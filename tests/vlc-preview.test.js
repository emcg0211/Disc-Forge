'use strict';
/**
 * Unit tests for the VLC preview helper (src/lib/preview.js) and its wiring.
 * Run: node tests/vlc-preview.test.js
 *
 * preview.js is Electron-free; the `open -a VLC` call is injected via the
 * execFileFn seam so no real system call is ever made here. The IPC/preload
 * wiring is asserted by reading the source (main.js can't be required under
 * plain node — it pulls in `electron`), same pattern as burn.test.js.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { openInVlc, OPEN_BIN } = require(path.join(__dirname, '..', 'src', 'lib', 'preview.js'));

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); failed++; }
}
function assertEq(a, b, name) { assert(a === b, name, `expected ${b}, got ${a}`); }

(async () => {
  // ── 1: missing ISO → success:false, clear error, no exec call ──────────────────
  console.log('\n=== 1: missing ISO ===');
  {
    let execCalled = false;
    const r = await openInVlc({
      isoPath: path.join(os.tmpdir(), 'does-not-exist-vlc.iso'),
      execFileFn: () => { execCalled = true; },
    });
    assertEq(r.success, false, 'missing ISO → success:false');
    assert(/not found/i.test(r.error), 'error says the file was not found');
    assertEq(execCalled, false, 'open is never invoked for a missing ISO');

    const r2 = await openInVlc({ execFileFn: () => {} });
    assertEq(r2.success, false, 'no isoPath at all → success:false (never throws)');
  }

  // ── 2: invokes `open -a VLC <iso>` with the exact arguments ────────────────────
  console.log('\n=== 2: exec arguments ===');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vlctest-'));
    const tmpIso = path.join(tmpDir, 'fake.iso');
    fs.writeFileSync(tmpIso, 'not a real iso');

    let gotBin = null, gotArgs = null;
    const ok = await openInVlc({
      isoPath: tmpIso,
      execFileFn: (bin, args, cb) => { gotBin = bin; gotArgs = args; setImmediate(() => cb(null, '', '')); },
    });
    assertEq(ok.success, true, 'exec success → success:true');
    assertEq(gotBin, OPEN_BIN, 'invokes /usr/bin/open');
    assertEq(JSON.stringify(gotArgs), JSON.stringify(['-a', 'VLC', tmpIso]), 'arguments are -a VLC <isoPath>');

    // ── 3: VLC not installed (open exits 1) → friendly install pointer ──────────
    console.log('\n=== 3: VLC not installed ===');
    const notFound = await openInVlc({
      isoPath: tmpIso,
      execFileFn: (bin, args, cb) => setImmediate(() =>
        cb(new Error('Command failed'), '', "Unable to find application named 'VLC'")),
    });
    assertEq(notFound.success, false, 'open exit 1 → success:false');
    assert(/not installed/i.test(notFound.error), 'error says VLC is not installed');
    assert(/videolan\.org/i.test(notFound.error), 'error points at videolan.org');

    // Other failures surface the underlying detail.
    const other = await openInVlc({
      isoPath: tmpIso,
      execFileFn: (bin, args, cb) => setImmediate(() => cb(new Error('spawn EPERM'), '', '')),
    });
    assertEq(other.success, false, 'unexpected exec error → success:false');
    assert(/EPERM/.test(other.error), 'underlying error detail surfaced');

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  // ── 4: IPC + preload wiring ─────────────────────────────────────────────────────
  console.log('\n=== 4: wiring ===');
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert(mainSrc.includes("ipcMain.handle('open-in-vlc'"), "main.js registers ipcMain.handle('open-in-vlc')");
    const preSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
    assert(/openInVLC:\s*\(isoPath\)\s*=>/.test(preSrc), 'preload exposes openInVLC');
    const rendSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
    assert(rendSrc.includes('preview-vlc'), 'renderer renders the Preview in VLC button');
    assert(rendSrc.includes('openInVLC'), 'renderer calls openInVLC through the bridge');
  }

  // ─── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log('OVERALL: FAIL'); process.exit(1); }
  else { console.log('OVERALL: PASS'); }
})();
