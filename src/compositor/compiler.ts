/**
 * Cuthol Multi-Layer Sequence Compositor & Filter-Graph Compiler (`src/compositor/compiler.ts`).
 *
 * Compiles `CutholSequence` (`spine` + `lanes` sorted by `z_index` + HyperFrames compositions
 * + interleaved `.ass` typography + multi-bus audio chain) into an executable FFmpeg filter graph.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { computeRenderDurationMs, resolveCueStartMs } from "../core/timeline.js";
import { CutholSequence, getCuePlaybackRate, isStillGraphic, maxSourceDurationMs, ParameterEnvelope, TransitionSpec } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { resolveLibraryItemPath } from "../library/probe.js";
import { sequenceMsToSourceMs } from "../sequence/spine.js";
import { compileTypographyAssFile } from "./ass_generator.js";
import { syncCompositionBridgeFiles } from "./bridge_exporter.js";
import {
  renderHyperFramesCompositionToMp4,
  renderHyperFramesSingleFramePng,
} from "./hyperframes_bridge.js";

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
}

function buildAtempoChain(rate: number): string[] {
  const filters: string[] = [];
  let r = Math.max(0.1, Math.min(16.0, rate));
  while (r > 2.0) {
    filters.push("atempo=2.0");
    r /= 2.0;
  }
  while (r < 0.5) {
    filters.push("atempo=0.5");
    r /= 0.5;
  }
  if (Math.abs(r - 1.0) > 0.001) {
    filters.push(`atempo=${r.toFixed(4)}`);
  }
  return filters;
}

export function escapeFfmpegFilterPath(relPath: string): string {
  return relPath
    .replace(/\\/g, "/")
    .replace(/([:\\',;[\]])/g, "\\$1");
}

/**
 * Compiles a `ParameterEnvelope` into a deterministic piecewise FFmpeg expression
 * evaluated over `t` (in seconds), supporting `linear`, `ease_in`, `ease_out`, and `ease_in_out`.
 */
export function compileEnvelopeToFfmpegExpr(options: {
  envelope: ParameterEnvelope | undefined;
  timeBaseOffsetMs: number;
  mode: "pixel_offset" | "db_to_linear" | "raw";
  baseCenterPx?: number;
  canvasDimPx?: number;
  baseGainDb?: number;
}): string | null {
  const env = options.envelope;
  if (!env || env.points.length === 0) return null;

  const mapVal = (v: number): number => {
    if (options.mode === "db_to_linear") {
      const totalDb = (options.baseGainDb ?? 0) + v;
      return Number(Math.pow(10, totalDb / 20).toFixed(4));
    }
    if (options.mode === "raw") {
      return Number(v.toFixed(4));
    }
    const center = options.baseCenterPx ?? 0;
    const dim = options.canvasDimPx ?? 1000;
    return Math.round(center + (v / 100) * dim);
  };

  const pts = env.points.map((p) => ({
    tSec: Number(((options.timeBaseOffsetMs + p.offset_ms) / 1000).toFixed(3)),
    val: mapVal(p.value),
    dbVal: Number(((options.baseGainDb ?? 0) + p.value).toFixed(4)),
    easing: p.easing,
  }));

  if (pts.length === 1) {
    return String(pts[0].val);
  }

  // Build nested `if(lt(t, t1), easedLerp, ...)` from right to left (easing + dB-space interpolation)
  let expr = String(pts[pts.length - 1].val);
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i];
    const b = pts[i + 1];
    const dt = Math.max(0.001, Number((b.tSec - a.tSec).toFixed(3)));
    const dv = Number((b.val - a.val).toFixed(4));
    const uExpr = `((t-${a.tSec})/${dt})`;

    let easedU = uExpr;
    if (b.easing === "ease_in") {
      easedU = `pow(${uExpr},2)`;
    } else if (b.easing === "ease_out") {
      easedU = `(1-pow(1-${uExpr},2))`;
    } else if (b.easing === "ease_in_out") {
      easedU = `(pow(${uExpr},2)*(3-2*${uExpr}))`;
    }

    let segExpr: string;
    if (options.mode === "db_to_linear") {
      const dDb = Number((b.dbVal - a.dbVal).toFixed(4));
      segExpr =
        Math.abs(dDb) < 1e-4
          ? String(a.val)
          : `pow(10,(${a.dbVal}+(${dDb})*${easedU})/20)`;
    } else {
      segExpr =
        Math.abs(dv) < 1e-4
          ? String(a.val)
          : `${a.val}+(${dv})*${easedU}`;
    }
    expr = `if(lt(t,${b.tSec}),${segExpr},${expr})`;
  }
  expr = `if(lt(t,${pts[0].tSec}),${pts[0].val},${expr})`;
  return expr;
}

export interface CompileSequenceOptions {
  activeWindowMs?: [number, number];
  singleFrameAtMs?: number;
  minDurationMs?: number;
}

export interface CompileAudioOptions {
  inputIndexOffset?: number;
  minDurationMs?: number;
}

export interface CompiledAudioPlan {
  inputArgs: string[];
  filterComplex: string;
  audioOutPad: string;
  totalDurationMs: number;
  hasActiveAudio: boolean;
}

function buildSingleAudioTrackFilterChain(options: {
  inputIdx: number;
  outputPad: string;
  srcInSec: string;
  srcOutSec: string;
  effectiveRate: number;
  preservePitch?: boolean;
  sampleRate?: number | null;
  audioChain: CutholSequence["spine"]["clips"][number]["audio_chain"] | undefined;
  envelopes: ParameterEnvelope[];
  postTrimDurationMs: number;
  timelineStartMs: number;
  totalDurationSec: number;
}): string {
  const rateFilters =
    options.preservePitch === false && Math.abs(options.effectiveRate - 1.0) > 0.001
      ? (() => {
          const sr = options.sampleRate && options.sampleRate > 0 ? options.sampleRate : 48000;
          const pitchedRate = Math.max(4000, Math.min(384000, Math.round(sr * options.effectiveRate)));
          return [`asetrate=${pitchedRate}`, `aresample=${sr}`, `asetpts=PTS-STARTPTS`];
        })()
      : buildAtempoChain(options.effectiveRate);

  const aFilters: string[] = [
    `atrim=start=${options.srcInSec}:end=${options.srcOutSec}`,
    `asetpts=PTS-STARTPTS`,
    ...rateFilters,
  ];

  const ac = options.audioChain;
  if (ac) {
    if (ac.denoise.enabled) {
      aFilters.push(
        `afftdn=nr=${ac.denoise.nr_db.toFixed(1)}:nf=${ac.denoise.noise_floor_db.toFixed(1)}`
      );
    }
    if (ac.voice_clarity.enabled) {
      const compRatio = Math.max(1.0, Math.min(20.0, ac.voice_clarity.compressor_ratio));
      aFilters.push(
        `highpass=f=${ac.voice_clarity.highpass_hz}`,
        `equalizer=f=3000:t=q:w=1.2:g=${ac.voice_clarity.presence_boost_db.toFixed(1)}`,
        `acompressor=threshold=-18dB:ratio=${compRatio.toFixed(1)}:attack=15:release=150:makeup=2dB`
      );
    }
    const gainEnv = options.envelopes.find((e) => e.parameter === "audio_chain.gain_db");
    const gainExpr = compileEnvelopeToFfmpegExpr({
      envelope: gainEnv,
      timeBaseOffsetMs: 0,
      mode: "db_to_linear",
      baseGainDb: ac.gain_db,
    });
    if (gainExpr) {
      aFilters.push(`volume='${gainExpr}':eval=frame`);
    } else if (Math.abs(ac.gain_db) > 0.01) {
      aFilters.push(`volume=${ac.gain_db.toFixed(2)}dB`);
    }
    if (ac.fade_in_ms > 0) {
      aFilters.push(`afade=t=in:st=0:d=${(ac.fade_in_ms / 1000).toFixed(3)}`);
    }
    if (ac.fade_out_ms > 0) {
      const outStart = Math.max(0, (options.postTrimDurationMs - ac.fade_out_ms) / 1000).toFixed(3);
      aFilters.push(`afade=t=out:st=${outStart}:d=${(ac.fade_out_ms / 1000).toFixed(3)}`);
    }
  }

  if (options.timelineStartMs > 0) {
    aFilters.push(`adelay=${options.timelineStartMs}|${options.timelineStartMs}`);
  }
  aFilters.push(`apad=whole_dur=${options.totalDurationSec}`);

  return `[${options.inputIdx}:a]${aFilters.join(",")}${options.outputPad}`;
}

function buildMasterAudioFinalizeFilter(
  audioMixPads: string[],
  finalAudioPad: string,
  masterAudio?: CutholSequence["stage"]["master_audio"]
): string {
  if (audioMixPads.length <= 1) {
    return `${audioMixPads[0]}aformat=sample_rates=48000:channel_layouts=stereo${finalAudioPad}`;
  }
  const masterGainDb = masterAudio?.gain_db ?? 0;
  const gainStage = Math.abs(masterGainDb) > 0.01 ? `,volume=${masterGainDb.toFixed(2)}dB` : "";
  // Reserve 0.55 dB margin below true_peak_ceiling_dbtp to account for 4x oversampled inter-sample true peaks and AAC lossy encoding overshoot
  const limiterLimit = masterAudio
    ? Math.max(
        0.1,
        Math.min(0.98, Math.pow(10, Math.min(-0.1, masterAudio.true_peak_ceiling_dbtp - 0.55) / 20))
      ).toFixed(4)
    : "0.891";
  return `${audioMixPads.join("")}amix=inputs=${audioMixPads.length}:duration=first:dropout_transition=0:normalize=0${gainStage},alimiter=limit=${limiterLimit}:level=disabled${finalAudioPad}`;
}

export function compileSequenceAudioPlan(
  seq: CutholSequence,
  paths: WorkspacePaths,
  overrideMasterAudio?: CutholSequence["stage"]["master_audio"],
  options?: CompileAudioOptions
): CompiledAudioPlan {
  const totalDurationMs = computeRenderDurationMs(seq, options?.minDurationMs ?? 0);
  const totalDurationSec = Number((totalDurationMs / 1000).toFixed(3));
  const libMap = new Map(seq.library.map((item) => [item.handle, item]));

  const inputArgs: string[] = [];
  const filterChains: string[] = [];
  const audioMixPads: string[] = [];

  let nextInputIdx = options?.inputIndexOffset ?? 0;
  const addInput = (args: string[]): number => {
    inputArgs.push(...args);
    return nextInputIdx++;
  };

  const silentAudioIdx = addInput([
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=48000:cl=stereo:d=${totalDurationSec}`,
  ]);
  audioMixPads.push(`[${silentAudioIdx}:a]`);

  let aStepCounter = 0;
  const sortedLanes = [...seq.lanes].sort((a, b) => a.z_index - b.z_index);
  const underSpineLanes = sortedLanes.filter((l) => l.z_index < 0);
  const overSpineLanes = sortedLanes.filter((l) => l.z_index >= 0);

  const compileLaneAudio = (lane: CutholSequence["lanes"][number]): void => {
    if (lane.muted) return;
    for (const cue of lane.cues) {
      if (!cue.asset_handle) continue;
      const asset = libMap.get(cue.asset_handle);
      if (!asset) continue;
      if (
        !asset.probe.has_audio ||
        cue.audio_chain?.muted ||
        !(cue.kind === "music" || cue.kind === "sfx" || cue.kind === "voiceover" || cue.kind === "broll")
      ) {
        continue;
      }

      const cueStartMs = resolveCueStartMs(seq, cue);
      const absAssetPath = resolveLibraryItemPath(paths.rootDir, asset);
      const cueRate = getCuePlaybackRate(cue);
      const srcInMs = cue.source_in_ms ?? 0;
      const maxOutByDuration =
        cueRate === 1.0
          ? srcInMs + cue.duration_ms
          : srcInMs + Math.round(cue.duration_ms * cueRate);
      const requestedOut = cue.source_out_ms ?? maxOutByDuration;
      const srcOutMs = Math.min(maxSourceDurationMs(asset), requestedOut, maxOutByDuration);
      const srcInSec = (srcInMs / 1000).toFixed(3);
      const srcOutSec = (srcOutMs / 1000).toFixed(3);
      const effectiveRate = Math.max(0.1, Math.min(16.0, cueRate));
      const postTrimDurationMs =
        cueRate === 1.0 ? Math.max(0, srcOutMs - srcInMs) : cue.duration_ms;

      const inIdx = addInput(["-i", absAssetPath]);
      const aPad = `[a_cue_${++aStepCounter}]`;
      filterChains.push(
        buildSingleAudioTrackFilterChain({
          inputIdx: inIdx,
          outputPad: aPad,
          srcInSec,
          srcOutSec,
          effectiveRate,
          preservePitch: cue.playback?.preserve_pitch,
          sampleRate: asset.probe.sample_rate,
          audioChain: cue.audio_chain,
          envelopes: cue.envelopes,
          postTrimDurationMs,
          timelineStartMs: cueStartMs,
          totalDurationSec,
        })
      );
      audioMixPads.push(aPad);
    }
  };

  for (const lane of underSpineLanes) {
    compileLaneAudio(lane);
  }

  for (let i = 0; i < seq.spine.clips.length; i++) {
    const clip = seq.spine.clips[i];
    const asset = libMap.get(clip.asset_handle);
    if (!asset || !asset.probe.has_audio || clip.audio_chain.muted) continue;

    const absAssetPath = resolveLibraryItemPath(paths.rootDir, asset);
    const inIdx = addInput(["-i", absAssetPath]);
    const srcInSec = (clip.source_in_ms / 1000).toFixed(3);
    const srcOutSec = (clip.source_out_ms / 1000).toFixed(3);
    const effectiveRate = Math.max(
      0.1,
      Math.min(16.0, (clip.source_out_ms - clip.source_in_ms) / Math.max(1, clip.duration_ms))
    );

    const aPad = `[a_sp_${++aStepCounter}]`;
    filterChains.push(
      buildSingleAudioTrackFilterChain({
        inputIdx: inIdx,
        outputPad: aPad,
        srcInSec,
        srcOutSec,
        effectiveRate,
        preservePitch: clip.playback.preserve_pitch,
        sampleRate: asset.probe.sample_rate,
        audioChain: clip.audio_chain,
        envelopes: clip.envelopes,
        postTrimDurationMs: clip.duration_ms,
        timelineStartMs: clip.timeline_in_ms,
        totalDurationSec,
      })
    );
    audioMixPads.push(aPad);
  }

  for (const lane of overSpineLanes) {
    compileLaneAudio(lane);
  }

  const finalAudioPad = "[aout]";
  const effectiveMaster = overrideMasterAudio !== undefined ? overrideMasterAudio : seq.stage.master_audio;
  filterChains.push(buildMasterAudioFinalizeFilter(audioMixPads, finalAudioPad, effectiveMaster));

  return {
    inputArgs,
    filterComplex: filterChains.join(";"),
    audioOutPad: finalAudioPad,
    totalDurationMs,
    hasActiveAudio: audioMixPads.length > 1,
  };
}

function extractSceneHostBackdropSlice(
  seq: CutholSequence,
  paths: WorkspacePaths,
  cueStartMs: number,
  cueDurationMs: number,
  renderWidth: number,
  renderHeight: number,
  fps: number,
  underneathGraph?: {
    inputArgs: string[];
    filterChains: string[];
    videoPad: string;
  }
): string | undefined {
  const cueEndMs = cueStartMs + cueDurationMs;
  const cueStartSec = Number((cueStartMs / 1000).toFixed(3));
  const cueEndSec = Number((cueEndMs / 1000).toFixed(3));
  const durSec = Number((cueDurationMs / 1000).toFixed(3));

  // Render the exact underneath composite graph (backdrop + z_index < 0 lanes + spine with speed ramps,
  // transitions, color grades, crops, and fit modes) over [cueStartSec, cueEndSec] so boundary frames match 100%.
  if (underneathGraph && underneathGraph.inputArgs.length > 0) {
    const graphFilter = [
      "sws_flags=accurate_rnd+full_chroma_int",
      ...underneathGraph.filterChains,
      `${underneathGraph.videoPad}trim=start=${cueStartSec}:end=${cueEndSec},setpts=PTS-STARTPTS,fps=${fps}:eof_action=pass,tpad=stop_mode=clone:stop_duration=${(2 / fps).toFixed(3)},format=yuv420p,settb=AVTB[v_sh_out]`,
    ].join(";");

    const sliceHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          libDigests: seq.library.map((x) => `${x.handle}:${x.digest_sha256}`),
          inputArgs: underneathGraph.inputArgs,
          graphFilter,
          cueStartSec,
          durSec,
          w: renderWidth,
          h: renderHeight,
          fps,
        })
      )
      .digest("hex")
      .slice(0, 14);

    fs.mkdirSync(paths.blobsDir, { recursive: true });
    const outMp4 = path.join(paths.blobsDir, `sh_backdrop_${sliceHash}.mp4`);
    if (fs.existsSync(outMp4) && fs.statSync(outMp4).size > 500) {
      return outMp4;
    }

    const tmpMp4 = `${outMp4}.${process.pid}.${Date.now()}.tmp.mp4`;
    const proc = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        ...underneathGraph.inputArgs,
        "-filter_complex",
        graphFilter,
        "-map",
        "[v_sh_out]",
        "-t",
        String(durSec),
        "-an",
        "-c:v",
        "libx264",
        "-crf",
        "14",
        "-preset",
        "fast",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        tmpMp4,
      ],
      { cwd: paths.rootDir, encoding: "utf8" }
    );
    if (proc.status === 0 && fs.existsSync(tmpMp4) && fs.statSync(tmpMp4).size > 500) {
      fs.renameSync(tmpMp4, outMp4);
      return outMp4;
    }
    if (fs.existsSync(tmpMp4)) {
      try {
        fs.unlinkSync(tmpMp4);
      } catch {
        // ignore
      }
    }
  }

  const clip = seq.spine.clips.find(
    (c) => c.timeline_in_ms < cueEndMs && c.timeline_in_ms + c.duration_ms > cueStartMs
  );
  if (!clip) return undefined;
  const asset = seq.library.find((item) => item.handle === clip.asset_handle);
  if (!asset || !asset.probe.has_video) return undefined;

  const absAsset = resolveLibraryItemPath(paths.rootDir, asset);
  const srcStartMs = sequenceMsToSourceMs(clip, Math.max(clip.timeline_in_ms, cueStartMs));
  const srcStartSec = Number((srcStartMs / 1000).toFixed(3));

  const sliceHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        digest: asset.digest_sha256,
        srcStartSec,
        durSec,
        w: renderWidth,
        h: renderHeight,
        fps,
      })
    )
    .digest("hex")
    .slice(0, 14);

  fs.mkdirSync(paths.blobsDir, { recursive: true });
  const outMp4 = path.join(paths.blobsDir, `sh_backdrop_${sliceHash}.mp4`);
  if (fs.existsSync(outMp4) && fs.statSync(outMp4).size > 500) {
    return outMp4;
  }

  const tmpMp4 = `${outMp4}.${process.pid}.tmp.mp4`;
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-ss",
      String(srcStartSec),
      "-i",
      absAsset,
      "-t",
      String(durSec),
      "-vf",
      `fps=${fps}:eof_action=pass,tpad=stop_mode=clone:stop_duration=${(2 / fps).toFixed(3)},scale=${renderWidth}:${renderHeight}:force_original_aspect_ratio=increase,crop=${renderWidth}:${renderHeight},format=yuv420p,settb=AVTB`,
      "-an",
      "-c:v",
      "libx264",
      "-crf",
      "14",
      "-preset",
      "fast",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-color_range",
      "tv",
      tmpMp4,
    ],
    { encoding: "utf8" }
  );
  if (proc.status === 0 && fs.existsSync(tmpMp4) && fs.statSync(tmpMp4).size > 500) {
    fs.renameSync(tmpMp4, outMp4);
    return outMp4;
  }
  return undefined;
}

export function compileSequenceRenderPlan(
  seq: CutholSequence,
  paths: WorkspacePaths,
  preset: RenderPreset = "master_1080p",
  compileOptions?: CompileSequenceOptions
): CompiledRenderPlan {
  const totalDurationMs = computeRenderDurationMs(seq, compileOptions?.minDurationMs ?? 0);
  const totalDurationSec = Number((totalDurationMs / 1000).toFixed(3));

  const scaleFactor = preset === "draft_480p" ? 480 / Math.min(seq.stage.width, seq.stage.height) : 1.0;
  const renderWidth = Math.max(16, Math.round((seq.stage.width * scaleFactor) / 2) * 2);
  const renderHeight = Math.max(16, Math.round((seq.stage.height * scaleFactor) / 2) * 2);
  const fps = seq.stage.fps;

  const libMap = new Map(seq.library.map((item) => [item.handle, item]));
  const inputArgs: string[] = [];
  const filterChains: string[] = [];
  const hyperframesBlobs: string[] = [];
  const assFilePaths: string[] = [];

  let nextInputIdx = 0;
  const addInput = (args: string[]): number => {
    inputArgs.push(...args);
    return nextInputIdx++;
  };

  // Input 0: Stage Backdrop Canvas (use microsecond AVTB so downstream overlays and -t trim never quantize to 1/fps)
  const bgHex = seq.stage.backdrop.color.replace(/^#/, "0x");
  const bgInputIdx = addInput([
    "-f",
    "lavfi",
    "-i",
    `color=c=${bgHex}:s=${renderWidth}x${renderHeight}:r=${fps}:d=${totalDurationSec},settb=AVTB`,
  ]);

  let currentVideoPad = `[${bgInputIdx}:v]`;
  let vStepCounter = 0;

  const sortedLanes = [...seq.lanes].sort((a, b) => a.z_index - b.z_index);
  const underSpineLanes = sortedLanes.filter((l) => l.z_index < 0);
  const overSpineLanes = sortedLanes.filter((l) => l.z_index >= 0);

  const compileLane = (lane: CutholSequence["lanes"][number]): void => {
    if (lane.muted) return;

    let laneHasTypography = false;
    const orderedCues = lane.cues.some((c) => c.z_index !== undefined)
      ? [...lane.cues].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0))
      : lane.cues;

    for (const cue of orderedCues) {
      if (cue.typography && cue.typography.text.trim()) {
        laneHasTypography = true;
      }

      const cueStartMs = resolveCueStartMs(seq, cue);
      const cueEndMs = cueStartMs + cue.duration_ms;
      const cueStartSec = (cueStartMs / 1000).toFixed(3);
      const cueEndSec = (cueEndMs / 1000).toFixed(3);

      // 2a. HyperFrames Composition Cue
      if (cue.kind === "composition" && cue.composition) {
        if (compileOptions?.activeWindowMs) {
          const [winStart, winEnd] = compileOptions.activeWindowMs;
          if (cueEndMs <= winStart || cueStartMs > winEnd) {
            continue;
          }
        }
        try {
          syncCompositionBridgeFiles(seq, cue, paths);
        } catch {
          // non-blocking bridge sync
        }
        const compDir = path.isAbsolute(cue.composition.composition_dir)
          ? cue.composition.composition_dir
          : path.resolve(paths.rootDir, cue.composition.composition_dir);

        const compMode = cue.composition.mode ?? "overlay_alpha";
        let hfIdx: number;
        const frameDurMs = 1000 / Math.max(1, fps);

        if (
          compileOptions?.singleFrameAtMs !== undefined &&
          compMode !== "scene_host" &&
          compileOptions.singleFrameAtMs + frameDurMs >= cueStartMs &&
          compileOptions.singleFrameAtMs <= cueEndMs
        ) {
          // Preserve exact floating-point `singleFrameAtMs` (without integer ms truncation)
          // so 30fps `frameIdx = 3k + 1` never drifts by 1 frame.
          const localSec = Math.max(0, (compileOptions.singleFrameAtMs - cueStartMs) / 1000);
          const singleFrame = renderHyperFramesSingleFramePng({
            compositionDir: compDir,
            entryHtml: cue.composition.entry_html,
            blobsDir: paths.blobsDir,
            width: renderWidth,
            height: renderHeight,
            fps,
            durationMs: cue.duration_ms,
            localSec,
            props: cue.composition.props,
            transparent: cue.composition.transparent,
            mode: compMode,
          });
          hyperframesBlobs.push(singleFrame.pngPath);
          hfIdx = addInput([
            "-loop",
            "1",
            "-framerate",
            String(fps),
            "-t",
            (cue.duration_ms / 1000 + 2 / fps).toFixed(3),
            "-i",
            singleFrame.pngPath,
          ]);
        } else {
          const backdropVideoPath =
            compMode === "scene_host"
              ? extractSceneHostBackdropSlice(
                  seq,
                  paths,
                  cueStartMs,
                  cue.duration_ms,
                  renderWidth,
                  renderHeight,
                  fps,
                  {
                    inputArgs: [...inputArgs],
                    filterChains: [...filterChains],
                    videoPad: currentVideoPad,
                  }
                )
              : undefined;

          const hfBlob = renderHyperFramesCompositionToMp4({
            compositionDir: compDir,
            entryHtml: cue.composition.entry_html,
            blobsDir: paths.blobsDir,
            width: renderWidth,
            height: renderHeight,
            fps,
            durationMs: cue.duration_ms,
            props: cue.composition.props,
            transparent: cue.composition.transparent,
            mode: compMode,
            backdropVideoPath,
          });
          hyperframesBlobs.push(hfBlob);
          hfIdx = addInput(["-i", hfBlob]);
        }

        const targetW = Math.max(8, Math.round((renderWidth * Math.abs(cue.placement.scale_x)) / 2) * 2);
        const targetH = Math.max(8, Math.round((renderHeight * Math.abs(cue.placement.scale_y)) / 2) * 2);

        const hfFilters: string[] = [`scale=${targetW}:${targetH}`];
        if (cue.placement.mirror_x) hfFilters.push("hflip");
        if (cue.placement.mirror_y) hfFilters.push("vflip");
        const hfRotEnv = cue.envelopes.find((e) => e.parameter === "placement.rotation_deg");
        const hfRotExpr = compileEnvelopeToFfmpegExpr({
          envelope: hfRotEnv,
          timeBaseOffsetMs: 0,
          mode: "raw",
        });
        const hfOpEnv = cue.envelopes.find((e) => e.parameter === "placement.opacity");
        const hfOpExpr = compileEnvelopeToFfmpegExpr({
          envelope: hfOpEnv,
          timeBaseOffsetMs: 0,
          mode: "raw",
        });
        // Always normalize through `format=rgba` before `yuva444p10le` so both RGBA PNG single-frame snapshots
        // and ProRes 4444 `.mov` blobs share the exact same color matrix conversion path in FFmpeg.
        hfFilters.push("format=rgba");
        if (hfRotExpr) {
          const radExpr = `((${hfRotExpr})*PI/180)`;
          hfFilters.push(`rotate=a='${radExpr}':ow='rotw(${radExpr})':oh='roth(${radExpr})':c=none`);
        } else if (Math.abs(cue.placement.rotation_deg) > 0.01) {
          const rad = ((cue.placement.rotation_deg * Math.PI) / 180).toFixed(4);
          hfFilters.push(`rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`);
        }
        if (hfOpExpr) {
          const opExprT = hfOpExpr.replace(/\bt\b/g, "T");
          hfFilters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*(${opExprT}),0,255)'`);
        } else if (cue.placement.opacity < 0.999) {
          hfFilters.push(`colorchannelmixer=aa=${cue.placement.opacity.toFixed(3)}`);
        }
        const hfSxEnv = cue.envelopes.find((e) => e.parameter === "placement.scale_x");
        const hfSyEnv = cue.envelopes.find((e) => e.parameter === "placement.scale_y");
        const hfSxExpr = compileEnvelopeToFfmpegExpr({ envelope: hfSxEnv, timeBaseOffsetMs: 0, mode: "raw" });
        const hfSyExpr = compileEnvelopeToFfmpegExpr({ envelope: hfSyEnv, timeBaseOffsetMs: 0, mode: "raw" });
        if (hfSxExpr || hfSyExpr) {
          const sxPart = hfSxExpr ? `abs(${hfSxExpr})` : String(Math.abs(cue.placement.scale_x));
          const syPart = hfSyExpr ? `abs(${hfSyExpr})` : String(Math.abs(cue.placement.scale_y));
          hfFilters.push(
            `scale=w='max(8,trunc((${renderWidth}*${sxPart})/2)*2)':h='max(8,trunc((${renderHeight}*${syPart})/2)*2)':eval=frame`
          );
        }
        hfFilters.push(
          `tpad=stop_mode=clone:stop_duration=${(2 / fps).toFixed(3)}`,
          `settb=AVTB`,
          `setpts=PTS-STARTPTS+${cueStartSec}/TB`
        );

        const hfPad = `[v_hf_${cue.id}]`;
        filterChains.push(`[${hfIdx}:v]${hfFilters.join(",")}${hfPad}`);

        const hfRadAbs = (Math.abs(cue.placement.rotation_deg) * Math.PI) / 180;
        const hfEffW =
          Math.abs(cue.placement.rotation_deg) > 0.01
            ? Math.round(targetW * Math.abs(Math.cos(hfRadAbs)) + targetH * Math.abs(Math.sin(hfRadAbs)))
            : targetW;
        const hfEffH =
          Math.abs(cue.placement.rotation_deg) > 0.01
            ? Math.round(targetW * Math.abs(Math.sin(hfRadAbs)) + targetH * Math.abs(Math.cos(hfRadAbs)))
            : targetH;
        const baseCenterX = Math.round((renderWidth - hfEffW) / 2);
        const baseCenterY = Math.round((renderHeight - hfEffH) / 2);
        const xEnv = cue.envelopes.find((e) => e.parameter === "placement.x_pct");
        const yEnv = cue.envelopes.find((e) => e.parameter === "placement.y_pct");

        const xExpr =
          compileEnvelopeToFfmpegExpr({
            envelope: xEnv,
            timeBaseOffsetMs: cueStartMs,
            mode: "pixel_offset",
            baseCenterPx: baseCenterX,
            canvasDimPx: renderWidth,
          }) ??
          (hfSxExpr || hfSyExpr || hfRotExpr
            ? `(W-w)/2+${Math.round((cue.placement.x_pct / 100) * renderWidth)}`
            : String(Math.round(baseCenterX + (cue.placement.x_pct / 100) * renderWidth)));

        const yExpr =
          compileEnvelopeToFfmpegExpr({
            envelope: yEnv,
            timeBaseOffsetMs: cueStartMs,
            mode: "pixel_offset",
            baseCenterPx: baseCenterY,
            canvasDimPx: renderHeight,
          }) ??
          (hfSxExpr || hfSyExpr || hfRotExpr
            ? `(H-h)/2+${Math.round((cue.placement.y_pct / 100) * renderHeight)}`
            : String(Math.round(baseCenterY + (cue.placement.y_pct / 100) * renderHeight)));

        const base10Pad = `[vc_b10_${++vStepCounter}]`;
        const ov10Pad = `[vc_o10_${vStepCounter}]`;
        const nextPad = `[vc_${vStepCounter}]`;
        filterChains.push(
          `${currentVideoPad}format=yuv444p10le${base10Pad}`,
          `${hfPad}format=yuva444p10le${ov10Pad}`,
          `${base10Pad}${ov10Pad}overlay=x='${xExpr}':y='${yExpr}':format=yuv444p10:alpha=straight:eval=frame:enable='between(t,${cueStartSec},${cueEndSec})':eof_action=pass:repeatlast=0,format=yuv420p${nextPad}`
        );
        currentVideoPad = nextPad;
        continue;
      }

      // 2b. Asset-Backed Lane Cue (B-roll, Graphic, Music, SFX, Voiceover)
      if (cue.asset_handle) {
        const asset = libMap.get(cue.asset_handle);
        if (!asset) continue;

        const absAssetPath = resolveLibraryItemPath(paths.rootDir, asset);
        const cueRate = getCuePlaybackRate(cue);
        const srcInMs = cue.source_in_ms ?? 0;
        // Always bound srcOutMs by both asset.probe.duration_ms and srcInMs + cue.duration_ms * cueRate
        const maxOutByDuration =
          cueRate === 1.0
            ? srcInMs + cue.duration_ms
            : srcInMs + Math.round(cue.duration_ms * cueRate);
        const requestedOut = cue.source_out_ms ?? maxOutByDuration;
        const srcOutMs = Math.min(maxSourceDurationMs(asset), requestedOut, maxOutByDuration);
        const srcInSec = (srcInMs / 1000).toFixed(3);
        const srcOutSec = (srcOutMs / 1000).toFixed(3);

        const isAudioOnlyKind =
          cue.kind === "music" || cue.kind === "sfx" || cue.kind === "voiceover";

        if (
          !isAudioOnlyKind &&
          asset.probe.has_video &&
          (cue.kind === "broll" || asset.kind === "graphic" || asset.kind === "footage")
        ) {
          const isStill = isStillGraphic(asset);
          const inIdx = isStill
            ? addInput([
                "-loop",
                "1",
                "-framerate",
                String(fps),
                "-t",
                (cue.duration_ms / 1000 + 2 / fps).toFixed(3),
                "-i",
                absAssetPath,
              ])
            : addInput(["-i", absAssetPath]);

          const cropWRatio = cue.placement.crop
            ? Math.max(0.05, 1 - (cue.placement.crop.left_pct + cue.placement.crop.right_pct) / 100)
            : 1.0;
          const cropHRatio = cue.placement.crop
            ? Math.max(0.05, 1 - (cue.placement.crop.top_pct + cue.placement.crop.bottom_pct) / 100)
            : 1.0;
          const assetAr =
            asset.probe.width > 0 && asset.probe.height > 0
              ? (asset.probe.width * cropWRatio) / (asset.probe.height * cropHRatio)
              : renderWidth / renderHeight;
          // Compute targetH from cropped assetAr * scale_y
          const targetW = Math.max(8, Math.round((renderWidth * Math.abs(cue.placement.scale_x)) / 2) * 2);
          const targetH = Math.max(8, Math.round(((renderWidth / assetAr) * Math.abs(cue.placement.scale_y)) / 2) * 2);

          // Reset PTS to 0 right after `trim` (`setpts=PTS-STARTPTS`) so local keyframe
          // envelopes (`rotate`, `geq` opacity, `scale`) evaluate over `t = 0 .. cueDuration` even when `srcInMs > 0`.
          // Frame-exact tail padding ensures non-30fps / VFR sources cover every output frame until `cueEndSec`.
          const cueSrcFps = Math.max(1, asset.probe.fps || fps);
          const cueRawSrcSpanSec = Math.max(0, (srcOutMs - srcInMs) / (1000 * cueRate));
          const cueDurSec = cue.duration_ms / 1000;
          const cueTailPadSec = Math.max(
            0.1,
            Math.max(0, cueDurSec - cueRawSrcSpanSec) + 3 / (cueSrcFps * cueRate) + 2 / fps
          ).toFixed(3);
          const vFilters: string[] = isStill
            ? [`fps=${fps}:eof_action=pass`, `tpad=stop_mode=clone:stop_duration=${cueTailPadSec}`]
            : [
                `settb=AVTB`,
                `trim=start=${srcInSec}:end=${srcOutSec}`,
                cueRate === 1.0
                  ? `setpts=PTS-STARTPTS`
                  : `setpts=(PTS-STARTPTS)/${cueRate.toFixed(4)}`,
                `fps=${fps}:eof_action=pass`,
                `tpad=stop_mode=clone:stop_duration=${cueTailPadSec}`,
              ];

          if (cue.placement.crop) {
            const cr = cue.placement.crop;
            const wRatio = cropWRatio.toFixed(4);
            const hRatio = cropHRatio.toFixed(4);
            const xRatio = (cr.left_pct / 100).toFixed(4);
            const yRatio = (cr.top_pct / 100).toFixed(4);
            vFilters.push(`crop=w=iw*${wRatio}:h=ih*${hRatio}:x=iw*${xRatio}:y=ih*${yRatio}`);
          }

          if (cue.placement.fit_mode === "contain") {
            vFilters.push(
              `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease`,
              `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black@0`
            );
          } else {
            vFilters.push(`scale=${targetW}:${targetH}`);
          }
          if (cue.placement.mirror_x) vFilters.push("hflip");
          if (cue.placement.mirror_y) vFilters.push("vflip");
          vFilters.push(`format=rgba`);

          const cueRotEnv = cue.envelopes.find((e) => e.parameter === "placement.rotation_deg");
          const cueRotExpr = compileEnvelopeToFfmpegExpr({
            envelope: cueRotEnv,
            timeBaseOffsetMs: 0,
            mode: "raw",
          });
          if (cueRotExpr) {
            const radExpr = `((${cueRotExpr})*PI/180)`;
            vFilters.push(`rotate=a='${radExpr}':ow='rotw(${radExpr})':oh='roth(${radExpr})':c=none`);
          } else if (Math.abs(cue.placement.rotation_deg) > 0.01) {
            const rad = ((cue.placement.rotation_deg * Math.PI) / 180).toFixed(4);
            vFilters.push(`rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`);
          }
          const cueOpEnv = cue.envelopes.find((e) => e.parameter === "placement.opacity");
          const cueOpExpr = compileEnvelopeToFfmpegExpr({
            envelope: cueOpEnv,
            timeBaseOffsetMs: 0,
            mode: "raw",
          });
          if (cueOpExpr) {
            const opExprT = cueOpExpr.replace(/\bt\b/g, "T");
            vFilters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*(${opExprT}),0,255)'`);
          } else if (cue.placement.opacity < 0.999) {
            vFilters.push(`colorchannelmixer=aa=${cue.placement.opacity.toFixed(3)}`);
          }
          const cueSxEnv = cue.envelopes.find((e) => e.parameter === "placement.scale_x");
          const cueSyEnv = cue.envelopes.find((e) => e.parameter === "placement.scale_y");
          const cueSxExpr = compileEnvelopeToFfmpegExpr({ envelope: cueSxEnv, timeBaseOffsetMs: 0, mode: "raw" });
          const cueSyExpr = compileEnvelopeToFfmpegExpr({ envelope: cueSyEnv, timeBaseOffsetMs: 0, mode: "raw" });
          if (cueSxExpr || cueSyExpr) {
            const baseUnscaledH = Math.max(8, Math.round(renderWidth / assetAr));
            const sxPart = cueSxExpr ? `abs(${cueSxExpr})` : String(Math.abs(cue.placement.scale_x));
            const syPart = cueSyExpr ? `abs(${cueSyExpr})` : String(Math.abs(cue.placement.scale_y));
            vFilters.push(
              `scale=w='max(8,trunc((${renderWidth}*${sxPart})/2)*2)':h='max(8,trunc((${baseUnscaledH}*${syPart})/2)*2)':eval=frame`
            );
          }
          vFilters.push(`settb=AVTB`, `setpts=PTS-STARTPTS+${cueStartSec}/TB`);

          const cuePad = `[v_cue_${cue.id}]`;
          filterChains.push(`[${inIdx}:v]${vFilters.join(",")}${cuePad}`);

          const cueRadAbs = (Math.abs(cue.placement.rotation_deg) * Math.PI) / 180;
          const cueEffW =
            Math.abs(cue.placement.rotation_deg) > 0.01
              ? Math.round(targetW * Math.abs(Math.cos(cueRadAbs)) + targetH * Math.abs(Math.sin(cueRadAbs)))
              : targetW;
          const cueEffH =
            Math.abs(cue.placement.rotation_deg) > 0.01
              ? Math.round(targetW * Math.abs(Math.sin(cueRadAbs)) + targetH * Math.abs(Math.cos(cueRadAbs)))
              : targetH;
          const baseCenterX = Math.round((renderWidth - cueEffW) / 2);
          const baseCenterY = Math.round((renderHeight - cueEffH) / 2);
          const xEnv = cue.envelopes.find((e) => e.parameter === "placement.x_pct");
          const yEnv = cue.envelopes.find((e) => e.parameter === "placement.y_pct");

          const xExpr =
            compileEnvelopeToFfmpegExpr({
              envelope: xEnv,
              timeBaseOffsetMs: cueStartMs,
              mode: "pixel_offset",
              baseCenterPx: baseCenterX,
              canvasDimPx: renderWidth,
            }) ??
            (cueSxExpr || cueSyExpr || cueRotExpr
              ? `(W-w)/2+${Math.round((cue.placement.x_pct / 100) * renderWidth)}`
              : String(Math.round(baseCenterX + (cue.placement.x_pct / 100) * renderWidth)));

          const yExpr =
            compileEnvelopeToFfmpegExpr({
              envelope: yEnv,
              timeBaseOffsetMs: cueStartMs,
              mode: "pixel_offset",
              baseCenterPx: baseCenterY,
              canvasDimPx: renderHeight,
            }) ??
            (cueSxExpr || cueSyExpr || cueRotExpr
              ? `(H-h)/2+${Math.round((cue.placement.y_pct / 100) * renderHeight)}`
              : String(Math.round(baseCenterY + (cue.placement.y_pct / 100) * renderHeight)));

          const nextPad = `[vc_${++vStepCounter}]`;
          filterChains.push(
            `${currentVideoPad}${cuePad}overlay=x='${xExpr}':y='${yExpr}':eval=frame:enable='between(t,${cueStartSec},${cueEndSec})':eof_action=pass${nextPad}`
          );
          currentVideoPad = nextPad;
        }
      }
    }

    // Compile and apply typography for this lane right at its `z_index` level,
    // keeping native `seq.stage.width x seq.stage.height` PlayResX/Y so libass scales outlines/margins accurately!
    if (laneHasTypography) {
      const laneAssHash = crypto
        .createHash("sha256")
        .update(JSON.stringify({ stage: seq.stage, spine: seq.spine.clips, lane }))
        .digest("hex")
        .slice(0, 8);
      const assOutFile = path.join(
        paths.blobsDir,
        `typography_r${seq.meta.revision}_${lane.id}_${preset}_${laneAssHash}.ass`
      );
      const assResult = compileTypographyAssFile(seq, assOutFile, new Set([lane.id]));
      if (assResult.hasTypographyCues) {
        assFilePaths.push(assResult.filePath);
        const relAssPath = path.relative(paths.rootDir, assResult.filePath);
        const escapedAssPath = escapeFfmpegFilterPath(relAssPath);
        const nextPad = `[vc_${++vStepCounter}]`;
        filterChains.push(`${currentVideoPad}ass=filename=${escapedAssPath}${nextPad}`);
        currentVideoPad = nextPad;
      }
    }
  };

  // --- 1a. Compile Under-Spine Lanes (`z_index < 0`) ---
  for (const lane of underSpineLanes) {
    compileLane(lane);
  }

  // --- 1b. Compile Primary Spine Clips (`z_index === 0`) ---
  for (let i = 0; i < seq.spine.clips.length; i++) {
    const clip = seq.spine.clips[i];
    const prevClip = i > 0 ? seq.spine.clips[i - 1] : null;
    const incomingTransition: TransitionSpec | null = prevClip?.transition_out ?? null;

    const asset = libMap.get(clip.asset_handle);
    if (!asset || !asset.probe.has_video) continue;

    const absAssetPath = resolveLibraryItemPath(paths.rootDir, asset);
    // A still image is a single frame: loop it so it covers the whole source range of the clip.
    const inIdx = isStillGraphic(asset)
      ? addInput([
          "-loop",
          "1",
          "-framerate",
          String(fps),
          "-t",
          (clip.source_out_ms / 1000 + 2 / fps).toFixed(3),
          "-i",
          absAssetPath,
        ])
      : addInput(["-i", absAssetPath]);

    const srcInSec = (clip.source_in_ms / 1000).toFixed(3);
    const srcOutSec = (clip.source_out_ms / 1000).toFixed(3);
    const tlInSec = (clip.timeline_in_ms / 1000).toFixed(3);

    // If this clip has a cross-transition (`dissolve`, `wipe_left`, `wipe_right`, `slide_up`, `zoom_in`)
    // into `clips[i+1]`, hold its final frame under `clips[i+1]` during the transition duration so there is ZERO dip to backdrop!
    const hasNextClip = i < seq.spine.clips.length - 1;
    const outTrans = clip.transition_out;
    const holdTailMs =
      hasNextClip && outTrans && outTrans.kind !== "fade" ? outTrans.duration_ms : 0;

    const tlOutSec = ((clip.timeline_in_ms + clip.duration_ms + holdTailMs) / 1000).toFixed(3);

    // Compute effectiveRate from integrated `clip.duration_ms` so speed_ramp durations match exactly
    const effectiveRate = Math.max(
      0.1,
      Math.min(16.0, (clip.source_out_ms - clip.source_in_ms) / Math.max(1, clip.duration_ms))
    );

    {
      const targetW = Math.max(8, Math.round((renderWidth * Math.abs(clip.placement.scale_x)) / 2) * 2);
      const targetH = Math.max(8, Math.round((renderHeight * Math.abs(clip.placement.scale_y)) / 2) * 2);

      const srcFps = Math.max(1, asset.probe.fps || fps);
      const rawSrcSpanSec = Math.max(0, (clip.source_out_ms - clip.source_in_ms) / 1000);
      const scaledSrcSpanSec = rawSrcSpanSec / effectiveRate;
      const clipDurSec = clip.duration_ms / 1000;
      const tailPadSec = Math.max(
        0.1,
        Math.max(0, clipDurSec - scaledSrcSpanSec) + 3 / (srcFps * effectiveRate) + 2 / fps
      ).toFixed(3);

      const vFilters: string[] = [
        `settb=AVTB`,
        `trim=start=${srcInSec}:end=${srcOutSec}`,
        `setpts=(PTS-STARTPTS)/${effectiveRate.toFixed(4)}`,
        `fps=${fps}:eof_action=pass`,
        `tpad=stop_mode=clone:stop_duration=${tailPadSec}`,
      ];

      // Apply crop if configured
      if (clip.placement.crop) {
        const cr = clip.placement.crop;
        const wRatio = Math.max(0.05, 1 - (cr.left_pct + cr.right_pct) / 100).toFixed(4);
        const hRatio = Math.max(0.05, 1 - (cr.top_pct + cr.bottom_pct) / 100).toFixed(4);
        const xRatio = (cr.left_pct / 100).toFixed(4);
        const yRatio = (cr.top_pct / 100).toFixed(4);
        vFilters.push(`crop=w=iw*${wRatio}:h=ih*${hRatio}:x=iw*${xRatio}:y=ih*${yRatio}`);
      }

      if (clip.placement.fit_mode === "contain") {
        vFilters.push(
          `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease`,
          `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black@0`
        );
      } else if (clip.placement.fit_mode === "cover") {
        vFilters.push(
          `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase`,
          `crop=${targetW}:${targetH}`
        );
      } else {
        vFilters.push(`scale=${targetW}:${targetH}`);
      }

      if (clip.placement.mirror_x) vFilters.push("hflip");
      if (clip.placement.mirror_y) vFilters.push("vflip");

      const cg = clip.treatments.color_grade;
      if (cg.brightness !== 0 || cg.contrast !== 1 || cg.saturation !== 1) {
        vFilters.push(
          `eq=brightness=${cg.brightness.toFixed(2)}:contrast=${cg.contrast.toFixed(2)}:saturation=${cg.saturation.toFixed(2)}`
        );
      }

      if (clip.treatments.cutout.mode === "chroma" && clip.treatments.cutout.chroma_key_hex) {
        const keyColor = clip.treatments.cutout.chroma_key_hex.replace(/^#/, "0x");
        vFilters.push(
          `format=rgba,colorkey=${keyColor}:${clip.treatments.cutout.similarity.toFixed(2)}:${clip.treatments.cutout.blend.toFixed(2)}`
        );
      } else {
        vFilters.push("format=rgba");
      }

      // Apply rotation_deg / envelopes with dynamic output bounding box
      const spRotEnv = clip.envelopes.find((e) => e.parameter === "placement.rotation_deg");
      const spRotExpr = compileEnvelopeToFfmpegExpr({
        envelope: spRotEnv,
        timeBaseOffsetMs: 0,
        mode: "raw",
      });
      if (spRotExpr) {
        const radExpr = `((${spRotExpr})*PI/180)`;
        vFilters.push(`rotate=a='${radExpr}':ow='rotw(${radExpr})':oh='roth(${radExpr})':c=none`);
      } else if (Math.abs(clip.placement.rotation_deg) > 0.01) {
        const rad = ((clip.placement.rotation_deg * Math.PI) / 180).toFixed(4);
        vFilters.push(`rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`);
      }

      const spOpEnv = clip.envelopes.find((e) => e.parameter === "placement.opacity");
      const spOpExpr = compileEnvelopeToFfmpegExpr({
        envelope: spOpEnv,
        timeBaseOffsetMs: 0,
        mode: "raw",
      });
      if (spOpExpr) {
        const opExprT = spOpExpr.replace(/\bt\b/g, "T");
        vFilters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*(${opExprT}),0,255)'`);
      } else if (clip.placement.opacity < 0.999) {
        vFilters.push(`colorchannelmixer=aa=${clip.placement.opacity.toFixed(3)}`);
      }

      // Handle outgoing & incoming transitions cleanly without Porter-Duff alpha dip
      const nextClip = hasNextClip ? seq.spine.clips[i + 1] : null;
      const nextCoversStage =
        nextClip !== null &&
        outTrans?.kind !== "zoom_in" &&
        Math.abs(nextClip.placement.scale_x) >= 0.999 &&
        Math.abs(nextClip.placement.scale_y) >= 0.999 &&
        Math.abs(nextClip.placement.x_pct) < 0.01 &&
        Math.abs(nextClip.placement.y_pct) < 0.01 &&
        Math.abs(nextClip.placement.rotation_deg) < 0.01 &&
        !nextClip.placement.crop &&
        nextClip.placement.fit_mode !== "contain" &&
        nextClip.placement.opacity >= 0.999 &&
        !nextClip.envelopes.some(
          (e) =>
            e.parameter === "placement.scale_x" ||
            e.parameter === "placement.scale_y" ||
            e.parameter === "placement.x_pct" ||
            e.parameter === "placement.y_pct" ||
            e.parameter === "placement.rotation_deg" ||
            e.parameter === "placement.opacity"
        );

      if (outTrans && outTrans.duration_ms > 0) {
        const fadeDurSec = (outTrans.duration_ms / 1000).toFixed(3);
        if (!hasNextClip || outTrans.kind === "fade") {
          const fadeStartSec = Math.max(0, (clip.duration_ms - outTrans.duration_ms) / 1000).toFixed(3);
          vFilters.push(`fade=t=out:st=${fadeStartSec}:d=${fadeDurSec}:alpha=1`);
        } else if (nextCoversStage) {
          // Hold last frame at 100% alpha under full-frame incoming next clip so total opacity stays 1.0 (zero backdrop bleed)
          vFilters.push(`tpad=stop_mode=clone:stop_duration=${fadeDurSec}`);
        } else {
          const holdFadeStartSec = (clip.duration_ms / 1000).toFixed(3);
          vFilters.push(
            `tpad=stop_mode=clone:stop_duration=${fadeDurSec}`,
            `fade=t=out:st=${holdFadeStartSec}:d=${fadeDurSec}:alpha=1`
          );
        }
      }

      const isZoomInIncoming =
        incomingTransition !== null &&
        incomingTransition.duration_ms > 0 &&
        incomingTransition.kind === "zoom_in";

      if (incomingTransition && incomingTransition.duration_ms > 0) {
        const inDurSec = (incomingTransition.duration_ms / 1000).toFixed(3);
        if (
          incomingTransition.kind === "dissolve" ||
          incomingTransition.kind === "fade" ||
          incomingTransition.kind === "zoom_in"
        ) {
          vFilters.push(`fade=t=in:st=0:d=${inDurSec}:alpha=1`);
        }
      }

      const spSxEnv = clip.envelopes.find((e) => e.parameter === "placement.scale_x");
      const spSyEnv = clip.envelopes.find((e) => e.parameter === "placement.scale_y");
      const spSxExpr = compileEnvelopeToFfmpegExpr({ envelope: spSxEnv, timeBaseOffsetMs: 0, mode: "raw" });
      const spSyExpr = compileEnvelopeToFfmpegExpr({ envelope: spSyEnv, timeBaseOffsetMs: 0, mode: "raw" });

      if (spSxExpr || spSyExpr || isZoomInIncoming) {
        const inDurSec = incomingTransition ? (incomingTransition.duration_ms / 1000).toFixed(3) : "0.001";
        const zoomFactor = isZoomInIncoming
          ? `if(lt(t,${inDurSec}),0.88+0.12*(t/${inDurSec}),1)`
          : "1";
        const sxPart = spSxExpr ? `abs(${spSxExpr})*(${zoomFactor})` : `${Math.abs(clip.placement.scale_x)}*(${zoomFactor})`;
        const syPart = spSyExpr ? `abs(${spSyExpr})*(${zoomFactor})` : `${Math.abs(clip.placement.scale_y)}*(${zoomFactor})`;
        vFilters.push(
          `scale=w='max(8,trunc((${renderWidth}*${sxPart})/2)*2)':h='max(8,trunc((${renderHeight}*${syPart})/2)*2)':eval=frame`
        );
      }

      vFilters.push(`settb=AVTB`, `setpts=PTS+${tlInSec}/TB`);

      const clipPad = `[v_sp_${i}]`;
      filterChains.push(`[${inIdx}:v]${vFilters.join(",")}${clipPad}`);

      const spRadAbs = (Math.abs(clip.placement.rotation_deg) * Math.PI) / 180;
      const spEffW =
        Math.abs(clip.placement.rotation_deg) > 0.01
          ? Math.round(targetW * Math.abs(Math.cos(spRadAbs)) + targetH * Math.abs(Math.sin(spRadAbs)))
          : targetW;
      const spEffH =
        Math.abs(clip.placement.rotation_deg) > 0.01
          ? Math.round(targetW * Math.abs(Math.sin(spRadAbs)) + targetH * Math.abs(Math.cos(spRadAbs)))
          : targetH;
      const baseCenterX = Math.round((renderWidth - spEffW) / 2);
      const baseCenterY = Math.round((renderHeight - spEffH) / 2);
      const xEnv = clip.envelopes.find((e) => e.parameter === "placement.x_pct");
      const yEnv = clip.envelopes.find((e) => e.parameter === "placement.y_pct");

      let xExpr =
        compileEnvelopeToFfmpegExpr({
          envelope: xEnv,
          timeBaseOffsetMs: clip.timeline_in_ms,
          mode: "pixel_offset",
          baseCenterPx: baseCenterX,
          canvasDimPx: renderWidth,
        }) ??
        (spSxExpr || spSyExpr || spRotExpr || isZoomInIncoming
          ? `(W-w)/2+${Math.round((clip.placement.x_pct / 100) * renderWidth)}`
          : String(Math.round(baseCenterX + (clip.placement.x_pct / 100) * renderWidth)));

      let yExpr =
        compileEnvelopeToFfmpegExpr({
          envelope: yEnv,
          timeBaseOffsetMs: clip.timeline_in_ms,
          mode: "pixel_offset",
          baseCenterPx: baseCenterY,
          canvasDimPx: renderHeight,
        }) ??
        (spSxExpr || spSyExpr || spRotExpr || isZoomInIncoming
          ? `(H-h)/2+${Math.round((clip.placement.y_pct / 100) * renderHeight)}`
          : String(Math.round(baseCenterY + (clip.placement.y_pct / 100) * renderHeight)));

      // Animate incoming wipe_left / wipe_right / slide_up transitions
      if (incomingTransition && incomingTransition.duration_ms > 0) {
        const t0 = Number((clip.timeline_in_ms / 1000).toFixed(3));
        const dt = Number((incomingTransition.duration_ms / 1000).toFixed(3));
        const t1 = Number((t0 + dt).toFixed(3));
        if (incomingTransition.kind === "wipe_left") {
          xExpr = `if(lt(t,${t1}),${renderWidth}-${renderWidth}*(t-${t0})/${dt},${xExpr})`;
        } else if (incomingTransition.kind === "wipe_right") {
          xExpr = `if(lt(t,${t1}),-${renderWidth}+${renderWidth}*(t-${t0})/${dt},${xExpr})`;
        } else if (incomingTransition.kind === "slide_up") {
          yExpr = `if(lt(t,${t1}),${renderHeight}-${renderHeight}*(t-${t0})/${dt},${yExpr})`;
        }
      }

      const nextPad = `[vc_${++vStepCounter}]`;
      filterChains.push(
        `${currentVideoPad}${clipPad}overlay=x='${xExpr}':y='${yExpr}':eval=frame:enable='between(t,${tlInSec},${tlOutSec})':eof_action=pass${nextPad}`
      );
      currentVideoPad = nextPad;
    }
  }

  // --- 2. Compile Over-Spine Parallel Lanes Sorted by z_index (`z_index >= 0`) ---
  for (const lane of overSpineLanes) {
    compileLane(lane);
  }

  // Finalize Video Output Pad (preserve AVTB so FFmpeg -t duration trim does not round down to 1/fps)
  const finalVideoPad = "[vout]";
  filterChains.push(`${currentVideoPad}format=yuv420p,settb=AVTB${finalVideoPad}`);

  // --- 3. Compile Audio Graph via the single shared `compileSequenceAudioPlan` ---
  const audioPlan = compileSequenceAudioPlan(seq, paths, seq.stage.master_audio, {
    inputIndexOffset: nextInputIdx,
    minDurationMs: compileOptions?.minDurationMs,
  });
  inputArgs.push(...audioPlan.inputArgs);
  filterChains.push(audioPlan.filterComplex);

  return {
    inputArgs,
    filterComplex: ["sws_flags=accurate_rnd+full_chroma_int", ...filterChains].join(";"),
    videoOutPad: finalVideoPad,
    audioOutPad: audioPlan.audioOutPad,
    totalDurationMs,
    renderWidth,
    renderHeight,
    fps,
    assFilePath: assFilePaths[0] ?? null,
    assFilePaths,
    hyperframesBlobs,
  };
}
