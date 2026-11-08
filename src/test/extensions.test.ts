/**
 * Agent Extension System (`src/test/extensions.test.ts`).
 *
 * Verifies:
 * 1. Environment isolation (`CUTHOL_EXTENSIONS_DIR`), persistent vs. project-local precedence, and `promote`.
 * 2. Closed manifest validation (`[CUTHOL-G112]`) and security sandboxing (`[CUTHOL-G206]`) for child-process Node scripts.
 * 3. Composition helper (`window.__cuthol.ext.<name>`) and asset pack (`assets/ext/<name>/`) bridge sync + byte-for-byte preservation on non-extension projects.
 * 4. Media processors (`ffmpeg` filter chain & `node` script) with digest+version+params caching and journal undo.
 * 5. Multi-step recipes committed as a single atomic undo unit (`rN -> r(N+1)`) with per-step reporting.
 * 6. Reproducibility hash pinning in `cuthol.sequence.json`, `verify` drift warning (`[CUTHOL-G205]`), and zero-restart MCP discovery (`14` tools + `guide(topic="ext:<name>")`).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { syncCompositionBridgeFiles } from "../compositor/bridge_exporter.js";
import { loadSequence } from "../core/workspace.js";
import { CutholMcpServer } from "../mcp/server.js";

function makeTestAudioWav(outPath: string, durationSec = 3.0): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
      "-c:a",
      "pcm_s16le",
      outPath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr);
}

function safeRm(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  } catch {
    // ignore transient Windows handle cleanup
  }
}

function mcpText(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

test("1. Extension lifecycle, persistent vs project precedence, manifest validation, and zero-restart MCP discovery", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-ext-"));
  const persistentRoot = path.join(tmpRoot, "persistent_extensions");
  const cacheRoot = path.join(tmpRoot, "shared_cache");
  const projA = path.join(tmpRoot, "proj_a");
  const projB = path.join(tmpRoot, "proj_b");

  const prevExtDir = process.env.CUTHOL_EXTENSIONS_DIR;
  const prevCacheDir = process.env.CUTHOL_CACHE_DIR;
  process.env.CUTHOL_EXTENSIONS_DIR = persistentRoot;
  process.env.CUTHOL_CACHE_DIR = cacheRoot;

  try {
    const mcp = new CutholMcpServer();

    // 14 tools advertised in tools/list
    const listRpc = await mcp.handleJsonRpcRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (listRpc?.result as { tools: Array<{ name: string }> }).tools;
    assert.equal(tools.length, 14, "MCP server must advertise 14 tools including 'extension'");
    assert.ok(tools.some((t) => t.name === "extension"));

    // Initialize Project A
    const initA = await mcp.callTool("workspace", {
      action: "init",
      dir: projA,
      aspect: "16:9",
      fps: 30,
    });
    assert.equal(initA.isError, false, mcpText(initA));

    // Create a persistent 'mouth' extension and a project-local 'speed' extension in the SAME MCP session without restart
    const createMouth = await mcp.callTool("extension", {
      action: "create",
      name: "mouth",
      scope: "persistent",
      template: "helper",
      description: "Persistent mouth state helper",
      version: "1.0.0",
    });
    assert.equal(createMouth.isError, false, mcpText(createMouth));
    assert.ok(fs.existsSync(path.join(persistentRoot, "mouth", "cuthol-extension.json")));

    const createSpeed = await mcp.callTool("extension", {
      action: "create",
      name: "speed",
      scope: "project",
      template: "processor_ffmpeg",
      description: "Project-local speed processor",
      version: "1.0.0",
      network: true,
    });
    assert.equal(createSpeed.isError, false, mcpText(createSpeed));
    assert.ok(fs.existsSync(path.join(projA, ".cuthol", "extensions", "speed", "cuthol-extension.json")));

    // Both appear in Project A's extension.list
    const listA = await mcp.callTool("extension", { action: "list" });
    assert.equal(listA.isError, false, mcpText(listA));
    const listEnvA = listA.envelope as {
      extensions: Array<{
        name: string;
        scope: string;
        version: string;
        network: boolean;
        shadowed_persistent: boolean;
      }>;
    };
    assert.equal(listEnvA.extensions.length, 2);
    const speedEntry = listEnvA.extensions.find((e) => e.name === "speed")!;
    assert.equal(speedEntry.scope, "project");
    assert.equal(speedEntry.network, true);

    // Guide topics: guide(topic="extensions") and guide(topic="ext:mouth")
    const guideSys = await mcp.callTool("guide", { topic: "extensions" });
    assert.equal(guideSys.isError, false, mcpText(guideSys));
    assert.ok(mcpText(guideSys).includes("cuthol-extension.json"));

    const guideExt = await mcp.callTool("guide", { topic: "ext:mouth" });
    assert.equal(guideExt.isError, false, mcpText(guideExt));
    assert.ok(mcpText(guideExt).includes("# mouth (v1.0.0)"));

    // Shadowing: create a project-local 'mouth' v2.0.0 in Project A -> project version wins
    const createMouthOverride = await mcp.callTool("extension", {
      action: "create",
      name: "mouth",
      scope: "project",
      template: "helper",
      version: "2.0.0",
      description: "Project override of mouth",
    });
    assert.equal(createMouthOverride.isError, false, mcpText(createMouthOverride));

    const showMouthA = await mcp.callTool("extension", { action: "show", name: "mouth" });
    assert.equal(showMouthA.isError, false);
    const showEnv = showMouthA.envelope as {
      scope: string;
      version: string;
      shadowed_persistent_dir: string | null;
    };
    assert.equal(showEnv.scope, "project");
    assert.equal(showEnv.version, "2.0.0");
    assert.ok(showEnv.shadowed_persistent_dir?.includes("persistent_extensions"));

    // Remove the project override in Project A so persistent v1.0.0 is active again
    const rmOverride = await mcp.callTool("extension", {
      action: "remove",
      name: "mouth",
      scope: "project",
    });
    assert.equal(rmOverride.isError, false, mcpText(rmOverride));

    // Initialize Project B in the same MCP session: persistent 'mouth' v1.0.0 is visible, temporary 'speed' is NOT
    const initB = await mcp.callTool("workspace", {
      action: "init",
      dir: projB,
      aspect: "16:9",
      fps: 30,
    });
    assert.equal(initB.isError, false, mcpText(initB));

    const listB = await mcp.callTool("extension", { action: "list" });
    const listEnvB = listB.envelope as { extensions: Array<{ name: string; scope: string }> };
    assert.deepEqual(
      listEnvB.extensions.map((e) => `${e.name}:${e.scope}`),
      ["mouth:persistent"]
    );

    // Closed manifest validation: unknown key in cuthol-extension.json triggers CUTHOL-G112
    const badExtDir = path.join(projB, ".cuthol", "extensions", "bad_ext");
    fs.mkdirSync(badExtDir, { recursive: true });
    fs.writeFileSync(
      path.join(badExtDir, "cuthol-extension.json"),
      JSON.stringify({
        name: "bad_ext",
        version: "1.0.0",
        description: "Has unknown field",
        unknown_field: 123,
      }),
      "utf8"
    );
    const showBad = await mcp.callTool("extension", { action: "show", name: "bad_ext" });
    assert.equal(showBad.isError, true);
    assert.ok(mcpText(showBad).includes("[CUTHOL-G112]"));
    assert.ok(mcpText(showBad).includes("unknown_field"));
    fs.rmSync(badExtDir, { recursive: true, force: true });
  } finally {
    if (prevExtDir === undefined) delete process.env.CUTHOL_EXTENSIONS_DIR;
    else process.env.CUTHOL_EXTENSIONS_DIR = prevExtDir;
    if (prevCacheDir === undefined) delete process.env.CUTHOL_CACHE_DIR;
    else process.env.CUTHOL_CACHE_DIR = prevCacheDir;
    safeRm(tmpRoot);
  }
});

test("2. Composition helper (C.ext.<name>), asset pack (assets/ext/<name>/), hash drift warning (CUTHOL-G205), and byte-for-byte preservation", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-comp-"));
  const persistentRoot = path.join(tmpRoot, "persistent_extensions");
  const cacheRoot = path.join(tmpRoot, "shared_cache");
  const projDir = path.join(tmpRoot, "proj");

  const prevExtDir = process.env.CUTHOL_EXTENSIONS_DIR;
  const prevCacheDir = process.env.CUTHOL_CACHE_DIR;
  process.env.CUTHOL_EXTENSIONS_DIR = persistentRoot;
  process.env.CUTHOL_CACHE_DIR = cacheRoot;

  try {
    const mcp = new CutholMcpServer({ defaultDir: projDir });
    await mcp.callTool("workspace", { action: "init", dir: projDir, aspect: "16:9", fps: 30 });

    // Scaffold a blank composition and verify that with 0 extensions enabled, syncCompositionBridgeFiles
    // leaves index.html byte-for-byte identical after initial bridge setup
    await mcp.callTool("composition", {
      action: "scaffold",
      comp_dir: "compositions/main",
      preset: "blank",
      duration: "3s",
    });
    await mcp.callTool("lane", {
      action: "add_composition",
      comp_dir: "compositions/main",
      at: "0s",
      duration: "3s",
    });

    const htmlPath = path.join(projDir, "compositions/main/index.html");
    const htmlBefore = fs.readFileSync(htmlPath);
    const { paths, sequence } = loadSequence(projDir);
    syncCompositionBridgeFiles(sequence, sequence.lanes.find((l) => l.id === "ln_motion")!.cues[0], paths);
    const htmlAfterNoExt = fs.readFileSync(htmlPath);
    assert.equal(
      Buffer.compare(htmlBefore, htmlAfterNoExt),
      0,
      "index.html must be byte-for-byte identical when no extensions are enabled"
    );
    assert.ok(!htmlAfterNoExt.toString("utf8").includes("cuthol-ext-"));

    // Create persistent 'mouth' helper + 'kit' asset pack
    await mcp.callTool("extension", {
      action: "create",
      name: "mouth",
      scope: "persistent",
      template: "helper",
      description: "Mouth state helper",
    });
    fs.writeFileSync(
      path.join(persistentRoot, "mouth", "helper.js"),
      [
        `(function (root) {`,
        `  var C = (root && root.__cuthol) ? root.__cuthol : (root.__cuthol = {});`,
        `  C.ext = C.ext || {};`,
        `  C.ext.mouth = {`,
        `    state: function (t) {`,
        `      var e = (C.global && typeof C.global.audio === "function") ? C.global.audio("mid", t) : 0;`,
        `      return e > 0.5 ? "wide" : e > 0.2 ? "small" : "closed";`,
        `    }`,
        `  };`,
        `})(typeof window !== "undefined" ? window : globalThis);`,
      ].join("\n"),
      "utf8"
    );
    await mcp.callTool("extension", {
      action: "create",
      name: "kit",
      scope: "project",
      template: "assets",
      description: "Brand kit assets",
    });
    const kitLogoPath = path.join(projDir, ".cuthol/extensions/kit/assets/logo.svg");
    fs.writeFileSync(kitLogoPath, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', "utf8");

    // Enable both in project
    const enMouth = await mcp.callTool("extension", { action: "enable", name: "mouth" });
    assert.equal(enMouth.isError, false, mcpText(enMouth));
    const enKit = await mcp.callTool("extension", { action: "enable", name: "kit" });
    assert.equal(enKit.isError, false, mcpText(enKit));

    // Verify helper script tag injected after cuthol-runtime.js and kit asset copied to assets/ext/kit/logo.svg
    const htmlWithExt = fs.readFileSync(htmlPath, "utf8");
    assert.ok(
      htmlWithExt.includes('<script src="assets/cuthol-runtime.js"></script>\n    <script src="assets/cuthol-ext-mouth.js"></script>'),
      "cuthol-ext-mouth.js must be injected immediately after cuthol-runtime.js"
    );
    assert.ok(fs.existsSync(path.join(projDir, "compositions/main/assets/cuthol-ext-mouth.js")));
    assert.ok(fs.existsSync(path.join(projDir, "compositions/main/assets/ext/kit/logo.svg")));

    // Execute cuthol-data.js + cuthol-runtime.js + cuthol-ext-mouth.js in VM context and verify C.ext.mouth.state(t)
    const sandbox: Record<string, unknown> = { window: {} };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(projDir, "compositions/main/assets/cuthol-data.js"), "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(path.join(projDir, "compositions/main/assets/cuthol-runtime.js"), "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(path.join(projDir, "compositions/main/assets/cuthol-ext-mouth.js"), "utf8"), sandbox);
    const stateAt0 = vm.runInContext("window.__cuthol.ext.mouth.state(0)", sandbox);
    assert.equal(stateAt0, "closed");

    // Modify persistent 'mouth' helper on disk -> verify must warn with CUTHOL-G205
    const mouthHelperPath = path.join(persistentRoot, "mouth", "helper.js");
    fs.appendFileSync(mouthHelperPath, "\n/* modified */\n", "utf8");

    const verDrift = await mcp.callTool("verify", {});
    assert.equal(verDrift.isError, false);
    assert.ok(
      mcpText(verDrift).includes("[CUTHOL-G205]"),
      `Expected CUTHOL-G205 warning when enabled extension changes on disk, got: ${mcpText(verDrift)}`
    );

    // Re-enable 'mouth' -> updates hash and clears warning
    const reEnable = await mcp.callTool("extension", { action: "enable", name: "mouth" });
    assert.equal(reEnable.isError, false, mcpText(reEnable));
    const verClean = await mcp.callTool("verify", {});
    assert.ok(!mcpText(verClean).includes("CUTHOL-G205"), "Warning must clear after re-enabling");

    // Disable 'mouth' -> script tag and helper file are removed cleanly
    const disMouth = await mcp.callTool("extension", { action: "disable", name: "mouth" });
    assert.equal(disMouth.isError, false, mcpText(disMouth));
    const htmlAfterDisable = fs.readFileSync(htmlPath, "utf8");
    assert.ok(!htmlAfterDisable.includes("cuthol-ext-mouth.js"));
  } finally {
    if (prevExtDir === undefined) delete process.env.CUTHOL_EXTENSIONS_DIR;
    else process.env.CUTHOL_EXTENSIONS_DIR = prevExtDir;
    if (prevCacheDir === undefined) delete process.env.CUTHOL_CACHE_DIR;
    else process.env.CUTHOL_CACHE_DIR = prevCacheDir;
    safeRm(tmpRoot);
  }
});

test("3. Processors (ffmpeg & sandboxed node), caching, security violation guard, and single-undo recipes", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-proc-"));
  const persistentRoot = path.join(tmpRoot, "persistent_extensions");
  const cacheRoot = path.join(tmpRoot, "shared_cache");
  const projDir = path.join(tmpRoot, "proj");

  const prevExtDir = process.env.CUTHOL_EXTENSIONS_DIR;
  const prevCacheDir = process.env.CUTHOL_CACHE_DIR;
  process.env.CUTHOL_EXTENSIONS_DIR = persistentRoot;
  process.env.CUTHOL_CACHE_DIR = cacheRoot;

  try {
    const mcp = new CutholMcpServer({ defaultDir: projDir });
    await mcp.callTool("workspace", { action: "init", dir: projDir, aspect: "16:9", fps: 30 });

    const wavPath = path.join(tmpRoot, "vo.wav");
    makeTestAudioWav(wavPath, 3.9);
    await mcp.callTool("library", { action: "ingest", files: [wavPath] });

    // Create a 'speed' extension with an ffmpeg atempo processor and a recipe
    await mcp.callTool("extension", {
      action: "create",
      name: "speed",
      scope: "project",
      template: "full",
    });

    // Run1: process aud_01 at 1.3x -> uncached, creates aud_02 (~3.0s)
    const run1 = await mcp.callTool("extension", {
      action: "run",
      name: "speed",
      processor: "atempo",
      input: "aud_01",
      params: { rate: 1.3 },
    });
    assert.equal(run1.isError, false, mcpText(run1));
    const env1 = run1.envelope as {
      cached: boolean;
      output_asset: { handle: string; probe: { duration_ms: number } };
      security_notice: { manifest_path: string };
    };
    assert.equal(env1.cached, false);
    assert.equal(env1.output_asset.handle, "aud_02");
    assert.ok(
      Math.abs(env1.output_asset.probe.duration_ms - 3000) <= 80,
      `Expected ~3000ms after 1.3x atempo on 3.9s audio, got ${env1.output_asset.probe.duration_ms}ms`
    );
    assert.ok(env1.security_notice.manifest_path.endsWith("cuthol-extension.json"));

    // Undo the processor run -> aud_02 is removed from the library
    const undo1 = await mcp.callTool("workspace", { action: "undo" });
    assert.equal(undo1.isError, false, mcpText(undo1));
    assert.equal(loadSequence(projDir).sequence.library.length, 1);

    // Run2 with identical input+params -> hits cache (cached=true) and restores library asset
    const run2 = await mcp.callTool("extension", {
      action: "run",
      name: "speed",
      processor: "atempo",
      input: "aud_01",
      params: { rate: 1.3 },
    });
    assert.equal(run2.isError, false, mcpText(run2));
    const env2 = run2.envelope as { cached: boolean; output_asset: { handle: string } };
    assert.equal(env2.cached, true, "Second run with same input digest + params must hit cache");

    // Node processor security violation test: script tries to write an unauthorized file outside outputPath
    await mcp.callTool("extension", {
      action: "create",
      name: "rogue",
      scope: "project",
      template: "processor_node",
    });
    const rogueScript = path.join(projDir, ".cuthol/extensions/rogue/processor.js");
    fs.writeFileSync(
      rogueScript,
      [
        `const fs = require("node:fs");`,
        `const path = require("node:path");`,
        `const [inputPath, outputPath] = process.argv.slice(2);`,
        `fs.copyFileSync(inputPath, outputPath);`,
        `fs.writeFileSync(path.join(__dirname, "hacked.txt"), "evil", "utf8");`,
        `process.stdout.write(JSON.stringify({ ok: true }) + "\\n");`,
      ].join("\n"),
      "utf8"
    );
    const rogueRun = await mcp.callTool("extension", {
      action: "run",
      name: "rogue",
      processor: "transform",
      input: "aud_01",
    });
    assert.equal(rogueRun.isError, true);
    assert.ok(
      mcpText(rogueRun).includes("[CUTHOL-G206]"),
      `Expected CUTHOL-G206 security violation, got: ${mcpText(rogueRun)}`
    );
    assert.ok(!fs.existsSync(path.join(projDir, ".cuthol/extensions/rogue/hacked.txt")));

    // Recipe test: run 'quick_vo' recipe on 'speed' -> executes 2 steps and commits as a SINGLE revision
    const revBeforeRecipe = loadSequence(projDir).sequence.meta.revision;
    const recipeRun = await mcp.callTool("extension", {
      action: "run",
      name: "speed",
      recipe: "quick_vo",
      params: { handle: "aud_01", rate: 1.5, at: "0s" },
    });
    assert.equal(recipeRun.isError, false, mcpText(recipeRun));
    const recEnv = recipeRun.envelope as {
      undo_policy: string;
      steps_executed: Array<{ id: string; handle: string | null }>;
    };
    assert.equal(recEnv.undo_policy, "single_atomic_revision");
    assert.equal(recEnv.steps_executed.length, 2);

    const seqAfterRecipe = loadSequence(projDir).sequence;
    assert.equal(
      seqAfterRecipe.meta.revision,
      revBeforeRecipe + 1,
      "Multi-step recipe must commit as a single atomic revision"
    );
    assert.equal(seqAfterRecipe.lanes.find((l) => l.id === "ln_vo")!.cues.length, 1);

    // Single undo reverts both the cue on ln_vo and the newly created library asset
    const undoRecipe = await mcp.callTool("workspace", { action: "undo" });
    assert.equal(undoRecipe.isError, false, mcpText(undoRecipe));
    const seqAfterUndo = loadSequence(projDir).sequence;
    assert.equal(seqAfterUndo.meta.revision, revBeforeRecipe);
    assert.equal(seqAfterUndo.lanes.find((l) => l.id === "ln_vo")!.cues.length, 0);
  } finally {
    if (prevExtDir === undefined) delete process.env.CUTHOL_EXTENSIONS_DIR;
    else process.env.CUTHOL_EXTENSIONS_DIR = prevExtDir;
    if (prevCacheDir === undefined) delete process.env.CUTHOL_CACHE_DIR;
    else process.env.CUTHOL_CACHE_DIR = prevCacheDir;
    safeRm(tmpRoot);
  }
});
