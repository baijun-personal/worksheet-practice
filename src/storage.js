// IndexedDB wrapper.
// One DB with two stores:
//   attempts: { id, createdAt, pdfName, pdfBlob, subject, level,
//               questionPages, answerPages, currentPage, reportJson, settings, status }
//   strokes:  keyed by [attemptId, strokeId], indexed by [attemptId, pageNumber]
//
// Strokes are stored separately so writing one stroke doesn't rewrite the
// whole attempt blob (which embeds the source PDF).

const DB_NAME = 'worksheet-marker';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('attempts')) {
        db.createObjectStore('attempts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('strokes')) {
        const s = db.createObjectStore('strokes', { keyPath: ['attemptId', 'id'] });
        s.createIndex('byAttemptPage', ['attemptId', 'pageNumber']);
        s.createIndex('byAttempt', 'attemptId');
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
