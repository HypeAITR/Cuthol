// Render-free prediction of a grade: the "after" map and side effects (owner: measurement).
import { frameSetSamples } from "./frames.js";
import { colorMap } from "./map.js";
import { applyStageToPixels } from "./math.js";
import type { ColorFrameSet, ColorMap, ColorPrediction } from "./types.js";

export function predictStage(
  source: ColorFrameSet,
  fn: (p: [number, number, number]) => void,
  opts?: { before?: ColorMap }
): ColorPrediction {
  const t0 = Date.now();
  const before = opts?.before ?? colorMap(source);
  const graded: ColorFrameSet = {
    width: source.width,
    height: source.height,
    at_ms: [...source.at_ms],
    stage: "graded",
    frames: source.frames.map((f) => applyStageToPixels(f, fn)),
  };
  const after = colorMap(graded);
  // Mean dE between sampled source and graded pixels.
  const src = frameSetSamples(source);
  const dst = frameSetSamples(graded);
  const n = Math.min(src.length, dst.length) / 3;
  let sum = 0;
  const { rgbToLab, deltaE2000 } = math();
  for (let i = 0; i < n; i++) {
    sum += deltaE2000(
      rgbToLab(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]),
      rgbToLab(dst[i * 3], dst[i * 3 + 1], dst[i * 3 + 2])
    );
  }
  const mean_change_de = n > 0 ? sum / n : 0;
  const fb = before.fields as Record<string, number>;
  const fa = after.fields as Record<string, number>;
  const side_effects: string[] = [];
  const dHiA = fa.hi_a - fb.hi_a;
  const dHiB = fa.hi_b - fb.hi_b;
  if (fb.hi_cov > 0.05 && fa.hi_cov < fb.hi_cov / 2) {
    side_effects.push(`neutral highlights turned chromatic (coverage ${(fb.hi_cov * 100).toFixed(0)}% -> ${(fa.hi_cov * 100).toFixed(0)}%; white wall turns colour)`);
  } else if (Math.hypot(dHiA, dHiB) > 4 && fb.hi_cov > 0.005) {
    side_effects.push(`neutral highlights shift a${dHiA >= 0 ? "+" : ""}${dHiA.toFixed(1)} b${dHiB >= 0 ? "+" : ""}${dHiB.toFixed(1)} (white wall turns ${dHiA > 2 ? "pink" : dHiB > 2 ? "yellow" : dHiB < -2 ? "blue" : "coloured"})`);
  }
  const dClipHi = fa.clip_hi - fb.clip_hi;
  if (dClipHi > 0.02) side_effects.push(`new highlight clipping +${(dClipHi * 100).toFixed(1)}%`);
  const dClipLo = fa.clip_lo - fb.clip_lo;
  if (dClipLo > 0.05) side_effects.push(`new shadow crushing +${(dClipLo * 100).toFixed(1)}%`);
  const dM = fa.M - fb.M;
  if (Math.abs(dM) > 0.05) side_effects.push(`colourfulness ${dM >= 0 ? "+" : ""}${dM.toFixed(3)}`);
  const sa = sectorRecordsP(before.fields as Record<string, number>);
  const sb = sectorRecordsP(after.fields as Record<string, number>);
  for (const k of Object.keys(sa)) {
    const dC = Math.abs((sb[k]?.c ?? 0) - (sa[k]?.c ?? 0));
    if (dC > 12 && (sa[k]?.share ?? 0) > 0.03) side_effects.push(`hue sector ${k} chroma shift ${dC.toFixed(0)}`);
  }
  if (!side_effects.length) side_effects.push("no side effects above threshold");
  void t0;
  return {
    after,
    side_effects,
    mean_change_de: Math.round(mean_change_de * 100) / 100,
    lines: [
      `mean change ${mean_change_de.toFixed(2)} dE`,
      ...side_effects.map((s) => `side_effect ${s}`),
    ],
  };
}

export function sectorRecordsP(fields: Record<string, number>): Record<string, { share: number; c: number }> {
  const out: Record<string, { share: number; c: number }> = {};
  for (const k of ["red", "orange", "yellow", "green", "cyan", "sky", "blue", "magenta"]) {
    out[k] = { share: Number(fields[`sec_${k}_share`] ?? 0), c: Number(fields[`sec_${k}_c`] ?? 0) };
  }
  return out;
}

// Lazy import target to keep module load order simple.
import * as mathNs from "./math.js";
function math(): typeof mathNs {
  return mathNs;
}
