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

// Pick a custom override if the parent set one in Setup → Advanced,
// otherwise use the built-in default. Trim before checking so a
// textarea with only whitespace is treated as empty.
function pickPrompt(custom, builtin) {
  return (custom && String(custom).trim()) ? custom : builtin;
}

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

Each input item carries a "pair_id" field. Echo it back unchanged on the corresponding output row so the marker can match output rows to input items. Do not rename, normalise, or omit pair_id. (If an item is missing pair_id, omit the field from that output row too.)

Each item in "items" is EITHER:
  (A) FLAT — has student_answer and expected_answer fields. Compare them and return one row.
  (B) MULTI-PART — has is_multi_part: true with student_parts[] and expected_parts[]. Return ONE row with is_multi_part: true and parts[] containing per-part statuses.

For multi-part items:
  • If order_matters: true — compare each student part against the expected part with the SAME "part" label, or by index when labels are missing.
  • If order_matters: false — POOL MATCH. The student may have written list items in any order, so do NOT assume student_parts[i] should be compared with expected_parts[i]. Walk each student part and look for ANY unused expected_part whose meaning matches. Each expected_part may be matched at most once across the whole question. A student part is correct if some unused expected_part means the same; otherwise incorrect.
  • For each student part, set "matched_expected" to the expected text it matched, or "" if none.

WORKED EXAMPLE — pool match (order_matters: false):

Input item:
{
  "pair_id": "cp=2|q=19|ss=1|ap=3",
  "question": "Q19",
  "is_multi_part": true,
  "order_matters": false,
  "student_parts": [
    {"part":"i","answer":"No"},
    {"part":"ii","answer":"stay alert"}
  ],
  "expected_parts": [
    {"part":"i","answer":"To be alert"},
    {"part":"ii","answer":"Avoid eye contact with them"}
  ]
}

Reasoning:
- "No" does not mean "To be alert" or "Avoid eye contact with them" → incorrect.
- "stay alert" means the same as "To be alert" → correct, even though it appears in a different part position.
- Position is irrelevant when order_matters is false.

Correct output:
{
  "pair_id": "cp=2|q=19|ss=1|ap=3",
  "question": "Q19",
  "is_multi_part": true,
  "parts": [
    {
      "part": "i",
      "student_answer": "No",
      "matched_expected": "",
      "status": "incorrect",
      "comment": "'No' does not match any expected item."
    },
    {
      "part": "ii",
      "student_answer": "stay alert",
      "matched_expected": "To be alert",
      "status": "correct",
      "comment": "Same meaning as 'To be alert'."
    }
  ],
  "short_display_answer": "To be alert",
  "short_reason": "One listed answer does not match the expected points.",
  "confidence": 0.9
}

Do NOT pair student_parts[i] with expected_parts[i] just because they have the same index when order_matters is false.

Status rules:
- correct: same answer or same meaning. Accept paraphrases, equivalent forms, equivalent units, and minor formatting differences.
- incorrect: different meaning, wrong choice, irrelevant answer, or student answer is blank/missing while expected answer is present.
- unclear: expected answer is missing, student answer is unreadable, question matching is uncertain, or judgement genuinely cannot be made from the extracted text.

Confidence rule:
- Use numeric confidence from 0 to 1.
- Do not mark an item "unclear" solely because match_confidence is below 1.
- If match_confidence >= 0.8 and the extracted answer text is readable, judge the answer normally.

For MCQ-style answers:
- "3 (scooped)" can match "3" or "scooped".
- Match by either component if the meaning is clear.

The "question" field carries the printed question label, e.g. "Q17" or "Q19". Preserve it exactly.

Review fields:
For any flat row with status "incorrect" or "unclear", return:
- short_display_answer: short correct-answer preview, ideally <=24 characters
- short_reason: one short parent/child-friendly reason
- confidence: numeric confidence from 0 to 1

For any multi-part row where at least one part is "incorrect" or "unclear", return:
- short_display_answer: short correct-answer preview, ideally <=24 characters
- short_reason: one short parent/child-friendly reason
- confidence: numeric confidence from 0 to 1

weak_points (optional): a short array of one-line strings describing recurring themes you noticed across the wrong answers (e.g. "verb tense agreement", "unit conversion errors"). Omit or return [] if nothing specific stands out — do not invent themes.

Output JSON only:
{
  "summary": {
    "estimated_score": "",
    "comment": ""
  },
  "questions": [
    {
      "pair_id": "",
      "question": "",
      "student_answer": "",
      "expected_answer": "",
      "status": "correct | incorrect | unclear",
      "comment": "",
      "short_display_answer": "",
      "short_reason": "",
      "confidence": 0
    },
    {
      "pair_id": "",
      "question": "",
      "is_multi_part": true,
      "parts": [
        {
          "part": "",
          "student_answer": "",
          "matched_expected": "",
          "status": "correct | incorrect | unclear",
          "comment": ""
        }
      ],
      "short_display_answer": "",
      "short_reason": "",
      "confidence": 0
    }
  ],
  "weak_points": []
}`;

const STUDENT_PROMPT = `Read the child's answers from this completed worksheet page.

For each page you receive TWO images:
- The PRINTED worksheet page (black text on white, no student writing).
- The STROKES-ONLY image (white background, the student's blue marks only) at the same dimensions and positions as the printed page.

For each question on the printed page, find the student's answer by looking at the strokes-only image at that question's location. If the strokes-only image has no ink in the question's answer area, the answer is BLANK — return answer_type "blank" and answer "". Do not return a printed option letter (e.g. "a." or "B.") as the student's answer; printed letters do NOT appear on the strokes-only image.

Return JSON:
{
  "answers": [
    {
      "global_question_index": 1,
      "section": "",
      "question_number": "",
      "display_question": "",
      "page": 0,
      "answer_type": "text | choice | number | tick_box | drawing | diagram_label | blank | unknown",
      "answer": "",
      "confidence": 0
    }
  ]
}

Multi-part entry shape (one stem, several answer slots — e.g.
"list two reasons", "name three examples"):
{
  ...
  "is_multi_part": true,
  "order_matters": false,
  "parts": [
    { "part": "i",  "answer_type": "text", "answer": "", "confidence": 0 },
    { "part": "ii", "answer_type": "text", "answer": "", "confidence": 0 }
  ]
}

Field guide:

- question_number: as printed on the page ("1", "5a", "19(i)"). Don't renumber.
- display_question: short label like "Q17" or "Section A Q1". Not the question text.
- section: section header if the paper has them (e.g. "Section A: Grammar"). Empty otherwise.
- page: from the page label on the image.

answer_type:
- "text": handwritten text answer.
- "choice": MCQ option letter ("A", "B"). Return the letter only.
- "number": numeric answer.
- "tick_box": one or more boxes ticked; "answer" lists which (e.g. "B and D").
- "drawing": shaded fraction, circled item, underlined option, matching line, arrow, plotted point, drawn shape — anything where placement/shape carries the meaning.
- "diagram_label": child labelled or annotated a diagram.
- "blank": no ink in the slot's area on the strokes-only image. answer: "". confidence: 0.95.
- "unknown": ink visible on the strokes-only image but illegible. answer: "unclear". confidence: 0.3.

Multi-part rule:
- LIST-ANSWER question (one stem, several slots): one entry with is_multi_part: true and parts[]. Use printed slot labels for "part" ("i", "ii", "a", "b").
- DISTINCT SUB-QUESTIONS (Q5a and Q5b are different questions with their own prompts): separate flat entries with question_number "5a" and "5b".

For 4-up images: each tile has a dark-grey label "PDF page N — not student answer" above its quadrant. Use that to set "page". The label is not a student answer. 4-up batches now receive TWO contact-sheet images with the SAME tile layout — one printed-with-strokes and one strokes-only on white. The "no ink in the slot's area on the strokes-only image = BLANK" rule applies to each tile's question areas on the strokes-only composite, identically to per-page mode.

Return JSON only.`;

// Prompt for batch4_fourup_single mode. The mode sends only ONE
// 4-up contact-sheet image (printed pages with strokes overlaid),
// no strokes-only companion. We trade the strokes-only blank-
// detection signal for half the image-token cost. The prompt
// stays minimal: one positive instruction, one JSON shape, no
// branching on image layout.
const STUDENT_PROMPT_SINGLE = `Read the child's answers written in blue from this completed worksheet page printed in black. If a question has no blue ink, include it with answer_type "blank" and answer "".
Return JSON only:
{
  "answers": [
    {
      "question_number": "",
      "page": 0,
      "answer_type": "choice | text | number | blank | unknown",
      "answer": "",
      "confidence": 0
    }
  ]
}
`;

const ANSWER_KEY_PROMPT = `Extract the printed answers from this answer-key page.

These pages contain the model answers for grading. Answers may appear as a numbered list, a compact grid of question-number → answer pairs, or a marking scheme with sample answers. Read all of them.

Return JSON:
{
  "answers": [
    {
      "global_question_index": 1,
      "section": "",
      "question_number": "",
      "display_question": "",
      "page": 0,
      "answer_type": "text | choice | number | tick_box | drawing | diagram_label | blank | unknown",
      "answer": "",
      "confidence": 0
    }
  ]
}

Multi-part entry shape (same as student extraction — when the printed
answer has multiple parts under one question number):
{
  ...
  "is_multi_part": true,
  "order_matters": false,
  "parts": [
    { "part": "i",  "answer_type": "text", "answer": "", "confidence": 0 },
    { "part": "ii", "answer_type": "text", "answer": "", "confidence": 0 }
  ]
}

Field guide:

- question_number: as printed on the answer key. If the key uses a compact grid (e.g. a 2-column table of question_number / answer pairs packed in columns), read the question_number from the printed grid, not from your own counting.
- display_question: short label like "Q17". Not the question text.
- section: section header if printed on the key. Empty if not.
- page: from the page label on the image.

answer_type:
- "text": text answer (sentence or short).
- "choice": MCQ option letter.
- "number": numeric answer.
- "tick_box": one or more boxes — "answer" lists which.
- "drawing": describe briefly what the model answer is.
- "diagram_label": describe the expected labeling.
- "blank": no answer printed for this question.
- "unknown": present but unreadable.

For 4-up images: each tile has a dark-grey label "PDF page N — not student answer" above its quadrant. Use that to set "page".

Return JSON only.`;

export async function extractStudentAnswers({
  apiKey,
  model,
  completedPageImages, // [{ pageNumber, dataUrl, strokesDataUrl?, fourup?, fourupSingle?, includedPageNumbers? }]
  signal,
  apiMode,
  proxyEndpoint,
  proxyToken,
  customPrompt,         // override STUDENT_PROMPT when non-empty
                        // (used by single_fullpage + batch4_fourup)
  customPromptSingle,   // override STUDENT_PROMPT_SINGLE when non-empty
                        // (used by batch4_fourup_single)
}) {
  const content = [];
  for (const p of completedPageImages) {
    if (p.fourup && Array.isArray(p.includedPageNumbers)) {
      // 4-up contact sheets now send TWO images per batch when the
      // caller supplies a companion strokes-only composite — same
      // dual-image idea as the per-page path, just composited
      // across multiple pages on each sheet. Falls back to single
      // image if strokesDataUrl is absent.
      const printedLabel = `Completed contact-sheet image: pages ${p.includedPageNumbers.join(', ')} arranged on a single A4 sheet ` +
        `(layout chosen for the page count: 1 = full page, 2 = stacked, 3 = one wide on top + two below, 4 = 2x2 grid). ` +
        `Each tile carries a small dark-grey label "PDF page N — not student answer" above it. ` +
        `Use that tile label to identify the page number for any answer in that tile. ` +
        `The dark-grey labels are NOT student answers — student answers are blue.`;
      content.push({ type: 'text', text: printedLabel });
      content.push({ type: 'image_url', image_url: { url: p.dataUrl, detail: 'high' } });
      if (p.strokesDataUrl) {
        // Companion strokes-only contact sheet — same layout, same
        // per-tile labels ("PDF page N — strokes only"), white
        // background, only the student's blue ink visible. Source
        // of truth for "what did the student actually write" with
        // no printed text to misread as handwriting.
        content.push({
          type: 'text',
          text: `Companion contact-sheet image: SAME pages and SAME tile layout as the previous image, ` +
            `but each tile shows ONLY the student's blue ink on a white background (no printed worksheet). ` +
            `This is the source of truth for what the student wrote. If a tile has no ink in a question's area, that question is BLANK.`,
        });
        content.push({ type: 'image_url', image_url: { url: p.strokesDataUrl, detail: 'high' } });
      }
      continue;
    }
    // Per-page full-page path: send the printed page first, then
    // the strokes-only image at identical dimensions. Order
    // matters — the prompt refers to "the PRINTED worksheet page"
    // first and "the STROKES-ONLY image" second. If strokesDataUrl
    // is absent (older caller, future regression), we fall back
    // to the single-image behaviour without crashing.
    content.push({ type: 'text', text: `PDF page ${p.pageNumber} — PRINTED worksheet (no student writing).` });
    content.push({ type: 'image_url', image_url: { url: p.dataUrl, detail: 'high' } });
    if (p.strokesDataUrl) {
      content.push({
        type: 'text',
        text: `PDF page ${p.pageNumber} — STROKES ONLY (the student's blue ink on white, same dimensions as the printed page above).`,
      });
      content.push({ type: 'image_url', image_url: { url: p.strokesDataUrl, detail: 'high' } });
    }
  }
  // Pick prompt by batch shape. fourup_single entries are flagged
  // with fourupSingle: true. Other batches (per-page pairs OR
  // standard fourup dual-image pairs) use the standard prompt.
  const isSingle = completedPageImages.some((p) => p.fourupSingle === true);
  const system = isSingle
    ? pickPrompt(customPromptSingle, STUDENT_PROMPT_SINGLE)
    : pickPrompt(customPrompt, STUDENT_PROMPT);
  return chatJson({
    apiKey, model,
    system,
    content, signal, apiMode, proxyEndpoint, proxyToken,
  });
}

export async function extractAnswerKey({
  apiKey,
  model,
  answerPageImages,    // [{ pageNumber, dataUrl }]
  signal,
  apiMode,
  proxyEndpoint,
  proxyToken,
  customPrompt,        // override ANSWER_KEY_PROMPT when non-empty
}) {
  const content = [];
  for (const p of answerPageImages) {
    const label = (p.contactSheet && Array.isArray(p.includedPageNumbers))
      ? `Answer-key contact-sheet image: pages ${p.includedPageNumbers.join(', ')} arranged on a single A4 sheet ` +
        `(layout chosen for the page count: 1 = full page, 2 = stacked, 3 = one wide on top + two below, 4 = 2x2 grid). ` +
        `Each tile carries a small dark-grey label "Answer page N" above it — that's the source PDF page number, ` +
        `not part of the answer key.`
      : `Answer page ${p.pageNumber}`;
    content.push({ type: 'text', text: label });
    content.push({ type: 'image_url', image_url: { url: p.dataUrl, detail: 'high' } });
  }
  return chatJson({
    apiKey, model,
    system: pickPrompt(customPrompt, ANSWER_KEY_PROMPT),
    content, signal, apiMode, proxyEndpoint, proxyToken,
  });
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
  customPrompt,            // override COMPARE_VISUAL_PROMPT when non-empty
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
  return chatJson({
    apiKey, model,
    system: pickPrompt(customPrompt, COMPARE_VISUAL_PROMPT),
    content, signal, apiMode, proxyEndpoint, proxyToken,
  });
}

// Page-type classification call. Vision; uses low-resolution contact
// sheets so the cost stays small (page-level classification is forgiving
// of low resolution — we only need to identify what KIND of page it is,
// not read every word). The detection prompt is intentionally explicit
// about compact answer-key grids because that case is easy to misread
// as a question page.
const PAGE_DETECTION_PROMPT = `Classify each PDF page.

Types:
- question: contains questions for the student to answer (printed Q numbers, blanks, MCQ option grids the student fills in).
- answer_key: contains answers, marking scheme, or compact answer grids. Often packed densely as tables of question-number/answer pairs, numeric grids, or "Answer:" labelled rows. Also called marking scheme, mark scheme, answers, or solutions.
- passage: reading passage / source text without answer blanks. The student reads but does not write.
- composition: writing or composition page with mostly ruled lines or large writing space.
- cover: cover or title page with school header, paper number, candidate name field, instructions block.
- instruction: instruction page (rules, time allowed, marks distribution, student information).
- section_divider: section title or marks page with little or no work — e.g. "Section A — 20 marks", "End of Booklet A".
- blank: blank or nearly blank page.
- unknown: page kind cannot be determined confidently.

Rules:
- Answer key pages often contain many short answers packed together, numeric grids, tables of question-number/answer pairs, or a marking scheme. If a page contains a tabular grid of question numbers and answer values packed in columns (for example 5 columns of "<Q#> <A>" pairs, or rows of small answers separated by short rulings), classify it as answer_key, NOT question — even if it visually resembles an MCQ-style grid. The presence of explicit headers like "Answers", "Marking scheme", "Suggested answers" is also a strong answer_key signal.
- Question pages usually contain questions with space for student answers. They have larger blanks, ruled answer space, or option boxes the student would fill.
- Each image may contain up to 4 PDF pages arranged in a contact sheet. Each tile is labelled with its source PDF page number above it (text like "PDF page 12"). Classify EACH labelled page separately and use the printed page label as the "page" value in the output.
- Confidence is on a 0..1 scale. Be honest: if a page is genuinely ambiguous, set confidence below 0.7 and prefer "unknown" rather than guessing.
- "reason" is a one-line human-readable note (e.g. "compact MCQ answer grid", "ruled lines for composition", "school header and rules block").

Return JSON only:
{
  "pages": [
    {
      "page": 1,
      "type": "question | answer_key | passage | composition | cover | instruction | section_divider | blank | unknown",
      "confidence": 0,
      "reason": ""
    }
  ]
}`;

// --- Calculator parse (Stage 5) ----------------------------------------
// Vision-only parse of a small cropped region containing one math
// expression. The model NEVER computes the answer — local
// JavaScript (src/calc.js) does that. The model's job is to read
// the printed/handwritten math and return a structured JSON shape
// that the validator can sanity-check.

const DEFAULT_CALC_PARSE_PROMPT = `You are reading a small image showing one math expression.
Identify the math and return a JSON object describing it.
DO NOT compute the answer. Return JSON only, no prose.

Allowed types and their schemas:

{ "type": "arithmetic",
  "op": "+|-|*|/",
  "operands": [number, number] }
  - Single arithmetic expression with two numeric operands.
  - Operands may be integers or decimals.
  - Use "/" for division regardless of whether the printed form is "÷" or "/".

{ "type": "out_of_scope", "reason": "<short reason>" }
  - Math that doesn't fit any allowed type (e.g. quadratic, geometry, word problem).

{ "type": "unreadable", "reason": "<short reason>" }
  - Image too blurry / mixed / sparse to parse confidently.

Examples:

Image shows "48 × 6 =" →
{"type":"arithmetic","op":"*","operands":[48,6]}

Image shows "24 ÷ 10" →
{"type":"arithmetic","op":"/","operands":[24,10]}

Image shows "2.4 ÷ 0.6" →
{"type":"arithmetic","op":"/","operands":[2.4,0.6]}

Image shows "x² + 4x = 5" →
{"type":"out_of_scope","reason":"Quadratic equation"}

Return JSON object only.`;

export async function parseMathRegion({
  apiKey,
  model,
  imageDataUrl,
  signal,
  apiMode,
  proxyEndpoint,
  proxyToken,
  openaiEndpoint,
  customPrompt,           // override DEFAULT_CALC_PARSE_PROMPT when non-empty
}) {
  const content = [
    { type: 'text', text: 'Read this math expression and return JSON only.' },
    { type: 'image_url', image_url: { url: imageDataUrl, detail: 'low' } },
  ];
  return chatJson({
    apiKey, model,
    system: pickPrompt(customPrompt, DEFAULT_CALC_PARSE_PROMPT),
    content, signal, apiMode, proxyEndpoint, proxyToken, openaiEndpoint,
  });
}

// Export the default prompt so the Settings UI can pre-fill the
// custom-prompt textarea (mirrors the BUILTIN_PROMPTS pattern).
export { DEFAULT_CALC_PARSE_PROMPT };

export async function detectPages({
  apiKey,
  model,
  pageImages,            // [{ contactSheet?: true, includedPageNumbers?: [], pageNumber?: 0, dataUrl }]
  signal,
  apiMode,
  proxyEndpoint,
  proxyToken,
  customPrompt,          // override PAGE_DETECTION_PROMPT when non-empty
}) {
  const content = [];
  for (const p of pageImages) {
    const label = (p.contactSheet && Array.isArray(p.includedPageNumbers))
      ? `Contact-sheet image: pages ${p.includedPageNumbers.join(', ')} arranged on a single A4 sheet ` +
        `(layout chosen for the page count). Each tile carries a small dark-grey label "PDF page N" above it. ` +
        `Use that label as the "page" value when classifying that tile.`
      : `PDF page ${p.pageNumber}`;
    content.push({ type: 'text', text: label });
    // 'low' detail is intentional: page-level classification doesn't
    // need 'high'. Cuts input tokens substantially.
    content.push({ type: 'image_url', image_url: { url: p.dataUrl, detail: 'low' } });
  }
  return chatJson({
    apiKey, model,
    system: pickPrompt(customPrompt, PAGE_DETECTION_PROMPT),
    content, signal, apiMode, proxyEndpoint, proxyToken,
  });
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
  customPrompt,     // override COMPARE_PROMPT when non-empty
}) {
  // Build the payload sent to the AI. Earlier versions added
  // completed_page / page_question_index / questions_on_page so
  // the AI could synthesise question_start_location coordinates.
  // That output path is gone now (marker placement is fully
  // code-side ordinal in compare.js) — those metadata fields
  // would just be unused token bloat in the AI payload, so they
  // are dropped here.
  const payload = {
    subject: subject || '',
    level: level || '',
    items: pairs.map((p) => {
      const item = {
        question: p.display_question || p.question,
        match_confidence: typeof p.match_confidence === 'number' ? p.match_confidence : 1,
      };
      // pair_id is stamped on every pair by matchExtractions. Echoing
      // it lets buildFinalReport / the practice-mode cache write site
      // map response rows to pairs even when two pairs share a
      // question string (section-restart papers — Section A Q1 and
      // Section B Q1). Defensive: omit the field when absent so an
      // un-stamped pair (e.g. tests) still produces a valid payload.
      if (p.pair_id) item.pair_id = p.pair_id;
      if (p.is_multi_part) {
        item.is_multi_part = true;
        item.order_matters = !!p.order_matters;
        item.student_parts = (p.student_parts || []).map((sp) => ({
          part: sp.part != null ? String(sp.part) : '',
          answer: sp.answer || '',
        }));
        item.expected_parts = (p.expected_parts || []).map((ep) => ({
          part: ep.part != null ? String(ep.part) : '',
          answer: ep.answer || '',
        }));
      } else {
        item.student_answer = p.student_answer || '';
        item.expected_answer = p.expected_answer || '';
      }
      return item;
    }),
  };
  const content = [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
  return chatJson({
    apiKey, model,
    system: pickPrompt(customPrompt, COMPARE_PROMPT),
    content, signal, apiMode, proxyEndpoint, proxyToken,
  });
}

// Per-question explanation calls for Review Mode. Three flavours
// driven by request_type: 'why', 'show_steps', 'give_hint'. All
// share the image context (marked-up target page + previous-2 +
// next-1 for passage / table reference) and the question metadata.
//
// Returns the raw text response (NOT JSON) — the explanation is a
// short paragraph or step list that gets shown directly in the
// popup. Adding JSON wrapping would only add noise.
const EXPLANATION_PROMPT_BASE = `You are helping a parent understand why a primary-school worksheet question was marked the way it was.

You receive:
  - The TARGET page image — the page the question is on. The student's answer is in BLUE; the printed worksheet is in BLACK.
  - Up to 2 PREVIOUS pages and 1 NEXT page for passage / table / figure context. The student's blue ink is preserved on those too in case earlier working is relevant. Some context pages may be omitted at the start or end of the paper.
  - Question metadata: the printed question label, what the student wrote, what the correct answer is, and a one-sentence reason from the marker.

Style:
  - Match the worksheet's language. English for English / Math / Science / English-language papers; use 简体中文 if the worksheet is in 中文.
  - Age-appropriate for primary school (P1–P6). Short sentences, no jargon, no LaTeX.
  - Do NOT mention "the marker" or grading workflow — speak directly to the parent / child about the question.
  - Keep it concise. Length depends on request_type (see below).
  - The "don't repeat the correct answer" rule varies by request type — see each variant.
`;

const EXPLANATION_VARIANTS = {
  why: `Request type: WHY?
Explain in 2–4 sentences why the correct answer is what it is, and what the common mistake is here. Be plain-language. Do not produce a bulleted list.
Do NOT repeat the student's answer or the correct answer verbatim — those are already visible to the parent above your response. Address the REASON.`,
  show_steps: `Request type: SHOW STEPS
List the steps to solve this question, one per line, numbered. Each step is one short sentence. Aim for 3–6 steps. The last step should produce or clearly point to the correct answer. Do not add any preamble or wrap-up.
You MAY state the final answer at the last step — a worked solution that hides its conclusion is unhelpful. Do not pad earlier steps by repeating the student's answer.`,
  give_hint: `Request type: GIVE HINT
Give 1–2 sentences nudging the child toward the right approach WITHOUT revealing the correct answer. Phrase it as a question or a partial pointer ("Look at the second sentence of the passage…", "What unit does the question ask for?"). The child should still need to do the actual work after reading the hint.
Do NOT state, paraphrase, or trivially imply the correct answer in any form.`,
};

// Lightweight FNV-1a 32-bit hash. Used to fingerprint each prompt
// at module load so the practice-mode diagnostic dump can record
// which prompt version was active (without copying the full
// multi-kilobyte text into every dump). 8 hex chars × 5 prompts is
// plenty for spotting drift across builds; collisions in this
// tiny set don't matter. Sync + dependency-free, no Web Crypto
// async fuss.
function shortHash(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Stable per-prompt hashes — computed once at module load. The dump
// reads these and (when a custom prompt is in use) also hashes the
// active custom so the diff between "default" and "active" is
// visible.
export const PROMPT_HASHES = {
  student:        shortHash(STUDENT_PROMPT),
  studentSingle:  shortHash(STUDENT_PROMPT_SINGLE),
  answerKey:      shortHash(ANSWER_KEY_PROMPT),
  compare:        shortHash(COMPARE_PROMPT),
  compareVisual:  shortHash(COMPARE_VISUAL_PROMPT),
};

// Exported for the dump assembler so it can hash an active custom
// prompt for comparison against the default.
export { shortHash };

// Built-in prompts exposed for the Settings UI. Lets the
// custom-prompt textareas pre-fill with the current built-in
// text so reviewers can see what's being sent without grepping
// the source. pickPrompt() still treats empty / whitespace
// custom strings as "use built-in", so an unmodified textarea
// (visible text matches the built-in) saves as empty and stays
// in sync with future built-in edits.
//
// Keys mirror the settings field names without the "custom"
// prefix (customStudentPrompt → student, etc.) so the wiring
// in main.js is mechanical.
export const BUILTIN_PROMPTS = {
  student:                     STUDENT_PROMPT,
  studentSingle:               STUDENT_PROMPT_SINGLE,
  answerKey:                   ANSWER_KEY_PROMPT,
  compare:                     COMPARE_PROMPT,
  compareVisual:               COMPARE_VISUAL_PROMPT,
  pageDetection:               PAGE_DETECTION_PROMPT,
  explanationBase:             EXPLANATION_PROMPT_BASE,
  explanationVariantWhy:       EXPLANATION_VARIANTS.why,
  explanationVariantShowSteps: EXPLANATION_VARIANTS.show_steps,
  explanationVariantGiveHint:  EXPLANATION_VARIANTS.give_hint,
};

export async function requestExplanation({
  apiKey,
  model,
  requestType,           // 'why' | 'show_steps' | 'give_hint'
  question,              // printed label, e.g. "Q19" or "Q5b"
  studentAnswer,
  expectedAnswer,
  shortReason,
  pageImages,            // [{ role: 'target' | 'context', pageNumber, dataUrl }]
  signal,
  apiMode,
  proxyEndpoint,
  proxyToken,
  customExplanationBase,       // optional override for EXPLANATION_PROMPT_BASE
  customExplanationVariants,   // optional { why, show_steps, give_hint } —
                               // only present keys override; the rest fall
                               // through to the built-in variant strings
}) {
  const base = pickPrompt(customExplanationBase, EXPLANATION_PROMPT_BASE);
  const variants = {
    why:        pickPrompt(customExplanationVariants?.why,        EXPLANATION_VARIANTS.why),
    show_steps: pickPrompt(customExplanationVariants?.show_steps, EXPLANATION_VARIANTS.show_steps),
    give_hint:  pickPrompt(customExplanationVariants?.give_hint,  EXPLANATION_VARIANTS.give_hint),
  };
  const variant = variants[requestType] || variants.why;
  const system = `${base}\n${variant}`;
  const headerLines = [
    `Question: ${question || '(unknown)'}`,
    `Student wrote: ${studentAnswer || '(blank)'}`,
    `Correct answer: ${expectedAnswer || '(unspecified)'}`,
  ];
  if (shortReason) headerLines.push(`Marker's reason: ${shortReason}`);
  const content = [{ type: 'text', text: headerLines.join('\n') }];
  for (const p of pageImages) {
    content.push({
      type: 'text',
      text: p.role === 'target'
        ? `TARGET page ${p.pageNumber} — the page the question being explained is on. Use the question metadata above (printed label, student answer, correct answer) to find it on this page.`
        : `Context page ${p.pageNumber}.`,
    });
    // detail: 'low' — verified on the wire via Network payload
    // inspection. For patch-based models (gpt-5.4-mini included),
    // "low" resizes the image before patching but the resulting
    // token count is NOT the tile-model fixed 85-token rate.
    // Real observation on gpt-5.4-mini: ~1,707 tokens per image at
    // 'low' detail on a 150-DPI A4 page, vs ~2,490 expected at
    // 'high'. Modest savings, not the 4× the tile-based docs
    // would suggest.
    //
    // Tune cost via explanationRenderDpi in settings rather than
    // flipping this to 'high' — lower DPI = smaller source image
    // = fewer patches, even at the same detail setting. (Marking
    // calls keep 'high' because they have to read printed text
    // and the child's handwriting; explanation only needs to
    // interpret a known question, not extract from scratch.)
    content.push({ type: 'image_url', image_url: { url: p.dataUrl, detail: 'low' } });
  }
  if (!model) throw new Error('Model not set');
  const { url, headers } = buildRequest({ apiMode, apiKey, proxyEndpoint, proxyToken });
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
  };
  // Reasoning-class models reject the `temperature` parameter
  // (only temperature: 1 / unset is accepted). Detect by id pattern
  // and omit. Non-reasoning models get a low warmth — these are
  // explanations, not extractions, so a tiny bit of variation is
  // OK; 0.4 keeps it small.
  if (!isReasoningModel(model)) {
    body.temperature = 0.4;
  }
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e && (e.name === 'TypeError' || /failed to fetch|network/i.test(e.message || ''))) {
      throw new Error(
        `Could not reach ${url}. Check whether this device's network or parental-control filter is blocking that URL. Original error: ${e.message}`
      );
    }
    throw e;
  }
  if (!resp.ok) {
    const errText = await resp.text();
    if (resp.status === 429) {
      throw new Error(`429 OpenAI is rate-limiting. ${errText.slice(0, 200)}`);
    }
    throw new Error(`OpenAI ${resp.status}: ${errText.slice(0, 400)}`);
  }
  const json = await resp.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI response had no content');
  return { text: String(text).trim(), raw: json, usage: json.usage };
}

// Reasoning-class models reject the `temperature` parameter (only
// the default value is accepted), so callers must omit it for
// those. We match on:
//   - o-series:    o1, o3, etc.
//   - gpt-5.x variants explicitly tagged "reasoning" or "thinking"
//                  (e.g. "gpt-5-thinking-mini").
// The plain gpt-5.4 / gpt-5.4-mini / gpt-5.4-nano models in
// MODEL_PRESETS accept temperature normally and are intentionally
// NOT matched here — the marking pipeline relies on
// `temperature: 0` for deterministic JSON output and that has been
// running on gpt-5.4 successfully throughout the pipeline.
// Adding a blanket /^gpt-5/ would silently strip determinism for
// no benefit; revisit only if a real reasoning-tagged gpt-5.x
// variant gets used.
function isReasoningModel(model) {
  const m = String(model || '').toLowerCase();
  return /^o\d/.test(m)
      || /reasoning/.test(m)
      || /thinking/.test(m);
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
  };
  // See note in requestExplanation — reasoning models reject
  // explicit temperature. Omit for those, fix at 0 for everything
  // else (we want deterministic JSON output for marking).
  if (!isReasoningModel(model)) {
    body.temperature = 0;
  }
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
