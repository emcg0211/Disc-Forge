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

const { checkBurner, burnDisc, parseBurnProgress } = require(path.join(__dirname, '..', 'src', 'lib', 'burn.js'));

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

    assert(real.deviceNode === null || typeof real.deviceNode === 'string', 'checkBurner.deviceNode is string|null');

    // Injected seams: a burner present → found:true with a name, and the device
    // node parsed out of `drutil status` (e.g. /dev/disk9) for growisofs.
    const withBurner = await checkBurner({
      exec: (cb) => cb(null, JSON.stringify({ SPDiscBurningDataType: [{ _name: 'HL-DT-ST BD-RE' }] })),
      execDrutil: (cb) => cb(null, '           Type: BD-RE                Name: /dev/disk9\n'),
    });
    assertEq(withBurner.found, true, 'parses a present burner → found:true');
    assertEq(withBurner.name, 'HL-DT-ST BD-RE', 'parses the burner name');
    assertEq(withBurner.deviceNode, '/dev/disk9', 'parses the device node from drutil status');

    // Burner present but drutil yields no device node → found:true, deviceNode:null.
    const noNode = await checkBurner({
      exec: (cb) => cb(null, JSON.stringify({ SPDiscBurningDataType: [{ _name: 'HL-DT-ST BD-RE' }] })),
      execDrutil: (cb) => cb(new Error('no drive'), ''),
    });
    assertEq(noNode.found, true, 'burner present even if drutil fails → found:true');
    assertEq(noNode.deviceNode, null, 'no device node from drutil → deviceNode:null');

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
    // A fake growisofs that exits 0 → success. Uses a real temp ISO so the existence
    // check passes; the spawn itself is mocked so nothing is actually burned. A second
    // real file stands in for the growisofs binary so its existence check passes too.
    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'burntest-'));
    const tmpIso  = path.join(tmpDir, 'fake.iso');
    const fakeBin = path.join(tmpDir, 'growisofs');
    fs.writeFileSync(tmpIso, 'not a real iso');
    fs.writeFileSync(fakeBin, '#!/bin/sh\n');
    const dev = '/dev/disk9';

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
    // Hermetic stand-in for the pre-burn `diskutil unmountDisk` so tests never
    // touch real disks. okUnmount = something was mounted and unmounted;
    // failUnmount = blank/erased disc (nothing mounted → diskutil errors).
    const okUnmount   = (d, cb) => setImmediate(() => cb(null, `Unmount of all volumes on ${d} was successful`));
    const failUnmount = (d, cb) => setImmediate(() => cb(new Error('Unmount failed'), `Unmount of ${d} failed: at least one volume could not be unmounted`));

    const logged = [];
    const okRes = await burnDisc({ isoPath: tmpIso, deviceNode: dev, growisofsPath: fakeBin, spawnFn: fakeSpawn(0, ['Executing growisofs', 'writing to /dev/disk9']), unmountFn: okUnmount, onLog: l => logged.push(l) });
    assertEq(okRes.success, true, 'exit 0 → success:true');
    assert(logged.includes('writing to /dev/disk9'), 'streams output lines to onLog');

    const failRes = await burnDisc({ isoPath: tmpIso, deviceNode: dev, growisofsPath: fakeBin, spawnFn: fakeSpawn(1, [':-( unable to open /dev/disk9: device busy']), unmountFn: okUnmount });
    assertEq(failRes.success, false, 'non-zero exit → success:false');
    assert(/device busy/i.test(failRes.error), 'failure surfaces the growisofs error');

    const spawnErr = await burnDisc({ isoPath: tmpIso, deviceNode: dev, growisofsPath: fakeBin, spawnFn: fakeSpawn(0, [], new Error('spawn ENOENT')), unmountFn: okUnmount });
    assertEq(spawnErr.success, false, 'spawn error → success:false');
    assert(/ENOENT/.test(spawnErr.error), 'spawn error surfaced in result');

    // ── 3b: pre-burn unmount is BEST-EFFORT ──────────────────────────────────────
    // A blank/erased disc has nothing mounted, so `diskutil unmountDisk` fails
    // (growisofs's own internal attempt printed ":-( unable to umount: Block
    // device required" and ABORTED). The unmount failure must be logged and the
    // burn must proceed regardless.
    const blankLog = [];
    const blankRes = await burnDisc({ isoPath: tmpIso, deviceNode: dev, growisofsPath: fakeBin, spawnFn: fakeSpawn(0, ['writing to /dev/disk9']), unmountFn: failUnmount, onLog: l => blankLog.push(l) });
    assertEq(blankRes.success, true, 'unmount failure on blank disc → burn still proceeds and succeeds');
    assert(blankLog.some(l => /unmount .* failed .*continuing/i.test(l)), 'unmount failure is logged as non-fatal ("continuing")');
    assert(blankLog.includes('writing to /dev/disk9'), 'growisofs still ran after the failed unmount');

    const okLog = [];
    await burnDisc({ isoPath: tmpIso, deviceNode: dev, growisofsPath: fakeBin, spawnFn: fakeSpawn(0, []), unmountFn: okUnmount, onLog: l => okLog.push(l) });
    assert(okLog.some(l => /unmount of all volumes/i.test(l)), 'successful unmount is logged');

    // The unmount must come BEFORE growisofs (order matters: growisofs aborts on
    // a mounted volume).
    const order = [];
    await burnDisc({
      isoPath: tmpIso, deviceNode: dev, growisofsPath: fakeBin,
      unmountFn: (d, cb) => { order.push('unmount'); setImmediate(() => cb(null, '')); },
      spawnFn: (...a) => { order.push('growisofs'); return fakeSpawn(0)(...a); },
    });
    assertEq(order.join(','), 'unmount,growisofs', 'unmount runs before growisofs');

    // ── 3c: real burn progress parsed from growisofs output ─────────────────────
    console.log('\n=== 3c: burn progress parsing ===');
    // parseBurnProgress — the two growisofs formats and the traps.
    assertEq(parseBurnProgress('4521984/3964231680 ( 0.1%) @0.9x, remaining 14:32 RBU 100.0% UBU  96.9%'),
      0.1, 'ISO-burn line → parenthesized percent (NOT the RBU/UBU buffer percents)');
    assertEq(parseBurnProgress('3964231680/3964231680 (100.0%) @0.9x, remaining 0:00 RBU 0.0% UBU 0.0%'),
      100, 'final line → 100');
    assertEq(parseBurnProgress(' 12.34% done, estimate finish Tue Jun 10 21:00:00 2026'),
      12.34, 'mkisofs-style "% done" line parses');
    assertEq(parseBurnProgress('writing to /dev/disk9'), null, 'plain log line → null');
    assertEq(parseBurnProgress(':-( unable to open /dev/disk9: device busy'), null, 'error line with parens → null');
    assertEq(parseBurnProgress('RBU 100.0% UBU 96.9%'), null, 'buffer-fill percents alone → null');
    assertEq(parseBurnProgress(''), null, 'empty line → null');

    // End-to-end through burnDisc: onProgress fires only for progress lines.
    const progress = [];
    const progLog = [];
    await burnDisc({
      isoPath: tmpIso, deviceNode: dev, growisofsPath: fakeBin, unmountFn: okUnmount,
      spawnFn: fakeSpawn(0, [
        'Executing builtin_dd',
        '4521984/3964231680 ( 0.1%) @0.9x, remaining 14:32 RBU 100.0% UBU  96.9%',
        '1982115840/3964231680 (50.0%) @4.0x, remaining 4:10 RBU 99.8% UBU 97.0%',
        'builtin_dd: flushing cache',
      ]),
      onLog: l => progLog.push(l),
      onProgress: p => progress.push(p),
    });
    assertEq(JSON.stringify(progress), JSON.stringify([0.1, 50]),
      'onProgress receives exactly the parsed percents, in order');
    assertEq(progLog.length >= 4, true, 'all lines still stream to onLog');

    // growisofs binary missing → clear install hint, never throws.
    const noBin = await burnDisc({ isoPath: tmpIso, deviceNode: dev, growisofsPath: path.join(tmpDir, 'nope') });
    assertEq(noBin.success, false, 'missing growisofs → success:false');
    assert(/dvd\+rw-tools/.test(noBin.error), 'missing growisofs → install hint');

    // No device node → success:false (cannot target a drive), never throws.
    const noDev = await burnDisc({ isoPath: tmpIso, growisofsPath: fakeBin, spawnFn: fakeSpawn(0) });
    assertEq(noDev.success, false, 'no deviceNode → success:false');

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  // ── 4: IPC handlers are registered in main.js ──────────────────────────────────
  console.log('\n=== 4: main.js IPC registration ===');
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert(mainSrc.includes("ipcMain.handle('disc:burn'"), "main.js registers ipcMain.handle('disc:burn')");
    assert(mainSrc.includes("ipcMain.handle('disc:checkBurner'"), "main.js registers ipcMain.handle('disc:checkBurner')");
    assert(mainSrc.includes("ipcMain.handle('chapter:extractThumb'"), "main.js registers ipcMain.handle('chapter:extractThumb')");
    // BD-R/BD-RE burning must go through growisofs (hdiutil burn cannot write
    // Blu-ray) and must never auto-eject (no eject call anywhere in burn.js).
    const burnSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'burn.js'), 'utf8');
    assert(/growisofs/.test(burnSrc), 'burn.js burns via growisofs');
    assert(burnSrc.includes('-dvd-compat') && burnSrc.includes('-Z'), 'burn.js uses growisofs -dvd-compat -Z');
    assert(!/_spawn\([^)]*hdiutil/.test(burnSrc), 'burn.js no longer spawns hdiutil');
    // Never auto-eject: growisofs is not invoked with an -eject flag.
    assert(!/['"`]-eject['"`]/.test(burnSrc), 'burn.js never passes -eject to growisofs');

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
