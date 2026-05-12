// Per-task cost tracking helpers.
//
// Each API call is recorded as one task with a frozen snapshot of the
// pricing used at request time. Old reports keep their original
// per-task prices regardless of how the user later edits the prices in
// Setup, and a single report can mix multiple models — e.g. cheap
// detection on nano + extraction on full GPT-5.4 + text compare on
// mini.
//
// Task record shape:
//
//   {
//     task_type: 'detection' | 'student_extraction' | 'answer_key_extraction'
//              | 'text_comparison' | 'visual_comparison',
//     model: 'gpt-5.4-mini',
//     label: 'Student answers, pages 3, 4, 5',
//     pages: [3, 4, 5],
//     prompt_tokens: 0,
//     cached_tokens: 0,
//     completion_tokens: 0,
//     total_tokens: 0,
//     price_in_per_m: 0.75,
//     price_cached_in_per_m: 0.075,
//     price_out_per_m: 4.50,
//     estimated_cost_usd: 0.0123,
//     ts: <epoch ms>,
//   }
//
// Detection cost is stored separately on the paper profile (Stage E)
// rather than in the per-attempt marking report. The per-attempt report
// only contains: student_extraction, answer_key_extraction,
// text_comparison, visual_comparison.

import { MODEL_PRESETS } from './openai.js';

// Resolve pricing for the given model at request time.
//
// Preference order:
//   1. If `model` matches `settings.openaiModel`, use the user-edited
//      prices in settings (these are the prices visible / editable on
//      the Setup form for the active model).
//   2. Otherwise, look up the model in MODEL_PRESETS.
//   3. Otherwise, fall back to the active settings prices (so an
//      unrecognised custom model still gets *some* pricing rather than
//      reporting $0).
//
// The returned object is the frozen snapshot to stamp onto a task
// record. After freezing, settings edits can't change historical reports.
export function freezePricingFor(model, settings) {
  const safeNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const fromSettings = () => ({
    price_in_per_m: safeNumber(settings?.priceInPerMTokens),
    price_cached_in_per_m: safeNumber(settings?.priceCachedInPerMTokens),
    price_out_per_m: safeNumber(settings?.priceOutPerMTokens),
  });
  if (model && settings?.openaiModel && model === settings.openaiModel) {
    return { model, ...fromSettings() };
  }
  const preset = MODEL_PRESETS.find((p) => p.id === model);
  if (preset) {
    return {
      model,
      price_in_per_m: safeNumber(preset.priceInPerMTokens),
      price_cached_in_per_m: safeNumber(preset.priceCachedInPerMTokens),
      price_out_per_m: safeNumber(preset.priceOutPerMTokens),
    };
  }
  return { model: model || '', ...fromSettings() };
}

// Compute cost for a single task from its OpenAI usage object plus the
// frozen pricing snapshot.
//
// usage is the raw OpenAI usage object: { prompt_tokens,
// prompt_tokens_details: { cached_tokens }, completion_tokens,
// total_tokens }.
//
// Returns: { prompt_tokens, cached_tokens, completion_tokens,
// total_tokens, estimated_input_cost_usd,
// estimated_uncached_input_cost_usd, estimated_cached_input_cost_usd,
// estimated_output_cost_usd, estimated_cost_usd }.
export function costFromUsage(usage, pricing) {
  const u = usage || {};
  const prompt = Number(u.prompt_tokens) || 0;
  const cached = Number(u.prompt_tokens_details?.cached_tokens) || 0;
  const uncached = Math.max(0, prompt - cached);
  const completion = Number(u.completion_tokens) || 0;
  const total = Number(u.total_tokens) || (prompt + completion);
  const priceIn = Number(pricing?.price_in_per_m) || 0;
  const priceCachedIn = Number(pricing?.price_cached_in_per_m) || 0;
  const priceOut = Number(pricing?.price_out_per_m) || 0;
  const uncachedCost = (uncached / 1_000_000) * priceIn;
  const cachedCost = (cached / 1_000_000) * priceCachedIn;
  const outCost = (completion / 1_000_000) * priceOut;
  const inputCost = uncachedCost + cachedCost;
  return {
    prompt_tokens: prompt,
    cached_tokens: cached,
    completion_tokens: completion,
    total_tokens: total,
    estimated_input_cost_usd: round4(inputCost),
    estimated_uncached_input_cost_usd: round4(uncachedCost),
    estimated_cached_input_cost_usd: round4(cachedCost),
    estimated_output_cost_usd: round4(outCost),
    estimated_cost_usd: round4(inputCost + outCost),
  };
}

// Build a complete, self-contained task record from the inputs.
// Always returns a record even when `usage` is missing (zero costs).
export function buildTaskRecord({ task_type, model, label, pages, usage, settings, ts }) {
  const pricing = freezePricingFor(model, settings);
  const cost = costFromUsage(usage, pricing);
  return {
    task_type,
    model: pricing.model,
    label: label || '',
    pages: Array.isArray(pages) ? [...pages] : [],
    ...cost,
    price_in_per_m: pricing.price_in_per_m,
    price_cached_in_per_m: pricing.price_cached_in_per_m,
    price_out_per_m: pricing.price_out_per_m,
    ts: ts || Date.now(),
  };
}

// Sum per-task records into aggregate totals + estimated cost. Pricing
// is NOT averaged here — every task carries its own frozen prices, and
// the totals use each task's own cost calculation.
export function aggregateTasks(tasks) {
  let prompt_tokens = 0, cached_tokens = 0, completion_tokens = 0, total_tokens = 0;
  let estimated_cost_usd = 0;
  let estimated_input_cost_usd = 0;
  let estimated_uncached_input_cost_usd = 0;
  let estimated_cached_input_cost_usd = 0;
  let estimated_output_cost_usd = 0;
  for (const t of (tasks || [])) {
    prompt_tokens += Number(t.prompt_tokens) || 0;
    cached_tokens += Number(t.cached_tokens) || 0;
    completion_tokens += Number(t.completion_tokens) || 0;
    total_tokens += Number(t.total_tokens) || 0;
    estimated_cost_usd += Number(t.estimated_cost_usd) || 0;
    estimated_input_cost_usd += Number(t.estimated_input_cost_usd) || 0;
    estimated_uncached_input_cost_usd += Number(t.estimated_uncached_input_cost_usd) || 0;
    estimated_cached_input_cost_usd += Number(t.estimated_cached_input_cost_usd) || 0;
    estimated_output_cost_usd += Number(t.estimated_output_cost_usd) || 0;
  }
  // Models used (set, in task order)
  const models = [];
  for (const t of (tasks || [])) {
    if (t.model && !models.includes(t.model)) models.push(t.model);
  }
  return {
    prompt_tokens,
    cached_tokens,
    uncached_input_tokens: Math.max(0, prompt_tokens - cached_tokens),
    completion_tokens,
    total_tokens,
    estimated_cost_usd: round4(estimated_cost_usd),
    estimated_input_cost_usd: round4(estimated_input_cost_usd),
    estimated_uncached_input_cost_usd: round4(estimated_uncached_input_cost_usd),
    estimated_cached_input_cost_usd: round4(estimated_cached_input_cost_usd),
    estimated_output_cost_usd: round4(estimated_output_cost_usd),
    models,
  };
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

// Map the legacy task `kind` strings used inside main.js to the
// canonical task_type values stored on records. Keep the mapping
// here so callers don't sprinkle these strings around.
export const TASK_TYPES = {
  STUDENT_EXTRACTION: 'student_extraction',
  ANSWER_KEY_EXTRACTION: 'answer_key_extraction',
  TEXT_COMPARISON: 'text_comparison',
  VISUAL_COMPARISON: 'visual_comparison',
  DETECTION: 'detection',
  EXPLANATION: 'explanation',
  CALCULATION: 'calculation',
};

export function taskTypeLabel(t) {
  switch (t) {
    case 'student_extraction':    return 'Student answers';
    case 'answer_key_extraction': return 'Answer key';
    case 'text_comparison':       return 'Text compare';
    case 'visual_comparison':     return 'Visual compare';
    case 'detection':             return 'Page detection';
    case 'explanation':           return 'Review explanation';
    case 'calculation':           return 'Calculator';
    default:                      return t || '?';
  }
}
