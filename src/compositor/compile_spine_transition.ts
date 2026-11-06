// Spine transitions (`clip.transition_out`). Built-in kinds plus kinds that enabled
// extensions register (`ext:<extension>/<name>`, manifest `transitions` section,
// extensions/ext_transitions.ts). compile_spine.ts calls these hooks at fixed points:
//   - transitionHoldTailMs           → how long the outgoing clip stays drawn under the next one
//   - incomingTransitionScaleFactor  → time-varying scale factor of the incoming clip (null = none)
//   - buildOutgoingTransitionFilters → filters appended to the outgoing clip chain (after opacity)
//   - buildIncomingTransitionFilters → filters appended to the incoming clip chain (after the outgoing ones)
//   - applyIncomingTransitionPosition→ overlay x/y expressions of the incoming clip
//   - applyOutgoingTransitionPosition→ overlay x/y expressions of the outgoing clip
//
// Built-in kinds compile as they always have (they ignore `easing`, as before). Extension kinds resolve
// their manifest template through the sequence effect registry; unknown/disabled kinds fail with G122
// (never a silent dissolve) and bad params with G123. `cubic_bezier` easing rides the shared cubic-bezier solver.
// `incomingTransitionScaleFactor` cannot see the registry (its call site passes no compile context and
// compile_spine.ts is frozen), so extension incoming scale compiles through the clip chain
// (`scale` + centered `pad` in buildIncomingTransitionFilters) instead of the dynamic-scale path.
import type { CutholSequence, EffectParamValue, TransitionSpec } from "../core/schema.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { compileCubicBezierEasedU, cubicBezierIssue } from "../core/easing.js";
import type { VideoGraphCompileContext } from "./compiler.js";
import { compileEnvelopeToFfmpegExpr } from "./compile_filters.js";
import {
  getSequenceEffectRegistry,
  isExtensionEffectRef,
  parseExtensionEffectRef,
} from "../extensions/ext_effects.js";
import type { ExtensionTransitionSpec } from "../extensions/ext_transitions.js";
import {
  resolveTransitionParams,
  substituteTransitionTemplate,
} from "../extensions/ext_transitions.js";

type SpineClipSpec = CutholSequence["spine"]["clips"][number];

interface ResolvedExtTransition {
  spec: ExtensionTransitionSpec;
  params: Record<string, EffectParamValue>;
}

/** Seconds with the builtin overlay formatting (`Number(x.toFixed(3))`, e.g. 2, 0.4). */
function numSec(ms: number): number {
  return Number((ms / 1000).toFixed(3));
}

/** Seconds with the builtin filter formatting (`x.toFixed(3)`, e.g. "2.000", "0.400"). */
function strSec(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/**
 * Eased progress expression over the linear progress `u` (an ffmpeg expression in `t`,
 * 0 at the transition start, 1 at its end). Clamped to [0,1] before easing so templates rest at
 * their start pose before the window and at their end pose after it. Curve shapes mirror the
 * envelope compiler; `cubic_bezier` uses the shared cubic-bezier solver, `hold`/unknown names throw G120.
 */
function easedProgressExpr(u: string, transition: TransitionSpec, subjectId: string): string {
  const c = `min(max(${u},0),1)`;
  switch (transition.easing) {
    case "linear":
      return `(${c})`;
    case "ease_in":
      return `(pow(${c},2))`;
    case "ease_out":
      return `(1-pow(1-${c},2))`;
    case "ease_in_out":
      return `(pow(${c},2)*(3-2*${c}))`;
    case "hold":
      // A step makes no visible transition (progress sticks at 0, then jumps to 1 at the end).
      throw new CutholError(DIAGNOSTICS.EASING_HOLD_IN_TRANSITION(subjectId));
    default:
      // Unreachable via validated inputs (CLI, cue sheet and verify reject these with G120 first).
      throw new CutholError(
        DIAGNOSTICS.EASING_NAME_INVALID(`${subjectId} transition`, String(transition.easing))
      );
    case "cubic_bezier": {
      const issue = cubicBezierIssue(transition.bezier);
      if (issue) {
        throw new CutholError(DIAGNOSTICS.CUBIC_BEZIER_INVALID(`${subjectId} transition`, issue));
      }
      return compileCubicBezierEasedU(transition.bezier!, c);
    }
  }
}

/**
 * Resolves an `ext:` transition against the enabled extensions. Throws G122 when the kind is
 * malformed or unregistered, G123 when its params are invalid.
 */
function resolveExtTransition(
  ctx: VideoGraphCompileContext,
  kind: string,
  transition: TransitionSpec,
  clipId: string
): ResolvedExtTransition {
  const ref = isExtensionEffectRef(kind) ? parseExtensionEffectRef(kind) : null;
  if (!ref) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_TRANSITION_UNAVAILABLE(
        kind,
        `not in 'ext:<extension>/<name>' form (lowercase, [a-z0-9_-]).`,
        clipId
      )
    );
  }
  const registry = getSequenceEffectRegistry(ctx.seq, ctx.paths.rootDir);
  const def = registry.transitions.get(kind as `ext:${string}/${string}`);
  if (!def) {
    const loadErr = registry.load_errors.get(ref.extension);
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_TRANSITION_UNAVAILABLE(
        kind,
        loadErr
          ? `extension '${ref.extension}' failed to load: ${loadErr}`
          : `extension '${ref.extension}' is not enabled in the project, or does not define the '${ref.name}' transition.`,
        clipId
      )
    );
  }
  const params = resolveTransitionParams(def.spec, transition.params, kind, clipId);
  return { spec: def.spec, params };
}

/** Outgoing clip hold under the next clip (ms). `fade` and the last clip hold nothing. */
export function transitionHoldTailMs(clip: SpineClipSpec, hasNextClip: boolean): number {
  const outTrans = clip.transition_out;
  return hasNextClip && outTrans && outTrans.kind !== "fade" ? outTrans.duration_ms : 0;
}

/** Scale multiplier expression (ffmpeg, local clip time `t`) for the incoming clip, or null when unscaled. */
export function incomingTransitionScaleFactor(incomingTransition: TransitionSpec | null): string | null {
  if (!incomingTransition || incomingTransition.duration_ms <= 0 || incomingTransition.kind !== "zoom_in") return null;
  const inDurSec = (incomingTransition.duration_ms / 1000).toFixed(3);
  return `if(lt(t,${inDurSec}),0.88+0.12*(t/${inDurSec}),1)`;
}

function nextClipCoversStage(seq: CutholSequence, i: number, outTrans: TransitionSpec | null): boolean {
  const nextClip = i < seq.spine.clips.length - 1 ? seq.spine.clips[i + 1] : null;
  return (
    nextClip !== null &&
    outTrans?.kind !== "zoom_in" &&
    Math.abs(nextClip.placement.scale_x) >= 0.999 &&
    Math.abs(nextClip.placement.scale_y) >= 0.999 &&
    Math.abs(nextClip.placement.x_pct) < 0.01 &&
    Math.abs(nextClip.placement.y_pct) < 0.01 &&
    Math.abs(nextClip.placement.rotation_deg) < 0.01 &&
    !nextClip.placement.crop &&
    nextClip.placement.fit_mode !== "contain" &&
    nextClip.placement.opacity >= 0.999 &&
    !nextClip.envelopes.some(
      (e) =>
        e.parameter === "placement.scale_x" ||
        e.parameter === "placement.scale_y" ||
        e.parameter === "placement.x_pct" ||
        e.parameter === "placement.y_pct" ||
        e.parameter === "placement.rotation_deg" ||
        e.parameter === "placement.opacity"
    )
  );
}

function buildBuiltinOutgoingFilters(
  ctx: VideoGraphCompileContext,
  params: { i: number; clip: SpineClipSpec; hasNextClip: boolean; outTrans: TransitionSpec }
): string[] {
  const { i, clip, hasNextClip, outTrans } = params;
  const out: string[] = [];
  const fadeDurSec = (outTrans.duration_ms / 1000).toFixed(3);
  if (!hasNextClip || outTrans.kind === "fade") {
    const fadeStartSec = Math.max(0, (clip.duration_ms - outTrans.duration_ms) / 1000).toFixed(3);
    out.push(`fade=t=out:st=${fadeStartSec}:d=${fadeDurSec}:alpha=1`);
  } else if (nextClipCoversStage(ctx.seq, i, outTrans)) {
    // Hold last frame at 100% alpha under full-frame incoming next clip so total opacity stays 1.0 (zero backdrop bleed)
    out.push(`tpad=stop_mode=clone:stop_duration=${fadeDurSec}`);
  } else {
    const holdFadeStartSec = (clip.duration_ms / 1000).toFixed(3);
    out.push(
      `tpad=stop_mode=clone:stop_duration=${fadeDurSec}`,
      `fade=t=out:st=${holdFadeStartSec}:d=${fadeDurSec}:alpha=1`
    );
  }
  return out;
}

function buildExtOutgoingFilters(
  ctx: VideoGraphCompileContext,
  params: { clip: SpineClipSpec; hasNextClip: boolean; outTrans: TransitionSpec }
): string[] {
  const { clip, hasNextClip, outTrans } = params;
  const kind = outTrans.kind;
  const { spec, params: tParams } = resolveExtTransition(ctx, kind, outTrans, clip.id);
  const durSec = strSec(outTrans.duration_ms);
  const hold = hasNextClip && spec.hold_outgoing !== false;
  // Held transitions run over the tail [clipDur, clipDur+dur]; fade-like ones (`hold_outgoing: false`,
  // or the last clip with no next clip) run over the clip's own tail [clipDur-dur, clipDur].
  const winStartMs = hold ? clip.duration_ms : Math.max(0, clip.duration_ms - outTrans.duration_ms);
  const t0Num = numSec(winStartMs);
  const dtNum = numSec(outTrans.duration_ms);
  const u = t0Num === 0 ? `(t/${dtNum})` : `((t-${t0Num})/${dtNum})`;
  const p = easedProgressExpr(u, outTrans, clip.id);
  const vars = { t0: strSec(winStartMs), dur: durSec, p };
  const out: string[] = [];
  if (hold) {
    out.push(`tpad=stop_mode=clone:stop_duration=${durSec}`);
  } else if (hasNextClip) {
    // No hold: fade out over the clip tail so the timeline tail (kept for layout) renders transparent.
    out.push(`fade=t=out:st=${strSec(winStartMs)}:d=${durSec}:alpha=1`);
  }
  if (spec.outgoing_filter) {
    out.push(substituteTransitionTemplate(spec.outgoing_filter, vars, tParams, kind, clip.id));
  }
  return out;
}

/** Outgoing side: fade out, or hold the last frame under the next clip (no Porter-Duff alpha dip). */
export function buildOutgoingTransitionFilters(
  ctx: VideoGraphCompileContext,
  params: { i: number; clip: SpineClipSpec; hasNextClip: boolean; outTrans: TransitionSpec | null }
): string[] {
  const { outTrans } = params;
  if (!outTrans || outTrans.duration_ms <= 0) return [];
  if (outTrans.kind.startsWith("ext:")) {
    return buildExtOutgoingFilters(ctx, { clip: params.clip, hasNextClip: params.hasNextClip, outTrans });
  }
  return buildBuiltinOutgoingFilters(ctx, {
    i: params.i,
    clip: params.clip,
    hasNextClip: params.hasNextClip,
    outTrans,
  });
}

/**
 * Chain frame size at the transition stage (stage 6), mirroring the static/dynamic target and the
 * rotation bounding box computed in compile_spine.ts. Extension transitions never set the dynamic
 * zoom factor, so only placement scale envelopes make it dynamic here.
 */
function extChainFrameSize(
  ctx: VideoGraphCompileContext,
  clip: SpineClipSpec
): { w: number; h: number } {
  const { renderWidth, renderHeight } = ctx;
  const spSxExpr = compileEnvelopeToFfmpegExpr({
    envelope: clip.envelopes.find((e) => e.parameter === "placement.scale_x"),
    timeBaseOffsetMs: 0,
    mode: "raw",
  });
  const spSyExpr = compileEnvelopeToFfmpegExpr({
    envelope: clip.envelopes.find((e) => e.parameter === "placement.scale_y"),
    timeBaseOffsetMs: 0,
    mode: "raw",
  });
  const dynamic = Boolean(spSxExpr || spSyExpr);
  const targetW = dynamic
    ? renderWidth
    : Math.max(8, Math.round((renderWidth * Math.abs(clip.placement.scale_x)) / 2) * 2);
  const targetH = dynamic
    ? renderHeight
    : Math.max(8, Math.round((renderHeight * Math.abs(clip.placement.scale_y)) / 2) * 2);
  const radAbs = (Math.abs(clip.placement.rotation_deg) * Math.PI) / 180;
  if (Math.abs(clip.placement.rotation_deg) <= 0.01) return { w: targetW, h: targetH };
  return {
    w: Math.round(targetW * Math.abs(Math.cos(radAbs)) + targetH * Math.abs(Math.sin(radAbs))),
    h: Math.round(targetW * Math.abs(Math.sin(radAbs)) + targetH * Math.abs(Math.cos(radAbs))),
  };
}

function buildExtIncomingFilters(
  ctx: VideoGraphCompileContext,
  params: { clip: SpineClipSpec; incomingTransition: TransitionSpec }
): string[] {
  const { clip, incomingTransition } = params;
  const kind = incomingTransition.kind;
  const { spec, params: tParams } = resolveExtTransition(ctx, kind, incomingTransition, clip.id);
  const durSec = strSec(incomingTransition.duration_ms);
  const dtNum = numSec(incomingTransition.duration_ms);
  const p = easedProgressExpr(`(t/${dtNum})`, incomingTransition, clip.id);
  const vars = { t0: strSec(0), dur: durSec, p };
  const out: string[] = [];
  if (spec.incoming_scale) {
    const factor = substituteTransitionTemplate(spec.incoming_scale, vars, tParams, kind, clip.id);
    const guarded = `if(lt(t,${durSec}),(${factor}),1)`;
    const { w, h } = extChainFrameSize(ctx, clip);
    out.push(
      `scale=w='iw*(${guarded})':h='ih*(${guarded})':eval=frame`,
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`
    );
  }
  if (spec.incoming_filter) {
    out.push(substituteTransitionTemplate(spec.incoming_filter, vars, tParams, kind, clip.id));
  }
  return out;
}

/** Incoming side, in the clip chain (alpha fades). Position-based kinds are handled in the overlay. */
export function buildIncomingTransitionFilters(
  _ctx: VideoGraphCompileContext,
  params: { clip: SpineClipSpec; incomingTransition: TransitionSpec | null }
): string[] {
  const { incomingTransition } = params;
  if (!incomingTransition || incomingTransition.duration_ms <= 0) return [];
  if (incomingTransition.kind.startsWith("ext:")) {
    return buildExtIncomingFilters(_ctx, { clip: params.clip, incomingTransition });
  }
  const inDurSec = (incomingTransition.duration_ms / 1000).toFixed(3);
  if (
    incomingTransition.kind === "dissolve" ||
    incomingTransition.kind === "fade" ||
    incomingTransition.kind === "zoom_in"
  ) {
    return [`fade=t=in:st=0:d=${inDurSec}:alpha=1`];
  }
  return [];
}

function applyExtOutgoingPosition(
  ctx: VideoGraphCompileContext,
  params: { clip: SpineClipSpec; hasNextClip: boolean; outTrans: TransitionSpec; xExpr: string; yExpr: string }
): { xExpr: string; yExpr: string } {
  const { clip, hasNextClip, outTrans } = params;
  let { xExpr, yExpr } = params;
  const kind = outTrans.kind;
  const { spec, params: tParams } = resolveExtTransition(ctx, kind, outTrans, clip.id);
  if (!spec.outgoing_x && !spec.outgoing_y) return { xExpr, yExpr };
  const hold = hasNextClip && spec.hold_outgoing !== false;
  const winStartMs = hold ? clip.timeline_in_ms + clip.duration_ms : clip.timeline_in_ms + clip.duration_ms - outTrans.duration_ms;
  const t0 = numSec(winStartMs);
  const dt = numSec(outTrans.duration_ms);
  const t1 = numSec(winStartMs + outTrans.duration_ms);
  const p = easedProgressExpr(`((t-${t0})/${dt})`, outTrans, clip.id);
  const vars = {
    t0: String(t0),
    t1: String(t1),
    dur: strSec(outTrans.duration_ms),
    p,
    W: String(ctx.renderWidth),
    H: String(ctx.renderHeight),
    x: xExpr,
    y: yExpr,
  };
  if (spec.outgoing_x) xExpr = substituteTransitionTemplate(spec.outgoing_x, vars, tParams, kind, clip.id);
  if (spec.outgoing_y) yExpr = substituteTransitionTemplate(spec.outgoing_y, vars, tParams, kind, clip.id);
  return { xExpr, yExpr };
}

/**
 * Outgoing side, in the overlay (called after applyIncomingTransitionPosition). Identity for the built-in kinds;
 * transitions that move the outgoing clip (e.g. a push) change x/y here. `t` is sequence time; the outgoing clip's
 * transition starts at `clip.timeline_in_ms + clip.duration_ms` (it is held under the next clip, see
 * transitionHoldTailMs).
 */
export function applyOutgoingTransitionPosition(
  _ctx: VideoGraphCompileContext,
  params: { clip: SpineClipSpec; hasNextClip: boolean; outTrans: TransitionSpec | null; xExpr: string; yExpr: string }
): { xExpr: string; yExpr: string } {
  const { outTrans } = params;
  if (outTrans && outTrans.duration_ms > 0 && outTrans.kind.startsWith("ext:")) {
    return applyExtOutgoingPosition(_ctx, {
      clip: params.clip,
      hasNextClip: params.hasNextClip,
      outTrans,
      xExpr: params.xExpr,
      yExpr: params.yExpr,
    });
  }
  return { xExpr: params.xExpr, yExpr: params.yExpr };
}

function applyExtIncomingPosition(
  ctx: VideoGraphCompileContext,
  params: { clip: SpineClipSpec; incomingTransition: TransitionSpec; xExpr: string; yExpr: string }
): { xExpr: string; yExpr: string } {
  const { clip, incomingTransition } = params;
  let { xExpr, yExpr } = params;
  const kind = incomingTransition.kind;
  const { spec, params: tParams } = resolveExtTransition(ctx, kind, incomingTransition, clip.id);
  if (!spec.incoming_x && !spec.incoming_y) return { xExpr, yExpr };
  const t0 = numSec(clip.timeline_in_ms);
  const dt = numSec(incomingTransition.duration_ms);
  const t1 = numSec(clip.timeline_in_ms + incomingTransition.duration_ms);
  const p = easedProgressExpr(`((t-${t0})/${dt})`, incomingTransition, clip.id);
  const vars = {
    t0: String(t0),
    t1: String(t1),
    dur: strSec(incomingTransition.duration_ms),
    p,
    W: String(ctx.renderWidth),
    H: String(ctx.renderHeight),
    x: xExpr,
    y: yExpr,
  };
  if (spec.incoming_x) xExpr = substituteTransitionTemplate(spec.incoming_x, vars, tParams, kind, clip.id);
  if (spec.incoming_y) yExpr = substituteTransitionTemplate(spec.incoming_y, vars, tParams, kind, clip.id);
  return { xExpr, yExpr };
}

/** Incoming side, in the overlay: wipe/slide move the clip in from outside the stage. `t` is sequence time. */
export function applyIncomingTransitionPosition(
  ctx: VideoGraphCompileContext,
  params: { clip: SpineClipSpec; incomingTransition: TransitionSpec | null; xExpr: string; yExpr: string }
): { xExpr: string; yExpr: string } {
  const { renderWidth, renderHeight } = ctx;
  const { clip, incomingTransition } = params;
  let { xExpr, yExpr } = params;
  if (incomingTransition && incomingTransition.duration_ms > 0) {
    if (incomingTransition.kind.startsWith("ext:")) {
      return applyExtIncomingPosition(ctx, { clip, incomingTransition, xExpr, yExpr });
    }
    const t0 = Number((clip.timeline_in_ms / 1000).toFixed(3));
    const dt = Number((incomingTransition.duration_ms / 1000).toFixed(3));
    const t1 = Number((t0 + dt).toFixed(3));
    if (incomingTransition.kind === "wipe_left") {
      xExpr = `if(lt(t,${t1}),${renderWidth}-${renderWidth}*(t-${t0})/${dt},${xExpr})`;
    } else if (incomingTransition.kind === "wipe_right") {
      xExpr = `if(lt(t,${t1}),-${renderWidth}+${renderWidth}*(t-${t0})/${dt},${xExpr})`;
    } else if (incomingTransition.kind === "slide_up") {
      yExpr = `if(lt(t,${t1}),${renderHeight}-${renderHeight}*(t-${t0})/${dt},${yExpr})`;
    }
  }
  return { xExpr, yExpr };
}
