/**
 * Browser-side PDF page rendering, shared by the restore tab (import a
 * Coldpaper PDF or a scanner's PDF output) and the shrink feature (re-render
 * a bulky PDF as compact page images). pdf.js loads on demand so users who
 * never touch a PDF never download it. Everything stays local: the worker is
 * a bundled asset, never a CDN.
 */

/**
 * Resolution for decoding QR codes out of PDF pages. Locked by
 * test/pdf-roundtrip.test.ts: even the dense preset (QR v40) must decode
 * reliably at this DPI.
 */
export const PDF_IMPORT_DPI = 220;

type Pdfjs = typeof import('pdfjs-dist');

let loaded: Promise<{ pdfjs: Pdfjs; WorkerCtor: new () => Worker }> | null = null;

function loadPdfjs(): Promise<{ pdfjs: Pdfjs; WorkerCtor: new () => Worker }> {
  loaded ??= (async () => {
    // `?worker&inline` bundles the pdf.js worker INTO the app and instantiates
    // it from a Blob at runtime: it works identically on the dev server, in
    // the deployed PWA and inside the single-file offline build, always with
    // zero network access.
    const [pdfjs, workerModule] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?worker&inline'),
    ]);
    return { pdfjs, WorkerCtor: workerModule.default };
  })();
  return loaded;
}

export interface RenderedPdfPage {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  /** Page size in PDF points (1/72 inch). */
  widthPt: number;
  heightPt: number;
  /** 1-based. */
  pageIndex: number;
  pageCount: number;
}

/**
 * Render every page of a PDF to a canvas at the given DPI, sequentially.
 * The SAME canvas is reused between pages: consume it before iterating on.
 * Note pdf.js transfers `data` to its worker; hand over a copy if the caller
 * still needs the buffer.
 */
export async function* renderPdfPages(
  data: ArrayBuffer,
  dpi: number = PDF_IMPORT_DPI,
): AsyncGenerator<RenderedPdfPage> {
  const { pdfjs, WorkerCtor } = await loadPdfjs();
  // A fresh worker per call keeps lifecycles simple: destroying the document
  // can safely take its worker down with it. (pdf.js's typings say `port:
  // null`, but a real Worker is the documented way to supply your own.)
  const worker = new pdfjs.PDFWorker({
    port: new WorkerCtor(),
  } as unknown as ConstructorParameters<typeof pdfjs.PDFWorker>[0]);
  const doc = await pdfjs.getDocument({
    data,
    worker,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  try {
    for (let pageIndex = 1; pageIndex <= doc.numPages; pageIndex++) {
      const page = await doc.getPage(pageIndex);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: dpi / 72 });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      // 'print' intent renders in immediate chunks instead of waiting on
      // requestAnimationFrame, so imports keep working in backgrounded tabs
      // (and it is the right intent for off-screen rasterisation anyway).
      await page.render({ canvas, canvasContext: context, viewport, intent: 'print' }).promise;
      yield {
        canvas,
        context,
        widthPt: base.width,
        heightPt: base.height,
        pageIndex,
        pageCount: doc.numPages,
      };
      page.cleanup();
    }
  } finally {
    await doc.destroy();
    worker.destroy();
  }
}
