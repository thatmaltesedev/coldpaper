/**
 * The credibility test, part 2: the ACTUAL printable PDF, rendered to page
 * images (pdf.js - a wholly independent PDF implementation), scanned with the
 * bundled zxing decoder, damaged, and restored byte-identically.
 *
 * This is "print it, tear a page off, restore anyway" minus the paper.
 */
import { createCanvas } from '@napi-rs/canvas';
import { beforeAll, describe, expect, it } from 'vitest';
import { ChunkCollector } from '../src/core/collector';
import { createBackup, restoreBackup, type BackupResult } from '../src/core/pipeline';
import { buildPdf } from '../src/pdf/build';
import { A4, CODES_PER_PAGE, codePageCount, LETTER } from '../src/pdf/layout';
import { presetById } from '../src/qr/presets';
import { loadPdfjs } from './helpers/pdfjs-node';
import { mulberry32, randomBytes } from './helpers/rng';
import { decodeRgba } from './helpers/zxing';

interface RgbaPage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

async function renderPdf(pdfBytes: Uint8Array, dpi: number): Promise<RgbaPage[]> {
  const { getDocument } = await loadPdfjs();
  const doc = await getDocument({
    data: Uint8Array.from(pdfBytes),
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  const pages: RgbaPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    pages.push({ data: image.data, width: image.width, height: image.height });
  }
  await doc.destroy();
  return pages;
}

describe('printed-PDF round trip', () => {
  const rand = mulberry32(20260711);
  const preset = presetById('easy');
  const fileBytes = randomBytes(rand, 60 * 1024); // incompressible, ~74 data chunks
  let backup: BackupResult;
  let pdfBytes: Uint8Array;
  let pageCodes: Uint8Array[][] = [];

  beforeAll(async () => {
    backup = await createBackup({
      fileName: 'tax-return-2025.pdf',
      fileBytes,
      chunkSize: preset.chunkSize,
      redundancyPercent: 25,
    });
    pdfBytes = await buildPdf({
      backup,
      fileName: 'tax-return-2025.pdf',
      fileSize: fileBytes.length,
      preset,
      paper: A4,
      redundancyPercent: 25,
      createdOn: '2026-07-11',
      appUrl: 'https://example.invalid/coldpaper',
    });
    const pages = await renderPdf(pdfBytes, 150);
    pageCodes = [];
    for (const page of pages) pageCodes.push(await decodeRgba(page, CODES_PER_PAGE + 4));
  }, 300_000);

  it('produces a plausible PDF (cover + code pages)', () => {
    expect(pdfBytes.length).toBeGreaterThan(10_000);
    expect(pageCodes.length).toBe(1 + codePageCount(backup.plan.totalChunks));
  });

  it('cover sheet contains no QR codes', () => {
    expect(pageCodes[0]).toHaveLength(0);
  });

  it('every single code on every page decodes from the rendered PDF', () => {
    const decoded = pageCodes.slice(1).reduce((n, page) => n + page.length, 0);
    expect(decoded).toBe(backup.plan.totalChunks);
  });

  it('full restore from the rendered pages is byte-identical', async () => {
    const collector = new ChunkCollector();
    for (const page of pageCodes.slice(1)) for (const code of page) collector.add(code);
    const [collected] = collector.list();
    expect(collected.capturedCount).toBe(backup.plan.totalChunks);
    const restored = await restoreBackup(collected);
    expect(restored.bytes).toEqual(fileBytes);
    expect(restored.sha256).toEqual(backup.fileHash);
    expect(restored.name).toBe('tax-return-2025.pdf');
  });

  it('restores with one page torn off AND a coffee stain on another', async () => {
    const plan = backup.plan;
    const tolerance = plan.parityPerGroup * plan.groupCount;
    expect(tolerance).toBeGreaterThan(CODES_PER_PAGE + 2); // page (12) + stain (2)

    const collector = new ChunkCollector();
    const codePages = pageCodes.slice(1);
    for (let p = 0; p < codePages.length; p++) {
      if (p === 1) continue; // page 2 of the codes: torn off and lost
      let codes = codePages[p];
      if (p === 3) codes = codes.slice(2); // coffee mug ate two codes of page 4
      for (const code of codes) collector.add(code);
    }
    const [collected] = collector.list();
    expect(collected.capturedCount).toBeLessThan(plan.totalChunks);
    const restored = await restoreBackup(collected);
    expect(restored.bytes).toEqual(fileBytes);
  });

  it('the dense preset fully decodes at the in-app PDF-import DPI', async () => {
    // The restore tab renders imported PDFs at PDF_IMPORT_DPI. Even the
    // tightest preset (v40, 177 modules per code) must decode losslessly at
    // that resolution, or the "restore from the PDF itself" path would
    // silently under-deliver.
    const { PDF_IMPORT_DPI } = await import('../src/scan/pdf-import');
    const preset3 = presetById('dense');
    const denseFile = randomBytes(rand, 30 * 1024);
    const backup3 = await createBackup({
      fileName: 'dense-import.bin',
      fileBytes: denseFile,
      chunkSize: preset3.chunkSize,
      redundancyPercent: 25,
    });
    const pdf3 = await buildPdf({
      backup: backup3,
      fileName: 'dense-import.bin',
      fileSize: denseFile.length,
      preset: preset3,
      paper: A4,
      redundancyPercent: 25,
      createdOn: '2026-07-11',
      appUrl: 'https://example.invalid/coldpaper',
    });
    const pages = await renderPdf(pdf3, PDF_IMPORT_DPI);
    const collector = new ChunkCollector();
    let found = 0;
    for (const page of pages.slice(1)) {
      for (const code of await decodeRgba(page, CODES_PER_PAGE + 4)) {
        found++;
        collector.add(code);
      }
    }
    expect(found).toBe(backup3.plan.totalChunks);
    const restored = await restoreBackup(collector.list()[0]);
    expect(restored.bytes).toEqual(denseFile);
  }, 300_000);

  it('letter paper + balanced preset also survive the printer', async () => {
    const preset2 = presetById('balanced');
    const smallFile = randomBytes(rand, 18 * 1024);
    const backup2 = await createBackup({
      fileName: 'passwords.kdbx',
      fileBytes: smallFile,
      chunkSize: preset2.chunkSize,
      redundancyPercent: 30,
    });
    const pdf2 = await buildPdf({
      backup: backup2,
      fileName: 'passwords.kdbx',
      fileSize: smallFile.length,
      preset: preset2,
      paper: LETTER,
      redundancyPercent: 30,
      createdOn: '2026-07-11',
      appUrl: 'https://example.invalid/coldpaper',
    });
    const pages = await renderPdf(pdf2, 200);
    const collector = new ChunkCollector();
    let found = 0;
    for (const page of pages.slice(1)) {
      for (const code of await decodeRgba(page, CODES_PER_PAGE + 4)) {
        found++;
        collector.add(code);
      }
    }
    expect(found).toBe(backup2.plan.totalChunks);
    const restored = await restoreBackup(collector.list()[0]);
    expect(restored.bytes).toEqual(smallFile);
  }, 300_000);
});
