// Post-render scans: blank/backdrop frames and edge strips (split out of renderer.ts).
import { progressBegin, progressFinish } from "../core/progress.js";
import {
  spawnWatchedSync
} from "../core/subprocess.js";
import {
  computeRenderDurationMs,
  findBackdropOnlySpans
} from "../core/timeline.js";
import {
  CutholDiagnostic, DIAGNOSTICS
} from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { evaluateRgb24FrameBlankness } from "../monitor/preview.js";
import { evaluateEnvelopeAt } from "../sequence/spine.js";

export interface BlankFrameEvent {
  start_frame: number;
  end_frame: number;
  frame_count: number;
  start_s: number;
  end_s: number;
  start_ms: number;
  end_ms: number;
  clip_id: string;
  luma_mean: number;
  backdrop_flat_ratio: number;
}

export interface PostRenderBlankScanResult {
  fps: number;
  total_frames: number;
  scan_duration_ms: number;
  events: BlankFrameEvent[];
  blank_frames_count: number;
  blank_at_s: number[];
  diagnostics: CutholDiagnostic[];
}

function isIntentionalFadeOrTransparentAtMs(
  seq: CutholSequence,
  clipIndex: number,
  tMs: number,
  frameDurMs: number
): boolean {
  const clip = seq.spine.clips[clipIndex];
  if (!clip) return false;
  const prevClip = clipIndex > 0 ? seq.spine.clips[clipIndex - 1] : null;
  const hasNextClip = clipIndex < seq.spine.clips.length - 1;

  const outTrans = clip.transition_out;
  if (outTrans && outTrans.duration_ms > 0 && (outTrans.kind === "fade" || !hasNextClip)) {
    const fadeStartMs = clip.timeline_in_ms + clip.duration_ms - outTrans.duration_ms - frameDurMs;
    if (tMs >= fadeStartMs) return true;
  }

  const inTrans = prevClip?.transition_out ?? null;
  if (inTrans && inTrans.duration_ms > 0 && inTrans.kind === "fade") {
    const fadeEndMs = clip.timeline_in_ms + inTrans.duration_ms + frameDurMs;
    if (tMs <= fadeEndMs) return true;
  }

  const localOffsetMs = Math.max(0, tMs - clip.timeline_in_ms);
  const opEnv = clip.envelopes.find((e) => e.parameter === "placement.opacity");
  const effectiveOpacity = opEnv
    ? evaluateEnvelopeAt(opEnv, localOffsetMs)
    : clip.placement.opacity;
  if (effectiveOpacity <= 0.2) return true;

  const brEnv = clip.envelopes.find((e) => e.parameter === "treatments.color_grade.brightness");
  const effectiveBrightness = brEnv
    ? evaluateEnvelopeAt(brEnv, localOffsetMs)
    : clip.treatments.color_grade.brightness;
  if (effectiveBrightness <= -0.8) return true;

  return false;
}

/**
 * Performs a fast post-render pass over `mp4Path` using downscaled nearest-neighbor RGB24 frames
 * to detect unintentional blank / backdrop-colored frames while a spine clip is active. In a spine-less
 * (graphics-only) sequence it checks the frames where no visual cue is on screen; `clip_id` is empty there.
 */
/**
 * Detects a black strip along the right or bottom edge of the render. Some ffmpeg builds zero the last
 * columns when converting planar RGB to yuv420p at widths that are not a multiple of 16 (e.g. 1080); the
 * opaque HyperFrames render path works around it by rewriting that conversion. This check keeps a
 * regression (for example after a HyperFrames update) from shipping silently. Samples a few frames and
 * compares the outer 8 px with the 8 px just inside.
 */
export function scanRenderedMp4ForEdgeStrips(
  mp4Path: string,
  durationMs: number,
  samples = 5
): CutholDiagnostic | null {
  const probe = spawnWatchedSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", mp4Path],
    { encoding: "utf8", step: "ffprobe edge strip scan" }
  );
  const [w, h] = String(probe.stdout || "").trim().split(",").map(Number);
  if (!(w > 32 && h > 32)) return null;

  progressBegin("edge scan", 1);
  try {
  const strip = 8;
  const regions = {
    right: { outer: `crop=${strip}:${h}:${w - strip}:0`, inner: `crop=${strip}:${h}:${w - 2 * strip}:0` },
    bottom: { outer: `crop=${w}:${strip}:0:${h - strip}`, inner: `crop=${w}:${strip}:0:${h - 2 * strip}` },
  };

  // Single-pass FFmpeg edge strip check across all `samples` timestamps x 4 edge/inner crops.
  // Falls back to the per-sample loop below if any sample timestamp is past EOF or if disabled via CUTHOL_EDGE_SCAN_ONEPASS=0.
  if (samples > 0 && process.env.CUTHOL_EDGE_SCAN_ONEPASS !== "0" && process.env.CUTHOL_EDGE_SCAN_ONEPASS !== "false") {
    const cropList = [
      regions.right.outer,
      regions.right.inner,
      regions.bottom.outer,
      regions.bottom.inner,
    ];
    const args: string[] = ["-v", "error"];
    for (let i = 0; i < samples; i++) {
      args.push("-ss", (((i + 0.5) / samples) * (durationMs / 1000)).toFixed(3), "-i", mp4Path);
    }
    const parts: string[] = [];
    const labels: string[] = [];
    for (let i = 0; i < samples; i++) {
      parts.push(
        `[${i}:v]trim=end_frame=1,split=4${cropList.map((_, k) => `[s${i}_${k}]`).join("")}`
      );
      cropList.forEach((c, k) => {
        parts.push(`[s${i}_${k}]${c},scale=1:1,format=gray[o${i}_${k}]`);
        labels.push(`[o${i}_${k}]`);
      });
    }
    parts.push(`${labels.join("")}hstack=inputs=${labels.length}[out]`);
    args.push(
      "-filter_complex",
      parts.join(";"),
      "-map",
      "[out]",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "pipe:1"
    );
    const one = spawnWatchedSync("ffmpeg", args, {
      maxBuffer: 1 << 20,
      step: "ffmpeg edge strip scan (one pass)",
    });
    const buf = one.stdout as Buffer;
    if (one.status === 0 && buf && buf.length >= labels.length) {
      const hitEdges: string[] = [];
      for (const [edge, base] of [
        ["right", 0],
        ["bottom", 2],
      ] as const) {
        let hits = 0;
        for (let i = 0; i < samples; i++) {
          if (buf[i * 4 + base] <= 4 && buf[i * 4 + base + 1] >= 24) {
            hits += 1;
          }
        }
        if (hits >= Math.max(2, Math.ceil(samples * 0.6))) {
          hitEdges.push(edge);
        }
      }
      return hitEdges.length > 0 ? DIAGNOSTICS.RENDER_EDGE_STRIP(hitEdges, w, h) : null;
    }
  }

  const meanLuma = (atSec: number, crop: string): number | null => {
    const proc = spawnWatchedSync(
      "ffmpeg",
      ["-v", "error", "-ss", atSec.toFixed(3), "-i", mp4Path, "-frames:v", "1", "-vf", `${crop},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
      { maxBuffer: 1024, step: "ffmpeg edge strip sample" }
    );
    const buf = proc.stdout as Buffer;
    return proc.status === 0 && buf && buf.length >= 1 ? buf[0] : null;
  };

  const affected: string[] = [];
  for (const [edge, crops] of Object.entries(regions)) {
    let hits = 0;
    let checked = 0;
    for (let i = 0; i < samples; i++) {
      const atSec = ((i + 0.5) / samples) * (durationMs / 1000);
      const outer = meanLuma(atSec, crops.outer);
      const inner = meanLuma(atSec, crops.inner);
      if (outer === null || inner === null) continue;
      checked += 1;
      if (outer <= 4 && inner >= 24) hits += 1;
    }
    if (checked > 0 && hits >= Math.max(2, Math.ceil(checked * 0.6))) affected.push(edge);
  }
  return affected.length > 0 ? DIAGNOSTICS.RENDER_EDGE_STRIP(affected, w, h) : null;
  } finally {
    progressFinish("edge scan");
  }
}

export function scanRenderedMp4ForBlankFrames(
  mp4Path: string,
  seq: CutholSequence,
  options?: { chunkFrames?: number }
): PostRenderBlankScanResult {
  const t0 = Date.now();
  const fps = Math.max(1, seq.stage.fps);
  const expectedFrames = Math.max(1, Math.round((computeRenderDurationMs(seq) / 1000) * fps));
  progressBegin("blank scan", expectedFrames, { mode: "ffmpeg-frames" });
  try {
  const frameDurMs = 1000 / fps;
  const scanW = 64;
  const scanH = 64;

  // Read the render in fixed-size chunks so memory stays bounded for long videos (hours of footage);
  // a single pipe of the whole file would exceed any fixed buffer.
  const frameBytes = scanW * scanH * 3;
  const chunkFrames = Math.max(1, options?.chunkFrames ?? 6000);
  const events: BlankFrameEvent[] = [];
  let blankFramesCount = 0;
  // Only non-empty for a spine-less sequence: the moments where no visual cue is on screen.
  const backdropOnlySpans = findBackdropOnlySpans(seq);
  const processFrame = (f: number, frameBuf: Buffer): void => {
    const tMs = (f * 1000) / fps;
    let activeClipIdx = -1;
    for (let i = 0; i < seq.spine.clips.length; i++) {
      const c = seq.spine.clips[i];
      if (tMs >= c.timeline_in_ms - 1e-3 && tMs < c.timeline_in_ms + c.duration_ms - 1e-3) {
        activeClipIdx = i;
        break;
      }
    }
    if (activeClipIdx >= 0) {
      if (isIntentionalFadeOrTransparentAtMs(seq, activeClipIdx, tMs, frameDurMs)) return;
    } else if (!backdropOnlySpans.some((sp) => tMs >= sp.start_ms - 1e-3 && tMs < sp.end_ms - 1e-3)) {
      // Spine-less frames drawn by a composition or graphic are not judged by brightness: designed dark
      // frames are common there and a composition that cannot render already stops the render (G503).
      return;
    }

    const ev = evaluateRgb24FrameBlankness(
      frameBuf,
      scanW,
      scanH,
      seq.stage.backdrop?.color
    );
    if (!ev.is_blank_frame) return;

    blankFramesCount += 1;
    const clipId = activeClipIdx >= 0 ? seq.spine.clips[activeClipIdx].id : "";
    const prev = events[events.length - 1];
    if (prev && prev.end_frame === f) {
      prev.end_frame = f + 1;
      prev.frame_count += 1;
      prev.end_s = Number(((f + 1) / fps).toFixed(3));
      prev.end_ms = Math.round(((f + 1) * 1000) / fps);
    } else {
      events.push({
        start_frame: f,
        end_frame: f + 1,
        frame_count: 1,
        start_s: Number((f / fps).toFixed(3)),
        end_s: Number(((f + 1) / fps).toFixed(3)),
        start_ms: Math.round((f * 1000) / fps),
        end_ms: Math.round(((f + 1) * 1000) / fps),
        clip_id: clipId,
        luma_mean: ev.luma_mean,
        backdrop_flat_ratio: ev.backdrop_flat_ratio,
      });
    }
  };

  let totalFrames = 0;
  for (let startFrame = 0; ; startFrame += chunkFrames) {
    const proc = spawnWatchedSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-threads",
        "0",
        "-ss",
        (startFrame / fps).toFixed(6),
        "-i",
        mp4Path,
        "-an",
        "-frames:v",
        String(chunkFrames),
        "-vf",
        `scale=${scanW}:${scanH}:flags=neighbor:in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24`,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      {
        maxBuffer: chunkFrames * frameBytes + 4 * 1024 * 1024,
        step: "ffmpeg blank frame scan",
      }
    );
    if (proc.status !== 0 || !proc.stdout) {
      if (startFrame === 0) {
        return {
          fps,
          total_frames: 0,
          scan_duration_ms: Date.now() - t0,
          events: [],
          blank_frames_count: 0,
          blank_at_s: [],
          diagnostics: [],
        };
      }
      break;
    }
    const chunkBuf = proc.stdout as Buffer;
    const got = Math.floor(chunkBuf.length / frameBytes);
    for (let i = 0; i < got; i++) {
      processFrame(startFrame + i, chunkBuf.subarray(i * frameBytes, (i + 1) * frameBytes));
    }
    totalFrames += got;
    if (got < chunkFrames) break;
  }


  const diagnostics: CutholDiagnostic[] =
    events.length > 0 ? [DIAGNOSTICS.RENDER_BLANK_FRAMES_DETECTED(events)] : [];

  return {
    fps,
    total_frames: totalFrames,
    scan_duration_ms: Date.now() - t0,
    events,
    blank_frames_count: blankFramesCount,
    blank_at_s: events.map((e) => e.start_s),
    diagnostics,
  };
  } finally {
    progressFinish("blank scan");
  }
}
