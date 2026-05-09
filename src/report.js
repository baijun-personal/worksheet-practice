// Render the merged marking JSON into a parent-friendly UI, and export it
// as a PDF using pdf-lib loaded from CDN.

import { KNOWN_STATUSES } from './openai.js';

export function renderReport(report, mountNodes) {
  const {
    summaryEl, costEl, wrongEl, uncertainEl, weakEl, redoEl, tableEl, rawEl,
  } = mountNodes;

  const summary = report.summary || {};
  const warnings = report.app_warnings || null;
  summaryEl.innerHTML = `
    ${warnings ? renderWarningBanner(warnings) : ''}
    <h2>Summary</h2>
    <p><strong>Estimated score:</strong> ${escapeHtml(summary.estimated_score || '—')}</p>
    <p>${escapeHtml(summary.comment || '')}</p>
  `;

  if (costEl) {
    costEl.innerHTML = report.app_usage ? renderCostCard(report.app_usage) : '';
    costEl.style.display = report.app_usage ? '' : 'none';
  }

  const results = Array.isArray(report.questions) ? report.questions : [];

  const wrong = results.filter(isWrong);
  wrongEl.innerHTML = `<h2>Incorrect (${wrong.length})</h2>` +
    (wrong.length === 0 ? '<p class="muted">None.</p>' : `<ul>${wrong.map(qBullet).join('')}</ul>`);

  const uncertain = results.filter(isUncertain);
  uncertainEl.innerHTML = `<h2>Unclear (${uncertain.length})</h2>` +
    (uncertain.length === 0 ? '<p class="muted">None.</p>' : `<ul>${uncertain.map(qBullet).join('')}</ul>`);

  const weak = Array.isArray(report.weak_points) ? report.weak_points : [];
  // Hide the weak-points card entirely when there's nothing specific to say,
  // rather than printing a generic "no clear pattern" line.
  if (weak.length === 0) {
    weakEl.innerHTML = '';
    weakEl.style.display = 'none';
  } else {
    weakEl.style.display = '';
    weakEl.innerHTML = `<h2>Weak points</h2>` +
      `<ul>${weak.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
  }

  const redo = Array.isArray(report.redo) ? report.redo : [];
  redoEl.innerHTML = `<h2>Suggested redo</h2>` +
    (redo.length === 0 ? '<p class="muted">None.</p>' :
      `<p>${redo.map(escapeHtml).join(', ')}</p>`);

  // Only show the section column when at least one row actually has a section.
  const showSection = results.some((r) => r.section);
  tableEl.innerHTML = `<h2>All questions (${results.length})</h2>` +
    `<table><thead><tr>
        <th>Q</th>${showSection ? '<th>Section</th>' : ''}<th>Status</th><th>Student</th><th>Expected</th><th>Pages</th><th>Comment</th>
      </tr></thead><tbody>${
      results.map((r) => `<tr>
        <td>${escapeHtml(questionLabel(r))}</td>
        ${showSection ? `<td>${escapeHtml(r.section || '')}</td>` : ''}
        <td>${statusTag(r.status)}</td>
        <td>${escapeHtml(r.student_answer || '')}</td>
        <td>${escapeHtml(r.expected_answer || '')}</td>
        <td>${formatPageRefs(r)}</td>
        <td>${escapeHtml(r.comment || '')}</td>
      </tr>`).join('')
    }</tbody></table>`;

  rawEl.textContent = JSON.stringify(report, null, 2);
}

// Build a safe display label for a question. Prefers the AI-extracted
// display_question; otherwise composes one from section + question_number,
// adding a "Q" prefix only when the value doesn't already start with one
// (fixes the "QQ1" UI bug where the renderer was double-prefixing).
function questionLabel(r) {
  if (r.display_question) return String(r.display_question);
  const q = r.question != null ? String(r.question) : '';
  const sec = r.section ? String(r.section) : '';
  const qDisplay = q
    ? (/^Q/i.test(q) ? q : `Q${q}`)
    : '';
  if (sec && qDisplay) return `${sec} ${qDisplay}`;
  return qDisplay || sec || '';
}

function renderCostCard(u) {
  const t = u.totals || {};
  const fmtTokens = (n) => Number(n || 0).toLocaleString();
  const fmtUsd = (n) => '$' + (Number(n) || 0).toFixed(4);
  const fmtRate = (n) => '$' + (Number(n) || 0).toFixed(3);
  const batchRows = (u.batches || []).map((b) => {
    const cached = Number(b.usage?.prompt_tokens_details?.cached_tokens) || 0;
    const prompt = Number(b.usage?.prompt_tokens) || 0;
    const uncached = Math.max(0, prompt - cached);
    return `
    <tr>
      <td>${escapeHtml(b.index + 1)}</td>
      <td>${escapeHtml((b.pages || []).join(', '))}</td>
      <td>${fmtTokens(uncached)}</td>
      <td>${fmtTokens(cached)}</td>
      <td>${fmtTokens(b.usage?.completion_tokens)}</td>
      <td>${fmtTokens(b.usage?.total_tokens)}</td>
    </tr>`;
  }).join('');
  return `
    <h2>Cost &amp; usage <span class="muted small">(estimate)</span></h2>
    <p><strong>Estimated total: ${fmtUsd(u.estimated_cost_usd)}</strong>
       <span class="muted small">
         (input ${fmtUsd(u.estimated_input_cost_usd)}
         = uncached ${fmtUsd(u.estimated_uncached_input_cost_usd)}
         + cached ${fmtUsd(u.estimated_cached_input_cost_usd)};
         output ${fmtUsd(u.estimated_output_cost_usd)})
       </span></p>
    <p class="muted small">
      Model: ${escapeHtml(u.model || '—')} —
      rates used: input ${fmtRate(u.price_in_per_m_tokens)}/1M,
      cached input ${fmtRate(u.price_cached_in_per_m_tokens)}/1M,
      output ${fmtRate(u.price_out_per_m_tokens)}/1M.
      Verify against <a href="https://openai.com/api/pricing/" target="_blank" rel="noopener">openai.com/api/pricing</a>.
      The authoritative cost is on the OpenAI dashboard.
    </p>
    <p class="muted small">
      Total tokens: input ${fmtTokens(t.prompt_tokens)}
      (of which cached ${fmtTokens(t.cached_input_tokens)}) +
      output ${fmtTokens(t.completion_tokens)} =
      ${fmtTokens(t.total_tokens)}.
    </p>
    <details>
      <summary class="muted small">Per-batch breakdown</summary>
      <table style="margin-top:8px"><thead><tr>
        <th>Batch</th><th>Pages</th><th>Uncached in</th><th>Cached in</th><th>Output</th><th>Total</th>
      </tr></thead><tbody>${batchRows}</tbody></table>
    </details>`;
}

function renderWarningBanner(w) {
  const lines = [];
  if (w.stopped_by_user) {
    lines.push(`Marking was stopped after batch ${w.batches_completed} of ${w.batches_total}. ${w.stopped_skipped_count} batch(es) were skipped.`);
  }
  if (Array.isArray(w.failed_batches) && w.failed_batches.length > 0) {
    const failed = w.failed_batches
      .map((b) => `batch ${b.index + 1} (pages ${b.pages.join(', ')})`)
      .join(', ');
    lines.push(`Failed and skipped: ${failed}.`);
  }
  lines.push(`This report is incomplete: only ${w.batches_completed} of ${w.batches_total} batches were marked.`);
  return `<div class="warning" style="margin-bottom:12px">
    <strong>Warning:</strong> ${lines.map(escapeHtml).join(' ')}
  </div>`;
}

function formatPageRefs(r) {
  const a = r.completed_page;
  const b = r.answer_page;
  const hasA = a != null && a !== 0 && a !== '';
  const hasB = b != null && b !== 0 && b !== '';
  if (!hasA && !hasB) return '<span class="muted">—</span>';
  const aStr = hasA ? `completed p.${escapeHtml(a)}` : '';
  const bStr = hasB ? `answer p.${escapeHtml(b)}` : '';
  return [aStr, bStr].filter(Boolean).join('<br>');
}

function isWrong(r)     { return r.status === 'incorrect'; }
function isUncertain(r) { return r.status === 'unclear'; }

function qBullet(r) {
  const pageBits = [];
  if (r.completed_page) pageBits.push(`completed p.${r.completed_page}`);
  if (r.answer_page)    pageBits.push(`answer p.${r.answer_page}`);
  const pageStr = pageBits.length ? ` <span class="muted small">[${escapeHtml(pageBits.join(', '))}]</span>` : '';
  return `<li>
    <strong>${escapeHtml(questionLabel(r))}</strong>
    ${statusTag(r.status)}${pageStr}
    — student: <em>${escapeHtml(r.student_answer || '')}</em>,
    expected: <em>${escapeHtml(r.expected_answer || '')}</em>
    ${r.comment ? `<div class="muted small">${escapeHtml(r.comment)}</div>` : ''}
  </li>`;
}

function statusTag(status) {
  const known = KNOWN_STATUSES.includes(status);
  let cls = 'unsure';
  if (status === 'correct') cls = 'correct';
  else if (status === 'incorrect') cls = 'wrong';
  else if (status === 'unclear') cls = 'review';
  const label = status || 'unknown';
  return `<span class="tag ${cls}" title="${known ? '' : 'Unrecognized status'}">${escapeHtml(label)}</span>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- PDF export -----------------------------------------------------------

let pdfLibPromise = null;
async function getPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm');
  }
  return pdfLibPromise;
}

let html2canvasPromise = null;
async function getHtml2Canvas() {
  if (!html2canvasPromise) {
    html2canvasPromise = import('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/+esm')
      .then((m) => m.default || m);
  }
  return html2canvasPromise;
}

// Build the report PDF by rasterising the on-screen report DOM via
// html2canvas, then assembling those bitmaps as US Letter pages with pdf-lib.
//
// Why image-based instead of text? pdf-lib + standard fonts only encode
// WinAnsi (Windows-1252), so Chinese (and any other non-Latin script) can't
// be rendered as text. We tried embedding a CJK Unicode font via fontkit
// + Noto Sans SC, but the resulting PDFs failed to render correctly across
// readers (FreeType-based viewers including iPadOS / MuPDF rejected the
// embedded CFF font). Rasterising the DOM sidesteps font embedding entirely:
// the browser already renders the on-screen report in any language, so the
// PDF inherits that rendering. Trade-off: PDF is not text-searchable, but
// the on-screen report and raw-JSON download cover that need.
export async function exportReportPdf(report, meta) {
  const { PDFDocument } = await getPdfLib();
  const html2canvas = await getHtml2Canvas();

  // Build a clean off-screen DOM that mirrors the visible report cards.
  // We clone the live #stage-report cards so the PDF reflects exactly what
  // the parent saw on screen, including the warning banner and cost card.
  const reportStage = document.getElementById('stage-report');
  if (!reportStage) {
    throw new Error('Report stage not found in DOM; export needs the on-screen report');
  }

  const printRoot = document.createElement('div');
  printRoot.style.cssText = [
    'position:fixed',
    'left:-99999px',
    'top:0',
    'width:780px',
    'padding:32px',
    'background:#ffffff',
    'color:#14181f',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    'font-size:14px',
    'line-height:1.45',
    'z-index:-1',
  ].join(';');

  // Title block at the top of the PDF
  const title = document.createElement('div');
  title.innerHTML = `
    <h1 style="margin:0 0 4px;font-size:22px;">Worksheet Marking Report</h1>
    <div style="color:#5b6573;font-size:12px;">PDF: ${escapeHtml(meta?.pdfName || '')}</div>
    <div style="color:#5b6573;font-size:12px;margin-bottom:16px;">Generated: ${escapeHtml(new Date().toLocaleString())}</div>
  `;
  printRoot.appendChild(title);

  // Clone each non-empty card from the live report. Drop any interactive
  // elements (buttons, action rows) so the print copy is purely informational.
  for (const card of reportStage.querySelectorAll('.card')) {
    if (!card.textContent.trim()) continue;
    const clone = card.cloneNode(true);
    clone.querySelectorAll('button, .actions, summary').forEach((el) => el.remove());
    // Expand any <details> so all per-batch breakdowns end up in the PDF.
    clone.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));
    // Re-apply card styling inline so html2canvas captures it without
    // depending on the page's stylesheet linkage timing.
    clone.style.cssText = [
      'background:#ffffff',
      'border:1px solid #d8dde5',
      'border-radius:8px',
      'padding:16px',
      'margin-bottom:12px',
      'box-shadow:0 1px 2px rgba(0,0,0,0.06)',
    ].join(';');
    printRoot.appendChild(clone);
  }

  document.body.appendChild(printRoot);

  let canvas;
  try {
    canvas = await html2canvas(printRoot, {
      scale: 2,
      backgroundColor: '#ffffff',
      logging: false,
      useCORS: true,
    });
  } finally {
    document.body.removeChild(printRoot);
  }

  // Slice the tall canvas into US Letter (612 × 792 pt) pages.
  const doc = await PDFDocument.create();
  const pageWidthPt = 612;
  const pageHeightPt = 792;
  const margin = 24;
  const drawableWidthPt = pageWidthPt - margin * 2;
  // ptPerPx scales canvas pixel rows to PDF points so the canvas's pixel
  // width fits drawableWidthPt.
  const ptPerPx = drawableWidthPt / canvas.width;
  const sliceHeightPx = Math.max(1, Math.floor((pageHeightPt - margin * 2) / ptPerPx));

  let yPx = 0;
  while (yPx < canvas.height) {
    const h = Math.min(sliceHeightPx, canvas.height - yPx);
    // Skip trailing slices that are basically just margin/whitespace —
    // protects against an off-by-one tail page when the canvas height
    // doesn't divide evenly into page-sized slices.
    if (h < 40 && yPx > 0) break;
    const slice = document.createElement('canvas');
    slice.width = canvas.width;
    slice.height = h;
    const sctx = slice.getContext('2d');
    sctx.fillStyle = '#ffffff';
    sctx.fillRect(0, 0, slice.width, slice.height);
    sctx.drawImage(canvas, 0, -yPx);
    // Skip pages that came out essentially all-white (sample a grid of
    // pixels; any non-white triggers keep). This catches the case where
    // tall white margins pushed past the previous page.
    if (yPx > 0 && isMostlyWhite(sctx, slice.width, slice.height)) {
      yPx += h;
      continue;
    }
    const dataUrl = slice.toDataURL('image/jpeg', 0.85);
    const bytes = dataUrlToBytes(dataUrl);
    const img = await doc.embedJpg(bytes);
    const page = doc.addPage([pageWidthPt, pageHeightPt]);
    const drawHeightPt = h * ptPerPx;
    page.drawImage(img, {
      x: margin,
      y: pageHeightPt - margin - drawHeightPt,
      width: drawableWidthPt,
      height: drawHeightPt,
    });
    yPx += h;
  }

  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

function isMostlyWhite(ctx, w, h) {
  const samples = 100;
  for (let i = 0; i < samples; i++) {
    const x = Math.floor(Math.random() * w);
    const y = Math.floor(Math.random() * h);
    const data = ctx.getImageData(x, y, 1, 1).data;
    if (data[0] < 240 || data[1] < 240 || data[2] < 240) return false;
  }
  return true;
}

// Build a PDF of the completed worksheet pages (question pages with strokes)
// from already-flattened JPEG data URLs.
export async function exportCompletedAttemptPdf(completedPages) {
  const { PDFDocument } = await getPdfLib();
  const doc = await PDFDocument.create();
  for (const { dataUrl } of completedPages) {
    const bytes = dataUrlToBytes(dataUrl);
    const img = await doc.embedJpg(bytes);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const base64 = dataUrl.slice(comma + 1);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
