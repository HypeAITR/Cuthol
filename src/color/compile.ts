// Colour stage compiler: stage (+ Look, + envelopes) to ffmpeg filters (owner: render).
//
// One stage = one LUT from `lut.ts`. A static stage compiles to a single `lut3d` on explicit
// `gbrp16le` (measured 99 fps at 1080p on this machine); a stage with keyframed colour envelopes
// bakes one CLUT per distinct value set and feeds them with `haldclut` as a frame sequence
// aligned to the item's time. Projects without `color` fields return [] everywhere, so their
// render plans stay byte-identical.
//
// Contract: returns [] when the item has no effective colour stage, so projects without `color` fields render
// exactly as before.
import fs from "node:fs";
import path from "node:path";
import type { CutholSequence } from "../core/schema.js";
import type { ParameterEnvelope } from "../core/schema.js";
import { CutholError, DIAGNOSTICS, type CutholDiagnostic } from "../core/diagnostics.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import {
  compileLut,
  colorLutBlobPath,
  stableHash,
  writeCube,
  LUT_SELFTEST_P99_LIMIT,
  LUT_FINE_SIZE,
  type LutSelfTest,
} from "./lut.js";
import {
  itemColorProgram,
  parseColorParam,
  withColorParam,
  type ColorItemRef,
} from "./blocks.js";
import { evaluateEnvelopeAt } from "../sequence/spine_envelope.js";
import { inputTransformFilters } from "./input_transform.js";

type LibraryAsset = CutholSequence["library"][number];

/** Compiled LUT info of one item, shared with Live and the render-free prediction path. */
export interface ColorLutInfo {
  hash: string;
  file: string;
  size: number;
  selftest: LutSelfTest;
}

/** Largest keyframed colour frame count cached per item (G442 reports the number). */
export const MAX_COLOR_KEYFRAMED_FRAMES = 9000;
/** Hald CLUT level for the baked envelope frames (level 8 = 64 steps per channel). */
export const COLOR_HALD_LEVEL = 8;

export interface ColorCompileItem {
  item: ColorItemRef;
  asset: LibraryAsset;
  /** Colour envelopes of the clip/cue (spine `clip.envelopes`, lane `cue.envelopes`). */
  envelopes: ParameterEnvelope[];
  /** Output frame rate of the render. */
  fps: number;
  /** Item duration on the timeline. */
  durationMs: number;
  /** True when the pixels at this stage are RGB(A) rather than YUV. */
  isRgb: boolean;
  /** Pixel format to return to after the stage (input domain of the next stage). */
  backFormat: string;
  /** Range of the YUV pixels at this stage (`tv` after the source scale filter). */
  srcRange: "tv" | "pc";
}

export interface ColorCompileHost {
  rootDir: string;
  addInput: (args: string[]) => number;
  /** Collected render warnings; when omitted the WARN diagnostic goes to stderr. */
  warnings?: CutholDiagnostic[];
}

/** The compiled LUT info of an item at its static values (`{hash, file, size, selftest}`) or null. */
export function compiledColorLutInfo(
  seq: CutholSequence,
  rootDir: string,
  item: ColorItemRef
): ColorLutInfo | null {
  let program: ReturnType<typeof itemColorProgram>;
  try {
    program = itemColorProgram(seq, rootDir, item);
  } catch (err) {
    throw new CutholError(
      DIAGNOSTICS.COLOR_LOOK_LUT_UNREADABLE(item.id, lookPathOf(item), shortReason(err))
    );
  }
  if (program.identity) return null;
  return ensureStaticLut(rootDir, program, undefined);
}

function lookPathOf(item: ColorItemRef): string {
  const uri = (item.stage as { look?: { lut_uri?: string } } | undefined)?.look;
  return typeof uri === "string" ? uri : (item.stage as { look?: { id?: string } })?.look?.id ?? "(look)";
}

function shortReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 160 ? `${msg.slice(0, 160)}...` : msg;
}

function emitWarn(host: ColorCompileHost | undefined, d: CutholDiagnostic): void {
  if (host?.warnings) {
    host.warnings.push(d);
    return;
  }
  console.warn(d.formatted);
}

function ensureStaticLut(
  rootDir: string,
  program: ReturnType<typeof itemColorProgram>,
  warnings: CutholDiagnostic[] | undefined,
  itemId = ""
): ColorLutInfo {
  const compiled = compileLut(program.fn);
  const hash = stableHash({ program: program.hashInput, size: compiled.lut.size });
  const file = colorLutBlobPath(rootDir, hash);
  if (!fs.existsSync(file)) writeCube(compiled.lut, file);
  if (compiled.lut.size >= LUT_FINE_SIZE && compiled.selftest.p99_de > LUT_SELFTEST_P99_LIMIT) {
    const d = DIAGNOSTICS.COLOR_LUT_SELFTEST_ABOVE_LIMIT(itemId, compiled.selftest.p99_de);
    if (warnings) warnings.push(d);
    else console.warn(d.formatted);
  }
  return { hash, file, size: compiled.lut.size, selftest: compiled.selftest };
}

/**
 * ffmpeg filters of one item's colour stage, appended after the existing `color_grade` filters.
 * Static stages compile to a single `lut3d`; keyframed colour envelopes bake one CLUT per
 * distinct value set and feed them with `haldclut` as a frame sequence aligned to the item.
 */
export function compileColorStageFilters(
  seq: CutholSequence,
  host: ColorCompileHost,
  req: ColorCompileItem
): string[] {
  const colorEnvs = req.envelopes.filter((e) => parseColorParam(e.parameter) !== null);
  if (colorEnvs.length === 0) return compileStaticStageFilters(seq, host, req);
  return compileKeyframedStageFilters(seq, host, req, colorEnvs);
}

/**
 * `lut3d` runs on planar 16-bit RGB (fastest). `haldclut` must get PACKED RGB: with a planar main
 * input (gbrp/gbrp16le) ffmpeg 8.1 maps the CLUT channels in the wrong order (red and blue swap).
 */
function pixelPathPrefix(req: ColorCompileItem, packed = false): { head: string; back: string } {
  const alpha = alphaCapable(req.asset);
  const wide = packed ? (alpha ? "rgba64le" : "rgb48le") : alpha ? "gbrap16le" : "gbrp16le";
  const range = req.isRgb ? "pc" : req.srcRange;
  return {
    head: `scale=in_color_matrix=bt709:in_range=${range},format=${wide}`,
    back: `scale=out_color_matrix=bt709:out_range=tv,format=${req.backFormat}`,
  };
}

function alphaCapable(asset: LibraryAsset): boolean {
  return (asset.probe.pix_fmt ?? "").toLowerCase().includes("a");
}

function compileStaticStageFilters(
  seq: CutholSequence,
  host: ColorCompileHost,
  req: ColorCompileItem
): string[] {
  let program: ReturnType<typeof itemColorProgram>;
  try {
    program = itemColorProgram(seq, host.rootDir, req.item);
  } catch (err) {
    throw new CutholError(
      DIAGNOSTICS.COLOR_LOOK_LUT_UNREADABLE(req.item.id, lookPathOf(req.item), shortReason(err))
    );
  }
  if (program.identity) return [];
  const info = ensureStaticLut(host.rootDir, program, host.warnings, req.item.id);
  const { head, back } = pixelPathPrefix(req);
  const rel = path
    .relative(path.resolve(host.rootDir), info.file)
    .replace(/\\/g, "/");
  return [`${head},lut3d=file='${escapeCubePath(rel)}',${back}`];
}

function compileKeyframedStageFilters(
  seq: CutholSequence,
  host: ColorCompileHost,
  req: ColorCompileItem,
  colorEnvs: ParameterEnvelope[]
): string[] {
  const fps = Math.max(1, req.fps);
  const frames = Math.max(1, Math.round((req.durationMs / 1000) * fps));
  if (frames > MAX_COLOR_KEYFRAMED_FRAMES) {
    throw new CutholError(
      DIAGNOSTICS.COLOR_ENVELOPE_TOO_MANY_FRAMES(req.item.id, frames, MAX_COLOR_KEYFRAMED_FRAMES)
    );
  }
  // Sample every envelope on the output frame grid; runs of equal value sets share one CLUT.
  const frameHashes: string[] = [];
  const programs = new Map<string, ReturnType<typeof itemColorProgram>>();
  for (let k = 0; k < frames; k++) {
    const tMs = (k * 1000) / fps;
    let stage = req.item.stage;
    for (const env of colorEnvs) {
      const v = evaluateEnvelopeAt(env, tMs);
      stage = withColorParam(stage, env.parameter, Math.round(v * 1e4) / 1e4);
    }
    let program: ReturnType<typeof itemColorProgram>;
    try {
      program = itemColorProgram(seq, host.rootDir, { ...req.item, stage });
    } catch (err) {
      throw new CutholError(
        DIAGNOSTICS.COLOR_LOOK_LUT_UNREADABLE(req.item.id, lookPathOf(req.item), shortReason(err))
      );
    }
    const hash = stableHash({ program: program.hashInput });
    if (!programs.has(hash)) programs.set(hash, program);
    frameHashes.push(hash);
  }
  const lutFiles = new Map<string, string>();
  for (const [hash, program] of programs) {
    const info = ensureStaticLut(host.rootDir, program, host.warnings, req.item.id);
    lutFiles.set(hash, info.file);
  }
  const clutDir = ensureClutSequence(host.rootDir, req.item.id, frameHashes, lutFiles);
  const clutIdx = host.addInput([
    "-framerate",
    String(fps),
    "-start_number",
    "1",
    "-i",
    path.join(clutDir, "frame_%06d.png"),
  ]);
  const { head, back } = pixelPathPrefix(req, true);
  // One array element holding an interior `;`: the caller joins the chain with `,`, so this
  // element ends the input chain at an intermediate pad and reopens it with the CLUT stream.
  // The pad name is unique per item (the graph is global to the render).
  const pad = `cs_${req.item.id.replace(/[^A-Za-z0-9_]/g, "_")}`;
  return [`${head}[${pad}];[${pad}][${clutIdx}:v]haldclut,${back}`];
}

/**
 * Materializes one Hald CLUT PNG per output frame (deduplicated by hash) under
 * `.cuthol/blobs/color/<item>-clut/` and returns the directory. Each distinct value set bakes
 * its `.cube` once, converts it once with `haldclutsrc` + `lut3d`, then repeats by copy.
 */
function ensureClutSequence(
  rootDir: string,
  itemId: string,
  frameHashes: string[],
  lutFiles: Map<string, string>
): string {
  const dirHash = stableHash(frameHashes);
  const dir = path.join(rootDir, ".cuthol", "blobs", "color", `clut-${dirHash}`);
  const marker = path.join(dir, "complete");
  if (fs.existsSync(marker)) return dir;
  fs.mkdirSync(dir, { recursive: true });
  const distinct = [...new Set(frameHashes)];
  const clutPng = new Map<string, string>();
  for (const hash of distinct) {
    const png = path.join(dir, `hald-${hash}.png`);
    if (!fs.existsSync(png)) renderHaldPng(lutFiles.get(hash)!, png, itemId);
    clutPng.set(hash, png);
  }
  frameHashes.forEach((hash, k) => {
    const dst = path.join(dir, `frame_${String(k + 1).padStart(6, "0")}.png`);
    if (!fs.existsSync(dst)) fs.copyFileSync(clutPng.get(hash)!, dst);
  });
  fs.writeFileSync(marker, `${distinct.length}/${frameHashes.length}\n`);
  return dir;
}

function renderHaldPng(cubeFile: string, pngFile: string, itemId: string): void {
  const rel = path.relative(process.cwd(), cubeFile).replace(/\\/g, "/");
  const proc = spawnWatchedSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `haldclutsrc=level=${COLOR_HALD_LEVEL}`,
      "-vf",
      `lut3d=file='${escapeCubePath(rel)}'`,
      "-frames:v",
      "1",
      "-y",
      pngFile,
    ],
    { encoding: "utf8", step: "colour hald clut", cwd: process.cwd() }
  );
  if (proc.status !== 0 || proc.error) {
    throw new CutholError(
      DIAGNOSTICS.COLOR_HALD_RENDER_FAILED(
        itemId,
        (proc.stderr || proc.error?.message || "ffmpeg failed").trim()
      )
    );
  }
}

function escapeCubePath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
}

export { inputTransformFilters };
