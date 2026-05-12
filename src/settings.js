// Settings persisted in localStorage.
// API key is one of these values; design accepts that for a personal prototype
// where the parent pastes the key in the parent's own browser.

const KEY = 'wsp.settings.v1';

const DEFAULTS = {
  openaiKey: '',
  openaiModel: 'gpt-5.4-mini',
  renderDpi: 150,
  batchSize: 5,
  testMode: false,
  // USD per 1M tokens. Defaults match the gpt-5.4-mini preset; verify
  // against https://openai.com/api/pricing/ for the model actually selected.
  // The cost shown in the report is labelled "estimated" and is computed
  // from these rates only. Cached input applies when the OpenAI prompt
  // cache hits (repeat answer-page images, repeat system prompt).
  priceInPerMTokens: 0.75,
  priceCachedInPerMTokens: 0.075,
  priceOutPerMTokens: 4.50,
  // Marking modes:
  // - "single_fullpage"      → one combined request, full-page images
  //                            per page (printed + strokes-only pair)
  // - "batch4_fourup"        → groups of 4 pages, composed into one
  //                            4-up A4 image plus a strokes-only
  //                            companion (default — Balanced)
  // - "batch4_fourup_single" → groups of 4 pages, single 4-up A4
  //                            image only (no strokes-only companion;
  //                            cheapest)
  // Older saved values ("auto", "batch4_fullpage") fall through to
  // batch4_fourup in main.js — they no longer have a dropdown option
  // and there's no migration code, by design.
  markingMode: 'batch4_fourup',
  // Top-level mode toggle for new attempts:
  //   - 'final'    → submit the whole paper at the end (today's default).
  //   - 'practice' → mark page-by-page mid-paper with the "Mark up to
  //                  here" button. Memory-fresh review: child sees
  //                  mistakes immediately rather than waiting for end
  //                  of paper. Pages get frozen once marked.
  // attempt.mode is stamped from this at attempt creation and never
  // mutated thereafter; mid-attempt mode switching isn't supported.
  mode: 'final',
  // Marking mode used by practice-mode mark-up-to-here calls. Kept
  // separate from `markingMode` (which governs final-mode Submit) so
  // a parent can tune the two independently — practice mode may want
  // higher accuracy (Best / Balanced) since the pages being marked
  // are smaller batches than a full paper.
  practiceMarkingMode: 'batch4_fourup',
  // API mode:
  // - "direct" → browser POSTs to api.openai.com with the OpenAI key.
  // - "proxy"  → browser POSTs to a Cloudflare Worker (or similar) that
  //              holds the OpenAI key server-side. Required when the
  //              child's tablet network can't reliably reach
  //              api.openai.com (Family Link / family-filter edge cases).
  apiMode: 'direct',
  proxyEndpoint: 'https://worksheet-openai-proxy.jbjsg1.workers.dev',
  proxyToken: '',
  // Per-task model selectors. Different tasks have very different
  // economics:
  //   - detection: cheap page classification → small model (nano)
  //   - extraction: vision-heavy, accuracy matters → bigger model
  //   - text comparison: text-only paraphrase judgement → mini is fine
  //   - visual comparison: vision-heavy per-question → bigger model
  // Each can be overridden via the Setup form. Pricing is frozen per
  // task at request time — see src/cost.js. An empty string means
  // "fall back to openaiModel".
  detectionModel: 'gpt-5.4-nano',
  extractionModel: 'gpt-5.4',
  textComparisonModel: 'gpt-5.4-mini',
  visualComparisonModel: 'gpt-5.4',
  // Used for Review Mode's per-question explanation requests
  // (Why? / Show steps / Give hint). Vision-aware because the
  // request includes the marked-up target page image; the model
  // also gets the surrounding 2 pages plus the next page so it
  // sees passage / context references.
  explanationModel: 'gpt-5.4',
  // DPI for rendering pages sent to the explanation API. Separate
  // from marking-submission DPI: explanation only needs to
  // recognise the question and any reference passage; marking
  // needs to read the child's handwriting in detail.
  //   100 — ~44% of 150's pixel area; cheapest, fine for most
  //         papers
  //   150 — default, matches marking DPI
  //   200 — useful for dense math/science with small subscripts
  explanationRenderDpi: 150,
  // Custom prompt overrides. Each empty string = use the
  // built-in default in src/openai.js. Set via Setup → Advanced
  // → "Custom prompt overrides". Useful for per-subject tuning
  // or when iterating on prompt language during real-paper
  // testing. Changes take effect on the next request — no
  // restart needed.
  customStudentPrompt: '',
  customStudentPromptSingle: '',
  customAnswerKeyPrompt: '',
  customComparePrompt: '',
  customCompareVisualPrompt: '',
  customPageDetectionPrompt: '',
  customExplanationPromptBase: '',
  customExplanationVariantWhy: '',
  customExplanationVariantShowSteps: '',
  customExplanationVariantGiveHint: '',
  passphrase: '', // empty = unlocked; first run sets it
  unlocked: false,
  // Diagnostic: when true, every practice-mode mark-up-to-here run
  // saves a JSON dump of the full session (inputs / cache before /
  // matcher pairs / compare request + response / final report /
  // cache after / errors). Off by default — dumps contain the
  // student's actual answers and the expected-answer text, so they
  // should only be enabled for troubleshooting and not shared
  // outside trusted hands. See Settings → Diagnostics.
  practiceMarkingDiagnostics: false,

  // --- Practice policy + Calculator (Stages 1-9) ----------------
  // Practice attempts come in two flavours. Stamped on attempt at
  // creation (alongside attempt.calculate_enabled) and never mutated
  // afterwards — settings changes here affect only NEW attempts.
  //   - 'assisted' → learning support. Calculate enabled by default.
  //                  Future helper tools may also be enabled.
  //   - 'exam'     → assessment-style. Helper tools off by default.
  // Final-mode attempts ignore this entirely.
  practiceModeType: 'assisted',
  // Per-mode Calculate availability. Defaults match the spirit of
  // each practice type; parent may flip either.
  calculateEnabledInAssistedPractice: true,
  calculateEnabledInExamPractice: false,
  // Calculator-specific config (Stages 5, 7, 9).
  calcModel: 'gpt-5.4-mini',
  customCalcPrompt: '',
  calcAllowedTypes: { arithmetic: true, linear_1var: false, linear_2var: false },
  calcMinAreaFraction: 0.005,   // 0.5% of page area minimum
  calcMaxAreaFraction: 0.10,    // 10% of page area maximum
  calcCapMode: 'per_page',      // 'per_page' | 'per_attempt'
  calcCapValue: 1,
  // Practice-mode review rail (per-page mark + wrong-answer list on
  // frozen pages) — when true the rail starts collapsed to a small
  // chip so the page area is unobstructed. User can expand by
  // tapping the chip. Persisted across pages and attempts because
  // it's a layout preference, not per-page state.
  practiceReviewRailMinimized: false,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
