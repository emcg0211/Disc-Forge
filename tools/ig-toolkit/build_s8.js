#!/usr/bin/env node
'use strict';
/**
 * build_s8.js — Phase 4 final disc: S7's mutated IG on OUR blank navy menu video.
 *
 * S8 = S7 + our video content. Where S0–S7 sit on Toast's menu video (which has
 * Toast's button text baked in), S8 swaps that for a flat navy 0x1a1a2e still.
 * This directly tests the Phase-2 hypothesis: if S7 renders buttons but S8 does
 * not, the working menus depended on text being in the *video*, and our IG
 * (invisible normal-state, selected-only bitmaps) shows nothing without it.
 *
 * Pipeline:
 *   1. ffmpeg navy still + silent AC3 → MKV (B-frames) → tsMuxeR → menu clip m2ts
 *   2. rewriteVideoPesDts; firstVideoPTS = extractFirstVideoPTS
 *   3. rebuild S7 IG (extract Toast menu, apply S1–S6 mutations)
 *   4. re-time every IG PES PTS/DTS by offset = firstVideoPTS − earliest IG DTS,
 *      preserving Toast's exact PES marker nibbles (incl. the 0x0 DTS nibble)
 *   5. inject 188-byte IG TS into the navy m2ts; patchPmtForIG
 *   6. CLPI/MPLS from tsMuxeR, patched for IG + infinite still, renamed 01200
 *   7. assemble Toast tree with new 01200.{m2ts,clpi,mpls} (+00002 from S7)
 *   8. hdiutil makehybrid -udf → ~/Desktop/toast_S8.iso
 *
 * Usage: node build_s8.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const lib = require('./lib');
const { OPS } = require('./mutate');
const { buildIso } = require('./repack');
const mb = require('../../src/lib/menu-builder');

const DESKTOP = path.join(os.homedir(), 'Desktop');
const MENU_TESTS = path.join(DESKTOP, 'menu-tests');
const WORK = '/tmp/igtk_phase4';
const S8 = path.join(WORK, 's8');
const TOAST_MOUNT = '/Volumes/My Movie';
const TOAST_ISO = '/Volumes/Internal SSD/Personal/My Movie.iso';
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const TSMUXER = path.join(__dirname, '..', '..', 'bin', 'tsMuxeR');
const BTN_W = 800, BTN_H = 90, GAP = 30, VID_W = 1920, VID_H = 1080;
const OUR_PALETTE = '0:16,128,128,255;1:235,128,128,0;2:112,184,42,0;3:45,103,171,0';

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || '').toString().slice(-600)}`);
  return r;
}
function ensureMount() {
  if (!fs.existsSync(path.join(TOAST_MOUNT, 'BDMV'))) sh('hdiutil', ['attach', TOAST_ISO, '-readonly', '-nobrowse']);
}

// ── re-time IG: rewrite each PES PTS/DTS by offset, preserve marker nibbles ──
function restampField(hdr, off, v) {
  // preserve the original 4-bit prefix nibble (hdr[off] high nibble), rewrite value
  lib.encodeTimestamp(v, hdr[off] >> 4).copy(hdr, off);
}
function emitIgTs188(manifest, offset) {
  const parts = [];
  for (const u of manifest.units) {
    const hdr = Buffer.from(lib.unhex(u.pesHeaderHex));
    const flags2 = hdr[7];
    if (flags2 & 0x80) restampField(hdr, 9, u.pes.pts + offset);
    if ((flags2 & 0x40) && u.pes.dts != null) restampField(hdr, 14, u.pes.dts + offset);
    const body = Buffer.concat(u.segments.map(s => lib.buildSegment(s.type, lib.encodeSegmentBody(s.type, s.decoded))));
    const pesLen = 3 + hdr[8] + body.length;
    hdr.writeUInt16BE(Math.min(pesLen, 0xFFFF), 4);
    const pes = Buffer.concat([hdr, body]);
    const m192 = lib.packetizePesToM2ts(pes, manifest.igPid, u.ccStart, u.ats);
    // strip 4-byte ATS → 188-byte TS
    const n = m192.length / 192;
    const ts = Buffer.alloc(n * 188);
    for (let i = 0; i < n; i++) m192.copy(ts, i * 188, i * 192 + 4, i * 192 + 192);
    parts.push(ts);
  }
  return Buffer.concat(parts);
}

function runTsMuxer(mkv, outBdmv) {
  const meta = mkv + '.meta';
  fs.writeFileSync(meta,
    `MUXOPT --no-pcr-on-video-pid --new-audio-pes --blu-ray\n` +
    `V_MPEG4/ISO/AVC, "${mkv}", track=1, level=4.1, insertSEI, contSPS, lang=und, fps=24\n` +
    `A_AC3, "${mkv}", track=2, lang=und\n`);
  sh(TSMUXER, [meta, outBdmv], { stdio: ['ignore', 'ignore', 'pipe'] });
  const streamDir = path.join(outBdmv, 'BDMV', 'STREAM');
  const base = fs.readdirSync(streamDir).filter(f => f.endsWith('.m2ts')).sort()[0].replace('.m2ts', '');
  return {
    m2ts: path.join(streamDir, `${base}.m2ts`),
    clpi: path.join(outBdmv, 'BDMV', 'CLIPINF', `${base}.clpi`),
    mpls: path.join(outBdmv, 'BDMV', 'PLAYLIST', `${base}.mpls`),
  };
}

function buildS7Manifest() {
  // extract Toast menu → apply S1–S6 (the IG content of S7; S7 itself adds no IG change)
  const pack = path.join(S8, 'ig.pack');
  fs.rmSync(pack, { recursive: true, force: true });
  const menu = path.join(TOAST_MOUNT, 'BDMV', 'STREAM', '01200.m2ts');
  execFileSync('node', [path.join(__dirname, 'extract.js'), menu, pack], { stdio: 'ignore' });
  const load = () => JSON.parse(fs.readFileSync(path.join(pack, 'manifest.json'), 'utf8'));
  const save = (m) => fs.writeFileSync(path.join(pack, 'manifest.json'), JSON.stringify(m));
  let m = load();
  // S1 bitmaps
  for (let i = 0; i < 3; i++) OPS['set-ods-rect'](m, ['1', String(i), '2', '1', '3']);
  // S2 dims
  for (let i = 0; i < 3; i++) { OPS['set-ods-dims'](m, ['1', String(i), String(BTN_W), String(BTN_H)]); OPS['set-ods-rect'](m, ['1', String(i), '2', '1', '3']); }
  // S3 positions (N=3)
  { const n = 3, tH = n * BTN_H + (n - 1) * GAP, topY = Math.round((VID_H - tH) / 2), bx = Math.round((VID_W - BTN_W) / 2);
    for (let i = 0; i < 3; i++) OPS['set-button-pos'](m, ['1', String(i), '0', String(bx), String(topY + i * (BTN_H + GAP))]); }
  // S4 palette
  OPS['replace-palette'](m, ['1', OUR_PALETTE]);
  for (let i = 0; i < 3; i++) OPS['set-ods-rect'](m, ['1', String(i), '2', '1', '3']);
  // S5 count → 2
  OPS['set-button-count'](m, ['1', '2', String(BTN_W), String(BTN_H), String(GAP), String(VID_W), String(VID_H)]);
  // S6 nav
  OPS['replace-nav'](m, ['1', '0', '0', 'PLAY_PL', '1']);
  OPS['replace-nav'](m, ['1', '1', '0', 'PLAY_PL', '2']);
  save(m);
  return m;
}

function main() {
  fs.rmSync(S8, { recursive: true, force: true });
  fs.mkdirSync(S8, { recursive: true });
  ensureMount();

  // 1. navy menu video → MKV → tsMuxeR
  console.log('S8: generating navy menu video…');
  const mkv = path.join(S8, 'navy.mkv');
  sh(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=c=0x1a1a2e:size=${VID_W}x${VID_H}:rate=24`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-map', '0:v', '-map', '1:a', '-t', '4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '28', '-bf', '2', '-g', '24',
    '-c:a', 'ac3', '-b:a', '192k', mkv], { stdio: ['ignore', 'ignore', 'pipe'] });
  const bdmv = path.join(S8, 'bdmv'); fs.mkdirSync(bdmv, { recursive: true });
  const tp = runTsMuxer(mkv, bdmv);

  // 2. ensure video PES have DTS; get first video PTS
  const videoM2ts = mb.rewriteVideoPesDts(fs.readFileSync(tp.m2ts), 3750);
  const firstVideoPTS = mb.extractFirstVideoPTS(videoM2ts);
  console.log(`S8: firstVideoPTS=${firstVideoPTS}`);

  // 3. S7 IG manifest
  const manifest = buildS7Manifest();

  // 4. re-time: align earliest ICS *PTS* to firstVideoPTS (Toast's convention).
  //    Toast (measured on S7) puts the ICS PTS exactly at the clip in_time and
  //    its DTS 12012 ticks earlier; PDS/ODS land a hair before in_time, which the
  //    m2ts_filter allows for non-composition segments. The earlier code anchored
  //    the earliest *DTS* to firstVideoPTS, which pushed ICS PTS 12012 ticks LATE
  //    (DTS==in_time instead of PTS==in_time). See docs/menu_research_progress.md
  //    "S8 VLC failure — root cause", Finding B.
  const icsPtsAll = manifest.units
    .filter(u => u.segments.some(s => s.type === 0x18))
    .map(u => u.pes.pts);
  const earliestIcsPts = Math.min(...icsPtsAll);
  const offset = firstVideoPTS - earliestIcsPts;
  console.log(`S8: earliest ICS PTS=${earliestIcsPts}, offset=${offset} → DS0 ICS PTS lands at in_time=${firstVideoPTS} (Toast model) …`);
  const igTs188 = emitIgTs188(manifest, offset);

  // 5. inject + PMT
  let menuM2ts = mb.injectIGIntoM2ts(videoM2ts, igTs188, 10);
  menuM2ts = mb.patchPmtForIG(menuM2ts);

  // sanity: re-extract the IG from the assembled clip
  const chk = lib.extractIg(menuM2ts, 0x1400);
  const seg = ds => chk.displaySets[ds] ? chk.displaySets[ds].units.flatMap(ui => chk.units.find(x => x.pesIndex === ui).segments) : [];
  const ds1btn = seg(1).length ? seg(1).find(s => s.type === 0x18).decoded.pages[0].bogs.reduce((n, b) => n + b.buttons.length, 0) : 0;
  console.log(`S8: injected IG re-extracts → displaySets=${chk.displaySets.length}, DS1 buttons=${ds1btn}, segRT=${chk.segmentRoundTripOK}`);
  const icsPts = chk.units.filter(u => u.segments.some(s => s.type === 0x18)).map(u => u.pes.pts);
  console.log(`S8: re-timed ICS PTS = ${icsPts.join(', ')} (in_time≈${firstVideoPTS})`);

  // 6. CLPI/MPLS patched for IG + still, renamed 01200
  const clpi = mb.patchClpiForIG(fs.readFileSync(tp.clpi));
  if (!clpi) throw new Error('patchClpiForIG failed');
  let mpls = mb.patchMplsClipName(fs.readFileSync(tp.mpls), '01200');
  mpls = mb.patchMplsForStill(mb.patchMplsForIG(mpls));

  // 7. assemble tree
  const TREE = path.join(S8, 'tree');
  fs.mkdirSync(TREE, { recursive: true });
  fs.cpSync(path.join(TOAST_MOUNT, 'BDMV'), path.join(TREE, 'BDMV'), { recursive: true });
  sh('chmod', ['-R', 'u+w', TREE]);
  fs.writeFileSync(path.join(TREE, 'BDMV', 'STREAM', '01200.m2ts'), menuM2ts);
  fs.writeFileSync(path.join(TREE, 'BDMV', 'CLIPINF', '01200.clpi'), clpi);
  fs.writeFileSync(path.join(TREE, 'BDMV', 'PLAYLIST', '01200.mpls'), mpls);
  // 00002 (from S7) so PLAY_PL(2) resolves
  fs.copyFileSync(path.join(TREE, 'BDMV', 'PLAYLIST', '00001.mpls'), path.join(TREE, 'BDMV', 'PLAYLIST', '00002.mpls'));
  fs.copyFileSync(path.join(TREE, 'BDMV', 'CLIPINF', '00001.clpi'), path.join(TREE, 'BDMV', 'CLIPINF', '00002.clpi'));

  // 8. ISO
  fs.mkdirSync(MENU_TESTS, { recursive: true });
  const iso = path.join(MENU_TESTS, 'toast_S8.iso');
  console.log(`S8: hdiutil makehybrid → ${iso}`);
  buildIso(TREE, iso, 'DISC_FORGE');
  console.log(`S8: wrote ${iso} (${(fs.statSync(iso).size / 1e6).toFixed(1)} MB)`);
  console.log(`S8: menu clip 01200.m2ts = ${menuM2ts.length} B (video ${videoM2ts.length} B + IG ${igTs188.length} B TS)`);
}

if (require.main === module) main();
