// Frame sampling for colour measurement (owner: measurement). Decodes an item's source frames through the
// input transform, BT.709 to encoded RGB, downscaled; optionally after the colour stage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnWatchedSync } from "../core/subprocess.js";
import { loadSequence } from "../core/workspace.js";
import { itemColorProgram, listColorItems } from "./blocks.js";
import type { ColorFrameSet } from "./types.js";
import type { CutholSequence } from "../core/schema.js";
import { probeStandaloneVideoColorMetadata, resolveSourceColorSpec } from "../library/probe.js";
import { buildSourceScaleFilter } from "../compositor/compile_color.js";
import { inputTransformFilters } from "./input_transform.js";

export interface SampleItemFramesOptions {
  workspaceDir: string;
  /** Spine clip or lane cue id. */
  itemId: string;
  /** Number of frames spread over the item (default 7; 5..9). Ignored when `atMs` is given. */
  count?: number;
  /** Item-local instants to sample. */
  atMs?: number[];
  /** Output width in pixels (default 256; height keeps the aspect). */
  width?: number;
  /** `source` = before the colour stage (default), `graded` = after it (the item's compiled LUT applied). */
  stage?: "source" | "graded";
}

interface ItemMedia {
  file: string;
  startMs: number;
  durationMs: number;
  fps: number;
  asset?: CutholSequence["library"][number];
}

function probeDurationMs(file: string): number {
  const r = spawnWatchedSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
    encoding: "utf8",
    windowsHide: true,
  });
  const s = String(r.stdout ?? "").trim();
  const v = Number(s);
  return Number.isFinite(v) && v > 0 ? v * 1000 : 10000;
}

function resolveItemMedia(workspaceDir: string, itemId: string): ItemMedia {
  const seq = loadSequence(workspaceDir).sequence;
  const clips = seq.spine.clips;
  const clipIdx = clips.findIndex((c: any) => c.id === itemId);
  let assetHandle: string | undefined;
  let startMs = 0;
  let durationMs = 0;
  if (clipIdx >= 0) {
    const c = clips[clipIdx];
    assetHandle = c.asset_handle;
    startMs = c.source_in_ms ?? 0;
    durationMs = c.duration_ms;
  } else {
    for (const lane of seq.lanes) {
      const cue = lane.cues.find((q: any) => q.id === itemId);
      if (cue) {
        assetHandle = cue.asset_handle;
        startMs = cue.source_in_ms ?? 0;
        durationMs = cue.duration_ms || 5000;
        break;
      }
    }
  }
  if (!assetHandle) throw new Error(`unknown item '${itemId}'`);
  const asset = seq.library.find((a: any) => a.handle === assetHandle);
  const uri = (asset as { uri?: string } | undefined)?.uri ?? assetHandle;
  const file = path.isAbsolute(uri) ? uri : path.join(workspaceDir, uri);
  if (!fs.existsSync(file)) throw new Error(`asset file missing '${file}'`);
  const dur = probeDurationMs(file);
  if (!(durationMs > 0)) durationMs = dur;
  return { file, startMs, durationMs, fps: 30, asset: asset as CutholSequence["library"][number] | undefined };
}

/**
 * Decode one frame at `atSec` (absolute media seconds) to rgb24 raw at `width` px wide, through the same colour
 * path as the render: input transform (HDR to SDR), the source's own matrix and range to BT.709 TV range, then
 * BT.709 to full-range RGB. `asset` gives the probe of a library item; files outside the library are probed.
 */
export function decodeFrameRgb24(
  file: string,
  atSec: number,
  width: number,
  asset?: CutholSequence["library"][number]
): { width: number; height: number; data: Buffer } {
  const tmp = path.join(os.tmpdir(), `cuthol-frame-${process.pid}-${Math.round(Math.random() * 1e9)}.raw`);
  const colorProbe = asset?.probe ?? probeStandaloneVideoColorMetadata(file);
  const spec = resolveSourceColorSpec(colorProbe, file);
  const pre = asset ? inputTransformFilters(asset) : [];
  const vf = [
    ...pre,
    spec.isRgb
      ? `scale=${width}:-2`
      : `${buildSourceScaleFilter(width, -2, spec)},scale=in_color_matrix=bt709:in_range=tv:out_range=full`,
  ].join(",");
  const r = spawnWatchedSync(
    "ffmpeg",
    ["-v", "error", "-y", "-i", file, "-ss", String(Math.max(0, atSec)), "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", tmp],
    { encoding: "buffer", windowsHide: true }
  );
  if (r.status !== 0) throw new Error(`ffmpeg frame decode failed for '${file}'`);
  const probe = spawnWatchedSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
    { encoding: "utf8", windowsHide: true }
  );
  const m = String(probe.stdout ?? "").trim().split(/[,\s]+/).map(Number);
  const srcW = m[0] || 16;
  const srcH = m[1] || 9;
  const h = Math.max(2, Math.round((srcH * width) / srcW / 2) * 2);
  const buf = fs.readFileSync(tmp);
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  const expect = width * h * 3;
  if (buf.length < expect) throw new Error(`short frame buffer ${buf.length} < ${expect}`);
  return { width, height: h, data: buf.subarray(0, expect) };
}

function toFrameSet(frames: Array<{ width: number; height: number; data: Buffer }>, atMs: number[], stage: "source" | "graded"): ColorFrameSet {
  const width = frames[0].width;
  const height = frames[0].height;
  return {
    width,
    height,
    at_ms: atMs,
    stage,
    frames: frames.map((f) => {
      const out = new Float32Array(f.data.length);
      for (let i = 0; i < f.data.length; i++) out[i] = f.data[i] / 255;
      return out;
    }),
  };
}

export function frameSetSamples(set: ColorFrameSet, maxPerFrame = 2048): Float32Array {
  const per = Math.min(maxPerFrame, Math.floor(set.frames[0].length / 3));
  const out = new Float32Array(set.frames.length * per * 3);
  let o = 0;
  for (const fr of set.frames) {
    const n = Math.floor(fr.length / 3);
    const step = Math.max(1, Math.floor(n / per));
    let taken = 0;
    for (let i = 0; i < n && taken < per; i += step, taken++) {
      out[o++] = fr[i * 3]; out[o++] = fr[i * 3 + 1]; out[o++] = fr[i * 3 + 2];
    }
  }
  return out.subarray(0, o);
}

function applyStageInPlace(set: ColorFrameSet, workspaceDir: string, itemId: string): void {
  const seq = loadSequence(workspaceDir).sequence;
  const item = listColorItems(seq).find((c: any) => c.id === itemId);
  if (!item) throw new Error(`unknown item '${itemId}'`);
  const { fn } = itemColorProgram(seq, workspaceDir, item);
  const p: [number, number, number] = [0, 0, 0];
  for (const fr of set.frames) {
    for (let i = 0; i < fr.length; i += 3) {
      p[0] = fr[i]; p[1] = fr[i + 1]; p[2] = fr[i + 2];
      fn(p);
      fr[i] = p[0]; fr[i + 1] = p[1]; fr[i + 2] = p[2];
    }
  }
}

export function sampleItemFrames(opts: SampleItemFramesOptions): ColorFrameSet {
  const width = Math.max(32, Math.min(512, Math.round(opts.width ?? 256)));
  const stage = opts.stage ?? "source";
  const media = resolveItemMedia(opts.workspaceDir, opts.itemId);
  let locals: number[];
  if (opts.atMs && opts.atMs.length > 0) locals = [...opts.atMs];
  else {
    const count = Math.max(5, Math.min(9, Math.round(opts.count ?? 7)));
    locals = [];
    for (let i = 0; i < count; i++) {
      const f = 0.05 + (0.9 * i) / Math.max(1, count - 1);
      locals.push(f * media.durationMs);
    }
  }
  const decoded = locals.map((lm) => decodeFrameRgb24(media.file, (media.startMs + lm) / 1000, width, media.asset));
  const set = toFrameSet(decoded, locals, "source");
  if (stage === "graded") {
    applyStageInPlace(set, opts.workspaceDir, opts.itemId);
    set.stage = "graded";
  }
  return set;
}

/** Frames of a reference file outside the timeline: an image (one frame) or a video (`count` frames). */
export function loadReferenceFrames(file: string, opts?: { width?: number; count?: number }): ColorFrameSet {
  const width = Math.max(32, Math.min(1920, Math.round(opts?.width ?? 256)));
  const ext = path.extname(file).toLowerCase();
  const isImage = [".png", ".jpg", ".jpeg", ".webp", ".bmp"].includes(ext);
  if (isImage) {
    const f = decodeFrameRgb24(file, 0, width);
    return toFrameSet([f], [0], "source");
  }
  const dur = probeDurationMs(file);
  const count = Math.max(5, Math.min(9, Math.round(opts?.count ?? 7)));
  const atMs: number[] = [];
  for (let i = 0; i < count; i++) atMs.push(((0.05 + (0.9 * i) / Math.max(1, count - 1)) * dur));
  const decoded = atMs.map((m) => decodeFrameRgb24(file, m / 1000, width));
  return toFrameSet(decoded, atMs, "source");
}
