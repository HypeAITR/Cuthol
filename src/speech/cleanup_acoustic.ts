// Acoustic window edge refinement and pause verification for dialogue cleanup.

import { DecisionTraceItem } from "../core/decision_trace.js";
import { SpineClip } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { AcousticWindowProfile, measureAssetAcousticWindows } from "../library/waveform.js";
import { RawTranscriptWord } from "./providers.js";

/** Profiles measured during cleanup, keyed by library digest. Absent entries are skipped. */
const acousticProfilesByDigest = new Map<string, AcousticWindowProfile>();

export function rememberAcousticProfile(
  digest: string,
  profile: AcousticWindowProfile | null
): void {
  if (!digest || !profile) return;
  acousticProfilesByDigest.set(digest, profile);
}

export function peekCachedAcousticProfile(digest: string): AcousticWindowProfile | null {
  if (!digest) return null;
  return acousticProfilesByDigest.get(digest) ?? null;
}

export interface RawCandidate {
  kind: "pause" | "filler" | "repetition" | "tail_without_audio";
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
  requestedSourceStart?: number;
  requestedSourceEnd?: number;
  edgeReason?: CleanupEdgeReason;
  edgeGuardStart?: number;
  edgeGuardEnd?: number;
  trailingSilenceGuardEnd?: number;
  untranscribedAudioSpans?: Array<{
    start_ms: number;
    end_ms: number;
    duration_ms: number;
    max_dbfs: number;
  }>;
}

export type CleanupEdgeReason =
  | "pulled_in_before_speech"
  | "extended_into_silence"
  | "split_around_untranscribed_audio"
  | "unchanged";

/**
 * Refines a selected cut `[rawStart .. rawEnd]` against the 25ms RMS profile.
 * The edge may move outward from the requested boundary only through silence,
 * and it stops one window before the first above-threshold window. An edge that
 * already lies in speech after the cut words is pulled inward, ahead of that attack.
 * An above-threshold run longer than `MIN_UNTRANSCRIBED_SPEECH_MS` that starts after
 * the cut words and ends before the requested end is kept: the cut stops `padMs` before it.
 */
export function refineSelectedCandidateSpanAcoustically(options: {
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
  edgeReason: CleanupEdgeReason;
  untranscribedAudioSpans?: Array<{
    start_ms: number;
    end_ms: number;
    duration_ms: number;
    max_dbfs: number;
  }>;
  preservedSpeechStartMs?: number;
  trailingSilenceGuardEndMs?: number;
} {
  const { clip, rawStart, rawEnd, padMs, minPauseMs, transcriptWords, acousticProfile } = options;
  const requestedStart = Math.max(clip.source_in_ms, rawStart);
  const requestedEnd = Math.min(clip.source_out_ms, rawEnd);
  let startMs = requestedStart;
  let endMs = requestedEnd;
  if (endMs <= startMs) {
    return {
      startMs,
      endMs,
      acousticEdgeTrimmed: false,
      splitAroundUntranscribedAudio: false,
      edgeReason: "unchanged",
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
  let leftReason: CleanupEdgeReason = "unchanged";
  let rightReason: CleanupEdgeReason = "unchanged";
  if (prevKeptWord && startMs < prevKeptWord.source_end_ms) {
    startMs = prevKeptWord.source_end_ms;
    leftReason = "pulled_in_before_speech";
  }
  if (nextKeptWord && endMs > nextKeptWord.source_start_ms) {
    endMs = nextKeptWord.source_start_ms;
    rightReason = "pulled_in_before_speech";
  }

  const rank: Record<CleanupEdgeReason, number> = {
    unchanged: 0,
    extended_into_silence: 1,
    split_around_untranscribed_audio: 2,
    pulled_in_before_speech: 3,
  };
  const untranscribedSpans: Array<{
    start_ms: number;
    end_ms: number;
    duration_ms: number;
    max_dbfs: number;
  }> = [];
  let preservedSpeechStartMs: number | undefined;
  let trailingSilenceGuardEndMs: number | undefined;

  // Speech that belongs to words inside the selection is cut content.
  // A later active run is kept speech, even when ASR starts that word late.
  const keptSpeechAfterMs = cutWords.length > 0 ? lastCutWordEnd : requestedStart;

  if (acousticProfile && acousticProfile.has_silence_variation) {
    const winMs = acousticProfile.window_ms;
    const winDbs = acousticProfile.window_dbfs;
    const floorDb = acousticProfile.silence_floor_dbfs;
    const minUntranscribedMs = OPEN_STANDARDS.DIALOGUE_CLEANUP.MIN_UNTRANSCRIBED_SPEECH_MS;
    const isActive = (w: number) => w >= 0 && w < winDbs.length && winDbs[w] > floorDb;

    const leadGapStart = prevKeptWord ? prevKeptWord.source_end_ms : clip.source_in_ms;
    if (firstCutWordStart > leadGapStart) {
      const minAllowedStart =
        leadGapStart === clip.source_in_ms
          ? clip.source_in_ms
          : Math.min(firstCutWordStart, leadGapStart + padMs);
      if (startMs < minAllowedStart) {
        startMs = minAllowedStart;
        leftReason = "pulled_in_before_speech";
      }
      // Step past a kept-word tail, then leave one silent window before the cut.
      const w0 = Math.max(0, Math.floor(startMs / winMs));
      const w1 = Math.min(winDbs.length, Math.floor(firstCutWordStart / winMs));
      let wCur = w0;
      while (wCur < w1 && isActive(wCur)) wCur++;
      if (wCur > w0) {
        startMs = Math.min(firstCutWordStart, (wCur + 1) * winMs);
        leftReason = "pulled_in_before_speech";
      }
    }

    const extensionIsSilent = (fromMs: number, toMs: number): boolean => {
      if (toMs <= fromMs) return true;
      const wLo = Math.max(0, Math.floor(fromMs / winMs));
      const wHi = Math.min(winDbs.length, Math.ceil(toMs / winMs));
      for (let w = wLo; w < wHi; w++) {
        const wStart = w * winMs;
        const wEnd = wStart + winMs;
        if (wEnd <= fromMs || wStart >= toMs) continue;
        if (isActive(w)) return false;
      }
      return true;
    };

    const describeRun = (startW: number) => {
      let endW = startW + 1;
      while (endW < winDbs.length && isActive(endW)) endW++;
      let maxDb = winDbs[startW];
      for (let w = startW + 1; w < endW; w++) {
        if (winDbs[w] > maxDb) maxDb = winDbs[w];
      }
      const start = startW * winMs;
      const end = endW * winMs;
      const overlapsNextWord = nextKeptWord
        ? end > nextKeptWord.source_start_ms - 40 && start < nextKeptWord.source_end_ms + 40
        : false;
      return {
        start,
        end,
        duration: end - start,
        maxDb,
        untranscribed:
          !overlapsNextWord && end - start > minUntranscribedMs && start > keptSpeechAfterMs + 50,
      };
    };

    const rememberPreserved = (run: ReturnType<typeof describeRun>) => {
      if (!run.untranscribed) return;
      untranscribedSpans.push({
        start_ms: run.start,
        end_ms: run.end,
        duration_ms: run.duration,
        max_dbfs: Number(run.maxDb.toFixed(2)),
      });
    };

    // Runs that go silent again before the requested end are speech the transcript missed.
    // Truncating the scan at that end would count a run that continues past it.
    const interiorSpans: Array<{
      start_ms: number;
      end_ms: number;
      duration_ms: number;
      max_dbfs: number;
    }> = [];
    const scanEndMs = Math.min(
      requestedEnd,
      nextKeptWord ? nextKeptWord.source_start_ms : clip.source_out_ms
    );
    const scanW0 = Math.max(0, Math.ceil(lastCutWordEnd / winMs));
    const scanW1 = Math.min(winDbs.length, Math.floor(scanEndMs / winMs));
    let interiorW = -1;
    let interiorMaxDb = -100;
    for (let w = scanW0; w <= scanW1; w++) {
      const isAct = w < scanW1 && isActive(w);
      if (isAct) {
        if (interiorW === -1) {
          interiorW = w;
          interiorMaxDb = winDbs[w];
        } else if (winDbs[w] > interiorMaxDb) {
          interiorMaxDb = winDbs[w];
        }
      } else if (interiorW !== -1) {
        const runStart = interiorW * winMs;
        const runEnd = w * winMs;
        if (
          w < scanW1 &&
          runEnd - runStart > minUntranscribedMs &&
          runStart > lastCutWordEnd + 50 &&
          runEnd <= requestedEnd
        ) {
          interiorSpans.push({
            start_ms: runStart,
            end_ms: runEnd,
            duration_ms: runEnd - runStart,
            max_dbfs: Number(interiorMaxDb.toFixed(2)),
          });
        }
        interiorW = -1;
        interiorMaxDb = -100;
      }
    }

    if (interiorSpans.length > 0) {
      const firstStart = interiorSpans[0].start_ms;
      const stopped = Math.max(lastCutWordEnd, firstStart - padMs);
      if (stopped < endMs) {
        endMs = stopped;
        rightReason = "split_around_untranscribed_audio";
      }
      untranscribedSpans.push(...interiorSpans);
      preservedSpeechStartMs = firstStart;
      const afterMs = interiorSpans[interiorSpans.length - 1].end_ms;
      let attackW = Math.max(0, Math.ceil(afterMs / winMs));
      while (attackW < winDbs.length && !isActive(attackW)) attackW++;
      if (attackW < winDbs.length) {
        const attackMs = attackW * winMs;
        let limit = attackMs - winMs;
        if (nextKeptWord) {
          limit = Math.min(limit, nextKeptWord.source_start_ms);
          const padLimit = nextKeptWord.source_start_ms - padMs;
          if (padLimit < attackMs) limit = Math.min(limit, Math.max(afterMs, padLimit));
        }
        limit = Math.min(clip.source_out_ms, limit);
        if (limit > afterMs) trailingSilenceGuardEndMs = limit;
      }
    }

    const boundaryW = endMs <= 0 ? 0 : Math.min(winDbs.length - 1, Math.floor((endMs - 1) / winMs));
    let runStartW = -1;
    if (interiorSpans.length === 0 && isActive(boundaryW)) {
      runStartW = boundaryW;
      while (runStartW > 0 && isActive(runStartW - 1)) runStartW--;
    }

    if (interiorSpans.length === 0 && runStartW >= 0 && runStartW * winMs > keptSpeechAfterMs) {
      // Requested end sits in a speech run that began after the cut words.
      const attackMs = runStartW * winMs;
      const pulled = Math.max(requestedStart, attackMs - winMs);
      if (pulled < endMs) {
        endMs = pulled;
        rightReason = "pulled_in_before_speech";
        rememberPreserved(describeRun(runStartW));
      }
    } else if (interiorSpans.length === 0) {
      let searchW =
        runStartW >= 0 && runStartW * winMs <= keptSpeechAfterMs
          ? (() => {
              let w = boundaryW + 1;
              while (w < winDbs.length && isActive(w)) w++;
              return w;
            })()
          : Math.max(0, Math.ceil(endMs / winMs));
      while (searchW < winDbs.length && !isActive(searchW)) searchW++;

      const trailGapEnd = nextKeptWord ? nextKeptWord.source_start_ms : clip.source_out_ms;
      const gapDur = trailGapEnd - keptSpeechAfterMs;
      const shouldExtend =
        endMs >= trailGapEnd - 30 ||
        gapDur >= minPauseMs ||
        trailGapEnd - endMs < OPEN_STANDARDS.DIALOGUE_CLEANUP.MIN_REMAINDER_SLIVER_MS;

      if (searchW < winDbs.length) {
        const attackMs = searchW * winMs;
        let limit = attackMs - winMs;
        if (nextKeptWord) {
          limit = Math.min(limit, nextKeptWord.source_start_ms);
          const padLimit = nextKeptWord.source_start_ms - padMs;
          if (padLimit < attackMs) limit = Math.min(limit, Math.max(keptSpeechAfterMs, padLimit));
        }
        limit = Math.min(clip.source_out_ms, Math.max(requestedStart, limit));
        const run = describeRun(searchW);
        if (limit < endMs) {
          endMs = limit;
          rightReason = "pulled_in_before_speech";
          rememberPreserved(run);
        } else if (limit > endMs && shouldExtend && extensionIsSilent(endMs, limit)) {
          endMs = limit;
          rightReason = run.untranscribed ? "split_around_untranscribed_audio" : "extended_into_silence";
          rememberPreserved(run);
        }
      } else if (shouldExtend) {
        let limit = clip.source_out_ms;
        if (nextKeptWord) limit = Math.max(keptSpeechAfterMs, nextKeptWord.source_start_ms - padMs);
        limit = Math.min(clip.source_out_ms, limit);
        if (limit > endMs && extensionIsSilent(endMs, limit)) {
          endMs = limit;
          rightReason = "extended_into_silence";
        } else if (limit < endMs) {
          endMs = Math.max(requestedStart, limit);
          rightReason = "pulled_in_before_speech";
        }
      }
    }
  } else if (nextKeptWord && endMs > lastCutWordEnd && endMs > nextKeptWord.source_start_ms - padMs) {
    endMs = Math.max(lastCutWordEnd, nextKeptWord.source_start_ms - padMs);
    rightReason = "pulled_in_before_speech";
  }

  const edgeReason = rank[leftReason] >= rank[rightReason] ? leftReason : rightReason;
  const acousticEdgeTrimmed = startMs !== requestedStart || endMs !== requestedEnd;
  return {
    startMs: Math.max(clip.source_in_ms, startMs),
    endMs: Math.min(clip.source_out_ms, Math.max(startMs, endMs)),
    acousticEdgeTrimmed,
    splitAroundUntranscribedAudio:
      preservedSpeechStartMs !== undefined || edgeReason === "split_around_untranscribed_audio",
    edgeReason,
    ...(untranscribedSpans.length > 0 ? { untranscribedAudioSpans: untranscribedSpans } : {}),
    ...(preservedSpeechStartMs !== undefined ? { preservedSpeechStartMs } : {}),
    ...(trailingSilenceGuardEndMs !== undefined ? { trailingSilenceGuardEndMs } : {}),
  };
}

export function verifyPauseCandidatesAcoustically(params: {
  clip: SpineClip;
  mergedPauseCandidates: RawCandidate[];
  acousticProfile: ReturnType<typeof measureAssetAcousticWindows>;
  minPauseMs: number;
  rejectedNearMisses: DecisionTraceItem[];
}): RawCandidate[] {
  const { clip, mergedPauseCandidates, acousticProfile, minPauseMs, rejectedNearMisses } = params;

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
            note: `${dur}ms of untranscribed audio (${seg.start_ms}..${seg.end_ms}ms, peak ${maxDb} dBFS > floor ${silenceFloorDbfs} dBFS) inside pause candidate (${cand.rawStart}..${cand.rawEnd}ms) was kept; cut by hand if it is a voiced filler`,
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
          note: `Pause candidate (${cand.rawStart}..${cand.rawEnd}ms) kept because the silent region left (${maxSilentMs}ms) after narrowing to the acoustic silence floor (${silenceFloorDbfs} dBFS) fell below the threshold (${minPauseMs}ms)`,
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
            note: `Pause piece split around untranscribed audio (${dr.start_ms}..${dr.end_ms}ms, ${drDur}ms) dropped for falling below the threshold (${minPauseMs}ms)`,
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

  return acousticallyVerifiedPauses;
}
