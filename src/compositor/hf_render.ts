// Renders one HyperFrames composition into a cached overlay blob (split out of hyperframes_bridge.ts).
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  type AlphaOverlayFormat,
  resolveAlphaOverlayFormat,
  resolveHyperFramesWorkers
} from "../core/env.js";
import { progressWatch } from "../core/progress.js";
import {
  spawnWatchedSync
} from "../core/subprocess.js";
import { OverlayBlobExt, resolveCachedCompositionVideoBlob, inspectPngSequenceDir, isValidVideoBlobOnDisk, stageCompositionRenderDir } from "./hf_blobs.js";
import { syncScalarVarsAndComputeCompositionHash, readCompositionCacheState, writeCompositionCacheState, clearBridgeMetaLastDataChangeReason } from "./hf_cache_state.js";
import { findLocalHyperFramesCliMjs, hyperFramesProcessEnv, renameWithRetrySync } from "./hf_common.js";
import { recordCompositionAlphaBboxSidecar } from "./hf_frames.js";
import { overlayCollector, readBlobMetaSummary, recordOverlayRenderOutcome, parseHyperFramesPipelineSummary, parseHyperFramesScriptErrorIsolated, buildHyperFramesFailureError } from "./hf_overlay_tracking.js";

export type DraftOverlayRes = "draft" | "native";

let captureDraftOverlaysAtNative = false;

/** Draft renders capture at the draft frame size unless this is set for the current render. */
export function setDraftNativeOverlayCapture(enabled: boolean): void {
  captureDraftOverlaysAtNative = enabled;
}

export function isDraftNativeOverlayCapture(): boolean {
  return captureDraftOverlaysAtNative;
}

/** The explicit flag wins over `CUTHOL_DRAFT_OVERLAY_RES`. Missing or `draft` keeps the smaller capture. */
export function resolveDraftOverlayRes(explicit?: string | null): DraftOverlayRes {
  const flag = typeof explicit === "string" ? explicit.trim().toLowerCase() : "";
  const raw = flag || (process.env.CUTHOL_DRAFT_OVERLAY_RES ?? "").trim().toLowerCase();
  if (!raw || raw === "draft") return "draft";
  if (raw === "native") return "native";
  throw new CutholError(
    DIAGNOSTICS.UNKNOWN_FLAG(
      `--overlay-res ${raw}`,
      "render",
      "cuthol render --overlay-res draft|native"
    )
  );
}

/**
 * Renders a HyperFrames composition into a cached overlay blob in `blobsDir`:
 * - Mode A (`overlay_alpha`, `transparent: true`):
 *   - Default (`pngseq`): Lossless RGBA PNG directory `hf_comp_<hash>.pngseq` (`frame_%06d.png`) via
 *     `hyperframes render --format png-sequence` (zero intermediate video encode step).
 *   - Long-overlay / single-file option (`ffv1`): Lossless RGBA FFV1 `.ffv1.mov` with exact `1/fps`
 *     frame timing (`CUTHOL_ALPHA_FORMAT=ffv1` or `>= CUTHOL_ALPHA_FFV1_MIN_FRAMES`).
 *   - Legacy option (`mov`): ProRes 4444 `.mov` (`CUTHOL_ALPHA_FORMAT=mov`).
 * - Mode B (`scene_host`): Mounts `backdropVideoPath` as `<video class="clip">` inside the composition and renders `.mp4` (`--video-frame-format png`).
 * - Opaque standalone (`transparent: false`): H.264 `.mp4` (with optional stage backdrop colour/still image baked in when no moving footage sits underneath).
 */
export function renderHyperFramesCompositionToMp4(options: {
  compositionDir: string;
  entryHtml: string;
  blobsDir: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  props: Record<string, unknown>;
  transparent: boolean;
  mode?: "overlay_alpha" | "scene_host";
  backdropVideoPath?: string;
  opaqueBackdropColor?: string;
  backdropImagePath?: string;
  workers?: number;
  useGpu?: boolean;
  crf?: number;
}): string {
  const tStart = Date.now();
  const absCompDir = path.resolve(options.compositionDir);
  const compName = path.basename(absCompDir) || "main";
  const entryPath = path.join(absCompDir, options.entryHtml);
  if (!fs.existsSync(entryPath)) {
    throw new CutholError(DIAGNOSTICS.MISSING_FILE_ON_DISK("composition", entryPath));
  }

  const mode = options.mode ?? "overlay_alpha";
  const isSceneHostCandidate =
    mode === "scene_host" && Boolean(options.backdropVideoPath && fs.existsSync(options.backdropVideoPath));
  const useTrueAlpha = options.transparent && !isSceneHostCandidate;
  const durationSec = Math.max(0.1, Number((options.durationMs / 1000).toFixed(3)));
  const expectedFrames = Math.max(1, Math.round(durationSec * options.fps));
  const alphaFormat: AlphaOverlayFormat = useTrueAlpha
    ? resolveAlphaOverlayFormat(expectedFrames)
    : "mov";

  let htmlSource = fs.readFileSync(entryPath, "utf8");
  // Upgrade any legacy #00FF00 background on body/#root to true CSS `transparent` when rendering with alpha or stage backdrop
  if (
    (useTrueAlpha || options.opaqueBackdropColor || options.backdropImagePath) &&
    /(?:body|#root)\s*\{[^}]*?background\s*:\s*#00ff00\b/i.test(htmlSource)
  ) {
    htmlSource = htmlSource.replace(
      /((?:body|#root)\s*\{[^}]*?)background\s*:\s*#00ff00\b/gi,
      "$1background: transparent"
    );
    fs.writeFileSync(entryPath, htmlSource, "utf8");
  }

  const hashOptions = {
    absCompDir,
    entryHtml: options.entryHtml,
    htmlSource,
    width: options.width,
    height: options.height,
    fps: options.fps,
    durationMs: options.durationMs,
    props: options.props,
    transparent: options.transparent,
    mode,
    backdropVideoPath: options.backdropVideoPath,
    opaqueBackdropColor: options.opaqueBackdropColor,
    backdropImagePath: options.backdropImagePath,
  };
  let hashInfo = syncScalarVarsAndComputeCompositionHash(hashOptions);
  // Capture at the composition's own size so the cache key, quality and CRF match a master render.
  // The draft picture still scales that blob to the draft frame.
  if (
    captureDraftOverlaysAtNative &&
    (hashInfo.targetWidth !== hashInfo.nativeWidth || hashInfo.targetHeight !== hashInfo.nativeHeight)
  ) {
    hashInfo = syncScalarVarsAndComputeCompositionHash({
      ...hashOptions,
      width: hashInfo.nativeWidth,
      height: hashInfo.nativeHeight,
    });
  }
  const { hash, scalarVars, isSceneHost, nativeWidth, nativeHeight, targetWidth, targetHeight } = hashInfo;

  fs.mkdirSync(options.blobsDir, { recursive: true });
  const ext: OverlayBlobExt = !useTrueAlpha
    ? "mp4"
    : alphaFormat === "pngseq"
      ? "pngseq"
      : alphaFormat === "ffv1"
        ? "ffv1.mov"
        : "mov";
  const outBlob = path.join(options.blobsDir, `hf_comp_${hash}.${ext}`);

  const persistStateForBlob = (resolvedBlob: string, isExactRes: boolean, matchedBackdrop?: string): void => {
    const prev = readCompositionCacheState(options.blobsDir, absCompDir);
    const cachedBlobs: Record<string, string> = { ...(prev?.cachedBlobs ?? {}) };
    const resKey = isExactRes
      ? `${targetWidth}x${targetHeight}:${ext}`
      : `${nativeWidth}x${nativeHeight}:${ext}`;
    cachedBlobs[resKey] = resolvedBlob;
    cachedBlobs[`${resKey}:${hashInfo.backdropDigest}`] = resolvedBlob;
    writeCompositionCacheState(options.blobsDir, absCompDir, {
      compositionDir: absCompDir,
      filesHash: hashInfo.filesHash,
      usedSliceHash: hashInfo.usedSliceHash,
      usedGlobalHash: hashInfo.usedGlobalHash,
      propsHash: hashInfo.propsHash,
      durationMs: options.durationMs,
      transparent: options.transparent,
      mode,
      backdropDigest: hashInfo.backdropDigest,
      backdropImagePath: matchedBackdrop ?? options.backdropImagePath,
      cachedBlobs,
    });
    clearBridgeMetaLastDataChangeReason(absCompDir);
  };

  const cacheLookup = resolveCachedCompositionVideoBlob({
    absCompDir,
    entryPath,
    blobsDir: options.blobsDir,
    ext,
    expectedFrames: useTrueAlpha && ext === "pngseq" ? expectedFrames : undefined,
    durationMs: options.durationMs,
    transparent: options.transparent,
    mode,
    backdropImagePath: options.backdropImagePath,
    hashInfo,
  });

  if (cacheLookup.cachedBlobPath) {
    if (overlayCollector) {
      return cacheLookup.cachedBlobPath;
    }
    persistStateForBlob(
      cacheLookup.cachedBlobPath,
      cacheLookup.isExactTargetRes,
      cacheLookup.matchedBackdropImagePath
    );
    const cachedMeta = readBlobMetaSummary(cacheLookup.cachedBlobPath);
    recordOverlayRenderOutcome({
      composition: compName,
      composition_dir: absCompDir,
      blob_path: cacheLookup.cachedBlobPath,
      cached: true,
      reason: "cached",
      elapsed_ms: Date.now() - tStart,
      ...cachedMeta,
    });
    return cacheLookup.cachedBlobPath;
  }

  const hfBin = findLocalHyperFramesCliMjs();
  if (!fs.existsSync(hfBin)) {
    throw new CutholError(
      DIAGNOSTICS.HYPERFRAMES_RENDER_FAILED(
        options.compositionDir,
        "hyperframes CLI bulunamadı (npm install ile kurulmalı)"
      )
    );
  }

  const usesPngSequenceCapture = useTrueAlpha && (alphaFormat === "pngseq" || alphaFormat === "ffv1");
  const uniqueSuffix = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tmpWorkDir = usesPngSequenceCapture
    ? path.join(options.blobsDir, `hf_tmp_${hash}_${uniqueSuffix}`)
    : null;
  if (tmpWorkDir) {
    fs.mkdirSync(tmpWorkDir, { recursive: true });
  }
  const tmpBlob = tmpWorkDir
    ? path.join(tmpWorkDir, "frames")
    : path.join(options.blobsDir, `hf_comp_${hash}.${uniqueSuffix}.tmp.${ext}`);
  const watchTargetPath = tmpWorkDir ?? tmpBlob;
  const workers = resolveHyperFramesWorkers(options.workers);

  const needsStage =
    (isSceneHost && Boolean(options.backdropVideoPath)) ||
    (!useTrueAlpha && Boolean(options.opaqueBackdropColor || options.backdropImagePath)) ||
    targetWidth !== nativeWidth ||
    targetHeight !== nativeHeight;

  let targetRenderDir = absCompDir;
  let tempSceneHostDir: string | null = null;
  let deferredToCollector = false;

  const finalizeRenderedBlob = (params: {
    usedGpu: boolean;
    gpuFallbackReason: string | null;
    elapsedMs: number;
    stdoutStr: string;
    stderrStr: string;
  }): void => {
    let frameCountMeta: number | undefined;
    let totalBytesMeta: number | undefined;

    if (usesPngSequenceCapture) {
      const pngInfo = inspectPngSequenceDir(tmpBlob);
      frameCountMeta = pngInfo.frameCount;
      totalBytesMeta = pngInfo.totalBytes;

      if (alphaFormat === "ffv1") {
        const tmpFfv1 = path.join(tmpWorkDir!, "alpha.ffv1.mov");
        const packProc = spawnWatchedSync(
          "ffmpeg",
          [
            "-y",
            "-v",
            "error",
            "-framerate",
            String(options.fps),
            "-start_number",
            "1",
            "-i",
            path.join(tmpBlob, "frame_%06d.png"),
            "-c:v",
            "ffv1",
            "-level",
            "3",
            "-coder",
            "1",
            "-context",
            "1",
            "-g",
            "1",
            "-pix_fmt",
            "rgba",
            "-r",
            String(options.fps),
            "-video_track_timescale",
            String(Math.round(options.fps * 1000)),
            tmpFfv1,
          ],
          {
            encoding: "utf8",
            step: `ffmpeg pack ffv1 (${compName})`,
            watchedPaths: [tmpFfv1],
            cleanupPathsOnStall: [tmpFfv1],
          }
        );
        if (packProc.status !== 0 || !isValidVideoBlobOnDisk(tmpFfv1)) {
          throw new CutholError(
            DIAGNOSTICS.HYPERFRAMES_RENDER_FAILED(
              options.compositionDir,
              `FFV1 alpha paketleme başarısız oldu: ${(packProc.stderr || "").trim().slice(-200)}`
            )
          );
        }
        if (fs.existsSync(outBlob)) {
          fs.rmSync(outBlob, { recursive: true, force: true });
        }
        renameWithRetrySync(tmpFfv1, outBlob);
        totalBytesMeta = fs.statSync(outBlob).size;
      } else {
        renameWithRetrySync(tmpBlob, outBlob);
      }
    } else {
      renameWithRetrySync(tmpBlob, outBlob);
      try {
        totalBytesMeta = fs.statSync(outBlob).size;
      } catch {
        // ignore
      }
    }

    const hfSummaryInfo = parseHyperFramesPipelineSummary(params.stdoutStr, params.stderrStr);
    const scriptErrors = parseHyperFramesScriptErrorIsolated(params.stdoutStr, params.stderrStr);
    const metaEncoder = !useTrueAlpha
      ? params.usedGpu
        ? "h264_nvenc"
        : "libx264"
      : alphaFormat === "pngseq"
        ? "png-sequence"
        : alphaFormat === "ffv1"
          ? "ffv1"
          : "prores_ks";

    try {
      fs.writeFileSync(
        `${outBlob}.meta.json`,
        JSON.stringify(
          {
            encoder: metaEncoder,
            format: ext,
            ...(frameCountMeta !== undefined ? { frame_count: frameCountMeta } : {}),
            ...(totalBytesMeta !== undefined ? { size_bytes: totalBytesMeta } : {}),
            gpu_fallback_reason: params.gpuFallbackReason,
            workers,
            width: targetWidth,
            height: targetHeight,
            hf_summary: hfSummaryInfo.hf_summary,
            capture_mode: hfSummaryInfo.capture_mode,
            gpu_mode: hfSummaryInfo.gpu_mode,
            streaming_encode: hfSummaryInfo.streaming_encode,
            stages_sec: hfSummaryInfo.stages_sec,
            ...(scriptErrors.length > 0 ? { script_errors: scriptErrors } : {}),
          },
          null,
          2
        ),
        "utf8"
      );
    } catch {
      // non-blocking metadata write
    }
    persistStateForBlob(outBlob, true, options.backdropImagePath);
    recordOverlayRenderOutcome({
      composition: compName,
      composition_dir: absCompDir,
      blob_path: outBlob,
      cached: false,
      reason: cacheLookup.missReason,
      elapsed_ms: params.elapsedMs,
      ...hfSummaryInfo,
      ...(scriptErrors.length > 0 ? { script_errors: scriptErrors } : {}),
    });
    if (useTrueAlpha) {
      recordCompositionAlphaBboxSidecar(absCompDir, outBlob, durationSec * 0.5);
    }
  };

  try {
    if (overlayCollector && overlayCollector.some((j) => j.outBlob === outBlob)) {
      return outBlob;
    }

    if (needsStage) {
      tempSceneHostDir = stageCompositionRenderDir({
        absCompDir,
        entryHtml: options.entryHtml,
        blobsDir: options.blobsDir,
        hash,
        durationSec,
        nativeWidth,
        nativeHeight,
        targetWidth,
        targetHeight,
        isSceneHost,
        backdropVideoPath: options.backdropVideoPath,
        transparent: useTrueAlpha,
        opaqueBackdropColor: options.opaqueBackdropColor,
        backdropImagePath: options.backdropImagePath,
      });
      targetRenderDir = tempSceneHostDir;
    }

    // HyperFrames' own GPU encode gives no measurable speed-up here (frame capture dominates) and its rate
    // control is not configurable from outside, so it is only used when asked for explicitly.
    const wantGpu = !useTrueAlpha && options.useGpu === true;
    const isDraftScale = targetWidth <= 854 && targetHeight <= 854 && (targetWidth < nativeWidth || targetHeight < nativeHeight);
    const effectiveCrf = options.crf ?? (isDraftScale ? 24 : wantGpu ? 22 : 19);

    const buildRenderArgs = (withGpu: boolean): string[] => {
      const hfFormat = !useTrueAlpha
        ? "mp4"
        : usesPngSequenceCapture
          ? "png-sequence"
          : "mov";
      const args = [
        hfBin,
        "render",
        targetRenderDir,
        "--format",
        hfFormat,
        "--quality",
        isSceneHost || (!useTrueAlpha && !isDraftScale) ? "looks" : "draft",
        "--workers",
        String(workers),
        "--output",
        tmpBlob,
      ];
      if (!useTrueAlpha) {
        args.push("--crf", String(effectiveCrf));
        if (withGpu) {
          args.push("--gpu");
        }
      }
      if (isSceneHost) {
        args.push("--video-frame-format", "png");
      }
      const activeVarsFile = path.join(targetRenderDir, "assets/cuthol-vars.json");
      if (Object.keys(scalarVars).length > 0 && fs.existsSync(activeVarsFile)) {
        args.push("--variables-file", activeVarsFile);
      }
      return args;
    };

    const renderArgs = buildRenderArgs(wantGpu);
    const expectedFramesCheck = usesPngSequenceCapture ? expectedFrames : undefined;

    if (overlayCollector) {
      const stageDirToClean = tempSceneHostDir;
      const workDirToClean = tmpWorkDir;
      overlayCollector.push({
        compName,
        compositionDir: options.compositionDir,
        absCompDir,
        outBlob,
        tmpBlob,
        watchTargetPath,
        expectedFrames: expectedFramesCheck,
        args: renderArgs,
        fallbackNoGpuArgs: wantGpu ? buildRenderArgs(false) : null,
        wantGpu,
        workers,
        stageDirToClean,
        finalizeSuccess: finalizeRenderedBlob,
        cleanupTemp: () => {
          if (workDirToClean && fs.existsSync(workDirToClean)) {
            try {
              fs.rmSync(workDirToClean, { recursive: true, force: true });
            } catch {
              // ignore
            }
          } else if (fs.existsSync(tmpBlob)) {
            try {
              fs.rmSync(tmpBlob, { recursive: true, force: true });
            } catch {
              // ignore
            }
          }
          if (stageDirToClean && fs.existsSync(stageDirToClean)) {
            try {
              fs.rmSync(stageDirToClean, { recursive: true, force: true });
            } catch {
              // ignore
            }
          }
        },
      });
      deferredToCollector = true;
      return outBlob;
    }

    // No wall-clock limit: render time grows with composition length (long videos take hours).
    // A large output buffer keeps progress logging of long renders from killing the process (ENOBUFS).
    progressWatch({
      mode: "watch",
      paths: [watchTargetPath],
      expectedFrames: [expectedFramesCheck ?? 0],
    });
    const hfProc = spawnWatchedSync(process.execPath, renderArgs, {
      encoding: "utf8",
      env: hyperFramesProcessEnv(),
      maxBuffer: 512 * 1024 * 1024,
      step: "hyperframes render",
      watchedPaths: [watchTargetPath],
      cleanupPathsOnStall: [watchTargetPath],
    });
    let finalHfProc = hfProc;
    let usedGpu = wantGpu;
    let gpuFallbackReason: string | null = null;

    if (
      wantGpu &&
      (finalHfProc.status !== 0 || !isValidVideoBlobOnDisk(tmpBlob, expectedFramesCheck))
    ) {
      usedGpu = false;
      gpuFallbackReason = finalHfProc.stalled
        ? "stalled"
        : "HyperFrames GPU encode failed; retried with libx264";
      if (fs.existsSync(tmpBlob)) {
        try {
          fs.rmSync(tmpBlob, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      finalHfProc = spawnWatchedSync(process.execPath, buildRenderArgs(false), {
        encoding: "utf8",
        env: hyperFramesProcessEnv(),
        maxBuffer: 512 * 1024 * 1024,
        step: "hyperframes render",
        watchedPaths: [watchTargetPath],
        cleanupPathsOnStall: [watchTargetPath],
      });
    }

    if (hfProc.status === 0 || finalHfProc.status === 0) {
      if (isValidVideoBlobOnDisk(tmpBlob, expectedFramesCheck)) {
        finalizeRenderedBlob({
          usedGpu,
          gpuFallbackReason,
          elapsedMs: Date.now() - tStart,
          stdoutStr: String(finalHfProc.stdout || ""),
          stderrStr: String(finalHfProc.stderr || ""),
        });
        return outBlob;
      }
    }

    throw buildHyperFramesFailureError(options.compositionDir, renderArgs, finalHfProc);
  } finally {
    if (!deferredToCollector) {
      if (tmpWorkDir && fs.existsSync(tmpWorkDir)) {
        try {
          fs.rmSync(tmpWorkDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      } else if (fs.existsSync(tmpBlob)) {
        try {
          fs.rmSync(tmpBlob, { recursive: true, force: true });
        } catch {
          // ignore cleanup error
        }
      }
      if (tempSceneHostDir && fs.existsSync(tempSceneHostDir)) {
        try {
          fs.rmSync(tempSceneHostDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }
}
