// OpenAI vision calls. Uses chat/completions with image_url parts.
//
// Marking is split into two extractions plus a code-side comparison:
//   - extractStudentAnswers(): completed worksheet pages only.
//   - extractAnswerKey():      answer sheet pages only.
//   - compareExtractions() in compare.js merges the two structured outputs.
// Keeping the two reads isolated stops the answer key from biasing how the
// model reads the student's handwriting (observed failure mode: model
// "reads" a 1 as a 4 because the key expected 4).
//
// Model is configurable via MODEL_PRESETS below; default "gpt-5.4-mini".
// Verify against current OpenAI model list when iterating; the model name
// and pricing are config fields, not hardcoded.

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// Pluggable transport. In "direct" mode the browser POSTs to api.openai.com
// with the user's OpenAI key in Authorization. In "proxy" mode the browser
// POSTs to a Cloudflare Worker (URL + token configured per-device) that
// adds the real OpenAI key server-side. See relay/cloudflare-worker.js.
function buildRequest({ apiMode, apiKey, proxyEndpoint, proxyToken }) {
  if (apiMode === 'proxy') {
    if (!proxyEndpoint) throw new Error('Proxy URL not set');
    if (!proxyToken) throw new Error('Proxy token not set');
    return {
      url: proxyEndpoint,
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Token': proxyToken,
      },
    };
  }
  if (!apiKey) throw new Error('OpenAI API key not set');
  return {
    url: ENDPOINT,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  };
}

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

// Final-report status values the report UI knows how to render.
export const KNOWN_STATUSES = ['correct', 'incorrect', 'unclear'];

const STUDENT_PROMPT = `Extract the child's answers from these completed worksheet pages.

The printed worksheet is black. The child's answers are blue. Read only the blue answers.

Do not mark. Do not compare with an answer key. Do not use printed page numbers, score boxes, marks, or footer numbers as answers.

Preserve the printed question_number EXACTLY as it appears on the page — for example "17", "5a", "19(i)". Do not invent, renumber, skip, or replace it with the question text.

For questions with subparts (e.g. Q19 with parts (i) and (ii)), output ONE entry per subpart so each can be matched and compared individually. Use question_number values like "19(i)" and "19(ii)" — do not put two answers under a single "19" entry, and do not duplicate the same label without a subpart suffix.

If a worksheet has multiple sections, capture the section label (e.g. "Section A - Vocabulary"). Use the page number from the image label.

If an answer is unreadable, set "answer" to "unclear" and a low confidence.

Return JSON only:
{
  "answers": [
    {
      "global_question_index": 1,
      "section": "",
      "question_number": "",
      "display_question": "",
      "page": 0,
      "answer": "",
      "confidence": 0
    }
  ]
}`;

const ANSWER_KEY_PROMPT = `Extract the expected answers from these answer sheet pages.

Preserve the printed question_number EXACTLY as it appears (e.g. "17", "5a", "19(i)"). Do not renumber or skip questions.

For multi-part questions, output ONE entry per subpart with question_number values like "19(i)", "19(ii)" — matching how the student answers will be split — so each subpart can be compared individually.

If a worksheet has multiple sections, capture the section label. Use the page number from the image label.

Return JSON only:
{
  "answers": [
    {
      "global_question_index": 1,
      "section": "",
      "question_number": "",
      "display_question": "",
      "page": 0,
      "answer": "",
      "confidence": 0
    }
  ]
}`;

export async function extractStudentAnswers({
  apiKey,
  model,
  completedPageImages, // [{ pageNumber, dataUrl, fourup?, includedPageNumbers? }]
  signal,
  apiMode,
  proxyEndpoint,
  proxyToken,
}) {
  const content = [];
  for (const p of completedPageImages) {
    const label = (p.fourup && Array.isArray(p.includedPageNumbers))
      ? `Completed 4-up image: pages ${p.includedPageNumbers.join(', ')} arranged 2x2 and labelled in the image.`
      : `Completed page ${p.pageNumber}`;
    content.push({ type: 'text', text: label });
    content.push({ type: 'image_url', image_url: { url: p.dataUrl, detail: 'high' } });
  }
  return chatJson({ apiKey, model, system: STUDENT_PROMPT, content, signal, apiMode, proxyEndpoint, proxyToken });
}

export async function extractAnswerKey({
  apiKey,
  model,
  answerPageImages,    // [{ pageNumber, dataUrl }]
  signal,
  apiMode,
  proxyEndpoint,
  proxyToken,
}) {
  const content = [];
  for (const p of answerPageImages) {
    content.push({ type: 'text', text: `Answer page ${p.pageNumber}` });
    content.push({ type: 'image_url', image_url: { url: p.dataUrl, detail: 'high' } });
  }
  return chatJson({ apiKey, model, system: ANSWER_KEY_PROMPT, content, signal, apiMode, proxyEndpoint, proxyToken });
}

async function chatJson({ apiKey, model, system, content, signal, apiMode, proxyEndpoint, proxyToken }) {
  if (!model) throw new Error('Model not set');
  const { url, headers } = buildRequest({ apiMode, apiKey, proxyEndpoint, proxyToken });
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  };
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    // fetch() throws a TypeError BEFORE any response when the network
    // layer rejects the request — common causes: device-level filter,
    // CORS preflight blocked, OS firewall, adblocker, OOM on a low-RAM
    // device, or no internet. Surface a hint with the actual URL we
    // were trying to hit so the parent can audit it in a browser tab.
    if (e && (e.name === 'TypeError' || /failed to fetch|network/i.test(e.message || ''))) {
      throw new Error(
        `Could not reach ${url}. Check whether this device's network ` +
        `or parental-control filter is blocking that URL (open it in a ` +
        `new tab — if it doesn't load, the network is the cause). ` +
        `Original error: ${e.message}`
      );
    }
    throw e;
  }
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

export function chunkPages(pages, size) {
  const out = [];
  for (let i = 0; i < pages.length; i += size) out.push(pages.slice(i, i + size));
  return out;
}
