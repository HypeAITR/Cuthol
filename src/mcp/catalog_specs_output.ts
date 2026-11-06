// MCP action specs: verify, monitor, render, extension, guide (split out of catalog.ts; order is significant).
import { ActionSpec, p, TIME_HELP } from "./catalog_types.js";

export const OUTPUT_ACTION_SPECS: ActionSpec[] = [
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
      {
        name: "overlay_res",
        type: "string",
        description:
          "draft (default) captures overlays at the draft frame size. native captures them at master size and quality so a following master_1080p reuses the cache; that draft takes longer. Ignored on master_1080p. CUTHOL_DRAFT_OVERLAY_RES is the same switch; this flag wins.",
        enum: ["draft", "native"],
        flag: "overlay-res",
      },
      p.out("Output MP4 path (default under the project folder)."),
      { name: "workers", type: "number", description: "Parallel HyperFrames browser workers (default: hardware-calibrated, e.g. 6 on 12 cores).", flag: "workers" },
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
          "Manual topic: a skill name ('cuthol' when omitted, or a category skill), '<skill>/<reference>' for a reference file, a legacy alias (overview, editing, speech_mix, compositions, verify_monitor, extensions, mcp), or 'ext:<name>' for an extension's README.md.",
      },
    ],
  },
];
