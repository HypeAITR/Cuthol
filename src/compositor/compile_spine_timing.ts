// Spine clip stage 1 — source timing: trim, playback rate / speed ramp, output fps and tail padding.
// Called by compile_spine.ts; the returned filters open the clip chain.
import type { CutholSequence } from "../core/schema.js";
import { getNormalizedSpeedRampSegments } from "../sequence/spine_time.js";

type SpineClipSpec = CutholSequence["spine"]["clips"][number];

/**
 * Average playback rate of a clip, derived from its source span and its (integrated) timeline duration so that
 * clips with a `speed_ramp` keep the exact duration computed by the sequence layer.
 */
export function computeSpineClipEffectiveRate(clip: SpineClipSpec): number {
  return Math.max(
    0.1,
    Math.min(16.0, (clip.source_out_ms - clip.source_in_ms) / Math.max(1, clip.duration_ms))
  );
}

function formatFfmpegNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(9).replace(/\.?0+$/, "");
  return s === "" || s === "-0" ? "0" : s;
}

/**
 * Compiles a clip's `speed_ramp` into the `setpts` expression body (output seconds over `TB`).
 * Same closed form as `integrateSourceOffsetToClipLocalMs`: constant pieces map `(S-s0)/r`,
 * varying pieces map `(L/D)*ln(r(S)/r0)` with `S=(T-STARTT)` source seconds. The `fps` filter
 * after `setpts` resamples the unevenly spaced frames back to even output spacing.
 */
export function compileSpeedRampToSetptsBody(clip: SpineClipSpec): string {
  const spanMs = Math.max(1, clip.source_out_ms - clip.source_in_ms);
  const segments = getNormalizedSpeedRampSegments(
    spanMs,
    clip.playback.rate,
    clip.playback.speed_ramp
  );
  const S = "(T-STARTT)";
  let cumSec = 0;
  const parts = segments.map((seg) => {
    const part = { s0: seg.u0 / 1000, s1: seg.u1 / 1000, r0: seg.r0, r1: seg.r1, cum: cumSec };
    cumSec += seg.dt / 1000;
    return part;
  });
  let expr = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    const { s0, s1, r0, r1, cum } = parts[i];
    const sOff = `(${S}-${formatFfmpegNumber(s0)})`;
    let partial: string;
    if (Math.abs(r1 - r0) < 1e-6) {
      partial = `${sOff}/${formatFfmpegNumber(r0)}`;
    } else {
      const L = formatFfmpegNumber(s1 - s0);
      const D = formatFfmpegNumber(r1 - r0);
      const r0s = formatFfmpegNumber(r0);
      partial = `(${L})/(${D})*log((${r0s}+(${D})*${sOff}/${L})/${r0s})`;
    }
    const branch = cum > 0 ? `${formatFfmpegNumber(cum)}+${partial}` : partial;
    expr =
      i === parts.length - 1
        ? branch
        : `if(lt(${S},${formatFfmpegNumber(s1)}),${branch},${expr})`;
  }
  return `(${expr})/TB`;
}

export function buildSpineClipTimingFilters(params: {
  clip: SpineClipSpec;
  asset: CutholSequence["library"][number];
  isStill: boolean;
  fps: number;
  /** Trim points in the (possibly seeked) input's local time, seconds as fixed strings. */
  srcInSec: string;
  srcOutSec: string;
  effectiveRate: number;
}): string[] {
  const { clip, asset, isStill, fps, srcInSec, srcOutSec, effectiveRate } = params;
  const ramp = clip.playback.speed_ramp;
  const hasRamp = !!ramp && ramp.length >= 2;
  const srcFps = Math.max(1, asset.probe.fps || fps);
  const rawSrcSpanSec = Math.max(0, (clip.source_out_ms - clip.source_in_ms) / 1000);
  const scaledSrcSpanSec = rawSrcSpanSec / effectiveRate;
  const clipDurSec = clip.duration_ms / 1000;
  // When a ramped clip ends slowly, the gap between the last source frame and the range end
  // grows in the output; compute the tail padding at the slowest rate so the last frame is not lost.
  // In an unramped clip tailRate === effectiveRate, so the output stays byte-identical.
  let tailRate = effectiveRate;
  if (hasRamp && !isStill) {
    const spanMs = Math.max(1, clip.source_out_ms - clip.source_in_ms);
    let slowest = Infinity;
    for (const seg of getNormalizedSpeedRampSegments(spanMs, clip.playback.rate, ramp)) {
      slowest = Math.min(slowest, seg.r0, seg.r1);
    }
    if (Number.isFinite(slowest) && slowest > 0) tailRate = slowest;
  }
  const tailPadSec = isStill
    ? (clipDurSec + 2 / fps).toFixed(3)
    : Math.max(
        0.1,
        Math.max(0, clipDurSec - scaledSrcSpanSec) + 3 / (srcFps * tailRate) + 2 / fps
      ).toFixed(3);

  const needsPreTrimEofPad =
    !isStill &&
    asset.probe.duration_ms > 0 &&
    clip.source_out_ms >= Math.max(0, asset.probe.duration_ms - 5000);
  const setptsFilter = hasRamp
    ? `setpts='${compileSpeedRampToSetptsBody(clip)}'`
    : `setpts=(PTS-STARTPTS)/${effectiveRate.toFixed(4)}`;
  return [
    `settb=AVTB`,
    ...(needsPreTrimEofPad ? [`tpad=stop_mode=clone:stop_duration=3.000`] : []),
    `trim=start=${srcInSec}:end=${srcOutSec}`,
    setptsFilter,
    `fps=${fps}:eof_action=pass`,
    `tpad=stop_mode=clone:stop_duration=${tailPadSec}`,
  ];
}
