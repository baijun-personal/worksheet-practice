// OpenAI vision call. Uses chat/completions with image_url parts.
// The system prompt and user prompt include the color-convention sentence
// verbatim — see design doc "Prompt contract".
//
// Model is configurable via MODEL_PRESETS below; default "gpt-5.4-mini".
// Verify against current OpenAI model list when iterating; the model name
// and pricing are config fields, not hardcoded into the marking call.

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// Model presets shown in the Setup → Advanced settings dropdown.
// Prices are USD per 1M tokens. Verify on https://openai.com/api/pricing/
// before relying on the cost estimate. Edit them in the form to override.
//
// "Cached input" applies when prompt_tokens_details.cached_tokens > 0
// (OpenAI prompt cache hit). Repeated answer-page images across batches
// are exactly the kind of repeat content that benefits, so cost reporting
// splits prompt tokens into cached vs. uncached.
export const MODEL_PRESETS = [
  {
    id: 'gpt-4o-mini',
    label: 'gpt-4o-mini — cheapest legacy test',
    priceInPerMTokens: 0.15,
    priceCachedInPerMTokens: 0.075,
    priceOutPerMTokens: 0.60,
  },
  {
    id: 'gpt-4.1-mini',
    label: 'gpt-4.1-mini — cheap comparison',
    priceInPerMTokens: 0.40,
    priceCachedInPerMTokens: 0.10,
    priceOutPerMTokens: 1.60,
  },
  {
    id: 'gpt-5.4-nano',
    label: 'gpt-5.4-nano — cheap GPT-5.4 class',
    priceInPerMTokens: 0.20,
    priceCachedInPerMTokens: 0.02,
    priceOutPerMTokens: 1.25,
  },
  {
    id: 'gpt-5.4-mini',
    label: 'gpt-5.4-mini — balanced default',
    priceInPerMTokens: 0.75,
    priceCachedInPerMTokens: 0.075,
    priceOutPerMTokens: 4.50,
  },
  {
    id: 'gpt-5.4',
    label: 'gpt-5.4 — higher accuracy',
    priceInPerMTokens: 2.50,
    priceCachedInPerMTokens: 0.25,
    priceOutPerMTokens: 15.00,
  },
  {
    id: 'gpt-5.5',
    label: 'gpt-5.5 — best benchmark, expensive',
    priceInPerMTokens: 5.00,
    priceCachedInPerMTokens: 0.50,
    priceOutPerMTokens: 30.00,
  },
];

export const DEFAULT_MODEL = 'gpt-5.4-mini';

export function presetForModel(model) {
  return MODEL_PRESETS.find((p) => p.id === model) || null;
}

const SYSTEM_PROMPT = `You are marking a child's worksheet.

Use the answer sheet pages to mark the completed worksheet pages.

The printed worksheet is black. The child's answers are blue. Read only the blue answers, then compare with the answer sheet.

Mark every visible question. Do not use printed page numbers, score boxes, marks, or footer numbers as answers. For tick-box questions, count only boxes clearly ticked in blue. For open-ended writing, mark only if the answer key gives a clear answer; otherwise use unclear.

Return JSON only:
{
  "summary": {
    "estimated_score": "",
    "comment": ""
  },
  "questions": [
    {
      "question": "",
      "completed_page": 0,
      "answer_page": 0,
      "student_answer": "",
      "expected_answer": "",
      "status": "correct | incorrect | unclear",
      "comment": ""
    }
  ],
  "redo": [],
  "weak_points": []
}`;

// Status values the report UI knows how to render.
export const KNOWN_STATUSES = ['correct', 'incorrect', 'unclear'];

export async function markBatch({
  apiKey,
  model,
  completedPageImages, // [{ pageNumber, dataUrl, fourup?, includedPageNumbers? }]
  answerPageImages,    // [{ pageNumber, dataUrl }]
  signal,
}) {
  if (!apiKey) throw new Error('OpenAI API key not set');
  if (!model) throw new Error('Model not set');

  // User message: short image labels and images only. All marking rules
  // live in SYSTEM_PROMPT.
  const content = [];
  for (const p of completedPageImages) {
    let label;
    if (p.fourup && Array.isArray(p.includedPageNumbers)) {
      label = `Completed 4-up image: pages ${p.includedPageNumbers.join(', ')} arranged 2x2 and labelled in the image.`;
    } else {
      label = `Completed page ${p.pageNumber}`;
    }
    content.push({ type: 'text', text: label });
    content.push({
      type: 'image_url',
      image_url: { url: p.dataUrl, detail: 'high' },
    });
  }
  for (const p of answerPageImages) {
    content.push({ type: 'text', text: `Answer page ${p.pageNumber}` });
    content.push({
      type: 'image_url',
      image_url: { url: p.dataUrl, detail: 'high' },
    });
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  };

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${errText.slice(0, 400)}`);
  }
  const json = await resp.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI response had no content');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('OpenAI response was not valid JSON: ' + text.slice(0, 200));
  }
  return { parsed, raw: json, usage: json.usage };
}

// Merge per-batch JSONs into a single report using the simplified schema:
//   { summary: { estimated_score, comment }, questions, redo, weak_points }
export function mergeReports(batchReports) {
  const merged = {
    summary: { estimated_score: '', comment: '' },
    questions: [],
    redo: [],
    weak_points: [],
  };
  const seenRedo = new Set();
  const seenWeak = new Set();
  for (const r of batchReports) {
    if (!r) continue;
    if (r.summary?.comment) {
      merged.summary.comment += (merged.summary.comment ? ' ' : '') + r.summary.comment;
    }
    if (Array.isArray(r.questions)) merged.questions.push(...r.questions);
    if (Array.isArray(r.redo)) {
      for (const q of r.redo) {
        const k = String(q).trim().toLowerCase();
        if (!k || seenRedo.has(k)) continue;
        seenRedo.add(k); merged.redo.push(q);
      }
    }
    if (Array.isArray(r.weak_points)) {
      for (const w of r.weak_points) {
        const k = String(w).trim().toLowerCase();
        if (!k || seenWeak.has(k)) continue;
        seenWeak.add(k); merged.weak_points.push(w);
      }
    }
  }
  // If every batch reported an "X/Y" estimated score, sum them.
  let scoreNum = 0, scoreDen = 0, allParseable = true;
  for (const r of batchReports) {
    const s = r?.summary?.estimated_score || '';
    const m = String(s).match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    if (m) { scoreNum += parseFloat(m[1]); scoreDen += parseFloat(m[2]); } else { allParseable = false; }
  }
  if (allParseable && scoreDen > 0) {
    const trimmed = (n) => Number.isInteger(n) ? n.toString() : n.toFixed(1);
    merged.summary.estimated_score = `${trimmed(scoreNum)}/${trimmed(scoreDen)}`;
  }
  return merged;
}

export function chunkPages(pages, size) {
  const out = [];
  for (let i = 0; i < pages.length; i += size) out.push(pages.slice(i, i + size));
  return out;
}
