// Colour data model (sequence JSON) and the shared API shapes of the colour modules.
//
// A colour stage is a fixed-order list of point operations written as editable blocks. Every block of a stage
// (plus its bound Look) is compiled into ONE 3D LUT by `src/color/lut.ts`; the render, the Live preview and the
// render-free "after" prediction all read that same LUT. Cuthol never applies a colour change on its own:
// blocks are written by the agent (`color set`), `color solve` only proposes a patch.
//
// Pixel domain of the blocks: BT.709 display-encoded R'G'B' in 0..1 (full range). Operations that are physically
// linear (white balance, exposure) decode with the BT.1886 2.4 power first and re-encode afterwards.

/** What a source shows. Screen recordings and graphics are designed colour: Looks skip them by default. */
export type ColorSourceKind = "camera" | "screen" | "graphic";

/**
 * Source input transform, applied before any colour block (never keyframed).
 * `auto`: HLG/PQ sources (by transfer tag) are tone-mapped to SDR BT.709, everything else is left as is.
 */
export type ColorInputTransform = "auto" | "none" | "hlg_to_sdr" | "pq_to_sdr";

/** `library[].color_source`. Omitted = measured kind is unknown, input transform `auto`. */
export interface ColorSourceSpec {
  /** Kind set by the agent; wins over `kind_measured`. */
  kind?: ColorSourceKind;
  /** Kind measured by `color kind` / `color map` (written by Cuthol, informational). */
  kind_measured?: ColorSourceKind;
  input?: ColorInputTransform;
}

/** Fields every block shares. `enabled` omitted = true; `amount` omitted = 1 (0..1, blends block output with its input). */
export interface ColorBlockBase {
  enabled?: boolean;
  amount?: number;
}

/**
 * White balance in linear light. `temp_mired`: shift in mired from D65, positive = warmer (towards orange),
 * negative = cooler. `tint`: -1..1, positive = magenta, negative = green. Luma is preserved.
 */
export interface WhiteBalanceBlock extends ColorBlockBase {
  temp_mired: number;
  tint: number;
}

/** Exposure in stops (linear-light gain 2^stops). */
export interface ExposureBlock extends ColorBlockBase {
  stops: number;
}

/**
 * Tone shaping on encoded values; every field -1..1, 0 = neutral.
 * `contrast` is a pivoted S curve (pivot default 18% grey = 0.4894 encoded); `shadows`/`highlights` lift or
 * lower the lower/upper tone regions; `blacks`/`whites` move the end points.
 */
export interface ToneBlock extends ColorBlockBase {
  contrast?: number;
  pivot?: number;
  shadows?: number;
  highlights?: number;
  blacks?: number;
  whites?: number;
}

/** A curve point [input, output], both 0..1. */
export type ColorCurvePoint = [number, number];

/**
 * Monotone cubic curves (Fritsch–Carlson) on encoded values. Missing end points default to (0,0) and (1,1).
 * `master` runs first, then the per-channel curves.
 */
export interface CurvesBlock extends ColorBlockBase {
  master?: ColorCurvePoint[];
  r?: ColorCurvePoint[];
  g?: ColorCurvePoint[];
  b?: ColorCurvePoint[];
}

/**
 * One colour wheel: a chroma push towards `hue_deg` (HSV hue: 0 red, 120 green, 240 blue) of strength
 * `amount` (0..1) plus an equal-channel `luma` push (-1..1).
 */
export interface ColorWheelValue {
  hue_deg: number;
  amount: number;
  luma?: number;
}

/** Lift (shadows), gamma (mids), gain (highlights), offset (all) wheels on encoded values. */
export interface WheelsBlock extends ColorBlockBase {
  lift?: ColorWheelValue;
  gamma?: ColorWheelValue;
  gain?: ColorWheelValue;
  offset?: ColorWheelValue;
}

/**
 * HSL secondary: a soft qualifier (hue window, optional saturation and luma ranges) and the change applied
 * inside it. Only this block can appear more than once (each with its own `id`, e.g. `hsl_01`).
 */
export interface HslQualifierBlock extends ColorBlockBase {
  id: string;
  hue_center_deg: number;
  /** Full width of the fully selected hue window. */
  hue_width_deg: number;
  /** Soft edge on each side of the window; default = half of `hue_width_deg`. */
  hue_soft_deg?: number;
  /** Saturation range 0..1 (HSV saturation); default 0..1. */
  sat_min?: number;
  sat_max?: number;
  /** Luma range 0..1 (BT.709 Y'); default 0..1. */
  luma_min?: number;
  luma_max?: number;
  /** Hue rotation inside the selection, degrees. */
  hue_shift_deg?: number;
  /** Chroma multiplier inside the selection (1 = unchanged). */
  sat_scale?: number;
  /** Luma push inside the selection, -1..1. */
  luma_shift?: number;
}

/** Global saturation multiplier (1 = unchanged) and vibrance (-1..1; boosts low-chroma pixels more, protects skin hues). */
export interface SaturationBlock extends ColorBlockBase {
  saturation?: number;
  vibrance?: number;
}

/** Binds an item to a project Look. `amount` overrides the Look's own amount for this item. */
export interface ColorLookBinding {
  id: string;
  amount?: number;
}

/** Fixed block order of a colour stage (the compiler always runs them in this order). */
export const COLOR_STAGE_ORDER = [
  "white_balance",
  "exposure",
  "tone",
  "curves",
  "wheels",
  "hsl",
  "saturation",
  "look",
] as const;
export type ColorStageBlockName = (typeof COLOR_STAGE_ORDER)[number];

/** `treatments.color` of a spine clip and `color` of a visual lane cue. All blocks optional. */
export interface ColorStageSpec {
  white_balance?: WhiteBalanceBlock;
  exposure?: ExposureBlock;
  tone?: ToneBlock;
  curves?: CurvesBlock;
  wheels?: WheelsBlock;
  hsl?: HslQualifierBlock[];
  saturation?: SaturationBlock;
  look?: ColorLookBinding;
}

/** The point blocks of a stage (everything except the Look binding). */
export type ColorBlocks = Omit<ColorStageSpec, "look">;

/**
 * A named, project-level Look (`looks[]`). Its point part is either a `.cube` file (`lut_uri`, project-relative)
 * or blocks. It joins the LUT of every item it reaches: items bound explicitly (`stage.look`) and, when
 * `apply_to` is `"all"` or lists the item, every item whose source kind is in `scope.kinds`.
 */
export interface ColorLookSpec {
  id: string;
  name: string;
  lut_uri?: string | null;
  blocks?: ColorBlocks;
  /** 0..1, default 1. */
  amount?: number;
  /** Items the Look reaches without an explicit binding. Omitted = none (explicit bindings only). */
  apply_to?: "all" | string[];
  /** Source kinds reached through `apply_to`. Default `["camera"]`. */
  scope?: { kinds?: ColorSourceKind[] };
  /** How the Look was made (informational). */
  origin?: { kind: "pair" | "reference" | "blocks" | "file"; note?: string };
}

// ---------------------------------------------------------------------------------------------
// API shapes shared by the colour modules (measurement, solving, prediction). Implementations live in
// src/color/{frames,map,diff,solve,predict,cluster,source_kind,variants,render_check}.ts.

/** Decoded, downscaled RGB frames of one item (encoded BT.709, 0..1, interleaved RGB per frame). */
export interface ColorFrameSet {
  width: number;
  height: number;
  /** Item-local time of each frame. */
  at_ms: number[];
  frames: Float32Array[];
  /** Where the pixels were taken: before the colour stage (after the input transform) or after it. */
  stage: "source" | "graded";
}

/** A text-first colour map of a frame set. `lines` is the compact form given to agents (~100 tokens). */
export interface ColorMap {
  version: 1;
  frames: number;
  /** Measured fields (stable keys; see map.ts). */
  fields: Record<string, number | string | number[] | Record<string, number>>;
  /** Evidence notes, e.g. "neutral coverage 0.4%: cast and scene colour cannot be separated". */
  evidence: string[];
  lines: string[];
}

export interface ColorDiff {
  /** Differences expressed in block units where possible (stops, mired, tint, saturation...). */
  deltas: Record<string, number>;
  /** Overlap of the two maps, 0..1 (how comparable they are). */
  overlap: number;
  lines: string[];
}

export type ColorSolveMode = "match" | "pair" | "technical";

export interface ColorSolveResult {
  mode: ColorSolveMode;
  /** Proposed blocks (never applied by Cuthol). */
  patch: ColorBlocks;
  /** For `pair`: a project-relative `.cube` written for a Look. */
  lut_uri?: string;
  predicted_residual_de: number;
  lines: string[];
}

export interface ColorPrediction {
  after: ColorMap;
  /** Side effects worth a look, e.g. "neutral highs a+9 (white wall turns pink)". */
  side_effects: string[];
  /** Mean CIEDE2000 between source and graded samples. */
  mean_change_de: number;
  lines: string[];
}
