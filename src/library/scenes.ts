/**
 * Shot / Scene Boundary Detector (`src/library/scenes.ts`).
 *
 * Uses FFmpeg 8.1 `scdet` filter (`lavfi.scd.time`, `lavfi.scd.score`) to identify
 * visual cut boundaries in footage assets.
 * Source: FFmpeg 8.1 official `scdet` documentation (default threshold = 10.0 on [0..100] MAFD scale).
 */

import { createSubprocessFailureDiagnostic, CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import { loadSequence, updateSequenceInPlace } from "../core/workspace.js";
import { MediaLedger } from "./ledger.js";
import { resolveLibraryItemPath } from "./probe.js";

export interface SceneCutPoint {
  time_ms: number;
  score: number;
}

export interface SceneAnalysisResult {
  handle: string;
  sha256: string;
  duration_ms: number;
  threshold: number;
  cuts_count: number;
  cuts: SceneCutPoint[];
  segments_ms: Array<{ index: number; start_ms: number; end_ms: number; duration_ms: number }>;
}

export function analyzeAssetScenes(options: {
  workspaceDir: string;
  handle: string;
  threshold?: number;
}): SceneAnalysisResult {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const item = sequence.library.find((x) => x.handle === options.handle);
  if (!item) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.handle));
  }
  if (!item.probe.has_video) {
    throw new CutholError(
      DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
        "ffmpeg scdet",
        `Source '${options.handle}' has no video stream.`
      )
    );
  }

  const rawThresh = Number.isFinite(options.threshold)
    ? options.threshold!
    : OPEN_STANDARDS.SCENE_DETECTION.DEFAULT_SCDET_THRESHOLD;
  const threshold = Math.max(
    OPEN_STANDARDS.SCENE_DETECTION.MIN_SCDET_THRESHOLD,
    Math.min(OPEN_STANDARDS.SCENE_DETECTION.MAX_SCDET_THRESHOLD, rawThresh)
  );

  const ledger = new MediaLedger(paths.ledgerFile);

  try {
    let cached = ledger.getScenes<SceneAnalysisResult>(item.digest_sha256, threshold);

    if (!cached) {
      const absFile = resolveLibraryItemPath(paths.rootDir, item);
      const scdetArgs = ["-nostats", "-i", absFile, "-vf", `scdet=threshold=${threshold}`, "-an", "-f", "null", "-"];
      const proc = spawnWatchedSync("ffmpeg", scdetArgs, {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        step: "ffmpeg scdet",
      });

      if (proc.status !== 0 || proc.error) {
        throw new CutholError(
          createSubprocessFailureDiagnostic({
            tool: "ffmpeg scdet",
            executable: "ffmpeg",
            args: scdetArgs,
            proc,
            fallbackDetail: (proc.stderr || "scdet failed").slice(-400),
          })
        );
      }

      const cuts: SceneCutPoint[] = [];
      const regex = /lavfi\.scd\.score:\s*([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?),\s*lavfi\.scd\.time:\s*([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi;
      let match: RegExpExecArray | null;
      const log = proc.stderr || "";
      const maxCutTimeMs = item.probe.duration_ms > 100 ? item.probe.duration_ms - 50 : Infinity;
      while ((match = regex.exec(log)) !== null) {
        const score = Number(match[1]);
        const timeSec = Number(match[2]);
        if (!Number.isFinite(score) || !Number.isFinite(timeSec)) continue;
        const time_ms = Math.round(timeSec * 1000);
        if (
          time_ms > 50 &&
          time_ms < maxCutTimeMs &&
          (cuts.length === 0 || time_ms - cuts[cuts.length - 1].time_ms >= 150)
        ) {
          cuts.push({ time_ms, score });
        }
      }

      const effectiveDurationMs = Math.max(
        item.probe.duration_ms,
        cuts.length > 0 ? cuts[cuts.length - 1].time_ms : 0
      );
      const boundaries = [0, ...cuts.map((c) => c.time_ms), effectiveDurationMs];
      const segments_ms: Array<{ index: number; start_ms: number; end_ms: number; duration_ms: number }> = [];
      for (let i = 0; i < boundaries.length - 1; i++) {
        const start_ms = boundaries[i];
        const end_ms = boundaries[i + 1];
        if (end_ms > start_ms) {
          segments_ms.push({
            index: segments_ms.length,
            start_ms,
            end_ms,
            duration_ms: end_ms - start_ms,
          });
        }
      }

      cached = {
        handle: item.handle,
        sha256: item.digest_sha256,
        duration_ms: item.probe.duration_ms,
        threshold,
        cuts_count: cuts.length,
        cuts,
        segments_ms,
      };
      ledger.setScenes(item.digest_sha256, threshold, cached);
    }

    const refId = `scn_${item.digest_sha256.slice(0, 8)}`;
    const current = sequence.library.find((x) => x.handle === item.handle);
    if (current && current.analysis_refs.scenes !== refId) {
      updateSequenceInPlace(options.workspaceDir, (seq) => {
        const target = seq.library.find((x) => x.handle === item.handle);
        if (target) {
          target.analysis_refs.scenes = refId;
        }
      });
    }

    return {
      ...cached,
      handle: item.handle,
    };
  } finally {
    ledger.close();
  }
}
