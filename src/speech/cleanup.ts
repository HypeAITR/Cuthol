/**
 * Cuthol Dialogue Disfluency & Pause Cleanup Engine (`src/speech/cleanup.ts`).
 *
 * Identifies pauses (`>= minPauseMs`), filler words (`ıı`, `ee`, `şey`, `uh`, `um`),
 * contextual discourse fillers (`review_candidates`), and phrase repetitions / sentence
 * restarts (`repetition_candidates`) across a single `SpineClip`, a list of clips, or the
 * entire spine in a single atomic operation.
 */

import { DecisionTrace, DecisionTraceItem } from "../core/decision_trace.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { allocateNextHandle, SpineClip } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { minClipDurationMs, parseTimeMs } from "../core/time.js";
import { loadSequence } from "../core/workspace.js";
import { analyzeAssetWaveform, measureAssetAcousticWindows } from "../library/waveform.js";
import {
  clipLocalMsToSourceMs,
  computeClipDurationMs,
  exciseSpineRanges,
  reflowSpine,
  sliceEnvelopes,
  sliceReframeFocalPoints,
  sliceSpeedRamp,
  sourceMsToClipLocalMs,
  sourceMsToSequenceMs,
} from "../sequence/spine.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";
import {
  DetectedDisfluencySpan,
  isContextualFillerIsolated,
  isContextualFillerToken,
  normalizeTokenForMatch,
  RawTranscriptWord,
  TranscriptDocument,
} from "./providers.js";
import {
  detectRepetitionAndRestartCandidates,
  RepetitionAttempt,
  RepetitionRestartCandidate,
} from "./repetitions.js";
import { loadCachedTranscriptForAsset } from "./transcribe.js";

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

interface RawCandidate {
  kind: "pause" | "filler" | "repetition";
  candidateId?: string;
  label: string;
  rawStart: number;
  rawEnd: number;
  wordGapStart: number;
  wordGapEnd: number;
  origStart: number;
  origEnd: number;
  trimmedToWordGap: boolean;
  overlappingWords: string[];
  acousticEdgeTrimmed?: boolean;
  splitAroundUntranscribedAudio?: boolean;
  untranscribedAudioSpans?: Array<{
    start_ms: number;
    end_ms: number;
    duration_ms: number;
    max_dbfs: number;
  }>;
}

/**
 * Refines a selected word/repetition/restart candidate cut `[rawStart .. rawEnd]`
 * using the asset's 25ms RMS acoustic profile and transcript words:
 * - Never clips neighboring kept words outside the selected cut interval.
 * - Snaps boundary silence edges to acoustic silent windows (`<= silence_floor_dbfs`) with `padMs` collar before/after kept words.
 * - Preserves untranscribed interior audio bursts (`> 120ms`, `> silence_floor_dbfs`) in boundary silence gaps.
 */
function refineSelectedCandidateSpanAcoustically(options: {
  clip: SpineClip;
  rawStart: number;
  rawEnd: number;
  padMs: number;
  minPauseMs: number;
  transcriptWords: RawTranscriptWord[];
  acousticProfile: ReturnType<typeof measureAssetAcousticWindows>;
}): {
  startMs: number;
  endMs: number;
  acousticEdgeTrimmed: boolean;
  splitAroundUntranscribedAudio: boolean;
  untranscribedAudioSpans?: Array<{
    start_ms: number;
    end_ms: number;
    duration_ms: number;
    max_dbfs: number;
  }>;
} {
  const { clip, rawStart, rawEnd, padMs, minPauseMs, transcriptWords, acousticProfile } = options;
  let startMs = Math.max(clip.source_in_ms, rawStart);
  let endMs = Math.min(clip.source_out_ms, rawEnd);
  if (endMs <= startMs) {
    return {
      startMs,
      endMs,
      acousticEdgeTrimmed: false,
      splitAroundUntranscribedAudio: false,
    };
  }

  // Partition transcript words into intentionally excised words vs neighboring kept words
  const cutWords = transcriptWords.filter((w) => {
    const ov = Math.min(endMs, w.source_end_ms) - Math.max(startMs, w.source_start_ms);
    const wDur = Math.max(1, w.source_end_ms - w.source_start_ms);
    return ov >= wDur * 0.5 || (w.source_start_ms >= startMs - 30 && w.source_end_ms <= endMs + 30);
  });
  const cutWordSet = new Set(cutWords);

  let prevKeptWord: RawTranscriptWord | null = null;
  let nextKeptWord: RawTranscriptWord | null = null;
  for (const w of transcriptWords) {
    if (cutWordSet.has(w)) continue;
    if (w.source_end_ms <= startMs + 40) {
      if (!prevKeptWord || w.source_end_ms > prevKeptWord.source_end_ms) {
        prevKeptWord = w;
      }
    } else if (w.source_start_ms >= endMs - 40) {
      if (!nextKeptWord || w.source_start_ms < nextKeptWord.source_start_ms) {
        nextKeptWord = w;
      }
    }
  }

  const firstCutWordStart =
    cutWords.length > 0 ? Math.min(...cutWords.map((w) => w.source_start_ms)) : startMs;
  const lastCutWordEnd =
    cutWords.length > 0 ? Math.max(...cutWords.map((w) => w.source_end_ms)) : endMs;

  // Never overlap neighboring kept words
  if (prevKeptWord && startMs < prevKeptWord.source_end_ms) {
    startMs = prevKeptWord.source_end_ms;
  }
  if (nextKeptWord && endMs > nextKeptWord.source_start_ms) {
    endMs = nextKeptWord.source_start_ms;
  }

  let acousticEdgeTrimmed = false;
  let splitAroundUntranscribedAudio = false;
  const untranscribedSpans: Array<{
    start_ms: number;
    end_ms: number;
    duration_ms: number;
    max_dbfs: number;
  }> = [];

  if (acousticProfile && acousticProfile.has_silence_variation) {
    const winMs = acousticProfile.window_ms;
    const winDbs = acousticProfile.window_dbfs;
    const floorDb = acousticProfile.silence_floor_dbfs;
    const minUntranscribedMs = OPEN_STANDARDS.DIALOGUE_CLEANUP.MIN_UNTRANSCRIBED_SPEECH_MS;

    // 1. Leading gap between prevKeptWord and firstCutWordStart
    const leadGapStart = prevKeptWord ? prevKeptWord.source_end_ms : clip.source_in_ms;
    if (firstCutWordStart > leadGapStart) {
      const minAllowedStart =
        leadGapStart === clip.source_in_ms
          ? clip.source_in_ms
          : Math.min(firstCutWordStart, leadGapStart + padMs);
      if (startMs < minAllowedStart) {
        startMs = minAllowedStart;
        acousticEdgeTrimmed = true;
      }
      // Step forward past any active tail of prevKeptWord
      const w0 = Math.max(0, Math.floor(startMs / winMs));
      const w1 = Math.min(winDbs.length, Math.floor(firstCutWordStart / winMs));
      let wCur = w0;
      while (wCur < w1 && winDbs[wCur] > floorDb) {
        wCur++;
      }
      if (wCur > w0) {
        startMs = Math.min(firstCutWordStart, wCur * winMs);
        acousticEdgeTrimmed = true;
      }
    }

    // 2. Trailing gap between lastCutWordEnd and nextKeptWord
    const trailGapEnd = nextKeptWord ? nextKeptWord.source_start_ms : clip.source_out_ms;
    if (trailGapEnd > lastCutWordEnd) {
      const gapDur = trailGapEnd - lastCutWordEnd;
      // If the selected cut ended at nextKeptWord.source_start_ms (like a restart cut) or if the trailing gap
      // is long enough to be a pause, extend/align the right cut boundary into the silent part of the gap
      // while leaving `padMs` collar before `nextKeptWord` and preserving any untranscribed audio burst.
      const shouldAlignAcrossGap =
        endMs >= trailGapEnd - 30 || gapDur >= minPauseMs || trailGapEnd - endMs < OPEN_STANDARDS.DIALOGUE_CLEANUP.MIN_REMAINDER_SLIVER_MS;

      if (shouldAlignAcrossGap) {
        const targetMaxEnd =
          trailGapEnd === clip.source_out_ms
            ? clip.source_out_ms
            : Math.max(lastCutWordEnd, trailGapEnd - padMs);
        const w0 = Math.max(0, Math.ceil(lastCutWordEnd / winMs));
        const w1 = Math.min(winDbs.length, Math.floor(trailGapEnd / winMs));

        // Find any untranscribed active audio run (> minUntranscribedMs) inside the trailing gap
        let activeRunStart = -1;
        let activeRunMaxDb = -100;
        let firstUntranscribedStartMs: number | null = null;

        for (let w = w0; w <= w1; w++) {
          const isAct = w < w1 && winDbs[w] > floorDb;
          if (isAct) {
            if (activeRunStart === -1) {
              activeRunStart = w * winMs;
              activeRunMaxDb = winDbs[w];
            } else if (winDbs[w] > activeRunMaxDb) {
              activeRunMaxDb = winDbs[w];
            }
          } else if (activeRunStart !== -1) {
            const runEnd = w * winMs;
            const runDur = runEnd - activeRunStart;
            if (runDur > minUntranscribedMs && activeRunStart > lastCutWordEnd + 50) {
              untranscribedSpans.push({
                start_ms: activeRunStart,
                end_ms: runEnd,
                duration_ms: runDur,
                max_dbfs: Number(activeRunMaxDb.toFixed(2)),
              });
              if (firstUntranscribedStartMs === null) {
                firstUntranscribedStartMs = activeRunStart;
              }
            }
            activeRunStart = -1;
            activeRunMaxDb = -100;
          }
        }

        if (firstUntranscribedStartMs !== null) {
          endMs = Math.max(lastCutWordEnd, firstUntranscribedStartMs - padMs);
          splitAroundUntranscribedAudio = true;
          acousticEdgeTrimmed = true;
        } else {
          // Step backward out of any early acoustic onset of nextKeptWord
          let wEnd = Math.min(w1, Math.floor(targetMaxEnd / winMs));
          while (wEnd > w0 && winDbs[wEnd - 1] > floorDb) {
            wEnd--;
          }
          const silentRightMs = Math.max(lastCutWordEnd, Math.min(targetMaxEnd, wEnd * winMs));
          if (silentRightMs !== endMs) {
            endMs = silentRightMs;
            acousticEdgeTrimmed = true;
          }
        }
      }
    }
  } else if (nextKeptWord && endMs > lastCutWordEnd && endMs > nextKeptWord.source_start_ms - padMs) {
    endMs = Math.max(lastCutWordEnd, nextKeptWord.source_start_ms - padMs);
  }

  return {
    startMs: Math.max(clip.source_in_ms, startMs),
    endMs: Math.min(clip.source_out_ms, Math.max(startMs, endMs)),
    acousticEdgeTrimmed,
    splitAroundUntranscribedAudio,
    ...(untranscribedSpans.length > 0 ? { untranscribedAudioSpans: untranscribedSpans } : {}),
  };
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

  // Resolve target clip(s): explicit clipIds list, single/comma-separated clipId, or all spine clips
  const explicitIds: string[] = [];
  if (options.clipIds && options.clipIds.length > 0) {
    for (const raw of options.clipIds) {
      for (const part of String(raw).split(",")) {
        const clean = part.trim();
        if (clean && clean.toLowerCase() !== "all" && clean !== "*") {
          explicitIds.push(clean);
        }
      }
    }
  } else if (
    options.clipId &&
    options.clipId.trim() &&
    options.clipId.trim().toLowerCase() !== "all" &&
    options.clipId.trim() !== "*" &&
    !options.allSpine
  ) {
    for (const part of options.clipId.split(",")) {
      const clean = part.trim();
      if (clean) explicitIds.push(clean);
    }
  }

  let targetClips: SpineClip[] = [];
  if (explicitIds.length > 0) {
    const idSet = new Set(explicitIds);
    for (const reqId of idSet) {
      if (!sequence.spine.clips.some((c) => c.id === reqId)) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(reqId));
      }
    }
    targetClips = sequence.spine.clips.filter((c) => idSet.has(c.id));
  } else {
    targetClips = [...sequence.spine.clips];
  }

  if (targetClips.length === 0) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.clipId ?? "sp_01"));
  }

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

  // Per-asset memoization so multi-clip spine cleanup loads transcript, acoustic windows,
  // and asset-wide repetition candidates only ONCE per unique asset_handle!
  const transcriptCache = new Map<
    string,
    { spans: DetectedDisfluencySpan[]; words: RawTranscriptWord[]; docDurationMs: number }
  >();
  const acousticCache = new Map<string, ReturnType<typeof measureAssetAcousticWindows>>();
  const assetRepetitionCache = new Map<string, RepetitionRestartCandidate[]>();

  const getAssetTranscriptAndSpans = (clip: SpineClip) => {
    const cached = transcriptCache.get(clip.asset_handle);
    if (cached) return cached;

    let spans: DetectedDisfluencySpan[] = [];
    let words: RawTranscriptWord[] = [];
    let docDurationMs = clip.source_out_ms;

    try {
      const doc: TranscriptDocument = loadCachedTranscriptForAsset(
        options.workspaceDir,
        clip.asset_handle,
        options.language ?? "tr"
      );
      spans = doc.disfluencies;
      words = doc.words ?? [];
      docDurationMs = doc.duration_ms || clip.source_out_ms;
    } catch (err) {
      if (options.useAcousticFallback !== false) {
        const wave = analyzeAssetWaveform({
          workspaceDir: options.workspaceDir,
          handle: clip.asset_handle,
        });
        spans = wave.silence_intervals.map((s) => ({
          kind: "pause" as const,
          source_start_ms: s.start_ms,
          source_end_ms: s.end_ms,
          duration_ms: s.duration_ms,
          label: `<acoustic_silence ${s.duration_ms}ms>`,
        }));
      } else {
        throw err;
      }
    }

    const entry = { spans, words, docDurationMs };
    transcriptCache.set(clip.asset_handle, entry);
    return entry;
  };

  const getAssetRepetitionCandidates = (
    clip: SpineClip,
    transcriptWords: RawTranscriptWord[],
    docDurationMs: number
  ): RepetitionRestartCandidate[] => {
    let fullList = assetRepetitionCache.get(clip.asset_handle);
    if (!fullList) {
      const fullAssetProbeClip: SpineClip = {
        ...clip,
        id: clip.id,
        source_in_ms: 0,
        source_out_ms: Math.max(docDurationMs, clip.source_out_ms),
        timeline_in_ms: 0,
        duration_ms: Math.max(docDurationMs, clip.source_out_ms),
      };
      fullList = detectRepetitionAndRestartCandidates({
        clip: fullAssetProbeClip,
        transcriptWords,
        docDurationMs,
      });
      assetRepetitionCache.set(clip.asset_handle, fullList);
    }

    const projected: RepetitionRestartCandidate[] = [];
    for (const rc of fullList) {
      if (rc.source_end_ms <= clip.source_in_ms || rc.source_start_ms >= clip.source_out_ms) {
        continue;
      }
      const clampedStart = Math.max(clip.source_in_ms, rc.source_start_ms);
      const clampedEnd = Math.min(clip.source_out_ms, rc.source_end_ms);
      const sugStart = Math.max(clip.source_in_ms, rc.suggested_cut_start_ms);
      const sugEnd = Math.min(clip.source_out_ms, rc.suggested_cut_end_ms);
      if (clampedEnd <= clampedStart || sugEnd <= sugStart) continue;

      projected.push({
        ...rc,
        clip_id: clip.id,
        sequence_start_ms: sourceMsToSequenceMs(clip, clampedStart),
        sequence_end_ms: sourceMsToSequenceMs(clip, clampedEnd),
      });
    }
    return projected;
  };

  const getAssetAcousticProfile = (assetHandle: string) => {
    if (acousticCache.has(assetHandle)) {
      return acousticCache.get(assetHandle)!;
    }
    let profile: ReturnType<typeof measureAssetAcousticWindows> = null;
    try {
      profile = measureAssetAcousticWindows({
        workspaceDir: options.workspaceDir,
        handle: assetHandle,
      });
    } catch {
      profile = null;
    }
    acousticCache.set(assetHandle, profile);
    return profile;
  };

  // Pass 1: Collect contextual filler review candidates (`cf_<asset>_<start>_<end>`) and
  // repetition/restart review candidates (`rr_<asset>_<start>_<end>`) across all target clips
  const allReviewCandidates: ContextualFillerReviewCandidate[] = [];
  const allRepetitionCandidates: RepetitionRestartCandidate[] = [];
  const reviewCandidatesByClip = new Map<string, ContextualFillerReviewCandidate[]>();
  const repetitionCandidatesByClip = new Map<string, RepetitionRestartCandidate[]>();

  for (const clip of targetClips) {
    const assetItem = sequence.library.find((a) => a.handle === clip.asset_handle);
    if (assetItem && !assetItem.probe.has_audio && targetClips.length > 1) {
      reviewCandidatesByClip.set(clip.id, []);
      repetitionCandidatesByClip.set(clip.id, []);
      continue;
    }

    const { words: transcriptWords, docDurationMs } = getAssetTranscriptAndSpans(clip);
    const clipReviewCands: ContextualFillerReviewCandidate[] = [];

    for (let wIdx = 0; wIdx < transcriptWords.length; wIdx++) {
      const w = transcriptWords[wIdx];
      if (!isContextualFillerToken(w.word)) continue;
      const origStart = Math.max(clip.source_in_ms, w.source_start_ms);
      const origEnd = Math.min(clip.source_out_ms, w.source_end_ms);
      if (origEnd <= origStart) continue;

      const gapBeforeMs = Math.max(
        0,
        wIdx > 0 ? w.source_start_ms - transcriptWords[wIdx - 1].source_end_ms : w.source_start_ms
      );
      const gapAfterMs = Math.max(
        0,
        wIdx + 1 < transcriptWords.length
          ? transcriptWords[wIdx + 1].source_start_ms - w.source_end_ms
          : docDurationMs - w.source_end_ms
      );
      if (isContextualFillerIsolated(gapBeforeMs, gapAfterMs)) {
        continue;
      }

      const ctxStart = Math.max(0, wIdx - 4);
      const ctxEnd = Math.min(transcriptWords.length - 1, wIdx + 4);
      const ctxTokens: string[] = [];
      if (ctxStart > 0) ctxTokens.push("…");
      for (let k = ctxStart; k <= ctxEnd; k++) {
        const tok = transcriptWords[k].punctuated_word || transcriptWords[k].word;
        ctxTokens.push(k === wIdx ? `[${tok}]` : tok);
      }
      if (ctxEnd < transcriptWords.length - 1) ctxTokens.push("…");

      // Persistent source-anchored ID: independent of clip index or call order
      const id = `cf_${clip.asset_handle}_${w.source_start_ms}_${w.source_end_ms}`;
      const cand: ContextualFillerReviewCandidate = {
        id,
        clip_id: clip.id,
        asset_handle: clip.asset_handle,
        word: normalizeTokenForMatch(w.word) || w.word,
        punctuated_word: w.punctuated_word || w.word,
        source_start_ms: origStart,
        source_end_ms: origEnd,
        duration_ms: origEnd - origStart,
        sequence_start_ms: sourceMsToSequenceMs(clip, origStart),
        sequence_end_ms: sourceMsToSequenceMs(clip, origEnd),
        gap_before_ms: gapBeforeMs,
        gap_after_ms: gapAfterMs,
        context: ctxTokens.join(" "),
      };
      clipReviewCands.push(cand);
      allReviewCandidates.push(cand);
    }

    const clipRepCands = getAssetRepetitionCandidates(clip, transcriptWords, docDurationMs);
    reviewCandidatesByClip.set(clip.id, clipReviewCands);
    repetitionCandidatesByClip.set(clip.id, clipRepCands);
    for (const rc of clipRepCands) {
      if (!allRepetitionCandidates.some((ex) => ex.id === rc.id)) {
        allRepetitionCandidates.push(rc);
      }
    }
  }

  // Pass 2: Resolve `cut_candidates` selections (supports persistent `cf_...`, `rr_...`,
  // `:keep=K` / `:cut=K` / `#K` attempt overrides, legacy ordinal `cf_01`/`rr_01`, and source ranges `start..end`)
  const selectedReviewIds = new Set<string>();
  const selectedRepetitionIds = new Set<string>();
  const customSelectedSpansByAsset = new Map<
    string,
    Array<{
      kind: "filler" | "repetition";
      candidateId?: string;
      label: string;
      startMs: number;
      endMs: number;
    }>
  >();

  const addSelectedSpan = (
    assetHandle: string,
    span: {
      kind: "filler" | "repetition";
      candidateId?: string;
      label: string;
      startMs: number;
      endMs: number;
    }
  ) => {
    if (span.endMs <= span.startMs) return;
    const list = customSelectedSpansByAsset.get(assetHandle) ?? [];
    list.push(span);
    customSelectedSpansByAsset.set(assetHandle, list);
  };

  const scheduleRepetitionCandidate = (
    rc: RepetitionRestartCandidate,
    modifier?: string
  ) => {
    selectedRepetitionIds.add(rc.id);
    if (!modifier) {
      addSelectedSpan(rc.asset_handle, {
        kind: "repetition",
        candidateId: rc.id,
        label: `${rc.kind}:${rc.matched_phrase}`,
        startMs: rc.suggested_cut_start_ms,
        endMs: rc.suggested_cut_end_ms,
      });
      return;
    }

    const modLower = modifier.toLowerCase().trim();
    if (modLower.startsWith("keep=")) {
      const keepNums = new Set(
        modLower
          .slice("keep=".length)
          .split(/[+,/;|]/)
          .map((x) => parseInt(x.replace(/^#/, "").trim(), 10))
          .filter(Number.isFinite)
      );
      if (keepNums.size > 0) {
        for (let aIdx = 0; aIdx < rc.attempts.length; aIdx++) {
          const att = rc.attempts[aIdx];
          if (keepNums.has(att.attempt_index)) continue;
          const isLast = aIdx === rc.attempts.length - 1;
          const prevAttEnd = aIdx > 0 ? rc.attempts[aIdx - 1].source_end_ms : att.cut_start_ms;
          const cStart = isLast && keepNums.has(aIdx) ? prevAttEnd : att.cut_start_ms;
          const cEnd = att.cut_end_ms;
          addSelectedSpan(rc.asset_handle, {
            kind: "repetition",
            candidateId: att.attempt_id,
            label: `${rc.kind}:${att.text}`,
            startMs: cStart,
            endMs: cEnd,
          });
        }
        return;
      }
    }

    const cutRaw = modLower.startsWith("cut=") ? modLower.slice("cut=".length) : modLower;
    const cutNums = new Set(
      cutRaw
        .split(/[+,/;|]/)
        .map((x) => parseInt(x.replace(/^#/, "").trim(), 10))
        .filter(Number.isFinite)
    );
    if (cutNums.size > 0) {
      for (let aIdx = 0; aIdx < rc.attempts.length; aIdx++) {
        const att = rc.attempts[aIdx];
        if (!cutNums.has(att.attempt_index)) continue;
        const isLast = aIdx === rc.attempts.length - 1;
        const prevAttEnd = aIdx > 0 ? rc.attempts[aIdx - 1].source_end_ms : att.cut_start_ms;
        const cStart = isLast && !cutNums.has(aIdx) ? prevAttEnd : att.cut_start_ms;
        const cEnd = att.cut_end_ms;
        addSelectedSpan(rc.asset_handle, {
          kind: "repetition",
          candidateId: att.attempt_id,
          label: `${rc.kind}:${att.text}`,
          startMs: cStart,
          endMs: cEnd,
        });
      }
    }
  };

  const rawCutSpecs = (options.cutCandidates ?? [])
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter(Boolean);

  for (const spec of rawCutSpecs) {
    const lower = spec.toLowerCase();

    if (lower === "all_repetitions" || lower === "all_restarts" || lower === "rr_*") {
      for (const rc of allRepetitionCandidates) {
        if (!selectedRepetitionIds.has(rc.id)) {
          scheduleRepetitionCandidate(rc);
        }
      }
      continue;
    }

    if (lower === "all_fillers" || lower === "cf_*") {
      for (const cf of allReviewCandidates) {
        if (!selectedReviewIds.has(cf.id)) {
          selectedReviewIds.add(cf.id);
          addSelectedSpan(cf.asset_handle ?? targetClips[0].asset_handle, {
            kind: "filler",
            candidateId: cf.id,
            label: cf.punctuated_word,
            startMs: cf.source_start_ms,
            endMs: cf.source_end_ms,
          });
        }
      }
      continue;
    }

    // Check repetition candidate ID (`rr_...` with optional `:keep=1`, `:cut=1`, or `#1`)
    const rrMatch = /^(rr_[a-z0-9_]+?)(?::(keep=[^#]+|cut=[^#]+)|#(\d+))?$/i.exec(spec);
    if (rrMatch) {
      const baseId = rrMatch[1].toLowerCase();
      const modifier = rrMatch[2] ?? (rrMatch[3] ? `cut=${rrMatch[3]}` : undefined);
      let foundRR = allRepetitionCandidates.find((r) => r.id.toLowerCase() === baseId);
      if (!foundRR) {
        const ordMatch = /^rr_?0*(\d+)$/i.exec(baseId);
        if (ordMatch) {
          const ord = parseInt(ordMatch[1], 10);
          if (ord >= 1 && ord <= allRepetitionCandidates.length) {
            foundRR = allRepetitionCandidates[ord - 1];
          } else {
            foundRR = allRepetitionCandidates.find(
              (r) => r.source_start_ms === ord || r.suggested_cut_start_ms === ord
            );
          }
        } else {
          const tailMatch = /^rr_(?:[a-z0-9_]+_)?(\d+)_(\d+)$/i.exec(baseId);
          if (tailMatch) {
            const sMs = parseInt(tailMatch[1], 10);
            const eMs = parseInt(tailMatch[2], 10);
            foundRR = allRepetitionCandidates.find(
              (r) =>
                (Math.abs(r.source_start_ms - sMs) <= 50 && Math.abs(r.source_end_ms - eMs) <= 50) ||
                (Math.abs(r.suggested_cut_start_ms - sMs) <= 50 &&
                  Math.abs(r.suggested_cut_end_ms - eMs) <= 50)
            );
          }
        }
      }
      if (foundRR) {
        scheduleRepetitionCandidate(foundRR, modifier);
        continue;
      }
    }

    // Check contextual filler candidate ID (`cf_vid_01_16785_16945`, `cf_16785_16945`, `cf_01`, `#1`)
    const cfMatch = /^(?:cf_[a-z0-9_]+|(?:cf_?|#)\d+)$/i.exec(lower);
    if (cfMatch && !spec.includes("..")) {
      let foundCF = allReviewCandidates.find((c) => c.id.toLowerCase() === lower);
      if (!foundCF) {
        const tailMatch = /^cf_(?:[a-z0-9_]+_)?(\d+)_(\d+)$/i.exec(lower);
        if (tailMatch) {
          const sMs = parseInt(tailMatch[1], 10);
          const eMs = parseInt(tailMatch[2], 10);
          foundCF = allReviewCandidates.find(
            (c) => Math.abs(c.source_start_ms - sMs) <= 50 && Math.abs(c.source_end_ms - eMs) <= 50
          );
        } else {
          const numMatch = /^(?:cf_?|#)(\d+)$/i.exec(lower);
          if (numMatch) {
            const idxNum = parseInt(numMatch[1], 10);
            foundCF =
              allReviewCandidates.find((c) => c.source_start_ms === idxNum) ??
              (idxNum >= 1 && idxNum <= allReviewCandidates.length
                ? allReviewCandidates[idxNum - 1]
                : undefined);
          }
        }
      }
      if (foundCF && !selectedReviewIds.has(foundCF.id)) {
        selectedReviewIds.add(foundCF.id);
        addSelectedSpan(foundCF.asset_handle ?? targetClips[0].asset_handle, {
          kind: "filler",
          candidateId: foundCF.id,
          label: foundCF.punctuated_word,
          startMs: foundCF.source_start_ms,
          endMs: foundCF.source_end_ms,
        });
        continue;
      }
    }

    // Check source range (`16785..16945ms`, `vid_01:36150..42880ms`, `36.15s..42.88s`)
    if (spec.includes("..")) {
      let assetPrefix: string | null = null;
      let rangePart = spec;
      const colonIdx = spec.indexOf(":");
      if (colonIdx > 0 && !/^\d+$/.test(spec.slice(0, colonIdx))) {
        assetPrefix = spec.slice(0, colonIdx).trim();
        rangePart = spec.slice(colonIdx + 1).trim();
      }
      const [aRaw, bRaw] = rangePart.split("..");
      const normTime = (t: string): number => {
        const clean = t.trim();
        return /^\d+$/.test(clean) ? parseInt(clean, 10) : parseTimeMs(clean);
      };
      const startMs = normTime(aRaw);
      const endMs = normTime(bRaw);

      let matchedAny = false;
      for (const rc of allReviewCandidates) {
        if (assetPrefix && rc.asset_handle !== assetPrefix) continue;
        const overlap = Math.min(endMs, rc.source_end_ms) - Math.max(startMs, rc.source_start_ms);
        if (
          (overlap > 0 && endMs - startMs <= rc.duration_ms + 400) ||
          (Math.abs(rc.source_start_ms - startMs) <= 50 && Math.abs(rc.source_end_ms - endMs) <= 50)
        ) {
          matchedAny = true;
          if (!selectedReviewIds.has(rc.id)) {
            selectedReviewIds.add(rc.id);
            addSelectedSpan(rc.asset_handle ?? targetClips[0].asset_handle, {
              kind: "filler",
              candidateId: rc.id,
              label: rc.punctuated_word,
              startMs: rc.source_start_ms,
              endMs: rc.source_end_ms,
            });
          }
        }
      }

      if (!matchedAny) {
        for (const rr of allRepetitionCandidates) {
          if (assetPrefix && rr.asset_handle !== assetPrefix) continue;
          if (
            Math.abs(rr.suggested_cut_start_ms - startMs) <= 80 &&
            Math.abs(rr.suggested_cut_end_ms - endMs) <= 80
          ) {
            matchedAny = true;
            scheduleRepetitionCandidate(rr);
            break;
          }
        }
      }

      if (!matchedAny) {
        const targetAssetHandles = assetPrefix
          ? [assetPrefix]
          : Array.from(new Set(targetClips.map((c) => c.asset_handle)));
        for (const ah of targetAssetHandles) {
          addSelectedSpan(ah, {
            kind: "repetition",
            label: spec,
            startMs,
            endMs,
          });
        }
      }
      continue;
    }

    // Word token match (`"yani"`, `"şey"`)
    const normalizedWord = normalizeTokenForMatch(spec);
    const matchingByWord = allReviewCandidates.filter(
      (rc) => rc.id.toLowerCase() === lower || (normalizedWord && rc.word === normalizedWord)
    );
    if (matchingByWord.length > 0) {
      for (const rc of matchingByWord) {
        if (!selectedReviewIds.has(rc.id)) {
          selectedReviewIds.add(rc.id);
          addSelectedSpan(rc.asset_handle ?? targetClips[0].asset_handle, {
            kind: "filler",
            candidateId: rc.id,
            label: rc.punctuated_word,
            startMs: rc.source_start_ms,
            endMs: rc.source_end_ms,
          });
        }
      }
      continue;
    }

    try {
      const pointMs = parseTimeMs(spec);
      const foundAtPoint = allReviewCandidates.find(
        (rc) => pointMs >= rc.source_start_ms - 50 && pointMs <= rc.source_end_ms + 50
      );
      if (foundAtPoint && !selectedReviewIds.has(foundAtPoint.id)) {
        selectedReviewIds.add(foundAtPoint.id);
        addSelectedSpan(foundAtPoint.asset_handle ?? targetClips[0].asset_handle, {
          kind: "filler",
          candidateId: foundAtPoint.id,
          label: foundAtPoint.punctuated_word,
          startMs: foundAtPoint.source_start_ms,
          endMs: foundAtPoint.source_end_ms,
        });
      }
    } catch {
      // ignore unparseable spec
    }
  }

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

    const plannedCuts: PlannedCutInterval[] = [];
    const rejectedNearMisses: DecisionTraceItem[] = [];
    const rawPauseCandidates: RawCandidate[] = [];
    const rawNonPauseCandidates: RawCandidate[] = [];

    // Schedule any user-selected candidates (`cut_candidates`) that fall inside `clip`
    const selectedSpans = customSelectedSpansByAsset.get(clip.asset_handle) ?? [];
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

    const acousticallyVerifiedPauses: RawCandidate[] = [];
    if (acousticProfile && acousticProfile.has_silence_variation) {
      const winMs = acousticProfile.window_ms;
      const winDbs = acousticProfile.window_dbfs;
      const silenceFloorDbfs = acousticProfile.silence_floor_dbfs;
      const minUntranscribedMs = OPEN_STANDARDS.DIALOGUE_CLEANUP.MIN_UNTRANSCRIBED_SPEECH_MS;
      const maxInteriorBlipMs = OPEN_STANDARDS.DIALOGUE_CLEANUP.MAX_INTERIOR_BLIP_MS;

      for (let mIdx = 0; mIdx < mergedPauseCandidates.length; mIdx++) {
        const cand = mergedPauseCandidates[mIdx];
        const w0 = Math.max(0, Math.floor(cand.rawStart / winMs));
        const w1 = Math.min(winDbs.length, Math.ceil(cand.rawEnd / winMs));

        if (w0 >= w1) {
          acousticallyVerifiedPauses.push(cand);
          continue;
        }

        interface AcousticRun {
          active: boolean;
          start_ms: number;
          end_ms: number;
          max_dbfs: number;
        }

        const rawRuns: AcousticRun[] = [];
        for (let w = w0; w < w1; w++) {
          const s = Math.max(cand.rawStart, w * winMs);
          const e = Math.min(cand.rawEnd, (w + 1) * winMs);
          if (e <= s) continue;
          const db = winDbs[w];
          const active = db > silenceFloorDbfs;
          if (rawRuns.length === 0 || rawRuns[rawRuns.length - 1].active !== active) {
            rawRuns.push({ active, start_ms: s, end_ms: e, max_dbfs: db });
          } else {
            const prev = rawRuns[rawRuns.length - 1];
            prev.end_ms = e;
            if (db > prev.max_dbfs) prev.max_dbfs = db;
          }
        }

        // Pass 1: Bridge isolated micro-blips (<= 50ms and <= -35 dBFS) surrounded by silence
        const blipBridged: AcousticRun[] = [];
        for (let i = 0; i < rawRuns.length; i++) {
          const r = rawRuns[i];
          const dur = r.end_ms - r.start_ms;
          if (
            r.active &&
            dur <= maxInteriorBlipMs &&
            r.max_dbfs <= -35.0 &&
            blipBridged.length > 0 &&
            !blipBridged[blipBridged.length - 1].active &&
            i + 1 < rawRuns.length &&
            !rawRuns[i + 1].active
          ) {
            const prev = blipBridged[blipBridged.length - 1];
            prev.end_ms = r.end_ms;
            if (r.max_dbfs > prev.max_dbfs) prev.max_dbfs = r.max_dbfs;
          } else if (blipBridged.length > 0 && blipBridged[blipBridged.length - 1].active === r.active) {
            const prev = blipBridged[blipBridged.length - 1];
            prev.end_ms = r.end_ms;
            if (r.max_dbfs > prev.max_dbfs) prev.max_dbfs = r.max_dbfs;
          } else {
            blipBridged.push({ ...r });
          }
        }

        // Pass 2: Bridge short plosive closure notches
        const segments: AcousticRun[] = [];
        for (let i = 0; i < blipBridged.length; i++) {
          const r = blipBridged[i];
          const dur = r.end_ms - r.start_ms;
          const isTinyBoundaryNotch =
            !r.active &&
            dur <= 50 &&
            ((i === 0 && blipBridged.length > 1 && blipBridged[1].active) ||
              (i === blipBridged.length - 1 &&
                segments.length > 0 &&
                segments[segments.length - 1].active));
          const isInteriorPlosiveNotch =
            !r.active &&
            dur <= 75 &&
            segments.length > 0 &&
            segments[segments.length - 1].active &&
            i + 1 < blipBridged.length &&
            blipBridged[i + 1].active;

          if (isTinyBoundaryNotch || isInteriorPlosiveNotch) {
            if (segments.length > 0 && segments[segments.length - 1].active) {
              segments[segments.length - 1].end_ms = r.end_ms;
            } else {
              segments.push({
                active: true,
                start_ms: r.start_ms,
                end_ms: r.end_ms,
                max_dbfs: r.max_dbfs,
              });
            }
          } else if (segments.length > 0 && segments[segments.length - 1].active === r.active) {
            const prev = segments[segments.length - 1];
            prev.end_ms = r.end_ms;
            if (r.max_dbfs > prev.max_dbfs) prev.max_dbfs = r.max_dbfs;
          } else {
            segments.push({ ...r });
          }
        }

        const hasQualifyingSilentRun = segments.some(
          (s) => !s.active && s.end_ms - s.start_ms >= minPauseMs
        );
        const untranscribedBursts: Array<{
          start_ms: number;
          end_ms: number;
          duration_ms: number;
          max_dbfs: number;
        }> = [];

        for (let sIdx = 0; sIdx < segments.length; sIdx++) {
          const seg = segments[sIdx];
          if (!seg.active) continue;
          const dur = seg.end_ms - seg.start_ms;
          const isInterior = sIdx > 0 && sIdx < segments.length - 1;
          const isLongUntranscribedEdgeSpeech =
            !isInterior &&
            hasQualifyingSilentRun &&
            dur >= Math.max(minPauseMs, 400) &&
            seg.max_dbfs > -35.0;

          if ((isInterior && dur > minUntranscribedMs) || isLongUntranscribedEdgeSpeech) {
            const maxDb = Number(seg.max_dbfs.toFixed(2));
            untranscribedBursts.push({
              start_ms: seg.start_ms,
              end_ms: seg.end_ms,
              duration_ms: dur,
              max_dbfs: maxDb,
            });
            rejectedNearMisses.push({
              id: `untranscribed_audio_${clip.id}_${mIdx + 1}_${untranscribedBursts.length}`,
              span: [seg.start_ms, seg.end_ms],
              action: "rejected",
              reason_code: "UNTRANSCRIBED_AUDIO",
              measured: {
                audio_ms: dur,
                max_dbfs: maxDb,
                silence_floor_dbfs: silenceFloorDbfs,
                parent_pause_span: `${cand.rawStart}..${cand.rawEnd}`,
              },
              threshold: {
                min_untranscribed_audio_ms: minUntranscribedMs,
                silence_floor_dbfs: silenceFloorDbfs,
              },
              margin: dur - minUntranscribedMs,
              note: `Duraksama adayı (${cand.rawStart}..${cand.rawEnd}ms) içinde transkripte girmemiş ${dur}ms ses (${seg.start_ms}..${seg.end_ms}ms, tepe ${maxDb} dBFS > eşik ${silenceFloorDbfs} dBFS) korundu; seslendirilmiş dolguysa manuel kesilebilir`,
            });
          }
        }

        const silentRuns = segments.filter((s) => !s.active);
        const validSilentRuns = silentRuns.filter((s) => s.end_ms - s.start_ms >= minPauseMs);

        if (validSilentRuns.length === 0) {
          const maxSilentMs =
            silentRuns.length > 0 ? Math.max(...silentRuns.map((s) => s.end_ms - s.start_ms)) : 0;
          const bestSilent =
            silentRuns.length > 0
              ? silentRuns.reduce((best, cur) =>
                  cur.end_ms - cur.start_ms > best.end_ms - best.start_ms ? cur : best
                )
              : null;
          rejectedNearMisses.push({
            id: `pause_cand_acoustic_${clip.id}_${mIdx + 1}`,
            span: [cand.rawStart, cand.rawEnd],
            action: "rejected",
            reason_code: "ACOUSTIC_GAP_TOO_SHORT",
            measured: {
              raw_gap_ms: cand.rawEnd - cand.rawStart,
              acoustic_silent_ms: maxSilentMs,
              silence_floor_dbfs: silenceFloorDbfs,
              ...(bestSilent
                ? {
                    silent_start_ms: bestSilent.start_ms,
                    silent_end_ms: bestSilent.end_ms,
                    silent_span: `${bestSilent.start_ms}..${bestSilent.end_ms}`,
                  }
                : {}),
            },
            threshold: {
              min_pause_ms: minPauseMs,
              silence_floor_dbfs: silenceFloorDbfs,
            },
            margin: maxSilentMs - minPauseMs,
            note: `Duraksama adayı (${cand.rawStart}..${cand.rawEnd}ms) akustik sessizlik eşiğine (${silenceFloorDbfs} dBFS) göre daraltıldığında kalan sessiz bölge (${maxSilentMs}ms) eşik değerin (${minPauseMs}ms) altında kaldığı için korundu`,
          });
          continue;
        }

        if (untranscribedBursts.length > 0) {
          const droppedShortRuns = silentRuns.filter((s) => s.end_ms - s.start_ms < minPauseMs);
          for (let dIdx = 0; dIdx < droppedShortRuns.length; dIdx++) {
            const dr = droppedShortRuns[dIdx];
            const drDur = dr.end_ms - dr.start_ms;
            rejectedNearMisses.push({
              id: `pause_cand_split_short_${clip.id}_${mIdx + 1}_${dIdx + 1}`,
              span: [dr.start_ms, dr.end_ms],
              action: "rejected",
              reason_code: "ACOUSTIC_GAP_TOO_SHORT",
              measured: {
                raw_gap_ms: cand.rawEnd - cand.rawStart,
                acoustic_silent_ms: drDur,
                silence_floor_dbfs: silenceFloorDbfs,
                silent_span: `${dr.start_ms}..${dr.end_ms}`,
              },
              threshold: {
                min_pause_ms: minPauseMs,
                silence_floor_dbfs: silenceFloorDbfs,
              },
              margin: drDur - minPauseMs,
              note: `Transkript dışı ses etrafından bölünen duraksama parçası (${dr.start_ms}..${dr.end_ms}ms, ${drDur}ms) eşik değerin (${minPauseMs}ms) altında kaldığı için bırakıldı`,
            });
          }
        }

        for (let vIdx = 0; vIdx < validSilentRuns.length; vIdx++) {
          const sr = validSilentRuns[vIdx];
          const srDur = sr.end_ms - sr.start_ms;
          const edgeTrimmed = sr.start_ms > cand.rawStart || sr.end_ms < cand.rawEnd;
          const splitAroundAudio = untranscribedBursts.length > 0;
          acousticallyVerifiedPauses.push({
            ...cand,
            label:
              validSilentRuns.length > 1 || splitAroundAudio
                ? `<acoustic_split_pause ${srDur}ms>`
                : cand.label,
            rawStart: sr.start_ms,
            rawEnd: sr.end_ms,
            wordGapStart: cand.rawStart,
            wordGapEnd: cand.rawEnd,
            acousticEdgeTrimmed: edgeTrimmed,
            splitAroundUntranscribedAudio: splitAroundAudio,
            untranscribedAudioSpans: splitAroundAudio ? untranscribedBursts : undefined,
          });
        }
      }
    } else {
      acousticallyVerifiedPauses.push(...mergedPauseCandidates);
    }

    const allRawCandidates: RawCandidate[] = [
      ...acousticallyVerifiedPauses,
      ...rawNonPauseCandidates,
    ];

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

    totalSavedSourceMs += clipSavedSourceMs;
    totalSavedSeqMs += clipSavedSeqMs;
    allPlannedCuts.push(...plannedCuts);
    allRejectedNearMisses.push(...rejectedNearMisses);
    if (mergedRanges.length > 0) {
      perClipCutRanges.set(clip.id, mergedRanges);
    }
  }

  const buildCleanupTrace = (rev: number): DecisionTrace => {
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
          return {
            id: `cut_${idx + 1}`,
            span: [c.padded_source_start_ms, c.padded_source_end_ms],
            action: "applied",
            reason_code: "SPLIT_AROUND_UNTRANSCRIBED_AUDIO",
            measured: measuredObj,
            threshold: {
              min_pause_ms: minPauseMs,
              pad_ms: padMs,
              silence_floor_dbfs: globalSilenceFloorVal,
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
        text: `${targetClips.length} klip üzerinde ${allDecisions.length} aday incelendi -> ${allPlannedCuts.length} kesim (${totalSavedSeqMs}ms kısaldı), ${allRejectedNearMisses.length} aday korundu${allReviewCandidates.length > 0 ? `, ${allReviewCandidates.length} bağlamsal dolgu adayı` : ""}${allRepetitionCandidates.length > 0 ? `, ${allRepetitionCandidates.length} tekrar/yeniden başlama adayı` : ""}`,
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
        },
      },
      decisions: allDecisions,
      near_misses: allRejectedNearMisses.slice(0, 8),
    };
  };

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
      decision_trace: buildCleanupTrace(sequence.meta.revision),
      ...(dryRun ? {} : { remaining_clips: targetClips, revision: sequence.meta.revision }),
    };
  }

  // Single-clip fast path uses exciseSpineRanges directly for 100% identical journal label when 1 clip is cleaned
  if (targetClips.length === 1 && silentRemnantClipsToRemove.size === 0) {
    const clip = targetClips[0];
    const exciseRes = exciseSpineRanges({
      workspaceDir: options.workspaceDir,
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
    options.workspaceDir,
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
