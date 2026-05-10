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
import { drawStroke } from './draw.js';

const NON_QUESTION_TYPES = new Set([
  'passage', 'composition', 'cover', 'instruction',
  'section_divider', 'blank', 'answer_key',
]);

// Render the given PDF page into the supplied canvas at a width
// matching the host element, then draw any saved strokes on top so
// the parent sees the COMPLETED page — not the clean blank
// worksheet. Reviewer-2 flagged the previous behaviour (clean PDF
// only) as a blocker: the X marker was floating next to a blank
// answer slot, which defeated the whole purpose of the review.
async function renderToCanvas(pdf, pageNumber, canvas, hostWidth, strokes) {
  const dpi = Math.min(180, Math.max(96, hostWidth * 0.13));
  const r = await renderPageOffscreen(pdf, pageNumber, dpi);
  // Draw the strokes (if any) directly onto r.ctx — same path used
  // by flattenQuestionPage at submission time, so the visual result
  // matches what was sent to OpenAI for marking.
  if (Array.isArray(strokes) && strokes.length > 0) {
    const size = {
      pageWidthPts: r.pageWidthPts,
      pageHeightPts: r.pageHeightPts,
      widthPx: r.widthPx,
      heightPx: r.heightPx,
    };
    for (const s of strokes) drawStroke(r.ctx, s, size);
  }
  // Copy onto the visible canvas
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
// records share one marker. compare.js already collapses parts of
// the same printed question into one record (record.parts[]), so
// in normal cases this is one-record-one-marker. The grouping is
// defensive against:
//   - distinct base questions that happen to land at the same y
//     (e.g. two-column layouts where Q3 and Q9 sit at the same
//     vertical line) — group must NOT merge them
//   - upstream regressions that ever produce two review records
//     for the same base question on the same page
//
// Rule: group ONLY when both the page AND the canonical base
// question label match. y-tolerance is no longer used as a merge
// criterion. Reviewer-2 flagged this: y-only grouping silently
// merges unrelated questions in two-column layouts.
function groupReviewRecords(records) {
  const groups = new Map(); // key = `${page}::${baseQuestion}`
  const order = [];
  for (const rec of records) {
    const loc = rec.question_start_location;
    if (!loc) continue;
    const baseKey = canonicalBaseQuestion(rec.question);
    const groupKey = `${loc.page}::${baseKey}`;
    if (groups.has(groupKey)) {
      groups.get(groupKey).records.push(rec);
    } else {
      const g = { page: loc.page, x: loc.x, y: loc.y, records: [rec] };
      groups.set(groupKey, g);
      order.push(g);
    }
  }
  return order;
}

// Drop any printed-subpart suffix (Q19(i) → Q19, "5a" → "5a") and
// normalise to lowercase for matching. We don't drop alphabetic
// subpart letters because Q5a and Q5b ARE distinct printed
// questions on the worksheet — they should each get their own
// marker. Only the "(...)" subpart from list-answer questions
// collapses here.
function canonicalBaseQuestion(label) {
  return String(label || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .toLowerCase();
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
// page canvas with the COMPLETED page (PDF + saved strokes) and the
// marker layer with the markers for any review_records anchored to
// this page.
//
//   ctx = {
//     pdf,                    // pdf.js doc
//     paperProfile,           // optional, for page-type gating
//     reviewRecords,          // array from report.review_records
//     pageNumber,             // 1-based
//     strokes,                // array of saved strokes for this
//                             //   page (caller fetches via
//                             //   getStrokesForPage); empty array
//                             //   if no ink — page renders clean
//     canvas,                 // <canvas> for the page render
//     markerLayer,            // <div> overlay for markers
//     onMarkerClick(record),  // called when a marker is tapped
//     hostWidth,              // CSS pixels for the rendered page
//   }
export async function renderReviewPage(ctx) {
  const {
    pdf, paperProfile, reviewRecords, pageNumber, strokes,
    canvas, markerLayer, onMarkerClick, hostWidth,
  } = ctx;
  await renderToCanvas(pdf, pageNumber, canvas, hostWidth, strokes);
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
    // Unclear and incorrect both render as red ✗ per the agreed
    // decision: a confusing answer is usually wrong; the parent
    // sees one consistent "needs attention" cue and the
    // low-confidence summary alert at the top names which were
    // borderline. Earlier amber-for-unclear styling is gone.
    marker.className = 'review-marker';
    marker.style.left = (g.x * 100).toFixed(3) + '%';
    marker.style.top  = (g.y * 100).toFixed(3) + '%';

    // The label is built from the FIRST record in the group.
    // Multi-part: short_display_answer is the row-level answer; the
    // popup unpacks parts. Single-part: same.
    const first = g.records[0];
    const labelText = formatMarkerLabel(first);
    // Debug toggle: when ?debug=1 is in the URL, append the
    // coordinate source so we can see at a glance how often
    // markers come from the AI vs the ordinal fallback. Useful
    // for the Phase 1 gate decision the original plan called for.
    const debug = isDebugMode();
    const sourceTag = debug
      ? ` (${first.question_start_location?.source || '?'})`
      : '';
    marker.innerHTML =
      `<span class="review-marker-x">✗</span>` +
      `<span class="review-marker-label">${escapeHtml(labelText)}${escapeHtml(sourceTag)}</span>`;
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
// shows a generic "Click to view answer" instead so the parent
// doesn't see a half-truncated answer that misleads.
//
// Both incorrect and unclear records use the same "Correct: <X>"
// preview — the agreed treatment is that unclear is shown as
// wrong (one consistent red ✗ + same label format), with the
// low-confidence summary alert at the top of the stage naming
// which questions were borderline.
function formatMarkerLabel(record) {
  const FALLBACK = 'Click to view answer';
  const CAP = 24;
  const ans = String(record.short_display_answer || '').trim();
  if (!ans) return FALLBACK;
  const candidate = 'Correct: ' + ans;
  if (candidate.length <= CAP) return candidate;
  return FALLBACK;
}

// Debug mode: enabled via ?debug=1 in the URL. Used by Review
// Mode to surface coordinate-source provenance on every marker
// label, so a developer can run the marking pipeline on real
// papers and see how many markers came from the AI vs from the
// ordinal fallback. (The Phase 1 gate from the plan was supposed
// to give this answer; the toggle gives it after the fact.)
function isDebugMode() {
  try {
    return new URL(window.location.href).searchParams.get('debug') === '1';
  } catch { return false; }
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
//
// Both paths hide the "Correct:" row when there's no expected
// answer to show (rather than rendering "Correct: —" or
// "Correct: (see comment)" as the previous version did).
export function popupBodyHtml(record) {
  if (!record) return '';
  // Also a defensive scrub — if upstream ever leaks the literal
  // '(see comment)' marker, treat it as empty here too.
  const visibleAnswer = (s) => {
    const v = String(s || '').trim();
    if (!v || v === '(see comment)') return '';
    return v;
  };
  if (Array.isArray(record.parts) && record.parts.length > 0) {
    const partsHtml = record.parts.map((p) => {
      const expected = visibleAnswer(p.matched_expected);
      const correctRow = expected
        ? `<div class="rp-row"><span class="rp-label">Correct:</span><span class="rp-correct">${escapeHtml(expected)}</span></div>`
        : '';
      return `
        <div class="rp-part">
          <div class="rp-part-label">Part (${escapeHtml(p.part)}) — ${
            p.status === 'incorrect'
              ? '<span class="rp-wrong">incorrect</span>'
              : '<span class="rp-wrong">unclear</span>'
          }</div>
          <div class="rp-row"><span class="rp-label">Student:</span>${escapeHtml(p.student_answer || '(blank)')}</div>
          ${correctRow}
          ${p.comment ? `<div class="rp-row"><span class="rp-label">Why:</span>${escapeHtml(p.comment)}</div>` : ''}
        </div>
      `;
    }).join('');
    return `
      ${record.short_reason ? `<div class="rp-row"><span class="rp-label">Reason:</span>${escapeHtml(record.short_reason)}</div>` : ''}
      ${partsHtml}
    `;
  }
  const expected = visibleAnswer(record.expected_answer) || visibleAnswer(record.short_display_answer);
  const correctRow = expected
    ? `<div class="rp-row"><span class="rp-label">Correct:</span><span class="rp-correct">${escapeHtml(expected)}</span></div>`
    : '';
  return `
    <div class="rp-row"><span class="rp-label">Student:</span>${escapeHtml(record.student_answer || '(blank)')}</div>
    ${correctRow}
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
//
// HTML-escape labels: r.question is AI-extracted from a PDF, so a
// hostile or weirdly-shaped value (`<img onerror=…>`) would
// otherwise execute when innerHTML'd. Practical exploitability is
// near zero for primary-school worksheets, but the escape is one
// line and matches the rest of the file's hygiene.
export function lowConfidenceBannerHtml(reviewRecords) {
  const flagged = (reviewRecords || []).filter((r) => r.needs_human_review);
  if (flagged.length === 0) return '';
  const names = flagged.map((r) => {
    const lbl = /^Q/i.test(r.question) ? r.question : `Q${r.question}`;
    return escapeHtml(lbl);
  }).join(', ');
  return `<strong>${names}</strong> ${flagged.length === 1 ? 'was' : 'were'} marked with lower confidence. ` +
    `Tap each to verify before relying on the score.`;
}
