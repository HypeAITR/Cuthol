/**
 * ITU-R BS.1770-4 / EBU R128 Loudness & True Peak Analyzer (`src/library/loudness.ts`).
 *
 * Uses FFmpeg 8.1 `ebur128=peak=true` filter to compute:
 * - Integrated Programme Loudness (`integrated_lufs`)
 * - Loudness Range (`lra_lu`)
 * - Maximum True Peak (`true_peak_dbtp`)
 * - Recommended gain adjustment to reach the target loudness (`recommended_gain_db`)
 */

import { createSubprocessFailureDiagnostic, CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import { loadSequence, updateSequenceInPlace } from "../core/workspace.js";
import { MediaLedger } from "./ledger.js";
import { resolveLibraryItemPath } from "./probe.js";

function computeSafeRecommendedGainDb(targetLufs: number, integratedLufs: number): number {
  if (!Number.isFinite(integratedLufs) || integratedLufs <= -69.5) {
    return 0.0;
  }
  const rawGain = targetLufs - integratedLufs;
  return Number(Math.max(-24.0, Math.min(24.0, rawGain)).toFixed(2));
}

export interface LoudnessMetrics {
  handle: string;
  sha256: string;
  integrated_lufs: number;
  loudness_range_lu: number;
  threshold_lufs: number;
  true_peak_dbtp: number;
  target_lufs: number;
  recommended_gain_db: number;
  exceeds_true_peak_ceiling: boolean;
}

export function analyzeAssetLoudness(options: {
  workspaceDir: string;
  handle: string;
  targetLufs?: number;
}): LoudnessMetrics {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const item = sequence.library.find((x) => x.handle === options.handle);
  if (!item) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.handle));
  }
  if (!item.probe.has_audio) {
    throw new CutholError(DIAGNOSTICS.NO_AUDIO_STREAM(options.handle));
  }

  const targetLufs = options.targetLufs ?? OPEN_STANDARDS.LOUDNESS.DEFAULT_TARGET_LUFS;
  const ledger = new MediaLedger(paths.ledgerFile);

  try {
    const cached = ledger.getLoudness<Omit<LoudnessMetrics, "handle" | "target_lufs" | "recommended_gain_db">>(
      item.digest_sha256
    );
    if (cached) {
      const recommended_gain_db = computeSafeRecommendedGainDb(targetLufs, cached.integrated_lufs);
      const metrics: LoudnessMetrics = {
        ...cached,
        handle: item.handle,
        target_lufs: targetLufs,
        recommended_gain_db,
        exceeds_true_peak_ceiling: cached.true_peak_dbtp > OPEN_STANDARDS.LOUDNESS.DEFAULT_TRUE_PEAK_DBTP,
      };
      recordLoudnessRef(options.workspaceDir, item.handle, `loud_${item.digest_sha256.slice(0, 8)}`);
      return metrics;
    }

    const absFile = resolveLibraryItemPath(paths.rootDir, item);
    const eburArgs = ["-nostats", "-i", absFile, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"];
    const proc = spawnWatchedSync("ffmpeg", eburArgs, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      step: "ffmpeg ebur128",
    });

    if (proc.status !== 0 || proc.error) {
      throw new CutholError(
        createSubprocessFailureDiagnostic({
          tool: "ffmpeg ebur128",
          executable: "ffmpeg",
          args: eburArgs,
          proc,
          fallbackDetail: (proc.stderr || "ebur128 failed").slice(-400),
        })
      );
    }

    const log = proc.stderr || "";
    const summaryIdx = log.lastIndexOf("Summary:");
    const summaryBlock = summaryIdx >= 0 ? log.slice(summaryIdx) : log;

    const iMatch = /I:\s*([+-]?\d+(?:\.\d+)?|-inf)\s*LUFS/i.exec(summaryBlock);
    const lraMatch = /LRA:\s*([+-]?\d+(?:\.\d+)?|-inf)\s*LU/i.exec(summaryBlock);
    const threshMatch = /Threshold:\s*([+-]?\d+(?:\.\d+)?|-inf)\s*LUFS/i.exec(summaryBlock);
    const peakMatch =
      /True peak:\s*(?:[\s\S]*?)Peak:\s*([+-]?\d+(?:\.\d+)?|-inf)\s*dBFS/i.exec(summaryBlock) ??
      /Peak:\s*([+-]?\d+(?:\.\d+)?|-inf)\s*dBFS/i.exec(summaryBlock);

    if (!iMatch || !peakMatch) {
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_TOOL_FAILED("ffmpeg ebur128", "could not parse the ebur128 Summary output.")
      );
    }

    const parseEbuVal = (rawVal: string | undefined, fallback: number): number => {
      if (!rawVal || rawVal.toLowerCase() === "-inf") return fallback;
      const n = Number(rawVal);
      return Number.isFinite(n) ? n : fallback;
    };

    const integrated_lufs = parseEbuVal(iMatch[1], -70.0);
    const loudness_range_lu = parseEbuVal(lraMatch?.[1], 0.0);
    const threshold_lufs = parseEbuVal(threshMatch?.[1], -70.0);
    const true_peak_dbtp = parseEbuVal(peakMatch[1], -70.0);

    const baseMetrics = {
      sha256: item.digest_sha256,
      integrated_lufs,
      loudness_range_lu,
      threshold_lufs,
      true_peak_dbtp,
      exceeds_true_peak_ceiling: true_peak_dbtp > OPEN_STANDARDS.LOUDNESS.DEFAULT_TRUE_PEAK_DBTP,
    };

    ledger.setLoudness(item.digest_sha256, baseMetrics);
    recordLoudnessRef(options.workspaceDir, item.handle, `loud_${item.digest_sha256.slice(0, 8)}`);

    return {
      ...baseMetrics,
      handle: item.handle,
      target_lufs: targetLufs,
      recommended_gain_db: computeSafeRecommendedGainDb(targetLufs, integrated_lufs),
    };
  } finally {
    ledger.close();
  }
}

function recordLoudnessRef(workspaceDir: string, handle: string, refId: string): void {
  const { sequence } = loadSequence(workspaceDir);
  const current = sequence.library.find((x) => x.handle === handle);
  if (current && current.analysis_refs.loudness !== refId) {
    updateSequenceInPlace(workspaceDir, (seq) => {
      const target = seq.library.find((x) => x.handle === handle);
      if (target) {
        target.analysis_refs.loudness = refId;
      }
    });
  }
}
