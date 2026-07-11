/**
 * Density presets: pinned (QR version, error-correction) pairs.
 *
 * Byte-mode capacities measured against the bundled encoder (test-asserted):
 *   easy      v23-M  857 bytes/code  109 modules
 *   balanced  v31-M 1452 bytes/code  141 modules
 *   dense     v40-M 2331 bytes/code  177 modules
 *
 * ECC level M (~15% in-code correction) is the print-friendly sweet spot: the
 * in-code ECC absorbs smudges INSIDE a code, while whole-code losses are the
 * erasure layer's job. Chunk size is capacity minus the 22-byte frame.
 */
import { CHUNK_OVERHEAD } from '../core/format';

export type PresetId = 'easy' | 'balanced' | 'dense';

export interface DensityPreset {
  id: PresetId;
  label: string;
  description: string;
  qrVersion: number;
  errorCorrectionLevel: 'M';
  /** Total byte-mode capacity of one code at this version/ECC. */
  qrCapacity: number;
  /** Data bytes per chunk (capacity minus frame overhead). */
  chunkSize: number;
  /** Symbol width in modules (excluding quiet zone). */
  modules: number;
}

export const PRESETS: readonly DensityPreset[] = [
  {
    id: 'easy',
    label: 'Easy scan',
    description: 'Bigger dots. Any printer, any phone camera.',
    qrVersion: 23,
    errorCorrectionLevel: 'M',
    qrCapacity: 857,
    chunkSize: 857 - CHUNK_OVERHEAD,
    modules: 109,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'More bytes per page; still comfortable to scan.',
    qrVersion: 31,
    errorCorrectionLevel: 'M',
    qrCapacity: 1452,
    chunkSize: 1452 - CHUNK_OVERHEAD,
    modules: 141,
  },
  {
    id: 'dense',
    label: 'Dense',
    description: 'Fewest pages. Needs a sharp printer and a decent camera.',
    qrVersion: 40,
    errorCorrectionLevel: 'M',
    qrCapacity: 2331,
    chunkSize: 2331 - CHUNK_OVERHEAD,
    modules: 177,
  },
];

export const DEFAULT_PRESET = PRESETS[0];

export function presetById(id: string): DensityPreset {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`unknown preset: ${id}`);
  return preset;
}
