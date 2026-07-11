// Generates the PWA icons from the same QR-corner motif as favicon.svg.
// Run once (npm run icons) and commit the PNGs - they are build inputs.
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';

const PAPER = '#faf9f6';
const INK = '#171512';

function draw(size, pad) {
  const canvas = createCanvas(size, size);
  const g = canvas.getContext('2d');
  g.fillStyle = PAPER;
  g.fillRect(0, 0, size, size);
  const u = (size - pad * 2) / 24;
  const o = pad;
  g.fillStyle = INK;
  const rects = [
    [2, 2, 9, 9],
    [13, 2, 3.5, 3.5],
    [18.5, 2, 3.5, 3.5],
    [13, 7.5, 3.5, 3.5],
    [2, 13, 3.5, 3.5],
    [7.5, 13, 3.5, 3.5],
    [2, 18.5, 3.5, 3.5],
    [13, 13, 9, 9],
  ];
  for (const [x, y, w, h] of rects) g.fillRect(o + x * u, o + y * u, w * u, h * u);
  g.fillStyle = PAPER;
  g.fillRect(o + 4.75 * u, o + 4.75 * u, 3.5 * u, 3.5 * u);
  g.fillRect(o + 15.75 * u, o + 15.75 * u, 3.5 * u, 3.5 * u);
  return canvas;
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-512.png', draw(512, 44).toBuffer('image/png'));
writeFileSync('public/icons/icon-192.png', draw(192, 16).toBuffer('image/png'));
writeFileSync('public/icons/maskable-512.png', draw(512, 96).toBuffer('image/png'));
writeFileSync('public/icons/apple-touch-icon.png', draw(180, 20).toBuffer('image/png'));
console.log('icons written to public/icons/');
