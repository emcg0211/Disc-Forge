'use strict';
/**
 * Unit tests for generateMenuVideo / validateBackgroundImage (src/lib/menu-builder.js).
 * Run: node tests/menu-video.test.js
 *
 * Generates throwaway fixture images with ffmpeg, feeds them through
 * generateMenuVideo, and uses ffprobe to assert the output clip is a 1920×1080
 * H.264 stream with the LOCKED encoder profile (profile High / level 4.0 /
 * yuv420p), regardless of the input image's size, aspect ratio, or alpha. Clips
 * are produced at 1s (24 frames) so that with the locked GOP of 24 each yields a
 * single keyframe — which the tests assert.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { execFileSync } = require('child_process');

const {
  generateMenuVideo, validateBackgroundImage, MENU_ENCODE_ARGS,
} = require(path.join(__dirname, '..', 'src', 'lib', 'menu-builder.js'));
const { loadTemplate } = require(path.join(__dirname, '..', 'src', 'lib', 'template.js'));

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); failed++; }
}
function assertEq(a, b, name) { assert(a === b, name, `expected ${b}, got ${a}`); }

// ── Resolve ffmpeg / ffprobe ──────────────────────────────────────────────────
function resolveBin(name) {
  const cands = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`];
  for (const c of cands) if (fs.existsSync(c)) return c;
  try { return execFileSync('which', [name]).toString().trim() || null; } catch { return null; }
}
const FFMPEG  = resolveBin('ffmpeg');
const FFPROBE = resolveBin('ffprobe');

if (!FFMPEG || !FFPROBE) {
  console.log('\nSKIP: ffmpeg/ffprobe not found — menu-video tests require them.');
  console.log('Results: 0 passed, 0 failed\nOVERALL: PASS');
  process.exit(0);
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'menuvid-'));
function cleanup() { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup);

// ── Fixture generators ────────────────────────────────────────────────────────
function makeImage(name, args) {
  const out = path.join(WORK, name);
  execFileSync(FFMPEG, ['-y', ...args, out], { stdio: ['ignore', 'ignore', 'pipe'] });
  return out;
}
// Single-frame stills at various aspect ratios.
const png1080  = makeImage('1080.png',    ['-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=1', '-frames:v', '1']);
const jpg4k    = makeImage('4k.jpg',      ['-f', 'lavfi', '-i', 'testsrc=size=3840x2160:rate=1', '-frames:v', '1']);
const portrait = makeImage('portrait.png',['-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=1', '-frames:v', '1']);
const pano     = makeImage('pano.png',    ['-f', 'lavfi', '-i', 'testsrc=size=3840x800:rate=1',  '-frames:v', '1']);
// Alpha image (rgba): a semi-transparent gradient — exercises alpha flattening.
const alphaPng = makeImage('alpha.png',   ['-f', 'lavfi', '-i', 'color=c=red@0.5:size=1600x900:rate=1', '-frames:v', '1', '-pix_fmt', 'rgba']);
// Animated GIF (must be rejected).
const animGif  = makeImage('anim.gif',    ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-frames:v', '8']);
// Oversized still (> 8K on one axis; must be rejected).
const huge     = makeImage('huge.png',    ['-f', 'lavfi', '-i', 'testsrc=size=8000x200:rate=1', '-frames:v', '1']);

// ── ffprobe helpers ───────────────────────────────────────────────────────────
function probeStream(file) {
  const out = execFileSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,level,width,height,pix_fmt',
    '-of', 'json', file,
  ]);
  return JSON.parse(out.toString()).streams[0];
}
function keyframeCount(file) {
  const out = execFileSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-show_entries', 'frame=pict_type', '-of', 'csv=p=0', file,
  ]).toString().trim();
  return out ? out.split('\n').filter(l => l.includes('I')).length : 0;
}

// ── 1: locked encoder params constant ───────────────────────────────────────────
console.log('\n=== 1: locked encoder params ===');
{
  const j = MENU_ENCODE_ARGS.join(' ');
  assert(j.includes('libx264'),        'MENU_ENCODE_ARGS: libx264');
  assert(j.includes('-pix_fmt yuv420p'),'MENU_ENCODE_ARGS: yuv420p');
  assert(j.includes('-preset medium'),  'MENU_ENCODE_ARGS: preset medium');
  assert(j.includes('-crf 28'),         'MENU_ENCODE_ARGS: crf 28');
  assert(j.includes('-bf 2'),           'MENU_ENCODE_ARGS: 2 B-frames');
  assert(j.includes('-g 24'),           'MENU_ENCODE_ARGS: GOP 24');
  assert(j.includes('-c:a ac3'),        'MENU_ENCODE_ARGS: AC-3 audio');
}

// ── Shared assertions for an encoded menu clip ──────────────────────────────────
function assertLockedClip(file, label) {
  assert(fs.existsSync(file), `${label}: output clip exists`);
  const s = probeStream(file);
  assertEq(s.codec_name, 'h264', `${label}: codec = h264`);
  assertEq(s.profile, 'High',    `${label}: profile = High (locked)`);
  assertEq(s.level, 40,          `${label}: level = 4.0 (locked)`);
  assertEq(s.width, 1920,        `${label}: width = 1920`);
  assertEq(s.height, 1080,       `${label}: height = 1080`);
  assertEq(s.pix_fmt, 'yuv420p', `${label}: pix_fmt = yuv420p (locked)`);
  assertEq(keyframeCount(file), 1, `${label}: single keyframe (1s clip @ GOP 24)`);
}

// ── 2: solid backgrounds (Classic + Minimal) ────────────────────────────────────
console.log('\n=== 2: solid backgrounds ===');
{
  for (const id of ['classic', 'minimal']) {
    const out = path.join(WORK, `solid_${id}.mkv`);
    generateMenuVideo({ template: loadTemplate(id), ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputPath: out, duration: 1 });
    assertLockedClip(out, `solid ${id}`);
  }
}

// ── 3: image backgrounds across fits + aspect ratios ────────────────────────────
console.log('\n=== 3: image backgrounds (fit × aspect) ===');
{
  const theatrical = loadTemplate('theatrical');
  const fixtures = [
    ['1080p PNG', png1080],
    ['4K JPG',    jpg4k],
    ['portrait',  portrait],
    ['pano',      pano],
    ['alpha PNG', alphaPng],
  ];
  for (const [imgLabel, img] of fixtures) {
    for (const fit of ['cover', 'contain', 'stretch']) {
      const tpl = { ...theatrical, background: { ...theatrical.background, imagePath: img, fit } };
      const out = path.join(WORK, `img_${imgLabel.replace(/\W+/g, '')}_${fit}.mkv`);
      generateMenuVideo({ template: tpl, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputPath: out, duration: 1 });
      assertLockedClip(out, `image ${imgLabel} / ${fit}`);
    }
  }
}

// ── 4: validateBackgroundImage ──────────────────────────────────────────────────
console.log('\n=== 4: validateBackgroundImage ===');
{
  const ok = validateBackgroundImage(png1080, FFPROBE);
  assertEq(ok.width, 1920,  'validate: returns width');
  assertEq(ok.height, 1080, 'validate: returns height');

  const ok4k = validateBackgroundImage(jpg4k, FFPROBE);
  assertEq(ok4k.width, 3840, 'validate: 4K accepted (under 8K)');

  function rejects(fn, name) {
    let threw = false; try { fn(); } catch { threw = true; }
    assert(threw, `validate rejects: ${name}`);
  }
  rejects(() => validateBackgroundImage(animGif, FFPROBE), 'animated GIF');
  rejects(() => validateBackgroundImage(huge, FFPROBE),    'image > 8K on an axis');
  rejects(() => validateBackgroundImage(path.join(WORK, 'nope.png'), FFPROBE), 'missing file');
}

// ── 5: generateMenuVideo error handling ─────────────────────────────────────────
console.log('\n=== 5: generateMenuVideo error handling ===');
{
  const theatrical = loadTemplate('theatrical');  // background.type=image, imagePath=null
  let threw = false;
  try {
    generateMenuVideo({ template: theatrical, ffmpegPath: FFMPEG, ffprobePath: FFPROBE,
      outputPath: path.join(WORK, 'noimg.mkv'), duration: 1 });
  } catch { threw = true; }
  assert(threw, 'image template with null imagePath throws');

  threw = false;
  try {
    const tpl = { ...theatrical, background: { ...theatrical.background, imagePath: animGif } };
    generateMenuVideo({ template: tpl, ffmpegPath: FFMPEG, ffprobePath: FFPROBE,
      outputPath: path.join(WORK, 'anim.mkv'), duration: 1 });
  } catch { threw = true; }
  assert(threw, 'image template with animated source throws (validated before encode)');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('OVERALL: FAIL'); process.exit(1); }
else { console.log('OVERALL: PASS'); }
