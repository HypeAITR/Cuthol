/**
 * Spectral-Flux Onset & Beat Detector (`src/library/beats.ts`).
 *
 * Computes half-wave rectified spectral flux on 16 kHz PCM frames (hop = 256 samples = 16 ms),
 * applies adaptive moving-average thresholding, enforces a minimum inter-onset interval (220 ms),
 * and estimates tempo (BPM) via inter-onset histogram clustering.
 */

import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { loadSequence, updateSequenceInPlace } from "../core/workspace.js";
import { MediaLedger } from "./ledger.js";
import { resolveLibraryItemPath } from "./probe.js";
import { extractMono16kPcm, radix2Fft } from "./waveform.js";

export interface OnsetPeak {
  time_ms: number;
  strength: number;
}

export interface TempoResolutionInfo {
  raw_bpm: number;
  resolved_bpm: number;
  preferred_range_bpm: [number, number];
  half_tempo_bpm: number;
  double_tempo_bpm: number;
  subharmonic_2_3_bpm: number;
  confidence: number;
  resolution:
    | "in_range"
    | "doubled_from_half"
    | "halved_from_double"
    | "resolved_from_subharmonic"
    | "no_periodic_pulse";
  note: string;
}

export interface BeatAnalysisResult {
  handle: string;
  sha256: string;
  duration_ms: number;
  sensitivity: number;
  estimated_bpm: number;
  grid_bpm: number;
  phase_ms: number;
  beat_period_ms: number;
  grid_count: number;
  grid_ms: number[];
  onsets_count: number;
  onsets_ms: number[];
  onsets: OnsetPeak[];
  tempo_resolution: TempoResolutionInfo;
  beats_count: number;
  beats_ms: number[];
}

export function analyzeAssetBeats(options: {
  workspaceDir: string;
  handle: string;
  sensitivity?: number;
}): BeatAnalysisResult {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const item = sequence.library.find((x) => x.handle === options.handle);
  if (!item) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.handle));
  }
  if (!item.probe.has_audio) {
    throw new CutholError(DIAGNOSTICS.NO_AUDIO_STREAM(options.handle));
  }

  const rawSens = Number.isFinite(options.sensitivity) ? options.sensitivity! : 1.35;
  const sensitivity = Math.max(0.8, Math.min(3.0, rawSens));
  const ledger = new MediaLedger(paths.ledgerFile);

  try {
    let cached = ledger.getBeats<BeatAnalysisResult>(item.digest_sha256, sensitivity);
    if (
      !cached ||
      !Array.isArray(cached.grid_ms) ||
      !Array.isArray(cached.onsets) ||
      typeof cached.phase_ms !== "number" ||
      !cached.tempo_resolution
    ) {
      const absFile = resolveLibraryItemPath(paths.rootDir, item);
      const samples = extractMono16kPcm(absFile);
      const sampleRate = OPEN_STANDARDS.SPECTRAL_BANDS_HZ.ANALYSIS_SAMPLE_RATE;
      const durationMs =
        samples.length > 0 ? Math.round((samples.length / sampleRate) * 1000) : item.probe.duration_ms;

      const frameSize = 512; // 32 ms window at 16 kHz
      const hopSize = 128; // 8 ms hop (125 Hz frame rate) for <= 20 ms phase accuracy
      const hopMs = (hopSize / sampleRate) * 1000;
      const winCenterOffsetMs = ((frameSize / 2) / sampleRate) * 1000; // 16 ms
      const numFrames = Math.max(1, Math.floor((samples.length - frameSize) / hopSize));

      const prevMag = new Float64Array(frameSize >> 1);
      const prevLogMag = new Float64Array(frameSize >> 1);
      const linFlux = new Float64Array(numFrames);
      const logFlux = new Float64Array(numFrames);
      const real = new Float64Array(frameSize);
      const imag = new Float64Array(frameSize);

      for (let f = 0; f < numFrames; f++) {
        const offset = f * hopSize;
        real.fill(0);
        imag.fill(0);
        for (let i = 0; i < frameSize; i++) {
          const s = (samples[offset + i] ?? 0) / 32768.0;
          const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameSize - 1)));
          real[i] = s * hann;
        }
        radix2Fft(real, imag);

        let frameLinFlux = 0;
        let frameLogFlux = 0;
        for (let k = 1; k < frameSize >> 1; k++) {
          const mag = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
          const lmag = Math.log1p(100 * mag);
          const diffLin = mag - prevMag[k];
          if (diffLin > 0) {
            frameLinFlux += diffLin;
          }
          if (f > 0) {
            const diffLog = lmag - prevLogMag[k];
            if (diffLog > 0) {
              frameLogFlux += diffLog;
            }
          }
          prevMag[k] = mag;
          prevLogMag[k] = lmag;
        }
        linFlux[f] = frameLinFlux;
        logFlux[f] = frameLogFlux;
      }

      // 1. Detect Onsets with Strength using strength-descending Non-Maximum Suppression (NMS)
      // so weak pre-echoes never shadow stronger beats and strong onsets remain invariant across sensitivities.
      const winRadius = 24; // +/- 192 ms at 8 ms hop
      const minInterBeatMs = 220;
      const candidatePeaks: Array<{ time_ms: number; raw_flux: number }> = [];
      let globalMaxPeakFlux = 0;

      for (let f = 1; f < numFrames - 1; f++) {
        if (linFlux[f] <= linFlux[f - 1] || linFlux[f] < linFlux[f + 1]) continue;
        if (linFlux[f] > globalMaxPeakFlux) {
          globalMaxPeakFlux = linFlux[f];
        }

        let sum = 0;
        let count = 0;
        for (
          let w = Math.max(0, f - winRadius);
          w <= Math.min(numFrames - 1, f + winRadius);
          w++
        ) {
          if (Math.abs(w - f) <= 2) continue;
          sum += linFlux[w];
          count++;
        }
        const localMean = sum / Math.max(1, count);
        const thresholdMultiplier = 2.4 / sensitivity;

        if (linFlux[f] > localMean * thresholdMultiplier && linFlux[f] > 0.05) {
          const denom = linFlux[f - 1] - 2 * linFlux[f] + linFlux[f + 1];
          const delta =
            Math.abs(denom) > 1e-9
              ? Math.max(-0.5, Math.min(0.5, (0.5 * (linFlux[f - 1] - linFlux[f + 1])) / denom))
              : 0;
          const timeMs = Math.max(
            0,
            Math.min(durationMs, Math.round((f + delta) * hopMs + winCenterOffsetMs))
          );
          candidatePeaks.push({ time_ms: timeMs, raw_flux: linFlux[f] });
        }
      }

      // Sort candidates strongest-first, accept if >= minInterBeatMs from all stronger accepted peaks
      candidatePeaks.sort((a, b) => b.raw_flux - a.raw_flux || a.time_ms - b.time_ms);
      const acceptedOnsets: Array<{ time_ms: number; raw_flux: number }> = [];
      for (const cand of candidatePeaks) {
        const tooClose = acceptedOnsets.some(
          (acc) => Math.abs(acc.time_ms - cand.time_ms) < minInterBeatMs
        );
        if (!tooClose) {
          acceptedOnsets.push(cand);
        }
      }
      acceptedOnsets.sort((a, b) => a.time_ms - b.time_ms);

      const refFlux = Math.max(1e-6, globalMaxPeakFlux);
      const onsets: OnsetPeak[] = acceptedOnsets.map((o) => ({
        time_ms: o.time_ms,
        strength: Number(Math.max(0.05, Math.min(1.0, o.raw_flux / refFlux)).toFixed(3)),
      }));
      const onsetsMs = onsets.map((o) => o.time_ms);

      // 2. Sensitivity-Independent Tempo & Phase Estimation for the Beat Grid
      const gridEst = estimateTempoAndPhaseGrid({
        linFlux,
        logFlux,
        numFrames,
        hopMs,
        winCenterOffsetMs,
        durationMs,
      });

      const effectiveBeatsMs = gridEst.grid_ms.length > 0 ? gridEst.grid_ms : onsetsMs;

      cached = {
        handle: item.handle,
        sha256: item.digest_sha256,
        duration_ms: durationMs,
        sensitivity,
        estimated_bpm: gridEst.grid_bpm,
        grid_bpm: gridEst.grid_bpm,
        phase_ms: gridEst.phase_ms,
        beat_period_ms: gridEst.beat_period_ms,
        grid_count: gridEst.grid_ms.length,
        grid_ms: gridEst.grid_ms,
        onsets_count: onsets.length,
        onsets_ms: onsetsMs,
        onsets,
        tempo_resolution: gridEst.tempo_resolution,
        beats_count: effectiveBeatsMs.length,
        beats_ms: effectiveBeatsMs,
      };
      ledger.setBeats(item.digest_sha256, sensitivity, cached);
    }

    const refId = `beat_${item.digest_sha256.slice(0, 8)}`;
    updateSequenceInPlace(options.workspaceDir, (seq) => {
      const target = seq.library.find((x) => x.handle === item.handle);
      if (target) {
        target.analysis_refs.beats = refId;
      }
    });

    return {
      ...cached,
      handle: item.handle,
    };
  } finally {
    ledger.close();
  }
}

function estimateTempoAndPhaseGrid(params: {
  linFlux: Float64Array;
  logFlux: Float64Array;
  numFrames: number;
  hopMs: number;
  winCenterOffsetMs: number;
  durationMs: number;
}): {
  grid_bpm: number;
  phase_ms: number;
  beat_period_ms: number;
  grid_ms: number[];
  tempo_resolution: TempoResolutionInfo;
} {
  const { linFlux, logFlux, numFrames, hopMs, winCenterOffsetMs, durationMs } = params;
  const winR = 24;
  const logNov = new Float64Array(numFrames);
  const linNov = new Float64Array(numFrames);
  let totalLogNov = 0;

  for (let f = 1; f < numFrames; f++) {
    let sumLog = 0;
    let sumLin = 0;
    let cnt = 0;
    for (let w = Math.max(1, f - winR); w <= Math.min(numFrames - 1, f + winR); w++) {
      if (Math.abs(w - f) <= 2) continue;
      sumLog += logFlux[w];
      sumLin += linFlux[w];
      cnt++;
    }
    const meanLog = sumLog / Math.max(1, cnt);
    const exLog = logFlux[f] - meanLog * 1.25;
    logNov[f] = exLog > 0 && logFlux[f] > 0.2 ? exLog : 0;
    totalLogNov += logNov[f];

    const meanLin = sumLin / Math.max(1, cnt);
    const exLin = linFlux[f] - meanLin * 1.25;
    linNov[f] = exLin > 0 && linFlux[f] > 0.05 ? exLin : 0;
  }

  // Extract sensitivity-independent reference peaks to verify whether a periodic musical rhythm exists
  const refPeaksMs: number[] = [];
  for (let f = 1; f < numFrames - 1; f++) {
    if (linNov[f] <= linNov[f - 1] || linNov[f] < linNov[f + 1] || linNov[f] <= 0.05) continue;
    const tMs = Math.round(f * hopMs + winCenterOffsetMs);
    if (refPeaksMs.length === 0 || tMs - refPeaksMs[refPeaksMs.length - 1] >= 180) {
      refPeaksMs.push(tMs);
    }
  }

  let musicalIntervals = 0;
  for (let i = 0; i < refPeaksMs.length; i++) {
    for (let j = i + 1; j <= Math.min(refPeaksMs.length - 1, i + 3); j++) {
      const dt = refPeaksMs[j] - refPeaksMs[i];
      if (dt >= 250 && dt <= 1600) {
        musicalIntervals++;
      }
    }
  }

  const sampleArr = (arr: Float64Array, idx: number): number => {
    if (idx < 0 || idx >= numFrames - 1) return 0;
    const i = Math.floor(idx);
    const frac = idx - i;
    return arr[i] * (1 - frac) + arr[i + 1] * frac;
  };

  const acAtLag = (lagFrames: number): number => {
    if (lagFrames < 2 || lagFrames >= numFrames - 2) return 0;
    let s = 0;
    let c = 0;
    for (let f = 1; f + lagFrames < numFrames - 1; f++) {
      s += logNov[f] * sampleArr(logNov, f + lagFrames);
      c++;
    }
    return c > 0 ? s / c : 0;
  };

  const preferredRange: [number, number] = [80, 160];

  if (refPeaksMs.length < 4 || musicalIntervals < 2 || totalLogNov <= 1e-3) {
    return {
      grid_bpm: 0,
      phase_ms: 0,
      beat_period_ms: 0,
      grid_ms: [],
      tempo_resolution: {
        raw_bpm: 0,
        resolved_bpm: 0,
        preferred_range_bpm: preferredRange,
        half_tempo_bpm: 0,
        double_tempo_bpm: 0,
        subharmonic_2_3_bpm: 0,
        confidence: 0,
        resolution: "no_periodic_pulse",
        note: "Periyodik müzik vuruşu tespit edilmedi (düz sinyal veya seyrek tekil darbe); ızgara üretilmedi.",
      },
    };
  }

  const evaluateCandidateBpm = (bpm: number): {
    rawScore: number;
    weightedScore: number;
    ac1: number;
    ac05: number;
  } => {
    const periodFrames = (60_000 / bpm) / hopMs;
    const ac1 = acAtLag(1.0 * periodFrames);
    const ac2 = acAtLag(2.0 * periodFrames);
    const ac3 = acAtLag(3.0 * periodFrames);
    const ac4 = acAtLag(4.0 * periodFrames);
    const ac05 = acAtLag(0.5 * periodFrames);

    const acScore = 1.0 * ac1 + 0.7 * ac2 + 0.5 * ac3 + 0.6 * ac4 + 0.35 * ac05;

    const phaseSteps = Math.max(24, Math.round(periodFrames));
    let bestComb = 0;
    for (let p = 0; p < phaseSteps; p++) {
      const phFrame = (p / phaseSteps) * periodFrames;
      let capturedE = 0;
      let nPulses = 0;
      for (let k = 0; ; k++) {
        const center = phFrame + k * periodFrames;
        if (center >= numFrames - 1) break;
        const localE =
          sampleArr(logNov, center) +
          0.7 * (sampleArr(logNov, center - 1) + sampleArr(logNov, center + 1)) +
          0.3 * (sampleArr(logNov, center - 2) + sampleArr(logNov, center + 2));
        capturedE += localE;
        nPulses++;
      }
      const precision = capturedE / Math.max(1, nPulses);
      const recall = capturedE / Math.max(1e-6, totalLogNov);
      const fScore = Math.pow(precision, 0.5) * Math.pow(recall, 0.5);
      if (fScore > bestComb) {
        bestComb = fScore;
      }
    }

    const rawScore = acScore * bestComb;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.55, 2));
    const weightedScore = rawScore * (0.75 + 0.25 * prior);
    return { rawScore, weightedScore, ac1, ac05 };
  };

  let bestBpm = 120;
  let bestWeighted = -1;
  let rawBestBpm = 120;
  let maxRawOnly = -1;

  for (let bpm = 68; bpm <= 165; bpm += 0.2) {
    const cand = evaluateCandidateBpm(bpm);
    const roundedBpm = Number(bpm.toFixed(1));
    if (cand.rawScore > maxRawOnly) {
      maxRawOnly = cand.rawScore;
      rawBestBpm = roundedBpm;
    }
    if (cand.weightedScore > bestWeighted) {
      bestWeighted = cand.weightedScore;
      bestBpm = roundedBpm;
    }
  }

  // Fine search (+/- 0.3 BPM in 0.05 BPM steps) around bestBpm
  const coarseWinner = bestBpm;
  for (
    let bpm = Math.max(68, coarseWinner - 0.3);
    bpm <= Math.min(165, coarseWinner + 0.3);
    bpm += 0.05
  ) {
    const cand = evaluateCandidateBpm(bpm);
    if (cand.weightedScore > bestWeighted) {
      bestWeighted = cand.weightedScore;
      bestBpm = Number(bpm.toFixed(1));
    }
  }

  const periodMs = 60_000 / bestBpm;
  let bestPhaseMs = 0;
  let maxPhaseE = -1;
  for (let ph = 0; ph < periodMs; ph += 1) {
    let e = 0;
    let cnt = 0;
    for (let t = ph; t < durationMs; t += periodMs) {
      const fr = (t - winCenterOffsetMs) / hopMs;
      if (fr >= 0 && fr < numFrames - 1) {
        e +=
          sampleArr(linNov, fr) +
          0.5 * (sampleArr(linNov, fr - 1) + sampleArr(linNov, fr + 1));
        cnt++;
      }
    }
    const avgE = e / Math.max(1, cnt);
    if (avgE > maxPhaseE) {
      maxPhaseE = avgE;
      bestPhaseMs = ph;
    }
  }

  if (periodMs - bestPhaseMs <= 6) {
    bestPhaseMs = 0;
  }

  const gridMs: number[] = [];
  for (let k = 0; ; k++) {
    const beatMs = Math.round(bestPhaseMs + k * periodMs);
    if (beatMs > durationMs) break;
    gridMs.push(beatMs);
  }

  const halfBpm = Number((bestBpm / 2).toFixed(1));
  const doubleBpm = Number((bestBpm * 2).toFixed(1));
  const sub23Bpm = Number(((bestBpm * 2) / 3).toFixed(1));
  const ac1Best = acAtLag((60_000 / bestBpm) / hopMs);
  const acSub23 = acAtLag((60_000 / sub23Bpm) / hopMs);

  let resolutionKind: TempoResolutionInfo["resolution"] = "in_range";
  let note = `Tempo ${bestBpm} BPM (periyot ${periodMs.toFixed(1)} ms, faz ${bestPhaseMs} ms) tercih edilen [${preferredRange[0]}..${preferredRange[1]}] BPM aralığında kararlı.`;
  if (Math.abs(rawBestBpm - halfBpm) <= 2.0) {
    resolutionKind = "doubled_from_half";
    note = `Yarım tempo adayı (${rawBestBpm} BPM) algısal oktav önceliğiyle ${bestBpm} BPM ana temposuna çözümlendi.`;
  } else if (Math.abs(rawBestBpm - doubleBpm) <= 3.0) {
    resolutionKind = "halved_from_double";
    note = `Çift tempo adayı (${rawBestBpm} BPM) algısal oktav önceliğiyle ${bestBpm} BPM ana temposuna çözümlendi.`;
  } else if (acSub23 > ac1Best * 0.95) {
    resolutionKind = "resolved_from_subharmonic";
    note = `2/3 noktalı-dörtlük alt-harmonik (${sub23Bpm} BPM, tresillo/senkop) ve yarı-tempo (${halfBpm} BPM) adayları metrik bar/sekizlik uyumuyla ${bestBpm} BPM ana temposuna çözümlendi.`;
  }

  return {
    grid_bpm: bestBpm,
    phase_ms: bestPhaseMs,
    beat_period_ms: Number(periodMs.toFixed(2)),
    grid_ms: gridMs,
    tempo_resolution: {
      raw_bpm: rawBestBpm,
      resolved_bpm: bestBpm,
      preferred_range_bpm: preferredRange,
      half_tempo_bpm: halfBpm,
      double_tempo_bpm: doubleBpm,
      subharmonic_2_3_bpm: sub23Bpm,
      confidence: Number(Math.min(1, bestWeighted / Math.max(1, bestWeighted + 10)).toFixed(3)),
      resolution: resolutionKind,
      note,
    },
  };
}
