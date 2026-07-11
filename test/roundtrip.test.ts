import { describe, expect, it } from 'vitest';
import { ChunkCollector } from '../src/core/collector';
import { createBackup, restoreBackup } from '../src/core/pipeline';
import { compressibleBytes, mulberry32, randInt, randomBytes, type Rand } from './helpers/rng';

const FAST_KDF = 1000;

/** Feed chunks to a collector shuffled, with some duplicates thrown in. */
function collect(rand: Rand, chunks: Uint8Array[]) {
  const order = chunks.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randInt(rand, i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const collector = new ChunkCollector();
  for (const i of order) {
    expect(collector.add(chunks[i]).kind).toBe('added');
    if (randInt(rand, 4) === 0) {
      expect(collector.add(chunks[i]).kind).toBe('duplicate');
    }
  }
  const backups = collector.list();
  expect(backups).toHaveLength(1);
  return backups[0];
}

describe('full pipeline round-trips byte-identically', () => {
  const chunkSizes = [835, 1430, 2309]; // the three density presets
  const sizes = [0, 1, 13, 1024, 20_000];

  for (const chunkSize of chunkSizes) {
    it(`chunk size ${chunkSize}, plain, random + compressible content`, async () => {
      const rand = mulberry32(chunkSize);
      for (const size of sizes) {
        for (const kind of ['random', 'compressible'] as const) {
          const fileBytes = kind === 'random' ? randomBytes(rand, size) : compressibleBytes(rand, size);
          const backup = await createBackup({
            fileName: `${kind}-${size}.bin`,
            fileBytes,
            chunkSize,
            redundancyPercent: 25,
          });
          expect(backup.chunks).toHaveLength(backup.plan.totalChunks);
          const restored = await restoreBackup(collect(rand, backup.chunks));
          expect(restored.bytes).toEqual(fileBytes);
          expect(restored.name).toBe(`${kind}-${size}.bin`);
          expect(restored.sha256).toEqual(backup.fileHash);
        }
      }
    });
  }

  it('encrypted backups round-trip across sizes and presets', async () => {
    const rand = mulberry32(90210);
    for (const [size, chunkSize] of [
      [0, 835],
      [700, 835],
      [9000, 1430],
      [40_000, 2309],
    ] as const) {
      const fileBytes = randomBytes(rand, size);
      const backup = await createBackup({
        fileName: 'secrets.kdbx',
        fileBytes,
        chunkSize,
        redundancyPercent: 30,
        passphrase: 'correct horse battery staple',
        kdfIterations: FAST_KDF,
      });
      expect(backup.encrypted).toBe(true);
      const collected = collect(rand, backup.chunks);
      expect(collected.encrypted).toBe(true);
      const restored = await restoreBackup(collected, 'correct horse battery staple', FAST_KDF);
      expect(restored.bytes).toEqual(fileBytes);
      expect(restored.wasEncrypted).toBe(true);
    }
  });

  it('multi-group backups (large file) round-trip', async () => {
    const rand = mulberry32(31337);
    const fileBytes = randomBytes(rand, 400_000); // random => incompressible => ~480 chunks at S=835
    const backup = await createBackup({
      fileName: 'big.tar',
      fileBytes,
      chunkSize: 835,
      redundancyPercent: 25,
    });
    expect(backup.plan.groupCount).toBeGreaterThan(1);
    const restored = await restoreBackup(collect(rand, backup.chunks));
    expect(restored.bytes).toEqual(fileBytes);
  });

  it('redundancy extremes (10% and 50%) round-trip', async () => {
    const rand = mulberry32(808);
    for (const redundancy of [10, 50]) {
      const fileBytes = randomBytes(rand, 30_000);
      const backup = await createBackup({
        fileName: 'r.bin',
        fileBytes,
        chunkSize: 1430,
        redundancyPercent: redundancy,
      });
      const restored = await restoreBackup(collect(rand, backup.chunks));
      expect(restored.bytes).toEqual(fileBytes);
    }
  });

  it('a full-cap 5 MB file round-trips', async () => {
    const rand = mulberry32(5);
    const fileBytes = compressibleBytes(rand, 5 * 1024 * 1024);
    const backup = await createBackup({
      fileName: 'cap.bin',
      fileBytes,
      chunkSize: 2309,
      redundancyPercent: 10,
    });
    const restored = await restoreBackup(collect(rand, backup.chunks));
    expect(restored.bytes).toEqual(fileBytes);
  }, 240_000);

  it('rejects oversized files up front', async () => {
    await expect(
      createBackup({
        fileName: 'nope.iso',
        fileBytes: new Uint8Array(5 * 1024 * 1024 + 1),
        chunkSize: 2309,
        redundancyPercent: 10,
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('restoring an encrypted backup without a passphrase asks for one', async () => {
    const rand = mulberry32(1);
    const backup = await createBackup({
      fileName: 'x.txt',
      fileBytes: randomBytes(rand, 100),
      chunkSize: 835,
      redundancyPercent: 25,
      passphrase: 'pw',
      kdfIterations: FAST_KDF,
    });
    const collected = collect(rand, backup.chunks);
    await expect(restoreBackup(collected)).rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED' });
    await expect(restoreBackup(collected, 'wrong', FAST_KDF)).rejects.toMatchObject({ code: 'BAD_PASSPHRASE' });
    const restored = await restoreBackup(collected, 'pw', FAST_KDF);
    expect(restored.bytes).toHaveLength(100);
  });
});
