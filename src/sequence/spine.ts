/**
 * Cuthol Primary Narrative Spine & Envelope Engine (`src/sequence/spine.ts`).
 *
 * Implements magnetic spine reflow, append, split (with automatic cue re-anchoring
 * and envelope partitioning), trim, multi-range excise (ripple cut), remove, reorder,
 * spatial transform (absolute & relative deltas), playback speed, transitions,
 * and deterministic keyframe envelope evaluation.
 */

import { resolveCueStartMs } from "../brief/inspector.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  allocateNextHandle,
  createDefaultAudioChain,
  createDefaultPlacement,
  createDefaultTreatments,
  CutholSequence,
  ParameterEnvelope,
  ParameterEnvelopePoint,
  SpatialPlacement,
  SpeedRampPoint,
  SpineClip,
  syncSequenceHandleCounters,
  TimedWordToken,
  TransitionSpec,
} from "../core/schema.js";
import { minClipDurationMs } from "../core/time.js";
import { loadSequence } from "../core/workspace.js";
import {
  analyzeAssetSubjectTrack,
  planCalmReframeTrajectory,
  PlannedClipReframe,
  SubjectTrackAnalysis,
} from "../library/subject.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";

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
  const matchingClips = seq.spine.clips.filter((c) => c.asset_handle === assetHandle);
  const matchingLaneCues = seq.lanes
    .filter((l) => !l.muted)
    .flatMap((l) => l.cues)
    .filter((c) => c.asset_handle === assetHandle && !c.audio_chain?.muted);
  const results: TimedWordToken[] = [];

  if (matchingClips.length === 0 && matchingLaneCues.length > 0) {
    for (const w of rawWords) {
      let matchedAnyCue = false;
      for (const cue of matchingLaneCues) {
        const cueStart = resolveCueStartMs(seq, cue);
        const srcIn = cue.source_in_ms ?? 0;
        const srcOut = cue.source_out_ms ?? srcIn + cue.duration_ms;
        if (w.source_end_ms <= srcIn || w.source_start_ms >= srcOut) continue;
        const clampedStart = Math.max(srcIn, w.source_start_ms);
        const clampedEnd = Math.min(srcOut, w.source_end_ms);
        if (clampedEnd <= clampedStart) continue;
        const seqStart = cueStart + (clampedStart - srcIn);
        const seqEnd = Math.max(seqStart + 1, cueStart + Math.min(cue.duration_ms, clampedEnd - srcIn));
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
        matchedAnyCue = true;
      }
      if (!matchedAnyCue) {
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
}

export function evaluateEnvelopeAt(envelope: ParameterEnvelope, offsetMs: number): number {
  const pts = envelope.points;
  if (pts.length === 0) return 0;
  if (offsetMs <= pts[0].offset_ms) return pts[0].value;
  if (offsetMs >= pts[pts.length - 1].offset_ms) return pts[pts.length - 1].value;

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (offsetMs >= a.offset_ms && offsetMs <= b.offset_ms) {
      const span = Math.max(1, b.offset_ms - a.offset_ms);
      const t = (offsetMs - a.offset_ms) / span;
      let easedT = t;
      switch (b.easing) {
        case "ease_in":
          easedT = t * t;
          break;
        case "ease_out":
          easedT = 1 - (1 - t) * (1 - t);
          break;
        case "ease_in_out":
          easedT = t * t * (3 - 2 * t);
          break;
        case "linear":
        default:
          easedT = t;
          break;
      }
      return Number((a.value + (b.value - a.value) * easedT).toFixed(6));
    }
  }
  return pts[pts.length - 1].value;
}

export function sliceEnvelopes(
  envelopes: ParameterEnvelope[],
  localStartMs: number,
  localEndMs: number
): ParameterEnvelope[] {
  const newDurationMs = Math.max(0, Math.round(localEndMs - localStartMs));
  const out: ParameterEnvelope[] = [];

  for (const env of envelopes) {
    if (env.points.length === 0) continue;
    if (env.points.length === 1) {
      const shiftedOffset = Math.max(
        0,
        Math.min(newDurationMs, Math.round(env.points[0].offset_ms - localStartMs))
      );
      out.push({
        parameter: env.parameter,
        points: [{ ...env.points[0], offset_ms: shiftedOffset }],
      });
      continue;
    }

    const startVal = evaluateEnvelopeAt(env, localStartMs);
    const endVal = evaluateEnvelopeAt(env, localEndMs);

    let endEasing: ParameterEnvelopePoint["easing"] = "linear";
    for (let i = 0; i < env.points.length - 1; i++) {
      const a = env.points[i];
      const b = env.points[i + 1];
      if (localEndMs > a.offset_ms && localEndMs <= b.offset_ms) {
        endEasing = b.easing;
        break;
      }
    }

    const firstOrigOffset = env.points[0].offset_ms;
    const lastOrigOffset = env.points[env.points.length - 1].offset_ms;
    const rawPts: ParameterEnvelopePoint[] = [];

    if (localStartMs >= firstOrigOffset || localEndMs <= firstOrigOffset) {
      rawPts.push({ offset_ms: 0, value: startVal, easing: "linear" });
    }

    for (const p of env.points) {
      if (p.offset_ms > localStartMs && p.offset_ms < localEndMs) {
        rawPts.push({
          offset_ms: Math.max(0, Math.min(newDurationMs, Math.round(p.offset_ms - localStartMs))),
          value: p.value,
          easing: p.easing,
        });
      }
    }

    if (localEndMs <= lastOrigOffset && localEndMs > firstOrigOffset) {
      rawPts.push({ offset_ms: newDurationMs, value: endVal, easing: endEasing });
    } else if (rawPts.length === 0) {
      rawPts.push({ offset_ms: 0, value: startVal, easing: "linear" });
    }

    rawPts.sort((a, b) => a.offset_ms - b.offset_ms);
    const deduped: ParameterEnvelopePoint[] = [];
    for (const pt of rawPts) {
      if (deduped.length > 0 && deduped[deduped.length - 1].offset_ms === pt.offset_ms) {
        deduped[deduped.length - 1] = pt;
      } else {
        deduped.push(pt);
      }
    }

    out.push({ parameter: env.parameter, points: deduped });
  }

  return out;
}

export function sliceReframeFocalPoints(
  focalPoints: SpineClip["treatments"]["reframe"]["focal_points"],
  localStartMs: number,
  localEndMs: number
): SpineClip["treatments"]["reframe"]["focal_points"] {
  if (!focalPoints || focalPoints.length === 0) return [];
  const newDurationMs = Math.max(0, Math.round(localEndMs - localStartMs));
  if (focalPoints.length === 1) {
    return [
      {
        ...focalPoints[0],
        offset_ms: Math.max(0, Math.min(newDurationMs, Math.round(focalPoints[0].offset_ms - localStartMs))),
      },
    ];
  }

  const xEnv: ParameterEnvelope = {
    parameter: "placement.x_pct",
    points: focalPoints.map((fp) => ({
      offset_ms: fp.offset_ms,
      value: fp.center_x_pct,
      easing: "ease_in_out",
    })),
  };
  const yEnv: ParameterEnvelope = {
    parameter: "placement.y_pct",
    points: focalPoints.map((fp) => ({
      offset_ms: fp.offset_ms,
      value: fp.center_y_pct,
      easing: "ease_in_out",
    })),
  };

  const startCx = Number(evaluateEnvelopeAt(xEnv, localStartMs).toFixed(2));
  const endCx = Number(evaluateEnvelopeAt(xEnv, localEndMs).toFixed(2));
  const startCy = Number(evaluateEnvelopeAt(yEnv, localStartMs).toFixed(2));
  const endCy = Number(evaluateEnvelopeAt(yEnv, localEndMs).toFixed(2));

  const raw: SpineClip["treatments"]["reframe"]["focal_points"] = [
    { offset_ms: 0, center_x_pct: startCx, center_y_pct: startCy, confidence: focalPoints[0].confidence },
  ];
  for (const fp of focalPoints) {
    if (fp.offset_ms > localStartMs && fp.offset_ms < localEndMs) {
      raw.push({
        offset_ms: Math.max(0, Math.min(newDurationMs, Math.round(fp.offset_ms - localStartMs))),
        center_x_pct: fp.center_x_pct,
        center_y_pct: fp.center_y_pct,
        confidence: fp.confidence,
      });
    }
  }
  if (newDurationMs > 0) {
    raw.push({
      offset_ms: newDurationMs,
      center_x_pct: endCx,
      center_y_pct: endCy,
      confidence: focalPoints[focalPoints.length - 1].confidence,
    });
  }
  raw.sort((a, b) => a.offset_ms - b.offset_ms);
  const deduped: SpineClip["treatments"]["reframe"]["focal_points"] = [];
  for (const pt of raw) {
    if (deduped.length > 0 && deduped[deduped.length - 1].offset_ms === pt.offset_ms) {
      deduped[deduped.length - 1] = pt;
    } else {
      deduped.push(pt);
    }
  }
  return deduped;
}

export function appendSpineClip(options: {
  workspaceDir: string;
  assetHandle: string;
  sourceInMs?: number;
  sourceOutMs?: number;
  explicitId?: string;
}): { clip: SpineClip; revision: number; verification: VerificationReport } {
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.append(${options.assetHandle})`,
    (seq) => {
      const asset = seq.library.find((x) => x.handle === options.assetHandle);
      if (!asset) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.assetHandle));
      }

      const sourceInMs = options.sourceInMs ?? 0;
      const sourceOutMs = options.sourceOutMs ?? asset.probe.duration_ms;

      const existingIds = seq.spine.clips.map((c) => c.id);
      const id = options.explicitId ?? allocateNextHandle(existingIds, "sp", seq);
      syncSequenceHandleCounters(seq, [id]);

      const newClip: SpineClip = {
        id,
        asset_handle: asset.handle,
        source_in_ms: sourceInMs,
        source_out_ms: sourceOutMs,
        timeline_in_ms: 0,
        duration_ms: Math.max(1, sourceOutMs - sourceInMs),
        playback: {
          rate: 1.0,
          preserve_pitch: true,
          speed_ramp: null,
        },
        placement: createDefaultPlacement(),
        audio_chain: createDefaultAudioChain(),
        treatments: createDefaultTreatments(),
        transition_out: null,
        envelopes: [],
      };

      seq.spine.clips.push(newClip);
      reflowSpine(seq);
      return newClip;
    }
  );

  return { clip: result, revision, verification };
}

export function splitSpineClip(options: {
  workspaceDir: string;
  clipId: string;
  splitPointsMs: number[];
  isSequenceTime?: boolean;
}): { clips: SpineClip[]; revision: number; verification: VerificationReport } {
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.split(${options.clipId})`,
    (seq) => {
      const idx = seq.spine.clips.findIndex((c) => c.id === options.clipId);
      if (idx === -1) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.clipId));
      }
      const target = seq.spine.clips[idx];

      // Convert split points into clip-local timeline offsets (0 .. target.duration_ms)
      const localOffsets = options.splitPointsMs
        .map((pt) => (options.isSequenceTime ? pt - target.timeline_in_ms : pt))
        .filter((off) => off > 0 && off < target.duration_ms)
        .sort((a, b) => a - b);

      // Deduplicate
      const uniqueOffsets: number[] = [];
      for (const off of localOffsets) {
        if (uniqueOffsets.length === 0 || off - uniqueOffsets[uniqueOffsets.length - 1] >= 1) {
          uniqueOffsets.push(off);
        }
      }

      if (uniqueOffsets.length === 0) {
        return [target];
      }

      const existingIds = new Set(seq.spine.clips.map((c) => c.id));
      const targetSpan = Math.max(1, target.source_out_ms - target.source_in_ms);

      // Map all split offsets directly against the original `target` clip so multi-point splits
      // never accumulate iterative rounding drift on `speed_ramp`, `envelopes`, or `cue.anchor`.
      const splitSourcePoints: number[] = [];
      for (const localOff of uniqueOffsets) {
        const rawSrc = clipLocalMsToSourceMs(target, localOff);
        const prevSrc =
          splitSourcePoints.length > 0
            ? splitSourcePoints[splitSourcePoints.length - 1]
            : target.source_in_ms;
        const clampedSrc = Math.min(
          target.source_out_ms - 1,
          Math.max(prevSrc + 1, rawSrc)
        );
        if (clampedSrc > prevSrc && clampedSrc < target.source_out_ms) {
          splitSourcePoints.push(clampedSrc);
        }
      }

      if (splitSourcePoints.length === 0) {
        return [target];
      }

      const boundarySources = [
        target.source_in_ms,
        ...splitSourcePoints,
        target.source_out_ms,
      ];
      const generatedClips: SpineClip[] = [];

      for (let i = 0; i < boundarySources.length - 1; i++) {
        const srcIn = boundarySources[i];
        const srcOut = boundarySources[i + 1];
        const subId = i === 0 ? target.id : allocateNextHandle(existingIds, "sp", seq);
        existingIds.add(subId);

        const subRamp = sliceSpeedRamp(
          target.playback.speed_ramp,
          targetSpan,
          target.playback.rate,
          srcIn - target.source_in_ms,
          srcOut - target.source_in_ms
        );

        const subClip: SpineClip = {
          ...structuredClone(target),
          id: subId,
          source_in_ms: srcIn,
          source_out_ms: srcOut,
          playback: { ...target.playback, speed_ramp: subRamp },
          duration_ms: 1,
          transition_out: i === boundarySources.length - 2 ? target.transition_out : null,
          envelopes: [],
        };
        subClip.duration_ms = computeClipDurationMs(subClip);

        const sliceLocalStart = sourceMsToClipLocalMs(target, srcIn);
        const sliceLocalEnd = sliceLocalStart + subClip.duration_ms;
        subClip.envelopes = sliceEnvelopes(target.envelopes, sliceLocalStart, sliceLocalEnd);
        if (target.treatments.reframe.focal_points.length > 0) {
          subClip.treatments.reframe.focal_points = sliceReframeFocalPoints(
            target.treatments.reframe.focal_points,
            sliceLocalStart,
            sliceLocalEnd
          );
        }

        generatedClips.push(subClip);
      }

      // Re-anchor any lane cues anchored to `target.id` directly from `target` source coordinates
      for (const lane of seq.lanes) {
        for (const cue of lane.cues) {
          if (cue.anchor && cue.anchor.ref === target.id) {
            const overhangMs = Math.max(0, cue.anchor.offset_ms - target.duration_ms);
            const leadInMs = Math.min(0, cue.anchor.offset_ms);
            const cueSrcMs = clipLocalMsToSourceMs(target, cue.anchor.offset_ms);

            let matchingSub = generatedClips[generatedClips.length - 1];
            for (let i = 0; i < generatedClips.length; i++) {
              const sub = generatedClips[i];
              const isLast = i === generatedClips.length - 1;
              if (
                cueSrcMs >= sub.source_in_ms &&
                (isLast ? cueSrcMs <= sub.source_out_ms : cueSrcMs < sub.source_out_ms)
              ) {
                matchingSub = sub;
                break;
              }
            }

            const clampedSrc = Math.max(
              matchingSub.source_in_ms,
              Math.min(matchingSub.source_out_ms, cueSrcMs)
            );
            cue.anchor = {
              ref: matchingSub.id,
              offset_ms: Math.max(
                0,
                sourceMsToClipLocalMs(matchingSub, clampedSrc) + overhangMs + leadInMs
              ),
            };
          }
        }
      }

      seq.spine.clips.splice(idx, 1, ...generatedClips);
      reflowSpine(seq);
      return generatedClips;
    }
  );

  return { clips: result, revision, verification };
}

export function trimSpineClip(options: {
  workspaceDir: string;
  clipId: string;
  sourceInMs?: number;
  sourceOutMs?: number;
}): { clip: SpineClip; revision: number; verification: VerificationReport } {
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.trim(${options.clipId})`,
    (seq) => {
      const clip = seq.spine.clips.find((c) => c.id === options.clipId);
      if (!clip) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.clipId));
      }

      const oldClipClone = structuredClone(clip);
      if (options.sourceInMs !== undefined) {
        clip.source_in_ms = options.sourceInMs;
      }
      if (options.sourceOutMs !== undefined) {
        clip.source_out_ms = options.sourceOutMs;
      }

      if (oldClipClone.playback.speed_ramp && oldClipClone.playback.speed_ramp.length > 0) {
        const oldSpan = Math.max(1, oldClipClone.source_out_ms - oldClipClone.source_in_ms);
        clip.playback.speed_ramp = sliceSpeedRamp(
          oldClipClone.playback.speed_ramp,
          oldSpan,
          oldClipClone.playback.rate,
          clip.source_in_ms - oldClipClone.source_in_ms,
          clip.source_out_ms - oldClipClone.source_in_ms
        );
      }
      const newDurationMs = computeClipDurationMs(clip);
      clip.duration_ms = newDurationMs;

      // Signed clip-local start shift (handles both trimming in and slip-extending head out)
      const localStartMs =
        clip.source_in_ms >= oldClipClone.source_in_ms
          ? sourceMsToClipLocalMs(oldClipClone, clip.source_in_ms)
          : -sourceMsToClipLocalMs(clip, oldClipClone.source_in_ms);

      clip.envelopes = sliceEnvelopes(
        oldClipClone.envelopes,
        localStartMs,
        localStartMs + newDurationMs
      );
      if (oldClipClone.treatments.reframe.focal_points.length > 0) {
        clip.treatments.reframe.focal_points = sliceReframeFocalPoints(
          oldClipClone.treatments.reframe.focal_points,
          localStartMs,
          localStartMs + newDurationMs
        );
      }

      // Update any lane cues anchored to this clip so they stay locked to the same source timestamp
      for (const lane of seq.lanes) {
        for (const cue of lane.cues) {
          if (cue.anchor && cue.anchor.ref === clip.id) {
            const overhangMs = Math.max(0, cue.anchor.offset_ms - oldClipClone.duration_ms);
            const leadInMs = Math.min(0, cue.anchor.offset_ms);
            const cueSrcMs = clipLocalMsToSourceMs(oldClipClone, cue.anchor.offset_ms);
            const clampedSrc = Math.max(
              clip.source_in_ms,
              Math.min(clip.source_out_ms, cueSrcMs)
            );
            cue.anchor.offset_ms = Math.max(
              0,
              sourceMsToClipLocalMs(clip, clampedSrc) + overhangMs + leadInMs
            );
          }
        }
      }

      reflowSpine(seq);
      return clip;
    }
  );

  return { clip: result, revision, verification };
}

/**
 * Excises (cuts out) one or more internal time intervals from a spine clip and closes gaps.
 * Supports 3 explicit coordinate spaces via `coordinateSpace`:
 * - `"source"`: Raw media file timestamps (e.g., directly from ASR transcript pauses/filler words),
 *               automatically mapped through the clip's `source_in_ms` and `playback.rate`.
 * - `"sequence"`: Global timeline timestamps (`timeline_in_ms .. timeline_in_ms + duration_ms`).
 * - `"clip_local"` (default for manual CLI unless specified): `[0 .. clip.duration_ms]`.
 */
export function exciseSpineRanges(options: {
  workspaceDir: string;
  clipId: string;
  ranges: Array<{ start_ms: number; end_ms: number }>;
  coordinateSpace?: TimeCoordinateSpace;
  isSourceTime?: boolean;
}): { remainingClips: SpineClip[]; revision: number; verification: VerificationReport } {
  const coordSpace: TimeCoordinateSpace =
    options.coordinateSpace ?? (options.isSourceTime ? "source" : "clip_local");

  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.excise(${options.clipId},${coordSpace})`,
    (seq) => {
      const idx = seq.spine.clips.findIndex((c) => c.id === options.clipId);
      if (idx === -1) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.clipId));
      }
      const target = seq.spine.clips[idx];

      // Convert cut ranges to source milliseconds [source_in_ms .. source_out_ms]
      const cutRanges = options.ranges
        .map((r) => {
          let rawSrcStart: number;
          let rawSrcEnd: number;
          if (coordSpace === "source") {
            rawSrcStart = r.start_ms;
            rawSrcEnd = r.end_ms;
          } else if (coordSpace === "sequence") {
            rawSrcStart = sequenceMsToSourceMs(target, r.start_ms);
            rawSrcEnd = sequenceMsToSourceMs(target, r.end_ms);
          } else {
            rawSrcStart = clipLocalMsToSourceMs(target, r.start_ms);
            rawSrcEnd = clipLocalMsToSourceMs(target, r.end_ms);
          }
          return {
            start: Math.max(target.source_in_ms, rawSrcStart),
            end: Math.min(target.source_out_ms, rawSrcEnd),
          };
        })
        .filter((r) => r.end > r.start)
        .sort((a, b) => a.start - b.start);

      // Merge overlapping cut ranges
      const mergedCuts: Array<{ start: number; end: number }> = [];
      for (const r of cutRanges) {
        if (mergedCuts.length === 0 || r.start > mergedCuts[mergedCuts.length - 1].end) {
          mergedCuts.push({ ...r });
        } else {
          mergedCuts[mergedCuts.length - 1].end = Math.max(mergedCuts[mergedCuts.length - 1].end, r.end);
        }
      }

      // Compute kept source intervals, absorbing any micro-sliver (< 2 frames) between cuts
      const minFrameDurMs = minClipDurationMs(seq.stage.fps, 2);
      const rawKeptIntervals: Array<{ start: number; end: number }> = [];
      let cursor = target.source_in_ms;
      for (const cut of mergedCuts) {
        if (cut.start > cursor) {
          rawKeptIntervals.push({ start: cursor, end: cut.start });
        }
        cursor = Math.max(cursor, cut.end);
      }
      if (cursor < target.source_out_ms) {
        rawKeptIntervals.push({ start: cursor, end: target.source_out_ms });
      }

      const keptIntervals = rawKeptIntervals.filter((interval) => {
        const probeClip: SpineClip = {
          ...structuredClone(target),
          source_in_ms: interval.start,
          source_out_ms: interval.end,
        };
        return computeClipDurationMs(probeClip) >= minFrameDurMs;
      });

      const existingIds = new Set(seq.spine.clips.map((c) => c.id));
      const newClips: SpineClip[] = [];
      const targetSpan = Math.max(1, target.source_out_ms - target.source_in_ms);

      for (let i = 0; i < keptIntervals.length; i++) {
        const interval = keptIntervals[i];
        const clipId = i === 0 ? target.id : allocateNextHandle(existingIds, "sp", seq);
        existingIds.add(clipId);

        const subRamp = sliceSpeedRamp(
          target.playback.speed_ramp,
          targetSpan,
          target.playback.rate,
          interval.start - target.source_in_ms,
          interval.end - target.source_in_ms
        );

        const subClip: SpineClip = {
          ...structuredClone(target),
          id: clipId,
          source_in_ms: interval.start,
          source_out_ms: interval.end,
          playback: { ...target.playback, speed_ramp: subRamp },
          duration_ms: 1,
          transition_out: i === keptIntervals.length - 1 ? target.transition_out : null,
          envelopes: [],
        };
        subClip.duration_ms = computeClipDurationMs(subClip);

        const localStartMs = sourceMsToClipLocalMs(target, interval.start);
        subClip.envelopes = sliceEnvelopes(
          target.envelopes,
          localStartMs,
          localStartMs + subClip.duration_ms
        );
        if (target.treatments.reframe.focal_points.length > 0) {
          subClip.treatments.reframe.focal_points = sliceReframeFocalPoints(
            target.treatments.reframe.focal_points,
            localStartMs,
            localStartMs + subClip.duration_ms
          );
        }
        newClips.push(subClip);
      }

      if (newClips.length === 0) {
        for (const lane of seq.lanes) {
          lane.cues = lane.cues.filter((cue) => cue.anchor?.ref !== target.id);
        }
      } else {
        // Re-anchor any cues anchored to `target.id` into the kept sub-clip covering that source timestamp
        for (const lane of seq.lanes) {
          for (const cue of lane.cues) {
            if (cue.anchor && cue.anchor.ref === target.id) {
              const overhangMs = Math.max(0, cue.anchor.offset_ms - target.duration_ms);
              const leadInMs = Math.min(0, cue.anchor.offset_ms);
              const cueSrcMs = clipLocalMsToSourceMs(target, cue.anchor.offset_ms);
              const matchingSub =
                newClips.find((sub) => cueSrcMs >= sub.source_in_ms && cueSrcMs <= sub.source_out_ms) ??
                newClips.find((sub) => sub.source_in_ms >= cueSrcMs) ??
                newClips[newClips.length - 1];
              const clampedSrc = Math.max(
                matchingSub.source_in_ms,
                Math.min(matchingSub.source_out_ms, cueSrcMs)
              );
              cue.anchor = {
                ref: matchingSub.id,
                offset_ms: Math.max(
                  0,
                  sourceMsToClipLocalMs(matchingSub, clampedSrc) + overhangMs + leadInMs
                ),
              };
            }
          }
        }
      }

      seq.spine.clips.splice(idx, 1, ...newClips);
      reflowSpine(seq);
      return newClips;
    }
  );

  return { remainingClips: result, revision, verification };
}

export function removeSpineClips(options: {
  workspaceDir: string;
  clipIds: string[];
  cascadeAnchoredCues?: boolean;
}): { removedIds: string[]; revision: number; verification: VerificationReport } {
  const cascade = options.cascadeAnchoredCues ?? true;
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.remove(${options.clipIds.join(",")})`,
    (seq) => {
      syncSequenceHandleCounters(seq);
      const toRemove = new Set(options.clipIds);
      for (const id of toRemove) {
        if (!seq.spine.clips.some((c) => c.id === id)) {
          throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(id));
        }
      }

      for (const lane of seq.lanes) {
        if (cascade) {
          lane.cues = lane.cues.filter((cue) => !cue.anchor || !toRemove.has(cue.anchor.ref));
        } else {
          for (const cue of lane.cues) {
            if (cue.anchor && toRemove.has(cue.anchor.ref)) {
              cue.at_ms = resolveCueStartMs(seq, cue);
              cue.anchor = null;
            }
          }
        }
      }

      seq.spine.clips = seq.spine.clips.filter((c) => !toRemove.has(c.id));
      reflowSpine(seq);
      return Array.from(toRemove);
    }
  );

  return { removedIds: result, revision, verification };
}

export function reorderSpineClip(options: {
  workspaceDir: string;
  clipId: string;
  beforeClipId?: string;
  afterClipId?: string;
  toIndex?: number;
}): { spineOrder: string[]; revision: number; verification: VerificationReport } {
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.reorder(${options.clipId})`,
    (seq) => {
      const fromIdx = seq.spine.clips.findIndex((c) => c.id === options.clipId);
      if (fromIdx === -1) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.clipId));
      }
      const [moving] = seq.spine.clips.splice(fromIdx, 1);

      let insertIdx = seq.spine.clips.length;
      if (options.beforeClipId) {
        const bIdx = seq.spine.clips.findIndex((c) => c.id === options.beforeClipId);
        if (bIdx === -1) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.beforeClipId));
        insertIdx = bIdx;
      } else if (options.afterClipId) {
        const aIdx = seq.spine.clips.findIndex((c) => c.id === options.afterClipId);
        if (aIdx === -1) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.afterClipId));
        insertIdx = aIdx + 1;
      } else if (options.toIndex !== undefined) {
        insertIdx = Math.max(0, Math.min(seq.spine.clips.length, options.toIndex));
      }

      seq.spine.clips.splice(insertIdx, 0, moving);
      reflowSpine(seq);
      return seq.spine.clips.map((c) => c.id);
    }
  );

  return { spineOrder: result, revision, verification };
}

export function applyNumericDeltaOrValue(current: number, expr: string | number): number {
  if (typeof expr === "number") {
    if (!Number.isFinite(expr)) {
      throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(String(expr)));
    }
    return expr;
  }
  const trimmed = expr.trim().replace(/(?:%|deg|x)$/i, "").trim();
  if (trimmed === "" || trimmed === "+=" || trimmed === "-=") {
    throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(expr));
  }
  let result: number;
  if (trimmed.startsWith("+=")) {
    const delta = Number(trimmed.slice(2));
    result = Number((current + delta).toFixed(4));
  } else if (trimmed.startsWith("-=")) {
    const delta = Number(trimmed.slice(2));
    result = Number((current - delta).toFixed(4));
  } else {
    result = Number(trimmed);
  }
  if (!Number.isFinite(result)) {
    throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(expr));
  }
  return result;
}

export function applyOpacityDeltaOrValue(current: number, expr: string | number): number {
  if (typeof expr === "number") {
    if (!Number.isFinite(expr)) {
      throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(String(expr)));
    }
    return Math.max(0, Math.min(1, expr));
  }
  const raw = expr.trim();
  const isPercent = raw.endsWith("%");
  const core = (isPercent ? raw.slice(0, -1) : raw).trim();
  if (core === "" || core === "+=" || core === "-=") {
    throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(expr));
  }
  let val: number;
  if (core.startsWith("+=")) {
    const delta = Number(core.slice(2));
    if (!Number.isFinite(delta)) throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(expr));
    val = current + (isPercent ? delta / 100 : delta);
  } else if (core.startsWith("-=")) {
    const delta = Number(core.slice(2));
    if (!Number.isFinite(delta)) throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(expr));
    val = current - (isPercent ? delta / 100 : delta);
  } else {
    const parsed = Number(core);
    if (!Number.isFinite(parsed)) throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(expr));
    val = isPercent ? parsed / 100 : parsed;
  }
  return Math.max(0, Math.min(1, Number(val.toFixed(4))));
}

export function transformSpineClip(options: {
  workspaceDir: string;
  clipId: string;
  xPct?: string | number;
  yPct?: string | number;
  scale?: string | number;
  scaleX?: string | number;
  scaleY?: string | number;
  rotationDeg?: string | number;
  opacity?: string | number;
  fitMode?: SpatialPlacement["fit_mode"];
  mirrorX?: boolean;
  mirrorY?: boolean;
}): { placement: SpatialPlacement; revision: number; verification: VerificationReport } {
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.transform(${options.clipId})`,
    (seq) => {
      const clip = seq.spine.clips.find((c) => c.id === options.clipId);
      if (!clip) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.clipId));
      }

      if (options.xPct !== undefined) {
        clip.placement.x_pct = applyNumericDeltaOrValue(clip.placement.x_pct, options.xPct);
      }
      if (options.yPct !== undefined) {
        clip.placement.y_pct = applyNumericDeltaOrValue(clip.placement.y_pct, options.yPct);
      }
      if (options.scale !== undefined) {
        clip.placement.scale_x = applyNumericDeltaOrValue(clip.placement.scale_x, options.scale);
        clip.placement.scale_y = applyNumericDeltaOrValue(clip.placement.scale_y, options.scale);
      }
      if (options.scaleX !== undefined) {
        clip.placement.scale_x = applyNumericDeltaOrValue(clip.placement.scale_x, options.scaleX);
      }
      if (options.scaleY !== undefined) {
        clip.placement.scale_y = applyNumericDeltaOrValue(clip.placement.scale_y, options.scaleY);
      }
      if (options.rotationDeg !== undefined) {
        clip.placement.rotation_deg = applyNumericDeltaOrValue(
          clip.placement.rotation_deg,
          options.rotationDeg
        );
      }
      if (options.opacity !== undefined) {
        clip.placement.opacity = applyOpacityDeltaOrValue(clip.placement.opacity, options.opacity);
      }
      if (options.fitMode !== undefined) clip.placement.fit_mode = options.fitMode;
      if (options.mirrorX !== undefined) clip.placement.mirror_x = options.mirrorX;
      if (options.mirrorY !== undefined) clip.placement.mirror_y = options.mirrorY;

      return clip.placement;
    }
  );

  return { placement: result, revision, verification };
}

export function setSpineSpeed(options: {
  workspaceDir: string;
  clipId: string;
  rate?: number;
  speedRamp?: SpeedRampPoint[] | null;
  preservePitch?: boolean;
}): { clip: SpineClip; revision: number; verification: VerificationReport } {
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.speed(${options.clipId})`,
    (seq) => {
      const clip = seq.spine.clips.find((c) => c.id === options.clipId);
      if (!clip) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.clipId));
      }

      const oldClipClone = structuredClone(clip);
      const oldDurationMs = clip.duration_ms;
      if (options.rate !== undefined) {
        clip.playback.rate = options.rate;
      }
      if (options.speedRamp !== undefined) {
        clip.playback.speed_ramp = options.speedRamp;
      }
      if (options.preservePitch !== undefined) {
        clip.playback.preserve_pitch = options.preservePitch;
      }

      const newDurationMs = computeClipDurationMs(clip);
      clip.duration_ms = newDurationMs;

      // Map envelope points through exact source-offset integral (handles both constant rate and nonlinear speed_ramp)
      for (const env of clip.envelopes) {
        for (const pt of env.points) {
          const srcOffsetMs = invertClipLocalMsToSourceOffset(oldClipClone, pt.offset_ms);
          pt.offset_ms = Math.min(
            newDurationMs,
            Math.max(0, Math.round(integrateSourceOffsetToClipLocalMs(clip, srcOffsetMs)))
          );
        }
      }
      for (const fp of clip.treatments.reframe.focal_points) {
        const srcOffsetMs = invertClipLocalMsToSourceOffset(oldClipClone, fp.offset_ms);
        fp.offset_ms = Math.min(
          newDurationMs,
          Math.max(0, Math.round(integrateSourceOffsetToClipLocalMs(clip, srcOffsetMs)))
        );
      }

      // Rescale anchored lane cue offsets so they stay locked to the same source timestamp
      for (const lane of seq.lanes) {
        for (const cue of lane.cues) {
          if (cue.anchor && cue.anchor.ref === clip.id) {
            const overhangMs = Math.max(0, cue.anchor.offset_ms - oldDurationMs);
            const leadInMs = Math.min(0, cue.anchor.offset_ms);
            const srcOffsetMs = invertClipLocalMsToSourceOffset(oldClipClone, cue.anchor.offset_ms);
            cue.anchor.offset_ms = Math.max(
              0,
              Math.round(integrateSourceOffsetToClipLocalMs(clip, srcOffsetMs)) + overhangMs + leadInMs
            );
          }
        }
      }

      reflowSpine(seq);
      return clip;
    }
  );

  return { clip: result, revision, verification };
}

export function setSpineTransition(options: {
  workspaceDir: string;
  clipId: string;
  transition: TransitionSpec | null;
}): { clip: SpineClip; revision: number; verification: VerificationReport } {
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.transition(${options.clipId})`,
    (seq) => {
      const clip = seq.spine.clips.find((c) => c.id === options.clipId);
      if (!clip) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.clipId));
      }
      clip.transition_out = options.transition;
      return clip;
    }
  );

  return { clip: result, revision, verification };
}

export function setItemEnvelope(options: {
  workspaceDir: string;
  targetId: string;
  parameter: ParameterEnvelope["parameter"];
  points: ParameterEnvelopePoint[];
}): { envelope: ParameterEnvelope; revision: number; verification: VerificationReport } {
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `envelope.set(${options.targetId},${options.parameter})`,
    (seq) => {
      const sortedPts = [...options.points]
        .map((pt) => ({
          ...pt,
          offset_ms: Number.isFinite(pt.offset_ms) ? Math.round(pt.offset_ms) : pt.offset_ms,
        }))
        .sort((a, b) => a.offset_ms - b.offset_ms);

      const dedupedPts: ParameterEnvelopePoint[] = [];
      for (const pt of sortedPts) {
        if (
          dedupedPts.length > 0 &&
          dedupedPts[dedupedPts.length - 1].offset_ms === pt.offset_ms
        ) {
          dedupedPts[dedupedPts.length - 1] = pt;
        } else {
          dedupedPts.push(pt);
        }
      }

      const newEnv: ParameterEnvelope = {
        parameter: options.parameter,
        points: dedupedPts,
      };

      const spineClip = seq.spine.clips.find((c) => c.id === options.targetId);
      if (spineClip) {
        const existingIdx = spineClip.envelopes.findIndex((e) => e.parameter === options.parameter);
        if (existingIdx >= 0) spineClip.envelopes[existingIdx] = newEnv;
        else spineClip.envelopes.push(newEnv);
        return newEnv;
      }

      for (const lane of seq.lanes) {
        const cue = lane.cues.find((c) => c.id === options.targetId);
        if (cue) {
          const existingIdx = cue.envelopes.findIndex((e) => e.parameter === options.parameter);
          if (existingIdx >= 0) cue.envelopes[existingIdx] = newEnv;
          else cue.envelopes.push(newEnv);
          return newEnv;
        }
      }

      throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.targetId));
    }
  );

  return { envelope: result, revision, verification };
}

export interface ReframeSpineOptions {
  workspaceDir: string;
  clipIds?: string[];
  mode?: "subject_track" | "center_lock" | "off";
  deadbandPct?: number;
  fixedCenterXPct?: number;
  manualPoints?: Array<{ offset_ms: number; center_x_pct: number; center_y_pct?: number }>;
  replaceManualPoints?: boolean;
  sampleFps?: number;
  dryRun?: boolean;
}

export interface ReframeSpineResult {
  dry_run: boolean;
  mode: "subject_track" | "center_lock" | "off";
  clips: PlannedClipReframe[];
  override_hint: string;
  revision: number;
  verification?: VerificationReport;
}

/**
 * Tracks the visual subject (speaker face or moving foreground object) across one or more
 * spine clips and configures `treatments.reframe`, `placement.scale_x`, `placement.x_pct`,
 * and `envelopes` (`placement.x_pct`) so that `brief`, `monitor`, and `render` all show
 * the exact same smooth, jitter-free subject-centered framing.
 */
export function reframeSpineClips(options: ReframeSpineOptions): ReframeSpineResult {
  const { sequence: initialSeq } = loadSequence(options.workspaceDir);
  const mode = options.mode ?? "subject_track";
  const dryRun = options.dryRun ?? false;

  const targetIds =
    options.clipIds && options.clipIds.length > 0
      ? options.clipIds
      : initialSeq.spine.clips.map((c) => c.id);

  if (targetIds.length === 0) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE("sp_01"));
  }

  for (const cid of targetIds) {
    if (!initialSeq.spine.clips.some((c) => c.id === cid)) {
      throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(cid));
    }
  }

  // Pre-analyze required library assets once (cached by SHA-256 in .cuthol/blobs)
  const trackByHandle = new Map<string, SubjectTrackAnalysis>();
  const needsAutoAnalysis =
    mode === "subject_track" &&
    !(options.manualPoints && options.manualPoints.length > 0 && options.replaceManualPoints);

  if (needsAutoAnalysis) {
    for (const cid of targetIds) {
      const clip = initialSeq.spine.clips.find((c) => c.id === cid)!;
      if (!trackByHandle.has(clip.asset_handle)) {
        const asset = initialSeq.library.find((x) => x.handle === clip.asset_handle);
        if (asset && asset.probe.has_video) {
          const track = analyzeAssetSubjectTrack({
            workspaceDir: options.workspaceDir,
            handle: clip.asset_handle,
            sampleFps: options.sampleFps,
          });
          trackByHandle.set(clip.asset_handle, track);
        }
      }
    }
  }

  const buildPlansForSequence = (seq: CutholSequence, applyMutations: boolean): PlannedClipReframe[] => {
    const plans: PlannedClipReframe[] = [];
    for (const cid of targetIds) {
      const clip = seq.spine.clips.find((c) => c.id === cid);
      if (!clip) continue;
      const asset = seq.library.find((x) => x.handle === clip.asset_handle);
      const assetW = asset?.probe.width ?? seq.stage.width;
      const assetH = asset?.probe.height ?? seq.stage.height;
      const track = trackByHandle.get(clip.asset_handle);

      // If patching existing reframe focal_points with manualPoints (without --replace),
      // merge manualPoints onto existing focal_points so cumulative manual edits are preserved.
      let effectiveManualPoints = options.manualPoints;
      let effectiveReplace = options.replaceManualPoints ?? false;

      if (
        options.manualPoints &&
        options.manualPoints.length > 0 &&
        !options.replaceManualPoints &&
        clip.treatments.reframe.enabled &&
        clip.treatments.reframe.focal_points.length > 0
      ) {
        const merged = clip.treatments.reframe.focal_points.map((fp) => ({
          offset_ms: fp.offset_ms,
          center_x_pct: fp.center_x_pct,
          center_y_pct: fp.center_y_pct,
        }));
        for (const mp of options.manualPoints) {
          const offMs = Math.max(0, Math.min(clip.duration_ms, Math.round(mp.offset_ms)));
          for (let j = merged.length - 1; j >= 0; j--) {
            if (Math.abs(merged[j].offset_ms - offMs) <= 1200) {
              merged.splice(j, 1);
            }
          }
          merged.push({
            offset_ms: offMs,
            center_x_pct: mp.center_x_pct,
            center_y_pct: mp.center_y_pct ?? 45,
          });
        }
        effectiveManualPoints = merged;
        effectiveReplace = true;
      }

      const plan = planCalmReframeTrajectory({
        clip,
        stageWidth: seq.stage.width,
        stageHeight: seq.stage.height,
        assetWidth: assetW,
        assetHeight: assetH,
        track,
        mode,
        deadbandPct: options.deadbandPct,
        fixedCenterXPct: options.fixedCenterXPct,
        manualPoints: effectiveManualPoints,
        replaceManualPoints: effectiveReplace,
        sourceMsToClipLocalMsFn: sourceMsToClipLocalMs,
        clipLocalMsToSourceMsFn: clipLocalMsToSourceMs,
      });

      if (applyMutations) {
        if (mode === "off") {
          clip.treatments.reframe = {
            enabled: false,
            mode: "center_lock",
            focal_points: [],
          };
          clip.placement.scale_x = 1;
          clip.placement.scale_y = 1;
          clip.placement.x_pct = 0;
          clip.envelopes = clip.envelopes.filter((e) => e.parameter !== "placement.x_pct");
        } else {
          clip.treatments.reframe = {
            enabled: plan.applied_pan || mode === "center_lock",
            mode,
            focal_points: plan.focal_points.map((fp) => ({
              offset_ms: fp.offset_ms,
              center_x_pct: fp.center_x_pct,
              center_y_pct: fp.center_y_pct,
              confidence: fp.confidence,
            })),
          };

          if (plan.applied_pan) {
            clip.placement.fit_mode = "cover";
            clip.placement.scale_x = plan.scale_x;
            clip.placement.scale_y = plan.scale_y;
            clip.placement.x_pct = plan.static_x_pct;
            if (plan.envelope_points.length > 1) {
              const existingIdx = clip.envelopes.findIndex((e) => e.parameter === "placement.x_pct");
              const newEnv: ParameterEnvelope = {
                parameter: "placement.x_pct",
                points: plan.envelope_points,
              };
              if (existingIdx >= 0) clip.envelopes[existingIdx] = newEnv;
              else clip.envelopes.push(newEnv);
            } else {
              clip.envelopes = clip.envelopes.filter((e) => e.parameter !== "placement.x_pct");
            }
          } else {
            clip.placement.scale_x = 1;
            clip.placement.scale_y = 1;
            clip.placement.x_pct = 0;
            clip.envelopes = clip.envelopes.filter((e) => e.parameter !== "placement.x_pct");
          }
        }
      }

      plans.push(plan);
    }
    return plans;
  };

  const firstClipId = targetIds[0] ?? "sp_01";
  const overrideHint = `cuthol spine reframe --clip ${firstClipId} --points 0ms:50,40000ms:64,78600ms:55`;

  if (dryRun) {
    const { sequence } = loadSequence(options.workspaceDir);
    const plans = buildPlansForSequence(sequence, false);
    return {
      dry_run: true,
      mode,
      clips: plans,
      override_hint: overrideHint,
      revision: sequence.meta.revision,
    };
  }

  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.reframe(${targetIds.join(",")},${mode})`,
    (seq) => buildPlansForSequence(seq, true)
  );

  return {
    dry_run: false,
    mode,
    clips: result,
    override_hint: overrideHint,
    revision,
    verification,
  };
}
