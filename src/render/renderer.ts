/**
 * Cuthol Sequence Video/Audio Render Engine (`src/render/renderer.ts`).
 *
 * Executes a `CompiledRenderPlan` via FFmpeg 8.1 to produce either a delivery MP4
 * (`master_1080p`) or a fast inspection proxy (`draft_480p`).
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { computeSequenceDurationMs } from "../brief/inspector.js";
import { hashDirectoryRecursive, syncCompositionBridgeFiles } from "../compositor/bridge_exporter.js";
import { compileSequenceRenderPlan, RenderPreset } from "../compositor/compiler.js";
import { getHyperFramesFallbackInfo } from "../compositor/hyperframes_bridge.js";
import { CutholDiagnostic, CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { loadSequence, WorkspacePaths } from "../core/workspace.js";
import { evaluateRgb24FrameBlankness } from "../monitor/preview.js";
import { evaluateEnvelopeAt } from "../sequence/spine.js";
import { verifySequence, VerificationReport } from "../verify/gates.js";

export interface BlankFrameEvent {
  start_frame: number;
  end_frame: number;
  frame_count: number;
  start_s: number;
  end_s: number;
  start_ms: number;
  end_ms: number;
  clip_id: string;
  luma_mean: number;
  backdrop_flat_ratio: number;
}

export interface PostRenderBlankScanResult {
  fps: number;
  total_frames: number;
  scan_duration_ms: number;
  events: BlankFrameEvent[];
  blank_frames_count: number;
  blank_at_s: number[];
  diagnostics: CutholDiagnostic[];
}

export interface RenderOutputSummary {
  ok: boolean;
  output_path: string;
  preset: RenderPreset;
  width: number;
  height: number;
  fps: number;
  duration_ms: number;
  size_bytes: number;
  verification: VerificationReport;
  blank_scan?: PostRenderBlankScanResult;
}

function isIntentionalFadeOrTransparentAtMs(
  seq: CutholSequence,
  clipIndex: number,
  tMs: number,
  frameDurMs: number
): boolean {
  const clip = seq.spine.clips[clipIndex];
  if (!clip) return false;
  const prevClip = clipIndex > 0 ? seq.spine.clips[clipIndex - 1] : null;
  const hasNextClip = clipIndex < seq.spine.clips.length - 1;

  const outTrans = clip.transition_out;
  if (outTrans && outTrans.duration_ms > 0 && (outTrans.kind === "fade" || !hasNextClip)) {
    const fadeStartMs = clip.timeline_in_ms + clip.duration_ms - outTrans.duration_ms - frameDurMs;
    if (tMs >= fadeStartMs) return true;
  }

  const inTrans = prevClip?.transition_out ?? null;
  if (inTrans && inTrans.duration_ms > 0 && inTrans.kind === "fade") {
    const fadeEndMs = clip.timeline_in_ms + inTrans.duration_ms + frameDurMs;
    if (tMs <= fadeEndMs) return true;
  }

  const localOffsetMs = Math.max(0, tMs - clip.timeline_in_ms);
  const opEnv = clip.envelopes.find((e) => e.parameter === "placement.opacity");
  const effectiveOpacity = opEnv
    ? evaluateEnvelopeAt(opEnv, localOffsetMs)
    : clip.placement.opacity;
  if (effectiveOpacity <= 0.2) return true;

  const brEnv = clip.envelopes.find((e) => e.parameter === "treatments.color_grade.brightness");
  const effectiveBrightness = brEnv
    ? evaluateEnvelopeAt(brEnv, localOffsetMs)
    : clip.treatments.color_grade.brightness;
  if (effectiveBrightness <= -0.8) return true;

  return false;
}

/**
 * Performs a fast post-render pass over `mp4Path` using downscaled nearest-neighbor RGB24 frames
 * to detect unintentional blank / backdrop-colored frames while a spine clip is active.
 */
export function scanRenderedMp4ForBlankFrames(
  mp4Path: string,
  seq: CutholSequence
): PostRenderBlankScanResult {
  const t0 = Date.now();
  const fps = Math.max(1, seq.stage.fps);
  const frameDurMs = 1000 / fps;
  const scanW = 64;
  const scanH = 64;

  const proc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-threads",
      "0",
      "-i",
      mp4Path,
      "-an",
      "-vf",
      `scale=${scanW}:${scanH}:flags=neighbor`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    {
      maxBuffer: 128 * 1024 * 1024,
      timeout: 60_000,
    }
  );

  if (proc.status !== 0 || !proc.stdout) {
    return {
      fps,
      total_frames: 0,
      scan_duration_ms: Date.now() - t0,
      events: [],
      blank_frames_count: 0,
      blank_at_s: [],
      diagnostics: [],
    };
  }

  const buf = proc.stdout as Buffer;
  const frameBytes = scanW * scanH * 3;
  const totalFrames = Math.floor(buf.length / frameBytes);
  const events: BlankFrameEvent[] = [];
  let blankFramesCount = 0;

  for (let f = 0; f < totalFrames; f++) {
    const tMs = (f * 1000) / fps;
    let activeClipIdx = -1;
    for (let i = 0; i < seq.spine.clips.length; i++) {
      const c = seq.spine.clips[i];
      if (tMs >= c.timeline_in_ms - 1e-3 && tMs < c.timeline_in_ms + c.duration_ms - 1e-3) {
        activeClipIdx = i;
        break;
      }
    }
    if (activeClipIdx < 0) continue;
    if (isIntentionalFadeOrTransparentAtMs(seq, activeClipIdx, tMs, frameDurMs)) continue;

    const frameBuf = buf.subarray(f * frameBytes, (f + 1) * frameBytes);
    const ev = evaluateRgb24FrameBlankness(
      frameBuf,
      scanW,
      scanH,
      seq.stage.backdrop?.color
    );
    if (!ev.is_blank_frame) continue;

    blankFramesCount += 1;
    const activeClip = seq.spine.clips[activeClipIdx];
    const prev = events[events.length - 1];
    if (prev && prev.end_frame === f) {
      prev.end_frame = f + 1;
      prev.frame_count += 1;
      prev.end_s = Number(((f + 1) / fps).toFixed(3));
      prev.end_ms = Math.round(((f + 1) * 1000) / fps);
    } else {
      events.push({
        start_frame: f,
        end_frame: f + 1,
        frame_count: 1,
        start_s: Number((f / fps).toFixed(3)),
        end_s: Number(((f + 1) / fps).toFixed(3)),
        start_ms: Math.round((f * 1000) / fps),
        end_ms: Math.round(((f + 1) * 1000) / fps),
        clip_id: activeClip.id,
        luma_mean: ev.luma_mean,
        backdrop_flat_ratio: ev.backdrop_flat_ratio,
      });
    }
  }

  const diagnostics: CutholDiagnostic[] =
    events.length > 0 ? [DIAGNOSTICS.RENDER_BLANK_FRAMES_DETECTED(events)] : [];

  return {
    fps,
    total_frames: totalFrames,
    scan_duration_ms: Date.now() - t0,
    events,
    blank_frames_count: blankFramesCount,
    blank_at_s: events.map((e) => e.start_s),
    diagnostics,
  };
}

export function renderSequenceToMp4(options: {
  workspaceDir: string;
  outputPath?: string;
  preset?: RenderPreset;
}): RenderOutputSummary {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const verification = verifySequence(sequence, paths);
  if (!verification.ok) {
    const firstErr = verification.diagnostics.find((d) => d.severity === "ERROR")!;
    throw new CutholError(firstErr);
  }

  const preset: RenderPreset = options.preset ?? "master_1080p";
  const plan = compileSequenceRenderPlan(sequence, paths, preset);

  // Report CUTHOL-G503 warning if any HyperFrames composition fell back to drawbox
  for (const blobPath of plan.hyperframesBlobs) {
    const fb = getHyperFramesFallbackInfo(blobPath);
    if (fb) {
      verification.diagnostics.push(
        DIAGNOSTICS.HYPERFRAMES_RENDER_FALLBACK(fb.composition_dir, fb.reason)
      );
      verification.warning_count += 1;
    }
  }

  const defaultOut = path.join(paths.rootDir, "output", `render_r${sequence.meta.revision}_${preset}.mp4`);
  const resolvedOut = options.outputPath
    ? path.isAbsolute(options.outputPath)
      ? options.outputPath
      : path.resolve(paths.rootDir, options.outputPath)
    : defaultOut;

  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  const tmpOut = `${resolvedOut}.${process.pid}.${Date.now()}.tmp.mp4`;

  const ffArgs: string[] = [
    "-y",
    "-v",
    "error",
    ...plan.inputArgs,
    "-filter_complex",
    plan.filterComplex,
    "-map",
    plan.videoOutPad,
    "-map",
    plan.audioOutPad,
    "-t",
    (plan.totalDurationMs / 1000).toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    preset === "draft_480p" ? "ultrafast" : "fast",
    "-crf",
    preset === "draft_480p" ? "24" : "19",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    tmpOut,
  ];

  const proc = spawnSync("ffmpeg", ffArgs, {
    cwd: paths.rootDir,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });

  if (proc.status !== 0 || !fs.existsSync(tmpOut)) {
    if (fs.existsSync(tmpOut)) {
      try {
        fs.unlinkSync(tmpOut);
      } catch {
        // ignore cleanup error
      }
    }
    throw new CutholError(
      DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
        "ffmpeg render",
        (proc.stderr || proc.stdout || "render failed").slice(-600)
      )
    );
  }

  fs.renameSync(tmpOut, resolvedOut);
  const stat = fs.statSync(resolvedOut);
  const blankScan = scanRenderedMp4ForBlankFrames(resolvedOut, sequence);
  for (const diag of blankScan.diagnostics) {
    verification.diagnostics.push(diag);
    verification.warning_count += 1;
  }

  return {
    ok: true,
    output_path: resolvedOut,
    preset,
    width: plan.renderWidth,
    height: plan.renderHeight,
    fps: plan.fps,
    duration_ms: plan.totalDurationMs,
    size_bytes: stat.size,
    verification,
    blank_scan: blankScan,
  };
}

/**
 * Renders or retrieves a content-addressed preview MP4 for the current sequence state
 * so `monitor frame` and `monitor sheet` can sample arbitrary timestamps rapidly.
 */
export function ensurePreviewCompositeMp4(
  seq: CutholSequence,
  paths: WorkspacePaths,
  preset: RenderPreset = "draft_480p"
): { mp4Path: string; width: number; height: number; durationMs: number } {
  // Verify structural/asset/timing gates before preview composite
  const verification = verifySequence(seq, paths, ["G1_SCHEMA", "G2_ASSETS", "G3_TIMING"]);
  if (!verification.ok) {
    const firstErr = verification.diagnostics.find((d) => d.severity === "ERROR")!;
    throw new CutholError(firstErr);
  }

  // Synchronize bridge data files (`cuthol-data.js` / `cuthol-vars.json`) BEFORE
  // hashing composition directories so speech/beat/cut changes invalidate `stateHash` immediately.
  const compContents: string[] = [];
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      if (cue.composition) {
        try {
          syncCompositionBridgeFiles(seq, cue, paths);
        } catch {
          // non-blocking bridge sync
        }
        const compDir = path.isAbsolute(cue.composition.composition_dir)
          ? cue.composition.composition_dir
          : path.resolve(paths.rootDir, cue.composition.composition_dir);
        if (fs.existsSync(compDir)) {
          compContents.push(`${cue.id}:${hashDirectoryRecursive(compDir)}`);
        }
      }
    }
  }

  const stateHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        stage: seq.stage,
        libraryDigests: seq.library.map((x) => `${x.handle}:${x.digest_sha256}`),
        spine: seq.spine,
        lanes: seq.lanes,
        compContents,
        preset,
      })
    )
    .digest("hex")
    .slice(0, 14);

  const totalDurationMs = Math.max(500, computeSequenceDurationMs(seq));
  const scaleFactor = preset === "draft_480p" ? 480 / Math.min(seq.stage.width, seq.stage.height) : 1.0;
  const renderWidth = Math.max(16, Math.round((seq.stage.width * scaleFactor) / 2) * 2);
  const renderHeight = Math.max(16, Math.round((seq.stage.height * scaleFactor) / 2) * 2);

  const cachedMp4 = path.join(paths.blobsDir, `preview_comp_${stateHash}.mp4`);
  // Return immediately on cache hit BEFORE invoking compileSequenceRenderPlan side effects
  if (fs.existsSync(cachedMp4) && fs.statSync(cachedMp4).size > 1000) {
    return {
      mp4Path: cachedMp4,
      width: renderWidth,
      height: renderHeight,
      durationMs: totalDurationMs,
    };
  }

  const plan = compileSequenceRenderPlan(seq, paths, preset);

  fs.mkdirSync(paths.blobsDir, { recursive: true });
  const tmpMp4 = path.join(
    paths.blobsDir,
    `preview_comp_${stateHash}.${process.pid}.${Date.now()}.tmp.mp4`
  );

  const ffArgs: string[] = [
    "-y",
    "-v",
    "error",
    ...plan.inputArgs,
    "-filter_complex",
    plan.filterComplex,
    "-map",
    plan.videoOutPad,
    "-map",
    plan.audioOutPad,
    "-t",
    (plan.totalDurationMs / 1000).toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "20",
    "-g",
    "1", // All-intra frames for exact millisecond seeking in monitor
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    tmpMp4,
  ];

  const proc = spawnSync("ffmpeg", ffArgs, {
    cwd: paths.rootDir,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });

  if (proc.status !== 0 || !fs.existsSync(tmpMp4)) {
    if (fs.existsSync(tmpMp4)) {
      try {
        fs.unlinkSync(tmpMp4);
      } catch {
        // ignore cleanup error
      }
    }
    throw new CutholError(
      DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
        "ffmpeg preview composite",
        (proc.stderr || proc.stdout || "preview composite failed").slice(-600)
      )
    );
  }

  fs.renameSync(tmpMp4, cachedMp4);

  return {
    mp4Path: cachedMp4,
    width: plan.renderWidth,
    height: plan.renderHeight,
    durationMs: plan.totalDurationMs,
  };
}

/**
 * Renders a single composite frame at `atMs` through the exact same `compileSequenceRenderPlan`
 * filtergraph as full `render` (preserving `xfade` dissolves, keyframe envelopes, B-roll lanes,
 * and `.ass` subtitles), while skipping compositions outside `atMs` and capturing only a single
 * frame-grid-snapped RGBA PNG for any uncached composition active at `atMs`.
 */
export function renderSingleCompositeFrameRgb24(
  seq: CutholSequence,
  paths: WorkspacePaths,
  atMs: number,
  preset: RenderPreset = "draft_480p"
): { rgbBuf: Buffer; width: number; height: number; durationMs: number; clampedMs: number } {
  const verification = verifySequence(seq, paths, ["G1_SCHEMA", "G2_ASSETS", "G3_TIMING"]);
  if (!verification.ok) {
    const firstErr = verification.diagnostics.find((d) => d.severity === "ERROR")!;
    throw new CutholError(firstErr);
  }

  const totalDurationMs = Math.max(500, computeSequenceDurationMs(seq));
  const fps = Math.max(1, seq.stage.fps);
  const lastFrameIdx = Math.max(0, Math.floor((totalDurationMs / 1000) * fps - 1));
  const maxSafeMs = Math.max(0, Math.floor(lastFrameIdx * (1000 / fps)));
  const clampedMs = Math.max(0, Math.min(Math.round(atMs), maxSafeMs));
  const frameIdx = Math.max(0, Math.min(lastFrameIdx, Math.floor((clampedMs / 1000) * fps + 1e-6)));
  // Use exact floating-point millisecond timestamp `exactFrameMs = (frameIdx * 1000) / fps`
  // instead of `Math.round(...)` so 30fps `frameIdx = 3k + 1` never loses 0.333ms and drifts to `frameIdx - 1`.
  const exactFrameMs = (frameIdx * 1000) / fps;
  const frameDurMs = 1000 / fps;

  const plan = compileSequenceRenderPlan(seq, paths, preset, {
    activeWindowMs: [exactFrameMs - 1e-3, exactFrameMs + frameDurMs],
    singleFrameAtMs: exactFrameMs,
  });

  const width = plan.renderWidth;
  const height = plan.renderHeight;
  const pixelCount = width * height;
  const snappedSec = (frameIdx / fps).toFixed(6);
  const stopSec = ((frameIdx + 2) / fps).toFixed(6);

  const filterWithSelect = `${plan.filterComplex};${plan.videoOutPad}trim=start=${snappedSec},setpts=PTS-STARTPTS[v_single_out];${plan.audioOutPad}anullsink`;

  const proc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      ...plan.inputArgs,
      "-filter_complex",
      filterWithSelect,
      "-map",
      "[v_single_out]",
      "-t",
      stopSec,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    {
      cwd: paths.rootDir,
      maxBuffer: pixelCount * 4 + 2 * 1024 * 1024,
      timeout: 60_000,
    }
  );

  const rgbBuf = proc.stdout as Buffer;
  if (proc.status === 0 && rgbBuf && rgbBuf.length >= pixelCount * 3) {
    return {
      rgbBuf: rgbBuf.subarray(0, pixelCount * 3),
      width,
      height,
      durationMs: plan.totalDurationMs,
      clampedMs,
    };
  }

  // Fallback to full preview composite MP4 if single-frame pipe encounters EOF edge case
  const { mp4Path } = ensurePreviewCompositeMp4(seq, paths, preset);
  const fallbackProc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      (clampedMs / 1000).toFixed(3),
      "-i",
      mp4Path,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: pixelCount * 4 + 1024 * 1024, timeout: 30_000 }
  );
  const fbBuf = fallbackProc.stdout as Buffer;
  if (fallbackProc.status !== 0 || !fbBuf || fbBuf.length < pixelCount * 3) {
    throw new CutholError(
      DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
        "ffmpeg single frame extract",
        (proc.stderr?.toString("utf8") || fallbackProc.stderr?.toString("utf8") || "extract failed").slice(-400)
      )
    );
  }
  return {
    rgbBuf: fbBuf.subarray(0, pixelCount * 3),
    width,
    height,
    durationMs: plan.totalDurationMs,
    clampedMs,
  };
}
