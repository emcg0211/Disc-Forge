#!/usr/bin/env node
'use strict';
/**
 * build_template_test.js — v1.13.0 template-path test discs.
 *
 * Parameterized sibling of build_prod_test.js: instead of a hardcoded navy
 * background, the menu clip is produced by the PRODUCTION generateMenuVideo()
 * from a TEMPLATE (src/lib/menu-builder.js), then run through the exact same
 * production inject/patch chain (rewriteVideoPesDts, extractFirstVideoPTS,
 * buildMenuDisplaySet(template), injectIGIntoM2ts, patchPmtForIG, patchClpi*,
 * patchMpls*). The only variable vs the v1.12.0 prod disc is "which template".
 *
 * Builds three discs into ~/Desktop/menu-tests/:
 *   template_classic_test.iso     — Classic   (solid navy bg)
 *   template_minimal_test.iso     — Minimal   (solid gray bg, different palette)
 *   template_theatrical_test.iso  — Theatrical (image bg from a generated fixture)
 *
 * Usage: node build_template_test.js [classic|minimal|theatrical|all]   (default: all)
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const mb = require('../src/lib/menu-builder');
const { loadTemplate } = require('../src/lib/template');
const { buildIso } = require('./ig-toolkit/repack');

const DESKTOP    = path.join(os.homedir(), 'Desktop');
const MENU_TESTS = path.join(DESKTOP, 'menu-tests');
const WORK_ROOT  = '/tmp/igtk_phase4/template';
const TOAST_MOUNT = '/Volumes/My Movie';
const TOAST_ISO   = '/Volumes/Internal SSD/Personal/My Movie.iso';
const FFMPEG  = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const TSMUXER = path.join(__dirname, '..', 'bin', 'tsMuxeR');

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

// Generate a cinematic gradient fixture for the Theatrical image background.
function makeTheatricalFixture(dir) {
  const out = path.join(dir, 'theatrical_bg.png');
  // A clearly-visible diagonal gradient (deep blue → maroon) so the image
  // background is obviously a picture, not a flat color, in screenshots.
  sh(FFMPEG, ['-y', '-f', 'lavfi',
    '-i', 'gradients=s=1920x1080:c0=0x16386e:c1=0x5e1430:x0=0:y0=0:x1=1920:y1=1080',
    '-frames:v', '1', out], { stdio: ['ignore', 'ignore', 'pipe'] });
  return out;
}

function buildOne(templateId, isoName, fixtureImage) {
  const WORK = path.join(WORK_ROOT, templateId);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  const template = loadTemplate(templateId);
  if (template.background.type === 'image') {
    if (!fixtureImage) throw new Error(`${templateId}: image template needs a fixture image`);
    template.background.imagePath = fixtureImage;
  }

  // 1. menu background video via the PRODUCTION generateMenuVideo (template-driven)
  console.log(`[${templateId}] generateMenuVideo (bg=${template.background.type})…`);
  const mkv = path.join(WORK, 'menu.mkv');
  mb.generateMenuVideo({ template, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputPath: mkv, duration: 4 });

  const bdmv = path.join(WORK, 'bdmv'); fs.mkdirSync(bdmv, { recursive: true });
  const tp = runTsMuxer(mkv, bdmv);

  // 2-5. EXACT production sequence (mirrors src/main.js addMenuToDisc), with template
  const playlists = [1, 2];
  const labels    = ['Play Episode 1', 'Play Episode 2'];

  const videoM2ts     = mb.rewriteVideoPesDts(fs.readFileSync(tp.m2ts), 3750);
  const firstVideoPTS = mb.extractFirstVideoPTS(videoM2ts);

  const igTs = mb.buildMenuDisplaySet({ playlists, pts: firstVideoPTS, labels, ffmpegPath: FFMPEG, template });
  let menuM2ts = mb.injectIGIntoM2ts(videoM2ts, igTs);
  menuM2ts = mb.patchPmtForIG(menuM2ts);

  // pre-flight via the toolkit decoder (same checks as build_prod_test)
  const lib = require('./ig-toolkit/lib');
  const chk = lib.extractIg(menuM2ts, 0x1400);
  const segs = chk.displaySets[0].units.flatMap(ui => chk.units.find(x => x.pesIndex === ui).segments);
  const odsIds = segs.filter(s => s.type === 0x15).map(s => s.decoded.objectId);
  const page = segs.find(s => s.type === 0x18).decoded.pages[0];
  console.log(`[${templateId}] displaySets=${chk.displaySets.length}, ODS=[${odsIds.join(',')}], ` +
    `wds=${segs.some(s => s.type === 0x17)}, defSel=${page.defaultSelectedButtonIdRef}, ` +
    `ICS_PTS=${chk.units.filter(u => u.segments.some(s => s.type === 0x18)).map(u => u.pes.pts)}, ` +
    `in_time=${firstVideoPTS}, segRT=${chk.segmentRoundTripOK}, igLen=${igTs.length}`);
  if (chk.displaySets.length !== 1) throw new Error(`expected 1 display set, got ${chk.displaySets.length}`);
  if (odsIds.join(',') !== '0,1,2,3') throw new Error(`expected ODS 0,1,2,3, got [${odsIds.join(',')}]`);
  if (page.defaultSelectedButtonIdRef !== 1) throw new Error(`expected defSel=1, got ${page.defaultSelectedButtonIdRef}`);
  if (segs.some(s => s.type === 0x17)) throw new Error('unexpected WDS');

  const clpi = mb.patchClpiForIG(fs.readFileSync(tp.clpi));
  if (!clpi) throw new Error('patchClpiForIG failed');
  let mpls = mb.patchMplsClipName(fs.readFileSync(tp.mpls), '01200');
  mpls = mb.patchMplsForStill(mb.patchMplsForIG(mpls));

  // assemble single-menu Toast tree (same scaffolding as build_prod_test / build_s11)
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
  const iso = path.join(MENU_TESTS, isoName);
  console.log(`[${templateId}] hdiutil makehybrid → ${iso}`);
  buildIso(TREE, iso, 'DISC_FORGE');
  console.log(`[${templateId}] wrote ${iso} (${(fs.statSync(iso).size / 1e6).toFixed(1)} MB)`);
}

function main() {
  const which = (process.argv[2] || 'all').toLowerCase();
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  ensureMount();

  const fixture = makeTheatricalFixture(WORK_ROOT);

  const jobs = [
    ['classic',    'template_classic_test.iso',    null],
    ['minimal',    'template_minimal_test.iso',    null],
    ['theatrical', 'template_theatrical_test.iso', fixture],
  ];
  for (const [id, iso, fix] of jobs) {
    if (which === 'all' || which === id) buildOne(id, iso, fix);
  }
  console.log('DONE');
}

if (require.main === module) main();
