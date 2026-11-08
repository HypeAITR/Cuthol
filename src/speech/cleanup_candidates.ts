// Candidate loading, review/repetition collection, and cut_candidates resolution for dialogue cleanup.

import fs from "node:fs";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence, SpineClip } from "../core/schema.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import { parseTimeMs } from "../core/time.js";
import { loadSequence } from "../core/workspace.js";
import { resolveLibraryItemPath } from "../library/probe.js";
import { analyzeAssetWaveform, measureAssetAcousticWindows } from "../library/waveform.js";
import { sourceMsToSequenceMs } from "../sequence/spine.js";
import { rememberAcousticProfile } from "./cleanup_acoustic.js";
import type {
  ContextualFillerReviewCandidate,
  PlannedCutInterval,
  PreservedUntranscribedSpan,
  TailWithoutAudioCandidate,
} from "./cleanup.js";
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
  DISTANT_REPETITION_GAP_MS,
  RepetitionRestartCandidate,
} from "./repetitions.js";
import { loadCachedTranscriptForAsset } from "./transcribe.js";

const NEAR_PRESERVED_CANDIDATE_MS = 1000;

export interface SelectedCandidateSpan {
  kind: "filler" | "repetition" | "tail_without_audio";
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
  getAssetAudioEndMs: (assetHandle: string) => number | null;
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
        options.language ?? "auto"
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
    if (profile) {
      try {
        const { sequence } = loadSequence(options.workspaceDir);
        const item = sequence.library.find((asset) => asset.handle === assetHandle);
        if (item) rememberAcousticProfile(item.digest_sha256, profile);
      } catch {
        // The profile is still returned for this cleanup call.
      }
    }
    return profile;
  };

  const audioEndCache = new Map<string, number | null>();
  const getAssetAudioEndMs = (assetHandle: string): number | null => {
    if (audioEndCache.has(assetHandle)) return audioEndCache.get(assetHandle) ?? null;
    let endMs: number | null = null;
    try {
      const { paths, sequence } = loadSequence(options.workspaceDir);
      const item = sequence.library.find((asset) => asset.handle === assetHandle);
      if (item?.probe.has_audio) {
        const ends: number[] = [];
        const profile = getAssetAcousticProfile(assetHandle);
        if (profile && profile.duration_ms > 0) ends.push(profile.duration_ms);
        const absPath = resolveLibraryItemPath(paths.rootDir, item);
        const streamMs = readAudioStreamDurationMs(absPath);
        if (streamMs != null && streamMs > 0) ends.push(streamMs);
        endMs = ends.length > 0 ? Math.min(...ends) : null;
      }
    } catch {
      endMs = null;
    }
    audioEndCache.set(assetHandle, endMs);
    return endMs;
  };

  return {
    getAssetTranscriptAndSpans,
    getAssetRepetitionCandidates,
    getAssetAcousticProfile,
    getAssetAudioEndMs,
  };
}

function readAudioStreamDurationMs(absPath: string): number | null {
  if (!absPath || !fs.existsSync(absPath)) return null;
  const proc = spawnWatchedSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=duration",
      "-of",
      "csv=p=0",
      absPath,
    ],
    { encoding: "utf8", step: "ffprobe audio duration" }
  );
  if (proc.status !== 0) return null;
  const seconds = Number.parseFloat(String(proc.stdout).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
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

export function partitionRepetitionCandidates(candidates: RepetitionRestartCandidate[]): {
  near: RepetitionRestartCandidate[];
  distant: RepetitionRestartCandidate[];
} {
  const near: RepetitionRestartCandidate[] = [];
  const distant: RepetitionRestartCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.gap_ms > DISTANT_REPETITION_GAP_MS) distant.push(candidate);
    else near.push(candidate);
  }
  return { near, distant };
}

export function collectTailWithoutAudioCandidates(params: {
  sequence: CutholSequence;
  targetClips: SpineClip[];
  getAssetAudioEndMs: CleanupAssetLoaders["getAssetAudioEndMs"];
}): TailWithoutAudioCandidate[] {
  const tails: TailWithoutAudioCandidate[] = [];
  const seen = new Set<string>();
  for (const clip of params.targetClips) {
    const asset = params.sequence.library.find((item) => item.handle === clip.asset_handle);
    if (!asset?.probe.has_audio || !asset.probe.has_video) continue;
    const audioEnd = params.getAssetAudioEndMs(clip.asset_handle);
    if (audioEnd == null || audioEnd <= 0) continue;
    if (audioEnd >= asset.probe.duration_ms) continue;
    const tailStart = Math.max(clip.source_in_ms, audioEnd);
    const tailEnd = Math.min(clip.source_out_ms, asset.probe.duration_ms);
    if (tailEnd <= tailStart) continue;
    const fps = asset.probe.fps > 0 ? asset.probe.fps : params.sequence.stage.fps;
    if (!(fps > 0) || (tailEnd - tailStart) * fps < 1000) continue;
    const id = `ta_${clip.asset_handle}_${tailStart}_${tailEnd}`;
    if (seen.has(id)) continue;
    seen.add(id);
    tails.push({
      id,
      kind: "tail_without_audio",
      clip_id: clip.id,
      asset_handle: clip.asset_handle,
      source_start_ms: tailStart,
      source_end_ms: tailEnd,
      duration_ms: tailEnd - tailStart,
      sequence_start_ms: sourceMsToSequenceMs(clip, tailStart),
      sequence_end_ms: sourceMsToSequenceMs(clip, tailEnd),
    });
  }
  return tails;
}

function rangeDistance(startA: number, endA: number, startB: number, endB: number): number {
  if (endA < startB) return startB - endA;
  if (endB < startA) return startA - endB;
  return 0;
}

export function buildPreservedUntranscribed(params: {
  cuts: PlannedCutInterval[];
  repetitionCandidates: RepetitionRestartCandidate[];
  selectedSpansByAsset: Map<string, SelectedCandidateSpan[]>;
}): PreservedUntranscribedSpan[] {
  const preserved: PreservedUntranscribedSpan[] = [];
  const seen = new Set<string>();
  for (const cut of params.cuts) {
    if (!cut.clip_id || !cut.untranscribed_audio_spans) continue;
    for (const span of cut.untranscribed_audio_spans) {
      const key = `${cut.clip_id}:${span.start_ms}:${span.end_ms}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let bestId: string | undefined;
      let bestDistance = NEAR_PRESERVED_CANDIDATE_MS + 1;
      for (const candidate of params.repetitionCandidates) {
        if (cut.asset_handle && candidate.asset_handle !== cut.asset_handle) continue;
        const distance = rangeDistance(
          span.start_ms,
          span.end_ms,
          candidate.source_start_ms,
          candidate.source_end_ms
        );
        if (distance <= NEAR_PRESERVED_CANDIDATE_MS && distance < bestDistance) {
          bestDistance = distance;
          bestId = candidate.id;
        }
      }
      const selected = cut.asset_handle
        ? (params.selectedSpansByAsset.get(cut.asset_handle) ?? [])
        : [];
      for (const sel of selected) {
        if (!sel.candidateId) continue;
        const distance = rangeDistance(span.start_ms, span.end_ms, sel.startMs, sel.endMs);
        if (distance <= NEAR_PRESERVED_CANDIDATE_MS && distance < bestDistance) {
          bestDistance = distance;
          bestId = sel.candidateId;
        }
      }
      preserved.push({
        clip_id: cut.clip_id,
        source_start_ms: span.start_ms,
        source_end_ms: span.end_ms,
        duration_ms: span.duration_ms,
        max_dbfs: span.max_dbfs,
        ...(bestId ? { near_candidate_id: bestId } : {}),
      });
    }
  }
  return preserved;
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
  tailWithoutAudioCandidates?: TailWithoutAudioCandidate[];
}): {
  selectedReviewIds: Set<string>;
  selectedRepetitionIds: Set<string>;
  selectedTailIds: Set<string>;
  customSelectedSpansByAsset: Map<string, SelectedCandidateSpan[]>;
} {
  const {
    cutCandidates,
    targetClips,
    allReviewCandidates,
    allRepetitionCandidates,
    tailWithoutAudioCandidates = [],
  } = params;

  // Pass 2: Resolve `cut_candidates` selections (supports persistent `cf_...`, `rr_...`,
  // `:keep=K` / `:cut=K` / `#K` attempt overrides, legacy ordinal `cf_01`/`rr_01`, and source ranges `start..end`)
  const selectedReviewIds = new Set<string>();
  const selectedRepetitionIds = new Set<string>();
  const selectedTailIds = new Set<string>();
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

    if (lower.startsWith("ta_")) {
      const foundTail = tailWithoutAudioCandidates.find((tail) => tail.id.toLowerCase() === lower);
      if (foundTail && !selectedTailIds.has(foundTail.id)) {
        selectedTailIds.add(foundTail.id);
        addSelectedSpan(customSelectedSpansByAsset, foundTail.asset_handle, {
          kind: "tail_without_audio",
          candidateId: foundTail.id,
          label: "tail_without_audio",
          startMs: foundTail.source_start_ms,
          endMs: foundTail.source_end_ms,
        });
      }
      continue;
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
    selectedTailIds,
    customSelectedSpansByAsset,
  };
}
