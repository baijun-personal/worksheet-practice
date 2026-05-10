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

Each item in "items" is EITHER:
  (A) FLAT — has student_answer and expected_answer fields. Compare them and return one row.
  (B) MULTI-PART — has is_multi_part: true with student_parts[] and expected_parts[]. Return ONE row with is_multi_part: true and parts[] containing per-part statuses.

For multi-part items:
  • If order_matters: true — compare each student part against the expected part with the SAME "part" label, or by index when labels are missing.
  • If order_matters: false — POOL MATCH. The student may have written list items in any order, so do NOT assume student_parts[i] should be compared with expected_parts[i]. Walk each student part and look for ANY expected_part (regardless of part label or index) whose meaning matches. Each expected_part may be matched at most once across the whole question. A student part is correct if some unused expected_part means the same; otherwise incorrect.
  • For each student part, set "matched_expected" to the expected text it matched (or "" / null if none).

WORKED EXAMPLE — pool match (order_matters: false):

  Input item:
    {
      "question": "Q19",
      "is_multi_part": true,
      "order_matters": false,
      "student_parts":  [{"part":"i","answer":"No"}, {"part":"ii","answer":"stay alert"}],
      "expected_parts": [{"part":"i","answer":"To be alert"}, {"part":"ii","answer":"Avoid eye contact with them"}]
    }

  Reasoning:
    - "No" doesn't mean "To be alert" or "Avoid eye contact with them" → incorrect.
    - "stay alert" means the same as "To be alert" → correct, even though the student wrote it as part (ii) and the matching expected is at part (i). Position is irrelevant when order_matters is false.

  Correct output:
    {
      "question": "Q19",
      "is_multi_part": true,
      "parts": [
        {"part":"i",  "student_answer":"No",         "matched_expected":"",            "status":"incorrect", "comment":"'No' does not match any expected item."},
        {"part":"ii", "student_answer":"stay alert", "matched_expected":"To be alert", "status":"correct",   "comment":"Same meaning as 'To be alert' (matched across positions because order_matters is false)."}
      ]
    }

  WRONG output (do not produce this):
    parts where part:'ii' is paired with expected_parts[1] "Avoid eye contact with them" just because they share index 1. Pool matching means "stay alert" can match "To be alert" at any position.

Status rules (apply to flat rows AND to each part of multi-part rows):
- correct: same answer or same meaning (paraphrases, equivalent forms, equivalent units, minor formatting differences are correct).
- incorrect: different meaning, wrong choice, irrelevant answer, OR student answer is blank/missing while expected is present.
- unclear: expected answer is missing, the student answer reads "unclear" or is unreadable, the question matching is uncertain, or judgement genuinely cannot be made from the extracted text.

Confidence rule: treat match_confidence >= 0.8 as reliable — do not mark an item "unclear" solely because of match_confidence in that range. Only use "unclear" when the answer text itself is missing/unreadable or the comparison genuinely cannot be made.

For MCQ-style answers, "3 (scooped)" should be considered the same as "3" or "scooped" alone — match by either component.

The 'question' field carries the printed question label (e.g. "Q17", "Q19"); preserve it exactly in your output.

REVIEW FIELDS (Phase 1 of Review Mode):
For ANY row or part where status is "incorrect" or "unclear", additionally produce these fields. They drive a parent-facing review surface that highlights wrong answers on the printed paper image and lets the parent open a popup explaining what went wrong.

  short_display_answer  — a SHORT (≤24 character) form of the correct answer, suitable for inline display next to a marker on the printed page. Examples: "1/4", "B", "scooped", "30 cm", "True". Use the expected_answer as the source; trim explanation text.
  short_reason          — one short, parent-friendly sentence explaining why the answer is wrong or unclear. Example: "Wrote 4 instead of 1." or "Answer is unreadable."
  confidence            — a number in [0, 1] reflecting how confident you are in the comparison verdict. Use < 0.5 when something is genuinely ambiguous (e.g. unreadable handwriting, ambiguous question matching, units uncertain).
  question_start_location — a best-effort page+coordinate hint of where the printed question heading begins. Schema:
        { "page": <integer>, "x": <0..1>, "y": <0..1> }
    "page" should equal the input item's "completed_page" exactly — that field is definitive (it comes from the per-answer page metadata produced during extraction). "x" is the horizontal position (origin = left edge), "y" is vertical (origin = top edge). You don't see the rendered page, so your coordinate guess is approximate — code-side post-processing replaces obvious garbage with an ordinal-based fallback. Provide a sensible band:
       x = 0.06 (questions start near the left margin in every Singapore primary worksheet we've measured)
       y = (page_question_index + 0.5) / questions_on_page, BUT bias upward when the question is short (one-line MCQ) and downward when the previous questions are long (list answers, comprehension). The two metadata fields tell you the ordinal position; your judgement adjusts for spacing.
    If "completed_page" is missing on the input item, omit the location entirely (don't fabricate one).

For MULTI-PART rows where some parts are correct and others are incorrect/unclear, attach the row-level review fields ONCE on the row (not per-part). Per-part status / comment / matched_expected stay as before.

Return JSON only:
{
  "summary": {
    "estimated_score": "",
    "comment": ""
  },
  "questions": [
    // Flat row (incorrect or unclear adds review fields):
    {
      "question": "",
      "student_answer": "",
      "expected_answer": "",
      "status": "correct | incorrect | unclear",
      "comment": "",
      "short_display_answer": "",
      "short_reason": "",
      "confidence": 0,
      "question_start_location": { "page": 0, "x": 0, "y": 0 }
    },
    // Multi-part row (review fields once at row level when any part is wrong):
    {
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
      "confidence": 0,
      "question_start_location": { "page": 0, "x": 0, "y": 0 }
    }
  ],
  "redo": [],
  "weak_points": []
}`;

const STUDENT_PROMPT = `Extract the child's answers from these completed worksheet pages.

The printed worksheet is black. The child's answers are blue. Read only the blue answers.

Do not mark. Do not compare with an answer key. Do not use printed page numbers, score boxes, marks, or footer numbers as answers.

Preserve the printed question_number EXACTLY as it appears on the page — for example "17", "5a", "19(i)". Do not invent, renumber, skip, or replace it with the question text.

There are TWO different kinds of subparts. Use the right schema for each:

(A) LIST-ANSWER question — single stem asking for several items.
    Examples: "Name two reasons", "List three examples", "What two things should…", "State two ways to stay safe".
    Output ONE entry with:
      question_number: the printed base number (e.g. "19" or "5")
      is_multi_part: true
      order_matters: false  (default for list-answer questions)
      parts: [
        { "part": "i",  "answer_type": "...", "answer": "...", "confidence": 0.9 },
        { "part": "ii", "answer_type": "...", "answer": "...", "confidence": 0.9 }
      ]
    Use the printed slot label as the "part" value (e.g. "i", "ii", "a", "b"). If no slot label is printed, use "1", "2", "3"… in the order the child wrote them.

    Set order_matters: TRUE only when the question explicitly requires sequence/order/arrangement, e.g. "arrange the events in the correct order", "sequence the steps", "first / next / last", "before / after", "find x, y and z" with named slots.

(B) DISTINCT SUB-QUESTIONS — each subpart has its own different question text on the page (e.g. Q5a is one question, Q5b is a different question with its own prompt and answer).
    Output SEPARATE flat entries with question_number "5a" and "5b" — DO NOT group these under a single "5" entry. Each is independent.

Never duplicate the same "question_number" label without a subpart suffix. If you produce two entries with the same composite key, the later one will silently overwrite the earlier; use the multi-part form (A) instead.

"display_question" is a SHORT label only — values like "Q17", "Q19", or "Section A Q1". Do NOT put the full question text into display_question; it's used as a heading in the report, not as the question prompt itself.

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

Return JSON only. Each entry is EITHER flat (single answer) OR multi-part:

{
  "answers": [
    // Flat entry:
    {
      "global_question_index": 1,
      "section": "",
      "question_number": "",
      "display_question": "",
      "page": 0,
      "answer_type": "text | choice | number | tick_box | drawing | diagram_label | unknown",
      "answer": "",
      "confidence": 0
    },
    // Multi-part entry (list-answer / sequence questions):
    {
      "global_question_index": 2,
      "section": "",
      "question_number": "",
      "display_question": "",
      "page": 0,
      "is_multi_part": true,
      "order_matters": false,
      "parts": [
        { "part": "i",  "answer_type": "text", "answer": "", "confidence": 0 },
        { "part": "ii", "answer_type": "text", "answer": "", "confidence": 0 }
      ]
    }
  ]
}`;

const ANSWER_KEY_PROMPT = `Extract the expected answers from these answer sheet pages.

CRITICAL — compact MCQ answer grids: many answer keys pack the MCQ section into a tight tabular grid where each cell holds a question number paired with its answer. For example:

    | 1  | 1  | 6  | 2  | 11 | 4  | 16 | 4  | 21 | 3  | 26 | 1 |
    | 2  | 2  | 7  | 4  | 12 | 3  | 17 | 4  | 22 | 3  | 27 | 3 |
    | 3  | 4  | 8  | 2  | 13 | 2  | 18 | 3  | 23 | 1  | 28 | 2 |
    ...

Each "<number> <number>" pair in such a grid is ONE entry: the first number is the question_number and the second is the answer. The grid above carries 30 separate entries (Q1 answer 1, Q2 answer 2, Q3 answer 4, Q6 answer 2, Q7 answer 4, Q8 answer 2, Q11 answer 4, …). Output ALL of them, not just the open-ended answers below the grid. Do not skip the grid because it looks dense or repetitive — those compact pairs are the bulk of the answer key.

Preserve the printed question_number EXACTLY as it appears (e.g. "17", "5a", "19(i)"). Do not renumber or skip questions.

For LIST-ANSWER questions (single stem with several expected items, e.g. "Name two reasons"), output ONE entry with:
  question_number: the base printed number (e.g. "19" or "5")
  is_multi_part: true
  order_matters: matches the question's requirement (false by default; true only for "arrange in order"/"sequence"/"first/next/last"/"x, y, z" named-slot questions)
  parts: [{ "part": "i", "answer_type": "...", "answer": "...", "confidence": 0 }, ...]

For DISTINCT sub-questions where each subpart has its own question text (e.g. Q5a and Q5b are independent), output SEPARATE flat entries with question_number "5a" and "5b". Do NOT group these.

Never produce two entries with the same composite key (section + question_number) — use the multi-part form when there are multiple expected items for the same printed question.

"display_question" is a SHORT label only — e.g. "Q17", "Q19". Do NOT put the full question text or expected-answer text into display_question.

Note: answer-key pages may not always show full question wording; if order_matters is unclear from the answer key alone, leave order_matters: false (the student-side extraction will set it correctly).

For each expected answer, set "answer_type" to one of the same values used for the student extraction:
- "text", "choice", "number", "tick_box", "drawing", "diagram_label", "unknown".

For choice questions, if the option text is visible next to the option number/letter on the answer sheet, include both in "answer", e.g. "3 (scooped)" or "B (the dolphin jumped)". This helps later comparison when the student's extraction may carry the option number while the key carries the option text or vice versa.

CLASSIFICATION RULE: if the expected answer cannot be FULLY represented as typed text — shaded area, matching line, arrow, plotted point, clock hand, completed diagram, drawn shape, etc. — classify it as "drawing" or "diagram_label", NOT "text". For these visual expected answers, "answer" is a short description ("a clock showing 3:15", "the upper half shaded", "lines connecting A→3, B→1"); the final judgement is done by a separate visual comparison stage, not by text equality.

If a worksheet has multiple sections, capture the section label. Use the page number from the image label.

Return JSON only. Each entry is EITHER flat (single answer) OR multi-part (list-answer / sequence question):

{
  "answers": [
    // Flat entry:
    {
      "global_question_index": 1,
      "section": "",
      "question_number": "",
      "display_question": "",
      "page": 0,
      "answer_type": "text | choice | number | tick_box | drawing | diagram_label | unknown",
      "answer": "",
      "confidence": 0
    },
    // Multi-part entry:
    {
      "global_question_index": 2,
      "section": "",
      "question_number": "",
      "display_question": "",
      "page": 0,
      "is_multi_part": true,
      "order_matters": false,
      "parts": [
        { "part": "i",  "answer_type": "text", "answer": "", "confidence": 0 },
        { "part": "ii", "answer_type": "text", "answer": "", "confidence": 0 }
      ]
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
      ? `Completed contact-sheet image: pages ${p.includedPageNumbers.join(', ')} arranged on a single A4 sheet ` +
        `(layout chosen for the page count: 1 = full page, 2 = stacked, 3 = one wide on top + two below, 4 = 2x2 grid). ` +
        `Each tile carries a small dark-grey label "PDF page N — not student answer" above it. ` +
        `Use that tile label to identify the page number for any answer in that tile. ` +
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
    const label = (p.contactSheet && Array.isArray(p.includedPageNumbers))
      ? `Answer-key contact-sheet image: pages ${p.includedPageNumbers.join(', ')} arranged on a single A4 sheet ` +
        `(layout chosen for the page count: 1 = full page, 2 = stacked, 3 = one wide on top + two below, 4 = 2x2 grid). ` +
        `Each tile carries a small dark-grey label "Answer page N" above it — that's the source PDF page number, ` +
        `not part of the answer key.`
      : `Answer page ${p.pageNumber}`;
    content.push({ type: 'text', text: label });
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

export async function detectPages({
  apiKey,
  model,
  pageImages,            // [{ contactSheet?: true, includedPageNumbers?: [], pageNumber?: 0, dataUrl }]
  signal,
  apiMode,
  proxyEndpoint,
  proxyToken,
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
  return chatJson({ apiKey, model, system: PAGE_DETECTION_PROMPT, content, signal, apiMode, proxyEndpoint, proxyToken });
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
  // Per-page question count + per-pair page index. Used to give
  // the AI enough metadata to synthesize a meaningful y-position
  // for question_start_location — without page+ordinal context,
  // the AI's coordinate output was a guess in [0,1] with no
  // grounding. Reviewer-2 flagged this in the v4 round.
  const pageQuestionCounts = new Map();
  for (const p of pairs) {
    const pg = Number(p.completed_page);
    if (Number.isFinite(pg)) {
      pageQuestionCounts.set(pg, (pageQuestionCounts.get(pg) || 0) + 1);
    }
  }
  // Sort pairs per page to compute each pair's index-on-page.
  const pairsOnPage = new Map(); // page -> [pair, ...]
  for (const p of pairs) {
    const pg = Number(p.completed_page);
    if (!Number.isFinite(pg)) continue;
    if (!pairsOnPage.has(pg)) pairsOnPage.set(pg, []);
    pairsOnPage.get(pg).push(p);
  }
  for (const list of pairsOnPage.values()) {
    // Sort by numeric prefix only. Q5a / Q5b / Q5c will tie on
    // their leading "5" — we rely on Array.sort being stable
    // (ES2019+) so they keep the input order, which traces back
    // through matchExtractions → studentResults flattening →
    // extraction. The pipeline preserves document order today.
    // If you ever introduce a re-sort earlier in the pipeline,
    // make this comparator a full tie-breaker instead.
    list.sort((a, b) => {
      const ka = String(a.display_question || a.question || '');
      const kb = String(b.display_question || b.question || '');
      const na = (ka.match(/\d+/) || ['0'])[0];
      const nb = (kb.match(/\d+/) || ['0'])[0];
      return Number(na) - Number(nb);
    });
  }
  const indexOnPage = new Map(); // pair → index within page
  for (const list of pairsOnPage.values()) {
    list.forEach((p, i) => indexOnPage.set(p, i));
  }

  const payload = {
    subject: subject || '',
    level: level || '',
    items: pairs.map((p) => {
      const item = {
        question: p.display_question || p.question,
        match_confidence: typeof p.match_confidence === 'number' ? p.match_confidence : 1,
      };
      // Page metadata so the AI can return a non-fake
      // question_start_location. completed_page is from extraction
      // (definitive); page_question_index + questions_on_page let
      // the AI compute a sensible y for "this is question N of K
      // on the page".
      if (Number.isFinite(Number(p.completed_page))) {
        item.completed_page = Number(p.completed_page);
        item.page_question_index = indexOnPage.get(p) ?? null;
        item.questions_on_page = pageQuestionCounts.get(Number(p.completed_page)) || null;
      }
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
  return chatJson({ apiKey, model, system: COMPARE_PROMPT, content, signal, apiMode, proxyEndpoint, proxyToken });
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
  - The TARGET page image with a red ✗ next to the printed question heading the parent is asking about. The student's answer is in BLUE; the printed worksheet is in BLACK.
  - The 2 PREVIOUS pages and the NEXT page (cleanly rendered, no markup) — for passage / table / figure context. Some pages may be omitted at the start or end of the paper.
  - Question metadata: the printed question label, what the student wrote, what the correct answer is, and a one-sentence reason from the marker.

Style:
  - Match the worksheet's language. English for English / Math / Science / English-language papers; use 简体中文 if the worksheet is in 中文.
  - Age-appropriate for primary school (P1–P6). Short sentences, no jargon, no LaTeX.
  - Do NOT mention the red ✗ or "the marker" or grading workflow — speak directly to the parent / child about the question.
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
}) {
  const variant = EXPLANATION_VARIANTS[requestType] || EXPLANATION_VARIANTS.why;
  const system = `${EXPLANATION_PROMPT_BASE}\n${variant}`;
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
        ? `TARGET page ${p.pageNumber} — the red ✗ marks the question being explained.`
        : `Context page ${p.pageNumber}.`,
    });
    content.push({ type: 'image_url', image_url: { url: p.dataUrl, detail: 'high' } });
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

// Reasoning-class models (o1, o3, gpt-5+ reasoning variants) reject
// the temperature parameter — only the default is accepted, so
// callers must omit it. Match conservatively on common id prefixes
// and the "thinking" / "reasoning" suffix conventions.
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
