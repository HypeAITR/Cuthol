---
name: cuthol-audio
description: >
  Mix audio in Cuthol: loudness measurement and mix.normalize to a LUFS target,
  mix.polish_voice noise cleanup, mix.duck music ducking under speech, beat
  grid and onset analysis, mix.beat_align cuts to the beat, music and effects
  lanes, composition sound stems, and post-render audio health. Load when
  balancing levels, ducking music, cutting to beats, or chasing drift and gaps.
---

# Audio mix: loudness, ducking, beats

## Loudness

- `library.loudness(handle)` measures integrated LUFS, loudness range and true
  peak of one asset.
- `mix.normalize(target_lufs=-14, true_peak=-1, clips?)` first assigns per-item
  pre-gain (`applied_gain_db`) to unmuted spine clips and `ln_vo` voiceovers
  within each item's true-peak headroom (`TRUE_PEAK_CLAMPED` vs `APPLIED`), then
  measures the **compiled full-sequence master mix** and calibrates the master
  bus gain (`master_gain_db`) to hit `target_lufs` (`MASTER_MIX_CALIBRATED`, or
  `TARGET_NOT_REACHED` if limited by the ceiling). Muted items are never
  adjusted (`skipped_muted_count` reports how many were skipped). Run it after
  all audio items and ducking are in place — and re-run it after any rebuild.
- Check the `Loudness:` line: `measured_mix_before_lufs`, `achieved_lufs`,
  `achieved_true_peak_dbtp`, `master_gain_db`, `target_reached`, plus
  `adjusted_clips_count` (first 8 items by default; `verbose=true` for all).
- `mix.polish_voice(clips?, nr_db=12, clarity=true)` adds denoise (`afftdn`) +
  high-pass + presence boost + gentle compression. For stronger surgery, clean
  the file outside (high-pass, `afftdn`, gentle EQ) and ingest the result.
- G501 means a true peak above −1 dBTP — lower `gain_db` or re-run normalize.
- Speed-ramped spine clips render audio on the same time map as video (±1
  frame); ramps outside 0.5..2.0 warn G410. For click/transient-only tracks
  prefer `preserve_pitch=false` (sample-accurate resampling; pitch is
  meaningless for impulses).

## Ducking music under speech

`mix.duck(bgm_lane="ln_bgm", duck_db=-12, attack="120ms", release="350ms",
lang?)` writes a gain envelope on the music cues: down while someone speaks,
back up in pauses (gaps ≤ `max(600ms, attack + release)` merge to avoid
pumping).

- Speech windows come from **transcripts**. Transcribe the voiceover / talking
  clips first. Spine clips without a transcript are skipped as triggers when
  other speech exists (G504); if nothing is transcribed, Cuthol falls back to
  an acoustic voice-activity guess (`ACOUSTIC_VAD_FALLBACK`) — less reliable.
- If speech starts at `0s` (or within `attack` of the music start), the first
  envelope point starts already attenuated or mid-ramp rather than at 0 dB.
  This is intentional, so the opening syllable is not buried.
- See the curve on `monitor.timeline`.

## Beats and cutting to the beat

`library.beats(handle="aud_02", sensitivity=1.35)` caches **two beat layers**:
the regular tempo/phase **grid** (`grid_bpm`, `phase_ms`, `grid_ms` — a uniform
pulse across the whole track, independent of `sensitivity`) and detected
transient **onsets** (`onsets: [{time_ms, strength}]`; higher `sensitivity`
0.8..3.0 = lower threshold = more onsets).

- `library.query(handle, kind="beats", range="0s..10s")` returns grid beats;
  `text="onset"` returns onset peaks with `strength`.
- `mix.beat_align(bgm_handle="aud_02", clips?, mode="grid"|"onsets", …)` snaps
  each target clip's end to the nearest beat **only within `tolerance`**
  (default half a beat period, clamped to `120..500ms`). `mode="grid"` (default)
  snaps to the regular pulse; `mode="onsets"` snaps to transient peaks
  (`sensitivity` applies). Snapped cuts report `SHIFTED_TO_BEAT` (or
  `ALREADY_ON_BEAT`); untouched ones report `OUT_OF_TOLERANCE` (or
  `NO_VALID_BEAT_IN_RANGE`). Check the total-duration delta; `preserve_duration=
  true` adjusts the final clip to keep it, or pass a narrower `tolerance`.
- Full grid/onset semantics: `references/beats.md`. Inside compositions,
  `C.beats()` returns onsets, `C.beats({grid:true})` / `C.beatGrid()` the grid
  (see `cuthol-motion`).

## Music and effects lanes

Place music on `ln_bgm` and effects on `ln_sfx` with `lane.add_cue` (anchor
effects to the cue or clip they belong to, so cuts move them together). Music
and effects can also come from a provider shelf (`library.search` /
`library.fetch` — see `cuthol-speech`). Keep effect levels well under the
voice; start low.

## Sound inside compositions (per-cue stem)

A composition cue whose HTML holds audible `<audio>` or `<video>` (including
`<hf-audio-group>` buses, volume automation and fx chains) brings that sound
into the Cuthol mix as a **stem**: the engine's own mix of the composition,
rendered to a 48 kHz stereo file cached beside the overlay blobs.

- Placement: the stem starts at the cue's lane start and plays from
  composition time 0 at rate 1 (like the picture), cut at the cue duration.
- It follows the cue like any audio cue: `gain_db`, `muted`, lane mute,
  envelopes; `mix.normalize` pre-gains it (from the cached stem) and measures
  it in the master mix; on `ln_vo` its whole span counts as dialogue for
  `mix.duck`. Measurement and render use the same audio compiler.
- The stem is extracted on the first render or mix measurement after the
  composition files, used data or props change; unchanged compositions reuse
  it. An opaque (mp4) overlay supplies it from its own blob; otherwise one
  extra draft render of the composition produces it.
- Compositions without audible elements produce no stem and no change to the
  render plan.
- Switch per cue: `lane.update_cue(cue, composition_audio="off")` (or
  `lane.add_composition(..., composition_audio="off")`) keeps the composition
  silent; `"mix"` (default) turns it back on. Journaled and undoable.
- `verify` reports the state per cue: `CUTHOL-G416` INFO when the stem is in
  the mix (cue, ms of audio, the off switch) or when it is `off`; G416 WARN
  while no stem has been extracted yet; `CUTHOL-G435` WARN with the reason when
  extraction failed; `CUTHOL-G436` INFO when the engine rendered silence.
- JS-created audio (Web Audio built in script) is only included if the engine
  itself renders it into its own audio track; if it does not, the stem is
  silent and `verify` says so with G436. Prefer `<audio>` elements.

## Drift and gaps: how audio breaks and how to catch it

- Every render runs a post-render audio health check and reports timing drift
  or signal drop-outs as `CUTHOL-G508` (ramp-aware on ramped clips;
  `inconclusive` on periodic signals, where correlation cannot measure shift).
- When you measure sync yourself, use **sparse, sharp events** (a 1-frame white
  flash plus a simultaneous short click, once a second): measure the event
  times separately in picture and in sound. To hunt drop-outs, use **continuous
  noise** (pink noise shows a ≥ 3 ms full-silence gap anywhere). Never treat a
  health warning as a defect until a measurement confirms it — and never claim
  a root cause from a re-synthesis outside the real render; verify against the
  actual output file.
- Cutting media outside Cuthol and concatenating the pieces drifts picture
  against sound (video rounds to frames, audio keeps exact length) — round both
  to the same frame grid (see `cuthol-editing`). If a splice must be sample
  precise, compare source and output with correlation, not by ear.
