/**
 * Cuthol Dialogue Disfluency & Pause Cleanup Engine (`src/speech/cleanup.ts`).
 *
 * Identifies pauses (`>= minPauseMs`), filler words (`ıı`, `ee`, `şey`, `uh`, `um`),
 * and immediate word repetitions inside a `SpineClip`'s active source range
 * `[source_in_ms .. source_out_ms]`, applies protective collar padding (`padMs`, default `75ms`)
 * so adjacent consonant transients are never clipped, and excises them in `source` coordinates.
 */

import { DecisionTrace, DecisionTraceItem } from "../core/decision_trace.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { SpineClip } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { parseTimeMs } from "../core/time.js";
import { loadSequence } from "../core/workspace.js";
import { analyzeAssetWaveform, measureAssetAcousticWindows } from "../library/waveform.js";
import { exciseSpineRanges, sourceMsToSequenceMs } from "../sequence/spine.js";
import {
  DetectedDisfluencySpan,
  isContextualFillerIsolated,
  isContextualFillerToken,
  normalizeTokenForMatch,
  RawTranscriptWord,
} from "./providers.js";
import { loadCachedTranscriptForAsset } from "./transcribe.js";

export interface PlannedCutInterval {
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
}

export interface ContextualFillerReviewCandidate {
  id: string;
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
  dry_run: boolean;
  cuts_count: number;
  saved_source_ms: number;
  saved_sequence_ms: number;
  cuts: PlannedCutInterval[];
  review_candidates: ContextualFillerReviewCandidate[];
  decision_trace: DecisionTrace;
  remaining_clips?: SpineClip[];
  revision?: number;
}

export function cleanupClipDialogue(options: {
  workspaceDir: string;
  clipId: string;
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
  const clip = sequence.spine.clips.find((c) => c.id === options.clipId);
  if (!clip) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.clipId));
  }

  const minPauseMs = options.minPauseMs ?? OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_MIN_PAUSE_MS;
  const padMs = options.padMs ?? OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_PAD_MS;
  const removePauses = options.removePauses ?? true;
  const removeFillers = options.removeFillers ?? true;
  const removeRepetitions = options.removeRepetitions ?? true;
  const dryRun = options.dryRun ?? false;

  let spans: DetectedDisfluencySpan[] = [];
  let transcriptWords: RawTranscriptWord[] = [];
  let docDurationMs = clip.source_out_ms;

  try {
    const doc = loadCachedTranscriptForAsset(
      options.workspaceDir,
      clip.asset_handle,
      options.language ?? "tr"
    );
    spans = doc.disfluencies;
    transcriptWords = doc.words ?? [];
    docDurationMs = doc.duration_ms || clip.source_out_ms;
  } catch (err) {
    if (options.useAcousticFallback !== false) {
      // Fallback to acoustic waveform silence intervals if no ASR transcript is cached yet
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

  const minSubClipTimelineMs = Math.ceil(
    (OPEN_STANDARDS.SIGNAL_SANITY.MIN_CLIP_FRAMES * 1000) / Math.max(1, sequence.stage.fps)
  );
  const plannedCuts: PlannedCutInterval[] = [];
  const rejectedNearMisses: DecisionTraceItem[] = [];

  interface RawCandidate {
    kind: "pause" | "filler" | "repetition";
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

  const rawPauseCandidates: RawCandidate[] = [];
  const rawNonPauseCandidates: RawCandidate[] = [];
  const reviewCandidates: ContextualFillerReviewCandidate[] = [];

  // Collect contextual discourse fillers ("yani", "şey", "hani", "acaba") that are NOT pause-isolated
  // into a separate review group so they are never cut automatically, while allowing the agent to
  // inspect their word, source time, and context and cut chosen ones in a single call.
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

    const id = `cf_${String(reviewCandidates.length + 1).padStart(2, "0")}`;
    reviewCandidates.push({
      id,
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
    });
  }

  // If the agent explicitly selected review candidates (by ID e.g. "cf_01", index "1", or source span "16785..16945ms"),
  // schedule those selected candidates for excision in this call.
  const selectedReviewIds = new Set<string>();
  const rawCutSpecs = (options.cutCandidates ?? [])
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter(Boolean);

  for (const spec of rawCutSpecs) {
    const lower = spec.toLowerCase();
    const idMatch = /^(?:cf_?|#)?(\d+)$/i.exec(lower);
    if (idMatch) {
      const idxNum = parseInt(idMatch[1], 10);
      const canonicalId = `cf_${String(idxNum).padStart(2, "0")}`;
      const found = reviewCandidates.find(
        (rc) => rc.id === canonicalId || rc.source_start_ms === idxNum
      );
      if (found && !selectedReviewIds.has(found.id)) {
        selectedReviewIds.add(found.id);
        rawNonPauseCandidates.push({
          kind: "filler",
          label: found.punctuated_word,
          rawStart: found.source_start_ms,
          rawEnd: found.source_end_ms,
          wordGapStart: found.source_start_ms,
          wordGapEnd: found.source_end_ms,
          origStart: found.source_start_ms,
          origEnd: found.source_end_ms,
          trimmedToWordGap: false,
          overlappingWords: [],
        });
      }
      continue;
    }

    if (spec.includes("..")) {
      const [aRaw, bRaw] = spec.split("..");
      const normTime = (t: string): number => {
        const clean = t.trim();
        return /^\d+$/.test(clean) ? parseInt(clean, 10) : parseTimeMs(clean);
      };
      const startMs = normTime(aRaw);
      const endMs = normTime(bRaw);
      let matchedAny = false;
      for (const rc of reviewCandidates) {
        const overlap =
          Math.min(endMs, rc.source_end_ms) - Math.max(startMs, rc.source_start_ms);
        if (
          overlap > 0 ||
          (Math.abs(rc.source_start_ms - startMs) <= 50 && Math.abs(rc.source_end_ms - endMs) <= 50)
        ) {
          matchedAny = true;
          if (!selectedReviewIds.has(rc.id)) {
            selectedReviewIds.add(rc.id);
            rawNonPauseCandidates.push({
              kind: "filler",
              label: rc.punctuated_word,
              rawStart: rc.source_start_ms,
              rawEnd: rc.source_end_ms,
              wordGapStart: rc.source_start_ms,
              wordGapEnd: rc.source_end_ms,
              origStart: rc.source_start_ms,
              origEnd: rc.source_end_ms,
              trimmedToWordGap: false,
              overlappingWords: [],
            });
          }
        }
      }
      if (!matchedAny) {
        const clampedStart = Math.max(clip.source_in_ms, startMs);
        const clampedEnd = Math.min(clip.source_out_ms, endMs);
        if (clampedEnd > clampedStart) {
          rawNonPauseCandidates.push({
            kind: "filler",
            label: spec,
            rawStart: clampedStart,
            rawEnd: clampedEnd,
            wordGapStart: clampedStart,
            wordGapEnd: clampedEnd,
            origStart: clampedStart,
            origEnd: clampedEnd,
            trimmedToWordGap: false,
            overlappingWords: [],
          });
        }
      }
      continue;
    }

    // Single time literal or word token match
    const normalizedWord = normalizeTokenForMatch(spec);
    const matchingByWord = reviewCandidates.filter(
      (rc) => rc.id.toLowerCase() === lower || (normalizedWord && rc.word === normalizedWord)
    );
    if (matchingByWord.length > 0) {
      for (const rc of matchingByWord) {
        if (!selectedReviewIds.has(rc.id)) {
          selectedReviewIds.add(rc.id);
          rawNonPauseCandidates.push({
            kind: "filler",
            label: rc.punctuated_word,
            rawStart: rc.source_start_ms,
            rawEnd: rc.source_end_ms,
            wordGapStart: rc.source_start_ms,
            wordGapEnd: rc.source_end_ms,
            origStart: rc.source_start_ms,
            origEnd: rc.source_end_ms,
            trimmedToWordGap: false,
            overlappingWords: [],
          });
        }
      }
      continue;
    }

    try {
      const pointMs = parseTimeMs(spec);
      const foundAtPoint = reviewCandidates.find(
        (rc) => pointMs >= rc.source_start_ms - 50 && pointMs <= rc.source_end_ms + 50
      );
      if (foundAtPoint && !selectedReviewIds.has(foundAtPoint.id)) {
        selectedReviewIds.add(foundAtPoint.id);
        rawNonPauseCandidates.push({
          kind: "filler",
          label: foundAtPoint.punctuated_word,
          rawStart: foundAtPoint.source_start_ms,
          rawEnd: foundAtPoint.source_end_ms,
          wordGapStart: foundAtPoint.source_start_ms,
          wordGapEnd: foundAtPoint.source_end_ms,
          origStart: foundAtPoint.source_start_ms,
          origEnd: foundAtPoint.source_end_ms,
          trimmedToWordGap: false,
          overlappingWords: [],
        });
      }
    } catch {
      // ignore unparseable spec
    }
  }

  for (let sIdx = 0; sIdx < spans.length; sIdx++) {
    const span = spans[sIdx];
    if (span.kind === "pause" && !removePauses) continue;
    if (span.kind === "filler" && !removeFillers) continue;
    if (span.kind === "repetition" && !removeRepetitions) continue;

    // Contextual discourse words ("şey", "yani", "hani", "acaba") are only cleanup candidates
    // when surrounded by hesitation pauses on both sides.
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

    // Intersect with clip's active source window [source_in_ms .. source_out_ms]
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

    // If an inter-word <pause> candidate in a cached transcript has a start timestamp slightly after
    // the preceding word's acoustically tightened end timestamp, align it to the true word boundary.
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
        id: `pause_cand_${sIdx + 1}`,
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
        (w) => Math.min(candidateEnd, w.source_end_ms) - Math.max(candidateStart, w.source_start_ms) > 0
      );

      if (overlappingWords.length > 0) {
        // Trim pause candidate to word-free gap(s) by subtracting all overlapping ASR word intervals
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
              Math.max(0, Math.min(candidateEnd, w.source_end_ms) - Math.max(candidateStart, w.source_start_ms))
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
            id: `pause_cand_${sIdx + 1}`,
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
            label:
              validSegments.length > 1
                ? `<trimmed_pause ${segDur}ms>`
                : span.label,
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

  // Merge overlapping raw pause candidates (e.g. when both an acoustic pause and an ASR pause
  // cover the same inter-word silence gap) before applying collar padding
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

  // Verify pause candidate edges and interior against actual 25ms RMS acoustic windows
  // relative to `silence_floor_dbfs`. Shrink edges inward out of word tails/onsets,
  // and split/shorten around untranscribed interior audio bursts (> 120ms).
  let acousticProfile: ReturnType<typeof measureAssetAcousticWindows> = null;
  try {
    acousticProfile = measureAssetAcousticWindows({
      workspaceDir: options.workspaceDir,
      handle: clip.asset_handle,
    });
  } catch {
    acousticProfile = null;
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

      // Pass 2: Bridge short plosive closure notches (<= 75ms between active speech, or <= 50ms at boundary before/after active speech)
      const segments: AcousticRun[] = [];
      for (let i = 0; i < blipBridged.length; i++) {
        const r = blipBridged[i];
        const dur = r.end_ms - r.start_ms;
        const isTinyBoundaryNotch =
          !r.active &&
          dur <= 50 &&
          ((i === 0 && blipBridged.length > 1 && blipBridged[1].active) ||
            (i === blipBridged.length - 1 && segments.length > 0 && segments[segments.length - 1].active));
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
            segments.push({ active: true, start_ms: r.start_ms, end_ms: r.end_ms, max_dbfs: r.max_dbfs });
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
            id: `untranscribed_audio_${mIdx + 1}_${untranscribedBursts.length}`,
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
          silentRuns.length > 0
            ? Math.max(...silentRuns.map((s) => s.end_ms - s.start_ms))
            : 0;
        const bestSilent =
          silentRuns.length > 0
            ? silentRuns.reduce((best, cur) =>
                cur.end_ms - cur.start_ms > best.end_ms - best.start_ms ? cur : best
              )
            : null;
        rejectedNearMisses.push({
          id: `pause_cand_acoustic_${mIdx + 1}`,
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

      // Record any sub-pauses (< minPauseMs) dropped after splitting around untranscribed audio
      if (untranscribedBursts.length > 0) {
        const droppedShortRuns = silentRuns.filter((s) => s.end_ms - s.start_ms < minPauseMs);
        for (let dIdx = 0; dIdx < droppedShortRuns.length; dIdx++) {
          const dr = droppedShortRuns[dIdx];
          const drDur = dr.end_ms - dr.start_ms;
          rejectedNearMisses.push({
            id: `pause_cand_split_short_${mIdx + 1}_${dIdx + 1}`,
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

  const allRawCandidates: RawCandidate[] = [...acousticallyVerifiedPauses, ...rawNonPauseCandidates];

  for (let cIdx = 0; cIdx < allRawCandidates.length; cIdx++) {
    const cand = allRawCandidates[cIdx];
    const { rawStart, rawEnd } = cand;
    const effectiveDurMs = rawEnd - rawStart;

    // Apply collar padding (`padMs`) ONLY to silence/pause intervals so adjacent consonant transients
    // are preserved, and clamp to the acoustically verified silent window `[rawStart .. rawEnd]`.
    let paddedStart: number;
    let paddedEnd: number;
    if (cand.kind === "pause") {
      const basePadStart =
        cand.wordGapStart === clip.source_in_ms
          ? clip.source_in_ms
          : Math.min(rawEnd, cand.wordGapStart + padMs);
      const basePadEnd =
        cand.wordGapEnd === clip.source_out_ms
          ? clip.source_out_ms
          : Math.max(basePadStart, cand.wordGapEnd - padMs);
      paddedStart = Math.max(basePadStart, rawStart);
      paddedEnd = Math.min(basePadEnd, rawEnd);

      if (paddedEnd - paddedStart < 80) {
        rejectedNearMisses.push({
          id: `pause_cand_pad_${cIdx + 1}`,
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

    // Absorb sub-frame remnants at clip boundaries using exact speed_ramp-aware timeline duration
    // so G3_TIMING (< 2 frames) is never violated (unless absorbing would clip a spoken word or active audio)
    const leadingTimelineMs =
      sourceMsToSequenceMs(clip, paddedStart) - sourceMsToSequenceMs(clip, clip.source_in_ms);
    if (paddedStart > clip.source_in_ms && leadingTimelineMs < minSubClipTimelineMs) {
      const hitsLeadingWord =
        cand.kind === "pause" &&
        (transcriptWords.some(
          (w) => Math.min(paddedStart, w.source_end_ms) - Math.max(clip.source_in_ms, w.source_start_ms) > 0
        ) ||
          hasActiveAudioInSpan(clip.source_in_ms, paddedStart));
      if (!hitsLeadingWord) {
        paddedStart = clip.source_in_ms;
      }
    }
    const trailingTimelineMs =
      sourceMsToSequenceMs(clip, clip.source_out_ms) - sourceMsToSequenceMs(clip, paddedEnd);
    if (paddedEnd < clip.source_out_ms && trailingTimelineMs < minSubClipTimelineMs) {
      const hitsTrailingWord =
        cand.kind === "pause" &&
        (transcriptWords.some(
          (w) => Math.min(clip.source_out_ms, w.source_end_ms) - Math.max(paddedEnd, w.source_start_ms) > 0
        ) ||
          hasActiveAudioInSpan(paddedEnd, clip.source_out_ms));
      if (!hitsTrailingWord) {
        paddedEnd = clip.source_out_ms;
      }
    }

    // Never allow a single cut to swallow the entire clip [source_in_ms .. source_out_ms]
    if (paddedStart <= clip.source_in_ms && paddedEnd >= clip.source_out_ms) {
      continue;
    }

    const cutDur = paddedEnd - paddedStart;
    if (cutDur <= 0) continue;

    const seqStart = sourceMsToSequenceMs(clip, paddedStart);
    const seqEnd = sourceMsToSequenceMs(clip, paddedEnd);

    plannedCuts.push({
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

  // Sort cuts chronologically and absorb micro-slivers (< 2 frames) between adjacent cuts
  plannedCuts.sort(
    (a, b) =>
      a.padded_source_start_ms - b.padded_source_start_ms ||
      a.padded_source_end_ms - b.padded_source_end_ms
  );
  for (let i = 0; i < plannedCuts.length - 1; i++) {
    const curr = plannedCuts[i];
    const next = plannedCuts[i + 1];
    if (next.padded_source_start_ms > curr.padded_source_end_ms) {
      const gapTimelineMs =
        sourceMsToSequenceMs(clip, next.padded_source_start_ms) -
        sourceMsToSequenceMs(clip, curr.padded_source_end_ms);
      const gapSourceMs = next.padded_source_start_ms - curr.padded_source_end_ms;
      const involvesWordCut = curr.kind !== "pause" || next.kind !== "pause";
      const hasSpokenWordInGap =
        involvesWordCut &&
        transcriptWords.some(
          (w) =>
            Math.min(next.padded_source_start_ms, w.source_end_ms) -
              Math.max(curr.padded_source_end_ms, w.source_start_ms) >
            0
        );
      const isCollarBridgeNextToWordCut =
        involvesWordCut && !hasSpokenWordInGap && gapSourceMs <= padMs + 10;

      if (gapTimelineMs < minSubClipTimelineMs || isCollarBridgeNextToWordCut) {
        // Bridge micro-sliver unless bridging would swallow the entire clip
        if (
          !(
            curr.padded_source_start_ms <= clip.source_in_ms &&
            next.padded_source_end_ms >= clip.source_out_ms
          )
        ) {
          curr.padded_source_end_ms = next.padded_source_start_ms;
          curr.sequence_end_ms = next.sequence_start_ms;
          curr.cut_duration_ms = curr.padded_source_end_ms - curr.padded_source_start_ms;
        }
      }
    }
  }

  // Compute non-overlapping merged cut intervals for exact saved duration metrics
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

  // Ensure at least one kept sub-clip >= minSubClipTimelineMs remains
  let cursor = clip.source_in_ms;
  let validKeptCount = 0;
  for (const r of mergedRanges) {
    if (r.start_ms > cursor) {
      const keptSeqDur = sourceMsToSequenceMs(clip, r.start_ms) - sourceMsToSequenceMs(clip, cursor);
      if (keptSeqDur >= minSubClipTimelineMs) validKeptCount++;
    }
    cursor = Math.max(cursor, r.end_ms);
  }
  if (cursor < clip.source_out_ms) {
    const keptSeqDur =
      sourceMsToSequenceMs(clip, clip.source_out_ms) - sourceMsToSequenceMs(clip, cursor);
    if (keptSeqDur >= minSubClipTimelineMs) validKeptCount++;
  }
  if (validKeptCount === 0 && plannedCuts.length > 0) {
    for (let idx = 0; idx < plannedCuts.length; idx++) {
      const c = plannedCuts[idx];
      rejectedNearMisses.push({
        id: `dropped_cut_${idx + 1}`,
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

  const savedSourceMs = mergedRanges.reduce((acc, r) => acc + (r.end_ms - r.start_ms), 0);
  const savedSeqMs = mergedRanges.reduce(
    (acc, r) =>
      acc + Math.max(0, sourceMsToSequenceMs(clip, r.end_ms) - sourceMsToSequenceMs(clip, r.start_ms)),
    0
  );

  const buildCleanupTrace = (rev: number): DecisionTrace => {
    const silenceFloorVal =
      acousticProfile && acousticProfile.has_silence_variation
        ? acousticProfile.silence_floor_dbfs
        : OPEN_STANDARDS.DIALOGUE_CLEANUP.SILENCE_FLOOR_DBFS;
    const appliedDecisions: DecisionTraceItem[] = plannedCuts.map((c, idx): DecisionTraceItem => {
      if (c.split_around_untranscribed_audio) {
        const origStart = c.original_source_start_ms ?? c.raw_source_start_ms;
        const origEnd = c.original_source_end_ms ?? c.raw_source_end_ms;
        const burstSpans = (c.untranscribed_audio_spans ?? [])
          .map((b) => `${b.start_ms}..${b.end_ms}ms (${b.duration_ms}ms, ${b.max_dbfs}dBFS)`)
          .join(", ");
        const measuredObj: Record<string, number | string> = {
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
          silence_floor_dbfs: silenceFloorVal,
          kind: c.kind,
        };
        if (c.overlapping_words?.length) {
          measuredObj.overlapping_words = c.overlapping_words.join(", ");
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
            silence_floor_dbfs: silenceFloorVal,
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
          measuredObj.silence_floor_dbfs = silenceFloorVal;
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
        measuredObj.silence_floor_dbfs = silenceFloorVal;
      }
      return {
        id: `cut_${idx + 1}`,
        span: [c.padded_source_start_ms, c.padded_source_end_ms],
        action: "applied",
        reason_code: "APPLIED",
        measured: measuredObj,
        threshold: { min_pause_ms: minPauseMs, pad_ms: padMs },
        note: `${c.kind}: ${c.label} (${c.cut_duration_ms}ms kesildi)`,
      };
    });

    const allDecisions = [...appliedDecisions, ...rejectedNearMisses];
    const byReason: Record<string, number> = {};
    for (const d of allDecisions) {
      byReason[d.reason_code] = (byReason[d.reason_code] ?? 0) + 1;
    }

    return {
      trace_id: `tr_cleanup_r${rev}`,
      feature: "silence_cut",
      algorithm: { id: "cleanup.pause-and-disfluency", version: "2.1.0" },
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
        "R5: Saf dolgu sesleri (ıı, ee, uh, um), duraksamayla çevrili bağlamsal dolgular (şey, yani, hani, acaba) ve ardışık kelime tekrarları tam aralığıyla kesilir; akıcı konuşmadaki bağlamsal dolgular otomatik kesilmez ve review_candidates grubunda listelenir",
      ],
      summary: {
        text: `${allDecisions.length} aday incelendi -> ${plannedCuts.length} kesim (${savedSeqMs}ms kısaldı), ${rejectedNearMisses.length} aday korundu${reviewCandidates.length > 0 ? `, ${reviewCandidates.length} bağlamsal dolgu gözden geçirme grubunda listelendi` : ""}`,
        candidates: allDecisions.length,
        accepted: plannedCuts.length,
        rejected: rejectedNearMisses.length,
        by_reason: byReason,
        effect: {
          cuts_count: plannedCuts.length,
          saved_source_ms: savedSourceMs,
          saved_sequence_ms: savedSeqMs,
          review_candidates_count: reviewCandidates.length,
        },
      },
      decisions: allDecisions,
      near_misses: rejectedNearMisses.slice(0, 8),
    };
  };

  if (dryRun || plannedCuts.length === 0) {
    return {
      clip_id: clip.id,
      dry_run: dryRun,
      cuts_count: plannedCuts.length,
      saved_source_ms: savedSourceMs,
      saved_sequence_ms: savedSeqMs,
      cuts: plannedCuts,
      review_candidates: reviewCandidates,
      decision_trace: buildCleanupTrace(sequence.meta.revision),
      ...(dryRun ? {} : { remaining_clips: [clip], revision: sequence.meta.revision }),
    };
  }

  const exciseRes = exciseSpineRanges({
    workspaceDir: options.workspaceDir,
    clipId: clip.id,
    ranges: plannedCuts.map((c) => ({
      start_ms: c.padded_source_start_ms,
      end_ms: c.padded_source_end_ms,
    })),
    coordinateSpace: "source",
  });

  return {
    clip_id: clip.id,
    dry_run: false,
    cuts_count: plannedCuts.length,
    saved_source_ms: savedSourceMs,
    saved_sequence_ms: savedSeqMs,
    cuts: plannedCuts,
    review_candidates: reviewCandidates.filter((rc) => !selectedReviewIds.has(rc.id)),
    decision_trace: buildCleanupTrace(exciseRes.revision),
    remaining_clips: exciseRes.remainingClips,
    revision: exciseRes.revision,
  };
}
