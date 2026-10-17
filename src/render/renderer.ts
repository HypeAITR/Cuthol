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
import {
  CompiledAudioPlan,
  CompiledRenderPlan,
  compileSequenceAudioPlan,
  compileSequenceRenderPlan,
  RenderPreset,
} from "../compositor/compiler.js";
import {
  renderHyperFramesBatchFramesPng,
  shouldUseNvencForRender,
} from "../compositor/hyperframes_bridge.js";
import {
  createSubprocessFailureDiagnostic,
  CutholDiagnostic,
  CutholError,
  DIAGNOSTICS,
  estimateCommandLineLength,
} from "../core/diagnostics.js";
import { resolveHyperFramesWorkers, resolveMaxClipsPerRenderSegment } from "../core/env.js";
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

export interface RenderEncoderFallback {
  from: "h264_nvenc";
  to: "libx264";
  reason: string;
}

export interface RenderStageTimingsMs {
  verify_ms: number;
  compile_and_overlays_ms: number;
  encode_ms: number;
  blank_scan_ms: number;
  total_ms: number;
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
  encoder: "h264_nvenc" | "libx264";
  encoder_fallback: RenderEncoderFallback | null;
  workers: number;
  single_stage: boolean;
  timings_ms: RenderStageTimingsMs;
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
/**
 * Detects a black strip along the right or bottom edge of the render. Some ffmpeg builds zero the last
 * columns when converting planar RGB to yuv420p at widths that are not a multiple of 16 (e.g. 1080); the
 * opaque HyperFrames render path works around it by rewriting that conversion. This check keeps a
 * regression (for example after a HyperFrames update) from shipping silently. Samples a few frames and
 * compares the outer 8 px with the 8 px just inside.
 */
export function scanRenderedMp4ForEdgeStrips(
  mp4Path: string,
  durationMs: number,
  samples = 5
): CutholDiagnostic | null {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", mp4Path],
    { encoding: "utf8", timeout: 15_000 }
  );
  const [w, h] = String(probe.stdout || "").trim().split(",").map(Number);
  if (!(w > 32 && h > 32)) return null;

  const strip = 8;
  const regions = {
    right: { outer: `crop=${strip}:${h}:${w - strip}:0`, inner: `crop=${strip}:${h}:${w - 2 * strip}:0` },
    bottom: { outer: `crop=${w}:${strip}:0:${h - strip}`, inner: `crop=${w}:${strip}:0:${h - 2 * strip}` },
  };
  const meanLuma = (atSec: number, crop: string): number | null => {
    const proc = spawnSync(
      "ffmpeg",
      ["-v", "error", "-ss", atSec.toFixed(3), "-i", mp4Path, "-frames:v", "1", "-vf", `${crop},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
      { maxBuffer: 1024, timeout: 15_000 }
    );
    const buf = proc.stdout as Buffer;
    return proc.status === 0 && buf && buf.length >= 1 ? buf[0] : null;
  };

  const affected: string[] = [];
  for (const [edge, crops] of Object.entries(regions)) {
    let hits = 0;
    let checked = 0;
    for (let i = 0; i < samples; i++) {
      const atSec = ((i + 0.5) / samples) * (durationMs / 1000);
      const outer = meanLuma(atSec, crops.outer);
      const inner = meanLuma(atSec, crops.inner);
      if (outer === null || inner === null) continue;
      checked += 1;
      if (outer <= 4 && inner >= 24) hits += 1;
    }
    if (checked > 0 && hits >= Math.max(2, Math.ceil(checked * 0.6))) affected.push(edge);
  }
  return affected.length > 0 ? DIAGNOSTICS.RENDER_EDGE_STRIP(affected, w, h) : null;
}

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

function buildVideoCodecArgs(
  encoder: "h264_nvenc" | "libx264",
  preset: RenderPreset
): string[] {
  if (encoder === "h264_nvenc") {
    return preset === "draft_480p"
      ? ["-c:v", "h264_nvenc", "-preset", "p1", "-rc", "vbr", "-cq", "24", "-b:v", "0", "-pix_fmt", "yuv420p"]
      : [
          "-c:v",
          "h264_nvenc",
          "-preset",
          "p4",
          "-tune",
          "hq",
          "-rc",
          "vbr",
          "-cq",
          "22",
          "-b:v",
          "0",
          "-pix_fmt",
          "yuv420p",
        ];
  }
  return [
    "-c:v",
    "libx264",
    "-preset",
    preset === "draft_480p" ? "ultrafast" : "fast",
    "-crf",
    preset === "draft_480p" ? "24" : "19",
    "-pix_fmt",
    "yuv420p",
  ];
}

export interface RenderTimeSegment {
  index: number;
  startFrame: number;
  endFrame: number;
  frameCount: number;
  startMs: number;
  endMs: number;
}

export function computeRenderTimeSegments(
  seq: CutholSequence,
  totalDurationMs: number,
  maxItemsPerSegment = resolveMaxClipsPerRenderSegment()
): RenderTimeSegment[] {
  const fps = Math.max(1, seq.stage.fps);
  const totalFrames = Math.max(1, Math.ceil((totalDurationMs / 1000) * fps - 1e-6));

  const itemIntervalsMs: Array<[number, number]> = [];
  for (let i = 0; i < seq.spine.clips.length; i++) {
    const c = seq.spine.clips[i];
    const hasNext = i < seq.spine.clips.length - 1;
    const holdTail =
      hasNext && c.transition_out && c.transition_out.kind !== "fade"
        ? c.transition_out.duration_ms
        : 0;
    itemIntervalsMs.push([c.timeline_in_ms, c.timeline_in_ms + c.duration_ms + holdTail]);
  }
  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (!cue.asset_handle && cue.kind !== "composition") continue;
      const st = resolveCueStartMs(seq, cue);
      itemIntervalsMs.push([st, st + cue.duration_ms]);
    }
  }

  const countOverlappingItems = (winStartMs: number, winEndMs: number): number => {
    let count = 0;
    for (const [st, en] of itemIntervalsMs) {
      if (en > winStartMs + 1e-3 && st < winEndMs - 1e-3) count++;
    }
    return count;
  };

  if (
    seq.spine.clips.length <= maxItemsPerSegment &&
    itemIntervalsMs.length <= maxItemsPerSegment * 2
  ) {
    return [
      {
        index: 0,
        startFrame: 0,
        endFrame: totalFrames,
        frameCount: totalFrames,
        startMs: 0,
        endMs: (totalFrames * 1000) / fps,
      },
    ];
  }

  const boundaryFramesSet = new Set<number>([0, totalFrames]);
  for (const c of seq.spine.clips) {
    const f = Math.max(0, Math.min(totalFrames, Math.round((c.timeline_in_ms / 1000) * fps)));
    boundaryFramesSet.add(f);
  }
  for (const [st] of itemIntervalsMs) {
    const f = Math.max(0, Math.min(totalFrames, Math.round((st / 1000) * fps)));
    boundaryFramesSet.add(f);
  }
  const sortedCandidates = [...boundaryFramesSet].sort((a, b) => a - b);

  const segments: RenderTimeSegment[] = [];
  let curStartFrame = 0;

  while (curStartFrame < totalFrames) {
    const curStartMs = (curStartFrame * 1000) / fps;
    let chosenEndFrame = curStartFrame;

    for (const candFrame of sortedCandidates) {
      if (candFrame <= curStartFrame) continue;
      const candEndMs = (candFrame * 1000) / fps;
      const spineInWin = seq.spine.clips.filter(
        (c) =>
          c.timeline_in_ms + c.duration_ms > curStartMs - 1e-3 &&
          c.timeline_in_ms < candEndMs + 1e-3
      ).length;
      const totalInWin = countOverlappingItems(curStartMs - 1e-3, candEndMs + 1e-3);

      if (
        chosenEndFrame > curStartFrame &&
        (spineInWin > maxItemsPerSegment || totalInWin > maxItemsPerSegment * 2)
      ) {
        break;
      }
      chosenEndFrame = candFrame;
      if (spineInWin >= maxItemsPerSegment || totalInWin >= maxItemsPerSegment * 2) {
        break;
      }
    }

    if (chosenEndFrame <= curStartFrame) {
      chosenEndFrame = Math.min(totalFrames, curStartFrame + Math.max(1, fps * 10));
    }

    segments.push({
      index: segments.length,
      startFrame: curStartFrame,
      endFrame: chosenEndFrame,
      frameCount: chosenEndFrame - curStartFrame,
      startMs: (curStartFrame * 1000) / fps,
      endMs: (chosenEndFrame * 1000) / fps,
    });
    curStartFrame = chosenEndFrame;
  }

  return segments;
}

function escapeConcatFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

function buildMasterAudioPostConcatFilter(
  inputPad: string,
  outputPad: string,
  masterAudio?: CutholSequence["stage"]["master_audio"]
): string {
  const masterGainDb = masterAudio?.gain_db ?? 0;
  const gainStage = Math.abs(masterGainDb) > 0.01 ? `volume=${masterGainDb.toFixed(2)}dB,` : "";
  const limiterLimit = masterAudio
    ? Math.max(
        0.1,
        Math.min(0.98, Math.pow(10, Math.min(-0.1, masterAudio.true_peak_ceiling_dbtp - 0.55) / 20))
      ).toFixed(4)
    : "0.891";
  return `${inputPad}aformat=sample_rates=48000:channel_layouts=stereo,${gainStage}alimiter=limit=${limiterLimit}:level=disabled${outputPad}`;
}

export interface SegmentedAudioBuildResult {
  mode: "direct_plan" | "concat_wav";
  directPlan?: CompiledAudioPlan;
  concatListPath?: string;
  masterFilterComplex?: string;
  audioOutPad: string;
  totalDurationMs: number;
  hasActiveAudio: boolean;
  maxInputsInAnyCall: number;
  maxCommandLengthChars: number;
}

export function buildOrRenderSequenceAudioForMixOrRender(
  seq: CutholSequence,
  paths: WorkspacePaths,
  masterAudio: CutholSequence["stage"]["master_audio"] | undefined,
  options?: {
    minDurationMs?: number;
    maxItemsPerSegment?: number;
    inputIndexOffset?: number;
  }
): SegmentedAudioBuildResult {
  const maxItems = options?.maxItemsPerSegment ?? resolveMaxClipsPerRenderSegment();
  const totalDurationMs = computeRenderDurationMs(seq, options?.minDurationMs ?? 0);
  const segments = computeRenderTimeSegments(seq, totalDurationMs, maxItems);

  if (segments.length <= 1) {
    const directPlan = compileSequenceAudioPlan(seq, paths, masterAudio, {
      inputIndexOffset: options?.inputIndexOffset ?? 0,
      minDurationMs: options?.minDurationMs,
    });
    const inputCount = directPlan.inputArgs.filter((a) => a === "-i").length;
    if (inputCount <= maxItems * 2 + 2) {
      const cmdLen = estimateCommandLineLength("ffmpeg", [
        ...directPlan.inputArgs,
        "-/filter_complex",
        "filter.txt",
      ]);
      return {
        mode: "direct_plan",
        directPlan,
        audioOutPad: directPlan.audioOutPad,
        totalDurationMs: directPlan.totalDurationMs,
        hasActiveAudio: directPlan.hasActiveAudio,
        maxInputsInAnyCall: inputCount,
        maxCommandLengthChars: cmdLen,
      };
    }
  }

  fs.mkdirSync(paths.blobsDir, { recursive: true });
  const libDigests = seq.library.map((x) => `${x.handle}:${x.digest_sha256}`);

  interface AudioSegTask {
    seg: RenderTimeSegment;
    segSamples: number;
    wavPath: string;
    tmpWavPath: string;
    filterPath: string;
    ffArgs: string[];
    inputCount: number;
    cmdLen: number;
    hasActiveAudio: boolean;
    needsEncode: boolean;
  }

  const tasks: AudioSegTask[] = [];
  let anyActiveAudio = false;
  let maxInputsInAnyCall = 1;
  let maxCommandLengthChars = 0;

  for (const seg of segments) {
    const startSample = Math.round((seg.startMs / 1000) * 48000);
    const endSample = Math.round((seg.endMs / 1000) * 48000);
    const segSamples = Math.max(1, endSample - startSample);

    const segPlan = compileSequenceAudioPlan(seq, paths, undefined, {
      activeWindowMs: [seg.startMs, seg.endMs],
      applyMasterFinalize: false,
    });
    if (segPlan.hasActiveAudio) anyActiveAudio = true;

    const segFilter = `${segPlan.filterComplex};${segPlan.audioOutPad}aresample=48000,atrim=start_sample=0:end_sample=${segSamples},asetpts=PTS-STARTPTS[aseg_out]`;
    const segHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          libDigests,
          segSamples,
          inputArgs: segPlan.inputArgs,
          segFilter,
        })
      )
      .digest("hex")
      .slice(0, 16);

    const wavPath = path.join(paths.blobsDir, `aseg_${segHash}.wav`);
    const tmpWavPath = `${wavPath}.${process.pid}.${seg.index}.tmp.wav`;
    const filterPath = `${wavPath}.${process.pid}.${seg.index}.filter.txt`;
    const ffArgs = [
      "-y",
      "-v",
      "error",
      ...segPlan.inputArgs,
      "-/filter_complex",
      filterPath,
      "-map",
      "[aseg_out]",
      "-c:a",
      "pcm_f32le",
      "-ar",
      "48000",
      "-ac",
      "2",
      tmpWavPath,
    ];
    const inputCount = segPlan.inputArgs.filter((a) => a === "-i").length;
    const cmdLen = estimateCommandLineLength("ffmpeg", ffArgs);
    if (inputCount > maxInputsInAnyCall) maxInputsInAnyCall = inputCount;
    if (cmdLen > maxCommandLengthChars) maxCommandLengthChars = cmdLen;

    const cached = fs.existsSync(wavPath) && fs.statSync(wavPath).size > 44;
    tasks.push({
      seg,
      segSamples,
      wavPath,
      tmpWavPath,
      filterPath,
      ffArgs,
      inputCount,
      cmdLen,
      hasActiveAudio: segPlan.hasActiveAudio,
      needsEncode: !cached,
    });
  }

  const pending = tasks.filter((t) => t.needsEncode);
  if (pending.length > 0) {
    for (const t of pending) {
      fs.writeFileSync(t.filterPath, (() => {
        const segPlan = compileSequenceAudioPlan(seq, paths, undefined, {
          activeWindowMs: [t.seg.startMs, t.seg.endMs],
          applyMasterFinalize: false,
        });
        return `${segPlan.filterComplex};${segPlan.audioOutPad}aresample=48000,atrim=start_sample=0:end_sample=${t.segSamples},asetpts=PTS-STARTPTS[aseg_out]`;
      })(), "utf8");
    }
    try {
      const jobs: ParallelFfmpegJob[] = pending.map((t) => ({
        args: t.ffArgs,
        cwd: paths.rootDir,
      }));
      const results = runParallelFfmpegJobsSync(
        jobs,
        pending.map(() => 16 * 1024 * 1024),
        Math.max(2, Math.min(os.cpus().length, 6))
      );
      for (let i = 0; i < pending.length; i++) {
        const t = pending[i];
        const r = results[i];
        if (!r || r.status !== 0 || r.error || !fs.existsSync(t.tmpWavPath)) {
          if (fs.existsSync(t.tmpWavPath)) {
            try {
              fs.unlinkSync(t.tmpWavPath);
            } catch {
              // ignore
            }
          }
          throw new CutholError(
            createSubprocessFailureDiagnostic({
              tool: "ffmpeg audio segment",
              executable: "ffmpeg",
              args: t.ffArgs,
              proc: {
                status: r?.status ?? null,
                error: r?.error,
                stderr: r?.stderr ?? "",
              },
              clipCount: seq.spine.clips.length,
              fallbackDetail: `audio segment #${t.seg.index} failed`,
            })
          );
        }
        fs.renameSync(t.tmpWavPath, t.wavPath);
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

  const concatLines = tasks.map((t) => `file '${escapeConcatFilePath(t.wavPath)}'`).join("\n") + "\n";
  const concatHash = crypto.createHash("sha256").update(concatLines).digest("hex").slice(0, 14);
  const concatListPath = path.join(paths.blobsDir, `aconcat_${concatHash}.txt`);
  fs.writeFileSync(concatListPath, concatLines, "utf8");

  const inIdx = options?.inputIndexOffset ?? 0;
  const audioOutPad = "[aout]";
  const masterFilterComplex = buildMasterAudioPostConcatFilter(
    `[${inIdx}:a]`,
    audioOutPad,
    masterAudio
  );

  return {
    mode: "concat_wav",
    concatListPath,
    masterFilterComplex,
    audioOutPad,
    totalDurationMs,
    hasActiveAudio: anyActiveAudio,
    maxInputsInAnyCall,
    maxCommandLengthChars,
  };
}

export function renderSequenceToMp4(options: {
  workspaceDir: string;
  outputPath?: string;
  preset?: RenderPreset;
  workers?: number;
  encoder?: "auto" | "nvenc" | "libx264";
}): RenderOutputSummary {
  const tTotal0 = Date.now();
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const tVerify0 = Date.now();
  const verification = verifySequence(sequence, paths);
  const verifyMs = Date.now() - tVerify0;
  if (!verification.ok) {
    const firstErr = verification.diagnostics.find((d) => d.severity === "ERROR")!;
    throw new CutholError(firstErr);
  }
  // An empty sequence would only produce a short clip of backdrop colour; refuse instead of writing it.
  if (computeSequenceDurationMs(sequence) <= 0) {
    throw new CutholError(DIAGNOSTICS.EMPTY_SEQUENCE("ERROR"));
  }

  const preset: RenderPreset = options.preset ?? "master_1080p";
  const workers = resolveHyperFramesWorkers(options.workers);
  const nvencDecision = shouldUseNvencForRender(options.encoder);
  let activeEncoder: "h264_nvenc" | "libx264" = nvencDecision.useNvenc ? "h264_nvenc" : "libx264";
  let encoderFallback: RenderEncoderFallback | null = nvencDecision.fallbackReason
    ? { from: "h264_nvenc", to: "libx264", reason: nvencDecision.fallbackReason }
    : null;

  const defaultOut = path.join(paths.rootDir, "output", `render_r${sequence.meta.revision}_${preset}.mp4`);
  const resolvedOut = options.outputPath
    ? path.isAbsolute(options.outputPath)
      ? options.outputPath
      : path.resolve(paths.rootDir, options.outputPath)
    : defaultOut;

  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.mkdirSync(paths.blobsDir, { recursive: true });
  const tmpOut = `${resolvedOut}.${process.pid}.${Date.now()}.tmp.mp4`;

  const totalDurationMs = computeRenderDurationMs(sequence);
  const maxItemsPerSegment = resolveMaxClipsPerRenderSegment();
  const segments = computeRenderTimeSegments(sequence, totalDurationMs, maxItemsPerSegment);

  let compileAndOverlaysMs = 0;
  let encodeMs = 0;
  let singleStageUsed = false;
  let renderWidth = 0;
  let renderHeight = 0;
  let fps = sequence.stage.fps;

  if (segments.length <= 1) {
    const tCompile0 = Date.now();
    // A composition that cannot be rendered throws CUTHOL-G503 from the compiler; nothing is substituted.
    // NVENC is used for Cuthol's own composite encode only; HyperFrames encodes overlays on the CPU
    // (its GPU encode is not faster here and its rate control cannot be set from outside).
    const plan = compileSequenceRenderPlan(sequence, paths, preset, { workers });
    compileAndOverlaysMs = Date.now() - tCompile0;
    renderWidth = plan.renderWidth;
    renderHeight = plan.renderHeight;
    fps = plan.fps;

    let canRemuxDirectBlob = false;
    let directBlobAudioBuild: SegmentedAudioBuildResult | null = null;
    if (plan.directVideoBlobPath && fs.existsSync(plan.directVideoBlobPath)) {
      let blobEncoder: "h264_nvenc" | "libx264" | null = null;
      let blobFallbackReason: string | null = null;
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
        } catch {
          // ignore metadata parse error
        }
      }
      if (blobFallbackReason && activeEncoder === "h264_nvenc") {
        activeEncoder = "libx264";
        encoderFallback = { from: "h264_nvenc", to: "libx264", reason: blobFallbackReason };
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

    const filterScriptPath = `${tmpOut}.filter.txt`;
    const buildRenderFfmpegArgs = (
      encoder: "h264_nvenc" | "libx264",
      useStreamCopy: boolean
    ): string[] => {
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
          ...(useStreamCopy ? ["-c:v", "copy"] : buildVideoCodecArgs(encoder, preset)),
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-movflags",
          "+faststart",
          tmpOut,
        ];
      }

      const useScript =
        plan.filterComplex.length > 4000 ||
        estimateCommandLineLength("ffmpeg", plan.inputArgs) + plan.filterComplex.length > 12000;
      if (useScript) {
        fs.writeFileSync(filterScriptPath, plan.filterComplex, "utf8");
      }
      return [
        "-y",
        "-v",
        "error",
        ...plan.inputArgs,
        ...(useScript
          ? ["-/filter_complex", filterScriptPath]
          : ["-filter_complex", plan.filterComplex]),
        "-map",
        plan.videoOutPad,
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
    };

    const tEncode0 = Date.now();
    singleStageUsed = canRemuxDirectBlob;
    let ffArgs: string[] = buildRenderFfmpegArgs(activeEncoder, singleStageUsed);

    try {
      const proc = spawnSync("ffmpeg", ffArgs, {
        cwd: paths.rootDir,
        encoding: "utf8",
        // No wall-clock limit: a full render scales with sequence length (long videos take hours).
        maxBuffer: 256 * 1024 * 1024,
      });

      let finalProc = proc;
      if (
        (finalProc.status !== 0 || finalProc.error || !fs.existsSync(tmpOut)) &&
        !finalProc.error &&
        (activeEncoder === "h264_nvenc" || singleStageUsed)
      ) {
        if (fs.existsSync(tmpOut)) {
          try {
            fs.unlinkSync(tmpOut);
          } catch {
            // ignore
          }
        }
        const errDetail = (finalProc.stderr || finalProc.stdout || "NVENC encode failed")
          .trim()
          .slice(-240);
        if (activeEncoder === "h264_nvenc") {
          activeEncoder = "libx264";
          encoderFallback = {
            from: "h264_nvenc",
            to: "libx264",
            reason: `h264_nvenc failed at encode time (${errDetail}); fell back to libx264`,
          };
        }
        singleStageUsed = false;
        ffArgs = buildRenderFfmpegArgs("libx264", false);
        finalProc = spawnSync("ffmpeg", ffArgs, {
          cwd: paths.rootDir,
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
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
      if (fs.existsSync(filterScriptPath)) {
        try {
          fs.unlinkSync(filterScriptPath);
        } catch {
          // ignore
        }
      }
    }
  } else {
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
    compileAndOverlaysMs = Date.now() - tCompile0;

    const tEncode0 = Date.now();
    const libDigests = sequence.library.map((x) => `${x.handle}:${x.digest_sha256}`);

    const encodeVideoSegmentsWithEncoder = (
      encoder: "h264_nvenc" | "libx264"
    ): { ok: boolean; segMp4Paths: string[]; firstFailure?: ParallelFfmpegJobResult; failedArgs?: string[] } => {
      interface VideoSegTask {
        seg: RenderTimeSegment;
        plan: CompiledRenderPlan;
        mp4Path: string;
        tmpMp4Path: string;
        filterPath: string;
        ffArgs: string[];
        needsEncode: boolean;
      }

      const vTasks: VideoSegTask[] = segmentVideoPlans.map(({ seg, plan: segPlan }) => {
        const vHash = crypto
          .createHash("sha256")
          .update(
            JSON.stringify({
              libDigests,
              preset,
              encoder,
              w: segPlan.renderWidth,
              h: segPlan.renderHeight,
              fps: segPlan.fps,
              frameCount: seg.frameCount,
              inputArgs: segPlan.inputArgs,
              filterComplex: segPlan.filterComplex,
            })
          )
          .digest("hex")
          .slice(0, 16);

        const mp4Path = path.join(paths.blobsDir, `vseg_${vHash}.mp4`);
        const tmpMp4Path = `${mp4Path}.${process.pid}.${seg.index}.tmp.mp4`;
        const filterPath = `${mp4Path}.${process.pid}.${seg.index}.filter.txt`;
        const ffArgs = [
          "-y",
          "-v",
          "error",
          ...segPlan.inputArgs,
          "-/filter_complex",
          filterPath,
          "-map",
          segPlan.videoOutPad,
          "-frames:v",
          String(seg.frameCount),
          "-r",
          String(segPlan.fps),
          "-fps_mode",
          "cfr",
          "-an",
          ...buildVideoCodecArgs(encoder, preset),
          "-colorspace",
          "bt709",
          "-color_primaries",
          "bt709",
          "-color_trc",
          "bt709",
          "-color_range",
          "tv",
          tmpMp4Path,
        ];
        const cached = fs.existsSync(mp4Path) && fs.statSync(mp4Path).size > 500;
        return {
          seg,
          plan: segPlan,
          mp4Path,
          tmpMp4Path,
          filterPath,
          ffArgs,
          needsEncode: !cached,
        };
      });

      const pending = vTasks.filter((t) => t.needsEncode);
      if (pending.length > 0) {
        for (const t of pending) {
          fs.writeFileSync(t.filterPath, t.plan.filterComplex, "utf8");
        }
        try {
          const concurrency =
            encoder === "h264_nvenc" ? 2 : Math.max(2, Math.min(os.cpus().length, 6));
          const jobs: ParallelFfmpegJob[] = pending.map((t) => ({
            args: t.ffArgs,
            cwd: paths.rootDir,
          }));
          const results = runParallelFfmpegJobsSync(
            jobs,
            pending.map(() => 32 * 1024 * 1024),
            concurrency
          );
          for (let i = 0; i < pending.length; i++) {
            const t = pending[i];
            const r = results[i];
            if (!r || r.status !== 0 || r.error || !fs.existsSync(t.tmpMp4Path)) {
              for (const p of pending) {
                if (fs.existsSync(p.tmpMp4Path)) {
                  try {
                    fs.unlinkSync(p.tmpMp4Path);
                  } catch {
                    // ignore
                  }
                }
              }
              return {
                ok: false,
                segMp4Paths: [],
                firstFailure: r,
                failedArgs: t.ffArgs,
              };
            }
            fs.renameSync(t.tmpMp4Path, t.mp4Path);
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
      };
    };

    let vSegResult = encodeVideoSegmentsWithEncoder(activeEncoder);
    if (!vSegResult.ok && activeEncoder === "h264_nvenc" && !vSegResult.firstFailure?.error) {
      const errDetail = (vSegResult.firstFailure?.stderr || "NVENC segment encode failed")
        .trim()
        .slice(-240);
      activeEncoder = "libx264";
      encoderFallback = {
        from: "h264_nvenc",
        to: "libx264",
        reason: `h264_nvenc failed at encode time (${errDetail}); fell back to libx264`,
      };
      vSegResult = encodeVideoSegmentsWithEncoder("libx264");
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
          },
          clipCount: sequence.spine.clips.length,
          fallbackDetail: "video segment render failed",
        })
      );
    }

    const audioBuild = buildOrRenderSequenceAudioForMixOrRender(
      sequence,
      paths,
      sequence.stage.master_audio,
      { inputIndexOffset: 1, maxItemsPerSegment }
    );

    const vConcatLines =
      vSegResult.segMp4Paths
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
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      tmpOut,
    ];

    try {
      const muxProc = spawnSync("ffmpeg", muxArgs, {
        cwd: paths.rootDir,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
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
  }

  fs.renameSync(tmpOut, resolvedOut);
  const stat = fs.statSync(resolvedOut);
  const tScan0 = Date.now();
  const blankScan = scanRenderedMp4ForBlankFrames(resolvedOut, sequence);
  const blankScanMs = Date.now() - tScan0;
  for (const diag of blankScan.diagnostics) {
    verification.diagnostics.push(diag);
    verification.warning_count += 1;
  }
  const edgeStrip = scanRenderedMp4ForEdgeStrips(resolvedOut, totalDurationMs);
  if (edgeStrip) {
    verification.diagnostics.push(edgeStrip);
    verification.warning_count += 1;
  }

  const totalMs = Date.now() - tTotal0;

  return {
    ok: true,
    output_path: resolvedOut,
    preset,
    width: renderWidth,
    height: renderHeight,
    fps,
    duration_ms: totalDurationMs,
    size_bytes: stat.size,
    encoder: activeEncoder,
    encoder_fallback: encoderFallback,
    workers,
    single_stage: singleStageUsed,
    timings_ms: {
      verify_ms: verifyMs,
      compile_and_overlays_ms: compileAndOverlaysMs,
      encode_ms: encodeMs,
      blank_scan_ms: blankScanMs,
      total_ms: totalMs,
    },
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

  const maxItemsPerSegment = resolveMaxClipsPerRenderSegment();
  const segments = computeRenderTimeSegments(seq, totalDurationMs, maxItemsPerSegment);
  if (segments.length > 1) {
    const rendered = renderSequenceToMp4({
      workspaceDir: paths.rootDir,
      outputPath: cachedMp4,
      preset,
      encoder: "libx264",
    });
    return {
      mp4Path: rendered.output_path,
      width: rendered.width,
      height: rendered.height,
      durationMs: rendered.duration_ms,
    };
  }

  const plan = compileSequenceRenderPlan(seq, paths, preset);

  fs.mkdirSync(paths.blobsDir, { recursive: true });
  const tmpMp4 = path.join(
    paths.blobsDir,
    `preview_comp_${stateHash}.${process.pid}.${Date.now()}.tmp.mp4`
  );
  const filterScriptPath = `${tmpMp4}.filter.txt`;
  const useScript =
    plan.filterComplex.length > 4000 ||
    estimateCommandLineLength("ffmpeg", plan.inputArgs) + plan.filterComplex.length > 12000;
  if (useScript) {
    fs.writeFileSync(filterScriptPath, plan.filterComplex, "utf8");
  }

  const ffArgs: string[] = [
    "-y",
    "-v",
    "error",
    ...plan.inputArgs,
    ...(useScript
      ? ["-/filter_complex", filterScriptPath]
      : ["-filter_complex", plan.filterComplex]),
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

  try {
    const proc = spawnSync("ffmpeg", ffArgs, {
      cwd: paths.rootDir,
      encoding: "utf8",
      // No wall-clock limit: a full render scales with sequence length (long videos take hours).
      maxBuffer: 256 * 1024 * 1024,
    });

    if (proc.status !== 0 || proc.error || !fs.existsSync(tmpMp4)) {
      if (fs.existsSync(tmpMp4)) {
        try {
          fs.unlinkSync(tmpMp4);
        } catch {
          // ignore cleanup error
        }
      }
      throw new CutholError(
        createSubprocessFailureDiagnostic({
          tool: "ffmpeg preview composite",
          executable: "ffmpeg",
          args: ffArgs,
          proc,
          clipCount: seq.spine.clips.length,
          fallbackDetail: "preview composite failed",
        })
      );
    }
  } finally {
    if (fs.existsSync(filterScriptPath)) {
      try {
        fs.unlinkSync(filterScriptPath);
      } catch {
        // ignore
      }
    }
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
          const computeCandidateHash = (
            w: number,
            h: number,
            transparent: boolean,
            backdropDigest: string
          ): string =>
            crypto
              .createHash("sha256")
              .update(recursiveDirHash)
              .update(
                JSON.stringify({
                  entry: cue.composition!.entry_html,
                  w,
                  h,
                  fps,
                  dur: cue.duration_ms,
                  props: cue.composition!.props,
                  transparent,
                  mode: compMode,
                  backdropDigest,
                })
              )
              .digest("hex")
              .slice(0, 16);

          const compHash = computeCandidateHash(
            renderWidth,
            renderHeight,
            cue.composition.transparent,
            ""
          );

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
            const bgColorDigest = `color:${seq.stage.backdrop.color.trim().toLowerCase()}`;
            const candidateSpecs: Array<{ hash: string; needsScale: boolean }> = [
              { hash: compHash, needsScale: false },
              {
                hash: computeCandidateHash(renderWidth, renderHeight, false, bgColorDigest),
                needsScale: false,
              },
              {
                hash: computeCandidateHash(
                  nativeWidth,
                  nativeHeight,
                  cue.composition.transparent,
                  ""
                ),
                needsScale: nativeWidth !== renderWidth || nativeHeight !== renderHeight,
              },
              {
                hash: computeCandidateHash(nativeWidth, nativeHeight, false, bgColorDigest),
                needsScale: nativeWidth !== renderWidth || nativeHeight !== renderHeight,
              },
            ];

            let cachedVideo: string | null = null;
            let extractVf = "format=rgba";
            for (const spec of candidateSpecs) {
              const cMov = path.join(paths.blobsDir, `hf_comp_${spec.hash}.mov`);
              const cMp4 = path.join(paths.blobsDir, `hf_comp_${spec.hash}.mp4`);
              const found =
                fs.existsSync(cMov) && fs.statSync(cMov).size > 1000
                  ? cMov
                  : fs.existsSync(cMp4) && fs.statSync(cMp4).size > 1000
                    ? cMp4
                    : null;
              if (found) {
                cachedVideo = found;
                extractVf = spec.needsScale
                  ? `scale=${renderWidth}:${renderHeight},format=rgba`
                  : "format=rgba";
                break;
              }
            }

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
                  extractVf,
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
  status: number | null;
  stdout: Buffer;
  stderr: string;
  error?: Error;
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
        let proc;
        try {
          proc = spawn("ffmpeg", job.args, {
            cwd: job.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
        } catch (err) {
          resolve({
            status: null,
            stdoutBuf: Buffer.alloc(0),
            stderr: String(err),
            errorCode: err && err.code ? String(err.code) : undefined,
            errorMessage: err && err.message ? String(err.message) : String(err),
          });
          return;
        }
        proc.stdout.on("data", (chunk) => outChunks.push(chunk));
        proc.stderr.on("data", (chunk) => errChunks.push(chunk));
        proc.on("error", (err) => {
          if (settled) return;
          settled = true;
          resolve({
            status: null,
            stdoutBuf: Buffer.alloc(0),
            stderr: String(err),
            errorCode: err && err.code ? String(err.code) : undefined,
            errorMessage: err && err.message ? String(err.message) : String(err),
          });
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
          results[i] = {
            status: res.status,
            stdoutAb: ab,
            stderr: res.stderr,
            errorCode: res.errorCode,
            errorMessage: res.errorMessage,
          };
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
        status: proc.status,
        stdout: (proc.stdout as Buffer) ?? Buffer.alloc(0),
        stderr: proc.stderr ? proc.stderr.toString("utf8") : "",
        error: proc.error,
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
        (r: {
          status: number | null;
          stdoutAb: ArrayBuffer;
          stderr: string;
          errorCode?: string;
          errorMessage?: string;
        }) => {
          let errObj: NodeJS.ErrnoException | undefined;
          if (r.errorCode || r.errorMessage) {
            errObj = new Error(r.errorMessage || r.stderr || "spawn failed");
            if (r.errorCode) errObj.code = r.errorCode;
          }
          return {
            status: r.status,
            stdout: Buffer.from(r.stdoutAb),
            stderr: r.stderr,
            error: errObj,
          };
        }
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
      status: proc.status,
      stdout: (proc.stdout as Buffer) ?? Buffer.alloc(0),
      stderr: proc.stderr ? proc.stderr.toString("utf8") : "",
      error: proc.error,
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
  const shortDurSec = (4 / fps).toFixed(6);

  // Split inputArgs into per-input groups and strip any audio inputs
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

  for (let idx = 0; idx < videoInputGroups.length; idx++) {
    const g = videoInputGroups[idx];
    const loopPos = g.indexOf("-loop");
    const tPos = g.indexOf("-t");
    const frPos = g.indexOf("-framerate");
    const inputPath = g[g.length - 1];
    if (loopPos >= 0 && tPos >= 0 && frPos >= 0 && inputPath?.endsWith(".png")) {
      const fpsVal = g[frPos + 1];
      // Decode the PNG once instead of re-decoding it on every frame via `-loop 1`
      videoInputGroups[idx] = ["-framerate", fpsVal, "-i", inputPath];

      const leadFrame = Math.max(0, Math.floor(Math.max(0, frameIdx - 2) / 3) * 3);
      const leadStartSec = (leadFrame / fps).toFixed(6);
      videoFilterComplex = videoFilterComplex.replace(
        new RegExp(
          `\\[${idx}:v\\]([\\s\\S]*?)tpad=stop_mode=clone:stop_duration=[\\d.]+,settb=AVTB,setpts=PTS-STARTPTS\\+([\\d.]+)/TB(\\[v_hf_[^\\]]+\\])`
        ),
        (_m, midFilters: string, cueStartSecStr: string, outPad: string) => {
          const localSecVal = Math.max(0, Number(snappedSec) - Number(cueStartSecStr)).toFixed(6);
          return `[${idx}:v]settb=AVTB,setpts=PTS+${localSecVal}/TB,${midFilters}tpad=stop_mode=clone:stop_duration=${shortDurSec},settb=AVTB,setpts=PTS-STARTPTS+${leadStartSec}/TB${outPad}`;
        }
      );
    }
  }

  const optimizedInputArgs = videoInputGroups.flat();
  const filterWithSelect = `${videoFilterComplex};${plan.videoOutPad}trim=start=${snappedSec},setpts=PTS-STARTPTS[v_single_out]`;

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
      shortDurSec,
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

  const plans: SingleFrameFfmpegPlan[] = timestampsMs.map((atMs) => {
    const clampedMs = Math.max(0, Math.min(Math.round(atMs), maxSafeMs));
    const frameIdx = Math.max(0, Math.min(lastFrameIdx, Math.floor((clampedMs / 1000) * fps + 1e-6)));
    const exactFrameMs = (frameIdx * 1000) / fps;

    const activeInfo = resolveActiveCompositionRefsAt(seq, paths, exactFrameMs, fps);
    const compiledPlan = compileSequenceRenderPlan(seq, paths, preset, {
      activeWindowMs: [exactFrameMs, exactFrameMs + frameDurMs],
      singleFrameAtMs: exactFrameMs,
      includeAudio: false,
    });

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
    if (res && res.status === 0 && !res.error && res.stdout && res.stdout.length >= p.pixelCount * 3) {
      return {
        rgbBuf: res.stdout.subarray(0, p.pixelCount * 3),
        width: p.width,
        height: p.height,
        durationMs: p.durationMs,
        clampedMs: p.clampedMs,
        bboxUpdates,
      };
    }

    if (res?.error) {
      throw new CutholError(
        createSubprocessFailureDiagnostic({
          tool: "ffmpeg single frame extract",
          executable: "ffmpeg",
          args: p.ffArgs,
          proc: {
            status: res.status,
            error: res.error,
            stderr: res.stderr,
          },
          clipCount: seq.spine.clips.length,
          fallbackDetail: "single frame extract failed",
        })
      );
    }

    if (!fallbackMp4Path) {
      fallbackMp4Path = ensurePreviewCompositeMp4(seq, paths, preset).mp4Path;
    }
    const fallbackArgs = [
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
    ];
    const fallbackProc = spawnSync("ffmpeg", fallbackArgs, {
      maxBuffer: p.pixelCount * 4 + 1024 * 1024,
      timeout: 30_000,
    });
    const fbBuf = fallbackProc.stdout as Buffer;
    if (fallbackProc.status !== 0 || fallbackProc.error || !fbBuf || fbBuf.length < p.pixelCount * 3) {
      throw new CutholError(
        createSubprocessFailureDiagnostic({
          tool: "ffmpeg single frame extract",
          executable: "ffmpeg",
          args: fallbackArgs,
          proc: fallbackProc,
          clipCount: seq.spine.clips.length,
          fallbackDetail: res?.stderr || "extract failed",
        })
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
