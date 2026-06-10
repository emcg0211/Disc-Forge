'use strict';
/**
 * Single-title menu — hardware-invariants regression suite.
 * Run: node tests/single-title-menu.test.js
 *
 * Pins every field of the single-title ("Play Movie") menu path that the
 * LG BP350 investigation proved load-bearing, end to end across the same
 * production functions addMenuToDisc() calls:
 *
 *   patchMplsClipName → patchMplsForIG → patchMplsForStill   (00099.mpls)
 *   buildMenuDisplaySet (N=1, PLAY_PL(0))                     (IG stream)
 *   injectIGIntoM2ts → patchPmtForIG                          (00099.m2ts)
 *
 * The MPLS fixture reproduces the exact PlayItem/STN layout tsMuxeR emits
 * (verified against real tsMuxeR output, 2026-06-10). The still_mode value
 * map is the one from BD-ROM Part 3 §5.3.4 / libbluray bluray.h:
 *   0x00 = none, 0x01 = BLURAY_STILL_TIME, 0x02 = BLURAY_STILL_INFINITE.
 * still_mode=0x01 + still_time=0 (shipped through v1.24.0) is a zero-second
 * timed still — the menu looped and never took input on hardware.
 */

const path = require('path');
const mb = require(path.join(__dirname, '..', 'src', 'lib', 'menu-builder.js'));

let passed = 0, failed = 0;
function assert(cond, name, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); failed++; }
}
function assertEq(a, b, name) { assert(a === b, name, `expected ${b}, got ${a}`); }

// ── Fixture: a tsMuxeR-shaped single-PlayItem MPLS (video+audio STN) ──────────
// Field offsets match libbluray mpls_parse.c (and real tsMuxeR output):
// PlayList at 58; PlayItem at 68; STN at PlayItem+34 with 16-byte header and
// 16-byte entries (StreamEntry 10 + StreamCodingInfo 6).
function buildTsMuxerLikeMpls() {
  const PL_OFF = 58;
  const PI_PAYLOAD = 80;             // tsMuxeR's video+audio PlayItem payload size
  const buf = Buffer.alloc(PL_OFF + 10 + 2 + PI_PAYLOAD + 16, 0x00); // + mark table stub
  buf.write('MPLS0200', 0, 'ascii');
  buf.writeUInt32BE(PL_OFF, 8);                       // PlayList_start_address
  const markAddr = PL_OFF + 10 + 2 + PI_PAYLOAD;
  buf.writeUInt32BE(markAddr, 12);                    // PlayListMark_start_address
  buf.writeUInt32BE(0, 16);                           // ExtensionData (none)
  buf.writeUInt32BE(6 + 2 + PI_PAYLOAD, PL_OFF);      // PlayList.length
  buf.writeUInt16BE(1, PL_OFF + 6);                   // num_PlayItems
  buf.writeUInt16BE(0, PL_OFF + 8);                   // num_SubPaths
  const pi = PL_OFF + 10;
  buf.writeUInt16BE(PI_PAYLOAD, pi);                  // PlayItem.length
  buf.write('00000', pi + 2, 'ascii');                // clip id
  buf.write('M2TS', pi + 7, 'ascii');                 // codec id
  buf.writeUInt16BE(0x0001, pi + 11);                 // reserved+multi_angle+cc=1
  buf[pi + 13] = 0;                                   // stc_id
  buf.writeUInt32BE(27000000, pi + 14);               // IN_time  (45kHz)
  buf.writeUInt32BE(27225000, pi + 18);               // OUT_time (45kHz, +5s)
  buf[pi + 30] = 0x80;                                // RAF=1 (verify it survives)
  // STN_table at pi+34: length(2) reserved(2) counts(7) reserved(5) entries
  const stn = pi + 34;
  buf.writeUInt16BE(46, stn);                         // STN length (2 entries + header - 2)
  buf[stn + 4] = 1;                                   // num_video
  buf[stn + 5] = 1;                                   // num_audio
  buf[stn + 6] = 0;                                   // num_PG
  buf[stn + 7] = 0;                                   // num_IG
  let so = stn + 16;
  // video entry: StreamEntry(10) 09 01 PID(0x1011) ... + SCI(6) 05 1b ...
  buf[so] = 9; buf[so + 1] = 1; buf.writeUInt16BE(0x1011, so + 2);
  buf[so + 10] = 5; buf[so + 11] = 0x1b; so += 16;
  // audio entry: PID 0x1100, AC-3 (0x81)
  buf[so] = 9; buf[so + 1] = 1; buf.writeUInt16BE(0x1100, so + 2);
  buf[so + 10] = 5; buf[so + 11] = 0x81;
  return buf;
}

// ── Decoders (independent of the encoder, per libbluray layouts) ─────────────
function decodePlayItem(buf) {
  const plStart = buf.readUInt32BE(8);
  const pi = plStart + 10;
  const stn = pi + 34;
  const streams = [];
  let so = stn + 16;
  const total = buf[stn + 4] + buf[stn + 5] + buf[stn + 6] + buf[stn + 7];
  for (let s = 0; s < total; s++) {
    const entryLen = buf[so];
    const pid = buf.readUInt16BE(so + 2);
    const sciLen = buf[so + 10];
    streams.push({ pid, codingType: buf[so + 11] });
    so += 1 + entryLen + 1 + sciLen;
  }
  return {
    length: buf.readUInt16BE(pi),
    clipId: buf.slice(pi + 2, pi + 7).toString('ascii'),
    byte30: buf[pi + 30],
    stillMode: buf[pi + 31],
    stillTime: buf.readUInt16BE(pi + 32),
    stnLen: buf.readUInt16BE(stn),
    numIG: buf[stn + 7],
    markAddr: buf.readUInt32BE(12),
    streams,
  };
}

function ts90k(b, o) {
  return ((b[o] & 0x0e) * (1 << 29)) + (b[o + 1] * (1 << 22)) +
         ((b[o + 2] & 0xfe) * (1 << 14)) + (b[o + 3] * (1 << 7)) + ((b[o + 4] & 0xfe) >> 1);
}

// Depacketize a 188-byte TS IG stream into PES packets with PTS/DTS + segment type.
function decodeIgSegments(igTs) {
  const pes = [];
  let cur = null;
  for (let i = 0; i + 188 <= igTs.length; i += 188) {
    const pkt = igTs.slice(i, i + 188);
    const pusi = !!(pkt[1] & 0x40);
    const afc = (pkt[3] >> 4) & 3;
    let off = 4;
    if (afc & 2) off += 1 + pkt[4];
    const data = pkt.slice(off);
    if (pusi) { if (cur) pes.push(cur); cur = [data]; }
    else if (cur) cur.push(data);
  }
  if (cur) pes.push(cur);
  return pes.map(chunks => {
    const raw = Buffer.concat(chunks);
    const flags2 = raw[7], hdrLen = raw[8];
    const seg = raw.slice(9 + hdrLen);
    return {
      type: seg[0],
      pts: (flags2 & 0x80) ? ts90k(raw, 9) : null,
      dts: (flags2 & 0x40) ? ts90k(raw, 14) : null,
      body: seg,
    };
  });
}

// Parse the ICS body fields the hardware investigation proved load-bearing.
function decodeIcs(seg) {
  const b = seg.body;
  let o = 3 + 5 + 3 + 1;                       // header + video + comp + seq descriptors
  o += 3;                                       // interactive_composition data_len(24)
  const sm = b[o]; o += 1;
  const out = { streamModel: (sm >> 7) & 1, uiModel: (sm >> 6) & 1 };
  out.compositionTimeout = (b[o] & 1) * 0x100000000 + b.readUInt32BE(o + 1); o += 5;
  out.selectionTimeout = (b[o] & 1) * 0x100000000 + b.readUInt32BE(o + 1); o += 5;
  out.userTimeout = (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]; o += 3;
  out.numPages = b[o]; o += 1;
  const pg = o;
  out.defaultSelected = b.readUInt16BE(pg + 15);
  out.defaultActivated = b.readUInt16BE(pg + 17);
  out.numBogs = b[pg + 20];
  const bo = pg + 21;
  out.bogDefaultValid = b.readUInt16BE(bo);
  const bt = bo + 3;
  out.button = {
    id: b.readUInt16BE(bt),
    up: b.readUInt16BE(bt + 9), down: b.readUInt16BE(bt + 11),
    left: b.readUInt16BE(bt + 13), right: b.readUInt16BE(bt + 15),
    normalStart: b.readUInt16BE(bt + 17),
    selStart: b.readUInt16BE(bt + 23),
    actStart: b.readUInt16BE(bt + 29),
    numNavCmds: b.readUInt16BE(bt + 33),
    navCmd: b.slice(bt + 35, bt + 47).toString('hex'),
  };
  return out;
}

// Minimal 192-byte-packet m2ts with a PAT and a video-only PMT (PID 0x0100).
function buildMinimalM2ts() {
  function tsPacket(pid, section) {
    const pkt = Buffer.alloc(188, 0xFF);
    pkt[0] = 0x47;
    pkt[1] = 0x40 | ((pid >> 8) & 0x1F);
    pkt[2] = pid & 0xFF;
    pkt[3] = 0x10;
    pkt[4] = 0x00;                              // pointer_field
    section.copy(pkt, 5);
    return pkt;
  }
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc ^= (buf[i] << 24);
      for (let j = 0; j < 8; j++) { crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1); crc = crc >>> 0; }
    }
    return crc >>> 0;
  }
  // PAT: program 1 → PMT PID 0x0100
  const patBody = Buffer.from([0x00, 0xB0, 0x0D, 0x00, 0x00, 0xC1, 0x00, 0x00, 0x00, 0x01, 0xE1, 0x00]);
  const pat = Buffer.concat([patBody, (() => { const b = Buffer.alloc(4); b.writeUInt32BE(crc32(patBody), 0); return b; })()]);
  // PMT: PCR 0x1011, one ES: H.264 (0x1b) @ 0x1011
  const pmtNoCrc = Buffer.from([
    0x02, 0xB0, 0x12, 0x00, 0x01, 0xC1, 0x00, 0x00,
    0xF0 | 0x00, 0x11,                          // PCR PID 0x1011 (0xE0|hi … actually 0xF0 nibble carries reserved bits)
    0xF0, 0x00,                                 // program_info_length 0
    0x1b, 0xE0 | 0x10, 0x11, 0xF0, 0x00,        // stream_type 0x1b PID 0x1011
  ]);
  // fix section_length to actual: bytes after first 3 = pmtNoCrc.length - 3 + 4
  pmtNoCrc[1] = 0xB0 | (((pmtNoCrc.length - 3 + 4) >> 8) & 0x0F);
  pmtNoCrc[2] = (pmtNoCrc.length - 3 + 4) & 0xFF;
  const pmt = Buffer.concat([pmtNoCrc, (() => { const b = Buffer.alloc(4); b.writeUInt32BE(crc32(pmtNoCrc), 0); return b; })()]);
  const m2ts = Buffer.alloc(2 * 192);
  m2ts.writeUInt32BE(0, 0); tsPacket(0x0000, pat).copy(m2ts, 4);
  m2ts.writeUInt32BE(300, 192); tsPacket(0x0100, pmt).copy(m2ts, 196);
  return { m2ts, crc32 };
}

// ── 1: MPLS patch chain (the addMenuToDisc playlist path) ─────────────────────
console.log('\n=== 1: 00099.mpls patch chain — clip name, IG STN entry, infinite still ===');
{
  const raw = buildTsMuxerLikeMpls();
  const before = decodePlayItem(raw);
  const patched = mb.patchMplsForStill(mb.patchMplsForIG(mb.patchMplsClipName(raw, '00099')));
  const pi = decodePlayItem(patched);

  assertEq(pi.clipId, '00099', 'clip_information_file_name renamed to 00099');
  assertEq(pi.stillMode, 0x02, 'still_mode = 0x02 (BLURAY_STILL_INFINITE — NOT 0x01/timed)');
  assertEq(pi.stillTime, 0x0000, 'still_time = 0 (unused for infinite still)');
  assertEq(pi.byte30, 0x80, 'random_access_flag preserved, reserved bits cleared');
  assertEq(pi.numIG, 1, 'STN num_IG = 1');
  const ig = pi.streams.find(s => s.pid === 0x1400);
  assert(!!ig, 'STN declares IG stream at PID 0x1400');
  assertEq(ig && ig.codingType, 0x91, 'IG StreamCodingInfo coding_type = 0x91 (HDMV IG)');
  assertEq(pi.stnLen, before.stnLen + 16, 'STN_table.length grew by exactly 16');
  assertEq(pi.length, before.length + 16, 'PlayItem.length grew by exactly 16');
  assertEq(pi.markAddr, before.markAddr + 16, 'PlayListMark_start_address shifted by 16');
}

// ── 2: IG display set invariants (buildMenuDisplaySet N=1, "Play Movie") ─────
console.log('\n=== 2: single-button IG display set — hardware-proven field invariants ===');
{
  const PTS = 54000000;                          // = clip in_time in 90kHz
  const igTs = mb.buildMenuDisplaySet({ playlists: [0], pts: PTS, labels: ['Play Movie'] });
  assertEq(igTs.length % 188, 0, 'IG stream is whole 188-byte TS packets');
  const segs = decodeIgSegments(igTs);
  assertEq(segs.map(s => '0x' + s.type.toString(16)).join(','), '0x18,0x14,0x15,0x15,0x80',
    'segment order ICS,PDS,ODS,ODS,END — 2 ODS (normal+selected), NO WDS (Toast layout)');
  assertEq(segs[0].pts, PTS, 'ICS PES PTS = clip in_time (Finding B anchor)');
  assertEq(segs[0].dts, PTS - 12012, 'ICS PES DTS = PTS − 12012 (Toast-measured lead)');
  assertEq(segs[1].pts, PTS - 12012, 'PDS PTS = ICS DTS');
  assertEq(segs[1].dts, null, 'PDS has no DTS');
  assertEq(segs[2].dts, PTS - 12012, 'ODS[0] DTS = ICS DTS (decode chain start)');
  assertEq(segs[4].pts, segs[3].pts, 'END PTS = last ODS PTS');

  const ics = decodeIcs(segs[0]);
  assertEq(ics.streamModel, 0, 'stream_model = 0 (in-mux, IG in the menu clip)');
  assertEq(ics.uiModel, 0, 'ui_model = 0 (always-on, not popup)');
  assertEq(ics.compositionTimeout, 0, 'composition_timeout_pts = 0 (Toast-identical; v1.10.8: non-zero = hardware load reject)');
  assertEq(ics.selectionTimeout, 0, 'selection_timeout_pts = 0 (Toast-identical)');
  assertEq(ics.userTimeout, 0, 'user_timeout_duration = 0 (wait forever)');
  assertEq(ics.numPages, 1, 'one page');
  assertEq(ics.defaultSelected, 1, 'default_selected_button_id_ref = 1 (Play Movie starts highlighted)');
  assertEq(ics.defaultActivated, 0xFFFF, 'default_activated_button_id_ref = 0xFFFF (none auto-activated)');
  assertEq(ics.numBogs, 1, 'one BOG');
  assertEq(ics.bogDefaultValid, 1, 'BOG default_valid_button_id_ref = 1');
  const btn = ics.button;
  assertEq(btn.id, 1, 'button id = 1 (1-based per spec)');
  assert(btn.up === 1 && btn.down === 1 && btn.left === 1 && btn.right === 1,
    'lone button navigation is self-referential (up/down/left/right = 1)');
  assertEq(btn.normalStart, 0, 'visible NORMAL state object (obj 0) — not 0xFFFF');
  assertEq(btn.selStart, 1, 'SELECTED state object (obj 1)');
  assertEq(btn.actStart, 1, 'ACTIVATED reuses the selected object');
  assertEq(btn.numNavCmds, 1, 'one nav command');
  assertEq(btn.navCmd, '228000000000000000000000', 'nav command = PLAY_PL(0) — the feature playlist');
}

// ── 3: PMT declaration (patchPmtForIG on a minimal PAT/PMT m2ts) ──────────────
console.log('\n=== 3: PMT declares the IG stream with a valid CRC ===');
{
  const { m2ts, crc32 } = buildMinimalM2ts();
  const patched = mb.patchPmtForIG(m2ts, 0x1400, 0x91);
  // decode the patched PMT
  const pkt = patched.slice(192 + 4, 192 + 192);
  const ss = 5;                                   // pointer 0 → section at payload+1
  const secLen = ((pkt[ss + 1] & 0x0F) << 8) | pkt[ss + 2];
  const crcOff = ss + 3 + secLen - 4;
  const progInfoLen = ((pkt[ss + 10] & 0x0F) << 8) | pkt[ss + 11];
  let es = ss + 12 + progInfoLen;
  const found = [];
  while (es + 5 <= crcOff) {
    found.push({ st: pkt[es], pid: ((pkt[es + 1] & 0x1F) << 8) | pkt[es + 2] });
    es += 5 + (((pkt[es + 3] & 0x0F) << 8) | pkt[es + 4]);
  }
  const igEs = found.find(e => e.pid === 0x1400);
  assert(!!igEs, 'PMT ES loop contains PID 0x1400');
  assertEq(igEs && igEs.st, 0x91, 'PMT stream_type = 0x91 (HDMV IG — hardware demux routing)');
  assertEq(pkt.readUInt32BE(crcOff), crc32(pkt.slice(ss, crcOff)), 'PMT CRC_32 recomputed correctly');
  const again = mb.patchPmtForIG(patched, 0x1400, 0x91);
  assert(again.equals(patched), 'patchPmtForIG is idempotent (second call is a no-op)');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('OVERALL: FAIL'); process.exit(1); }
else { console.log('OVERALL: PASS'); }
