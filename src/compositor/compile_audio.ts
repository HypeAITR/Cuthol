// Audio filter-graph compiler shared by render and loudness measurement (split out of compiler.ts).
import { computeRenderDurationMs, resolveCueStartMs } from "../core/timeline.js";
import { CutholSequence, SpeedRampPoint, getCuePlaybackRate, maxSourceDurationMs, ParameterEnvelope } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import {
  resolveLibraryItemPath
} from "../library/probe.js";
import { buildAtempoChain, buildAudioRampTempoFilters, compileEnvelopeToFfmpegExpr, buildSeekableMediaInput } from "./compile_filters.js";
import { getAudioRampSlicesInRange, integrateRampSourceOffsetToLocalMs, invertRampLocalMsToSourceOffset } from "../sequence/spine_time.js";

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

/** The time map the audio follows in a ramped clip. */
export interface AudioRampInfo {
  spanMs: number;
  fallbackRate: number;
  ramp: SpeedRampPoint[];
}

/**
 * Slice grid for pitch-preserving (`atempo`) ramps: fewer, longer slices than
 * the default grid, so each independent WSOLA run has ample context. The
 * within-slice linear-vs-curve timing error stays ~1 ms at ratio 1.15.
 * The `asetrate` path keeps the default grid (sample-exact at any length).
 */
const PITCH_PRESERVING_SLICE_OPTIONS = { maxRateRatio: 1.15, maxSliceOutputMs: 500 };

/**
 * WSOLA settle margins (source ms). Measured (ffmpeg 8.1 `atempo`): a chained
 * run maps erratically over roughly its first 500 ms of input (up to ~25 ms
 * jitter and dropped transients on sparse content), while a single-stage run
 * settles immediately (only head skip + tail flush remain). Each slice therefore
 * reads extra context on both sides and the stretched margins are trimmed; the
 * `asetrate` path needs no margins (sample-exact) and gets none.
 */
const RAMP_MARGIN_IN_MS_PER_STAGE = 250;
const RAMP_MARGIN_IN_MS_SINGLE_STAGE = 100;

function rampSliceMarginInMs(tempoFilters: string[]): number {
  if (tempoFilters.length === 0) return 0;
  if (tempoFilters.length === 1) return RAMP_MARGIN_IN_MS_SINGLE_STAGE;
  return RAMP_MARGIN_IN_MS_PER_STAGE * tempoFilters.length;
}

interface RampedSliceMargin {
  useHeadMs: number;
  padHeadMs: number;
  useTailMs: number;
  padTailMs: number;
}

/**
 * Settle-margin split for one ramped slice: real source context where the seek
 * window has it, silence padding (adelay/apad before the stretcher) where it
 * does not. The first slice through at most one WSOLA stage takes no head
 * margin: the stream head passes through verbatim, so content at the clip head
 * survives exactly.
 */
function splitRampedSliceMargin(options: {
  marginInMs: number;
  sliceAbsU0Ms: number;
  sliceAbsU1Ms: number;
  readAbsInMs: number;
  readAbsOutMs: number;
  isFirstSlice: boolean;
  tempoStageCount: number;
}): RampedSliceMargin {
  const headAvailMs = Math.max(0, options.sliceAbsU0Ms - options.readAbsInMs);
  const tailAvailMs = Math.max(0, options.readAbsOutMs - options.sliceAbsU1Ms);
  let useHeadMs = Math.min(options.marginInMs, headAvailMs);
  let padHeadMs = options.marginInMs - useHeadMs;
  if (options.isFirstSlice && options.tempoStageCount <= 1) {
    useHeadMs = 0;
    padHeadMs = 0;
  }
  const useTailMs = Math.min(options.marginInMs, tailAvailMs);
  const padTailMs = options.marginInMs - useTailMs;
  return { useHeadMs, padHeadMs, useTailMs, padTailMs };
}

/**
 * One ramped slice: source trim (with settle margins) + stretcher + exact keep
 * window + duration safety net. With zero margins the emitted text is exactly
 * the historical form (`atrim=start=0:end=...`), keeping the asetrate path
 * byte-identical.
 */
function buildRampedSliceFilterParts(options: {
  trimStartSec: string;
  trimEndSec: string;
  padHeadMs: number;
  padTailMs: number;
  tempo: string[];
  keepStartMs: number;
  keepDurationMs: number;
}): string[] {
  const parts = [
    `atrim=start=${options.trimStartSec}:end=${options.trimEndSec}`,
    `asetpts=PTS-STARTPTS`,
  ];
  if (options.padHeadMs > 0.0005) {
    parts.push(`adelay=${options.padHeadMs.toFixed(3)}|${options.padHeadMs.toFixed(3)}`);
  }
  if (options.padTailMs > 0.0005) {
    parts.push(`apad=pad_dur=${(options.padTailMs / 1000).toFixed(6)}`);
  }
  parts.push(...options.tempo);
  const keepDurSec = (options.keepDurationMs / 1000).toFixed(6);
  const keepStartSec = options.keepStartMs === 0 ? "0" : (options.keepStartMs / 1000).toFixed(6);
  const keepEndSec =
    options.keepStartMs === 0 ? keepDurSec : ((options.keepStartMs + options.keepDurationMs) / 1000).toFixed(6);
  parts.push(
    `atrim=start=${keepStartSec}:end=${keepEndSec}`,
    `asetpts=PTS-STARTPTS`,
    `apad=whole_dur=${keepDurSec}`
  );
  return parts;
}

/**
 * Post-rate audio chain (denoise, voice, gain, fade,
 * slice trimming, delay, padding). Produces the same order and form as the
 * post-rate block inside `buildSingleAudioTrackFilterChain`; factored out only
 * for the ramped (multi-slice) path, to be applied to the `concat` output.
 * The unramped path stays as-is inside `buildSingleAudioTrackFilterChain`.
 */
function buildRampedAudioPostFilters(options: {
  audioChain: CutholSequence["spine"]["clips"][number]["audio_chain"] | undefined;
  envelopes: ParameterEnvelope[];
  postTrimDurationMs: number;
  envelopeTimeBaseOffsetMs: number;
  localSliceTrimSec?: [number, number];
  timelineStartMs: number;
  legacyPostAdelayClampEndSec?: number;
  totalDurationSec: number;
}): string[] {
  const aFilters: string[] = [];
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
  return aFilters;
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
    rampInfo?: AudioRampInfo;
  }): void => {
    const itemStartMs = item.timelineStartMs;
    const itemEndMs = itemStartMs + item.postTrimDurationMs;
    if (activeWin && (itemEndMs <= winStartMs + 1e-3 || itemStartMs >= winEndMs - 1e-3)) {
      return;
    }

    // In a ramped (>=2 points) clip the audio follows the same integral
    // map as the video (slice + slice rate + exact duration clamp + concat).
    // The clamp (atrim 0:dt + apad dt) is required: measurements show each slice's
    // atempo output wobbles +-2ms with content (longer in tone, shorter in silence);
    // without the clamp the drift over 24 slices exceeds the 33ms frame bound. The
    // unramped path below is kept as-is (filter text byte-identical).
    //
    // Pitch-preserving slices additionally read settle margins on both sides:
    // each independent atempo run consumes its head (startup skip) and tail
    // (unflushed buffer), and chained runs map erratically over ~500 ms of
    // input; without margins the clamp backfills the lost span with silence
    // (audible gaps, lost transients at slice joints). The margins are trimmed
    // after stretching, so slice boundaries stay sample-exact. The asetrate
    // path is sample-exact without margins and keeps the old filter text
    // byte-identical (zero margins, default grid).
    const rampInfo = item.rampInfo;
    if (rampInfo && rampInfo.ramp.length >= 2) {
      const rampSpanMs = Math.max(1, rampInfo.spanMs);
      const rampFallbackRate = rampInfo.fallbackRate;
      const ramp = rampInfo.ramp;
      let rampReadSrcInMs = item.srcInMs;
      let rampReadSrcOutMs = item.srcOutMs;
      let rampRelTimelineStartMs = item.timelineStartMs;
      let rampEnvOffsetMs = 0;
      let rampLocalSliceTrimSec: [number, number] | undefined;
      let rampLegacyClampEndSec: number | undefined;
      let rampSlices: ReturnType<typeof getAudioRampSlicesInRange>;
      const pitchPreserving = item.preservePitch !== false;
      const rampSliceOptions = pitchPreserving ? PITCH_PRESERVING_SLICE_OPTIONS : undefined;
      if (!activeWin) {
        rampSlices = getAudioRampSlicesInRange(rampSpanMs, rampFallbackRate, ramp, 0, rampSpanMs, rampSliceOptions);
      } else if (itemStartMs >= winStartMs) {
        rampRelTimelineStartMs = Math.max(0, Number((itemStartMs - winStartMs).toFixed(3)));
        if (itemEndMs > winEndMs + 1e-3) {
          const maxLocalPlayMs = Math.max(0.001, winEndMs - itemStartMs);
          const uReadEnd = invertRampLocalMsToSourceOffset(
            rampSpanMs, rampFallbackRate, ramp, maxLocalPlayMs + 500
          );
          rampReadSrcOutMs = Math.min(item.srcOutMs, item.srcInMs + Math.ceil(uReadEnd));
          const readU1 = Math.max(1, rampReadSrcOutMs - item.srcInMs);
          rampSlices = getAudioRampSlicesInRange(rampSpanMs, rampFallbackRate, ramp, 0, readU1, rampSliceOptions);
          const forceLegacyClamp = process.env.CUTHOL_TEST_LEGACY_POST_ADELAY_TRIM === "1";
          if (forceLegacyClamp) {
            rampLegacyClampEndSec = totalDurationSec;
          } else {
            const sliceEndSec = Math.max(
              0.001,
              (winEndMs - (winStartMs + rampRelTimelineStartMs)) / 1000
            );
            rampLocalSliceTrimSec = [0, sliceEndSec];
          }
        } else {
          rampSlices = getAudioRampSlicesInRange(rampSpanMs, rampFallbackRate, ramp, 0, rampSpanMs, rampSliceOptions);
        }
      } else {
        rampRelTimelineStartMs = 0;
        const localWinStartMs = winStartMs - itemStartMs;
        const localWinEndMs = Math.min(item.postTrimDurationMs, winEndMs - itemStartMs);
        const rampHasStatefulFilter = true;
        let rampPreRollMs = rampHasStatefulFilter ? Math.min(localWinStartMs, 500) : 0;
        const rampFadeInMs = item.audioChain?.fade_in_ms ?? 0;
        const rampFadeOutMs = item.audioChain?.fade_out_ms ?? 0;
        if (rampFadeInMs > 0 && localWinStartMs < rampFadeInMs) {
          rampPreRollMs = localWinStartMs;
        }
        if (rampFadeOutMs > 0 && localWinStartMs > item.postTrimDurationMs - rampFadeOutMs) {
          const sinceFadeOutStartMs =
            localWinStartMs - Math.max(0, item.postTrimDurationMs - rampFadeOutMs);
          rampPreRollMs = Math.max(rampPreRollMs, sinceFadeOutStartMs);
        }
        const rampReadLocalStartMs = Math.max(0, localWinStartMs - rampPreRollMs);
        const rampUStart = invertRampLocalMsToSourceOffset(
          rampSpanMs, rampFallbackRate, ramp, rampReadLocalStartMs
        );
        const rampUEnd = invertRampLocalMsToSourceOffset(
          rampSpanMs, rampFallbackRate, ramp, localWinEndMs + 500
        );
        rampReadSrcInMs = Math.min(item.srcOutMs, item.srcInMs + Math.floor(rampUStart));
        rampReadSrcOutMs = Math.min(item.srcOutMs, item.srcInMs + Math.ceil(rampUEnd));
        const rampReadU0 = Math.max(0, rampReadSrcInMs - item.srcInMs);
        const rampReadU1 = Math.max(rampReadU0 + 1, rampReadSrcOutMs - item.srcInMs);
        rampSlices = getAudioRampSlicesInRange(
          rampSpanMs, rampFallbackRate, ramp, rampReadU0, rampReadU1, rampSliceOptions
        );
        const rampActualReadLocalStartMs = integrateRampSourceOffsetToLocalMs(
          rampSpanMs, rampFallbackRate, ramp, rampReadU0
        );
        rampEnvOffsetMs = -rampActualReadLocalStartMs;
        const rampSliceStartSec = Math.max(0, (localWinStartMs - rampActualReadLocalStartMs) / 1000);
        const rampSliceEndSec = Math.max(
          rampSliceStartSec + 0.001,
          (localWinEndMs - rampActualReadLocalStartMs) / 1000
        );
        rampLocalSliceTrimSec = [rampSliceStartSec, rampSliceEndSec];
      }
      if (rampSlices.length === 0) {
        return;
      }
      const rampSeekInfo = buildSeekableMediaInput(
        item.absAssetPath,
        rampReadSrcInMs,
        rampReadSrcOutMs,
        item.assetDurationMs,
        Boolean(activeWin) || item.assetDurationMs >= 180_000
      );
      const rampInIdx = addInput(rampSeekInfo.inputArgs);
      if (rampSlices.length === 1) {
        const s = rampSlices[0];
        const aPad = `[${item.padPrefix}_${++aStepCounter}]`;
        const sTempo = buildAudioRampTempoFilters(s.rate, item.preservePitch, item.sampleRate);
        const sMarginInMs = pitchPreserving ? rampSliceMarginInMs(sTempo) : 0;
        const sMargin = splitRampedSliceMargin({
          marginInMs: sMarginInMs,
          sliceAbsU0Ms: item.srcInMs + s.u0,
          sliceAbsU1Ms: item.srcInMs + s.u1,
          readAbsInMs: rampReadSrcInMs,
          readAbsOutMs: rampReadSrcOutMs,
          isFirstSlice: true,
          tempoStageCount: sTempo.length,
        });
        const sT0 = ((item.srcInMs + s.u0 - sMargin.useHeadMs) / 1000 - rampSeekInfo.seekSec).toFixed(6);
        const sT1 = ((item.srcInMs + s.u1 + sMargin.useTailMs) / 1000 - rampSeekInfo.seekSec).toFixed(6);
        const sHeadDropMs = (sMargin.useHeadMs + sMargin.padHeadMs) / Math.max(1e-9, s.rate);
        const sPost = buildRampedAudioPostFilters({
          audioChain: item.audioChain,
          envelopes: item.envelopes,
          postTrimDurationMs: item.postTrimDurationMs,
          envelopeTimeBaseOffsetMs: rampEnvOffsetMs,
          localSliceTrimSec: rampLocalSliceTrimSec,
          timelineStartMs: rampRelTimelineStartMs,
          legacyPostAdelayClampEndSec: rampLegacyClampEndSec,
          totalDurationSec,
        });
        const sParts = [
          ...buildRampedSliceFilterParts({
            trimStartSec: sT0,
            trimEndSec: sT1,
            padHeadMs: sMargin.padHeadMs,
            padTailMs: sMargin.padTailMs,
            tempo: sTempo,
            keepStartMs: sHeadDropMs,
            keepDurationMs: s.dt,
          }),
          ...sPost,
        ];
        filterChains.push(`[${rampInIdx}:a]${sParts.join(",")}${aPad}`);
        audioMixPads.push(aPad);
        return;
      }
      const rampPadIdx = ++aStepCounter;
      const rampOutPad = `[${item.padPrefix}_${rampPadIdx}]`;
      const rampSplitPads = rampSlices.map((_, i) => `[${item.padPrefix}_${rampPadIdx}_in${i}]`);
      const rampSliceOutPads = rampSlices.map((_, i) => `[${item.padPrefix}_${rampPadIdx}_s${i}]`);
      const rampConcatPad = `[${item.padPrefix}_${rampPadIdx}_cat]`;
      // Joints: when both neighboring slices are >= 6ms, a 5ms crossfade (acrossfade),
      // otherwise a plain concat. A crossfaded slice extends its source right by
      // 5ms*output rate; total duration is unchanged (extension - overlap = 0).
      const RAMP_XFADE_MS = 5;
      const RAMP_XFADE_MIN_SLICE_MS = 6;
      const rampXfadeAfter: boolean[] = rampSlices.map((s, i) => {
        if (i >= rampSlices.length - 1) return false;
        const nxt = rampSlices[i + 1];
        return s.dt >= RAMP_XFADE_MIN_SLICE_MS && nxt.dt >= RAMP_XFADE_MIN_SLICE_MS;
      });
      filterChains.push(`[${rampInIdx}:a]asplit=${rampSlices.length}${rampSplitPads.join("")}`);
      rampSlices.forEach((s, i) => {
        const extendMs = rampXfadeAfter[i] ? RAMP_XFADE_MS : 0;
        const extSrcMs = extendMs > 0 ? extendMs * s.rate : 0;
        const sliceDuMs = s.u1 - s.u0 + extSrcMs;
        const sliceOutMs = s.dt + extendMs;
        const sliceRate = sliceDuMs / Math.max(1e-9, sliceOutMs);
        const tempo = buildAudioRampTempoFilters(sliceRate, item.preservePitch, item.sampleRate);
        const marginInMs = pitchPreserving ? rampSliceMarginInMs(tempo) : 0;
        const margin = splitRampedSliceMargin({
          marginInMs,
          sliceAbsU0Ms: item.srcInMs + s.u0,
          sliceAbsU1Ms: item.srcInMs + s.u1,
          readAbsInMs: rampReadSrcInMs,
          readAbsOutMs: rampReadSrcOutMs,
          isFirstSlice: i === 0,
          tempoStageCount: tempo.length,
        });
        const t0 = ((item.srcInMs + s.u0 - margin.useHeadMs) / 1000 - rampSeekInfo.seekSec).toFixed(6);
        const t1 = ((item.srcInMs + s.u1 + margin.useTailMs + extSrcMs) / 1000 - rampSeekInfo.seekSec).toFixed(6);
        const headDropMs = (margin.useHeadMs + margin.padHeadMs) / Math.max(1e-9, sliceRate);
        const parts = buildRampedSliceFilterParts({
          trimStartSec: t0,
          trimEndSec: t1,
          padHeadMs: margin.padHeadMs,
          padTailMs: margin.padTailMs,
          tempo,
          keepStartMs: headDropMs,
          keepDurationMs: sliceOutMs,
        });
        filterChains.push(`${rampSplitPads[i]}${parts.join(",")}${rampSliceOutPads[i]}`);
      });
      let rampMixedPad = rampSliceOutPads[0];
      for (let i = 1; i < rampSlices.length; i++) {
        const isLast = i === rampSlices.length - 1;
        const jointPad = isLast ? rampConcatPad : `[${item.padPrefix}_${rampPadIdx}_m${i}]`;
        if (rampXfadeAfter[i - 1]) {
          filterChains.push(
            `${rampMixedPad}${rampSliceOutPads[i]}acrossfade=d=0.005:curve1=tri:curve2=tri${jointPad}`
          );
        } else {
          filterChains.push(`${rampMixedPad}${rampSliceOutPads[i]}concat=n=2:v=0:a=1${jointPad}`);
        }
        rampMixedPad = jointPad;
      }
      const rampPostFilters = buildRampedAudioPostFilters({
        audioChain: item.audioChain,
        envelopes: item.envelopes,
        postTrimDurationMs: item.postTrimDurationMs,
        envelopeTimeBaseOffsetMs: rampEnvOffsetMs,
        localSliceTrimSec: rampLocalSliceTrimSec,
        timelineStartMs: rampRelTimelineStartMs,
        legacyPostAdelayClampEndSec: rampLegacyClampEndSec,
        totalDurationSec,
      });
      filterChains.push(`${rampConcatPad}${rampPostFilters.join(",")}${rampOutPad}`);
      audioMixPads.push(rampOutPad);
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
      rampInfo:
        clip.playback.speed_ramp && clip.playback.speed_ramp.length >= 2
          ? {
              spanMs: Math.max(1, clip.source_out_ms - clip.source_in_ms),
              fallbackRate: clip.playback.rate,
              ramp: clip.playback.speed_ramp,
            }
          : undefined,
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
