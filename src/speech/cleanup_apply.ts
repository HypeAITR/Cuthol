// Spine excision and verified sequence mutation for dialogue cleanup.

import { DecisionTrace } from "../core/decision_trace.js";
import { allocateNextHandle, CutholSequence, SpineClip } from "../core/schema.js";
import { minClipDurationMs } from "../core/time.js";
import {
  clipLocalMsToSourceMs,
  computeClipDurationMs,
  exciseSpineRanges,
  reflowSpine,
  sliceEnvelopes,
  sliceReframeFocalPoints,
  sliceSpeedRamp,
  sourceMsToClipLocalMs,
} from "../sequence/spine.js";
import { commitVerifiedMutation } from "../verify/gates.js";
import type {
  ContextualFillerReviewCandidate,
  DialogueCleanupResult,
  PlannedCutInterval,
} from "./cleanup.js";
import type { RepetitionRestartCandidate } from "./repetitions.js";

export function applyCleanupCutsToSpine(params: {
  workspaceDir: string;
  sequence: CutholSequence;
  targetClips: SpineClip[];
  clipIdSummary: string;
  clipIdsList: string[];
  allPlannedCuts: PlannedCutInterval[];
  perClipCutRanges: Map<string, Array<{ start_ms: number; end_ms: number }>>;
  silentRemnantClipsToRemove: Set<string>;
  totalSavedSourceMs: number;
  totalSavedSeqMs: number;
  allReviewCandidates: ContextualFillerReviewCandidate[];
  allRepetitionCandidates: RepetitionRestartCandidate[];
  selectedReviewIds: Set<string>;
  selectedRepetitionIds: Set<string>;
  buildCleanupTrace: (rev: number) => DecisionTrace;
}): DialogueCleanupResult {
  const {
    workspaceDir,
    sequence,
    targetClips,
    clipIdSummary,
    clipIdsList,
    allPlannedCuts,
    perClipCutRanges,
    silentRemnantClipsToRemove,
    totalSavedSourceMs,
    totalSavedSeqMs,
    allReviewCandidates,
    allRepetitionCandidates,
    selectedReviewIds,
    selectedRepetitionIds,
    buildCleanupTrace,
  } = params;

  // Single-clip fast path uses exciseSpineRanges directly for 100% identical journal label when 1 clip is cleaned
  if (targetClips.length === 1 && silentRemnantClipsToRemove.size === 0) {
    const clip = targetClips[0];
    const exciseRes = exciseSpineRanges({
      workspaceDir,
      clipId: clip.id,
      ranges: allPlannedCuts.map((c) => ({
        start_ms: c.padded_source_start_ms,
        end_ms: c.padded_source_end_ms,
      })),
      coordinateSpace: "source",
    });

    return {
      clip_id: clip.id,
      clip_ids: [clip.id],
      clips_processed: 1,
      dry_run: false,
      cuts_count: allPlannedCuts.length,
      saved_source_ms: totalSavedSourceMs,
      saved_sequence_ms: totalSavedSeqMs,
      cuts: allPlannedCuts,
      review_candidates: allReviewCandidates.filter((rc) => !selectedReviewIds.has(rc.id)),
      repetition_candidates: allRepetitionCandidates.filter(
        (rr) => !selectedRepetitionIds.has(rr.id)
      ),
      decision_trace: buildCleanupTrace(exciseRes.revision),
      remaining_clips: exciseRes.remainingClips,
      revision: exciseRes.revision,
      verification: exciseRes.verification,
    };
  }

  // Multi-clip / full-spine atomic excision in a single journal revision
  const opLabel =
    targetClips.length === sequence.spine.clips.length
      ? `speech.cleanup(all_spine,${targetClips.length}_clips)`
      : `speech.cleanup(${targetClips.length}_clips)`;

  const { result: remainingClips, revision, verification } = commitVerifiedMutation(
    workspaceDir,
    opLabel,
    (seq) => {
      const minFrameDurMs = minClipDurationMs(seq.stage.fps, 2);
      const existingIds = new Set(seq.spine.clips.map((c) => c.id));

      for (const targetOrig of targetClips) {
        const idx = seq.spine.clips.findIndex((c) => c.id === targetOrig.id);
        if (idx === -1) continue;
        const target = seq.spine.clips[idx];

        if (silentRemnantClipsToRemove.has(target.id)) {
          if (seq.spine.clips.length > 1) {
            const fallbackClip = seq.spine.clips[idx > 0 ? idx - 1 : idx + 1];
            for (const lane of seq.lanes) {
              for (const cue of lane.cues) {
                if (cue.anchor && cue.anchor.ref === target.id && fallbackClip) {
                  cue.anchor = { ref: fallbackClip.id, offset_ms: 0 };
                }
              }
            }
            seq.spine.clips.splice(idx, 1);
          }
          continue;
        }

        const mergedCuts = perClipCutRanges.get(target.id);
        if (!mergedCuts || mergedCuts.length === 0) continue;

        const rawKeptIntervals: Array<{ start: number; end: number }> = [];
        let cursor = target.source_in_ms;
        for (const cut of mergedCuts) {
          const cStart = Math.max(target.source_in_ms, cut.start_ms);
          const cEnd = Math.min(target.source_out_ms, cut.end_ms);
          if (cEnd <= cStart) continue;
          if (cStart > cursor) {
            rawKeptIntervals.push({ start: cursor, end: cStart });
          }
          cursor = Math.max(cursor, cEnd);
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
          const fallbackClip = seq.spine.clips[idx > 0 ? idx - 1 : idx + 1];
          for (const lane of seq.lanes) {
            if (fallbackClip) {
              for (const cue of lane.cues) {
                if (cue.anchor && cue.anchor.ref === target.id) {
                  cue.anchor = { ref: fallbackClip.id, offset_ms: 0 };
                }
              }
            } else {
              lane.cues = lane.cues.filter((cue) => cue.anchor?.ref !== target.id);
            }
          }
        } else {
          for (const lane of seq.lanes) {
            for (const cue of lane.cues) {
              if (cue.anchor && cue.anchor.ref === target.id) {
                const overhangMs = Math.max(0, cue.anchor.offset_ms - target.duration_ms);
                const leadInMs = Math.min(0, cue.anchor.offset_ms);
                const cueSrcMs = clipLocalMsToSourceMs(target, cue.anchor.offset_ms);
                const matchingSub =
                  newClips.find(
                    (sub) => cueSrcMs >= sub.source_in_ms && cueSrcMs <= sub.source_out_ms
                  ) ??
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
      }

      reflowSpine(seq);
      return seq.spine.clips;
    }
  );

  return {
    clip_id: clipIdSummary,
    clip_ids: clipIdsList,
    clips_processed: targetClips.length,
    dry_run: false,
    cuts_count: allPlannedCuts.length,
    saved_source_ms: totalSavedSourceMs,
    saved_sequence_ms: totalSavedSeqMs,
    cuts: allPlannedCuts,
    review_candidates: allReviewCandidates.filter((rc) => !selectedReviewIds.has(rc.id)),
    repetition_candidates: allRepetitionCandidates.filter(
      (rr) => !selectedRepetitionIds.has(rr.id)
    ),
    decision_trace: buildCleanupTrace(revision),
    remaining_clips: remainingClips,
    revision,
    verification,
  };
}
