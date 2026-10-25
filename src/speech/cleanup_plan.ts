// Per-clip disfluency and pause cut planning, collar padding, and remnant sliver guards.

import { DecisionTraceItem } from "../core/decision_trace.js";
import { CutholSequence, SpineClip } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { measureAssetAcousticWindows } from "../library/waveform.js";
import { sourceMsToSequenceMs } from "../sequence/spine.js";
import type { PlannedCutInterval } from "./cleanup.js";
import {
  RawCandidate,
  refineSelectedCandidateSpanAcoustically,
  verifyPauseCandidatesAcoustically,
} from "./cleanup_acoustic.js";
import type { CleanupAssetLoaders, SelectedCandidateSpan } from "./cleanup_candidates.js";
import {
  DetectedDisfluencySpan,
  isContextualFillerIsolated,
  isContextualFillerToken,
  RawTranscriptWord,
} from "./providers.js";

export function collectClipRawCandidates(params: {
  clip: SpineClip;
  selectedSpans: SelectedCandidateSpan[];
  spans: DetectedDisfluencySpan[];
  transcriptWords: RawTranscriptWord[];
  docDurationMs: number;
  acousticProfile: ReturnType<typeof measureAssetAcousticWindows>;
  minPauseMs: number;
  padMs: number;
  removePauses: boolean;
  removeFillers: boolean;
  removeRepetitions: boolean;
  rejectedNearMisses: DecisionTraceItem[];
}): {
  mergedPauseCandidates: RawCandidate[];
  rawNonPauseCandidates: RawCandidate[];
} {
  const {
    clip,
    selectedSpans,
    spans,
    transcriptWords,
    docDurationMs,
    acousticProfile,
    minPauseMs,
    padMs,
    removePauses,
    removeFillers,
    removeRepetitions,
    rejectedNearMisses,
  } = params;

  const rawPauseCandidates: RawCandidate[] = [];
  const rawNonPauseCandidates: RawCandidate[] = [];

  // Schedule any user-selected candidates (`cut_candidates`) that fall inside `clip`
  for (const sel of selectedSpans) {
    const clampedStart = Math.max(clip.source_in_ms, sel.startMs);
    const clampedEnd = Math.min(clip.source_out_ms, sel.endMs);
    if (clampedEnd <= clampedStart) continue;

    const refined = refineSelectedCandidateSpanAcoustically({
      clip,
      rawStart: clampedStart,
      rawEnd: clampedEnd,
      padMs,
      minPauseMs,
      transcriptWords,
      acousticProfile,
    });

    if (refined.endMs > refined.startMs) {
      rawNonPauseCandidates.push({
        kind: sel.kind,
        candidateId: sel.candidateId,
        label: sel.label,
        rawStart: refined.startMs,
        rawEnd: refined.endMs,
        wordGapStart: refined.startMs,
        wordGapEnd: refined.endMs,
        origStart: clampedStart,
        origEnd: clampedEnd,
        trimmedToWordGap: false,
        overlappingWords: [],
        acousticEdgeTrimmed: refined.acousticEdgeTrimmed,
        splitAroundUntranscribedAudio: refined.splitAroundUntranscribedAudio,
        untranscribedAudioSpans: refined.untranscribedAudioSpans,
      });
    }
  }

  for (let sIdx = 0; sIdx < spans.length; sIdx++) {
    const span = spans[sIdx];
    if (span.kind === "pause" && !removePauses) continue;
    if (span.kind === "filler" && !removeFillers) continue;
    if (span.kind === "repetition" && !removeRepetitions) continue;

    if (span.kind === "filler" && isContextualFillerToken(span.label) && transcriptWords.length > 0) {
      const wIdx = transcriptWords.findIndex(
        (w) =>
          Math.abs(w.source_start_ms - span.source_start_ms) <= 50 &&
          Math.abs(w.source_end_ms - span.source_end_ms) <= 50
      );
      if (wIdx >= 0) {
        const w = transcriptWords[wIdx];
        const gapBeforeMs =
          wIdx > 0 ? w.source_start_ms - transcriptWords[wIdx - 1].source_end_ms : w.source_start_ms;
        const gapAfterMs =
          wIdx + 1 < transcriptWords.length
            ? transcriptWords[wIdx + 1].source_start_ms - w.source_end_ms
            : docDurationMs - w.source_end_ms;
        if (!isContextualFillerIsolated(gapBeforeMs, gapAfterMs)) {
          continue;
        }
      }
    }

    const origStart = Math.max(clip.source_in_ms, span.source_start_ms);
    const origEnd = Math.min(clip.source_out_ms, span.source_end_ms);
    if (origEnd <= origStart) continue;

    if (span.kind !== "pause") {
      rawNonPauseCandidates.push({
        kind: span.kind,
        label: span.label,
        rawStart: origStart,
        rawEnd: origEnd,
        wordGapStart: origStart,
        wordGapEnd: origEnd,
        origStart,
        origEnd,
        trimmedToWordGap: false,
        overlappingWords: [],
      });
      continue;
    }

    let candidateStart = origStart;
    const candidateEnd = origEnd;
    if (span.label.startsWith("<pause") && transcriptWords.length > 0) {
      const nextIdx = transcriptWords.findIndex((w) => w.source_start_ms === span.source_end_ms);
      if (nextIdx > 0) {
        const prevWordEnd = Math.max(clip.source_in_ms, transcriptWords[nextIdx - 1].source_end_ms);
        if (prevWordEnd < candidateStart) {
          candidateStart = prevWordEnd;
        }
      }
    }

    const effectiveDurMs = candidateEnd - candidateStart;
    if (effectiveDurMs < minPauseMs) {
      rejectedNearMisses.push({
        id: `pause_cand_${clip.id}_${sIdx + 1}`,
        span: [origStart, origEnd],
        action: "rejected",
        reason_code: "TOO_SHORT",
        measured: { gap_ms: effectiveDurMs },
        threshold: { min_pause_ms: minPauseMs },
        margin: effectiveDurMs - minPauseMs,
        note: `Duraksama (${effectiveDurMs}ms) eşik değerin (${minPauseMs}ms) altında olduğu için korundu`,
      });
      continue;
    }

    if (transcriptWords.length > 0) {
      const overlappingWords = transcriptWords.filter(
        (w) =>
          Math.min(candidateEnd, w.source_end_ms) - Math.max(candidateStart, w.source_start_ms) > 0
      );

      if (overlappingWords.length > 0) {
        let freeSegments: Array<{ start_ms: number; end_ms: number }> = [
          { start_ms: candidateStart, end_ms: candidateEnd },
        ];
        for (const w of transcriptWords) {
          const nextSegments: Array<{ start_ms: number; end_ms: number }> = [];
          for (const seg of freeSegments) {
            if (w.source_end_ms <= seg.start_ms || w.source_start_ms >= seg.end_ms) {
              nextSegments.push(seg);
            } else {
              if (w.source_start_ms > seg.start_ms) {
                nextSegments.push({ start_ms: seg.start_ms, end_ms: w.source_start_ms });
              }
              if (w.source_end_ms < seg.end_ms) {
                nextSegments.push({ start_ms: w.source_end_ms, end_ms: seg.end_ms });
              }
            }
          }
          freeSegments = nextSegments;
        }

        const wordLabels = overlappingWords.map((w) => w.punctuated_word || w.word);
        const validSegments = freeSegments.filter((seg) => seg.end_ms - seg.start_ms >= minPauseMs);

        if (validSegments.length === 0) {
          const maxRemainingGapMs =
            freeSegments.length > 0
              ? Math.max(...freeSegments.map((seg) => seg.end_ms - seg.start_ms))
              : 0;
          const bestTrimmedSeg =
            freeSegments.length > 0
              ? freeSegments.reduce((best, cur) =>
                  cur.end_ms - cur.start_ms > best.end_ms - best.start_ms ? cur : best
                )
              : null;
          const maxOverlapMs = Math.max(
            ...overlappingWords.map((w) =>
              Math.max(
                0,
                Math.min(candidateEnd, w.source_end_ms) - Math.max(candidateStart, w.source_start_ms)
              )
            )
          );
          const measuredObj: Record<string, number | string> = {
            gap_ms: origEnd - origStart,
            trimmed_gap_ms: maxRemainingGapMs,
            overlap_ms: maxOverlapMs,
            overlapping_words: wordLabels.join(", "),
          };
          if (bestTrimmedSeg) {
            measuredObj.trimmed_start_ms = bestTrimmedSeg.start_ms;
            measuredObj.trimmed_end_ms = bestTrimmedSeg.end_ms;
            measuredObj.trimmed_span = `${bestTrimmedSeg.start_ms}..${bestTrimmedSeg.end_ms}`;
          }
          rejectedNearMisses.push({
            id: `pause_cand_${clip.id}_${sIdx + 1}`,
            span: [origStart, origEnd],
            action: "rejected",
            reason_code: "OVERLAPS_WORD",
            measured: measuredObj,
            threshold: { min_pause_ms: minPauseMs, max_word_overlap_ms: 0 },
            margin: maxRemainingGapMs - minPauseMs,
            refs: wordLabels,
            note: `Duraksama adayı (${origStart}..${origEnd}ms) konuşulan ASR kelimesiyle (${overlappingWords.map((w) => `'${w.punctuated_word || w.word}' [${w.source_start_ms}..${w.source_end_ms}ms]`).join(", ")}) çakıştı; kırpma sonrası kalan boşluk (${maxRemainingGapMs}ms) eşik değerin (${minPauseMs}ms) altında kaldığı için reddedildi`,
          });
          continue;
        }

        for (let segIdx = 0; segIdx < validSegments.length; segIdx++) {
          const seg = validSegments[segIdx];
          const segDur = seg.end_ms - seg.start_ms;
          rawPauseCandidates.push({
            kind: "pause",
            label: validSegments.length > 1 ? `<trimmed_pause ${segDur}ms>` : span.label,
            rawStart: seg.start_ms,
            rawEnd: seg.end_ms,
            wordGapStart: seg.start_ms,
            wordGapEnd: seg.end_ms,
            origStart,
            origEnd,
            trimmedToWordGap: true,
            overlappingWords: wordLabels,
          });
        }
        continue;
      }
    }

    rawPauseCandidates.push({
      kind: "pause",
      label: span.label,
      rawStart: candidateStart,
      rawEnd: candidateEnd,
      wordGapStart: candidateStart,
      wordGapEnd: candidateEnd,
      origStart,
      origEnd,
      trimmedToWordGap: false,
      overlappingWords: [],
    });
  }

  // Merge overlapping raw pause candidates
  rawPauseCandidates.sort((a, b) => a.rawStart - b.rawStart || a.rawEnd - b.rawEnd);
  const mergedPauseCandidates: RawCandidate[] = [];
  for (const cand of rawPauseCandidates) {
    if (
      mergedPauseCandidates.length === 0 ||
      cand.rawStart > mergedPauseCandidates[mergedPauseCandidates.length - 1].rawEnd
    ) {
      mergedPauseCandidates.push({
        ...cand,
        overlappingWords: [...cand.overlappingWords],
      });
    } else {
      const prev = mergedPauseCandidates[mergedPauseCandidates.length - 1];
      prev.rawEnd = Math.max(prev.rawEnd, cand.rawEnd);
      prev.wordGapEnd = prev.rawEnd;
      prev.origStart = Math.min(prev.origStart, cand.origStart);
      prev.origEnd = Math.max(prev.origEnd, cand.origEnd);
      if (cand.trimmedToWordGap && !prev.trimmedToWordGap) {
        prev.trimmedToWordGap = true;
        prev.label = cand.label;
      }
      for (const wLabel of cand.overlappingWords) {
        if (!prev.overlappingWords.includes(wLabel)) {
          prev.overlappingWords.push(wLabel);
        }
      }
    }
  }

  return {
    mergedPauseCandidates,
    rawNonPauseCandidates,
  };
}

export function applyCollarAndBoundaryRemnantGuard(params: {
  clip: SpineClip;
  sequence: CutholSequence;
  acousticallyVerifiedPauses: RawCandidate[];
  rawNonPauseCandidates: RawCandidate[];
  transcriptWords: RawTranscriptWord[];
  acousticProfile: ReturnType<typeof measureAssetAcousticWindows>;
  minPauseMs: number;
  padMs: number;
  minSubClipTimelineMs: number;
  minRemainderTimelineMs: number;
  rejectedNearMisses: DecisionTraceItem[];
  hasKeptWordInSpan: (sMs: number, eMs: number) => boolean;
}): PlannedCutInterval[] {
  const {
    clip,
    sequence,
    acousticallyVerifiedPauses,
    rawNonPauseCandidates,
    transcriptWords,
    acousticProfile,
    minPauseMs,
    padMs,
    minSubClipTimelineMs,
    minRemainderTimelineMs,
    rejectedNearMisses,
    hasKeptWordInSpan,
  } = params;

  const plannedCuts: PlannedCutInterval[] = [];
  const allRawCandidates: RawCandidate[] = [
    ...acousticallyVerifiedPauses,
    ...rawNonPauseCandidates,
  ];

  const hasActiveAudioInSpan = (sMs: number, eMs: number): boolean => {
    if (!acousticProfile || !acousticProfile.has_silence_variation || eMs <= sMs) return false;
    const wStart = Math.max(0, Math.floor(sMs / acousticProfile.window_ms));
    const wEnd = Math.min(
      acousticProfile.window_dbfs.length,
      Math.ceil(eMs / acousticProfile.window_ms)
    );
    for (let w = wStart; w < wEnd; w++) {
      if (acousticProfile.window_dbfs[w] > acousticProfile.silence_floor_dbfs) return true;
    }
    return false;
  };

  for (let cIdx = 0; cIdx < allRawCandidates.length; cIdx++) {
    const cand = allRawCandidates[cIdx];
    const { rawStart, rawEnd } = cand;
    const effectiveDurMs = rawEnd - rawStart;

    let paddedStart: number;
    let paddedEnd: number;
    if (cand.kind === "pause") {
      // If the boundary of the pause is clip.source_in_ms or clip.source_out_ms AND there is no kept spoken word
      // at that clip boundary (e.g. a clip edge created by an earlier excise inside a pause), do NOT leave a 75ms collar sliver!
      const hasWordJustBeforeGap = transcriptWords.some(
        (w) =>
          w.source_end_ms <= cand.wordGapStart + 30 &&
          w.source_end_ms >= Math.max(clip.source_in_ms, cand.wordGapStart - 150)
      );
      const hasWordJustAfterGap = transcriptWords.some(
        (w) =>
          w.source_start_ms >= cand.wordGapEnd - 30 &&
          w.source_start_ms <= Math.min(clip.source_out_ms, cand.wordGapEnd + 150)
      );

      const basePadStart =
        cand.wordGapStart === clip.source_in_ms && !hasWordJustBeforeGap
          ? clip.source_in_ms
          : Math.min(rawEnd, cand.wordGapStart + padMs);
      const basePadEnd =
        cand.wordGapEnd === clip.source_out_ms && !hasWordJustAfterGap
          ? clip.source_out_ms
          : Math.max(basePadStart, cand.wordGapEnd - padMs);
      paddedStart = Math.max(basePadStart, rawStart);
      paddedEnd = Math.min(basePadEnd, rawEnd);

      if (paddedEnd - paddedStart < 80) {
        rejectedNearMisses.push({
          id: `pause_cand_pad_${clip.id}_${cIdx + 1}`,
          span: [rawStart, rawEnd],
          action: "rejected",
          reason_code: "COLLAR_PAD_EXHAUSTED",
          measured: { gap_ms: effectiveDurMs, remaining_after_pad_ms: paddedEnd - paddedStart },
          threshold: { min_pause_ms: minPauseMs, pad_ms: padMs, min_cut_ms: 80 },
          margin: paddedEnd - paddedStart - 80,
          note: `Yaka payı (${padMs}ms) sonrası kalan kesim süresi (${paddedEnd - paddedStart}ms) 80ms alt sınırının altında kaldığı için korundu`,
        });
        continue;
      }
    } else {
      paddedStart = rawStart;
      paddedEnd = rawEnd;
      if (paddedEnd - paddedStart <= 0) continue;
    }

    // Absorb < 150ms (`minRemainderTimelineMs`) remnants at clip boundaries so no short sliver clip (< 150ms) is left behind
    const leadingTimelineMs =
      sourceMsToSequenceMs(clip, paddedStart) - sourceMsToSequenceMs(clip, clip.source_in_ms);
    if (paddedStart > clip.source_in_ms && leadingTimelineMs < minRemainderTimelineMs) {
      const hitsLeadingKeptWord = hasKeptWordInSpan(clip.source_in_ms, paddedStart);
      const hitsLeadingAudio =
        cand.kind === "pause" &&
        leadingTimelineMs >= minSubClipTimelineMs &&
        hitsLeadingKeptWord &&
        hasActiveAudioInSpan(clip.source_in_ms, paddedStart);
      if (!hitsLeadingKeptWord && !hitsLeadingAudio) {
        paddedStart = clip.source_in_ms;
      } else if (cand.kind === "pause") {
        // Retract pause cut start so the leading clip with speech stays >= minRemainderTimelineMs
        const minNeededSourceStart = clip.source_in_ms + Math.ceil(minRemainderTimelineMs * clip.playback.rate);
        if (paddedEnd - minNeededSourceStart >= 80) {
          paddedStart = minNeededSourceStart;
        } else {
          rejectedNearMisses.push({
            id: `pause_cand_short_lead_${clip.id}_${cIdx + 1}`,
            span: [rawStart, rawEnd],
            action: "rejected",
            reason_code: "AVOID_SHORT_REMNANT_CLIP",
            measured: { leading_remnant_ms: leadingTimelineMs, cut_ms: paddedEnd - paddedStart },
            threshold: { min_remainder_clip_ms: minRemainderTimelineMs },
            margin: leadingTimelineMs - minRemainderTimelineMs,
            note: `Kesim uygulandığında klip başında ${leadingTimelineMs}ms (< ${minRemainderTimelineMs}ms) konuşmalı artık parça kalacağı için korundu`,
          });
          continue;
        }
      }
    }

    const trailingTimelineMs =
      sourceMsToSequenceMs(clip, clip.source_out_ms) - sourceMsToSequenceMs(clip, paddedEnd);
    if (paddedEnd < clip.source_out_ms && trailingTimelineMs < minRemainderTimelineMs) {
      const hitsTrailingKeptWord = hasKeptWordInSpan(paddedEnd, clip.source_out_ms);
      const hitsTrailingAudio =
        cand.kind === "pause" &&
        trailingTimelineMs >= minSubClipTimelineMs &&
        hitsTrailingKeptWord &&
        hasActiveAudioInSpan(paddedEnd, clip.source_out_ms);
      if (!hitsTrailingKeptWord && !hitsTrailingAudio) {
        paddedEnd = clip.source_out_ms;
      } else if (cand.kind === "pause") {
        const maxAllowedSourceEnd =
          clip.source_out_ms - Math.ceil(minRemainderTimelineMs * clip.playback.rate);
        if (maxAllowedSourceEnd - paddedStart >= 80) {
          paddedEnd = maxAllowedSourceEnd;
        } else {
          rejectedNearMisses.push({
            id: `pause_cand_short_trail_${clip.id}_${cIdx + 1}`,
            span: [rawStart, rawEnd],
            action: "rejected",
            reason_code: "AVOID_SHORT_REMNANT_CLIP",
            measured: { trailing_remnant_ms: trailingTimelineMs, cut_ms: paddedEnd - paddedStart },
            threshold: { min_remainder_clip_ms: minRemainderTimelineMs },
            margin: trailingTimelineMs - minRemainderTimelineMs,
            note: `Kesim uygulandığında klip sonunda ${trailingTimelineMs}ms (< ${minRemainderTimelineMs}ms) konuşmalı artık parça kalacağı için korundu`,
          });
          continue;
        }
      }
    }

    if (
      paddedStart <= clip.source_in_ms &&
      paddedEnd >= clip.source_out_ms &&
      sequence.spine.clips.length <= 1
    ) {
      continue;
    }

    const cutDur = paddedEnd - paddedStart;
    if (cutDur <= 0) continue;

    const seqStart = sourceMsToSequenceMs(clip, paddedStart);
    const seqEnd = sourceMsToSequenceMs(clip, paddedEnd);

    plannedCuts.push({
      clip_id: clip.id,
      asset_handle: clip.asset_handle,
      ...(cand.candidateId ? { candidate_id: cand.candidateId } : {}),
      kind: cand.kind,
      label: cand.label,
      raw_source_start_ms: rawStart,
      raw_source_end_ms: rawEnd,
      padded_source_start_ms: paddedStart,
      padded_source_end_ms: paddedEnd,
      sequence_start_ms: seqStart,
      sequence_end_ms: seqEnd,
      cut_duration_ms: cutDur,
      ...(cand.trimmedToWordGap || cand.acousticEdgeTrimmed || cand.splitAroundUntranscribedAudio
        ? {
            original_source_start_ms: cand.origStart,
            original_source_end_ms: cand.origEnd,
          }
        : {}),
      ...(cand.trimmedToWordGap
        ? {
            trimmed_to_word_gap: true,
            overlapping_words: cand.overlappingWords,
          }
        : {}),
      ...(cand.acousticEdgeTrimmed
        ? {
            acoustic_edge_trimmed: true,
          }
        : {}),
      ...(cand.splitAroundUntranscribedAudio
        ? {
            split_around_untranscribed_audio: true,
            untranscribed_audio_spans: cand.untranscribedAudioSpans,
          }
        : {}),
    });
  }

  return plannedCuts;
}

export function bridgeInterCutSliversAndSummarizeClip(params: {
  clip: SpineClip;
  sequence: CutholSequence;
  plannedCuts: PlannedCutInterval[];
  rejectedNearMisses: DecisionTraceItem[];
  padMs: number;
  minSubClipTimelineMs: number;
  minRemainderTimelineMs: number;
  hasKeptWordInSpan: (sMs: number, eMs: number) => boolean;
}): {
  mergedRanges: Array<{ start_ms: number; end_ms: number }>;
  clipSavedSourceMs: number;
  clipSavedSeqMs: number;
} {
  const {
    clip,
    sequence,
    plannedCuts,
    rejectedNearMisses,
    padMs,
    minSubClipTimelineMs,
    minRemainderTimelineMs,
    hasKeptWordInSpan,
  } = params;

  // Sort cuts chronologically and absorb/bridge any < 150ms (`minRemainderTimelineMs`) remnant between adjacent cuts
  plannedCuts.sort(
    (a, b) =>
      a.padded_source_start_ms - b.padded_source_start_ms ||
      a.padded_source_end_ms - b.padded_source_end_ms
  );

  for (let i = 0; i < plannedCuts.length - 1; i++) {
    const curr = plannedCuts[i];
    const next = plannedCuts[i + 1];
    if (next.padded_source_start_ms <= curr.padded_source_end_ms) {
      // Overlapping cuts (e.g. a selected candidate cut overlapping an adjacent pause cut): align seamlessly
      if (next.padded_source_end_ms > curr.padded_source_end_ms) {
        next.padded_source_start_ms = curr.padded_source_end_ms;
        next.sequence_start_ms = curr.sequence_end_ms;
        next.cut_duration_ms = next.padded_source_end_ms - next.padded_source_start_ms;
      } else {
        plannedCuts.splice(i + 1, 1);
        i--;
      }
      continue;
    }

    const gapTimelineMs =
      sourceMsToSequenceMs(clip, next.padded_source_start_ms) -
      sourceMsToSequenceMs(clip, curr.padded_source_end_ms);
    const gapSourceMs = next.padded_source_start_ms - curr.padded_source_end_ms;
    const hasSpokenWordInGap = hasKeptWordInSpan(
      curr.padded_source_end_ms,
      next.padded_source_start_ms
    );
    const involvesWordCut = curr.kind !== "pause" || next.kind !== "pause";
    const isCollarBridgeNextToWordCut =
      involvesWordCut && !hasSpokenWordInGap && gapSourceMs <= padMs + 20;

    if (
      (gapTimelineMs < minRemainderTimelineMs && !hasSpokenWordInGap) ||
      gapTimelineMs < minSubClipTimelineMs ||
      isCollarBridgeNextToWordCut
    ) {
      if (
        !(
          sequence.spine.clips.length <= 1 &&
          curr.padded_source_start_ms <= clip.source_in_ms &&
          next.padded_source_end_ms >= clip.source_out_ms
        )
      ) {
        curr.bridged_sliver_ms = (curr.bridged_sliver_ms ?? 0) + gapTimelineMs;
        curr.padded_source_end_ms = next.padded_source_start_ms;
        curr.sequence_end_ms = next.sequence_start_ms;
        curr.cut_duration_ms = curr.padded_source_end_ms - curr.padded_source_start_ms;
      }
    } else if (gapTimelineMs < minRemainderTimelineMs && hasSpokenWordInGap) {
      // A spoken word sits inside a < 150ms gap between two cuts: retract adjacent pause cut or drop it
      const neededExtraMs = Math.ceil((minRemainderTimelineMs - gapTimelineMs) * clip.playback.rate);
      if (next.kind === "pause" && next.cut_duration_ms - neededExtraMs >= 80) {
        next.padded_source_start_ms += neededExtraMs;
        next.sequence_start_ms = sourceMsToSequenceMs(clip, next.padded_source_start_ms);
        next.cut_duration_ms = next.padded_source_end_ms - next.padded_source_start_ms;
      } else if (curr.kind === "pause" && curr.cut_duration_ms - neededExtraMs >= 80) {
        curr.padded_source_end_ms -= neededExtraMs;
        curr.sequence_end_ms = sourceMsToSequenceMs(clip, curr.padded_source_end_ms);
        curr.cut_duration_ms = curr.padded_source_end_ms - curr.padded_source_start_ms;
      } else if (next.kind === "pause") {
        rejectedNearMisses.push({
          id: `pause_cand_sliver_guard_${clip.id}_${i + 2}`,
          span: [next.raw_source_start_ms, next.raw_source_end_ms],
          action: "rejected",
          reason_code: "AVOID_SHORT_REMNANT_CLIP",
          measured: { gap_between_cuts_ms: gapTimelineMs, cut_ms: next.cut_duration_ms },
          threshold: { min_remainder_clip_ms: minRemainderTimelineMs },
          margin: gapTimelineMs - minRemainderTimelineMs,
          note: `İki kesim arasında ${gapTimelineMs}ms (< ${minRemainderTimelineMs}ms) konuşmalı artık klip kalmaması için duraksama kesimi iptal edildi`,
        });
        plannedCuts.splice(i + 1, 1);
        i--;
      }
    }
  }

  // Compute non-overlapping merged cut intervals for exact saved duration metrics on this clip
  const mergedRanges: Array<{ start_ms: number; end_ms: number }> = [];
  for (const c of plannedCuts) {
    if (
      mergedRanges.length === 0 ||
      c.padded_source_start_ms > mergedRanges[mergedRanges.length - 1].end_ms
    ) {
      mergedRanges.push({
        start_ms: c.padded_source_start_ms,
        end_ms: c.padded_source_end_ms,
      });
    } else {
      mergedRanges[mergedRanges.length - 1].end_ms = Math.max(
        mergedRanges[mergedRanges.length - 1].end_ms,
        c.padded_source_end_ms
      );
    }
  }

  let cursor = clip.source_in_ms;
  let validKeptCount = 0;
  for (const r of mergedRanges) {
    if (r.start_ms > cursor) {
      const keptSeqDur =
        sourceMsToSequenceMs(clip, r.start_ms) - sourceMsToSequenceMs(clip, cursor);
      if (keptSeqDur >= minSubClipTimelineMs) validKeptCount++;
    }
    cursor = Math.max(cursor, r.end_ms);
  }
  if (cursor < clip.source_out_ms) {
    const keptSeqDur =
      sourceMsToSequenceMs(clip, clip.source_out_ms) - sourceMsToSequenceMs(clip, cursor);
    if (keptSeqDur >= minSubClipTimelineMs) validKeptCount++;
  }

  if (validKeptCount === 0 && plannedCuts.length > 0 && sequence.spine.clips.length <= 1) {
    for (let idx = 0; idx < plannedCuts.length; idx++) {
      const c = plannedCuts[idx];
      rejectedNearMisses.push({
        id: `dropped_cut_${clip.id}_${idx + 1}`,
        span: [c.padded_source_start_ms, c.padded_source_end_ms],
        action: "rejected",
        reason_code: "ALL_CUTS_DROPPED_MIN_CLIP_GUARD",
        measured: { cut_ms: c.cut_duration_ms },
        threshold: { min_clip_timeline_ms: minSubClipTimelineMs },
        note: `Kesim uygulandığında geçerli uzunlukta (>= ${minSubClipTimelineMs}ms) hiçbir alt klip kalmayacağı için iptal edildi`,
      });
    }
    plannedCuts.length = 0;
    mergedRanges.length = 0;
  }

  const clipSavedSourceMs = mergedRanges.reduce((acc, r) => acc + (r.end_ms - r.start_ms), 0);
  const clipSavedSeqMs = mergedRanges.reduce(
    (acc, r) =>
      acc +
      Math.max(0, sourceMsToSequenceMs(clip, r.end_ms) - sourceMsToSequenceMs(clip, r.start_ms)),
    0
  );

  return {
    mergedRanges,
    clipSavedSourceMs,
    clipSavedSeqMs,
  };
}

export function planTargetClipsCuts(params: {
  sequence: CutholSequence;
  targetClips: SpineClip[];
  customSelectedSpansByAsset: Map<string, SelectedCandidateSpan[]>;
  getAssetTranscriptAndSpans: CleanupAssetLoaders["getAssetTranscriptAndSpans"];
  getAssetAcousticProfile: CleanupAssetLoaders["getAssetAcousticProfile"];
  minPauseMs: number;
  padMs: number;
  removePauses: boolean;
  removeFillers: boolean;
  removeRepetitions: boolean;
  minSubClipTimelineMs: number;
  minRemainderTimelineMs: number;
}): {
  allPlannedCuts: PlannedCutInterval[];
  allRejectedNearMisses: DecisionTraceItem[];
  perClipCutRanges: Map<string, Array<{ start_ms: number; end_ms: number }>>;
  silentRemnantClipsToRemove: Set<string>;
  totalSavedSourceMs: number;
  totalSavedSeqMs: number;
  globalSilenceFloorVal: number;
} {
  const {
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
  } = params;

  // Pass 3: Plan cuts for each target clip
  const allPlannedCuts: PlannedCutInterval[] = [];
  const allRejectedNearMisses: DecisionTraceItem[] = [];
  const perClipCutRanges = new Map<string, Array<{ start_ms: number; end_ms: number }>>();
  const silentRemnantClipsToRemove = new Set<string>();
  let totalSavedSourceMs = 0;
  let totalSavedSeqMs = 0;
  let globalSilenceFloorVal: number = OPEN_STANDARDS.DIALOGUE_CLEANUP.SILENCE_FLOOR_DBFS;

  for (const clip of targetClips) {
    const assetItem = sequence.library.find((a) => a.handle === clip.asset_handle);
    if (assetItem && !assetItem.probe.has_audio && targetClips.length > 1) {
      continue;
    }

    const { spans: allAssetSpans, words: allAssetWords, docDurationMs } = getAssetTranscriptAndSpans(clip);
    // Pre-filter words and spans to those near [clip.source_in_ms .. clip.source_out_ms] for O(clip) speed on 100+ clip spines
    const transcriptWords = allAssetWords.filter(
      (w) => w.source_end_ms >= clip.source_in_ms - 2000 && w.source_start_ms <= clip.source_out_ms + 2000
    );
    const spans = allAssetSpans.filter(
      (s) => s.source_end_ms > clip.source_in_ms && s.source_start_ms < clip.source_out_ms
    );
    const acousticProfile = getAssetAcousticProfile(clip.asset_handle);
    if (acousticProfile && acousticProfile.has_silence_variation) {
      globalSilenceFloorVal = acousticProfile.silence_floor_dbfs;
    }

    // If this clip on a multi-clip spine is ALREADY a < 150ms silent remnant from an earlier manual excise
    // (0 transcript words overlapping it), remove it cleanly as a silent remnant!
    const wordsInClip = transcriptWords.filter(
      (w) => Math.min(clip.source_out_ms, w.source_end_ms) - Math.max(clip.source_in_ms, w.source_start_ms) > 0
    );
    if (
      targetClips.length > 1 &&
      sequence.spine.clips.length > 1 &&
      clip.duration_ms < minRemainderTimelineMs &&
      wordsInClip.length === 0
    ) {
      silentRemnantClipsToRemove.add(clip.id);
      const cutInterval: PlannedCutInterval = {
        clip_id: clip.id,
        asset_handle: clip.asset_handle,
        kind: "pause",
        label: `<short_silent_remnant ${clip.duration_ms}ms>`,
        raw_source_start_ms: clip.source_in_ms,
        raw_source_end_ms: clip.source_out_ms,
        padded_source_start_ms: clip.source_in_ms,
        padded_source_end_ms: clip.source_out_ms,
        sequence_start_ms: clip.timeline_in_ms,
        sequence_end_ms: clip.timeline_in_ms + clip.duration_ms,
        cut_duration_ms: clip.source_out_ms - clip.source_in_ms,
        bridged_sliver_ms: clip.duration_ms,
      };
      allPlannedCuts.push(cutInterval);
      totalSavedSourceMs += clip.source_out_ms - clip.source_in_ms;
      totalSavedSeqMs += clip.duration_ms;
      continue;
    }

    const rejectedNearMisses: DecisionTraceItem[] = [];
    const selectedSpans = customSelectedSpansByAsset.get(clip.asset_handle) ?? [];

    const { mergedPauseCandidates, rawNonPauseCandidates } = collectClipRawCandidates({
      clip,
      selectedSpans,
      spans,
      transcriptWords,
      docDurationMs,
      acousticProfile,
      minPauseMs,
      padMs,
      removePauses,
      removeFillers,
      removeRepetitions,
      rejectedNearMisses,
    });

    const acousticallyVerifiedPauses = verifyPauseCandidatesAcoustically({
      clip,
      mergedPauseCandidates,
      acousticProfile,
      minPauseMs,
      rejectedNearMisses,
    });

    // Helper: check if a source span [sMs .. eMs] contains any KEPT spoken word (a word not covered by a non-pause cut)
    const hasKeptWordInSpan = (sMs: number, eMs: number): boolean => {
      if (eMs <= sMs) return false;
      return transcriptWords.some((w) => {
        const ov = Math.min(eMs, w.source_end_ms) - Math.max(sMs, w.source_start_ms);
        if (ov <= 0) return false;
        const isWordBeingCut = rawNonPauseCandidates.some(
          (nc) => Math.min(nc.rawEnd, w.source_end_ms) - Math.max(nc.rawStart, w.source_start_ms) >= ov
        );
        return !isWordBeingCut;
      });
    };

    const plannedCuts = applyCollarAndBoundaryRemnantGuard({
      clip,
      sequence,
      acousticallyVerifiedPauses,
      rawNonPauseCandidates,
      transcriptWords,
      acousticProfile,
      minPauseMs,
      padMs,
      minSubClipTimelineMs,
      minRemainderTimelineMs,
      rejectedNearMisses,
      hasKeptWordInSpan,
    });

    const { mergedRanges, clipSavedSourceMs, clipSavedSeqMs } =
      bridgeInterCutSliversAndSummarizeClip({
        clip,
        sequence,
        plannedCuts,
        rejectedNearMisses,
        padMs,
        minSubClipTimelineMs,
        minRemainderTimelineMs,
        hasKeptWordInSpan,
      });

    totalSavedSourceMs += clipSavedSourceMs;
    totalSavedSeqMs += clipSavedSeqMs;
    allPlannedCuts.push(...plannedCuts);
    allRejectedNearMisses.push(...rejectedNearMisses);
    if (mergedRanges.length > 0) {
      perClipCutRanges.set(clip.id, mergedRanges);
    }
  }

  return {
    allPlannedCuts,
    allRejectedNearMisses,
    perClipCutRanges,
    silentRemnantClipsToRemove,
    totalSavedSourceMs,
    totalSavedSeqMs,
    globalSilenceFloorVal,
  };
}
