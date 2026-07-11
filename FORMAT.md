# The Coldpaper format, version 1

This document is the **normative specification** of the bytes Coldpaper prints.
It exists so that a competent developer, holding only a stack of printed pages
and this file, can write an independent decoder from scratch, in any language,
with no access to the Coldpaper codebase. If the app, the repository and the
whole ecosystem around it disappear, the paper still talks.

Everything here is test-locked: the reference implementation in `src/core/`
asserts the exact vectors printed in this document (`test/crypto.test.ts`,
`test/rs-vector.test.ts`). If code and spec ever disagree, one of them has a
bug, and the tests say so.

## 0. Contents

1. [Design goals](#1-design-goals)
2. [Conventions](#2-conventions)
3. [Pipeline overview](#3-pipeline-overview)
4. [The chunk frame (what is inside each QR code)](#4-the-chunk-frame)
5. [The payload: metadata block + content](#5-the-payload)
6. [Encryption envelope](#6-encryption-envelope)
7. [Erasure coding](#7-erasure-coding)
8. [Restore algorithm](#8-restore-algorithm)
9. [Damage-tolerance guarantees](#9-damage-tolerance-guarantees)
10. [Versioning policy](#10-versioning-policy)
11. [Appendix A: independent decoder checklist](#appendix-a-independent-decoder-checklist)
12. [Appendix B: reading the codes without this app](#appendix-b-reading-the-codes-without-this-app)

## 1. Design goals

- **Self-describing.** Every single QR code carries enough header to identify
  the backup it belongs to, its position, the erasure-coding geometry and the
  processing flags. No cover sheet, ordering, or external state is required.
- **Order-free and duplicate-safe.** Codes may be scanned in any order, any
  number of times, mixed with codes from other backups.
- **Damage-tolerant.** The file survives the loss of whole codes (tears,
  stains, missing pages) up to a configurable parity budget, via Reed-Solomon
  erasure coding. Damage inside a code is handled by the QR symbology's own
  error correction.
- **Standard cryptography.** AES-256-GCM with a PBKDF2-SHA256 key. Nothing
  custom; implementable from any mainstream crypto library.
- **Small.** 22 bytes of framing per code; one metadata block per backup.

## 2. Conventions

- All multi-byte integers are **big-endian, unsigned**.
- `u8`/`u16`/`u32` are 1/2/4-byte unsigned integers.
- Byte values are written in hex (`0x43`).
- `a || b` means concatenation of byte strings a and b.
- `XOR` is bitwise exclusive-or; in GF(256) it is also addition/subtraction.
- "QR payload" means the full byte string stored in one QR code, which MUST be
  encoded in QR **byte mode** (ISO/IEC 18004 8-bit mode).
- `ceil(a / b)` is integer division rounding up.
- Ranges `[a, b)` include `a` and exclude `b`.

## 3. Pipeline overview

Backup (encode) direction:

```
file bytes
   |   (SHA-256 of these bytes is stored in the metadata block)
   v
raw DEFLATE, only kept if smaller          -> flag bit 0
   v
inner = metadata block || content
   v
AES-256-GCM, optional                      -> flag bit 1
   v
payload  (payloadLength bytes)
   v
zero-pad to kTotal * S, split into kTotal data chunks of S bytes
   v
Reed-Solomon parity: G groups, m parity chunks per group (GF(256), Cauchy)
   v
kTotal + m*G chunks, each framed (22-byte header+CRC) -> one QR code each
```

Restore is the mirror image and is specified in [section 8](#8-restore-algorithm).

## 4. The chunk frame

Every QR payload is exactly `22 + S` bytes, where `S` (the *chunk size*) is
constant across a backup and is **not stored**: decoders derive it as
`qrPayload.length - 22`.

| offset | size | field            | meaning                                               |
|-------:|-----:|------------------|-------------------------------------------------------|
| 0      | 2    | magic            | `0x43 0x50` (ASCII "CP")                              |
| 2      | 1    | version          | `0x01` for this specification                          |
| 3      | 4    | backupId         | random; all chunks of one backup share it             |
| 7      | 4    | payloadLength    | u32: exact byte length of the payload before padding  |
| 11     | 2    | chunkIndex       | u16: this chunk's index in `[0, totalChunks)`         |
| 13     | 2    | dataChunkCount   | u16: `kTotal`, number of data chunks                  |
| 15     | 1    | groupCount       | u8: `G`, number of Reed-Solomon groups                |
| 16     | 1    | parityPerGroup   | u8: `m`, parity chunks in every group                 |
| 17     | 1    | flags            | bit 0: content DEFLATEd; bit 1: payload encrypted     |
| 18     | 4    | crc32            | over bytes `[0,18)` followed by the chunk data        |
| 22     | S    | chunk data       |                                                       |

Derived quantities (identical for every chunk of a backup):

```
S             = qrPayload.length - 22
slotsPerGroup = k = ceil(kTotal / G)        (data slots per group, section 7.2)
totalChunks   = kTotal + m * G
```

**CRC-32** is the ubiquitous IEEE 802.3 / zlib CRC: reflected polynomial
`0xEDB88320`, initial value `0xFFFFFFFF`, final XOR `0xFFFFFFFF`. It is the
same function as zlib's `crc32()` and Python's `binascii.crc32`. It is
computed over the 18 header bytes immediately followed by the S data bytes
(the four CRC bytes themselves are *not* included).

The CRC exists because real-world scanners sometimes deliver *text* instead of
bytes, silently transcoding binary content. Any such mangling, or a rare QR
mis-decode from heavily damaged paper, fails the CRC and the chunk is
discarded instead of poisoning reconstruction.

A decoder MUST reject a chunk when any of these hold:

- length < 23, wrong magic, or CRC mismatch;
- `version != 1` (report "newer format" when version > 1);
- `payloadLength = 0`, `kTotal = 0`, `G = 0`, `m = 0`, or `G > kTotal`;
- `ceil(payloadLength / S) != kTotal` (frame is internally inconsistent);
- `slotsPerGroup + m > 255` (impossible GF(256) geometry);
- `chunkIndex >= totalChunks`;
- any flag bit other than 0 and 1 set (unknown feature; treat as version
  incompatibility, not as ignorable).

Chunks sharing a `backupId` MUST agree on `payloadLength`, `kTotal`, `G`, `m`,
`flags` and `S`; a disagreeing chunk is a mis-scan and MUST be dropped.

**Chunks are printed in `chunkIndex` order** and labelled "Code i+1 of
totalChunks", but nothing in the format relies on print order.

## 5. The payload

The *payload* is the byte string protected by erasure coding. Its exact length
is `payloadLength`; for chunking it is zero-padded at the end to
`kTotal * S` bytes, and data chunk `i` carries bytes `[i*S, (i+1)*S)` of the
padded payload.

If flag bit 1 (encrypted) is clear:

```
payload = inner
```

If flag bit 1 is set, `payload` is the encryption envelope of section 6 and
`inner` is its decrypted plaintext.

`inner` is always:

```
inner = metadata block || content
```

### 5.1 Metadata block

| offset | size | field      | meaning                                    |
|-------:|-----:|------------|--------------------------------------------|
| 0      | 1    | nameLength | `n`, UTF-8 byte length of the filename (0-255) |
| 1      | n    | name       | filename, UTF-8                             |
| 1+n    | 4    | fileSize   | u32: original file size in bytes            |
| 5+n    | 32   | sha256     | SHA-256 of the **original file bytes**      |

The metadata block therefore occupies the first `37 + n` bytes of `inner`,
i.e. the beginning of data chunk 0 for unencrypted backups.

### 5.2 Content

- If flag bit 0 (DEFLATE) is set: `content` is the file compressed with **raw
  DEFLATE (RFC 1951)**, no zlib or gzip wrapper. Encoders MUST only set this
  flag when the compressed form is strictly smaller than the original.
- Otherwise `content` is the file verbatim.

After reversing compression, a decoder MUST verify that the result is exactly
`fileSize` bytes and hashes (SHA-256) to `sha256`. Only then is the restore
declared good.

## 6. Encryption envelope

When flag bit 1 is set:

```
payload = salt (16 bytes) || iv (12 bytes) || AES-256-GCM ciphertext
```

- Key: `PBKDF2-HMAC-SHA256(passphrase as UTF-8 bytes, salt, 600000 iterations,
  32-byte output)`. The iteration count is **fixed by this format version**.
- Cipher: AES-256-GCM with the 12-byte `iv`, empty additional authenticated
  data, and the standard 16-byte authentication tag appended to the ciphertext
  (so `ciphertext length = inner length + 16`).
- `salt` and `iv` MUST be freshly random for every backup.
- The **whole** `inner`, metadata included, is inside the envelope: an
  encrypted backup leaks neither filename, file size (beyond coarse total
  size), nor the plaintext hash.
- A failed GCM tag check almost always means a wrong passphrase; a decoder
  should say so rather than "corrupt data" (the per-chunk CRCs make actual
  transport corruption nearly impossible at this stage).

### 6.4 Test vector

```
passphrase   "correct horse battery staple"
salt         000102030405060708090a0b0c0d0e0f
iv           000102030405060708090a0b
iterations   600000
derived key  ef177144eec9420cbc1093d2a8b344a92bc506d0d4ec9c028dd19f8324d8c1e6
plaintext    "coldpaper test vector 001"
             = 636f6c647061706572207465737420766563746f7220303031
ciphertext   6da9e4e501d54ce99e09f326cfc9a8cb80fac944ac6ab704
             0f97742eb4199c229f8e3b3d3c20958072            (tag included)
envelope     salt || iv || ciphertext
```

## 7. Erasure coding

### 7.1 The field: GF(256)

All arithmetic happens in GF(2^8) with reducing polynomial
`x^8+x^4+x^3+x^2+1` (`0x11D`) and generator element `2`, the same field QR
codes use internally.

- **Addition and subtraction are XOR.**
- Multiplication/division via exp/log tables:

```
exp[0] = 1
for i in 1..254:  exp[i] = exp[i-1] * 2      # *2 = shift left; XOR 0x11D if bit 8 set
log[exp[i]] = i
mul(a,b)  = 0 if a=0 or b=0, else exp[(log[a]+log[b]) mod 255]
inv(a)    = exp[255 - log[a]]                # a != 0
```

Worked scalar facts to check a fresh implementation:
`mul(2,2) = 0x04`, `mul(0x80,0x02) = 0x1D` (reduction), `inv(0x03) = 0xF4`.

### 7.2 Groups and striping

One GF(256) Reed-Solomon group can hold at most 255 shards. To support larger
backups, data chunks are dealt **round-robin** across `G` groups:

```
data chunk index i    ->  group  i mod G,   slot  floor(i / G)
parity chunk index kTotal + t
                      ->  group  t mod G,   parity slot floor(t / G)
```

Every group has exactly `k = slotsPerGroup = ceil(kTotal / G)` data slots and
`m` parity slots. When `kTotal` is not a multiple of `G`, the trailing groups'
last slots map past `kTotal`; these **virtual slots** are defined to be
all-zero chunks. They are never printed, and decoders treat them as always
present (a slot `(g, s)` is virtual iff `s*G + g >= kTotal`).

The encoder in this repository chooses `G = ceil(kTotal / 168)`, but that
constant is an encoder tuning choice, **not** part of the format: decoders
MUST take `G` from the header and derive `k = ceil(kTotal / G)`.

Round-robin striping is deliberate: physically adjacent printed codes belong
to different groups, so localized damage (a torn corner, one lost page)
spreads its losses across groups instead of exhausting one group's parity.

### 7.3 The code: systematic Reed-Solomon via a Cauchy matrix

Within one group with `k` data slots `d_0 .. d_{k-1}` (each `S` bytes) and `m`
parity slots, parity is computed **byte-position-wise**; position `s` of every
shard forms an independent codeword:

```
C[t][j]      = inv( (k + t) XOR j )                  t in [0,m), j in [0,k)
parity_t[s]  = XOR over j of  mul( C[t][j], d_j[s] )
```

`C` is a Cauchy matrix: element `1/(x_t - y_j)` with `x_t = k+t`, `y_j = j`,
where subtraction in GF(256) is XOR. Because the `x_t` and `y_j` are pairwise
distinct field elements (guaranteed by `k + m <= 255`, section 4 validation),
**every square submatrix of `[ I_k ; C ]` is invertible**, which is exactly
the property that lets *any* k of the k+m shards reconstruct the group.

### 7.4 Worked example (test-locked)

Group with `k = 3`, `m = 2`, `S = 4`; data slots:

```
d0 = 63 6f 6c 64   ("cold")
d1 = 70 61 70 65   ("pape")
d2 = 72 21 21 21   ("r!!!")
```

Cauchy rows (`x_0 = 3`, `x_1 = 4`; `XOR` shown as `^`):

```
C[0] = inv(3^0) inv(3^1) inv(3^2) = inv(3) inv(2) inv(1) = f4 8e 01
C[1] = inv(4^0) inv(4^1) inv(4^2) = inv(4) inv(5) inv(6) = 47 a7 7a
```

Parity shards:

```
parity0 = 6b ba 3d 4a
parity1 = 8f 1f d3 72
```

Any 3 of the 5 shards `{d0, d1, d2, parity0, parity1}` recover all data,
e.g. from `{d1, parity0, parity1}` alone (see `test/rs-vector.test.ts`).

### 7.5 Reconstruction mathematics

To rebuild `e` missing data slots (set `M`, |M| = e) using `e` captured parity
rows `t_1 .. t_e`:

1. For each chosen parity row `t`, fold the known data slots into the parity:

   `rhs_t[s] = parity_t[s] XOR ( XOR over known j of mul(C[t][j], d_j[s]) )`

2. Build the `e x e` matrix `A[r][c] = C[t_r][ M_c ]` (parity rows restricted
   to the missing columns). `A` is a submatrix of a Cauchy matrix, hence
   invertible.
3. Invert `A` over GF(256) (Gauss-Jordan; pivots are never zero for Cauchy
   submatrices, but partial pivoting costs nothing and guards bugs).
4. Each missing slot: `d_{M_i}[s] = XOR over r of mul( Ainv[i][r], rhs_{t_r}[s] )`.

Any `e <= m` works, and any choice of `e` captured parity rows works.

## 8. Restore algorithm

Given an unordered pile of scanned QR payloads:

1. **Frame-validate** each payload (section 4). Drop invalid ones. Group
   survivors by `backupId`; if several backups are present, ask the user which
   to restore. Never mix backups.
2. Within the chosen backup, index chunks by `chunkIndex`, ignoring
   duplicates (identical `chunkIndex` seen twice) after checking agreement.
3. **Completeness check**: for every group `g`, require
   `present data slots + virtual slots + present parity slots >= k`. If any
   group falls short, more codes are needed; the still-useful chunk indexes
   are exactly the not-yet-seen ones of that group (both data and parity).
4. **Reconstruct** every group (section 7.5) to obtain all data slots; write
   each real slot `(g, s)` into padded-payload position `(s*G + g) * S`.
5. Truncate the padded payload to `payloadLength`.
6. If flag bit 1: parse `salt || iv || ciphertext`, derive the key
   (section 6), decrypt AES-256-GCM. On tag failure, report *wrong passphrase*
   and allow retry without rescanning.
7. Parse the metadata block (section 5.1) off the front of `inner`.
8. If flag bit 0: raw-DEFLATE-decompress the remaining content.
9. Verify length == `fileSize` **and** SHA-256 == `sha256`. On success, hand
   the user the file under `name`. On failure, advise rescanning; per-chunk
   CRCs make this state rare (it indicates a systematic error, not noise).

## 9. Damage-tolerance guarantees

Let `P = m * G` be the total number of parity codes.

- **Any m lost codes** are always recoverable, regardless of where they fall.
- **Up to P lost codes** are recoverable provided no single group loses more
  than `m`. Round-robin striping makes this the expected case for physically
  clustered damage: a contiguous run of `L` lost codes in print order hits
  each group at most `ceil(L / G)` times, so **any contiguous tear of up to
  about P codes is recoverable**.
- For backups small enough to fit one group (`G = 1`, up to ~140 KB of
  payload at the default density), the guarantee is exact and simple:
  *any* `m` of the `k+m` codes may be lost.
- Damage *inside* a code (small stains, printer artifacts) is absorbed by the
  QR symbology's own error correction (level M, about 15% of codewords) and,
  when that fails, the code simply counts as lost; the CRC keeps mis-decodes
  out.

The printed cover sheet states the concrete numbers for its backup.

## 10. Versioning policy

- The version byte is bumped for **any** change to the bytes: header layout,
  KDF parameters, field polynomial, striping rule, metadata layout, anything.
- Decoders MUST refuse payloads with a higher version than they understand,
  and SHOULD tell the user to fetch a newer decoder. The paper outlives app
  versions, so the reverse must hold too: new decoders MUST keep reading v1
  forever.
- Unknown flag bits are a version-compatibility error, not ignorable.

## Appendix A: independent decoder checklist

A from-scratch decoder needs, in order:

1. A QR reader that returns **raw bytes** (byte-mode content, not text).
2. CRC-32 (zlib flavour), a standard-library function in most languages.
3. The 22-byte frame parser + validation list of section 4.
4. Grouping by backupId; dedupe by chunkIndex.
5. GF(256) exp/log tables (15 lines; section 7.1) and the Cauchy row formula.
6. Gauss-Jordan inversion of an at-most m x m matrix over GF(256).
7. The slot mapping of section 7.2 including virtual zero slots.
8. Payload truncation to `payloadLength`.
9. Optional: PBKDF2-SHA256 (600000 iterations) + AES-256-GCM, both in every
   mainstream crypto library. Check against the section 6.4 vector.
10. Raw-DEFLATE decompression (zlib `inflateRaw`, Python `zlib.decompress(d, -15)`).
11. SHA-256 for final verification.

Total: a few hundred lines in Python/Go/Rust. The section 6.4 and 7.4 vectors
plus one self-made backup give you end-to-end confidence.

## Appendix B: reading the codes without this app

Any byte-capable QR scanner works. Two battle-tested options:

- **zxing-cpp** CLI: `ZXingReader -bytes page.png` (or the `zxingcpp` Python
  module: `zxingcpp.read_barcodes(img)[0].bytes`).
- **zbar**: `zbarimg --raw --oneshot -Sbinary page.png` emits raw bytes.

Photograph or scan every page, run the reader over each image, and feed each
result through the checklist above. Order never matters; duplicates never
hurt.
