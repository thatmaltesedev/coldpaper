# coldpaper

**Back up any file onto printable paper, and get it back with a phone camera.**

Coldpaper turns a file into a PDF of QR codes. Print it, put it in a drawer,
and years later point any phone at the pages to get the file back,
byte-for-byte, checksum-verified. Everything runs in your browser: no server,
no upload, no account. Thanks to erasure coding, a torn, stained, or entirely
missing code still restores.

**Use it now: [thatmaltesedev.github.io/coldpaper](https://thatmaltesedev.github.io/coldpaper/)**

[![CI](https://github.com/thatmaltesedev/coldpaper/actions/workflows/ci.yml/badge.svg)](https://github.com/thatmaltesedev/coldpaper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)

<!--
  DEMO GIF PLACEHOLDER. Record this exact sequence (about 25s):
   1. Drop a file (e.g. "2fa-recovery-codes.txt") on the Backup tab, type a
      passphrase, click "Generate pages", click Download PDF.
   2. Print the PDF. On camera: TEAR ONE PAGE IN HALF and throw half away,
      then spill a splash of coffee on another page. Let it soak.
   3. Open the site on a phone, tap Restore, sweep the camera over the
      surviving pages. Beeps land, the progress meter fills, the passphrase
      prompt appears, and the file comes back with the green
      "SHA-256 checksum verified" card.
  Then embed it here:  ![coldpaper demo](docs/demo.gif)
-->

Made for the things that must not disappear when a hard drive, a phone, or a
cloud company does: 2FA recovery codes, a password-manager export, a crypto
seed phrase, a will, tax records. Paper doesn't get ransomware.

## How it works

```
file -> SHA-256 -> DEFLATE -> [AES-256-GCM] -> split into k chunks
     -> Reed-Solomon parity (any k of k+m recover) -> one QR code per chunk
     -> PDF: cover sheet with restore instructions + labelled code grid
```

- **Restore is grandma-grade.** Open the site, tap Restore, point the camera
  at every page. Any order, duplicates fine, progress beeps. When enough codes
  are in, the file downloads with its checksum verified. Photos and flatbed
  scans of the pages work too.
- **Backups survive damage.** The redundancy slider (default 25%) adds parity
  codes via Reed-Solomon erasure coding over GF(256). Lose any codes up to
  the parity budget (tears, stains, a whole missing page) and the file still
  reconstructs, exactly.
- **Encryption is optional and boring.** AES-256-GCM, key derived with
  PBKDF2-SHA256 at 600,000 iterations. There is **no password reset**. Lose
  the passphrase and the backup is unreadable; that is what real encryption
  means.
- **The format is documented to survive this project.** [FORMAT.md](FORMAT.md)
  specifies every byte, with frozen test vectors, so a stranger in 2045 can
  write a decoder from scratch. The printed cover sheet carries a summary.
- **Nothing leaves your device.** Verify it yourself: open DevTools, watch the
  Network tab, then back up and restore a file. You will see zero requests
  after the initial page load (and with the service worker installed, not
  even that).

Every claim above is enforced by tests, including one that builds the real
PDF, renders it to images with an independent PDF engine (pdf.js), throws away
a full page plus two coffee-stained codes, and restores the file
byte-identically on every CI run.

## Quick start

**Just use it:** [thatmaltesedev.github.io/coldpaper](https://thatmaltesedev.github.io/coldpaper/)
is a PWA and works fully offline after the first visit.

**Keep a copy that can't disappear:** the footer offers
`coldpaper-offline.html`, the entire app in one self-contained file. Put it
on a USB stick in the same drawer as your printed backups.

**Run it yourself:**

```sh
git clone https://github.com/thatmaltesedev/coldpaper.git
cd coldpaper
npm ci
npm run dev        # develop on http://localhost:5173
npm test           # the full suite, including print-and-scan simulations
npm run build      # dist/ (PWA) + dist/coldpaper-offline.html (single file)
```

Node 20+ required. No other toolchain.

**Print advice:** 100% scale ("actual size"), plain black and white. Laser
toner is waterproof; inkjet mostly isn't. Standard 80 g/m2 paper is fine, or
acid-free paper if you want decades. Keep the cover sheet; it explains
everything to whoever finds the pages.

## Capacity and page counts

| Density preset | QR version/ECC | bytes per code | bytes per page (12 codes) |
|---|---|---:|---:|
| Easy scan (default) | v23-M | 835 | ~10 KB |
| Balanced | v31-M | 1,430 | ~17 KB |
| Dense | v40-M | 2,309 | ~27.7 KB |

A 100 KB file at default settings is ~150 codes, which is 13 pages plus the
cover. There is a soft warning above 500 KB and a hard cap at 5 MB. Above
that, paper stops being the right medium (see FAQ).

## Security notes and threat model

Read this before trusting the tool with anything important.

- **PBKDF2, not Argon2.** WebCrypto (the only cryptography this app will use;
  no hand-rolled primitives, no wasm crypto blobs) doesn't offer memory-hard
  KDFs. 600,000 iterations of PBKDF2-SHA256 is the OWASP-recommended setting,
  but it is not memory-hard: a well-funded attacker with GPUs brute-forces
  weak passphrases far faster than your phone can. Passphrase strength is
  the real defence. Use six or more random words (diceware), not a password
  you can remember by being clever.
- **Paper is only as safe as the drawer it lives in.** An unencrypted backup
  is readable by anyone with a phone. That is the point (future-you included),
  so encrypt anything sensitive. The cover sheet prints the filename in plain
  text; for encrypted backups the plaintext hash and name are hidden inside
  the ciphertext, and the cover shows only a ciphertext fingerprint.
- **No plausible deniability, no key rotation, no revocation.** This is cold
  storage, not a vault product. To "rotate" a passphrase you print a new
  backup and destroy the old one.
- **The web app can be compromised like any web app.** If GitHub Pages or this
  repo were maliciously altered, a poisoned version could exfiltrate what you
  feed it. Mitigations: the app is small and auditable, all processing is
  local and verifiable in the Network tab, and, best practice, keep the
  `coldpaper-offline.html` from a version you trust on read-only media and use
  that. The format spec means you never need this codebase to restore.
- **Metadata leaks.** Even encrypted, the paper reveals: approximate payload
  size, code count, creation date (cover), and that it's a Coldpaper backup.
  Anyone can count your pages; they can't read them.
- **Integrity has several layers.** Every chunk carries a CRC-32, the file's
  SHA-256 travels inside the (possibly encrypted) payload and is verified on
  restore, and GCM authenticates the ciphertext. A wrong passphrase is
  detected as such; silent corruption has to defeat all three.

## FAQ

**How big a file can I back up?**
Hard cap 5 MB, soft warning at 500 KB. At default density 5 MB is roughly 630
pages: technically fine, practically silly. Paper is for the irreplaceable
kilobytes.

**Multiple files?**
Zip them first (v1). Native multi-file backups are on the roadmap.

**What if this project dies?**
That's the design case. [FORMAT.md](FORMAT.md) specifies every byte with test
vectors; the cover sheet summarises it; any byte-capable QR reader
(zxing, zbar) gets the raw chunks out. A competent developer can write an
independent decoder in an afternoon without this repository.

**Why QR codes and not DataMatrix, colour codes, or high-density film?**
QR byte mode is the most universally decodable machine-readable print format
on Earth. Every phone made this decade reads it. Exotic formats read better
in demos and worse in 2045.

**Why not print base64 text I could OCR?**
OCR of thousands of characters of base64 is far less reliable than QR's
built-in error correction, position detection and binary mode. QR is already
the OCR-proof encoding.

**Scanning with a regular QR app mangles the data. Why?**
Generic apps decode to text, which corrupts binary payloads. Use the Restore
tab (it reads raw bytes), or any byte-capable reader (see FORMAT.md
Appendix B). This is also why every chunk carries a CRC.

**The page got wet / faded / torn. Now what?**
Scan everything that still scans. The progress card tells you exactly which
codes are still useful and how many more each group needs. Any codes up to
the parity budget can be gone entirely.

**Does it work on iPhone?**
Yes. Safari supports camera capture and everything else used here. The
restore tab is designed phone-first.

**Can I store the PDF instead of printing it?**
You can, but then it's just a file backup with extra steps. The point of
Coldpaper is the paper.

## Roadmap

- Multi-file backups (zip container with per-file listing on the cover)
- Argon2id as an optional KDF once it can ship self-contained and auditable
  (bundled wasm, no CDN, no custom crypto), with a format version bump
- "Scan report" print-out: which codes were used, which were missing
- Batch-import UX for whole folders of page scans
- Localisation of the UI and the printed cover sheet
- Higher-capacity page layouts (2x3 large-code mode for bad printers)

## License

[MIT](LICENSE). The format specification (FORMAT.md) may be implemented by
anyone, anywhere, with no strings attached; independent decoders are the
whole point.
