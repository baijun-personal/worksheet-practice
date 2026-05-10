// Review Mode — render question pages with red X markers next to
// every wrong / unclear question, plus a popup that explains what
// went wrong (Phase 3+) and optionally calls the AI for an
// explanation (Phase 4+).
//
// This module is the rendering layer. The data layer is
// `report.review_records` (built in compare.js) — one record per
// printed question to review. Coordinates inside each record are
// pre-validated; the renderer just maps (x, y) to pixel positions
// on the rendered page.
//
// Page-classification gating: when a paper profile is available
// and a page is typed as one of the non-question types
// (passage/composition/cover/instruction/section_divider/
// blank/answer_key), no markers are rendered on that page.
// 'unknown' or no-profile cases render markers normally.

import { renderPageOffscreen } from './pdfRender.js';

const NON_QUESTION_TYPES = new Set([
  'passage', 'composition', 'cover', 'instruction',
  'section_divider', 'blank', 'answer_key',
]);

// Render the given PDF page into the supplied canvas at a width
// matching the host element. Resolves with the rendered viewport size
// (PDF points).
async function renderToCanvas(pdf, pageNumber, canvas, hostWidth) {
  const dpi = Math.min(180, Math.max(96, hostWidth * 0.13));
  const r = await renderPageOffscreen(pdf, pageNumber, dpi);
  // Copy r.canvas onto our visible canvas
  canvas.width = r.canvas.width;
  canvas.height = r.canvas.height;
  canvas.style.width = `${hostWidth}px`;
  canvas.style.height = `${(r.canvas.height / r.canvas.width) * hostWidth}px`;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(r.canvas, 0, 0);
  return r;
}

// Group review records by `(page, base question)` so multi-part
// records share one marker. The records produced by compare.js are
// already one-per-base-question (parts are inside record.parts),
// so this is mostly a passthrough — we ALSO collapse near-duplicate
// y-positions on the same page within a 2% tolerance, just in case
// future changes ever produce two records for the same anchor.
function groupReviewRecords(records) {
  const groups = [];
  for (const rec of records) {
    const loc = rec.question_start_location;
    if (!loc) continue;
    const yTol = 0.02;
    const existing = groups.find((g) =>
      g.page === loc.page &&
      Math.abs(g.y - loc.y) <= yTol
    );
    if (existing) {
      existing.records.push(rec);
    } else {
      groups.push({
        page: loc.page,
        x: loc.x,
        y: loc.y,
        records: [rec],
      });
    }
  }
  return groups;
}

// Decide whether a given page should host markers. Rules:
//  - If no paper profile, render markers (no info to gate on).
//  - If page type is in NON_QUESTION_TYPES, skip.
//  - 'unknown' or 'question' → render.
function shouldRenderMarkersOnPage(paperProfile, pageNumber) {
  if (!paperProfile || !Array.isArray(paperProfile.pages)) return true;
  const entry = paperProfile.pages.find((p) => p.page === pageNumber);
  if (!entry) return true;
  return !NON_QUESTION_TYPES.has(entry.type);
}

// Public: render one page in the Review-mode UI. Replaces the host's
// page canvas with this page and the marker layer with the markers
// for any review_records anchored to this page.
//
//   ctx = {
//     pdf,                    // pdf.js doc
//     paperProfile,           // optional, for page-type gating
//     reviewRecords,          // array from report.review_records
//     pageNumber,             // 1-based
//     canvas,                 // <canvas> for the page render
//     markerLayer,            // <div> overlay for markers
//     onMarkerClick(record),  // called when a marker is tapped
//     hostWidth,              // CSS pixels for the rendered page
//   }
export async function renderReviewPage(ctx) {
  const {
    pdf, paperProfile, reviewRecords, pageNumber,
    canvas, markerLayer, onMarkerClick, hostWidth,
  } = ctx;
  await renderToCanvas(pdf, pageNumber, canvas, hostWidth);
  markerLayer.innerHTML = '';
  if (!shouldRenderMarkersOnPage(paperProfile, pageNumber)) return;

  // Records anchored to this page only.
  const onThisPage = (reviewRecords || []).filter((r) => {
    const loc = r.question_start_location;
    return loc && loc.page === pageNumber;
  });
  const groups = groupReviewRecords(onThisPage);

  for (const g of groups) {
    const marker = document.createElement('div');
    const isUnclear = g.records.every((r) => r.status === 'unclear');
    marker.className = 'review-marker' + (isUnclear ? ' unclear' : '');
    marker.style.left = (g.x * 100).toFixed(3) + '%';
    marker.style.top  = (g.y * 100).toFixed(3) + '%';

    // The label is built from the FIRST record in the group.
    // Multi-part: short_display_answer is the row-level answer; the
    // popup unpacks parts. Single-part: same.
    const first = g.records[0];
    const labelText = formatMarkerLabel(first);
    marker.innerHTML =
      `<span class="review-marker-x">✗</span>` +
      `<span class="review-marker-label">${escapeHtml(labelText)}</span>`;
    marker.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onMarkerClick(first, g.records);
    });
    markerLayer.appendChild(marker);
  }
}

// Build the inline marker label. Caps to 24 characters total
// including the "Correct: " prefix; if the cap would truncate,
// shows a generic "✗ Click to view answer" instead so the parent
// doesn't see a half-truncated answer that misleads.
function formatMarkerLabel(record) {
  const FALLBACK = 'Click to view answer';
  const CAP = 24;
  const ans = String(record.short_display_answer || '').trim();
  if (!ans) return FALLBACK;
  const prefix = record.status === 'unclear' ? 'Unclear: ' : 'Correct: ';
  const candidate = prefix + ans;
  if (candidate.length <= CAP) return candidate;
  return FALLBACK;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Build the per-page navigable list of pages that have at least one
// review record. Pages with markers gated off (non-question types)
// are still navigable — the parent might want to flip past them.
// MVP: include every page from question_start_location, sorted.
export function pagesWithReviews(reviewRecords) {
  const pages = new Set();
  for (const r of reviewRecords || []) {
    const pg = r.question_start_location?.page;
    if (Number.isFinite(pg)) pages.add(pg);
  }
  return [...pages].sort((a, b) => a - b);
}

// Walk records in document order. Returns {idx, total, prev, next}
// where prev/next are the records on the wrap-around boundaries.
export function recordIndex(reviewRecords, target) {
  const recs = reviewRecords || [];
  const idx = recs.findIndex((r) =>
    r === target || (r.question === target.question && r.completed_page === target.completed_page)
  );
  if (idx === -1) return { idx: -1, total: recs.length, prev: null, next: null };
  return {
    idx,
    total: recs.length,
    prev: recs[(idx - 1 + recs.length) % recs.length] || null,
    next: recs[(idx + 1) % recs.length] || null,
  };
}

// Build the popup body HTML for a single review record. Multi-part
// records get one .rp-part block per wrong subpart; flat records
// get a simpler student-vs-correct two-row layout.
export function popupBodyHtml(record) {
  if (!record) return '';
  if (Array.isArray(record.parts) && record.parts.length > 0) {
    const partsHtml = record.parts.map((p) => `
      <div class="rp-part">
        <div class="rp-part-label">Part (${escapeHtml(p.part)}) — ${
          p.status === 'incorrect'
            ? '<span class="rp-wrong">incorrect</span>'
            : '<span class="rp-wrong">unclear</span>'
        }</div>
        <div class="rp-row"><span class="rp-label">Student:</span>${escapeHtml(p.student_answer || '(blank)')}</div>
        <div class="rp-row"><span class="rp-label">Correct:</span><span class="rp-correct">${escapeHtml(p.matched_expected || '—')}</span></div>
        ${p.comment ? `<div class="rp-row"><span class="rp-label">Why:</span>${escapeHtml(p.comment)}</div>` : ''}
      </div>
    `).join('');
    return `
      <div class="rp-row"><span class="rp-label">Reason:</span>${escapeHtml(record.short_reason || '')}</div>
      ${partsHtml}
    `;
  }
  return `
    <div class="rp-row"><span class="rp-label">Student:</span>${escapeHtml(record.student_answer || '(blank)')}</div>
    <div class="rp-row"><span class="rp-label">Correct:</span><span class="rp-correct">${escapeHtml(record.expected_answer || record.short_display_answer || '—')}</span></div>
    <div class="rp-row"><span class="rp-label">Why:</span>${escapeHtml(record.short_reason || record.comment || '')}</div>
  `;
}

export function popupTitle(record) {
  if (!record) return 'Review';
  const baseLabel = /^Q/i.test(record.question) ? record.question : `Q${record.question}`;
  if (Array.isArray(record.parts) && record.parts.length > 0) {
    return `${baseLabel} — ${record.parts.length} part${record.parts.length === 1 ? '' : 's'} to review`;
  }
  return baseLabel;
}

// Build the inline low-confidence summary banner — used by Review
// stage above the page render. Names every record where
// needs_human_review is set.
export function lowConfidenceBannerHtml(reviewRecords) {
  const flagged = (reviewRecords || []).filter((r) => r.needs_human_review);
  if (flagged.length === 0) return '';
  const names = flagged.map((r) => {
    const lbl = /^Q/i.test(r.question) ? r.question : `Q${r.question}`;
    return lbl;
  }).join(', ');
  return `<strong>${names}</strong> ${flagged.length === 1 ? 'was' : 'were'} marked with lower confidence. ` +
    `Tap each to verify before relying on the score.`;
}
