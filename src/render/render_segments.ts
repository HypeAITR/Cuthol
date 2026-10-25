// Time segments for long timelines and the segmented audio build (split out of renderer.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ParallelFfmpegJob
} from "../core/subprocess.js";
import {
  computeRenderDurationMs, resolveCueStartMs
} from "../core/timeline.js";
import {
  CompiledAudioPlan, compileSequenceAudioPlan
} from "../compositor/compiler.js";
import {
  createSubprocessFailureDiagnostic, CutholError, estimateCommandLineLength
} from "../core/diagnostics.js";
import {
  resolveMaxClipsPerRenderSegment
} from "../core/env.js";
import { CutholSequence } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { runParallelFfmpegJobsSync } from "./render_frames.js";

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

export function escapeConcatFilePath(filePath: string): string {
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
  return `${inputPad}aformat=sample_rates=48000:channel_layouts=stereo,${gainStage}alimiter=limit=${limiterLimit}:level=disabled:latency=1,apad=pad_dur=0.006${outputPad}`;
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
        step: "ffmpeg audio segment",
        watchedPaths: [t.tmpWavPath],
        cleanupPathsOnStall: [t.tmpWavPath],
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
                stalled: r?.stalled,
                stalledMs: r?.stalledMs,
                stallThresholdMs: r?.stallThresholdMs,
                lastProgress: r?.lastProgress,
                commandSummary: r?.commandSummary,
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
