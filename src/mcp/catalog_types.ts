/** Parameter/action/tool spec types and shared parameter builders of the MCP action catalog (see catalog.ts). */

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

export const TIME_HELP = "Time literal: '1500ms', '1.5s' or '00:01.500'.";

export const p = {
  handle: (desc: string, required = true): ParamSpec => ({ name: "handle", type: "string", description: desc, required }),
  clip: (desc = "Spine clip handle, e.g. 'sp_01'.", required = true): ParamSpec => ({
    name: "clip",
    type: "string",
    description: desc,
    required,
  }),
  speechLang: (): ParamSpec => ({ name: "lang", type: "string", description: "Speech language code ('auto' detects it from the audio, the default)." }),
  verbose: (): ParamSpec => ({
    name: "verbose",
    type: "boolean",
    description: "Return full arrays instead of the compact digest. Prefer `library.query` for slices.",
  }),
  dryRun: (desc: string): ParamSpec => ({ name: "dry_run", type: "boolean", description: desc }),
  out: (desc: string): ParamSpec => ({ name: "out", type: "string", description: desc }),
};
