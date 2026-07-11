/**
 * Arithmetic over GF(2^8) with the reducing polynomial x^8+x^4+x^3+x^2+1 (0x11d)
 * and generator element 2 — the same field QR codes themselves use.
 *
 * Addition and subtraction are both XOR. Multiplication and division go through
 * exp/log tables. EXP is doubled in length so `EXP[LOG[a] + LOG[b]]` never needs
 * a modulo.
 */
import { CpError } from './errors';

export const GF_POLY = 0x11d;

export const EXP = new Uint8Array(510);
export const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF_POLY;
  }
  for (let i = 255; i < 510; i++) EXP[i] = EXP[i - 255];
}

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new CpError('INTERNAL', 'division by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[LOG[a] + 255 - LOG[b]];
}

export function gfInv(a: number): number {
  if (a === 0) throw new CpError('INTERNAL', 'inverse of zero in GF(256)');
  return EXP[255 - LOG[a]];
}

/** dst[i] ^= c * src[i], for i in [0, src.length). The hot loop of the whole coder. */
export function gfMulAddInto(dst: Uint8Array, src: Uint8Array, c: number): void {
  if (c === 0) return;
  const lc = LOG[c];
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v !== 0) dst[i] ^= EXP[lc + LOG[v]];
  }
}
