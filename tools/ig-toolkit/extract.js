#!/usr/bin/env node
'use strict';
/**
 * extract.js — full IG extraction from a BD ISO or .m2ts file.
 *
 * Usage:
 *   node extract.js <input.m2ts|input.iso> [outDir] [--pid 0x1400] [--stream 01200]
 *
 *   <input>     a .m2ts file, OR a .iso (mounted read-only via hdiutil), OR a
 *               mounted BDMV path / directory containing BDMV/STREAM.
 *   [outDir]    pack directory to create (default: ./<basename>.pack).
 *   --pid       force IG PID (hex or dec). Default: auto-detect (first PID with ICS).
 *   --stream    when input is an ISO/BDMV, pick STREAM/<n>.m2ts (default: the
 *               smallest .m2ts, which is almost always the menu clip).
 *
 * Produces in <outDir>:
 *   source.m2ts    exact copy of the chosen m2ts (repack reads original bytes from here)
 *   manifest.json  pktSize, igPid, and per-PES-unit decode (segments + PES timing + provenance)
 *   ig.txt         human-readable segment dump
 *
 * The manifest is the input to mutate.js and repack.js.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const lib = require('./lib');

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pid') a.pid = argv[++i];
    else if (argv[i] === '--stream') a.stream = argv[++i];
    else a._.push(argv[i]);
  }
  return a;
}

/** Resolve <input> to an actual .m2ts path; mount ISO if needed. Returns {m2ts, cleanup}. */
function resolveM2ts(input, streamSel) {
  const st = fs.statSync(input);
  let bdmvRoot = null;
  let cleanup = () => {};

  if (st.isFile() && input.toLowerCase().endsWith('.m2ts')) {
    return { m2ts: input, cleanup };
  }
  if (st.isFile() && input.toLowerCase().endsWith('.iso')) {
    const r = spawnSync('hdiutil', ['attach', input, '-readonly', '-nobrowse'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`hdiutil attach failed: ${r.stderr}`);
    const mountLine = r.stdout.trim().split('\n').pop().trim();
    const mountPoint = mountLine.split('\t').pop().trim();
    bdmvRoot = mountPoint;
    cleanup = () => { spawnSync('hdiutil', ['detach', mountPoint], { encoding: 'utf8' }); };
  } else if (st.isDirectory()) {
    bdmvRoot = input;
  } else {
    throw new Error(`Unsupported input: ${input}`);
  }

  // locate STREAM dir
  let streamDir = path.join(bdmvRoot, 'BDMV', 'STREAM');
  if (!fs.existsSync(streamDir)) streamDir = path.join(bdmvRoot, 'STREAM');
  if (!fs.existsSync(streamDir)) { cleanup(); throw new Error(`No BDMV/STREAM under ${bdmvRoot}`); }

  const m2tsFiles = fs.readdirSync(streamDir).filter(f => f.toLowerCase().endsWith('.m2ts'));
  if (m2tsFiles.length === 0) { cleanup(); throw new Error(`No .m2ts in ${streamDir}`); }

  let chosen;
  if (streamSel) {
    chosen = m2tsFiles.find(f => f.startsWith(String(streamSel))) || `${streamSel}.m2ts`;
  } else {
    // smallest file = menu clip in practice
    chosen = m2tsFiles
      .map(f => ({ f, size: fs.statSync(path.join(streamDir, f)).size }))
      .sort((a, b) => a.size - b.size)[0].f;
  }
  return { m2ts: path.join(streamDir, chosen), cleanup };
}

function renderText(r, srcName) {
  const L = [];
  L.push(`IG extract — ${srcName}`);
  L.push(`packet size: ${r.pktSize}   IG PID: 0x${r.igPid.toString(16)}`);
  L.push(`PES units: ${r.units.length}   display sets: ${r.displaySets.length}`);
  L.push(`segment round-trip exact: ${r.segmentRoundTripOK}` + (r.segmentRoundTripOK ? '' : ` (${r.mismatches.length} mismatches!)`));
  L.push('');
  r.displaySets.forEach((ds, di) => {
    L.push(`── Display Set ${di} (PES units ${ds.units.join(',')}) ──`);
    ds.units.forEach(ui => {
      const u = r.units.find(x => x.pesIndex === ui);
      L.push(`  PES#${u.pesIndex}  pkt@${u.pktIdxStart}×${u.pktCount}  cc=${u.ccStart}  PTS=${u.pes.pts}  DTS=${u.pes.dts}`);
      u.segments.forEach(s => L.push('    ' + describeSeg(s)));
    });
    L.push('');
  });
  return L.join('\n');
}

function describeSeg(s) {
  const d = s.decoded;
  switch (s.type) {
    case lib.SEG.ICS: {
      const pg = d.pages[0] || {};
      const nbtn = (pg.bogs || []).reduce((n, b) => n + b.buttons.length, 0);
      return `ICS  video=${d.videoWidth}x${d.videoHeight} fr=0x${d.frameRate.toString(16)} comp#${d.compNumber} state=${d.compState} stream_model=${d.streamModel} ui=${d.uiModel} pages=${d.pages.length} bogs=${(pg.bogs||[]).length} buttons=${nbtn} defSel=${pg.defaultSelectedButtonIdRef} defAct=${pg.defaultActivatedButtonIdRef} palRef=${pg.paletteIdRef} ctoPTS=${d.compTimeoutPts} stoPTS=${d.selTimeoutPts}`;
    }
    case lib.SEG.PDS: return `PDS  id=${d.paletteId} v=${d.version} entries=${d.entries.length}`;
    case lib.SEG.WDS: return `WDS  windows=${d.windows.map(w => `#${w.id}(${w.x},${w.y},${w.width}x${w.height})`).join(' ')}`;
    case lib.SEG.ODS: return d.first
      ? `ODS  obj=${d.objectId} v=${d.version} ${d.width}x${d.height} dataLen=${d.dataLen} rle=${d.rleHex.length/2}B first=${d.first} last=${d.last}`
      : `ODS  obj=${d.objectId} (cont) rle=${d.rleHex.length/2}B last=${d.last}`;
    case lib.SEG.END: return 'END';
    default: return `${s.name} (${s.length}B)`;
  }
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a._.length < 1) { console.error('Usage: node extract.js <input.m2ts|input.iso|bdmvDir> [outDir] [--pid 0x1400] [--stream 01200]'); process.exit(1); }
  const input = a._[0];
  const pid = a.pid !== undefined ? (a.pid.startsWith('0x') ? parseInt(a.pid, 16) : parseInt(a.pid, 10)) : undefined;

  const { m2ts, cleanup } = resolveM2ts(input, a.stream);
  let buf;
  try {
    buf = fs.readFileSync(m2ts);
  } finally { /* keep mount until copied below */ }

  const r = lib.extractIg(buf, pid);
  const outDir = a._[1] || path.join(process.cwd(), path.basename(input).replace(/\.[^.]+$/, '') + '.pack');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'source.m2ts'), buf);
  cleanup();

  const manifest = {
    source: path.basename(m2ts),
    pktSize: r.pktSize,
    igPid: r.igPid,
    segmentRoundTripOK: r.segmentRoundTripOK,
    mismatches: r.mismatches,
    displaySets: r.displaySets,
    units: r.units,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const text = renderText(r, path.basename(m2ts));
  fs.writeFileSync(path.join(outDir, 'ig.txt'), text);

  console.log(text);
  console.log(`\nWrote pack: ${outDir}`);
  console.log(`  source.m2ts (${buf.length} bytes), manifest.json, ig.txt`);
  if (!r.segmentRoundTripOK) { console.error(`\nWARNING: ${r.mismatches.length} segment(s) did not round-trip exactly.`); process.exit(2); }
}

if (require.main === module) main();
module.exports = { resolveM2ts };
