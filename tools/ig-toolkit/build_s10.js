#!/usr/bin/env node
'use strict';
/**
 * build_s10.js — S9 (single-DS) PLUS the render-layer fix (Finding C).
 *
 * S9 fixed the timing (Finding B) and structural non-consumed (Finding A) bugs
 * but still showed navy/no-buttons in VLC because the IG objects are invisible:
 * the button-fill palette entries had alpha T=0, and default_selected_button_id_ref
 * was 0xFFFF. See docs/menu_research_progress.md "Finding C".
 *
 * S10 keeps S9's structure (single DS1, our 2 buttons, ICS PTS anchored to
 * in_time, navy video) and applies the two render fixes:
 *   - **Opaque palette:** all 4 entries T=255. set-ods-rect fills the button
 *     body at index 2 and the border at index 1, so those two MUST be opaque;
 *     idx 0/3 are opaque too as sensible defaults.
 *   - **default_selected_button_id_ref = 1** (button id 1, first valid button).
 *
 * Expected VLC result: button 1 paints (opaque blue fill + white border) on the
 * navy background; button 2 stays invisible (its normal_state object is 0xFFFF
 * and it is not selected) — which confirms the auto-select fallback and shows
 * that production needs a visible normal-state object for every button.
 *
 * Output: ~/Desktop/menu-tests/toast_S10.iso
 *
 * Usage: node build_s10.js
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
const S10 = path.join(WORK, 's10');
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
  const pack = path.join(S10, 'ig.pack');
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

function main() {
  fs.rmSync(S10, { recursive: true, force: true });
  fs.mkdirSync(S10, { recursive: true });
  ensureMount();

  // 1. navy menu video → MKV → tsMuxeR
  console.log('S10: generating navy menu video…');
  const mkv = path.join(S10, 'navy.mkv');
  sh(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=c=0x1a1a2e:size=${VID_W}x${VID_H}:rate=24`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-map', '0:v', '-map', '1:a', '-t', '4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '28', '-bf', '2', '-g', '24',
    '-c:a', 'ac3', '-b:a', '192k', mkv], { stdio: ['ignore', 'ignore', 'pipe'] });
  const bdmv = path.join(S10, 'bdmv'); fs.mkdirSync(bdmv, { recursive: true });
  const tp = runTsMuxer(mkv, bdmv);

  // 2. ensure video PES have DTS; get first video PTS
  const videoM2ts = mb.rewriteVideoPesDts(fs.readFileSync(tp.m2ts), 3750);
  const firstVideoPTS = mb.extractFirstVideoPTS(videoM2ts);
  console.log(`S10: firstVideoPTS=${firstVideoPTS}`);

  // 3. S7 IG manifest, then keep ONLY DS1 (our real 2-button menu).
  const manifest = buildS7Manifest();
  const ds1UnitIdx = manifest.displaySets[1].units;            // [4,5,6,7,8,9]
  const ds1Units = ds1UnitIdx.map(i => manifest.units.find(u => u.pesIndex === i));
  console.log(`S10: dropping DS0 (Toast vestigial 1-btn glyph); emitting DS1 only, ${ds1Units.length} PES units`);

  // 4. re-time DS1 so its ICS PTS == in_time (firstVideoPTS), Toast convention.
  const ds1IcsPts = ds1Units.filter(u => u.segments.some(s => s.type === 0x18)).map(u => u.pes.pts);
  const earliestIcsPts = Math.min(...ds1IcsPts);
  const offset = firstVideoPTS - earliestIcsPts;
  console.log(`S10: DS1 ICS PTS=${earliestIcsPts}, offset=${offset} → ICS PTS lands at in_time=${firstVideoPTS} …`);
  const igTs188 = emitIgTs188(ds1Units, manifest.igPid, offset);

  // 5. inject + PMT
  let menuM2ts = mb.injectIGIntoM2ts(videoM2ts, igTs188, 10);
  menuM2ts = mb.patchPmtForIG(menuM2ts);

  // sanity: re-extract the IG from the assembled clip (expect a SINGLE display set)
  const chk = lib.extractIg(menuM2ts, 0x1400);
  const seg = ds => chk.displaySets[ds] ? chk.displaySets[ds].units.flatMap(ui => chk.units.find(x => x.pesIndex === ui).segments) : [];
  const ds0btn = seg(0).length ? seg(0).find(s => s.type === 0x18).decoded.pages[0].bogs.reduce((n, b) => n + b.buttons.length, 0) : 0;
  console.log(`S10: injected IG re-extracts → displaySets=${chk.displaySets.length}, DS0 buttons=${ds0btn}, segRT=${chk.segmentRoundTripOK}`);
  const icsPts = chk.units.filter(u => u.segments.some(s => s.type === 0x18)).map(u => u.pes.pts);
  console.log(`S10: re-timed ICS PTS = ${icsPts.join(', ')} (in_time≈${firstVideoPTS})`);
  if (chk.displaySets.length !== 1) throw new Error(`S10: expected exactly 1 display set, got ${chk.displaySets.length}`);

  // 6. CLPI/MPLS patched for IG + still, renamed 01200
  const clpi = mb.patchClpiForIG(fs.readFileSync(tp.clpi));
  if (!clpi) throw new Error('patchClpiForIG failed');
  let mpls = mb.patchMplsClipName(fs.readFileSync(tp.mpls), '01200');
  mpls = mb.patchMplsForStill(mb.patchMplsForIG(mpls));

  // 7. assemble tree
  const TREE = path.join(S10, 'tree');
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
  const iso = path.join(MENU_TESTS, 'toast_S10.iso');
  console.log(`S10: hdiutil makehybrid → ${iso}`);
  buildIso(TREE, iso, 'DISC_FORGE');
  console.log(`S10: wrote ${iso} (${(fs.statSync(iso).size / 1e6).toFixed(1)} MB)`);
  console.log(`S10: menu clip 01200.m2ts = ${menuM2ts.length} B (video ${videoM2ts.length} B + IG ${igTs188.length} B TS)`);
}

if (require.main === module) main();
