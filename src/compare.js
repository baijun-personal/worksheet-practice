// Code-side matching + post-processing for the staged marking pipeline.
//
// Stage 1 ("student") and Stage 2 ("answer key") each produce
//   { answers: [{ global_question_index, section, question_number,
//                 display_question, page, answer, confidence }, ...] }
//
// This module is responsible for:
//   1. matchExtractions(): pairing student answers to answer-key entries by
//      printed question identity (section + question_number, with a safe
//      qnum-only fallback). Returns matched pairs + a not_in_attempt list.
//   2. partitionPairsByModality(): split into text vs visual pairs so
//      they can be sent to the right comparison call.
//   3. buildFinalReport(): merge the AI text-compare output and the
//      per-question visual-compare outputs into the report shape used
//      by the UI, enriched with local pair metadata (page numbers,
//      section, display label) the AI doesn't see. For multi-part
//      pairs, flattens to per-part display rows here. Falls back to
//      string-equality scoring (per-row or per-part) when the AI
//      compare call didn't grade an item.
//
// Why split? The compare prompt previously embedded BOTH semantic
// reasoning AND image reading in a single OpenAI call, which was the
// source of multiple bugs (answer key biased handwriting reads;
// global-index fallbacks crossed wires on subset pages). Now image
// reads are isolated to extractions, matching is deterministic in code,
// and only the final correct/incorrect/unclear judgment goes to AI —
// text-only, with no image bias possible.

// Normalize a free-form answer for the local-fallback equality scorer
// (NOT used in the AI-compare path). Permissive on spacing / casing /
// full-half-width digits; doesn't attempt semantic equivalence — that
// is the AI compare call's job.
export function normalizeAnswer(value) {
  if (value == null) return '';
  let v = String(value);
  v = v.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  v = v.replace(/　/g, ' ');
  v = v.replace(/^\s*(?:question\s+|q\.?\s*)(?=\S)/i, '');
  v = v.toLowerCase();
  v = v.replace(/\s+/g, ' ').trim();
  v = v.replace(/^[\.,;:!?。，；：！？"'“”‘’]+|[\.,;:!?。，；：！？"'“”‘’]+$/g, '');
  v = v.replace(/\btrue\b/g, 't').replace(/\bfalse\b/g, 'f');
  return v.trim();
}

function normalizeKeyPart(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

// Normalize a printed question-number into a stable matching key.
//   "Q17"        → "17"
//   "17"         → "17"
//   "5a"         → "5a"
//   "Q19(i)"     → "19i"
//   "Q 19 (i)"   → "19i"
//   "Question 5" → "5"
function normalizeQNumber(q) {
  if (q == null) return '';
  let s = String(q).trim().toLowerCase();
  s = s.replace(/^q(?:uestion)?\.?\s*/, '');
  s = s.replace(/[.:]+$/, '');
  s = s.replace(/[()\s]+/g, '');
  return s;
}

function compositeKey(section, qnum) {
  return `${normalizeKeyPart(section)}|${normalizeQNumber(qnum)}`;
}

function flattenAnswers(stageResults) {
  const out = [];
  for (const r of stageResults) {
    if (!r) continue;
    if (Array.isArray(r.answers)) {
      for (const a of r.answers) if (a && typeof a === 'object') out.push(a);
    }
  }
  return out;
}

// Defensive multi-part normalization. Handles three input shapes from the
// extraction stage:
//   1. Already grouped (is_multi_part: true, parts: [...]) — preserved.
//   2. Single flat entry with a unique composite key — preserved.
//   3. Multiple flat entries that share the same composite key — silently
//      a duplicate-key bug (the older code's failure mode for Q19). We
//      auto-merge them into a multi-part group with order_matters: false
//      so pool-matching can still produce a sensible result.
//
// We deliberately do NOT auto-group separate "5a"/"5b" entries (different
// composite keys) — those are independent sub-questions on many papers.
// The extraction prompt is the place that decides between flat-with-suffix
// and grouped-multi-part; this helper just rescues malformed output.
function normalizeMultiParts(answers) {
  const byKey = new Map();
  const order = [];

  function getOrCreate(ck, source) {
    if (byKey.has(ck)) return byKey.get(ck);
    // Shallow clone so we can mutate without touching the model's output.
    const entry = { ...source };
    byKey.set(ck, entry);
    order.push(ck);
    return entry;
  }

  function flatToPart(a, autoLabel) {
    return {
      part: a.part != null && a.part !== '' ? String(a.part) : autoLabel,
      answer_type: a.answer_type || 'text',
      answer: a.answer ?? '',
      confidence: typeof a.confidence === 'number' ? a.confidence : null,
    };
  }

  for (const a of answers) {
    if (!a) continue;
    const ck = compositeKey(a.section || '', a.question_number || '');

    if (a.is_multi_part === true && Array.isArray(a.parts)) {
      const existing = byKey.get(ck);
      if (!existing) {
        // Normalize the parts array shape.
        const cloned = { ...a, parts: a.parts.map((p, i) => flatToPart(p, String(i + 1))) };
        byKey.set(ck, cloned);
        order.push(ck);
      } else {
        // Same composite was seen earlier (rare). Merge parts together.
        const merged = ensureMultiPart(existing);
        for (const p of a.parts) merged.parts.push(flatToPart(p, String(merged.parts.length + 1)));
      }
      continue;
    }

    // Flat entry.
    const existing = byKey.get(ck);
    if (!existing) {
      getOrCreate(ck, a);
    } else {
      // Duplicate composite key with flat shape — promote to multi-part.
      const merged = ensureMultiPart(existing);
      merged.parts.push(flatToPart(a, String(merged.parts.length + 1)));
    }
  }

  const dedup = order.map((ck) => byKey.get(ck));

  // SECOND PASS — auto-group entries whose question_number has a
  // parenthesised subpart suffix (e.g. "19(i)" + "19(ii)") into a
  // single multi-part record keyed by the base ("19"). The student
  // extraction often emits these as separate flat entries even when
  // the prompt asks for the grouped form; without this pass, the
  // matcher pairs them positionally with the answer key's "19(i)"
  // and "19(ii)" entries and the AI compare never sees them as one
  // pool. This rule does NOT touch suffixes WITHOUT parens like
  // "5a" / "5b" — those are typically distinct sub-questions.
  const baseGroups = new Map();   // composite-key-of-base -> group entry
  const survivors = [];

  for (const entry of dedup) {
    if (entry.is_multi_part === true && Array.isArray(entry.parts)) {
      survivors.push(entry);
      continue;
    }
    const sub = parseParenSubpart(entry.question_number);
    if (!sub) {
      survivors.push(entry);
      continue;
    }
    const baseCk = compositeKey(entry.section || '', sub.base);
    if (!baseGroups.has(baseCk)) {
      baseGroups.set(baseCk, {
        global_question_index: entry.global_question_index,
        section: entry.section || '',
        question_number: sub.base,
        page: entry.page,
        is_multi_part: true,
        order_matters: false,  // safe default for list-answer slots
        parts: [],
      });
    }
    const group = baseGroups.get(baseCk);
    group.parts.push({
      part: sub.part,
      answer_type: entry.answer_type || 'text',
      answer: entry.answer ?? '',
      confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
    });
  }

  return [...survivors, ...baseGroups.values()];
}

// Convert a flat entry in-place into a multi-part one (one part holding
// the original answer). Returns the same object so callers can chain.
function ensureMultiPart(entry) {
  if (entry.is_multi_part === true && Array.isArray(entry.parts)) return entry;
  const firstPart = {
    part: '1',
    answer_type: entry.answer_type || 'text',
    answer: entry.answer ?? '',
    confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
  };
  entry.is_multi_part = true;
  entry.order_matters = false;
  entry.parts = [firstPart];
  delete entry.answer;
  delete entry.answer_type;
  delete entry.confidence;
  return entry;
}

function buildDisplayQuestion(a) {
  // Always rebuild from question_number / section. The AI's
  // display_question is unreliable — it sometimes returns the full
  // question text ("In paragraph 3, what two things..."), which is
  // useless as a label. We only fall back to display_question if it
  // exists AND looks short and label-like (no spaces > a couple).
  const q = a.question_number ? String(a.question_number).trim() : '';
  const s = a.section ? String(a.section).trim() : '';
  if (q) {
    const qLabel = /^Q/i.test(q) ? q : `Q${q}`;
    return s ? `${s} ${qLabel}` : qLabel;
  }
  if (a.display_question) {
    const dq = String(a.display_question).trim();
    if (dq && dq.length <= 24 && !/\?/.test(dq)) return dq;
  }
  if (a.global_question_index != null) return `Q${a.global_question_index}`;
  return '';
}

// Detect a parenthesised subpart suffix like "19(i)", "5(ii)",
// "Q19(iii)". Returns { base, part } when present, else null. We
// deliberately don't match suffixes WITHOUT parens like "5a" / "5b"
// — those are typically distinct sub-questions on Singapore primary
// papers, not list-answer slots, and should remain as separate pairs.
function parseParenSubpart(qnumber) {
  const s = String(qnumber || '').trim();
  const m = s.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (!m) return null;
  const base = m[1].trim();
  const part = m[2].trim();
  if (!base || !part) return null;
  return { base, part };
}

// matchExtractions(studentBatchResults, answerKeyResults)
//   → { pairs, not_in_attempt, keysProvided }
//
// Every entry in `pairs` represents a question the student attempted;
// `expected_answer` is empty when no matching answer-key entry exists.
// `match_confidence` is a hint for the AI compare call:
//   1.00 — student's local section + question_number matched exactly.
//   0.85 — qnum-only match (no section, but unique across the key).
//   0.50 — student answered but no key match (compare call should
//          probably mark this 'unclear' unless it can decide).
// We deliberately do NOT use global_question_index as a fallback,
// because the student's pages are often a subset of the worksheet and
// local indexes 1/2/3 would collide with the key's Q1/Q2/Q3.
export function matchExtractions(studentBatchResults, answerKeyResults) {
  // Pre-normalize so duplicate composite keys auto-merge into multi-part
  // groups (rather than silently overwriting). After this, each composite
  // key appears at most once in students/keys.
  const students = normalizeMultiParts(flattenAnswers(studentBatchResults));
  const keys = normalizeMultiParts(flattenAnswers(answerKeyResults));

  const keyByKey = new Map();
  const keyByKeyAmbiguous = new Set();
  const keyByQNum = new Map();
  const keyByQNumAmbiguous = new Set();
  for (const k of keys) {
    if (k.section || k.question_number) {
      const ck = compositeKey(k.section || '', k.question_number || '');
      if (keyByKey.has(ck)) keyByKeyAmbiguous.add(ck);
      else keyByKey.set(ck, k);
    }
    const qn = normalizeQNumber(k.question_number);
    if (qn) {
      if (keyByQNum.has(qn)) keyByQNumAmbiguous.add(qn);
      else keyByQNum.set(qn, k);
    }
  }

  const pairs = [];
  const usedKeyRefs = new Set();

  for (const s of students) {
    let key = null;
    let matchMethod = 'unmatched';
    let matchConfidence = 0.5;
    const ck = compositeKey(s.section || '', s.question_number || '');
    if (keyByKeyAmbiguous.has(ck)) {
      // Composite key collides with another answer-key entry —
      // refuse to pick one. Pair has no expected answer; AI compare
      // gets a low match_confidence and should mark unclear.
      matchMethod = 'ambiguous-composite-key';
      matchConfidence = 0.4;
    } else if (keyByKey.has(ck)) {
      key = keyByKey.get(ck);
      matchMethod = 'section+question_number';
      matchConfidence = 1.0;
    } else {
      const qn = normalizeQNumber(s.question_number);
      if (qn && keyByQNum.has(qn) && !keyByQNumAmbiguous.has(qn)) {
        key = keyByQNum.get(qn);
        matchMethod = 'question_number-only';
        matchConfidence = 0.85;
      }
    }
    // Lower confidence if student extraction was itself low-confidence.
    if (typeof s.confidence === 'number' && s.confidence < 0.5) {
      matchConfidence = Math.min(matchConfidence, s.confidence);
    }
    if (key) usedKeyRefs.add(refOf(key));

    // Determine whether this pair is multi-part. Either side being
    // multi-part promotes the pair into a multi-part record so the
    // comparison call can reason over parts coherently.
    const studentGrouped = s.is_multi_part === true && Array.isArray(s.parts);
    const keyGrouped = !!key && key.is_multi_part === true && Array.isArray(key.parts);
    const isMultiPart = studentGrouped || keyGrouped;

    // student-side wording is the more reliable source for order_matters
    // (the question wording is on the worksheet, not the answer sheet).
    const orderMatters = studentGrouped
      ? !!s.order_matters
      : (keyGrouped ? !!key.order_matters : false);

    const studentParts = studentGrouped
      ? s.parts.map((p, i) => ({
          part: p.part != null ? String(p.part) : String(i + 1),
          answer: p.answer ?? '',
          answer_type: p.answer_type || 'text',
          confidence: typeof p.confidence === 'number' ? p.confidence : null,
        }))
      : [{
          part: '1',
          answer: s.answer ?? '',
          answer_type: s.answer_type || 'text',
          confidence: typeof s.confidence === 'number' ? s.confidence : null,
        }];
    const expectedParts = keyGrouped
      ? key.parts.map((p, i) => ({
          part: p.part != null ? String(p.part) : String(i + 1),
          answer: p.answer ?? '',
          answer_type: p.answer_type || 'text',
          confidence: typeof p.confidence === 'number' ? p.confidence : null,
        }))
      : (key
          ? [{
              part: '1',
              answer: key.answer ?? '',
              answer_type: key.answer_type || 'text',
              confidence: typeof key.confidence === 'number' ? key.confidence : null,
            }]
          : []);

    pairs.push({
      question: String(s.question_number || s.global_question_index || ''),
      section: s.section || '',
      display_question: buildDisplayQuestion(s),
      completed_page: s.page ?? null,
      answer_page: key?.page ?? null,
      // Multi-part fields (always populated; for flat pairs parts has length 1).
      is_multi_part: isMultiPart,
      order_matters: orderMatters,
      student_parts: studentParts,
      expected_parts: expectedParts,
      // Flat convenience fields — preserved for the non-grouped flow so
      // existing readers (markPairs, fallback scoring) work unchanged.
      // For grouped pairs these are derived for fallback display only.
      student_answer: studentGrouped
        ? studentParts.map((p) => p.answer).filter(Boolean).join('; ')
        : (s.answer ?? ''),
      student_confidence: studentGrouped
        ? null
        : (typeof s.confidence === 'number' ? s.confidence : null),
      student_type: studentGrouped ? '' : (s.answer_type || ''),
      expected_answer: keyGrouped
        ? expectedParts.map((p) => p.answer).filter(Boolean).join('; ')
        : (key ? (key.answer ?? '') : ''),
      expected_type: keyGrouped ? '' : (key?.answer_type || ''),
      match_confidence: +matchConfidence.toFixed(2),
      match_method: matchMethod,
    });
  }

  const notInAttempt = [];
  for (const k of keys) {
    if (usedKeyRefs.has(refOf(k))) continue;
    notInAttempt.push({
      question: String(k.question_number || k.global_question_index || ''),
      section: k.section || '',
      display_question: buildDisplayQuestion(k),
      answer_page: k.page ?? null,
      expected_answer: k.answer ?? '',
    });
  }

  return { pairs, not_in_attempt: notInAttempt, keysProvided: keys.length > 0 };
}

// Pair classification: a pair is visual when any side's answer_type
// is "drawing" or "diagram_label". "unknown" routes to the text path
// by default — the text compare call returns "unclear" when it can't
// decide, which is the safe fallback.
//
// For multi-part pairs, ANY part being visual promotes the entire
// pair to the visual path. This is intentionally coarse: we run one
// vision call per question rather than mixing text-compare and
// visual-compare within the same question. Per-part visual handling
// can be added later if needed.
const VISUAL_TYPE_RE = /^(drawing|diagram_label)$/i;
export function isVisualType(t) { return VISUAL_TYPE_RE.test(String(t || '')); }
export function isVisualPair(p) {
  if (p.is_multi_part) {
    const sParts = p.student_parts || [];
    const eParts = p.expected_parts || [];
    return sParts.some((sp) => isVisualType(sp.answer_type))
        || eParts.some((ep) => isVisualType(ep.answer_type));
  }
  return isVisualType(p.student_type) || isVisualType(p.expected_type);
}

export function partitionPairsByModality(match) {
  const text = [];
  const visual = [];
  for (const p of match.pairs) (isVisualPair(p) ? visual : text).push(p);
  return { text, visual };
}

// Final report builder for the staged pipeline.
//
// Inputs:
//   match           — output of matchExtractions().
//   aiTextReport    — parsed JSON from markPairs() (text compare call) or null.
//   visualResults   — [{ pair, parsed?, error? }] one per visual pair.
//
// Output report shape: { summary, questions, not_in_attempt, redo,
// weak_points }. Each pair's row gets its status from the appropriate
// source:
//   - visual pairs   → matching entry in visualResults
//   - text pairs     → matching entry in aiTextReport.questions
//   - text pair with no AI result → local string-equality fallback
//
// Visual rows show '[visual answer]' as the student/expected text
// (with the AI's descriptions and comment recorded in row.comment).
export function buildFinalReport({ match, aiTextReport, visualResults }) {
  const visualResultByQ = new Map();
  for (const v of visualResults || []) {
    const qn = normalizeQNumber(v.pair?.display_question || v.pair?.question || '');
    if (qn) visualResultByQ.set(qn, v);
  }

  const aiQByQ = new Map();
  if (aiTextReport && Array.isArray(aiTextReport.questions)) {
    for (const q of aiTextReport.questions) {
      const qn = normalizeQNumber(q.question || '');
      if (qn) aiQByQ.set(qn, q);
    }
  }

  let correct = 0, incorrect = 0, unclear = 0;
  const questions = [];
  for (const p of match.pairs) {
    const qn = normalizeQNumber(p.display_question || p.question);
    const base = {
      question: p.question,
      section: p.section,
      display_question: p.display_question,
      completed_page: p.completed_page,
      answer_page: p.answer_page,
    };

    // Visual path — multi-part visual still produces one row per
    // question for MVP (per-part visual handling is a future
    // refinement; the prompt scope is already noisy with full pages).
    if (isVisualPair(p)) {
      const v = visualResultByQ.get(qn);
      let row;
      if (v?.parsed) {
        const status = normalizeStatus(v.parsed.status);
        const detailBits = [];
        if (v.parsed.comment) detailBits.push(String(v.parsed.comment));
        if (v.parsed.student_visual_answer) detailBits.push(`Student: ${v.parsed.student_visual_answer}`);
        if (v.parsed.expected_visual_answer) detailBits.push(`Expected: ${v.parsed.expected_visual_answer}`);
        row = {
          ...base,
          student_answer: '[visual answer]',
          expected_answer: '[visual answer]',
          status,
          comment: `Visual comparison: ${detailBits.join(' ').trim() || (status === 'correct' ? 'matches.' : 'see report.')}`,
        };
      } else {
        row = {
          ...base,
          student_answer: '[visual answer]',
          expected_answer: '[visual answer]',
          status: 'unclear',
          comment: `Visual comparison: ${v?.error || 'not run.'}`,
        };
      }
      if (row.status === 'correct') correct++;
      else if (row.status === 'incorrect') incorrect++;
      else unclear++;
      questions.push(row);
      continue;
    }

    // Text path — multi-part: one row per student part using the AI's
    // per-part response (or per-part local fallback if AI didn't grade).
    if (p.is_multi_part) {
      const ai = aiQByQ.get(qn);
      const aiParts = ai && Array.isArray(ai.parts) ? ai.parts : null;
      const partRows = buildMultiPartRows(p, aiParts, match.keysProvided);
      for (const row of partRows) {
        if (row.status === 'correct') correct++;
        else if (row.status === 'incorrect') incorrect++;
        else unclear++;
        questions.push(row);
      }
      continue;
    }

    // Flat text pair
    const ai = aiQByQ.get(qn);
    if (ai) {
      const status = normalizeStatus(ai.status);
      if (status === 'correct') correct++;
      else if (status === 'incorrect') incorrect++;
      else unclear++;
      questions.push({
        ...base,
        student_answer: ai.student_answer ?? p.student_answer,
        expected_answer: ai.expected_answer ?? p.expected_answer,
        status,
        comment: ai.comment ? String(ai.comment) : '',
      });
      continue;
    }

    // No AI text result for this pair (or AI text call failed) — local fallback.
    const local = scoreOnePairLocally(p, match.keysProvided);
    if (local.status === 'correct') correct++;
    else if (local.status === 'incorrect') incorrect++;
    else unclear++;
    questions.push({ ...base, ...local });
  }

  const attempted = correct + incorrect + unclear;
  const summary = {
    estimated_score: attempted > 0 && match.keysProvided ? `${correct}/${attempted}` : '',
    comment: buildSummaryComment({
      correct, incorrect, unclear, attempted,
      notInAttempt: match.not_in_attempt,
      keysProvided: match.keysProvided,
    }),
  };

  // Redo: always compute from the merged rows so visual-compare incorrects
  // are included alongside text-compare incorrects. The AI's text-only
  // redo list only sees text pairs, so using it directly would silently
  // drop wrong drawings.
  //
  // Dedupe by base question — if multiple parts of Q19 are wrong, redo
  // should show "Q19" once, not "Q19(i)" and "Q19(ii)" separately.
  const redoSeen = new Set();
  const redo = [];
  for (const q of questions) {
    if (q.status !== 'incorrect') continue;
    const label = q.display_question || q.question;
    if (!label) continue;
    // Strip a trailing "(part)" suffix to compute the base label.
    const base = label.replace(/\([^)]*\)\s*$/, '').trim() || label;
    if (redoSeen.has(base)) continue;
    redoSeen.add(base);
    redo.push(base);
  }

  // Review records — Phase 1 of Review Mode. One record per
  // wrong / unclear question (multi-part rows that share a base
  // question are grouped into a single record so the page only
  // gets one marker per question, not one per part).
  //
  // Gated on match.keysProvided: when there's no answer key,
  // every row is "unclear" by construction (no expected to
  // compare against), so a Review surface would be a wall of
  // red Xs with nothing meaningful to explain. The decision was:
  // Review Mode is unavailable for no-key papers. The empty
  // array also lets main.js gate the entry button.
  const review_records = match.keysProvided
    ? buildReviewRecords({
        pairs: match.pairs,
        questions,
        aiQByQ,
      })
    : [];

  return {
    summary,
    questions,
    review_records,
    not_in_attempt: match.not_in_attempt,
    redo,
    weak_points: Array.isArray(aiTextReport?.weak_points) ? aiTextReport.weak_points : [],
  };
}

// ---------- Review records ----------------------------------------------
//
// Each record describes ONE wrong-or-unclear printed question, with
// enough metadata to render a marker on the page and open a popup:
//
//   {
//     question:           printed question label, e.g. "Q19"
//     section:            optional section name
//     completed_page:     1-based page number on the source PDF
//     status:             "incorrect" | "unclear"
//     parts: [            // empty for flat rows; one entry per
//                         //   wrong/unclear part for multi-part
//       {
//         part: "i",
//         student_answer, matched_expected, comment, status
//       }
//     ],
//     student_answer:     // top-level for flat rows; omitted for multi-part
//     expected_answer,
//     comment,
//     short_display_answer:    // ≤24 char inline preview (UI may further cap)
//     short_reason,
//     confidence:         0..1 numeric
//     needs_human_review: confidence < 0.5
//     question_start_location: { page, x, y }   x/y normalized 0..1
//   }
//
// Coordinates: the AI-suggested location (if any) is taken as a hint
// but always validated; on any out-of-bounds / NaN / page-mismatch
// value we fall back to a code-side snap based on the question's
// position among other questions on the same page. The snap puts x at
// a fixed left-margin band (questions start near the left in every
// worksheet we've seen) and y proportional to the question's
// numeric ordering on the page. Fully deterministic.
function buildReviewRecords({ pairs, questions, aiQByQ }) {
  // Index pairs by base question for the position-on-page lookup.
  const pairsByPage = new Map(); // page -> [{ qn, pair }]
  for (const p of pairs) {
    const pg = Number(p.completed_page);
    if (!Number.isFinite(pg)) continue;
    const qn = normalizeQNumber(p.display_question || p.question || '');
    if (!qn) continue;
    if (!pairsByPage.has(pg)) pairsByPage.set(pg, []);
    pairsByPage.get(pg).push({ qn, pair: p });
  }
  // Sort each page's questions by their numeric prefix so y-position
  // synthesis lines up with reading order.
  for (const list of pairsByPage.values()) {
    list.sort((a, b) => qnumNumericPrefix(a.qn) - qnumNumericPrefix(b.qn));
  }

  // Group flat rows by base question so multi-part subparts that
  // share a base question (Q19(i), Q19(ii)) become one record.
  const groups = new Map(); // baseKey -> { row, parts: [] }
  for (const row of questions) {
    if (row.status !== 'incorrect' && row.status !== 'unclear') continue;
    // Exclude visual-comparison rows from Review Mode for the MVP.
    // Their student_answer / expected_answer are placeholder
    // "[visual answer]" strings; the popup would show
    // "Student: [visual answer]" / "Correct: [visual answer]" with
    // no useful explanation. Visual results still appear in the
    // standard report's All-questions table — Review Mode just
    // doesn't add markers for them.
    if (row.student_answer === '[visual answer]'
        || row.expected_answer === '[visual answer]') {
      continue;
    }
    const baseDisplay = row.display_question || row.question || '';
    const baseKey = baseDisplay.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const partMatch = baseDisplay.match(/\(([^)]+)\)\s*$/);
    if (!groups.has(baseKey)) {
      groups.set(baseKey, { baseKey, baseRow: row, parts: [] });
    }
    if (partMatch) {
      groups.get(baseKey).parts.push({
        part: partMatch[1].trim(),
        student_answer: row.student_answer || '',
        matched_expected: row.expected_answer || '',
        status: row.status,
        comment: row.comment || '',
      });
    } else {
      // Flat row — overwrite baseRow with the single source row.
      groups.get(baseKey).baseRow = row;
    }
  }

  const records = [];
  for (const { baseKey, baseRow, parts } of groups.values()) {
    const qn = normalizeQNumber(baseKey);
    const aiRow = aiQByQ.get(qn);
    const conf = clampConfidence(aiRow?.confidence);
    const shortAnswer = trimToCap(aiRow?.short_display_answer || baseRow.expected_answer || '', 24);
    const shortReason = String(aiRow?.short_reason || baseRow.comment || '').trim();
    const location = synthLocation({
      aiLocation: aiRow?.question_start_location,
      page: baseRow.completed_page,
      qn,
      pairsByPage,
    });
    const status = parts.length > 0 && parts.every((p) => p.status === 'correct')
      ? 'correct'
      : (parts.length > 0 ? worstStatusOf(parts) : baseRow.status);
    if (status === 'correct') continue; // shouldn't happen given the filter, but defensive

    const rec = {
      question: baseKey,
      section: baseRow.section || '',
      completed_page: location?.page ?? baseRow.completed_page ?? null,
      status,
      short_display_answer: shortAnswer,
      short_reason: shortReason,
      confidence: conf,
      needs_human_review: conf < 0.5,
      question_start_location: location,
    };
    if (parts.length > 0) {
      rec.parts = parts;
    } else {
      rec.student_answer = baseRow.student_answer || '';
      rec.expected_answer = baseRow.expected_answer || '';
      rec.comment = baseRow.comment || '';
    }
    records.push(rec);
  }
  // Stable sort: by page, then by numeric prefix of question label,
  // so Previous/Next navigation in the popup walks document order.
  records.sort((a, b) => {
    const pa = a.completed_page ?? 9999, pb = b.completed_page ?? 9999;
    if (pa !== pb) return pa - pb;
    return qnumNumericPrefix(normalizeQNumber(a.question)) - qnumNumericPrefix(normalizeQNumber(b.question));
  });
  return records;
}

function clampConfidence(v) {
  const n = Number(v);
  // Default to 0.7 when the AI omits confidence — sits right at
  // the alerting threshold (>= 0.8 is "reliable" per the prompt,
  // < 0.5 → needs_human_review). Means an omission shows up in
  // the low-confidence banner ("verify before relying on the
  // score") without changing the marking verdict. Earlier
  // optimistic 1.0 default silently masked omissions.
  if (!Number.isFinite(n)) return 0.7;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function trimToCap(s, max) {
  const v = String(s || '').replace(/\s+/g, ' ').trim();
  if (v.length <= max) return v;
  return v.slice(0, Math.max(0, max - 1)).trim() + '…';
}

function worstStatusOf(parts) {
  // incorrect > unclear > correct. Returns the most-severe.
  if (parts.some((p) => p.status === 'incorrect')) return 'incorrect';
  if (parts.some((p) => p.status === 'unclear'))   return 'unclear';
  return 'correct';
}

function qnumNumericPrefix(qn) {
  const m = String(qn || '').match(/^(\d+)/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

// Validate the AI's coordinate hint, or fall back to an ordinal
// estimate.
//
// IMPORTANT: this is NOT a snap-to-Q-heading. The fallback does not
// detect headings, columns, passages, diagrams, or page layout —
// it only spreads questions evenly between [0.05, 0.95] of page
// height by ordinal position. On worksheets with two-column layouts,
// large diagrams, comprehension passages, or one long question
// followed by short ones, the fallback will be visibly misplaced.
//
// AI hints are accepted only when they pass strict validation:
// page matches the extraction's page (definitive), x and y are
// finite numbers in [0, 1]. Garbage values fall through to the
// ordinal estimate. The caller can tell which branch was used via
// `source`: 'ai' | 'ordinal_fallback'.
function synthLocation({ aiLocation, page, qn, pairsByPage }) {
  const pg = Number(page);
  if (!Number.isFinite(pg) || pg < 1) return null;
  const aiX = aiLocation && Number(aiLocation.x);
  const aiY = aiLocation && Number(aiLocation.y);
  const aiPage = aiLocation && Number(aiLocation.page);
  const aiValid =
    Number.isFinite(aiPage) && aiPage === pg &&
    Number.isFinite(aiX) && aiX >= 0 && aiX <= 1 &&
    Number.isFinite(aiY) && aiY >= 0 && aiY <= 1;
  if (aiValid) {
    return { page: pg, x: aiX, y: aiY, source: 'ai' };
  }
  // Ordinal fallback. Spread questions evenly down the page —
  // unreliable on irregular layouts, see comment above.
  const list = pairsByPage.get(pg) || [];
  const idx = list.findIndex((e) => e.qn === qn);
  const total = list.length;
  const top = 0.05;
  const bottom = 0.95;
  const y = total > 0 && idx >= 0
    ? top + ((idx + 0.5) / total) * (bottom - top)
    : 0.5;
  return { page: pg, x: 0.06, y, source: 'ordinal_fallback' };
}

// Build per-part display rows for a grouped text pair. Walks the
// student parts in order; for each, picks the AI's per-part status if
// the AI returned per-part data, otherwise falls back to local pool /
// positional scoring.
function buildMultiPartRows(p, aiParts, keysProvided) {
  const baseDisplay = p.display_question || (p.question ? `Q${p.question}` : '');
  const baseRow = {
    question: p.question,
    section: p.section,
    display_question: baseDisplay,
    completed_page: p.completed_page,
    answer_page: p.answer_page,
  };

  const rows = [];

  // Index AI parts by 'part' label so we can look up by student part.
  const aiByPart = new Map();
  if (Array.isArray(aiParts)) {
    aiParts.forEach((ap, i) => {
      const lbl = ap?.part != null ? String(ap.part) : String(i + 1);
      aiByPart.set(lbl, ap);
    });
  }

  // Local fallback: pool / positional matching when AI didn't grade.
  const localStatuses = aiParts ? null : scorePartsLocally(p, keysProvided);

  (p.student_parts || []).forEach((sp, i) => {
    const partLabel = sp.part != null ? String(sp.part) : String(i + 1);
    const display = `${baseDisplay}(${partLabel})`;
    const ai = aiByPart.get(partLabel) || (Array.isArray(aiParts) ? aiParts[i] : null);
    if (ai) {
      const status = normalizeStatus(ai.status);
      // expected_answer falls through to '' rather than the
      // literal '(see comment)' marker the previous code used —
      // that string was leaking into both the All-questions table
      // and (more visibly) the Review popup, where the parent
      // saw "Correct: (see comment)" with no comment to refer to.
      // A blank cell is cleaner; the popup logic now hides the
      // Correct row when the value is empty.
      rows.push({
        ...baseRow,
        display_question: display,
        student_answer: ai.student_answer ?? sp.answer ?? '',
        expected_answer: ai.matched_expected ?? '',
        status,
        comment: ai.comment ? String(ai.comment) : '',
      });
    } else if (localStatuses) {
      const local = localStatuses[i] || { status: 'unclear', comment: 'Local fallback could not score this part.' };
      rows.push({
        ...baseRow,
        display_question: display,
        student_answer: sp.answer || '',
        expected_answer: local.matchedExpected || '',
        status: local.status,
        comment: local.comment || '',
      });
    } else {
      rows.push({
        ...baseRow,
        display_question: display,
        student_answer: sp.answer || '',
        expected_answer: '',
        status: 'unclear',
        comment: 'AI compare did not return a per-part status for this part.',
      });
    }
  });

  return rows;
}

// Local per-part scorer for grouped pairs. Pool-matches when
// order_matters is false; positional otherwise. Used as a fallback
// when the AI text-compare call didn't return per-part data.
function scorePartsLocally(p, keysProvided) {
  const studentParts = p.student_parts || [];
  const expectedParts = p.expected_parts || [];
  const out = new Array(studentParts.length).fill(null);

  if (!keysProvided) {
    return studentParts.map(() => ({
      status: 'unclear',
      comment: 'No answer pages provided; compare manually.',
      matchedExpected: '',
    }));
  }
  if (expectedParts.length === 0) {
    return studentParts.map(() => ({
      status: 'unclear',
      comment: 'No matching answer-key entry for this question.',
      matchedExpected: '',
    }));
  }

  if (p.order_matters) {
    // Positional: student[i] vs expected[i].
    studentParts.forEach((sp, i) => {
      const ep = expectedParts[i];
      out[i] = scoreSinglePartLocally(sp, ep);
    });
  } else {
    // Pool: each expected can be matched at most once.
    const expectedUsed = new Array(expectedParts.length).fill(false);
    studentParts.forEach((sp, i) => {
      const studentBlank = !(sp.answer || '').trim();
      const isUnreadable = sp.answer && /^unclear$/i.test(String(sp.answer).trim());
      if (studentBlank) {
        out[i] = { status: 'incorrect', comment: 'Student part was blank.', matchedExpected: '' };
        return;
      }
      if (isUnreadable) {
        out[i] = { status: 'unclear', comment: 'Student part was unreadable.', matchedExpected: '' };
        return;
      }
      const sNorm = normalizeAnswer(sp.answer || '');
      let matchIdx = -1;
      for (let j = 0; j < expectedParts.length; j++) {
        if (expectedUsed[j]) continue;
        if (normalizeAnswer(expectedParts[j].answer || '') === sNorm) { matchIdx = j; break; }
      }
      if (matchIdx >= 0) {
        expectedUsed[matchIdx] = true;
        out[i] = { status: 'correct', comment: '', matchedExpected: expectedParts[matchIdx].answer || '' };
      } else {
        out[i] = { status: 'incorrect', comment: 'No matching expected answer.', matchedExpected: '' };
      }
    });
  }

  return out;
}

function scoreSinglePartLocally(studentPart, expectedPart) {
  const sa = studentPart?.answer || '';
  const ea = expectedPart?.answer || '';
  if (!ea) return { status: 'unclear', comment: 'No matching expected part.', matchedExpected: '' };
  if (!sa.trim()) return { status: 'incorrect', comment: 'Student part was blank.', matchedExpected: '' };
  if (/^unclear$/i.test(sa.trim())) return { status: 'unclear', comment: 'Student part was unreadable.', matchedExpected: '' };
  if (normalizeAnswer(sa) === normalizeAnswer(ea)) return { status: 'correct', comment: '', matchedExpected: ea };
  return { status: 'incorrect', comment: '', matchedExpected: ea };
}

// Score a single flat text pair using string equality. Returns just
// the per-row diff so buildFinalReport can splice it in when the AI
// text compare call didn't grade this row.
function scoreOnePairLocally(p, keysProvided) {
  const studentAns = p.student_answer || '';
  const expectedAns = p.expected_answer || '';
  const isUnreadable = !studentAns || /^unclear$/i.test(studentAns.trim());
  const studentBlank = !studentAns.trim();
  let status, comment = '';
  if (!keysProvided) {
    status = 'unclear';
    comment = 'No answer pages provided; compare manually.';
  } else if (!expectedAns) {
    status = 'unclear';
    comment = 'No matching answer-key entry for this question.';
  } else if (isUnreadable && !studentBlank) {
    status = 'unclear';
    comment = 'Student answer was unreadable.';
  } else if (studentBlank) {
    status = 'incorrect';
    comment = 'Student answer was blank.';
  } else if (typeof p.student_confidence === 'number' && p.student_confidence < 0.4) {
    status = 'unclear';
    comment = `Low extraction confidence (${p.student_confidence.toFixed(2)}).`;
  } else if (normalizeAnswer(studentAns) === normalizeAnswer(expectedAns)) {
    status = 'correct';
  } else {
    status = 'incorrect';
  }
  return {
    student_answer: studentAns,
    expected_answer: expectedAns,
    status,
    comment,
  };
}

function normalizeStatus(s) {
  const v = String(s || '').toLowerCase().trim();
  if (v === 'correct' || v === 'incorrect' || v === 'unclear') return v;
  return 'unclear';
}

function buildSummaryComment({ correct, incorrect, unclear, attempted, notInAttempt, keysProvided }) {
  if (attempted === 0 && (!notInAttempt || notInAttempt.length === 0)) return '';
  if (attempted === 0) return 'No answers were extracted from the completed pages.';
  let s = `${correct} correct, ${incorrect} incorrect, ${unclear} unclear out of ${attempted} attempted question(s).`;
  if (!keysProvided) {
    s += ' No answer pages were specified, so questions are listed but not graded.';
  } else if (notInAttempt && notInAttempt.length > 0) {
    s += ` ${notInAttempt.length} answer-key question(s) were not found on the completed pages.`;
  }
  return s;
}

let _refSeq = 0;
const _refMap = new WeakMap();
function refOf(o) {
  if (!_refMap.has(o)) _refMap.set(o, ++_refSeq);
  return _refMap.get(o);
}
