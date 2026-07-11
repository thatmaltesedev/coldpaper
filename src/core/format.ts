/**
 * The Coldpaper v1 chunk format — the exact bytes that go inside each QR code.
 * FORMAT.md is the normative spec; this file implements it.
 *
 * Every QR payload:
 *
 *   offset  size  field
 *   0       2     magic 0x43 0x50 ("CP")
 *   2       1     format version (0x01)
 *   3       4     backup id (random; prevents mixing different backups)
 *   7       4     payload length in bytes, u32 BE (before padding)
 *   11      2     chunk index, u16 BE (0-based, over data then parity)
 *   13      2     data chunk count kTotal, u16 BE
 *   15      1     group count G, u8
 *   16      1     parity chunks per group m, u8
 *   17      1     flags (bit0 = deflate, bit1 = AES-256-GCM)
 *   18      4     CRC-32 over header bytes 0..17 followed by the chunk data
 *   22      S     chunk data (same S for every chunk of a backup)
 *
 * The CRC makes any mangled scan (or a text-mode QR reader that "helpfully"
 * re-encoded the bytes) detectable before it can poison reconstruction.
 */
import {
  concatBytes,
  crc32Update,
  readU16BE,
  readU32BE,
  utf8Decode,
  utf8Encode,
  writeU16BE,
  writeU32BE,
} from './bytes';
import { CpError } from './errors';
import { MAX_GROUP_SHARDS } from './rs';

export const MAGIC_0 = 0x43; // 'C'
export const MAGIC_1 = 0x50; // 'P'
export const FORMAT_VERSION = 1;
export const HEADER_LENGTH = 18;
export const CRC_LENGTH = 4;
/** Bytes of every QR payload not available for chunk data. */
export const CHUNK_OVERHEAD = HEADER_LENGTH + CRC_LENGTH; // 22

export const FLAG_DEFLATE = 0b0000_0001;
export const FLAG_ENCRYPTED = 0b0000_0010;
const KNOWN_FLAGS = FLAG_DEFLATE | FLAG_ENCRYPTED;

export const BACKUP_ID_LENGTH = 4;

export interface ChunkHeader {
  backupId: Uint8Array; // 4 bytes
  payloadLength: number;
  chunkIndex: number;
  dataChunkCount: number;
  groupCount: number;
  parityPerGroup: number;
  flags: number;
}

export interface DecodedChunk {
  header: ChunkHeader;
  data: Uint8Array;
}

export function encodeChunk(header: ChunkHeader, data: Uint8Array): Uint8Array {
  if (header.backupId.length !== BACKUP_ID_LENGTH) {
    throw new CpError('INTERNAL', 'backup id must be 4 bytes');
  }
  const out = new Uint8Array(CHUNK_OVERHEAD + data.length);
  out[0] = MAGIC_0;
  out[1] = MAGIC_1;
  out[2] = FORMAT_VERSION;
  out.set(header.backupId, 3);
  writeU32BE(out, 7, header.payloadLength);
  writeU16BE(out, 11, header.chunkIndex);
  writeU16BE(out, 13, header.dataChunkCount);
  out[15] = header.groupCount;
  out[16] = header.parityPerGroup;
  out[17] = header.flags;
  let crc = crc32Update(0xffffffff, out.subarray(0, HEADER_LENGTH));
  crc = (crc32Update(crc, data) ^ 0xffffffff) >>> 0;
  writeU32BE(out, HEADER_LENGTH, crc);
  out.set(data, CHUNK_OVERHEAD);
  return out;
}

/**
 * Parse and validate one QR payload. Throws:
 *  - NOT_COLDPAPER for anything that is not a Coldpaper chunk,
 *  - UNSUPPORTED_VERSION for chunks from a future format,
 *  - BAD_CHECKSUM for corrupted/mangled scans,
 *  - NOT_COLDPAPER (with details) for headers that are internally inconsistent.
 */
export function decodeChunk(payload: Uint8Array): DecodedChunk {
  if (payload.length < CHUNK_OVERHEAD + 1) {
    throw new CpError('NOT_COLDPAPER', 'too short to be a Coldpaper chunk');
  }
  if (payload[0] !== MAGIC_0 || payload[1] !== MAGIC_1) {
    throw new CpError('NOT_COLDPAPER', 'missing CP magic bytes');
  }
  if (payload[2] !== FORMAT_VERSION) {
    throw new CpError(
      'UNSUPPORTED_VERSION',
      `chunk uses format version ${payload[2]}; this decoder understands version ${FORMAT_VERSION}`,
      { version: payload[2] },
    );
  }

  const stored = readU32BE(payload, HEADER_LENGTH);
  let crc = crc32Update(0xffffffff, payload.subarray(0, HEADER_LENGTH));
  crc = (crc32Update(crc, payload.subarray(CHUNK_OVERHEAD)) ^ 0xffffffff) >>> 0;
  if (crc !== stored) {
    throw new CpError('BAD_CHECKSUM', 'chunk failed its CRC-32 check (mis-scan?)', {
      expected: stored,
      actual: crc,
    });
  }

  const header: ChunkHeader = {
    backupId: payload.slice(3, 7),
    payloadLength: readU32BE(payload, 7),
    chunkIndex: readU16BE(payload, 11),
    dataChunkCount: readU16BE(payload, 13),
    groupCount: payload[15],
    parityPerGroup: payload[16],
    flags: payload[17],
  };
  const data = payload.slice(CHUNK_OVERHEAD);

  // Internal consistency — a valid CRC over an insane header still gets rejected.
  const { payloadLength, dataChunkCount, groupCount, parityPerGroup } = header;
  const chunkSize = data.length;
  const bad = (why: string) => new CpError('NOT_COLDPAPER', `inconsistent chunk header: ${why}`, { header });
  if (payloadLength < 1) throw bad('payload length is zero');
  if (dataChunkCount < 1) throw bad('no data chunks');
  if (groupCount < 1 || groupCount > dataChunkCount) throw bad('impossible group count');
  if (parityPerGroup < 1) throw bad('no parity');
  const slotsPerGroup = Math.ceil(dataChunkCount / groupCount);
  if (slotsPerGroup + parityPerGroup > MAX_GROUP_SHARDS) throw bad('group exceeds 255 shards');
  if (Math.ceil(payloadLength / chunkSize) !== dataChunkCount) {
    throw bad('payload length does not match chunk size and count');
  }
  const totalChunks = dataChunkCount + parityPerGroup * groupCount;
  if (header.chunkIndex >= totalChunks) throw bad('chunk index out of range');
  if (header.flags & ~KNOWN_FLAGS) throw bad(`unknown flags 0x${header.flags.toString(16)}`);

  return { header, data };
}

// ---------------------------------------------------------------------------
// Metadata block — the first bytes of the (plaintext) payload.
//
//   offset   size  field
//   0        1     filename length n in bytes (may be 0)
//   1        n     filename, UTF-8
//   1+n      4     original file size in bytes, u32 BE
//   5+n      32    SHA-256 of the original file bytes
// ---------------------------------------------------------------------------

export const META_FIXED_LENGTH = 1 + 4 + 32;
export const MAX_NAME_BYTES = 255;

export interface BackupMeta {
  name: string;
  fileSize: number;
  sha256: Uint8Array; // 32 bytes
}

export function encodeMeta(meta: BackupMeta): Uint8Array {
  let nameBytes = utf8Encode(meta.name);
  if (nameBytes.length > MAX_NAME_BYTES) {
    // Trim to a valid UTF-8 boundary; the name is a convenience, not sacred data.
    let cut = MAX_NAME_BYTES;
    while (cut > 0 && (nameBytes[cut] & 0b1100_0000) === 0b1000_0000) cut--;
    nameBytes = nameBytes.slice(0, cut);
  }
  if (meta.sha256.length !== 32) throw new CpError('INTERNAL', 'sha256 must be 32 bytes');
  const head = new Uint8Array(1 + nameBytes.length + 4);
  head[0] = nameBytes.length;
  head.set(nameBytes, 1);
  writeU32BE(head, 1 + nameBytes.length, meta.fileSize);
  return concatBytes([head, meta.sha256]);
}

export function decodeMeta(payload: Uint8Array): { meta: BackupMeta; byteLength: number } {
  if (payload.length < META_FIXED_LENGTH) {
    throw new CpError('NOT_COLDPAPER', 'payload too short for its metadata block');
  }
  const nameLength = payload[0];
  const byteLength = META_FIXED_LENGTH + nameLength;
  if (payload.length < byteLength) {
    throw new CpError('NOT_COLDPAPER', 'metadata block extends past the payload');
  }
  const name = utf8Decode(payload.slice(1, 1 + nameLength));
  const fileSize = readU32BE(payload, 1 + nameLength);
  const sha256 = payload.slice(5 + nameLength, 5 + nameLength + 32);
  return { meta: { name, fileSize, sha256 }, byteLength };
}
