'use strict';
/**
 * Unit tests for src/lib/template-store.js + renderButtonPreviewPng.
 * Run: node tests/template-store.test.js
 *
 * Uses setUserTemplatesDir() to redirect the user-templates dir into a temp
 * folder so the suite never touches a real Electron userData location.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const store = require(path.join(__dirname, '..', 'src', 'lib', 'template-store.js'));
const { renderButtonPreviewPng, computeBackgroundDrawRect } = require(path.join(__dirname, '..', 'src', 'lib', 'menu-builder.js'));
const { loadTemplate, validateTemplate } = require(path.join(__dirname, '..', 'src', 'lib', 'template.js'));

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); failed++; }
}
function assertEq(a, b, name) { assert(a === b, name, `expected ${b}, got ${a}`); }
function rejects(fn, name) { let t = false; try { fn(); } catch { t = true; } assert(t, `rejects: ${name}`); }

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tplstore-'));
process.on('exit', () => { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {} });
store.setUserTemplatesDir(WORK);

// ── 1: built-in catalog ─────────────────────────────────────────────────────────
console.log('\n=== 1: listBuiltIn ===');
{
  const bi = store.listBuiltIn();
  const ids = bi.map(t => t.id).sort();
  assert(ids.length === 24, 'listBuiltIn: 24 built-in templates');
  for (const id of ['classic', 'minimal', 'theatrical', 'ocean-bar', 'navy-bar', 'silver-bar', 'gold-bar']) {
    assert(ids.includes(id), `listBuiltIn: includes ${id}`);
  }
  assert(bi.every(t => typeof t.category === 'string' && t.category.trim().length > 0),
    'listBuiltIn: every entry carries a non-empty category');
  assert(bi.every(t => t.readonly === true), 'listBuiltIn: all readonly');
  assert(bi.every(t => fs.existsSync(t.path)), 'listBuiltIn: paths exist');
  assert(store.isBuiltInId('classic'), 'isBuiltInId(classic) = true');
  assert(!store.isBuiltInId('nope'), 'isBuiltInId(nope) = false');
}

// ── 2: loadById ─────────────────────────────────────────────────────────────────
console.log('\n=== 2: loadById ===');
{
  assertEq(store.loadById('classic').id, 'classic', 'loadById(classic)');
  assertEq(store.loadById('theatrical').background.type, 'image', 'loadById(theatrical): image bg');
  rejects(() => store.loadById('does-not-exist'), 'unknown id');
  rejects(() => store.loadById(''), 'empty id');
}

// ── 3: saveUser ─────────────────────────────────────────────────────────────────
console.log('\n=== 3: saveUser ===');
{
  assert(store.listUser().length === 0, 'listUser empty initially');

  const custom = loadTemplate('classic');
  custom.id = 'my-custom';
  custom.name = 'My Custom';
  custom.button.normalFill = { entry: 2, rgb: [10, 20, 30], hex: '0a141e' };
  const id = store.saveUser(custom);
  assertEq(id, 'my-custom', 'saveUser returns id');
  assert(fs.existsSync(path.join(WORK, 'my-custom.json')), 'saveUser wrote file');
  const u = store.listUser();
  assertEq(u.length, 1, 'listUser now has 1');
  assertEq(u[0].readonly, false, 'user template not readonly');
  assertEq(store.loadById('my-custom').name, 'My Custom', 'loadById(user) round-trips name');

  // id derived from name when absent
  const noId = loadTemplate('minimal'); delete noId.id; noId.name = 'Auto Slug Name';
  assertEq(store.saveUser(noId), 'auto-slug-name', 'saveUser derives slug id from name');

  // built-in id reserved
  const clash = loadTemplate('classic'); clash.id = 'classic';
  rejects(() => store.saveUser(clash), 'saveUser over built-in id');

  // validation runs on save
  const bad = loadTemplate('classic'); bad.id = 'bad-one'; bad.palette[1].T = 0;
  rejects(() => store.saveUser(bad), 'saveUser validates (transparent palette)');
}

// ── 4: duplicate ─────────────────────────────────────────────────────────────────
console.log('\n=== 4: duplicate ===');
{
  const id1 = store.duplicate('classic', 'My Copy');
  assertEq(id1, 'my-copy', 'duplicate(classic, "My Copy") -> my-copy');
  assertEq(store.loadById('my-copy').name, 'My Copy', 'duplicate sets new name');
  assert(store.loadById('my-copy').button.width === 800, 'duplicate copies source contents');

  // second duplicate with same name gets a unique id
  const id2 = store.duplicate('classic', 'My Copy');
  assertEq(id2, 'my-copy-2', 'duplicate again -> my-copy-2 (unique)');

  // duplicating a user template works too
  const id3 = store.duplicate('my-custom', 'From User');
  assertEq(store.loadById(id3).button.normalFill.hex, '0a141e', 'duplicate(user) carries edits');

  // duplicating into a built-in-colliding name avoids the reserved id
  const id4 = store.duplicate('classic', 'classic');
  assert(!store.isBuiltInId(id4), 'duplicate never produces a built-in id');
}

// ── 5: deleteUser ─────────────────────────────────────────────────────────────────
console.log('\n=== 5: deleteUser ===');
{
  store.deleteUser('my-custom');
  assert(!fs.existsSync(path.join(WORK, 'my-custom.json')), 'deleteUser removed file');
  rejects(() => store.loadById('my-custom'), 'loadById after delete throws');
  rejects(() => store.deleteUser('classic'), 'deleteUser(built-in) throws');
  rejects(() => store.deleteUser('ghost'), 'deleteUser(missing) throws');
}

// ── 6: slugify ─────────────────────────────────────────────────────────────────
console.log('\n=== 6: slugify ===');
{
  assertEq(store.slugify('Hello World!'), 'hello-world', 'slugify spaces+punct');
  assertEq(store.slugify('  Trim--Me  '), 'trim-me', 'slugify trims dashes');
  assertEq(store.slugify(''), 'template', 'slugify empty -> template');
}

// ── 7: renderButtonPreviewPng ────────────────────────────────────────────────────
console.log('\n=== 7: renderButtonPreviewPng ===');
{
  function pngDims(buf) {
    const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    const sigOk = sig.every((b, i) => buf[i] === b) && buf.slice(12, 16).toString('ascii') === 'IHDR';
    return { sigOk, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  for (const id of ['classic', 'minimal', 'theatrical']) {
    const tpl = loadTemplate(id);
    const png = renderButtonPreviewPng({ template: tpl, state: 'selected' });
    const d = pngDims(png);
    assert(d.sigOk, `${id}: valid PNG signature + IHDR`);
    assertEq(d.w, tpl.button.width, `${id}: PNG width == button width`);
    assertEq(d.h, tpl.button.height, `${id}: PNG height == button height`);
  }
  // normal vs selected differ (different fill).
  const c = loadTemplate('classic');
  const sel = renderButtonPreviewPng({ template: c, state: 'selected' });
  const nor = renderButtonPreviewPng({ template: c, state: 'normal' });
  assert(Buffer.compare(sel, nor) !== 0, 'preview: selected vs normal differ');
  rejects(() => renderButtonPreviewPng({ template: null }), 'preview: null template throws');
}

// ── 8: saveAsUser (name uniqueness) ──────────────────────────────────────────────
console.log('\n=== 8: saveAsUser (Save As name uniqueness) ===');
{
  const draft = loadTemplate('classic');
  draft.button.normalFill = { entry: 2, rgb: [9, 9, 9], hex: '090909' };

  const id = store.saveAsUser(draft, 'My Saved As');
  assertEq(id, 'my-saved-as', 'saveAsUser returns slugified id');
  assertEq(store.loadById('my-saved-as').name, 'My Saved As', 'saveAsUser sets new name');
  assertEq(store.loadById('my-saved-as').button.normalFill.hex, '090909', 'saveAsUser persists the draft edits');

  // collides with a built-in name/id
  rejects(() => store.saveAsUser(draft, 'Classic'), 'Save As over built-in name');
  rejects(() => store.saveAsUser(draft, 'classic'), 'Save As over built-in id slug');
  // collides with the just-created user template (by name and by id slug)
  rejects(() => store.saveAsUser(draft, 'My Saved As'), 'Save As duplicate user name');
  rejects(() => store.saveAsUser(draft, 'my saved as'), 'Save As duplicate (case-insensitive)');
  // empty name
  rejects(() => store.saveAsUser(draft, '   '), 'Save As empty name');

  // a genuinely new unique name succeeds
  assertEq(store.saveAsUser(draft, 'Another One'), 'another-one', 'Save As unique name succeeds');
}

// ── 9: full persistence round-trip (duplicate → edit → save → re-read) ────────────
console.log('\n=== 9: persistence round-trip ===');
{
  // duplicate a built-in
  const dupId = store.duplicate('classic', 'Round Trip');
  // edit the working copy's palette (as the editor would) and save by id
  const draft = store.loadById(dupId);
  draft.palette[2].Y = 99;
  draft.button.normalFill = { entry: 2, rgb: [1, 2, 3], hex: '010203' };
  store.saveUser(draft);
  // simulate app restart: a fresh store instance re-reading from disk
  delete require.cache[require.resolve(path.join(__dirname, '..', 'src', 'lib', 'template-store.js'))];
  const store2 = require(path.join(__dirname, '..', 'src', 'lib', 'template-store.js'));
  store2.setUserTemplatesDir(WORK);
  const reloaded = store2.loadById(dupId);
  assertEq(reloaded.palette[2].Y, 99, 'round-trip: palette edit persisted across reload');
  assertEq(reloaded.button.normalFill.hex, '010203', 'round-trip: fill edit persisted across reload');
  assert(store2.listUser().some(t => t.id === dupId), 'round-trip: appears in listUser after reload');
}

// ── 10: background.file validation (v1.21.0 custom background image) ───────────────
console.log('\n=== 10: background image schema ===');
{
  // Base off a solid built-in, then swap in an image background per case.
  const withBg = (bg) => { const t = loadTemplate('classic'); t.background = bg; return t; };

  // valid image: type + filename-only file + fit + color
  assert(!!validateTemplate(withBg({ type: 'image', file: 'poster.jpg', fit: 'cover', color: '112233' })),
    'accepts image: file + fit + color');
  // fit defaults are optional now — image with no fit still validates
  assert(!!validateTemplate(withBg({ type: 'image', file: 'poster.jpg', color: '112233' })),
    'accepts image: file + color (fit omitted)');

  rejects(() => validateTemplate(withBg({ type: 'image', file: '', fit: 'cover', color: '112233' })),
    'image with empty (missing) file');
  rejects(() => validateTemplate(withBg({ type: 'image', file: 'art/poster.jpg', fit: 'cover', color: '112233' })),
    'image file with a forward slash');
  rejects(() => validateTemplate(withBg({ type: 'image', file: '..\\poster.jpg', fit: 'cover', color: '112233' })),
    'image file with a path-traversal segment');
  rejects(() => validateTemplate(withBg({ type: 'image', file: 'poster.jpg', fit: 'zoom', color: '112233' })),
    'unknown fit value');
  rejects(() => validateTemplate(withBg({ type: 'image', file: 'poster.jpg', fit: 'cover', color: 'xyz' })),
    'image missing a valid fallback color');

  // solid is unchanged — still valid with and without fit
  assert(!!validateTemplate(withBg({ type: 'solid', color: '1a1a2e' })), 'accepts solid (no fit)');
  assert(!!validateTemplate(withBg({ type: 'solid', color: '1a1a2e', fit: 'cover' })), 'accepts solid (with fit)');
  rejects(() => validateTemplate(withBg({ type: 'gradient', color: '1a1a2e' })), 'unknown background type');
}

// ── 11: fit math (cover / contain / stretch) ──────────────────────────────────────
console.log('\n=== 11: computeBackgroundDrawRect ===');
{
  const FW = 1920, FH = 1080;
  // stretch: exactly the frame regardless of source aspect
  const st = computeBackgroundDrawRect('stretch', 100, 50, FW, FH);
  assert(st.dx === 0 && st.dy === 0 && st.dw === FW && st.dh === FH, 'stretch fills the frame exactly');
  // cover a square: scales to the larger ratio (19.2) → 1920×1920, vertically centred
  const cov = computeBackgroundDrawRect('cover', 100, 100, FW, FH);
  assert(cov.dw === 1920 && cov.dh === 1920 && cov.dy === -420, 'cover fills + crops (centred)');
  // contain a square: scales to the smaller ratio (10.8) → 1080×1080, horizontally centred
  const con = computeBackgroundDrawRect('contain', 100, 100, FW, FH);
  assert(con.dw === 1080 && con.dh === 1080 && con.dx === 420, 'contain letterboxes (centred)');
  // default (unknown / undefined) behaves like cover
  const def = computeBackgroundDrawRect(undefined, 100, 100, FW, FH);
  assert(def.dw === 1920 && def.dh === 1920, 'undefined fit defaults to cover');
}

// ── 12: duplicating a built-in image template starts solid ────────────────────────
console.log('\n=== 12: duplicate(built-in image) → solid ===');
{
  // Cinema/Theatrical ship as type:image with no portable file; the copy must not
  // carry a dangling image reference.
  const dupId = store.duplicate('theatrical', 'My Theatrical');
  assertEq(store.loadById(dupId).background.type, 'solid', 'duplicate of built-in image → solid background');
}

// ── 13: horizontal layout schema (v1.22.0 studio bar) ─────────────────────────────
console.log('\n=== 13: horizontal layout schema ===');
{
  const withBtn = (extra) => { const t = loadTemplate('classic'); Object.assign(t.button, extra); return t; };

  // valid horizontal: layout + required barColor + optional bar/icon fields
  assert(!!validateTemplate(withBtn({ layout: 'horizontal', barColor: '00b4d8', barOpacity: 0.9, barHeight: 140, iconSize: 52, count: 4 })),
    'accepts horizontal with valid bar fields');
  // explicit vertical with no bar fields
  assert(!!validateTemplate(withBtn({ layout: 'vertical' })), 'accepts explicit vertical (no bar fields)');
  // absent layout (backward compat — classic ships without it)
  assert(!!validateTemplate(loadTemplate('classic')), 'accepts absent layout (backward compat)');
  // vertical may carry stray bar fields (future-proof: ignored, not rejected)
  assert(!!validateTemplate(withBtn({ layout: 'vertical', barColor: 'abcdef', barHeight: 999 })),
    'vertical ignores stray bar fields');

  rejects(() => validateTemplate(withBtn({ layout: 'diagonal' })), 'unknown layout value');
  rejects(() => validateTemplate(withBtn({ layout: 'horizontal' })), 'horizontal missing barColor');
  rejects(() => validateTemplate(withBtn({ layout: 'horizontal', barColor: 'zzzzzz' })), 'horizontal invalid barColor hex');
  rejects(() => validateTemplate(withBtn({ layout: 'horizontal', barColor: '111111', barOpacity: 1.5 })), 'barOpacity > 1');
  rejects(() => validateTemplate(withBtn({ layout: 'horizontal', barColor: '111111', barOpacity: -0.1 })), 'barOpacity < 0');
  rejects(() => validateTemplate(withBtn({ layout: 'horizontal', barColor: '111111', barHeight: 40 })), 'barHeight < 50');
  rejects(() => validateTemplate(withBtn({ layout: 'horizontal', barColor: '111111', barHeight: 500 })), 'barHeight > 400');
  rejects(() => validateTemplate(withBtn({ layout: 'horizontal', barColor: '111111', iconSize: 10 })), 'iconSize < 20');
  rejects(() => validateTemplate(withBtn({ count: 9 })), 'count > 8');
  rejects(() => validateTemplate(withBtn({ count: 0 })), 'count < 1');

  // the 4 shipped horizontal templates all declare layout horizontal + a bar color
  for (const id of ['ocean-bar', 'navy-bar', 'silver-bar', 'gold-bar']) {
    const t = loadTemplate(id);
    assertEq(t.button.layout, 'horizontal', `${id}: layout horizontal`);
    assert(/^[0-9a-f]{6}$/i.test(t.button.barColor), `${id}: has a 6-hex bar color`);
  }
}

// ── 14: computeAutoPositions horizontal vs vertical ───────────────────────────────
console.log('\n=== 14: computeAutoPositions layout ===');
const { computeAutoPositions } = require(path.join(__dirname, '..', 'src', 'lib', 'menu-builder.js'));
{
  const FW = 1920, bw = 180;
  const tpl = { button: { layout: 'horizontal', width: bw, height: 110, gap: 24, barHeight: 140, count: 4 } };
  const h = computeAutoPositions(tpl, 4);
  assertEq(h.length, 4, 'horizontal: 4 positions');
  assert(h[0].y === h[1].y && h[1].y === h[2].y && h[2].y === h[3].y, 'horizontal: all buttons share one Y (a row)');
  assert(h[0].x < h[1].x && h[1].x < h[2].x && h[2].x < h[3].x, 'horizontal: left-to-right order');
  // first and last button symmetric about the horizontal centre
  assert(Math.abs(h[0].x - (FW - (h[3].x + bw))) < 2, 'horizontal: row is centered (symmetric margins)');

  // vertical (legacy positional form) is unchanged: a single-column stack
  const v = computeAutoPositions(3, 800, 90, 30);
  assert(v[0].x === v[1].x && v[1].x === v[2].x, 'vertical: shared X (a column)');
  assert(v[0].y < v[1].y && v[1].y < v[2].y, 'vertical: top-to-bottom order');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('OVERALL: FAIL'); process.exit(1); }
else { console.log('OVERALL: PASS'); }
