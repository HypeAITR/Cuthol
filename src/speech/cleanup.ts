/**
 * Cuthol Dialogue Disfluency & Pause Cleanup Engine (`src/speech/cleanup.ts`).
 *
 * Identifies pauses (`>= minPauseMs`), filler words (`ıı`, `ee`, `şey`, `uh`, `um`),
 * contextual discourse fillers (`review_candidates`), and phrase repetitions / sentence
 * restarts (`repetition_candidates`) across a single `SpineClip`, a list of clips, or the
 * entire spine in a single atomic operation.
 */

import { DecisionTrace } from "../core/decision_trace.js";
import { SpineClip } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { loadSequence } from "../core/workspace.js";
import { VerificationReport } from "../verify/gates.js";
import { applyCleanupCutsToSpine } from "./cleanup_apply.js";
import {
  collectCleanupReviewAndRepetitionCandidates,
  createCleanupAssetLoaders,
  resolveCleanupTargetClips,
  resolveSelectedCutCandidates,
} from "./cleanup_candidates.js";
import { planTargetClipsCuts } from "./cleanup_plan.js";
import { buildCleanupTrace } from "./cleanup_trace.js";
import {
  detectRepetitionAndRestartCandidates,
  RepetitionAttempt,
  RepetitionRestartCandidate,
} from "./repetitions.js";

export {
  detectRepetitionAndRestartCandidates,
  RepetitionAttempt,
  RepetitionRestartCandidate,
};

export interface PlannedCutInterval {
  clip_id?: string;
  asset_handle?: string;
  candidate_id?: string;
  kind: "pause" | "filler" | "repetition";
  label: string;
  raw_source_start_ms: number;
  raw_source_end_ms: number;
  padded_source_start_ms: number;
  padded_source_end_ms: number;
  sequence_start_ms: number;
  sequence_end_ms: number;
  cut_duration_ms: number;
  original_source_start_ms?: number;
  original_source_end_ms?: number;
  trimmed_to_word_gap?: boolean;
  overlapping_words?: string[];
  acoustic_edge_trimmed?: boolean;
  split_around_untranscribed_audio?: boolean;
  untranscribed_audio_spans?: Array<{
    start_ms: number;
    end_ms: number;
    duration_ms: number;
    max_dbfs: number;
  }>;
  bridged_sliver_ms?: number;
}

export interface ContextualFillerReviewCandidate {
  id: string;
  clip_id?: string;
  asset_handle?: string;
  word: string;
  punctuated_word: string;
  source_start_ms: number;
  source_end_ms: number;
  duration_ms: number;
  sequence_start_ms: number;
  sequence_end_ms: number;
  gap_before_ms: number;
  gap_after_ms: number;
  context: string;
}

export interface DialogueCleanupResult {
  clip_id: string;
  clip_ids?: string[];
  clips_processed?: number;
  dry_run: boolean;
  cuts_count: number;
  saved_source_ms: number;
  saved_sequence_ms: number;
  cuts: PlannedCutInterval[];
  review_candidates: ContextualFillerReviewCandidate[];
  repetition_candidates: RepetitionRestartCandidate[];
  decision_trace: DecisionTrace;
  remaining_clips?: SpineClip[];
  revision?: number;
  verification?: VerificationReport;
}

export function cleanupClipDialogue(options: {
  workspaceDir: string;
  clipId?: string;
  clipIds?: string[];
  allSpine?: boolean;
  minPauseMs?: number;
  padMs?: number;
  removePauses?: boolean;
  removeFillers?: boolean;
  removeRepetitions?: boolean;
  cutCandidates?: string[];
  useAcousticFallback?: boolean;
  language?: string;
  dryRun?: boolean;
}): DialogueCleanupResult {
  const { sequence } = loadSequence(options.workspaceDir);
  const targetClips = resolveCleanupTargetClips(sequence, options);

  const minPauseMs = options.minPauseMs ?? OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_MIN_PAUSE_MS;
  const padMs = options.padMs ?? OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_PAD_MS;
  const removePauses = options.removePauses ?? true;
  const removeFillers = options.removeFillers ?? true;
  // Repetitions and restarts are listed as candidates for agent decision and never cut automatically by default
  const removeRepetitions = options.removeRepetitions ?? false;
  const dryRun = options.dryRun ?? false;

  const minSubClipTimelineMs = Math.ceil(
    (OPEN_STANDARDS.SIGNAL_SANITY.MIN_CLIP_FRAMES * 1000) / Math.max(1, sequence.stage.fps)
  );
  const minRemainderTimelineMs = Math.max(
    minSubClipTimelineMs,
    OPEN_STANDARDS.DIALOGUE_CLEANUP.MIN_REMAINDER_SLIVER_MS
  );

  const {
    getAssetTranscriptAndSpans,
    getAssetRepetitionCandidates,
    getAssetAcousticProfile,
  } = createCleanupAssetLoaders(options);

  const { allReviewCandidates, allRepetitionCandidates } =
    collectCleanupReviewAndRepetitionCandidates({
      sequence,
      targetClips,
      getAssetTranscriptAndSpans,
      getAssetRepetitionCandidates,
    });

  const { selectedReviewIds, selectedRepetitionIds, customSelectedSpansByAsset } =
    resolveSelectedCutCandidates({
      cutCandidates: options.cutCandidates,
      targetClips,
      allReviewCandidates,
      allRepetitionCandidates,
    });

  const {
    allPlannedCuts,
    allRejectedNearMisses,
    perClipCutRanges,
    silentRemnantClipsToRemove,
    totalSavedSourceMs,
    totalSavedSeqMs,
    globalSilenceFloorVal,
  } = planTargetClipsCuts({
    sequence,
    targetClips,
    customSelectedSpansByAsset,
    getAssetTranscriptAndSpans,
    getAssetAcousticProfile,
    minPauseMs,
    padMs,
    removePauses,
    removeFillers,
    removeRepetitions,
    minSubClipTimelineMs,
    minRemainderTimelineMs,
  });

  const buildTrace = (rev: number): DecisionTrace =>
    buildCleanupTrace({
      rev,
      allPlannedCuts,
      allRejectedNearMisses,
      allReviewCandidates,
      allRepetitionCandidates,
      targetClips,
      minRemainderTimelineMs,
      minPauseMs,
      padMs,
      removeFillers,
      globalSilenceFloorVal,
      totalSavedSourceMs,
      totalSavedSeqMs,
      options,
    });

  const clipIdSummary =
    targetClips.length === 1 ? targetClips[0].id : targetClips.map((c) => c.id).join(",");
  const clipIdsList = targetClips.map((c) => c.id);

  if (dryRun || allPlannedCuts.length === 0) {
    return {
      clip_id: clipIdSummary,
      clip_ids: clipIdsList,
      clips_processed: targetClips.length,
      dry_run: dryRun,
      cuts_count: allPlannedCuts.length,
      saved_source_ms: totalSavedSourceMs,
      saved_sequence_ms: totalSavedSeqMs,
      cuts: allPlannedCuts,
      review_candidates: allReviewCandidates,
      repetition_candidates: allRepetitionCandidates,
      decision_trace: buildTrace(sequence.meta.revision),
      ...(dryRun ? {} : { remaining_clips: targetClips, revision: sequence.meta.revision }),
    };
  }

  return applyCleanupCutsToSpine({
    workspaceDir: options.workspaceDir,
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
    buildCleanupTrace: buildTrace,
  });
}
