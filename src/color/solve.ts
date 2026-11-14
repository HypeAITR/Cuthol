// Proposes a block patch towards an objective target; never applies it (owner: measurement).
import { stageToFlags } from "./cli_parse.js";
import fs from "node:fs";
import path from "node:path";
import { frameSetSamples } from "./frames.js";
import { applyLutToPixels, writeCube } from "./lut.js";
import { fitPairLut } from "./pair_lut.js";
import { colorDiff } from "./diff.js";
import { colorMap } from "./map.js";
import { applyStageToPixels, deltaE2000, prepareBlocks, rgbToLab, stagePixelFunction, whiteBalanceGains } from "./math.js";
import type { ColorBlocks, ColorFrameSet, ColorSolveMode, ColorSolveResult } from "./types.js";

export interface ColorSolveInput {
  mode: ColorSolveMode;
  /** Frames to correct (`match`, `technical`) or the BEFORE frames of a pair (`pair`). */
  from: ColorFrameSet;
  /** Target frames (`match`: another item or a reference) or the AFTER frames of a pair (`pair`). */
  to?: ColorFrameSet;
  /** `technical` targets. */
  technical?: Array<"exposure" | "white_balance" | "legal_range">;
  /** Project root; `pair` writes its LUT under `looks/`. */
  rootDir: string;
  /** Name used for a written LUT file. */
  name?: string;
}

function meanDe(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length) / 3;
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += deltaE2000(rgbToLab(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]), rgbToLab(b[i * 3], b[i * 3 + 1], b[i * 3 + 2]));
  }
  return n > 0 ? s / n : 0;
}

function applyBlocks(rgb: Float32Array, blocks: ColorBlocks): Float32Array {
  return applyStageToPixels(rgb, stagePixelFunction(blocks, null));
}

function toArgs(patch: ColorBlocks): string {
  return `--item <item> ${stageToFlags(patch)}`;
}

/** Smooth-only match: white balance + exposure + tone + saturation via coordinate descent on samples. */
function solveMatch(from: Float32Array, to: Float32Array): { patch: ColorBlocks; residual: number } {
  const patch: ColorBlocks = {
    white_balance: { temp_mired: 0, tint: 0 },
    exposure: { stops: 0 },
    tone: { contrast: 0 },
    saturation: { saturation: 1 },
  };
  const evalPatch = (): number => meanDe(applyBlocks(from, patch), to);
  // Multi-start on the coupled warm/saturation axis: keep the best of three seeds.
  let best = Infinity;
  let bestPatch: ColorBlocks = JSON.parse(JSON.stringify(patch));
  for (const seed of [{ m: -40, s: 1 }, { m: 0, s: 1 }, { m: 40, s: 0.75 }]) {
    patch.white_balance!.temp_mired = seed.m;
    patch.saturation!.saturation = seed.s;
    descend(patch, evalPatch);
    const v = evalPatch();
    if (v < best) { best = v; bestPatch = JSON.parse(JSON.stringify(patch)); }
  }
  Object.assign(patch, bestPatch);
  return finish(patch, best);

  function descend(patch: ColorBlocks, evalPatch: () => number): number {
    let best = evalPatch();
    const steps: Array<{ get: () => number; set: (v: number) => void; lo: number; hi: number; step: number }> = [
      { get: () => patch.exposure!.stops, set: (v) => (patch.exposure!.stops = v), lo: -3, hi: 3, step: 0.15 },
      { get: () => patch.white_balance!.temp_mired, set: (v) => (patch.white_balance!.temp_mired = v), lo: -120, hi: 120, step: 10 },
      { get: () => patch.white_balance!.tint, set: (v) => (patch.white_balance!.tint = v), lo: -0.6, hi: 0.6, step: 0.1 },
      { get: () => patch.saturation!.saturation ?? 1, set: (v) => (patch.saturation!.saturation = v), lo: 0.4, hi: 1.8, step: 0.08 },
      { get: () => patch.tone!.contrast ?? 0, set: (v) => (patch.tone!.contrast = v), lo: -0.6, hi: 0.6, step: 0.1 },
    ];
    for (let pass = 0; pass < 6; pass++) {
      for (const s of steps) {
        let improved = true;
        while (improved) {
          improved = false;
          for (const dir of [-1, 1]) {
            const nv = Math.max(s.lo, Math.min(s.hi, s.get() + dir * s.step));
            const old = s.get();
            s.set(nv);
            const v = evalPatch();
            if (v < best - 1e-4) { best = v; improved = true; }
            else s.set(old);
          }
        }
      }
      for (const s of steps) s.step /= 2;
    }
    return best;
  }

  function finish(patch: ColorBlocks, best: number): { patch: ColorBlocks; residual: number } {
    // Round and drop no-ops.
    patch.white_balance!.temp_mired = Math.round(patch.white_balance!.temp_mired);
    patch.white_balance!.tint = Math.round(patch.white_balance!.tint * 100) / 100;
    patch.exposure!.stops = Math.round(patch.exposure!.stops * 100) / 100;
    patch.tone!.contrast = Math.round((patch.tone!.contrast ?? 0) * 100) / 100;
    patch.saturation!.saturation = Math.round((patch.saturation!.saturation ?? 1) * 100) / 100;
    if (patch.white_balance!.temp_mired === 0 && patch.white_balance!.tint === 0) delete patch.white_balance;
    if (patch.exposure!.stops === 0) delete patch.exposure;
    if (!patch.tone!.contrast) delete patch.tone;
    if (patch.saturation!.saturation === 1) delete patch.saturation;
    return { patch, residual: best };
  }
}

/** Pair: coarse voxel-mean 3D mapping baked to a 33 cube + explanatory blocks. */
function solvePair(from: ColorFrameSet, to: ColorFrameSet, rootDir: string, name: string): { lut_uri: string; patch: ColorBlocks; residual: number } {
  const a = frameSetSamples(from, 60000);
  const b = frameSetSamples(to, 60000);
  const { lut } = fitPairLut(a, b);
  const rel = path.posix.join("looks", `${name}.cube`);
  writeCube(lut, path.join(rootDir, rel), `cuthol pair ${name}`);
  const { patch } = solveMatch(a.subarray(0, 18000), b.subarray(0, 18000));
  const residual = meanDe(applyLutToPixels(lut, a), b);
  return { lut_uri: rel, patch, residual };
}

function solveTechnical(from: ColorFrameSet, targets: Array<"exposure" | "white_balance" | "legal_range">): ColorBlocks {
  const m = colorMap(from);
  const f = m.fields as Record<string, number>;
  const patch: ColorBlocks = {};
  if (targets.includes("exposure")) {
    // From the bright end: bring p99 to ~0.92.
    const stops = Math.log2(0.92 / Math.max(0.05, f.L_p99 + 0.02));
    const s = Math.max(-2, Math.min(2, Math.round(stops * 100) / 100));
    if (Math.abs(s) > 0.03) patch.exposure = { stops: s };
  }
  if (targets.includes("white_balance")) {
    if (f.neutral_cov >= 0.03) {
      // Drive mid neutral towards zero via the calibrated inverse.
      const g0 = whiteBalanceGains(0, 0);
      void g0;
      const mired = Math.max(-120, Math.min(120, Math.round(-f.md_a * 6 - f.md_b * 2)));
      const tint = Math.max(-0.6, Math.min(0.6, Math.round((-f.md_a * 0.02 + f.md_b * 0.0) * 100) / 100));
      if (mired !== 0 || tint !== 0) patch.white_balance = { temp_mired: mired, tint };
    }
  }
  if (targets.includes("legal_range")) {
    if (f.clip_lo > 0.02 || f.clip_hi > 0.02) patch.tone = { contrast: 0, blacks: 0, whites: 0 };
  }
  void prepareBlocks;
  return patch;
}

export function colorSolve(input: ColorSolveInput): ColorSolveResult {
  const fromS = frameSetSamples(input.from, 6000);
  if (input.mode === "pair") {
    if (!input.to) throw new Error("pair needs `to` frames");
    const name = (input.name ?? "pair-look").replace(/[^a-z0-9-_]+/gi, "-");
    const { lut_uri, patch, residual } = solvePair(input.from, input.to, input.rootDir, name);
    return {
      mode: "pair",
      patch,
      lut_uri,
      predicted_residual_de: Math.round(residual * 100) / 100,
      lines: [...Object.entries(patch).map(([k, v]) => `block ${k} ${JSON.stringify(v)}`), `residual ${residual.toFixed(2)} dE`, `cuthol color look create --name ${name} --lut ${lut_uri}`],
    };
  }
  if (input.mode === "technical") {
    const patch = solveTechnical(input.from, input.technical ?? ["exposure", "white_balance", "legal_range"]);
    const residual = meanDe(applyBlocks(fromS, patch), fromS);
    const m = colorMap(input.from);
    const gated = (m.fields as Record<string, number>).neutral_cov < 0.03 && patch.white_balance === undefined;
    return {
      mode: "technical",
      patch,
      predicted_residual_de: Math.round(residual * 100) / 100,
      lines: [
        ...Object.entries(patch).map(([k, v]) => `block ${k} ${JSON.stringify(v)}`),
        ...(gated ? ["white balance skipped: neutral coverage too low"] : []),
        `cuthol color set ${toArgs(patch)}`.trim(),
      ],
    };
  }
  if (!input.to) throw new Error("match needs `to` frames");
  const toS = frameSetSamples(input.to, 6000);
  const { patch, residual } = solveMatch(fromS, toS);
  const diff = colorDiff(colorMap(input.from), colorMap(input.to));
  return {
    mode: "match",
    patch,
    predicted_residual_de: Math.round(residual * 100) / 100,
    lines: [...diff.lines.map((l) => `target ${l}`), `residual ${residual.toFixed(2)} dE`, `cuthol color set ${toArgs(patch)}`.trim()],
  };
}
