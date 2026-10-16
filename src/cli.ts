#!/usr/bin/env node
/**
 * Cuthol CLI Entry Point (`src/cli.ts`).
 *
 * Agent-native command surface for workspace management, media library ingestion,
 * signal/scene analysis, spine & lane editing, declarative cue sheets,
 * 5-gate verification, and multi-lens sequence inspection.
 */

import fs from "node:fs";
import path from "node:path";
import { BriefLens, renderSequenceBrief } from "./brief/inspector.js";
import { syncAllCompositionBridges } from "./compositor/bridge_exporter.js";
import { RenderPreset } from "./compositor/compiler.js";
import { previewAndCheckComposition } from "./compositor/composition_preview.js";
import {
  HyperFramesPresetKind,
  scaffoldHyperFramesComposition,
  validateHyperFramesCompositionContract,
} from "./compositor/hyperframes_bridge.js";
import { CutholError, DIAGNOSTICS, VerificationGateId } from "./core/diagnostics.js";
import { loadDotEnvIfNeeded } from "./core/env.js";
import {
  AspectPreset,
  HyperFramesCompositeMode,
  LaneKind,
  ParameterEnvelope,
  ParameterEnvelopePoint,
  SpatialPlacement,
  TransitionSpec,
} from "./core/schema.js";
import { parseTimeMs } from "./core/time.js";
import {
  buildWorkspaceEnvelopeHeader,
  initWorkspace,
  loadJournalManifest,
  loadSequence,
  setLaneLockStatus,
  stepJournal,
  tagCurrentRevision,
} from "./core/workspace.js";
import { analyzeAssetBeats } from "./library/beats.js";
import { analyzeAssetLoudness } from "./library/loudness.js";
import { detachAudioFromLibraryAsset, ingestAssetsIntoWorkspace } from "./library/probe.js";
import {
  formatBeatsDigest,
  formatCaptionsDigest,
  formatScenesDigest,
  formatTranscribeDigest,
  formatWaveformDigest,
  QueryableMediaKind,
  queryLibraryAnalysis,
} from "./library/query.js";
import { analyzeAssetScenes } from "./library/scenes.js";
import { analyzeAssetSubjectTrack, formatSubjectTrackDigest } from "./library/subject.js";
import { analyzeAssetWaveform } from "./library/waveform.js";
import {
  CUTHOL_MCP_TOOLS,
  formatEnvelopeCompact,
  readWorkspaceRevision,
  resolveActionSpecForCommand,
  startMcpStdioServer,
} from "./mcp/server.js";
import {
  alignClipsToBeats,
  duckMusicUnderDialogue,
  normalizeSequenceAudio,
  polishVoiceAudio,
} from "./mix/audio_mix.js";
import { captureMonitorFrame, captureMonitorSheet } from "./monitor/preview.js";
import { captureMonitorTimeline } from "./monitor/timeline_view.js";
import { renderSequenceToMp4 } from "./render/renderer.js";
import {
  applyCueSheet,
  CutholCueSheet,
  exportSequenceToCueSheet,
  mergeCueSheetIntoSequence,
  planCueSheet,
} from "./sequence/cuesheet.js";
import { addLaneCue, removeLaneCues, updateLaneCue } from "./sequence/lanes.js";
import {
  appendSpineClip,
  exciseSpineRanges,
  reframeSpineClips,
  removeSpineClips,
  reorderSpineClip,
  setItemEnvelope,
  setSpineSpeed,
  setSpineTransition,
  splitSpineClip,
  transformSpineClip,
  trimSpineClip,
} from "./sequence/spine.js";
import { CaptionStylePreset, generateSequenceCaptions } from "./speech/captions.js";
import { cleanupClipDialogue } from "./speech/cleanup.js";
import { AsrProviderId, TtsProviderId } from "./speech/providers.js";
import { synthesizeVoiceover } from "./speech/synthesize.js";
import { transcribeLibraryAsset } from "./speech/transcribe.js";
import { runWorkspaceVerification } from "./verify/gates.js";

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  "help",
  "json",
  "compact",
  "verbose",
  "full-bins",
  "sequence-time",
  "source-time",
  "cascade-cues",
  "preserve-pitch",
  "mirror-x",
  "mirror-y",
  "transparent",
  "remove-pauses",
  "remove-fillers",
  "remove-repetitions",
  "dry-run",
  "clarity",
  "boxes",
  "all-spine",
  "replace",
  "include-empty",
  "preserve-duration",
]);

const KNOWN_CLI_FLAGS = new Set([
  ...BOOLEAN_FLAGS,
  "format",
  "dir",
  "project",
  "aspect",
  "fps",
  "title",
  "steps",
  "to",
  "expect-rev",
  "allow-protected",
  "name",
  "file",
  "handle",
  "target-lufs",
  "bins",
  "png",
  "sensitivity",
  "threshold",
  "target-handle",
  "kind",
  "range",
  "text",
  "limit",
  "cursor",
  "max-tokens",
  "asset",
  "in",
  "out",
  "id",
  "clip",
  "clips",
  "at",
  "ranges",
  "coord",
  "before",
  "after",
  "index",
  "x",
  "y",
  "scale",
  "scale-x",
  "scale-y",
  "rotation",
  "opacity",
  "fit",
  "rate",
  "duration",
  "easing",
  "param",
  "points",
  "lane",
  "anchor",
  "offset",
  "size",
  "color",
  "max-width",
  "comp-dir",
  "composition-dir",
  "dir-comp",
  "entry",
  "props",
  "mode",
  "scaffold",
  "preset",
  "cue",
  "cues",
  "gain-db",
  "gates",
  "lang",
  "provider",
  "voice",
  "model",
  "speed",
  "place-on-lane",
  "min-pause",
  "pad",
  "cut-candidates",
  "style",
  "max-words",
  "max-chars",
  "true-peak",
  "nr-db",
  "bgm-lane",
  "duck-db",
  "attack",
  "release",
  "bgm-handle",
  "tolerance",
  "tolerance-ms",
  "grid",
  "start",
  "end",
  "width",
  "lens",
  "window",
  "deadband",
  "focal-points",
]);

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function suggestFlagFix(unknownFlag: string, group: string, action?: string): string {
  const aliasMap: Record<string, string> = {
    compdir: "comp-dir",
    composition: "comp-dir",
    rev: "expect-rev",
    revision: "expect-rev",
    "output-format": "json",
    from: "start",
    proj: "dir",
  };
  let best = aliasMap[unknownFlag];
  if (!best) {
    let bestDist = Infinity;
    for (const known of KNOWN_CLI_FLAGS) {
      const d = levenshtein(unknownFlag, known);
      if (d < bestDist) {
        bestDist = d;
        best = known;
      }
    }
  }
  return `cuthol ${group}${action ? ` ${action}` : ""} --${best ?? "help"}`;
}

let activeCliCompactMode = false;
let activeCliWorkspaceDir = process.cwd();
let activeCliRevisionBefore: number | null = null;
let activeCliValues: Record<string, unknown> = {};
let activeCliGroup = "";
let activeCliAction: string | undefined;
let activeCliSub: string | undefined;

function emitEnvelopeObject(
  workspaceDir: string,
  command: string,
  envObj: Record<string, unknown>
): void {
  if (activeCliCompactMode) {
    const { text } = formatEnvelopeCompact({
      envelope: envObj,
      command,
      dir: workspaceDir,
      values: activeCliValues,
      revisionBefore: activeCliRevisionBefore,
      exitCode: envObj.ok === false ? 1 : 0,
    });
    console.log(text);
    return;
  }
  console.log(JSON.stringify(envObj, null, 2));
}

function emitEnvelopeJson(
  workspaceDir: string,
  command: string,
  payload: Record<string, unknown>
): void {
  let header: Record<string, unknown> = { schema_version: "cuthol.envelope/1" };
  try {
    header = buildWorkspaceEnvelopeHeader(workspaceDir);
  } catch {
    // workspace might not exist yet
  }
  emitEnvelopeObject(workspaceDir, command, {
    ok: true,
    command,
    ...header,
    ...payload,
  });
}

function parsePropsJsonFlag(raw: string, commandName: string): Record<string, unknown> {
  try {
    const cleaned = raw.replace(/\bNaN\b|\bInfinity\b|-Infinity\b/g, "null");
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to diagnostic error
  }
  throw new CutholError(
    DIAGNOSTICS.UNKNOWN_FLAG(
      `--props ${raw}`,
      commandName,
      `cuthol ${commandName.replace(".", " ")} --props '{"headline":"Başlık"}'`
    )
  );
}

function parseArgv(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx > 0) {
        const key = token.slice(2, eqIdx);
        flags[key] = token.slice(eqIdx + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (BOOLEAN_FLAGS.has(key)) {
          if (next === "true" || next === "false" || next === "1" || next === "0") {
            flags[key] = next;
            i++;
          } else {
            flags[key] = true;
          }
        } else if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function strFlag(flags: Record<string, string | boolean>, name: string, fallback?: string): string | undefined {
  const val = flags[name];
  if (typeof val === "string") return val;
  if (val === true && name !== "scaffold" && !BOOLEAN_FLAGS.has(name)) {
    throw new CutholError(
      DIAGNOSTICS.UNKNOWN_FLAG(
        `--${name} (eksik değer / missing value)`,
        "cli",
        `--${name} <değer>`
      )
    );
  }
  return fallback;
}

function numFlag(flags: Record<string, string | boolean>, name: string, fallback?: number): number | undefined {
  const val = flags[name];
  if (typeof val === "string") {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  if (val === true && !BOOLEAN_FLAGS.has(name)) {
    throw new CutholError(
      DIAGNOSTICS.UNKNOWN_FLAG(
        `--${name} (eksik sayısal değer / missing numeric value)`,
        "cli",
        `--${name} <sayı>`
      )
    );
  }
  return fallback;
}

function boolFlag(flags: Record<string, string | boolean>, name: string, fallback?: boolean): boolean | undefined {
  const val = flags[name];
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    if (val === "true" || val === "1") return true;
    if (val === "false" || val === "0") return false;
  }
  return fallback;
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgv(process.argv.slice(2));
  const [group, action, ...rest] = positionals;
  activeCliGroup = group ?? "";
  activeCliAction = action;
  activeCliSub = rest[0];

  const formatFlag = typeof flags["format"] === "string" ? flags["format"].trim().toLowerCase() : "";
  activeCliCompactMode =
    !flags["json"] &&
    (boolFlag(flags, "compact", false) === true || formatFlag === "text" || formatFlag === "compact");

  const invokedBin = path.basename(process.argv[1] ?? "").toLowerCase();
  if (group === "mcp" || invokedBin.startsWith("cuthol-mcp")) {
    const mcpDir = typeof flags["dir"] === "string" ? flags["dir"] : undefined;
    startMcpStdioServer({ defaultDir: mcpDir });
    return;
  }

  for (const key of Object.keys(flags)) {
    if (!KNOWN_CLI_FLAGS.has(key)) {
      throw new CutholError(
        DIAGNOSTICS.UNKNOWN_FLAG(`--${key}`, `${group ?? "cuthol"}${action ? `.${action}` : ""}`, suggestFlagFix(key, group ?? "", action))
      );
    }
  }
  if (formatFlag && formatFlag !== "json" && formatFlag !== "text" && formatFlag !== "compact") {
    throw new CutholError(
      DIAGNOSTICS.UNKNOWN_FLAG(
        `--format ${String(flags["format"])}`,
        `${group ?? "cuthol"}${action ? `.${action}` : ""}`,
        `cuthol ${group ?? ""}${action ? ` ${action}` : ""} --format text`
      )
    );
  }

  const workspaceDir = strFlag(flags, "dir") ?? strFlag(flags, "project") ?? process.cwd();
  activeCliWorkspaceDir = workspaceDir;
  activeCliRevisionBefore = readWorkspaceRevision(workspaceDir);
  activeCliValues = {
    dry_run: boolFlag(flags, "dry-run", false),
    verbose: boolFlag(flags, "verbose", false),
    clip: strFlag(flags, "clip"),
    cursor: strFlag(flags, "cursor"),
    limit: numFlag(flags, "limit"),
  };
  loadDotEnvIfNeeded(workspaceDir);

  if (!group || group === "help" || flags["help"]) {
    if (flags["json"]) {
      const targetGroup = group === "help" ? action : group;
      const tools = targetGroup
        ? CUTHOL_MCP_TOOLS.filter((t) => t.name === targetGroup)
        : CUTHOL_MCP_TOOLS;
      console.log(
        JSON.stringify(
          {
            ok: true,
            command: "help",
            schema_version: "cuthol.envelope/1",
            tools,
            flag_lexicon: {
              workspace_dir: ["--dir", "--project"],
              composition_dir: ["--comp-dir", "--composition-dir"],
              revision_guard: ["--expect-rev"],
              targeted_undo: ["--to"],
            },
          },
          null,
          2
        )
      );
      return;
    }
    printHelp();
    return;
  }

  switch (group) {
    case "workspace": {
      if (action === "init") {
        const targetDir = rest[0] ?? workspaceDir;
        const aspect = (strFlag(flags, "aspect", "9:16") as AspectPreset) ?? "9:16";
        const fps = numFlag(flags, "fps", 30) ?? 30;
        const title = strFlag(flags, "title");
        const { paths, sequence } = initWorkspace({ dir: targetDir, aspect, fps, title });
        emitEnvelopeJson(targetDir, "workspace.init", {
          action: "workspace.init",
          sequence_file: paths.sequenceFile,
          ledger_file: paths.ledgerFile,
          project_id: sequence.meta.project_id,
          stage: sequence.stage,
        });
        return;
      }

      if (action === "journal") {
        const sub = rest[0] ?? "list";
        if (sub === "list") {
          const { paths } = loadSequence(workspaceDir);
          const manifest = loadJournalManifest(paths);
          emitEnvelopeJson(workspaceDir, "workspace.journal.list", { ...manifest });
          return;
        }
        if (sub === "undo" || sub === "redo") {
          const allowRaw = strFlag(flags, "allow-protected");
          const allowProtected = allowRaw
            ? allowRaw.split(",").map((s) => s.trim()).filter(Boolean)
            : undefined;
          const res = stepJournal(workspaceDir, sub, {
            steps: numFlag(flags, "steps"),
            toRevision: numFlag(flags, "to"),
            expectRevision: numFlag(flags, "expect-rev"),
            dryRun: boolFlag(flags, "dry-run", false),
            allowProtected,
          });
          emitEnvelopeObject(workspaceDir, `workspace.journal.${sub}`, {
            ok: true,
            command: `workspace.journal.${sub}`,
            action: `journal.${sub}`,
            schema_version: "cuthol.envelope/1",
            dry_run: res.dry_run,
            previous_revision: res.previous_revision,
            revision: res.revision,
            operation: res.operation,
            reverted_entries: res.reverted_entries,
            state: res.state,
            delta: {
              summary:
                res.reverted_entries.map((e) => e.inverse_summary).join("; ") || res.operation,
              affected_ids: [...new Set(res.reverted_entries.flatMap((e) => e.affected_ids))],
            },
            history: res.history,
          });
          return;
        }
        if (sub === "tag") {
          const tag = rest[1] ?? strFlag(flags, "name", "checkpoint")!;
          const entry = tagCurrentRevision(workspaceDir, tag);
          emitEnvelopeJson(workspaceDir, "workspace.journal.tag", {
            action: "journal.tag",
            entry,
          });
          return;
        }
      }
      break;
    }

    case "library": {
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
        const qRes = queryLibraryAnalysis({
          workspaceDir,
          handle,
          kind: strFlag(flags, "kind") as QueryableMediaKind | undefined,
          range: strFlag(flags, "range"),
          text: strFlag(flags, "text"),
          limit: numFlag(flags, "limit"),
          cursor: strFlag(flags, "cursor"),
          maxTokens: numFlag(flags, "max-tokens"),
        });
        emitEnvelopeJson(workspaceDir, "library.query", {
          action: "library.query",
          ...qRes,
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
      break;
    }

    case "spine": {
      if (action === "append") {
        const assetHandle = strFlag(flags, "asset") ?? rest[0];
        if (!assetHandle) throw new Error("Provide --asset <vid_XX>.");
        const inRaw = strFlag(flags, "in");
        const outRaw = strFlag(flags, "out");
        const res = appendSpineClip({
          workspaceDir,
          assetHandle,
          sourceInMs: inRaw ? parseTimeMs(inRaw) : undefined,
          sourceOutMs: outRaw ? parseTimeMs(outRaw) : undefined,
          explicitId: strFlag(flags, "id"),
        });
        emitEnvelopeJson(workspaceDir, "spine.append", { action: "spine.append", ...res });
        return;
      }

      if (action === "split") {
        const clipId = strFlag(flags, "clip") ?? rest[0];
        const atRaw = strFlag(flags, "at");
        if (!clipId || !atRaw) throw new Error("Provide --clip <sp_XX> --at <t1,t2>.");
        const pts = atRaw.split(",").map((s) => parseTimeMs(s.trim()));
        const res = splitSpineClip({
          workspaceDir,
          clipId,
          splitPointsMs: pts,
          isSequenceTime: boolFlag(flags, "sequence-time", false),
        });
        emitEnvelopeJson(workspaceDir, "spine.split", { action: "spine.split", ...res });
        return;
      }

      if (action === "trim") {
        const clipId = strFlag(flags, "clip") ?? rest[0];
        if (!clipId) throw new Error("Provide --clip <sp_XX>.");
        const inRaw = strFlag(flags, "in");
        const outRaw = strFlag(flags, "out");
        const res = trimSpineClip({
          workspaceDir,
          clipId,
          sourceInMs: inRaw ? parseTimeMs(inRaw) : undefined,
          sourceOutMs: outRaw ? parseTimeMs(outRaw) : undefined,
        });
        emitEnvelopeJson(workspaceDir, "spine.trim", { action: "spine.trim", ...res });
        return;
      }

      if (action === "excise") {
        const clipId = strFlag(flags, "clip") ?? rest[0];
        const rangesRaw = strFlag(flags, "ranges");
        if (!clipId || !rangesRaw) throw new Error("Provide --clip <sp_XX> --ranges <a..b,c..d>.");
        const ranges = rangesRaw.split(",").map((pair) => {
          const [a, b] = pair.trim().split("..");
          return { start_ms: parseTimeMs(a), end_ms: parseTimeMs(b) };
        });
        const coordFlag = strFlag(flags, "coord") as "source" | "sequence" | "clip_local" | undefined;
        const res = exciseSpineRanges({
          workspaceDir,
          clipId,
          ranges,
          coordinateSpace: coordFlag,
          isSourceTime: boolFlag(flags, "source-time", false),
        });
        emitEnvelopeJson(workspaceDir, "spine.excise", { action: "spine.excise", ...res });
        return;
      }

      if (action === "remove") {
        const clipsRaw = strFlag(flags, "clips") ?? strFlag(flags, "clip") ?? rest[0];
        if (!clipsRaw) throw new Error("Provide --clips <sp_01,sp_02>.");
        const clipIds = clipsRaw.split(",").map((s) => s.trim()).filter(Boolean);
        const res = removeSpineClips({
          workspaceDir,
          clipIds,
          cascadeAnchoredCues: boolFlag(flags, "cascade-cues", true),
        });
        emitEnvelopeJson(workspaceDir, "spine.remove", { action: "spine.remove", ...res });
        return;
      }

      if (action === "reorder") {
        const clipId = strFlag(flags, "clip") ?? rest[0];
        if (!clipId) throw new Error("Provide --clip <sp_XX>.");
        const res = reorderSpineClip({
          workspaceDir,
          clipId,
          beforeClipId: strFlag(flags, "before"),
          afterClipId: strFlag(flags, "after"),
          toIndex: numFlag(flags, "index"),
        });
        emitEnvelopeJson(workspaceDir, "spine.reorder", { action: "spine.reorder", ...res });
        return;
      }

      if (action === "transform") {
        const clipId = strFlag(flags, "clip") ?? rest[0];
        if (!clipId) throw new Error("Provide --clip <sp_XX>.");
        const res = transformSpineClip({
          workspaceDir,
          clipId,
          xPct: strFlag(flags, "x"),
          yPct: strFlag(flags, "y"),
          scale: strFlag(flags, "scale"),
          scaleX: strFlag(flags, "scale-x"),
          scaleY: strFlag(flags, "scale-y"),
          rotationDeg: strFlag(flags, "rotation"),
          opacity: strFlag(flags, "opacity"),
          fitMode: strFlag(flags, "fit") as SpatialPlacement["fit_mode"] | undefined,
          mirrorX: boolFlag(flags, "mirror-x"),
          mirrorY: boolFlag(flags, "mirror-y"),
        });
        emitEnvelopeJson(workspaceDir, "spine.transform", { action: "spine.transform", ...res });
        return;
      }

      if (action === "speed") {
        const clipId = strFlag(flags, "clip") ?? rest[0];
        const rateRaw = strFlag(flags, "rate");
        if (!clipId || !rateRaw) throw new Error("Provide --clip <sp_XX> --rate <1.5>.");
        const rate = Number(rateRaw.replace(/x$/i, ""));
        const res = setSpineSpeed({
          workspaceDir,
          clipId,
          rate,
          preservePitch: boolFlag(flags, "preserve-pitch"),
        });
        emitEnvelopeJson(workspaceDir, "spine.speed", { action: "spine.speed", ...res });
        return;
      }

      if (action === "transition") {
        const clipId = strFlag(flags, "clip") ?? rest[0];
        const kind = strFlag(flags, "kind", "dissolve")!;
        if (!clipId) throw new Error("Provide --clip <sp_XX>.");
        const durRaw = strFlag(flags, "duration", "400ms")!;
        const easing = (strFlag(flags, "easing", "ease_in_out") as TransitionSpec["easing"]) ?? "ease_in_out";
        const transition: TransitionSpec | null =
          kind === "none"
            ? null
            : {
                kind: kind as TransitionSpec["kind"],
                duration_ms: parseTimeMs(durRaw),
                easing,
              };
        const res = setSpineTransition({ workspaceDir, clipId, transition });
        emitEnvelopeJson(workspaceDir, "spine.transition", { action: "spine.transition", ...res });
        return;
      }

      if (action === "envelope") {
        const targetId = strFlag(flags, "clip") ?? strFlag(flags, "id") ?? rest[0];
        const parameter = strFlag(flags, "param") as ParameterEnvelope["parameter"] | undefined;
        const ptsRaw = strFlag(flags, "points");
        if (!targetId || !parameter || !ptsRaw) {
          throw new Error("Provide --clip <sp_XX|cue_XX> --param <name> --points <0ms:1.0,2000ms:1.15>.");
        }
        const defaultEasing =
          (strFlag(flags, "easing", "ease_in_out") as ParameterEnvelopePoint["easing"]) ?? "ease_in_out";
        const points: ParameterEnvelopePoint[] = ptsRaw.split(",").map((token) => {
          const [tStr, vStr] = token.trim().split(":");
          return {
            offset_ms: parseTimeMs(tStr),
            value: Number(vStr),
            easing: defaultEasing,
          };
        });
        const res = setItemEnvelope({ workspaceDir, targetId, parameter, points });
        emitEnvelopeJson(workspaceDir, "spine.envelope", { action: "spine.envelope", ...res });
        return;
      }

      if (action === "reframe") {
        const clipsRaw = strFlag(flags, "clips") ?? strFlag(flags, "clip") ?? rest[0];
        const clipIds =
          boolFlag(flags, "all-spine", false) || !clipsRaw
            ? undefined
            : clipsRaw
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        const mode = (strFlag(flags, "mode", "subject_track") ?? "subject_track") as
          | "subject_track"
          | "center_lock"
          | "off";
        const ptsRaw = strFlag(flags, "points") ?? strFlag(flags, "focal-points");
        const manualPoints = ptsRaw
          ? ptsRaw.split(",").map((token) => {
              const trimmed = token.trim();
              const sepIdx = trimmed.lastIndexOf(":");
              if (sepIdx <= 0) {
                throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(trimmed));
              }
              const tStr = trimmed.slice(0, sepIdx).trim();
              const vStr = trimmed.slice(sepIdx + 1).trim();
              const val = Number(vStr.replace(/%$/, ""));
              if (!Number.isFinite(val)) {
                throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(trimmed));
              }
              return {
                offset_ms: parseTimeMs(tStr),
                center_x_pct: val,
              };
            })
          : undefined;
        const fixedXRaw = strFlag(flags, "x");
        const fixedCenterXPct =
          fixedXRaw !== undefined ? Number(fixedXRaw.replace(/%$/, "")) : undefined;
        const res = reframeSpineClips({
          workspaceDir,
          clipIds,
          mode,
          deadbandPct: numFlag(flags, "deadband"),
          fixedCenterXPct: Number.isFinite(fixedCenterXPct) ? fixedCenterXPct : undefined,
          manualPoints,
          replaceManualPoints: boolFlag(flags, "replace", false),
          sampleFps: numFlag(flags, "fps"),
          dryRun: boolFlag(flags, "dry-run", false),
        });
        emitEnvelopeJson(workspaceDir, "spine.reframe", { action: "spine.reframe", ...res });
        return;
      }
      break;
    }

    case "lane": {
      if (action === "lock" || action === "unlock") {
        const laneId = strFlag(flags, "lane") ?? rest[0] ?? "ln_titles";
        const res = setLaneLockStatus({
          workspaceDir,
          laneId,
          locked: action === "lock",
        });
        emitEnvelopeJson(workspaceDir, `lane.${action}`, {
          action: `lane.${action}`,
          ...res,
        });
        return;
      }

      if (action === "add-cue") {
        const laneId = strFlag(flags, "lane", "ln_titles")!;
        const kind = strFlag(flags, "kind") as LaneKind | undefined;
        const durRaw = strFlag(flags, "duration", "3000ms")!;
        const anchorRef = strFlag(flags, "anchor");
        const offsetRaw = strFlag(flags, "offset", "0ms")!;
        const atRaw = strFlag(flags, "at", "0ms")!;
        const res = addLaneCue({
          workspaceDir,
          laneId,
          kind,
          explicitId: strFlag(flags, "id"),
          assetHandle: strFlag(flags, "asset"),
          anchor: anchorRef ? { ref: anchorRef, offset_ms: parseTimeMs(offsetRaw) } : null,
          atMs: parseTimeMs(atRaw),
          durationMs: parseTimeMs(durRaw),
          text: strFlag(flags, "text"),
          fontSizePx: numFlag(flags, "size"),
          colorHex: strFlag(flags, "color"),
          maxWidthPct: numFlag(flags, "max-width"),
          xPct: numFlag(flags, "x"),
          yPct: numFlag(flags, "y"),
          scale: numFlag(flags, "scale"),
          opacity: numFlag(flags, "opacity"),
        });
        emitEnvelopeJson(workspaceDir, "lane.add-cue", { action: "lane.add-cue", ...res });
        return;
      }

      if (action === "add-composition") {
        const laneId = strFlag(flags, "lane", "ln_motion")!;
        const compDir =
          strFlag(flags, "comp-dir") ??
          strFlag(flags, "composition-dir") ??
          strFlag(flags, "dir-comp") ??
          rest[0];
        if (!compDir) {
          throw new CutholError(
            DIAGNOSTICS.UNKNOWN_FLAG(
              flags["dir"] ? "--dir (used without --comp-dir)" : "missing --comp-dir",
              "lane.add-composition",
              `cuthol lane add-composition --dir <workspace_dir> --comp-dir ${strFlag(flags, "dir") ?? "./compositions/intro"} --duration 3000ms`
            )
          );
        }
        const entryHtml = strFlag(flags, "entry", "index.html")!;
        const durRaw = strFlag(flags, "duration", "4000ms")!;
        const atRaw = strFlag(flags, "at", "0ms")!;
        const anchorRef = strFlag(flags, "anchor");
        const offsetRaw = strFlag(flags, "offset", "0ms")!;
        const propsRaw = strFlag(flags, "props", "{}")!;
        const props = parsePropsJsonFlag(propsRaw, "lane.add-composition");
        const transparent = boolFlag(flags, "transparent", true) ?? true;
        const mode = (strFlag(flags, "mode", "overlay_alpha") as HyperFramesCompositeMode) ?? "overlay_alpha";
        const durationMs = parseTimeMs(durRaw);

        // If `--scaffold <preset>` is passed or the composition dir does not exist yet, scaffold it deterministically
        const { sequence } = loadSequence(workspaceDir);
        const absCompDir = path.isAbsolute(compDir) ? compDir : path.resolve(workspaceDir, compDir);
        if (flags["scaffold"] || !fs.existsSync(path.join(absCompDir, entryHtml))) {
          const preset = (strFlag(flags, "scaffold", "lower_third") as HyperFramesPresetKind) ?? "lower_third";
          scaffoldHyperFramesComposition({
            targetDir: absCompDir,
            width: sequence.stage.width,
            height: sequence.stage.height,
            fps: sequence.stage.fps,
            durationMs,
            preset,
            props,
            transparent,
          });
        }

        const contract = validateHyperFramesCompositionContract(absCompDir, entryHtml);
        if (!contract.ok) {
          throw new Error(`HyperFrames composition contract errors: ${contract.findings.join("; ")}`);
        }

        const res = addLaneCue({
          workspaceDir,
          laneId,
          kind: "composition",
          explicitId: strFlag(flags, "id"),
          anchor: anchorRef ? { ref: anchorRef, offset_ms: parseTimeMs(offsetRaw) } : null,
          atMs: parseTimeMs(atRaw),
          durationMs,
          composition: {
            composition_dir: compDir,
            entry_html: entryHtml,
            props,
            transparent,
            mode,
          },
        });
        emitEnvelopeJson(workspaceDir, "lane.add-composition", {
          action: "lane.add-composition",
          ...res,
        });
        return;
      }

      if (action === "update-cue") {
        const cueId = strFlag(flags, "cue") ?? strFlag(flags, "id") ?? rest[0];
        if (!cueId) throw new Error("Provide --cue <cue_XX>.");
        const atRaw = strFlag(flags, "at");
        const durRaw = strFlag(flags, "duration");
        const res = updateLaneCue({
          workspaceDir,
          cueId,
          atMs: atRaw ? parseTimeMs(atRaw) : undefined,
          durationMs: durRaw ? parseTimeMs(durRaw) : undefined,
          xPct: strFlag(flags, "x"),
          yPct: strFlag(flags, "y"),
          scale: strFlag(flags, "scale"),
          opacity: strFlag(flags, "opacity"),
          text: strFlag(flags, "text"),
          fontSizePx: numFlag(flags, "size"),
          maxWidthPct: numFlag(flags, "max-width"),
          gainDb: numFlag(flags, "gain-db"),
        });
        emitEnvelopeJson(workspaceDir, "lane.update-cue", { action: "lane.update-cue", ...res });
        return;
      }

      if (action === "remove-cue") {
        const cuesRaw = strFlag(flags, "cues") ?? strFlag(flags, "cue") ?? rest[0];
        if (!cuesRaw) throw new Error("Provide --cues <cue_01,cue_02>.");
        const cueIds = cuesRaw.split(",").map((s) => s.trim()).filter(Boolean);
        const res = removeLaneCues({ workspaceDir, cueIds });
        emitEnvelopeJson(workspaceDir, "lane.remove-cue", { action: "lane.remove-cue", ...res });
        return;
      }
      break;
    }

    case "composition": {
      if (action === "scaffold") {
        const { sequence } = loadSequence(workspaceDir);
        const compDir =
          strFlag(flags, "comp-dir") ??
          strFlag(flags, "composition-dir") ??
          rest[0] ??
          "compositions/new_comp";
        const absCompDir = path.isAbsolute(compDir)
          ? compDir
          : path.resolve(workspaceDir, compDir);
        const durationMs = parseTimeMs(strFlag(flags, "duration", "3000ms")!);
        const preset = (strFlag(flags, "preset", "counter") as HyperFramesPresetKind) ?? "counter";
        const props = parsePropsJsonFlag(strFlag(flags, "props", "{}")!, "composition.scaffold");
        const transparent = boolFlag(flags, "transparent", true) ?? true;
        const res = scaffoldHyperFramesComposition({
          targetDir: absCompDir,
          width: sequence.stage.width,
          height: sequence.stage.height,
          fps: sequence.stage.fps,
          durationMs,
          preset,
          props,
          transparent,
        });
        emitEnvelopeJson(workspaceDir, "composition.scaffold", {
          action: "composition.scaffold",
          ...res,
        });
        return;
      }

      if (action === "sync") {
        const { paths, sequence } = loadSequence(workspaceDir);
        const synced = syncAllCompositionBridges(sequence, paths);
        emitEnvelopeJson(workspaceDir, "composition.sync", {
          action: "composition.sync",
          synced,
        });
        return;
      }

      if (action === "preview" || action === "check") {
        const atRaw = strFlag(flags, "at");
        const atSeconds = atRaw
          ? atRaw
              .split(",")
              .map((s) => Number(s.trim().replace(/s$/i, "")))
              .filter((n) => Number.isFinite(n))
          : undefined;
        const res = previewAndCheckComposition({
          workspaceDir,
          cueId: strFlag(flags, "cue") ?? strFlag(flags, "id") ?? rest[0],
          compositionDir: strFlag(flags, "comp-dir") ?? strFlag(flags, "composition-dir"),
          atSeconds,
          outputPath: strFlag(flags, "out"),
        });
        emitEnvelopeJson(workspaceDir, `composition.${action}`, {
          action: `composition.${action}`,
          ...res,
        });
        return;
      }
      break;
    }

    case "cue": {
      const sheetFile = strFlag(flags, "file") ?? rest[0];
      if (action === "export") {
        const { sequence } = loadSequence(workspaceDir);
        const exported = exportSequenceToCueSheet(sequence);
        if (sheetFile) {
          fs.writeFileSync(path.resolve(sheetFile), JSON.stringify(exported, null, 2), "utf8");
        }
        emitEnvelopeJson(workspaceDir, "cue.export", { action: "cue.export", sheet: exported });
        return;
      }

      if (!sheetFile) throw new Error("Provide --file <cuthol.cues.json>.");
      const sheet = JSON.parse(fs.readFileSync(path.resolve(sheetFile), "utf8")) as CutholCueSheet;

      if (action === "diff") {
        const { sequence } = loadSequence(workspaceDir);
        const { diff } = mergeCueSheetIntoSequence(sequence, sheet);
        emitEnvelopeJson(workspaceDir, "cue.diff", { action: "cue.diff", diff });
        return;
      }
      if (action === "plan") {
        const res = planCueSheet(workspaceDir, sheet);
        emitEnvelopeJson(workspaceDir, "cue.plan", { action: "cue.plan", ...res });
        return;
      }
      if (action === "apply") {
        const res = applyCueSheet(workspaceDir, sheet);
        emitEnvelopeJson(workspaceDir, "cue.apply", { action: "cue.apply", ...res });
        return;
      }
      break;
    }

    case "verify": {
      const gatesRaw = strFlag(flags, "gates");
      const gates =
        gatesRaw && gatesRaw !== "all"
          ? (gatesRaw.split(",").map((s) => s.trim()) as VerificationGateId[])
          : undefined;
      const report = runWorkspaceVerification(workspaceDir, gates);
      emitEnvelopeJson(workspaceDir, "verify", { ...report, ok: report.ok });
      if (!report.ok) {
        process.exitCode = 1;
      }
      return;
    }

    case "speech": {
      if (action === "transcribe") {
        const handle = strFlag(flags, "handle") ?? rest[0];
        if (!handle) throw new Error("Provide --handle <vid_XX|aud_XX>.");
        const res = await transcribeLibraryAsset({
          workspaceDir,
          handle,
          language: strFlag(flags, "lang", "tr"),
          provider: strFlag(flags, "provider") as AsrProviderId | undefined,
        });
        const payload = flags["verbose"]
          ? { action: "speech.transcribe", ...res }
          : { action: "speech.transcribe", ...formatTranscribeDigest(res) };
        emitEnvelopeJson(workspaceDir, "speech.transcribe", payload);
        return;
      }

      if (action === "synthesize") {
        const text = strFlag(flags, "text") ?? rest[0];
        if (!text) throw new Error("Provide --text \"...\" to synthesize.");
        const atRaw = strFlag(flags, "at");
        const offRaw = strFlag(flags, "offset");
        const res = await synthesizeVoiceover({
          workspaceDir,
          text,
          voiceId: strFlag(flags, "voice"),
          modelId: strFlag(flags, "model"),
          speed: numFlag(flags, "speed"),
          provider: strFlag(flags, "provider") as TtsProviderId | undefined,
          language: strFlag(flags, "lang", "tr"),
          placeOnLane: strFlag(flags, "place-on-lane"),
          atMs: atRaw ? parseTimeMs(atRaw) : undefined,
          anchorClipId: strFlag(flags, "anchor"),
          anchorOffsetMs: offRaw ? parseTimeMs(offRaw) : undefined,
        });
        emitEnvelopeJson(workspaceDir, "speech.synthesize", {
          action: "speech.synthesize",
          ...res,
        });
        return;
      }

      if (action === "cleanup") {
        const clipId = strFlag(flags, "clip") ?? rest[0];
        if (!clipId) throw new Error("Provide --clip <sp_XX>.");
        const minPauseRaw = strFlag(flags, "min-pause");
        const padRaw = strFlag(flags, "pad");
        const cutCandRaw = strFlag(flags, "cut-candidates");
        const cutCandidates = cutCandRaw
          ? cutCandRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        const res = cleanupClipDialogue({
          workspaceDir,
          clipId,
          minPauseMs: minPauseRaw ? parseTimeMs(minPauseRaw) : undefined,
          padMs: padRaw ? parseTimeMs(padRaw) : undefined,
          removePauses: boolFlag(flags, "remove-pauses", true),
          removeFillers: boolFlag(flags, "remove-fillers", true),
          removeRepetitions: boolFlag(flags, "remove-repetitions", true),
          cutCandidates,
          language: strFlag(flags, "lang", "tr"),
          dryRun: boolFlag(flags, "dry-run", false),
        });
        emitEnvelopeJson(workspaceDir, "speech.cleanup", {
          action: "speech.cleanup",
          ...res,
        });
        return;
      }

      if (action === "captions") {
        const style = (strFlag(flags, "style", "active_word") as CaptionStylePreset) ?? "active_word";
        const res = generateSequenceCaptions({
          workspaceDir,
          clipId: strFlag(flags, "clip"),
          allSpineOnly: boolFlag(flags, "all-spine", false),
          style,
          maxWordsPerGroup: numFlag(flags, "max-words"),
          maxCharsPerLine: numFlag(flags, "max-chars"),
          language: strFlag(flags, "lang", "tr"),
          replaceExistingCaptions: boolFlag(flags, "replace"),
        });
        const payload = flags["verbose"]
          ? { action: "speech.captions", ...res }
          : { action: "speech.captions", ...formatCaptionsDigest(res) };
        emitEnvelopeJson(workspaceDir, "speech.captions", payload);
        return;
      }
      break;
    }

    case "mix": {
      if (action === "normalize") {
        const clipsRaw = strFlag(flags, "clips") ?? strFlag(flags, "clip");
        const clipIds = clipsRaw ? clipsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        const res = normalizeSequenceAudio({
          workspaceDir,
          targetLufs: numFlag(flags, "target-lufs"),
          truePeakDbtp: numFlag(flags, "true-peak"),
          clipIds,
        });
        emitEnvelopeJson(workspaceDir, "mix.normalize", { action: "mix.normalize", ...res });
        return;
      }

      if (action === "polish-voice") {
        const clipsRaw = strFlag(flags, "clips") ?? strFlag(flags, "clip") ?? rest[0];
        const clipIds = clipsRaw ? clipsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        const res = polishVoiceAudio({
          workspaceDir,
          clipIds,
          nrDb: numFlag(flags, "nr-db"),
          enableClarity: boolFlag(flags, "clarity", true),
        });
        emitEnvelopeJson(workspaceDir, "mix.polish-voice", {
          action: "mix.polish-voice",
          ...res,
        });
        return;
      }

      if (action === "duck") {
        const attackRaw = strFlag(flags, "attack");
        const releaseRaw = strFlag(flags, "release");
        const res = duckMusicUnderDialogue({
          workspaceDir,
          bgmLaneId: strFlag(flags, "bgm-lane", "ln_bgm"),
          duckDb: numFlag(flags, "duck-db"),
          attackMs: attackRaw ? parseTimeMs(attackRaw) : undefined,
          releaseMs: releaseRaw ? parseTimeMs(releaseRaw) : undefined,
          language: strFlag(flags, "lang", "tr"),
        });
        emitEnvelopeJson(workspaceDir, "mix.duck", { action: "mix.duck", ...res });
        return;
      }

      if (action === "beat-align") {
        const bgmHandle = strFlag(flags, "bgm-handle") ?? rest[0];
        if (!bgmHandle) throw new Error("Provide --bgm-handle <aud_XX>.");
        const clipsRaw = strFlag(flags, "clips");
        const clipIds = clipsRaw ? clipsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        const tolRaw = strFlag(flags, "tolerance") ?? strFlag(flags, "tolerance-ms");
        const modeRaw = strFlag(flags, "mode");
        const gridFlag = boolFlag(flags, "grid");
        const alignTo: "grid" | "onsets" | undefined =
          modeRaw === "onsets" || modeRaw === "onset" || gridFlag === false
            ? "onsets"
            : modeRaw === "grid" || gridFlag === true
              ? "grid"
              : undefined;
        const res = alignClipsToBeats({
          workspaceDir,
          bgmHandle,
          clipIds,
          sensitivity: numFlag(flags, "sensitivity"),
          toleranceMs: tolRaw !== undefined ? parseTimeMs(tolRaw) : undefined,
          preserveDuration: boolFlag(flags, "preserve-duration", false),
          alignTo,
        });
        emitEnvelopeJson(workspaceDir, "mix.beat-align", { action: "mix.beat-align", ...res });
        return;
      }
      break;
    }

    case "monitor": {
      if (action === "frame") {
        const atRaw = strFlag(flags, "at") ?? rest[0] ?? "0ms";
        const res = captureMonitorFrame({
          workspaceDir,
          atMs: parseTimeMs(atRaw),
          showBoxes: boolFlag(flags, "boxes", true),
          outputPath: strFlag(flags, "out"),
        });
        emitEnvelopeJson(workspaceDir, "monitor.frame", { ...res });
        return;
      }

      if (action === "sheet") {
        const gridRaw = strFlag(flags, "grid", "3x3")!;
        const [cStr, rStr] = gridRaw.toLowerCase().split("x");
        const cols = Number(cStr) || 3;
        const rows = Number(rStr) || 3;
        const startRaw = strFlag(flags, "start");
        const endRaw = strFlag(flags, "end");
        const res = captureMonitorSheet({
          workspaceDir,
          startMs: startRaw ? parseTimeMs(startRaw) : undefined,
          endMs: endRaw ? parseTimeMs(endRaw) : undefined,
          cols,
          rows,
          showBoxes: boolFlag(flags, "boxes", true),
          outputPath: strFlag(flags, "out"),
        });
        emitEnvelopeJson(workspaceDir, "monitor.sheet", { ...res });
        return;
      }

      if (action === "timeline") {
        const res = captureMonitorTimeline({
          workspaceDir,
          width: numFlag(flags, "width"),
          includeEmptyLanes: boolFlag(flags, "include-empty", false),
          outputPath: strFlag(flags, "out"),
        });
        emitEnvelopeJson(workspaceDir, "monitor.timeline", { ...res });
        return;
      }
      break;
    }

    case "render": {
      const isActionPreset = action === "draft_480p" || action === "master_1080p";
      const preset =
        (strFlag(flags, "preset", isActionPreset ? (action as RenderPreset) : "master_1080p") as RenderPreset) ??
        "master_1080p";
      const outPath = strFlag(flags, "out") ?? (isActionPreset ? rest[0] : action ?? rest[0]);
      const res = renderSequenceToMp4({
        workspaceDir,
        preset,
        outputPath: outPath,
      });
      emitEnvelopeJson(workspaceDir, "render", { ...res });
      return;
    }

    case "brief": {
      const { sequence } = loadSequence(workspaceDir);
      const lens = (strFlag(flags, "lens", (action as BriefLens) || "overview") as BriefLens) ?? "overview";
      const idRaw = strFlag(flags, "id");
      const targetIds = idRaw ? idRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];

      let windowStartMs: number | undefined;
      let windowEndMs: number | undefined;
      const winRaw = strFlag(flags, "window");
      if (winRaw && winRaw.includes("..")) {
        const [a, b] = winRaw.split("..");
        if (a) windowStartMs = parseTimeMs(a);
        if (b) windowEndMs = parseTimeMs(b);
      }

      if (flags["json"]) {
        emitEnvelopeJson(workspaceDir, "brief", { lens, sequence });
        return;
      }

      const md = renderSequenceBrief(sequence, {
        lens,
        targetIds,
        windowStartMs,
        windowEndMs,
      });
      console.log(md);
      return;
    }
  }

  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(
    [
      "Cuthol — Agent-First Open-Source Non-Linear Video Editor (NLE)",
      "",
      "Usage:",
      "  cuthol workspace init [dir] [--aspect 9:16|16:9|1:1] [--fps 30] [--title <name>]",
      "  cuthol workspace journal [list | undo [--steps N | --to <rev>] [--expect-rev <rev>] [--dry-run] | redo [--steps N] | tag <name>] [--dir <dir>]",
      "  cuthol library ingest <files...> [--handle <vid_01>] [--dir <dir>]",
      "  cuthol library loudness --handle <vid_01> [--target-lufs -14] [--dir <dir>]",
      "  cuthol library waveform --handle <vid_01> [--bins 160] [--png <out.png>] [--verbose] [--dir <dir>]",
      "  cuthol library beats --handle <aud_01> [--sensitivity 1.35] [--verbose] [--dir <dir>]",
      "  cuthol library scenes --handle <vid_01> [--threshold 10.0] [--verbose] [--dir <dir>]",
      "  cuthol library detach-audio --handle <vid_01> [--target-handle <aud_01>] [--dir <dir>]",
      "  cuthol library query --handle <vid_01|ln_captions> [--kind transcript|beats|waveform|scenes|captions] [--range 0s..5s] [--text <q>] [--limit 40] [--cursor <idx>] [--max-tokens 2000]",
      "  cuthol spine [append|split|trim|excise|remove|reorder|transform|speed|transition|envelope] ...",
      "  cuthol lane [add-cue|add-composition|update-cue|remove-cue|lock|unlock] ...",
      "  cuthol composition [scaffold|sync|preview|check] --comp-dir <dir> ...",
      "  cuthol cue [plan|apply|diff|export] --file <cuthol.cues.json>",
      "  cuthol speech [transcribe|synthesize|cleanup|captions] ...",
      "  cuthol mix [normalize|polish-voice|duck|beat-align] ...",
      "  cuthol verify [--gates all|G1_SCHEMA,G2_ASSETS,G3_TIMING,G4_STAGE,G5_SIGNAL]",
      "  cuthol monitor frame --at <2400ms> [--boxes true] [--out <frame.png>] [--dir <dir>]",
      "  cuthol monitor sheet [--start 0s] [--end 12s] [--grid 3x3] [--boxes true] [--out <sheet.png>] [--dir <dir>]",
      "  cuthol monitor timeline [--width 1400] [--include-empty] [--out <timeline.png>] [--dir <dir>]",
      "  cuthol render [--preset draft_480p|master_1080p] [--out <render.mp4>] [--dir <dir>]",
      "  cuthol brief [--lens overview|flow|canvas|detail] [--id <id1,id2>] [--window 0s..10s] [--json] [--dir <dir>]",
      "  cuthol mcp",
      "",
      "Global output flags: [--compact | --format text|json]",
    ].join("\n")
  );
}

main().catch((err: unknown) => {
  const errEnvelope: Record<string, unknown> =
    err instanceof CutholError
      ? {
          ok: false,
          schema_version: "cuthol.envelope/1",
          diagnostic: err.diagnostic,
        }
      : {
          ok: false,
          schema_version: "cuthol.envelope/1",
          error: err instanceof Error ? err.message : String(err),
        };

  if (activeCliCompactMode) {
    const spec = resolveActionSpecForCommand(activeCliGroup, activeCliAction, activeCliSub);
    const { text } = formatEnvelopeCompact({
      envelope: errEnvelope,
      spec,
      dir: activeCliWorkspaceDir,
      values: activeCliValues,
      revisionBefore: activeCliRevisionBefore,
      exitCode: 1,
    });
    console.error(text);
  } else {
    console.error(JSON.stringify(errEnvelope, null, 2));
  }
  process.exitCode = 1;
});
