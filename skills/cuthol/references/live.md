# Cuthol Live window

Cuthol Live is a separate window the user keeps open while you edit: it shows
every change live, lets the user pin notes on a frame, pause you to edit the
timeline themselves, and watch render progress. It reads Cuthol's own state,
never asks you anything — open it once, then ignore it.

## Before the first edit

Read `workspace(action="live_status")` (CLI: `cuthol live status`) and follow
the window mode:

- `ask` (default): ask the user once, in one sentence and in their language,
  e.g. "Shall I open the Cuthol Live window? You'll see every change live, can
  pin notes on a frame, and can pause me to edit the timeline yourself."
  Yes → `live_open`; no → never ask again in this session.
- `on`: `live_open` without asking.
- `off`: never ask, never open.

After opening, stop thinking about the window.

## While editing

- A response may carry a `Live notes from the user` block (CLI) / `live_notes`
  field (MCP). Handle those notes first: each line points at exact item refs
  (`cue_12/#title`) — use them directly instead of searching.
- Notes arrive with your next command result; you cannot be woken while idle.
- When the user presses Pause in the window, the step you are on still
  completes; from then on every response starts with a `PAUSED:` line. Stop
  editing and run `live_wait` (CLI: `cuthol live wait`): it returns when they
  resume, with a summary of their edits. Read-only commands still work.
- If you keep writing after the `PAUSED:` line, writes are refused with `G601`
  and nothing changes; run `live_wait`, read the user's edits, then run the
  refused command again if it still makes sense on the new timeline.

## Window mode commands

- `live_config` reads the mode; `live_config(mode="ask"|"on"|"off")` sets the
  project mode (journaled, undoable), `global=true` sets the user-wide mode.
  Precedence: `CUTHOL_LIVE` env > project > user > `ask`.
- `live_stop` (CLI: `cuthol live stop`) stops the server (the window shows
  "disconnected").
- When paused, the user can mute/unmute a lane from its track header; their
  edit reaches you like any other human edit after `live_wait`.
