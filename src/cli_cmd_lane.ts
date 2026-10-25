// CLI 'lane' command group handler (split out of cli.ts).
import fs from "node:fs";
import path from "node:path";
import { syncEnabledExtensionAssetsToComposition } from "./compositor/bridge_exporter.js";
import {
  HyperFramesPresetKind,
  scaffoldHyperFramesComposition,
  validateHyperFramesCompositionContract,
} from "./compositor/hyperframes_bridge.js";
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import { HyperFramesCompositeMode, LaneKind } from "./core/schema.js";
import { parseTimeMs } from "./core/time.js";
import { loadSequence, setLaneLockStatus } from "./core/workspace.js";
import {
  addLaneCue,
  exciseLaneCueRanges,
  LaneExciseRippleAcross,
  removeLaneCues,
  updateLaneCue,
} from "./sequence/lanes.js";
import { boolFlag, numFlag, parsePropsJsonFlag, strFlag } from "./cli_args.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";

export function runLaneCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, rest, flags, workspaceDir } = ctx;
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
    const inRaw = strFlag(flags, "in");
    const outRaw = strFlag(flags, "out");
    const rateRaw = strFlag(flags, "rate");
    const rate = rateRaw !== undefined ? Number(rateRaw.replace(/x$/i, "")) : undefined;
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
      explicitDuration: flags["duration"] !== undefined,
      sourceInMs: inRaw ? parseTimeMs(inRaw) : undefined,
      sourceOutMs: outRaw ? parseTimeMs(outRaw) : undefined,
      rate,
      preservePitch: boolFlag(flags, "preserve-pitch"),
      zIndex: numFlag(flags, "z-index"),
      text: strFlag(flags, "text"),
      fontSizePx: numFlag(flags, "size"),
      colorHex: strFlag(flags, "color"),
      maxWidthPct: numFlag(flags, "max-width"),
      xPct: numFlag(flags, "x"),
      yPct: numFlag(flags, "y"),
      scale: numFlag(flags, "scale"),
      rotationDeg: strFlag(flags, "rotation") ?? strFlag(flags, "rotate"),
      opacity: numFlag(flags, "opacity"),
      gainDb: numFlag(flags, "gain-db"),
      muted: boolFlag(flags, "muted"),
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
    const { paths, sequence } = loadSequence(workspaceDir);
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

    try {
      syncEnabledExtensionAssetsToComposition(sequence, absCompDir, entryHtml, paths);
    } catch {
      // non-blocking extension asset pre-sync
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
      zIndex: numFlag(flags, "z-index"),
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
    const inRaw = strFlag(flags, "in");
    const outRaw = strFlag(flags, "out");
    const rateRaw = strFlag(flags, "rate");
    const rate = rateRaw !== undefined ? Number(rateRaw.replace(/x$/i, "")) : undefined;
    const anchorRef = strFlag(flags, "anchor");
    const offsetRaw = strFlag(flags, "offset", "0ms")!;
    const anchorOpt =
      anchorRef !== undefined
        ? anchorRef === "none" || anchorRef === "null" || anchorRef === ""
          ? null
          : { ref: anchorRef, offset_ms: parseTimeMs(offsetRaw) }
        : undefined;
    const res = updateLaneCue({
      workspaceDir,
      cueId,
      atMs: atRaw ? parseTimeMs(atRaw) : undefined,
      durationMs: durRaw ? parseTimeMs(durRaw) : undefined,
      sourceInMs: inRaw ? parseTimeMs(inRaw) : undefined,
      sourceOutMs: outRaw ? parseTimeMs(outRaw) : undefined,
      rate,
      preservePitch: boolFlag(flags, "preserve-pitch"),
      zIndex: numFlag(flags, "z-index"),
      anchor: anchorOpt,
      xPct: strFlag(flags, "x"),
      yPct: strFlag(flags, "y"),
      scale: strFlag(flags, "scale"),
      rotationDeg: strFlag(flags, "rotation") ?? strFlag(flags, "rotate"),
      opacity: strFlag(flags, "opacity"),
      text: strFlag(flags, "text"),
      fontSizePx: numFlag(flags, "size"),
      maxWidthPct: numFlag(flags, "max-width"),
      gainDb: numFlag(flags, "gain-db"),
      muted: boolFlag(flags, "muted"),
    });
    emitEnvelopeJson(workspaceDir, "lane.update-cue", { action: "lane.update-cue", ...res });
    return;
  }

  if (action === "excise") {
    const cueId =
      strFlag(flags, "cue") ?? strFlag(flags, "id") ?? strFlag(flags, "clip") ?? rest[0];
    const rangesRaw = strFlag(flags, "ranges");
    if (!cueId || !rangesRaw) {
      throw new Error("Provide --cue <cue_XX> --ranges <a..b,c..d>.");
    }
    const ranges = rangesRaw.split(",").map((pair) => {
      const [a, b] = pair.trim().split("..");
      return { start_ms: parseTimeMs(a), end_ms: parseTimeMs(b) };
    });
    const coordFlag = strFlag(flags, "coord") as
      | "source"
      | "sequence"
      | "clip_local"
      | "cue_local"
      | undefined;
    const acrossFlag = strFlag(flags, "across") as LaneExciseRippleAcross | undefined;
    const res = exciseLaneCueRanges({
      workspaceDir,
      cueId,
      ranges,
      coordinateSpace: coordFlag,
      isSourceTime:
        flags["source-time"] !== undefined ? boolFlag(flags, "source-time") : undefined,
      ripple: boolFlag(flags, "ripple", true),
      across: acrossFlag,
    });
    emitEnvelopeJson(workspaceDir, "lane.excise", { action: "lane.excise", ...res });
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
  return CLI_NOT_HANDLED;
}
