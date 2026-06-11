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

const { checkBurner, burnDisc, burnWithMediaCheck, checkMediaStatus, eraseDisc, ejectDisc, verifyBurn, parseBurnProgress, friendlyBurnError, DRUTIL } = require(path.join(__dirname, '..', 'src', 'lib', 'burn.js'));

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

    // ── 3e: friendly burn error mapping ───────────────────────────────────────────
    console.log('\n=== 3e: friendlyBurnError ===');
    {
      const cases = [
        [':-( unable to open /dev/disk9: device busy', /drive is busy/i],
        [':-( media is not blank, aborting', /not blank/i],
        [":-( /dev/disk9 doesn't look like it's blank", /not blank/i],
        [':-( calibration area almost full, use a new disc', /too many write sessions/i],
        [':-( write failed: no space left on device', /disc is full/i],
        [':-( unable to umount /Volumes/DISC: Block device required', /ejecting and reinserting/i],
      ];
      for (const [raw, want] of cases) {
        const out = friendlyBurnError(raw);
        assert(want.test(out), `maps: ${raw.slice(0, 44)}…`);
        assert(out.includes(raw), 'raw text kept for diagnostics');
      }
      const unknown = friendlyBurnError('some novel growisofs failure');
      assertEq(unknown, 'some novel growisofs failure', 'unknown errors pass through unchanged');

      // End-to-end: a failing burn surfaces the FRIENDLY message.
      const r = await burnDisc({
        isoPath: tmpIso, deviceNode: dev, growisofsPath: fakeBin, unmountFn: okUnmount,
        spawnFn: fakeSpawn(1, []),
      });
      assert(r.success === false, 'non-zero exit still fails');
      const r2 = await burnDisc({
        isoPath: tmpIso, deviceNode: dev, growisofsPath: fakeBin, unmountFn: okUnmount,
        spawnFn: (() => () => {
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
          setImmediate(() => {
            proc.stderr.emit('data', Buffer.from(':-( media is not blank, aborting\n'));
            proc.emit('close', 1);
          });
          return proc;
        })(),
      });
      assert(/not blank/i.test(r2.error) && /Use a blank BD-R/.test(r2.error), 'burnDisc failure returns the mapped message');
    }

    // ── 3g: reburn support — media status, erase, unmount retry, erase-and-burn ─────
    console.log('\n=== 3g: erase-and-burn flow for used BD-RE media ===');
    {
      // drutil status fixtures (shape verified against real drutil output).
      const STATUS_BLANK_BDRE = [
        ' Vendor   Product           Rev ',
        ' HL-DT-ST BD-RE  WH16NS40   1.05',
        '',
        '           Type: BD-RE                Name: /dev/disk4',
        '   Write Speeds: 2x, 4x, 6x',
        '      Overwrite:   23.30GB blank, appendable, overwritable',
      ].join('\n');
      const STATUS_USED_BDRE = [
        ' Vendor   Product           Rev ',
        ' HL-DT-ST BD-RE  WH16NS40   1.05',
        '',
        '           Type: BD-RE                Name: /dev/disk4',
        '   Write Speeds: 2x, 4x, 6x',
        '     Space Free: 0.00GB (0 blocks)    Book Type: BD-RE',
      ].join('\n');
      const STATUS_USED_BDR = STATUS_USED_BDRE.replace(/BD-RE {16}/, 'BD-R   ').replace('Book Type: BD-RE', 'Book Type: BD-R');
      const STATUS_NO_MEDIA = [
        ' Vendor   Product           Rev ',
        ' HL-DT-ST BD-RE  WH16NS40   1.05',
        '',
        '           Type: No Media Inserted',
      ].join('\n');
      const drutilStub = (out) => (bin, args, opts, cb) => setImmediate(() => cb(null, out, ''));

      // checkMediaStatus parsing
      const blank = await checkMediaStatus({ execFileFn: drutilStub(STATUS_BLANK_BDRE) });
      assertEq(blank.hasMedia, true, 'blank BD-RE: hasMedia');
      assertEq(blank.mediaType, 'BD-RE', 'blank BD-RE: mediaType parsed');
      assertEq(blank.isBlank, true, 'blank BD-RE: isBlank true');
      assertEq(blank.deviceNode, '/dev/disk4', 'blank BD-RE: device node from Name:');

      const used = await checkMediaStatus({ execFileFn: drutilStub(STATUS_USED_BDRE) });
      assertEq(used.isBlank, false, 'used BD-RE: isBlank false (no "blank" indicator)');
      assertEq(used.mediaType, 'BD-RE', 'used BD-RE: mediaType parsed');

      const none = await checkMediaStatus({ execFileFn: drutilStub(STATUS_NO_MEDIA) });
      assertEq(none.hasMedia, false, 'no media: hasMedia false');

      const broken = await checkMediaStatus({ execFileFn: (b, a, o, cb) => setImmediate(() => cb(new Error('boom'), '', '')) });
      assertEq(broken.hasMedia, false, 'drutil failure → hasMedia false (never throws)');

      // eraseDisc
      let eraseArgs = null;
      const erOk = await eraseDisc({ execFileFn: (bin, args, opts, cb) => { eraseArgs = args; setImmediate(() => cb(null, '', '')); } });
      assertEq(erOk.success, true, 'erase success');
      assertEq(JSON.stringify(eraseArgs), JSON.stringify(['erase', 'quick']), 'uses drutil erase quick');
      const erFail = await eraseDisc({ execFileFn: (b, a, o, cb) => setImmediate(() => cb(new Error('x'), '', 'erase failed: no media')) });
      assertEq(erFail.success, false, 'erase failure → success:false');
      assert(/no media/.test(erFail.error), 'erase stderr surfaced');

      // unmount retry: fails 3×, succeeds on the 4th — growisofs still runs,
      // and the spawn happens after the SUCCESSFUL unmount (order preserved).
      {
        const order = [];
        let attempts = 0;
        const r = await burnDisc({
          isoPath: tmpIso, deviceNode: dev, growisofsPath: fakeBin, unmountRetryDelayMs: 1,
          unmountFn: (d, cb) => {
            attempts++;
            order.push('unmount' + attempts);
            setImmediate(() => attempts < 4 ? cb(new Error('busy'), 'Resource busy') : cb(null, 'Unmount successful'));
          },
          spawnFn: (...a) => { order.push('growisofs'); return fakeSpawn(0)(...a); },
        });
        assertEq(r.success, true, 'retry flow: burn succeeds');
        assertEq(attempts, 4, 'unmount retried until success (4 attempts)');
        assertEq(order.join(','), 'unmount1,unmount2,unmount3,unmount4,growisofs',
          'growisofs spawns only after the successful unmount attempt');
      }
      // all 5 attempts fail → still burns (best-effort blank-disc path)
      {
        let attempts = 0;
        const r = await burnDisc({
          isoPath: tmpIso, deviceNode: dev, growisofsPath: fakeBin, unmountRetryDelayMs: 1,
          unmountFn: (d, cb) => { attempts++; setImmediate(() => cb(new Error('nothing mounted'), '')); },
          spawnFn: fakeSpawn(0, ['writing']),
        });
        assertEq(attempts, 5, 'unmount capped at 5 attempts');
        assertEq(r.success, true, 'exhausted retries still proceed to burn (best-effort)');
      }

      // burnWithMediaCheck: non-blank BD-RE without erase → needsErase, NO growisofs
      {
        let spawned = false;
        const r = await burnWithMediaCheck({
          isoPath: tmpIso, deviceNode: dev, growisofsPath: fakeBin,
          execFileFn: drutilStub(STATUS_USED_BDRE),
          spawnFn: () => { spawned = true; return fakeSpawn(0)(); },
          unmountFn: okUnmount,
        });
        assertEq(r.needsErase, true, 'used BD-RE without erase → needsErase:true');
        assertEq(r.mediaType, 'BD-RE', 'needsErase carries the media type');
        assertEq(spawned, false, 'growisofs is NOT spawned for a needsErase response');
      }
      // non-blank write-once BD-R → friendly refusal, no erase, no burn
      {
        const r = await burnWithMediaCheck({
          isoPath: tmpIso, deviceNode: dev, growisofsPath: fakeBin,
          execFileFn: drutilStub(STATUS_USED_BDR),
          spawnFn: fakeSpawn(0), unmountFn: okUnmount,
        });
        assertEq(r.success, false, 'used BD-R → refused');
        assert(/write-once|cannot be erased/i.test(r.error), 'BD-R refusal explains why');
        assertEq(r.needsErase, undefined, 'BD-R never offers erase');
      }
      // erase:true flow — erases, RE-RESOLVES the node (changed after erase),
      // burns to the NEW node, stages in order.
      {
        const STATUS_BLANK_NEWNODE = STATUS_BLANK_BDRE.replace('/dev/disk4', '/dev/disk6');
        const calls = [];
        const stages = [];
        let statusCount = 0;
        const seqExec = (bin, args, opts, cb) => {
          calls.push(args.join(' '));
          if (args[0] === 'status') {
            statusCount++;
            // 1st status: used disc on disk4; post-erase status: blank on disk6
            return setImmediate(() => cb(null, statusCount === 1 ? STATUS_USED_BDRE : STATUS_BLANK_NEWNODE, ''));
          }
          return setImmediate(() => cb(null, '', ''));  // erase quick
        };
        let burnedTo = null;
        const r = await burnWithMediaCheck({
          isoPath: tmpIso, deviceNode: '/dev/disk4', erase: true, growisofsPath: fakeBin,
          execFileFn: seqExec, unmountFn: okUnmount, unmountRetryDelayMs: 1,
          onStage: (s) => stages.push(s),
          spawnFn: (bin, args) => { burnedTo = args[args.length - 1]; return fakeSpawn(0)(); },
        });
        assertEq(r.success, true, 'erase-and-burn flow succeeds');
        assertEq(stages.join(','), 'checking,erasing,burning', 'stages emitted in order');
        assert(calls.includes('erase quick'), 'drutil erase quick was invoked');
        assert(burnedTo && burnedTo.startsWith('/dev/disk6='), `burns to the RE-RESOLVED node (/dev/disk6), got ${burnedTo}`);
        assertEq(r.deviceNode, '/dev/disk6', 'result carries the node actually burned to');
      }
      // blank disc → straight to burning, no erase, single status check
      {
        const stages = [];
        const r = await burnWithMediaCheck({
          isoPath: tmpIso, deviceNode: dev, growisofsPath: fakeBin,
          execFileFn: drutilStub(STATUS_BLANK_BDRE), unmountFn: okUnmount, unmountRetryDelayMs: 1,
          onStage: (s) => stages.push(s), spawnFn: fakeSpawn(0),
        });
        assertEq(r.success, true, 'blank disc burns directly');
        assertEq(stages.join(','), 'checking,burning', 'no erasing stage for blank media');
      }

      // new friendlyBurnError mappings
      assert(/already has data/i.test(friendlyBurnError(':-( /dev/disk4 already carries isofs!')),
        '"already carries isofs" → has-data guidance');
      assert(/re-mounted|reinsert/i.test(friendlyBurnError(':-( unable to umount: Block device required')),
        '"Block device required" → remount-race guidance');
    }


    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  // ── 3d: ejectDisc (drutil eject, seam-injected) ─────────────────────────────────
  console.log('\n=== 3d: ejectDisc ===');
  {
    let gotBin = null, gotArgs = null;
    const ok = await ejectDisc({ execFileFn: (bin, args, cb) => { gotBin = bin; gotArgs = args; setImmediate(() => cb(null, '', '')); } });
    assertEq(ok.success, true, 'drutil exit 0 → success:true');
    assertEq(gotBin, DRUTIL, 'invokes drutil');
    assertEq(JSON.stringify(gotArgs), JSON.stringify(['eject']), 'with the eject verb');

    const fail = await ejectDisc({ execFileFn: (bin, args, cb) => setImmediate(() => cb(new Error('exit 1'), '', 'no media present')) });
    assertEq(fail.success, false, 'drutil failure → success:false');
    assert(/no media present/.test(fail.error), 'stderr detail surfaced');
  }

  // ── 3f: verifyBurn (first-1MB device read-back, seam-injected) ───────────────────
  console.log('\n=== 3f: verifyBurn ===');
  {
    const vDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifytest-'));
    const vIso = path.join(vDir, 'v.iso');
    const head = Buffer.alloc(4096); head.fill(0xAB);
    fs.writeFileSync(vIso, head);

    let gotBin = null, gotArgs = null;
    const match = await verifyBurn({
      isoPath: vIso, deviceNode: '/dev/disk9',
      execFileFn: (bin, args, opts, cb) => { gotBin = bin; gotArgs = args; setImmediate(() => cb(null, Buffer.from(head), '')); },
    });
    assertEq(match.verified, true, 'identical first MB → verified:true');
    assertEq(gotBin, '/bin/dd', 'reads the device via dd');
    assert(gotArgs[0] === 'if=/dev/rdisk9', 'uses the RAW device node (rdisk)');

    const bad = Buffer.from(head); bad[100] ^= 0xFF;
    const mismatch = await verifyBurn({
      isoPath: vIso, deviceNode: '/dev/disk9',
      execFileFn: (bin, args, opts, cb) => setImmediate(() => cb(null, bad, '')),
    });
    assertEq(mismatch.verified, false, 'differing bytes → verified:false');
    assert(/corrupt/i.test(mismatch.error), 'mismatch explains the disc may be corrupt');

    const noRead = await verifyBurn({
      isoPath: vIso, deviceNode: '/dev/disk9',
      execFileFn: (bin, args, opts, cb) => setImmediate(() => cb(new Error('Operation not permitted'), Buffer.alloc(0), '')),
    });
    assertEq(noRead.verified, null, 'unreadable device → verified:null (not a failed burn)');
    assert(/burn itself reported success/i.test(noRead.error), 'read-back failure is softened');

    const noIso = await verifyBurn({ isoPath: path.join(vDir, 'gone.iso'), deviceNode: '/dev/disk9', execFileFn: () => {} });
    assertEq(noIso.verified, null, 'missing ISO → verified:null');

    try { fs.rmSync(vDir, { recursive: true, force: true }); } catch {}
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
