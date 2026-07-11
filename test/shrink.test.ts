import { describe, expect, it } from 'vitest';
import { categorize, hasLossyOptions } from '../src/app/shrink';

describe('shrink categorisation', () => {
  it('detects images by mime and by extension', () => {
    expect(categorize('photo.jpg', 'image/jpeg')).toBe('image');
    expect(categorize('scan.PNG', '')).toBe('image');
    expect(categorize('pic.webp', '')).toBe('image');
    expect(categorize('drawing.svg', 'image/svg+xml')).toBe('image');
  });

  it('detects pdfs, videos, audio and archives', () => {
    expect(categorize('will.pdf', 'application/pdf')).toBe('pdf');
    expect(categorize('WILL.PDF', '')).toBe('pdf');
    expect(categorize('clip.mp4', 'video/mp4')).toBe('video');
    expect(categorize('movie.mkv', '')).toBe('video');
    expect(categorize('song.mp3', 'audio/mpeg')).toBe('audio');
    expect(categorize('backup.zip', 'application/zip')).toBe('archive');
    expect(categorize('export.tar.gz', '')).toBe('archive');
    expect(categorize('report.docx', '')).toBe('archive');
  });

  it('falls back to generic for everything else', () => {
    expect(categorize('notes.txt', 'text/plain')).toBe('generic');
    expect(categorize('keys.json', '')).toBe('generic');
    expect(categorize('wallet.dat', 'application/octet-stream')).toBe('generic');
  });

  it('only images and pdfs get lossy options', () => {
    expect(hasLossyOptions('image')).toBe(true);
    expect(hasLossyOptions('pdf')).toBe(true);
    expect(hasLossyOptions('video')).toBe(false);
    expect(hasLossyOptions('audio')).toBe(false);
    expect(hasLossyOptions('archive')).toBe(false);
    expect(hasLossyOptions('generic')).toBe(false);
  });
});
