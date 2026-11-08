/**
 *  (`src/test/reframe.test.ts`).
 *
 * Tests:
 * 1. Synthetic 16:9 video with a moving subject (left plateau -> smooth pan -> right plateau)
 *    reframed into a 9:16 vertical project: verifies subject tracking accuracy, plateau stillness,
 *    and actual rendered pixel presence at the center of the 9:16 frame via `captureMonitorFrame`.
 * 2. Guard against unnecessary motion in 16:9 projects and stationary clips (both centered and off-center).
 * 3. Agent manual override (`manualPoints` patch & replace) and preservation of `treatments.reframe`
 *    and `placement.x_pct` envelopes across `splitSpineClip` and `exciseSpineRanges`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import {
  appendSpineClip,
  evaluateEnvelopeAt,
  exciseSpineRanges,
  reframeSpineClips,
  splitSpineClip,
} from "../sequence/spine.js";
import { captureMonitorFrame } from "../monitor/preview.js";
import { renderSequenceBrief } from "../brief/inspector.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const MEDIA_DIR = path.join(TEST_ROOT, "shared_media_r2_reframe");

function ensureMovingSubjectVideo(): string {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const videoPath = path.join(MEDIA_DIR, "moving_subject_6s.mp4");
  if (!fs.existsSync(videoPath)) {
    // 640x360 (16:9), 6s:
    // Subject box (110x160, warm skin-like tone #E8B49A) on dark slate background (#111827):
    // - 0..2s: stationary on left (center_x = 160px = 25%, x0 = 105)
    // - 2..4s: moves smoothly from left (x0=105) to right (center_x = 480px = 75%, x0 = 425)
    // - 4..6s: stationary on right (x0 = 425)
    const filterComplex = [
      "color=c=#111827:s=640x360:r=30:d=6[bg]",
      "color=c=#E8B49A:s=110x160:r=30:d=6[subj]",
      "[bg][subj]overlay=x='if(lt(t,2),105,if(lt(t,4),105+160*(t-2),425))':y=90:eval=frame,format=yuv420p[v]",
    ].join(";");

    const proc = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=330:sample_rate=48000:duration=6",
        "-filter_complex",
        filterComplex,
        "-map",
        "[v]",
        "-map",
        "0:a",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        videoPath,
      ],
      { encoding: "utf8" }
    );
    assert.equal(proc.status, 0, `FFmpeg moving subject video generation failed: ${proc.stderr}`);
  }
  return videoPath;
}

function ensureStationaryCenteredVideo(): string {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const videoPath = path.join(MEDIA_DIR, "stationary_center_4s.mp4");
  if (!fs.existsSync(videoPath)) {
    // Subject stationary at exact horizontal center (x0 = (640-110)/2 = 265 => center_x = 50%)
    const filterComplex = [
      "color=c=#111827:s=640x360:r=30:d=4[bg]",
      "color=c=#E8B49A:s=110x160:r=30:d=4[subj]",
      "[bg][subj]overlay=x=265:y=90,format=yuv420p[v]",
    ].join(";");

    const proc = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-filter_complex",
        filterComplex,
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        videoPath,
      ],
      { encoding: "utf8" }
    );
    assert.equal(proc.status, 0, `FFmpeg stationary video generation failed: ${proc.stderr}`);
  }
  return videoPath;
}

test("1. Synthetic moving subject (16:9 -> 9:16): tracks subject into center and holds steady on plateaus", () => {
  const wsDir = path.join(TEST_ROOT, "r2_reframe_moving_9_16");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Reframe Moving 9:16", aspect: "9:16", fps: 30 });

  const videoPath = ensureMovingSubjectVideo();
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [videoPath] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01" });

  // Before reframe: at t=1000ms (subject at x=25%) and t=5000ms (subject at x=75%),
  // default center crop [34.2%..65.8%] misses the bright subject almost completely (low mean luma).
  const beforeLeft = captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 1000,
    showBoxes: false,
    outputPath: path.join(wsDir, "before_1000ms.png"),
  });
  const beforeRight = captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 5000,
    showBoxes: false,
    outputPath: path.join(wsDir, "before_5000ms.png"),
  });

  // Apply subject-tracking reframe
  const reframeRes = reframeSpineClips({
    workspaceDir: wsDir,
    clipIds: ["sp_01"],
  });

  assert.equal(reframeRes.clips.length, 1);
  const plan = reframeRes.clips[0];
  assert.equal(plan.applied_pan, true);
  assert.equal(plan.horizontal_pan_available, true);
  assert.ok(Math.abs(plan.scale_x - 3.1605) < 0.02, `Expected scale_x ~3.1605, got ${plan.scale_x}`);
  assert.ok(plan.mean_confidence > 0.5, `Expected high confidence, got ${plan.mean_confidence}`);
  assert.ok(plan.envelope_points.length >= 2, "Expected dynamic envelope points");

  const { sequence } = loadSequence(wsDir);
  const clip = sequence.spine.clips[0];
  assert.equal(clip.treatments.reframe.enabled, true);
  assert.equal(clip.treatments.reframe.mode, "subject_track");
  const xEnv = clip.envelopes.find((e) => e.parameter === "placement.x_pct");
  assert.ok(xEnv, "Expected placement.x_pct envelope on sp_01");

  // At t=1000ms (left plateau, subject near 25%), x_pct must be strongly positive (> +50%)
  const xPctAt1000 = evaluateEnvelopeAt(xEnv, 1000);
  assert.ok(xPctAt1000 > 50, `Expected positive x_pct (> +50%) at 1000ms, got ${xPctAt1000}`);

  // Plateau stillness check on left plateau (500ms vs 1200ms)
  const xPctAt500 = evaluateEnvelopeAt(xEnv, 500);
  const xPctAt1200 = evaluateEnvelopeAt(xEnv, 1200);
  assert.ok(
    Math.abs(xPctAt500 - xPctAt1200) < 1.0,
    `Expected stationary left plateau between 500ms (${xPctAt500}) and 1200ms (${xPctAt1200})`
  );

  // At t=5000ms (right plateau, subject near 75%), x_pct must be strongly negative (< -50%)
  const xPctAt5000 = evaluateEnvelopeAt(xEnv, 5000);
  assert.ok(xPctAt5000 < -50, `Expected negative x_pct (< -50%) at 5000ms, got ${xPctAt5000}`);

  // Plateau stillness check on right plateau (4600ms vs 5500ms)
  const xPctAt4600 = evaluateEnvelopeAt(xEnv, 4600);
  const xPctAt5500 = evaluateEnvelopeAt(xEnv, 5500);
  assert.ok(
    Math.abs(xPctAt4600 - xPctAt5500) < 1.0,
    `Expected stationary right plateau between 4600ms (${xPctAt4600}) and 5500ms (${xPctAt5500})`
  );

  // Capture monitor frames after reframe at 1000ms, 3000ms (midpoint), and 5000ms:
  // Because the bright subject (#E8B49A) is now centered inside the 9:16 frame, frame luma_mean increases significantly!
  const afterLeft = captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 1000,
    showBoxes: false,
    outputPath: path.join(wsDir, "after_1000ms.png"),
  });
  const afterMid = captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 3000,
    showBoxes: false,
    outputPath: path.join(wsDir, "after_3000ms.png"),
  });
  const afterRight = captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 5000,
    showBoxes: false,
    outputPath: path.join(wsDir, "after_5000ms.png"),
  });

  assert.ok(
    afterLeft.metrics.luma_mean > beforeLeft.metrics.luma_mean + 25,
    `Expected bright subject in frame at 1000ms after reframe (before=${beforeLeft.metrics.luma_mean}, after=${afterLeft.metrics.luma_mean})`
  );
  assert.ok(
    afterRight.metrics.luma_mean > beforeRight.metrics.luma_mean + 25,
    `Expected bright subject in frame at 5000ms after reframe (before=${beforeRight.metrics.luma_mean}, after=${afterRight.metrics.luma_mean})`
  );
  assert.ok(
    afterMid.metrics.luma_mean > beforeLeft.metrics.luma_mean + 25,
    `Expected bright subject in frame at 3000ms midpoint pan (luma=${afterMid.metrics.luma_mean})`
  );

  // Verify brief detail lens reflects reframe focal points and envelope
  const detailMd = renderSequenceBrief(sequence, { lens: "detail", targetIds: ["sp_01"] });
  assert.ok(detailMd.includes('"subject_track"'));
  assert.ok(detailMd.includes('"placement.x_pct"'));
});

test("2. Guard against unnecessary motion in 16:9 projects and stationary clips", () => {
  // 2a. 16:9 project with moving 16:9 video -> zero horizontal pan
  const ws16x9 = path.join(TEST_ROOT, "r2_reframe_16_9_guard");
  fs.rmSync(ws16x9, { recursive: true, force: true });
  initWorkspace({ dir: ws16x9, title: "Reframe 16:9 Guard", aspect: "16:9", fps: 30 });

  const movingVideo = ensureMovingSubjectVideo();
  ingestAssetsIntoWorkspace({ workspaceDir: ws16x9, filePaths: [movingVideo] });
  appendSpineClip({ workspaceDir: ws16x9, assetHandle: "vid_01" });

  const res16x9 = reframeSpineClips({ workspaceDir: ws16x9 });
  assert.equal(res16x9.clips[0].horizontal_pan_available, false);
  assert.equal(res16x9.clips[0].applied_pan, false);
  assert.equal(res16x9.clips[0].scale_x, 1);
  assert.equal(res16x9.clips[0].envelope_points.length, 0);

  const seq16x9 = loadSequence(ws16x9).sequence;
  assert.equal(seq16x9.spine.clips[0].placement.scale_x, 1);
  assert.equal(seq16x9.spine.clips[0].placement.x_pct, 0);
  assert.equal(seq16x9.spine.clips[0].envelopes.length, 0);

  // 2b. 9:16 project with stationary centered subject -> zero pan, zero envelopes
  const wsStatic = path.join(TEST_ROOT, "r2_reframe_stationary_guard");
  fs.rmSync(wsStatic, { recursive: true, force: true });
  initWorkspace({ dir: wsStatic, title: "Reframe Stationary Guard", aspect: "9:16", fps: 30 });

  const staticVideo = ensureStationaryCenteredVideo();
  ingestAssetsIntoWorkspace({ workspaceDir: wsStatic, filePaths: [staticVideo] });
  appendSpineClip({ workspaceDir: wsStatic, assetHandle: "vid_01" });

  const resStatic = reframeSpineClips({ workspaceDir: wsStatic });
  assert.equal(resStatic.clips[0].horizontal_pan_available, true);
  assert.equal(resStatic.clips[0].applied_pan, false);
  assert.equal(resStatic.clips[0].envelope_points.length, 0);

  const seqStatic = loadSequence(wsStatic).sequence;
  assert.equal(seqStatic.spine.clips[0].placement.x_pct, 0);
  assert.equal(seqStatic.spine.clips[0].envelopes.length, 0);
});

test("3. Agent manual override (--points patch/replace) & split/excise focal_points slicing", () => {
  const wsDir = path.join(TEST_ROOT, "r2_reframe_manual_and_slice");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Reframe Manual & Slice", aspect: "9:16", fps: 30 });

  const movingVideo = ensureMovingSubjectVideo();
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [movingVideo] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01" });

  // Initial auto reframe
  reframeSpineClips({ workspaceDir: wsDir, clipIds: ["sp_01"] });

  // Agent patches t=3000ms to center_x_pct = 62%
  const patchRes = reframeSpineClips({
    workspaceDir: wsDir,
    clipIds: ["sp_01"],
    manualPoints: [{ offset_ms: 3000, center_x_pct: 62 }],
  });
  const patchedFocal = patchRes.clips[0].focal_points.find((f) => f.offset_ms === 3000);
  assert.ok(patchedFocal, "Expected manual focal point at 3000ms");
  assert.equal(patchedFocal.center_x_pct, 62);
  assert.equal(patchedFocal.confidence, 1.0);

  // Split clip at 3000ms and verify both sub-clips retain sliced envelopes and reframe focal_points
  const splitRes = splitSpineClip({
    workspaceDir: wsDir,
    clipId: "sp_01",
    splitPointsMs: [3000],
  });
  assert.equal(splitRes.clips.length, 2);
  for (const sub of splitRes.clips) {
    assert.equal(sub.treatments.reframe.enabled, true);
    assert.ok(sub.treatments.reframe.focal_points.length >= 1);
    for (const fp of sub.treatments.reframe.focal_points) {
      assert.ok(fp.offset_ms >= 0 && fp.offset_ms <= sub.duration_ms);
    }
    const env = sub.envelopes.find((e) => e.parameter === "placement.x_pct");
    assert.ok(env && env.points.length >= 1);
  }

  // Excise a middle range from the second clip and verify focal_points stay within bounds
  const exciseRes = exciseSpineRanges({
    workspaceDir: wsDir,
    clipId: splitRes.clips[1].id,
    ranges: [{ start_ms: 500, end_ms: 1500 }],
    coordinateSpace: "clip_local",
  });
  assert.ok(exciseRes.remainingClips.length >= 1);
  for (const rem of exciseRes.remainingClips) {
    for (const fp of rem.treatments.reframe.focal_points) {
      assert.ok(fp.offset_ms >= 0 && fp.offset_ms <= rem.duration_ms);
    }
  }
});
