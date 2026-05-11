// Render a PDF page at submission DPI and draw saved strokes on top.
// Returns a JPEG data URL ready to send to OpenAI as image_url.

import { renderPageOffscreen } from './pdfRender.js';
import { drawStroke } from './draw.js';

export async function flattenQuestionPage(pdf, pageNumber, strokes, dpi) {
  const r = await renderPageOffscreen(pdf, pageNumber, dpi);
  const size = {
    pageWidthPts: r.pageWidthPts,
    pageHeightPts: r.pageHeightPts,
    widthPx: r.widthPx,
    heightPx: r.heightPx,
  };
  for (const s of strokes) drawStroke(r.ctx, s, size);
  return r.canvas.toDataURL('image/jpeg', 0.85);
}

export async function renderAnswerPage(pdf, pageNumber, dpi) {
  const r = await renderPageOffscreen(pdf, pageNumber, dpi);
  return r.canvas.toDataURL('image/jpeg', 0.85);
}

// Render ONLY the student's strokes on a white canvas at the same
// dimensions as the rendered PDF page. Used by the extraction call
// alongside the printed-page image: the model uses the printed
// image for question structure, this one to see what was actually
// written. Removes the "printed option letter mis-read as
// handwriting" failure mode that affected MCQ rows with no
// selection (Q5 on the English Mock: model returned
// answer:"a"/confidence 0.98 by reading the printed option label,
// even though the slot was empty).
//
// Same DPI / same pixel dimensions / same coordinate system as
// flattenQuestionPage so the model can align this image against
// the printed-page image at identical positions.
export async function renderStrokesOnlyPage(pdf, pageNumber, strokes, dpi) {
  const r = await renderPageOffscreen(pdf, pageNumber, dpi);
  // renderPageOffscreen returns a canvas with the PDF already
  // painted on it. Overpaint with white to drop the printed
  // content before drawing strokes. The few ms of wasted page
  // render is negligible vs the API call latency this image
  // will join.
  r.ctx.fillStyle = 'white';
  r.ctx.fillRect(0, 0, r.canvas.width, r.canvas.height);
  const size = {
    pageWidthPts: r.pageWidthPts,
    pageHeightPts: r.pageHeightPts,
    widthPx: r.widthPx,
    heightPx: r.heightPx,
  };
  for (const s of (strokes || [])) drawStroke(r.ctx, s, size);
  return r.canvas.toDataURL('image/jpeg', 0.85);
}

// Quick black-and-white check: render a small thumbnail and sample pixels.
// Returns ratio of pixels that are clearly chromatic (not grayscale).
export async function colorContentRatio(pdf, sampleSize = 200) {
  const numPages = pdf.numPages;
  const pagesToCheck = [1];
  if (numPages >= 3) pagesToCheck.push(Math.ceil(numPages / 2));
  let totalSamples = 0;
  let chromaticSamples = 0;
  for (const pageNumber of pagesToCheck) {
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = sampleSize / baseViewport.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    // willReadFrequently: true — this context exists solely to be
    // read back via getImageData below. Without the flag, the
    // browser logs a "readback faster with willReadFrequently"
    // warning every time colorContentRatio runs.
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      // chroma threshold: separation between RGB channels > 24 = colored pixel
      if (max - min > 24) chromaticSamples++;
      totalSamples++;
    }
  }
  return totalSamples ? chromaticSamples / totalSamples : 0;
}
