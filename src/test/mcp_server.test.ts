/**
 * Cuthol MCP adapter tests (`src/mcp/server.ts`, `src/mcp/catalog.ts`).
 *
 * Exercises the server the way a client does: JSON-RPC envelopes, catalog validation,
 * session project selection, image results, dry-run / no-change reporting, the guide tool
 * and the composition file sandbox.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ACTION_SPECS, buildCliArgv, findActionSpec, TOOL_SPECS, validateActionArgs } from "../mcp/catalog.js";
import { CutholMcpServer, GUIDE_TOPICS, SERVER_INSTRUCTIONS } from "../mcp/server.js";
import { resolveGuideTopic } from "../core/skills_install.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace", "mcp_server_tests");

function makeClip(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=3",
      "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr);
}

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

test("1. Catalog: every action maps to a CLI command or an MCP-only handler, schemas are closed", () => {
  for (const spec of ACTION_SPECS) {
    assert.ok(spec.mcpOnly || spec.argv.length > 0, `${spec.tool}.${spec.action} needs argv or mcpOnly`);
    assert.ok(TOOL_SPECS.some((t) => t.name === spec.tool), `unknown tool ${spec.tool}`);
  }
  const server = new CutholMcpServer();
  const tools = server.getToolDefinitions();
  assert.equal(tools.length, TOOL_SPECS.length);
  for (const t of tools) {
    const schema = t.inputSchema as { additionalProperties?: boolean; properties: Record<string, { description?: string }> };
    assert.equal(schema.additionalProperties, false, `${t.name} schema must be closed`);
    for (const [name, prop] of Object.entries(schema.properties)) {
      assert.ok(prop.description && prop.description.length > 8, `${t.name}.${name} needs a description`);
    }
  }
  // argv: values starting with '-' survive because flags are always '--flag=value'
  const argv = buildCliArgv(findActionSpec("lane", "update_cue")!, { cue: "cue_01", y: "-=5", gain_db: -6 }, "/p");
  assert.deepEqual(argv, ["lane", "update-cue", "--cue=cue_01", "--y=-=5", "--gain-db=-6", "--dir=/p"]);
  assert.ok(SERVER_INSTRUCTIONS.includes("guide(topic="));
  // Every legacy guide topic still resolves to an existing skill file (current or legacy layout).
  for (const topic of Object.keys(GUIDE_TOPICS)) {
    const r = resolveGuideTopic(topic, path.resolve(process.cwd(), "skills"));
    assert.ok(r.ok && r.kind === "file" && fs.existsSync(r.file), `guide topic ${topic} does not resolve to a file`);
  }
});

test("2. Session project, image results, dry-run / no-change reporting, guide and composition sandbox", async () => {
  const ws = path.join(TEST_ROOT, "ws");
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  const clip = path.join(TEST_ROOT, "media", "clip.mp4");
  makeClip(clip);

  const mcp = new CutholMcpServer();

  const noProject = await mcp.callTool("brief", {});
  if (!fs.existsSync(path.join(process.cwd(), "cuthol.sequence.json"))) {
    assert.equal(noProject.isError, true);
    assert.ok(text(noProject).includes("workspace.init"));
  }

  const init = await mcp.callTool("workspace", { action: "init", dir: ws, aspect: "16:9", fps: 30 });
  assert.equal(init.isError, false, text(init));
  assert.equal((await mcp.callTool("library", { action: "ingest", files: [clip] })).isError, false);

  const append = await mcp.callTool("spine", { action: "append", asset: "vid_01", in: "0s", out: "2s" });
  assert.equal(append.isError, false, text(append));
  assert.match(text(append), /^OK spine\.append · r3/);
  assert.ok(text(append).includes("Changed: "));
  assert.ok(!text(append).includes('"clip":{'), "edit results must not echo the whole clip object");

  const reingest = await mcp.callTool("library", { action: "ingest", files: [clip] });
  assert.equal(reingest.isError, false);

  const dry = await mcp.callTool("workspace", { action: "undo", dry_run: true });
  assert.equal(dry.isError, false);
  assert.match(text(dry), /^DRY-RUN workspace\.undo · nothing changed/);
  assert.ok(!text(dry).includes("Undo (expect_rev"), "dry run must not advertise an undo");

  const timeline = await mcp.callTool("monitor", { action: "timeline" });
  assert.equal(timeline.isError, false, text(timeline));
  const image = timeline.content.find((c) => c.type === "image");
  assert.ok(image && image.data && image.data.length > 1000, "monitor.timeline must return an image block");

  const guide = await mcp.callTool("guide", { topic: "compositions" });
  assert.equal(guide.isError, false);
  assert.ok(text(guide).includes("window.__cuthol"));
  assert.ok(!text(guide).startsWith("---"), "frontmatter is stripped");

  const escape = await mcp.callTool("composition", { action: "write", comp_dir: "compositions/a", file: "../../evil.html", content: "x" });
  assert.equal(escape.isError, true);
  assert.ok(!fs.existsSync(path.join(ws, "evil.html")));
  const badExt = await mcp.callTool("composition", { action: "write", comp_dir: "compositions/a", file: "run.sh", content: "x" });
  assert.equal(badExt.isError, true);
  const write = await mcp.callTool("composition", { action: "write", comp_dir: "compositions/a", content: "<html></html>" });
  assert.equal(write.isError, false);
  assert.ok(text(write).includes("WARN missing data-composition-id"));
  const read = await mcp.callTool("composition", { action: "read", comp_dir: "compositions/a" });
  assert.equal(text(read), "<html></html>");

  const missingHtml = await mcp.callTool("lane", { action: "add_composition", comp_dir: "compositions/none", duration: "1s" });
  assert.equal(missingHtml.isError, true);
  assert.ok(text(missingHtml).includes("composition(action=scaffold"));

  // JSON-RPC surface
  const initRes = await mcp.handleJsonRpcRequest({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} });
  const result = initRes!.result as { instructions: string; capabilities: { tools: { listChanged: boolean } } };
  assert.ok(result.instructions.length > 500);
  assert.equal(await mcp.handleJsonRpcRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const unknownTool = await mcp.callTool("spien", { action: "trim" });
  assert.ok(text(unknownTool).includes("Did you mean 'spine'"));
});

test("3. Cleanup dry-run candidates table & pagination, accurate dry-run Would change line, library.query page boundary, failed composition.preview image, and mix/beats catalog", async () => {
  // Catalog checks (item 5)
  const beatAlignSpec = findActionSpec("mix", "beat_align")!;
  assert.ok(beatAlignSpec.params.some((p) => p.name === "tolerance"));
  assert.ok(beatAlignSpec.params.some((p) => p.name === "preserve_duration"));
  const beatArgv = buildCliArgv(
    beatAlignSpec,
    { bgm_handle: "aud_01", tolerance: "180ms", preserve_duration: true },
    "/proj"
  );
  assert.deepEqual(beatArgv, [
    "mix",
    "beat-align",
    "--bgm-handle=aud_01",
    "--tolerance=180ms",
    "--preserve-duration=true",
    "--dir=/proj",
  ]);
  const beatsSpec = findActionSpec("library", "beats")!;
  const sensParam = beatsSpec.params.find((p) => p.name === "sensitivity")!;
  assert.match(sensParam.description, /higher\s*=.*more beats/i);

  const ws = path.join(TEST_ROOT, "ws_live_fixes");
  fs.rmSync(ws, { recursive: true, force: true });
  const talkClip = path.join(TEST_ROOT, "media", "talk_long.mp4");
  fs.mkdirSync(path.dirname(talkClip), { recursive: true });
  const ffProc = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=55",
      "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=55",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", talkClip,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ffProc.status, 0, ffProc.stderr);

  // Build a sidecar transcript with 180 words and 55+ pause/filler candidates (mix of >=400ms and 280..350ms pauses)
  const words: Array<{
    word: string;
    punctuated_word: string;
    source_start_ms: number;
    source_end_ms: number;
    confidence: number;
  }> = [];
  let cursorMs = 100;
  for (let i = 0; i < 180; i++) {
    const isFiller = i % 25 === 12;
    const wText = isFiller ? "ıı" : `kelime_${i + 1}_uzun_metin_ornegi`;
    const dur = 120;
    words.push({
      word: wText,
      punctuated_word: wText,
      source_start_ms: cursorMs,
      source_end_ms: cursorMs + dur,
      confidence: 0.98,
    });
    cursorMs += dur;
    if (i < 42) {
      cursorMs += 650; // applied pause (>= 500ms)
    } else if (i < 56) {
      cursorMs += 440; // recorded as pause (>= 400ms) at transcribe time, rejected as TOO_SHORT when min_pause=500ms
    } else {
      cursorMs += 40;
    }
  }
  fs.writeFileSync(`${talkClip}.transcript.json`, JSON.stringify({ language: "tr", words }, null, 2), "utf8");

  const mcp = new CutholMcpServer();
  assert.equal((await mcp.callTool("workspace", { action: "init", dir: ws, aspect: "16:9", fps: 30 })).isError, false);
  assert.equal((await mcp.callTool("library", { action: "ingest", files: [talkClip] })).isError, false);
  assert.equal((await mcp.callTool("spine", { action: "append", asset: "vid_01" })).isError, false);
  assert.equal(
    (await mcp.callTool("speech", { action: "transcribe", handle: "vid_01", provider: "local" })).isError,
    false
  );

  // (1) & (2): speech.cleanup dry-run returns all candidates in a compact table without truncation,
  // and `Would change:` describes the cleanup (not the previous `spine.append` journal entry).
  const dryCleanup = await mcp.callTool("speech", {
    action: "cleanup",
    clip: "sp_01",
    min_pause: "500ms",
    dry_run: true,
  });
  assert.equal(dryCleanup.isError, false, text(dryCleanup));
  const dryText = text(dryCleanup);
  assert.ok(!dryText.includes("[truncated"), "cleanup dry-run must not be truncated");
  assert.match(dryText, /^DRY-RUN speech\.cleanup · nothing changed \(still r\d+\) · current:/m);
  assert.match(dryText, /^Would change: excise \d+ span\(s\) on sp_01/m);
  assert.ok(!dryText.includes("spine.append"), "dry-run Would change line must not echo previous journal entry");
  assert.match(dryText, /^Candidates \(1\.\.\d+ of \d+/m);
  assert.ok(dryText.includes("[APPLIED]"), "table must list applied candidates");
  assert.ok(dryText.includes("[REJECTED:TOO_SHORT]"), "table must list rejected candidates");

  // Pagination of cleanup candidate table
  const page1 = await mcp.callTool("speech", {
    action: "cleanup",
    clip: "sp_01",
    dry_run: true,
    limit: 10,
    cursor: "0",
  });
  assert.equal(page1.isError, false);
  assert.match(text(page1), /Candidates \(1\.\.10 of \d+/);
  assert.match(text(page1), /next page: speech\(action=cleanup, clip=sp_01, dry_run=true, cursor="10", limit=10\)/);

  const page2 = await mcp.callTool("speech", {
    action: "cleanup",
    clip: "sp_01",
    dry_run: true,
    limit: 10,
    cursor: "10",
  });
  assert.equal(page2.isError, false);
  assert.match(text(page2), /Candidates \(11\.\.20 of \d+/);

  // (3) library.query page is never cut mid-JSON even with a large max_tokens / limit
  const qRes = await mcp.callTool("library", {
    action: "query",
    handle: "vid_01",
    kind: "transcript",
    limit: 200,
    max_tokens: 8000,
  });
  assert.equal(qRes.isError, false, text(qRes));
  const qText = text(qRes);
  assert.ok(!qText.includes("[truncated"), "library.query output must never be sliced mid-JSON");
  const resultLine = qText.split("\n").find((l) => l.startsWith("Result: "));
  assert.ok(resultLine, "library.query must have a Result: JSON line");
  const parsedQuery = JSON.parse(resultLine!.slice("Result: ".length)) as {
    returned: number;
    items: Array<{ index: number }>;
    next_cursor: string | null;
  };
  assert.equal(parsedQuery.returned, parsedQuery.items.length);
  if (parsedQuery.next_cursor !== null) {
    assert.equal(parsedQuery.next_cursor, String(parsedQuery.items.length));
  }

  // (5) mix.normalize reports achieved_lufs and target_reached on the Loudness: line
  const normRes = await mcp.callTool("mix", { action: "normalize", target_lufs: -14 });
  assert.equal(normRes.isError, false, text(normRes));
  assert.match(text(normRes), /^Loudness: .* LUFS .* target_reached=(true|false)/m);

  // (4) composition.preview / check returns the contact sheet image even when it reports FAILED (e.g. G505 / lint)
  assert.equal(
    (await mcp.callTool("composition", {
      action: "scaffold",
      comp_dir: "compositions/bad_opaque",
      preset: "blank",
      duration: "2s",
    })).isError,
    false
  );
  // Make the overlay 100% opaque AND introduce a contract violation so preview reports FAILED
  const opaqueHtml = `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <script src="assets/gsap.min.js"></script>
  <script src="assets/cuthol-data.js"></script>
  <script src="assets/cuthol-runtime.js"></script>
  <style>
    html, body { margin: 0; background: #112233; }
    #root { position: relative; width: 1920px; height: 1080px; background: #112233; }
    .clip { position: absolute; inset: 0; background: #112233; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="2">
    <div id="c1" class="clip" data-start="0" data-duration="2"><h1 style="color:#fff">OPAQUE</h1></div>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.set({}, {}, 2);
    window.__timelines["main"] = tl;
  </script>
</body>
</html>`;
  assert.equal(
    (await mcp.callTool("composition", {
      action: "write",
      comp_dir: "compositions/bad_opaque",
      content: opaqueHtml,
    })).isError,
    false
  );
  assert.equal(
    (await mcp.callTool("lane", {
      action: "add_composition",
      comp_dir: "compositions/bad_opaque",
      at: "0s",
      duration: "2s",
    })).isError,
    false
  );

  const prevRes = await mcp.callTool("composition", { action: "preview", cue: "cue_01" });
  assert.equal(prevRes.isError, true, "opaque overlay must fail alpha_gate (G505)");
  assert.match(text(prevRes), /^FAILED composition\.preview/);
  assert.ok(text(prevRes).includes("CUTHOL-G505"));
  const prevImg = prevRes.content.find((c) => c.type === "image");
  assert.ok(prevImg && prevImg.data && prevImg.data.length > 1000, "failed composition.preview must still return the contact sheet image");
});

test("4. MCP catalog & docs: spine.reframe, mix.beat_align mode/grid, library.beats grid/onsets, library.subject, and guide topics", async () => {
  // 4a. spine.reframe catalog & CLI argv
  const reframeSpec = findActionSpec("spine", "reframe");
  assert.ok(reframeSpec, "spine.reframe must exist in ACTION_SPECS");
  const reframeValidated = validateActionArgs(reframeSpec, {
    clip: "sp_01",
    mode: "subject_track",
    points: ["0ms:50", "40s:64", "78.6s:55"],
    replace: true,
    deadband: 3.2,
    x: "55",
    fps: 4,
    dry_run: true,
  });
  assert.equal(reframeValidated.issues.length, 0);
  const reframeArgv = buildCliArgv(reframeSpec, reframeValidated.values, "/proj");
  assert.deepEqual(reframeArgv, [
    "spine",
    "reframe",
    "--clip=sp_01",
    "--mode=subject_track",
    "--points=0ms:50,40s:64,78.6s:55",
    "--replace=true",
    "--deadband=3.2",
    "--x=55",
    "--fps=4",
    "--dry-run=true",
    "--dir=/proj",
  ]);

  const reframeMultiValidated = validateActionArgs(reframeSpec, {
    clips: ["sp_01", "sp_02"],
    all_spine: true,
    mode: "center_lock",
    x: "60",
  });
  assert.equal(reframeMultiValidated.issues.length, 0);
  assert.deepEqual(buildCliArgv(reframeSpec, reframeMultiValidated.values, "/proj"), [
    "spine",
    "reframe",
    "--clips=sp_01,sp_02",
    "--all-spine=true",
    "--mode=center_lock",
    "--x=60",
    "--dir=/proj",
  ]);

  // 4b. mix.beat_align alignment mode / grid flags
  const beatAlignSpec = findActionSpec("mix", "beat_align")!;
  const beatModeValidated = validateActionArgs(beatAlignSpec, {
    bgm_handle: "aud_01",
    mode: "onsets",
    grid: false,
    sensitivity: 1.5,
    tolerance: "200ms",
    preserve_duration: true,
  });
  assert.equal(beatModeValidated.issues.length, 0);
  assert.deepEqual(buildCliArgv(beatAlignSpec, beatModeValidated.values, "/proj"), [
    "mix",
    "beat-align",
    "--bgm-handle=aud_01",
    "--mode=onsets",
    "--grid=false",
    "--sensitivity=1.5",
    "--tolerance=200ms",
    "--preserve-duration=true",
    "--dir=/proj",
  ]);

  // 4c. library.beats summary & library.subject catalog
  const beatsSpec = findActionSpec("library", "beats")!;
  assert.match(beatsSpec.summary, /grid/i);
  assert.match(beatsSpec.summary, /onset/i);

  const subjectSpec = findActionSpec("library", "subject");
  assert.ok(subjectSpec, "library.subject must exist in ACTION_SPECS");
  const subjectValidated = validateActionArgs(subjectSpec, { handle: "vid_01", fps: 4, verbose: true });
  assert.equal(subjectValidated.issues.length, 0);
  assert.deepEqual(buildCliArgv(subjectSpec, subjectValidated.values, "/proj"), [
    "library",
    "subject",
    "--handle=vid_01",
    "--fps=4",
    "--verbose=true",
    "--dir=/proj",
  ]);

  // 4d. Guide topics reflect the documentation
  const mcp = new CutholMcpServer();
  // Content moved into category skills; the legacy topic still serves the editing skill.
  const guideEditing = text(await mcp.callTool("guide", { topic: "editing" }));
  assert.ok(guideEditing.includes("reframe"));
  assert.ok(text(await mcp.callTool("guide", { topic: "cuthol-review" })).includes("monitor.frame"));
  assert.ok(text(await mcp.callTool("guide", { topic: "cuthol-editing/effects" })).includes("replace"));

  // The legacy speech_mix topic serves speech and points to the audio skill, where beats live.
  assert.ok(text(await mcp.callTool("guide", { topic: "speech_mix" })).includes("cuthol-audio"));
  const guideSpeechMix = text(await mcp.callTool("guide", { topic: "cuthol-audio" }));
  assert.ok(guideSpeechMix.includes("grid_ms"));
  assert.ok(guideSpeechMix.includes("onsets"));
  assert.ok(guideSpeechMix.includes('mode="onsets"'));

  const guideCompositions = text(await mcp.callTool("guide", { topic: "compositions" }));
  assert.ok(guideCompositions.includes("C.beatGrid"));
  assert.ok(guideCompositions.includes("grid"));

  const guideMcp = text(await mcp.callTool("guide", { topic: "mcp" }));
  assert.ok(guideMcp.includes("CUTHOL_CACHE_DIR"));
  assert.ok(guideMcp.includes("76 px"));
  assert.ok(guideMcp.includes("64 px"));
});
