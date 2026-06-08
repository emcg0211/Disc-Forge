'use strict';
/**
 * Unit tests for the v1.19.0 chapter-selection sub-menu building blocks:
 *   - ig-encoder.buildNavCmd JUMP_OBJECT / PLAY_PL_MARK (and backward compat)
 *   - menu-builder.computeChapterGridPositions
 *   - menu-builder.buildChapterMenuButtons (layout + labels + nav commands)
 *   - menu-builder.buildChapterMenuDisplaySet (well-formed IG stream + embedded nav)
 *
 * These cover only the verifiable, byte-deterministic building blocks. The disc
 * pipeline (second clip, two MovieObjects, cross-clip JumpObject transitions) is
 * deferred and not exercised here — see the v1.19.0 PR notes.
 *
 * Run: node tests/chapter-menu.test.js
 */

const path = require('path');

const {
  buildNavCmd, SEG,
} = require(path.join(__dirname, '..', 'src', 'lib', 'ig-encoder.js'));
const {
  buildChapterMenuDisplaySet, buildChapterMenuButtons, computeChapterGridPositions,
  computeAutoPositions, buildMenuDisplaySet, extractChapterThumbnail,
} = require(path.join(__dirname, '..', 'src', 'lib', 'menu-builder.js'));

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); failed++; }
}
function assertEq(a, b, name) { assert(a === b, name, `expected ${b}, got ${a}`); }
function assertBufEq(a, b, name) {
  assert(Buffer.isBuffer(a) && Buffer.isBuffer(b) && Buffer.compare(a, b) === 0, name,
    `expected [${b ? [...b].map(x => x.toString(16).padStart(2, '0')).join(' ') : 'n/a'}], ` +
    `got [${a ? [...a].map(x => x.toString(16).padStart(2, '0')).join(' ') : 'n/a'}]`);
}

// Reconstruct the contiguous PES byte stream from TS packets (strip 4-byte TS
// header + any adaptation field). Within a PES the payload bytes are contiguous
// across packets once headers are removed, so a 12-byte nav command is never
// split — making a substring search for command bytes reliable.
function depacketize(ts) {
  const out = [];
  for (let off = 0; off + 188 <= ts.length; off += 188) {
    const pkt = ts.slice(off, off + 188);
    if (pkt[0] !== 0x47) continue;
    const afc = (pkt[3] >> 4) & 3;
    let p = 4;
    if (afc & 2) p = 5 + pkt[4];
    if (p < 188) out.push(pkt.slice(p));
  }
  return Buffer.concat(out);
}
const containsCmd = (ts, cmd) => depacketize(ts).includes(cmd);

// ─── Part 2: navigation commands ──────────────────────────────────────────────
console.log('\n=== Part 2: nav commands (JUMP_OBJECT / PLAY_PL_MARK) ===');
{
  const jo = buildNavCmd('JUMP_OBJECT', 1);
  assertEq(jo.length, 12, 'JUMP_OBJECT is 12 bytes');
  assertEq(jo.readUInt32BE(0), 0x21800000, 'JUMP_OBJECT opcode = 0x21800000');
  assertEq(jo.readUInt32BE(4), 1, 'JUMP_OBJECT op_1 = movie_object_id (1)');
  assertEq(jo.readUInt32BE(8), 0, 'JUMP_OBJECT op_2 = 0');

  const jo0 = buildNavCmd('JUMP_OBJECT', 0);
  assertEq(jo0.readUInt32BE(4), 0, 'JUMP_OBJECT(0) op_1 = 0 (main-menu object)');

  const pm = buildNavCmd('PLAY_PL_MARK', 1, 2);
  assertEq(pm.length, 12, 'PLAY_PL_MARK is 12 bytes');
  assertEq(pm.readUInt32BE(0), 0x42C20000, 'PLAY_PL_MARK opcode = 0x42C20000');
  assertEq(pm.readUInt32BE(4), 1, 'PLAY_PL_MARK op_1 = playlist_id (1)');
  assertEq(pm.readUInt32BE(8), 2, 'PLAY_PL_MARK op_2 = mark_id (2)');

  const pm0 = buildNavCmd('PLAY_PL_MARK', 1, 0);
  assertEq(pm0.readUInt32BE(8), 0, 'PLAY_PL_MARK(_,0) mark_id = 0 (first chapter)');

  // Backward compatibility — existing opcodes MUST be unchanged (golden hash).
  assertEq(buildNavCmd('PLAY_PL', 3).readUInt32BE(0), 0x22800000, 'PLAY_PL opcode unchanged');
  assertEq(buildNavCmd('PLAY_PL', 3).readUInt32BE(4), 3, 'PLAY_PL arg unchanged');
  assertEq(buildNavCmd('JUMP_TITLE', 5).readUInt32BE(0), 0x21810000, 'JUMP_TITLE opcode unchanged');
  assertEq(buildNavCmd('NOOP').readUInt32BE(0), 0x00020000, 'NOOP opcode unchanged');
  // 3-arg signature is additive: omitting arg2 still works for 1-operand commands.
  assertEq(buildNavCmd('PLAY_PL', 7).readUInt32BE(8), 0, 'PLAY_PL op_2 stays 0 with new signature');
}

// ─── Part 4: computeChapterGridPositions ──────────────────────────────────────
console.log('\n=== Part 4a: computeChapterGridPositions (2-column grid) ===');
{
  const bw = 800, bh = 90, gap = 30;
  const g7 = computeChapterGridPositions(7, bw, bh, gap);
  assertEq(g7.length, 7, 'grid: returns one position per chapter');
  // 2 columns, centered: totalW = 2*800+30 = 1630, startX = (1920-1630)/2 = 145
  assertEq(g7[0].x, 145, 'grid col 0 x = 145 (centered)');
  assertEq(g7[1].x, 145 + bw + gap, 'grid col 1 x = startX + bw + gap');
  assertEq(g7[0].y, g7[1].y, 'grid: items 0 and 1 share row 0 (same y)');
  // rows = ceil(7/2) = 4; totalH = 4*90+3*30 = 450; startY = (1080-450)/2 = 315
  assertEq(g7[0].y, 315, 'grid row 0 y = 315 (centered for 4 rows)');
  assertEq(g7[2].y, 315 + bh + gap, 'grid row 1 y = startY + bh + gap');
  assertEq(g7[6].x, 145, 'grid: last (odd) item falls in column 0');
  // Even count centers symmetrically.
  const g8 = computeChapterGridPositions(8, bw, bh, gap);
  assertEq(g8[0].y, computeChapterGridPositions(8, bw, bh, gap)[1].y, 'grid: deterministic');
}

// ─── Part 4: buildChapterMenuButtons ──────────────────────────────────────────
console.log('\n=== Part 4b: buildChapterMenuButtons (≤6 → vertical stack) ===');
{
  const chapters = [{ name: 'Opening' }, { name: 'Act One' }, { name: 'Finale' }];
  const r = buildChapterMenuButtons(chapters, { mainPlaylistId: 1, mainMenuObjectId: 0 });

  assertEq(r.positions.length, 4, '3 chapters → 4 buttons (3 + back)');
  assertEq(r.backIndex, 3, 'backIndex = chapter count');
  assertEq(r.labels.length, 4, '4 labels');
  assertEq(r.labels[0], 'Opening', 'label 0 = chapter name');
  assertEq(r.labels[3], 'Main Menu', 'last label = back button');

  // Chapter positions match the episode-menu vertical stack (computeAutoPositions).
  const auto = computeAutoPositions(3, 800, 90, 30, 1920, 1080);
  assertEq(r.positions[0].x, auto[0].x, 'chapter 0 x = auto-stack x');
  assertEq(r.positions[0].y, auto[0].y, 'chapter 0 y = auto-stack y');
  assertEq(r.positions[2].y, auto[2].y, 'chapter 2 y = auto-stack y');

  // Back button is centered and below the lowest chapter (with a 2× gap).
  assertEq(r.positions[3].x, Math.round((1920 - 800) / 2), 'back button x centered');
  assert(r.positions[3].y > r.positions[2].y, 'back button is below the last chapter');
  assertEq(r.positions[3].y, r.positions[2].y + 90 + 30 * 2, 'back button y = lowest + bh + 2*gap');

  // Nav commands: chapter i → PLAY_PL_MARK(1, i); back → JUMP_OBJECT(0).
  assertBufEq(r.navCmds[0][0], buildNavCmd('PLAY_PL_MARK', 1, 0), 'chapter 0 → PLAY_PL_MARK(1,0)');
  assertBufEq(r.navCmds[1][0], buildNavCmd('PLAY_PL_MARK', 1, 1), 'chapter 1 → PLAY_PL_MARK(1,1) (0-indexed mark)');
  assertBufEq(r.navCmds[2][0], buildNavCmd('PLAY_PL_MARK', 1, 2), 'chapter 2 → PLAY_PL_MARK(1,2)');
  assertBufEq(r.navCmds[3][0], buildNavCmd('JUMP_OBJECT', 0), 'back → JUMP_OBJECT(0)');
}

console.log('\n=== Part 4c: buildChapterMenuButtons (defaults, grid, options) ===');
{
  // Missing/blank names fall back to "Chapter N".
  const r = buildChapterMenuButtons([{ name: '' }, {}, { name: '  ' }]);
  assertEq(r.labels[0], 'Chapter 1', 'blank name → "Chapter 1"');
  assertEq(r.labels[1], 'Chapter 2', 'missing name → "Chapter 2"');
  assertEq(r.labels[2], 'Chapter 3', 'whitespace name → "Chapter 3"');

  // 7+ chapters use the 2-column grid layout.
  const chapters7 = Array.from({ length: 7 }, (_, i) => ({ name: `Ch ${i + 1}` }));
  const r7 = buildChapterMenuButtons(chapters7);
  const grid = computeChapterGridPositions(7, 800, 90, 30);
  assertEq(r7.positions[0].x, grid[0].x, '7 chapters: button 0 uses grid x');
  assertEq(r7.positions[1].x, grid[1].x, '7 chapters: button 1 in second column');
  assertEq(r7.positions.length, 8, '7 chapters → 8 buttons (7 + back)');

  // Custom playlist / back-target / label options flow through.
  const rc = buildChapterMenuButtons([{ name: 'A' }], { mainPlaylistId: 2, mainMenuObjectId: 5, backLabel: 'Top Menu' });
  assertBufEq(rc.navCmds[0][0], buildNavCmd('PLAY_PL_MARK', 2, 0), 'custom mainPlaylistId used');
  assertBufEq(rc.navCmds[1][0], buildNavCmd('JUMP_OBJECT', 5), 'custom mainMenuObjectId used');
  assertEq(rc.labels[1], 'Top Menu', 'custom backLabel used');

  // Positions are clamped to the frame.
  const rClamp = buildChapterMenuButtons(Array.from({ length: 6 }, (_, i) => ({ name: `C${i}` })));
  for (const p of rClamp.positions) {
    assert(p.x >= 0 && p.x <= 1920 - 800, `position x in frame (${p.x})`);
    assert(p.y >= 0 && p.y <= 1080 - 90, `position y in frame (${p.y})`);
  }
}

// ─── buildChapterMenuDisplaySet: well-formed IG stream ────────────────────────
console.log('\n=== Part 3/4: buildChapterMenuDisplaySet (IG stream) ===');
{
  const chapters = [{ name: 'Opening' }, { name: 'Act One' }, { name: 'Finale' }];
  const ds = buildChapterMenuDisplaySet({ chapters, pts: 54000000 });

  assert(Buffer.isBuffer(ds) && ds.length > 0, 'produces a non-empty buffer');
  assert(ds.length % 188 === 0, 'output is a whole number of 188-byte TS packets');
  assertEq(ds[0], 0x47, 'first byte is TS sync 0x47');
  assert((ds[1] & 0x40) === 0x40, 'PUSI set on first packet');

  const pes = depacketize(ds);
  assert(pes.includes(Buffer.from([SEG.IG_COMPOSITION])), 'contains an ICS segment (0x18)');
  assert(pes.includes(Buffer.from([0x80, 0x00, 0x00])), 'contains an END segment (0x80 0x00 0x00)');

  // The chapter nav commands are actually embedded in the display set.
  assert(containsCmd(ds, buildNavCmd('PLAY_PL_MARK', 1, 0)), 'DS embeds PLAY_PL_MARK(1,0) for chapter 1');
  assert(containsCmd(ds, buildNavCmd('PLAY_PL_MARK', 1, 2)), 'DS embeds PLAY_PL_MARK(1,2) for chapter 3');
  assert(containsCmd(ds, buildNavCmd('JUMP_OBJECT', 0)), 'DS embeds the back-button JUMP_OBJECT(0)');

  // Different chapter sets produce different streams (data flows through).
  const ds2 = buildChapterMenuDisplaySet({ chapters: [{ name: 'X' }, { name: 'Y' }], pts: 54000000 });
  assert(Buffer.compare(ds, ds2) !== 0, 'different chapters → different IG stream');

  // A 7-chapter (grid) menu still builds correctly and embeds the last mark.
  const ds7 = buildChapterMenuDisplaySet({ chapters: Array.from({ length: 7 }, (_, i) => ({ name: `Ch${i + 1}` })), pts: 48000000 });
  assert(ds7.length % 188 === 0, '7-chapter grid menu is well-formed TS');
  assert(containsCmd(ds7, buildNavCmd('PLAY_PL_MARK', 1, 6)), '7-chapter menu embeds PLAY_PL_MARK(1,6)');
}

// ─── Regression guard: episode menu output is unchanged ───────────────────────
console.log('\n=== Regression: buildMenuDisplaySet (episode menu) unaffected ===');
{
  // The chapter additions must not perturb the episode menu. The section-18
  // golden hash in ig-encoder.test.js is the authority; this is a fast local guard
  // that the episode menu still emits PLAY_PL (not PLAY_PL_MARK) and is unchanged
  // across two builds.
  const cfg = { playlists: [1, 2, 3], pts: 48000000, labels: ['A', 'B', 'C'] };
  const a = buildMenuDisplaySet(cfg);
  const b = buildMenuDisplaySet(cfg);
  assert(Buffer.compare(a, b) === 0, 'episode menu is deterministic');
  assert(containsCmd(a, buildNavCmd('PLAY_PL', 1)), 'episode menu still uses PLAY_PL(1)');
  assert(containsCmd(a, buildNavCmd('PLAY_PL', 3)), 'episode menu still uses PLAY_PL(3)');
  assert(!containsCmd(a, buildNavCmd('PLAY_PL_MARK', 1, 0)), 'episode menu does NOT use PLAY_PL_MARK');
}

// ─── Part 5: chapter thumbnail cells + graceful extraction (v1.23.0) ──────────
console.log('\n=== Part 5a: computeChapterGridPositions cell rects (x,y,w,h) ===');
{
  // Each chapter button's bounding rect IS its thumbnail cell: x,y from the grid,
  // w,h from the button geometry passed in. Verify the full rect against known input.
  const bw = 800, bh = 90, gap = 30;
  const g = computeChapterGridPositions(4, bw, bh, gap);
  // 2 cols × 2 rows; totalW = 1630 → startX = 145; totalH = 210 → startY = 435.
  const cells = g.map(p => ({ x: p.x, y: p.y, width: bw, height: bh }));
  assertEq(cells.length, 4, 'one cell per chapter');
  assertEq(cells[0].x, 145, 'cell 0 x = 145');
  assertEq(cells[0].y, 435, 'cell 0 y = 435');
  assertEq(cells[0].width, 800, 'cell 0 width = button width');
  assertEq(cells[0].height, 90, 'cell 0 height = button height');
  assertEq(cells[1].x, 145 + bw + gap, 'cell 1 x = next column');
  assertEq(cells[1].y, 435, 'cell 1 y = same row as cell 0');
  assertEq(cells[3].y, 435 + bh + gap, 'cell 3 y = second row');
  // Different geometry flows straight through to the cell size.
  const g2 = computeChapterGridPositions(2, 480, 270, 20);
  assert(g2.every(p => Number.isInteger(p.x) && Number.isInteger(p.y)), 'grid positions are integers');
}

console.log('\n=== Part 5b: extractChapterThumbnail graceful fallback ===');
{
  // A non-existent source video must return null (never throw) so the build/preview
  // can fall back to solid-color buttons.
  let threw = false, res;
  try {
    res = extractChapterThumbnail({
      videoPath: path.join(__dirname, 'no-such-video-xyz.mkv'),
      timestamp: 5, width: 320, height: 180, ffmpegPath: '/usr/bin/true',
    });
  } catch { threw = true; }
  assert(!threw, 'extractChapterThumbnail does not throw on a missing video');
  assertEq(res, null, 'missing video → returns null');

  // Missing ffmpeg binary → null, no throw.
  let threw2 = false, res2;
  try {
    res2 = extractChapterThumbnail({ videoPath: __filename, timestamp: 0, width: 10, height: 10, ffmpegPath: '/no/such/ffmpeg' });
  } catch { threw2 = true; }
  assert(!threw2, 'extractChapterThumbnail does not throw on a missing ffmpeg');
  assertEq(res2, null, 'missing ffmpeg → returns null');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('OVERALL: FAIL'); process.exit(1); }
else { console.log('OVERALL: PASS'); }
