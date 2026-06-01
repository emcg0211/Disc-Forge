#!/usr/bin/env node
'use strict';
/**
 * mutate.js — targeted, single-dimension mutation of an extracted pack.
 *
 * Operates on a pack directory (from extract.js). Each op edits the decoded
 * segment structure in manifest.json and marks the affected PES unit(s) dirty.
 * repack.js then re-encodes only those units (in place when length is unchanged).
 *
 * Usage:
 *   node mutate.js <packDir> <op> [args...]
 *
 * Ops (DS = display-set index, shown by extract.js):
 *   set-button-pos   <ds> <bog> <btn> <x> <y>
 *   set-defsel       <ds> <value>              (default_selected_button_id_ref; 65535 = none)
 *   set-defact       <ds> <value>
 *   set-state        <ds> <bog> <btn> <normStart> <normEnd> <selStart> <selEnd> <actStart> <actEnd>
 *   set-nav          <ds> <bog> <btn> <cmdIndex> PLAY_PL|JUMP_TITLE|RAW <arg|hex24>
 *   set-palette      <ds> <id> <Y> <Cr> <Cb> <T>
 *   copy-palette     <ds> <fromPackDir> [fromDs]      (replace whole PDS entries)
 *   remove-wds       <ds>
 *   set-wds          <ds> <id> <x> <y> <w> <h>        (single window; replaces all)
 *   set-ods-dims     <ds> <objIdx> <w> <h>            (re-RLE existing pixels into new canvas)
 *   set-ods-bitmap   <ds> <objIdx> <png> [--fit]      (quantize PNG to this DS's palette → RLE)
 *   set-ods-from     <ds> <objIdx> <fromPackDir> <fromDs> <fromObjIdx>
 *
 * Tip: extract → mutate (repeatedly, each one a single dimension) → repack.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');

function loadManifest(packDir) {
  return JSON.parse(fs.readFileSync(path.join(packDir, 'manifest.json'), 'utf8'));
}
function saveManifest(packDir, m) {
  fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify(m, null, 2));
}

/** Find the PES unit (and its segment of `type`) in display set `ds`. */
function findSeg(m, ds, type, occurrence = 0) {
  const dsObj = m.displaySets[ds];
  if (!dsObj) throw new Error(`no display set ${ds}`);
  let count = 0;
  for (const ui of dsObj.units) {
    const unit = m.units.find(u => u.pesIndex === ui);
    for (const seg of unit.segments) {
      if (seg.type === type) {
        if (count === occurrence) return { unit, seg };
        count++;
      }
    }
  }
  throw new Error(`no ${lib.SEG_NAME[type]} #${occurrence} in DS ${ds}`);
}

function markDirty(unit) { unit.dirty = true; }

function getButton(seg, bog, btn) {
  const page = seg.decoded.pages[0];
  const b = page.bogs[bog];
  if (!b) throw new Error(`no BOG ${bog}`);
  const button = b.buttons[btn];
  if (!button) throw new Error(`no button ${btn} in BOG ${bog}`);
  return { page, bogObj: b, button };
}

// ── PNG → palette-indexed pixels via ffmpeg ────────────────────────────────────
function pngToRgba(png, w, h, fit) {
  const tmp = path.join(require('os').tmpdir(), `igtk_${Date.now()}.rgba`);
  const scale = fit
    ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`
    : `scale=${w}:${h}`;
  const r = spawnSync('ffmpeg', ['-y', '-i', png, '-vf', scale, '-pix_fmt', 'rgba', '-f', 'rawvideo', tmp], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg PNG decode failed: ${r.stderr.slice(-300)}`);
  const data = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return data; // w*h*4 RGBA
}

function rgbToYcbcr(R, G, B) {
  const Y = Math.round(0.257 * R + 0.504 * G + 0.098 * B + 16);
  const Cb = Math.round(-0.148 * R - 0.291 * G + 0.439 * B + 128);
  const Cr = Math.round(0.439 * R - 0.368 * G - 0.071 * B + 128);
  return { Y, Cb, Cr };
}

/** Map RGBA pixels to nearest entry in a PDS entries[] (YCbCr+T). */
function quantize(rgba, w, h, entries) {
  const px = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const R = rgba[i * 4], G = rgba[i * 4 + 1], B = rgba[i * 4 + 2], A = rgba[i * 4 + 3];
    if (A < 16) { px[i] = 0; continue; } // transparent → index 0 (RLE escape)
    const { Y, Cb, Cr } = rgbToYcbcr(R, G, B);
    let best = 0, bestD = Infinity;
    for (const e of entries) {
      if (e.id === 0) continue;
      if (e.T > 240) continue; // skip transparent palette slots for opaque pixels
      const dY = Y - e.Y, dCb = Cb - e.Cb, dCr = Cr - e.Cr, dA = A - (255 - e.T);
      const d = dY * dY * 2 + dCb * dCb + dCr * dCr + dA * dA;
      if (d < bestD) { bestD = d; best = e.id; }
    }
    px[i] = best;
  }
  return px;
}

function setOdsRle(seg, width, height, pixels) {
  const rle = lib.encodeRLE(pixels, width, height);
  seg.decoded.first = 1;
  seg.decoded.last = 1;
  seg.decoded.seq = 0xC0;
  seg.decoded.width = width;
  seg.decoded.height = height;
  seg.decoded.dataLen = 4 + rle.length;
  seg.decoded.rleHex = lib.hex(rle);
}

// ── ops ────────────────────────────────────────────────────────────────────
const OPS = {
  'set-button-pos'(m, [ds, bog, btn, x, y]) {
    const { unit, seg } = findSeg(m, +ds, lib.SEG.ICS);
    const { button } = getButton(seg, +bog, +btn);
    button.x = +x; button.y = +y; markDirty(unit);
    return `DS${ds} BOG${bog} btn${btn} pos → (${x},${y})`;
  },
  'set-defsel'(m, [ds, v]) {
    const { unit, seg } = findSeg(m, +ds, lib.SEG.ICS);
    seg.decoded.pages[0].defaultSelectedButtonIdRef = +v; markDirty(unit);
    return `DS${ds} defaultSelectedButtonIdRef → ${v}`;
  },
  'set-defact'(m, [ds, v]) {
    const { unit, seg } = findSeg(m, +ds, lib.SEG.ICS);
    seg.decoded.pages[0].defaultActivatedButtonIdRef = +v; markDirty(unit);
    return `DS${ds} defaultActivatedButtonIdRef → ${v}`;
  },
  'set-state'(m, [ds, bog, btn, ns, ne, ss, se, as, ae]) {
    const { unit, seg } = findSeg(m, +ds, lib.SEG.ICS);
    const { button } = getButton(seg, +bog, +btn);
    button.normalStart = +ns; button.normalEnd = +ne;
    button.selStart = +ss; button.selEnd = +se;
    button.actStart = +as; button.actEnd = +ae;
    markDirty(unit);
    return `DS${ds} BOG${bog} btn${btn} state → N(${ns}-${ne}) S(${ss}-${se}) A(${as}-${ae})`;
  },
  'set-nav'(m, [ds, bog, btn, idx, kind, arg]) {
    const { unit, seg } = findSeg(m, +ds, lib.SEG.ICS);
    const { button } = getButton(seg, +bog, +btn);
    let cmd = Buffer.alloc(12);
    if (kind === 'PLAY_PL') { cmd.writeUInt32BE(0x22800000, 0); cmd.writeUInt32BE(+arg, 4); }
    else if (kind === 'JUMP_TITLE') { cmd.writeUInt32BE(0x21810000, 0); cmd.writeUInt32BE(+arg, 4); }
    else if (kind === 'RAW') { cmd = lib.unhex(arg.padEnd(24, '0')).subarray(0, 12); }
    else throw new Error(`unknown nav kind ${kind}`);
    button.navCmds[+idx] = lib.hex(cmd); markDirty(unit);
    return `DS${ds} BOG${bog} btn${btn} nav[${idx}] → ${kind}(${arg})`;
  },
  'set-palette'(m, [ds, id, Y, Cr, Cb, T]) {
    const { unit, seg } = findSeg(m, +ds, lib.SEG.PDS);
    let e = seg.decoded.entries.find(x => x.id === +id);
    if (!e) { e = { id: +id, Y: 0, Cr: 0, Cb: 0, T: 0 }; seg.decoded.entries.push(e); }
    e.Y = +Y; e.Cr = +Cr; e.Cb = +Cb; e.T = +T; markDirty(unit);
    return `DS${ds} palette[${id}] → Y${Y} Cr${Cr} Cb${Cb} T${T}`;
  },
  'copy-palette'(m, [ds, fromPack, fromDs = 0]) {
    const { unit, seg } = findSeg(m, +ds, lib.SEG.PDS);
    const fm = loadManifest(fromPack);
    const { seg: fseg } = findSeg(fm, +fromDs, lib.SEG.PDS);
    seg.decoded.entries = JSON.parse(JSON.stringify(fseg.decoded.entries));
    markDirty(unit);
    return `DS${ds} palette ← ${fromPack} DS${fromDs} (${seg.decoded.entries.length} entries)`;
  },
  'remove-wds'(m, [ds]) {
    const dsObj = m.displaySets[+ds];
    let removed = 0;
    for (const ui of dsObj.units) {
      const unit = m.units.find(u => u.pesIndex === ui);
      const before = unit.segments.length;
      unit.segments = unit.segments.filter(s => s.type !== lib.SEG.WDS);
      if (unit.segments.length !== before) { removed++; markDirty(unit); }
    }
    if (!removed) throw new Error(`no WDS in DS ${ds}`);
    return `DS${ds} WDS removed`;
  },
  'set-wds'(m, [ds, id, x, y, w, h]) {
    const { unit, seg } = findSeg(m, +ds, lib.SEG.WDS);
    seg.decoded.windows = [{ id: +id, x: +x, y: +y, width: +w, height: +h }];
    markDirty(unit);
    return `DS${ds} WDS → #${id}(${x},${y},${w}x${h})`;
  },
  'set-ods-dims'(m, [ds, objIdx, w, h]) {
    const { unit, seg } = findSeg(m, +ds, lib.SEG.ODS, +objIdx);
    const pixels = lib.decodeRLE(lib.unhex(seg.decoded.rleHex), seg.decoded.width, seg.decoded.height);
    // place old pixels into new canvas (top-left), transparent fill
    const np = new Uint8Array(+w * +h);
    for (let y = 0; y < Math.min(+h, seg.decoded.height); y++)
      for (let x = 0; x < Math.min(+w, seg.decoded.width); x++)
        np[y * +w + x] = pixels[y * seg.decoded.width + x];
    setOdsRle(seg, +w, +h, np); markDirty(unit);
    return `DS${ds} ODS#${objIdx} dims → ${w}x${h} (rle ${seg.decoded.rleHex.length / 2}B)`;
  },
  'set-ods-bitmap'(m, [ds, objIdx, png, fitFlag]) {
    const { unit, seg } = findSeg(m, +ds, lib.SEG.ODS, +objIdx);
    const { seg: pds } = findSeg(m, +ds, lib.SEG.PDS);
    const w = seg.decoded.width, h = seg.decoded.height;
    const rgba = pngToRgba(png, w, h, fitFlag === '--fit');
    const px = quantize(rgba, w, h, pds.decoded.entries);
    setOdsRle(seg, w, h, px); markDirty(unit);
    return `DS${ds} ODS#${objIdx} bitmap ← ${path.basename(png)} (${w}x${h}, rle ${seg.decoded.rleHex.length / 2}B)`;
  },
  'replace-palette'(m, [ds, spec]) {
    // spec: "id:Y,Cr,Cb,T;id:Y,Cr,Cb,T;..."  — replaces ALL entries
    const { unit, seg } = findSeg(m, +ds, lib.SEG.PDS);
    const entries = spec.split(';').filter(Boolean).map(part => {
      const [id, rest] = part.split(':');
      const [Y, Cr, Cb, T] = rest.split(',').map(Number);
      return { id: +id, Y, Cr, Cb, T };
    });
    seg.decoded.entries = entries; markDirty(unit);
    return `DS${ds} palette replaced with ${entries.length} entries`;
  },
  'replace-nav'(m, [ds, bog, btn, kind, arg]) {
    const { unit, seg } = findSeg(m, +ds, lib.SEG.ICS);
    const { button } = getButton(seg, +bog, +btn);
    let cmd = Buffer.alloc(12);
    if (kind === 'PLAY_PL') cmd.writeUInt32BE(0x22800000, 0), cmd.writeUInt32BE(+arg, 4);
    else if (kind === 'JUMP_TITLE') cmd.writeUInt32BE(0x21810000, 0), cmd.writeUInt32BE(+arg, 4);
    else if (kind === 'RAW') cmd = lib.unhex(arg.padEnd(24, '0')).subarray(0, 12);
    else throw new Error(`unknown nav kind ${kind}`);
    button.navCmds = [lib.hex(cmd)]; markDirty(unit);
    return `DS${ds} BOG${bog} btn${btn} navCmds → [${kind}(${arg})]`;
  },
  'set-button-count'(m, [ds, n, btnW = 800, btnH = 90, gap = 30, vidW = 1920, vidH = 1080]) {
    n = +n; btnW = +btnW; btnH = +btnH; gap = +gap; vidW = +vidW; vidH = +vidH;
    const { unit: icsUnit, seg: ics } = findSeg(m, +ds, lib.SEG.ICS);
    const page = ics.decoded.pages[0];
    const cur = page.bogs.length;
    if (n < 1) throw new Error('n must be >= 1');
    if (n < cur) {
      page.bogs = page.bogs.slice(0, n);
    } else if (n > cur) {
      const tmpl = page.bogs[cur - 1];
      for (let i = cur; i < n; i++) page.bogs.push(JSON.parse(JSON.stringify(tmpl)));
    }
    // centered vertical layout
    const totalH = n * btnH + (n - 1) * gap;
    const topY = Math.round((vidH - totalH) / 2);
    const btnX = Math.round((vidW - btnW) / 2);
    page.bogs.forEach((bog, i) => {
      const button = bog.buttons[0];
      button.id = i + 1;
      button.numericSelectValue = i + 1;
      button.x = btnX;
      button.y = topY + i * (btnH + gap);
      button.upper = ((i - 1 + n) % n) + 1;
      button.lower = ((i + 1) % n) + 1;
      button.left = i + 1;
      button.right = i + 1;
      button.selStart = i; button.selEnd = i;
      button.actStart = i; button.actEnd = i;
      bog.defaultValidButtonIdRef = i + 1;
    });
    markDirty(icsUnit);
    // trim/extend ODS objects to match (objectId 0..n-1)
    const dsObj = m.displaySets[+ds];
    const odsSegs = [];
    for (const ui of dsObj.units) {
      const u = m.units.find(x => x.pesIndex === ui);
      u.segments.forEach(s => { if (s.type === lib.SEG.ODS) odsSegs.push({ u, s }); });
    }
    if (n < odsSegs.length) {
      // remove trailing ODS objects from their units
      for (let i = n; i < odsSegs.length; i++) {
        const { u, s } = odsSegs[i];
        u.segments = u.segments.filter(x => x !== s);
        markDirty(u);
      }
    } else if (n > odsSegs.length && odsSegs.length > 0) {
      // clone the last ODS into the last ODS unit for the extra objects
      const last = odsSegs[odsSegs.length - 1];
      for (let i = odsSegs.length; i < n; i++) {
        const clone = JSON.parse(JSON.stringify(last.s));
        clone.decoded.objectId = i;
        last.u.segments.push(clone);
        markDirty(last.u);
      }
    }
    return `DS${ds} button count → ${n} (was ${cur}), centered ${btnW}x${btnH}, ODS objs → ${n}`;
  },
  'set-ods-rect'(m, [ds, objIdx, fillIdx = 2, borderIdx = 1, borderPx = 3]) {
    // Solid-fill button with a border, at the ODS's current dims — mirrors
    // menu-builder.renderButtonPixels (the actual bitmap our app emits when no
    // text font is available). Self-contained: no ffmpeg/PNG.
    const { unit, seg } = findSeg(m, +ds, lib.SEG.ODS, +objIdx);
    const w = seg.decoded.width, h = seg.decoded.height;
    fillIdx = +fillIdx; borderIdx = +borderIdx; borderPx = +borderPx;
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const border = x < borderPx || x >= w - borderPx || y < borderPx || y >= h - borderPx;
      px[y * w + x] = border ? borderIdx : fillIdx;
    }
    setOdsRle(seg, w, h, px); markDirty(unit);
    return `DS${ds} ODS#${objIdx} rect fill=${fillIdx} border=${borderIdx}x${borderPx} (${w}x${h}, rle ${seg.decoded.rleHex.length / 2}B)`;
  },
  'set-ods-from'(m, [ds, objIdx, fromPack, fromDs, fromObjIdx]) {
    const { unit, seg } = findSeg(m, +ds, lib.SEG.ODS, +objIdx);
    const fm = loadManifest(fromPack);
    const { seg: fseg } = findSeg(fm, +fromDs, lib.SEG.ODS, +fromObjIdx);
    seg.decoded = JSON.parse(JSON.stringify(fseg.decoded));
    markDirty(unit);
    return `DS${ds} ODS#${objIdx} ← ${fromPack} DS${fromDs} ODS#${fromObjIdx} (${seg.decoded.width}x${seg.decoded.height})`;
  },
};

function main() {
  const [packDir, op, ...args] = process.argv.slice(2);
  if (!packDir || !op || !OPS[op]) {
    console.error('Usage: node mutate.js <packDir> <op> [args...]');
    console.error('Ops: ' + Object.keys(OPS).join(', '));
    process.exit(1);
  }
  const m = loadManifest(packDir);
  const msg = OPS[op](m, args);
  saveManifest(packDir, m);
  console.log(`✓ ${msg}`);
  console.log(`  (run: node repack.js ${packDir} <out.m2ts>)`);
}

if (require.main === module) main();
module.exports = { OPS, findSeg, quantize };
