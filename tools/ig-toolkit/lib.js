'use strict';
/**
 * lib.js — shared IG forensic/mutation library for the Disc Forge menu toolkit.
 *
 * Layers, bottom to top:
 *   M2TS    — 192-byte packets = 4-byte arrival-timestamp (ATS) + 188-byte TS packet
 *   TS      — 188-byte transport packets (sync 0x47, PID, PUSI, CC, adaptation field)
 *   PES     — packetized elementary stream (00 00 01 stream_id + len + flags + PTS/DTS)
 *   Segment — IG display-set segments: ICS(0x18) PDS(0x14) WDS(0x17) ODS(0x15) END(0x80)
 *
 * Design goal: LOSSLESS round-trip. extract() records, per IG PES unit, the exact
 * original 188-byte TS packets AND a fully-decoded structure. repack() emits the
 * original bytes for clean units (→ byte-identical) and re-encodes only mutated
 * (dirty) units. Every segment parser has an exact inverse encoder; extract.js
 * verifies parse→encode reproduces the original payload byte-for-byte.
 *
 * Sources cross-checked: libbluray decoders/ig_decode.c, pg_decode.c, rle.c,
 * graphics_processor.c; BD-ROM Part 3 §5.7 (IG) / §9 (HDMV); and the existing
 * Disc Forge ig-encoder.js / parse_ig_segments.py.
 */

const fs = require('fs');

// ── Constants ───────────────────────────────────────────────────────────────
const M2TS_PKT = 192;
const TS_PKT   = 188;
const ATS_LEN  = 4;
const SYNC     = 0x47;

const SEG = { PDS: 0x14, ODS: 0x15, PG: 0x16, WDS: 0x17, ICS: 0x18, END: 0x80 };
const SEG_NAME = { 0x14: 'PDS', 0x15: 'ODS', 0x16: 'PG', 0x17: 'WDS', 0x18: 'ICS', 0x80: 'END' };

const PES_STREAM_ID = 0xBD; // private_stream_1 (graphics)

// ── small helpers ─────────────────────────────────────────────────────────────
const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
function wu24(b, o, v) { b[o] = (v >> 16) & 0xFF; b[o + 1] = (v >> 8) & 0xFF; b[o + 2] = v & 0xFF; }
const hex = (buf) => Buffer.from(buf).toString('hex');
const unhex = (s) => Buffer.from(s, 'hex');

// ════════════════════════════════════════════════════════════════════════════
//  M2TS / TS layer
// ════════════════════════════════════════════════════════════════════════════

/** Detect 188 (raw TS) vs 192 (BDAV m2ts). */
function detectPacketSize(buf) {
  if (buf.length >= M2TS_PKT && buf[ATS_LEN] === SYNC && buf[ATS_LEN + M2TS_PKT] === SYNC) return M2TS_PKT;
  if (buf[0] === SYNC && buf[TS_PKT] === SYNC) return TS_PKT;
  // fall back on divisibility
  if (buf.length % M2TS_PKT === 0) return M2TS_PKT;
  return TS_PKT;
}

/**
 * Split a buffer into packet records.
 * @returns {{pktSize:number, packets: Array<{idx,ats,ts:Buffer}>}}
 *   ats is the 30-bit arrival timestamp (m2ts only; -1 for raw TS).
 *   ts is the 188-byte TS packet (a view into buf).
 */
function readPackets(buf) {
  const pktSize = detectPacketSize(buf);
  const packets = [];
  const n = Math.floor(buf.length / pktSize);
  for (let i = 0; i < n; i++) {
    const base = i * pktSize;
    if (pktSize === M2TS_PKT) {
      const ats = buf.readUInt32BE(base) & 0x3FFFFFFF;
      packets.push({ idx: i, ats, ts: buf.subarray(base + ATS_LEN, base + M2TS_PKT) });
    } else {
      packets.push({ idx: i, ats: -1, ts: buf.subarray(base, base + TS_PKT) });
    }
  }
  return { pktSize, packets };
}

/** TS packet field accessors. */
function tsPid(ts)  { return ((ts[1] & 0x1F) << 8) | ts[2]; }
function tsPusi(ts) { return (ts[1] >> 6) & 1; }
function tsCC(ts)   { return ts[3] & 0x0F; }
function tsAfc(ts)  { return (ts[3] >> 4) & 0x03; }
/** Offset where the TS payload begins (after any adaptation field). */
function tsPayloadStart(ts) {
  const afc = tsAfc(ts);
  if (afc === 0x00 || afc === 0x02) return TS_PKT; // no payload
  if (afc === 0x03) return 4 + 1 + ts[4];          // adaptation field present
  return 4;                                         // payload only
}

// ════════════════════════════════════════════════════════════════════════════
//  Demux with provenance
// ════════════════════════════════════════════════════════════════════════════

/**
 * Demux one PID into PES units, each carrying full provenance for lossless repack.
 * A PES unit = the TS packets from one PUSI up to (but excluding) the next PUSI
 * on this PID.
 *
 * @returns Array<{
 *   pesIndex, pktIdx:number[], ats:number[], ccStart:number,
 *   rawTs: Buffer[],            // exact original 188-byte packets
 *   pesBytes: Buffer            // reassembled PES (header + payload)
 * }>
 */
function demuxPid(packets, pid) {
  const units = [];
  let cur = null;
  for (const p of packets) {
    if (tsPid(p.ts) !== pid) continue;
    if (tsAfc(p.ts) === 0x00 || tsAfc(p.ts) === 0x02) {
      // no payload — still belongs to the current unit's packet span
      if (cur) { cur.pktIdx.push(p.idx); cur.ats.push(p.ats); cur.rawTs.push(Buffer.from(p.ts)); }
      continue;
    }
    const payload = p.ts.subarray(tsPayloadStart(p.ts));
    if (tsPusi(p.ts)) {
      if (cur) units.push(finalizeUnit(cur, units.length));
      cur = { pktIdx: [p.idx], ats: [p.ats], ccStart: tsCC(p.ts), rawTs: [Buffer.from(p.ts)], chunks: [Buffer.from(payload)] };
    } else if (cur) {
      cur.pktIdx.push(p.idx); cur.ats.push(p.ats); cur.rawTs.push(Buffer.from(p.ts));
      cur.chunks.push(Buffer.from(payload));
    }
  }
  if (cur) units.push(finalizeUnit(cur, units.length));
  return units;
}

function finalizeUnit(cur, pesIndex) {
  return {
    pesIndex,
    pktIdx: cur.pktIdx,
    ats: cur.ats,
    ccStart: cur.ccStart,
    rawTs: cur.rawTs,
    pesBytes: Buffer.concat(cur.chunks),
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  PES layer
// ════════════════════════════════════════════════════════════════════════════

function parseTimestamp(b, o) {
  // 5-byte PTS/DTS field → 33-bit value
  return (
    ((b[o] >> 1) & 0x07) * 0x40000000 +
    ((b[o + 1]) << 22) +
    (((b[o + 2] >> 1) & 0x7F) << 15) +
    ((b[o + 3]) << 7) +
    ((b[o + 4] >> 1) & 0x7F)
  );
}

/** Parse a PES packet header; return header fields + the segment payload slice. */
function parsePes(pes) {
  if (pes.length < 9 || pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) return null;
  const streamId = pes[3];
  const pesLen = pes.readUInt16BE(4);
  const flags1 = pes[6];
  const flags2 = pes[7];
  const hdrDataLen = pes[8];
  const ptsDtsFlags = (flags2 >> 6) & 0x03;
  let pts = null, dts = null;
  let o = 9;
  if (ptsDtsFlags === 0x02) { pts = parseTimestamp(pes, o); }
  else if (ptsDtsFlags === 0x03) { pts = parseTimestamp(pes, o); dts = parseTimestamp(pes, o + 5); }
  const payload = pes.subarray(9 + hdrDataLen);
  return { streamId, pesLen, flags1, flags2, hdrDataLen, ptsDtsFlags, pts, dts, payload, markerNibble: pes[9] !== undefined ? (pes[9] >> 4) : null };
}

function encodeTimestamp(v, markerHigh) {
  const b = Buffer.alloc(5);
  b[0] = (markerHigh << 4) | (((Math.floor(v / 0x40000000)) & 0x07) << 1) | 1;
  b[1] = (v >> 22) & 0xFF;
  b[2] = (((v >> 15) & 0x7F) << 1) | 1;
  b[3] = (v >> 7) & 0xFF;
  b[4] = ((v & 0x7F) << 1) | 1;
  return b;
}

/**
 * Build a PES packet for a graphics segment.
 * Mirrors ig-encoder.js wrapInPES header conventions (flags1=0x84,
 * flags2=0xC0 w/ DTS else 0x80; PTS marker nibble 0x3 w/ DTS else 0x2; DTS nibble 0x1).
 */
function buildPes(segmentData, pts, dts) {
  const hasDts = dts !== null && dts !== undefined;
  const ptsBuf = encodeTimestamp(pts || 0, hasDts ? 0x3 : 0x2);
  const dtsBuf = hasDts ? encodeTimestamp(dts, 0x1) : Buffer.alloc(0);
  const hdrDataLen = ptsBuf.length + dtsBuf.length;
  const pesLen = 3 + hdrDataLen + segmentData.length;
  const hdr = Buffer.alloc(9);
  hdr[0] = 0x00; hdr[1] = 0x00; hdr[2] = 0x01; hdr[3] = PES_STREAM_ID;
  hdr.writeUInt16BE(Math.min(pesLen, 0xFFFF), 4);
  hdr[6] = 0x84;
  hdr[7] = hasDts ? 0xC0 : 0x80;
  hdr[8] = hdrDataLen;
  return Buffer.concat([hdr, ptsBuf, dtsBuf, segmentData]);
}

/**
 * Packetize a PES into 188-byte TS packets for a PID, then wrap to 192-byte m2ts.
 * Stuffing goes in the LAST packet's adaptation field (matches wrapInPES).
 * @returns Buffer of 192-byte m2ts packets.
 */
function packetizePesToM2ts(pes, pid, ccStart, atsBase, atsStep = 300) {
  const out = [];
  let offset = 0;
  let cc = ccStart & 0x0F;
  let ats = atsBase >>> 0;
  while (offset < pes.length) {
    const pkt = Buffer.alloc(TS_PKT, 0xFF);
    pkt[0] = SYNC;
    const pusi = offset === 0 ? 0x40 : 0x00;
    pkt[1] = pusi | ((pid >> 8) & 0x1F);
    pkt[2] = pid & 0xFF;
    const remaining = pes.length - offset;
    const stuffing = 184 - Math.min(remaining, 184);
    if (stuffing === 0) {
      pkt[3] = 0x10 | cc;
      pes.copy(pkt, 4, offset, offset + 184);
      offset += 184;
    } else {
      pkt[3] = 0x30 | cc;
      pkt[4] = stuffing - 1;
      if (stuffing >= 2) pkt[5] = 0x00;
      pkt.fill(0xFF, 6, 4 + stuffing);
      pes.copy(pkt, 4 + stuffing, offset, offset + remaining);
      offset = pes.length;
    }
    const m = Buffer.alloc(M2TS_PKT);
    m.writeUInt32BE((ats & 0x3FFFFFFF) >>> 0, 0);
    pkt.copy(m, ATS_LEN);
    out.push(m);
    cc = (cc + 1) & 0x0F;
    ats = (ats + atsStep) >>> 0;
  }
  return Buffer.concat(out);
}

// ════════════════════════════════════════════════════════════════════════════
//  Segment layer — parse / encode (exact inverses)
// ════════════════════════════════════════════════════════════════════════════

/** Split a PES payload into individual segments (one PES usually carries one). */
function splitSegments(payload) {
  const segs = [];
  let o = 0;
  while (o + 3 <= payload.length) {
    const type = payload[o];
    const len = payload.readUInt16BE(o + 1);
    const body = payload.subarray(o + 3, o + 3 + len);
    segs.push({ type, name: SEG_NAME[type] || `0x${type.toString(16)}`, length: len, body: Buffer.from(body) });
    o += 3 + len;
  }
  return segs;
}

function buildSegment(type, body) {
  const hdr = Buffer.alloc(3);
  hdr[0] = type;
  hdr.writeUInt16BE(body.length, 1);
  return Buffer.concat([hdr, body]);
}

// ── PDS ────────────────────────────────────────────────────────────────────
function parsePDS(body) {
  const entries = [];
  for (let o = 2; o + 5 <= body.length; o += 5) {
    entries.push({ id: body[o], Y: body[o + 1], Cr: body[o + 2], Cb: body[o + 3], T: body[o + 4] });
  }
  return { paletteId: body[0], version: body[1], entries };
}
function encodePDS(d) {
  const b = Buffer.alloc(2 + d.entries.length * 5);
  b[0] = d.paletteId; b[1] = d.version;
  d.entries.forEach((e, i) => {
    const o = 2 + i * 5;
    b[o] = e.id; b[o + 1] = e.Y; b[o + 2] = e.Cr; b[o + 3] = e.Cb; b[o + 4] = e.T;
  });
  return b;
}

// ── WDS ────────────────────────────────────────────────────────────────────
function parseWDS(body) {
  const num = body[0];
  const windows = [];
  for (let i = 0; i < num; i++) {
    const o = 1 + i * 9;
    windows.push({ id: body[o], x: body.readUInt16BE(o + 1), y: body.readUInt16BE(o + 3), width: body.readUInt16BE(o + 5), height: body.readUInt16BE(o + 7) });
  }
  return { windows };
}
function encodeWDS(d) {
  const b = Buffer.alloc(1 + d.windows.length * 9);
  b[0] = d.windows.length;
  d.windows.forEach((w, i) => {
    const o = 1 + i * 9;
    b[o] = w.id; b.writeUInt16BE(w.x, o + 1); b.writeUInt16BE(w.y, o + 3); b.writeUInt16BE(w.width, o + 5); b.writeUInt16BE(w.height, o + 7);
  });
  return b;
}

// ── ODS ──────────────────────────────────────────────────────────────────────
function parseODS(body) {
  const objectId = body.readUInt16BE(0);
  const version = body[2];
  const seq = body[3];
  const first = (seq >> 7) & 1;
  const last = (seq >> 6) & 1;
  if (first) {
    const dataLen = u24(body, 4);
    const width = body.readUInt16BE(7);
    const height = body.readUInt16BE(9);
    const rle = body.subarray(11);
    return { objectId, version, seq, first, last, dataLen, width, height, rleHex: hex(rle) };
  }
  return { objectId, version, seq, first, last, rleHex: hex(body.subarray(4)) };
}
function encodeODS(d) {
  if (d.first) {
    const rle = unhex(d.rleHex);
    const b = Buffer.alloc(11 + rle.length);
    b.writeUInt16BE(d.objectId, 0); b[2] = d.version; b[3] = d.seq;
    wu24(b, 4, d.dataLen);
    b.writeUInt16BE(d.width, 7); b.writeUInt16BE(d.height, 9);
    rle.copy(b, 11);
    return b;
  }
  const rle = unhex(d.rleHex);
  const b = Buffer.alloc(4 + rle.length);
  b.writeUInt16BE(d.objectId, 0); b[2] = d.version; b[3] = d.seq;
  rle.copy(b, 4);
  return b;
}

// ── ICS ──────────────────────────────────────────────────────────────────────
function parseEffectSequence(body, o) {
  const start = o;
  const numWindows = body[o++];
  o += numWindows * 9;
  const numEffects = body[o++];
  for (let i = 0; i < numEffects; i++) {
    o += 3 + 1; // duration + palette_id_ref
    const numCo = body[o++];
    for (let j = 0; j < numCo; j++) {
      const flags = body[o + 3];
      o += 8;
      if (flags & 0x80) o += 8; // crop
    }
  }
  return { rawHex: hex(body.subarray(start, o)), numWindows, numEffects, next: o };
}

function parseButton(body, o) {
  const r = {};
  r.id = body.readUInt16BE(o); o += 2;
  r.numericSelectValue = body.readUInt16BE(o); o += 2;
  r.autoAction = body[o++];
  r.x = body.readUInt16BE(o); o += 2;
  r.y = body.readUInt16BE(o); o += 2;
  r.upper = body.readUInt16BE(o); o += 2;
  r.lower = body.readUInt16BE(o); o += 2;
  r.left = body.readUInt16BE(o); o += 2;
  r.right = body.readUInt16BE(o); o += 2;
  r.normalStart = body.readUInt16BE(o); o += 2;
  r.normalEnd = body.readUInt16BE(o); o += 2;
  r.normalRepeat = body[o++];
  r.selSound = body[o++];
  r.selStart = body.readUInt16BE(o); o += 2;
  r.selEnd = body.readUInt16BE(o); o += 2;
  r.selRepeat = body[o++];
  r.actSound = body[o++];
  r.actStart = body.readUInt16BE(o); o += 2;
  r.actEnd = body.readUInt16BE(o); o += 2;
  const numNav = body.readUInt16BE(o); o += 2;
  r.navCmds = [];
  for (let i = 0; i < numNav; i++) { r.navCmds.push(hex(body.subarray(o, o + 12))); o += 12; }
  return { btn: r, next: o };
}
function encodeButton(r) {
  const navCmds = r.navCmds || [];
  const b = Buffer.alloc(35 + navCmds.length * 12);
  let o = 0;
  b.writeUInt16BE(r.id, o); o += 2;
  b.writeUInt16BE(r.numericSelectValue, o); o += 2;
  b[o++] = r.autoAction;
  b.writeUInt16BE(r.x, o); o += 2;
  b.writeUInt16BE(r.y, o); o += 2;
  b.writeUInt16BE(r.upper, o); o += 2;
  b.writeUInt16BE(r.lower, o); o += 2;
  b.writeUInt16BE(r.left, o); o += 2;
  b.writeUInt16BE(r.right, o); o += 2;
  b.writeUInt16BE(r.normalStart, o); o += 2;
  b.writeUInt16BE(r.normalEnd, o); o += 2;
  b[o++] = r.normalRepeat;
  b[o++] = r.selSound;
  b.writeUInt16BE(r.selStart, o); o += 2;
  b.writeUInt16BE(r.selEnd, o); o += 2;
  b[o++] = r.selRepeat;
  b[o++] = r.actSound;
  b.writeUInt16BE(r.actStart, o); o += 2;
  b.writeUInt16BE(r.actEnd, o); o += 2;
  b.writeUInt16BE(navCmds.length, o); o += 2;
  navCmds.forEach(c => { unhex(c).copy(b, o); o += 12; });
  return b;
}

function parseBog(body, o) {
  const defValid = body.readUInt16BE(o); o += 2;
  const numButtons = body[o++];
  const buttons = [];
  for (let i = 0; i < numButtons; i++) { const { btn, next } = parseButton(body, o); buttons.push(btn); o = next; }
  return { bog: { defaultValidButtonIdRef: defValid, buttons }, next: o };
}
function encodeBog(d) {
  const buttons = d.buttons.map(encodeButton);
  const hdr = Buffer.alloc(3);
  hdr.writeUInt16BE(d.defaultValidButtonIdRef, 0);
  hdr[2] = d.buttons.length;
  return Buffer.concat([hdr, ...buttons]);
}

function parsePage(body, o) {
  const id = body[o++];
  const version = body[o++];
  const uoMask = hex(body.subarray(o, o + 8)); o += 8;
  const inFx = parseEffectSequence(body, o); o = inFx.next;
  const outFx = parseEffectSequence(body, o); o = outFx.next;
  const animFps = body[o++];
  const defSel = body.readUInt16BE(o); o += 2;
  const defAct = body.readUInt16BE(o); o += 2;
  const palId = body[o++];
  const numBogs = body[o++];
  const bogs = [];
  for (let i = 0; i < numBogs; i++) { const { bog, next } = parseBog(body, o); bogs.push(bog); o = next; }
  return {
    page: { id, version, uoMask, inEffectsHex: inFx.rawHex, outEffectsHex: outFx.rawHex, animFps, defaultSelectedButtonIdRef: defSel, defaultActivatedButtonIdRef: defAct, paletteIdRef: palId, bogs },
    next: o,
  };
}
function encodePage(d) {
  const inFx = unhex(d.inEffectsHex);
  const outFx = unhex(d.outEffectsHex);
  const bogs = d.bogs.map(encodeBog);
  const hdr = Buffer.alloc(2 + 8 + inFx.length + outFx.length + 1 + 2 + 2 + 1 + 1);
  let o = 0;
  hdr[o++] = d.id; hdr[o++] = d.version;
  unhex(d.uoMask).copy(hdr, o); o += 8;
  inFx.copy(hdr, o); o += inFx.length;
  outFx.copy(hdr, o); o += outFx.length;
  hdr[o++] = d.animFps;
  hdr.writeUInt16BE(d.defaultSelectedButtonIdRef, o); o += 2;
  hdr.writeUInt16BE(d.defaultActivatedButtonIdRef, o); o += 2;
  hdr[o++] = d.paletteIdRef;
  hdr[o++] = d.bogs.length;
  return Buffer.concat([hdr, ...bogs]);
}

function parseICS(body) {
  let o = 0;
  const videoWidth = body.readUInt16BE(o); o += 2;
  const videoHeight = body.readUInt16BE(o); o += 2;
  const frameRate = body[o++];
  const compNumber = body.readUInt16BE(o); o += 2;
  const compState = (body[o] >> 6) & 0x03; o += 1;
  const seqDesc = body[o++];
  const dataLen = u24(body, o); o += 3;
  const icStart = o;
  const flags = body[o++];
  const streamModel = (flags >> 7) & 1;
  const uiModel = (flags >> 6) & 1;
  let compTimeoutPts = null, selTimeoutPts = null;
  if (streamModel === 0) {
    compTimeoutPts = ((body[o] & 0x01) * 0x100000000) + body.readUInt32BE(o + 1); o += 5;
    selTimeoutPts = ((body[o] & 0x01) * 0x100000000) + body.readUInt32BE(o + 1); o += 5;
  }
  const userTimeout = u24(body, o); o += 3;
  const numPages = body[o++];
  const pages = [];
  for (let i = 0; i < numPages; i++) { const { page, next } = parsePage(body, o); pages.push(page); o = next; }
  return {
    videoWidth, videoHeight, frameRate, compNumber, compState, seqDesc,
    streamModel, uiModel, compTimeoutPts, selTimeoutPts, userTimeout, pages,
    dataLen, icConsumed: o - icStart,
  };
}
function encodeICS(d) {
  const ic = [];
  ic.push(Buffer.from([((d.streamModel & 1) << 7) | ((d.uiModel & 1) << 6)]));
  if (d.streamModel === 0) {
    const enc = (v) => { const b = Buffer.alloc(5); b[0] = Math.floor(v / 0x100000000) & 0x01; b.writeUInt32BE(v % 0x100000000, 1); return b; };
    ic.push(enc(d.compTimeoutPts || 0));
    ic.push(enc(d.selTimeoutPts || 0));
  }
  const utd = Buffer.alloc(3); wu24(utd, 0, d.userTimeout || 0); ic.push(utd);
  ic.push(Buffer.from([d.pages.length]));
  d.pages.forEach(p => ic.push(encodePage(p)));
  const icData = Buffer.concat(ic);
  const pre = Buffer.alloc(9);
  pre.writeUInt16BE(d.videoWidth, 0);
  pre.writeUInt16BE(d.videoHeight, 2);
  pre[4] = d.frameRate;
  pre.writeUInt16BE(d.compNumber, 5);
  pre[7] = (d.compState & 0x03) << 6;
  pre[8] = d.seqDesc;
  const dl = Buffer.alloc(3); wu24(dl, 0, icData.length);
  return Buffer.concat([pre, dl, icData]);
}

/** Parse any segment body into a decoded structure (by type). */
function decodeSegment(seg) {
  switch (seg.type) {
    case SEG.PDS: return parsePDS(seg.body);
    case SEG.WDS: return parseWDS(seg.body);
    case SEG.ODS: return parseODS(seg.body);
    case SEG.ICS: return parseICS(seg.body);
    case SEG.END: return {};
    default: return { rawHex: hex(seg.body) };
  }
}
/** Encode a decoded structure back to a segment body. */
function encodeSegmentBody(type, decoded) {
  switch (type) {
    case SEG.PDS: return encodePDS(decoded);
    case SEG.WDS: return encodeWDS(decoded);
    case SEG.ODS: return encodeODS(decoded);
    case SEG.ICS: return encodeICS(decoded);
    case SEG.END: return Buffer.alloc(0);
    default: return unhex(decoded.rawHex || '');
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  RLE codec (BD-ROM 8-bit indexed) — libbluray rle.c
// ════════════════════════════════════════════════════════════════════════════
function decodeRLE(rle, width, height) {
  const pixels = new Uint8Array(width * height);
  let i = 0, x = 0, y = 0;
  const put = (color, n) => { for (let k = 0; k < n; k++) { if (x < width && y < height) pixels[y * width + x] = color; x++; } };
  while (i < rle.length && y < height) {
    const b0 = rle[i++];
    if (b0 !== 0) { put(b0, 1); continue; }
    if (i >= rle.length) break;
    const b1 = rle[i++];
    if (b1 === 0) { x = 0; y++; continue; }            // end of line
    const sw = (b1 >> 6) & 0x03;
    if (sw === 0) put(0, b1 & 0x3F);                    // N transparent (short)
    else if (sw === 1) { const n = ((b1 & 0x3F) << 8) | rle[i++]; put(0, n); } // N transparent (long)
    else if (sw === 2) { const n = b1 & 0x3F; put(rle[i++], n); }              // N colour (short)
    else { const n = ((b1 & 0x3F) << 8) | rle[i++]; put(rle[i++], n); }        // N colour (long)
  }
  return pixels;
}

function encodeRLE(pixels, width, height) {
  const out = [];
  const MAX = 0x3FFF;
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const color = pixels[y * width + x];
      let run = 1;
      while (x + run < width && run < MAX && pixels[y * width + x + run] === color) run++;
      if (color === 0) {
        if (run <= 0x3F) out.push(0x00, run);
        else out.push(0x00, 0x40 | (run >> 8), run & 0xFF);
      } else if (run === 1) out.push(color);
      else if (run <= 0x3F) out.push(0x00, 0x80 | run, color);
      else out.push(0x00, 0xC0 | (run >> 8), run & 0xFF, color);
      x += run;
    }
    out.push(0x00, 0x00);
  }
  return Buffer.from(out);
}

// ════════════════════════════════════════════════════════════════════════════
//  High-level extract: m2ts buffer → structured display sets
// ════════════════════════════════════════════════════════════════════════════

/** Find candidate IG PIDs (those carrying ICS segments). */
function findIgPids(packets) {
  const byPid = {};
  for (const p of packets) {
    if (!tsPusi(p.ts)) continue;
    if (tsAfc(p.ts) === 0x00 || tsAfc(p.ts) === 0x02) continue;
    const payload = p.ts.subarray(tsPayloadStart(p.ts));
    const pes = parsePes(payload);
    if (!pes || pes.streamId !== PES_STREAM_ID) continue;
    if (pes.payload.length >= 1 && pes.payload[0] === SEG.ICS) {
      const pid = tsPid(p.ts);
      byPid[pid] = (byPid[pid] || 0) + 1;
    }
  }
  return Object.keys(byPid).map(Number);
}

/**
 * Full structured extraction of one IG PID from an m2ts buffer.
 * @returns {{ pktSize, igPid, units:[...], displaySets:[...], segmentRoundTripOK:bool, mismatches:[] }}
 */
function extractIg(buf, igPid) {
  const { pktSize, packets } = readPackets(buf);
  if (igPid === undefined || igPid === null) {
    const pids = findIgPids(packets);
    igPid = pids[0];
  }
  const rawUnits = demuxPid(packets, igPid);
  const units = [];
  const mismatches = [];
  for (const ru of rawUnits) {
    const pes = parsePes(ru.pesBytes);
    if (!pes) continue;
    const segs = splitSegments(pes.payload);
    const decodedSegs = segs.map(s => {
      const decoded = decodeSegment(s);
      // segment-level round-trip check (exact inverse)
      const reBody = encodeSegmentBody(s.type, decoded);
      const ok = reBody.equals(s.body);
      if (!ok) mismatches.push({ pesIndex: ru.pesIndex, type: s.name, origHex: hex(s.body).slice(0, 80), reHex: hex(reBody).slice(0, 80) });
      return { type: s.type, name: s.name, length: s.length, decoded, bodyHex: hex(s.body), roundTrip: ok };
    });
    units.push({
      pesIndex: ru.pesIndex,
      pktIdxStart: ru.pktIdx[0],
      pktIdx: ru.pktIdx,
      pktCount: ru.pktIdx.length,
      ats: ru.ats[0],
      ccStart: ru.ccStart,
      // exact original PES header bytes (PES start → end of header data) — lets
      // repack preserve the reference's framing (incl. its DTS marker nibble) and
      // swap only the mutated segment payload.
      pesHeaderHex: hex(ru.pesBytes.subarray(0, 9 + pes.hdrDataLen)),
      pes: { streamId: pes.streamId, pesLen: pes.pesLen, flags2: pes.flags2, hdrDataLen: pes.hdrDataLen, ptsDtsFlags: pes.ptsDtsFlags, pts: pes.pts, dts: pes.dts, markerNibble: pes.markerNibble },
      segments: decodedSegs,
      dirty: false,
    });
  }
  // group into display sets: each ICS-led run up to and including END
  const displaySets = [];
  let curDs = null;
  for (const u of units) {
    const hasIcs = u.segments.some(s => s.type === SEG.ICS);
    if (hasIcs) { if (curDs) displaySets.push(curDs); curDs = { units: [u.pesIndex] }; }
    else if (curDs) curDs.units.push(u.pesIndex);
  }
  if (curDs) displaySets.push(curDs);

  return { pktSize, igPid, units, displaySets, segmentRoundTripOK: mismatches.length === 0, mismatches };
}

module.exports = {
  // constants
  M2TS_PKT, TS_PKT, ATS_LEN, SYNC, SEG, SEG_NAME, PES_STREAM_ID,
  // helpers
  hex, unhex, u24, wu24,
  // TS/m2ts
  detectPacketSize, readPackets, tsPid, tsPusi, tsCC, tsAfc, tsPayloadStart,
  demuxPid,
  // PES
  parsePes, buildPes, parseTimestamp, encodeTimestamp, packetizePesToM2ts,
  // segments
  splitSegments, buildSegment, decodeSegment, encodeSegmentBody,
  parsePDS, encodePDS, parseWDS, encodeWDS, parseODS, encodeODS,
  parseICS, encodeICS, parsePage, encodePage, parseBog, encodeBog, parseButton, encodeButton,
  // rle
  decodeRLE, encodeRLE,
  // high level
  findIgPids, extractIg,
};
