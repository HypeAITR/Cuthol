/**
 * Cuthol <-> HyperFrames Synchronous Bridge Runtime (`src/compositor/cuthol_runtime.ts`).
 *
 * Implements the 6 core deterministic functions of `window.__cuthol` (`C`):
 * 1. `C.word(query, opts?)`   — Plain Turkish character/diacritic folding word & phrase lookup
 * 2. `C.beats(opts?)`         — Beat, strong-beat/downbeat, and sub-beat onset times in seconds
 * 3. `C.audio(band, t, win?)` — 3-band (`low`/`mid`/`high`) normalized [0..1] envelope interpolation
 * 4. `C.cuts()`               — Spine/scene cut timestamps (`Sec[]`) and phase segments
 * 5. `C.drive(tl, fn, opts?)` — GSAP `seek()`-safe continuous driver via setter-proxy tween
 * 6. `C.value(tl, spec, fn)`  — GSAP `seek()`-safe numeric counter/interpolation driver via setter-proxy
 */

export const CUTHOL_RUNTIME_VERSION = "1.0.0";
export const CUTHOL_BRIDGE_SCHEMA = "cuthol.bridge/1";

export type Sec = number;

export interface CutholBridgeWord {
  t0: Sec;
  t1: Sec;
  text: string;
  conf?: number;
  clipped?: boolean;
}

export interface CutholBridgeSegment {
  t0: Sec;
  t1: Sec;
  index: number;
  duration: Sec;
  clipId?: string;
}

export interface CutholBridgeGlobalV1 {
  hash?: string;
  duration: Sec;
  words: CutholBridgeWord[];
  pauses?: Array<{ t0: Sec; t1: Sec }>;
  sentences?: Array<{ t0: Sec; t1: Sec; text: string }>;
  beats?: {
    bpm: number;
    offset?: Sec;
    phase?: Sec;
    grid?: Sec[];
    times: Sec[];
    strength?: number[];
    downbeats?: Sec[];
  };
  audio?: {
    fps: number;
    t0: Sec;
    bands: ["low", "mid", "high"];
    low: number[];
    mid: number[];
    high: number[];
  };
  cuts?: Array<{ t: Sec; clipId?: string; kind?: "spine_cut" | "scene_cut" }>;
  segments?: CutholBridgeSegment[];
}

export interface CutholBridgeV1 {
  schema: "cuthol.bridge/1";
  hash: string;
  composition: {
    id: string;
    cueId: string;
    duration: Sec;
    fps: number;
    width: number;
    height: number;
    sequenceStartSec: Sec;
  };
  props?: Record<string, unknown>;
  words: CutholBridgeWord[];
  sentences?: Array<{ t0: Sec; t1: Sec; text: string }>;
  pauses?: Array<{ t0: Sec; t1: Sec }>;
  beats?: {
    bpm: number;
    offset?: Sec;
    phase?: Sec;
    grid?: Sec[];
    times: Sec[];
    strength?: number[];
    downbeats?: Sec[];
  };
  audio?: {
    fps: number;
    t0: Sec;
    bands: ["low", "mid", "high"];
    low: number[];
    mid: number[];
    high: number[];
  };
  cuts?: Array<{ t: Sec; clipId?: string; kind?: "spine_cut" | "scene_cut" }>;
  segments?: CutholBridgeSegment[];
  safeZone?: {
    px: { x: number; y: number; w: number; h: number };
  };
  global?: CutholBridgeGlobalV1;
}

export interface CutholWordMatch {
  found: boolean;
  start: Sec;
  end: Sec;
  duration: Sec;
  text: string;
  clipped: boolean;
}

export interface CutholGlobalWordMatch extends CutholWordMatch {
  localStart: Sec;
  localEnd: Sec;
  inWindow: boolean;
}

export interface GsapLikeTimeline {
  fromTo(
    target: object,
    fromVars: Record<string, unknown>,
    toVars: Record<string, unknown>,
    position?: number | string
  ): GsapLikeTimeline;
}

export interface CutholGlobalRuntimeApi {
  duration: Sec;
  cueStart: Sec;
  cueEnd: Sec;
  bpm: number;
  words: CutholBridgeWord[];
  pauses: Array<{ t0: Sec; t1: Sec }>;
  sentences: Array<{ t0: Sec; t1: Sec; text: string }>;
  data: CutholBridgeGlobalV1;
  toLocal(globalSec: Sec): Sec;
  toGlobal(localSec: Sec): Sec;
  word(
    query: string,
    opts?: {
      nth?: number;
      after?: Sec;
      pre?: Sec;
      post?: Sec;
      minDur?: Sec;
      fallback?: Sec;
    }
  ): CutholGlobalWordMatch;
  beats(opts?: {
    from?: Sec;
    to?: Sec;
    strong?: boolean;
    threshold?: number;
    div?: number;
    grid?: boolean;
  }): Sec[];
  beatGrid(opts?: {
    from?: Sec;
    to?: Sec;
    strong?: boolean;
    div?: number;
  }): Sec[];
  audio(
    bandOrT: "low" | "mid" | "high" | Sec,
    tOrSmooth?: Sec,
    smoothSec?: Sec
  ): number;
  cuts(): {
    cuts: Sec[];
    segments: CutholBridgeSegment[];
  };
  drive<T extends GsapLikeTimeline>(
    tl: T,
    fn: (tSec: Sec) => void,
    opts?: { start?: Sec; end?: Sec }
  ): T;
  value<T extends GsapLikeTimeline>(
    tl: T,
    spec: { from?: number; to: number; at?: Sec; duration?: Sec; ease?: string },
    fn: (val: number) => void
  ): T;
}

export interface CutholRuntimeApi {
  ok: boolean;
  schema: string;
  runtimeVersion: string;
  hash: string | null;
  duration: Sec;
  cueStart: Sec;
  cueEnd: Sec;
  sequenceStartSec: Sec;
  sequenceDuration: Sec;
  fps: number;
  width: number;
  height: number;
  bpm: number;
  safe: {
    x: number;
    y: number;
    w: number;
    h: number;
    cx: number;
    cy: number;
    norm: { x: number; y: number; w: number; h: number };
  };
  props: Record<string, unknown>;
  ext: Record<string, unknown>;
  data: CutholBridgeV1;
  global: CutholGlobalRuntimeApi;
  warnings: string[];
  errors: string[];
  norm(text: string): string;
  frame(t: Sec): Sec;
  toGlobal(localSec: Sec): Sec;
  toLocal(globalSec: Sec): Sec;
  word(
    query: string,
    opts?: {
      nth?: number;
      after?: Sec;
      pre?: Sec;
      post?: Sec;
      minDur?: Sec;
      fallback?: Sec;
    }
  ): CutholWordMatch;
  beats(opts?: {
    from?: Sec;
    to?: Sec;
    strong?: boolean;
    threshold?: number;
    div?: number;
    grid?: boolean;
  }): Sec[];
  beatGrid(opts?: {
    from?: Sec;
    to?: Sec;
    strong?: boolean;
    div?: number;
  }): Sec[];
  audio(
    bandOrT: "low" | "mid" | "high" | Sec,
    tOrSmooth?: Sec,
    smoothSec?: Sec
  ): number;
  cuts(): {
    cuts: Sec[];
    segments: CutholBridgeSegment[];
  };
  drive<T extends GsapLikeTimeline>(
    tl: T,
    fn: (tSec: Sec) => void,
    opts?: { start?: Sec; end?: Sec }
  ): T;
  value<T extends GsapLikeTimeline>(
    tl: T,
    spec: { from?: number; to: number; at?: Sec; duration?: Sec; ease?: string },
    fn: (val: number) => void
  ): T;
}

const TURKISH_CHAR_FOLD: Record<string, string> = {
  İ: "i",
  I: "i",
  ı: "i",
  Ş: "s",
  ş: "s",
  Ğ: "g",
  ğ: "g",
  Ü: "u",
  ü: "u",
  Ö: "o",
  ö: "o",
  Ç: "c",
  ç: "c",
  Â: "a",
  â: "a",
  Î: "i",
  î: "i",
  Û: "u",
  û: "u",
};

/**
 * Deterministic plain Turkish lowercase & diacritic folding without fragile number-to-word expansion.
 */
export function normTurkish(text: string): string {
  let s = String(text ?? "").replace(/[İIışŞğĞüÜöÖçÇâÂîÎûÛ]/g, (c) => TURKISH_CHAR_FOLD[c] ?? c);
  s = s.toLowerCase();
  s = s.normalize("NFD").replace(/[\u0307]/g, "").normalize("NFC");
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return s
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9%.,]+/g, " ")
    .replace(/[.,]+/g, (m, offset, str) => {
      // Preserve decimal separator inside numbers (e.g. 99,4 -> 99.4), strip trailing punctuation
      const prev = str[offset - 1] ?? "";
      const next = str[offset + m.length] ?? "";
      return /\d/.test(prev) && /\d/.test(next) ? "." : " ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function compactNorm(text: string): string {
  return normTurkish(text).replace(/\s+/g, "");
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function createCutholRuntime(
  rawData: Partial<CutholBridgeV1> | null | undefined,
  externalVars?: Record<string, unknown>
): CutholRuntimeApi {
  const warnings: string[] = [];
  const errors: string[] = [];
  const d = (rawData ?? {}) as Partial<CutholBridgeV1>;

  if (!rawData) {
    errors.push("No data: window.__CUTHOL_DATA__ not found");
  }
  if (d.schema && d.schema !== CUTHOL_BRIDGE_SCHEMA) {
    errors.push(`Schema mismatch: ${d.schema} != ${CUTHOL_BRIDGE_SCHEMA}`);
  }

  const comp = d.composition ?? ({} as Partial<CutholBridgeV1["composition"]>);
  const D = isFiniteNum(comp.duration) && comp.duration > 0 ? comp.duration : 0;
  if (!D) {
    errors.push("composition.duration missing or 0");
  }
  const FPS = isFiniteNum(comp.fps) && comp.fps > 0 ? comp.fps : 30;
  const W = isFiniteNum(comp.width) && comp.width > 0 ? comp.width : 1920;
  const H = isFiniteNum(comp.height) && comp.height > 0 ? comp.height : 1080;

  const rawWordsExpanded: Array<{
    t0: number;
    t1: number;
    text: string;
    n: string;
    clipped: boolean;
  }> = [];

  for (const w of d.words ?? []) {
    if (!isFiniteNum(w.t0) || !isFiniteNum(w.t1) || w.t1 <= 0 || w.t0 >= (D || Infinity)) {
      continue;
    }
    const clampedT0 = Math.max(0, w.t0);
    const clampedT1 = D > 0 ? Math.min(D, w.t1) : w.t1;
    if (clampedT1 <= clampedT0) continue;
    const isClipped = Boolean(w.clipped || w.t0 < 0 || (D > 0 && w.t1 > D));
    const rawText = String(w.text ?? "").trim();
    const parts = rawText.split(/\s+/).filter(Boolean);
    if (parts.length <= 1) {
      const n = compactNorm(rawText);
      if (!n) continue;
      rawWordsExpanded.push({
        t0: clampedT0,
        t1: clampedT1,
        text: rawText,
        n,
        clipped: isClipped,
      });
    } else {
      const totalChars = Math.max(1, parts.reduce((acc, p) => acc + p.length, 0));
      const span = clampedT1 - clampedT0;
      let cursorChars = 0;
      for (const part of parts) {
        const nextChars = cursorChars + part.length;
        const subT0 = Number((clampedT0 + (span * cursorChars) / totalChars).toFixed(4));
        const subT1 = Number((clampedT0 + (span * nextChars) / totalChars).toFixed(4));
        cursorChars = nextChars;
        const n = compactNorm(part);
        if (!n || subT1 <= subT0) continue;
        rawWordsExpanded.push({
          t0: subT0,
          t1: subT1,
          text: part,
          n,
          clipped: isClipped,
        });
      }
    }
  }

  const words = rawWordsExpanded.sort((a, b) => a.t0 - b.t0);

  if (words.length === 0) {
    warnings.push("words empty — C.word uses fallback");
  }

  const rawBeatTimes = d.beats?.times ?? [];
  const rawStrengths = d.beats?.strength ?? [];
  const strengthMap = new Map<number, number>();
  rawBeatTimes.forEach((t, idx) => {
    if (isFiniteNum(t) && isFiniteNum(rawStrengths[idx])) {
      const prev = strengthMap.get(t);
      strengthMap.set(t, prev !== undefined ? Math.max(prev, rawStrengths[idx]) : rawStrengths[idx]);
    }
  });

  const beatT = rawBeatTimes
    .filter((t) => isFiniteNum(t) && t >= 0 && (D === 0 || t < D))
    .sort((a, b) => a - b)
    .filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-4);

  const bpm = isFiniteNum(d.beats?.bpm) && d.beats!.bpm > 0 ? d.beats!.bpm : 0;
  const gridT = (d.beats?.grid ?? [])
    .filter((t) => isFiniteNum(t) && t >= 0 && (D === 0 || t < D))
    .sort((a, b) => a - b)
    .filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-4);

  if (gridT.length === 0 && bpm > 0 && D > 0) {
    const period = 60 / bpm;
    const rawOff = isFiniteNum(d.beats?.offset)
      ? d.beats!.offset!
      : isFiniteNum(d.beats?.phase)
        ? d.beats!.phase!
        : beatT.length > 0
          ? beatT[0] % period
          : 0;
    const off = Math.max(0, rawOff % period);
    for (let t = off; t < D; t += period) {
      gridT.push(Number(t.toFixed(4)));
    }
  }

  if (beatT.length === 0 && gridT.length > 0) {
    for (const gt of gridT) {
      beatT.push(gt);
    }
    warnings.push("beats.times empty — BPM grid generated");
  }

  let downT = (d.beats?.downbeats ?? [])
    .filter((t) => isFiniteNum(t) && t >= 0 && (D === 0 || t < D))
    .sort((a, b) => a - b)
    .filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-4);
  if (downT.length === 0) {
    const srcForDown = gridT.length > 0 ? gridT : beatT;
    if (srcForDown.length > 0) {
      downT = srcForDown.filter((_, i) => i % 4 === 0);
    }
  }

  const A = d.audio;
  const audioFps = isFiniteNum(A?.fps) && A!.fps > 0 ? A!.fps : 0;
  const audioT0 = isFiniteNum(A?.t0) ? A!.t0 : 0;

  const cutTimes = (d.cuts ?? [])
    .map((c) => (typeof c === "number" ? c : c.t))
    .filter((t) => isFiniteNum(t) && t > 0 && (D === 0 || t < D))
    .sort((a, b) => a - b)
    .filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-4);

  const rawSegments =
    d.segments && d.segments.length > 0
      ? d.segments.map((s, idx) => ({
          t0: s.t0,
          t1: s.t1,
          index: idx,
          duration: Math.max(0, Number((s.t1 - s.t0).toFixed(4))),
          clipId: s.clipId,
        }))
      : (() => {
          const bounds = [0, ...cutTimes, D];
          const segs: CutholBridgeSegment[] = [];
          for (let i = 0; i < bounds.length - 1; i++) {
            const t0 = bounds[i];
            const t1 = bounds[i + 1];
            if (t1 > t0) {
              segs.push({
                t0,
                t1,
                index: segs.length,
                duration: Number((t1 - t0).toFixed(4)),
              });
            }
          }
          return segs;
        })();

  const safePx = d.safeZone?.px ?? {
    x: Math.round(W * 0.05),
    y: Math.round(H * 0.05),
    w: Math.round(W * 0.9),
    h: Math.round(H * 0.9),
  };
  const safe = {
    x: safePx.x,
    y: safePx.y,
    w: safePx.w,
    h: safePx.h,
    cx: Math.round(safePx.x + safePx.w / 2),
    cy: Math.round(safePx.y + safePx.h / 2),
    norm: {
      x: Number((safePx.x / W).toFixed(4)),
      y: Number((safePx.y / H).toFixed(4)),
      w: Number((safePx.w / W).toFixed(4)),
      h: Number((safePx.h / H).toFixed(4)),
    },
  };

  const hfVars =
    typeof (globalThis as { window?: { __hyperframes?: { getVariables?: () => Record<string, unknown> } } })
      .window?.__hyperframes?.getVariables === "function"
      ? (globalThis as { window?: { __hyperframes?: { getVariables?: () => Record<string, unknown> } } })
          .window!.__hyperframes!.getVariables!() ?? {}
      : {};

  const mergedProps: Record<string, unknown> = {
    ...(d.props ?? {}),
    ...hfVars,
    ...(externalVars ?? {}),
  };

  const sampleAudioRaw = (band: "low" | "mid" | "high", t: Sec): number => {
    const arr = A?.[band];
    if (!audioFps || !arr || arr.length === 0) return 0;
    const x = (t - audioT0) * audioFps;
    if (x <= 0) return clamp(arr[0] ?? 0, 0, 1);
    if (x >= arr.length - 1) return clamp(arr[arr.length - 1] ?? 0, 0, 1);
    const i = Math.floor(x);
    const f = x - i;
    const v = (arr[i] ?? 0) + ((arr[i + 1] ?? 0) - (arr[i] ?? 0)) * f;
    return clamp(v, 0, 1);
  };

  const cueStart = isFiniteNum(comp.sequenceStartSec) ? comp.sequenceStartSec : 0;
  const cueEnd = Number((cueStart + D).toFixed(4));
  const toGlobal = (localSec: Sec): Sec => Number((localSec + cueStart).toFixed(4));
  const toLocal = (globalSec: Sec): Sec => Number((globalSec - cueStart).toFixed(4));

  // Build global (full-sequence) scope
  const gRaw = d.global;
  const globalD =
    isFiniteNum(gRaw?.duration) && gRaw!.duration > 0
      ? gRaw!.duration
      : Math.max(cueEnd, D);

  const globalSourceWords: CutholBridgeWord[] = Array.isArray(gRaw?.words)
    ? gRaw!.words
    : (d.words ?? []).map((w) => ({
        ...w,
        t0: Number((w.t0 + cueStart).toFixed(4)),
        t1: Number((w.t1 + cueStart).toFixed(4)),
      }));

  const globalWordsExpanded: Array<{
    t0: number;
    t1: number;
    text: string;
    n: string;
    clipped: boolean;
  }> = [];

  for (const w of globalSourceWords) {
    if (!isFiniteNum(w.t0) || !isFiniteNum(w.t1) || w.t1 <= 0 || w.t0 >= (globalD || Infinity)) {
      continue;
    }
    const clampedT0 = Math.max(0, w.t0);
    const clampedT1 = globalD > 0 ? Math.min(globalD, w.t1) : w.t1;
    if (clampedT1 <= clampedT0) continue;
    const isClipped = Boolean(w.clipped || w.t0 < 0 || (globalD > 0 && w.t1 > globalD));
    const rawText = String(w.text ?? "").trim();
    const parts = rawText.split(/\s+/).filter(Boolean);
    if (parts.length <= 1) {
      const n = compactNorm(rawText);
      if (!n) continue;
      globalWordsExpanded.push({
        t0: clampedT0,
        t1: clampedT1,
        text: rawText,
        n,
        clipped: isClipped,
      });
    } else {
      const totalChars = Math.max(1, parts.reduce((acc, p) => acc + p.length, 0));
      const span = clampedT1 - clampedT0;
      let cursorChars = 0;
      for (const part of parts) {
        const nextChars = cursorChars + part.length;
        const subT0 = Number((clampedT0 + (span * cursorChars) / totalChars).toFixed(4));
        const subT1 = Number((clampedT0 + (span * nextChars) / totalChars).toFixed(4));
        cursorChars = nextChars;
        const n = compactNorm(part);
        if (!n || subT1 <= subT0) continue;
        globalWordsExpanded.push({
          t0: subT0,
          t1: subT1,
          text: part,
          n,
          clipped: isClipped,
        });
      }
    }
  }
  const globalWords = globalWordsExpanded.sort((a, b) => a.t0 - b.t0);

  const globalPauses: Array<{ t0: Sec; t1: Sec }> = Array.isArray(gRaw?.pauses)
    ? gRaw!.pauses!
    : (() => {
        const out: Array<{ t0: Sec; t1: Sec }> = [];
        for (let i = 0; i < globalWords.length - 1; i++) {
          const gap = globalWords[i + 1].t0 - globalWords[i].t1;
          if (gap >= 0.2) {
            out.push({
              t0: Number(Math.max(0, globalWords[i].t1).toFixed(4)),
              t1: Number(Math.min(globalD || Infinity, globalWords[i + 1].t0).toFixed(4)),
            });
          }
        }
        return out;
      })();

  const globalSentences: Array<{ t0: Sec; t1: Sec; text: string }> = Array.isArray(gRaw?.sentences)
    ? gRaw!.sentences!
    : (() => {
        const out: Array<{ t0: Sec; t1: Sec; text: string }> = [];
        if (globalWords.length === 0) return out;
        let sentStart = Math.max(0, globalWords[0].t0);
        let sentTokens: string[] = [];
        for (let i = 0; i < globalWords.length; i++) {
          const curr = globalWords[i];
          const next = globalWords[i + 1];
          sentTokens.push(curr.text);
          const gapSec = next ? next.t0 - curr.t1 : 0;
          if (!next || /[.!?…]$/.test(curr.text) || gapSec >= 0.4) {
            out.push({
              t0: Number(sentStart.toFixed(4)),
              t1: Number(Math.min(globalD || Infinity, curr.t1).toFixed(4)),
              text: sentTokens.join(" "),
            });
            if (next) {
              sentStart = Math.max(0, next.t0);
              sentTokens = [];
            }
          }
        }
        return out;
      })();

  const gBeatsSrc = gRaw?.beats ?? d.beats;
  const gRawBeatTimes = gRaw?.beats?.times
    ? gRaw.beats.times
    : (d.beats?.times ?? []).map((t) => Number((t + cueStart).toFixed(4)));
  const gRawStrengths = gBeatsSrc?.strength ?? [];
  const gStrengthMap = new Map<number, number>();
  gRawBeatTimes.forEach((t, idx) => {
    if (isFiniteNum(t) && isFiniteNum(gRawStrengths[idx])) {
      const prev = gStrengthMap.get(t);
      gStrengthMap.set(t, prev !== undefined ? Math.max(prev, gRawStrengths[idx]) : gRawStrengths[idx]);
    }
  });
  const gBeatT = gRawBeatTimes
    .filter((t) => isFiniteNum(t) && t >= 0 && (globalD === 0 || t < globalD))
    .sort((a, b) => a - b)
    .filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-4);
  const gBpm = isFiniteNum(gBeatsSrc?.bpm) && gBeatsSrc!.bpm > 0 ? gBeatsSrc!.bpm : bpm;
  const gGridT = (
    gRaw?.beats?.grid
      ? gRaw.beats.grid
      : (d.beats?.grid ?? []).map((t) => Number((t + cueStart).toFixed(4)))
  )
    .filter((t) => isFiniteNum(t) && t >= 0 && (globalD === 0 || t < globalD))
    .sort((a, b) => a - b)
    .filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-4);
  if (gGridT.length === 0 && gBpm > 0 && globalD > 0) {
    const period = 60 / gBpm;
    const rawOff = isFiniteNum(gBeatsSrc?.offset)
      ? gBeatsSrc!.offset!
      : isFiniteNum(gBeatsSrc?.phase)
        ? gBeatsSrc!.phase!
        : gBeatT.length > 0
          ? gBeatT[0] % period
          : 0;
    const off = Math.max(0, rawOff % period);
    for (let t = off; t < globalD; t += period) {
      gGridT.push(Number(t.toFixed(4)));
    }
  }
  if (gBeatT.length === 0 && gGridT.length > 0) {
    for (const gt of gGridT) gBeatT.push(gt);
  }
  let gDownT = (
    gRaw?.beats?.downbeats
      ? gRaw.beats.downbeats
      : (d.beats?.downbeats ?? []).map((t) => Number((t + cueStart).toFixed(4)))
  )
    .filter((t) => isFiniteNum(t) && t >= 0 && (globalD === 0 || t < globalD))
    .sort((a, b) => a - b)
    .filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-4);
  if (gDownT.length === 0) {
    const srcForDown = gGridT.length > 0 ? gGridT : gBeatT;
    if (srcForDown.length > 0) {
      gDownT = srcForDown.filter((_, i) => i % 4 === 0);
    }
  }

  const gA = gRaw?.audio ?? A;
  const gAudioFps = isFiniteNum(gA?.fps) && gA!.fps > 0 ? gA!.fps : 0;
  const gAudioT0 = gRaw?.audio
    ? isFiniteNum(gRaw.audio.t0)
      ? gRaw.audio.t0
      : 0
    : audioT0 + cueStart;

  const sampleGlobalAudioRaw = (band: "low" | "mid" | "high", t: Sec): number => {
    const arr = gA?.[band];
    if (!gAudioFps || !arr || arr.length === 0) return 0;
    const x = (t - gAudioT0) * gAudioFps;
    if (x <= 0) return clamp(arr[0] ?? 0, 0, 1);
    if (x >= arr.length - 1) return clamp(arr[arr.length - 1] ?? 0, 0, 1);
    const i = Math.floor(x);
    const f = x - i;
    const v = (arr[i] ?? 0) + ((arr[i + 1] ?? 0) - (arr[i] ?? 0)) * f;
    return clamp(v, 0, 1);
  };

  const gCutTimes = (
    gRaw?.cuts
      ? gRaw.cuts.map((c) => (typeof c === "number" ? c : c.t))
      : (d.cuts ?? []).map((c) => Number(((typeof c === "number" ? c : c.t) + cueStart).toFixed(4)))
  )
    .filter((t) => isFiniteNum(t) && t > 0 && (globalD === 0 || t < globalD))
    .sort((a, b) => a - b)
    .filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-4);

  const gSegments: CutholBridgeSegment[] =
    gRaw?.segments && gRaw.segments.length > 0
      ? gRaw.segments.map((s, idx) => ({
          t0: s.t0,
          t1: s.t1,
          index: idx,
          duration: Math.max(0, Number((s.t1 - s.t0).toFixed(4))),
          clipId: s.clipId,
        }))
      : (() => {
          const bounds = [0, ...gCutTimes, globalD];
          const segs: CutholBridgeSegment[] = [];
          for (let i = 0; i < bounds.length - 1; i++) {
            const t0 = bounds[i];
            const t1 = bounds[i + 1];
            if (t1 > t0) {
              segs.push({
                t0,
                t1,
                index: segs.length,
                duration: Number((t1 - t0).toFixed(4)),
              });
            }
          }
          return segs;
        })();

  const globalData: CutholBridgeGlobalV1 = {
    hash: gRaw?.hash,
    duration: globalD,
    words: globalSourceWords,
    pauses: globalPauses,
    sentences: globalSentences,
    beats: gRaw?.beats ?? d.beats,
    audio: gRaw?.audio ?? d.audio,
    cuts: gRaw?.cuts ?? d.cuts ?? [],
    segments: gSegments,
  };

  const globalApi: CutholGlobalRuntimeApi = {
    duration: globalD,
    cueStart,
    cueEnd,
    bpm: gBpm,
    words: globalSourceWords,
    pauses: globalPauses,
    sentences: globalSentences,
    data: globalData,
    toLocal,
    toGlobal,
    word(query, opts) {
      const o = opts ?? {};
      const targetTokens = normTurkish(query)
        .split(" ")
        .map((tok) => tok.trim())
        .filter(Boolean);
      const afterSec = o.after ?? 0;
      const nth = o.nth ?? 0;
      const matches: Array<{ t0: Sec; t1: Sec; text: string; clipped: boolean }> = [];

      if (targetTokens.length > 0) {
        const kLen = targetTokens.length;
        for (let i = 0; i <= globalWords.length - kLen; i++) {
          if (globalWords[i].t0 < afterSec) continue;
          let matched = true;
          for (let k = 0; k < kLen; k++) {
            if (globalWords[i + k].n !== targetTokens[k]) {
              matched = false;
              break;
            }
          }
          if (matched) {
            const slice = globalWords.slice(i, i + kLen);
            matches.push({
              t0: slice[0].t0,
              t1: slice[slice.length - 1].t1,
              text: slice.map((w) => w.text).join(" "),
              clipped: slice.some((w) => w.clipped),
            });
          }
        }
      }

      const chosen = matches[nth];
      if (!chosen) {
        warnings.push(`Word/phrase not found (global): '${query}'`);
        const fbStart = clamp(o.fallback ?? 0, 0, globalD || 1);
        const fbEnd = clamp(
          fbStart + Math.max(o.minDur ?? 0.5, 1 / FPS),
          fbStart,
          globalD || fbStart + 0.5
        );
        const s = Number(fbStart.toFixed(4));
        const e = Number(fbEnd.toFixed(4));
        return {
          found: false,
          start: s,
          end: e,
          duration: Number(Math.max(1 / FPS, e - s).toFixed(4)),
          text: "",
          clipped: false,
          localStart: toLocal(s),
          localEnd: toLocal(e),
          inWindow: e > cueStart && s < cueEnd,
        };
      }

      const start = clamp(chosen.t0 - (o.pre ?? 0), 0, globalD || Infinity);
      let end = clamp(
        Math.max(start + 1 / FPS, chosen.t1 + (o.post ?? 0)),
        start,
        globalD || Infinity
      );
      if (o.minDur !== undefined && o.minDur > 0 && end - start < o.minDur) {
        end = clamp(start + o.minDur, start, globalD || Infinity);
      }
      const s = Number(start.toFixed(4));
      const e = Number(end.toFixed(4));
      return {
        found: true,
        start: s,
        end: e,
        duration: Number(Math.max(1 / FPS, e - s).toFixed(4)),
        text: chosen.text,
        clipped: chosen.clipped,
        localStart: toLocal(s),
        localEnd: toLocal(e),
        inWindow: e > cueStart && s < cueEnd,
      };
    },
    beats(opts) {
      const o = opts ?? {};
      const from = o.from ?? 0;
      const to = o.to ?? globalD;
      const thresh = o.threshold ?? 0.7;
      const sourceBeats = o.grid ? (gGridT.length > 0 ? gGridT : gBeatT) : gBeatT;
      const baseBeats = o.strong
        ? o.grid
          ? gDownT.length > 0
            ? gDownT
            : sourceBeats.filter((_, i) => i % 4 === 0)
          : sourceBeats.filter((t) => {
              const s = gStrengthMap.get(t);
              return s !== undefined ? s >= thresh : gDownT.includes(t);
            })
        : sourceBeats;
      const div = o.div && o.div > 1 ? Math.floor(o.div) : 1;
      if (div <= 1) {
        return baseBeats.filter((t) => t >= from && t < to);
      }
      const subdivided: Sec[] = [];
      for (let i = 0; i < baseBeats.length; i++) {
        const curr = baseBeats[i];
        const next =
          i + 1 < baseBeats.length
            ? baseBeats[i + 1]
            : gBpm > 0
              ? curr + 60 / gBpm
              : null;
        if (next === null) {
          if (curr >= from && curr < to) subdivided.push(curr);
          continue;
        }
        for (let k = 0; k < div; k++) {
          const subT = Number((curr + ((next - curr) * k) / div).toFixed(4));
          if (subT >= from && subT < to) subdivided.push(subT);
        }
      }
      return subdivided;
    },
    beatGrid(opts) {
      return globalApi.beats({ ...(opts ?? {}), grid: true });
    },
    audio(bandOrT, tOrSmooth, smoothSec) {
      const band: "low" | "mid" | "high" =
        typeof bandOrT === "string" ? bandOrT : "mid";
      const t: Sec =
        typeof bandOrT === "number" ? bandOrT : typeof tOrSmooth === "number" ? tOrSmooth : 0;
      const smooth: Sec | undefined =
        typeof bandOrT === "number" ? tOrSmooth : smoothSec;
      if (!smooth || smooth <= 0) {
        return Number(sampleGlobalAudioRaw(band, t).toFixed(4));
      }
      const samples = Math.max(5, Math.min(65, Math.ceil(2 * smooth * (gAudioFps || 30)) | 1));
      let sum = 0;
      for (let k = 0; k < samples; k++) {
        const sampleT = t - smooth + (2 * smooth * k) / (samples - 1);
        sum += sampleGlobalAudioRaw(band, sampleT);
      }
      return Number((sum / samples).toFixed(4));
    },
    cuts() {
      return {
        cuts: gCutTimes.slice(),
        segments: gSegments.map((s) => ({ ...s })),
      };
    },
    drive(tl, fn, opts) {
      const o = opts ?? {};
      const s = clamp(o.start ?? 0, 0, globalD);
      const e = clamp(o.end ?? globalD, s, globalD);
      let cur = s;
      const proxy: Record<string, unknown> = {
        t(v?: number) {
          if (v !== undefined) {
            cur = v;
            fn(v);
          }
          return cur;
        },
      };
      tl.fromTo(
        proxy,
        { t: s },
        {
          t: e,
          duration: Math.max(e - s, 1 / FPS),
          ease: "none",
          immediateRender: true,
        },
        s
      );
      return tl;
    },
    value(tl, spec, fn) {
      const fromVal = spec.from ?? 0;
      const toVal = spec.to;
      const atSec = clamp(spec.at ?? 0, 0, globalD);
      const durSec = Math.max(spec.duration ?? 0.6, 1 / FPS);
      let cur = fromVal;
      const proxy: Record<string, unknown> = {
        v(x?: number) {
          if (x !== undefined) {
            cur = x;
            fn(x);
          }
          return cur;
        },
      };
      tl.fromTo(
        proxy,
        { v: fromVal },
        {
          v: toVal,
          duration: durSec,
          ease: spec.ease ?? "power2.out",
          immediateRender: true,
        },
        atSec
      );
      return tl;
    },
  };

  const api: CutholRuntimeApi = {
    ok: errors.length === 0,
    schema: d.schema ?? CUTHOL_BRIDGE_SCHEMA,
    runtimeVersion: CUTHOL_RUNTIME_VERSION,
    hash: d.hash ?? null,
    duration: D,
    cueStart,
    cueEnd,
    sequenceStartSec: cueStart,
    sequenceDuration: globalD,
    fps: FPS,
    width: W,
    height: H,
    bpm,
    safe,
    props: mergedProps,
    ext: {},
    data: {
      schema: CUTHOL_BRIDGE_SCHEMA,
      hash: d.hash ?? "",
      composition: {
        id: comp.id ?? "main",
        cueId: comp.cueId ?? "cue_01",
        duration: D,
        fps: FPS,
        width: W,
        height: H,
        sequenceStartSec: cueStart,
      },
      props: mergedProps,
      words: d.words ?? [],
      sentences: d.sentences ?? [],
      pauses: d.pauses ?? [],
      beats: d.beats,
      audio: d.audio,
      cuts: d.cuts ?? [],
      segments: rawSegments,
      safeZone: { px: safePx },
      global: globalData,
    },
    global: globalApi,
    warnings,
    errors,
    norm: normTurkish,
    frame(t: Sec): Sec {
      return Math.round(t * FPS) / FPS;
    },
    toGlobal,
    toLocal,

    // 1. Word / Phrase Lookup
    word(query, opts) {
      const o = opts ?? {};
      const targetTokens = normTurkish(query)
        .split(" ")
        .map((tok) => tok.trim())
        .filter(Boolean);
      const afterSec = o.after ?? 0;
      const nth = o.nth ?? 0;
      const matches: Array<{ t0: Sec; t1: Sec; text: string; clipped: boolean }> = [];

      if (targetTokens.length > 0) {
        const kLen = targetTokens.length;
        for (let i = 0; i <= words.length - kLen; i++) {
          if (words[i].t0 < afterSec) continue;
          let matched = true;
          for (let k = 0; k < kLen; k++) {
            if (words[i + k].n !== targetTokens[k]) {
              matched = false;
              break;
            }
          }
          if (matched) {
            const slice = words.slice(i, i + kLen);
            matches.push({
              t0: slice[0].t0,
              t1: slice[slice.length - 1].t1,
              text: slice.map((w) => w.text).join(" "),
              clipped: slice.some((w) => w.clipped),
            });
          }
        }
      }

      const chosen = matches[nth];
      if (!chosen) {
        warnings.push(`Word/phrase not found: '${query}'`);
        const fbStart = clamp(o.fallback ?? 0, 0, D || 1);
        const fbEnd = clamp(fbStart + Math.max(o.minDur ?? 0.5, 1 / FPS), fbStart, D || fbStart + 0.5);
        return {
          found: false,
          start: Number(fbStart.toFixed(4)),
          end: Number(fbEnd.toFixed(4)),
          duration: Number(Math.max(1 / FPS, fbEnd - fbStart).toFixed(4)),
          text: "",
          clipped: false,
        };
      }

      const start = clamp(chosen.t0 - (o.pre ?? 0), 0, D || Infinity);
      let end = clamp(Math.max(start + 1 / FPS, chosen.t1 + (o.post ?? 0)), start, D || Infinity);
      if (o.minDur !== undefined && o.minDur > 0 && end - start < o.minDur) {
        end = clamp(start + o.minDur, start, D || Infinity);
      }
      return {
        found: true,
        start: Number(start.toFixed(4)),
        end: Number(end.toFixed(4)),
        duration: Number(Math.max(1 / FPS, end - start).toFixed(4)),
        text: chosen.text,
        clipped: chosen.clipped,
      };
    },

    // 2. Beats & Sub-beats
    beats(opts) {
      const o = opts ?? {};
      const from = o.from ?? 0;
      const to = o.to ?? D;
      const thresh = o.threshold ?? 0.7;

      const sourceBeats = o.grid ? (gridT.length > 0 ? gridT : beatT) : beatT;
      const baseBeats = o.strong
        ? o.grid
          ? downT.length > 0
            ? downT
            : sourceBeats.filter((_, i) => i % 4 === 0)
          : sourceBeats.filter((t) => {
              const s = strengthMap.get(t);
              return s !== undefined ? s >= thresh : downT.includes(t);
            })
        : sourceBeats;

      const div = o.div && o.div > 1 ? Math.floor(o.div) : 1;
      if (div <= 1) {
        return baseBeats.filter((t) => t >= from && t < to);
      }

      const subdivided: Sec[] = [];
      for (let i = 0; i < baseBeats.length; i++) {
        const curr = baseBeats[i];
        const next =
          i + 1 < baseBeats.length
            ? baseBeats[i + 1]
            : bpm > 0
              ? curr + 60 / bpm
              : null;
        if (next === null) {
          if (curr >= from && curr < to) subdivided.push(curr);
          continue;
        }
        for (let k = 0; k < div; k++) {
          const subT = Number((curr + ((next - curr) * k) / div).toFixed(4));
          if (subT >= from && subT < to) subdivided.push(subT);
        }
      }
      return subdivided;
    },

    beatGrid(opts) {
      return api.beats({ ...(opts ?? {}), grid: true });
    },

    // 3. 3-Band Audio Envelope
    audio(bandOrT, tOrSmooth, smoothSec) {
      const band: "low" | "mid" | "high" =
        typeof bandOrT === "string" ? bandOrT : "mid";
      const t: Sec =
        typeof bandOrT === "number" ? bandOrT : typeof tOrSmooth === "number" ? tOrSmooth : 0;
      const smooth: Sec | undefined =
        typeof bandOrT === "number" ? tOrSmooth : smoothSec;
      if (!smooth || smooth <= 0) {
        return Number(sampleAudioRaw(band, t).toFixed(4));
      }
      const samples = Math.max(5, Math.min(65, Math.ceil(2 * smooth * (audioFps || 30)) | 1));
      let sum = 0;
      for (let k = 0; k < samples; k++) {
        const sampleT = t - smooth + (2 * smooth * k) / (samples - 1);
        sum += sampleAudioRaw(band, sampleT);
      }
      return Number((sum / samples).toFixed(4));
    },

    // 4. Cuts & Segments
    cuts() {
      return {
        cuts: cutTimes.slice(),
        segments: rawSegments.map((s) => ({ ...s })),
      };
    },

    // 5. GSAP seek()-safe Continuous Driver
    drive(tl, fn, opts) {
      const o = opts ?? {};
      const s = clamp(o.start ?? 0, 0, D);
      const e = clamp(o.end ?? D, s, D);
      let cur = s;
      const proxy: Record<string, unknown> = {
        t(v?: number) {
          if (v !== undefined) {
            cur = v;
            fn(v);
          }
          return cur;
        },
      };
      tl.fromTo(
        proxy,
        { t: s },
        {
          t: e,
          duration: Math.max(e - s, 1 / FPS),
          ease: "none",
          immediateRender: true,
        },
        s
      );
      return tl;
    },

    // 6. GSAP seek()-safe Numeric Value / Counter Driver
    value(tl, spec, fn) {
      const fromVal = spec.from ?? 0;
      const toVal = spec.to;
      const atSec = clamp(spec.at ?? 0, 0, D);
      const durSec = Math.max(spec.duration ?? 0.6, 1 / FPS);
      let cur = fromVal;
      const proxy: Record<string, unknown> = {
        v(x?: number) {
          if (x !== undefined) {
            cur = x;
            fn(x);
          }
          return cur;
        },
      };
      tl.fromTo(
        proxy,
        { v: fromVal },
        {
          v: toVal,
          duration: durSec,
          ease: spec.ease ?? "power2.out",
          immediateRender: true,
        },
        atSec
      );
      return tl;
    },
  };

  return api;
}

/**
 * Generates the self-contained UMD JavaScript file (`assets/cuthol-runtime.js`)
 * injected into HyperFrames compositions.
 */
export function getCutholRuntimeJsSource(): string {
  return `/* cuthol-runtime.js v${CUTHOL_RUNTIME_VERSION} — Cuthol <-> HyperFrames Synchronous Runtime (${CUTHOL_BRIDGE_SCHEMA})
 * Deterministic 6-method API: C.word, C.beats, C.audio, C.cuts, C.drive, C.value
 */
(function (root) {
  "use strict";
  var SCHEMA = ${JSON.stringify(CUTHOL_BRIDGE_SCHEMA)};
  var RUNTIME_VERSION = ${JSON.stringify(CUTHOL_RUNTIME_VERSION)};
  var FOLD = { "İ": "i", "I": "i", "ı": "i", "Ş": "s", "ş": "s", "Ğ": "g", "ğ": "g", "Ü": "u", "ü": "u", "Ö": "o", "ö": "o", "Ç": "c", "ç": "c", "Â": "a", "â": "a", "Î": "i", "î": "i", "Û": "u", "û": "u" };

  function normTurkish(text) {
    var s = String(text == null ? "" : text).replace(/[İIışŞğĞüÜöÖçÇâÂîÎûÛ]/g, function (c) { return FOLD[c] || c; });
    s = s.toLowerCase();
    s = s.normalize("NFD").replace(/[\\u0307]/g, "").normalize("NFC");
    s = s.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
    return s
      .replace(/['’\`]/g, "")
      .replace(/[^a-z0-9%.,]+/g, " ")
      .replace(/[.,]+/g, function (m, offset, str) {
        var prev = str[offset - 1] || "";
        var next = str[offset + m.length] || "";
        return /\\d/.test(prev) && /\\d/.test(next) ? "." : " ";
      })
      .replace(/\\s+/g, " ")
      .trim();
  }

  function compactNorm(text) {
    return normTurkish(text).replace(/\\s+/g, "");
  }

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function isFiniteNum(x) {
    return typeof x === "number" && isFinite(x);
  }

  function create(rawData, externalVars) {
    var warnings = [], errors = [];
    var d = rawData || {};
    if (!rawData) errors.push("No data: window.__CUTHOL_DATA__ not found");
    if (d.schema && d.schema !== SCHEMA) errors.push("Schema mismatch: " + d.schema + " != " + SCHEMA);

    var comp = d.composition || {};
    var D = isFiniteNum(comp.duration) && comp.duration > 0 ? comp.duration : 0;
    if (!D) errors.push("composition.duration missing or 0");
    var FPS = isFiniteNum(comp.fps) && comp.fps > 0 ? comp.fps : 30;
    var W = isFiniteNum(comp.width) && comp.width > 0 ? comp.width : 1920;
    var H = isFiniteNum(comp.height) && comp.height > 0 ? comp.height : 1080;

    var rawWordsExpanded = [];
    (d.words || []).forEach(function (w) {
      if (!isFiniteNum(w.t0) || !isFiniteNum(w.t1) || w.t1 <= 0 || w.t0 >= (D || Infinity)) return;
      var clampedT0 = Math.max(0, w.t0);
      var clampedT1 = D > 0 ? Math.min(D, w.t1) : w.t1;
      if (clampedT1 <= clampedT0) return;
      var isClipped = Boolean(w.clipped || w.t0 < 0 || (D > 0 && w.t1 > D));
      var rawText = String(w.text == null ? "" : w.text).trim();
      var parts = rawText.split(/\\s+/).filter(Boolean);
      if (parts.length <= 1) {
        var n = compactNorm(rawText);
        if (!n) return;
        rawWordsExpanded.push({ t0: clampedT0, t1: clampedT1, text: rawText, n: n, clipped: isClipped });
      } else {
        var totalChars = Math.max(1, parts.reduce(function (acc, p) { return acc + p.length; }, 0));
        var span = clampedT1 - clampedT0;
        var cursorChars = 0;
        for (var pIdx = 0; pIdx < parts.length; pIdx++) {
          var part = parts[pIdx];
          var nextChars = cursorChars + part.length;
          var subT0 = +(clampedT0 + (span * cursorChars) / totalChars).toFixed(4);
          var subT1 = +(clampedT0 + (span * nextChars) / totalChars).toFixed(4);
          cursorChars = nextChars;
          var pn = compactNorm(part);
          if (!pn || subT1 <= subT0) continue;
          rawWordsExpanded.push({ t0: subT0, t1: subT1, text: part, n: pn, clipped: isClipped });
        }
      }
    });
    var words = rawWordsExpanded.sort(function (a, b) { return a.t0 - b.t0; });

    if (!words.length) warnings.push("words empty — C.word uses fallback");

    var rawBeatTimes = (d.beats && d.beats.times) || [];
    var rawStrengths = (d.beats && d.beats.strength) || [];
    var strengthMap = {};
    rawBeatTimes.forEach(function (t, idx) {
      if (isFiniteNum(t) && isFiniteNum(rawStrengths[idx])) {
        strengthMap[t] = strengthMap[t] !== undefined ? Math.max(strengthMap[t], rawStrengths[idx]) : rawStrengths[idx];
      }
    });

    var beatT = rawBeatTimes
      .filter(function (t) { return isFiniteNum(t) && t >= 0 && (!D || t < D); })
      .sort(function (a, b) { return a - b; })
      .filter(function (t, i, a) { return i === 0 || t - a[i - 1] > 1e-4; });

    var bpm = d.beats && isFiniteNum(d.beats.bpm) && d.beats.bpm > 0 ? d.beats.bpm : 0;
    var gridT = ((d.beats && d.beats.grid) || [])
      .filter(function (t) { return isFiniteNum(t) && t >= 0 && (!D || t < D); })
      .sort(function (a, b) { return a - b; })
      .filter(function (t, i, a) { return i === 0 || t - a[i - 1] > 1e-4; });
    if (!gridT.length && bpm > 0 && D > 0) {
      var period = 60 / bpm;
      var rawOff = d.beats && isFiniteNum(d.beats.offset) ? d.beats.offset : (d.beats && isFiniteNum(d.beats.phase) ? d.beats.phase : (beatT.length ? beatT[0] % period : 0));
      var off = Math.max(0, rawOff % period);
      for (var gt = off; gt < D; gt += period) gridT.push(+gt.toFixed(4));
    }
    if (!beatT.length && gridT.length) {
      for (var gi = 0; gi < gridT.length; gi++) beatT.push(gridT[gi]);
      warnings.push("beats.times empty — BPM grid generated");
    }

    var downT = ((d.beats && d.beats.downbeats) || [])
      .filter(function (t) { return isFiniteNum(t) && t >= 0 && (!D || t < D); })
      .sort(function (a, b) { return a - b; })
      .filter(function (t, i, a) { return i === 0 || t - a[i - 1] > 1e-4; });
    if (!downT.length) {
      var srcForDown = gridT.length ? gridT : beatT;
      if (srcForDown.length) downT = srcForDown.filter(function (_, i) { return i % 4 === 0; });
    }

    var A = d.audio || {};
    var audioFps = isFiniteNum(A.fps) && A.fps > 0 ? A.fps : 0;
    var audioT0 = isFiniteNum(A.t0) ? A.t0 : 0;

    var cutTimes = (d.cuts || [])
      .map(function (c) { return typeof c === "number" ? c : c.t; })
      .filter(function (t) { return isFiniteNum(t) && t > 0 && (!D || t < D); })
      .sort(function (a, b) { return a - b; })
      .filter(function (t, i, a) { return i === 0 || t - a[i - 1] > 1e-4; });

    var rawSegments = (d.segments && d.segments.length)
      ? d.segments.map(function (s, idx) {
          return { t0: s.t0, t1: s.t1, index: idx, duration: Math.max(0, +(s.t1 - s.t0).toFixed(4)), clipId: s.clipId };
        })
      : (function () {
          var bounds = [0].concat(cutTimes, [D]), segs = [];
          for (var i = 0; i < bounds.length - 1; i++) {
            var t0 = bounds[i], t1 = bounds[i + 1];
            if (t1 > t0) segs.push({ t0: t0, t1: t1, index: segs.length, duration: +(t1 - t0).toFixed(4) });
          }
          return segs;
        })();

    var safePx = (d.safeZone && d.safeZone.px) || {
      x: Math.round(W * 0.05),
      y: Math.round(H * 0.05),
      w: Math.round(W * 0.9),
      h: Math.round(H * 0.9)
    };
    var safe = {
      x: safePx.x, y: safePx.y, w: safePx.w, h: safePx.h,
      cx: Math.round(safePx.x + safePx.w / 2),
      cy: Math.round(safePx.y + safePx.h / 2),
      norm: {
        x: +(safePx.x / W).toFixed(4),
        y: +(safePx.y / H).toFixed(4),
        w: +(safePx.w / W).toFixed(4),
        h: +(safePx.h / H).toFixed(4)
      }
    };

    var hfVars = (typeof window !== "undefined" && window.__hyperframes && typeof window.__hyperframes.getVariables === "function")
      ? (window.__hyperframes.getVariables() || {})
      : {};
    var mergedProps = Object.assign({}, d.props || {}, hfVars, externalVars || {});

    function sampleAudioRaw(band, t) {
      var arr = A[band];
      if (!audioFps || !arr || !arr.length) return 0;
      var x = (t - audioT0) * audioFps;
      if (x <= 0) return clamp(arr[0] || 0, 0, 1);
      if (x >= arr.length - 1) return clamp(arr[arr.length - 1] || 0, 0, 1);
      var i = Math.floor(x), f = x - i;
      return clamp((arr[i] || 0) + ((arr[i + 1] || 0) - (arr[i] || 0)) * f, 0, 1);
    }

    var cueStart = isFiniteNum(comp.sequenceStartSec) ? comp.sequenceStartSec : 0;
    var cueEnd = +(cueStart + D).toFixed(4);
    function toGlobal(localSec) { return +(localSec + cueStart).toFixed(4); }
    function toLocal(globalSec) { return +(globalSec - cueStart).toFixed(4); }

    var gRaw = d.global || null;
    var globalD = (gRaw && isFiniteNum(gRaw.duration) && gRaw.duration > 0) ? gRaw.duration : Math.max(cueEnd, D);
    var globalSourceWords = (gRaw && Array.isArray(gRaw.words))
      ? gRaw.words
      : (d.words || []).map(function (w) {
          return Object.assign({}, w, { t0: +(w.t0 + cueStart).toFixed(4), t1: +(w.t1 + cueStart).toFixed(4) });
        });

    var gWordsExpanded = [];
    globalSourceWords.forEach(function (w) {
      if (!isFiniteNum(w.t0) || !isFiniteNum(w.t1) || w.t1 <= 0 || w.t0 >= (globalD || Infinity)) return;
      var clampedT0 = Math.max(0, w.t0);
      var clampedT1 = globalD > 0 ? Math.min(globalD, w.t1) : w.t1;
      if (clampedT1 <= clampedT0) return;
      var isClipped = Boolean(w.clipped || w.t0 < 0 || (globalD > 0 && w.t1 > globalD));
      var rawText = String(w.text == null ? "" : w.text).trim();
      var parts = rawText.split(/\\s+/).filter(Boolean);
      if (parts.length <= 1) {
        var n = compactNorm(rawText);
        if (!n) return;
        gWordsExpanded.push({ t0: clampedT0, t1: clampedT1, text: rawText, n: n, clipped: isClipped });
      } else {
        var totalChars = Math.max(1, parts.reduce(function (acc, p) { return acc + p.length; }, 0));
        var span = clampedT1 - clampedT0;
        var cursorChars = 0;
        for (var pIdx = 0; pIdx < parts.length; pIdx++) {
          var part = parts[pIdx];
          var nextChars = cursorChars + part.length;
          var subT0 = +(clampedT0 + (span * cursorChars) / totalChars).toFixed(4);
          var subT1 = +(clampedT0 + (span * nextChars) / totalChars).toFixed(4);
          cursorChars = nextChars;
          var pn = compactNorm(part);
          if (!pn || subT1 <= subT0) continue;
          gWordsExpanded.push({ t0: subT0, t1: subT1, text: part, n: pn, clipped: isClipped });
        }
      }
    });
    var globalWords = gWordsExpanded.sort(function (a, b) { return a.t0 - b.t0; });

    var globalPauses = (gRaw && Array.isArray(gRaw.pauses))
      ? gRaw.pauses
      : (function () {
          var out = [];
          for (var i = 0; i < globalWords.length - 1; i++) {
            var gap = globalWords[i + 1].t0 - globalWords[i].t1;
            if (gap >= 0.2) {
              out.push({
                t0: +Math.max(0, globalWords[i].t1).toFixed(4),
                t1: +Math.min(globalD || Infinity, globalWords[i + 1].t0).toFixed(4)
              });
            }
          }
          return out;
        })();

    var globalSentences = (gRaw && Array.isArray(gRaw.sentences))
      ? gRaw.sentences
      : (function () {
          var out = [];
          if (!globalWords.length) return out;
          var sentStart = Math.max(0, globalWords[0].t0);
          var sentTokens = [];
          for (var i = 0; i < globalWords.length; i++) {
            var curr = globalWords[i];
            var next = globalWords[i + 1];
            sentTokens.push(curr.text);
            var gapSec = next ? next.t0 - curr.t1 : 0;
            if (!next || /[.!?…]$/.test(curr.text) || gapSec >= 0.4) {
              out.push({
                t0: +sentStart.toFixed(4),
                t1: +Math.min(globalD || Infinity, curr.t1).toFixed(4),
                text: sentTokens.join(" ")
              });
              if (next) {
                sentStart = Math.max(0, next.t0);
                sentTokens = [];
              }
            }
          }
          return out;
        })();

    var gBeatsSrc = (gRaw && gRaw.beats) || d.beats || {};
    var gRawBeatTimes = (gRaw && gRaw.beats && gRaw.beats.times)
      ? gRaw.beats.times
      : rawBeatTimes.map(function (t) { return +(t + cueStart).toFixed(4); });
    var gRawStrengths = gBeatsSrc.strength || [];
    var gStrengthMap = {};
    gRawBeatTimes.forEach(function (t, idx) {
      if (isFiniteNum(t) && isFiniteNum(gRawStrengths[idx])) {
        gStrengthMap[t] = gStrengthMap[t] !== undefined ? Math.max(gStrengthMap[t], gRawStrengths[idx]) : gRawStrengths[idx];
      }
    });
    var gBeatT = gRawBeatTimes
      .filter(function (t) { return isFiniteNum(t) && t >= 0 && (!globalD || t < globalD); })
      .sort(function (a, b) { return a - b; })
      .filter(function (t, i, a) { return i === 0 || t - a[i - 1] > 1e-4; });
    var gBpm = isFiniteNum(gBeatsSrc.bpm) && gBeatsSrc.bpm > 0 ? gBeatsSrc.bpm : bpm;
    var gGridT = ((gRaw && gRaw.beats && gRaw.beats.grid)
      ? gRaw.beats.grid
      : ((d.beats && d.beats.grid) || []).map(function (t) { return +(t + cueStart).toFixed(4); }))
      .filter(function (t) { return isFiniteNum(t) && t >= 0 && (!globalD || t < globalD); })
      .sort(function (a, b) { return a - b; })
      .filter(function (t, i, a) { return i === 0 || t - a[i - 1] > 1e-4; });
    if (!gGridT.length && gBpm > 0 && globalD > 0) {
      var gPeriod = 60 / gBpm;
      var gRawOff = isFiniteNum(gBeatsSrc.offset) ? gBeatsSrc.offset : (isFiniteNum(gBeatsSrc.phase) ? gBeatsSrc.phase : (gBeatT.length ? gBeatT[0] % gPeriod : 0));
      var gOff = Math.max(0, gRawOff % gPeriod);
      for (var ggt = gOff; ggt < globalD; ggt += gPeriod) gGridT.push(+ggt.toFixed(4));
    }
    if (!gBeatT.length && gGridT.length) {
      for (var ggi = 0; ggi < gGridT.length; ggi++) gBeatT.push(gGridT[ggi]);
    }
    var gDownT = ((gRaw && gRaw.beats && gRaw.beats.downbeats)
      ? gRaw.beats.downbeats
      : ((d.beats && d.beats.downbeats) || []).map(function (t) { return +(t + cueStart).toFixed(4); }))
      .filter(function (t) { return isFiniteNum(t) && t >= 0 && (!globalD || t < globalD); })
      .sort(function (a, b) { return a - b; })
      .filter(function (t, i, a) { return i === 0 || t - a[i - 1] > 1e-4; });
    if (!gDownT.length) {
      var gSrcForDown = gGridT.length ? gGridT : gBeatT;
      if (gSrcForDown.length) gDownT = gSrcForDown.filter(function (_, i) { return i % 4 === 0; });
    }

    var gA = (gRaw && gRaw.audio) || A;
    var gAudioFps = isFiniteNum(gA.fps) && gA.fps > 0 ? gA.fps : 0;
    var gAudioT0 = (gRaw && gRaw.audio) ? (isFiniteNum(gRaw.audio.t0) ? gRaw.audio.t0 : 0) : (audioT0 + cueStart);

    function sampleGlobalAudioRaw(band, t) {
      var arr = gA[band];
      if (!gAudioFps || !arr || !arr.length) return 0;
      var x = (t - gAudioT0) * gAudioFps;
      if (x <= 0) return clamp(arr[0] || 0, 0, 1);
      if (x >= arr.length - 1) return clamp(arr[arr.length - 1] || 0, 0, 1);
      var i = Math.floor(x), f = x - i;
      return clamp((arr[i] || 0) + ((arr[i + 1] || 0) - (arr[i] || 0)) * f, 0, 1);
    }

    var gCutTimes = ((gRaw && gRaw.cuts)
      ? gRaw.cuts.map(function (c) { return typeof c === "number" ? c : c.t; })
      : (d.cuts || []).map(function (c) { return +((typeof c === "number" ? c : c.t) + cueStart).toFixed(4); }))
      .filter(function (t) { return isFiniteNum(t) && t > 0 && (!globalD || t < globalD); })
      .sort(function (a, b) { return a - b; })
      .filter(function (t, i, a) { return i === 0 || t - a[i - 1] > 1e-4; });

    var gSegments = (gRaw && gRaw.segments && gRaw.segments.length)
      ? gRaw.segments.map(function (s, idx) {
          return { t0: s.t0, t1: s.t1, index: idx, duration: Math.max(0, +(s.t1 - s.t0).toFixed(4)), clipId: s.clipId };
        })
      : (function () {
          var bounds = [0].concat(gCutTimes, [globalD]), segs = [];
          for (var i = 0; i < bounds.length - 1; i++) {
            var t0 = bounds[i], t1 = bounds[i + 1];
            if (t1 > t0) segs.push({ t0: t0, t1: t1, index: segs.length, duration: +(t1 - t0).toFixed(4) });
          }
          return segs;
        })();

    var globalData = {
      hash: gRaw && gRaw.hash ? gRaw.hash : undefined,
      duration: globalD,
      words: globalSourceWords,
      pauses: globalPauses,
      sentences: globalSentences,
      beats: (gRaw && gRaw.beats) || d.beats,
      audio: (gRaw && gRaw.audio) || d.audio,
      cuts: (gRaw && gRaw.cuts) || d.cuts || [],
      segments: gSegments
    };

    var globalApi = {
      duration: globalD,
      cueStart: cueStart,
      cueEnd: cueEnd,
      bpm: gBpm,
      words: globalSourceWords,
      pauses: globalPauses,
      sentences: globalSentences,
      data: globalData,
      toLocal: toLocal,
      toGlobal: toGlobal,
      word: function (query, opts) {
        var o = opts || {};
        var targetTokens = normTurkish(query).split(" ").map(function (tok) { return tok.trim(); }).filter(Boolean);
        var afterSec = o.after != null ? o.after : 0;
        var nth = o.nth != null ? o.nth : 0;
        var matches = [];
        if (targetTokens.length > 0) {
          var kLen = targetTokens.length;
          for (var i = 0; i <= globalWords.length - kLen; i++) {
            if (globalWords[i].t0 < afterSec) continue;
            var matched = true;
            for (var k = 0; k < kLen; k++) {
              if (globalWords[i + k].n !== targetTokens[k]) { matched = false; break; }
            }
            if (matched) {
              var slice = globalWords.slice(i, i + kLen);
              matches.push({
                t0: slice[0].t0,
                t1: slice[slice.length - 1].t1,
                text: slice.map(function (w) { return w.text; }).join(" "),
                clipped: slice.some(function (w) { return w.clipped; })
              });
            }
          }
        }
        var chosen = matches[nth];
        var minDurVal = o.minDur != null ? o.minDur : 0.5;
        if (!chosen) {
          warnings.push("Word/phrase not found (global): '" + query + "'");
          var fbStart = clamp(o.fallback != null ? o.fallback : 0, 0, globalD || 1);
          var fbEnd = clamp(fbStart + Math.max(minDurVal, 1 / FPS), fbStart, globalD || fbStart + 0.5);
          var s = +fbStart.toFixed(4), e = +fbEnd.toFixed(4);
          return {
            found: false,
            start: s,
            end: e,
            duration: +Math.max(1 / FPS, e - s).toFixed(4),
            text: "",
            clipped: false,
            localStart: toLocal(s),
            localEnd: toLocal(e),
            inWindow: e > cueStart && s < cueEnd
          };
        }
        var preVal = o.pre != null ? o.pre : 0;
        var postVal = o.post != null ? o.post : 0;
        var start = clamp(chosen.t0 - preVal, 0, globalD || Infinity);
        var end = clamp(Math.max(start + 1 / FPS, chosen.t1 + postVal), start, globalD || Infinity);
        if (o.minDur != null && o.minDur > 0 && end - start < o.minDur) end = clamp(start + o.minDur, start, globalD || Infinity);
        var sOk = +start.toFixed(4), eOk = +end.toFixed(4);
        return {
          found: true,
          start: sOk,
          end: eOk,
          duration: +Math.max(1 / FPS, eOk - sOk).toFixed(4),
          text: chosen.text,
          clipped: chosen.clipped,
          localStart: toLocal(sOk),
          localEnd: toLocal(eOk),
          inWindow: eOk > cueStart && sOk < cueEnd
        };
      },
      beats: function (opts) {
        var o = opts || {};
        var from = o.from != null ? o.from : 0;
        var to = o.to != null ? o.to : globalD;
        var thresh = o.threshold != null ? o.threshold : 0.7;
        var sourceBeats = o.grid ? (gGridT.length ? gGridT : gBeatT) : gBeatT;
        var baseBeats = o.strong
          ? (o.grid
              ? (gDownT.length ? gDownT : sourceBeats.filter(function (_, i) { return i % 4 === 0; }))
              : sourceBeats.filter(function (t) {
                  var s = gStrengthMap[t];
                  return s !== undefined ? s >= thresh : gDownT.indexOf(t) >= 0;
                }))
          : sourceBeats;
        var div = o.div && o.div > 1 ? Math.floor(o.div) : 1;
        if (div <= 1) return baseBeats.filter(function (t) { return t >= from && t < to; });
        var sub = [];
        for (var i = 0; i < baseBeats.length; i++) {
          var curr = baseBeats[i];
          var next = i + 1 < baseBeats.length ? baseBeats[i + 1] : (gBpm > 0 ? curr + 60 / gBpm : null);
          if (next === null) { if (curr >= from && curr < to) sub.push(curr); continue; }
          for (var k = 0; k < div; k++) {
            var st = +(curr + ((next - curr) * k) / div).toFixed(4);
            if (st >= from && st < to) sub.push(st);
          }
        }
        return sub;
      },
      beatGrid: function (opts) {
        return globalApi.beats(Object.assign({}, opts || {}, { grid: true }));
      },
      audio: function (bandOrT, tOrSmooth, smoothSec) {
        var band = typeof bandOrT === "string" ? bandOrT : "mid";
        var t = typeof bandOrT === "number" ? bandOrT : (typeof tOrSmooth === "number" ? tOrSmooth : 0);
        var smooth = typeof bandOrT === "number" ? tOrSmooth : smoothSec;
        if (!smooth || smooth <= 0) return +sampleGlobalAudioRaw(band, t).toFixed(4);
        var n = Math.max(5, Math.min(65, Math.ceil(2 * smooth * (gAudioFps || 30)) | 1)), sum = 0;
        for (var k = 0; k < n; k++) {
          sum += sampleGlobalAudioRaw(band, t - smooth + (2 * smooth * k) / (n - 1));
        }
        return +(sum / n).toFixed(4);
      },
      cuts: function () {
        return {
          cuts: gCutTimes.slice(),
          segments: gSegments.map(function (s) { return Object.assign({}, s); })
        };
      },
      drive: function (tl, fn, opts) {
        var o = opts || {};
        var s = clamp(o.start != null ? o.start : 0, 0, globalD);
        var e = clamp(o.end != null ? o.end : globalD, s, globalD);
        var cur = s;
        var proxy = {
          t: function (v) {
            if (arguments.length) { cur = v; fn(v); }
            return cur;
          }
        };
        tl.fromTo(proxy, { t: s }, { t: e, duration: Math.max(e - s, 1 / FPS), ease: "none", immediateRender: true }, s);
        return tl;
      },
      value: function (tl, spec, fn) {
        var fromVal = spec.from != null ? spec.from : 0;
        var toVal = spec.to;
        var atSec = clamp(spec.at != null ? spec.at : 0, 0, globalD);
        var durSec = Math.max(spec.duration != null ? spec.duration : 0.6, 1 / FPS);
        var cur = fromVal;
        var proxy = {
          v: function (x) {
            if (arguments.length) { cur = x; fn(x); }
            return cur;
          }
        };
        tl.fromTo(proxy, { v: fromVal }, { v: toVal, duration: durSec, ease: spec.ease || "power2.out", immediateRender: true }, atSec);
        return tl;
      }
    };

    var normalizedData = {
      schema: SCHEMA,
      hash: d.hash || "",
      composition: {
        id: comp.id || "main",
        cueId: comp.cueId || "cue_01",
        duration: D,
        fps: FPS,
        width: W,
        height: H,
        sequenceStartSec: cueStart
      },
      props: mergedProps,
      words: d.words || [],
      sentences: d.sentences || [],
      pauses: d.pauses || [],
      beats: d.beats,
      audio: d.audio,
      cuts: d.cuts || [],
      segments: rawSegments,
      safeZone: { px: safePx },
      global: globalData
    };

    return {
      ok: errors.length === 0,
      schema: d.schema || SCHEMA,
      runtimeVersion: RUNTIME_VERSION,
      hash: d.hash || null,
      duration: D,
      cueStart: cueStart,
      cueEnd: cueEnd,
      sequenceStartSec: cueStart,
      sequenceDuration: globalD,
      fps: FPS,
      width: W,
      height: H,
      bpm: bpm,
      safe: safe,
      props: mergedProps,
      ext: (typeof window !== "undefined" && window.__cuthol && window.__cuthol.ext) ? window.__cuthol.ext : {},
      data: normalizedData,
      global: globalApi,
      warnings: warnings,
      errors: errors,
      norm: normTurkish,
      frame: function (t) { return Math.round(t * FPS) / FPS; },
      toGlobal: toGlobal,
      toLocal: toLocal,

      word: function (query, opts) {
        var o = opts || {};
        var targetTokens = normTurkish(query).split(" ").map(function (tok) { return tok.trim(); }).filter(Boolean);
        var afterSec = o.after != null ? o.after : 0;
        var nth = o.nth != null ? o.nth : 0;
        var matches = [];
        if (targetTokens.length > 0) {
          var kLen = targetTokens.length;
          for (var i = 0; i <= words.length - kLen; i++) {
            if (words[i].t0 < afterSec) continue;
            var matched = true;
            for (var k = 0; k < kLen; k++) {
              if (words[i + k].n !== targetTokens[k]) { matched = false; break; }
            }
            if (matched) {
              var slice = words.slice(i, i + kLen);
              matches.push({
                t0: slice[0].t0,
                t1: slice[slice.length - 1].t1,
                text: slice.map(function (w) { return w.text; }).join(" "),
                clipped: slice.some(function (w) { return w.clipped; })
              });
            }
          }
        }
        var chosen = matches[nth];
        var minDurVal = o.minDur != null ? o.minDur : 0.5;
        if (!chosen) {
          warnings.push("Word/phrase not found: '" + query + "'");
          var fbStart = clamp(o.fallback != null ? o.fallback : 0, 0, D || 1);
          var fbEnd = clamp(fbStart + Math.max(minDurVal, 1 / FPS), fbStart, D || fbStart + 0.5);
          return {
            found: false,
            start: +fbStart.toFixed(4),
            end: +fbEnd.toFixed(4),
            duration: +Math.max(1 / FPS, fbEnd - fbStart).toFixed(4),
            text: "",
            clipped: false
          };
        }
        var preVal = o.pre != null ? o.pre : 0;
        var postVal = o.post != null ? o.post : 0;
        var start = clamp(chosen.t0 - preVal, 0, D || Infinity);
        var end = clamp(Math.max(start + 1 / FPS, chosen.t1 + postVal), start, D || Infinity);
        if (o.minDur != null && o.minDur > 0 && end - start < o.minDur) end = clamp(start + o.minDur, start, D || Infinity);
        return {
          found: true,
          start: +start.toFixed(4),
          end: +end.toFixed(4),
          duration: +Math.max(1 / FPS, end - start).toFixed(4),
          text: chosen.text,
          clipped: chosen.clipped
        };
      },

      beats: function (opts) {
        var o = opts || {};
        var from = o.from != null ? o.from : 0;
        var to = o.to != null ? o.to : D;
        var thresh = o.threshold != null ? o.threshold : 0.7;
        var sourceBeats = o.grid ? (gridT.length ? gridT : beatT) : beatT;
        var baseBeats = o.strong
          ? (o.grid
              ? (downT.length ? downT : sourceBeats.filter(function (_, i) { return i % 4 === 0; }))
              : sourceBeats.filter(function (t) {
                  var s = strengthMap[t];
                  return s !== undefined ? s >= thresh : downT.indexOf(t) >= 0;
                }))
          : sourceBeats;
        var div = o.div && o.div > 1 ? Math.floor(o.div) : 1;
        if (div <= 1) return baseBeats.filter(function (t) { return t >= from && t < to; });
        var sub = [];
        for (var i = 0; i < baseBeats.length; i++) {
          var curr = baseBeats[i];
          var next = i + 1 < baseBeats.length ? baseBeats[i + 1] : (bpm > 0 ? curr + 60 / bpm : null);
          if (next === null) { if (curr >= from && curr < to) sub.push(curr); continue; }
          for (var k = 0; k < div; k++) {
            var st = +(curr + ((next - curr) * k) / div).toFixed(4);
            if (st >= from && st < to) sub.push(st);
          }
        }
        return sub;
      },

      beatGrid: function (opts) {
        return this.beats(Object.assign({}, opts || {}, { grid: true }));
      },

      audio: function (bandOrT, tOrSmooth, smoothSec) {
        var band = typeof bandOrT === "string" ? bandOrT : "mid";
        var t = typeof bandOrT === "number" ? bandOrT : (typeof tOrSmooth === "number" ? tOrSmooth : 0);
        var smooth = typeof bandOrT === "number" ? tOrSmooth : smoothSec;
        if (!smooth || smooth <= 0) return +sampleAudioRaw(band, t).toFixed(4);
        var n = Math.max(5, Math.min(65, Math.ceil(2 * smooth * (audioFps || 30)) | 1)), sum = 0;
        for (var k = 0; k < n; k++) {
          sum += sampleAudioRaw(band, t - smooth + (2 * smooth * k) / (n - 1));
        }
        return +(sum / n).toFixed(4);
      },

      cuts: function () {
        return {
          cuts: cutTimes.slice(),
          segments: rawSegments.map(function (s) { return Object.assign({}, s); })
        };
      },

      drive: function (tl, fn, opts) {
        var o = opts || {};
        var s = clamp(o.start != null ? o.start : 0, 0, D);
        var e = clamp(o.end != null ? o.end : D, s, D);
        var cur = s;
        var proxy = {
          t: function (v) {
            if (arguments.length) { cur = v; fn(v); }
            return cur;
          }
        };
        tl.fromTo(proxy, { t: s }, { t: e, duration: Math.max(e - s, 1 / FPS), ease: "none", immediateRender: true }, s);
        return tl;
      },

      value: function (tl, spec, fn) {
        var fromVal = spec.from != null ? spec.from : 0;
        var toVal = spec.to;
        var atSec = clamp(spec.at != null ? spec.at : 0, 0, D);
        var durSec = Math.max(spec.duration != null ? spec.duration : 0.6, 1 / FPS);
        var cur = fromVal;
        var proxy = {
          v: function (x) {
            if (arguments.length) { cur = x; fn(x); }
            return cur;
          }
        };
        tl.fromTo(proxy, { v: fromVal }, { v: toVal, duration: durSec, ease: spec.ease || "power2.out", immediateRender: true }, atSec);
        return tl;
      }
    };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { create: create, normTurkish: normTurkish, SCHEMA: SCHEMA, RUNTIME_VERSION: RUNTIME_VERSION };
  }
  if (typeof window !== "undefined") {
    var data = window.__CUTHOL_DATA__;
    if (!data && typeof document !== "undefined") {
      var el = document.getElementById("cuthol-data");
      if (el) {
        try { data = JSON.parse(el.textContent); } catch (_) { data = null; }
      }
    }
    window.__cuthol = create(data);
  }
})(this);
`;
}
