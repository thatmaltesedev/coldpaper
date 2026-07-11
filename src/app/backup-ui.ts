/** Backup tab: pick a file, optionally shrink it, tune options, get a PDF. */
import { maybeCompress } from '../core/compress';
import { isCpError } from '../core/errors';
import { sha256 } from '../core/hash';
import { planBackup } from '../core/layout';
import { createBackup, HARD_FILE_CAP, SOFT_FILE_WARNING, type BackupResult } from '../core/pipeline';
import { buildPdf } from '../pdf/build';
import { codePageCount, computeGrid, paperById, type PaperSize } from '../pdf/layout';
import { makeQrMatrix } from '../qr/generate';
import { DEFAULT_PRESET, PRESETS, presetById, type DensityPreset } from '../qr/presets';
import { $, el, fmtBytes, fmtHexGroups, safeFileName, todayIso } from './dom';
import {
  categorize,
  hasLossyOptions,
  shrinkImage,
  shrinkPdf,
  webpSupported,
  type ShrinkCategory,
} from './shrink';

const APP_URL = 'https://thatmaltesedev.github.io/coldpaper/';

interface FileVariant {
  name: string;
  bytes: Uint8Array;
  hash: Uint8Array;
  /** Post-DEFLATE size estimate; null while still being computed. */
  contentLength: number | null;
}

interface SelectedFile {
  original: FileVariant;
  category: ShrinkCategory;
  /** Present only when the shrink toggle is on AND the result was smaller. */
  shrunk: (FileVariant & { detail: string }) | null;
}

export function initBackupUi(): void {
  const dropzone = $('#dropzone');
  const fileInput = $<HTMLInputElement>('#file-input');
  const fileCard = $('#file-card');
  const optionsForm = $<HTMLFormElement>('#backup-options');
  const densityGroup = $('#density-group');
  const redundancyInput = $<HTMLInputElement>('#redundancy');
  const redundancyNote = $('#redundancy-note');
  const passphrase = $<HTMLInputElement>('#passphrase');
  const passphraseConfirm = $<HTMLInputElement>('#passphrase-confirm');
  const passphraseError = $('#passphrase-error');
  const summary = $('#backup-summary');
  const sizeWarning = $('#size-warning');
  const progressWrap = $('#backup-progress');
  const progressLabel = $('#backup-progress-label');
  const progressBar = $<HTMLProgressElement>('#backup-progress-bar');
  const resultSection = $('#backup-result');
  const resultLine = $('#backup-result-line');
  const previewStrip = $('#preview-strip');
  const shrinkToggle = $<HTMLInputElement>('#shrink-toggle');
  const shrinkGear = $<HTMLButtonElement>('#shrink-gear');
  const shrinkSettings = $('#shrink-settings');
  const shrinkStatus = $('#shrink-status');
  const generateBtn = $<HTMLButtonElement>('#generate-btn');
  const errorLine = el('p', { class: 'error-text', role: 'alert', hidden: true });
  dropzone.after(errorLine);

  let selected: SelectedFile | null = null;
  let generated: { backup: BackupResult; pdf: Uint8Array; url: string; suggestedName: string } | null = null;
  let generating = false;
  let shrinkRun = 0;
  let shrinkBusy = false;
  let shrinkDebounce: ReturnType<typeof setTimeout> | undefined;

  const effective = (): FileVariant | null => (selected ? (selected.shrunk ?? selected.original) : null);

  // ---- density radio cards -------------------------------------------------
  for (const preset of PRESETS) {
    const input = el('input', {
      type: 'radio',
      name: 'density',
      value: preset.id,
      id: `density-${preset.id}`,
    }) as HTMLInputElement;
    input.checked = preset.id === DEFAULT_PRESET.id;
    const card = el(
      'label',
      { class: 'choice-card', for: `density-${preset.id}` },
      input,
      el('span', { class: 'choice-title', text: preset.label }),
      el('span', { class: 'choice-desc', text: preset.description }),
      el('span', { class: 'choice-meta', text: `${preset.chunkSize} bytes per code` }),
    );
    densityGroup.append(card);
  }

  // ---- file selection ------------------------------------------------------
  const pickFile = () => fileInput.click();
  dropzone.addEventListener('click', pickFile);
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pickFile();
    }
  });
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
    const file = event.dataTransfer?.files?.[0];
    if (file) void onFile(file);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void onFile(file);
  });
  $('#change-file').addEventListener('click', () => {
    reset();
    pickFile();
  });

  async function onFile(file: File): Promise<void> {
    errorLine.hidden = true;
    if (file.size > HARD_FILE_CAP) {
      errorLine.textContent = `"${file.name}" is ${fmtBytes(file.size)}. The hard cap is 5 MB; paper has limits, so zip only the irreplaceable part.`;
      errorLine.hidden = false;
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await sha256(bytes);
    selected = {
      original: { name: file.name, bytes, hash, contentLength: null },
      category: categorize(file.name, file.type || ''),
      shrunk: null,
    };
    generated = null;

    $('#file-name').textContent = file.name;
    $('#file-size').textContent = `${fmtBytes(bytes.length)} (${bytes.length.toLocaleString('en-US')} bytes)`;
    dropzone.hidden = true;
    fileCard.hidden = false;
    optionsForm.hidden = false;
    resultSection.hidden = true;
    summary.textContent = 'Sizing up the file...';
    setupShrinkUi(selected.category);
    refreshFileCard();

    // Estimate compressed size off the click path so the card paints first.
    setTimeout(() => {
      if (!selected || selected.original.bytes !== bytes) return;
      selected.original.contentLength = maybeCompress(bytes).data.length;
      updateSummary();
    }, 30);
  }

  function reset(): void {
    selected = null;
    if (generated) URL.revokeObjectURL(generated.url);
    generated = null;
    shrinkRun++;
    shrinkBusy = false;
    clearTimeout(shrinkDebounce);
    fileInput.value = '';
    passphrase.value = '';
    passphraseConfirm.value = '';
    passphraseError.hidden = true;
    dropzone.hidden = false;
    fileCard.hidden = true;
    optionsForm.hidden = true;
    resultSection.hidden = true;
    previewStrip.innerHTML = '';
    errorLine.hidden = true;
    shrinkToggle.checked = false;
    shrinkSettings.hidden = true;
    shrinkGear.setAttribute('aria-expanded', 'false');
    shrinkStatus.textContent = '';
  }
  $('#start-over').addEventListener('click', reset);

  // ---- shrink (lossy pre-compression) --------------------------------------
  shrinkGear.addEventListener('click', () => {
    const expand = shrinkSettings.hidden;
    shrinkSettings.hidden = !expand;
    shrinkGear.setAttribute('aria-expanded', String(expand));
  });

  shrinkToggle.addEventListener('change', () => {
    if (!selected) return;
    if (shrinkToggle.checked) {
      if (shrinkSettings.hidden) {
        shrinkSettings.hidden = false;
        shrinkGear.setAttribute('aria-expanded', 'true');
      }
      void runShrink();
    } else {
      shrinkRun++; // cancels any in-flight run
      shrinkBusy = false;
      selected.shrunk = null;
      shrinkStatus.textContent = 'Using the original file.';
      refreshFileCard();
      updateSummary();
    }
  });

  function setupShrinkUi(category: ShrinkCategory): void {
    shrinkSettings.innerHTML = '';
    shrinkStatus.textContent = '';
    shrinkToggle.checked = false;
    shrinkToggle.disabled = !hasLossyOptions(category);
    shrinkSettings.hidden = true;
    shrinkGear.setAttribute('aria-expanded', 'false');

    const select = (id: string, label: string, options: [string, string][], selectedValue: string) => {
      const control = el('select', { id }) as HTMLSelectElement;
      for (const [value, text] of options) control.append(el('option', { value, text }));
      control.value = selectedValue;
      control.addEventListener('change', () => {
        if (shrinkToggle.checked) {
          clearTimeout(shrinkDebounce);
          shrinkDebounce = setTimeout(() => void runShrink(), 250);
        }
      });
      return el('label', { class: 'stack', for: id, text: label + ' ' }, control);
    };
    const note = (text: string) => el('p', { class: 'shrink-note', text });

    if (category === 'image') {
      const formats: [string, string][] = [['jpeg', 'JPEG']];
      if (webpSupported()) formats.push(['webp', 'WebP']);
      shrinkSettings.append(
        el(
          'div',
          { class: 'options-row options-row--three' },
          select('shrink-dimension', 'Longest side', [
            ['1600', '1600 px'],
            ['1200', '1200 px'],
            ['800', '800 px'],
            ['640', '640 px'],
            ['0', 'keep size'],
          ], '1200'),
          select('shrink-quality', 'Quality', [
            ['0.8', 'high'],
            ['0.65', 'medium'],
            ['0.5', 'low'],
          ], '0.65'),
          select('shrink-format', 'Format', formats, 'jpeg'),
        ),
        note(
          'The backup stores the shrunken copy, and restoring returns that copy. Keep the original elsewhere if you need it.',
        ),
      );
    } else if (category === 'pdf') {
      shrinkSettings.append(
        el(
          'div',
          { class: 'options-row' },
          select('shrink-dpi', 'Page detail', [
            ['150', '150 dpi (crisp)'],
            ['100', '100 dpi (balanced)'],
            ['72', '72 dpi (smallest)'],
          ], '100'),
          select('shrink-quality', 'Quality', [
            ['0.8', 'high'],
            ['0.65', 'medium'],
            ['0.5', 'low'],
          ], '0.65'),
        ),
        note(
          'Pages are re-rendered as images: much smaller for scanned documents, often LARGER for pure text, which also stops being selectable. If the result is not smaller, the original is kept.',
        ),
      );
    } else if (category === 'video') {
      shrinkSettings.append(
        note(
          'Video is already heavily compressed; a browser cannot usefully squeeze it further. Paper suits small files: consider backing up the key information instead of the footage itself.',
        ),
      );
    } else if (category === 'audio') {
      shrinkSettings.append(
        note('Compressed audio (MP3, AAC, OGG) cannot be meaningfully shrunk further in the browser.'),
      );
    } else if (category === 'archive') {
      shrinkSettings.append(
        note(
          'Archives are already compressed, so there are no lossy options. The automatic lossless pass still runs during backup.',
        ),
      );
    } else {
      shrinkSettings.append(
        note(
          'No lossy options for this file type. Lossless compression is applied automatically during backup whenever it makes the payload smaller.',
        ),
      );
    }
  }

  async function runShrink(): Promise<void> {
    if (!selected || !hasLossyOptions(selected.category)) return;
    const token = ++shrinkRun;
    shrinkBusy = true;
    generateBtn.disabled = true;
    shrinkStatus.textContent = 'Shrinking...';
    const original = selected.original;
    try {
      let result;
      if (selected.category === 'image') {
        result = await shrinkImage(original.bytes, original.name, {
          maxDimension: Number($<HTMLSelectElement>('#shrink-dimension').value),
          quality: Number($<HTMLSelectElement>('#shrink-quality').value),
          format: $<HTMLSelectElement>('#shrink-format').value as 'jpeg' | 'webp',
        });
      } else {
        result = await shrinkPdf(
          original.bytes,
          original.name,
          {
            dpi: Number($<HTMLSelectElement>('#shrink-dpi').value),
            quality: Number($<HTMLSelectElement>('#shrink-quality').value),
          },
          (page, pages) => {
            if (token === shrinkRun) shrinkStatus.textContent = `Rasterising page ${page} of ${pages}...`;
          },
        );
      }
      if (token !== shrinkRun || !selected) return; // settings changed mid-run
      if (result.bytes.length < original.bytes.length) {
        const hash = await sha256(result.bytes);
        const contentLength = maybeCompress(result.bytes).data.length;
        selected.shrunk = { ...result, hash, contentLength };
        const saved = Math.round((1 - result.bytes.length / original.bytes.length) * 100);
        shrinkStatus.textContent = `${fmtBytes(original.bytes.length)} to ${fmtBytes(result.bytes.length)} (${saved}% smaller). Backing up the shrunken copy: ${result.name} (${result.detail}).`;
      } else {
        selected.shrunk = null;
        shrinkToggle.checked = false;
        shrinkStatus.textContent = `No savings at these settings (result was ${fmtBytes(result.bytes.length)}). Keeping the original.`;
      }
    } catch (e) {
      if (token !== shrinkRun || !selected) return;
      selected.shrunk = null;
      shrinkToggle.checked = false;
      shrinkStatus.textContent = `Could not shrink: ${e instanceof Error ? e.message : String(e)}.`;
    } finally {
      if (token === shrinkRun) {
        shrinkBusy = false;
        generateBtn.disabled = false;
        refreshFileCard();
        updateSummary();
      }
    }
  }

  function refreshFileCard(): void {
    if (!selected) return;
    const eff = effective()!;
    $('#file-hash-label').textContent =
      selected.shrunk === null ? 'SHA-256 fingerprint' : 'SHA-256 fingerprint (shrunken copy)';
    $('#file-hash').textContent = fmtHexGroups(eff.hash);
  }

  // ---- live summary --------------------------------------------------------
  function currentPreset(): DensityPreset {
    const checked = densityGroup.querySelector<HTMLInputElement>('input[name=density]:checked');
    return presetById(checked?.value ?? DEFAULT_PRESET.id);
  }
  function currentPaper(): PaperSize {
    const checked = optionsForm.querySelector<HTMLInputElement>('input[name=paper]:checked');
    return paperById(checked?.value ?? 'a4');
  }

  function estimatedPayloadLength(): number | null {
    const eff = effective();
    if (!eff || eff.contentLength === null) return null;
    const nameBytes = Math.min(new TextEncoder().encode(eff.name).length, 255);
    const inner = 1 + nameBytes + 4 + 32 + eff.contentLength;
    const encrypting = passphrase.value.length > 0;
    return encrypting ? 16 + 12 + inner + 16 : inner;
  }

  function updateSummary(): void {
    const eff = effective();
    if (!eff) return;
    const payloadLength = estimatedPayloadLength();
    if (payloadLength === null) return;
    const preset = currentPreset();
    const redundancy = Number(redundancyInput.value);
    try {
      const plan = planBackup(payloadLength, preset.chunkSize, redundancy);
      const parityTotal = plan.parityPerGroup * plan.groupCount;
      const pages = codePageCount(plan.totalChunks);
      const tolerance =
        plan.groupCount === 1
          ? `lose any ${parityTotal} code${parityTotal === 1 ? '' : 's'} and still restore`
          : `tolerates ${plan.parityPerGroup} lost codes per group (${parityTotal} when damage is spread out)`;
      summary.textContent = `${plan.totalChunks} codes · ${pages + 1} pages including the cover · ${tolerance}`;
      redundancyNote.textContent = `${redundancy}%: ${parityTotal} parity code${parityTotal === 1 ? '' : 's'}`;
      const softWarn = eff.bytes.length > SOFT_FILE_WARNING;
      sizeWarning.hidden = !softWarn;
      if (softWarn) {
        sizeWarning.textContent = `Heads up: ${fmtBytes(eff.bytes.length)} means about ${pages} code pages. Paper backups work best under 500 KB; consider backing up only the irreplaceable core.`;
      }
    } catch (e) {
      summary.textContent = isCpError(e) ? e.message : 'This combination does not fit; try a denser preset.';
    }
  }

  optionsForm.addEventListener('input', () => {
    passphraseError.hidden = true;
    updateSummary();
  });

  // ---- generate ------------------------------------------------------------
  optionsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void generate();
  });

  async function generate(): Promise<void> {
    const eff = effective();
    if (!eff || generating || shrinkBusy) return;
    if (passphrase.value !== passphraseConfirm.value) {
      passphraseError.hidden = false;
      passphraseConfirm.focus();
      return;
    }
    generating = true;
    generateBtn.disabled = true;
    progressWrap.hidden = false;
    try {
      const preset = currentPreset();
      const paper = currentPaper();
      const redundancy = Number(redundancyInput.value);

      progressLabel.textContent = 'Computing parity...';
      progressBar.removeAttribute('value');
      const backup = await createBackup({
        fileName: eff.name,
        fileBytes: eff.bytes,
        chunkSize: preset.chunkSize,
        redundancyPercent: redundancy,
        passphrase: passphrase.value || undefined,
        onProgress: (done, total) => {
          progressLabel.textContent = `Computing parity... group ${done} of ${total}`;
          progressBar.max = total;
          progressBar.value = done;
        },
      });

      progressLabel.textContent = 'Rendering codes...';
      const pdf = await buildPdf({
        backup,
        fileName: eff.name,
        fileSize: eff.bytes.length,
        preset,
        paper,
        redundancyPercent: redundancy,
        createdOn: todayIso(),
        appUrl: APP_URL,
        onProgress: (done, total) => {
          progressLabel.textContent = `Rendering codes... ${done} of ${total}`;
          progressBar.max = total;
          progressBar.value = done;
        },
      });

      if (generated) URL.revokeObjectURL(generated.url);
      const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: 'application/pdf' }));
      const base = safeFileName(eff.name).replace(/\.[^.]*$/, '') || 'backup';
      generated = { backup, pdf, url, suggestedName: `coldpaper-${base}.pdf` };

      const plan = backup.plan;
      const pages = codePageCount(plan.totalChunks);
      resultLine.textContent =
        `${plan.totalChunks} codes on ${pages} page${pages === 1 ? '' : 's'} (+ cover) · ` +
        `backup ID ${fmtHexGroups(backup.backupId).replace(' ', '')} · ` +
        `${backup.encrypted ? 'encrypted · ' : ''}${fmtBytes(pdf.length)} PDF`;
      optionsForm.hidden = true;
      resultSection.hidden = false;
      resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      void renderPreviews(previewStrip, backup, preset, paper);
    } catch (e) {
      errorLine.textContent = isCpError(e) ? e.message : `Something went wrong: ${String(e)}`;
      errorLine.hidden = false;
    } finally {
      generating = false;
      generateBtn.disabled = false;
      progressWrap.hidden = true;
    }
  }

  // ---- download / print ----------------------------------------------------
  $('#download-pdf').addEventListener('click', () => {
    if (!generated) return;
    el('a', { href: generated.url, download: generated.suggestedName }).click();
  });
  $('#print-pdf').addEventListener('click', () => {
    if (!generated) return;
    const frame = el('iframe', { class: 'print-frame', src: generated.url, title: 'print' });
    frame.addEventListener('load', () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        window.open(generated?.url, '_blank');
      }
    });
    document.body.append(frame);
    setTimeout(() => frame.remove(), 60_000);
  });
}

// ---- page previews ---------------------------------------------------------

function matrixToCanvas(matrix: { size: number; data: Uint8Array }): HTMLCanvasElement {
  const canvas = el('canvas') as HTMLCanvasElement;
  canvas.width = matrix.size;
  canvas.height = matrix.size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(matrix.size, matrix.size);
  for (let i = 0; i < matrix.data.length; i++) {
    const v = matrix.data[i] ? 23 : 255;
    image.data[i * 4] = v;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

async function renderPreviews(
  strip: HTMLElement,
  backup: BackupResult,
  preset: DensityPreset,
  paper: PaperSize,
): Promise<void> {
  strip.innerHTML = '';
  const grid = computeGrid(paper);
  const pages = codePageCount(backup.plan.totalChunks);
  const scale = 168 / paper.width;
  const thumbW = 168;
  const thumbH = Math.round(paper.height * scale);

  const addThumb = (canvas: HTMLCanvasElement, label: string) => {
    canvas.className = 'preview-page';
    strip.append(el('figure', { class: 'preview-figure' }, canvas, el('figcaption', { text: label })));
  };

  // Cover sheet: stylised.
  {
    const canvas = el('canvas') as HTMLCanvasElement;
    canvas.width = thumbW;
    canvas.height = thumbH;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, thumbW, thumbH);
    ctx.fillStyle = '#171512';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.fillText('COLDPAPER', 14, 26);
    ctx.fillRect(14, 34, thumbW - 28, 1);
    ctx.fillStyle = '#b8b4ab';
    const bars = [46, 54, 70, 78, 86, 104, 112, 130, 138, 146, 154];
    for (const y of bars) ctx.fillRect(14, y, (thumbW - 28) * (0.55 + ((y * 7) % 40) / 100), 3);
    addThumb(canvas, 'Cover sheet');
  }

  const shownPages = Math.min(pages, 4);
  for (let p = 0; p < shownPages; p++) {
    const canvas = el('canvas') as HTMLCanvasElement;
    canvas.width = thumbW;
    canvas.height = thumbH;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, thumbW, thumbH);
    for (let cell = 0; cell < grid.cells.length; cell++) {
      const index = p * grid.cells.length + cell;
      if (index >= backup.plan.totalChunks) break;
      const geometry = grid.cells[cell];
      const mini = matrixToCanvas(makeQrMatrix(backup.chunks[index], preset));
      ctx.drawImage(
        mini,
        Math.round(geometry.x * scale),
        Math.round(geometry.y * scale),
        Math.round(geometry.size * scale),
        Math.round(geometry.size * scale),
      );
    }
    addThumb(canvas, `Page ${p + 1} of ${pages}`);
    // setTimeout, not requestAnimationFrame: rAF never fires in hidden tabs.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (pages > shownPages) {
    strip.append(
      el('div', {
        class: 'preview-more',
        text: `+ ${pages - shownPages} more page${pages - shownPages === 1 ? '' : 's'}`,
      }),
    );
  }
}
