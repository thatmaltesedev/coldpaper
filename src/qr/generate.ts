import QRCode from 'qrcode';
import { CpError } from '../core/errors';
import type { DensityPreset } from './presets';

export interface QrMatrix {
  /** Symbol width/height in modules. */
  size: number;
  /** Row-major module map, 1 = dark. Length = size². */
  data: Uint8Array;
}

/** Encode one chunk payload as a byte-mode QR at the preset's pinned version/ECC. */
export function makeQrMatrix(payload: Uint8Array, preset: DensityPreset): QrMatrix {
  if (payload.length > preset.qrCapacity) {
    throw new CpError('INTERNAL', `payload of ${payload.length} bytes exceeds ${preset.id} capacity`);
  }
  const qr = QRCode.create([{ data: payload, mode: 'byte' }], {
    version: preset.qrVersion,
    errorCorrectionLevel: preset.errorCorrectionLevel,
  });
  const modules = qr.modules;
  return {
    size: modules.size,
    data: modules.data instanceof Uint8Array ? modules.data : Uint8Array.from(modules.data),
  };
}
