// CLI 'library' command group handler (split out of cli.ts).
import { analyzeAssetBeats } from "./library/beats.js";
import { analyzeAssetLoudness } from "./library/loudness.js";
import { detachAudioFromLibraryAsset, ingestAssetsIntoWorkspace } from "./library/probe.js";
import {
  formatBeatsDigest,
  formatScenesDigest,
  formatWaveformDigest,
  QueryableMediaKind,
  queryLibraryAnalysis,
} from "./library/query.js";
import { analyzeAssetScenes } from "./library/scenes.js";
import { analyzeAssetSubjectTrack, formatSubjectTrackDigest } from "./library/subject.js";
import { analyzeAssetWaveform } from "./library/waveform.js";
import { DIAGNOSTICS } from "./core/diagnostics.js";
import { parseTimeMs } from "./core/time.js";
import { loadSequence } from "./core/workspace.js";
import { fetchMediaSource, searchMediaSource } from "./library/media_source.js";
import { numFlag, strFlag } from "./cli_args.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";

function readQueryAssetSource(workspaceDir: string, handle: string): Record<string, unknown> {
  try {
    const { sequence } = loadSequence(workspaceDir);
    const item = sequence.library.find((x) => x.handle === handle);
    if (item?.source) {
      return { asset_source: item.source };
    }
  } catch {
    // Never fail a query because the source lookup failed.
  }
  return {};
}

export function runLibraryCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, rest, flags, workspaceDir, formatFlag } = ctx;
  if (action === "ingest") {
    const files = rest.length > 0 ? rest : strFlag(flags, "file") ? [strFlag(flags, "file")!] : [];
    if (files.length === 0) {
      throw new Error("Provide at least one file path to 'cuthol library ingest <path...>'.");
    }
    const explicitHandle = strFlag(flags, "handle");
    const items = ingestAssetsIntoWorkspace({
      workspaceDir,
      filePaths: files,
      explicitHandle,
    });
    emitEnvelopeJson(workspaceDir, "library.ingest", {
      action: "library.ingest",
      ingested: items,
    });
    return;
  }

  if (action === "loudness") {
    const handle = strFlag(flags, "handle") ?? rest[0];
    if (!handle) throw new Error("Provide --handle <vid_XX|aud_XX>.");
    const targetLufs = numFlag(flags, "target-lufs");
    const metrics = analyzeAssetLoudness({ workspaceDir, handle, targetLufs });
    emitEnvelopeJson(workspaceDir, "library.loudness", {
      action: "library.loudness",
      metrics,
    });
    return;
  }

  if (action === "waveform") {
    const handle = strFlag(flags, "handle") ?? rest[0];
    if (!handle) throw new Error("Provide --handle <vid_XX|aud_XX>.");
    const bins = numFlag(flags, "bins", 160);
    const pngOutPath = strFlag(flags, "png");
    const res = analyzeAssetWaveform({ workspaceDir, handle, bins, pngOutPath });
    const payload =
      flags["full-bins"] || flags["verbose"]
        ? { action: "library.waveform", result: res }
        : { action: "library.waveform", ...formatWaveformDigest(res) };
    emitEnvelopeJson(workspaceDir, "library.waveform", payload);
    return;
  }

  if (action === "beats") {
    const handle = strFlag(flags, "handle") ?? rest[0];
    if (!handle) throw new Error("Provide --handle <aud_XX|vid_XX>.");
    const sensitivity = numFlag(flags, "sensitivity", 1.35);
    const res = analyzeAssetBeats({ workspaceDir, handle, sensitivity });
    const payload = flags["verbose"]
      ? { action: "library.beats", result: res }
      : { action: "library.beats", ...formatBeatsDigest(res) };
    emitEnvelopeJson(workspaceDir, "library.beats", payload);
    return;
  }

  if (action === "scenes") {
    const handle = strFlag(flags, "handle") ?? rest[0];
    if (!handle) throw new Error("Provide --handle <vid_XX>.");
    const threshold = numFlag(flags, "threshold");
    const res = analyzeAssetScenes({ workspaceDir, handle, threshold });
    const payload = flags["verbose"]
      ? { action: "library.scenes", result: res }
      : { action: "library.scenes", ...formatScenesDigest(res) };
    emitEnvelopeJson(workspaceDir, "library.scenes", payload);
    return;
  }

  if (action === "detach-audio") {
    const sourceHandle = strFlag(flags, "handle") ?? rest[0];
    if (!sourceHandle) throw new Error("Provide --handle <vid_XX>.");
    const targetHandle = strFlag(flags, "target-handle");
    const item = detachAudioFromLibraryAsset({ workspaceDir, sourceHandle, targetHandle });
    emitEnvelopeJson(workspaceDir, "library.detach-audio", {
      action: "library.detach-audio",
      item,
    });
    return;
  }

  if (action === "query") {
    const handle = strFlag(flags, "handle") ?? rest[0];
    if (!handle) throw new Error("Provide --handle <vid_XX|aud_XX|ln_captions>.");
    const qFormat =
      formatFlag === "compact"
        ? "compact"
        : formatFlag === "default"
          ? "default"
          : undefined;
    const qRes = queryLibraryAnalysis({
      workspaceDir,
      handle,
      kind: strFlag(flags, "kind") as QueryableMediaKind | undefined,
      format: qFormat,
      range: strFlag(flags, "range"),
      text: strFlag(flags, "text"),
      limit: numFlag(flags, "limit"),
      cursor: strFlag(flags, "cursor"),
      maxTokens: numFlag(flags, "max-tokens"),
    });
    const pageWarning =
      qRes.truncated_by === "max_tokens"
        ? DIAGNOSTICS.QUERY_PAGE_TOKEN_TRUNCATED(qRes.returned, qRes.next_cursor ?? "")
        : null;
    emitEnvelopeJson(workspaceDir, "library.query", {
      action: "library.query",
      ...qRes,
      ...readQueryAssetSource(workspaceDir, handle),
      ...(pageWarning ? { diagnostics: [pageWarning] } : {}),
    });
    return;
  }

  if (action === "search") {
    const provider = strFlag(flags, "provider");
    if (!provider) throw new Error("Provide --provider ext:<name>.");
    const kind = strFlag(flags, "kind");
    if (!kind) throw new Error("Provide --kind music|sfx.");
    const query = strFlag(flags, "query");
    if (!query) throw new Error('Provide --query "<text>".');
    const minRaw = strFlag(flags, "min");
    const maxRaw = strFlag(flags, "max");
    const res = searchMediaSource({
      workspaceDir,
      provider,
      kind,
      query,
      minDurationMs: minRaw ? parseTimeMs(minRaw) : null,
      maxDurationMs: maxRaw ? parseTimeMs(maxRaw) : null,
      limit: numFlag(flags, "limit"),
    });
    emitEnvelopeJson(workspaceDir, "library.search", {
      action: "library.search",
      ...res,
    });
    return;
  }

  if (action === "fetch") {
    const provider = strFlag(flags, "provider");
    if (!provider) throw new Error("Provide --provider ext:<name>.");
    const id = strFlag(flags, "id");
    if (!id) throw new Error("Provide --id <candidate>.");
    const res = fetchMediaSource({ workspaceDir, provider, id });
    emitEnvelopeJson(workspaceDir, "library.fetch", {
      action: "library.fetch",
      ...res,
    });
    return;
  }

  if (action === "subject") {
    const handle = strFlag(flags, "handle") ?? rest[0];
    if (!handle) throw new Error("Provide --handle <vid_XX>.");
    const res = analyzeAssetSubjectTrack({
      workspaceDir,
      handle,
      sampleFps: numFlag(flags, "fps"),
    });
    const payload = flags["verbose"]
      ? { action: "library.subject", result: res }
      : { action: "library.subject", ...formatSubjectTrackDigest(res) };
    emitEnvelopeJson(workspaceDir, "library.subject", payload);
    return;
  }
  return CLI_NOT_HANDLED;
}
