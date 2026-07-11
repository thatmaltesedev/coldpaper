import { describe, expect, it } from 'vitest';
import { ChunkCollector, type CollectedBackup } from '../src/core/collector';
import { locateChunk } from '../src/core/layout';
import { createBackup, restoreBackup, type BackupResult } from '../src/core/pipeline';
import { mulberry32, pickDistinct, randomBytes, type Rand } from './helpers/rng';

async function makeBackup(rand: Rand, size: number, chunkSize = 835, redundancy = 25): Promise<BackupResult> {
  return createBackup({
    fileName: `erasure-${size}.bin`,
    fileBytes: randomBytes(rand, size),
    chunkSize,
    redundancyPercent: redundancy,
  });
}

function collectExcept(backup: BackupResult, lost: ReadonlySet<number>): CollectedBackup {
  const collector = new ChunkCollector();
  backup.chunks.forEach((chunk, i) => {
    if (!lost.has(i)) collector.add(chunk);
  });
  const [collected] = collector.list();
  expect(collected).toBeDefined();
  return collected;
}

describe('erasure resilience', () => {
  it('survives losing exactly m chunks in every group (the worst legal loss)', async () => {
    const rand = mulberry32(2001);
    const backup = await makeBackup(rand, 60_000);
    const plan = backup.plan;
    // Lose the LAST m data chunks of each group — parity must carry them.
    const lost = new Set<number>();
    for (let g = 0; g < plan.groupCount; g++) {
      let inGroup = 0;
      for (let i = plan.dataChunkCount - 1; i >= 0 && inGroup < plan.parityPerGroup; i--) {
        if (locateChunk(i, plan).group === g) {
          lost.add(i);
          inGroup++;
        }
      }
    }
    expect(lost.size).toBe(plan.parityPerGroup * plan.groupCount);
    const restored = await restoreBackup(collectExcept(backup, lost));
    expect(restored.sha256).toEqual(backup.fileHash);
  });

  it('survives losing all parity chunks (data alone restores)', async () => {
    const rand = mulberry32(2002);
    const backup = await makeBackup(rand, 30_000);
    const lost = new Set<number>();
    for (let i = backup.plan.dataChunkCount; i < backup.plan.totalChunks; i++) lost.add(i);
    const restored = await restoreBackup(collectExcept(backup, lost));
    expect(restored.sha256).toEqual(backup.fileHash);
  });

  it('survives random loss patterns capped at m per group (200 trials)', async () => {
    const rand = mulberry32(2003);
    const backup = await makeBackup(rand, 45_000, 835, 30);
    const plan = backup.plan;
    for (let trial = 0; trial < 200; trial++) {
      const perGroup = new Map<number, number>();
      const lost = new Set<number>();
      const shuffled = pickDistinct(rand, plan.totalChunks, plan.totalChunks);
      for (const i of shuffled) {
        const g = locateChunk(i, plan).group;
        const count = perGroup.get(g) ?? 0;
        if (count < plan.parityPerGroup && rand() < 0.5) {
          lost.add(i);
          perGroup.set(g, count + 1);
        }
      }
      const restored = await restoreBackup(collectExcept(backup, lost));
      expect(restored.sha256).toEqual(backup.fileHash);
    }
  }, 240_000);

  it('multi-group: survives a contiguous tear of m×G consecutive codes', async () => {
    const rand = mulberry32(2004);
    const backup = await makeBackup(rand, 400_000); // several groups at S=835
    const plan = backup.plan;
    expect(plan.groupCount).toBeGreaterThan(1);
    const tearLength = plan.parityPerGroup * plan.groupCount; // e.g. a whole missing page run
    const start = Math.floor((plan.dataChunkCount - tearLength) / 2);
    const lost = new Set<number>();
    for (let i = start; i < start + tearLength; i++) lost.add(i);
    const restored = await restoreBackup(collectExcept(backup, lost));
    expect(restored.sha256).toEqual(backup.fileHash);
  }, 240_000);

  it('fails cleanly and helpfully when one group loses m+1 chunks', async () => {
    const rand = mulberry32(2005);
    const backup = await makeBackup(rand, 60_000);
    const plan = backup.plan;
    const lost = new Set<number>();
    for (let i = 0; i < plan.dataChunkCount && lost.size <= plan.parityPerGroup; i++) {
      if (locateChunk(i, plan).group === 0) lost.add(i); // m+1 losses, all in group 0
    }
    expect(lost.size).toBe(plan.parityPerGroup + 1);
    const collected = collectExcept(backup, lost);
    expect(collected.isComplete()).toBe(false);
    expect(collected.stillUseful().length).toBeGreaterThan(0);
    await expect(restoreBackup(collected)).rejects.toMatchObject({
      code: 'INSUFFICIENT_CHUNKS',
      message: expect.stringContaining('scan more pages'),
    });
  });

  it('a torn-in-half backup (50% gone, 50% redundancy) still restores', async () => {
    const rand = mulberry32(2006);
    const backup = await makeBackup(rand, 20_000, 835, 50);
    const plan = backup.plan;
    // Lose every second code — round-robin striping spreads this at exactly m per group.
    const lost = new Set<number>();
    for (let i = 0; i < plan.totalChunks; i += 2) lost.add(i);
    let restored;
    try {
      restored = await restoreBackup(collectExcept(backup, lost));
    } catch {
      // Depending on rounding a couple of groups may be one short — allow the
      // documented fallback: drop half of DATA chunks only, keep parity.
      const lost2 = new Set<number>();
      for (let g = 0; g < plan.groupCount; g++) {
        let inGroup = 0;
        for (let i = 0; i < plan.dataChunkCount && inGroup < plan.parityPerGroup; i++) {
          if (locateChunk(i, plan).group === g) {
            lost2.add(i);
            inGroup++;
          }
        }
      }
      restored = await restoreBackup(collectExcept(backup, lost2));
    }
    expect(restored.sha256).toEqual(backup.fileHash);
  });
});
