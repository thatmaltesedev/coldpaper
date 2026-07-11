import { describe, expect, it } from 'vitest';
import { isScanSoundEnabled, setScanSound } from '../src/scan/beep';

describe('scan sound preference', () => {
  it('is muted by default (batch imports must not beep per code)', () => {
    expect(isScanSoundEnabled()).toBe(false);
  });

  it('can be switched on and off', () => {
    setScanSound(true);
    expect(isScanSoundEnabled()).toBe(true);
    setScanSound(false);
    expect(isScanSoundEnabled()).toBe(false);
  });
});
