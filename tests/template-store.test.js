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
const { renderButtonPreviewPng } = require(path.join(__dirname, '..', 'src', 'lib', 'menu-builder.js'));
const { loadTemplate } = require(path.join(__dirname, '..', 'src', 'lib', 'template.js'));

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
  assert(ids.length === 12, 'listBuiltIn: 12 built-in templates');
  for (const id of ['classic', 'minimal', 'theatrical']) {
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

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('OVERALL: FAIL'); process.exit(1); }
else { console.log('OVERALL: PASS'); }
