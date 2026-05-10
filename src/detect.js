// AI page-detection coordinator.
//
// Renders low-resolution contact sheets of the loaded PDF, calls the
// page-classification model, and merges results into a normalized
// `pages` array suitable for storing on a paper profile.
//
// Detection is intentionally cheap:
//   - DPI ~100 (low — page-level classification doesn't need clarity)
//   - JPEG quality 0.65
//   - 4 pages per contact sheet
//   - 'low' image detail on the API call
// The detection model defaults to gpt-5.4-nano (see settings.js).

import { composeContactSheetA4, chunkInto } from './contactSheet.js';
import { detectPages } from './openai.js';
import { buildTaskRecord, TASK_TYPES } from './cost.js';

const DETECTION_DPI = 100;
const DETECTION_JPEG_QUALITY = 0.65;
const PAGES_PER_SHEET = 4;

// Render contact sheets covering every page of the PDF (1..pdf.numPages).
// Returns an array of { contactSheet, includedPageNumbers, dataUrl }
// items, ready to feed into detectPages().
export async function buildDetectionContactSheets(pdf, opts = {}) {
  const total = pdf?.numPages || 0;
  if (total === 0) return [];
  const dpi = opts.dpi || DETECTION_DPI;
  const jpegQuality = opts.jpegQuality || DETECTION_JPEG_QUALITY;
  const pageNumbers = [];
  for (let p = 1; p <= total; p++) pageNumbers.push(p);
  const groups = chunkInto(pageNumbers, PAGES_PER_SHEET);
  const sheets = [];
  for (const g of groups) {
    const tilePages = g.map((n) => ({ pageNumber: n }));
    const composed = await composeContactSheetA4(pdf, tilePages, {
      dpi,
      labelPrefix: 'PDF page',
      // No "not student answer" suffix — these are blank PDF pages
      // for detection, no ink involved.
      labelSuffix: '',
      jpegQuality,
    });
    sheets.push({
      contactSheet: true,
      includedPageNumbers: composed.includedPageNumbers,
      dataUrl: composed.dataUrl,
      layout: composed.layout,
    });
  }
  return sheets;
}

// Run AI page detection on the loaded PDF and return:
//   { pages, costRecord, raw }
//
//   pages       — normalised page records:
//                   [{ page, type, confidence, reason, manually_edited:false }]
//                 Always covers 1..pdf.numPages, even when the model
//                 omits a page (filled in as type:'unknown', conf:0).
//   costRecord  — buildTaskRecord output; the caller stores it in the
//                 paper.setup_costs[] array (NOT in the marking
//                 report — detection is a setup cost, not a marking
//                 cost).
//   raw         — the raw parsed AI response (debug / "Show raw JSON").
export async function runPageDetection({
  pdf,
  apiKey, model, apiMode, proxyEndpoint, proxyToken, settings, signal,
}) {
  if (!pdf || !pdf.numPages) throw new Error('runPageDetection: PDF not loaded');
  if (!model) throw new Error('runPageDetection: model required');

  const sheets = await buildDetectionContactSheets(pdf);
  const result = await detectPages({
    apiKey, model, apiMode, proxyEndpoint, proxyToken, signal,
    pageImages: sheets,
  });

  const aiPages = Array.isArray(result?.parsed?.pages) ? result.parsed.pages : [];
  const byPage = new Map();
  for (const p of aiPages) {
    const num = Number(p.page);
    if (!Number.isFinite(num) || num < 1) continue;
    if (byPage.has(num)) continue; // first wins
    byPage.set(num, {
      page: num,
      type: typeof p.type === 'string' ? p.type : 'unknown',
      confidence: Number(p.confidence) || 0,
      reason: typeof p.reason === 'string' ? p.reason : '',
      manually_edited: false,
    });
  }
  // Fill gaps so the array is contiguous over [1..numPages].
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    if (byPage.has(n)) {
      pages.push(byPage.get(n));
    } else {
      pages.push({
        page: n,
        type: 'unknown',
        confidence: 0,
        reason: 'AI omitted this page from the response',
        manually_edited: false,
      });
    }
  }

  const costRecord = buildTaskRecord({
    task_type: TASK_TYPES.DETECTION,
    model,
    label: `Page detection — ${pdf.numPages} pages, ${sheets.length} contact sheet(s)`,
    pages: [],
    usage: result.usage,
    settings,
  });

  return { pages, costRecord, raw: result.parsed };
}

// Derive question/answer page-range arrays from a `pages` classification.
// Used to keep paper.question_pages / paper.answer_pages in sync with
// per-page edits in the confirmation UI.
export function rangesFromPages(pages) {
  const question_pages = [];
  const answer_pages = [];
  for (const p of (pages || [])) {
    if (p.type === 'question') question_pages.push(p.page);
    else if (p.type === 'answer_key') answer_pages.push(p.page);
  }
  return { question_pages, answer_pages };
}
