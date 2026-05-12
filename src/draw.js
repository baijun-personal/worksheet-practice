// Drawing on a canvas overlay aligned to the rendered PDF page.
// Strokes are stored in PDF page coordinate space — pen as normalized
// [0,1] points plus page dimensions in PDF points; type / circle /
// tick as PDF-point coordinates anchored on the page — so they can be
// redrawn at any zoom or resolution without drift.
//
// Stage 0 introduces a tool-aware dispatcher pattern. drawStroke() and
// strokeNearPoint() each switch on stroke.tool and forward to a per-
// tool renderer / hit-tester. The pointer handler's tool branching is
// also explicit: an unknown tool does NOTHING rather than falling back
// to pen — that prevents new toolbar buttons from accidentally
// triggering pen strokes before their handler is wired up.

export const PEN_COLOR = '#1a4fc4';
export const DEFAULT_PEN_WIDTH_PT = 1.6; // in PDF points
export const ERASER_HIT_RADIUS_PT = 8;

// Type-tool defaults. Font size in PDF points so the rendered glyph
// scales correctly across zoom and across the strokes-only image's
// DPI (same convention pen widthPt uses). Picking a pixel value would
// give different visual sizes between the live canvas and the
// strokes-only composite sent to extraction.
export const DEFAULT_TYPE_FONT_SIZE_PT = 10;
// Default text-wrap width as a fraction of the page width. The
// student picks the caret position; we wrap at the page edge so
// nothing falls off the right of the canvas.
export const DEFAULT_TYPE_WRAP_FRACTION = 0.9;

// Circle / Tick defaults — both in PDF points so they scale
// correctly across zoom and the strokes-only composite's DPI.
// Sized for typical MCQ-letter circling and inline tick marks.
// 6pt radius fits cleanly around a single printed MCQ letter
// (a, b, c, d) without overlapping into neighbours.
export const DEFAULT_CIRCLE_RADIUS_PT = 6;
// Bounding-box edge length of a placed tick in PDF points.
//
// The tick path occupies only ~60-75% of this bbox (the path
// uses fractions x∈[0.15, 0.90], y∈[0.20, 0.80]), so the visible
// check mark is smaller than the bbox value. 28 pt bbox gives a
// visible mark roughly the size of the 48-image-pixel cursor
// preview's visible tick (~27 image px wide) at typical fit-zoom.
//
// Earlier values: 18 (too small to match the chunkier cursor)
// and 48 (overshot — the bbox interpretation made the placed
// tick visibly larger than the cursor previewed).
export const DEFAULT_TICK_SIZE_PT = 28;

export function makeStrokeId() {
  // crypto.randomUUID is widely supported, but fall back if missing.
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'stk_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Diagnostic: log unknown stroke tools once each so a stale persisted
// stroke from a removed tool is easy to identify.
const _warnedUnknownTools = new Set();
function warnUnknownTool(tool) {
  if (_warnedUnknownTools.has(tool)) return;
  _warnedUnknownTools.add(tool);
  console.warn(`drawStroke: unknown stroke.tool=${JSON.stringify(tool)} — rendering nothing`);
}

// Tool-aware dispatcher. Signature unchanged from pre-Stage-0 so the
// four external callers (contactSheet.js, flatten.js, review.js, and
// internal redrawAll) don't need to change. Each per-tool renderer
// owns its own coordinate-space math.
export function drawStroke(ctx, stroke, size) {
  if (!stroke) return;
  switch (stroke.tool) {
    case 'pen':    return drawPenStroke(ctx, stroke, size);
    case 'type':   return drawTypeStroke(ctx, stroke, size);
    case 'circle': return drawCircleStroke(ctx, stroke, size);
    case 'tick':   return drawTickStroke(ctx, stroke, size);
    default:
      // Defensive: if a stroke was persisted without a tool field
      // (legacy bug, future migration), treat it as a pen stroke if
      // it has a points array — that matches the pre-Stage-0
      // behaviour. Otherwise warn.
      if (Array.isArray(stroke.points) && stroke.points.length > 0) {
        return drawPenStroke(ctx, stroke, size);
      }
      warnUnknownTool(stroke.tool);
      return;
  }
}

export function redrawAll(ctx, strokes, size) {
  ctx.clearRect(0, 0, size.widthPx, size.heightPx);
  for (const s of strokes) drawStroke(ctx, s, size);
}

// --- Per-tool renderers ---------------------------------------------------

// PEN — unchanged from pre-Stage-0. Same path tracing, same width
// scaling, same single-point dot fallback. Renaming only.
function drawPenStroke(ctx, stroke, { widthPx, heightPx }) {
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

// TYPE — typed text committed to a fixed canvas position. Coordinates
// in PDF points so font + wrap width scale identically across zoom
// and across the strokes-only composite's DPI. Greedy word-wrap with
// respect to existing newlines.
function drawTypeStroke(ctx, stroke, { widthPx, heightPx }) {
  const text = String(stroke.text || '');
  if (!text) return;
  const pageWidthPts = stroke.pageWidthPts || 612;
  const scale = widthPx / pageWidthPts;
  const fontPx = (stroke.fontSizePt || DEFAULT_TYPE_FONT_SIZE_PT) * scale;
  if (fontPx <= 0) return;
  const xPx = (stroke.xPt || 0) * scale;
  const yPx = (stroke.yPt || 0) * scale;
  const wrapPx = (stroke.widthPt || pageWidthPts * DEFAULT_TYPE_WRAP_FRACTION) * scale;
  ctx.save();
  ctx.font = `${fontPx}px sans-serif`;
  ctx.fillStyle = stroke.color || PEN_COLOR;
  // textBaseline:'middle' makes the y coordinate the vertical CENTRE
  // of each line, not its top. That aligns the tap point with the
  // middle of the first character — what the student expects when
  // they "click where the text should start" — instead of having
  // the text appear below the tap as it did with baseline:'top'.
  // Subsequent wrap lines flow downward by a full line-height.
  ctx.textBaseline = 'middle';
  const lines = wrapText(ctx, text, wrapPx);
  let y = yPx;
  for (const line of lines) {
    ctx.fillText(line, xPx, y);
    y += fontPx * 1.2;
  }
  ctx.restore();
}

// Greedy word-wrap that respects explicit '\n'. Emits an empty line
// for consecutive newlines so the visible vertical spacing matches
// what the student typed.
function wrapText(ctx, text, wrapPx) {
  const out = [];
  const paragraphs = String(text).split('\n');
  for (const paragraph of paragraphs) {
    if (!paragraph) { out.push(''); continue; }
    const words = paragraph.split(/(\s+)/); // keep whitespace tokens
    let line = '';
    for (const w of words) {
      if (!w) continue;
      const candidate = line + w;
      const width = ctx.measureText(candidate).width;
      if (width <= wrapPx || !line) {
        line = candidate;
      } else {
        out.push(line.trimEnd());
        // If the token itself is wider than the wrap width, split it
        // character-by-character so it doesn't overflow.
        if (ctx.measureText(w).width > wrapPx) {
          let chunk = '';
          for (const ch of w) {
            const next = chunk + ch;
            if (ctx.measureText(next).width > wrapPx && chunk) {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk = next;
            }
          }
          line = chunk;
        } else {
          line = w.replace(/^\s+/, '');
        }
      }
    }
    if (line) out.push(line.trimEnd());
  }
  return out;
}

// CIRCLE — tap-to-place outline at (cxPt, cyPt) with fixed radius
// in PDF points so it scales identically across zoom and the
// strokes-only composite's DPI. Default radius matches a typical
// MCQ-letter glyph (~12pt).
function drawCircleStroke(ctx, stroke, { widthPx }) {
  const pageWidthPts = stroke.pageWidthPts || 612;
  const scale = widthPx / pageWidthPts;
  const cxPx = (stroke.cxPt || 0) * scale;
  const cyPx = (stroke.cyPt || 0) * scale;
  const rPx = (stroke.radiusPt || DEFAULT_CIRCLE_RADIUS_PT) * scale;
  const lwPx = (stroke.widthPt || DEFAULT_PEN_WIDTH_PT) * scale;
  ctx.save();
  ctx.strokeStyle = stroke.color || PEN_COLOR;
  ctx.lineWidth = lwPx;
  ctx.beginPath();
  ctx.arc(cxPx, cyPx, rPx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// TICK — two-segment checkmark inside a fixed bounding box anchored
// at (xPt, yPt). Path: bottom-left dip → mid-bottom corner → top-right.
function drawTickStroke(ctx, stroke, { widthPx }) {
  const pageWidthPts = stroke.pageWidthPts || 612;
  const scale = widthPx / pageWidthPts;
  const xPx = (stroke.xPt || 0) * scale;
  const yPx = (stroke.yPt || 0) * scale;
  const sPx = (stroke.sizePt || DEFAULT_TICK_SIZE_PT) * scale;
  const lwPx = (stroke.widthPt || DEFAULT_PEN_WIDTH_PT + 0.5) * scale;
  ctx.save();
  ctx.strokeStyle = stroke.color || PEN_COLOR;
  ctx.lineWidth = lwPx;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  // Standard checkmark: down-and-right into the corner, then up-and-
  // right out of it. Coordinates expressed as fractions of the bbox.
  ctx.moveTo(xPx + sPx * 0.15, yPx + sPx * 0.50);
  ctx.lineTo(xPx + sPx * 0.40, yPx + sPx * 0.80);
  ctx.lineTo(xPx + sPx * 0.90, yPx + sPx * 0.20);
  ctx.stroke();
  ctx.restore();
}

// --- Per-tool hit testers (for the eraser) --------------------------------

export function strokeNearPoint(stroke, p, rx, ry) {
  if (!stroke) return false;
  switch (stroke.tool) {
    case 'pen':    return hitTestPenStroke(stroke, p, rx, ry);
    case 'type':   return hitTestTypeStroke(stroke, p, rx, ry);
    case 'circle': return hitTestCircleStroke(stroke, p, rx, ry);
    case 'tick':   return hitTestTickStroke(stroke, p, rx, ry);
    default:
      // Pre-Stage-0 strokes without an explicit tool that have a
      // points array are pen strokes — fall through.
      if (Array.isArray(stroke.points)) return hitTestPenStroke(stroke, p, rx, ry);
      return false;
  }
}

function hitTestPenStroke(stroke, p, rx, ry) {
  if (!Array.isArray(stroke.points)) return false;
  for (const q of stroke.points) {
    const dx = (q.xNorm - p.xNorm) / rx;
    const dy = (q.yNorm - p.yNorm) / ry;
    if (dx * dx + dy * dy <= 1) return true;
  }
  return false;
}

// TYPE hit test — bounding rectangle in normalized space. The stroke
// is anchored at (xPt, yPt) with wrap width widthPt; the rendered
// height is fontSizePt * 1.2 * lineCount. We don't know lineCount
// without running the wrap helper, but we don't have a canvas
// context here — use a conservative estimate based on character
// count and average glyph width. That's the same coarse bbox the
// eraser used pre-Stage-0 for the (then-absent) type tool.
function hitTestTypeStroke(stroke, p, rx, ry) {
  const pageWidthPts = stroke.pageWidthPts || 612;
  const pageHeightPts = stroke.pageHeightPts || 792;
  const xNorm = (stroke.xPt || 0) / pageWidthPts;
  const yNorm = (stroke.yPt || 0) / pageHeightPts;
  const wNorm = (stroke.widthPt || pageWidthPts * DEFAULT_TYPE_WRAP_FRACTION) / pageWidthPts;
  // Estimate line count: 1 line for short text, more for long text.
  const text = String(stroke.text || '');
  const charsPerLine = Math.max(8, Math.floor((stroke.widthPt || pageWidthPts * DEFAULT_TYPE_WRAP_FRACTION) / ((stroke.fontSizePt || DEFAULT_TYPE_FONT_SIZE_PT) * 0.55)));
  const newlineCount = (text.match(/\n/g) || []).length;
  const lineCount = Math.max(1, newlineCount + Math.ceil(text.length / charsPerLine));
  const lineHeightPt = (stroke.fontSizePt || DEFAULT_TYPE_FONT_SIZE_PT) * 1.2;
  const hNorm = (lineCount * lineHeightPt) / pageHeightPts;
  // Tolerance ≈ one eraser hit radius in each direction.
  return (
    p.xNorm >= xNorm - rx &&
    p.xNorm <= xNorm + wNorm + rx &&
    p.yNorm >= yNorm - ry &&
    p.yNorm <= yNorm + hNorm + ry
  );
}

// CIRCLE hit test — hit anywhere within (radius + eraser tolerance)
// of the centre. We work in PDF points end-to-end so a single
// distance comparison covers both dimensions cleanly (avoiding the
// rx/ry-stretched-ellipse math the pen hit-test uses).
function hitTestCircleStroke(stroke, p, _rx, _ry) {
  const pageWidthPts = stroke.pageWidthPts || 612;
  const pageHeightPts = stroke.pageHeightPts || 792;
  const pXPt = p.xNorm * pageWidthPts;
  const pYPt = p.yNorm * pageHeightPts;
  const dxPt = pXPt - (stroke.cxPt || 0);
  const dyPt = pYPt - (stroke.cyPt || 0);
  const dPt = Math.sqrt(dxPt * dxPt + dyPt * dyPt);
  return dPt <= (stroke.radiusPt || DEFAULT_CIRCLE_RADIUS_PT) + ERASER_HIT_RADIUS_PT;
}

// TICK hit test — bbox extended by the eraser tolerance. PDF-point
// coordinates throughout.
function hitTestTickStroke(stroke, p, _rx, _ry) {
  const pageWidthPts = stroke.pageWidthPts || 612;
  const pageHeightPts = stroke.pageHeightPts || 792;
  const pXPt = p.xNorm * pageWidthPts;
  const pYPt = p.yNorm * pageHeightPts;
  const xPt = stroke.xPt || 0;
  const yPt = stroke.yPt || 0;
  const sPt = stroke.sizePt || DEFAULT_TICK_SIZE_PT;
  return (
    pXPt >= xPt - ERASER_HIT_RADIUS_PT &&
    pXPt <= xPt + sPt + ERASER_HIT_RADIUS_PT &&
    pYPt >= yPt - ERASER_HIT_RADIUS_PT &&
    pYPt <= yPt + sPt + ERASER_HIT_RADIUS_PT
  );
}

// --- Pointer / input controller -------------------------------------------

// Setup pointer capture on the ink canvas. Calls back into the controller
// for every stroke completion, undo, eraser hit, etc.
//
// Tool model after Stage 0:
//   - 'pen'    — drag to draw, classic path stroke.
//   - 'eraser' — tap or drag over existing strokes to remove them.
//   - 'type'   — tap places a caret; on-screen / hardware keyboard
//                fills a textarea; the typed text rasterises as a
//                single tool:'type' stroke on commit.
//   - 'circle' — STAGE 2: tap places a fixed-radius outline.
//   - 'tick'   — STAGE 2: tap places a fixed-size checkmark.
//   - any other value — no-op. Unknown tools must NOT fall back to
//     pen, otherwise a new toolbar button starts pen strokes before
//     its handler is wired up.
//
// Inputs:
//   inkCanvas           — the overlay canvas
//   typeInput           — hidden <textarea> used to capture text on tablet
//   typeOverlay         — <div> showing in-progress text + blinking caret
//   pageWrap            — the page-wrap element used as the coordinate
//                         origin for positioning typeOverlay / typeInput
//   getPageMeta         — () => { pageWidthPts, pageHeightPts, widthPx, heightPx }
//   getCurrentPage      — () => pageNumber
//   getStrokes          — async () => Stroke[] (current page)
//   getTool             — () => "pen" | "eraser" | "type" | ...
//   onStrokeAdded       — async (stroke) => void
//   onStrokeRemoved     — async (strokeId) => void
export function attachInkController({
  inkCanvas,
  typeInput,
  typeOverlay,
  pageWrap,
  calcDragRect,        // <div> element drawn during calc-tool drag
  getPageMeta,
  getCurrentPage,
  getStrokes,
  getTool,
  onStrokeAdded,
  onStrokeRemoved,
  onCalcSelect,        // async (rectPt) => void — called on calc drag end
}) {
  // Match canvas backing-store size to its CSS size on each redraw.
  // willReadFrequently: true — the ink canvas is rebuilt on every
  // page redraw (clearRect + replay all strokes), and Chrome/Edge
  // log a "Multiple readback operations using getImageData are
  // faster with the willReadFrequently attribute set to true"
  // warning otherwise. Harmless on contexts that don't actually
  // read; a useful hint to the browser for the ones that do.
  const ctx = inkCanvas.getContext('2d', { willReadFrequently: true });

  let drawing = false;
  let activePointerId = null;
  let currentPoints = null;
  let currentStroke = null;
  // Eraser: prevent overlapping erase operations. pointermove can fire
  // every few ms; eraseAt awaits IndexedDB. Without a flag, two
  // concurrent calls can read the same stroke list and both pick the
  // same stroke (one becomes a no-op delete). The flag also keeps the
  // canvas redraw (triggered inside onStrokeRemoved) coherent — the
  // next erase event won't queue until the previous one's UI repaint
  // has completed.
  let erasing = false;

  // Calculator drag state — see startCalcDrag / extendCalcDrag /
  // finishCalcDrag. The drag rectangle is a DOM element, not a
  // stroke — it's purely a visual overlay, never persisted, and
  // never appears in the strokes-only image sent to extraction.
  let calcDragging = false;
  let calcPointerId = null;
  let calcStartNorm = null; // { xNorm, yNorm } at pointerdown

  // Type tool state — see startTyping / commitTyping below.
  // typing.active=false means no caret visible; the textarea is
  // unfocused.
  const typing = {
    active: false,
    xNorm: 0,
    yNorm: 0,
    page: 0,
    text: '',
  };

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

  // --- Pen branch (unchanged from pre-Stage-0) ---

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
      await commitStroke(stroke);
    } else {
      currentStroke = null;
      currentPoints = null;
    }
  }

  // --- Eraser branch (unchanged from pre-Stage-0) ---

  async function eraseAt(ev) {
    if (erasing) return;
    erasing = true;
    try {
      const meta = getPageMeta();
      if (!meta) return;
      const p = localPoint(ev);
      const strokes = await getStrokes();
      const hitRadiusNormX = ERASER_HIT_RADIUS_PT / meta.pageWidthPts;
      const hitRadiusNormY = ERASER_HIT_RADIUS_PT / meta.pageHeightPts;
      let hit = null;
      // Find the most recent stroke whose path passes near the pointer.
      for (let i = strokes.length - 1; i >= 0; i--) {
        const s = strokes[i];
        if (strokeNearPoint(s, p, hitRadiusNormX, hitRadiusNormY)) { hit = s; break; }
      }
      if (hit) await onStrokeRemoved(hit.id);
    } finally {
      erasing = false;
    }
  }

  // --- Circle / Tick branch (Stage 2) ---

  // Tap-to-place: build a single stroke at the tap location and commit.
  // Both tools are stateless — no drag, no in-progress preview — so
  // the entire lifecycle is "tap → push stroke → draw on next redraw".
  // Undo and Eraser work automatically because the stroke lives in the
  // same per-page strokes array as pen/type.
  function placeCircle(ev) {
    const meta = getPageMeta();
    if (!meta) return;
    const p = localPoint(ev);
    const stroke = {
      id: makeStrokeId(),
      attemptId: null,
      pageNumber: getCurrentPage(),
      tool: 'circle',
      color: PEN_COLOR,
      cxPt: p.xNorm * meta.pageWidthPts,
      cyPt: p.yNorm * meta.pageHeightPts,
      radiusPt: DEFAULT_CIRCLE_RADIUS_PT,
      widthPt: DEFAULT_PEN_WIDTH_PT,
      pageWidthPts: meta.pageWidthPts,
      pageHeightPts: meta.pageHeightPts,
      createdAt: Date.now(),
    };
    commitStroke(stroke).catch((e) => console.error('placeCircle commit failed', e));
  }

  function placeTick(ev) {
    const meta = getPageMeta();
    if (!meta) return;
    const p = localPoint(ev);
    const sizePt = DEFAULT_TICK_SIZE_PT;
    const stroke = {
      id: makeStrokeId(),
      attemptId: null,
      pageNumber: getCurrentPage(),
      tool: 'tick',
      color: PEN_COLOR,
      // Centre the bbox on the tap so the visible tick lands where the
      // student aimed, not below-and-to-the-right of the tap.
      xPt: p.xNorm * meta.pageWidthPts - sizePt / 2,
      yPt: p.yNorm * meta.pageHeightPts - sizePt / 2,
      sizePt,
      widthPt: DEFAULT_PEN_WIDTH_PT + 0.5,
      pageWidthPts: meta.pageWidthPts,
      pageHeightPts: meta.pageHeightPts,
      createdAt: Date.now(),
    };
    commitStroke(stroke).catch((e) => console.error('placeTick commit failed', e));
  }

  // --- Calculator drag (Stage 4) ---
  //
  // Drag-rectangle on the canvas. Caller-supplied onCalcSelect
  // (passed into attachInkController) is fired with a PDF-point
  // rectangle on pointerup. The drag rectangle is a DOM overlay
  // (calcDragRect element) — pure visual, never persisted, never
  // appears in extraction images. Calc work is committed via
  // attempt.calc_popups + attempt.calc_usage on the main.js side.

  function startCalcDrag(ev) {
    const meta = getPageMeta();
    if (!meta) return;
    calcDragging = true;
    calcPointerId = ev.pointerId;
    try { inkCanvas.setPointerCapture(ev.pointerId); } catch {}
    const p = localPoint(ev);
    calcStartNorm = { xNorm: p.xNorm, yNorm: p.yNorm };
    updateCalcDragRect(p, p);
  }

  function extendCalcDrag(ev) {
    if (!calcDragging) return;
    const p = localPoint(ev);
    updateCalcDragRect(calcStartNorm, p);
  }

  async function finishCalcDrag(ev) {
    if (!calcDragging) return;
    const start = calcStartNorm;
    calcDragging = false;
    calcPointerId = null;
    calcStartNorm = null;
    if (calcDragRect) calcDragRect.hidden = true;
    if (!start) return;
    const meta = getPageMeta();
    if (!meta) return;
    const end = localPoint(ev);
    // Convert the two normalized corners to a PDF-point rectangle.
    const x0 = Math.min(start.xNorm, end.xNorm) * meta.pageWidthPts;
    const y0 = Math.min(start.yNorm, end.yNorm) * meta.pageHeightPts;
    const x1 = Math.max(start.xNorm, end.xNorm) * meta.pageWidthPts;
    const y1 = Math.max(start.yNorm, end.yNorm) * meta.pageHeightPts;
    const rectPt = {
      xPt: x0,
      yPt: y0,
      widthPt: x1 - x0,
      heightPt: y1 - y0,
      pageWidthPts: meta.pageWidthPts,
      pageHeightPts: meta.pageHeightPts,
    };
    if (typeof onCalcSelect === 'function') {
      try { await onCalcSelect(rectPt); }
      catch (e) { console.error('onCalcSelect failed', e); }
    }
  }

  function updateCalcDragRect(a, b) {
    if (!calcDragRect || !pageWrap) return;
    const rect = pageWrap.getBoundingClientRect();
    const x0 = Math.min(a.xNorm, b.xNorm) * rect.width;
    const y0 = Math.min(a.yNorm, b.yNorm) * rect.height;
    const x1 = Math.max(a.xNorm, b.xNorm) * rect.width;
    const y1 = Math.max(a.yNorm, b.yNorm) * rect.height;
    calcDragRect.style.left = `${x0}px`;
    calcDragRect.style.top = `${y0}px`;
    calcDragRect.style.width = `${x1 - x0}px`;
    calcDragRect.style.height = `${y1 - y0}px`;
    calcDragRect.hidden = false;
  }

  // --- Type branch (Stage 1) ---

  // Show the overlay + textarea at the tapped position. The textarea
  // is the focus target for the OS keyboard; the overlay shows the
  // live in-progress text and a blinking caret. Both are positioned
  // in pageWrap-local CSS pixels (= canvas CSS pixels).
  function startTyping(ev) {
    if (!typeOverlay || !typeInput || !pageWrap) return;
    const meta = getPageMeta();
    if (!meta) return;
    // If we were already typing, commit before re-anchoring.
    if (typing.active) {
      commitTyping();
    }
    const p = localPoint(ev);
    typing.active = true;
    typing.xNorm = p.xNorm;
    typing.yNorm = p.yNorm;
    typing.page = getCurrentPage();
    typing.text = '';
    // Position the overlay in pageWrap-local CSS pixels.
    const wrapRect = pageWrap.getBoundingClientRect();
    const cssX = ev.clientX - wrapRect.left;
    const cssY = ev.clientY - wrapRect.top;
    // Render the overlay font in CSS px matching what drawTypeStroke
    // will use when this commits. canvas CSS width is wrapRect.width.
    const cssFontPx = (DEFAULT_TYPE_FONT_SIZE_PT / meta.pageWidthPts) * wrapRect.width;
    // Wrap distance for the live overlay = page-width-from-caret
    // minus a small right gutter, clamped to a 10% minimum. This
    // mirrors commitTyping's widthPt math exactly so what the user
    // sees while typing matches the committed stroke — no visible
    // jump at commit time when typing in the right half of the page.
    const rightGutterCss = wrapRect.width * 0.03;
    const minWrapCss = wrapRect.width * 0.10;
    const overlayWrapCss = Math.max(minWrapCss, wrapRect.width - cssX - rightGutterCss);
    typeOverlay.style.left = `${cssX}px`;
    typeOverlay.style.top = `${cssY}px`;
    typeOverlay.style.maxWidth = `${overlayWrapCss}px`;
    typeOverlay.style.fontSize = `${cssFontPx}px`;
    typeOverlay.hidden = false;
    renderTypeOverlay();
    // Position + focus the hidden textarea so iPad's keyboard
    // anchors near the tap location.
    typeInput.style.left = `${cssX}px`;
    typeInput.style.top = `${cssY}px`;
    typeInput.value = '';
    // Defer focus to the next tick — iOS Safari requires the focus
    // to happen inside the user-tap synchronously, but moving the
    // element first is more reliable across browsers.
    try { typeInput.focus({ preventScroll: true }); } catch { typeInput.focus(); }
  }

  function renderTypeOverlay() {
    if (!typeOverlay) return;
    // Two child spans — text then caret — created lazily.
    if (!typeOverlay.firstChild) {
      typeOverlay.innerHTML = '<span class="type-overlay-text"></span><span class="type-caret"></span>';
    }
    const textSpan = typeOverlay.querySelector('.type-overlay-text');
    if (textSpan) {
      // Preserve newlines visually: render newlines as <br>.
      textSpan.innerHTML = escapeForOverlay(typing.text).replace(/\n/g, '<br>');
    }
  }

  function escapeForOverlay(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Commit the in-progress text as a tool:'type' stroke. Idempotent —
  // safe to call when typing is inactive or text is empty. Returns a
  // Promise that resolves AFTER the underlying IndexedDB write
  // completes, so call sites that immediately read strokes (submit,
  // mark, page navigation) can `await` and avoid the
  // typed-text-not-yet-persisted race.
  function commitTyping() {
    if (!typing.active) return Promise.resolve();
    const text = String(typing.text || '');
    const meta = getPageMeta();
    typing.active = false;
    if (typeOverlay) typeOverlay.hidden = true;
    if (typeInput) {
      typeInput.value = '';
      try { typeInput.blur(); } catch {}
    }
    if (!text.trim() || !meta) {
      typing.text = '';
      return Promise.resolve();
    }
    // Wrap width = distance from caret to the right page edge,
    // minus a small right gutter so text doesn't run flush against
    // the edge. Clamp to a sensible minimum so a tap at the far
    // right still has a few characters of wrap room.
    const xPt = typing.xNorm * meta.pageWidthPts;
    const rightGutterPt = meta.pageWidthPts * 0.03;
    const minWrapPt = meta.pageWidthPts * 0.1;
    const widthPt = Math.max(minWrapPt, meta.pageWidthPts - xPt - rightGutterPt);
    const stroke = {
      id: makeStrokeId(),
      attemptId: null, // filled in by controller before save
      pageNumber: typing.page || getCurrentPage(),
      tool: 'type',
      color: PEN_COLOR,
      text,
      xPt,
      yPt: typing.yNorm * meta.pageHeightPts,
      widthPt,
      fontSizePt: DEFAULT_TYPE_FONT_SIZE_PT,
      pageWidthPts: meta.pageWidthPts,
      pageHeightPts: meta.pageHeightPts,
      createdAt: Date.now(),
    };
    typing.text = '';
    // Return the underlying commit promise so callers that need the
    // stroke to land before reading it (submit / mark / page nav)
    // can `await`. Callers that don't care (tool change, blur) can
    // simply not await — the promise still resolves and any error
    // is logged via the .catch fallback.
    return commitStroke(stroke).catch((e) => {
      console.error('commitTyping commit failed', e);
    });
  }

  function onTypeInput() {
    if (!typing.active) return;
    typing.text = typeInput ? typeInput.value : '';
    renderTypeOverlay();
  }

  function onTypeBlur() {
    // If the blur is because the user tapped somewhere on the canvas
    // to relocate the caret, the canvas pointerdown handler will call
    // startTyping which commits first. If the blur is because the
    // keyboard was dismissed or the user tapped outside the canvas,
    // commit now.
    if (typing.active) {
      commitTyping();
    }
  }

  // --- Pointer dispatcher ---

  function onPointerDown(ev) {
    // Only primary pointer; ignore secondary (e.g. second finger) so
    // two-finger gestures pass through to the page-stage scroll layer.
    if (!ev.isPrimary) return;
    const tool = getTool();
    if (tool === 'eraser') {
      ev.preventDefault();
      // .catch so IndexedDB errors aren't swallowed silently.
      eraseAt(ev).catch((e) => console.error('eraseAt failed', e));
    } else if (tool === 'pen') {
      ev.preventDefault();
      startPenStroke(ev);
    } else if (tool === 'type') {
      ev.preventDefault();
      startTyping(ev);
    } else if (tool === 'circle') {
      ev.preventDefault();
      placeCircle(ev);
    } else if (tool === 'tick') {
      ev.preventDefault();
      placeTick(ev);
    } else if (tool === 'calc') {
      ev.preventDefault();
      startCalcDrag(ev);
    } else {
      // Unknown tool — silent no-op. Better than starting a pen
      // stroke for an unrecognised toolbar button.
    }
  }
  function onPointerMove(ev) {
    const tool = getTool();
    if (tool === 'eraser' && ev.buttons > 0 && ev.isPrimary) {
      eraseAt(ev).catch((e) => console.error('eraseAt failed', e));
      return;
    }
    if (tool === 'pen' && drawing && ev.pointerId === activePointerId) {
      ev.preventDefault();
      extendPenStroke(ev);
    }
    if (tool === 'calc' && calcDragging && ev.pointerId === calcPointerId) {
      ev.preventDefault();
      extendCalcDrag(ev);
    }
  }
  function onPointerUp(ev) {
    if (drawing && ev.pointerId === activePointerId) {
      ev.preventDefault();
      finishPenStroke(ev);
    }
    if (calcDragging && ev.pointerId === calcPointerId) {
      ev.preventDefault();
      finishCalcDrag(ev);
    }
  }

  inkCanvas.addEventListener('pointerdown', onPointerDown);
  inkCanvas.addEventListener('pointermove', onPointerMove);
  inkCanvas.addEventListener('pointerup', onPointerUp);
  inkCanvas.addEventListener('pointercancel', onPointerUp);
  inkCanvas.addEventListener('pointerleave', onPointerUp);
  if (typeInput) {
    typeInput.addEventListener('input', onTypeInput);
    typeInput.addEventListener('blur', onTypeBlur);
  }

  // Helper used by both the pen finish handler and the type-commit
  // path. Centralised so additional bookkeeping (e.g. analytics) can
  // be added in one place.
  async function commitStroke(stroke) {
    // Snapshot the page + meta BEFORE awaiting the persistence call —
    // if the user navigates while the IndexedDB write is in flight, we
    // must not paint a stale stroke onto a different page's canvas.
    const pageAtCommit = stroke.pageNumber;
    const metaAtCommit = getPageMeta();
    await onStrokeAdded(stroke);
    // Repaint the just-committed stroke onto the ink canvas. Pen
    // strokes already drew themselves incrementally during the
    // pointer-move phase, so this call re-traces a path that's
    // already visible — harmless. Type / Circle / Tick strokes have
    // no incremental phase (Type used a DOM overlay that was hidden
    // before this call; Circle / Tick are instant tap-to-place), so
    // this is where their mark first appears on the canvas. Without
    // it, the overlay hides and the canvas stays blank until the
    // next page load (e.g. tab away and back) — which was the
    // "typed text disappears" bug.
    if (metaAtCommit && getCurrentPage() === pageAtCommit) {
      drawStroke(ctx, stroke, {
        widthPx: metaAtCommit.widthPx,
        heightPx: metaAtCommit.heightPx,
      });
    }
  }

  return {
    detach() {
      inkCanvas.removeEventListener('pointerdown', onPointerDown);
      inkCanvas.removeEventListener('pointermove', onPointerMove);
      inkCanvas.removeEventListener('pointerup', onPointerUp);
      inkCanvas.removeEventListener('pointercancel', onPointerUp);
      inkCanvas.removeEventListener('pointerleave', onPointerUp);
      if (typeInput) {
        typeInput.removeEventListener('input', onTypeInput);
        typeInput.removeEventListener('blur', onTypeBlur);
      }
    },
    // Exposed so main.js can flush typed text before submitting, before
    // navigating to a new page, etc. Safe to call when typing is
    // inactive (no-op).
    commitTyping,
  };
}
