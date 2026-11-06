---
name: cuthol
description: >
  Start every Cuthol video-editing session here. Cuthol is an agent-first local
  non-linear video editor (magnetic spine timeline, lanes, speech cleanup and
  captions, voiceover, audio mix, HyperFrames motion graphics, verification,
  render) driven through MCP tools or the `cuthol` CLI. Read this skill first in
  any session where you edit, assemble, caption, mix, check or render a video;
  load a category skill only when its task comes up.
---

# Cuthol

Cuthol is a video editor built for agents: a project is a folder with
`cuthol.sequence.json`, changed only through Cuthol commands, every change
journaled and verified, results checked by looking at rendered frames.

You can drive it two ways. They are the same commands:

| MCP tool call | CLI |
|---|---|
| `spine(action="trim", clip="sp_01", out="4s")` | `cuthol spine trim --clip sp_01 --out 4s --dir <project>` |
| `lane(action="add_cue", lane="ln_titles", text="Hi")` | `cuthol lane add-cue --lane ln_titles --text "Hi"` |
| `brief(lens="flow")` | `cuthol brief --lens flow` |

MCP names use `_` where the CLI uses `-` (`add_cue` ↔ `add-cue`,
`comp_dir` ↔ `--comp-dir`). Error suggestions match your interface.

## MCP or CLI

- MCP remembers the project after `workspace.init`/`workspace.open`, resolves
  relative paths against the project folder, and returns monitor images inline.
  Use it for interactive work: inspecting, checking frames, verifying, mixing.
- The CLI resolves relative file paths against the current working directory
  and prints PNG paths for monitor calls (open them with your image reader).
  It suits bulk work: setup scripts, shell loops, cue sheets. Pass `--compact`
  for the same short text MCP returns (default CLI output is JSON).
- After a Cuthol upgrade, new MCP arguments appear in tool schemas only once
  the client session restarts; until then use the CLI (full tool reference:
  `references/mcp.md`). API keys live in the environment or a project `.env`
  (found up to 4 folders above the project).

## The model in one minute

- **Library**: imported media get typed handles — `vid_01` (video), `aud_01`
  (audio), `img_01` (image), `vo_01` (synthesized voice).
- **Spine**: the main storyline. Clips `sp_01, sp_02 …` play back-to-back with
  no gaps; edits ripple everything after them. It may stay empty (below).
  Handles are never reused after deletion.
- **Lanes**: parallel tracks for cues `cue_01 …`: `ln_titles` (text, z 25) ·
  `ln_captions` (z 30) · `ln_motion` (overlays, z 20) · `ln_broll` (z 10) ·
  `ln_vo` voiceover · `ln_sfx` · `ln_bgm` music. A cue sits at an absolute
  time (`at`) or is **anchored** to a spine clip (`anchor="sp_02",
  offset="300ms"`) and moves with it through edits.
- **Two clocks**: transcripts store source time; Cuthol projects words onto the
  timeline, including after trims, speed changes and cuts.
- **Time literals**: `1500ms`, `1.5s`, `00:01.500` — always with the unit (a
  bare number means milliseconds). Lane `x`/`y` are % offsets from the stage
  centre (`y=-30` is towards the top).
- **Stage-scaled typography**: on `9:16`, titles `76 px` / captions `64 px`;
  on `16:9`, titles `56 px` / auto-captions `42 px` (widths, `max_words` and
  `max_chars` scale with the stage too).

## Workflow

1. `workspace.init(dir, aspect, fps)` — or `workspace.open(dir)` for an
   existing project.
2. `library.ingest(files=[…])` → handles. Optional analysis:
   `library.loudness / beats / scenes / waveform / subject`.
3. Build the spine: `spine.append`, then `trim`, `split`, `excise`, `reorder`,
   `transition`, `speed`, `transform`, `reframe`, `grade`, `fx`, `envelope`.
4. Speech: `speech.transcribe(handle)` → `speech.cleanup(dry_run=true)` →
   read candidates → run without `dry_run` → `speech.verify_cleanup` →
   `speech.captions()`.
5. Lanes: titles/b-roll/music/voiceover with `lane.add_cue`; your own
   animations with `composition.scaffold` + `lane.add_composition`.
6. Mix: `mix.normalize()`, `mix.duck()`, `mix.beat_align()`.
7. Check: `brief(lens="flow")`, `monitor.timeline`, `monitor.sheet`,
   `monitor.frame(at)` — **look at the images**.
8. `verify()` must report 0 errors. Then `render(preset="draft_480p")`, look at
   frames of the output, then `render(preset="master_1080p")`.

Long edits are easier to rebuild than to repair: keep a setup script for the
whole build (init → ingest → spine → cues → compositions) and re-run it
whenever the spine or timing changes.

## Graphics-only video (no footage)

Leave the spine empty; the lanes are the whole edit and the sequence lasts
until the latest lane cue ends. Place cues with `at` (anchors need a spine
clip). `workspace.init` → `workspace.backdrop(color="#RRGGBB")` →
`library.ingest` → `lane.add_cue` for audio → `composition.scaffold` +
`lane.add_composition` → `verify()` → `monitor.sheet` → `mix.normalize()` →
`render`. Bare stretches show only the backdrop (G308); a project with nothing
on it gives G307, and `render` refuses it.

## Rules

1. **Look before you claim.** A command returning OK only means it ran. Inspect
   `monitor.frame` / `monitor.sheet` images (and `composition.preview` for
   overlays) before saying something works.
2. **Read every result.** Each edit returns the new revision, `Changed:` and
   `Undo:`, plus warnings (`WARN [CUTHOL-G…]`) — real problems unless you
   chose them deliberately.
3. **Verify 0 errors before delivery.** `verify()` must report 0 errors before
   a master render; understand every warning.
4. **Undo safely.** Check the undo line first, pass `expect_rev`, use
   `dry_run=true` when unsure, and `lane.lock` lanes you must not lose.
5. **Never repeat a failing call unchanged.** Errors carry `Suggestion:` (the
   fix). The MCP server refuses the third identical failure.
6. **Anchor what belongs to a clip.** Titles/b-roll that describe a shot should
   be anchored to that clip, so later trims don't desync them.
7. **Prefer digests and queries.** Analyzers return short digests; read details
   with `library.query(handle, kind, range|text, format?)`.
8. **Overlays are code.** Write HyperFrames HTML with `window.__cuthol`; never
   use green-screen keying.
9. **Speech services cost money.** Transcripts and voiceovers are content-hash
   cached; don't re-transcribe edited copies needlessly.
10. **Adopt outside edits deliberately.** Composition files and hand edits to
    `cuthol.sequence.json` are not revisions until journaled. On `NOTE
    External project change…` (or a `CUTHOL-G211` refusal), run
    `workspace(action="changes_show")`, then `changes_adopt` or
    `changes_revert`.

## Where to go next

Load a category skill **only when its task comes up**:

| Skill | Load it when | Example |
|---|---|---|
| cuthol-editing | You need to build or change the timeline: spine clips, lane cues, anchors, cuts, speed, transitions, effects, envelopes, cue sheets, undo. | "Trim sp_02, anchor the title to it, and slow the b-roll to 0.8x." |
| cuthol-speech | You need to transcribe, clean up speech, verify the cleanup, caption, synthesize a voiceover, or choose a speech provider. | "Remove the pauses and repeated takes, then rebuild the captions." |
| cuthol-audio | You need to balance loudness, polish a voice, duck music under speech, or cut to the beat. | "The music buries the narration; duck it and normalize to -14 LUFS." |
| cuthol-motion | You need to write, mount, preview or debug a HyperFrames overlay, or use words, beats, audio or cuts inside composition code. | "Show a counter that lands exactly on the spoken number." |
| cuthol-geometry | You need to measure, without looking at a picture, whether one element covers another or how far it sits from the frame edge or another element. | "Before rendering, is the title still on the card and clear of the edge?" |
| cuthol-review | You need to verify the edit, understand a diagnostic code, or inspect frames, sheets, the timeline or the edit structure. | "Verify says G403 — what is covered and how do I fix it?" |
| cuthol-render | You need to render a draft or master, reuse overlay cache, pick an encoder, or check the finished file. | "Render a draft, then the master, and confirm no blank frames." |
| cuthol-extensions | You need a reusable helper, asset pack, media processor, clip effect, transition, recipe, planner or provider — or to run, enable or inspect one. | "Turn this three-step voiceover prep into a one-command recipe." |
