// App entry point. Manages a small state machine across the five stages,
// plus the practice canvas controller and the marking pipeline.

import { parsePageRange, validateRanges, rangesOverlap } from './pageRange.js';
import { loadSettings, saveSettings } from './settings.js';
import {
  putAttempt, getAttempt, putStroke, deleteStroke, getStrokesForPage,
  clearStrokesForPage,
} from './storage.js';
import { loadPdfFromBlob, renderPageToCanvas } from './pdfRender.js';
import { attachInkController, redrawAll } from './draw.js';
import { flattenQuestionPage, renderAnswerPage, colorContentRatio } from './flatten.js';
import { markBatch, mergeReports, chunkPages } from './openai.js';
import { renderReport, exportReportPdf, exportCompletedAttemptPdf } from './report.js';

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

  $('pdf-input').addEventListener('change', onPdfPicked);
  $('start-practice-btn').addEventListener('click', onStartPractice);

  // Persist settings on change so they survive a refresh.
  for (const [id, key, parser] of [
    ['openai-key', 'openaiKey', (v) => v],
    ['openai-model', 'openaiModel', (v) => v.trim() || 'gpt-4o-mini'],
    ['render-dpi', 'renderDpi', (v) => parseInt(v, 10) || 150],
    ['batch-size', 'batchSize', (v) => Math.max(1, parseInt(v, 10) || 5)],
  ]) {
    $(id).addEventListener('change', () => {
      state.settings = saveSettings({ [key]: parser($(id).value) });
    });
  }
  $('test-mode').addEventListener('change', () => {
    state.settings = saveSettings({ testMode: $('test-mode').checked });
  });
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
    // Suggest sensible defaults
    if (!$('question-pages').value) {
      $('question-pages').value = `1-${Math.max(1, state.pdf.numPages - 4)}`;
    }
    if (!$('answer-pages').value && state.pdf.numPages > 4) {
      $('answer-pages').value = `${state.pdf.numPages - 3}-${state.pdf.numPages}`;
    }
    // Color check (non-blocking).
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
  });

  const subject = $('meta-subject').value.trim();
  const level = $('meta-level').value.trim();
  const pdfName = $('pdf-input').files?.[0]?.name || 'worksheet.pdf';

  // Create attempt
  state.attempt = {
    id: 'att_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: Date.now(),
    pdfName,
    pdfBlob: state.pdfBlob,
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
  const batchSize = state.settings.batchSize || 5;
  const numBatches = Math.ceil(qPages.length / batchSize);
  const totalImagesPerBatch = batchSize + aPages.length;
  const totalImages = qPages.length + aPages.length * numBatches;

  const ok = confirm(
    `About to send ${totalImages} images to OpenAI in ${numBatches} batch(es).\n` +
    `Each batch: up to ${batchSize} completed pages + ${aPages.length} answer pages = ` +
    `${totalImagesPerBatch} images.\n\nContinue?`
  );
  if (!ok) return;

  setStage('marking');
  $('marking-status').textContent = 'Flattening pages…';
  $('batch-list').innerHTML = '';
  state.cancelMarking = false;

  const dpi = state.settings.renderDpi || 150;

  // Flatten all completed question pages (cache for later download).
  const completedPagesAll = [];
  for (const pageNum of qPages) {
    if (state.cancelMarking) return abortMarking('Cancelled');
    const strokes = await getStrokesForPage(state.attempt.id, pageNum);
    const dataUrl = await flattenQuestionPage(state.pdf, pageNum, strokes, dpi);
    completedPagesAll.push({ pageNumber: pageNum, dataUrl });
    $('marking-status').textContent = `Flattening ${completedPagesAll.length}/${qPages.length} pages…`;
  }
  state.flattenedCompletedPages = completedPagesAll;

  // Render answer pages once.
  const answerImages = [];
  for (const pageNum of aPages) {
    if (state.cancelMarking) return abortMarking('Cancelled');
    const dataUrl = await renderAnswerPage(state.pdf, pageNum, dpi);
    answerImages.push({ pageNumber: pageNum, dataUrl });
  }

  // Run batches.
  const batches = chunkPages(completedPagesAll, batchSize);
  const batchListEl = $('batch-list');
  batches.forEach((b, i) => {
    const li = document.createElement('li');
    li.id = `batch-${i}`;
    li.textContent = `Batch ${i + 1}: pages ${b.map((p) => p.pageNumber).join(', ')} — pending`;
    batchListEl.appendChild(li);
  });

  const batchResults = [];
  const failedBatches = [];           // [{ index, pages, error }]
  let cancelledAfterIndex = null;     // index reached when user clicked stop
  for (let i = 0; i < batches.length; i++) {
    if (state.cancelMarking) {
      cancelledAfterIndex = i;
      // Mark remaining batches as skipped in the UI list
      for (let j = i; j < batches.length; j++) {
        const li = $(`batch-${j}`);
        if (li && !li.classList.contains('done') && !li.classList.contains('failed')) {
          li.textContent = `Batch ${j + 1}: pages ${batches[j].map((p) => p.pageNumber).join(', ')} — skipped (stopped)`;
          li.classList.add('failed');
        }
      }
      break;
    }
    const li = $(`batch-${i}`);
    li.textContent = `Batch ${i + 1}: pages ${batches[i].map((p) => p.pageNumber).join(', ')} — sending…`;
    $('marking-status').textContent = `Marking batch ${i + 1} of ${batches.length}…`;
    try {
      const res = await markBatch({
        apiKey: state.settings.openaiKey,
        model: state.settings.openaiModel,
        completedPageImages: batches[i],
        answerPageImages: answerImages,
        subject: state.attempt.subject,
        level: state.attempt.level,
      });
      batchResults.push(res.parsed);
      li.classList.add('done');
      li.textContent = `Batch ${i + 1}: pages ${batches[i].map((p) => p.pageNumber).join(', ')} — done`;
    } catch (e) {
      console.error('Batch failed', e);
      li.classList.add('failed');
      li.textContent = `Batch ${i + 1}: failed — ${e.message}`;
      const retry = confirm(`Batch ${i + 1} failed:\n${e.message}\n\nRetry?`);
      if (retry) { i--; continue; }
      failedBatches.push({
        index: i,
        pages: batches[i].map((p) => p.pageNumber),
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

  state.reportJson = merged;
  state.attempt.reportJson = merged;
  state.attempt.status = (failedBatches.length > 0 || stopped) ? 'partially_marked' : 'marked';
  await putAttempt(state.attempt);

  showReport(merged);
}

function abortMarking(reason) {
  $('marking-status').textContent = reason;
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
