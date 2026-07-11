/**
 * zxing-wasm harness for Node tests: loads the wasm binary from node_modules
 * (no network) and decodes QR codes from raw bitmaps or encoded image bytes —
 * the SAME decoder the app bundles, so tests exercise the shipped scan path.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { grayToRgba, type GrayBitmap } from '../../src/qr/raster';

let prepared = false;

function init(): void {
  if (prepared) return;
  const wasmPath = fileURLToPath(
    new URL('../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', import.meta.url),
  );
  const bytes = readFileSync(wasmPath);
  const wasmBinary = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  prepareZXingModule({ overrides: { wasmBinary } });
  prepared = true;
}

export async function decodeBitmap(bitmap: GrayBitmap, maxSymbols = 24): Promise<Uint8Array[]> {
  init();
  const imageData = { data: grayToRgba(bitmap), width: bitmap.width, height: bitmap.height };
  const results = await readBarcodes(imageData as unknown as ImageData, {
    formats: ['QRCode'],
    tryHarder: true,
    maxNumberOfSymbols: maxSymbols,
  });
  return results.filter((r) => r.isValid).map((r) => r.bytes);
}

/** Decode from encoded image file bytes (exercises PNG parsing inside zxing). */
export async function decodeImageFile(fileBytes: Uint8Array, maxSymbols = 24): Promise<Uint8Array[]> {
  init();
  const results = await readBarcodes(fileBytes, {
    formats: ['QRCode'],
    tryHarder: true,
    maxNumberOfSymbols: maxSymbols,
  });
  return results.filter((r) => r.isValid).map((r) => r.bytes);
}
