#!/usr/bin/env node
'use strict';
/**
 * diff.js — structural IG comparison of two m2ts (or pack) inputs.
 *
 * Usage:
 *   node diff.js <a.m2ts|a.pack> <b.m2ts|b.pack> [--pid 0x1400]
 *
 * Aligns display sets → PES units → segments by index and reports every IG
 * structural field, classified as:
 *   =  identical
 *   ~  content-different  (same structure, different value)
 *   !  structurally-different (counts/types/presence differ)
 *
 * Designed for the Toast-mutation bisection: shows exactly which dimension a
 * candidate disc changed relative to the reference.
 */

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

function loadIg(input, pid) {
  let buf, igPid = pid;
  if (fs.statSync(input).isDirectory()) {
    const m = JSON.parse(fs.readFileSync(path.join(input, 'manifest.json'), 'utf8'));
    buf = fs.readFileSync(path.join(input, 'source.m2ts'));
    if (igPid === undefined) igPid = m.igPid;
  } else {
    buf = fs.readFileSync(input);
  }
  return lib.extractIg(buf, igPid);
}

const rows = [];
function row(cls, label, a, b) { rows.push({ cls, label, a, b }); }
function cmp(label, a, b) {
  if (a === undefined && b === undefined) return;
  if (a === b) row('=', label, a, b);
  else row('~', label, a, b);
}
function struct(label, a, b) {
  if (a !== b) row('!', label, a, b);
  else row('=', label, a, b);
}

function diffButton(prefix, A, B) {
  if (!A || !B) { row('!', prefix, A ? 'present' : 'absent', B ? 'present' : 'absent'); return; }
  cmp(`${prefix}.id`, A.id, B.id);
  cmp(`${prefix}.pos`, `${A.x},${A.y}`, `${B.x},${B.y}`);
  cmp(`${prefix}.numericSelect`, A.numericSelectValue, B.numericSelectValue);
  cmp(`${prefix}.autoAction`, A.autoAction, B.autoAction);
  cmp(`${prefix}.neighbors`, `${A.upper}/${A.lower}/${A.left}/${A.right}`, `${B.upper}/${B.lower}/${B.left}/${B.right}`);
  cmp(`${prefix}.normalObj`, `${A.normalStart}-${A.normalEnd}`, `${B.normalStart}-${B.normalEnd}`);
  cmp(`${prefix}.selObj`, `${A.selStart}-${A.selEnd}`, `${B.selStart}-${B.selEnd}`);
  cmp(`${prefix}.actObj`, `${A.actStart}-${A.actEnd}`, `${B.actStart}-${B.actEnd}`);
  cmp(`${prefix}.selSound`, A.selSound, B.selSound);
  cmp(`${prefix}.actSound`, A.actSound, B.actSound);
  struct(`${prefix}.navCount`, A.navCmds.length, B.navCmds.length);
  for (let i = 0; i < Math.max(A.navCmds.length, B.navCmds.length); i++)
    cmp(`${prefix}.nav[${i}]`, A.navCmds[i], B.navCmds[i]);
}

function diffICS(prefix, A, B) {
  cmp(`${prefix}.video`, `${A.videoWidth}x${A.videoHeight}`, `${B.videoWidth}x${B.videoHeight}`);
  cmp(`${prefix}.frameRate`, A.frameRate, B.frameRate);
  cmp(`${prefix}.compNumber`, A.compNumber, B.compNumber);
  cmp(`${prefix}.compState`, A.compState, B.compState);
  cmp(`${prefix}.streamModel`, A.streamModel, B.streamModel);
  cmp(`${prefix}.uiModel`, A.uiModel, B.uiModel);
  cmp(`${prefix}.compTimeoutPts`, A.compTimeoutPts, B.compTimeoutPts);
  cmp(`${prefix}.selTimeoutPts`, A.selTimeoutPts, B.selTimeoutPts);
  cmp(`${prefix}.userTimeout`, A.userTimeout, B.userTimeout);
  struct(`${prefix}.numPages`, A.pages.length, B.pages.length);
  const pA = A.pages[0] || {}, pB = B.pages[0] || {};
  cmp(`${prefix}.page0.defSel`, pA.defaultSelectedButtonIdRef, pB.defaultSelectedButtonIdRef);
  cmp(`${prefix}.page0.defAct`, pA.defaultActivatedButtonIdRef, pB.defaultActivatedButtonIdRef);
  cmp(`${prefix}.page0.palRef`, pA.paletteIdRef, pB.paletteIdRef);
  cmp(`${prefix}.page0.animFps`, pA.animFps, pB.animFps);
  cmp(`${prefix}.page0.uoMask`, pA.uoMask, pB.uoMask);
  cmp(`${prefix}.page0.inEffects`, pA.inEffectsHex, pB.inEffectsHex);
  cmp(`${prefix}.page0.outEffects`, pA.outEffectsHex, pB.outEffectsHex);
  const bA = pA.bogs || [], bB = pB.bogs || [];
  struct(`${prefix}.page0.numBogs`, bA.length, bB.length);
  for (let i = 0; i < Math.max(bA.length, bB.length); i++) {
    const gA = bA[i] || { buttons: [] }, gB = bB[i] || { buttons: [] };
    cmp(`${prefix}.bog[${i}].defValid`, gA.defaultValidButtonIdRef, gB.defaultValidButtonIdRef);
    struct(`${prefix}.bog[${i}].numButtons`, gA.buttons.length, gB.buttons.length);
    for (let j = 0; j < Math.max(gA.buttons.length, gB.buttons.length); j++)
      diffButton(`${prefix}.bog[${i}].btn[${j}]`, gA.buttons[j], gB.buttons[j]);
  }
}

function diffSegment(prefix, sA, sB) {
  if (!sA || !sB) { row('!', `${prefix} present`, sA ? sA.name : 'absent', sB ? sB.name : 'absent'); return; }
  struct(`${prefix}.type`, sA.name, sB.name);
  if (sA.type !== sB.type) return;
  const a = sA.decoded, b = sB.decoded;
  switch (sA.type) {
    case lib.SEG.ICS: diffICS(prefix, a, b); break;
    case lib.SEG.PDS:
      cmp(`${prefix}.paletteId`, a.paletteId, b.paletteId);
      struct(`${prefix}.entries`, a.entries.length, b.entries.length);
      cmp(`${prefix}.entriesHash`, JSON.stringify(a.entries), JSON.stringify(b.entries));
      break;
    case lib.SEG.WDS:
      struct(`${prefix}.numWindows`, a.windows.length, b.windows.length);
      cmp(`${prefix}.windows`, JSON.stringify(a.windows), JSON.stringify(b.windows));
      break;
    case lib.SEG.ODS:
      cmp(`${prefix}.objectId`, a.objectId, b.objectId);
      cmp(`${prefix}.dims`, `${a.width}x${a.height}`, `${b.width}x${b.height}`);
      cmp(`${prefix}.dataLen`, a.dataLen, b.dataLen);
      cmp(`${prefix}.rle`, a.rleHex, b.rleHex);
      break;
  }
}

function flatSegs(r) {
  // [{ds, segIdxInDs, seg, pts, dts}]
  const out = [];
  r.displaySets.forEach((ds, di) => {
    let k = 0;
    ds.units.forEach(ui => {
      const u = r.units.find(x => x.pesIndex === ui);
      u.segments.forEach(s => out.push({ ds: di, k: k++, seg: s, pts: u.pes.pts, dts: u.pes.dts }));
    });
  });
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  let pid;
  const pi = argv.indexOf('--pid');
  if (pi >= 0) { pid = argv[pi + 1].startsWith('0x') ? parseInt(argv[pi + 1], 16) : parseInt(argv[pi + 1], 10); argv.splice(pi, 2); }
  const [A, B] = argv;
  if (!A || !B) { console.error('Usage: node diff.js <a> <b> [--pid 0x1400]'); process.exit(1); }
  const ra = loadIg(A, pid), rb = loadIg(B, pid);

  struct('numDisplaySets', ra.displaySets.length, rb.displaySets.length);
  struct('igPid', '0x' + ra.igPid.toString(16), '0x' + rb.igPid.toString(16));

  const fa = flatSegs(ra), fb = flatSegs(rb);
  const max = Math.max(fa.length, fb.length);
  for (let i = 0; i < max; i++) {
    const A = fa[i], B = fb[i];
    const label = `DS${(A || B).ds}.seg${(A || B).k}[${A ? A.seg.name : '∅'}/${B ? B.seg.name : '∅'}]`;
    if (A && B) {
      cmp(`${label}.PTS`, A.pts, B.pts);
      cmp(`${label}.DTS`, A.dts, B.dts);
    }
    diffSegment(label, A && A.seg, B && B.seg);
  }

  // print
  const counts = { '=': 0, '~': 0, '!': 0 };
  for (const r of rows) counts[r.cls]++;
  console.log(`A = ${A}`);
  console.log(`B = ${B}\n`);
  for (const r of rows) {
    if (r.cls === '=') continue; // show only differences by default
    console.log(`${r.cls} ${r.label}`);
    console.log(`    A: ${r.a}`);
    console.log(`    B: ${r.b}`);
  }
  console.log(`\nidentical=${counts['=']}  content-diff=${counts['~']}  structural-diff=${counts['!']}`);
  if (counts['~'] === 0 && counts['!'] === 0) console.log('→ IG structurally identical.');
}

if (require.main === module) main();
module.exports = { loadIg };
