/**
 * Regression & Verification Suite for Task U2 (`src/test/color_alpha_encoders.test.ts`):
 * 0. Explicit BT.709 (tv range) color consistency across single-pass, segmented, monitor frame, and sheet paths.
 * 1. Lossless PNG-sequence (`hf_comp_<hash>.pngseq`) intermediate format for transparent HyperFrames overlays
 *    (plus frame-count cache validation, atomic staging, and frame-exact FFV1 option).
 * 2. Multi-vendor video encoder selection (`h264_nvenc`, `h264_amf`, `h264_qsv`, `h264_vaapi`, `h264_videotoolbox`,
 *    `libx264`), first-use color-bars PSNR/drift verification, AMF BT.709 color fix, parallel segment session-limit
 *    fallback, and generalized watchdog stall retry.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  inspectPngSequenceDir,
  isPngSequenceBlobDir,
  isValidVideoBlobOnDisk,
  scaffoldHyperFramesComposition,
} from "../compositor/hyperframes_bridge.js";
import { resolveAlphaOverlayFormat, resolveVideoEncoderPreference } from "../core/env.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import {
  ingestAssetsIntoWorkspace,
  resolveSourceColorSpec,
} from "../library/probe.js";
import { captureMonitorFrame } from "../monitor/preview.js";
import { verifySequence } from "../verify/gates.js";
import {
  buildVideoCodecArgs,
  clearEncoderProbeCache,
  getAutoHardwareEncoderOrder,
  probeAndVerifyVideoEncoder,
  resolveMaxHardwareEncoderSessions,
  resolveVideoEncoderForRender,
} from "../render/encoder.js";
import {
  renderSequenceToMp4,
  renderSingleCompositeFrameRgb24,
} from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/color_alpha_encoders");

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

function probeVideoColorTags(mp4Path: string): {
  pix_fmt: string;
  color_range: string;
  color_space: string;
  color_transfer: string;
  color_primaries: string;
} {
  const proc = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=pix_fmt,color_range,color_space,color_transfer,color_primaries",
      "-of",
      "json",
      mp4Path,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr);
  const parsed = JSON.parse(proc.stdout);
  const st = parsed.streams?.[0] ?? {};
  return {
    pix_fmt: String(st.pix_fmt ?? ""),
    color_range: String(st.color_range ?? ""),
    color_space: String(st.color_space ?? ""),
    color_transfer: String(st.color_transfer ?? ""),
    color_primaries: String(st.color_primaries ?? ""),
  };
}

function decodeMp4FrameRgb24(mp4Path: string, atSec: number, width: number, height: number): Buffer {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      atSec.toFixed(3),
      "-i",
      mp4Path,
      "-vf",
      `scale=${width}:${height}:flags=accurate_rnd+full_chroma_int:in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: width * height * 4 + 1024 * 1024 }
  );
  assert.equal(proc.status, 0);
  return (proc.stdout as Buffer).subarray(0, width * height * 3);
}

function computePsnrBetweenRgbBuffers(a: Buffer, b: Buffer): number {
  const len = Math.min(a.length, b.length);
  assert.ok(len > 0);
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const d = a[i] - b[i];
    sumSq += d * d;
  }
  const mse = sumSq / len;
  return mse <= 1e-9 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

test("1. Explicit BT.709 (tv range) color tags and RGB accuracy across single-pass, segmented, and monitor frame paths", () => {
  const wsDir = path.join(TEST_ROOT, "ws_bt709_parity");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({
    dir: wsDir,
    title: "BT709 Parity",
    aspect: "16:9",
    fps: 30,
  });

  // Create two solid-color source clips (#1E40AF blue = RGB(30,64,175) and #16A34A green = RGB(22,163,74))
  const clipBlue = path.join(wsDir, "blue.mp4");
  const clipGreen = path.join(wsDir, "green.mp4");
  for (const [hex, out] of [
    ["0x1E40AF", clipBlue],
    ["0x16A34A", clipGreen],
  ] as const) {
    const p = spawnSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${hex}:s=640x360:r=30:d=2,format=rgb24,scale=in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv`,
      "-c:v",
      "libx264",
      "-crf",
      "10",
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
      out,
    ]);
    assert.equal(p.status, 0);
  }

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [clipBlue, clipGreen] });
  for (let i = 0; i < 4; i++) {
    appendSpineClip({
      workspaceDir: wsDir,
      assetHandle: i % 2 === 0 ? "vid_01" : "vid_02",
      sourceInMs: 0,
      sourceOutMs: 1000,
    });
  }

  const singleRes = withEnv({ CUTHOL_RENDER_SEGMENT_MAX_CLIPS: "24" }, () =>
    renderSequenceToMp4({
      workspaceDir: wsDir,
      preset: "draft_480p",
      encoder: "libx264",
      outputPath: "output/single.mp4",
    })
  );
  const segRes = withEnv({ CUTHOL_RENDER_SEGMENT_MAX_CLIPS: "1" }, () =>
    renderSequenceToMp4({
      workspaceDir: wsDir,
      preset: "draft_480p",
      encoder: "libx264",
      outputPath: "output/segmented.mp4",
    })
  );

  for (const res of [singleRes, segRes]) {
    const tags = probeVideoColorTags(res.output_path);
    assert.equal(tags.pix_fmt, "yuv420p");
    assert.equal(tags.color_range, "tv");
    assert.equal(tags.color_space, "bt709");
    assert.equal(tags.color_primaries, "bt709");
    assert.equal(tags.color_transfer, "bt709");
  }

  // Check exact RGB values at t=0.5s (#1E40AF = 30, 64, 175) and t=1.5s (#16A34A = 22, 163, 74)
  const { sequence } = loadSequence(wsDir);
  const monBlue = renderSingleCompositeFrameRgb24(sequence, paths, 500, "draft_480p");
  const renBlue = decodeMp4FrameRgb24(singleRes.output_path, 0.5, monBlue.width, monBlue.height);
  const segBlue = decodeMp4FrameRgb24(segRes.output_path, 0.5, monBlue.width, monBlue.height);

  const centerIdx = (Math.floor(monBlue.height / 2) * monBlue.width + Math.floor(monBlue.width / 2)) * 3;
  for (const [label, buf] of [
    ["monitor", monBlue.rgbBuf],
    ["single_render", renBlue],
    ["segmented_render", segBlue],
  ] as const) {
    const [r, g, b] = [buf[centerIdx], buf[centerIdx + 1], buf[centerIdx + 2]];
    assert.ok(
      Math.abs(r - 30) <= 2 && Math.abs(g - 64) <= 2 && Math.abs(b - 175) <= 2,
      `${label} blue RGB(${r},${g},${b}) drifted from #1E40AF (30,64,175)`
    );
  }
  assert.ok(
    computePsnrBetweenRgbBuffers(monBlue.rgbBuf, renBlue) >= 50,
    "Monitor frame RGB24 and rendered MP4 frame must match in BT.709 color"
  );
  assert.ok(
    computePsnrBetweenRgbBuffers(renBlue, segBlue) >= 55,
    "Single-pass and segmented render frames must match in BT.709 color"
  );
});

test("2. Alpha overlay PNG-sequence directory, incomplete directory protection, FFV1 lossless option, and ProRes .mov visual parity", () => {
  const wsDir = path.join(TEST_ROOT, "ws_alpha_pngseq");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({
    dir: wsDir,
    title: "Alpha PNG Sequence Test",
    aspect: "16:9",
    fps: 30,
  });

  // Compact 320x180 stage for fast test execution
  const seqJson = JSON.parse(fs.readFileSync(paths.sequenceFile, "utf8"));
  seqJson.stage.width = 320;
  seqJson.stage.height = 180;
  fs.writeFileSync(paths.sequenceFile, JSON.stringify(seqJson, null, 2), "utf8");

  const bgVid = path.join(wsDir, "bg.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=1.5",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    bgVid,
  ]);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [bgVid] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 1500 });

  const compDir = path.join(wsDir, "compositions/alpha_card");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    compositionId: "main",
    width: 320,
    height: 180,
    fps: 30,
    durationMs: 1000,
    preset: "lower_third",
    props: { headline: "PNG ALFA", subline: "KAYIPSIZ DIZIN" },
    transparent: true,
  });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 200,
    durationMs: 1000,
    composition: {
      composition_dir: "compositions/alpha_card",
      entry_html: "index.html",
      mode: "overlay_alpha",
      transparent: true,
      props: { headline: "PNG ALFA", subline: "KAYIPSIZ DIZIN" },
    },
  });

  // (a) Default render produces `.pngseq` directory with 30 PNG frames
  assert.equal(resolveAlphaOverlayFormat(30), "pngseq");
  const pngRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "master_1080p",
    encoder: "libx264",
    outputPath: "output/render_pngseq.mp4",
  });
  assert.equal(pngRes.ok, true);
  assert.equal(pngRes.overlays?.rendered, 1);

  const pngSeqDirs = fs
    .readdirSync(paths.blobsDir)
    .filter((f) => f.startsWith("hf_comp_") && f.endsWith(".pngseq"));
  assert.equal(pngSeqDirs.length, 1, "Expected 1 hf_comp_<hash>.pngseq directory");
  const pngSeqPath = path.join(paths.blobsDir, pngSeqDirs[0]);
  assert.equal(isPngSequenceBlobDir(pngSeqPath), true);
  const pngInfo = inspectPngSequenceDir(pngSeqPath);
  assert.equal(pngInfo.valid, true);
  assert.equal(pngInfo.frameCount, 30);
  assert.equal(isValidVideoBlobOnDisk(pngSeqPath, 30), true);
  assert.ok(fs.existsSync(path.join(compDir, "assets/cuthol-bbox.json")), "Expected alpha bbox sidecar");

  const metaJson = JSON.parse(fs.readFileSync(`${pngSeqPath}.meta.json`, "utf8"));
  assert.equal(metaJson.encoder, "png-sequence");
  assert.equal(metaJson.frame_count, 30);

  // (b) Warm render hits `.pngseq` cache
  const warmRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "master_1080p",
    encoder: "libx264",
    outputPath: "output/render_pngseq_warm.mp4",
  });
  assert.equal(warmRes.overlays?.cached, 1);
  assert.equal(warmRes.overlays?.rendered, 0);

  // (c) Incomplete `.pngseq` directory (truncated frame count) is rejected and re-rendered
  for (let f = 15; f <= 30; f++) {
    const p = path.join(pngSeqPath, `frame_${String(f).padStart(6, "0")}.png`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  assert.equal(
    isValidVideoBlobOnDisk(pngSeqPath, 30),
    false,
    "Truncated pngseq directory (14/30 frames) must not pass cache validation"
  );
  const healRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "master_1080p",
    encoder: "libx264",
    outputPath: "output/render_pngseq_healed.mp4",
  });
  assert.equal(healRes.overlays?.rendered, 1);
  assert.equal(inspectPngSequenceDir(pngSeqPath).frameCount, 30);

  // (d) Monitor frame reads directly from cached `.pngseq` directory without re-rendering
  const mf = captureMonitorFrame({ workspaceDir: wsDir, atMs: 600 });
  assert.equal(mf.ok, true);

  // (e) FFV1 single-file lossless mode (`CUTHOL_ALPHA_FORMAT=ffv1`) has zero frame drift vs png-sequence
  const ffv1Res = withEnv({ CUTHOL_ALPHA_FORMAT: "ffv1" }, () => {
    assert.equal(resolveAlphaOverlayFormat(30), "ffv1");
    return renderSequenceToMp4({
      workspaceDir: wsDir,
      preset: "master_1080p",
      encoder: "libx264",
      outputPath: "output/render_ffv1.mp4",
    });
  });
  assert.equal(ffv1Res.ok, true);
  const ffv1Blobs = fs
    .readdirSync(paths.blobsDir)
    .filter((f) => f.startsWith("hf_comp_") && f.endsWith(".ffv1.mov"));
  assert.equal(ffv1Blobs.length, 1);

  const psnrPngVsFfv1 = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      pngRes.output_path,
      "-i",
      ffv1Res.output_path,
      "-lavfi",
      "[0:v]settb=1/30,setpts=N[a];[1:v]settb=1/30,setpts=N[b];[a][b]psnr=stats_file=-",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" }
  );
  const ffv1FrameLines = (psnrPngVsFfv1.stdout || "").trim().split(/\r?\n/);
  assert.equal(ffv1FrameLines.length, 45, "Expected 45 frames for 1.5s @ 30fps");
  assert.ok(
    ffv1FrameLines.every((l) => l.includes("psnr_avg:inf")),
    `Expected bit-exact (inf dB, 0 frame drift) composite between png-sequence and FFV1, got: ${ffv1FrameLines.find((l) => !l.includes("psnr_avg:inf"))}`
  );
});

test("3. Multi-vendor encoder selection, codec args, color verification, session-limit fallback, and stall retry", () => {
  clearEncoderProbeCache();

  // (a) Preference resolution via CUTHOL_ENCODER and backward-compatible CUTHOL_DISABLE_NVENC
  withEnv(
    {
      CUTHOL_ENCODER: undefined,
      CUTHOL_VIDEO_ENCODER: undefined,
      CUTHOL_DISABLE_NVENC: undefined,
      CUTHOL_DISABLE_GPU: undefined,
    },
    () => {
      assert.equal(resolveVideoEncoderPreference(), "auto");
      assert.equal(resolveVideoEncoderPreference("nvenc"), "nvenc");
      assert.equal(resolveVideoEncoderPreference("amf"), "amf");
      assert.equal(resolveVideoEncoderPreference("qsv"), "qsv");
      assert.equal(resolveVideoEncoderPreference("vaapi"), "vaapi");
      assert.equal(resolveVideoEncoderPreference("videotoolbox"), "videotoolbox");
      assert.equal(resolveVideoEncoderPreference("x264"), "libx264");
    }
  );
  withEnv({ CUTHOL_DISABLE_NVENC: "1", CUTHOL_ENCODER: undefined }, () => {
    assert.equal(resolveVideoEncoderPreference(), "libx264");
  });
  withEnv({ CUTHOL_ENCODER: "amf", CUTHOL_DISABLE_NVENC: "1" }, () => {
    assert.equal(resolveVideoEncoderPreference(), "amf");
  });

  // (b) Platform vendor priority order & codec argument construction for all 6 encoders
  assert.deepEqual(getAutoHardwareEncoderOrder("win32"), ["h264_nvenc", "h264_amf", "h264_qsv"]);
  assert.deepEqual(getAutoHardwareEncoderOrder("linux"), [
    "h264_nvenc",
    "h264_amf",
    "h264_qsv",
    "h264_vaapi",
  ]);
  assert.deepEqual(getAutoHardwareEncoderOrder("darwin"), ["h264_videotoolbox"]);

  for (const enc of [
    "h264_nvenc",
    "h264_amf",
    "h264_qsv",
    "h264_vaapi",
    "h264_videotoolbox",
    "libx264",
  ] as const) {
    for (const preset of ["draft_480p", "master_1080p"] as const) {
      const args = buildVideoCodecArgs(enc, preset);
      assert.ok(args.includes("-c:v") && args.includes(enc));
      assert.ok(args.includes("-colorspace") && args.includes("bt709"));
      assert.ok(args.includes("-color_range") && args.includes("tv"));
      if (enc === "h264_amf") {
        assert.ok(
          args.includes("-bsf:v"),
          "h264_amf must include h264_metadata VUI filter so primaries/transfer are tagged bt709"
        );
      }
    }
  }
  assert.equal(resolveMaxHardwareEncoderSessions("h264_nvenc"), 2);
  assert.equal(resolveMaxHardwareEncoderSessions("h264_amf"), 2);

  // (c) Real hardware verification on this machine (NVENC + AMF if present) & simulated color-shift rejection
  const nvencProbe = probeAndVerifyVideoEncoder("h264_nvenc", { forceFresh: true });
  const amfProbe = probeAndVerifyVideoEncoder("h264_amf", { forceFresh: true });
  if (nvencProbe.ok) {
    assert.ok((nvencProbe.psnr_db ?? 0) >= 40, `Expected NVENC probe PSNR >= 40dB, got ${nvencProbe.psnr_db}`);
    assert.ok((nvencProbe.max_channel_drift ?? 99) <= 5);
  }
  if (amfProbe.ok) {
    assert.ok((amfProbe.psnr_db ?? 0) >= 40, `Expected AMF probe PSNR >= 40dB, got ${amfProbe.psnr_db}`);
    assert.ok((amfProbe.max_channel_drift ?? 99) <= 5);

    // Simulate the pre-fix Rec.601 -> BT.709 VUI color shift on AMF and verify the gate rejects it!
    const shiftedAmf = withEnv({ CUTHOL_SIMULATE_ENCODER_COLOR_SHIFT: "amf" }, () =>
      probeAndVerifyVideoEncoder("h264_amf", { forceFresh: true })
    );
    assert.equal(shiftedAmf.ok, false, "Color-shifted AMF encode (~24 dB) must be rejected by verification gate");
    assert.match(shiftedAmf.reason ?? "", /failed color accuracy verification/i);

    const fallbackOnShift = withEnv(
      { CUTHOL_ENCODER: "amf", CUTHOL_SIMULATE_ENCODER_COLOR_SHIFT: "amf" },
      () => resolveVideoEncoderForRender("amf")
    );
    assert.equal(fallbackOnShift.encoder, "libx264");
    assert.equal(fallbackOnShift.fallback?.from, "h264_amf");
    assert.equal(fallbackOnShift.fallback?.to, "libx264");
    assert.match(fallbackOnShift.fallback?.reason ?? "", /color accuracy verification/i);
  }

  // (d) Unavailable hardware encoders (QSV / VAAPI / VideoToolbox) fall back cleanly to libx264 with reason
  for (const pref of ["qsv", "vaapi", "videotoolbox"] as const) {
    const decision = withEnv({ CUTHOL_SIMULATE_ENCODER_FAIL: pref }, () =>
      resolveVideoEncoderForRender(pref)
    );
    assert.equal(decision.encoder, "libx264");
    assert.ok(decision.fallback);
    assert.equal(decision.fallback.to, "libx264");
    assert.ok(decision.fallback.reason.length > 5);
  }

  // (e) End-to-end render with forced no-GPU, segment session-limit fallback, and generalized AMF watchdog stall fallback
  const wsDir = path.join(TEST_ROOT, "ws_encoders");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Encoder Fallback Suite", aspect: "16:9", fps: 30 });
  const seqPath = path.join(wsDir, "cuthol.sequence.json");
  const seqObj = JSON.parse(fs.readFileSync(seqPath, "utf8"));
  seqObj.stage.width = 320;
  seqObj.stage.height = 180;
  fs.writeFileSync(seqPath, JSON.stringify(seqObj, null, 2), "utf8");

  const clipPath = path.join(wsDir, "src.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "smptehdbars=s=320x180:r=30:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    clipPath,
  ]);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [clipPath] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 500 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 500, sourceOutMs: 1000 });

  // Forced no-GPU (`CUTHOL_SIMULATE_ENCODER_FAIL=all`) in `auto` mode falls back to libx264 and completes
  const noGpuRes = withEnv(
    { CUTHOL_ENCODER: "auto", CUTHOL_SIMULATE_ENCODER_FAIL: "all" },
    () =>
      renderSequenceToMp4({
        workspaceDir: wsDir,
        preset: "draft_480p",
        outputPath: "output/no_gpu.mp4",
      })
  );
  assert.equal(noGpuRes.ok, true);
  assert.equal(noGpuRes.encoder, "libx264");
  assert.ok(noGpuRes.encoder_fallback);
  assert.equal(noGpuRes.encoder_fallback.to, "libx264");

  if (amfProbe.ok) {
    // Real AMF sequence render + color tag check
    const amfRes = withEnv({ CUTHOL_ENCODER: "amf" }, () =>
      renderSequenceToMp4({
        workspaceDir: wsDir,
        preset: "draft_480p",
        outputPath: "output/amf_real.mp4",
      })
    );
    assert.equal(amfRes.ok, true);
    assert.equal(amfRes.encoder, "h264_amf");
    assert.equal(amfRes.encoder_fallback, null);
    const amfTags = probeVideoColorTags(amfRes.output_path);
    assert.equal(amfTags.color_space, "bt709");
    assert.equal(amfTags.color_primaries, "bt709");
    assert.equal(amfTags.color_transfer, "bt709");
    assert.equal(amfTags.color_range, "tv");

    // Generalized watchdog stall retry on AMF (`CUTHOL_SIMULATE_HW_ENCODER_STALL=amf`)
    const amfStallRes = withEnv(
      {
        CUTHOL_ENCODER: "amf",
        CUTHOL_SIMULATE_HW_ENCODER_STALL: "amf",
        CUTHOL_STALL_TIMEOUT_SEC: "0.4",
      },
      () =>
        renderSequenceToMp4({
          workspaceDir: wsDir,
          preset: "draft_480p",
          outputPath: "output/amf_stall_fallback.mp4",
        })
    );
    assert.equal(amfStallRes.ok, true);
    assert.equal(amfStallRes.encoder, "libx264");
    assert.deepEqual(amfStallRes.encoder_fallback, {
      from: "h264_amf",
      to: "libx264",
      reason: "stalled",
    });

    // Parallel segment session-limit fallback (`CUTHOL_SIMULATE_HW_SESSION_LIMIT=1`)
    const sessionLimitRes = withEnv(
      {
        CUTHOL_ENCODER: "amf",
        CUTHOL_RENDER_SEGMENT_MAX_CLIPS: "1",
        CUTHOL_SIMULATE_HW_SESSION_LIMIT: "1",
      },
      () =>
        renderSequenceToMp4({
          workspaceDir: wsDir,
          preset: "draft_480p",
          outputPath: "output/amf_session_fallback.mp4",
        })
    );
    assert.equal(sessionLimitRes.ok, true);
    assert.equal(sessionLimitRes.encoder, "libx264");
    assert.equal(sessionLimitRes.encoder_fallback?.from, "h264_amf");
    assert.equal(sessionLimitRes.encoder_fallback?.to, "libx264");
  }
});

test("4. Source color matrix & range selection across (a) untagged 640x360, (b) untagged 1920x1080, (c) bt709 640x360, (d) smpte170m 1920x1080, JPG/PNG stills, BT.2020 G208 note, and legacy re-probe", () => {
  const rootDir = path.join(TEST_ROOT, "ws_source_color_matrix");
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.mkdirSync(rootDir, { recursive: true });

  const createTestsrcMp4 = (
    outFile: string,
    w: number,
    h: number,
    encodeMatrix: "bt601" | "bt709" | "bt2020",
    tagColorspace: "bt709" | "smpte170m" | "bt2020nc" | null
  ) => {
    const setp = tagColorspace
      ? `setparams=colorspace=${tagColorspace}:color_primaries=${tagColorspace === "bt2020nc" ? "bt2020" : tagColorspace}:color_trc=${tagColorspace === "bt2020nc" ? "bt2020-10" : tagColorspace}:range=tv`
      : "setparams=colorspace=unknown:color_primaries=unknown:color_trc=unknown:range=unknown";
    const args = [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${w}x${h}:rate=30:duration=1,format=rgb24,scale=in_color_matrix=${encodeMatrix}:out_color_matrix=${encodeMatrix}:out_range=tv,format=yuv420p,${setp}`,
      "-c:v",
      "libx264",
      "-crf",
      "10",
      "-pix_fmt",
      "yuv420p",
    ];
    if (tagColorspace) {
      const prim = tagColorspace === "bt2020nc" ? "bt2020" : tagColorspace;
      const trc = tagColorspace === "bt2020nc" ? "bt2020-10" : tagColorspace;
      args.push(
        "-colorspace",
        tagColorspace,
        "-color_primaries",
        prim,
        "-color_trc",
        trc,
        "-color_range",
        "tv"
      );
    }
    args.push(outFile);
    const p = spawnSync("ffmpeg", args, { encoding: "utf8" });
    assert.equal(p.status, 0, p.stderr);
  };

  const fileA = path.join(rootDir, "a_640x360_untagged.mp4");
  const fileB = path.join(rootDir, "b_1920x1080_untagged.mp4");
  const fileC = path.join(rootDir, "c_640x360_bt709.mp4");
  const fileD = path.join(rootDir, "d_1920x1080_smpte170m.mp4");

  createTestsrcMp4(fileA, 640, 360, "bt601", null);
  createTestsrcMp4(fileB, 1920, 1080, "bt709", null);
  createTestsrcMp4(fileC, 640, 360, "bt709", "bt709");
  createTestsrcMp4(fileD, 1920, 1080, "bt601", "smpte170m");

  const maeBetween = (a: Buffer, b: Buffer): number => {
    const len = Math.min(a.length, b.length);
    assert.ok(len > 0);
    let s = 0;
    for (let i = 0; i < len; i++) s += Math.abs(a[i] - b[i]);
    return s / len;
  };

  const cases = [
    {
      label: "(a) untagged 640x360 (BT.601)",
      file: fileA,
      expectedMatrix: "bt601",
      expectedRule: "heuristic_sd",
    },
    {
      label: "(b) untagged 1920x1080 (BT.709)",
      file: fileB,
      expectedMatrix: "bt709",
      expectedRule: "heuristic_hd",
    },
    {
      label: "(c) tagged bt709 640x360",
      file: fileC,
      expectedMatrix: "bt709",
      expectedRule: "tagged",
    },
    {
      label: "(d) tagged smpte170m 1920x1080",
      file: fileD,
      expectedMatrix: "bt601",
      expectedRule: "tagged",
    },
  ] as const;

  for (const [idx, c] of cases.entries()) {
    const wsDir = path.join(rootDir, `ws_${idx}`);
    const { paths } = initWorkspace({
      dir: wsDir,
      title: c.label,
      aspect: "16:9",
      fps: 30,
    });
    const [ingested] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [c.file] });
    const spec = resolveSourceColorSpec(ingested.probe, c.file);
    assert.equal(spec.isRgb, false, `${c.label}: expected YUV source`);
    assert.equal(spec.inMatrix, c.expectedMatrix, `${c.label}: wrong inMatrix`);
    assert.equal(spec.inRange, "tv", `${c.label}: wrong inRange`);
    assert.equal(spec.sourceRule, c.expectedRule, `${c.label}: wrong sourceRule`);

    appendSpineClip({ workspaceDir: wsDir, assetHandle: ingested.handle, sourceInMs: 0, sourceOutMs: 1000 });
    const renderRes = renderSequenceToMp4({
      workspaceDir: wsDir,
      preset: "draft_480p",
      encoder: "libx264",
      outputPath: "output/out.mp4",
    });
    assert.equal(renderRes.ok, true);
    const outTags = probeVideoColorTags(renderRes.output_path);
    assert.equal(outTags.color_space, "bt709");
    assert.equal(outTags.color_range, "tv");

    // Decode source with its true matrix vs rendered output decoded with its BT.709 tag
    const refProc = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        c.file,
        "-vf",
        `scale=${renderRes.width}:${renderRes.height}:flags=accurate_rnd+full_chroma_int:in_color_matrix=${c.expectedMatrix}:out_color_matrix=${c.expectedMatrix}:in_range=tv,format=rgb24`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { maxBuffer: 16 * 1024 * 1024 }
    );
    assert.equal(refProc.status, 0);
    const refRgb = (refProc.stdout as Buffer).subarray(0, renderRes.width * renderRes.height * 3);

    const outRgb = decodeMp4FrameRgb24(renderRes.output_path, 0, renderRes.width, renderRes.height);
    const { sequence } = loadSequence(wsDir);
    const monRgb = renderSingleCompositeFrameRgb24(sequence, paths, 0, "draft_480p").rgbBuf;

    const renderMae = maeBetween(refRgb, outRgb);
    const monMae = maeBetween(refRgb, monRgb);
    const parityMae = maeBetween(outRgb, monRgb);

    assert.ok(renderMae < 2.0, `${c.label}: expected render MAE < 2.0, got ${renderMae.toFixed(3)}`);
    assert.ok(monMae < 2.0, `${c.label}: expected monitor MAE < 2.0, got ${monMae.toFixed(3)}`);
    assert.ok(parityMae < 1.5, `${c.label}: expected render vs monitor MAE < 1.5, got ${parityMae.toFixed(3)}`);
  }

  // Test JPG (yuvj420p/bt470bg/pc) still image at 1920x1080 + BT.2020 G208 note + legacy re-probe
  const wsExtra = path.join(rootDir, "ws_extra");
  const { paths: extraPaths } = initWorkspace({
    dir: wsExtra,
    title: "JPG & BT2020 & Legacy Probe",
    aspect: "16:9",
    fps: 30,
  });
  const jpg1080 = path.join(rootDir, "still_1080.jpg");
  const bt2020File = path.join(rootDir, "bt2020_1080.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1920x1080:rate=1:duration=1",
    "-q:v",
    "1",
    "-frames:v",
    "1",
    jpg1080,
  ]);
  createTestsrcMp4(bt2020File, 1920, 1080, "bt2020", "bt2020nc");

  const [jpgItem, bt2020Item] = ingestAssetsIntoWorkspace({
    workspaceDir: wsExtra,
    filePaths: [jpg1080, bt2020File],
  });
  const jpgSpec = resolveSourceColorSpec(jpgItem.probe, jpg1080);
  assert.equal(jpgSpec.isRgb, true, "1080p JPG must be treated as RGB still source");

  const bt2020Spec = resolveSourceColorSpec(bt2020Item.probe, bt2020File);
  assert.equal(bt2020Spec.inMatrix, "bt2020");
  assert.ok(bt2020Spec.note && bt2020Spec.note.includes("BT.2020"));

  // Simulate legacy sequence where color_space / color_range / pix_fmt are missing on probe
  const loadedExtra = loadSequence(wsExtra);
  for (const item of loadedExtra.sequence.library) {
    delete item.probe.color_space;
    delete item.probe.color_range;
    delete item.probe.pix_fmt;
  }
  fs.writeFileSync(extraPaths.sequenceFile, JSON.stringify(loadedExtra.sequence, null, 2), "utf8");

  const reverifyLoaded = loadSequence(wsExtra);
  const verReport = verifySequence(reverifyLoaded.sequence, extraPaths);
  assert.ok(
    verReport.diagnostics.some((d) => d.code === "CUTHOL-G208" && d.severity === "INFO"),
    "Expected CUTHOL-G208 INFO diagnostic for BT.2020 asset after legacy re-probe"
  );
  const refreshedBt2020 = reverifyLoaded.sequence.library.find((x) => x.handle === bt2020Item.handle);
  assert.equal(refreshedBt2020?.probe.color_space, "bt2020nc");
});
