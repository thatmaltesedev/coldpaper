/**
 * Builds the printable PDF: a human-readable cover sheet followed by pages of
 * labelled QR codes. Everything a future stranger needs to restore the file -
 * including a written description of the format - is ON the paper.
 */
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from 'pdf-lib';
import { toHex } from '../core/bytes';
import { FLAG_ENCRYPTED } from '../core/format';
import type { BackupResult } from '../core/pipeline';
import { makeQrMatrix } from '../qr/generate';
import { encodeGrayPng } from '../qr/png';
import type { DensityPreset } from '../qr/presets';
import { rasterizeMatrix } from '../qr/raster';
import { CODES_PER_PAGE, codePageCount, computeGrid, type PaperSize } from './layout';

const INK = rgb(0.08, 0.08, 0.08);
const RULE = rgb(0.62, 0.62, 0.62);

export interface PdfBuildOptions {
  backup: BackupResult;
  fileName: string;
  fileSize: number;
  preset: DensityPreset;
  paper: PaperSize;
  redundancyPercent: number;
  /** ISO date shown on the cover, e.g. "2026-07-11". */
  createdOn: string;
  /** Where the app lives (printed in the restore instructions). */
  appUrl: string;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Replace anything Helvetica/Courier (WinAnsi) cannot draw. The escaped list
 * keeps the cp1252 punctuation that user filenames may legitimately contain
 * (dashes, curly quotes, bullet, ellipsis, euro, trademark).
 */
function winAnsi(text: string): string {
  return text.replace(
    /[^\x20-\x7e\xa0-\xff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026\u20ac\u2122]/g,
    '?',
  );
}

function groupedHex(bytes: Uint8Array): string[] {
  const hex = toHex(bytes).toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 4) groups.push(hex.slice(i, i + 4));
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += 4) lines.push(groups.slice(i, i + 4).join(' '));
  return lines;
}

export async function buildPdf(options: PdfBuildOptions): Promise<Uint8Array> {
  const { backup, fileName, fileSize, preset, paper, redundancyPercent, createdOn, appUrl, onProgress } = options;
  const plan = backup.plan;
  const encrypted = (backup.flags & FLAG_ENCRYPTED) !== 0;
  const totalCodes = plan.totalChunks;
  const parityTotal = plan.parityPerGroup * plan.groupCount;
  const pageTotal = codePageCount(totalCodes);
  const idHex = toHex(backup.backupId).toUpperCase();

  const doc = await PDFDocument.create();
  doc.setTitle(`Coldpaper backup - ${fileName}`);
  doc.setCreator(`coldpaper v${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'}`);
  doc.setProducer('coldpaper (pdf-lib)');

  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const monoBold = await doc.embedFont(StandardFonts.CourierBold);

  // ---------------------------------------------------------------- cover
  const cover = doc.addPage([paper.width, paper.height]);
  const left = 54;
  const width = paper.width - 2 * left;
  let cursor = 64; // top-down cursor in points

  const text = (
    page: PDFPage,
    str: string,
    topY: number,
    opts: { font?: PDFFont; size?: number; x?: number; center?: boolean },
  ) => {
    const font = opts.font ?? helv;
    const size = opts.size ?? 10;
    const safe = winAnsi(str);
    let x = opts.x ?? left;
    if (opts.center) x = (page.getWidth() - font.widthOfTextAtSize(safe, size)) / 2;
    page.drawText(safe, { x, y: page.getHeight() - topY, size, font, color: INK });
  };
  const label = (str: string) => {
    text(cover, str.toUpperCase(), cursor, { font: monoBold, size: 8 });
    cursor += 14;
  };
  const rule = () => {
    cover.drawLine({
      start: { x: left, y: cover.getHeight() - cursor },
      end: { x: left + width, y: cover.getHeight() - cursor },
      thickness: 0.7,
      color: RULE,
    });
    cursor += 18;
  };

  text(cover, 'COLDPAPER', cursor, { font: bold, size: 30 });
  cursor += 16;
  text(cover, 'One file, printed as QR codes. This paper IS the backup.', cursor, { size: 11 });
  cursor += 14;
  rule();

  label('File');
  text(cover, fileName || '(unnamed file)', cursor, { font: bold, size: 14 });
  cursor += 17;
  text(cover, `${fileSize.toLocaleString('en-US')} bytes - backed up ${createdOn}${encrypted ? ' - ENCRYPTED (passphrase required)' : ''}`, cursor, {
    size: 10,
  });
  cursor += 22;

  label(encrypted ? 'SHA-256 fingerprint (of the encrypted payload)' : 'SHA-256 fingerprint (of the file)');
  for (const line of groupedHex(encrypted ? backup.payloadHash : backup.fileHash)) {
    text(cover, line, cursor, { font: mono, size: 11 });
    cursor += 14;
  }
  if (encrypted) {
    text(cover, 'The plaintext filename, size and hash are stored inside the encrypted data.', cursor, { size: 8.5 });
    cursor += 12;
  }
  cursor += 8;

  label('Backup');
  text(
    cover,
    `ID ${idHex} - ${preset.label} (QR v${preset.qrVersion}-${preset.errorCorrectionLevel}) - ${paper.label} - ${redundancyPercent}% redundancy`,
    cursor,
    { size: 10 },
  );
  cursor += 13;
  text(
    cover,
    `${totalCodes} codes (${plan.dataChunkCount} data + ${parityTotal} parity) on ${pageTotal} page${pageTotal === 1 ? '' : 's'}`,
    cursor,
    { size: 10 },
  );
  cursor += 13;
  const tolerance =
    plan.groupCount === 1
      ? `Any ${parityTotal} codes can be torn, stained or missing - any ${plan.dataChunkCount} of the ${totalCodes} recover the file.`
      : `Codes interleave across ${plan.groupCount} groups; each tolerates ${plan.parityPerGroup} losses - up to ${parityTotal} total for spread-out damage (worst case ${plan.parityPerGroup} if all damage hits one group).`;
  text(cover, tolerance, cursor, { font: bold, size: 10 });
  cursor += 22;

  label('How to restore');
  const steps = [
    `1. Open ${appUrl} on any phone or computer (works offline once loaded),`,
    '   or open coldpaper-offline.html from the USB stick kept with this backup.',
    '2. Tap RESTORE and point the camera at every page - or import photos/scans.',
    '3. Any order, duplicates are fine. The app tells you when it has enough,',
    '   verifies the SHA-256 fingerprint, and hands you the original file.',
  ];
  for (const s of steps) {
    text(cover, s, cursor, { size: 10.5 });
    cursor += 13.5;
  }
  cursor += 9;

  label('If this app is gone (for a future engineer)');
  const techLines = [
    'Each QR code (binary/byte mode) holds one chunk: a 22-byte frame - magic "CP",',
    'version, random backup id (4B), payload length (u32), chunk index (u16), data-chunk',
    'count k (u16), group count G, parity-per-group m, flags (bit0 DEFLATE, bit1',
    'AES-256-GCM), CRC-32 - then S data bytes. Data chunks 0..k-1, in index order,',
    'concatenated and cut to payload length, form: [metadata | file content], possibly',
    'DEFLATE-compressed then AES-256-GCM-encrypted (key: PBKDF2-SHA256, 600000',
    'iterations, salt/iv prefixed). Chunks k.. are Reed-Solomon parity over GF(256)',
    '(poly 0x11D, Cauchy matrix, chunk i in group i mod G): any k-per-group suffice.',
    `Full spec: FORMAT.md in the source repository - ${appUrl.replace(/\/$/, '')} - mirrored with every copy.`,
  ];
  for (const s of techLines) {
    text(cover, s, cursor, { font: mono, size: 8 });
    cursor += 10.5;
  }

  drawFooter(cover, mono, `coldpaper - backup ${idHex} - cover sheet - ${createdOn} - format v1`);

  // ------------------------------------------------------------ code pages
  const grid = computeGrid(paper);
  for (let page = 0; page < pageTotal; page++) {
    const p = doc.addPage([paper.width, paper.height]);
    text(p, `coldpaper - ${fileName || 'backup'} - ${idHex}`, 30, { font: mono, size: 8.5 });
    const pageLabel = `page ${page + 1} of ${pageTotal}`;
    p.drawText(pageLabel, {
      x: paper.width - 36 - mono.widthOfTextAtSize(pageLabel, 8.5),
      y: paper.height - 30,
      size: 8.5,
      font: mono,
      color: INK,
    });

    for (let cell = 0; cell < CODES_PER_PAGE; cell++) {
      const index = page * CODES_PER_PAGE + cell;
      if (index >= totalCodes) break;
      const geometry = grid.cells[cell];
      const bitmap = rasterizeMatrix(makeQrMatrix(backup.chunks[index], preset), 4);
      const png = await doc.embedPng(encodeGrayPng(bitmap));
      p.drawImage(png, {
        x: geometry.x,
        y: paper.height - geometry.y - geometry.size,
        width: geometry.size,
        height: geometry.size,
      });
      const codeLabel = `Code ${index + 1} of ${totalCodes}`;
      p.drawText(codeLabel, {
        x: geometry.labelCenterX - mono.widthOfTextAtSize(codeLabel, 8.5) / 2,
        y: paper.height - geometry.labelY,
        size: 8.5,
        font: mono,
        color: INK,
      });
      if (onProgress) onProgress(index + 1, totalCodes);
    }
    drawFooter(p, mono, `backup ${idHex} - page ${page + 1} of ${pageTotal} - any order - coldpaper format v1`);
    // Let the UI paint between pages.
    if (onProgress) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return doc.save();
}

function drawFooter(page: PDFPage, mono: PDFFont, str: string): void {
  const size = 7.5;
  page.drawText(str, {
    x: (page.getWidth() - mono.widthOfTextAtSize(str, size)) / 2,
    y: 24,
    size,
    font: mono,
    color: INK,
  });
}
