// CLI 'composition' and 'cue' command group handlers (split out of cli.ts).
import fs from "node:fs";
import path from "node:path";
import { syncAllCompositionBridges } from "./compositor/bridge_exporter.js";
import { previewAndCheckComposition } from "./compositor/composition_preview.js";
import {
  HyperFramesPresetKind,
  scaffoldHyperFramesComposition,
} from "./compositor/hyperframes_bridge.js";
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import { parseTimeMs } from "./core/time.js";
import { measureCompositionCues, parseCoordsFrameSelector } from "./compositor/coords_extract.js";
import { geometryMisuseError, isGeometryAtValue, runGeometryQuery } from "./compositor/coords_query.js";
import { formatEnvelopeCompact, resolveActionSpecForCommand } from "./mcp/server.js";
import { loadSequence } from "./core/workspace.js";
import {
  applyCueSheet,
  CutholCueSheet,
  exportSequenceToCueSheet,
  mergeCueSheetIntoSequence,
  planCueSheet,
} from "./sequence/cuesheet.js";
import { boolFlag, parsePropsJsonFlag, strFlag } from "./cli_args.js";
import {
  activeCliAction,
  activeCliCompactMode,
  activeCliGroup,
  activeCliRevisionBefore,
  activeCliSub,
  activeCliValues,
  activeCliWorkspaceDir,
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";

function emitCoordsAsyncError(err: unknown): void {
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
}

export function runCompositionCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, rest, flags, workspaceDir } = ctx;
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
    const synced = syncAllCompositionBridges(sequence, paths, { explicit: true });
    const updatedCount = synced.filter((s) => s.updated).length;
    emitEnvelopeJson(workspaceDir, "composition.sync", {
      action: "composition.sync",
      updated: updatedCount > 0,
      updated_count: updatedCount,
      total_count: synced.length,
      auto_sync_policy:
        "Bridge files (cuthol-data.json, cuthol-data.js, cuthol-vars.json, cuthol-runtime.js, extension assets) are automatically synced after sequence edits and media analysis; updated=true means files were written during this call, updated=false means disk files already matched the current sequence state.",
      synced,
    });
    return;
  }

  if (action === "coords") {
    const cueId = strFlag(flags, "cue") ?? strFlag(flags, "id");
    const all = boolFlag(flags, "all", false) === true;
    const atRaw = strFlag(flags, "at");
    const framesRaw = strFlag(flags, "frames");
    const elementsRaw = strFlag(flags, "elements");
    const refresh = boolFlag(flags, "refresh", false) === true;
    // Geometry query: --elements, or --at with time syntax (bare frames stay legacy).
    const wantsGeometry =
      elementsRaw !== undefined || (atRaw !== undefined && isGeometryAtValue(atRaw));
    if (wantsGeometry) {
      if (cueId && all) {
        throw new CutholError(
          DIAGNOSTICS.UNKNOWN_FLAG(
            "--cue + --all",
            "composition.coords",
            "cuthol composition coords --at <moment> --cue <cue_XX> | --all"
          )
        );
      }
      if (framesRaw !== undefined) {
        throw geometryMisuseError(
          "--frames (frame ranges list boxes; the geometry query needs one --at moment)"
        );
      }
      if (atRaw === undefined) {
        throw geometryMisuseError("--elements (the geometry query needs one --at moment)");
      }
      // Async measurement inside a sync handler: argument misuse throws above (handled by
      // the cli.ts catch); measurement errors are emitted below. The process stays alive
      // on the browser/static-server handles until the envelope is written.
      runGeometryQuery({
        workspaceDir,
        cueId,
        all,
        atRaw,
        elementsRaw,
        refresh,
      }).then(
        (res) => {
          emitEnvelopeJson(workspaceDir, "composition.coords", {
            action: "composition.coords",
            ...res,
          });
        },
        (err: unknown) => {
          emitCoordsAsyncError(err);
        }
      );
      return;
    }
    if ((cueId ? 1 : 0) + (all ? 1 : 0) !== 1) {
      throw new CutholError(
        DIAGNOSTICS.UNKNOWN_FLAG(
          cueId && all ? "--cue + --all" : "--cue/--all (missing target)",
          "composition.coords",
          "cuthol composition coords --cue <cue_XX> | --all"
        )
      );
    }
    const query = parseCoordsFrameSelector(strFlag(flags, "frames"), strFlag(flags, "at"));
    // Async measurement inside a sync handler: argument misuse throws above (handled by
    // the cli.ts catch); measurement errors are emitted below. The process stays alive
    // on the browser/static-server handles until the envelope is written.
    measureCompositionCues({
      workspaceDir,
      cueIds: cueId ? [cueId] : undefined,
      all,
      refresh,
      querySequenceFrames: query,
    }).then(
      (res) => {
        emitEnvelopeJson(workspaceDir, "composition.coords", {
          action: "composition.coords",
          ...res,
        });
      },
      (err: unknown) => {
        emitCoordsAsyncError(err);
      }
    );
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
  return CLI_NOT_HANDLED;
}

export function runCueCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, rest, flags, workspaceDir } = ctx;
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
  return CLI_NOT_HANDLED;
}
