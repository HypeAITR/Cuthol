// Beat alignment of spine cut points (split out of audio_mix.ts).
import { DecisionTrace, DecisionTraceItem } from "../core/decision_trace.js";
import { maxSourceDurationMs } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { analyzeAssetBeats } from "../library/beats.js";
import {
  clipLocalMsToSourceMs,
  computeClipDurationMs,
  integrateSourceOffsetToClipLocalMs,
  reflowSpine,
  sliceEnvelopes,
  sliceSpeedRamp
} from "../sequence/spine.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";

/**
 * Aligns the cut points (`duration_ms` / `source_out_ms`) of target `spine` clips
 * to the detected musical beats (`beats_ms[]`) of `bgmHandle` within `toleranceMs`.
 */
export function alignClipsToBeats(options: {
  workspaceDir: string;
  bgmHandle: string;
  clipIds?: string[];
  sensitivity?: number;
  toleranceMs?: number;
  preserveDuration?: boolean;
  alignTo?: "grid" | "onsets";
  useGrid?: boolean;
}): {
  bgm_handle: string;
  align_mode: "grid" | "onsets";
  estimated_bpm: number;
  phase_ms: number;
  tolerance_ms: number;
  old_total_duration_ms: number;
  new_total_duration_ms: number;
  total_duration_delta_ms: number;
  duration_warning?: string;
  aligned_clips: Array<{
    clip_id: string;
    old_duration_ms: number;
    new_duration_ms: number;
    shift_ms: number;
    beat_time_ms: number;
    reason_code: "SHIFTED_TO_BEAT" | "ALREADY_ON_BEAT";
  }>;
  skipped_clips: Array<{
    clip_id: string;
    duration_ms: number;
    nearest_beat_ms: number | null;
    distance_ms: number | null;
    reason_code: "OUT_OF_TOLERANCE" | "NO_VALID_BEAT_IN_RANGE";
  }>;
  decision_trace: DecisionTrace;
  revision: number;
  verification: VerificationReport;
} {
  const beatAnalysis = analyzeAssetBeats({
    workspaceDir: options.workspaceDir,
    handle: options.bgmHandle,
    sensitivity: options.sensitivity,
  });

  const requestedMode: "grid" | "onsets" =
    options.alignTo === "onsets" || options.useGrid === false ? "onsets" : "grid";
  const hasGrid = Array.isArray(beatAnalysis.grid_ms) && beatAnalysis.grid_ms.length > 0;
  const alignMode: "grid" | "onsets" = requestedMode === "grid" && hasGrid ? "grid" : "onsets";
  const beats =
    alignMode === "grid"
      ? beatAnalysis.grid_ms
      : (beatAnalysis.onsets_ms ?? beatAnalysis.beats_ms);
  const beatPeriodMs = beatAnalysis.estimated_bpm > 0 ? 60_000 / beatAnalysis.estimated_bpm : 500;
  const defaultToleranceMs = Math.max(120, Math.min(500, Math.round(beatPeriodMs * 0.5)));
  const toleranceMs =
    options.toleranceMs !== undefined && Number.isFinite(options.toleranceMs)
      ? Math.max(20, Math.round(options.toleranceMs))
      : defaultToleranceMs;
  const preserveDuration = options.preserveDuration ?? false;

  const targetSet = options.clipIds ? new Set(options.clipIds) : null;

  const alignedSpanById = new Map<string, [number, number]>();
  const skippedTargetClips: Array<{
    clip_id: string;
    duration_ms: number;
    desired_end_ms: number;
    nearest_beat_ms: number | null;
    distance_ms: number | null;
    span: [number, number];
    min_allowed_ms: number;
    max_timeline_ms: number;
    reason_code: "OUT_OF_TOLERANCE" | "NO_VALID_BEAT_IN_RANGE";
  }> = [];

  let oldTotalDurationMs = 0;
  let newTotalDurationMs = 0;

  const { result: aligned, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `mix.beat-align(${options.bgmHandle})`,
    (seq) => {
      oldTotalDurationMs = seq.spine.clips.reduce((acc, c) => acc + c.duration_ms, 0);
      const libMap = new Map(seq.library.map((x) => [x.handle, x]));
      const changes: Array<{
        clip_id: string;
        old_duration_ms: number;
        new_duration_ms: number;
        shift_ms: number;
        beat_time_ms: number;
        reason_code: "SHIFTED_TO_BEAT" | "ALREADY_ON_BEAT";
      }> = [];

      let runningTimelineMs = 0;
      const minFrameDurMs = Math.ceil(
        (OPEN_STANDARDS.SIGNAL_SANITY.MIN_CLIP_FRAMES * 1000) / Math.max(1, seq.stage.fps)
      );

      for (let idx = 0; idx < seq.spine.clips.length; idx++) {
        const clip = seq.spine.clips[idx];
        const prevClip = idx > 0 ? seq.spine.clips[idx - 1] : null;
        const oldDur = clip.duration_ms;
        const oldSourceSpan = Math.max(1, clip.source_out_ms - clip.source_in_ms);
        if (targetSet && !targetSet.has(clip.id)) {
          runningTimelineMs += oldDur;
          continue;
        }

        const asset = libMap.get(clip.asset_handle);
        const maxSourceOut = asset ? maxSourceDurationMs(asset) : clip.source_out_ms;
        const maxSourceSpan = Math.max(1, maxSourceOut - clip.source_in_ms);
        const extendedRamp =
          clip.playback.speed_ramp && clip.playback.speed_ramp.length > 0 && maxSourceSpan > oldSourceSpan
            ? [
                ...clip.playback.speed_ramp,
                {
                  source_offset_ms: maxSourceSpan,
                  rate: clip.playback.speed_ramp[clip.playback.speed_ramp.length - 1].rate,
                },
              ]
            : clip.playback.speed_ramp;
        const tempMaxClip = {
          ...clip,
          source_out_ms: clip.source_in_ms + maxSourceSpan,
          playback: { ...clip.playback, speed_ramp: extendedRamp },
        };
        const maxTimelineDur = Math.max(
          1,
          Math.floor(integrateSourceOffsetToClipLocalMs(tempMaxClip, maxSourceSpan))
        );
        const desiredEndMs = runningTimelineMs + oldDur;
        const minTransitionBudgetMs = Math.max(
          (clip.transition_out?.duration_ms ?? 0) * 2,
          (prevClip?.transition_out?.duration_ms ?? 0) * 2
        );
        const minAllowedDur = Math.max(200, minFrameDurMs, minTransitionBudgetMs);

        // Find closest beat >= runningTimelineMs + minAllowedDur and <= runningTimelineMs + maxTimelineDur
        let bestBeat: number | null = null;
        let bestDist = Number.MAX_SAFE_INTEGER;
        for (const b of beats) {
          if (b < runningTimelineMs + minAllowedDur) continue;
          if (b > runningTimelineMs + maxTimelineDur) break;
          const dist = Math.abs(b - desiredEndMs);
          if (dist < bestDist) {
            bestDist = dist;
            bestBeat = b;
          }
        }

        if (bestBeat !== null && bestDist <= toleranceMs) {
          const targetDur = bestBeat - runningTimelineMs;
          let actualNewDur = oldDur;
          if (targetDur !== oldDur) {
            const mappedSourceOut = clipLocalMsToSourceMs(tempMaxClip, targetDur);
            const newSourceOut = Math.max(
              clip.source_in_ms + 1,
              Math.min(maxSourceOut, mappedSourceOut)
            );
            const newSourceSpan = Math.max(1, newSourceOut - clip.source_in_ms);
            if (clip.playback.speed_ramp && clip.playback.speed_ramp.length > 0) {
              clip.playback.speed_ramp = sliceSpeedRamp(
                extendedRamp,
                Math.max(oldSourceSpan, newSourceSpan),
                clip.playback.rate,
                0,
                newSourceSpan
              );
            }
            clip.source_out_ms = newSourceOut;
            actualNewDur = computeClipDurationMs(clip);
            clip.duration_ms = actualNewDur;
            clip.envelopes = sliceEnvelopes(clip.envelopes, 0, actualNewDur);

            for (const lane of seq.lanes) {
              for (const cue of lane.cues) {
                if (cue.anchor?.ref === clip.id && cue.anchor.offset_ms > actualNewDur) {
                  cue.anchor.offset_ms = Math.max(0, Math.min(actualNewDur, cue.anchor.offset_ms));
                }
              }
            }
          }

          const shiftMs = actualNewDur - oldDur;
          changes.push({
            clip_id: clip.id,
            old_duration_ms: oldDur,
            new_duration_ms: actualNewDur,
            shift_ms: shiftMs,
            beat_time_ms: bestBeat,
            reason_code: shiftMs === 0 ? "ALREADY_ON_BEAT" : "SHIFTED_TO_BEAT",
          });
        } else if (bestBeat !== null) {
          skippedTargetClips.push({
            clip_id: clip.id,
            duration_ms: oldDur,
            desired_end_ms: desiredEndMs,
            nearest_beat_ms: bestBeat,
            distance_ms: bestDist,
            span: [runningTimelineMs, runningTimelineMs + oldDur],
            min_allowed_ms: runningTimelineMs + minAllowedDur,
            max_timeline_ms: runningTimelineMs + maxTimelineDur,
            reason_code: "OUT_OF_TOLERANCE",
          });
        } else {
          skippedTargetClips.push({
            clip_id: clip.id,
            duration_ms: oldDur,
            desired_end_ms: desiredEndMs,
            nearest_beat_ms: null,
            distance_ms: null,
            span: [runningTimelineMs, runningTimelineMs + oldDur],
            min_allowed_ms: runningTimelineMs + minAllowedDur,
            max_timeline_ms: runningTimelineMs + maxTimelineDur,
            reason_code: "NO_VALID_BEAT_IN_RANGE",
          });
        }

        runningTimelineMs += clip.duration_ms;
      }

      if (preserveDuration && seq.spine.clips.length > 0 && runningTimelineMs !== oldTotalDurationMs) {
        const lastClip = seq.spine.clips[seq.spine.clips.length - 1];
        const prevClip = seq.spine.clips.length > 1 ? seq.spine.clips[seq.spine.clips.length - 2] : null;
        const asset = libMap.get(lastClip.asset_handle);
        const maxSourceOut = asset ? maxSourceDurationMs(asset) : lastClip.source_out_ms;
        const maxSourceSpan = Math.max(1, maxSourceOut - lastClip.source_in_ms);
        const tempMaxClip = { ...lastClip, source_out_ms: lastClip.source_in_ms + maxSourceSpan };
        const maxTimelineDur = Math.max(
          1,
          Math.floor(integrateSourceOffsetToClipLocalMs(tempMaxClip, maxSourceSpan))
        );
        const minTransitionBudgetMs = Math.max(
          (lastClip.transition_out?.duration_ms ?? 0) * 2,
          (prevClip?.transition_out?.duration_ms ?? 0) * 2
        );
        const minAllowedDur = Math.max(200, minFrameDurMs, minTransitionBudgetMs);
        const prefixDur = runningTimelineMs - lastClip.duration_ms;
        const wantedLastDur = Math.max(
          minAllowedDur,
          Math.min(maxTimelineDur, oldTotalDurationMs - prefixDur)
        );
        const mappedSourceOut = clipLocalMsToSourceMs(tempMaxClip, wantedLastDur);
        lastClip.source_out_ms = Math.max(
          lastClip.source_in_ms + 1,
          Math.min(maxSourceOut, mappedSourceOut)
        );
        lastClip.duration_ms = computeClipDurationMs(lastClip);
        lastClip.envelopes = sliceEnvelopes(lastClip.envelopes, 0, lastClip.duration_ms);
      }

      // Ensure transition_out budgets remain valid across all neighbor pairs after duration adjustments
      for (let i = 0; i < seq.spine.clips.length; i++) {
        const curr = seq.spine.clips[i];
        if (curr.transition_out) {
          const next = seq.spine.clips[i + 1];
          const maxTrans = next
            ? Math.floor(Math.min(curr.duration_ms, next.duration_ms) / 2)
            : Math.floor(curr.duration_ms / 2);
          if (curr.transition_out.duration_ms > maxTrans) {
            curr.transition_out =
              maxTrans > 0 ? { ...curr.transition_out, duration_ms: maxTrans } : null;
          }
        }
      }

      reflowSpine(seq);
      newTotalDurationMs = seq.spine.clips.reduce((acc, c) => acc + c.duration_ms, 0);
      for (const clip of seq.spine.clips) {
        alignedSpanById.set(clip.id, [clip.timeline_in_ms, clip.timeline_in_ms + clip.duration_ms]);
      }
      return changes;
    }
  );

  const totalDurationDeltaMs = newTotalDurationMs - oldTotalDurationMs;
  const significantDurationChange =
    Math.abs(totalDurationDeltaMs) > Math.max(toleranceMs, 500) ||
    (oldTotalDurationMs > 0 && Math.abs(totalDurationDeltaMs) / oldTotalDurationMs > 0.08);
  const durationWarning = significantDurationChange
    ? `Total spine duration changed noticeably: ${oldTotalDurationMs}ms -> ${newTotalDurationMs}ms (${totalDurationDeltaMs >= 0 ? "+" : ""}${totalDurationDeltaMs}ms). To keep the duration, use '--preserve-duration' or a tighter '--tolerance'.`
    : undefined;

  const beatDecisions: DecisionTraceItem[] = aligned.map((c) => {
    const shiftMs = c.new_duration_ms - c.old_duration_ms;
    const isAlreadyOnBeat = shiftMs === 0;
    return {
      id: c.clip_id,
      span: alignedSpanById.get(c.clip_id) ?? [0, c.new_duration_ms],
      action: isAlreadyOnBeat ? "applied" : "shifted",
      reason_code: isAlreadyOnBeat ? "ALREADY_ON_BEAT" : "SHIFTED_TO_BEAT",
      measured: {
        old_duration_ms: c.old_duration_ms,
        new_duration_ms: c.new_duration_ms,
        shift_ms: shiftMs,
        beat_time_ms: c.beat_time_ms,
      },
      threshold: {
        tolerance_ms: toleranceMs,
      },
      ...(isAlreadyOnBeat
        ? {
            note: `'${c.clip_id}' end point (${c.beat_time_ms}ms) already sits on a music beat, so it was not shifted (0ms)`,
          }
        : {}),
    };
  });

  const beatNearMisses: DecisionTraceItem[] = skippedTargetClips.map((s): DecisionTraceItem => {
    if (s.reason_code === "OUT_OF_TOLERANCE") {
      return {
        id: s.clip_id,
        span: alignedSpanById.get(s.clip_id) ?? s.span,
        action: "skipped",
        reason_code: "OUT_OF_TOLERANCE",
        measured: {
          duration_ms: s.duration_ms,
          desired_end_ms: s.desired_end_ms,
          nearest_beat_ms: s.nearest_beat_ms ?? 0,
          distance_ms: s.distance_ms ?? 0,
        },
        threshold: {
          tolerance_ms: toleranceMs,
        },
        margin: (s.distance_ms ?? 0) - toleranceMs,
        note: `nearest beat to the '${s.clip_id}' end point (${s.desired_end_ms}ms) is ${s.nearest_beat_ms}ms (${s.distance_ms}ms away > tolerance ±${toleranceMs}ms); clip duration unchanged`,
      };
    }
    return {
      id: s.clip_id,
      span: alignedSpanById.get(s.clip_id) ?? s.span,
      action: "skipped",
      reason_code: "NO_VALID_BEAT_IN_RANGE",
      threshold: {
        min_end_ms: s.min_allowed_ms,
        max_end_ms: s.max_timeline_ms,
        tolerance_ms: toleranceMs,
      },
      note: `no music beat found in the valid duration range of clip '${s.clip_id}' (${s.min_allowed_ms}..${s.max_timeline_ms}ms)`,
    };
  });

  const allBeatDecisions = [...beatDecisions, ...beatNearMisses].sort(
    (a, b) => a.span[0] - b.span[0]
  );
  const byReason: Record<string, number> = {};
  for (const d of allBeatDecisions) {
    byReason[d.reason_code] = (byReason[d.reason_code] ?? 0) + 1;
  }

  const shiftedCount = aligned.filter((c) => c.shift_ms !== 0).length;
  const alreadyOnBeatCount = aligned.filter((c) => c.shift_ms === 0).length;
  const outOfTolCount = skippedTargetClips.filter((s) => s.reason_code === "OUT_OF_TOLERANCE").length;
  const summaryParts = [
    `${aligned.length}/${allBeatDecisions.length} clips aligned to '${options.bgmHandle}' ${alignMode === "grid" ? "beat grid" : "onsets"} (${beatAnalysis.estimated_bpm} BPM, phase ${beatAnalysis.phase_ms ?? 0}ms, tolerance ±${toleranceMs}ms) (${shiftedCount} shifted, ${alreadyOnBeatCount} already on beat)`,
  ];
  if (outOfTolCount > 0) {
    summaryParts.push(`${outOfTolCount} clips kept untouched for falling outside the tolerance (OUT_OF_TOLERANCE)`);
  }
  if (durationWarning) {
    summaryParts.push(`WARNING: ${durationWarning}`);
  }

  const decisionTrace: DecisionTrace = {
    trace_id: `tr_beat_r${revision}`,
    feature: "beat_align",
    algorithm: { id: "beat.snap-nearest-tolerant", version: "2.2.0" },
    revision,
    params: {
      bgm_handle: { value: options.bgmHandle, default: options.bgmHandle, source: "user" },
      align_mode: {
        value: alignMode,
        default: "grid",
        source: options.alignTo !== undefined || options.useGrid !== undefined ? "user" : "default",
      },
      sensitivity: {
        value: options.sensitivity ?? 1.35,
        default: 1.35,
        source: options.sensitivity !== undefined ? "user" : "default",
      },
      tolerance_ms: {
        value: toleranceMs,
        default: defaultToleranceMs,
        unit: "ms",
        source: options.toleranceMs !== undefined ? "user" : "default",
      },
      preserve_duration: {
        value: preserveDuration,
        default: false,
        source: options.preserveDuration !== undefined ? "user" : "default",
      },
    },
    rules: [
      `R1: Each target clip's end point is aligned only to the nearest music beat (${alignMode === "grid" ? "grid_ms" : "onsets_ms"}) within ±${toleranceMs}ms`,
      "R2: Clips whose nearest beat is outside the tolerance are left untouched and marked OUT_OF_TOLERANCE",
      "R3: The physical source duration (probe.duration_ms) and transition (transition_out) lower bounds are kept",
    ],
    summary: {
      text: summaryParts.join("; "),
      candidates: allBeatDecisions.length,
      accepted: aligned.length,
      rejected: beatNearMisses.length,
      by_reason: byReason,
      effect: {
        aligned_count: aligned.length,
        shifted_count: shiftedCount,
        already_on_beat_count: alreadyOnBeatCount,
        skipped_count: beatNearMisses.length,
        tolerance_ms: toleranceMs,
        estimated_bpm: beatAnalysis.estimated_bpm,
        phase_ms: beatAnalysis.phase_ms ?? 0,
        old_total_duration_ms: oldTotalDurationMs,
        new_total_duration_ms: newTotalDurationMs,
        total_duration_delta_ms: totalDurationDeltaMs,
      },
    },
    decisions: allBeatDecisions,
    near_misses: beatNearMisses,
  };

  return {
    bgm_handle: options.bgmHandle,
    align_mode: alignMode,
    estimated_bpm: beatAnalysis.estimated_bpm,
    phase_ms: beatAnalysis.phase_ms ?? 0,
    tolerance_ms: toleranceMs,
    old_total_duration_ms: oldTotalDurationMs,
    new_total_duration_ms: newTotalDurationMs,
    total_duration_delta_ms: totalDurationDeltaMs,
    ...(durationWarning ? { duration_warning: durationWarning } : {}),
    aligned_clips: aligned,
    skipped_clips: skippedTargetClips.map((s) => ({
      clip_id: s.clip_id,
      duration_ms: s.duration_ms,
      nearest_beat_ms: s.nearest_beat_ms,
      distance_ms: s.distance_ms,
      reason_code: s.reason_code,
    })),
    decision_trace: decisionTrace,
    revision,
    verification,
  };
}
