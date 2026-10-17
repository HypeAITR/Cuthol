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

export function probeLocalMediaFile(filePath: string, ledger: MediaLedger): {
  sha256: string;
  probe: ProbeMetadata;
  kind: AssetKind;
} {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    const shownUri =
      filePath !== absPath ? `${filePath} (denenen mutlak yol: ${absPath})` : absPath;
    throw new CutholError(DIAGNOSTICS.MISSING_FILE_ON_DISK("ingest", shownUri));
  }

  const { sha256, sizeBytes } = ledger.resolveFileSha256(absPath);
  const cached = ledger.getProbe<ProbeMetadata>(sha256);
  if (cached && (!cached.has_video || cached.fps === 0 || cached.is_vfr !== undefined)) {
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
    has_video: Boolean(videoStream),
    has_audio: Boolean(audioStream),
    video_codec: videoStream ? String(videoStream.codec_name ?? null) : null,
    audio_codec: audioStream ? String(audioStream.codec_name ?? null) : null,
    sample_rate: audioStream ? Number(audioStream.sample_rate ?? 48000) : null,
    channels: audioStream ? Number(audioStream.channels ?? 2) : null,
    size_bytes: sizeBytes,
  };

  ledger.setProbe(sha256, probe);
  return {
    sha256,
    probe,
    kind: inferAssetKind(absPath, probe),
  };
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
            rawFile !== absFile ? `${rawFile} (denenen mutlak yol: ${absFile})` : absFile;
          const diag = DIAGNOSTICS.MISSING_FILE_ON_DISK("ingest", shownUri);
          const candidateInWorkspace = path.resolve(paths.rootDir, rawFile);
          if (!path.isAbsolute(rawFile) && candidateInWorkspace !== absFile) {
            diag.suggestion = `CLI göreli yolları çalışma dizinine (${process.cwd()}) göre çözer; proje klasörüne göre değil. Dosya yolunu düzeltin (ör. '${candidateInWorkspace}') veya 'cuthol library ingest' ile doğru yolu verin.`;
            diag.formatted = `[${diag.code}] ${diag.what} | Öneri: ${diag.suggestion}`;
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
          if (existing.probe.has_video && existing.probe.fps > 0 && existing.probe.is_vfr === undefined) {
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
