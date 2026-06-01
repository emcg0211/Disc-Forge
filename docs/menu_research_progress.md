# Menu-rendering research — progress & handoff

Goal: make IG menu buttons render on the **LG BP350** (and standalone BD players
generally), then ship the working encoder as a paid Pro feature (v1.12.0). The
free autoplay release (v1.11.0) already shipped. Work happens on branch
**`menus-pro`** (do not touch the v1.11.0 autoplay path on `main`).

Ground truth: **Toast (Roxio) "My Movie.iso"** renders buttons correctly on the
LG. Menu m2ts = `STREAM/01200.m2ts`, IG **PID 0x1400**. libbluray/VLC accepts
everything (poor hardware proxy).

Strategy shift: 12 single-variable spec-fix iterations (v1.10.x) failed building
IG from scratch. New approach — **start from Toast's working disc and mutate one
dimension at a time toward our content**; the mutation that breaks rendering is
the hardware constraint. Phase 1 builds the toolkit for that.

---

## Phase 1 — forensic & mutation toolkit ✅ COMPLETE (2026-06-01)

Delivered `tools/ig-toolkit/`: `lib.js`, `extract.js`, `mutate.js`, `repack.js`,
`diff.js`, `selftest.js`, `README.md`. See the README for full usage.

**Verified guarantees**
- `extract → repack` of Toast 01200.m2ts is **byte-identical** (lossless).
- `repack --reencode-all` is **also byte-identical** — our PES/TS re-encoder
  reproduces Toast exactly (header preserved, payload refilled in place).
- Every segment `parse→encode` reproduces the original payload byte-for-byte
  (ICS/PDS/WDS/ODS), zero mismatches.
- `selftest.js`: 15/15 pass. Existing suites untouched: **205/205** pass
  (`tests/ig-encoder.test.js` 181, `tests/rewrite-video-pes-dts.test.js` 24).

**Mutation fidelity demonstrated**
- Same-length mutation (button position) → **3 changed bytes, 1 packet**, ATS/CC/AF
  preserved; `diff.js` isolates exactly the one changed field.
- Length-changing mutation (ODS 79×46 → 120×60) → unit re-packetized (+1 packet),
  output re-extracts cleanly with exact segment round-trip.
- Palette-entry edit → 4 changed bytes, in place.

---

## Toast IG forensic decode (from the toolkit, 2026-06-01)

Toast's working menu is **two epoch-start display sets**, CC continuous across
both (0→15 wrapping). Packets 777–788 (DS0) and 1644–1662 (DS1).

| field | DS0 | DS1 |
|---|---|---|
| segments | ICS, PDS, ODS×1, END | ICS, PDS, ODS×3, END |
| **WDS** | **none** | **none** |
| ICS comp_number / state | 0 / 2 (epoch_start) | 1 / 2 (epoch_start) |
| video / frame_rate | 1920×1080 / 0x40 | 1920×1080 / 0x40 |
| stream_model / ui_model | 0 (in-mux) / 0 (always-on) | 0 / 0 |
| comp_timeout_pts / sel_timeout_pts | 0 / 0 | 0 / 0 |
| pages / bogs / buttons | 1 / 1 / **1** | 1 / 3 / **3** |
| defaultSelectedButtonIdRef | 65535 (0xFFFF) | 65535 (0xFFFF) |
| defaultActivatedButtonIdRef | 65535 | 65535 |
| palette_id_ref | 0 | 0 |
| PDS entries | 255 | 255 |
| ODS sizes | 22×22 | 16×16, 16×17, 79×46 |

**PES timing pattern (both DS identical shape):**
- ICS: `PTS − DTS = 12012` ticks (DS0 120030/108018; DS1 165075/153063).
- PDS: PTS = ICS **DTS**, no DTS field.
- ODS: DTS/PTS chained (each ODS DTS = previous ODS PTS), small decode deltas
  (DS1: 153063→153066→153070→153111).
- END: PTS = last ODS PTS, no DTS.

**Out-of-spec detail that LG accepts:** Toast's PES **DTS field marker nibble is
`0x0`** (MPEG-2 spec mandates `0x1`). Confirmed by `repack --reencode-all` diff:
the only TS-content divergence between our spec-correct encoder and Toast was
exactly this nibble on the 6 DTS-bearing packets (ICS×2, ODS×4). Candidate
hardware-relevant convention — flag for Phase 2.

These confirm several v1.10.18 notes empirically: 2 epoch_start DS, defSelBtn =
0xFFFF, no WDS, DTS nibble 0x0. **DS0 has only 1 button/1 ODS while DS1 has 3** —
worth understanding (DS0 may be a transient/initial composition and DS1 the real
menu; investigate in Phase 3).

---

## Open questions for later phases
- Why two display sets, and why DS0=1 button vs DS1=3 buttons? (Phase 3 decode +
  Phase 2 libbluray epoch handling.)
- Is the `0xFFFF` defaultSelectedButton (no auto-selection) significant for
  hardware rendering vs. our prior attempts that set a real default?
- No-WDS: does the LG require buttons to paint without a window definition, or is
  WDS simply optional? (Phase 4 step can add/remove WDS to test.)
- The DTS nibble 0x0 — enforced or ignored by LG firmware?

## Next: Phase 2 (awaiting greenlight)
Deep libbluray source analysis (`src/libbluray/decoders/*.c`, `hdmv/*.c`):
every conditional that can suppress a button, lax spec interpretations,
"player should do X but we don't" comments, the button selection state machine,
TopMenu vs PopupMenu vs IG-in-playback semantics. Output:
`docs/libbluray_ig_analysis.md`. Cross-reference the Toast findings above —
especially the DTS nibble, the no-WDS layout, and defSelBtn=0xFFFF.

## Reference assets
- Toast ISO: `/Volumes/Internal SSD/Personal/My Movie.iso` (menu `STREAM/01200.m2ts`, PID 0x1400)
- Working pack for experiments: `node tools/ig-toolkit/extract.js <toast_m2ts> /tmp/toast.pack`
- Clannad reference: `reference_clannad/BDMV/` (software-validated)
- Beach Boys reference: `~/Desktop/reference_bdmv/`
- Our latest output discs: `~/Desktop/v110*_test.iso`
