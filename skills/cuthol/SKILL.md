---
name: cuthol
description: >
  Edit real videos with Cuthol, an agent-first non-linear video editor: cut and arrange footage on a
  magnetic timeline, transcribe speech, remove pauses, add word-highlighted captions, voiceover and
  music with ducking, and code your own HyperFrames (HTML/GSAP) motion graphics that react to words,
  beats and cuts. Use whenever a task involves editing, assembling, captioning, mixing or rendering a
  video, or animating overlays on footage, through the `cuthol` MCP tools or the `cuthol` CLI.
---

# Cuthol

Cuthol is a video editor built for agents. A project is a folder containing `cuthol.sequence.json`;
you change it only through Cuthol commands, every change is journaled and verified, and you check the
result by looking at rendered frames.

You can drive it two ways. They are the same commands:

| MCP tool call | CLI |
|---|---|
| `spine(action="trim", clip="sp_01", out="4s")` | `cuthol spine trim --clip sp_01 --out 4s --dir <project>` |
| `lane(action="add_cue", lane="ln_titles", text="Hi")` | `cuthol lane add-cue --lane ln_titles --text "Hi"` |
| `brief(lens="flow")` | `cuthol brief --lens flow` |

MCP action names use `_` where CLI commands use `-` (`add_cue` ↔ `add-cue`). MCP argument names use
`_` where CLI flags use `-` (`comp_dir` ↔ `--comp-dir`). Error suggestions are written for whichever
interface you are using.

## The model in one minute

- **Library**: imported media get typed handles — `vid_01` (video), `aud_01` (audio), `img_01` (image), `vo_01` (synthesized voice).
- **Spine**: the main storyline. Clips `sp_01, sp_02 …` play back-to-back with no gaps. It may stay empty (graphics-only video, below). Trimming, cutting or removing a clip ripples everything after it. Handles (`sp_XX`, `cue_XX`, `mk_XX`, `vo_XX`) are never reused after deletion within the same project (tracked in `meta.handle_counters`, consistent across undo/redo).
- **Lanes**: parallel tracks for cues `cue_01 …`
  `ln_titles` (text, z 25) · `ln_captions` (z 30) · `ln_motion` (HyperFrames overlays, z 20) · `ln_broll` (z 10) · `ln_vo` voiceover · `ln_sfx` · `ln_bgm` music.
  A cue sits at an absolute time (`at`) or is **anchored** to a spine clip (`anchor="sp_02", offset="300ms"`) and then moves with that clip through edits.
- **Two clocks**: transcripts store source time; Cuthol projects words onto the timeline for you, including after trims, speed changes and cuts.
- **Time literals**: `1500ms`, `1.5s`, `00:01.500`. **Positions**: lane `x`/`y` are % offsets from the centre of the stage (`y=-30` is towards the top).
- **Stage-scaled typography defaults**: On vertical `9:16` (`1080x1920`), titles default to `76 px` (`max_width=70`%) and captions to `64 px` (`max_width=70`%, `max_words=4`, `max_chars=26`); on landscape `16:9` (`1920x1080`), titles default to `56 px` (`max_width=76`%) and auto-captions to `42 px` (`max_width=80`%, `max_words=5`, `max_chars=38`; manual lane captions `44 px` / `76%`).

## Workflow

1. `workspace.init(dir, aspect="16:9"|"9:16"|"1:1"|"4:5", fps)` — or `workspace.open(dir)` for an existing project. MCP remembers the project after this.
2. `library.ingest(files=[…])` → handles. Optional analysis: `library.loudness / beats / scenes / waveform / subject`.
3. Build the spine: `spine.append(asset, in, out)`, then `trim`, `split`, `excise`, `reorder`, `transition`, `speed`, `transform`, `reframe` (track single speaker horizontally when placing 16:9 clips onto a 9:16 stage), `envelope`.
4. Speech: `speech.transcribe(handle)` → `speech.cleanup(clip, dry_run=true)` → read `Candidates` and `Review candidates` (`cf_01`… contextual fillers with word, source time and context) → run without `dry_run` (passing `cut_candidates=["cf_01", …]` to cut chosen review items in the same call) → `speech.captions()`.
5. Lanes: titles/b-roll/music/voiceover with `lane.add_cue`; your own animations with `composition.scaffold` + `lane.add_composition` (see `references/compositions.md`).
6. Mix: `mix.normalize()`, `mix.duck()` (needs transcripts of the speech), `mix.beat_align()` (snaps cuts to the regular beat grid by default, or to detected onsets with `mode="onsets"`).
7. Check: `brief(lens="flow")`, `monitor.timeline`, `monitor.sheet`, `monitor.frame(at)` — **look at the images**.
8. `verify()` must report 0 errors. Then `render(preset="draft_480p")`, look at frames of the output, then `render(preset="master_1080p")`.

## Graphics-only video (no footage)

Leave the spine empty; the lanes are then the whole edit and the sequence lasts until the latest lane cue ends. Place cues with `at` (anchors need a spine clip).
`workspace.init` → `workspace.backdrop(color="#RRGGBB")` (the base colour that shows through transparent parts of compositions) → `library.ingest` (voiceover, effects, music) → `lane.add_cue` for the audio → `composition.scaffold` + `lane.add_composition` on `ln_motion`, back to back so every moment has a picture → `verify()` → `monitor.sheet` → `mix.normalize()` → `render`.
Where no visual cue is on screen only the stage backdrop shows (G308). A project with nothing on it gives G307, and `render` refuses it.

## Rules

1. **Look before you claim.** A command returning OK only means it ran. Inspect `monitor.frame` / `monitor.sheet` images (and `composition.preview` for overlays) before saying something works.
2. **Read every result.** Each edit returns the new revision, `Changed:` (what happened) and `Undo:` (what an undo would revert), plus warnings (`WARN [CUTHOL-G…]`). Warnings are real problems unless you chose them deliberately.
3. **Undo safely.** Check the undo line first, pass `expect_rev`, use `dry_run=true` when unsure, and `lane.lock` lanes you must not lose (e.g. finished titles).
4. **Never repeat a failing call unchanged.** Errors carry `Öneri:` (the fix). The MCP server refuses the third identical failure.
5. **Anchor what belongs to a clip.** Titles/b-roll that describe a shot should be anchored to that clip, so later trims don't desync them.
6. **Prefer digests and queries.** Analyzers return short digests; read details with `library.query(handle, kind, range|text)` instead of `verbose`.
7. **Overlays are code.** Write HyperFrames HTML with `window.__cuthol`; never use green-screen keying. Default mode `overlay_alpha` keeps real transparency.
8. **Speech services cost money.** Transcripts and voiceovers are cached by SHA-256 both inside the project (`.cuthol/ledger.sqlite`) and in the user-level shared cache (`~/.cuthol/cache`, redirected via `CUTHOL_CACHE_DIR`, disabled via `CUTHOL_CACHE_DIR=0` or `CUTHOL_DISABLE_SHARED_CACHE=1`); don't re-transcribe edited copies needlessly. `provider="local"` TTS without a configured command produces placeholder tones, not speech.

## References

| Topic | File | MCP |
|---|---|---|
| Spine, lanes, anchors, time, transforms, envelopes, undo/journal, brief lenses, cue sheets | `references/editing.md` | `guide(topic="editing")` |
| Transcription, cleanup, captions, voiceover, loudness, ducking, beat alignment | `references/speech-and-mix.md` | `guide(topic="speech_mix")` |
| Writing HyperFrames overlays, `window.__cuthol` API, overlay modes, preview | `references/compositions.md` | `guide(topic="compositions")` |
| Verification gates and all diagnostic codes, monitor, render | `references/verify-and-monitor.md` | `guide(topic="verify_monitor")` |
| MCP server setup and conventions | `references/mcp.md` | `guide(topic="mcp")` |
