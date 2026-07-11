/** Restore tab: live camera scanning + photo import, mobile-first. */
import { ChunkCollector, type CollectedBackup } from '../core/collector';
import { isCpError } from '../core/errors';
import { restoreBackup, type RestoredFile } from '../core/pipeline';
import { isScanSoundEnabled, scanFeedback, setScanSound } from '../scan/beep';
import { startCamera, type CameraSession } from '../scan/camera';
import { QrDecoder } from '../scan/decode';
import { renderPdfPages } from '../scan/pdf-import';
import { $, el, fmtBytes, fmtHexGroups, safeFileName } from './dom';

const MAX_IMPORT_DIMENSION = 2600;

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export function initRestoreUi(): void {
  const cameraBtn = $<HTMLButtonElement>('#camera-btn');
  const importBtn = $<HTMLButtonElement>('#import-btn');
  const importInput = $<HTMLInputElement>('#import-input');
  const cameraWrap = $('#camera-wrap');
  const video = $<HTMLVideoElement>('#camera-video');
  const torchBtn = $<HTMLButtonElement>('#torch-btn');
  const stopBtn = $<HTMLButtonElement>('#stop-camera');
  const dropTarget = $('#restore-drop');
  const importProgress = $('#import-progress');
  const scanNote = $('#scan-note');
  const statusSection = $('#restore-status');
  const resultSection = $('#restore-result');

  let collector = new ChunkCollector();
  let decoder: QrDecoder | null = null;
  let camera: CameraSession | null = null;
  let torchOn = false;
  const passphrases = new Map<string, string>();
  const restored = new Map<string, RestoredFile>();
  const restoring = new Set<string>();
  const promptedFor = new Set<string>();
  let noteTimer: ReturnType<typeof setTimeout> | undefined;

  // ------------------------------------------------------------- helpers
  function note(text: string): void {
    scanNote.textContent = text;
    clearTimeout(noteTimer);
    if (text) noteTimer = setTimeout(() => (scanNote.textContent = ''), 6000);
  }

  async function ensureDecoder(): Promise<QrDecoder> {
    decoder ??= await QrDecoder.create();
    return decoder;
  }

  // Sound is muted by default; batch imports never give per-code feedback
  // even when sound is on (a 50-code PDF must not beep 50 times). The live
  // camera is where per-code feedback earns its keep.
  const soundToggle = $<HTMLButtonElement>('#sound-toggle');
  soundToggle.addEventListener('click', () => {
    const on = !isScanSoundEnabled();
    setScanSound(on);
    soundToggle.setAttribute('aria-pressed', String(on));
    $('#sound-toggle-label').textContent = on ? 'sound: on' : 'sound: off';
  });

  function handleDecoded(payloads: Uint8Array[], source: 'camera' | 'import'): void {
    let progressed = false;
    for (const bytes of payloads) {
      const outcome = collector.add(bytes);
      switch (outcome.kind) {
        case 'added':
          progressed = true;
          if (source === 'camera') {
            scanFeedback('added');
            video.classList.add('flash');
            setTimeout(() => video.classList.remove('flash'), 220);
          }
          break;
        case 'duplicate':
          if (source === 'camera') scanFeedback('duplicate');
          break;
        case 'invalid':
          if (outcome.error.code === 'BAD_CHECKSUM') {
            note('A code scanned fuzzy. Hold steady or move closer.');
          } else if (outcome.error.code === 'UNSUPPORTED_VERSION') {
            note('That code is from a NEWER Coldpaper format. Update this app to restore it.');
          } else {
            note('Ignored a QR code that is not part of a Coldpaper backup.');
          }
          break;
        case 'mismatch':
          note('One code disagreed with the rest of its backup (mis-scan) and was ignored.');
          break;
      }
    }
    if (progressed) {
      renderStatus();
      for (const backup of collector.list()) {
        if (backup.isComplete()) void maybeRestore(backup);
      }
    }
  }

  // ------------------------------------------------------------- camera
  cameraBtn.addEventListener('click', () => void startScanning());
  stopBtn.addEventListener('click', stopScanning);
  torchBtn.addEventListener('click', () => {
    torchOn = !torchOn;
    torchBtn.setAttribute('aria-pressed', String(torchOn));
    void camera?.setTorch(torchOn);
  });

  async function startScanning(): Promise<void> {
    if (camera) return;
    cameraBtn.disabled = true;
    note('');
    try {
      const qr = await ensureDecoder();
      camera = await startCamera(video, async (imageData, canvas) => {
        handleDecoded(await qr.decode(imageData, canvas), 'camera');
      });
      cameraWrap.hidden = false;
      torchBtn.hidden = !camera.torchAvailable;
      cameraBtn.hidden = true;
    } catch (e) {
      note(isCpError(e) ? e.message : 'Could not start the camera. Import photos instead.');
    } finally {
      cameraBtn.disabled = false;
    }
  }

  function stopScanning(): void {
    camera?.stop();
    camera = null;
    torchOn = false;
    cameraWrap.hidden = true;
    cameraBtn.hidden = false;
  }

  // ------------------------------------------------------------- imports
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    if (importInput.files?.length) void importFiles([...importInput.files]);
    importInput.value = '';
  });
  for (const target of [dropTarget, statusSection]) {
    target.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropTarget.classList.add('dragging');
    });
    target.addEventListener('dragleave', () => dropTarget.classList.remove('dragging'));
    target.addEventListener('drop', (event) => {
      event.preventDefault();
      dropTarget.classList.remove('dragging');
      const files = [...(event.dataTransfer?.files ?? [])].filter(
        (f) => f.type.startsWith('image/') || isPdfFile(f),
      );
      if (files.length) void importFiles(files);
    });
  }
  dropTarget.addEventListener('click', () => importInput.click());
  dropTarget.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      importInput.click();
    }
  });

  async function importFiles(files: File[]): Promise<void> {
    const qr = await ensureDecoder();
    importProgress.hidden = false;
    let found = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (isPdfFile(file)) {
        found += await importPdf(qr, file, i + 1, files.length);
        continue;
      }
      importProgress.textContent = `Reading image ${i + 1} of ${files.length}...`;
      try {
        const imageData = await imageDataFromFile(file);
        const payloads = await qr.decode(imageData);
        found += payloads.length;
        handleDecoded(payloads, 'import');
      } catch {
        note(`Couldn't read "${file.name}" as an image.`);
      }
    }
    importProgress.textContent =
      found === 0
        ? 'No QR codes found in those files. Make sure each code is sharp, flat and well-lit.'
        : `Done: found ${found} code${found === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}.`;
    renderStatus();
  }

  /** Pull codes straight out of a PDF: the generated backup PDF or a scanner's PDF output. */
  async function importPdf(qr: QrDecoder, file: File, fileIndex: number, fileCount: number): Promise<number> {
    let found = 0;
    try {
      const data = await file.arrayBuffer();
      for await (const page of renderPdfPages(data)) {
        importProgress.textContent =
          fileCount > 1
            ? `File ${fileIndex} of ${fileCount}: PDF page ${page.pageIndex} of ${page.pageCount}...`
            : `Reading PDF page ${page.pageIndex} of ${page.pageCount}...`;
        const imageData = page.context.getImageData(0, 0, page.canvas.width, page.canvas.height);
        const payloads = await qr.decode(imageData);
        found += payloads.length;
        handleDecoded(payloads, 'import');
      }
    } catch {
      note(`Couldn't read "${file.name}" as a PDF.`);
    }
    return found;
  }

  async function imageDataFromFile(file: File): Promise<ImageData> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      bitmap = await createImageBitmap(file); // older Safari: no options bag
    }
    const scale = Math.min(1, MAX_IMPORT_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  // ------------------------------------------------------------- status UI
  function renderStatus(): void {
    const backups = collector.list();
    statusSection.innerHTML = '';
    if (backups.length === 0) return;

    if (backups.length > 1) {
      statusSection.append(
        el('p', {
          class: 'multi-note',
          text: `Codes from ${backups.length} different backups detected. They are kept separate; keep scanning and restore each below.`,
        }),
      );
    }

    for (const backup of backups) {
      const captured = backup.capturedCount;
      const total = backup.totalChunks;
      const required = backup.requiredCount;
      const complete = backup.isComplete();
      const isRestored = restored.has(backup.backupIdHex);

      const meter = el('progress', { max: String(required) }) as HTMLProgressElement;
      meter.value = Math.min(captured, required);

      const card = el(
        'article',
        { class: `scan-card${complete ? ' complete' : ''}` },
        el(
          'header',
          { class: 'scan-card-head' },
          el('span', { class: 'mono', text: `backup ${backup.backupIdHex.toUpperCase()}` }),
          backup.encrypted ? el('span', { class: 'badge', text: 'encrypted' }) : '',
          complete ? el('span', { class: 'badge ok', text: isRestored ? 'restored' : 'complete' }) : '',
        ),
        meter,
        el('p', {
          class: 'scan-count',
          text: complete
            ? `${captured} of ${total} codes captured: enough to restore.`
            : `${captured} of ${total} codes captured (need any ${required}).`,
        }),
      );

      if (!complete) {
        const groups = backup.groupProgress().filter((g) => !g.satisfied);
        const missing = backup.stillUseful();
        if (missing.length > 0 && missing.length <= 18) {
          card.append(
            el('p', {
              class: 'missing-list mono',
              text: `still useful: ${missing.map((i) => `#${i + 1}`).join('  ')}`,
            }),
          );
        } else if (groups.length > 0 && backup.plan.groupCount > 1) {
          card.append(
            el('p', {
              class: 'muted',
              text: `${backup.plan.groupCount - groups.length} of ${backup.plan.groupCount} groups ready`,
            }),
          );
        }
      } else if (!isRestored) {
        const btn = el('button', { type: 'button', class: 'primary', text: 'Restore this backup' });
        btn.addEventListener('click', () => void maybeRestore(backup, true));
        card.append(btn);
      }
      statusSection.append(card);
    }

    const clear = el('button', { type: 'button', class: 'ghost', text: 'clear all scans' });
    clear.addEventListener('click', () => {
      collector = new ChunkCollector();
      restored.clear();
      restoring.clear();
      promptedFor.clear();
      passphrases.clear();
      resultSection.innerHTML = '';
      renderStatus();
    });
    statusSection.append(clear);
  }

  // ------------------------------------------------------------- restore
  async function maybeRestore(backup: CollectedBackup, manual = false): Promise<void> {
    const id = backup.backupIdHex;
    if (restored.has(id) || restoring.has(id)) return;
    if (backup.encrypted && !passphrases.has(id)) {
      if (manual || !promptedFor.has(id)) {
        promptedFor.add(id);
        renderPassphrasePrompt(backup);
      }
      return;
    }
    restoring.add(id);
    try {
      const file = await restoreBackup(backup, passphrases.get(id));
      restored.set(id, file);
      scanFeedback('complete');
      stopScanning();
      renderResult(backup, file);
      renderStatus();
    } catch (e) {
      if (isCpError(e, 'BAD_PASSPHRASE')) {
        passphrases.delete(id);
        renderPassphrasePrompt(backup, e.message);
      } else if (isCpError(e)) {
        renderError(backup, e.message);
      } else {
        renderError(backup, `Unexpected error: ${String(e)}`);
      }
    } finally {
      restoring.delete(id);
    }
  }

  function renderPassphrasePrompt(backup: CollectedBackup, error?: string): void {
    resultSection.innerHTML = '';
    const input = el('input', {
      type: 'password',
      id: 'restore-passphrase',
      autocomplete: 'current-password',
      spellcheck: 'false',
    }) as HTMLInputElement;
    const form = el(
      'form',
      { class: 'card prompt-card' },
      el('h2', { text: 'Passphrase needed' }),
      el('p', {
        class: 'muted',
        text: `Backup ${backup.backupIdHex.toUpperCase()} is encrypted. All codes are captured; enter the passphrase to unlock it.`,
      }),
      el('label', { class: 'stack', for: 'restore-passphrase', text: 'Passphrase ' }, input),
      error ? el('p', { class: 'error-text', role: 'alert', text: error }) : '',
      el('button', { type: 'submit', class: 'primary big', text: 'Decrypt & restore' }),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!input.value) return;
      passphrases.set(backup.backupIdHex, input.value);
      resultSection.innerHTML = '<p class="muted" role="status">Deriving key (600,000 rounds) and decrypting...</p>';
      void maybeRestore(backup, true);
    });
    resultSection.append(form);
    input.focus();
  }

  function renderError(backup: CollectedBackup, message: string): void {
    resultSection.innerHTML = '';
    resultSection.append(
      el(
        'div',
        { class: 'card error-card', role: 'alert' },
        el('h2', { text: 'Restore failed' }),
        el('p', { text: message }),
        el('p', {
          class: 'muted',
          text: `Backup ${backup.backupIdHex.toUpperCase()}: rescan any doubtful pages; duplicates are always safe.`,
        }),
      ),
    );
  }

  function renderResult(backup: CollectedBackup, file: RestoredFile): void {
    resultSection.innerHTML = '';
    const download = el('button', { type: 'button', class: 'primary big', text: `Download ${safeFileName(file.name)}` });
    download.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: 'application/octet-stream' }));
      el('a', { href: url, download: safeFileName(file.name) }).click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
    resultSection.append(
      el(
        'div',
        { class: 'card success-card' },
        el('h2', { text: 'File restored' }),
        el('p', { class: 'file-name', text: file.name || '(unnamed file)' }),
        el('p', {
          class: 'muted',
          text: `${fmtBytes(file.bytes.length)}${file.wasEncrypted ? ' · decrypted' : ''}${file.wasCompressed ? ' · decompressed' : ''} · backup ${backup.backupIdHex.toUpperCase()}`,
        }),
        el('p', { class: 'verified', text: 'SHA-256 checksum verified: byte-for-byte identical to the original.' }),
        el('p', { class: 'fingerprint', text: fmtHexGroups(file.sha256) }),
        download,
      ),
    );
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
