/**
 * Print-and-scan damage simulation on grayscale bitmaps: rotation (skewed
 * paper), scaling (distance/resolution), gaussian noise (sensor + paper
 * texture) and blur (focus, ink bleed). Pure TS — no canvas needed.
 */
import type { GrayBitmap } from '../../src/qr/raster';
import type { Rand } from './rng';

/**
 * Rotate around the centre by `degrees`, bilinear sampling, white background.
 * The canvas expands so nothing is clipped — like a photo of a skewed page.
 */
export function rotate(img: GrayBitmap, degrees: number): GrayBitmap {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const width = Math.ceil(img.width * Math.abs(cos) + img.height * Math.abs(sin));
  const height = Math.ceil(img.width * Math.abs(sin) + img.height * Math.abs(cos));
  const out = new Uint8Array(width * height).fill(255);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const scx = (img.width - 1) / 2;
  const scy = (img.height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Inverse mapping: where did this output pixel come from?
      const dx = x - cx;
      const dy = y - cy;
      const sx = scx + dx * cos + dy * sin;
      const sy = scy - dx * sin + dy * cos;
      out[y * width + x] = sampleBilinear(img.data, img.width, img.height, sx, sy);
    }
  }
  return { width, height, data: out };
}

/** Resize by `factor` with bilinear sampling. */
export function scale(img: GrayBitmap, factor: number): GrayBitmap {
  const width = Math.max(1, Math.round(img.width * factor));
  const height = Math.max(1, Math.round(img.height * factor));
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = sampleBilinear(img.data, img.width, img.height, x / factor, y / factor);
    }
  }
  return { width, height, data: out };
}

function sampleBilinear(data: Uint8Array, width: number, height: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 255;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const top = data[y0 * width + x0] * (1 - fx) + data[y0 * width + x1] * fx;
  const bottom = data[y1 * width + x0] * (1 - fx) + data[y1 * width + x1] * fx;
  return Math.round(top * (1 - fy) + bottom * fy);
}

/** Add gaussian noise with standard deviation `sigma` (Box–Muller, seeded). */
export function addNoise(img: GrayBitmap, sigma: number, rand: Rand): GrayBitmap {
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < out.length; i += 2) {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    const n0 = r * Math.cos(2 * Math.PI * u2) * sigma;
    const n1 = r * Math.sin(2 * Math.PI * u2) * sigma;
    out[i] = clamp(img.data[i] + n0);
    if (i + 1 < out.length) out[i + 1] = clamp(img.data[i + 1] + n1);
  }
  return { width: img.width, height: img.height, data: out };
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Separable box blur with the given radius (0 = no-op). */
export function boxBlur(img: GrayBitmap, radius: number): GrayBitmap {
  if (radius <= 0) return img;
  const { width, height } = img;
  const tmp = new Uint8Array(img.data.length);
  const out = new Uint8Array(img.data.length);
  const window = radius * 2 + 1;
  // horizontal
  for (let y = 0; y < height; y++) {
    let acc = 0;
    for (let x = -radius; x <= radius; x++) acc += at(img.data, width, height, x, y);
    for (let x = 0; x < width; x++) {
      tmp[y * width + x] = Math.round(acc / window);
      acc += at(img.data, width, height, x + radius + 1, y) - at(img.data, width, height, x - radius, y);
    }
  }
  // vertical
  for (let x = 0; x < width; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += at(tmp, width, height, x, y);
    for (let y = 0; y < height; y++) {
      out[y * width + x] = Math.round(acc / window);
      acc += at(tmp, width, height, x, y + radius + 1) - at(tmp, width, height, x, y - radius);
    }
  }
  return { width, height, data: out };
}

function at(data: Uint8Array, width: number, height: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
  const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
  return data[cy * width + cx];
}
