// Code-side comparison of two extraction stages.
//
// Stage 1 ("student") and Stage 2 ("answer key") each produce
//   { answers: [{ global_question_index, section, question_number,
//                 display_question, page, answer, confidence }, ...] }
//
// compareExtractions() merges multiple stage-1 batch results plus a stage-2
// extraction and produces the final report shape consumed by report.js:
//   { summary: { estimated_score, comment }, questions: [...], redo: [],
//     weak_points: [] }
//
// Why code-side comparison? See prompt redesign — keeping student-answer
// reading isolated from the answer key stops the model from reverse-engineering
// the "right" handwriting based on what the key expects.

// Normalize a free-form answer for equality comparison. This is intentionally
// permissive about spacing, casing, and full-/half-width differences; AI
// comparison can be added later for genuinely ambiguous open-ended answers.
export function normalizeAnswer(value) {
  if (value == null) return '';
  let v = String(value);

  // Full-width → half-width for ASCII range.
  v = v.replace(/[！-～]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xFEE0)
  );
  // Full-width space → space.
  v = v.replace(/　/g, ' ');
  // Strip a leading "Q", "Q.", "Question " etc. (only when followed by
  // a digit/letter so we don't strip real content like the Q in "iQ").
  v = v.replace(/^\s*(?:question\s+|q\.?\s*)(?=\S)/i, '');
  // Lowercase for case-insensitive equality.
  v = v.toLowerCase();
  // Collapse internal whitespace.
  v = v.replace(/\s+/g, ' ').trim();
  // Strip surrounding punctuation that doesn't carry meaning.
  v = v.replace(/^[\.,;:!?。，；：！？"'“”‘’]+|[\.,;:!?。，；：！？"'“”‘’]+$/g, '');
  // Common equivalences.
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
// Trailing punctuation (./:) is stripped. Parens and whitespace are
// collapsed so subpart labels match across slight formatting differences.
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
  if (s && q) {
    return /^Q/i.test(q) ? `${s} ${q}` : `${s} Q${q}`;
  }
  if (q) return /^Q/i.test(q) ? q : `Q${q}`;
  if (a.global_question_index != null) return `Q${a.global_question_index}`;
  return '';
}

// studentBatchResults: array of Stage-1 parsed JSONs (one per batch)
// answerKeyResults:    array of Stage-2 parsed JSONs (typically just one)
//
// Returns:
//   {
//     summary: { estimated_score, comment },
//     questions: [...rows the student attempted...],
//     not_in_attempt: [...answer-key questions NOT found on completed pages...],
//     redo: [...labels of incorrect attempted rows...],
//     weak_points: [],
//   }
//
// The score's denominator is the number of attempted questions (those
// extracted from the completed pages). Answer-key entries with no matching
// student answer go into not_in_attempt[] and don't affect the score or
// the redo list — they're shown separately so the parent can decide
// whether to revisit those questions on a different attempt.
export function compareExtractions(studentBatchResults, answerKeyResults) {
  const students = flattenAnswers(studentBatchResults);
  const keys = flattenAnswers(answerKeyResults);

  // Index answer-key answers for lookup.
  //   keyByKey   — strict match on section + question_number.
  //   keyByQNum  — qnum-only fallback, but only used when exactly ONE
  //                answer-key entry has that qnum. If two sections share
  //                e.g. "Q1", we record it as ambiguous and refuse the
  //                fallback so the row goes to "unclear" instead.
  //
  // We deliberately do NOT use global_question_index as a fallback. When
  // the student's pages are a subset of the worksheet (e.g. only Q17–19),
  // the student's local indexes 1/2/3 would otherwise collide with the
  // answer key's Q1/Q2/Q3 entries — exactly the bug we're fixing here.
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

  const questions = [];
  const usedKeyRefs = new Set();
  let correct = 0, incorrect = 0, unclear = 0;

  // Drive the questions list from the student extraction — every row in
  // `questions` represents a question the student actually attempted.
  for (const s of students) {
    let key = null;
    const ck = compositeKey(s.section || '', s.question_number || '');
    if (keyByKey.has(ck)) {
      key = keyByKey.get(ck);
    } else {
      // Fallback: qnum-only match, but only when unambiguous across the
      // whole answer key. (E.g. if the student didn't capture a section
      // label but the answer key did, this still pairs correctly.)
      const qn = normalizeQNumber(s.question_number);
      if (qn && keyByQNum.has(qn) && !keyByQNumAmbiguous.has(qn)) {
        key = keyByQNum.get(qn);
      }
    }
    if (key) usedKeyRefs.add(refOf(key));

    const studentAns = s.answer ?? '';
    const expectedAns = key ? (key.answer ?? '') : '';
    const studentConfidence = typeof s.confidence === 'number' ? s.confidence : null;
    const isUnreadable = !studentAns || /^unclear$/i.test(String(studentAns).trim());

    let status, comment = '';
    if (keys.length === 0) {
      status = 'unclear';
      comment = 'No answer pages provided; compare manually.';
    } else if (!key) {
      status = 'unclear';
      comment = 'No matching answer-key entry for this question.';
    } else if (isUnreadable) {
      status = 'unclear';
      comment = 'Student answer was unreadable.';
    } else if (studentConfidence != null && studentConfidence < 0.4) {
      status = 'unclear';
      comment = `Low extraction confidence (${studentConfidence.toFixed(2)}).`;
    } else if (normalizeAnswer(studentAns) === normalizeAnswer(expectedAns)) {
      status = 'correct';
    } else {
      status = 'incorrect';
    }

    if (status === 'correct') correct++;
    else if (status === 'incorrect') incorrect++;
    else unclear++;

    questions.push({
      question: String(s.question_number || s.global_question_index || ''),
      section: s.section || '',
      display_question: buildDisplayQuestion(s),
      completed_page: s.page ?? null,
      answer_page: key?.page ?? null,
      student_answer: studentAns,
      expected_answer: expectedAns,
      status,
      comment,
    });
  }

  // Answer-key entries the student didn't attempt — listed separately, not
  // counted in the main score, not added to the redo list.
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

  const attempted = correct + incorrect + unclear;
  const summary = {
    estimated_score: attempted > 0 && keys.length > 0 ? `${correct}/${attempted}` : '',
    comment: buildSummaryComment({ correct, incorrect, unclear, attempted, notInAttempt, keysProvided: keys.length > 0 }),
  };

  // Redo: incorrect rows from attempted questions only. Unmatched-key
  // questions deliberately do not appear here (the student didn't see them
  // on the completed pages, so "redo" doesn't apply yet).
  const redo = questions
    .filter((q) => q.status === 'incorrect')
    .map((q) => q.display_question || q.question)
    .filter(Boolean);

  return {
    summary,
    questions,
    not_in_attempt: notInAttempt,
    redo,
    // Weak points: reserved field, kept empty by code-side comparison so
    // the report doesn't surface generic guesses like "understanding of
    // the topic". Future enhancement: a separate pattern-detection pass.
    weak_points: [],
  };
}

function buildSummaryComment({ correct, incorrect, unclear, attempted, notInAttempt, keysProvided }) {
  if (attempted === 0 && notInAttempt.length === 0) return '';
  if (attempted === 0) {
    return 'No answers were extracted from the completed pages.';
  }
  let s = `${correct} correct, ${incorrect} incorrect, ${unclear} unclear out of ${attempted} attempted question(s).`;
  if (!keysProvided) {
    s += ' No answer pages were specified, so questions are listed but not graded. Open Setup → Pages to add an Answer pages range.';
  } else if (notInAttempt.length > 0) {
    s += ` ${notInAttempt.length} answer-key question(s) were not found on the completed pages — listed separately and not counted in the score.`;
  }
  return s;
}

let _refSeq = 0;
const _refMap = new WeakMap();
function refOf(o) {
  if (!_refMap.has(o)) _refMap.set(o, ++_refSeq);
  return _refMap.get(o);
}
