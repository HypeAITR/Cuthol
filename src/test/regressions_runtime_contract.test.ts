/**
 * Composition runtime regression suite (`src/test/regressions_runtime_contract.test.ts`).
 *
 * Verifies key fixes in the composition runtime and contract validator:
 * 1. `C.word()` token-boundary matching ("on" + "ay" !== "onay"),
 *    multi-word ASR token splitting, and `0`-option preservation in both TS and UMD `cuthol-runtime.js`.
 * 2. Open-tag stack parser in `validateHyperFramesCompositionContract` (sibling `<section data-start>`
 *    + `<video data-start>` allowed; nested `<section data-start><video data-start>` rejected).
 * 3. Multi-word `library query --text`, inverted `--range` error,
 *    `repairToolArguments` boolean `"false"` / numeric string coercion, and read-interleaved Loop Guard.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  CUTHOL_BRIDGE_SCHEMA,
  createCutholRuntime,
  CutholBridgeV1,
  getCutholRuntimeJsSource,
} from "../compositor/cuthol_runtime.js";
import { validateHyperFramesCompositionContract } from "../compositor/hyperframes_bridge.js";
import { CutholError } from "../core/diagnostics.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { formatTranscribeDigest, queryLibraryAnalysis } from "../library/query.js";
import { findActionSpec, validateActionArgs } from "../mcp/catalog.js";
import { CutholMcpServer, repairToolArguments } from "../mcp/server.js";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip, setSpineTransition } from "../sequence/spine.js";
import { captureMonitorFrame } from "../monitor/preview.js";
import { measureCuePixelBox } from "../verify/gates.js";
import { buildWorkspaceEnvelopeHeader } from "../core/workspace.js";
import { transcribeLibraryAsset } from "../speech/transcribe.js";
import { spawnSync } from "node:child_process";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/v2_r1_regression_tests");

test("1. C.word() Token Boundary Matching, Multi-Word Token Splitting & UMD 0-Option Parity", () => {
  const bridge: CutholBridgeV1 = {
    schema: CUTHOL_BRIDGE_SCHEMA,
    hash: "sha256:r1test0000000000",
    composition: {
      id: "main",
      cueId: "cue_01",
      duration: 5,
      fps: 30,
      width: 1920,
      height: 1080,
      sequenceStartSec: 0,
    },
    words: [
      { t0: 0.2, t1: 0.5, text: "on" },
      { t0: 0.52, t1: 0.85, text: "ay" },
      { t0: 1.2, t1: 2.0, text: "doksan dokuz" }, // multi-word token from custom ASR
      { t0: 2.5, t1: 3.1, text: "onay" },
    ],
    beats: {
      bpm: 120,
      times: [0.0, 0.5, 1.0, 1.5, 2.0],
      strength: [1.0, 0.4, 0.8, 0.4, 1.0],
      downbeats: [0.0, 2.0],
    },
    cuts: [{ t: 2.0 }, { t: 2.00001 }], // near-duplicate cut
  };

  // Test TypeScript runtime
  const C = createCutholRuntime(bridge);
  // "onay" MUST match the actual word "onay" at 2.5..3.1s, NOT "on" + "ay" at 0.2..0.85s!
  const hitOnay = C.word("onay");
  assert.equal(hitOnay.found, true);
  assert.equal(hitOnay.start, 2.5);
  assert.equal(hitOnay.end, 3.1);

  // "on ay" (two words) MUST match 0.2..0.85s
  const hitOnAy = C.word("on ay");
  assert.equal(hitOnAy.found, true);
  assert.equal(hitOnAy.start, 0.2);
  assert.equal(hitOnAy.end, 0.85);

  // Multi-word ASR token "doksan dokuz" is split so searching "dokuz" alone finds the second half!
  const hitDokuz = C.word("dokuz");
  assert.equal(hitDokuz.found, true);
  assert.ok(hitDokuz.start > 1.2 && hitDokuz.end === 2.0);

  // Near-duplicate cuts are deduplicated
  assert.equal(C.cuts().cuts.length, 1);

  // Test UMD browser script in VM sandbox for 100% parity (including fallback: 0 and to: 0)
  const sandbox: Record<string, unknown> = {
    window: { __CUTHOL_DATA__: bridge },
  };
  vm.createContext(sandbox);
  vm.runInContext(getCutholRuntimeJsSource(), sandbox);
  const umdC = (sandbox.window as { __cuthol: ReturnType<typeof createCutholRuntime> }).__cuthol;
  assert.equal(umdC.word("onay").start, 2.5);
  const missingZeroFb = umdC.word("yok", { fallback: 0 });
  assert.equal(missingZeroFb.found, false);
  assert.equal(missingZeroFb.start, 0);
  assert.deepEqual(umdC.beats({ from: 0, to: 0 }), []);
});

test("2. Open-Tag Stack in validateHyperFramesCompositionContract (Sibling vs Nested Timed <video>)", () => {
  const siblingDir = path.join(TEST_ROOT, "comp_sibling_video");
  const nestedDir = path.join(TEST_ROOT, "comp_nested_video");
  fs.rmSync(siblingDir, { recursive: true, force: true });
  fs.rmSync(nestedDir, { recursive: true, force: true });
  fs.mkdirSync(siblingDir, { recursive: true });
  fs.mkdirSync(nestedDir, { recursive: true });

  // 2a. Sibling `<section data-start>` followed by `<video data-start>` under root (VALID!)
  fs.writeFileSync(
    path.join(siblingDir, "index.html"),
    `<!doctype html><html><head></head><body>
      <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="4">
        <section id="s1" class="clip" data-start="0" data-duration="4"><h1>Title</h1></section>
        <video id="bg-vid" class="clip" src="assets/bg.mp4" data-start="0" data-duration="4" muted playsinline></video>
      </div>
      <script>
        const tl = gsap.timeline({ paused: true });
        tl.to("#s1", { opacity: 1, duration: 0.5 }, 0);
        gsap.set("#other", { autoAlpha: 1 });
        window.__timelines["main"] = tl;
      </script>
    </body></html>`,
    "utf8"
  );
  const resSibling = validateHyperFramesCompositionContract(siblingDir, "index.html", false);
  assert.equal(
    resSibling.ok,
    true,
    `Expected sibling <section data-start> and <video data-start> to pass contract, got: ${resSibling.findings.join("; ")}`
  );

  // 2b. Nested `<video data-start>` inside `<section data-start>` (INVALID!)
  fs.writeFileSync(
    path.join(nestedDir, "index.html"),
    `<!doctype html><html><head></head><body>
      <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="4">
        <section id="s1" class="clip" data-start="0" data-duration="4">
          <video id="bg-vid" class="clip" src="assets/bg.mp4" data-start="0" data-duration="4" muted playsinline></video>
        </section>
      </div>
      <script>
        const tl = gsap.timeline({ paused: true });
        window.__timelines["main"] = tl;
      </script>
    </body></html>`,
    "utf8"
  );
  const resNested = validateHyperFramesCompositionContract(nestedDir, "index.html", false);
  assert.equal(resNested.ok, false);
  assert.ok(resNested.findings.some((f) => f.includes("video_nested_in_timed_element")));
});

test("3. Multi-Word Transcript Query, Invalid Range Error, Boolean Coercion & Interleaved Loop Guard", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_query_and_mcp");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Fixes Test", aspect: "16:9", fps: 30 });

  // Create dummy audio file & ingest
  const dummyWav = path.join(TEST_ROOT, "dummy.wav");
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const wavHeader = Buffer.alloc(44 + 16000 * 2);
  wavHeader.write("RIFF", 0);
  wavHeader.writeUInt32LE(36 + 16000 * 2, 4);
  wavHeader.write("WAVEfmt ", 8);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(1, 22);
  wavHeader.writeUInt32LE(16000, 24);
  wavHeader.writeUInt32LE(32000, 28);
  wavHeader.writeUInt16LE(2, 32);
  wavHeader.writeUInt16LE(16, 34);
  wavHeader.write("data", 36);
  wavHeader.writeUInt32LE(16000 * 2, 40);
  fs.writeFileSync(dummyWav, wavHeader);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [dummyWav] });
  const { paths, sequence } = loadSequence(wsDir);
  const aud01 = sequence.library[0];
  const ledger = new MediaLedger(paths.ledgerFile);
  ledger.setTranscript(aud01.digest_sha256, "local:tr", {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: 3000,
    text: "Merhaba yapay zeka dünyası",
    words: [
      { word: "Merhaba", punctuated_word: "Merhaba", source_start_ms: 100, source_end_ms: 500, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "yapay", punctuated_word: "yapay", source_start_ms: 600, source_end_ms: 1000, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "zeka", punctuated_word: "zeka", source_start_ms: 1050, source_end_ms: 1500, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "dünyası", punctuated_word: "dünyası", source_start_ms: 1600, source_end_ms: 2200, confidence: 0.99, is_filler: false, is_repetition: false },
    ],
    disfluencies: [],
  });
  ledger.close();

  // 3a. Multi-word phrase search (`--text "yapay zeka"`) in transcript query returns the 2 constituent words ("yapay", "zeka") with their original indices [1, 2]
  const multiQ = queryLibraryAnalysis({
    workspaceDir: wsDir,
    handle: aud01.handle,
    kind: "transcript",
    text: "YAPAY ZEKA",
  });
  assert.equal(multiQ.matched, 2, "Expected multi-word transcript query 'YAPAY ZEKA' to return both matched word tokens");
  assert.deepEqual(
    (multiQ.items as Array<{ index: number; word: string }>).map((x) => [x.index, x.word]),
    [
      [1, "yapay"],
      [2, "zeka"],
    ]
  );

  // 3b. Inverted range (`5s..2s`) throws CutholError (CUTHOL-SYS02) instead of silently returning all items
  assert.throws(
    () =>
      queryLibraryAnalysis({
        workspaceDir: wsDir,
        handle: aud01.handle,
        kind: "transcript",
        range: "5s..2s",
      }),
    (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-SYS02"
  );

  // 3c. repairToolArguments maps kebab-case keys; the catalog validator coerces "false" -> false and "5" -> 5
  const rep = repairToolArguments({
    "comp-dir": "compositions/a",
    "dry-run": "false",
    "expect-rev": "5",
  });
  assert.equal(rep.comp_dir, "compositions/a");
  const { comp_dir: _compDir, ...undoArgs } = rep;
  const undoCheck = validateActionArgs(findActionSpec("workspace", "undo")!, undoArgs);
  assert.equal(undoCheck.issues.length, 0);
  // comp_dir is not an undo argument: the validator must say so instead of ignoring it
  const strayArg = validateActionArgs(findActionSpec("workspace", "undo")!, rep);
  assert.ok(strayArg.issues.some((i) => i.kind === "unknown_arg" && i.message.includes("comp_dir")));
  assert.equal(undoCheck.values.dry_run, false);
  assert.equal(undoCheck.values.expect_rev, 5);

  // 3d. Interleaved read-only `brief` call does NOT reset Loop Guard counter for repeated failing mutations
  const mcp = new CutholMcpServer();
  const badMut = { action: "trim", dir: wsDir, clip: "sp_99", out: "1s" };
  await mcp.callTool("spine", badMut); // fail 1
  await mcp.callTool("brief", { dir: wsDir, lens: "overview" }); // read-only call in between!
  await mcp.callTool("spine", badMut); // fail 2
  const fail3 = await mcp.callTool("spine", badMut); // fail 3 -> must trigger CUTHOL-LOOP-GUARD!
  assert.equal(fail3.isError, true);
  assert.ok(String(fail3.content[0].text).includes("CUTHOL-LOOP-GUARD"));
});

test("4. MCP list_changed Notification, Auto Beats/Audio 0..1 Norm, Alpha BBox for Top-Right Custom Card, Clean blank CSS, Transition Delta & VO Digest Preview", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_live_agent_fixes");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Live Agent Fixes", aspect: "16:9", fps: 30 });

  // 4a. MCP `discover_capabilities` emits `notifications/tools/list_changed`
  const mcp = new CutholMcpServer({ progressive: true });
  assert.equal(mcp.sentNotifications.length, 0);
  const discRes = await mcp.callTool("discover_capabilities", { groups: ["render", "composition", "speech", "mix"] });
  assert.ok(String(discRes.content[0].text).includes("tools/list_changed sent"));
  assert.equal(mcp.sentNotifications.length, 1);
  assert.equal(mcp.sentNotifications[0].method, "notifications/tools/list_changed");

  // Synthesize a 4s video and a 4s pulsing music track (WITHOUT calling `library beats` or `library waveform` manually!)
  const mediaDir = path.join(TEST_ROOT, "live_media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const vidPath = path.join(mediaDir, "base.mp4");
  const bgmPath = path.join(mediaDir, "pulsing_bgm.mp3");
  spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x1E293B:s=1280x720:r=30:d=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=16000:duration=4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      vidPath,
    ],
    { encoding: "utf8" }
  );
  spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=90:sample_rate=16000:duration=4",
      "-af",
      "volume='if(lt(mod(t,0.5),0.12),0.95,0.10)':eval=frame",
      "-c:a",
      "libmp3lame",
      bgmPath,
    ],
    { encoding: "utf8" }
  );

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [vidPath, bgmPath] });

  // 4b. Voiceover / audio transcribe digest BEFORE placing on spine/lane must STILL have non-empty `preview.items`!
  const { paths, sequence: seq0 } = loadSequence(wsDir);
  const aud01 = seq0.library.find((x) => x.handle === "aud_01")!;
  const ledger = new MediaLedger(paths.ledgerFile);
  ledger.setTranscript(aud01.digest_sha256, "local:tr", {
    provider: "local",
    model: "fixture",
    language: "tr",
    duration_ms: 4000,
    text: "Moonstar doksan dokuz hızında.",
    words: [
      { word: "Moonstar", punctuated_word: "Moonstar", source_start_ms: 300, source_end_ms: 800, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "doksan", punctuated_word: "doksan", source_start_ms: 900, source_end_ms: 1400, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "dokuz", punctuated_word: "dokuz", source_start_ms: 1450, source_end_ms: 1900, confidence: 0.99, is_filler: false, is_repetition: false },
    ],
    disfluencies: [],
  });
  ledger.close();

  const trRes = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "aud_01",
    language: "tr",
    provider: "local",
  });
  const trDig = formatTranscribeDigest(trRes);
  assert.ok(
    trDig.digest.preview.items.length >= 3,
    "Expected transcribe digest preview.items to be populated even before asset is placed on spine/lane"
  );

  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });

  // 4c. Setting transition on sp_01 produces descriptive delta (`transition:dissolve 300ms`), not just `~sp_01`
  setSpineTransition({
    workspaceDir: wsDir,
    clipId: "sp_01",
    transition: { kind: "dissolve", duration_ms: 300, easing: "ease_in_out" },
  });
  const envAfterTrans = buildWorkspaceEnvelopeHeader(wsDir);
  assert.ok(
    envAfterTrans.delta?.summary.includes("transition:dissolve 300ms"),
    `Expected descriptive transition delta, got: ${envAfterTrans.delta?.summary}`
  );

  // Place `aud_01` on `ln_bgm` WITHOUT having called `library beats` or `library waveform`!
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: 3800,
  });

  // 4d. Scaffold a `blank` composition -> verify its HTML does NOT contain legacy `.title-banner` or `.stat-card` CSS!
  const compDir = path.join(wsDir, "compositions/custom_top_right");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    compositionId: "main",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 3000,
    preset: "blank",
    transparent: true,
  });
  const blankHtml = fs.readFileSync(path.join(compDir, "index.html"), "utf8");
  assert.equal(blankHtml.includes(".title-banner"), false, "Expected blank preset not to include .title-banner CSS");
  assert.equal(blankHtml.includes(".stat-card"), false, "Expected blank preset not to include .stat-card CSS");

  // Write custom HTML placing a card in the TOP-RIGHT corner (`left: 1320px; top: 60px; width: 520px; height: 220px`)
  const customTopRightHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>
      html, body, #root { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
      .custom-tr-card {
        position: absolute;
        left: 1320px;
        top: 60px;
        width: 520px;
        height: 220px;
        background: #0EA5E9;
        border-radius: 24px;
      }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="3">
      <section class="clip" data-start="0" data-duration="3">
        <div id="trcard" class="custom-tr-card"></div>
      </section>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#trcard", { opacity: 0.95 }, { opacity: 1, duration: 0.2 }, 0);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`;
  fs.writeFileSync(path.join(compDir, "index.html"), customTopRightHtml, "utf8");

  const { cue: mountedComp } = addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    explicitId: "cue_tr",
    atMs: 200,
    durationMs: 3000,
    composition: {
      composition_dir: "compositions/custom_top_right",
      entry_html: "index.html",
      props: {},
      transparent: true,
    },
  });

  // 4e. Verify `cuthol-data.json` automatically populated `beats.times` and normalized `audio.low` to peak at 1.0!
  const bridgeData = JSON.parse(
    fs.readFileSync(path.join(compDir, "assets/cuthol-data.json"), "utf8")
  ) as CutholBridgeV1;
  assert.ok(
    (bridgeData.beats?.times.length ?? 0) > 0,
    "Expected music lane beats to be auto-analyzed when mounting composition without prior library beats call"
  );
  const maxLow = Math.max(...(bridgeData.audio?.low ?? [0]));
  assert.equal(maxLow, 1, `Expected audio.low peak to be normalized to 1.0, got ${maxLow}`);

  // 4f. Capture monitor frame at 1000ms -> triggers single-frame RGBA snapshot + alpha bbox measurement (`assets/cuthol-bbox.json`)
  const frameOut = path.join(wsDir, "custom_top_right_frame.png");
  captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 1000,
    showBoxes: true,
    outputPath: frameOut,
  });

  const { sequence: seqAfter } = loadSequence(wsDir);
  const measuredBox = measureCuePixelBox(seqAfter.stage, mountedComp, undefined, wsDir);
  // Card is at left=1320..1840, top=60..280 on 1920x1080!
  assert.ok(
    measuredBox.left > 1250 && measuredBox.top < 120 && measuredBox.bottom < 340,
    `Expected alpha-measured bbox to sit in top-right corner, got: ${JSON.stringify(measuredBox)}`
  );
});
