// Adaptive contact-sheet composer.
//
// Arranges 1-4 worksheet pages on a portrait A4 image, choosing a layout
// that maximises legibility for the page count:
//
//   1 page  → single full-A4 tile
//   2 pages → stacked (full-width, half-height each)
//   3 pages → 1-wide on top + 2 small below (1+2)
//   4 pages → 2x2 grid (the original "4-up" layout)
//
// Each tile is letterboxed with aspect preserved and labelled with the
// source PDF page number so the AI can still attribute answers to the
// correct page even when several are packed onto one image.
//
// At 200 DPI a portrait A4 sheet is 1654x2339 px. Each layout's per-tile
// area in pixels:
//
//   1 page : ~1614 x 2299    (essentially full page)
//   2 pages: ~1614 x ~1140   (full-width, half-height)
//   3 pages: top  ~1614 x ~1140
//            bot   ~795 x ~1140 each
//   4 pages: ~795 x ~1140 each
//
// Higher density (200 DPI) than the per-page submission DPI is intentional:
// when several pages share one image, each tile gets less area, and we
// need extra resolution to keep printed text and handwriting legible
// after the area reduction.
//
// The tile-label colour is dark grey (#5b6573) — NOT blue. The student's
// answers are blue, and the AI is told blue == student. A blue label
// would be a real misclassification risk.

import { renderPageOffscreen } from './pdfRender.js';
import { drawStroke } from './draw.js';

const A4_PORTRAIT_PT = { w: 595, h: 842 };
const DEFAULT_DPI = 200;

// Compose 1-4 pages onto a single A4 portrait image.
//
//   pdf       : the pdf.js document
//   pages     : [{ pageNumber, strokes? }] — 1..4 entries
//   opts      : { dpi?, labelPrefix?, labelSuffix?, jpegQuality?, strokesOnly? }
//
//   labelPrefix defaults to "PDF page". labelSuffix defaults to
//   " — not student answer" (suitable for student-page composites where
//   the AI must distinguish blue student ink from this dark-grey label
//   text). For answer-key composites pass labelSuffix: ''.
//
//   strokesOnly (default false): when true, each tile shows ONLY the
//   student's strokes on a white background (no printed PDF content).
//   Same layout, same labels, same dimensions — meant to be a companion
//   to the printed-with-strokes composite so the extraction call can
//   tell "no ink at all" apart from "printed option letter on the
//   page". Same fix as the per-page mode's strokes-only image, applied
//   to the contact-sheet path.
//
// Returns: { dataUrl, includedPageNumbers, widthPx, heightPx, layout }
//   layout ∈ "single" | "stacked" | "one_plus_two" | "grid_2x2"
export async function composeContactSheetA4(pdf, pages, opts = {}) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('composeContactSheetA4: pages must be a non-empty array');
  }
  if (pages.length > 4) {
    throw new Error('composeContactSheetA4: pages length must be 1..4');
  }

  const dpi = opts.dpi || DEFAULT_DPI;
  const strokesOnly = opts.strokesOnly === true;
  const labelPrefix = opts.labelPrefix || 'PDF page';
  // When strokesOnly, the default suffix changes from "— not student
  // answer" (which is true on the printed composite, where the label
  // text could be mistaken for ink) to "— strokes only" (which tells
  // the model what this companion image is). Caller may still override.
  const labelSuffix = opts.labelSuffix == null
    ? (strokesOnly ? ' — strokes only' : ' — not student answer')
    : opts.labelSuffix;
  const jpegQuality = opts.jpegQuality || 0.85;

  const ptToPx = dpi / 72;
  const sheetW = Math.round(A4_PORTRAIT_PT.w * ptToPx);
  const sheetH = Math.round(A4_PORTRAIT_PT.h * ptToPx);
  const margin = Math.round(20 * ptToPx);
  const gutter = Math.round(12 * ptToPx);
  const labelH = Math.round(14 * ptToPx);

  const sheet = document.createElement('canvas');
  sheet.width = sheetW;
  sheet.height = sheetH;
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, sheetW, sheetH);
  ctx.textBaseline = 'middle';

  const slots = layoutSlots(pages.length, {
    sheetW, sheetH, margin, gutter, labelH,
  });

  const includedPageNumbers = [];
  for (let i = 0; i < pages.length; i++) {
    const slot = slots[i];
    const { pageNumber, strokes } = pages[i];
    includedPageNumbers.push(pageNumber);

    // Slot border so the AI sees clear separations between tiles.
    ctx.strokeStyle = '#d8dde5';
    ctx.lineWidth = Math.max(1, Math.round(0.5 * ptToPx));
    ctx.strokeRect(slot.x + 0.5, slot.y + 0.5, slot.cellW - 1, slot.cellH - 1);

    // Label band at the top of the cell.
    ctx.fillStyle = '#5b6573';
    ctx.font = `bold ${Math.round(11 * ptToPx)}px sans-serif`;
    ctx.fillText(`${labelPrefix} ${pageNumber}${labelSuffix}`, slot.x + 4, slot.y + labelH / 2);

    // Render the page off-screen at a DPI matched to the available tile
    // area, then letterbox into the tile area.
    const tileW = slot.cellW;
    const tileH = slot.cellH - labelH;
    const tileCanvas = strokesOnly
      ? await renderStrokesOnlyTile(pdf, pageNumber, strokes || [], tileW, tileH)
      : await renderTile(pdf, pageNumber, strokes || [], tileW, tileH);
    const drawX = slot.x + Math.round((tileW - tileCanvas.width) / 2);
    const drawY = slot.y + labelH + Math.round((tileH - tileCanvas.height) / 2);
    ctx.drawImage(tileCanvas, drawX, drawY);
  }

  return {
    dataUrl: sheet.toDataURL('image/jpeg', jpegQuality),
    includedPageNumbers,
    widthPx: sheetW,
    heightPx: sheetH,
    layout: layoutName(pages.length),
  };
}

function layoutName(n) {
  if (n === 1) return 'single';
  if (n === 2) return 'stacked';
  if (n === 3) return 'one_plus_two';
  return 'grid_2x2';
}

// Compute slot rectangles for the chosen layout. Each slot has:
//   { x, y, cellW, cellH }  — outer cell rect (label + tile area).
// The label band is laid inside the cell at its top.
function layoutSlots(n, { sheetW, sheetH, margin, gutter, labelH }) {
  const innerW = sheetW - margin * 2;
  const innerH = sheetH - margin * 2;

  if (n === 1) {
    return [{ x: margin, y: margin, cellW: innerW, cellH: innerH }];
  }

  if (n === 2) {
    const cellH = Math.floor((innerH - gutter) / 2);
    return [
      { x: margin, y: margin,                       cellW: innerW, cellH },
      { x: margin, y: margin + cellH + gutter,      cellW: innerW, cellH },
    ];
  }

  if (n === 3) {
    // Top row: one wide cell.
    // Bottom row: two cells side-by-side.
    // Give the top cell ~45% of inner height (slightly less than half) so
    // the bottom pair stays generously sized — they'd otherwise be too
    // narrow on portrait A4 to remain legible.
    const topCellH = Math.floor((innerH - gutter) * 0.45);
    const bottomCellH = innerH - gutter - topCellH;
    const halfCellW = Math.floor((innerW - gutter) / 2);
    return [
      { x: margin, y: margin, cellW: innerW, cellH: topCellH },
      { x: margin,                          y: margin + topCellH + gutter, cellW: halfCellW, cellH: bottomCellH },
      { x: margin + halfCellW + gutter,     y: margin + topCellH + gutter, cellW: halfCellW, cellH: bottomCellH },
    ];
  }

  // 4 → 2x2
  const halfCellW = Math.floor((innerW - gutter) / 2);
  const halfCellH = Math.floor((innerH - gutter) / 2);
  return [
    { x: margin,                      y: margin,                      cellW: halfCellW, cellH: halfCellH },
    { x: margin + halfCellW + gutter, y: margin,                      cellW: halfCellW, cellH: halfCellH },
    { x: margin,                      y: margin + halfCellH + gutter, cellW: halfCellW, cellH: halfCellH },
    { x: margin + halfCellW + gutter, y: margin + halfCellH + gutter, cellW: halfCellW, cellH: halfCellH },
  ];
}

async function renderTile(pdf, pageNumber, strokes, maxW, maxH) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const fit = Math.min(maxW / baseViewport.width, maxH / baseViewport.height);
  const dpi = (fit * 72);
  const r = await renderPageOffscreen(pdf, pageNumber, dpi);
  for (const s of strokes) {
    drawStroke(r.ctx, s, {
      pageWidthPts: r.pageWidthPts,
      widthPx: r.widthPx,
      heightPx: r.heightPx,
    });
  }
  return r.canvas;
}

// Strokes-only sibling of renderTile. Same fit calc / DPI / canvas
// dimensions — only the content differs: the printed PDF is wiped
// with white before the strokes are drawn, so each tile shows only
// the student's blue ink against white. Used as a companion to the
// printed-with-strokes composite so the extraction model can tell
// "no ink at all" apart from "printed option letter on the
// underlying page". Same fix as the per-page renderStrokesOnlyPage
// in flatten.js, applied to the contact-sheet path.
async function renderStrokesOnlyTile(pdf, pageNumber, strokes, maxW, maxH) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const fit = Math.min(maxW / baseViewport.width, maxH / baseViewport.height);
  const dpi = (fit * 72);
  const r = await renderPageOffscreen(pdf, pageNumber, dpi);
  // renderPageOffscreen painted the printed PDF on the canvas.
  // Wipe with white before drawing strokes.
  r.ctx.fillStyle = 'white';
  r.ctx.fillRect(0, 0, r.canvas.width, r.canvas.height);
  for (const s of strokes) {
    drawStroke(r.ctx, s, {
      pageWidthPts: r.pageWidthPts,
      widthPx: r.widthPx,
      heightPx: r.heightPx,
    });
  }
  return r.canvas;
}

// Group an array of pages into chunks of up to `size` for contact-sheet
// composition. Trailing chunk may have fewer than `size` entries — the
// adaptive composer handles 1, 2, 3, or 4 page chunks natively (no need
// to pad with blanks).
export function chunkInto(pages, size) {
  const out = [];
  for (let i = 0; i < pages.length; i += size) out.push(pages.slice(i, i + size));
  return out;
}

// Backwards-compatible alias. Older callers used `composeFourUpA4` and
// always padded the trailing chunk with empty quarters; the adaptive
// composer no longer needs that padding (it picks a layout for the
// actual page count). Kept so existing imports keep working.
export const composeFourUpA4 = composeContactSheetA4;
