// OpenAI vision calls. Uses chat/completions with image_url parts.
//
// Marking is staged across multiple OpenAI calls:
//   - extractStudentAnswers(): vision, completed worksheet pages only.
//   - extractAnswerKey():      vision, answer sheet pages only.
//   - markPairs():             text-only, semantic comparison of matched
//                              text pairs in a single batched call.
//   - compareVisualPair():     vision, one call per drawing/diagram pair.
// Keeping the student/answer-key reads isolated stops the answer key from
// biasing how the model reads the student's handwriting (observed failure
// mode: model "reads" a 1 as a 4 because the key expected 4). Matching is
// then deterministic in code (compare.js: matchExtractions).
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

const COMPARE_PROMPT = `You are marking extracted worksheet answers. No images are provided.

Compare each student answer with the expected answer.

Mark:
- correct: same answer or same meaning (paraphrases, equivalent forms, equivalent units, minor formatting differences are correct).
- incorrect: different meaning, wrong choice, irrelevant answer, OR student answer is blank/missing while the expected answer is present.
- unclear: expected answer is missing, the extracted student answer reads "unclear" or is unreadable, the question matching is uncertain, or the answer genuinely cannot be judged from the extracted text.

Confidence rule: treat match_confidence >= 0.8 as reliable — do not mark an item "unclear" solely because of match_confidence in that range. Only use "unclear" when the answer text itself is missing/unreadable or the comparison genuinely cannot be made.

For MCQ-style answers, "3 (scooped)" should be considered the same as "3" or "scooped" alone — match by either component.

The 'question' field carries the printed question label (e.g. "Q17", "Q19(i)"); preserve it exactly in your output.

Return JSON only:
{
  "summary": {
    "estimated_score": "",
    "comment": ""
  },
  "questions": [
    {
      "question": "",
      "student_answer": "",
      "expected_answer": "",
      "status": "correct | incorrect | unclear",
      "comment": ""
    }
  ],
  "redo": [],
  "weak_points": []
}`;

const STUDENT_PROMPT = `Extract the child's answers from these completed worksheet pages.

The printed worksheet is black. The child's answers are blue. Read only the blue answers.

Do not mark. Do not compare with an answer key. Do not use printed page numbers, score boxes, marks, or footer numbers as answers.

Preserve the printed question_number EXACTLY as it appears on the page — for example "17", "5a", "19(i)". Do not invent, renumber, skip, or replace it with the question text.

For questions with subparts (e.g. Q19 with parts (i) and (ii)), output ONE entry per subpart so each can be matched and compared individually. Use question_number values like "19(i)" and "19(ii)" — do not put two answers under a single "19" entry, and do not duplicate the same label without a subpart suffix.

For each answer, set "answer_type" to one of:
- "text": short or long handwritten text answer.
- "choice": MCQ option letter ("A", "B") or option number ("3"). For choice questions, if the selected option's text is visible next to the option number/letter, include both in "answer", e.g. "3 (scooped)" or "B (the dolphin jumped)". This helps later comparison when the answer key extraction may carry the option text instead of the number.
- "number": numeric answer (units optional).
- "tick_box": the child ticked one or more boxes; "answer" should list which (e.g. "B and D").
- "drawing": the answer is a drawing or marking. Examples: shaded area, shaded fraction, circled item, underlined item, matching line, arrow, graph point, plotted point, clock hand, completed diagram, drawn shape, drawn angle.
- "diagram_label": the child labelled or annotated a diagram visually.
- "unknown": cannot determine confidently.

CLASSIFICATION RULE: if the answer cannot be FULLY represented as typed text — i.e. the visual placement / shape / mark on the page is what carries the meaning — classify it as "drawing" or "diagram_label", NOT "text". Forcing a drawing into a short text description and routing it through text-equality comparison reliably marks it wrong. For drawing/diagram_label answers, "answer" is just a brief human description for the parent to read; the final mark uses a separate visual comparison stage.

If a worksheet has multiple sections, capture the section label (e.g. "Section A - Vocabulary"). Use the page number from the image label.

For 4-up images: each tile has a small dark-grey label "PDF page N — not student answer" above its quadrant. Use that tile label to set "page" for answers in that quadrant. The dark-grey labels are NOT student answers — student answers are blue.

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
      "answer_type": "text | choice | number | tick_box | drawing | diagram_label | unknown",
      "answer": "",
      "confidence": 0
    }
  ]
}`;

const ANSWER_KEY_PROMPT = `Extract the expected answers from these answer sheet pages.

Preserve the printed question_number EXACTLY as it appears (e.g. "17", "5a", "19(i)"). Do not renumber or skip questions.

For multi-part questions, output ONE entry per subpart with question_number values like "19(i)", "19(ii)" — matching how the student answers will be split — so each subpart can be compared individually.

For each expected answer, set "answer_type" to one of the same values used for the student extraction:
- "text", "choice", "number", "tick_box", "drawing", "diagram_label", "unknown".

For choice questions, if the option text is visible next to the option number/letter on the answer sheet, include both in "answer", e.g. "3 (scooped)" or "B (the dolphin jumped)". This helps later comparison when the student's extraction may carry the option number while the key carries the option text or vice versa.

CLASSIFICATION RULE: if the expected answer cannot be FULLY represented as typed text — shaded area, matching line, arrow, plotted point, clock hand, completed diagram, drawn shape, etc. — classify it as "drawing" or "diagram_label", NOT "text". For these visual expected answers, "answer" is a short description ("a clock showing 3:15", "the upper half shaded", "lines connecting A→3, B→1"); the final judgement is done by a separate visual comparison stage, not by text equality.

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
      "answer_type": "text | choice | number | tick_box | drawing | diagram_label | unknown",
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
      ? `Completed 4-up image: pages ${p.includedPageNumbers.join(', ')} arranged 2x2 and labelled in the image. ` +
        `Each tile carries a small dark-grey label "PDF page N — not student answer" above its quadrant. ` +
        `Use that tile label to identify the page number for any answer in that quadrant. ` +
        `The dark-grey labels are NOT student answers — student answers are blue.`
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

const COMPARE_VISUAL_PROMPT = `You are comparing one visual worksheet answer.

Compare only the specified question. Do not mark other questions on the pages.

The printed worksheet is black. The child's answer marks are blue.

Decide whether the child's visual answer matches the expected visual answer on the answer sheet.

Mark:
- correct: the visual answer matches the expected answer closely enough for practice marking
- incorrect: the visual answer is clearly wrong or missing
- unclear: the relevant visual answer cannot be located, is unreadable, or cannot be judged confidently

Return JSON only:
{
  "question": "",
  "status": "correct | incorrect | unclear",
  "student_visual_answer": "",
  "expected_visual_answer": "",
  "comment": ""
}`;

// One vision API call to judge a single visual question. Receives the
// completed page image (with the child's blue strokes flattened in) and
// the answer-sheet page image. The prompt is scoped to the named
// question; full page images are sent because we don't have crop
// coordinates yet (MVP).
export async function compareVisualPair({
  apiKey,
  model,
  pair,                    // { question, display_question, completed_page, answer_page,
                           //   student_answer, expected_answer, ... }
  completedImageDataUrl,
  answerImageDataUrl,
  signal,
  apiMode,
  proxyEndpoint,
  proxyToken,
}) {
  const headerLines = [
    `Question: ${pair.display_question || pair.question}`,
    `Completed page: ${pair.completed_page ?? 'unknown'}`,
    `Answer page: ${pair.answer_page ?? 'unknown'}`,
  ];
  if (pair.student_answer) headerLines.push(`Student-answer description from text extraction: ${pair.student_answer}`);
  if (pair.expected_answer) headerLines.push(`Expected-answer description from text extraction: ${pair.expected_answer}`);
  const content = [{ type: 'text', text: headerLines.join('\n') }];
  if (completedImageDataUrl) {
    content.push({ type: 'text', text: `Completed page ${pair.completed_page ?? ''}` });
    content.push({ type: 'image_url', image_url: { url: completedImageDataUrl, detail: 'high' } });
  }
  if (answerImageDataUrl) {
    content.push({ type: 'text', text: `Answer page ${pair.answer_page ?? ''}` });
    content.push({ type: 'image_url', image_url: { url: answerImageDataUrl, detail: 'high' } });
  }
  return chatJson({ apiKey, model, system: COMPARE_VISUAL_PROMPT, content, signal, apiMode, proxyEndpoint, proxyToken });
}

// Final-stage TEXT comparison call. Text-only — no images. Receives the
// matched (student, expected) pairs from the code-side matcher and
// returns the final correct/incorrect/unclear judgment per question
// with semantic understanding (paraphrases / equivalent meaning).
//
// pairs: [{ question, student_answer, expected_answer, match_confidence }, ...]
// Caller should send the full set in one request, not one per row.
export async function markPairs({
  apiKey,
  model,
  pairs,
  subject,
  level,
  signal,
  apiMode,
  proxyEndpoint,
  proxyToken,
}) {
  const payload = {
    subject: subject || '',
    level: level || '',
    items: pairs.map((p) => ({
      question: p.display_question || p.question,
      student_answer: p.student_answer || '',
      expected_answer: p.expected_answer || '',
      match_confidence: typeof p.match_confidence === 'number' ? p.match_confidence : 1,
    })),
  };
  const content = [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
  return chatJson({ apiKey, model, system: COMPARE_PROMPT, content, signal, apiMode, proxyEndpoint, proxyToken });
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
