---
name: cuthol-editing
description: >
  Build and change the Cuthol timeline: spine clips (append, trim, split,
  excise, remove, reorder, speed, transitions), lane cues and anchors, clip
  effects, colour grade, keyframe envelopes, cue sheets, undo and journal, and
  adopting outside edits. Load when cutting, trimming, rearranging, retiming or
  restructuring footage, titles, b-roll or cues.
---

# Timeline editing: spine, lanes, cues

Notation: `tool.action(args)` is an MCP call; the CLI form is
`cuthol <tool> <action-with-dashes> --arg-with-dashes value`.

## Media prep

- `workspace.init(dir, aspect, fps, title)` creates `cuthol.sequence.json` plus
  a `.cuthol/` cache folder. Aspect `9:16`, `16:9`, `1:1`, `4:5`. Default 9:16
  @ 30 fps — set it explicitly. `workspace.open(dir, verbose?)` selects an
  existing project and returns a compact summary (`verbose=true` for full
  tables). `workspace.backdrop(color="#RRGGBB")` sets the stage colour showing
  wherever nothing covers it (default `#0D0F12`); journaled.
- `library.ingest(files=[...], handle?)` probes and hashes files → `vid_XX`,
  `aud_XX`, `img_XX` (cached; re-ingesting is free). Variable-frame-rate
  sources are recorded and reported as `INFO [CUTHOL-G207]` during `verify`.
- Still images have no length of their own: hold one for any duration
  (`spine.append(asset="img_01", in="0s", out="34s")`); without an out point it
  defaults to 5 s. `library.detach_audio(handle="vid_01")` turns a video's
  audio into a separate `aud_XX` asset (e.g. to slip a voice ahead of its
  picture for a J-cut).
- Analyzers are cached by file content: `loudness`, `waveform`, `beats`,
  `scenes`, `subject`. They return digests; read slices with
  `library.query(handle, kind, range="2s..6s" | text="word", format?)`.
  MCP `format="compact"` on transcripts returns `i:word@sec` strings (up to 600
  words per page); on the CLI the same compact text comes from `--compact`.
- If you pre-cut media outside Cuthol before ingest, round every piece to whole
  frames for both picture and audio (`n = round(seconds * fps)`): video rounds
  to frames while audio keeps exact length, so the drift accumulates across
  pieces. Inside Cuthol, cuts are frame-exact and audio stays sample-locked.

## Spine (main storyline)

Clips are contiguous: `timeline position = sum of previous clip durations`. You
never set a clip's timeline start directly. Handles are never reused after
deletion. Clips shorter than 2 frames are rejected (G301); source ranges beyond
the media are rejected (G202).

| Action | Use |
|---|---|
| `append(asset, in?, out?)` | Add a source range at the end. `in`/`out` are **source** times. |
| `trim(clip, in?, out?)` | New source in/out. Later clips ripple. |
| `split(clip, at=[...], sequence_time?)` | Split at source times (or timeline times with `sequence_time=true`). Envelopes and anchored cues carry over to the right pieces. |
| `excise(clip, ranges, coord?)` | Remove `ranges=["a..b", …]` (**comma-separated**) and close the gaps. `coord`: `clip_local` (default), `source`, `sequence`. |
| `remove(clips, cascade_cues?)` | Delete clips; anchored cues go too, unless `cascade_cues=false` (they detach, keep absolute time). |
| `reorder(clip, before\|after\|index)` | Move a clip. |
| `speed(clip, rate?, ramp?, preserve_pitch?)` | Constant `rate` (0.1..16) or `ramp` (`["0s:1","2s:4"]`, source offsets; `["none"]` removes it); never both. Pitch is preserved by default. Ramps outside 0.5..2.0 warn G410. |
| `transition(clip, kind, duration, easing, params?)` | Outgoing transition into the next clip (`dissolve`, `fade`, `wipe_left`, `wipe_right`, `slide_up`, `zoom_in`, `none`, `ext:<ext>/<name>`). The blend overlaps the next clip's start. Details: `references/effects.md`. |
| `transform(clip, x, y, scale, scale_x, scale_y, rotation, opacity, fit, mirror_x, mirror_y, edge)` | Static placement; absolute (`"1.2"`) or relative (`"+=0.1"`) values. `fit`: `cover`, `contain`, `fill`. `edge`: `transparent` (default), `mirror`, `clamp`; spine only. |
| `mute / unmute(clip \| clips \| all_spine?)` | Mute one clip, a list, or the whole spine (omit `clip`); `muted=false` restores. |
| `reframe(…)` | Track one subject in wider footage onto a narrower stage (writes `scale_x` + a calm `x_pct` pan envelope). Details: `references/effects.md`. |
| `envelope(clip, param, points, easing, bezier?)` | Keyframes over the item's own time (0 = its start); spine clips and lane cues. Details: `references/effects.md`. |
| `grade(…)` / `fx_add / fx_set / fx_remove / fx_list` | Constant colour grade; per-clip effect chain (`ext:<ext>/<fx>` or raw `filter=`). Details: `references/effects.md`. |

## Lanes and cues

Default lanes (higher z is on top; negative = audio-only): `ln_captions`
(caption, z 30) · `ln_titles` (title, z 25) · `ln_motion` (composition, z 20) ·
`ln_broll` (broll, z 10) · `ln_vo` voiceover · `ln_sfx` · `ln_bgm` music.

- `lane.add_cue(lane, kind?, asset?, text?, at | anchor+offset, duration, in?,
  out?, rate?, preserve_pitch?, gain_db?, muted?, z_index?, size, color,
  max_width, x, y, scale, rotation?, opacity)`.
  Title: `lane.add_cue(lane="ln_titles", text="Heading", at="0.5s",
  duration="2.5s", y=-30, size=72)`.
  Music: `lane.add_cue(lane="ln_bgm", kind="music", asset="aud_02", at="0s",
  duration="14s", gain_db=-10)`.
  B-roll: `lane.add_cue(lane="ln_broll", kind="broll", asset="vid_03",
  anchor="sp_02", offset="1s", duration="2s")`.
- `x`/`y` are % of the stage from the centre (`y=-35` near the top). Keep text
  inside the title-safe area (G401 reports overflow in px). Default type scales
  with the stage: 9:16 titles `76 px`/`70`%, lane captions `64 px`/`70`%; 16:9
  titles `56 px`/`76`%, lane captions `44 px`/`76`% (auto-captions `42 px`/`80`%).
- **Anchor** cues that belong to a shot (`anchor="sp_02", offset="1s"`) or to
  another cue (`anchor="cue_01"`, e.g. an SFX that must follow a voiceover cut).
  Absolute (`at`) cues stay at their time. Clear with `anchor="none"`.
- `lane.update_cue(cue, …)` — placement (`x`, `y`, `scale`, `rotation`,
  `opacity`) accepts `+=`/`-=`; `rotation` is clockwise degrees on visual and
  typography cues alike.
- `lane.excise(cue, ranges, coord?, ripple?, across?)` cuts intervals out of a
  `voiceover`/`music`/`sfx`/video-`broll` cue in one atomic step: splits the
  cue, closes the gap, shifts later cues on the lane, re-anchors attached cues,
  shifts word timings. `across`: `lane` (default), `all_lanes`, `all`/`spine`
  (also cut the spine), `none`/`ripple=false` (leave a gap). Refused on
  `composition`/`title`/`caption`/still cues (G310).
- `rate` (0.1..16) on `ln_vo`/`ln_sfx`/`ln_bgm`/`ln_broll` cues rescales
  duration and projects word times at the new speed (`atempo` by default).
- Overlapping composition cues stack by lane `z_index`, then cue `z_index`,
  then cue order. `lane.remove_cue(cues=[...])`, `lane.lock(lane)`,
  `lane.unlock(lane)`, `lane.mute(lane)` / `lane.unmute(lane)` (muted lanes are
  skipped by render, preview, mix and captions). Cues running past the spine give G306.
- A cue is visible on exactly the frames with `start <= t < end` (the end instant starts the next frame and is never part of the cue).

## Undo, journal, outside edits

Every edit returns `Changed:` and `Undo (expect_rev N):`. Undo with
`workspace.undo(expect_rev=N)` (`steps=3`, `to=<rev>`, `dry_run=true` to
preview). Locked lanes block undo/redo touching them (G111) unless you pass
`allow_protected=[ids]`. Plus `workspace.redo`, `workspace.tag(name)`,
`workspace.journal`. Edits breaking G1–G3 roll back automatically.

Composition files and hand edits to `cuthol.sequence.json` are not revisions
until journaled: `changes_show` reports them (JSON-path diff for the project
file, e.g. `spine.clips[1].placement.opacity: 1 → 0.5`), then `changes_adopt`
journals them or `changes_revert` restores the journal state.

## Cue sheets (bulk edits)

`cue.export(file="edit.cues.json")` → edit the file → `cue.diff(file)` →
`cue.plan(file)` (dry run with verification) → `cue.apply(file)` (one journaled
transaction). Use this for many coordinated changes at once.

## Edit dictionary

Common edit terms and how each one is done in Cuthol (punch-in, Ken Burns,
speed ramp, J/L cut, cutaway, dip to black…) live in
`references/edit-dictionary.md` — check there before inventing a workaround.
