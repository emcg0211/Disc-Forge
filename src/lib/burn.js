'use strict';
/**
 * burn.js — direct BD-R burning helpers for Disc Forge.
 *
 * macOS's built-in `hdiutil burn` does NOT support Blu-ray media, so we shell out
 * to `growisofs` (from dvd+rw-tools: `brew install dvd+rw-tools`) to write a finished
 * ISO straight to a blank BD-R/BD-RE. The IPC layer (main.js disc:burn /
 * disc:checkBurner) is a thin shell over these functions; keeping the logic here
 * (no Electron dependency) makes it unit-testable.
 *
 * Safety contract (matches the app's hard constraints):
 *   - Before burning, the target disc is unmounted via `diskutil unmountDisk`
 *     (BEST-EFFORT: a blank/erased disc has nothing mounted and diskutil fails —
 *     that is logged and ignored, never fatal). macOS auto-mounts any disc with
 *     a readable filesystem (e.g. a previously burned BD-RE), and growisofs
 *     refuses to write to a mounted volume — its own internal unmount attempt
 *     fails on macOS (":-( unable to umount: Block device required") and aborts
 *     the burn.
 *   - growisofs is invoked as `growisofs -dvd-compat -Z <deviceNode>=<iso>` and
 *     NOTHING else — no eject, no post-burn verify. The user stays in control of
 *     the disc.
 *   - burnDisc never throws: it always resolves a { success, error? } result.
 */

const fs = require('fs');
const { spawn, execFile } = require('child_process');

const SYSTEM_PROFILER = '/usr/sbin/system_profiler';
const DRUTIL = '/usr/bin/drutil';
const DISKUTIL = '/usr/sbin/diskutil';
const GROWISOFS = '/opt/homebrew/bin/growisofs';

/**
 * Detect whether a disc burner is connected and resolve its device node.
 *
 * Drive presence + model come from `system_profiler SPDiscBurningDataType -json`
 * (the same source the rest of the app uses). The device node growisofs needs
 * (e.g. /dev/disk9) is NOT in system_profiler's output, so it is read separately
 * from `drutil status` ("Name: /dev/disk9"). Never throws.
 *
 * @param {object}   [opts]
 * @param {function} [opts.exec]       - test seam: exec(cb) → cb(err, stdout) for
 *                                        system_profiler. Defaults to the real call.
 * @param {function} [opts.execDrutil] - test seam: execDrutil(cb) → cb(err, stdout)
 *                                        for `drutil status`. Defaults to the real call.
 * @returns {Promise<{found:boolean, name:string|null, deviceNode:string|null}>}
 */
function checkBurner({ exec, execDrutil } = {}) {
  return new Promise((resolve) => {
    const finish = (found, name, deviceNode) =>
      resolve({ found: !!found, name: name || null, deviceNode: deviceNode || null });

    const runSp = exec || ((cb) => {
      try {
        const proc = execFile(
          SYSTEM_PROFILER, ['SPDiscBurningDataType', '-json'],
          { timeout: 12000, maxBuffer: 4 << 20 },
          (err, stdout) => cb(err, stdout),
        );
        proc.on('error', (e) => cb(e, ''));
      } catch (e) { cb(e, ''); }
    });

    runSp((err, stdout) => {
      if (err || !stdout) return finish(false, null, null);
      let name = null;
      try {
        const data = JSON.parse(stdout.toString());
        const burners = (data && data.SPDiscBurningDataType) || [];
        if (!Array.isArray(burners) || burners.length === 0) return finish(false, null, null);
        const b = burners[0] || {};
        name = b._name || b.spdisc_burner_model || 'Optical Drive';
      } catch {
        return finish(false, null, null);
      }

      // A burner is present — now resolve its device node from `drutil status`.
      const runDrutil = execDrutil || ((cb) => {
        try {
          const proc = execFile(
            DRUTIL, ['status'],
            { timeout: 10000, maxBuffer: 1 << 20 },
            (e, out) => cb(e, out),
          );
          proc.on('error', (e) => cb(e, ''));
        } catch (e) { cb(e, ''); }
      });

      runDrutil((derr, dout) => {
        let deviceNode = null;
        if (!derr && dout) {
          const m = dout.toString().match(/\/dev\/r?disk\d+/);
          if (m) deviceNode = m[0];
        }
        finish(true, name, deviceNode);
      });
    });
  });
}

/**
 * Parse a burn progress percentage out of one growisofs output line.
 *
 * growisofs reports progress in two formats:
 *   - burning a premade ISO (our case, `-Z dev=iso`):
 *       "4521984/3964231680 ( 0.1%) @0.9x, remaining 14:32 RBU 100.0% UBU  96.9%"
 *     The real percent is the PARENTHESIZED one — the same line also contains
 *     "RBU 100.0%" / "UBU 96.9%" (ring/unit buffer fill), which a naive /%/
 *     regex would match and peg the bar at 100% immediately.
 *   - generating a filesystem (mkisofs passthrough): "12.34% done, estimate…"
 *
 * @param {string} line - one trimmed growisofs output line
 * @returns {number|null} percent 0-100, or null when the line carries none
 */
function parseBurnProgress(line) {
  const s = String(line || '');
  const paren = s.match(/\(\s*(\d+(?:\.\d+)?)%\s*\)/);
  const done  = paren ? null : s.match(/(\d+(?:\.\d+)?)%\s+done/i);
  const m = paren || done;
  if (!m) return null;
  const pct = parseFloat(m[1]);
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}

/**
 * Burn an ISO to disc via `growisofs -dvd-compat -Z <deviceNode>=<iso>`, streaming
 * each output line to onLog. Always resolves a result object — never throws.
 *
 * Never auto-ejects and never auto-verifies (growisofs does neither by default and
 * we pass no flags that would).
 *
 * @param {object}   opts
 * @param {string}   opts.isoPath        - path to the ISO to burn (must exist)
 * @param {string}   opts.deviceNode     - burner device node from checkBurner (e.g. /dev/disk9)
 * @param {string}   [opts.growisofsPath]- growisofs binary (default /opt/homebrew/bin/growisofs)
 * @param {function} [opts.onLog]        - called with each trimmed output line
 * @param {function} [opts.onProgress]   - called with a percent number (0-100) each time a
 *                                          growisofs output line carries one (see parseBurnProgress)
 * @param {function} [opts.spawnFn]      - test seam for child_process.spawn
 * @param {function} [opts.unmountFn]    - test seam: unmountFn(deviceNode, cb) → cb(err, output)
 *                                          for the pre-burn `diskutil unmountDisk`. Defaults to
 *                                          the real call.
 * @returns {Promise<{success:boolean, error?:string}>}
 */
function burnDisc({ isoPath, deviceNode, growisofsPath = GROWISOFS, onLog = () => {}, onProgress = () => {}, spawnFn, unmountFn } = {}) {
  return new Promise((resolve) => {
    if (!isoPath || !fs.existsSync(isoPath)) {
      return resolve({ success: false, error: `ISO file not found: ${isoPath || '(none)'}` });
    }
    if (!growisofsPath || !fs.existsSync(growisofsPath)) {
      return resolve({ success: false, error: 'growisofs not found. Install with: brew install dvd+rw-tools' });
    }
    if (!deviceNode) {
      return resolve({ success: false, error: 'No burner device node found. Connect a Blu-ray burner and try again.' });
    }

    const startBurn = () => {
      const _spawn = spawnFn || spawn;
      let proc;
      try {
        // -dvd-compat: finalise/close the disc for maximum player compatibility.
        // -Z <dev>=<iso>: initial session burn of the ISO image to the device.
        // No eject, no verify — by design.
        proc = _spawn(growisofsPath, ['-dvd-compat', '-Z', `${deviceNode}=${isoPath}`]);
      } catch (e) {
        return resolve({ success: false, error: 'growisofs error: ' + e.message });
      }

      let stdout = '', stderr = '';
      const emit = (buf, isErr) => {
        const text = buf.toString();
        if (isErr) stderr += text; else stdout += text;
        // growisofs rewrites its progress line with \r — split on both so each
        // update is seen as its own line.
        text.split(/[\r\n]/).map(l => l.trim()).filter(Boolean).forEach(l => {
          try { onLog(l); } catch {}
          const pct = parseBurnProgress(l);
          if (pct !== null) { try { onProgress(pct); } catch {} }
        });
      };
      if (proc.stdout) proc.stdout.on('data', d => emit(d, false));
      if (proc.stderr) proc.stderr.on('data', d => emit(d, true));
      proc.on('error', err => resolve({ success: false, error: 'growisofs error: ' + err.message }));
      proc.on('close', code => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          const msg = stderr.trim() || stdout.trim() || `growisofs exited with code ${code}`;
          resolve({ success: false, error: friendlyBurnError(msg) });
        }
      });
    };

    // Pre-burn unmount, BEST-EFFORT. macOS auto-mounts any disc with a readable
    // filesystem (a previously burned BD-RE), and growisofs refuses to write to
    // a mounted volume — its internal unmount fails on macOS (":-( unable to
    // umount: Block device required") and aborts the burn. A blank/erased disc
    // has nothing mounted, so diskutil errors there — that must NEVER block the
    // burn: failures are logged and the burn proceeds regardless.
    const doUnmount = unmountFn || ((dev, cb) => {
      let called = false;
      const finish = (err, output) => { if (!called) { called = true; cb(err, output); } };
      try {
        const proc = execFile(
          DISKUTIL, ['unmountDisk', dev],
          { timeout: 15000, maxBuffer: 1 << 20 },
          (err, stdout, stderr) => finish(err, String(stderr || stdout || '')),
        );
        proc.on('error', (e) => finish(e, ''));
      } catch (e) { finish(e, ''); }
    });

    doUnmount(deviceNode, (err, output) => {
      const note = String(output || (err && err.message) || '').trim().split('\n')[0];
      try {
        if (err) onLog(`unmount ${deviceNode} failed (${note || 'nothing mounted'}) — continuing with burn`);
        else if (note) onLog(note);
      } catch {}
      startBurn();
    });
  });
}

// Known growisofs failure patterns → user-readable messages. The raw output
// stays appended for diagnostics (the burn modal renders it in a <pre>).
const BURN_ERROR_PATTERNS = [
  [/unable to open.*busy/i, 'The disc drive is busy. Eject any disc and try again.'],
  [/does not look like.*blank|media is not blank/i, 'The disc is not blank. Use a blank BD-R or an erased BD-RE.'],
  [/calibration area (almost )?full/i, 'The disc has too many write sessions. Use a fresh disc.'],
  [/no space left/i, 'The disc is full. Use a larger disc or reduce content.'],
  [/unable to umount/i, 'Could not unmount the disc. Try ejecting and reinserting it.'],
];

/**
 * Map a raw growisofs failure to a friendly message, keeping the raw text
 * appended for diagnostics. Unrecognized errors pass through unchanged.
 * @param {string} raw - growisofs stderr/stdout tail
 * @returns {string}
 */
function friendlyBurnError(raw) {
  const s = String(raw || '');
  for (const [re, msg] of BURN_ERROR_PATTERNS) {
    if (re.test(s)) return `${msg}\n\nDetails: ${s}`;
  }
  return s;
}

/**
 * Eject the optical disc via `drutil eject`. Never throws — always resolves
 * { success, error? }. Used by the burn-success modal's Eject button (the burn
 * itself never auto-ejects, by design — this is the user choosing to).
 *
 * @param {object}   [opts]
 * @param {function} [opts.execFileFn] - test seam: (bin, args, cb) → cb(err, stdout, stderr)
 * @returns {Promise<{success:boolean, error?:string}>}
 */
function ejectDisc({ execFileFn } = {}) {
  return new Promise((resolve) => {
    const run = execFileFn || ((bin, args, cb) => {
      try {
        const proc = execFile(bin, args, { timeout: 30000 }, (err, stdout, stderr) => cb(err, stdout, stderr));
        proc.on('error', (e) => cb(e, '', ''));
      } catch (e) { cb(e, '', ''); }
    });
    let done = false;
    run(DRUTIL, ['eject'], (err, _stdout, stderr) => {
      if (done) return; done = true;
      if (err) {
        const detail = String(stderr || err.message || '').trim();
        resolve({ success: false, error: `Could not eject the disc: ${detail || 'unknown error'}` });
      } else {
        resolve({ success: true });
      }
    });
  });
}

module.exports = { checkBurner, burnDisc, ejectDisc, parseBurnProgress, friendlyBurnError, SYSTEM_PROFILER, DRUTIL, DISKUTIL, GROWISOFS };
