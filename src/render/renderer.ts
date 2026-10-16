/**
 * Cuthol Sequence Video/Audio Render Engine (`src/render/renderer.ts`).
 *
 * Executes a `CompiledRenderPlan` via FFmpeg 8.1 to produce either a delivery MP4
 * (`master_1080p`) or a fast inspection proxy (`draft_480p`).
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import {
  computeRenderDurationMs,
  computeSequenceDurationMs,
  findBackdropOnlySpans,
  resolveCueStartMs,
} from "../core/timeline.js";
import { hashDirectoryRecursive, syncCompositionBridgeFiles } from "../compositor/bridge_exporter.js";
import { CompiledRenderPlan, compileSequenceRenderPlan, RenderPreset } from "../compositor/compiler.js";
import { renderHyperFramesBatchFramesPng } from "../compositor/hyperframes_bridge.js";
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
 * to detect unintentional blank / backdrop-colored frames while a spine clip is active. In a spine-less
 * (graphics-only) sequence it checks the frames where no visual cue is on screen; `clip_id` is empty there.
 */
export function scanRenderedMp4ForBlankFrames(
  mp4Path: string,
  seq: CutholSequence,
  options?: { chunkFrames?: number }
): PostRenderBlankScanResult {
  const t0 = Date.now();
  const fps = Math.max(1, seq.stage.fps);
  const frameDurMs = 1000 / fps;
  const scanW = 64;
  const scanH = 64;

  // Read the render in fixed-size chunks so memory stays bounded for long videos (hours of footage);
  // a single pipe of the whole file would exceed any fixed buffer.
  const frameBytes = scanW * scanH * 3;
  const chunkFrames = Math.max(1, options?.chunkFrames ?? 6000);
  const events: BlankFrameEvent[] = [];
  let blankFramesCount = 0;
  // Only non-empty for a spine-less sequence: the moments where no visual cue is on screen.
  const backdropOnlySpans = findBackdropOnlySpans(seq);
  const processFrame = (f: number, frameBuf: Buffer): void => {
    const tMs = (f * 1000) / fps;
    let activeClipIdx = -1;
    for (let i = 0; i < seq.spine.clips.length; i++) {
      const c = seq.spine.clips[i];
      if (tMs >= c.timeline_in_ms - 1e-3 && tMs < c.timeline_in_ms + c.duration_ms - 1e-3) {
        activeClipIdx = i;
        break;
      }
    }
    if (activeClipIdx >= 0) {
      if (isIntentionalFadeOrTransparentAtMs(seq, activeClipIdx, tMs, frameDurMs)) return;
    } else if (!backdropOnlySpans.some((sp) => tMs >= sp.start_ms - 1e-3 && tMs < sp.end_ms - 1e-3)) {
      // Spine-less frames drawn by a composition or graphic are not judged by brightness: designed dark
      // frames are common there and a composition that cannot render already stops the render (G503).
      return;
    }

    const ev = evaluateRgb24FrameBlankness(
      frameBuf,
      scanW,
      scanH,
      seq.stage.backdrop?.color
    );
    if (!ev.is_blank_frame) return;

    blankFramesCount += 1;
    const clipId = activeClipIdx >= 0 ? seq.spine.clips[activeClipIdx].id : "";
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
        clip_id: clipId,
        luma_mean: ev.luma_mean,
        backdrop_flat_ratio: ev.backdrop_flat_ratio,
      });
    }
  };

  let totalFrames = 0;
  for (let startFrame = 0; ; startFrame += chunkFrames) {
    const proc = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-threads",
        "0",
        "-ss",
        (startFrame / fps).toFixed(6),
        "-i",
        mp4Path,
        "-an",
        "-frames:v",
        String(chunkFrames),
        "-vf",
        `scale=${scanW}:${scanH}:flags=neighbor`,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { maxBuffer: chunkFrames * frameBytes + 4 * 1024 * 1024 }
    );
    if (proc.status !== 0 || !proc.stdout) {
      if (startFrame === 0) {
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
      break;
    }
    const chunkBuf = proc.stdout as Buffer;
    const got = Math.floor(chunkBuf.length / frameBytes);
    for (let i = 0; i < got; i++) {
      processFrame(startFrame + i, chunkBuf.subarray(i * frameBytes, (i + 1) * frameBytes));
    }
    totalFrames += got;
    if (got < chunkFrames) break;
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
  // An empty sequence would only produce a short clip of backdrop colour; refuse instead of writing it.
  if (computeSequenceDurationMs(sequence) <= 0) {
    throw new CutholError(DIAGNOSTICS.EMPTY_SEQUENCE("ERROR"));
  }

  const preset: RenderPreset = options.preset ?? "master_1080p";
  // A composition that cannot be rendered throws CUTHOL-G503 from the compiler; nothing is substituted.
  const plan = compileSequenceRenderPlan(sequence, paths, preset);

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
    // No wall-clock limit: a full render scales with sequence length (long videos take hours).
    maxBuffer: 256 * 1024 * 1024,
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

  const totalDurationMs = computeRenderDurationMs(seq);
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
    // No wall-clock limit: a full render scales with sequence length (long videos take hours).
    maxBuffer: 256 * 1024 * 1024,
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
 * Pre-renders all active HyperFrames composition frames needed across `timestampsMs` in a single
 * batched `snapshot --at` call per composition cue so subsequent `renderSingleCompositeFrameRgb24`
 * calls hit the `hf_frame_<hash>_f<idx>.png` cache directly.
 */
export function prefetchCompositeFramesForTimestamps(
  seq: CutholSequence,
  paths: WorkspacePaths,
  timestampsMs: number[],
  preset: RenderPreset = "draft_480p"
): void {
  if (timestampsMs.length === 0) return;

  const totalDurationMs = computeRenderDurationMs(seq);
  const fps = Math.max(1, seq.stage.fps);
  const lastFrameIdx = Math.max(0, Math.floor((totalDurationMs / 1000) * fps - 1));
  const maxSafeMs = Math.max(0, Math.floor(lastFrameIdx * (1000 / fps)));
  const frameDurMs = 1000 / fps;

  const scaleFactor = preset === "draft_480p" ? 480 / Math.min(seq.stage.width, seq.stage.height) : 1.0;
  const renderWidth = Math.max(16, Math.round((seq.stage.width * scaleFactor) / 2) * 2);
  const renderHeight = Math.max(16, Math.round((seq.stage.height * scaleFactor) / 2) * 2);

  const exactFrameTimesMs = timestampsMs.map((atMs) => {
    const clampedMs = Math.max(0, Math.min(Math.round(atMs), maxSafeMs));
    const frameIdx = Math.max(0, Math.min(lastFrameIdx, Math.floor((clampedMs / 1000) * fps + 1e-6)));
    return (frameIdx * 1000) / fps;
  });

  const sortedLanes = [...seq.lanes].sort((a, b) => a.z_index - b.z_index);
  for (const lane of sortedLanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (cue.kind !== "composition" || !cue.composition) continue;
      const compMode = cue.composition.mode ?? "overlay_alpha";
      if (compMode === "scene_host") continue;

      const cueStartMs = resolveCueStartMs(seq, cue);
      const cueEndMs = cueStartMs + cue.duration_ms;

      const localSecs: number[] = [];
      for (const exactFrameMs of exactFrameTimesMs) {
        if (exactFrameMs + frameDurMs >= cueStartMs && exactFrameMs <= cueEndMs) {
          localSecs.push(Math.max(0, (exactFrameMs - cueStartMs) / 1000));
        }
      }
      if (localSecs.length === 0) continue;

      try {
        syncCompositionBridgeFiles(seq, cue, paths);
      } catch {
        // non-blocking bridge sync
      }

      const compDir = path.isAbsolute(cue.composition.composition_dir)
        ? cue.composition.composition_dir
        : path.resolve(paths.rootDir, cue.composition.composition_dir);

      const entryPath = path.join(compDir, cue.composition.entry_html);
      let allFramesAlreadyCached = false;
      if (fs.existsSync(entryPath)) {
        try {
          const htmlSource = fs.readFileSync(entryPath, "utf8");
          const wMatch = /\bdata-width\s*=\s*(["'])(\d+)\1/i.exec(htmlSource);
          const hMatch = /\bdata-height\s*=\s*(["'])(\d+)\1/i.exec(htmlSource);
          const nativeWidth = wMatch ? Math.max(16, Number(wMatch[2])) : renderWidth;
          const nativeHeight = hMatch ? Math.max(16, Number(hMatch[2])) : renderHeight;
          const recursiveDirHash = hashDirectoryRecursive(compDir);
          const compHash = crypto
            .createHash("sha256")
            .update(recursiveDirHash)
            .update(
              JSON.stringify({
                entry: cue.composition.entry_html,
                w: nativeWidth,
                h: nativeHeight,
                fps,
                dur: cue.duration_ms,
                props: cue.composition.props,
                transparent: cue.composition.transparent,
                mode: compMode,
                backdropDigest: "",
              })
            )
            .digest("hex")
            .slice(0, 16);

          const durationSec = Math.max(0.1, Number((cue.duration_ms / 1000).toFixed(3)));
          const totalFrames = Math.max(1, Math.round(durationSec * fps));
          const missingByFrame = new Map<number, { outPng: string; tmpPng: string; seekSec: string }>();
          for (const localSec of localSecs) {
            const fIdx = Math.max(0, Math.min(totalFrames - 1, Math.floor(localSec * fps + 1e-6)));
            if (missingByFrame.has(fIdx)) continue;
            const outPng = path.join(paths.blobsDir, `hf_frame_${compHash}_f${fIdx}.png`);
            if (!fs.existsSync(outPng) || fs.statSync(outPng).size <= 200) {
              const tmpPng = `${outPng}.${process.pid}.${fIdx}.tmp.png`;
              missingByFrame.set(fIdx, {
                outPng,
                tmpPng,
                seekSec: (fIdx / fps).toFixed(6),
              });
            }
          }

          if (missingByFrame.size === 0) {
            const bboxSidecarPath = path.join(compDir, "assets/cuthol-bbox.json");
            if (!cue.composition.transparent || fs.existsSync(bboxSidecarPath)) {
              allFramesAlreadyCached = true;
            }
          } else if (missingByFrame.size > 1) {
            const cachedMov = path.join(paths.blobsDir, `hf_comp_${compHash}.mov`);
            const cachedMp4 = path.join(paths.blobsDir, `hf_comp_${compHash}.mp4`);
            const cachedVideo =
              fs.existsSync(cachedMov) && fs.statSync(cachedMov).size > 1000
                ? cachedMov
                : fs.existsSync(cachedMp4) && fs.statSync(cachedMp4).size > 1000
                  ? cachedMp4
                  : null;

            if (cachedVideo) {
              fs.mkdirSync(paths.blobsDir, { recursive: true });
              const missingList = [...missingByFrame.values()];
              const extractJobs: ParallelFfmpegJob[] = missingList.map((m) => ({
                args: [
                  "-y",
                  "-v",
                  "error",
                  "-ss",
                  m.seekSec,
                  "-i",
                  cachedVideo,
                  "-vf",
                  "format=rgba",
                  "-frames:v",
                  "1",
                  m.tmpPng,
                ],
                cwd: paths.rootDir,
              }));
              const extractResults = runParallelFfmpegJobsSync(
                extractJobs,
                missingList.map(() => 4 * 1024 * 1024)
              );
              let extractedCount = 0;
              for (let i = 0; i < missingList.length; i++) {
                const m = missingList[i];
                if (
                  extractResults[i]?.status === 0 &&
                  fs.existsSync(m.tmpPng) &&
                  fs.statSync(m.tmpPng).size > 200
                ) {
                  fs.renameSync(m.tmpPng, m.outPng);
                  extractedCount++;
                } else if (fs.existsSync(m.tmpPng)) {
                  try {
                    fs.unlinkSync(m.tmpPng);
                  } catch {
                    // ignore
                  }
                }
              }
              if (extractedCount === missingList.length) {
                const bboxSidecarPath = path.join(compDir, "assets/cuthol-bbox.json");
                if (!cue.composition.transparent || fs.existsSync(bboxSidecarPath)) {
                  allFramesAlreadyCached = true;
                }
              }
            }
          }
        } catch {
          // fall through to renderHyperFramesBatchFramesPng
        }
      }

      if (!allFramesAlreadyCached) {
        renderHyperFramesBatchFramesPng({
          compositionDir: compDir,
          entryHtml: cue.composition.entry_html,
          blobsDir: paths.blobsDir,
          width: renderWidth,
          height: renderHeight,
          fps,
          durationMs: cue.duration_ms,
          localSecs,
          props: cue.composition.props,
          transparent: cue.composition.transparent,
          mode: compMode,
        });
      }
    }
  }
}

export interface CellBboxSidecarUpdate {
  bboxPath: string;
  bboxJson: string | null;
}

interface ActiveCompFrameRef {
  cueId: string;
  compFrameIdx: number;
  bboxPath: string | null;
}

interface SingleFrameFfmpegPlan {
  ffArgs: string[];
  cwd: string;
  width: number;
  height: number;
  pixelCount: number;
  durationMs: number;
  clampedMs: number;
  bboxTargets: Array<{ bboxPath: string; pngPath: string }>;
}

interface ParallelFfmpegJob {
  args: string[];
  cwd: string;
}

interface ParallelFfmpegJobResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

let sharedFfmpegPoolWorker: Worker | null = null;

function getFfmpegPoolWorker(): Worker {
  if (sharedFfmpegPoolWorker) return sharedFfmpegPoolWorker;
  const workerScript = `
    const { parentPort } = require("node:worker_threads");
    const { spawn } = require("node:child_process");

    function runOne(job) {
      return new Promise((resolve) => {
        const outChunks = [];
        const errChunks = [];
        let settled = false;
        const proc = spawn("ffmpeg", job.args, {
          cwd: job.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        proc.stdout.on("data", (chunk) => outChunks.push(chunk));
        proc.stderr.on("data", (chunk) => errChunks.push(chunk));
        proc.on("error", (err) => {
          if (settled) return;
          settled = true;
          resolve({ status: 1, stdoutBuf: Buffer.alloc(0), stderr: String(err) });
        });
        proc.on("close", (code) => {
          if (settled) return;
          settled = true;
          const stdoutBuf = Buffer.concat(outChunks);
          const stderr = errChunks.length > 0 ? Buffer.concat(errChunks).toString("utf8") : "";
          resolve({ status: code ?? 1, stdoutBuf, stderr });
        });
      });
    }

    parentPort.on("message", async (msg) => {
      const { jobs, concurrency, port, sab } = msg;
      const signal = new Int32Array(sab);
      const results = new Array(jobs.length);
      let nextIdx = 0;
      const workerCount = Math.max(1, Math.min(jobs.length, concurrency || 4));

      async function workerLoop() {
        while (true) {
          const i = nextIdx++;
          if (i >= jobs.length) break;
          const res = await runOne(jobs[i]);
          const ab = res.stdoutBuf.buffer.slice(
            res.stdoutBuf.byteOffset,
            res.stdoutBuf.byteOffset + res.stdoutBuf.byteLength
          );
          results[i] = { status: res.status, stdoutAb: ab, stderr: res.stderr };
        }
      }

      try {
        await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
        const transferList = results.map((r) => r.stdoutAb);
        port.postMessage({ ok: true, results }, transferList);
      } catch (err) {
        port.postMessage({ ok: false, error: String(err) });
      } finally {
        port.close();
        Atomics.store(signal, 0, 1);
        Atomics.notify(signal, 0, 1);
      }
    });
  `;
  const worker = new Worker(workerScript, { eval: true });
  worker.unref();
  worker.on("error", () => {
    if (sharedFfmpegPoolWorker === worker) {
      sharedFfmpegPoolWorker = null;
    }
  });
  worker.on("exit", () => {
    if (sharedFfmpegPoolWorker === worker) {
      sharedFfmpegPoolWorker = null;
    }
  });
  sharedFfmpegPoolWorker = worker;
  return worker;
}

function runParallelFfmpegJobsSync(
  jobs: ParallelFfmpegJob[],
  maxBuffers: number[],
  concurrency = Math.max(2, Math.min(os.cpus().length, 12))
): ParallelFfmpegJobResult[] {
  if (jobs.length === 0) return [];
  if (jobs.length === 1) {
    const proc = spawnSync("ffmpeg", jobs[0].args, {
      cwd: jobs[0].cwd,
      maxBuffer: maxBuffers[0],
    });
    return [
      {
        status: proc.status ?? 1,
        stdout: (proc.stdout as Buffer) ?? Buffer.alloc(0),
        stderr: proc.stderr ? proc.stderr.toString("utf8") : "",
      },
    ];
  }

  try {
    const worker = getFfmpegPoolWorker();
    const { port1, port2 } = new MessageChannel();
    const sab = new SharedArrayBuffer(4);
    const signal = new Int32Array(sab);
    worker.postMessage({ jobs, concurrency, port: port2, sab }, [port2]);
    Atomics.wait(signal, 0, 0);
    const received = receiveMessageOnPort(port1);
    port1.close();
    if (received?.message?.ok && Array.isArray(received.message.results)) {
      return received.message.results.map(
        (r: { status: number; stdoutAb: ArrayBuffer; stderr: string }) => ({
          status: r.status,
          stdout: Buffer.from(r.stdoutAb),
          stderr: r.stderr,
        })
      );
    }
  } catch {
    // Fallback to synchronous execution below if worker messaging fails
  }

  return jobs.map((job, idx) => {
    const proc = spawnSync("ffmpeg", job.args, {
      cwd: job.cwd,
      maxBuffer: maxBuffers[idx],
    });
    return {
      status: proc.status ?? 1,
      stdout: (proc.stdout as Buffer) ?? Buffer.alloc(0),
      stderr: proc.stderr ? proc.stderr.toString("utf8") : "",
    };
  });
}

function computeAlphaBboxJsonFromRgbaBuffer(buf: Buffer, probeW = 320, probeH = 180): string | null {
  if (!buf || buf.length < probeW * probeH * 4) return null;
  let minX = probeW;
  let minY = probeH;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < probeH; y++) {
    for (let x = 0; x < probeW; x++) {
      const a = buf[(y * probeW + x) * 4 + 3];
      if (a > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return JSON.stringify(
    {
      left_pct: Number((minX / probeW).toFixed(4)),
      top_pct: Number((minY / probeH).toFixed(4)),
      right_pct: Number(((maxX + 1) / probeW).toFixed(4)),
      bottom_pct: Number(((maxY + 1) / probeH).toFixed(4)),
      width_pct: Number(((maxX - minX + 1) / probeW).toFixed(4)),
      height_pct: Number(((maxY - minY + 1) / probeH).toFixed(4)),
    },
    null,
    2
  );
}

function resolveActiveCompositionRefsAt(
  seq: CutholSequence,
  paths: WorkspacePaths,
  exactFrameMs: number,
  fps: number
): { canReuseTemplate: boolean; signature: string; refs: ActiveCompFrameRef[] } {
  const frameDurMs = 1000 / Math.max(1, fps);
  const winStart = exactFrameMs - 1e-3;
  const winEnd = exactFrameMs + frameDurMs;
  const refs: ActiveCompFrameRef[] = [];
  const sortedLanes = [...seq.lanes].sort((a, b) => a.z_index - b.z_index);

  for (const lane of sortedLanes) {
    if (lane.muted) continue;
    const orderedCues = [...lane.cues].sort(
      (a, b) => resolveCueStartMs(seq, a) - resolveCueStartMs(seq, b)
    );
    for (const cue of orderedCues) {
      if (cue.kind !== "composition" || !cue.composition) continue;
      const cueStartMs = resolveCueStartMs(seq, cue);
      const cueEndMs = cueStartMs + cue.duration_ms;
      if (cueEndMs <= winStart || cueStartMs > winEnd) continue;

      const compMode = cue.composition.mode ?? "overlay_alpha";
      if (
        compMode === "scene_host" ||
        !(exactFrameMs + frameDurMs >= cueStartMs && exactFrameMs <= cueEndMs)
      ) {
        return { canReuseTemplate: false, signature: "", refs: [] };
      }

      const durationSec = Math.max(0.1, Number((cue.duration_ms / 1000).toFixed(3)));
      const totalFrames = Math.max(1, Math.round(durationSec * fps));
      const localSec = Math.max(0, (exactFrameMs - cueStartMs) / 1000);
      const compFrameIdx = Math.max(0, Math.min(totalFrames - 1, Math.floor(localSec * fps + 1e-6)));
      const absCompDir = path.isAbsolute(cue.composition.composition_dir)
        ? cue.composition.composition_dir
        : path.resolve(paths.rootDir, cue.composition.composition_dir);

      refs.push({
        cueId: cue.id,
        compFrameIdx,
        bboxPath: cue.composition.transparent
          ? path.join(path.resolve(absCompDir), "assets/cuthol-bbox.json")
          : null,
      });
    }
  }

  return {
    canReuseTemplate: true,
    signature: refs.map((r) => r.cueId).join("|"),
    refs,
  };
}

function buildSingleFrameFfmpegPlanFromCompiledPlan(
  plan: CompiledRenderPlan,
  paths: WorkspacePaths,
  fps: number,
  frameIdx: number,
  clampedMs: number,
  bboxTargets: Array<{ bboxPath: string; pngPath: string }>
): SingleFrameFfmpegPlan {
  const width = plan.renderWidth;
  const height = plan.renderHeight;
  const pixelCount = width * height;
  const snappedSec = (frameIdx / fps).toFixed(6);
  const stopSec = ((frameIdx + 2) / fps).toFixed(6);

  // Split inputArgs into per-input groups and strip the unused audio graph (`anullsrc` + audio inputs)
  // so single-frame extraction never decodes or mixes audio tracks.
  const inputGroups: string[][] = [];
  let curGroup: string[] = [];
  for (let i = 0; i < plan.inputArgs.length; i++) {
    const arg = plan.inputArgs[i];
    curGroup.push(arg);
    if (arg === "-i" && i + 1 < plan.inputArgs.length) {
      curGroup.push(plan.inputArgs[++i]);
      inputGroups.push(curGroup);
      curGroup = [];
    }
  }
  const audioStartIdx = inputGroups.findIndex((g) => g[g.length - 1]?.startsWith("anullsrc="));
  const videoInputGroups = audioStartIdx >= 0 ? inputGroups.slice(0, audioStartIdx) : inputGroups;

  const voutIdx = plan.filterComplex.indexOf(plan.videoOutPad);
  let videoFilterComplex =
    voutIdx >= 0
      ? plan.filterComplex.slice(0, voutIdx + plan.videoOutPad.length)
      : plan.filterComplex;

  // Check if the video graph only consists of the stage backdrop (`[0:v]`), HyperFrames single-frame
  // PNG inputs (`[v_hf_...]`), and optional `.ass` subtitles (no spine video clips `[v_sp_...]` or
  // asset lane cues `[v_cue_...]`). When true, shift `[0:v]` and `[v_hf_...]` directly to `snappedSec`
  // so FFmpeg composites 1 frame instead of simulating `0 .. snappedSec`.
  const hasSpineOrAssetVideo =
    videoFilterComplex.includes("[v_sp_") || videoFilterComplex.includes("[v_cue_");
  const canJumpDirectlyToFrame =
    !hasSpineOrAssetVideo &&
    videoInputGroups.length > 0 &&
    videoInputGroups[0][videoInputGroups[0].length - 1]?.startsWith("color=") &&
    videoInputGroups.slice(1).every((g) => g.includes("-loop") && g[g.length - 1]?.endsWith(".png"));

  const shortDurSec = (2 / fps).toFixed(6);
  if (canJumpDirectlyToFrame) {
    videoFilterComplex = videoFilterComplex.replace(
      "[0:v]",
      `[0:v]setpts=PTS+${snappedSec}/TB,`
    );
  }
  for (let idx = 0; idx < videoInputGroups.length; idx++) {
    const g = videoInputGroups[idx];
    if (idx === 0 && canJumpDirectlyToFrame) {
      const colorSpec = g[g.length - 1];
      g[g.length - 1] = colorSpec.replace(
        /:d=[\d.]+,settb=AVTB$/,
        `:d=${shortDurSec},settb=AVTB`
      );
      continue;
    }
    const loopPos = g.indexOf("-loop");
    const tPos = g.indexOf("-t");
    const frPos = g.indexOf("-framerate");
    const inputPath = g[g.length - 1];
    if (loopPos >= 0 && tPos >= 0 && frPos >= 0 && inputPath?.endsWith(".png")) {
      const durVal = g[tPos + 1];
      const fpsVal = g[frPos + 1];
      // Decode the PNG once instead of re-decoding it on every frame via `-loop 1`
      videoInputGroups[idx] = ["-framerate", fpsVal, "-i", inputPath];

      if (canJumpDirectlyToFrame) {
        videoFilterComplex = videoFilterComplex.replace(
          new RegExp(
            `\\[${idx}:v\\]([\\s\\S]*?)tpad=stop_mode=clone:stop_duration=[\\d.]+,settb=AVTB,setpts=PTS-STARTPTS\\+([\\d.]+)/TB(\\[v_hf_[^\\]]+\\])`
          ),
          (_m, midFilters: string, cueStartSecStr: string, outPad: string) => {
            const localSecVal = Math.max(0, Number(snappedSec) - Number(cueStartSecStr)).toFixed(6);
            return `[${idx}:v]settb=AVTB,setpts=PTS+${localSecVal}/TB,${midFilters}tpad=stop_mode=clone:stop_duration=${shortDurSec},settb=AVTB,setpts=PTS-STARTPTS+${snappedSec}/TB${outPad}`;
          }
        );
      } else {
        videoFilterComplex = videoFilterComplex.replace(
          new RegExp(
            `(\\[${idx}:v\\][\\s\\S]*?)tpad=stop_mode=clone:stop_duration=[\\d.]+(,settb=AVTB,setpts=PTS-STARTPTS\\+[\\d.]+/TB\\[v_hf_[^\\]]+\\])`
          ),
          `$1tpad=stop_mode=clone:stop_duration=${durVal}$2`
        );
      }
    }
  }

  const optimizedInputArgs = videoInputGroups.flat();
  const filterWithSelect = canJumpDirectlyToFrame
    ? `${videoFilterComplex};${plan.videoOutPad}setpts=PTS-STARTPTS[v_single_out]`
    : `${videoFilterComplex};${plan.videoOutPad}trim=start=${snappedSec},setpts=PTS-STARTPTS[v_single_out]`;

  return {
    ffArgs: [
      "-v",
      "error",
      ...optimizedInputArgs,
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
    cwd: paths.rootDir,
    width,
    height,
    pixelCount,
    durationMs: plan.totalDurationMs,
    clampedMs,
    bboxTargets,
  };
}

/**
 * Renders multiple composite frames at `timestampsMs` in parallel through a CPU-bounded async
 * FFmpeg process pool while preserving bit-for-bit identical output to `renderSingleCompositeFrameRgb24`.
 */
export function renderMultipleCompositeFramesRgb24(
  seq: CutholSequence,
  paths: WorkspacePaths,
  timestampsMs: number[],
  preset: RenderPreset = "draft_480p"
): Array<{
  rgbBuf: Buffer;
  width: number;
  height: number;
  durationMs: number;
  clampedMs: number;
  bboxUpdates: CellBboxSidecarUpdate[];
}> {
  if (timestampsMs.length === 0) return [];

  const verification = verifySequence(seq, paths, ["G1_SCHEMA", "G2_ASSETS", "G3_TIMING"]);
  if (!verification.ok) {
    const firstErr = verification.diagnostics.find((d) => d.severity === "ERROR")!;
    throw new CutholError(firstErr);
  }

  const totalDurationMs = computeRenderDurationMs(seq);
  const fps = Math.max(1, seq.stage.fps);
  const lastFrameIdx = Math.max(0, Math.floor((totalDurationMs / 1000) * fps - 1));
  const maxSafeMs = Math.max(0, Math.floor(lastFrameIdx * (1000 / fps)));
  const frameDurMs = 1000 / fps;

  const templateBySignature = new Map<
    string,
    {
      basePlan: CompiledRenderPlan;
      blobPrefixes: string[];
      inputArgPositions: number[];
    }
  >();

  const plans: SingleFrameFfmpegPlan[] = timestampsMs.map((atMs) => {
    const clampedMs = Math.max(0, Math.min(Math.round(atMs), maxSafeMs));
    const frameIdx = Math.max(0, Math.min(lastFrameIdx, Math.floor((clampedMs / 1000) * fps + 1e-6)));
    const exactFrameMs = (frameIdx * 1000) / fps;

    const activeInfo = resolveActiveCompositionRefsAt(seq, paths, exactFrameMs, fps);
    let compiledPlan: CompiledRenderPlan | null = null;

    if (activeInfo.canReuseTemplate) {
      const cachedTpl = templateBySignature.get(activeInfo.signature);
      if (cachedTpl && cachedTpl.blobPrefixes.length === activeInfo.refs.length) {
        const nextPngPaths: string[] = [];
        let allCached = true;
        for (let k = 0; k < activeInfo.refs.length; k++) {
          const candidatePng = `${cachedTpl.blobPrefixes[k]}${activeInfo.refs[k].compFrameIdx}.png`;
          if (!fs.existsSync(candidatePng) || fs.statSync(candidatePng).size <= 200) {
            allCached = false;
            break;
          }
          nextPngPaths.push(candidatePng);
        }
        if (allCached) {
          const clonedInputArgs = [...cachedTpl.basePlan.inputArgs];
          for (let k = 0; k < cachedTpl.inputArgPositions.length; k++) {
            clonedInputArgs[cachedTpl.inputArgPositions[k]] = nextPngPaths[k];
          }
          compiledPlan = {
            ...cachedTpl.basePlan,
            inputArgs: clonedInputArgs,
            hyperframesBlobs: nextPngPaths,
          };
        }
      }
    }

    if (!compiledPlan) {
      compiledPlan = compileSequenceRenderPlan(seq, paths, preset, {
        activeWindowMs: [exactFrameMs - 1e-3, exactFrameMs + frameDurMs],
        singleFrameAtMs: exactFrameMs,
      });

      if (
        activeInfo.canReuseTemplate &&
        compiledPlan.hyperframesBlobs.length === activeInfo.refs.length
      ) {
        const blobPrefixes: string[] = [];
        const inputArgPositions: number[] = [];
        let validTemplate = true;
        for (let k = 0; k < compiledPlan.hyperframesBlobs.length; k++) {
          const blobPath = compiledPlan.hyperframesBlobs[k];
          const m = /^(.*hf_frame_[0-9a-f]+_f)\d+\.png$/i.exec(blobPath);
          const pos = compiledPlan.inputArgs.indexOf(blobPath);
          if (!m || pos < 0) {
            validTemplate = false;
            break;
          }
          blobPrefixes.push(m[1]);
          inputArgPositions.push(pos);
        }
        if (validTemplate) {
          templateBySignature.set(activeInfo.signature, {
            basePlan: compiledPlan,
            blobPrefixes,
            inputArgPositions,
          });
        }
      }
    }

    const bboxTargets: Array<{ bboxPath: string; pngPath: string }> = [];
    if (
      timestampsMs.length > 1 &&
      activeInfo.canReuseTemplate &&
      compiledPlan.hyperframesBlobs.length === activeInfo.refs.length
    ) {
      for (let k = 0; k < activeInfo.refs.length; k++) {
        const bboxPath = activeInfo.refs[k].bboxPath;
        const pngPath = compiledPlan.hyperframesBlobs[k];
        if (bboxPath && pngPath) {
          bboxTargets.push({ bboxPath, pngPath });
        }
      }
    }

    return buildSingleFrameFfmpegPlanFromCompiledPlan(
      compiledPlan,
      paths,
      fps,
      frameIdx,
      clampedMs,
      bboxTargets
    );
  });

  const bboxJsonByPng = new Map<string, string | null>();
  const uncachedBboxPngs: string[] = [];
  const bboxPngSet = new Set<string>();
  for (const p of plans) {
    for (const bt of p.bboxTargets) {
      if (bboxPngSet.has(bt.pngPath)) continue;
      bboxPngSet.add(bt.pngPath);
      const cachedBboxFile = `${bt.pngPath}.bbox.json`;
      if (fs.existsSync(cachedBboxFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(cachedBboxFile, "utf8"));
          bboxJsonByPng.set(bt.pngPath, parsed.bboxJson ?? null);
          continue;
        } catch {
          // recompute below
        }
      }
      uncachedBboxPngs.push(bt.pngPath);
    }
  }

  const frameJobs: ParallelFfmpegJob[] = plans.map((p) => ({ args: p.ffArgs, cwd: p.cwd }));
  const bboxJobs: ParallelFfmpegJob[] = uncachedBboxPngs.map((pngPath) => ({
    args: [
      "-v",
      "error",
      "-i",
      pngPath,
      "-vf",
      "scale=320:180:flags=neighbor,format=rgba",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    cwd: paths.rootDir,
  }));

  const allJobs = [...frameJobs, ...bboxJobs];
  const allMaxBuffers = [
    ...plans.map((p) => p.pixelCount * 4 + 2 * 1024 * 1024),
    ...uncachedBboxPngs.map(() => 320 * 180 * 4 + 65536),
  ];
  const allResults = runParallelFfmpegJobsSync(allJobs, allMaxBuffers);
  const jobResults = allResults.slice(0, plans.length);
  const bboxResults = allResults.slice(plans.length);

  for (let i = 0; i < uncachedBboxPngs.length; i++) {
    const r = bboxResults[i];
    const bboxJson =
      r && r.status === 0 ? computeAlphaBboxJsonFromRgbaBuffer(r.stdout, 320, 180) : null;
    const pngPath = uncachedBboxPngs[i];
    bboxJsonByPng.set(pngPath, bboxJson);
    try {
      fs.writeFileSync(`${pngPath}.bbox.json`, JSON.stringify({ bboxJson }), "utf8");
    } catch {
      // ignore cache write error
    }
  }

  let fallbackMp4Path: string | null = null;
  return plans.map((p, idx) => {
    const bboxUpdates: CellBboxSidecarUpdate[] = p.bboxTargets.map((bt) => ({
      bboxPath: bt.bboxPath,
      bboxJson: bboxJsonByPng.get(bt.pngPath) ?? null,
    }));

    const res = jobResults[idx];
    if (res && res.status === 0 && res.stdout && res.stdout.length >= p.pixelCount * 3) {
      return {
        rgbBuf: res.stdout.subarray(0, p.pixelCount * 3),
        width: p.width,
        height: p.height,
        durationMs: p.durationMs,
        clampedMs: p.clampedMs,
        bboxUpdates,
      };
    }

    if (!fallbackMp4Path) {
      fallbackMp4Path = ensurePreviewCompositeMp4(seq, paths, preset).mp4Path;
    }
    const fallbackProc = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        (p.clampedMs / 1000).toFixed(3),
        "-i",
        fallbackMp4Path,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { maxBuffer: p.pixelCount * 4 + 1024 * 1024, timeout: 30_000 }
    );
    const fbBuf = fallbackProc.stdout as Buffer;
    if (fallbackProc.status !== 0 || !fbBuf || fbBuf.length < p.pixelCount * 3) {
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
          "ffmpeg single frame extract",
          (res?.stderr || fallbackProc.stderr?.toString("utf8") || "extract failed").slice(-400)
        )
      );
    }
    return {
      rgbBuf: fbBuf.subarray(0, p.pixelCount * 3),
      width: p.width,
      height: p.height,
      durationMs: p.durationMs,
      clampedMs: p.clampedMs,
      bboxUpdates,
    };
  });
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
  const res = renderMultipleCompositeFramesRgb24(seq, paths, [atMs], preset)[0];
  return {
    rgbBuf: res.rgbBuf,
    width: res.width,
    height: res.height,
    durationMs: res.durationMs,
    clampedMs: res.clampedMs,
  };
}
