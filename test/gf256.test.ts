import { describe, expect, it } from 'vitest';
import { EXP, LOG, gfDiv, gfInv, gfMul, gfMulAddInto } from '../src/core/gf256';

/** Slow-but-obviously-correct carry-less multiply for cross-checking the tables. */
function mulReference(a: number, b: number): number {
  let r = 0;
  let x = a;
  let y = b;
  while (y > 0) {
    if (y & 1) r ^= x;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
    y >>= 1;
  }
  return r;
}

describe('GF(256)', () => {
  it('EXP/LOG are mutual inverses', () => {
    for (let a = 1; a < 256; a++) expect(EXP[LOG[a]]).toBe(a);
    for (let i = 0; i < 255; i++) expect(LOG[EXP[i]]).toBe(i);
  });

  it('table multiplication matches the reference for all 65536 pairs', () => {
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        expect(gfMul(a, b)).toBe(mulReference(a, b));
      }
    }
  });

  it('every nonzero element has a working inverse', () => {
    for (let a = 1; a < 256; a++) expect(gfMul(a, gfInv(a))).toBe(1);
  });

  it('division inverts multiplication', () => {
    for (let a = 0; a < 256; a += 3) {
      for (let b = 1; b < 256; b += 5) {
        expect(gfMul(gfDiv(a, b), b)).toBe(a);
      }
    }
  });

  it('multiplication distributes over addition (xor)', () => {
    for (let a = 1; a < 256; a += 7) {
      for (let b = 0; b < 256; b += 11) {
        for (let c = 0; c < 256; c += 13) {
          expect(gfMul(a, b ^ c)).toBe(gfMul(a, b) ^ gfMul(a, c));
        }
      }
    }
  });

  it('gfMulAddInto matches the scalar definition', () => {
    const src = Uint8Array.from({ length: 300 }, (_, i) => (i * 37 + 11) & 0xff);
    for (const c of [0, 1, 2, 87, 255]) {
      const dst = Uint8Array.from({ length: 300 }, (_, i) => (i * 5 + 3) & 0xff);
      const expected = dst.map((v, i) => v ^ gfMul(c, src[i]));
      gfMulAddInto(dst, src, c);
      expect(dst).toEqual(expected);
    }
  });

  it('inverse/division by zero throw', () => {
    expect(() => gfInv(0)).toThrow();
    expect(() => gfDiv(1, 0)).toThrow();
  });
});
