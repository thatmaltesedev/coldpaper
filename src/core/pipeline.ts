/**
 * The full Coldpaper pipeline.
 *
 * backup:   file -> sha256 -> deflate (if it helps) -> [encrypt] ->
 *           split into kTotal chunks -> RS parity per group -> framed chunks
 * restore:  framed chunks (any order, any k per group) -> RS decode ->
 *           [decrypt] -> inflate -> verify sha256 -> original file
 */
import { bytesEqual, concatBytes, randomBytes } from './bytes';
import type { CollectedBackup } from './collector';
import { decompress, maybeCompress } from './compress';
import { decrypt, encrypt } from './crypto';
import { CpError, isCpError } from './errors';
import {
  BACKUP_ID_LENGTH,
  decodeMeta,
  encodeChunk,
  encodeMeta,
  FLAG_DEFLATE,
  FLAG_ENCRYPTED,
  type ChunkHeader,
} from './format';
import { sha256 } from './hash';
import { dataChunkIndex, isVirtualSlot, parityChunkIndex, planBackup, type RsPlan } from './layout';
import { decodeGroup, encodeParity } from './rs';

/** Hard cap. Paper backups above this stop being paper backups and start being a book. */
export const HARD_FILE_CAP = 5 * 1024 * 1024;
/** Above this we warn: page counts grow fast. */
export const SOFT_FILE_WARNING = 500 * 1024;

export interface CreateBackupOptions {
  fileName: string;
  fileBytes: Uint8Array;
  /** Data bytes per chunk (S) - comes from the density preset. */
  chunkSize: number;
  /** Parity per group as a percentage of data slots (10-50). */
  redundancyPercent: number;
  passphrase?: string;
  /** Yield to the event loop between groups so the UI can breathe. */
  onProgress?: (done: number, total: number) => void;
  /** Tests only. Not part of the format - real backups always use 600 000. */
  kdfIterations?: number;
}

export interface BackupResult {
  backupId: Uint8Array;
  plan: RsPlan;
  flags: number;
  compressed: boolean;
  encrypted: boolean;
  /** SHA-256 of the original file. */
  fileHash: Uint8Array;
  /** SHA-256 of the padded payload - printable fingerprint that never leaks plaintext. */
  payloadHash: Uint8Array;
  /** QR payloads, index 0..totalChunks-1 in print order. */
  chunks: Uint8Array[];
}

export async function createBackup(options: CreateBackupOptions): Promise<BackupResult> {
  const { fileName, fileBytes, chunkSize, redundancyPercent, passphrase, onProgress } = options;
  if (fileBytes.length > HARD_FILE_CAP) {
    throw new CpError('FILE_TOO_LARGE', `files above ${HARD_FILE_CAP / 1024 / 1024} MB are not supported`, {
      size: fileBytes.length,
    });
  }

  const fileHash = await sha256(fileBytes);
  const { data: content, compressed } = maybeCompress(fileBytes);
  const meta = encodeMeta({ name: fileName, fileSize: fileBytes.length, sha256: fileHash });
  const inner = concatBytes([meta, content]);

  let flags = compressed ? FLAG_DEFLATE : 0;
  let payload = inner;
  if (passphrase !== undefined && passphrase !== '') {
    payload = await encrypt(inner, passphrase, { iterations: options.kdfIterations });
    flags |= FLAG_ENCRYPTED;
  }

  const plan = planBackup(payload.length, chunkSize, redundancyPercent);
  const backupId = randomBytes(BACKUP_ID_LENGTH);

  const dataChunk = (index: number): Uint8Array => {
    const start = index * chunkSize;
    const slice = payload.subarray(start, Math.min(start + chunkSize, payload.length));
    if (slice.length === chunkSize) return slice;
    const padded = new Uint8Array(chunkSize); // trailing zeros; true length is in every header
    padded.set(slice);
    return padded;
  };

  const headerFor = (chunkIndex: number): ChunkHeader => ({
    backupId,
    payloadLength: plan.payloadLength,
    chunkIndex,
    dataChunkCount: plan.dataChunkCount,
    groupCount: plan.groupCount,
    parityPerGroup: plan.parityPerGroup,
    flags,
  });

  const chunks: Uint8Array[] = new Array(plan.totalChunks);
  for (let i = 0; i < plan.dataChunkCount; i++) {
    chunks[i] = encodeChunk(headerFor(i), dataChunk(i));
  }
  for (let g = 0; g < plan.groupCount; g++) {
    const slots: (Uint8Array | null)[] = [];
    for (let s = 0; s < plan.slotsPerGroup; s++) {
      slots.push(isVirtualSlot(g, s, plan) ? null : dataChunk(dataChunkIndex(g, s, plan)));
    }
    const parity = encodeParity(slots, plan.parityPerGroup, chunkSize);
    for (let t = 0; t < plan.parityPerGroup; t++) {
      const index = parityChunkIndex(g, t, plan);
      chunks[index] = encodeChunk(headerFor(index), parity[t]);
    }
    if (onProgress) {
      onProgress(g + 1, plan.groupCount);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const payloadHash = await sha256(padTo(payload, plan.dataChunkCount * chunkSize));

  return {
    backupId,
    plan,
    flags,
    compressed,
    encrypted: (flags & FLAG_ENCRYPTED) !== 0,
    fileHash,
    payloadHash,
    chunks,
  };
}

function padTo(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length === length) return bytes;
  const out = new Uint8Array(length);
  out.set(bytes);
  return out;
}

export interface RestoredFile {
  name: string;
  bytes: Uint8Array;
  sha256: Uint8Array;
  wasCompressed: boolean;
  wasEncrypted: boolean;
}

export async function restoreBackup(
  collected: CollectedBackup,
  passphrase?: string,
  kdfIterations?: number,
): Promise<RestoredFile> {
  const plan = collected.plan;
  const encrypted = collected.encrypted;
  if (encrypted && (passphrase === undefined || passphrase === '')) {
    throw new CpError('PASSPHRASE_REQUIRED', 'this backup is encrypted, enter its passphrase to restore');
  }

  // Reassemble the padded payload group by group.
  const padded = new Uint8Array(plan.dataChunkCount * plan.chunkSize);
  const zero = new Uint8Array(plan.chunkSize);
  for (let g = 0; g < plan.groupCount; g++) {
    const dataPresent = new Map<number, Uint8Array>();
    const parityPresent = new Map<number, Uint8Array>();
    for (let s = 0; s < plan.slotsPerGroup; s++) {
      if (isVirtualSlot(g, s, plan)) {
        dataPresent.set(s, zero);
        continue;
      }
      const bytes = collected.chunkData.get(dataChunkIndex(g, s, plan));
      if (bytes) dataPresent.set(s, bytes);
    }
    for (let t = 0; t < plan.parityPerGroup; t++) {
      const bytes = collected.chunkData.get(parityChunkIndex(g, t, plan));
      if (bytes) parityPresent.set(t, bytes);
    }
    let slots: Uint8Array[];
    try {
      slots = decodeGroup({
        k: plan.slotsPerGroup,
        m: plan.parityPerGroup,
        chunkSize: plan.chunkSize,
        dataPresent,
        parityPresent,
      });
    } catch (e) {
      if (isCpError(e, 'INSUFFICIENT_CHUNKS')) {
        throw new CpError(
          'INSUFFICIENT_CHUNKS',
          `not enough codes captured yet (group ${g + 1} of ${plan.groupCount} is short), scan more pages`,
          { ...e.details, group: g },
        );
      }
      throw e;
    }
    for (let s = 0; s < plan.slotsPerGroup; s++) {
      const idx = dataChunkIndex(g, s, plan);
      if (idx < plan.dataChunkCount) padded.set(slots[s], idx * plan.chunkSize);
    }
  }

  const payload = padded.subarray(0, plan.payloadLength);
  const inner = encrypted ? await decrypt(payload, passphrase!, kdfIterations) : payload;

  let meta;
  try {
    meta = decodeMeta(inner);
  } catch {
    throw new CpError('CORRUPT_PAYLOAD', 'reconstructed payload has no valid metadata block, rescan the pages');
  }

  const content = inner.subarray(meta.byteLength);
  const wasCompressed = (collected.flags & FLAG_DEFLATE) !== 0;
  const bytes = wasCompressed ? decompress(content, meta.meta.fileSize) : Uint8Array.from(content);

  if (bytes.length !== meta.meta.fileSize) {
    throw new CpError('HASH_MISMATCH', 'restored file has the wrong size, rescan the pages', {
      expected: meta.meta.fileSize,
      actual: bytes.length,
    });
  }
  const digest = await sha256(bytes);
  if (!bytesEqual(digest, meta.meta.sha256)) {
    throw new CpError(
      'HASH_MISMATCH',
      'restored file failed its SHA-256 check. Rescan the pages; if this repeats, one code may be mislabelled',
    );
  }

  return {
    name: meta.meta.name,
    bytes,
    sha256: digest,
    wasCompressed,
    wasEncrypted: encrypted,
  };
}
