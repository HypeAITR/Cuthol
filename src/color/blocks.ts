// Colour stage helpers shared by the compiler, the measurement modules, the CLI and Live:
// Look resolution, structural validation, keyframable parameter paths, and the compiled pixel function of an item.
import path from "node:path";
import type { CutholSequence } from "../core/schema.js";
import { cubePixelFunction, readCube } from "./lut.js";
import { isIdentityStage, ResolvedLook, stagePixelFunction } from "./math.js";
import type {
  ColorBlocks,
  ColorLookSpec,
  ColorSourceKind,
  ColorStageSpec,
  HslQualifierBlock,
} from "./types.js";

/** A spine clip or a lane cue that can carry a colour stage. */
export interface ColorItemRef {
  id: string;
  /** `spine` or the lane id. */
  track: string;
  asset_handle: string | undefined;
  stage: ColorStageSpec | undefined;
}

/** Every item of a sequence that can carry a colour stage (spine clips, footage/graphic lane cues). */
export function listColorItems(seq: CutholSequence): ColorItemRef[] {
  const out: ColorItemRef[] = [];
  for (const c of seq.spine.clips) {
    out.push({ id: c.id, track: "spine", asset_handle: c.asset_handle, stage: c.treatments.color });
  }
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      if (!cue.asset_handle) continue;
      const asset = seq.library.find((a) => a.handle === cue.asset_handle);
      if (!asset || (asset.kind !== "footage" && asset.kind !== "graphic")) continue;
      out.push({ id: cue.id, track: lane.id, asset_handle: cue.asset_handle, stage: cue.color });
    }
  }
  return out;
}

/** Effective source kind of an asset: agent-set kind, else measured, else `camera` for footage and `graphic` for stills. */
export function sourceKindOf(seq: CutholSequence, assetHandle: string | undefined): ColorSourceKind {
  const a = seq.library.find((x) => x.handle === assetHandle);
  if (!a) return "camera";
  return a.color_source?.kind ?? a.color_source?.kind_measured ?? (a.kind === "graphic" ? "graphic" : "camera");
}

export interface LookResolution {
  look: ColorLookSpec | null;
  amount: number;
  via: "binding" | "apply_to" | null;
  /** More than one Look reaches the item through `apply_to` (ambiguous; first one wins, verify reports it). */
  conflicts: string[];
}

/**
 * Which Look an item gets. An explicit `stage.look` binding wins (scope is not applied to it). Otherwise the
 * first project Look whose `apply_to` covers the item and whose `scope.kinds` (default `["camera"]`) contains the
 * item's source kind.
 */
export function resolveItemLook(seq: CutholSequence, item: ColorItemRef): LookResolution {
  const looks = seq.looks ?? [];
  const binding = item.stage?.look;
  if (binding) {
    const look = looks.find((l) => l.id === binding.id) ?? null;
    const amount = clampAmount(binding.amount ?? look?.amount ?? 1);
    return { look, amount, via: look ? "binding" : null, conflicts: [] };
  }
  const kind = sourceKindOf(seq, item.asset_handle);
  const hits = looks.filter((l) => {
    const reaches = l.apply_to === "all" || (Array.isArray(l.apply_to) && l.apply_to.includes(item.id));
    const kinds = l.scope?.kinds ?? ["camera"];
    return reaches && kinds.includes(kind);
  });
  if (!hits.length) return { look: null, amount: 0, via: null, conflicts: [] };
  return {
    look: hits[0],
    amount: clampAmount(hits[0].amount ?? 1),
    via: "apply_to",
    conflicts: hits.slice(1).map((l) => l.id),
  };
}

const clampAmount = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 1);

/** Resolves a Look spec for evaluation. `lut_uri` is read relative to the project root (throws on a bad file). */
export function resolveLookForEval(rootDir: string, look: ColorLookSpec | null, amount: number): ResolvedLook | null {
  if (!look || amount <= 0) return null;
  const r: ResolvedLook = { amount };
  if (look.blocks) r.blocks = look.blocks;
  if (look.lut_uri) {
    const abs = path.isAbsolute(look.lut_uri) ? look.lut_uri : path.resolve(rootDir, look.lut_uri);
    r.lut = cubePixelFunction(readCube(abs));
  }
  return r;
}

export interface ItemColorProgram {
  /** Pixel function of the whole stage (blocks + Look) on encoded BT.709 RGB. */
  fn: (p: [number, number, number]) => void;
  identity: boolean;
  look: LookResolution;
  /** Hash input: everything that changes the compiled LUT (stage, Look spec, Look LUT path). */
  hashInput: unknown;
}

/** The compiled colour program of one item at its static values (envelopes not applied). */
export function itemColorProgram(seq: CutholSequence, rootDir: string, item: ColorItemRef, stageOverride?: ColorStageSpec): ItemColorProgram {
  const stage = stageOverride ?? item.stage;
  const look = resolveItemLook(seq, { ...item, stage });
  const resolved = resolveLookForEval(rootDir, look.look, look.amount);
  return {
    fn: stagePixelFunction(stage, resolved),
    identity: isIdentityStage(stage, resolved),
    look,
    hashInput: { stage: stripLookBinding(stage), look: look.look, amount: look.amount },
  };
}

function stripLookBinding(stage: ColorStageSpec | undefined): ColorBlocks | undefined {
  if (!stage) return undefined;
  const { look: _look, ...rest } = stage;
  return rest;
}

// ---------------------------------------------------------------------------------------------
// Keyframable parameters: `color.<block>.<field>`, `color.<block>.amount`, `color.hsl.<id>.<field>`,
// `color.wheels.<wheel>.<field>`, `color.look.amount`.

const NUMERIC_FIELDS: Record<string, string[]> = {
  white_balance: ["temp_mired", "tint", "amount"],
  exposure: ["stops", "amount"],
  tone: ["contrast", "pivot", "shadows", "highlights", "blacks", "whites", "amount"],
  curves: ["amount"],
  saturation: ["saturation", "vibrance", "amount"],
  look: ["amount"],
};
const WHEEL_NAMES = ["lift", "gamma", "gain", "offset"];
const WHEEL_FIELDS = ["hue_deg", "amount", "luma"];
const HSL_FIELDS = [
  "hue_center_deg",
  "hue_width_deg",
  "hue_soft_deg",
  "sat_min",
  "sat_max",
  "luma_min",
  "luma_max",
  "hue_shift_deg",
  "sat_scale",
  "luma_shift",
  "amount",
];

/** Parses a colour envelope parameter; null when it is not a valid colour parameter path. */
export function parseColorParam(param: string):
  | { block: string; field: string; hslId?: string; wheel?: string }
  | null {
  const parts = param.split(".");
  if (parts[0] !== "color" || parts.length < 3) return null;
  const block = parts[1];
  if (block === "hsl") {
    if (parts.length !== 4 || !HSL_FIELDS.includes(parts[3])) return null;
    return { block, hslId: parts[2], field: parts[3] };
  }
  if (block === "wheels") {
    if (parts.length === 3 && parts[2] === "amount") return { block, field: "amount" };
    if (parts.length !== 4 || !WHEEL_NAMES.includes(parts[2]) || !WHEEL_FIELDS.includes(parts[3])) return null;
    return { block, wheel: parts[2], field: parts[3] };
  }
  if (parts.length !== 3 || !(NUMERIC_FIELDS[block] ?? []).includes(parts[2])) return null;
  return { block, field: parts[2] };
}

/** Returns a copy of `stage` with one numeric colour parameter set (creating the block when missing). */
export function withColorParam(stage: ColorStageSpec | undefined, param: string, value: number): ColorStageSpec {
  const p = parseColorParam(param);
  if (!p) throw new Error(`not a colour parameter: ${param}`);
  const s: ColorStageSpec = JSON.parse(JSON.stringify(stage ?? {}));
  if (p.block === "hsl") {
    const q = (s.hsl ?? []).find((h) => h.id === p.hslId);
    if (!q) throw new Error(`no HSL qualifier '${p.hslId}'`);
    (q as unknown as Record<string, number>)[p.field] = value;
    return s;
  }
  if (p.block === "wheels") {
    s.wheels = s.wheels ?? {};
    if (p.wheel) {
      const w = ((s.wheels as Record<string, unknown>)[p.wheel] ?? { hue_deg: 0, amount: 0 }) as Record<string, number>;
      w[p.field] = value;
      (s.wheels as Record<string, unknown>)[p.wheel] = w;
    } else {
      s.wheels.amount = value;
    }
    return s;
  }
  if (p.block === "look") {
    if (!s.look) throw new Error("no Look binding on this item");
    s.look.amount = value;
    return s;
  }
  const defaults: Record<string, Record<string, number>> = {
    white_balance: { temp_mired: 0, tint: 0 },
    exposure: { stops: 0 },
    tone: {},
    curves: {},
    saturation: {},
  };
  const key = p.block as keyof ColorStageSpec;
  const blk = ((s as Record<string, unknown>)[key] ?? { ...defaults[p.block] }) as Record<string, number>;
  blk[p.field] = value;
  (s as Record<string, unknown>)[key] = blk;
  return s;
}

/** A structural problem in a colour stage or Look (verification turns these into diagnostics). */
export interface ColorIssue {
  itemId: string;
  path: string;
  message: string;
}

const finite = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);

function checkRange(issues: ColorIssue[], itemId: string, p: string, v: unknown, lo: number, hi: number): void {
  if (v === undefined) return;
  if (!finite(v) || (v as number) < lo || (v as number) > hi) {
    issues.push({ itemId, path: p, message: `must be a number in ${lo}..${hi} (got ${JSON.stringify(v)})` });
  }
}

/** Structural validation of a stage's blocks (ranges, curve points, unique HSL ids). */
export function validateColorBlocks(itemId: string, blocks: ColorBlocks | undefined, prefix = "color"): ColorIssue[] {
  const issues: ColorIssue[] = [];
  if (!blocks) return issues;
  const all = blocks as Record<string, unknown>;
  for (const [name, b] of Object.entries(all)) {
    if (b && typeof b === "object" && !Array.isArray(b)) checkRange(issues, itemId, `${prefix}.${name}.amount`, (b as { amount?: unknown }).amount, 0, 1);
  }
  const wb = blocks.white_balance;
  if (wb) {
    checkRange(issues, itemId, `${prefix}.white_balance.temp_mired`, wb.temp_mired ?? 0, -300, 300);
    checkRange(issues, itemId, `${prefix}.white_balance.tint`, wb.tint ?? 0, -1, 1);
  }
  if (blocks.exposure) checkRange(issues, itemId, `${prefix}.exposure.stops`, blocks.exposure.stops ?? 0, -8, 8);
  const t = blocks.tone;
  if (t) {
    for (const k of ["contrast", "shadows", "highlights", "blacks", "whites"] as const) {
      checkRange(issues, itemId, `${prefix}.tone.${k}`, t[k], -1, 1);
    }
    checkRange(issues, itemId, `${prefix}.tone.pivot`, t.pivot, 0.05, 0.95);
  }
  const cv = blocks.curves;
  if (cv) {
    for (const ch of ["master", "r", "g", "b"] as const) {
      const pts = cv[ch];
      if (pts === undefined) continue;
      if (!Array.isArray(pts) || pts.length > 16) {
        issues.push({ itemId, path: `${prefix}.curves.${ch}`, message: "must be a list of at most 16 [x, y] points" });
        continue;
      }
      pts.forEach((pt, i) => {
        if (!Array.isArray(pt) || pt.length !== 2 || !pt.every((v) => finite(v) && v >= 0 && v <= 1)) {
          issues.push({ itemId, path: `${prefix}.curves.${ch}[${i}]`, message: "point must be [x, y] with both in 0..1" });
        }
      });
    }
  }
  const wh = blocks.wheels;
  if (wh) {
    for (const w of WHEEL_NAMES) {
      const v = (wh as Record<string, { hue_deg?: unknown; amount?: unknown; luma?: unknown } | undefined>)[w];
      if (!v) continue;
      checkRange(issues, itemId, `${prefix}.wheels.${w}.hue_deg`, v.hue_deg, -360, 360);
      checkRange(issues, itemId, `${prefix}.wheels.${w}.amount`, v.amount, 0, 1);
      checkRange(issues, itemId, `${prefix}.wheels.${w}.luma`, v.luma, -1, 1);
    }
  }
  const ids = new Set<string>();
  for (const q of blocks.hsl ?? ([] as HslQualifierBlock[])) {
    if (!q.id || ids.has(q.id)) issues.push({ itemId, path: `${prefix}.hsl`, message: `HSL qualifier id '${q.id}' missing or duplicated` });
    ids.add(q.id);
    const p = `${prefix}.hsl.${q.id}`;
    checkRange(issues, itemId, `${p}.hue_center_deg`, q.hue_center_deg, -360, 360);
    checkRange(issues, itemId, `${p}.hue_width_deg`, q.hue_width_deg, 0, 360);
    checkRange(issues, itemId, `${p}.hue_soft_deg`, q.hue_soft_deg, 0, 180);
    for (const k of ["sat_min", "sat_max", "luma_min", "luma_max"] as const) checkRange(issues, itemId, `${p}.${k}`, q[k], 0, 1);
    checkRange(issues, itemId, `${p}.hue_shift_deg`, q.hue_shift_deg, -180, 180);
    checkRange(issues, itemId, `${p}.sat_scale`, q.sat_scale, 0, 4);
    checkRange(issues, itemId, `${p}.luma_shift`, q.luma_shift, -1, 1);
  }
  const s = blocks.saturation;
  if (s) {
    checkRange(issues, itemId, `${prefix}.saturation.saturation`, s.saturation, 0, 4);
    checkRange(issues, itemId, `${prefix}.saturation.vibrance`, s.vibrance, -1, 1);
  }
  return issues;
}
