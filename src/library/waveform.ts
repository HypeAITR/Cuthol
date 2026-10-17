/**
 * Waveform Envelope, 3-Band Spectral Analyzer & PNG Visualizer (`src/library/waveform.ts`).
 *
 * Extracts mono 16 kHz PCM samples via FFmpeg, computes:
 * 1. Normalized Peak & RMS amplitude envelope across `bins` intervals (with a 1% visual floor
 *    so silent timeline regions remain distinguishable from missing media).
 * 2. Conventional 3-band spectral energy decomposition via Radix-2 Cooley-Tukey FFT:
 *    - Low (Bass / Fundamental): 20–250 Hz
 *    - Mid (Speech Formants / Presence): 250–4000 Hz
 *    - High (Sibilance / Treble): 4000–20000 Hz (up to Nyquist 8000 Hz at 16 kHz)
 * 3. Silence vs Active Audio intervals (using `OPEN_STANDARDS.DIALOGUE_CLEANUP.SILENCE_FLOOR_DBFS`).
 * 4. Optional high-contrast multi-panel PNG visualization (`--png`) for AI agent visual inspection.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSubprocessFailureDiagnostic, CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { PngCanvas } from "../core/png_canvas.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import { loadSequence, updateSequenceInPlace } from "../core/workspace.js";
import { MediaLedger } from "./ledger.js";
import { resolveLibraryItemPath } from "./probe.js";

export interface SilenceInterval {
  start_ms: number;
  end_ms: number;
  duration_ms: number;
}

export interface SpectralBandSummary {
  low_20_250hz_pct: number;
  mid_250_4000hz_pct: number;
  high_4000_8000hz_pct: number;
}

export interface WaveformBin {
  bin_index: number;
  start_ms: number;
  end_ms: number;
  peak_norm: number;
  rms_norm: number;
  db_fs: number;
  low_energy: number;
  mid_energy: number;
  high_energy: number;
}

export interface WaveformAnalysisResult {
  handle: string;
  sha256: string;
  duration_ms: number;
  sample_rate_hz: number;
  bins_count: number;
  peak_dbfs: number;
  rms_dbfs: number;
  silence_floor_dbfs?: number;
  pts_aligned?: boolean;
  spectral_summary: SpectralBandSummary;
  silence_intervals: SilenceInterval[];
  bins: WaveformBin[];
  png_path?: string;
}

export interface AcousticWindowProfile {
  sample_rate_hz: number;
  window_ms: number;
  duration_ms: number;
  silence_floor_dbfs: number;
  has_silence_variation: boolean;
  window_dbfs: Float64Array;
}

const acousticWindowCache = new Map<string, AcousticWindowProfile>();

/**
 * In-place Radix-2 Cooley-Tukey FFT.
 */
export function radix2Fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wlenR = Math.cos(angle);
    const wlenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wR = 1.0;
      let wI = 0.0;
      for (let k = 0; k < halfLen; k++) {
        const uR = real[i + k];
        const uI = imag[i + k];
        const vR = real[i + k + halfLen] * wR - imag[i + k + halfLen] * wI;
        const vI = real[i + k + halfLen] * wI + imag[i + k + halfLen] * wR;
        real[i + k] = uR + vR;
        imag[i + k] = uI + vI;
        real[i + k + halfLen] = uR - vR;
        imag[i + k + halfLen] = uI - vI;
        const nextWR = wR * wlenR - wI * wlenI;
        wI = wR * wlenI + wI * wlenR;
        wR = nextWR;
      }
    }
  }
}

export function extractMono16kPcm(absFilePath: string): Int16Array {
  const sampleRate = OPEN_STANDARDS.SPECTRAL_BANDS_HZ.ANALYSIS_SAMPLE_RATE;
  const pcmArgs = [
    "-v",
    "error",
    "-i",
    absFilePath,
    "-vn",
    "-af",
    "aresample=async=1:first_pts=0",
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-f",
    "s16le",
    "pipe:1",
  ];
  const proc = spawnWatchedSync("ffmpeg", pcmArgs, {
    maxBuffer: 128 * 1024 * 1024,
    step: "ffmpeg pcm extract",
  });

  if (proc.status !== 0 || proc.error) {
    throw new CutholError(
      createSubprocessFailureDiagnostic({
        tool: "ffmpeg pcm extract",
        executable: "ffmpeg",
        args: pcmArgs,
        proc,
        fallbackDetail: (proc.stderr?.toString("utf8") || "pcm extraction failed").slice(-400),
      })
    );
  }

  const outBuf = proc.stdout as Buffer;
  const sampleCount = Math.floor(outBuf.byteLength / 2);
  if (os.endianness() === "LE") {
    if (outBuf.byteOffset % 2 === 0) {
      return new Int16Array(outBuf.buffer, outBuf.byteOffset, sampleCount);
    }
    const aligned = new Uint8Array(sampleCount * 2);
    aligned.set(outBuf.subarray(0, sampleCount * 2));
    return new Int16Array(aligned.buffer);
  }
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = outBuf.readInt16LE(i * 2);
  }
  return samples;
}

export function analyzeAssetWaveform(options: {
  workspaceDir: string;
  handle: string;
  bins?: number;
  pngOutPath?: string;
}): WaveformAnalysisResult {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const item = sequence.library.find((x) => x.handle === options.handle);
  if (!item) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.handle));
  }
  if (!item.probe.has_audio) {
    throw new CutholError(DIAGNOSTICS.NO_AUDIO_STREAM(options.handle));
  }

  const rawBins = Number.isFinite(options.bins) ? Math.round(options.bins!) : 160;
  const binsCount = Math.max(16, Math.min(2000, rawBins));
  const ledger = new MediaLedger(paths.ledgerFile);

  try {
    let result = ledger.getWaveform<WaveformAnalysisResult>(item.digest_sha256, binsCount);
    const absFile = resolveLibraryItemPath(paths.rootDir, item);

    // Recompute if legacy cached entry lacks adaptive `silence_floor_dbfs` or PTS alignment and the media file exists
    if (
      result &&
      (result.silence_floor_dbfs === undefined || !result.pts_aligned) &&
      fs.existsSync(absFile)
    ) {
      result = null;
    }

    if (!result) {
      const samples = extractMono16kPcm(absFile);
      const sampleRate = OPEN_STANDARDS.SPECTRAL_BANDS_HZ.ANALYSIS_SAMPLE_RATE;
      const totalDurationMs =
        samples.length > 0 ? Math.round((samples.length / sampleRate) * 1000) : item.probe.duration_ms;

      const fftSize = 512;
      const real = new Float64Array(fftSize);
      const imag = new Float64Array(fftSize);
      const hannTable = new Float64Array(fftSize);
      for (let k = 0; k < fftSize; k++) {
        hannTable[k] = 0.5 * (1 - Math.cos((2 * Math.PI * k) / (fftSize - 1)));
      }

      const rawPeaks = new Float64Array(binsCount);
      const rawRms = new Float64Array(binsCount);
      const rawLow = new Float64Array(binsCount);
      const rawMid = new Float64Array(binsCount);
      const rawHigh = new Float64Array(binsCount);

      let globalMaxPeak = 0;
      let globalSumSq = 0;
      let totalLow = 0;
      let totalMid = 0;
      let totalHigh = 0;
      const binHz = sampleRate / fftSize; // 31.25 Hz per FFT bin

      for (let b = 0; b < binsCount; b++) {
        const startSample = Math.floor((b * samples.length) / binsCount);
        const endSample = Math.min(
          samples.length,
          Math.max(startSample + 1, Math.floor(((b + 1) * samples.length) / binsCount))
        );
        const count = Math.max(1, endSample - startSample);

        let maxAbs = 0;
        let sumSq = 0;
        for (let i = startSample; i < endSample; i++) {
          const v = Math.abs(samples[i]) / 32768.0;
          if (v > maxAbs) maxAbs = v;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / count);
        rawPeaks[b] = maxAbs;
        rawRms[b] = rms;
        if (maxAbs > globalMaxPeak) globalMaxPeak = maxAbs;
        globalSumSq += sumSq;

        // Multi-window STFT across the entire bin (hop = 256 samples) so no part of a long bin is skipped
        const stftHop = 256;
        const maxWinCount = Math.max(1, Math.min(16, Math.ceil(count / stftHop)));
        const winStep = count > fftSize && maxWinCount > 1 ? Math.floor((count - fftSize) / (maxWinCount - 1)) : 0;

        let binLowSum = 0;
        let binMidSum = 0;
        let binHighSum = 0;

        for (let w = 0; w < maxWinCount; w++) {
          const winStart =
            count <= fftSize
              ? Math.max(0, Math.floor((startSample + endSample - fftSize) / 2))
              : startSample + w * winStep;

          real.fill(0);
          imag.fill(0);
          for (let k = 0; k < fftSize; k++) {
            const idx = winStart + k;
            const s = idx < samples.length ? samples[idx] / 32768.0 : 0;
            real[k] = s * hannTable[k];
          }
          radix2Fft(real, imag);

          let lowE = 0;
          let midE = 0;
          let highE = 0;
          for (let k = 1; k < fftSize >> 1; k++) {
            const freq = k * binHz;
            const magSq = real[k] * real[k] + imag[k] * imag[k];
            if (freq >= 20 && freq <= 250) {
              lowE += magSq;
            } else if (freq > 250 && freq <= 4000) {
              midE += magSq;
            } else if (freq > 4000) {
              highE += magSq;
            }
          }
          binLowSum += Math.sqrt(lowE);
          binMidSum += Math.sqrt(midE);
          binHighSum += Math.sqrt(highE);
        }

        rawLow[b] = binLowSum / maxWinCount;
        rawMid[b] = binMidSum / maxWinCount;
        rawHigh[b] = binHighSum / maxWinCount;
        totalLow += rawLow[b];
        totalMid += rawMid[b];
        totalHigh += rawHigh[b];
      }

      const maxBandVal = Math.max(
        1e-9,
        ...Array.from(rawLow),
        ...Array.from(rawMid),
        ...Array.from(rawHigh)
      );
      const peakSpan = Math.max(1e-6, globalMaxPeak);

      const bins: WaveformBin[] = [];
      for (let b = 0; b < binsCount; b++) {
        const start_ms = Math.round((b / binsCount) * totalDurationMs);
        const end_ms = Math.round(((b + 1) / binsCount) * totalDurationMs);

        // Normalize with a 1% visual floor so zero-energy sections remain visible on timelines
        const peak_norm = Number(Math.min(1.0, Math.max(0.01, rawPeaks[b] / peakSpan)).toFixed(4));
        const rms_norm = Number(Math.min(1.0, Math.max(0.01, rawRms[b] / peakSpan)).toFixed(4));
        const db_fs = rawRms[b] > 1e-6 ? Number((20 * Math.log10(rawRms[b])).toFixed(2)) : -96.0;

        bins.push({
          bin_index: b,
          start_ms,
          end_ms,
          peak_norm,
          rms_norm,
          db_fs,
          low_energy: Number((rawLow[b] / maxBandVal).toFixed(4)),
          mid_energy: Number((rawMid[b] / maxBandVal).toFixed(4)),
          high_energy: Number((rawHigh[b] / maxBandVal).toFixed(4)),
        });
      }

      // Silence interval detection on fixed 25ms (400-sample) windows, independent of visual `--bins` count.
      // Uses a recording-relative silence threshold (`silenceFloorDbfs`) so quiet recordings (e.g. -29 LUFS)
      // do not misclassify spoken words as silence.
      const globalRms = samples.length > 0 ? Math.sqrt(globalSumSq / samples.length) : 0;
      const globalRmsDbfs = globalRms > 1e-6 ? 20 * Math.log10(globalRms) : -96.0;
      const minPauseMs = OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_MIN_PAUSE_MS;
      const silenceIntervals: SilenceInterval[] = [];
      const silenceWinSamples = Math.max(1, Math.round(sampleRate * 0.025)); // 25ms at 16kHz = 400 samples
      let silenceFloorDbfs: number = OPEN_STANDARDS.DIALOGUE_CLEANUP.SILENCE_FLOOR_DBFS;

      if (samples.length > 0) {
        const numSilWins = Math.ceil(samples.length / silenceWinSamples);
        const winDbs = new Float64Array(numSilWins);
        const activeWinDbs: number[] = [];

        for (let w = 0; w < numSilWins; w++) {
          const wStart = w * silenceWinSamples;
          const wEnd = Math.min(samples.length, (w + 1) * silenceWinSamples);
          const wCount = Math.max(1, wEnd - wStart);
          let wSumSq = 0;
          for (let i = wStart; i < wEnd; i++) {
            const v = samples[i] / 32768.0;
            wSumSq += v * v;
          }
          const wRms = Math.sqrt(wSumSq / wCount);
          const wDbFs = wRms > 1e-6 ? 20 * Math.log10(wRms) : -96.0;
          winDbs[w] = wDbFs;
          if (wDbFs > -70.0) {
            activeWinDbs.push(wDbFs);
          }
        }

        let p80Db = globalRmsDbfs;
        if (activeWinDbs.length > 0) {
          activeWinDbs.sort((a, b) => a - b);
          p80Db = activeWinDbs[Math.min(activeWinDbs.length - 1, Math.floor(activeWinDbs.length * 0.8))];
        }

        const cachedLoud = ledger.getLoudness<{ integrated_lufs?: number }>(item.digest_sha256);
        const hasValidLoudness =
          cachedLoud &&
          typeof cachedLoud.integrated_lufs === "number" &&
          Number.isFinite(cachedLoud.integrated_lufs) &&
          cachedLoud.integrated_lufs > -69.5;
        const refSpeechDb = hasValidLoudness
          ? Math.max(cachedLoud.integrated_lufs!, p80Db - 4.0)
          : p80Db;

        const relativeFloorDbfs =
          refSpeechDb + OPEN_STANDARDS.DIALOGUE_CLEANUP.RELATIVE_SILENCE_OFFSET_DB;
        silenceFloorDbfs = Number(
          Math.max(
            OPEN_STANDARDS.DIALOGUE_CLEANUP.MIN_SILENCE_FLOOR_DBFS,
            Math.min(OPEN_STANDARDS.DIALOGUE_CLEANUP.SILENCE_FLOOR_DBFS, relativeFloorDbfs)
          ).toFixed(2)
        );

        let activeSilenceStart: number | null = null;
        for (let w = 0; w < numSilWins; w++) {
          const wStart = w * silenceWinSamples;
          const wDbFs = winDbs[w];
          const winStartMs = Math.round((wStart * 1000) / sampleRate);

          if (wDbFs <= silenceFloorDbfs) {
            if (activeSilenceStart === null) {
              activeSilenceStart = winStartMs;
            }
          } else if (activeSilenceStart !== null) {
            const dur = winStartMs - activeSilenceStart;
            if (dur >= minPauseMs) {
              silenceIntervals.push({ start_ms: activeSilenceStart, end_ms: winStartMs, duration_ms: dur });
            }
            activeSilenceStart = null;
          }
        }
        if (activeSilenceStart !== null) {
          const dur = totalDurationMs - activeSilenceStart;
          if (dur >= minPauseMs) {
            silenceIntervals.push({ start_ms: activeSilenceStart, end_ms: totalDurationMs, duration_ms: dur });
          }
        }
      }

      const totalSpectral = Math.max(1e-9, totalLow + totalMid + totalHigh);

      result = {
        handle: item.handle,
        sha256: item.digest_sha256,
        duration_ms: totalDurationMs,
        sample_rate_hz: sampleRate,
        bins_count: binsCount,
        peak_dbfs: globalMaxPeak > 1e-6 ? Number((20 * Math.log10(globalMaxPeak)).toFixed(2)) : -96.0,
        rms_dbfs: Number(globalRmsDbfs.toFixed(2)),
        silence_floor_dbfs: silenceFloorDbfs,
        pts_aligned: true,
        spectral_summary: {
          low_20_250hz_pct: Number(((totalLow / totalSpectral) * 100).toFixed(1)),
          mid_250_4000hz_pct: Number(((totalMid / totalSpectral) * 100).toFixed(1)),
          high_4000_8000hz_pct: Number(((totalHigh / totalSpectral) * 100).toFixed(1)),
        },
        silence_intervals: silenceIntervals,
        bins,
      };

      ledger.setWaveform(item.digest_sha256, binsCount, result);
    }

    const refId = `wave_${item.digest_sha256.slice(0, 8)}`;
    const current = sequence.library.find((x) => x.handle === item.handle);
    if (current && current.analysis_refs.waveform !== refId) {
      updateSequenceInPlace(options.workspaceDir, (seq) => {
        const target = seq.library.find((x) => x.handle === item.handle);
        if (target) {
          target.analysis_refs.waveform = refId;
        }
      });
    }

    const finalResult: WaveformAnalysisResult = {
      ...result,
      handle: item.handle,
    };

    if (options.pngOutPath) {
      const resolvedPng = path.isAbsolute(options.pngOutPath)
        ? options.pngOutPath
        : path.resolve(paths.rootDir, options.pngOutPath);
      renderWaveformPng(finalResult, resolvedPng);
      finalResult.png_path = resolvedPng;
    }

    return finalResult;
  } finally {
    ledger.close();
  }
}

/**
 * Computes PTS-aligned 25ms RMS window profile (`window_dbfs`) and recording-relative
 * `silence_floor_dbfs` for acoustic edge verification in `speech.cleanup`.
 */
export function measureAssetAcousticWindows(options: {
  workspaceDir: string;
  handle: string;
}): AcousticWindowProfile | null {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const item = sequence.library.find((x) => x.handle === options.handle);
  if (!item || !item.probe.has_audio) {
    return null;
  }

  const cached = acousticWindowCache.get(item.digest_sha256);
  if (cached) {
    return cached;
  }

  const absFile = resolveLibraryItemPath(paths.rootDir, item);
  if (!fs.existsSync(absFile)) {
    return null;
  }

  const samples = extractMono16kPcm(absFile);
  if (samples.length === 0) {
    return null;
  }

  const sampleRate = OPEN_STANDARDS.SPECTRAL_BANDS_HZ.ANALYSIS_SAMPLE_RATE;
  const windowMs = 25;
  const winSamples = Math.max(1, Math.round((sampleRate * windowMs) / 1000)); // 400 samples at 16 kHz
  const numWins = Math.ceil(samples.length / winSamples);
  const winDbs = new Float64Array(numWins);
  const activeWinDbs: number[] = [];
  let globalSumSq = 0;

  for (let w = 0; w < numWins; w++) {
    const wStart = w * winSamples;
    const wEnd = Math.min(samples.length, (w + 1) * winSamples);
    const wCount = Math.max(1, wEnd - wStart);
    let wSumSq = 0;
    for (let i = wStart; i < wEnd; i++) {
      const v = samples[i] / 32768.0;
      wSumSq += v * v;
    }
    globalSumSq += wSumSq;
    const wRms = Math.sqrt(wSumSq / wCount);
    const wDbFs = wRms > 1e-6 ? 20 * Math.log10(wRms) : -96.0;
    winDbs[w] = wDbFs;
    if (wDbFs > -70.0) {
      activeWinDbs.push(wDbFs);
    }
  }

  const globalRms = Math.sqrt(globalSumSq / samples.length);
  const globalRmsDbfs = globalRms > 1e-6 ? 20 * Math.log10(globalRms) : -96.0;
  let p80Db = globalRmsDbfs;
  if (activeWinDbs.length > 0) {
    activeWinDbs.sort((a, b) => a - b);
    p80Db = activeWinDbs[Math.min(activeWinDbs.length - 1, Math.floor(activeWinDbs.length * 0.8))];
  }

  let refSpeechDb = p80Db;
  const ledger = new MediaLedger(paths.ledgerFile);
  try {
    const cachedLoud = ledger.getLoudness<{ integrated_lufs?: number }>(item.digest_sha256);
    const hasValidLoudness =
      cachedLoud &&
      typeof cachedLoud.integrated_lufs === "number" &&
      Number.isFinite(cachedLoud.integrated_lufs) &&
      cachedLoud.integrated_lufs > -69.5;
    if (hasValidLoudness) {
      refSpeechDb = Math.max(cachedLoud.integrated_lufs!, p80Db - 4.0);
    }
  } finally {
    ledger.close();
  }

  const relativeFloorDbfs =
    refSpeechDb + OPEN_STANDARDS.DIALOGUE_CLEANUP.RELATIVE_SILENCE_OFFSET_DB;
  const silenceFloorDbfs = Number(
    Math.max(
      OPEN_STANDARDS.DIALOGUE_CLEANUP.MIN_SILENCE_FLOOR_DBFS,
      Math.min(OPEN_STANDARDS.DIALOGUE_CLEANUP.SILENCE_FLOOR_DBFS, relativeFloorDbfs)
    ).toFixed(2)
  );

  let hasActiveWin = false;
  let curSilentRun = 0;
  let maxSilentRun = 0;
  for (let w = 0; w < numWins; w++) {
    if (winDbs[w] <= silenceFloorDbfs) {
      curSilentRun += 1;
      if (curSilentRun > maxSilentRun) {
        maxSilentRun = curSilentRun;
      }
    } else {
      curSilentRun = 0;
      hasActiveWin = true;
    }
  }
  const minSilenceRunWins = Math.ceil(
    OPEN_STANDARDS.DIALOGUE_CLEANUP.MIN_PAUSE_MS / windowMs
  );

  const profile: AcousticWindowProfile = {
    sample_rate_hz: sampleRate,
    window_ms: windowMs,
    duration_ms: Math.round((samples.length / sampleRate) * 1000),
    silence_floor_dbfs: silenceFloorDbfs,
    has_silence_variation: hasActiveWin && maxSilentRun >= minSilenceRunWins,
    window_dbfs: winDbs,
  };

  acousticWindowCache.set(item.digest_sha256, profile);
  return profile;
}

export function renderWaveformPng(data: WaveformAnalysisResult, outputPath: string): void {
  const width = 1200;
  const height = 520;
  const canvas = new PngCanvas(width, height, [14, 17, 23, 255]);

  // Header bar
  canvas.fillRect(0, 0, width, 46, [22, 27, 36, 255]);
  canvas.drawText(
    `CUTHOL AUDIO MONITOR | HANDLE: ${data.handle} | DUR: ${data.duration_ms}MS | PEAK: ${data.peak_dbfs}DBFS | RMS: ${data.rms_dbfs}DBFS`,
    20,
    16,
    [230, 237, 243, 255],
    2
  );

  // Panel 1: Waveform Peak/RMS Envelope + Silence Shaded Regions
  const waveLeft = 60;
  const waveRight = width - 30;
  const waveWidth = waveRight - waveLeft;
  const waveTop = 65;
  const waveHeight = 220;
  const waveMidY = waveTop + waveHeight / 2;

  canvas.fillRect(waveLeft, waveTop, waveWidth, waveHeight, [18, 22, 30, 255]);
  canvas.strokeRect(waveLeft, waveTop, waveWidth, waveHeight, 1, [48, 54, 65, 255]);

  // Highlight detected silence regions in Panel 1
  for (const sil of data.silence_intervals) {
    if (data.duration_ms <= 0) continue;
    const sx = waveLeft + (sil.start_ms / data.duration_ms) * waveWidth;
    const sw = Math.max(2, (sil.duration_ms / data.duration_ms) * waveWidth);
    canvas.fillRect(sx, waveTop + 1, sw, waveHeight - 2, [180, 50, 60, 55]);
  }

  // Center line (0 amplitude)
  canvas.drawLine(waveLeft, waveMidY, waveRight, waveMidY, [60, 70, 85, 255]);
  canvas.drawText("PEAK/RMS", 6, waveTop + 8, [130, 145, 165, 255], 1);
  canvas.drawText("0.0", 24, waveMidY - 4, [130, 145, 165, 255], 1);

  const binCount = data.bins.length;
  const barStep = waveWidth / Math.max(1, binCount);
  const barWidth = Math.max(2, Math.floor(barStep - 1));

  for (let i = 0; i < binCount; i++) {
    const bin = data.bins[i];
    const x = waveLeft + i * barStep;
    const peakHalfH = Math.max(2, bin.peak_norm * (waveHeight * 0.46));
    const rmsHalfH = Math.max(1, bin.rms_norm * (waveHeight * 0.46));

    // Outer Peak bar (cyan/blue)
    canvas.fillRect(x, waveMidY - peakHalfH, barWidth, peakHalfH * 2, [45, 145, 215, 220]);
    // Inner RMS core (bright emerald)
    canvas.fillRect(x, waveMidY - rmsHalfH, barWidth, rmsHalfH * 2, [80, 225, 155, 255]);
  }

  // Panel 2: 3-Band Spectral Energy (Low 20-250Hz, Mid 250-4000Hz, High 4000-8000Hz)
  const specTop = 310;
  const specHeight = 150;
  canvas.fillRect(waveLeft, specTop, waveWidth, specHeight, [18, 22, 30, 255]);
  canvas.strokeRect(waveLeft, specTop, waveWidth, specHeight, 1, [48, 54, 65, 255]);

  canvas.drawText(
    `3-BAND SPECTRUM | LOW(20-250HZ): ${data.spectral_summary.low_20_250hz_pct}% | MID(250-4KHZ): ${data.spectral_summary.mid_250_4000hz_pct}% | HIGH(4K-8KHZ): ${data.spectral_summary.high_4000_8000hz_pct}%`,
    waveLeft + 10,
    specTop + 8,
    [200, 210, 225, 255],
    1
  );

  const plotBottom = specTop + specHeight - 6;
  const maxBarH = specHeight - 28;

  for (let i = 0; i < binCount; i++) {
    const bin = data.bins[i];
    const x = waveLeft + i * barStep;
    const lowH = Math.round(bin.low_energy * maxBarH * 0.45);
    const midH = Math.round(bin.mid_energy * maxBarH * 0.45);
    const highH = Math.round(bin.high_energy * maxBarH * 0.45);

    // Stacked 3-band bar: Low (amber), Mid (green), High (magenta)
    if (lowH > 0) {
      canvas.fillRect(x, plotBottom - lowH, barWidth, lowH, [240, 155, 55, 230]);
    }
    if (midH > 0) {
      canvas.fillRect(x, plotBottom - lowH - midH, barWidth, midH, [70, 205, 120, 230]);
    }
    if (highH > 0) {
      canvas.fillRect(x, plotBottom - lowH - midH - highH, barWidth, highH, [195, 95, 245, 230]);
    }
  }

  // Time Ruler at bottom
  const rulerY = 475;
  const ticks = 8;
  for (let t = 0; t <= ticks; t++) {
    const tx = waveLeft + (t / ticks) * waveWidth;
    const ms = Math.round((t / ticks) * data.duration_ms);
    canvas.drawLine(tx, rulerY - 8, tx, rulerY, [120, 130, 145, 255]);
    canvas.drawText(`${(ms / 1000).toFixed(1)}S`, Math.max(10, tx - 16), rulerY + 6, [175, 185, 200, 255], 2);
  }

  canvas.saveAs(outputPath);
}
