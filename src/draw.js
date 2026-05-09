// Drawing on a canvas overlay aligned to the rendered PDF page.
// Strokes are stored in PDF page coordinate space as normalized [0,1] points
// plus the page dimensions in PDF points, so they can be redrawn at any zoom
// or resolution without drift.

export const PEN_COLOR = '#1a4fc4';
export const DEFAULT_PEN_WIDTH_PT = 1.6; // in PDF points
export const ERASER_HIT_RADIUS_PT = 8;

export function makeStrokeId() {
  // crypto.randomUUID is widely supported, but fall back if missing.
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'stk_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Draw a single stroke onto a canvas, mapping normalized coordinates to the
// canvas's pixel size. `lineWidthPx` is the rendered width.
export function drawStroke(ctx, stroke, { widthPx, heightPx }) {
  const points = stroke.points;
  if (!points || points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = stroke.color || PEN_COLOR;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Scale stroke width: stroke.width is in PDF points; convert to px.
  const ptToPx = widthPx / stroke.pageWidthPts;
  const baseWidth = (stroke.width || DEFAULT_PEN_WIDTH_PT) * ptToPx;

  if (points.length === 1) {
    const p = points[0];
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(p.xNorm * widthPx, p.yNorm * heightPx, baseWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const w = baseWidth * (0.5 + 0.5 * (a.pressure || 0.5));
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(a.xNorm * widthPx, a.yNorm * heightPx);
    ctx.lineTo(b.xNorm * widthPx, b.yNorm * heightPx);
    ctx.stroke();
  }
  ctx.restore();
}

export function redrawAll(ctx, strokes, size) {
  ctx.clearRect(0, 0, size.widthPx, size.heightPx);
  for (const s of strokes) drawStroke(ctx, s, size);
}

// Setup pointer capture on the ink canvas. Calls back into the controller
// for every stroke completion, undo, eraser hit, etc.
export function attachInkController({
  inkCanvas,
  getPageMeta,           // () => { pageWidthPts, pageHeightPts, widthPx, heightPx }
  getCurrentPage,        // () => pageNumber
  getStrokes,            // async () => Stroke[] (current page)
  getTool,               // () => "pen" | "eraser"
  onStrokeAdded,         // async (stroke) => void
  onStrokeRemoved,       // async (strokeId) => void
  onRedrawRequested,     // () => Promise<void>
}) {
  // Match canvas backing-store size to its CSS size on each redraw.
  const ctx = inkCanvas.getContext('2d');

  let drawing = false;
  let activePointerId = null;
  let currentPoints = null;
  let currentStroke = null;

  function localPoint(ev) {
    const rect = inkCanvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) / rect.width;
    const y = (ev.clientY - rect.top) / rect.height;
    return {
      xNorm: clamp01(x),
      yNorm: clamp01(y),
      pressure: ev.pressure > 0 ? ev.pressure : 0.5,
      t: Date.now(),
    };
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function startPenStroke(ev) {
    const meta = getPageMeta();
    if (!meta) return;
    drawing = true;
    activePointerId = ev.pointerId;
    inkCanvas.setPointerCapture(ev.pointerId);
    const p = localPoint(ev);
    currentPoints = [p];
    currentStroke = {
      id: makeStrokeId(),
      attemptId: null, // filled in by controller before save
      pageNumber: getCurrentPage(),
      tool: 'pen',
      color: PEN_COLOR,
      width: DEFAULT_PEN_WIDTH_PT,
      pageWidthPts: meta.pageWidthPts,
      pageHeightPts: meta.pageHeightPts,
      points: currentPoints,
      createdAt: Date.now(),
    };
    drawDot(p, meta);
  }

  function drawDot(p, size) {
    ctx.save();
    ctx.fillStyle = PEN_COLOR;
    const ptToPx = size.widthPx / size.pageWidthPts;
    const r = (DEFAULT_PEN_WIDTH_PT * ptToPx) / 2;
    ctx.beginPath();
    ctx.arc(p.xNorm * size.widthPx, p.yNorm * size.heightPx, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function extendPenStroke(ev) {
    if (!drawing || ev.pointerId !== activePointerId) return;
    const meta = getPageMeta();
    if (!meta) return;
    const p = localPoint(ev);
    const prev = currentPoints[currentPoints.length - 1];
    currentPoints.push(p);
    ctx.save();
    ctx.strokeStyle = PEN_COLOR;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const ptToPx = meta.widthPx / meta.pageWidthPts;
    const w = DEFAULT_PEN_WIDTH_PT * ptToPx * (0.5 + 0.5 * (p.pressure || 0.5));
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(prev.xNorm * meta.widthPx, prev.yNorm * meta.heightPx);
    ctx.lineTo(p.xNorm * meta.widthPx, p.yNorm * meta.heightPx);
    ctx.stroke();
    ctx.restore();
  }

  async function finishPenStroke(ev) {
    if (!drawing || ev.pointerId !== activePointerId) return;
    drawing = false;
    activePointerId = null;
    if (currentStroke && currentStroke.points.length > 0) {
      const stroke = currentStroke;
      currentStroke = null;
      currentPoints = null;
      await onStrokeAdded(stroke);
    } else {
      currentStroke = null;
      currentPoints = null;
    }
  }

  async function eraseAt(ev) {
    const meta = getPageMeta();
    if (!meta) return;
    const p = localPoint(ev);
    const strokes = await getStrokes();
    const hitRadiusNormX = ERASER_HIT_RADIUS_PT / meta.pageWidthPts;
    const hitRadiusNormY = ERASER_HIT_RADIUS_PT / meta.pageHeightPts;
    let hit = null;
    // Find the most recent stroke whose path passes near the pointer
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      if (strokeNearPoint(s, p, hitRadiusNormX, hitRadiusNormY)) { hit = s; break; }
    }
    if (hit) await onStrokeRemoved(hit.id);
  }

  function strokeNearPoint(stroke, p, rx, ry) {
    for (const q of stroke.points) {
      const dx = (q.xNorm - p.xNorm) / rx;
      const dy = (q.yNorm - p.yNorm) / ry;
      if (dx * dx + dy * dy <= 1) return true;
    }
    return false;
  }

  function onPointerDown(ev) {
    // Only primary pointer; ignore secondary (e.g. second finger) so
    // two-finger gestures pass through to the page-stage scroll layer.
    if (!ev.isPrimary) return;
    if (getTool() === 'eraser') {
      ev.preventDefault();
      eraseAt(ev);
    } else {
      ev.preventDefault();
      startPenStroke(ev);
    }
  }
  function onPointerMove(ev) {
    if (getTool() === 'eraser' && ev.buttons > 0 && ev.isPrimary) {
      eraseAt(ev);
      return;
    }
    if (drawing && ev.pointerId === activePointerId) {
      ev.preventDefault();
      extendPenStroke(ev);
    }
  }
  function onPointerUp(ev) {
    if (drawing && ev.pointerId === activePointerId) {
      ev.preventDefault();
      finishPenStroke(ev);
    }
  }

  inkCanvas.addEventListener('pointerdown', onPointerDown);
  inkCanvas.addEventListener('pointermove', onPointerMove);
  inkCanvas.addEventListener('pointerup', onPointerUp);
  inkCanvas.addEventListener('pointercancel', onPointerUp);
  inkCanvas.addEventListener('pointerleave', onPointerUp);

  return {
    detach() {
      inkCanvas.removeEventListener('pointerdown', onPointerDown);
      inkCanvas.removeEventListener('pointermove', onPointerMove);
      inkCanvas.removeEventListener('pointerup', onPointerUp);
      inkCanvas.removeEventListener('pointercancel', onPointerUp);
      inkCanvas.removeEventListener('pointerleave', onPointerUp);
    },
  };
}
