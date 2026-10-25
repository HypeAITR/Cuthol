// Candidate loading, review/repetition collection, and cut_candidates resolution for dialogue cleanup.

import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence, SpineClip } from "../core/schema.js";
import { parseTimeMs } from "../core/time.js";
import { analyzeAssetWaveform, measureAssetAcousticWindows } from "../library/waveform.js";
import { sourceMsToSequenceMs } from "../sequence/spine.js";
import type { ContextualFillerReviewCandidate } from "./cleanup.js";
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
  RepetitionRestartCandidate,
} from "./repetitions.js";
import { loadCachedTranscriptForAsset } from "./transcribe.js";

export interface SelectedCandidateSpan {
  kind: "filler" | "repetition";
  candidateId?: string;
  label: string;
  startMs: number;
  endMs: number;
}

export interface CleanupAssetLoaders {
  getAssetTranscriptAndSpans: (clip: SpineClip) => {
    spans: DetectedDisfluencySpan[];
    words: RawTranscriptWord[];
    docDurationMs: number;
  };
  getAssetRepetitionCandidates: (
    clip: SpineClip,
    transcriptWords: RawTranscriptWord[],
    docDurationMs: number
  ) => RepetitionRestartCandidate[];
  getAssetAcousticProfile: (
    assetHandle: string
  ) => ReturnType<typeof measureAssetAcousticWindows>;
}

export function resolveCleanupTargetClips(
  sequence: CutholSequence,
  options: {
    clipId?: string;
    clipIds?: string[];
    allSpine?: boolean;
  }
): SpineClip[] {
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

  return targetClips;
}

export function createCleanupAssetLoaders(options: {
  workspaceDir: string;
  useAcousticFallback?: boolean;
  language?: string;
}): CleanupAssetLoaders {
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

  return {
    getAssetTranscriptAndSpans,
    getAssetRepetitionCandidates,
    getAssetAcousticProfile,
  };
}

export function collectCleanupReviewAndRepetitionCandidates(params: {
  sequence: CutholSequence;
  targetClips: SpineClip[];
  getAssetTranscriptAndSpans: CleanupAssetLoaders["getAssetTranscriptAndSpans"];
  getAssetRepetitionCandidates: CleanupAssetLoaders["getAssetRepetitionCandidates"];
}): {
  allReviewCandidates: ContextualFillerReviewCandidate[];
  allRepetitionCandidates: RepetitionRestartCandidate[];
  reviewCandidatesByClip: Map<string, ContextualFillerReviewCandidate[]>;
  repetitionCandidatesByClip: Map<string, RepetitionRestartCandidate[]>;
} {
  const {
    sequence,
    targetClips,
    getAssetTranscriptAndSpans,
    getAssetRepetitionCandidates,
  } = params;

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

  return {
    allReviewCandidates,
    allRepetitionCandidates,
    reviewCandidatesByClip,
    repetitionCandidatesByClip,
  };
}

function addSelectedSpan(
  customSelectedSpansByAsset: Map<string, SelectedCandidateSpan[]>,
  assetHandle: string,
  span: SelectedCandidateSpan
): void {
  if (span.endMs <= span.startMs) return;
  const list = customSelectedSpansByAsset.get(assetHandle) ?? [];
  list.push(span);
  customSelectedSpansByAsset.set(assetHandle, list);
}

export function scheduleRepetitionCandidate(
  rc: RepetitionRestartCandidate,
  modifier: string | undefined,
  selectedRepetitionIds: Set<string>,
  customSelectedSpansByAsset: Map<string, SelectedCandidateSpan[]>
): void {
  selectedRepetitionIds.add(rc.id);
  if (!modifier) {
    addSelectedSpan(customSelectedSpansByAsset, rc.asset_handle, {
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
        addSelectedSpan(customSelectedSpansByAsset, rc.asset_handle, {
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
      addSelectedSpan(customSelectedSpansByAsset, rc.asset_handle, {
        kind: "repetition",
        candidateId: att.attempt_id,
        label: `${rc.kind}:${att.text}`,
        startMs: cStart,
        endMs: cEnd,
      });
    }
  }
}

export function resolveSelectedCutCandidates(params: {
  cutCandidates?: string[];
  targetClips: SpineClip[];
  allReviewCandidates: ContextualFillerReviewCandidate[];
  allRepetitionCandidates: RepetitionRestartCandidate[];
}): {
  selectedReviewIds: Set<string>;
  selectedRepetitionIds: Set<string>;
  customSelectedSpansByAsset: Map<string, SelectedCandidateSpan[]>;
} {
  const { cutCandidates, targetClips, allReviewCandidates, allRepetitionCandidates } = params;

  // Pass 2: Resolve `cut_candidates` selections (supports persistent `cf_...`, `rr_...`,
  // `:keep=K` / `:cut=K` / `#K` attempt overrides, legacy ordinal `cf_01`/`rr_01`, and source ranges `start..end`)
  const selectedReviewIds = new Set<string>();
  const selectedRepetitionIds = new Set<string>();
  const customSelectedSpansByAsset = new Map<string, SelectedCandidateSpan[]>();

  const rawCutSpecs = (cutCandidates ?? [])
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter(Boolean);

  for (const spec of rawCutSpecs) {
    const lower = spec.toLowerCase();

    if (lower === "all_repetitions" || lower === "all_restarts" || lower === "rr_*") {
      for (const rc of allRepetitionCandidates) {
        if (!selectedRepetitionIds.has(rc.id)) {
          scheduleRepetitionCandidate(
            rc,
            undefined,
            selectedRepetitionIds,
            customSelectedSpansByAsset
          );
        }
      }
      continue;
    }

    if (lower === "all_fillers" || lower === "cf_*") {
      for (const cf of allReviewCandidates) {
        if (!selectedReviewIds.has(cf.id)) {
          selectedReviewIds.add(cf.id);
          addSelectedSpan(
            customSelectedSpansByAsset,
            cf.asset_handle ?? targetClips[0].asset_handle,
            {
              kind: "filler",
              candidateId: cf.id,
              label: cf.punctuated_word,
              startMs: cf.source_start_ms,
              endMs: cf.source_end_ms,
            }
          );
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
        scheduleRepetitionCandidate(
          foundRR,
          modifier,
          selectedRepetitionIds,
          customSelectedSpansByAsset
        );
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
        addSelectedSpan(
          customSelectedSpansByAsset,
          foundCF.asset_handle ?? targetClips[0].asset_handle,
          {
            kind: "filler",
            candidateId: foundCF.id,
            label: foundCF.punctuated_word,
            startMs: foundCF.source_start_ms,
            endMs: foundCF.source_end_ms,
          }
        );
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
            addSelectedSpan(
              customSelectedSpansByAsset,
              rc.asset_handle ?? targetClips[0].asset_handle,
              {
                kind: "filler",
                candidateId: rc.id,
                label: rc.punctuated_word,
                startMs: rc.source_start_ms,
                endMs: rc.source_end_ms,
              }
            );
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
            scheduleRepetitionCandidate(
              rr,
              undefined,
              selectedRepetitionIds,
              customSelectedSpansByAsset
            );
            break;
          }
        }
      }

      if (!matchedAny) {
        const targetAssetHandles = assetPrefix
          ? [assetPrefix]
          : Array.from(new Set(targetClips.map((c) => c.asset_handle)));
        for (const ah of targetAssetHandles) {
          addSelectedSpan(customSelectedSpansByAsset, ah, {
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
          addSelectedSpan(
            customSelectedSpansByAsset,
            rc.asset_handle ?? targetClips[0].asset_handle,
            {
              kind: "filler",
              candidateId: rc.id,
              label: rc.punctuated_word,
              startMs: rc.source_start_ms,
              endMs: rc.source_end_ms,
            }
          );
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
        addSelectedSpan(
          customSelectedSpansByAsset,
          foundAtPoint.asset_handle ?? targetClips[0].asset_handle,
          {
            kind: "filler",
            candidateId: foundAtPoint.id,
            label: foundAtPoint.punctuated_word,
            startMs: foundAtPoint.source_start_ms,
            endMs: foundAtPoint.source_end_ms,
          }
        );
      }
    } catch {
      // ignore unparseable spec
    }
  }

  return {
    selectedReviewIds,
    selectedRepetitionIds,
    customSelectedSpansByAsset,
  };
}
