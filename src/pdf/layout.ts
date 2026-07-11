/**
 * Print geometry, shared by the PDF builder and the on-screen page previews so
 * the preview never lies. All units are PDF points (1/72"), top-down origin;
 * the PDF builder flips y at the end.
 *
 * 3x4 grid on both paper sizes: codes come out 55-58 mm wide, which keeps even
 * a v40 code's modules above 0.3 mm - inside what office printers and phone
 * cameras handle, with generous quiet zones.
 */
export interface PaperSize {
  id: 'a4' | 'letter';
  label: string;
  width: number;
  height: number;
}

export const A4: PaperSize = { id: 'a4', label: 'A4', width: 595.28, height: 841.89 };
export const LETTER: PaperSize = { id: 'letter', label: 'Letter', width: 612, height: 792 };
export const PAPER_SIZES: readonly PaperSize[] = [A4, LETTER];

export function paperById(id: string): PaperSize {
  const paper = PAPER_SIZES.find((p) => p.id === id);
  if (!paper) throw new Error(`unknown paper size: ${id}`);
  return paper;
}

export const GRID_COLS = 3;
export const GRID_ROWS = 4;
export const CODES_PER_PAGE = GRID_COLS * GRID_ROWS;

const MARGIN_X = 36;
const MARGIN_TOP = 48;
const MARGIN_BOTTOM = 40;
const LABEL_HEIGHT = 13;
const GAP_X = 10;
const GAP_Y = 8;

export interface CodeCell {
  /** Top-left of the QR square, top-down coordinates. */
  x: number;
  y: number;
  size: number;
  /** Baseline position for the "Code 7 of 48" label (top-down). */
  labelCenterX: number;
  labelY: number;
}

export interface PageGrid {
  paper: PaperSize;
  cells: CodeCell[];
  codeSize: number;
}

export function computeGrid(paper: PaperSize): PageGrid {
  const colWidth = (paper.width - 2 * MARGIN_X) / GRID_COLS;
  const rowHeight = (paper.height - MARGIN_TOP - MARGIN_BOTTOM) / GRID_ROWS;
  const codeSize = Math.min(colWidth - GAP_X, rowHeight - LABEL_HEIGHT - GAP_Y);
  const cells: CodeCell[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cellX = MARGIN_X + c * colWidth;
      const cellY = MARGIN_TOP + r * rowHeight;
      const x = cellX + (colWidth - codeSize) / 2;
      const y = cellY + (rowHeight - LABEL_HEIGHT - GAP_Y - codeSize) / 2;
      cells.push({
        x,
        y,
        size: codeSize,
        labelCenterX: x + codeSize / 2,
        labelY: y + codeSize + LABEL_HEIGHT - 3,
      });
    }
  }
  return { paper, cells, codeSize };
}

export function codePageCount(totalChunks: number): number {
  return Math.ceil(totalChunks / CODES_PER_PAGE);
}
