// Composition-pixel to stage-pixel mapping for measured boxes.
//
// Must place boxes exactly where the compiler places the overlay (`compile_lane.ts`,
// composition cue branch): mirror, scale (composition size -> stage size, then cue scale
// with the same even-pixel rounding), centered rotation (axis-aligned bounding box), then
// the overlay offset (centered base + x/y percent). Per-frame placement values come from
// the cue envelopes evaluated at the frame's local time.
import { LaneCue } from "../core/schema.js";
import { evaluateEnvelopeAt } from "../sequence/spine.js";

export interface CoordsBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResolvedPlacement {
  x_pct: number;
  y_pct: number;
  scale_x: number;
  scale_y: number;
  rotation_deg: number;
}

export interface CoordsMapContext {
  compWidth: number;
  compHeight: number;
  stageWidth: number;
  stageHeight: number;
}

/** Placement values at a frame's local cue time (envelopes evaluated, statics otherwise). */
export function resolvePlacementAtLocalMs(cue: LaneCue, localMs: number): ResolvedPlacement {
  const at = (param: string, fallback: number): number => {
    const env = cue.envelopes.find((e) => e.parameter === param);
    if (!env || env.points.length === 0) return fallback;
    const v = evaluateEnvelopeAt(env, localMs);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    x_pct: at("placement.x_pct", cue.placement.x_pct),
    y_pct: at("placement.y_pct", cue.placement.y_pct),
    scale_x: at("placement.scale_x", cue.placement.scale_x),
    scale_y: at("placement.scale_y", cue.placement.scale_y),
    rotation_deg: at("placement.rotation_deg", cue.placement.rotation_deg),
  };
}

function hasEnvelope(cue: LaneCue, param: string): boolean {
  const env = cue.envelopes.find((e) => e.parameter === param);
  return Boolean(env && env.points.length > 0);
}

function evenRoundedTarget(stageDim: number, scale: number): number {
  return Math.max(8, Math.round((stageDim * Math.abs(scale)) / 2) * 2);
}

/**
 * Maps one composition-pixel box to stage pixels for a cue at a frame's local time.
 * Returns the mapping plus `unmappable` when a placement value was not finite (static
 * placement was used for that value instead).
 */
export function mapLocalBoxToStage(
  box: CoordsBox,
  cue: LaneCue,
  ctx: CoordsMapContext,
  localMs: number
): { box: CoordsBox; unmappable: boolean } {
  const { compWidth, compHeight, stageWidth, stageHeight } = ctx;
  let unmappable = false;
  const finite = (v: number, fallback: number): number => {
    if (Number.isFinite(v)) return v;
    unmappable = true;
    return fallback;
  };

  const p = resolvePlacementAtLocalMs(cue, localMs);
  const sx = finite(p.scale_x, 1);
  const sy = finite(p.scale_y, 1);
  const rot = finite(p.rotation_deg, 0);
  const dxPct = finite(p.x_pct, 0);
  const dyPct = finite(p.y_pct, 0);

  // Mirror is applied in-stream before scaling (`compile_lane.ts` hflip/vflip).
  let lx = box.x;
  let ly = box.y;
  if (cue.placement.mirror_x) lx = compWidth - box.x - box.w;
  if (cue.placement.mirror_y) ly = compHeight - box.y - box.h;

  // Composition pixels -> overlay pixels: the overlay is rendered at stage size,
  // so a composition whose own size differs is scaled by the size ratio first
  // (same as the staging scale in `hf_blobs.ts`).
  const ratioX = stageWidth / Math.max(1, compWidth);
  const ratioY = stageHeight / Math.max(1, compHeight);
  const ox = lx * ratioX;
  const oy = ly * ratioY;
  const ow = box.w * ratioX;
  const oh = box.h * ratioY;

  // Scale filter target (`compile_lane.ts` targetW/targetH): static scale uses the
  // even-rounded size; dynamic (enveloped) scale keeps the full frame and scales
  // in-stream with exact values, which equals the static formula with per-frame values.
  const hasDynScale = hasEnvelope(cue, "placement.scale_x") || hasEnvelope(cue, "placement.scale_y");
  const targetW = hasDynScale ? stageWidth : evenRoundedTarget(stageWidth, sx);
  const targetH = hasDynScale ? stageHeight : evenRoundedTarget(stageHeight, sy);
  const scaledX = (ox * targetW) / Math.max(1, stageWidth);
  const scaledY = (oy * targetH) / Math.max(1, stageHeight);
  const scaledW = (ow * targetW) / Math.max(1, stageWidth);
  const scaledH = (oh * targetH) / Math.max(1, stageHeight);

  // Rotation about the layer center, then the axis-aligned bounding box. Effective
  // sizes use the compiler's formula (`compile_lane.ts` hfEffW/hfEffH).
  const rotAbs = (Math.abs(rot) * Math.PI) / 180;
  const cosA = Math.abs(Math.cos(rotAbs));
  const sinA = Math.abs(Math.sin(rotAbs));
  let effW = targetW;
  let effH = targetH;
  let rx = scaledX;
  let ry = scaledY;
  let rw = scaledW;
  let rh = scaledH;
  if (Math.abs(rot) > 0.01) {
    effW = Math.round(targetW * cosA + targetH * sinA);
    effH = Math.round(targetW * sinA + targetH * cosA);
    const rad = (rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = targetW / 2;
    const cy = targetH / 2;
    const corners: Array<[number, number]> = [
      [scaledX, scaledY],
      [scaledX + scaledW, scaledY],
      [scaledX, scaledY + scaledH],
      [scaledX + scaledW, scaledY + scaledH],
    ];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [px, py] of corners) {
      const qx = cx + (px - cx) * cos - (py - cy) * sin + (effW - targetW) / 2;
      const qy = cy + (px - cx) * sin + (py - cy) * cos + (effH - targetH) / 2;
      if (qx < x0) x0 = qx;
      if (qy < y0) y0 = qy;
      if (qx > x1) x1 = qx;
      if (qy > y1) y1 = qy;
    }
    rx = x0;
    ry = y0;
    rw = x1 - x0;
    rh = y1 - y0;
  }

  // Overlay offset (`compile_lane.ts` xExpr/yExpr). Static placement rounds to whole
  // pixels; enveloped parameters evaluate exactly (the compiler carries the sub-pixel
  // part in-stream and the overlay position evaluates the same expression).
  const staticRot = Number.isFinite(cue.placement.rotation_deg) ? cue.placement.rotation_deg : 0;
  const staticRotAbs = (Math.abs(staticRot) * Math.PI) / 180;
  const staticEffW =
    Math.abs(staticRot) > 0.01
      ? Math.round(targetW * Math.abs(Math.cos(staticRotAbs)) + targetH * Math.abs(Math.sin(staticRotAbs)))
      : targetW;
  const staticEffH =
    Math.abs(staticRot) > 0.01
      ? Math.round(targetW * Math.abs(Math.sin(staticRotAbs)) + targetH * Math.abs(Math.cos(staticRotAbs)))
      : targetH;
  const baseCenterX = Math.round((stageWidth - staticEffW) / 2);
  const baseCenterY = Math.round((stageHeight - staticEffH) / 2);
  const staticDx = Number.isFinite(cue.placement.x_pct)
    ? (cue.placement.x_pct / 100) * stageWidth
    : 0;
  const staticDy = Number.isFinite(cue.placement.y_pct)
    ? (cue.placement.y_pct / 100) * stageHeight
    : 0;
  const hasXEnv = hasEnvelope(cue, "placement.x_pct");
  const hasYEnv = hasEnvelope(cue, "placement.y_pct");
  const hasRotEnv = hasEnvelope(cue, "placement.rotation_deg");
  const dxNow = (dxPct / 100) * stageWidth;
  const dyNow = (dyPct / 100) * stageHeight;

  let offX: number;
  let offY: number;
  if (hasDynScale) {
    offX = (hasRotEnv ? (stageWidth - effW) / 2 : baseCenterX) + dxNow;
    offY = (hasRotEnv ? (stageHeight - effH) / 2 : baseCenterY) + dyNow;
  } else {
    offX = hasXEnv
      ? baseCenterX + dxNow
      : hasRotEnv
        ? (stageWidth - effW) / 2 + Math.round(staticDx)
        : Math.round(baseCenterX + staticDx);
    offY = hasYEnv
      ? baseCenterY + dyNow
      : hasRotEnv
        ? (stageHeight - effH) / 2 + Math.round(staticDy)
        : Math.round(baseCenterY + staticDy);
  }

  return { box: { x: rx + offX, y: ry + offY, w: rw, h: rh }, unmappable };
}

/** Union of stage boxes (all inputs already in stage pixels). */
export function unionStageBoxes(boxes: CoordsBox[]): CoordsBox | null {
  if (boxes.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    if (b.x < x0) x0 = b.x;
    if (b.y < y0) y0 = b.y;
    if (b.x + b.w > x1) x1 = b.x + b.w;
    if (b.y + b.h > y1) y1 = b.y + b.h;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function roundBox1(box: CoordsBox): [number, number, number, number] {
  const r = (v: number): number => Math.round(v * 10) / 10;
  return [r(box.x), r(box.y), r(box.w), r(box.h)];
}
