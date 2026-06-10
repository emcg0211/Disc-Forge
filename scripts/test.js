'use strict';
/**
 * test.js — Disc Forge test runner (`npm test`).
 *
 * Runs every tests/*.test.js with node, streams each suite's output through,
 * parses its "Results: N passed, M failed" summary line, and exits non-zero
 * if any suite fails an assertion or exits with a non-zero code.
 *
 * Suites are plain-node scripts with their own assert harness (no framework).
 * menu-video.test.js self-skips (exit 0, "Results: 0 passed, 0 failed") when
 * ffmpeg/ffprobe are not installed — the runner treats that as a pass, so the
 * suite is still meaningful on machines without media tools.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TESTS_DIR = path.join(__dirname, '..', 'tests');

const files = fs.readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (files.length === 0) {
  console.error('No test files found in tests/');
  process.exit(1);
}

let totalPassed = 0;
let totalFailed = 0;
let suitesFailed = 0;
const rows = [];

for (const f of files) {
  const file = path.join(TESTS_DIR, f);
  console.log(`\n══════ ${f} ══════`);
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(out);

  const m = out.match(/Results:\s*(\d+)\s*passed,\s*(\d+)\s*failed/);
  const passed = m ? parseInt(m[1], 10) : 0;
  const failed = m ? parseInt(m[2], 10) : 0;
  // A suite is broken if it failed assertions, exited non-zero (crash), or
  // produced no parseable summary at all (e.g. a syntax/require error).
  const broken = failed > 0 || r.status !== 0 || (!m && r.status === 0);

  totalPassed += passed;
  totalFailed += failed;
  if (broken) suitesFailed++;
  rows.push({ f, passed, failed, status: broken ? 'FAIL' : 'PASS' });
}

console.log(`\n${'═'.repeat(56)}`);
console.log('SUITE SUMMARY');
for (const r of rows) {
  console.log(`  ${r.status}  ${r.f}  (${r.passed} passed, ${r.failed} failed)`);
}
console.log(`${'═'.repeat(56)}`);
console.log(`TOTAL: ${totalPassed} passed, ${totalFailed} failed across ${files.length} suites`);

if (suitesFailed > 0) {
  console.log(`OVERALL: FAIL (${suitesFailed} suite${suitesFailed === 1 ? '' : 's'} failed)`);
  process.exit(1);
}
console.log('OVERALL: PASS');
process.exit(0);
