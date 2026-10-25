// Acoustic window edge refinement and pause verification for dialogue cleanup.

import { DecisionTraceItem } from "../core/decision_trace.js";
import { SpineClip } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { measureAssetAcousticWindows } from "../library/waveform.js";
import { RawTranscriptWord } from "./providers.js";

export interface RawCandidate {
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

  return acousticallyVerifiedPauses;
}
