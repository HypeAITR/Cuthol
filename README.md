# Cuthol

Cuthol is a local, open-source non-linear video editor built for AI agents instead of a mouse.

An agent edits through a CLI (`cuthol`) or an MCP server (`cuthol mcp`). It reads the edit through compact text views and checks it by looking at rendered frames. It can also write its own motion graphics as HyperFrames (HTML/GSAP) compositions that react to the words, beats and cuts of the edit. Every change is journaled, can be undone, and is checked by verification gates before render.

> Status: early (0.1). The core editing, speech, mix, compositing and render paths are complete and have been exercised end to end by agents on real footage. Expect rough edges and breaking changes.

## What it does

- **Timeline.** A magnetic primary storyline (`spine`) plus typed parallel lanes (titles, captions, b-roll, motion graphics, voiceover, sfx, music). Cues can be anchored to clips, so they follow later trims.
- **Speech.**
  - Transcription with word timings.
  - Pause and filler cleanup with cut edges placed in real silence. Contextual fillers are offered for review rather than cut blindly.
  - Word-highlighted captions and voiceover synthesis.
- **Mix.** Loudness normalization to a target (ITU-R BS.1770, e.g. −14 LUFS / −1 dBTP), voice polish, music ducking under speech, and cut alignment to a regular beat grid.
- **Reframe.** Single-subject tracking when placing 16:9 footage on a 9:16 stage, with manual correction.
- **Motion graphics.** HyperFrames compositions composited with true alpha. Each composition gets a runtime (`window.__cuthol`) exposing word times, beats, the beat grid and cut points, both for its own window and for the whole edit (`C.global`). A video can be made entirely of motion graphics, with no footage on the main storyline; set the base colour with `workspace backdrop --color`.
- **Seeing the edit.**
  - A fast frame preview that matches the render.
  - Contact sheets and a timeline diagram.
  - Blank-frame detection on monitor frames and on the rendered output.
- **Safety.**
  - Integer-millisecond model with typed handles (`vid_01`, `sp_01`, `cue_01`) that are never reused.
  - An atomic edit journal with undo previews and `expect_rev`, plus lane locking.
  - 5 verification gates (schema, assets, timing, stage, signal) with structured diagnostics.

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

Most clients read MCP servers only when a session starts. After adding or changing the configuration (for example a project `.mcp.json`), start a new session and approve the `cuthol` server when asked. To check the server on its own, run `node dist/cli.js mcp` and send `initialize` and then `tools/list`; it should list 13 tools.

The server exposes 13 tools:

| Group | Tools |
|---|---|
| Project and media | `workspace`, `library`, `brief` |
| Editing | `spine`, `lane`, `composition` |
| Speech and sound | `speech`, `mix` |
| Batch edits | `cue` |
| Checking and output | `verify`, `monitor`, `render` |
| Help | `guide` |

Agents should start with `guide(topic="overview")`. Edit results come back as short text (`Changed:` / `Undo:` / warnings). `monitor` and `composition.preview` return images inline.

Agents that support skills can load [`skills/cuthol/SKILL.md`](skills/cuthol/SKILL.md). Its references cover:

- editing;
- speech and mix;
- compositions;
- verification and monitoring;
- MCP usage.

## Use it from the command line

```bash
node dist/cli.js workspace init ./my-video --aspect 9:16 --fps 30
node dist/cli.js library ingest talk.mp4 music.mp3 --dir ./my-video
node dist/cli.js spine append --asset vid_01 --dir ./my-video
node dist/cli.js speech transcribe --handle vid_01 --dir ./my-video
node dist/cli.js speech cleanup --clip sp_01 --dry-run --dir ./my-video
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
- Renders have no time limit; long videos simply take longer. If an overlay cannot be rendered, the render fails with an error instead of substituting anything.
- Rendering presets:
  - `draft_480p`: a fast proxy for checking.
  - `master_1080p`: the deliverable.

## License

MIT, see [LICENSE](LICENSE).
