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

function compositeKey(section, qnum) {
  return `${normalizeKeyPart(section)}|${normalizeKeyPart(qnum)}`;
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
export function compareExtractions(studentBatchResults, answerKeyResults) {
  const students = flattenAnswers(studentBatchResults);
  const keys = flattenAnswers(answerKeyResults);

  // Index student answers for lookup.
  const studentByKey = new Map();
  const studentByGlobal = new Map();
  for (const s of students) {
    if (s.section || s.question_number) {
      studentByKey.set(compositeKey(s.section || '', s.question_number || ''), s);
    }
    if (s.global_question_index != null) {
      studentByGlobal.set(Number(s.global_question_index), s);
    }
  }

  // Build the merged questions array. If we have an answer key, drive from
  // it (one row per expected question). Otherwise drive from student
  // answers and mark every entry as `unclear` since there's nothing to
  // compare against.
  const questions = [];
  const usedStudentRefs = new Set();
  const driver = keys.length > 0 ? keys : students;
  const mode = keys.length > 0 ? 'compare' : 'student-only';

  let correct = 0, incorrect = 0, unclear = 0;

  for (const k of driver) {
    const expected = mode === 'compare' ? (k.answer ?? '') : '';
    let student = null;

    if (mode === 'compare') {
      const ck = compositeKey(k.section || '', k.question_number || '');
      if (studentByKey.has(ck)) student = studentByKey.get(ck);
      else if (k.global_question_index != null && studentByGlobal.has(Number(k.global_question_index))) {
        student = studentByGlobal.get(Number(k.global_question_index));
      }
    } else {
      // student-only mode: each driver entry IS the student
      student = k;
    }

    if (student) usedStudentRefs.add(refOf(student));

    const studentAns = student ? (student.answer ?? '') : '';
    const studentConfidence = student && typeof student.confidence === 'number'
      ? student.confidence
      : null;
    const isUnreadable = !studentAns || /^unclear$/i.test(String(studentAns).trim());

    let status;
    let comment = '';

    if (mode === 'student-only') {
      status = 'unclear';
      comment = 'No answer key provided; compare manually.';
    } else if (!student || isUnreadable) {
      status = 'unclear';
      comment = !student
        ? 'No matching student answer found for this question.'
        : 'Student answer was unreadable.';
    } else if (studentConfidence != null && studentConfidence < 0.4) {
      status = 'unclear';
      comment = `Low extraction confidence (${studentConfidence.toFixed(2)}).`;
    } else if (normalizeAnswer(studentAns) === normalizeAnswer(expected)) {
      status = 'correct';
    } else {
      status = 'incorrect';
    }

    if (status === 'correct') correct++;
    else if (status === 'incorrect') incorrect++;
    else unclear++;

    questions.push({
      question: String(k.question_number || k.global_question_index || ''),
      section: k.section || '',
      display_question: buildDisplayQuestion(k),
      completed_page: student?.page ?? null,
      answer_page: mode === 'compare' ? (k.page ?? null) : null,
      student_answer: studentAns,
      expected_answer: expected,
      status,
      comment,
    });
  }

  // Surface student answers that didn't match any answer-key entry. They
  // typically signal questions the model identified on the worksheet but
  // not on the key — useful for the parent to spot gaps.
  if (mode === 'compare') {
    for (const s of students) {
      if (usedStudentRefs.has(refOf(s))) continue;
      questions.push({
        question: String(s.question_number || s.global_question_index || ''),
        section: s.section || '',
        display_question: buildDisplayQuestion(s),
        completed_page: s.page ?? null,
        answer_page: null,
        student_answer: s.answer ?? '',
        expected_answer: '',
        status: 'unclear',
        comment: 'No matching entry on the answer key.',
      });
      unclear++;
    }
  }

  const total = correct + incorrect + unclear;
  const summary = {
    estimated_score: total > 0 ? `${correct}/${total}` : '',
    comment: total > 0
      ? `${correct} correct, ${incorrect} incorrect, ${unclear} unclear out of ${total}.`
      : '',
  };

  const redo = questions
    .filter((q) => q.status === 'incorrect' || (q.status === 'unclear' && q.expected_answer))
    .map((q) => q.display_question || q.question)
    .filter(Boolean);

  return {
    summary,
    questions,
    redo,
    // Weak points: reserved field, kept empty by code-side comparison so
    // the report doesn't surface generic guesses like "understanding of
    // the topic". Future enhancement: a separate pattern-detection pass.
    weak_points: [],
  };
}

let _refSeq = 0;
const _refMap = new WeakMap();
function refOf(o) {
  if (!_refMap.has(o)) _refMap.set(o, ++_refSeq);
  return _refMap.get(o);
}
