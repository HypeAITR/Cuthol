# Verify, monitor, render

## Looking at the edit

You cannot watch video; these tools are how you see. MCP returns the images inline; the CLI prints the PNG path (open it with your image/file reader).

| Call | What you get | Cost |
|---|---|---|
| `monitor.frame(at="4.2s", boxes=true)` | One composited frame from the same pipeline as the final render, plus luma stats and blank-frame check. Boxes show safe areas and each visible cue (overlays are measured from their alpha). | seconds |
| `monitor.sheet(start, end, grid="4x3")` | A grid of frames across a window, each labelled with time and active handles. Best overview after an edit. | ~10–20 s |
| `monitor.timeline()` | Lane diagram: spine clips and transitions, every cue, music beats and the ducking curve. Best for spotting gaps, overlaps and lanes outlasting the spine. | ~1 s |
| `composition.preview(cue, at=[…])` | An overlay alone: checkerboard / over footage / alpha mask. | Chrome render |

The HUD line on frames reads `T:<time> | ACT:<active handles> | Y:<mean luma>`. `boxes=false` gives a clean frame.

What to check, concretely:
- Every title/caption readable, inside the yellow safe box, not covered by another layer.
- Transitions: sample the cut ± half the transition length.
- Word-locked overlays: sample the frame right after the word starts (use `library.query(text=…)` for the word time, add the cue offset).
- The last seconds: is there picture until the end?

## Verification gates

`verify()` runs all gates. **ERROR** gates (G1–G3) also run after every edit and roll the edit back. **WARN** gates (G4–G5) are reported and kept, because some are deliberate creative choices — decide consciously.

| Code | Gate | Meaning → fix |
|---|---|---|
| G101 | G1 ERROR | Unknown handle → `brief` to list handles. |
| G102 | G1 ERROR | Duplicate handle. |
| G103 | G1 ERROR | Clip/cue points to a missing asset. |
| G104 | G1 ERROR | Cue anchored to a missing clip. |
| G105 | G1 ERROR | Composition HTML breaks the contract (root id / timeline registration / paused timeline / determinism). |
| G109 | — | `expect_rev` does not match the current revision → re-read. |
| G110 | — | Unknown or mistyped flag/argument (the message names the right one). |
| G111 | — | Undo/redo would change a locked lane → `allow_protected` or unlock. |
| G201 | G2 ERROR | File missing on disk. |
| G202 | G2 ERROR | Source range beyond the media length. |
| G203 | G2 ERROR | Audio operation on an asset without audio. |
| G301 | G3 ERROR | Clip shorter than 2 frames. |
| G302 | G3 ERROR | Gap/overlap on the spine. |
| G303 | G3 ERROR | Transition longer than half of a neighbouring clip. |
| G304 | G3 ERROR | Invalid playback rate. |
| G305 | G3 ERROR | Keyframe outside the item or out of range. |
| G306 | G3 WARN | A lane cue runs past the end of the spine (only backdrop behind it). |
| G401 | G4 WARN | Outside the title-safe area by N px → move / shrink / `max_width`. |
| G402 | G4 WARN | Caption reading speed too high → fewer words per caption. |
| G403 | G4 WARN | Text covered by a higher layer. |
| G406 | G4 WARN | Overlay uses backdrop-filter / blend modes in overlay mode → `mode="scene_host"`. |
| G501 | G5 WARN | True peak above −1 dBTP → lower gain or `mix.normalize`. |
| G502 | G5 WARN | Blank or backdrop-filled frame (even with a caption/small overlay on top); also emitted after `render` with event timestamps if a spine clip drops to backdrop outside intentional fades. |
| G503 | G5 ERROR | HyperFrames could not render an overlay; the render stops with `ok:false` and nothing is substituted. The message carries the HyperFrames error → open the composition with `composition.preview`, fix it, render again. Renders have no time limit: a long video simply takes longer (MCP reports progress and can be cancelled). |
| G504 | G5 WARN | Ducking ignored clips without transcripts. |
| G505 | G5 WARN | Overlay is (almost) fully opaque and hides moving footage playing under it. Not raised when only the stage backdrop or a still image is underneath (a full-frame graphic is then deliberate). |
| SYS01–06 | — | Project not found, bad time literal, journal entry unavailable, ffmpeg/HyperFrames failure, missing API key, transcript missing. |

Every diagnostic is `[CODE] what happened | Öneri: next step`.

## Render

`render(preset="draft_480p")` for checks, `render(preset="master_1080p")` for delivery (default output `output/render_r<revision>_<preset>.mp4` in the project). Overlays are rendered once and cached by their content; a 14-second edit with one overlay takes well under a minute at 1080p. After encoding, `render` automatically scans the output video for blank/backdrop-filled frames while a spine clip is active (ignoring intentional fade windows) and reports any drop-outs as `CUTHOL-G502` warnings with exact timestamps.

After rendering, sample frames of the **output file** (CLI: `ffmpeg -ss 4.2 -i out.mp4 -frames:v 1 f.png`; MCP: `monitor.frame` shows the same pipeline). Deliver only after verify shows 0 errors, the warnings are understood, and you have looked at the frames.
