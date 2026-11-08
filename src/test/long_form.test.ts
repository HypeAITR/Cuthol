/**
 * long-form & layered workflows:
 * 1. Lane audio playback speed (`rate`, `preserve_pitch`) in `lane.add_cue` / `lane.update_cue`,
 *    shared audio graph (`atempo`), projected word timings (`C.word`, `C.global.words`, `speech.captions`), and undo.
 * 2. Simultaneous layered compositions (`ln_motion` stacking & `z_index` ordering) verified on rendered pixels.
 * 3. Compact transcript query (`library.query(kind="transcript", format="compact")`) returning 300 words in one MCP call
 *    while preserving the default object format.
 * 4. Cached HyperFrames lint in `verify` (`CUTHOL-G407` for real issues like `left`/`width` tweens, ignoring size/split hints).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { syncAllCompositionBridges } from "../compositor/bridge_exporter.js";
import { compileSequenceAudioPlan } from "../compositor/compiler.js";
import { lintHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import { loadSequence } from "../core/workspace.js";
import { CutholMcpServer } from "../mcp/server.js";
import { runWorkspaceVerification } from "../verify/gates.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace", "long_form");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

function cli(args: string[]): { ok: boolean; result: any; raw: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = `${proc.stdout ?? ""}`;
  let env: any = null;
  try {
    env = JSON.parse(raw);
  } catch {
    // keep raw for assertion messages
  }
  return {
    ok: Boolean(env?.ok),
    result: env?.result ?? env,
    raw: raw.slice(0, 3000) + (proc.stderr ?? "").slice(0, 1000),
  };
}

function sampleRegionRgb(mp4: string, atSec: number, cropExpr: string): [number, number, number] {
  const buf = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      String(atSec),
      "-i",
      mp4,
      "-frames:v",
      "1",
      "-vf",
      `${cropExpr},scale=1:1`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: 1024 }
  ).stdout as Buffer;
  return [buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0];
}

test("1. Lane voiceover speed (1.3x): duration, atempo audio graph, projected C.global.words & captions, and undo", () => {
  const wsDir = path.join(TEST_ROOT, "ws_lane_speed");
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "1:1", "--fps", "30"]).ok);

  const wavPath = path.join(wsDir, "vo.wav");
  assert.equal(
    spawnSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=260:sample_rate=48000:duration=3.9",
      "-ac",
      "1",
      wavPath,
    ]).status,
    0
  );

  // Write a local transcript sidecar with 3 words at 0.65s, 1.95s, and 3.25s
  const sidecarWords = [
    { word: "birinci", punctuated_word: "Birinci", source_start_ms: 650, source_end_ms: 1040, confidence: 0.99 },
    { word: "ikinci", punctuated_word: "ikinci", source_start_ms: 1950, source_end_ms: 2340, confidence: 0.99 },
    { word: "ucuncu", punctuated_word: "üçüncü.", source_start_ms: 3250, source_end_ms: 3640, confidence: 0.99 },
  ];
  fs.writeFileSync(
    `${wavPath}.transcript.json`,
    JSON.stringify({ language: "tr", words: sidecarWords }, null, 2),
    "utf8"
  );

  assert.ok(cli(["library", "ingest", wavPath, "--dir", wsDir]).ok);
  assert.ok(
    cli(["speech", "transcribe", "--handle", "aud_01", "--provider", "local", "--dir", wsDir]).ok
  );

  const addVo = cli([
    "lane",
    "add-cue",
    "--lane",
    "ln_vo",
    "--kind",
    "voiceover",
    "--asset",
    "aud_01",
    "--at",
    "0ms",
    "--duration",
    "3900ms",
    "--dir",
    wsDir,
  ]);
  assert.ok(addVo.ok, addVo.raw);
  assert.equal(addVo.result.cue.duration_ms, 3900);

  const compDir = path.join(wsDir, "compositions", "main");
  assert.ok(
    cli([
      "lane",
      "add-composition",
      "--lane",
      "ln_motion",
      "--comp-dir",
      "compositions/main",
      "--at",
      "0ms",
      "--duration",
      "3900ms",
      "--scaffold",
      "blank",
      "--dir",
      wsDir,
    ]).ok
  );

  const readBridgeWords = () => {
    const { sequence, paths } = loadSequence(wsDir);
    syncAllCompositionBridges(sequence, paths);
    const dataJs = fs.readFileSync(path.join(compDir, "assets/cuthol-data.js"), "utf8");
    const runtimeJs = fs.readFileSync(path.join(compDir, "assets/cuthol-runtime.js"), "utf8");
    const sandbox: any = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(`${dataJs}\n${runtimeJs}`, sandbox);
    const C = sandbox.window.__cuthol;
    return {
      w1: C.global.word("birinci"),
      w2: C.global.word("ikinci"),
      w3: C.global.word("ucuncu"),
      localW2: C.word("ikinci"),
    };
  };

  const before = readBridgeWords();
  assert.ok(Math.abs(before.w1.start - 0.65) < 0.005);
  assert.ok(Math.abs(before.w2.start - 1.95) < 0.005);
  assert.ok(Math.abs(before.w3.start - 3.25) < 0.005);

  // Speed up cue_01 by 1.3x with pitch preservation
  const speedUp = cli([
    "lane",
    "update-cue",
    "--cue",
    "cue_01",
    "--rate",
    "1.3",
    "--preserve-pitch",
    "--dir",
    wsDir,
  ]);
  assert.ok(speedUp.ok, speedUp.raw);
  assert.equal(speedUp.result.cue.duration_ms, 3000);
  assert.equal(speedUp.result.cue.playback.rate, 1.3);
  assert.equal(speedUp.result.cue.playback.preserve_pitch, true);

  // Audio plan uses atempo=1.3000
  const { sequence: seqAfter, paths: pathsAfter } = loadSequence(wsDir);
  const audioPlan = compileSequenceAudioPlan(seqAfter, pathsAfter);
  assert.match(audioPlan.filterComplex, /atrim=start=0\.000:end=3\.900,asetpts=PTS-STARTPTS,atempo=1\.3000/);

  // Words in C.global.word and C.word are scaled by 1 / 1.3 (0.65 -> 0.50, 1.95 -> 1.50, 3.25 -> 2.50)
  const after = readBridgeWords();
  assert.ok(Math.abs(after.w1.start - 0.5) < 0.005, `w1 after=${after.w1.start}`);
  assert.ok(Math.abs(after.w2.start - 1.5) < 0.005, `w2 after=${after.w2.start}`);
  assert.ok(Math.abs(after.w3.start - 2.5) < 0.005, `w3 after=${after.w3.start}`);
  assert.ok(Math.abs(after.localW2.start - 1.5) < 0.005);

  // Captions also use the sped-up word times
  const caps = cli(["speech", "captions", "--verbose", "--dir", wsDir]);
  assert.ok(caps.ok, caps.raw);
  const capWords = caps.result.cues.flatMap((c: any) => c.typography?.words ?? []);
  assert.equal(capWords.length, 3);
  assert.ok(Math.abs(capWords[0].sequence_start_ms - 500) <= 2);
  assert.ok(Math.abs(capWords[1].sequence_start_ms - 1500) <= 2);
  assert.ok(Math.abs(capWords[2].sequence_start_ms - 2500) <= 2);

  // Brief flow lens reflects the sped-up cue duration and caption times
  const briefFlow = spawnSync(
    process.execPath,
    [CLI, "brief", "--lens", "flow", "--dir", wsDir],
    { encoding: "utf8" }
  ).stdout;
  assert.match(briefFlow, /`cue_01` \(`ln_vo`, z=0\): `0\.\.3000ms` \| aud_01/);

  // Undo captions + speed change restores original 3900ms duration and original word times
  assert.ok(cli(["workspace", "journal", "undo", "--steps", "2", "--dir", wsDir]).ok);
  const restored = readBridgeWords();
  assert.ok(Math.abs(restored.w2.start - 1.95) < 0.005);
  const { sequence: seqRestored } = loadSequence(wsDir);
  const voCueRestored = seqRestored.lanes.find((l) => l.id === "ln_vo")!.cues[0];
  assert.equal(voCueRestored.duration_ms, 3900);
});

test("2. Simultaneous layered compositions render in deterministic stacking order", () => {
  const wsDir = path.join(TEST_ROOT, "ws_layered_comps");
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "1:1", "--fps", "30"]).ok);
  assert.ok(cli(["workspace", "backdrop", "--color", "#FFD23F", "--dir", wsDir]).ok);

  const writeLayerComp = (relDir: string, boxStyle: string) => {
    const absDir = path.join(wsDir, relDir);
    assert.ok(
      cli(["composition", "scaffold", "--comp-dir", relDir, "--duration", "1s", "--preset", "blank", "--dir", wsDir]).ok
    );
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>
      html, body { margin: 0; width: 480px; height: 480px; overflow: hidden; background: transparent; }
      #root { position: relative; width: 480px; height: 480px; overflow: hidden; background: transparent; }
      .clip { position: absolute; inset: 0; }
      #box { position: absolute; ${boxStyle} }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="480" data-height="480" data-fps="30" data-duration="1">
      <section id="slot" class="clip" data-start="0" data-duration="1">
        <div id="box"></div>
      </section>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      tl.set("#box", { opacity: 1 }, 0);
      tl.set({}, {}, 1);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`;
    fs.writeFileSync(path.join(absDir, "index.html"), html, "utf8");
    fs.writeFileSync(
      path.join(absDir, "hyperframes.json"),
      JSON.stringify({ name: "main", entry: "index.html", width: 480, height: 480, fps: 30 }, null, 2),
      "utf8"
    );
  };

  // Bottom scene layer covers the left 70% in cobalt blue (#2346D8)
  writeLayerComp("compositions/scene_base", "left: 0; top: 0; width: 340px; height: 480px; background: #2346D8;");
  // Top badge layer covers the center-right in red (#E5383B), overlapping the right half of scene_base
  writeLayerComp("compositions/badge_top", "left: 200px; top: 80px; width: 240px; height: 320px; background: #E5383B;");

  assert.ok(
    cli([
      "lane",
      "add-composition",
      "--lane",
      "ln_motion",
      "--comp-dir",
      "compositions/scene_base",
      "--at",
      "0ms",
      "--duration",
      "1000ms",
      "--dir",
      wsDir,
    ]).ok
  );
  assert.ok(
    cli([
      "lane",
      "add-composition",
      "--lane",
      "ln_motion",
      "--comp-dir",
      "compositions/badge_top",
      "--at",
      "0ms",
      "--duration",
      "1000ms",
      "--dir",
      wsDir,
    ]).ok
  );

  const outMp4 = path.join(wsDir, "output", "layered.mp4");
  const render = cli(["render", "--preset", "draft_480p", "--out", "output/layered.mp4", "--dir", wsDir]);
  assert.ok(render.ok, render.raw);

  // Left region (x=60, y=240): only scene_base -> blue (#2346D8)
  const [rLeft, gLeft, bLeft] = sampleRegionRgb(outMp4, 0.5, "crop=20:20:50:230");
  assert.ok(bLeft > 170 && rLeft < 80, `expected blue scene_base on left, got rgb(${rLeft},${gLeft},${bLeft})`);

  // Overlap region (x=260, y=240): badge_top over scene_base -> red (#E5383B)
  const [rMid, gMid, bMid] = sampleRegionRgb(outMp4, 0.5, "crop=20:20:250:230");
  assert.ok(rMid > 180 && gMid < 90 && bMid < 90, `expected red badge_top in overlap, got rgb(${rMid},${gMid},${bMid})`);
});

test("3. Compact transcript query returns 285+ words in one MCP call while default format stays unchanged", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_compact_transcript");
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "16:9", "--fps", "30"]).ok);

  const wavPath = path.join(wsDir, "long_vo.wav");
  assert.equal(
    spawnSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=16000:duration=90",
      "-ac",
      "1",
      wavPath,
    ]).status,
    0
  );

  const words = Array.from({ length: 285 }, (_, i) => ({
    word: `kelime_${i}`,
    punctuated_word: `kelime_${i}`,
    source_start_ms: i * 300 + 80,
    source_end_ms: i * 300 + 260,
    confidence: 0.96,
  }));
  fs.writeFileSync(`${wavPath}.transcript.json`, JSON.stringify({ language: "tr", words }, null, 2), "utf8");

  const mcp = new CutholMcpServer({ defaultDir: wsDir });
  assert.equal((await mcp.callTool("library", { action: "ingest", files: [wavPath] })).isError, false);
  assert.equal(
    (await mcp.callTool("speech", { action: "transcribe", handle: "aud_01", provider: "local" })).isError,
    false
  );

  const compactRes = await mcp.callTool("library", {
    action: "query",
    handle: "aud_01",
    kind: "transcript",
    format: "compact",
  });
  assert.equal(compactRes.isError, false);
  const compactText = compactRes.content[0].text!;
  const compactPayload = JSON.parse(compactText.split("Result: ")[1]);
  assert.equal(compactPayload.matched, 285);
  assert.equal(compactPayload.returned, 285);
  assert.equal(compactPayload.truncated, false);
  assert.equal(compactPayload.items[0], "0:kelime_0@0.08");
  assert.equal(compactPayload.items[284], "284:kelime_284@85.28");

  // Counter-metric: default query format is unchanged (40 object items, paginated)
  const defaultRes = await mcp.callTool("library", {
    action: "query",
    handle: "aud_01",
    kind: "transcript",
  });
  assert.equal(defaultRes.isError, false);
  const defaultPayload = JSON.parse(defaultRes.content[0].text!.split("Result: ")[1]);
  assert.equal(defaultPayload.matched, 285);
  assert.equal(defaultPayload.returned, 40);
  assert.equal(defaultPayload.truncated, true);
  assert.deepEqual(defaultPayload.items[0], {
    index: 0,
    word: "kelime_0",
    source_start_ms: 80,
    source_end_ms: 260,
    confidence: 0.96,
  });
});

test("4. Verify runs cached HyperFrames lint (G407 for left/width tweens, ignores file-size/subcomp split warnings)", () => {
  const wsDir = path.join(TEST_ROOT, "ws_verify_lint");
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "1:1", "--fps", "30"]).ok);

  assert.ok(
    cli([
      "lane",
      "add-composition",
      "--lane",
      "ln_motion",
      "--comp-dir",
      "compositions/main",
      "--at",
      "0ms",
      "--duration",
      "3000ms",
      "--scaffold",
      "blank",
      "--dir",
      wsDir,
    ]).ok
  );

  const compDir = path.join(wsDir, "compositions/main");
  const paddingLines = Array.from({ length: 420 }, (_, i) => `      <div class="row" id="r_${i}"></div>`).join("\n");
  const htmlWithLayoutTweens = `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>
      html, body { margin: 0; width: 1080px; height: 1080px; overflow: hidden; background: transparent; }
      #root { position: relative; width: 1080px; height: 1080px; overflow: hidden; background: transparent; }
      .clip { position: absolute; inset: 0; }
      .cutb { position: absolute; left: 100px; top: 100px; width: 80px; height: 80px; background: #e5383b; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1080" data-height="1080" data-fps="30" data-duration="3">
      <section id="main-slot" class="clip" data-start="0" data-duration="3">
        <div id="scene0">
          <div class="cutb" id="c2"></div>
          <div class="cutb" id="c4"></div>
          <div class="cutb" id="c5"></div>
${paddingLines}
        </div>
      </section>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      tl.to("#c2", { left: 330, width: 50, duration: 0.45 }, 0.2);
      tl.to("#c4", { left: 640, width: 40, duration: 0.45 }, 0.3);
      tl.to("#c5", { left: 770, width: 50, duration: 0.45 }, 0.4);
      tl.set({}, {}, 3);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`;
  fs.writeFileSync(path.join(compDir, "index.html"), htmlWithLayoutTweens, "utf8");

  const t0 = performance.now();
  const rep1 = runWorkspaceVerification(wsDir);
  const coldMs = performance.now() - t0;

  const t1 = performance.now();
  const rep2 = runWorkspaceVerification(wsDir);
  const cachedMs = performance.now() - t1;

  const lintCheck = lintHyperFramesComposition(compDir, "index.html", path.join(wsDir, ".cuthol/blobs"));
  assert.equal(lintCheck.cached, true);
  assert.ok(cachedMs < coldMs, `expected cached verify (${cachedMs.toFixed(1)}ms) < cold verify (${coldMs.toFixed(1)}ms)`);

  const g407 = rep1.diagnostics.filter((d) => d.code === "CUTHOL-G407");
  assert.equal(g407.length, 3, JSON.stringify(rep1.diagnostics));
  for (const d of g407) {
    assert.match(d.what, /gsap_non_transform_motion/);
    assert.match(d.what, /left/);
  }
  assert.ok(
    !rep1.diagnostics.some(
      (d) =>
        d.what.includes("composition_file_too_large") ||
        d.what.includes("nested_structure_needs_subcomposition")
    ),
    "size/splitting advisories must not be emitted as warnings"
  );
  assert.equal(rep2.diagnostics.length, rep1.diagnostics.length);
});
