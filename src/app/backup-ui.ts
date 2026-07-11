/** Backup tab: pick a file, tune density/paper/redundancy/passphrase, get a PDF. */
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

const APP_URL = 'https://thatmaltesedev.github.io/coldpaper/';

interface SelectedFile {
  name: string;
  bytes: Uint8Array;
  hash: Uint8Array;
  /** Post-compression content length (estimated once per file). */
  contentLength: number | null;
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
  const errorLine = el('p', { class: 'error-text', role: 'alert', hidden: true });
  dropzone.after(errorLine);

  let selected: SelectedFile | null = null;
  let generated: { backup: BackupResult; pdf: Uint8Array; url: string; suggestedName: string } | null = null;
  let generating = false;

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
    selected = { name: file.name, bytes, hash, contentLength: null };
    generated = null;

    $('#file-name').textContent = file.name;
    $('#file-size').textContent = `${fmtBytes(bytes.length)} (${bytes.length.toLocaleString('en-US')} bytes)`;
    $('#file-hash').textContent = fmtHexGroups(hash);
    dropzone.hidden = true;
    fileCard.hidden = false;
    optionsForm.hidden = false;
    resultSection.hidden = true;
    summary.textContent = 'Sizing up the file...';

    // Estimate compressed size off the click path so the card paints first.
    setTimeout(() => {
      if (!selected || selected.bytes !== bytes) return;
      selected.contentLength = maybeCompress(bytes).data.length;
      updateSummary();
    }, 30);
  }

  function reset(): void {
    selected = null;
    if (generated) URL.revokeObjectURL(generated.url);
    generated = null;
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
  }
  $('#start-over').addEventListener('click', reset);

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
    if (!selected || selected.contentLength === null) return null;
    const nameBytes = Math.min(new TextEncoder().encode(selected.name).length, 255);
    const inner = 1 + nameBytes + 4 + 32 + selected.contentLength;
    const encrypting = passphrase.value.length > 0;
    return encrypting ? 16 + 12 + inner + 16 : inner;
  }

  function updateSummary(): void {
    if (!selected) return;
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
      const softWarn = selected.bytes.length > SOFT_FILE_WARNING;
      sizeWarning.hidden = !softWarn;
      if (softWarn) {
        sizeWarning.textContent = `Heads up: ${fmtBytes(selected.bytes.length)} means about ${pages} code pages. Paper backups work best under 500 KB; consider backing up only the irreplaceable core.`;
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
    if (!selected || generating) return;
    if (passphrase.value !== passphraseConfirm.value) {
      passphraseError.hidden = false;
      passphraseConfirm.focus();
      return;
    }
    generating = true;
    $('#generate-btn').setAttribute('disabled', '');
    progressWrap.hidden = false;
    try {
      const preset = currentPreset();
      const paper = currentPaper();
      const redundancy = Number(redundancyInput.value);

      progressLabel.textContent = 'Computing parity...';
      progressBar.removeAttribute('value');
      const backup = await createBackup({
        fileName: selected.name,
        fileBytes: selected.bytes,
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
        fileName: selected.name,
        fileSize: selected.bytes.length,
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
      const base = safeFileName(selected.name).replace(/\.[^.]*$/, '') || 'backup';
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
      $('#generate-btn').removeAttribute('disabled');
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
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  if (pages > shownPages) {
    strip.append(el('div', { class: 'preview-more', text: `+ ${pages - shownPages} more page${pages - shownPages === 1 ? '' : 's'}` }));
  }
}
