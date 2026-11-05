# Verify, monitor, render

## Looking at the edit

You cannot watch video; these tools are how you see. MCP returns the images inline; the CLI prints the PNG path (open it with your image/file reader).

| Call | What you get | Cost |
|---|---|---|
| `monitor.frame(at="4.2s", boxes=true)` | One composited frame from the same pipeline as the final render (compiling only the clips and cues active at `at`), plus luma stats and blank-frame check. Boxes show safe areas and each visible cue (overlays are measured from their alpha). | seconds |
| `monitor.sheet(start, end, grid="4x3", at=[…])` | A grid of frames across `[start, end]` — or at explicit `at` timestamps (e.g. `at=["3s","12.5s","40s"]`, CLI `--at 3s,12.5s,40s`) — each rendered through the same windowed single-frame pipeline as `monitor.frame` (only clips/cues active at each cell timestamp are compiled; composition frames are captured in one batched `snapshot` call and cached per frame). | ~10–20 s cold, <5 s warm |
| `monitor.timeline()` | Lane diagram: spine clips and transitions, every cue, music beats and the ducking curve. Best for spotting gaps, overlaps and lanes outlasting the spine. | ~1 s |
| `composition.preview(cue, at=[…])` | An overlay alone: checkerboard / over footage (over the stage backdrop when nothing visual plays underneath) / alpha mask. | Chrome render |

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
| G114 | — WARN | `monitor frame` / `monitor sheet` read every bare `--at` number as milliseconds, all of them were under 1000, and the sequence is at least 10s. Times are unchanged → pass `21.1s` or `00:21.1` if you meant seconds. A single bare value, or any value with a unit, does not warn. |
| G115 | — WARN | `library query` cut the page at the token budget (`truncated_by=max_tokens`). The message gives the returned count and `next_cursor` → continue with `--cursor`, or raise `--max-tokens`. |
| G124 | G1 ERROR | A spine clip's colour temperature is outside 1000..40000 K → `spine grade --clip sp_XX --temperature 6500` (neutral, no filter). |
| G201 | G2 ERROR | File missing on disk. |
| G202 | G2 ERROR | Source range beyond the media length. |
| G203 | G2 ERROR | Audio operation on an asset without audio. |
| G205 | G2 WARN / Render ERROR | Enabled extension on disk or its copy in a composition differs from the pinned `content_hash` in `cuthol.sequence.json`. `verify` warns with `CUTHOL-G205` and `render` stops with `ERROR [CUTHOL-G205]` → run `extension(action="enable", name="<name>")` (`cuthol extension enable --name <name>`) to update the hash and sync compositions. |
| G207 | G2 INFO | Variable-frame-rate (VFR) video source detected (`probe.is_vfr=true`) on a spine clip or on a cue whose lane is not muted. A library asset that nothing plays does not raise this. Cuthol converts video to the stage's constant frame rate (`settb=AVTB,fps=<stage.fps>:eof_action=pass`) and resamples audio (`aresample=async=1:first_pts=0`), noting potential 1-frame rounding or frame duplication during sudden VFR drops. |
| G208 | G2 INFO | BT.2020 color space source detected (`probe.color_space` is `bt2020nc`/`bt2020c`/`bt2020`); Cuthol converts YCbCr to BT.709 using `in_color_matrix=bt2020:out_color_matrix=bt709` without HDR transfer/primaries tone-mapping. |
| G209 | G2 WARN | An extension processor output has both a video and an audio stream and their durations differ by more than one frame (40 ms when the output has no frame rate). The message states both durations → set the ffmpeg processor's `"audio"` to `"drop"`, or add an `audio_filter` that keeps the streams the same length. Also returned on a cache hit. |
| G301 | G3 ERROR | Clip shorter than 2 frames. |
| G302 | G3 ERROR | Gap/overlap on the spine. |
| G303 | G3 ERROR | Transition longer than half of a neighbouring clip. |
| G304 | G3 ERROR | Invalid playback rate. |
| G305 | G3 ERROR | Keyframe outside the item or out of range. |
| G306 | G3 WARN | A lane cue runs past the end of the spine (only backdrop behind it). |
| G307 | G3 WARN | The sequence is empty (no spine clips, no cues on unmuted lanes). `render` refuses it with the same code as an error. |
| G308 | G3 WARN | Spine is empty and no visual cue is on screen between the given times: only the stage backdrop shows → add or extend a visual cue. |
| G309 | G3 WARN | Spine clip duration is `<= 150 ms` (a leftover fragment between cuts) → `spine remove` that clip or merge it into a neighbour. |
| G312 | G3 INFO | Spine clip longer than 150 ms and shorter than 300 ms with audio above the silence floor. The message says this may be a short restart leftover ("kısa konuşma parçası, yeniden başlama kalıntısı olabilir"). The check uses a cleanup acoustic profile only when one is already cached for the asset and stays silent otherwise. |
| G311 | G3 ERROR | An `excise` range is not `start..end`. The message names the broken piece → write `--ranges 2s..3s,6s..7s`. |
| G401 | G4 WARN | Outside the title-safe area by N px → move / shrink / `max_width`. |
| G402 | G4 WARN | Caption reading speed too high → fewer words per caption. |
| G403 | G4 WARN | Text covered by a higher layer. |
| G406 | G4 WARN | Overlay uses backdrop-filter / blend modes in overlay mode → `mode="scene_host"`. |
| G407 | G4 WARN / INFO | HyperFrames lint finding inside a mounted composition (e.g. `gsap_non_transform_motion` tweening `left`/`width`, `duplicate_media_discovery_risk`; cached by composition content hash, size/sub-composition split hints are ignored). `duplicate_media_discovery_risk` is downgraded to `INFO` when it only affects `<img>` tags and stays `WARN` for `<video>`/`<audio>` → apply the finding's `Öneri` fix hint. |
| G409 | G4 WARN | Motion blur, a mask, or a brightness/contrast/saturation envelope on a lane cue is set away from the default. This version does not apply that field in the render. The message names the clip (or cue) and the field. Spine colour (constant or enveloped brightness/contrast/saturation, temperature, LUT) renders → leave the unused field at its default. |
| G414 | G4 ERROR | A spine clip's LUT file is missing, unreadable, outside the project folder, or not `.cube`/`.3dl` → put the file under the project folder and re-attach with `spine grade --clip sp_XX --lut <path>`, or clear with `--lut none`. Render refuses to start. |
| G415 | G4 WARN | A sub-composition script threw while a sibling timeline stayed alive, so HyperFrames skipped it with an empty timeline and that overlay part is blank. `overlays.script_errors` / `overlays.diagnostics` name the element, composition and error → fix that script; the next `render` re-captures. |
| G416 | G4 WARN | A composition cue plays audio (`<audio>`, audible `<video>`, `<hf-audio-group>`, JS audio) that never enters the Cuthol mix — overlays are picture-only. `muted` / silent / sourceless stays quiet → move the sound to `ln_sfx` / `ln_bgm`. |
| G501 | G5 WARN | True peak above −1 dBTP → lower gain or `mix.normalize`. |
| G502 | G5 WARN | Blank or backdrop-filled frame (even with a caption/small overlay on top); also emitted after `render` with event timestamps if a spine clip drops to backdrop outside intentional fades. Without spine clips only frames with no visual cue count: dark frames a composition draws itself are not reported. |
| G503 | G5 ERROR | HyperFrames could not render an overlay; the render stops with `ok:false` and nothing is substituted. The message carries the HyperFrames error → open the composition with `composition.preview`, fix it, render again. Renders have no time limit: a long video simply takes longer (MCP reports progress and can be cancelled). |
| G504 | G5 WARN | Ducking ignored clips without transcripts. |
| G505 | G5 WARN | Overlay is (almost) fully opaque and hides moving footage playing under it. Not raised when only the stage backdrop or a still image is underneath (a full-frame graphic is then deliberate). |
| G506 | G5 WARN | The render has an 8 px black strip on its right or bottom edge (a known ffmpeg conversion bug at widths like 1080). Check the HyperFrames/ffmpeg version and render again. |
| G507 | G5 WARN | A composition uses `C.audio`, but no audio energy envelope could be extracted for its window (no active audio source or waveform extraction failed), so `C.audio` returns 0. |
| G508 | G5 WARN | Post-render audio health check detected an audio alignment offset or missing signal on a clip/cue (e.g. around a segmented render boundary) → check the item's timing/audio chain and render again. |
| SYS01–08 | — | Project not found, bad time literal, journal entry unavailable, external tool spawn/exit failure (`SYS04`, reporting OS spawn errors such as `ENOENT`), missing API key, transcript missing, invalid colour (`workspace.backdrop`), extension execution failure (`SYS08`). |
| SYS09 | SYS ERROR | Subprocess command line exceeds the operating system limit (`ENAMETOOLONG` / `E2BIG`); reports the command length, OS character limit, and clip count. |
| SYS10 | SYS ERROR | Subprocess progress stalled (`SUBPROCESS_STALLED`): the child process (and its process tree) was terminated because no progress occurred for `CUTHOL_STALL_TIMEOUT_SEC` (default 300 s; `0` disables the watchdog). Reports the step, last progress value, stalled duration, and a concise command summary. |

Every diagnostic is `[CODE] what happened | Öneri: next step`.

## Render

`render(preset="draft_480p")` for checks, `render(preset="master_1080p")` for delivery (default output `output/render_r<revision>_<preset>.mp4` in the project). Overlays are rendered once and cached by their composition files, used window-local data, used `C.global.*` data, and the HyperFrames package version that renders them (`draft_480p` captures overlays at 480p under a separate cache key without overwriting `master_1080p` blobs, and reuses an already-cached `master_1080p` blob when the composition state matches). Every render result includes `overlays: { total, cached, rendered, concurrency, workers, capture_modes, gpu_modes, stage_totals_sec, reasons, elapsed_ms, rerendered, summary }` reporting how many overlays hit cache, why any were re-rendered (`new`, `html_changed`, `renderer_version_changed`, `slice_changed`, `global_used_changed`, `props_changed`, `backdrop_changed`, `blob_missing`), and the HyperFrames pipeline summary (`capture_mode`, `gpu_mode`, `streaming_encode`, `stages_sec`, `hf_summary`, also saved in each blob's `.meta.json`).

- **Concurrent overlay pre-pass & workers (`K` × `W`):** Before compiling the final filtergraph, uncached composition overlays are collected and rendered up to `K` at a time (`concurrency`), each using `W` HyperFrames workers (`workers`).
  - `W` (workers per single HyperFrames composition): defaults to `1` on Windows/macOS (preserving single-worker streaming encode / `drawElement` without separate chunk-encode overhead) and `2` on Linux (`1` on <=2 cores); override via `workers` (`render --workers <W>`) or `CUTHOL_WORKERS`.
  - `K` (concurrent overlay processes): defaults to `floor(logical_cores / W)`, bounded by total RAM (~40% budget at ~1.0 GB per `W` worker tree), current free RAM (preserving >=0.8 GB free headroom at ~350 MB per headless Chrome worker), and the number of cold overlays; override via `CUTHOL_OVERLAY_CONCURRENCY=<K>` (`1` forces sequential overlay rendering). If one overlay fails in a concurrent batch, sibling overlays finish and cache normally before `CUTHOL-G503` (or `CUTHOL-SYS10`) is raised.
- **Alpha overlay intermediate format & single-stage opaque fast paths:**
  - Transparent (`overlay_alpha`) compositions over moving footage are captured as a lossless 8-bit straight RGBA PNG directory (`.cuthol/blobs/hf_comp_<hash>.pngseq/frame_%06d.png`) via `hyperframes render --format png-sequence` (staged in a temporary directory and atomically renamed after verifying the directory and frame count) and read directly by FFmpeg (`-framerate <fps> -start_number 1 -i <dir>/frame_%06d.png`) with an explicit BT.709 (`tv` range) conversion in the composite graph.
  - For very long alpha overlays (>= `CUTHOL_ALPHA_FFV1_MIN_FRAMES`, default `3600` frames = 2 min at 30 fps; `0` disables threshold packing) or when `CUTHOL_ALPHA_FORMAT=ffv1` is set, the captured PNG sequence is packed into a single lossless RGBA FFV1 `.ffv1.mov` container with exact `1/fps` frame timing (`CUTHOL_ALPHA_FORMAT=png|ffv1|mov` overrides the format).
  - When a full-frame composition has no moving footage underneath (only stage backdrop or a static still image), Cuthol renders it directly as an opaque MP4 with the backdrop baked in, and skips a second video encode (`single_stage: true`) when no upper visual layers exist. Opaque, full-frame, untransformed, transition-less, envelope-less footage clips on the spine and B-roll lanes also skip the `format=rgba` conversion in the FFmpeg composite graph.
- **Multi-vendor hardware encoding & source-aware BT.709 color pipeline:**
  - Every source input (spine clips, B-roll/visual cues, still images, HyperFrames overlays) selects its input color matrix and range from the source metadata (`probe.color_space`, `probe.color_range`, `probe.pix_fmt`; legacy library entries missing color fields are re-probed once and cached in `.cuthol/ledger.sqlite`):
    1. Tagged YUV sources use their declared matrix and range (`bt709` → `bt709`, `smpte170m`/`bt470bg` → `bt601`, `bt2020nc`/`bt2020c`/`bt2020` → `bt2020` with `CUTHOL-G208` note).
    2. Untagged YUV sources follow standard player heuristics: `height >= 720` or `width >= 1280` → `bt709`, smaller SD sources → `bt601`; untagged range defaults to `tv`.
    3. RGB/still sources (PNG, JPG, HyperFrames PNG sequences, single-frame PNGs, FFV1 BGRA) scale in RGB (`format=rgba`) and apply the BT.709 (`tv` range) matrix only when converting to output YUV; HyperFrames `.mp4`/`.mov` blobs are probed for their stream color tags.
  - All render paths (single-pass, segmented, `monitor.frame`, `monitor.sheet`, `composition.preview`) output in Rec. ITU-R BT.709 (`tv` range) and tag output streams as `tv/bt709` (`color_space`, `color_primaries`, `color_transfer`, `color_range`).
  - Cuthol's composite encode selects a video encoder in vendor priority order: `h264_nvenc` (NVIDIA) → `h264_amf` (AMD) → `h264_qsv` (Intel) → `h264_vaapi` (Linux) → `h264_videotoolbox` (macOS) → `libx264` (CPU fallback). Override via `CUTHOL_ENCODER=auto|nvenc|amf|qsv|vaapi|videotoolbox|x264` (legacy `CUTHOL_DISABLE_NVENC=1` and `CUTHOL_VIDEO_ENCODER` remain supported).
  - Every hardware encoder is verified on first use by encoding a short SMPTE HD color-bars clip and checking frame-aligned RGB PSNR (>= 38 dB) and per-bar color channel drift against a `libx264` BT.709 reference (results are cached per machine/driver/FFmpeg fingerprint). Any encoder that fails initialization or color accuracy verification is skipped and its reason is recorded in `encoder_fallback`.
  - During parallel segment encoding on long timelines, concurrent hardware encoder sessions are bounded (`CUTHOL_HW_ENCODER_SESSIONS`, default `2`), and if any segment hits a hardware session limit or stalls, that segment falls back to `libx264` and `encoder_fallback` reports the fallback.
  - The render result reports `encoder`, `encoder_fallback` (`{ from, to, reason }`), and stage `timings_ms` (`verify_ms`, `compile_and_overlays_ms`, `encode_ms`, `blank_scan_ms`, `edge_strip_scan_ms`, `audio_health_ms`, `total_ms`).
While `render` runs it writes stderr lines prefixed `cuthol:progress `, at most about every two seconds. Each line names the stage, `n/N` when a count is known, and a remaining-time estimate from that stage's speed. Stdout stays the JSON envelope, or the compact text when `--compact` is set. Compact text and MCP add one line such as `Checks: blank 0/10212 · audio ok (9 points) · encoder h264_nvenc` (blank frames over total frames, audio point count and whether any point failed, encoder). In that text, `overlays.rerendered` keeps the summary plus the first five compositions; the JSON envelope still lists every composition. A cold overlay with no saved state file for that composition reports `new`. If a state file exists, the hashes still match, and the blob file is gone, the reason is `blob_missing`.

- **Progress watchdog (no wall-clock limit):** Renders and analysis passes have no wall-clock duration cap — a long render that keeps advancing is never interrupted. A progress watchdog monitors `ffmpeg` (`-progress` frame/timestamp/size advancement and output streams) and HyperFrames (output stream and written file/directory growth); if progress stops for `CUTHOL_STALL_TIMEOUT_SEC` (default `300` seconds = 5 minutes; `0` disables the watchdog; initial startup wait before first output configurable via `CUTHOL_STALL_STARTUP_TIMEOUT_SEC`), the stuck process tree is terminated and reported as `CUTHOL-SYS10` (after one automatic `libx264` retry if the stalled step used any hardware encoder, recording `encoder_fallback.reason = "stalled"`).
- **Long multi-clip timelines:** Sequences with many spine clips or lane cues (>24 clips per segment by default, configurable via `CUTHOL_RENDER_SEGMENT_MAX_CLIPS`) are automatically compiled and rendered in frame-exact time segments (`vseg_*.mp4`) with sample-exact 48 kHz float32 PCM audio segments (`aseg_*.wav`), passing filtergraphs via `-/filter_complex` script files and concatenating without re-encoding video. Simultaneous decoder instances and command-line length remain bounded regardless of total clip count, while preserving transitions, compositions, envelopes, subtitles, and `mix.normalize` loudness calibration across segment boundaries.

After encoding, `render` automatically scans the output video for blank/backdrop-filled frames while a spine clip is active (ignoring intentional fade windows) and reports any drop-outs as `CUTHOL-G502` warnings with exact timestamps, checks the right/bottom edges in a single FFmpeg pass for 8 px black strips (`CUTHOL-G506`, timed in `timings_ms.edge_strip_scan_ms`), and in a graphics-only project (empty spine) scans the frames where no visual cue is on screen (event `clip_id` is empty); frames drawn by compositions are not judged by brightness, because a composition that fails to render already stops the render (G503). It also runs a post-render audio health check (`audio_health`), correlating rendered audio windows against source audio across segment boundaries and delayed cues and emitting `CUTHOL-G508` if any timing drift or signal drop-out is found.

After rendering, sample frames of the **output file** (CLI: `ffmpeg -ss 4.2 -i out.mp4 -frames:v 1 f.png`; MCP: `monitor.frame` shows the same pipeline). Deliver only after verify shows 0 errors, the warnings are understood, and you have looked at the frames.
