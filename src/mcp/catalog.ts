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

import { ToolSpec, ActionSpec, p, TIME_HELP, ParamSpec } from "./catalog_types.js";
import { PROJECT_ACTION_SPECS } from "./catalog_specs_project.js";
import { TIMELINE_ACTION_SPECS } from "./catalog_specs_timeline.js";
import { MEDIA_ACTION_SPECS } from "./catalog_specs_media.js";
import { OUTPUT_ACTION_SPECS } from "./catalog_specs_output.js";

export type { ParamType, ParamSpec, ActionSpec, ToolSpec } from "./catalog_types.js";


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
      "Read the Cuthol manual. Start with topic 'cuthol' (workflow & rules), then read a category skill only when you need it, or '<skill>/<reference>' for a reference file. Legacy aliases (overview, editing, speech_mix, compositions, verify_monitor, extensions, mcp) and ext:<name> (an extension's README.md) also work.",
  },
];

export const ACTION_SPECS: ActionSpec[] = [
  ...PROJECT_ACTION_SPECS,
  ...TIMELINE_ACTION_SPECS,
  ...MEDIA_ACTION_SPECS,
  ...OUTPUT_ACTION_SPECS,
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

export interface CatalogFlagIssue {
  tool: string;
  action: string | null;
  param: string;
  flag: string;
}

/**
 * Flag names are stored without leading dashes. `buildCliArgv` always writes `--${flag}`.
 * A dash prefix is emitted twice (`----workers`) and the CLI rejects it as CUTHOL-G110.
 */
export function catalogFlagIssues(specs: readonly ActionSpec[] = ACTION_SPECS): CatalogFlagIssue[] {
  const issues: CatalogFlagIssue[] = [];
  for (const spec of specs) {
    for (const prm of spec.params) {
      if (typeof prm.flag === "string" && prm.flag.startsWith("-")) {
        issues.push({
          tool: spec.tool,
          action: spec.action,
          param: prm.name,
          flag: prm.flag,
        });
      }
    }
  }
  return issues;
}

const dashedCatalogFlags = catalogFlagIssues();
if (dashedCatalogFlags.length > 0) {
  const listed = dashedCatalogFlags
    .map((issue) => `${issue.tool}.${issue.param}=${issue.flag}`)
    .join(", ");
  throw new Error(`Catalog flag must not start with '-': ${listed}`);
}
