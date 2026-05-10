// IndexedDB wrapper.
// One DB with three stores:
//   attempts: { id, createdAt, pdfName, pdfBlob, subject, level,
//               questionPages, answerPages, currentPage, reportJson,
//               settings, status, paperId? }
//   strokes:  keyed by [attemptId, strokeId], indexed by [attemptId, pageNumber]
//   papers:   { paper_id, title, source, built_in_id?, pdf_hash?,
//               pdf_name?, pdf_byte_length?, pdf_page_count?,
//               question_pages, answer_pages, pages,
//               confirmed_by_user, setup_costs, updated_at }
//
// Strokes are stored separately so writing one stroke doesn't rewrite the
// whole attempt blob (which embeds the source PDF). Papers are stored
// separately from attempts so a paper profile can outlive any one
// attempt and be reused across attempts on the same PDF.
//
// Schema versions:
//   v1: attempts + strokes (initial)
//   v2: + papers store (Stage E)

const DB_NAME = 'worksheet-marker';
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      // v1 → v2: existing attempts + strokes are preserved unchanged.
      // We only add the papers store. Always check existence so a fresh
      // install at v2 also works (no v1 step happened).
      if (!db.objectStoreNames.contains('attempts')) {
        db.createObjectStore('attempts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('strokes')) {
        const s = db.createObjectStore('strokes', { keyPath: ['attemptId', 'id'] });
        s.createIndex('byAttemptPage', ['attemptId', 'pageNumber']);
        s.createIndex('byAttempt', 'attemptId');
      }
      if (!db.objectStoreNames.contains('papers')) {
        db.createObjectStore('papers', { keyPath: 'paper_id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode) {
  return openDb().then((db) => db.transaction(storeNames, mode));
}

function awaitTx(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- attempts -------------------------------------------------------------

export async function putAttempt(attempt) {
  const t = await tx('attempts', 'readwrite');
  t.objectStore('attempts').put(attempt);
  await awaitTx(t);
}

export async function getAttempt(id) {
  const t = await tx('attempts', 'readonly');
  return reqToPromise(t.objectStore('attempts').get(id));
}

export async function attemptExists(id) {
  const a = await getAttempt(id);
  return !!a;
}

export async function listAttempts() {
  const t = await tx('attempts', 'readonly');
  return reqToPromise(t.objectStore('attempts').getAll());
}

export async function deleteAttempt(id) {
  const t = await tx(['attempts', 'strokes'], 'readwrite');
  t.objectStore('attempts').delete(id);
  // Remove strokes belonging to this attempt
  const idx = t.objectStore('strokes').index('byAttempt');
  const cursorReq = idx.openCursor(IDBKeyRange.only(id));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
  await awaitTx(t);
}

// --- strokes --------------------------------------------------------------

export async function putStroke(stroke) {
  const t = await tx('strokes', 'readwrite');
  t.objectStore('strokes').put(stroke);
  await awaitTx(t);
}

export async function deleteStroke(attemptId, strokeId) {
  const t = await tx('strokes', 'readwrite');
  t.objectStore('strokes').delete([attemptId, strokeId]);
  await awaitTx(t);
}

export async function getStrokesForPage(attemptId, pageNumber) {
  const t = await tx('strokes', 'readonly');
  const idx = t.objectStore('strokes').index('byAttemptPage');
  const range = IDBKeyRange.only([attemptId, pageNumber]);
  const all = await reqToPromise(idx.getAll(range));
  // Sort by created order
  all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return all;
}

export async function clearStrokesForPage(attemptId, pageNumber) {
  const t = await tx('strokes', 'readwrite');
  const idx = t.objectStore('strokes').index('byAttemptPage');
  const cursorReq = idx.openCursor(IDBKeyRange.only([attemptId, pageNumber]));
  cursorReq.onsuccess = () => {
    const c = cursorReq.result;
    if (c) {
      c.delete();
      c.continue();
    }
  };
  await awaitTx(t);
}

// --- papers --------------------------------------------------------------
//
// A paper profile records the page-level structure of a PDF (which
// pages are questions, which are the answer key, etc.) so the
// practice picker doesn't have to ask the parent to re-enter that
// every attempt.
//
// Paper shape (see src/paper.js):
//   {
//     paper_id, title, source, built_in_id?, pdf_hash?, pdf_name?,
//     pdf_byte_length?, pdf_page_count?, question_pages, answer_pages,
//     pages: [{ page, type, confidence, reason, manually_edited }],
//     confirmed_by_user, setup_costs, updated_at,
//   }

export async function putPaper(paper) {
  if (!paper || !paper.paper_id) throw new Error('putPaper: paper.paper_id required');
  const next = { ...paper, updated_at: new Date().toISOString() };
  const t = await tx('papers', 'readwrite');
  t.objectStore('papers').put(next);
  await awaitTx(t);
  return next;
}

export async function getPaper(paperId) {
  if (!paperId) return null;
  const t = await tx('papers', 'readonly');
  return reqToPromise(t.objectStore('papers').get(paperId));
}

export async function listPapers() {
  const t = await tx('papers', 'readonly');
  return reqToPromise(t.objectStore('papers').getAll());
}

export async function deletePaper(paperId) {
  const t = await tx('papers', 'readwrite');
  t.objectStore('papers').delete(paperId);
  await awaitTx(t);
}
