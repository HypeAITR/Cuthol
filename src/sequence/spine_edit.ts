// Spine edit operations: append, split, trim, excise, remove, reorder, transform, speed, transition, envelope, mute (split out of spine.ts).
import { resolveCueStartMs } from "../core/timeline.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  allocateNextHandle,
  createDefaultAudioChain,
  createDefaultPlacement,
  createDefaultTreatments, ParameterEnvelope,
  ParameterEnvelopePoint,
  SpatialPlacement,
  SpeedRampPoint,
  SpineClip,
  syncSequenceHandleCounters, TransitionSpec
} from "../core/schema.js";
import { minClipDurationMs } from "../core/time.js";
import { loadSequence } from "../core/workspace.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";
import { sliceEnvelopes, sliceReframeFocalPoints } from "./spine_envelope.js";
import { reflowSpine, clipLocalMsToSourceMs, sliceSpeedRamp, computeClipDurationMs, sourceMsToClipLocalMs, TimeCoordinateSpace, sequenceMsToSourceMs, invertClipLocalMsToSourceOffset, integrateSourceOffsetToClipLocalMs } from "./spine_time.js";

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

export function setSpineMute(options: {
  workspaceDir: string;
  clipIds?: string[];
  allSpine?: boolean;
  muted: boolean;
}): {
  clips: SpineClip[];
  muted_ids: string[];
  unmuted_ids: string[];
  revision: number;
  verification: VerificationReport;
} {
  const { sequence: initialSeq } = loadSequence(options.workspaceDir);
  const targetIds =
    options.allSpine || !options.clipIds || options.clipIds.length === 0
      ? initialSeq.spine.clips.map((c) => c.id)
      : options.clipIds;

  if (targetIds.length === 0) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE("sp_01"));
  }
  for (const cid of targetIds) {
    if (!initialSeq.spine.clips.some((c) => c.id === cid)) {
      throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(cid));
    }
  }

  const targetSet = new Set(targetIds);
  const opName = options.muted
    ? `spine.mute(${targetIds.join(",")})`
    : `spine.unmute(${targetIds.join(",")})`;

  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    opName,
    (seq) => {
      const updatedClips: SpineClip[] = [];
      const mutedIds: string[] = [];
      const unmutedIds: string[] = [];
      for (const clip of seq.spine.clips) {
        if (!targetSet.has(clip.id)) continue;
        clip.audio_chain.muted = options.muted;
        updatedClips.push(clip);
        if (options.muted) mutedIds.push(clip.id);
        else unmutedIds.push(clip.id);
      }
      return { updatedClips, mutedIds, unmutedIds };
    }
  );

  return {
    clips: result.updatedClips,
    muted_ids: result.mutedIds,
    unmuted_ids: result.unmutedIds,
    revision,
    verification,
  };
}
