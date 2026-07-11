import { describe, expect, it } from 'vitest';
import { isCpError } from '../src/core/errors';
import {
  CHUNK_OVERHEAD,
  decodeChunk,
  decodeMeta,
  encodeChunk,
  encodeMeta,
  FLAG_DEFLATE,
  FLAG_ENCRYPTED,
  FORMAT_VERSION,
  type ChunkHeader,
} from '../src/core/format';
import { mulberry32, randomBytes } from './helpers/rng';

const rand = mulberry32(2024);

function sampleHeader(overrides: Partial<ChunkHeader> = {}): ChunkHeader {
  return {
    backupId: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    payloadLength: 2000,
    chunkIndex: 1,
    dataChunkCount: 3,
    groupCount: 1,
    parityPerGroup: 2,
    flags: FLAG_DEFLATE,
    ...overrides,
  };
}

describe('chunk codec', () => {
  it('round-trips header and data byte-for-byte', () => {
    const data = randomBytes(rand, 835);
    const header = sampleHeader({ payloadLength: 835 * 3 - 100, flags: FLAG_DEFLATE | FLAG_ENCRYPTED });
    const encoded = encodeChunk(header, data);
    expect(encoded.length).toBe(CHUNK_OVERHEAD + data.length);
    const decoded = decodeChunk(encoded);
    expect(decoded.header).toEqual(header);
    expect(decoded.data).toEqual(data);
  });

  it('rejects non-Coldpaper bytes', () => {
    try {
      decodeChunk(new TextEncoder().encode('https://example.com/definitely-not-a-backup'));
      expect.unreachable();
    } catch (e) {
      expect(isCpError(e, 'NOT_COLDPAPER')).toBe(true);
    }
  });

  it('rejects future format versions with a dedicated error', () => {
    const data = randomBytes(rand, 100);
    const encoded = encodeChunk(sampleHeader({ payloadLength: 300 - 40 }), data);
    encoded[2] = FORMAT_VERSION + 1;
    try {
      decodeChunk(encoded);
      expect.unreachable();
    } catch (e) {
      expect(isCpError(e, 'UNSUPPORTED_VERSION')).toBe(true);
    }
  });

  it('detects any single flipped bit via CRC-32', () => {
    const data = randomBytes(rand, 200);
    const encoded = encodeChunk(sampleHeader({ payloadLength: 550 }), data);
    for (const pos of [3, 7, 11, 14, 17, 30, encoded.length - 1]) {
      const copy = Uint8Array.from(encoded);
      copy[pos] ^= 0x01;
      try {
        decodeChunk(copy);
        expect.unreachable(`bit flip at ${pos} was not detected`);
      } catch (e) {
        expect(isCpError(e, 'BAD_CHECKSUM') || isCpError(e, 'NOT_COLDPAPER')).toBe(true);
      }
    }
  });

  it('rejects internally inconsistent headers even with a valid CRC', () => {
    const data = randomBytes(rand, 100);
    // payloadLength says 5 chunks of 100 bytes, header says 3.
    const encoded = encodeChunk(sampleHeader({ payloadLength: 480, dataChunkCount: 3 }), data);
    try {
      decodeChunk(encoded);
      expect.unreachable();
    } catch (e) {
      expect(isCpError(e, 'NOT_COLDPAPER')).toBe(true);
    }
  });

  it('survives being decoded as text only if the bytes survive (mangling is detected)', () => {
    // Simulates a scanner that decodes byte-mode QR content as UTF-8 text and
    // hands back the re-encoded string: any lossy step must be caught.
    const data = randomBytes(rand, 300);
    const encoded = encodeChunk(sampleHeader({ payloadLength: 800 }), data);
    const asText = new TextDecoder('utf-8', { fatal: false }).decode(encoded);
    const reEncoded = new TextEncoder().encode(asText);
    if (reEncoded.length === encoded.length) {
      // Improbable with random bytes, but if lossless it must decode fine.
      expect(decodeChunk(reEncoded)).toBeTruthy();
    } else {
      expect(() => decodeChunk(reEncoded)).toThrow();
    }
  });
});

describe('metadata block', () => {
  it('round-trips names, size and hash', () => {
    const meta = {
      name: 'seed-phrase — final(2).txt',
      fileSize: 123_456,
      sha256: randomBytes(rand, 32),
    };
    const tail = randomBytes(rand, 50);
    const payload = new Uint8Array([...encodeMeta(meta), ...tail]);
    const { meta: decoded, byteLength } = decodeMeta(payload);
    expect(decoded.name).toBe(meta.name);
    expect(decoded.fileSize).toBe(meta.fileSize);
    expect(decoded.sha256).toEqual(meta.sha256);
    expect(payload.slice(byteLength)).toEqual(tail);
  });

  it('handles empty names', () => {
    const meta = { name: '', fileSize: 1, sha256: randomBytes(rand, 32) };
    const { meta: decoded } = decodeMeta(encodeMeta(meta));
    expect(decoded.name).toBe('');
  });

  it('truncates over-long names on a UTF-8 boundary', () => {
    const meta = { name: '📄'.repeat(100), fileSize: 9, sha256: randomBytes(rand, 32) };
    const encoded = encodeMeta(meta);
    const { meta: decoded } = decodeMeta(encoded);
    expect(decoded.name.length).toBeGreaterThan(0);
    expect(decoded.name.includes('�')).toBe(false);
    expect(new TextEncoder().encode(decoded.name).length).toBeLessThanOrEqual(255);
  });
});
