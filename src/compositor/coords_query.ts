// Geometry query over measured composition coordinates.
//
// Read-only: resolves element references at one sequence moment, maps measured
// local boxes to stage pixels with the compiler's overlay formulas, and reports
// distances, overlap, paint order, and design relations. Cues missing from the
// cache are measured through the existing measurement path (one browser) and the
// answer says which cues were measured. Nothing is warned about; the agent decides.
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence, LaneCue } from "../core/schema.js";
import { parseTimeMs } from "../core/time.js";
import { resolveCueStartMs } from "../core/timeline.js";
import { loadSequence } from "../core/workspace.js";
import { CoordsDocItem, CoordsDocument, measureCompositionCues } from "./coords_extract.js";
import { mapLocalBoxToStage, roundBox1 } from "./coords_map.js";

/** Four corners `[[x1,y1],[x2,y2],[x3,y3],[x4,y4]]` of a convex quad. */
export type StageQuad = [[number, number], [number, number], [number, number], [number, number]];

/** Local (composition-pixel) quad corners, flat `[x1,y1,x2,y2,x3,y3,x4,y4]`. */
type LocalQuad = [number, number, number, number, number, number, number, number];

/** Stage-pixel box, `[x, y, w, h]`, rounded to 0.1 px. */
export type GeometryBox = [number, number, number, number];

export interface GeometryEdges {
  /** Stage px from the box to each frame edge; negative means overflow. */
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GeometryElementRow {
  cue: string;
  key: string;
  kind: string;
  label: string;
  /** Stage-pixel item box; null when the element is not visible in the frame. */
  item: GeometryBox | null;
  /** Stage-pixel ink box; null when absent (ink then equals the item box) or invisible. */
  ink: GeometryBox | null;
  opacity: number | null;
  z: number | null;
  /** Detail-only keys below; list mode omits them (short rows). */
  visible?: boolean;
  /** Key of the nearest measured ancestor; null when there is none. */
  parent?: string | null;
  /** Key of the design-group owner; null when the element has no group. */
  group?: string | null;
  /** Edge distances from the effective box (ink when present, else item). */
  edges?: GeometryEdges | null;
  /** Share of the effective box outside the frame (0..1). */
  outside_ratio?: number | null;
}

export type GeometryRelation = "same_group" | "ancestor" | "descendant" | "none";

export interface GeometryPairRow {
  /** Qualified refs (`cue_XX/key`), canonical order (composition, cue, key). */
  a: string;
  b: string;
  /**
   * Which shapes the pair math used: `quad` when at least one end has a measured
   * quad (convex-polygon intersection / distance), else `box` (axis-aligned math).
   */
  shape: "quad" | "box";
  /** Horizontal / vertical gap between effective boxes (0 when ranges overlap). */
  gap_x: number | null;
  gap_y: number | null;
  /** Shortest distance (0 when intersecting); null when either end is invisible. */
  distance: number | null;
  /** Intersection area in stage px^2. */
  intersection: number | null;
  /** Intersection over the smaller effective area (0..1). */
  overlap_ratio: number | null;
  /** Qualified ref of the upper element; null when either end is invisible. */
  top: string | null;
  /**
   * How `a` relates to `b`: `ancestor` (a contains b), `descendant` (b contains
   * a), `same_group` (one design group, neither contains the other), `none`.
   * Structural: reported even when an end is invisible; cross-cue pairs are `none`.
   */
  relation: GeometryRelation;
}

export interface GeometryFrameUse {
  cue: string;
  active: boolean;
  /** Used local frame; null when the cue does not cover the moment. */
  local_frame: number | null;
}

// ---------------------------------------------------------------------------
// Moment parsing: `--at` keeps its sequence addressing. Bare frames (`75`)
// mean what they always meant; `<n>f` names a frame and time literals name
// sequence time. Cue-local time is NOT accepted: the same syntax with two
// meanings would be ambiguous, and the agent can add the cue start.
// ---------------------------------------------------------------------------

export interface GeometryMoment {
  sequence_frame: number;
  sequence_ms: number;
}

const BARE_FRAMES = /^\d+$/;
const FRAME_SUFFIX = /^(\d+)[fF]$/;

/**
 * True when `--at` holds query syntax (anything but a bare frame list).
 * Legacy `--at 75[,90...]` keeps returning per-frame boxes.
 */
export function isGeometryAtValue(atRaw: string): boolean {
  const parts = atRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return false;
  return !parts.every((p) => BARE_FRAMES.test(p));
}

export const GEOMETRY_USAGE =
  "cuthol composition coords --at <1500ms|1.5s|45f> [--cue <cue_XX>] [--elements <ref>[,<ref>...]]";

function misuse(detail: string): CutholError {
  return new CutholError(DIAGNOSTICS.COORDS_QUERY_MISUSE(detail, GEOMETRY_USAGE));
}

/** Geometry usage error for CLI-layer validation (same shape as `misuse`). */
export function geometryMisuseError(detail: string): CutholError {
  return misuse(detail);
}

/** Parses one query moment (single value: `<n>`, `<n>f`, or a time literal). */
export function parseGeometryMoment(atRaw: string, stageFps: number): GeometryMoment {
  const fps = Math.max(1, stageFps);
  const raw = atRaw.trim();
  if (raw.length === 0 || raw.includes(",")) {
    throw misuse(`--at ${JSON.stringify(atRaw)} (the geometry query needs one moment)`);
  }
  const suffixed = FRAME_SUFFIX.exec(raw);
  if (suffixed || BARE_FRAMES.test(raw)) {
    const frame = Number(suffixed ? suffixed[1] : raw);
    if (!Number.isSafeInteger(frame)) {
      throw misuse(`--at ${JSON.stringify(atRaw)} (not a valid frame)`);
    }
    return { sequence_frame: frame, sequence_ms: Math.round((frame / fps) * 1000) };
  }
  let ms: number;
  try {
    ms = parseTimeMs(raw);
  } catch {
    throw misuse(`--at ${JSON.stringify(atRaw)} (expected <1500ms|1.5s|45f|75>)`);
  }
  return { sequence_frame: Math.round((ms * fps) / 1000), sequence_ms: ms };
}

// ---------------------------------------------------------------------------
// Pure frame math (no IO): shared by the CLI/MCP path and unit tests.
// ---------------------------------------------------------------------------

interface CueLookupEntry {
  cue: LaneCue;
  /** Paint position of the lane (0 = bottom). */
  laneOrder: number;
  /** Paint position of the cue inside its lane (0 = bottom). */
  cueOrder: number;
}

// Paint order mirrors the compositor (query side only; compiler files stay
// untouched): lanes `[...seq.lanes].sort((a, b) => a.z_index - b.z_index)`
// (compiler.ts:251, stable) and cues `some(z) ? [...cues].sort((z ?? 0)) : cues`
// (compile_lane.ts:966-968, stable). Larger order paints on top.
function buildCueLookup(sequence: CutholSequence): Map<string, CueLookupEntry> {
  const map = new Map<string, CueLookupEntry>();
  const laneOrderByIndex = new Map<number, number>();
  sequence.lanes
    .map((lane, index) => ({ lane, index }))
    .sort((a, b) => a.lane.z_index - b.lane.z_index)
    .forEach((entry, order) => laneOrderByIndex.set(entry.index, order));
  sequence.lanes.forEach((lane, laneIndex) => {
    const indexed = lane.cues.map((cue, index) => ({ cue, index }));
    const ordered = lane.cues.some((c) => c.z_index !== undefined)
      ? [...indexed].sort((a, b) => (a.cue.z_index ?? 0) - (b.cue.z_index ?? 0))
      : indexed;
    const cueOrderByIndex = new Map<number, number>();
    ordered.forEach((entry, order) => cueOrderByIndex.set(entry.index, order));
    lane.cues.forEach((cue, cueIndex) => {
      map.set(cue.id, {
        cue,
        laneOrder: laneOrderByIndex.get(laneIndex) ?? laneIndex,
        cueOrder: cueOrderByIndex.get(cueIndex) ?? cueIndex,
      });
    });
  });
  return map;
}

/** Transitive measured-ancestor chain (cycle-guarded). */
function ancestorsOf(elements: CoordsDocument["elements"], elIndex: number): Set<number> {
  const out = new Set<number>();
  let next = elements[elIndex]?.parent;
  for (let i = 0; i <= elements.length && next !== undefined; i++) {
    if (out.has(next)) break;
    out.add(next);
    next = elements[next]?.parent;
  }
  return out;
}

interface PreparedDoc {
  doc: CoordsDocument;
  cue: LaneCue;
  laneOrder: number;
  cueOrder: number;
  compDir: string;
  active: boolean;
  usedLocal: number | null;
  docFps: number;
  itemsByEl: Map<number, CoordsDocItem>;
  inkByEl: Map<number, [number, number, number, number]>;
  quadsByEl: Map<number, LocalQuad>;
  inkQuadsByEl: Map<number, LocalQuad>;
  ancestorsByEl: Map<number, Set<number>>;
}

function nearestFrameRow(
  frames: CoordsDocument["frames"],
  local: number
): CoordsDocument["frames"][number] | null {
  let best: CoordsDocument["frames"][number] | null = null;
  let bestDist = Infinity;
  for (const fr of frames) {
    const dist = Math.abs(fr.f - local);
    if (dist < bestDist || (dist === bestDist && best !== null && fr.f < best.f)) {
      bestDist = dist;
      best = fr;
    }
  }
  return best;
}

function prepareDocs(
  sequence: CutholSequence,
  docs: CoordsDocument[],
  sequenceFrame: number
): PreparedDoc[] {
  const lookup = buildCueLookup(sequence);
  return docs.map((doc) => {
    const found = lookup.get(doc.cue_id);
    if (!found) {
      throw misuse(`cue '${doc.cue_id}' is not on the sequence`);
    }
    const localRequested = sequenceFrame - doc.sequence_start_frame;
    const inRange =
      localRequested >= 0 &&
      localRequested < Math.max(1, doc.frame_count) &&
      doc.frames.length > 0;
    const row = inRange ? nearestFrameRow(doc.frames, localRequested) : null;
    const itemsByEl = new Map<number, CoordsDocItem>();
    const inkByEl = new Map<number, [number, number, number, number]>();
    const quadsByEl = new Map<number, LocalQuad>();
    const inkQuadsByEl = new Map<number, LocalQuad>();
    if (row) {
      for (const it of row.items) itemsByEl.set(it[0], it);
      for (const ink of row.ink ?? []) inkByEl.set(ink[0], [ink[1], ink[2], ink[3], ink[4]]);
      for (const q of row.quads ?? []) {
        if (q.length === 9 && q.slice(1).every((v) => Number.isFinite(v))) {
          quadsByEl.set(q[0], [q[1], q[2], q[3], q[4], q[5], q[6], q[7], q[8]]);
        }
      }
      for (const q of row.ink_quads ?? []) {
        if (q.length === 9 && q.slice(1).every((v) => Number.isFinite(v))) {
          inkQuadsByEl.set(q[0], [q[1], q[2], q[3], q[4], q[5], q[6], q[7], q[8]]);
        }
      }
    }
    const ancestorsByEl = new Map<number, Set<number>>();
    doc.elements.forEach((_, elIndex) => ancestorsByEl.set(elIndex, ancestorsOf(doc.elements, elIndex)));
    return {
      doc,
      cue: found.cue,
      laneOrder: found.laneOrder,
      cueOrder: found.cueOrder,
      compDir: doc.composition_dir,
      active: row !== null,
      usedLocal: row ? row.f : null,
      docFps: Math.max(1, doc.fps),
      itemsByEl,
      inkByEl,
      quadsByEl,
      inkQuadsByEl,
      ancestorsByEl,
    };
  });
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function nearestKey(want: string, keys: string[]): string | null {
  if (keys.length === 0) return null;
  let best = keys[0];
  let bestDist = editDistance(want, best);
  for (const key of keys.slice(1)) {
    const dist = editDistance(want, key);
    if (dist < bestDist) {
      bestDist = dist;
      best = key;
    }
  }
  return best;
}

interface ResolvedElement {
  prep: PreparedDoc;
  elIndex: number;
  ref: string;
}

/**
 * Resolves refs (`<key>` against the single cue, or `cue_XX/<key>`).
 * The key is the coordinate document's element key (an id when the element has
 * one, else a data key or DOM path), so id refs match by construction.
 */
function resolveRefs(
  refs: string[],
  preps: PreparedDoc[],
  defaultCueId: string | undefined
): ResolvedElement[] {
  const byCue = new Map(preps.map((p) => [p.doc.cue_id, p]));
  const seen = new Set<string>();
  const out: ResolvedElement[] = [];
  for (const token of refs) {
    let cueId: string;
    let key: string;
    const slash = token.indexOf("/");
    if (slash > 0 && /^cue_\d+$/.test(token.slice(0, slash))) {
      cueId = token.slice(0, slash);
      key = token.slice(slash + 1);
    } else if (defaultCueId !== undefined) {
      cueId = defaultCueId;
      key = token;
    } else {
      throw misuse(
        `element '${token}' (needs a cue prefix: '<cue_XX>/${token}') when no single --cue is given`
      );
    }
    const prep = byCue.get(cueId);
    if (!prep) {
      throw misuse(`element '${token}' (cue '${cueId}' has no coordinate document)`);
    }
    const elIndex = prep.doc.elements.findIndex((e) => e.key === key);
    if (elIndex < 0) {
      throw new CutholError(
        DIAGNOSTICS.COORDS_UNKNOWN_ELEMENT(
          token,
          cueId,
          nearestKey(
            key,
            prep.doc.elements.map((e) => e.key)
          )
        )
      );
    }
    const ref = `${cueId}/${key}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ prep, elIndex, ref });
  }
  return out;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/** Share of the box outside the stage rect (0..1). */
function outsideRatio(
  box: { x: number; y: number; w: number; h: number },
  stageW: number,
  stageH: number
): number {
  const total = box.w * box.h;
  if (!(total > 0)) return 0;
  const insideW = Math.min(box.x + box.w, stageW) - Math.max(box.x, 0);
  const insideH = Math.min(box.y + box.h, stageH) - Math.max(box.y, 0);
  const inside = Math.max(0, insideW) * Math.max(0, insideH);
  return Math.min(1, Math.max(0, (total - inside) / total));
}

/**
 * Maps a local quad to stage pixels through the SAME placement math boxes use:
 * each corner is mapped as a degenerate (zero-size) box, so quads can never drift
 * from the compiler-mirror formulas in `coords_map.ts` (a box's own corners map to
 * exactly its mapped box).
 */
export function mapLocalQuadToStage(
  quad: LocalQuad,
  cue: LaneCue,
  ctx: { compWidth: number; compHeight: number; stageWidth: number; stageHeight: number },
  localMs: number
): StageQuad {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < 8; k += 2) {
    const r = mapLocalBoxToStage({ x: quad[k], y: quad[k + 1], w: 0, h: 0 }, cue, ctx, localMs).box;
    pts.push([r.x, r.y]);
  }
  return [pts[0], pts[1], pts[2], pts[3]];
}

/** Convex polygon corners in stage pixels (any winding, e.g. a mapped quad). */
export type ConvexPoly = Array<[number, number]>;

type Poly = ConvexPoly;

function signedPolyArea(poly: Poly): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

/** Convex polygon intersection area (Sutherland–Hodgman clip; any winding). */
export function convexPolygonIntersectionArea(a: Poly, b: Poly): number {
  if (a.length < 3 || b.length < 3) return 0;
  const ccw = signedPolyArea(b) > 0;
  let output = a.map((p): [number, number] => [p[0], p[1]]);
  for (let i = 0; i < b.length; i++) {
    const cp1 = b[i];
    const cp2 = b[(i + 1) % b.length];
    const ex = cp2[0] - cp1[0];
    const ey = cp2[1] - cp1[1];
    const inside = (p: [number, number]): boolean => {
      const cross = ex * (p[1] - cp1[1]) - ey * (p[0] - cp1[0]);
      return ccw ? cross >= -1e-9 : cross <= 1e-9;
    };
    const intersect = (s: [number, number], e: [number, number]): [number, number] => {
      const dx = e[0] - s[0];
      const dy = e[1] - s[1];
      const denom = dx * ey - dy * ex;
      if (Math.abs(denom) < 1e-12) return [e[0], e[1]];
      const t = ((cp1[0] - s[0]) * ey - (cp1[1] - s[1]) * ex) / denom;
      return [s[0] + t * dx, s[1] + t * dy];
    };
    const input = output;
    output = [];
    if (input.length === 0) break;
    let s = input[input.length - 1];
    for (const e of input) {
      const eIn = inside(e);
      const sIn = inside(s);
      if (eIn) {
        if (!sIn) output.push(intersect(s, e));
        output.push(e);
      } else if (sIn) {
        output.push(intersect(s, e));
      }
      s = e;
    }
  }
  if (output.length < 3) return 0;
  return Math.max(0, Math.abs(signedPolyArea(output)));
}

function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0)) return Math.hypot(px - ax, py - ay);
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * True convex-polygon distance: 0 when the polygons touch or overlap, otherwise the
 * minimum vertex-to-edge distance. Unlike `hypot(gap_x, gap_y)` this is exact for
 * rotated shapes.
 */
export function convexPolygonDistance(a: Poly, b: Poly): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (convexPolygonIntersectionArea(a, b) > 1e-9) return 0;
  let best = Infinity;
  for (const [px, py] of a) {
    for (let i = 0; i < b.length; i++) {
      const [ax, ay] = b[i];
      const [bx, by] = b[(i + 1) % b.length];
      const d = pointSegmentDistance(px, py, ax, ay, bx, by);
      if (d < best) best = d;
    }
  }
  for (const [px, py] of b) {
    for (let i = 0; i < a.length; i++) {
      const [ax, ay] = a[i];
      const [bx, by] = a[(i + 1) % a.length];
      const d = pointSegmentDistance(px, py, ax, ay, bx, by);
      if (d < best) best = d;
    }
  }
  return best === Infinity ? 0 : best;
}

function boxCornersAsPoly(box: { x: number; y: number; w: number; h: number }): Poly {
  return [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x + box.w, box.y + box.h],
    [box.x, box.y + box.h],
  ];
}

function polyAabb(poly: Poly): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

interface MappedElement {
  resolved: ResolvedElement;
  visible: boolean;
  item: { x: number; y: number; w: number; h: number } | null;
  ink: { x: number; y: number; w: number; h: number } | null;
  quad: StageQuad | null;
  inkQuad: StageQuad | null;
  opacity: number | null;
  z: number | null;
}

/**
 * Maps one element to stage pixels at the used frame. Ink (glyph/pixel box)
 * wins over the item box wherever present; both map through the same placement.
 * Quads map corner by corner through the same formulas (see `mapLocalQuadToStage`).
 */
function mapElement(
  resolved: ResolvedElement,
  sequence: CutholSequence
): MappedElement {
  const { prep, elIndex } = resolved;
  const base = { resolved, visible: false, item: null, ink: null, quad: null, inkQuad: null, opacity: null, z: null };
  if (!prep.active || prep.usedLocal === null) return base;
  const it = prep.itemsByEl.get(elIndex);
  if (!it) return base;
  const stageW = sequence.stage.width;
  const stageH = sequence.stage.height;
  const ctx = {
    compWidth: prep.doc.width,
    compHeight: prep.doc.height,
    stageWidth: stageW,
    stageHeight: stageH,
  };
  const localMs = (prep.usedLocal / prep.docFps) * 1000;
  const item = mapLocalBoxToStage(
    { x: it[1], y: it[2], w: it[3], h: it[4] },
    prep.cue,
    ctx,
    localMs
  ).box;
  const inkLocal = prep.inkByEl.get(elIndex);
  const ink = inkLocal
    ? mapLocalBoxToStage(
        { x: inkLocal[0], y: inkLocal[1], w: inkLocal[2], h: inkLocal[3] },
        prep.cue,
        ctx,
        localMs
      ).box
    : null;
  const quadLocal = prep.quadsByEl.get(elIndex);
  const quad = quadLocal ? mapLocalQuadToStage(quadLocal, prep.cue, ctx, localMs) : null;
  const inkQuadLocal = prep.inkQuadsByEl.get(elIndex);
  const inkQuad = inkQuadLocal ? mapLocalQuadToStage(inkQuadLocal, prep.cue, ctx, localMs) : null;
  return { resolved, visible: true, item, ink, quad, inkQuad, opacity: it[5], z: it[6] };
}

function elementRow(
  mapped: MappedElement,
  sequence: CutholSequence,
  detail: boolean
): GeometryElementRow | null {
  const { resolved, visible, item, ink, opacity, z } = mapped;
  const el = resolved.prep.doc.elements[resolved.elIndex];
  const row: GeometryElementRow = {
    cue: resolved.prep.doc.cue_id,
    key: el.key,
    kind: el.kind,
    label: el.label,
    item: item ? roundBox1(item) : null,
    ink: ink ? roundBox1(ink) : null,
    opacity,
    z,
  };
  if (!detail) return visible ? row : null;
  const keyOf = (idx: number | undefined): string | null =>
    idx === undefined ? null : (resolved.prep.doc.elements[idx]?.key ?? null);
  row.visible = visible;
  row.parent = keyOf(el.parent);
  row.group = keyOf(el.group);
  const eff = ink ?? item;
  if (!visible || !eff) {
    row.edges = null;
    row.outside_ratio = null;
    return row;
  }
  const stageW = sequence.stage.width;
  const stageH = sequence.stage.height;
  row.edges = {
    left: round1(eff.x),
    top: round1(eff.y),
    right: round1(stageW - (eff.x + eff.w)),
    bottom: round1(stageH - (eff.y + eff.h)),
  };
  row.outside_ratio = round4(outsideRatio(eff, stageW, stageH));
  return row;
}

/** Positive when `a` paints above `b` (compositor order across cues). */
function comparePaint(a: MappedElement, b: MappedElement): number {
  const pa = a.resolved.prep;
  const pb = b.resolved.prep;
  if (pa === pb) {
    if (a.z !== b.z) return (a.z ?? 0) - (b.z ?? 0);
    // Equal z: later document order paints on top.
    return a.resolved.elIndex - b.resolved.elIndex;
  }
  if (pa.laneOrder !== pb.laneOrder) return pa.laneOrder - pb.laneOrder;
  if (pa.cueOrder !== pb.cueOrder) return pa.cueOrder - pb.cueOrder;
  return pa.doc.cue_id < pb.doc.cue_id ? -1 : 1;
}

function relationOf(a: ResolvedElement, b: ResolvedElement): GeometryRelation {
  if (a.prep !== b.prep) return "none";
  const ancestorsA = a.prep.ancestorsByEl.get(a.elIndex) ?? new Set<number>();
  const ancestorsB = b.prep.ancestorsByEl.get(b.elIndex) ?? new Set<number>();
  // `a` is an ancestor when it sits on `b`'s ancestor chain (and vice versa).
  if (ancestorsB.has(a.elIndex)) return "ancestor";
  if (ancestorsA.has(b.elIndex)) return "descendant";
  const elements = a.prep.doc.elements;
  const groupA = elements[a.elIndex].group ?? -1;
  const groupB = elements[b.elIndex].group ?? -1;
  if (groupA !== -1 && groupA === groupB) return "same_group";
  if (groupA === b.elIndex || groupB === a.elIndex) return "same_group";
  return "none";
}

/** Canonical unordered-pair order (deterministic across input orders). */
function entryLess(x: ResolvedElement, y: ResolvedElement): boolean {
  if (x.prep.compDir !== y.prep.compDir) return x.prep.compDir < y.prep.compDir;
  const xc = x.prep.doc.cue_id;
  const yc = y.prep.doc.cue_id;
  if (xc !== yc) return xc < yc;
  return (
    x.prep.doc.elements[x.elIndex].key < y.prep.doc.elements[y.elIndex].key
  );
}

/**
 * Effective end shape for pair math: ink wins over item (as before), quads win over
 * boxes. An end with a measured quad contributes its true corners; otherwise its box
 * corners stand in. Returns the polygon plus whether a true quad was used.
 */
function endPoly(mapped: MappedElement): { poly: Poly; isQuad: boolean } | null {
  const box = (mapped.ink ?? mapped.item) as { x: number; y: number; w: number; h: number } | null;
  if (!box) return null;
  if (mapped.ink) {
    if (mapped.inkQuad) return { poly: mapped.inkQuad.map((p): [number, number] => [p[0], p[1]]), isQuad: true };
    return { poly: boxCornersAsPoly(box), isQuad: false };
  }
  if (mapped.quad) return { poly: mapped.quad.map((p): [number, number] => [p[0], p[1]]), isQuad: true };
  return { poly: boxCornersAsPoly(box), isQuad: false };
}

function pairRow(a: MappedElement, b: MappedElement): GeometryPairRow {
  const [first, second] = entryLess(a.resolved, b.resolved) ? [a, b] : [b, a];
  const row: GeometryPairRow = {
    a: first.resolved.ref,
    b: second.resolved.ref,
    shape: "box",
    gap_x: null,
    gap_y: null,
    distance: null,
    intersection: null,
    overlap_ratio: null,
    top: null,
    relation: relationOf(first.resolved, second.resolved),
  };
  const boxA = (first.ink ?? first.item) as { x: number; y: number; w: number; h: number } | null;
  const boxB = (second.ink ?? second.item) as { x: number; y: number; w: number; h: number } | null;
  if (!first.visible || !second.visible || !boxA || !boxB) return row;
  const endA = endPoly(first);
  const endB = endPoly(second);
  if (endA && endB && (endA.isQuad || endB.isQuad)) {
    // Quad path: convex-polygon intersection / distance. Axis gaps stay defined on
    // the polygon AABBs (axis projections of the true shapes).
    const inter = convexPolygonIntersectionArea(endA.poly, endB.poly);
    const areaA = Math.abs(signedPolyArea(endA.poly));
    const areaB = Math.abs(signedPolyArea(endB.poly));
    const minArea = Math.min(areaA, areaB);
    const aabbA = polyAabb(endA.poly);
    const aabbB = polyAabb(endB.poly);
    const xw = Math.min(aabbA.x + aabbA.w, aabbB.x + aabbB.w) - Math.max(aabbA.x, aabbB.x);
    const yh = Math.min(aabbA.y + aabbA.h, aabbB.y + aabbB.h) - Math.max(aabbA.y, aabbB.y);
    const gx = xw < 0 ? -xw : 0;
    const gy = yh < 0 ? -yh : 0;
    row.shape = "quad";
    row.gap_x = round1(gx);
    row.gap_y = round1(gy);
    row.distance = round1(inter > 0 ? 0 : convexPolygonDistance(endA.poly, endB.poly));
    row.intersection = round1(inter);
    row.overlap_ratio = round4(minArea > 0 ? inter / minArea : 0);
    row.top = comparePaint(first, second) >= 0 ? first.resolved.ref : second.resolved.ref;
    return row;
  }
  const xw = Math.min(boxA.x + boxA.w, boxB.x + boxB.w) - Math.max(boxA.x, boxB.x);
  const yh = Math.min(boxA.y + boxA.h, boxB.y + boxB.h) - Math.max(boxA.y, boxB.y);
  const inter = xw > 0 && yh > 0 ? xw * yh : 0;
  const gx = xw < 0 ? -xw : 0;
  const gy = yh < 0 ? -yh : 0;
  const minArea = Math.min(boxA.w * boxA.h, boxB.w * boxB.h);
  row.gap_x = round1(gx);
  row.gap_y = round1(gy);
  row.distance = round1(inter > 0 ? 0 : Math.hypot(gx, gy));
  row.intersection = round1(inter);
  row.overlap_ratio = round4(minArea > 0 ? inter / minArea : 0);
  row.top = comparePaint(first, second) >= 0 ? first.resolved.ref : second.resolved.ref;
  return row;
}

function frameUses(preps: PreparedDoc[]): GeometryFrameUse[] {
  return preps.map((p) => ({
    cue: p.doc.cue_id,
    active: p.active,
    local_frame: p.usedLocal,
  }));
}

export interface ListGeometryFrameInput {
  sequence: CutholSequence;
  docs: CoordsDocument[];
  sequenceFrame: number;
  /** When set, only this cue is listed. */
  defaultCueId?: string;
}

export interface ListGeometryFrameResult {
  elements: GeometryElementRow[];
  /** Always empty in list mode; present so both modes share one shape. */
  pairs: GeometryPairRow[];
  frames: GeometryFrameUse[];
}

/** Short rows for every element visible in the frame (list mode). */
export function listGeometryFrame(input: ListGeometryFrameInput): ListGeometryFrameResult {
  const preps = prepareDocs(input.sequence, input.docs, input.sequenceFrame);
  const scoped =
    input.defaultCueId !== undefined
      ? preps.filter((p) => p.doc.cue_id === input.defaultCueId)
      : preps;
  if (input.defaultCueId !== undefined && scoped.length === 0) {
    throw misuse(`cue '${input.defaultCueId}' has no coordinate document`);
  }
  const elements: GeometryElementRow[] = [];
  for (const prep of scoped) {
    if (!prep.active) continue;
    const order = [...prep.itemsByEl.keys()].sort((x, y) => x - y);
    for (const elIndex of order) {
      const row = elementRow(
        mapElement(
          { prep, elIndex, ref: `${prep.doc.cue_id}/${prep.doc.elements[elIndex].key}` },
          input.sequence
        ),
        input.sequence,
        false
      );
      if (row) elements.push(row);
    }
  }
  return { elements, pairs: [], frames: frameUses(preps) };
}

export interface DetailGeometryFrameInput {
  sequence: CutholSequence;
  docs: CoordsDocument[];
  sequenceFrame: number;
  refs: string[];
  /** The single `--cue`: resolves bare `<key>` refs. */
  defaultCueId?: string;
}

export interface DetailGeometryFrameResult {
  elements: GeometryElementRow[];
  pairs: GeometryPairRow[];
  frames: GeometryFrameUse[];
}

/** Full rows for the requested elements plus every pair (detail mode). */
export function detailGeometryFrame(input: DetailGeometryFrameInput): DetailGeometryFrameResult {
  if (input.refs.length === 0) {
    throw misuse("--elements needs at least one element reference");
  }
  const preps = prepareDocs(input.sequence, input.docs, input.sequenceFrame);
  const resolved = resolveRefs(input.refs, preps, input.defaultCueId);
  const mapped = resolved.map((r) => mapElement(r, input.sequence));
  const elements = mapped.map(
    (m) => elementRow(m, input.sequence, true) as GeometryElementRow
  );
  const ordered = [...mapped].sort((x, y) =>
    entryLess(x.resolved, y.resolved) ? -1 : 1
  );
  const pairs: GeometryPairRow[] = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      pairs.push(pairRow(ordered[i], ordered[j]));
    }
  }
  return { elements, pairs, frames: frameUses(preps) };
}

// ---------------------------------------------------------------------------
// IO: cache first, measure the missing cues, answer from the documents.
// ---------------------------------------------------------------------------

export interface RunGeometryQueryOptions {
  workspaceDir: string;
  cueId?: string;
  all?: boolean;
  atRaw: string;
  elementsRaw?: string;
  refresh?: boolean;
}

export interface GeometryCueRow {
  cue: string;
  composition: string;
  active: boolean;
  cached: boolean;
  local_frame: number | null;
}

export interface GeometryQueryResult {
  mode: "geometry";
  detail: boolean;
  at: string;
  sequence_frame: number;
  sequence_ms: number;
  stage: { width: number; height: number; fps: number };
  cues: GeometryCueRow[];
  /** Cues measured by this call (cache misses). */
  measured: string[];
  elements: GeometryElementRow[];
  pairs: GeometryPairRow[];
}

/** Same cue-addressing errors as measurement target resolution. */
function requireCompCue(
  lookup: Map<string, CueLookupEntry>,
  id: string,
  where: string
): LaneCue {
  const found = lookup.get(id);
  if (!found) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(id));
  if (!found.cue.composition) {
    throw new CutholError(
      DIAGNOSTICS.UNKNOWN_FLAG(
        `${where} (cue ${id} is not a composition cue)`,
        "composition.coords",
        "cuthol composition coords --at <moment> --cue <composition_cue_XX>"
      )
    );
  }
  return found.cue;
}

export async function runGeometryQuery(
  options: RunGeometryQueryOptions
): Promise<GeometryQueryResult> {
  const { sequence } = loadSequence(options.workspaceDir);
  const stageW = sequence.stage.width;
  const stageH = sequence.stage.height;
  const stageFps = Math.max(1, sequence.stage.fps);
  const moment = parseGeometryMoment(options.atRaw, stageFps);
  const refs =
    options.elementsRaw !== undefined
      ? options.elementsRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined;
  if (options.elementsRaw !== undefined && refs!.length === 0) {
    throw misuse("--elements needs at least one element reference");
  }
  const detail = refs !== undefined;
  const lookup = buildCueLookup(sequence);
  if (options.cueId !== undefined) {
    requireCompCue(lookup, options.cueId, `--cue ${options.cueId}`);
  }

  // Referenced cues from `cue_XX/key` tokens.
  const refCues = new Set<string>();
  for (const token of refs ?? []) {
    const slash = token.indexOf("/");
    if (slash > 0 && /^cue_\d+$/.test(token.slice(0, slash))) {
      refCues.add(token.slice(0, slash));
    }
  }
  for (const id of refCues) {
    requireCompCue(lookup, id, `--elements <ref>`);
  }

  // Involved cues: named cues even when inactive (the agent asked about them),
  // plus every active unmuted composition cue when no single --cue scopes the call.
  const startFrameOf = (cue: LaneCue): number =>
    Math.round((resolveCueStartMs(sequence, cue) * stageFps) / 1000);
  const frameCountOf = (cue: LaneCue): number =>
    Math.max(1, Math.round((cue.duration_ms * stageFps) / 1000));
  const involved = new Set<string>();
  if (options.cueId !== undefined) involved.add(options.cueId);
  for (const id of refCues) involved.add(id);
  if (options.cueId === undefined && (options.all === true || !detail)) {
    for (const lane of sequence.lanes) {
      if (lane.muted) continue;
      for (const cue of lane.cues) {
        if (!cue.composition) continue;
        const local = moment.sequence_frame - startFrameOf(cue);
        if (local >= 0 && local < frameCountOf(cue)) involved.add(cue.id);
      }
    }
  }

  const head = {
    mode: "geometry" as const,
    detail,
    at: options.atRaw.trim(),
    sequence_frame: moment.sequence_frame,
    sequence_ms: moment.sequence_ms,
    stage: { width: stageW, height: stageH, fps: stageFps },
  };
  if (involved.size === 0) {
    return { ...head, cues: [], measured: [], elements: [], pairs: [] };
  }

  // The existing measurement path (cache fast path, one browser for misses).
  const measured = await measureCompositionCues({
    workspaceDir: options.workspaceDir,
    cueIds: [...involved],
    refresh: options.refresh,
  });
  if (measured.skipped_cues.length > 0) {
    const first = measured.skipped_cues[0];
    throw new CutholError(
      DIAGNOSTICS.COORDS_MEASUREMENT_FAILED(first.cue, first.reason)
    );
  }
  const fileOf = new Map(measured.cues.map((c) => [c.cue, c]));
  const cachedOf = new Map(measured.cues.map((c) => [c.cue, c.cached]));
  const docs: CoordsDocument[] = [];
  for (const cueId of involved) {
    const entry = fileOf.get(cueId);
    if (!entry) {
      throw new CutholError(
        DIAGNOSTICS.COORDS_MEASUREMENT_FAILED(cueId, "measured result missing")
      );
    }
    const fileDoc = JSON.parse(fs.readFileSync(entry.file, "utf8")) as CoordsDocument;
    // Sibling cues can share one cache file: same boxes, this cue's identity.
    docs.push({
      ...fileDoc,
      cue_id: cueId,
      sequence_start_frame: startFrameOf(lookup.get(cueId)!.cue),
    });
  }

  const evaluated = detail
    ? detailGeometryFrame({
        sequence,
        docs,
        sequenceFrame: moment.sequence_frame,
        refs: refs!,
        defaultCueId: options.cueId,
      })
    : listGeometryFrame({
        sequence,
        docs,
        sequenceFrame: moment.sequence_frame,
        defaultCueId: options.cueId,
      });
  const frameByCue = new Map(evaluated.frames.map((f) => [f.cue, f]));
  const order = [...involved].sort(
    (x, y) =>
      startFrameOf(lookup.get(x)!.cue) - startFrameOf(lookup.get(y)!.cue) ||
      (x < y ? -1 : x > y ? 1 : 0)
  );
  const cues: GeometryCueRow[] = order.map((cueId) => {
    const doc = docs.find((d) => d.cue_id === cueId)!;
    const use = frameByCue.get(cueId)!;
    return {
      cue: cueId,
      composition: path.basename(doc.composition_dir),
      active: use.active,
      cached: cachedOf.get(cueId) === true,
      local_frame: use.local_frame,
    };
  });
  return {
    ...head,
    cues,
    measured: cues.filter((c) => !c.cached).map((c) => c.cue),
    elements: evaluated.elements,
    pairs: evaluated.pairs,
  };
}
