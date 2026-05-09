// OpenAI vision call. Uses chat/completions with image_url parts.
// The system prompt and user prompt include the color-convention sentence
// verbatim — see design doc "Prompt contract".
//
// Model is configurable; default "gpt-4o-mini". Verify against current
// OpenAI model list when iterating; this is a config field, not hardcoded.

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT = [
  'You are an AI worksheet marking assistant for a parent.',
  'This is for practice review, not official grading.',
  "Use the provided answer sheet images as the primary source of truth for expected answers, but read the child's visible answer independently before comparing.",
  'The worksheet is printed in black ink on white paper.',
  "The child's handwritten answers appear in blue.",
  "Any blue marks on the page are the child's contribution.",
  'Any black marks are the original printed worksheet.',
  'Be careful and conservative.',
  'If handwriting is unclear, question numbering is uncertain, or the answer sheet mapping is unclear,',
  'mark the item as `needs_parent_review` instead of guessing.',
  'Return valid JSON only.',
].join(' ');

const USER_PROMPT_PREFIX = [
  'You will receive completed worksheet page images and answer sheet page images.',
  '',
  "The completed worksheet pages show the child's handwritten answers (in blue) on top of the printed worksheet (in black).",
  '',
  'The answer sheet pages are the reference answers.',
  '',
  'Please:',
  '1. Identify questions visible in the completed worksheet pages.',
  "2. Read the child's answers (the blue handwriting).",
  '3. Compare them with the answer sheet.',
  '4. Mark each question or sub-question.',
  '5. Use conservative confidence labels.',
  '6. Treat equivalent answers as correct where appropriate.',
  '7. Do not invent marking schemes if the answer sheet only gives final answers.',
  '8. Flag unclear handwriting or unclear mapping for parent review.',
  '9. Summarise likely weak knowledge points.',
  '10. Suggest questions to redo.',
  '11. Provide estimated score only if possible.',
  '12. Return JSON only.',
  '',
  'Special rules:',
  '- Equivalent forms can be correct, e.g. 1/2 and 0.5.',
  '- Equivalent units can be correct if suitable, e.g. 340 cm and 3 m 40 cm.',
  '- Minor formatting differences should not be penalised.',
  '- If partial credit is uncertain, flag for parent review.',
  '- If the answer is unreadable, do not guess.',
  '- For multi-part questions, use labels like Q5a, Q5b.',
  '- For tick-box or checkbox questions, first identify only the boxes visibly selected by the child. Do not infer missing ticks from the answer sheet.',
  '- Count a box as selected only if the blue mark is clearly inside or directly on the box. If a required tick is missing or unclear, do not mark the question correct.',
  '',
  'Each image part is preceded by a short text label naming the PDF page it shows',
  '(e.g. "Completed worksheet page PDF p.3" or "Answer sheet page PDF p.22").',
  'Use those page numbers when populating completed_page_number and answer_sheet_page_number',
  'so the parent can verify the AI was reading the right page.',
  '',
  'JSON shape (use exactly these keys):',
  '{',
  '  "paper_summary": { "subject": string, "estimated_score": string, "score_confidence": string, "overall_comment": string, "needs_parent_review_count": number },',
  '  "question_results": [ {',
  '    "question_number": string,',
  '    "completed_page_number": number,         // PDF page number (1-based) of the completed worksheet page where the student answer appears; null if unknown',
  '    "answer_sheet_page_number": number,      // PDF page number (1-based) of the answer sheet page that supplied the expected answer; null if unknown',
  '    "student_answer": string,',
  '    "expected_answer": string,',
  '    "marking_status": string,',
  '    "confidence": number,',
  '    "comment": string,',
  '    "knowledge_point": string,',
  '    "parent_review_needed": boolean,',
  '    "evidence_note": string                  // one short sentence saying which page each value was read from, e.g. "Student answer was read from completed page 3; expected answer found on answer sheet page 22."',
  '  } ],',
  '  "weak_knowledge_points": [ { "knowledge_point": string, "evidence_questions": string[], "comment": string } ],',
  '  "redo_suggestions": string[],',
  '  "parent_review_checklist": string[],',
  '  "limitations": string[]',
  '}',
].join('\n');

// Status values the report UI knows how to render.
export const KNOWN_STATUSES = [
  'correct_high_confidence',
  'wrong_high_confidence',
  'probably_correct',
  'probably_wrong',
  'needs_parent_review',
  'not_attempted',
  'unable_to_determine',
];

export async function markBatch({
  apiKey,
  model,
  completedPageImages, // [{ pageNumber, dataUrl }]
  answerPageImages,    // [{ pageNumber, dataUrl }]
  subject,
  level,
  signal,
}) {
  if (!apiKey) throw new Error('OpenAI API key not set');
  if (!model) throw new Error('Model not set');

  const completedRange = completedPageImages.map((p) => p.pageNumber).join(', ');
  const userText = [
    USER_PROMPT_PREFIX,
    '',
    `Subject: ${subject || 'unspecified'}`,
    `Level: ${level || 'unspecified'}`,
    `Completed worksheet pages included in this request: ${completedRange}`,
    'Mark only questions visible in these completed pages.',
  ].join('\n');

  // Interleave a short label before each image so the model can map answers
  // to specific PDF page numbers reliably.
  const content = [{ type: 'text', text: userText }];
  for (const p of completedPageImages) {
    content.push({ type: 'text', text: `Completed worksheet page PDF p.${p.pageNumber}` });
    content.push({
      type: 'image_url',
      image_url: { url: p.dataUrl, detail: 'high' },
    });
  }
  for (const p of answerPageImages) {
    content.push({ type: 'text', text: `Answer sheet page PDF p.${p.pageNumber}` });
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

// Merge per-batch JSONs into a single report.
export function mergeReports(batchReports) {
  const merged = {
    paper_summary: {
      subject: '',
      estimated_score: '',
      score_confidence: 'low',
      overall_comment: '',
      needs_parent_review_count: 0,
    },
    question_results: [],
    weak_knowledge_points: [],
    redo_suggestions: [],
    parent_review_checklist: [],
    limitations: [],
  };
  const seenWeak = new Map();
  const seenRedo = new Set();
  const seenChecklist = new Set();
  const seenLimitations = new Set();
  for (const r of batchReports) {
    if (!r) continue;
    if (r.paper_summary) {
      merged.paper_summary.subject ||= r.paper_summary.subject || '';
      merged.paper_summary.overall_comment +=
        (merged.paper_summary.overall_comment && r.paper_summary.overall_comment ? ' ' : '') +
        (r.paper_summary.overall_comment || '');
      merged.paper_summary.needs_parent_review_count +=
        Number(r.paper_summary.needs_parent_review_count) || 0;
    }
    if (Array.isArray(r.question_results)) merged.question_results.push(...r.question_results);
    if (Array.isArray(r.weak_knowledge_points)) {
      for (const w of r.weak_knowledge_points) {
        const key = (w.knowledge_point || '').toLowerCase().trim();
        if (!key) continue;
        if (seenWeak.has(key)) {
          const existing = seenWeak.get(key);
          const ev = new Set([...(existing.evidence_questions || []), ...(w.evidence_questions || [])]);
          existing.evidence_questions = [...ev];
        } else {
          const copy = { ...w, evidence_questions: [...(w.evidence_questions || [])] };
          seenWeak.set(key, copy);
          merged.weak_knowledge_points.push(copy);
        }
      }
    }
    if (Array.isArray(r.redo_suggestions)) {
      for (const q of r.redo_suggestions) if (!seenRedo.has(q)) { seenRedo.add(q); merged.redo_suggestions.push(q); }
    }
    if (Array.isArray(r.parent_review_checklist)) {
      for (const q of r.parent_review_checklist) if (!seenChecklist.has(q)) { seenChecklist.add(q); merged.parent_review_checklist.push(q); }
    }
    if (Array.isArray(r.limitations)) {
      for (const q of r.limitations) if (!seenLimitations.has(q)) { seenLimitations.add(q); merged.limitations.push(q); }
    }
  }
  // Sum estimated score from individual batches (best-effort): if every
  // batch reported "X/Y" totals, add them; otherwise leave blank with low
  // confidence.
  let scoreNum = 0, scoreDen = 0, allParseable = true;
  for (const r of batchReports) {
    const s = r?.paper_summary?.estimated_score || '';
    const m = String(s).match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    if (m) { scoreNum += parseFloat(m[1]); scoreDen += parseFloat(m[2]); } else { allParseable = false; }
  }
  if (allParseable && scoreDen > 0) {
    const trimmed = (n) => Number.isInteger(n) ? n.toString() : n.toFixed(1);
    merged.paper_summary.estimated_score = `${trimmed(scoreNum)}/${trimmed(scoreDen)}`;
    merged.paper_summary.score_confidence = 'medium';
  }
  return merged;
}

export function chunkPages(pages, size) {
  const out = [];
  for (let i = 0; i < pages.length; i += size) out.push(pages.slice(i, i + size));
  return out;
}
