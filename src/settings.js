// Settings persisted in localStorage.
// API key is one of these values; design accepts that for a personal prototype
// where the parent pastes the key in the parent's own browser.

const KEY = 'wsp.settings.v1';

const DEFAULTS = {
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',
  renderDpi: 150,
  batchSize: 5,
  testMode: false,
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
