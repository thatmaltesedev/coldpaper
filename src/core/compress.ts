/**
 * Raw DEFLATE (RFC 1951) via fflate. Compression is only kept when it actually
 * shrinks the payload — already-compressed inputs (zips, jpegs, random keys)
 * are stored verbatim so they never pay for a wrapper.
 */
import { deflateSync, inflateSync } from 'fflate';
import { CpError } from './errors';

export function maybeCompress(data: Uint8Array): { data: Uint8Array; compressed: boolean } {
  if (data.length === 0) return { data, compressed: false };
  const packed = deflateSync(data, { level: 9 });
  if (packed.length < data.length) return { data: packed, compressed: true };
  return { data, compressed: false };
}

export function decompress(data: Uint8Array, expectedSize?: number): Uint8Array {
  try {
    if (expectedSize !== undefined) return inflateSync(data, { out: new Uint8Array(expectedSize) });
    return inflateSync(data);
  } catch {
    throw new CpError(
      'CORRUPT_PAYLOAD',
      'the reconstructed payload failed to decompress — rescan the pages and try again',
    );
  }
}
