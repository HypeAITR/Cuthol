/**
 * Cuthol Automatic Active-Word Caption Generator (`src/speech/captions.ts`).
 *
 * Projects cached transcript words across all active `spine` clips (and/or `ln_vo` voiceover cues)
 * using `projectTranscriptAcrossSequence` (which applies the exact `speed_ramp` integral and
 * sets `sequence_start_ms: null, excised: true` on any words falling in excised gaps).
 * Automatically skips excised words and groups active words into readable caption cues on `ln_captions`.
 */

import { resolveCueStartMs } from "../brief/inspector.js";
import { wrapTypographyLines } from "../compositor/ass_generator.js";
import { DecisionTrace, DecisionTraceItem } from "../core/decision_trace.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  allocateNextHandle,
  createDefaultPlacement,
  LaneCue,
  syncSequenceHandleCounters,
  TimedWordToken,
  TypographySpec,
} from "../core/schema.js";
import {
  isVerticalStage,
  OPEN_STANDARDS,
  resolveDefaultCaptionFontSizePx,
  resolveDefaultCaptionMaxWidthPct,
} from "../core/standards.js";
import { loadSequence } from "../core/workspace.js";
import { projectTranscriptAcrossSequence, projectTranscriptWordsToClip } from "../sequence/spine.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";
import { loadCachedTranscriptForAsset } from "./transcribe.js";

export type CaptionStylePreset = "active_word" | "sentence" | "boxed";

export interface GenerateCaptionsResult {
  style: CaptionStylePreset;
  cues_created: number;
  skipped_excised_words: number;
  cues: LaneCue[];
  decision_trace: DecisionTrace;
  revision: number;
  verification: VerificationReport;
}

export function generateSequenceCaptions(options: {
  workspaceDir: string;
  clipId?: string;
  allSpineOnly?: boolean;
  style?: CaptionStylePreset;
  maxWordsPerGroup?: number;
  maxCharsPerLine?: number;
  language?: string;
  replaceExistingCaptions?: boolean;
}): GenerateCaptionsResult {
  const { sequence: initialSeq } = loadSequence(options.workspaceDir);
  const style: CaptionStylePreset = options.style ?? "active_word";
  const verticalStage = isVerticalStage(initialSeq.stage);
  const defaultMaxWords = verticalStage
    ? OPEN_STANDARDS.CAPTIONS.DEFAULT_MAX_WORDS_PER_GROUP_9_16
    : OPEN_STANDARDS.CAPTIONS.DEFAULT_MAX_WORDS_PER_GROUP;
  const maxWords = options.maxWordsPerGroup ?? defaultMaxWords;
  const maxChars =
    options.maxCharsPerLine ??
    (verticalStage
      ? OPEN_STANDARDS.CAPTIONS.MAX_CHARS_PER_LINE_9_16
      : OPEN_STANDARDS.CAPTIONS.MAX_CHARS_PER_LINE_16_9);
  const defaultFontSizePx = resolveDefaultCaptionFontSizePx(initialSeq.stage);
  const defaultMaxWidthPct = resolveDefaultCaptionMaxWidthPct(initialSeq.stage);
  const lang = options.language ?? "tr";
  let detectedTranscriptLang: string | null = null;
  const replaceExisting = options.replaceExistingCaptions ?? true;
  const minFrameDurMs = Math.ceil(
    (OPEN_STANDARDS.SIGNAL_SANITY.MIN_CLIP_FRAMES * 1000) / Math.max(1, initialSeq.stage.fps)
  );

  // Collect projected words across target clip or all spine clips + voiceover cues
  const allProjectedWords: TimedWordToken[] = [];
  let skippedExcisedCount = 0;
  let targetClipWindow: { startMs: number; endMs: number } | null = null;

  if (options.clipId) {
    const targetClip = initialSeq.spine.clips.find((c) => c.id === options.clipId);
    if (targetClip) {
      targetClipWindow = {
        startMs: targetClip.timeline_in_ms,
        endMs: targetClip.timeline_in_ms + targetClip.duration_ms,
      };
      const doc = loadCachedTranscriptForAsset(options.workspaceDir, targetClip.asset_handle, lang);
      if (!detectedTranscriptLang && doc.language) detectedTranscriptLang = doc.language;
      const activeWords = doc.words.map((w) => ({
        word: w.punctuated_word || w.word,
        source_start_ms: w.source_start_ms,
        source_end_ms: w.source_end_ms,
        confidence: w.confidence,
      }));
      const projectedForClip = projectTranscriptWordsToClip(targetClip, activeWords);
      skippedExcisedCount += Math.max(0, activeWords.length - projectedForClip.length);
      allProjectedWords.push(...projectedForClip);
    } else {
      const voCue = initialSeq.lanes
        .flatMap((l) => l.cues)
        .find((c) => c.id === options.clipId && Boolean(c.asset_handle));
      if (!voCue || !voCue.asset_handle) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.clipId));
      }
      const doc = loadCachedTranscriptForAsset(options.workspaceDir, voCue.asset_handle, lang);
      if (!detectedTranscriptLang && doc.language) detectedTranscriptLang = doc.language;
      const cueStart = resolveCueStartMs(initialSeq, voCue);
      targetClipWindow = { startMs: cueStart, endMs: cueStart + voCue.duration_ms };
      const cueSourceIn = voCue.source_in_ms ?? 0;
      const cueSourceOut = Math.min(
        voCue.source_out_ms ?? cueSourceIn + voCue.duration_ms,
        cueSourceIn + voCue.duration_ms
      );
      for (const w of doc.words) {
        if (w.source_end_ms <= cueSourceIn || w.source_start_ms >= cueSourceOut) {
          skippedExcisedCount++;
          continue;
        }
        const clampedStart = Math.max(cueSourceIn, w.source_start_ms);
        const clampedEnd = Math.min(cueSourceOut, w.source_end_ms);
        if (clampedEnd <= clampedStart) {
          skippedExcisedCount++;
          continue;
        }
        const seqStart = cueStart + (clampedStart - cueSourceIn);
        const seqEnd = Math.max(seqStart + 1, cueStart + Math.min(voCue.duration_ms, clampedEnd - cueSourceIn));
        allProjectedWords.push({
          word: w.punctuated_word || w.word,
          source_start_ms: clampedStart,
          source_end_ms: clampedEnd,
          sequence_start_ms: seqStart,
          sequence_end_ms: seqEnd,
          clip_id: voCue.id,
          excised: false,
          confidence: w.confidence,
        });
      }
    }
  } else {
    // Group spine clips by unique asset_handle so `projectTranscriptAcrossSequence` marks excised words accurately
    const seenSpineAssets = new Set<string>();
    const mutedSpineClipIds = new Set(
      initialSeq.spine.clips.filter((c) => c.audio_chain.muted).map((c) => c.id)
    );
    for (const clip of initialSeq.spine.clips) {
      if (clip.audio_chain.muted) continue;
      if (seenSpineAssets.has(clip.asset_handle)) continue;
      seenSpineAssets.add(clip.asset_handle);
      try {
        const doc = loadCachedTranscriptForAsset(options.workspaceDir, clip.asset_handle, lang);
        if (!detectedTranscriptLang && doc.language) detectedTranscriptLang = doc.language;
        const allAssetWords = doc.words.map((w) => ({
          word: w.punctuated_word || w.word,
          source_start_ms: w.source_start_ms,
          source_end_ms: w.source_end_ms,
          confidence: w.confidence,
        }));
        const projected = projectTranscriptAcrossSequence(
          initialSeq,
          clip.asset_handle,
          allAssetWords
        );
        for (const pw of projected) {
          if (
            pw.excised ||
            pw.sequence_start_ms === null ||
            pw.sequence_end_ms === null ||
            (pw.clip_id && mutedSpineClipIds.has(pw.clip_id))
          ) {
            skippedExcisedCount++;
          } else {
            allProjectedWords.push(pw);
          }
        }
      } catch {
        // Skip assets without transcripts
      }
    }

    // Also check voiceover lane cues (`ln_vo` or `cue.kind === "voiceover"`) unless `--all-spine` is set
    if (!options.allSpineOnly) {
      for (const lane of initialSeq.lanes) {
        if (lane.muted) continue;
        for (const voCue of lane.cues) {
          const isVoCue = lane.id === "ln_vo" || lane.kind === "voiceover" || voCue.kind === "voiceover";
          if (!isVoCue || !voCue.asset_handle || voCue.audio_chain?.muted) continue;
          try {
            const doc = loadCachedTranscriptForAsset(options.workspaceDir, voCue.asset_handle, lang);
            if (!detectedTranscriptLang && doc.language) detectedTranscriptLang = doc.language;
            const cueStart = resolveCueStartMs(initialSeq, voCue);
            const cueSourceIn = voCue.source_in_ms ?? 0;
            const cueSourceOut = Math.min(
              voCue.source_out_ms ?? cueSourceIn + voCue.duration_ms,
              cueSourceIn + voCue.duration_ms
            );
            for (const w of doc.words) {
              if (w.source_end_ms <= cueSourceIn || w.source_start_ms >= cueSourceOut) continue;
              const clampedStart = Math.max(cueSourceIn, w.source_start_ms);
              const clampedEnd = Math.min(cueSourceOut, w.source_end_ms);
              if (clampedEnd <= clampedStart) continue;
              const seqStart = cueStart + (clampedStart - cueSourceIn);
              const seqEnd = Math.max(
                seqStart + 1,
                cueStart + Math.min(voCue.duration_ms, clampedEnd - cueSourceIn)
              );
              allProjectedWords.push({
                word: w.punctuated_word || w.word,
                source_start_ms: clampedStart,
                source_end_ms: clampedEnd,
                sequence_start_ms: seqStart,
                sequence_end_ms: seqEnd,
                clip_id: voCue.id,
                excised: false,
                confidence: w.confidence,
              });
            }
          } catch {
            // Ignore if no transcript
          }
        }
      }
    }
  }

  const effectiveLang =
    options.language && options.language !== "auto"
      ? options.language
      : detectedTranscriptLang ?? lang;

  // Filter out any remaining null/excised words and sort chronologically by sequence_start_ms
  const validWords = allProjectedWords
    .filter(
      (w): w is TimedWordToken & { sequence_start_ms: number; sequence_end_ms: number } =>
        !w.excised && w.sequence_start_ms !== null && w.sequence_end_ms !== null
    )
    .sort((a, b) => a.sequence_start_ms - b.sequence_start_ms);

  // Group into caption phrases
  const groups: Array<Array<TimedWordToken & { sequence_start_ms: number; sequence_end_ms: number }>> = [];
  let currentGroup: Array<TimedWordToken & { sequence_start_ms: number; sequence_end_ms: number }> = [];
  let currentChars = 0;

  for (let i = 0; i < validWords.length; i++) {
    const w = validWords[i];
    const prev = currentGroup.length > 0 ? currentGroup[currentGroup.length - 1] : null;
    const gapMs = prev ? w.sequence_start_ms - prev.sequence_end_ms : 0;
    const prevEndsSentence = prev ? /[.?!…]$/.test(prev.word) : false;
    const nextChars = currentChars + (currentChars > 0 ? 1 : 0) + w.word.length;

    const groupSpanIfSplitMs =
      currentGroup.length > 0 ? w.sequence_start_ms - currentGroup[0].sequence_start_ms : 0;

    let wouldOverflowVerticalLines = false;
    let canAbsorbClauseFinalWord = false;
    if (verticalStage && currentGroup.length > 0) {
      const candidateText = [...currentGroup.map((tok) => tok.word), w.word].join(" ");
      const wrappedLines = wrapTypographyLines(
        candidateText,
        defaultFontSizePx,
        initialSeq.stage.width,
        defaultMaxWidthPct
      ).lines.length;
      wouldOverflowVerticalLines = wrappedLines > 2;

      const nextW = i + 1 < validWords.length ? validWords[i + 1] : null;
      const wEndsClause =
        /[.?!…]$/.test(w.word) ||
        !nextW ||
        nextW.sequence_start_ms - w.sequence_end_ms >= 350;
      canAbsorbClauseFinalWord =
        wEndsClause &&
        currentGroup.length === maxWords &&
        !wouldOverflowVerticalLines &&
        nextChars <= maxChars + 6 &&
        gapMs < 350 &&
        !prevEndsSentence;
    }

    if (
      currentGroup.length > 0 &&
      groupSpanIfSplitMs >= minFrameDurMs &&
      ((currentGroup.length >= maxWords && !canAbsorbClauseFinalWord) ||
        (nextChars > maxChars && !canAbsorbClauseFinalWord) ||
        wouldOverflowVerticalLines ||
        gapMs >= 350 ||
        prevEndsSentence)
    ) {
      groups.push(currentGroup);
      currentGroup = [];
      currentChars = 0;
    }

    currentGroup.push(w);
    currentChars += (currentChars > 0 ? 1 : 0) + w.word.length;
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  const { result: createdCues, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `speech.captions(${style})`,
    (seq) => {
      let capLane = seq.lanes.find((l) => l.id === "ln_captions");
      if (!capLane) {
        capLane = {
          id: "ln_captions",
          kind: "caption",
          z_index: 30,
          muted: false,
          locked: false,
          cues: [],
        };
        seq.lanes.push(capLane);
      }

      syncSequenceHandleCounters(seq);
      if (replaceExisting) {
        if (options.clipId && options.replaceExistingCaptions === undefined && targetClipWindow) {
          capLane.cues = capLane.cues.filter((c) => {
            const cStart = resolveCueStartMs(seq, c);
            const cEnd = cStart + c.duration_ms;
            return cEnd <= targetClipWindow.startMs || cStart >= targetClipWindow.endMs;
          });
        } else {
          capLane.cues = [];
        }
      }

      const existingCueIds = new Set(seq.lanes.flatMap((l) => l.cues.map((c) => c.id)));
      const newCues: LaneCue[] = [];
      const maxCps = effectiveLang.toLowerCase().startsWith("tr")
        ? OPEN_STANDARDS.CAPTIONS.TURKISH_MAX_CPS
        : OPEN_STANDARDS.CAPTIONS.DEFAULT_MAX_CPS;

      for (let gIdx = 0; gIdx < groups.length; gIdx++) {
        const grp = groups[gIdx];
        const startMs = grp[0].sequence_start_ms;
        const rawEndMs = grp[grp.length - 1].sequence_end_ms;
        const text = grp.map((w) => w.word).join(" ");
        const minDurationForCpsMs = Math.ceil((text.length / maxCps) * 1000);
        const hasNextGroup = gIdx + 1 < groups.length;
        const nextGroupStartMs = hasNextGroup
          ? groups[gIdx + 1][0].sequence_start_ms
          : Math.max(rawEndMs, startMs + minDurationForCpsMs, startMs + 200);
        const maxAvailableDurMs = hasNextGroup
          ? Math.max(minFrameDurMs, nextGroupStartMs - startMs)
          : Math.max(200, nextGroupStartMs - startMs);
        const durationMs = Math.min(
          maxAvailableDurMs,
          Math.max(minFrameDurMs, Math.min(200, maxAvailableDurMs), rawEndMs - startMs, minDurationForCpsMs)
        );

        const id = allocateNextHandle(existingCueIds, "cue", seq);
        existingCueIds.add(id);

        const placement = createDefaultPlacement();
        placement.x_pct = 0;
        // Position at +26% (safe above bottom 18% vertical social chrome)
        placement.y_pct = 26;

        const cueWords =
          style === "active_word"
            ? grp.map((w, idx) =>
                idx === grp.length - 1 && startMs + durationMs > w.sequence_end_ms
                  ? { ...w, sequence_end_ms: startMs + durationMs }
                  : w
              )
            : undefined;

        const typography: TypographySpec = {
          text,
          words: cueWords,
          font_family: "Arial",
          font_size_px: resolveDefaultCaptionFontSizePx(seq.stage),
          font_weight: 800,
          color_hex: "#FFFFFF",
          active_word_color_hex: style === "active_word" ? "#FACC15" : undefined,
          stroke_color_hex: "#0F172A",
          stroke_width_px: style === "boxed" ? 0 : 4,
          box_color_hex: style === "boxed" ? "#0F172A" : null,
          box_opacity: style === "boxed" ? 0.85 : 0,
          align: "center",
          max_width_pct: resolveDefaultCaptionMaxWidthPct(seq.stage),
        };

        const cue: LaneCue = {
          id,
          kind: "caption",
          anchor: null,
          at_ms: startMs,
          duration_ms: durationMs,
          placement,
          typography,
          envelopes: [],
        };

        capLane.cues.push(cue);
        newCues.push(cue);
      }

      return newCues;
    }
  );

  const maxCps = effectiveLang.toLowerCase().startsWith("tr")
    ? OPEN_STANDARDS.CAPTIONS.TURKISH_MAX_CPS
    : OPEN_STANDARDS.CAPTIONS.DEFAULT_MAX_CPS;

  const capDecisions: DecisionTraceItem[] = [];
  const capNearMisses: DecisionTraceItem[] = [];
  let sumCps = 0;

  for (const cue of createdCues) {
    const txt = cue.typography?.text ?? "";
    const cps = Number((txt.length / Math.max(0.1, cue.duration_ms / 1000)).toFixed(1));
    sumCps += cps;
    const exceeded = cps > maxCps;
    const item: DecisionTraceItem = {
      id: cue.id,
      span: [cue.at_ms, cue.at_ms + cue.duration_ms],
      action: exceeded ? "clamped" : "applied",
      reason_code: exceeded ? "CPS_EXCEEDED" : "APPLIED",
      measured: { cps, chars: txt.length, duration_ms: cue.duration_ms },
      threshold: { max_cps: maxCps, max_chars_per_line: maxChars },
      margin: Number((cps - maxCps).toFixed(1)),
    };
    capDecisions.push(item);
    if (exceeded) capNearMisses.push(item);
  }

  const meanCps = createdCues.length > 0 ? Number((sumCps / createdCues.length).toFixed(1)) : 0;
  const decisionTrace: DecisionTrace = {
    trace_id: `tr_cap_r${revision}`,
    feature: "auto_caption",
    algorithm: { id: "caption.dual-clock-grouper", version: "2.0.0" },
    revision,
    params: {
      style: { value: style, default: "active_word", source: options.style !== undefined ? "user" : "default" },
      max_words_per_group: { value: maxWords, default: defaultMaxWords, source: options.maxWordsPerGroup !== undefined ? "user" : "default" },
      max_chars_per_line: { value: maxChars, default: maxChars, source: options.maxCharsPerLine !== undefined ? "user" : "preset" },
      max_cps: { value: maxCps, default: maxCps, unit: "char/s", source: "default" },
    },
    rules: [
      "R1: Kesilen (excised) kelimeler atlanır; aktif kelimeler speed_ramp integraliyle sekans saatine (sequence_ms) izdüşürülür",
      "R2: Noktalama sonlarında, >= 350ms boşluklarda veya max_words_per_group / max_chars_per_line sınırında yeni altyazı grubuna bölünür",
      "R3: CPS <= max_cps okumayı sağlamak için komşu altyazıya kadar olan boşluk kullanılır",
    ],
    summary: {
      text: `${validWords.length} aktif kelime -> ${createdCues.length} altyazı öğesi (ort. ${meanCps} CPS); ${skippedExcisedCount} kesilmiş kelime atlandı`,
      candidates: createdCues.length,
      accepted: createdCues.length,
      rejected: 0,
      by_reason: {
        APPLIED: createdCues.length - capNearMisses.length,
        ...(capNearMisses.length > 0 ? { CPS_EXCEEDED: capNearMisses.length } : {}),
      },
      effect: {
        cues_created: createdCues.length,
        active_words: validWords.length,
        mean_cps: meanCps,
        skipped_excised_words: skippedExcisedCount,
      },
    },
    decisions: capDecisions,
    near_misses: capNearMisses,
  };

  return {
    style,
    cues_created: createdCues.length,
    skipped_excised_words: skippedExcisedCount,
    cues: createdCues,
    decision_trace: decisionTrace,
    revision,
    verification,
  };
}
