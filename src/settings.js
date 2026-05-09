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
  // Marking mode: how completed pages are grouped before sending to OpenAI.
  // - "auto"            → single combined (≤4 question pages) or batch4_fullpage (>4)
  // - "single_fullpage" → one request, all completed pages as separate full-page images
  // - "batch4_fullpage" → groups of 4 pages, full-page images per page
  // - "batch4_fourup"   → groups of 4 pages, composed into one 4-up A4 image per group
  markingMode: 'auto',
  // API mode:
  // - "direct" → browser POSTs to api.openai.com with the OpenAI key.
  // - "proxy"  → browser POSTs to a Cloudflare Worker (or similar) that
  //              holds the OpenAI key server-side. Required when the
  //              child's tablet network can't reliably reach
  //              api.openai.com (Family Link / family-filter edge cases).
  apiMode: 'direct',
  proxyEndpoint: 'https://worksheet-openai-proxy.jbjsg1.workers.dev',
  proxyToken: '',
  passphrase: '', // empty = unlocked; first run sets it
  unlocked: false,
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
