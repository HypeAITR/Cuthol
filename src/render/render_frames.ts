// Single and multiple composite frames at given times for monitor/sheet (split out of renderer.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ParallelFfmpegJob,
  type ParallelFfmpegJobResult,
  runWatchedParallelFfmpegJobsSync,
  spawnWatchedSync,
} from "../core/subprocess.js";
import {
  computeRenderDurationMs, resolveCueStartMs
} from "../core/timeline.js";
import {
  CompiledRenderPlan, compileSequenceRenderPlan,
  RenderPreset
} from "../compositor/compiler.js";
import {
  createSubprocessFailureDiagnostic, CutholError
} from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { verifySequence } from "../verify/gates.js";
import { ensurePreviewCompositeMp4 } from "./render_preview.js";

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

export function runParallelFfmpegJobsSync(
  jobs: ParallelFfmpegJob[],
  maxBuffers: number[],
  concurrency = Math.max(2, Math.min(os.cpus().length, 12))
): ParallelFfmpegJobResult[] {
  return runWatchedParallelFfmpegJobsSync(jobs, maxBuffers, concurrency);
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
  const shortDurSec = (8 / fps).toFixed(6);

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
      const leadFrame = Math.max(0, Math.floor(Math.max(0, frameIdx - 2) / 3) * 3);
      const leadStartSec = (leadFrame / fps).toFixed(6);
      const hfSingleFrameRe = new RegExp(
        `\\[${idx}:v\\]([\\s\\S]*?)tpad=stop_mode=clone:stop_duration=[\\d.]+,settb=AVTB,setpts=PTS-STARTPTS\\+([\\d.]+)/TB(\\[v_hf_[^\\]]+\\])`
      );
      if (hfSingleFrameRe.test(videoFilterComplex)) {
        // Decode the HyperFrames single-frame PNG once instead of re-decoding via `-loop 1`,
        // and pad for 8 frames (`shortDurSec`) so `frameIdx - leadFrame <= 4` never hits EOF on `3k + 1` frames.
        videoInputGroups[idx] = ["-framerate", fpsVal, "-i", inputPath];
        videoFilterComplex = videoFilterComplex.replace(
          hfSingleFrameRe,
          (_m, midFilters: string, cueStartSecStr: string, outPad: string) => {
            const localSecVal = Math.max(0, Number(snappedSec) - Number(cueStartSecStr)).toFixed(6);
            return `[${idx}:v]settb=AVTB,setpts=PTS+${localSecVal}/TB,${midFilters}tpad=stop_mode=clone:stop_duration=${shortDurSec},settb=AVTB,setpts=PTS-STARTPTS+${leadStartSec}/TB${outPad}`;
          }
        );
      }
    }
  }

  const optimizedInputArgs = videoInputGroups.flat();
  const filterWithSelect = `${videoFilterComplex};${plan.videoOutPad}trim=start=${snappedSec},setpts=PTS-STARTPTS,scale=in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24[v_single_out]`;

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
            stalled: res.stalled,
            stalledMs: res.stalledMs,
            stallThresholdMs: res.stallThresholdMs,
            lastProgress: res.lastProgress,
            commandSummary: res.commandSummary,
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
      "-vf",
      "scale=flags=accurate_rnd+full_chroma_int:in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ];
    const fallbackProc = spawnWatchedSync("ffmpeg", fallbackArgs, {
      maxBuffer: p.pixelCount * 4 + 1024 * 1024,
      step: "ffmpeg single frame extract",
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
