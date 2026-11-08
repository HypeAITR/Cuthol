---
name: cuthol-speech
description: >
  Transcribe, clean up and verify speech in Cuthol: speech.transcribe,
  speech.cleanup with dry_run and cut_candidates, speech.verify_cleanup,
  captions, voiceover synthesis, provider selection (deepgram, elevenlabs,
  local, ext:), and patching a misread word. Load when removing pauses,
  fillers or repeated takes, captioning speech, or working with voiceover.
---

# Speech: transcribe, clean, caption, voiceover

## Transcription

`speech.transcribe(handle, lang="auto")` sends the asset to the ASR provider once
and caches the result by file content (re-running is free). It returns a
digest: word count, words per minute, low-confidence spans, a short preview and
query hints. Read words with `library.query(handle, kind="transcript",
range="3s..6s" | text="moonstar", format="default" | "compact")` — the text
search ignores case and diacritics.

- The language defaults to `"auto"` (detected from the audio; the digest shows
  it as `language`). Pass `lang="tr"` / `"en"` to force one — an explicit
  language only ever reads that language's cache record. `refresh=true`
  re-transcribes and replaces the stored record. A provider that cannot detect
  the language fails with `[CUTHOL-G213]` unless `lang` is given.

- Transcribe the **asset** (`vid_01`, `aud_01`), not a clip. Words project onto
  every clip and voiceover cue using that asset, and stay correct after trims,
  speed changes and cuts. Check brand names and rare nouns with
  `library.query(text=…)` first — they are often misheard.
- Providers: `deepgram` (default, needs `DEEPGRAM_API_KEY`), `local` (needs a
  `<file>.transcript.json` sidecar or `CUTHOL_LOCAL_ASR_CMD`), or
  `ext:<extension>` (an extension ASR provider). See *Providers* below.

## Voiceover

`speech.synthesize(text, voice?, speed?, place_on_lane="ln_vo", at |
anchor+offset)` creates a `vo_XX` asset with exact word timings from the TTS
itself (no ASR pass needed, spelling preserved). Default provider `elevenlabs`
(needs `ELEVENLABS_API_KEY`). `provider="local"` without `CUTHOL_LOCAL_TTS_CMD`
gives placeholder tones (`is_placeholder_audio: true`) — fine for timing tests,
not for delivery. `provider="ext:<extension>"` uses an extension TTS provider;
without alignment it reports `has_alignment: false` plus a warning instead of
inventing timings. Pass `lang` with the text's language: it is recorded with the
voiceover's transcript. Without it, text with Turkish-only letters is recorded as
`tr` and anything else as `und` (undetermined), so a later
`speech.transcribe(lang="en")` re-transcribes instead of reusing a mislabelled record.

To use an existing narration file instead: `library.ingest` it, place it with
`lane.add_cue(lane="ln_vo", kind="voiceover", asset=…, at=…, duration=<its
length>)`, then `speech.transcribe` it. To speed it up inside Cuthol, pass
`rate=` to `add_cue` / `update_cue` (duration, `atempo` audio and all projected
word times follow). To cut a sentence out of it, `lane.excise(cue="cue_01",
ranges=["10s..14s"], coord="source")`.

**Patching one misread word:** record just the patch and splice it in: (1)
transcribe, find the word's time; (2) cut at an **energy valley**, not the
transcript boundary — word edges often sit adjacent, while the closure before
a consonant cuts cleanly (scan 5–10 ms RMS); (3) trim the patch's silent
head/tail, match gain on voiced frames (cap ±4 dB), 10 ms equal-power
crossfades at both joints; (4) join ±3 s around both joints, re-transcribe the
few seconds, confirm the words arrive once and complete. Keep an old→new time
map so later lookups shift correctly.

**Real recordings** (screen capture + live voice): build the spine from kept
ranges, rounding boundaries **cumulatively** (each clip starts on the frame the
previous one ended on). Verify sync by correlating the recording's own audio
against the cut voiceover.

## Providers

Each speech call resolves its provider in this order: `--provider` flag, then
`CUTHOL_ASR_PROVIDER` / `CUTHOL_TTS_PROVIDER`, then the project default, then
the built-in (`deepgram` / `elevenlabs`). `speech.providers` shows stored
defaults and effective resolution; `speech.providers(asr="ext:my-asr")` stores a
project default (journaled, undoable; `"builtin"` clears one). Unknown ids fail
with `[CUTHOL-G230]`. Transcripts and voiceovers cache per provider identity +
version + options, so providers never share records.

Two ways to use local models: the `local` door (sidecar transcript, or
`CUTHOL_LOCAL_ASR_CMD` / `CUTHOL_LOCAL_TTS_CMD`) or an `ext:` provider
extension (see `cuthol-extensions`).

Music and effects can come from a provider shelf: `library.search(provider=
"ext:media-folder", kind="music", query="calm", min="10s", max="60s")` lists
candidates; `library.fetch(provider=..., id=...)` ingests one through the
normal path with its origin kept in the asset `source` (provider, id, title,
license), shown by `library.query` and `brief(lens="detail")`.

## Cleanup (single clip, clips, whole spine, or audio cue)

`speech.cleanup(clip?, clips?, all_spine?, cue?, cues?, across?, min_pause=
"400ms", pad="75ms", remove_pauses, remove_fillers, remove_repetitions=false,
cut_candidates?, lang?, dry_run?, verbose?, limit?, cursor?)`.

A raw narration file needs no video wrapped around it: ingest the audio, place
it on `ln_vo`, then `speech.cleanup(cue="cue_01", dry_run=true)` — the same
pause/filler/restart/acoustic-edge engine as a spine clip. Applied cuts go
through lane excise in one revision (`across` defaults to `lane`). A missing
transcript is `CUTHOL-SYS06`; transcribe the asset first.

1. **Whole spine in one atomic call:** omit `clip` (or `all_spine=true`, or
   `clips=[…]`) to clean every transcribed spine clip in a single operation
   (one journal entry, one undo). Or pass one `clip="sp_01"`.
2. **Inspect candidates first (`dry_run=true`):** the dry-run response holds
   `Candidates` (pause/filler decision table), `Review candidates`
   (`cf_<asset>_<start>_<end>`: contextual fillers in fluent clauses),
   `Repetition / restart candidates` (`rr_<asset>_<start>_<end>`: phrase
   repeats, restarts, word repeats, with attempts, suggested cut and `gap_ms`;
   `gap_ms > 8000` listed separately as distant), `Preserved untranscribed`
   (kept audio runs the transcript missed), and `Image-only tail`
   (`ta_<asset>_<start>_<end>`). IDs are source-anchored, so they stay valid
   after the spine is split. Details: `references/cleanup.md`.
3. **Decide one by one (`cut_candidates`):** contextual fillers and
   repetition/restart candidates are never cut automatically. Pass
   `cut_candidates=["cf_…", "rr_…", "rr_…:keep=1", "rr_…#1",
   "36150..42880ms"]` in the applying call. Detection is deliberately broad —
   read each candidate's `context`; never pass every `rr_` id wholesale.
4. Look at the result (`monitor.sheet` around the cuts); render a draft if
   timing matters. After cleanup, list clips shorter than ~1.5 s or holding no
   words and check their energy: merge crumbs with `spine.remove`, repair a
   clipped onset with `spine.trim` (G309/G312 flag the shortest ones).

Cut edges tighten to 25 ms RMS windows below the recording-relative silence
floor so kept word tails are never clipped; `< 150 ms` silent remnants merge
into adjacent cuts. Full edge/remnant rules: `references/cleanup.md`.

## Cleanup verification

`speech.verify_cleanup(clip?, clips?, all_spine?, provider?, lang?)` checks the
speech you kept: it renders the clips through the same audio compiler as
render, transcribes that WAV once (cached by audio hash + provider), and
compares it against the unexcised words. It never edits. Run it after cleanup,
before you trust a cut — a cut can eat the next word, a first take the source
transcript missed can survive as a repeat, a syllable sliver can remain.

Read `missing_words` (kept word, nothing heard — the "cut ate the word"
candidate) and `repeated_phrases` (heard twice — the "leftover first take"
candidate). `unexpected_words` are insertions; `substituted_words` is spelling
noise between the two ASR passes, not a lost word.

## Captions

`speech.captions(style="active_word" | "sentence" | "boxed", clip?,
all_spine?, max_words?, max_chars?, lang?, replace?)` builds caption cues on
`ln_captions` from transcripts of spine clips **and** `ln_vo` voiceover cues
(`all_spine=true` to skip voiceovers).

- **Every unexcised word is shown:** flags only affect cleanup candidacy — if a
  word survived the edit, it appears, so text and audio never diverge.
- Generate captions **after** cleanup and other cuts; `replace=true` rebuilds
  them after later edits. Stage-scaled defaults: 9:16 → 64 px, 70% width,
  `max_words=4`, `max_chars=26`; 16:9 → 42 px, 80% width, `max_words=5`,
  `max_chars=38`.
- `active_word` highlights the spoken word. Reading speed uses the project
  language (19 CPS Turkish, 17 CPS English); fast groups give G402 — lower
  `max_words`. Captions sit at `y=26`; move them with `lane.update_cue` on
  collision (G403 warns about occlusion).
