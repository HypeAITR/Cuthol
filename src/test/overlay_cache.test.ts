import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./test_setup.js";

import {
  analyzeCompositionDataUsage,
  syncAllCompositionBridges,
} from "../compositor/bridge_exporter.js";
import {
  isDuplicateImgMediaDiscoveryFinding,
  lintHyperFramesComposition,
  validateHyperFramesCompositionContract,
} from "../compositor/hyperframes_bridge.js";
import { CutholError } from "../core/diagnostics.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import {
  createExtension,
  enableExtensionInWorkspace,
} from "../extensions/manager.js";
import { analyzeAssetWaveform } from "../library/waveform.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { CutholMcpServer } from "../mcp/server.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip, splitSpineClip } from "../sequence/spine.js";
import { TranscriptDocument } from "../speech/providers.js";
import { runWorkspaceVerification } from "../verify/gates.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function safeRm(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup error
  }
}

function createSyntheticToneVideo(outPath: string, freqHz: number, color: string, durationSec = 1): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=320x180:r=30:d=${durationSec}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${freqHz}:sample_rate=48000:duration=${durationSec}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      outPath,
    ],
    { encoding: "utf8", timeout: 30_000 }
  );
  assert.equal(proc.status, 0, `ffmpeg tone video failed: ${proc.stderr}`);
}

function createSyntheticToneWav(outPath: string, freqHz: number, durationSec = 0.6): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${freqHz}:sample_rate=48000:duration=${durationSec}`,
      "-af",
      "volume=6dB",
      "-c:a",
      "pcm_s16le",
      outPath,
    ],
    { encoding: "utf8", timeout: 30_000 }
  );
  assert.equal(proc.status, 0, `ffmpeg tone wav failed: ${proc.stderr}`);
}

function createSyntheticPng(outPath: string, color = "orange"): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=64x64:d=0.1`,
      "-frames:v",
      "1",
      outPath,
    ],
    { encoding: "utf8", timeout: 15_000 }
  );
  assert.equal(proc.status, 0, `ffmpeg png failed: ${proc.stderr}`);
}

function extractRgb24AtSec(mp4Path: string, atSec: number, w = 320, h = 180): Buffer {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      atSec.toFixed(3),
      "-i",
      mp4Path,
      "-frames:v",
      "1",
      "-vf",
      `scale=${w}:${h}:flags=neighbor`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: w * h * 4 + 65536, timeout: 15_000 }
  );
  assert.equal(proc.status, 0, `extractRgb24AtSec failed: ${proc.stderr}`);
  return proc.stdout as Buffer;
}

function computeBufferMae(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length, "Buffer lengths must match for MAE");
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / a.length;
}

test("1. Selective overlay cache key (used local/global data only), render overlay summary, and zero stale cache hits", () => {
  const tmpDir = makeTempDir("cuthol-cache-");
  try {
    const wsDir = path.join(tmpDir, "ws");
    initWorkspace({ dir: wsDir, title: "cache", aspect: "16:9", fps: 30 });

    // Reduce stage to 320x180 so live HyperFrames renders finish in ~1-2s each
    const seqPath = path.join(wsDir, "cuthol.sequence.json");
    const seqInit = JSON.parse(fs.readFileSync(seqPath, "utf8"));
    seqInit.stage.width = 320;
    seqInit.stage.height = 180;
    fs.writeFileSync(seqPath, JSON.stringify(seqInit, null, 2), "utf8");

    const clip1Path = path.join(tmpDir, "clip1.mp4");
    const clip2Path = path.join(tmpDir, "clip2.mp4");
    const sfxPath = path.join(tmpDir, "sfx.wav");
    createSyntheticToneVideo(clip1Path, 220, "black", 1);
    createSyntheticToneVideo(clip2Path, 440, "black", 1);
    createSyntheticToneWav(sfxPath, 880, 0.5);

    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [clip1Path, clip2Path, sfxPath] });
    analyzeAssetWaveform({ workspaceDir: wsDir, handle: "vid_01", bins: 40 });
    analyzeAssetWaveform({ workspaceDir: wsDir, handle: "vid_02", bins: 40 });
    analyzeAssetWaveform({ workspaceDir: wsDir, handle: "aud_01", bins: 40 });

    const { paths, sequence: seqAfterIngest } = loadSequence(wsDir);
    const vid01 = seqAfterIngest.library.find((x) => x.handle === "vid_01")!;
    const ledger = new MediaLedger(paths.ledgerFile);
    const setVid01Transcript = (alfaStartMs: number, alfaEndMs: number): void => {
      const doc: TranscriptDocument = {
        provider: "local",
        model: "fixture",
        language: "tr",
        duration_ms: 1000,
        text: "alfa beta",
        words: [
          {
            word: "alfa",
            punctuated_word: "alfa",
            source_start_ms: alfaStartMs,
            source_end_ms: alfaEndMs,
            confidence: 0.99,
            is_filler: false,
            is_repetition: false,
          },
          {
            word: "beta",
            punctuated_word: "beta",
            source_start_ms: 820,
            source_end_ms: 950,
            confidence: 0.99,
            is_filler: false,
            is_repetition: false,
          },
        ],
        disfluencies: [],
      };
      ledger.setTranscript(vid01.digest_sha256, "local:tr", doc);
    };
    // Initially "alfa" is at 700..800ms (so at t=0.2s it is NOT active yet)
    setVid01Transcript(700, 800);
    ledger.close();

    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01" }); // sp_01: 0..1000ms
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_02" }); // sp_02: 1000..2000ms

    const writeComp = (name: string, htmlBody: string, scriptBody: string): string => {
      const cDir = path.join(wsDir, "compositions", name);
      fs.mkdirSync(path.join(cDir, "assets"), { recursive: true });
      const html = `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>html, body, #root { margin:0; width:320px; height:180px; background:transparent !important; overflow:hidden; }</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="320" data-height="180" data-fps="30" data-duration="0.6">
      ${htmlBody}
    </div>
    <script>
      const C = window.__cuthol;
      const tl = gsap.timeline({ paused: true });
      ${scriptBody}
      tl.set({}, {}, C.duration);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`;
      fs.writeFileSync(path.join(cDir, "index.html"), html, "utf8");
      return cDir;
    };

    // 1. comp_static: uses only C.duration (no word, no audio, no cuts, no global)
    const dirStatic = writeComp(
      "comp_static",
      `<div id="box" style="position:absolute;left:10px;top:10px;width:60px;height:40px;background:#38BDF8">STATIC</div>`,
      `tl.to("#box", { x: 10, duration: 0.2 }, 0);`
    );

    // 2. comp_word: uses C.word("alfa") and C.audio("low", 0.4) to switch colors on word timing & audio energy
    const dirWord = writeComp(
      "comp_word",
      `<div id="wbox" style="position:absolute;left:0;top:0;width:160px;height:180px;background:#0022AA"></div>
       <div id="abox" style="position:absolute;left:160px;top:0;width:160px;height:180px;background:#111111"></div>`,
      `const w = C.word("alfa", { fallback: 0.55 });
       const a = C.audio("low", 0.4);
       gsap.set("#wbox", { backgroundColor: "#0022AA" });
       gsap.set("#abox", { backgroundColor: a > 0.1 ? "#FFAA00" : "#111111" });
       tl.set("#wbox", { backgroundColor: "#FF1100" }, w.start);`
    );

    // 3. comp_global_cuts: uses C.global.cuts() to color top bar green when global cuts > 1
    const dirGlobal = writeComp(
      "comp_global",
      `<div id="gbar" style="position:absolute;left:0;top:0;width:320px;height:50px;background:#222222"></div>`,
      `const gc = C.global.cuts().cuts.length;
       gsap.set("#gbar", { backgroundColor: gc > 1 ? "#00FF44" : "#222222" });
       tl.to("#gbar", { opacity: 1, duration: 0.1 }, 0);`
    );

    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_motion",
      kind: "composition",
      atMs: 0,
      durationMs: 600,
      composition: {
        composition_dir: "compositions/comp_static",
        entry_html: "index.html",
        props: {},
        transparent: true,
      },
    });
    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_motion",
      kind: "composition",
      atMs: 0,
      durationMs: 600,
      composition: {
        composition_dir: "compositions/comp_word",
        entry_html: "index.html",
        props: {},
        transparent: true,
      },
    });
    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_motion",
      kind: "composition",
      atMs: 1000,
      durationMs: 600,
      composition: {
        composition_dir: "compositions/comp_global",
        entry_html: "index.html",
        props: {},
        transparent: true,
      },
    });

    // Verify usage analyzer accuracy
    const uStatic = analyzeCompositionDataUsage(dirStatic, "index.html");
    assert.equal(uStatic.usesLocalWords, false);
    assert.equal(uStatic.usesLocalAudio, false);
    assert.equal(uStatic.usesLocalCuts, false);
    assert.equal(uStatic.usesAnyGlobal, false);

    const uWord = analyzeCompositionDataUsage(dirWord, "index.html");
    assert.equal(uWord.usesLocalWords, true);
    assert.equal(uWord.usesLocalAudio, true);
    assert.equal(uWord.usesAnyGlobal, false);

    const uGlobal = analyzeCompositionDataUsage(dirGlobal, "index.html");
    assert.equal(uGlobal.usesGlobalCuts, true);
    assert.equal(uGlobal.usesGlobalWords, false);
    assert.equal(uGlobal.usesAnyGlobal, true);

    // (a) Initial cold render -> 3 rendered (reason: new)
    const r1 = renderSequenceToMp4({
      workspaceDir: wsDir,
      outputPath: "output/r1.mp4",
      preset: "master_1080p",
    });
    assert.ok(r1.overlays);
    assert.equal(r1.overlays.total, 3);
    assert.equal(r1.overlays.cached, 0);
    assert.equal(r1.overlays.rendered, 3);
    assert.equal(r1.overlays.reasons.new, 3);
    const frameAt02Before = extractRgb24AtSec(r1.output_path, 0.2);

    // (b) Second render with no changes -> 3 cached, 0 rendered
    const r2 = renderSequenceToMp4({
      workspaceDir: wsDir,
      outputPath: "output/r2.mp4",
      preset: "master_1080p",
    });
    assert.ok(r2.overlays);
    assert.equal(r2.overlays.total, 3);
    assert.equal(r2.overlays.cached, 3);
    assert.equal(r2.overlays.rendered, 0);

    // (c) Add an SFX cue at 1100ms -> none of the 3 compositions use local or global audio!
    // Expect 0 overlays re-rendered (3/3 cached)
    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_sfx",
      kind: "sfx",
      assetHandle: "aud_01",
      atMs: 1100,
      durationMs: 400,
    });
    const r3 = renderSequenceToMp4({
      workspaceDir: wsDir,
      outputPath: "output/r3_sfx.mp4",
      preset: "master_1080p",
    });
    assert.ok(r3.overlays);
    assert.equal(r3.overlays.cached, 3);
    assert.equal(r3.overlays.rendered, 0, `Expected 0 re-renders on unused SFX addition, got: ${JSON.stringify(r3.overlays)}`);

    // (d) Counter-metric (no false cache hit): move "alfa" word from 700..800ms to 50..350ms
    // and sync bridges -> ONLY `comp_word` must re-render (`slice_changed`), and frame at 0.2s must change!
    const ledger2 = new MediaLedger(paths.ledgerFile);
    const docUpdated: TranscriptDocument = {
      provider: "local",
      model: "fixture",
      language: "tr",
      duration_ms: 1000,
      text: "alfa beta",
      words: [
        {
          word: "alfa",
          punctuated_word: "alfa",
          source_start_ms: 50,
          source_end_ms: 350,
          confidence: 0.99,
          is_filler: false,
          is_repetition: false,
        },
        {
          word: "beta",
          punctuated_word: "beta",
          source_start_ms: 820,
          source_end_ms: 950,
          confidence: 0.99,
          is_filler: false,
          is_repetition: false,
        },
      ],
      disfluencies: [],
    };
    ledger2.setTranscript(vid01.digest_sha256, "local:tr", docUpdated);
    ledger2.close();
    syncAllCompositionBridges(loadSequence(wsDir).sequence, paths);

    const r4 = renderSequenceToMp4({
      workspaceDir: wsDir,
      outputPath: "output/r4_word.mp4",
      preset: "master_1080p",
    });
    assert.ok(r4.overlays);
    assert.equal(r4.overlays.cached, 2);
    assert.equal(r4.overlays.rendered, 1);
    assert.equal(r4.overlays.reasons.slice_changed, 1);
    assert.equal(r4.overlays.rerendered[0].composition, "comp_word");

    const frameAt02After = extractRgb24AtSec(r4.output_path, 0.2);
    const maeWordDiff = computeBufferMae(frameAt02Before, frameAt02After);
    assert.ok(
      maeWordDiff > 15,
      `Expected rendered frame at 0.2s to change when C.word timing moved (MAE=${maeWordDiff.toFixed(2)})`
    );

    // (e) Split sp_02 at 1700ms (outside comp_global's [1000..1600ms] window, so only global.cuts changes!)
    // ONLY `comp_global` must re-render (`global_used_changed`), while `comp_static` and `comp_word` hit cache!
    splitSpineClip({
      workspaceDir: wsDir,
      clipId: "sp_02",
      splitPointsMs: [1700],
      isSequenceTime: true,
    });
    const r5 = renderSequenceToMp4({
      workspaceDir: wsDir,
      outputPath: "output/r5_global_cut.mp4",
      preset: "master_1080p",
    });
    assert.ok(r5.overlays);
    assert.equal(r5.overlays.cached, 2);
    assert.equal(r5.overlays.rendered, 1);
    assert.equal(r5.overlays.reasons.global_used_changed, 1);
    assert.equal(r5.overlays.rerendered[0].composition, "comp_global");

    // (f) Modify HTML of `comp_static` -> ONLY `comp_static` re-renders (`html_changed`)
    const staticHtmlPath = path.join(dirStatic, "index.html");
    fs.writeFileSync(
      staticHtmlPath,
      fs.readFileSync(staticHtmlPath, "utf8").replace(">STATIC<", ">UPDATED<"),
      "utf8"
    );
    const r6 = renderSequenceToMp4({
      workspaceDir: wsDir,
      outputPath: "output/r6_html.mp4",
      preset: "master_1080p",
    });
    assert.ok(r6.overlays);
    assert.equal(r6.overlays.cached, 2);
    assert.equal(r6.overlays.rendered, 1);
    assert.equal(r6.overlays.reasons.html_changed, 1);
    assert.equal(r6.overlays.rerendered[0].composition, "comp_static");
  } finally {
    safeRm(tmpDir);
  }
});

test("2. G205 stops render with ERROR when project-scoped extension or composition copy drifts, and clears after extension enable", async () => {
  const tmpDir = makeTempDir("cuthol-g205-");
  try {
    const wsDir = path.join(tmpDir, "ws");
    initWorkspace({ dir: wsDir, title: "g205", aspect: "16:9", fps: 30 });
    const seqPath = path.join(wsDir, "cuthol.sequence.json");
    const seqInit = JSON.parse(fs.readFileSync(seqPath, "utf8"));
    seqInit.stage.width = 320;
    seqInit.stage.height = 180;
    fs.writeFileSync(seqPath, JSON.stringify(seqInit, null, 2), "utf8");

    const clipPath = path.join(tmpDir, "clip.mp4");
    createSyntheticToneVideo(clipPath, 300, "black", 1);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [clipPath] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01" });

    // Create and enable a project-scoped extension
    createExtension({
      workspaceDir: wsDir,
      name: "test_kit",
      scope: "project",
      description: "Project-scoped test extension for G205 render guard",
    });
    enableExtensionInWorkspace({
      workspaceDir: wsDir,
      name: "test_kit",
      scope: "project",
    });

    const compDir = path.join(wsDir, "compositions/ext_scene");
    fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(compDir, "index.html"),
      `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>html, body, #root { margin:0; width:320px; height:180px; background:transparent !important; }</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="320" data-height="180" data-fps="30" data-duration="0.5">
      <div id="t" style="color:#fff">EXT</div>
    </div>
    <script>
      const C = window.__cuthol;
      const tl = gsap.timeline({ paused: true });
      tl.to("#t", { x: 20, duration: 0.2 }, 0);
      tl.set({}, {}, C.duration);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`,
      "utf8"
    );

    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_motion",
      kind: "composition",
      atMs: 0,
      durationMs: 500,
      composition: {
        composition_dir: "compositions/ext_scene",
        entry_html: "index.html",
        props: {},
        transparent: true,
      },
    });

    // Modify extension helper source on disk -> must trigger G205 and stop render with ERROR
    const extHelperSrc = path.join(wsDir, ".cuthol/extensions/test_kit/helper.js");
    fs.appendFileSync(extHelperSrc, "\n/* drifted */\n", "utf8");

    const verDrift = runWorkspaceVerification(wsDir);
    const g205 = verDrift.diagnostics.find((d) => d.code === "CUTHOL-G205");
    assert.ok(g205, "Expected CUTHOL-G205 diagnostic when extension source drifts");
    assert.match(g205.suggestion, /extension enable --name test_kit/);

    assert.throws(
      () =>
        renderSequenceToMp4({
          workspaceDir: wsDir,
          outputPath: "output/should_fail.mp4",
          preset: "draft_480p",
        }),
      (err: unknown) => {
        assert.ok(err instanceof CutholError);
        assert.equal(err.diagnostic.code, "CUTHOL-G205");
        assert.equal(err.diagnostic.severity, "ERROR");
        assert.match(err.diagnostic.suggestion, /extension enable --name test_kit/);
        return true;
      }
    );

    // Also verify MCP render call returns isError: true with CUTHOL-G205
    const mcp = new CutholMcpServer({ defaultDir: wsDir });
    const mcpRenderFail = await mcp.callTool("render", { preset: "draft_480p" });
    assert.equal(mcpRenderFail.isError, true);
    const mcpFailText = (mcpRenderFail.content[0] as { type: "text"; text: string }).text;
    assert.match(mcpFailText, /CUTHOL-G205/);
    assert.match(mcpFailText, /extension\(action=enable,\s*name=test_kit\)|extension enable --name test_kit/);

    // Re-enable extension -> updates hash and syncs composition copy -> render succeeds
    enableExtensionInWorkspace({
      workspaceDir: wsDir,
      name: "test_kit",
      scope: "project",
    });

    const verClean = runWorkspaceVerification(wsDir);
    assert.equal(
      verClean.diagnostics.some((d) => d.code === "CUTHOL-G205"),
      false,
      "Expected CUTHOL-G205 to clear after extension enable"
    );

    const renderedOk = renderSequenceToMp4({
      workspaceDir: wsDir,
      outputPath: "output/after_enable.mp4",
      preset: "draft_480p",
    });
    assert.equal(renderedOk.ok, true);
    assert.ok(renderedOk.overlays);
    assert.equal(renderedOk.overlays.total, 1);
  } finally {
    safeRm(tmpDir);
  }
});

test("3. Duplicate media lint (G407): duplicate <img> is downgraded to INFO while duplicate <video> stays WARN", () => {
  const tmpDir = makeTempDir("cuthol-lint-");
  try {
    const wsDir = path.join(tmpDir, "ws");
    initWorkspace({ dir: wsDir, title: "lint", aspect: "16:9", fps: 30 });

    const clipPath = path.join(tmpDir, "clip.mp4");
    createSyntheticToneVideo(clipPath, 300, "black", 2);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [clipPath] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01" });

    // Composition 1: duplicate <img> with same src -> must be INFO (G407)
    const compImgDir = path.join(wsDir, "compositions/dup_img");
    fs.mkdirSync(path.join(compImgDir, "assets"), { recursive: true });
    createSyntheticPng(path.join(compImgDir, "assets/logo.png"), "cyan");
    fs.writeFileSync(
      path.join(compImgDir, "index.html"),
      `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>html, body, #root { margin:0; width:1920px; height:1080px; background:transparent !important; }</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="2">
      <img id="logo1" src="assets/logo.png" style="position:absolute;left:100px;top:100px;width:120px" />
      <img id="logo2" src="assets/logo.png" style="position:absolute;left:400px;top:100px;width:120px" />
    </div>
    <script>
      const C = window.__cuthol;
      const tl = gsap.timeline({ paused: true });
      tl.to("#logo1", { x: 20, duration: 0.5 }, 0);
      tl.to("#logo2", { x: 20, duration: 0.5 }, 0.2);
      tl.set({}, {}, C.duration);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`,
      "utf8"
    );

    // Composition 2: duplicate <video> with same src/start/duration -> must stay WARN (G407)
    const compVidDir = path.join(wsDir, "compositions/dup_vid");
    fs.mkdirSync(path.join(compVidDir, "assets"), { recursive: true });
    fs.copyFileSync(clipPath, path.join(compVidDir, "assets/loop.mp4"));
    fs.writeFileSync(
      path.join(compVidDir, "index.html"),
      `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>html, body, #root { margin:0; width:1920px; height:1080px; background:transparent !important; }</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="2">
      <video id="v1" class="clip" data-start="0" data-duration="2" src="assets/loop.mp4" muted playsinline style="position:absolute;left:50px;top:50px;width:320px"></video>
      <video id="v2" class="clip" data-start="0" data-duration="2" src="assets/loop.mp4" muted playsinline style="position:absolute;left:500px;top:50px;width:320px"></video>
    </div>
    <script>
      const C = window.__cuthol;
      const tl = gsap.timeline({ paused: true });
      tl.to("#v1", { x: 10, duration: 0.5 }, 0);
      tl.set({}, {}, C.duration);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`,
      "utf8"
    );

    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_motion",
      kind: "composition",
      atMs: 0,
      durationMs: 1000,
      composition: {
        composition_dir: "compositions/dup_img",
        entry_html: "index.html",
        props: {},
        transparent: true,
      },
    });
    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_motion",
      kind: "composition",
      atMs: 1000,
      durationMs: 1000,
      composition: {
        composition_dir: "compositions/dup_vid",
        entry_html: "index.html",
        props: {},
        transparent: true,
      },
    });

    // Check contract path for both compositions
    const contractImg = validateHyperFramesCompositionContract(compImgDir, "index.html", true);
    assert.equal(contractImg.ok, true);
    assert.equal(
      (contractImg.lint_findings ?? []).some((f) => f.code === "duplicate_media_discovery_risk"),
      false,
      "Duplicate <img> must not remain in warning lint_findings"
    );
    assert.equal(
      (contractImg.lint_info_findings ?? []).some(
        (f) => f.code === "duplicate_media_discovery_risk" && f.severity === "info"
      ),
      true,
      "Duplicate <img> must be placed in lint_info_findings with severity=info"
    );

    const contractVid = validateHyperFramesCompositionContract(compVidDir, "index.html", true);
    assert.equal(
      (contractVid.lint_findings ?? []).some(
        (f) => f.code === "duplicate_media_discovery_risk" && f.severity === "warning"
      ),
      true,
      "Duplicate <video> must remain in lint_findings with severity=warning"
    );

    // Check verifySequence G407 gate mapping
    const ver = runWorkspaceVerification(wsDir);
    const g407Img = ver.diagnostics.find(
      (d) => d.code === "CUTHOL-G407" && d.subject_id === "cue_01"
    );
    const g407Vid = ver.diagnostics.find(
      (d) => d.code === "CUTHOL-G407" && d.subject_id === "cue_02"
    );
    assert.ok(g407Img, "Expected G407 diagnostic for duplicate <img> on cue_01");
    assert.equal(g407Img.severity, "INFO", "Expected duplicate <img> G407 to have INFO severity");

    assert.ok(g407Vid, "Expected G407 diagnostic for duplicate <video> on cue_02");
    assert.equal(g407Vid.severity, "WARN", "Expected duplicate <video> G407 to keep WARN severity");

    assert.equal(
      isDuplicateImgMediaDiscoveryFinding({
        code: "duplicate_media_discovery_risk",
        message: "Detected 2 matching img entries with the same source/start/duration.",
      }),
      true
    );
    assert.equal(
      isDuplicateImgMediaDiscoveryFinding({
        code: "duplicate_media_discovery_risk",
        message: "Detected 2 matching video entries with the same source/start/duration.",
      }),
      false
    );
  } finally {
    safeRm(tmpDir);
  }
});
