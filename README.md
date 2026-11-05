# Cuthol

Cuthol is a local, open-source non-linear video editor built for AI agents instead of a mouse.

An agent edits through a CLI (`cuthol`) or an MCP server (`cuthol mcp`). It reads the edit through compact text views and checks it by looking at rendered frames. It can also write its own motion graphics as HyperFrames (HTML/GSAP) compositions that react to the words, beats and cuts of the edit. Every change is journaled, can be undone, and is checked by verification gates before render.

> Status: early (0.1). The core editing, speech, mix, compositing and render paths are complete and have been exercised end to end by agents on real footage. Expect rough edges and breaking changes.

## What it does

- **Timeline.** A magnetic primary storyline (`spine`) plus typed parallel lanes (titles, captions, b-roll, motion graphics, voiceover, sfx, music). Cues can be anchored to clips, so they follow later trims.
- **Clip effects.** Effects are applied in the render graph on the clip itself, so the source asset and its transcript binding stay as they are.
  - Speed ramps that the picture, the audio and the word timings all follow.
  - Colour: brightness, contrast and saturation (static or animated), white balance in kelvin, and `.cube`/`.3dl` LUTs.
  - A per-clip effect chain (`spine fx`): a raw FFmpeg chain or effects provided by extensions, with parameters that can be animated.
  - Edge fill for moved, scaled or rotated clips: mirrored or stretched edges instead of showing the layer below.
  - Keyframes with cubic-bezier and step (`hold`) easing.
  - Transitions from extensions, declared as expressions (no code), next to the built-in ones.
- **Speech.**
  - Transcription with word timings.
  - Pause and filler cleanup with cut edges placed in real silence (an edge never grows into a kept word), over one clip, the whole spine, or a voiceover/audio cue on a lane, in a single undoable step.
  - Optional cleanup check: the cleaned speech is transcribed once more and compared with what should remain, listing missing words, phrases heard twice and stray fragments.
  - Mute spine clips, and cut a range out of a voiceover or music cue with later cues and word timings following.
  - Contextual fillers, repeated phrases and restarted sentences are offered for review with stable ids rather than cut blindly; the agent decides what goes.
  - Word-highlighted captions and voiceover synthesis.
- **Mix.** Loudness normalization to a target (ITU-R BS.1770, e.g. −14 LUFS / −1 dBTP), voice polish, music ducking under speech, and cut alignment to a regular beat grid.
- **Reframe.** Single-subject tracking when placing 16:9 footage on a 9:16 stage, with manual correction.
- **Long-form friendly.** A long recording or a single long composition is normal use: renders report progress as they go, a draft can capture overlays at full size so the following master reuses them, edits with hundreds or thousands of cuts render in time segments and preview only the moment asked for, compositions can overlap in layers, audio on lanes can be sped up (pitch kept, word timings follow), and transcripts can be read compactly.
- **Motion graphics.** HyperFrames compositions composited with true alpha. Each composition gets a runtime (`window.__cuthol`) exposing word times, beats, the beat grid and cut points, both for its own window and for the whole edit (`C.global`). A video can be made entirely of motion graphics, with no footage on the main storyline; set the base colour with `workspace backdrop --color`.
- **Seeing the edit.**
  - A fast frame preview that matches the render; contact sheets are built from the same frames in seconds.
  - A timeline diagram.
  - Blank-frame detection on monitor frames and on the rendered output.
- **Safety.**
  - Integer-millisecond model with typed handles (`vid_01`, `sp_01`, `cue_01`) that are never reused.
  - An atomic edit journal with undo previews and `expect_rev`, plus lane locking.
  - 5 verification gates (schema, assets, timing, stage, signal) with structured diagnostics, including HyperFrames lint findings for each composition.
  - Changes made outside Cuthol (a composition edited by hand or in another tool, a hand-edited project file) are detected when the project is opened; the agent sees which files changed and can adopt them as an undoable revision or revert them.
- **Extensions.** Agents can add their own tools without rebuilding Cuthol: composition helpers, asset packs (fonts, mascots, icons), audio/video/image processors, per-clip effects, spine transitions, multi-step recipes, and planners that read the edit's timing (word times, events declared by compositions) and propose cue changes applied as one undoable step. An extension is kept for one project or installed for every project.

## Requirements

- Node.js ≥ 22.5
- `ffmpeg` and `ffprobe` on `PATH` (8.x recommended)
- A Chrome/Chromium that HyperFrames can launch. This is needed only for motion-graphics overlays; check it with `npx hyperframes doctor`.
- Optional, for speech:
  - `DEEPGRAM_API_KEY` (transcription)
  - `ELEVENLABS_API_KEY` (voiceover)

## Install

```bash
git clone https://github.com/HypeAITR/Cuthol.git cuthol
cd cuthol
npm install
npm run build
```

API keys can be set in the environment or in a `.env` file inside your project folder:

```
DEEPGRAM_API_KEY=...
ELEVENLABS_API_KEY=...
```

Transcripts and voiceovers are cached by content hash, both inside each project and in a user-level cache (`~/.cuthol/cache`). This avoids paying twice for the same media. Use `CUTHOL_CACHE_DIR` to move the cache, or set it to `0` to disable it.

## Use it from an agent (MCP)

Register the stdio server in your MCP client:

```json
{
  "mcpServers": {
    "cuthol": {
      "command": "node",
      "args": ["/absolute/path/to/cuthol/dist/cli.js", "mcp"]
    }
  }
}
```

Most clients read MCP servers only when a session starts. After adding or changing the configuration (for example a project `.mcp.json`), start a new session and approve the `cuthol` server when asked. To check the server on its own, run `node dist/cli.js mcp` and send `initialize` and then `tools/list`; it should list 14 tools.

The server exposes 14 tools:

| Group | Tools |
|---|---|
| Project and media | `workspace`, `library`, `brief` |
| Editing | `spine`, `lane`, `composition` |
| Speech and sound | `speech`, `mix` |
| Batch edits | `cue` |
| Checking and output | `verify`, `monitor`, `render` |
| Extensions | `extension` |
| Help | `guide` |

Agents should start with `guide(topic="overview")`. Edit results come back as short text (`Changed:` / `Undo:` / warnings). `monitor` and `composition.preview` return images inline.

Agents that support skills can load [`skills/cuthol/SKILL.md`](skills/cuthol/SKILL.md). Its references cover:

- editing;
- speech and mix;
- compositions;
- verification and monitoring;
- extensions;
- MCP usage.

## Use it from the command line

```bash
node dist/cli.js workspace init ./my-video --aspect 9:16 --fps 30
node dist/cli.js library ingest talk.mp4 music.mp3 --dir ./my-video
node dist/cli.js spine append --asset vid_01 --dir ./my-video
node dist/cli.js speech transcribe --handle vid_01 --dir ./my-video
node dist/cli.js speech cleanup --dry-run --dir ./my-video
node dist/cli.js speech captions --style active_word --dir ./my-video
node dist/cli.js mix normalize --dir ./my-video
node dist/cli.js brief --lens flow --dir ./my-video
node dist/cli.js monitor sheet --grid 4x3 --dir ./my-video
node dist/cli.js verify --dir ./my-video
node dist/cli.js render --preset master_1080p --dir ./my-video
```

By default each command prints a full JSON result. Add `--compact` to get the same short text an agent sees over MCP (`OK … · rN`, `Changed:`, `Undo:`, warnings).

On the CLI, relative file paths resolve against the current directory; over MCP they resolve against the project folder.

To see the commands:
- `node dist/cli.js help` lists every command.
- `node dist/cli.js help --json` prints the machine-readable schemas.

## Project layout

A Cuthol project is a folder:

| Path | What it is |
|---|---|
| `cuthol.sequence.json` | The edit: stage, library, spine, lanes and markers. It is changed only through Cuthol commands. |
| `.cuthol/journal/` | Revision snapshots used for undo and redo. |
| `.cuthol/ledger.sqlite` | Cached transcripts, voiceovers and analyses. |
| `.cuthol/blobs/` | Generated intermediates such as caption files and previews. |

## Notes

- Diagnostics have the form `[CUTHOL-Gxxx] what | Öneri: fix`. They and some guidance text are currently in Turkish. `Öneri` means "suggestion".
- Renders have no time limit; long videos simply take longer. A watchdog stops an external process only when it stops making progress (`CUTHOL_STALL_TIMEOUT_SEC`, default 300, 0 turns it off); a stalled hardware encode is retried once on the CPU. Compositions are captured several at a time, each with its own small worker pool (`CUTHOL_OVERLAY_CONCURRENCY`, `CUTHOL_WORKERS` or `render --workers`; defaults from your CPU cores and memory); a motion-graphics video with nothing underneath renders in one stage, transparent overlays are kept as lossless PNG frames, and drafts capture overlays at 480p.
- The final encode uses the GPU when one is available and passes a short color check: NVIDIA (NVENC), AMD (AMF), Intel (Quick Sync), VAAPI on Linux and VideoToolbox on macOS, otherwise libx264 on the CPU. Pick one with `CUTHOL_ENCODER=auto|nvenc|amf|qsv|vaapi|videotoolbox|x264`. No GPU is required.
- Output is always BT.709. Each source is read with its own color standard: from its tag, or by resolution when untagged (HD as BT.709, SD as BT.601). If an overlay cannot be rendered, the render fails with an error instead of substituting anything.
- Overlays are cached by the data each composition actually uses, so a revision re-renders only what changed; every render reports how many overlays came from cache and why the others were re-rendered. After a render Cuthol checks that segmented audio lines up with its sources.
- Rendering presets:
  - `draft_480p`: a fast proxy for checking.
  - `master_1080p`: the deliverable.

## License

MIT, see [LICENSE](LICENSE).
