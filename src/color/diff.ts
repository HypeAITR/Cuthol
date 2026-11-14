// Difference of two colour maps in block units (owner: measurement).
import { whiteBalanceGains } from "./math.js";
import type { ColorDiff, ColorMap } from "./types.js";

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function sectorRecords(fields: Record<string, number>): Record<string, { share: number; c: number }> {
  const out: Record<string, { share: number; c: number }> = {};
  for (const k of ["red", "orange", "yellow", "green", "cyan", "sky", "blue", "magenta"]) {
    out[k] = { share: Number(fields[`sec_${k}_share`] ?? 0), c: Number(fields[`sec_${k}_c`] ?? 0) };
  }
  return out;
}

/** Mired shift whose gains best explain the neutral-axis shift from `a` to `b` (grid search on the inverse). */
export function neutralToMiredTint(a: { a: number; b: number }, b: { a: number; b: number }): { mired: number; tint: number } {
  // Approximate: Lab neutral shift per mired/tint measured on mid grey (0.5 encoded).
  // Calibrate numerically: gain round-trip on grey.
  let best = { mired: 0, tint: 0 };
  let bestErr = Infinity;
  const da = b.a - a.a;
  const db = b.b - a.b;
  for (let mired = -120; mired <= 120; mired += 5) {
    for (let tint = -0.5; tint <= 0.5; tint += 0.1) {
      const g = whiteBalanceGains(mired, tint);
      // Linear-space gain effect on grey approximated in Lab via gain ratios.
      const pa = 12 * (g[0] / g[1] - 1);
      const pb = 12 * (1 - g[2] / g[1]);
      const err = (pa - da) ** 2 + (pb - db) ** 2;
      if (err < bestErr) { bestErr = err; best = { mired, tint }; }
    }
  }
  return best;
}

export function colorDiff(a: ColorMap, b: ColorMap): ColorDiff {
  const fa = a.fields as Record<string, number>;
  const fb = b.fields as Record<string, number>;
  // Exposure from the bright end in linear light (BT.1886 2.4 decode first:
  // encoded percentiles compress highlights and would under-read stops).
  const lin = (x: number): number => (x <= 0 ? 0 : Math.pow(Math.max(0, x), 2.4));
  const stopsAt = (q: string): number => {
    const r = lin(num((fb as Record<string, number>)[q], 0.5)) / Math.max(1e-9, lin(num((fa as Record<string, number>)[q], 0.5)));
    return Math.log2(Math.max(1e-9, r));
  };
  const stops = (stopsAt("L_p25") + stopsAt("L_p50") * 2 + stopsAt("L_p75") * 3) / 6;
  const wb = neutralToMiredTint({ a: fa.md_a, b: fa.md_b }, { a: fb.md_a, b: fb.md_b });
  const contrast = ((fb.L_p75 - fb.L_p25) - (fa.L_p75 - fa.L_p25)) * 2;
  const satRatio = num(fb.M, 0) / Math.max(1e-6, num(fa.M, 0));
  const deltas: Record<string, number> = {
    exposure_stops: Math.max(-8, Math.min(8, stops)),
    wb_mired: wb.mired,
    wb_tint: Math.round(wb.tint * 100) / 100,
    tone_contrast: Math.max(-1, Math.min(1, contrast)),
    saturation_ratio: Math.round(satRatio * 100) / 100,
  };
  const sa = sectorRecords(a.fields as Record<string, number>);
  const sb = sectorRecords(b.fields as Record<string, number>);
  for (const k of Object.keys({ ...sa, ...sb })) {
    const dC = num(sb[k]?.c, 0) - num(sa[k]?.c, 0);
    const dShare = num(sb[k]?.share, 0) - num(sa[k]?.share, 0);
    deltas[`hue_${k}_dc`] = Math.round(dC * 10) / 10;
    deltas[`hue_${k}_dshare`] = Math.round(dShare * 1000) / 1000;
  }
  // Overlap: comparable when tone ranges and dominant sectors agree.
  const domA = Object.entries(sa).sort((x, y) => y[1].share - x[1].share)[0]?.[0];
  const domB = Object.entries(sb).sort((x, y) => y[1].share - x[1].share)[0]?.[0];
  const toneSim = 1 - Math.min(1, Math.abs(num(fb.L_p50, 0) - num(fa.L_p50, 0)) * 3 + Math.abs(num(fb.M, 0) - num(fa.M, 0)) * 2);
  const overlap = Math.round(Math.max(0, Math.min(1, (domA === domB ? 0.35 : 0) + 0.65 * toneSim)) * 100) / 100;
  return {
    deltas,
    overlap,
    lines: [
      `exposure ${deltas.exposure_stops >= 0 ? "+" : ""}${deltas.exposure_stops.toFixed(2)} stops`,
      `white_balance ${wb.mired >= 0 ? "+" : ""}${wb.mired} mired tint ${wb.tint >= 0 ? "+" : ""}${wb.tint.toFixed(2)}`,
      `tone contrast ${contrast >= 0 ? "+" : ""}${contrast.toFixed(2)} saturation x${satRatio.toFixed(2)}`,
      `overlap ${overlap.toFixed(2)}${domA === domB ? ` (both ${domA})` : ` (${domA} vs ${domB})`}`,
    ],
  };
}
