// 4-up A4 layout: arrange up to 4 completed worksheet pages in a 2x2 grid on
// a single portrait A4 image. Each tile preserves aspect ratio, sits on a
// white background, and is labelled with its source PDF page number so the
// AI marker can still reference page numbers.
//
// At 200 DPI, portrait A4 is 1654 x 2339 px. Each tile gets ~795 x 1115 px
// (after margins/gutter) — large enough to preserve printed text legibility
// for typical worksheet pages.
//
// NOTE: this composer always renders at 200 DPI by default, intentionally
// decoupled from settings.renderDpi (the per-page submission DPI). 4-up
// tiles need higher density than full-page submissions to stay readable
// after the 4x area reduction. If a future "4-up DPI" setting is exposed,
// thread it through the `dpi` option here.

import { renderPageOffscreen } from './pdfRender.js';
import { drawStroke } from './draw.js';

const A4_PORTRAIT_PT = { w: 595, h: 842 };
const DEFAULT_DPI = 200;

// pages: [{ pageNumber, strokes }] — up to 4 entries.
// Returns: { dataUrl, includedPageNumbers, widthPx, heightPx }
export async function composeFourUpA4(pdf, pages, opts = {}) {
  const dpi = opts.dpi || DEFAULT_DPI;
  const ptToPx = dpi / 72;
  const sheetW = Math.round(A4_PORTRAIT_PT.w * ptToPx);
  const sheetH = Math.round(A4_PORTRAIT_PT.h * ptToPx);
  const margin = Math.round(20 * ptToPx);   // outer margin
  const gutter = Math.round(12 * ptToPx);   // between tiles
  const labelH = Math.round(14 * ptToPx);   // page label band per tile

  const cellW = Math.floor((sheetW - margin * 2 - gutter) / 2);
  const cellH = Math.floor((sheetH - margin * 2 - gutter) / 2);
  const tileW = cellW;
  const tileH = cellH - labelH;

  const sheet = document.createElement('canvas');
  sheet.width = sheetW;
  sheet.height = sheetH;
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, sheetW, sheetH);
  ctx.fillStyle = '#14181f';
  ctx.font = `bold ${Math.round(11 * ptToPx)}px sans-serif`;
  ctx.textBaseline = 'middle';

  const slots = [
    { x: margin, y: margin },
    { x: margin + cellW + gutter, y: margin },
    { x: margin, y: margin + cellH + gutter },
    { x: margin + cellW + gutter, y: margin + cellH + gutter },
  ];

  const includedPageNumbers = [];

  for (let i = 0; i < 4; i++) {
    const slot = slots[i];
    // Slot border (light) so the AI sees clear separations
    ctx.strokeStyle = '#d8dde5';
    ctx.lineWidth = Math.max(1, Math.round(0.5 * ptToPx));
    ctx.strokeRect(slot.x + 0.5, slot.y + 0.5, cellW - 1, cellH - 1);

    if (i >= pages.length) {
      // Empty quarter: white-filled with a subtle "(blank)" label.
      ctx.fillStyle = '#9aa3af';
      ctx.font = `italic ${Math.round(10 * ptToPx)}px sans-serif`;
      ctx.fillText('(blank)', slot.x + cellW / 2 - Math.round(20 * ptToPx), slot.y + cellH / 2);
      ctx.fillStyle = '#14181f';
      ctx.font = `bold ${Math.round(11 * ptToPx)}px sans-serif`;
      continue;
    }

    const { pageNumber, strokes } = pages[i];
    includedPageNumbers.push(pageNumber);

    // Draw label band at top of the cell. The color is intentionally
    // dark grey, NOT blue: the extraction prompt tells the model that
    // blue marks are the child's answers, so a blue label here would be
    // a real misclassification risk. The wording also makes it clear
    // the label is metadata, not a student answer.
    ctx.fillStyle = '#5b6573';
    ctx.fillText(`PDF page ${pageNumber} — not student answer`, slot.x + 4, slot.y + labelH / 2);
    ctx.fillStyle = '#14181f';

    // Render the page off-screen at a DPI matched to the tile size, then
    // letterbox into the tile area.
    const tileCanvas = await renderTile(pdf, pageNumber, strokes, tileW, tileH);
    // Center inside the tile area
    const drawX = slot.x + Math.round((cellW - tileCanvas.width) / 2);
    const drawY = slot.y + labelH + Math.round((tileH - tileCanvas.height) / 2);
    ctx.drawImage(tileCanvas, drawX, drawY);
  }

  return {
    dataUrl: sheet.toDataURL('image/jpeg', 0.85),
    includedPageNumbers,
    widthPx: sheetW,
    heightPx: sheetH,
  };
}

async function renderTile(pdf, pageNumber, strokes, maxW, maxH) {
  // Pick a DPI that fits the page into (maxW, maxH) preserving aspect.
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const fit = Math.min(maxW / baseViewport.width, maxH / baseViewport.height);
  const dpi = (fit * 72);
  const r = await renderPageOffscreen(pdf, pageNumber, dpi);
  // Draw strokes on top using existing helper.
  for (const s of strokes) {
    drawStroke(r.ctx, s, {
      pageWidthPts: r.pageWidthPts,
      widthPx: r.widthPx,
      heightPx: r.heightPx,
    });
  }
  return r.canvas;
}

// Group an array of pages into chunks of up to 4 for 4-up composition.
export function chunkInto(pages, size) {
  const out = [];
  for (let i = 0; i < pages.length; i += size) out.push(pages.slice(i, i + size));
  return out;
}
