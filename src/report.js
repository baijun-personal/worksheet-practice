// Render the merged marking JSON into a parent-friendly UI, and export it
// as a PDF using pdf-lib loaded from CDN.

import { KNOWN_STATUSES } from './openai.js';

export function renderReport(report, mountNodes) {
  const {
    summaryEl, costEl, wrongEl, uncertainEl, weakEl, redoEl, tableEl, rawEl,
  } = mountNodes;

  const summary = report.paper_summary || {};
  const warnings = report.app_warnings || null;
  summaryEl.innerHTML = `
    ${warnings ? renderWarningBanner(warnings) : ''}
    <h2>Summary</h2>
    <p><strong>Estimated score:</strong> ${escapeHtml(summary.estimated_score || '—')}
       <span class="muted small">(confidence: ${escapeHtml(summary.score_confidence || 'low')})</span></p>
    <p><strong>Subject:</strong> ${escapeHtml(summary.subject || '—')}</p>
    <p>${escapeHtml(summary.overall_comment || '')}</p>
    <p class="muted small">Items flagged for parent review: ${Number(summary.needs_parent_review_count) || 0}</p>
  `;

  if (costEl) {
    costEl.innerHTML = report.app_usage ? renderCostCard(report.app_usage) : '';
    costEl.style.display = report.app_usage ? '' : 'none';
  }

  const results = Array.isArray(report.question_results) ? report.question_results : [];

  const wrong = results.filter((r) => isWrong(r));
  wrongEl.innerHTML = `<h2>Wrong (${wrong.length})</h2>` +
    (wrong.length === 0 ? '<p class="muted">None.</p>' : `<ul>${wrong.map(qBullet).join('')}</ul>`);

  const uncertain = results.filter((r) => isUncertain(r));
  uncertainEl.innerHTML = `<h2>Uncertain or needs parent review (${uncertain.length})</h2>` +
    (uncertain.length === 0 ? '<p class="muted">None.</p>' : `<ul>${uncertain.map(qBullet).join('')}</ul>`);

  const weak = Array.isArray(report.weak_knowledge_points) ? report.weak_knowledge_points : [];
  weakEl.innerHTML = `<h2>Weak knowledge points</h2>` +
    (weak.length === 0 ? '<p class="muted">No clear pattern detected.</p>' :
      `<ul>${weak.map((w) => `
        <li><strong>${escapeHtml(w.knowledge_point || '')}</strong> —
            ${escapeHtml(w.comment || '')}
            <span class="muted small">(see ${(w.evidence_questions || []).map(escapeHtml).join(', ')})</span>
        </li>`).join('')}</ul>`);

  const redo = Array.isArray(report.redo_suggestions) ? report.redo_suggestions : [];
  redoEl.innerHTML = `<h2>Suggested redo</h2>` +
    (redo.length === 0 ? '<p class="muted">None.</p>' :
      `<p>${redo.map(escapeHtml).join(', ')}</p>`);

  tableEl.innerHTML = `<h2>All questions (${results.length})</h2>` +
    `<table><thead><tr>
        <th>Q</th><th>Status</th><th>Student</th><th>Expected</th><th>Pages</th><th>Conf</th><th>Comment / evidence</th><th>Topic</th>
      </tr></thead><tbody>${
      results.map((r) => `<tr>
        <td>${escapeHtml(r.question_number || '')}</td>
        <td>${statusTag(r.marking_status)}</td>
        <td>${escapeHtml(r.student_answer || '')}</td>
        <td>${escapeHtml(r.expected_answer || '')}</td>
        <td>${formatPageRefs(r)}</td>
        <td>${formatConfidence(r.confidence)}</td>
        <td>${escapeHtml(r.comment || '')}${
          r.evidence_note ? `<div class="muted small">${escapeHtml(r.evidence_note)}</div>` : ''
        }</td>
        <td>${escapeHtml(r.knowledge_point || '')}</td>
      </tr>`).join('')
    }</tbody></table>`;

  rawEl.textContent = JSON.stringify(report, null, 2);
}

function renderCostCard(u) {
  const t = u.totals || {};
  const fmtTokens = (n) => Number(n || 0).toLocaleString();
  const fmtUsd = (n) => '$' + (Number(n) || 0).toFixed(4);
  const batchRows = (u.batches || []).map((b) => `
    <tr>
      <td>${escapeHtml(b.index + 1)}</td>
      <td>${escapeHtml((b.pages || []).join(', '))}</td>
      <td>${fmtTokens(b.usage?.prompt_tokens)}</td>
      <td>${fmtTokens(b.usage?.completion_tokens)}</td>
      <td>${fmtTokens(b.usage?.total_tokens)}</td>
    </tr>`).join('');
  return `
    <h2>Cost &amp; usage <span class="muted small">(estimate)</span></h2>
    <p><strong>Estimated total: ${fmtUsd(u.estimated_cost_usd)}</strong>
       <span class="muted small">
         (input ${fmtUsd(u.estimated_input_cost_usd)} + output ${fmtUsd(u.estimated_output_cost_usd)})
       </span></p>
    <p class="muted small">
      Model: ${escapeHtml(u.model || '—')} —
      rates used: input $${(u.price_in_per_m_tokens ?? 0).toFixed(2)}/1M,
      output $${(u.price_out_per_m_tokens ?? 0).toFixed(2)}/1M.
      Verify against <a href="https://openai.com/api/pricing/" target="_blank" rel="noopener">openai.com/api/pricing</a>.
      The authoritative cost is on the OpenAI dashboard.
    </p>
    <p class="muted small">
      Total tokens: input ${fmtTokens(t.prompt_tokens)} +
      output ${fmtTokens(t.completion_tokens)} =
      ${fmtTokens(t.total_tokens)}.
    </p>
    <details>
      <summary class="muted small">Per-batch breakdown</summary>
      <table style="margin-top:8px"><thead><tr>
        <th>Batch</th><th>Pages</th><th>Input</th><th>Output</th><th>Total</th>
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
  const a = r.completed_page_number;
  const b = r.answer_sheet_page_number;
  if (a == null && b == null) return '<span class="muted">—</span>';
  const aStr = a != null ? `completed p.${escapeHtml(a)}` : '';
  const bStr = b != null ? `answer p.${escapeHtml(b)}` : '';
  return [aStr, bStr].filter(Boolean).join('<br>');
}

function isWrong(r) {
  return r.marking_status === 'wrong_high_confidence' || r.marking_status === 'probably_wrong';
}
function isUncertain(r) {
  return r.parent_review_needed === true ||
    r.marking_status === 'needs_parent_review' ||
    r.marking_status === 'unable_to_determine';
}

function qBullet(r) {
  const pageBits = [];
  if (r.completed_page_number != null) pageBits.push(`completed p.${r.completed_page_number}`);
  if (r.answer_sheet_page_number != null) pageBits.push(`answer p.${r.answer_sheet_page_number}`);
  const pageStr = pageBits.length ? ` <span class="muted small">[${escapeHtml(pageBits.join(', '))}]</span>` : '';
  return `<li>
    <strong>Q${escapeHtml(r.question_number || '')}</strong>
    ${statusTag(r.marking_status)}${pageStr}
    — student: <em>${escapeHtml(r.student_answer || '')}</em>,
    expected: <em>${escapeHtml(r.expected_answer || '')}</em>
    ${r.comment ? `<div class="muted small">${escapeHtml(r.comment)}</div>` : ''}
    ${r.evidence_note ? `<div class="muted small">${escapeHtml(r.evidence_note)}</div>` : ''}
  </li>`;
}

function statusTag(status) {
  const known = KNOWN_STATUSES.includes(status);
  let cls = 'unsure';
  if (status === 'correct_high_confidence' || status === 'probably_correct') cls = 'correct';
  else if (status === 'wrong_high_confidence' || status === 'probably_wrong') cls = 'wrong';
  else if (status === 'needs_parent_review' || status === 'unable_to_determine') cls = 'review';
  const label = (status || 'unknown').replace(/_/g, ' ');
  return `<span class="tag ${cls}" title="${known ? '' : 'Unrecognized status'}">${escapeHtml(label)}</span>`;
}

function formatConfidence(c) {
  if (c == null) return '—';
  const n = Number(c);
  if (!isFinite(n)) return escapeHtml(String(c));
  return n.toFixed(2);
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

  function newPage() { page = doc.addPage([pageWidth, pageHeight]); y = pageHeight - margin; }
  function drawText(text, opts = {}) {
    const fnt = opts.bold ? bold : font;
    const size = opts.size || 11;
    const color = opts.color || rgb(0.08, 0.1, 0.12);
    const lines = wrap(text, fnt, size, pageWidth - margin * 2);
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

  const s = report.paper_summary || {};
  drawText('Summary', { bold: true, size: 14 });
  drawText(`Estimated score: ${s.estimated_score || '—'}  (confidence: ${s.score_confidence || 'low'})`);
  if (s.subject) drawText(`Subject: ${s.subject}`);
  if (s.overall_comment) drawText(s.overall_comment);
  y -= 4;

  if (report.app_usage) {
    const u = report.app_usage;
    const t = u.totals || {};
    drawText('Cost & usage (estimate)', { bold: true, size: 14 });
    drawText(
      `Estimated total: $${(u.estimated_cost_usd ?? 0).toFixed(4)} ` +
      `(input $${(u.estimated_input_cost_usd ?? 0).toFixed(4)} + ` +
      `output $${(u.estimated_output_cost_usd ?? 0).toFixed(4)})`
    );
    drawText(
      `Model: ${u.model || '—'}. ` +
      `Rates: input $${(u.price_in_per_m_tokens ?? 0).toFixed(2)}/1M, ` +
      `output $${(u.price_out_per_m_tokens ?? 0).toFixed(2)}/1M. ` +
      `Verify against openai.com/api/pricing.`,
      { size: 10, color: rgb(0.4, 0.45, 0.5) }
    );
    drawText(
      `Total tokens: input ${(t.prompt_tokens || 0).toLocaleString()} + ` +
      `output ${(t.completion_tokens || 0).toLocaleString()} = ` +
      `${(t.total_tokens || 0).toLocaleString()}.`,
      { size: 10, color: rgb(0.4, 0.45, 0.5) }
    );
    y -= 4;
  }

  const results = report.question_results || [];
  const wrong = results.filter(isWrong);
  if (wrong.length) {
    drawText(`Wrong (${wrong.length})`, { bold: true, size: 14 });
    for (const r of wrong) {
      drawText(`Q${r.question_number}: student "${r.student_answer || ''}" vs expected "${r.expected_answer || ''}"`);
      if (r.comment) drawText(`  ${r.comment}`, { size: 10, color: rgb(0.4, 0.45, 0.5) });
    }
  }

  const uncertain = results.filter(isUncertain);
  if (uncertain.length) {
    drawText(`Needs parent review (${uncertain.length})`, { bold: true, size: 14 });
    for (const r of uncertain) {
      drawText(`Q${r.question_number}: ${r.comment || ''}`);
    }
  }

  const weak = report.weak_knowledge_points || [];
  if (weak.length) {
    drawText('Weak knowledge points', { bold: true, size: 14 });
    for (const w of weak) {
      drawText(`- ${w.knowledge_point}: ${w.comment || ''}`);
    }
  }

  const redo = report.redo_suggestions || [];
  if (redo.length) {
    drawText('Suggested redo', { bold: true, size: 14 });
    drawText(redo.join(', '));
  }

  const checklist = report.parent_review_checklist || [];
  if (checklist.length) {
    drawText('Parent review checklist', { bold: true, size: 14 });
    for (const item of checklist) drawText(`- ${item}`);
  }

  drawText('All questions', { bold: true, size: 14 });
  for (const r of results) {
    const pageBits = [];
    if (r.completed_page_number != null) pageBits.push(`completed p.${r.completed_page_number}`);
    if (r.answer_sheet_page_number != null) pageBits.push(`answer p.${r.answer_sheet_page_number}`);
    const pageSuffix = pageBits.length ? ` [${pageBits.join(', ')}]` : '';
    drawText(
      `Q${r.question_number} [${(r.marking_status || '').replace(/_/g, ' ')}]${pageSuffix}: ` +
      `student "${r.student_answer || ''}" / expected "${r.expected_answer || ''}"`
    );
    if (r.comment) drawText(`  ${r.comment}`, { size: 10, color: rgb(0.4, 0.45, 0.5) });
    if (r.evidence_note) drawText(`  ${r.evidence_note}`, { size: 9, color: rgb(0.45, 0.5, 0.55) });
  }

  const limitations = report.limitations || [];
  if (limitations.length) {
    drawText('Limitations', { bold: true, size: 14 });
    for (const l of limitations) drawText(`- ${l}`);
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
