// Overlay cache state: per-composition state records, still-backdrop equivalence, composition cache hash (split out of hyperframes_bridge.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  spawnWatchedSync
} from "../core/subprocess.js";
import {
  analyzeCompositionDataUsage,
  computeUsedBridgePayloadHashes,
  extractScalarHyperFramesVariables,
  hashCompositionFilesExcludingBridgeData,
  hashDirectoryRecursive,
} from "./bridge_exporter.js";
import {
  CutholBridgeV1
} from "./cuthol_runtime.js";

const fileSha256Memo = new Map<string, string>();

function hashFileContentSha256(filePath: string): string {
  try {
    const abs = path.resolve(filePath);
    const st = fs.statSync(abs);
    const memoKey = `${abs}:${st.size}:${st.mtimeMs}`;
    const hit = fileSha256Memo.get(memoKey);
    if (hit) return hit;
    const digest = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 16);
    fileSha256Memo.set(memoKey, digest);
    return digest;
  } catch {
    return "missing";
  }
}

const stillThumb16x9Memo = new Map<string, Buffer | null>();

function getStillImageThumb16x9Rgb24(pngPath: string): Buffer | null {
  try {
    const abs = path.resolve(pngPath);
    if (!fs.existsSync(abs)) return null;
    const st = fs.statSync(abs);
    const memoKey = `${abs}:${st.size}`;
    if (stillThumb16x9Memo.has(memoKey)) {
      return stillThumb16x9Memo.get(memoKey) ?? null;
    }
    const sidecarPath = `${abs}.thumb16x9.rgb`;
    if (fs.existsSync(sidecarPath) && fs.statSync(sidecarPath).size === 16 * 9 * 3) {
      const buf = fs.readFileSync(sidecarPath);
      stillThumb16x9Memo.set(memoKey, buf);
      return buf;
    }
    const proc = spawnWatchedSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        abs,
        "-vf",
        "scale=16:9:flags=area:in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { maxBuffer: 65536, step: "ffmpeg still thumb" }
    );
    const out = proc.stdout as Buffer;
    if (proc.status === 0 && out && out.length >= 16 * 9 * 3) {
      const slice = Buffer.from(out.subarray(0, 16 * 9 * 3));
      stillThumb16x9Memo.set(memoKey, slice);
      try {
        fs.writeFileSync(sidecarPath, slice);
      } catch {
        // ignore sidecar write error
      }
      return slice;
    }
    stillThumb16x9Memo.set(memoKey, null);
    return null;
  } catch {
    return null;
  }
}

export function areStillBackdropsVisuallyEquivalent(pngA?: string, pngB?: string): boolean {
  if (!pngA && !pngB) return true;
  if (!pngA || !pngB) return false;
  const absA = path.resolve(pngA);
  const absB = path.resolve(pngB);
  if (absA === absB) return true;
  if (!fs.existsSync(absA) || !fs.existsSync(absB)) return false;
  if (hashFileContentSha256(absA) === hashFileContentSha256(absB)) return true;

  const thumbA = getStillImageThumb16x9Rgb24(absA);
  const thumbB = getStillImageThumb16x9Rgb24(absB);
  if (!thumbA || !thumbB || thumbA.length !== thumbB.length) return false;

  let diffSum = 0;
  let maxDiff = 0;
  for (let i = 0; i < thumbA.length; i++) {
    const d = Math.abs(thumbA[i] - thumbB[i]);
    diffSum += d;
    if (d > maxDiff) maxDiff = d;
  }
  const mae = diffSum / thumbA.length;
  return mae <= 3.5 && maxDiff <= 24;
}

interface CompositionCacheStateRecord {
  compositionDir: string;
  filesHash: string;
  usedSliceHash: string;
  usedGlobalHash: string;
  propsHash: string;
  durationMs: number;
  transparent: boolean;
  mode: string;
  backdropDigest: string;
  backdropImagePath?: string;
  cachedBlobs: Record<string, string>;
}

function getCompositionStateFilePath(blobsDir: string, absCompDir: string): string {
  const compKey = crypto.createHash("sha256").update(path.resolve(absCompDir)).digest("hex").slice(0, 16);
  return path.join(blobsDir, `hf_state_${compKey}.json`);
}

export function readCompositionCacheState(blobsDir: string, absCompDir: string): CompositionCacheStateRecord | null {
  const statePath = getCompositionStateFilePath(blobsDir, absCompDir);
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as CompositionCacheStateRecord;
  } catch {
    return null;
  }
}

export function writeCompositionCacheState(
  blobsDir: string,
  absCompDir: string,
  state: CompositionCacheStateRecord
): void {
  try {
    fs.mkdirSync(blobsDir, { recursive: true });
    const statePath = getCompositionStateFilePath(blobsDir, absCompDir);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // ignore state write error
  }
}

export function clearBridgeMetaLastDataChangeReason(absCompDir: string): void {
  const metaPath = path.join(absCompDir, "assets/.cuthol-bridge-meta.json");
  if (!fs.existsSync(metaPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (parsed && parsed.lastDataChangeReason) {
      parsed.lastDataChangeReason = null;
      fs.writeFileSync(metaPath, JSON.stringify(parsed, null, 2), "utf8");
    }
  } catch {
    // ignore
  }
}

function compositionOccludesHtmlBackdrop(absCompDir: string, htmlSource: string): boolean {
  // Only an explicit author declaration on the composition root counts: `data-cuthol-opaque="true"`
  // means the composition paints its own opaque full-frame surface for its whole duration,
  // so the stage backdrop underneath can never show through.
  const declared =
    /<[^>]*\bdata-composition-id\b[^>]*\bdata-cuthol-opaque\s*=\s*["']?true\b|<[^>]*\bdata-cuthol-opaque\s*=\s*["']?true\b[^>]*\bdata-composition-id\b/i.test(
      htmlSource
    );
  if (!declared) return false;
  // Safety: transparent root or masks can still reveal the backdrop.
  if (/#root\s*\{[^}]*\bbackground(?:-color)?\s*:\s*transparent\b/i.test(htmlSource)) {
    return false;
  }
  if (/\bmask-composite\b|\b-webkit-mask\b/i.test(htmlSource)) {
    return false;
  }
  return true;
}

export function syncScalarVarsAndComputeCompositionHash(options: {
  absCompDir: string;
  entryHtml: string;
  htmlSource: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  props: Record<string, unknown>;
  transparent: boolean;
  mode: "overlay_alpha" | "scene_host";
  backdropVideoPath?: string;
  opaqueBackdropColor?: string;
  backdropImagePath?: string;
}): {
  hash: string;
  nativeHash: string;
  legacyHash: string;
  legacyNativeHash: string;
  filesHash: string;
  usedSliceHash: string;
  usedGlobalHash: string;
  propsHash: string;
  backdropDigest: string;
  legacyBackdropDigest: string;
  legacyDirHash: string;
  validLegacyDirHashes: string[];
  lastDataChangeReason: "slice_changed" | "global_used_changed" | null;
  scalarVars: Record<string, string | number | boolean>;
  isSceneHost: boolean;
  nativeWidth: number;
  nativeHeight: number;
  targetWidth: number;
  targetHeight: number;
  computeCandidateKey: (dirH: string, w: number, h: number, bd: string) => string;
} {
  // Synchronize `assets/cuthol-vars.json` BEFORE hashing so the cache key is never computed against stale variables.
  const varsFile = path.join(options.absCompDir, "assets/cuthol-vars.json");
  const scalarVars = extractScalarHyperFramesVariables(options.props);
  const nextVarsJson = JSON.stringify(scalarVars, null, 2);
  let currentVarsJson = "";
  if (fs.existsSync(varsFile)) {
    try {
      currentVarsJson = fs.readFileSync(varsFile, "utf8");
    } catch {
      currentVarsJson = "";
    }
  }
  if (currentVarsJson !== nextVarsJson && (Object.keys(scalarVars).length > 0 || fs.existsSync(varsFile))) {
    fs.mkdirSync(path.dirname(varsFile), { recursive: true });
    fs.writeFileSync(varsFile, nextVarsJson, "utf8");
  }

  const wMatch = /\bdata-width\s*=\s*(["'])(\d+)\1/i.exec(options.htmlSource);
  const hMatch = /\bdata-height\s*=\s*(["'])(\d+)\1/i.exec(options.htmlSource);
  const nativeWidth = wMatch ? Math.max(16, Number(wMatch[2])) : options.width;
  const nativeHeight = hMatch ? Math.max(16, Number(hMatch[2])) : options.height;
  const targetWidth = Math.max(16, Math.round(options.width / 2) * 2);
  const targetHeight = Math.max(16, Math.round(options.height / 2) * 2);

  const isSceneHost =
    options.mode === "scene_host" &&
    Boolean(options.backdropVideoPath && fs.existsSync(options.backdropVideoPath));

  const filesHash = hashCompositionFilesExcludingBridgeData(options.absCompDir);
  const usage = analyzeCompositionDataUsage(options.absCompDir, options.entryHtml, options.props);
  const dataJsonPath = path.join(options.absCompDir, "assets/cuthol-data.json");
  let parsedBridge: Partial<CutholBridgeV1> | null = null;
  if (fs.existsSync(dataJsonPath)) {
    try {
      parsedBridge = JSON.parse(fs.readFileSync(dataJsonPath, "utf8")) as Partial<CutholBridgeV1>;
    } catch {
      parsedBridge = null;
    }
  }
  const { usedSliceHash, usedGlobalHash } = computeUsedBridgePayloadHashes(parsedBridge, usage);
  const propsHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(options.props ?? {}))
    .digest("hex")
    .slice(0, 16);

  const effectiveDirHash = crypto
    .createHash("sha256")
    .update(`files:${filesHash}\nslice:${usedSliceHash}\nglobal:${usedGlobalHash}\n`)
    .digest("hex");

  const legacyDirHash = hashDirectoryRecursive(options.absCompDir);

  let validLegacyDirHashes: string[] = [];
  let lastDataChangeReason: "slice_changed" | "global_used_changed" | null = null;
  const metaSidecarPath = path.join(options.absCompDir, "assets/.cuthol-bridge-meta.json");
  if (fs.existsSync(metaSidecarPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaSidecarPath, "utf8"));
      if (Array.isArray(meta.validLegacyDirHashes)) {
        validLegacyDirHashes = meta.validLegacyDirHashes;
      }
      if (
        meta.lastDataChangeReason === "slice_changed" ||
        meta.lastDataChangeReason === "global_used_changed"
      ) {
        lastDataChangeReason = meta.lastDataChangeReason;
      }
    } catch {
      // ignore
    }
  }

  let backdropDigest = "";
  let legacyBackdropDigest = "";
  const selfOccludesBackdrop =
    !options.transparent &&
    !isSceneHost &&
    compositionOccludesHtmlBackdrop(options.absCompDir, options.htmlSource);
  if (isSceneHost && options.backdropVideoPath) {
    backdropDigest = `video-sha256:${hashFileContentSha256(options.backdropVideoPath)}`;
    try {
      const st = fs.statSync(options.backdropVideoPath);
      legacyBackdropDigest = `${path.basename(options.backdropVideoPath)}:${st.size}:${st.mtimeMs}`;
    } catch {
      legacyBackdropDigest = "none";
    }
  } else if (!options.transparent && selfOccludesBackdrop) {
    backdropDigest = "self-opaque";
    if (options.backdropImagePath) {
      try {
        const st = fs.statSync(options.backdropImagePath);
        legacyBackdropDigest = `still:${path.basename(options.backdropImagePath)}:${st.size}`;
      } catch {
        legacyBackdropDigest = "still:none";
      }
    } else if (options.opaqueBackdropColor) {
      legacyBackdropDigest = `color:${options.opaqueBackdropColor.trim().toLowerCase()}`;
    }
  } else if (!options.transparent && options.backdropImagePath) {
    backdropDigest = `still-sha256:${hashFileContentSha256(options.backdropImagePath)}`;
    try {
      const st = fs.statSync(options.backdropImagePath);
      legacyBackdropDigest = `still:${path.basename(options.backdropImagePath)}:${st.size}`;
    } catch {
      legacyBackdropDigest = "still:none";
    }
  } else if (!options.transparent && options.opaqueBackdropColor) {
    backdropDigest = `color:${options.opaqueBackdropColor.trim().toLowerCase()}`;
    legacyBackdropDigest = backdropDigest;
  }

  const computeCandidateKey = (dirH: string, w: number, h: number, bd: string): string =>
    crypto
      .createHash("sha256")
      .update(dirH)
      .update(
        JSON.stringify({
          entry: options.entryHtml,
          w,
          h,
          fps: options.fps,
          dur: options.durationMs,
          props: options.props,
          transparent: options.transparent,
          mode: options.mode,
          backdropDigest: bd,
        })
      )
      .digest("hex")
      .slice(0, 16);

  // Resolution-specific cache key depending ONLY on composition files + used slice + used global data.
  const hash = computeCandidateKey(effectiveDirHash, targetWidth, targetHeight, backdropDigest);
  const nativeHash = computeCandidateKey(effectiveDirHash, nativeWidth, nativeHeight, backdropDigest);
  const legacyHash = computeCandidateKey(legacyDirHash, targetWidth, targetHeight, legacyBackdropDigest);
  const legacyNativeHash = computeCandidateKey(legacyDirHash, nativeWidth, nativeHeight, legacyBackdropDigest);

  return {
    hash,
    nativeHash,
    legacyHash,
    legacyNativeHash,
    filesHash,
    usedSliceHash,
    usedGlobalHash,
    propsHash,
    backdropDigest,
    legacyBackdropDigest,
    legacyDirHash,
    validLegacyDirHashes,
    lastDataChangeReason,
    scalarVars,
    isSceneHost,
    nativeWidth,
    nativeHeight,
    targetWidth,
    targetHeight,
    computeCandidateKey,
  };
}
