/**
 * Verification Suite (`src/test/overlay_modes_preview.test.ts`):
 * 1. Chromakey-Free Mode A (`overlay_alpha`): Pure `#00FF00` green element + semi-transparent shadow preservation
 * 2. Explicit Mode B (`scene_host`), `CUTHOL-G406` advisory, and boundary frame (`t_in-1..t_in`) continuity verification
 * 3. `previewAndCheckComposition` (3-column contact sheet + `alpha_gate` + `CUTHOL-G505` leak detection) & `captureMonitorTimeline`
 * 4. Acceptance Test: Fast `monitor frame` (`renderSingleCompositeFrameRgb24`) vs Full `render` pixel-by-pixel equivalence
 *    at (a) zoom envelope + composition + caption frame, (b) `dissolve` (`xfade`) midpoint, and (c) second spine clip frame.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { previewAndCheckComposition } from "../compositor/composition_preview.js";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { analyzeAssetBeats } from "../library/beats.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { analyzeAssetWaveform } from "../library/waveform.js";
import { captureMonitorFrame } from "../monitor/preview.js";
import { captureMonitorTimeline } from "../monitor/timeline_view.js";
import {
  ensurePreviewCompositeMp4,
  renderSequenceToMp4,
  renderSingleCompositeFrameRgb24,
} from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import {
  appendSpineClip,
  setItemEnvelope,
  setSpineTransition,
} from "../sequence/spine.js";
import { runWorkspaceVerification } from "../verify/gates.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/overlay_modes_preview_tests");

function ensureTestVideos(dir: string): { redVid: string; blueGridVid: string } {
  fs.mkdirSync(dir, { recursive: true });
  const redVid = path.join(dir, "red_base.mp4");
  const blueGridVid = path.join(dir, "blue_grid.mp4");

  if (!fs.existsSync(redVid)) {
    spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=0xB91C1C:s=1280x720:r=30:d=4",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=330:sample_rate=16000:duration=4",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        "-c:a",
        "aac",
        redVid,
      ],
      { encoding: "utf8" }
    );
  }

  if (!fs.existsSync(blueGridVid)) {
    spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=30:duration=4",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=16000:duration=4",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        "-c:a",
        "aac",
        blueGridVid,
      ],
      { encoding: "utf8" }
    );
  }

  return { redVid, blueGridVid };
}

function extractRgb24FrameAtSec(videoPath: string, sec: number, width: number, height: number): Buffer {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      sec.toFixed(4),
      "-i",
      videoPath,
      "-sws_flags",
      "accurate_rnd+full_chroma_int",
      "-vf",
      `scale=${width}:${height}:flags=accurate_rnd+full_chroma_int`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: width * height * 4 + 1024 * 1024, timeout: 20_000 }
  );
  return (proc.stdout as Buffer).subarray(0, width * height * 3);
}

test("1. Chromakey-Free Mode A (overlay_alpha): Pure #00FF00 Green Element & Semi-Transparent Shadow Preservation", () => {
  const wsDir = path.join(TEST_ROOT, "ws_mode_a_green");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { redVid } = ensureTestVideos(path.join(TEST_ROOT, "media"));

  initWorkspace({ dir: wsDir, title: "Mode A True Alpha Test", aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [redVid] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });

  // Author a custom transparent HyperFrames composition containing a pure #00FF00 green box at center
  // and a semi-transparent shadow around it. Under old colorkey=0x00FF00, the center would turn red!
  const compDir = path.join(wsDir, "compositions/green_card");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    compositionId: "main",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 2000,
    preset: "blank",
    transparent: true,
  });

  const customHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>
      html, body, #root {
        margin: 0;
        width: 100%;
        height: 100%;
        background: transparent;
        overflow: hidden;
      }
      .green-hero {
        position: absolute;
        left: 660px;
        top: 340px;
        width: 600px;
        height: 400px;
        background: #00FF00;
        border-radius: 32px;
        box-shadow: 0 36px 72px rgba(0, 0, 0, 0.65);
      }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="2">
      <section class="clip" data-start="0" data-duration="2">
        <div id="hero" class="green-hero"></div>
      </section>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#hero", { scale: 0.95, opacity: 0.9 }, { scale: 1, opacity: 1, duration: 0.2 }, 0);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`;
  fs.writeFileSync(path.join(compDir, "index.html"), customHtml, "utf8");

  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 500,
    durationMs: 2000,
    composition: {
      composition_dir: "compositions/green_card",
      entry_html: "index.html",
      props: {},
      transparent: true,
      mode: "overlay_alpha",
    },
  });

  const frameOut = path.join(wsDir, "mode_a_green_frame.png");
  captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 1200,
    showBoxes: false,
    outputPath: frameOut,
  });

  // Read center pixel (must be bright green G > 200, R < 50) and top-left background pixel (must be red R > 140, G < 50)
  const { paths, sequence } = loadSequence(wsDir);
  const raw = renderSingleCompositeFrameRgb24(sequence, paths, 1200, "draft_480p");
  const cx = Math.floor(raw.width / 2);
  const cy = Math.floor(raw.height / 2);
  const centerIdx = (cy * raw.width + cx) * 3;
  const centerR = raw.rgbBuf[centerIdx];
  const centerG = raw.rgbBuf[centerIdx + 1];
  const centerB = raw.rgbBuf[centerIdx + 2];

  const bgIdx = (40 * raw.width + 40) * 3;
  const bgR = raw.rgbBuf[bgIdx];
  const bgG = raw.rgbBuf[bgIdx + 1];

  assert.ok(
    centerG > 200 && centerR < 60 && centerB < 60,
    `Expected pure #00FF00 green element to remain green (not keyed out!), got RGB=(${centerR},${centerG},${centerB})`
  );
  assert.ok(
    bgR > 130 && bgG < 60,
    `Expected transparent area around card to show red spine background, got RGB=(${bgR},${bgG})`
  );
});

test("2. Explicit Mode B (scene_host), CUTHOL-G406 Advisory & Boundary Frame Continuity (t_in-1 <-> t_in)", () => {
  const wsDir = path.join(TEST_ROOT, "ws_mode_b_scene_host");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { blueGridVid } = ensureTestVideos(path.join(TEST_ROOT, "media"));

  initWorkspace({ dir: wsDir, title: "Mode B Glass & Boundary Test", aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [blueGridVid] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3500 });

  const compDir = path.join(wsDir, "compositions/frosted_glass");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    compositionId: "main",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 1500,
    preset: "blank",
    transparent: true,
  });

  const glassHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>
      html, body, #root {
        margin: 0;
        width: 100%;
        height: 100%;
        background: transparent;
        overflow: hidden;
      }
      .glass-panel {
        position: absolute;
        left: 460px;
        top: 260px;
        width: 1000px;
        height: 560px;
        background: rgba(255, 255, 255, 0.14);
        backdrop-filter: blur(22px) saturate(1.4);
        border: 3px solid rgba(255, 255, 255, 0.45);
        border-radius: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .blend-title {
        font-family: system-ui, sans-serif;
        font-size: 92px;
        font-weight: 900;
        color: #FFFFFF;
        mix-blend-mode: difference;
      }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="1.5">
      <section class="clip" data-start="0" data-duration="1.5" style="z-index:2">
        <div id="glass" class="glass-panel">
          <div class="blend-title">SCENE HOST</div>
        </div>
      </section>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#glass", { opacity: 0.95 }, { opacity: 1, duration: 0.2 }, 0);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`;
  fs.writeFileSync(path.join(compDir, "index.html"), glassHtml, "utf8");

  // 2a. First mount with default `mode: "overlay_alpha"` -> must NOT auto-switch, must emit `CUTHOL-G406`
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    explicitId: "cue_glass",
    atMs: 1000,
    durationMs: 1500,
    composition: {
      composition_dir: "compositions/frosted_glass",
      entry_html: "index.html",
      props: {},
      transparent: true,
      mode: "overlay_alpha",
    },
  });

  const verOverlay = runWorkspaceVerification(wsDir);
  const g406 = verOverlay.diagnostics.find((d) => d.code === "CUTHOL-G406");
  assert.ok(g406, "Expected CUTHOL-G406 (SCENE_HOST_RECOMMENDED) when backdrop-filter is used in overlay_alpha mode");

  // 2b. Switch cue_glass explicitly to `mode: "scene_host"` -> CUTHOL-G406 disappears
  const { paths, sequence } = loadSequence(wsDir);
  const cue = sequence.lanes.find((l) => l.id === "ln_motion")!.cues[0];
  cue.composition!.mode = "scene_host";
  cue.composition!.transparent = false;
  fs.writeFileSync(paths.sequenceFile, JSON.stringify(sequence, null, 2), "utf8");

  const verSceneHost = runWorkspaceVerification(wsDir);
  assert.equal(
    verSceneHost.diagnostics.some((d) => d.code === "CUTHOL-G406"),
    false,
    "Expected CUTHOL-G406 to clear once mode is explicitly set to scene_host"
  );

  // Render with draft_480p and verify boundary frame continuity around t_in = 1000ms (frame 29 @ 0.967s vs frame 30 @ 1.000s)
  const renderOut = path.join(wsDir, "output/mode_b_render.mp4");
  const renderRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "draft_480p",
    outputPath: renderOut,
  });
  assert.equal(renderRes.ok, true);

  // Extract boundary frames: just before Mode B starts (0.966s) and right after Mode B starts (1.033s)
  // Measure top strip (y in [10..60]), which is OUTSIDE the frosted glass card (card top is 260/1080 * 480 = 115px)
  const w = renderRes.width;
  const h = renderRes.height;
  const bufBefore = extractRgb24FrameAtSec(renderOut, 0.966, w, h);
  const bufInside = extractRgb24FrameAtSec(renderOut, 1.033, w, h);

  // Also save the Mode B composite frame at 1.5s for visual inspection
  captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 1500,
    showBoxes: false,
    outputPath: path.join(wsDir, "mode_b_frame_1500ms.png"),
  });

  let sumDiffLuma = 0;
  let samples = 0;
  for (let py = 12; py < 50; py++) {
    for (let px = 20; px < 180; px++) {
      const idx = (py * w + px) * 3;
      const y1 = 0.2126 * bufBefore[idx] + 0.7152 * bufBefore[idx + 1] + 0.0722 * bufBefore[idx + 2];
      const y2 = 0.2126 * bufInside[idx] + 0.7152 * bufInside[idx + 1] + 0.0722 * bufInside[idx + 2];
      sumDiffLuma += Math.abs(y1 - y2);
      samples++;
    }
  }
  const meanBoundaryLumaDiff = sumDiffLuma / Math.max(1, samples);
  assert.ok(
    meanBoundaryLumaDiff < 6.0,
    `Expected Mode B boundary background luma jump to be < 6.0/255, got ${meanBoundaryLumaDiff.toFixed(2)}`
  );
});

test("3. Composition Preview (3-Column Contact Sheet + Alpha Gate + CUTHOL-G505) & Visual Timeline (timeline.png)", () => {
  const wsDir = path.join(TEST_ROOT, "ws_preview_and_timeline");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { redVid, blueGridVid } = ensureTestVideos(path.join(TEST_ROOT, "media"));

  initWorkspace({ dir: wsDir, title: "Preview & Timeline Test", aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [redVid, blueGridVid] });
  analyzeAssetWaveform({ workspaceDir: wsDir, handle: "vid_01", bins: 60 });
  analyzeAssetBeats({ workspaceDir: wsDir, handle: "vid_01" });

  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2500 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_02", sourceInMs: 0, sourceOutMs: 2500 });
  setSpineTransition({
    workspaceDir: wsDir,
    clipId: "sp_01",
    transition: {
      kind: "dissolve",
      duration_ms: 400,
      easing: "ease_in_out",
    },
  });

  const compDir = path.join(wsDir, "compositions/lt_alpha");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    compositionId: "main",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 2000,
    preset: "lower_third",
    props: { headline: "GERÇEK ALFA KATMANI", subline: "SIFIR YEŞİL PERDE", accent: "#38BDF8" },
    transparent: true,
  });

  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    explicitId: "cue_lt",
    atMs: 300,
    durationMs: 2000,
    composition: {
      composition_dir: "compositions/lt_alpha",
      entry_html: "index.html",
      props: { headline: "GERÇEK ALFA KATMANI", subline: "SIFIR YEŞİL PERDE", accent: "#38BDF8" },
      transparent: true,
    },
  });

  // Add a music lane with a ducking envelope so timeline.png renders the yellow ducking curve!
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    explicitId: "cue_bgm",
    assetHandle: "vid_01",
    atMs: 0,
    durationMs: 3800,
  });
  const { paths, sequence } = loadSequence(wsDir);
  const bgmCue = sequence.lanes.find((l) => l.id === "ln_bgm")!.cues[0];
  bgmCue.envelopes.push({
    parameter: "audio_chain.gain_db",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 400, value: 0, easing: "linear" },
      { offset_ms: 550, value: -12, easing: "ease_out" },
      { offset_ms: 2200, value: -12, easing: "linear" },
      { offset_ms: 2550, value: 0, easing: "ease_in" },
      { offset_ms: 3800, value: 0, easing: "linear" },
    ],
  });
  fs.writeFileSync(paths.sequenceFile, JSON.stringify(sequence, null, 2), "utf8");

  // 3a. Run composition preview & verify alpha_gate passes + 3-column sheet exists
  const prevRes = previewAndCheckComposition({
    workspaceDir: wsDir,
    cueId: "cue_lt",
    atSeconds: [0.5, 1.2],
  });
  assert.equal(prevRes.ok, true);
  assert.equal(prevRes.alpha_gate.passed, true);
  assert.equal(prevRes.contrast_check_ran_on_footage, true);
  assert.ok(fs.existsSync(prevRes.contact_sheet_path));
  assert.ok(prevRes.alpha_gate.frames[0].transparent_ratio > 0.5);

  // 3b. Verify CUTHOL-G505 (OPAQUE_OVERLAY_LEAK) when an overlay accidentally covers 100% of frame opaquely
  const leakyDir = path.join(wsDir, "compositions/leaky_bg");
  scaffoldHyperFramesComposition({
    targetDir: leakyDir,
    compositionId: "main",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 1500,
    preset: "title_card",
    transparent: false, // Opaque #0F172A background!
  });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    explicitId: "cue_leaky",
    atMs: 2600,
    durationMs: 1500,
    composition: {
      composition_dir: "compositions/leaky_bg",
      entry_html: "index.html",
      props: {},
      transparent: true, // Mounted as transparent overlay, but #root has opaque #0F172A!
    },
  });
  const leakRes = previewAndCheckComposition({
    workspaceDir: wsDir,
    cueId: "cue_leaky",
    atSeconds: [0.5],
  });
  assert.equal(leakRes.alpha_gate.passed, false, "Expected alpha_gate to fail on opaque background leak");
  assert.ok(
    leakRes.diagnostics.some((d) => d.code === "CUTHOL-G505"),
    "Expected CUTHOL-G505 diagnostic on opaque overlay leak"
  );

  // 3c. Render visual NLE timeline (`timeline.png`)
  const tlRes = captureMonitorTimeline({ workspaceDir: wsDir });
  assert.equal(tlRes.ok, true);
  assert.ok(fs.existsSync(tlRes.png_path));
});

test("4. Acceptance Test: Fast monitor frame vs Full render Pixel-by-Pixel Equivalence (Zoom Envelope, Dissolve Midpoint, Captions)", () => {
  const wsDir = path.join(TEST_ROOT, "ws_fast_frame_equivalence");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { redVid, blueGridVid } = ensureTestVideos(path.join(TEST_ROOT, "media"));

  initWorkspace({ dir: wsDir, title: "Fast Monitor Frame Equivalence", aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [blueGridVid, redVid] });

  // sp_01: 0..2500ms, sp_02: 2500..4500ms with 600ms dissolve (so dissolve spans 1900..2500ms, midpoint = 2200ms)
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2500 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_02", sourceInMs: 0, sourceOutMs: 2000 });
  setSpineTransition({
    workspaceDir: wsDir,
    clipId: "sp_01",
    transition: {
      kind: "dissolve",
      duration_ms: 600,
      easing: "ease_in_out",
    },
  });

  // Add a zoom keyframe envelope on sp_01 (scale 1.0 -> 1.24 across 0..2000ms)
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_01",
    parameter: "placement.scale_x",
    points: [
      { offset_ms: 0, value: 1.0, easing: "linear" },
      { offset_ms: 2000, value: 1.24, easing: "linear" },
    ],
  });
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_01",
    parameter: "placement.scale_y",
    points: [
      { offset_ms: 0, value: 1.0, easing: "linear" },
      { offset_ms: 2000, value: 1.24, easing: "linear" },
    ],
  });

  // Add .ass caption cue spanning 500..3500ms
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_captions",
    kind: "caption",
    atMs: 500,
    durationMs: 3000,
    text: "Kare hizası ve geçiş eşdeğerliği testi",
  });

  // Add two compositions: comp_early (400..1800ms) and comp_late (3100..4100ms)
  const earlyDir = path.join(wsDir, "compositions/comp_early");
  const lateDir = path.join(wsDir, "compositions/comp_late");
  scaffoldHyperFramesComposition({
    targetDir: earlyDir,
    compositionId: "main",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 1400,
    preset: "badge_overlay",
    props: { headline: "EARLY BADGE" },
    transparent: true,
  });
  scaffoldHyperFramesComposition({
    targetDir: lateDir,
    compositionId: "main",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 1000,
    preset: "lower_third",
    props: { headline: "LATE COMP" },
    transparent: true,
  });

  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 400,
    durationMs: 1400,
    composition: {
      composition_dir: "compositions/comp_early",
      entry_html: "index.html",
      props: { headline: "EARLY BADGE" },
      transparent: true,
    },
  });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 3100,
    durationMs: 1000,
    composition: {
      composition_dir: "compositions/comp_late",
      entry_html: "index.html",
      props: { headline: "LATE COMP" },
      transparent: true,
    },
  });

  const { paths, sequence } = loadSequence(wsDir);

  // Capture 3 fast single frames BEFORE full video render:
  // (a) t = 1000ms (zoom envelope active + comp_early active + .ass caption active)
  // (b) t = 2200ms (dissolve midpoint between sp_01 and sp_02 + .ass caption active)
  // (c) t = 2700ms (sp_02 + .ass caption active)
  const testTimesMs = [1000, 2200, 2700];
  const fastFrames = testTimesMs.map((tMs) =>
    renderSingleCompositeFrameRgb24(sequence, paths, tMs, "draft_480p")
  );

  // Verify that NO full .mov video blob was rendered yet (only single-frame PNG for comp_early, and 0 for comp_late!)
  const blobsBeforeFull = fs.readdirSync(paths.blobsDir);
  assert.equal(
    blobsBeforeFull.some((f) => f.startsWith("hf_comp_") && f.endsWith(".mov")),
    false,
    `Expected fast monitor frame NOT to render full .mov composition videos, found: ${blobsBeforeFull.join(", ")}`
  );

  // Now perform the FULL sequence composite render (`ensurePreviewCompositeMp4`)
  const fullPreview = ensurePreviewCompositeMp4(sequence, paths, "draft_480p");

  // Compare each fast frame pixel-by-pixel against the exact same frame extracted from the full render!
  for (let i = 0; i < testTimesMs.length; i++) {
    const tMs = testTimesMs[i];
    const fast = fastFrames[i];
    const frameIdx = Math.floor((tMs / 1000) * sequence.stage.fps + 1e-6);
    const snappedSec = frameIdx / sequence.stage.fps;
    const fullRgb = extractRgb24FrameAtSec(fullPreview.mp4Path, snappedSec, fast.width, fast.height);

    let totalAbsDiff = 0;
    const len = fast.rgbBuf.length;
    for (let b = 0; b < len; b++) {
      totalAbsDiff += Math.abs(fast.rgbBuf[b] - fullRgb[b]);
    }
    const meanAbsDiff = totalAbsDiff / len;
    assert.ok(
      meanAbsDiff < 2.0,
      `Expected fast monitor frame at ${tMs}ms to match full render within 2.0/255 MAE, got MAE=${meanAbsDiff.toFixed(3)}`
    );
  }
});
