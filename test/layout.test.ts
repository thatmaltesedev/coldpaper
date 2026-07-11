import { describe, expect, it } from 'vitest';
import {
  DATA_SLOTS_CAP,
  dataChunkIndex,
  isVirtualSlot,
  locateChunk,
  parityChunkIndex,
  planBackup,
  planFromHeader,
} from '../src/core/layout';
import { MAX_GROUP_SHARDS } from '../src/core/rs';

describe('striping layout', () => {
  it('small payloads use a single group', () => {
    const plan = planBackup(50_000, 835, 25);
    expect(plan.groupCount).toBe(1);
    expect(plan.dataChunkCount).toBe(Math.ceil(50_000 / 835));
    expect(plan.slotsPerGroup).toBe(plan.dataChunkCount);
    expect(plan.parityPerGroup).toBe(Math.ceil(plan.slotsPerGroup * 0.25));
  });

  it('always keeps k+m within one GF(256) group across the whole envelope', () => {
    const payloadSizes = [1, 100, 5000, 100_000, 500_000, 1_000_000, 5 * 1024 * 1024 + 300];
    const chunkSizes = [128, 400, 835, 1430, 2309];
    const redundancy = [10, 17, 25, 33, 50];
    for (const p of payloadSizes) {
      for (const s of chunkSizes) {
        for (const r of redundancy) {
          const plan = planBackup(p, s, r);
          expect(plan.slotsPerGroup + plan.parityPerGroup).toBeLessThanOrEqual(MAX_GROUP_SHARDS);
          expect(plan.groupCount).toBeLessThanOrEqual(255);
          expect(plan.totalChunks).toBeLessThanOrEqual(0xffff);
          expect(plan.parityPerGroup).toBeGreaterThanOrEqual(1);
          // Every real data byte is covered.
          expect(plan.dataChunkCount * s).toBeGreaterThanOrEqual(p);
          expect((plan.dataChunkCount - 1) * s).toBeLessThan(p);
        }
      }
    }
  });

  it('locateChunk is the inverse of dataChunkIndex/parityChunkIndex', () => {
    const plan = planBackup(700_000, 835, 25);
    expect(plan.groupCount).toBeGreaterThan(1);
    for (let index = 0; index < plan.totalChunks; index++) {
      const loc = locateChunk(index, plan);
      const back =
        loc.kind === 'data'
          ? dataChunkIndex(loc.group, loc.slot, plan)
          : parityChunkIndex(loc.group, loc.slot, plan);
      expect(back).toBe(index);
      expect(loc.group).toBeLessThan(plan.groupCount);
      expect(loc.slot).toBeLessThan(loc.kind === 'data' ? plan.slotsPerGroup : plan.parityPerGroup);
    }
  });

  it('adjacent chunk indexes land in different groups (round-robin)', () => {
    const plan = planBackup(700_000, 835, 25);
    for (let i = 0; i + 1 < plan.dataChunkCount; i++) {
      const a = locateChunk(i, plan);
      const b = locateChunk(i + 1, plan);
      expect((a.group + 1) % plan.groupCount).toBe(b.group);
    }
  });

  it('virtual slots only appear in the last slot row and are never many', () => {
    const plan = planBackup(1_000_001, 835, 30);
    let virtual = 0;
    for (let g = 0; g < plan.groupCount; g++) {
      for (let s = 0; s < plan.slotsPerGroup; s++) {
        if (isVirtualSlot(g, s, plan)) {
          virtual++;
          expect(s).toBe(plan.slotsPerGroup - 1);
        }
      }
    }
    expect(virtual).toBe(plan.groupCount * plan.slotsPerGroup - plan.dataChunkCount);
    expect(virtual).toBeLessThan(plan.groupCount);
  });

  it('planFromHeader reproduces planBackup exactly', () => {
    for (const p of [1, 999, 140_000, 3_000_000]) {
      const plan = planBackup(p, 1430, 40);
      const rebuilt = planFromHeader({
        payloadLength: plan.payloadLength,
        dataChunkCount: plan.dataChunkCount,
        groupCount: plan.groupCount,
        parityPerGroup: plan.parityPerGroup,
        chunkSize: plan.chunkSize,
      });
      expect(rebuilt).toEqual(plan);
    }
  });

  it('respects the data-slot cap', () => {
    const plan = planBackup(5 * 1024 * 1024, 835, 50);
    expect(plan.slotsPerGroup).toBeLessThanOrEqual(DATA_SLOTS_CAP);
  });

  it('rejects payloads that cannot fit the format', () => {
    expect(() => planBackup(70_000_000, 128, 50)).toThrow();
  });
});
