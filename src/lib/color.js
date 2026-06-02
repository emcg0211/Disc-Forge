'use strict';
/**
 * color.js — the single source of truth for YCbCr-601 ↔ RGB conversion used
 * across the menu pipeline (template fill colors, button preview rendering, and
 * the renderer's palette color pickers). Limited-range BT.601, matching how the
 * built-in template palettes were authored.
 *
 * Exposed to the renderer via preload (window.discForge.color.*) so the UI never
 * re-derives the math inline.
 */

function clamp(v) { return Math.max(0, Math.min(255, Math.round(v))); }

/** YCbCr-601 (limited range) → [r, g, b] (0-255). */
function yuvToRgb(Y, Cr, Cb) {
  return [
    clamp(1.164 * (Y - 16) + 1.596 * (Cr - 128)),
    clamp(1.164 * (Y - 16) - 0.813 * (Cr - 128) - 0.391 * (Cb - 128)),
    clamp(1.164 * (Y - 16) + 2.018 * (Cb - 128)),
  ];
}

/** [r, g, b] (0-255) → { Y, Cr, Cb } YCbCr-601 (limited range). */
function rgbToYuv(r, g, b) {
  return {
    Y:  clamp( 0.257 * r + 0.504 * g + 0.098 * b + 16),
    Cb: clamp(-0.148 * r - 0.291 * g + 0.439 * b + 128),
    Cr: clamp( 0.439 * r - 0.368 * g - 0.071 * b + 128),
  };
}

/** [r, g, b] → "rrggbb" (no leading #). */
function rgbToHex(rgb) {
  return rgb.map(v => clamp(v).toString(16).padStart(2, '0')).join('');
}

/** "#rrggbb" or "rrggbb" → [r, g, b]. */
function hexToRgb(hex) {
  const h = String(hex || '').replace(/^#/, '');
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

module.exports = { clamp, yuvToRgb, rgbToYuv, rgbToHex, hexToRgb };
