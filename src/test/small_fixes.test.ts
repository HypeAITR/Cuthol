/**
 * Small fixes: MCP render `workers` flag, G309 wording.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { initWorkspace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { ACTION_SPECS, buildCliArgv, catalogFlagIssues, findActionSpec, type ActionSpec } from "../mcp/catalog.js";
import { CutholMcpServer } from "../mcp/server.js";
import { appendSpineClip } from "../sequence/spine.js";

function dashedFlagSpec(): ActionSpec {
  return {
    tool: "render",
    action: null,
    argv: ["render"],
    summary: "probe",
    mutates: false,
    params: [
      {
        name: "workers",
        type: "number",
        description: "Parallel workers.",
        flag: "--workers",
      },
    ],
  };
}

test("catalog rejects a flag that starts with a dash", () => {
  const planted = catalogFlagIssues([dashedFlagSpec()]);
  assert.equal(planted.length, 1);
  assert.equal(planted[0].tool, "render");
  assert.equal(planted[0].param, "workers");
  assert.equal(planted[0].flag, "--workers");

  const shipped = catalogFlagIssues(ACTION_SPECS);
  assert.deepEqual(
    shipped,
    [],
    `catalog flags must not start with '-': ${JSON.stringify(shipped)}`
  );

  const renderSpec = findActionSpec("render", null);
  assert.ok(renderSpec);
  const argv = buildCliArgv(renderSpec, { workers: 1 }, "/p");
  assert.ok(argv.includes("--workers=1"), argv.join(" "));
  assert.equal(argv.some((arg) => arg.includes("----")), false, argv.join(" "));
});

test("MCP render workers:1 succeeds on a small synthetic project", { timeout: 180_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-workers-"));
  const previousEncoder = process.env.CUTHOL_ENCODER;
  process.env.CUTHOL_ENCODER = "x264";
  try {
    const wsDir = path.join(dir, "ws");
    initWorkspace({ dir: wsDir, title: "workers-flag", aspect: "16:9", fps: 30 });
    const clipPath = path.join(dir, "clip.mp4");
    const proc = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x2244aa:s=640x360:r=30:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=1",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        clipPath,
      ],
      { encoding: "utf8", timeout: 30_000 }
    );
    assert.equal(proc.status, 0, proc.stderr);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [clipPath] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 1000 });

    const mcp = new CutholMcpServer();
    const rendered = await mcp.callTool("render", {
      dir: wsDir,
      preset: "draft_480p",
      workers: 1,
      out: "output/workers.mp4",
    });
    const text = rendered.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    assert.equal(rendered.isError, false, text);
    assert.equal(rendered.envelope?.ok, true, text);
    assert.equal(rendered.envelope?.workers, 1, text);
    assert.equal(text.includes("CUTHOL-G110"), false, text);
    assert.ok(fs.existsSync(path.join(wsDir, "output", "workers.mp4")));
  } finally {
    if (previousEncoder === undefined) delete process.env.CUTHOL_ENCODER;
    else process.env.CUTHOL_ENCODER = previousEncoder;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("G309 message says the clip is at most 150 ms", () => {
  const diag = DIAGNOSTICS.SHORT_SPINE_CLIP("sp_01", 150, 150);
  assert.equal(diag.code, "CUTHOL-G309");
  assert.equal(diag.severity, "WARN");
  assert.match(diag.what, /at most\s+150ms/);
  assert.match(diag.formatted, /at most\s+150ms/);
  assert.doesNotMatch(diag.what, /below/);
});
