# Diagnostic codes (full table)

Every diagnostic is `[CODE] what happened | Suggestion: next step`. ERROR gates
(G1–G3) also run after every edit and roll the edit back; WARN gates (G4–G5)
are reported and kept. Codes G420–G427 are retired (a removed warning system)
and never reused; they may appear in old projects and logs.

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
| G112 | G1 ERROR | Extension manifest invalid → fix per the schema (`cuthol-extensions`). |
| G113 | G1 ERROR | Extension already exists → pick another name or remove it first. |
| G114 | — WARN | `monitor frame` / `monitor sheet` read every bare `--at` number as milliseconds, all of them were under 1000, and the sequence is at least 10 s. Times are unchanged → pass `21.1s` or `00:21.1` if you meant seconds. A single bare value, or any value with a unit, does not warn. |
| G115 | — WARN | `library query` cut the page at the token budget (`truncated_by=max_tokens`). The message gives the returned count and `next_cursor` → continue with `--cursor`, or raise `--max-tokens`. |
| G116 | G1 ERROR | Invalid `--ramp` → `'--ramp "0s:1,1s:1,2.5s:4"'` (source offset:rate pairs, strictly increasing offsets, rate 0.1..16, ≥ 2 points); `'--ramp none'` removes it; never combine with `--rate`. |
| G117 | G4 WARN | Ramp offset beyond the source range → clamped; bring offsets into range. |
| G118 | G1 ERROR | Clip effect invalid → fix params or remove it (`spine fx remove`). |
| G119 | G1 ERROR | Envelope on a non-animatable param → move it to an envelopable parameter; the extension declares `animatable`. |
| G120 | G1 ERROR | Invalid easing name or cubic-bezier curve → `linear`, `ease_in`, `ease_out`, `ease_in_out`, `hold` (envelopes only), or `cubic-bezier(x1,y1,x2,y2)` with x1,x2 in 0..1. |
| G121 | G1 ERROR | `edge` on a lane cue (mirrored/extended fill is spine-only) → drop it; fill the spine clip underneath instead. |
| G122 | G1 ERROR | Extension transition unavailable, or its easing unsupported → check install, manifest `transitions`, and enabled state. |
| G123 | G1 ERROR | Transition params invalid (builtins take none) → fix per the manifest. |
| G124 | G1 ERROR | Colour temperature outside 1000..40000 K → `--temperature 6500` (neutral, no filter). |
| G125 | G1 ERROR | `lane mute` targeting `spine` → the spine is not a lane; `spine mute --clip <id>` for a clip, `lane mute --lane <id>` for a lane. |
| G630 | SYS ERROR | `setup` target config file unparseable (left unwritten) → fix the file syntax, re-run `--apply`. |
| G631 | G1 ERROR | `setup --agent` names an unknown agent id → use `claude-code`, `codex`, `cursor` or `gemini-cli`. |
| G632 | SYS INFO | `setup` tool has no writable config (manual registration) → follow the tool's MCP docs with the printed command. |
| G633 | SYS WARN | `setup` found an existing different cuthol entry (kept) → re-run with `--force` to replace. |
| G634 | SYS ERROR | `setup` could not back up or write the config → check the folder exists and is writable. |
| G201 | G2 ERROR | File missing on disk. |
| G202 | G2 ERROR | Source range beyond the media length. |
| G203 | G2 ERROR | Audio operation on an asset without audio. |
| G204 | G2 ERROR | Extension not found in project or persistent folders → `extension list` or `create`. |
| G205 | G2 WARN / Render ERROR | Enabled extension (or its copy in a composition) differs from the pinned `content_hash` → `extension enable` to accept and re-sync. Render stops until then. |
| G206 | G2 ERROR | Extension violated the security boundary (wrote outside its output path / `CUTHOL_EXT_TMP`, or used network APIs with `network: false`). |
| G207 | G2 INFO | Variable-frame-rate source on a played clip/cue (converted to stage fps; possible 1-frame rounding). Unplayed library assets stay silent. |
| G208 | G2 INFO | BT.2020 source (YCbCr converted to BT.709, no HDR tone-mapping). |
| G209 | G2 WARN | Extension processor output's video/audio lengths differ by > 1 frame (40 ms without a frame rate) → `"audio": "drop"` or an aligning `audio_filter`. Also on cache hits. |
| G210 | G2 INFO | Outside edits present → `changes_show`, then adopt or revert. |
| G211 | G2 ERROR | An op refused to overwrite outside edits → show, adopt or revert, then retry. |
| G212 | G2 WARN | ffmpeg/ffprobe below 8.x (Cuthol is tested with 8.x; tempo, loudness and scene analysis may differ) → install 8.x; also shown at render start. |
| G213 | SYS ERROR | ASR provider cannot auto-detect the speech language and no `lang` was given → re-run transcribe with `lang`. |
| G625 | SYS ERROR | `doctor` found no ffmpeg/ffprobe on PATH → install ffmpeg 8.x. |
| G626 | SYS ERROR | `doctor` found no Chrome/Chromium for HyperFrames rendering → install Chrome or Edge. |
| G214 | — WARN | `composition scaffold` / `lane add-composition` read a bare `--duration` under 100 as milliseconds. The value is unchanged → pass `4s` or `4000ms` if you meant seconds. Values with units never warn. |
| G230 | G1 ERROR | Unknown provider id → use a listed one. |
| G231 | G2 ERROR | Extension does not provide that provider kind → `extension show` its `providers`. |
| G232 | SYS ERROR | Provider env secret missing → set it in the shell or project `.env`; values are never written anywhere. |
| G233 | SYS ERROR | Provider script returned output violating its contract → fix the script. |
| G234 | SYS ERROR | Provider script crashed / missing output → check script and config. |
| G235 | SYS WARN | Extension TTS returned audio without alignment → no word timings; transcribe the voiceover or change provider. |
| G236 | G2 ERROR | Media provider has no candidate with that id → `library.search` again. |
| G237 | SYS ERROR | Keyless local speech not installed → `cuthol setup --local-speech --apply` (or wire `CUTHOL_LOCAL_*_CMD`). |
| G238 | SYS ERROR | Local speech setup failed at a step → fix the cause, re-run with `--apply`. |
| G239 | SYS ERROR | Local speech bridge (ASR/TTS) failed → re-run setup with `--apply`, then retry. |
| G301 | G3 ERROR | Clip shorter than 2 frames. |
| G302 | G3 ERROR | Gap/overlap on the spine. |
| G303 | G3 ERROR | Transition longer than half of a neighbouring clip. |
| G304 | G3 ERROR | Playback rate outside 0.1..16.0. |
| G305 | G3 ERROR | Keyframe outside the item or out of range. |
| G306 | G3 WARN | A lane cue runs past the end of the spine (only backdrop behind it). |
| G307 | G3 WARN | The sequence is empty (no spine clips, no cues on unmuted lanes). `render` refuses it with the same code as an error. |
| G308 | G3 WARN | Spine is empty and no visual cue is on screen between the given times → add or extend a visual cue. |
| G309 | G3 WARN | Spine clip duration `<= 150 ms` (leftover fragment) → `spine remove` or merge into a neighbour. |
| G310 | G3 ERROR | `lane.excise` on a composition/title/caption/still cue → `update_cue(duration=…)` or `remove_cue`. |
| G311 | G3 ERROR | An `excise` range is not `start..end` → `--ranges 2s..3s,6s..7s`. |
| G312 | G3 INFO | 150–300 ms spine clip with audio above the silence floor ("short speech fragment, possibly a restart leftover"). Runs only with a cached cleanup acoustic profile. |
| G313 | G3 ERROR | `speech.cleanup` on a non-audio cue → voiceover/music/sfx cues only. |
| G314 | G3 ERROR | Cleanup taking a spine clip and an audio cue in one call → one target per call. |
| G315 | G3 ERROR | Invalid `--across` → `lane`, `all_lanes`, `all`, `spine`, `none`. |
| G316 | G3 INFO | Spine-less stretch whose only picture is a transparent composition with mostly-empty alpha (bare backdrop shows through) → `workspace backdrop --color` or an opaque background layer. Only reported with a cached alpha measurement. |
| G401 | G4 WARN | Outside the title-safe area by N px → move / shrink / `max_width`. |
| G402 | G4 WARN | Caption reading speed too high → fewer words per caption. |
| G403 | G4 WARN | Text covered by a higher layer. |
| G406 | G4 WARN | Overlay uses backdrop-filter / blend modes in overlay mode → `mode="scene_host"`. |
| G407 | G4 WARN / INFO | HyperFrames lint finding inside a mounted composition (cached by content hash; size/split hints ignored). `duplicate_media_discovery_risk` on `<img>`-only is INFO, on `<video>`/`<audio>` WARN → apply the finding's fix hint. |
| G409 | G4 WARN | Motion blur, a mask, or a brightness/contrast/saturation envelope on a lane cue set off-default: this version does not apply that field in the render. Spine colour (constant or enveloped, temperature, LUT) renders → leave the unused field at default. |
| G410 | G4 WARN | Speed ramp with rates outside 0.5..2.0 (audio follows, quality drops) → listen in the draft; keep speech ramps inside. |
| G411 | G4 WARN | Clip effect compiling against a drifted extension → `extension enable` to accept. |
| G412 | G4 WARN | Edge mode that changes nothing (clip already covers the stage and never moves) → drop it or move the clip. |
| G413 | G4 WARN | A used extension transition's extension changed on disk (render uses the current one) → `extension enable` to accept. |
| G414 | G4 ERROR | LUT file missing, unreadable, outside the project, or not `.cube`/`.3dl` → place it under the project and re-attach, or clear with `--lut none`. Render refuses to start. |
| G415 | G4 WARN | A sub-composition script threw while a sibling timeline stayed alive: skipped with an empty timeline, that overlay part is blank → fix that script; the next render re-captures. |
| G416 | G4 WARN / INFO | A composition cue plays audio (`<audio>`, audible `<video>`, `<hf-audio-group>`). INFO when its stem is in the Cuthol mix (it follows the cue's gain, mute, envelopes and ducking) or the cue has `composition_audio: off`; WARN while no stem has been extracted yet (render or `mix` extracts it). |
| G435 | G4 WARN | Extracting a composition's sound failed (reason in the message); the cue stays silent in the mix → fix the composition, or `lane update-cue --cue <id> --composition-audio off`. |
| G436 | G4 INFO | The engine rendered silence for a composition with audio markers (for example sound made only in JS) → prefer `<audio>` elements. |
| G440 | G4 WARN | Colour stage LUT still above the self-test limit at the fine 65 grid (message gives p99 CIEDE2000); the render uses the closest LUT → simplify the stage (narrow HSL qualifiers need the fine grid) and re-render. |
| G441 | G4 ERROR | Look LUT unreadable or outside the project → place it under the project as `.cube` and re-attach, or remove the Look binding. Render refuses to start. |
| G442 | G4 ERROR | Keyframed colour needs more baked frames than the per-item cache limit (message gives the number) → shorten the keyframed range or split it across items. Render refuses to start. |
| G443 | G4 ERROR | Input transform the asset needs is unavailable in this ffmpeg build (`zscale`/`tonemap` missing) → install ffmpeg 8.x with both filters, or set the asset input to `none`. Render refuses to start. |
| G444 | G4 ERROR | Keyframed colour frame LUTs could not bake (reason in the message) → re-run (frames cache under `.cuthol/blobs/color`); simplify the envelopes if it persists. Render refuses to start. |
| G417 | G4 WARN | Coordinate measurement failed for a cue → skipped, the rest continue. |
| G418 | G4 WARN | Coords fell back to raw HTML (bundled fonts unavailable). |
| G419 | G4 INFO | Coords page error or unmappable placement. |
| G428 | G4 ERROR | Unknown geometry element ref (message names the nearest measured key). |
| G429 | G4 ERROR | Geometry query misuse (e.g. `--elements` without one `--at` moment). |
| G430 | G4 ERROR | Composition script threw before its timeline registered: the overlay cannot render (render stops with G503) and monitor frames show the static unanimated page — don't trust them. `file:line` when known → fix, then `cuthol composition preview --cue <cue_XX>` to refresh; `verify` stays red while the recorded error matches. |
| G431 | G4 WARN | Composition script threw while the timeline was running (e.g. a `tl.call` callback). Render output unaffected → fix, then re-preview. |
| G432 | G4 WARN | Composition page logged a `console.error` (e.g. a failed shader compile). Render output unaffected → inspect, then re-preview. |
| G433 | G4 INFO | Composition page logged only shader/compiler warnings (nothing threw; render output unaffected) → no action needed. |
| G501 | G5 WARN | True peak above −1 dBTP → lower gain or `mix.normalize`. |
| G502 | G5 WARN | Blank or backdrop-filled frame (even with a caption/small overlay on top); also emitted after `render` with event timestamps if a spine clip drops to backdrop outside intentional fades. Without spine clips only frames with no visual cue count: dark frames a composition draws itself are not reported. |
| G503 | G5 ERROR | HyperFrames could not render an overlay; the render stops with `ok:false` and nothing is substituted → open the composition with `composition.preview`, fix it, render again. Renders have no time limit (MCP reports progress and can be cancelled). |
| G504 | G5 WARN | Ducking ignored clips without transcripts. |
| G505 | G5 WARN | Overlay (almost) fully opaque hiding moving footage. Not raised when only the backdrop or a still image is underneath. |
| G506 | G5 WARN | 8 px black strip on the right/bottom edge (an ffmpeg conversion bug at widths like 1080). Check versions and render again. |
| G507 | G5 WARN | A composition uses `C.audio` but no audio energy could be extracted for its window, so `C.audio` returns 0. |
| G508 | G5 WARN | Post-render audio health: alignment offset, missing signal, or silent output gap while the source is loud (ramp-aware on ramped clips, inconclusive on periodic signals) → check the item's timing/audio chain and render again. |
| G509 | G4 INFO | N compositions were never opened in a browser, so their scripts are unchecked → `composition.preview(cue=…)` to record a check. |
| SYS01–08 | — | Project not found, bad time literal, journal entry unavailable, external tool spawn/exit failure (`SYS04`, e.g. `ENOENT`), missing API key, transcript missing, invalid colour, extension execution failure (`SYS08`). |
| G240 | G2 ERROR | Colour frame sampling failed (unknown item, missing asset, ffmpeg decode failure). | Check the item id and that its asset file exists, then re-run. |
| G241 | G2 WARN | Colour map has almost no measurable pixels. | Sample more frames or check the source file. |
| G242 | G2 ERROR | Colour solve needs target frames but none were given. | Pass target frames or a reference file. |
| G510 | G5 INFO | Post-render colour check matches the prediction (per-item mean dE; 0.6–1.5 is normal). | No action needed. |
| G512 | G5 WARN | Rendered colour differs from the render-free prediction (mean dE > 3; item, instant and mean in the message). | Re-measure with the colour map and check the stage LUT. |
| SYS09 | SYS ERROR | Subprocess command line exceeds the OS limit (`ENAMETOOLONG` / `E2BIG`); reports length, limit, clip count. |
| SYS10 | SYS ERROR | Subprocess progress stalled: the process tree was terminated after `CUTHOL_STALL_TIMEOUT_SEC` (default 300 s; `0` disables) without progress. Reports step, last progress, stall duration. After one automatic `libx264` retry if a hardware encoder stalled. |
| G515 | G5 INFO | Transparent master codec choice (ProRes 4444 MOV vs VP9 WebM) and why; alpha preserved end to end. |
| G516 | G5 INFO | Render preset target dimensions (e.g. 3840x2160 for master_2160p 16:9). |
| G517 | G5 INFO | Timeline exported (format, path, spine clip count); check not-exported lines for manual work. |
| G518 | G5 WARN | Timeline export skipped a kind (compositions, captions, lanes); recreate by hand or from overlay renders. |
| G519 | G5 INFO | A post-render scan skipped on transparent masters (blank/edge scans assume opaque frames). |
| G660 | G1 ERROR | Unknown timeline export format; use fcpxml, xmeml, edl or otio. |
| G661 | G1 ERROR | Timeline export with an empty spine. |
| G662 | G1 WARN | Composition/caption cues exported as markers (no cached overlay). Render first to get overlay references. |
| G663 | G2 WARN | Export references media whose file could not be resolved locally. |
| G664 | G1 WARN | EDL left audio cues out (spine/video only by design); use fcpxml/xmeml/otio to carry the mix. |
| G650 | G4 ERROR | Colour LUT for a Live item could not be compiled -> check the item and its stage, retry. |
| G651 | G4 ERROR | Live colour drag preview failed -> release the slider and retry; saved stage unchanged. |
| G652 | G4 ERROR | Live colour slider commit failed -> pause the agent, then `color set --item <id> --patch`. |
| G653 | G4 WARN | Live colour scopes could not be computed -> graded picture unaffected; reopen the panel. |
| G654 | G4 ERROR | Live colour text map unavailable (needs the measurement build) -> graded preview still works. |
| G133 | G1 ERROR | A Look's `.cube`/`.3dl` is missing or outside the project -> recreate the Look from a LUT inside the project or remove it. |
| G134 | G1 WARN | Two or more Looks reach one item through `apply_to`; only the first is used -> bind the intended one. |
| G135 | G1 WARN | A Look is bound to a screen recording or graphic -> unbind unless asked, or correct `color kind`. |
| G136 | G1 WARN | HDR (HLG/PQ) source with input transform `none` -> `color kind --input auto`. |
| G137 | G1 WARN | Ungraded clip of the same source as graded clips -> copy the grade or bind a Look. |
