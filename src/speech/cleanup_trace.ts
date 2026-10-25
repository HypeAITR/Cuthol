// Decision trace builder for dialogue disfluency and pause cleanup.

import { DecisionTrace, DecisionTraceItem } from "../core/decision_trace.js";
import { SpineClip } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import type { ContextualFillerReviewCandidate, PlannedCutInterval } from "./cleanup.js";
import type { RepetitionRestartCandidate } from "./repetitions.js";

export function buildCleanupTrace(params: {
  rev: number;
  allPlannedCuts: PlannedCutInterval[];
  allRejectedNearMisses: DecisionTraceItem[];
  allReviewCandidates: ContextualFillerReviewCandidate[];
  allRepetitionCandidates: RepetitionRestartCandidate[];
  distantRepetitionCount?: number;
  preservedUntranscribedCount?: number;
  tailWithoutAudioCount?: number;
  targetClips: SpineClip[];
  minRemainderTimelineMs: number;
  minPauseMs: number;
  padMs: number;
  removeFillers: boolean;
  globalSilenceFloorVal: number;
  totalSavedSourceMs: number;
  totalSavedSeqMs: number;
  options: {
    minPauseMs?: number;
    padMs?: number;
    removeFillers?: boolean;
  };
}): DecisionTrace {
  const {
    rev,
    allPlannedCuts,
    allRejectedNearMisses,
    allReviewCandidates,
    allRepetitionCandidates,
    distantRepetitionCount = 0,
    preservedUntranscribedCount = 0,
    tailWithoutAudioCount = 0,
    targetClips,
    minRemainderTimelineMs,
    minPauseMs,
    padMs,
    removeFillers,
    globalSilenceFloorVal,
    totalSavedSourceMs,
    totalSavedSeqMs,
    options,
  } = params;

  const attachCutEdgeFields = (measured: Record<string, number | string>, c: PlannedCutInterval) => {
    if (typeof c.silence_floor_dbfs === "number") {
      measured.silence_floor_dbfs = c.silence_floor_dbfs;
    }
    if (typeof c.requested_source_start_ms !== "number" || typeof c.requested_source_end_ms !== "number") {
      return;
    }
    const appliedStart = c.applied_source_start_ms ?? c.padded_source_start_ms;
    const appliedEnd = c.applied_source_end_ms ?? c.padded_source_end_ms;
    measured.requested_source_start_ms = c.requested_source_start_ms;
    measured.requested_source_end_ms = c.requested_source_end_ms;
    measured.applied_source_start_ms = appliedStart;
    measured.applied_source_end_ms = appliedEnd;
    measured.requested_span = `${c.requested_source_start_ms}..${c.requested_source_end_ms}`;
    measured.applied_span = `${appliedStart}..${appliedEnd}`;
    if (c.edge_reason) measured.edge_reason = c.edge_reason;
  };

  const appliedDecisions: DecisionTraceItem[] = allPlannedCuts.map(
    (c, idx): DecisionTraceItem => {
      if (c.label.startsWith("<short_silent_remnant")) {
        return {
          id: `cut_${idx + 1}`,
          span: [c.padded_source_start_ms, c.padded_source_end_ms],
          action: "applied",
          reason_code: "SHORT_SILENT_REMNANT_REMOVED",
          measured: {
            clip_id: c.clip_id ?? "",
            remnant_ms: c.bridged_sliver_ms ?? c.cut_duration_ms,
            cut_ms: c.cut_duration_ms,
            kind: c.kind,
            ...(typeof c.silence_floor_dbfs === "number" ? { silence_floor_dbfs: c.silence_floor_dbfs } : {}),
          },
          threshold: { min_remainder_clip_ms: minRemainderTimelineMs },
          note: `${c.clip_id}: ${minRemainderTimelineMs}ms altındaki sessiz artık klip (${c.cut_duration_ms}ms) otomatik kaldırıldı`,
        };
      }
      if (c.split_around_untranscribed_audio) {
        const origStart = c.original_source_start_ms ?? c.raw_source_start_ms;
        const origEnd = c.original_source_end_ms ?? c.raw_source_end_ms;
        const burstSpans = (c.untranscribed_audio_spans ?? [])
          .map((b) => `${b.start_ms}..${b.end_ms}ms (${b.duration_ms}ms, ${b.max_dbfs}dBFS)`)
          .join(", ");
        const measuredObj: Record<string, number | string> = {
          ...(c.clip_id ? { clip_id: c.clip_id } : {}),
          original_start_ms: origStart,
          original_end_ms: origEnd,
          original_span: `${origStart}..${origEnd}`,
          silent_start_ms: c.raw_source_start_ms,
          silent_end_ms: c.raw_source_end_ms,
          silent_span: `${c.raw_source_start_ms}..${c.raw_source_end_ms}`,
          untranscribed_audio_spans: burstSpans,
          raw_ms: origEnd - origStart,
          silent_gap_ms: c.raw_source_end_ms - c.raw_source_start_ms,
          cut_ms: c.cut_duration_ms,
          silence_floor_dbfs: globalSilenceFloorVal,
          kind: c.kind,
        };
        if (c.overlapping_words?.length) {
          measuredObj.overlapping_words = c.overlapping_words.join(", ");
        }
        if (c.bridged_sliver_ms) {
          measuredObj.bridged_sliver_ms = c.bridged_sliver_ms;
        }
        attachCutEdgeFields(measuredObj, c);
        return {
          id: `cut_${idx + 1}`,
          span: [c.padded_source_start_ms, c.padded_source_end_ms],
          action: "applied",
          reason_code: "SPLIT_AROUND_UNTRANSCRIBED_AUDIO",
          measured: measuredObj,
          threshold: {
            min_pause_ms: minPauseMs,
            pad_ms: padMs,
            silence_floor_dbfs: c.silence_floor_dbfs ?? globalSilenceFloorVal,
            min_untranscribed_audio_ms: OPEN_STANDARDS.DIALOGUE_CLEANUP.MIN_UNTRANSCRIBED_SPEECH_MS,
          },
          refs: c.overlapping_words,
          note: `${c.kind}: ${c.label} (transkript dışı ses [${burstSpans}] korunarak [${c.raw_source_start_ms}..${c.raw_source_end_ms}]ms sessizliğine bölündü/kısaltıldı, ${c.cut_duration_ms}ms kesildi)`,
        };
      }
      if (c.trimmed_to_word_gap) {
        const origStart = c.original_source_start_ms ?? c.raw_source_start_ms;
        const origEnd = c.original_source_end_ms ?? c.raw_source_end_ms;
        const measuredObj: Record<string, number | string> = {
          ...(c.clip_id ? { clip_id: c.clip_id } : {}),
          original_start_ms: origStart,
          original_end_ms: origEnd,
          original_span: `${origStart}..${origEnd}`,
          trimmed_start_ms: c.raw_source_start_ms,
          trimmed_end_ms: c.raw_source_end_ms,
          trimmed_span: `${c.raw_source_start_ms}..${c.raw_source_end_ms}`,
          raw_ms: origEnd - origStart,
          trimmed_gap_ms: c.raw_source_end_ms - c.raw_source_start_ms,
          cut_ms: c.cut_duration_ms,
          kind: c.kind,
        };
        if (c.overlapping_words?.length) {
          measuredObj.overlapping_words = c.overlapping_words.join(", ");
        }
        if (c.acoustic_edge_trimmed) {
          measuredObj.silence_floor_dbfs = globalSilenceFloorVal;
        }
        if (c.bridged_sliver_ms) {
          measuredObj.bridged_sliver_ms = c.bridged_sliver_ms;
        }
        attachCutEdgeFields(measuredObj, c);
        return {
          id: `cut_${idx + 1}`,
          span: [c.padded_source_start_ms, c.padded_source_end_ms],
          action: "applied",
          reason_code: "TRIMMED_TO_WORD_GAP",
          measured: measuredObj,
          threshold: { min_pause_ms: minPauseMs, pad_ms: padMs },
          refs: c.overlapping_words,
          note: `${c.kind}: ${c.label} (orijinal [${origStart}..${origEnd}]ms kelime/akustik sınırına göre [${c.raw_source_start_ms}..${c.raw_source_end_ms}]ms boşluğuna kırpıldı, pad sonrası ${c.cut_duration_ms}ms kesildi)`,
        };
      }
      const measuredObj: Record<string, number | string> = {
        ...(c.clip_id ? { clip_id: c.clip_id } : {}),
        ...(c.candidate_id ? { candidate_id: c.candidate_id } : {}),
        raw_ms: c.raw_source_end_ms - c.raw_source_start_ms,
        cut_ms: c.cut_duration_ms,
        kind: c.kind,
      };
      if (c.acoustic_edge_trimmed) {
        const origStart = c.original_source_start_ms ?? c.raw_source_start_ms;
        const origEnd = c.original_source_end_ms ?? c.raw_source_end_ms;
        measuredObj.original_start_ms = origStart;
        measuredObj.original_end_ms = origEnd;
        measuredObj.original_span = `${origStart}..${origEnd}`;
        measuredObj.acoustic_silent_span = `${c.raw_source_start_ms}..${c.raw_source_end_ms}`;
        measuredObj.silence_floor_dbfs = globalSilenceFloorVal;
      }
      if (c.bridged_sliver_ms) {
        measuredObj.bridged_sliver_ms = c.bridged_sliver_ms;
      }
      attachCutEdgeFields(measuredObj, c);
      const reasonCode = c.bridged_sliver_ms ? "APPLIED_WITH_SLIVER_MERGE" : "APPLIED";
      return {
        id: `cut_${idx + 1}`,
        span: [c.padded_source_start_ms, c.padded_source_end_ms],
        action: "applied",
        reason_code: reasonCode,
        measured: measuredObj,
        threshold: { min_pause_ms: minPauseMs, pad_ms: padMs },
        note: `${c.kind}: ${c.label} (${c.cut_duration_ms}ms kesildi${c.bridged_sliver_ms ? `, ${c.bridged_sliver_ms}ms kısa artık komşu kesimle birleştirildi` : ""})`,
      };
    }
  );

  const allDecisions = [...appliedDecisions, ...allRejectedNearMisses];
  const byReason: Record<string, number> = {};
  for (const d of allDecisions) {
    byReason[d.reason_code] = (byReason[d.reason_code] ?? 0) + 1;
  }

  return {
    trace_id: `tr_cleanup_r${rev}`,
    feature: "silence_cut",
    algorithm: { id: "cleanup.pause-and-disfluency", version: "2.2.0" },
    revision: rev,
    params: {
      min_pause_ms: {
        value: minPauseMs,
        default: OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_MIN_PAUSE_MS,
        unit: "ms",
        source: options.minPauseMs !== undefined ? "user" : "default",
      },
      pad_ms: {
        value: padMs,
        default: OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_PAD_MS,
        unit: "ms",
        source: options.padMs !== undefined ? "user" : "default",
      },
      remove_fillers: {
        value: removeFillers,
        default: true,
        source: options.removeFillers !== undefined ? "user" : "default",
      },
    },
    rules: [
      "R1: Duraksama >= min_pause_ms ise iki uçtan pad_ms yaka payı bırakılarak ve silence_floor_dbfs altındaki sessiz pencerelere oturtularak kesilir",
      "R2: Duraksama < min_pause_ms (veya akustik daraltma sonrası < min_pause_ms) ise doğal prozodi kabul edilip korunur (TOO_SHORT / ACOUSTIC_GAP_TOO_SHORT)",
      "R3: Konuşulan bir ASR kelimesiyle çakışan duraksama adayı kelimeler arasındaki boşluğa kırpılır (TRIMMED_TO_WORD_GAP); kırpılmış boşluk < min_pause_ms kalırsa reddedilir (OVERLAPS_WORD)",
      "R4: Duraksama içindeki transkript dışı uzun sesler (> 120ms) kesilmez (UNTRANSCRIBED_AUDIO); kesim etrafından ikiye bölünür veya kısaltılır (SPLIT_AROUND_UNTRANSCRIBED_AUDIO)",
      "R5: Saf dolgu sesleri (ıı, ee, uh, um) ve duraksamayla çevrili bağlamsal dolgular kesilir; akıcı bağlamsal dolgular (review_candidates) ile kelime grubu tekrarları ve cümle yeniden başlamaları (repetition_candidates) otomatik kesilmez, kaynak-tabanlı kalıcı kimliklerle listelenir ve yalnız ajan cut_candidates ile seçtiğinde akustik kenar kurallarıyla kesilir",
      "R6: Kesimler arasında veya klip uçlarında < 150ms artık parça kalacaksa konuşma içermiyorsa komşu kesimle birleştirilir (APPLIED_WITH_SLIVER_MERGE), konuşma içeriyorsa duraksama kesimi daraltılır veya reddedilir (AVOID_SHORT_REMNANT_CLIP)",
    ],
    summary: {
      text: `${targetClips.length} klip üzerinde ${allDecisions.length} aday incelendi -> ${allPlannedCuts.length} kesim (${totalSavedSeqMs}ms kısaldı), ${allRejectedNearMisses.length} aday korundu${allReviewCandidates.length > 0 ? `, ${allReviewCandidates.length} bağlamsal dolgu adayı` : ""}${allRepetitionCandidates.length > 0 ? `, ${allRepetitionCandidates.length} tekrar/yeniden başlama adayı` : ""}${distantRepetitionCount > 0 ? `, ${distantRepetitionCount} uzak tekrar adayı` : ""}${preservedUntranscribedCount > 0 ? `, ${preservedUntranscribedCount} korunan dökümsüz ses` : ""}${tailWithoutAudioCount > 0 ? `, ${tailWithoutAudioCount} görüntü kuyruğu adayı` : ""}`,
      candidates: allDecisions.length,
      accepted: allPlannedCuts.length,
      rejected: allRejectedNearMisses.length,
      by_reason: byReason,
      effect: {
        clips_processed: targetClips.length,
        cuts_count: allPlannedCuts.length,
        saved_source_ms: totalSavedSourceMs,
        saved_sequence_ms: totalSavedSeqMs,
        review_candidates_count: allReviewCandidates.length,
        repetition_candidates_count: allRepetitionCandidates.length,
        distant_repetition_candidates_count: distantRepetitionCount,
        preserved_untranscribed_count: preservedUntranscribedCount,
        tail_without_audio_candidates_count: tailWithoutAudioCount,
      },
    },
    decisions: allDecisions,
    near_misses: allRejectedNearMisses.slice(0, 8),
  };
}
