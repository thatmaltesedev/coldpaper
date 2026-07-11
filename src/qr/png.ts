/**
 * Minimal 8-bit grayscale PNG encoder (color type 0, filter 0) — enough for
 * QR bitmaps, tiny, and shared verbatim between the app (PDF embedding) and
 * the tests (what we test is what prints). Compression via fflate's zlib.
 */
import { zlibSync } from 'fflate';
import { concatBytes, crc32, writeU32BE } from '../core/bytes';
import type { GrayBitmap } from './raster';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  writeU32BE(out, 0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  writeU32BE(out, 8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

export function encodeGrayPng(bitmap: GrayBitmap): Uint8Array {
  const { width, height, data } = bitmap;
  const ihdr = new Uint8Array(13);
  writeU32BE(ihdr, 0, width);
  writeU32BE(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  // compression 0, filter 0, interlace 0 — already zeroed

  // Every scanline prefixed with filter byte 0 (None).
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(data.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const idat = zlibSync(raw, { level: 6 });

  return concatBytes([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
}
