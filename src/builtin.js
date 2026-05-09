// Bundled worksheets — fetched from public/worksheets/index.json at runtime.
// Keeps the catalog data-driven so adding a worksheet only needs a JSON edit
// and a PDF drop into the folder.

let catalogPromise = null;

export function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch('public/worksheets/index.json', { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load worksheets index: HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => Array.isArray(j.worksheets) ? j.worksheets : []);
  }
  return catalogPromise;
}

export async function fetchBuiltinPdf(pdfPath) {
  const r = await fetch(pdfPath, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`Failed to load worksheet PDF: HTTP ${r.status}`);
  return r.blob();
}

export function builtinAttemptId(worksheetId) {
  return `builtin:${worksheetId}`;
}
