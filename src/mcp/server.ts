/**
 * Cuthol MCP Server (`src/mcp/server.ts` — `cuthol mcp` / `cuthol-mcp`).
 *
 * A thin, stateless-per-call adapter over the `cuthol` CLI:
 * - Every tool call is validated against the declarative catalog (`./catalog.ts`) and executed as a
 *   CLI child process, so the CLI remains the single implementation of editing behaviour.
 * - Calls on the same project are serialized (the journal is not safe for concurrent writers).
 * - Long actions (render, monitor, preview, ASR/TTS) stream `notifications/progress` when the client
 *   sends a progress token and can be cancelled with `notifications/cancelled`.
 * - Results are compact text (status · state digest · change · undo preview · warnings · payload);
 *   monitor/preview PNGs are returned as inline images so the agent can actually look at the edit.
 * - The session remembers the project folder after `workspace.init` / `workspace.open`.
 * - A `guide` tool serves the skill manual for clients that cannot load skill files.
 */

import { ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  ACTION_SPECS,
  ActionSpec,
  actionsForTool,
  buildCliArgv,
  buildToolDefinition,
  closestName,
  findActionSpec,
  TOOL_SPECS,
  validateActionArgs,
  WORKSPACELESS_TOOLS,
} from "./catalog.js";
import { formatWorkspaceOpenSummary, loadSequence } from "../core/workspace.js";
import {
  buildSkillsCatalogSection,
  LEGACY_GUIDE_FILES,
  maybeAutoInstallSkills,
  resolveGuideTopic,
  resolvePackageSkillsDir,
  scanSkills,
} from "../core/skills_install.js";
import { detectExternalChanges, formatExternalNotice, formatExternalReminder } from "../core/external_changes.js";
import { resolveExtension } from "../extensions/manager.js";
import { CUTHOL_PROGRESS_PREFIX } from "../core/progress.js";
import { repairToolArguments, readRevision, tryParseJson, formatEnvelopeCompact, findValuesByKey, stripCutholProgress } from "./mcp_format.js";
import { drainLiveInbox, formatLiveNotesBlock, LIVE_NOTES_HEADER } from "../live/live_inbox.js";
export { repairToolArguments, readWorkspaceRevision, translateCliHint, resolveActionSpecForCommand, formatEnvelopeCompact } from "./mcp_format.js";
export type { FormatEnvelopeCompactOptions } from "./mcp_format.js";


const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT_DIR = path.resolve(MODULE_DIR, "../..");
const DEFAULT_CLI_PATH = path.resolve(MODULE_DIR, "../cli.js");
const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const MAX_IMAGE_WIDTH = 1600;

// Legacy topic -> file under `skills/cuthol/`. Aliases fall back to these while
// the old single-skill tree is in place (the new skill folder is missing).
export const GUIDE_TOPICS: Record<string, string> = { ...LEGACY_GUIDE_FILES };

/** Tools visible before `discover_capabilities` when progressive disclosure is enabled. */
const PROGRESSIVE_CORE_TOOLS = new Set(["workspace", "library", "brief", "spine", "lane", "verify", "monitor", "guide"]);
const SPECIALIST_TOOLS = ["composition", "speech", "mix", "cue", "render", "extension"];

/**
 * Build the server instructions. The skill topic list is generated from a scan
 * of `skills/`, never fixed in code, so later skills show up automatically.
 */
export function buildServerInstructions(skillsDir?: string): string {
  let names: string[];
  try {
    names = scanSkills(skillsDir ?? resolvePackageSkillsDir()).map((s) => s.name);
  } catch {
    names = ["cuthol"];
  }
  if (!names.includes("cuthol")) names = ["cuthol", ...names];
  const categories = names.filter((n) => n !== "cuthol");
  const categoryLine =
    categories.length > 0
      ? `Read a category skill only when you need it: ${categories.join(", ")}.`
      : `No category skills are installed; the main skill covers everything.`;
  return `Cuthol is a video editor you drive through tools. A project is a folder with cuthol.sequence.json.

First step: read guide(topic="cuthol") — the main skill with the workflow, the timeline model and the rules. ${categoryLine} A reference file inside a skill: guide(topic="<skill>/<reference>").

Workflow:
1. workspace.init (new folder, set aspect/fps) or workspace.open (existing). The session then remembers the folder; pass dir only to switch projects.
2. library.ingest your media -> handles (vid_01, aud_01, img_01).
3. Build the primary storyline with spine.append/trim/split/excise/reframe (clips sp_01.. play back-to-back, edits ripple).
4. Put titles, captions, b-roll, music (ln_bgm), voiceover (ln_vo) and HyperFrames overlays (ln_motion) on lanes as cues (cue_01..). Anchor a cue to a clip (anchor=sp_XX) when it must follow edits.
5. Speech: speech.transcribe -> speech.cleanup (dry_run first) -> speech.captions. Mix: mix.normalize, mix.duck, mix.beat_align.
6. Look before you claim anything: monitor.frame / monitor.sheet return images; verify must show 0 errors; then render.

Rules:
- Times are '1500ms', '1.5s' or '00:01.500'. Lane x/y are % offsets from the centre of the stage.
- Every edit returns the new revision, what changed and what an undo would revert. Undo with expect_rev; use dry_run when unsure.
- Errors explain the fix ("Suggestion"). Do not repeat an identical failing call; change the arguments.
- For your own animations: composition.scaffold preset=blank, write index.html (your file tools or composition.write) using window.__cuthol (C.word, C.beats, C.beatGrid, C.audio, C.cuts, C.drive, C.value), mount with lane.add_composition, then composition.preview. Read guide(topic="cuthol-motion") first.
- For reusable custom helpers, brand kits, media processors or multi-step recipes: use the extension tool (list/create/show/enable/disable/promote/remove/run) and read guide(topic="cuthol-extensions") or guide(topic="ext:<name>").
- Legacy guide aliases still work: overview, editing, speech_mix, compositions, verify_monitor, extensions, mcp.`;
}

export const SERVER_INSTRUCTIONS = buildServerInstructions();

export interface McpContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content: McpContent[];
  isError: boolean;
  /** Parsed CLI envelope (not sent over the wire unless `structuredOutput` is enabled). */
  envelope?: Record<string, unknown> | null;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface CutholMcpServerOptions {
  /** Project folder used when a call has no `dir` and no project was opened yet. */
  defaultDir?: string;
  /** Hide specialist tools until `discover_capabilities` (off by default). */
  progressive?: boolean;
  /** Also send `structuredContent` (full CLI envelope) in tool results. */
  structuredOutput?: boolean;
  cliPath?: string;
  onNotification?: (notif: JsonRpcNotification) => void;
  /** One-line note (e.g. skills auto-install) prepended to the first tool response only. */
  skillsNote?: string | null;
}

interface CallContext {
  requestId?: string | number | null;
  progressToken?: string | number;
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  elapsedMs: number;
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT_DIR, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface SessionProjectStamp {
  revision: number;
  projectId: string | null;
  createdAt: string | null;
}

function readProjectStamp(dir: string): SessionProjectStamp | null {
  try {
    const seq = JSON.parse(fs.readFileSync(path.join(dir, "cuthol.sequence.json"), "utf8")) as {
      meta?: { revision?: number; project_id?: unknown; created_at?: unknown };
    };
    if (typeof seq.meta?.revision !== "number") return null;
    return {
      revision: seq.meta.revision,
      projectId: typeof seq.meta.project_id === "string" ? seq.meta.project_id : null,
      createdAt: typeof seq.meta.created_at === "string" ? seq.meta.created_at : null,
    };
  } catch {
    return null;
  }
}

export class CutholMcpServer {
  private readonly options: CutholMcpServerOptions;
  private readonly cliPath: string;
  private sessionDir: string | null;
  private readonly unlockedSpecialists = new Set<string>();
  private readonly sessionProjects = new Map<string, SessionProjectStamp>();
  /** Last fully-reported external-change digest per project (repeat calls get a one-line reminder). */
  private readonly sessionExtNotes = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly running = new Map<string, ChildProcess>();
  private lastFailedSignature: string | null = null;
  private consecutiveFailures = 0;
  private pendingSkillsNote: string | null;
  public readonly sentNotifications: JsonRpcNotification[] = [];

  constructor(options: CutholMcpServerOptions = {}) {
    this.options = options;
    this.cliPath = options.cliPath ?? DEFAULT_CLI_PATH;
    this.sessionDir = options.defaultDir ? path.resolve(options.defaultDir) : null;
    this.pendingSkillsNote = options.skillsNote ?? null;
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    const notif: JsonRpcNotification = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
    this.sentNotifications.push(notif);
    this.options.onNotification?.(notif);
  }

  public getToolDefinitions(): Array<Record<string, unknown>> {
    const defs: Array<Record<string, unknown>> = TOOL_SPECS.filter(
      (t) => !this.options.progressive || PROGRESSIVE_CORE_TOOLS.has(t.name) || this.unlockedSpecialists.has(t.name)
    ).map((t) => buildToolDefinition(t));
    if (this.options.progressive && this.unlockedSpecialists.size < SPECIALIST_TOOLS.length) {
      defs.push({
        name: "discover_capabilities",
        title: "Unlock more tools",
        description: `Unlock specialist tools: ${SPECIALIST_TOOLS.join(", ")} (or 'all').`,
        inputSchema: {
          type: "object",
          properties: {
            groups: { type: "array", items: { type: "string", enum: [...SPECIALIST_TOOLS, "all"] } },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      });
    }
    return defs;
  }

  public async handleJsonRpcRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;
    const isNotification = req.id === undefined;
    try {
      switch (req.method) {
        case "initialize": {
          const requested = String((req.params as { protocolVersion?: unknown } | undefined)?.protocolVersion ?? "");
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
              serverInfo: { name: "cuthol", title: "Cuthol video editor", version: readPackageVersion() },
              capabilities: { tools: { listChanged: true } },
              instructions: buildServerInstructions(),
            },
          };
        }
        case "notifications/initialized":
          return null;
        case "notifications/cancelled": {
          const target = String((req.params as { requestId?: unknown } | undefined)?.requestId ?? "");
          this.running.get(target)?.kill();
          return null;
        }
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: this.getToolDefinitions() } };
        case "resources/list":
          return { jsonrpc: "2.0", id, result: { resources: [] } };
        case "prompts/list":
          return { jsonrpc: "2.0", id, result: { prompts: [] } };
        case "tools/call": {
          const params = (req.params ?? {}) as {
            name?: string;
            arguments?: unknown;
            _meta?: { progressToken?: string | number };
          };
          const result = await this.callTool(String(params.name ?? ""), params.arguments, {
            requestId: id,
            progressToken: params._meta?.progressToken,
          });
          const wire: Record<string, unknown> = { content: result.content, isError: result.isError };
          if (this.options.structuredOutput && result.envelope) wire.structuredContent = result.envelope;
          return { jsonrpc: "2.0", id, result: wire };
        }
        default:
          if (isNotification) return null;
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
      }
    } catch (err) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  private textResult(text: string, isError: boolean, envelope: Record<string, unknown> | null = null): McpToolResult {
    return { content: [{ type: "text", text }], isError, envelope };
  }

  /**
   * Out-of-journal change note for this project, if any: full text on the
   * first call (or when the change set grows/changes), a one-line reminder
   * while the same change persists. Never throws.
   */
  private externalChangesNote(dir: string): string | null {
    let changes;
    try {
      changes = detectExternalChanges(dir);
    } catch {
      return null;
    }
    if (!changes.has_changes) {
      this.sessionExtNotes.delete(dir);
      return null;
    }
    const last = this.sessionExtNotes.get(dir);
    if (last === changes.digest) return formatExternalReminder(changes);
    this.sessionExtNotes.set(dir, changes.digest);
    return formatExternalNotice(changes, "mcp");
  }

  /**
   * Executes one tool call and returns an MCP tool result. Never throws.
   * A pending skills-install note is prepended to the first response only.
   */
  public async callTool(toolName: string, rawArgs: unknown, ctx: CallContext = {}): Promise<McpToolResult> {
    const result = await this.callToolInner(toolName, rawArgs, ctx);
    const note = this.pendingSkillsNote;
    this.pendingSkillsNote = null;
    const first = result.content[0];
    if (note && first?.type === "text" && typeof first.text === "string") {
      result.content[0] = { ...first, text: `${note}\n${first.text}` };
    }
    return result;
  }

  /** Executes one tool call and returns an MCP tool result. Never throws. */
  private async callToolInner(toolName: string, rawArgs: unknown, ctx: CallContext = {}): Promise<McpToolResult> {
    const args = repairToolArguments(rawArgs);

    if (toolName === "discover_capabilities") {
      return this.discoverCapabilities(args);
    }

    const toolSpec = TOOL_SPECS.find((t) => t.name === toolName);
    if (!toolSpec) {
      const near = closestName(toolName, [...TOOL_SPECS.map((t) => t.name), "discover_capabilities"]);
      return this.textResult(
        `FAILED unknown tool '${toolName}'.${near ? ` Did you mean '${near}'?` : ""} Tools: ${TOOL_SPECS.map((t) => t.name).join(", ")}.`,
        true
      );
    }
    if (this.options.progressive && SPECIALIST_TOOLS.includes(toolName) && !this.unlockedSpecialists.has(toolName)) {
      this.unlockedSpecialists.add(toolName);
      this.notify("notifications/tools/list_changed");
    }

    const actions = actionsForTool(toolName);
    const singleAction = actions.length === 1 && actions[0].action === null;
    const actionName = singleAction ? null : typeof args.action === "string" ? args.action : null;
    const spec = findActionSpec(toolName, actionName);
    if (!spec) {
      const names = actions.map((a) => a.action as string);
      const near = actionName ? closestName(actionName, names) : null;
      return this.textResult(
        `FAILED ${toolName}: ${actionName ? `unknown action '${actionName}'.` : "missing 'action'."}${near ? ` Did you mean '${near}'?` : ""} Actions: ${names.join(", ")}.`,
        true
      );
    }

    const label = spec.action ? `${spec.tool}.${spec.action}` : spec.tool;
    const signature = `${label}:${JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]))}`;
    if (this.lastFailedSignature === signature && this.consecutiveFailures >= 2) {
      return this.textResult(
        `FAILED ${label}: this exact call already failed ${this.consecutiveFailures} times in a row and was not run again (CUTHOL-LOOP-GUARD). Read the previous error, check handles with brief, and change the arguments.`,
        true
      );
    }

    const { values, issues } = validateActionArgs(spec, args);
    if (issues.length) {
      return this.recordOutcome(
        signature,
        this.textResult(`FAILED ${label}: invalid arguments.\n${issues.map((i) => `- ${i.message}`).join("\n")}`, true)
      );
    }

    if (spec.tool === "guide") {
      const hintDir =
        typeof args.dir === "string" && args.dir.trim()
          ? path.resolve(args.dir.trim())
          : this.sessionDir;
      return this.recordOutcome(
        signature,
        this.readGuide(String(values.topic ?? ""), hintDir),
        false
      );
    }

    // Resolve the project folder.
    let workspaceDir: string | null = null;
    if (!WORKSPACELESS_TOOLS.has(spec.tool)) {
      if (typeof args.dir === "string" && args.dir.trim()) {
        workspaceDir = path.resolve(args.dir.trim());
      } else if (spec.tool === "workspace" && (spec.action === "init" || spec.action === "open")) {
        workspaceDir = null;
      } else if (this.sessionDir) {
        workspaceDir = this.sessionDir;
      } else if (fs.existsSync(path.join(process.cwd(), "cuthol.sequence.json"))) {
        workspaceDir = process.cwd();
      }
      const isWorkspacelessExtensionAction =
        spec.tool === "extension" &&
        (spec.action === "list" ||
          spec.action === "show" ||
          (spec.action === "create" && values.scope === "persistent") ||
          (spec.action === "remove" && values.scope === "persistent"));
      if (!workspaceDir && isWorkspacelessExtensionAction) {
        workspaceDir = process.cwd();
      }
      if (!workspaceDir) {
        return this.textResult(
          spec.action === "init"
            ? "FAILED workspace.init needs 'dir': the folder to create the project in."
            : spec.action === "open"
              ? "FAILED workspace.open needs 'dir': a folder that contains cuthol.sequence.json."
              : `FAILED ${label}: no project selected. Call workspace.init (new project) or workspace.open (existing) with 'dir', or pass 'dir' here.`,
          true
        );
      }
      if (
        !(spec.tool === "workspace" && spec.action === "init") &&
        !isWorkspacelessExtensionAction &&
        !fs.existsSync(path.join(workspaceDir, "cuthol.sequence.json"))
      ) {
        return this.textResult(
          `FAILED ${label}: '${workspaceDir}' is not a Cuthol project (no cuthol.sequence.json). Use workspace.init to create one.`,
          true
        );
      }
    }

    const dir = workspaceDir as string;
    const run = async (): Promise<McpToolResult> => {
      if (spec.tool === "workspace" && spec.action === "open") {
        this.sessionDir = dir;
        const opened = readProjectStamp(dir);
        this.sessionProjects.set(
          dir,
          opened ?? { revision: readRevision(dir) ?? 0, projectId: null, createdAt: null }
        );
        if (values.verbose === true) {
          const brief = await this.runCli(["brief", "--lens=overview", `--dir=${dir}`], dir, spec, ctx);
          this.externalChangesNote(dir);
          return this.textResult(`OK workspace.open · session project is now ${dir}\n\n${brief.stdout.trim()}`, false);
        }
        const { sequence } = loadSequence(dir);
        const extNote = this.externalChangesNote(dir);
        const summary = formatWorkspaceOpenSummary(sequence, {
          verbose: false,
          ...(extNote ? { noticeLine: extNote } : {}),
        });
        // Opening runs in-process (no CLI envelope), so queued Live notes are delivered here.
        const live = drainLiveInbox(dir);
        const openText = `OK workspace.open · session project is now ${dir}\n\n${summary}`;
        if (!live) return this.textResult(openText, false);
        const result = this.textResult([openText, ...formatLiveNotesBlock(live.lines)].join("\n"), false);
        for (const p of live.images) {
          const img = this.loadImage(path.isAbsolute(p) ? p : path.resolve(dir, p));
          if (img) result.content.push(img);
        }
        return result;
      }

      if (spec.tool === "composition" && (spec.action === "write" || spec.action === "read")) {
        return this.compositionFile(spec.action, dir, values);
      }

      if (spec.tool === "lane" && spec.action === "add_composition" && !values.scaffold) {
        const compDir = path.resolve(dir, String(values.comp_dir));
        const entry = String(values.entry ?? "index.html");
        if (!fs.existsSync(path.join(compDir, entry))) {
          return this.textResult(
            `FAILED lane.add_composition: ${path.join(compDir, entry)} does not exist. Create it first with composition(action=scaffold, comp_dir=${String(values.comp_dir)}, preset=blank) and edit index.html, or pass scaffold=<preset>.`,
            true
          );
        }
      }

      const beforeStamp = readProjectStamp(dir);
      const before = beforeStamp?.revision ?? null;
      const known = this.sessionProjects.get(dir);
      const revisionMoved = known !== undefined && before !== null && before !== known.revision;
      const recreated =
        known !== undefined &&
        beforeStamp !== null &&
        (beforeStamp.revision < known.revision ||
          (known.projectId !== null && beforeStamp.projectId !== known.projectId) ||
          (known.createdAt !== null && beforeStamp.createdAt !== known.createdAt));

      const argv = buildCliArgv(spec, values, dir);
      const res = await this.runCli(argv, dir, spec, ctx);
      const result = this.formatResult(spec, res, dir, values, before);
      const extNote = this.externalChangesNote(dir);
      if (extNote && result.content[0]?.type === "text") {
        result.content[0].text = `${extNote}\n${result.content[0].text}`;
      }

      const afterStamp = readProjectStamp(dir);
      if (afterStamp) this.sessionProjects.set(dir, afterStamp);
      if (spec.tool === "workspace" && spec.action === "init" && !result.isError) {
        this.sessionDir = dir;
      }
      if (
        known &&
        beforeStamp &&
        (recreated || revisionMoved) &&
        result.content[0]?.type === "text"
      ) {
        const note = recreated
          ? `project was recreated (r${known.revision} -> r${beforeStamp.revision}); earlier results do not belong to this project`
          : `NOTE the project changed outside this session (r${known.revision} -> r${beforeStamp.revision}); re-read it with brief before relying on earlier results.`;
        result.content[0].text = `${note}\n${result.content[0].text}`;
      }
      return result;
    };

    const outcome = spec.mutates || spec.long ? await this.enqueue(dir, run) : await run();
    return this.recordOutcome(signature, outcome, spec.mutates);
  }

  /**
   * Loop guard bookkeeping. Successful read-only calls (brief, monitor …) between two identical
   * failures do not reset the counter: re-reading and then repeating the same failing call is still a loop.
   */
  private recordOutcome(signature: string, result: McpToolResult, resetsGuard = true): McpToolResult {
    if (!result.isError && !resetsGuard) return result;
    if (result.isError) {
      if (this.lastFailedSignature === signature) this.consecutiveFailures += 1;
      else {
        this.lastFailedSignature = signature;
        this.consecutiveFailures = 1;
      }
    } else {
      this.lastFailedSignature = null;
      this.consecutiveFailures = 0;
    }
    return result;
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    this.queues.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  }

  private discoverCapabilities(args: Record<string, unknown>): McpToolResult {
    const requested = Array.isArray(args.groups) ? (args.groups as string[]) : ["all"];
    const before = this.unlockedSpecialists.size;
    for (const g of requested) {
      if (g === "all") SPECIALIST_TOOLS.forEach((s) => this.unlockedSpecialists.add(s));
      else if (SPECIALIST_TOOLS.includes(g)) this.unlockedSpecialists.add(g);
    }
    const changed = this.unlockedSpecialists.size > before;
    if (changed) this.notify("notifications/tools/list_changed");
    return this.textResult(
      `OK discover_capabilities · unlocked: ${[...this.unlockedSpecialists].join(", ") || "(none)"}${changed ? " · tools/list_changed sent" : ""}`,
      false
    );
  }

  /** Reads or writes a text file strictly inside `<project>/<comp_dir>/`. */
  private compositionFile(mode: "write" | "read", dir: string, values: Record<string, unknown>): McpToolResult {
    const compDir = path.resolve(dir, String(values.comp_dir));
    const fileRel = String(values.file ?? "index.html");
    const target = path.resolve(compDir, fileRel);
    const inside = (parent: string, child: string): boolean => {
      const rel = path.relative(parent, child);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    };
    if (!inside(dir, compDir) || !inside(compDir, target)) {
      return this.textResult(`FAILED composition.${mode}: '${fileRel}' must stay inside the project's composition folder.`, true);
    }
    if (!/\.(html|css|js|json|svg)$/i.test(target)) {
      return this.textResult(`FAILED composition.${mode}: only .html, .css, .js, .json and .svg files are allowed.`, true);
    }
    if (mode === "read") {
      if (!fs.existsSync(target)) {
        return this.textResult(`FAILED composition.read: ${target} does not exist.`, true);
      }
      return this.textResult(fs.readFileSync(target, "utf8"), false);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content = String(values.content);
    fs.writeFileSync(target, content, "utf8");
    const extNote = this.externalChangesNote(dir);
    const hints: string[] = [];
    if (/index\.html$/i.test(target)) {
      if (!/data-composition-id=/.test(content)) hints.push("missing data-composition-id on the root element");
      if (!/window\.__timelines\[/.test(content)) hints.push("timeline is not registered in window.__timelines");
      if (!/paused\s*:\s*true/.test(content)) hints.push("timeline should be created with { paused: true }");
      if (/https?:\/\//.test(content)) hints.push("remote URLs will not load during render; put files in assets/");
    }
    return this.textResult(
      (extNote ? `${extNote}\n` : "") +
        `OK composition.write · ${content.length} chars → ${target}` +
        (hints.length ? `\nWARN ${hints.join("; ")}` : "") +
        "\nNext: lane.add_composition (first time) or composition.preview to look at it.",
      false
    );
  }

  private readGuide(topic: string, workspaceDir?: string | null): McpToolResult {
    const trimmed = (topic || "").trim();
    if (/^ext:/i.test(trimmed)) {
      const extName = trimmed.slice(4).trim();
      try {
        const ext = resolveExtension(extName, workspaceDir);
        const guideRel = ext.guideRelPath ?? "README.md";
        const guideFile = path.join(ext.dir, guideRel);
        if (!fs.existsSync(guideFile)) {
          return this.textResult(
            `FAILED guide: extension '${ext.name}' does not have a guide file ('${guideRel}') in ${ext.dir}.`,
            true
          );
        }
        const text = fs.readFileSync(guideFile, "utf8").replace(/^---[\s\S]*?---\s*/, "");
        return this.textResult(text, false);
      } catch (err) {
        return this.textResult(
          `FAILED guide: ${err instanceof Error ? err.message : String(err)}`,
          true
        );
      }
    }
    const resolution = resolveGuideTopic(trimmed, resolvePackageSkillsDir());
    if (!resolution.ok) {
      return this.textResult(`FAILED guide: ${resolution.message}`, true);
    }
    if (resolution.kind === "catalog") {
      if (!fs.existsSync(resolution.mainFile)) {
        return this.textResult(`FAILED guide: main skill file '${resolution.mainFile}' not found.`, true);
      }
      const main = fs.readFileSync(resolution.mainFile, "utf8").replace(/^---[\s\S]*?---\s*/, "");
      return this.textResult(`${main}\n\n${buildSkillsCatalogSection(resolution.skills)}`, false);
    }
    if (!fs.existsSync(resolution.file)) {
      return this.textResult(
        `FAILED guide: topic '${trimmed}' is not available (file '${resolution.file}' not found).`,
        true
      );
    }
    const text = fs.readFileSync(resolution.file, "utf8").replace(/^---[\s\S]*?---\s*/, "");
    if (resolution.appendAudioPointer) {
      return this.textResult(
        `${text}\n\nRelated: for loudness, voice cleanup and music ducking also read guide(topic="cuthol-audio").`,
        false
      );
    }
    return this.textResult(text, false);
  }

  private runCli(argv: string[], cwd: string, spec: ActionSpec, ctx: CallContext): Promise<CliRun> {
    const timeoutMs = Number(process.env.CUTHOL_MCP_TIMEOUT_MS) || (spec.long ? 30 * 60_000 : 10 * 60_000);
    return new Promise((resolve) => {
      const started = Date.now();
      fs.mkdirSync(cwd, { recursive: true });
      const child = spawn(process.execPath, [this.cliPath, ...argv], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const key = ctx.requestId !== undefined && ctx.requestId !== null ? String(ctx.requestId) : null;
      if (key) this.running.set(key, child);

      let stdout = "";
      let stderr = "";
      let stderrPending = "";
      let lastProgress = "";
      let lastNotifiedAt = 0;
      let announcedProgress = false;
      let tick = 0;
      let timedOut = false;
      let cancelled = false;
      const label = spec.action ? `${spec.tool}.${spec.action}` : spec.tool;
      const sendProgress = (force: boolean): void => {
        if (ctx.progressToken === undefined) return;
        const now = Date.now();
        const firstProgress = lastProgress.length > 0 && !announcedProgress;
        if (!force && !firstProgress && lastNotifiedAt !== 0 && now - lastNotifiedAt < 3000) return;
        if (lastProgress.length > 0) announcedProgress = true;
        lastNotifiedAt = now;
        tick += 1;
        const extra = lastProgress ? ` · ${lastProgress}` : "";
        this.notify("notifications/progress", {
          progressToken: ctx.progressToken,
          progress: tick,
          message: `${label} running · ${Math.round((now - started) / 1000)}s${extra}`,
        });
      };
      const noteProgressLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith(CUTHOL_PROGRESS_PREFIX)) return;
        lastProgress = trimmed;
        sendProgress(false);
      };
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString("utf8");
        stderr += chunk;
        stderrPending += chunk;
        const lines = stderrPending.split(/\r?\n/);
        stderrPending = lines.pop() ?? "";
        for (const line of lines) noteProgressLine(line);
      });

      const progressTimer =
        ctx.progressToken !== undefined ? setInterval(() => sendProgress(true), 3000) : null;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      const finishRun = (): void => {
        const pending = stderrPending.trim();
        if (pending.startsWith(CUTHOL_PROGRESS_PREFIX)) noteProgressLine(pending);
        clearTimeout(timeout);
        if (progressTimer) clearInterval(progressTimer);
        if (key) this.running.delete(key);
      };
      child.on("exit", (_code, signal) => {
        if (signal && !timedOut) cancelled = true;
      });
      child.on("close", (code) => {
        finishRun();
        resolve({ code, stdout, stderr, timedOut, cancelled, elapsedMs: Date.now() - started });
      });
      child.on("error", (err) => {
        finishRun();
        resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut, cancelled, elapsedMs: Date.now() - started });
      });
    });
  }

  private formatResult(
    spec: ActionSpec,
    run: CliRun,
    dir: string,
    values: Record<string, unknown> = {},
    revisionBefore: number | null = null
  ): McpToolResult {
    const label = spec.action ? `${spec.tool}.${spec.action}` : spec.tool;
    if (run.timedOut || run.cancelled) {
      return this.textResult(
        `FAILED ${label}: ${run.timedOut ? `timed out after ${Math.round(run.elapsedMs / 1000)}s` : "cancelled"}. The edit itself was not committed unless a later brief shows a new revision.`,
        true
      );
    }

    if (spec.textOutput && run.code === 0) {
      const plain = this.textResult(run.stdout.trim(), false);
      this.attachLiveSheetsFromText(plain.content, run.stdout, dir);
      return plain;
    }

    const strippedErr = stripCutholProgress(run.stderr);
    const env = tryParseJson(run.stdout) ?? tryParseJson(strippedErr.text);
    if (!env) {
      const raw = (strippedErr.text || run.stdout).trim().slice(-1500);
      return this.textResult(`FAILED ${label} (exit ${run.code}): ${raw || "no output"}`, true);
    }

    const { text, isError } = formatEnvelopeCompact({
      envelope: env,
      spec,
      dir,
      values,
      revisionBefore,
      exitCode: run.code,
    });

    const content: McpContent[] = [{ type: "text", text }];
    if (spec.imageKeys?.length) {
      for (const key of spec.imageKeys) {
        for (const p of findValuesByKey(env, key)) {
          const abs = path.isAbsolute(p) ? p : path.resolve(dir, p);
          const img = this.loadImage(abs);
          if (img) content.push(img);
        }
      }
    }
    // Cuthol Live: contact sheets ride along as inline images (same path as monitor images).
    const liveNotes = (env as Record<string, unknown>).live_notes as { images?: unknown } | undefined;
    if (liveNotes && Array.isArray(liveNotes.images)) {
      for (const p of liveNotes.images) {
        if (typeof p !== "string") continue;
        const abs = path.isAbsolute(p) ? p : path.resolve(dir, p);
        const img = this.loadImage(abs);
        if (img) content.push(img);
      }
    } else {
      this.attachLiveSheetsFromText(content, text, dir);
    }
    return { content, isError, envelope: env };
  }

  /**
   * Markdown answers (brief) carry Live notes as text only; their `sheet:` lines
   * name the contact sheets, which ride along as inline images too.
   */
  private attachLiveSheetsFromText(content: McpContent[], text: string, dir: string): void {
    const at = text.indexOf(LIVE_NOTES_HEADER);
    if (at < 0) return;
    for (const m of text.slice(at).matchAll(/^\s*sheet:\s*(\S+\.png)\s*$/gm)) {
      const img = this.loadImage(path.isAbsolute(m[1]) ? m[1] : path.resolve(dir, m[1]));
      if (img) content.push(img);
    }
  }

  /** Downscales a PNG to a JPEG preview (keeps tokens bounded) and returns it as MCP image content. */
  private loadImage(pngPath: string): McpContent | null {
    if (!fs.existsSync(pngPath)) return null;
    const preview = pngPath.replace(/\.png$/i, "") + ".mcp.jpg";
    const proc = spawnSync(
      "ffmpeg",
      ["-v", "error", "-y", "-i", pngPath, "-vf", `scale='min(${MAX_IMAGE_WIDTH},iw)':-2`, "-q:v", "4", preview],
      { timeout: 30_000, windowsHide: true }
    );
    if (proc.status === 0 && fs.existsSync(preview)) {
      return { type: "image", data: fs.readFileSync(preview).toString("base64"), mimeType: "image/jpeg" };
    }
    const size = fs.statSync(pngPath).size;
    if (size < 4 * 1024 * 1024) {
      return { type: "image", data: fs.readFileSync(pngPath).toString("base64"), mimeType: "image/png" };
    }
    return null;
  }
}

/** Tool definitions as advertised over MCP (also used by `cuthol help --json`). */
export const CUTHOL_MCP_TOOLS = TOOL_SPECS.map((t) => buildToolDefinition(t));

/** All catalogued actions (for documentation and tests). */
export const CUTHOL_MCP_ACTIONS = ACTION_SPECS;

export function startMcpStdioServer(options: Omit<CutholMcpServerOptions, "onNotification"> = {}): void {
  const write = (msg: unknown): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const autoSkillsNote = maybeAutoInstallSkills();
  const server = new CutholMcpServer({
    progressive: process.env.CUTHOL_MCP_PROGRESSIVE === "1",
    structuredOutput: process.env.CUTHOL_MCP_STRUCTURED === "1",
    defaultDir: options.defaultDir ?? process.env.CUTHOL_WORKSPACE,
    ...options,
    skillsNote: options.skillsNote ?? autoSkillsNote,
    onNotification: write,
  });
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch (err) {
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `Parse error: ${err instanceof Error ? err.message : String(err)}` },
      });
      return;
    }
    void server.handleJsonRpcRequest(req).then((res) => {
      if (res && req.id !== undefined) write(res);
    });
  });
}
