// App entry point. Manages a small state machine across the five stages,
// plus the practice canvas controller and the marking pipeline.

import { parsePageRange, validateRanges, rangesOverlap } from './pageRange.js';
import { loadSettings, saveSettings } from './settings.js';
import {
  putAttempt, getAttempt, putStroke, deleteStroke, getStrokesForPage,
  clearStrokesForPage, deleteAttempt, attemptExists,
  putPaper, getPaper, listPapers,
} from './storage.js';
import {
  computePaperIdentity, paperFromBuiltinCatalog, paperFromAttempt,
  paperFreshness, snapshotPaperOntoAttempt,
} from './paper.js';
import { loadPdfFromBlob, renderPageToCanvas } from './pdfRender.js';
import { attachInkController, redrawAll } from './draw.js';
import { flattenQuestionPage, renderAnswerPage, colorContentRatio } from './flatten.js';
import { extractStudentAnswers, extractAnswerKey, markPairs, compareVisualPair, MODEL_PRESETS, DEFAULT_MODEL, presetForModel } from './openai.js';
import { matchExtractions, buildFinalReport, partitionPairsByModality } from './compare.js';
import { renderReport, exportReportPdf, exportCompletedAttemptPdf } from './report.js';
import { loadCatalog, fetchBuiltinPdf, builtinAttemptId } from './builtin.js';
import { composeFourUpA4, chunkInto } from './fourup.js';
import { buildTaskRecord, aggregateTasks, TASK_TYPES } from './cost.js';

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

// --- Helpers for shuttling attempt metadata into the setup form ----------

function pageArrayToRange(arr) {
  if (!arr || arr.length === 0) return '';
  const sorted = [...new Set(arr.map(Number))].sort((a, b) => a - b);
  const parts = [];
  let runStart = sorted[0], runEnd = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === runEnd + 1) { runEnd = sorted[i]; continue; }
    parts.push(runStart === runEnd ? `${runStart}` : `${runStart}-${runEnd}`);
    runStart = runEnd = sorted[i];
  }
  parts.push(runStart === runEnd ? `${runStart}` : `${runStart}-${runEnd}`);
  return parts.join(',');
}

function updateStartPracticeButton() {
  const btn = $('start-practice-btn');
  if (!btn) return;
  btn.textContent = state.attempt ? 'Resume practice' : 'Start practice';
}

function fillSetupFormFromAttempt() {
  if (!state.attempt) return;
  $('question-pages').value = pageArrayToRange(state.attempt.questionPages);
  $('answer-pages').value = pageArrayToRange(state.attempt.answerPages);
  $('meta-subject').value = state.attempt.subject || '';
  $('meta-level').value = state.attempt.level || '';
  if (state.attempt.builtinId) {
    const radio = document.querySelector('input[name="source-mode"][value="builtin"]');
    if (radio) radio.checked = true;
    state.sourceMode = 'builtin';
    applySourceVisibility();
    $('builtin-select').value = state.attempt.builtinId;
    state.selectedWorksheet = state.catalog.find((w) => w.id === state.attempt.builtinId) || null;
    if (state.selectedWorksheet) {
      $('builtin-description').textContent = state.selectedWorksheet.description || '';
    }
    if (state.pdf) {
      $('builtin-status').textContent = `${state.attempt.pdfName} — ${state.pdf.numPages} pages`;
    }
    $('builtin-resume').hidden = true; // suppress the Continue/Restart banner — already in an attempt
  } else {
    const radio = document.querySelector('input[name="source-mode"][value="upload"]');
    if (radio) radio.checked = true;
    state.sourceMode = 'upload';
    applySourceVisibility();
    if (state.pdf) {
      $('pdf-status').textContent = `${state.attempt.pdfName} — ${state.pdf.numPages} pages`;
    }
  }
  updateStartPracticeButton();
}

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
  const className = 'autosave' + (cls ? ' ' + cls : '');
  for (const el of [els.autosave, els.autosavePractice]) {
    if (!el) continue;
    el.textContent = label;
    el.className = className;
  }
}

// --- Immersive practice mode ---------------------------------------------
// Hides chrome (topbar, stage tabs, etc.) and requests browser fullscreen so
// the worksheet feels like a clean writing surface. Falls back to immersive
// CSS only if Fullscreen API isn't available (older iPad Safari).
async function enterFullscreenPractice() {
  document.body.classList.add('app-immersive');
  const root = document.documentElement;
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  if (typeof req === 'function') {
    try {
      await req.call(root);
    } catch (e) {
      // User can deny or the API may be unavailable; immersive CSS still
      // applies so the experience is acceptable either way.
      console.warn('Fullscreen request failed; using immersive layout only', e);
    }
  }
  // The page-stage just changed size; re-render so the canvas and ink
  // overlay match the new dimensions.
  if (state.stage === 'practice' && state.attempt) {
    setTimeout(() => loadCurrentPage(), 50);
  }
  setTimeout(refreshScrollRails, 100);
}

async function exitFullscreenPractice() {
  document.body.classList.remove('app-immersive');
  const exitFn = document.exitFullscreen || document.webkitExitFullscreen;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    if (typeof exitFn === 'function') {
      try { await exitFn.call(document); } catch { /* ignore */ }
    }
  }
  if (state.stage === 'practice' && state.attempt) {
    setTimeout(() => loadCurrentPage(), 50);
  }
  setTimeout(refreshScrollRails, 100);
}

// --- Init -----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);

async function init() {
  els.autosave = $('autosave-indicator');
  els.autosavePractice = $('autosave-indicator-practice');
  setAutosave('saved');

  // Keep our `app-immersive` class in sync if the user exits full-screen via
  // the OS shortcut (Esc on desktop, swipe on iPad).
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) document.body.classList.remove('app-immersive');
  });
  document.addEventListener('webkitfullscreenchange', () => {
    if (!document.webkitFullscreenElement) document.body.classList.remove('app-immersive');
  });

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
  setupScrollRails();
  $('reset-btn').addEventListener('click', resetApp);
}

// --- Custom scroll rails for #page-stage --------------------------------
// Native iPadOS scrollbars are auto-hidden, which makes scrolling the
// worksheet hard to discover and hard to control on tablet. We render
// our own vertical (and conditionally horizontal) rails inside
// #page-stage-frame so the parent always sees a draggable thumb.
// CSS keeps the rails hidden outside immersive mode.
function setupScrollRails() {
  const stage = $('page-stage');
  const railV = $('scroll-rail-v');
  const thumbV = $('scroll-thumb-v');
  const railH = $('scroll-rail-h');
  const thumbH = $('scroll-thumb-h');
  if (!stage || !railV || !thumbV || !railH || !thumbH) return;

  function update() {
    // Vertical
    if (stage.scrollHeight > stage.clientHeight + 1) {
      railV.hidden = false;
      const railLen = railV.clientHeight;
      const ratio = stage.clientHeight / stage.scrollHeight;
      const thumbLen = Math.max(44, Math.round(railLen * ratio));
      const maxScroll = stage.scrollHeight - stage.clientHeight;
      const top = maxScroll > 0
        ? Math.round((stage.scrollTop / maxScroll) * (railLen - thumbLen))
        : 0;
      thumbV.style.height = `${thumbLen}px`;
      thumbV.style.top = `${top}px`;
    } else {
      railV.hidden = true;
    }
    // Horizontal — only shown when worksheet actually overflows horizontally.
    if (stage.scrollWidth > stage.clientWidth + 1) {
      railH.hidden = false;
      const railLen = railH.clientWidth;
      const ratio = stage.clientWidth / stage.scrollWidth;
      const thumbLen = Math.max(44, Math.round(railLen * ratio));
      const maxScroll = stage.scrollWidth - stage.clientWidth;
      const left = maxScroll > 0
        ? Math.round((stage.scrollLeft / maxScroll) * (railLen - thumbLen))
        : 0;
      thumbH.style.width = `${thumbLen}px`;
      thumbH.style.left = `${left}px`;
    } else {
      railH.hidden = true;
    }
  }

  function attachDrag(rail, thumb, axis) {
    let dragging = false;
    let startPointer = 0;
    let startScroll = 0;

    thumb.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      dragging = true;
      startPointer = axis === 'y' ? ev.clientY : ev.clientX;
      startScroll = axis === 'y' ? stage.scrollTop : stage.scrollLeft;
      thumb.setPointerCapture(ev.pointerId);
    });
    thumb.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      ev.preventDefault();
      const railLen = axis === 'y' ? rail.clientHeight : rail.clientWidth;
      const thumbLen = axis === 'y' ? thumb.clientHeight : thumb.clientWidth;
      const maxScroll = axis === 'y'
        ? stage.scrollHeight - stage.clientHeight
        : stage.scrollWidth - stage.clientWidth;
      const trackLen = railLen - thumbLen;
      if (trackLen <= 0 || maxScroll <= 0) return;
      const delta = (axis === 'y' ? ev.clientY : ev.clientX) - startPointer;
      const newScroll = Math.max(0, Math.min(maxScroll, startScroll + delta * (maxScroll / trackLen)));
      if (axis === 'y') stage.scrollTop = newScroll; else stage.scrollLeft = newScroll;
    });
    const release = (ev) => {
      if (!dragging) return;
      dragging = false;
      try { thumb.releasePointerCapture(ev.pointerId); } catch {}
    };
    thumb.addEventListener('pointerup', release);
    thumb.addEventListener('pointercancel', release);

    // Tap on the rail (not on the thumb) jumps scroll to that ratio.
    rail.addEventListener('pointerdown', (ev) => {
      if (ev.target !== rail) return;
      const rect = rail.getBoundingClientRect();
      const ratio = axis === 'y'
        ? (ev.clientY - rect.top) / rect.height
        : (ev.clientX - rect.left) / rect.width;
      const maxScroll = axis === 'y'
        ? stage.scrollHeight - stage.clientHeight
        : stage.scrollWidth - stage.clientWidth;
      const target = Math.max(0, Math.min(maxScroll, ratio * maxScroll));
      if (axis === 'y') stage.scrollTop = target; else stage.scrollLeft = target;
    });
  }

  attachDrag(railV, thumbV, 'y');
  attachDrag(railH, thumbH, 'x');

  stage.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(update);
    ro.observe(stage);
    // page-wrap (the inner content) is what actually changes size when a
    // new page renders or zoom changes. ResizeObserver on the scroll
    // container doesn't fire on its content's box change, so observe
    // the wrap too.
    const wrap = $('page-wrap');
    if (wrap) ro.observe(wrap);
  }
  // First sync once layout settles, plus expose update() so other places
  // (loadCurrentPage, fullscreen toggles) can trigger it explicitly.
  setTimeout(update, 50);
  state._updateScrollRails = update;
}

function refreshScrollRails() {
  if (typeof state._updateScrollRails === 'function') state._updateScrollRails();
}

function resetStageScroll() {
  const stage = $('page-stage');
  if (!stage) return;
  stage.scrollTop = 0;
  stage.scrollLeft = 0;
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
  exitFullscreenPractice();
  updateStartPracticeButton();
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
  // Populate the model preset dropdown from the openai.js table.
  populateModelPresetSelect();
  // Populate the four per-task model selects from the same MODEL_PRESETS
  // list. These default to the user-specified per-task defaults
  // (settings.{detection|extraction|textComparison|visualComparison}Model).
  populateTaskModelSelects();

  // Prefill settings inputs.
  $('openai-key').value = state.settings.openaiKey || '';
  $('openai-model').value = state.settings.openaiModel || DEFAULT_MODEL;
  applyModelToControls(state.settings.openaiModel || DEFAULT_MODEL);
  $('model-detection').value      = state.settings.detectionModel        || state.settings.openaiModel || DEFAULT_MODEL;
  $('model-extraction').value     = state.settings.extractionModel       || state.settings.openaiModel || DEFAULT_MODEL;
  $('model-text-compare').value   = state.settings.textComparisonModel   || state.settings.openaiModel || DEFAULT_MODEL;
  $('model-visual-compare').value = state.settings.visualComparisonModel || state.settings.openaiModel || DEFAULT_MODEL;
  $('render-dpi').value = String(state.settings.renderDpi || 150);
  $('batch-size').value = String(state.settings.batchSize || 5);
  $('test-mode').checked = !!state.settings.testMode;
  $('price-in').value = String(state.settings.priceInPerMTokens ?? 0.75);
  $('price-cached-in').value = String(state.settings.priceCachedInPerMTokens ?? 0.075);
  $('price-out').value = String(state.settings.priceOutPerMTokens ?? 4.50);
  $('marking-mode').value = state.settings.markingMode || 'auto';
  // API mode + proxy fields
  const apiMode = state.settings.apiMode || 'direct';
  for (const r of document.querySelectorAll('input[name="api-mode"]')) {
    r.checked = (r.value === apiMode);
  }
  $('proxy-endpoint').value = state.settings.proxyEndpoint || '';
  $('proxy-token').value = state.settings.proxyToken || '';
  applyApiModeVisibility(apiMode);

  $('pdf-input').addEventListener('change', onPdfPicked);
  $('start-practice-btn').addEventListener('click', onStartPractice);

  // Source toggle
  for (const radio of document.querySelectorAll('input[name="source-mode"]')) {
    radio.addEventListener('change', onSourceChange);
  }
  $('builtin-select').addEventListener('change', onBuiltinSelect);

  // Model preset: switch model + auto-fill prices.
  $('openai-model-preset').addEventListener('change', onModelPresetChange);

  // Persist settings on change so they survive a refresh.
  for (const [id, key, parser] of [
    ['openai-key', 'openaiKey', (v) => v],
    ['openai-model', 'openaiModel', (v) => v.trim() || DEFAULT_MODEL],
    ['render-dpi', 'renderDpi', (v) => parseInt(v, 10) || 150],
    ['batch-size', 'batchSize', (v) => Math.max(1, parseInt(v, 10) || 5)],
    ['price-in', 'priceInPerMTokens', (v) => Math.max(0, parseFloat(v) || 0)],
    ['price-cached-in', 'priceCachedInPerMTokens', (v) => Math.max(0, parseFloat(v) || 0)],
    ['price-out', 'priceOutPerMTokens', (v) => Math.max(0, parseFloat(v) || 0)],
    ['marking-mode', 'markingMode', (v) => v || 'auto'],
    ['model-detection',      'detectionModel',        (v) => v.trim() || DEFAULT_MODEL],
    ['model-extraction',     'extractionModel',       (v) => v.trim() || DEFAULT_MODEL],
    ['model-text-compare',   'textComparisonModel',   (v) => v.trim() || DEFAULT_MODEL],
    ['model-visual-compare', 'visualComparisonModel', (v) => v.trim() || DEFAULT_MODEL],
  ]) {
    $(id).addEventListener('change', () => {
      state.settings = saveSettings({ [key]: parser($(id).value) });
    });
  }
  $('test-mode').addEventListener('change', () => {
    state.settings = saveSettings({ testMode: $('test-mode').checked });
  });

  // API mode toggle + proxy fields
  for (const r of document.querySelectorAll('input[name="api-mode"]')) {
    r.addEventListener('change', () => {
      const v = r.checked ? r.value : null;
      if (!v) return;
      state.settings = saveSettings({ apiMode: v });
      applyApiModeVisibility(v);
    });
  }
  $('proxy-endpoint').addEventListener('change', () => {
    state.settings = saveSettings({ proxyEndpoint: $('proxy-endpoint').value.trim() });
  });
  $('proxy-token').addEventListener('change', () => {
    state.settings = saveSettings({ proxyToken: $('proxy-token').value });
  });

  populateBuiltinCatalog();
  applySourceVisibility();

  // Diagnostics
  $('diag-text-btn').addEventListener('click', () => runDiagnostic('text'));
  $('diag-image-btn').addEventListener('click', () => runDiagnostic('image'));
  $('diag-page-btn').addEventListener('click', () => runDiagnostic('page'));
}

// --- Diagnostics: minimal OpenAI requests for narrowing down marking errors.
// Runs against the current API key, model, and (optional) endpoint override
// from settings. Output is structured JSON dumped into #diag-output for
// easy reading + copy-paste.

const OPENAI_DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

function buildDiagTransport() {
  const apiMode = state.settings.apiMode || 'direct';
  const model = state.settings.openaiModel || DEFAULT_MODEL;
  if (apiMode === 'proxy') {
    if (!state.settings.proxyEndpoint) return { error: 'Proxy URL not set in Setup → Advanced settings.' };
    if (!state.settings.proxyToken) return { error: 'Proxy token not set in Setup → Advanced settings.' };
    return {
      apiMode,
      model,
      url: state.settings.proxyEndpoint,
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Token': state.settings.proxyToken,
      },
    };
  }
  if (!state.settings.openaiKey) return { error: 'No OpenAI API key set. Paste it in Setup → Advanced settings → API key first.' };
  return {
    apiMode,
    model,
    url: OPENAI_DEFAULT_ENDPOINT,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.settings.openaiKey}`,
    },
  };
}

async function runDiagnostic(kind) {
  const out = $('diag-output');
  out.hidden = false;
  const t = buildDiagTransport();
  if (t.error) { out.textContent = t.error; return; }

  const testLabel =
    kind === 'image' ? 'tiny-image' :
    kind === 'page'  ? 'first-worksheet-page' :
    'text-only';

  out.textContent = `Preparing ${testLabel} request…`;

  let messages;
  if (kind === 'image') {
    // 300x300 canvas: white background + black "test" text.
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 300;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 300, 300);
    ctx.fillStyle = 'black';
    ctx.font = 'bold 80px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('test', 60, 150);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'Read this test image and return JSON only: {"ok":true,"text":""}' },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
      ],
    }];
  } else if (kind === 'page') {
    if (!state.pdf) {
      out.textContent =
        'No worksheet PDF is loaded. Pick a built-in worksheet or upload a PDF in Setup first, then run this test.';
      return;
    }
    out.textContent = 'Rendering first worksheet page…';
    const dpi = state.settings.renderDpi || 150;
    let dataUrl;
    try {
      const strokes = state.attempt
        ? await getStrokesForPage(state.attempt.id, state.attempt.questionPages?.[0] ?? 1)
        : [];
      const pageNum = state.attempt?.questionPages?.[0] ?? 1;
      dataUrl = await flattenQuestionPage(state.pdf, pageNum, strokes, dpi);
    } catch (e) {
      out.textContent = JSON.stringify({
        test: testLabel,
        success: false,
        stage: 'page rendering failed before any request',
        errorName: e?.name || '',
        errorMessage: e?.message || '',
      }, null, 2);
      return;
    }
    messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'Briefly describe this worksheet page in 1 sentence and return JSON only: {"ok":true,"description":""}' },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      ],
    }];
  } else {
    messages = [{ role: 'user', content: 'Return JSON only: {"ok":true}' }];
  }

  const body = {
    model: t.model,
    messages,
    response_format: { type: 'json_object' },
    temperature: 0,
  };
  const bodyStr = JSON.stringify(body);

  out.textContent = JSON.stringify({
    test: testLabel,
    apiMode: t.apiMode,
    endpoint: t.url,
    model: t.model,
    requestBytes: bodyStr.length,
    requestKB: Math.round(bodyStr.length / 1024),
    status: 'sending…',
  }, null, 2);

  const start = performance.now();
  let resp;
  try {
    resp = await fetch(t.url, { method: 'POST', headers: t.headers, body: bodyStr });
  } catch (e) {
    const isNetwork = e?.name === 'TypeError' || /failed to fetch|network/i.test(e?.message || '');
    out.textContent = JSON.stringify({
      test: testLabel,
      apiMode: t.apiMode,
      endpoint: t.url,
      model: t.model,
      requestBytes: bodyStr.length,
      success: false,
      stage: 'fetch threw before any response',
      elapsedMs: Math.round(performance.now() - start),
      errorName: e?.name || '',
      errorMessage: e?.message || '',
      isBrowserOrNetworkError: isNetwork,
      hint: isNetwork
        ? `Browser/network error before any HTTP exchange. Try opening ${t.url} in a new tab — if it doesn't load, the device's network is blocking it. Other causes: CORS preflight blocked, OS firewall, ad-blocker, OOM on a low-memory tablet.`
        : 'Unexpected error type — copy errorName/errorMessage above when reporting.',
    }, null, 2);
    return;
  }

  const elapsedMs = Math.round(performance.now() - start);
  let text = '';
  let readErr = null;
  try { text = await resp.text(); } catch (e) { readErr = e; }
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}

  out.textContent = JSON.stringify({
    test: testLabel,
    apiMode: t.apiMode,
    endpoint: t.url,
    model: t.model,
    requestBytes: bodyStr.length,
    requestKB: Math.round(bodyStr.length / 1024),
    success: resp.ok,
    httpStatus: resp.status,
    httpStatusText: resp.statusText,
    elapsedMs,
    responseBytes: text.length,
    readError: readErr ? `${readErr.name}: ${readErr.message}` : null,
    modelContent: parsed?.choices?.[0]?.message?.content ?? null,
    usage: parsed?.usage ?? null,
    rawSnippet: text.slice(0, 1500),
  }, null, 2);
}

function populateModelPresetSelect() {
  const sel = $('openai-model-preset');
  // Build presets first, then keep the existing trailing "__custom__" option.
  const customOpt = sel.querySelector('option[value="__custom__"]');
  sel.innerHTML = '';
  for (const p of MODEL_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
  sel.appendChild(customOpt);
}

// Populate each per-task model dropdown with the same MODEL_PRESETS
// list. Selection is bound to its own settings field, defaulting to
// the user-specified per-task default.
function populateTaskModelSelects() {
  const ids = ['model-detection', 'model-extraction', 'model-text-compare', 'model-visual-compare'];
  for (const id of ids) {
    const sel = $(id);
    if (!sel) continue;
    sel.innerHTML = '';
    for (const p of MODEL_PRESETS) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      sel.appendChild(opt);
    }
  }
}

function applyModelToControls(model) {
  const preset = presetForModel(model);
  if (preset) {
    $('openai-model-preset').value = preset.id;
    $('openai-model-custom-wrap').hidden = true;
    $('openai-model').value = preset.id;
  } else {
    // Custom model name not in the preset table.
    $('openai-model-preset').value = '__custom__';
    $('openai-model-custom-wrap').hidden = false;
    $('openai-model').value = model;
  }
}

function onModelPresetChange() {
  const v = $('openai-model-preset').value;
  if (v === '__custom__') {
    $('openai-model-custom-wrap').hidden = false;
    // Don't touch prices; user is going off-menu.
    const customName = $('openai-model').value.trim() || '';
    state.settings = saveSettings({ openaiModel: customName });
    return;
  }
  const preset = presetForModel(v);
  if (!preset) return;
  $('openai-model-custom-wrap').hidden = true;
  $('openai-model').value = preset.id;
  $('price-in').value = String(preset.priceInPerMTokens);
  $('price-cached-in').value = String(preset.priceCachedInPerMTokens);
  $('price-out').value = String(preset.priceOutPerMTokens);
  state.settings = saveSettings({
    openaiModel: preset.id,
    priceInPerMTokens: preset.priceInPerMTokens,
    priceCachedInPerMTokens: preset.priceCachedInPerMTokens,
    priceOutPerMTokens: preset.priceOutPerMTokens,
  });
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
  const newMode = checked ? checked.value : 'builtin';
  if (newMode === state.sourceMode) return;
  // Switching source while an attempt is active means the PDF and stroke
  // page-numbering would no longer match the attempt; require explicit
  // confirmation to drop the attempt before changing source.
  if (state.attempt) {
    const ok = confirm(
      'Switching worksheet source will leave the current attempt.\n\n' +
      'OK = leave the attempt (it stays saved; you can pick the worksheet again to resume).\n' +
      'Cancel = stay on the current source.'
    );
    if (!ok) {
      const radio = document.querySelector(`input[name="source-mode"][value="${state.sourceMode}"]`);
      if (radio) radio.checked = true;
      return;
    }
    state.attempt = null;
    if (state.inkController) { state.inkController.detach(); state.inkController = null; }
    updateStartPracticeButton();
  }
  state.sourceMode = newMode;
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

function applyApiModeVisibility(mode) {
  const proxy = mode === 'proxy';
  $('proxy-fields').hidden = !proxy;
  // The OpenAI API key field stays visible in both modes (user can keep
  // it stashed for later) but is no longer required when proxy is on.
  // Update the help text accordingly.
  const helpEl = $('api-mode-help');
  if (helpEl) {
    helpEl.textContent = proxy
      ? 'Proxy mode: requests go to the Worker URL with X-Proxy-Token. The OpenAI API key field below is unused; the real key lives in the Worker.'
      : 'Direct mode: browser calls api.openai.com directly with the API key below. Proxy: browser calls a Worker that holds the OpenAI key server-side (use this when the device blocks api.openai.com).';
  }
  const keyWrap = $('openai-key-wrap');
  if (keyWrap) keyWrap.style.opacity = proxy ? '0.55' : '';
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
    // Resolve / synthesize the paper profile for this PDF. If a stored
    // profile already exists, prefer its ranges over the catalog
    // metadata (the parent may have edited them).
    await resolvePaperProfile({ source: 'built_in', builtinId: w.id, catalogEntry: w });
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
  // Mirror the attempt's values into the setup form so the Setup back-button
  // shows them (and lets the user edit before resuming).
  fillSetupFormFromAttempt();
  setStage('practice');
  await loadCurrentPage();
  enterFullscreenPractice();
}

// After the PDF has loaded (built-in or upload), compute its paper
// identity and look up an existing profile in IndexedDB.
//
// Built-ins always end up with a profile in state.paperProfile —
// either the stored one (if confirmed previously) or a fresh one
// synthesised from the catalog metadata (unconfirmed).
//
// Uploads only get a profile when one was previously stored for this
// PDF. First-time uploads return null; the practice picker then uses
// heuristic defaults until the parent confirms a profile (Stage F+G).
//
// If the stored built-in profile's hash / size disagrees with the
// loaded PDF, we treat the profile as stale — the parent will need to
// reconfirm. For now we just log and keep the stored profile so the
// in-progress flow doesn't break; full UX is added in Stage G.
async function resolvePaperProfile(opts) {
  if (!state.pdf || !state.pdfBlob) {
    state.paperProfile = null;
    return null;
  }
  let bytes;
  try {
    bytes = new Uint8Array(await state.pdfBlob.arrayBuffer());
  } catch (e) {
    console.warn('Could not read PDF bytes for hashing:', e);
    bytes = null;
  }
  const identity = await computePaperIdentity({
    source: opts.source,
    builtinId: opts.builtinId,
    pdfBytes: bytes,
    pdfName: opts.pdfName || opts.catalogEntry?.title || '',
    pdfPageCount: state.pdf.numPages,
    pdfByteLength: state.pdfBlob.size || (bytes ? bytes.byteLength : 0),
  });
  state.paperIdentity = identity;
  let paper = await getPaper(identity.paper_id);
  if (paper) {
    const fresh = paperFreshness(paper, identity);
    if (fresh === 'stale') {
      console.warn(
        `Paper profile for ${identity.paper_id} looks stale ` +
        `(stored hash/size differs from loaded PDF). ` +
        `Re-confirmation will be required after Stage G ships.`
      );
    }
    state.paperProfile = paper;
    return paper;
  }
  if (opts.source === 'built_in' && opts.catalogEntry) {
    paper = paperFromBuiltinCatalog(opts.catalogEntry, identity);
    paper = await putPaper(paper);
    state.paperProfile = paper;
    return paper;
  }
  // Upload with no stored profile. Caller decides what to do.
  state.paperProfile = null;
  return null;
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
    // Look up or synthesize a paper profile for this upload. Returns
    // null when there's no stored profile yet — the picker will then
    // fall back to the heuristic defaults below until detection
    // (Stage F) creates one.
    const paper = await resolvePaperProfile({ source: 'upload', pdfName: file.name });
    if (paper) {
      // Reuse the stored ranges (parent confirmed these previously).
      $('question-pages').value = pageArrayToRange(paper.question_pages);
      $('answer-pages').value = pageArrayToRange(paper.answer_pages);
    } else {
      // Suggest sensible defaults for first-time uploads.
      if (!$('question-pages').value) {
        $('question-pages').value = `1-${Math.max(1, state.pdf.numPages - 4)}`;
      }
      if (!$('answer-pages').value && state.pdf.numPages > 4) {
        $('answer-pages').value = `${state.pdf.numPages - 3}-${state.pdf.numPages}`;
      }
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
    openaiModel: $('openai-model').value.trim() || DEFAULT_MODEL,
    renderDpi: parseInt($('render-dpi').value, 10) || 150,
    batchSize: Math.max(1, parseInt($('batch-size').value, 10) || 5),
    testMode: $('test-mode').checked,
    priceInPerMTokens: Math.max(0, parseFloat($('price-in').value) || 0),
    priceCachedInPerMTokens: Math.max(0, parseFloat($('price-cached-in').value) || 0),
    priceOutPerMTokens: Math.max(0, parseFloat($('price-out').value) || 0),
    markingMode: $('marking-mode').value || 'auto',
    apiMode: (document.querySelector('input[name="api-mode"]:checked')?.value) || 'direct',
    proxyEndpoint: $('proxy-endpoint').value.trim(),
    proxyToken: $('proxy-token').value,
  });

  const subject = $('meta-subject').value.trim();
  const level = $('meta-level').value.trim();

  // Update path: if there's an active attempt, just rewrite its metadata
  // from the current form values and resume practice. Strokes saved on
  // pages that fall outside the new question range stay in IndexedDB but
  // are no longer visible (and won't be sent for marking).
  if (state.attempt) {
    const oldQ = new Set(state.attempt.questionPages || []);
    const newQ = new Set(questionPages);
    const dropped = [...oldQ].filter((p) => !newQ.has(p));
    if (dropped.length > 0) {
      const ok = confirm(
        `Question pages no longer in the range: ${dropped.join(', ')}\n\n` +
        `Strokes saved on those pages will be hidden but not deleted. Continue?`
      );
      if (!ok) return;
    }
    state.attempt.questionPages = questionPages;
    state.attempt.answerPages = answerPages;
    state.attempt.subject = subject;
    state.attempt.level = level;
    if (!questionPages.includes(state.attempt.currentPage)) {
      state.attempt.currentPage = questionPages[0];
    }
    state.currentPage = state.attempt.currentPage;
    await putAttempt(state.attempt);
    setStage('practice');
    await loadCurrentPage();
    enterFullscreenPractice();
    return;
  }

  // Determine attempt id and pdfName based on source for the fresh-create
  // path.
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
    // If user clicked Start practice while a saved attempt exists, treat
    // that as a fresh start (the resume banner is the explicit "continue"
    // path).
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

  // Create attempt. paperId snapshots the resolved profile so later
  // edits to the profile don't retroactively mutate this attempt.
  // questionPages / answerPages on the attempt are still authoritative
  // for marking; the paperId is just a back-reference.
  state.attempt = {
    id: attemptId,
    createdAt: Date.now(),
    pdfName,
    builtinId,
    paperId: state.paperProfile?.paper_id || null,
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
  updateStartPracticeButton();
  setStage('practice');
  await loadCurrentPage();
  enterFullscreenPractice();
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
  $('page-nav-prev').addEventListener('click', () => navigateBy(-1));
  $('page-nav-next').addEventListener('click', () => navigateBy(1));
  $('submit-btn').addEventListener('click', onSubmit);
  $('back-to-setup-btn').addEventListener('click', onBackToSetup);
  $('exit-fullscreen-btn').addEventListener('click', () => exitFullscreenPractice());

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

async function navigateBy(dir) {
  if (!state.attempt) return;
  const qp = state.attempt.questionPages;
  const idx = qp.indexOf(state.currentPage);
  const next = qp[idx + dir];
  if (next != null) {
    state.currentPage = next;
    state.attempt.currentPage = next;
    // Persist the new currentPage as a tracked autosave (was fire-and-
    // forget before — failures were silent and the indicator still read
    // 'saved'). Render the page in parallel; failures of either surface
    // through their own UI hooks.
    setAutosave('saving…', 'saving');
    try {
      await putAttempt(state.attempt);
      setAutosave('saved');
    } catch (e) {
      console.error('Failed to persist current page', e);
      setAutosave('save failed', 'error');
    }
    await loadCurrentPage();
    // Always land at the top-left of the new page so the user doesn't
    // start the next page mid-scroll from the previous one.
    resetStageScroll();
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
  });

  // Page indicator — mirrored to the bottom nav bar in immersive mode.
  const qp = state.attempt.questionPages;
  const idx = qp.indexOf(state.currentPage);
  $('page-indicator').textContent = `${idx + 1} / ${qp.length} (PDF p.${state.currentPage})`;
  $('prev-page-btn').disabled = idx <= 0;
  $('next-page-btn').disabled = idx >= qp.length - 1;
  const navIndicator = $('page-nav-indicator');
  if (navIndicator) navIndicator.textContent = `Page ${idx + 1} / ${qp.length}`;
  $('page-nav-prev').disabled = idx <= 0;
  $('page-nav-next').disabled = idx >= qp.length - 1;

  // The rendered page just changed size; re-sync the custom scroll rails.
  refreshScrollRails();
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
  // In direct mode we need the OpenAI key here; in proxy mode the
  // Worker holds the key, but we need the proxy URL + token.
  const apiMode = state.settings.apiMode || 'direct';
  if (apiMode === 'proxy') {
    if (!state.settings.proxyEndpoint || !state.settings.proxyToken) {
      alert('Proxy mode is selected but the Proxy URL or token is empty. Set them in Setup → Advanced settings.');
      return;
    }
  } else if (!state.settings.openaiKey) {
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

  // Build the request list for the confirmation. Staged pipeline:
  //   1. Student-answer extraction request(s) — completed images only.
  //   2. Answer-key extraction request — answer-page images only (skipped
  //      if no answer pages are specified).
  //   3. Final comparison request — text-only (no images), runs only if
  //      both prior stages produced something to compare.
  const studentRequestImages = batchesPlan.map((b) => (b.composite === 'fourup' ? 1 : b.pages.length));
  const studentRequestCount = batchesPlan.length;
  const answerKeyRequestCount = aPages.length > 0 ? 1 : 0;
  const compareRequestCount = answerKeyRequestCount > 0 ? 1 : 0;
  const totalRequests = studentRequestCount + answerKeyRequestCount + compareRequestCount;
  const totalStudentImages = studentRequestImages.reduce((a, b) => a + b, 0);
  const totalAnswerImages = aPages.length;
  const totalImages = totalStudentImages + totalAnswerImages;
  const modeLabel = (
    requestedMode === 'auto' ? `Auto → ${humanMode(mode)}` : humanMode(mode)
  );
  const studentLines = batchesPlan.map((b, i) =>
    `  Request ${i + 1}: Student answers — ${
      b.composite === 'fourup' ? '1 4-up image' : `${b.pages.length} full-page image(s)`
    } covering completed pages ${b.pages.join(', ')}`
  ).join('\n');
  const answerLine = answerKeyRequestCount > 0
    ? `  Request ${studentRequestCount + 1}: Answer key — ${aPages.length} answer page image(s) covering page${aPages.length === 1 ? '' : 's'} ${aPages.join(', ')}`
    : `  ⚠ No answer pages specified — normal answer-key marking cannot run.\n` +
      `    The AI will still extract the student's answers, but the report will\n` +
      `    have no expected-answer column and no correct/incorrect verdicts.\n` +
      `    Add answer pages in Setup if you want full marking.`;
  const compareLine = compareRequestCount > 0
    ? `  Request ${studentRequestCount + 2}: Final comparison — text-only (no images), one call covering all matched pairs`
    : '';
  const ok = confirm(
    `Marking mode: ${modeLabel}\n` +
    `Pipeline: extract student answers → extract answer key → compare ` +
    `(text-only for written answers; one extra vision call per drawing/diagram question).\n` +
    `About to send ${totalRequests} request(s) to OpenAI ` +
    `(${totalStudentImages} student image(s) + ${totalAnswerImages} answer page image(s) = ${totalImages} total images, plus ${compareRequestCount} text-only compare).\n` +
    [studentLines, answerLine, compareLine].filter(Boolean).join('\n') +
    (compareRequestCount > 0
      ? '\n  + 0 or more visual-compare calls — added after extraction for any drawing / diagram questions found.'
      : '') +
    `\n\nContinue?`
  );
  if (!ok) return;

  exitFullscreenPractice();
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
  // Each batch carries ONLY completed images — the answer key is sent as
  // a separate request later in the staged pipeline.
  const completedByPage = new Map(completedPagesAll.map((p) => [p.pageNumber, p]));
  const batches = [];
  for (const plan of batchesPlan) {
    if (plan.composite === 'fourup') {
      const tilePages = plan.pages.map((n) => ({
        pageNumber: n,
        strokes: completedByPage.get(n).strokes,
      }));
      // composeFourUpA4 currently always renders at 200 DPI regardless of
      // the user's submission DPI setting. 200 DPI keeps a 4-up A4 tile
      // (each ~795x1115 px) readable for typical worksheet text. If you
      // later expose a "4-up DPI" setting, plumb it in here. For now, this
      // is intentional and decoupled from settings.renderDpi.
      const composed = await composeFourUpA4(state.pdf, tilePages, { dpi: 200 });
      // Use the first page of the group as the representative pageNumber
      // so the per-image text label naming still works; the per-tile
      // page labels are also baked into the image itself.
      batches.push({
        completed: [{
          pageNumber: plan.pages[0],
          dataUrl: composed.dataUrl,
          fourup: true,
          includedPageNumbers: composed.includedPageNumbers,
        }],
        plannedPages: plan.pages,
      });
    } else {
      batches.push({
        completed: plan.pages.map((n) => ({ pageNumber: n, dataUrl: completedByPage.get(n).dataUrl })),
        plannedPages: plan.pages,
      });
    }
  }

  // Build a unified list of "tasks" the marking loop will run, in order:
  //   - one task per Stage-1 student-answer batch
  //   - one task for the Stage-2 answer-key extraction (if there are answer pages)
  // Each task tracks its kind, label, request payload, and result holder.
  const tasks = batches.map((b, i) => ({
    kind: 'student',
    index: i,
    label: `Student answers, pages ${b.plannedPages.join(', ')}`,
    completed: b.completed,
    plannedPages: b.plannedPages,
  }));
  if (answerImages.length > 0) {
    tasks.push({
      kind: 'answer_key',
      index: tasks.length,
      label: `Answer key, pages ${aPages.join(', ')}`,
      answer: answerImages,
      plannedPages: [...aPages],
    });
  }

  const batchListEl = $('batch-list');
  tasks.forEach((t, i) => {
    const li = document.createElement('li');
    li.id = `batch-${i}`;
    li.textContent = `Request ${i + 1}: ${t.label} — pending`;
    batchListEl.appendChild(li);
  });

  const studentResults = [];
  const keyResults = [];
  const taskUsages = [];              // [{ index, kind, pages, usage }]
  const failedTasks = [];             // [{ index, kind, pages, error }]
  let cancelledAfterIndex = null;     // index reached when user clicked stop

  for (let i = 0; i < tasks.length; i++) {
    if (state.cancelMarking) {
      cancelledAfterIndex = i;
      for (let j = i; j < tasks.length; j++) {
        const li = $(`batch-${j}`);
        if (li && !li.classList.contains('done') && !li.classList.contains('failed')) {
          li.textContent = `Request ${j + 1}: ${tasks[j].label} — skipped (stopped)`;
          li.classList.add('failed');
        }
      }
      break;
    }
    const t = tasks[i];
    const li = $(`batch-${i}`);
    li.textContent = `Request ${i + 1}: ${t.label} — sending…`;
    $('marking-status').textContent = `Marking request ${i + 1} of ${tasks.length}…`;
    try {
      let res;
      // Per-task model — extraction (student + answer key) uses the
      // user's extractionModel selector. Falls back to openaiModel if
      // unset (e.g. settings migrated from before Stage D).
      const taskModel = state.settings.extractionModel || state.settings.openaiModel || DEFAULT_MODEL;
      const transport = {
        apiKey: state.settings.openaiKey,
        model: taskModel,
        apiMode: state.settings.apiMode || 'direct',
        proxyEndpoint: state.settings.proxyEndpoint,
        proxyToken: state.settings.proxyToken,
      };
      if (t.kind === 'student') {
        res = await extractStudentAnswers({
          ...transport,
          completedPageImages: t.completed,
        });
        studentResults.push(res.parsed);
      } else {
        res = await extractAnswerKey({
          ...transport,
          answerPageImages: t.answer,
        });
        keyResults.push(res.parsed);
      }
      taskUsages.push(buildTaskRecord({
        task_type: t.kind === 'student'
          ? TASK_TYPES.STUDENT_EXTRACTION
          : TASK_TYPES.ANSWER_KEY_EXTRACTION,
        model: taskModel,
        label: t.label,
        pages: t.plannedPages,
        usage: res.usage,
        settings: state.settings,
      }));
      li.classList.add('done');
      li.textContent = `Request ${i + 1}: ${t.label} — done`;
    } catch (e) {
      console.error('Task failed', e);
      li.classList.add('failed');
      li.textContent = `Request ${i + 1}: failed — ${e.message}`;
      const retry = confirm(`Request ${i + 1} failed:\n${e.message}\n\nRetry?`);
      if (retry) { i--; continue; }
      failedTasks.push({
        index: i,
        kind: t.kind,
        pages: t.plannedPages,
        error: e.message,
      });
      // Fall through with what we have.
    }
  }

  if (studentResults.length === 0) {
    $('marking-status').textContent = 'No student-answer extractions succeeded; cannot produce a report.';
    return;
  }

  // Stage 3a: match extracted student answers to answer-key entries
  // deterministically in code (by section + question_number, with a safe
  // qnum-only fallback). No global-index fallback — it crosses wires on
  // subset-page runs.
  const match = matchExtractions(studentResults, keyResults);
  const { text: textPairs, visual: visualPairs } = partitionPairsByModality(match);

  // Shared transport (everything except model). The model is chosen
  // per task type — text compare uses textComparisonModel, visual
  // compare uses visualComparisonModel — so we don't put it on the
  // shared transport.
  const baseTransport = {
    apiKey: state.settings.openaiKey,
    apiMode: state.settings.apiMode || 'direct',
    proxyEndpoint: state.settings.proxyEndpoint,
    proxyToken: state.settings.proxyToken,
  };
  const textCompareModel   = state.settings.textComparisonModel   || state.settings.openaiModel || DEFAULT_MODEL;
  const visualCompareModel = state.settings.visualComparisonModel || state.settings.openaiModel || DEFAULT_MODEL;

  // Stage 3b — TEXT compare: one text-only AI call covering text-style
  // pairs (text/choice/number/tick_box/unknown). Skipped when there are
  // no text pairs to compare.
  let aiTextReport = null;
  let compareError = null;
  const canRunTextCompare = textPairs.length > 0 && match.keysProvided;
  if (canRunTextCompare) {
    const idx = tasks.length;
    const li = document.createElement('li');
    li.id = `batch-${idx}`;
    li.textContent = `Request ${idx + 1}: Text compare — ${textPairs.length} pair(s), text only — sending…`;
    $('batch-list').appendChild(li);
    $('marking-status').textContent = `Text comparison (${textPairs.length} pair(s))…`;
    while (true) {
      try {
        const cmpRes = await markPairs({
          ...baseTransport,
          model: textCompareModel,
          pairs: textPairs,
          subject: state.attempt.subject,
          level: state.attempt.level,
        });
        aiTextReport = cmpRes.parsed;
        taskUsages.push(buildTaskRecord({
          task_type: TASK_TYPES.TEXT_COMPARISON,
          model: textCompareModel,
          label: `Text compare — ${textPairs.length} pair(s)`,
          pages: [],
          usage: cmpRes.usage,
          settings: state.settings,
        }));
        li.classList.add('done');
        li.textContent = `Request ${idx + 1}: Text compare — done`;
        break;
      } catch (e) {
        console.error('Text compare failed', e);
        li.classList.add('failed');
        li.textContent = `Request ${idx + 1}: Text compare — failed: ${e.message}`;
        const retry = confirm(
          `Text comparison failed:\n${e.message}\n\n` +
          `OK = retry.\nCancel = fall back to local string-equality (paraphrases will be marked incorrect).`
        );
        if (retry) {
          li.classList.remove('failed');
          li.textContent = `Request ${idx + 1}: Text compare — sending…`;
          continue;
        }
        compareError = e.message;
        break;
      }
    }
  }

  // Stage 3c — VISUAL compare: one vision call per drawing / diagram
  // question, comparing the completed page image against the answer-sheet
  // page image. We use full pages (no crop) for MVP and rely on the
  // prompt to scope the model's attention to the named question.
  const visualResults = [];
  if (visualPairs.length > 0 && match.keysProvided) {
    const completedByPage = new Map(completedPagesAll.map((p) => [p.pageNumber, p]));
    const answerByPage = new Map(answerImages.map((p) => [p.pageNumber, p]));
    let vCount = 0;
    for (const pair of visualPairs) {
      if (state.cancelMarking) break;
      vCount++;
      const idx = tasks.length + (canRunTextCompare ? 1 : 0) + (vCount - 1);
      const li = document.createElement('li');
      li.id = `batch-${idx}`;
      li.textContent = `Request ${idx + 1}: Visual compare ${pair.display_question || pair.question} — sending…`;
      $('batch-list').appendChild(li);
      $('marking-status').textContent = `Visual comparison ${vCount} of ${visualPairs.length} (${pair.display_question || pair.question})…`;
      const cPageEntry = pair.completed_page ? completedByPage.get(pair.completed_page) : null;
      const aPageEntry = pair.answer_page ? answerByPage.get(pair.answer_page) : null;
      if (!cPageEntry || !aPageEntry) {
        const detail = `completed p.${pair.completed_page ?? '?'}=${!!cPageEntry}, answer p.${pair.answer_page ?? '?'}=${!!aPageEntry}`;
        visualResults.push({ pair, error: `Page image not available (${detail}).` });
        li.classList.add('failed');
        li.textContent = `Request ${idx + 1}: Visual compare ${pair.display_question || pair.question} — skipped (${detail})`;
        continue;
      }
      try {
        const res = await compareVisualPair({
          ...baseTransport,
          model: visualCompareModel,
          pair,
          completedImageDataUrl: cPageEntry.dataUrl,
          answerImageDataUrl: aPageEntry.dataUrl,
        });
        visualResults.push({ pair, parsed: res.parsed });
        taskUsages.push(buildTaskRecord({
          task_type: TASK_TYPES.VISUAL_COMPARISON,
          model: visualCompareModel,
          label: `Visual compare ${pair.display_question || pair.question}`,
          pages: [pair.completed_page, pair.answer_page].filter((n) => n != null),
          usage: res.usage,
          settings: state.settings,
        }));
        li.classList.add('done');
        li.textContent = `Request ${idx + 1}: Visual compare ${pair.display_question || pair.question} — done`;
      } catch (e) {
        console.error('Visual compare failed', e);
        visualResults.push({ pair, error: e.message });
        li.classList.add('failed');
        li.textContent = `Request ${idx + 1}: Visual compare ${pair.display_question || pair.question} — failed: ${e.message}`;
      }
    }
  }

  // Stage 4 — merge text + visual results into the final report. Local
  // string-equality fallback is applied to any text pair the AI didn't
  // grade (used when the text compare call failed).
  const merged = buildFinalReport({ match, aiTextReport, visualResults });
  const compareUsedAi = !!aiTextReport;

  // Compare-stage request count: 1 if the text compare ran + N for each
  // visual pair. Visual pairs without page images don't trigger a request
  // but still contribute an unclear row in the report.
  const visualRequestsAttempted = visualResults.filter((v) => v.parsed || v.error).length;
  const visualRequestsSucceeded = visualResults.filter((v) => v.parsed).length;
  const extraCompareRequestCount = (canRunTextCompare ? 1 : 0) + visualRequestsAttempted;
  const extraCompareCompleted = (compareUsedAi ? 1 : 0) + visualRequestsSucceeded;

  const stopped = cancelledAfterIndex != null;
  const skippedCount = stopped ? tasks.length - cancelledAfterIndex : 0;
  if (failedTasks.length > 0 || stopped || compareError || (visualRequestsAttempted > visualRequestsSucceeded)) {
    merged.app_warnings = {
      incomplete: true,
      batches_total: tasks.length + extraCompareRequestCount,
      batches_completed: (tasks.length - failedTasks.length - skippedCount) + extraCompareCompleted,
      failed_batches: [
        ...failedTasks.map((t) => ({
          index: t.index,
          pages: t.pages,
          error: `${t.kind === 'answer_key' ? 'Answer key' : 'Student answers'}: ${t.error}`,
        })),
        ...visualResults.filter((v) => v.error).map((v) => ({
          index: -1,
          pages: [v.pair.completed_page, v.pair.answer_page].filter(Boolean),
          error: `Visual compare ${v.pair.display_question || v.pair.question}: ${v.error}`,
        })),
      ],
      stopped_by_user: stopped,
      stopped_skipped_count: skippedCount,
      missing_answer_key: keyResults.length === 0 && answerImages.length > 0,
      compare_fell_back_to_local: compareError ? true : false,
      compare_error: compareError || null,
    };
  }
  if (keyResults.length === 0 && answerImages.length === 0) {
    merged.summary.comment = (merged.summary.comment ? merged.summary.comment + ' ' : '') +
      'No answer pages were specified, so questions are listed but not compared. Open Setup → Pages to add an Answer pages range and submit again.';
  } else if (compareError) {
    merged.summary.comment = (merged.summary.comment ? merged.summary.comment + ' ' : '') +
      'Final comparison call failed; results below were scored by local string equality (paraphrased answers may show as incorrect).';
  }

  // Cost / usage — each task carries its own frozen pricing snapshot
  // (taken at request time via buildTaskRecord), so the total is just
  // the sum of per-task estimated_cost_usd values. Old reports keep
  // their original prices regardless of later Setup edits.
  //
  // The per-attempt marking report intentionally holds ONLY:
  //   student_extraction, answer_key_extraction,
  //   text_comparison, visual_comparison.
  // Detection cost lives on the paper profile, not here (Stage E).
  const totals = aggregateTasks(taskUsages);
  merged.app_usage = {
    tasks: taskUsages,
    totals,
    estimated_cost_usd: totals.estimated_cost_usd,
    estimated_input_cost_usd: totals.estimated_input_cost_usd,
    estimated_uncached_input_cost_usd: totals.estimated_uncached_input_cost_usd,
    estimated_cached_input_cost_usd: totals.estimated_cached_input_cost_usd,
    estimated_output_cost_usd: totals.estimated_output_cost_usd,
    models: totals.models,
  };

  // Stash the raw extractions so the parent can inspect via "Show raw JSON".
  merged.app_extractions = {
    student: studentResults,
    answer_key: keyResults,
  };

  state.reportJson = merged;
  state.attempt.reportJson = merged;
  state.attempt.status = (failedTasks.length > 0 || stopped) ? 'partially_marked' : 'marked';
  await putAttempt(state.attempt);

  showReport(merged);
}

function abortMarking(reason) {
  $('marking-status').textContent = reason;
}

function onBackToSetup() {
  // Preserve the attempt; just navigate to Setup with the current values
  // pre-filled so the parent can edit and click Resume practice.
  // Detach the ink controller so the canvas isn't holding pointer capture
  // when we leave the practice stage.
  if (state.inkController) { state.inkController.detach(); state.inkController = null; }
  try {
    fillSetupFormFromAttempt();
  } catch (e) {
    console.error('fillSetupFormFromAttempt failed', e);
  }
  exitFullscreenPractice();
  setStage('setup');
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
  $('download-report-pdf').addEventListener('click', async (ev) => {
    if (!state.reportJson) return;
    const btn = ev.currentTarget;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Generating PDF…';
    try {
      const blob = await exportReportPdf(state.reportJson, { pdfName: state.attempt?.pdfName });
      triggerDownload(blob, fileBaseName(state.attempt?.pdfName) + '-report.pdf');
    } catch (e) {
      console.error('Report PDF export failed', e);
      alert('Report PDF export failed: ' + (e?.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });
  $('download-attempt-pdf').addEventListener('click', async (ev) => {
    if (!state.flattenedCompletedPages) {
      alert('Completed pages are only available right after marking.');
      return;
    }
    const btn = ev.currentTarget;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Generating PDF…';
    try {
      const blob = await exportCompletedAttemptPdf(state.flattenedCompletedPages);
      triggerDownload(blob, fileBaseName(state.attempt?.pdfName) + '-completed.pdf');
    } catch (e) {
      console.error('Attempt PDF export failed', e);
      alert('Attempt PDF export failed: ' + (e?.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
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
    notAttemptedEl: $('report-not-attempted'),
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
