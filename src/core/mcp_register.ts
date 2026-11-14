// MCP registration planning and application (`src/core/mcp_register.ts`).
//
// Pure functions for `cuthol setup`: read the current MCP state of each
// detected agent tool, plan the entry that would be written, and apply it.
// The `claude` CLI runner is injectable so tests never spawn the real one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectAgentTargets, isValidAgentId } from "./skills_install.js";
import { CutholError, DIAGNOSTICS } from "./diagnostics.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT_DIR = path.resolve(MODULE_DIR, "../..");

/** Agent tools `cuthol setup` can write config files for. */
export const SETUP_WRITABLE_IDS = ["codex", "cursor", "gemini-cli"] as const;

/** Agent tools handled by `cuthol setup` (writable files + claude-code via CLI). */
export const SETUP_HANDLED_IDS = ["claude-code", "codex", "cursor", "gemini-cli"] as const;

export interface SetupCommand {
  command: string;
  args: string[];
}

export function resolvePackageRootDir(): string {
  return PACKAGE_ROOT_DIR;
}

/**
 * The MCP command to register: `node <pkg>/dist/cli.js mcp`, or `npx -y cuthol mcp` from an npx cache.
 * On Windows `npx` is a `.cmd` shim that MCP clients cannot start without a shell, so it is wrapped in `cmd /c`.
 */
export function resolveSetupCommand(
  packageRootDir?: string,
  platform: NodeJS.Platform = process.platform
): SetupCommand {
  const root = packageRootDir ?? PACKAGE_ROOT_DIR;
  if (root.split(/[\\/]/).includes("_npx")) {
    return platform === "win32"
      ? { command: "cmd", args: ["/c", "npx", "-y", "cuthol", "mcp"] }
      : { command: "npx", args: ["-y", "cuthol", "mcp"] };
  }
  return { command: "node", args: [path.join(root, "dist", "cli.js"), "mcp"] };
}

export function resolveSetupHomeDir(): string {
  return os.homedir();
}

export type ClaudeRunner = (
  args: string[],
  options?: { windowsHide?: boolean }
) => { status: number | null; stdout: string; stderr: string };

export function defaultClaudeRunner(
  args: string[],
  _options?: { windowsHide?: boolean }
): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync("claude", args, { encoding: "utf8", windowsHide: true });
  return { status: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

export function isClaudeCliOnPath(runner?: ClaudeRunner): boolean {
  const run = runner ?? defaultClaudeRunner;
  try {
    const proc = run(["--version"], { windowsHide: true });
    return proc.status === 0;
  } catch {
    return false;
  }
}

export type SetupToolState =
  | "not-registered"
  | "registered-same"
  | "registered-different"
  | "broken"
  | "manual";

export interface SetupToolPlan {
  id: string;
  state: SetupToolState;
  /** Config file path, or null for claude-code / manual tools. */
  file: string | null;
  /** What would be written (null when nothing to write). */
  entry: SetupCommand | null;
  /** The exact manual instruction for the user. */
  manual: string | null;
  note?: string;
}

/** Read the cuthol entry recorded in a Codex TOML file, if any. */
export function readCodexEntry(fileText: string): SetupCommand | null | "broken" {
  const tableIdx = fileText.search(/^\s*\[mcp_servers\.cuthol\]/m);
  if (tableIdx < 0) return null;
  const after = fileText.slice(tableIdx);
  const lines = after.split(/\r?\n/);
  let command: string | null = null;
  let args: string[] | null = null;
  // Skip lines up to and including the `[mcp_servers.cuthol]` header itself,
  // so the header never trips the next-table break below.
  let i = 0;
  while (i < lines.length && !/^\s*\[mcp_servers\.cuthol\]/.test(lines[i])) i++;
  for (i++; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\[/.test(line)) break;
    const cmdMatch = line.match(/^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/);
    if (cmdMatch) {
      command = cmdMatch[1];
      continue;
    }
    const argsMatch = line.match(/^\s*args\s*=\s*\[(.*)\]\s*(?:#.*)?$/);
    if (argsMatch) {
      try {
        const parsed: unknown = JSON.parse(
          `[${argsMatch[1].replace(/'/g, '"')}]`
        );
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
          args = parsed as string[];
        } else {
          return "broken";
        }
      } catch {
        return "broken";
      }
    }
  }
  if (command === null) return "broken";
  return { command, args: args ?? [] };
}

function commandsEqual(a: SetupCommand, b: SetupCommand): boolean {
  return a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args);
}

/** Replace or append the `[mcp_servers.cuthol]` table; every other byte is kept. */
export function buildCodexFileText(fileText: string, entry: SetupCommand): string {
  const argsJson = JSON.stringify(entry.args);
  const table = `[mcp_servers.cuthol]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${argsJson}\n`;
  const match = fileText.match(/^\s*\[mcp_servers\.cuthol\][^\[]*/ms);
  if (!match || match.index === undefined) {
    const sep = fileText.length === 0 || fileText.endsWith("\n") ? "" : "\n";
    return `${fileText}${sep}${table}`;
  }
  const before = fileText.slice(0, match.index);
  const after = fileText.slice(match.index + match[0].length);
  const trailingNewline = after.length > 0 && !after.startsWith("\n") ? "\n" : "";
  return `${before}${table}${trailingNewline}${after}`;
}

/** Read the cuthol entry from a Cursor/Gemini JSON file. */
export function readJsonEntry(fileText: string): SetupCommand | null | "broken" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    return "broken";
  }
  if (typeof parsed !== "object" || parsed === null) return "broken";
  const servers = (parsed as Record<string, unknown>)["mcpServers"];
  if (servers === undefined) return null;
  if (typeof servers !== "object" || servers === null) return "broken";
  const entry = (servers as Record<string, unknown>)["cuthol"];
  if (entry === undefined) return null;
  if (typeof entry !== "object" || entry === null) return "broken";
  const rec = entry as Record<string, unknown>;
  if (typeof rec["command"] !== "string" || !Array.isArray(rec["args"])) return "broken";
  if (!(rec["args"] as unknown[]).every((v) => typeof v === "string")) return "broken";
  return { command: rec["command"] as string, args: rec["args"] as string[] };
}

/** Merge the cuthol entry into a JSON file, keeping every other key. */
export function buildJsonFileText(fileText: string, entry: SetupCommand): string {
  const parsed = JSON.parse(fileText) as Record<string, unknown>;
  const servers =
    typeof parsed["mcpServers"] === "object" && parsed["mcpServers"] !== null
      ? (parsed["mcpServers"] as Record<string, unknown>)
      : {};
  servers["cuthol"] = { command: entry.command, args: entry.args };
  parsed["mcpServers"] = servers;
  const newline = fileText.endsWith("\n") ? "\n" : "";
  return `${JSON.stringify(parsed, null, 2)}${newline}`;
}

export function codexConfigPath(homeDir: string): string {
  const override = process.env["CODEX_HOME"];
  if (override !== undefined && override.trim() !== "") return path.join(path.resolve(override.trim()), "config.toml");
  return path.join(homeDir, ".codex", "config.toml");
}

export function cursorConfigPath(homeDir: string): string {
  return path.join(homeDir, ".cursor", "mcp.json");
}

export function geminiConfigPath(homeDir: string): string {
  return path.join(homeDir, ".gemini", "settings.json");
}

export function configPathForId(id: string, homeDir: string): string | null {
  if (id === "codex") return codexConfigPath(homeDir);
  if (id === "cursor") return cursorConfigPath(homeDir);
  if (id === "gemini-cli") return geminiConfigPath(homeDir);
  return null;
}

export function manualInstructionFor(id: string, cmd: SetupCommand): string {
  const full = [cmd.command, ...cmd.args].join(" ");
  if (id === "claude-code") return `claude mcp add --scope user cuthol -- ${full}`;
  if (id === "copilot" || id === "opencode" || id === "agents") {
    return `Register "${full}" as the cuthol MCP server in the ${id} configuration (see the tool's MCP docs).`;
  }
  return `Register "${full}" as the cuthol MCP server for ${id}.`;
}

export interface PlanSetupOptions {
  ids?: string[];
  homeDir?: string;
  packageRootDir?: string;
  claudeRunner?: ClaudeRunner;
}

export interface PlannedSetup {
  command: SetupCommand;
  tools: SetupToolPlan[];
}

export function planSetup(options?: PlanSetupOptions): PlannedSetup {
  const home = options?.homeDir ?? resolveSetupHomeDir();
  const command = resolveSetupCommand(options?.packageRootDir);
  const detected = new Set(detectAgentTargets(home).map((t) => t.id));
  const claudeOnPath = isClaudeCliOnPath(options?.claudeRunner);
  if (options?.ids) {
    for (const id of options.ids) {
      if (!isValidAgentId(id)) {
        throw new CutholError(DIAGNOSTICS.SETUP_UNKNOWN_AGENT(id));
      }
    }
  }
  const wanted = options?.ids?.length ? options.ids : [...SETUP_HANDLED_IDS, ...[...detected].filter((id) => !(SETUP_HANDLED_IDS as readonly string[]).includes(id))];
  const tools: SetupToolPlan[] = [];
  for (const id of wanted) {
    if (id === "claude-code") {
      if (!claudeOnPath) {
        tools.push({ id, state: "manual", file: null, entry: null, manual: manualInstructionFor(id, command) });
        continue;
      }
      const run = options?.claudeRunner ?? defaultClaudeRunner;
      let state: SetupToolState = "not-registered";
      let note: string | undefined;
      try {
        const got = run(["mcp", "get", "cuthol"], { windowsHide: true });
        const combined = `${got.stdout}\n${got.stderr}`;
        if (got.status === 0) {
          state = combined.includes(command.args[0] ?? "") && combined.includes("mcp") ? "registered-same" : "registered-different";
        } else {
          const list = run(["mcp", "list"], { windowsHide: true });
          state = `${list.stdout}\n${list.stderr}`.includes("cuthol") ? "registered-different" : "not-registered";
        }
      } catch {
        state = "not-registered";
        note = "claude CLI check failed; assuming not registered.";
      }
      tools.push({ id, state, file: null, entry: state === "registered-same" ? null : command, manual: null, note });
      continue;
    }
    if (id === "codex" || id === "cursor" || id === "gemini-cli") {
      const file = configPathForId(id, home) as string;
      let text: string | null = null;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        text = null;
      }
      if (text === null) {
        tools.push({ id, state: "not-registered", file, entry: command, manual: null });
        continue;
      }
      const current = id === "codex" ? readCodexEntry(text) : readJsonEntry(text);
      if (current === "broken") {
        tools.push({ id, state: "broken", file, entry: command, manual: null });
        continue;
      }
      if (current === null) {
        tools.push({ id, state: "not-registered", file, entry: command, manual: null });
        continue;
      }
      tools.push(
        commandsEqual(current, command)
          ? { id, state: "registered-same", file, entry: null, manual: null }
          : { id, state: "registered-different", file, entry: command, manual: null }
      );
      continue;
    }
    tools.push({ id, state: "manual", file: null, entry: null, manual: manualInstructionFor(id, command) });
  }
  return { command, tools };
}

export interface ApplySetupOptions extends PlanSetupOptions {
  apply?: boolean;
  force?: boolean;
}

export interface AppliedToolResult extends SetupToolPlan {
  written: boolean;
  backup?: string;
  action: string;
}

export interface SetupReport {
  action: "setup";
  dry_run: boolean;
  command: SetupCommand;
  tools: AppliedToolResult[];
  backups: string[];
  diagnostics: Array<{ code: string; formatted: string }>;
}

function backupPathFor(file: string): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  return `${file}.cuthol-backup-${stamp}`;
}

function atomicWriteFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.cuthol-tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true, recursive: true });
    throw new Error(`Could not write '${file}'. | Suggestion: check that the folder exists and is writable.`);
  }
}

export function applySetup(options?: ApplySetupOptions): SetupReport {
  const planned = planSetup(options);
  const doApply = options?.apply === true;
  const force = options?.force === true;
  const diagnostics: SetupReport["diagnostics"] = [];
  const backups: string[] = [];
  const tools: AppliedToolResult[] = [];
  for (const tool of planned.tools) {
    if (tool.state === "manual") {
      const diag = DIAGNOSTICS.SETUP_MANUAL_ONLY(tool.id, tool.manual ?? "");
      diagnostics.push({ code: diag.code, formatted: diag.formatted });
      tools.push({ ...tool, written: false, action: tool.manual ?? "" });
      continue;
    }
    if (tool.id === "claude-code") {
      if (!doApply || tool.state === "registered-same") {
        tools.push({ ...tool, written: false, action: tool.state === "registered-same" ? "up to date" : `would run: claude mcp add --scope user cuthol -- ${planned.command.command} ${planned.command.args.join(" ")}` });
        continue;
      }
      if (tool.state === "registered-different" && !force) {
        const diag = DIAGNOSTICS.SETUP_DIFFERENT_ENTRY("claude-code");
        diagnostics.push({ code: diag.code, formatted: diag.formatted });
        tools.push({ ...tool, written: false, action: "kept (use --force to replace)" });
        continue;
      }
      const run = options?.claudeRunner ?? defaultClaudeRunner;
      try {
        if (tool.state === "registered-different") run(["mcp", "remove", "cuthol"], { windowsHide: true });
        const proc = run(["mcp", "add", "--scope", "user", "cuthol", "--", planned.command.command, ...planned.command.args], { windowsHide: true });
        if (proc.status !== 0) throw new Error(proc.stderr.trim() || `exit ${proc.status}`);
        tools.push({ ...tool, written: true, action: "registered" });
      } catch (err) {
        const diag = DIAGNOSTICS.SETUP_WRITE_FAILED("claude-code", err instanceof Error ? err.message : String(err));
        diagnostics.push({ code: diag.code, formatted: diag.formatted });
        tools.push({ ...tool, written: false, action: manualInstructionFor(tool.id, planned.command) });
      }
      continue;
    }
    const file = tool.file as string;
    if (!doApply) {
      tools.push({ ...tool, written: false, action: tool.state === "registered-same" ? "up to date" : `would write ${file}` });
      continue;
    }
    if (tool.state === "registered-same") {
      tools.push({ ...tool, written: false, action: "up to date" });
      continue;
    }
    if (tool.state === "broken") {
      const diag = DIAGNOSTICS.SETUP_CONFIG_UNPARSEABLE(file);
      diagnostics.push({ code: diag.code, formatted: diag.formatted });
      tools.push({ ...tool, written: false, action: "not written (unparseable)" });
      continue;
    }
    if (tool.state === "registered-different" && !force) {
      const diag = DIAGNOSTICS.SETUP_DIFFERENT_ENTRY(file);
      diagnostics.push({ code: diag.code, formatted: diag.formatted });
      tools.push({ ...tool, written: false, action: "kept (use --force to replace)" });
      continue;
    }
    try {
      const existing = (() => {
        try {
          return fs.readFileSync(file, "utf8");
        } catch {
          return tool.id === "codex" ? "" : JSON.stringify({ mcpServers: {} });
        }
      })();
      if (tool.id !== "codex") {
        try {
          JSON.parse(existing);
        } catch {
          const diag = DIAGNOSTICS.SETUP_CONFIG_UNPARSEABLE(file);
          diagnostics.push({ code: diag.code, formatted: diag.formatted });
          tools.push({ ...tool, written: false, action: "not written (unparseable)" });
          continue;
        }
      }
      const next = tool.id === "codex" ? buildCodexFileText(existing, planned.command) : buildJsonFileText(existing, planned.command);
      if (existing === next) {
        tools.push({ ...tool, written: false, action: "up to date" });
        continue;
      }
      let backup: string | undefined;
      try {
        if (fs.existsSync(file)) {
          backup = backupPathFor(file);
          fs.copyFileSync(file, backup);
          backups.push(backup);
        }
      } catch (err) {
        const diag = DIAGNOSTICS.SETUP_WRITE_FAILED(file, err instanceof Error ? err.message : String(err));
        diagnostics.push({ code: diag.code, formatted: diag.formatted });
        tools.push({ ...tool, written: false, action: "not written (backup failed)" });
        continue;
      }
      try {
        atomicWriteFile(file, next);
      } catch (err) {
        const diag = DIAGNOSTICS.SETUP_WRITE_FAILED(file, err instanceof Error ? err.message : String(err));
        diagnostics.push({ code: diag.code, formatted: diag.formatted });
        tools.push({ ...tool, written: false, action: "not written (write failed)", ...(backup ? { backup } : {}) });
        continue;
      }
      tools.push({ ...tool, written: true, action: `wrote ${file}`, ...(backup ? { backup } : {}) });
    } catch (err) {
      const diag = DIAGNOSTICS.SETUP_WRITE_FAILED(file, err instanceof Error ? err.message : String(err));
      diagnostics.push({ code: diag.code, formatted: diag.formatted });
      tools.push({ ...tool, written: false, action: "not written (write failed)" });
    }
  }
  return { action: "setup", dry_run: !doApply, command: planned.command, tools, backups, diagnostics };
}
