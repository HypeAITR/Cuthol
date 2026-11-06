// Shared cubic-bezier easing math (CSS `cubic-bezier()` semantics).
//
// Used by the JS evaluator (`sequence/spine_envelope.ts`), the FFmpeg expression
// compiler (`compositor/compile_filters.ts`), the CLI `--easing` parser and the
// verify gate (`verify/gates_easing.ts`) so every consumer agrees on one curve.
import { CubicBezierControlPoints, EasingKind } from "./schema.js";
import { CutholError, DIAGNOSTICS } from "./diagnostics.js";
import type { CutholDiagnostic } from "./diagnostics.js";

/** Newton iterations unrolled into the FFmpeg expression (measured: <= 1.2e-7 on 10 curves). */
export const CUBIC_BEZIER_FFMPEG_NEWTON_ITERS = 5;

/** `st()`/`ld()` slots used by the unrolled solver (no other compiler output uses slots). */
const BEZIER_X_SLOT = 2;
const BEZIER_U_SLOT = 0;

/** Non-throwing check: `null` when valid, otherwise an English detail for G120. */
export function cubicBezierIssue(bezier: unknown): string | null {
  if (bezier === undefined || bezier === null) {
    return "easing is 'cubic_bezier' but the 'bezier' field is missing";
  }
  if (!Array.isArray(bezier) || bezier.length !== 4) {
    return "'bezier' must be 4 numbers ([x1, y1, x2, y2])";
  }
  for (const n of bezier) {
    if (typeof n !== "number" || !Number.isFinite(n)) {
      return "'bezier' must be 4 numbers ([x1, y1, x2, y2])";
    }
  }
  const [x1, , x2] = bezier as [number, number, number, number];
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    return `x1 (${x1}) and x2 (${x2}) must be within 0..1`;
  }
  return null;
}

/** Every easing name the sequence may store (`hold` is a step). */
export const VALID_EASING_NAMES: readonly string[] = [
  "linear",
  "ease_in",
  "ease_out",
  "ease_in_out",
  "hold",
  "cubic_bezier",
];

const VALID_EASING_NAME_SET: ReadonlySet<string> = new Set(VALID_EASING_NAMES);

export interface EasingValidationOptions {
  /** `false` rejects `hold` (transitions). Defaults to `true` (envelopes). */
  allowHold?: boolean;
}

/**
 * Non-throwing easing check shared by the CLI parser, the cue sheet entry point, the verify
 * gate and the transition compiler: `null` when valid, otherwise a CUTHOL-G120 diagnostic.
 * Unknown names are never silently treated as linear; `hold` is envelopes-only.
 */
export function easingDiagnostic(
  subject: string,
  easing: unknown,
  bezier: unknown,
  options?: EasingValidationOptions
): CutholDiagnostic | null {
  if (typeof easing !== "string" || !VALID_EASING_NAME_SET.has(easing)) {
    return DIAGNOSTICS.EASING_NAME_INVALID(subject, String(easing));
  }
  if (easing === "hold" && options?.allowHold === false) {
    return DIAGNOSTICS.EASING_HOLD_IN_TRANSITION(subject);
  }
  if (easing === "cubic_bezier") {
    const issue = cubicBezierIssue(bezier);
    if (issue) return DIAGNOSTICS.CUBIC_BEZIER_INVALID(subject, issue);
  }
  return null;
}

/** Throwing wrapper of `easingDiagnostic` for entry points (CLI, cue sheet). */
export function assertValidEasing(
  subject: string,
  easing: unknown,
  bezier: unknown,
  options?: EasingValidationOptions
): void {
  const problem = easingDiagnostic(subject, easing, bezier, options);
  if (problem) throw new CutholError(problem);
}

export interface ParseEasingFlagOptions extends EasingValidationOptions {
  /** Subject used in G120 messages. Defaults to `"--easing"`. */
  subject?: string;
}

function throwG120(subject: string, detail: string): never {
  throw new CutholError(DIAGNOSTICS.CUBIC_BEZIER_INVALID(subject, detail));
}

/**
 * Parses a CLI/MCP `--easing` value. Accepts the named curves, the CSS form
 * `cubic-bezier(x1,y1,x2,y2)` (or `cubic_bezier(...)`), and bare `x1,y1,x2,y2`.
 * Unknown names are rejected with CUTHOL-G120 (no silent linear fallback); malformed
 * cubic forms and (with allowHold: false) `hold` throw CUTHOL-G120 too.
 */
export function parseEasingFlag(raw: string | undefined, options?: ParseEasingFlagOptions): {
  easing: EasingKind;
  bezier?: CubicBezierControlPoints;
} {
  const v = (raw ?? "ease_in_out").trim();
  const wrapped = /^cubic[-_]bezier\((.*)\)$/i.exec(v);
  const bareCsv = !wrapped && v.includes(",") ? v : null;
  const csv = wrapped ? wrapped[1] : bareCsv;
  if (csv !== null) {
    const parts = csv.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      throwG120("--easing", `'${v}' must contain 4 numbers (e.g. 'cubic-bezier(0.25,0.1,0.25,1)')`);
    }
    const issue = cubicBezierIssue(parts);
    if (issue) throwG120("--easing", `'${v}': ${issue}`);
    return { easing: "cubic_bezier", bezier: parts as CubicBezierControlPoints };
  }
  if (/^cubic[-_]bezier$/i.test(v)) {
    throwG120("--easing", "'cubic_bezier' cannot be given without control points");
  }
  assertValidEasing(options?.subject ?? "--easing", v, undefined, {
    allowHold: options?.allowHold ?? true,
  });
  return { easing: v as EasingKind };
}

interface CubicPoint {
  x: number;
  y: number;
  dx: number;
}

function cubicAt(b: CubicBezierControlPoints, u: number): CubicPoint {
  const [x1, y1, x2, y2] = b;
  const v = 1 - u;
  return {
    x: 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u,
    y: 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u,
    dx: 3 * v * v * x1 + 6 * v * u * (x2 - x1) + 3 * u * u * (1 - x2),
  };
}

/** Solves `x(u) = x` for `u` (Newton, then bisection polish). */
export function cubicBezierU(b: CubicBezierControlPoints, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let u = x;
  for (let i = 0; i < 16; i++) {
    const p = cubicAt(b, u);
    if (Math.abs(p.x - x) < 1e-9) break;
    if (Math.abs(p.dx) < 1e-9) break;
    u = Math.min(1, Math.max(0, u - (p.x - x) / p.dx));
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48; i++) {
    const p = cubicAt(b, u);
    if (Math.abs(p.x - x) < 1e-12) break;
    if (p.x < x) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return u;
}

/** Exact JS evaluator: normalized value ratio `y(u)` for normalized time `x`. */
export function cubicBezierY(b: CubicBezierControlPoints, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return cubicAt(b, cubicBezierU(b, x)).y;
}

/**
 * Restricts a cubic-bezier to the sub-interval `[xStart, xEnd]` (normalized time)
 * and re-expresses it as a new `[x1, y1, x2, y2]` over `[0, 1]` (de Casteljau
 * split at the solved parameters + renormalization). Exact up to float error.
 * Returns `[0, 0, 1, 1]` for degenerate (zero-span or flat) intervals.
 */
export function subCubicBezier(
  b: CubicBezierControlPoints,
  xStart: number,
  xEnd: number
): CubicBezierControlPoints {
  const xs = Math.min(1, Math.max(0, xStart));
  const xe = Math.min(1, Math.max(0, xEnd));
  if (xs <= 1e-12 && xe >= 1 - 1e-12) return [...b] as CubicBezierControlPoints;
  if (xe - xs < 1e-12) return [0, 0, 1, 1];
  const [x1, y1, x2, y2] = b;
  const us = cubicBezierU(b, xs);
  const ue = cubicBezierU(b, xe);
  type Pt = [number, number];
  const p0: Pt = [0, 0];
  const p1: Pt = [x1, y1];
  const p2: Pt = [x2, y2];
  const p3: Pt = [1, 1];
  const lerp = (a: Pt, c: Pt, t: number): Pt => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
  const split = (q0: Pt, q1: Pt, q2: Pt, q3: Pt, t: number): { left: Pt[]; right: Pt[] } => {
    const a = lerp(q0, q1, t);
    const c = lerp(q1, q2, t);
    const d = lerp(q2, q3, t);
    const e = lerp(a, c, t);
    const f = lerp(c, d, t);
    const g = lerp(e, f, t);
    return { left: [q0, a, e, g], right: [g, f, d, q3] };
  };
  const right = split(p0, p1, p2, p3, us).right;
  const t2 = (ue - us) / Math.max(1e-12, 1 - us);
  const sub = split(right[0], right[1], right[2], right[3], Math.min(1, Math.max(0, t2))).left;
  const ys = sub[0][1];
  const ye = sub[3][1];
  if (Math.abs(ye - ys) < 1e-12) return [0, 0, 1, 1];
  const nx = (v: number): number => (v - xs) / (xe - xs);
  const ny = (v: number): number => (v - ys) / (ye - ys);
  return [nx(sub[1][0]), ny(sub[1][1]), nx(sub[2][0]), ny(sub[2][1])];
}

function fmtExpr(n: number): string {
  const s = Number(n.toFixed(6));
  return Object.is(s, -0) ? "0" : String(s);
}

/**
 * FFmpeg expression fragment for the eased ratio of one cubic-bezier segment.
 * `xExpr` is the normalized-time subexpression (0..1). Unrolled Newton solver
 * with `st()`/`ld()` sequencing; the initial guess is chosen at compile time
 * from the control points (flat ends get a sqrt guess, otherwise `u0 = x`).
 */
export function compileCubicBezierEasedU(b: CubicBezierControlPoints, xExpr: string): string {
  const [x1, y1, x2, y2] = b.map(fmtExpr);
  const xx = `ld(${BEZIER_X_SLOT})`;
  const uu = `ld(${BEZIER_U_SLOT})`;
  const cx = `(3*pow(1-(${uu}),2)*(${uu})*(${x1})+3*(1-(${uu}))*pow(${uu},2)*(${x2})+pow(${uu},3))`;
  const dx =
    `(3*pow(1-(${uu}),2)*(${x1})+6*(1-(${uu}))*(${uu})*((${x2})-(${x1}))` +
    `+3*pow(${uu},2)*(1-(${x2})))`;
  const cy = `(3*pow(1-(${uu}),2)*(${uu})*(${y1})+3*(1-(${uu}))*pow(${uu},2)*(${y2})+pow(${uu},3))`;
  const flatStart = b[0] < 0.05;
  const flatEnd = b[2] > 0.95;
  const u0 =
    flatStart && flatEnd
      ? `(if(lt(${xx},0.5),sqrt(${xx}),1-sqrt(1-${xx})))`
      : flatStart
        ? `sqrt(${xx})`
        : flatEnd
          ? `(1-sqrt(1-${xx}))`
          : xx;
  const parts = [`st(${BEZIER_X_SLOT},min(max(${xExpr},0),1))`, `st(${BEZIER_U_SLOT},${u0})`];
  for (let i = 0; i < CUBIC_BEZIER_FFMPEG_NEWTON_ITERS; i++) {
    parts.push(`st(${BEZIER_U_SLOT},min(max((${uu}-((${cx})-(${xx}))/((${dx})+0.000001)),0),1))`);
  }
  parts.push(cy);
  const chained = parts.map((p, i) => (i === parts.length - 1 ? p : `${p}*0`)).join("+");
  return `(${chained})`;
}
