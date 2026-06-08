'use strict';
/**
 * Unit tests for direct BD-R burning (src/lib/burn.js) and its IPC wiring.
 * Run: node tests/burn.test.js
 *
 * burn.js is intentionally Electron-free so the burn/checkBurner logic is testable
 * here. The IPC registration itself is asserted by reading src/main.js (main.js
 * can't be required under plain node — it pulls in `electron`).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const { checkBurner, burnDisc } = require(path.join(__dirname, '..', 'src', 'lib', 'burn.js'));

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); failed++; }
}
function assertEq(a, b, name) { assert(a === b, name, `expected ${b}, got ${a}`); }

(async () => {
  // ── 1: checkBurner returns { found: boolean } ──────────────────────────────────
  console.log('\n=== 1: checkBurner ===');
  {
    // Real call on the test machine — must return an object with a boolean `found`,
    // regardless of whether a burner is actually present.
    const real = await checkBurner();
    assert(real && typeof real === 'object', 'checkBurner returns an object');
    assertEq(typeof real.found, 'boolean', 'checkBurner.found is a boolean');
    assert(real.name === null || typeof real.name === 'string', 'checkBurner.name is string|null');

    // Injected exec seam: a burner present → found:true with a name.
    const withBurner = await checkBurner({
      exec: (cb) => cb(null, JSON.stringify({ SPDiscBurningDataType: [{ _name: 'HL-DT-ST BD-RE' }] })),
    });
    assertEq(withBurner.found, true, 'parses a present burner → found:true');
    assertEq(withBurner.name, 'HL-DT-ST BD-RE', 'parses the burner name');

    // Empty list → found:false.
    const none = await checkBurner({ exec: (cb) => cb(null, JSON.stringify({ SPDiscBurningDataType: [] })) });
    assertEq(none.found, false, 'empty burner list → found:false');

    // exec error → found:false, no throw.
    const errored = await checkBurner({ exec: (cb) => cb(new Error('boom'), '') });
    assertEq(errored.found, false, 'exec error → found:false (no throw)');

    // Garbage output → found:false, no throw.
    const garbage = await checkBurner({ exec: (cb) => cb(null, 'not json') });
    assertEq(garbage.found, false, 'non-JSON output → found:false (no throw)');
  }

  // ── 2: burnDisc graceful failure on a missing ISO ──────────────────────────────
  console.log('\n=== 2: burnDisc missing ISO ===');
  {
    const r = await burnDisc({ isoPath: path.join(os.tmpdir(), 'does-not-exist-xyz.iso') });
    assert(r && typeof r === 'object', 'burnDisc returns a result object');
    assertEq(r.success, false, 'missing ISO → success:false');
    assertEq(typeof r.error, 'string', 'missing ISO → error message present');
    assert(/not found/i.test(r.error), 'error mentions the file was not found');

    // No isoPath at all → still resolves (never throws).
    const r2 = await burnDisc({});
    assertEq(r2.success, false, 'no isoPath → success:false (no throw)');
  }

  // ── 3: burnDisc success/failure parsing via a mock spawn ───────────────────────
  console.log('\n=== 3: burnDisc spawn handling ===');
  {
    // A fake hdiutil that exits 0 → success. Uses a real temp ISO so the existence
    // check passes; the spawn itself is mocked so nothing is actually burned.
    const tmpIso = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'burntest-')), 'fake.iso');
    fs.writeFileSync(tmpIso, 'not a real iso');

    function fakeSpawn(exitCode, lines = [], emitErr = null) {
      return () => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        setImmediate(() => {
          if (emitErr) { proc.emit('error', emitErr); return; }
          for (const l of lines) proc.stdout.emit('data', Buffer.from(l + '\n'));
          proc.emit('close', exitCode);
        });
        return proc;
      };
    }

    const logged = [];
    const okRes = await burnDisc({ isoPath: tmpIso, spawnFn: fakeSpawn(0, ['Opening device', 'Writing track']), onLog: l => logged.push(l) });
    assertEq(okRes.success, true, 'exit 0 → success:true');
    assert(logged.includes('Writing track'), 'streams output lines to onLog');

    const failRes = await burnDisc({ isoPath: tmpIso, spawnFn: fakeSpawn(1, ['hdiutil: burn failed - device busy']) });
    assertEq(failRes.success, false, 'non-zero exit → success:false');
    assert(/device busy/i.test(failRes.error), 'failure surfaces the hdiutil error');

    const spawnErr = await burnDisc({ isoPath: tmpIso, spawnFn: fakeSpawn(0, [], new Error('spawn ENOENT')) });
    assertEq(spawnErr.success, false, 'spawn error → success:false');
    assert(/ENOENT/.test(spawnErr.error), 'spawn error surfaced in result');

    try { fs.rmSync(path.dirname(tmpIso), { recursive: true, force: true }); } catch {}
  }

  // ── 4: IPC handlers are registered in main.js ──────────────────────────────────
  console.log('\n=== 4: main.js IPC registration ===');
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert(mainSrc.includes("ipcMain.handle('disc:burn'"), "main.js registers ipcMain.handle('disc:burn')");
    assert(mainSrc.includes("ipcMain.handle('disc:checkBurner'"), "main.js registers ipcMain.handle('disc:checkBurner')");
    assert(mainSrc.includes("ipcMain.handle('chapter:extractThumb'"), "main.js registers ipcMain.handle('chapter:extractThumb')");
    // The burn handler must use the no-verify / no-eject safety flags (via burn.js).
    const burnSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'burn.js'), 'utf8');
    assert(burnSrc.includes('-noverify') && burnSrc.includes('-noeject'), 'burn.js uses -noverify and -noeject');

    // preload exposes the new bridge methods.
    const preSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
    assert(/burnDisc:\s*\(opts\)\s*=>/.test(preSrc), 'preload exposes burnDisc');
    assert(/checkBurner:\s*\(\)\s*=>/.test(preSrc), 'preload exposes checkBurner');
    assert(/extractChapterThumb:\s*\(opts\)\s*=>/.test(preSrc), 'preload exposes extractChapterThumb');
  }

  // ─── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log('OVERALL: FAIL'); process.exit(1); }
  else { console.log('OVERALL: PASS'); }
})();
