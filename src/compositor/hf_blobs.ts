// Overlay blob files on disk: PNG-sequence/video validation, cached blob lookup, render staging directory (split out of hyperframes_bridge.ts).
import fs from "node:fs";
import path from "node:path";
import { syncScalarVarsAndComputeCompositionHash, readCompositionCacheState, areStillBackdropsVisuallyEquivalent, rendererVersionOfFilesHash } from "./hf_cache_state.js";
import { copyDirRecursiveSync } from "./hf_common.js";
import { OverlayCacheReason } from "./hf_overlay_tracking.js";

export type OverlayBlobExt = "pngseq" | "ffv1.mov" | "mov" | "mp4";

export function isPngSequenceBlobDir(blobPath: string): boolean {
  if (!blobPath) return false;
  if (blobPath.endsWith(".pngseq")) return true;
  try {
    return fs.existsSync(blobPath) && fs.statSync(blobPath).isDirectory();
  } catch {
    return false;
  }
}

export function inspectPngSequenceDir(dirPath: string): {
  valid: boolean;
  frameCount: number;
  totalBytes: number;
  firstFramePath: string | null;
  lastFramePath: string | null;
} {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) {
      return { valid: false, frameCount: 0, totalBytes: 0, firstFramePath: null, lastFramePath: null };
    }
    const st = fs.statSync(dirPath);
    if (!st.isDirectory()) {
      return { valid: false, frameCount: 0, totalBytes: 0, firstFramePath: null, lastFramePath: null };
    }
    const pngNames = fs
      .readdirSync(dirPath)
      .filter((name) => /^frame_\d+\.png$/i.test(name))
      .sort();
    const frameCount = pngNames.length;
    if (frameCount === 0) {
      return { valid: false, frameCount: 0, totalBytes: 0, firstFramePath: null, lastFramePath: null };
    }
    const firstFramePath = path.join(dirPath, pngNames[0]);
    const lastFramePath = path.join(dirPath, pngNames[frameCount - 1]);
    const firstSize = fs.statSync(firstFramePath).size;
    const lastSize = fs.statSync(lastFramePath).size;
    if (firstSize <= 64 || lastSize <= 64) {
      return { valid: false, frameCount, totalBytes: 0, firstFramePath, lastFramePath };
    }
    let totalBytes = 0;
    for (const name of pngNames) {
      try {
        totalBytes += fs.statSync(path.join(dirPath, name)).size;
      } catch {
        return { valid: false, frameCount, totalBytes: 0, firstFramePath, lastFramePath };
      }
    }
    return {
      valid: totalBytes > 128,
      frameCount,
      totalBytes,
      firstFramePath,
      lastFramePath,
    };
  } catch {
    return { valid: false, frameCount: 0, totalBytes: 0, firstFramePath: null, lastFramePath: null };
  }
}

export function isValidVideoBlobOnDisk(blobPath: string, expectedFrames?: number): boolean {
  if (!blobPath || !fs.existsSync(blobPath)) return false;
  const legacyFallbackSidecar = `${blobPath}.fallback.json`;
  if (fs.existsSync(legacyFallbackSidecar)) {
    for (const stale of [blobPath, legacyFallbackSidecar]) {
      try {
        fs.rmSync(stale, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    return false;
  }
  try {
    const st = fs.statSync(blobPath);
    if (st.isDirectory()) {
      const info = inspectPngSequenceDir(blobPath);
      if (!info.valid) return false;
      if (typeof expectedFrames === "number" && Number.isFinite(expectedFrames) && expectedFrames > 0) {
        if (info.frameCount < Math.max(1, expectedFrames - 1)) {
          return false;
        }
      }
      return true;
    }
    return st.isFile() && st.size > 1000;
  } catch {
    return false;
  }
}

export function resolveCachedCompositionVideoBlob(params: {
  absCompDir: string;
  entryPath: string;
  blobsDir: string;
  ext: OverlayBlobExt;
  expectedFrames?: number;
  durationMs: number;
  transparent: boolean;
  mode: "overlay_alpha" | "scene_host";
  backdropImagePath?: string;
  hashInfo: ReturnType<typeof syncScalarVarsAndComputeCompositionHash>;
}): {
  cachedBlobPath: string | null;
  isExactTargetRes: boolean;
  missReason: OverlayCacheReason;
  matchedBackdropImagePath?: string;
} {
  const {
    absCompDir,
    blobsDir,
    ext,
    expectedFrames,
    durationMs,
    transparent,
    mode,
    backdropImagePath,
    hashInfo,
  } = params;
  const {
    hash,
    nativeHash,
    legacyHash,
    legacyNativeHash,
    filesHash,
    usedSliceHash,
    usedGlobalHash,
    propsHash,
    backdropDigest,
    legacyDirHash,
    validLegacyDirHashes,
    nativeWidth,
    nativeHeight,
    targetWidth,
    targetHeight,
    computeCandidateKey,
  } = hashInfo;

  const outBlob = path.join(blobsDir, `hf_comp_${hash}.${ext}`);
  if (isValidVideoBlobOnDisk(outBlob, expectedFrames)) {
    return {
      cachedBlobPath: outBlob,
      isExactTargetRes: true,
      missReason: "cached",
      matchedBackdropImagePath: backdropImagePath,
    };
  }

  if (nativeHash !== hash) {
    const nativeBlob = path.join(blobsDir, `hf_comp_${nativeHash}.${ext}`);
    if (isValidVideoBlobOnDisk(nativeBlob, expectedFrames)) {
      return {
        cachedBlobPath: nativeBlob,
        isExactTargetRes: false,
        missReason: "cached",
        matchedBackdropImagePath: backdropImagePath,
      };
    }
  }

  const prevState = readCompositionCacheState(blobsDir, absCompDir);
  // Hashes can match while the file itself is gone. That is not a backdrop change.
  let backdropMatched = false;
  if (prevState) {
    // Renderer version is tagged onto filesHash (`<digest>|hf:<version>`). That miss is not an HTML edit.
    if (rendererVersionOfFilesHash(prevState.filesHash) !== rendererVersionOfFilesHash(filesHash)) {
      return { cachedBlobPath: null, isExactTargetRes: false, missReason: "renderer_version_changed" };
    }
    if (prevState.filesHash !== filesHash) {
      return { cachedBlobPath: null, isExactTargetRes: false, missReason: "html_changed" };
    }
    if (prevState.usedSliceHash !== usedSliceHash) {
      return { cachedBlobPath: null, isExactTargetRes: false, missReason: "slice_changed" };
    }
    if (prevState.usedGlobalHash !== usedGlobalHash) {
      return { cachedBlobPath: null, isExactTargetRes: false, missReason: "global_used_changed" };
    }
    if (prevState.propsHash !== propsHash || prevState.durationMs !== durationMs) {
      return { cachedBlobPath: null, isExactTargetRes: false, missReason: "props_changed" };
    }
    if (prevState.transparent !== transparent || prevState.mode !== mode) {
      return { cachedBlobPath: null, isExactTargetRes: false, missReason: "backdrop_changed" };
    }

    const exactBdTargetKey = `${targetWidth}x${targetHeight}:${ext}:${backdropDigest}`;
    const exactBdNativeKey = `${nativeWidth}x${nativeHeight}:${ext}:${backdropDigest}`;
    if (
      prevState.cachedBlobs?.[exactBdTargetKey] &&
      isValidVideoBlobOnDisk(prevState.cachedBlobs[exactBdTargetKey], expectedFrames)
    ) {
      return {
        cachedBlobPath: prevState.cachedBlobs[exactBdTargetKey],
        isExactTargetRes: true,
        missReason: "cached",
        matchedBackdropImagePath: backdropImagePath,
      };
    }
    if (
      prevState.cachedBlobs?.[exactBdNativeKey] &&
      isValidVideoBlobOnDisk(prevState.cachedBlobs[exactBdNativeKey], expectedFrames)
    ) {
      return {
        cachedBlobPath: prevState.cachedBlobs[exactBdNativeKey],
        isExactTargetRes: targetWidth === nativeWidth && targetHeight === nativeHeight,
        missReason: "cached",
        matchedBackdropImagePath: backdropImagePath,
      };
    }

    backdropMatched =
      prevState.backdropDigest === backdropDigest ||
      (!transparent &&
        Boolean(backdropImagePath && prevState.backdropImagePath) &&
        areStillBackdropsVisuallyEquivalent(backdropImagePath, prevState.backdropImagePath));

    if (backdropMatched) {
      const targetResKey = `${targetWidth}x${targetHeight}:${ext}`;
      const nativeResKey = `${nativeWidth}x${nativeHeight}:${ext}`;
      const savedTarget = prevState.cachedBlobs?.[targetResKey];
      if (savedTarget && isValidVideoBlobOnDisk(savedTarget, expectedFrames)) {
        return {
          cachedBlobPath: savedTarget,
          isExactTargetRes: true,
          missReason: "cached",
          matchedBackdropImagePath: prevState.backdropImagePath ?? backdropImagePath,
        };
      }
      const savedNative = prevState.cachedBlobs?.[nativeResKey];
      if (savedNative && isValidVideoBlobOnDisk(savedNative, expectedFrames)) {
        return {
          cachedBlobPath: savedNative,
          isExactTargetRes: targetWidth === nativeWidth && targetHeight === nativeHeight,
          missReason: "cached",
          matchedBackdropImagePath: prevState.backdropImagePath ?? backdropImagePath,
        };
      }
    }
  }

  // Backward-compatible lookup for pre-existing `.cuthol/blobs/hf_comp_<legacyHash>` caches
  // when neither composition files nor used bridge slices have changed.
  const canTryLegacyBlobs =
    !prevState ||
    (prevState.filesHash === filesHash &&
      prevState.usedSliceHash === usedSliceHash &&
      prevState.usedGlobalHash === usedGlobalHash &&
      prevState.propsHash === propsHash &&
      prevState.durationMs === durationMs &&
      prevState.transparent === transparent &&
      prevState.mode === mode);

  if (canTryLegacyBlobs) {
    const legOut = path.join(blobsDir, `hf_comp_${legacyHash}.${ext}`);
    if (isValidVideoBlobOnDisk(legOut, expectedFrames)) {
      return {
        cachedBlobPath: legOut,
        isExactTargetRes: true,
        missReason: "cached",
        matchedBackdropImagePath: backdropImagePath,
      };
    }
    const legNat = path.join(blobsDir, `hf_comp_${legacyNativeHash}.${ext}`);
    if (isValidVideoBlobOnDisk(legNat, expectedFrames)) {
      return {
        cachedBlobPath: legNat,
        isExactTargetRes: targetWidth === nativeWidth && targetHeight === nativeHeight,
        missReason: "cached",
        matchedBackdropImagePath: backdropImagePath,
      };
    }

    const candidateDirHashes = [
      legacyDirHash,
      ...validLegacyDirHashes.filter((h) => h !== legacyDirHash),
    ];
    for (const candDirH of candidateDirHashes) {
      for (const [w, h, exact] of [
        [targetWidth, targetHeight, true] as const,
        [nativeWidth, nativeHeight, targetWidth === nativeWidth && targetHeight === nativeHeight] as const,
      ]) {
        const directCand = path.join(
          blobsDir,
          `hf_comp_${computeCandidateKey(candDirH, w, h, hashInfo.legacyBackdropDigest)}.${ext}`
        );
        if (isValidVideoBlobOnDisk(directCand, expectedFrames)) {
          return {
            cachedBlobPath: directCand,
            isExactTargetRes: exact,
            missReason: "cached",
            matchedBackdropImagePath: backdropImagePath,
          };
        }
      }
    }

    if (!transparent && backdropImagePath && fs.existsSync(blobsDir)) {
      try {
        const stillFiles = fs.readdirSync(blobsDir).filter((f) => f.startsWith("sh_still_") && f.endsWith(".png"));
        for (const candDirH of candidateDirHashes) {
          for (const [w, h, exact] of [
            [targetWidth, targetHeight, true] as const,
            [nativeWidth, nativeHeight, targetWidth === nativeWidth && targetHeight === nativeHeight] as const,
          ]) {
            for (const sf of stillFiles) {
              const sfFull = path.join(blobsDir, sf);
              let sfSize = 0;
              try {
                sfSize = fs.statSync(sfFull).size;
              } catch {
                continue;
              }
              const bd = `still:${sf}:${sfSize}`;
              const candHash = computeCandidateKey(candDirH, w, h, bd);
              const candBlob = path.join(blobsDir, `hf_comp_${candHash}.${ext}`);
              if (isValidVideoBlobOnDisk(candBlob, expectedFrames)) {
                if (
                  backdropDigest === "self-opaque" ||
                  areStillBackdropsVisuallyEquivalent(backdropImagePath, sfFull)
                ) {
                  return {
                    cachedBlobPath: candBlob,
                    isExactTargetRes: exact,
                    missReason: "cached",
                    matchedBackdropImagePath: sfFull,
                  };
                }
              }
            }
          }
        }
      } catch {
        // ignore directory scan error
      }
    }
  }

  if (prevState) {
    return {
      cachedBlobPath: null,
      isExactTargetRes: false,
      missReason: backdropMatched ? "blob_missing" : "backdrop_changed",
    };
  }

  // No state file for this composition: other blobs and bridge flags do not describe it.
  return { cachedBlobPath: null, isExactTargetRes: false, missReason: "new" };
}

export function stageCompositionRenderDir(options: {
  absCompDir: string;
  entryHtml: string;
  blobsDir: string;
  hash: string;
  durationSec: number;
  nativeWidth: number;
  nativeHeight: number;
  targetWidth: number;
  targetHeight: number;
  isSceneHost: boolean;
  backdropVideoPath?: string;
  transparent: boolean;
  opaqueBackdropColor?: string;
  backdropImagePath?: string;
}): string {
  const tempStageDir = path.join(
    options.blobsDir,
    `hf_stage_${options.hash}_${process.pid}_${Date.now()}`
  );
  fs.rmSync(tempStageDir, { recursive: true, force: true });
  copyDirRecursiveSync(options.absCompDir, tempStageDir);

  const stagedHtmlPath = path.join(tempStageDir, options.entryHtml);
  let stagedHtml = fs.readFileSync(stagedHtmlPath, "utf8");

  if (options.isSceneHost && options.backdropVideoPath) {
    const bgDest = path.join(tempStageDir, "assets/cuthol_scene_host_bg.mp4");
    fs.mkdirSync(path.dirname(bgDest), { recursive: true });
    fs.copyFileSync(options.backdropVideoPath, bgDest);

    stagedHtml = stagedHtml.replace(
      /((?:html|body|#root)\s*\{[^}]*?)\bbackground(?:-color)?\s*:\s*[^;}]+/gi,
      "$1background: transparent"
    );
    const zIndexHelperStyle = `<style id="cuthol-scene-host-style">html, body, #root { background: transparent !important; } .clip:not(#cuthol-scene-host-bg) { z-index: 1; }</style>`;
    if (/<\/head>/i.test(stagedHtml)) {
      stagedHtml = stagedHtml.replace(/<\/head>/i, `${zIndexHelperStyle}\n</head>`);
    } else {
      stagedHtml = `${zIndexHelperStyle}\n${stagedHtml}`;
    }

    const videoTag = `\n      <video id="cuthol-scene-host-bg" class="clip" src="assets/cuthol_scene_host_bg.mp4" data-start="0" data-duration="${options.durationSec}" data-track-index="0" muted playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0"></video>`;
    if (/(<[a-zA-Z0-9_-]+\b[^>]*\bdata-composition-id=(["'])[^"']+\2[^>]*>)/i.test(stagedHtml)) {
      stagedHtml = stagedHtml.replace(
        /(<[a-zA-Z0-9_-]+\b[^>]*\bdata-composition-id=(["'])[^"']+\2[^>]*>)/i,
        `$1${videoTag}`
      );
    } else {
      stagedHtml = stagedHtml.replace(
        /(<div\b[^>]*\bid=(["'])root\2[^>]*>)/i,
        `$1${videoTag}`
      );
    }
  } else if (!options.transparent && (options.opaqueBackdropColor || options.backdropImagePath)) {
    const bgColor = options.opaqueBackdropColor || "#000000";
    let bgRule = `background-color: ${bgColor} !important;`;
    if (options.backdropImagePath && fs.existsSync(options.backdropImagePath)) {
      const extImg = path.extname(options.backdropImagePath) || ".png";
      const bgImgDest = path.join(tempStageDir, `assets/cuthol_stage_backdrop${extImg}`);
      fs.mkdirSync(path.dirname(bgImgDest), { recursive: true });
      fs.copyFileSync(options.backdropImagePath, bgImgDest);
      bgRule = `background: ${bgColor} url("assets/cuthol_stage_backdrop${extImg}") center / cover no-repeat !important;`;
    }
    stagedHtml = stagedHtml.replace(
      /((?:html\s*,\s*body|html)\s*\{[^}]*?\bbackground(?:-color)?\s*:\s*transparent)\s*!important/gi,
      "$1"
    );
    const opaqueBgStyle = `<style id="cuthol-opaque-backdrop-style">html { ${bgRule} }</style>`;
    if (/<\/head>/i.test(stagedHtml)) {
      stagedHtml = stagedHtml.replace(/<\/head>/i, `${opaqueBgStyle}\n</head>`);
    } else {
      stagedHtml = `${opaqueBgStyle}\n${stagedHtml}`;
    }
  }

  if (options.targetWidth !== options.nativeWidth || options.targetHeight !== options.nativeHeight) {
    const scaleX = Number((options.targetWidth / options.nativeWidth).toFixed(6));
    const scaleY = Number((options.targetHeight / options.nativeHeight).toFixed(6));
    stagedHtml = stagedHtml
      .replace(/(\bdata-width\s*=\s*["'])\d+(["'])/i, `$1${options.targetWidth}$2`)
      .replace(/(\bdata-height\s*=\s*["'])\d+(["'])/i, `$1${options.targetHeight}$2`)
      .replace(
        /(<meta[^>]*name=["']viewport["'][^>]*content=["']width=)\d+(,\s*height=)\d+/i,
        `$1${options.targetWidth}$2${options.targetHeight}`
      );
    const scaleStyle = `<style id="cuthol-stage-scale-style">html, body { width: ${options.targetWidth}px !important; height: ${options.targetHeight}px !important; overflow: hidden !important; } body > [data-composition-id], #root[data-composition-id] { width: ${options.nativeWidth}px !important; height: ${options.nativeHeight}px !important; transform: scale(${scaleX}, ${scaleY}) !important; transform-origin: 0 0 !important; }</style>`;
    if (/<\/head>/i.test(stagedHtml)) {
      stagedHtml = stagedHtml.replace(/<\/head>/i, `${scaleStyle}\n</head>`);
    } else {
      stagedHtml = `${scaleStyle}\n${stagedHtml}`;
    }
  }

  fs.writeFileSync(stagedHtmlPath, stagedHtml, "utf8");
  return tempStageDir;
}
