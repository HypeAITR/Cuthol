// Spine clip stage 7 — edge mode for transformed clips (`placement.edge`).
// Runs after rotation/opacity and transition filters, immediately before the sub-pixel
// scale/pan filters, i.e. on the clip at `targetW × targetH` (plus static rotation bounds) before it is moved
// on the stage. Default (`undefined` / "transparent") keeps today's behaviour: uncovered stage area shows what
// is below (backdrop or previous clip).
//
// Two constructions, chosen per clip (see planSpineClipEdge):
//   - strip: the axis-aligned frame grows with `pad` (transparent) and the grown ring is filled with
//     `fillborders` (`mode=mirror` reflects the clip at its edges, `mode=smear` stretches the edge pixels for
//     "clamp"). The overlay position shifts back by the grown offset so the content stays exactly where the
//     transparent mode would put it. Used when the frame is axis-aligned (no rotation, or a static multiple of
//     90 degrees whose frame stays fully opaque).
//   - derotate: a rotated frame's edge strips are transparent corner triangles, so strip mirroring cannot fill
//     them (and whole-image mirror tiles leave diamond gaps — both verified empirically). Instead the stage
//     de-rotates the frame, crops the clean axis-aligned content, fills a generous surround with the strip
//     method (both modes work on clean content), and rotates back. The surround rect R is sized so the rotated
//     R covers the stage for every overlay position and every rotation angle of the clip. This also fills
//     `contain` letterbox bars under rotation (they de-rotate into plain bands).
// `contain` bars on an axis-aligned frame are filled with the same mode (they are part of the clip frame;
// under a 90/270-degree static rotation the bar orientation is swapped accordingly).
import type { CutholSequence } from "../core/schema.js";
import { compileEnvelopeToFfmpegExpr } from "./compile_filters.js";
import type { VideoGraphCompileContext } from "./compiler.js";

type SpineClipSpec = CutholSequence["spine"]["clips"][number];
type EdgeMode = "mirror" | "clamp";

/** Padded ring thickness, in pixels, on each side of a frame. All zero = no surround needed. */
export interface SpineClipEdgePad {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const ZERO_PAD: SpineClipEdgePad = { left: 0, right: 0, top: 0, bottom: 0 };

/** Dynamic-scale growth factor cap: zoom-outs below ~1/3 of the stage may leave the rim uncovered. */
const MAX_DYNAMIC_GROWTH = 3;
/** Smallest scale honoured in the dynamic path (a 0 scale envelope would ask for an infinite frame). */
const MIN_DYNAMIC_SCALE = 0.02;
/** Rotated-fill rect cap, in stage units per side (absurd pan/spin envelopes degrade to partial cover). */
const MAX_FILL_RECT_STAGES = 3;

/** True when the edge stage needs the clip in RGBA (disables the opaque-footage RGBA skip in compile_spine.ts). */
export function spineClipEdgeRequiresRgba(clip: SpineClipSpec): boolean {
  return clip.placement.edge !== undefined && clip.placement.edge !== "transparent";
}

function assertEdgeKind(edge: string, clip: SpineClipSpec): asserts edge is EdgeMode | "transparent" {
  if (edge !== "transparent" && edge !== "mirror" && edge !== "clamp") {
    // Never ignore an unknown edge value silently: fail the compile loudly.
    throw new Error(`placement.edge '${edge}' is not supported (clip ${clip.id}); use transparent|mirror|clamp`);
  }
}

/** Presence check that matches compile_spine.ts exactly (it keys off the compiled expression, not raw points). */
function hasEnvelope(clip: SpineClipSpec, parameter: SpineClipSpec["envelopes"][number]["parameter"]): boolean {
  const env = clip.envelopes.find((e) => e.parameter === parameter);
  return compileEnvelopeToFfmpegExpr({ envelope: env, timeBaseOffsetMs: 0, mode: "raw" }) !== null;
}

/** Envelope point values, or null when the parameter has no envelope (caller falls back to the static value). */
function envelopeValues(clip: SpineClipSpec, parameter: SpineClipSpec["envelopes"][number]["parameter"]): number[] | null {
  if (!hasEnvelope(clip, parameter)) return null;
  return clip.envelopes.find((e) => e.parameter === parameter)!.points.map((p) => p.value);
}

/** Static-path target size; replicates compile_spine.ts (must stay in sync with it). */
function staticTargetSize(renderDim: number, scale: number): number {
  return Math.max(8, Math.round((renderDim * Math.abs(scale)) / 2) * 2);
}

/** Post-rotation frame size; replicates compile_spine.ts `rotate` bounds (verified against rotw/roth). */
function rotatedFrameSize(w: number, h: number, rotationDeg: number): { fw: number; fh: number } {
  if (Math.abs(rotationDeg) <= 0.01) return { fw: w, fh: h };
  const rad = (Math.abs(rotationDeg) * Math.PI) / 180;
  return {
    fw: Math.round(w * Math.abs(Math.cos(rad)) + h * Math.abs(Math.sin(rad))),
    fh: Math.round(w * Math.abs(Math.sin(rad)) + h * Math.abs(Math.cos(rad))),
  };
}

/** Safety margin per side: covers easing overshoot (cubic-bezier) and overlay rounding. Mirror padding is cheap. */
function safetyMarginPx(dimPx: number): number {
  return Math.max(8, Math.round(dimPx * 0.02));
}

/**
 * Minimum incoming-transition scale multiplier. `zoom_in` ramps 0.88 → 1 (see incomingTransitionScaleFactor in
 * compile_spine_transition.ts); every other kind leaves the scale untouched.
 */
function incomingTransitionMinScale(ctx: VideoGraphCompileContext, clip: SpineClipSpec): number {
  const clips = ctx.seq.spine.clips;
  const idx = clips.findIndex((c) => c.id === clip.id);
  const incoming = idx > 0 ? clips[idx - 1].transition_out : null;
  if (incoming && incoming.duration_ms > 0 && incoming.kind === "zoom_in") return 0.88;
  return 1;
}

interface RotationAnalysis {
  thetaDeg: number;
  hasRotEnv: boolean;
  thetaMin: number;
  thetaMax: number;
  /** Compiled rotation envelope in local clip time `t` (same call as compile_spine.ts), or null. */
  rotExpr: string | null;
  /** Static multiple of 90 degrees (frame stays opaque): the strip path still applies. */
  square: boolean;
}

function analyzeRotation(clip: SpineClipSpec): RotationAnalysis {
  const thetaDeg = clip.placement.rotation_deg;
  const rotEnv = clip.envelopes.find((e) => e.parameter === "placement.rotation_deg");
  const rotExpr = compileEnvelopeToFfmpegExpr({ envelope: rotEnv, timeBaseOffsetMs: 0, mode: "raw" });
  const hasRotEnv = rotExpr !== null;
  // Like every other placement parameter, an envelope replaces the static value (see compile_spine.ts).
  const thetaMin = hasRotEnv ? Math.min(...rotEnv!.points.map((p) => p.value)) : thetaDeg;
  const thetaMax = hasRotEnv ? Math.max(...rotEnv!.points.map((p) => p.value)) : thetaDeg;
  const m = ((thetaDeg % 90) + 90) % 90;
  const square = !hasRotEnv && (m < 0.01 || m > 89.99);
  return { thetaDeg, hasRotEnv, thetaMin, thetaMax, rotExpr, square };
}

/** Overlay top-left travel range over the clip (static-scale path), in stage pixels. */
interface TravelRange {
  xMinPx: number;
  xMaxPx: number;
  yMinPx: number;
  yMaxPx: number;
}

function staticTravelRange(baseCX: number, baseCY: number, renderW: number, renderH: number, xVals: number[], yVals: number[]): TravelRange {
  return {
    xMinPx: baseCX + (Math.min(...xVals) / 100) * renderW,
    xMaxPx: baseCX + (Math.max(...xVals) / 100) * renderW,
    yMinPx: baseCY + (Math.min(...yVals) / 100) * renderH,
    yMaxPx: baseCY + (Math.max(...yVals) / 100) * renderH,
  };
}

/**
 * Angles (degrees) at which the rotated-fill rect is sized. `|dx·cosθ + dy·sinθ|` between 15-degree samples
 * deviates by <1% of the amplitude, which the safety margin absorbs; a range spanning 180+ degrees covers a
 * full period, so the closed-form spin bound applies.
 */
function thetaSamplesForFill(thetaMin: number, thetaMax: number): { spin: boolean; samples: number[] } {
  if (thetaMax - thetaMin >= 180) return { spin: true, samples: [] };
  const samples = [thetaMin, thetaMax];
  if (thetaMin < 0 && thetaMax > 0) samples.push(0);
  for (let a = Math.ceil(thetaMin / 15) * 15; a < thetaMax; a += 15) samples.push(a);
  return { spin: false, samples: [...new Set(samples)] };
}

export type SpineEdgePlan =
  | { kind: "none" }
  | { kind: "strip"; pad: SpineClipEdgePad }
  | {
      kind: "derotate";
      rot: RotationAnalysis;
      /** Surround rect (axis-aligned, in the de-rotated domain) and its re-rotated bbox. */
      Rw: number;
      Rh: number;
      bboxW: number;
      bboxH: number;
      /** Overlay correction for a static angle (runtime-centering forms need none / re-anchor instead). */
      offX: number;
      offY: number;
      /** Ring from the clean content (w×h) to the surround rect. */
      ring: SpineClipEdgePad;
    };

/**
 * Sizes the rotated-fill rect R: the rotated R must cover the stage for every content-center position (cx range
 * × cy range) and every rotation angle. Both R and the stage are convex, so covering all stage corners from all
 * center corners covers everything.
 */
function sizeRotatedFillRect(
  renderW: number,
  renderH: number,
  cx0: number,
  cx1: number,
  cy0: number,
  cy1: number,
  thetaMin: number,
  thetaMax: number,
  contentW: number,
  contentH: number
): { Rw: number; Rh: number } {
  const { spin, samples } = thetaSamplesForFill(thetaMin, thetaMax);
  let maxLx = 0;
  let maxLy = 0;
  for (const cx of [cx0, cx1]) {
    for (const cy of [cy0, cy1]) {
      for (const sx of [0, renderW]) {
        for (const sy of [0, renderH]) {
          const dx = sx - cx;
          const dy = sy - cy;
          if (spin) {
            const hyp = Math.hypot(dx, dy);
            maxLx = Math.max(maxLx, hyp);
            maxLy = Math.max(maxLy, hyp);
          } else {
            for (const deg of samples) {
              const rad = (deg * Math.PI) / 180;
              maxLx = Math.max(maxLx, Math.abs(dx * Math.cos(rad) + dy * Math.sin(rad)));
              maxLy = Math.max(maxLy, Math.abs(-dx * Math.sin(rad) + dy * Math.cos(rad)));
            }
          }
        }
      }
    }
  }
  if (!Number.isFinite(maxLx) || !Number.isFinite(maxLy)) {
    throw new Error(`placement.edge: cannot size the fill (non-finite placement on the clip)`);
  }
  const Rw = Math.min(
    MAX_FILL_RECT_STAGES * renderW,
    Math.max(contentW, 2 * Math.ceil(maxLx + safetyMarginPx(renderW)))
  );
  const Rh = Math.min(
    MAX_FILL_RECT_STAGES * renderH,
    Math.max(contentH, 2 * Math.ceil(maxLy + safetyMarginPx(renderH)))
  );
  return { Rw, Rh };
}

/**
 * Surround thickness for the static-scale strip path. The overlay travel range [xMin..xMax] must satisfy
 * `x - left <= 0` and `x + fw + right >= renderW` for every x, hence `left >= xMax` and
 * `right >= renderW - fw - xMin` (same for y). Positional transitions are deliberately NOT included: during a
 * wipe/slide the held outgoing clip underneath is the correct backdrop.
 */
function edgePadForStaticPath(renderW: number, renderH: number, fw: number, fh: number, travel: TravelRange): SpineClipEdgePad {
  if (travel.xMaxPx + fw <= 0 || travel.xMinPx >= renderW || travel.yMaxPx + fh <= 0 || travel.yMinPx >= renderH) {
    return { ...ZERO_PAD };
  }
  const rawLeft = Math.ceil(travel.xMaxPx);
  const rawRight = Math.ceil(renderW - fw - travel.xMinPx);
  const rawTop = Math.ceil(travel.yMaxPx);
  const rawBottom = Math.ceil(renderH - fh - travel.yMinPx);
  if (rawLeft <= 0 && rawRight <= 0 && rawTop <= 0 && rawBottom <= 0) return { ...ZERO_PAD };
  const mx = safetyMarginPx(renderW);
  const my = safetyMarginPx(renderH);
  const clamp = (v: number, dim: number): number => Math.min(dim, Math.max(0, v));
  return {
    left: clamp(rawLeft + mx, renderW),
    right: clamp(rawRight + mx, renderW),
    top: clamp(rawTop + my, renderH),
    bottom: clamp(rawBottom + my, renderH),
  };
}

/**
 * Surround thickness for the dynamic-scale strip path (`spHasDynScale`). The stage-8 perspective maps the whole
 * input frame into a quad of `scale × frame`, so growing the frame by k keeps the content size (`scale × fw`)
 * identical while the grown quad must cover the stage plus the pan travel: `sxMin × fw × k >= renderW + 2×dxMax`.
 */
function edgePadForDynamicPath(
  renderW: number,
  renderH: number,
  fw: number,
  fh: number,
  sxMin: number,
  syMin: number,
  dxMaxPx: number,
  dyMaxPx: number
): SpineClipEdgePad {
  const mx = safetyMarginPx(renderW);
  const my = safetyMarginPx(renderH);
  const kx = (renderW + 2 * dxMaxPx + 2 * mx) / (sxMin * fw);
  const ky = (renderH + 2 * dyMaxPx + 2 * my) / (syMin * fh);
  let k = Math.max(kx, ky, 1);
  if (!Number.isFinite(k)) {
    throw new Error(`placement.edge: cannot size the fill ring (non-finite scale/offset on the clip)`);
  }
  k = Math.min(k, MAX_DYNAMIC_GROWTH);
  if (k <= 1) return { ...ZERO_PAD };
  const targetW = Math.ceil(fw * k);
  const targetH = Math.ceil(fh * k);
  const left = Math.floor((targetW - fw) / 2);
  const top = Math.floor((targetH - fh) / 2);
  return { left, right: targetW - fw - left, top, bottom: targetH - fh - top };
}

/**
 * Chooses the fill construction for a clip. Pure function of the placement + envelopes; shared by the filter
 * stage and the overlay hook so both agree on the grown geometry.
 */
export function planSpineClipEdge(
  ctx: VideoGraphCompileContext,
  clip: SpineClipSpec,
  targetW: number,
  targetH: number,
  hasDynamicScale: boolean
): SpineEdgePlan {
  const edge = clip.placement.edge;
  if (edge === undefined || edge === "transparent") return { kind: "none" };
  assertEdgeKind(edge, clip);
  const renderW = ctx.renderWidth;
  const renderH = ctx.renderHeight;
  const rot = analyzeRotation(clip);
  // compile_spine.ts always sizes from the static rotation (spEffW/spEffH), even with a rotation envelope.
  const { fw, fh } = rotatedFrameSize(targetW, targetH, rot.thetaDeg);
  const xVals = envelopeValues(clip, "placement.x_pct") ?? [clip.placement.x_pct];
  const yVals = envelopeValues(clip, "placement.y_pct") ?? [clip.placement.y_pct];

  if (!rot.hasRotEnv && (Math.abs(rot.thetaDeg) <= 0.01 || rot.square)) {
    // Strip path: the frame is (nearly) axis-aligned and fully opaque.
    if (!hasDynamicScale) {
      const baseCX = Math.round((renderW - fw) / 2);
      const baseCY = Math.round((renderH - fh) / 2);
      const travel = staticTravelRange(baseCX, baseCY, renderW, renderH, xVals, yVals);
      return { kind: "strip", pad: edgePadForStaticPath(renderW, renderH, fw, fh, travel) };
    }
    const sxVals = envelopeValues(clip, "placement.scale_x") ?? [clip.placement.scale_x];
    const syVals = envelopeValues(clip, "placement.scale_y") ?? [clip.placement.scale_y];
    const transMin = incomingTransitionMinScale(ctx, clip);
    const sxMin = Math.max(MIN_DYNAMIC_SCALE, Math.min(...sxVals.map((v) => Math.abs(v))) * transMin);
    const syMin = Math.max(MIN_DYNAMIC_SCALE, Math.min(...syVals.map((v) => Math.abs(v))) * transMin);
    return {
      kind: "strip",
      pad: edgePadForDynamicPath(
        renderW,
        renderH,
        fw,
        fh,
        sxMin,
        syMin,
        (Math.max(...xVals.map((v) => Math.abs(v))) / 100) * renderW,
        (Math.max(...yVals.map((v) => Math.abs(v))) / 100) * renderH
      ),
    };
  }

  // De-rotate path: content-center range over the clip, then the surround rect around it.
  let cx0: number;
  let cx1: number;
  let cy0: number;
  let cy1: number;
  if (!hasDynamicScale) {
    const baseCX = Math.round((renderW - fw) / 2);
    const baseCY = Math.round((renderH - fh) / 2);
    const travel = staticTravelRange(baseCX, baseCY, renderW, renderH, xVals, yVals);
    if (travel.xMaxPx + fw <= 0 || travel.xMinPx >= renderW || travel.yMaxPx + fh <= 0 || travel.yMinPx >= renderH) {
      return { kind: "none" };
    }
    cx0 = travel.xMinPx + fw / 2;
    cx1 = travel.xMaxPx + fw / 2;
    cy0 = travel.yMinPx + fh / 2;
    cy1 = travel.yMaxPx + fh / 2;
  } else {
    const dxMaxPx = (Math.max(...xVals.map((v) => Math.abs(v))) / 100) * renderW;
    const dyMaxPx = (Math.max(...yVals.map((v) => Math.abs(v))) / 100) * renderH;
    cx0 = renderW / 2 - dxMaxPx;
    cx1 = renderW / 2 + dxMaxPx;
    cy0 = renderH / 2 - dyMaxPx;
    cy1 = renderH / 2 + dyMaxPx;
  }
  const { Rw, Rh } = sizeRotatedFillRect(renderW, renderH, cx0, cx1, cy0, cy1, rot.thetaMin, rot.thetaMax, targetW, targetH);
  const bbox = rotatedFrameSize(Rw, Rh, rot.hasRotEnv ? Math.max(Math.abs(rot.thetaMin), Math.abs(rot.thetaMax)) : rot.thetaDeg);
  const ringLeft = Math.floor((Rw - targetW) / 2);
  const ringTop = Math.floor((Rh - targetH) / 2);
  return {
    kind: "derotate",
    rot,
    Rw,
    Rh,
    bboxW: bbox.fw,
    bboxH: bbox.fh,
    offX: Math.round((bbox.fw - fw) / 2),
    offY: Math.round((bbox.fh - fh) / 2),
    ring: { left: ringLeft, right: Rw - targetW - ringLeft, top: ringTop, bottom: Rh - targetH - ringTop },
  };
}

/**
 * `contain` letterbox bars, filled with the edge mode. The bars are transparent padding *inside* the clip frame,
 * so the surround ring never touches them; with an edge mode they become mirrored/stretched content instead of
 * a window onto the layer below. Skipped when the probe size is unknown. `swapBars` is set when the frame
 * carries a static 90/270-degree rotation (bars lie sideways in the frame).
 */
function containBarFillFilters(
  ctx: VideoGraphCompileContext,
  clip: SpineClipSpec,
  contentW: number,
  contentH: number,
  edge: EdgeMode,
  swapBars: boolean
): string[] {
  if (clip.placement.fit_mode !== "contain") return [];
  const asset = ctx.libMap?.get(clip.asset_handle);
  const probeW = asset?.probe.width ?? 0;
  const probeH = asset?.probe.height ?? 0;
  if (!(probeW > 0) || !(probeH > 0)) return [];
  // Effective source size after the stage-2 crop (replicates compile_spine.ts).
  const crop = clip.placement.crop;
  const wRatio = crop ? Math.max(0.05, 1 - (crop.left_pct + crop.right_pct) / 100) : 1;
  const hRatio = crop ? Math.max(0.05, 1 - (crop.top_pct + crop.bottom_pct) / 100) : 1;
  const sw = probeW * wRatio;
  const sh = probeH * hRatio;
  if (!(sw > 0) || !(sh > 0)) return [];
  // `scale=w:h:force_original_aspect_ratio=decrease` output, then centered `pad` to the target.
  const scaledW = Math.round(Math.min(contentW, (contentH * sw) / sh));
  const scaledH = Math.round(Math.min(contentH, (contentW * sh) / sw));
  let barW = contentW - scaledW;
  let barH = contentH - scaledH;
  if (swapBars) [barW, barH] = [barH, barW];
  const mode = edge === "mirror" ? "mirror" : "smear";
  const parts: string[] = [];
  // `ceil` may overwrite 1 px of content on odd remainders (invisible); bars under 2 px are rounding noise.
  if (barW >= 2) {
    const t = Math.ceil(barW / 2);
    parts.push(`left=${t}`, `right=${t}`);
  }
  if (barH >= 2) {
    const t = Math.ceil(barH / 2);
    parts.push(`top=${t}`, `bottom=${t}`);
  }
  if (parts.length === 0) return [];
  parts.push(`mode=${mode}`);
  return [`fillborders=${parts.join(":")}`];
}

function fillbordersSides(pad: SpineClipEdgePad): string {
  const parts: string[] = [];
  if (pad.left > 0) parts.push(`left=${pad.left}`);
  if (pad.right > 0) parts.push(`right=${pad.right}`);
  if (pad.top > 0) parts.push(`top=${pad.top}`);
  if (pad.bottom > 0) parts.push(`bottom=${pad.bottom}`);
  return parts.join(":");
}

/**
 * Grows a fully-opaque frame by `pad` and fills the grown ring. `smear` (clamp) fills arbitrarily wide borders
 * in one pass; `mirror` reflects only one frame-width, so the frame grows by doubling (each step mirrors real
 * pixels and mirror-of-mirror tiles seamlessly).
 */
function buildSurroundFillFilters(fw: number, fh: number, pad: SpineClipEdgePad, edge: EdgeMode): string[] {
  if (pad.left <= 0 && pad.right <= 0 && pad.top <= 0 && pad.bottom <= 0) return [];
  const filters: string[] = [];
  if (edge === "clamp") {
    filters.push(`pad=w=${fw + pad.left + pad.right}:h=${fh + pad.top + pad.bottom}:x=${pad.left}:y=${pad.top}:color=black@0`);
    filters.push(`fillborders=${fillbordersSides(pad)}:mode=smear`);
    return filters;
  }
  let curW = fw;
  let curH = fh;
  let rL = pad.left;
  let rR = pad.right;
  let rT = pad.top;
  let rB = pad.bottom;
  for (let guard = 0; guard < 32 && rL + rR + rT + rB > 0; guard++) {
    const sL = Math.min(rL, curW);
    const sR = Math.min(rR, curW);
    const sT = Math.min(rT, curH);
    const sB = Math.min(rB, curH);
    if (sL + sR + sT + sB === 0) break;
    filters.push(`pad=w=${curW + sL + sR}:h=${curH + sT + sB}:x=${sL}:y=${sT}:color=black@0`);
    filters.push(`fillborders=${fillbordersSides({ left: sL, right: sR, top: sT, bottom: sB })}:mode=mirror`);
    curW += sL + sR;
    curH += sT + sB;
    rL -= sL;
    rR -= sR;
    rT -= sT;
    rB -= sB;
  }
  return filters;
}

/** De-rotate path filters: undo the rotation, crop the clean content, fill, rotate back. */
function buildDerotateFillFilters(
  ctx: VideoGraphCompileContext,
  clip: SpineClipSpec,
  targetW: number,
  targetH: number,
  plan: Extract<SpineEdgePlan, { kind: "derotate" }>,
  edge: EdgeMode
): string[] {
  const { rot, ring } = plan;
  const out: string[] = ["format=rgba"];
  if (rot.hasRotEnv) {
    const ang = `((${rot.rotExpr})*PI/180)`;
    out.push(`rotate=a='-(${ang})':ow='rotw(-(${ang}))':oh='roth(-(${ang}))':c=none`);
    out.push(`crop=w=${targetW}:h=${targetH}:x='(in_w-${targetW})/2':y='(in_h-${targetH})/2'`);
  } else {
    const derad = ((-rot.thetaDeg * Math.PI) / 180).toFixed(4);
    out.push(`rotate=${derad}:ow='rotw(${derad})':oh='roth(${derad})':c=none`);
    const { fw: plainW, fh: plainH } = rotatedFrameSize(targetW, targetH, rot.thetaDeg);
    const de = rotatedFrameSize(plainW, plainH, rot.thetaDeg);
    out.push(`crop=w=${targetW}:h=${targetH}:x=${Math.round((de.fw - targetW) / 2)}:y=${Math.round((de.fh - targetH) / 2)}`);
  }
  out.push(...containBarFillFilters(ctx, clip, targetW, targetH, edge, false));
  out.push(...buildSurroundFillFilters(targetW, targetH, ring, edge));
  if (rot.hasRotEnv) {
    const ang = `((${rot.rotExpr})*PI/180)`;
    out.push(`rotate=a='${ang}':ow='rotw(${ang})':oh='roth(${ang})':c=none`);
  } else {
    const rad = ((rot.thetaDeg * Math.PI) / 180).toFixed(4);
    out.push(`rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`);
  }
  return out;
}

export function buildSpineClipEdgeFilters(
  ctx: VideoGraphCompileContext,
  params: {
    clip: SpineClipSpec;
    targetW: number;
    targetH: number;
    hasDynamicScale: boolean;
  }
): string[] {
  const { clip, targetW, targetH, hasDynamicScale } = params;
  const edge = clip.placement.edge;
  if (edge === undefined || edge === "transparent") return [];
  assertEdgeKind(edge, clip);
  const plan = planSpineClipEdge(ctx, clip, targetW, targetH, hasDynamicScale);
  if (plan.kind === "none") return [];
  if (plan.kind === "derotate") {
    return buildDerotateFillFilters(ctx, clip, targetW, targetH, plan, edge);
  }
  const rot = analyzeRotation(clip);
  const { fw, fh } = rotatedFrameSize(targetW, targetH, rot.thetaDeg);
  const k90 = Math.abs(Math.round(rot.thetaDeg / 90)) % 2 === 1;
  const barFill = containBarFillFilters(ctx, clip, targetW, targetH, edge, k90);
  const surround = buildSurroundFillFilters(fw, fh, plan.pad, edge);
  if (barFill.length === 0 && surround.length === 0) return [];
  return ["format=rgba", ...barFill, ...surround];
}

function subtractPx(expr: string, px: number): string {
  if (px === 0) return expr;
  const trimmed = expr.trim();
  if (/^-?\d+$/.test(trimmed)) return String(Number(trimmed) - px);
  return `(${expr})-${px}`;
}

/**
 * Overlay position hook (called in overlaySpineClip after the base x/y and before the still-image spec and the
 * transition position hooks). Strip path: shifts x/y back by the grown offset so the content stays put.
 * De-rotate path: the content is centered in the grown frame, so a static angle shifts by the bbox growth
 * while runtime-centering `(W-w)/2` forms (rotation envelope without a matching position envelope) need no
 * correction; an envelope position with a rotation envelope is re-anchored from corner- to center-based
 * (` +K-w/2`) so the content center — not the varying frame corner — follows the envelope.
 */
export function applySpineClipEdgeToOverlay(
  ctx: VideoGraphCompileContext,
  params: { clip: SpineClipSpec; xExpr: string; yExpr: string; hasDynamicScale: boolean }
): { xExpr: string; yExpr: string } {
  const { clip, xExpr, yExpr, hasDynamicScale } = params;
  const edge = clip.placement.edge;
  if (edge === undefined || edge === "transparent") return { xExpr, yExpr };
  assertEdgeKind(edge, clip);
  const targetW = hasDynamicScale ? ctx.renderWidth : staticTargetSize(ctx.renderWidth, clip.placement.scale_x);
  const targetH = hasDynamicScale ? ctx.renderHeight : staticTargetSize(ctx.renderHeight, clip.placement.scale_y);
  const plan = planSpineClipEdge(ctx, clip, targetW, targetH, hasDynamicScale);
  if (plan.kind === "none") return { xExpr, yExpr };
  if (plan.kind === "strip") {
    if (plan.pad.left === 0 && plan.pad.top === 0) return { xExpr, yExpr };
    return { xExpr: subtractPx(xExpr, plan.pad.left), yExpr: subtractPx(yExpr, plan.pad.top) };
  }
  const rot = plan.rot;
  if (!rot.hasRotEnv) {
    if (plan.offX === 0 && plan.offY === 0) return { xExpr, yExpr };
    return { xExpr: subtractPx(xExpr, plan.offX), yExpr: subtractPx(yExpr, plan.offY) };
  }
  // Rotation envelope: the grown frame size varies per frame; corner-anchored overlay math cannot track it.
  // In the dynamic path the overlay is always the self-centering `(W-w)/2` form (motion lives inside the
  // perspective mapping), so nothing needs to change there.
  if (hasDynamicScale) return { xExpr, yExpr };
  const { fw, fh } = rotatedFrameSize(targetW, targetH, rot.thetaDeg);
  const reanchor = (expr: string, hasEnv: boolean, center: number, dim: string): string => {
    if (!hasEnv) return expr;
    return `(${expr})+${center / 2}-${dim}/2`;
  };
  return {
    xExpr: reanchor(xExpr, hasEnvelope(clip, "placement.x_pct"), fw, "w"),
    yExpr: reanchor(yExpr, hasEnvelope(clip, "placement.y_pct"), fh, "h"),
  };
}
