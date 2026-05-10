// Paper-profile identity, synthesis, and freshness helpers.
//
// A "paper" is the structural metadata for one PDF (which pages are
// questions, which are the answer key). It's stored in IndexedDB and
// keyed by `paper_id`:
//
//   builtin:<index.json id>   — for built-in worksheets shipped with
//                               the app. Stable across sessions.
//   upload:<sha256>           — for user-uploaded PDFs hashed with
//                               crypto.subtle.digest. Same file →
//                               same id.
//   upload-meta:<name>:<bytes>:<pages>
//                             — fallback id used when SHA-256 is not
//                               available (no SubtleCrypto). Far less
//                               reliable but better than re-asking the
//                               parent to set page ranges every visit.
//
// A paper outlives any one attempt — many attempts can share one
// paper profile. Attempts snapshot their effective question/answer
// pages at start, so editing a paper later doesn't retroactively
// alter an in-progress attempt's stroke layout.

import { parsePageRange } from './pageRange.js';

// Parse the catalog entry's questionPages/answerPages strings into
// 1-based number arrays. Empty strings yield empty arrays.
function parseRangeStrings(catalogEntry) {
  const safe = (s) => {
    try { return parsePageRange(s); }
    catch (e) { console.warn(`Could not parse page range '${s}':`, e.message); return []; }
  };
  return {
    question_pages: safe(catalogEntry?.questionPages || ''),
    answer_pages: safe(catalogEntry?.answerPages || ''),
  };
}

const BUILTIN_PREFIX = 'builtin:';
const UPLOAD_PREFIX = 'upload:';
const UPLOAD_META_PREFIX = 'upload-meta:';

export function paperIdForBuiltin(builtinId) {
  if (!builtinId) throw new Error('paperIdForBuiltin: builtinId required');
  return BUILTIN_PREFIX + builtinId;
}

export function paperIdForUploadHash(hash) {
  if (!hash) throw new Error('paperIdForUploadHash: hash required');
  return UPLOAD_PREFIX + hash;
}

export function paperIdForUploadMeta({ pdf_name, pdf_byte_length, pdf_page_count }) {
  // Sanitise the filename so colons / slashes don't break the id format.
  const name = String(pdf_name || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return `${UPLOAD_META_PREFIX}${name}:${pdf_byte_length || 0}:${pdf_page_count || 0}`;
}

export function isBuiltinPaperId(paperId) {
  return typeof paperId === 'string' && paperId.startsWith(BUILTIN_PREFIX);
}

export function isUploadPaperId(paperId) {
  return typeof paperId === 'string' &&
    (paperId.startsWith(UPLOAD_PREFIX) || paperId.startsWith(UPLOAD_META_PREFIX));
}

// SHA-256 hex digest of a Uint8Array / ArrayBuffer. Returns null if
// SubtleCrypto isn't available (very old browsers, some embedded
// WebViews) — caller should fall back to paperIdForUploadMeta.
export async function sha256Hex(bytes) {
  try {
    if (!globalThis.crypto || !globalThis.crypto.subtle) return null;
    const buf = await crypto.subtle.digest(
      'SHA-256',
      bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes
    );
    const arr = new Uint8Array(buf);
    let hex = '';
    for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
    return hex;
  } catch (e) {
    console.warn('sha256Hex failed; falling back to meta-id', e);
    return null;
  }
}

// Compute paper identity for a freshly-loaded PDF. For built-ins the
// id is deterministic from index.json. For uploads we prefer
// SHA-256 of the bytes (best — same file → same id even if renamed)
// and fall back to filename + size + page count.
//
// Returns: { paper_id, source, built_in_id?, pdf_hash?, pdf_name,
//            pdf_byte_length, pdf_page_count }
export async function computePaperIdentity({
  source,                  // 'built_in' | 'upload'
  builtinId,               // when source === 'built_in'
  pdfBytes,                // ArrayBuffer or Uint8Array — for hashing uploads
  pdfName,                 // file name (uploads) or built-in title (built-ins)
  pdfPageCount,            // number of pages (from pdf.js doc)
  pdfByteLength,           // bytes.length (from the loaded blob)
}) {
  const base = {
    pdf_name: pdfName || '',
    pdf_byte_length: pdfByteLength || 0,
    pdf_page_count: pdfPageCount || 0,
  };
  if (source === 'built_in') {
    if (!builtinId) throw new Error('computePaperIdentity: builtinId required for built_in');
    // Hashing built-ins is optional — used to detect that the bundled
    // PDF has changed since the parent confirmed pages.
    const hash = pdfBytes ? await sha256Hex(pdfBytes) : null;
    return {
      paper_id: paperIdForBuiltin(builtinId),
      source: 'built_in',
      built_in_id: builtinId,
      pdf_hash: hash || null,
      ...base,
    };
  }
  // upload
  const hash = pdfBytes ? await sha256Hex(pdfBytes) : null;
  if (hash) {
    return {
      paper_id: paperIdForUploadHash(hash),
      source: 'upload',
      pdf_hash: hash,
      ...base,
    };
  }
  return {
    paper_id: paperIdForUploadMeta(base),
    source: 'upload',
    pdf_hash: null,
    ...base,
  };
}

// Has the underlying PDF changed since this paper profile was
// confirmed? Returns:
//   'fresh'  — same PDF (hash match, or hash unknown but byte length
//              and page count match)
//   'stale'  — hash mismatch, or byte length / page count mismatch
//              when no hash is available
//   'unknown'— profile has no comparable fields stored
export function paperFreshness(paper, identity) {
  if (!paper || !identity) return 'unknown';
  // Prefer hash when both sides have one.
  if (paper.pdf_hash && identity.pdf_hash) {
    return paper.pdf_hash === identity.pdf_hash ? 'fresh' : 'stale';
  }
  // Fall back to size + page count.
  const sizeKnown = paper.pdf_byte_length != null && identity.pdf_byte_length != null;
  const pagesKnown = paper.pdf_page_count != null && identity.pdf_page_count != null;
  if (!sizeKnown && !pagesKnown) return 'unknown';
  if (sizeKnown && paper.pdf_byte_length !== identity.pdf_byte_length) return 'stale';
  if (pagesKnown && paper.pdf_page_count !== identity.pdf_page_count) return 'stale';
  return 'fresh';
}

// Build a paper profile from a built-in catalog entry. Used the first
// time a built-in is opened, so we have a confirmed profile to draw
// from on subsequent visits without re-parsing index.json each time.
//
// All built-in entries are treated as confirmed_by_user: false until
// the parent explicitly confirms them — the index.json metadata is
// curated but we still want explicit confirmation before relying on it.
//
// (The practice picker can still use the curated ranges to prefill
// the form even before confirmation. See main.js.)
export function paperFromBuiltinCatalog(catalogEntry, identity) {
  if (!catalogEntry) throw new Error('paperFromBuiltinCatalog: catalogEntry required');
  const { question_pages, answer_pages } = parseRangeStrings(catalogEntry);
  const pages = synthesizePagesFromRanges(
    identity?.pdf_page_count || catalogEntry.totalPages || 0,
    question_pages, answer_pages,
    'curated_metadata',
  );
  return {
    paper_id: paperIdForBuiltin(catalogEntry.id),
    title: catalogEntry.title || '',
    source: 'built_in',
    built_in_id: catalogEntry.id,
    pdf_hash: identity?.pdf_hash || null,
    pdf_name: identity?.pdf_name || catalogEntry.title || '',
    pdf_byte_length: identity?.pdf_byte_length || 0,
    pdf_page_count: identity?.pdf_page_count || catalogEntry.totalPages || 0,
    question_pages,
    answer_pages,
    pages,
    confirmed_by_user: false,
    setup_costs: [],
    updated_at: new Date().toISOString(),
  };
}

// Synthesize a paper profile from an existing attempt's questionPages /
// answerPages fields. Used as a fallback when an old attempt is loaded
// and there's no paper profile yet (pre-Stage E attempts, or attempts
// for an upload whose hash now differs).
export function paperFromAttempt(attempt, identity) {
  if (!attempt) throw new Error('paperFromAttempt: attempt required');
  const qp = Array.isArray(attempt.questionPages) ? [...attempt.questionPages] : [];
  const ap = Array.isArray(attempt.answerPages) ? [...attempt.answerPages] : [];
  const pages = synthesizePagesFromRanges(
    identity?.pdf_page_count || attempt.pdfPageCount || 0,
    qp, ap, 'attempt_fallback',
  );
  const paperId = identity?.paper_id
    || (attempt.builtinId ? paperIdForBuiltin(attempt.builtinId) : null);
  if (!paperId) throw new Error('paperFromAttempt: no paper_id available');
  return {
    paper_id: paperId,
    title: attempt.pdfName || '',
    source: identity?.source || (attempt.builtinId ? 'built_in' : 'upload'),
    built_in_id: attempt.builtinId || null,
    pdf_hash: identity?.pdf_hash || null,
    pdf_name: identity?.pdf_name || attempt.pdfName || '',
    pdf_byte_length: identity?.pdf_byte_length || 0,
    pdf_page_count: identity?.pdf_page_count || 0,
    question_pages: qp,
    answer_pages: ap,
    pages,
    confirmed_by_user: false, // synthesized — needs explicit confirmation
    setup_costs: [],
    updated_at: new Date().toISOString(),
  };
}

// Build a `pages` array from question/answer page ranges. Each entry:
//   { page, type, confidence, reason, manually_edited }
// Pages not in either range are typed 'unknown' with confidence 0.
function synthesizePagesFromRanges(totalPages, questionPages, answerPages, reason) {
  const qSet = new Set(questionPages);
  const aSet = new Set(answerPages);
  const out = [];
  for (let p = 1; p <= (totalPages || 0); p++) {
    let type = 'unknown';
    let confidence = 0;
    if (qSet.has(p)) { type = 'question'; confidence = 1; }
    else if (aSet.has(p)) { type = 'answer_key'; confidence = 1; }
    out.push({
      page: p,
      type,
      confidence,
      reason: reason || '',
      manually_edited: false,
    });
  }
  return out;
}

// Build an empty paper profile from a paper identity. Used when an
// upload reaches Auto-classify without a stored profile — the
// detection result is then merged into this skeleton (see
// mergeDetectionIntoPaper in main.js).
export function paperFromIdentity(identity, title) {
  if (!identity || !identity.paper_id) {
    throw new Error('paperFromIdentity: identity.paper_id required');
  }
  return {
    paper_id: identity.paper_id,
    title: title || identity.pdf_name || '',
    source: identity.source || 'upload',
    built_in_id: identity.built_in_id || null,
    pdf_hash: identity.pdf_hash || null,
    pdf_name: identity.pdf_name || '',
    pdf_byte_length: identity.pdf_byte_length || 0,
    pdf_page_count: identity.pdf_page_count || 0,
    question_pages: [],
    answer_pages: [],
    pages: [],
    confirmed_by_user: false,
    setup_costs: [],
    updated_at: new Date().toISOString(),
  };
}

// Snapshot the question/answer page ranges from a paper profile onto
// an attempt at attempt-start time. Profile edits made AFTER this
// snapshot don't retroactively change the in-progress attempt — see
// the Stage E spec.
export function snapshotPaperOntoAttempt(paper, attempt) {
  if (!paper) return attempt;
  return {
    ...attempt,
    paperId: paper.paper_id,
    questionPages: [...(paper.question_pages || [])],
    answerPages: [...(paper.answer_pages || [])],
  };
}
