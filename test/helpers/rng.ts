/** Deterministic PRNG so every "random" test failure reproduces exactly. */
export type Rand = () => number;

export function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rand: Rand, maxExclusive: number): number {
  return Math.floor(rand() * maxExclusive);
}

export function randomBytes(rand: Rand, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = randInt(rand, 256);
  return out;
}

/** Bytes with heavy repetition, so DEFLATE actually shrinks them. */
export function compressibleBytes(rand: Rand, n: number): Uint8Array {
  const out = new Uint8Array(n);
  const phrase = new TextEncoder().encode('the quick brown fax jumped over the lazy backup. ');
  for (let i = 0; i < n; i++) out[i] = i % 7 === 0 ? randInt(rand, 256) : phrase[i % phrase.length];
  return out;
}

/** Choose `count` distinct values from [0, n) without replacement. */
export function pickDistinct(rand: Rand, n: number, count: number): number[] {
  const all = Array.from({ length: n }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = randInt(rand, i + 1);
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, count);
}
