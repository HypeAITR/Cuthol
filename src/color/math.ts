// Colour block math: pure, deterministic functions on BT.709 display-encoded R'G'B' (0..1).
//
// These functions are the single definition of what a colour block does. They are baked into a 3D LUT
// (src/color/lut.ts) for the render and the Live preview, and they are used directly to predict a grade
// without rendering. Engineering choices (not standards) are named as such:
// - linear light for white balance and exposure: BT.1886 pure 2.4 power (black level 0);
// - white balance: von Kries-style channel gains from the Planckian locus (Kim et al. 2002 cubic fit)
//   converted to linear BT.709 RGB, normalised to keep BT.709 luma;
// - Lab/CIEDE2000 for measurement: sRGB transfer + D65 (IEC 61966-2-1, CIE 15), matching the colour
//   experiments in this project.
import type {
  ColorBlocks,
  ColorCurvePoint,
  ColorStageSpec,
  ColorWheelValue,
  CurvesBlock,
  ExposureBlock,
  HslQualifierBlock,
  SaturationBlock,
  ToneBlock,
  WheelsBlock,
  WhiteBalanceBlock,
} from "./types.js";

/** BT.709 luma weights. */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;
/** 18% grey in BT.1886 2.4 encoding (default tone pivot). */
export const MID_GREY_ENCODED = Math.pow(0.18, 1 / 2.4);
/** D65 on the Planckian locus used as the white-balance origin (mired). */
export const WB_REFERENCE_MIRED = 1e6 / 6504;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const decode24 = (x: number): number => (x <= 0 ? 0 : Math.pow(x, 2.4));
export const encode24 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(x, 1 / 2.4));

const blockOn = (b: { enabled?: boolean } | undefined): boolean => Boolean(b) && b!.enabled !== false;
const amountOf = (b: { amount?: number } | undefined): number =>
  b && typeof b.amount === "number" && Number.isFinite(b.amount) ? clamp01(b.amount) : 1;
const num = (v: number | undefined, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d;

// ---------------------------------------------------------------------------------------------
// White balance

/** CIE xy of the Planckian radiator at `kelvin` (Kim et al. 2002 cubic fit, 1667..25000 K). */
export function planckianXy(kelvin: number): [number, number] {
  const t = Math.min(25000, Math.max(1667, kelvin));
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    t <= 4000
      ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  const y =
    t <= 2222
      ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
      : t <= 4000
        ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

function xyToLinearRgb([x, y]: [number, number]): [number, number, number] {
  const X = x / y;
  const Y = 1;
  const Z = (1 - x - y) / y;
  return [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
}

/** Linear-light RGB gains of a white-balance block (luma preserving). */
export function whiteBalanceGains(temp_mired: number, tint: number): [number, number, number] {
  const ref = xyToLinearRgb(planckianXy(1e6 / WB_REFERENCE_MIRED));
  const mired = Math.max(40, Math.min(600, WB_REFERENCE_MIRED + temp_mired));
  const w = xyToLinearRgb(planckianXy(1e6 / mired));
  const g: [number, number, number] = [w[0] / ref[0], w[1] / ref[1], w[2] / ref[2]];
  g[1] *= Math.pow(2, -0.5 * Math.max(-1, Math.min(1, tint)));
  const luma = LUMA_R * g[0] + LUMA_G * g[1] + LUMA_B * g[2];
  return [g[0] / luma, g[1] / luma, g[2] / luma];
}

// ---------------------------------------------------------------------------------------------
// Curves (monotone cubic, Fritsch–Carlson)

export interface MonotoneCurve {
  xs: number[];
  ys: number[];
  ms: number[];
}

export function buildMonotoneCurve(points: ColorCurvePoint[] | undefined): MonotoneCurve | null {
  if (!points || points.length === 0) return null;
  const pts = points
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([x, y]) => [clamp01(x), clamp01(y)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const dedup: [number, number][] = [];
  for (const p of pts) {
    if (dedup.length && Math.abs(dedup[dedup.length - 1][0] - p[0]) < 1e-6) dedup[dedup.length - 1] = p;
    else dedup.push(p);
  }
  if (dedup[0][0] > 0) dedup.unshift([0, 0]);
  if (dedup[dedup.length - 1][0] < 1) dedup.push([1, 1]);
  const xs = dedup.map((p) => p[0]);
  const ys = dedup.map((p) => p[1]);
  const n = xs.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const ms: number[] = new Array(n).fill(0);
  ms[0] = d[0];
  ms[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) ms[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      ms[i] = 0;
      ms[i + 1] = 0;
      continue;
    }
    const a = ms[i] / d[i];
    const b = ms[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      ms[i] = t * a * d[i];
      ms[i + 1] = t * b * d[i];
    }
  }
  return { xs, ys, ms };
}

export function evalMonotoneCurve(c: MonotoneCurve, x: number): number {
  const { xs, ys, ms } = c;
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 0;
  while (i < n - 2 && x > xs[i + 1]) i++;
  const h = xs[i + 1] - xs[i];
  const t = (x - xs[i]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return clamp01(
    (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * ms[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * ms[i + 1]
  );
}

// ---------------------------------------------------------------------------------------------
// Hue helpers

/** Unit chroma direction (luma removed, max |component| = 1) of an HSV hue. */
export function hueDirection(hueDeg: number): [number, number, number] {
  const h = (((hueDeg % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] =
    h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  const y = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  const u: [number, number, number] = [r - y, g - y, b - y];
  const m = Math.max(Math.abs(u[0]), Math.abs(u[1]), Math.abs(u[2])) || 1;
  return [u[0] / m, u[1] / m, u[2] / m];
}

/** HSV hue in degrees (0..360) and HSV saturation of an encoded pixel. */
export function hueSat(r: number, g: number, b: number): [number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  if (c <= 1e-9) return [0, 0];
  let h: number;
  if (max === r) h = ((g - b) / c) % 6;
  else if (max === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, max > 0 ? c / max : 0];
}

const angDist = (a: number, b: number): number => {
  const d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return d;
};

// ---------------------------------------------------------------------------------------------
// Blocks on one pixel (in place on a 3-tuple)

type Px = [number, number, number];

function blend(out: Px, inp: Px, amount: number): void {
  if (amount >= 1) return;
  out[0] = inp[0] + (out[0] - inp[0]) * amount;
  out[1] = inp[1] + (out[1] - inp[1]) * amount;
  out[2] = inp[2] + (out[2] - inp[2]) * amount;
}

function applyWhiteBalance(p: Px, gains: [number, number, number]): void {
  for (let c = 0; c < 3; c++) p[c] = encode24(decode24(p[c]) * gains[c]);
}

function applyExposure(p: Px, gain: number): void {
  for (let c = 0; c < 3; c++) p[c] = encode24(decode24(p[c]) * gain);
}

function toneCurve(e: number, t: ToneBlock): number {
  let x = clamp01(e);
  const contrast = Math.max(-1, Math.min(1, num(t.contrast, 0)));
  if (contrast !== 0) {
    const pivot = Math.min(0.95, Math.max(0.05, num(t.pivot, MID_GREY_ENCODED)));
    const k = Math.pow(2, contrast);
    x = x < pivot ? pivot * Math.pow(x / pivot, k) : 1 - (1 - pivot) * Math.pow((1 - x) / (1 - pivot), k);
  }
  const sh = Math.max(-1, Math.min(1, num(t.shadows, 0)));
  const hi = Math.max(-1, Math.min(1, num(t.highlights, 0)));
  if (sh !== 0 || hi !== 0) {
    const bs = 6.75 * x * (1 - x) * (1 - x);
    const bh = 6.75 * x * x * (1 - x);
    x = x + 0.12 * (sh * bs + hi * bh);
  }
  const bl = Math.max(-1, Math.min(1, num(t.blacks, 0)));
  const wh = Math.max(-1, Math.min(1, num(t.whites, 0)));
  if (bl !== 0 || wh !== 0) {
    const y = clamp01(x);
    x = y + 0.1 * bl * Math.pow(1 - y, 3) + 0.1 * wh * Math.pow(y, 3);
  }
  return clamp01(x);
}

function applyTone(p: Px, t: ToneBlock): void {
  p[0] = toneCurve(p[0], t);
  p[1] = toneCurve(p[1], t);
  p[2] = toneCurve(p[2], t);
}

interface PreparedCurves {
  master: MonotoneCurve | null;
  r: MonotoneCurve | null;
  g: MonotoneCurve | null;
  b: MonotoneCurve | null;
}

function applyCurves(p: Px, c: PreparedCurves): void {
  if (c.master) for (let i = 0; i < 3; i++) p[i] = evalMonotoneCurve(c.master, p[i]);
  if (c.r) p[0] = evalMonotoneCurve(c.r, p[0]);
  if (c.g) p[1] = evalMonotoneCurve(c.g, p[1]);
  if (c.b) p[2] = evalMonotoneCurve(c.b, p[2]);
}

/** RGB offset vector of one wheel value: 0.25 * amount along the hue direction + 0.25 * luma. */
export function wheelVector(w: ColorWheelValue | undefined): Px | null {
  if (!w) return null;
  const amount = Math.max(0, Math.min(1, num(w.amount, 0)));
  const luma = Math.max(-1, Math.min(1, num(w.luma, 0)));
  if (amount === 0 && luma === 0) return null;
  const d = hueDirection(num(w.hue_deg, 0));
  return [0.25 * (amount * d[0] + luma), 0.25 * (amount * d[1] + luma), 0.25 * (amount * d[2] + luma)];
}

interface PreparedWheels {
  lift: Px | null;
  gamma: Px | null;
  gain: Px | null;
  offset: Px | null;
}

function applyWheels(p: Px, w: PreparedWheels): void {
  for (let c = 0; c < 3; c++) {
    let x = p[c];
    if (w.lift) x = x + w.lift[c] * (1 - x);
    if (w.gain) x = x * (1 + w.gain[c]);
    if (w.gamma) x = Math.pow(clamp01(x), 1 / Math.max(0.1, 1 + w.gamma[c]));
    if (w.offset) x = x + 0.5 * w.offset[c];
    p[c] = clamp01(x);
  }
}

/** Selection weight (0..1) of an HSL qualifier for an encoded pixel. */
export function hslWeight(q: HslQualifierBlock, r: number, g: number, b: number): number {
  const [h, s] = hueSat(r, g, b);
  if (s <= 0.02) return 0;
  const width = Math.max(0, Math.min(360, num(q.hue_width_deg, 30)));
  const soft = Math.max(0.5, num(q.hue_soft_deg, width / 2));
  const d = angDist(h, num(q.hue_center_deg, 0));
  let w = 1 - smoothstep(width / 2, width / 2 + soft, d);
  if (w <= 0) return 0;
  const sMin = num(q.sat_min, 0);
  const sMax = num(q.sat_max, 1);
  if (sMin > 0) w *= smoothstep(sMin - 0.1, sMin, s);
  if (sMax < 1) w *= 1 - smoothstep(sMax, sMax + 0.1, s);
  const y = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  const lMin = num(q.luma_min, 0);
  const lMax = num(q.luma_max, 1);
  if (lMin > 0) w *= smoothstep(lMin - 0.1, lMin, y);
  if (lMax < 1) w *= 1 - smoothstep(lMax, lMax + 0.1, y);
  // Hue is unreliable near grey: taper the selection with chroma.
  w *= smoothstep(0.02, 0.1, s);
  return w;
}

function applyHsl(p: Px, q: HslQualifierBlock): void {
  const w = hslWeight(q, p[0], p[1], p[2]) * amountOf(q);
  if (w <= 0) return;
  let y = LUMA_R * p[0] + LUMA_G * p[1] + LUMA_B * p[2];
  let cb = (p[2] - y) / 1.8556;
  let cr = (p[0] - y) / 1.5748;
  const shift = num(q.hue_shift_deg, 0) * w;
  if (shift !== 0) {
    const a = (shift * Math.PI) / 180;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const ncb = cb * ca - cr * sa;
    const ncr = cb * sa + cr * ca;
    cb = ncb;
    cr = ncr;
  }
  const k = 1 + w * (num(q.sat_scale, 1) - 1);
  cb *= k;
  cr *= k;
  y += w * 0.5 * Math.max(-1, Math.min(1, num(q.luma_shift, 0)));
  const r = y + 1.5748 * cr;
  const bb = y + 1.8556 * cb;
  const g = (y - LUMA_R * r - LUMA_B * bb) / LUMA_G;
  p[0] = clamp01(r);
  p[1] = clamp01(g);
  p[2] = clamp01(bb);
}

/** Skin-hue window used to protect skin from vibrance (HSV hue around 25 degrees; an engineering choice). */
const SKIN_HUE_CENTER = 25;
const SKIN_HUE_HALF = 20;

function applySaturation(p: Px, s: SaturationBlock): void {
  const sat = Math.max(0, num(s.saturation, 1));
  const vib = Math.max(-1, Math.min(1, num(s.vibrance, 0)));
  const y = LUMA_R * p[0] + LUMA_G * p[1] + LUMA_B * p[2];
  let k = sat;
  if (vib !== 0) {
    const c = Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
    let f = vib * (1 - smoothstep(0, 0.6, c));
    if (vib > 0) {
      const [h, hs] = hueSat(p[0], p[1], p[2]);
      if (hs > 0.02) f *= 1 - 0.5 * (1 - smoothstep(SKIN_HUE_HALF, SKIN_HUE_HALF + 15, angDist(h, SKIN_HUE_CENTER)));
    }
    k *= 1 + f;
  }
  for (let i = 0; i < 3; i++) p[i] = clamp01(y + (p[i] - y) * k);
}

// ---------------------------------------------------------------------------------------------
// Stage evaluation

/** A Look resolved for evaluation: either a sampled LUT function or blocks, with its effective amount. */
export interface ResolvedLook {
  amount: number;
  /** Maps one encoded pixel in place (e.g. tetrahedral sampling of a .cube). */
  lut?: (p: Px) => void;
  blocks?: ColorBlocks;
}

/** Blocks prepared once (curves, gains, wheel vectors) so that per-pixel evaluation stays cheap. */
export interface PreparedBlocks {
  wb: { gains: [number, number, number]; amount: number } | null;
  exposure: { gain: number; amount: number } | null;
  tone: { block: ToneBlock; amount: number } | null;
  curves: { c: PreparedCurves; amount: number } | null;
  wheels: { w: PreparedWheels; amount: number } | null;
  hsl: HslQualifierBlock[];
  saturation: { block: SaturationBlock; amount: number } | null;
}

export function prepareBlocks(blocks: ColorBlocks | undefined): PreparedBlocks {
  const b = blocks ?? {};
  const wbB = b.white_balance as WhiteBalanceBlock | undefined;
  const exB = b.exposure as ExposureBlock | undefined;
  const cvB = b.curves as CurvesBlock | undefined;
  const whB = b.wheels as WheelsBlock | undefined;
  const curves: PreparedCurves | null = blockOn(cvB)
    ? {
        master: buildMonotoneCurve(cvB!.master),
        r: buildMonotoneCurve(cvB!.r),
        g: buildMonotoneCurve(cvB!.g),
        b: buildMonotoneCurve(cvB!.b),
      }
    : null;
  const wheels: PreparedWheels | null = blockOn(whB)
    ? {
        lift: wheelVector(whB!.lift),
        gamma: wheelVector(whB!.gamma),
        gain: wheelVector(whB!.gain),
        offset: wheelVector(whB!.offset),
      }
    : null;
  return {
    wb:
      blockOn(wbB) && (num(wbB!.temp_mired, 0) !== 0 || num(wbB!.tint, 0) !== 0)
        ? { gains: whiteBalanceGains(num(wbB!.temp_mired, 0), num(wbB!.tint, 0)), amount: amountOf(wbB) }
        : null,
    exposure:
      blockOn(exB) && num(exB!.stops, 0) !== 0
        ? { gain: Math.pow(2, Math.max(-8, Math.min(8, num(exB!.stops, 0)))), amount: amountOf(exB) }
        : null,
    tone: blockOn(b.tone) ? { block: b.tone!, amount: amountOf(b.tone) } : null,
    curves: curves && (curves.master || curves.r || curves.g || curves.b) ? { c: curves, amount: amountOf(cvB) } : null,
    wheels:
      wheels && (wheels.lift || wheels.gamma || wheels.gain || wheels.offset) ? { w: wheels, amount: amountOf(whB) } : null,
    hsl: (b.hsl ?? []).filter((q) => blockOn(q)),
    saturation: blockOn(b.saturation) ? { block: b.saturation!, amount: amountOf(b.saturation) } : null,
  };
}

const tmp: Px = [0, 0, 0];

function step(p: Px, amount: number, fn: (q: Px) => void): void {
  tmp[0] = p[0];
  tmp[1] = p[1];
  tmp[2] = p[2];
  fn(p);
  blend(p, tmp, amount);
}

/** Applies prepared blocks to one encoded pixel, in the fixed stage order (without the Look). */
export function applyPreparedBlocks(p: Px, pb: PreparedBlocks): void {
  for (let i = 0; i < 3; i++) p[i] = clamp01(p[i]);
  if (pb.wb) step(p, pb.wb.amount, (q) => applyWhiteBalance(q, pb.wb!.gains));
  if (pb.exposure) step(p, pb.exposure.amount, (q) => applyExposure(q, pb.exposure!.gain));
  if (pb.tone) step(p, pb.tone.amount, (q) => applyTone(q, pb.tone!.block));
  if (pb.curves) step(p, pb.curves.amount, (q) => applyCurves(q, pb.curves!.c));
  if (pb.wheels) step(p, pb.wheels.amount, (q) => applyWheels(q, pb.wheels!.w));
  for (const q of pb.hsl) applyHsl(p, q);
  if (pb.saturation) step(p, pb.saturation.amount, (q) => applySaturation(q, pb.saturation!.block));
}

/** A ready-to-run pixel function of a whole stage (blocks, then the resolved Look). */
export function stagePixelFunction(stage: ColorStageSpec | undefined, look?: ResolvedLook | null): (p: Px) => void {
  const pb = prepareBlocks(stage);
  const lookBlocks = look?.blocks ? prepareBlocks(look.blocks) : null;
  const lookAmount = look ? clamp01(look.amount) : 0;
  return (p: Px) => {
    applyPreparedBlocks(p, pb);
    if (look && lookAmount > 0) {
      step(p, lookAmount, (q) => {
        if (lookBlocks) applyPreparedBlocks(q, lookBlocks);
        if (look.lut) look.lut(q);
      });
    }
  };
}

/** True when a stage (with its Look) changes nothing: the compiler emits no filter for it. */
export function isIdentityStage(stage: ColorStageSpec | undefined, look?: ResolvedLook | null): boolean {
  const pb = prepareBlocks(stage);
  const hasBlocks = Boolean(
    pb.wb || pb.exposure || pb.curves || pb.wheels ||
      pb.hsl.some((q) => num(q.hue_shift_deg, 0) !== 0 || num(q.sat_scale, 1) !== 1 || num(q.luma_shift, 0) !== 0) ||
      (pb.saturation && (num(pb.saturation.block.saturation, 1) !== 1 || num(pb.saturation.block.vibrance, 0) !== 0)) ||
      (pb.tone && ["contrast", "shadows", "highlights", "blacks", "whites"].some((k) => num((pb.tone!.block as any)[k], 0) !== 0))
  );
  return !hasBlocks && !(look && look.amount > 0);
}

/** Applies a stage to interleaved RGB (encoded, 0..1); returns a new array. */
export function applyStageToPixels(rgb: Float32Array, fn: (p: Px) => void): Float32Array {
  const out = new Float32Array(rgb.length);
  const p: Px = [0, 0, 0];
  for (let i = 0; i < rgb.length; i += 3) {
    p[0] = rgb[i];
    p[1] = rgb[i + 1];
    p[2] = rgb[i + 2];
    fn(p);
    out[i] = p[0];
    out[i + 1] = p[1];
    out[i + 2] = p[2];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Measurement colour space: sRGB transfer + D65 → CIE L*a*b*, CIEDE2000

const srgbToLinear = (x: number): number => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const D65 = [0.95047, 1.0, 1.08883];
const labF = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (t * 24389) / 27 / 116 + 16 / 116);

/** CIE L*a*b* (D65) of an encoded pixel, reading the encoding as sRGB. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = srgbToLinear(clamp01(r));
  const G = srgbToLinear(clamp01(g));
  const B = srgbToLinear(clamp01(b));
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / D65[0];
  const Y = (0.2126729 * R + 0.7151522 * G + 0.072175 * B) / D65[1];
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / D65[2];
  const fx = labF(X);
  const fy = labF(Y);
  const fz = labF(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 colour difference (kL = kC = kH = 1). */
export function deltaE2000(l1: [number, number, number], l2: [number, number, number]): number {
  const [L1, a1, b1] = l1;
  const [L2, a2, b2] = l2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const Cb7 = Math.pow(Cb, 7);
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h = (b: number, a: number): number => {
    if (a === 0 && b === 0) return 0;
    const v = (Math.atan2(b, a) * 180) / Math.PI;
    return v < 0 ? v + 360 : v;
  };
  const h1p = h(b1, a1p);
  const h2p = h(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp = h1p + h2p < 360 ? hbp + 360 : hbp - 360;
    hbp /= 2;
  }
  const rad = (d: number): number => (d * Math.PI) / 180;
  const T =
    1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) -
    0.2 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Cbp7 = Math.pow(Cbp, 7);
  const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt(
    Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh)
  );
}

/** Per-pixel CIEDE2000 between two interleaved RGB arrays of equal length. */
export function deltaE2000Pixels(a: Float32Array, b: Float32Array): Float32Array {
  const n = Math.min(a.length, b.length) / 3;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    out[i] = deltaE2000(rgbToLab(a[j], a[j + 1], a[j + 2]), rgbToLab(b[j], b[j + 1], b[j + 2]));
  }
  return out;
}
