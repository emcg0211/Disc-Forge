#!/usr/bin/env node
'use strict';
/**
 * selftest.js — self-contained correctness tests for the IG toolkit.
 * Run: node tools/ig-toolkit/selftest.js
 *
 * Codec round-trip tests run unconditionally. The full extract→repack
 * byte-identity test runs against a reference m2ts if one is found
 * (Toast 01200 at /tmp/igtk/toast_01200.m2ts, or $IGTK_REF).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib');

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); } }
function eqBuf(a, b) { return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b); }

// ── RLE round-trip ─────────────────────────────────────────────────────────
(() => {
  for (const [w, h] of [[16, 16], [80, 90], [120, 7]]) {
    const px = new Uint8Array(w * h);
    for (let i = 0; i < px.length; i++) px[i] = (i % 5 === 0) ? 0 : (i % 7) + 1; // mix transparent/colour runs
    const rle = lib.encodeRLE(px, w, h);
    const back = lib.decodeRLE(rle, w, h);
    ok(`RLE round-trip ${w}x${h}`, Buffer.from(px).equals(Buffer.from(back)));
  }
})();

// ── PES timestamp round-trip ───────────────────────────────────────────────
(() => {
  for (const v of [0, 1, 90000, 108018, 0x1FFFFFFFF]) {
    const b = lib.encodeTimestamp(v, 0x2);
    const got = lib.parseTimestamp(b, 0);
    ok(`PTS round-trip ${v}`, got === v, `got ${got}`);
  }
})();

// ── segment encode/parse round-trip (synthetic) ────────────────────────────
(() => {
  const pds = { paletteId: 0, version: 0, entries: [{ id: 1, Y: 235, Cr: 128, Cb: 128, T: 0 }, { id: 2, Y: 16, Cr: 128, Cb: 128, T: 255 }] };
  ok('PDS round-trip', eqBuf(lib.encodePDS(lib.parsePDS(lib.encodePDS(pds))), lib.encodePDS(pds)));

  const wds = { windows: [{ id: 0, x: 10, y: 20, width: 300, height: 80 }] };
  ok('WDS round-trip', eqBuf(lib.encodeWDS(lib.parseWDS(lib.encodeWDS(wds))), lib.encodeWDS(wds)));

  const px = new Uint8Array(16 * 16).fill(1);
  const rle = lib.encodeRLE(px, 16, 16);
  const ods = { objectId: 0, version: 0, seq: 0xC0, first: 1, last: 1, dataLen: 4 + rle.length, width: 16, height: 16, rleHex: lib.hex(rle) };
  ok('ODS round-trip', eqBuf(lib.encodeODS(lib.parseODS(lib.encodeODS(ods))), lib.encodeODS(ods)));

  const ics = {
    videoWidth: 1920, videoHeight: 1080, frameRate: 0x40, compNumber: 0, compState: 2, seqDesc: 0xC0,
    streamModel: 0, uiModel: 0, compTimeoutPts: 0, selTimeoutPts: 0, userTimeout: 0,
    pages: [{
      id: 0, version: 0, uoMask: '0000000000000000', inEffectsHex: '0000', outEffectsHex: '0000',
      animFps: 0, defaultSelectedButtonIdRef: 0xFFFF, defaultActivatedButtonIdRef: 0xFFFF, paletteIdRef: 0,
      bogs: [{ defaultValidButtonIdRef: 1, buttons: [{
        id: 1, numericSelectValue: 0, autoAction: 0, x: 100, y: 200, upper: 0xFFFF, lower: 0xFFFF, left: 0xFFFF, right: 0xFFFF,
        normalStart: 0, normalEnd: 0, normalRepeat: 0, selSound: 0xFF, selStart: 0, selEnd: 0, selRepeat: 0,
        actSound: 0xFF, actStart: 0, actEnd: 0, navCmds: ['228000000000006300000000'],
      }] }],
    }],
  };
  const reics = lib.encodeICS(lib.parseICS(lib.encodeICS(ics)));
  ok('ICS round-trip', eqBuf(reics, lib.encodeICS(ics)));
})();

// ── full extract→repack byte identity (if a reference is available) ─────────
(() => {
  const ref = process.env.IGTK_REF || '/tmp/igtk/toast_01200.m2ts';
  if (!fs.existsSync(ref)) { console.log(`  SKIP  full round-trip (no reference at ${ref})`); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igtk_st_'));
  const pack = path.join(dir, 'r.pack');
  const out = path.join(dir, 'rt.m2ts');
  const reOut = path.join(dir, 're.m2ts');
  const here = __dirname;
  execFileSync('node', [path.join(here, 'extract.js'), ref, pack], { stdio: 'ignore' });
  execFileSync('node', [path.join(here, 'repack.js'), pack, out], { stdio: 'ignore' });
  execFileSync('node', [path.join(here, 'repack.js'), pack, reOut, '--reencode-all'], { stdio: 'ignore' });
  const orig = fs.readFileSync(ref);
  ok('extract→repack byte-identical', orig.equals(fs.readFileSync(out)));
  ok('extract→repack --reencode-all byte-identical', orig.equals(fs.readFileSync(reOut)));
  // segment round-trip flag in manifest
  const m = JSON.parse(fs.readFileSync(path.join(pack, 'manifest.json'), 'utf8'));
  ok('all segments round-trip exact', m.segmentRoundTripOK === true, `${m.mismatches.length} mismatches`);
  fs.rmSync(dir, { recursive: true, force: true });
})();

console.log(`\n──────────────────────────────────────────────────`);
console.log(`Results: ${pass} passed, ${fail} failed`);
console.log(`OVERALL: ${fail === 0 ? 'PASS' : 'FAIL'}`);
process.exit(fail === 0 ? 0 : 1);
