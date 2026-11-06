/**
 * Cuthol Native Sequence Schema (`cuthol.sequence.json`).
 *
 * Clean-room design tailored for AI agent context efficiency, modality-prefixed
 * handles (`vid_01`, `aud_01`, `sp_01`, `cue_01`), a magnetic primary narrative `spine`,
 * and typed parallel `lanes` with optional spine anchoring.
 */

import { OPEN_STANDARDS } from "./standards.js";

export type AspectPreset = "9:16" | "16:9" | "1:1" | "4:5";

export type AssetKind = "footage" | "audio" | "graphic" | "voiceover" | "composition";

export type LaneKind = "broll" | "caption" | "title" | "music" | "sfx" | "voiceover" | "composition";

export interface ProbeMetadata {
  duration_ms: number;
  width: number;
  height: number;
  fps: number;
  is_vfr?: boolean;
  r_frame_rate?: string | null;
  avg_frame_rate?: string | null;
  pix_fmt?: string | null;
  color_space?: string | null;
  color_range?: string | null;
  color_transfer?: string | null;
  color_primaries?: string | null;
  has_video: boolean;
  has_audio: boolean;
  video_codec: string | null;
  audio_codec: string | null;
  sample_rate: number | null;
  channels: number | null;
  size_bytes: number;
}

export interface MediaSourceRef {
  /** Media provider id, e.g. `ext:media-folder`. */
  provider: string;
  /** Candidate id within the provider. */
  id: string;
  title?: string;
  license?: string;
  source_url?: string;
  fetched_at?: string;
}

export interface LibraryItem {
  handle: string;
  kind: AssetKind;
  uri: string;
  digest_sha256: string;
  probe: ProbeMetadata;
  /**
   * Where a fetched media asset came from (set by `library fetch` from a media provider).
   */
  source?: MediaSourceRef;
  analysis_refs: {
    loudness?: string;
    waveform?: string;
    beats?: string;
    scenes?: string;
    transcript?: string;
    subject?: string;
  };
}

export interface SpatialPlacement {
  x_pct: number;
  y_pct: number;
  scale_x: number;
  scale_y: number;
  rotation_deg: number;
  opacity: number;
  fit_mode: "cover" | "contain" | "fill";
  crop: { left_pct: number; top_pct: number; right_pct: number; bottom_pct: number } | null;
  mirror_x: boolean;
  mirror_y: boolean;
  /**
   * What fills stage area a moved/scaled/rotated clip no longer covers. Omitted = "transparent"
   * (today's behaviour: the layer below shows). "mirror" reflects the clip at its edges, "clamp" repeats the edge pixels.
   */
  edge?: "transparent" | "mirror" | "clamp";
}

export interface AudioProcessingChain {
  gain_db: number;
  muted: boolean;
  fade_in_ms: number;
  fade_out_ms: number;
  denoise: {
    enabled: boolean;
    nr_db: number;
    noise_floor_db: number;
  };
  voice_clarity: {
    enabled: boolean;
    highpass_hz: number;
    presence_boost_db: number;
    compressor_ratio: number;
  };
  loudness_target_lufs: number | null;
  true_peak_ceiling_dbtp: number;
}

export interface VisualTreatments {
  cutout: {
    mode: "none" | "auto" | "chroma";
    chroma_key_hex: string | null;
    similarity: number;
    blend: number;
    feather_px: number;
  };
  mask: {
    shape: "rect" | "ellipse" | "split";
    center_x_pct: number;
    center_y_pct: number;
    width_pct: number;
    height_pct: number;
    feather_px: number;
    invert: boolean;
  } | null;
  motion_blur: {
    enabled: boolean;
    shutter_deg: number;
    subframes: number;
  };
  reframe: {
    enabled: boolean;
    mode: "center_lock" | "subject_track";
    focal_points: Array<{
      offset_ms: number;
      center_x_pct: number;
      center_y_pct: number;
      confidence?: number;
    }>;
  };
  color_grade: {
    brightness: number;
    contrast: number;
    saturation: number;
    temperature_k: number;
    lut_uri: string | null;
  };
}

/**
 * Easing of a segment. The four named curves are quadratic. "cubic_bezier" uses `bezier`
 * ([x1, y1, x2, y2], CSS `cubic-bezier()` semantics, x in [0, 1]). "hold" is a step: the previous value holds until this point's instant, then jumps (envelopes only).
 */
export type EasingKind = "linear" | "ease_in" | "ease_out" | "ease_in_out" | "cubic_bezier" | "hold";
export type CubicBezierControlPoints = [number, number, number, number];

export type BuiltinTransitionKind = "dissolve" | "fade" | "wipe_left" | "wipe_right" | "slide_up" | "zoom_in";
/** An effect registered by an enabled extension, written `ext:<extension>/<name>`. */
export type ExtensionEffectRef = `ext:${string}/${string}`;
export type EffectParamValue = number | string | boolean;

export interface TransitionSpec {
  /** Built-in kind, or an extension transition (`ext:<extension>/<name>`). */
  kind: BuiltinTransitionKind | ExtensionEffectRef;
  duration_ms: number;
  easing: EasingKind;
  bezier?: CubicBezierControlPoints;
  /** Parameters of an extension transition (validated against its manifest definition). */
  params?: Record<string, EffectParamValue>;
}

export interface ParameterEnvelopePoint {
  offset_ms: number;
  value: number;
  /** Easing of the segment that ENDS at this point (the curve from the previous point to this one). */
  easing: EasingKind;
  bezier?: CubicBezierControlPoints;
}

/**
 * One entry of a spine clip's effect chain. Applied in the render graph on the clip itself (the source
 * asset is not replaced, transcript bindings stay). Numeric params can be animated with an envelope whose
 * parameter is `fx.<id>.<param>`.
 */
export interface ClipFxSpec {
  /** Stable handle inside the clip, e.g. `fx_01`. */
  id: string;
  /** Built-in fx kind, or `ext:<extension>/<name>` from an enabled extension's `fx` section. */
  kind: string;
  params: Record<string, EffectParamValue>;
  /** Omitted = true. */
  enabled?: boolean;
}

export interface ParameterEnvelope {
  parameter:
    | "placement.x_pct"
    | "placement.y_pct"
    | "placement.scale_x"
    | "placement.scale_y"
    | "placement.rotation_deg"
    | "placement.opacity"
    | "audio_chain.gain_db"
    | "treatments.color_grade.brightness"
    | "treatments.color_grade.contrast"
    | "treatments.color_grade.saturation"
    | `fx.${string}.${string}`;
  points: ParameterEnvelopePoint[];
}

export interface SpeedRampPoint {
  source_offset_ms: number;
  rate: number;
}

export interface SpineClip {
  id: string;
  asset_handle: string;
  source_in_ms: number;
  source_out_ms: number;
  timeline_in_ms: number;
  duration_ms: number;
  playback: {
    rate: number;
    preserve_pitch: boolean;
    speed_ramp: SpeedRampPoint[] | null;
  };
  placement: SpatialPlacement;
  audio_chain: AudioProcessingChain;
  treatments: VisualTreatments;
  transition_out: TransitionSpec | null;
  envelopes: ParameterEnvelope[];
  /** Per-clip effect chain, applied in order (compositor/compile_spine_fx.ts). Omitted = none. */
  fx?: ClipFxSpec[];
}

export interface TimedWordToken {
  word: string;
  source_start_ms: number;
  source_end_ms: number;
  sequence_start_ms: number | null;
  sequence_end_ms: number | null;
  clip_id?: string | null;
  excised?: boolean;
  confidence?: number;
}

export interface TypographySpec {
  text: string;
  words?: TimedWordToken[];
  font_family: string;
  font_size_px: number;
  font_weight: number;
  color_hex: string;
  active_word_color_hex?: string;
  stroke_color_hex: string | null;
  stroke_width_px: number;
  box_color_hex: string | null;
  box_opacity: number;
  align: "left" | "center" | "right";
  max_width_pct: number;
}

export type HyperFramesCompositeMode = "overlay_alpha" | "scene_host";

export interface HyperFramesMountSpec {
  composition_dir: string;
  entry_html: string;
  props: Record<string, unknown>;
  transparent: boolean;
  mode?: HyperFramesCompositeMode;
}

export interface CueAnchor {
  ref: string; // SpineClip id (e.g. `sp_01`)
  offset_ms: number;
}

export interface CuePlaybackSpec {
  rate: number;
  preserve_pitch: boolean;
}

export interface LaneCue {
  id: string;
  kind: LaneKind;
  asset_handle?: string;
  anchor: CueAnchor | null;
  cue_anchor?: CueAnchor | null;
  at_ms: number;
  duration_ms: number;
  source_in_ms?: number;
  source_out_ms?: number;
  playback?: CuePlaybackSpec;
  z_index?: number;
  placement: SpatialPlacement;
  audio_chain?: AudioProcessingChain;
  typography?: TypographySpec;
  composition?: HyperFramesMountSpec;
  envelopes: ParameterEnvelope[];
}

export function getCuePlaybackRate(cue: Pick<LaneCue, "playback">): number {
  const r = cue.playback?.rate;
  return typeof r === "number" && Number.isFinite(r) && r > 0 ? r : 1.0;
}

export interface ParallelLane {
  id: string;
  kind: LaneKind;
  z_index: number;
  muted: boolean;
  locked: boolean;
  cues: LaneCue[];
}

export interface TimelineMarker {
  id: string;
  at_ms: number;
  label: string;
  category: "beat" | "scene" | "chapter" | "note";
}

export interface MasterAudioBusSpec {
  gain_db: number;
  target_lufs: number;
  true_peak_ceiling_dbtp: number;
}

export interface MountedExtensionRef {
  name: string;
  version: string;
  content_hash: string;
  scope: "project" | "persistent";
  enabled_at: string;
}

export interface CutholSequence {
  schema_version: "1.0.0";
  meta: {
    project_id: string;
    title: string;
    revision: number;
    created_at: string;
    updated_at: string;
    handle_counters?: Record<string, number>;
  };
  stage: {
    width: number;
    height: number;
    aspect: AspectPreset;
    fps: number;
    timebase: "ms";
    color_space: "bt709";
    backdrop: {
      kind: "solid" | "blurred_fill" | "image";
      color: string;
      blur_sigma: number;
    };
    master_audio?: MasterAudioBusSpec;
  };
  library: LibraryItem[];
  spine: {
    magnetic: boolean;
    clips: SpineClip[];
  };
  lanes: ParallelLane[];
  markers: TimelineMarker[];
  extensions?: MountedExtensionRef[];
  /**
   * Default speech providers for this project (`speech providers` to change; the
   * `--provider` flag and `CUTHOL_ASR_PROVIDER` / `CUTHOL_TTS_PROVIDER` override it).
   */
  providers?: {
    asr?: string;
    tts?: string;
  };
  /**
   * Retired reviewer keys (`coords_suppress`, `coords_rules`) from the removed layout
   * warning system: ignored, but preserved so old projects keep opening and undo
   * stays consistent (no migration rewrites the file outside the journal).
   */
  review?: Record<string, unknown>;
}

export function resolveAspectDimensions(aspect: AspectPreset): { width: number; height: number } {
  switch (aspect) {
    case "9:16":
      return { width: 1080, height: 1920 };
    case "16:9":
      return { width: 1920, height: 1080 };
    case "1:1":
      return { width: 1080, height: 1080 };
    case "4:5":
      return { width: 1080, height: 1350 };
  }
}

export function createDefaultPlacement(): SpatialPlacement {
  return {
    x_pct: 0.0,
    y_pct: 0.0,
    scale_x: 1.0,
    scale_y: 1.0,
    rotation_deg: 0.0,
    opacity: 1.0,
    fit_mode: "cover",
    crop: null,
    mirror_x: false,
    mirror_y: false,
  };
}

export function createDefaultAudioChain(): AudioProcessingChain {
  return {
    gain_db: 0.0,
    muted: false,
    fade_in_ms: 0,
    fade_out_ms: 0,
    denoise: {
      enabled: false,
      nr_db: OPEN_STANDARDS.DENOISE_AFFTDN.DEFAULT_NR_DB,
      noise_floor_db: OPEN_STANDARDS.DENOISE_AFFTDN.DEFAULT_NOISE_FLOOR_DB,
    },
    voice_clarity: {
      enabled: false,
      highpass_hz: OPEN_STANDARDS.VOICE_CLARITY.DEFAULT_HIGHPASS_HZ,
      presence_boost_db: OPEN_STANDARDS.VOICE_CLARITY.DEFAULT_PRESENCE_BOOST_DB,
      compressor_ratio: OPEN_STANDARDS.VOICE_CLARITY.DEFAULT_COMPRESSOR_RATIO,
    },
    loudness_target_lufs: null,
    true_peak_ceiling_dbtp: OPEN_STANDARDS.LOUDNESS.DEFAULT_TRUE_PEAK_DBTP,
  };
}

export function createDefaultTreatments(): VisualTreatments {
  return {
    cutout: {
      mode: "none",
      chroma_key_hex: null,
      similarity: 0.15,
      blend: 0.05,
      feather_px: 0,
    },
    mask: null,
    motion_blur: {
      enabled: false,
      shutter_deg: 180,
      subframes: 4,
    },
    reframe: {
      enabled: false,
      mode: "center_lock",
      focal_points: [],
    },
    color_grade: {
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.0,
      temperature_k: 6500,
      lut_uri: null,
    },
  };
}

export function createEmptySequence(options: {
  projectId: string;
  title: string;
  aspect?: AspectPreset;
  fps?: number;
}): CutholSequence {
  const aspect = options.aspect ?? "9:16";
  const { width, height } = resolveAspectDimensions(aspect);
  const now = new Date().toISOString();

  return {
    schema_version: "1.0.0",
    meta: {
      project_id: options.projectId,
      title: options.title,
      revision: 1,
      created_at: now,
      updated_at: now,
      handle_counters: {},
    },
    stage: {
      width,
      height,
      aspect,
      fps: options.fps ?? 30,
      timebase: "ms",
      color_space: "bt709",
      backdrop: {
        kind: "solid",
        color: "#0D0F12",
        blur_sigma: 0,
      },
    },
    library: [],
    spine: {
      magnetic: true,
      clips: [],
    },
    lanes: [
      { id: "ln_broll", kind: "broll", z_index: 10, muted: false, locked: false, cues: [] },
      { id: "ln_motion", kind: "composition", z_index: 20, muted: false, locked: false, cues: [] },
      { id: "ln_titles", kind: "title", z_index: 25, muted: false, locked: false, cues: [] },
      { id: "ln_captions", kind: "caption", z_index: 30, muted: false, locked: false, cues: [] },
      { id: "ln_vo", kind: "voiceover", z_index: 0, muted: false, locked: false, cues: [] },
      { id: "ln_sfx", kind: "sfx", z_index: -5, muted: false, locked: false, cues: [] },
      { id: "ln_bgm", kind: "music", z_index: -10, muted: false, locked: false, cues: [] },
    ],
    markers: [],
  };
}

function isCutholSequence(val: unknown): val is CutholSequence {
  return Boolean(
    val &&
      typeof val === "object" &&
      "meta" in (val as Record<string, unknown>) &&
      "spine" in (val as Record<string, unknown>) &&
      "lanes" in (val as Record<string, unknown>)
  );
}

/**
 * Ensures `seq.meta.handle_counters` records the highest numeric suffix seen for every
 * modality prefix across the sequence (`library`, `spine.clips`, `lanes[].cues`, `markers`)
 * plus any `extraHandles`. Safe on legacy sequence files where `handle_counters` is undefined.
 */
export function syncSequenceHandleCounters(
  seq: CutholSequence,
  extraHandles?: Iterable<string>
): Record<string, number> {
  if (!seq.meta.handle_counters || typeof seq.meta.handle_counters !== "object") {
    seq.meta.handle_counters = {};
  }
  const counters = seq.meta.handle_counters;
  const observe = (h: string | undefined): void => {
    if (!h) return;
    const m = /^([a-z]+)_(\d+)$/.exec(h);
    if (!m) return;
    const pfx = m[1];
    const num = parseInt(m[2], 10);
    if (Number.isFinite(num) && num > (counters[pfx] ?? 0)) {
      counters[pfx] = num;
    }
  };
  for (const item of seq.library ?? []) observe(item.handle);
  for (const clip of seq.spine?.clips ?? []) observe(clip.id);
  for (const lane of seq.lanes ?? []) {
    observe(lane.id);
    for (const cue of lane.cues ?? []) observe(cue.id);
  }
  for (const marker of seq.markers ?? []) observe(marker.id);
  if (extraHandles) {
    for (const h of extraHandles) observe(h);
  }
  return counters;
}

/**
 * Allocates the next available modality-prefixed handle (`vid_01`, `aud_01`, `img_01`, `sp_01`, `cue_01`, `mk_01`).
 * When `seq` (`CutholSequence`) is provided (either as the first argument or third argument),
 * handle allocation is monotonic per prefix via `seq.meta.handle_counters` so previously deleted
 * handles are never re-issued in the same project (and remain consistent across undo/redo).
 */
/**
 * A still image (PNG/JPEG/WebP/…) has no intrinsic length: it can be held on the timeline for any duration.
 * `probe.duration_ms` of a still is only the default length used when no out point is given.
 */
export function isStillGraphic(asset: Pick<LibraryItem, "kind" | "probe">): boolean {
  return asset.kind === "graphic" && (asset.probe.fps === 0 || asset.probe.duration_ms === 0);
}

/** Practical upper bound for holding a still image (24 h); finite so it can be stored in the sequence. */
export const STILL_GRAPHIC_MAX_SOURCE_MS = 24 * 60 * 60 * 1000;

/** Longest source range an asset can supply (a still can be held for up to 24 h). */
export function maxSourceDurationMs(asset: Pick<LibraryItem, "kind" | "probe">): number {
  return isStillGraphic(asset) ? STILL_GRAPHIC_MAX_SOURCE_MS : asset.probe.duration_ms;
}

export function allocateNextHandle(
  existingHandles: Iterable<string> | CutholSequence,
  prefix: string,
  seq?: CutholSequence
): string {
  const targetSeq = isCutholSequence(existingHandles) ? existingHandles : seq;
  const extraHandles: Iterable<string> = isCutholSequence(existingHandles) ? [] : existingHandles;

  if (targetSeq) {
    const counters = syncSequenceHandleCounters(targetSeq, extraHandles);
    const used = new Set<string>(extraHandles);
    for (const item of targetSeq.library ?? []) used.add(item.handle);
    for (const clip of targetSeq.spine?.clips ?? []) used.add(clip.id);
    for (const lane of targetSeq.lanes ?? []) {
      used.add(lane.id);
      for (const cue of lane.cues ?? []) used.add(cue.id);
    }
    for (const marker of targetSeq.markers ?? []) used.add(marker.id);

    let nextIdx = (counters[prefix] ?? 0) + 1;
    while (true) {
      const candidate = `${prefix}_${String(nextIdx).padStart(2, "0")}`;
      if (!used.has(candidate)) {
        counters[prefix] = nextIdx;
        return candidate;
      }
      nextIdx++;
    }
  }

  const used = new Set(extraHandles);
  let idx = 1;
  while (true) {
    const candidate = `${prefix}_${String(idx).padStart(2, "0")}`;
    if (!used.has(candidate)) {
      return candidate;
    }
    idx++;
  }
}

export function assetPrefixForKind(kind: AssetKind): string {
  switch (kind) {
    case "footage":
      return "vid";
    case "audio":
      return "aud";
    case "graphic":
      return "img";
    case "voiceover":
      return "vo";
    case "composition":
      return "comp";
  }
}
