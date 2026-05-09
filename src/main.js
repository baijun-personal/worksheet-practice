// App entry point. Manages a small state machine across the five stages,
// plus the practice canvas controller and the marking pipeline.

import { parsePageRange, validateRanges, rangesOverlap } from './pageRange.js';
import { loadSettings, saveSettings } from './settings.js';
import {
  putAttempt, getAttempt, putStroke, deleteStroke, getStrokesForPage,
  clearStrokesForPage, deleteAttempt, attemptExists,
} from './storage.js';
import { loadPdfFromBlob, renderPageToCanvas } from './pdfRender.js';
import { attachInkController, redrawAll } from './draw.js';
import { flattenQuestionPage, renderAnswerPage, colorContentRatio } from './flatten.js';
import { markBatch, mergeReports, chunkPages } from './openai.js';
import { renderReport, exportReportPdf, exportCompletedAttemptPdf } from './report.js';
import { loadCatalog, fetchBuiltinPdf, builtinAttemptId } from './builtin.js';
import { composeFourUpA4, chunkInto } from './fourup.js';

const STAGES = ['unlock', 'setup', 'practice', 'marking', 'report'];

const state = {
  stage: 'setup',
  settings: loadSettings(),
  attempt: null,         // current attempt metadata
  pdf: null,             // pdf.js document
  pdfBlob: null,
  currentPage: null,     // 1-based PDF page number, must be a question page
  pageMeta: null,        // result from renderPageToCanvas
  tool: 'pen',
  zoomLevel: 1,
  inkController: null,
  cancelMarking: false,
  flattenedCompletedPages: null, // cached after submit for "download attempt"
  reportJson: null,
  // Setup-stage source state
  sourceMode: 'builtin',           // "builtin" | "upload"
  catalog: [],                     // [Worksheet]
  selectedWorksheet: null,         // current built-in worksheet (or null)
  resumableAttempt: null,          // existing attempt for the chosen built-in (or null)
};

const els = {};

function $(id) { return document.getElementById(id); }

function setStage(stage) {
  state.stage = stage;
  for (const s of STAGES) {
    const sec = $(`stage-${s}`);
    if (sec) sec.hidden = s !== stage;
  }
  for (const span of document.querySelectorAll('.stages span')) {
    span.classList.toggle('active', span.dataset.stage === stage);
  }
  $('reset-btn').hidden = (stage === 'unlock' || stage === 'setup');
}

function setAutosave(label, cls = '') {
  els.autosave.textContent = label;
  els.autosave.className = 'autosave' + (cls ? ' ' + cls : '');
}

// --- Init -----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);

async function init() {
  els.autosave = $('autosave-indicator');
  setAutosave('saved');

  // Show unlock if a passphrase was previously set and not yet unlocked.
  if (state.settings.passphrase && !state.settings.unlocked) {
    setStage('unlock');
  } else {
    setStage('setup');
  }

  bindUnlockForm();
  bindSetupForm();
  bindPracticeUI();
  bindMarkingUI();
  bindReportUI();
  $('reset-btn').addEventListener('click', resetApp);
}

function resetApp() {
  if (!confirm('Start over? Current attempt will be cleared from view (autosaved data is kept in this browser).')) return;
  state.attempt = null;
  state.pdf = null;
  state.pdfBlob = null;
  state.currentPage = null;
  state.pageMeta = null;
  state.flattenedCompletedPages = null;
  state.reportJson = null;
  if (state.inkController) { state.inkController.detach(); state.inkController = null; }
  setStage('setup');
}

// --- Unlock ---------------------------------------------------------------

function bindUnlockForm() {
  $('unlock-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = $('unlock-input').value;
    if (v && v === state.settings.passphrase) {
      state.settings = saveSettings({ unlocked: true });
      $('unlock-error').hidden = true;
      setStage('setup');
    } else {
      $('unlock-error').hidden = false;
    }
  });
}

// --- Setup ----------------------------------------------------------------

function bindSetupForm() {
  // Prefill settings inputs.
  $('openai-key').value = state.settings.openaiKey || '';
  $('openai-model').value = state.settings.openaiModel || 'gpt-4o-mini';
  $('render-dpi').value = String(state.settings.renderDpi || 150);
  $('batch-size').value = String(state.settings.batchSize || 5);
  $('test-mode').checked = !!state.settings.testMode;
  $('price-in').value = String(state.settings.priceInPerMTokens ?? 0.15);
  $('price-out').value = String(state.settings.priceOutPerMTokens ?? 0.60);
  $('marking-mode').value = state.settings.markingMode || 'auto';

  $('pdf-input').addEventListener('change', onPdfPicked);
  $('start-practice-btn').addEventListener('click', onStartPractice);

  // Source toggle
  for (const radio of document.querySelectorAll('input[name="source-mode"]')) {
    radio.addEventListener('change', onSourceChange);
  }
  $('builtin-select').addEventListener('change', onBuiltinSelect);

  // Persist settings on change so they survive a refresh.
  for (const [id, key, parser] of [
    ['openai-key', 'openaiKey', (v) => v],
    ['openai-model', 'openaiModel', (v) => v.trim() || 'gpt-4o-mini'],
    ['render-dpi', 'renderDpi', (v) => parseInt(v, 10) || 150],
    ['batch-size', 'batchSize', (v) => Math.max(1, parseInt(v, 10) || 5)],
    ['price-in', 'priceInPerMTokens', (v) => Math.max(0, parseFloat(v) || 0)],
    ['price-out', 'priceOutPerMTokens', (v) => Math.max(0, parseFloat(v) || 0)],
    ['marking-mode', 'markingMode', (v) => v || 'auto'],
  ]) {
    $(id).addEventListener('change', () => {
      state.settings = saveSettings({ [key]: parser($(id).value) });
    });
  }
  $('test-mode').addEventListener('change', () => {
    state.settings = saveSettings({ testMode: $('test-mode').checked });
  });

  populateBuiltinCatalog();
  applySourceVisibility();
}

async function populateBuiltinCatalog() {
  try {
    state.catalog = await loadCatalog();
  } catch (e) {
    console.warn('Built-in catalog not available:', e);
    state.catalog = [];
  }
  const sel = $('builtin-select');
  sel.innerHTML = '<option value="">— choose —</option>' +
    state.catalog.map((w) =>
      `<option value="${w.id}">${escapeAttr(w.title)} (${w.totalPages || '?'} pages)</option>`
    ).join('');
  if (state.catalog.length === 0) {
    $('builtin-status').textContent = 'No built-in worksheets are available.';
  }
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function onSourceChange() {
  const checked = document.querySelector('input[name="source-mode"]:checked');
  state.sourceMode = checked ? checked.value : 'builtin';
  applySourceVisibility();
  // Reset any loaded PDF state so the next picker action fully drives it.
  state.pdf = null;
  state.pdfBlob = null;
  state.selectedWorksheet = null;
  state.resumableAttempt = null;
  $('pdf-status').textContent = '';
  $('color-warning').hidden = true;
  $('builtin-resume').hidden = true;
  // Clear auto-filled fields so the next picker drives them fresh.
  $('question-pages').value = '';
  $('answer-pages').value = '';
  $('meta-subject').value = '';
  $('meta-level').value = '';
  $('builtin-description').textContent = '';
  $('builtin-status').textContent = '';
  $('pdf-input').value = '';
  $('builtin-select').value = '';
}

function applySourceVisibility() {
  $('builtin-picker').hidden = state.sourceMode !== 'builtin';
  $('upload-picker').hidden = state.sourceMode !== 'upload';
}

async function onBuiltinSelect() {
  const id = $('builtin-select').value;
  $('builtin-resume').hidden = true;
  if (!id) {
    state.selectedWorksheet = null;
    state.pdf = null;
    state.pdfBlob = null;
    $('builtin-description').textContent = '';
    $('builtin-status').textContent = '';
    return;
  }
  const w = state.catalog.find((x) => x.id === id);
  if (!w) return;
  state.selectedWorksheet = w;
  $('builtin-description').textContent = w.description || '';
  $('builtin-status').textContent = 'Loading…';
  try {
    state.pdfBlob = await fetchBuiltinPdf(w.pdfPath);
    state.pdf = await loadPdfFromBlob(state.pdfBlob);
    $('builtin-status').textContent = `${w.title} — ${state.pdf.numPages} pages`;
    // Auto-fill metadata + page ranges (still editable).
    if (w.subject) $('meta-subject').value = w.subject;
    if (w.level) $('meta-level').value = w.level;
    $('question-pages').value = w.questionPages || '';
    $('answer-pages').value = w.answerPages || '';
    // Color check (non-blocking).
    runColorCheck();
    // Resume prompt if a saved attempt exists.
    const aid = builtinAttemptId(w.id);
    if (await attemptExists(aid)) {
      const banner = $('builtin-resume');
      banner.hidden = false;
      banner.innerHTML =
        `Saved work found for <strong>${escapeAttr(w.title)}</strong>.` +
        `<div class="actions">` +
        `<button id="resume-continue" type="button" class="primary">Continue previous attempt</button>` +
        `<button id="resume-restart" type="button">Start from scratch</button>` +
        `</div>`;
      $('resume-continue').addEventListener('click', () => onResumeBuiltin(w, 'continue'));
      $('resume-restart').addEventListener('click', () => onResumeBuiltin(w, 'restart'));
    }
  } catch (e) {
    $('builtin-status').textContent = 'Failed to load worksheet: ' + (e?.message || e);
  }
}

async function onResumeBuiltin(worksheet, mode) {
  const aid = builtinAttemptId(worksheet.id);
  if (mode === 'restart') {
    if (!confirm(`Discard saved strokes and saved report for "${worksheet.title}" and start a blank attempt?`)) return;
    await deleteAttempt(aid);
    $('builtin-resume').hidden = true;
    // Fall through into a fresh practice attempt using the auto-filled fields.
    await onStartPractice();
    return;
  }
  // continue: load existing attempt and jump straight into Practice.
  const existing = await getAttempt(aid);
  if (!existing) return;
  state.attempt = existing;
  // Refresh in-memory PDF from the catalog (Blob isn't reliably persisted).
  if (!state.pdf) {
    state.pdfBlob = await fetchBuiltinPdf(worksheet.pdfPath);
    state.pdf = await loadPdfFromBlob(state.pdfBlob);
  }
  state.currentPage = existing.currentPage || (existing.questionPages?.[0] ?? 1);
  setStage('practice');
  await loadCurrentPage();
}

async function runColorCheck() {
  $('color-warning').hidden = true;
  if (!state.pdf) return;
  try {
    const ratio = await colorContentRatio(state.pdf);
    if (ratio > 0.02) {
      $('color-warning').hidden = false;
      $('color-warning').textContent =
        'This worksheet contains color content. The marking AI works best with black-and-white worksheets. ' +
        'You can continue, but accuracy may be reduced on pages with colored elements.';
    }
  } catch (e) {
    console.warn('Color check failed', e);
  }
}

async function onPdfPicked(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  $('pdf-status').textContent = 'Loading…';
  $('color-warning').hidden = true;
  try {
    state.pdfBlob = file;
    state.pdf = await loadPdfFromBlob(file);
    $('pdf-status').textContent = `${file.name} — ${state.pdf.numPages} pages`;
    // Suggest sensible defaults for upload only.
    if (!$('question-pages').value) {
      $('question-pages').value = `1-${Math.max(1, state.pdf.numPages - 4)}`;
    }
    if (!$('answer-pages').value && state.pdf.numPages > 4) {
      $('answer-pages').value = `${state.pdf.numPages - 3}-${state.pdf.numPages}`;
    }
    runColorCheck();
  } catch (e) {
    $('pdf-status').textContent = 'Failed to load PDF: ' + (e?.message || e);
  }
}

async function onStartPractice() {
  $('page-range-error').hidden = true;
  if (!state.pdf || !state.pdfBlob) {
    $('page-range-error').hidden = false;
    $('page-range-error').textContent = 'Pick a worksheet PDF first.';
    return;
  }
  let questionPages, answerPages;
  try {
    questionPages = parsePageRange($('question-pages').value);
    answerPages = parsePageRange($('answer-pages').value);
  } catch (e) {
    $('page-range-error').hidden = false;
    $('page-range-error').textContent = e.message;
    return;
  }
  const issues = validateRanges({
    questionPages, answerPages, totalPages: state.pdf.numPages,
  });
  if (issues.length) {
    $('page-range-error').hidden = false;
    $('page-range-error').textContent = issues.join('; ');
    return;
  }
  if (rangesOverlap(questionPages, answerPages)) {
    if (!confirm('Question and answer page ranges overlap. Continue anyway?')) return;
  }
  const apiKey = $('openai-key').value.trim();
  if (!apiKey) {
    if (!confirm('No OpenAI API key set. You can still practise, but submitting for marking will fail. Continue?')) return;
  }
  state.settings = saveSettings({
    openaiKey: apiKey,
    openaiModel: $('openai-model').value.trim() || 'gpt-4o-mini',
    renderDpi: parseInt($('render-dpi').value, 10) || 150,
    batchSize: Math.max(1, parseInt($('batch-size').value, 10) || 5),
    testMode: $('test-mode').checked,
    priceInPerMTokens: Math.max(0, parseFloat($('price-in').value) || 0),
    priceOutPerMTokens: Math.max(0, parseFloat($('price-out').value) || 0),
    markingMode: $('marking-mode').value || 'auto',
  });

  const subject = $('meta-subject').value.trim();
  const level = $('meta-level').value.trim();

  // Determine attempt id and pdfName based on source.
  let attemptId, pdfName, builtinId = null;
  if (state.sourceMode === 'builtin') {
    if (!state.selectedWorksheet) {
      $('page-range-error').hidden = false;
      $('page-range-error').textContent = 'Select a built-in worksheet first.';
      return;
    }
    builtinId = state.selectedWorksheet.id;
    attemptId = builtinAttemptId(builtinId);
    pdfName = state.selectedWorksheet.title;
    // If user changed their mind and clicked Start practice while a saved
    // attempt exists, treat that as a fresh start (the resume banner is the
    // explicit "continue" path).
    const existing = await getAttempt(attemptId);
    if (existing) {
      const overwrite = confirm(
        `Saved work exists for "${state.selectedWorksheet.title}".\n\n` +
        `OK = discard the saved work and start a fresh attempt.\n` +
        `Cancel = keep saved work; close this dialog and use "Continue previous attempt" above.`
      );
      if (!overwrite) return;
      await deleteAttempt(attemptId);
    }
  } else {
    attemptId = 'att_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    pdfName = $('pdf-input').files?.[0]?.name || 'worksheet.pdf';
  }

  // Create attempt
  state.attempt = {
    id: attemptId,
    createdAt: Date.now(),
    pdfName,
    builtinId,
    pdfBlob: state.sourceMode === 'upload' ? state.pdfBlob : null,
    pdfPath: state.sourceMode === 'builtin' ? state.selectedWorksheet.pdfPath : null,
    subject,
    level,
    questionPages,
    answerPages,
    currentPage: questionPages[0],
    reportJson: null,
    status: 'in_progress',
  };
  await putAttempt(state.attempt);
  state.currentPage = questionPages[0];
  setStage('practice');
  await loadCurrentPage();
}

// --- Practice -------------------------------------------------------------

function bindPracticeUI() {
  for (const btn of document.querySelectorAll('.tool-btn')) {
    btn.addEventListener('click', () => {
      state.tool = btn.dataset.tool;
      for (const b of document.querySelectorAll('.tool-btn')) {
        b.classList.toggle('active', b === btn);
      }
    });
  }
  $('undo-btn').addEventListener('click', onUndo);
  $('clear-page-btn').addEventListener('click', onClearPage);
  $('zoom-in-btn').addEventListener('click', () => setZoom(state.zoomLevel * 1.2));
  $('zoom-out-btn').addEventListener('click', () => setZoom(state.zoomLevel / 1.2));
  $('zoom-fit-btn').addEventListener('click', () => setZoom(1));
  $('prev-page-btn').addEventListener('click', () => navigateBy(-1));
  $('next-page-btn').addEventListener('click', () => navigateBy(1));
  $('submit-btn').addEventListener('click', onSubmit);

  document.addEventListener('keydown', (ev) => {
    if (state.stage !== 'practice') return;
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
    if (ev.key === 'p') document.querySelector('[data-tool="pen"]').click();
    else if (ev.key === 'e') document.querySelector('[data-tool="eraser"]').click();
    else if ((ev.ctrlKey || ev.metaKey) && ev.key === 'z') { ev.preventDefault(); onUndo(); }
    else if (ev.key === 'ArrowLeft') navigateBy(-1);
    else if (ev.key === 'ArrowRight') navigateBy(1);
  });

  window.addEventListener('resize', debounce(() => {
    if (state.stage === 'practice' && state.currentPage) loadCurrentPage();
  }, 150));
}

function debounce(fn, wait) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function setZoom(z) {
  state.zoomLevel = Math.max(0.5, Math.min(z, 3));
  loadCurrentPage();
}

function navigateBy(dir) {
  if (!state.attempt) return;
  const qp = state.attempt.questionPages;
  const idx = qp.indexOf(state.currentPage);
  const next = qp[idx + dir];
  if (next != null) {
    state.currentPage = next;
    state.attempt.currentPage = next;
    putAttempt(state.attempt);
    loadCurrentPage();
  }
}

async function loadCurrentPage() {
  if (!state.pdf) return;
  const pdfCanvas = $('pdf-canvas');
  const inkCanvas = $('ink-canvas');

  // Compute target CSS width for the rendered page.
  const stage = $('page-stage');
  const stageW = stage.clientWidth - 32; // padding
  const cssWidth = Math.max(320, Math.min(1400, stageW * state.zoomLevel));

  state.pageMeta = await renderPageToCanvas(state.pdf, state.currentPage, pdfCanvas, { cssWidth });

  // Match ink-canvas backing store and CSS to pdf-canvas.
  inkCanvas.width = pdfCanvas.width;
  inkCanvas.height = pdfCanvas.height;
  inkCanvas.style.width = pdfCanvas.style.width;
  inkCanvas.style.height = pdfCanvas.style.height;

  const inkCtx = inkCanvas.getContext('2d');
  const strokes = await getStrokesForPage(state.attempt.id, state.currentPage);
  redrawAll(inkCtx, strokes, {
    widthPx: inkCanvas.width,
    heightPx: inkCanvas.height,
    pageWidthPts: state.pageMeta.pageWidthPts,
  });

  // Attach ink controller (re-attach each time so it picks up new canvas size)
  if (state.inkController) state.inkController.detach();
  state.inkController = attachInkController({
    inkCanvas,
    getPageMeta: () => ({
      pageWidthPts: state.pageMeta.pageWidthPts,
      pageHeightPts: state.pageMeta.pageHeightPts,
      widthPx: inkCanvas.width,
      heightPx: inkCanvas.height,
    }),
    getCurrentPage: () => state.currentPage,
    getStrokes: () => getStrokesForPage(state.attempt.id, state.currentPage),
    getTool: () => state.tool,
    onStrokeAdded: async (stroke) => {
      stroke.attemptId = state.attempt.id;
      setAutosave('saving…', 'saving');
      try {
        await putStroke(stroke);
        setAutosave('saved');
      } catch (e) {
        console.error(e);
        setAutosave('save failed', 'error');
      }
    },
    onStrokeRemoved: async (strokeId) => {
      setAutosave('saving…', 'saving');
      try {
        await deleteStroke(state.attempt.id, strokeId);
        // Redraw after removal
        const remaining = await getStrokesForPage(state.attempt.id, state.currentPage);
        redrawAll(inkCtx, remaining, {
          widthPx: inkCanvas.width,
          heightPx: inkCanvas.height,
          pageWidthPts: state.pageMeta.pageWidthPts,
        });
        setAutosave('saved');
      } catch (e) {
        console.error(e);
        setAutosave('save failed', 'error');
      }
    },
    onRedrawRequested: async () => {
      const all = await getStrokesForPage(state.attempt.id, state.currentPage);
      redrawAll(inkCtx, all, {
        widthPx: inkCanvas.width,
        heightPx: inkCanvas.height,
        pageWidthPts: state.pageMeta.pageWidthPts,
      });
    },
  });

  // Page indicator
  const qp = state.attempt.questionPages;
  const idx = qp.indexOf(state.currentPage);
  $('page-indicator').textContent = `${idx + 1} / ${qp.length} (PDF p.${state.currentPage})`;
  $('prev-page-btn').disabled = idx <= 0;
  $('next-page-btn').disabled = idx >= qp.length - 1;
}

async function onUndo() {
  if (!state.attempt) return;
  const strokes = await getStrokesForPage(state.attempt.id, state.currentPage);
  if (strokes.length === 0) return;
  const last = strokes[strokes.length - 1];
  await deleteStroke(state.attempt.id, last.id);
  const remaining = strokes.slice(0, -1);
  const inkCanvas = $('ink-canvas');
  redrawAll(inkCanvas.getContext('2d'), remaining, {
    widthPx: inkCanvas.width,
    heightPx: inkCanvas.height,
    pageWidthPts: state.pageMeta.pageWidthPts,
  });
}

async function onClearPage() {
  if (!state.attempt) return;
  if (!confirm(`Clear all writing on this page?`)) return;
  await clearStrokesForPage(state.attempt.id, state.currentPage);
  const inkCanvas = $('ink-canvas');
  inkCanvas.getContext('2d').clearRect(0, 0, inkCanvas.width, inkCanvas.height);
}

// --- Marking pipeline -----------------------------------------------------

function bindMarkingUI() {
  $('cancel-marking-btn').addEventListener('click', () => {
    state.cancelMarking = true;
  });
}

async function onSubmit() {
  if (!state.attempt) return;
  if (!state.settings.openaiKey) {
    alert('No OpenAI API key set. Add one in Setup → Advanced settings before submitting.');
    return;
  }
  let qPages = [...state.attempt.questionPages];
  if (state.settings.testMode) qPages = qPages.slice(0, 2);
  const aPages = state.attempt.answerPages;

  // Resolve marking mode (Auto chooses between single combined and batch4_fullpage).
  const requestedMode = state.settings.markingMode || 'auto';
  let mode = requestedMode;
  if (mode === 'auto') {
    mode = qPages.length <= 4 ? 'single_fullpage' : 'batch4_fullpage';
  }

  // Build the batches up front so we can show a confirmation with image counts.
  // Each "batch" is: { label, completedImages: [{pageNumber, dataUrl}], answerImages: same array each time }
  let batchesPlan; // [{ pages: number[], composite: "fullpage"|"fourup" }]
  if (mode === 'single_fullpage') {
    batchesPlan = [{ pages: qPages, composite: 'fullpage' }];
  } else if (mode === 'batch4_fourup') {
    batchesPlan = chunkInto(qPages, 4).map((g) => ({ pages: g, composite: 'fourup' }));
  } else {
    // batch4_fullpage
    batchesPlan = chunkInto(qPages, 4).map((g) => ({ pages: g, composite: 'fullpage' }));
  }

  const imagesPerBatch = batchesPlan.map((b) => (b.composite === 'fourup' ? 1 : b.pages.length) + aPages.length);
  const totalImages = imagesPerBatch.reduce((a, b) => a + b, 0);
  const modeLabel = (
    requestedMode === 'auto' ? `Auto → ${humanMode(mode)}` : humanMode(mode)
  );
  const ok = confirm(
    `Marking mode: ${modeLabel}\n` +
    `About to send ${totalImages} images to OpenAI in ${batchesPlan.length} request(s).\n` +
    batchesPlan.map((b, i) =>
      `  Request ${i + 1}: ${b.composite === 'fourup' ? '1 4-up image' : b.pages.length + ' full-page image(s)'}` +
      ` covering pages ${b.pages.join(', ')} + ${aPages.length} answer page(s)`
    ).join('\n') +
    `\n\nContinue?`
  );
  if (!ok) return;

  setStage('marking');
  $('marking-status').textContent = 'Flattening pages…';
  $('batch-list').innerHTML = '';
  state.cancelMarking = false;

  const dpi = state.settings.renderDpi || 150;

  // Flatten all completed question pages once (cache for "download attempt").
  const completedPagesAll = [];
  for (const pageNum of qPages) {
    if (state.cancelMarking) return abortMarking('Cancelled');
    const strokes = await getStrokesForPage(state.attempt.id, pageNum);
    const dataUrl = await flattenQuestionPage(state.pdf, pageNum, strokes, dpi);
    completedPagesAll.push({ pageNumber: pageNum, dataUrl, strokes });
    $('marking-status').textContent = `Flattening ${completedPagesAll.length}/${qPages.length} pages…`;
  }
  state.flattenedCompletedPages = completedPagesAll.map(({ pageNumber, dataUrl }) => ({ pageNumber, dataUrl }));

  // Render answer pages once.
  const answerImages = [];
  for (const pageNum of aPages) {
    if (state.cancelMarking) return abortMarking('Cancelled');
    const dataUrl = await renderAnswerPage(state.pdf, pageNum, dpi);
    answerImages.push({ pageNumber: pageNum, dataUrl });
  }

  // Now build per-batch image arrays, composing 4-up sheets where requested.
  const completedByPage = new Map(completedPagesAll.map((p) => [p.pageNumber, p]));
  const batches = [];
  for (const plan of batchesPlan) {
    if (plan.composite === 'fourup') {
      const tilePages = plan.pages.map((n) => ({
        pageNumber: n,
        strokes: completedByPage.get(n).strokes,
      }));
      const composed = await composeFourUpA4(state.pdf, tilePages, { dpi: 200 });
      // Use the first page of the group as the representative pageNumber so
      // the existing image-label logic still works (the prompt text already
      // mentions "Completed worksheet page PDF p.N"; for 4-up the per-tile
      // labels are baked into the image itself).
      batches.push({
        completed: [{ pageNumber: plan.pages[0], dataUrl: composed.dataUrl, fourup: true, includedPageNumbers: composed.includedPageNumbers }],
        answer: answerImages,
        plannedPages: plan.pages,
      });
    } else {
      batches.push({
        completed: plan.pages.map((n) => ({ pageNumber: n, dataUrl: completedByPage.get(n).dataUrl })),
        answer: answerImages,
        plannedPages: plan.pages,
      });
    }
  }

  const batchListEl = $('batch-list');
  batches.forEach((b, i) => {
    const li = document.createElement('li');
    li.id = `batch-${i}`;
    li.textContent = `Request ${i + 1}: pages ${b.plannedPages.join(', ')} — pending`;
    batchListEl.appendChild(li);
  });

  const batchResults = [];
  const batchUsages = [];             // [{ index, pages, usage }]
  const failedBatches = [];           // [{ index, pages, error }]
  let cancelledAfterIndex = null;     // index reached when user clicked stop
  for (let i = 0; i < batches.length; i++) {
    if (state.cancelMarking) {
      cancelledAfterIndex = i;
      // Mark remaining batches as skipped in the UI list
      for (let j = i; j < batches.length; j++) {
        const li = $(`batch-${j}`);
        if (li && !li.classList.contains('done') && !li.classList.contains('failed')) {
          li.textContent = `Request ${j + 1}: pages ${batches[j].plannedPages.join(', ')} — skipped (stopped)`;
          li.classList.add('failed');
        }
      }
      break;
    }
    const li = $(`batch-${i}`);
    li.textContent = `Request ${i + 1}: pages ${batches[i].plannedPages.join(', ')} — sending…`;
    $('marking-status').textContent = `Marking request ${i + 1} of ${batches.length}…`;
    try {
      const res = await markBatch({
        apiKey: state.settings.openaiKey,
        model: state.settings.openaiModel,
        completedPageImages: batches[i].completed,
        answerPageImages: batches[i].answer,
        subject: state.attempt.subject,
        level: state.attempt.level,
      });
      batchResults.push(res.parsed);
      if (res.usage) {
        batchUsages.push({
          index: i,
          pages: batches[i].plannedPages,
          usage: res.usage,
        });
      }
      li.classList.add('done');
      li.textContent = `Request ${i + 1}: pages ${batches[i].plannedPages.join(', ')} — done`;
    } catch (e) {
      console.error('Batch failed', e);
      li.classList.add('failed');
      li.textContent = `Request ${i + 1}: failed — ${e.message}`;
      const retry = confirm(`Request ${i + 1} failed:\n${e.message}\n\nRetry?`);
      if (retry) { i--; continue; }
      failedBatches.push({
        index: i,
        pages: batches[i].plannedPages,
        error: e.message,
      });
      // Fall through with partial batches; merged report will show what we have.
    }
  }

  if (batchResults.length === 0) {
    $('marking-status').textContent = 'No batches succeeded.';
    return;
  }

  const merged = mergeReports(batchResults);
  if (state.attempt.subject) merged.paper_summary.subject = state.attempt.subject;

  const stopped = cancelledAfterIndex != null;
  const skippedCount = stopped ? batches.length - cancelledAfterIndex : 0;
  if (failedBatches.length > 0 || stopped) {
    merged.app_warnings = {
      incomplete: true,
      batches_total: batches.length,
      batches_completed: batchResults.length,
      failed_batches: failedBatches,
      stopped_by_user: stopped,
      stopped_skipped_count: skippedCount,
    };
  }

  // Compute totals + an estimated USD cost from configured per-1M-token rates.
  const totals = batchUsages.reduce((acc, b) => {
    const u = b.usage || {};
    acc.prompt_tokens += Number(u.prompt_tokens) || 0;
    acc.completion_tokens += Number(u.completion_tokens) || 0;
    acc.total_tokens += Number(u.total_tokens) || 0;
    return acc;
  }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  const priceIn = Number(state.settings.priceInPerMTokens) || 0;
  const priceOut = Number(state.settings.priceOutPerMTokens) || 0;
  const inputCost = (totals.prompt_tokens / 1_000_000) * priceIn;
  const outputCost = (totals.completion_tokens / 1_000_000) * priceOut;
  merged.app_usage = {
    model: state.settings.openaiModel,
    batches: batchUsages,
    totals,
    price_in_per_m_tokens: priceIn,
    price_out_per_m_tokens: priceOut,
    estimated_cost_usd: +(inputCost + outputCost).toFixed(4),
    estimated_input_cost_usd: +inputCost.toFixed(4),
    estimated_output_cost_usd: +outputCost.toFixed(4),
  };

  state.reportJson = merged;
  state.attempt.reportJson = merged;
  state.attempt.status = (failedBatches.length > 0 || stopped) ? 'partially_marked' : 'marked';
  await putAttempt(state.attempt);

  showReport(merged);
}

function abortMarking(reason) {
  $('marking-status').textContent = reason;
}

function humanMode(mode) {
  switch (mode) {
    case 'single_fullpage': return 'Single combined request, full-page images';
    case 'batch4_fullpage': return 'Batch by 4 pages, full-page images';
    case 'batch4_fourup':   return 'Batch by 4 pages, 4-up A4 combined images';
    default:                return mode;
  }
}

// --- Report ---------------------------------------------------------------

function bindReportUI() {
  $('toggle-raw-json').addEventListener('click', () => {
    const el = $('raw-json');
    el.hidden = !el.hidden;
    $('toggle-raw-json').textContent = el.hidden ? 'Show raw JSON' : 'Hide raw JSON';
  });
  $('download-report-pdf').addEventListener('click', async () => {
    if (!state.reportJson) return;
    const blob = await exportReportPdf(state.reportJson, { pdfName: state.attempt?.pdfName });
    triggerDownload(blob, fileBaseName(state.attempt?.pdfName) + '-report.pdf');
  });
  $('download-attempt-pdf').addEventListener('click', async () => {
    if (!state.flattenedCompletedPages) {
      alert('Completed pages are only available right after marking.');
      return;
    }
    const blob = await exportCompletedAttemptPdf(state.flattenedCompletedPages);
    triggerDownload(blob, fileBaseName(state.attempt?.pdfName) + '-completed.pdf');
  });
}

function showReport(merged) {
  setStage('report');
  renderReport(merged, {
    summaryEl: $('report-summary'),
    costEl: $('report-cost'),
    wrongEl: $('report-wrong'),
    uncertainEl: $('report-uncertain'),
    weakEl: $('report-weak'),
    redoEl: $('report-redo'),
    tableEl: $('report-table'),
    rawEl: $('raw-json'),
  });
}

function fileBaseName(name) {
  if (!name) return 'worksheet';
  return name.replace(/\.pdf$/i, '').replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 80) || 'worksheet';
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
