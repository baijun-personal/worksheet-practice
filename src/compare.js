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

// Composite matching key. Uses the synthetic section index when
// present (set by assignSyntheticSections — covers section-restart
// papers where the printed `section` field is unreliable), otherwise
// falls back to the printed section string. The qnum portion is the
// existing normalised question_number.
function compositeKey(entry) {
  const synth = entry && entry._syntheticSection;
  const sec = synth != null
    ? `S${synth}`
    : normalizeKeyPart(entry?.section || '');
  const qnum = normalizeQNumber(entry?.question_number || '');
  return `${sec}|${qnum}`;
}

// Extract the leading integer from a question_number like "9",
// "9a", "9(i)", "Q9b". Returns null for purely alphabetic or
// roman labels (rare).
function leadingInt(qnum) {
  const m = String(qnum || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// Try to split a flat answer-key value like "27, 32" or "alert; calm"
// into `expectedCount` segments. Returns string[] of that length, or
// null if a clean split isn't possible. The split is intentionally
// strict: we only accept results that have the SAME number of
// segments as the student has parts. Mismatches fall back to the
// caller's flatten-or-pass-through path.
//
// Supports comma, semicolon, and the "X and Y" form (only when
// exactly 2 are expected). Trims whitespace and a leading "and" /
// "or" on each segment. Filters out empty strings.
//
// Used by matchExtractions' pair-builder when the student side is
// multi-part but the answer-key side is flat — common on
// list-answer questions ("Write the next two numbers") where the
// printed key writes the answers as a single comma-separated row.
// Without this, the AI comparator receives mismatched part counts
// (student N parts vs key 1 part) and produces nonsense per-part
// rows.
function splitFlatListAnswer(text, expectedCount) {
  const s = String(text || '').trim();
  if (!s || expectedCount < 2) return null;

  // Try comma split first, then semicolon. Both are common in
  // Singapore answer keys ("27, 32" or "27; 32").
  for (const delim of [',', ';']) {
    if (s.includes(delim)) {
      const parts = s.split(delim).map((x) =>
        x.replace(/^\s*(?:and|or)\s+/i, '').trim()
      ).filter(Boolean);
      if (parts.length === expectedCount) return parts;
    }
  }

  // "X and Y" — only when expectedCount is exactly 2.
  if (expectedCount === 2) {
    const m = s.match(/^(.+?)\s+and\s+(.+)$/i);
    if (m) {
      const parts = [m[1].trim(), m[2].trim()].filter(Boolean);
      if (parts.length === 2) return parts;
    }
  }

  return null;
}

// Assign a synthetic, 1-indexed section number to every entry in the
// list based on backward jumps in the printed question-number sequence.
// Papers with sections that restart numbering at 1 (e.g. Section A:
// Q1-Q10, Section B: Q1-Q5) produce collisions on the printed
// (section, qnum) composite key because the extracted `section` field
// is unreliable — the answer-key page often labels every entry just
// "Answer Key", and student-side section text is partial / stale.
//
// Walk the list in printed (top-to-bottom) order. Track the maximum
// numeric prefix seen so far. When the next entry's prefix goes
// BACKWARD (strict <), treat it as the start of a new section and
// increment. Forward / equal stays in the current section.
//
// Multi-part within the same Q (Q9, Q9a, Q9b → leadingInt 9, 9, 9):
// equal, no reset. Skipped numbers (1, 2, 3, 5): forward, no reset.
// Section reset (… 10, 1, 2, …): backward, reset.
//
// Roman-only or alphabetic labels return null from leadingInt and
// just inherit the running section.
//
// Known limitation: a single-question Section A followed by Section
// B starting at Q1 (sequence: 1, 1) is NOT detected — strict <
// requires a backward jump. Mitigation: tighten to <= if a real
// paper surfaces it, accepting false-positive resets on duplicate
// numbers within a section. For the current scope, strict <.
function assignSyntheticSections(answers) {
  let currentSection = 1;
  let maxSeen = 0;
  for (const a of answers) {
    if (!a) continue;
    const n = leadingInt(a.question_number);
    if (n == null) {
      a._syntheticSection = currentSection;
      continue;
    }
    if (n < maxSeen) {
      currentSection += 1;
      maxSeen = n;
    } else if (n > maxSeen) {
      maxSeen = n;
    }
    a._syntheticSection = currentSection;
  }
  return answers;
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
    const ck = compositeKey(a);

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
    } else if (a._fanned_from_multipart === true) {
      // Duplicate of a fanned-out entry. fanOutMultiPartKeys emits
      // dual roman forms ("19(i)" + "19i") that normalize to the
      // same composite key — they represent the SAME part, not two
      // parts of a multi-part question, so don't merge them into a
      // duplicate-parts multi-part record. Drop silently. The
      // parens form was emitted first, so the entry kept in byKey
      // is the parenthesised one — that lets the second pass auto-
      // group "19(i)" + "19(ii)" back into a base "19" multi-part.
      continue;
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
    const baseCk = compositeKey({
      section: entry.section || '',
      question_number: sub.base,
      _syntheticSection: entry._syntheticSection,
    });
    if (!baseGroups.has(baseCk)) {
      baseGroups.set(baseCk, {
        global_question_index: entry.global_question_index,
        section: entry.section || '',
        _syntheticSection: entry._syntheticSection, // inherit so downstream matching works
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

// Build the human-facing label for a question. On papers without
// section restarts (paperHasSections=false — the common case) the
// label is just "Q<n>" or "<section> Q<n>". On section-restart
// papers (paperHasSections=true — detected by assignSyntheticSections)
// every label is prefixed with the synthetic section ("S1Q1", "S2Q1")
// so the parent can disambiguate Section A Q1 from Section B Q1.
// The flag is computed once per match run in matchExtractions and
// threaded through both call sites.
function buildDisplayQuestion(a, paperHasSections = false) {
  // Always rebuild from question_number / section. The AI's
  // display_question is unreliable — it sometimes returns the full
  // question text ("In paragraph 3, what two things..."), which is
  // useless as a label. We only fall back to display_question if it
  // exists AND looks short and label-like (no spaces > a couple).
  //
  // Section prefix policy:
  //   - When paperHasSections=true (a section reset was detected) the
  //     label MUST disambiguate between e.g. Section A Q1 and Section
  //     B Q1, so we emit "S{n}Q{num}".
  //   - When paperHasSections=false the printed section name is
  //     redundant — the report table already shows section in its own
  //     column and the previous "Section B: Short Answer Questions
  //     Q9a" was 39+ chars of noise. Just "Q{num}".
  const q = a.question_number ? String(a.question_number).trim() : '';
  if (q) {
    const qLabel = /^Q/i.test(q) ? q : `Q${q}`;
    if (paperHasSections && a._syntheticSection != null) {
      return `S${a._syntheticSection}${qLabel}`;
    }
    return qLabel;
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

// Fan out multi-part answer-key entries into flat per-part entries.
//
// Math worksheet answer keys typically list multi-part answers in
// the grouped form:
//   { question_number: "9", is_multi_part: true,
//     parts: [{part: "a", answer: "56"}, {part: "b", answer: "12"}] }
//
// Student extraction on the same paper emits the flat form, one
// row per answer slot:
//   { question_number: "9a", answer: "56" }
//   { question_number: "9b", answer: "14" }
//
// matchExtractions pairs by question_number string equality, so the
// shapes never line up without preprocessing. We canonicalise BOTH
// sides to the flat shape before the matcher runs.
//
// Only fires when is_multi_part === true AND parts[] is non-empty.
// Flat entries pass through unchanged. Parenthesised-suffix entries
// (e.g. "19(i)") aren't multi-part at this stage — they're handled
// by normalizeMultiParts' second pass, which is correct for them.
//
// Applied to BOTH extraction sides in matchExtractions. The helper
// is idempotent on flat entries (they pass through unchanged at the
// out.push(a) below), so running it on both sides is safe and avoids
// shape drift. An earlier "answer-key only" application broke when
// the student side emitted multi-part on inline-layout Math questions
// (e.g. "9. Write the answers. a. ___ b. ___" read as one multi-part
// question instead of two distinct sub-questions); the symmetric
// version handles any combination of shapes either side produces.
//
// Part labels that signal a list-answer slot rather than a distinct
// sub-question. When fanOutMultiPartKeys sees these, it emits BOTH
// a parenthesised form ("6(1)", "19(i)") and a bare form ("61",
// "19i") so the second-pass auto-grouping in normalizeMultiParts
// can regroup against whichever shape the OTHER side emitted.
//   - Roman: i, ii, iii, iv, v, vi, vii, viii, ix, x
//   - Numeric: any positive integer (covers list-answer questions
//     like "Write the next two numbers" where the student-side
//     extraction emits parts: [{part: "1"}, {part: "2"}] but the
//     printed answer key gives a single comma-separated answer).
// Alphabetic parts (a, b, c) intentionally do NOT match — those
// are typically distinct sub-questions on Singapore P4/P5 papers
// (Q9a vs Q9b are separate questions with their own prompts),
// not slots in one list answer. Bundling them into a multi-part
// would change the matching semantics and risk regressions on
// every paper with 9a/9b-style sub-questions.
const PARENTHESISABLE_PART_RE = /^(\d+|i{1,3}|iv|v|vi{1,3}|ix|x)$/i;

// Build a flat per-part entry from a parent multi-part record and
// one of its parts, using `qnum` as the synthesised question_number
// (the caller decides whether to emit "19i" or "19(i)" or both).
function buildFannedEntry(parent, part, qnum) {
  return {
    global_question_index: parent.global_question_index,
    section: parent.section || '',
    _syntheticSection: parent._syntheticSection, // inherit synthetic section for matching
    question_number: qnum,
    display_question: undefined,                  // rebuilt downstream
    page: parent.page,
    answer_type: part?.answer_type || parent.answer_type || 'text',
    answer: part?.answer ?? '',
    confidence: typeof part?.confidence === 'number'
      ? part.confidence
      : (typeof parent.confidence === 'number' ? parent.confidence : null),
    _fanned_from_multipart: true,
  };
}

function fanOutMultiPartKeys(answers) {
  const out = [];
  for (const a of answers) {
    if (!a) continue;
    if (a.is_multi_part === true && Array.isArray(a.parts) && a.parts.length > 0) {
      const baseQNum = String(a.question_number || '').trim();
      for (const p of a.parts) {
        const partLabel = String(p?.part ?? '').trim();
        if (!baseQNum && !partLabel) continue; // skip degenerate
        // Parenthesisable parts (roman OR numeric) emit the
        // parenthesised form FIRST and the bare form second.
        // normalizeMultiParts first-pass dedupes by composite key —
        // both forms normalize to the same qnum ("19(i)" and "19i"
        // both → "19i" via normalizeQNumber; "6(1)" and "61" both →
        // "61"), so the second arrival drops silently as a fanned-
        // out duplicate. Keeping the parens form lets the second
        // pass auto-group "19(i)" + "19(ii)" — or "6(1)" + "6(2)" —
        // back into a base multi-part so the matcher pairs against
        // the other side whether IT emitted grouped, flat-with-
        // parens, or flat-no-parens.
        // Alphabetic parts (a/b/c/d) emit a single bare form; the
        // matcher pairs them positionally via question_number.
        if (PARENTHESISABLE_PART_RE.test(partLabel)) {
          out.push(buildFannedEntry(a, p, baseQNum + '(' + partLabel + ')'));
          out.push(buildFannedEntry(a, p, baseQNum + partLabel));
        } else {
          out.push(buildFannedEntry(a, p, baseQNum + partLabel));
        }
      }
      continue;
    }
    out.push(a);
  }
  return out;
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
  // Fan out grouped multi-part entries on BOTH sides into per-part
  // flat rows ("9a","9b") before normalising. Either side may emit
  // multi-part on any given run — Math papers in particular are
  // ambiguous: the model sometimes reads "9. Write the answers.
  // a. ___ b. ___" as one multi-part question and sometimes as two
  // distinct sub-questions, and the two sides don't always agree.
  // Running fanOutMultiPartKeys on both sides canonicalises both to
  // flat, so the matcher's question_number string equality works
  // regardless of which shape either side produced. fanOutMultiPartKeys
  // is idempotent on flat entries.
  // assignSyntheticSections runs FIRST so every entry carries a
  // _syntheticSection index that survives through fanOutMultiPartKeys
  // (which preserves it on fanned children) and into normalizeMultiParts
  // (which reads it via compositeKey). Section-restart papers (Section
  // A: Q1-Q10, Section B: Q1-Q5) get distinct S1/S2 prefixes so the
  // composite key no longer collapses Section A Q1 and Section B Q1
  // into the same bucket on the answer-key side.
  const students = normalizeMultiParts(
    fanOutMultiPartKeys(
      assignSyntheticSections(flattenAnswers(studentBatchResults))
    )
  );
  const keys = normalizeMultiParts(
    fanOutMultiPartKeys(
      assignSyntheticSections(flattenAnswers(answerKeyResults))
    )
  );

  // Did at least one side actually have a section reset? If neither
  // side sees a backward jump, every entry is _syntheticSection=1
  // and we keep the familiar "Q1"/"Q9a" display labels. Otherwise
  // every label gets an S-prefix ("S1Q1","S2Q1") so the parent can
  // tell Section A Q1 apart from Section B Q1.
  const paperHasSections =
    students.some((s) => (s._syntheticSection || 1) > 1) ||
    keys.some((k) => (k._syntheticSection || 1) > 1);

  const keyByKey = new Map();
  const keyByKeyAmbiguous = new Set();
  const keyByQNum = new Map();
  const keyByQNumAmbiguous = new Set();
  for (const k of keys) {
    if (k.section || k.question_number || k._syntheticSection != null) {
      const ck = compositeKey(k);
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
    const ck = compositeKey(s);
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

    // Determine the shape of each side BEFORE the
    // split/flatten logic below. The pair's final is_multi_part
    // flag is recomputed after that block from the final
    // studentParts/expectedParts arrays — the flatten branch can
    // collapse a grouped student to length 1, so an early flag
    // based only on studentGrouped/keyGrouped would lie.
    const studentGrouped = s.is_multi_part === true && Array.isArray(s.parts);
    const keyGrouped = !!key && key.is_multi_part === true && Array.isArray(key.parts);

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
    // Build expected_parts to match the student's part count where
    // possible. Three branches:
    //
    //   1. Both sides grouped: per-part 1:1 — the existing happy path.
    //   2. Student grouped, key flat: try to split the key's flat
    //      answer ("27, 32") into the same number of segments as
    //      studentParts. If splitting succeeds, pair positionally per
    //      part. If splitting fails (single-value key like "blue"),
    //      flatten the student side into one joined entry instead —
    //      both sides become 1:1 and the comparator sees a clean
    //      single-string compare. This case appeared on the Math
    //      Mock Section A Q6 ("Write the next two numbers"): student
    //      extracted as multi-part with two slots, key printed
    //      "27, 32" as a single comma-separated flat answer. Without
    //      the split/flatten, the AI compare received mismatched
    //      part counts and produced nonsense per-part rows.
    //   3. Key flat AND student also flat: today's single wrap.
    let expectedParts;
    if (keyGrouped) {
      expectedParts = key.parts.map((p, i) => ({
        part: p.part != null ? String(p.part) : String(i + 1),
        answer: p.answer ?? '',
        answer_type: p.answer_type || 'text',
        confidence: typeof p.confidence === 'number' ? p.confidence : null,
      }));
    } else if (key && studentGrouped && studentParts.length > 1) {
      const split = splitFlatListAnswer(key.answer, studentParts.length);
      if (split) {
        // Split worked — pair positionally per part. Student's
        // part labels are preserved so the report's per-part rows
        // line up with the student's printed labels (Q6(1), Q6(2)).
        expectedParts = split.map((value, i) => ({
          part: studentParts[i]?.part ?? String(i + 1),
          answer: value,
          answer_type: key.answer_type || 'text',
          confidence: typeof key.confidence === 'number' ? key.confidence : null,
        }));
      } else {
        // Flatten: join the student's parts into one comma-
        // separated entry, leave the key flat. Both sides 1:1.
        // We mutate studentParts in place (it's an array literal
        // built above this branch — no external aliasing) so the
        // pair record below sees the flattened shape.
        const joined = studentParts.map((p) => p.answer).filter(Boolean).join(', ');
        studentParts.length = 0;
        studentParts.push({
          part: '1',
          answer: joined,
          answer_type: 'text',
          confidence: null,
        });
        expectedParts = [{
          part: '1',
          answer: key.answer ?? '',
          answer_type: key.answer_type || 'text',
          confidence: typeof key.confidence === 'number' ? key.confidence : null,
        }];
      }
    } else if (key) {
      expectedParts = [{
        part: '1',
        answer: key.answer ?? '',
        answer_type: key.answer_type || 'text',
        confidence: typeof key.confidence === 'number' ? key.confidence : null,
      }];
    } else {
      expectedParts = [];
    }

    // Multi-part flag derived from the FINAL shapes after the
    // split/flatten logic above. The flatten branch may have
    // rewritten studentParts to length 1, in which case the pair
    // is no longer multi-part regardless of the original
    // studentGrouped flag.
    const finalIsMultiPart = studentParts.length > 1 || expectedParts.length > 1;

    pairs.push({
      question: String(s.question_number || s.global_question_index || ''),
      section: s.section || '',
      display_question: buildDisplayQuestion(s, paperHasSections),
      completed_page: s.page ?? null,
      answer_page: key?.page ?? null,
      // Multi-part fields (always populated; for flat pairs parts has length 1).
      is_multi_part: finalIsMultiPart,
      order_matters: orderMatters,
      student_parts: studentParts,
      expected_parts: expectedParts,
      // Flat convenience fields — preserved for the non-grouped flow so
      // existing readers (markPairs, fallback scoring) work unchanged.
      // Derived from the (possibly mutated) studentParts/expectedParts
      // arrays so the flatten branch's rewrite shows up cleanly here too.
      student_answer: studentParts.length > 1
        ? studentParts.map((p) => p.answer).filter(Boolean).join('; ')
        : (studentParts[0]?.answer ?? ''),
      student_confidence: studentParts.length > 1
        ? null
        : (studentParts[0]?.confidence ?? null),
      student_type: studentParts.length > 1
        ? ''
        : (studentParts[0]?.answer_type || ''),
      expected_answer: expectedParts.length > 1
        ? expectedParts.map((p) => p.answer).filter(Boolean).join('; ')
        : (expectedParts[0]?.answer ?? ''),
      expected_type: expectedParts.length > 1
        ? ''
        : (expectedParts[0]?.answer_type || ''),
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
      display_question: buildDisplayQuestion(k, paperHasSections),
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

  let correct = 0, incorrect = 0, unclear = 0, unanswered = 0;
  const questions = [];
  const tally = (s) => {
    if (s === 'correct')        correct++;
    else if (s === 'incorrect') incorrect++;
    else if (s === 'unanswered') unanswered++;
    else                        unclear++;
  };
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
          // Visual results don't carry extraction confidence in a way
          // that's diagnostic for the self-consistency hypothesis —
          // the model that "extracts" the drawing IS the comparator
          // here. Render as null to keep the column shape consistent.
          student_confidence: null,
        };
      } else {
        row = {
          ...base,
          student_answer: '[visual answer]',
          expected_answer: '[visual answer]',
          status: 'unclear',
          comment: `Visual comparison: ${v?.error || 'not run.'}`,
          student_confidence: null,
        };
      }
      tally(row.status);
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
        tally(row.status);
        questions.push(row);
      }
      continue;
    }

    // Flat text pair
    const ai = aiQByQ.get(qn);
    if (ai) {
      let status = normalizeStatus(ai.status);
      let comment = ai.comment ? String(ai.comment) : '';
      // Blank-vs-unclear: the extraction stage now tags genuinely
      // empty answer lines as answer_type='blank'. Override the AI's
      // verdict in that case — the AI couldn't tell blank from
      // unreadable from its text-only payload (no images, no
      // answer_type), so it would otherwise label these as
      // incorrect or unclear. We surface the distinction here so
      // the report can count them as "unanswered" separately.
      if (p.student_type === 'blank' && match.keysProvided) {
        status = 'unanswered';
        comment = 'No answer was written.';
      }
      tally(status);
      questions.push({
        ...base,
        student_answer: ai.student_answer ?? p.student_answer,
        expected_answer: ai.expected_answer ?? p.expected_answer,
        status,
        comment,
        // Extraction confidence — emitted per-question by the vision
        // model when reading the student's writing. Rendered in the
        // "Conf." column of the All-questions table to support
        // diagnosing run-to-run flips (low confidence on a flipped
        // reading is the smoking gun for a self-consistency fix).
        // Distinct from the comparator's confidence shown in the
        // debug-table "Cmp.conf." column.
        student_confidence: p.student_confidence ?? null,
      });
      continue;
    }

    // No AI text result for this pair (or AI text call failed) — local fallback.
    const local = scoreOnePairLocally(p, match.keysProvided);
    // Same blank-vs-unclear override in the fallback path so a
    // failed AI call doesn't mask the unanswered distinction.
    if (p.student_type === 'blank' && match.keysProvided) {
      local.status = 'unanswered';
      local.comment = 'No answer was written.';
    }
    tally(local.status);
    questions.push({
      ...base,
      ...local,
      student_confidence: p.student_confidence ?? null,
    });
  }

  // "attempted" = questions where the student tried something
  // (graded by the AI), regardless of correct/wrong/unclear.
  // Unanswered rows are NOT attempted by definition. The
  // estimated_score denominator follows the same convention so
  // skipping questions doesn't artificially inflate the
  // percentage (10/10 with 7 skipped reads cleaner than 10/17
  // including 7 unanswered).
  const attempted = correct + incorrect + unclear;
  const total = attempted + unanswered;
  const summary = {
    estimated_score: attempted > 0 && match.keysProvided ? `${correct}/${attempted}` : '',
    comment: buildSummaryComment({
      correct, incorrect, unclear, unanswered, attempted, total,
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
//     question_page:      <integer>   // 1-based PDF page number
//   }
//
// Placement: there are no coordinates here. The compare/marking
// AI call is text-only — it never sees the rendered page — so
// it can't locate a printed question heading, and the earlier
// code-side ordinal-spread coordinate also drifted off questions
// on any paper with non-uniform question density.
//
// Review Mode now renders a side-rail list of review rows
// alongside the page image, ordered by question number within
// each page. question_page is all the rail needs to know.
function buildReviewRecords({ pairs, questions, aiQByQ }) {
  // Group flat rows by base question so multi-part subparts that
  // share a base question (Q19(i), Q19(ii)) become one record.
  const groups = new Map(); // baseKey -> { row, parts: [] }
  for (const row of questions) {
    // unanswered joins incorrect + unclear: the parent still
    // wants a Review-list row for "this one was skipped — here's
    // the expected answer, here's how to think about it" via the
    // Review popup. The side-rail list treats all three statuses
    // the same way; the popup carries the distinction.
    if (row.status !== 'incorrect' && row.status !== 'unclear' && row.status !== 'unanswered') continue;
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
    // Prefer the local 'No answer was written.' override for
    // unanswered rows over the AI's text-compare comment (which
    // typically reads "Answer is unreadable." — wrong for blanks
    // and the whole reason this fix exists).
    const localCommentWinsForUnanswered =
      baseRow.status === 'unanswered' && baseRow.comment;
    const shortReason = localCommentWinsForUnanswered
      ? String(baseRow.comment).trim()
      : String(aiRow?.short_reason || baseRow.comment || '').trim();
    const anchorPage = synthAnchor({ page: baseRow.completed_page });
    const status = parts.length > 0 && parts.every((p) => p.status === 'correct')
      ? 'correct'
      : (parts.length > 0 ? worstStatusOf(parts) : baseRow.status);
    if (status === 'correct') continue; // shouldn't happen given the filter, but defensive

    const rec = {
      question: baseKey,
      section: baseRow.section || '',
      completed_page: anchorPage ?? baseRow.completed_page ?? null,
      status,
      short_display_answer: shortAnswer,
      short_reason: shortReason,
      confidence: conf,
      // Extraction confidence pulled off the base row (which now
      // carries it from buildFinalReport). For multi-part records
      // this is whichever part opened the group; the per-part
      // extraction confidence still appears in the All-questions
      // table's "Conf." column, one row per part.
      student_confidence: baseRow.student_confidence ?? null,
      needs_human_review: conf < 0.5,
      question_page: anchorPage,
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
  // Default 0.7 when the AI omits confidence: low enough to NOT
  // count as "reliable" (the prompt's >= 0.8 floor), high enough
  // to NOT trip needs_human_review (which fires below 0.5). An
  // omission lands in the middle band — graded but unremarkable.
  // The low-confidence banner shows ONLY records below 0.5, so
  // an omitted-confidence record will not appear there. That's
  // intentional: we don't want noise from missing-but-otherwise-
  // sensible rows. If the AI starts omitting confidence often
  // and we want to surface those, lower the default to 0.49.
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
  // incorrect > unanswered > unclear > correct. unanswered ranks
  // above unclear because a blank-but-graded part is a definitive
  // miss (no attempt), whereas unclear is "couldn't tell". All
  // three render the same way in the Review side-rail list; the
  // popup carries the distinction.
  if (parts.some((p) => p.status === 'incorrect'))   return 'incorrect';
  if (parts.some((p) => p.status === 'unanswered')) return 'unanswered';
  if (parts.some((p) => p.status === 'unclear'))     return 'unclear';
  return 'correct';
}

function qnumNumericPrefix(qn) {
  const m = String(qn || '').match(/^(\d+)/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

// Anchor a review record to a page. The earlier x/y coordinate
// path (ordinal-uniform placement) was removed when Review
// Mode switched from on-page ✗ overlays to a side-rail list —
// there's no coordinate to compute. The list orders rows by
// question number within the record's page, which is all we
// need here.
//
// Returns the page number (or null if the input page is
// invalid / missing).
function synthAnchor({ page }) {
  const pg = Number(page);
  if (!Number.isFinite(pg) || pg < 1) return null;
  return pg;
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
    // Per-part blank-vs-unclear: same override as the flat path —
    // if extraction tagged this subpart's answer_type as 'blank',
    // override status to 'unanswered' regardless of what the AI
    // text-compare said. The AI sees no answer_type and would
    // otherwise mis-classify.
    const partIsBlank = sp.answer_type === 'blank' && keysProvided;
    // Per-part extraction confidence — emitted by the student-side
    // vision model when reading each slot. Diagnostic for the
    // self-consistency hypothesis; rendered in the All-questions
    // table's "Conf." column. null when the model didn't emit one.
    const partConf = typeof sp.confidence === 'number' ? sp.confidence : null;
    if (ai) {
      const status = partIsBlank ? 'unanswered' : normalizeStatus(ai.status);
      const comment = partIsBlank
        ? 'No answer was written.'
        : (ai.comment ? String(ai.comment) : '');
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
        comment,
        student_confidence: partConf,
      });
    } else if (localStatuses) {
      const local = localStatuses[i] || { status: 'unclear', comment: 'Local fallback could not score this part.' };
      rows.push({
        ...baseRow,
        display_question: display,
        student_answer: sp.answer || '',
        expected_answer: local.matchedExpected || '',
        status: partIsBlank ? 'unanswered' : local.status,
        comment: partIsBlank ? 'No answer was written.' : (local.comment || ''),
        student_confidence: partConf,
      });
    } else {
      rows.push({
        ...baseRow,
        display_question: display,
        student_answer: sp.answer || '',
        expected_answer: '',
        status: partIsBlank ? 'unanswered' : 'unclear',
        comment: partIsBlank
          ? 'No answer was written.'
          : 'AI compare did not return a per-part status for this part.',
        student_confidence: partConf,
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

function buildSummaryComment({ correct, incorrect, unclear, unanswered = 0, attempted, total, notInAttempt, keysProvided }) {
  if (attempted === 0 && unanswered === 0 && (!notInAttempt || notInAttempt.length === 0)) return '';
  if (attempted === 0 && unanswered === 0) return 'No answers were extracted from the completed pages.';
  // Order: correct, incorrect, unclear (only if any), unanswered
  // (only if any), out of <total>. Suppress zero buckets — saying
  // "0 unclear" on a paper with no unclear items is noise.
  const totalForLine = Number.isFinite(total) ? total : (attempted + unanswered);
  const parts = [];
  parts.push(`${correct} correct`);
  parts.push(`${incorrect} incorrect`);
  if (unclear > 0)    parts.push(`${unclear} unclear`);
  if (unanswered > 0) parts.push(`${unanswered} unanswered`);
  let s = parts.join(', ') + ` out of ${totalForLine} question(s).`;
  if (attempted > 0 && unanswered > 0) {
    s += ` (Score is based on ${attempted} attempted; ${unanswered} were skipped.)`;
  }
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
