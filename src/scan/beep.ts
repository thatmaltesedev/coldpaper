/**
 * Scan feedback. Sound is OFF by default (importing a 50-code PDF must not
 * beep 50 times); the restore tab has a toggle for people who want audible
 * camera feedback. Vibration still fires where supported: silent haptics are
 * the useful part of scanning with a phone.
 */

let soundEnabled = false;
let ctx: AudioContext | null = null;
let lastDuplicate = 0;

export function setScanSound(on: boolean): void {
  soundEnabled = on;
}

export function isScanSoundEnabled(): boolean {
  return soundEnabled;
}

function tone(frequency: number, startInMs: number, durationMs: number, gainValue = 0.08): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = frequency;
  gain.gain.value = gainValue;
  osc.connect(gain).connect(ctx.destination);
  const t0 = ctx.currentTime + startInMs / 1000;
  osc.start(t0);
  osc.stop(t0 + durationMs / 1000);
}

export function scanFeedback(kind: 'added' | 'duplicate' | 'complete'): void {
  try {
    if (kind === 'added') navigator.vibrate?.(40);
    else if (kind === 'complete') navigator.vibrate?.([70, 50, 120]);

    if (!soundEnabled) return; // muted: skip audio entirely (no AudioContext)
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    if (kind === 'added') {
      tone(880, 0, 70);
    } else if (kind === 'complete') {
      tone(660, 0, 90);
      tone(990, 110, 140);
    } else {
      // Duplicates happen constantly while pointing at a page: keep them quiet and rare.
      const now = Date.now();
      if (now - lastDuplicate > 1500) {
        lastDuplicate = now;
        tone(330, 0, 25, 0.03);
      }
    }
  } catch {
    // No audio? No problem. The progress meter still moves.
  }
}
