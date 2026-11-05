// CLI 'spine' command group handler (split out of cli.ts).
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import {
  ParameterEnvelope,
  ParameterEnvelopePoint,
  SpatialPlacement,
  SpeedRampPoint,
  TransitionSpec,
} from "./core/schema.js";
import { parseEasingFlag } from "./core/easing.js";
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
import { setSpineGrade } from "./sequence/spine_grade.js";
import { addSpineFx, listSpineFx, removeSpineFx, setSpineFx } from "./sequence/spine_fx.js";
import { boolFlag, numFlag, parseExciseRanges, parsePropsJsonFlag, strFlag } from "./cli_args.js";

function parseSpeedRampFlag(raw: string): SpeedRampPoint[] {
  const fail = (detail: string): never => {
    throw new CutholError(DIAGNOSTICS.INVALID_SPEED_RAMP(detail));
  };
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) fail(`'${raw}' içinde 'ofset:hız' çifti yok.`);
  return tokens.map((token) => {
    const sepIdx = token.lastIndexOf(":");
    if (sepIdx <= 0) fail(`'${token}' 'ofset:hız' biçiminde değil.`);
    const tStr = token.slice(0, sepIdx).trim();
    const vStr = token
      .slice(sepIdx + 1)
      .trim()
      .replace(/x$/i, "");
    let offsetMs: number;
    try {
      offsetMs = parseTimeMs(tStr);
    } catch {
      fail(`'${tStr}' geçerli bir zaman değil.`);
    }
    const rate = Number(vStr);
    if (!Number.isFinite(rate)) fail(`'${token}' hızı ('${vStr}') sayı değil.`);
    return { source_offset_ms: offsetMs!, rate };
  });
}
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";

function parseFxScalar(raw: string): number | string | boolean {
  const t = raw.trim();
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
  if (t !== "" && Number.isFinite(Number(t))) return Number(t);
  return raw;
}

function addFxPair(target: Record<string, unknown>, token: string): void {
  for (const piece of token.split(",")) {
    const eq = piece.indexOf("=");
    const name = eq > 0 ? piece.slice(0, eq).trim() : "";
    if (!name) {
      throw new Error(
        `'${piece.trim() || token}' bir ad=değer çifti değil; '--param sigma=4' biçiminde verin (birden çok parametre için bayrağı tekrarlayın).`
      );
    }
    target[name] = parseFxScalar(piece.slice(eq + 1));
  }
}

/**
 * Collects fx params from `--params '{"k":v}'` (MCP object path) plus every `--param k=v` occurrence.
 * `parseArgv` keeps only the last `--param`, so repeats are re-scanned from the raw argv; a single `--param`
 * may also carry comma-separated pairs.
 */
function collectSpineFxParams(flags: Record<string, string | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const rawJson = strFlag(flags, "params");
  if (rawJson !== undefined) {
    Object.assign(out, parsePropsJsonFlag(rawJson, "spine.fx"));
  }
  const argv = process.argv.slice(2);
  let sawArgvParam = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--param") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        addFxPair(out, next);
        sawArgvParam = true;
        i++;
      }
    } else if (tok.startsWith("--param=")) {
      addFxPair(out, tok.slice("--param=".length));
      sawArgvParam = true;
    }
  }
  if (!sawArgvParam) {
    const single = strFlag(flags, "param");
    if (single !== undefined) addFxPair(out, single);
  }
  return out;
}

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
    const ranges = parseExciseRanges(rangesRaw);
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
      edge: strFlag(flags, "edge") as SpatialPlacement["edge"] | undefined,
    });
    emitEnvelopeJson(workspaceDir, "spine.transform", { action: "spine.transform", ...res });
    return;
  }

  if (action === "speed") {
    const clipId = strFlag(flags, "clip") ?? rest[0];
    const rateRaw = strFlag(flags, "rate");
    const rampRaw = strFlag(flags, "ramp");
    if (!clipId || (!rateRaw && rampRaw === undefined)) {
      throw new Error('Provide --clip <sp_XX> --rate <1.5> or --ramp "0s:1,2s:4".');
    }
    const rampIsNone = rampRaw !== undefined && rampRaw.trim().toLowerCase() === "none";
    if (rateRaw && rampRaw !== undefined && !rampIsNone) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_SPEED_RAMP(
          `'--rate ${rateRaw}' ile '--ramp ${rampRaw}' bir arada verildi; rampa varken taban hız etkisizdir.`
        )
      );
    }
    const rate = rateRaw ? Number(rateRaw.replace(/x$/i, "")) : undefined;
    const speedRamp =
      rampRaw === undefined ? undefined : rampIsNone ? null : parseSpeedRampFlag(rampRaw);
    const res = setSpineSpeed({
      workspaceDir,
      clipId,
      rate,
      speedRamp,
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
    const { easing, bezier } = parseEasingFlag(strFlag(flags, "easing", "ease_in_out"), { allowHold: kind === "none", subject: clipId });
    const rawParamsJson = strFlag(flags, "params");
    const rawSingleParam = strFlag(flags, "param");
    let transitionParams: Record<string, string> | undefined;
    if (rawParamsJson) {
      const parsed = parsePropsJsonFlag(rawParamsJson, "spine.transition");
      transitionParams = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") transitionParams[k] = String(v);
        else throw new Error(`Value of '${k}' in --params must be a scalar (number, string or boolean).`);
      }
    }
    if (rawSingleParam) {
      transitionParams = transitionParams ?? {};
      for (const piece of rawSingleParam.split(",")) {
        const eq = piece.indexOf("=");
        const key = (eq >= 0 ? piece.slice(0, eq) : piece).trim();
        const value = eq >= 0 ? piece.slice(eq + 1) : "";
        if (!key || eq < 0) throw new Error(`--param must be name=value (got '${piece.trim()}'). Separate several params with commas: --param yon=sol,hiz=2.`);
        transitionParams[key] = value;
      }
    }
    const transition: TransitionSpec | null =
      kind === "none"
        ? null
        : {
            kind: kind as TransitionSpec["kind"],
            duration_ms: parseTimeMs(durRaw),
            easing,
            ...(bezier ? { bezier: [...bezier] } : {}),
            ...(transitionParams ? { params: transitionParams } : {}),
          };
    const res = setSpineTransition({ workspaceDir, clipId, transition });
    emitEnvelopeJson(workspaceDir, "spine.transition", { action: "spine.transition", ...res });
    return;
  }

  if (action === "grade") {
    const clipId = strFlag(flags, "clip") ?? rest[0];
    if (!clipId) throw new Error("Provide --clip <sp_XX>.");
    const brightnessRaw = strFlag(flags, "brightness");
    const contrastRaw = strFlag(flags, "contrast");
    const saturationRaw = strFlag(flags, "saturation");
    const temperatureRaw = strFlag(flags, "temperature");
    const lutRaw = strFlag(flags, "lut");
    if (
      brightnessRaw === undefined &&
      contrastRaw === undefined &&
      saturationRaw === undefined &&
      temperatureRaw === undefined &&
      lutRaw === undefined
    ) {
      throw new Error(
        "Provide at least one of --brightness, --contrast, --saturation, --temperature, --lut (use --lut none to clear)."
      );
    }
    const res = setSpineGrade({
      workspaceDir,
      clipId,
      brightness: brightnessRaw !== undefined ? Number(brightnessRaw) : undefined,
      contrast: contrastRaw !== undefined ? Number(contrastRaw) : undefined,
      saturation: saturationRaw !== undefined ? Number(saturationRaw) : undefined,
      temperatureK: temperatureRaw !== undefined ? Number(temperatureRaw) : undefined,
      lutUri:
        lutRaw !== undefined
          ? lutRaw.trim().toLowerCase() === "none"
            ? null
            : lutRaw
          : undefined,
    });
    emitEnvelopeJson(workspaceDir, "spine.grade", { action: "spine.grade", ...res });
    return;
  }

  if (action === "envelope") {
    const targetId = strFlag(flags, "clip") ?? strFlag(flags, "id") ?? rest[0];
    const parameter = strFlag(flags, "param") as ParameterEnvelope["parameter"] | undefined;
    const ptsRaw = strFlag(flags, "points");
    if (!targetId || !parameter || !ptsRaw) {
      throw new Error("Provide --clip <sp_XX|cue_XX> --param <name> --points <0ms:1.0,2000ms:1.15>.");
    }
    const { easing: defaultEasing, bezier: defaultBezier } =
      parseEasingFlag(strFlag(flags, "easing", "ease_in_out"));
    const points: ParameterEnvelopePoint[] = ptsRaw.split(",").map((token) => {
      const [tStr, vStr] = token.trim().split(":");
      return {
        offset_ms: parseTimeMs(tStr),
        value: Number(vStr),
        easing: defaultEasing,
        ...(defaultBezier ? { bezier: [...defaultBezier] } : {}),
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
  if (action === "fx") {
    const sub = rest[0];
    if (sub !== "add" && sub !== "set" && sub !== "remove" && sub !== "list") {
      throw new Error("Provide a subcommand: spine fx [add|set|remove|list] --clip <sp_XX> ...");
    }
    const clipId = strFlag(flags, "clip");
    if (!clipId) throw new Error("Provide --clip <sp_XX>.");
    if (sub === "add") {
      const kind = strFlag(flags, "kind");
      const filter = strFlag(flags, "filter");
      const res = addSpineFx({ workspaceDir, clipId, kind, filter, params: collectSpineFxParams(flags) });
      emitEnvelopeJson(workspaceDir, "spine.fx.add", { action: "spine.fx.add", ...res });
      return;
    }
    if (sub === "set") {
      const fxId = strFlag(flags, "fx") ?? strFlag(flags, "id");
      if (!fxId) throw new Error("Provide --fx <fx_XX>.");
      const filter = strFlag(flags, "filter");
      const params = collectSpineFxParams(flags);
      if (filter === undefined && Object.keys(params).length === 0) {
        throw new Error("Provide --param <ad=değer> or --filter \"<zincir>\".");
      }
      const res = setSpineFx({ workspaceDir, clipId, fxId, params, filter });
      emitEnvelopeJson(workspaceDir, "spine.fx.set", { action: "spine.fx.set", ...res });
      return;
    }
    if (sub === "remove") {
      const fxId = strFlag(flags, "fx") ?? strFlag(flags, "id");
      if (!fxId) throw new Error("Provide --fx <fx_XX>.");
      const res = removeSpineFx({ workspaceDir, clipId, fxId });
      emitEnvelopeJson(workspaceDir, "spine.fx.remove", { action: "spine.fx.remove", ...res });
      return;
    }
    const res = listSpineFx({ workspaceDir, clipId });
    emitEnvelopeJson(workspaceDir, "spine.fx.list", { action: "spine.fx.list", ...res });
    return;
  }
  return CLI_NOT_HANDLED;
}
