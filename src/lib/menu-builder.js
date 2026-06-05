'use strict';
/**
 * menu-builder.js — Tier 2 interactive menu generator for BD-ROM discs.
 *
 * Generates an N-button IG display set for use as a disc menu (2–9 episodes).
 * Buttons are centered vertically and horizontally on the 1920×1080 frame.
 * The display set is injected into a solid-color background video m2ts.
 *
 * Architecture:
 *   buildMenuDisplaySet(options) → Buffer (TS-packetized IG PES stream)
 *     → renderButtonBitmap(text,state) or renderButtonPixels(state)
 *     → ig-encoder.buildIGDisplaySet() assembles the full BD IG display set
 *
 * Button text is rendered in-process with the `canvas` package (node-canvas):
 * the label is drawn onto an off-screen canvas with the bundled MenuFont, the
 * raw pixels are read back via getImageData(), and each pixel is quantized to
 * the nearest palette entry. renderButtonPixels() (solid color blocks, no text)
 * remains the true fallback if the canvas module fails to load.
 *
 * Palette (all entries opaque, T=255):
 *   0 = background near-black (opaque; unused by the button bitmaps)
 *   1 = white (text + border)
 *   2 = orange      — NORMAL button fill   (YCbCr → RGB ≈ 201,100,0)
 *   3 = dark slate blue — SELECTED button fill (YCbCr → RGB ≈ 0,37,120)
 *
 * Button layout (auto-centered, 800×90 each, 30px gap):
 *   Button i → obj_id 2i (normal) + 2i+1 (selected); Episode i+1 → PLAY_PL(i+1).
 *   No WDS (the IG render path ignores it; matches Toast/S11).
 */

const path = require('path');
const fs   = require('fs');
const { execFileSync } = require('child_process');

// node-canvas is loaded lazily so that a missing/broken native build degrades
// to the solid-fill fallback (renderButtonPixels) instead of crashing the app.
let _canvasLib;        // undefined = not tried, null = load failed, object = loaded
const _registeredFonts = new Set();  // fontPath → registered once with registerFont
function _getCanvas() {
  if (_canvasLib !== undefined) return _canvasLib;
  try {
    _canvasLib = require('canvas');
  } catch {
    _canvasLib = null;
  }
  return _canvasLib;
}

const { buildNavCmd, buildIGDisplaySet, encodePDS, encodeODS, encodeWDS, encodeICS, encodeEND, encodeRLE, wrapInPES, buildSegment, SEG } = require('./ig-encoder');
const { defaultTemplate, resolveFontPath } = require('./template');

// ── Button shape geometry ───────────────────────────────────────────────────────
// Compute the corner radius for a button shape. 'pill' rounds to a full half-pill;
// 'rounded' uses cornerRadius (default 16) clamped to half the shorter side; any
// other value ('rect' or undefined) returns 0 (a true rectangle).
function _shapeRadius(shape, w, h, cornerRadius) {
  if (shape === 'pill')    return Math.min(h / 2, w / 2);
  if (shape === 'rounded') return Math.max(0, Math.min(cornerRadius || 16, Math.min(w, h) / 2));
  return 0;
}

// Trace a button outline (rounded-rect / pill / rect) as the current canvas path.
function _buttonShapePath(ctx, x, y, w, h, shape, cornerRadius) {
  const r = _shapeRadius(shape, w, h, cornerRadius);
  ctx.beginPath();
  if (r === 0) { ctx.rect(x, y, w, h); return; }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Fill a button shape. For 'rect' (radius 0) this is a plain fillRect — identical
// to the v1.16.0 fill, so rectangular templates stay byte-for-byte unchanged.
function _drawButtonShape(ctx, x, y, w, h, shape, cornerRadius) {
  const r = _shapeRadius(shape, w, h, cornerRadius);
  if (r === 0) { ctx.fillRect(x, y, w, h); return; }
  _buttonShapePath(ctx, x, y, w, h, shape, cornerRadius);
  ctx.fill();
}

// ── Button layout + spatial navigation (v1.18.0) ─────────────────────────────────
/**
 * Compute default button positions — centered horizontally, stacked vertically
 * from the vertical midpoint of the frame, matching the v1.17 auto-layout exactly.
 * This is the single source of truth for the auto layout, shared by the disc
 * encoder (buildMenuDisplaySet) and the renderer's preview (which mirrors it).
 *
 * @param {number} count     — number of buttons
 * @param {number} bw        — button width (px)
 * @param {number} bh        — button height (px)
 * @param {number} gap       — gap between buttons (px)
 * @param {number} [fw=1920] — frame width
 * @param {number} [fh=1080] — frame height
 * @returns {{ x: number, y: number }[]}
 */
function computeAutoPositions(count, bw, bh, gap, fw = 1920, fh = 1080) {
  // Object form (v1.22.0): computeAutoPositions(tpl, n) — drives the horizontal
  // studio-bar layout. The legacy positional form (count, bw, bh, gap, fw, fh) is
  // unchanged and always produces the vertical stack. The renderer's _autoPositions()
  // mirrors this math byte-for-byte (see src/renderer.js) — keep the two in sync.
  if (count && typeof count === 'object') {
    const tpl = count;
    const b = tpl.button || {};
    const n = (bw != null) ? bw : (b.count != null ? b.count : (b.layout === 'horizontal' ? 4 : 3));
    const FW = 1920, FH = 1080;
    if (b.layout === 'horizontal') {
      const barH = (b.barHeight != null) ? b.barHeight : 140;
      const barY = FH - barH;
      const totalW = n * b.width + (n - 1) * b.gap;
      const startX = Math.round((FW - totalW) / 2);
      const buttonY = Math.round(barY + (barH - b.height) / 2);
      return Array.from({ length: n }, (_, i) => ({ x: startX + i * (b.width + b.gap), y: buttonY }));
    }
    // vertical via the object form → delegate to the positional path (identical math)
    return computeAutoPositions(n, b.width, b.height, b.gap, FW, FH);
  }
  const totalH = count * bh + (count - 1) * gap;
  const startY = Math.round((fh - totalH) / 2);
  const startX = Math.round((fw - bw) / 2);
  return Array.from({ length: count }, (_, i) => ({
    x: startX,
    y: startY + i * (bh + gap),
  }));
}

/**
 * Compute spatial navigation neighbours for a set of button positions.
 * Returns an array of { up, down, left, right } with 1-based button IDs,
 * matching the BD IG convention (button IDs start at 1).
 *
 * Algorithm: for each direction, find the nearest button in that half-plane
 * using a weighted distance that strongly prefers axially aligned neighbours.
 * If no button exists in a given half-plane, wrap to the furthest button in the
 * OPPOSITE half-plane (DVD-Studio-Pro-style wrap). When the opposite half-plane
 * is also empty (e.g. LEFT/RIGHT in a perfectly stacked column, where every
 * button shares the same x), there is genuinely nowhere to go and the neighbour
 * falls back to the button itself — which is exactly what the v1.17 hardcoded
 * column navigation did, so the auto-layout path stays byte-identical.
 *
 * @param {{ x: number, y: number }[]} positions  — top-left of each button
 * @param {number} bw — button width
 * @param {number} bh — button height
 * @returns {{ up: number, down: number, left: number, right: number }[]}
 */
function computeSpatialNavigation(positions, bw, bh) {
  const n = positions.length;
  if (n === 0) return [];
  if (n === 1) return [{ up: 1, down: 1, left: 1, right: 1 }];

  const centers = positions.map(p => ({
    cx: p.x + bw / 2,
    cy: p.y + bh / 2,
  }));

  const AXIS_PENALTY = 3.0;

  // Nearest button in a half-plane, weighting cross-axis distance heavily so an
  // axially aligned neighbour wins over a diagonal one.
  function nearest(fromIdx, filterFn, primaryAxis) {
    const { cx: fx, cy: fy } = centers[fromIdx];
    let best = -1, bestDist = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === fromIdx) continue;
      if (!filterFn(centers[j], fx, fy)) continue;
      const { cx: jx, cy: jy } = centers[j];
      const dx = jx - fx, dy = jy - fy;
      const axisDist  = primaryAxis === 'y' ? Math.abs(dy) : Math.abs(dx);
      const crossDist = primaryAxis === 'y' ? Math.abs(dx) : Math.abs(dy);
      const dist = Math.sqrt((crossDist * AXIS_PENALTY) ** 2 + axisDist ** 2);
      if (dist < bestDist) { bestDist = dist; best = j; }
    }
    return best;
  }

  // Furthest button in the OPPOSITE half-plane (the wrap target). Constrained to
  // the strict opposite half so a pure column has no left/right wrap target.
  function wrapIdx(fromIdx, wrapAxis, wrapDir) {
    const { cx: fx, cy: fy } = centers[fromIdx];
    let best = -1, bestVal = -Infinity;
    for (let j = 0; j < n; j++) {
      if (j === fromIdx) continue;
      const coord = wrapAxis === 'y' ? centers[j].cy : centers[j].cx;
      const from  = wrapAxis === 'y' ? fy : fx;
      const inHalf = wrapDir === 'max' ? coord > from : coord < from;
      if (!inHalf) continue;
      const val = wrapDir === 'max' ? coord : -coord;
      if (val > bestVal) { bestVal = val; best = j; }
    }
    return best;
  }

  return centers.map((_, i) => {
    const upIdx    = nearest(i, (c, fx, fy) => c.cy < fy, 'y');
    const up       = upIdx    >= 0 ? upIdx    : wrapIdx(i, 'y', 'max');
    const downIdx  = nearest(i, (c, fx, fy) => c.cy > fy, 'y');
    const down     = downIdx  >= 0 ? downIdx  : wrapIdx(i, 'y', 'min');
    const leftIdx  = nearest(i, (c, fx, fy) => c.cx < fx, 'x');
    const left     = leftIdx  >= 0 ? leftIdx  : wrapIdx(i, 'x', 'max');
    const rightIdx = nearest(i, (c, fx, fy) => c.cx > fx, 'x');
    const right    = rightIdx >= 0 ? rightIdx : wrapIdx(i, 'x', 'min');

    return {
      up:    (up    >= 0 ? up    : i) + 1,
      down:  (down  >= 0 ? down  : i) + 1,
      left:  (left  >= 0 ? left  : i) + 1,
      right: (right >= 0 ? right : i) + 1,
    };
  });
}

// ── Template-derived defaults ───────────────────────────────────────────────────
// All look-and-feel values (palette, geometry, font, fill colors, background) now
// live in templates (src/assets/templates/*.json — see src/lib/template.js). The
// "Classic" template holds the exact v1.12.0 production look, so the module-level
// constants below are derived from it. This keeps the default code path (and the
// public exports PALETTE/BTN_W/BTN_H/ENTRY_RGB/FONT_PATH) byte-identical to v1.12.0
// while letting buildMenuDisplaySet accept an alternate template.
//
// The palette's 5th PDS byte (T) is ALPHA: T=255 = opaque, T=0 = fully transparent
// (confirmed by the S11 disc — every entry T=255 rendered solid in VLC). Templates
// are validated to keep all entries opaque (validateTemplate enforces T=255), so the
// button bitmaps always paint. (See docs/menu_research_progress.md.)
const CLASSIC = defaultTemplate();

// Palette (4 opaque YCbCr-601 entries): 0=near-black bg, 1=white border,
// 2=NORMAL fill, 3=SELECTED fill.
const PALETTE = CLASSIC.palette;

// ── Button geometry (Classic defaults) ──────────────────────────────────────────
const BTN_W   = CLASSIC.button.width;
const BTN_H   = CLASSIC.button.height;
const BTN_GAP = CLASSIC.button.gap;     // vertical gap between buttons
const BORDER  = CLASSIC.button.border;  // border thickness in pixels

// ── Text rendering constants ──────────────────────────────────────────────────
// Font for canvas text rendering (SIL Open Font License — Inter Regular).
const FONT_PATH = resolveFontPath(CLASSIC.font.file);

// RGB equivalents of the Classic fill palette entries — used for pixel
// quantization. Derived from YCbCr in the template JSON.
const ENTRY_RGB = {
  [CLASSIC.button.normalFill.entry]:   CLASSIC.button.normalFill.rgb,
  [CLASSIC.button.selectedFill.entry]: CLASSIC.button.selectedFill.rgb,
};

/**
 * Build a render "style" — the look values renderButtonBitmap/renderButtonPixels
 * need — from a template object. Defaults to the Classic template so callers that
 * pass nothing keep the v1.12.0 behavior exactly.
 *
 * @param {object} [tpl] - a validated template (defaults to Classic)
 * @returns {object} { w, h, gap, border, borderEntry, normalEntry, selEntry,
 *                      normalRGB, selRGB, normalHex, selHex, fontPath, fontSizeRatio, fontColor }
 */
function styleFromTemplate(tpl = CLASSIC) {
  const b = tpl.button;
  return {
    w:            b.width,
    h:            b.height,
    gap:          b.gap,
    border:       b.border,
    borderEntry:  b.borderEntry,
    normalEntry:  b.normalFill.entry,
    selEntry:     b.selectedFill.entry,
    normalRGB:    b.normalFill.rgb,
    selRGB:       b.selectedFill.rgb,
    normalHex:    b.normalFill.hex,
    selHex:       b.selectedFill.hex,
    // Shape: 'rect' (default) | 'rounded' | 'pill'. Absent → 'rect' (v1.16.0 look).
    shape:        (b.shape === 'rounded' || b.shape === 'pill') ? b.shape : 'rect',
    cornerRadius: b.cornerRadius,
    // Layout: 'horizontal' draws an icon ring + label-below (studio bar style);
    // anything else (default) keeps the v1.16 centered-label look.
    layout:       b.layout === 'horizontal' ? 'horizontal' : 'vertical',
    iconSize:     b.iconSize,
    fontPath:     resolveFontPath(tpl.font.file),
    fontSizeRatio: tpl.font.sizeRatio,
    fontColor:    tpl.font.color,
  };
}

// The Classic-derived style: the default for the render helpers.
const DEFAULT_STYLE = styleFromTemplate(CLASSIC);

function _colorDist2(r1, g1, b1, r2, g2, b2) {
  return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

/**
 * Render a button bitmap with a centered text label using node-canvas.
 *
 * The label is drawn with the bundled MenuFont onto an off-screen canvas filled
 * with the button's fill color; the raw RGBA pixels are read back and each is
 * quantized to the nearest palette entry (text/border color vs fill color).
 * Falls back to renderButtonPixels (solid blocks, no text) if the canvas module
 * fails to load, the font is missing, the label is empty, or anything throws.
 *
 * @param {string} text       - button label text
 * @param {'normal'|'selected'|'activated'} state
 * @param {number} w          - button width in pixels
 * @param {number} h          - button height in pixels
 * @param {object} [style]    - render style (from styleFromTemplate); defaults to Classic
 * @returns {Uint8Array} palette-indexed pixel array (w*h bytes)
 */
function renderButtonBitmap(text, state, w, h, style = DEFAULT_STYLE) {
  const fontPath = style.fontPath;
  const canvasLib = _getCanvas();
  if (!canvasLib || !fs.existsSync(fontPath) || !text) {
    return renderButtonPixels(w, h, state, style);
  }

  try {
    const { createCanvas, registerFont } = canvasLib;

    // Register the font family once per font file (must precede createCanvas).
    if (!_registeredFonts.has(fontPath)) {
      registerFont(fontPath, { family: 'MenuFont' });
      _registeredFonts.add(fontPath);
    }

    const isNormal  = state === 'normal';
    const fillEntry = isNormal ? style.normalEntry : style.selEntry;
    const fillRGB   = isNormal ? style.normalRGB   : style.selRGB;
    const border      = style.border;
    const borderEntry = style.borderEntry;
    const fontSize  = Math.round((h - border * 2) * style.fontSizeRatio);
    // 'rect' (default) draws byte-for-byte as v1.16.0; 'rounded'/'pill' clip the fill.
    const shape = (style.shape === 'rounded' || style.shape === 'pill') ? style.shape : 'rect';

    const canvas = createCanvas(w, h);
    const ctx    = canvas.getContext('2d');

    // Fill the button shape. For 'rect' this fills the whole canvas (identical to
    // v1.16.0); for rounded/pill the corners are left transparent so they fall back
    // to the background palette entry below.
    ctx.fillStyle = `rgb(${fillRGB[0]}, ${fillRGB[1]}, ${fillRGB[2]})`;
    _drawButtonShape(ctx, 0, 0, w, h, shape, style.cornerRadius);

    if (style.layout === 'horizontal') {
      // Studio-bar button: a circular icon placeholder in the top ~60% and the label
      // below it. The ring strokes in the label color → quantizes to borderEntry; the
      // translucent fill stays close to the button fill so it maps back to fillEntry.
      const iconD = style.iconSize || 52;
      const cx = w / 2;
      const cy = Math.round(h * 0.34);
      ctx.beginPath();
      ctx.arc(cx, cy, iconD / 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = style.fontColor;
      ctx.stroke();
      // Label centered in the bottom band.
      const labelSize = Math.max(10, Math.round(h * 0.30 * style.fontSizeRatio));
      ctx.fillStyle    = style.fontColor;
      ctx.font         = `${labelSize}px MenuFont`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, Math.round(h * 0.80));
    } else {
      // Draw the label centered both horizontally and vertically.
      ctx.fillStyle    = style.fontColor;
      ctx.font         = `${fontSize}px MenuFont`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, h / 2);
    }

    // For rounded/pill, draw the border by stroking the same outline (inset so it
    // stays inside the shape) in the label color — it quantizes to borderEntry just
    // like the text. Rect keeps the v1.16.0 pixel-overlay border further below.
    if (border > 0 && shape !== 'rect') {
      ctx.strokeStyle = style.fontColor;
      ctx.lineWidth   = border;
      _buttonShapePath(ctx, border / 2, border / 2, w - border, h - border, shape, style.cornerRadius);
      ctx.stroke();
    }

    // Read back raw RGBA pixels and quantize to the nearest palette entry
    // (text/border color vs fill color — anti-aliased edges snap to the closer).
    // Outside the shape (rounded/pill corners) the pixel is transparent → it maps to
    // the background palette entry (id 0), which is what the disc shows there too.
    const data = ctx.getImageData(0, 0, w, h).data;
    const WHITE = [255, 255, 255];
    const pixels = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (shape !== 'rect' && data[i * 4 + 3] < 128) { pixels[i] = 0; continue; }
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const dWhite = _colorDist2(r, g, b, WHITE[0], WHITE[1], WHITE[2]);
      const dFill  = _colorDist2(r, g, b, fillRGB[0], fillRGB[1], fillRGB[2]);
      pixels[i] = dWhite <= dFill ? borderEntry : fillEntry;
    }

    // Overlay the rectangular border (rect only — rounded/pill stroked it above).
    if (shape === 'rect') {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (x < border || x >= w - border || y < border || y >= h - border) {
            pixels[y * w + x] = borderEntry;
          }
        }
      }
    }

    return pixels;
  } catch {
    return renderButtonPixels(w, h, state, style);
  }
}

// IG stream PID: BD spec assigns 0x1400-0x141F to Interactive Graphics.
// 0x1200-0x121F is reserved for Presentation Graphics (subtitles).
// libbluray IS_HDMV_PID_IG() checks range 0x1400-0x141F; using 0x1200
// causes gc_decode_ts() to route the data to the PG decoder instead of IG.
const IG_PID = 0x1400;

/**
 * Render a button bitmap as a palette-indexed pixel array.
 * state: 'normal' | 'selected' | 'activated'
 *
 * @param {number} w - button width
 * @param {number} h - button height
 * @param {'normal'|'selected'|'activated'} state
 * @param {object} [style] - render style (from styleFromTemplate); defaults to Classic
 * @returns {Uint8Array} palette-indexed pixels (w*h bytes)
 */
function renderButtonPixels(w, h, state, style = DEFAULT_STYLE) {
  const bgIdx     = state === 'normal' ? style.normalEntry : style.selEntry;
  const borderIdx = style.borderEntry;
  const border    = style.border;
  const pixels    = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const isBorder = x < border || x >= w - border || y < border || y >= h - border;
      pixels[y * w + x] = isBorder ? borderIdx : bgIdx;
    }
  }
  return pixels;
}

/**
 * Build the complete IG display set for an N-button menu.
 * Buttons are auto-laid out and centered vertically on the frame.
 *
 * State model (v1.12.0 — the S11 "visible normal-state" pattern, proven in VLC):
 * every button gets TWO ODS objects so it is visible at rest AND when selected:
 *   button i → obj_id (2i)   = NORMAL  bitmap (palette fill idx 2)
 *              obj_id (2i+1) = SELECTED bitmap (palette fill idx 3)
 *   button i refs: normal=2i, selected=2i+1, activated=2i+1 (reuses selected).
 * page.defaultSelectedButtonIdRef = 1 so the first button starts highlighted
 * (libbluray and compliant players then move selection with the arrow keys).
 * Single epoch_start display set, no WDS (IG render path ignores it; matches
 * Toast/S11). ICS PTS = the menu clip's first video PTS (passed as `pts`); the
 * encoder derives ICS DTS = PTS−12012 and the PDS/ODS/END decode chain.
 * See docs/menu_research_progress.md "Phase 6 — production encoder refactor".
 *
 * @param {object}   opts
 * @param {number}   opts.videoWidth   - video frame width (default 1920)
 * @param {number}   opts.videoHeight  - video frame height (default 1080)
 * @param {number[]} opts.playlists    - playlist IDs for each button (e.g. [1,2,3])
 * @param {number}   opts.pl1          - legacy: playlist for button 0 (ignored when playlists provided)
 * @param {number}   opts.pl2          - legacy: playlist for button 1 (ignored when playlists provided)
 * @param {number}   opts.pts          - PTS for the display set in 90kHz ticks (default 0)
 * @param {string[]} opts.labels       - button label text array
 * @param {string}   opts.ffmpegPath   - accepted for API compatibility; unused (text is rendered in-process via canvas)
 * @param {object}   opts.template     - menu template (look/geometry/palette); defaults to Classic
 * @returns {Buffer} TS-packetized IG PES stream (188-byte packets)
 */
function buildMenuDisplaySet({ videoWidth = 1920, videoHeight = 1080, playlists = null, pl1 = 0, pl2 = 1, pts = 0, labels = [], ffmpegPath = null, template = null } = {}) {
  const playlistIds = playlists || [pl1, pl2];
  const N = playlistIds.length;

  // Template controls look + geometry + palette. Absent → Classic (v1.12.0).
  const tpl   = template || CLASSIC;
  const style = styleFromTemplate(tpl);
  const btnW  = style.w;
  const btnH  = style.h;
  const btnGap = style.gap;

  // Resolve button positions. A template may carry button.positions[] (the
  // v1.18.0 layout editor's output) — each non-null {x,y} overrides the auto
  // layout for that button index; absent/null entries fall back to the auto
  // layout. With no positions at all this is byte-identical to v1.17.
  const autoPos = computeAutoPositions(N, btnW, btnH, btnGap, videoWidth, videoHeight);
  const stored  = (tpl.button && Array.isArray(tpl.button.positions)) ? tpl.button.positions : null;
  const positions = autoPos.map((a, i) => {
    const p = (stored && stored[i] && stored[i].x != null) ? stored[i] : a;
    return {
      x: Math.max(0, Math.min(Math.round(p.x), videoWidth  - btnW)),
      y: Math.max(0, Math.min(Math.round(p.y), videoHeight - btnH)),
    };
  });

  // Spatial navigation is recomputed from the resolved positions every build, so
  // the remote's UP/DOWN/LEFT/RIGHT always point at the visually nearest button
  // regardless of placement. For the auto column this reproduces the v1.17
  // sequential-with-wrap navigation exactly.
  const nav = computeSpatialNavigation(positions, btnW, btnH);

  // Visible normal-state model (v1.12.0 / S11): TWO bitmaps per button.
  // obj_id (2i)=NORMAL fill, obj_id (2i+1)=SELECTED fill (entries from template).
  const objects = [];
  const bogs = [];
  for (let i = 0; i < N; i++) {
    const label = (labels[i] && labels[i].trim()) ? labels[i].trim() : `Play Episode ${i + 1}`;
    const normalObjId = 2 * i;
    const selObjId    = 2 * i + 1;
    objects.push({ objectId: normalObjId, version: 0, width: btnW, height: btnH,
                   pixels: renderButtonBitmap(label, 'normal',   btnW, btnH, style) });
    objects.push({ objectId: selObjId,    version: 0, width: btnW, height: btnH,
                   pixels: renderButtonBitmap(label, 'selected', btnW, btnH, style) });

    // One BOG per button, circular up/down navigation.
    // Button IDs are 1-based per BD spec (valid range [1, 0xEFFF]; 0 is reserved).
    bogs.push({
      defaultValidButtonIdRef: i + 1,
      buttons: [{
        id:                 i + 1,
        numericSelectValue: i + 1,
        autoActionFlag:     false,
        x:                  positions[i].x,
        y:                  positions[i].y,
        upperBtnId:         nav[i].up,
        lowerBtnId:         nav[i].down,
        leftBtnId:          nav[i].left,
        rightBtnId:         nav[i].right,
        // normal_state visible (its own bitmap) so the button shows at rest.
        normalStartObjId:   normalObjId,  normalEndObjId: normalObjId,  normalRepeat: false,
        selectedSoundId:    0xFF,
        // selected and activated share the highlighted bitmap (obj 2i+1).
        selStartObjId:      selObjId,  selEndObjId: selObjId,  selRepeat: false,
        activatedSoundId:   0xFF,
        actStartObjId:      selObjId,  actEndObjId: selObjId,
        navCmds: [buildNavCmd('PLAY_PL', playlistIds[i])],
      }],
    });
  }

  return buildIGDisplaySet({
    composition: {
      videoWidth, videoHeight,
      frameRate:        0x20,   // 24fps (frame_rate_code=2; 0x40 would be 29.97fps)
      compositionNumber: 0,
      compositionState:  2,     // epoch_start
      streamModel:       false, // Multiplexed (stream_model=0): IG is in the same m2ts clip as video
      // composition_timeout_pts=0 is the universal 'no timeout' convention; setting to video PTS in v1.10.8 caused hardware to reject the disc at load time, likely because the composition appears 'expired' immediately.
      uiModel:           false,
      userTimeoutMs:     0,
      pages: [{
        id: 0, version: 0,
        uoMask: Buffer.alloc(8),
        animationFrameRateCode:      0,
        defaultSelectedButtonIdRef:  1,       // first button starts highlighted (S11/Finding C)
        defaultActivatedButtonIdRef: 0xFFFF,  // none auto-activated (Toast convention)
        paletteIdRef: 0,
        bogs,
      }],
    },
    palette: { paletteId: 0, version: 0, entries: tpl.palette },
    // No WDS — the IG button render path never consults it (matches Toast/S11).
    windows: null,
    objects,
    pid: IG_PID,
    pts,
  });
}

// ── Chapter selection sub-menu (v1.19.0) ─────────────────────────────────────────
// A second IG menu screen: one button per chapter mark plus a "Main Menu" back
// button. It reuses the exact S11-proven encoder contract used by
// buildMenuDisplaySet (2 ODS per button, no WDS, defaultSelectedButtonIdRef
// highlight, frame_rate_code=2, epoch_start, InMux stream_model). Only the button
// layout and the navigation commands differ from the episode menu.
//
// HARDWARE STATUS: the disc-pipeline integration (a second m2ts/mpls/clpi clip,
// two MovieObjects, and the cross-clip JumpObject transitions) is NOT part of this
// change — see the v1.19.0 PR notes. These functions are the verifiable building
// blocks (byte-deterministic, unit-tested); end-to-end hardware navigation is
// pending and unverified.

/**
 * 2-column grid layout for chapter buttons (used for 7+ chapters). The grid is
 * centered on the frame; row-major fill (button i → column i%2, row floor(i/2)).
 *
 * @param {number} count - number of chapter buttons
 * @param {number} bw    - button width
 * @param {number} bh    - button height
 * @param {number} gap   - gap between buttons (both axes)
 * @param {number} [fw=1920] - frame width
 * @param {number} [fh=1080] - frame height
 * @returns {{x:number,y:number}[]}
 */
function computeChapterGridPositions(count, bw, bh, gap, fw = 1920, fh = 1080) {
  const cols = 2;
  const rows = Math.ceil(count / cols);
  const totalW = cols * bw + (cols - 1) * gap;
  const totalH = rows * bh + (rows - 1) * gap;
  const startX = Math.round((fw - totalW) / 2);
  const startY = Math.round((fh - totalH) / 2);
  return Array.from({ length: count }, (_, i) => ({
    x: startX + (i % cols) * (bw + gap),
    y: startY + Math.floor(i / cols) * (bh + gap),
  }));
}

/**
 * Resolve the chapter-menu button set: positions, labels, and nav commands.
 * Chapter buttons (≤6 → vertical stack via computeAutoPositions; 7+ → 2-column
 * grid) seek the main video to chapter i via PLAY_PL_MARK(mainPlaylistId, i). A
 * trailing "Main Menu" back button (centered, below all chapters with an extra
 * gap) jumps back to the main-menu MovieObject via JUMP_OBJECT(mainMenuObjectId).
 * All positions are clamped to the frame, matching buildMenuDisplaySet.
 *
 * @param {Array<{name?:string,time?:string,startTime?:number}>} chapters
 * @param {object}  [opts]
 * @param {object}  [opts.template]           - validated template (geometry source)
 * @param {number}  [opts.mainPlaylistId=1]   - playlist id of the main video (00001.mpls → 1)
 * @param {number}  [opts.mainMenuObjectId=0] - MovieObject id of the main menu (back target)
 * @param {string}  [opts.backLabel='Main Menu']
 * @param {number}  [opts.videoWidth=1920]
 * @param {number}  [opts.videoHeight=1080]
 * @returns {{positions:{x,y}[], labels:string[], navCmds:Buffer[][], backIndex:number}}
 */
function buildChapterMenuButtons(chapters = [], opts = {}) {
  const {
    template = CLASSIC, mainPlaylistId = 1, mainMenuObjectId = 0,
    backLabel = 'Main Menu', videoWidth = 1920, videoHeight = 1080,
  } = opts;
  const style = styleFromTemplate(template || CLASSIC);
  const bw = style.w, bh = style.h, gap = style.gap;
  const n = chapters.length;

  // ≤6 chapters → vertical stack (same as the episode menu auto-layout);
  // 7+ → 2-column grid. Both are centered on the frame.
  const chapPos = n <= 6
    ? computeAutoPositions(n, bw, bh, gap, videoWidth, videoHeight)
    : computeChapterGridPositions(n, bw, bh, gap, videoWidth, videoHeight);

  // Back button sits below the lowest chapter button, centered, with a 2× gap.
  const lowestY = chapPos.reduce((m, p) => Math.max(m, p.y), 0);
  const backPos = { x: Math.round((videoWidth - bw) / 2), y: lowestY + bh + gap * 2 };

  const clamp = (p) => ({
    x: Math.max(0, Math.min(Math.round(p.x), videoWidth  - bw)),
    y: Math.max(0, Math.min(Math.round(p.y), videoHeight - bh)),
  });
  const positions = [...chapPos, backPos].map(clamp);

  const labels = [
    ...chapters.map((c, i) => (c && c.name && c.name.trim()) ? c.name.trim() : `Chapter ${i + 1}`),
    backLabel,
  ];

  const navCmds = [
    // chapter i → seek main video to mark i (0-indexed, matches the MPLS mark order)
    ...chapters.map((_, i) => [buildNavCmd('PLAY_PL_MARK', mainPlaylistId, i)]),
    // back → return to the main-menu MovieObject (JumpObject, no call-stack push)
    [buildNavCmd('JUMP_OBJECT', mainMenuObjectId)],
  ];

  return { positions, labels, navCmds, backIndex: n };
}

/**
 * Build the complete chapter-selection IG display set (one button per chapter +
 * a "Main Menu" back button). Encoder contract is identical to buildMenuDisplaySet
 * (the S11 visible-normal-state model); only layout + nav commands differ.
 *
 * @param {object}  opts
 * @param {Array}   opts.chapters             - project.chapters array
 * @param {object}  [opts.template]           - menu template (defaults to Classic)
 * @param {number}  [opts.pts=0]              - ICS PTS in 90kHz ticks
 * @param {number}  [opts.mainPlaylistId=1]   - main video playlist id (00001.mpls → 1)
 * @param {number}  [opts.mainMenuObjectId=0] - back-button JumpObject target
 * @param {string}  [opts.backLabel='Main Menu']
 * @param {number}  [opts.videoWidth=1920]
 * @param {number}  [opts.videoHeight=1080]
 * @returns {Buffer} TS-packetized IG PES stream
 */
function buildChapterMenuDisplaySet({ chapters = [], template = null, pts = 0, mainPlaylistId = 1, mainMenuObjectId = 0, backLabel = 'Main Menu', videoWidth = 1920, videoHeight = 1080 } = {}) {
  const tpl   = template || CLASSIC;
  const style = styleFromTemplate(tpl);
  const btnW  = style.w;
  const btnH  = style.h;

  const { positions, labels, navCmds } = buildChapterMenuButtons(chapters, {
    template: tpl, mainPlaylistId, mainMenuObjectId, backLabel, videoWidth, videoHeight,
  });
  const N = positions.length;

  // Spatial navigation (UP/DOWN/LEFT/RIGHT) recomputed from the resolved layout —
  // identical algorithm to the episode menu so the grid navigates naturally.
  const nav = computeSpatialNavigation(positions, btnW, btnH);

  // Visible normal-state model (S11): TWO bitmaps per button (normal + selected).
  const objects = [];
  const bogs = [];
  for (let i = 0; i < N; i++) {
    const normalObjId = 2 * i;
    const selObjId    = 2 * i + 1;
    objects.push({ objectId: normalObjId, version: 0, width: btnW, height: btnH,
                   pixels: renderButtonBitmap(labels[i], 'normal',   btnW, btnH, style) });
    objects.push({ objectId: selObjId,    version: 0, width: btnW, height: btnH,
                   pixels: renderButtonBitmap(labels[i], 'selected', btnW, btnH, style) });
    bogs.push({
      defaultValidButtonIdRef: i + 1,
      buttons: [{
        id: i + 1, numericSelectValue: i + 1, autoActionFlag: false,
        x: positions[i].x, y: positions[i].y,
        upperBtnId: nav[i].up, lowerBtnId: nav[i].down, leftBtnId: nav[i].left, rightBtnId: nav[i].right,
        normalStartObjId: normalObjId, normalEndObjId: normalObjId, normalRepeat: false,
        selectedSoundId: 0xFF,
        selStartObjId: selObjId, selEndObjId: selObjId, selRepeat: false,
        activatedSoundId: 0xFF,
        actStartObjId: selObjId, actEndObjId: selObjId,
        navCmds: navCmds[i] || [],
      }],
    });
  }

  return buildIGDisplaySet({
    composition: {
      videoWidth, videoHeight,
      frameRate: 0x20, compositionNumber: 0, compositionState: 2,
      streamModel: false, uiModel: false, userTimeoutMs: 0,
      pages: [{
        id: 0, version: 0, uoMask: Buffer.alloc(8),
        animationFrameRateCode: 0,
        defaultSelectedButtonIdRef: 1, defaultActivatedButtonIdRef: 0xFFFF,
        paletteIdRef: 0, bogs,
      }],
    },
    palette: { paletteId: 0, version: 0, entries: tpl.palette },
    windows: null,
    objects,
    pid: IG_PID,
    pts,
  });
}

/**
 * Extract the first video PES PTS from a BD m2ts buffer.
 *
 * Scans for the first PID=0x1011 (HDMV video) PUSI packet that has a PTS.
 * This PTS value equals the MPLS in_pts (in_time << 1 in 90kHz) used by
 * libbluray's m2ts_filter, so it is the minimum value an IG PES PTS must
 * meet to pass the filter's `pts >= in_pts` check.
 *
 * @param {Buffer} m2tsBuf - 192-byte BD m2ts packets
 * @returns {number} PTS in 90kHz ticks, or 54000000 as fallback
 */
function extractFirstVideoPTS(m2tsBuf) {
  const VIDEO_PID = 0x1011;
  for (let i = 0; i + 192 <= m2tsBuf.length; i += 192) {
    const pkt = m2tsBuf.slice(i + 4, i + 192);
    if (pkt[0] !== 0x47) continue;
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    if (pid !== VIDEO_PID) continue;
    if (!(pkt[1] & 0x40)) continue;                      // not PUSI
    const payloadStart = (pkt[3] & 0x20) ? 5 + pkt[4] : 4;
    const pes = pkt.slice(payloadStart);
    if (pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) continue;
    if (!(pes[7] & 0x80)) continue;                      // no PTS flag
    const p = pes.slice(9, 14);
    return ((p[0] & 0x0e) * (1 << 29)) +
           (p[1] * (1 << 22)) +
           ((p[2] & 0xfe) * (1 << 14)) +
           (p[3] * (1 << 7)) +
           ((p[4] & 0xfe) >> 1);
  }
  return 54000000;  // fallback: tsMuxeR default for 600s clip start
}

/**
 * Convert 188-byte TS packets to 192-byte BD m2ts format.
 * BD m2ts prepends a 4-byte arrival timestamp (in 27MHz ticks) to each packet.
 *
 * @param {Buffer} tsPackets - raw 188-byte TS packets
 * @param {number} baseTimestamp - 27MHz timestamp for first packet
 * @returns {Buffer} 192-byte BD m2ts packets
 */
function convertTsBdFormat(tsPackets, baseTimestamp = 0) {
  if (tsPackets.length % 188 !== 0) {
    throw new Error(`TS packet stream not aligned to 188 bytes (got ${tsPackets.length} bytes)`);
  }
  const numPackets = tsPackets.length / 188;
  const out = Buffer.alloc(numPackets * 192);
  for (let i = 0; i < numPackets; i++) {
    const ts = baseTimestamp + i * 300;  // 300 = 1 tick spacing (27MHz / 90kHz)
    // 4-byte timestamp: top 30 bits are the 27MHz clock value
    // >>> 0 converts signed 32-bit result to unsigned for writeUInt32BE
    out.writeUInt32BE((ts & 0x3FFFFFFF) >>> 0, i * 192);
    tsPackets.copy(out, i * 192 + 4, i * 188, (i + 1) * 188);
  }
  return out;
}

/**
 * Inject IG TS packets into an existing BD m2ts stream.
 *
 * The IG packets are inserted after the initial PAT/PMT packets (first 10
 * 192-byte packets) so the player sees IG data early in the stream.
 * This is a "dirty injection" — the PMT is NOT updated to list the IG PID.
 * libbluray uses the CLPI STN_table to discover stream PIDs, not the PMT,
 * so this works if the CLPI is patched to declare the IG stream.
 *
 * @param {Buffer} videoM2ts  - 192-byte BD m2ts video stream
 * @param {Buffer} igTs188    - 188-byte TS IG stream (from wrapInPES / buildMenuDisplaySet)
 * @param {number} insertAfterN - insert after this many 192-byte packets (default 10)
 * @returns {Buffer} combined 192-byte BD m2ts
 */
function injectIGIntoM2ts(videoM2ts, igTs188, insertAfterN = 10) {
  if (videoM2ts.length % 192 !== 0) {
    throw new Error(`Video m2ts not aligned to 192 bytes (${videoM2ts.length} bytes)`);
  }
  const beforeIdx = Math.min(insertAfterN - 1, videoM2ts.length / 192 - 1);
  const beforeArr = videoM2ts.readUInt32BE(beforeIdx * 192) & 0x3FFFFFFF;
  const igBd = convertTsBdFormat(igTs188, beforeArr + 300);
  const insertAt = Math.min(insertAfterN * 192, videoM2ts.length);
  return Buffer.concat([
    videoM2ts.slice(0, insertAt),
    igBd,
    videoM2ts.slice(insertAt),
  ]);
}

// ── MPEG-2 CRC32 (polynomial 0x04C11DB7, initial 0xFFFFFFFF, no final XOR, big-endian) ───────
function mpegCrc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= (buf[i] << 24);
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1);
      crc = crc >>> 0;
    }
  }
  return crc >>> 0;
}

/**
 * Patch the PMT packet in a BD m2ts buffer to add an IG stream entry.
 *
 * Hardware demuxers route PES packets to the IG decoder only when the PMT
 * declares the stream. CLPI/MPLS declarations alone are not sufficient.
 * This function locates the PMT via the PAT, appends a 5-byte ES entry for
 * PID igPid with stream_type igStreamType, updates section_length, and
 * rewrites the CRC_32. Idempotent: returns the original buffer if the PID
 * is already declared.
 *
 * @param {Buffer} m2tsBuf      - 192-byte BD m2ts stream (with arrival timestamps)
 * @param {number} igPid        - IG elementary stream PID (default 0x1400)
 * @param {number} igStreamType - IG stream type (default 0x91 = HDMV IG)
 * @returns {Buffer} patched m2ts buffer (or original if already patched)
 */
function patchPmtForIG(m2tsBuf, igPid = 0x1400, igStreamType = 0x91) {
  // Step 1: Parse PAT (PID 0x0000) to find PMT PID
  let pmtPid = -1;
  for (let i = 0; i + 192 <= m2tsBuf.length; i += 192) {
    const pkt = m2tsBuf.slice(i + 4, i + 192); // skip 4-byte BD arrival timestamp
    if (pkt[0] !== 0x47) continue;
    const pid = ((pkt[1] & 0x1F) << 8) | pkt[2];
    if (pid !== 0x0000) continue;
    if (!(pkt[1] & 0x40)) continue; // need PUSI to start section
    const hasAdaptation = (pkt[3] & 0x20) !== 0;
    const payloadStart = hasAdaptation ? (4 + 1 + pkt[4]) : 4;
    const pointer = pkt[payloadStart];
    const sectionStart = payloadStart + 1 + pointer;
    if (pkt[sectionStart] !== 0x00) continue; // table_id must be 0x00 for PAT
    const sectionLength = ((pkt[sectionStart + 1] & 0x0F) << 8) | pkt[sectionStart + 2];
    // program entries: sectionStart+3 (table_id+2 bytes) +5 fixed bytes = sectionStart+8
    const programsStart = sectionStart + 8;
    const programsEnd   = sectionStart + 3 + sectionLength - 4; // exclude CRC_32
    for (let p = programsStart; p + 4 <= programsEnd; p += 4) {
      const progNum = (pkt[p] << 8) | pkt[p + 1];
      if (progNum !== 0) { // program_number 0 = NIT pointer, skip
        pmtPid = ((pkt[p + 2] & 0x1F) << 8) | pkt[p + 3];
        break;
      }
    }
    if (pmtPid !== -1) break;
  }
  if (pmtPid === -1) throw new Error('patchPmtForIG: PAT not found in m2ts stream');

  // Step 2: Find PMT packet (table_id 0x02) and patch it
  for (let i = 0; i + 192 <= m2tsBuf.length; i += 192) {
    const pktOff = i + 4;
    const pkt    = m2tsBuf.slice(pktOff, pktOff + 188);
    if (pkt[0] !== 0x47) continue;
    const pid = ((pkt[1] & 0x1F) << 8) | pkt[2];
    if (pid !== pmtPid) continue;
    if (!(pkt[1] & 0x40)) continue; // only PUSI packet starts the section
    const hasAdaptation = (pkt[3] & 0x20) !== 0;
    const payloadStart  = hasAdaptation ? (4 + 1 + pkt[4]) : 4;
    const pointer       = pkt[payloadStart];
    const sectionStart  = payloadStart + 1 + pointer;
    if (pkt[sectionStart] !== 0x02) continue; // table_id must be 0x02 for PMT

    const sectionLength = ((pkt[sectionStart + 1] & 0x0F) << 8) | pkt[sectionStart + 2];
    // sectionStart+10..11: reserved(4)+program_info_length(12)
    const progInfoLen   = ((pkt[sectionStart + 10] & 0x0F) << 8) | pkt[sectionStart + 11];
    const esLoopStart   = sectionStart + 12 + progInfoLen;
    const crcOff        = sectionStart + 3 + sectionLength - 4; // first byte of CRC_32

    // Walk ES loop: check for igPid (idempotency) and find loop end
    let esOff = esLoopStart;
    while (esOff + 5 <= crcOff) {
      const esPid      = ((pkt[esOff + 1] & 0x1F) << 8) | pkt[esOff + 2];
      const esInfoLen  = ((pkt[esOff + 3] & 0x0F) << 8) | pkt[esOff + 4];
      if (esPid === igPid) return m2tsBuf; // already declared, nothing to do
      esOff += 5 + esInfoLen;
    }

    const newSectionLength = sectionLength + 5;
    if (newSectionLength + 4 > 184) {
      throw new Error(`patchPmtForIG: PMT section too large after IG insertion (section_length + 4 = ${newSectionLength + 4} > 184)`);
    }

    // Build updated 3-byte section header with new section_length
    const sectionHeader = Buffer.from(pkt.slice(sectionStart, sectionStart + 3));
    sectionHeader[1] = (sectionHeader[1] & 0xF0) | ((newSectionLength >> 8) & 0x0F);
    sectionHeader[2] = newSectionLength & 0xFF;

    // New ES entry: stream_type(1) + reserved(3)+PID(13 in 2 bytes) + reserved(4)+ES_info_length(12 in 2 bytes)
    const igEntry = Buffer.from([
      igStreamType,
      0xE0 | (igPid >> 8),
      igPid & 0xFF,
      0xF0,
      0x00,
    ]);

    // Full section body: header + fixed fields + program_info + ES loop + new IG entry
    const sectionBody = Buffer.concat([
      sectionHeader,
      pkt.slice(sectionStart + 3, crcOff), // everything between header and old CRC
      igEntry,
    ]);

    // Recompute CRC_32 over the complete section body
    const newCrc = mpegCrc32(sectionBody);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(newCrc, 0);

    // Pad remaining TS payload with 0xFF stuffing bytes
    const newSectionEndInPkt = sectionStart + sectionBody.length + 4;
    const stuffLen = 188 - newSectionEndInPkt;

    const newPkt = Buffer.concat([
      pkt.slice(0, sectionStart),
      sectionBody,
      crcBuf,
      Buffer.alloc(Math.max(0, stuffLen), 0xFF),
    ]);

    const newM2ts = Buffer.from(m2tsBuf);
    newPkt.copy(newM2ts, pktOff, 0, 188);
    return newM2ts;
  }

  throw new Error(`patchPmtForIG: PMT packet (PID 0x${pmtPid.toString(16).padStart(4, '0')}) not found`);
}

/**
 * Patch a CLPI ProgramInfo section to declare an IG stream at IG_PID.
 *
 * CLPI ProgramInfo layout (confirmed from tsMuxeR-produced files):
 *   ProgramInfo section at piAddr (from header offset 0x0C):
 *     length(4)           number of bytes that follow this field
 *     reserved(1)
 *     number_of_programs(1)
 *     program_sequence[]:
 *       SPN(4) + PMT_PID(2) + num_streams(1) + num_groups(1) = 8 bytes
 *       stream_entries[]:
 *         PID(2) + entry_length(1)=0x15 + StreamCodingInfo(21) = 24 bytes each
 *         StreamCodingInfo: coding_type(1) + data(20)
 *
 * After patching: num_streams++ and a new 24-byte IG entry appended.
 * All header address fields after ProgramInfo are incremented by 24.
 *
 * @param {Buffer} clpiBuf - CLPI file buffer
 * @returns {Buffer|null} new buffer with IG stream added, or null on error
 */
function patchClpiForIG(clpiBuf) {
  if (clpiBuf.length < 0x1C) return null;

  const piAddr = clpiBuf.readUInt32BE(0x0C);   // ProgramInfo_start_address
  if (piAddr + 16 > clpiBuf.length) return null;

  const numPrograms = clpiBuf[piAddr + 5];       // byte at piAddr+5
  if (numPrograms === 0) return null;

  // Program[0] header: SPN(4)+PMT_PID(2)+num_streams(1)+num_groups(1) = 8 bytes at piAddr+6
  const prog0Off  = piAddr + 6;
  const numStreams = clpiBuf[prog0Off + 6];

  // Walk stream entries (each: PID(2)+entry_len(1)+StreamCodingInfo(entry_len)) to find append point
  let streamOff = prog0Off + 8;
  for (let i = 0; i < numStreams; i++) {
    const entryLen = clpiBuf[streamOff + 2];
    streamOff += 3 + entryLen;
  }
  const appendAt = streamOff;

  // 24-byte IG stream entry: PID(2)=0x1200 + length(1)=21 + coding_type(1)=0x91 + 20 zero bytes
  const igEntry = Buffer.alloc(24);
  igEntry.writeUInt16BE(IG_PID, 0);
  igEntry[2] = 0x15;   // StreamCodingInfo length = 21
  igEntry[3] = 0x91;   // coding_type = Interactive Graphics
  // bytes 4–23 remain zero

  const newBuf = Buffer.concat([clpiBuf.slice(0, appendAt), igEntry, clpiBuf.slice(appendAt)]);

  // Update num_streams_in_PS for program[0]
  newBuf[prog0Off + 6] = numStreams + 1;

  // Update ProgramInfo.length (bytes following the 4-byte length field)
  newBuf.writeUInt32BE(clpiBuf.readUInt32BE(piAddr) + 24, piAddr);

  // Increment all header section addresses that fall after ProgramInfo
  for (const off of [0x10, 0x14, 0x18]) {
    const addr = clpiBuf.readUInt32BE(off);
    if (addr > piAddr) newBuf.writeUInt32BE(addr + 24, off);
  }

  return newBuf;
}

/**
 * Patch every PlayItem STN_table in an MPLS to declare an IG stream at IG_PID.
 *
 * MPLS PlayItem→STN_table layout (confirmed from tsMuxeR-produced files):
 *   STN_table at pi_off + 34:
 *     length(2)         bytes following this field
 *     reserved(2)
 *     num_vid(1) num_aud(1) num_PG(1) num_IG(1) num_SA(1) num_SV(1) num_PiP(1)
 *     reserved(5)        → 16-byte header total
 *     stream_entries[]:
 *       StreamEntry(10): entry_len(1)=9 + flag(1)=1 + PID(2) + reserved(6)
 *       StreamCodingInfo(6): sci_len(1)=5 + coding_type(1) + data(4)
 *       Total per entry = 16 bytes
 *
 * IG entries come after PG entries. This appends one IG entry per PlayItem.
 * Updates: num_IG, STN_table.length, PlayItem.length, PlayList.length,
 * PlayListMark_start_address, ExtensionData_start_address (if non-zero).
 *
 * @param {Buffer} mplsBuf - MPLS file buffer
 * @returns {Buffer} new buffer with IG stream added to every PlayItem
 */
function patchMplsForIG(mplsBuf) {
  const plStart    = mplsBuf.readUInt32BE(8);
  const plMarkStart = mplsBuf.readUInt32BE(12);
  const extStart   = mplsBuf.readUInt32BE(16);

  const numPlayItems = mplsBuf.readUInt16BE(plStart + 6);

  // Build the 16-byte IG stream entry:
  //   StreamEntry(10): 09 01 PID_HI PID_LO 00*6
  //   StreamCodingInfo(6): 05 91 00 00 00 00
  const igEntry = Buffer.from([
    0x09, 0x01, (IG_PID >> 8) & 0xFF, IG_PID & 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x05, 0x91, 0x00, 0x00, 0x00, 0x00,
  ]);

  let newBuf      = Buffer.from(mplsBuf);
  let totalAdded  = 0;  // cumulative bytes inserted so far
  let piOrgOffset = plStart + 10;  // PlayItem[0] offset in the ORIGINAL buffer

  for (let i = 0; i < numPlayItems; i++) {
    const origPiLen = mplsBuf.readUInt16BE(piOrgOffset);  // from original buffer (pre-patch)
    const piOff     = piOrgOffset + totalAdded;            // offset in current newBuf

    const stnOff = piOff + 34;
    const numVid = newBuf[stnOff + 4];
    const numAud = newBuf[stnOff + 5];
    const numPg  = newBuf[stnOff + 6];
    const numIg  = newBuf[stnOff + 7];

    // IG entries start after vid+aud+pg entries (each 16 bytes)
    const igEntriesOff = stnOff + 16 + (numVid + numAud + numPg) * 16;

    newBuf = Buffer.concat([newBuf.slice(0, igEntriesOff), igEntry, newBuf.slice(igEntriesOff)]);
    totalAdded += 16;

    // Update num_IG
    newBuf[stnOff + 7] = numIg + 1;
    // Update STN_table.length (+16 for the new entry, read from original buffer)
    const origStnLen = mplsBuf.readUInt16BE(piOrgOffset + 34);
    newBuf.writeUInt16BE(origStnLen + 16, stnOff);
    // Update PlayItem.length (+16)
    newBuf.writeUInt16BE(origPiLen + 16, piOff);

    piOrgOffset += 2 + origPiLen;  // advance in original buffer
  }

  // Update PlayList.length (bytes following the 4-byte length field)
  newBuf.writeUInt32BE(mplsBuf.readUInt32BE(plStart) + totalAdded, plStart);
  // Update PlayListMark_start_address
  newBuf.writeUInt32BE(plMarkStart + totalAdded, 12);
  // Update ExtensionData_start_address (if present)
  if (extStart > 0) newBuf.writeUInt32BE(extStart + totalAdded, 16);

  return newBuf;
}

/**
 * Patch every PlayItem clip_information_file_name in an MPLS to a new 5-char name.
 * Used to rename the clip reference from "00000" (tsMuxeR default) to "00099" (menu slot).
 *
 * @param {Buffer} mplsBuf - MPLS file buffer
 * @param {string} name    - exactly 5 ASCII characters, e.g. "00099"
 * @returns {Buffer} new buffer with clip names updated
 */
function patchMplsClipName(mplsBuf, name) {
  if (name.length !== 5) throw new Error(`patchMplsClipName: name must be 5 chars, got ${name.length}`);
  const plStart      = mplsBuf.readUInt32BE(8);
  const numPlayItems = mplsBuf.readUInt16BE(plStart + 6);
  const newBuf = Buffer.from(mplsBuf);
  const nameBytes = Buffer.from(name, 'ascii');

  let piOff = plStart + 10;
  for (let i = 0; i < numPlayItems; i++) {
    const piLen = newBuf.readUInt16BE(piOff);
    nameBytes.copy(newBuf, piOff + 2);   // clip_information_file_name at PlayItem+2
    piOff += 2 + piLen;
  }
  return newBuf;
}

/**
 * Find the BD packet index immediately before the first video PES whose PTS
 * is >= targetPts. Used to interleave IG packets at the correct position in
 * a high-bitrate stream so GC fires after the vout is initialized.
 *
 * @param {Buffer} m2tsBuf   - 192-byte BD m2ts stream
 * @param {number} targetPts - PTS threshold in 90kHz ticks
 * @returns {number} BD packet index; falls back to 90% of total if not found
 */
function findPtsInsertionPoint(m2tsBuf, targetPts) {
  const VIDEO_PID = 0x1011;
  const numPkts   = Math.floor(m2tsBuf.length / 192);
  for (let i = 0; i < numPkts; i++) {
    const pkt = m2tsBuf.slice(i * 192 + 4, i * 192 + 192);
    if (pkt[0] !== 0x47) continue;
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    if (pid !== VIDEO_PID) continue;
    if (!(pkt[1] & 0x40)) continue;                      // not PUSI
    const payloadStart = (pkt[3] & 0x20) ? 5 + pkt[4] : 4;
    const pes = pkt.slice(payloadStart);
    if (pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) continue;
    if (!(pes[7] & 0x80)) continue;                      // no PTS flag
    const p = pes.slice(9, 14);
    const pts = ((p[0] & 0x0e) * (1 << 29)) +
                (p[1] * (1 << 22)) +
                ((p[2] & 0xfe) * (1 << 14)) +
                (p[3] * (1 << 7)) +
                ((p[4] & 0xfe) >> 1);
    if (pts >= targetPts) return i;
  }
  return Math.floor(numPkts * 0.9);
}

/**
 * Set still_mode=2 (infinite still) on every PlayItem in a menu MPLS.
 * With infinite still the player holds the last frame indefinitely instead
 * of firing End-of-title, which would call blurayReleaseVout and destroy
 * the IG overlay before any video frame is displayed.
 *
 * PlayItem byte layout (BDMV spec §5.3.4):
 *   piOff+0-1  : length of PlayItem data (not counting these 2 bytes)
 *   piOff+2-6  : ClipInformationFileName (5 chars)
 *   piOff+7-10 : Clip_codec_identifier (4 chars)
 *   piOff+11   : reserved(7) + is_multi_angle(1)
 *   piOff+12   : connection_condition(4) + reserved(4)
 *   piOff+13   : ref_to_STC_id
 *   piOff+14-17: IN_time
 *   piOff+18-21: OUT_time
 *   piOff+22-29: UO_mask_table (8 bytes)
 *   piOff+30   : random_access_flag(1) + still_mode(2) + reserved(5)
 *   piOff+31-32: still_time (2 bytes, only meaningful when still_mode==1)
 */
function patchMplsForStill(mplsBuf) {
  const plStart      = mplsBuf.readUInt32BE(8);
  const numPlayItems = mplsBuf.readUInt16BE(plStart + 6);
  const newBuf       = Buffer.from(mplsBuf);

  let piOff = plStart + 10;
  for (let i = 0; i < numPlayItems; i++) {
    const piLen = newBuf.readUInt16BE(piOff);
    // PlayItem byte layout (after UO_mask_table at [22-29]):
    //   [30]: random_access_flag(1) + reserved(7)
    //   [31]: still_mode — 0x00=no-still, 0x01=infinite-still, 0x02=timed-still
    //   [32-33]: still_time (only meaningful when still_mode==0x02)
    // Ref: Beach Boys 50 Live reference disc — 00001.mpls PlayItem byte[31]=0x01 for IG menu clip.
    newBuf[piOff + 30] = newBuf[piOff + 30] & 0x80;  // keep only RAF bit, clear reserved bits
    newBuf[piOff + 31] = 0x01;                        // still_mode = 0x01 (infinite still)
    newBuf.writeUInt16BE(0x0000, piOff + 32);          // still_time = 0 (N/A for infinite still)
    piOff += 2 + piLen;
  }
  return newBuf;
}

/**
 * Rewrite video PES headers in a BD m2ts to ensure every video PUSI packet
 * has both PTS and DTS (flags2 = 0xC0, hdr_len = 10).
 *
 * tsMuxeR only writes DTS when DTS != PTS (i.e., for I/P frames in a B-frame
 * stream). B-frames are emitted with PTS-only (flags2 = 0x80). BD-ROM spec
 * mandates PTS+DTS for all H.264 video PES. Hardware players (LG BP350) use
 * video DTS to schedule IG overlay composition; missing DTS causes buttons to
 * never render.
 *
 * Strategy: for PUSI packets that have PTS but no DTS, steal 5 bytes from the
 * TS adaptation field stuffing (always present with 77+ bytes for B-frames),
 * reduce af_len by 5, insert the DTS field (5 bytes) after the PTS field, and
 * update flags2 and hdr_len accordingly.
 *
 * DTS value: PTS - frameDuration (default 3750 ticks = 1 frame at 24fps).
 * BD hardware accepts a constant 1-frame DTS offset for all frame types.
 *
 * @param {Buffer} m2tsBuf      - 192-byte BD m2ts packets
 * @param {number} frameDuration - 90kHz ticks per frame (default 3750 = 24fps)
 * @returns {Buffer} patched m2ts with PTS+DTS on all video PUSI packets
 */
function rewriteVideoPesDts(m2tsBuf, frameDuration = 3750) {
  const VIDEO_PID = 0x1011;
  if (m2tsBuf.length % 192 !== 0) throw new Error('rewriteVideoPesDts: buffer not aligned to 192 bytes');

  const out = Buffer.from(m2tsBuf);  // copy

  for (let i = 0; i + 192 <= out.length; i += 192) {
    const pkt = out.slice(i + 4, i + 192);  // 188-byte TS packet (mutable view)

    if (pkt[0] !== 0x47) continue;
    const pid  = ((pkt[1] & 0x1f) << 8) | pkt[2];
    const pusi = (pkt[1] >> 6) & 1;
    const afc  = (pkt[3] >> 4) & 3;
    if (pid !== VIDEO_PID || !pusi) continue;

    // Locate PES header in payload
    let afLen = 0;
    let payloadStart;
    if (afc & 2) {
      afLen = pkt[4];          // adaptation_field_length (content bytes)
      payloadStart = 5 + afLen;
    } else {
      payloadStart = 4;
    }

    const pes = pkt.slice(payloadStart);
    if (pes.length < 14) continue;
    if (pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) continue;  // no start code
    const flags2  = pes[7];
    const hdrLen  = pes[8];
    const ptsFlag = (flags2 >> 7) & 1;
    const dtsFlag = (flags2 >> 6) & 1;

    if (!ptsFlag || dtsFlag) continue;  // already OK or no PTS to work from
    if (hdrLen < 5 || pes.length < 9 + hdrLen) continue;

    // Require adaptation field with at least 6 bytes content (1 flags + 5 stuffing)
    if (!(afc & 2) || afLen < 6) continue;  // packet #0 (IDR) already has DTS from tsMuxeR

    // Decode PTS
    const p = pes.slice(9, 14);
    const pts = ((p[0] & 0x0e) * (1 << 29)) +
                (p[1] * (1 << 22)) +
                ((p[2] & 0xfe) * (1 << 14)) +
                (p[3] * (1 << 7)) +
                ((p[4] & 0xfe) >> 1);

    // Clamp DTS to 0 to avoid wrap-around on very early frames
    const dts = Math.max(0, pts - frameDuration);

    // Encode DTS (5 bytes, marker nibble 0x01) — same layout as ig-encoder.encodeDTS
    const dtsBuf = Buffer.alloc(5);
    dtsBuf[0] = 0x11 | (((dts >> 30) & 0x07) << 1);
    dtsBuf[1] = (dts >> 22) & 0xFF;
    dtsBuf[2] = ((dts >> 15) & 0x7F) << 1 | 1;
    dtsBuf[3] = (dts >> 7) & 0xFF;
    dtsBuf[4] = ((dts & 0x7F) << 1) | 1;

    // Steal 5 bytes from adaptation field stuffing: reduce af_len by 5
    // pkt[4] = af_len; stuffing starts at pkt[5 + 1] (after af_flags byte)
    pkt[4] = afLen - 5;

    // Shift payload left by 5 (AF shrinks; payload grows by 5 at its old start)
    // New payload start is 5 bytes earlier
    const newPayloadStart = payloadStart - 5;
    // Copy PES header + existing PTS to new position
    pkt.copy(pkt, newPayloadStart, payloadStart, payloadStart + 9 + 5);  // 9 fixed + 5 PTS

    // Update PTS prefix nibble: 0011 (PTS+DTS present)
    pkt[newPayloadStart + 9] = (pkt[newPayloadStart + 9] & 0x0f) | 0x30;

    // Insert DTS after PTS
    const dtsOff = newPayloadStart + 14;
    dtsBuf.copy(pkt, dtsOff);

    // Copy ES data (after old PTS field) to new position (after new DTS field)
    const esStart = payloadStart + 14;
    const newEsStart = dtsOff + 5;
    if (esStart < 188 && newEsStart < 188) {
      pkt.copy(pkt, newEsStart, esStart, 188);
    }

    // Update PES header fields
    pkt[newPayloadStart + 7] = (flags2 & 0x3f) | 0xc0;  // PTS_DTS_flags = 11
    pkt[newPayloadStart + 8] = hdrLen + 5;               // extend hdr_len

    // Update PES_packet_length if non-zero
    const pesLen = (pkt[newPayloadStart + 4] << 8) | pkt[newPayloadStart + 5];
    if (pesLen !== 0) {
      const newLen = pesLen + 5;
      pkt[newPayloadStart + 4] = (newLen >> 8) & 0xff;
      pkt[newPayloadStart + 5] = newLen & 0xff;
    }
  }

  return out;
}

// ── Menu background video generation (v1.13.0) ───────────────────────────────────
// The menu clip is the video the IG is injected into. v1.12.0 proved a specific
// H.264 profile (the navy-frame ffmpeg command) renders correctly on the LG BP350.
// These params are LOCKED here so user-supplied backgrounds (solid or image) always
// produce a stream with the same codec profile/level/pix_fmt and can never drift
// into something the hardware rejects. Anything that wants to change the look does
// so through the template's background config — never by changing the encoder args.
const MENU_VIDEO = { width: 1920, height: 1080, fps: 24 };

// Locked H.264/AC-3 encode args — byte-for-byte the v1.12.0 navy-frame command.
// (Verified: profile High, level 4.0, yuv420p, 2 B-frames; GOP 24.)
const MENU_ENCODE_ARGS = [
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-preset', 'medium', '-crf', '28',
  '-bf', '2', '-g', '24',
  '-c:a', 'ac3', '-b:a', '192k',
];

const MAX_IMAGE_DIM = 7680;  // reject anything larger than 8K on either axis
const ANIMATED_CODECS = new Set(['gif', 'apng', 'webp', 'mng', 'flv1']);

/**
 * Validate a user-supplied background image before it is encoded into a menu
 * clip. Uses ffprobe to read the first video stream. Throws on:
 *   - missing / unreadable file
 *   - no decodable video stream
 *   - dimensions larger than 8K on either axis
 *   - animated formats (multi-frame: gif / apng / animated webp …)
 *
 * @param {string} imagePath
 * @param {string} ffprobePath - path to ffprobe binary
 * @returns {{width:number,height:number,codec:string}}
 */
function validateBackgroundImage(imagePath, ffprobePath) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error(`background image not found: ${imagePath}`);
  }
  if (!ffprobePath || !fs.existsSync(ffprobePath)) {
    throw new Error(`validateBackgroundImage: ffprobe not available at ${ffprobePath}`);
  }
  let info;
  try {
    const out = execFileSync(ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name,nb_frames',
      '-of', 'json', imagePath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    info = JSON.parse(out.toString());
  } catch (e) {
    throw new Error(`background image is not a readable image: ${imagePath} (${e.message})`);
  }
  const s = info && info.streams && info.streams[0];
  if (!s || !s.width || !s.height) {
    throw new Error(`background image has no decodable video stream: ${imagePath}`);
  }
  if (s.width > MAX_IMAGE_DIM || s.height > MAX_IMAGE_DIM) {
    throw new Error(`background image too large (${s.width}x${s.height}); max ${MAX_IMAGE_DIM}px on either axis`);
  }
  const nbFrames = parseInt(s.nb_frames, 10);
  if (ANIMATED_CODECS.has(s.codec_name) || (Number.isFinite(nbFrames) && nbFrames > 1)) {
    throw new Error(`animated images are not supported as menu backgrounds (codec=${s.codec_name}, frames=${s.nb_frames})`);
  }
  return { width: s.width, height: s.height, codec: s.codec_name };
}

/**
 * Build the ffmpeg scale expression for a given fit mode, targeting 1920×1080.
 *   cover   — fill the frame, crop the overflow (default; no letterbox)
 *   contain — fit inside the frame, letterbox the remainder (bg color)
 *   stretch — scale to exactly 1920×1080, distorting aspect ratio
 */
function _fitScaleExpr(fit, w, h) {
  switch (fit) {
    case 'contain':
      return `scale=${w}:${h}:force_original_aspect_ratio=decrease`;
    case 'stretch':
      return `scale=${w}:${h},setsar=1`;
    case 'cover':
    default:
      return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  }
}

// ── Background image resolution (v1.21.0) ─────────────────────────────────────────
// User-uploaded background images are copied to app userData/backgrounds and stored
// in the template as a bare filename (background.file) — never an absolute path — so
// templates stay portable. Resolve that filename back to an absolute path here, in
// the main process. The directory is resolved lazily from Electron so this module
// still loads under plain node (tests fall back to ~/.disc-forge/backgrounds, the
// same convention template-store.js uses for the templates dir).
let _backgroundsDirCache = null;
function backgroundsDir() {
  if (_backgroundsDirCache) return _backgroundsDirCache;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      _backgroundsDirCache = path.join(app.getPath('userData'), 'backgrounds');
    }
  } catch { /* not running under Electron */ }
  if (!_backgroundsDirCache) _backgroundsDirCache = path.join(require('os').homedir(), '.disc-forge', 'backgrounds');
  return _backgroundsDirCache;
}

/**
 * Resolve a background block to an absolute image path, or null if it references
 * no image. Prefers the portable `file` (→ userData/backgrounds/<file>); falls back
 * to the legacy absolute `imagePath`. Does NOT check existence — callers decide
 * whether a missing file is an error (legacy null) or a graceful fallback (v1.21.0).
 *
 * @param {object} bg - template.background
 * @returns {string|null}
 */
function resolveBackgroundImagePath(bg) {
  if (!bg) return null;
  if (typeof bg.file === 'string' && bg.file.trim()) return path.join(backgroundsDir(), bg.file);
  if (typeof bg.imagePath === 'string' && bg.imagePath.trim()) return bg.imagePath;
  return null;
}

/**
 * Compute the destination rectangle for drawing an image into an FW×FH frame under
 * a given fit mode. Pure math (no canvas) so the cover/contain/stretch logic is unit
 * testable. This is the canvas-side counterpart of _fitScaleExpr (the ffmpeg path);
 * both must agree on what each fit mode means.
 *   cover   — scale to fill the frame, centred, cropping the overflow (default)
 *   contain — scale to fit entirely inside, centred (letterbox the remainder)
 *   stretch — scale to exactly FW×FH, distorting aspect ratio
 *
 * @returns {{dx:number, dy:number, dw:number, dh:number}}
 */
function computeBackgroundDrawRect(fit, imgW, imgH, FW, FH) {
  if (!imgW || !imgH) return { dx: 0, dy: 0, dw: FW, dh: FH };
  if (fit === 'stretch') return { dx: 0, dy: 0, dw: FW, dh: FH };
  const scale = fit === 'contain'
    ? Math.min(FW / imgW, FH / imgH)
    : Math.max(FW / imgW, FH / imgH);   // 'cover' (default)
  const dw = imgW * scale, dh = imgH * scale;
  return { dx: (FW - dw) / 2, dy: (FH - dh) / 2, dw, dh };
}

/**
 * Draw a loaded image onto a 2D canvas context per the fit mode, painting the
 * fallback color first so 'contain' letterboxes against it. Used by the in-process
 * menu previews (template-preview-menu); the burned disc uses ffmpeg (_fitScaleExpr).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} img - a loaded canvas Image (has .width/.height)
 * @param {string} fit - 'cover' | 'contain' | 'stretch'
 * @param {number} FW
 * @param {number} FH
 * @param {string} [fallbackColor] - CSS color string for the letterbox / base plate
 */
function _drawBackgroundImage(ctx, img, fit, FW, FH, fallbackColor) {
  if (fallbackColor) { ctx.fillStyle = fallbackColor; ctx.fillRect(0, 0, FW, FH); }
  const { dx, dy, dw, dh } = computeBackgroundDrawRect(fit, img.width, img.height, FW, FH);
  ctx.drawImage(img, dx, dy, dw, dh);
}

/**
 * Build an ffmpeg drawbox filter for the horizontal layout's bottom bar, or null if
 * the template isn't horizontal / has no bar color. The bar is baked into the menu
 * background clip (so it sits behind the IG buttons at all times). Returns a filter
 * fragment like `drawbox=x=0:y=940:w=iw:h=140:color=0x00b4d8@0.96:t=fill`.
 *
 * @param {object} btn - template.button
 * @param {number} [FH=1080]
 * @returns {string|null}
 */
function _barDrawboxFilter(btn, FH = 1080) {
  if (!btn || btn.layout !== 'horizontal' || !btn.barColor) return null;
  const barH = (btn.barHeight != null) ? btn.barHeight : 140;
  const barY = FH - barH;
  const op = (typeof btn.barOpacity === 'number') ? btn.barOpacity : 1;
  return `drawbox=x=0:y=${barY}:w=iw:h=${barH}:color=0x${btn.barColor}@${op}:t=fill`;
}

/**
 * Generate the menu background clip (the video the IG is later injected into).
 *
 * Solid backgrounds reproduce the v1.12.0 navy-frame logic with the template's
 * color. Image backgrounds load the user image, scale+pad it per the template's
 * fit mode, flatten any alpha against the template's background color, and encode
 * with the SAME locked H.264 params. Either way the output is a 1920×1080 H.264
 * clip with the proven codec profile, plus a silent AC-3 track.
 *
 * @param {object} opts
 * @param {object} opts.template    - validated template (background drives this)
 * @param {string} opts.ffmpegPath  - ffmpeg binary
 * @param {string} opts.ffprobePath - ffprobe binary (required to validate images)
 * @param {string} opts.outputPath  - output clip path (.mkv recommended)
 * @param {number} [opts.duration]  - clip duration in seconds (default 5)
 * @returns {string} outputPath
 */
function generateMenuVideo({ template, ffmpegPath, ffprobePath, outputPath, duration = 5 } = {}) {
  if (!template || !template.background) throw new Error('generateMenuVideo: template with a background is required');
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error(`generateMenuVideo: ffmpeg not available at ${ffmpegPath}`);
  if (!outputPath) throw new Error('generateMenuVideo: outputPath is required');

  const bg = template.background;
  const { width: W, height: H, fps } = MENU_VIDEO;
  const anull = 'anullsrc=channel_layout=stereo:sample_rate=48000';

  // Resolve the image (portable `file` preferred, legacy `imagePath` fallback).
  // A type:image template with NO reference at all is misconfigured → throw. A
  // template that DOES reference an image whose file is missing on disk falls back
  // to the solid color plate (never crash a build over a deleted asset — v1.21.0).
  let imgPath = null;
  if (bg.type === 'image') {
    const resolved = resolveBackgroundImagePath(bg);
    if (!resolved) {
      throw new Error('generateMenuVideo: background.type is "image" but no image is set (file/imagePath)');
    }
    if (fs.existsSync(resolved)) imgPath = resolved;   // present → encode it; missing → fall through to solid
  }

  // Horizontal layout (v1.22.0): a colored bar is baked into the bottom of the clip,
  // on top of whatever background was drawn, behind the IG buttons. Appended to both
  // the solid and image filter chains. Missing barColor → null → no bar (graceful).
  const barF = _barDrawboxFilter(template.button, H);

  let args;
  if (imgPath) {
    validateBackgroundImage(imgPath, ffprobePath);
    // Composite the scaled image over a solid color plate. This flattens any
    // alpha against background.color AND supplies the letterbox color for
    // 'contain'. format=yuv420p drops the (now-flattened) alpha for encoding.
    const scaleExpr = _fitScaleExpr(bg.fit, W, H);
    // Final scale with out_range=tv normalizes full-range (JPEG → yuvj420p) sources
    // to limited-range yuv420p, which BD-ROM requires; format=yuv420p drops the
    // (already-flattened) alpha. Without it, JPEG inputs would emit yuvj420p.
    const filter =
      `color=c=0x${bg.color}:s=${W}x${H}[bgc];` +
      `[0:v]${scaleExpr}[fg];` +
      `[bgc][fg]overlay=(W-w)/2:(H-h)/2,scale=${W}:${H}:out_range=tv,format=yuv420p${barF ? ',' + barF : ''}[v]`;
    args = [
      '-y',
      '-loop', '1', '-i', imgPath,
      '-f', 'lavfi', '-i', anull,
      '-filter_complex', filter,
      '-map', '[v]', '-map', '1:a',
      '-t', String(duration), '-r', String(fps),
      ...MENU_ENCODE_ARGS,
      outputPath,
    ];
  } else if (barF) {
    // Solid + horizontal bar: draw the bar over the color plate via filter_complex.
    args = [
      '-y',
      '-f', 'lavfi', '-i', `color=c=0x${bg.color}:size=${W}x${H}:rate=${fps}`,
      '-f', 'lavfi', '-i', anull,
      '-filter_complex', `[0:v]${barF},format=yuv420p[v]`,
      '-map', '[v]', '-map', '1:a',
      '-t', String(duration),
      ...MENU_ENCODE_ARGS,
      outputPath,
    ];
  } else {
    // Solid: the v1.12.0 navy-frame logic, parameterized on background.color.
    args = [
      '-y',
      '-f', 'lavfi', '-i', `color=c=0x${bg.color}:size=${W}x${H}:rate=${fps}`,
      '-f', 'lavfi', '-i', anull,
      '-map', '0:v', '-map', '1:a',
      '-t', String(duration),
      ...MENU_ENCODE_ARGS,
      outputPath,
    ];
  }

  try {
    execFileSync(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    const detail = (e.stderr || '').toString().slice(-600);
    throw new Error(`generateMenuVideo: ffmpeg failed: ${detail || e.message}`);
  }
  if (!fs.existsSync(outputPath)) throw new Error(`generateMenuVideo: no output produced at ${outputPath}`);
  return outputPath;
}

// ── Button preview rendering (v1.13.0 — for the template editor UI) ───────────────
// YCbCr-601 (limited range) → RGB via the shared color module (single source of
// truth, also exposed to the renderer's palette pickers).
const { yuvToRgb: _yuvToRgb } = require('./color');

// Standard IEEE CRC-32 (reflected) — required for PNG chunk checksums. (Distinct
// from mpegCrc32 above, which uses the MPEG-TS polynomial.)
let _crcTable = null;
function _crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = _crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function _pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(_crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// Encode an 8-bit RGB buffer (w*h*3) as a PNG (color type 2). No deps beyond zlib.
function _encodePng(rgb, w, h) {
  const zlib = require('zlib');
  const sig  = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type RGB
  // [10] compression=0, [11] filter=0, [12] interlace=0
  // Prepend filter byte (0 = none) to each scanline.
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    rgb.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, _pngChunk('IHDR', ihdr), _pngChunk('IDAT', idat), _pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * Render a single menu button at a template's settings as a PNG — for the
 * template editor's preview pane. Mirrors exactly how the button is drawn on the
 * disc (same renderButtonBitmap/renderButtonPixels path and palette), so the
 * preview is faithful — including the real, canvas-rendered text label. The PNG
 * itself is encoded in-process (no ffmpeg). ffmpegPath is accepted for API
 * compatibility but unused.
 *
 * @param {object} opts
 * @param {object} opts.template   - validated template
 * @param {'normal'|'selected'} [opts.state] - button state to preview (default 'selected')
 * @param {string} [opts.label]    - button label (default 'Play Episode 1')
 * @param {string} [opts.ffmpegPath] - accepted for API compatibility; unused
 * @returns {Buffer} PNG image of one button (template button width × height)
 */
function renderButtonPreviewPng({ template, state = 'selected', label = 'Play Episode 1', ffmpegPath = null } = {}) {
  if (!template || !template.button || !template.palette) {
    throw new Error('renderButtonPreviewPng: a validated template is required');
  }
  const style = styleFromTemplate(template);
  const w = style.w, h = style.h;
  const idx = renderButtonBitmap(label, state, w, h, style);
  const pal = {};
  for (const e of template.palette) pal[e.id] = _yuvToRgb(e.Y, e.Cr, e.Cb);
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const c = pal[idx[i]] || [0, 0, 0];
    rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2];
  }
  return _encodePng(rgb, w, h);
}

module.exports = {
  buildMenuDisplaySet,
  buildChapterMenuDisplaySet,
  buildChapterMenuButtons,
  computeChapterGridPositions,
  generateMenuVideo,
  validateBackgroundImage,
  resolveBackgroundImagePath,
  backgroundsDir,
  computeBackgroundDrawRect,
  _drawBackgroundImage,
  renderButtonPreviewPng,
  MENU_VIDEO,
  MENU_ENCODE_ARGS,
  extractFirstVideoPTS,
  rewriteVideoPesDts,
  renderButtonBitmap,
  renderButtonPixels,
  styleFromTemplate,
  computeAutoPositions,
  computeSpatialNavigation,
  convertTsBdFormat,
  injectIGIntoM2ts,
  patchPmtForIG,
  patchClpiForIG,
  patchMplsForIG,
  patchMplsClipName,
  patchMplsForStill,
  findPtsInsertionPoint,
  IG_PID,
  BTN_W, BTN_H, BTN_GAP, BORDER,
  PALETTE,
  ENTRY_RGB,
  FONT_PATH,
};
