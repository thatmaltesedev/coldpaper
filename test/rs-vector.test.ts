import { describe, expect, it } from 'vitest';
import { cauchyRow, decodeGroup, encodeParity } from '../src/core/rs';

/**
 * The frozen worked example from FORMAT.md §7.4 — computed with an independent
 * GF(256) implementation. If this test fails, either the coder or the spec
 * drifted, and whichever moved is wrong.
 */
describe('FORMAT.md worked example (k=3, m=2, S=4)', () => {
  const data = [
    Uint8Array.from([0x63, 0x6f, 0x6c, 0x64]), // "cold"
    Uint8Array.from([0x70, 0x61, 0x70, 0x65]), // "pape"
    Uint8Array.from([0x72, 0x21, 0x21, 0x21]), // "r!!!"
  ];

  it('produces the documented Cauchy rows', () => {
    expect([...cauchyRow(3, 0)]).toEqual([0xf4, 0x8e, 0x01]);
    expect([...cauchyRow(3, 1)]).toEqual([0x47, 0xa7, 0x7a]);
  });

  it('produces the documented parity bytes', () => {
    const parity = encodeParity(data, 2, 4);
    expect([...parity[0]]).toEqual([0x6b, 0xba, 0x3d, 0x4a]);
    expect([...parity[1]]).toEqual([0x8f, 0x1f, 0xd3, 0x72]);
  });

  it('recovers the documented data from any 3 of the 5 shards', () => {
    const parity = encodeParity(data, 2, 4);
    // Lose data slots 0 and 2; keep d1 + both parity shards.
    const out = decodeGroup({
      k: 3,
      m: 2,
      chunkSize: 4,
      dataPresent: new Map([[1, data[1]]]),
      parityPresent: new Map([
        [0, parity[0]],
        [1, parity[1]],
      ]),
    });
    expect([...out[0]]).toEqual([...data[0]]);
    expect([...out[2]]).toEqual([...data[2]]);
  });
});
