# Editing: spine, lanes, time, undo

Notation: `tool.action(args)` is an MCP call; the CLI form is `cuthol <tool> <action-with-dashes> --arg-with-dashes value`.

## Projects

- `workspace.init(dir, aspect, fps, title)` creates `cuthol.sequence.json` plus a `.cuthol/` cache folder. Aspect `9:16` (1080x1920), `16:9` (1920x1080), `1:1`, `4:5`. Default 9:16 @ 30 fps — set it explicitly.
- `workspace.open(dir)` selects an existing project for the MCP session.
- `workspace.backdrop(color="#RRGGBB")` (CLI `workspace backdrop --color "#RRGGBB"`) sets the stage backdrop colour (default `#0D0F12`): the base of every frame wherever no clip or cue covers it. Journaled; `Changed:` shows `stage.backdrop.color=<new> (was <old>)` and undo restores the old colour. A value that is not 6 hex digits is refused (SYS07).
- Relative paths in MCP arguments (`files`, `comp_dir`, `out`, `file`) resolve against the project folder. On the CLI, relative file paths (e.g. `library ingest <files...>`) resolve against the current working directory.

## Library

- `library.ingest(files=[...], handle?)` probes and hashes files. Handles: `vid_XX`, `aud_XX`, `img_XX`. Re-ingesting the same file is cached. Variable-frame-rate (VFR) video sources are recorded (`probe.is_vfr`, `r_frame_rate`, `avg_frame_rate`) and reported as `INFO [CUTHOL-G207]` during `verify`.
- Still images (`img_XX`) have no length of their own: hold one on the spine or a lane for any duration (`spine.append(asset="img_01", in="0s", out="34s")`). Without an out point it defaults to 5 s. For a video that is all motion graphics you do not need a background clip at all: leave the spine empty (see *Graphics-only projects*).
- `library.detach_audio(handle="vid_01")` turns a video's audio into a separate `aud_XX` asset (for example to use a recording as music).
- Analyzers are cached by file content: `loudness`, `waveform` (silences, 3-band spectrum, optional PNG), `beats` (regular tempo/phase `grid` + spectral-flux `onsets`), `scenes` (cut points), `subject` (horizontal/vertical subject trajectory and confidence). They return digests; read slices with `library.query(handle, kind, range="2s..6s" | text="word", format="default"|"compact", limit, cursor)`. For transcripts, `format="compact"` returns `i:word@sec` strings (up to 600 words per page by default) so an entire multi-minute narration fits in one call.

## Spine (main storyline)

Clips are contiguous. `timeline position = sum of previous clip durations`. You never set a clip's timeline start directly. Once a handle (`sp_XX`, `cue_XX`, `mk_XX`, `vo_XX`) has been allocated in a project, deleting that item never re-issues its ID to a later item (`meta.handle_counters`, preserved across undo/redo).

| Action | Use |
|---|---|
| `append(asset, in?, out?)` | Add a source range at the end. `in`/`out` are **source** times of the asset. |
| `trim(clip, in?, out?)` | New source in/out. Later clips ripple. |
| `split(clip, at=[...], sequence_time?)` | Split at source times (or timeline times with `sequence_time=true`). Envelopes and anchored cues are carried over to the right pieces. |
| `excise(clip, ranges=["a..b", …], coord?)` | Remove ranges and close the gaps. `coord`: `clip_local` (default, 0 = clip start), `source`, `sequence`. Use this for cutting out mistakes or pauses by hand. |
| `remove(clips=[...], cascade_cues?)` | Delete clips; cues anchored to them are deleted too, unless `cascade_cues=false` (then they are detached and keep their current absolute time). |
| `reorder(clip, before|after|index)` | Move a clip. |
| `speed(clip, rate, preserve_pitch?)` | 0.5 = slow motion, 2 = double speed. The clip's timeline duration changes; transcripts stay correct. |
| `transition(clip, kind, duration, easing)` | Outgoing transition into the next clip: `dissolve`, `fade`, `wipe_left`, `wipe_right`, `slide_up`, `zoom_in`, `none`. Duration ≤ half of the shorter neighbouring clip (G303). The blend happens after the cut point (it overlaps the start of the next clip). |
| `transform(clip, x, y, scale, scale_x, scale_y, rotation, opacity, fit, mirror_x, mirror_y)` | Static placement. Values are absolute (`"1.2"`) or relative (`"+=0.1"`, `"-=5"`). `fit`: `cover` (fill, crop), `contain` (letterbox), `fill` (stretch). |
| `reframe(clip | clips | all_spine?, mode?, points?, replace?, deadband?, x?, fps?, dry_run?)` | Track a single speaker/subject in wider footage (e.g. 16:9 on a 9:16 stage) and write `placement.scale_x` + a calm `placement.x_pct` pan envelope (or manual focal points). |
| `envelope(clip, param, points=["0ms:1.0","4s:1.15"], easing)` | Keyframes over the item's own time (0 = its start). Works on spine clips and lane cues. Params: `placement.x_pct`, `placement.y_pct`, `placement.scale_x`, `placement.scale_y`, `placement.rotation_deg`, `placement.opacity`, `audio_chain.gain_db`. A slow zoom needs both `scale_x` and `scale_y`. |

Clips shorter than 2 frames are rejected (G301). Source ranges beyond the media are rejected (G202).

## Reframing horizontal footage for vertical stages (`spine.reframe`)

When a wider source video (e.g. 16:9) is placed on a narrower stage (e.g. 9:16 vertical, where `asset_aspect / stage_aspect > 1.03`), the default centre crop (`fit="cover"`, `x=0`) only shows roughly the middle third (`~34%..66%`) of the horizontal frame and can cut off a speaker who stands or moves to the left or right.

- **When to use:** Call `spine(action="reframe", clip="sp_01")` (or omit `clip` / pass `all_spine=true` for all spine clips) when reframing horizontal talking-head or single-subject clips into a vertical `9:16` (or `1:1` / `4:5`) project. On a `16:9` stage (or when the subject stays centered within `deadband`), it leaves `scale_x=1, x_pct=0` and writes zero unnecessary pan keyframes.
- **What it writes:** Sets `placement.fit_mode="cover"`, `placement.scale_x = asset_aspect / stage_aspect` (e.g. `~3.1605` for 16:9 on 9:16, `scale_y=1`), `treatments.reframe` (`focal_points`), and a smooth `placement.x_pct` envelope (`ease_in_out` ramps between stationary plateaus controlled by hysteresis `deadband`, default `3.2`%). Later `spine.split`, `spine.excise` and `spine.speed` edits automatically slice and rescale both `treatments.reframe.focal_points` and the `placement.x_pct` envelope.
- **Modes:**
  - `mode="subject_track"` (default): Automatically tracks the horizontal centre (`center_x_pct`, `0..100`) of the subject.
  - `mode="center_lock"`: Locks a static horizontal crop at `x` (`0..100` in source frame width, default `50`).
  - `mode="off"`: Resets reframing (`scale_x=1`, `x_pct=0`) and removes the `placement.x_pct` envelope.
- **Verify with `monitor.frame`:** Over MCP, `spine.reframe` returns a compact per-clip summary (`Reframe summary`: confidence `mean_confidence`/`min_confidence`, pan range `pan_x_pct_range` & `center_x_pct_range`, and stationary `plateaus` count). Always inspect the reframed clip with `monitor.frame(at=…)` (or `monitor.sheet`) — especially around pan transitions and any `low_confidence_ranges_ms` reported — to confirm the speaker's face/head is centered and not clipped by the frame edge.
- **Manual correction (`points`, `replace`):**
  - Each manual point is `offset:center_x_pct`, where `offset` is clip-local time (`0ms` = clip start) and `center_x_pct` is the subject's horizontal position in the source video (`0` = left edge, `50` = centre, `100` = right edge; Cuthol converts this to `placement.x_pct = (50 - center_x_pct) * scale_x` clamped to `±max_pan_x_pct`).
  - **Patch auto track (`replace=false`, default):** `spine(action="reframe", clip="sp_01", points=["0ms:50", "40s:64", "78.6s:55"])` replaces auto-detected focal points within `±1.2s` of each manual timestamp while keeping the rest of the tracked trajectory.
  - **Full manual override (`replace=true`):** `spine(action="reframe", clip="sp_01", points=["0ms:55", "78.6s:55"], replace=true)` ignores automatic tracking completely and builds the `placement.x_pct` envelope solely from your `points`.
- **Limits (no ML / single subject only):**
  - There is **no neural face/person detector**. Tracking uses a deterministic, low-resolution (`160px` wide @ `4 fps`, or `8 fps` for clips `<= 4s`) signal pipeline: ITU-R BT.601 YCbCr/RGB skin-cluster + upper-cranial head silhouette detection (`face_skin`), moving foreground activity (`foreground_motion`), and border-contrast saliency (`static_saliency`).
  - It assumes a **single primary subject**. Multiple people on screen, two-shots, skin-coloured background clutter, or heavy lighting shifts can pull the crop toward the wrong region. Check `mean_confidence`, `min_confidence` and `low_confidence_ranges_ms`, look at frames with `monitor.frame`, and pin or replace bad spans with `points` / `replace=true` or `mode="center_lock"`.
  - Reframing is **horizontal only** (`scale_x` + `placement.x_pct`, `scale_y=1`); it does not pan vertically.

## Lanes and cues

Default lanes (z order: higher is on top; negative = audio-only lanes under the picture):

| Lane | Kind | z | Typical content |
|---|---|---|---|
| `ln_captions` | caption | 30 | generated by `speech.captions` |
| `ln_titles` | title | 25 | text titles |
| `ln_motion` | composition | 20 | HyperFrames overlays |
| `ln_broll` | broll | 10 | cutaway footage / images over the spine |
| `ln_vo` | voiceover | 0 | narration audio |
| `ln_sfx` | sfx | −5 | sound effects |
| `ln_bgm` | music | −10 | music bed |

- `lane.add_cue(lane, kind?, asset?, text?, at | anchor+offset, duration, in?, out?, rate?, preserve_pitch?, z_index?, size, color, max_width, x, y, scale, rotation?, opacity)`.
  - Text title: `lane.add_cue(lane="ln_titles", text="Başlık", at="0.5s", duration="2.5s", y=-30, size=72)`.
  - Default typography sizes scale with stage orientation: on vertical `9:16` (`1080x1920`), titles default to `size=76` px (`max_width=70`%) and lane captions to `size=64` px (`max_width=70`%); on landscape `16:9` (`1920x1080`), titles default to `size=56` px (`max_width=76`%) and lane captions to `size=44` px (`max_width=76`%, auto-captions `42` px / `80`%).
  - Music bed: `lane.add_cue(lane="ln_bgm", kind="music", asset="aud_02", at="0s", duration="14s")`.
  - Voiceover: `lane.add_cue(lane="ln_vo", kind="voiceover", asset="aud_01", at="0.5s", duration=<asset length>, rate=1.0)`.
  - B-roll over a clip: `lane.add_cue(lane="ln_broll", kind="broll", asset="vid_03", anchor="sp_02", offset="1s", duration="2s")`.
- `x`/`y` are % of the stage measured from the centre: `x=0,y=0` is centred, `y=-35` near the top, `y=30` near the bottom. Keep text inside the title-safe area (G401 tells you by how many px it overflows).
- **Anchor** cues that belong to a particular shot. Absolute (`at`) cues stay at their time when the spine changes — good for music and narration, bad for shot-specific titles.
- `lane.update_cue(cue, at, duration, in, out, rate, preserve_pitch, z_index, x, y, scale, rotation, opacity, text, size, max_width, gain_db)` — placement (`x`, `y`, `scale`, `rotation`, `opacity`) accepts `+=`/`-=`; `rotation` is in clockwise degrees and applies to both visual (`broll`/graphic/composition) and typography (`title`/`caption`) cues in `monitor` and `render`.
- **Speed on lane audio/media cues (`rate`, `preserve_pitch`):** Set `rate` (0.1..16.0, e.g. `lane.update_cue(cue="cue_01", rate=1.3)`) on `ln_vo`, `ln_sfx`, `ln_bgm`, or `ln_broll` cues. Unless you also pass an explicit `duration`, Cuthol locks `[source_in_ms, source_out_ms]` to the asset range and updates `duration_ms = round((source_out_ms - source_in_ms) / rate)` (and scales any envelopes on the cue). Audio compilation (`compileSequenceAudioPlan`, shared by `render` and `mix.normalize`) applies `atempo` when `preserve_pitch=true` (default), and transcript words on `ln_vo` cues are projected at the sped-up times into `C.word`, `C.global.words`, and `speech.captions`.
- **Simultaneous / layered compositions:** Multiple composition cues can overlap in time — for example, a single 90+ second composition carrying the scenes while a second composition (a continuous mascot or corner badge) runs on top for the entire duration. Stacking order is deterministic: across lanes, higher `lane.z_index` renders on top; within the same lane (`ln_motion`), cues with higher `z_index` (or later cues when `z_index` is equal/omitted) render on top.
- `lane.remove_cue(cues=[...])`, `lane.lock(lane)`, `lane.unlock(lane)`.
- If lanes run longer than the spine you get G306 (the picture is just the backdrop there): extend the spine or shorten the cues.

## Graphics-only projects (empty spine)

The spine is optional. With no spine clips:
- The sequence length is the end of the latest cue on an unmuted lane. `brief(lens="overview")` shows `Length from: lane cues (spine empty, graphics-only)`; `monitor.timeline` labels the spine row `EMPTY - LENGTH FROM LANES`.
- Use `at` times; there is no clip to anchor to.
- Render starts from the stage backdrop and stacks the lanes on top; audio runs for the same length. Set the base colour with `workspace.backdrop(color="#RRGGBB")` first: wherever a composition is transparent the backdrop shows through, and the dark default can hide dark text. Monitor, `composition.preview` and the blank-frame check all use that colour.
- Cover the whole length with visual cues (compositions, titles, b-roll, stills on `ln_broll`). A stretch with only audio shows the bare backdrop and is reported as G308, also in `brief(lens="flow")` as `Backdrop only`.
- An entirely empty project (no spine clips, no cues) is reported as G307 by `verify`; `render` refuses it.

## Reading the edit

- `brief(lens="overview")` — stage, library table, spine list, lanes.
- `brief(lens="flow", window="0s..10s")` — chronological clips with anchored cues.
- `brief(lens="canvas", window="2s..2s")` — everything on screen at an instant with positions and z.
- `brief(lens="detail", id=["sp_01","cue_03"])` — every field of those items.
- `monitor.timeline` — the same as a picture (see `verify-and-monitor.md`).

## Undo and the journal

Every edit increments `revision` and returns:
- `Changed:` — e.g. `~sp_01 (transition:dissolve 500ms)`, `+cue_04 (title: 'Test') on ln_titles`.
- `Undo (expect_rev N):` — what an undo would revert, e.g. `SİLİNİR: cue_04 …` (will be deleted).

Undo: `workspace.undo(expect_rev=N)`; several steps `steps=3` or `to=<rev>`; preview with `dry_run=true`. If the revision moved (G109), re-read with `brief`. Locked lanes block undo/redo that would touch them (G111) unless you pass `allow_protected=[ids]`. `workspace.redo`, `workspace.tag(name)` and `workspace.journal` (list) complete the journal.

Edits that break G1–G3 (schema, files, timing) are rolled back automatically and returned as errors; nothing is half-applied.

## Cue sheets (bulk edits)

`cue.export(file="edit.cues.json")` writes the current edit in the cue-sheet format. Edit the file, then `cue.diff(file)` → `cue.plan(file)` (dry run with verification) → `cue.apply(file)` (one journaled transaction). Use this when you need many coordinated changes.
