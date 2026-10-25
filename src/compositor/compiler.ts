/**
 * Cuthol Multi-Layer Sequence Compositor & Filter-Graph Compiler (`src/compositor/compiler.ts`).
 *
 * Compiles `CutholSequence` (`spine` + `lanes` sorted by `z_index` + HyperFrames compositions
 * + interleaved `.ass` typography + multi-bus audio chain) into an executable FFmpeg filter graph.
 */

import { computeRenderDurationMs } from "../core/timeline.js";
import { CutholSequence } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import {
  ensureLibraryItemVideoProbe,
  isProbeMetadataComplete,
} from "../library/probe.js";
import { compileSequenceAudioPlan } from "./compile_audio.js";
import { StaticStillLayerSpec } from "./compile_backdrop.js";
import { BT709_TO_YUV420P } from "./compile_color.js";
import { compileLane } from "./compile_lane.js";
import { compileSpineClip } from "./compile_spine.js";
export { escapeFfmpegFilterPath, compileEnvelopeToFfmpegExpr } from "./compile_filters.js";
export { buildMasterAudioFinalizeFilter, compileSequenceAudioPlan } from "./compile_audio.js";
export type { CompileAudioOptions, CompiledAudioPlan } from "./compile_audio.js";

export type RenderPreset = "draft_480p" | "master_1080p";

export interface CompiledRenderPlan {
  inputArgs: string[];
  filterComplex: string;
  videoOutPad: string;
  audioOutPad: string;
  totalDurationMs: number;
  renderWidth: number;
  renderHeight: number;
  fps: number;
  assFilePath: string | null;
  assFilePaths: string[];
  hyperframesBlobs: string[];
  directVideoBlobPath?: string | null;
}

export interface CompileSequenceOptions {
  activeWindowMs?: [number, number];
  singleFrameAtMs?: number;
  minDurationMs?: number;
  workers?: number;
  useGpu?: boolean;
  includeAudio?: boolean;
}

export interface DrawnVisualLayer {
  id: string;
  startMs: number;
  endMs: number;
  kind: "still_graphic" | "moving" | "opaque_comp";
  blobPath?: string;
  bakedUnderneathIds?: string[];
  stillSpec?: StaticStillLayerSpec;
}

export interface VideoGraphCompileContext {
  seq: CutholSequence;
  paths: WorkspacePaths;
  preset: RenderPreset;
  compileOptions?: CompileSequenceOptions;
  totalDurationMs: number;
  totalDurationSec: number;
  renderWidth: number;
  renderHeight: number;
  fps: number;
  libMap: Map<string, CutholSequence["library"][number]>;
  inputArgs: string[];
  filterChains: string[];
  hyperframesBlobs: string[];
  assFilePaths: string[];
  drawnVisualLayers: DrawnVisualLayer[];
  nextInputIdx: number;
  addInput: (args: string[]) => number;
  activeWin: [number, number] | undefined;
  winStartMs: number;
  winEndMs: number;
  winLeadStartMs: number;
  winLeadStartSec: string;
  winStartSec: string;
  winEndSec: string;
  winEndPadSec: string;
  currentVideoPad: string;
  vStepCounter: number;
}

function ensureSequenceVideoProbes(seq: CutholSequence, paths: WorkspacePaths): void {
  if (seq.library.some((item) => item.probe.has_video && !isProbeMetadataComplete(item.probe))) {
    let probeLedger: MediaLedger | null = null;
    try {
      for (const item of seq.library) {
        if (item.probe.has_video && !isProbeMetadataComplete(item.probe)) {
          if (!probeLedger && paths?.ledgerFile) {
            try {
              probeLedger = new MediaLedger(paths.ledgerFile);
            } catch {
              // ignore ledger open error
            }
          }
          ensureLibraryItemVideoProbe(item, paths.rootDir, probeLedger);
        }
      }
    } finally {
      probeLedger?.close();
    }
  }
}

function initVideoGraphCompileContext(
  seq: CutholSequence,
  paths: WorkspacePaths,
  preset: RenderPreset,
  compileOptions?: CompileSequenceOptions
): VideoGraphCompileContext {
  const totalDurationMs = computeRenderDurationMs(seq, compileOptions?.minDurationMs ?? 0);
  const totalDurationSec = Number((totalDurationMs / 1000).toFixed(3));

  const scaleFactor = preset === "draft_480p" ? 480 / Math.min(seq.stage.width, seq.stage.height) : 1.0;
  const renderWidth = Math.max(16, Math.round((seq.stage.width * scaleFactor) / 2) * 2);
  const renderHeight = Math.max(16, Math.round((seq.stage.height * scaleFactor) / 2) * 2);
  const fps = seq.stage.fps;

  ensureSequenceVideoProbes(seq, paths);

  const libMap = new Map(seq.library.map((item) => [item.handle, item]));
  const inputArgs: string[] = [];
  const filterChains: string[] = [];
  const hyperframesBlobs: string[] = [];
  const assFilePaths: string[] = [];
  const drawnVisualLayers: DrawnVisualLayer[] = [];

  // Input 0: Stage Backdrop Canvas (use microsecond AVTB so downstream overlays and -t trim never quantize to 1/fps)
  const activeWin = compileOptions?.activeWindowMs;
  const winStartMs = activeWin ? Math.max(0, activeWin[0]) : 0;
  const winEndMs = activeWin ? Math.max(winStartMs + 1, activeWin[1]) : totalDurationMs;
  // Align `winLeadStartSec` to a 3-frame multiple (0.1s at 30fps / 0.125s at 24fps) so `PTS + winLeadStartSec/TB`
  // has zero 1-microsecond AVTB rounding drift relative to a 0-based timeline!
  const winStartFrameApprox = Math.floor((winStartMs / 1000) * Math.max(1, fps) + 1e-6);
  const leadAlignedFrame = activeWin
    ? Math.max(0, Math.floor(Math.max(0, winStartFrameApprox - 2) / 3) * 3)
    : 0;
  const winLeadStartMs = activeWin ? (leadAlignedFrame * 1000) / Math.max(1, fps) : 0;
  const winLeadStartSec = (winLeadStartMs / 1000).toFixed(6);
  const winStartSec = (winStartMs / 1000).toFixed(6);
  const winEndSec = (winEndMs / 1000).toFixed(6);
  const winEndPadSec = ((winEndMs + 2000 / Math.max(1, fps)) / 1000).toFixed(6);
  const bgDurationSec = activeWin
    ? Number(
        (
          Math.max(1 / Math.max(1, fps), (winEndMs - winLeadStartMs) / 1000) +
          3 / Math.max(1, fps)
        ).toFixed(6)
      )
    : totalDurationSec;

  const ctx: VideoGraphCompileContext = {
    seq,
    paths,
    preset,
    compileOptions,
    totalDurationMs,
    totalDurationSec,
    renderWidth,
    renderHeight,
    fps,
    libMap,
    inputArgs,
    filterChains,
    hyperframesBlobs,
    assFilePaths,
    drawnVisualLayers,
    nextInputIdx: 0,
    addInput: (args: string[]): number => {
      ctx.inputArgs.push(...args);
      return ctx.nextInputIdx++;
    },
    activeWin,
    winStartMs,
    winEndMs,
    winLeadStartMs,
    winLeadStartSec,
    winStartSec,
    winEndSec,
    winEndPadSec,
    currentVideoPad: "",
    vStepCounter: 0,
  };

  const bgHex = seq.stage.backdrop.color.replace(/^#/, "0x");
  const bgInputIdx = ctx.addInput([
    "-f",
    "lavfi",
    "-i",
    `color=c=${bgHex}:s=${renderWidth}x${renderHeight}:r=${fps}:d=${bgDurationSec},format=rgb24,${BT709_TO_YUV420P},settb=AVTB`,
  ]);

  ctx.currentVideoPad = `[${bgInputIdx}:v]`;
  if (activeWin && winLeadStartMs > 0) {
    const bgWinPad = `[vc_${++ctx.vStepCounter}]`;
    ctx.filterChains.push(
      `${ctx.currentVideoPad}settb=AVTB,setpts=PTS+${winLeadStartSec}/TB${bgWinPad}`
    );
    ctx.currentVideoPad = bgWinPad;
  }

  return ctx;
}

function resolveDirectVideoBlobPath(ctx: VideoGraphCompileContext): string | null {
  const { compileOptions, assFilePaths, drawnVisualLayers, fps, totalDurationMs } = ctx;
  // Determine if the entire sequence visual output is satisfied by a single full-frame opaque HyperFrames MP4 blob
  let directVideoBlobPath: string | null = null;
  if (
    compileOptions?.singleFrameAtMs === undefined &&
    !compileOptions?.activeWindowMs &&
    assFilePaths.length === 0
  ) {
    const opaqueComps = drawnVisualLayers.filter((l) => l.kind === "opaque_comp" && l.blobPath);
    if (opaqueComps.length === 1) {
      const compLayer = opaqueComps[0];
      const bakedSet = new Set(compLayer.bakedUnderneathIds ?? []);
      const otherLayers = drawnVisualLayers.filter(
        (l) => l.id !== compLayer.id && !bakedSet.has(l.id)
      );
      const frameToleranceMs = Math.ceil(1000 / Math.max(1, fps)) + 1;
      if (
        otherLayers.length === 0 &&
        compLayer.startMs === 0 &&
        Math.abs(compLayer.endMs - totalDurationMs) <= frameToleranceMs &&
        compLayer.blobPath
      ) {
        directVideoBlobPath = compLayer.blobPath;
      }
    }
  }
  return directVideoBlobPath;
}

export function compileSequenceRenderPlan(
  seq: CutholSequence,
  paths: WorkspacePaths,
  preset: RenderPreset = "master_1080p",
  compileOptions?: CompileSequenceOptions
): CompiledRenderPlan {
  const ctx = initVideoGraphCompileContext(seq, paths, preset, compileOptions);

  const sortedLanes = [...seq.lanes].sort((a, b) => a.z_index - b.z_index);
  const underSpineLanes = sortedLanes.filter((l) => l.z_index < 0);
  const overSpineLanes = sortedLanes.filter((l) => l.z_index >= 0);

  // --- 1a. Compile Under-Spine Lanes (`z_index < 0`) ---
  for (const lane of underSpineLanes) {
    compileLane(ctx, lane);
  }

  // --- 1b. Compile Primary Spine Clips (`z_index === 0`) ---
  for (let i = 0; i < seq.spine.clips.length; i++) {
    compileSpineClip(ctx, i);
  }

  // --- 2. Compile Over-Spine Parallel Lanes Sorted by z_index (`z_index >= 0`) ---
  for (const lane of overSpineLanes) {
    compileLane(ctx, lane);
  }

  const directVideoBlobPath = resolveDirectVideoBlobPath(ctx);

  // Finalize Video Output Pad (preserve AVTB so FFmpeg -t duration trim does not round down to 1/fps)
  const finalVideoPad = "[vout]";
  if (ctx.activeWin && compileOptions?.singleFrameAtMs === undefined) {
    ctx.filterChains.push(
      `${ctx.currentVideoPad}trim=start=${ctx.winStartSec}:end=${ctx.winEndSec},setpts=PTS-STARTPTS,${BT709_TO_YUV420P},settb=AVTB${finalVideoPad}`
    );
  } else {
    ctx.filterChains.push(`${ctx.currentVideoPad}${BT709_TO_YUV420P},settb=AVTB${finalVideoPad}`);
  }

  // --- 3. Compile Audio Graph via the single shared `compileSequenceAudioPlan` ---
  const shouldIncludeAudio =
    compileOptions?.includeAudio !== false && compileOptions?.singleFrameAtMs === undefined;
  let audioOutPad = "[aout]";
  if (shouldIncludeAudio) {
    const audioPlan = compileSequenceAudioPlan(seq, paths, seq.stage.master_audio, {
      inputIndexOffset: ctx.nextInputIdx,
      minDurationMs: compileOptions?.minDurationMs,
      activeWindowMs: compileOptions?.activeWindowMs,
    });
    ctx.inputArgs.push(...audioPlan.inputArgs);
    ctx.filterChains.push(audioPlan.filterComplex);
    audioOutPad = audioPlan.audioOutPad;
  }

  return {
    inputArgs: ctx.inputArgs,
    filterComplex: ["sws_flags=accurate_rnd+full_chroma_int", ...ctx.filterChains].join(";"),
    videoOutPad: finalVideoPad,
    audioOutPad,
    totalDurationMs: ctx.totalDurationMs,
    renderWidth: ctx.renderWidth,
    renderHeight: ctx.renderHeight,
    fps: ctx.fps,
    assFilePath: ctx.assFilePaths[0] ?? null,
    assFilePaths: ctx.assFilePaths,
    hyperframesBlobs: ctx.hyperframesBlobs,
    directVideoBlobPath,
  };
}
