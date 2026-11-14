// `cuthol setup` tests: dry run, apply, idempotency, force, broken configs, claude runner.
//
// Every case runs against a temporary home directory; the real home folder and
// the real `claude` CLI are never touched (the claude runner is faked).
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applySetup,
  buildCodexFileText,
  buildJsonFileText,
  planSetup,
  readCodexEntry,
  readJsonEntry,
  resolveSetupCommand,
  type ClaudeRunner,
} from "../core/mcp_register.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const HOME_VARS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

const SCRATCH_ROOT = path.resolve(process.cwd(), "test-workspace", "mcp_register");

function makeTempHome(prefix: string): string {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH_ROOT, `${prefix}-`));
}

/** A fake `claude` CLI runner backed by an in-memory server list. */
function makeFakeClaude(initial: Array<{ command: string; args: string[] }> = []): {
  runner: ClaudeRunner;
  servers: Map<string, { command: string; args: string[] }>;
  calls: string[][];
} {
  const servers = new Map(initial.map((s) => ["cuthol", s]));
  const calls: string[][] = [];
  const runner: ClaudeRunner = (args) => {
    calls.push(args);
    if (args[0] === "--version") return { status: 0, stdout: "1.0.0", stderr: "" };
    if (args[0] === "mcp" && args[1] === "get" && args[2] === "cuthol") {
      const hit = servers.get("cuthol");
      if (!hit) return { status: 1, stdout: "", stderr: "not found" };
      return { status: 0, stdout: `cuthol: ${hit.command} ${hit.args.join(" ")}`, stderr: "" };
    }
    if (args[0] === "mcp" && args[1] === "list") {
      return { status: 0, stdout: [...servers.keys()].join("\n"), stderr: "" };
    }
    if (args[0] === "mcp" && args[1] === "add") {
      const dash = args.indexOf("--");
      const command = args[dash + 1];
      const rest = args.slice(dash + 2);
      servers.set("cuthol", { command, args: rest });
      return { status: 0, stdout: "added", stderr: "" };
    }
    if (args[0] === "mcp" && args[1] === "remove") {
      servers.delete("cuthol");
      return { status: 0, stdout: "removed", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unknown" };
  };
  return { runner, servers, calls };
}

function absentClaude(): ClaudeRunner {
  return () => {
    throw new Error("spawn claude ENOENT");
  };
}

function spawnEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  delete env.XDG_CONFIG_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  env.CUTHOL_SKILLS_AUTO = "0";
  return env;
}

function runCli(args: string[], home: string): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: spawnEnv(home),
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

const PKG_ROOT = path.resolve(process.cwd());
const EXPECTED_ARGS = [path.join(PKG_ROOT, "dist", "cli.js"), "mcp"];

test("setup: npx cache path registers `npx -y cuthol mcp` (wrapped in `cmd /c` on Windows)", () => {
  const npxRoot = path.join("C:", "Users", "u", "_npx", "abc", "node_modules", "cuthol");
  assert.deepEqual(resolveSetupCommand(npxRoot, "linux"), { command: "npx", args: ["-y", "cuthol", "mcp"] });
  assert.deepEqual(resolveSetupCommand("/home/u/.npm/_npx/abc/node_modules/cuthol", "darwin"), {
    command: "npx",
    args: ["-y", "cuthol", "mcp"],
  });
  assert.deepEqual(resolveSetupCommand(npxRoot, "win32"), {
    command: "cmd",
    args: ["/c", "npx", "-y", "cuthol", "mcp"],
  });
  const local = resolveSetupCommand(PKG_ROOT);
  assert.deepEqual(local, { command: "node", args: EXPECTED_ARGS });
});

test("setup: dry run writes nothing", () => {
  const home = makeTempHome("cuthol-setup-dry-");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
  const report = applySetup({ homeDir: home, packageRootDir: PKG_ROOT, claudeRunner: absentClaude() });
  assert.equal(report.dry_run, true);
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
  assert.equal(fs.existsSync(path.join(home, ".cursor", "mcp.json")), false);
  assert.equal(report.tools.find((t) => t.id === "codex")?.state, "not-registered");
  assert.equal(report.tools.find((t) => t.id === "claude-code")?.state, "manual");
});

test("setup: apply creates configs; second apply is a no-op; bytes outside cuthol table unchanged", () => {
  const home = makeTempHome("cuthol-setup-apply-");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
  const codexFile = path.join(home, ".codex", "config.toml");
  const before = `# user comment\n[other]\nfoo = 1\n\n[mcp_servers.other]\ncommand = "x"\n`;
  fs.writeFileSync(codexFile, before);
  const cursorFile = path.join(home, ".cursor", "mcp.json");
  fs.writeFileSync(cursorFile, JSON.stringify({ mcpServers: { other: { command: "x", args: [] } }, theme: "dark" }));
  const geminiFile = path.join(home, ".gemini", "settings.json");
  fs.writeFileSync(geminiFile, "{}");

  const first = applySetup({ homeDir: home, packageRootDir: PKG_ROOT, apply: true, claudeRunner: absentClaude() });
  assert.ok(first.tools.find((t) => t.id === "codex")?.written);
  assert.ok(first.backups.some((b) => b.startsWith(codexFile)));
  const afterCodex = fs.readFileSync(codexFile, "utf8");
  assert.ok(afterCodex.startsWith(before));
  assert.deepEqual(readCodexEntry(afterCodex), { command: "node", args: EXPECTED_ARGS });
  const afterCursor = JSON.parse(fs.readFileSync(cursorFile, "utf8")) as Record<string, unknown>;
  assert.equal((afterCursor as { theme: string }).theme, "dark");
  assert.deepEqual(readJsonEntry(fs.readFileSync(cursorFile, "utf8")), { command: "node", args: EXPECTED_ARGS });
  assert.deepEqual(readJsonEntry(fs.readFileSync(geminiFile, "utf8")), { command: "node", args: EXPECTED_ARGS });

  const second = applySetup({ homeDir: home, packageRootDir: PKG_ROOT, apply: true, claudeRunner: absentClaude() });
  assert.ok(second.tools.filter((t) => t.file !== null).every((t) => !t.written));
  assert.deepEqual(second.backups, []);
  assert.equal(fs.readFileSync(codexFile, "utf8"), afterCodex);
});

test("setup: broken JSON is not written and reports G630", () => {
  const home = makeTempHome("cuthol-setup-broken-");
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  const file = path.join(home, ".cursor", "mcp.json");
  fs.writeFileSync(file, "{ not json");
  const report = applySetup({ ids: ["cursor"], homeDir: home, packageRootDir: PKG_ROOT, apply: true, claudeRunner: absentClaude() });
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  assert.ok(report.diagnostics.some((d) => d.code === "CUTHOL-G630"));
});

test("setup: different entry refused without --force (G633), replaced with it", () => {
  const home = makeTempHome("cuthol-setup-force-");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const file = path.join(home, ".codex", "config.toml");
  fs.writeFileSync(file, `[mcp_servers.cuthol]\ncommand = "old"\nargs = ["x"]\n`);
  const refused = applySetup({ ids: ["codex"], homeDir: home, packageRootDir: PKG_ROOT, apply: true, claudeRunner: absentClaude() });
  assert.ok(!refused.tools[0].written);
  assert.ok(refused.diagnostics.some((d) => d.code === "CUTHOL-G633"));
  assert.ok(fs.readFileSync(file, "utf8").includes('"old"'));
  const forced = applySetup({ ids: ["codex"], homeDir: home, packageRootDir: PKG_ROOT, apply: true, force: true, claudeRunner: absentClaude() });
  assert.ok(forced.tools[0].written);
  assert.deepEqual(readCodexEntry(fs.readFileSync(file, "utf8")), { command: "node", args: EXPECTED_ARGS });
});

test("setup: claude CLI path registers via runner; absent CLI prints the manual command", () => {
  const home = makeTempHome("cuthol-setup-claude-");
  const fake = makeFakeClaude();
  const planned = planSetup({ ids: ["claude-code"], homeDir: home, packageRootDir: PKG_ROOT, claudeRunner: fake.runner });
  assert.equal(planned.tools[0].state, "not-registered");
  const applied = applySetup({ ids: ["claude-code"], homeDir: home, packageRootDir: PKG_ROOT, apply: true, claudeRunner: fake.runner });
  assert.ok(applied.tools[0].written);
  assert.deepEqual(fake.servers.get("cuthol"), { command: "node", args: EXPECTED_ARGS });
  assert.ok(fake.calls.some((c) => c.includes("add") && c.includes("--scope")));

  const manual = planSetup({ ids: ["claude-code"], homeDir: home, packageRootDir: PKG_ROOT, claudeRunner: absentClaude() });
  assert.equal(manual.tools[0].state, "manual");
  assert.ok(manual.tools[0].manual?.includes("claude mcp add"));
});

test("setup: other detected tools print a manual instruction and are never written", () => {
  const home = makeTempHome("cuthol-setup-manual-");
  fs.mkdirSync(path.join(home, ".copilot"), { recursive: true });
  const report = applySetup({ homeDir: home, packageRootDir: PKG_ROOT, apply: true, claudeRunner: absentClaude() });
  const copilot = report.tools.find((t) => t.id === "copilot");
  assert.equal(copilot?.state, "manual");
  assert.equal(copilot?.written, false);
  assert.equal(fs.existsSync(path.join(home, ".copilot", "mcp.json")), false);
});

test("setup: TOML/JSON builders keep unrelated content", () => {
  assert.ok(buildCodexFileText("", { command: "node", args: ["a", "mcp"] }).includes("[mcp_servers.cuthol]"));
  assert.deepEqual(
    readCodexEntry(buildCodexFileText(`[mcp_servers.cuthol]\ncommand = "a"\nargs = ["b"]\n`, { command: "node", args: ["c", "mcp"] })),
    { command: "node", args: ["c", "mcp"] }
  );
  const merged = buildJsonFileText(JSON.stringify({ mcpServers: { x: { command: "y", args: [] } } }), { command: "node", args: ["c", "mcp"] });
  const parsed = JSON.parse(merged) as { mcpServers: Record<string, unknown> };
  assert.ok("x" in parsed.mcpServers && "cuthol" in parsed.mcpServers);
});

test("setup: real CLI dry run and apply against a temp home", () => {
  const home = makeTempHome("cuthol-setup-cli-");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  const dry = runCli(["setup"], home);
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /codex: not registered/);
  assert.match(dry.stdout, /Start a new agent session to load the MCP server\./);
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
  const applied = runCli(["setup", "--apply", "--agent", "codex,cursor"], home);
  assert.equal(applied.status, 0);
  assert.ok(fs.existsSync(path.join(home, ".codex", "config.toml")));
  assert.ok(fs.existsSync(path.join(home, ".cursor", "mcp.json")));
});
