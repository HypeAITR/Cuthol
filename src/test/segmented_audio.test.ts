import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { captureMonitorFrame } from "../monitor/preview.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip, setItemEnvelope } from "../sequence/spine.js";

const TEST_ROOT = path.resolve("test-workspace/segmented_audio");

test("1. Segmented audio render: in-segment delayed cue crossing segment boundaries has < 1 ms offset and CUTHOL-G508 catches legacy post-adelay trim bug", () => {
  const wsDir = path.join(TEST_ROOT, "seg_audio_health");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Segmented Audio Alignment", aspect: "16:9", fps: 30 });

  // Create a 3s silent video clip for the spine (we will append 6 clips of 1s each = 6s total, 3 segments of 2s when maxClips=2)
  const silentVid = path.join(wsDir, "silent_vid.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1E293B:s=640x360:r=30:d=2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    silentVid,
  ]);

  // Create a deterministic frequency-modulated / chirp-like multi-tone voiceover wav (6s, 48kHz)
  // so cross-correlation has a unique, sharp peak at every millisecond.
  const voWav = path.join(wsDir, "vo_patterned.wav");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.35*sin(2*PI*(220+180*sin(2*PI*3.7*t))*t)+0.25*sin(2*PI*(510+290*cos(2*PI*7.3*t))*t)+0.15*sin(2*PI*113*t*t)':s=48000:d=6",
    "-c:a",
    "pcm_s16le",
    voWav,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [silentVid, voWav] });

  for (let i = 0; i < 6; i++) {
    appendSpineClip({
      workspaceDir: wsDir,
      assetHandle: "vid_01",
      sourceInMs: 0,
      sourceOutMs: 1000,
    });
  }

  // Cue 1: starts at 600ms (inside Clip 1: 0..1000ms, so inside Segment 0: 0..2000ms with adelay=600ms)
  // and runs for 3800ms (until 4400ms, crossing Segment 0->1 and Segment 1->2 boundaries, ending inside Segment 2)
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_vo",
    kind: "voiceover",
    assetHandle: "aud_01",
    atMs: 600,
    sourceInMs: 500,
    sourceOutMs: 4300,
    durationMs: 3800,
  });
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "cue_01",
    parameter: "audio_chain.gain_db",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 1900, value: -1.5, easing: "linear" },
      { offset_ms: 3800, value: 0, easing: "linear" },
    ],
  });

  const prevMaxClips = process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS;
  process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS = "2";

  try {
    // A. Render with the fixed audio pipeline
    delete process.env.CUTHOL_TEST_LEGACY_POST_ADELAY_TRIM;
    const fixedMp4 = path.join(wsDir, "output", "fixed.mp4");
    const fixedSummary = renderSequenceToMp4({
      workspaceDir: wsDir,
      outputPath: fixedMp4,
      preset: "draft_480p",
    });

    assert.equal(fixedSummary.ok, true);
    assert.ok(fixedSummary.audio_health, "Expected audio_health in render summary");
    assert.equal(
      fixedSummary.audio_health.issues.length,
      0,
      `Expected 0 audio health issues in fixed render, got: ${JSON.stringify(fixedSummary.audio_health.issues)}`
    );
    assert.ok(
      !fixedSummary.verification.diagnostics.some((d) => d.code === "CUTHOL-G508"),
      "Fixed render must not emit CUTHOL-G508"
    );
    assert.ok(
      fixedSummary.audio_health.points.length >= 2,
      "Expected multiple audio health check points across segments"
    );
    for (const pt of fixedSummary.audio_health.points) {
      assert.equal(pt.ok, true);
      assert.ok(
        Math.abs(pt.measured_offset_ms) < 1.0,
        `Expected audio offset < 1 ms at ${pt.check_at_ms}ms, got ${pt.measured_offset_ms}ms`
      );
      assert.ok(
        pt.similarity > 0.9,
        `Expected correlation similarity > 0.9 at ${pt.check_at_ms}ms, got ${pt.similarity}`
      );
    }

    // B. Force legacy post-adelay atrim bug via test hook and verify health check catches it with CUTHOL-G508
    const { paths } = loadSequence(wsDir);
    for (const f of fs.readdirSync(paths.blobsDir)) {
      if (f.startsWith("aseg_") || f.startsWith("aconcat_")) {
        fs.unlinkSync(path.join(paths.blobsDir, f));
      }
    }
    process.env.CUTHOL_TEST_LEGACY_POST_ADELAY_TRIM = "1";
    const buggyMp4 = path.join(wsDir, "output", "buggy.mp4");
    const buggySummary = renderSequenceToMp4({
      workspaceDir: wsDir,
      outputPath: buggyMp4,
      preset: "draft_480p",
    });

    assert.ok(buggySummary.audio_health, "Expected audio_health in buggy render summary");
    assert.ok(
      buggySummary.audio_health.issues.length > 0,
      "Expected audio_health to detect shifted audio in legacy post-adelay trim mode"
    );
    assert.ok(
      buggySummary.verification.diagnostics.some((d) => d.code === "CUTHOL-G508"),
      "Expected CUTHOL-G508 diagnostic when audio is shifted across segment boundary"
    );
    const seg0Issue = buggySummary.audio_health.issues.find(
      (iss) => Math.abs(iss.measured_offset_ms + 600) < 50
    );
    assert.ok(
      seg0Issue,
      `Expected detected offset near -600ms in Segment 0, got issues: ${JSON.stringify(buggySummary.audio_health.issues)}`
    );
  } finally {
    delete process.env.CUTHOL_TEST_LEGACY_POST_ADELAY_TRIM;
    if (prevMaxClips === undefined) {
      delete process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS;
    } else {
      process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS = prevMaxClips;
    }
  }
});

test("2. Sub-pixel scale envelope monotonicity (< 1 px steps, zero backward jumps) and static scale identity", () => {
  const wsDir = path.join(TEST_ROOT, "subpixel_scale");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Subpixel Scale Test", aspect: "16:9", fps: 30 });

  const clipPath = path.join(wsDir, "static_ui.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#111827:s=1920x1080:r=30:d=33.5,drawbox=x=400:y=200:w=1120:h=680:color=#F9FAFB:t=fill",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "10",
    "-pix_fmt",
    "yuv444p",
    clipPath,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [clipPath] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01" });

  // Verify static scale plan does not inject dynamic perspective filter
  const { paths, sequence: staticSeq } = loadSequence(wsDir);
  const staticPlan = compileSequenceRenderPlan(staticSeq, paths, "master_1080p", {
    includeAudio: false,
  });
  assert.ok(
    !staticPlan.filterComplex.includes("perspective="),
    "Static scale clip must not use per-frame perspective filter"
  );

  // Add slow linear scale envelope 1.0 -> 1.12 over 33500ms
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_01",
    parameter: "placement.scale_x",
    points: [
      { offset_ms: 0, value: 1.0, easing: "linear" },
      { offset_ms: 33500, value: 1.12, easing: "linear" },
    ],
  });
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_01",
    parameter: "placement.scale_y",
    points: [
      { offset_ms: 0, value: 1.0, easing: "linear" },
      { offset_ms: 33500, value: 1.12, easing: "linear" },
    ],
  });

  const { sequence: envSeq } = loadSequence(wsDir);
  const envPlan = compileSequenceRenderPlan(envSeq, paths, "master_1080p", {
    includeAudio: false,
  });
  assert.ok(
    envPlan.filterComplex.includes("perspective="),
    "Dynamic scale envelope must compile to sub-pixel perspective transform"
  );

  const proc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      ...envPlan.inputArgs,
      "-filter_complex",
      envPlan.filterComplex,
      "-map",
      envPlan.videoOutPad,
      "-frames:v",
      "30",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "pipe:1",
    ],
    { cwd: wsDir, maxBuffer: 120 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0);

  const W = 1920;
  const H = 1080;
  const edges: number[] = [];
  for (let f = 0; f < 30; f++) {
    const rowOff = f * W * H + 540 * W;
    const bgVal = proc.stdout[rowOff + 100];
    const fgVal = proc.stdout[rowOff + 430];
    const span = Math.max(1, fgVal - bgVal);
    let sumFg = 0;
    for (let x = 350; x < 415; x++) {
      sumFg += Math.max(0, Math.min(1, (proc.stdout[rowOff + x] - bgVal) / span));
    }
    edges.push(415 - sumFg);
  }

  for (let i = 1; i < edges.length; i++) {
    const step = edges[i] - edges[i - 1];
    assert.ok(
      step < -0.02 && step > -0.2,
      `Expected monotonic sub-pixel left-edge step in (-0.2, -0.02) px at frame ${i}, got ${step.toFixed(4)} px`
    );
  }
});

test("3. monitor.frame at 3k+1 frame index with still PNG spine and HyperFrames composition does not drop to blank backdrop", () => {
  const wsDir = path.join(TEST_ROOT, "monitor_frame_3k1");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Monitor Frame 3k+1 Regression", aspect: "16:9", fps: 30 });

  const stillPng = path.join(wsDir, "textured_bg.png");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1E293B:s=640x360:d=1,drawbox=x=40:y=40:w=560:h=280:color=#475569:t=fill",
    "-frames:v",
    "1",
    stillPng,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [stillPng] });
  appendSpineClip({
    workspaceDir: wsDir,
    assetHandle: "img_01",
    sourceInMs: 0,
    sourceOutMs: 3000,
  });

  const compDir = path.join(wsDir, "compositions/card_comp");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    compositionId: "main",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 2000,
    preset: "title_card",
    props: { headline: "FRAME 3K+1", subhead: "NO EOF DROP" },
    transparent: true,
  });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 500,
    durationMs: 2000,
    composition: {
      composition_dir: "compositions/card_comp",
      entry_html: "index.html",
      props: {},
      transparent: true,
      mode: "overlay_alpha",
    },
  });

  // frameIdx = 31 (3*10 + 1 -> 1033.33ms, atMs = 1040ms): leadFrame = 27, frameIdx - leadFrame = 4 frames
  const frameRes = captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 1040,
  });
  assert.equal(frameRes.ok, true);
  assert.equal(frameRes.metrics.is_blank_frame, false);
  assert.equal(frameRes.diagnostics.length, 0);
  assert.ok(frameRes.metrics.luma_std > 10, `Expected non-flat frame luma_std > 10, got ${frameRes.metrics.luma_std}`);
});
