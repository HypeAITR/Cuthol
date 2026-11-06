---
name: cuthol-extensions
description: >
  Write, run and manage Cuthol extensions: extension create/enable/run/promote,
  manifest schema, composition helpers, asset packs, ffmpeg and node media
  processors, per-clip effects, transitions, recipes, planners, and ASR/TTS/
  media providers. Load when packaging reusable helpers, effects, transitions,
  workflows or providers — or when an extension warning appears.
---

# Extensions: package what you repeat

When a task needs a reusable niche helper across scenes or projects — an
audio-reactive mascot mouth state (`C.ext.mouth.state(t)`), a shared brand kit
of fonts/logos (`assets/ext/kit/...`), a custom media processor (an `ffmpeg`
filter chain or a child-process `node` script), a parameterized multi-step
recipe, a planner that places cues from composition events — package it as a
Cuthol extension instead of repeating boilerplate. No rebuild or server restart
is needed; every `extension` call reads from disk.

**When to write one:** the same composition helper, asset set, filter chain or
multi-step workflow is needed in ≥ 2 scenes or projects; a beat-driven edit
needs a data-dependent number of cues (planner); speech or music must come
from somewhere other than the built-ins (provider). Example scenarios: a mouth
helper + asset pack for a recurring character; an `atempo` processor recipe
that speeds a voiceover and places it; a planner that drops effects cues on
every `paper_drop` event (see `references/capabilities.md`); a folder of
licensed tracks served as a searchable shelf (see `references/providers.md`).

## Storage and precedence

- **Project-local:** `<project>/.cuthol/extensions/<name>/` (`scope="project"`).
  Available only in that project. **Wins on name collision** (`list` marks
  `shadowed_persistent: true`).
- **Persistent:** `~/.cuthol/extensions/<name>/` (`scope="persistent"`).
  Redirect with `CUTHOL_EXTENSIONS_DIR=/path` (or `CUTHOL_USER_EXTENSIONS_DIR` /
  `CUTHOL_SHARED_EXTENSIONS_DIR`); if unset and `CUTHOL_CACHE_DIR` is custom,
  defaults to its sibling `extensions/`. Disable with
  `CUTHOL_EXTENSIONS_DIR=0` (or `false`/`off`/`none`) or
  `CUTHOL_DISABLE_EXTENSIONS=1`.

## Manifest (`cuthol-extension.json`)

Every extension folder carries a `cuthol-extension.json` whose `name` matches
the folder (`^[a-z][a-z0-9_-]{0,63}$`). Unknown fields are `[CUTHOL-G112]`.
Fields: `schema_version` (`"1.0.0"`), `name`, `version`, `description` (all
required except `schema_version`), `network` (default `false`; declare `true`
when the extension touches the network), `helper` (`.js` path), `assets`
(folder), `processors`, `fx`, `planners`, `recipes`, `providers`
(`{asr?, tts?, media?}`), `transitions`, `guide` (markdown path, default
`README.md`, read via `guide(topic="ext:<name>")`).

## What an extension can provide

| Kind | What it is | Start |
|---|---|---|
| Composition helper | JS synced to each composition as `assets/cuthol-ext-<name>.js`, exposed on `window.__cuthol.ext.<name>` | `extension create --template helper` |
| Asset pack | Fonts/images synced to `<composition>/assets/ext/<name>/…` | `--template assets` |
| Media processor | `ffmpeg` filter chain or sandboxed `node` script turning a handle into a new asset (cached, journaled) | `--template processor_ffmpeg` / `processor_node` |
| Clip effect (`fx`) | Named effect for `spine fx` with params and `animatable` subset | manifest `fx` section |
| Transition | Named spine transition (`ext:<name>/<kind>`) as ffmpeg templates | manifest `transitions` section |
| Recipe | Parameterized multi-step Cuthol workflow, one atomic undo unit | `--template recipe` |
| Planner | Sandboxed script proposing a variable-length cue patch from composition events + word timings (dry-run plan, atomic apply) | `--template planner` |
| Provider | `asr` / `tts` / `media` served by a sandboxed script over a fixed JSON contract | `examples/extensions/{asr,tts,media}-*` |
| Guide | The extension's own manual page | `guide: README.md` |

Details, contracts and a worked planner example: `references/capabilities.md`.
Provider contracts, secrets and examples: `references/providers.md`.

## Commands

| MCP call | CLI | Purpose |
|---|---|---|
| `extension(action="list", scope?)` | `cuthol extension list [--scope project\|persistent]` | List persistent, project-local and enabled extensions |
| `extension(action="create", name, scope?, template?, description?)` | `cuthol extension create --name <name> [--template full\|helper\|processor_ffmpeg\|processor_node\|assets\|recipe\|planner]` | Scaffold a new extension |
| `extension(action="show", name, scope?)` | `cuthol extension show --name <name>` | Inspect manifest, hash and file list |
| `extension(action="enable", name, scope?, dry_run?)` | `cuthol extension enable --name <name>` | Enable in project (or refresh pinned hash) & sync bridges |
| `extension(action="disable", name, dry_run?)` | `cuthol extension disable --name <name>` | Disable in project & remove helper script tags |
| `extension(action="promote", name, overwrite?)` | `cuthol extension promote --name <name>` | Copy project extension to persistent storage |
| `extension(action="remove", name, scope?)` | `cuthol extension remove --name <name> [--scope ...]` | Delete extension folder |
| `extension(action="run", name, processor?\|planner?\|recipe?, input?, params?, dry_run?)` | `cuthol extension run --name <name> [--planner <p> \| --processor <p> --input <h> \| --recipe <r>] [--params '{...}'] [--dry-run]` | Run a processor, planner or recipe |

Providers have no `extension run` entry point; they run through
`speech transcribe` / `speech synthesize` (`--provider ext:<name>`),
`speech.providers` (project defaults), and `library.search` / `library.fetch`.
Use `extension show` to inspect a provider's manifest section and script.

## Reproducibility, secrets, traps

- `extension.enable` pins `{name, version, content_hash, scope, enabled_at}`
  in `cuthol.sequence.json` and syncs helper/assets into mounted compositions.
  If the sources or a composition's copy drift, `verify` warns and **`render`
  stops** (`CUTHOL-G205`) — re-run `extension.enable` to accept the new hash.
  An extension whose transitions are in use cannot be disabled until those
  transitions are replaced (G122). Mounting a composition and `verify` also
  sync still-missing asset packs, so enabling before scaffolding no longer
  loses files — but if a composition renders with fallback fonts, re-run
  `enable` and check `assets/ext/<name>/` inside it.
- Manifest edits: read the file first, then write (a same-line read-write
  truncates it to empty JSON and fails with G112).
- Secrets: provider scripts declare env **names** in `env`; values come from
  the process environment or project `.env` at call time, reach only the child,
  and are never written to the sequence, journal, cache key, output or logs. A
  missing variable fails with `[CUTHOL-G232]`.
- Processors: declare a valid `asset_kind` (`footage`, `audio`, `graphic`,
  `voiceover`, `composition`) — anything else is `[CUTHOL-G112]`; when a video
  filter changes duration, pass `"audio": "drop"` or the old-length audio is
  copied with a G209 warning. Outputs cache by input + extension identity +
  params, so fixing a manifest and re-running with identical bytes can return
  the previously cached library item — verify manifest fixes in a clean
  project. Node processors/planners default to a 120 s limit (`timeout_sec`;
  `0` removes it); heavy chains on long clips need a higher budget.
- Security: node scripts run in a separate `node` child process with an
  isolated temp working directory — never `eval`/in-process import. Scripts may
  write only the designated output, the response file, and their temp dir
  (`CUTHOL_EXT_TMP` / `CUTHOL_PROVIDER_TMP`, deleted afterwards); anything else
  is `[CUTHOL-G206]`. With `network: false` (default), network APIs are
  forbidden (`[CUTHOL-G206]`); API-backed providers declare `network: true`.
  Every processor result reports `security_notice: {manifest_path, script_path,
  network_declared}`.
