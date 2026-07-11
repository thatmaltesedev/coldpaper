/**
 * Optional lossy pre-compression ("shrink file first"), so bulky files use
 * less paper. This happens BEFORE the pipeline and outside the format: the
 * backup simply stores the smaller copy, and restore returns that copy.
 *
 * Only types with a real, standard, in-browser recompression path get lossy
 * options: images (canvas re-encode to JPEG/WebP with downscaling) and PDFs
 * (pages re-rendered as JPEGs, the classic "reduce file size" move). Video,
 * audio and archives are already compressed and honestly can't be improved
 * here; text-like files are covered by the pipeline's automatic lossless
 * DEFLATE.
 */
import { PDFDocument } from 'pdf-lib';
import { renderPdfPages } from '../scan/pdf-import';

export type ShrinkCategory = 'image' | 'pdf' | 'video' | 'audio' | 'archive' | 'generic';

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg|tiff?|heic|heif)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|mpe?g)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|wma)$/i;
const ARCHIVE_EXT = /\.(zip|gz|tgz|bz2|xz|7z|rar|zst|docx|xlsx|pptx|odt|ods|odp|epub|jar|apk)$/i;
const ARCHIVE_MIME = new Set([
  'application/zip',
  'application/gzip',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/x-tar',
]);

export function categorize(name: string, mime: string): ShrinkCategory {
  if (mime.startsWith('image/') || IMAGE_EXT.test(name)) return 'image';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (mime.startsWith('video/') || VIDEO_EXT.test(name)) return 'video';
  if (mime.startsWith('audio/') || AUDIO_EXT.test(name)) return 'audio';
  if (ARCHIVE_MIME.has(mime) || ARCHIVE_EXT.test(name)) return 'archive';
  return 'generic';
}

/** True when this category has actual lossy settings to offer. */
export function hasLossyOptions(category: ShrinkCategory): boolean {
  return category === 'image' || category === 'pdf';
}

export interface ShrinkOutput {
  bytes: Uint8Array;
  name: string;
  /** Short human description of what was produced, e.g. "1200x900 JPEG". */
  detail: string;
}

export function webpSupported(): boolean {
  try {
    return document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    return false;
  }
}

export interface ImageShrinkOptions {
  /** Longest-side cap in pixels; 0 keeps the original dimensions. */
  maxDimension: number;
  /** 0..1 encoder quality. */
  quality: number;
  format: 'jpeg' | 'webp';
}

export async function shrinkImage(
  bytes: Uint8Array,
  name: string,
  options: ImageShrinkOptions,
): Promise<ShrinkOutput> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  } catch {
    throw new Error('this browser cannot decode that image format');
  }
  const scale =
    options.maxDimension > 0 ? Math.min(1, options.maxDimension / Math.max(bitmap.width, bitmap.height)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  // JPEG has no alpha channel: transparency becomes white paper, not black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const type = options.format === 'webp' && webpSupported() ? 'image/webp' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, options.quality));
  if (!blob) throw new Error('image encoding failed');
  const out = new Uint8Array(await blob.arrayBuffer());
  const ext = type === 'image/webp' ? '.webp' : '.jpg';
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  return {
    bytes: out,
    name: (base || 'image') + ext,
    detail: `${canvas.width}x${canvas.height} ${type === 'image/webp' ? 'WebP' : 'JPEG'}`,
  };
}

export interface PdfShrinkOptions {
  /** Rendering resolution for the rasterised pages. */
  dpi: number;
  /** 0..1 JPEG quality. */
  quality: number;
}

export async function shrinkPdf(
  bytes: Uint8Array,
  name: string,
  options: PdfShrinkOptions,
  onProgress?: (page: number, pages: number) => void,
): Promise<ShrinkOutput> {
  const doc = await PDFDocument.create();
  doc.setProducer('coldpaper shrink (rasterised copy)');
  let pageCount = 0;
  // pdf.js transfers the buffer to its worker: give it a copy.
  const copy = bytes.slice().buffer as ArrayBuffer;
  for await (const page of renderPdfPages(copy, options.dpi)) {
    onProgress?.(page.pageIndex, page.pageCount);
    const blob = await new Promise<Blob | null>((resolve) =>
      page.canvas.toBlob(resolve, 'image/jpeg', options.quality),
    );
    if (!blob) throw new Error('page encoding failed');
    const jpg = await doc.embedJpg(await blob.arrayBuffer());
    const out = doc.addPage([page.widthPt, page.heightPt]);
    out.drawImage(jpg, { x: 0, y: 0, width: page.widthPt, height: page.heightPt });
    pageCount = page.pageCount;
  }
  return {
    bytes: await doc.save(),
    name,
    detail: `${pageCount} page${pageCount === 1 ? '' : 's'} rasterised at ${options.dpi} dpi`,
  };
}
