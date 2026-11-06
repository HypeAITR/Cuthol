// CLI 'verify', 'monitor', 'render', and 'brief' command group handlers (split out of cli.ts).
import { BriefLens, renderSequenceBrief } from "./brief/inspector.js";
import { detectExternalChanges, formatExternalNotice } from "./core/external_changes.js";
import { RenderPreset } from "./compositor/compiler.js";
import { CutholDiagnostic, DIAGNOSTICS, VerificationGateId } from "./core/diagnostics.js";
import { parseTimeMs } from "./core/time.js";
import { computeSequenceDurationMs } from "./core/timeline.js";
import { loadSequence, toExternalChangesSummary } from "./core/workspace.js";
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

const BARE_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;
const NUMBER_WITH_UNIT = /^[+-]?\d+(?:\.\d+)?\s*(?:ms|s|sec|min|us)$/i;

/** Warn when several bare numbers are all under 1000 ms on a sequence of at least 10s. */
function unitlessAtWarning(atRaw: string | undefined, sequenceDurationMs: number): CutholDiagnostic | null {
  if (!atRaw || sequenceDurationMs < 10_000) return null;
  const bare: number[] = [];
  for (const token of atRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (token.includes(":") || NUMBER_WITH_UNIT.test(token)) continue;
    if (!BARE_NUMBER.test(token)) continue;
    bare.push(Number(token));
  }
  if (bare.length < 2 || !bare.every((n) => n < 1000)) return null;
  return DIAGNOSTICS.UNITLESS_TIME_AS_MS();
}

function attachAtWarning<T extends { diagnostics: CutholDiagnostic[] }>(
  workspaceDir: string,
  atRaw: string | undefined,
  result: T
): T {
  const durationMs = computeSequenceDurationMs(loadSequence(workspaceDir).sequence);
  const warning = unitlessAtWarning(atRaw, durationMs);
  if (!warning) return result;
  return { ...result, diagnostics: [...result.diagnostics, warning] };
}

export function runVerifyCommand(ctx: CliCommandContext): CliCommandResult {
  const { flags, workspaceDir } = ctx;
  const gatesRaw = strFlag(flags, "gates");
  const gates =
    gatesRaw && gatesRaw !== "all"
      ? (gatesRaw.split(",").map((s) => s.trim()) as VerificationGateId[])
      : undefined;
  // Verify never touches coordinates: no measuring, no browser, no flags.
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
    emitEnvelopeJson(workspaceDir, "monitor.frame", { ...attachAtWarning(workspaceDir, atRaw, res) });
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
    emitEnvelopeJson(workspaceDir, "monitor.sheet", { ...attachAtWarning(workspaceDir, atRaw, res) });
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
  const overlayRes = strFlag(flags, "overlay-res");
  const res = renderSequenceToMp4({
    workspaceDir,
    preset,
    outputPath: outPath,
    workers,
    encoder: encoderRaw,
    overlayRes,
  });
  emitEnvelopeJson(workspaceDir, "render", { ...res });
  return;
}

export function runBriefCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, flags, workspaceDir, formatFlag } = ctx;
  const { sequence } = loadSequence(workspaceDir);
  // External-change top line (null when clean: outputs stay byte-identical).
  let extChanges: ReturnType<typeof detectExternalChanges> | null = null;
  let extNotice: string | null = null;
  try {
    extChanges = detectExternalChanges(workspaceDir);
    extNotice = formatExternalNotice(extChanges, "cli");
  } catch {
    extChanges = null;
    extNotice = null;
  }
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

  if (flags["json"] || formatFlag === "json") {
    emitEnvelopeJson(workspaceDir, "brief", {
      lens,
      sequence,
      ...(extChanges && extNotice ? { external_changes: toExternalChangesSummary(extChanges, extNotice) } : {}),
    });
    return;
  }

  const md = renderSequenceBrief(sequence, {
    lens,
    targetIds,
    windowStartMs,
    windowEndMs,
    ...(extNotice ? { noticeLine: extNotice } : {}),
  });
  console.log(md);
  return;
}
