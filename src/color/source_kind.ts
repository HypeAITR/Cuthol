// Camera / screen recording / graphic detection from pixels.
// Camera footage carries sensor noise and optical softness: almost no exactly-flat areas and no
// razor edges. Screen recordings carry large flat fills. Smooth synthetic graphics are neither flat
// nor sharp; sharp monochrome content is graphic while sharp colourful content is screen.
// Thresholds were calibrated on a labelled set of camera, screen and graphic frames.
import type { ColorFrameSet, ColorSourceKind } from "./types.js";

export function detectSourceKind(frames: ColorFrameSet): { kind: ColorSourceKind; confidence: number; evidence: string } {
  const w = frames.width;
  const full = new Float32Array(frames.frames.reduce((s, f) => s + f.length, 0));
  let off = 0;
  for (const f of frames.frames) { full.set(f, off); off += f.length; }
  const rgb = full;
  const n = Math.floor(rgb.length / 3);
  const lum = (i: number): number => 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
  let flat = 0;
  let huge = 0;
  let tot = 0;
  for (let i = 0; i + w + 1 < n; i++) {
    const d = Math.abs(lum(i) - lum(i + 1)) + Math.abs(lum(i) - lum(i + w));
    tot++;
    if (d === 0) flat++;
    if (d > 0.5) huge++;
  }
  const flatFrac = flat / Math.max(1, tot);
  const hugeFrac = huge / Math.max(1, tot);
  let satSum = 0;
  for (let i = 0; i < n; i++) {
    const mx = Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    const mn = Math.min(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    satSum += mx > 0 ? (mx - mn) / mx : 0;
  }
  const satMean = satSum / Math.max(1, n);
  let kind: ColorSourceKind = "camera";
  let confidence = 0.6;
  if (flatFrac > 0.25) {
    kind = "screen";
    confidence = flatFrac > 0.5 ? 0.85 : 0.75;
  } else if (hugeFrac > 0.015) {
    kind = satMean > 0.15 ? "screen" : "graphic";
    confidence = 0.75;
  } else if (hugeFrac < 0.002 && flatFrac < 0.1) {
    kind = "graphic";
    confidence = 0.7;
  } else {
    kind = "camera";
    confidence = 0.75;
  }
  return {
    kind,
    confidence,
    evidence: `${kind} (flat=${flatFrac.toFixed(3)} sharp=${hugeFrac.toFixed(4)} sat=${satMean.toFixed(2)})`,
  };
}
