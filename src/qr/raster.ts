import type { QrMatrix } from './generate';

/** 8-bit grayscale bitmap: 0 = ink, 255 = paper. */
export interface GrayBitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

/** ISO 18004 asks for ≥4 modules of quiet zone; we render it into every bitmap. */
export const QUIET_ZONE_MODULES = 4;

export function rasterizeMatrix(
  matrix: QrMatrix,
  modulePixels: number,
  quietModules: number = QUIET_ZONE_MODULES,
): GrayBitmap {
  const side = (matrix.size + quietModules * 2) * modulePixels;
  const data = new Uint8Array(side * side).fill(255);
  const offset = quietModules * modulePixels;
  for (let my = 0; my < matrix.size; my++) {
    for (let mx = 0; mx < matrix.size; mx++) {
      if (!matrix.data[my * matrix.size + mx]) continue;
      const y0 = offset + my * modulePixels;
      const x0 = offset + mx * modulePixels;
      for (let y = y0; y < y0 + modulePixels; y++) {
        data.fill(0, y * side + x0, y * side + x0 + modulePixels);
      }
    }
  }
  return { width: side, height: side, data };
}

/** Expand grayscale to the RGBA layout ImageData consumers (zxing, canvas) expect. */
export function grayToRgba(bitmap: GrayBitmap): Uint8ClampedArray {
  const out = new Uint8ClampedArray(bitmap.width * bitmap.height * 4);
  for (let i = 0; i < bitmap.data.length; i++) {
    const v = bitmap.data[i];
    const o = i * 4;
    out[o] = v;
    out[o + 1] = v;
    out[o + 2] = v;
    out[o + 3] = 255;
  }
  return out;
}
