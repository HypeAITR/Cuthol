// CLI 'verify', 'monitor', 'render', and 'brief' command group handlers (split out of cli.ts).
import { BriefLens, renderSequenceBrief } from "./brief/inspector.js";
import { RenderPreset } from "./compositor/compiler.js";
import { VerificationGateId } from "./core/diagnostics.js";
import { parseTimeMs } from "./core/time.js";
import { loadSequence } from "./core/workspace.js";
import { captureMonitorFrame, captureMonitorSheet } from "./monitor/preview.js";
import { captureMonitorTimeline } from "./monitor/timeline_view.js";
import { renderSequenceToMp4 } from "./render/renderer.js";
import { runWorkspaceVerification } from "./verify/gates.js";
import { boolFlag, numFlag, strFlag } from "./cli_args.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";

export function runVerifyCommand(ctx: CliCommandContext): CliCommandResult {
  const { flags, workspaceDir } = ctx;
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

export function runMonitorCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, rest, flags, workspaceDir } = ctx;
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
    const hasExplicitGrid = flags["grid"] !== undefined;
    const gridRaw = strFlag(flags, "grid", "3x3")!;
    const [cStr, rStr] = gridRaw.toLowerCase().split("x");
    const cols = Number(cStr) || 3;
    const rows = Number(rStr) || 3;
    const startRaw = strFlag(flags, "start");
    const endRaw = strFlag(flags, "end");
    const atRaw = strFlag(flags, "at");
    const atMs = atRaw
      ? atRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => parseTimeMs(s))
      : undefined;
    const res = captureMonitorSheet({
      workspaceDir,
      startMs: startRaw ? parseTimeMs(startRaw) : undefined,
      endMs: endRaw ? parseTimeMs(endRaw) : undefined,
      atMs,
      cols: atMs && !hasExplicitGrid ? undefined : cols,
      rows: atMs && !hasExplicitGrid ? undefined : rows,
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
  return CLI_NOT_HANDLED;
}

export function runRenderCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, rest, flags, workspaceDir } = ctx;
  const isActionPreset = action === "draft_480p" || action === "master_1080p";
  const preset =
    (strFlag(flags, "preset", isActionPreset ? (action as RenderPreset) : "master_1080p") as RenderPreset) ??
    "master_1080p";
  const outPath = strFlag(flags, "out") ?? (isActionPreset ? rest[0] : action ?? rest[0]);
  const workers = numFlag(flags, "workers");
  const encoderRaw = strFlag(flags, "encoder") as "auto" | "nvenc" | "libx264" | undefined;
  const res = renderSequenceToMp4({
    workspaceDir,
    preset,
    outputPath: outPath,
    workers,
    encoder: encoderRaw,
  });
  emitEnvelopeJson(workspaceDir, "render", { ...res });
  return;
}

export function runBriefCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, flags, workspaceDir } = ctx;
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
