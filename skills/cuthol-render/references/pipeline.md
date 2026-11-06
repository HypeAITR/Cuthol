# Render pipeline details

## Concurrent overlay pre-pass (`K` × `W`)

Before compiling the final filtergraph, uncached overlays are collected and
rendered up to `K` at a time (`concurrency`), each using `W` HyperFrames
workers (`workers`).

- `W` (workers per composition): defaults to `1` on Windows/macOS (preserving
  single-worker streaming encode without separate chunk-encode overhead) and
  `2` on Linux (`1` on ≤ 2 cores); override via `workers` (`render --workers
  <W>`) or `CUTHOL_WORKERS`.
- `K` (concurrent overlay processes): defaults to `floor(logical_cores / W)`,
  bounded by total RAM (~40% budget at ~1.0 GB per `W` worker tree), current
  free RAM (keeping ≥ 0.8 GB free headroom at ~350 MB per headless Chrome
  worker), and the number of cold overlays; override via
  `CUTHOL_OVERLAY_CONCURRENCY=<K>` (`1` forces sequential). If one overlay
  fails in a batch, siblings finish and cache normally before `CUTHOL-G503`
  (or `CUTHOL-SYS10`) is raised.
- **Render slot:** HyperFrames normally runs one local render at a time per
  user account (a second waits on a lock file). Cuthol sets
  `HYPERFRAMES_RENDER_LOCK=off` on every HyperFrames process it spawns so
  concurrent overlay renders run side by side. An explicitly set, non-empty
  user value wins: `HYPERFRAMES_RENDER_LOCK=1` re-enables the machine-wide
  slot (the parallel pre-pass then queues).

## Alpha intermediates and opaque fast paths

- Transparent (`overlay_alpha`) compositions over moving footage are captured
  as a lossless 8-bit straight RGBA PNG directory
  (`.cuthol/blobs/hf_comp_<hash>.pngseq/`) via `hyperframes render --format
  png-sequence` (staged in a temp dir, atomically renamed after verifying
  frame count) and read directly by FFmpeg with an explicit BT.709 (`tv` range)
  conversion.
- Very long alpha overlays (≥ `CUTHOL_ALPHA_FFV1_MIN_FRAMES`, default `3600`
  frames = 2 min at 30 fps; `0` disables threshold packing) or
  `CUTHOL_ALPHA_FORMAT=ffv1` pack the PNG sequence into a single lossless RGBA
  FFV1 `.ffv1.mov` with exact `1/fps` timing (`CUTHOL_ALPHA_FORMAT=png|ffv1|mov`
  overrides).
- Full-frame compositions with no moving footage underneath (only backdrop or
  a static still) render directly as an opaque MP4 with the backdrop baked in,
  skipping a second encode (`single_stage: true`) when no upper visual layers
  exist. Opaque, full-frame, untransformed, transition-less, envelope-less
  footage clips also skip the `format=rgba` conversion.
- A failed sub-composition script (one timeline alive, another throwing) is
  skipped with an empty timeline by the renderer — that overlay part comes out
  blank. Cuthol reports it in `overlays.script_errors` + `overlays.diagnostics`
  (persisted in the blob `.meta.json`, so warm renders keep warning) and as
  `CUTHOL-G415`. A lone failing composition stops the render (`CUTHOL-G503`).

## Colour pipeline and encoder chain

Every source input selects its matrix and range from metadata (`probe.color_
space`, `probe.color_range`, `probe.pix_fmt`; legacy entries missing colour
fields are re-probed once and cached):

1. Tagged YUV uses its declared matrix and range (`bt709` → `bt709`,
   `smpte170m`/`bt470bg` → `bt601`, `bt2020nc`/`bt2020c`/`bt2020` → `bt2020`
   with a `CUTHOL-G208` note).
2. Untagged YUV follows player heuristics: `height >= 720` or `width >= 1280`
   → `bt709`, smaller SD → `bt601`; untagged range defaults to `tv`.
3. RGB/still sources (PNG, JPG, HyperFrames PNG sequences, FFV1 BGRA) scale in
   RGB and apply the BT.709 (`tv`) matrix only when converting to output YUV.

All render paths output Rec. ITU-R BT.709 (`tv` range) and tag streams as
`tv/bt709`. The encoder chain is `h264_nvenc` → `h264_amf` → `h264_qsv` →
`h264_vaapi` → `h264_videotoolbox` → `libx264`, each hardware encoder verified
on first use by encoding SMPTE colour bars and checking PSNR (≥ 38 dB) and
per-bar drift against a `libx264` BT.709 reference (cached per
machine/driver/FFmpeg fingerprint). Parallel segment encoding bounds concurrent
hardware sessions (`CUTHOL_HW_ENCODER_SESSIONS`, default `2`); a segment hitting
a session limit or stalling falls back to `libx264` (`encoder_fallback`
records it). The result reports `encoder`, `encoder_fallback`, and stage
`timings_ms` (`verify_ms`, `compile_and_overlays_ms`, `encode_ms`,
`blank_scan_ms`, `edge_strip_scan_ms`, `audio_health_ms`, `total_ms`).

## Segmented rendering

Sequences with many clips/cues (> 24 clips per segment,
`CUTHOL_RENDER_SEGMENT_MAX_CLIPS`) compile and render in frame-exact time
segments (`vseg_*.mp4`) with sample-exact 48 kHz float32 PCM audio segments
(`aseg_*.wav`), passing filtergraphs via script files and concatenating without
re-encoding video. Decoder instances and command-line length stay bounded
regardless of total clip count; transitions, compositions, envelopes,
subtitles and `mix.normalize` calibration survive the boundaries.
