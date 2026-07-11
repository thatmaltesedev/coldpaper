import { describe, expect, it } from 'vitest';
import { isCpError } from '../src/core/errors';
import { cauchyRow, decodeGroup, encodeParity, gfInvertMatrix, gfMul } from '../src/core/rs';
import { mulberry32, pickDistinct, randInt, randomBytes } from './helpers/rng';

function makeSlots(rand: () => number, k: number, size: number): Uint8Array[] {
  return Array.from({ length: k }, () => randomBytes(rand, size));
}

/**
 * Simulate a capture: of the k+m shards, keep exactly the ones in `kept`
 * (indices 0..k-1 are data, k..k+m-1 are parity) and reconstruct.
 */
function reconstruct(
  data: Uint8Array[],
  parity: Uint8Array[],
  kept: Set<number>,
  chunkSize: number,
): Uint8Array[] {
  const k = data.length;
  const dataPresent = new Map<number, Uint8Array>();
  const parityPresent = new Map<number, Uint8Array>();
  for (const i of kept) {
    if (i < k) dataPresent.set(i, data[i]);
    else parityPresent.set(i - k, parity[i - k]);
  }
  return decodeGroup({ k, m: parity.length, chunkSize, dataPresent, parityPresent });
}

describe('Reed-Solomon over GF(256)', () => {
  it('matrix inversion round-trips (A * A^-1 = I)', () => {
    const rand = mulberry32(7);
    for (let trial = 0; trial < 20; trial++) {
      const n = 1 + randInt(rand, 12);
      // Random Cauchy submatrix rows — always invertible.
      const k = n + randInt(rand, 40);
      const rows = pickDistinct(rand, 40, n).map((t) => cauchyRow(k, t));
      const a = rows.map((r) => {
        const cols = pickDistinct(rand, k, n).sort((x, y) => x - y);
        return Uint8Array.from(cols.map((c) => r[c]));
      });
      // Rebuild consistent columns: use same column set for every row.
      const cols = pickDistinct(rand, k, n).sort((x, y) => x - y);
      const rowIdx = pickDistinct(rand, 60, n);
      const m2 = rowIdx.map((t) => Uint8Array.from(cols.map((c) => cauchyRow(k, t)[c])));
      const inv = gfInvertMatrix(m2, n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          let acc = 0;
          for (let l = 0; l < n; l++) acc ^= gfMul(m2[i][l], inv[l][j]);
          expect(acc).toBe(i === j ? 1 : 0);
        }
      }
      void a;
    }
  });

  it('recovers from any loss pattern up to m shards (randomised)', () => {
    const rand = mulberry32(42);
    const configs = [
      { k: 1, m: 1 },
      { k: 2, m: 1 },
      { k: 3, m: 2 },
      { k: 10, m: 3 },
      { k: 40, m: 10 },
      { k: 168, m: 84 },
    ];
    for (const { k, m } of configs) {
      const size = 64;
      const data = makeSlots(rand, k, size);
      const parity = encodeParity(data, m, size);
      for (let trial = 0; trial < 8; trial++) {
        const lost = new Set(pickDistinct(rand, k + m, randInt(rand, m + 1)));
        const kept = new Set<number>();
        for (let i = 0; i < k + m; i++) if (!lost.has(i)) kept.add(i);
        const out = reconstruct(data, parity, kept, size);
        for (let j = 0; j < k; j++) expect(out[j]).toEqual(data[j]);
      }
    }
  });

  it('recovers from ANY k-subset of the k+m shards (exhaustive for small groups)', () => {
    const rand = mulberry32(1234);
    const k = 4;
    const m = 3;
    const size = 48;
    const data = makeSlots(rand, k, size);
    const parity = encodeParity(data, m, size);
    // Every subset of size k out of k+m=7 shards: C(7,4) = 35 combinations.
    const n = k + m;
    for (let mask = 0; mask < 1 << n; mask++) {
      let bits = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) bits++;
      if (bits !== k) continue;
      const kept = new Set<number>();
      for (let i = 0; i < n; i++) if (mask & (1 << i)) kept.add(i);
      const out = reconstruct(data, parity, kept, size);
      for (let j = 0; j < k; j++) expect(out[j]).toEqual(data[j]);
    }
  });

  it('reconstructs from parity alone when m >= k', () => {
    const rand = mulberry32(99);
    const k = 3;
    const m = 3;
    const size = 32;
    const data = makeSlots(rand, k, size);
    const parity = encodeParity(data, m, size);
    const kept = new Set([k, k + 1, k + 2]); // parity only
    const out = reconstruct(data, parity, kept, size);
    for (let j = 0; j < k; j++) expect(out[j]).toEqual(data[j]);
  });

  it('fails cleanly with INSUFFICIENT_CHUNKS when m+1 shards are lost', () => {
    const rand = mulberry32(7777);
    const k = 10;
    const m = 3;
    const size = 32;
    const data = makeSlots(rand, k, size);
    const parity = encodeParity(data, m, size);
    // Lose m+1 = 4 data shards; all parity present: 10-4+3 = 9 < k.
    const kept = new Set<number>();
    for (let i = 4; i < k + m; i++) kept.add(i);
    try {
      reconstruct(data, parity, kept, size);
      expect.unreachable('reconstruction should have failed');
    } catch (e) {
      expect(isCpError(e, 'INSUFFICIENT_CHUNKS')).toBe(true);
    }
  });

  it('treats null slots as virtual zeros', () => {
    const rand = mulberry32(5);
    const k = 5;
    const m = 2;
    const size = 16;
    const data = makeSlots(rand, k - 1, size);
    const zero = new Uint8Array(size);
    const parityWithNull = encodeParity([...data, null], m, size);
    const parityWithZero = encodeParity([...data, zero], m, size);
    expect(parityWithNull).toEqual(parityWithZero);
  });

  it('parity actually depends on every data slot', () => {
    const rand = mulberry32(3);
    const k = 6;
    const m = 2;
    const size = 8;
    const data = makeSlots(rand, k, size);
    const base = encodeParity(data, m, size);
    for (let j = 0; j < k; j++) {
      const tweaked = data.map((d, i) => (i === j ? d.map((v) => v ^ 0x5a) : d));
      const parity = encodeParity(tweaked as Uint8Array[], m, size);
      expect(parity[0]).not.toEqual(base[0]);
    }
  });
});
