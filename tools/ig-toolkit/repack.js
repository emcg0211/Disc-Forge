#!/usr/bin/env node
'use strict';
/**
 * repack.js — reassemble an m2ts (and optionally an ISO) from a pack directory.
 *
 * Usage:
 *   node repack.js <packDir> <out.m2ts> [--reencode-all]
 *   node repack.js --iso <bdmvDir> <out.iso>      (BDMV tree → burnable ISO, xorriso native)
 *
 * Repack model (lossless):
 *   - CLEAN PES units  → re-emit the exact original 192-byte packets sliced from
 *                        source.m2ts by their recorded packet indices.
 *   - DIRTY PES units  → re-encode segment bodies → PES → 188-byte TS → 192-byte
 *                        m2ts, preserving the unit's PTS/DTS, ccStart and ATS base.
 *   - non-IG packets   → copied verbatim, in original order.
 *
 * With no dirty units this is byte-identical to source.m2ts (round-trip identity).
 * --reencode-all forces re-encode of every unit (diagnostic: measures how close
 * our PES/TS packetization is to the reference's).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');

let manifestPid = 0x1400;

/**
 * Re-encode one dirty PES unit.
 *   - Rebuild the PES = original PES header (byte-exact framing, incl. the
 *     reference's DTS marker nibble) + freshly-encoded segment payload, with the
 *     PES_packet_length field patched.
 *   - If the new PES length equals the original packet payload capacity, refill
 *     the original packets in place → ATS / CC / adaptation-field layout are all
 *     preserved (highest fidelity; covers position/palette/nav/state mutations).
 *   - Otherwise re-packetize from scratch (length changed: ODS resize, button
 *     count change), preserving CC and ATS base.
 */
function reencodeUnit(unit, src, pktSize) {
  const segBufs = unit.segments.map(s => lib.buildSegment(s.type, lib.encodeSegmentBody(s.type, s.decoded)));
  const payload = Buffer.concat(segBufs);
  const hdr = unit.pesHeaderHex ? Buffer.from(lib.unhex(unit.pesHeaderHex)) : lib.buildPes(Buffer.alloc(0), unit.pes.pts || 0, unit.pes.dts).subarray(0, 9 + (unit.pes.hdrDataLen || 5));
  const pesLen = 3 + hdr[8] + payload.length;
  hdr.writeUInt16BE(Math.min(pesLen, 0xFFFF), 4);
  const pes = Buffer.concat([hdr, payload]);

  // payload capacity of the original packets for this unit
  let cap = 0;
  const regions = unit.pktIdx.map(pi => {
    const ts = src.subarray(pi * pktSize + (pktSize - lib.TS_PKT), (pi + 1) * pktSize);
    const ps = lib.tsPayloadStart(ts);
    cap += lib.TS_PKT - ps;
    return { pi, ps };
  });

  if (pes.length === cap) {
    // in-place refill — preserves ATS, CC, AF stuffing byte-for-byte
    let off = 0;
    const out = [];
    for (const { pi, ps } of regions) {
      const m = Buffer.from(src.subarray(pi * pktSize, (pi + 1) * pktSize));
      const tsOff = (pktSize - lib.TS_PKT);
      const room = lib.TS_PKT - ps;
      pes.copy(m, tsOff + ps, off, off + room);
      off += room;
      out.push(m);
    }
    return Buffer.concat(out);
  }
  // length changed → re-packetize
  return lib.packetizePesToM2ts(pes, manifestPid, unit.ccStart, unit.ats);
}

function repack(packDir, reencodeAll) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packDir, 'manifest.json'), 'utf8'));
  manifestPid = manifest.igPid;
  const src = fs.readFileSync(path.join(packDir, 'source.m2ts'));
  const { pktSize } = lib.readPackets(src);
  const slicePkt = (idx) => src.subarray(idx * pktSize, (idx + 1) * pktSize);

  // map packet index → {unit, isAnchor}
  const pktToUnit = new Map();
  for (const u of manifest.units) {
    u.pktIdx.forEach((pi, k) => pktToUnit.set(pi, { unit: u, isAnchor: k === 0 }));
  }

  const nPkts = Math.floor(src.length / pktSize);
  const out = [];
  for (let i = 0; i < nPkts; i++) {
    const ref = pktToUnit.get(i);
    if (!ref) { out.push(slicePkt(i)); continue; }       // non-IG packet
    if (!ref.isAnchor) continue;                          // emitted at anchor
    const u = ref.unit;
    if (u.dirty || reencodeAll) {
      out.push(reencodeUnit(u, src, pktSize));
    } else {
      // re-emit exact original packets for this unit, in order
      u.pktIdx.forEach(pi => out.push(slicePkt(pi)));
    }
  }
  return Buffer.concat(out);
}

function buildIso(bdmvDir, outIso) {
  // xorriso native mode, UDF, matching how v17/v19 packaging produced burnable BD ISOs.
  const args = [
    '-as', 'mkisofs',
    '-udf',
    '-V', 'BDROM',
    '-o', outIso,
    bdmvDir,
  ];
  const r = spawnSync('xorriso', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`xorriso failed:\n${r.stderr.slice(-600)}`);
  return r.stderr; // xorriso logs to stderr
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--iso') {
    const [, bdmvDir, outIso] = argv;
    if (!bdmvDir || !outIso) { console.error('Usage: node repack.js --iso <bdmvDir> <out.iso>'); process.exit(1); }
    buildIso(bdmvDir, outIso);
    console.log(`Wrote ISO: ${outIso} (${fs.statSync(outIso).size} bytes)`);
    return;
  }
  const reencodeAll = argv.includes('--reencode-all');
  const pos = argv.filter(x => !x.startsWith('--'));
  const [packDir, outM2ts] = pos;
  if (!packDir || !outM2ts) { console.error('Usage: node repack.js <packDir> <out.m2ts> [--reencode-all]'); process.exit(1); }
  const buf = repack(packDir, reencodeAll);
  fs.writeFileSync(outM2ts, buf);
  console.log(`Wrote ${outM2ts} (${buf.length} bytes)`);
}

if (require.main === module) main();
module.exports = { repack, buildIso };
