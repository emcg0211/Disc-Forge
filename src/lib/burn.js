'use strict';
/**
 * burn.js — direct BD-R burning helpers for Disc Forge (v1.23.0).
 *
 * Wraps macOS's built-in `hdiutil burn` so a finished ISO can be written straight
 * to a blank BD-R from inside the app — no third-party tools. The IPC layer
 * (main.js disc:burn / disc:checkBurner) is a thin shell over these functions;
 * keeping the logic here (no Electron dependency) makes it unit-testable.
 *
 * Safety contract (matches the app's hard constraints):
 *   - hdiutil runs with -noverify (skip the 10-15min post-burn read-verify) AND
 *     -noeject (NEVER auto-eject — the user stays in control of the disc).
 *   - burnDisc never throws: it always resolves a { success, error? } result.
 */

const fs = require('fs');
const { spawn, execFile } = require('child_process');

const SYSTEM_PROFILER = '/usr/sbin/system_profiler';
const HDIUTIL = '/usr/bin/hdiutil';

/**
 * Detect whether a disc burner is connected via `system_profiler`.
 * Returns { found: boolean, name: string|null } and never throws.
 *
 * @param {object} [opts]
 * @param {function} [opts.exec] - test seam: exec(cb) → cb(err, stdout). Defaults
 *                                 to running `system_profiler SPDiscBurningDataType -json`.
 * @returns {Promise<{found:boolean, name:string|null}>}
 */
function checkBurner({ exec } = {}) {
  return new Promise((resolve) => {
    const finish = (found, name) => resolve({ found: !!found, name: name || null });
    const runner = exec || ((cb) => {
      try {
        const proc = execFile(
          SYSTEM_PROFILER, ['SPDiscBurningDataType', '-json'],
          { timeout: 12000, maxBuffer: 4 << 20 },
          (err, stdout) => cb(err, stdout),
        );
        proc.on('error', (e) => cb(e, ''));
      } catch (e) { cb(e, ''); }
    });
    runner((err, stdout) => {
      if (err || !stdout) return finish(false, null);
      try {
        const data = JSON.parse(stdout.toString());
        const burners = (data && data.SPDiscBurningDataType) || [];
        if (!Array.isArray(burners) || burners.length === 0) return finish(false, null);
        const b = burners[0] || {};
        finish(true, b._name || b.spdisc_burner_model || 'Optical Drive');
      } catch {
        finish(false, null);
      }
    });
  });
}

/**
 * Burn an ISO to disc via `hdiutil burn <iso> -noverify -noeject -quiet`, streaming
 * each output line to onLog. Always resolves a result object — never throws.
 *
 * @param {object}   opts
 * @param {string}   opts.isoPath        - path to the ISO to burn (must exist)
 * @param {string}   [opts.hdiutilPath]  - hdiutil binary (default /usr/bin/hdiutil)
 * @param {function} [opts.onLog]        - called with each trimmed output line
 * @param {function} [opts.spawnFn]      - test seam for child_process.spawn
 * @returns {Promise<{success:boolean, error?:string}>}
 */
function burnDisc({ isoPath, hdiutilPath = HDIUTIL, onLog = () => {}, spawnFn } = {}) {
  return new Promise((resolve) => {
    if (!isoPath || !fs.existsSync(isoPath)) {
      return resolve({ success: false, error: `ISO file not found: ${isoPath || '(none)'}` });
    }
    const _spawn = spawnFn || spawn;
    let proc;
    try {
      // -noverify: skip post-burn read-verify. -noeject: keep the disc in the drive
      // (never auto-eject). -quiet: suppress hdiutil chatter (we stream our own lines).
      proc = _spawn(hdiutilPath, ['burn', isoPath, '-noverify', '-noeject', '-quiet']);
    } catch (e) {
      return resolve({ success: false, error: 'hdiutil error: ' + e.message });
    }

    let stdout = '', stderr = '';
    const emit = (buf, isErr) => {
      const text = buf.toString();
      if (isErr) stderr += text; else stdout += text;
      text.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => { try { onLog(l); } catch {} });
    };
    if (proc.stdout) proc.stdout.on('data', d => emit(d, false));
    if (proc.stderr) proc.stderr.on('data', d => emit(d, true));
    proc.on('error', err => resolve({ success: false, error: 'hdiutil error: ' + err.message }));
    proc.on('close', code => {
      const combined = stdout + stderr;
      if (code === 0 || /Burn completed successfully/i.test(combined)) {
        resolve({ success: true });
      } else {
        const msg = stderr.trim() || stdout.trim() || `hdiutil burn exited with code ${code}`;
        resolve({ success: false, error: msg });
      }
    });
  });
}

module.exports = { checkBurner, burnDisc, SYSTEM_PROFILER, HDIUTIL };
