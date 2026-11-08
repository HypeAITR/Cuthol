/**
 * MCP `guide` tests: skill topics come from scanning `skills/`, legacy topic names keep
 * working as aliases. Runs against temporary fake `skills/` trees (old single-skill and
 * new category layout) via `CUTHOL_SKILLS_DIR`.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildServerInstructions, CutholMcpServer, SERVER_INSTRUCTIONS } from "../mcp/server.js";
import { buildSkillsCatalogSection, resolveGuideTopic, scanSkills } from "../core/skills_install.js";

function writeSkill(root: string, name: string, description: string, body: string, references: Record<string, string> = {}): void {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: >\n  ${description}\n---\n\n${body}\n`,
    "utf8"
  );
  for (const [ref, content] of Object.entries(references)) {
    fs.writeFileSync(path.join(dir, "references", ref), `${content}\n`, "utf8");
  }
}

/** Old layout: only `skills/cuthol` with reference files. */
function buildOldTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-skills-old-"));
  writeSkill(root, "cuthol", "Main Cuthol skill.", "# Cuthol main skill OLD-TREE-MARKER", {
    "editing.md": "# Editing OLD-EDITING-MARKER",
    "speech-and-mix.md": "# Speech and mix OLD-SPEECH-MIX-MARKER",
    "compositions.md": "# Compositions with window.__cuthol OLD-COMPOSITIONS-MARKER",
    "verify-and-monitor.md": "# Verify OLD-VERIFY-MARKER",
    "extensions.md": "# Extensions OLD-EXTENSIONS-MARKER",
    "mcp.md": "# MCP OLD-MCP-MARKER",
  });
  return root;
}

/** New layout: category skills plus the main skill. */
function buildNewTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-skills-new-"));
  writeSkill(root, "cuthol", "Main Cuthol skill.", "# Cuthol main skill NEW-MAIN-MARKER", {
    "mcp.md": "# MCP NEW-MCP-MARKER",
  });
  writeSkill(root, "cuthol-editing", "Spine and lane editing.", "# Editing NEW-EDITING-MARKER");
  writeSkill(
    root,
    "cuthol-speech",
    "Transcribe and clean speech.",
    "# Speech NEW-SPEECH-MARKER",
    { "mix.md": "# Mix reference NEW-SPEECH-MIX-REF-MARKER" }
  );
  writeSkill(root, "cuthol-audio", "Loudness and ducking.", "# Audio NEW-AUDIO-MARKER");
  writeSkill(root, "cuthol-motion", "HyperFrames overlays.", "# Motion NEW-MOTION-MARKER");
  return root;
}

async function withSkillsDir<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.CUTHOL_SKILLS_DIR;
  process.env.CUTHOL_SKILLS_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CUTHOL_SKILLS_DIR;
    else process.env.CUTHOL_SKILLS_DIR = prev;
  }
}

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

test("guide: new skills tree serves skill topics, references, aliases and the catalog", async () => {
  const tree = buildNewTree();
  await withSkillsDir(tree, async () => {
    const mcp = new CutholMcpServer();
    const names = scanSkills().map((s) => s.name);
    assert.ok(names.includes("cuthol-editing") && names.includes("cuthol-audio"));

    const editing = await mcp.callTool("guide", { topic: "cuthol-editing" });
    assert.equal(editing.isError, false, textOf(editing));
    assert.ok(textOf(editing).includes("NEW-EDITING-MARKER"));

    const ref = await mcp.callTool("guide", { topic: "cuthol-speech/mix" });
    assert.equal(ref.isError, false, textOf(ref));
    assert.ok(textOf(ref).includes("NEW-SPEECH-MIX-REF-MARKER"));
    const refExt = await mcp.callTool("guide", { topic: "cuthol-speech/mix.md" });
    assert.equal(refExt.isError, false, textOf(refExt));

    const alias = await mcp.callTool("guide", { topic: "editing" });
    assert.equal(alias.isError, false, textOf(alias));
    assert.ok(textOf(alias).includes("NEW-EDITING-MARKER"), "legacy alias must serve the new skill");

    const speechMix = await mcp.callTool("guide", { topic: "speech_mix" });
    assert.equal(speechMix.isError, false, textOf(speechMix));
    assert.ok(textOf(speechMix).includes("NEW-SPEECH-MARKER"));
    assert.ok(textOf(speechMix).includes("cuthol-audio"), "speech_mix response must point at cuthol-audio");

    const mcpTopic = await mcp.callTool("guide", { topic: "mcp" });
    assert.equal(mcpTopic.isError, false, textOf(mcpTopic));
    assert.ok(textOf(mcpTopic).includes("NEW-MCP-MARKER"));

    const catalog = await mcp.callTool("guide", {});
    assert.equal(catalog.isError, false, textOf(catalog));
    assert.ok(textOf(catalog).includes("NEW-MAIN-MARKER"), "topicless guide starts with the main skill");
    assert.ok(textOf(catalog).includes("cuthol-editing"));
    assert.ok(textOf(catalog).includes("Spine and lane editing."));

    const unknown = await mcp.callTool("guide", { topic: "nope" });
    assert.equal(unknown.isError, true);
    assert.ok(textOf(unknown).includes("cuthol-editing"), "error must list available topics");
  });
});

test("guide: old single-skill tree keeps serving the legacy topics", async () => {
  const tree = buildOldTree();
  await withSkillsDir(tree, async () => {
    const mcp = new CutholMcpServer();

    for (const [topic, marker] of [
      ["overview", "OLD-TREE-MARKER"],
      ["editing", "OLD-EDITING-MARKER"],
      ["speech_mix", "OLD-SPEECH-MIX-MARKER"],
      ["compositions", "OLD-COMPOSITIONS-MARKER"],
      ["verify_monitor", "OLD-VERIFY-MARKER"],
      ["extensions", "OLD-EXTENSIONS-MARKER"],
      ["mcp", "OLD-MCP-MARKER"],
    ] as const) {
      const res = await mcp.callTool("guide", { topic });
      assert.equal(res.isError, false, `topic ${topic}: ${textOf(res)}`);
      assert.ok(textOf(res).includes(marker), `topic ${topic} must serve the legacy file`);
    }

    const catalog = await mcp.callTool("guide", {});
    assert.equal(catalog.isError, false, textOf(catalog));
    assert.ok(textOf(catalog).includes("OLD-TREE-MARKER"));

    const missing = await mcp.callTool("guide", { topic: "cuthol-editing" });
    assert.equal(missing.isError, true, "topics come from the scan, not a fixed list");
  });
});

test("guide: topic resolution and catalog helpers", async () => {
  const tree = buildNewTree();
  await withSkillsDir(tree, () => {
    const skills = scanSkills();
    const section = buildSkillsCatalogSection(skills);
    assert.ok(section.includes("cuthol-editing"));
    assert.ok(section.includes("Spine and lane editing."));

    const direct = resolveGuideTopic("cuthol-motion");
    assert.equal(direct.ok, true);
    assert.equal(direct.ok && direct.kind, "file");

    const legacy = resolveGuideTopic("overview");
    assert.equal(legacy.ok, true);

    const empty = resolveGuideTopic("");
    assert.equal(empty.ok && empty.kind, "catalog");
  });
});

test("guide: server instructions start with the main skill and list scanned topics", async () => {
  const tree = buildNewTree();
  const instructions = await withSkillsDir(tree, () => buildServerInstructions());
  assert.ok(instructions.includes('guide(topic="cuthol")'));
  assert.ok(instructions.includes("cuthol-editing"));
  assert.ok(instructions.length > 500);
  assert.ok(SERVER_INSTRUCTIONS.includes("guide(topic="));
});

test("guide: install note is prepended to the first MCP tool response only", async () => {
  const tree = buildNewTree();
  await withSkillsDir(tree, async () => {
    const note = "Installed Cuthol skills for: codex. Start a new session to load them.";
    const mcp = new CutholMcpServer({ skillsNote: note });
    const first = await mcp.callTool("guide", { topic: "cuthol-editing" });
    assert.equal(first.isError, false, textOf(first));
    assert.ok(textOf(first).startsWith(note));
    const second = await mcp.callTool("guide", { topic: "cuthol-editing" });
    assert.ok(!textOf(second).startsWith(note));
  });
});
