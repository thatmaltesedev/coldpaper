/**
 * Gathers scanned chunks: order-free, duplicate-safe, and multi-backup-aware.
 * Codes from different backups (different 4-byte ids) are kept apart so a user
 * who accidentally scans two piles of paper gets told, not garbage.
 */
import { toHex } from './bytes';
import { CpError, isCpError } from './errors';
import { decodeChunk, FLAG_ENCRYPTED, type ChunkHeader } from './format';
import { dataChunkIndex, locateChunk, parityChunkIndex, planFromHeader, type RsPlan } from './layout';

export type AddOutcome =
  | { kind: 'added'; backupId: string; chunkIndex: number; backup: CollectedBackup }
  | { kind: 'duplicate'; backupId: string; chunkIndex: number; backup: CollectedBackup }
  | { kind: 'mismatch'; backupId: string; error: CpError }
  | { kind: 'invalid'; error: CpError };

export interface GroupProgress {
  group: number;
  /** Shards effectively in hand for this group (captured + virtual zeros), capped at need. */
  have: number;
  need: number;
  satisfied: boolean;
  /** Chunk indexes (0-based) that would still help this group. */
  missingCandidates: number[];
}

export class CollectedBackup {
  readonly plan: RsPlan;
  readonly flags: number;
  readonly backupId: Uint8Array;
  readonly backupIdHex: string;
  readonly chunkData = new Map<number, Uint8Array>();

  constructor(header: ChunkHeader, chunkSize: number) {
    this.plan = planFromHeader({
      payloadLength: header.payloadLength,
      dataChunkCount: header.dataChunkCount,
      groupCount: header.groupCount,
      parityPerGroup: header.parityPerGroup,
      chunkSize,
    });
    this.flags = header.flags;
    this.backupId = header.backupId;
    this.backupIdHex = toHex(header.backupId);
  }

  get encrypted(): boolean {
    return (this.flags & FLAG_ENCRYPTED) !== 0;
  }

  get capturedCount(): number {
    return this.chunkData.size;
  }

  get totalChunks(): number {
    return this.plan.totalChunks;
  }

  /** Minimum captures that can complete a restore (any mix, spread over groups). */
  get requiredCount(): number {
    return this.plan.dataChunkCount;
  }

  addDecoded(header: ChunkHeader, data: Uint8Array): AddOutcome {
    const p = this.plan;
    const consistent =
      header.payloadLength === p.payloadLength &&
      header.dataChunkCount === p.dataChunkCount &&
      header.groupCount === p.groupCount &&
      header.parityPerGroup === p.parityPerGroup &&
      header.flags === this.flags &&
      data.length === p.chunkSize;
    if (!consistent) {
      return {
        kind: 'mismatch',
        backupId: this.backupIdHex,
        error: new CpError(
          'CHUNK_MISMATCH',
          `chunk ${header.chunkIndex + 1} disagrees with the other chunks of backup ${this.backupIdHex} — probably a mis-scan`,
          { header },
        ),
      };
    }
    if (this.chunkData.has(header.chunkIndex)) {
      return { kind: 'duplicate', backupId: this.backupIdHex, chunkIndex: header.chunkIndex, backup: this };
    }
    this.chunkData.set(header.chunkIndex, data);
    return { kind: 'added', backupId: this.backupIdHex, chunkIndex: header.chunkIndex, backup: this };
  }

  groupProgress(): GroupProgress[] {
    const p = this.plan;
    const out: GroupProgress[] = [];
    for (let g = 0; g < p.groupCount; g++) {
      let have = 0;
      const missingCandidates: number[] = [];
      for (let s = 0; s < p.slotsPerGroup; s++) {
        const idx = dataChunkIndex(g, s, p);
        if (idx >= p.dataChunkCount) have++; // virtual zero slot — always known
        else if (this.chunkData.has(idx)) have++;
        else missingCandidates.push(idx);
      }
      for (let t = 0; t < p.parityPerGroup; t++) {
        const idx = parityChunkIndex(g, t, p);
        if (this.chunkData.has(idx)) have++;
        else missingCandidates.push(idx);
      }
      const need = p.slotsPerGroup;
      out.push({
        group: g,
        have: Math.min(have, need),
        need,
        satisfied: have >= need,
        missingCandidates: missingCandidates.sort((a, b) => a - b),
      });
    }
    return out;
  }

  isComplete(): boolean {
    return this.groupProgress().every((g) => g.satisfied);
  }

  /** Flat sorted list of chunk indexes that would still advance the restore. */
  stillUseful(): number[] {
    return this.groupProgress()
      .filter((g) => !g.satisfied)
      .flatMap((g) => g.missingCandidates)
      .sort((a, b) => a - b);
  }
}

export class ChunkCollector {
  readonly backups = new Map<string, CollectedBackup>();

  add(payload: Uint8Array): AddOutcome {
    let decoded;
    try {
      decoded = decodeChunk(payload);
    } catch (e) {
      if (isCpError(e)) return { kind: 'invalid', error: e };
      throw e;
    }
    const { header, data } = decoded;
    const idHex = toHex(header.backupId);
    let backup = this.backups.get(idHex);
    if (!backup) {
      backup = new CollectedBackup(header, data.length);
      this.backups.set(idHex, backup);
    }
    return backup.addDecoded(header, data);
  }

  /** Backups seen so far, fullest first. */
  list(): CollectedBackup[] {
    return [...this.backups.values()].sort((a, b) => b.capturedCount - a.capturedCount);
  }
}

export { locateChunk };
