---
name: cuthol-review
description: >
  Verify and inspect a Cuthol edit: cuthol verify gates, diagnostic codes
  (CUTHOL-Gxxx) and their fixes, monitor frame/sheet/timeline, brief lenses,
  library query, and reading rendered frames. Load when checking whether the
  edit is correct, understanding a warning or error, or looking at the picture
  before claiming done.
---

# Review: verify, diagnose, look

You cannot watch video; these tools are how you see. MCP returns the images
inline; the CLI prints the PNG path (open it with your image reader).

| Call | What you get | Cost |
|---|---|---|
| `monitor.frame(at="4.2s", boxes=true)` | One composited frame from the same pipeline as the final render (compiling only clips/cues active at `at`), plus luma stats and blank-frame check. Boxes show safe areas and each visible cue (overlays measured from their alpha). | seconds |
| `monitor.sheet(start, end, grid="4x3", at=[…])` | A grid across `[start, end]` — or at explicit `at` timestamps (`at=["3s","12.5s","40s"]`, CLI `--at 3s,12.5s,40s`) — each through the same windowed pipeline as `monitor.frame`. | ~10–20 s cold, <5 s warm |
| `monitor.timeline()` | Lane diagram: spine clips and transitions, every cue, music beats and the ducking curve. Best for gaps, overlaps and lanes outlasting the spine. | ~1 s |
| `composition.preview(cue, at=[…])` | An overlay alone: checkerboard / over footage (over the stage backdrop when nothing visual plays underneath) / alpha mask. | Chrome render |

Write monitor times **with units** (`"21.1s"`): a bare number means
milliseconds. When several bare `--at` numbers are all under 1000 on a sequence
of ≥ 10 s, the call warns (G114) — the times are used unchanged.

The HUD line on frames reads `T:<time> | ACT:<active handles> | Y:<mean luma>`.
`boxes=false` gives a clean frame.

What to check, concretely:

- Every title/caption readable, inside the safe box, not covered by another
  layer. Before a master, look at the **start, middle and end of every
  scene** (`monitor.sheet` with a comma-separated `at` list) — start/end-only
  sampling has missed mid-scene collisions.
- Transitions: sample the cut ± half the transition length. Suspect moves:
  check consecutive frames from the render, not spaced singles.
- Word-locked overlays: sample the frame right after the word starts (use
  `library.query(text=…)` for the word time, add the cue offset).
- The last seconds: is there picture until the end?
- After a master render: sample the **output file** every couple of seconds and
  look at all of them.

## Verification gates

`verify()` runs all gates (`--gates` selects a subset). **ERROR** gates
(G1–G3) also run after every edit and roll the edit back. **WARN** gates
(G4–G5) are reported and kept, because some are deliberate creative choices —
decide consciously. `verify` must report 0 errors before a master render.
Verify never touches coordinates: no measuring, no browser.

Every diagnostic is `[CODE] what happened | Suggestion: next step`.

| Code | Gate | Meaning → fix |
|---|---|---|
| G101–G105 | G1 ERROR | Unknown/duplicate handle, missing asset, anchor to a missing clip, composition breaking the HTML contract → `brief` to list handles; fix the reference. |
| G109 / G110 / G111 | — | `expect_rev` mismatch → re-read; unknown flag (message names the right one); undo/redo would touch a locked lane → `allow_protected` or unlock. |
| G114 | — WARN | Bare `--at` numbers read as ms (see above) → add units. |
| G115 | — WARN | `library query` hit the token budget → continue with `--cursor` or raise `--max-tokens`. |
| G116 / G117 / G410 | G1/G4 | Bad speed ramp (form, offsets) → fix `--ramp`; ramp rates outside 0.5..2.0 → listen in the draft. |
| G118 / G119 / G411 | G1/G4 | Bad clip effect / envelope on a non-animatable param / effect's extension drifted → fix params or re-`enable` the extension. |
| G120 | G1 ERROR | Bad easing name or cubic-bezier curve → valid names or x1,x2 in 0..1. |
| G121 / G412 | G1/G4 | `edge` on a lane cue (spine only); edge mode that changes nothing → move or drop it. |
| G122 / G123 / G413 | G1/G4 | Extension transition unavailable / bad params / its extension changed → check the manifest, fix params, re-`enable`. |
| G124 / G414 | G1/G4 ERROR | Colour temperature outside 1000..40000 K; LUT file unusable → neutral 6500 K, or place the LUT under the project and re-attach. |
| G201–G203 | G2 ERROR | File missing, source range beyond media, audio op on a silent asset. |
| G205 | G2 WARN / Render ERROR | Enabled extension differs from its pinned hash → `extension.enable` to accept and re-sync. Render stops until then. |
| G207 / G208 | G2 INFO | Variable-frame-rate source (converted to stage fps); BT.2020 source (converted to BT.709). Only for assets actually played. |
| G209 | G2 WARN | Extension processor output's video/audio lengths differ by > 1 frame → `"audio": "drop"` or an aligning filter. |
| G210 / G211 | G2 INFO/ERROR | Outside edits present (adopt or revert); an op refused to overwrite one → show, adopt/revert, retry. |
| G212 | G2 WARN | ffmpeg/ffprobe below 8.x (Cuthol is tested with 8.x) → install 8.x; also shown at render start. |
| G213 | SYS ERROR | ASR provider cannot auto-detect the language → re-run transcribe with `lang`. |
| G230–G236 | G1/G2/SYS | Unknown provider; extension lacks that kind; missing env secret; bad provider output; provider crashed; TTS without alignment (transcribe the voiceover or change provider); media id not found. |
| G301–G305 | G3 ERROR | Clip < 2 frames; spine gap/overlap; transition > half a neighbour; rate outside 0.1..16; keyframe out of range. |
| G306–G309 | G3 WARN | Cue past the spine end; empty sequence (render refuses); backdrop-only stretch with an empty spine → cover it; clip ≤ 150 ms → remove or merge. |
| G310 / G311 | G3 ERROR | `lane.excise` on a non-media cue; malformed `--ranges` → `2s..3s,6s..7s`. |
| G312–G316 | G3 INFO/ERROR | 150–300 ms speech fragment (restart leftover?); cleanup on a non-audio cue; cleanup taking clip + cue together; bad `--across`; only a mostly-empty transparent composition on screen (bare backdrop shows through). |
| G401–G403 | G4 WARN | Outside title-safe (by N px) → move/shrink; captions too fast → fewer words; text covered → move a layer. |
| G406 / G407 | G4 WARN | Backdrop-filter/blend in overlay mode → `scene_host`; HyperFrames lint finding → apply its fix hint. |
| G409 | G4 WARN | A field the render ignores (motion blur, mask, brightness/contrast/saturation envelope on a lane cue) set off-default → leave it at default; spine colour renders. |
| G415–G419 | G4 WARN | Failed sub-composition script (that part renders blank); in-composition audio (never enters the mix — move it to `ln_sfx`/`ln_bgm`); coords measurement failed / raw-HTML fallback / unmappable placement. |
| G428 / G429 | G4 ERROR | Unknown geometry element ref (message names the nearest key); geometry query misuse. |
| G430–G432 | G4 ERROR/WARN | Composition script threw before the timeline registered (render stops; monitor shows the static page — don't trust it) / while running / `console.error` (e.g. shader compile). Fix, then `composition.preview(cue=…)` to refresh the record. |
| G509 | G4 INFO | N compositions were never opened in a browser, so their scripts are unchecked → `composition.preview(cue=…)` to record a check. |
| G501–G508 | G5 | True peak > −1 dBTP; blank/backdrop frame (with timestamps after render); overlay render failed (render stops, nothing substituted); ducking skipped untranscribed clips; opaque overlay hiding moving footage; 8 px edge strip; inaudible `C.audio` window; post-render audio drift/gap. See `cuthol-render` for the render-side ones. |

Full table with severities and fix commands: `references/diagnostics.md`.
Codes G420–G427 are retired (a removed warning system) and never reused; they
may appear in old projects and logs.

## Reading the edit without pictures

- `brief(lens="overview")` — stage, library table, spine list, lanes.
- `brief(lens="flow", window="0s..10s")` — chronological clips with anchored
  cues (also flags backdrop-only stretches).
- `brief(lens="canvas", window="2s..2s")` — everything on screen at an instant
  with positions and z.
- `brief(lens="detail", id=["sp_01","cue_03"])` — every field of those items
  (also shows asset `source` origin and ramp summaries).
- `library.query(handle, kind, range|text, format?, limit?, cursor?,
  max_tokens?)` — read analysis details (`transcript`, `beats`, `waveform`,
  `scenes`, `captions`). Token-budget truncation warns (G115) with
  `next_cursor`.

`monitor timeline` is the fastest structural check (~1 s): gaps, overlaps,
ducking curve, lanes outlasting the spine.
