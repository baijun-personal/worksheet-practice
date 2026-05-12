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
  paperFreshness, snapshotPaperOntoAttempt, paperFromIdentity,
} from './paper.js';
import { loadPdfFromBlob, renderPageToCanvas } from './pdfRender.js';
import { attachInkController, redrawAll } from './draw.js';
import { flattenQuestionPage, renderStrokesOnlyPage, renderAnswerPage, colorContentRatio } from './flatten.js';
import {
  extractStudentAnswers, extractAnswerKey, markPairs, compareVisualPair,
  requestExplanation, MODEL_PRESETS, DEFAULT_MODEL, presetForModel,
  BUILTIN_PROMPTS,
} from './openai.js';
import { matchExtractions, buildFinalReport, partitionPairsByModality, normalizeQNumber } from './compare.js';
import { renderReport, exportReportPdf, exportCompletedAttemptPdf } from './report.js';
import { loadCatalog, fetchBuiltinPdf, builtinAttemptId } from './builtin.js';
import { composeFourUpA4, composeContactSheetA4, chunkInto } from './fourup.js';
import { buildTaskRecord, aggregateTasks, TASK_TYPES } from './cost.js';
import { runPageDetection, rangesFromPages } from './detect.js';
import {
  renderReviewPage, pagesWithReviews, recordIndex,
  buildPageStats, buildPageListRows,
  popupBodyHtml, popupTitle, lowConfidenceBannerHtml,
} from './review.js';

const STAGES = ['unlock', 'setup', 'practice', 'marking', 'report', 'review'];

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

// Defensive setters used during prefill — safely no-op when an
// element is absent. Important after schema upgrades where the user
// may have a stale cached HTML that lacks newly-added inputs: a
// crash in prefill would otherwise abort bindSetupForm before
// listeners (incl. Start practice) get registered.
function setVal(id, value) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`setVal: missing element #${id} (stale HTML?)`);
    return false;
  }
  el.value = value;
  return true;
}
function setChecked(id, checked) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`setChecked: missing element #${id} (stale HTML?)`);
    return false;
  }
  el.checked = !!checked;
  return true;
}

// Brief visual confirmation that a settings write landed. Used on
// the prompt textareas specifically — the regular inputs / selects
// were never ambiguous because focus moves quickly, but a long
// textarea edit can run for minutes and the parent had no signal
// that the keystrokes were being persisted. Flash a green ✓ chip
// next to the element for ~800ms after each save.
//
// Implementation: lazily inject one .saved-chip element after the
// target on first call, then toggle a .visible class. Restricted
// to textareas via tagName check — no point flashing on selects
// where focus loss is the natural confirmation.
function flashSavedNear(el) {
  if (!el || el.tagName !== 'TEXTAREA') return;
  let chip = el.nextElementSibling && el.nextElementSibling.classList?.contains('saved-chip')
    ? el.nextElementSibling
    : null;
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'saved-chip';
    chip.textContent = '✓ saved';
    el.parentNode?.insertBefore(chip, el.nextSibling);
  }
  chip.classList.add('visible');
  clearTimeout(chip._fadeTimer);
  chip._fadeTimer = setTimeout(() => chip.classList.remove('visible'), 800);
}

// Custom-prompt textareas in Settings pre-fill with the built-in
// prompt text (BUILTIN_PROMPTS) so reviewers can see what's being
// sent without grepping the source. When saving, if the textarea
// content matches the built-in verbatim (after trimming trailing
// whitespace on each line — textareas often add/strip a trailing
// newline), persist '' instead of the full built-in text. This
// preserves the pickPrompt(custom, builtin) semantic where empty
// = follow built-in, so future edits to the built-in prompt in
// openai.js keep flowing through to users who haven't customised.
function normalizeCustomPrompt(textareaValue, builtin) {
  const v = String(textareaValue ?? '');
  if (!v.trim()) return '';
  if (v === builtin) return '';
  if (v.replace(/\s+$/, '') === String(builtin || '').replace(/\s+$/, '')) return '';
  return v;
}

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
  // Mirror the immersive class onto <html> so CSS can lock both
  // body AND html scrolling. iPad Safari sometimes scrolls the
  // <html> element itself (rather than body) when the viewport
  // changes, and that scroll is what triggers the URL-bar reveal /
  // fullscreen exit. Locking both keeps all gestures inside
  // #page-stage.
  document.documentElement.classList.add('app-immersive-html');
  swapToolbarLabels(true);
  refreshFullscreenToggleLabel();
  // CSS-only immersive on Safari (any flavour). Calling
  // requestFullscreen on documentElement on Safari has two known
  // problems for this app:
  //   - position:fixed children of an HTML in :fullscreen sometimes
  //     end up rendered outside the fullscreen layer, making the
  //     toolbar non-interactive.
  //   - Safari iOS doesn't actually hide its URL bar / bottom chrome
  //     for non-video fullscreen — it only changes the layer
  //     compositing, with no real visual gain.
  // Both desktop Chrome and Edge handle the API cleanly, so we still
  // call it there. Add-to-Home-Screen is the path for sealed iPad
  // immersive (handled separately).
  const root = document.documentElement;
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  const isSafari = isSafariBrowser();
  if (!isSafari && typeof req === 'function') {
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

// Detect Safari (desktop or iOS). Chrome / Edge / Firefox spoof the
// Safari UA on iOS but include "CriOS" / "EdgiOS" / "FxiOS" tokens
// — exclude those. We use this to skip Fullscreen API calls that
// trigger Safari-specific bugs (toolbar position:fixed children
// rendered outside the fullscreen layer, becoming non-interactive).
function isSafariBrowser() {
  const ua = navigator.userAgent || '';
  // Safari iOS / iPadOS reports "Safari" without "CriOS" / "EdgiOS" / "FxiOS".
  // iPadOS 13+ also reports as Mac with touch points.
  const isAppleDevice =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isMacSafari = /^((?!chrome|android|crios|edgios|fxios).)*safari/i.test(ua);
  return isAppleDevice || isMacSafari;
}

// Update the Fullscreen toggle button's label to reflect the current
// state: "Fullscreen" / short "FS" when not immersive, "Exit" when
// immersive. Called on every transition.
function refreshFullscreenToggleLabel() {
  const btn = $('fullscreen-toggle-btn');
  if (!btn) return;
  const inImmersive = document.body.classList.contains('app-immersive');
  if (inImmersive) {
    btn.dataset.short = 'Exit';
    btn.textContent = 'Exit';
    btn.title = 'Exit full-screen practice mode';
  } else {
    btn.dataset.short = 'FS';
    btn.textContent = 'Fullscreen';
    btn.title = 'Enter full-screen practice mode';
  }
}

// Swap practice-toolbar buttons that carry a `data-short` attribute
// between their long label (non-immersive) and the short label
// (immersive). Long is stashed in `data-long` on first toggle so we
// can swap back. Keeps the toolbar single-row in fullscreen on iPad.
function swapToolbarLabels(toShort) {
  const buttons = document.querySelectorAll('.practice-toolbar button[data-short]');
  for (const btn of buttons) {
    if (toShort) {
      if (!btn.dataset.long) btn.dataset.long = btn.textContent.trim();
      btn.textContent = btn.dataset.short;
    } else if (btn.dataset.long) {
      btn.textContent = btn.dataset.long;
    }
  }
}

async function exitFullscreenPractice() {
  document.body.classList.remove('app-immersive');
  document.documentElement.classList.remove('app-immersive-html');
  swapToolbarLabels(false);
  refreshFullscreenToggleLabel();
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

// --- Build-version badge --------------------------------------------------
// GitHub Pages serves a Last-Modified header on every file based on the
// commit time of that file in the deployed branch. Reading it costs one
// HEAD request and gives us a free build timestamp without any build
// tooling. Display it in the topbar as a relative time so the user can
// tell at a glance whether they're on the latest deploy.

async function showBuildVersion() {
  const btn = $('build-version-btn');
  if (!btn) return;
  try {
    // Cache-bust the HEAD itself so we don't read a stale cache entry.
    const url = `src/main.js?_v=${Date.now()}`;
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    const lm = res.headers.get('Last-Modified');
    if (!lm) {
      btn.textContent = 'build ?';
      return;
    }
    const built = new Date(lm);
    const renderRelative = () => {
      btn.textContent = 'build ' + relativeTime(built);
      btn.title = `main.js Last-Modified: ${built.toLocaleString()} (${lm}). Click to force-refresh past the cache.`;
      // Highlight if older than ~24h — likely an old browser cache
      // (GitHub Pages should serve fresh files within a minute or two
      // of a push).
      if (Date.now() - built.getTime() > 24 * 60 * 60 * 1000) {
        btn.classList.add('stale');
      } else {
        btn.classList.remove('stale');
      }
    };
    renderRelative();
    // Re-render every minute so "5 min ago" stays accurate.
    setInterval(renderRelative, 60_000);
  } catch (e) {
    console.warn('showBuildVersion failed:', e);
    btn.textContent = 'build ?';
  }
}

// Show the "Add to Home Screen" banner on iPad Safari (regular tab
// — not standalone). iPadOS edge gestures (URL bar reveal, dock,
// multitasking, back swipe) override page touch handlers in normal
// browser tabs; the only way to fully seal them off is to launch
// the app from the home-screen icon (PWA-style standalone mode).
//
// Hint is dismissed permanently per-device by writing a flag to
// localStorage so the parent isn't nagged on every visit.
function setupIosAddToHomeHint() {
  const banner = $('ios-add-to-home-hint');
  if (!banner) return;
  const dismissKey = 'wsp.iosAddToHomeDismissed.v1';
  if (localStorage.getItem(dismissKey) === '1') return;
  // Detect standalone (Add-to-Home-Screen / PWA) mode. Two signals,
  // either is sufficient:
  //   - navigator.standalone: legacy iOS-only flag, set when launched
  //     from a home-screen icon.
  //   - matchMedia('(display-mode: standalone)'): modern, cross-browser
  //     PWA detection — matches when the manifest's display:standalone
  //     is honoured.
  const isStandalone =
    window.navigator.standalone === true ||
    (typeof window.matchMedia === 'function' &&
     window.matchMedia('(display-mode: standalone)').matches);
  if (isStandalone) return;
  // Detect iPad / iPhone / iPod. iPadOS 13+ reports as Mac with
  // touch — sniff by ua + maxTouchPoints to catch the modern case.
  const ua = navigator.userAgent || '';
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIOS) return;
  banner.hidden = false;
  $('ios-add-to-home-dismiss')?.addEventListener('click', () => {
    banner.hidden = true;
    try { localStorage.setItem(dismissKey, '1'); } catch {}
  });
}

function relativeTime(date) {
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 14) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

// Force a reload that bypasses the HTTP cache for HTML and as much
// of the linked-resource cache as we can reach from JavaScript.
// Safari's reload button often serves stale cached ES modules; this
// is a more aggressive last-resort.
async function forceReloadWithCacheBust() {
  // 1. Clear the Cache Storage API (used by service workers / PWAs).
  //    GitHub Pages doesn't ship a SW, but if one ever lands, this
  //    keeps a path to escape from a stuck stale build.
  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) { console.warn('caches.delete failed:', e); }
  }
  // 2. Unregister any service worker.
  if ('serviceWorker' in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    } catch (e) { console.warn('SW unregister failed:', e); }
  }
  // 3. Append ?_v=<now> to the URL and reload. The new query string
  //    forces browsers to treat the HTML as fresh, and the chained
  //    module imports in the new HTML will revalidate against the
  //    server's ETag/Last-Modified headers (GitHub Pages serves both).
  const url = new URL(window.location.href);
  url.searchParams.set('_v', String(Date.now()));
  window.location.replace(url.toString());
}

// --- Init -----------------------------------------------------------------

// We're loaded by an async inline bootstrap in index.html that fetches
// main.js's Last-Modified header before injecting the <script>. By the
// time this module evaluates, DOMContentLoaded may already have fired —
// in which case the addEventListener below would never trigger and the
// app would never initialise. Run init() immediately if the DOM is
// already past loading; otherwise wait for the event.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // Defer one microtask so the rest of this module's top-level statements
  // (state, els, helpers) are fully initialized before init() runs.
  Promise.resolve().then(init);
}

async function init() {
  els.autosave = $('autosave-indicator');
  els.autosavePractice = $('autosave-indicator-practice');
  setAutosave('saved');

  // Fire-and-forget: stamp the build-version badge in the topbar
  // with main.js's Last-Modified header so the parent always knows
  // which deploy they're on. The badge click does a cache-busting
  // reload — Safari's hard refresh is unreliable.
  showBuildVersion();
  $('build-version-btn')?.addEventListener('click', forceReloadWithCacheBust);

  // Surface the Add-to-Home-Screen hint on iPad Safari (regular
  // tab) — the only way to get truly sealed fullscreen on iPad.
  setupIosAddToHomeHint();

  // Phase 6 telemetry: also flush on tab close so we don't lose
  // the per-session counters if the parent doesn't navigate back
  // to the report. Console-only — no network telemetry per plan.
  window.addEventListener('beforeunload', logExplanationTelemetrySummary);

  // Keep our `app-immersive` class in sync if the user exits full-screen via
  // the OS shortcut (Esc on desktop, swipe on iPad).
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      document.body.classList.remove('app-immersive');
      document.documentElement.classList.remove('app-immersive-html');
      swapToolbarLabels(false);
      refreshFullscreenToggleLabel();
    }
  });
  document.addEventListener('webkitfullscreenchange', () => {
    if (!document.webkitFullscreenElement) {
      document.body.classList.remove('app-immersive');
      document.documentElement.classList.remove('app-immersive-html');
      swapToolbarLabels(false);
      refreshFullscreenToggleLabel();
    }
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
  bindReviewUI();
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
    // Use the inner page-wrap (the actual worksheet) to decide
    // whether scroll is needed, NOT stage.scrollHeight. The stage
    // gets bottom-padding in immersive mode (room for the page-nav
    // bar + safe-area), which artificially inflates scrollHeight
    // even when the worksheet itself fits — making rails appear
    // for nothing-to-scroll content.
    const wrap = document.getElementById('page-wrap');
    const contentH = wrap ? wrap.offsetHeight : stage.scrollHeight;
    const contentW = wrap ? wrap.offsetWidth  : stage.scrollWidth;

    // Vertical
    if (contentH > stage.clientHeight + 1) {
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
    if (contentW > stage.clientWidth + 1) {
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

  // Prefill settings inputs. Each prefill is guarded so that a single
  // missing element (e.g. user has a stale cached index.html that
  // lacks the new per-task model selects) doesn't abort the whole
  // bindSetupForm and leave Start practice unbound.
  setVal('openai-key', state.settings.openaiKey || '');
  setVal('openai-model', state.settings.openaiModel || DEFAULT_MODEL);
  applyModelToControls(state.settings.openaiModel || DEFAULT_MODEL);
  setVal('model-detection',      state.settings.detectionModel        || state.settings.openaiModel || DEFAULT_MODEL);
  setVal('model-extraction',     state.settings.extractionModel       || state.settings.openaiModel || DEFAULT_MODEL);
  setVal('model-text-compare',   state.settings.textComparisonModel   || state.settings.openaiModel || DEFAULT_MODEL);
  setVal('model-visual-compare', state.settings.visualComparisonModel || state.settings.openaiModel || DEFAULT_MODEL);
  setVal('model-explanation',    state.settings.explanationModel      || state.settings.openaiModel || DEFAULT_MODEL);
  setVal('render-dpi', String(state.settings.renderDpi || 150));
  setVal('explanation-render-dpi', String(state.settings.explanationRenderDpi || 150));
  setVal('batch-size', String(state.settings.batchSize || 5));
  setChecked('test-mode', !!state.settings.testMode);
  setVal('price-in', String(state.settings.priceInPerMTokens ?? 0.75));
  setVal('price-cached-in', String(state.settings.priceCachedInPerMTokens ?? 0.075));
  setVal('price-out', String(state.settings.priceOutPerMTokens ?? 4.50));
  setVal('marking-mode', state.settings.markingMode || 'batch4_fourup');
  setVal('practice-marking-mode', state.settings.practiceMarkingMode || 'batch4_fourup');
  // Mode radio + the "Practice marking mode" sub-section (hidden in
  // final mode). When the parent flips between the two, we re-show the
  // sub-section on the fly. attempt.mode is stamped at attempt
  // creation; mid-attempt mode switching isn't supported.
  const initialMode = state.settings.mode || 'final';
  for (const r of document.querySelectorAll('input[name="practice-mode"]')) {
    r.checked = (r.value === initialMode);
  }
  applyPracticeModeVisibility(initialMode);
  for (const r of document.querySelectorAll('input[name="practice-mode"]')) {
    r.addEventListener('change', () => {
      const v = r.checked ? r.value : null;
      if (!v) return;
      state.settings = saveSettings({ mode: v });
      applyPracticeModeVisibility(v);
    });
  }
  // Custom prompt overrides — pre-fill with the built-in prompt
  // text so reviewers can see what's being sent without grepping
  // the source. Saved overrides win when present; empty falls
  // back to the built-in. normalizeCustomPrompt at save time
  // detects an unchanged textarea (matches built-in verbatim)
  // and persists '' so future edits to the built-in propagate
  // automatically. See the 9-textarea fieldset in Setup →
  // Advanced.
  setVal('custom-student-prompt',                  state.settings.customStudentPrompt            || BUILTIN_PROMPTS.student);
  setVal('custom-student-prompt-single',           state.settings.customStudentPromptSingle      || BUILTIN_PROMPTS.studentSingle);
  setVal('custom-answer-key-prompt',               state.settings.customAnswerKeyPrompt          || BUILTIN_PROMPTS.answerKey);
  setVal('custom-compare-prompt',                  state.settings.customComparePrompt            || BUILTIN_PROMPTS.compare);
  setVal('custom-compare-visual-prompt',           state.settings.customCompareVisualPrompt      || BUILTIN_PROMPTS.compareVisual);
  setVal('custom-page-detection-prompt',           state.settings.customPageDetectionPrompt      || BUILTIN_PROMPTS.pageDetection);
  setVal('custom-explanation-prompt-base',         state.settings.customExplanationPromptBase    || BUILTIN_PROMPTS.explanationBase);
  setVal('custom-explanation-variant-why',         state.settings.customExplanationVariantWhy    || BUILTIN_PROMPTS.explanationVariantWhy);
  setVal('custom-explanation-variant-show-steps',  state.settings.customExplanationVariantShowSteps || BUILTIN_PROMPTS.explanationVariantShowSteps);
  setVal('custom-explanation-variant-give-hint',   state.settings.customExplanationVariantGiveHint  || BUILTIN_PROMPTS.explanationVariantGiveHint);

  // Reset-to-default buttons next to each prompt textarea: re-fill
  // the textarea with the built-in prompt. The user still has to
  // confirm-and-save (Start practice persists the form state via
  // saveSettings); after that the on-change normalizer notices the
  // textarea matches BUILTIN_PROMPTS again and persists '' so the
  // setting falls back to following the built-in.
  for (const btn of document.querySelectorAll('.prompt-reset')) {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      const targetId = btn.getAttribute('data-target');
      const key = btn.getAttribute('data-builtin');
      const ta = targetId ? document.getElementById(targetId) : null;
      const builtin = key ? BUILTIN_PROMPTS[key] : null;
      if (ta && builtin != null) {
        ta.value = builtin;
        // Dispatch a synthetic 'change' so the change-listener
        // loop above persists the reset immediately via
        // normalizeCustomPrompt (textarea matches built-in →
        // saved as '').
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }

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
    ['explanation-render-dpi', 'explanationRenderDpi', (v) => parseInt(v, 10) || 150],
    ['batch-size', 'batchSize', (v) => Math.max(1, parseInt(v, 10) || 5)],
    ['price-in', 'priceInPerMTokens', (v) => Math.max(0, parseFloat(v) || 0)],
    ['price-cached-in', 'priceCachedInPerMTokens', (v) => Math.max(0, parseFloat(v) || 0)],
    ['price-out', 'priceOutPerMTokens', (v) => Math.max(0, parseFloat(v) || 0)],
    ['marking-mode', 'markingMode', (v) => v || 'batch4_fourup'],
    ['practice-marking-mode', 'practiceMarkingMode', (v) => v || 'batch4_fourup'],
    ['model-detection',      'detectionModel',        (v) => v.trim() || DEFAULT_MODEL],
    ['model-extraction',     'extractionModel',       (v) => v.trim() || DEFAULT_MODEL],
    ['model-text-compare',   'textComparisonModel',   (v) => v.trim() || DEFAULT_MODEL],
    ['model-visual-compare', 'visualComparisonModel', (v) => v.trim() || DEFAULT_MODEL],
    ['model-explanation',    'explanationModel',      (v) => v.trim() || DEFAULT_MODEL],
    // Custom prompt overrides — route every textarea-change save
    // through normalizeCustomPrompt so an unchanged pre-filled
    // textarea persists as '' (= "use built-in") rather than as
    // the full built-in text. Keeps future built-in edits in
    // openai.js flowing to users who haven't customised.
    ['custom-student-prompt',                'customStudentPrompt',               (v) => normalizeCustomPrompt(v, BUILTIN_PROMPTS.student)],
    ['custom-student-prompt-single',         'customStudentPromptSingle',         (v) => normalizeCustomPrompt(v, BUILTIN_PROMPTS.studentSingle)],
    ['custom-answer-key-prompt',             'customAnswerKeyPrompt',             (v) => normalizeCustomPrompt(v, BUILTIN_PROMPTS.answerKey)],
    ['custom-compare-prompt',                'customComparePrompt',               (v) => normalizeCustomPrompt(v, BUILTIN_PROMPTS.compare)],
    ['custom-compare-visual-prompt',         'customCompareVisualPrompt',         (v) => normalizeCustomPrompt(v, BUILTIN_PROMPTS.compareVisual)],
    ['custom-page-detection-prompt',         'customPageDetectionPrompt',         (v) => normalizeCustomPrompt(v, BUILTIN_PROMPTS.pageDetection)],
    ['custom-explanation-prompt-base',       'customExplanationPromptBase',       (v) => normalizeCustomPrompt(v, BUILTIN_PROMPTS.explanationBase)],
    ['custom-explanation-variant-why',       'customExplanationVariantWhy',       (v) => normalizeCustomPrompt(v, BUILTIN_PROMPTS.explanationVariantWhy)],
    ['custom-explanation-variant-show-steps','customExplanationVariantShowSteps', (v) => normalizeCustomPrompt(v, BUILTIN_PROMPTS.explanationVariantShowSteps)],
    ['custom-explanation-variant-give-hint', 'customExplanationVariantGiveHint',  (v) => normalizeCustomPrompt(v, BUILTIN_PROMPTS.explanationVariantGiveHint)],
  ]) {
    const el = document.getElementById(id);
    if (!el) {
      console.warn(`bindSetupForm: missing element #${id} (stale HTML?). Skipping listener.`);
      continue;
    }
    // Bind BOTH 'change' and 'input'. For <textarea>, 'change' only
    // fires on blur — so a paste-then-switch-tabs flow (common with
    // the prompt textareas) never persisted until the textarea lost
    // focus. 'input' fires on every keystroke / paste / programmatic
    // value-set, so we catch the mid-edit case too. For <select> and
    // numeric/text <input>, 'input' and 'change' are effectively the
    // same; the duplicate save is cheap (localStorage write of one
    // settings object) and harmless.
    const onPersist = () => {
      state.settings = saveSettings({ [key]: parser(el.value) });
      flashSavedNear(el);
    };
    el.addEventListener('change', onPersist);
    el.addEventListener('input', onPersist);
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

  // Auto-classify pages — page-level AI detection (Stage F).
  $('auto-classify-btn').addEventListener('click', onAutoClassifyClick);
  updateAutoClassifyButton();
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
  const ids = ['model-detection', 'model-extraction', 'model-text-compare', 'model-visual-compare', 'model-explanation'];
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
  // Clear paper-profile and detection state too — switching source
  // means the next loaded PDF gets a fresh resolve. Without this,
  // a stale state.detectionResult from the previous PDF could
  // cause the page-classify panel to claim "detection ran" against
  // a paper it didn't actually run on.
  state.paperProfile = null;
  state.paperIdentity = null;
  state.detectionResult = null;
  state.paperStaleWarning = null;
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

// Show / hide the Practice marking mode sub-section based on the
// current top-level mode toggle. The sub-section only matters when
// the parent picks 'practice'; in 'final' it's irrelevant.
function applyPracticeModeVisibility(mode) {
  const extra = $('practice-mode-extra');
  if (extra) extra.hidden = (mode !== 'practice');
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
    // If a confirmed paper profile already exists for this PDF, the
    // chip picker prefills from it; the manual inputs are hidden.
    if (state.paperProfile?.confirmed_by_user) {
      applyConfirmedPagesPickerVisibility();
    }
    state.detectionResult = null;
    renderPageClassifyPanel();
    updateAutoClassifyButton();
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
        `(stored hash/size differs from loaded PDF).`
      );
      // Surface the staleness to the parent in the UI rather than
      // letting them silently use a profile against a different PDF
      // version. confirmed_by_user is reset so the practice picker
      // shows the manual inputs (not the locked chip view), and the
      // "Auto-classify status" line carries the message right above
      // the per-page editor where they'd act on it.
      paper = { ...paper, confirmed_by_user: false };
      paper = await putPaper(paper);
      // Defer the status display until the panel is rendered (which
      // happens after this function returns). setStaleWarning gets
      // checked + cleared at panel-render time.
      state.paperStaleWarning =
        'This paper appears to have changed since you confirmed its page setup. ' +
        'Re-confirm the page types or click Re-detect to re-classify.';
    } else {
      state.paperStaleWarning = null;
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

// Enable / disable the Auto-classify button based on whether a PDF
// is loaded. The button additionally requires either an API key (in
// direct mode) or a proxy URL+token (proxy mode); we don't enforce
// that here — the call itself surfaces a clear error if either is
// missing.
function updateAutoClassifyButton() {
  const btn = $('auto-classify-btn');
  if (!btn) return;
  btn.disabled = !state.pdf;
}

async function onAutoClassifyClick() {
  if (!state.pdf || !state.pdfBlob) {
    setAutoClassifyStatus('Pick a PDF first.', 'error');
    return;
  }
  const apiMode = state.settings.apiMode || 'direct';
  if (apiMode === 'proxy') {
    if (!state.settings.proxyEndpoint || !state.settings.proxyToken) {
      setAutoClassifyStatus('Proxy URL and token must be set in Advanced settings.', 'error');
      return;
    }
  } else if (!state.settings.openaiKey) {
    setAutoClassifyStatus('OpenAI API key must be set in Advanced settings.', 'error');
    return;
  }
  const btn = $('auto-classify-btn');
  btn.disabled = true;
  setAutoClassifyStatus(`Classifying ${state.pdf.numPages} pages…`, '');
  try {
    const detectionModel = state.settings.detectionModel || state.settings.openaiModel || DEFAULT_MODEL;
    const result = await runPageDetection({
      pdf: state.pdf,
      apiKey: state.settings.openaiKey,
      model: detectionModel,
      apiMode,
      proxyEndpoint: state.settings.proxyEndpoint,
      proxyToken: state.settings.proxyToken,
      settings: state.settings,
    });
    state.detectionResult = result;
    // Stamp results onto the paper profile (in memory + IndexedDB).
    // For first-time uploads the profile may not exist yet — create
    // one from state.paperIdentity + the detection result.
    let paper = state.paperProfile;
    if (!paper) {
      if (!state.paperIdentity) {
        throw new Error('Internal error: paperIdentity missing — re-pick the PDF and retry.');
      }
      paper = paperFromIdentity(state.paperIdentity, $('pdf-status').textContent || '');
    }
    const merged = mergeDetectionIntoPaper(paper, result);
    state.paperProfile = await putPaper(merged);
    // Reflect derived ranges in the form so the parent can see them
    // and edit if needed even before clicking Confirm.
    $('question-pages').value = pageArrayToRange(state.paperProfile.question_pages);
    $('answer-pages').value = pageArrayToRange(state.paperProfile.answer_pages);
    const counts = result.pages.reduce((acc, p) => {
      acc[p.type] = (acc[p.type] || 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ');
    setAutoClassifyStatus(
      `Done. ${summary}. Detection cost: $${result.costRecord.estimated_cost_usd.toFixed(4)} ` +
      `(model ${result.costRecord.model}). Review the per-page table below, edit any types you disagree with, then click Confirm page setup.`,
      'ok',
    );
    renderPageClassifyPanel();
  } catch (e) {
    console.error('Auto-classify failed:', e);
    const msg = String(e?.message || e);
    if (/429|rate.?limit/i.test(msg)) {
      setAutoClassifyStatus('OpenAI is rate-limiting. Wait a moment and try again.', 'error');
    } else {
      setAutoClassifyStatus(`Detection failed: ${msg}`, 'error');
    }
  } finally {
    btn.disabled = false;
  }
}

function setAutoClassifyStatus(text, kind) {
  const el = $('auto-classify-status');
  if (!el) return;
  el.textContent = text || '';
  let cls;
  if (kind === 'error')      cls = 'error';
  else if (kind === 'warn')  cls = 'warn-text';
  else if (kind === 'ok')    cls = 'ok-text';
  else                       cls = 'muted';
  el.className = 'small ' + cls;
}

// Merge a detection result into a paper profile, recomputing the
// question/answer page-range arrays from the page types. Detection
// cost is appended to setup_costs so the paper profile keeps a record
// of how much each detection pass cost — separate from per-attempt
// marking cost (Stage C).
function mergeDetectionIntoPaper(paper, detectionResult) {
  const pages = detectionResult.pages || [];
  const { question_pages, answer_pages } = rangesFromPages(pages);
  return {
    ...paper,
    pages,
    question_pages,
    answer_pages,
    // Detection ran fresh — back to unconfirmed until the parent
    // explicitly confirms in Stage G's UI.
    confirmed_by_user: false,
    setup_costs: [...(paper.setup_costs || []), detectionResult.costRecord],
  };
}

// Per-page confirmation UI. Driven by state.paperProfile.pages so a
// fresh paper profile (no detection ever run) can also use this view
// — the table will simply show 'unknown' for every page.
//
// Edits flow:
//   - Each page row has a <select> for its type.
//   - On change, the page is updated in state.paperProfile.pages,
//     manually_edited is set true, the question/answer-page ranges are
//     recomputed and reflected in both the form and the saved paper
//     profile, and confirmed_by_user is reset to false (an edit
//     invalidates a previous confirm).
// Confirm / Re-detect / Use manual:
//   - Confirm sets confirmed_by_user true and saves.
//   - Re-detect re-runs detection (warns that manual edits will be
//     overwritten).
//   - Use manual collapses the editor; user types ranges by hand.
const PAGE_TYPE_OPTIONS = [
  'question', 'answer_key', 'passage', 'composition',
  'cover', 'instruction', 'section_divider', 'blank', 'unknown',
];

function renderPageClassifyPanel() {
  const panel = $('page-classify-panel');
  if (!panel) return;
  const paper = state.paperProfile;
  if (!paper || !Array.isArray(paper.pages) || paper.pages.length === 0) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  // detectionRan is the right signal for "the AI saw this" — curated
  // metadata (paperFromBuiltinCatalog) marks question / answer pages
  // with confidence:1 too, so we can't infer detection from confidence
  // alone. setup_costs is appended only when AI detection actually ran.
  const detectionRan = !!state.detectionResult || (paper.setup_costs?.length || 0) > 0;
  const unknownCount = paper.pages.filter((p) => p.type === 'unknown').length;
  // Only count low-confidence among pages the AI actually classified
  // (confidence > 0 AND not 'unknown'). Otherwise unknown pages would
  // double-count: they have confidence 0 and would always be flagged.
  const lowConfCount = paper.pages.filter((p) =>
    p.type !== 'unknown' && (p.confidence || 0) > 0 && (p.confidence || 0) < 0.7
  ).length;

  let summaryLine;
  if (detectionRan) {
    summaryLine = `Detected ${paper.pages.length} pages — ` +
      `${lowConfCount} low-confidence, ${unknownCount} unknown.`;
  } else if (unknownCount > 0) {
    // Curated metadata only — the catalog gave us question + answer
    // ranges, but doesn't know which of the remaining pages are
    // covers / blanks / dividers / etc. They're typed 'unknown'.
    summaryLine = `${paper.pages.length} pages from curated metadata — ` +
      `${unknownCount} not yet classified (likely covers, blank pages, or section dividers). ` +
      `Click Auto-classify above to fill them in, or pick a type per row below.`;
  } else {
    summaryLine = `${paper.pages.length} pages — all classified from curated metadata.`;
  }

  const rangeLine = `Question pages: ${pageArrayToRange(paper.question_pages) || '(none)'}; ` +
                    `Answer pages: ${pageArrayToRange(paper.answer_pages) || '(none)'}.`;

  const rows = paper.pages.map((p) => {
    const lowConf = Number.isFinite(p.confidence) && p.confidence < 0.7 && p.confidence > 0;
    const isUnknown = p.type === 'unknown';
    const rowClass = (isUnknown || lowConf) ? 'class="warning-row"' : '';
    const confText = Number.isFinite(p.confidence) && p.confidence > 0
      ? p.confidence.toFixed(2)
      : (p.manually_edited ? 'manual' : '—');
    const flagBits = [];
    if (isUnknown) flagBits.push('unknown');
    if (lowConf) flagBits.push(`low ${confText}`);
    if (p.manually_edited) flagBits.push('edited');
    const flag = flagBits.length ? ' (' + flagBits.join(', ') + ')' : '';
    const opts = PAGE_TYPE_OPTIONS.map((t) =>
      `<option value="${t}"${t === p.type ? ' selected' : ''}>${t}</option>`
    ).join('');
    return `<tr ${rowClass}>
      <td style="white-space:nowrap">p.${p.page}${flag}</td>
      <td><select data-page="${p.page}" class="page-type-select" style="font-size:13px">${opts}</select></td>
      <td>${escapeAttr(p.reason || '')}</td>
    </tr>`;
  }).join('');

  const confirmedTag = paper.confirmed_by_user
    ? '<span class="muted small">✓ confirmed</span>'
    : '<span class="muted small">not yet confirmed</span>';

  // Stale-paper banner. Set in resolvePaperProfile when the
  // stored profile's pdf_hash / byte length doesn't match the
  // currently-loaded PDF. Cleared once shown so the parent isn't
  // nagged again after they re-confirm.
  const staleBanner = state.paperStaleWarning
    ? `<div class="warning" style="margin:8px 0">
         <strong>This paper appears to have changed.</strong>
         ${escapeAttr(state.paperStaleWarning.replace(/^This paper appears to have changed\.\s*/, ''))}
       </div>`
    : '';

  panel.hidden = false;
  panel.innerHTML = `
    <details open style="margin-top:12px; border:1px solid var(--border); border-radius:6px; padding:8px 12px">
      <summary><strong>Page setup</strong> — ${summaryLine} ${confirmedTag}</summary>
      ${staleBanner}
      <p class="muted small" style="margin:8px 0">${escapeAttr(rangeLine)}</p>
      <div class="actions" style="margin:8px 0">
        <button id="confirm-pages-btn" type="button" class="primary">Confirm page setup</button>
        <button id="redetect-pages-btn" type="button">Re-detect</button>
        <button id="manual-pages-btn" type="button">Use manual page ranges instead</button>
      </div>
      <p class="muted small" id="confirm-pages-status"></p>
      <table style="margin-top:8px; width:100%"><thead><tr>
        <th style="text-align:left">Page</th>
        <th style="text-align:left">Type</th>
        <th style="text-align:left">Reason</th>
      </tr></thead><tbody>${rows}</tbody></table>
    </details>`;
  // The stale banner is one-shot — clear after rendering so any
  // future render (after confirm / re-detect) doesn't keep showing.
  if (state.paperStaleWarning) state.paperStaleWarning = null;

  // Wire row-level edits.
  for (const sel of panel.querySelectorAll('.page-type-select')) {
    sel.addEventListener('change', onPageTypeChange);
  }
  $('confirm-pages-btn').addEventListener('click', onConfirmPages);
  $('redetect-pages-btn').addEventListener('click', onRedetectClick);
  $('manual-pages-btn').addEventListener('click', onUseManualPagesClick);
}

async function onPageTypeChange(ev) {
  const paper = state.paperProfile;
  if (!paper) return;
  const pageNum = Number(ev.currentTarget.dataset.page);
  const newType = String(ev.currentTarget.value);
  const idx = paper.pages.findIndex((p) => p.page === pageNum);
  if (idx < 0) return;
  paper.pages[idx] = {
    ...paper.pages[idx],
    type: newType,
    manually_edited: true,
    // confidence unchanged — this reflects the AI's confidence at
    // detection time. The "edited" flag marks human override.
  };
  // Recompute derived ranges and sync form.
  const { question_pages, answer_pages } = rangesFromPages(paper.pages);
  paper.question_pages = question_pages;
  paper.answer_pages = answer_pages;
  paper.confirmed_by_user = false; // edit invalidates a prior confirm
  state.paperProfile = await putPaper(paper);
  $('question-pages').value = pageArrayToRange(paper.question_pages);
  $('answer-pages').value = pageArrayToRange(paper.answer_pages);
  // Re-render to refresh confirmed-tag and warning row classes.
  renderPageClassifyPanel();
}

async function onConfirmPages() {
  const paper = state.paperProfile;
  if (!paper) return;
  // Sanity-check before confirming: at least one question page must
  // exist. If there's no answer key, that's allowed (warned at
  // submission time) but worth surfacing here too.
  const issues = [];
  if (!paper.question_pages || paper.question_pages.length === 0) {
    issues.push('No question pages selected — at least one is required.');
  }
  if (!paper.answer_pages || paper.answer_pages.length === 0) {
    issues.push('No answer pages selected. Marking will skip the answer-key compare stage.');
  }
  if (issues.some((s) => /required/.test(s))) {
    setConfirmStatus(issues.join(' '), 'error');
    return;
  }
  // Two-step confirm when there are non-blocking warnings: first
  // click surfaces the warning visibly, second click commits. This
  // catches the case where a parent has accidentally not selected
  // any answer pages on a paper that should have them.
  if (issues.length > 0 && state._confirmPagesWarnedFor !== paper.paper_id) {
    state._confirmPagesWarnedFor = paper.paper_id;
    setConfirmStatus(
      `Warning: ${issues.join(' ')} Click Confirm again to proceed anyway.`,
      'warn',
    );
    return;
  }
  state._confirmPagesWarnedFor = null;
  paper.confirmed_by_user = true;
  state.paperProfile = await putPaper(paper);
  setConfirmStatus(
    issues.length > 0
      ? `Confirmed with warning: ${issues.join(' ')}`
      : `Confirmed. Practice picker will use these pages.`,
    issues.length > 0 ? 'warn' : 'ok',
  );
  renderPageClassifyPanel();
  applyConfirmedPagesPickerVisibility();
}

// Toggle between the manual range inputs and the chip picker based
// on whether the current paper profile is confirmed. Stage H spec:
// once a paper is confirmed, hide the answer-pages input (it's on
// the profile and used internally for marking) and let the parent
// pick a subset of question pages via chips. All chips selected by
// default; click to toggle.
function applyConfirmedPagesPickerVisibility() {
  const paper = state.paperProfile;
  const confirmed = !!paper?.confirmed_by_user;
  $('manual-pages-wrap').hidden = confirmed;
  $('confirmed-pages-wrap').hidden = !confirmed;
  if (!confirmed) return;

  // First time we show the chips for this paper, default to "all
  // selected". Subsequent renders preserve the user's selection.
  if (!state.selectedQuestionPages
      || state.selectedQuestionPagesPaperId !== paper.paper_id) {
    state.selectedQuestionPages = new Set(paper.question_pages);
    state.selectedQuestionPagesPaperId = paper.paper_id;
  }
  // Drop any pages that are no longer question pages (profile
  // edited), keep selections that still apply.
  const valid = new Set(paper.question_pages);
  for (const p of [...state.selectedQuestionPages]) {
    if (!valid.has(p)) state.selectedQuestionPages.delete(p);
  }

  const row = $('question-page-chips');
  row.innerHTML = '';
  for (const p of paper.question_pages) {
    const selected = state.selectedQuestionPages.has(p);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.setAttribute('role', 'option');
    chip.setAttribute('aria-selected', selected ? 'true' : 'false');
    chip.textContent = `p.${p}`;
    chip.dataset.page = String(p);
    chip.addEventListener('click', onQuestionChipClick);
    row.appendChild(chip);
  }

  // Internal-only: write through to hidden inputs so the existing
  // onStartPractice() code path keeps working (it parses the inputs).
  syncConfirmedPagesToInputs();
  updateConfirmedPagesMeta();
}

function onQuestionChipClick(ev) {
  const p = Number(ev.currentTarget.dataset.page);
  if (!p) return;
  if (state.selectedQuestionPages.has(p)) {
    state.selectedQuestionPages.delete(p);
    ev.currentTarget.setAttribute('aria-selected', 'false');
  } else {
    state.selectedQuestionPages.add(p);
    ev.currentTarget.setAttribute('aria-selected', 'true');
  }
  syncConfirmedPagesToInputs();
  updateConfirmedPagesMeta();
}

function syncConfirmedPagesToInputs() {
  const paper = state.paperProfile;
  if (!paper) return;
  const sel = [...(state.selectedQuestionPages || [])].sort((a, b) => a - b);
  $('question-pages').value = pageArrayToRange(sel);
  $('answer-pages').value   = pageArrayToRange(paper.answer_pages || []);
}

function updateConfirmedPagesMeta() {
  const paper = state.paperProfile;
  const sel = state.selectedQuestionPages || new Set();
  const meta = $('confirmed-pages-meta');
  if (!paper || !meta) return;
  const total = paper.question_pages?.length || 0;
  const aPages = paper.answer_pages?.length || 0;
  meta.textContent =
    `${sel.size} of ${total} question page(s) selected. ` +
    (aPages > 0
      ? `${aPages} answer page(s) on the profile (used internally; not shown for practice).`
      : `No answer pages on the profile — marking will skip the answer-key compare stage.`);
}

async function onRedetectClick() {
  const paper = state.paperProfile;
  const editedCount = paper?.pages?.filter((p) => p.manually_edited).length || 0;
  if (editedCount > 0) {
    const ok = confirm(
      `Re-detection will overwrite the AI classifications on every page, ` +
      `including the ${editedCount} page(s) you've manually edited. Manual edits will be lost.\n\n` +
      `Continue?`
    );
    if (!ok) return;
  }
  await onAutoClassifyClick();
}

function onUseManualPagesClick() {
  // Collapse the editor and force the manual-input view back, even
  // if a paper profile was already confirmed. The profile isn't
  // discarded — the parent can re-open the editor by re-running
  // Auto-classify. This is a "let me just type the ranges" escape
  // hatch.
  const panel = $('page-classify-panel');
  if (panel) panel.hidden = true;
  $('manual-pages-wrap').hidden = false;
  $('confirmed-pages-wrap').hidden = true;
  setAutoClassifyStatus(
    'Using manual page ranges. Edit Question pages / Answer pages above as needed. Auto-classify can be re-run later.',
    'ok',
  );
}

function setConfirmStatus(text, kind) {
  const el = $('confirm-pages-status');
  if (!el) return;
  el.textContent = text || '';
  // 'error' (red), 'warn' (amber), 'ok' (green), default neutral.
  let cls;
  if (kind === 'error')      cls = 'error';
  else if (kind === 'warn')  cls = 'warn-text';
  else if (kind === 'ok')    cls = 'ok-text';
  else                       cls = 'muted';
  el.className = 'small ' + cls;
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
    if (state.paperProfile?.confirmed_by_user) {
      applyConfirmedPagesPickerVisibility();
    }
    state.detectionResult = null;
    renderPageClassifyPanel();
    updateAutoClassifyButton();
    runColorCheck();
  } catch (e) {
    $('pdf-status').textContent = 'Failed to load PDF: ' + (e?.message || e);
  }
}

async function onStartPractice() {
  try {
    return await onStartPracticeImpl();
  } catch (e) {
    console.error('onStartPractice failed:', e);
    const errEl = $('page-range-error');
    if (errEl) {
      errEl.hidden = false;
      errEl.textContent = 'Could not start practice: ' + (e?.message || String(e));
    } else {
      alert('Could not start practice: ' + (e?.message || String(e)));
    }
  }
}

async function onStartPracticeImpl() {
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
  // API-key/proxy preflight. The "ready to mark?" question depends on
  // which API mode the user picked:
  //   - direct: needs an OpenAI key on this device
  //   - proxy:  needs a proxy URL + token; the OpenAI key lives on
  //             the Worker server-side, not here.
  // We were unconditionally asking for openaiKey, so users in proxy
  // mode (key on the Worker, not in the form) saw a misleading
  // "No OpenAI API key set" prompt. Branch on apiMode instead.
  const apiKey = $('openai-key').value.trim();
  const apiModeSel = (document.querySelector('input[name="api-mode"]:checked')?.value) || 'direct';
  const proxyEndpoint = $('proxy-endpoint').value.trim();
  const proxyToken = $('proxy-token').value;
  if (apiModeSel === 'proxy') {
    if (!proxyEndpoint || !proxyToken) {
      if (!confirm(
        'Proxy mode is selected but the Proxy URL or token is empty. ' +
        'You can still practise, but submitting for marking will fail. Continue?'
      )) return;
    }
  } else if (!apiKey) {
    if (!confirm('No OpenAI API key set. You can still practise, but submitting for marking will fail. Continue?')) return;
  }
  state.settings = saveSettings({
    openaiKey: apiKey,
    openaiModel: $('openai-model').value.trim() || DEFAULT_MODEL,
    renderDpi: parseInt($('render-dpi').value, 10) || 150,
    explanationRenderDpi: parseInt($('explanation-render-dpi').value, 10) || 150,
    batchSize: Math.max(1, parseInt($('batch-size').value, 10) || 5),
    testMode: $('test-mode').checked,
    priceInPerMTokens: Math.max(0, parseFloat($('price-in').value) || 0),
    priceCachedInPerMTokens: Math.max(0, parseFloat($('price-cached-in').value) || 0),
    priceOutPerMTokens: Math.max(0, parseFloat($('price-out').value) || 0),
    markingMode: $('marking-mode').value || 'batch4_fourup',
    practiceMarkingMode: $('practice-marking-mode').value || 'batch4_fourup',
    mode: (document.querySelector('input[name="practice-mode"]:checked')?.value) || 'final',
    apiMode: (document.querySelector('input[name="api-mode"]:checked')?.value) || 'direct',
    proxyEndpoint: $('proxy-endpoint').value.trim(),
    proxyToken: $('proxy-token').value,
    // Custom prompt overrides — value as-typed, but route through
    // normalizeCustomPrompt: when the textarea matches the built-in
    // verbatim (modulo trailing whitespace), persist '' so future
    // edits to the built-in in openai.js propagate automatically.
    // pickPrompt(custom, builtin) treats '' as "use built-in".
    customStudentPrompt:                normalizeCustomPrompt($('custom-student-prompt').value,                BUILTIN_PROMPTS.student),
    customStudentPromptSingle:          normalizeCustomPrompt($('custom-student-prompt-single').value,         BUILTIN_PROMPTS.studentSingle),
    customAnswerKeyPrompt:              normalizeCustomPrompt($('custom-answer-key-prompt').value,             BUILTIN_PROMPTS.answerKey),
    customComparePrompt:                normalizeCustomPrompt($('custom-compare-prompt').value,                BUILTIN_PROMPTS.compare),
    customCompareVisualPrompt:          normalizeCustomPrompt($('custom-compare-visual-prompt').value,         BUILTIN_PROMPTS.compareVisual),
    customPageDetectionPrompt:          normalizeCustomPrompt($('custom-page-detection-prompt').value,         BUILTIN_PROMPTS.pageDetection),
    customExplanationPromptBase:        normalizeCustomPrompt($('custom-explanation-prompt-base').value,       BUILTIN_PROMPTS.explanationBase),
    customExplanationVariantWhy:        normalizeCustomPrompt($('custom-explanation-variant-why').value,       BUILTIN_PROMPTS.explanationVariantWhy),
    customExplanationVariantShowSteps:  normalizeCustomPrompt($('custom-explanation-variant-show-steps').value, BUILTIN_PROMPTS.explanationVariantShowSteps),
    customExplanationVariantGiveHint:   normalizeCustomPrompt($('custom-explanation-variant-give-hint').value,  BUILTIN_PROMPTS.explanationVariantGiveHint),
  });

  const subject = $('meta-subject').value.trim();
  const level = $('meta-level').value.trim();

  // Update path: if there's an active attempt, just rewrite its metadata
  // from the current form values and resume practice. Strokes saved on
  // pages that fall outside the new question range stay in IndexedDB but
  // are no longer visible (and won't be sent for marking).
  if (state.attempt) {
    // Practice-mode cache invalidation. If the parent edits pages /
    // subject / level mid-attempt AND practice marking has already
    // produced state, the cached extractions + report would silently
    // grade pages the parent has now removed (or use a stale answer
    // key). Prompt to clear before applying the change. The
    // practiceMarkingMode setting is NOT a cache invalidator — it
    // only affects how NEW pages are extracted.
    if (practiceCacheWouldInvalidate(questionPages, answerPages, subject, level)) {
      const ok = await confirmInPage(
        "You've already marked some pages in this practice attempt. " +
        'Changing pages, subject, or level will clear the practice ' +
        'progress and the existing report. Continue?',
        { okLabel: 'Clear and continue', danger: true }
      );
      if (!ok) return;
      state.attempt.practice = {
        markedPages: [],
        cached_student_extractions_by_page: {},
        cached_answer_key_extraction: null,
        cached_compare_rows_by_pair_key: {},
        cached_visual_rows_by_pair_key: {},
        latest_report: null,
      };
      state.attempt.reportJson = null;
      state.reportJson = null;
      state.attempt.status = 'in_progress';
    }
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

  // Create attempt. snapshotPaperOntoAttempt copies the paper_id +
  // pages onto the attempt — the form-supplied questionPages /
  // answerPages override the paper's defaults to honour any chip-
  // picker subset selection. Profile edits AFTER this snapshot
  // can't retroactively mutate this attempt's stroke layout (Stage
  // E spec).
  // Stamp the attempt's mode from settings AT CREATION TIME. Mid-
  // attempt mode switching isn't supported — the practice cache shape
  // (extraction-per-page, comparator-row-per-pair) wouldn't make
  // sense after a partial run in the other mode. settings.mode is the
  // "default for next new attempt"; attempt.mode is the actual mode.
  const attemptMode = state.settings.mode === 'practice' ? 'practice' : 'final';
  let attempt = {
    id: attemptId,
    createdAt: Date.now(),
    pdfName,
    builtinId,
    pdfBlob: state.sourceMode === 'upload' ? state.pdfBlob : null,
    pdfPath: state.sourceMode === 'builtin' ? state.selectedWorksheet.pdfPath : null,
    subject,
    level,
    currentPage: questionPages[0],
    reportJson: null,
    status: 'in_progress',
    mode: attemptMode,
    // Practice-mode persistence. null in final mode. In practice mode
    // we accumulate page-level extraction results across mark-up-to-here
    // sessions so each click only pays the vision-extraction cost for
    // NEW pages (the answer key is also extracted once across all
    // sessions). The shape is documented at the call sites in
    // onMarkUpToHere.
    practice: attemptMode === 'practice'
      ? {
          markedPages: [],
          cached_student_extractions_by_page: {},
          cached_answer_key_extraction: null,
          cached_compare_rows_by_pair_key: {},
          cached_visual_rows_by_pair_key: {},
          latest_report: null,
        }
      : null,
  };
  attempt = snapshotPaperOntoAttempt(state.paperProfile, attempt, { questionPages, answerPages });
  state.attempt = attempt;
  await putAttempt(state.attempt);
  state.currentPage = questionPages[0];
  updateStartPracticeButton();
  setStage('practice');
  await loadCurrentPage();
  enterFullscreenPractice();
}

// --- Practice -------------------------------------------------------------

// Pick the default writing tool based on what input devices the
// browser advertises. Desktops with a real mouse + hover get
// 'type' — typing extracts at effectively 100% accuracy and is the
// natural input on a keyboard-equipped device. Tablets / phones /
// pen-primary devices get 'pen' — drawing matches what the child
// does on paper.
//
// We use the MQ4 `(any-hover: hover)` query, NOT `(hover: hover)`.
// The bare `hover` form tests the PRIMARY pointing device, which on
// touchscreen Windows laptops, ChromeBooks, Surface devices, etc. is
// often reported as "coarse / no-hover" by Chrome even when a real
// mouse is plugged in. The `any-hover` variant is true whenever
// AT LEAST ONE input device can hover — covers desktops, laptops,
// touchscreen-plus-mouse, and iPads with the Magic Keyboard trackpad.
// It's false on phones, finger-only tablets, and stylus-only setups
// (Apple Pencil reports "fine pointer" but not "hover").
//
// Failsafe: if matchMedia is missing or throws, fall back to 'pen' —
// the original default, safer for touch devices than mistakenly
// summoning the on-screen keyboard.
function defaultToolForEnvironment() {
  try {
    if (typeof window === 'undefined' || !window.matchMedia) return 'pen';
    if (window.matchMedia('(any-hover: hover)').matches) return 'type';
    return 'pen';
  } catch {
    return 'pen';
  }
}

// Set state.tool from the environment heuristic and reflect that on
// the toolbar by toggling the .active class onto the right button.
// Called once at app init (before the user opens a worksheet) and
// re-called when the practice stage is entered, so the choice is
// applied even on the first-ever load before any toolbar interaction.
function applyDefaultTool() {
  const tool = defaultToolForEnvironment();
  state.tool = tool;
  for (const b of document.querySelectorAll('.tool-btn')) {
    b.classList.toggle('active', b.dataset.tool === tool);
  }
  // One-line diagnostic so a parent debugging "why is pen active
  // on my desktop?" can confirm what the heuristic saw. Hard-refresh
  // and check DevTools Console.
  try {
    const anyHover = window.matchMedia
      ? window.matchMedia('(any-hover: hover)').matches
      : 'n/a';
    console.info(`[default-tool] picked '${tool}' (any-hover: hover = ${anyHover})`);
  } catch {}
}

function bindPracticeUI() {
  // Pick a sensible default tool for this device BEFORE wiring any
  // listeners — the toolbar HTML is parsed by now so the .active
  // class swap is safe.
  applyDefaultTool();

  for (const btn of document.querySelectorAll('.tool-btn')) {
    btn.addEventListener('click', () => {
      // Switching away from Type while a typing session is active
      // should commit the in-progress text — same semantics as
      // tapping elsewhere on the page.
      const prevTool = state.tool;
      const nextTool = btn.dataset.tool;
      if (prevTool === 'type' && nextTool !== 'type'
          && state.inkController && typeof state.inkController.commitTyping === 'function') {
        state.inkController.commitTyping();
      }
      state.tool = nextTool;
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
  $('mark-up-to-here-btn').addEventListener('click', onMarkUpToHere);
  $('continue-practising-btn').addEventListener('click', onContinuePractising);
  $('back-to-setup-btn').addEventListener('click', onBackToSetup);
  $('fullscreen-toggle-btn').addEventListener('click', () => {
    if (document.body.classList.contains('app-immersive')) {
      exitFullscreenPractice();
    } else {
      enterFullscreenPractice();
    }
    refreshFullscreenToggleLabel();
  });
  refreshFullscreenToggleLabel();

  document.addEventListener('keydown', (ev) => {
    if (state.stage !== 'practice') return;
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
    if (ev.key === 'p') document.querySelector('[data-tool="pen"]').click();
    else if (ev.key === 'e') document.querySelector('[data-tool="eraser"]').click();
    else if (ev.key === 't') document.querySelector('[data-tool="type"]')?.click();
    else if (ev.key === 'c') document.querySelector('[data-tool="circle"]')?.click();
    else if (ev.key === 'v') document.querySelector('[data-tool="tick"]')?.click();
    else if ((ev.ctrlKey || ev.metaKey) && ev.key === 'z') {
      ev.preventDefault();
      // Skip the IndexedDB read entirely on frozen pages — the
      // handler-level guard catches it too but stopping here also
      // saves the no-op stroke fetch.
      if (!isCurrentPageFrozen()) onUndo();
    }
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
  // Flush any in-progress typed text before leaving the page,
  // otherwise the caret stays "live" on the next page and the
  // student's draft would commit at the wrong coordinates. Await
  // the IDB write so the next-page render doesn't race against an
  // in-flight stroke save.
  if (state.inkController && typeof state.inkController.commitTyping === 'function') {
    await state.inkController.commitTyping();
  }
  // Clear the practice-mode marking status pill — the most recent
  // "Marked. Review on the right." applied to the page we're
  // leaving, not the one we're arriving on.
  setPracticeMarkStatus('');
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

  const inkCtx = inkCanvas.getContext('2d', { willReadFrequently: true });
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
    // Type-tool DOM dependencies. Both live inside #page-wrap (same
    // CSS coordinate space as the ink canvas) and are added in
    // index.html. attachInkController defends against null so older
    // cached HTML without these elements still loads.
    typeInput:   document.getElementById('type-input'),
    typeOverlay: document.getElementById('type-overlay'),
    pageWrap:    document.getElementById('page-wrap'),
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

  // Practice-mode UI: show / hide the Mark-up-to-here button, the
  // frozen-page banner, and disable the toolbar tools on frozen
  // pages. In final mode this is a no-op (everything stays visible
  // as before). Runs after the page renders so the ink canvas /
  // tool buttons reflect the right state for THIS page.
  applyPracticeStateForPage();

  // The rendered page just changed size; re-sync the custom scroll rails.
  refreshScrollRails();
}

// Practice-mode per-page UI state. Three surfaces:
//   - "Mark up to here" button visible only in practice mode AND when
//     the current page (and at least one page before it) is unmarked.
//   - "Submit for marking" button hidden in practice mode (Mark up to
//     here takes its place; there's no "all at once" path in practice).
//   - Frozen-page banner + tool-button disable state when the current
//     page is in markedPages.
function applyPracticeStateForPage() {
  const isPractice = state.attempt?.mode === 'practice';
  const submitBtn = $('submit-btn');
  const markBtn = $('mark-up-to-here-btn');
  const banner = $('frozen-page-banner');
  const rail = $('practice-review-rail');
  const stagePractice = $('stage-practice');
  if (submitBtn) submitBtn.hidden = !!isPractice;
  if (!isPractice) {
    if (markBtn) markBtn.hidden = true;
    if (banner) banner.hidden = true;
    if (rail) { rail.hidden = true; rail.innerHTML = ''; }
    if (stagePractice) stagePractice.classList.remove('frozen-page');
    setToolButtonsDisabled(false);
    return;
  }
  const markedPages = new Set(state.attempt?.practice?.markedPages || []);
  const isFrozen = markedPages.has(state.currentPage);
  if (markBtn) {
    markBtn.hidden = isFrozen;
    markBtn.textContent = `Mark pages 1 to ${pageNumberLabel(state.currentPage)}`;
    markBtn.title = isFrozen
      ? 'This page is already marked.'
      : 'Mark all unmarked question pages up to (and including) the current page.';
  }
  if (banner) {
    banner.hidden = !isFrozen;
    const detail = $('frozen-page-banner-detail');
    if (detail) {
      const marksCount = markedPages.size;
      detail.textContent = marksCount > 0
        ? `${marksCount} page${marksCount === 1 ? '' : 's'} marked so far.`
        : '';
    }
  }
  if (stagePractice) stagePractice.classList.toggle('frozen-page', isFrozen);
  setToolButtonsDisabled(isFrozen);
  // Populate the practice-mode review rail on frozen pages so the
  // child sees what went wrong on THIS page without leaving the
  // practice stage. Same content shape as the final-report review
  // rail (Stage 3 per-page stats on top + Stage 1 wrong-answer rows
  // below); clicking a row opens the existing Review Mode popup.
  renderPracticeReviewRail(rail, isFrozen);
}

function renderPracticeReviewRail(rail, isFrozen) {
  if (!rail) return;
  if (!isFrozen) {
    rail.hidden = true;
    rail.innerHTML = '';
    return;
  }
  // Source the report from the live attempt (survives a refresh
  // because attempt.reportJson / attempt.practice.latest_report are
  // persisted to IndexedDB on every mark-up-to-here).
  const report =
    state.reportJson ||
    state.attempt?.reportJson ||
    state.attempt?.practice?.latest_report ||
    null;
  if (!report) {
    rail.hidden = true;
    rail.innerHTML = '';
    return;
  }
  const questions = Array.isArray(report.questions) ? report.questions : [];
  const reviewRecords = Array.isArray(report.review_records) ? report.review_records : [];
  // Mirror state.reportJson so onOpenReviewPopup (which reads from
  // state.reportJson) can resolve the per-question detail when the
  // user clicks a row. Idempotent — harmless if already set.
  state.reportJson = report;

  rail.innerHTML = '';

  // Did this report actually have an answer key? On no-key papers
  // every row's expected_answer is empty, so "no mistakes" would be
  // a lie (nothing was checked). Detect by scanning the actual
  // rows / records — more reliable than threading match.keysProvided
  // through every render call.
  const hasAnyKey =
    (reviewRecords || []).some(
      (r) => r.expected_answer && String(r.expected_answer).trim().length > 0
    ) ||
    questions.some(
      (q) => q.expected_answer && String(q.expected_answer).trim().length > 0
    );

  // Per-page stats block — same component as the final-report rail.
  // Skip on no-answer-key papers: the denominator would be misleading
  // (every row would be unclear-by-construction).
  const stats = buildPageStats(questions);
  // Show only THIS page's mark — not the whole-paper roll-up. The
  // child is looking at one page at a time in practice mode; the
  // cumulative report is one page-nav-prev away and the across-pages
  // view lives in the final report after the last mark.
  const currentStat = stats.find((s) => s.page === Number(state.currentPage));
  if (currentStat && hasAnyKey) {
    const wrap = document.createElement('div');
    wrap.className = 'page-stats-block';
    wrap.innerHTML = `
      <div class="page-stats-row">
        <div class="page-stats-pill current">
          <span class="page-stats-page">Page ${currentStat.page}</span>
          <span class="page-stats-score">Marks ${currentStat.correct}/${currentStat.total}</span>
        </div>
      </div>`;
    rail.appendChild(wrap);
  }

  // Wrong-answer rows for THIS page, in question-number order.
  const rows = buildPageListRows(reviewRecords, state.currentPage);
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted small';
    empty.style.marginTop = '6px';
    empty.textContent = hasAnyKey
      ? 'No mistakes on this page — nice work!'
      : "No answer key was provided, so this page can't be reviewed.";
    rail.appendChild(empty);
  } else {
    for (const row of rows) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'review-list-row';
      btn.innerHTML =
        `<span class="review-list-q">${escapeRailText(row.questionLabel)}</span>` +
        `<span class="review-list-ans">${escapeRailText(row.inline)}</span>`;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        // openReviewPopup expects state.review to hold the records
        // array + page list (it reads activeRecord and the page idx
        // for the "1/N" counter). Final-mode review stage sets this
        // up in onOpenReviewMode; in practice mode we mirror the
        // setup here so the popup works identically on a frozen
        // page without leaving the practice stage.
        state.review = {
          records: reviewRecords,
          pages: pagesWithReviews(reviewRecords),
          pageIdx: 0,
          activeRecord: null,
        };
        openReviewPopup(row.record);
      });
      rail.appendChild(btn);
    }
  }
  rail.hidden = false;
}

function escapeRailText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setToolButtonsDisabled(disabled) {
  for (const btn of document.querySelectorAll('.practice-toolbar .tool-btn, #undo-btn, #clear-page-btn')) {
    btn.disabled = disabled;
  }
}

// Render the visible page label the way the practice toolbar shows it
// ("Mark pages 1 to N" where N is the 1-based index INTO the
// question-pages array, not the raw PDF page number). Falls back to
// the PDF page number if the page isn't in the question-pages array.
function pageNumberLabel(currentPage) {
  const qp = state.attempt?.questionPages || [];
  const idx = qp.indexOf(currentPage);
  return idx >= 0 ? String(idx + 1) : String(currentPage);
}

// Is the current practice-mode page already marked? Frozen pages
// MUST stay byte-identical with the cached extraction/report —
// otherwise the report would reference strokes that no longer
// exist. Used by onUndo / onClearPage / Ctrl+Z to bail before any
// stroke mutation. Returns false for final-mode attempts and for
// any non-frozen page.
function isCurrentPageFrozen() {
  if (!state.attempt) return false;
  if (state.attempt.mode !== 'practice') return false;
  const marked = state.attempt.practice?.markedPages || [];
  return marked.includes(state.currentPage);
}

// Stable cache key for a matched pair, used to look up cached
// comparator results. Built from raw fields that don't change when
// later pages are added:
//   - completed_page (the student's page — never changes after the
//     page is marked)
//   - normalised question_number
//   - _syntheticSection (stable per question_number once
//     assignSyntheticSections has assigned it; later pages can only
//     add NEW sections, never renumber existing ones)
//   - answer_page (stable because the answer key is cached once and
//     never re-extracted within a practice session)
// The pair object as returned by matchExtractions today carries
// all four; defensive '' fallbacks prevent undefined-keying.
function pairCacheKey(pair) {
  return `cp=${pair.completed_page ?? ''}`
       + `|q=${normalizeQNumber(pair.question || '')}`
       + `|ss=${pair._syntheticSection ?? ''}`
       + `|ap=${pair.answer_page ?? ''}`;
}

// Would the proposed new pages / subject / level change invalidate
// the practice attempt's existing cache? Returns true only if BOTH
// (a) there's practice cache state worth clearing AND
// (b) at least one cache-relevant field actually differs.
// Used by onStartPracticeImpl to prompt before applying a change
// that would otherwise silently grade against stale data.
function practiceCacheWouldInvalidate(newQ, newA, newSubject, newLevel) {
  const a = state.attempt;
  if (!a || a.mode !== 'practice') return false;
  const practice = a.practice;
  if (!practice) return false;
  const hasState =
    (practice.markedPages?.length || 0) > 0
    || Object.keys(practice.cached_student_extractions_by_page || {}).length > 0
    || practice.cached_answer_key_extraction != null
    || practice.latest_report != null;
  if (!hasState) return false;
  const sameArr = (x, y) =>
    (x?.length || 0) === (y?.length || 0)
    && (x || []).every((v, i) => v === y[i]);
  return !sameArr(a.questionPages || [], newQ)
      || !sameArr(a.answerPages || [], newA)
      || (a.subject || '') !== (newSubject || '')
      || (a.level || '') !== (newLevel || '');
}

async function onUndo() {
  if (!state.attempt) return;
  // Defense in depth: even though the Undo button is disabled on
  // frozen pages, Ctrl+Z / synthetic clicks / future code paths
  // could still call onUndo. Bail before mutating IndexedDB.
  if (isCurrentPageFrozen()) return;
  const strokes = await getStrokesForPage(state.attempt.id, state.currentPage);
  if (strokes.length === 0) return;
  const last = strokes[strokes.length - 1];
  await deleteStroke(state.attempt.id, last.id);
  const remaining = strokes.slice(0, -1);
  const inkCanvas = $('ink-canvas');
  redrawAll(inkCanvas.getContext('2d', { willReadFrequently: true }), remaining, {
    widthPx: inkCanvas.width,
    heightPx: inkCanvas.height,
    pageWidthPts: state.pageMeta.pageWidthPts,
  });
}

async function onClearPage() {
  if (!state.attempt) return;
  if (isCurrentPageFrozen()) return;
  // confirmInPage instead of native confirm() — iOS Safari forces an
  // exit from fullscreen whenever it shows a native dialog, breaking
  // immersive practice mode. The in-page modal stays inside the
  // fullscreened root element so the user remains immersive.
  if (!(await confirmInPage(`Clear all writing on this page?`, { okLabel: 'Clear', danger: true }))) return;
  await clearStrokesForPage(state.attempt.id, state.currentPage);
  const inkCanvas = $('ink-canvas');
  inkCanvas.getContext('2d', { willReadFrequently: true }).clearRect(0, 0, inkCanvas.width, inkCanvas.height);
}

// Lightweight in-page confirm dialog. Native confirm() forces iOS
// Safari to exit fullscreen (the system dialog needs the OS chrome
// back), so anywhere we want to stay immersive — practice-stage
// actions like Clear page — we use this instead. Returns a
// Promise<boolean>.
function confirmInPage(message, opts = {}) {
  return new Promise((resolve) => {
    const okLabel = opts.okLabel || 'OK';
    const cancelLabel = opts.cancelLabel || 'Cancel';
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.innerHTML = `
      <div class="modal-card">
        <p class="modal-msg"></p>
        <div class="modal-actions">
          <button type="button" class="modal-cancel">${escapeAttr(cancelLabel)}</button>
          <button type="button" class="modal-ok ${opts.danger ? 'danger' : 'primary'}">${escapeAttr(okLabel)}</button>
        </div>
      </div>`;
    backdrop.querySelector('.modal-msg').textContent = String(message || '');
    // Append into the fullscreen element if there is one (so the
    // modal stays inside fullscreen and inherits its stacking
    // context). Otherwise fall back to body.
    const host = document.fullscreenElement || document.body;
    host.appendChild(backdrop);
    const close = (value) => {
      backdrop.remove();
      resolve(value);
    };
    backdrop.querySelector('.modal-ok').addEventListener('click', () => close(true));
    backdrop.querySelector('.modal-cancel').addEventListener('click', () => close(false));
    // Click outside the card cancels.
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) close(false);
    });
    // Escape cancels.
    backdrop.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(false); }
      if (ev.key === 'Enter')  { ev.preventDefault(); close(true); }
    });
    // Focus the OK button so Enter / Space activates it.
    setTimeout(() => backdrop.querySelector('.modal-ok')?.focus(), 0);
  });
}

// --- Marking pipeline -----------------------------------------------------

function bindMarkingUI() {
  $('cancel-marking-btn').addEventListener('click', () => {
    state.cancelMarking = true;
  });
}

async function onSubmit() {
  if (!state.attempt) return;
  // Flush any in-progress typed text first. The Type tool keeps text
  // in an overlay until the student taps elsewhere or switches
  // tools; pressing Submit without an explicit tap-out would
  // otherwise silently discard their draft. Await the IDB write so
  // the extraction pipeline below doesn't read strokes before the
  // typed stroke lands.
  if (state.inkController && typeof state.inkController.commitTyping === 'function') {
    await state.inkController.commitTyping();
  }
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

  // Resolve marking mode. Three options:
  //   - 'single_fullpage'      — Best quality
  //   - 'batch4_fourup'        — Balanced (default)
  //   - 'batch4_fourup_single' — Most economical
  // Older saved values ('auto', 'batch4_fullpage') fall through to
  // batch4_fourup. No migration code by design.
  const mode = state.settings.markingMode || 'batch4_fourup';

  // Build the batches up front so we can show a confirmation with image counts.
  // Each "batch" is: { label, completedImages: [{pageNumber, dataUrl}], answerImages: same array each time }
  let batchesPlan; // [{ pages: number[], composite: "fullpage"|"fourup"|"fourup_single" }]
  if (mode === 'single_fullpage') {
    batchesPlan = [{ pages: qPages, composite: 'fullpage' }];
  } else if (mode === 'batch4_fourup_single') {
    batchesPlan = chunkInto(qPages, 4).map((g) => ({ pages: g, composite: 'fourup_single' }));
  } else {
    // batch4_fourup (default — also catches old saved values like
    // 'auto' or 'batch4_fullpage' since those modes no longer exist).
    batchesPlan = chunkInto(qPages, 4).map((g) => ({ pages: g, composite: 'fourup' }));
  }

  // Build the request list for the confirmation. Staged pipeline:
  //   1. Student-answer extraction request(s) — completed images only.
  //   2. Answer-key extraction request — answer-page images only (skipped
  //      if no answer pages are specified).
  //   3. Final comparison request — text-only (no images), runs only if
  //      both prior stages produced something to compare.
  // Image counts per batch:
  //   fullpage       — 2 images per page (printed + strokes-only)
  //   fourup         — 2 images per batch (printed 4-up + strokes-only 4-up)
  //   fourup_single  — 1 image per batch (printed 4-up only; no strokes-only companion)
  const studentRequestImages = batchesPlan.map((b) => {
    if (b.composite === 'fourup')         return 2;
    if (b.composite === 'fourup_single')  return 1;
    return b.pages.length * 2;
  });
  const studentRequestCount = batchesPlan.length;
  const answerKeyRequestCount = aPages.length > 0 ? 1 : 0;
  const compareRequestCount = answerKeyRequestCount > 0 ? 1 : 0;
  const totalRequests = studentRequestCount + answerKeyRequestCount + compareRequestCount;
  const totalStudentImages = studentRequestImages.reduce((a, b) => a + b, 0);
  const totalAnswerImages = aPages.length;
  const totalImages = totalStudentImages + totalAnswerImages;
  const modeLabel = humanMode(mode);
  const studentLines = batchesPlan.map((b, i) => {
    let imageDesc;
    if (b.composite === 'fourup')              imageDesc = '1 printed 4-up + 1 strokes-only 4-up (2 images)';
    else if (b.composite === 'fourup_single')  imageDesc = '1 printed 4-up image';
    else                                       imageDesc = `${b.pages.length} page(s) × 2 images (printed + strokes-only)`;
    return `  Request ${i + 1}: Student answers — ${imageDesc} covering completed pages ${b.pages.join(', ')}`;
  }).join('\n');
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

  // Re-marking starts a fresh report — clear the previous run's
  // explanation-cost history so the cost card on the new report
  // doesn't carry over Why? / Show steps / Give hint taps from
  // before. The previous report is being replaced; its
  // explanation costs go with it. The attempt record is the
  // canonical store for these, so blanking the array AND
  // persisting it ensures a reload after this point won't
  // resurrect the old taps either.
  state.attempt.explanation_costs = [];
  try { await putAttempt(state.attempt); } catch (e) {
    console.warn('Could not persist explanation-costs reset:', e);
  }

  const dpi = state.settings.renderDpi || 150;

  // Flatten all completed question pages once (cache for "download attempt").
  // Two images per page for the extraction call:
  //   dataUrl         — printed page + strokes flattened. Also feeds
  //                     the "Download completed attempt PDF" feature
  //                     and the Why?/Show steps explanation context
  //                     via state.flattenedCompletedPages below.
  //   strokesDataUrl  — white background + strokes only. Sent
  //                     alongside the printed page to the extraction
  //                     call so the model has a clean view of what
  //                     the student wrote, with no printed text to
  //                     misread as handwriting (the Q5 / "a"-from-
  //                     printed-option-label bug).
  // Both images use the same DPI and identical pixel dimensions so
  // the model can align them.
  const completedPagesAll = [];
  for (const pageNum of qPages) {
    if (state.cancelMarking) return abortMarking('Cancelled');
    const strokes = await getStrokesForPage(state.attempt.id, pageNum);
    const dataUrl = await flattenQuestionPage(state.pdf, pageNum, strokes, dpi);
    const strokesDataUrl = await renderStrokesOnlyPage(state.pdf, pageNum, strokes, dpi);
    completedPagesAll.push({ pageNumber: pageNum, dataUrl, strokesDataUrl, strokes });
    $('marking-status').textContent = `Flattening ${completedPagesAll.length}/${qPages.length} pages…`;
  }
  // flattenedCompletedPages feeds the download-attempt-PDF feature
  // and the explanation context. Both want page+strokes composited;
  // neither needs the strokes-only image. Intentionally omit
  // strokesDataUrl from this snapshot.
  state.flattenedCompletedPages = completedPagesAll.map(({ pageNumber, dataUrl }) => ({ pageNumber, dataUrl }));

  // Render answer pages. ALWAYS render one full-page image per
  // answer page — the visual-compare stage indexes them by page
  // number and needs full resolution. answerImagesByPage feeds
  // that lookup.
  //
  // For the answer-key EXTRACTION call we additionally allow a
  // contact-sheet variant in batch4_fourup mode, which packs ≤4
  // answer pages into a single image and saves significant input
  // tokens on multi-page answer keys. Other modes keep the
  // individual full pages so dense MCQ grids stay legible to the
  // extraction model.
  const answerImagesByPage = [];
  for (const pageNum of aPages) {
    if (state.cancelMarking) return abortMarking('Cancelled');
    const dataUrl = await renderAnswerPage(state.pdf, pageNum, dpi);
    answerImagesByPage.push({ pageNumber: pageNum, dataUrl });
  }

  let answerImages;
  if ((mode === 'batch4_fourup' || mode === 'batch4_fourup_single') && aPages.length > 1) {
    answerImages = [];
    const chunks = chunkInto(aPages, 4);
    for (const chunk of chunks) {
      if (state.cancelMarking) return abortMarking('Cancelled');
      const tilePages = chunk.map((n) => ({ pageNumber: n }));
      const composed = await composeContactSheetA4(state.pdf, tilePages, {
        dpi: 200,
        labelPrefix: 'Answer page',
        labelSuffix: '', // no "not student answer" — these are the key
      });
      answerImages.push({
        pageNumber: chunk[0],
        dataUrl: composed.dataUrl,
        contactSheet: true,
        includedPageNumbers: composed.includedPageNumbers,
      });
    }
  } else {
    // Re-use the per-page renders for the extraction call; no
    // re-render needed.
    answerImages = answerImagesByPage;
  }

  // Now build per-batch image arrays, composing 4-up sheets where requested.
  // Each batch carries ONLY completed images — the answer key is sent as
  // a separate request later in the staged pipeline.
  const completedByPage = new Map(completedPagesAll.map((p) => [p.pageNumber, p]));
  const batches = [];
  for (const plan of batchesPlan) {
    if (plan.composite === 'fourup_single') {
      const tilePages = plan.pages.map((n) => ({
        pageNumber: n,
        strokes: completedByPage.get(n).strokes,
      }));
      // fourup_single: send ONLY the printed-with-strokes composite,
      // no strokes-only companion. Half the image-token cost vs the
      // fourup branch below. extractStudentAnswers picks the minimal
      // STUDENT_PROMPT_SINGLE prompt when it sees fourupSingle: true
      // on any batch entry.
      const composed = await composeFourUpA4(state.pdf, tilePages, { dpi: 200 });
      batches.push({
        completed: [{
          pageNumber: plan.pages[0],
          dataUrl: composed.dataUrl,
          fourup: true,         // same 4-up layout downstream
          fourupSingle: true,   // → triggers lean prompt in extractStudentAnswers
          includedPageNumbers: composed.includedPageNumbers,
        }],
        plannedPages: plan.pages,
      });
    } else if (plan.composite === 'fourup') {
      const tilePages = plan.pages.map((n) => ({
        pageNumber: n,
        strokes: completedByPage.get(n).strokes,
      }));
      // composeFourUpA4 currently always renders at 200 DPI regardless of
      // the user's submission DPI setting. 200 DPI keeps a 4-up A4 tile
      // (each ~795x1115 px) readable for typical worksheet text. If you
      // later expose a "4-up DPI" setting, plumb it in here. For now, this
      // is intentional and decoupled from settings.renderDpi.
      //
      // Two composites per batch:
      //   composed         — printed pages with strokes overlaid (the
      //                      existing 4-up output).
      //   composedStrokes  — white background + strokes only, same layout
      //                      and same per-tile labels. Sent alongside as
      //                      a companion image so the extraction model
      //                      can tell "no ink at all" apart from
      //                      "printed option letter on the page" without
      //                      being confused by the underlying printed
      //                      text — same Q5-class fix as per-page mode.
      const composed = await composeFourUpA4(state.pdf, tilePages, { dpi: 200 });
      const composedStrokes = await composeFourUpA4(state.pdf, tilePages, {
        dpi: 200,
        strokesOnly: true,
      });
      // Use the first page of the group as the representative pageNumber
      // so the per-image text label naming still works; the per-tile
      // page labels are also baked into the image itself.
      batches.push({
        completed: [{
          pageNumber: plan.pages[0],
          dataUrl: composed.dataUrl,
          strokesDataUrl: composedStrokes.dataUrl,
          fourup: true,
          includedPageNumbers: composed.includedPageNumbers,
        }],
        plannedPages: plan.pages,
      });
    } else {
      // Non-4-up per-page path: send printed + strokes-only per page.
      // The 4-up branch above now ALSO sends both images, just
      // composited as two contact sheets instead of two-per-page.
      batches.push({
        completed: plan.pages.map((n) => {
          const p = completedByPage.get(n);
          return {
            pageNumber: n,
            dataUrl: p.dataUrl,
            strokesDataUrl: p.strokesDataUrl,
          };
        }),
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
          customPrompt:       state.settings.customStudentPrompt,
          customPromptSingle: state.settings.customStudentPromptSingle,
        });
        studentResults.push(res.parsed);
      } else {
        res = await extractAnswerKey({
          ...transport,
          answerPageImages: t.answer,
          customPrompt: state.settings.customAnswerKeyPrompt,
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
          customPrompt: state.settings.customComparePrompt,
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
    // answerImagesByPage = always full-page individual renders, even
    // when answerImages is contact-sheet packed for the extraction
    // call. Visual compare needs the full per-page resolution.
    const answerByPage = new Map(answerImagesByPage.map((p) => [p.pageNumber, p]));
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
        // skipped:true marks this as "no API call was ever made" rather
        // than "API call failed" — used downstream to keep
        // visualRequestsAttempted accurate and to filter these rows
        // out of failed_batches. Without the flag a missing-image pair
        // would be counted as both an attempt AND a failure, falsely
        // triggering the incomplete-warning gate.
        visualResults.push({ pair, error: `Page image not available (${detail}).`, skipped: true });
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
          customPrompt: state.settings.customCompareVisualPrompt,
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
  // "Attempted" = succeeded OR genuinely failed at the API. Skipped
  // (missing-image) pairs never reached the API and so aren't
  // attempts; counting them as such would overstate the request
  // count in the cost report and falsely trip the incomplete-warning
  // gate below for setup issues that aren't request failures.
  const visualRequestsAttempted = visualResults.filter((v) => v.parsed || (v.error && !v.skipped)).length;
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
        // Skipped (missing-image) rows belong in the per-row "unclear"
        // status on the report — they aren't request failures. Only
        // genuine API failures (error AND NOT skipped) belong in
        // failed_batches.
        ...visualResults.filter((v) => v.error && !v.skipped).map((v) => ({
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

// --- Practice mode (Stage 4) ----------------------------------------------
//
// Practice mode lets the child mark up to the current page mid-paper, see
// what they got wrong, and continue. The crucial economy is that each
// "Mark up to here" only pays the vision-extraction cost for NEW pages —
// already-extracted pages are pulled from a cache on the attempt record.
// The answer key is also cached once across the whole practice session.
//
// We do NOT cache the comparator (markPairs / compareVisualPair) output.
// Re-running them each mark is cheap (text-only, ~$0.001/pair) and keeps
// the report logic simple — there's no per-pair cache key to worry about.
//
// Cache shape on attempt.practice:
//   markedPages: number[]                       — frozen page numbers
//   cached_student_extractions_by_page: {       — batch-keyed extraction
//     "<pages.join(',')>": { answers: [...] }   //   results
//   }
//   cached_answer_key_extraction: { answers... } | null
//   latest_report: the most recent merged report (used for "Continue
//     practising" → return to report later)

// Set the inline marking status pill in the practice toolbar. kind
// drives the visual treatment ('saving' shows a spinner, 'ok' shows
// success, 'error' shows red). Pass '' to clear / hide. Designed so
// the user never leaves the practice stage while marking is running.
function setPracticeMarkStatus(text, kind) {
  const el = $('practice-mark-status');
  if (!el) return;
  el.classList.remove('is-saving', 'is-ok', 'is-error');
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = text;
  if (kind === 'saving') el.classList.add('is-saving');
  else if (kind === 'ok') el.classList.add('is-ok');
  else if (kind === 'error') el.classList.add('is-error');
}

async function onMarkUpToHere() {
  if (!state.attempt || state.attempt.mode !== 'practice') return;

  // Flush any in-progress typed text — same hook as onSubmit. Await
  // the IDB write so the extraction pipeline doesn't race against
  // an unfinished stroke save.
  if (state.inkController && typeof state.inkController.commitTyping === 'function') {
    await state.inkController.commitTyping();
  }

  // Auth preflight — inline status, no blocking alert. The user can
  // fix the missing setting in Setup and tap Mark again.
  const apiMode = state.settings.apiMode || 'direct';
  if (apiMode === 'proxy') {
    if (!state.settings.proxyEndpoint || !state.settings.proxyToken) {
      setPracticeMarkStatus('Proxy URL / token missing — set in Setup → Advanced.', 'error');
      return;
    }
  } else if (!state.settings.openaiKey) {
    setPracticeMarkStatus('No API key — set it in Setup → Advanced.', 'error');
    return;
  }

  // Determine the set of pages to mark in THIS call.
  const qPages = state.attempt.questionPages || [];
  const currentIdx = qPages.indexOf(state.currentPage);
  if (currentIdx < 0) {
    setPracticeMarkStatus('Current page is not in the question range.', 'error');
    return;
  }
  const pagesUpToCurrent = qPages.slice(0, currentIdx + 1);
  const practice = state.attempt.practice || {
    markedPages: [],
    cached_student_extractions_by_page: {},
    cached_answer_key_extraction: null,
    latest_report: null,
  };
  state.attempt.practice = practice; // ensure assigned
  const markedSet = new Set(practice.markedPages || []);
  const newPages = pagesUpToCurrent.filter((p) => !markedSet.has(p));
  if (newPages.length === 0) {
    setPracticeMarkStatus('Already marked up to here.', 'ok');
    setTimeout(() => setPracticeMarkStatus(''), 3000);
    return;
  }

  // Lock UI in place. Disable drawing + the mark button itself
  // while the pipeline runs. No stage transition, no confirm dialog
  // — the child sees a spinner in the toolbar and can keep looking
  // at the page.
  const markBtn = $('mark-up-to-here-btn');
  const prevBtnLabel = markBtn ? markBtn.textContent : '';
  if (markBtn) {
    markBtn.disabled = true;
    markBtn.textContent = 'Marking…';
  }
  setToolButtonsDisabled(true);

  // Total expected request count is used to render "step k/N" labels.
  // We don't yet know the exact compare count (depends on partition),
  // but we know batches + (answer-key one-time) + (compare round) =
  // a rough denominator. Refined as we go.
  setPracticeMarkStatus(`Marking ${newPages.length} page${newPages.length === 1 ? '' : 's'}…`, 'saving');

  const dpi = state.settings.renderDpi || 150;
  const practiceMarkingMode = state.settings.practiceMarkingMode || 'batch4_fourup';
  const taskUsages = [];
  const transport = {
    apiKey: state.settings.openaiKey,
    apiMode,
    proxyEndpoint: state.settings.proxyEndpoint,
    proxyToken: state.settings.proxyToken,
    openaiEndpoint: state.settings.openaiEndpoint,
  };
  const extractionModel = state.settings.extractionModel || state.settings.openaiModel || DEFAULT_MODEL;
  const textCompareModel = state.settings.textComparisonModel || state.settings.openaiModel || DEFAULT_MODEL;
  const visualCompareModel = state.settings.visualComparisonModel || state.settings.openaiModel || DEFAULT_MODEL;

  // Wrap the whole pipeline in try/catch so any failure resets the
  // toolbar UI cleanly (button re-enabled, status pill shows error).
  try {
    // Build batches over the NEW pages only. Same composite logic as
    // onSubmit but scoped to the new-pages list.
    let batchesPlan;
    if (practiceMarkingMode === 'single_fullpage' || newPages.length <= 1) {
      batchesPlan = [{ pages: newPages, composite: 'fullpage' }];
    } else if (practiceMarkingMode === 'batch4_fourup_single') {
      batchesPlan = chunkInto(newPages, 4).map((g) => ({ pages: g, composite: 'fourup_single' }));
    } else {
      batchesPlan = chunkInto(newPages, 4).map((g) => ({ pages: g, composite: 'fourup' }));
    }

    // Render images for the new pages.
    const completedByPage = new Map();
    for (const pageNum of newPages) {
      const strokes = await getStrokesForPage(state.attempt.id, pageNum);
      const dataUrl = await flattenQuestionPage(state.pdf, pageNum, strokes, dpi);
      const strokesDataUrl = await renderStrokesOnlyPage(state.pdf, pageNum, strokes, dpi);
      completedByPage.set(pageNum, { pageNumber: pageNum, dataUrl, strokesDataUrl, strokes });
    }

    // Build per-batch "completed" arrays (mirrors onSubmit).
    const batches = [];
    for (const plan of batchesPlan) {
      if (plan.composite === 'fourup_single') {
        const tilePages = plan.pages.map((n) => ({ pageNumber: n, strokes: completedByPage.get(n).strokes }));
        const composed = await composeFourUpA4(state.pdf, tilePages, { dpi: 200 });
        batches.push({
          completed: [{
            pageNumber: plan.pages[0],
            dataUrl: composed.dataUrl,
            fourup: true,
            fourupSingle: true,
            includedPageNumbers: composed.includedPageNumbers,
          }],
          plannedPages: plan.pages,
        });
      } else if (plan.composite === 'fourup') {
        const tilePages = plan.pages.map((n) => ({ pageNumber: n, strokes: completedByPage.get(n).strokes }));
        const composed = await composeFourUpA4(state.pdf, tilePages, { dpi: 200 });
        const composedStrokes = await composeFourUpA4(state.pdf, tilePages, { dpi: 200, strokesOnly: true });
        batches.push({
          completed: [{
            pageNumber: plan.pages[0],
            dataUrl: composed.dataUrl,
            strokesDataUrl: composedStrokes.dataUrl,
            fourup: true,
            includedPageNumbers: composed.includedPageNumbers,
          }],
          plannedPages: plan.pages,
        });
      } else {
        batches.push({
          completed: plan.pages.map((n) => {
            const p = completedByPage.get(n);
            return { pageNumber: n, dataUrl: p.dataUrl, strokesDataUrl: p.strokesDataUrl };
          }),
          plannedPages: plan.pages,
        });
      }
    }

    // Step counter so the status pill can render "Marking 2 of 5".
    const askForKey = !practice.cached_answer_key_extraction && (state.attempt.answerPages?.length || 0) > 0;
    const totalSteps = batches.length + (askForKey ? 1 : 0) + 1; // +1 for compare-round
    let stepIdx = 0;
    function step(label) {
      stepIdx += 1;
      setPracticeMarkStatus(`${label} (${stepIdx}/${totalSteps})`, 'saving');
    }

    // Student-extraction calls.
    for (let i = 0; i < batches.length; i++) {
      step(`Reading page${batches[i].plannedPages.length === 1 ? '' : 's'} ${batches[i].plannedPages.join(', ')}`);
      const res = await extractStudentAnswers({
        ...transport,
        model: extractionModel,
        completedPageImages: batches[i].completed,
        customPrompt: state.settings.customStudentPrompt,
        customPromptSingle: state.settings.customStudentPromptSingle,
      });
      const batchKey = batches[i].plannedPages.join(',');
      practice.cached_student_extractions_by_page[batchKey] = res.parsed;
      taskUsages.push(buildTaskRecord({
        task_type: TASK_TYPES.STUDENT_EXTRACTION,
        model: extractionModel,
        label: `Practice student extraction, pages ${batches[i].plannedPages.join(', ')}`,
        pages: batches[i].plannedPages,
        usage: res.usage,
        settings: state.settings,
      }));
    }

    // Answer-key extraction (one-time, cached after first run).
    if (askForKey) {
      step('Reading answer key');
      const aPages = state.attempt.answerPages;
      const answerImages = [];
      if (aPages.length > 1) {
        const chunks = chunkInto(aPages, 4);
        for (const chunk of chunks) {
          const tilePages = chunk.map((n) => ({ pageNumber: n }));
          const composed = await composeContactSheetA4(state.pdf, tilePages, {
            dpi: 200, labelPrefix: 'Answer page', labelSuffix: '',
          });
          answerImages.push({
            pageNumber: chunk[0], dataUrl: composed.dataUrl,
            contactSheet: true, includedPageNumbers: composed.includedPageNumbers,
          });
        }
      } else {
        for (const pageNum of aPages) {
          const dataUrl = await renderAnswerPage(state.pdf, pageNum, dpi);
          answerImages.push({ pageNumber: pageNum, dataUrl });
        }
      }
      const res = await extractAnswerKey({
        ...transport,
        model: extractionModel,
        answerPageImages: answerImages,
        customPrompt: state.settings.customAnswerKeyPrompt,
      });
      practice.cached_answer_key_extraction = res.parsed;
      taskUsages.push(buildTaskRecord({
        task_type: TASK_TYPES.ANSWER_KEY_EXTRACTION,
        model: extractionModel,
        label: `Practice answer-key extraction, pages ${aPages.join(', ')}`,
        pages: aPages,
        usage: res.usage,
        settings: state.settings,
      }));
    }

    // Build the union of all cached extractions and re-run match.
    // assignSyntheticSections / fanOutMultiPartKeys / normalizeMultiParts
    // walk the full set each mark, so labels stay consistent.
    const allStudentResults = Object.values(practice.cached_student_extractions_by_page);
    const allKeyResults = practice.cached_answer_key_extraction
      ? [practice.cached_answer_key_extraction] : [];
    const match = matchExtractions(allStudentResults, allKeyResults);
    const { text: textPairs, visual: visualPairs } = partitionPairsByModality(match);

    // Make sure the cache slots exist for legacy practice records
    // created before Stage 8 shipped.
    practice.cached_compare_rows_by_pair_key = practice.cached_compare_rows_by_pair_key || {};
    practice.cached_visual_rows_by_pair_key = practice.cached_visual_rows_by_pair_key || {};

    // Partition text pairs: cached rows (reuse) vs new pairs (call
    // markPairs). Cache key is stable across marks because it's
    // built from raw fields the matcher doesn't renumber as the
    // paper grows (see pairCacheKey notes).
    const cachedTextRows = [];
    const textPairsToCompare = [];
    for (const pair of textPairs) {
      const key = pairCacheKey(pair);
      const cached = practice.cached_compare_rows_by_pair_key[key];
      if (cached) cachedTextRows.push(cached);
      else textPairsToCompare.push({ pair, key });
    }

    let aiTextReport = null;
    let compareError = null;
    if (textPairsToCompare.length > 0 && match.keysProvided) {
      step(`Comparing ${textPairsToCompare.length} new answer${textPairsToCompare.length === 1 ? '' : 's'}`);
      try {
        const cmpRes = await markPairs({
          ...transport,
          model: textCompareModel,
          pairs: textPairsToCompare.map((x) => x.pair),
          subject: state.attempt.subject,
          level: state.attempt.level,
          customPrompt: state.settings.customComparePrompt,
        });
        const newRows = Array.isArray(cmpRes.parsed?.questions) ? cmpRes.parsed.questions : [];
        // Persist new rows into the per-pair cache. markPairs may
        // return rows in a different order than the input pairs, so
        // match by normalised question number.
        for (const { pair, key } of textPairsToCompare) {
          const qn = normalizeQNumber(pair.question || '');
          const row = newRows.find((r) => normalizeQNumber(r.question || '') === qn);
          if (row) practice.cached_compare_rows_by_pair_key[key] = row;
        }
        aiTextReport = {
          ...(cmpRes.parsed || {}),
          questions: [...cachedTextRows, ...newRows],
        };
        taskUsages.push(buildTaskRecord({
          task_type: TASK_TYPES.TEXT_COMPARISON,
          model: textCompareModel,
          label: `Text compare — ${textPairsToCompare.length} pair(s)`,
          pages: [],
          usage: cmpRes.usage,
          settings: state.settings,
        }));
      } catch (e) {
        // Text-compare failure is non-fatal — buildFinalReport falls
        // back to local string-equality scoring on uncached pairs;
        // cached rows still surface through the partial aiTextReport.
        console.error('Practice text compare failed', e);
        compareError = e.message;
        if (cachedTextRows.length > 0) {
          aiTextReport = { questions: cachedTextRows };
        }
      }
    } else if (cachedTextRows.length > 0) {
      // All text pairs cached — no API call, but buildFinalReport
      // still needs an aiTextReport shape.
      aiTextReport = { questions: cachedTextRows };
      stepIdx += 1; // consume the reserved compare-step slot
    } else {
      stepIdx += 1;
    }

    // Visual compare with per-pair cache. Same pattern: look up by
    // pairCacheKey, only call the API for uncached pairs, persist
    // results back into the cache.
    const visualResults = [];
    for (let i = 0; i < visualPairs.length; i++) {
      const pair = visualPairs[i];
      const key = pairCacheKey(pair);
      const cached = practice.cached_visual_rows_by_pair_key[key];
      if (cached) {
        visualResults.push(cached);
        continue;
      }
      setPracticeMarkStatus(`Visual compare ${pair.display_question || pair.question} (${i + 1}/${visualPairs.length})`, 'saving');
      try {
        const cStrokes = await getStrokesForPage(state.attempt.id, pair.completed_page);
        const completedImageDataUrl = await flattenQuestionPage(state.pdf, pair.completed_page, cStrokes, dpi);
        const answerImageDataUrl = pair.answer_page
          ? await renderAnswerPage(state.pdf, pair.answer_page, dpi)
          : null;
        const res = await compareVisualPair({
          ...transport,
          model: visualCompareModel,
          pair,
          completedImageDataUrl,
          answerImageDataUrl,
          customPrompt: state.settings.customCompareVisualPrompt,
        });
        const entry = { pair, parsed: res.parsed };
        visualResults.push(entry);
        practice.cached_visual_rows_by_pair_key[key] = entry;
        taskUsages.push(buildTaskRecord({
          task_type: TASK_TYPES.VISUAL_COMPARISON,
          model: visualCompareModel,
          label: `Visual compare ${pair.display_question || pair.question}`,
          pages: [pair.completed_page, pair.answer_page].filter(Boolean),
          usage: res.usage,
          settings: state.settings,
        }));
      } catch (e) {
        console.error('Practice visual compare failed', e);
        visualResults.push({ pair, error: e.message });
      }
    }

    // Aggregate cost across all marks in this session. The report
    // renderer reads from `app_usage` (the same key onSubmit uses for
    // the final-mode flow); using `app_cost` here would silently drop
    // the cost card from the practice-mode report. Carry the prior
    // mark's tasks forward so the displayed cost is cumulative.
    const priorTasks = practice.latest_report?.app_usage?.tasks || [];
    const allTasks = [...priorTasks, ...taskUsages];
    const totals = aggregateTasks(allTasks);
    const merged = buildFinalReport({ match, aiTextReport, visualResults });
    merged.app_usage = {
      tasks: allTasks,
      totals,
      estimated_cost_usd: totals.estimated_cost_usd,
      estimated_input_cost_usd: totals.estimated_input_cost_usd,
      estimated_uncached_input_cost_usd: totals.estimated_uncached_input_cost_usd,
      estimated_cached_input_cost_usd: totals.estimated_cached_input_cost_usd,
      estimated_output_cost_usd: totals.estimated_output_cost_usd,
      models: totals.models,
    };
    merged.app_extractions = {
      student: allStudentResults,
      answer_key: allKeyResults,
    };

    // Update practice state.
    for (const p of newPages) {
      if (!markedSet.has(p)) practice.markedPages.push(p);
    }
    practice.markedPages.sort((a, b) => a - b);
    practice.latest_report = merged;
    state.reportJson = merged;
    state.attempt.reportJson = merged;
    const lastQp = qPages[qPages.length - 1];
    const finishedPaper = practice.markedPages.includes(lastQp);
    state.attempt.status = finishedPaper ? 'marked' : 'in_progress';
    try {
      await putAttempt(state.attempt);
    } catch (e) {
      console.error('Failed to persist practice state', e);
    }

    if (finishedPaper) {
      // Last question page just marked — show the full report. The
      // child can browse, open Review Mode, etc. Exit immersive
      // first: the report card layout needs the toolbar / scroll
      // affordances back, and the dark fullscreen surround is for
      // practising, not reading the report.
      setPracticeMarkStatus('All pages marked.', 'ok');
      // Re-enable the buttons so the report-stage Back button etc.
      // work normally if the user returns to practice later.
      if (markBtn) { markBtn.disabled = false; markBtn.textContent = prevBtnLabel; }
      setToolButtonsDisabled(false);
      exitFullscreenPractice();
      showReport(merged);
      // Status pill is on the practice stage which is now hidden; it
      // re-appears next time practice is shown but we clear it then.
      return;
    }
    // Not the last page — stay on practice. The current page is now
    // frozen. applyPracticeStateForPage hides the mark button, shows
    // the banner + review rail, and keeps tools disabled because the
    // page is frozen.
    if (compareError) {
      setPracticeMarkStatus('Marked. Compare fell back to local equality — verdicts may be loose.', 'error');
    } else {
      setPracticeMarkStatus('Marked. Review on the right.', 'ok');
    }
    if (markBtn) {
      markBtn.disabled = false;
      markBtn.textContent = prevBtnLabel;
    }
    applyPracticeStateForPage();
    setTimeout(() => setPracticeMarkStatus(''), 4000);
  } catch (e) {
    console.error('Practice marking failed', e);
    setPracticeMarkStatus(`Marking failed: ${e.message}`, 'error');
    if (markBtn) {
      markBtn.disabled = false;
      markBtn.textContent = prevBtnLabel;
    }
    setToolButtonsDisabled(false);
  }
}

async function onContinuePractising() {
  // Returns to the practice stage from the report so the student
  // can mark up further pages. Navigates to the first unmarked
  // question page (or the last page if everything is marked).
  if (!state.attempt || state.attempt.mode !== 'practice') return;
  const qp = state.attempt.questionPages || [];
  const markedSet = new Set(state.attempt.practice?.markedPages || []);
  const nextUnmarked = qp.find((p) => !markedSet.has(p));
  if (nextUnmarked != null) {
    state.currentPage = nextUnmarked;
    state.attempt.currentPage = nextUnmarked;
    try { await putAttempt(state.attempt); } catch (e) { console.error(e); }
  }
  setStage('practice');
  await loadCurrentPage();
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
    case 'single_fullpage':       return 'Best quality';
    case 'batch4_fourup':         return 'Balanced';
    case 'batch4_fourup_single':  return 'Most economical';
    default:                      return mode;
  }
}

// --- Report ---------------------------------------------------------------

function bindReportUI() {
  // Download raw report JSON. Replaces the earlier Show/Hide toggle —
  // the parent can save the file and inspect it in their editor of
  // choice instead of scrolling a huge pre on the report page.
  $('download-raw-json').addEventListener('click', () => {
    if (!state.reportJson) {
      alert('No report to download yet — mark first.');
      return;
    }
    try {
      const blob = new Blob(
        [JSON.stringify(state.reportJson, null, 2)],
        { type: 'application/json' }
      );
      triggerDownload(blob, fileBaseName(state.attempt?.pdfName) + '-report.json');
    } catch (e) {
      console.error('Raw JSON download failed', e);
      alert('Raw JSON download failed: ' + (e?.message || e));
    }
  });

  $('open-review-btn')?.addEventListener('click', onOpenReviewMode);
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
    if (!state.attempt || !state.pdf) {
      alert('Open an attempt first.');
      return;
    }
    const btn = ev.currentTarget;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Generating PDF…';
    try {
      // Prefer the in-memory cache that onSubmit populates, but fall
      // back to rendering all question pages on demand from saved
      // strokes. The fallback covers:
      //   - Practice mode, where onMarkUpToHere doesn't populate the
      //     cache (each mark only renders new pages).
      //   - Re-visiting a marked attempt after a refresh, where the
      //     cache is null because no fresh mark has been run in
      //     this session.
      let pages = state.flattenedCompletedPages;
      if (!pages || pages.length === 0) {
        btn.textContent = 'Rendering pages…';
        const dpi = state.settings.renderDpi || 150;
        pages = [];
        for (const pageNum of (state.attempt.questionPages || [])) {
          const strokes = await getStrokesForPage(state.attempt.id, pageNum);
          const dataUrl = await flattenQuestionPage(state.pdf, pageNum, strokes, dpi);
          pages.push({ pageNumber: pageNum, dataUrl });
        }
        btn.textContent = 'Generating PDF…';
      }
      const blob = await exportCompletedAttemptPdf(pages);
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
    // Phase 6: live attempt-resident explanation costs surface as
    // a separate "Review explanations" section in the cost card.
    // Read from the live attempt so re-rendering after a Why? tap
    // shows the new cost without needing the marking pass to rerun.
    explanationCosts: state.attempt?.explanation_costs || [],
  });
  // Gate the Open Review Mode button:
  //   - no answer pages on the attempt → button hidden, note shown
  //     ("Review Mode needs an answer key.")
  //   - has answer pages but zero review records (everything correct
  //     OR keys produced no comparable items) → button hidden, note
  //     ("Review Mode: no questions to review — nice work!")
  //   - otherwise (review_records present) → button visible
  // Practice-mode: show "Continue practising" iff there are still
  // unmarked question pages. Final-mode attempts never see this
  // button. Pre-Stage-4 attempts (no attempt.mode) default to final.
  const isPractice = state.attempt?.mode === 'practice';
  const cBtn = $('continue-practising-btn');
  if (cBtn) {
    if (isPractice) {
      const qp = state.attempt.questionPages || [];
      const markedSet = new Set(state.attempt.practice?.markedPages || []);
      const hasUnmarked = qp.some((p) => !markedSet.has(p));
      cBtn.hidden = !hasUnmarked;
    } else {
      cBtn.hidden = true;
    }
  }
  const hasKey = (state.attempt?.answerPages?.length || 0) > 0;
  const recordCount = (merged?.review_records || []).length;
  const reviewable = hasKey && recordCount > 0;
  const btn = $('open-review-btn');
  const note = $('review-disabled-note');
  if (btn) btn.hidden = !reviewable;
  if (note) {
    if (!hasKey) {
      note.hidden = false;
      note.textContent = 'Review Mode needs an answer key. This paper doesn\'t have one.';
    } else if (recordCount === 0) {
      note.hidden = false;
      note.textContent = 'Review Mode: no questions to review — nice work!';
    } else {
      note.hidden = true;
      note.textContent = '';
    }
  }
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

// --- Review Mode (Phase 2 + 3) -------------------------------------------
//
// State while Review Mode is active:
//   state.review = {
//     records,         // report.review_records
//     pages,           // pagesWithReviews(records) — sorted unique
//     pageIdx,         // index into pages[]
//     activeRecord,    // currently popped record (Phase 3+) or null
//   }

function bindReviewUI() {
  $('review-back-btn')?.addEventListener('click', () => {
    closeReviewPopup();
    // Re-render the report so the "Review explanations" cost
    // section reflects any taps the parent made in this session.
    if (state.reportJson) showReport(state.reportJson);
    else setStage('report');
    logExplanationTelemetrySummary();
  });
  $('review-prev-page-btn')?.addEventListener('click', () => navigateReviewPage(-1));
  $('review-next-page-btn')?.addEventListener('click', () => navigateReviewPage(+1));
  $('review-popup-close')?.addEventListener('click', closeReviewPopup);
  $('review-popup-prev')?.addEventListener('click', () => navigateReviewRecord(-1));
  $('review-popup-next')?.addEventListener('click', () => navigateReviewRecord(+1));
  // Click-outside-card closes the popup.
  $('review-popup')?.addEventListener('click', (ev) => {
    if (ev.target?.id === 'review-popup') closeReviewPopup();
  });
  $('review-popup-why')?.addEventListener('click', () => onExplanationClick('why'));
  $('review-popup-steps')?.addEventListener('click', () => onExplanationClick('show_steps'));
  $('review-popup-hint')?.addEventListener('click', () => onExplanationClick('give_hint'));
  // Esc closes too.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.review?.activeRecord) {
      closeReviewPopup();
    }
  });
}

async function onOpenReviewMode() {
  if (!state.reportJson) return;
  const records = Array.isArray(state.reportJson.review_records)
    ? state.reportJson.review_records
    : [];
  // "Review Mode disabled" path: no answer key → no review records
  // (extract-only papers, or papers without keys).
  // Surface the message but still let the user open the stage so
  // the empty state explains what's going on.
  state.review = {
    records,
    pages: pagesWithReviews(records),
    pageIdx: 0,
    activeRecord: null,
  };
  setStage('review');
  await renderReviewStage();
}

async function renderReviewStage() {
  const r = state.review;
  if (!r) return;
  const banner = $('review-low-conf-banner');
  if (banner) {
    const html = lowConfidenceBannerHtml(r.records);
    if (html) {
      banner.hidden = false;
      banner.innerHTML = html;
    } else {
      banner.hidden = true;
      banner.innerHTML = '';
    }
  }
  const empty = $('review-empty-state');
  const frame = $('review-stage-frame');
  if (r.records.length === 0) {
    if (empty) {
      empty.hidden = false;
      // Distinguish "no key" vs "all correct".
      const hasAnswerKey = (state.attempt?.answerPages?.length || 0) > 0;
      empty.textContent = hasAnswerKey
        ? 'All correct! No questions to review.'
        : 'Review Mode needs an answer key. This paper doesn\'t have one.';
    }
    if (frame) frame.hidden = true;
    $('review-counter').textContent = '';
    $('review-page-label').textContent = '—';
    return;
  }
  if (empty) { empty.hidden = true; empty.textContent = ''; }
  if (frame) frame.hidden = false;
  if (r.pages.length === 0) {
    $('review-counter').textContent = `${r.records.length} record(s), no page anchors`;
    $('review-page-label').textContent = '—';
    return;
  }
  await renderReviewCurrentPage();
}

async function renderReviewCurrentPage() {
  const r = state.review;
  if (!r || r.pages.length === 0 || !state.pdf) return;
  const pageNumber = r.pages[r.pageIdx];
  const host = $('review-page-host');
  const canvas = $('review-pdf-canvas');
  const listHost = $('review-list-rail');
  if (!host || !canvas || !listHost) return;
  const hostWidth = Math.min(1000, host.parentElement?.clientWidth || 800) - 8;
  // Pull saved strokes for this page so renderReviewPage can flatten
  // them onto the rendered PDF — the parent sees the COMPLETED page,
  // not the clean worksheet. (If the attempt has no strokes for
  // this page, returns []; render is clean.)
  const strokes = state.attempt
    ? await getStrokesForPage(state.attempt.id, pageNumber)
    : [];
  await renderReviewPage({
    pdf: state.pdf,
    paperProfile: state.paperProfile,
    reviewRecords: r.records,
    pageNumber,
    strokes,
    canvas,
    listHost,
    hostWidth,
    // Full questions list (NOT just review records) — feeds the
    // per-page stats block above the wrong-answer rows. Stats are
    // suppressed on no-answer-key papers because every row would be
    // unclear there.
    questions: Array.isArray(state.reportJson?.questions) ? state.reportJson.questions : null,
    onRowClick: (record) => openReviewPopup(record),
  });
  $('review-page-label').textContent = `Page ${pageNumber}`;
  // Counter: how many review records on this page / total records.
  const onThisPage = r.records.filter((rec) => Number(rec.question_page) === pageNumber);
  $('review-counter').textContent =
    `${onThisPage.length} on this page · ${r.records.length} total`;
  // Disable nav buttons at the ends.
  $('review-prev-page-btn').disabled = r.pageIdx === 0;
  $('review-next-page-btn').disabled = r.pageIdx === r.pages.length - 1;
}

async function navigateReviewPage(delta) {
  const r = state.review;
  if (!r) return;
  const next = r.pageIdx + delta;
  if (next < 0 || next >= r.pages.length) return;
  r.pageIdx = next;
  await renderReviewCurrentPage();
}

function openReviewPopup(record) {
  const popup = $('review-popup');
  if (!popup || !state.review) return;
  // If we're switching to a different record while an explanation
  // call is still pending for the previous one, cancel it so its
  // late response can't overwrite the new record's panel.
  if (state.review.activeRecord
      && state.review.activeRecord !== record
      && state.review.explanationAbort) {
    state.review.explanationAbort.abort();
    state.review.explanationAbort = null;
  }
  state.review.activeRecord = record;
  $('review-popup-title').textContent = popupTitle(record);
  $('review-popup-body').innerHTML = popupBodyHtml(record);
  // Phase 6 inline help: once-per-device first-tap tooltip
  // explaining what the X means and what the buttons do. Stored
  // dismissal so it doesn't reappear.
  showReviewModeFirstTapHelpOnce();
  // Reset explanation panel + button row each time. Phase 4 plan
  // requires that re-opening the same record's popup restores the
  // three explanation buttons (no client-side caching).
  resetExplanationPanel();
  // Phase 4+5: enable the explanation buttons.
  $('review-popup-why').disabled = false;
  $('review-popup-steps').disabled = false;
  $('review-popup-hint').disabled = false;
  // Telemetry per popup-open — Phase 6 will use this.
  state.review._popupOpenedAt = Date.now();
  // Position counter (1 / N).
  const idx = recordIndex(state.review.records, record);
  $('review-popup-position').textContent =
    idx.idx >= 0 ? `${idx.idx + 1} / ${idx.total}` : '— / —';
  popup.hidden = false;
}

function closeReviewPopup() {
  const popup = $('review-popup');
  if (popup) popup.hidden = true;
  if (state.review) {
    // Cancel any in-flight explanation call so a slow response
    // doesn't write into a closed (or later re-opened) popup.
    if (state.review.explanationAbort) {
      state.review.explanationAbort.abort();
      state.review.explanationAbort = null;
    }
    state.review.activeRecord = null;
  }
}

async function navigateReviewRecord(delta) {
  const r = state.review;
  if (!r || !r.activeRecord) return;
  const idx = recordIndex(r.records, r.activeRecord);
  if (idx.idx === -1) return;
  const target = delta < 0 ? idx.prev : idx.next;
  if (!target) return;
  // If the target lives on a different page, navigate the page too.
  const targetPage = Number(target.question_page);
  if (Number.isFinite(targetPage)) {
    const newPageIdx = r.pages.indexOf(targetPage);
    if (newPageIdx !== -1 && newPageIdx !== r.pageIdx) {
      r.pageIdx = newPageIdx;
      await renderReviewCurrentPage();
    }
  }
  openReviewPopup(target);
}

// ---------- Explanation calls (Phase 4 + 5) ------------------------------

// Track per-tap stats console-only — useful in test runs to see how
// often each button gets used and how slow the explanation calls are.
// No network telemetry. (Phase 6 surfaces totals per session.)
const explanationTelemetry = {
  taps: { why: 0, show_steps: 0, give_hint: 0 },
  totalLatencyMs: { why: 0, show_steps: 0, give_hint: 0 },
  loggedSession: false,
};

function logExplanationTelemetrySummary() {
  const tt = explanationTelemetry.taps;
  const lat = explanationTelemetry.totalLatencyMs;
  const sum = (tt.why || 0) + (tt.show_steps || 0) + (tt.give_hint || 0);
  if (sum === 0 || explanationTelemetry.loggedSession) return;
  const avg = (rt) => (tt[rt] ? Math.round(lat[rt] / tt[rt]) : 0);
  console.info(
    `[review] session totals: why=${tt.why || 0} (avg ${avg('why')}ms), ` +
    `show_steps=${tt.show_steps || 0} (avg ${avg('show_steps')}ms), ` +
    `give_hint=${tt.give_hint || 0} (avg ${avg('give_hint')}ms)`
  );
  // Tag so beforeunload doesn't double-log when Back-to-report
  // already fired.
  explanationTelemetry.loggedSession = true;
}

async function onExplanationClick(requestType) {
  const r = state.review;
  if (!r?.activeRecord) return;
  const record = r.activeRecord;
  if (!state.pdf) {
    setReviewPopupStatus('Cannot generate — PDF not loaded.', 'error');
    return;
  }
  // Per-call AbortController. Lets us cancel an in-flight
  // explanation when the parent closes the popup or navigates to
  // a different record mid-call — without it, a slow ~10s
  // response could resolve AFTER the popup has moved on and
  // overwrite the new record's panel with an explanation for
  // the old one. Stored on state.review.explanationAbort so
  // closeReviewPopup / openReviewPopup can reach it.
  if (state.review.explanationAbort) {
    state.review.explanationAbort.abort();
  }
  const abort = new AbortController();
  state.review.explanationAbort = abort;
  // Tag the request with the record identity so we can detect
  // when a late-arriving response is for a stale popup state.
  const requestRecord = record;
  // Disable the three explanation buttons during the call so the
  // parent doesn't double-tap or fire a different request mid-flight.
  setExplanationButtonsDisabled(true);
  setReviewPopupStatus('Generating explanation…', '');
  // Reveal explanation panel so the parent can see the call is in
  // progress; original review content stays above (popupBody is not
  // touched).
  const expEl = $('review-popup-explanation');
  expEl.hidden = false;
  expEl.innerHTML = `<div class="rp-exp-heading">${labelForRequestType(requestType)}</div>` +
                    `<p class="muted small">Generating…</p>`;
  const tStart = performance.now();
  try {
    const pageImages = await buildExplanationContext(state.pdf, record);
    const apiMode = state.settings.apiMode || 'direct';
    const transport = {
      apiKey: state.settings.openaiKey,
      apiMode,
      proxyEndpoint: state.settings.proxyEndpoint,
      proxyToken: state.settings.proxyToken,
    };
    const model = state.settings.explanationModel
      || state.settings.openaiModel || DEFAULT_MODEL;
    const result = await requestExplanation({
      ...transport,
      model,
      requestType,
      question: record.question,
      studentAnswer: pickStudentAnswerForExplanation(record),
      expectedAnswer: pickExpectedAnswerForExplanation(record),
      shortReason: record.short_reason || record.comment || '',
      pageImages,
      signal: abort.signal,
      customExplanationBase: state.settings.customExplanationPromptBase,
      customExplanationVariants: {
        why:        state.settings.customExplanationVariantWhy,
        show_steps: state.settings.customExplanationVariantShowSteps,
        give_hint:  state.settings.customExplanationVariantGiveHint,
      },
    });
    // Bail if the user moved on while we were waiting. The fetch
    // may have already completed by the time the abort fires, so
    // the post-fetch check is a second line of defense.
    if (abort.signal.aborted || state.review?.activeRecord !== requestRecord) {
      return;
    }
    const tEnd = performance.now();
    const latencyMs = Math.round(tEnd - tStart);
    explanationTelemetry.taps[requestType] = (explanationTelemetry.taps[requestType] || 0) + 1;
    explanationTelemetry.totalLatencyMs[requestType] = (explanationTelemetry.totalLatencyMs[requestType] || 0) + latencyMs;
    console.info(`[review] ${requestType} for ${record.question} in ${latencyMs} ms`);

    // Render the explanation. Replace the loading message; keep the
    // original review content above it.
    expEl.innerHTML = `<div class="rp-exp-heading">${labelForRequestType(requestType)}</div>` +
                     escapeHtmlForPopup(result.text);
    setReviewPopupStatus('', '');
    // After response: per the plan, replace the three explanation
    // buttons with a single Close. The original answer/correction
    // block stays above. Re-opening the same popup later restores
    // the buttons.
    collapseExplanationButtonsToClose();

    // Cost record on the attempt (NOT on the marking report — Phase
    // 6 surfaces these separately under "Review explanations").
    //
    // pages reflects the ACTUAL pages sent to the model (target
    // plus the prev-2/next-1 context window). Recording only the
    // target was misleading: a Why? on page 5 sends 4 images
    // (3,4,5,6), and the cost-section breakdown should show that
    // so a developer can spot odd context windows (start-of-paper
    // → 2 images, end-of-paper → 3 images).
    const sentPages = pageImages
      .map((p) => Number(p.pageNumber))
      .filter((n) => Number.isFinite(n));
    const costRec = buildTaskRecord({
      task_type: TASK_TYPES.EXPLANATION,
      model,
      label: `${labelForRequestType(requestType)} — ${record.question}`,
      pages: sentPages,
      usage: result.usage,
      settings: state.settings,
    });
    if (state.attempt) {
      state.attempt.explanation_costs = state.attempt.explanation_costs || [];
      state.attempt.explanation_costs.push(costRec);
      try { await putAttempt(state.attempt); } catch (e) { console.warn('Could not persist explanation cost:', e); }
    }
  } catch (e) {
    // Abort is the user-initiated cancellation path — silently
    // ignore (the panel was already cleared by openReviewPopup or
    // closeReviewPopup). Real errors still surface.
    if (e?.name === 'AbortError'
        || /aborted|cancel/i.test(String(e?.message || ''))) {
      return;
    }
    // If the user moved to another record while waiting and we
    // somehow got here without the abort signal firing, suppress
    // too — never write an old explanation into a new record's
    // popup.
    if (state.review?.activeRecord !== requestRecord) return;
    console.error('Explanation request failed:', e);
    handleExplanationError(e, requestType);
  } finally {
    // Clear the abort handle if it's still ours (a newer click
    // would have replaced it with its own controller).
    if (state.review?.explanationAbort === abort) {
      state.review.explanationAbort = null;
    }
    // The button-collapse-to-Close happened on success; on error
    // we re-enable so the parent can retry.
    if (!state.review?.explanationCollapsed) {
      setExplanationButtonsDisabled(false);
    }
  }
}

function setExplanationButtonsDisabled(disabled) {
  $('review-popup-why').disabled = disabled;
  $('review-popup-steps').disabled = disabled;
  $('review-popup-hint').disabled = disabled;
}

function setReviewPopupStatus(text, kind) {
  const el = $('review-popup-status');
  if (!el) return;
  el.textContent = text || '';
  let cls;
  if (kind === 'error')      cls = 'error';
  else if (kind === 'warn')  cls = 'warn-text';
  else if (kind === 'ok')    cls = 'ok-text';
  else                       cls = 'muted small';
  el.className = cls + (cls.includes('small') ? '' : ' small');
}

function collapseExplanationButtonsToClose() {
  // Per plan Phase 4: after the response, replace the three
  // explanation buttons with a single Close. We hide the existing
  // row and inject a visible Close button so the parent (and
  // child) have an obvious way out — relying purely on the
  // header × / Esc / click-outside left no in-flow target near
  // where the eye is after reading the explanation. Re-opening
  // the same record's popup later restores the three buttons.
  const row = document.querySelector('.review-popup-explain-row');
  if (row) row.style.display = 'none';
  let closeRow = document.getElementById('review-popup-close-row');
  if (!closeRow) {
    closeRow = document.createElement('div');
    closeRow.id = 'review-popup-close-row';
    closeRow.className = 'review-popup-explain-row';
    closeRow.style.justifyContent = 'flex-end';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.textContent = 'Close';
    btn.addEventListener('click', closeReviewPopup);
    closeRow.appendChild(btn);
    row?.parentElement?.insertBefore(closeRow, row.nextSibling);
  } else {
    closeRow.style.display = '';
  }
  if (state.review) state.review.explanationCollapsed = true;
}

function handleExplanationError(e, requestType) {
  const msg = String(e?.message || e || '');
  let userMsg;
  if (/429|rate.?limit/i.test(msg)) {
    userMsg = 'OpenAI is rate-limiting. Wait a moment and try again.';
  } else if (/network|failed to fetch|could not reach|TypeError/i.test(msg)) {
    userMsg = `Couldn't reach OpenAI. Check your connection.`;
  } else if (/no content|not valid JSON|unexpected/i.test(msg)) {
    userMsg = 'Got an unexpected response. Try again.';
  } else {
    userMsg = msg;
  }
  const expEl = $('review-popup-explanation');
  if (expEl) {
    expEl.innerHTML = `<div class="rp-exp-heading">${labelForRequestType(requestType)}</div>` +
                     `<p class="error">${escapeHtmlForPopup(userMsg)}</p>` +
                     `<p class="muted small">Tap the same button to retry.</p>`;
  }
  setReviewPopupStatus(userMsg, 'error');
  // Leave buttons enabled so the parent can retry directly. Don't
  // collapse to Close — they may want to try a different request.
  setExplanationButtonsDisabled(false);
  if (state.review) state.review.explanationCollapsed = false;
}

// Reset popup explanation panel + buttons when a NEW record is
// opened (otherwise the collapsed state from a previous popup
// would leak into the next one).
function resetExplanationPanel() {
  const exp = $('review-popup-explanation');
  if (exp) { exp.hidden = true; exp.innerHTML = ''; }
  const row = document.querySelector('.review-popup-explain-row:not(#review-popup-close-row)');
  if (row) row.style.display = '';
  const closeRow = document.getElementById('review-popup-close-row');
  if (closeRow) closeRow.style.display = 'none';
  if (state.review) state.review.explanationCollapsed = false;
  setReviewPopupStatus('', '');
}

// Once-per-device inline help shown the first time the parent
// opens the Review popup. Explains the marker convention and what
// the three explanation buttons do. Sets a localStorage flag on
// dismissal so subsequent popups skip the tooltip.
function showReviewModeFirstTapHelpOnce() {
  const KEY = 'wsp.reviewHelpDismissed.v1';
  try { if (localStorage.getItem(KEY) === '1') return; }
  catch { return; }
  // Insert as the first child of the popup body so it's visible
  // before the answer rows. Has its own × so dismissal doesn't
  // close the popup.
  const body = $('review-popup-body');
  if (!body || body.querySelector('.rp-help')) return;
  const help = document.createElement('div');
  help.className = 'rp-help';
  help.innerHTML = `
    <div class="rp-help-body">
      <strong>Review Mode tip:</strong> the list on the left shows each question that needs a closer look.
      Tap a row to see the correct answer; then use <em>Why?</em> for a short explanation,
      <em>Show steps</em> for a worked solution, or <em>Give hint</em> for a nudge that tries not to reveal the answer.
    </div>
    <button type="button" class="rp-help-close" title="Got it">×</button>
  `;
  body.insertBefore(help, body.firstChild);
  help.querySelector('.rp-help-close').addEventListener('click', () => {
    help.remove();
    try { localStorage.setItem(KEY, '1'); } catch {}
  });
}

function labelForRequestType(rt) {
  switch (rt) {
    case 'why':        return 'Why?';
    case 'show_steps': return 'Show steps';
    case 'give_hint':  return 'Give hint';
    default:           return 'Explanation';
  }
}

function escapeHtmlForPopup(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pickStudentAnswerForExplanation(record) {
  if (Array.isArray(record.parts) && record.parts.length > 0) {
    return record.parts.map((p) => `(${p.part}) ${p.student_answer || '(blank)'}`).join('; ');
  }
  return record.student_answer || '(blank)';
}
function pickExpectedAnswerForExplanation(record) {
  if (Array.isArray(record.parts) && record.parts.length > 0) {
    return record.parts.map((p) => `(${p.part}) ${p.matched_expected || '—'}`).join('; ');
  }
  return record.expected_answer || record.short_display_answer || '—';
}

// Render the target page with the child's saved strokes flattened
// in. Plus prev-2 and next-1 pages — also flattened with strokes
// when those pages are within the attempt's question range, so
// passages / context the child wrote on are visible too. Returns
// [{ role, pageNumber, dataUrl }, ...] in document order.
//
// No ✗ overlay anywhere — the explanation model identifies the
// target via the 'TARGET page N' text label in the user message,
// and the question metadata (label, student answer, correct
// answer, short reason) tells it which question to discuss.
//
// Render DPI is fixed at 150 — same default as marking-submission
// DPI. The model needs to read printed text + child's blue ink
// near the marker; lower DPI risks losing detail on dense MCQ
// option grids.
//
// The system prompt tells the model "student's answer is in BLUE,
// printed worksheet is BLACK" — that's only true if the rendered
// pages actually carry the strokes. Reviewer-2 flagged the prior
// version (clean PDF + stamped X) as a blocker for this reason.
async function buildExplanationContext(pdf, record) {
  // Read from settings so we can tune without code changes. The
  // default 150 matches marking DPI; 100 saves ~56% on image
  // pixel area with negligible reading impact on most papers; 200
  // is useful for dense math/science with small subscripts. We
  // don't auto-tune per page — the parent picks one value for
  // the paper's character.
  const dpi = state.settings.explanationRenderDpi || 150;
  const targetPage = record.completed_page;
  if (!Number.isFinite(targetPage) || targetPage < 1) {
    throw new Error('Review record has no anchor page — cannot build explanation context');
  }

  // Helper: render a page with strokes flattened in (returns the
  // dataURL). attemptId may be null if no attempt is loaded;
  // strokes are then empty and the page renders clean.
  const attemptId = state.attempt?.id || null;
  const renderWithStrokes = async (pageNum) => {
    const strokes = attemptId
      ? await getStrokesForPage(attemptId, pageNum)
      : [];
    const dataUrl = await flattenQuestionPage(pdf, pageNum, strokes, dpi);
    return { dataUrl };
  };

  // No red ✗ overlay on the target page. The earlier design stamped
  // one at the question's normalised coords; those coords were
  // inaccurate (same root cause that retired the on-page markers
  // in Review Mode), and the prompt already identifies the target
  // page via the 'TARGET page N' text label below.
  const targetDataUrl = (await renderWithStrokes(targetPage)).dataUrl;

  const pageImages = [];
  for (let p = Math.max(1, targetPage - 2); p < targetPage; p++) {
    pageImages.push({
      role: 'context',
      pageNumber: p,
      dataUrl: (await renderWithStrokes(p)).dataUrl,
    });
  }
  pageImages.push({ role: 'target', pageNumber: targetPage, dataUrl: targetDataUrl });
  if (targetPage + 1 <= pdf.numPages) {
    pageImages.push({
      role: 'context',
      pageNumber: targetPage + 1,
      dataUrl: (await renderWithStrokes(targetPage + 1)).dataUrl,
    });
  }
  return pageImages;
}
