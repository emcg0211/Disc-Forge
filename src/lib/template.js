'use strict';
/**
 * template.js — menu template data model for Disc Forge (v1.13.0).
 *
 * A template is a plain JSON object describing the *look* of an interactive
 * menu: its palette, button geometry, font, text color, and background. It is
 * deliberately decoupled from the IG *encoder* — the encoder-level invariants
 * proven across S8–S11 (single epoch_start display set, 2 ODS per button,
 * no WDS, opaque palette, defaultSelectedButtonIdRef=1, ICS PTS = in_time) are
 * fixed in menu-builder.js / ig-encoder.js and are NOT template-controlled. A
 * template only changes colors, sizes, font, and the background plate, so no
 * template choice can produce an IG stream the LG BP350 rejects.
 *
 * Schema (schemaVersion 1):
 *   {
 *     id, name, description, schemaVersion,
 *     category,                                // group label for the Templates UI
 *     palette: [ {id,Y,Cr,Cb,T} × 4 ],        // YCbCr-601; T=255=opaque
 *     button: {
 *       width, height, gap, border,           // pixels
 *       borderEntry,                           // palette id for the border
 *       shape,                                 // 'rect'|'rounded'|'pill' (optional, default 'rect')
 *       cornerRadius,                          // px 4-60, used only when shape==='rounded' (optional)
 *       normalFill:   { entry, rgb:[r,g,b], hex },
 *       selectedFill: { entry, rgb:[r,g,b], hex }
 *     },
 *     font: { file, sizeRatio, color },        // file relative to assets/fonts
 *     background: { type:'solid'|'image', color, imagePath, fit }
 *   }
 *
 * Built-in templates ship read-only in src/assets/templates/*.json. User
 * templates live in app.getPath('userData')/templates/*.json (see
 * template-store.js).
 */

const path = require('path');
const fs   = require('fs');

const BUILTIN_DIR = path.join(__dirname, '..', 'assets', 'templates');
const FONT_DIR    = path.join(__dirname, '..', 'assets', 'fonts');

const VALID_FITS = ['cover', 'contain', 'stretch'];
const VALID_BG_TYPES = ['solid', 'image'];
const VALID_LAYOUTS = ['vertical', 'horizontal'];

/**
 * Resolve a template's font.file to an absolute path. Relative names are
 * resolved against the bundled assets/fonts dir; absolute paths pass through.
 */
function resolveFontPath(file) {
  const p = !file
    ? path.join(FONT_DIR, 'MenuFont.ttf')
    : (path.isAbsolute(file) ? file : path.join(FONT_DIR, file));
  // node-canvas registerFont() is NATIVE code — it opens the file itself and
  // cannot read inside app.asar (Electron only patches Node's fs, not native
  // fopen). src/assets/** ships asarUnpacked, so redirect to the real on-disk
  // twin when running from an asar package. No-op in dev and in tests.
  if (p.includes(`app.asar${path.sep}`)) {
    const unpacked = p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    try { if (fs.existsSync(unpacked)) return unpacked; } catch (_) { /* fall through */ }
  }
  return p;
}

function _isInt(n, lo, hi) {
  return Number.isInteger(n) && n >= lo && n <= hi;
}
function _isHex6(s) {
  return typeof s === 'string' && /^[0-9a-fA-F]{6}$/.test(s);
}

/**
 * Validate a template object. Throws Error with a descriptive message on the
 * first problem found; returns the object unchanged when valid.
 *
 * Validation is structural and range-based. It enforces the encoder's hard
 * requirements (4 opaque palette entries; fill/border entries reference real
 * palette ids) so a malformed template fails fast at load rather than producing
 * a disc the player rejects.
 */
function validateTemplate(obj) {
  const E = (m) => { throw new Error(`Invalid template: ${m}`); };

  if (!obj || typeof obj !== 'object') E('not an object');
  if (typeof obj.id !== 'string'   || !obj.id.trim())   E('id must be a non-empty string');
  if (typeof obj.name !== 'string' || !obj.name.trim()) E('name must be a non-empty string');
  if (typeof obj.category !== 'string' || !obj.category.trim()) E('category must be a non-empty string');

  // ── palette: exactly 4 entries, ids 0..3, channels 0-255, all opaque ──
  if (!Array.isArray(obj.palette) || obj.palette.length !== 4) {
    E('palette must be an array of exactly 4 entries');
  }
  obj.palette.forEach((e, i) => {
    if (!e || typeof e !== 'object') E(`palette[${i}] not an object`);
    if (e.id !== i) E(`palette[${i}].id must equal ${i} (entries must be ordered 0..3)`);
    for (const ch of ['Y', 'Cr', 'Cb', 'T']) {
      if (!_isInt(e[ch], 0, 255)) E(`palette[${i}].${ch} must be an integer 0-255`);
    }
    if (e.T !== 255) E(`palette[${i}].T must be 255 (opaque) — transparent entries render no button`);
  });

  // ── button geometry + fills ──
  const b = obj.button;
  if (!b || typeof b !== 'object') E('button block missing');
  if (!_isInt(b.width,  1, 1920)) E('button.width must be 1-1920');
  if (!_isInt(b.height, 1, 1080)) E('button.height must be 1-1080');
  if (!_isInt(b.gap,    0, 1080)) E('button.gap must be 0-1080');
  if (!_isInt(b.border, 0, Math.floor(Math.min(b.width, b.height) / 2))) {
    E('button.border must be a non-negative integer smaller than half the button size');
  }
  // ── button shape (optional; defaults to 'rect') ──
  // 'rect' (axis-aligned), 'rounded' (cornerRadius px), 'pill' (radius = half height).
  if (b.shape !== undefined && !['rect', 'rounded', 'pill'].includes(b.shape)) {
    E("button.shape must be one of 'rect'/'rounded'/'pill'");
  }
  // cornerRadius only applies to 'rounded'; ignored for rect/pill. Optional.
  if (b.cornerRadius !== undefined && !_isInt(b.cornerRadius, 4, 60)) {
    E('button.cornerRadius must be an integer 4-60');
  }
  // ── button positions (optional; v1.18.0 layout editor) ──
  // The source of truth for button placement on the 1920×1080 frame. Each entry
  // is the top-left {x,y} of a button; null means "auto-layout this one". Absent
  // → full auto-layout (backward-compatible; built-in templates carry none).
  if (b.positions !== undefined && b.positions !== null) {
    if (!Array.isArray(b.positions)) E('button.positions must be an array (or null)');
    b.positions.forEach((p, i) => {
      if (p === null) return;  // null → auto-layout this button
      if (!p || typeof p !== 'object') E(`button.positions[${i}] must be {x,y} or null`);
      if (!_isInt(p.x, 0, 1919)) E(`button.positions[${i}].x must be an integer 0-1919`);
      if (!_isInt(p.y, 0, 1079)) E(`button.positions[${i}].y must be an integer 0-1079`);
    });
  }
  // ── button layout mode (optional; v1.22.0 horizontal studio-bar layout) ──
  // 'vertical' (default/absent) keeps the v1.21 centered stack. 'horizontal' lays the
  // buttons in a row inside a colored bar at the bottom of the frame (WB/Universal
  // /Sony disc style). The bar/icon fields below only apply when layout==='horizontal';
  // they are *ignored* (not rejected) in vertical mode so a template may carry them
  // ahead of switching modes.
  if (b.layout !== undefined && b.layout !== null && !VALID_LAYOUTS.includes(b.layout)) {
    E("button.layout must be 'vertical' or 'horizontal'");
  }
  if (b.layout === 'horizontal') {
    if (!_isHex6(b.barColor)) E('button.barColor is required (6-digit hex) when layout is horizontal');
    if (b.barOpacity !== undefined && b.barOpacity !== null) {
      if (typeof b.barOpacity !== 'number' || !(b.barOpacity >= 0 && b.barOpacity <= 1)) {
        E('button.barOpacity must be a number between 0 and 1');
      }
    }
    if (b.barHeight !== undefined && b.barHeight !== null && !_isInt(b.barHeight, 50, 400)) {
      E('button.barHeight must be an integer 50-400');
    }
    if (b.iconSize !== undefined && b.iconSize !== null && !_isInt(b.iconSize, 20, 200)) {
      E('button.iconSize must be an integer 20-200');
    }
  }
  // count (optional; both modes) — number of sample buttons shown in the editor preview.
  if (b.count !== undefined && b.count !== null && !_isInt(b.count, 1, 8)) {
    E('button.count must be an integer 1-8');
  }

  const paletteIds = obj.palette.map(e => e.id);
  if (!paletteIds.includes(b.borderEntry)) E('button.borderEntry must reference a palette id');
  for (const key of ['normalFill', 'selectedFill']) {
    const f = b[key];
    if (!f || typeof f !== 'object') E(`button.${key} block missing`);
    if (!paletteIds.includes(f.entry)) E(`button.${key}.entry must reference a palette id`);
    if (!Array.isArray(f.rgb) || f.rgb.length !== 3 || !f.rgb.every(v => _isInt(v, 0, 255))) {
      E(`button.${key}.rgb must be [r,g,b] with each 0-255`);
    }
    if (!_isHex6(f.hex)) E(`button.${key}.hex must be a 6-digit hex color`);
  }

  // ── font ──
  const f = obj.font;
  if (!f || typeof f !== 'object') E('font block missing');
  if (typeof f.file !== 'string' || !f.file.trim()) E('font.file must be a non-empty string');
  if (typeof f.sizeRatio !== 'number' || !(f.sizeRatio > 0 && f.sizeRatio <= 1)) {
    E('font.sizeRatio must be a number in (0, 1]');
  }
  if (typeof f.color !== 'string' || !f.color.trim()) E('font.color must be a non-empty string');

  // ── background ──
  const bg = obj.background;
  if (!bg || typeof bg !== 'object') E('background block missing');
  if (!VALID_BG_TYPES.includes(bg.type)) E(`background.type must be one of ${VALID_BG_TYPES.join('/')}`);
  if (!_isHex6(bg.color)) E('background.color must be a 6-digit hex color');
  // fit is optional; when present it must be a known mode. Absent → the render
  // path defaults to 'cover'. (Relaxed from "required" in v1.21.0 so a template
  // reverted from image back to solid — which drops fit — still validates.)
  if (bg.fit !== undefined && bg.fit !== null && !VALID_FITS.includes(bg.fit)) {
    E(`background.fit must be one of ${VALID_FITS.join('/')}`);
  }
  // file (v1.21.0): a *filename-only* reference into the app's userData/backgrounds
  // directory (see main.js bg:pick — uploaded images are copied there). It keeps
  // templates portable JSON: no absolute paths, no base64. When present it must be
  // a bare filename with no path separators (defends against traversal too).
  if (bg.file !== undefined && bg.file !== null) {
    if (typeof bg.file !== 'string' || !bg.file.trim()) E('background.file must be a non-empty string');
    if (/[\\/]/.test(bg.file) || bg.file.includes(path.sep) || bg.file.includes('..')) {
      E('background.file must be a filename only (no path separators)');
    }
  }
  // imagePath (legacy absolute path) may be null in a template *definition* (e.g.
  // the built-in Theatrical ships without an image). generateMenuVideo() enforces
  // a usable image at encode time when background.type === 'image'.
  if (bg.imagePath != null && typeof bg.imagePath !== 'string') {
    E('background.imagePath must be a string or null');
  }

  return obj;
}

/**
 * Load a template by built-in id (e.g. 'classic') or by absolute/relative file
 * path to a .json file. Returns the validated template object.
 *
 * @param {string} idOrPath
 * @returns {object} validated template
 */
function loadTemplate(idOrPath) {
  if (typeof idOrPath !== 'string' || !idOrPath.trim()) {
    throw new Error('loadTemplate: idOrPath must be a non-empty string');
  }
  let p;
  if (idOrPath.endsWith('.json') || idOrPath.includes(path.sep) || path.isAbsolute(idOrPath)) {
    p = path.isAbsolute(idOrPath) ? idOrPath : path.resolve(idOrPath);
  } else {
    p = path.join(BUILTIN_DIR, `${idOrPath}.json`);
  }
  if (!fs.existsSync(p)) throw new Error(`loadTemplate: template not found: ${p}`);
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`loadTemplate: ${p} is not valid JSON: ${e.message}`);
  }
  return validateTemplate(obj);
}

/**
 * The default template (Classic) — the v1.12.0 production look. Returns a fresh
 * object each call (loaded from disk) so callers may safely mutate their copy.
 */
function defaultTemplate() {
  return loadTemplate('classic');
}

module.exports = {
  loadTemplate,
  validateTemplate,
  defaultTemplate,
  resolveFontPath,
  BUILTIN_DIR,
  VALID_FITS,
  VALID_BG_TYPES,
  VALID_LAYOUTS,
};
