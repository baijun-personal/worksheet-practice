// PDF.js rendering helpers. Loads a PDF from a Blob, renders pages on demand
// to canvases, and reports each page's intrinsic size in PDF points so that
// strokes stored in normalized coordinates can be redrawn at any size.

export async function loadPdfFromBlob(blob) {
  const buf = await blob.arrayBuffer();
  // window.pdfjsLib is set up by index.html
  const loadingTask = window.pdfjsLib.getDocument({ data: buf });
  return loadingTask.promise;
}

// Render a single PDF page into the given canvas at the chosen render scale.
// Returns metadata: rendered pixel size and PDF point size.
export async function renderPageToCanvas(pdf, pageNumber, canvas, { cssWidth }) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const pageWidthPts = baseViewport.width;
  const pageHeightPts = baseViewport.height;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssScale = cssWidth / pageWidthPts;
  const viewport = page.getViewport({ scale: cssScale * dpr });

  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${(pageHeightPts * cssScale).toFixed(2)}px`;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  return {
    pageWidthPts,
    pageHeightPts,
    renderedWidthPx: canvas.width,
    renderedHeightPx: canvas.height,
    cssWidth,
    cssHeight: pageHeightPts * cssScale,
    dpr,
  };
}

// Render a page off-screen to a canvas at a target DPI suitable for OpenAI
// submission. Returns the canvas and its size; caller draws strokes on top
// and exports it.
export async function renderPageOffscreen(pdf, pageNumber, dpi) {
  const page = await pdf.getPage(pageNumber);
  // PDF user-space is 72 points per inch.
  const scale = dpi / 72;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const baseViewport = page.getViewport({ scale: 1 });
  return {
    canvas,
    ctx,
    pageWidthPts: baseViewport.width,
    pageHeightPts: baseViewport.height,
    widthPx: canvas.width,
    heightPx: canvas.height,
  };
}
