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
//      section, display label) the AI doesn't see.
//   4. scorePairsLocally(): a string-equality scorer used as a fallback
//      when the AI text-compare call fails — keeps the user moving
//      even if the call breaks.
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
  const keyByKeyAmbiguous = new Set();
  const keyByQNum = new Map();
  const keyByQNumAmbiguous = new Set();
  for (const k of keys) {
    if (k.section || k.question_number) {
      const ck = compositeKey(k.section || '', k.question_number || '');
      // If the same composite (section + question_number) appears more
      // than once in the answer key, mark it ambiguous so we don't
      // silently pair against whichever one happened to land last.
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

    pairs.push({
      question: String(s.question_number || s.global_question_index || ''),
      section: s.section || '',
      display_question: buildDisplayQuestion(s),
      completed_page: s.page ?? null,
      answer_page: key?.page ?? null,
      student_answer: s.answer ?? '',
      student_confidence: typeof s.confidence === 'number' ? s.confidence : null,
      student_type: s.answer_type || '',
      expected_answer: key ? (key.answer ?? '') : '',
      expected_type: key?.answer_type || '',
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

// Pair classification: a pair is visual when either side's
// answer_type is "drawing" or "diagram_label". "unknown" routes to
// the text path by default — the text compare call returns "unclear"
// when it can't decide, which is the safe fallback.
const VISUAL_TYPE_RE = /^(drawing|diagram_label)$/i;
export function isVisualType(t) { return VISUAL_TYPE_RE.test(String(t || '')); }
export function isVisualPair(p) { return isVisualType(p.student_type) || isVisualType(p.expected_type); }

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
  const questions = match.pairs.map((p) => {
    const qn = normalizeQNumber(p.display_question || p.question);
    const base = {
      question: p.question,
      section: p.section,
      display_question: p.display_question,
      completed_page: p.completed_page,
      answer_page: p.answer_page,
    };

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
      return row;
    }

    // Text pair
    const ai = aiQByQ.get(qn);
    if (ai) {
      const status = normalizeStatus(ai.status);
      if (status === 'correct') correct++;
      else if (status === 'incorrect') incorrect++;
      else unclear++;
      return {
        ...base,
        student_answer: ai.student_answer ?? p.student_answer,
        expected_answer: ai.expected_answer ?? p.expected_answer,
        status,
        comment: ai.comment ? String(ai.comment) : '',
      };
    }

    // No AI text result for this pair (or AI text call failed) — local fallback.
    const local = scoreOnePairLocally(p, match.keysProvided);
    if (local.status === 'correct') correct++;
    else if (local.status === 'incorrect') incorrect++;
    else unclear++;
    return { ...base, ...local };
  });

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
  const redo = questions
    .filter((q) => q.status === 'incorrect')
    .map((q) => q.display_question || q.question)
    .filter(Boolean);

  return {
    summary,
    questions,
    not_in_attempt: match.not_in_attempt,
    redo,
    weak_points: Array.isArray(aiTextReport?.weak_points) ? aiTextReport.weak_points : [],
  };
}

// Score a single text pair using string equality. Mirrors the rules in
// scorePairsLocally() but returns just the per-row diff so buildFinalReport
// can splice it in.
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

// Local string-equality scorer — used when the AI compare call fails.
// Mirrors the shape of buildFinalReport() so the rest of the app
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
