#!/usr/bin/env node
'use strict';
/**
 * build_prod_test.js — Phase 6 production-path parity test.
 *
 * Builds a single-menu navy test disc whose IG is produced ENTIRELY by the
 * production encoder in src/lib/menu-builder.js (buildMenuDisplaySet) and the
 * production inject/patch chain (rewriteVideoPesDts, extractFirstVideoPTS,
 * injectIGIntoM2ts, patchPmtForIG, patchClpiForIG, patchMpls*). This is the
 * exact sequence src/main.js / tools/menu_inject.js use to add a menu — nothing
 * from the ig-toolkit hand-build path is used for the IG.
 *
 * It is assembled into the same single-menu Toast tree as the hand-built S11
 * (clip 01200, infinite still) so the ONLY variable vs S11 is "production
 * encoder" vs "hand-built emitIgTs188". The final ISO uses the app's ISO
 * mechanism (hdiutil makehybrid via repack.buildIso).
 *
 * Output: ~/Desktop/menu-tests/prod_v1.12.0_test.iso
 * Usage:  node build_prod_test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ── production encoder + patch chain (the code that ships in the app) ──
const mb = require('../src/lib/menu-builder');
// ISO assembly = the app's makehybrid mechanism
const { buildIso } = require('./ig-toolkit/repack');

const DESKTOP = path.join(os.homedir(), 'Desktop');
const MENU_TESTS = path.join(DESKTOP, 'menu-tests');
const WORK = '/tmp/igtk_phase4/prod';
const TOAST_MOUNT = '/Volumes/My Movie';
const TOAST_ISO = '/Volumes/Internal SSD/Personal/My Movie.iso';
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const TSMUXER = path.join(__dirname, '..', 'bin', 'tsMuxeR');
const VID_W = 1920, VID_H = 1080;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || '').toString().slice(-600)}`);
  return r;
}
function ensureMount() {
  if (!fs.existsSync(path.join(TOAST_MOUNT, 'BDMV')))
    sh('hdiutil', ['attach', TOAST_ISO, '-readonly', '-nobrowse']);
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

function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  ensureMount();

  // 1. navy menu video → MKV → tsMuxeR (same background as menu_inject.js)
  console.log('PROD: generating navy menu video…');
  const mkv = path.join(WORK, 'navy.mkv');
  sh(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=c=0x1a1a2e:size=${VID_W}x${VID_H}:rate=24`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-map', '0:v', '-map', '1:a', '-t', '4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '28', '-bf', '2', '-g', '24',
    '-c:a', 'ac3', '-b:a', '192k', mkv], { stdio: ['ignore', 'ignore', 'pipe'] });
  const bdmv = path.join(WORK, 'bdmv'); fs.mkdirSync(bdmv, { recursive: true });
  const tp = runTsMuxer(mkv, bdmv);

  // 2-5. EXACT production sequence (mirrors src/main.js addMenuToDisc) ───────────
  const playlists = [1, 2];
  const labels    = ['Play Episode 1', 'Play Episode 2'];

  const videoM2ts    = mb.rewriteVideoPesDts(fs.readFileSync(tp.m2ts), 3750);
  const firstVideoPTS = mb.extractFirstVideoPTS(videoM2ts);
  console.log(`PROD: firstVideoPTS=${firstVideoPTS}`);

  const igTs = mb.buildMenuDisplaySet({ playlists, pts: firstVideoPTS, labels, ffmpegPath: FFMPEG });
  let menuM2ts = mb.injectIGIntoM2ts(videoM2ts, igTs);
  menuM2ts = mb.patchPmtForIG(menuM2ts);
  console.log(`PROD: IG ${igTs.length} B TS → menu clip ${menuM2ts.length} B`);

  // sanity: re-extract via the toolkit decoder to confirm the production wiring
  const lib = require('./ig-toolkit/lib');
  const chk = lib.extractIg(menuM2ts, 0x1400);
  const segs = chk.displaySets[0].units.flatMap(ui => chk.units.find(x => x.pesIndex === ui).segments);
  const odsIds = segs.filter(s => s.type === 0x15).map(s => s.decoded.objectId);
  const page = segs.find(s => s.type === 0x18).decoded.pages[0];
  const btn = page.bogs.map(b => { const x = b.buttons[0]; return `id${x.id} N${x.normalStart} S${x.selStart} A${x.actStart}`; });
  const icsPts = chk.units.filter(u => u.segments.some(s => s.type === 0x18)).map(u => u.pes.pts);
  console.log(`PROD: displaySets=${chk.displaySets.length}, ODS objIds=[${odsIds.join(',')}], wds=${segs.some(s => s.type === 0x17)}`);
  console.log(`PROD: buttons → ${btn.join('  |  ')}  defSel=${page.defaultSelectedButtonIdRef}`);
  console.log(`PROD: ICS PTS=${icsPts.join(',')} (in_time=${firstVideoPTS}), segRT=${chk.segmentRoundTripOK}`);
  if (chk.displaySets.length !== 1) throw new Error(`expected 1 display set, got ${chk.displaySets.length}`);
  if (odsIds.join(',') !== '0,1,2,3') throw new Error(`expected ODS 0,1,2,3, got [${odsIds.join(',')}]`);
  if (page.defaultSelectedButtonIdRef !== 1) throw new Error(`expected defSel=1, got ${page.defaultSelectedButtonIdRef}`);

  // CLPI/MPLS via the production patchers, renamed 01200 (single-menu Toast tree, as S11)
  const clpi = mb.patchClpiForIG(fs.readFileSync(tp.clpi));
  if (!clpi) throw new Error('patchClpiForIG failed');
  let mpls = mb.patchMplsClipName(fs.readFileSync(tp.mpls), '01200');
  mpls = mb.patchMplsForStill(mb.patchMplsForIG(mpls));

  // assemble Toast tree (same scaffolding as build_s11 — isolates the encoder)
  const TREE = path.join(WORK, 'tree');
  fs.mkdirSync(TREE, { recursive: true });
  fs.cpSync(path.join(TOAST_MOUNT, 'BDMV'), path.join(TREE, 'BDMV'), { recursive: true });
  sh('chmod', ['-R', 'u+w', TREE]);
  fs.writeFileSync(path.join(TREE, 'BDMV', 'STREAM', '01200.m2ts'), menuM2ts);
  fs.writeFileSync(path.join(TREE, 'BDMV', 'CLIPINF', '01200.clpi'), clpi);
  fs.writeFileSync(path.join(TREE, 'BDMV', 'PLAYLIST', '01200.mpls'), mpls);
  fs.copyFileSync(path.join(TREE, 'BDMV', 'PLAYLIST', '00001.mpls'), path.join(TREE, 'BDMV', 'PLAYLIST', '00002.mpls'));
  fs.copyFileSync(path.join(TREE, 'BDMV', 'CLIPINF', '00001.clpi'), path.join(TREE, 'BDMV', 'CLIPINF', '00002.clpi'));

  fs.mkdirSync(MENU_TESTS, { recursive: true });
  const iso = path.join(MENU_TESTS, 'prod_v1.12.0_test.iso');
  console.log(`PROD: hdiutil makehybrid → ${iso}`);
  buildIso(TREE, iso, 'DISC_FORGE');
  console.log(`PROD: wrote ${iso} (${(fs.statSync(iso).size / 1e6).toFixed(1)} MB)`);
}

if (require.main === module) main();
