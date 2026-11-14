// Text-first colour map of a frame set (owner: measurement).
import { frameSetSamples } from "./frames.js";
import { LUMA_B, LUMA_G, LUMA_R, rgbToLab } from "./math.js";
import type { ColorFrameSet, ColorMap } from "./types.js";

const SECTOR_NAMES = ["red", "orange", "yellow", "green", "cyan", "sky", "blue", "magenta"] as const;

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)));
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function sortedCopy(v: number[]): number[] {
  return [...v].sort((a, b) => a - b);
}

function hsvHueSat(r: number, g: number, b: number): [number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  if (c <= 1e-9) return [0, 0];
  let h: number;
  if (max === r) h = (((g - b) / c) % 6) * 60;
  else if (max === g) h = ((b - r) / c) * 60 + 120;
  else h = ((r - g) / c) * 60 + 240;
  if (h < 0) h += 360;
  return [h, max > 0 ? c / max : 0];
}

export interface MapSamples {
  luma: number[];
  lab: Array<[number, number, number]>;
  chroma: number[];
  sat: number[];
  hue: number[];
  rgb: Float32Array;
}

export function samplesOf(set: ColorFrameSet, maxPerFrame = 4096): MapSamples {
  const rgb = frameSetSamples(set, maxPerFrame);
  const n = Math.floor(rgb.length / 3);
  const luma: number[] = new Array(n);
  const lab: Array<[number, number, number]> = new Array(n);
  const chroma: number[] = new Array(n);
  const sat: number[] = new Array(n);
  const hue: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    luma[i] = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    const L = rgbToLab(r, g, b);
    lab[i] = L;
    chroma[i] = Math.hypot(L[1], L[2]);
    const [h, s] = hsvHueSat(r, g, b);
    hue[i] = h;
    sat[i] = s;
  }
  return { luma, lab, chroma, sat, hue, rgb };
}

export function colorMap(set: ColorFrameSet, opts?: { label?: string }): ColorMap {
  const t0 = Date.now();
  const s = samplesOf(set);
  const n = s.luma.length;
  const ls = sortedCopy(s.luma);
  const q = (v: number): number => quantile(ls, v);
  const clipLo = s.luma.filter((v) => v <= 0.015).length / Math.max(1, n);
  const clipHi = s.luma.filter((v) => v >= 0.985).length / Math.max(1, n);

  // Neutral axis: low-chroma pixels (C* < 6) split by luma bands.
  const band = (lo: number, hi: number): { cov: number; a: number; b: number } => {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (s.chroma[i] < 6 && s.luma[i] >= lo && s.luma[i] < hi) idx.push(i);
    const cov = idx.length / Math.max(1, n);
    if (!idx.length) return { cov, a: 0, b: 0 };
    const as = sortedCopy(idx.map((i) => s.lab[i][1]));
    const bs = sortedCopy(idx.map((i) => s.lab[i][2]));
    return { cov, a: quantile(as, 0.5), b: quantile(bs, 0.5) };
  };
  const sh = band(0, 0.3);
  const md = band(0.3, 0.7);
  const hi = band(0.7, 1.01);
  const neutralCov = (sh.cov + md.cov + hi.cov);

  // Colourfulness M (Hasler-Susstrunk) on encoded RGB.
  let rgMean = 0;
  let ybMean = 0;
  const rg: number[] = new Array(n);
  const yb: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = s.rgb[i * 3];
    const g = s.rgb[i * 3 + 1];
    const b = s.rgb[i * 3 + 2];
    const a = r - g;
    const c = 0.5 * (r + g) - b;
    rg[i] = a; yb[i] = c; rgMean += a; ybMean += c;
  }
  rgMean /= Math.max(1, n); ybMean /= Math.max(1, n);
  let rgVar = 0;
  let ybVar = 0;
  for (let i = 0; i < n; i++) { rgVar += (rg[i] - rgMean) ** 2; ybVar += (yb[i] - ybMean) ** 2; }
  rgVar /= Math.max(1, n); ybVar /= Math.max(1, n);
  const M = Math.sqrt(rgVar + ybVar) + 0.3 * Math.sqrt(rgMean ** 2 + ybMean ** 2);

  const chromIdx: number[] = [];
  for (let i = 0; i < n; i++) if (s.sat[i] > 0.12 && s.luma[i] > 0.05 && s.luma[i] < 0.97) chromIdx.push(i);
  const chromaVals = sortedCopy(chromIdx.map((i) => s.chroma[i]));
  const chromaP50 = chromaVals.length ? quantile(chromaVals, 0.5) : 0;

  // 8 hue sectors (each chromatic pixel belongs to exactly one 45-degree sector).
  const sectors: Record<string, { share: number; c: number; l: number }> = {};
  const buckets: number[][] = SECTOR_NAMES.map(() => []);
  for (const i of chromIdx) buckets[Math.min(7, Math.floor((((s.hue[i] % 360) + 360) % 360) / 45))].push(i);
  for (let k = 0; k < 8; k++) {
    const name = SECTOR_NAMES[k];
    const idx = buckets[k];
    const share = idx.length / Math.max(1, n);
    const cs = sortedCopy(idx.map((i) => s.chroma[i]));
    const lsv = sortedCopy(idx.map((i) => s.lab[i][0]));
    sectors[name] = { share, c: idx.length ? quantile(cs, 0.5) : 0, l: idx.length ? quantile(lsv, 0.5) : 0 };
  }

  // Temporal spread: per-frame mean luma std.
  const frameMeans: number[] = [];
  for (const fr of set.frames) {
    let m = 0;
    const nn = fr.length / 3;
    for (let i = 0; i < fr.length; i += 3) m += LUMA_R * fr[i] + LUMA_G * fr[i + 1] + LUMA_B * fr[i + 2];
    frameMeans.push(m / Math.max(1, nn));
  }
  const meanOf = frameMeans.reduce((a, b) => a + b, 0) / Math.max(1, frameMeans.length);
  const timeSpread = Math.sqrt(frameMeans.reduce((a, b) => a + (b - meanOf) ** 2, 0) / Math.max(1, frameMeans.length));

  const evidence: string[] = [];
  if (neutralCov < 0.03) evidence.push(`neutral coverage ${(neutralCov * 100).toFixed(1)}%: cast and scene colour cannot be separated`);
  if (hi.cov < 0.01) evidence.push("no neutral highlights: white-balance from highs is unreliable");
  if (clipHi > 0.05) evidence.push(`highlight clipping ${(clipHi * 100).toFixed(1)}%: exposure reads from the bright end`);
  if (clipLo > 0.2) evidence.push(`deep shadows ${(clipLo * 100).toFixed(1)}%: crushed blacks likely`);
  const dom = [...SECTOR_NAMES].sort((a, b) => sectors[b].share - sectors[a].share)[0];
  if (sectors[dom].share > 0.25) evidence.push(`dominant ${dom} sector ${(sectors[dom].share * 100).toFixed(0)}%: selective look likely, global LUT unsafe`);
  if (!evidence.length) evidence.push("neutral coverage adequate for white-balance solve");

  const f2 = (v: number): string => (Math.round(v * 100) / 100).toFixed(2);
  const lines = [
    `tone L p1=${f2(q(0.01))} p25=${f2(q(0.25))} p50=${f2(q(0.5))} p75=${f2(q(0.75))} p99=${f2(q(0.99))} clipLo=${(clipLo * 100).toFixed(1)}% clipHi=${(clipHi * 100).toFixed(1)}%`,
    `neutral cov=${(neutralCov * 100).toFixed(1)}% sh_a=${sh.a.toFixed(1)} sh_b=${sh.b.toFixed(1)} md_a=${md.a.toFixed(1)} md_b=${md.b.toFixed(1)} hi_a=${hi.a.toFixed(1)} hi_b=${hi.b.toFixed(1)}`,
    `colour M=${M.toFixed(3)} chromaP50=${chromaP50.toFixed(1)}`,
    `hues ${SECTOR_NAMES.map((k) => `${k}:${(sectors[k].share * 100).toFixed(0)}%/${sectors[k].c.toFixed(0)}/${sectors[k].l.toFixed(0)}`).join(" ")}`,
    `time frames=${set.frames.length} spread=${timeSpread.toFixed(3)}`,
    `evidence ${evidence.join("; ")}`,
  ];
  const sectorFields: Record<string, number> = {};
  for (const k of SECTOR_NAMES) { sectorFields[`sec_${k}_share`] = sectors[k].share; sectorFields[`sec_${k}_c`] = sectors[k].c; sectorFields[`sec_${k}_l`] = sectors[k].l; }
  void t0;
  void opts;
  return {
    version: 1,
    frames: set.frames.length,
    fields: {
      L_p01: q(0.01), L_p25: q(0.25), L_p50: q(0.5), L_p75: q(0.75), L_p99: q(0.99),
      clip_lo: clipLo, clip_hi: clipHi,
      neutral_cov: neutralCov,
      sh_a: sh.a, sh_b: sh.b, md_a: md.a, md_b: md.b, hi_a: hi.a, hi_b: hi.b,
      sh_cov: sh.cov, md_cov: md.cov, hi_cov: hi.cov,
      M, chroma_p50: chromaP50,
      ...sectorFields,
      time_spread: timeSpread,
      label: opts?.label ?? "",
    },
    evidence,
    lines,
  };
}

