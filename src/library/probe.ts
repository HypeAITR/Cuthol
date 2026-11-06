/**
 * FFprobe Media Inspector, Library Ingestion, and Audio Detach (`src/library/probe.ts`).
 */

import fs from "node:fs";
import path from "node:path";
import { createSubprocessFailureDiagnostic, CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import {
  allocateNextHandle,
  AssetKind,
  assetPrefixForKind,
  LibraryItem,
  ProbeMetadata,
} from "../core/schema.js";
import { commitSequenceMutation, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "./ledger.js";

function parseRationalFpsExact(raw?: string | null): number | null {
  if (!raw || raw === "0/0") return null;
  const parts = raw.split("/");
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (den > 0 && Number.isFinite(num) && num > 0) {
      return num / den;
    }
    return null;
  }
  const direct = Number(raw);
  return Number.isFinite(direct) && direct > 0 ? direct : null;
}

function parseRationalFps(raw?: string): number {
  const exact = parseRationalFpsExact(raw);
  if (exact === null || exact > 240) return 30;
  return Math.round(exact * 100) / 100;
}

export function isVariableFrameRate(
  rFrameRateRaw?: string | null,
  avgFrameRateRaw?: string | null
): boolean {
  const rExact = parseRationalFpsExact(rFrameRateRaw);
  const avgExact = parseRationalFpsExact(avgFrameRateRaw);
  if (avgExact === null || avgExact <= 0) return false;
  if (rExact !== null && rExact > 240) return true;
  if (rExact !== null && Math.abs(rExact - avgExact) > Math.max(0.4, avgExact * 0.02)) {
    return true;
  }
  return false;
}

export type FfmpegColorMatrix = "bt709" | "bt601" | "bt2020" | "smpte240m" | "fcc";
export type FfmpegColorRange = "tv" | "pc";

export interface SourceColorSpec {
  isRgb: boolean;
  inMatrix: FfmpegColorMatrix;
  inRange: FfmpegColorRange;
  sourceRule: "tagged" | "heuristic_hd" | "heuristic_sd" | "rgb" | "hf_default";
  note?: string;
}

const probeMemoryCacheBySha = new Map<string, ProbeMetadata>();
const standaloneVideoColorCache = new Map<string, Partial<ProbeMetadata>>();

export function isProbeMetadataComplete(probe?: Partial<ProbeMetadata> | null): boolean {
  if (!probe || !probe.has_video) return true;
  const hasVfrField = probe.fps === 0 || probe.is_vfr !== undefined;
  const hasColorFields =
    probe.color_space !== undefined &&
    probe.color_range !== undefined &&
    probe.pix_fmt !== undefined;
  return hasVfrField && hasColorFields;
}

function normalizeColorTag(raw?: unknown): string | null {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s || s === "unknown" || s === "unspecified" || s === "reserved") return null;
  return s;
}

export function resolveSourceColorSpec(
  probe?: Partial<ProbeMetadata> | null,
  filePath?: string,
  options?: { isHyperFramesBlob?: boolean }
): SourceColorSpec {
  const cs = (probe?.color_space ?? "").toLowerCase().trim();
  const cr = (probe?.color_range ?? "").toLowerCase().trim();
  const pix = (probe?.pix_fmt ?? "").toLowerCase().trim();
  const codec = (probe?.video_codec ?? "").toLowerCase().trim();
  const ext = filePath ? path.extname(filePath).toLowerCase() : "";
  const lowerPath = filePath ? filePath.toLowerCase() : "";

  const isRgbFormat =
    cs === "gbr" ||
    cs === "rgb" ||
    /^(?:rgb|rgba|bgr|bgra|argb|abgr|gbr|pal8|ya|gray|monob|monow)/.test(pix) ||
    ["png", "bmp", "gif", "svg", "ffv1", "mjpeg"].includes(codec) ||
    [".png", ".jpg", ".jpeg", ".bmp", ".gif", ".svg"].includes(ext) ||
    lowerPath.endsWith(".pngseq") ||
    lowerPath.endsWith(".ffv1.mov");

  if (isRgbFormat) {
    return {
      isRgb: true,
      inMatrix: "bt709",
      inRange: "pc",
      sourceRule: "rgb",
    };
  }

  const inRange: FfmpegColorRange =
    cr === "pc" || cr === "full" || cr === "jpeg" || pix.startsWith("yuvj") ? "pc" : "tv";

  if (cs === "bt709") {
    return { isRgb: false, inMatrix: "bt709", inRange, sourceRule: "tagged" };
  }
  if (cs === "smpte170m" || cs === "bt470bg" || cs === "bt601" || cs === "bt470") {
    return { isRgb: false, inMatrix: "bt601", inRange, sourceRule: "tagged" };
  }
  if (cs === "bt2020nc" || cs === "bt2020c" || cs === "bt2020") {
    return {
      isRgb: false,
      inMatrix: "bt2020",
      inRange,
      sourceRule: "tagged",
      note: "Converted to BT.709 using the BT.2020 source color matrix (bt2020) (no HDR tone mapping applied).",
    };
  }
  if (cs === "smpte240m") {
    return { isRgb: false, inMatrix: "smpte240m", inRange, sourceRule: "tagged" };
  }
  if (cs === "fcc") {
    return { isRgb: false, inMatrix: "fcc", inRange, sourceRule: "tagged" };
  }

  if (options?.isHyperFramesBlob) {
    return {
      isRgb: false,
      inMatrix: "bt709",
      inRange,
      sourceRule: "hf_default",
    };
  }

  const w = probe?.width ?? 0;
  const h = probe?.height ?? 0;
  if (h >= 720 || w >= 1280) {
    return { isRgb: false, inMatrix: "bt709", inRange, sourceRule: "heuristic_hd" };
  }
  return { isRgb: false, inMatrix: "bt601", inRange, sourceRule: "heuristic_sd" };
}

export function probeStandaloneVideoColorMetadata(filePath: string): Partial<ProbeMetadata> {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) return {};
  let cacheKey = absPath;
  try {
    const st = fs.statSync(absPath);
    if (st.isDirectory()) {
      return { pix_fmt: "rgba", color_space: "gbr", color_range: "pc", video_codec: "png" };
    }
    cacheKey = `${absPath}|${st.size}|${st.mtimeMs}`;
  } catch {
    return {};
  }
  const hit = standaloneVideoColorCache.get(cacheKey);
  if (hit) return hit;

  const ffprobeArgs = [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,pix_fmt,width,height,color_space,color_range,color_transfer,color_primaries",
    "-of",
    "json",
    absPath,
  ];
  const proc = spawnWatchedSync("ffprobe", ffprobeArgs, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    step: "ffprobe color",
  });
  if (proc.status !== 0 || proc.error) {
    return {};
  }
  try {
    const parsed = JSON.parse(proc.stdout) as { streams?: Array<Record<string, unknown>> };
    const vs = parsed.streams?.[0];
    if (!vs) return {};
    const meta: Partial<ProbeMetadata> = {
      width: Number(vs.width ?? 0),
      height: Number(vs.height ?? 0),
      video_codec: vs.codec_name ? String(vs.codec_name) : null,
      pix_fmt: vs.pix_fmt ? String(vs.pix_fmt) : null,
      color_space: normalizeColorTag(vs.color_space),
      color_range: normalizeColorTag(vs.color_range),
      color_transfer: normalizeColorTag(vs.color_transfer),
      color_primaries: normalizeColorTag(vs.color_primaries),
    };
    standaloneVideoColorCache.set(cacheKey, meta);
    return meta;
  } catch {
    return {};
  }
}

export function probeLocalMediaFile(
  filePath: string,
  ledger: MediaLedger,
  knownSha256?: string
): {
  sha256: string;
  probe: ProbeMetadata;
  kind: AssetKind;
} {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    const shownUri =
      filePath !== absPath ? `${filePath} (absolute path tried: ${absPath})` : absPath;
    throw new CutholError(DIAGNOSTICS.MISSING_FILE_ON_DISK("ingest", shownUri));
  }

  let sha256: string;
  let sizeBytes: number;
  if (knownSha256) {
    sha256 = knownSha256;
    sizeBytes = fs.statSync(absPath).size;
  } else {
    const resolved = ledger.resolveFileSha256(absPath);
    sha256 = resolved.sha256;
    sizeBytes = resolved.sizeBytes;
  }

  const memCached = probeMemoryCacheBySha.get(sha256);
  if (memCached && isProbeMetadataComplete(memCached)) {
    return {
      sha256,
      probe: memCached,
      kind: inferAssetKind(absPath, memCached),
    };
  }

  const cached = ledger.getProbe<ProbeMetadata>(sha256);
  if (cached && isProbeMetadataComplete(cached)) {
    probeMemoryCacheBySha.set(sha256, cached);
    return {
      sha256,
      probe: cached,
      kind: inferAssetKind(absPath, cached),
    };
  }

  const ffprobeArgs = ["-v", "error", "-show_format", "-show_streams", "-of", "json", absPath];
  const proc = spawnWatchedSync("ffprobe", ffprobeArgs, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    step: "ffprobe",
  });

  if (proc.status !== 0 || proc.error) {
    throw new CutholError(
      createSubprocessFailureDiagnostic({
        tool: "ffprobe",
        executable: "ffprobe",
        args: ffprobeArgs,
        proc,
        fallbackDetail: (proc.stderr || proc.stdout || "unknown error").trim(),
      })
    );
  }

  const parsed = JSON.parse(proc.stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");

  const formatDurationSec = Number(parsed.format?.duration ?? videoStream?.duration ?? audioStream?.duration ?? 0);
  const duration_ms = Math.max(0, Math.round(formatDurationSec * 1000));

  const width = Number(videoStream?.width ?? 0);
  const height = Number(videoStream?.height ?? 0);
  const rawAvgRate = videoStream?.avg_frame_rate ? String(videoStream.avg_frame_rate) : null;
  const rawRRate = videoStream?.r_frame_rate ? String(videoStream.r_frame_rate) : null;
  const fps = videoStream
    ? parseRationalFps(
        rawAvgRate && rawAvgRate !== "0/0" ? rawAvgRate : (rawRRate ?? "30/1")
      )
    : 0;

  const ext = path.extname(absPath).toLowerCase();
  const codecName = String(videoStream?.codec_name ?? "").toLowerCase();
  const nbFrames = Number(videoStream?.nb_frames ?? 0);
  const formatName = String(parsed.format?.format_name ?? "").toLowerCase();

  const staticImageExts = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".svg"];
  const isStaticImageExt = staticImageExts.includes(ext);
  const isSingleFrameGif = ext === ".gif" && (nbFrames === 1 || (nbFrames === 0 && duration_ms <= 100));
  const isImage2Demuxer = formatName.includes("image2") || formatName.endsWith("_pipe");

  const isStillImage =
    Boolean(videoStream) &&
    !audioStream &&
    (isStaticImageExt ||
      isSingleFrameGif ||
      isImage2Demuxer ||
      (duration_ms === 0 && nbFrames <= 1 && ["png", "mjpeg", "webp", "bmp", "gif"].includes(codecName)));

  const isVfr =
    Boolean(videoStream) && !isStillImage ? isVariableFrameRate(rawRRate, rawAvgRate) : false;

  const rawPixFmt = videoStream?.pix_fmt ? String(videoStream.pix_fmt) : null;
  const rawColorSpace = normalizeColorTag(videoStream?.color_space);
  const rawColorRange = normalizeColorTag(videoStream?.color_range);
  const rawColorTransfer = normalizeColorTag(videoStream?.color_transfer);
  const rawColorPrimaries = normalizeColorTag(videoStream?.color_primaries);

  const probe: ProbeMetadata = {
    duration_ms: isStillImage ? 5000 : duration_ms,
    width,
    height,
    fps: isStillImage ? 0 : fps,
    ...(videoStream && !isStillImage
      ? {
          is_vfr: isVfr,
          r_frame_rate: rawRRate,
          avg_frame_rate: rawAvgRate,
        }
      : {}),
    ...(videoStream
      ? {
          pix_fmt: rawPixFmt,
          color_space: rawColorSpace,
          color_range: rawColorRange,
          color_transfer: rawColorTransfer,
          color_primaries: rawColorPrimaries,
        }
      : {}),
    has_video: Boolean(videoStream),
    has_audio: Boolean(audioStream),
    video_codec: videoStream ? String(videoStream.codec_name ?? null) : null,
    audio_codec: audioStream ? String(audioStream.codec_name ?? null) : null,
    sample_rate: audioStream ? Number(audioStream.sample_rate ?? 48000) : null,
    channels: audioStream ? Number(audioStream.channels ?? 2) : null,
    size_bytes: sizeBytes,
  };

  ledger.setProbe(sha256, probe);
  probeMemoryCacheBySha.set(sha256, probe);
  return {
    sha256,
    probe,
    kind: inferAssetKind(absPath, probe),
  };
}

export function ensureLibraryItemVideoProbe(
  item: LibraryItem,
  rootDir: string,
  ledger?: MediaLedger | null
): ProbeMetadata {
  if (!item.probe.has_video || isProbeMetadataComplete(item.probe)) {
    return item.probe;
  }

  const applyRefreshedFields = (src: Partial<ProbeMetadata>) => {
    if (item.probe.fps > 0 && item.probe.is_vfr === undefined) {
      if (src.is_vfr !== undefined) item.probe.is_vfr = src.is_vfr;
      if (src.r_frame_rate !== undefined) item.probe.r_frame_rate = src.r_frame_rate;
      if (src.avg_frame_rate !== undefined) item.probe.avg_frame_rate = src.avg_frame_rate;
    }
    if (src.pix_fmt !== undefined) item.probe.pix_fmt = src.pix_fmt;
    if (src.color_space !== undefined) item.probe.color_space = src.color_space;
    if (src.color_range !== undefined) item.probe.color_range = src.color_range;
    if (src.color_transfer !== undefined) item.probe.color_transfer = src.color_transfer;
    if (src.color_primaries !== undefined) item.probe.color_primaries = src.color_primaries;
  };

  if (item.digest_sha256) {
    const mem = probeMemoryCacheBySha.get(item.digest_sha256);
    if (mem && isProbeMetadataComplete(mem)) {
      applyRefreshedFields(mem);
      return item.probe;
    }
    if (ledger) {
      const fromLedger = ledger.getProbe<ProbeMetadata>(item.digest_sha256);
      if (fromLedger && isProbeMetadataComplete(fromLedger)) {
        probeMemoryCacheBySha.set(item.digest_sha256, fromLedger);
        applyRefreshedFields(fromLedger);
        return item.probe;
      }
    }
  }

  if (
    item.probe.fps > 0 &&
    item.probe.is_vfr === undefined &&
    (item.probe.r_frame_rate || item.probe.avg_frame_rate)
  ) {
    item.probe.is_vfr = isVariableFrameRate(item.probe.r_frame_rate, item.probe.avg_frame_rate);
  }

  const absPath = resolveLibraryItemPath(rootDir, item);
  if (!fs.existsSync(absPath)) {
    return item.probe;
  }

  try {
    if (ledger) {
      const refreshed = probeLocalMediaFile(absPath, ledger, item.digest_sha256 || undefined).probe;
      applyRefreshedFields(refreshed);
    } else {
      const colorMeta = probeStandaloneVideoColorMetadata(absPath);
      applyRefreshedFields(colorMeta);
    }
  } catch {
    // ignore probe failure on missing/corrupt external file
  }
  return item.probe;
}

function inferAssetKind(filePath: string, probe: ProbeMetadata): AssetKind {
  const ext = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".svg"].includes(ext)) {
    return "graphic";
  }
  if (probe.has_video && probe.fps > 0) {
    return "footage";
  }
  if (probe.has_audio && !probe.has_video) {
    return "audio";
  }
  return probe.has_video ? "graphic" : "audio";
}

export function ingestAssetsIntoWorkspace(options: {
  workspaceDir: string;
  filePaths: string[];
  explicitHandle?: string;
  explicitKind?: AssetKind;
}): LibraryItem[] {
  const { paths } = loadSequence(options.workspaceDir);
  const ledger = new MediaLedger(paths.ledgerFile);

  try {
    const { result } = commitSequenceMutation(options.workspaceDir, "library.ingest", (seq) => {
      const added: LibraryItem[] = [];

      for (let i = 0; i < options.filePaths.length; i++) {
        const rawFile = options.filePaths[i];
        const absFile = path.resolve(rawFile);
        if (!fs.existsSync(absFile)) {
          const shownUri =
            rawFile !== absFile ? `${rawFile} (absolute path tried: ${absFile})` : absFile;
          const diag = DIAGNOSTICS.MISSING_FILE_ON_DISK("ingest", shownUri);
          const candidateInWorkspace = path.resolve(paths.rootDir, rawFile);
          if (!path.isAbsolute(rawFile) && candidateInWorkspace !== absFile) {
            diag.suggestion = `The CLI resolves relative paths against the working directory (${process.cwd()}), not the project folder. Fix the file path (e.g. '${candidateInWorkspace}') or pass the right path with 'cuthol library ingest'.`;
            diag.formatted = `[${diag.code}] ${diag.what} | Suggestion: ${diag.suggestion}`;
          }
          throw new CutholError(diag);
        }
        const { sha256, probe, kind: detectedKind } = probeLocalMediaFile(absFile, ledger);
        const kind = options.explicitKind ?? detectedKind;

        const requestedHandle = i === 0 ? options.explicitHandle : undefined;

        // If already in library by sha256 (with matching kind if explicit) and either no explicit handle
        // or the same explicit handle is requested, return existing idempotently
        const existing = seq.library.find(
          (item) => item.digest_sha256 === sha256 && (!options.explicitKind || item.kind === kind)
        );
        if (existing && (!requestedHandle || existing.handle === requestedHandle)) {
          if (existing.probe.has_video && !isProbeMetadataComplete(existing.probe)) {
            existing.probe = probe;
          }
          added.push(existing);
          continue;
        }

        const existingHandles = seq.library.map((item) => item.handle);
        const handle = requestedHandle ?? allocateNextHandle(existingHandles, assetPrefixForKind(kind));

        if (existingHandles.includes(handle)) {
          throw new CutholError(DIAGNOSTICS.DUPLICATE_HANDLE(handle));
        }

        const relUri = path.relative(paths.rootDir, absFile).replace(/\\/g, "/");
        const uri = relUri.startsWith("..") ? absFile.replace(/\\/g, "/") : relUri;

        const newItem: LibraryItem = {
          handle,
          kind,
          uri,
          digest_sha256: sha256,
          probe,
          analysis_refs: {},
        };

        seq.library.push(newItem);
        added.push(newItem);
      }

      return added;
    });

    return result;
  } finally {
    ledger.close();
  }
}

export function resolveLibraryItemPath(rootDir: string, item: LibraryItem): string {
  return path.isAbsolute(item.uri) ? item.uri : path.resolve(rootDir, item.uri);
}

/**
 * Extracts the audio stream of a video asset into a standalone `.wav` asset in `.cuthol/blobs/`
 * and registers it in the sequence library (`cuthol library detach-audio`).
 */
export function detachAudioFromLibraryAsset(options: {
  workspaceDir: string;
  sourceHandle: string;
  targetHandle?: string;
}): LibraryItem {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const srcItem = sequence.library.find((item) => item.handle === options.sourceHandle);
  if (!srcItem) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.sourceHandle));
  }
  if (!srcItem.probe.has_audio) {
    throw new CutholError(DIAGNOSTICS.NO_AUDIO_STREAM(options.sourceHandle));
  }

  const srcAbsPath = resolveLibraryItemPath(paths.rootDir, srcItem);
  const outWavPath = path.join(paths.blobsDir, `detached_${srcItem.handle}_${srcItem.digest_sha256.slice(0, 12)}.wav`);

  if (!fs.existsSync(outWavPath)) {
    const detachArgs = ["-y", "-v", "error", "-i", srcAbsPath, "-vn", "-acodec", "pcm_s16le", "-ar", "48000", "-ac", "2", outWavPath];
    const proc = spawnWatchedSync("ffmpeg", detachArgs, {
      encoding: "utf8",
      step: "ffmpeg detach audio",
      watchedPaths: [outWavPath],
      cleanupPathsOnStall: [outWavPath],
    });
    if (proc.status !== 0 || proc.error) {
      throw new CutholError(
        createSubprocessFailureDiagnostic({
          tool: "ffmpeg detach audio",
          executable: "ffmpeg",
          args: detachArgs,
          proc,
          fallbackDetail: (proc.stderr || proc.stdout || "audio detach failed").trim(),
        })
      );
    }
  }

  const ingested = ingestAssetsIntoWorkspace({
    workspaceDir: options.workspaceDir,
    filePaths: [outWavPath],
    explicitHandle: options.targetHandle,
    explicitKind: "audio",
  });

  return ingested[0];
}
