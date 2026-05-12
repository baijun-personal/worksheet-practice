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

// Page types where having a question is genuinely impossible —
// suppress markers even if a stray review record somehow anchors
// here (defensive against AI returning a coordinate on a clearly-
// unanswerable page).
//
// Earlier versions also suppressed 'passage', 'composition',
// 'instruction', 'section_divider', 'answer_key'. That was
// wrong: in primary-school comprehension layouts a 'passage'
// page very commonly hosts the questions BELOW the passage on
// the same page. Treating those records as fake silently
// dropped real review markers — Reviewer 2 caught this.
//
// Trimmed to types where a question record would itself be
// evidence of an extraction bug we want to surface elsewhere,
// not hide here. Composition / instruction / section-divider /
// answer-key pages can be reclassified manually if a stray
// marker shows up; that's a more honest failure mode than
// silently dropping markers the parent expects to see.
const NON_QUESTION_TYPES = new Set([
  'cover', 'blank',
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
// Decide whether a given page should host a list rail. Rules:
//  - If no paper profile, render the rail (no info to gate on).
//  - If page type is in NON_QUESTION_TYPES, skip.
//  - 'unknown' or 'question' → render.
function shouldRenderMarkersOnPage(paperProfile, pageNumber) {
  if (!paperProfile || !Array.isArray(paperProfile.pages)) return true;
  const entry = paperProfile.pages.find((p) => p.page === pageNumber);
  if (!entry) return true;
  return !NON_QUESTION_TYPES.has(entry.type);
}

// Public: render one page in the Review-mode UI. Replaces the host's
// page canvas with the COMPLETED page (PDF + saved strokes) and
// populates the side-rail list with one row per review_record
// anchored to this page.
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
//     listHost,               // <aside> element to populate with
//                             //   row buttons
//     onRowClick(record),     // called when a list row is tapped
//     hostWidth,              // CSS pixels for the rendered page
//     questions,              // OPTIONAL — report.questions (all rows,
//                             //   not just the wrong-answer review
//                             //   records). When provided, a per-page
//                             //   stats block is rendered above the
//                             //   list of wrong-answer rows showing
//                             //   "Page N: X/Y" for each page that
//                             //   contributed graded questions. Same
//                             //   block is shown on every page's rail
//                             //   so the student can see the whole-
//                             //   paper picture at a glance.
//   }
export async function renderReviewPage(ctx) {
  const {
    pdf, paperProfile, reviewRecords, pageNumber, strokes,
    canvas, listHost, onRowClick, hostWidth, questions,
  } = ctx;
  await renderToCanvas(pdf, pageNumber, canvas, hostWidth, strokes);
  if (listHost) listHost.innerHTML = '';

  // Page-type gate: cover / blank / etc. pages get no list, even
  // if a stray record somehow anchors there.
  if (!shouldRenderMarkersOnPage(paperProfile, pageNumber)) return;
  if (!listHost) return;

  // Per-page stats block — only rendered when the caller supplies
  // the full questions list AND there's at least one graded row.
  // Don't render on no-answer-key papers (every row would be
  // unclear; stats would be misleading).
  const stats = Array.isArray(questions) ? buildPageStats(questions) : [];
  // Show only THIS page's mark, not the whole-paper roll-up.
  const currentStat = stats.find((s) => Number(s.page) === Number(pageNumber));
  if (currentStat) {
    const wrap = document.createElement('div');
    wrap.className = 'page-stats-block';
    wrap.innerHTML = `
      <div class="page-stats-row">
        <div class="page-stats-pill current">
          <span class="page-stats-page">Page ${escapeHtml(currentStat.page)}</span>
          <span class="page-stats-score">Marks ${currentStat.correct}/${currentStat.total}</span>
        </div>
      </div>
    `;
    listHost.appendChild(wrap);
  }

  const rows = buildPageListRows(reviewRecords, pageNumber);
  for (const row of rows) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'review-list-row';
    el.innerHTML =
      `<span class="review-list-q">${escapeHtml(row.questionLabel)}</span>` +
      `<span class="review-list-ans">${escapeHtml(row.inline)}</span>`;
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onRowClick(row.record);
    });
    listHost.appendChild(el);
  }
}

// Build the side-rail list of review rows for the page currently
// being shown. Each row carries the original record plus a short
// label for the question and the inline preview text.
//
// `inline` is short_display_answer when it fits inline; otherwise
// 'Tap'. Multi-part rows always read 'Tap' because they have
// multiple correct answers that can't be previewed in one row.
//
// Rows arrive in question-number order so the list reads
// top-to-bottom like the page does.
export function buildPageListRows(reviewRecords, pageNumber) {
  const onThisPage = (reviewRecords || []).filter((r) =>
    Number(r.question_page) === Number(pageNumber)
  );
  onThisPage.sort((a, b) => qnPrefix(a.question) - qnPrefix(b.question));
  return onThisPage.map((r) => ({
    record: r,
    questionLabel: shortQLabel(r.question),
    inline: inlinePreview(r),
  }));
}

// Build per-page correct/total stats from report.questions. Returns an
// array sorted by page number:
//   [{ page: 1, correct: 5, total: 8 }, { page: 2, correct: 4, total: 6 }, ...]
//
// Grouping key is `completed_page` (the page the student wrote on),
// not `question_page` — the latter is used elsewhere for review-rail
// anchoring inside the popup. completed_page is the field populated on
// every report row.
//
// Unanswered rows are excluded from the denominator: they aren't a
// failed attempt, just a skip. Visual-comparison rows are included
// (they're graded the same way as text rows).
export function buildPageStats(questions) {
  const byPage = new Map();
  for (const q of (questions || [])) {
    const pg = q.completed_page;
    if (pg == null) continue;
    if (q.status === 'unanswered') continue;
    const cur = byPage.get(pg) || { correct: 0, total: 0 };
    cur.total += 1;
    if (q.status === 'correct') cur.correct += 1;
    byPage.set(pg, cur);
  }
  return [...byPage.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([page, { correct, total }]) => ({ page, correct, total }));
}

// Shrink a raw question label to "Q<num>[a-z]" form for the rail.
// Examples:
//   "Section A: Grammar Multiple Choice Q1" → "Q1"
//   "Q19(i)" → "Q19"   (multi-part collapses to base)
//   "Q5a"    → "Q5a"
//   "5a"     → "Q5a"
//   "5"      → "Q5"
function shortQLabel(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/Q\s*(\d+[a-z]?)/i) || s.match(/^(\d+[a-z]?)/);
  return m ? `Q${m[1]}` : s;
}

// Inline-preview rule: keep it strict — answer must be non-empty,
// ≤5 chars, and contain no whitespace. The smaller rail buttons
// don't have room for longer text without wrapping; anything past
// the threshold collapses to "Tap" so the row stays compact and
// the popup carries the full expected answer.
function inlinePreview(record) {
  if (Array.isArray(record.parts) && record.parts.length > 0) return 'Tap';
  const ans = String(record.short_display_answer || '').trim();
  if (!ans || ans.length > 5 || /\s/.test(ans)) return 'Tap';
  return ans;
}

function qnPrefix(raw) {
  const m = String(raw || '').match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

// (Earlier versions had isDebugMode() + formatMarkerLabel() here
// to feed the on-page ✗ overlay. Both are gone — the side-rail
// list doesn't need a per-marker debug tag or a 24-char label
// cap. shortQLabel + inlinePreview above cover their roles.)

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Build the per-page navigable list of pages that have at least
// one review record. Reads the simplified question_page field
// (just a number; the prior {page, x, y, source} shape is gone).
export function pagesWithReviews(reviewRecords) {
  const pages = new Set();
  for (const r of reviewRecords || []) {
    const pg = Number(r.question_page);
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
  // record.question carries the already-display-ready label
  // (e.g. "Section A: Grammar Multiple Choice Q1" or just "Q19"
  // or, in single-section papers, "5"). The previous code
  // prepended "Q" whenever the label didn't start with Q, which
  // produced "QSection A:..." on section-prefixed labels —
  // visible bug. Use the label as-is. For the bare-number
  // case ("5" → "Q5"), prepend ONLY when the label is purely
  // a number / number-with-trailing-letter (5, 5a) and has no
  // section colon.
  const baseLabel = qNumPrefixedLabel(record.question);
  if (Array.isArray(record.parts) && record.parts.length > 0) {
    return `${baseLabel} — ${record.parts.length} part${record.parts.length === 1 ? '' : 's'} to review`;
  }
  return baseLabel;
}

// Add a "Q" prefix only when the label is clearly a bare
// question number (digits, optionally followed by a letter or
// roman-numeral suffix) AND doesn't already start with Q AND
// doesn't carry a section colon. Section-prefixed and Q-prefixed
// labels pass through unchanged.
function qNumPrefixedLabel(raw) {
  const lbl = String(raw || '').trim();
  if (!lbl) return '';
  if (/^Q/i.test(lbl)) return lbl;
  if (/:/.test(lbl)) return lbl;
  // Bare numeric form like "5", "12a", "19(i)"
  if (/^\d+[a-z]?(\([ivx]+\))?$/i.test(lbl)) return `Q${lbl}`;
  return lbl;
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
  // Same label-rendering rule as popupTitle — don't blindly
  // prepend Q to section-prefixed labels.
  const names = flagged.map((r) => escapeHtml(qNumPrefixedLabel(r.question))).join(', ');
  return `<strong>${names}</strong> ${flagged.length === 1 ? 'was' : 'were'} marked with lower confidence. ` +
    `Tap each to verify before relying on the score.`;
}
