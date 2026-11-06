// Extension media providers: searchable music/sfx sources (`library search` + `library fetch`).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { LibraryItem, MediaSourceRef } from "../core/schema.js";
import { commitSequenceMutation, loadSequence } from "../core/workspace.js";
import { ExtensionScope } from "../extensions/ext_manifest.js";
import {
  collectProviderEnv,
  resolveExtensionProvider,
  runExtensionProviderScript,
} from "../extensions/ext_providers.js";
import { extensionNameOf, parseMediaProviderId } from "../speech/provider_select.js";
import { ingestAssetsIntoWorkspace } from "./probe.js";

export type MediaSourceKind = "music" | "sfx";

export interface MediaCandidate {
  id: string;
  title: string;
  duration_ms: number | null;
  preview_url: string | null;
  license: string | null;
  source_url: string | null;
  tags: string[];
}

function assertSearchArgs(kind: string, minMs: number | null, maxMs: number | null): MediaSourceKind {
  if (kind !== "music" && kind !== "sfx") {
    throw new CutholError(
      DIAGNOSTICS.UNKNOWN_FLAG(
        `--kind ${kind}`,
        "library.search",
        'cuthol library search --provider ext:<name> --kind music|sfx --query "<text>"'
      )
    );
  }
  if (
    (minMs !== null && (!Number.isFinite(minMs) || minMs < 0)) ||
    (maxMs !== null && (!Number.isFinite(maxMs) || maxMs < 0)) ||
    (minMs !== null && maxMs !== null && minMs > maxMs)
  ) {
    throw new CutholError(
      DIAGNOSTICS.UNKNOWN_FLAG(
        `--min/--max ${String(minMs)}..${String(maxMs)}`,
        "library.search",
        'cuthol library search --provider ext:<name> --kind music|sfx --query "<text>" --min 10s --max 60s'
      )
    );
  }
  return kind;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validateCandidates(extName: string, response: unknown): MediaCandidate[] {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_BAD_OUTPUT(extName, "media", "expected the response to be a JSON object.")
    );
  }
  const obj = response as Record<string, unknown>;
  if (!Array.isArray(obj.candidates)) {
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_BAD_OUTPUT(extName, "media", "expected 'candidates' to be an array.")
    );
  }
  return obj.candidates.map((entry, i) => {
    const label = `'candidates[${i}]'`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new CutholError(
        DIAGNOSTICS.PROVIDER_BAD_OUTPUT(extName, "media", `expected ${label} to be an object.`)
      );
    }
    const cand = entry as Record<string, unknown>;
    if (typeof cand.id !== "string" || !cand.id.trim()) {
      throw new CutholError(
        DIAGNOSTICS.PROVIDER_BAD_OUTPUT(extName, "media", `expected ${label} to have a non-empty 'id'.`)
      );
    }
    let durationMs: number | null = null;
    if (cand.duration_ms !== undefined && cand.duration_ms !== null) {
      const n = Number(cand.duration_ms);
      if (!Number.isFinite(n) || n < 0) {
        throw new CutholError(
          DIAGNOSTICS.PROVIDER_BAD_OUTPUT(
            extName,
            "media",
            `expected ${label} 'duration_ms' to be a number >= 0.`
          )
        );
      }
      durationMs = Math.round(n);
    }
    const tags = Array.isArray(cand.tags)
      ? cand.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean)
      : [];
    return {
      id: (cand.id as string).trim(),
      title: asNullableString(cand.title) ?? (cand.id as string).trim(),
      duration_ms: durationMs,
      preview_url: asNullableString(cand.preview_url),
      license: asNullableString(cand.license),
      source_url: asNullableString(cand.source_url),
      tags,
    };
  });
}

export interface MediaSearchResult {
  provider: string;
  kind: MediaSourceKind;
  query: string;
  count: number;
  candidates: MediaCandidate[];
}

export function searchMediaSource(options: {
  workspaceDir: string;
  provider: string;
  kind: string;
  query: string;
  minDurationMs?: number | null;
  maxDurationMs?: number | null;
  limit?: number;
  scope?: ExtensionScope;
}): MediaSearchResult {
  const providerId = parseMediaProviderId(options.provider);
  const extName = extensionNameOf(providerId) as string;
  const minMs = options.minDurationMs ?? null;
  const maxMs = options.maxDurationMs ?? null;
  const kind = assertSearchArgs(options.kind, minMs, maxMs);
  const limit =
    options.limit !== undefined && Number.isFinite(options.limit)
      ? Math.max(1, Math.min(100, Math.floor(options.limit)))
      : 20;

  const provider = resolveExtensionProvider({
    extensionName: extName,
    kind: "media",
    workspaceDir: options.workspaceDir,
    scope: options.scope,
  });
  const secrets = collectProviderEnv({
    workspaceDir: options.workspaceDir,
    extensionName: provider.extension.name,
    kind: "media",
    declared: provider.spec.env,
  });

  const { response } = runExtensionProviderScript({
    provider,
    workspaceDir: options.workspaceDir,
    operation: "search",
    request: {
      contract: "cuthol.provider.media/1",
      operation: "search",
      extension: provider.extension.name,
      version: provider.extension.version,
      kind,
      query: options.query,
      min_duration_ms: minMs,
      max_duration_ms: maxMs,
      limit,
      config: provider.spec.config ?? {},
    },
    secrets,
  });

  let candidates = validateCandidates(provider.extension.name, response);
  // Re-apply range/limit in Cuthol so a misbehaving script cannot return
  // out-of-range results (candidates with unknown duration are kept).
  candidates = candidates.filter((c) => {
    if (c.duration_ms === null) return true;
    if (minMs !== null && c.duration_ms < minMs) return false;
    if (maxMs !== null && c.duration_ms > maxMs) return false;
    return true;
  });
  candidates = candidates.slice(0, limit);
  return { provider: providerId, kind, query: options.query, count: candidates.length, candidates };
}

function sanitizeFileToken(raw: string, maxLen: number): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "media").slice(0, maxLen);
}

function safeAudioExt(filename: unknown): string {
  if (typeof filename === "string") {
    const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
    const m = /\.([A-Za-z0-9]{2,5})$/.exec(base);
    if (m) {
      const ext = m[1].toLowerCase();
      if (["wav", "mp3", "flac", "ogg", "oga", "m4a", "aac", "opus", "aiff", "wma"].includes(ext)) {
        return `.${ext}`;
      }
    }
  }
  return ".wav";
}

function sha256FileShort(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex").slice(0, 12);
}

export interface MediaFetchResult {
  provider: string;
  asset: LibraryItem;
  source: MediaSourceRef;
  cached: boolean;
}

export function fetchMediaSource(options: {
  workspaceDir: string;
  provider: string;
  id: string;
  scope?: ExtensionScope;
}): MediaFetchResult {
  const providerId = parseMediaProviderId(options.provider);
  const extName = extensionNameOf(providerId) as string;
  const candidateId = options.id.trim();
  if (!candidateId) {
    throw new CutholError(
      DIAGNOSTICS.UNKNOWN_FLAG(
        "--id (missing value)",
        "library.fetch",
        "cuthol library fetch --provider ext:<name> --id <candidate>"
      )
    );
  }

  const provider = resolveExtensionProvider({
    extensionName: extName,
    kind: "media",
    workspaceDir: options.workspaceDir,
    scope: options.scope,
  });
  const secrets = collectProviderEnv({
    workspaceDir: options.workspaceDir,
    extensionName: provider.extension.name,
    kind: "media",
    declared: provider.spec.env,
  });

  const { paths: fetchPaths } = loadSequence(options.workspaceDir);
  fs.mkdirSync(fetchPaths.blobsDir, { recursive: true });
  const stagePath = path.join(
    fetchPaths.blobsDir,
    `media_stage_${sanitizeFileToken(extName, 24)}_${sanitizeFileToken(candidateId, 32)}_${process.pid}.bin`
  );
  const { response, audioOutputPath } = runExtensionProviderScript({
    provider,
    workspaceDir: options.workspaceDir,
    operation: "fetch",
    request: {
      contract: "cuthol.provider.media/1",
      operation: "fetch",
      extension: provider.extension.name,
      version: provider.extension.version,
      id: candidateId,
      config: provider.spec.config ?? {},
    },
    needsAudioOutput: true,
    audioOutputExt: ".wav",
    persistAudioTo: stagePath,
    secrets,
  });

  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_BAD_OUTPUT(
        provider.extension.name,
        "media",
        "expected the fetch response to be a JSON object."
      )
    );
  }
  const obj = response as Record<string, unknown>;
  if (obj.found === false || obj.error === "not_found") {
    throw new CutholError(DIAGNOSTICS.MEDIA_FETCH_NOT_FOUND(provider.extension.name, candidateId));
  }
  if (!audioOutputPath) {
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_EXECUTION_FAILED(
        provider.extension.name,
        "media",
        "The script did not produce the expected audio file."
      )
    );
  }

  const { paths } = loadSequence(options.workspaceDir);
  const stagedAudio = audioOutputPath as string;
  const ext = safeAudioExt(obj.filename);
  const contentHash = sha256FileShort(stagedAudio);
  const finalPath = path.join(
    paths.blobsDir,
    `media_${sanitizeFileToken(extName, 24)}_${sanitizeFileToken(candidateId, 32)}_${contentHash}${ext}`
  );
  fs.mkdirSync(paths.blobsDir, { recursive: true });
  if (fs.existsSync(finalPath)) {
    try {
      fs.unlinkSync(stagedAudio);
    } catch {
      // ignore staging cleanup failure
    }
  } else {
    fs.renameSync(stagedAudio, finalPath);
  }

  const fileSha256 = crypto.createHash("sha256").update(fs.readFileSync(finalPath)).digest("hex");
  const current = loadSequence(options.workspaceDir).sequence;
  const alreadyThere = current.library.find(
    (item) =>
      item.digest_sha256 === fileSha256 &&
      item.source?.provider === providerId &&
      item.source?.id === candidateId
  );
  if (alreadyThere?.source) {
    return { provider: providerId, asset: alreadyThere, source: alreadyThere.source, cached: true };
  }

  // Normal ingest path: probe, ledger, `aud_XX` handle.
  const [ingested] = ingestAssetsIntoWorkspace({ workspaceDir: options.workspaceDir, filePaths: [finalPath] });

  const source: MediaSourceRef = {
    provider: providerId,
    id: candidateId,
    ...(asNullableString(obj.title) ? { title: asNullableString(obj.title) as string } : {}),
    ...(asNullableString(obj.license) ? { license: asNullableString(obj.license) as string } : {}),
    ...(asNullableString(obj.source_url)
      ? { source_url: asNullableString(obj.source_url) as string }
      : {}),
    fetched_at: new Date().toISOString(),
  };
  const { result: asset } = commitSequenceMutation(
    options.workspaceDir,
    `library.fetch(${providerId}:${candidateId})`,
    (seq) => {
      const target = seq.library.find((item) => item.handle === ingested.handle);
      if (!target) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(ingested.handle));
      }
      target.source = source;
      return target;
    }
  );
  return { provider: providerId, asset, source, cached: false };
}
