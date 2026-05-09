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
//   2. buildReportFromAi(): turning the final-stage AI compare response
//      into the report shape used by the UI, enriched with local pair
//      metadata (page numbers, section, display label) the AI doesn't see.
//   3. scorePairsLocally(): a string-equality scorer used as a fallback
//      when the AI compare call fails — keeps the user moving even if
//      the third call breaks.
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

function buildDisplayQuestion(a) {
  if (a.display_question) return String(a.display_question);
  const q = a.question_number ? String(a.question_number) : '';
  const s = a.section ? String(a.section) : '';
  if (s && q) return /^Q/i.test(q) ? `${s} ${q}` : `${s} Q${q}`;
  if (q) return /^Q/i.test(q) ? q : `Q${q}`;
  if (a.global_question_index != null) return `Q${a.global_question_index}`;
  return '';
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
  const students = flattenAnswers(studentBatchResults);
  const keys = flattenAnswers(answerKeyResults);

  const keyByKey = new Map();
  const keyByQNum = new Map();
  const keyByQNumAmbiguous = new Set();
  for (const k of keys) {
    if (k.section || k.question_number) {
      keyByKey.set(compositeKey(k.section || '', k.question_number || ''), k);
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
    if (keyByKey.has(ck)) {
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

    pairs.push({
      question: String(s.question_number || s.global_question_index || ''),
      section: s.section || '',
      display_question: buildDisplayQuestion(s),
      completed_page: s.page ?? null,
      answer_page: key?.page ?? null,
      student_answer: s.answer ?? '',
      student_confidence: typeof s.confidence === 'number' ? s.confidence : null,
      expected_answer: key ? (key.answer ?? '') : '',
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

// Build the report consumed by the UI from the AI compare response,
// enriched with local pair metadata.
//   aiReport: { summary, questions[], redo[], weak_points[] } as returned
//             by the COMPARE_PROMPT call (text-only, post-extraction).
//   match:    { pairs, not_in_attempt, keysProvided } from matchExtractions.
export function buildReportFromAi(aiReport, match) {
  const pairsByQ = new Map();
  for (const p of match.pairs) {
    pairsByQ.set(normalizeQNumber(p.display_question || p.question), p);
    pairsByQ.set(normalizeQNumber(p.question || ''), p);
  }
  const aiQuestions = Array.isArray(aiReport?.questions) ? aiReport.questions : [];
  const seenLocalRefs = new Set();
  const questions = aiQuestions.map((q) => {
    const lookupKey =
      pairsByQ.get(normalizeQNumber(q.question || '')) ||
      pairsByQ.get(normalizeQNumber(q.display_question || ''));
    if (lookupKey) seenLocalRefs.add(refOf(lookupKey));
    return {
      question: lookupKey?.question ?? String(q.question || ''),
      section: lookupKey?.section ?? '',
      display_question: lookupKey?.display_question ?? String(q.question || ''),
      completed_page: lookupKey?.completed_page ?? null,
      answer_page: lookupKey?.answer_page ?? null,
      student_answer: q.student_answer ?? lookupKey?.student_answer ?? '',
      expected_answer: q.expected_answer ?? lookupKey?.expected_answer ?? '',
      status: normalizeStatus(q.status),
      comment: q.comment ? String(q.comment) : '',
    };
  });

  // Safety net: if the AI dropped any pair we sent, surface it as
  // 'unclear' so it doesn't silently disappear.
  for (const p of match.pairs) {
    if (seenLocalRefs.has(refOf(p))) continue;
    questions.push({
      question: p.question,
      section: p.section,
      display_question: p.display_question,
      completed_page: p.completed_page,
      answer_page: p.answer_page,
      student_answer: p.student_answer,
      expected_answer: p.expected_answer,
      status: 'unclear',
      comment: 'AI compare did not return a row for this question.',
    });
  }

  // If the AI didn't compute estimated_score, do it from rows.
  let summary = aiReport?.summary || { estimated_score: '', comment: '' };
  if (!summary.estimated_score) {
    const correct = questions.filter((q) => q.status === 'correct').length;
    const total = questions.length;
    summary = {
      estimated_score: total > 0 ? `${correct}/${total}` : '',
      comment: summary.comment || '',
    };
  }

  // Redo: incorrect rows from attempted questions only.
  const redo = (Array.isArray(aiReport?.redo) && aiReport.redo.length > 0)
    ? aiReport.redo
    : questions.filter((q) => q.status === 'incorrect')
        .map((q) => q.display_question || q.question)
        .filter(Boolean);

  return {
    summary,
    questions,
    not_in_attempt: match.not_in_attempt,
    redo,
    weak_points: Array.isArray(aiReport?.weak_points) ? aiReport.weak_points : [],
  };
}

// Local string-equality scorer — used when the AI compare call fails.
// Mirrors the shape of buildReportFromAi() so the rest of the app
// doesn't need to know which path produced the result.
export function scorePairsLocally(match) {
  const pairs = match.pairs;
  let correct = 0, incorrect = 0, unclear = 0;
  const questions = pairs.map((p) => {
    const studentAns = p.student_answer || '';
    const expectedAns = p.expected_answer || '';
    const isUnreadable = !studentAns || /^unclear$/i.test(studentAns.trim());
    const studentBlank = !studentAns.trim();
    let status, comment = '';
    if (!match.keysProvided) {
      status = 'unclear';
      comment = 'No answer pages provided; compare manually.';
    } else if (!expectedAns) {
      status = 'unclear';
      comment = 'No matching answer-key entry for this question.';
    } else if (studentBlank || isUnreadable) {
      // Per the spec: blank/missing student answer is incorrect when
      // the expected answer exists; only "unclear" when extraction
      // explicitly returned 'unclear' (we can't read it).
      if (isUnreadable && !studentBlank) {
        status = 'unclear';
        comment = 'Student answer was unreadable.';
      } else {
        status = 'incorrect';
        comment = 'Student answer was blank.';
      }
    } else if (typeof p.student_confidence === 'number' && p.student_confidence < 0.4) {
      status = 'unclear';
      comment = `Low extraction confidence (${p.student_confidence.toFixed(2)}).`;
    } else if (normalizeAnswer(studentAns) === normalizeAnswer(expectedAns)) {
      status = 'correct';
    } else {
      status = 'incorrect';
    }
    if (status === 'correct') correct++;
    else if (status === 'incorrect') incorrect++;
    else unclear++;
    return {
      question: p.question,
      section: p.section,
      display_question: p.display_question,
      completed_page: p.completed_page,
      answer_page: p.answer_page,
      student_answer: studentAns,
      expected_answer: expectedAns,
      status,
      comment,
    };
  });

  const attempted = correct + incorrect + unclear;
  const summary = {
    estimated_score: attempted > 0 && match.keysProvided ? `${correct}/${attempted}` : '',
    comment: buildSummaryComment({ correct, incorrect, unclear, attempted, notInAttempt: match.not_in_attempt, keysProvided: match.keysProvided }),
  };
  const redo = questions
    .filter((q) => q.status === 'incorrect')
    .map((q) => q.display_question || q.question)
    .filter(Boolean);

  return {
    summary,
    questions,
    not_in_attempt: match.not_in_attempt,
    redo,
    weak_points: [],
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

// Backward-compat shim: a few earlier diagnostics may still call
// compareExtractions(). Route them to local scoring so nothing breaks.
export function compareExtractions(studentBatchResults, answerKeyResults) {
  const match = matchExtractions(studentBatchResults, answerKeyResults);
  return scorePairsLocally(match);
}
