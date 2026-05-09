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
  weakEl.innerHTML = `<h2>Weak points</h2>` +
    (weak.length === 0 ? '<p class="muted">No clear pattern detected.</p>' :
      `<ul>${weak.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`);

  const redo = Array.isArray(report.redo) ? report.redo : [];
  redoEl.innerHTML = `<h2>Suggested redo</h2>` +
    (redo.length === 0 ? '<p class="muted">None.</p>' :
      `<p>${redo.map(escapeHtml).join(', ')}</p>`);

  tableEl.innerHTML = `<h2>All questions (${results.length})</h2>` +
    `<table><thead><tr>
        <th>Q</th><th>Status</th><th>Student</th><th>Expected</th><th>Pages</th><th>Comment</th>
      </tr></thead><tbody>${
      results.map((r) => `<tr>
        <td>${escapeHtml(r.question || '')}</td>
        <td>${statusTag(r.status)}</td>
        <td>${escapeHtml(r.student_answer || '')}</td>
        <td>${escapeHtml(r.expected_answer || '')}</td>
        <td>${formatPageRefs(r)}</td>
        <td>${escapeHtml(r.comment || '')}</td>
      </tr>`).join('')
    }</tbody></table>`;

  rawEl.textContent = JSON.stringify(report, null, 2);
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
    <strong>Q${escapeHtml(r.question || '')}</strong>
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

// pdf-lib's StandardFonts only encode WinAnsi (Windows-1252). Any character
// beyond Latin-1 (CJK, Hebrew, Arabic, etc.) crashes drawText. We sanitize
// strings before drawing: keep ASCII and Latin-1 + a few common smart
// punctuation chars; replace anything else with '?'. If a string ends up
// substantially '?', swap it for a placeholder pointing at the on-screen
// report so the PDF doesn't fill with gibberish.
const PDF_SAFE_RE = /[\x09\x0A\x0D\x20-\x7E\xA0-\xFF‘’“”–—€]/;

function pdfSafe(text, ctx) {
  const s = String(text == null ? '' : text);
  if (!s) return '';
  let out = '';
  let unsafeCount = 0;
  for (const ch of s) {
    if (PDF_SAFE_RE.test(ch)) out += ch;
    else { unsafeCount++; out += '?'; }
  }
  if (unsafeCount === 0) return s;
  if (ctx) ctx.sanitized = true;
  // If the sanitized result is mostly '?'s (e.g. an all-CJK string), replace
  // it with a clear placeholder rather than a row of question marks.
  const meaningful = out.replace(/[?\s\-,.]/g, '');
  if (meaningful.length === 0) return '[non-Latin text — see on-screen report]';
  return out;
}

// Build a simple report PDF: text-only summary plus one page per question.
export async function exportReportPdf(report, meta) {
  const { PDFDocument, StandardFonts, rgb } = await getPdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const margin = 48;
  const pageWidth = 612;
  const pageHeight = 792;
  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  // Track whether any text needed sanitization, and if so add a banner at
  // the very top once the rest of the document is laid out.
  const ctx = { sanitized: false };

  function newPage() { page = doc.addPage([pageWidth, pageHeight]); y = pageHeight - margin; }
  function drawText(text, opts = {}) {
    const fnt = opts.bold ? bold : font;
    const size = opts.size || 11;
    const color = opts.color || rgb(0.08, 0.1, 0.12);
    const safe = pdfSafe(text, ctx);
    const lines = wrap(safe, fnt, size, pageWidth - margin * 2);
    for (const line of lines) {
      if (y < margin + size) newPage();
      page.drawText(line, { x: margin, y, size, font: fnt, color });
      y -= size * 1.4;
    }
    y -= 4;
  }

  drawText('Worksheet Marking Report', { bold: true, size: 18 });
  drawText(`PDF: ${meta.pdfName || ''}`, { size: 10, color: rgb(0.4, 0.45, 0.5) });
  drawText(`Generated: ${new Date().toLocaleString()}`, { size: 10, color: rgb(0.4, 0.45, 0.5) });
  y -= 8;

  if (report.app_warnings) {
    const w = report.app_warnings;
    drawText('WARNING: report is incomplete', { bold: true, size: 13, color: rgb(0.6, 0.1, 0.1) });
    drawText(
      `Only ${w.batches_completed} of ${w.batches_total} batches were marked.`,
      { color: rgb(0.4, 0.1, 0.1) }
    );
    if (w.stopped_by_user) {
      drawText(`Marking was stopped by the user; ${w.stopped_skipped_count} batch(es) were skipped.`,
        { color: rgb(0.4, 0.1, 0.1) });
    }
    if (Array.isArray(w.failed_batches) && w.failed_batches.length > 0) {
      for (const fb of w.failed_batches) {
        drawText(`Failed batch ${fb.index + 1} (pages ${fb.pages.join(', ')}): ${fb.error}`,
          { color: rgb(0.4, 0.1, 0.1) });
      }
    }
    y -= 6;
  }

  const s = report.summary || {};
  drawText('Summary', { bold: true, size: 14 });
  drawText(`Estimated score: ${s.estimated_score || '—'}`);
  if (s.comment) drawText(s.comment);
  y -= 4;

  if (report.app_usage) {
    const u = report.app_usage;
    const t = u.totals || {};
    drawText('Cost & usage (estimate)', { bold: true, size: 14 });
    drawText(
      `Estimated total: $${(u.estimated_cost_usd ?? 0).toFixed(4)}  ` +
      `(input $${(u.estimated_input_cost_usd ?? 0).toFixed(4)} ` +
      `= uncached $${(u.estimated_uncached_input_cost_usd ?? 0).toFixed(4)} ` +
      `+ cached $${(u.estimated_cached_input_cost_usd ?? 0).toFixed(4)}; ` +
      `output $${(u.estimated_output_cost_usd ?? 0).toFixed(4)})`
    );
    drawText(
      `Model: ${u.model || '—'}. ` +
      `Rates: input $${(u.price_in_per_m_tokens ?? 0).toFixed(3)}/1M, ` +
      `cached input $${(u.price_cached_in_per_m_tokens ?? 0).toFixed(3)}/1M, ` +
      `output $${(u.price_out_per_m_tokens ?? 0).toFixed(3)}/1M. ` +
      `Verify against openai.com/api/pricing.`,
      { size: 10, color: rgb(0.4, 0.45, 0.5) }
    );
    drawText(
      `Total tokens: input ${(t.prompt_tokens || 0).toLocaleString()} ` +
      `(of which cached ${(t.cached_input_tokens || 0).toLocaleString()}) + ` +
      `output ${(t.completion_tokens || 0).toLocaleString()} = ` +
      `${(t.total_tokens || 0).toLocaleString()}.`,
      { size: 10, color: rgb(0.4, 0.45, 0.5) }
    );
    y -= 4;
  }

  const results = report.questions || [];
  const wrong = results.filter(isWrong);
  if (wrong.length) {
    drawText(`Incorrect (${wrong.length})`, { bold: true, size: 14 });
    for (const r of wrong) {
      drawText(`Q${r.question}: student "${r.student_answer || ''}" vs expected "${r.expected_answer || ''}"`);
      if (r.comment) drawText(`  ${r.comment}`, { size: 10, color: rgb(0.4, 0.45, 0.5) });
    }
  }

  const uncertain = results.filter(isUncertain);
  if (uncertain.length) {
    drawText(`Unclear (${uncertain.length})`, { bold: true, size: 14 });
    for (const r of uncertain) {
      drawText(`Q${r.question}: ${r.comment || ''}`);
    }
  }

  const weak = report.weak_points || [];
  if (weak.length) {
    drawText('Weak points', { bold: true, size: 14 });
    for (const w of weak) drawText(`- ${w}`);
  }

  const redo = report.redo || [];
  if (redo.length) {
    drawText('Suggested redo', { bold: true, size: 14 });
    drawText(redo.join(', '));
  }

  drawText('All questions', { bold: true, size: 14 });
  for (const r of results) {
    const pageBits = [];
    if (r.completed_page) pageBits.push(`completed p.${r.completed_page}`);
    if (r.answer_page)    pageBits.push(`answer p.${r.answer_page}`);
    const pageSuffix = pageBits.length ? ` [${pageBits.join(', ')}]` : '';
    drawText(
      `Q${r.question} [${r.status || 'unknown'}]${pageSuffix}: ` +
      `student "${r.student_answer || ''}" / expected "${r.expected_answer || ''}"`
    );
    if (r.comment) drawText(`  ${r.comment}`, { size: 10, color: rgb(0.4, 0.45, 0.5) });
  }

  // If any text needed sanitization, prepend a banner page explaining why
  // some content reads "[non-Latin text — see on-screen report]" or has
  // '?' substitutions. The on-screen report and the raw JSON download
  // carry the full original text.
  if (ctx.sanitized) {
    const banner = doc.insertPage(0, [pageWidth, pageHeight]);
    let by = pageHeight - margin;
    const drawBannerLine = (text, opts = {}) => {
      const fnt = opts.bold ? bold : font;
      const size = opts.size || 11;
      const color = opts.color || rgb(0.08, 0.1, 0.12);
      const lines = wrap(pdfSafe(text), fnt, size, pageWidth - margin * 2);
      for (const line of lines) {
        banner.drawText(line, { x: margin, y: by, size, font: fnt, color });
        by -= size * 1.4;
      }
      by -= 4;
    };
    drawBannerLine('Note', { bold: true, size: 18, color: rgb(0.6, 0.1, 0.1) });
    drawBannerLine(
      'This PDF report cannot render some characters from the worksheet ' +
      '(for example Chinese, Japanese, or other non-Latin text) because ' +
      'the embedded font only supports Latin characters.'
    );
    drawBannerLine(
      'Where original text was non-Latin, you will see one of:'
    );
    drawBannerLine('  - "?" in place of individual characters', { size: 10, color: rgb(0.4, 0.45, 0.5) });
    drawBannerLine('  - "[non-Latin text — see on-screen report]" for a whole value', { size: 10, color: rgb(0.4, 0.45, 0.5) });
    by -= 6;
    drawBannerLine(
      'For the full text, open the marking report in the app, ' +
      'or click "Show raw JSON" and copy the JSON below.'
    );
  }

  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

function wrap(text, font, size, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? line + ' ' + w : w;
    const width = font.widthOfTextAtSize(candidate, size);
    if (width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
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
