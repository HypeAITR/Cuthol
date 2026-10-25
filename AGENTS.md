# Cuthol — notes for coding agents

Cuthol is an open-source, local non-linear video editor (NLE) designed to be operated entirely by AI agents. Agents drive it through:
- their own skill files (`skills/cuthol/SKILL.md` + `references/`);
- an agent-specific interface (CLI and MCP).

It is built on HyperFrames, so agents can produce motion graphics and animation as code.

This file is for agents that work **on** Cuthol's code. To **use** Cuthol to edit a video, read [`skills/cuthol/SKILL.md`](skills/cuthol/SKILL.md) instead.

## Layout

The full file map, layering rules and where to start for each kind of change are in [`src/ARCHITECTURE.md`](src/ARCHITECTURE.md). Old module paths are kept as re-export facades; new code goes in the focused files next to them.

| Path | Contents |
|---|---|
| `src/cli.ts` | CLI entry point; command groups in `cli_cmd_*.ts`; every command emits a `cuthol.envelope/1` JSON result (`cli_output.ts`) |
| `src/mcp/` | MCP server: `catalog.ts` validates calls and maps them to CLI argv, tool/action specs live in `catalog_specs_*.ts`; `server.ts` runs the CLI per call, formats compact text results, returns images |
| `src/core/` | Sequence schema and handles, workspace and journal, diagnostics dictionary, open standards (`standards.ts`), time parsing |
| `src/sequence/` | Spine (magnetic storyline), lanes and cues, cue sheets |
| `src/library/` | Ingest/probe, loudness, beats (grid + onsets), scenes, waveform, subject tracking, ledger cache, queries |
| `src/speech/` | Transcription, cleanup (pauses/fillers), captions, voiceover synthesis |
| `src/mix/` | Normalization, voice polish, ducking, beat alignment |
| `src/compositor/` | ffmpeg filter-graph compiler, HyperFrames bridge and runtime (`window.__cuthol`), caption rendering, composition preview |
| `src/extensions/` | Extension system: manifests, registry, processors, planners, recipes, composition helpers |
| `src/monitor/`, `src/render/`, `src/verify/`, `src/brief/` | Frames/sheets/timeline, render + post-render scan, the 5 gates, text lenses |
| `skills/cuthol/` | The agent skill shipped with Cuthol |

Build with `npm install && npm run build`; run with `node dist/cli.js` (or `node dist/cli.js mcp`).

## Rules

1. **No shallow wrappers.** Model the real thing:
   - a multi-lane sequence (`spine` and `lanes`);
   - keyframe envelopes;
   - an audio chain (ITU-R BS.1770 loudness, denoise, sidechain ducking);
   - dual-clock speech alignment (source time vs. sequence time);
   - an atomic edit journal.
2. **Agent-first interface.** Design for agents, not for people clicking:
   - typed handles (`vid_01`, `sp_01`, `cue_01`), never reused after deletion;
   - lens-based context reading (`brief`);
   - a declarative cue sheet;
   - the 5-gate verifier (`verify`);
   - the contact-sheet monitor (`monitor`).

   Results must be short, structured and say what changed and how to undo it.
3. **Diagnostics are part of the interface.** Every error or warning has:
   - a code in `src/core/diagnostics.ts`;
   - the form `[CUTHOL-Gxxx] what | Öneri: fix`;
   - a fix the agent can act on.

   Prefer a precise warning over a silent wrong result.
4. **Integer milliseconds** everywhere in the sequence model; conversions to seconds or frames happen at the ffmpeg boundary.
5. **One code path per behavior.** For example, loudness measurement and render use the same audio graph compiler. Do not fork logic between preview, measurement and render.
6. **Evidence before "done".** A change is not finished until:
   - its output has been checked: rendered frames looked at, loudness measured, frame counts compared;
   - runtime errors have been read;
   - an end-to-end run passes.

   Report results plainly, without exaggeration. Do not state that something works without the evidence.
7. **No single-metric gaming.** When fixing a measurable problem, also check a counter-metric that would catch a cheap fix. For example:
   - zero overlapping cuts **and** the same time saved;
   - zero black frames **and** no shifted source frames.
8. **Keep the skill true.** When behavior or parameters change, update the MCP catalog (`src/mcp/catalog*.ts`) and `skills/cuthol/**`. Write only what the code does.
9. **Never commit secrets.** API keys live in the environment or a `.env` file, which is git-ignored.
