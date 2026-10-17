# Speech and audio mix

## Transcription

`speech.transcribe(handle, lang="tr")` sends the asset to the ASR provider once and caches the result by file content (re-running is free). It returns a digest: word count, words per minute, low-confidence spans (`attention`), a short preview and query hints. Read words with `library.query(handle, kind="transcript", range="3s..6s" | text="moonstar", format="default" | "compact")` — the text search ignores Turkish diacritics and case.

- **Compact word index (`format="compact"`):** `library.query(handle="aud_01", kind="transcript", format="compact")` returns `i:word@sec` strings (e.g. `"0:Kısaca,@0.08"`, default `limit=600`) so hundreds of words come back in a single MCP/CLI call without pagination. The index `i` matches `C.global.words[i]` inside compositions. Omit `format` (or pass `format="default"`) for full word objects (`{index, word, source_start_ms, source_end_ms, confidence}`).
- Transcribe the **asset** (`vid_01`, `aud_01`), not a clip. Words are projected onto every clip and voiceover cue that uses that asset, and they stay correct after trims, speed changes (both `spine.speed` and `lane.update_cue(cue, rate=…)`) and cuts.
- Transcripts and synthesized voiceovers are cached both in the project (`.cuthol/ledger.sqlite`) and in the user-level shared cache (`~/.cuthol/cache/ledger.sqlite` + `blobs/`, configurable via `CUTHOL_CACHE_DIR`, disabled via `CUTHOL_CACHE_DIR=0` or `CUTHOL_DISABLE_SHARED_CACHE=1`), so reusing the same media file or TTS text across projects hits the cache without calling cloud APIs.
- Brand names and rare proper nouns are often misheard. Check them with `library.query(text=…)` before building captions or word-locked animations on them.
- Providers: `deepgram` (default, needs `DEEPGRAM_API_KEY`) or `local` (needs a `<file>.transcript.json` sidecar or `CUTHOL_LOCAL_ASR_CMD`).

## Voiceover

`speech.synthesize(text, voice?, speed?, place_on_lane="ln_vo", at | anchor+offset)` creates a `vo_XX` asset with exact word timings from the TTS itself (no ASR pass needed, spelling is preserved). Default provider `elevenlabs` (needs `ELEVENLABS_API_KEY`). `provider="local"` without `CUTHOL_LOCAL_TTS_CMD` gives placeholder tones (`is_placeholder_audio: true`) — fine for timing tests, not for delivery.

To use an existing narration file instead: `library.ingest` it, place it with `lane.add_cue(lane="ln_vo", kind="voiceover", asset=…, at=…, duration=<its length>)`, then `speech.transcribe` it. To speed up or slow down the voiceover inside Cuthol (without pre-converting in ffmpeg), call `lane.update_cue(cue="cue_01", rate=1.3)` (or pass `rate=1.3` to `lane.add_cue`); Cuthol updates the cue duration, runs `atempo` (pitch-preserved by default, `preserve_pitch=true`) in the shared audio graph, and scales all projected word timestamps in `C.global.words` / `C.word` and `speech.captions`.

## Cleaning up talking clips (single clip or entire spine)

`speech.cleanup(clip?, clips?, all_spine?, min_pause="400ms", pad="75ms", remove_pauses, remove_fillers, remove_repetitions=false, cut_candidates?, lang?, dry_run?, verbose?, limit?, cursor?)`:

1. **Whole spine in one atomic call:** Omit `clip` (or pass `all_spine=true`, or `clips=["sp_01","sp_02",...]`) to clean every transcribed clip on the spine in a **single atomic operation** (one journal entry, one `workspace.undo`). You can also pass a single `clip="sp_01"`.
2. **Inspect candidates first (`dry_run=true`):** Over MCP, the dry-run response includes:
   - `Candidates`: the pause/filler decision table across all target clips (paginate with `cursor` / `limit`),
   - `Review candidates` (`review_candidates`): contextual discourse fillers (`yani`, `şey`, `hani`, `acaba`) spoken in fluent clauses, with **persistent source-anchored IDs** (`cf_<asset>_<start>_<end>`, e.g. `cf_vid_01_16785_16945`),
   - `Repetition / restart candidates` (`repetition_candidates`): 2–6 word phrase repeats (including Turkish inflectional stem matches, skipped filler particles, and 1-slot lexical substitutions), clause/sentence restarts, and word repeats, with **persistent source-anchored IDs** (`rr_<asset>_<start>_<end>`, e.g. `rr_vid_01_36470_44645`), each listing all `attempts` (`#1`, `#2`, …), `suggested_cut_start_ms..suggested_cut_end_ms`, `suggested_keep_attempt`, and surrounding `context`.
3. **Agent decides which candidates to cut (`cut_candidates`):** Neither contextual fillers in fluent speech nor repetition/restart candidates are ever cut automatically (`remove_repetitions` defaults to `false`). Pass `cut_candidates` to `speech.cleanup` (without `dry_run`) to cut your chosen candidates alongside pauses in a single atomic call:
   - Cut a contextual filler or a repetition group using its suggested cut: `cut_candidates=["cf_vid_01_16785_16945", "rr_vid_01_36470_44645"]`
   - Choose which attempt inside a repetition/restart group to **keep** (cutting the other attempts): `"rr_vid_01_52010_54810:keep=1"`
   - Cut only a specific attempt inside a group: `"rr_vid_01_36470_44645#1"` (or `":cut=1,2"`)
   - Cut by explicit source range: `"36150..42880ms"` (or `"vid_01:36150..42880ms"`).
   Detection is deliberately broad: it would rather show a candidate you reject than miss one. Suggested cuts are a starting point, not a safe default. On a 12-minute talk the suggestions covered about 3.9 minutes, of which about 2.4 minutes were content a careful editor kept (emphasis, a model name said twice on purpose, a meaningful clause). Read each candidate's `context` and decide one by one; never pass every `rr_` id wholesale.
   Because candidate IDs are anchored to `(asset_handle, source_start_ms, source_end_ms)` rather than clip order, an ID seen in `dry_run` still refers to the exact same word/phrase in subsequent calls even after the spine has been split into many clips.
4. Look at the result (`monitor.sheet` around the cuts) and listen-check by rendering a draft if timing matters.

How candidates, edges and remnants are handled:
- **Pauses and word boundaries:** A pause candidate that overlaps an ASR word is not discarded blindly — it is trimmed to the word-free gap (`TRIMMED_TO_WORD_GAP`). If the remaining gap after trimming is `< min_pause`, it is rejected with `OVERLAPS_WORD`.
- **Acoustic edge verification (pauses and selected candidates):** Cut edges — both for automatic pauses and for agent-selected `cut_candidates` — are tightened to 25 ms RMS windows below the recording-relative `silence_floor_dbfs` so neighboring kept word tails and onsets are never clipped. If the acoustically silent region left in a pause is `< min_pause`, the candidate is rejected with `ACOUSTIC_GAP_TOO_SHORT`. `pad` (default `75ms`) keeps breathing room around speech; if collar padding leaves `< 80ms`, it is rejected with `COLLAR_PAD_EXHAUSTED`.
- **Untranscribed audio inside a pause:** If a pause or boundary gap contains > 120 ms of active audio not present in the transcript (e.g. a voiced hesitation `"ııı"`, breath/cough, or a word missed by ASR), that audio is **preserved** (`UNTRANSCRIBED_AUDIO` in `decision_trace` with its exact source `span`) and the cut is split or shortened around it (`SPLIT_AROUND_UNTRANSCRIBED_AUDIO`). If you verify that the preserved span is an unwanted voiced filler, you can remove it explicitly with `cut_candidates=["start..end"]` or `spine.excise`.
- **No `< 150 ms` remnant slivers:** If a cleanup cut would leave a `< 150 ms` remnant at a clip boundary or between two cuts, and that remnant contains no kept speech, it is merged into the adjacent cut (`APPLIED_WITH_SLIVER_MERGE`); if a `< 150 ms` silent remnant clip already exists on a multi-clip spine from an earlier manual edit, full-spine cleanup removes it (`SHORT_SILENT_REMNANT_REMOVED`). If a `< 150 ms` gap between cuts contains a spoken word, the adjacent pause cut is retracted or rejected (`AVOID_SHORT_REMNANT_CLIP`) so spoken words are never clipped. `verify` also flags any spine clip `< 150 ms` with `CUTHOL-G309` (`WARN`).
- **Compact output:** `decision_trace.rules` is included only when `dry_run=true` (or `verbose=true`).

## Captions

`speech.captions(style="active_word" | "sentence" | "boxed", clip?, all_spine?, max_words?, max_chars?, lang?, replace?)` builds caption cues on `ln_captions` from the transcripts of spine clips **and** `ln_vo` voiceover cues (`all_spine=true` to skip voiceovers).

- **Every unexcised word is shown:** Captions include all spoken words that remain in the edit after cuts/cleanup. The `is_filler` / `is_repetition` flags only affect `speech.cleanup` candidacy — if a word was not excised from the timeline, it appears in the captions so text and audio never diverge.
- **Stage-scaled defaults:** On vertical `9:16` (`1080x1920`), auto-captions default to `64 px` font size, `70%` max width, `max_words=4` and `max_chars=26` per line (wrapping into at most 2 lines inside the safe zone). On landscape `16:9` (`1920x1080`), they default to `42 px` font size, `80%` max width, `max_words=5` and `max_chars=38` per line.
- Generate captions **after** cleanup and other cuts; use `replace=true` to rebuild them after later edits.
- `active_word` highlights the word being spoken. Reading speed (CPS) is checked using the **project/transcript language**, not character heuristics: `19 CPS` for Turkish (`tr`, including ASCII-only Turkish words like `"modelleri."`) and `17 CPS` for English (`en`); fast groups produce G402 — lower `max_words`.
- Captions sit at `y=26` (lower third). Move them with `lane.update_cue` if they collide with other text (G403 warns about occlusion).

## Loudness

- `library.loudness(handle)` measures integrated LUFS, loudness range and true peak.
- `mix.normalize(target_lufs=-14, true_peak=-1, clips?)` first assigns per-item pre-gain (`applied_gain_db`) to spine clips and `ln_vo` voiceovers within each item's true-peak headroom (`TRUE_PEAK_CLAMPED` vs `APPLIED`), then measures the **compiled full-sequence master mix** (`amix` + envelopes + filters + `alimiter`) with `ebur128=peak=true` and calibrates the master bus gain (`master_gain_db`) to hit `target_lufs` (`MASTER_MIX_CALIBRATED`, or `TARGET_NOT_REACHED` if limited by the ceiling).
- Check the `Loudness:` line (MCP) or result fields: `measured_mix_before_lufs`, `achieved_lufs`, `achieved_true_peak_dbtp`, `master_gain_db`, `target_reached` (`true`/`false`), `adjusted_clips_count`, and `warning` (if `target_reached=false`). By default, `adjusted_clips` lists the first 8 items (`adjusted_clips_omitted` shows the remaining count); pass `verbose=true` (`--verbose` / `--detailed` on CLI) for the full per-clip list. Run `mix.normalize` after all audio items and ducking are in place.
- `mix.polish_voice(clips?, nr_db=12, clarity=true)` adds denoise (`afftdn`) + high-pass + presence boost + gentle compression.
- G501 means a true peak above −1 dBTP — lower `gain_db` (`lane.update_cue(cue, gain_db=…)` or a spine envelope) or re-run normalize.

## Ducking music under speech

`mix.duck(bgm_lane="ln_bgm", duck_db=-12, attack="120ms", release="350ms", lang?)` writes a gain envelope on the music cues: down while someone speaks, back up in pauses (gaps ≤ `max(600ms, attack + release)` are merged to avoid pumping).

- Speech windows come from **transcripts**. Transcribe the voiceover / talking clips first.
- If speech or voiceover starts at `0s` (or within `attack` of the music cue's start), the very first envelope point at `offset_ms: 0` starts already attenuated at `duck_db` (e.g. `-12 dB`) or mid-ramp (e.g. `-4.67 dB`) rather than `0 dB`. This is normal and intentional so the opening syllable is not buried under full-volume music.
- Spine clips without a transcript are skipped as triggers when other speech exists (G504, listed as `NO_TRANSCRIPT_SKIPPED` in `decision_trace`). If nothing is transcribed, Cuthol falls back to an acoustic voice-activity guess (`ACOUSTIC_VAD_FALLBACK`) — less reliable.
- See the curve on `monitor.timeline`.

## Cutting to the beat (`grid` vs `onsets`)

- `library.beats(handle="aud_02", sensitivity=1.35)` computes and caches **two distinct beat layers** (both summarized separately in `digest.grid` and `digest.onsets`):
  1. **Regular beat grid (`grid`):** Tempo (`grid_bpm` / `estimated_bpm`, with octave/sub-harmonic resolution in `[80..160]` BPM reported in `tempo_resolution`) and phase (`phase_ms`, `beat_period_ms`) estimated via autocorrelation + comb filtering. Produces a uniform, gap-free pulse across the entire track (`grid_ms`, `grid_count`), including across quiet intros, pads or breakdowns (`grid_ms` is empty only if the audio has no periodic pulse). The grid is **independent of `sensitivity`**. For backward compatibility, `beats_ms` equals `grid_ms` when a grid exists (otherwise `onsets_ms`).
  2. **Detected transient peaks (`onsets`):** Spectral-flux onset peaks (`onsets: [{ time_ms, strength }]`, `onsets_ms`, `onsets_count`) selected via strength-descending non-maximum suppression. `sensitivity` (`0.8..3.0`, default `1.35`; **higher value = lower threshold = more onsets detected**) only scales `onsets` while `grid_bpm` and `grid_ms` stay locked.
- **Querying beats vs onsets:**
  - `library.query(handle="aud_02", kind="beats", range="0s..10s")` returns the regular `grid` beats by default (`kind: "grid"`).
  - Pass `text="onset"` (or `text="transient"`) to query the detected spectral-flux onset peaks with their `strength`: `library.query(handle="aud_02", kind="beats", text="onset", range="0s..10s")`.
- `mix.beat_align(bgm_handle="aud_02", clips?, mode="grid" | "onsets", grid?, sensitivity?, tolerance?, preserve_duration?)` snaps each target spine clip's end point to the nearest beat **only if** that beat lies within `tolerance` (default: half a beat period, clamped to `120..500ms`):
  - **Alignment mode (`mode` / `grid`):** Defaults to `mode="grid"` (`grid=true`, `align_mode: "grid"`), snapping cuts to the regular `grid_ms` pulse (falling back to `onsets_ms` only if the track has no periodic grid). Pass `mode="onsets"` (or `grid=false`, `align_mode: "onsets"`) to snap cuts to raw spectral-flux transient peaks instead (`sensitivity` affects `mode="onsets"`).
  - Clips snapped within tolerance whose duration actually changes (`shift_ms != 0`) are recorded as `SHIFTED_TO_BEAT` in `aligned_clips` / `decision_trace`; cuts that are already on the beat (`shift_ms == 0`) are recorded as `ALREADY_ON_BEAT`.
  - Clips whose nearest beat is farther than `tolerance` are left unchanged and reported in `skipped_clips` and `decision_trace` as `OUT_OF_TOLERANCE` (or `NO_VALID_BEAT_IN_RANGE` when constrained by source media length or transition budget).
  - Check `old_total_duration_ms`, `new_total_duration_ms`, `total_duration_delta_ms`, and `duration_warning`. Pass `preserve_duration=true` to adjust the final clip so total spine duration stays close to the original, or pass a narrower `tolerance` (e.g. `tolerance="180ms"`).
- Inside HyperFrames compositions, `C.beats()` returns detected onset times by default, while `C.beats({ grid: true })` and `C.beatGrid()` return the regular tempo/phase beat grid (see `compositions.md`).
