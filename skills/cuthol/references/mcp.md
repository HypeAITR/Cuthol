# Cuthol MCP server

## Starting it

The server speaks MCP over stdio. It is the same program as the CLI:

```bash
cuthol mcp                      # or: cuthol-mcp
cuthol mcp --dir /path/to/project   # preselect a project
```

Client configuration (JSON used by most MCP clients):

```json
{
  "mcpServers": {
    "cuthol": {
      "command": "node",
      "args": ["/absolute/path/to/cuthol/dist/cli.js", "mcp"],
      "env": {
        "DEEPGRAM_API_KEY": "…",
        "ELEVENLABS_API_KEY": "…"
      }
    }
  }
}
```

Requirements on the machine: Node.js ≥ 22.5, `ffmpeg`/`ffprobe` on PATH, and a Chrome that HyperFrames can launch (for overlays). API keys are only needed for transcription and voiceover; they can also live in a `.env` file inside the project folder. After adding or editing `.mcp.json`, restart the MCP client session and approve the server; to verify the server directly over stdio, send `initialize` followed by `tools/list` to `node dist/cli.js mcp` and confirm 14 tools are returned.

Environment switches:
- **MCP server**: `CUTHOL_WORKSPACE` (default project), `CUTHOL_MCP_PROGRESSIVE=1` (start with core tools only; unlock with `discover_capabilities`), `CUTHOL_MCP_STRUCTURED=1` (also send the full JSON as `structuredContent`), `CUTHOL_MCP_TIMEOUT_MS`.
- **User-level shared ASR/TTS cache**: By default, transcripts (`transcript_cache`) and synthesized voiceover audio/alignments (`tts_cache`, `blobs/`) are also cached across projects by SHA-256 in `~/.cuthol/cache` (`ledger.sqlite` + `blobs/`), so re-ingesting the same file or synthesizing the same voiceover in a new project hits the cache without cloud API calls.
  - Redirect location: set `CUTHOL_CACHE_DIR=/path/to/cache` (or `CUTHOL_SHARED_CACHE_DIR` / `CUTHOL_USER_CACHE_DIR` / `CUTHOL_CACHE` / `CUTHOL_SHARED_CACHE`, either a folder or a `.sqlite`/`.db` path).
  - Disable shared cache (keep only per-project `.cuthol/ledger.sqlite`): set `CUTHOL_CACHE_DIR=0` (or `false`, `off`, `none`) or `CUTHOL_DISABLE_SHARED_CACHE=1` (`CUTHOL_NO_SHARED_CACHE=1`, `CUTHOL_DISABLE_CACHE=1`, `CUTHOL_NO_CACHE=1`).
- **Persistent extensions directory**: Persistent extensions live in `~/.cuthol/extensions/<name>/` (`scope="persistent"`), while project-local extensions live in `<project>/.cuthol/extensions/<name>/` (`scope="project"`, which wins on name collision). Redirect persistent extensions with `CUTHOL_EXTENSIONS_DIR=/path/to/extensions` or disable with `CUTHOL_EXTENSIONS_DIR=0`.
- **Stage-scaled typography defaults**: Vertical `9:16` (`1080x1920`) projects use larger default typography for mobile legibility — `76 px` for titles (`max_width=70`%) and `64 px` for captions (`max_width=70`%, `max_words=4`, `max_chars=26`), compared to `56 px` titles (`max_width=76`%) and `42 px` auto-captions (`max_width=80`%, `max_words=5`, `max_chars=38`; `44 px` / `76%` for manual caption cues) on `16:9` (`1920x1080`).

## Tools

14 tools: `workspace`, `library`, `brief`, `spine`, `lane`, `composition`, `speech`, `mix`, `cue`, `verify`, `monitor`, `render`, `extension`, `guide`. Multi-action tools take an `action` argument; every property description starts with the actions that use it, e.g. `[split] Split points …`. Unknown arguments are rejected with the valid list and the closest match — read the message instead of guessing again.

## Conventions

- **Project selection & relative paths**: `workspace.init(dir=…)` or `workspace.open(dir=…, verbose?)` sets the session project; afterwards `dir` can be omitted. `workspace.open` returns a compact summary (counts + first 3 library items and spine clips + lane cue counts); pass `verbose=true` for full tables. Passing `dir` to any call switches to that folder for that call. Over MCP, relative paths (`files`, `comp_dir`, `out`, `file`) resolve against the project folder (`dir`); on the CLI, relative file paths (such as `cuthol library ingest <files...>`) follow standard CLI convention and resolve against the current working directory (`cwd`), while `G201` reports the exact absolute path tried.
- **CLI compact mode**: Pass `--compact` (or `--format text`) to any CLI command to print the exact same compact text format used by the MCP server (default CLI output remains JSON).
- **Result format** (text, real example):
  ```
  OK spine.transition · r15 · 14.00s · 2 sp · 11 cue (1 comp, 8 cap)
  Changed: spine.transition(sp_01): ~sp_01 (transition:fade 400ms)
  Undo (expect_rev 15): ESKİ HALİNE DÖNER: sp_01 (transition:fade 400ms)
  Verify: 0 error(s), 0 warning(s)
  ```
  The first line is always status · revision · duration · counts (sp = spine clips, comp = compositions, cap = captions). `FAILED` lines carry `[CODE] what | Öneri: fix`. `WARN [CODE] …` lines follow. `mix.normalize` adds a `Loudness:` line showing `measured_mix_before_lufs → achieved_lufs` and `target_reached=true|false` (plus `skipped_muted=N` when muted clips/cues are skipped), and caps `adjusted_clips` at the first 8 items (`adjusted_clips_count` + `adjusted_clips_omitted`; pass `verbose=true` for the full list). `speech.cleanup` can clean a single clip, `clips=[...]`, or the entire spine (`clip` omitted / `all_spine=true`) in one atomic call; in `dry_run=true` it prints a `Candidates` table (paginate with `cursor` / `limit`), `Review candidates` (`cf_<asset>_<start>_<end>`) for fluent contextual fillers, and `Repetition / restart candidates` (`rr_<asset>_<start>_<end>`) for phrase repeats and sentence restarts that the agent can select via `cut_candidates` (including `:keep=1` / `#1` attempt selection). `decision_trace.rules` is returned only on `dry_run=true` (or `verbose=true`). `spine.reframe` prints a per-clip `Reframe summary` (confidence, pan range, stationary plateau count) and omits raw `focal_points` / `envelope_points` arrays from `Result:` so responses never truncate mid-JSON. `Result:` holds the remaining data as compact JSON (edits omit the echoed objects; `decision_trace` is summarized unless `dry_run=true`). Calls that did not change the edit say `No change to the edit`. Dry runs start with `DRY-RUN … nothing changed` and show `Would change:` for `workspace.undo/redo`, `speech.cleanup`, `spine.reframe` and `extension.run` planners.
  Undo/edit vocabulary in summaries: `SİLİNİR` = will be deleted, `ESKİ HALİNE DÖNER` = reverts to its previous state.
- **Images**: `monitor.frame`, `monitor.sheet`, `monitor.timeline`, `composition.preview/check` (and `library.waveform` with `png`) return the picture as an image block (JPEG, max 1600 px wide) next to the text — including when `composition.preview/check` reports `FAILED` (e.g. lint or `G505`), so you can still inspect the contact sheet.
- **Long calls** (`render`, `monitor`, `composition.preview`, `speech.transcribe/synthesize`) send `notifications/progress` if the client supplied a progress token, and can be cancelled. Calls that change the same project run one at a time.
- **Loop guard**: the third identical failing call in a row is refused without running.
- **Outside changes**: if the project was modified by something else (another agent, the CLI) since your last call, the result starts with `NOTE the project changed outside this session` — re-read with `brief`.
- **Manual**: `guide(topic)` returns these documents: `overview`, `editing`, `speech_mix`, `compositions`, `verify_monitor`, `extensions`, `mcp`, or `ext:<name>` for an installed extension's `README.md`.

Composition HTML can be edited with your own file tools (`<project>/<comp_dir>/index.html`) or, if you have none, with `composition.read(comp_dir)` / `composition.write(comp_dir, content, file?)`. `write` only accepts .html/.css/.js/.json/.svg files inside the composition folder and flags obvious contract mistakes.
