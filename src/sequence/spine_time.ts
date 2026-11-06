// Dual-clock time math: speed ramps, source/sequence conversion, transcript projection, spine reflow (split out of spine.ts).
import { resolveCueStartMs } from "../core/timeline.js";
import {
  CutholSequence,
  getCuePlaybackRate,
  LaneCue, SpeedRampPoint,
  SpineClip,
  syncSequenceHandleCounters,
  TimedWordToken
} from "../core/schema.js";

export type TimeCoordinateSpace = "source" | "sequence" | "clip_local";

function buildNormalizedRampSegments(
  sourceSpanMs: number,
  fallbackRate: number,
  ramp: SpeedRampPoint[] | null
): Array<{ u0: number; u1: number; r0: number; r1: number; dt: number }> {
  const span = Math.max(1, sourceSpanMs);
  const baseRate = Math.max(0.1, Math.min(16.0, fallbackRate));
  if (!ramp || ramp.length === 0) {
    return [{ u0: 0, u1: span, r0: baseRate, r1: baseRate, dt: span / baseRate }];
  }

  const sorted = [...ramp]
    .map((p) => ({
      u: Math.max(0, Math.min(span, p.source_offset_ms)),
      r: Math.max(0.1, Math.min(16.0, p.rate)),
    }))
    .sort((a, b) => a.u - b.u);

  const pts: Array<{ u: number; r: number }> = [];
  if (sorted[0].u > 0) {
    pts.push({ u: 0, r: sorted[0].r });
  }
  for (const p of sorted) {
    if (pts.length > 0 && Math.abs(pts[pts.length - 1].u - p.u) < 1e-6) {
      pts[pts.length - 1].r = p.r;
    } else {
      pts.push(p);
    }
  }
  if (pts[pts.length - 1].u < span) {
    pts.push({ u: span, r: pts[pts.length - 1].r });
  }

  const segments: Array<{ u0: number; u1: number; r0: number; r1: number; dt: number }> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const u0 = pts[i].u;
    const u1 = pts[i + 1].u;
    const r0 = pts[i].r;
    const r1 = pts[i + 1].r;
    const du = u1 - u0;
    if (du <= 0) continue;
    let dt: number;
    if (Math.abs(r1 - r0) < 1e-6) {
      dt = du / r0;
    } else {
      // Exact integral of 1 / (r0 + k*(u - u0)) du from u0 to u1 = (du / (r1 - r0)) * ln(r1 / r0)
      dt = (du / (r1 - r0)) * Math.log(r1 / r0);
    }
    segments.push({ u0, u1, r0, r1, dt });
  }
  return segments;
}

/**
 * Computes exact clip-local timeline elapsed milliseconds for a source offset `u` in `[0 .. sourceSpanMs]`
 * by analytically integrating $\int_0^u \frac{ds}{r(s)}$ over the piecewise-linear `speed_ramp` curve
 * (or constant `playback.rate` when `speed_ramp` is null).
 */
export function integrateSourceOffsetToClipLocalMs(clip: SpineClip, sourceOffsetMs: number): number {
  const span = Math.max(1, clip.source_out_ms - clip.source_in_ms);
  const clampedU = Math.max(0, Math.min(span, sourceOffsetMs));
  if (!clip.playback.speed_ramp || clip.playback.speed_ramp.length === 0) {
    return clampedU / Math.max(0.01, clip.playback.rate);
  }

  const segments = buildNormalizedRampSegments(span, clip.playback.rate, clip.playback.speed_ramp);
  let totalLocalMs = 0;

  for (const seg of segments) {
    if (clampedU <= seg.u0) break;
    if (clampedU >= seg.u1) {
      totalLocalMs += seg.dt;
    } else {
      const partialDu = clampedU - seg.u0;
      const segDu = seg.u1 - seg.u0;
      const rAtU = seg.r0 + ((seg.r1 - seg.r0) * partialDu) / segDu;
      if (Math.abs(rAtU - seg.r0) < 1e-6) {
        totalLocalMs += partialDu / seg.r0;
      } else {
        totalLocalMs += (partialDu / (rAtU - seg.r0)) * Math.log(rAtU / seg.r0);
      }
      break;
    }
  }
  return totalLocalMs;
}

/**
 * Exact analytic inverse of `integrateSourceOffsetToClipLocalMs`: given clip-local timeline
 * elapsed milliseconds `localMs`, solves for the corresponding source offset `u` in `[0 .. sourceSpanMs]`.
 */
export function invertClipLocalMsToSourceOffset(clip: SpineClip, localMs: number): number {
  const span = Math.max(1, clip.source_out_ms - clip.source_in_ms);
  if (!clip.playback.speed_ramp || clip.playback.speed_ramp.length === 0) {
    return Math.max(0, Math.min(span, localMs * Math.max(0.01, clip.playback.rate)));
  }

  const segments = buildNormalizedRampSegments(span, clip.playback.rate, clip.playback.speed_ramp);
  let remDt = Math.max(0, localMs);

  for (const seg of segments) {
    if (remDt >= seg.dt) {
      remDt -= seg.dt;
    } else {
      if (Math.abs(seg.r1 - seg.r0) < 1e-6) {
        return seg.u0 + seg.r0 * remDt;
      }
      const k = (seg.r1 - seg.r0) / (seg.u1 - seg.u0);
      return seg.u0 + (seg.r0 / k) * (Math.exp(k * remDt) - 1);
    }
  }
  return span;
}

export function computeClipDurationMs(clip: SpineClip): number {
  const span = Math.max(1, clip.source_out_ms - clip.source_in_ms);
  return Math.max(1, Math.round(integrateSourceOffsetToClipLocalMs(clip, span)));
}

export function evaluateSpeedRampAtOffset(
  sourceSpanMs: number,
  fallbackRate: number,
  ramp: SpeedRampPoint[] | null,
  sourceOffsetMs: number
): number {
  const span = Math.max(1, sourceSpanMs);
  const baseRate = Math.max(0.1, Math.min(16.0, fallbackRate));
  if (!ramp || ramp.length === 0) return baseRate;

  const segments = buildNormalizedRampSegments(span, baseRate, ramp);
  const clampedU = Math.max(0, Math.min(span, sourceOffsetMs));
  for (const seg of segments) {
    if (clampedU >= seg.u0 && clampedU <= seg.u1) {
      const segDu = seg.u1 - seg.u0;
      if (segDu <= 0) return seg.r1;
      const t = (clampedU - seg.u0) / segDu;
      return seg.r0 + (seg.r1 - seg.r0) * t;
    }
  }
  return segments[segments.length - 1]?.r1 ?? baseRate;
}

export function sliceSpeedRamp(
  ramp: SpeedRampPoint[] | null,
  oldSpanMs: number,
  fallbackRate: number,
  sliceStartOffsetMs: number,
  sliceEndOffsetMs: number
): SpeedRampPoint[] | null {
  if (!ramp || ramp.length === 0) return null;
  const oldSpan = Math.max(1, oldSpanMs);
  const newSpan = Math.max(1, Math.round(sliceEndOffsetMs - sliceStartOffsetMs));
  const rStart = Number(
    evaluateSpeedRampAtOffset(oldSpan, fallbackRate, ramp, sliceStartOffsetMs).toFixed(6)
  );
  const rEnd = Number(
    evaluateSpeedRampAtOffset(oldSpan, fallbackRate, ramp, sliceEndOffsetMs).toFixed(6)
  );

  // Normalize existing ramp points including [0, oldSpan] boundaries so slip-extending
  // (sliceStartOffsetMs < 0 or sliceEndOffsetMs > oldSpan) preserves constant-rate shelves outside [0, oldSpan].
  const normalizedSegments = buildNormalizedRampSegments(oldSpan, fallbackRate, ramp);
  const normalizedPts: SpeedRampPoint[] = [];
  if (normalizedSegments.length > 0) {
    normalizedPts.push({ source_offset_ms: normalizedSegments[0].u0, rate: normalizedSegments[0].r0 });
    for (const seg of normalizedSegments) {
      normalizedPts.push({ source_offset_ms: seg.u1, rate: seg.r1 });
    }
  }

  const interior = normalizedPts
    .filter((p) => p.source_offset_ms > sliceStartOffsetMs && p.source_offset_ms < sliceEndOffsetMs)
    .map((p) => ({
      source_offset_ms: Math.max(0, Math.min(newSpan, Math.round(p.source_offset_ms - sliceStartOffsetMs))),
      rate: p.rate,
    }))
    .sort((a, b) => a.source_offset_ms - b.source_offset_ms);

  const rawPts: SpeedRampPoint[] = [
    { source_offset_ms: 0, rate: rStart },
    ...interior,
    { source_offset_ms: newSpan, rate: rEnd },
  ].sort((a, b) => a.source_offset_ms - b.source_offset_ms);

  const deduped: SpeedRampPoint[] = [];
  for (const pt of rawPts) {
    if (deduped.length > 0 && deduped[deduped.length - 1].source_offset_ms === pt.source_offset_ms) {
      deduped[deduped.length - 1] = pt;
    } else {
      deduped.push(pt);
    }
  }
  return deduped;
}

/**
 * Converts a timestamp in the raw media file (`source_ms`) to the active timeline (`sequence_ms`)
 * for a given `SpineClip`, accounting for `source_in_ms`, `timeline_in_ms`, constant `playback.rate`,
 * and piecewise-linear `speed_ramp` integration.
 */
export function sourceMsToSequenceMs(clip: SpineClip, sourceMs: number): number {
  const u = sourceMs - clip.source_in_ms;
  return clip.timeline_in_ms + Math.round(integrateSourceOffsetToClipLocalMs(clip, u));
}

/**
 * Converts a timestamp on the active timeline (`sequence_ms`) back to the raw media file (`source_ms`)
 * for a given `SpineClip`, using the exact inverse speed-ramp integral.
 */
export function sequenceMsToSourceMs(clip: SpineClip, sequenceMs: number): number {
  const localMs = sequenceMs - clip.timeline_in_ms;
  return clip.source_in_ms + Math.round(invertClipLocalMsToSourceOffset(clip, localMs));
}

export function clipLocalMsToSourceMs(clip: SpineClip, localMs: number): number {
  return clip.source_in_ms + Math.round(invertClipLocalMsToSourceOffset(clip, localMs));
}

export function sourceMsToClipLocalMs(clip: SpineClip, sourceMs: number): number {
  return Math.round(integrateSourceOffsetToClipLocalMs(clip, sourceMs - clip.source_in_ms));
}

/**
 * Projects raw source-level ASR word tokens onto a single `SpineClip`.
 */
export function projectTranscriptWordsToClip(
  clip: SpineClip,
  rawWords: Array<{ word: string; source_start_ms: number; source_end_ms: number; confidence?: number }>
): TimedWordToken[] {
  const projected: TimedWordToken[] = [];
  for (const w of rawWords) {
    if (w.source_end_ms <= clip.source_in_ms || w.source_start_ms >= clip.source_out_ms) {
      continue;
    }
    const clampedStart = Math.max(clip.source_in_ms, w.source_start_ms);
    const clampedEnd = Math.min(clip.source_out_ms, w.source_end_ms);
    if (clampedEnd <= clampedStart) continue;

    const seqStart = sourceMsToSequenceMs(clip, clampedStart);
    const seqEnd = Math.max(seqStart + 1, sourceMsToSequenceMs(clip, clampedEnd));

    projected.push({
      word: w.word,
      source_start_ms: clampedStart,
      source_end_ms: clampedEnd,
      sequence_start_ms: seqStart,
      sequence_end_ms: seqEnd,
      clip_id: clip.id,
      excised: false,
      confidence: w.confidence,
    });
  }
  return projected;
}

/**
 * Projects raw source-level ASR word tokens of `assetHandle` across the ENTIRE `CutholSequence` spine.
 * Words that fall inside kept spine clips receive exact `sequence_start_ms` and `sequence_end_ms`
 * (using the speed-ramp integral if present).
 * Words that fall inside excised intervals (removed by `excise` or `trim`) receive
 * `sequence_start_ms: null, sequence_end_ms: null, clip_id: null, excised: true` so caption
 * generators skip them deterministically.
 */
export function projectTranscriptAcrossSequence(
  seq: CutholSequence,
  assetHandle: string,
  rawWords: Array<{ word: string; source_start_ms: number; source_end_ms: number; confidence?: number }>
): TimedWordToken[] {
  const unmutedSpineClips = seq.spine.clips.filter(
    (c) => c.asset_handle === assetHandle && !c.audio_chain.muted
  );
  const matchingClips =
    unmutedSpineClips.length > 0
      ? unmutedSpineClips
      : seq.spine.clips.filter((c) => c.asset_handle === assetHandle);
  const matchingLaneCues = seq.lanes
    .filter((l) => !l.muted)
    .flatMap((l) => l.cues)
    .filter((c) => c.asset_handle === assetHandle && !c.audio_chain?.muted);
  const results: TimedWordToken[] = [];

  if (unmutedSpineClips.length === 0 && matchingLaneCues.length > 0) {
    for (const w of rawWords) {
      const wordMidMs = (w.source_start_ms + w.source_end_ms) / 2;
      const wordDur = Math.max(1, w.source_end_ms - w.source_start_ms);
      const candidateCues = matchingLaneCues.filter((cue) => {
        const cueRate = getCuePlaybackRate(cue);
        const srcIn = cue.source_in_ms ?? 0;
        const maxSpanMs = Math.round(cue.duration_ms * cueRate);
        const srcOut = Math.min(cue.source_out_ms ?? srcIn + maxSpanMs, srcIn + maxSpanMs);
        const overlap = Math.min(srcOut, w.source_end_ms) - Math.max(srcIn, w.source_start_ms);
        if (overlap <= 0) return false;
        return (
          (wordMidMs >= srcIn && wordMidMs < srcOut) ||
          overlap >= wordDur * 0.5 ||
          matchingLaneCues.length === 1
        );
      });

      const ownerCues: LaneCue[] = [];
      for (const cue of candidateCues) {
        const prevOwner = ownerCues[ownerCues.length - 1];
        const prevRate = prevOwner ? getCuePlaybackRate(prevOwner) : 1;
        const prevSrcIn = prevOwner ? (prevOwner.source_in_ms ?? 0) : 0;
        const prevSrcOut = prevOwner
          ? (prevOwner.source_out_ms ?? prevSrcIn + Math.round(prevOwner.duration_ms * prevRate))
          : 0;
        const currRate = getCuePlaybackRate(cue);
        const currSrcIn = cue.source_in_ms ?? 0;
        const currSrcOut = cue.source_out_ms ?? currSrcIn + Math.round(cue.duration_ms * currRate);
        if (prevOwner && prevSrcOut === currSrcIn) {
          const prevOverlap = Math.min(prevSrcOut, w.source_end_ms) - Math.max(prevSrcIn, w.source_start_ms);
          const currOverlap = Math.min(currSrcOut, w.source_end_ms) - Math.max(currSrcIn, w.source_start_ms);
          if (currOverlap > prevOverlap) {
            ownerCues[ownerCues.length - 1] = cue;
          }
        } else {
          ownerCues.push(cue);
        }
      }

      if (ownerCues.length === 0) {
        results.push({
          word: w.word,
          source_start_ms: w.source_start_ms,
          source_end_ms: w.source_end_ms,
          sequence_start_ms: null,
          sequence_end_ms: null,
          clip_id: null,
          excised: true,
          confidence: w.confidence,
        });
      } else {
        for (const cue of ownerCues) {
          const cueStart = resolveCueStartMs(seq, cue);
          const cueRate = getCuePlaybackRate(cue);
          const srcIn = cue.source_in_ms ?? 0;
          const maxSpanMs = Math.round(cue.duration_ms * cueRate);
          const srcOut = Math.min(cue.source_out_ms ?? srcIn + maxSpanMs, srcIn + maxSpanMs);
          const clampedStart = Math.max(srcIn, w.source_start_ms);
          const clampedEnd = Math.min(srcOut, w.source_end_ms);
          if (clampedEnd <= clampedStart) continue;
          const seqStart = cueStart + Math.round((clampedStart - srcIn) / cueRate);
          const seqEnd = Math.max(
            seqStart + 1,
            cueStart + Math.min(cue.duration_ms, Math.round((clampedEnd - srcIn) / cueRate))
          );
          results.push({
            word: w.word,
            source_start_ms: clampedStart,
            source_end_ms: clampedEnd,
            sequence_start_ms: seqStart,
            sequence_end_ms: seqEnd,
            clip_id: cue.id,
            excised: false,
            confidence: w.confidence,
          });
        }
      }
    }
    return results;
  }

  for (const w of rawWords) {
    const wordMidMs = (w.source_start_ms + w.source_end_ms) / 2;
    const wordDur = Math.max(1, w.source_end_ms - w.source_start_ms);
    const candidateClips = matchingClips.filter((c) => {
      const overlap =
        Math.min(c.source_out_ms, w.source_end_ms) - Math.max(c.source_in_ms, w.source_start_ms);
      if (overlap <= 0) return false;
      return (
        (wordMidMs >= c.source_in_ms && wordMidMs < c.source_out_ms) ||
        overlap >= wordDur * 0.5
      );
    });

    // Prevent duplicate word emission when a single word is split across two contiguous clips
    // (where prev.source_out_ms === next.source_in_ms).
    const ownerClips: SpineClip[] = [];
    for (const c of candidateClips) {
      const prevOwner = ownerClips[ownerClips.length - 1];
      if (prevOwner && prevOwner.source_out_ms === c.source_in_ms) {
        const prevOverlap =
          Math.min(prevOwner.source_out_ms, w.source_end_ms) -
          Math.max(prevOwner.source_in_ms, w.source_start_ms);
        const currOverlap =
          Math.min(c.source_out_ms, w.source_end_ms) - Math.max(c.source_in_ms, w.source_start_ms);
        if (currOverlap > prevOverlap) {
          ownerClips[ownerClips.length - 1] = c;
        }
      } else {
        ownerClips.push(c);
      }
    }

    if (ownerClips.length === 0) {
      results.push({
        word: w.word,
        source_start_ms: w.source_start_ms,
        source_end_ms: w.source_end_ms,
        sequence_start_ms: null,
        sequence_end_ms: null,
        clip_id: null,
        excised: true,
        confidence: w.confidence,
      });
    } else {
      for (const ownerClip of ownerClips) {
        const clampedStart = Math.max(ownerClip.source_in_ms, w.source_start_ms);
        const clampedEnd = Math.min(ownerClip.source_out_ms, w.source_end_ms);
        if (clampedEnd <= clampedStart) continue;
        const seqStart = sourceMsToSequenceMs(ownerClip, clampedStart);
        const seqEnd = Math.max(seqStart + 1, sourceMsToSequenceMs(ownerClip, clampedEnd));
        results.push({
          word: w.word,
          source_start_ms: clampedStart,
          source_end_ms: clampedEnd,
          sequence_start_ms: seqStart,
          sequence_end_ms: seqEnd,
          clip_id: ownerClip.id,
          excised: false,
          confidence: w.confidence,
        });
      }
    }
  }

  return results;
}

/**
 * Recalculates clip durations from `(source_out_ms - source_in_ms) / playback.rate`,
 * enforces contiguous `timeline_in_ms` when `seq.spine.magnetic === true`,
 * and synchronizes `cue.at_ms` for all spine-anchored lane cues.
 */
export function reflowSpine(seq: CutholSequence): void {
  syncSequenceHandleCounters(seq);
  let cursorMs = 0;
  for (const clip of seq.spine.clips) {
    clip.duration_ms = computeClipDurationMs(clip);
    if (seq.spine.magnetic) {
      clip.timeline_in_ms = cursorMs;
    }
    cursorMs = clip.timeline_in_ms + clip.duration_ms;
  }

  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      if (cue.anchor) {
        cue.at_ms = resolveCueStartMs(seq, cue);
      }
    }
  }
  const cueById = new Map<string, LaneCue>();
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      cueById.set(cue.id, cue);
    }
  }
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      if (cue.cue_anchor) {
        const refCue = cueById.get(cue.cue_anchor.ref);
        if (refCue) {
          cue.at_ms = Math.max(0, resolveCueStartMs(seq, refCue) + cue.cue_anchor.offset_ms);
        }
      }
    }
  }
}

export interface NormalizedSpeedRampSegment {
  u0: number;
  u1: number;
  r0: number;
  r1: number;
  dt: number;
}

/**
 * Shares the `buildNormalizedRampSegments` output with the video compiler: a
 * pure read helper. It does not touch the existing integral functions; the
 * segments it returns are the same normalized curve as `integrateSourceOffsetToClipLocalMs`
 * (`u0/u1` in ms, rate `r0/r1`, segment duration `dt`).
 */
/** Audio slice (source offsets in ms, output duration in ms, slice rate). */
export interface AudioRampSlice {
  u0: number;
  u1: number;
  dt: number;
  rate: number;
}

export interface AudioRampSliceOptions {
  /** Largest in-slice rate ratio (default 1.03 = 3%). */
  maxRateRatio?: number;
  /** Slice output duration cap in ms (default 250). */
  maxSliceOutputMs?: number;
}

export const DEFAULT_AUDIO_RAMP_SLICE_OPTIONS: Required<AudioRampSliceOptions> = {
  maxRateRatio: 1.03,
  maxSliceOutputMs: 250,
};

/**
 * The same math as `integrateSourceOffsetToClipLocalMs`, as a clipless pure
 * equivalent (over span + fallback + ramp).
 */
export function integrateRampSourceOffsetToLocalMs(
  sourceSpanMs: number,
  fallbackRate: number,
  ramp: SpeedRampPoint[] | null,
  sourceOffsetMs: number
): number {
  const span = Math.max(1, sourceSpanMs);
  const clampedU = Math.max(0, Math.min(span, sourceOffsetMs));
  if (!ramp || ramp.length === 0) {
    return clampedU / Math.max(0.01, fallbackRate);
  }
  const segments = buildNormalizedRampSegments(span, fallbackRate, ramp);
  let totalLocalMs = 0;
  for (const seg of segments) {
    if (clampedU <= seg.u0) break;
    if (clampedU >= seg.u1) {
      totalLocalMs += seg.dt;
    } else {
      const partialDu = clampedU - seg.u0;
      const segDu = seg.u1 - seg.u0;
      const rAtU = seg.r0 + ((seg.r1 - seg.r0) * partialDu) / segDu;
      if (Math.abs(rAtU - seg.r0) < 1e-6) {
        totalLocalMs += partialDu / seg.r0;
      } else {
        totalLocalMs += (partialDu / (rAtU - seg.r0)) * Math.log(rAtU / seg.r0);
      }
      break;
    }
  }
  return totalLocalMs;
}

/**
 * The same math as `invertClipLocalMsToSourceOffset`, as a clipless pure
 * equivalent.
 */
export function invertRampLocalMsToSourceOffset(
  sourceSpanMs: number,
  fallbackRate: number,
  ramp: SpeedRampPoint[] | null,
  localMs: number
): number {
  const span = Math.max(1, sourceSpanMs);
  if (!ramp || ramp.length === 0) {
    return Math.max(0, Math.min(span, localMs * Math.max(0.01, fallbackRate)));
  }
  const segments = buildNormalizedRampSegments(span, fallbackRate, ramp);
  let remDt = Math.max(0, localMs);
  for (const seg of segments) {
    if (remDt >= seg.dt) {
      remDt -= seg.dt;
    } else {
      if (Math.abs(seg.r1 - seg.r0) < 1e-6) {
        return seg.u0 + seg.r0 * remDt;
      }
      const k = (seg.r1 - seg.r0) / (seg.u1 - seg.u0);
      return seg.u0 + (seg.r0 / k) * (Math.exp(k * remDt) - 1);
    }
  }
  return span;
}

function audioSliceDtForLinearRamp(du: number, r0: number, r1: number): number {
  if (du <= 0) return 0;
  if (Math.abs(r1 - r0) < 1e-6) return du / Math.max(1e-6, r0);
  return (du / (r1 - r0)) * Math.log(r1 / r0);
}

function subdivideLinearRampRange(
  u0: number,
  u1: number,
  r0: number,
  r1: number,
  maxRateRatio: number,
  maxSliceOutputMs: number
): AudioRampSlice[] {
  const du = u1 - u0;
  if (du <= 1e-9) return [];
  if (Math.abs(r1 - r0) < 1e-6) {
    const dt = du / Math.max(1e-6, r0);
    const rate = du / Math.max(1e-9, dt);
    return [{ u0, u1, dt, rate }];
  }
  const ratio = Math.max(r0, r1) / Math.max(1e-9, Math.min(r0, r1));
  const totalDt = audioSliceDtForLinearRamp(du, r0, r1);
  const nRate = Math.max(1, Math.ceil(Math.log(ratio) / Math.log(Math.max(1.001, maxRateRatio))));
  const nDur = Math.max(1, Math.ceil(totalDt / Math.max(1, maxSliceOutputMs)));
  const n = Math.max(1, nRate, nDur);
  if (n === 1) {
    const rate = du / Math.max(1e-9, totalDt);
    return [{ u0, u1, dt: totalDt, rate }];
  }
  const out: AudioRampSlice[] = [];
  for (let i = 0; i < n; i++) {
    const su0 = i === 0 ? u0 : u0 + (du * i) / n;
    const su1 = i === n - 1 ? u1 : u0 + (du * (i + 1)) / n;
    const t0 = (su0 - u0) / du;
    const t1 = (su1 - u0) / du;
    const sr0 = r0 + (r1 - r0) * t0;
    const sr1 = r0 + (r1 - r0) * t1;
    const sdu = su1 - su0;
    const sdt = audioSliceDtForLinearRamp(sdu, sr0, sr1);
    out.push({ u0: su0, u1: su1, dt: sdt, rate: sdu / Math.max(1e-9, sdt) });
  }
  return out;
}

/**
 * Splits the ramp's normalized segments into audio slices.
 * A constant-rate segment is a single slice; a varying-rate segment is split
 * into sub-slices that stay below the in-slice rate ratio `maxRateRatio` and
 * the slice output duration `maxSliceOutputMs`. Each slice's `rate` is the
 * `du/dt` ratio (from the integral); slice boundaries land on the same video instant.
 */
export function getAudioRampSlices(
  sourceSpanMs: number,
  fallbackRate: number,
  ramp: SpeedRampPoint[] | null,
  options?: AudioRampSliceOptions
): AudioRampSlice[] {
  const span = Math.max(1, sourceSpanMs);
  const maxRateRatio = options?.maxRateRatio ?? DEFAULT_AUDIO_RAMP_SLICE_OPTIONS.maxRateRatio;
  const maxSliceOutputMs =
    options?.maxSliceOutputMs ?? DEFAULT_AUDIO_RAMP_SLICE_OPTIONS.maxSliceOutputMs;
  if (!ramp || ramp.length < 2) {
    const rate = Math.max(0.1, Math.min(16.0, fallbackRate));
    const dt = span / rate;
    return [{ u0: 0, u1: span, dt, rate }];
  }
  const segments = buildNormalizedRampSegments(span, fallbackRate, ramp);
  const out: AudioRampSlice[] = [];
  for (const seg of segments) {
    out.push(...subdivideLinearRampRange(seg.u0, seg.u1, seg.r0, seg.r1, maxRateRatio, maxSliceOutputMs));
  }
  return out;
}

/**
 * Audio slices of the source sub-range `[uStartMs, uEndMs]`
 * (for windowed rendering). Locked to the full-range grid: first the whole span
 * is sliced with `getAudioRampSlices`, then trimmed to the read range; edge
 * segment durations come from integral differences. The window's inner
 * slices are therefore identical to a full render (WSOLA input identical
 * at bit level); the window seam stays in the edge pre-roll and is trimmed.
 */
export function getAudioRampSlicesInRange(
  sourceSpanMs: number,
  fallbackRate: number,
  ramp: SpeedRampPoint[] | null,
  uStartMs: number,
  uEndMs: number,
  options?: AudioRampSliceOptions
): AudioRampSlice[] {
  const span = Math.max(1, sourceSpanMs);
  const lo = Math.max(0, Math.min(span, uStartMs));
  const hi = Math.max(0, Math.min(span, uEndMs));
  if (hi <= lo + 1e-9) return [];
  const full = getAudioRampSlices(sourceSpanMs, fallbackRate, ramp, options);
  const out: AudioRampSlice[] = [];
  for (const s of full) {
    const a = Math.max(s.u0, lo);
    const b = Math.min(s.u1, hi);
    if (b <= a + 1e-9) continue;
    const tA = integrateRampSourceOffsetToLocalMs(span, fallbackRate, ramp, a);
    const tB = integrateRampSourceOffsetToLocalMs(span, fallbackRate, ramp, b);
    const dt = Math.max(1e-9, tB - tA);
    out.push({ u0: a, u1: b, dt, rate: (b - a) / dt });
  }
  return out;
}

export function getNormalizedSpeedRampSegments(
  sourceSpanMs: number,
  fallbackRate: number,
  ramp: SpeedRampPoint[] | null
): NormalizedSpeedRampSegment[] {
  return buildNormalizedRampSegments(sourceSpanMs, fallbackRate, ramp);
}
