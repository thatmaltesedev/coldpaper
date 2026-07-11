/**
 * The credibility test, part 1: QR codes rendered by OUR rasteriser must
 * survive print-and-scan style damage and decode with OUR bundled decoder.
 */
import { describe, expect, it } from 'vitest';
import { ChunkCollector } from '../src/core/collector';
import { createBackup, restoreBackup } from '../src/core/pipeline';
import { makeQrMatrix } from '../src/qr/generate';
import { encodeGrayPng } from '../src/qr/png';
import { PRESETS, presetById } from '../src/qr/presets';
import { rasterizeMatrix } from '../src/qr/raster';
import { addNoise, boxBlur, rotate, scale } from './helpers/image';
import { mulberry32, randomBytes } from './helpers/rng';
import { decodeBitmap, decodeImageFile } from './helpers/zxing';

describe('preset capacities are pinned correctly', () => {
  for (const preset of PRESETS) {
    it(`${preset.id}: ${preset.qrCapacity} bytes fit v${preset.qrVersion}-M exactly`, () => {
      const fits = makeQrMatrix(new Uint8Array(preset.qrCapacity), preset);
      expect(fits.size).toBe(preset.modules);
      expect(fits.data.length).toBe(preset.modules * preset.modules);
      expect(() =>
        makeQrMatrix(new Uint8Array(preset.qrCapacity + 1), { ...preset, qrCapacity: preset.qrCapacity + 1 }),
      ).toThrow();
    });
  }
});

describe('clean decode round-trip (raster + PNG paths)', () => {
  for (const preset of PRESETS) {
    it(`${preset.id}: raster and PNG both decode byte-identically`, async () => {
      const rand = mulberry32(preset.qrVersion);
      const payload = randomBytes(rand, preset.qrCapacity);
      const bitmap = rasterizeMatrix(makeQrMatrix(payload, preset), 4);

      const fromBitmap = await decodeBitmap(bitmap);
      expect(fromBitmap).toHaveLength(1);
      expect(fromBitmap[0]).toEqual(payload);

      const fromPng = await decodeImageFile(encodeGrayPng(bitmap));
      expect(fromPng).toHaveLength(1);
      expect(fromPng[0]).toEqual(payload);
    });
  }
});

describe('degraded decode: rotation, scale, noise, blur', () => {
  for (const preset of PRESETS) {
    it(`${preset.id}: survives each distortion alone`, async () => {
      const rand = mulberry32(1000 + preset.qrVersion);
      const payload = randomBytes(rand, preset.qrCapacity);
      const clean = rasterizeMatrix(makeQrMatrix(payload, preset), 6);

      const variants: Array<[string, () => ReturnType<typeof rotate>]> = [
        ['rotated 3°', () => rotate(clean, 3)],
        ['rotated -7°', () => rotate(clean, -7)],
        ['scaled to 60%', () => scale(clean, 0.6)],
        ['gaussian noise σ=24', () => addNoise(clean, 24, rand)],
        ['box blur r=2', () => boxBlur(clean, 2)],
      ];
      for (const [name, make] of variants) {
        const decoded = await decodeBitmap(make());
        expect(decoded, name).toHaveLength(1);
        expect(decoded[0], name).toEqual(payload);
      }
    });

    it(`${preset.id}: survives the combined "cheap print, casual photo" stack`, async () => {
      const rand = mulberry32(2000 + preset.qrVersion);
      const payload = randomBytes(rand, preset.qrCapacity);
      const clean = rasterizeMatrix(makeQrMatrix(payload, preset), 6);
      // blur (ink bleed) -> rotate (skewed page) -> scale down (distance) -> noise (sensor)
      const damaged = addNoise(scale(rotate(boxBlur(clean, 1), 2.5), 0.75), 10, rand);
      const decoded = await decodeBitmap(damaged);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]).toEqual(payload);
    });
  }
});

describe('whole-backup restore through degraded codes', () => {
  it('an 8 KB backup restores after every code is independently damaged', async () => {
    const rand = mulberry32(777);
    const preset = presetById('easy');
    const fileBytes = randomBytes(rand, 8 * 1024);
    const backup = await createBackup({
      fileName: 'damaged-but-fine.bin',
      fileBytes,
      chunkSize: preset.chunkSize,
      redundancyPercent: 25,
    });

    const collector = new ChunkCollector();
    let decodedCount = 0;
    for (const chunk of backup.chunks) {
      const clean = rasterizeMatrix(makeQrMatrix(chunk, preset), 6);
      const damaged = addNoise(rotate(boxBlur(clean, 1), (rand() - 0.5) * 6), 8, rand);
      const decoded = await decodeBitmap(damaged);
      expect(decoded, 'every mildly damaged code should still decode').toHaveLength(1);
      decodedCount++;
      expect(collector.add(decoded[0]).kind).toBe('added');
    }
    expect(decodedCount).toBe(backup.plan.totalChunks);

    const restored = await restoreBackup(collector.list()[0]);
    expect(restored.bytes).toEqual(fileBytes);
    expect(restored.sha256).toEqual(backup.fileHash);
  });

  it('restores even when heavy damage kills up to m codes per group', async () => {
    const rand = mulberry32(778);
    const preset = presetById('easy');
    const fileBytes = randomBytes(rand, 12 * 1024);
    const backup = await createBackup({
      fileName: 'heavier.bin',
      fileBytes,
      chunkSize: preset.chunkSize,
      redundancyPercent: 25,
    });
    const plan = backup.plan;

    const collector = new ChunkCollector();
    let lost = 0;
    for (let i = 0; i < backup.chunks.length; i++) {
      // Every 5th code gets destroyed-level damage; the rest mild.
      const clean = rasterizeMatrix(makeQrMatrix(backup.chunks[i], preset), 5);
      const doomed = i % 5 === 4;
      const damaged = doomed
        ? addNoise(boxBlur(scale(clean, 0.3), 3), 60, rand)
        : addNoise(rotate(clean, 2), 6, rand);
      const decoded = await decodeBitmap(damaged);
      if (decoded.length === 1) collector.add(decoded[0]);
      else lost++;
    }
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThanOrEqual(plan.parityPerGroup * plan.groupCount);

    const restored = await restoreBackup(collector.list()[0]);
    expect(restored.bytes).toEqual(fileBytes);
  });
});
