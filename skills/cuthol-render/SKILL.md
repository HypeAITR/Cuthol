---
name: cuthol-render
description: >
  Render a Cuthol edit to video: draft_480p and master_1080p presets,
  overlay cache and re-render reasons, overlay-res handoff, encoder selection,
  render progress and watchdog, long timelines, and post-render blank, edge
  and audio checks. Load when rendering, re-rendering, or diagnosing a render.
---

# Render: drafts, masters, cache, checks

`render(preset="draft_480p")` for checks, `render(preset="master_1080p")` for
delivery (default output `output/render_r<revision>_<preset>.mp4` in the
project; CLI `--out`, MCP `out`). `verify()` must show 0 errors first, and the
warnings must be understood. After rendering, sample frames of the **output
file** (CLI: `ffmpeg -ss 4.2 -i out.mp4 -frames:v 1 f.png`; MCP:
`monitor.frame` shows the same pipeline) before delivering.

ffmpeg/ffprobe below 8.x warn (`CUTHOL-G212`, from the render-start verify):
Cuthol is tested with 8.x — install it when the warning appears.

## Overlay cache: why things re-render

Overlays render once and cache in `.cuthol/blobs/`, keyed only by what affects
their pixels: composition files (HTML/JS/CSS, media, fonts, bridge runtime,
extension helper/asset copies), the **used** window-local data slice (only the
`C.*` slices the composition references — words, audio, beats, cuts, cue
position), the **used** `C.global.*` slices, props, and the backdrop underneath
(unless the root declares `data-cuthol-opaque="true"`, for compositions that
paint their own opaque full-frame surface for their whole duration — never
declare it with any transparency, mask or fade-in).

Every render reports `overlays: { total, cached, rendered, reasons,
elapsed_ms, rerendered, summary }`: how many overlays hit cache, why any
re-rendered, and total overlay time. Reasons: `new` (no saved state),
`html_changed`, `renderer_version_changed` (HyperFrames version tag changed),
`slice_changed`, `global_used_changed`, `props_changed`, `backdrop_changed`,
`blob_missing` (state matches, blob file gone). Finish extension/kit edits
before taking drafts: one changed rule re-renders every composition using it.

Resolution handoff: `draft_480p` captures overlays at 480p under a separate
key without touching master blobs — and reuses an already-cached master blob
when the state matches. `--overlay-res native` on `draft_480p` (or
`CUTHOL_DRAFT_OVERLAY_RES=native`; the flag wins) captures each overlay at
master resolution and scales down for the 480p picture, so the following master
is a cache hit (`overlays.summary` says `native capture for master reuse`).
The draft takes longer because the capture is full size. `master_1080p`
ignores the option.

## Encoders and colour

The composite encode picks `h264_nvenc` (NVIDIA) → `h264_amf` (AMD) →
`h264_qsv` (Intel) → `h264_vaapi` (Linux) → `h264_videotoolbox` (macOS) →
`libx264` (CPU fallback); override with `CUTHOL_ENCODER=auto|nvenc|amf|qsv|
vaapi|videotoolbox|x264` (CLI `--encoder auto|nvenc|libx264`). Every hardware
encoder is verified once against a `libx264` colour reference and skipped on
failure (`encoder_fallback` records why). All paths output Rec. ITU-R BT.709
(tagged `tv/bt709`); untagged HD sources assume BT.709, SD sources BT.601,
BT.2020 sources convert with a G208 note. Workers: `--workers <W>`
(`CUTHOL_WORKERS`); concurrent overlays: `CUTHOL_OVERLAY_CONCURRENCY=<K>`
(`1` forces sequential). Pipeline details: `references/pipeline.md`.

## Progress, watchdog, long timelines

While `render` runs it writes stderr lines prefixed `cuthol:progress ` (about
every 2 s): stage, `n/N` when known, and a remaining-time estimate. Stdout
stays the JSON envelope, or compact text with `--compact`. Compact/MCP text
adds a `Checks:` line (blank frames over total, audio points, encoder).

Renders have no wall-clock cap — a render that keeps advancing is never
interrupted. A progress watchdog kills the stuck process tree if progress stops
for `CUTHOL_STALL_TIMEOUT_SEC` (default 300 s; `0` disables; startup grace via
`CUTHOL_STALL_STARTUP_TIMEOUT_SEC`) and reports `CUTHOL-SYS10` (after one
automatic `libx264` retry if a hardware encoder stalled).

Long multi-clip timelines (> 24 clips per segment, `CUTHOL_RENDER_SEGMENT_
MAX_CLIPS`) compile and render in frame-exact time segments and concatenate
without re-encoding video, preserving transitions, compositions, envelopes,
subtitles and loudness calibration across boundaries. A whole-video pace change
(e.g. 1.1x delivery) has no in-app path: re-encode the master outside and
re-check loudness on the delivered file.

## How long it takes (orientation, one machine)

Timings scale with overlay count and footage, not just duration: a ~5-minute
edit with ~45 compositions rendered a cold draft in ~4.5 min and a cold master
in ~10–11.5 min; the same master with unchanged compositions re-rendered in
~0.5–1.5 min (overlay cache hit). A 15 s test (3 clips + 1 composition) took 21
s for a master. Screen-capture footage costs extra (per-clip frame-rate
conversion). Your machine will differ — use these only to tell "normal" from
"something is stuck" (then check `cuthol:progress` lines and the watchdog).

## Post-render checks (automatic + yours)

Automatic, every render: blank/backdrop-frame scan while a spine clip is
active (ignoring intentional fades; in graphics-only projects, frames with no
visual cue) → `CUTHOL-G502` with timestamps; right/bottom edge scan for 8 px
black strips → `CUTHOL-G506`; audio health (drift, drop-outs, silent gaps
while the source is loud) → `CUTHOL-G508`. `blank_frames_count` must be 0.

Yours: sample the output file every couple of seconds and look at every frame
(video-carrying scenes especially — the monitor has shown a different size
than the render in the past); re-measure loudness on the rendered file
(`ffmpeg -i out.mp4 -af ebur128=peak=true -f null -`); on loudness-critical
work, correlate the output against the source mix and require zero suspect
points.
