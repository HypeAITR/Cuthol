// Post-render colour check: rendered frames against the render-free prediction.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSequence } from "../core/workspace.js";
import { resolveCueStartMs } from "../core/timeline.js";
import { runWatchedParallelFfmpegJobsSync, spawnWatchedSync, type ParallelFfmpegJob } from "../core/subprocess.js";
import { DIAGNOSTICS, type CutholDiagnostic } from "../core/diagnostics.js";
import type { CutholSequence, ParameterEnvelope } from "../core/schema.js";
import {
  itemColorProgram,
  listColorItems,
  parseColorParam,
  withColorParam,
  type ColorItemRef,
} from "./blocks.js";
import { deltaE2000, rgbToLab } from "./math.js";
import { evaluateEnvelopeAt } from "../sequence/spine_envelope.js";
import { probeStandaloneVideoColorMetadata, resolveSourceColorSpec } from "../library/probe.js";
import { buildSourceScaleFilter } from "../compositor/compile_color.js";
import { inputTransformFilters } from "./input_transform.js";

/** Width both the source and the rendered frame decode to (keeps the check under 2 s). */
const CHECK_WIDTH = 128;
/** Mean dE above which the render is reported as not matching the prediction. */
const MISMATCH_MEAN_DE = 3;
/** Normal render/encode floor measured on camera footage (mean ~0.6, p99 ~3.2). */
const NORMAL_FLOOR_NOTE = "0.6-1.5 is normal";
/** Margin kept from cuts and transitions when picking probe instants. */
const EDGE_MARGIN_MS = 400;

interface ProbeInstant {
  /** Item-local ms. */
  localMs: number;
  /** Timeline ms of the same instant. */
  timelineMs: number;
  /** Pixel function of the stage with envelopes evaluated at this instant. */
  fn: (p: [number, number, number]) => void;
  /** True when the stage (with envelopes) is a no-op at this instant. */
  identity: boolean;
}

function clipSpanOf(seq: CutholSequence, item: ColorItemRef): { startMs: number; durationMs: number; envelopes: ParameterEnvelope[] } | null {
  if (item.track === "spine") {
    const idx = seq.spine.clips.findIndex((c) => c.id === item.id);
    if (idx < 0) return null;
    return {
      startMs: seq.spine.clips[idx].timeline_in_ms,
      durationMs: seq.spine.clips[idx].duration_ms,
      envelopes: seq.spine.clips[idx].envelopes,
    };
  }
  for (const lane of seq.lanes) {
    const cue = lane.cues.find((q) => q.id === item.id);
    if (cue) {
      return { startMs: resolveCueStartMs(seq, cue), durationMs: cue.duration_ms, envelopes: cue.envelopes };
    }
  }
  return null;
}

/** Timeline spans of visual overlay cues (compositions, captions, titles) that cover graded pixels. */
function overlaySpans(seq: CutholSequence): Array<{ startMs: number; endMs: number }> {
  const out: Array<{ startMs: number; endMs: number }> = [];
  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    if (lane.kind !== "composition" && lane.kind !== "caption" && lane.kind !== "title") continue;
    for (const cue of lane.cues) {
      const s = resolveCueStartMs(seq, cue);
      if (cue.duration_ms > 0) out.push({ startMs: s, endMs: s + cue.duration_ms });
    }
  }
  return out;
}

function transitionMarginMs(seq: CutholSequence, item: ColorItemRef): number {
  let margin = EDGE_MARGIN_MS;
  if (item.track !== "spine") return margin;
  const idx = seq.spine.clips.findIndex((c) => c.id === item.id);
  if (idx < 0) return margin;
  const out = seq.spine.clips[idx].transition_out?.duration_ms ?? 0;
  const prev = idx > 0 ? (seq.spine.clips[idx - 1].transition_out?.duration_ms ?? 0) : 0;
  return Math.max(margin, out, prev);
}

/** Two item-local instants away from cuts/transitions and outside covering overlay cues. */
function pickInstants(
  seq: CutholSequence,
  rootDir: string,
  item: ColorItemRef,
  startMs: number,
  durationMs: number,
  envelopes: ParameterEnvelope[]
): ProbeInstant[] {
  if (!(durationMs > 0)) return [];
  const margin = transitionMarginMs(seq, item);
  const overlays = overlaySpans(seq);
  const covered = (timelineMs: number): boolean =>
    overlays.some((sp) => timelineMs >= sp.startMs - 50 && timelineMs < sp.endMs + 50);
  const fractions = [0.3, 0.7, 0.5, 0.42, 0.58, 0.2, 0.8];
  const good: number[] = [];
  const fallback: number[] = [];
  for (const f of fractions) {
    const local = f * durationMs;
    if (local < margin || local > durationMs - margin) continue;
    if (covered(startMs + local)) {
      fallback.push(local);
      continue;
    }
    good.push(local);
    if (good.length >= 2) break;
  }
  const locals = (good.length >= 2 ? good : [...good, ...fallback]).slice(0, 2);
  if (locals.length === 0) {
    const mid = durationMs / 2;
    if (mid > 0) locals.push(mid);
  }
  return locals.map((localMs) => {
    let stage = item.stage;
    for (const env of envelopes) {
      if (parseColorParam(env.parameter) === null) continue;
      try {
        stage = withColorParam(stage, env.parameter, Math.round(evaluateEnvelopeAt(env, localMs) * 1e4) / 1e4);
      } catch {
        // Fall back to the static stage (see above).
      }
    }
    const program = itemColorProgram(seq, rootDir, { ...item, stage });
    return {
      localMs,
      timelineMs: startMs + localMs,
      fn: program.fn,
      identity: program.identity,
    };
  });
}

/** Geometry handling of one item: only default placement replicates the render's cover crop. */
function geometryModeOf(
  seq: CutholSequence,
  item: ColorItemRef,
  envelopes: ParameterEnvelope[]
): "default-cover" | "custom" {
  if (item.track !== "spine") return "custom";
  const clip = seq.spine.clips.find((c) => c.id === item.id);
  if (!clip) return "custom";
  const pl = clip.placement;
  const isDefault =
    pl.fit_mode === "cover" &&
    pl.crop === null &&
    !pl.mirror_x &&
    !pl.mirror_y &&
    pl.rotation_deg === 0 &&
    pl.x_pct === 0 &&
    pl.y_pct === 0 &&
    pl.scale_x === 1 &&
    pl.scale_y === 1;
  if (!isDefault) return "custom";
  // Animated geometry moves the crop window: do not replicate a moving frame.
  if (envelopes.some((e) => e.parameter.startsWith("placement."))) return "custom";
  return "default-cover";
}

/** On-disk media file of an item's source (mirrors `frames` item resolution). */
function mediaFileOf(seq: CutholSequence, rootDir: string, item: ColorItemRef): string | null {
  const asset = seq.library.find((a) => a.handle === item.asset_handle);
  const uri = asset?.uri ?? item.asset_handle;
  if (!uri) return null;
  const file = path.isAbsolute(uri) ? uri : path.join(rootDir, uri);
  return fs.existsSync(file) ? file : null;
}

/** Media offset (ms) where the item starts in its source file. */
function mediaStartMsOf(seq: CutholSequence, item: ColorItemRef): number {
  if (item.track === "spine") {
    return seq.spine.clips.find((c) => c.id === item.id)?.source_in_ms ?? 0;
  }
  for (const lane of seq.lanes) {
    const cue = lane.cues.find((q) => q.id === item.id);
    if (cue) return cue.source_in_ms ?? 0;
  }
  return 0;
}

/** Mean CIEDE2000 between a predicted frame and a rendered frame (stride-sampled pixels). */
export function meanDeltaEBetweenFrames(predicted: Float32Array, rendered: Float32Array): number {
  const n = Math.min(predicted.length, rendered.length) / 3;
  if (!(n >= 1)) return 0;
  const stride = Math.max(1, Math.floor(n / 2048));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i += stride) {
    const j = i * 3;
    sum += deltaE2000(
      rgbToLab(predicted[j], predicted[j + 1], predicted[j + 2]),
      rgbToLab(rendered[j], rendered[j + 1], rendered[j + 2])
    );
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

export interface RenderedColorItemResult {
  itemId: string;
  meanDe: number;
  /** Worst instant (timeline ms) and its mean, for the WARN message. */
  worstAtMs: number;
  worstDe: number;
  instants: number;
}

/**
 * Compares the render against the render-free prediction: for every item with an effective
 * colour stage, two instants away from cuts/transitions and covering cues are decoded from
 * the source (stage `source`) and from the render at the matching timeline time (same width,
 * same BT.709 path), the item's pixel function (envelopes evaluated per instant) is applied
 * to the source frame, and the mean CIEDE2000 is reported per item.
 */
/**
 * One frame to decode: the identical colour path `frames.decodeFrameRgb24` uses (input
 * transform, source matrix/range to BT.709 TV, BT.709 to full-range RGB), run through the
 * parallel ffmpeg runner so a multi-item check stays under 2 s.
 */
interface CheckFrameJob {
  key: string;
  file: string;
  atSec: number;
  width: number;
  assetHandle: string | undefined;
  tmp: string;
}

/** BT.709 frame-decode filter chain of one file (mirrors `frames.decodeFrameRgb24`). */
function checkFrameVf(
  width: number,
  file: string,
  asset: CutholSequence["library"][number] | undefined
): string {
  const colorProbe = asset?.probe ?? probeStandaloneVideoColorMetadata(file);
  const spec = resolveSourceColorSpec(colorProbe, file);
  const pre = asset ? inputTransformFilters(asset) : [];
  return [
    ...pre,
    spec.isRgb
      ? `scale=${width}:-2`
      : `${buildSourceScaleFilter(width, -2, spec)},scale=in_color_matrix=bt709:in_range=tv:out_range=full`,
  ].join(",");
}

/** Decoded height of a `width`-wide frame from probed stream dimensions. */
function checkFrameHeight(srcW: number, srcH: number, width: number): number {
  return Math.max(2, Math.round(((srcH || 9) * width) / (srcW || 16) / 2) * 2);
}

/**
 * Decodes every job's frame in parallel (one ffmpeg process each, same seeking and filters
 * as a single decode) and reads the raw buffers back. Jobs that fail decode are absent
 * from the returned map; the caller skips those instants.
 */
function decodeCheckFrames(
  seq: CutholSequence,
  jobs: CheckFrameJob[]
): Map<string, { width: number; height: number; data: Buffer }> {
  const out = new Map<string, { width: number; height: number; data: Buffer }>();
  if (jobs.length === 0) return out;
  const assets = new Map<string, CutholSequence["library"][number]>();
  for (const a of seq.library) {
    if (a.handle) assets.set(a.handle, a);
  }
  const ffJobs: ParallelFfmpegJob[] = [];
  const maxBuffers: number[] = [];
  const meta = new Map<string, { height: number; expect: number; asset: CutholSequence["library"][number] | undefined }>();
  for (const job of jobs) {
    const asset = job.assetHandle ? assets.get(job.assetHandle) : undefined;
    let vf: string;
    try {
      vf = checkFrameVf(job.width, job.file, asset);
    } catch {
      continue;
    }
    const probe = asset?.probe;
    const srcW = probe?.width ?? 0;
    const srcH = probe?.height ?? 0;
    let height: number;
    if (srcW > 0 && srcH > 0) {
      height = checkFrameHeight(srcW, srcH, job.width);
    } else {
      // Outside the library (the rendered file): one ffprobe for dimensions.
      try {
        const p = spawnWatchedSync(
          "ffprobe",
          ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", job.file],
          { encoding: "utf8", windowsHide: true }
        );
        const m = String(p.stdout ?? "").trim().split(/[,\s]+/).map(Number);
        height = checkFrameHeight(m[0] || 16, m[1] || 9, job.width);
      } catch {
        continue;
      }
    }
    meta.set(job.key, { height, expect: job.width * height * 3, asset });
    ffJobs.push({
      args: [
        "-v", "error", "-y", "-i", job.file, "-ss", String(Math.max(0, job.atSec)),
        "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", job.tmp,
      ],
      cwd: process.cwd(),
      step: "colour render check frame",
    });
    maxBuffers.push(1024);
  }
  if (ffJobs.length === 0) return out;
  let res: ReturnType<typeof runWatchedParallelFfmpegJobsSync>;
  try {
    res = runWatchedParallelFfmpegJobsSync(ffJobs, maxBuffers);
  } catch {
    return out;
  }
  const keys = [...meta.keys()];
  res.forEach((r, i) => {
    const key = keys[i];
    const m = meta.get(key);
    try {
      if (r.status !== 0 || r.error) return;
      const job = jobs.find((j) => j.key === key)!;
      const buf = fs.readFileSync(job.tmp);
      if (buf.length < (m?.expect ?? 0)) return;
      out.set(key, { width: job.width, height: m!.height, data: buf.subarray(0, m!.expect) });
    } catch {
      // Missing or short buffer: the instant is skipped.
    } finally {
      try { fs.unlinkSync(jobs.find((j) => j.key === key)!.tmp); } catch { /* ignore */ }
    }
  });
  return out;
}

export function checkRenderedColor(opts: { workspaceDir: string; renderedFile: string }): CutholDiagnostic[] {
  if (!fs.existsSync(opts.renderedFile)) return [];
  let seq: CutholSequence;
  try {
    seq = loadSequence(opts.workspaceDir).sequence;
  } catch {
    return [];
  }
  const results: RenderedColorItemResult[] = [];
  const skipped: string[] = [];
  const noteSkip = (id: string): void => {
    if (!skipped.includes(id)) skipped.push(id);
  };
  interface PlannedItem {
    item: ColorItemRef;
    instants: ProbeInstant[];
    geo: "default-cover" | "custom";
    mediaFile: string | null;
  }
  const planned: PlannedItem[] = [];
  try {
    for (const item of listColorItems(seq)) {
      const span = clipSpanOf(seq, item);
      if (!span) continue;
      // Identity is judged per instant: a keyframed stage can be a no-op at its
      // static values (e.g. a stage carried only by envelopes) yet graded elsewhere.
      const hasColorEnv = span.envelopes.some((e) => parseColorParam(e.parameter) !== null);
      if (!hasColorEnv) {
        try {
          if (itemColorProgram(seq, opts.workspaceDir, item).identity) continue;
        } catch {
          continue;
        }
      }
      const instants = pickInstants(seq, opts.workspaceDir, item, span.startMs, span.durationMs, span.envelopes).filter(
        (p) => !p.identity
      );
      if (instants.length === 0) {
        noteSkip(item.id);
        continue;
      }
      planned.push({
        item,
        instants,
        geo: geometryModeOf(seq, item, span.envelopes),
        mediaFile: mediaFileOf(seq, opts.workspaceDir, item),
      });
    }
    if (planned.length === 0) {
      if (skipped.length === 0) return [];
      return [DIAGNOSTICS.COLOR_RENDER_GRADE_OK(`no comparable instants; skipped ${skipped.join(", ")} (geometry)`)];
    }
    // Every instant on both sides decodes in one parallel batch (sync API).
    const jobs: CheckFrameJob[] = [];
    for (const pl of planned) {
      pl.instants.forEach((inst, k) => {
        if (pl.mediaFile) {
          jobs.push({
            key: `src:${pl.item.id}:${k}`,
            file: pl.mediaFile,
            atSec: Math.max(0, (mediaStartMsOf(seq, pl.item) + inst.localMs) / 1000),
            width: CHECK_WIDTH,
            assetHandle: pl.item.asset_handle,
            tmp: path.join(os.tmpdir(), `cuthol-rc-${process.pid}-${pl.item.id}-${k}-src.raw`),
          });
        }
        jobs.push({
          key: `rend:${pl.item.id}:${k}`,
          file: opts.renderedFile,
          atSec: Math.max(0, inst.timelineMs / 1000),
          width: CHECK_WIDTH,
          assetHandle: undefined,
          tmp: path.join(os.tmpdir(), `cuthol-rc-${process.pid}-${pl.item.id}-${k}-rend.raw`),
        });
      });
    }
    const frames = decodeCheckFrames(seq, jobs);
    for (const pl of planned) {
      let sum = 0;
      let worstDe = -1;
      let worstAt = 0;
      let used = 0;
      const p: [number, number, number] = [0, 0, 0];
      for (let k = 0; k < pl.instants.length; k++) {
        let src = frames.get(`src:${pl.item.id}:${k}`);
        const rend = frames.get(`rend:${pl.item.id}:${k}`);
        if (!src || !rend) continue;
        if (rend.width !== CHECK_WIDTH || src.width !== CHECK_WIDTH) continue;
        let srcData = src.data;
        if (rend.data.length / 3 !== srcData.length / 3) {
          // Portrait source in a landscape stage (or vice versa): the render covers
          // and center-crops. Replicate that only for default placement; anything
          // moved, scaled, rotated or cropped is skipped instead of miscompared.
          if (pl.geo !== "default-cover") continue;
          const wantH = rend.data.length / 3 / rend.width;
          const haveH = Math.round(srcData.length / 3 / src.width);
          const h = Math.round(wantH);
          if (!(h >= 8) || h > haveH) continue;
          const top = Math.floor((haveH - h) / 2);
          srcData = srcData.subarray(top * src.width * 3, (top + h) * src.width * 3);
          if (rend.data.length / 3 !== srcData.length / 3) continue;
        }
        const predicted = new Float32Array(srcData.length);
        for (let i = 0; i < srcData.length; i += 3) {
          p[0] = srcData[i] / 255; p[1] = srcData[i + 1] / 255; p[2] = srcData[i + 2] / 255;
          pl.instants[k].fn(p);
          predicted[i] = p[0]; predicted[i + 1] = p[1]; predicted[i + 2] = p[2];
        }
        const rendered = new Float32Array(srcData.length);
        for (let i = 0; i < srcData.length; i++) rendered[i] = rend.data[i] / 255;
        const mean = meanDeltaEBetweenFrames(predicted, rendered);
        sum += mean;
        used += 1;
        if (mean > worstDe) {
          worstDe = mean;
          worstAt = Math.round(pl.instants[k].timelineMs);
        }
      }
      if (used === 0) {
        noteSkip(pl.item.id);
        continue;
      }
      results.push({ itemId: pl.item.id, meanDe: sum / used, worstAtMs: worstAt, worstDe, instants: used });
    }
  } catch {
    return [];
  }
  const skipNote = skipped.length > 0 ? `; skipped ${skipped.join(", ")} (geometry)` : "";
  const bad = results.filter((r) => r.meanDe > MISMATCH_MEAN_DE);
  if (bad.length > 0) {
    const warns = bad.map((r) =>
      DIAGNOSTICS.COLOR_RENDER_GRADE_MISMATCH(r.itemId, r.worstAtMs, Math.round(r.meanDe * 100) / 100)
    );
    if (skipNote) warns.push(DIAGNOSTICS.COLOR_RENDER_GRADE_OK(`no comparable instants${skipNote}`));
    return warns;
  }
  if (results.length === 0) {
    if (!skipNote) return [];
    return [DIAGNOSTICS.COLOR_RENDER_GRADE_OK(`no comparable instants${skipNote}`)];
  }
  const summary = results.map((r) => `${r.itemId} ${(Math.round(r.meanDe * 100) / 100).toFixed(2)}`).join(", ");
  return [DIAGNOSTICS.COLOR_RENDER_GRADE_OK(summary + skipNote)];
}
