# Source map

Where things live in `src/`, and the few rules that keep the layout predictable.
Read this before searching the tree.

## Rules

- **One implementation, two front ends.** `cli.ts` is the only place editing
  behaviour is wired up. The MCP server (`mcp/`) validates a tool call against the
  catalog and runs the same command as a CLI subprocess.
- **Facade files.** Several large modules were split into smaller files in the
  same directory. The original file (for example `compositor/hyperframes_bridge.ts`,
  `render/renderer.ts`, `extensions/manager.ts`) now only re-exports. **Import from
  the facade** unless you are working inside that area; new code can go into the
  focused file.
- **Split files stay next to their facade.** A few modules compute paths from their
  own location (`import.meta.url`: package root, bundled GSAP, the CLI path), so
  moving a file to another directory changes behaviour.
- **Module state has one owner.** Mutable module-level state (overlay render
  tracking, the overlay pre-pass collector, encoder probe memo, the CLI's
  `activeCli*` output context) is declared in exactly one file. Other files may read
  it through imports but never redeclare it.
- **Diagnostics are central.** Every error/warning text and code lives in
  `core/diagnostics.ts` (`[CUTHOL-<code>] what | suggestion`).
- **Every write goes through the journal.** Mutations use
  `core/workspace.ts` (`commitSequenceMutation`) or `verify/gates.ts`
  (`commitVerifiedMutation`), so they are revisioned and undoable.

## Layers

```
cli.ts ── cli_args.ts, cli_help.ts, cli_output.ts, cli_cmd_*.ts
  │                     mcp/server.ts ── mcp/catalog*.ts, mcp/mcp_format.ts
  ▼                       (spawns the CLI)
core/        schema, time, timeline, workspace + journal, diagnostics, envelope, subprocess
library/     ingest/probe, ledger (SQLite), loudness, waveform, beats, scenes, subject, query
sequence/    spine (facade), lanes, cue sheet, stage
speech/      transcribe, synthesize, providers, cleanup (facade), repetitions, captions
mix/         audio_mix (facade): normalize, duck, beat align
compositor/  compiler (facade + video graph), HyperFrames bridge (facade), bridge exporter (facade),
             runtime injected into compositions, composition preview, .ass captions
render/      renderer (facade): render, segments, scans, preview, frames; encoder (facade)
monitor/     frame / sheet / timeline images
verify/      the five gates
brief/       lens-based project summary
extensions/  manager (facade): manifest, registry, lifecycle, processor, recipe, events, planner
live/        Cuthol Live: local server + window (src/live/ui, plain HTML/CSS/JS), write lock, notes inbox
```

## Directory map

### Entry points
| File | Responsibility |
|---|---|
| `cli.ts` | `main()`: argument validation, help, context setup, and dispatch `switch` over command groups. |
| `cli_output.ts` | CLI output state (`activeCli*`), `CliCommandContext`, and `emitEnvelopeObject` / `emitEnvelopeJson`. |
| `cli_cmd_*.ts` | Per-group CLI command handlers (`workspace`, `library`, `spine`, `lane`, `composition`/`cue`, `speech`, `mix`, `verify`/`monitor`/`render`/`brief`, `extension`, `skills`). |
| `cli_args.ts` | Flag lexicon (`KNOWN_CLI_FLAGS`, `BOOLEAN_FLAGS`), typo suggestions, `parseArgv`, `strFlag`/`numFlag`/`boolFlag`. |
| `cli_help.ts` | Plain-text help. |
| `mcp/server.ts` | `CutholMcpServer` (stdio JSON-RPC), session project, progress/cancel, `guide`. |
| `mcp/mcp_format.ts` | CLI envelope → short MCP text: hints, diagnostics, compact tables. |
| `mcp/catalog.ts` | Tool specs, JSON schemas, argument validation, MCP call → CLI argv. |
| `mcp/catalog_types.ts` | `ParamSpec` / `ActionSpec` / `ToolSpec` and shared parameter builders. |
| `mcp/catalog_specs_*.ts` | The action specs per area (project, timeline, media, output). Order matters. |

### core/
| File | Responsibility |
|---|---|
| `schema.ts` | `cuthol.sequence.json` types. |
| `time.ts`, `timeline.ts` | Integer-ms time parsing; the one definition of sequence duration. |
| `workspace.ts` | Project paths, load/save, journal (undo/redo/tag), open summary. |
| `diagnostics.ts` | All diagnostic codes and texts. |
| `envelope.ts`, `decision_trace.ts` | CLI/MCP response envelope, state delta, explainable decisions. |
| `subprocess.ts` | Spawning with the progress watchdog (stall → kill tree). |
| `standards.ts` | Default parameters and their sources. |
| `env.ts`, `png_canvas.ts` | `.env` loader; dependency-free PNG canvas. |
| `skills_install.ts` | Agent skill installer: `skills/` scan, agent-tool detection, atomic install/update/remove, auto-install hook, MCP `guide` topic resolution. |

### sequence/
| File | Responsibility |
|---|---|
| `spine.ts` | Facade. |
| `spine_time.ts` | Speed ramps, source ↔ sequence ms, transcript projection, magnetic reflow. |
| `spine_envelope.ts` | Envelope evaluation/slicing, reframe focal points. |
| `spine_edit.ts` | append, split, trim, excise, remove, reorder, transform, speed, transition, envelope, mute. |
| `spine_reframe.ts` | Subject-tracking reframe. |
| `lanes.ts` | Lane cues: add/update/remove, anchors, `lane excise`, markers. |
| `cuesheet.ts` | Declarative cue sheet: plan / apply / diff / export. |
| `stage.ts` | Stage-level edits (backdrop colour). |

### speech/ and mix/
| File | Responsibility |
|---|---|
| `speech/transcribe.ts`, `synthesize.ts`, `providers.ts` | ASR / TTS services and providers (cached in the ledger). |
| `speech/cleanup.ts` | Facade + `cleanupClipDialogue` orchestrator. |
| `speech/cleanup_candidates.ts` | Target clip resolution, asset transcript/repetition/acoustic memoization, review candidate collection, `cut_candidates` resolution. |
| `speech/cleanup_acoustic.ts` | Selected-candidate acoustic edge refinement and acoustic pause verification/splitting. |
| `speech/cleanup_plan.ts` | Per-clip candidate extraction, collar padding, boundary and inter-cut sliver guards. |
| `speech/cleanup_trace.ts`, `speech/cleanup_apply.ts` | Cleanup decision trace builder; single-clip and multi-clip atomic spine excision. |
| `speech/repetitions.ts` | Repetition and restart candidates (listed, never auto-cut). |
| `speech/captions.ts` | Caption generation. |
| `mix/audio_mix.ts` | Facade. |
| `mix/mix_normalize.ts` | Loudness normalization with master calibration; voice polish. |
| `mix/mix_duck.ts`, `mix/mix_beat_align.ts` | Ducking; beat alignment. |

### compositor/
| File | Responsibility |
|---|---|
| `compiler.ts` | Facade + `compileSequenceRenderPlan` (the video filter graph). |
| `compile_lane.ts`, `compile_spine.ts` | Per-lane compilation (HyperFrames compositions, visual asset cues, lane `.ass` typography) and per-clip spine compilation (inputs, speed, transforms, envelopes, transitions). |
| `compile_spine_timing.ts`, `compile_spine_color.ts`, `compile_spine_fx.ts`, `compile_spine_transition.ts`, `compile_spine_edge.ts` | Stages of the spine clip filter chain: timing / speed ramp, colour, per-clip fx, transitions (chain filters + overlay position), edge mode. Stage order is documented at the top of `compile_spine.ts`. |
| `compile_audio.ts` | The audio graph shared by render and loudness measurement. |
| `compile_filters.ts`, `compile_color.ts`, `compile_backdrop.ts` | Filter helpers; explicit BT.709 conversions; backdrop slices under compositions. |
| `hyperframes_bridge.ts` | Facade for everything HyperFrames: |
| `hf_common.ts` | Package root, local HyperFrames CLI / GSAP lookup, shared types. |
| `hf_lint.ts` | Lint with memo and severity mapping. |
| `hf_scaffold.ts` | Scaffolding and the composition contract validator. |
| `hf_cache_state.ts` | Overlay cache key and per-composition cache state. |
| `hf_blobs.ts` | Overlay blobs on disk (PNG sequence / video), cached lookup, staging. |
| `hf_render.ts` | Renders one composition to an overlay blob. |
| `hf_overlay_tracking.ts` | Render summary (`overlays`), concurrent pre-pass collector/runner. |
| `hf_frames.ts` | Single/batch composition frames, alpha bounding box. |
| `bridge_exporter.ts` | Facade + composition bridge sync (`syncCompositionBridgeFiles`, `syncAllCompositionBridges`). |
| `bridge_export_cue.ts` | Per-cue bridge export entry (`exportBridgeDataForCue`), context, auto-analyze guard. |
| `bridge_export_local.ts`, `bridge_export_global.ts` | Window-local and sequence-wide (`global`) bridge slice compilers. |
| `bridge_hash.ts` | Directory hashing and "which data does this composition use". |
| `bridge_extension_assets.ts` | Extension assets copied into compositions; stale-copy detection. |
| `cuthol_runtime.ts` | `window.__cuthol` source injected into compositions. Its output is part of the cache key; keep it byte-stable. |
| `composition_preview.ts`, `ass_generator.ts` | Composition preview sheet; `.ass` captions. |
| `coords_inpage.ts` | In-page box extractor (discovery, film-time seek, per-frame measurement). |
| `coords_extract.ts` | `composition coords` orchestration: browser, cache, summaries, frame queries. |
| `coords_query.ts` | Geometry query at one moment: ref resolution, stage mapping, gaps/overlap/order/relations. |
| `coords_cache.ts` | Coordinate cache key (overlay-key components + stage + engine + renderer) and atomic files. |
| `coords_map.ts` | Composition-pixel to stage-pixel mapping (compiler overlay formulas). |
| `coords_ink.ts` | Transparent margins of image assets (once per file) for ink boxes. |

### render/ and monitor/
| File | Responsibility |
|---|---|
| `renderer.ts` | Facade. |
| `render_main.ts` | `renderSequenceToMp4`: preparation/pre-pass, single/multi-segment dispatch, post-render checks, and summary. |
| `render_encode.ts` | Single-segment and multi-segment FFmpeg encoding, watchdog fallback, and audio/video muxing. |
| `render_segments.ts` | Time segments for long timelines; segmented audio. |
| `render_scan.ts`, `render_audio_health.ts` | Blank/backdrop and edge-strip scans; audio health against the source. |
| `render_preview.ts`, `render_frames.ts` | Cached preview composite; frames at given times for the monitor. |
| `encoder.ts` | Facade + hardware encoder probing/verification and selection. |
| `encoder_args.ts` | Encoder types, BT.709 output args, codec arguments. |
| `monitor/preview.ts`, `monitor/timeline_view.ts` | `monitor frame/sheet` images; timeline image. |

### verify/, brief/, library/, extensions/
| File | Responsibility |
|---|---|
| `verify/gates.ts` | Facade: `verifySequence`, `measureCuePixelBox`, verified commits. |
| `verify/gates_structural.ts`, `verify/gates_stage_signal.ts` | Gates 1–3 (`G1_SCHEMA`, `G2_ASSETS`, `G3_TIMING`) and Gates 4–5 (`G4_STAGE`, `G5_SIGNAL`). |
| `brief/inspector.ts` | `brief` lenses. |
| `library/*` | probe/ingest, ledger, loudness, waveform, beats, scenes, subject tracking, paginated query. |
| `extensions/manager.ts` | Facade. |
| `extensions/ext_manifest.ts` | Manifest types and closed-schema validation, path/network safety. |
| `extensions/ext_registry.ts` | Find, load, hash, list, show. |
| `extensions/ext_fx.ts`, `extensions/ext_transitions.ts` | Manifest `fx` and `transitions` sections. |
| `extensions/ext_effects.ts` | Effect registry of a sequence: `fx` / `transitions` of enabled extensions keyed `ext:<extension>/<name>`. |
| `extensions/ext_lifecycle.ts` | create, promote, remove, enable/disable per project. |
| `extensions/ext_processor.ts`, `ext_recipe.ts` | Processors (ffmpeg / node, cached); recipes (atomic). |
| `extensions/ext_events.ts`, `ext_planner.ts` | Composition events and planner snapshot; planners and patch validation. |

## Where to start

| Task | Start in |
|---|---|
| New CLI flag or command | `cli_args.ts` (lexicon), `cli_cmd_*.ts` / `cli.ts` (handler), `mcp/catalog_specs_*.ts` (MCP surface) |
| New diagnostic | `core/diagnostics.ts` |
| Render picture problem | `compositor/compiler.ts`, then `render/render_main.ts` |
| Render audio problem | `compositor/compile_audio.ts`, `render/render_segments.ts`, `render/render_audio_health.ts` |
| Overlay cache / re-render reasons | `compositor/hf_cache_state.ts`, `compositor/bridge_hash.ts`, `compositor/hf_overlay_tracking.ts` |
| Monitor differs from render | `render/render_frames.ts`, `compositor/hf_frames.ts` |
| Cleanup cut edges | `speech/cleanup_acoustic.ts`, `speech/cleanup_plan.ts` |
| Extension behaviour | `extensions/ext_*.ts` |

### live/
| File | Responsibility |
|---|---|
| `live_types.ts` | The `cuthol.live/1` contract: files under `.cuthol/live/`, server events, note packets. |
| `live_paths.ts` | Paths under `.cuthol/live/`; the window's static files (`src/live/ui/`, served from source). |
| `live_lock.ts` | `assertLiveWriteAllowed`: every sequence write checks it; G601 while the user holds the lock. |
| `live_inbox.ts` | Notes from the window: write, peek, drain into the next CLI/MCP response (`live_notes`). |
| `live_server.ts` | Local HTTP/SSE server: state feed, notes, lock, human edits. |
| `live_window.ts` | Opens the window (app-mode Chromium, else default browser). |
| `live_config.ts` | Open mode `ask|on|off` (env > project > user). |
| `ui/` | The window: `app.js` shell + store, one `<region>.js/.css` per panel, `live_client.js` connection. |
