# libbluray IG decoder analysis (Phase 2)

Source: `code.videolan.org/videolan/libbluray` @ `4dfb9b0` (cloned to
`/tmp/libbluray`). Files read in full or in the relevant parts:
`decoders/graphics_controller.c` (2102 lines), `graphics_processor.c` (638),
`ig_decode.c` (361), `m2ts_filter.c` (320), `rle.c` (207), `hdmv_pids.h`,
`ig.h`; plus the trigger sites in `bluray.c` and `hdmv/hdmv_vm.c`.

libbluray is the IG decoder inside VLC. It accepts **every** disc we and Toast
produce, so it is a poor hardware proxy. The value of reading it is the inverse:
**everywhere libbluray is lax, ignores a field, or comments "not implemented" is
a place where a strict hardware demuxer (LG BP350) can diverge.** Those are the
candidate causes of "navy background, no buttons." Cross-referenced against the
Phase-1 Toast forensics and the Phase-4 bisection throughout.

---

## TL;DR — ranked hardware-divergence candidates

1. **Invisible normal-state + `default_selected_button_id_ref = 0xFFFF`.**
   libbluray's `_find_selected_button_id()` **falls back to "first valid button"**
   when the default is `0xFFFF`, so it always auto-selects one button and renders
   it. A button is drawn *visible* only in SELECTED/ACTIVATED state; NORMAL is
   drawn too but our normal object is `0xFFFF` (nothing). **If the LG honors
   `0xFFFF` literally (no auto-selection), every button renders NORMAL = nothing
   = blank menu.** Toast uses the same invisible-normal model **but its button
   text lives in the background video**, so the menu looks populated regardless.
   Our text is *in the IG objects* → with no selection, nothing shows.
   → **Strongest single explanation for "navy, no buttons."**

2. **DTS/STC scheduling is skipped in software, enforced in hardware.**
   In-mux IG is decoded with `gc_decode_ts(..., stc = -1)` (`bluray.c:2109`), so
   the DTS gate in `graphics_processor_decode_pes` (`if (stc >= 0 && dts > stc)`)
   is bypassed — libbluray inits the menu the instant a complete DS is buffered,
   **ignoring all PTS/DTS**. A hardware transport demux almost certainly *does*
   schedule decode by DTS. So every DTS fix from v1.10.10–v1.10.16 (the 12012
   ICS lead, ODS decode chains) is invisible to VLC and only testable on the LG.

3. **`composition_timeout_pts` / `selection_timeout_pts` are "not implemented".**
   `graphics_controller.c:883-887` logs both as TODO and ignores them. We send
   `0`. Hardware likely uses `composition_timeout_pts` to decide *when* the
   composition appears/expires; `=0` may read as "display immediately" (good) or
   "already expired" (bad — v1.10.8 saw a hardware load-rejection when we set it
   to the video PTS). Toast sends `0` too, so `0` is the safe value — but this is
   firmware-interpreted and untestable in VLC.

4. **Object size / decode-time.** libbluray's RLE decoder grows its element
   buffer dynamically (`rle.c:39` "realloc to 2x") — no object-size limit. Real
   hardware has fixed graphics-decode buffers and a bounded object decode rate.
   Toast's IG objects are tiny highlight glyphs (16×16…79×46); ours are 800×90
   (~50× the area). This is the **Phase-4 S2** hypothesis: an object-size or
   per-frame decode-time ceiling the LG enforces and Toast never approaches.

---

## 1. The button selection → render state machine (the key path)

`_render_page()` (`graphics_controller.c:1379`) iterates the page's BOGs and, for
each, picks the **enabled** button (`gc->bog_data[ii].enabled_button`) then draws
it in exactly one state:

```c
if      (button->id == activated_button_id) _render_button(... BTN_ACTIVATED ...);
else if (button->id == selected_button_id)  _render_button(... BTN_SELECTED ...);   // PSR10
else                                         _render_button(... BTN_NORMAL ...);
```

`_render_button()` → `_find_object_for_button()` (`:195`) returns the object for
that state's `*_start/_end_object_id_ref`; if it is `0xFFFF`, `_find_object()`
returns NULL and the button **renders nothing** (`:1267` "object not found" →
`_clear_bog_area`). So:

> **A button is only visible if (a) it is the selected/activated button and its
> selected/activated object exists, OR (b) its NORMAL object exists.**

Our v1.10.19 model: `normal = 0xFFFF` (invisible), `selected = activated = obj i`.
→ Only the *selected* button is ever visible. Every other button is blank.

### How the selected button is chosen — and the lax fallback
`GC_CTRL_INIT_MENU` → `_select_page(0,0)` (`:698`) → `_reset_page_state` (sets
each BOG's `enabled_button = default_valid_button_id_ref`) → `_find_selected_button_id`
(`:292`) → `_select_button` writes `PSR10`.

`_find_selected_button_id()` implements spec §5.9.8.3 in three steps:
1. use `page->default_selected_button_id_ref` **if valid and enabled**;
2. else keep the current `PSR10` if still valid;
3. **else return the first valid enabled button.**

With our `default_selected_button_id_ref = 0xFFFF`, step 1 fails (`_find_button_page`
can't find button `0xFFFF`), step 2 is `0xFFFF` (invalid), and **step 3 picks the
first button anyway**. So *in software* one button is always selected and drawn.
The spec value `0xFFFF` means "no button selected." **A strict player may stop at
step 1/2 and leave `PSR10 = 0xFFFF` → no button selected → with invisible normal
state, the whole menu is blank.** Step 3 is libbluray being lenient.

**Implications for our encoder (Phase 6 candidates):**
- Set a real `default_selected_button_id_ref` (e.g. button 1) so a compliant
  player auto-selects and shows it; **and/or**
- Give buttons a **visible NORMAL state** (a real `normal_start_object`), so all
  buttons paint without any selection. This is the robust fix because our button
  *content* (text/fill) is in the IG, unlike Toast where it is in the video.
- The Phase-4 bisection tests this implicitly: S1–S7 sit on **Toast's** menu
  video (which already contains Toast's text), so the invisible-normal model
  still looks populated there. Only **S8** (our blank navy video) would expose
  "no visible normal + no video text." If S1–S7 render but S8 shows no buttons,
  this hypothesis is confirmed.

---

## 2. What makes a display set "complete" (and what gets dropped)

`graphics_processor.c`:
- Segments arriving **before** the ICS are dropped as "orphan"
  (`:209/231/278/498`): WDS/ODS/PDS/END with no preceding composition → ignored.
  → **Segment order matters: ICS must come first.** Our encoder and Toast both
  emit `ICS → PDS → (WDS) → ODS… → END`. ✔
- `_decode_ics` (`:377`) sets `s->decoding = 1`; `END` (`:495`) sets
  `s->complete = 1` **only if `s->decoding`** — a stray END is an orphan. So a DS
  needs a matching ICS…END bracket.
- `_check_epoch_start` (`:326`): a composition with `state == 2` (epoch_start)
  **drops all cached palettes/windows/objects** and starts fresh. Toast's two DS
  are both `state == 2` → independent epochs (matches Phase-1 forensics). Our
  menu is `state == 2` too. ✔
- `_decode_interactive_composition` (`ig_decode.c:280`):
  **`if (data_len != buf_len) return 0;`** — the IC `data_len` field must equal
  the remaining segment bytes **exactly**, or the whole composition is rejected.
  Our toolkit verifies this (segment round-trip), and our encoder computes it
  from the serialized body. Hardware very likely enforces this identically — a
  single stray/missing byte here = silent total failure (this is the class of
  bug v1.10.7/v1.10.8 fixed: spurious byte → `num_pages = 0`).

---

## 3. Timing: PTS/DTS, the STC gate, and the seek filter

- **In-mux decode ignores DTS (software).** `bluray.c:2108`:
  ```c
  if (gc_decode_ts(bd->graphics_controller, st->ig_pid, bd->int_buf, 1, -1) > 0)
      _run_gc(bd, GC_CTRL_INIT_MENU, 0);
  ```
  `stc = -1` ⇒ the gate `if (stc >= 0 && (*p)->dts > stc) return 0;`
  (`graphics_processor.c:540`) never fires. libbluray buffers segments and
  fires `INIT_MENU` as soon as a DS completes. **Hardware schedules by DTS** in
  its transport demux, so our DTS values (and the ICS `PTS−DTS = 12012` lead, the
  ODS decode chain) are a *hardware-only* variable. This is why VLC renders our
  menus and the LG may not, independent of everything else.
- **Sanity clamp:** even when `stc >= 0`, a segment with `dts − stc ≥ 30 s`
  (`MAX_STC_DTS_DIFF`) is decoded anyway — guards against an unset STC.
- **Multi-fragment ODS** must be fully joined (`_join_segment_fragments`,
  `:552`) before decode. Our objects are single-fragment (`first==last==1`). ✔
- **Seek/clip-window filter** (`m2ts_filter.c`): when seeking into a clip,
  IG packets with `pts < in_pts` are wiped until the first `pts ≥ in_pts`
  (`:222`); the comment at `:235` notes PG/IG may legitimately carry timestamps
  before `in_time` **except composition segments**. ⇒ the **ICS PTS must be
  ≥ the clip `in_time`**, which is exactly why the encoder stamps the IG PTS to
  the first video PTS (`extractFirstVideoPTS`). If ICS PTS < in_time, the menu is
  silently filtered out. Toast's ICS PTS (120030/165075) are ≥ its PlayItem
  in_times. ✔

---

## 4. PID routing, palette, windows, frame rate — smaller checks

- **IG PID range** (`hdmv_pids.h:48,66`): `IS_HDMV_PID_IG` ⇔ `0x1400–0x141F`.
  Using `0x1200` (PG range) routes data to the PG decoder → no IG. We use
  `0x1400`; Toast uses `0x1400`. ✔ (Also requires `st->ig_pid > 0`, i.e. the IG
  declared in the MPLS STN_table / CLPI — and, for hardware, in the PMT.)
- **Palette resolution** (`_render_page:1433`): the page's `palette_id_ref` must
  match a decoded PDS or the page is rejected (`return -1`). libbluray does *not*
  require a full 256-entry palette — a sparse PDS is fine **in software**. Whether
  the LG pre-clears and accepts a sparse 4-entry PDS is the **Phase-4 S4**
  question. (Toast ships a 255-entry PDS.)
- **No WDS is fine for IG.** Nothing in the IG render path consults WDS; windows
  are used by the PG (subtitle) path and by IG *effects* only. Buttons are
  painted directly at `button->x_pos/y_pos` over the object size. Matches Toast
  (no WDS at all) and supports dropping WDS from our encoder. The earlier
  "WDS present (v1.10.17 baseline)" was not load-bearing for rendering.
- **Frame-rate code** (`_reset_page_state:432`) indexes a `frame_interval[8]`
  table by `video_descriptor.frame_rate` (1–7) for *animation* timing only;
  `0` yields interval 0 (no animation). Non-animated menus are unaffected.
  Toast uses `0x40` (code 4 = 29.97); ours uses `0x20` (code 2 = 24).
- **`num_pages`/`num_bogs`/`num_buttons`** are `uint8`/`uint8`/`uint8`
  (`MAX_NUM_BOGS = 256`); no small ceiling. Our 2–3 buttons are far under any
  limit. RLE buffer grows dynamically — again, no software size cap.

---

## 5. TopMenu vs PopupMenu vs IG-in-playback

- **IG-in-playback (our case and Toast):** `ui_model = 0` (always-on). Triggered
  by `bluray.c:2108-2112` whenever a complete in-mux IG DS is decoded during
  normal playback → `GC_CTRL_INIT_MENU` → `_select_page` + `_render_page`. No UO
  / popup state required; the menu paints immediately on DS completion.
- **PopupMenu:** `ui_model = 1`. `_render_page` (`:1394`) returns early and keeps
  the OSD closed unless `gc->popup_visible`; toggled by `GC_CTRL_POPUP` /
  `INSN_POPUP_ON/OFF` from the HDMV VM. Not our model (we and Toast are always-on).
- **TopMenu / `menu_call`:** `bd_menu_call` (`bluray.c:3699`) jumps to the
  top-menu title (driven by the HDMV VM / MovieObject), which then plays its IG
  clip and hits the same `INIT_MENU` path. Subject to the `menu_call` UO mask.
  Our autoplay disc and Toast reach the menu via normal playlist playback, not a
  separate top-menu title.

---

## 6. Concrete recommendations carried into Phase 6

In rough priority (validate against the S0–S8 burn results):

1. **Make buttons visible without selection.** Either set a real
   `default_selected_button_id_ref` *and* keep selected-only objects, or (more
   robustly) give each button a **visible normal-state object**. Our content is
   in the IG, so we cannot rely on Toast's "text-in-video + invisible-IG" trick.
2. **Treat DTS/STC scheduling as a hardware-only variable.** It can't be
   validated in VLC. Keep the DTS conventions that match Toast byte-for-byte
   (the toolkit already reproduces Toast's exact PES framing, incl. the `0x0`
   DTS marker nibble) rather than spec-theoretical values.
3. **Keep `composition_timeout_pts = 0`** (Toast's value); never set it to the
   video PTS.
4. **If S2 breaks rendering, cap object size** — move button *text* into the
   background video (Toast's architecture) and use small IG highlight objects,
   instead of 800×90 text-bearing objects.
5. **Preserve `data_len == buf_len` exactly** and **ICS-first segment order** —
   non-negotiable; a strict demux rejects the whole composition otherwise.
6. **WDS is optional** for IG button rendering — safe to omit (matches Toast).

These map directly onto the Phase-4 discs: S2↔(4), S4↔palette sparsity, S8↔(1).
The burn results will tell us which constraint is the real blocker.
