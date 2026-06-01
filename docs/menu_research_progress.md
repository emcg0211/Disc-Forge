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

## Phase 4 — Toast-mutation bisection discs ✅ BUILT (2026-06-01)

Full plan + per-step byte deltas: `docs/toast_mutation_plan.md`. Driver:
`tools/ig-toolkit/build_mutation_discs.js`.

- **S0–S7 ISOs built** at `~/Desktop/toast_S{0..7}.iso` (+ `.diff.txt` each),
  all proper **UDF** (verified `NSR02/*UDF/BEA01/TEA01`). ~584 MB each.
- **Design:** mutate Toast's **DS1** (3-button menu) one dimension per step;
  leave **DS0** (1-button) untouched as an in-disc control on every disc.
- **S0 gate verified:** repackaged menu m2ts is byte-identical to Toast's
  01200.m2ts; full BDMV (incl. 583 MB main feature) preserved. **User burns S0
  first** — it must render like the retail disc or the pipeline is suspect.
- Steps: S1 our bitmaps (Toast dims) · S2 our 800×90 dims · S3 our positions ·
  S4 our 4-entry palette · S5 our 2-button count · S6 our PLAY_PL nav · S7 add
  00002 playlist/clipinf. Each diff confirmed to change only its intended field.
- **Prime suspect = S2** (object size): Toast's IG objects are tiny highlight
  glyphs (16×16…79×46) over video-baked text; ours are 800×90 full-text buttons
  (~50× area). If rendering survives S1 but dies at S2 → LG object-size /
  decode-time / window limit.
- **Filesystem lesson:** `xorriso -as mkisofs -udf` on this machine emits
  ISO9660-only (no UDF) — unusable for BD test discs. Use `hdiutil makehybrid
  -udf` (now what `repack.js buildIso` does).
- **S8 (our video) deferred by design** — needs video re-mux + IG re-timing,
  which reintroduces the integration variable the bisection isolates; build it
  after S0–S7 hardware results localize the boundary (recipe in the plan doc).

## Phase 2 — libbluray IG source analysis ✅ COMPLETE (2026-06-01)

Full writeup: `docs/libbluray_ig_analysis.md` (libbluray @ `4dfb9b0`). Top
hardware-divergence candidates, ranked:

1. **Invisible-normal + defSelBtn=0xFFFF.** libbluray `_find_selected_button_id`
   falls back to "first valid button" (spec §5.9.8.3 step 3), so it always
   auto-selects one and draws it. A button is visible only in SELECTED/ACTIVATED
   state; our NORMAL object is 0xFFFF (nothing). If the LG honors 0xFFFF
   literally (no auto-select), **all buttons render NORMAL = blank** → exactly
   "navy, no buttons." Toast uses the same model but **its text is in the
   video**, so it looks populated. Ours is in the IG → invisible. *Strongest
   single explanation.* Fix (Phase 6): visible normal-state object and/or a real
   defaultSelectedButtonIdRef.
2. **DTS/STC ignored in software, enforced in hardware.** In-mux IG decodes with
   `stc=-1` (bluray.c:2109) → the DTS gate is bypassed; libbluray inits the menu
   as soon as a DS completes. All our DTS work (12012 lead, ODS chains) is
   invisible to VLC, hardware-only. → DTS is untestable in VLC; keep Toast-exact.
3. **composition/selection_timeout_pts "not implemented"** (gc:883). We send 0
   (= Toast). Hardware interprets it; never set to video PTS (v1.10.8 reject).
4. **Object size / decode-time.** RLE buffer grows dynamically in SW (no cap);
   HW has fixed buffers. Toast objects 16×16…79×46; ours 800×90 (~50×). =
   Phase-4 **S2** hypothesis.

Other confirmed: ICS-first segment order required (orphans dropped);
`data_len==buf_len` exact or whole IC rejected (ig_decode:280); IG PID must be
0x1400–0x141F; **WDS not consulted by IG button render** (safe to omit, matches
Toast); sparse PDS ok in SW (S4 tests HW); ICS PTS must be ≥ clip in_time or the
seek filter wipes it (why encoder stamps IG PTS = first video PTS).

## Phase 4 — S8 (our video) ✅ BUILT (2026-06-01)

`tools/ig-toolkit/build_s8.js` → `~/Desktop/toast_S8.iso`. S8 = S7's IG on our
**blank navy 0x1a1a2e** menu video (Toast's text-bearing video removed). Built by:
ffmpeg navy still+silent AC3 → tsMuxeR clip → `rewriteVideoPesDts` →
re-time the S7 IG (offset so earliest IG DTS aligns to firstVideoPTS=54000000,
preserving the +12012 ICS lead and Toast's exact PES marker nibbles incl. 0x0
DTS) → `injectIGIntoM2ts` + `patchPmtForIG` → CLPI/MPLS patched for IG + infinite
still, renamed 01200 → full Toast tree → makehybrid UDF. Verified: UDF, navy
frame, still_mode=0x01, IG re-extracts (DS0 Toast control 1-btn + DS1 our 2-btn),
PLAY_PL(1/2)→00001/00002. Full notes in `docs/toast_mutation_plan.md` (S8 section).

**S8 is the decisive test of the Phase-2 #1 hypothesis.** Predicted: renders in
VLC (libbluray auto-selects DS1 btn0 → orange block) but blank on the LG (honours
defSelBtn=0xFFFF). If S0–S7 render but S8 is blank ⇒ confirmed: our IG-borne
button graphics + invisible normal-state need video-baked text (Toast's trick).

## Status / next
Phases 1, 2, 4 (S0–**S8**) all done. **User action: burn S0 (gate) → S1/S2 → S8.**
Report per disc whether DS1 (mutated) and DS0 (control) show buttons; for S8 note
VLC vs LG. Then Phase 6 encoder fix — start with the #1 candidate: give buttons a
**visible normal-state object** and/or a real `default_selected_button_id_ref`.
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
