// MCP action specs: workspace, library, brief (split out of catalog.ts; order is significant).
import { ActionSpec, p, TIME_HELP } from "./catalog_types.js";

export const PROJECT_ACTION_SPECS: ActionSpec[] = [
  // ---------------------------------------------------------------- workspace
  {
    tool: "workspace",
    action: "init",
    argv: ["workspace", "init"],
    summary: "Create a project in `dir` and make it the session default.",
    mutates: true,
    params: [
      { name: "aspect", type: "string", description: "Stage aspect ratio (default '9:16').", enum: ["9:16", "16:9", "1:1", "4:5"] },
      { name: "fps", type: "number", description: "Stage frame rate (default 30)." },
      { name: "title", type: "string", description: "Project title." },
    ],
  },
  {
    tool: "workspace",
    action: "open",
    argv: [],
    mcpOnly: true,
    summary: "Select an existing project folder (`dir`) as the session default and return its compact overview summary (counts + first few items; pass verbose=true for full tables).",
    mutates: false,
    params: [p.verbose()],
  },
  {
    tool: "workspace",
    action: "backdrop",
    argv: ["workspace", "backdrop"],
    summary: "Set the stage backdrop colour: the base of every frame wherever no clip or cue covers it (the background of a graphics-only video). Journaled; undo restores the previous colour.",
    mutates: true,
    params: [{ name: "color", type: "string", description: "Colour as '#RRGGBB' (e.g. '#F7C531').", required: true }],
  },
  {
    tool: "workspace",
    action: "journal",
    argv: ["workspace", "journal", "list"],
    summary: "List journal entries (revision, operation, delta).",
    mutates: false,
    params: [],
  },
  {
    tool: "workspace",
    action: "undo",
    argv: ["workspace", "journal", "undo"],
    summary: "Undo the last edit(s). Check `history.undo_preview` first.",
    mutates: true,
    params: [
      { name: "steps", type: "number", description: "Number of edits to undo (default 1)." },
      { name: "to", type: "number", description: "Undo back to this revision number." },
      { name: "expect_rev", type: "number", description: "Current revision you expect; the call is refused (G109) if it differs." },
      p.dryRun("Show what would be reverted without changing anything."),
      { name: "allow_protected", type: "string_list", description: "Cue/lane ids on locked lanes you explicitly allow to be reverted." },
    ],
  },
  {
    tool: "workspace",
    action: "redo",
    argv: ["workspace", "journal", "redo"],
    summary: "Redo previously undone edit(s).",
    mutates: true,
    params: [
      { name: "steps", type: "number", description: "Number of edits to redo (default 1)." },
      { name: "expect_rev", type: "number", description: "Current revision you expect." },
      p.dryRun("Show what would be re-applied without changing anything."),
    ],
  },
  {
    tool: "workspace",
    action: "tag",
    argv: ["workspace", "journal", "tag"],
    summary: "Name the current revision (checkpoint).",
    mutates: false,
    params: [{ name: "name", type: "string", description: "Tag name.", required: true }],
  },

  // ---------------------------------------------------------------- library
  {
    tool: "library",
    action: "ingest",
    argv: ["library", "ingest"],
    summary: "Import media files; returns their handles.",
    mutates: true,
    params: [
      { name: "files", type: "string_list", description: "Media file paths (absolute, or relative to the project folder).", positional: true, required: true },
      { name: "handle", type: "string", description: "Explicit handle for a single file (default: auto vid_XX/aud_XX/img_XX)." },
    ],
  },
  {
    tool: "library",
    action: "loudness",
    argv: ["library", "loudness"],
    summary: "Integrated LUFS, loudness range and true peak of an asset.",
    mutates: false,
    params: [
      p.handle("Asset handle (vid_XX / aud_XX)."),
      { name: "target_lufs", type: "number", description: "Target to compute the recommended gain for (default −14)." },
    ],
  },
  {
    tool: "library",
    action: "waveform",
    argv: ["library", "waveform"],
    summary: "Peak/RMS envelope, silence intervals and 3-band spectrum digest (optional PNG).",
    mutates: false,
    imageKeys: ["png_path"],
    params: [
      p.handle("Asset handle."),
      { name: "bins", type: "number", description: "Envelope resolution (default 160)." },
      { name: "png", type: "string", description: "Write a waveform/spectrum PNG to this path (returned as image)." },
      p.verbose(),
    ],
  },
  {
    tool: "library",
    action: "beats",
    argv: ["library", "beats"],
    summary: "Regular tempo/phase beat grid (`grid_ms`, `grid_bpm`, `phase_ms`) and separate spectral-flux onset peaks (`onsets` with strength) of an audio/video asset.",
    mutates: false,
    params: [
      p.handle("Music or video asset handle (aud_XX / vid_XX)."),
      { name: "sensitivity", type: "number", description: "Onset detection sensitivity 0.8..3.0 (default 1.35; higher = lower threshold = more beats/onsets detected; the tempo/phase `grid` is sensitivity-independent)." },
      p.verbose(),
    ],
  },
  {
    tool: "library",
    action: "scenes",
    argv: ["library", "scenes"],
    summary: "Scene-cut times of a video asset.",
    mutates: false,
    params: [
      p.handle("Video asset handle (vid_XX)."),
      { name: "threshold", type: "number", description: "Scene change threshold 2..40 (default 10)." },
      p.verbose(),
    ],
  },
  {
    tool: "library",
    action: "subject",
    argv: ["library", "subject"],
    summary: "Track horizontal/vertical position and confidence of the primary subject (single speaker face or moving foreground) across a video asset.",
    mutates: false,
    params: [
      p.handle("Video asset handle (vid_XX)."),
      { name: "fps", type: "number", description: "Analysis sampling rate in fps 1..15 (default 4; 8 for assets <= 4s)." },
      p.verbose(),
    ],
  },
  {
    tool: "library",
    action: "detach_audio",
    argv: ["library", "detach-audio"],
    summary: "Extract a video's audio as a new audio asset.",
    mutates: true,
    params: [
      p.handle("Video asset handle (vid_XX)."),
      { name: "target_handle", type: "string", description: "Handle for the new audio asset (default auto)." },
    ],
  },
  {
    tool: "library",
    action: "query",
    argv: ["library", "query"],
    summary: "Read a slice of cached analysis: transcript words, beats (grid by default, or onsets when `text='onset'`), waveform bins, scenes or captions.",
    mutates: false,
    params: [
      p.handle("Asset handle, or 'ln_captions' for caption cues."),
      { name: "kind", type: "string", description: "Which analysis to read.", enum: ["transcript", "beats", "waveform", "scenes", "captions"] },
      { name: "format", type: "string", description: "Output format for transcript queries: 'default' (word objects) or 'compact' ('i:word@sec' strings, hundreds of words per page).", enum: ["default", "compact"] },
      { name: "range", type: "string", description: "Time window, e.g. '2s..8s' (source time of the asset)." },
      { name: "text", type: "string", description: "Find transcript words (Turkish-diacritic insensitive), or pass 'onset' with kind='beats' to query detected onset peaks instead of the regular beat grid." },
      { name: "limit", type: "number", description: "Max items (default 40; 600 when format='compact')." },
      { name: "cursor", type: "string", description: "Pagination cursor from a previous result." },
      { name: "max_tokens", type: "number", description: "Approximate output budget." },
    ],
  },

  // ---------------------------------------------------------------- brief
  {
    tool: "brief",
    action: null,
    argv: ["brief"],
    summary: "Markdown view of the edit.",
    mutates: false,
    textOutput: true,
    params: [
      { name: "lens", type: "string", description: "View (default overview).", enum: ["overview", "flow", "canvas", "detail"] },
      { name: "id", type: "string_list", description: "Handles for lens=detail, e.g. ['sp_01','cue_03']." },
      { name: "window", type: "string", description: "Time window for flow/canvas, e.g. '0s..5s' (a single instant: '2s..2s')." },
    ],
  },

];
