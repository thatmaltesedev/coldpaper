/**
 * Striping layer: maps a payload onto one or more Reed-Solomon groups.
 *
 * A single RS group over GF(256) can hold at most 255 shards, which caps a
 * backup at ~200 QR codes. To honour the 5 MB cap we stripe: data chunks are
 * dealt round-robin across G groups (chunk i belongs to group i mod G), and
 * every group gets its own m parity chunks. Round-robin matters on paper:
 * physically adjacent codes land in different groups, so a torn corner or a
 * coffee stain spreads its damage evenly instead of exhausting one group.
 *
 * Guarantees (documented in FORMAT.md §7):
 *  - loss of ANY m codes is always recoverable;
 *  - loss of up to m*G codes is recoverable when no group loses more than m,
 *    which round-robin makes the norm for contiguous damage;
 *  - for backups small enough to fit one group (G = 1, files up to ~130 KB at
 *    the default density) the promise is exact: any m of the k+m codes.
 */
import { CpError } from './errors';
import { MAX_GROUP_SHARDS } from './rs';

/** Cap on data slots per group, leaving room for up to 50% parity + slack. */
export const DATA_SLOTS_CAP = 168;

export interface RsPlan {
  /** True byte length of the payload (before zero-padding the last chunk). */
  payloadLength: number;
  /** S: data bytes carried by every chunk. */
  chunkSize: number;
  /** kTotal: number of real data chunks across all groups. */
  dataChunkCount: number;
  /** G: number of RS groups. */
  groupCount: number;
  /** k: data slots per group (incl. virtual zero slots in trailing groups). */
  slotsPerGroup: number;
  /** m: parity chunks per group. */
  parityPerGroup: number;
  /** Real chunks emitted as QR codes: kTotal + m*G. */
  totalChunks: number;
}

export function planBackup(payloadLength: number, chunkSize: number, redundancyPercent: number): RsPlan {
  if (payloadLength < 1) throw new CpError('INTERNAL', 'cannot plan an empty payload');
  if (chunkSize < 16) throw new CpError('INTERNAL', `chunk size ${chunkSize} is too small`);
  const dataChunkCount = Math.ceil(payloadLength / chunkSize);
  const groupCount = Math.ceil(dataChunkCount / DATA_SLOTS_CAP);
  if (dataChunkCount > 0xffff || groupCount > 0xff) {
    throw new CpError('FILE_TOO_LARGE', 'file needs more chunks than the format allows', {
      dataChunkCount,
      groupCount,
    });
  }
  const slotsPerGroup = Math.ceil(dataChunkCount / groupCount);
  const parityPerGroup = Math.max(1, Math.ceil((slotsPerGroup * redundancyPercent) / 100));
  if (slotsPerGroup + parityPerGroup > MAX_GROUP_SHARDS) {
    throw new CpError('INTERNAL', `group over capacity: k=${slotsPerGroup} m=${parityPerGroup}`);
  }
  const totalChunks = dataChunkCount + parityPerGroup * groupCount;
  if (totalChunks > 0xffff) {
    throw new CpError('FILE_TOO_LARGE', 'backup exceeds 65535 chunks');
  }
  return {
    payloadLength,
    chunkSize,
    dataChunkCount,
    groupCount,
    slotsPerGroup,
    parityPerGroup,
    totalChunks,
  };
}

/** Rebuild the plan from fields carried by every chunk header. */
export function planFromHeader(fields: {
  payloadLength: number;
  dataChunkCount: number;
  groupCount: number;
  parityPerGroup: number;
  chunkSize: number;
}): RsPlan {
  const { payloadLength, dataChunkCount, groupCount, parityPerGroup, chunkSize } = fields;
  const slotsPerGroup = Math.ceil(dataChunkCount / groupCount);
  return {
    payloadLength,
    chunkSize,
    dataChunkCount,
    groupCount,
    slotsPerGroup,
    parityPerGroup,
    totalChunks: dataChunkCount + parityPerGroup * groupCount,
  };
}

export interface ChunkLocation {
  kind: 'data' | 'parity';
  group: number;
  /** Data slot j in [0, k) or parity slot t in [0, m). */
  slot: number;
}

export function locateChunk(index: number, plan: RsPlan): ChunkLocation {
  if (index < 0 || index >= plan.totalChunks) {
    throw new CpError('INTERNAL', `chunk index ${index} out of range`);
  }
  if (index < plan.dataChunkCount) {
    return { kind: 'data', group: index % plan.groupCount, slot: Math.floor(index / plan.groupCount) };
  }
  const t = index - plan.dataChunkCount;
  return { kind: 'parity', group: t % plan.groupCount, slot: Math.floor(t / plan.groupCount) };
}

/** Global chunk index of data slot `slot` in `group`; may point past the payload (virtual slot). */
export function dataChunkIndex(group: number, slot: number, plan: RsPlan): number {
  return slot * plan.groupCount + group;
}

/** Global chunk index of parity slot `slot` in `group`. */
export function parityChunkIndex(group: number, slot: number, plan: RsPlan): number {
  return plan.dataChunkCount + slot * plan.groupCount + group;
}

/** Virtual slots exist only to keep every group at exactly k slots; they are all-zero and never printed. */
export function isVirtualSlot(group: number, slot: number, plan: RsPlan): boolean {
  return dataChunkIndex(group, slot, plan) >= plan.dataChunkCount;
}
