# Beat grid vs onsets, in detail

`library.beats(handle="aud_02", sensitivity=1.35)` computes and caches **two
distinct beat layers** (summarized separately in `digest.grid` and
`digest.onsets`):

1. **Regular beat grid (`grid`):** tempo (`grid_bpm` / `estimated_bpm`, with
   octave/sub-harmonic resolution in `[80..160]` BPM reported in
   `tempo_resolution`) and phase (`phase_ms`, `beat_period_ms`) estimated via
   autocorrelation + comb filtering. A uniform, gap-free pulse across the
   entire track (`grid_ms`, `grid_count`), including across quiet intros, pads
   or breakdowns (`grid_ms` is empty only if the audio has no periodic pulse).
   The grid is **independent of `sensitivity`**. For backward compatibility,
   `beats_ms` equals `grid_ms` when a grid exists (otherwise `onsets_ms`).
2. **Detected transient peaks (`onsets`):** spectral-flux onset peaks (`onsets:
   [{ time_ms, strength }]`, `onsets_ms`, `onsets_count`) selected via
   strength-descending non-maximum suppression. `sensitivity` (`0.8..3.0`,
   default `1.35`; **higher value = lower threshold = more onsets detected**)
   only scales `onsets` while `grid_bpm` and `grid_ms` stay locked.

## Querying

- `library.query(handle="aud_02", kind="beats", range="0s..10s")` returns the
  regular `grid` beats by default (`kind: "grid"`).
- `library.query(handle="aud_02", kind="beats", text="onset", range="0s..10s")`
  (or `text="transient"`) returns the detected onset peaks with `strength`.

## Aligning cuts

`mix.beat_align(bgm_handle="aud_02", clips?, mode="grid" | "onsets", grid?,
sensitivity?, tolerance?, preserve_duration?)`:

- Defaults to `mode="grid"` (`grid=true`, `align_mode: "grid"`), snapping cuts
  to the regular `grid_ms` pulse (falling back to `onsets_ms` only if the track
  has no periodic grid). Pass `mode="onsets"` (or `grid=false`) to snap to raw
  transient peaks instead (`sensitivity` affects `mode="onsets"`). Onsets land
  closer to the audible hit on percussive music; the grid keeps a steady pulse
  through breakdowns and pads.
- Clips snapped within tolerance whose duration actually changes (`shift_ms !=
  0`) are recorded as `SHIFTED_TO_BEAT` in `aligned_clips` / `decision_trace`;
  cuts already on the beat (`shift_ms == 0`) are `ALREADY_ON_BEAT`.
- Clips whose nearest beat is farther than `tolerance` are left unchanged and
  reported in `skipped_clips` / `decision_trace` as `OUT_OF_TOLERANCE` (or
  `NO_VALID_BEAT_IN_RANGE` when constrained by source length or transition
  budget).
- Check `old_total_duration_ms`, `new_total_duration_ms`,
  `total_duration_delta_ms`, and `duration_warning`. Pass
  `preserve_duration=true` to adjust the final clip so total spine duration
  stays close to the original, or pass a narrower `tolerance` (e.g.
  `tolerance="180ms"`).
