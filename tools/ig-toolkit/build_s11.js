#!/usr/bin/env node
'use strict';
/**
 * build_s11.js — S10 PLUS a visible normal-state object on EVERY button
 * (the production menu pattern).
 *
 * S10 proved the palette+defSel pattern: the auto-selected button paints, but
 * the others stayed invisible because their normal_state object was 0xFFFF. A
 * real menu needs every button visible at rest, with the selected one
 * distinguished. So each button gets TWO 800×90 ODS objects (normal + selected)
 * with different fill colours.
 *
 * Structure (2 buttons, extensible to N): 4 ODS objects, all set-ods-rect:
 *   obj 0 = btn1 NORMAL   (fill idx 2 blue,      border idx 1 white)
 *   obj 1 = btn1 SELECTED (fill idx 3 highlight, border idx 1 white)
 *   obj 2 = btn2 NORMAL   (fill idx 2 blue,      border idx 1 white)
 *   obj 3 = btn2 SELECTED (fill idx 3 highlight, border idx 1 white)
 * Button refs: btn1 normal=0 sel/act=1 ; btn2 normal=2 sel/act=3.
 *
 * S10 starts with only 2 ODS (one per button, used as selected). `mutate.js`
 * has no "add ODS object" op, so `expandToVisibleNormal()` does it by direct
 * manifest surgery: clone the ODS PES-unit template, renumber object_ids 0..3,
 * reorder DS1 to ICS·PDS·ODS0-3·END (dropping the empty unit Toast left after
 * its 3rd ODS was trimmed), re-fill each via set-ods-rect, set button state refs
 * via set-state, chain the ODS decode PTS/DTS, and re-thread the continuity
 * counter so the whole IG PID stream is contiguous.
 *
 * Everything else is inherited from S10: single DS, opaque palette (T=255),
 * defSel=1, ICS PTS anchored to in_time, navy video.
 *
 * Expected VLC result: BOTH buttons visible — btn1 at (560,435) in the SELECTED
 * (highlight, idx 3) colour, btn2 at (560,555) in the NORMAL (blue, idx 2)
 * colour — visually distinct. That confirms the production pattern end-to-end.
 *
 * Output: ~/Desktop/menu-tests/toast_S11.iso
 *
 * Usage: node build_s11.js
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
const S11 = path.join(WORK, 's11');
const TOAST_MOUNT = '/Volumes/My Movie';
const TOAST_ISO = '/Volumes/Internal SSD/Personal/My Movie.iso';
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const TSMUXER = path.join(__dirname, '..', '..', 'bin', 'tsMuxeR');
const BTN_W = 800, BTN_H = 90, GAP = 30, VID_W = 1920, VID_H = 1080;
// S10 render fix: every entry OPAQUE (T=255). Format id:Y,Cr,Cb,T.
//   0 = background navy (unused by the rect bitmap, opaque anyway)
//   1 = white-ish border  (set-ods-rect borderIdx)
//   2 = blue button fill   (set-ods-rect fillIdx)
//   3 = lighter-blue highlight (distinct from 2; unused by the plain rect)
const OUR_PALETTE = '0:16,128,128,255;1:235,128,128,255;2:80,120,150,255;3:140,120,150,255';

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
// Emit only the given PES units (a single display set), re-timed by offset.
function emitIgTs188(units, igPid, offset) {
  const parts = [];
  for (const u of units) {
    const hdr = Buffer.from(lib.unhex(u.pesHeaderHex));
    const flags2 = hdr[7];
    if (flags2 & 0x80) restampField(hdr, 9, u.pes.pts + offset);
    if ((flags2 & 0x40) && u.pes.dts != null) restampField(hdr, 14, u.pes.dts + offset);
    const body = Buffer.concat(u.segments.map(s => lib.buildSegment(s.type, lib.encodeSegmentBody(s.type, s.decoded))));
    const pesLen = 3 + hdr[8] + body.length;
    hdr.writeUInt16BE(Math.min(pesLen, 0xFFFF), 4);
    const pes = Buffer.concat([hdr, body]);
    const m192 = lib.packetizePesToM2ts(pes, igPid, u.ccStart, u.ats);
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
  const pack = path.join(S11, 'ig.pack');
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
  // S10 render fix: select button id 1 by default (was 0xFFFF). With the now-
  // opaque palette this makes button 1 paint its selected object in VLC.
  OPS['set-defsel'](m, ['1', '1']);
  save(m);
  return m;
}

// Re-thread the continuity counter across an ordered unit list so the IG PID
// stream is contiguous (each unit's ccStart = prev ccStart + prev packet count).
// Packet count mirrors packetizePesToM2ts: ceil(pesBytes / 184).
function rethreadCC(units, startCC = 0) {
  let cc = startCC & 0x0F;
  for (const u of units) {
    u.ccStart = cc;
    const hdr = Buffer.from(lib.unhex(u.pesHeaderHex));
    const body = Buffer.concat(u.segments.map(s => lib.buildSegment(s.type, lib.encodeSegmentBody(s.type, s.decoded))));
    const nPkts = Math.max(1, Math.ceil((hdr.length + body.length) / 184));
    cc = (cc + nPkts) & 0x0F;
  }
}

// Expand DS1 from "one selected-only ODS per button" to a full menu: every
// button gets a visible NORMAL object plus a distinct SELECTED object.
// Mutates `m` in place; returns the ordered DS1 PES units.
function expandToVisibleNormal(m) {
  const DS = 1;
  const dsObj = m.displaySets[DS];
  const units = dsObj.units.map(ui => m.units.find(u => u.pesIndex === ui));
  const icsUnit = units.find(u => u.segments.some(s => s.type === lib.SEG.ICS));
  const pdsUnit = units.find(u => u.segments.some(s => s.type === lib.SEG.PDS));
  const odsUnits = units.filter(u => u.segments.some(s => s.type === lib.SEG.ODS));
  const endUnit = units.find(u => u.segments.some(s => s.type === lib.SEG.END));
  if (odsUnits.length < 2) throw new Error(`expandToVisibleNormal: need >=2 ODS units, got ${odsUnits.length}`);
  if (!icsUnit || !pdsUnit || !endUnit) throw new Error('expandToVisibleNormal: missing ICS/PDS/END');

  // Build exactly 4 ODS PES units: reuse the first two, clone the template twice.
  const tmpl = odsUnits[0];
  let nextPes = Math.max(...m.units.map(u => u.pesIndex)) + 1;
  const ods = [odsUnits[0], odsUnits[1]];
  for (let i = 2; i < 4; i++) {
    const clone = JSON.parse(JSON.stringify(tmpl));
    clone.pesIndex = nextPes++;
    m.units.push(clone);
    ods.push(clone);
  }
  // Each ODS unit must hold exactly one ODS segment with object_id = 0..3.
  ods.forEach((u, i) => {
    const odsSeg = u.segments.find(s => s.type === lib.SEG.ODS);
    u.segments = [odsSeg];
    odsSeg.decoded.objectId = i;
    u.dirty = true;
  });

  // Reorder DS1: ICS, PDS, ODS0..3, END (drops the empty unit Toast left behind).
  const ordered = [icsUnit, pdsUnit, ...ods, endUnit];
  dsObj.units = ordered.map(u => u.pesIndex);

  // Fill: obj0/obj2 = NORMAL (fill idx 2), obj1/obj3 = SELECTED (fill idx 3).
  OPS['set-ods-rect'](m, [String(DS), '0', '2', '1', '3']);
  OPS['set-ods-rect'](m, [String(DS), '1', '3', '1', '3']);
  OPS['set-ods-rect'](m, [String(DS), '2', '2', '1', '3']);
  OPS['set-ods-rect'](m, [String(DS), '3', '3', '1', '3']);

  // Button state refs: btn1 normal=0 sel/act=1 ; btn2 normal=2 sel/act=3.
  OPS['set-state'](m, [String(DS), '0', '0', '0', '0', '1', '1', '1', '1']);
  OPS['set-state'](m, [String(DS), '1', '0', '2', '2', '3', '3', '3', '3']);

  // Chain ODS decode times off the PDS PTS (= ICS DTS): dts_i = pts_{i-1}.
  // Absolute values are shifted to in_time later; only the relative chain matters.
  const base = pdsUnit.pes.pts;
  ods.forEach((u, i) => { u.pes.dts = base + i * 4; u.pes.pts = base + i * 4 + 3; });
  endUnit.pes.dts = null;
  endUnit.pes.pts = base + (ods.length - 1) * 4 + 3;

  // Re-thread CC so the whole DS1 IG stream is contiguous.
  rethreadCC(ordered, icsUnit.ccStart);
  return ordered;
}

function main() {
  fs.rmSync(S11, { recursive: true, force: true });
  fs.mkdirSync(S11, { recursive: true });
  ensureMount();

  // 1. navy menu video → MKV → tsMuxeR
  console.log('S11: generating navy menu video…');
  const mkv = path.join(S11, 'navy.mkv');
  sh(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=c=0x1a1a2e:size=${VID_W}x${VID_H}:rate=24`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-map', '0:v', '-map', '1:a', '-t', '4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '28', '-bf', '2', '-g', '24',
    '-c:a', 'ac3', '-b:a', '192k', mkv], { stdio: ['ignore', 'ignore', 'pipe'] });
  const bdmv = path.join(S11, 'bdmv'); fs.mkdirSync(bdmv, { recursive: true });
  const tp = runTsMuxer(mkv, bdmv);

  // 2. ensure video PES have DTS; get first video PTS
  const videoM2ts = mb.rewriteVideoPesDts(fs.readFileSync(tp.m2ts), 3750);
  const firstVideoPTS = mb.extractFirstVideoPTS(videoM2ts);
  console.log(`S11: firstVideoPTS=${firstVideoPTS}`);

  // 3. S7 IG manifest, expand to visible-normal (4 ODS), keep ONLY DS1.
  const manifest = buildS7Manifest();
  expandToVisibleNormal(manifest);
  const ds1UnitIdx = manifest.displaySets[1].units;
  const ds1Units = ds1UnitIdx.map(i => manifest.units.find(u => u.pesIndex === i));
  console.log(`S11: dropping DS0; emitting DS1 only, ${ds1Units.length} PES units (ICS,PDS,ODS×4,END)`);

  // 4. re-time DS1 so its ICS PTS == in_time (firstVideoPTS), Toast convention.
  const ds1IcsPts = ds1Units.filter(u => u.segments.some(s => s.type === 0x18)).map(u => u.pes.pts);
  const earliestIcsPts = Math.min(...ds1IcsPts);
  const offset = firstVideoPTS - earliestIcsPts;
  console.log(`S11: DS1 ICS PTS=${earliestIcsPts}, offset=${offset} → ICS PTS lands at in_time=${firstVideoPTS} …`);
  const igTs188 = emitIgTs188(ds1Units, manifest.igPid, offset);

  // 5. inject + PMT
  let menuM2ts = mb.injectIGIntoM2ts(videoM2ts, igTs188, 10);
  menuM2ts = mb.patchPmtForIG(menuM2ts);

  // sanity: re-extract the IG from the assembled clip and verify the wiring.
  const chk = lib.extractIg(menuM2ts, 0x1400);
  const allSegs = chk.displaySets[0].units.flatMap(ui => chk.units.find(x => x.pesIndex === ui).segments);
  const odsObjIds = allSegs.filter(s => s.type === 0x15).map(s => s.decoded.objectId);
  const page = allSegs.find(s => s.type === 0x18).decoded.pages[0];
  const btnRefs = page.bogs.map(b => { const x = b.buttons[0]; return `id${x.id} N${x.normalStart} S${x.selStart} A${x.actStart}`; });
  console.log(`S11: re-extract → displaySets=${chk.displaySets.length}, ODS objIds=[${odsObjIds.join(',')}], segRT=${chk.segmentRoundTripOK}`);
  console.log(`S11: buttons → ${btnRefs.join('  |  ')}  defSel=${page.defaultSelectedButtonIdRef}`);
  const icsPts = chk.units.filter(u => u.segments.some(s => s.type === 0x18)).map(u => u.pes.pts);
  console.log(`S11: re-timed ICS PTS = ${icsPts.join(', ')} (in_time≈${firstVideoPTS})`);
  if (chk.displaySets.length !== 1) throw new Error(`S11: expected exactly 1 display set, got ${chk.displaySets.length}`);
  if (odsObjIds.length !== 4 || odsObjIds.join(',') !== '0,1,2,3') throw new Error(`S11: expected 4 ODS objIds 0,1,2,3, got [${odsObjIds.join(',')}]`);
  if (!chk.segmentRoundTripOK) throw new Error('S11: segment round-trip failed');
  const b0 = page.bogs[0].buttons[0], b1 = page.bogs[1].buttons[0];
  if (!(b0.normalStart === 0 && b0.selStart === 1 && b1.normalStart === 2 && b1.selStart === 3))
    throw new Error(`S11: button refs wrong — b0 N${b0.normalStart}/S${b0.selStart} b1 N${b1.normalStart}/S${b1.selStart}`);

  // 6. CLPI/MPLS patched for IG + still, renamed 01200
  const clpi = mb.patchClpiForIG(fs.readFileSync(tp.clpi));
  if (!clpi) throw new Error('patchClpiForIG failed');
  let mpls = mb.patchMplsClipName(fs.readFileSync(tp.mpls), '01200');
  mpls = mb.patchMplsForStill(mb.patchMplsForIG(mpls));

  // 7. assemble tree
  const TREE = path.join(S11, 'tree');
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
  const iso = path.join(MENU_TESTS, 'toast_S11.iso');
  console.log(`S11: hdiutil makehybrid → ${iso}`);
  buildIso(TREE, iso, 'DISC_FORGE');
  console.log(`S11: wrote ${iso} (${(fs.statSync(iso).size / 1e6).toFixed(1)} MB)`);
  console.log(`S11: menu clip 01200.m2ts = ${menuM2ts.length} B (video ${videoM2ts.length} B + IG ${igTs188.length} B TS)`);
}

if (require.main === module) main();
