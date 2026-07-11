/**
 * Systematic Reed-Solomon erasure coding over GF(256) using a Cauchy matrix.
 *
 * A group holds k data slots and m parity slots (k + m <= 255). Parity slot t
 * is computed as: parity[t] = sum_j C[t][j] * data[j], where
 *
 *     C[t][j] = 1 / ((k + t) XOR j)      t in [0, m), j in [0, k)
 *
 * Because every square submatrix of a Cauchy matrix is invertible, ANY k of the
 * k+m slots suffice to reconstruct all data slots - the property the whole
 * "tear a page off and restore anyway" promise rests on.
 */
import { CpError } from './errors';
import { EXP, LOG, gfInv, gfMul, gfMulAddInto } from './gf256';

export const MAX_GROUP_SHARDS = 255;

/** Row t of the Cauchy parity matrix for a group with k data slots. */
export function cauchyRow(k: number, t: number): Uint8Array {
  const row = new Uint8Array(k);
  for (let j = 0; j < k; j++) row[j] = gfInv((k + t) ^ j);
  return row;
}

/**
 * Compute m parity slots for the given data slots. A `null` slot is a virtual
 * all-zero slot (used by the striping layer for slots past the end of the
 * payload); it contributes nothing to parity.
 */
export function encodeParity(
  dataSlots: readonly (Uint8Array | null)[],
  m: number,
  chunkSize: number,
): Uint8Array[] {
  const k = dataSlots.length;
  if (k + m > MAX_GROUP_SHARDS) {
    throw new CpError('INTERNAL', `RS group too large: k=${k} m=${m}`);
  }
  const parity: Uint8Array[] = [];
  for (let t = 0; t < m; t++) {
    const row = cauchyRow(k, t);
    const out = new Uint8Array(chunkSize);
    for (let j = 0; j < k; j++) {
      const src = dataSlots[j];
      if (src) gfMulAddInto(out, src, row[j]);
    }
    parity.push(out);
  }
  return parity;
}

/** Gauss-Jordan inversion of an n by n matrix over GF(256) (with partial pivoting). */
export function gfInvertMatrix(matrix: Uint8Array[], n: number): Uint8Array[] {
  const a = matrix.map((r) => Uint8Array.from(r));
  const inv: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const row = new Uint8Array(n);
    row[i] = 1;
    inv.push(row);
  }
  for (let col = 0; col < n; col++) {
    let pivot = -1;
    for (let r = col; r < n; r++) {
      if (a[r][col] !== 0) {
        pivot = r;
        break;
      }
    }
    if (pivot === -1) throw new CpError('INTERNAL', 'singular matrix in RS decode');
    if (pivot !== col) {
      [a[pivot], a[col]] = [a[col], a[pivot]];
      [inv[pivot], inv[col]] = [inv[col], inv[pivot]];
    }
    const scale = gfInv(a[col][col]);
    if (scale !== 1) {
      const ls = LOG[scale];
      for (let j = 0; j < n; j++) {
        if (a[col][j] !== 0) a[col][j] = EXP[ls + LOG[a[col][j]]];
        if (inv[col][j] !== 0) inv[col][j] = EXP[ls + LOG[inv[col][j]]];
      }
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      const lf = LOG[factor];
      for (let j = 0; j < n; j++) {
        if (a[col][j] !== 0) a[r][j] ^= EXP[lf + LOG[a[col][j]]];
        if (inv[col][j] !== 0) inv[r][j] ^= EXP[lf + LOG[inv[col][j]]];
      }
    }
  }
  return inv;
}

export interface GroupDecodeInput {
  k: number;
  m: number;
  chunkSize: number;
  /** Data slots we already have (virtual zero slots must be included by the caller). */
  dataPresent: ReadonlyMap<number, Uint8Array>;
  /** Parity slots we captured, keyed by parity slot index t in [0, m). */
  parityPresent: ReadonlyMap<number, Uint8Array>;
}

/**
 * Reconstruct all k data slots of one group. Throws INSUFFICIENT_CHUNKS if the
 * number of missing data slots exceeds the number of captured parity slots.
 */
export function decodeGroup(input: GroupDecodeInput): Uint8Array[] {
  const { k, m, chunkSize, dataPresent, parityPresent } = input;

  for (const t of parityPresent.keys()) {
    if (t < 0 || t >= m) throw new CpError('INTERNAL', `parity slot ${t} outside [0, ${m})`);
  }

  const missing: number[] = [];
  for (let j = 0; j < k; j++) if (!dataPresent.has(j)) missing.push(j);

  const slots: Uint8Array[] = new Array(k);
  for (const [j, bytes] of dataPresent) slots[j] = bytes;
  if (missing.length === 0) return slots;

  if (missing.length > parityPresent.size) {
    throw new CpError(
      'INSUFFICIENT_CHUNKS',
      `need ${missing.length} more chunk(s) for this group, have only ${parityPresent.size} spare`,
      { missingData: missing.length, parityAvailable: parityPresent.size },
    );
  }

  // Use the first e captured parity rows (any e work - every submatrix is invertible).
  const e = missing.length;
  const rows = [...parityPresent.keys()].sort((x, y) => x - y).slice(0, e);

  // rhs_t = parity_t XOR sum_{known j} C[t][j] * data_j
  const rhs: Uint8Array[] = [];
  for (const t of rows) {
    const row = cauchyRow(k, t);
    const acc = Uint8Array.from(parityPresent.get(t)!);
    for (const [j, bytes] of dataPresent) {
      if (j < k) gfMulAddInto(acc, bytes, row[j]);
    }
    rhs.push(acc);
  }

  // A[e][e]: parity coefficients restricted to the missing columns.
  const a: Uint8Array[] = rows.map((t) => {
    const full = cauchyRow(k, t);
    const r = new Uint8Array(e);
    for (let i = 0; i < e; i++) r[i] = full[missing[i]];
    return r;
  });
  const ainv = gfInvertMatrix(a, e);

  for (let i = 0; i < e; i++) {
    const out = new Uint8Array(chunkSize);
    for (let t = 0; t < e; t++) gfMulAddInto(out, rhs[t], ainv[i][t]);
    slots[missing[i]] = out;
  }
  return slots;
}

/** Multiply helper exposed for tests. */
export { gfMul };
