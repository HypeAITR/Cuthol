// Single and batch composition frames for the monitor, and the alpha bounding-box sidecar (split out of hyperframes_bridge.ts).
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  spawnWatchedSync
} from "../core/subprocess.js";
import { isPngSequenceBlobDir, resolveCachedCompositionVideoBlob, stageCompositionRenderDir, isValidVideoBlobOnDisk, inspectPngSequenceDir } from "./hf_blobs.js";
import { syncScalarVarsAndComputeCompositionHash } from "./hf_cache_state.js";
import { findLocalHyperFramesCliMjs } from "./hf_common.js";
import { renderHyperFramesCompositionToMp4 } from "./hf_render.js";

export function resolveFramePngInPngSequenceDir(dirPath: string, frameIdx: number): string | null {
  try {
    if (!isPngSequenceBlobDir(dirPath) || !fs.existsSync(dirPath)) return null;
    const directCandidate = path.join(dirPath, `frame_${String(frameIdx + 1).padStart(6, "0")}.png`);
    if (fs.existsSync(directCandidate) && fs.statSync(directCandidate).size > 64) {
      return directCandidate;
    }
    const pngNames = fs
      .readdirSync(dirPath)
      .filter((name) => /^frame_\d+\.png$/i.test(name))
      .sort();
    if (pngNames.length === 0) return null;
    const clampedIdx = Math.max(0, Math.min(pngNames.length - 1, frameIdx));
    const fallbackCandidate = path.join(dirPath, pngNames[clampedIdx]);
    return fs.existsSync(fallbackCandidate) && fs.statSync(fallbackCandidate).size > 64
      ? fallbackCandidate
      : null;
  } catch {
    return null;
  }
}

function extractFrameFromVideoBlob(
  videoPath: string,
  frameIdx: number,
  fps: number,
  outPng: string,
  scaleToWidth?: number,
  scaleToHeight?: number
): boolean {
  const tmpPng = `${outPng}.${process.pid}.tmp.png`;

  if (isPngSequenceBlobDir(videoPath)) {
    const srcFramePng = resolveFramePngInPngSequenceDir(videoPath, frameIdx);
    if (!srcFramePng) return false;
    if (!scaleToWidth || !scaleToHeight) {
      try {
        fs.copyFileSync(srcFramePng, tmpPng);
        if (fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 64) {
          fs.renameSync(tmpPng, outPng);
          return true;
        }
      } catch {
        // fall through
      }
    } else {
      const scaleProc = spawnWatchedSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-i",
          srcFramePng,
          "-vf",
          `scale=${scaleToWidth}:${scaleToHeight}:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba`,
          "-frames:v",
          "1",
          tmpPng,
        ],
        {
          encoding: "utf8",
          step: "ffmpeg scale pngseq frame",
          watchedPaths: [tmpPng],
          cleanupPathsOnStall: [tmpPng],
        }
      );
      if (scaleProc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 64) {
        fs.renameSync(tmpPng, outPng);
        return true;
      }
    }
    if (fs.existsSync(tmpPng)) {
      try {
        fs.unlinkSync(tmpPng);
      } catch {
        // ignore
      }
    }
    return false;
  }

  const seekSec = (frameIdx / fps).toFixed(6);
  const vfBase =
    scaleToWidth && scaleToHeight
      ? `scale=${scaleToWidth}:${scaleToHeight},format=rgba`
      : "format=rgba";
  const seekProc = spawnWatchedSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-ss",
      seekSec,
      "-i",
      videoPath,
      "-vf",
      vfBase,
      "-frames:v",
      "1",
      tmpPng,
    ],
    {
      encoding: "utf8",
      step: "ffmpeg extract blob frame",
      watchedPaths: [tmpPng],
      cleanupPathsOnStall: [tmpPng],
    }
  );
  if (seekProc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 200) {
    fs.renameSync(tmpPng, outPng);
    return true;
  }
  const extProc = spawnWatchedSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      videoPath,
      "-vf",
      `select='eq(n\\,${frameIdx})',${vfBase}`,
      "-frames:v",
      "1",
      tmpPng,
    ],
    {
      encoding: "utf8",
      step: "ffmpeg extract blob frame",
      watchedPaths: [tmpPng],
      cleanupPathsOnStall: [tmpPng],
    }
  );
  if (extProc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 200) {
    fs.renameSync(tmpPng, outPng);
    return true;
  }
  // Fallback to last frame (`-sseof -0.1`) if `frameIdx` exceeded encoded frame count by 1
  const eofProc = spawnWatchedSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-sseof",
      "-0.1",
      "-i",
      videoPath,
      "-vf",
      vfBase,
      "-frames:v",
      "1",
      tmpPng,
    ],
    {
      encoding: "utf8",
      step: "ffmpeg extract blob frame",
      watchedPaths: [tmpPng],
      cleanupPathsOnStall: [tmpPng],
    }
  );
  if (eofProc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 200) {
    fs.renameSync(tmpPng, outPng);
    return true;
  }
  if (fs.existsSync(tmpPng)) {
    try {
      fs.unlinkSync(tmpPng);
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Captures a single frame-grid-snapped RGBA PNG from a HyperFrames composition for fast `monitor frame --at <ms>`
 * without rendering the entire composition video when uncached.
 */
export function renderHyperFramesSingleFramePng(options: {
  compositionDir: string;
  entryHtml: string;
  blobsDir: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  localSec: number;
  props: Record<string, unknown>;
  transparent: boolean;
  mode?: "overlay_alpha" | "scene_host";
  backdropVideoPath?: string;
  opaqueBackdropColor?: string;
  backdropImagePath?: string;
}): { pngPath: string; snappedSec: number; frameIdx: number } {
  const absCompDir = path.resolve(options.compositionDir);
  const entryPath = path.join(absCompDir, options.entryHtml);
  if (!fs.existsSync(entryPath)) {
    throw new CutholError(DIAGNOSTICS.MISSING_FILE_ON_DISK("composition", entryPath));
  }

  const mode = options.mode ?? "overlay_alpha";
  let htmlSource = fs.readFileSync(entryPath, "utf8");
  if (options.transparent && mode !== "scene_host" && /(?:body|#root)\s*\{[^}]*?background\s*:\s*#00ff00\b/i.test(htmlSource)) {
    htmlSource = htmlSource.replace(
      /((?:body|#root)\s*\{[^}]*?)background\s*:\s*#00ff00\b/gi,
      "$1background: transparent"
    );
    fs.writeFileSync(entryPath, htmlSource, "utf8");
  }

  const durationSec = Math.max(0.1, Number((options.durationMs / 1000).toFixed(3)));
  const totalFrames = Math.max(1, Math.round(durationSec * options.fps));
  const frameIdx = Math.max(
    0,
    Math.min(totalFrames - 1, Math.floor(options.localSec * options.fps + 1e-6))
  );
  const snappedSec = Number((frameIdx / options.fps).toFixed(6));

  const hashInfo = syncScalarVarsAndComputeCompositionHash({
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
  });
  const { hash, nativeHash, legacyHash, isSceneHost, nativeWidth, nativeHeight, targetWidth, targetHeight } =
    hashInfo;

  fs.mkdirSync(options.blobsDir, { recursive: true });
  const outPng = path.join(options.blobsDir, `hf_frame_${hash}_f${frameIdx}.png`);
  if (fs.existsSync(outPng) && fs.statSync(outPng).size > 200) {
    if (options.transparent && !isSceneHost) {
      recordCompositionAlphaBboxSidecar(absCompDir, outPng);
    }
    return { pngPath: outPng, snappedSec, frameIdx };
  }
  const legPng = path.join(options.blobsDir, `hf_frame_${legacyHash}_f${frameIdx}.png`);
  if (legacyHash !== hash && fs.existsSync(legPng) && fs.statSync(legPng).size > 200) {
    if (options.transparent && !isSceneHost) {
      recordCompositionAlphaBboxSidecar(absCompDir, legPng);
    }
    return { pngPath: legPng, snappedSec, frameIdx };
  }

  for (const candExt of ["pngseq", "ffv1.mov", "mov", "mp4"] as const) {
    const resolved = resolveCachedCompositionVideoBlob({
      absCompDir,
      entryPath,
      blobsDir: options.blobsDir,
      ext: candExt,
      expectedFrames: candExt === "pngseq" ? totalFrames : undefined,
      durationMs: options.durationMs,
      transparent: candExt !== "mp4",
      mode,
      backdropImagePath: options.backdropImagePath,
      hashInfo,
    });
    if (resolved.cachedBlobPath) {
      const extracted = resolved.isExactTargetRes
        ? extractFrameFromVideoBlob(resolved.cachedBlobPath, frameIdx, options.fps, outPng)
        : extractFrameFromVideoBlob(
            resolved.cachedBlobPath,
            frameIdx,
            options.fps,
            outPng,
            targetWidth,
            targetHeight
          );
      if (extracted) {
        if (options.transparent && !isSceneHost && !resolved.cachedBlobPath.endsWith(".mp4")) {
          recordCompositionAlphaBboxSidecar(absCompDir, outPng);
        }
        return { pngPath: outPng, snappedSec, frameIdx };
      }
    }
  }

  const hfBin = findLocalHyperFramesCliMjs();
  if (fs.existsSync(hfBin)) {
    const tmpSnapDir = path.join(
      options.blobsDir,
      `hf_snap_tmp_${hash}_f${frameIdx}_${process.pid}_${Date.now()}`
    );
    const needsStage =
      (isSceneHost && Boolean(options.backdropVideoPath)) ||
      (!options.transparent && Boolean(options.opaqueBackdropColor || options.backdropImagePath)) ||
      targetWidth !== nativeWidth ||
      targetHeight !== nativeHeight;
    let tempSceneHostDir: string | null = null;
    try {
      let targetSnapDir = absCompDir;
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
          transparent: options.transparent,
          opaqueBackdropColor: options.opaqueBackdropColor,
          backdropImagePath: options.backdropImagePath,
        });
        targetSnapDir = tempSceneHostDir;
      }
      const snapProc = spawnWatchedSync(
        process.execPath,
        [
          hfBin,
          "snapshot",
          targetSnapDir,
          "--at",
          String(snappedSec),
          "--no-end",
          "--describe",
          "false",
          "--output",
          tmpSnapDir,
        ],
        {
          encoding: "utf8",
          step: "hyperframes snapshot",
          watchedPaths: [tmpSnapDir],
          cleanupPathsOnStall: [tmpSnapDir],
        }
      );
      if (snapProc.status === 0 && fs.existsSync(tmpSnapDir)) {
        const pngFile = fs
          .readdirSync(tmpSnapDir)
          .sort()
          .find((f) => f.startsWith("frame-") && f.endsWith(".png"));
        if (pngFile) {
          const fullPng = path.join(tmpSnapDir, pngFile);
          fs.copyFileSync(fullPng, outPng);
          if (options.transparent && !isSceneHost) {
            recordCompositionAlphaBboxSidecar(absCompDir, outPng);
          }
          return { pngPath: outPng, snappedSec, frameIdx };
        }
      }
    } finally {
      if (fs.existsSync(tmpSnapDir)) {
        try {
          fs.rmSync(tmpSnapDir, { recursive: true, force: true });
        } catch {
          // ignore
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

  // Fallback single-frame synthesis
  const fullBlob = renderHyperFramesCompositionToMp4({
    compositionDir: options.compositionDir,
    entryHtml: options.entryHtml,
    blobsDir: options.blobsDir,
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
  });
  extractFrameFromVideoBlob(fullBlob, frameIdx, options.fps, outPng);
  return { pngPath: outPng, snappedSec, frameIdx };
}

function parseSnapshotFrameSecFromFilename(filePath: string): number | null {
  const base = path.basename(filePath);
  const m = /^frame-(?:\d+-at-)?([\d.]+)s\.png$/i.exec(base);
  if (!m) return null;
  const val = Number(m[1]);
  return Number.isFinite(val) ? val : null;
}

/**
 * Captures multiple frame-grid-snapped RGBA PNGs from a HyperFrames composition in a single
 * `snapshot --at t1,t2,...` invocation and writes them into the shared `hf_frame_<hash>_f<idx>.png`
 * cache so `renderSingleCompositeFrameRgb24` hits the cache for every cell in `monitor sheet`.
 */
export function renderHyperFramesBatchFramesPng(options: {
  compositionDir: string;
  entryHtml: string;
  blobsDir: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  localSecs: number[];
  props: Record<string, unknown>;
  transparent: boolean;
  mode?: "overlay_alpha" | "scene_host";
  backdropVideoPath?: string;
  opaqueBackdropColor?: string;
  backdropImagePath?: string;
}): Array<{ pngPath: string; snappedSec: number; frameIdx: number }> {
  if (options.localSecs.length === 0) {
    return [];
  }

  const absCompDir = path.resolve(options.compositionDir);
  const entryPath = path.join(absCompDir, options.entryHtml);
  if (!fs.existsSync(entryPath)) {
    throw new CutholError(DIAGNOSTICS.MISSING_FILE_ON_DISK("composition", entryPath));
  }

  const mode = options.mode ?? "overlay_alpha";
  let htmlSource = fs.readFileSync(entryPath, "utf8");
  if (
    options.transparent &&
    mode !== "scene_host" &&
    /(?:body|#root)\s*\{[^}]*?background\s*:\s*#00ff00\b/i.test(htmlSource)
  ) {
    htmlSource = htmlSource.replace(
      /((?:body|#root)\s*\{[^}]*?)background\s*:\s*#00ff00\b/gi,
      "$1background: transparent"
    );
    fs.writeFileSync(entryPath, htmlSource, "utf8");
  }

  const durationSec = Math.max(0.1, Number((options.durationMs / 1000).toFixed(3)));
  const totalFrames = Math.max(1, Math.round(durationSec * options.fps));

  const { hash, nativeHash, isSceneHost, nativeWidth, nativeHeight, targetWidth, targetHeight } =
    syncScalarVarsAndComputeCompositionHash({
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
    });

  fs.mkdirSync(options.blobsDir, { recursive: true });

  const requestedItems = options.localSecs.map((localSec) => {
    const frameIdx = Math.max(
      0,
      Math.min(totalFrames - 1, Math.floor(localSec * options.fps + 1e-6))
    );
    const snappedSec = Number((frameIdx / options.fps).toFixed(6));
    const pngPath = path.join(options.blobsDir, `hf_frame_${hash}_f${frameIdx}.png`);
    return { pngPath, snappedSec, frameIdx };
  });

  const uniqueMissingByFrame = new Map<number, { pngPath: string; snappedSec: number; frameIdx: number }>();
  for (const item of requestedItems) {
    if (!fs.existsSync(item.pngPath) || fs.statSync(item.pngPath).size <= 200) {
      uniqueMissingByFrame.set(item.frameIdx, item);
    }
  }

  const missingTargets = [...uniqueMissingByFrame.values()].sort((a, b) => a.frameIdx - b.frameIdx);
  if (missingTargets.length === 0) {
    const bboxSidecarPath = path.join(absCompDir, "assets/cuthol-bbox.json");
    if (options.transparent && !isSceneHost && !fs.existsSync(bboxSidecarPath)) {
      recordCompositionAlphaBboxSidecar(absCompDir, requestedItems[0].pngPath);
    }
    return requestedItems;
  }

  const findValidBlobForHash = (h: string): string | null => {
    for (const ext of ["pngseq", "ffv1.mov", "mov", "mp4"] as const) {
      const cand = path.join(options.blobsDir, `hf_comp_${h}.${ext}`);
      if (isValidVideoBlobOnDisk(cand, ext === "pngseq" ? totalFrames : undefined)) {
        return cand;
      }
    }
    return null;
  };

  let scaleW: number | undefined;
  let scaleH: number | undefined;
  let videoToExtract = findValidBlobForHash(hash);
  if (!videoToExtract && nativeHash !== hash) {
    const nativeBlob = findValidBlobForHash(nativeHash);
    if (nativeBlob) {
      videoToExtract = nativeBlob;
      scaleW = targetWidth;
      scaleH = targetHeight;
    }
  }

  const stillMissing: Array<{ pngPath: string; snappedSec: number; frameIdx: number }> = [];
  if (videoToExtract) {
    for (const target of missingTargets) {
      if (
        !extractFrameFromVideoBlob(
          videoToExtract,
          target.frameIdx,
          options.fps,
          target.pngPath,
          scaleW,
          scaleH
        )
      ) {
        stillMissing.push(target);
      }
    }
  } else {
    stillMissing.push(...missingTargets);
  }

  const hfBin = findLocalHyperFramesCliMjs();
  if (stillMissing.length > 0 && fs.existsSync(hfBin)) {
    const tmpSnapDir = path.join(
      options.blobsDir,
      `hf_snap_batch_${hash}_${process.pid}_${Date.now()}`
    );
    const needsStage =
      (isSceneHost && Boolean(options.backdropVideoPath)) ||
      (!options.transparent && Boolean(options.opaqueBackdropColor || options.backdropImagePath)) ||
      targetWidth !== nativeWidth ||
      targetHeight !== nativeHeight;
    let tempSceneHostDir: string | null = null;
    try {
      let targetSnapDir = absCompDir;
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
          transparent: options.transparent,
          opaqueBackdropColor: options.opaqueBackdropColor,
          backdropImagePath: options.backdropImagePath,
        });
        targetSnapDir = tempSceneHostDir;
      }

      const snapProc = spawnWatchedSync(
        process.execPath,
        [
          hfBin,
          "snapshot",
          targetSnapDir,
          "--at",
          stillMissing.map((t) => String(t.snappedSec)).join(","),
          "--no-end",
          "--describe",
          "false",
          "--output",
          tmpSnapDir,
        ],
        {
          encoding: "utf8",
          step: "hyperframes snapshot",
          watchedPaths: [tmpSnapDir],
          cleanupPathsOnStall: [tmpSnapDir],
        }
      );

      if (snapProc.status === 0 && fs.existsSync(tmpSnapDir)) {
        const capturedPngs = fs
          .readdirSync(tmpSnapDir)
          .filter((f) => f.startsWith("frame-") && f.endsWith(".png"))
          .map((f) => path.join(tmpSnapDir, f))
          .sort((a, b) => {
            const sa = parseSnapshotFrameSecFromFilename(a);
            const sb = parseSnapshotFrameSecFromFilename(b);
            if (sa !== null && sb !== null) return sa - sb;
            return a.localeCompare(b);
          });

        for (let i = 0; i < stillMissing.length; i++) {
          const target = stillMissing[i];
          let matchedPng: string | undefined;
          let bestDiff = Infinity;
          for (const candidate of capturedPngs) {
            const cSec = parseSnapshotFrameSecFromFilename(candidate);
            if (cSec !== null) {
              const diff = Math.abs(cSec - target.snappedSec);
              if (diff < bestDiff && diff <= Math.max(0.05, 1.5 / options.fps)) {
                bestDiff = diff;
                matchedPng = candidate;
              }
            }
          }
          if (!matchedPng && i < capturedPngs.length) {
            matchedPng = capturedPngs[i];
          }
          if (matchedPng && fs.existsSync(matchedPng)) {
            fs.copyFileSync(matchedPng, target.pngPath);
          }
        }
      }
    } finally {
      if (fs.existsSync(tmpSnapDir)) {
        try {
          fs.rmSync(tmpSnapDir, { recursive: true, force: true });
        } catch {
          // ignore
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

  for (const target of stillMissing) {
    if (!fs.existsSync(target.pngPath) || fs.statSync(target.pngPath).size <= 200) {
      renderHyperFramesSingleFramePng({
        ...options,
        localSec: target.snappedSec,
      });
    }
  }

  if (options.transparent && !isSceneHost && requestedItems.length > 0) {
    const firstValid = requestedItems.find(
      (r) => fs.existsSync(r.pngPath) && fs.statSync(r.pngPath).size > 200
    );
    if (firstValid) {
      recordCompositionAlphaBboxSidecar(absCompDir, firstValid.pngPath);
    }
  }

  return requestedItems;
}

export interface MeasuredAlphaBboxPct {
  left_pct: number;
  top_pct: number;
  right_pct: number;
  bottom_pct: number;
  width_pct: number;
  height_pct: number;
}

/**
 * Measures the actual visible pixel bounding box (alpha > 12) from a rendered RGBA PNG frame
 * or ProRes 4444 .mov video and writes <absCompDir>/assets/cuthol-bbox.json so measureCuePixelBox
 * places the monitor/verification bounding box around the real custom graphic instead of guessing.
 */
export function recordCompositionAlphaBboxSidecar(
  absCompDir: string,
  mediaPath: string,
  atSec?: number
): MeasuredAlphaBboxPct | null {
  try {
    if (!fs.existsSync(mediaPath)) return null;
    let effectiveMediaPath = mediaPath;
    if (isPngSequenceBlobDir(mediaPath)) {
      const info = inspectPngSequenceDir(mediaPath);
      if (!info.valid || info.frameCount <= 0) return null;
      const midIdx = Math.floor(info.frameCount / 2);
      const midPng = resolveFramePngInPngSequenceDir(mediaPath, midIdx);
      if (!midPng) return null;
      effectiveMediaPath = midPng;
    }
    const probeW = 320;
    const probeH = 180;
    const args: string[] = ["-v", "error"];
    if (atSec !== undefined && atSec > 0 && !effectiveMediaPath.endsWith(".png")) {
      args.push("-ss", atSec.toFixed(3));
    }
    args.push(
      "-i",
      effectiveMediaPath,
      "-vf",
      `scale=${probeW}:${probeH}:flags=neighbor:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1"
    );
    const proc = spawnWatchedSync("ffmpeg", args, {
      maxBuffer: probeW * probeH * 4 + 65536,
      step: "ffmpeg alpha bbox",
    });
    const buf = proc.stdout as Buffer;
    if (proc.status !== 0 || !buf || buf.length < probeW * probeH * 4) return null;

    let minX = probeW;
    let minY = probeH;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < probeH; y++) {
      for (let x = 0; x < probeW; x++) {
        const a = buf[(y * probeW + x) * 4 + 3];
        if (a > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX || maxY < minY) return null;
    const bbox: MeasuredAlphaBboxPct = {
      left_pct: Number((minX / probeW).toFixed(4)),
      top_pct: Number((minY / probeH).toFixed(4)),
      right_pct: Number(((maxX + 1) / probeW).toFixed(4)),
      bottom_pct: Number(((maxY + 1) / probeH).toFixed(4)),
      width_pct: Number(((maxX - minX + 1) / probeW).toFixed(4)),
      height_pct: Number(((maxY - minY + 1) / probeH).toFixed(4)),
    };

    const bboxPath = path.join(path.resolve(absCompDir), "assets/cuthol-bbox.json");
    fs.mkdirSync(path.dirname(bboxPath), { recursive: true });
    fs.writeFileSync(bboxPath, JSON.stringify(bbox, null, 2), "utf8");
    return bbox;
  } catch {
    return null;
  }
}
