// CLI 'spine' command group handler (split out of cli.ts).
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import {
  ParameterEnvelope,
  ParameterEnvelopePoint,
  SpatialPlacement,
  TransitionSpec,
} from "./core/schema.js";
import { parseTimeMs } from "./core/time.js";
import {
  appendSpineClip,
  exciseSpineRanges,
  reframeSpineClips,
  removeSpineClips,
  reorderSpineClip,
  setItemEnvelope,
  setSpineMute,
  setSpineSpeed,
  setSpineTransition,
  splitSpineClip,
  transformSpineClip,
  trimSpineClip,
} from "./sequence/spine.js";
import { boolFlag, numFlag, strFlag } from "./cli_args.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";

export function runSpineCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, rest, flags, workspaceDir } = ctx;
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

  if (action === "mute" || action === "unmute") {
    const clipsRaw = strFlag(flags, "clips") ?? strFlag(flags, "clip") ?? rest[0];
    const allSpineFlag = boolFlag(flags, "all-spine", false) || !clipsRaw;
    const clipIds = allSpineFlag
      ? undefined
      : clipsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    const mutedVal =
      action === "unmute"
        ? false
        : boolFlag(flags, "muted", true) ?? true;
    const res = setSpineMute({
      workspaceDir,
      clipIds,
      allSpine: allSpineFlag,
      muted: mutedVal,
    });
    const cmdName = mutedVal ? "spine.mute" : "spine.unmute";
    emitEnvelopeJson(workspaceDir, cmdName, { action: cmdName, ...res });
    return;
  }
  return CLI_NOT_HANDLED;
}
