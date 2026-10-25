// Adapts an audio lane cue to the spine dialogue-cleanup engine. The planner,
// acoustic edge guard, and candidate collectors are the spine functions. One
// cue is committed with exciseLaneCueRanges; several cues run that same
// in-memory excise inside one commitVerifiedMutation.

import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  createDefaultAudioChain,
  createDefaultTreatments,
  CutholSequence,
  getCuePlaybackRate,
  isStillGraphic,
  LaneCue,
  SpineClip,
} from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { resolveCueStartMs } from "../core/timeline.js";
import { loadSequence } from "../core/workspace.js";
import {
  applyLaneCueExciseToSequence,
  exciseLaneCueRanges,
  LaneExciseRippleAcross,
} from "../sequence/lanes.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";
import type { ContextualFillerReviewCandidate, DialogueCleanupResult } from "./cleanup.js";
import {
  buildPreservedUntranscribed,
  collectCleanupReviewAndRepetitionCandidates,
  collectTailWithoutAudioCandidates,
  createCleanupAssetLoaders,
  partitionRepetitionCandidates,
  resolveSelectedCutCandidates,
} from "./cleanup_candidates.js";
import { planTargetClipsCuts } from "./cleanup_plan.js";
import { buildCleanupTrace } from "./cleanup_trace.js";
import type { RepetitionRestartCandidate } from "./repetitions.js";

const AUDIO_CUE_KINDS = new Set(["voiceover", "music", "sfx"]);
const ACROSS_VALUES: readonly LaneExciseRippleAcross[] = [
  "lane",
  "all_lanes",
  "all",
  "spine",
  "none",
];

export function cleanupLaneCueDialogue(options: {
  workspaceDir: string;
  cueId?: string;
  cueIds?: string[];
  minPauseMs?: number;
  padMs?: number;
  removePauses?: boolean;
  removeFillers?: boolean;
  removeRepetitions?: boolean;
  cutCandidates?: string[];
  language?: string;
  dryRun?: boolean;
  across?: string;
}): DialogueCleanupResult {
  const across = resolveAcross(options.across);
  const { sequence } = loadSequence(options.workspaceDir);
  const cues = resolveCleanupCues(sequence, options);
  const virtualClips = cues.map((cue) => cueAsSpineClip(sequence, cue));
  const planningSequence: CutholSequence = {
    ...sequence,
    spine: { magnetic: sequence.spine.magnetic, clips: virtualClips },
  };

  const minPauseMs = options.minPauseMs ?? OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_MIN_PAUSE_MS;
  const padMs = options.padMs ?? OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_PAD_MS;
  const removePauses = options.removePauses ?? true;
  const removeFillers = options.removeFillers ?? true;
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
    getAssetAudioEndMs,
  } = createCleanupAssetLoaders({
    workspaceDir: options.workspaceDir,
    useAcousticFallback: false,
    language: options.language,
  });

  const { allReviewCandidates, allRepetitionCandidates } =
    collectCleanupReviewAndRepetitionCandidates({
      sequence: planningSequence,
      targetClips: virtualClips,
      getAssetTranscriptAndSpans,
      getAssetRepetitionCandidates,
    });

  const tailWithoutAudioCandidates = collectTailWithoutAudioCandidates({
    sequence: planningSequence,
    targetClips: virtualClips,
    getAssetAudioEndMs,
  });

  const { selectedReviewIds, selectedRepetitionIds, selectedTailIds, customSelectedSpansByAsset } =
    resolveSelectedCutCandidates({
      cutCandidates: options.cutCandidates,
      targetClips: virtualClips,
      allReviewCandidates,
      allRepetitionCandidates,
      tailWithoutAudioCandidates,
    });

  const { near: nearRepetitionCandidates, distant: distantRepetitionCandidates } =
    partitionRepetitionCandidates(allRepetitionCandidates);

  const {
    allPlannedCuts,
    allRejectedNearMisses,
    perClipCutRanges,
    silentRemnantClipsToRemove,
    totalSavedSourceMs,
    totalSavedSeqMs,
    globalSilenceFloorVal,
  } = planTargetClipsCuts({
    sequence: planningSequence,
    targetClips: virtualClips,
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

  const preservedUntranscribed = buildPreservedUntranscribed({
    cuts: allPlannedCuts,
    repetitionCandidates: allRepetitionCandidates,
    selectedSpansByAsset: customSelectedSpansByAsset,
  });

  const buildTrace = (rev: number) =>
    buildCleanupTrace({
      rev,
      allPlannedCuts,
      allRejectedNearMisses,
      allReviewCandidates,
      allRepetitionCandidates: nearRepetitionCandidates,
      distantRepetitionCount: distantRepetitionCandidates.length,
      preservedUntranscribedCount: preservedUntranscribed.length,
      tailWithoutAudioCount: tailWithoutAudioCandidates.length,
      targetClips: virtualClips,
      minRemainderTimelineMs,
      minPauseMs,
      padMs,
      removeFillers,
      globalSilenceFloorVal,
      totalSavedSourceMs,
      totalSavedSeqMs,
      options,
    });

  const cueIds = cues.map((cue) => cue.id);
  const cueIdSummary = cueIds.length === 1 ? cueIds[0] : cueIds.join(",");

  const resultBase = {
    clip_id: cueIdSummary,
    clip_ids: cueIds,
    clips_processed: cues.length,
    cue_id: cueIdSummary,
    cue_ids: cueIds,
    across,
    cuts_count: allPlannedCuts.length,
    saved_source_ms: totalSavedSourceMs,
    saved_sequence_ms: totalSavedSeqMs,
    cuts: allPlannedCuts,
    preserved_untranscribed: preservedUntranscribed,
  };

  if (dryRun || allPlannedCuts.length === 0) {
    return {
      ...resultBase,
      dry_run: dryRun,
      review_candidates: allReviewCandidates,
      repetition_candidates: nearRepetitionCandidates,
      distant_repetition_candidates: distantRepetitionCandidates,
      tail_without_audio_candidates: tailWithoutAudioCandidates,
      decision_trace: buildTrace(sequence.meta.revision),
      ...(dryRun ? {} : { revision: sequence.meta.revision }),
    };
  }

  const applied = applyCueCuts({
    workspaceDir: options.workspaceDir,
    virtualClips,
    perClipCutRanges,
    silentRemnantClipsToRemove,
    across,
  });

  return {
    ...resultBase,
    dry_run: false,
    review_candidates: filterReview(allReviewCandidates, selectedReviewIds),
    repetition_candidates: filterRepetition(nearRepetitionCandidates, selectedRepetitionIds),
    distant_repetition_candidates: filterRepetition(
      distantRepetitionCandidates,
      selectedRepetitionIds
    ),
    tail_without_audio_candidates: tailWithoutAudioCandidates.filter(
      (tail) => !selectedTailIds.has(tail.id)
    ),
    decision_trace: buildTrace(applied.revision),
    remaining_cues: applied.remainingCues,
    revision: applied.revision,
    verification: applied.verification,
  };
}

function resolveAcross(value: string | undefined): LaneExciseRippleAcross {
  if (value === undefined || value === "") return "lane";
  if ((ACROSS_VALUES as readonly string[]).includes(value)) {
    return value as LaneExciseRippleAcross;
  }
  throw new CutholError(DIAGNOSTICS.CLEANUP_BAD_ACROSS(value));
}

function resolveCleanupCues(
  sequence: CutholSequence,
  options: { cueId?: string; cueIds?: string[] }
): LaneCue[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const raws = [...(options.cueIds ?? [])];
  if (options.cueId) raws.push(options.cueId);
  for (const raw of raws) {
    for (const part of String(raw).split(",")) {
      const clean = part.trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      ordered.push(clean);
    }
  }
  if (ordered.length === 0) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE("cue"));
  }

  const cues: LaneCue[] = [];
  for (const id of ordered) {
    const cue = findCue(sequence, id);
    assertAudioCleanupCue(sequence, cue);
    cues.push(cue);
  }
  return cues;
}

function findCue(sequence: CutholSequence, cueId: string): LaneCue {
  for (const lane of sequence.lanes) {
    const cue = lane.cues.find((item) => item.id === cueId);
    if (cue) return cue;
  }
  throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(cueId));
}

function assertAudioCleanupCue(sequence: CutholSequence, cue: LaneCue): void {
  const visual =
    Boolean(cue.composition) ||
    cue.kind === "composition" ||
    cue.kind === "title" ||
    cue.kind === "caption" ||
    cue.kind === "broll" ||
    !AUDIO_CUE_KINDS.has(cue.kind) ||
    !cue.asset_handle;
  if (visual) {
    throw new CutholError(DIAGNOSTICS.CLEANUP_CUE_NOT_AUDIO(cue.id, cue.kind));
  }
  const asset = sequence.library.find((item) => item.handle === cue.asset_handle);
  if (!asset) {
    throw new CutholError(DIAGNOSTICS.DANGLING_ASSET_REF(cue.id, cue.asset_handle!));
  }
  if (isStillGraphic(asset) || !asset.probe.has_audio) {
    const kind = isStillGraphic(asset) ? "still_graphic" : cue.kind;
    throw new CutholError(DIAGNOSTICS.CLEANUP_CUE_NOT_AUDIO(cue.id, kind));
  }
}

function cueSourceBounds(
  sequence: CutholSequence,
  cue: LaneCue
): { sourceIn: number; sourceOut: number; rate: number } {
  const asset = sequence.library.find((item) => item.handle === cue.asset_handle);
  const rate = getCuePlaybackRate(cue);
  const sourceIn = cue.source_in_ms ?? 0;
  const rawSpanMs = Math.max(1, Math.round(cue.duration_ms * rate));
  const sourceOut =
    cue.source_out_ms ??
    (asset && !isStillGraphic(asset)
      ? Math.min(asset.probe.duration_ms, sourceIn + rawSpanMs)
      : sourceIn + rawSpanMs);
  return { sourceIn, sourceOut, rate };
}

function cueAsSpineClip(sequence: CutholSequence, cue: LaneCue): SpineClip {
  const { sourceIn, sourceOut, rate } = cueSourceBounds(sequence, cue);
  return {
    id: cue.id,
    asset_handle: cue.asset_handle!,
    source_in_ms: sourceIn,
    source_out_ms: sourceOut,
    timeline_in_ms: resolveCueStartMs(sequence, cue),
    duration_ms: Math.max(1, Math.round((sourceOut - sourceIn) / Math.max(rate, 0.01))),
    playback: {
      rate,
      preserve_pitch: cue.playback?.preserve_pitch ?? true,
      speed_ramp: null,
    },
    placement: structuredClone(cue.placement),
    audio_chain: cue.audio_chain ? structuredClone(cue.audio_chain) : createDefaultAudioChain(),
    treatments: createDefaultTreatments(),
    transition_out: null,
    envelopes: [],
  };
}

function filterReview(
  candidates: ContextualFillerReviewCandidate[],
  selectedIds: Set<string>
): ContextualFillerReviewCandidate[] {
  return candidates.filter((candidate) => !selectedIds.has(candidate.id));
}

function filterRepetition(
  candidates: RepetitionRestartCandidate[],
  selectedIds: Set<string>
): RepetitionRestartCandidate[] {
  return candidates.filter((candidate) => !selectedIds.has(candidate.id));
}

function applyCueCuts(params: {
  workspaceDir: string;
  virtualClips: SpineClip[];
  perClipCutRanges: Map<string, Array<{ start_ms: number; end_ms: number }>>;
  silentRemnantClipsToRemove: Set<string>;
  across: LaneExciseRippleAcross;
}): { remainingCues: LaneCue[]; revision: number; verification?: VerificationReport } {
  const jobs: Array<{ cueId: string; ranges: Array<{ start_ms: number; end_ms: number }> }> = [];
  for (const clip of params.virtualClips) {
    if (params.silentRemnantClipsToRemove.has(clip.id)) {
      jobs.push({
        cueId: clip.id,
        ranges: [{ start_ms: clip.source_in_ms, end_ms: clip.source_out_ms }],
      });
      continue;
    }
    const ranges = params.perClipCutRanges.get(clip.id);
    if (ranges && ranges.length > 0) {
      jobs.push({ cueId: clip.id, ranges });
    }
  }
  jobs.sort((a, b) => {
    const aClip = params.virtualClips.find((clip) => clip.id === a.cueId);
    const bClip = params.virtualClips.find((clip) => clip.id === b.cueId);
    return (aClip?.timeline_in_ms ?? 0) - (bClip?.timeline_in_ms ?? 0) || a.cueId.localeCompare(b.cueId);
  });

  if (jobs.length === 0) {
    const { sequence } = loadSequence(params.workspaceDir);
    return { remainingCues: [], revision: sequence.meta.revision };
  }

  if (jobs.length === 1) {
    const res = exciseLaneCueRanges({
      workspaceDir: params.workspaceDir,
      cueId: jobs[0].cueId,
      ranges: jobs[0].ranges,
      coordinateSpace: "source",
      across: params.across,
    });
    return {
      remainingCues: res.remainingCues,
      revision: res.revision,
      verification: res.verification,
    };
  }

  const committed = commitVerifiedMutation(
    params.workspaceDir,
    `speech.cleanup(${jobs.length}_cues)`,
    (seq) => {
      const pieceIds: string[] = [];
      for (const job of jobs) {
        const res = applyLaneCueExciseToSequence(seq, {
          cueId: job.cueId,
          ranges: job.ranges,
          coordinateSpace: "source",
          across: params.across,
        });
        for (const cue of res.newCues) pieceIds.push(cue.id);
      }
      return pieceIds
        .map((id) => {
          for (const lane of seq.lanes) {
            const cue = lane.cues.find((item) => item.id === id);
            if (cue) return structuredClone(cue);
          }
          return undefined;
        })
        .filter((cue): cue is LaneCue => cue !== undefined);
    }
  );
  return {
    remainingCues: committed.result,
    revision: committed.revision,
    verification: committed.verification,
  };
}
