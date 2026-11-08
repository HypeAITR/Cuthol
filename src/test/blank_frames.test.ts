/**
 * Blank / Backdrop Frame Detection & Post-Render Sanity Verification Suite
 * (`src/test/blank_frames.test.ts`).
 *
 * Verifies:
 * 1. `evaluateRgb24FrameBlankness` & `annotateRgb24BufferToCanvas` detect solid backdrop frames
 *    (e.g. `#0D0F12` with luma ~15.08, or custom stage backdrop `#1E293B`) even when a white
 *    caption or small overlay sits on top, emitting `CUTHOL-G502`.
 * 2. Counter-criteria (zero false positives): real footage frames (`talk.mp4`, `broll_*.mp4`),
 *    darkened real footage (`-vf eq=brightness=-0.3`), and `gaps_J` 3x3 `monitor sheet`
 *    are NOT flagged as blank (`is_blank_frame: false`).
 * 3. `scanRenderedMp4ForBlankFrames` on `test-workspace/gaps/output/base.mp4`
 *    identifies all 6 drop-out events at `[1.867, 3.733, 7.467, 9.333, 11.2, 12.467]` seconds
 *    and emits `CUTHOL-G502`.
 * 4. `renderSequenceToMp4` post-render scan ignores intentional `fade` transition windows
 *    while reporting unintentional mid-clip backdrop drop-outs as `CUTHOL-G502`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createEmptySequence } from "../core/schema.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import {
  annotateRgb24BufferToCanvas,
  captureMonitorSheet,
  evaluateRgb24FrameBlankness,
} from "../monitor/preview.js";
import {
  renderSequenceToMp4,
  scanRenderedMp4ForBlankFrames,
} from "../render/renderer.js";
import { appendSpineClip, setSpineTransition } from "../sequence/spine.js";
import { FIXTURES_DIR, TRIAL_MEDIA_DIR } from "./fixtures.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const GAPS_J_DIR = path.join(FIXTURES_DIR, "gaps_J");
const BROKEN_BASE_MP4 = path.join(FIXTURES_DIR, "gaps", "output", "base.mp4");

/**
 * Builds a self-contained synthetic workspace mirroring the 8-clip `gaps` timeline
 * (`[1872, 1872, 1872, 1872, 1872, 1877, 1234, 1872]` ms at 30fps, backdrop `#0D0F12`)
 * and synthesizes a broken MP4 via ffmpeg `concat` of `testsrc` segments separated by
 * 1–2 frame `#0D0F12` backdrop drop-outs at the cut boundaries
 * (`[1.867, 3.733, 7.467, 9.333, 11.2, 12.467]` s).
 */
function ensureSyntheticGapsFixture(): {
  wsDir: string;
  sourceMp4: string;
  brokenMp4: string;
} {
  const wsDir = path.join(TEST_ROOT, "synthetic_gaps_fixture");
  const sourceMp4 = path.join(wsDir, "source_testsrc.mp4");
  const brokenMp4 = path.join(wsDir, "synthetic_broken_base.mp4");

  if (
    fs.existsSync( path.join(wsDir, "cuthol.sequence.json")) &&
    fs.existsSync(sourceMp4) &&
    fs.existsSync(brokenMp4)
  ) {
    return { wsDir, sourceMp4, brokenMp4 };
  }

  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Synthetic Gaps Fixture", aspect: "9:16", fps: 30 });

  // 1. Generate a 10s textured testsrc video for the workspace clips
  const srcRes = spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=s=320x568:r=30:d=10",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    sourceMp4,
  ]);
  assert.equal(srcRes.status, 0, `Failed to generate source_testsrc.mp4: ${srcRes.stderr?.toString()}`);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [sourceMp4] });

  const clipDurationsMs = [1872, 1872, 1872, 1872, 1872, 1877, 1234, 1872];
  for (let i = 0; i < clipDurationsMs.length; i++) {
    appendSpineClip({
      workspaceDir: wsDir,
      assetHandle: "vid_01",
      sourceInMs: i * 1000,
      sourceOutMs: i * 1000 + clipDurationsMs[i],
    });
  }

  // Set exact legacy unrounded clip timings from the `gaps` repro so cut boundaries sit right after frames 56, 112, 224, 280, 336..337, 374
  const loaded = loadSequence(wsDir);
  let cursorMs = 0;
  for (let i = 0; i < loaded.sequence.spine.clips.length; i++) {
    const dur = clipDurationsMs[i];
    const clip = loaded.sequence.spine.clips[i];
    clip.timeline_in_ms = cursorMs;
    clip.duration_ms = dur;
    clip.source_out_ms = clip.source_in_ms + dur;
    cursorMs += dur;
  }
  fs.writeFileSync(loaded.paths.sequenceFile, JSON.stringify(loaded.sequence, null, 2), "utf8");

  // 2. Synthesize the broken render MP4: 30fps testsrc with 1–2 frame #0D0F12 backdrop drop-outs at cut boundaries
  const enableExpr =
    "eq(n\\,56)+eq(n\\,112)+eq(n\\,224)+eq(n\\,280)+between(n\\,336\\,337)+eq(n\\,374)";
  const brokenRes = spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=s=320x568:r=30:d=14.367,drawbox=x=0:y=0:w=iw:h=ih:color=#0D0F12:t=fill:enable='${enableExpr}'`,
    "-c:v",
    "libx264",
    "-g",
    "1",
    "-pix_fmt",
    "yuv420p",
    brokenMp4,
  ]);
  assert.equal(brokenRes.status, 0, `Failed to synthesize broken MP4: ${brokenRes.stderr?.toString()}`);

  return { wsDir, sourceMp4, brokenMp4 };
}

function buildSyntheticFrameWithCaption(options: {
  width: number;
  height: number;
  bgRgb: [number, number, number];
  includeCaptionBlock: boolean;
}): Buffer {
  const { width, height, bgRgb, includeCaptionBlock } = options;
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = bgRgb[0];
    buf[i * 3 + 1] = bgRgb[1];
    buf[i * 3 + 2] = bgRgb[2];
  }

  if (includeCaptionBlock) {
    // Draw a dark semi-transparent caption pill near the bottom and a bright white text block inside it (~4% of frame area)
    const boxLeft = Math.round(width * 0.15);
    const boxRight = Math.round(width * 0.85);
    const boxTop = Math.round(height * 0.76);
    const boxBottom = Math.round(height * 0.84);

    for (let y = boxTop; y < boxBottom; y++) {
      for (let x = boxLeft; x < boxRight; x++) {
        const idx = (y * width + x) * 3;
        // Simulated white text glyph strokes inside the caption region
        const isTextStroke =
          y >= boxTop + 8 &&
          y < boxBottom - 8 &&
          x >= boxLeft + 16 &&
          x < boxRight - 16 &&
          (x + y) % 3 !== 0;
        if (isTextStroke) {
          buf[idx] = 255;
          buf[idx + 1] = 255;
          buf[idx + 2] = 255;
        } else {
          buf[idx] = 5;
          buf[idx + 1] = 6;
          buf[idx + 2] = 8;
        }
      }
    }
  }

  return buf;
}

test("1. Synthetic backdrop frame + white caption block is detected as blank (G502) and reads backdrop color from sequence", () => {
  const width = 480;
  const height = 854;
  const seq = createEmptySequence({
    projectId: "blank_unit",
    title: "Blank Unit Test",
    aspect: "9:16",
    fps: 30,
  });

  // 1a. Plain #0D0F12 backdrop after BT.709 YUV420p quantization: R=14, G=15, B=19 (luma_mean = 15.08, luma_std = 0)
  const plainBackdropBuf = buildSyntheticFrameWithCaption({
    width,
    height,
    bgRgb: [14, 15, 19],
    includeCaptionBlock: false,
  });
  const plainAnn = annotateRgb24BufferToCanvas(plainBackdropBuf, width, height, 1000, seq, false);
  assert.equal(plainAnn.metrics.luma_mean, 15.08);
  assert.equal(plainAnn.metrics.luma_std, 0);
  assert.equal(plainAnn.metrics.is_blank_frame, true);
  assert.ok(plainAnn.diagnostic);
  assert.equal(plainAnn.diagnostic.code, "CUTHOL-G502");

  // 1b. Backdrop #0D0F12 + white caption block on top (global luma_std > 25, but >90% of frame is flat backdrop)
  const captionedBackdropBuf = buildSyntheticFrameWithCaption({
    width,
    height,
    bgRgb: [14, 15, 19],
    includeCaptionBlock: true,
  });
  const capAnn = annotateRgb24BufferToCanvas(captionedBackdropBuf, width, height, 1000, seq, false);
  assert.ok(capAnn.metrics.luma_std > 20, `Expected high global luma_std from white text, got ${capAnn.metrics.luma_std}`);
  assert.equal(capAnn.metrics.is_blank_frame, true);
  assert.ok(capAnn.diagnostic);
  assert.equal(capAnn.diagnostic.code, "CUTHOL-G502");

  // 1c. Dynamic stage backdrop color (#1E293B -> R=30, G=41, B=59, luma ~39.5):
  // Not blank when stage backdrop is #0D0F12, but IS blank when stage.backdrop.color is #1E293B!
  const customBgBuf = buildSyntheticFrameWithCaption({
    width,
    height,
    bgRgb: [30, 41, 59],
    includeCaptionBlock: true,
  });
  const underDefaultStage = annotateRgb24BufferToCanvas(customBgBuf, width, height, 1000, seq, false);
  assert.equal(
    underDefaultStage.metrics.is_blank_frame,
    false,
    "A #1E293B frame must not be considered backdrop-blank when sequence backdrop is #0D0F12"
  );

  seq.stage.backdrop.color = "#1E293B";
  const underCustomStage = annotateRgb24BufferToCanvas(customBgBuf, width, height, 1000, seq, false);
  assert.equal(
    underCustomStage.metrics.is_blank_frame,
    true,
    "A #1E293B frame with a small white text overlay must be detected as blank when stage.backdrop.color is #1E293B"
  );
  assert.ok(underCustomStage.diagnostic);
  assert.equal(underCustomStage.diagnostic.code, "CUTHOL-G502");
});

test("2. Post-render scan on broken base.mp4 finds all 6 backdrop drop-out events at exact timestamps", () => {
  const { wsDir: synthWsDir, brokenMp4: synthBrokenMp4 } = ensureSyntheticGapsFixture();
  const { sequence: synthSequence } = loadSequence(synthWsDir);
  const synthScan = scanRenderedMp4ForBlankFrames(synthBrokenMp4, synthSequence);

  const expectedTimestamps = [1.867, 3.733, 7.467, 9.333, 11.2, 12.467];
  const expectedClips = ["sp_01", "sp_02", "sp_04", "sp_05", "sp_06", "sp_07"];

  assert.equal(synthScan.events.length, 6);
  assert.equal(synthScan.blank_frames_count, 7);
  assert.deepEqual(synthScan.blank_at_s, expectedTimestamps);
  assert.deepEqual(
    synthScan.events.map((e) => e.clip_id),
    expectedClips
  );
  assert.equal(synthScan.diagnostics.length, 1);
  assert.equal(synthScan.diagnostics[0].code, "CUTHOL-G502");
  for (const tSec of ["1.867s", "3.733s", "7.467s", "9.333s", "11.2s", "12.467s"]) {
    assert.ok(
      synthScan.diagnostics[0].formatted.includes(tSec),
      `Expected diagnostic to list ${tSec}, got: ${synthScan.diagnostics[0].formatted}`
    );
  }

  // Optional local repro check when present on developer machine
  if (fs.existsSync(BROKEN_BASE_MP4) && fs.existsSync(GAPS_J_DIR)) {
    const { sequence: localSequence } = loadSequence(GAPS_J_DIR);
    const localScan = scanRenderedMp4ForBlankFrames(BROKEN_BASE_MP4, localSequence);
    assert.equal(localScan.events.length, 6);
    assert.equal(localScan.blank_frames_count, 7);
    assert.deepEqual(localScan.blank_at_s, expectedTimestamps);
    assert.equal(localScan.diagnostics.length, 1);
    assert.equal(localScan.diagnostics[0].code, "CUTHOL-G502");
  }
});

test("3. Counter-criteria (false-alarm immunity): real footage, darkened (-vf eq=brightness=-0.3) footage, and gaps_J 3x3 monitor sheet", () => {
  const { wsDir: synthWsDir, sourceMp4: synthSourceMp4 } = ensureSyntheticGapsFixture();
  const candidateFiles = [
    synthSourceMp4,
    ...["talk.mp4", "broll_1.mp4", "broll_2.mp4", "broll_4.mp4"].map((f) =>
      path.join(TRIAL_MEDIA_DIR, f)
    ),
  ];
  const w = 160;
  const h = 284;

  for (const absPath of candidateFiles) {
    if (!fs.existsSync(absPath)) continue;
    const fileName = path.basename(absPath);

    // 3a. Normal frame
    const normProc = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        "1.5",
        "-i",
        absPath,
        "-vf",
        `scale=${w}:${h}`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { maxBuffer: 4 * 1024 * 1024 }
    );
    assert.equal(normProc.status, 0);
    const normEval = evaluateRgb24FrameBlankness(normProc.stdout as Buffer, w, h, "#0D0F12");
    assert.equal(
      normEval.is_blank_frame,
      false,
      `Normal frame from ${fileName} must not be blank: ${JSON.stringify(normEval)}`
    );

    // 3b. Darkened but textured frame (-vf eq=brightness=-0.3)
    const darkProc = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        "1.5",
        "-i",
        absPath,
        "-vf",
        `scale=${w}:${h},eq=brightness=-0.3`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { maxBuffer: 4 * 1024 * 1024 }
    );
    assert.equal(darkProc.status, 0);
    const darkEval = evaluateRgb24FrameBlankness(darkProc.stdout as Buffer, w, h, "#0D0F12");
    assert.equal(
      darkEval.is_blank_frame,
      false,
      `Darkened (-0.3) textured frame from ${fileName} must not be blank: ${JSON.stringify(darkEval)}`
    );
  }

  // 3c. 3x3 monitor sheet on synthetic gaps workspace (always runs) + local gaps_J if present
  const synthSheet = captureMonitorSheet({
    workspaceDir: synthWsDir,
    cols: 3,
    rows: 3,
    showBoxes: true,
  });
  assert.equal(synthSheet.ok, true);
  assert.equal(synthSheet.frames.length, 9);
  assert.deepEqual(synthSheet.blank_frames_ms, []);
  assert.equal(synthSheet.diagnostics.length, 0);

  if (fs.existsSync(GAPS_J_DIR) && fs.existsSync(TRIAL_MEDIA_DIR)) {
    const localSheet = captureMonitorSheet({
      workspaceDir: GAPS_J_DIR,
      cols: 3,
      rows: 3,
      showBoxes: true,
    });
    assert.equal(localSheet.ok, true);
    assert.equal(localSheet.frames.length, 9);
    assert.deepEqual(localSheet.blank_frames_ms, []);
    assert.equal(localSheet.diagnostics.length, 0);
  }
});

test("4. Post-render scan ignores intentional fade transitions but flags unintentional mid-clip backdrop drop-outs", () => {
  const wsDir = path.join(TEST_ROOT, "blank_frames_fade_vs_dropout");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Fade vs Dropout", aspect: "16:9", fps: 30 });

  const cleanClipPath = path.join(wsDir, "clean_textured.mp4");
  const dropoutClipPath = path.join(wsDir, "dropout_midclip.mp4");

  // Clean textured clip (2s)
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1E3A8A:s=640x360:r=30:d=2,drawgrid=w=40:h=40:t=3:c=#38BDF8@0.6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    cleanClipPath,
  ]);

  // Clip with an unintentional 0.2s backdrop (#0D0F12) drop-out at 1.0..1.2s
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#0F766E:s=640x360:r=30:d=1.0,drawgrid=w=40:h=40:t=3:c=#2DD4BF@0.6",
    "-f",
    "lavfi",
    "-i",
    "color=c=#0D0F12:s=640x360:r=30:d=0.2",
    "-f",
    "lavfi",
    "-i",
    "color=c=#0F766E:s=640x360:r=30:d=0.8,drawgrid=w=40:h=40:t=3:c=#2DD4BF@0.6",
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1:a=0[vout]",
    "-map",
    "[vout]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    dropoutClipPath,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [cleanClipPath, dropoutClipPath] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
  // Intentional fade-out on sp_01
  setSpineTransition({
    workspaceDir: wsDir,
    clipId: "sp_01",
    transition: { kind: "fade", duration_ms: 500, easing: "linear" },
  });

  const cleanRender = renderSequenceToMp4({ workspaceDir: wsDir, preset: "draft_480p" });
  assert.equal(
    cleanRender.verification.diagnostics.filter((d) => d.code === "CUTHOL-G502").length,
    0,
    `Intentional fade transition must not trigger CUTHOL-G502, got ${JSON.stringify(cleanRender.verification.diagnostics)}`
  );

  // Now append vid_02 (which has an unintentional mid-clip backdrop drop-out at 1.0..1.2s -> timeline 3.0..3.2s)
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_02", sourceInMs: 0, sourceOutMs: 2000 });
  const dropoutRender = renderSequenceToMp4({ workspaceDir: wsDir, preset: "draft_480p" });
  const g502 = dropoutRender.verification.diagnostics.filter((d) => d.code === "CUTHOL-G502");
  assert.equal(g502.length, 1, "Expected CUTHOL-G502 warning for unintentional mid-clip backdrop drop-out");
  assert.ok(
    g502[0].formatted.includes("sp_02"),
    `Expected CUTHOL-G502 diagnostic to reference sp_02, got: ${g502[0].formatted}`
  );
  assert.ok(dropoutRender.blank_scan && dropoutRender.blank_scan.events.length === 1);
  assert.ok(
    Math.abs(dropoutRender.blank_scan.events[0].start_s - 3.0) <= 0.05,
    `Expected drop-out around 3.0s, got ${dropoutRender.blank_scan.events[0].start_s}s`
  );
});
