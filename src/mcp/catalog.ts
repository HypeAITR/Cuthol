/**
 * Cuthol MCP Action Catalog (`src/mcp/catalog.ts`).
 *
 * Single declarative source for the MCP surface. Every MCP action maps 1:1 onto a `cuthol` CLI
 * command, so the CLI stays the only implementation of editing behaviour. From this table the
 * server derives:
 *   1. the JSON Schema each tool advertises (every property says which actions use it),
 *   2. per-action argument validation (unknown / missing / wrong-typed arguments),
 *   3. the exact CLI argv the call is translated into.
 */

export type ParamType = "string" | "time" | "number" | "boolean" | "string_list" | "object";

export interface ParamSpec {
  /** MCP argument name (snake_case). */
  name: string;
  type: ParamType;
  description: string;
  /** CLI flag name without dashes; defaults to the kebab-case form of `name`. */
  flag?: string;
  /** Passed as positional CLI arguments instead of a flag. */
  positional?: boolean;
  /** Consumed by the MCP server for formatting/pagination instead of being passed to the CLI. */
  mcpOnly?: boolean;
  required?: boolean;
  enum?: string[];
}

export interface ActionSpec {
  tool: string;
  /** Action value inside the tool; `null` for single-purpose tools (`brief`, `verify`, `render`). */
  action: string | null;
  /** CLI argv prefix, e.g. `["spine", "trim"]`. Empty for MCP-only actions. */
  argv: string[];
  summary: string;
  params: ParamSpec[];
  /** Changes `cuthol.sequence.json` (serialized per workspace, journaled). */
  mutates: boolean;
  /** Long-running: emits progress notifications and gets the long timeout. */
  long?: boolean;
  /** Result keys holding PNG paths that are returned to the agent as images. */
  imageKeys?: string[];
  /** Handled inside the MCP server instead of the CLI. */
  mcpOnly?: boolean;
  /** Plain-text (markdown) CLI output instead of a JSON envelope. */
  textOutput?: boolean;
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
}

const TIME_HELP = "Time literal: '1500ms', '1.5s' or '00:01.500'.";

const p = {
  handle: (desc: string, required = true): ParamSpec => ({ name: "handle", type: "string", description: desc, required }),
  clip: (desc = "Spine clip handle, e.g. 'sp_01'.", required = true): ParamSpec => ({
    name: "clip",
    type: "string",
    description: desc,
    required,
  }),
  lang: (): ParamSpec => ({ name: "lang", type: "string", description: "Speech language code (default 'tr')." }),
  verbose: (): ParamSpec => ({
    name: "verbose",
    type: "boolean",
    description: "Return full arrays instead of the compact digest. Prefer `library.query` for slices.",
  }),
  dryRun: (desc: string): ParamSpec => ({ name: "dry_run", type: "boolean", description: desc }),
  out: (desc: string): ParamSpec => ({ name: "out", type: "string", description: desc }),
};

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "workspace",
    title: "Workspace & journal",
    description:
      "Create or open a Cuthol project folder and manage its revision journal. `init` creates a project and makes it the session default; `open` selects an existing one. Every edit is journaled: read `history.undo_preview` before `undo`, pass `expect_rev`, and use `dry_run` to preview.",
  },
  {
    name: "library",
    title: "Media library & analysis",
    description:
      "Import media and run cached analyzers. Imported files get typed handles (vid_01 video, aud_01 audio, img_01 image). Analyzers return compact digests; use `query` to read a time slice or search transcript words.",
  },
  {
    name: "brief",
    title: "Read the edit",
    description:
      "Token-efficient markdown view of the current edit. lens=overview (default: stage, library, spine, lanes), flow (chronological clips + anchored cues), canvas (what is on screen in `window`, with positions), detail (all fields of the handles in `id`). Call this before editing and whenever a result says the state changed.",
  },
  {
    name: "spine",
    title: "Primary spine edits",
    description:
      "Edit the magnetic primary storyline. Spine clips (sp_01, sp_02 …) play back-to-back with no gaps: trimming or removing a clip ripples everything after it, and lane cues anchored to a clip move with it.",
  },
  {
    name: "lane",
    title: "Overlay & audio lanes",
    description:
      "Place cues on parallel lanes: ln_titles (text), ln_captions, ln_broll, ln_motion (HyperFrames compositions), ln_vo (voiceover), ln_sfx, ln_bgm (music). A cue sits at an absolute time (`at`) or is anchored to a spine clip (`anchor` + `offset`) so it follows edits.",
  },
  {
    name: "composition",
    title: "HyperFrames motion graphics",
    description:
      "Author code-driven HTML/GSAP overlays. `scaffold` writes a ready folder (index.html + assets incl. GSAP and the `window.__cuthol` runtime); edit index.html, then mount it with lane.add_composition. `preview` renders the overlay over the real footage and returns a contact sheet (checkerboard | composite | alpha). Call guide(topic='compositions') before writing your own HTML.",
  },
  {
    name: "speech",
    title: "Speech: ASR, TTS, cleanup, captions",
    description:
      "Transcribe media (word timings, cached), synthesize voiceover, remove pauses/fillers from a talking clip (`cleanup`, use dry_run first), and generate word-highlighted captions on ln_captions.",
  },
  {
    name: "mix",
    title: "Audio mix",
    description:
      "Loudness-normalize (default −14 LUFS / −1 dBTP), clean voice, duck music under speech, and snap clip boundaries to music beats. Results include a `decision_trace` explaining each decision.",
  },
  {
    name: "cue",
    title: "Declarative cue sheets",
    description: "Export the edit as a cue sheet JSON, or diff/plan/apply a cue sheet file in one transaction.",
  },
  {
    name: "verify",
    title: "Verify the edit",
    description:
      "Run the 5 verification gates: G1 schema/handles, G2 files & source ranges, G3 timing (ERROR, edits that fail these are rolled back), G4 safe-zone & caption speed, G5 audio peaks & blank frames (WARN). Run before every render.",
  },
  {
    name: "monitor",
    title: "Look at the edit",
    description:
      "See the edit as images (returned inline): `frame` = one composited frame at `at` (fast, same pipeline as render), `sheet` = grid of frames across a window, `timeline` = lane diagram of the whole edit. Always look at frames before calling something done.",
  },
  {
    name: "render",
    title: "Render video",
    description:
      "Render the edit to MP4. draft_480p for checks, master_1080p for delivery. Long-running (progress notifications are sent). Run verify first and inspect the output with monitor.",
  },
  {
    name: "extension",
    title: "Extensions & custom tools",
    description:
      "Create, inspect, enable/disable, promote, remove and run project-local (.cuthol/extensions/<name>) or persistent (~/.cuthol/extensions/<name>) extensions providing composition helpers (window.__cuthol.ext.<name>), asset packs (assets/ext/<name>/), media processors (ffmpeg filters or child-process node scripts) and multi-step recipes.",
  },
  {
    name: "guide",
    title: "Cuthol manual",
    description:
      "Read the Cuthol manual. Topics: overview (workflow & rules), editing (spine/lanes/time/undo), speech_mix (ASR, captions, cleanup, ducking), compositions (writing HyperFrames overlays with window.__cuthol), verify_monitor (gates, frames, render), extensions (writing & using extensions), mcp (this server's conventions), or ext:<name> (an extension's README.md).",
  },
];

export const ACTION_SPECS: ActionSpec[] = [
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

  // ---------------------------------------------------------------- spine
  {
    tool: "spine",
    action: "append",
    argv: ["spine", "append"],
    summary: "Append a source range of an asset to the end of the spine.",
    mutates: true,
    params: [
      { name: "asset", type: "string", description: "Asset handle to append (vid_XX / img_XX).", required: true },
      { name: "in", type: "time", description: `Source in point (default 0). ${TIME_HELP}` },
      { name: "out", type: "time", description: `Source out point (default end of media). ${TIME_HELP}` },
      { name: "id", type: "string", description: "Explicit clip id (default next sp_XX)." },
    ],
  },
  {
    tool: "spine",
    action: "split",
    argv: ["spine", "split"],
    summary: "Split a clip at one or more points (source time unless sequence_time=true).",
    mutates: true,
    params: [
      p.clip(),
      { name: "at", type: "string_list", description: `Split points, e.g. ['2s','4.5s']. ${TIME_HELP}`, required: true },
      { name: "sequence_time", type: "boolean", description: "Interpret `at` as timeline time instead of source time." },
    ],
  },
  {
    tool: "spine",
    action: "trim",
    argv: ["spine", "trim"],
    summary: "Set a clip's source in/out points; later clips ripple.",
    mutates: true,
    params: [
      p.clip(),
      { name: "in", type: "time", description: `New source in point. ${TIME_HELP}` },
      { name: "out", type: "time", description: `New source out point. ${TIME_HELP}` },
    ],
  },
  {
    tool: "spine",
    action: "excise",
    argv: ["spine", "excise"],
    summary: "Cut ranges out of a clip and close the gaps (ripple delete).",
    mutates: true,
    params: [
      p.clip(),
      { name: "ranges", type: "string_list", description: "Ranges to remove, e.g. ['1.2s..2.0s','4.5s..5.1s'].", required: true },
      { name: "coord", type: "string", description: "Coordinate space of `ranges` (default clip_local).", enum: ["source", "sequence", "clip_local"] },
    ],
  },
  {
    tool: "spine",
    action: "remove",
    argv: ["spine", "remove"],
    summary: "Remove clips; the spine closes the gap.",
    mutates: true,
    params: [
      { name: "clips", type: "string_list", description: "Clip ids to remove.", required: true },
      { name: "cascade_cues", type: "boolean", description: "Also remove cues anchored to removed clips (default true)." },
    ],
  },
  {
    tool: "spine",
    action: "reorder",
    argv: ["spine", "reorder"],
    summary: "Move a clip before/after another clip or to an index.",
    mutates: true,
    params: [
      p.clip(),
      { name: "before", type: "string", description: "Place before this clip id." },
      { name: "after", type: "string", description: "Place after this clip id." },
      { name: "index", type: "number", description: "Zero-based target index." },
    ],
  },
  {
    tool: "spine",
    action: "transform",
    argv: ["spine", "transform"],
    summary: "Position/scale/rotate/fade a clip. Values are absolute ('1.2') or relative ('+=0.1', '-=5').",
    mutates: true,
    params: [
      p.clip(),
      { name: "x", type: "string", description: "Horizontal offset from centre in % of stage width (e.g. '0', '-10', '+=5')." },
      { name: "y", type: "string", description: "Vertical offset from centre in % of stage height." },
      { name: "scale", type: "string", description: "Uniform scale (1 = fit)." },
      { name: "scale_x", type: "string", description: "Horizontal scale." },
      { name: "scale_y", type: "string", description: "Vertical scale." },
      { name: "rotation", type: "string", description: "Rotation in degrees." },
      { name: "opacity", type: "string", description: "Opacity 0..1 or '50%'." },
      { name: "fit", type: "string", description: "How the media fills the stage.", enum: ["cover", "contain", "fill"] },
      { name: "mirror_x", type: "boolean", description: "Flip horizontally." },
      { name: "mirror_y", type: "boolean", description: "Flip vertically." },
    ],
  },
  {
    tool: "spine",
    action: "speed",
    argv: ["spine", "speed"],
    summary: "Change a clip's playback rate (timeline duration scales).",
    mutates: true,
    params: [
      p.clip(),
      { name: "rate", type: "number", description: "Playback rate, e.g. 1.25 (faster) or 0.5 (slow motion).", required: true },
      { name: "preserve_pitch", type: "boolean", description: "Keep audio pitch when changing speed." },
    ],
  },
  {
    tool: "spine",
    action: "transition",
    argv: ["spine", "transition"],
    summary: "Set the outgoing transition of a clip (into the next clip). kind='none' removes it.",
    mutates: true,
    params: [
      p.clip(),
      { name: "kind", type: "string", description: "Transition type (default dissolve).", enum: ["dissolve", "fade", "wipe_left", "wipe_right", "slide_up", "zoom_in", "none"] },
      { name: "duration", type: "time", description: `Transition length (default 400ms; at most half of the shorter clip). ${TIME_HELP}` },
      { name: "easing", type: "string", description: "Easing curve.", enum: ["linear", "ease_in", "ease_out", "ease_in_out"] },
    ],
  },
  {
    tool: "spine",
    action: "envelope",
    argv: ["spine", "envelope"],
    summary: "Keyframe a parameter over a clip's or cue's own time (e.g. slow zoom, fade, volume ride).",
    mutates: true,
    params: [
      { name: "clip", type: "string", description: "Spine clip (sp_XX) or lane cue (cue_XX) id.", required: true },
      {
        name: "param",
        type: "string",
        description: "Animated parameter.",
        enum: [
          "placement.x_pct",
          "placement.y_pct",
          "placement.scale_x",
          "placement.scale_y",
          "placement.rotation_deg",
          "placement.opacity",
          "audio_chain.gain_db",
        ],
        required: true,
      },
      { name: "points", type: "string_list", description: "Keyframes 'offset:value' relative to the item's start, e.g. ['0ms:1.0','4s:1.15'].", required: true },
      { name: "easing", type: "string", description: "Easing between keyframes (default ease_in_out).", enum: ["linear", "ease_in", "ease_out", "ease_in_out", "hold"] },
    ],
  },
  {
    tool: "spine",
    action: "reframe",
    argv: ["spine", "reframe"],
    summary: "Reframe wider (e.g. 16:9) spine clips for a narrower (e.g. 9:16) stage by tracking a single speaker/subject horizontally and writing `placement.scale_x` + a calm `placement.x_pct` envelope (or manual focal points).",
    mutates: true,
    params: [
      p.clip("Spine clip handle (sp_XX). Omit (or use `clips` / `all_spine`) to reframe all spine clips.", false),
      { name: "clips", type: "string_list", description: "Spine clip ids to reframe (default all spine clips when omitted)." },
      { name: "all_spine", type: "boolean", description: "Reframe all clips on the spine." },
      {
        name: "mode",
        type: "string",
        description: "Reframe mode: 'subject_track' (default, tracks single speaker/subject horizontally), 'center_lock' (static horizontal crop at `x` or 50%), or 'off' (reset reframe to 1x).",
        enum: ["subject_track", "center_lock", "off"],
      },
      {
        name: "points",
        type: "string_list",
        description: "Manual subject centre keyframes 'offset:center_x_pct' (0..100 in source frame, 50 = centre), e.g. ['0ms:50','40s:64','78.6s:55']. Patches auto trajectory within ±1.2s unless `replace=true`.",
      },
      {
        name: "replace",
        type: "boolean",
        description: "Use only manual `points` and ignore automatic subject tracking (default false = patch auto trajectory with manual points).",
      },
      {
        name: "deadband",
        type: "number",
        description: "Hysteresis deadband in % of source width (0.5..15, default 3.2); smaller movements stay locked on a stationary plateau.",
      },
      {
        name: "x",
        type: "string",
        description: "Fixed horizontal subject centre in % of source width (0..100, default 50) when `mode='center_lock'`.",
      },
      {
        name: "fps",
        type: "number",
        description: "Subject analysis sampling rate in fps 1..15 (default 4; 8 for clips <= 4s).",
      },
      p.dryRun("Compute the reframe trajectory, confidence and focal points without modifying the sequence."),
    ],
  },
  {
    tool: "spine",
    action: "mute",
    argv: ["spine", "mute"],
    summary: "Mute (or unmute when muted=false) one clip, a list of clips, or all spine clips.",
    mutates: true,
    params: [
      p.clip("Spine clip handle (sp_XX). Omit (or use `clips` / `all_spine`) to mute all spine clips.", false),
      { name: "clips", type: "string_list", description: "Spine clip ids to mute (default all spine clips when omitted)." },
      { name: "all_spine", type: "boolean", description: "Mute all clips on the spine." },
      { name: "muted", type: "boolean", description: "Mute state (default true; pass false to unmute)." },
    ],
  },
  {
    tool: "spine",
    action: "unmute",
    argv: ["spine", "unmute"],
    summary: "Unmute one clip, a list of clips, or all spine clips.",
    mutates: true,
    params: [
      p.clip("Spine clip handle (sp_XX). Omit (or use `clips` / `all_spine`) to unmute all spine clips.", false),
      { name: "clips", type: "string_list", description: "Spine clip ids to unmute (default all spine clips when omitted)." },
      { name: "all_spine", type: "boolean", description: "Unmute all clips on the spine." },
    ],
  },

  // ---------------------------------------------------------------- lane
  {
    tool: "lane",
    action: "add_cue",
    argv: ["lane", "add-cue"],
    summary: "Add a text title, media (broll/music/sfx/voiceover) or caption cue to a lane.",
    mutates: true,
    params: [
      { name: "lane", type: "string", description: "Target lane id (default ln_titles).", },
      { name: "kind", type: "string", description: "Cue kind (default from the lane).", enum: ["title", "caption", "broll", "music", "sfx", "voiceover"] },
      { name: "asset", type: "string", description: "Asset handle for media cues (broll/music/sfx/voiceover)." },
      { name: "text", type: "string", description: "Text for title/caption cues." },
      { name: "at", type: "time", description: `Absolute timeline start (default 0). Ignored when anchor is set. ${TIME_HELP}` },
      { name: "anchor", type: "string", description: "Spine clip id (sp_XX) or lane cue id (cue_XX) to attach to; the cue then follows that clip or cue through edits." },
      { name: "offset", type: "time", description: "Offset from the anchor clip/cue's start (default 0)." },
      { name: "duration", type: "time", description: "Cue length (default 3000ms, or scaled from asset length when rate is set)." },
      { name: "in", type: "time", description: `Source in point for media cues (default 0). ${TIME_HELP}` },
      { name: "out", type: "time", description: `Source out point for media cues. ${TIME_HELP}` },
      { name: "rate", type: "number", description: "Playback rate for audio/media cues, e.g. 1.3 (faster) or 0.75 (slower)." },
      { name: "preserve_pitch", type: "boolean", description: "Keep audio pitch when changing playback rate (default true, uses atempo)." },
      { name: "gain_db", type: "number", description: "Audio gain in dB for media cues (e.g. -6, 3)." },
      { name: "muted", type: "boolean", description: "Mute this cue's audio (default false)." },
      { name: "z_index", type: "number", description: "Layer stacking order (higher renders on top)." },
      { name: "size", type: "number", description: "Font size in px (titles)." },
      { name: "color", type: "string", description: "Text colour hex, e.g. '#FFFFFF'." },
      { name: "max_width", type: "number", description: "Max text width in % of stage width." },
      { name: "x", type: "number", description: "Horizontal offset from centre, % of stage width." },
      { name: "y", type: "number", description: "Vertical offset from centre, % of stage height (negative = up)." },
      { name: "scale", type: "number", description: "Scale factor." },
      { name: "rotation", type: "number", description: "Rotation in degrees (clockwise)." },
      { name: "opacity", type: "number", description: "Opacity 0..1." },
      { name: "id", type: "string", description: "Explicit cue id (default next cue_XX)." },
    ],
  },
  {
    tool: "lane",
    action: "add_composition",
    argv: ["lane", "add-composition"],
    summary: "Mount a HyperFrames composition folder on a lane (default ln_motion). The folder must contain index.html (create it with composition.scaffold).",
    mutates: true,
    params: [
      { name: "comp_dir", type: "string", description: "Composition folder (relative to the project folder).", required: true },
      { name: "lane", type: "string", description: "Target lane id (default ln_motion)." },
      { name: "at", type: "time", description: `Absolute timeline start (default 0). ${TIME_HELP}` },
      { name: "anchor", type: "string", description: "Spine clip id to attach to." },
      { name: "offset", type: "time", description: "Offset from the anchor clip's start." },
      { name: "duration", type: "time", description: "Overlay length (default 4000ms)." },
      { name: "z_index", type: "number", description: "Layer stacking order (higher renders on top; within the same lane, higher z_index or later cues render on top)." },
      { name: "props", type: "object", description: "Scalar props exposed to the HTML as window.__cuthol.props and HyperFrames variables." },
      { name: "mode", type: "string", description: "overlay_alpha (default, true alpha) or scene_host (only for backdrop-filter / mix-blend-mode that must read the video).", enum: ["overlay_alpha", "scene_host"] },
      { name: "entry", type: "string", description: "Entry HTML file (default index.html)." },
      { name: "scaffold", type: "string", description: "Create the folder from this preset if it has no index.html yet.", enum: ["blank", "counter", "beat_cards", "audio_glow", "cut_phases", "lower_third", "title_card", "stat_callout", "badge_overlay"] },
      { name: "id", type: "string", description: "Explicit cue id." },
    ],
  },
  {
    tool: "lane",
    action: "update_cue",
    argv: ["lane", "update-cue"],
    summary: "Change timing, playback rate, placement, text, gain or mute state of an existing cue. Placement values accept '+=' / '-='.",
    mutates: true,
    params: [
      { name: "cue", type: "string", description: "Cue id (cue_XX).", required: true },
      { name: "at", type: "time", description: "New absolute start." },
      { name: "anchor", type: "string", description: "Spine clip id (sp_XX) or lane cue id (cue_XX) to attach to, or 'none' to detach." },
      { name: "offset", type: "time", description: "Offset from the anchor clip/cue's start (default 0)." },
      { name: "duration", type: "time", description: "New length." },
      { name: "in", type: "time", description: `New source in point for media cues. ${TIME_HELP}` },
      { name: "out", type: "time", description: `New source out point for media cues. ${TIME_HELP}` },
      { name: "rate", type: "number", description: "Playback rate for audio/media cues (0.1..16.0, e.g. 1.3; rescales cue duration and projected word timings)." },
      { name: "preserve_pitch", type: "boolean", description: "Keep audio pitch when changing playback rate (default true, uses atempo)." },
      { name: "z_index", type: "number", description: "Layer stacking order within the lane (higher renders on top)." },
      { name: "x", type: "string", description: "Horizontal offset % (absolute or '+=5')." },
      { name: "y", type: "string", description: "Vertical offset % (absolute or '-=3')." },
      { name: "scale", type: "string", description: "Scale (absolute or relative)." },
      { name: "rotation", type: "string", description: "Rotation in degrees (absolute or relative, e.g. '15', '+=10', '-=5')." },
      { name: "opacity", type: "string", description: "Opacity (absolute or relative)." },
      { name: "text", type: "string", description: "New text." },
      { name: "size", type: "number", description: "Font size px." },
      { name: "max_width", type: "number", description: "Max text width %." },
      { name: "gain_db", type: "number", description: "Audio gain in dB for media cues." },
      { name: "muted", type: "boolean", description: "Mute or unmute this cue's audio." },
    ],
  },
  {
    tool: "lane",
    action: "excise",
    argv: ["lane", "excise"],
    summary: "Cut one or more ranges out of an audio/video lane cue (voiceover, music, sfx, broll) in one atomic step and ripple-close the gap on the lane.",
    mutates: true,
    params: [
      { name: "cue", type: "string", description: "Target lane cue id (cue_XX).", required: true },
      { name: "ranges", type: "string_list", description: "Ranges to remove, e.g. ['10s..14s', '22.5s..24s'].", required: true },
      { name: "coord", type: "string", description: "Coordinate space of `ranges` (default 'source').", enum: ["source", "sequence", "clip_local", "cue_local"] },
      { name: "ripple", type: "boolean", description: "Close the excised gap and shift subsequent cues on the lane (default true)." },
      { name: "across", type: "string", description: "Ripple scope: 'lane' (default: same lane + anchored cues + bound captions), 'all_lanes' (also unlocked cues on other lanes), 'all' or 'spine' (also primary spine), 'none' (lift without shifting).", enum: ["lane", "all_lanes", "all", "spine", "none"] },
    ],
  },
  {
    tool: "lane",
    action: "remove_cue",
    argv: ["lane", "remove-cue"],
    summary: "Remove cues.",
    mutates: true,
    params: [{ name: "cues", type: "string_list", description: "Cue ids to remove.", required: true }],
  },
  {
    tool: "lane",
    action: "lock",
    argv: ["lane", "lock"],
    summary: "Protect a lane: undo/redo will refuse to change its cues unless explicitly allowed.",
    mutates: true,
    params: [{ name: "lane", type: "string", description: "Lane id.", required: true }],
  },
  {
    tool: "lane",
    action: "unlock",
    argv: ["lane", "unlock"],
    summary: "Remove lane protection.",
    mutates: true,
    params: [{ name: "lane", type: "string", description: "Lane id.", required: true }],
  },

  // ---------------------------------------------------------------- composition
  {
    tool: "composition",
    action: "scaffold",
    argv: ["composition", "scaffold"],
    summary: "Create a composition folder (index.html + assets/gsap.min.js + window.__cuthol runtime). Use preset 'blank' to write your own animation.",
    mutates: false,
    params: [
      { name: "comp_dir", type: "string", description: "Folder to create (relative to the project), e.g. 'compositions/intro'.", required: true },
      { name: "preset", type: "string", description: "Starting point (default counter).", enum: ["blank", "counter", "beat_cards", "audio_glow", "cut_phases", "lower_third", "title_card", "stat_callout", "badge_overlay"] },
      { name: "duration", type: "time", description: "Composition length (default 3000ms); keep it equal to the cue duration." },
      { name: "props", type: "object", description: "Preset props, e.g. {headline, subline, value, accent}." },
      { name: "transparent", type: "boolean", description: "Transparent background (default true)." },
    ],
  },
  {
    tool: "composition",
    action: "write",
    argv: [],
    mcpOnly: true,
    summary: "Write a file inside a composition folder (default index.html). For agents without their own file tools.",
    mutates: false,
    params: [
      { name: "comp_dir", type: "string", description: "Composition folder inside the project, e.g. 'compositions/intro'.", required: true },
      { name: "file", type: "string", description: "File inside comp_dir (default index.html). Allowed: .html .css .js .json .svg." },
      { name: "content", type: "string", description: "Full new file content.", required: true },
    ],
  },
  {
    tool: "composition",
    action: "read",
    argv: [],
    mcpOnly: true,
    summary: "Read a file inside a composition folder (default index.html).",
    mutates: false,
    params: [
      { name: "comp_dir", type: "string", description: "Composition folder inside the project.", required: true },
      { name: "file", type: "string", description: "File inside comp_dir (default index.html)." },
    ],
  },
  {
    tool: "composition",
    action: "sync",
    argv: ["composition", "sync"],
    summary: "Refresh assets/cuthol-data.js of every mounted composition (normally automatic after edits).",
    mutates: false,
    params: [],
  },
  {
    tool: "composition",
    action: "preview",
    argv: ["composition", "preview"],
    summary: "Render a mounted composition over the real footage at local times and return a checkerboard | composite | alpha contact sheet plus contrast/alpha findings.",
    mutates: false,
    long: true,
    imageKeys: ["contact_sheet_path"],
    params: [
      { name: "cue", type: "string", description: "Composition cue id (cue_XX)." },
      { name: "comp_dir", type: "string", description: "Composition folder (alternative to `cue`)." },
      { name: "at", type: "string_list", description: "Local seconds inside the composition, e.g. ['0.5','1.5','3']." },
      p.out("Contact sheet PNG path."),
    ],
  },
  {
    tool: "composition",
    action: "check",
    argv: ["composition", "check"],
    summary: "Same as preview, focused on the findings (WCAG contrast on real footage, opaque-overlay leak G505).",
    mutates: false,
    long: true,
    imageKeys: ["contact_sheet_path"],
    params: [
      { name: "cue", type: "string", description: "Composition cue id (cue_XX)." },
      { name: "comp_dir", type: "string", description: "Composition folder (alternative to `cue`)." },
      { name: "at", type: "string_list", description: "Local seconds inside the composition." },
      p.out("Contact sheet PNG path."),
    ],
  },

  // ---------------------------------------------------------------- speech
  {
    tool: "speech",
    action: "transcribe",
    argv: ["speech", "transcribe"],
    summary: "Transcribe an asset (word timings, pauses, fillers). Cached per file; returns a digest.",
    mutates: true,
    long: true,
    params: [
      p.handle("Asset with speech (vid_XX / aud_XX)."),
      p.lang(),
      { name: "provider", type: "string", description: "ASR provider (default deepgram; 'local' needs a sidecar transcript or CUTHOL_LOCAL_ASR_CMD).", enum: ["deepgram", "local"] },
      p.verbose(),
    ],
  },
  {
    tool: "speech",
    action: "synthesize",
    argv: ["speech", "synthesize"],
    summary: "Generate a voiceover with word timings; optionally place it on a lane.",
    mutates: true,
    long: true,
    params: [
      { name: "text", type: "string", description: "Text to speak.", required: true },
      { name: "voice", type: "string", description: "Voice id." },
      { name: "model", type: "string", description: "TTS model id." },
      { name: "speed", type: "number", description: "Speaking rate multiplier." },
      { name: "provider", type: "string", description: "TTS provider (default elevenlabs; 'local' without CUTHOL_LOCAL_TTS_CMD produces placeholder tones, not speech).", enum: ["elevenlabs", "local"] },
      p.lang(),
      { name: "place_on_lane", type: "string", description: "Lane to place the voiceover on, e.g. 'ln_vo'." },
      { name: "at", type: "time", description: "Absolute start when placed." },
      { name: "anchor", type: "string", description: "Spine clip to anchor the voiceover to." },
      { name: "offset", type: "time", description: "Offset from the anchor clip." },
    ],
  },
  {
    tool: "speech",
    action: "cleanup",
    argv: ["speech", "cleanup"],
    summary: "Remove long pauses and fillers from all spine clips (or chosen clip/clips) in one atomic call, and surface contextual fillers (review_candidates) plus phrase repeats / sentence restarts (repetition_candidates) with persistent source-anchored IDs for agent selection via cut_candidates.",
    mutates: true,
    params: [
      p.clip("Transcribed spine clip (sp_XX). Omit to clean all spine clips in one atomic call.", false),
      { name: "clips", type: "string_list", description: "Spine clip ids to clean in one atomic call (default: all spine clips when clip/clips omitted)." },
      { name: "all_spine", type: "boolean", description: "Clean all spine clips in one atomic call (default true when clip/clips omitted)." },
      { name: "min_pause", type: "time", description: "Pauses at least this long are cut (default 400ms)." },
      { name: "pad", type: "time", description: "Breathing room kept around speech (default 75ms)." },
      { name: "remove_pauses", type: "boolean", description: "Cut pauses (default true)." },
      { name: "remove_fillers", type: "boolean", description: "Cut isolated filler words (default true)." },
      { name: "remove_repetitions", type: "boolean", description: "Automatically cut immediate single-word repeats (default false; repetitions and restarts are listed in repetition_candidates so the agent decides via cut_candidates)." },
      { name: "cut_candidates", type: "string_list", description: "Candidate IDs from dry-run review_candidates ('cf_<asset>_<start>_<end>') or repetition_candidates ('rr_<asset>_<start>_<end>', optionally with ':keep=1', ':cut=1', or '#1' to choose which attempt stays/goes), or source ranges ('36150..42880ms') to cut in this call." },
      p.lang(),
      p.dryRun("Report the planned cuts, candidate decisions, contextual filler review_candidates, and repetition_candidates without editing."),
      p.verbose(),
      { name: "limit", type: "number", description: "Max candidate decisions shown per page in the table (default 80).", mcpOnly: true },
      { name: "cursor", type: "string", description: "Pagination cursor for the candidate decisions table.", mcpOnly: true },
    ],
  },
  {
    tool: "speech",
    action: "captions",
    argv: ["speech", "captions"],
    summary: "Create caption cues on ln_captions from transcripts of spine clips and ln_vo voiceovers.",
    mutates: true,
    params: [
      p.clip("Only caption this spine clip.", false),
      { name: "all_spine", type: "boolean", description: "Caption spine clips only (skip voiceover lanes)." },
      { name: "style", type: "string", description: "Caption style (default active_word).", enum: ["active_word", "sentence", "boxed"] },
      { name: "max_words", type: "number", description: "Max words per caption group." },
      { name: "max_chars", type: "number", description: "Max characters per line." },
      p.lang(),
      { name: "replace", type: "boolean", description: "Replace existing caption cues instead of adding." },
      p.verbose(),
    ],
  },

  // ---------------------------------------------------------------- mix
  {
    tool: "mix",
    action: "normalize",
    argv: ["mix", "normalize"],
    summary: "Calibrate clip/voiceover gains and master mix gain to reach the loudness target without exceeding the true-peak ceiling; reports achieved_lufs and target_reached.",
    mutates: true,
    params: [
      { name: "target_lufs", type: "number", description: "Integrated loudness target (default −14)." },
      { name: "true_peak", type: "number", description: "True-peak ceiling in dBTP (default −1)." },
      { name: "clips", type: "string_list", description: "Limit to these clip/cue ids." },
      p.verbose(),
    ],
  },
  {
    tool: "mix",
    action: "polish_voice",
    argv: ["mix", "polish-voice"],
    summary: "Enable denoise + voice clarity chain on clips.",
    mutates: true,
    params: [
      { name: "clips", type: "string_list", description: "Clip ids (default all spine clips)." },
      { name: "nr_db", type: "number", description: "Noise reduction strength in dB (default 12)." },
      { name: "clarity", type: "boolean", description: "High-pass + presence boost + compression (default true)." },
    ],
  },
  {
    tool: "mix",
    action: "duck",
    argv: ["mix", "duck"],
    summary: "Lower music under speech (needs transcripts of the speech). Read decision_trace for skipped clips.",
    mutates: true,
    params: [
      { name: "bgm_lane", type: "string", description: "Music lane (default ln_bgm)." },
      { name: "duck_db", type: "number", description: "Attenuation in dB (default −12)." },
      { name: "attack", type: "time", description: "Fade-down time (default 120ms)." },
      { name: "release", type: "time", description: "Fade-up time (default 350ms)." },
      p.lang(),
    ],
  },
  {
    tool: "mix",
    action: "beat_align",
    argv: ["mix", "beat-align"],
    summary: "Snap spine clip boundaries to the nearest music beats within tolerance (uses the regular tempo/phase `grid` by default, or detected `onsets`; cuts with 0ms shift are reported as ALREADY_ON_BEAT).",
    mutates: true,
    params: [
      { name: "bgm_handle", type: "string", description: "Music asset handle (aud_XX).", required: true },
      { name: "clips", type: "string_list", description: "Clip ids to align (default all)." },
      {
        name: "mode",
        type: "string",
        description: "Beat source to snap to: 'grid' (default, regular tempo + phase beat grid) or 'onsets' (spectral-flux transient peaks).",
        enum: ["grid", "onsets", "onset"],
      },
      {
        name: "grid",
        type: "boolean",
        description: "Snap to the regular beat grid (`true`, default) or to detected onsets (`false`, equivalent to `mode='onsets'`).",
      },
      { name: "sensitivity", type: "number", description: "Beat detection sensitivity 0.8..3.0 (default 1.35; higher = more beats; affects `mode='onsets'`)." },
      { name: "tolerance", type: "time", description: `Max distance to snap a cut to a beat (default half a beat period, clamped to 120..500ms); farther cuts are skipped as OUT_OF_TOLERANCE. ${TIME_HELP}` },
      { name: "preserve_duration", type: "boolean", description: "Adjust the last clip so total spine duration stays close to the original (default false)." },
    ],
  },

  // ---------------------------------------------------------------- cue
  {
    tool: "cue",
    action: "export",
    argv: ["cue", "export"],
    summary: "Export the edit as a cue sheet (optionally to `file`).",
    mutates: false,
    params: [{ name: "file", type: "string", description: "Write the cue sheet JSON here." }],
  },
  {
    tool: "cue",
    action: "diff",
    argv: ["cue", "diff"],
    summary: "Show what a cue sheet file would change.",
    mutates: false,
    params: [{ name: "file", type: "string", description: "Cue sheet JSON file.", required: true }],
  },
  {
    tool: "cue",
    action: "plan",
    argv: ["cue", "plan"],
    summary: "Dry-run a cue sheet including verification.",
    mutates: false,
    params: [{ name: "file", type: "string", description: "Cue sheet JSON file.", required: true }],
  },
  {
    tool: "cue",
    action: "apply",
    argv: ["cue", "apply"],
    summary: "Apply a cue sheet in one journaled transaction.",
    mutates: true,
    params: [{ name: "file", type: "string", description: "Cue sheet JSON file.", required: true }],
  },

  // ---------------------------------------------------------------- verify
  {
    tool: "verify",
    action: null,
    argv: ["verify"],
    summary: "Run verification gates.",
    mutates: false,
    params: [
      { name: "gates", type: "string_list", description: "Subset of gates (default all).", enum: ["G1_SCHEMA", "G2_ASSETS", "G3_TIMING", "G4_STAGE", "G5_SIGNAL"] },
    ],
  },

  // ---------------------------------------------------------------- monitor
  {
    tool: "monitor",
    action: "frame",
    argv: ["monitor", "frame"],
    summary: "Composite one frame at `at` (returned as image) with luma stats and blank-frame check.",
    mutates: false,
    long: true,
    imageKeys: ["png_path"],
    params: [
      { name: "at", type: "time", description: `Timeline time of the frame. ${TIME_HELP}`, required: true },
      { name: "boxes", type: "boolean", description: "Draw safe zones and cue boxes (default true)." },
      p.out("PNG output path."),
    ],
  },
  {
    tool: "monitor",
    action: "sheet",
    argv: ["monitor", "sheet"],
    summary: "Contact sheet of frames sampled across a window or at explicit `at` timestamps (returned as image).",
    mutates: false,
    long: true,
    imageKeys: ["png_path"],
    params: [
      { name: "at", type: "string_list", description: `Explicit timeline timestamps to sample instead of uniform grid spacing, e.g. ['3s','12.5s','40s']. ${TIME_HELP}` },
      { name: "start", type: "time", description: "Window start (default 0)." },
      { name: "end", type: "time", description: "Window end (default end of edit)." },
      { name: "grid", type: "string", description: "Columns x rows, e.g. '4x3' (default 3x3, or auto-sized to fit `at`)." },
      { name: "boxes", type: "boolean", description: "Draw safe zones and cue boxes (default true)." },
      p.out("PNG output path."),
    ],
  },
  {
    tool: "monitor",
    action: "timeline",
    argv: ["monitor", "timeline"],
    summary: "Lane diagram of the whole edit (returned as image).",
    mutates: false,
    imageKeys: ["png_path"],
    params: [
      { name: "width", type: "number", description: "Image width px." },
      { name: "include_empty", type: "boolean", description: "Also draw empty lanes." },
      p.out("PNG output path."),
    ],
  },

  // ---------------------------------------------------------------- render
  {
    tool: "render",
    action: null,
    argv: ["render"],
    summary: "Render to MP4.",
    mutates: false,
    long: true,
    params: [
      { name: "preset", type: "string", description: "draft_480p (quick check) or master_1080p (default).", enum: ["draft_480p", "master_1080p"] },
      p.out("Output MP4 path (default under the project folder)."),
      { name: "workers", type: "number", description: "Parallel HyperFrames browser workers (default: hardware-calibrated, e.g. 6 on 12 cores).", flag: "--workers" },
    ],
  },

  // ---------------------------------------------------------------- extension
  {
    tool: "extension",
    action: "list",
    argv: ["extension", "list"],
    summary: "List persistent, project-local and enabled extensions.",
    mutates: false,
    params: [
      {
        name: "scope",
        type: "string",
        description: "Optional filter by scope ('project' or 'persistent').",
        enum: ["project", "persistent"],
      },
    ],
  },
  {
    tool: "extension",
    action: "create",
    argv: ["extension", "create"],
    summary: "Scaffold a new extension (cuthol-extension.json + sample files).",
    mutates: false,
    params: [
      {
        name: "name",
        type: "string",
        description: "Extension name (lowercase alphanumeric, '-', '_').",
        required: true,
      },
      {
        name: "scope",
        type: "string",
        description:
          "Target scope: 'project' (.cuthol/extensions/<name>, default when a project is open) or 'persistent' (~/.cuthol/extensions/<name>).",
        enum: ["project", "persistent"],
      },
      {
        name: "template",
        type: "string",
        description: "Scaffold template kind (default 'full').",
        enum: ["full", "helper", "processor_ffmpeg", "processor_node", "assets", "recipe", "planner"],
      },
      {
        name: "description",
        type: "string",
        description: "Description of what the extension provides.",
      },
      {
        name: "version",
        type: "string",
        description: "Extension version string (default '1.0.0').",
      },
      {
        name: "network",
        type: "boolean",
        description: "Declare true if the extension requires network access.",
      },
      {
        name: "overwrite",
        type: "boolean",
        description: "Overwrite existing extension folder if present.",
      },
    ],
  },
  {
    tool: "extension",
    action: "show",
    argv: ["extension", "show"],
    summary: "Show an extension's validated manifest, content hash and file list.",
    mutates: false,
    params: [
      { name: "name", type: "string", description: "Extension name to inspect.", required: true },
      {
        name: "scope",
        type: "string",
        description: "Optional explicit scope ('project' or 'persistent').",
        enum: ["project", "persistent"],
      },
    ],
  },
  {
    tool: "extension",
    action: "enable",
    argv: ["extension", "enable"],
    summary:
      "Enable an extension in the active project (or update its pinned content hash) and sync composition bridges.",
    mutates: true,
    params: [
      { name: "name", type: "string", description: "Extension name to enable.", required: true },
      {
        name: "scope",
        type: "string",
        description: "Optional explicit scope ('project' or 'persistent').",
        enum: ["project", "persistent"],
      },
      p.dryRun("Preview enabling without writing."),
    ],
  },
  {
    tool: "extension",
    action: "disable",
    argv: ["extension", "disable"],
    summary: "Disable an extension in the active project and remove its helper tag from compositions.",
    mutates: true,
    params: [
      { name: "name", type: "string", description: "Extension name to disable.", required: true },
      p.dryRun("Preview disabling without writing."),
    ],
  },
  {
    tool: "extension",
    action: "promote",
    argv: ["extension", "promote"],
    summary: "Promote a project-local extension (.cuthol/extensions/<name>) to persistent (~/.cuthol/extensions/<name>).",
    mutates: false,
    params: [
      { name: "name", type: "string", description: "Extension name to promote.", required: true },
      {
        name: "overwrite",
        type: "boolean",
        description: "Overwrite existing persistent extension with the same name (default true).",
      },
    ],
  },
  {
    tool: "extension",
    action: "remove",
    argv: ["extension", "remove"],
    summary: "Remove an extension folder from project or persistent storage.",
    mutates: false,
    params: [
      { name: "name", type: "string", description: "Extension name to remove.", required: true },
      {
        name: "scope",
        type: "string",
        description: "Scope to remove from ('project' or 'persistent').",
        enum: ["project", "persistent"],
      },
    ],
  },
  {
    tool: "extension",
    action: "run",
    argv: ["extension", "run"],
    summary: "Run an extension processor (producing a cached, journaled library asset) or multi-step recipe.",
    mutates: true,
    long: true,
    params: [
      { name: "name", type: "string", description: "Extension name.", required: true },
      {
        name: "processor",
        type: "string",
        description: "Processor name to run (auto-selected if the extension has only one processor).",
      },
      {
        name: "planner",
        type: "string",
        description: "Planner name to run (reads sequence + composition events/words and proposes a cue sheet patch in one atomic revision).",
      },
      {
        name: "recipe",
        type: "string",
        description: "Recipe name to run (auto-selected if no processor/planner is given and the extension has one recipe).",
      },
      {
        name: "input",
        type: "string",
        description: "Input library handle (e.g. 'aud_01', 'vid_01') or file path for a processor.",
      },
      {
        name: "handle",
        type: "string",
        description: "Alias for 'input': input library handle to process.",
      },
      {
        name: "target_handle",
        type: "string",
        description: "Optional explicit handle for the newly created library asset.",
      },
      {
        name: "params",
        type: "object",
        description: "Parameters JSON object passed to the processor or recipe (e.g. { rate: 1.3 }).",
      },
      {
        name: "scope",
        type: "string",
        description: "Optional explicit scope ('project' or 'persistent').",
        enum: ["project", "persistent"],
      },
      p.dryRun("Preview processor/recipe run without mutating the sequence."),
    ],
  },

  // ---------------------------------------------------------------- guide
  {
    tool: "guide",
    action: null,
    argv: [],
    mcpOnly: true,
    summary: "Read a manual topic or an extension's README.md ('ext:<name>').",
    mutates: false,
    params: [
      {
        name: "topic",
        type: "string",
        description:
          "Manual topic: overview (default), editing, speech_mix, compositions, verify_monitor, extensions, mcp, or 'ext:<name>' for an extension's README.md.",
      },
    ],
  },
];

/** Tools that do not take a workspace `dir`. */
export const WORKSPACELESS_TOOLS = new Set(["guide"]);

export function actionsForTool(tool: string): ActionSpec[] {
  return ACTION_SPECS.filter((a) => a.tool === tool);
}

export function findActionSpec(tool: string, action: string | null): ActionSpec | undefined {
  const list = actionsForTool(tool);
  if (list.length === 1 && list[0].action === null) return list[0];
  return list.find((a) => a.action === action);
}

function jsonSchemaForParam(param: ParamSpec): Record<string, unknown> {
  switch (param.type) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "object":
      return { type: "object" };
    case "string_list":
      return param.enum
        ? { type: "array", items: { type: "string", enum: param.enum } }
        : { type: "array", items: { type: "string" } };
    default:
      return param.enum ? { type: "string", enum: param.enum } : { type: "string" };
  }
}

/**
 * Builds the MCP tool definition. Properties shared by several actions are merged; each property
 * description lists the actions that use it so agents never have to guess.
 */
export function buildToolDefinition(tool: ToolSpec): {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
} {
  const actions = actionsForTool(tool.name);
  const singleAction = actions.length === 1 && actions[0].action === null;
  const properties: Record<string, Record<string, unknown>> = {};
  const usage = new Map<string, { actions: string[]; requiredIn: string[]; spec: ParamSpec }>();

  for (const a of actions) {
    for (const prm of a.params) {
      const entry = usage.get(prm.name) ?? { actions: [], requiredIn: [], spec: prm };
      entry.actions.push(a.action ?? tool.name);
      if (prm.required) entry.requiredIn.push(a.action ?? tool.name);
      usage.set(prm.name, entry);
    }
  }

  const actionLines = singleAction
    ? []
    : actions.map((a) => {
        const req = a.params.filter((x) => x.required).map((x) => x.name);
        return `- ${a.action}${req.length ? ` (needs: ${req.join(", ")})` : ""}: ${a.summary}`;
      });

  if (!singleAction) {
    properties.action = {
      type: "string",
      enum: actions.map((a) => a.action),
      description: "What to do. See the tool description for each action.",
    };
  }

  if (!WORKSPACELESS_TOOLS.has(tool.name)) {
    properties.dir = {
      type: "string",
      description:
        "Project folder. Optional after workspace.init/open (the session remembers it). Relative paths in other arguments resolve against this folder.",
    };
  }

  for (const [name, entry] of usage) {
    const schema = jsonSchemaForParam(entry.spec);
    let desc = entry.spec.description;
    if (!singleAction) {
      const usedIn = entry.actions.join(", ");
      const reqIn = entry.requiredIn.length ? ` Required for: ${entry.requiredIn.join(", ")}.` : "";
      desc = `[${usedIn}] ${desc}${reqIn}`;
    }
    properties[name] = { ...schema, description: desc };
  }

  const required: string[] = [];
  if (!singleAction) required.push("action");
  if (singleAction) {
    for (const prm of actions[0].params) if (prm.required) required.push(prm.name);
  }

  const readOnly = actions.every((a) => !a.mutates);
  return {
    name: tool.name,
    title: tool.title,
    description: actionLines.length ? `${tool.description}\n\nActions:\n${actionLines.join("\n")}` : tool.description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    annotations: {
      title: tool.title,
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: readOnly,
      openWorldHint: tool.name === "speech",
    },
  };
}

export interface ValidationIssue {
  kind: "unknown_action" | "unknown_arg" | "missing_arg" | "bad_type" | "bad_enum";
  message: string;
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

export function closestName(name: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(name, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best !== null && bestDist <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

/**
 * Normalizes and validates arguments for one action. Returns coerced values or the list of issues.
 */
export function validateActionArgs(
  spec: ActionSpec,
  args: Record<string, unknown>
): { values: Record<string, unknown>; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const values: Record<string, unknown> = {};
  const known = new Map(spec.params.map((prm) => [prm.name, prm]));
  const label = spec.action ? `${spec.tool}.${spec.action}` : spec.tool;

  for (const [key, raw] of Object.entries(args)) {
    if (key === "action" || key === "dir" || raw === undefined || raw === null) continue;
    const prm = known.get(key);
    if (!prm) {
      const otherActions = actionsForTool(spec.tool)
        .filter((a) => a !== spec && a.params.some((x) => x.name === key))
        .map((a) => a.action);
      const near = closestName(key, [...known.keys()]);
      issues.push({
        kind: "unknown_arg",
        message:
          `'${key}' is not an argument of ${label}.` +
          (near ? ` Did you mean '${near}'?` : "") +
          (otherActions.length ? ` ('${key}' belongs to: ${otherActions.join(", ")}.)` : "") +
          ` Valid: ${[...known.keys()].join(", ") || "(none)"}.`,
      });
      continue;
    }

    let val: unknown = raw;
    switch (prm.type) {
      case "number": {
        const n = typeof raw === "number" ? raw : Number(String(raw).trim().replace(/x$/i, ""));
        if (!Number.isFinite(n)) {
          issues.push({ kind: "bad_type", message: `'${key}' must be a number, got ${JSON.stringify(raw)}.` });
          continue;
        }
        val = n;
        break;
      }
      case "boolean": {
        if (typeof raw === "boolean") val = raw;
        else if (["true", "1", "yes"].includes(String(raw).toLowerCase())) val = true;
        else if (["false", "0", "no"].includes(String(raw).toLowerCase())) val = false;
        else {
          issues.push({ kind: "bad_type", message: `'${key}' must be true or false, got ${JSON.stringify(raw)}.` });
          continue;
        }
        break;
      }
      case "string_list": {
        let list: unknown[];
        if (Array.isArray(raw)) list = raw;
        else if (typeof raw === "string" && raw.trim().startsWith("[")) {
          try {
            list = JSON.parse(raw);
          } catch {
            list = raw.split(",");
          }
        } else list = String(raw).split(",");
        const cleaned = list.map((x) => String(x).trim()).filter(Boolean);
        if (cleaned.length === 0) {
          issues.push({ kind: "bad_type", message: `'${key}' must be a non-empty list of strings.` });
          continue;
        }
        if (prm.enum) {
          const bad = cleaned.filter((x) => !prm.enum!.includes(x));
          if (bad.length) {
            issues.push({ kind: "bad_enum", message: `'${key}' accepts ${prm.enum.join(", ")}; got ${bad.join(", ")}.` });
            continue;
          }
        }
        val = cleaned;
        break;
      }
      case "object": {
        if (typeof raw === "string") {
          try {
            val = JSON.parse(raw);
          } catch {
            issues.push({ kind: "bad_type", message: `'${key}' must be a JSON object.` });
            continue;
          }
        }
        if (!val || typeof val !== "object" || Array.isArray(val)) {
          issues.push({ kind: "bad_type", message: `'${key}' must be a JSON object.` });
          continue;
        }
        break;
      }
      default: {
        val = typeof raw === "string" ? raw : String(raw);
        if (prm.enum && !prm.enum.includes(val as string)) {
          const near = closestName(val as string, prm.enum);
          issues.push({
            kind: "bad_enum",
            message: `'${key}' accepts ${prm.enum.join(", ")}; got '${val}'.${near ? ` Did you mean '${near}'?` : ""}`,
          });
          continue;
        }
      }
    }
    values[key] = val;
  }

  for (const prm of spec.params) {
    if (prm.required && values[prm.name] === undefined && !issues.some((i) => i.message.startsWith(`'${prm.name}'`))) {
      issues.push({ kind: "missing_arg", message: `${label} needs '${prm.name}': ${prm.description}` });
    }
  }
  return { values, issues };
}

/** Translates validated values into CLI argv (always `--flag=value` so values starting with '-' are safe). */
export function buildCliArgv(spec: ActionSpec, values: Record<string, unknown>, workspaceDir: string): string[] {
  const argv = [...spec.argv];
  const positionals: string[] = [];
  for (const prm of spec.params) {
    const val = values[prm.name];
    if (val === undefined || prm.mcpOnly) continue;
    if (prm.positional) {
      positionals.push(...(Array.isArray(val) ? val.map(String) : [String(val)]));
      continue;
    }
    const flag = prm.flag ?? prm.name.replace(/_/g, "-");
    let str: string;
    if (prm.type === "string_list") str = (val as string[]).join(",");
    else if (prm.type === "object") str = JSON.stringify(val);
    else str = String(val);
    argv.push(`--${flag}=${str}`);
  }
  argv.push(...positionals);
  argv.push(`--dir=${workspaceDir}`);
  return argv;
}
