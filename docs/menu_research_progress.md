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

---

## S8 VLC failure — root cause (Jun 1 2026, measured not assumed)

S8 played navy with **no buttons** in VLC and logged
`graphics_processor.c:380: ERROR: updating complete (non-consumed) IG composition`.
S7 (same IG bytes, Toast video) renders. Measured both with `extract.js` + a raw
PID/PTS scan of the muxed `01200.m2ts`. Two findings:

### Finding A — PRIMARY (the VLC breaker): both display sets are one contiguous block
The two builders place the IG differently in the transport stream:

| disc | builder | DS0 IG packets | DS1 IG packets | layout |
|------|---------|----------------|----------------|--------|
| S7 (works) | `build_mutation_discs.js` → `repack` (mutates Toast m2ts **in place**) | pkt 777–788 | pkt 1644–1659 | **interleaved with video, ~860 pkts apart** (Toast's original layout) |
| S8 (fails) | `build_s8.js` → `injectIGIntoM2ts` (extract IG, **re-inject as one blob** after pkt 10) | pkt 10–21 | pkt 22–37 | **contiguous: DS1 immediately follows DS0** |

In-mux IG is decoded with `gc_decode_ts(..., stc = -1)` (`bluray.c:2108`), so the
DTS/STC gate is bypassed (`graphics_processor.c:540`) and libbluray decodes
packets **in arrival order, ignoring PTS/DTS**. With DS0 and DS1 contiguous in the
same read, DS1's ICS (`_decode_ics`, ~`graphics_processor.c:380`) arrives **before
DS0's completed composition is consumed** by `_run_gc(INIT_MENU)` → the exact
"updating complete (non-consumed) IG composition" error → DS1 clobbers DS0 mid-
decode and no menu paints. S7 works only because Toast's interleaving puts ~860
video packets between the sets, so each completes and is consumed in its own read.

**This is almost certainly a software-only (stc=-1) artifact.** Real hardware
schedules decode by DTS in its transport demux (Phase-2 analysis §3), so on the LG
the two sets would decode at their separate DTS (45045 ticks / ~0.5 s apart) and
the contiguity would not matter. So the contiguous layout breaks VLC but may be
fine on hardware — which is why we keep a two-DS disc as a hardware diagnostic.

### Finding B — SECONDARY (hardware-relevant timing, not the VLC breaker): wrong offset anchor
`build_s8.js` set `offset = firstVideoPTS − earliest IG **DTS**`, landing
**ICS DTS = firstVideoPTS** and **ICS PTS = firstVideoPTS + 12012**. Toast's
genuine convention (measured on S7) is the inverse: **ICS PTS = in_time
(= firstVideoPTS)** with DTS 12012 earlier, and PDS/ODS legitimately a hair
before in_time. Measured:

```
            video first PTS   DS0 ICS PTS   DS0 ICS DTS
S7 (Toast)     120030           120030        108018   (ICS PTS == in_time)  ✔ Toast model
S8 (ours)    54000000         54012012      54000000   (ICS DTS == in_time)  -> 12012 late
```

This does not break VLC (it ignores DTS, and both ICS PTS pass the `m2ts_filter`
`pts ≥ in_time` check). But it deviates from Toast and is corrected for hardware
fidelity: anchor the **earliest ICS PTS** to `firstVideoPTS` (offset = firstVideoPTS
− min(ICS PTS) = 54000000 − 120030 = 53879970). The navy clip's first video PTS is
genuinely 54000000 (tsMuxeR's default 600 s start) — verified by raw scan, not the
`extractFirstVideoPTS` 54000000 *fallback*; PID 0x1011 PUSI carries PTS=54000000.

### Fixes applied
- `build_s8.js`: anchor offset on earliest **ICS PTS** (Finding B). Kept two-DS
  layout — S8 stays the hardware diagnostic for the DTS-scheduled two-set case.
- `build_s9.js` (new): **single display set** (DS1 only — our real 2-button menu;
  DS0 was just Toast's vestigial 1-button/22×22 top-menu glyph, unmutated). One
  contiguous DS has no DS-to-DS consume conflict, so it renders in VLC *and* is the
  robust hardware candidate. ISO → `~/Desktop/menu-tests/toast_S9.iso`.

### Finding C — REVEALED after A+B fixed: invisible objects (Phase-2 #1, now confirmed in SW)
With Finding A fixed (single-DS S9), VLC's `graphics_processor.c:380` error is
**gone** — the composition parses and is consumed cleanly (`displaySets=1`,
2 buttons, segRT ok). But S9 still shows **navy, no buttons** in VLC. Measured why:

- Button id=1/2: `normalStart=normalEnd=0xFFFF` (no normal-state object →
  invisible unless selected) but `selStart=selEnd=actStart=actEnd=0` (a real
  800×90 object 0 for the selected/activated state). `defaultSelectedButtonIdRef
  = 0xFFFF`; libbluray's lax fallback auto-selects button 1 and renders object 0.
- **Palette (id 0, 4 entries): only index 0 is opaque (`T=255`); indices 1, 2, 3
  are all fully transparent (`T=0`).** The 800×90 button fill uses indices 1/2/3,
  so the selected object renders but every pixel is transparent → nothing visible.

So **the IG objects are genuinely invisible**, exactly the Phase-2 TL;DR #1
prediction. S0–S7 only looked populated because they sit on **Toast's** menu
video (text baked into the video); the IG objects were invisible there too. On
our navy clip there is no video text, so the invisible objects = navy blank.
**This confirms in software what S8 was built to test on hardware.** It is the
*render* layer (Phase-6), independent of the timing/structural fixes above.

**Phase-6 next step (the now-decisive fix):** give buttons a **visible
normal-state object** and/or set a real `default_selected_button_id_ref`, AND
make the button-fill palette entries **opaque** (`T=255`, currently `T=0`).
Either alone is insufficient: with a real defSel but a transparent palette the
selected button still paints nothing; with an opaque palette but invisible
normal-state only the (auto-)selected button shows. Robust menu = visible normal
objects + opaque palette.

### Net result of this session
- **Timing bug (B): fixed** — S8 now anchors ICS PTS to in_time, Toast-correct.
- **Structural non-consumed bug (A): fixed** — S9 (single-DS) eliminates the
  `graphics_processor.c:380` error; composition parses & consumes cleanly in VLC.
- **Render bug (C): diagnosed, not yet fixed** — invisible objects (transparent
  palette + 0xFFFF normal/defSel). This is the real remaining blocker and the
  Phase-6 target. Neither S8 nor S9 will show buttons until C is fixed.

Hardware-burn diagnostics ready: **S8** (two-DS, timing-fixed — tests whether a
DTS-scheduling HW demux is happy with two contiguous sets) and **S9** (single-DS,
timing-fixed — the clean single-menu candidate; also tests whether the LG honours
`defSel=0xFFFF` literally). Expect both to be blank until C is fixed; the value of
burning them is to confirm A/B no longer cause a *load/parse* rejection on HW.

---

## S10 — palette + defSel fix (Jun 1 2026): FIRST IG button to render in VLC ✅

`tools/ig-toolkit/build_s10.js` = S9 (single DS1, navy video, ICS PTS anchored to
in_time) **plus the Finding-C render fix**:
- **Opaque palette** — all 4 entries `T=255` (was: only idx 0 opaque). Format
  `id:Y,Cr,Cb,T`: `0:16,128,128,255` (navy bg, unused by rect) ·
  `1:235,128,128,255` (white border = set-ods-rect borderIdx) ·
  `2:80,120,150,255` (blue fill = fillIdx) · `3:140,120,150,255` (highlight).
- **`default_selected_button_id_ref = 1`** (was 0xFFFF) via `OPS['set-defsel']`.

Verified in the built ISO: `displaySets=1`, `defSel=1`, all palette `T=255`,
button id1 sel→obj0 / id2 sel→obj1, both `normalStart=0xFFFF`.

**VLC result (measured, screenshot `/tmp/vlc_test/S10.png`): button 1 RENDERS** —
an 800×90 rounded rectangle, opaque blue-gray fill + white border, centered at
(560,435) on the navy background. No `graphics_processor.c:380` error. **Button 2
(560,555) is invisible**, exactly as expected: it is not the selected button and
its `normal_state` object is 0xFFFF.

**This is the first time our IG menu paints a visible button in software.** It
confirms Finding C end-to-end: the transparent palette (+ `defSel=0xFFFF`) was the
sole remaining render blocker once A (single-DS) and B (ICS-PTS anchor) were fixed.

### What it tells us for production (Phase-6)
- libbluray's auto-select fallback works (defSel=1 → button 1 selected & painted).
- **Only the selected button is visible** because every button's `normal_state`
  is 0xFFFF. To show *all* buttons at rest, production must give each button a
  **visible normal-state object** (not just selected/activated). The robust menu =
  visible normal objects for every button + opaque palette. defSel then only
  controls which one starts highlighted.
- Still untested on hardware: whether the LG honours `defSel` + paints the
  selected object the same way (Phase-2 noted the LG may differ on auto-select and
  DTS scheduling). S10 is now the strongest hardware-burn candidate.

Burn diagnostics ready in `~/Desktop/menu-tests/`: **S8** (two-DS, timing-fixed),
**S9** (single-DS, defSel=0xFFFF + transparent palette — blank by design), **S10**
(single-DS + opaque palette + defSel=1 — renders button 1 in VLC). Burn scripts
`burn_s8/s9/s10.sh` in `/tmp/vlc_test/`.

---

## S11 — visible normal-state (Jun 1 2026): FULL menu renders in VLC ✅✅

`tools/ig-toolkit/build_s11.js` = S10 + **a visible normal-state object on every
button** (the production menu pattern). S10 showed only the auto-selected button;
a real menu needs all buttons visible at rest with the selected one distinguished.

**Structure** — single DS1, 4 ODS objects (all 800×90 set-ods-rect):
`obj0` btn1 NORMAL (fill idx2 blue) · `obj1` btn1 SELECTED (fill idx3 highlight) ·
`obj2` btn2 NORMAL (fill idx2) · `obj3` btn2 SELECTED (fill idx3); border idx1
(white) on all. Button refs: btn1 `normal=0 sel/act=1`, btn2 `normal=2 sel/act=3`.
defSel=1, opaque palette, ICS PTS anchored to in_time, navy video — all from S10.

`mutate.js` has no "add ODS" op, so `expandToVisibleNormal()` does direct manifest
surgery: clone the ODS PES-unit template to go 2→4 objects, renumber object_ids
0..3, reorder DS1 to ICS·PDS·ODS0-3·END (dropping the empty unit Toast left after
its 3rd ODS was trimmed by set-button-count), re-fill via set-ods-rect, set button
state refs via set-state, chain the ODS decode PTS/DTS, re-thread the continuity
counter. **Verified in the built ISO before testing:** `displaySets=1`,
`ODS objIds=[0,1,2,3]`, `segRT=true`, `btn1 N0/S1/A1`, `btn2 N2/S3/A3`, `defSel=1`.

**VLC result (measured, fullscreen capture `/tmp/vlc_test/S11_fs.png`): BOTH
buttons render, visually distinct.** Sampled fill colours match the designed
palette to ±1 (BT.601):
- btn1 (560,435), SELECTED → RGB (132,142,189) — highlight idx3 (Y=140). ✔
- btn2 (560,555), NORMAL   → RGB (62,72,119)  — blue idx2 (Y=80). ✔
- white borders (idx1) on both; navy (26,27,47) background. No IG decoder errors.

**This is the full production menu pattern confirmed end-to-end in software.**
Every button is visible at rest; the selected one is highlighted; selection moves
between them (up/down nav refs already set by set-button-count). The complete
recipe for a working IG menu on our own video is now established:
1. single display set (Finding A);
2. ICS PTS = clip in_time (Finding B);
3. opaque palette + a real defaultSelectedButtonIdRef (Finding C / S10);
4. **a visible normal-state object per button** (S11) — the piece that makes a
   real multi-button menu legible without relying on auto-select.

### Remaining unknowns (hardware)
Still untested on the LG BP350: whether it (a) renders the selected+normal objects
like libbluray, (b) honours defSel, (c) is happy with the single-DS / in-mux IG
timing. S11 is now the lead hardware-burn candidate; S8/S9/S10 remain as the
A/B/C-isolating diagnostics. Burn scripts `burn_s8…s11.sh` in `/tmp/vlc_test/`.

### Productionising (for the encoder, beyond this research toolkit)
S11's `expandToVisibleNormal` is hand-rolled for 2 buttons but written N-extensibly
(2 ODS per button: normal=2*i, selected=2*i+1). Folding this pattern + the opaque
palette + in_time ICS anchoring + single-DS emission into `src/lib/menu-builder.js`
is the Phase-6 encoder work; real button *text* (vs solid rect fill) is the next
content step (render glyphs into the ODS bitmaps instead of set-ods-rect).

---

## Phase 6 — production encoder refactor (Jun 1 2026): parity with S11 ✅✅✅

Folded the S11 winning pattern into the shipping encoder so a disc built through
the **production code path** (`src/lib/menu-builder.js` `buildMenuDisplaySet` +
`src/lib/ig-encoder.js` `buildIGDisplaySet` + the production inject/patch chain)
renders identically to the hand-built S11.

### Code changes
**`src/lib/menu-builder.js`**
- `PALETTE`: all 4 entries now `T=255` (opaque). The 5th PDS byte is ALPHA
  (255=opaque, proven by S11); the old palette had the fill/border entries at
  `T=0` (transparent) → invisible buttons (Finding C). Fixed the inverted comment.
- Fill mapping flipped to the spec: `normal → idx 2`, `selected/activated → idx 3`
  (in both `renderButtonBitmap` and `renderButtonPixels`).
- `buildMenuDisplaySet`: **2N ODS** — for button i, `obj 2i` = NORMAL bitmap,
  `obj 2i+1` = SELECTED bitmap. Button refs `normal=2i, selected=2i+1,
  activated=2i+1`. `defaultSelectedButtonIdRef = 1` (was 0xFFFF). `windows: null`
  (drop WDS). Single epoch_start DS (unchanged). N parametric 1–9.
**`src/lib/ig-encoder.js` `buildIGDisplaySet`**
- ICS DTS lead `pts − 11664` → **`pts − 12012`** (Toast's measured PTS−DTS lead,
  matches S11). ODS decode_time=3 chain, PDS PTS=ICS DTS, END PTS=last ODS PTS —
  all unchanged.
- WDS now **optional**: emitted only when `windows` is non-empty. With no windows
  the order is `ICS · PDS · ODS×2N · END` (matches Toast/S11); callers that pass
  windows still get a WDS (so the lower-level unit tests are unaffected).

Finding B's "ICS PTS = clip in_time" was **already wired** in production:
`src/main.js` and `tools/menu_inject.js` both pass `pts: extractFirstVideoPTS(videoM2ts)`.
And production always emitted a single display set, so Finding A never applied to it.

### Tests — 291 pass (was 205)
`tests/ig-encoder.test.js` updated to assert the NEW pattern and expanded
(181 → 252): block 9/14/15 DTS constant 11664→12012; block 16 rewritten to assert
single ICS/PDS, **2N ODS**, no WDS, `defSel=1`, button refs `normal=2i / sel=2i+1
/ act=sel`, all palette `T=255`, ICS PES PTS == passed-in firstVideoPTS, and
parametric **N=1, 2, 5, 9** (object_ids cover 0..2N−1). `rewrite-video-pes-dts`
(24) and toolkit `selftest` (15) unchanged and green. No real regression was hidden
by the old assertions — every change was the test catching up to the correct pattern.

**Autoplay-default path untouched:** `buildMenuDisplaySet`/`buildIGDisplaySet`/
`PALETTE` are only reached under `if (useIGMenu && menusEnabled)` (src/main.js).
"Menus (Beta) off" builds the v1.11.0 autoplay disc with none of this code on the
path — byte-identical to v1.11.0.

### Production test disc — VLC verified at parity with S11
`tools/build_prod_test.js` drives the **production** encoder + patch chain (zero
ig-toolkit hand-build code for the IG) on a navy clip, assembled into the same
single-menu Toast tree as S11 → `~/Desktop/menu-tests/prod_v1.12.0_test.iso`.
Pre-flight re-extract: `displaySets=1, ODS objIds=[0,1,2,3], wds=false, btn1
N0/S1/A1, btn2 N2/S3/A3, defSel=1, ICS PTS=54000000=in_time, segRT=true`. The
production IG is byte-for-byte the same size as S11's (5076 B).

**VLC result (fullscreen capture `/tmp/vlc_test/prod_v1120.png`, viewed + sampled):**
both buttons render, distinct, no `graphics_processor` errors —
- btn1 (560,435) SELECTED (defSel=1) → RGB (0,37,121) = idx 3 dark blue ✔
- btn2 (560,555) NORMAL → RGB (201,100,0) = idx 2 orange ✔
Matches the expected result exactly (production keeps its own orange/blue palette,
so hues differ from S11's lavender/blue, but the structure/behaviour is identical).

**Text labels:** this machine's homebrew ffmpeg has **no `drawtext` filter (no
libfreetype)**, so `renderButtonBitmap` took its documented fallback to solid
fill + border (verified: bitmap histogram = border idx1 + fill idx2, no interior
text) — exactly S11's look. The drawtext text path is unchanged and renders the
label on any freetype-enabled ffmpeg.

### Verdict
The production encoder is at parity with the hand-built winning configuration.
v1.12.0 menu pipeline is ready for hardware burn. `prod_v1.12.0_test.iso` is the
production candidate; S8/S9/S10/S11 remain as the A/B/C/normal-state diagnostics.

---

## v1.13.0 — Templates (customizable / editable / saveable menus)

Branch `templates-pro`. Turns the single hardcoded "Classic" look into a
template system without changing the proven encoder. A template controls only
look-and-feel; every IG **encoder invariant** proven across S8–S11 (single
epoch_start display set, 2 ODS per button, no WDS, opaque palette, defSel=1,
ICS PTS = in_time) stays fixed in `ig-encoder.js` / `menu-builder.js`, so no
template choice can produce a stream the LG BP350 rejects.

### Schema (`src/lib/template.js`, schemaVersion 1)
```
{
  id, name, description, schemaVersion,
  palette: [ {id,Y,Cr,Cb,T} × 4 ],          // YCbCr-601; T MUST be 255 (opaque)
  button: {
    width, height, gap, border,             // pixels
    borderEntry,                            // palette id for the border
    normalFill:   { entry, rgb:[r,g,b], hex },
    selectedFill: { entry, rgb:[r,g,b], hex }
  },
  font: { file, sizeRatio, color },         // file relative to assets/fonts
  background: { type:'solid'|'image', color, imagePath, fit:'cover'|'contain'|'stretch' }
}
```
`validateTemplate()` enforces the structure and the encoder's hard requirements
(exactly 4 opaque palette entries; fill/border entries reference real palette
ids; geometry in range), so a malformed template fails fast at load.

### File layout
- **Built-in (read-only):** `src/assets/templates/{classic,minimal,theatrical}.json`.
  - *Classic* = the exact v1.12.0 look (navy bg, orange normal / blue selected).
  - *Minimal* = flat monochrome (dark-gray normal / light-gray selected, thin border).
  - *Theatrical* = `background.type:'image'`, gold/amber buttons, larger geometry.
- **User (editable, persistent):** `app.getPath('userData')/templates/*.json`,
  managed by `src/lib/template-store.js` (list / loadById / saveUser / duplicate /
  deleteUser; built-in ids are reserved and cannot be saved-over or deleted).

### Zero-regression guarantee
The default path (no template) and an explicit Classic template are
**byte-identical** to the v1.12.0 production encoder output — verified by golden
sha256 of the emitted IG for N=1/2/3/5 menus, on both the no-ffmpeg deterministic
path and the ffmpeg path (`tests/ig-encoder.test.js` §18). In `addMenuToDisc`,
`templateId === 'classic'` takes the literal v1.12.0 clip-generation code; only a
non-Classic template switches to `generateMenuVideo`.

### Image preprocessing decisions
`generateMenuVideo()` produces the menu background clip. Both solid and image
backgrounds encode with **one locked set of H.264/AC-3 params** (`MENU_ENCODE_ARGS`)
— byte-for-byte the v1.12.0 navy command: `libx264 / yuv420p / preset medium /
crf 28 / bf 2 / g 24`, giving **profile High, level 4.0, 1920×1080**. User images
can therefore never drift the codec profile into something the hardware rejects.
- Fit modes via ffmpeg `scale`+`crop`/`pad`: **cover** (default; fill+crop),
  **contain** (letterbox against `background.color`), **stretch** (distort).
- Alpha is flattened against `background.color` by compositing the scaled image
  over a color plate (`overlay`), which also supplies the letterbox color.
- Full-range JPEG (`yuvj420p`) sources are normalized to limited-range `yuv420p`
  in the filtergraph (`scale=out_range=tv`).
- `validateBackgroundImage()` rejects (via ffprobe) missing/unreadable files,
  dimensions > 8K on either axis, and animated formats (gif/apng/animated webp …).

### Test discs (VLC verified)
`tools/build_template_test.js` drives the production chain per template →
`~/Desktop/menu-tests/template_{classic,minimal,theatrical}_test.iso`. All three
pre-flight `displaySets=1, ODS=[0,1,2,3], wds=false, defSel=1, ICS PTS=in_time,
segRT=true` and render both buttons distinctly in VLC with the expected look;
theatrical confirms the **image-background** path end-to-end (visible gradient
plate behind gold buttons). Burn scripts: `/tmp/vlc_test/burn_template_*.sh`.

### Phase 4 — renderer UI (SHIPPED)
The template editor UI is now in the app (`src/renderer.js`, vanilla DOM matching
the existing patterns; styles in `src/styles.css`).
- **Reachable screen:** a dedicated **Templates** tab in the main tabbar (always
  visible). Two-pane layout: left = template list (built-in vs custom badges),
  right = editor.
- **Editor:** built-in templates are read-only (field display + live preview +
  "Duplicate to edit"); user templates are fully editable — Name; Palette (native
  color pickers per entry + an "Edit YCbCr" toggle, role labels derived from
  `button.*Entry`/`borderEntry`); Geometry (width/height/gap/border); Font (size-
  ratio slider + color; `MenuFont.ttf` only); Background (solid|image → color, or
  image picker + fit + flatten/letterbox color). A **live preview** (Normal +
  Selected button PNGs via `template-preview-button`, debounced 200 ms) re-renders
  on every edit; edits are validated first (`template-validate`) and the pane
  shows an inline error banner instead of rendering on failure.
- **Persistence toolbar:** Save / Save As… / Delete / Revert over the Phase-3 IPC
  (plus the Phase-4 `template-save-as`, which enforces name uniqueness across the
  built-in + user catalog). Delete uses a native confirm; Save re-reads from disk.
  Duplicate / Save As collect the name via an in-app modal (Electron has no
  `window.prompt`).
- **Build-flow wiring:** the **Project** tab's interactive-menu config has a
  **Template** dropdown (catalog-populated, default `classic`) bound to
  `igMenuConfig.templateId`, which flows to `addMenuToDisc`; absent/Classic stays
  byte-identical to v1.12.0.
- **Color math:** centralized in `src/lib/color.js` (YCbCr↔RGB), reused by the
  preview renderer and exposed to the UI via `window.discForge.color.*`.
- **CSP:** `index.html` gained `img-src 'self' data:` so the data-URI button
  previews load.

### NOT in v1.13.0 (explicitly deferred)
- **Custom fonts** beyond the bundled `MenuFont.ttf` (template `font.file`
  resolves within `assets/fonts`; a font-file picker is deferred to v1.14).
- **Animated / video backgrounds** — still images and solid colors only.

---

## v1.24.1 — FIRST HARDWARE RESULT + root cause (Jun 10 2026, measured not assumed)

**LG BP350 + Verbatim BD-RE, production single-title menu disc (v1.24.0):**
menu video + IG buttons RENDER (the S11 render recipe holds on hardware), but
the menu **looped every few seconds, never showed a selection highlight, and
ignored all remote input**. Top Menu showed the same non-interactive loop.

Root cause (byte-verified on real tsMuxeR output through the production patch
chain): `patchMplsForStill` wrote **still_mode=0x01 + still_time=0** — a
ZERO-SECOND **timed** still, not an infinite still. Per BD-ROM Part 3 §5.3.4
and libbluray `bluray.h` (`BLURAY_STILL_TIME=0x01`,
`BLURAY_STILL_INFINITE=0x02`), the v1.10.6 "fix" corrected the field OFFSET
(byte 30→31) but inverted the VALUE map. The play item therefore ended the
instant the 5s clip finished, the MovieObject loop (PLAY_PL 98 → 99 →
JUMP_OBJECT 2) restarted it each cycle, and the IG composition never survived
long enough to take input. VLC never caught it: libbluray fires still-mode
events to the host app and VLC ignores them, so software playback looks fine
with ANY still_mode value. **Fixed in v1.24.1: still_mode=0x02.**

Ruled out (decoded from the same production artifacts, all Toast-identical):
ICS composition/selection/user timeouts (0/0/0), the no-WDS layout, ICS
PTS=in_time with DTS lead 12012, ODS decode chain, PMT 0x91@0x1400 with valid
CRC, defSel=1, visible normal-state objects, self-referential 1-button nav.

New regression suite `tests/single-title-menu.test.js` (39 asserts) pins the
patch-chain and IG invariants end to end, including still_mode=0x02.

Remaining hardware-only candidate if looping persists after this fix: the
injected IG packets' ATS spacing (300 ticks apart ≈ a >100 Mbps instantaneous
burst, far above the 48 Mbps BD-ROM TS rate) — a strict read-buffer model
could object. One variable at a time: not changed in v1.24.1.
