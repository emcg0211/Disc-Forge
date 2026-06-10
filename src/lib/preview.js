'use strict';
/**
 * preview.js — open a built ISO in VLC for pre-burn preview.
 *
 * VLC (with libbluray) is an imperfect but fast proxy for disc playback: it
 * verifies the BDMV structure, menu rendering, and navigation in seconds
 * instead of a ~30-minute burn. See docs/menu_research_progress.md for where
 * VLC and real hardware (LG BP350) are known to diverge.
 *
 * Electron-free (like burn.js) so the logic is unit-testable: the macOS
 * `open -a VLC <iso>` call is injected via execFileFn.
 */

const fs = require('fs');
const { execFile } = require('child_process');

const OPEN_BIN = '/usr/bin/open';

/**
 * Open an ISO in VLC via `open -a VLC <isoPath>`. Never throws — always
 * resolves { success, error? }. `open` exits 1 with "Unable to find
 * application" when VLC is not installed.
 *
 * @param {object}   opts
 * @param {string}   opts.isoPath      - path to the built ISO (must exist)
 * @param {function} [opts.execFileFn] - test seam: (bin, args, cb) → cb(err, stdout, stderr)
 * @returns {Promise<{success:boolean, error?:string}>}
 */
function openInVlc({ isoPath, execFileFn } = {}) {
  return new Promise((resolve) => {
    if (!isoPath || !fs.existsSync(isoPath)) {
      return resolve({ success: false, error: `ISO file not found: ${isoPath || '(none)'}` });
    }
    const run = execFileFn || ((bin, args, cb) => {
      try {
        const proc = execFile(bin, args, { timeout: 15000 }, (err, stdout, stderr) => cb(err, stdout, stderr));
        proc.on('error', (e) => cb(e, '', ''));
      } catch (e) { cb(e, '', ''); }
    });
    let done = false;
    run(OPEN_BIN, ['-a', 'VLC', isoPath], (err, _stdout, stderr) => {
      if (done) return; done = true;
      if (err) {
        const detail = String(stderr || err.message || '').trim();
        const notFound = /unable to find application/i.test(detail) || /unable to find application/i.test(String(err.message || ''));
        resolve({
          success: false,
          error: notFound
            ? 'VLC is not installed. Download it free from videolan.org to preview discs before burning.'
            : `Could not open VLC: ${detail || 'unknown error'}`,
        });
      } else {
        resolve({ success: true });
      }
    });
  });
}

module.exports = { openInVlc, OPEN_BIN };
