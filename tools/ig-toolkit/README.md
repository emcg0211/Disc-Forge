# ig-toolkit — Blu-ray Interactive Graphics forensic & mutation toolkit

Phase-1 deliverable of the menu-rendering research (see the top-level
`docs/menu_research_progress.md`). The premise: 12 prior iterations built IG
from scratch and failed on hardware. This toolkit lets us go the other
direction — start from **Toast's known-good disc** and mutate it one dimension
at a time toward our content. The mutation that breaks button rendering on the
LG BP350 is the hardware-critical constraint.

Everything here is **lossless**: extracting a reference and re-packing it with
no changes reproduces the input m2ts **byte-for-byte** (including Toast's
out-of-spec DTS marker nibble). A single-dimension mutation changes only the
bytes it must.

## Layers

```
M2TS     192-byte packet = 4-byte arrival timestamp (ATS) + 188-byte TS packet
TS       sync 0x47, PID, PUSI, continuity counter, adaptation field
PES      00 00 01 + stream_id(0xBD) + length + flags + PTS/DTS
Segment  ICS(0x18) PDS(0x14) WDS(0x17) ODS(0x15) END(0x80)
```

## Files

| file        | role |
|-------------|------|
| `lib.js`    | shared codec: m2ts/TS read, provenance-demux, PES parse/build, segment parse/encode (exact inverses), RLE decode/encode |
| `extract.js`| ISO / m2ts / BDMV dir → JSON dump + `*.pack` intermediate |
| `mutate.js` | apply one targeted mutation to a pack (marks affected PES units dirty) |
| `repack.js` | pack → m2ts (clean = passthrough, dirty = re-encode); also BDMV → ISO |
| `diff.js`   | structural IG diff of two m2ts/packs, classified `= ~ !` |
| `selftest.js`| codec round-trips + full byte-identity test (run this first) |

## The `.pack` intermediate

`extract.js` writes a directory:

```
foo.pack/
  source.m2ts    exact copy of the chosen m2ts (repack reads original bytes here)
  manifest.json  pktSize, igPid, displaySets, and per-PES-unit decode + provenance
  ig.txt         human-readable dump
```

`manifest.units[*]` records each IG PES unit: packet indices, ATS, CC start,
the **exact original PES header bytes** (`pesHeaderHex`), the decoded segments,
and a `dirty` flag. `repack` re-emits the original packets for clean units (→
byte-identical) and re-encodes only dirty ones. When a mutation keeps the PES
length unchanged it refills the original packets in place, so ATS / CC /
adaptation-field stuffing are preserved exactly — the output differs from the
reference only in the mutated field's bytes.

## Usage

### Extract

```bash
# from a loose m2ts
node tools/ig-toolkit/extract.js /tmp/igtk/toast_01200.m2ts /tmp/igtk/toast.pack

# from an ISO (mounts read-only, picks the smallest = menu m2ts, auto-detects IG PID)
node tools/ig-toolkit/extract.js "/Volumes/Internal SSD/Personal/My Movie.iso" /tmp/toast.pack

# force a stream / PID
node tools/ig-toolkit/extract.js disc.iso out.pack --stream 01200 --pid 0x1400
```

### Mutate (one dimension per call; chain as many as you like)

```bash
node tools/ig-toolkit/mutate.js toast.pack set-button-pos   <ds> <bog> <btn> <x> <y>
node tools/ig-toolkit/mutate.js toast.pack set-defsel       <ds> <value>
node tools/ig-toolkit/mutate.js toast.pack set-state        <ds> <bog> <btn> <nStart> <nEnd> <sStart> <sEnd> <aStart> <aEnd>
node tools/ig-toolkit/mutate.js toast.pack set-nav          <ds> <bog> <btn> <cmdIdx> PLAY_PL <playlistId>
node tools/ig-toolkit/mutate.js toast.pack set-palette      <ds> <id> <Y> <Cr> <Cb> <T>
node tools/ig-toolkit/mutate.js toast.pack copy-palette     <ds> <fromPack> [fromDs]
node tools/ig-toolkit/mutate.js toast.pack remove-wds       <ds>
node tools/ig-toolkit/mutate.js toast.pack set-wds          <ds> <id> <x> <y> <w> <h>
node tools/ig-toolkit/mutate.js toast.pack set-ods-dims     <ds> <objIdx> <w> <h>
node tools/ig-toolkit/mutate.js toast.pack set-ods-bitmap   <ds> <objIdx> <png> [--fit]
node tools/ig-toolkit/mutate.js toast.pack set-ods-from     <ds> <objIdx> <fromPack> <fromDs> <fromObjIdx>
```

`<ds>` is the display-set index shown by `extract.js`. `set-ods-bitmap`
quantizes the PNG against *that display set's own palette* via ffmpeg.

### Repack

```bash
node tools/ig-toolkit/repack.js toast.pack /tmp/out.m2ts          # apply mutations
node tools/ig-toolkit/repack.js toast.pack /tmp/rt.m2ts            # no mutations → byte-identical
node tools/ig-toolkit/repack.js toast.pack /tmp/re.m2ts --reencode-all   # diagnostic
node tools/ig-toolkit/repack.js --iso /path/to/BDMV_root /tmp/disc.iso   # BDMV dir → ISO (xorriso)
```

### Diff

```bash
node tools/ig-toolkit/diff.js /tmp/igtk/toast_01200.m2ts /tmp/out.m2ts
# A/B can each be a .m2ts or a .pack; prints only differences + a summary count.
```

### Verify

```bash
node tools/ig-toolkit/selftest.js
```

## Round-trip guarantee (verified)

```
extract(toast_01200.m2ts) → repack            == toast_01200.m2ts   (byte-identical)
extract(toast_01200.m2ts) → repack --reencode-all == toast_01200.m2ts  (byte-identical)
all segments parse→encode == original payload  (zero mismatches)
```

## Notes / gotchas

- **DTS marker nibble.** Toast writes the PES DTS field's high nibble as `0x0`
  (MPEG-2 spec says `0x1`). The toolkit preserves whatever the source used by
  reusing the original PES header on re-encode. If you ever build a PES from
  scratch via `lib.buildPes`, it emits the spec value `0x1`.
- **ODS fragmentation.** Pixel/dimension mutations assume a single-fragment ODS
  (`first==last==1`), which is what Toast and our encoder produce. Multi-fragment
  objects round-trip losslessly but are not re-RLE'd by `set-ods-*`.
- **ATS on re-packetized units.** When a mutation changes PES length, the unit is
  re-packetized and ATS values are synthesized from the unit's base + a fixed
  step. This is timing metadata only; players reconstruct from PTS/DTS.
