/**
 *  (`src/test/frame_accuracy.test.ts`).
 *
 * Verifies that sequences compiled from non-30fps (e.g. 24fps `testsrc`) clips with
 * non-frame-aligned millisecond durations (e.g. 1872ms, 1876ms, 1234ms), speed changes
 * (`playback.rate = 0.75`), transitions, and B-roll lane cues render with:
 * 1. Exact expected total frame count (`Math.ceil((duration_ms / 1000) * fps - 1e-6)`),
 * 2. Zero backdrop (`#0D0F12`) / black flash frames at any cut boundary,
 * 3. Frame-accurate alignment (zero frame drift at clip start and end).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { computeSequenceDurationMs } from "../brief/inspector.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import {
  appendSpineClip,
  setSpineSpeed,
  setSpineTransition,
} from "../sequence/spine.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/r3_frames_suite");

function ensureSynthetic24FpsTestsrcVideo(): string {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const videoPath = path.join(TEST_ROOT, "synth_testsrc_24fps.mp4");
  if (!fs.existsSync(videoPath)) {
    const proc = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=360x640:rate=24:duration=10",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=10",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        videoPath,
      ],
      { encoding: "utf8" }
    );
    assert.equal(proc.status, 0, `Failed to generate 24fps testsrc video: ${proc.stderr}`);
  }
  return videoPath;
}

function inspectRenderedFrames(mp4Path: string, width: number, height: number): {
  frameCount: number;
  backdropFrameIndices: number[];
  blackdetectEvents: number;
} {
  // 1. Run ffprobe frame count
  const probeProc = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v",
      "-count_frames",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "csv=p=0",
      mp4Path,
    ],
    { encoding: "utf8" }
  );
  assert.equal(probeProc.status, 0, `ffprobe failed: ${probeProc.stderr}`);
  const frameCount = Number(probeProc.stdout.trim());

  // 2. Run ffmpeg blackdetect
  const bdProc = spawnSync(
    "ffmpeg",
    [
      "-nostats",
      "-i",
      mp4Path,
      "-an",
      "-vf",
      "blackdetect=d=0:pix_th=0.10:pic_th=0.98",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  const blackdetectEvents = [...bdProc.stderr.matchAll(/black_start:([\d.]+)/g)].length;

  // 3. Decode every frame as raw RGB24 and verify no frame matches the uniform stage backdrop (#0D0F12 -> RGB 13, 15, 18)
  const sampleW = Math.min(80, width);
  const sampleH = Math.min(142, height);
  const rawProc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      mp4Path,
      "-vf",
      `scale=${sampleW}:${sampleH}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  assert.equal(rawProc.status, 0);

  const frameBytes = sampleW * sampleH * 3;
  const pixelCount = sampleW * sampleH;
  const backdropFrameIndices: number[] = [];

  for (let f = 0; f * frameBytes + frameBytes <= rawProc.stdout.length; f++) {
    const base = f * frameBytes;
    let backdropLikePixels = 0;
    for (let i = 0; i < frameBytes; i += 3) {
      const r = rawProc.stdout[base + i];
      const g = rawProc.stdout[base + i + 1];
      const b = rawProc.stdout[base + i + 2];
      // Stage backdrop #0D0F12 is (13, 15, 18)
      if (Math.abs(r - 13) <= 8 && Math.abs(g - 15) <= 8 && Math.abs(b - 18) <= 8) {
        backdropLikePixels++;
      }
    }
    if (backdropLikePixels / pixelCount >= 0.95) {
      backdropFrameIndices.push(f);
    }
  }

  return { frameCount, backdropFrameIndices, blackdetectEvents };
}

test("1. 24fps testsrc clips with non-frame-aligned cuts render exact frame count and zero backdrop frames", () => {
  const wsDir = path.join(TEST_ROOT, "ws_24fps_cuts");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "24fps Exact Cuts", aspect: "9:16", fps: 30 });

  const testsrcPath = ensureSynthetic24FpsTestsrcVideo();
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [testsrcPath] });

  // Append 4 non-30fps-aligned clips from the 24fps testsrc source
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 1872 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 2000, sourceOutMs: 3872 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 4123, sourceOutMs: 6000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 6500, sourceOutMs: 7734 });

  const { sequence } = loadSequence(wsDir);
  const totalDurationMs = computeSequenceDurationMs(sequence);
  assert.equal(totalDurationMs, 1872 + 1872 + 1877 + 1234); // 6855 ms -> ceil(6.855 * 30) = 206 frames
  const expectedFrames = Math.ceil((totalDurationMs / 1000) * 30 - 1e-6);
  assert.equal(expectedFrames, 206);

  const outMp4 = path.join(wsDir, "output/cuts_draft.mp4");
  const renderRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "draft_480p",
    outputPath: outMp4,
  });
  assert.equal(renderRes.ok, true);

  const inspection = inspectRenderedFrames(outMp4, renderRes.width, renderRes.height);
  assert.equal(
    inspection.frameCount,
    expectedFrames,
    `Expected ${expectedFrames} rendered frames, got ${inspection.frameCount}`
  );
  assert.equal(
    inspection.blackdetectEvents,
    0,
    `Expected 0 blackdetect events, got ${inspection.blackdetectEvents}`
  );
  assert.deepEqual(
    inspection.backdropFrameIndices,
    [],
    `Expected no backdrop frames (#0D0F12), found at indices: ${inspection.backdropFrameIndices.join(", ")}`
  );

  // Verify counter-metric: first and last output frame of clip 2 (2000..3872ms -> tl 1872..3744ms) match source frames without drift
  const w = renderRes.width;
  const h = renderRes.height;
  const srcFramesProc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      testsrcPath,
      "-filter_complex",
      `sws_flags=accurate_rnd+full_chroma_int;[0:v]settb=AVTB,trim=start=2.000:end=3.872,setpts=PTS-STARTPTS,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},format=rgba,format=yuv420p[v]`,
      "-map",
      "[v]",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  const frameSize = w * h * 3;
  const srcCount = Math.floor(srcFramesProc.stdout.length / frameSize);
  assert.ok(srcCount >= 44, `Expected >=44 source frames in 1.872s @ 24fps, got ${srcCount}`);
  const srcFirst = srcFramesProc.stdout.subarray(0, frameSize);
  const srcLast = srcFramesProc.stdout.subarray((srcCount - 1) * frameSize, srcCount * frameSize);

  const extractOutFrame = (k: number): Buffer =>
    spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        outMp4,
        "-vf",
        `select='eq(n,${k})'`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { maxBuffer: 16 * 1024 * 1024 }
    ).stdout;

  const mae = (a: Buffer, b: Buffer): number => {
    let s = 0;
    for (let i = 0; i < frameSize; i++) s += Math.abs(a[i] - b[i]);
    return s / frameSize;
  };

  // Clip 2 spans timeline [1.872s, 3.744s] -> output frames k=57 .. k=112
  const outFirst = extractOutFrame(57);
  const outLast = extractOutFrame(112);
  assert.ok(mae(outFirst, srcFirst) < 5.0, `Expected clip 2 first frame (k=57) to match source_in frame (MAE=${mae(outFirst, srcFirst).toFixed(2)})`);
  assert.ok(mae(outLast, srcLast) < 5.0, `Expected clip 2 last frame (k=112) to match source_out-1 frame (MAE=${mae(outLast, srcLast).toFixed(2)})`);
});

test("2. 24fps testsrc clips with speed=0.75, dissolve transition, and B-roll lane cue render with zero backdrop frames", () => {
  const wsDir = path.join(TEST_ROOT, "ws_24fps_speed_trans_lane");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "24fps Speed & Transition", aspect: "9:16", fps: 30 });

  const testsrcPath = ensureSynthetic24FpsTestsrcVideo();
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [testsrcPath] });

  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 1872 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 2500, sourceOutMs: 4372 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 5000, sourceOutMs: 6234 });

  // Slow first clip to 0.75x (1872ms -> 2496ms) and add a 300ms dissolve transition
  setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", rate: 0.75 });
  setSpineTransition({
    workspaceDir: wsDir,
    clipId: "sp_01",
    transition: { kind: "dissolve", duration_ms: 300, easing: "ease_in_out" },
  });

  // Add a 24fps B-roll lane cue with non-aligned duration
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_broll",
    kind: "broll",
    assetHandle: "vid_01",
    atMs: 2600,
    durationMs: 1472,
    sourceInMs: 7000,
    sourceOutMs: 8472,
  });

  const { sequence } = loadSequence(wsDir);
  const totalDurationMs = computeSequenceDurationMs(sequence);
  const expectedFrames = Math.ceil((totalDurationMs / 1000) * 30 - 1e-6);

  const outMp4 = path.join(wsDir, "output/speed_trans_draft.mp4");
  const renderRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "draft_480p",
    outputPath: outMp4,
  });
  assert.equal(renderRes.ok, true);

  const inspection = inspectRenderedFrames(outMp4, renderRes.width, renderRes.height);
  assert.equal(
    inspection.frameCount,
    expectedFrames,
    `Expected ${expectedFrames} rendered frames, got ${inspection.frameCount}`
  );
  assert.equal(
    inspection.blackdetectEvents,
    0,
    `Expected 0 blackdetect events, got ${inspection.blackdetectEvents}`
  );
  assert.deepEqual(
    inspection.backdropFrameIndices,
    [],
    `Expected no backdrop frames (#0D0F12), found at indices: ${inspection.backdropFrameIndices.join(", ")}`
  );
});
