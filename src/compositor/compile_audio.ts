// Audio filter-graph compiler shared by render and loudness measurement (split out of compiler.ts).
import { computeRenderDurationMs, resolveCueStartMs } from "../core/timeline.js";
import { CutholSequence, getCuePlaybackRate, maxSourceDurationMs, ParameterEnvelope } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import {
  resolveLibraryItemPath
} from "../library/probe.js";
import { buildAtempoChain, compileEnvelopeToFfmpegExpr, buildSeekableMediaInput } from "./compile_filters.js";

export interface CompileAudioOptions {
  inputIndexOffset?: number;
  minDurationMs?: number;
  activeWindowMs?: [number, number];
  applyMasterFinalize?: boolean;
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
  envelopeTimeBaseOffsetMs?: number;
  localSliceTrimSec?: [number, number];
  legacyPostAdelayClampEndSec?: number;
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

  const envOffsetMs = options.envelopeTimeBaseOffsetMs ?? 0;
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
      timeBaseOffsetMs: envOffsetMs,
      mode: "db_to_linear",
      baseGainDb: ac.gain_db,
    });
    if (gainExpr) {
      aFilters.push(`volume='${gainExpr}':eval=frame`);
    } else if (Math.abs(ac.gain_db) > 0.01) {
      aFilters.push(`volume=${ac.gain_db.toFixed(2)}dB`);
    }
    if (ac.fade_in_ms > 0) {
      const fadeInStartMs = envOffsetMs;
      if (fadeInStartMs + ac.fade_in_ms > 0) {
        const stSec = Math.max(0, fadeInStartMs / 1000).toFixed(3);
        const dSec = (Math.max(1, ac.fade_in_ms + Math.min(0, fadeInStartMs)) / 1000).toFixed(3);
        aFilters.push(`afade=t=in:st=${stSec}:d=${dSec}`);
      }
    }
    if (ac.fade_out_ms > 0) {
      const outStartMs = options.postTrimDurationMs - ac.fade_out_ms + envOffsetMs;
      if (outStartMs + ac.fade_out_ms > 0) {
        const outStart = Math.max(0, outStartMs / 1000).toFixed(3);
        const dSec = (ac.fade_out_ms / 1000).toFixed(3);
        aFilters.push(`afade=t=out:st=${outStart}:d=${dSec}`);
      }
    }
  }

  if (options.localSliceTrimSec) {
    const [slStart, slEnd] = options.localSliceTrimSec;
    aFilters.push(
      `atrim=start=${slStart.toFixed(6)}:end=${slEnd.toFixed(6)}`,
      `asetpts=PTS-STARTPTS`
    );
  }

  if (options.timelineStartMs > 0) {
    const delayStr = Number.isInteger(options.timelineStartMs)
      ? String(options.timelineStartMs)
      : options.timelineStartMs.toFixed(3);
    aFilters.push(`adelay=${delayStr}|${delayStr}`);
  }
  if (options.legacyPostAdelayClampEndSec !== undefined) {
    aFilters.push(
      `atrim=start=0:end=${options.legacyPostAdelayClampEndSec.toFixed(6)}`,
      `asetpts=PTS-STARTPTS`
    );
  }
  aFilters.push(`apad=whole_dur=${options.totalDurationSec}`);

  return `[${options.inputIdx}:a]${aFilters.join(",")}${options.outputPad}`;
}

export function buildMasterAudioFinalizeFilter(
  audioMixPads: string[],
  finalAudioPad: string,
  masterAudio?: CutholSequence["stage"]["master_audio"],
  applyMasterFinalize = true
): string {
  if (audioMixPads.length <= 1) {
    return `${audioMixPads[0]}aformat=sample_rates=48000:channel_layouts=stereo${finalAudioPad}`;
  }
  if (!applyMasterFinalize) {
    return `${audioMixPads.join("")}amix=inputs=${audioMixPads.length}:duration=first:dropout_transition=0:normalize=0,aformat=sample_rates=48000:channel_layouts=stereo${finalAudioPad}`;
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
  return `${audioMixPads.join("")}amix=inputs=${audioMixPads.length}:duration=first:dropout_transition=0:normalize=0${gainStage},alimiter=limit=${limiterLimit}:level=disabled:latency=1,apad=pad_dur=0.006${finalAudioPad}`;
}

export function compileSequenceAudioPlan(
  seq: CutholSequence,
  paths: WorkspacePaths,
  overrideMasterAudio?: CutholSequence["stage"]["master_audio"],
  options?: CompileAudioOptions
): CompiledAudioPlan {
  const fullDurationMs = computeRenderDurationMs(seq, options?.minDurationMs ?? 0);
  const activeWin = options?.activeWindowMs;
  const winStartMs = activeWin ? Math.max(0, activeWin[0]) : 0;
  const winEndMs = activeWin ? Math.max(winStartMs + 1, activeWin[1]) : fullDurationMs;
  const totalDurationMs = activeWin ? Math.round(winEndMs - winStartMs) : fullDurationMs;
  const totalDurationSec = activeWin
    ? Number(((winEndMs - winStartMs) / 1000).toFixed(6))
    : Number((totalDurationMs / 1000).toFixed(3));
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

  const appendAudioItemToPlan = (item: {
    padPrefix: string;
    absAssetPath: string;
    assetDurationMs: number;
    sampleRate?: number | null;
    srcInMs: number;
    srcOutMs: number;
    effectiveRate: number;
    preservePitch?: boolean;
    audioChain: CutholSequence["spine"]["clips"][number]["audio_chain"] | undefined;
    envelopes: ParameterEnvelope[];
    postTrimDurationMs: number;
    timelineStartMs: number;
  }): void => {
    const itemStartMs = item.timelineStartMs;
    const itemEndMs = itemStartMs + item.postTrimDurationMs;
    if (activeWin && (itemEndMs <= winStartMs + 1e-3 || itemStartMs >= winEndMs - 1e-3)) {
      return;
    }

    let readSrcInMs = item.srcInMs;
    let readSrcOutMs = item.srcOutMs;
    let relTimelineStartMs = item.timelineStartMs;
    let envOffsetMs = 0;
    let localSliceTrimSec: [number, number] | undefined;
    let legacyPostAdelayClampEndSec: number | undefined;
    const forceLegacyClamp = process.env.CUTHOL_TEST_LEGACY_POST_ADELAY_TRIM === "1";

    if (activeWin) {
      if (itemStartMs >= winStartMs) {
        relTimelineStartMs = Math.max(0, Number((itemStartMs - winStartMs).toFixed(3)));
        if (itemEndMs > winEndMs + 1e-3) {
          const maxLocalPlayMs = Math.max(0.001, winEndMs - itemStartMs);
          readSrcOutMs = Math.min(
            item.srcOutMs,
            item.srcInMs + Math.ceil((maxLocalPlayMs + 500) * item.effectiveRate)
          );
          if (forceLegacyClamp) {
            legacyPostAdelayClampEndSec = totalDurationSec;
          } else {
            const sliceEndSec = Math.max(
              0.001,
              (winEndMs - (winStartMs + relTimelineStartMs)) / 1000
            );
            localSliceTrimSec = [0, sliceEndSec];
          }
        }
      } else {
        relTimelineStartMs = 0;
        const localWinStartMs = winStartMs - itemStartMs;
        const localWinEndMs = Math.min(item.postTrimDurationMs, winEndMs - itemStartMs);
        const hasStatefulFilter = Boolean(
          item.audioChain?.denoise.enabled ||
            item.audioChain?.voice_clarity.enabled ||
            Math.abs(item.effectiveRate - 1.0) > 1e-3
        );
        let preRollMs = hasStatefulFilter ? Math.min(localWinStartMs, 500) : 0;
        const fadeInMs = item.audioChain?.fade_in_ms ?? 0;
        const fadeOutMs = item.audioChain?.fade_out_ms ?? 0;
        if (fadeInMs > 0 && localWinStartMs < fadeInMs) {
          preRollMs = localWinStartMs;
        }
        if (fadeOutMs > 0 && localWinStartMs > item.postTrimDurationMs - fadeOutMs) {
          const sinceFadeOutStartMs =
            localWinStartMs - Math.max(0, item.postTrimDurationMs - fadeOutMs);
          preRollMs = Math.max(preRollMs, sinceFadeOutStartMs);
        }
        const readLocalStartMs = Math.max(0, localWinStartMs - preRollMs);
        readSrcInMs = Math.min(
          item.srcOutMs,
          item.srcInMs + Math.floor(readLocalStartMs * item.effectiveRate)
        );
        readSrcOutMs = Math.min(
          item.srcOutMs,
          item.srcInMs + Math.ceil((localWinEndMs + 500) * item.effectiveRate)
        );
        const actualReadLocalStartMs = (readSrcInMs - item.srcInMs) / item.effectiveRate;
        envOffsetMs = -actualReadLocalStartMs;
        const sliceStartSec = Math.max(0, (localWinStartMs - actualReadLocalStartMs) / 1000);
        const sliceEndSec = Math.max(
          sliceStartSec + 0.001,
          (localWinEndMs - actualReadLocalStartMs) / 1000
        );
        localSliceTrimSec = [sliceStartSec, sliceEndSec];
      }
    }

    const seekInfo = buildSeekableMediaInput(
      item.absAssetPath,
      readSrcInMs,
      readSrcOutMs,
      item.assetDurationMs,
      Boolean(activeWin) || item.assetDurationMs >= 180_000
    );
    const inIdx = addInput(seekInfo.inputArgs);
    const aPad = `[${item.padPrefix}_${++aStepCounter}]`;
    filterChains.push(
      buildSingleAudioTrackFilterChain({
        inputIdx: inIdx,
        outputPad: aPad,
        srcInSec: seekInfo.localSrcInSec,
        srcOutSec: seekInfo.localSrcOutSec,
        effectiveRate: item.effectiveRate,
        preservePitch: item.preservePitch,
        sampleRate: item.sampleRate,
        audioChain: item.audioChain,
        envelopes: item.envelopes,
        postTrimDurationMs: item.postTrimDurationMs,
        timelineStartMs: relTimelineStartMs,
        totalDurationSec,
        envelopeTimeBaseOffsetMs: envOffsetMs,
        localSliceTrimSec,
        legacyPostAdelayClampEndSec,
      })
    );
    audioMixPads.push(aPad);
  };

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
      const effectiveRate = Math.max(0.1, Math.min(16.0, cueRate));
      const postTrimDurationMs =
        cueRate === 1.0 ? Math.max(0, srcOutMs - srcInMs) : cue.duration_ms;

      appendAudioItemToPlan({
        padPrefix: "a_cue",
        absAssetPath,
        assetDurationMs: asset.probe.duration_ms,
        sampleRate: asset.probe.sample_rate,
        srcInMs,
        srcOutMs,
        effectiveRate,
        preservePitch: cue.playback?.preserve_pitch,
        audioChain: cue.audio_chain,
        envelopes: cue.envelopes,
        postTrimDurationMs,
        timelineStartMs: cueStartMs,
      });
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
    const effectiveRate = Math.max(
      0.1,
      Math.min(16.0, (clip.source_out_ms - clip.source_in_ms) / Math.max(1, clip.duration_ms))
    );

    appendAudioItemToPlan({
      padPrefix: "a_sp",
      absAssetPath,
      assetDurationMs: asset.probe.duration_ms,
      sampleRate: asset.probe.sample_rate,
      srcInMs: clip.source_in_ms,
      srcOutMs: clip.source_out_ms,
      effectiveRate,
      preservePitch: clip.playback.preserve_pitch,
      audioChain: clip.audio_chain,
      envelopes: clip.envelopes,
      postTrimDurationMs: clip.duration_ms,
      timelineStartMs: clip.timeline_in_ms,
    });
  }

  for (const lane of overSpineLanes) {
    compileLaneAudio(lane);
  }

  const finalAudioPad = "[aout]";
  const effectiveMaster = overrideMasterAudio !== undefined ? overrideMasterAudio : seq.stage.master_audio;
  filterChains.push(
    buildMasterAudioFinalizeFilter(
      audioMixPads,
      finalAudioPad,
      effectiveMaster,
      options?.applyMasterFinalize ?? true
    )
  );

  return {
    inputArgs,
    filterComplex: filterChains.join(";"),
    audioOutPad: finalAudioPad,
    totalDurationMs,
    hasActiveAudio: audioMixPads.length > 1,
  };
}
