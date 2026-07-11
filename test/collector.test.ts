import { describe, expect, it } from 'vitest';
import { ChunkCollector } from '../src/core/collector';
import { createBackup } from '../src/core/pipeline';
import { mulberry32, randomBytes } from './helpers/rng';

describe('chunk collector', () => {
  it('reports added / duplicate / invalid outcomes', async () => {
    const rand = mulberry32(11);
    const backup = await createBackup({
      fileName: 'a.txt',
      fileBytes: randomBytes(rand, 3000),
      chunkSize: 835,
      redundancyPercent: 25,
    });
    const collector = new ChunkCollector();

    const first = collector.add(backup.chunks[0]);
    expect(first.kind).toBe('added');

    const dup = collector.add(backup.chunks[0]);
    expect(dup.kind).toBe('duplicate');

    const junk = collector.add(new TextEncoder().encode('WIFI:S:CoffeeShop;;'));
    expect(junk.kind).toBe('invalid');

    const flipped = Uint8Array.from(backup.chunks[1]);
    flipped[30] ^= 0xff;
    const bad = collector.add(flipped);
    expect(bad.kind).toBe('invalid');
    expect(bad.kind === 'invalid' && bad.error.code).toBe('BAD_CHECKSUM');
  });

  it('keeps accidentally-mixed backups apart and reports both', async () => {
    const rand = mulberry32(12);
    const a = await createBackup({
      fileName: 'a.txt',
      fileBytes: randomBytes(rand, 2000),
      chunkSize: 835,
      redundancyPercent: 25,
    });
    const b = await createBackup({
      fileName: 'b.txt',
      fileBytes: randomBytes(rand, 2000),
      chunkSize: 835,
      redundancyPercent: 25,
    });
    const collector = new ChunkCollector();
    for (const chunk of [...a.chunks, ...b.chunks]) collector.add(chunk);
    expect(collector.backups.size).toBe(2);
    const list = collector.list();
    expect(list[0].isComplete()).toBe(true);
    expect(list[1].isComplete()).toBe(true);
  });

  it('tracks per-group progress and which codes still help', async () => {
    const rand = mulberry32(13);
    const backup = await createBackup({
      fileName: 'p.bin',
      fileBytes: randomBytes(rand, 10_000),
      chunkSize: 835,
      redundancyPercent: 25,
    });
    const plan = backup.plan;
    const collector = new ChunkCollector();

    // Add everything except the last two data chunks.
    const held = [plan.dataChunkCount - 1, plan.dataChunkCount - 2];
    backup.chunks.forEach((c, i) => {
      if (!held.includes(i)) collector.add(c);
    });
    const collected = collector.list()[0];

    expect(collected.capturedCount).toBe(plan.totalChunks - 2);
    expect(collected.requiredCount).toBe(plan.dataChunkCount);
    // 25% parity on a ~13-chunk backup gives m >= 2 spares: already complete.
    expect(collected.isComplete()).toBe(true);
    expect(collected.stillUseful()).toEqual([]);

    const progress = collected.groupProgress();
    expect(progress).toHaveLength(plan.groupCount);
    for (const g of progress) {
      expect(g.satisfied).toBe(true);
      expect(g.have).toBe(g.need);
    }
  });

  it('lists missing candidates when a group is short', async () => {
    const rand = mulberry32(14);
    const backup = await createBackup({
      fileName: 'q.bin',
      fileBytes: randomBytes(rand, 5000),
      chunkSize: 835,
      redundancyPercent: 25,
    });
    const collector = new ChunkCollector();
    // Provide only chunk 0.
    collector.add(backup.chunks[0]);
    const collected = collector.list()[0];
    expect(collected.isComplete()).toBe(false);
    const useful = collected.stillUseful();
    // Every not-yet-captured chunk should still be useful.
    expect(useful).toHaveLength(backup.plan.totalChunks - 1);
    expect(useful).not.toContain(0);
  });

  it('flags header-consistent-but-different chunks as mismatch', async () => {
    const rand = mulberry32(15);
    const backup = await createBackup({
      fileName: 'r.bin',
      fileBytes: randomBytes(rand, 5000),
      chunkSize: 835,
      redundancyPercent: 25,
    });
    // Forge a chunk with the same backup id but different geometry.
    const other = await createBackup({
      fileName: 'r2.bin',
      fileBytes: randomBytes(rand, 9000),
      chunkSize: 835,
      redundancyPercent: 25,
    });
    const forged = Uint8Array.from(other.chunks[0]);
    // Overwrite backup id bytes (3..7) with the first backup's id, then fix the CRC by re-encoding.
    const { decodeChunk, encodeChunk } = await import('../src/core/format');
    const parsed = decodeChunk(other.chunks[0]);
    parsed.header.backupId = backup.backupId;
    const reframed = encodeChunk(parsed.header, parsed.data);

    const collector = new ChunkCollector();
    collector.add(backup.chunks[0]);
    const outcome = collector.add(reframed);
    expect(outcome.kind).toBe('mismatch');
    expect(outcome.kind === 'mismatch' && outcome.error.code).toBe('CHUNK_MISMATCH');
    void forged;
  });
});
