'use strict';
/**
 * Tests for pure renderer logic (src/renderer.js is a browser script and can't
 * be required under plain node, so the pure functions under test are extracted
 * from its source text and evaluated — they are deliberately self-contained).
 * Run: node tests/renderer-logic.test.js
 *
 * Covers: project schema-version merge (Improvement E2) and any other pure
 * renderer helpers added later.
 */

const path = require('path');
const fs = require('fs');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); failed++; }
}
function assertEq(a, b, name) { assert(a === b, name, `expected ${b}, got ${a}`); }

/** Extract a top-level `function name(...) {...}` block from renderer source. */
function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in renderer.js`);
  let depth = 0, i = SRC.indexOf('{', start);
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// defaultProject references RESOLUTIONS / VIDEO_FMTS — provide the same shapes.
const RESOLUTIONS = ['1080p (1920×1080)', '720p (1280×720)'];
const VIDEO_FMTS = ['H.264 AVC', 'H.265 HEVC'];
const factory = new Function('RESOLUTIONS', 'VIDEO_FMTS', `
  ${extractFn('defaultProject')}
  ${extractFn('mergeProjectWithDefaults')}
  return { defaultProject, mergeProjectWithDefaults };
`);
const { defaultProject, mergeProjectWithDefaults } = factory(RESOLUTIONS, VIDEO_FMTS);

console.log('\n=== 1: defaultProject is complete ===');
{
  const d = defaultProject();
  for (const key of ['title', 'titles', 'audioTracks', 'subtitleTracks', 'chapters', 'extras', 'menuConfig', 'igMenuConfig', 'chapterMenu', 'discSize', 'useSplash', 'useIGMenu']) {
    assert(d[key] !== undefined, `defaultProject().${key} is defined`);
  }
  assert(Array.isArray(d.titles) && d.titles.length === 0, 'titles defaults to []');
  assertEq(d.igMenuConfig.templateId, 'classic', 'igMenuConfig.templateId defaults to classic');
  assertEq(d.chapterMenu.enabled, true, 'chapterMenu.enabled defaults true');
}

console.log('\n=== 2: merging an EMPTY load → full defaults, nothing undefined ===');
{
  const merged = mergeProjectWithDefaults({}, defaultProject());
  const d = defaultProject();
  let undef = 0;
  for (const key of Object.keys(d)) if (merged[key] === undefined) undef++;
  assertEq(undef, 0, 'no undefined values for any default key');
  assertEq(JSON.stringify(merged), JSON.stringify(d), 'empty load reproduces the defaults exactly');
  const fromNull = mergeProjectWithDefaults(null, defaultProject());
  assertEq(JSON.stringify(fromNull), JSON.stringify(d), 'null load also reproduces the defaults');
}

console.log('\n=== 3: partial loads merge correctly ===');
{
  const merged = mergeProjectWithDefaults(
    { title: 'My Disc', igMenuConfig: { templateId: 'gold-bar' }, titles: [{ id: 't1' }] },
    defaultProject(),
  );
  assertEq(merged.title, 'My Disc', 'scalar override taken');
  assertEq(merged.igMenuConfig.templateId, 'gold-bar', 'nested override taken');
  assert(Array.isArray(merged.igMenuConfig.buttonLabels), 'nested MISSING field (buttonLabels) filled from defaults');
  assertEq(merged.titles.length, 1, 'array taken whole');
  assertEq(merged.chapters.length, 0, 'missing array → default []');
  assertEq(merged.discSize, 'BD-25', 'missing scalar → default');
  // wrong-typed values fall back to defaults rather than corrupting state
  const fixed = mergeProjectWithDefaults({ titles: 'oops', igMenuConfig: 'oops' }, defaultProject());
  assert(Array.isArray(fixed.titles) && fixed.titles.length === 0, 'non-array for array field → default');
  assertEq(fixed.igMenuConfig.templateId, 'classic', 'non-object for object field → default');
  // null mainVideo stays null; object mainVideo passes through
  assertEq(mergeProjectWithDefaults({ mainVideo: null }, defaultProject()).mainVideo, null, 'null mainVideo → default null');
  const mv = mergeProjectWithDefaults({ mainVideo: { path: '/a.mkv' } }, defaultProject()).mainVideo;
  assertEq(mv && mv.path, '/a.mkv', 'mainVideo object passes through (null default)');
}

console.log('\n=== 4: schema-version wiring in renderer source ===');
{
  assert(/const PROJECT_SCHEMA_VERSION = 1/.test(SRC), 'PROJECT_SCHEMA_VERSION constant exists');
  assert(/schemaVersion: PROJECT_SCHEMA_VERSION/.test(SRC), 'saveProject stamps schemaVersion');
  assert(/schemaVersion > PROJECT_SCHEMA_VERSION/.test(SRC), 'loadProject detects newer-version files');
  assert(/newer version of Disc Forge/.test(SRC), 'newer-version warning message present');
  assert(/mergeProjectWithDefaults\(proj, defaultProject\(\)\)/.test(SRC), 'loadProject merges over full defaults');
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('OVERALL: FAIL'); process.exit(1); }
else { console.log('OVERALL: PASS'); }
