/**
 * pdf.js (pdfjs-dist >= 5) polyfills DOMMatrix/ImageData/Path2D in Node via
 * `process.getBuiltinModule`, which older Node lines (e.g. 21.x) lack. Shim it
 * before pdf.js loads so the test suite runs on any Node >= 20. CI's Node 22
 * never hits this branch.
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

const proc = process as unknown as { getBuiltinModule?: (id: string) => unknown };
if (typeof proc.getBuiltinModule !== 'function') {
  proc.getBuiltinModule = (id: string) => nodeRequire(id);
}

export async function loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}
