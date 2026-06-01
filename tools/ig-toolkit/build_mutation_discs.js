#!/usr/bin/env node
'use strict';
/**
 * build_mutation_discs.js — Phase 4: produce the Toast-mutation bisection discs.
 *
 * Starts from Toast's working menu and mutates DS1 one dimension at a time toward
 * our content, leaving DS0 (Toast's original 1-button composition) UNTOUCHED as an
 * in-disc control. Each step yields a full burnable ISO + a diff vs the prior step.
 *
 * Steps:
 *   S0  Toast unmodified (lossless extract→repack→ISO)              [GATE]
 *   S1  our button BITMAPS (Toast dims/positions/palette/count)
 *   S2  + our DIMENSIONS (800x90, re-RLE)
 *   S3  + our POSITIONS (centered, N=3 layout)
 *   S4  + our PALETTE (4 entries; bitmaps re-quantized to it)
 *   S5  + our BUTTON COUNT (3 → 2, repositioned to N=2 layout, ODS trimmed)
 *   S6  + our NAV COMMANDS (PLAY_PL(1)/PLAY_PL(2))
 *   S7  + our PLAYLIST/CLIPINF (add 00002 so PLAY_PL(2) resolves)
 *
 * S8 (our video content) is specified in docs/toast_mutation_plan.md and built
 * separately: it requires re-muxing the menu video and re-timing the IG, which
 * reintroduces the integration variable the bisection isolates — best done once
 * S0–S7 hardware results identify where rendering breaks.
 *
 * Usage: node build_mutation_discs.js
 * All synchronous. Outputs ~/Desktop/toast_S{0..7}.iso and .diff.txt.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const lib = require('./lib');
const { OPS } = require('./mutate');
const { repack, buildIso } = require('./repack');

const DESKTOP = path.join(os.homedir(), 'Desktop');
const WORK = '/tmp/igtk_phase4';
const TOAST_MOUNT = '/Volumes/My Movie';
const TOAST_ISO = '/Volumes/Internal SSD/Personal/My Movie.iso';
const FONT = '/System/Library/Fonts/Supplemental/Arial.ttf';

// our content parameters (from src/lib/menu-builder.js)
const BTN_W = 800, BTN_H = 90, GAP = 30, VID_W = 1920, VID_H = 1080;
const OUR_PALETTE = '0:16,128,128,255;1:235,128,128,0;2:112,184,42,0;3:45,103,171,0';

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || '').slice(-500)}`);
  return r;
}

function ensureMount() {
  if (!fs.existsSync(path.join(TOAST_MOUNT, 'BDMV'))) {
    sh('hdiutil', ['attach', TOAST_ISO, '-readonly', '-nobrowse']);
  }
}

function loadManifest(pack) { return JSON.parse(fs.readFileSync(path.join(pack, 'manifest.json'), 'utf8')); }
function saveManifest(pack, m) { fs.writeFileSync(path.join(pack, 'manifest.json'), JSON.stringify(m, null, 2)); }

function diffM2ts(a, b, outFile) {
  const r = spawnSync('node', [path.join(__dirname, 'diff.js'), a, b, '--pid', '0x1400'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(outFile, (r.stdout || '') + (r.stderr || ''));
  return r.stdout || '';
}

// ── mutation step definitions (cumulative; each takes the working pack) ──────
// Our button bitmap = solid 'selected' fill (palette idx 2) + white border (idx 1),
// matching menu-builder.renderButtonPixels (the bitmap our app emits w/o a text font).
const STEPS = {
  S0: () => { /* unmodified */ },
  S1: (m) => {
    for (let i = 0; i < 3; i++) OPS['set-ods-rect'](m, ['1', String(i), '2', '1', '3']);
  },
  S2: (m) => {
    for (let i = 0; i < 3; i++) {
      OPS['set-ods-dims'](m, ['1', String(i), String(BTN_W), String(BTN_H)]);
      OPS['set-ods-rect'](m, ['1', String(i), '2', '1', '3']);
    }
  },
  S3: (m) => {
    const n = 3, totalH = n * BTN_H + (n - 1) * GAP, topY = Math.round((VID_H - totalH) / 2), btnX = Math.round((VID_W - BTN_W) / 2);
    for (let i = 0; i < 3; i++) OPS['set-button-pos'](m, ['1', String(i), '0', String(btnX), String(topY + i * (BTN_H + GAP))]);
  },
  S4: (m) => {
    OPS['replace-palette'](m, ['1', OUR_PALETTE]);
    for (let i = 0; i < 3; i++) OPS['set-ods-rect'](m, ['1', String(i), '2', '1', '3']); // re-render in our palette indices
  },
  S5: (m) => {
    OPS['set-button-count'](m, ['1', '2', String(BTN_W), String(BTN_H), String(GAP), String(VID_W), String(VID_H)]);
  },
  S6: (m) => {
    OPS['replace-nav'](m, ['1', '0', '0', 'PLAY_PL', '1']);
    OPS['replace-nav'](m, ['1', '1', '0', 'PLAY_PL', '2']);
  },
  S7: () => { /* disc-level: handled in main (add 00002 playlist/clipinf); IG unchanged */ },
};

function main() {
  fs.mkdirSync(WORK, { recursive: true });
  ensureMount();

  // working BDMV tree (copy Toast once)
  const TREE = path.join(WORK, 'tree');
  if (!fs.existsSync(path.join(TREE, 'BDMV', 'index.bdmv'))) {
    console.log('Copying Toast BDMV tree (≈626MB)…');
    fs.rmSync(TREE, { recursive: true, force: true });
    fs.mkdirSync(TREE, { recursive: true });
    fs.cpSync(path.join(TOAST_MOUNT, 'BDMV'), path.join(TREE, 'BDMV'), { recursive: true });
    // make writable (Toast files are read-only)
    sh('chmod', ['-R', 'u+w', TREE]);
  }
  const menuM2tsPath = path.join(TREE, 'BDMV', 'STREAM', '01200.m2ts');
  // Always seed from the PRISTINE Toast menu (the tree may hold a prior run's
  // mutated menu) and reset any prior-run disc-level additions, so reruns are clean.
  const origMenu = fs.readFileSync(path.join(TOAST_MOUNT, 'BDMV', 'STREAM', '01200.m2ts'));
  fs.writeFileSync(menuM2tsPath, origMenu);
  for (const f of ['PLAYLIST/00002.mpls', 'CLIPINF/00002.clpi']) {
    const p = path.join(TREE, 'BDMV', f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  // base pack from the pristine Toast menu
  const pack = path.join(WORK, 'work.pack');
  fs.rmSync(pack, { recursive: true, force: true });
  execFileSync('node', [path.join(__dirname, 'extract.js'), menuM2tsPath, pack], { stdio: 'ignore' });

  const order = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];
  let prevM2ts = path.join(WORK, 'toast_orig.m2ts');
  fs.writeFileSync(prevM2ts, origMenu);
  const summary = [];

  for (const step of order) {
    console.log(`\n── ${step} ──`);
    // apply cumulative IG mutation (S7 has none)
    const m = loadManifest(pack);
    STEPS[step](m);
    saveManifest(pack, m);

    // repack menu m2ts
    const repacked = repack(pack, false);
    const stepM2ts = path.join(WORK, `${step}.m2ts`);
    fs.writeFileSync(stepM2ts, repacked);
    fs.writeFileSync(menuM2tsPath, repacked);

    // S7: disc-level playlist/clipinf addition
    if (step === 'S7') {
      const plDir = path.join(TREE, 'BDMV', 'PLAYLIST');
      const clDir = path.join(TREE, 'BDMV', 'CLIPINF');
      fs.copyFileSync(path.join(plDir, '00001.mpls'), path.join(plDir, '00002.mpls'));
      fs.copyFileSync(path.join(clDir, '00001.clpi'), path.join(clDir, '00002.clpi'));
    }

    // build ISO
    const iso = path.join(DESKTOP, `toast_${step}.iso`);
    console.log(`  xorriso → ${iso}`);
    buildIso(TREE, iso, 'DISC_FORGE');
    const isoSize = fs.statSync(iso).size;

    // diff vs previous step
    const diffFile = path.join(DESKTOP, `toast_${step}.diff.txt`);
    const dout = diffM2ts(prevM2ts, stepM2ts, diffFile);
    const lastLine = dout.trim().split('\n').filter(Boolean).pop() || '';
    console.log(`  diff vs prev: ${lastLine}`);
    summary.push({ step, isoSize, m2tsSize: repacked.length, diffSummary: lastLine });
    prevM2ts = stepM2ts;
  }

  // S0 gate: byte-identity of menu m2ts vs Toast original
  const s0 = fs.readFileSync(path.join(WORK, 'S0.m2ts'));
  console.log(`\n=== S0 gate: menu m2ts byte-identical to Toast original: ${s0.equals(origMenu)} ===`);

  console.log('\n=== SUMMARY ===');
  summary.forEach(s => console.log(`  toast_${s.step}.iso  ${(s.isoSize / 1e6).toFixed(1)}MB  menu m2ts ${s.m2tsSize}B  | diff: ${s.diffSummary}`));
  fs.writeFileSync(path.join(WORK, 'summary.json'), JSON.stringify(summary, null, 2));
}

if (require.main === module) main();
