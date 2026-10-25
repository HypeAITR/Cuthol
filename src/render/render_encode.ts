// Single-segment and multi-segment FFmpeg encoding, watchdog fallback, and audio/video muxing (split out of render_main.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { progressBegin, progressFinish } from "../core/progress.js";
import {
  type ParallelFfmpegJob,
  type ParallelFfmpegJobResult,
  spawnWatchedSync,
} from "../core/subprocess.js";
import {
  CompiledRenderPlan,
  compileSequenceRenderPlan,
  RenderPreset,
} from "../compositor/compiler.js";
import {
  BT709_COLOR_OUTPUT_ARGS,
  buildVideoCodecArgs,
  H264_BT709_VUI_BSF,
  isHardwareEncoder,
  type RenderEncoderFallback,
  resolveMaxHardwareEncoderSessions,
  type VideoEncoderCodec,
} from "./encoder.js";
import {
  createSubprocessFailureDiagnostic,
  CutholError,
  estimateCommandLineLength,
} from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { VerificationReport } from "../verify/gates.js";
import { runParallelFfmpegJobsSync } from "./render_frames.js";
import {
  SegmentedAudioBuildResult,
  buildOrRenderSequenceAudioForMixOrRender,
  RenderTimeSegment,
  escapeConcatFilePath,
} from "./render_segments.js";

export interface PreparedSequenceRender {
  tTotal0: number;
  paths: WorkspacePaths;
  sequence: CutholSequence;
  verification: VerificationReport;
  verifyMs: number;
  preset: RenderPreset;
  workers: number;
  activeEncoder: VideoEncoderCodec;
  encoderFallback: RenderEncoderFallback | null;
  resolvedOut: string;
  tmpOut: string;
  totalDurationMs: number;
  maxItemsPerSegment: number;
  segments: RenderTimeSegment[];
  overlayPrepassMs: number;
}

export interface RenderEncodeStageResult {
  compileAndOverlaysMs: number;
  encodeMs: number;
  singleStageUsed: boolean;
  renderWidth: number;
  renderHeight: number;
  fps: number;
  activeEncoder: VideoEncoderCodec;
  encoderFallback: RenderEncoderFallback | null;
}

interface VideoSegTask {
  seg: RenderTimeSegment;
  plan: CompiledRenderPlan;
  mp4Path: string;
  tmpMp4Path: string;
  filterPath: string;
  ffArgs: string[];
  needsEncode: boolean;
}

function buildSingleSegmentFfmpegArgs(params: {
  plan: CompiledRenderPlan;
  directBlobAudioBuild: SegmentedAudioBuildResult | null;
  filterScriptPath: string;
  preset: RenderPreset;
  tmpOut: string;
  encoder: VideoEncoderCodec;
  useStreamCopy: boolean;
}): string[] {
  const {
    plan,
    directBlobAudioBuild,
    filterScriptPath,
    preset,
    tmpOut,
    encoder,
    useStreamCopy,
  } = params;
  const vaapiDeviceArgs =
    !useStreamCopy && encoder === "h264_vaapi"
      ? ["-vaapi_device", process.env.CUTHOL_VAAPI_DEVICE || "/dev/dri/renderD128"]
      : [];
  if (plan.directVideoBlobPath && directBlobAudioBuild) {
    const audioInputArgs =
      directBlobAudioBuild.mode === "direct_plan"
        ? directBlobAudioBuild.directPlan!.inputArgs
        : ["-f", "concat", "-safe", "0", "-i", directBlobAudioBuild.concatListPath!];
    const audioFilter =
      directBlobAudioBuild.mode === "direct_plan"
        ? directBlobAudioBuild.directPlan!.filterComplex
        : directBlobAudioBuild.masterFilterComplex!;
    const useScript = audioFilter.length > 4000;
    if (useScript) {
      fs.writeFileSync(filterScriptPath, audioFilter, "utf8");
    }
    return [
      "-y",
      "-v",
      "error",
      ...vaapiDeviceArgs,
      "-i",
      plan.directVideoBlobPath,
      ...audioInputArgs,
      ...(useScript ? ["-/filter_complex", filterScriptPath] : ["-filter_complex", audioFilter]),
      "-map",
      "0:v:0",
      "-map",
      directBlobAudioBuild.audioOutPad,
      "-t",
      (plan.totalDurationMs / 1000).toFixed(3),
      ...(useStreamCopy
        ? ["-c:v", "copy", ...BT709_COLOR_OUTPUT_ARGS, "-bsf:v", H264_BT709_VUI_BSF]
        : buildVideoCodecArgs(encoder, preset)),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      tmpOut,
    ];
  }

  const effectiveFilterComplex =
    encoder === "h264_vaapi"
      ? `${plan.filterComplex};${plan.videoOutPad}format=nv12,hwupload[vout_vaapi]`
      : plan.filterComplex;
  const effectiveVideoOutPad =
    encoder === "h264_vaapi" ? "[vout_vaapi]" : plan.videoOutPad;

  const useScript =
    effectiveFilterComplex.length > 4000 ||
    estimateCommandLineLength("ffmpeg", plan.inputArgs) + effectiveFilterComplex.length > 12000;
  if (useScript) {
    fs.writeFileSync(filterScriptPath, effectiveFilterComplex, "utf8");
  }
  return [
    "-y",
    "-v",
    "error",
    ...vaapiDeviceArgs,
    ...plan.inputArgs,
    ...(useScript
      ? ["-/filter_complex", filterScriptPath]
      : ["-filter_complex", effectiveFilterComplex]),
    "-map",
    effectiveVideoOutPad,
    "-map",
    plan.audioOutPad,
    "-t",
    (plan.totalDurationMs / 1000).toFixed(3),
    ...buildVideoCodecArgs(encoder, preset),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    tmpOut,
  ];
}

export function renderSingleSegmentPath(prep: PreparedSequenceRender): RenderEncodeStageResult {
  const {
    paths,
    sequence,
    preset,
    workers,
    tmpOut,
    maxItemsPerSegment,
    overlayPrepassMs,
  } = prep;
  let { activeEncoder, encoderFallback } = prep;

  const tCompile0 = Date.now();
  // A composition that cannot be rendered throws CUTHOL-G503 from the compiler; nothing is substituted.
  // NVENC is used for Cuthol's own composite encode only; HyperFrames encodes overlays on the CPU
  // (its GPU encode is not faster here and its rate control cannot be set from outside).
  const plan = compileSequenceRenderPlan(sequence, paths, preset, { workers });
  const compileAndOverlaysMs = Date.now() - tCompile0 + overlayPrepassMs;
  const renderWidth = plan.renderWidth;
  const renderHeight = plan.renderHeight;
  const fps = plan.fps;

  let canRemuxDirectBlob = false;
  let directBlobAudioBuild: SegmentedAudioBuildResult | null = null;
  if (plan.directVideoBlobPath && fs.existsSync(plan.directVideoBlobPath)) {
    let blobEncoder: VideoEncoderCodec | null = null;
    let blobFallbackReason: string | null = null;
    let blobMatchesTargetRes = true;
    const metaPath = `${plan.directVideoBlobPath}.meta.json`;
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (meta.encoder === "h264_nvenc" || meta.encoder === "libx264") {
          blobEncoder = meta.encoder;
        }
        if (typeof meta.gpu_fallback_reason === "string" && meta.gpu_fallback_reason) {
          blobFallbackReason = meta.gpu_fallback_reason;
        }
        if (
          typeof meta.width === "number" &&
          typeof meta.height === "number" &&
          (meta.width !== renderWidth || meta.height !== renderHeight)
        ) {
          blobMatchesTargetRes = false;
        }
      } catch {
        // ignore metadata parse error
      }
    }
    if (!blobMatchesTargetRes) {
      plan.directVideoBlobPath = undefined;
    } else {
      if (blobFallbackReason && isHardwareEncoder(activeEncoder)) {
        const prevEnc = activeEncoder;
        activeEncoder = "libx264";
        encoderFallback = { from: prevEnc, to: "libx264", reason: blobFallbackReason };
      }
      directBlobAudioBuild = buildOrRenderSequenceAudioForMixOrRender(
        sequence,
        paths,
        sequence.stage.master_audio,
        { inputIndexOffset: 1, maxItemsPerSegment }
      );
      // The overlay blob already holds the final picture: copy its stream and report the encoder that made it.
      canRemuxDirectBlob = true;
      if (blobEncoder && blobEncoder !== activeEncoder) {
        activeEncoder = blobEncoder;
        encoderFallback = null;
      }
    }
  }

  const filterScriptPath = `${tmpOut}.filter.txt`;
  const buildRenderFfmpegArgs = (
    encoder: VideoEncoderCodec,
    useStreamCopy: boolean
  ): string[] =>
    buildSingleSegmentFfmpegArgs({
      plan,
      directBlobAudioBuild,
      filterScriptPath,
      preset,
      tmpOut,
      encoder,
      useStreamCopy,
    });

  progressFinish("overlay");
  const encodeFrames = Math.max(1, Math.round((prep.totalDurationMs / 1000) * fps));
  progressBegin("encode", encodeFrames, { mode: "ffmpeg-frames" });

  const tEncode0 = Date.now();
  let singleStageUsed = canRemuxDirectBlob;
  let encodeMs = 0;
  let ffArgs: string[] = buildRenderFfmpegArgs(activeEncoder, singleStageUsed);

  try {
    const proc = spawnWatchedSync("ffmpeg", ffArgs, {
      cwd: paths.rootDir,
      encoding: "utf8",
      // No wall-clock limit: a full render scales with sequence length (long videos take hours).
      maxBuffer: 256 * 1024 * 1024,
      step: "ffmpeg render",
      watchedPaths: [tmpOut],
      cleanupPathsOnStall: [tmpOut],
    });

    let finalProc = proc;
    const usedHwOnFirstAttempt = isHardwareEncoder(activeEncoder) && !singleStageUsed;
    const canFallbackOnStall = Boolean(finalProc.stalled && usedHwOnFirstAttempt);
    const canFallbackOnEncodeFailure =
      !finalProc.stalled &&
      !finalProc.error &&
      (isHardwareEncoder(activeEncoder) || singleStageUsed);

    if (
      (finalProc.status !== 0 || finalProc.error || !fs.existsSync(tmpOut)) &&
      (canFallbackOnStall || canFallbackOnEncodeFailure)
    ) {
      if (fs.existsSync(tmpOut)) {
        try {
          fs.unlinkSync(tmpOut);
        } catch {
          // ignore
        }
      }
      const errDetail = (finalProc.stderr || finalProc.stdout || `${activeEncoder} encode failed`)
        .trim()
        .slice(-240);
      if (isHardwareEncoder(activeEncoder)) {
        const prevEncoder = activeEncoder;
        activeEncoder = "libx264";
        encoderFallback = {
          from: prevEncoder,
          to: "libx264",
          reason: finalProc.stalled
            ? "stalled"
            : `${prevEncoder} failed at encode time (${errDetail}); fell back to libx264`,
        };
      }
      singleStageUsed = false;
      ffArgs = buildRenderFfmpegArgs("libx264", false);
      finalProc = spawnWatchedSync("ffmpeg", ffArgs, {
        cwd: paths.rootDir,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        step: "ffmpeg render",
        watchedPaths: [tmpOut],
        cleanupPathsOnStall: [tmpOut],
      });
    }
    encodeMs = Date.now() - tEncode0;

    if (finalProc.status !== 0 || finalProc.error || !fs.existsSync(tmpOut)) {
      if (fs.existsSync(tmpOut)) {
        try {
          fs.unlinkSync(tmpOut);
        } catch {
          // ignore cleanup error
        }
      }
      throw new CutholError(
        createSubprocessFailureDiagnostic({
          tool: "ffmpeg render",
          executable: "ffmpeg",
          args: ffArgs,
          proc: finalProc,
          clipCount: sequence.spine.clips.length,
          fallbackDetail: "render failed",
        })
      );
    }
  } finally {
    progressFinish("encode");
    if (fs.existsSync(filterScriptPath)) {
      try {
        fs.unlinkSync(filterScriptPath);
      } catch {
        // ignore
      }
    }
  }

  return {
    compileAndOverlaysMs,
    encodeMs,
    singleStageUsed,
    renderWidth,
    renderHeight,
    fps,
    activeEncoder,
    encoderFallback,
  };
}

function buildSegTaskForEncoder(params: {
  seg: RenderTimeSegment;
  segPlan: CompiledRenderPlan;
  segEncoder: VideoEncoderCodec;
  libDigests: string[];
  preset: RenderPreset;
  blobsDir: string;
}): VideoSegTask {
  const { seg, segPlan, segEncoder, libDigests, preset, blobsDir } = params;
  const effectiveFilter =
    segEncoder === "h264_vaapi"
      ? `${segPlan.filterComplex};${segPlan.videoOutPad}format=nv12,hwupload[vout_vaapi]`
      : segPlan.filterComplex;
  const effectiveOutPad =
    segEncoder === "h264_vaapi" ? "[vout_vaapi]" : segPlan.videoOutPad;
  const vaapiArgs =
    segEncoder === "h264_vaapi"
      ? ["-vaapi_device", process.env.CUTHOL_VAAPI_DEVICE || "/dev/dri/renderD128"]
      : [];

  const vHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        libDigests,
        preset,
        encoder: segEncoder,
        w: segPlan.renderWidth,
        h: segPlan.renderHeight,
        fps: segPlan.fps,
        frameCount: seg.frameCount,
        inputArgs: segPlan.inputArgs,
        filterComplex: effectiveFilter,
      })
    )
    .digest("hex")
    .slice(0, 16);

  const mp4Path = path.join(blobsDir, `vseg_${vHash}.mp4`);
  const tmpMp4Path = `${mp4Path}.${process.pid}.${seg.index}.tmp.mp4`;
  const filterPath = `${mp4Path}.${process.pid}.${seg.index}.filter.txt`;
  const ffArgs = [
    "-y",
    "-v",
    "error",
    ...vaapiArgs,
    ...segPlan.inputArgs,
    "-/filter_complex",
    filterPath,
    "-map",
    effectiveOutPad,
    "-frames:v",
    String(seg.frameCount),
    "-r",
    String(segPlan.fps),
    "-fps_mode",
    "cfr",
    "-an",
    ...buildVideoCodecArgs(segEncoder, preset),
    tmpMp4Path,
  ];
  const cached = fs.existsSync(mp4Path) && fs.statSync(mp4Path).size > 500;
  return {
    seg,
    plan: { ...segPlan, filterComplex: effectiveFilter },
    mp4Path,
    tmpMp4Path,
    filterPath,
    ffArgs,
    needsEncode: !cached,
  };
}

function encodeVideoSegmentsWithEncoder(params: {
  encoder: VideoEncoderCodec;
  segmentVideoPlans: Array<{ seg: RenderTimeSegment; plan: CompiledRenderPlan }>;
  libDigests: string[];
  preset: RenderPreset;
  paths: WorkspacePaths;
}): {
  ok: boolean;
  segMp4Paths: string[];
  firstFailure?: ParallelFfmpegJobResult;
  failedArgs?: string[];
  segmentFallbackReason?: string;
} {
  const { encoder, segmentVideoPlans, libDigests, preset, paths } = params;

  const vTasks: VideoSegTask[] = segmentVideoPlans.map(({ seg, plan: segPlan }) =>
    buildSegTaskForEncoder({
      seg,
      segPlan,
      segEncoder: encoder,
      libDigests,
      preset,
      blobsDir: paths.blobsDir,
    })
  );

  const pending = vTasks.filter((t) => t.needsEncode);
  let segmentFallbackReason: string | undefined;

  if (pending.length > 0) {
    for (const t of pending) {
      fs.writeFileSync(t.filterPath, t.plan.filterComplex, "utf8");
    }
    try {
      const concurrency = resolveMaxHardwareEncoderSessions(encoder);
      const jobs: ParallelFfmpegJob[] = pending.map((t) => ({
        args: t.ffArgs,
        cwd: paths.rootDir,
        step: "ffmpeg render segment",
        watchedPaths: [t.tmpMp4Path],
        cleanupPathsOnStall: [t.tmpMp4Path],
      }));
      const results = runParallelFfmpegJobsSync(
        jobs,
        pending.map(() => 32 * 1024 * 1024),
        concurrency
      );

      const failedIndices: number[] = [];
      for (let i = 0; i < pending.length; i++) {
        const t = pending[i];
        const r = results[i];
        const simSessionFail =
          isHardwareEncoder(encoder) &&
          process.env.CUTHOL_SIMULATE_HW_SESSION_LIMIT === "1" &&
          i >= 1;
        if (simSessionFail || !r || r.status !== 0 || r.error || !fs.existsSync(t.tmpMp4Path)) {
          if (fs.existsSync(t.tmpMp4Path)) {
            try {
              fs.unlinkSync(t.tmpMp4Path);
            } catch {
              // ignore
            }
          }
          failedIndices.push(i);
        } else {
          fs.renameSync(t.tmpMp4Path, t.mp4Path);
        }
      }

      if (failedIndices.length > 0) {
        const firstIdx = failedIndices[0];
        const firstFailRes = results[firstIdx];
        if (isHardwareEncoder(encoder) && (!firstFailRes?.error || firstFailRes?.stalled)) {
          // Retry only the failed segment(s) with libx264 (handles GPU session limit or hardware stall)
          const errDetail = (
            firstFailRes?.stderr || `${encoder} hardware session limit or segment encode failure`
          )
            .trim()
            .slice(-200);
          segmentFallbackReason = firstFailRes?.stalled
            ? "stalled"
            : `${encoder} segment encode failed (${errDetail}); retried failed segment(s) with libx264`;

          const fallbackTasks = failedIndices.map((idx) => {
            const orig = pending[idx];
            return {
              orig,
              fb: buildSegTaskForEncoder({
                seg: orig.seg,
                segPlan: segmentVideoPlans[orig.seg.index].plan,
                segEncoder: "libx264",
                libDigests,
                preset,
                blobsDir: paths.blobsDir,
              }),
            };
          });

          for (const { fb } of fallbackTasks) {
            if (fb.needsEncode) {
              fs.writeFileSync(fb.filterPath, fb.plan.filterComplex, "utf8");
            }
          }
          try {
            const fbPending = fallbackTasks.filter((x) => x.fb.needsEncode);
            if (fbPending.length > 0) {
              const fbResults = runParallelFfmpegJobsSync(
                fbPending.map(({ fb }) => ({
                  args: fb.ffArgs,
                  cwd: paths.rootDir,
                  step: "ffmpeg render segment (libx264 fallback)",
                  watchedPaths: [fb.tmpMp4Path],
                  cleanupPathsOnStall: [fb.tmpMp4Path],
                })),
                fbPending.map(() => 32 * 1024 * 1024),
                Math.max(2, Math.min(os.cpus().length, 6))
              );
              for (let k = 0; k < fbPending.length; k++) {
                const { fb } = fbPending[k];
                const fbRes = fbResults[k];
                if (!fbRes || fbRes.status !== 0 || fbRes.error || !fs.existsSync(fb.tmpMp4Path)) {
                  return {
                    ok: false,
                    segMp4Paths: [],
                    firstFailure: fbRes,
                    failedArgs: fb.ffArgs,
                  };
                }
                fs.renameSync(fb.tmpMp4Path, fb.mp4Path);
              }
            }
            for (const { orig, fb } of fallbackTasks) {
              vTasks[orig.seg.index] = fb;
            }
          } finally {
            for (const { fb } of fallbackTasks) {
              if (fs.existsSync(fb.filterPath)) {
                try {
                  fs.unlinkSync(fb.filterPath);
                } catch {
                  // ignore
                }
              }
            }
          }
        } else {
          return {
            ok: false,
            segMp4Paths: [],
            firstFailure: firstFailRes,
            failedArgs: pending[firstIdx].ffArgs,
          };
        }
      }
    } finally {
      for (const t of pending) {
        if (fs.existsSync(t.filterPath)) {
          try {
            fs.unlinkSync(t.filterPath);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  return {
    ok: true,
    segMp4Paths: vTasks.map((t) => t.mp4Path),
    segmentFallbackReason,
  };
}

function muxVideoSegmentsWithAudio(params: {
  sequence: CutholSequence;
  paths: WorkspacePaths;
  segments: RenderTimeSegment[];
  segMp4Paths: string[];
  fps: number;
  maxItemsPerSegment: number;
  tmpOut: string;
  tEncode0: number;
}): number {
  const {
    sequence,
    paths,
    segments,
    segMp4Paths,
    fps,
    maxItemsPerSegment,
    tmpOut,
    tEncode0,
  } = params;

  const audioBuild = buildOrRenderSequenceAudioForMixOrRender(
    sequence,
    paths,
    sequence.stage.master_audio,
    { inputIndexOffset: 1, maxItemsPerSegment }
  );

  const vConcatLines =
    segMp4Paths
      .map((p, idx) => {
        const durSec = (segments[idx].frameCount / fps).toFixed(6);
        return `file '${escapeConcatFilePath(p)}'\nduration ${durSec}`;
      })
      .join("\n") + "\n";
  const vConcatHash = crypto
    .createHash("sha256")
    .update(vConcatLines)
    .digest("hex")
    .slice(0, 14);
  const vConcatPath = path.join(paths.blobsDir, `vconcat_${vConcatHash}.txt`);
  fs.writeFileSync(vConcatPath, vConcatLines, "utf8");

  const muxFilterScriptPath = `${tmpOut}.mux.filter.txt`;
  const audioFilter =
    audioBuild.mode === "direct_plan"
      ? audioBuild.directPlan!.filterComplex
      : audioBuild.masterFilterComplex!;
  fs.writeFileSync(muxFilterScriptPath, audioFilter, "utf8");

  const audioInputArgs =
    audioBuild.mode === "direct_plan"
      ? audioBuild.directPlan!.inputArgs
      : ["-f", "concat", "-safe", "0", "-i", audioBuild.concatListPath!];

  const totalFrames = segments[segments.length - 1].endFrame;
  const exactTotalDurationSec = (totalFrames / fps).toFixed(6);
  const muxArgs = [
    "-y",
    "-v",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    vConcatPath,
    ...audioInputArgs,
    "-/filter_complex",
    muxFilterScriptPath,
    "-map",
    "0:v:0",
    "-map",
    audioBuild.audioOutPad,
    "-frames:v",
    String(totalFrames),
    "-t",
    exactTotalDurationSec,
    "-c:v",
    "copy",
    ...BT709_COLOR_OUTPUT_ARGS,
    "-bsf:v",
    H264_BT709_VUI_BSF,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    tmpOut,
  ];

  let encodeMs = 0;
  try {
    const muxProc = spawnWatchedSync("ffmpeg", muxArgs, {
      cwd: paths.rootDir,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      step: "ffmpeg render mux",
      watchedPaths: [tmpOut],
      cleanupPathsOnStall: [tmpOut],
    });
    encodeMs = Date.now() - tEncode0;

    if (muxProc.status !== 0 || muxProc.error || !fs.existsSync(tmpOut)) {
      if (fs.existsSync(tmpOut)) {
        try {
          fs.unlinkSync(tmpOut);
        } catch {
          // ignore
        }
      }
      throw new CutholError(
        createSubprocessFailureDiagnostic({
          tool: "ffmpeg render mux",
          executable: "ffmpeg",
          args: muxArgs,
          proc: muxProc,
          clipCount: sequence.spine.clips.length,
          fallbackDetail: "segmented render mux failed",
        })
      );
    }
  } finally {
    if (fs.existsSync(muxFilterScriptPath)) {
      try {
        fs.unlinkSync(muxFilterScriptPath);
      } catch {
        // ignore
      }
    }
  }

  return encodeMs;
}

export function renderMultiSegmentPath(prep: PreparedSequenceRender): RenderEncodeStageResult {
  const {
    paths,
    sequence,
    preset,
    workers,
    tmpOut,
    maxItemsPerSegment,
    segments,
    overlayPrepassMs,
  } = prep;
  let { activeEncoder, encoderFallback } = prep;
  let renderWidth = 0;
  let renderHeight = 0;
  let fps = sequence.stage.fps;

  // Multi-segment compilation and concatenation path for long timelines (hundreds or thousands of clips).
  const tCompile0 = Date.now();
  const segmentVideoPlans: Array<{
    seg: RenderTimeSegment;
    plan: CompiledRenderPlan;
  }> = [];
  for (const seg of segments) {
    const segPlan = compileSequenceRenderPlan(sequence, paths, preset, {
      activeWindowMs: [seg.startMs, seg.endMs],
      includeAudio: false,
      workers,
    });
    renderWidth = segPlan.renderWidth;
    renderHeight = segPlan.renderHeight;
    fps = segPlan.fps;
    segmentVideoPlans.push({ seg, plan: segPlan });
  }
  const compileAndOverlaysMs = Date.now() - tCompile0 + overlayPrepassMs;

  progressFinish("overlay");
  progressBegin("encode", Math.max(1, segments.length), { mode: "ffmpeg-jobs" });
  try {
  const tEncode0 = Date.now();
  const libDigests = sequence.library.map((x) => `${x.handle}:${x.digest_sha256}`);

  const vSegResult = encodeVideoSegmentsWithEncoder({
    encoder: activeEncoder,
    segmentVideoPlans,
    libDigests,
    preset,
    paths,
  });
  if (vSegResult.segmentFallbackReason && isHardwareEncoder(activeEncoder)) {
    const prevEncoder = activeEncoder;
    activeEncoder = "libx264";
    encoderFallback = {
      from: prevEncoder,
      to: "libx264",
      reason: vSegResult.segmentFallbackReason,
    };
  }

  if (!vSegResult.ok) {
    throw new CutholError(
      createSubprocessFailureDiagnostic({
        tool: "ffmpeg render segment",
        executable: "ffmpeg",
        args: vSegResult.failedArgs ?? [],
        proc: {
          status: vSegResult.firstFailure?.status ?? null,
          error: vSegResult.firstFailure?.error,
          stderr: vSegResult.firstFailure?.stderr ?? "",
          stalled: vSegResult.firstFailure?.stalled,
          stalledMs: vSegResult.firstFailure?.stalledMs,
          stallThresholdMs: vSegResult.firstFailure?.stallThresholdMs,
          lastProgress: vSegResult.firstFailure?.lastProgress,
          commandSummary: vSegResult.firstFailure?.commandSummary,
        },
        clipCount: sequence.spine.clips.length,
        fallbackDetail: "video segment render failed",
      })
    );
  }

  const encodeMs = muxVideoSegmentsWithAudio({
    sequence,
    paths,
    segments,
    segMp4Paths: vSegResult.segMp4Paths,
    fps,
    maxItemsPerSegment,
    tmpOut,
    tEncode0,
  });

  return {
    compileAndOverlaysMs,
    encodeMs,
    singleStageUsed: false,
    renderWidth,
    renderHeight,
    fps,
    activeEncoder,
    encoderFallback,
  };
  } finally {
    progressFinish("encode");
  }
}
