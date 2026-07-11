/**
 * Unified QR decoding. The native BarcodeDetector API is consulted first when
 * the platform has it (fast, hardware-assisted on many phones) - but browsers
 * only hand back a STRING, which can silently mangle binary payloads. So a
 * native result only counts if it reconstructs to a chunk that passes the
 * format's CRC-32, and the bundled zxing-wasm decoder ALWAYS runs as well:
 * its byte-true results are the ground truth, the native path is a bonus.
 */
import { toHex } from '../core/bytes';
import { decodeChunk } from '../core/format';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

interface BarcodeDetection {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource | Blob | ImageData): Promise<BarcodeDetection[]>;
}
interface BarcodeDetectorConstructor {
  new (options?: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

type ZxingReader = typeof import('zxing-wasm/reader');

let zxingModule: Promise<ZxingReader> | null = null;

function loadZxing(): Promise<ZxingReader> {
  zxingModule ??= (async () => {
    const mod = await import('zxing-wasm/reader');
    // Fetch the wasm ourselves: works for the hashed asset URL of the normal
    // build AND for the data: URI of the single-file offline build.
    const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
    mod.prepareZXingModule({ overrides: { wasmBinary } });
    return mod;
  })();
  return zxingModule;
}

/** Reconstruct candidate bytes from a BarcodeDetector rawValue string; null if hopeless. */
function chunkBytesFromText(text: string): Uint8Array | null {
  // Interpretation 1: one char per byte (latin-1 style).
  let latin1: Uint8Array | null = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      latin1 = null;
      break;
    }
    latin1![i] = code;
  }
  for (const candidate of [latin1, new TextEncoder().encode(text)]) {
    if (!candidate) continue;
    try {
      decodeChunk(candidate);
      return candidate;
    } catch {
      // keep trying
    }
  }
  return null;
}

export class QrDecoder {
  private native: BarcodeDetectorLike | null = null;

  static async create(): Promise<QrDecoder> {
    const decoder = new QrDecoder();
    const BD = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
    if (BD) {
      try {
        const formats = await BD.getSupportedFormats();
        if (formats.includes('qr_code')) decoder.native = new BD({ formats: ['qr_code'] });
      } catch {
        decoder.native = null;
      }
    }
    // Start the wasm download immediately; scanning shouldn't wait for first use.
    void loadZxing();
    return decoder;
  }

  get usingNative(): boolean {
    return this.native !== null;
  }

  /**
   * Decode all QR codes in one frame - union of both decoders, de-duplicated.
   * Foreign (non-Coldpaper) codes are still returned via zxing so the UI can
   * tell the user what it saw.
   */
  async decode(imageData: ImageData, canvas?: HTMLCanvasElement): Promise<Uint8Array[]> {
    const results: Uint8Array[] = [];
    const seen = new Set<string>();
    const add = (bytes: Uint8Array): void => {
      const key = toHex(bytes.length <= 64 ? bytes : bytes.subarray(0, 64)) + ':' + bytes.length;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(bytes);
      }
    };

    if (this.native) {
      try {
        for (const detection of await this.native.detect(canvas ?? imageData)) {
          const bytes = chunkBytesFromText(detection.rawValue);
          if (bytes) add(bytes);
        }
      } catch {
        this.native = null; // flaky platform implementation - zxing carries on alone
      }
    }

    const zxing = await loadZxing();
    const decoded = await zxing.readBarcodes(imageData, {
      formats: ['QRCode'],
      tryHarder: true,
      maxNumberOfSymbols: 16,
    });
    for (const r of decoded) {
      if (r.isValid) add(r.bytes);
    }
    return results;
  }
}
