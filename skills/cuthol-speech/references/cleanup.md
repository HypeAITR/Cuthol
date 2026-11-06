# Cleanup candidates, edges, remnants

## Candidate kinds (`dry_run=true`)

- `Candidates`: the pause/filler decision table across all target clips
  (paginate with `cursor` / `limit`).
- `Review candidates` (`review_candidates`): contextual discourse fillers
  spoken in fluent clauses, with persistent source-anchored IDs
  (`cf_<asset>_<start>_<end>`), word, source time and context.
- `Repetition / restart candidates` (`repetition_candidates`): 2–6 word phrase
  repeats (including inflectional stem matches, skipped filler particles, and
  1-slot lexical substitutions), clause/sentence restarts, and word repeats,
  with persistent IDs (`rr_<asset>_<start>_<end>`), all `attempts` (`#1`, `#2`,
  …), `suggested_cut_start_ms..suggested_cut_end_ms`, `suggested_keep_attempt`,
  `gap_ms` (end of first attempt → start of last), and surrounding `context`.
  Candidates with `gap_ms <= 8000` stay here.
- `Distant repetition / restart candidates`: the same `rr_` ids whose `gap_ms`
  is above 8000 ms, under their own heading. Pass the same id in
  `cut_candidates` to cut one.
- `Preserved untranscribed audio` (`preserved_untranscribed`): each kept
  ASR-missed run as `{clip_id, source_start_ms, source_end_ms, duration_ms,
  max_dbfs, near_candidate_id?}`. `near_candidate_id` is set when that run is
  inside, or within 1 second of, an `rr_` candidate or a span selected in this
  call. The compact text lists the first 10 runs and the total on every page.
- `Image-only tail` (`tail_without_audio_candidates`, kind `tail_without_audio`,
  id `ta_<asset>_<start>_<end>`): on a source with audio and video, picture
  continuing at least one frame after the audio ends. Listed, not cut, until
  its id is passed in `cut_candidates`.

Suggested cuts are a starting point, not a safe default: on a 12-minute talk
the suggestions covered ~3.9 minutes, of which ~2.4 were content a careful
editor kept (emphasis, a name said twice on purpose, a meaningful clause).

## `cut_candidates` syntax

- Cut by id: `cut_candidates=["cf_vid_01_16785_16945",
  "rr_vid_01_36470_44645"]`.
- Keep one attempt, cut the others: `"rr_vid_01_52010_54810:keep=1"`.
- Cut specific attempts: `"rr_vid_01_36470_44645#1"` (or `":cut=1,2"`).
- Cut by explicit source range: `"36150..42880ms"` (or
  `"vid_01:36150..42880ms"`).

## Edges and remnants

- **Pauses and word boundaries:** a pause candidate overlapping an ASR word is
  trimmed to the word-free gap (`TRIMMED_TO_WORD_GAP`). If the remaining gap is
  `< min_pause`, it is rejected with `OVERLAPS_WORD`.
- **Acoustic edge verification:** cut edges — automatic pauses and selected
  `cut_candidates` alike — tighten to 25 ms RMS windows below the
  recording-relative `silence_floor_dbfs`, so kept word tails and onsets are
  never clipped. If the silent region left in a pause is `< min_pause`, the
  candidate is rejected (`ACOUSTIC_GAP_TOO_SHORT`). `pad` (default `75ms`)
  keeps breathing room; if collar padding leaves `< 80ms`, the candidate is
  rejected (`COLLAR_PAD_EXHAUSTED`).
- **Selected-range edges:** a `cut_candidates` edge may move outward from the
  requested range only through silence; it stops one analysis window before the
  first window above the floor and never enters kept speech. An edge already in
  speech is pulled inward. Active audio the transcript missed (longer than 120
  ms, above the floor, starting after the cut words and ending before the
  requested end) is kept: the cut stops `pad` before the first such run
  (`split_around_untranscribed_audio`). Each selected cut reports requested vs
  applied source range and `edge_reason` (`pulled_in_before_speech`,
  `extended_into_silence`, `split_around_untranscribed_audio`, `unchanged`).
- **Untranscribed audio inside a pause:** a pause gap holding > 120 ms of
  active audio missing from the transcript (voiced hesitation, breath/cough, a
  missed word) is **preserved** (`UNTRANSCRIBED_AUDIO` in `decision_trace` with
  its exact source span) and the cut splits or shortens around it. If you
  verify the span is unwanted, remove it explicitly with
  `cut_candidates=["start..end"]` or `spine.excise`.
- **No `< 150 ms` remnant slivers:** a cleanup cut that would leave a `< 150
  ms` remnant with no kept speech merges it into the adjacent cut
  (`APPLIED_WITH_SLIVER_MERGE`); an existing `< 150 ms` silent remnant clip is
  removed on full-spine cleanup (`SHORT_SILENT_REMNANT_REMOVED`). A `< 150 ms`
  gap holding a spoken word retracts or rejects the adjacent pause cut
  (`AVOID_SHORT_REMNANT_CLIP`) so words are never clipped. `verify` flags spine
  clips of `<= 150 ms` with `CUTHOL-G309` (WARN); a 150–300 ms clip with audio
  above the floor is `CUTHOL-G312` (INFO, "short speech fragment, possibly a
  restart leftover") — G312 runs only when a cleanup acoustic profile for that
  asset is already cached.
- **Compact output:** `decision_trace.rules` is included only when
  `dry_run=true` (or `verbose=true`).

## Reading `verify_cleanup` numbers

`match_rate` is the share of expected words whose normalized token matched
exactly (`expected_word_count`, `heard_word_count`, `matched_word_count` are
the counts). `match_rate_lenient` counts a substitution as a match when its
character similarity is ≥ 0.6. Both rates are 1 when the expected list is empty
and nothing was heard, and 0 when the expected list is empty but words were
heard. `missing_words` entries carry sequence/source times, `clip_id`, and
`neighbor_cut_id` when within 250 ms of an excised gap. `repeated_phrases`
entries list each copy's range, plus nearby `preserved_untranscribed` runs.
`substituted_words` entries carry `{expected, heard, similarity, …}` and are
written only here, at every similarity — a low score never also becomes a
deletion or insertion.
