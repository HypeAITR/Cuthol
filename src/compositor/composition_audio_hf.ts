// HyperFrames composition-audio adapter: the engine's own mix as a Cuthol stem.
//
// HyperFrames 0.9.15 renders composition sound only inside video containers
// (mp4/mov); there is no audio-only render path. This adapter therefore takes
// the engine-produced mix through the public `hyperframes render` CLI:
// when the cue's cached overlay blob is an mp4/mov it extracts the stem from
// that blob (no extra render); otherwise it runs one draft-quality mp4 render
// of the same composition files/props and extracts the audio track. Draft and
// full-quality renders carry byte-identical audio, so the stem always matches
// a standalone engine render sample-for-sample.
import fs from "node:fs";
import path from "node:path";
import { resolveHyperFramesWorkers } from "../core/env.js";
import { progressWatch } from "../core/progress.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import { extractScalarHyperFramesVariables } from "./bridge_exporter.js";
import {
  CompositionAudioAdapter,
  CompositionAudioRequest,
  stemCacheFileDigest,
} from "./composition_audio.js";
import { isValidVideoBlobOnDisk } from "./hf_blobs.js";
import {
  readCompositionCacheState,
  syncScalarVarsAndComputeCompositionHash,
} from "./hf_cache_state.js";
import {
  findLocalHyperFramesCliMjs,
  hyperFramesProcessEnv,
  readInvokedHyperFramesVersion,
  renameWithRetrySync,
} from "./hf_common.js";
import { buildHyperFramesFailureError } from "./hf_overlay_tracking.js";
import {
  compositionVideoFileHasAudio,
  detectCompositionAudioNotInMix,
} from "../verify/gates_hf_audio.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";

/** Peak floor (dBFS): stems quieter than this count as rendered silence. */
const STEM_SILENCE_PEAK_DBFS = -90;

/** Extraction-path counters (observability for tests and reports). */
const hfStemStats = { blobReuse: 0, dedicatedRenders: 0 };

export function readCompositionAudioHfStats(): { blobReuse: number; dedicatedRenders: number } {
  return { ...hfStemStats };
}

export function resetCompositionAudioHfStats(): void {
  hfStemStats.blobReuse = 0;
  hfStemStats.dedicatedRenders = 0;
}

function computeAudioHashParts(request: CompositionAudioRequest): {
  filesHash: string;
  usedSliceHash: string;
  usedGlobalHash: string;
  propsHash: string;
  scalarVars: Record<string, string | number | boolean>;
} {
  const entryPath = path.join(request.compositionDir, request.entryHtml);
  let htmlSource = "";
  try {
    htmlSource = fs.readFileSync(entryPath, "utf8");
  } catch {
    htmlSource = "";
  }
  // Video-only inputs (size, backdrop, staging) are intentionally neutral: the
  // audio key follows files, used bridge data, props and the renderer version,
  // so a video-only change never regenerates the stem.
  const hashInfo = syncScalarVarsAndComputeCompositionHash({
    absCompDir: path.resolve(request.compositionDir),
    entryHtml: request.entryHtml,
    htmlSource,
    width: 16,
    height: 16,
    fps: request.fps,
    durationMs: request.cueDurationMs,
    props: request.props,
    transparent: true,
    mode: "overlay_alpha",
  });
  return {
    filesHash: hashInfo.filesHash,
    usedSliceHash: hashInfo.usedSliceHash,
    usedGlobalHash: hashInfo.usedGlobalHash,
    propsHash: hashInfo.propsHash,
    scalarVars: hashInfo.scalarVars,
  };
}

function probeAudioDurationMs(mediaPath: string): number | null {
  try {
    const proc = spawnWatchedSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=duration",
        "-of",
        "csv=p=0",
        mediaPath,
      ],
      { encoding: "utf8", step: "ffprobe stem duration" }
    );
    if (proc.status !== 0) return null;
    const seconds = Number(String(proc.stdout || "").trim());
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.max(1, Math.round(seconds * 1000));
  } catch {
    return null;
  }
}

function probeAudioPeakDbfs(mediaPath: string): number | null {
  try {
    const proc = spawnWatchedSync(
      "ffmpeg",
      ["-v", "info", "-i", mediaPath, "-af", "volumedetect", "-f", "null", "-"],
      { encoding: "utf8", step: "ffmpeg stem silence check" }
    );
    if (proc.status !== 0) return null;
    const text = `${proc.stdout || ""}\n${proc.stderr || ""}`;
    const m = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(text);
    if (!m) return null;
    const peak = Number(m[1]);
    return Number.isFinite(peak) ? peak : null;
  } catch {
    return null;
  }
}

/** Extracts the first audio stream to 48 kHz stereo PCM. Returns null when there is none. */
function extractWavFromContainer(
  containerPath: string,
  outputWavPath: string,
  audioProbeCache: Map<string, boolean>
): { durationMs: number } | null {
  if (!compositionVideoFileHasAudio(containerPath, audioProbeCache)) return null;
  fs.mkdirSync(path.dirname(outputWavPath), { recursive: true });
  const tmpWav = `${outputWavPath}.${process.pid}.tmp.wav`;
  try {
    const proc = spawnWatchedSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-i",
        containerPath,
        "-vn",
        "-c:a",
        "pcm_s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        tmpWav,
      ],
      { encoding: "utf8", step: "ffmpeg extract composition stem" }
    );
    if (proc.status !== 0 || !fs.existsSync(tmpWav)) {
      throw new Error(
        `stem audio extraction failed: ${String(proc.stderr || "").trim().slice(-300) || "ffmpeg error"}`
      );
    }
    const durationMs = probeAudioDurationMs(tmpWav);
    if (durationMs === null) {
      throw new Error("stem audio extraction failed: unmeasurable output duration");
    }
    const peak = probeAudioPeakDbfs(tmpWav);
    // Silence needs positive proof: an unmeasurable peak keeps the stem, so a
    // broken measurement can never drop real audio from the mix.
    if (peak !== null && peak < STEM_SILENCE_PEAK_DBFS) {
      return null;
    }
    renameWithRetrySync(tmpWav, outputWavPath);
    return { durationMs };
  } finally {
    try {
      if (fs.existsSync(tmpWav)) fs.rmSync(tmpWav, { force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Finds the cue's current overlay blob when it is an mp4/mov container: the
 * state record must match every audio-key input (files, used data, props,
 * renderer, cue duration) so a stale blob can never supply the stem.
 */
function findCurrentContainerBlob(
  request: CompositionAudioRequest,
  parts: { filesHash: string; usedSliceHash: string; usedGlobalHash: string; propsHash: string }
): string | null {
  const absCompDir = path.resolve(request.compositionDir);
  const state = readCompositionCacheState(request.blobsDir, absCompDir);
  if (!state) return null;
  if (
    state.filesHash !== parts.filesHash ||
    state.usedSliceHash !== parts.usedSliceHash ||
    state.usedGlobalHash !== parts.usedGlobalHash ||
    state.propsHash !== parts.propsHash ||
    state.durationMs !== request.cueDurationMs
  ) {
    return null;
  }
  const seen = new Set<string>();
  for (const blobPath of Object.values(state.cachedBlobs ?? {})) {
    if (typeof blobPath !== "string" || seen.has(blobPath)) continue;
    seen.add(blobPath);
    const lower = blobPath.toLowerCase();
    if (lower.endsWith(".ffv1.mov") || lower.endsWith(".pngseq")) continue;
    if (!lower.endsWith(".mp4") && !lower.endsWith(".mov")) continue;
    if (isValidVideoBlobOnDisk(blobPath)) return blobPath;
  }
  return null;
}

function runAudioOnlyRender(request: CompositionAudioRequest, tmpMp4: string): void {
  const absCompDir = path.resolve(request.compositionDir);
  const hfBin = findLocalHyperFramesCliMjs();
  if (!fs.existsSync(hfBin)) {
    throw new CutholError(
      DIAGNOSTICS.HYPERFRAMES_RENDER_FAILED(
        request.compositionDir,
        "hyperframes CLI not found (must be installed with npm install)"
      )
    );
  }
  const scalarVars = extractScalarHyperFramesVariables(request.props ?? {});
  const args = [
    hfBin,
    "render",
    absCompDir,
    "--format",
    "mp4",
    "--quality",
    "draft",
    "--workers",
    String(resolveHyperFramesWorkers()),
    "--output",
    tmpMp4,
  ];
  const varsFile = path.join(absCompDir, "assets/cuthol-vars.json");
  if (Object.keys(scalarVars).length > 0 && fs.existsSync(varsFile)) {
    args.push("--variables-file", varsFile);
  }
  fs.mkdirSync(path.dirname(tmpMp4), { recursive: true });
  progressWatch({ mode: "watch", paths: [tmpMp4], expectedFrames: [0] });
  const hfProc = spawnWatchedSync(process.execPath, args, {
    encoding: "utf8",
    env: hyperFramesProcessEnv(),
    maxBuffer: 512 * 1024 * 1024,
    step: "hyperframes render (composition audio)",
    watchedPaths: [tmpMp4],
    cleanupPathsOnStall: [tmpMp4],
  });
  if (hfProc.status !== 0 || !isValidVideoBlobOnDisk(tmpMp4)) {
    throw buildHyperFramesFailureError(request.compositionDir, args, hfProc);
  }
}

export const hyperFramesCompositionAudioAdapter: CompositionAudioAdapter = {
  engine: "hyperframes",

  readEngineVersion(): string {
    return readInvokedHyperFramesVersion();
  },

  cacheKeyFor(request: CompositionAudioRequest): string {
    const parts = computeAudioHashParts(request);
    return stemCacheFileDigest(
      `entry:${request.entryHtml}\nfiles:${parts.filesHash}\nslice:${parts.usedSliceHash}\nglobal:${parts.usedGlobalHash}\nprops:${parts.propsHash}\n`
    );
  },

  hasAudio(request: CompositionAudioRequest): boolean {
    return (
      detectCompositionAudioNotInMix(request.compositionDir, request.entryHtml).length > 0
    );
  },

  extractStem(request: CompositionAudioRequest, outputWavPath: string): { durationMs: number } | null {
    const absCompDir = path.resolve(request.compositionDir);
    const entryPath = path.join(absCompDir, request.entryHtml);
    if (!fs.existsSync(entryPath)) {
      throw new CutholError(DIAGNOSTICS.MISSING_FILE_ON_DISK("composition", entryPath));
    }
    const audioProbeCache = new Map<string, boolean>();
    const parts = computeAudioHashParts(request);

    // Fast path: the cue's own overlay blob already carries the engine mix.
    const containerBlob = findCurrentContainerBlob(request, parts);
    if (containerBlob) {
      const fromBlob = extractWavFromContainer(containerBlob, outputWavPath, audioProbeCache);
      if (fromBlob) {
        hfStemStats.blobReuse += 1;
        return fromBlob;
      }
      // The current blob rendered silence: fall through to a dedicated render
      // would only repeat the same silent mix, so report silence directly.
      return null;
    }

    // Png-sequence / packed-alpha overlays carry no audio: render the same
    // composition files and props to a throwaway mp4 and take its audio track.
    const uniqueSuffix = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const tmpWorkDir = path.join(request.blobsDir, `compaudio_tmp_${uniqueSuffix}`);
    const tmpMp4 = path.join(tmpWorkDir, "audio.mp4");
    try {
      hfStemStats.dedicatedRenders += 1;
      runAudioOnlyRender(request, tmpMp4);
      return extractWavFromContainer(tmpMp4, outputWavPath, audioProbeCache);
    } finally {
      try {
        fs.rmSync(tmpWorkDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
};
