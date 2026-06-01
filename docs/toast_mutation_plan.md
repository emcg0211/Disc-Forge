# Toast-mutation bisection plan (Phase 4)

Goal: find the **hardware-critical constraint** that stops our IG menu buttons
from rendering on the LG BP350, by starting from Toast's known-good disc and
mutating it **one dimension at a time** toward our content. The step that breaks
button rendering identifies the constraint.

Built by `tools/ig-toolkit/build_mutation_discs.js`. Reproduce with:

```bash
node tools/ig-toolkit/build_mutation_discs.js
```

## Design decisions

- **Mutate DS1, keep DS0 as an in-disc control.** Toast's menu clip 01200.m2ts
  has two epoch-start display sets: **DS0** (1 button) and **DS1** (3 buttons),
  shown via the menu playlist's two PlayItems. We mutate **DS1** progressively
  and leave **DS0 completely untouched**. On every candidate disc, DS0 is
  byte-for-byte Toast. So if a mutated DS1 stops rendering while DS0 still
  renders **on the same disc, same player, same session**, the mutation we just
  applied is the culprit — an unambiguous, self-controlled signal.

- **Full Toast disc, only the menu m2ts swapped.** Each ISO contains Toast's
  complete BDMV (incl. the 583 MB main feature `00001.m2ts`, `index.bdmv`,
  `MovieObject.bdmv`, `BACKUP/`, `META/`). Only `STREAM/01200.m2ts` changes
  (plus `00002.*` at S7). This keeps the boot path identical to Toast so S0 is a
  true sanity gate.

- **UDF 2.50 filesystem via `hdiutil makehybrid -udf`.** Standalone BD players
  require UDF. We verified Toast's ISO carries UDF descriptors
  (`NSR03`/`*UDF`/`BEA01`/`TEA01`) and that `makehybrid` reproduces them. (Note:
  on this machine `xorriso -as mkisofs -udf` silently emits an **ISO9660-only**
  image with no UDF — it must not be used for burnable BD test discs.)

- **"Our content" parameters** come from `src/lib/menu-builder.js`:
  buttons 800×90, 30 px gap, centered; 4-entry palette (0 transparent, 1 white,
  2 orange-yellow `Y112 Cr184 Cb42`, 3 dark-slate-blue `Y45 Cr103 Cb171`);
  `PLAY_PL(episode)` nav; default 2 episodes. No text font is available in this
  environment (this ffmpeg lacks `drawtext`), so our button bitmap is a solid
  fill + 3 px white border — exactly what `menu-builder.renderButtonPixels`
  emits as the fallback. The bisection tests structure, not legibility.

## Output (all on `~/Desktop/`)

| ISO | menu m2ts size | DS1 state after this step |
|---|---|---|
| `toast_S0.iso` | 325632 B | unchanged (= Toast) |
| `toast_S1.iso` | 325056 B | our bitmaps, Toast dims/pos/palette/count |
| `toast_S2.iso` | 327552 B | + dims 800×90 |
| `toast_S3.iso` | 327552 B | + centered positions (N=3) |
| `toast_S4.iso` | 326208 B | + our 4-entry palette |
| `toast_S5.iso` | 325248 B | + 2 buttons (N=2 layout, ODS trimmed) |
| `toast_S6.iso` | 325056 B | + PLAY_PL(1)/PLAY_PL(2) nav |
| `toast_S7.iso` | 325056 B | + disc-level 00002 playlist/clipinf |

Each `toast_S{N}.diff.txt` is `diff.js` of step N's menu m2ts vs step N−1's.
DS0 never appears in any diff (it is the untouched control).

## Per-step exact byte-level differences

All deltas below are confined to **DS1**. DS0, video PID 0x1011, PAT/PMT and all
PES timing of unchanged units are byte-identical to the prior step.

### S0 — Toast unmodified  **[GATE — burn first]**
`extract → repack → makehybrid`. Menu m2ts is **byte-identical to Toast's
original 01200.m2ts** (verified `cmp`-equal). `diff.js`: `identical=150,
content-diff=0, structural-diff=0`.
**Must render buttons identically to the retail Toast disc.** If S0 does not,
the repackaging/filesystem pipeline is the problem and S1–S7 are uninterpretable.

### S1 — our button bitmaps (Toast dimensions preserved)
The 3 DS1 ODS keep their sizes (16×16, 16×17, 79×46) but their pixel data is
replaced with our solid-fill+border rectangle (palette idx 2 fill, idx 1 border).
- `DS1 ODS#0` `dataLen 164→144`, `rle` replaced (Toast highlight glyph → flat rect)
- `DS1 ODS#1` `dataLen 183→155`, `rle` replaced
- `DS1 ODS#2` `dataLen 638→520`, `rle` replaced
- 6 content-diffs, 0 structural. Menu m2ts 325632→325056 B.
- **Tests:** does the LG render *our* RLE pixel content in Toast's exact object
  envelope? (If S0 renders and S1 doesn't, the blocker is in our RLE encoding.)

### S2 — our dimensions (800×90)
Each DS1 ODS is resized to 800×90 and re-RLE'd (still solid rect).
- `DS1 ODS#0/#1/#2` `dims →800x90`, `dataLen` and `rle` change (9 content-diffs).
- 0 structural. Menu m2ts 325056→327552 B (objects now larger).
- **Tests the prime suspect:** our objects are ~50× Toast's pixel area. If
  rendering breaks here, the LG has an **object-size / decode-time / window**
  limit that Toast's tiny highlights never hit. *(Toast's text lives in the
  background video; its IG objects are small. Ours carry the whole button.)*

### S3 — our positions (centered, N=3)
- `bog[0].btn[0].pos 237,289 → 560,375`
- `bog[1].btn[0].pos 237,358 → 560,495`
- `bog[2].btn[0].pos 279,930 → 560,615`
- 3 content-diffs, 0 structural, same m2ts size (in-place refill).
- **Tests:** button-rectangle placement constraints (no WDS present — Toast has
  none either; buttons paint directly).

### S4 — our palette (4 entries)
- `DS1 PDS` `entries 255 → 4` (1 structural: entry count; 1 content: entry table).
- ODS pixels re-expressed against our palette indices (already idx 1/2, so RLE
  unchanged). Same positions/dims. Menu m2ts 327552→326208 B.
- **Tests:** does the LG require a fully-populated 256-entry palette, or accept a
  sparse 4-entry PDS? (Decoders sometimes pre-clear the palette and only
  overwrite supplied entries.)

### S5 — our button count (3 → 2)
- `page0.numBogs 3 → 2` (structural)
- `bog[2]` and its button removed (structural); the 3rd ODS object removed, so
  DS1 goes from 3 ODS to 2 (the `ODS/END` segment-shift shows in the diff).
- remaining 2 buttons re-laid-out to the N=2 centered positions
  (`560,435` and `560,555`) with circular up/down neighbors.
- 6 content + 5 structural. Menu m2ts 326208→325248 B.
- **Tests:** button/object count handling and the multi-BOG page.

### S6 — our nav commands
- each button's `navCmds` replaced: Toast's 2-command `SET GPR (0x50400001)` +
  `JUMP_OBJECT (0x21800000)` → our single `PLAY_PL` (`0x22800000`):
  `btn0 → PLAY_PL(1)`, `btn1 → PLAY_PL(2)` (`navCount 2→1` each).
- 4 content + 2 structural. Menu m2ts 325248→325056 B.
- **Tests:** nav commands should not affect *rendering* (they fire on
  activation). If S6 breaks rendering, the LG validates command structure at
  composition load. *(At this step PLAY_PL(2) has no target yet — fixed in S7.)*

### S7 — our playlist/clipinf structure
- Disc-level only (IG byte-identical to S6 → `diff.txt` shows no IG change):
  adds `PLAYLIST/00002.mpls` and `CLIPINF/00002.clpi` (copies of Toast's `00001`)
  so the S6 `PLAY_PL(2)` resolves.
- **Tests:** whether adding playlists/clip-info perturbs menu loading. The
  m2ts-level diff is empty by design; the change is in the BDMV tree.

## S8 — our video content  *(specified; build deferred)*

S8 = "S7 + our menu background video" (navy `0x1a1a2e` 1920×1080 still instead of
Toast's). This is intentionally **not** auto-built yet, because it cannot be done
without re-muxing the menu clip's video and **re-timing the IG** to the new
video's PTS — which reintroduces exactly the from-scratch PTS/DTS/still-mode/PMT
integration that the bisection is trying to isolate. Building it before we know
which of S0–S7 renders would conflate "our video" with "our mux/timing/CLPI/MPLS"
and waste a burn.

Recipe to build once S0–S7 hardware results are in:
1. `ffmpeg` navy still + silent AC3 → MKV (B-frames) → `tsMuxeR` → menu clip
   (mirror `tools/menu_inject.js` / `menu-builder.js`).
2. `extractFirstVideoPTS` of the new clip.
3. Shift the S7 DS1 (and DS0) PES PTS/DTS by `newPTS − oldFirstDTS`, preserving
   the ICS `PTS−DTS=12012` lead and the ODS decode chain (toolkit can re-stamp
   `unit.pes.pts/dts` and re-encode).
4. `injectIGIntoM2ts` + `patchPmtForIG`; `patchClpiForIG` + `patchMplsForIG` +
   still on the new clip's CLPI/MPLS.
5. `makehybrid` ISO.

This is essentially our current encoder path carrying the **Toast-derived IG**,
so it is the right final convergence test — but only meaningful after the IG-only
steps (S0–S7) have localized the rendering boundary.

## Suggested burn order

1. **S0** (gate). Confirm buttons render like the retail Toast disc.
2. **S1, S2** — the highest-value cut: small-Toast-glyph vs our content, and
   Toast dims vs our 800×90. The object-size jump at S2 is the prime suspect.
3. Then **S3 → S7** as budget allows; on each, compare the (mutated) DS1 menu
   against the untouched DS0 menu on the same disc.

Report per disc: does DS1 show buttons? does DS0 still show its button? any
load/white-screen failure? That tells us the exact step — and therefore the
exact IG dimension — the LG firmware rejects.
