// 3D LUT baking, self-test, `.cube` I/O and tetrahedral sampling.
//
// A colour stage is compiled to ONE LUT. Grid size: 33 by default; the baker samples random colours (and any
// real frame pixels given) against the exact block math and moves to 65 when the 99th percentile CIEDE2000
// error exceeds LUT_SELFTEST_P99_LIMIT (measured: narrow HSL qualifiers need 65, global blocks do not).
// Sampling is tetrahedral, the same interpolation ffmpeg `lut3d` uses by default and the Live shader implements.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deltaE2000, rgbToLab } from "./math.js";

/** Grid data in `.cube` order: red varies fastest, then green, then blue. RGB triplets, 0..1. */
export interface Lut3D {
  size: number;
  data: Float32Array;
}

export const LUT_DEFAULT_SIZE = 33;
export const LUT_FINE_SIZE = 65;
/** p99 CIEDE2000 limit of the 33-grid self-test before the baker moves to 65. */
export const LUT_SELFTEST_P99_LIMIT = 1.0;

type Px = [number, number, number];

export function bakeLut(fn: (p: Px) => void, size: number): Lut3D {
  const data = new Float32Array(size * size * size * 3);
  const p: Px = [0, 0, 0];
  let o = 0;
  const s = size - 1;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        p[0] = r / s;
        p[1] = g / s;
        p[2] = b / s;
        fn(p);
        data[o++] = p[0];
        data[o++] = p[1];
        data[o++] = p[2];
      }
    }
  }
  return { size, data };
}

/** Tetrahedral interpolation of one pixel (in place). */
export function sampleLutTetra(lut: Lut3D, p: Px): void {
  const n = lut.size;
  const d = lut.data;
  const s = n - 1;
  const x = Math.min(1, Math.max(0, p[0])) * s;
  const y = Math.min(1, Math.max(0, p[1])) * s;
  const z = Math.min(1, Math.max(0, p[2])) * s;
  const r0 = Math.min(Math.floor(x), s - 1);
  const g0 = Math.min(Math.floor(y), s - 1);
  const b0 = Math.min(Math.floor(z), s - 1);
  const fr = x - r0;
  const fg = y - g0;
  const fb = z - b0;
  const idx = (r: number, g: number, b: number): number => ((b * n + g) * n + r) * 3;
  const c000 = idx(r0, g0, b0);
  const c111 = idx(r0 + 1, g0 + 1, b0 + 1);
  let c1: number, c2: number, t1: number, t2: number, t3: number;
  if (fr > fg) {
    if (fg > fb) {
      c1 = idx(r0 + 1, g0, b0); c2 = idx(r0 + 1, g0 + 1, b0); t1 = fr; t2 = fg; t3 = fb;
    } else if (fr > fb) {
      c1 = idx(r0 + 1, g0, b0); c2 = idx(r0 + 1, g0, b0 + 1); t1 = fr; t2 = fb; t3 = fg;
    } else {
      c1 = idx(r0, g0, b0 + 1); c2 = idx(r0 + 1, g0, b0 + 1); t1 = fb; t2 = fr; t3 = fg;
    }
  } else {
    if (fb > fg) {
      c1 = idx(r0, g0, b0 + 1); c2 = idx(r0, g0 + 1, b0 + 1); t1 = fb; t2 = fg; t3 = fr;
    } else if (fb > fr) {
      c1 = idx(r0, g0 + 1, b0); c2 = idx(r0, g0 + 1, b0 + 1); t1 = fg; t2 = fb; t3 = fr;
    } else {
      c1 = idx(r0, g0 + 1, b0); c2 = idx(r0 + 1, g0 + 1, b0); t1 = fg; t2 = fr; t3 = fb;
    }
  }
  for (let c = 0; c < 3; c++) {
    p[c] = (1 - t1) * d[c000 + c] + (t1 - t2) * d[c1 + c] + (t2 - t3) * d[c2 + c] + t3 * d[c111 + c];
  }
}

export function applyLutToPixels(lut: Lut3D, rgb: Float32Array): Float32Array {
  const out = new Float32Array(rgb.length);
  const p: Px = [0, 0, 0];
  for (let i = 0; i < rgb.length; i += 3) {
    p[0] = rgb[i];
    p[1] = rgb[i + 1];
    p[2] = rgb[i + 2];
    sampleLutTetra(lut, p);
    out[i] = p[0];
    out[i + 1] = p[1];
    out[i + 2] = p[2];
  }
  return out;
}

/** Deterministic pseudo-random RGB samples (mulberry32), interleaved. */
export function randomRgbSamples(count: number, seed = 0x5eed): Float32Array {
  let a = seed >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float32Array(count * 3);
  for (let i = 0; i < out.length; i++) out[i] = rnd();
  return out;
}

export interface LutSelfTest {
  samples: number;
  mean_de: number;
  p99_de: number;
  max_de: number;
}

/** Compares LUT sampling with the exact function on `samples` (interleaved RGB). */
export function selfTestLut(lut: Lut3D, fn: (p: Px) => void, samples: Float32Array): LutSelfTest {
  const n = samples.length / 3;
  const errs = new Float64Array(n);
  const a: Px = [0, 0, 0];
  const b: Px = [0, 0, 0];
  let sum = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    a[0] = b[0] = samples[i * 3];
    a[1] = b[1] = samples[i * 3 + 1];
    a[2] = b[2] = samples[i * 3 + 2];
    fn(a);
    sampleLutTetra(lut, b);
    const e = deltaE2000(rgbToLab(a[0], a[1], a[2]), rgbToLab(b[0], b[1], b[2]));
    errs[i] = e;
    sum += e;
    if (e > max) max = e;
  }
  const sorted = Array.from(errs).sort((x, y) => x - y);
  const p99 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))] : 0;
  return { samples: n, mean_de: n ? sum / n : 0, p99_de: p99, max_de: max };
}

export interface CompiledLut {
  lut: Lut3D;
  selftest: LutSelfTest;
}

/**
 * Bakes `fn` at 33, self-tests on 4096 random colours plus `framePixels` (if any), and re-bakes at 65 when the
 * p99 error is above the limit. The 65 result is returned even if it still fails; callers report `selftest`.
 */
export function compileLut(fn: (p: Px) => void, framePixels?: Float32Array): CompiledLut {
  const rnd = randomRgbSamples(4096);
  let samples = rnd;
  if (framePixels && framePixels.length) {
    // At most 20k frame pixels, evenly strided, keep the test cheap.
    const n = framePixels.length / 3;
    const stride = Math.max(1, Math.floor(n / 20000));
    const k = Math.floor(n / stride);
    samples = new Float32Array(rnd.length + k * 3);
    samples.set(rnd, 0);
    for (let i = 0; i < k; i++) {
      samples[rnd.length + i * 3] = framePixels[i * stride * 3];
      samples[rnd.length + i * 3 + 1] = framePixels[i * stride * 3 + 1];
      samples[rnd.length + i * 3 + 2] = framePixels[i * stride * 3 + 2];
    }
  }
  const coarse = bakeLut(fn, LUT_DEFAULT_SIZE);
  const t1 = selfTestLut(coarse, fn, samples);
  if (t1.p99_de <= LUT_SELFTEST_P99_LIMIT) return { lut: coarse, selftest: t1 };
  const fine = bakeLut(fn, LUT_FINE_SIZE);
  return { lut: fine, selftest: selfTestLut(fine, fn, samples) };
}

export function serializeCube(lut: Lut3D, title = "cuthol colour stage"): string {
  const lines: string[] = [`TITLE "${title.replace(/"/g, "'")}"`, `LUT_3D_SIZE ${lut.size}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
  const d = lut.data;
  for (let i = 0; i < d.length; i += 3) {
    lines.push(`${d[i].toFixed(6)} ${d[i + 1].toFixed(6)} ${d[i + 2].toFixed(6)}`);
  }
  return lines.join("\n") + "\n";
}

export function writeCube(lut: Lut3D, file: string, title?: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, serializeCube(lut, title));
  fs.renameSync(tmpFile, file);
}

/** Parses a `.cube` 3D LUT (DOMAIN_MIN/MAX honoured by rescaling the input). Throws on malformed files. */
export function parseCube(text: string): Lut3D & { domainMin: Px; domainMax: Px } {
  let size = 0;
  let domainMin: Px = [0, 0, 0];
  let domainMax: Px = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    const up = s.toUpperCase();
    if (up.startsWith("LUT_3D_SIZE")) size = parseInt(s.split(/\s+/)[1], 10);
    else if (up.startsWith("DOMAIN_MIN")) domainMin = s.split(/\s+/).slice(1, 4).map(Number) as Px;
    else if (up.startsWith("DOMAIN_MAX")) domainMax = s.split(/\s+/).slice(1, 4).map(Number) as Px;
    else if (/^[A-Z_]/.test(up)) continue;
    else {
      const parts = s.split(/\s+/);
      if (parts.length < 3) throw new Error(`malformed LUT row '${s}'`);
      vals.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
    }
  }
  if (!(size >= 2 && size <= 256)) throw new Error(`LUT_3D_SIZE missing or out of range (${size})`);
  if (vals.length !== size * size * size * 3) {
    throw new Error(`expected ${size ** 3} rows, found ${vals.length / 3}`);
  }
  if (vals.some((v) => !Number.isFinite(v))) throw new Error("non-numeric LUT value");
  return { size, data: Float32Array.from(vals), domainMin, domainMax };
}

export function readCube(file: string): Lut3D & { domainMin: Px; domainMax: Px } {
  return parseCube(fs.readFileSync(file, "utf8"));
}

/** Pixel function of a parsed `.cube` (domain rescale + tetrahedral sampling). */
export function cubePixelFunction(cube: Lut3D & { domainMin?: Px; domainMax?: Px }): (p: Px) => void {
  const lo = cube.domainMin ?? [0, 0, 0];
  const hi = cube.domainMax ?? [1, 1, 1];
  const identityDomain = lo.every((v) => v === 0) && hi.every((v) => v === 1);
  return (p: Px) => {
    if (!identityDomain) for (let c = 0; c < 3; c++) p[c] = (p[c] - lo[c]) / (hi[c] - lo[c] || 1);
    sampleLutTetra(cube, p);
  };
}

/** Stable content hash (sorted-key JSON) for blob caching of compiled stages. */
export function stableHash(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) o[k] = norm(x);
      }
      return o;
    }
    return v;
  };
  return crypto.createHash("sha256").update(JSON.stringify(norm(value))).digest("hex").slice(0, 16);
}

/** Where a compiled stage LUT lives inside a project: `.cuthol/blobs/color/<hash>.cube`. */
export function colorLutBlobPath(rootDir: string, hash: string): string {
  return path.join(rootDir, ".cuthol", "blobs", "color", `${hash}.cube`);
}
