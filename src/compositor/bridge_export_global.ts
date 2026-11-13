// Sequence-wide global slice compilers (words, audio envelope, cuts/segments) for per-cue bridge export.
import crypto from "node:crypto";
import {
  AudioProcessingChain,
  getCuePlaybackRate,
  ParameterEnvelope,
  SpineClip,
} from "../core/schema.js";

import { computeSequenceDurationMs, resolveCueStartMs } from "../core/timeline.js";
import { SceneAnalysisResult } from "../library/scenes.js";
import { WaveformAnalysisResult } from "../library/waveform.js";
import {
  evaluateEnvelopeAt,
  projectTranscriptWordsToClip,
  sequenceMsToSourceMs,
  sourceMsToSequenceMs,
} from "../sequence/spine.js";
import { TranscriptDocument } from "../speech/providers.js";
import {
  CutholBridgeGlobalV1,
  CutholBridgeSegment,
  CutholBridgeWord,
  normTurkish,
} from "./cuthol_runtime.js";
import type { BridgeCueExportContext } from "./bridge_export_cue.js";

function compileGlobalWordsAndPauses(
  ctx: BridgeCueExportContext,
  seqDurationMs: number,
  seqDurationSec: number,
  toGlobalSec: (seqMs: number) => number
): {
  globalDedupedWords: CutholBridgeWord[];
  globalPauses: Array<{ t0: number; t1: number }>;
} {
  const { seq, cue, libMap, ledger } = ctx;

  const globalRawWords: Array<{ seqStartMs: number; seqEndMs: number; text: string }> = [];
  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    for (const otherCue of lane.cues) {
      if (otherCue.id === cue.id) continue;
      const cStart = resolveCueStartMs(seq, otherCue);
      const cEnd = cStart + otherCue.duration_ms;
      if (cEnd <= 0) continue;

      if (otherCue.typography?.words && otherCue.typography.words.length > 0) {
        const firstKnownSeqStart = otherCue.typography.words.find(
          (w) => !w.excised && w.sequence_start_ms !== null && w.sequence_start_ms !== undefined
        )?.sequence_start_ms;
        const cueShiftMs =
          firstKnownSeqStart !== undefined && firstKnownSeqStart !== null
            ? cStart - firstKnownSeqStart
            : 0;

        for (const tw of otherCue.typography.words) {
          if (tw.excised) continue;
          const ownerClipId = tw.clip_id ?? otherCue.anchor?.ref ?? null;
          const ownerClip = ownerClipId
            ? seq.spine.clips.find((c) => c.id === ownerClipId)
            : undefined;

          let ws: number;
          let we: number;
          if (ownerClip) {
            if (
              tw.source_end_ms <= ownerClip.source_in_ms ||
              tw.source_start_ms >= ownerClip.source_out_ms
            ) {
              continue;
            }
            const clampedSrcStart = Math.max(ownerClip.source_in_ms, tw.source_start_ms);
            const clampedSrcEnd = Math.min(ownerClip.source_out_ms, tw.source_end_ms);
            ws = sourceMsToSequenceMs(ownerClip, clampedSrcStart);
            we = sourceMsToSequenceMs(ownerClip, clampedSrcEnd);
          } else if (
            tw.sequence_start_ms !== null &&
            tw.sequence_start_ms !== undefined &&
            tw.sequence_end_ms !== null &&
            tw.sequence_end_ms !== undefined
          ) {
            ws = tw.sequence_start_ms + cueShiftMs;
            we = tw.sequence_end_ms + cueShiftMs;
          } else {
            const srcIn = otherCue.source_in_ms ?? 0;
            const cueRate = getCuePlaybackRate(otherCue);
            ws = cStart + Math.max(0, (tw.source_start_ms - srcIn) / cueRate);
            we = cStart + Math.min(otherCue.duration_ms, (tw.source_end_ms - srcIn) / cueRate);
          }
          if (we > ws && we > 0 && ws < seqDurationMs) {
            globalRawWords.push({ seqStartMs: ws, seqEndMs: we, text: tw.word });
          }
        }
      } else if (otherCue.asset_handle && ledger) {
        const asset = libMap.get(otherCue.asset_handle);
        if (asset) {
          const doc = ledger.getLatestTranscript<TranscriptDocument>(asset.digest_sha256);
          if (doc?.words?.length) {
            const srcIn = otherCue.source_in_ms ?? 0;
            const cueRate = getCuePlaybackRate(otherCue);
            const srcOut =
              otherCue.source_out_ms ?? srcIn + Math.round(otherCue.duration_ms * cueRate);
            for (const w of doc.words) {
              if (w.source_end_ms <= srcIn || w.source_start_ms >= srcOut) continue;
              const ws = cStart + Math.max(0, (w.source_start_ms - srcIn) / cueRate);
              const we = cStart + Math.min(otherCue.duration_ms, (w.source_end_ms - srcIn) / cueRate);
              if (we > ws && we > 0 && ws < seqDurationMs) {
                globalRawWords.push({ seqStartMs: ws, seqEndMs: we, text: w.word });
              }
            }
          }
        }
      }
    }
  }

  if (ledger) {
    for (const clip of seq.spine.clips) {
      if (clip.audio_chain.muted) continue;
      const asset = libMap.get(clip.asset_handle);
      if (!asset) continue;
      const doc = ledger.getLatestTranscript<TranscriptDocument>(asset.digest_sha256);
      if (!doc?.words?.length) continue;

      const projected = projectTranscriptWordsToClip(clip, doc.words);
      for (const pw of projected) {
        if (pw.excised || pw.sequence_start_ms === null || pw.sequence_end_ms === null) continue;
        if (pw.sequence_end_ms > 0 && pw.sequence_start_ms < seqDurationMs) {
          globalRawWords.push({
            seqStartMs: pw.sequence_start_ms,
            seqEndMs: pw.sequence_end_ms,
            text: pw.word,
          });
        }
      }
    }
  }

  globalRawWords.sort((a, b) => a.seqStartMs - b.seqStartMs || a.seqEndMs - b.seqEndMs);
  const globalDedupedWords: CutholBridgeWord[] = [];
  for (const rw of globalRawWords) {
    const t0 = Number(Math.max(0, toGlobalSec(rw.seqStartMs)).toFixed(3));
    const t1 = Number(Math.min(seqDurationSec, toGlobalSec(rw.seqEndMs)).toFixed(3));
    if (t1 <= t0) continue;

    const normCurr = normTurkish(rw.text);
    const prev = globalDedupedWords[globalDedupedWords.length - 1];
    if (prev && normTurkish(prev.text) === normCurr) {
      const overlapSec = Math.min(prev.t1, t1) - Math.max(prev.t0, t0);
      if (Math.abs(prev.t0 - t0) < 0.025 || overlapSec > 0) {
        continue;
      }
    }
    globalDedupedWords.push({ t0, t1, text: rw.text });
  }

  const globalPauses: Array<{ t0: number; t1: number }> = [];
  for (let i = 0; i < globalDedupedWords.length - 1; i++) {
    const curr = globalDedupedWords[i];
    const next = globalDedupedWords[i + 1];
    if (next.t0 - curr.t1 >= 0.2) {
      globalPauses.push({
        t0: Number(Math.max(0, curr.t1).toFixed(3)),
        t1: Number(Math.min(seqDurationSec, next.t0).toFixed(3)),
      });
    }
  }

  return { globalDedupedWords, globalPauses };
}

function compileGlobalAudioEnvelope(
  ctx: BridgeCueExportContext,
  seqDurationSec: number
): CutholBridgeGlobalV1["audio"] {
  const { seq, libMap, usesAudio, ledger } = ctx;

  // Global 3-band audio envelope across [0 .. seqDurationSec] with a single sequence-wide normalization.
  // Resolution scales automatically: 10 Hz (100 ms) up to 15 min, 5 Hz (200 ms) for 15-60 min edits.
  const globalAudioFps = seqDurationSec > 900 ? 5 : 10;
  const globalAudioPrecision = seqDurationSec > 900 ? 2 : 3;
  const totalGlobalAudioFrames = Math.max(2, Math.ceil(seqDurationSec * globalAudioFps) + 1);
  const gLowArr = new Array<number>(totalGlobalAudioFrames).fill(0);
  const gMidArr = new Array<number>(totalGlobalAudioFrames).fill(0);
  const gHighArr = new Array<number>(totalGlobalAudioFrames).fill(0);
  let hasGlobalAudio = false;

  if (ledger) {
    const globalWaveSources: Array<{
      wave: WaveformAnalysisResult;
      seqStartMs: number;
      seqEndMs: number;
      srcInMs: number;
      clipRef?: SpineClip;
      audioChain?: AudioProcessingChain;
      envelopes?: ParameterEnvelope[];
    }> = [];

    for (const clip of seq.spine.clips) {
      if (clip.audio_chain.muted) continue;
      const cStart = clip.timeline_in_ms;
      const cEnd = cStart + clip.duration_ms;
      const asset = libMap.get(clip.asset_handle);
      if (!asset || !asset.probe.has_audio) continue;
      const wave = ctx.getOrAnalyzeWaveform(asset, usesAudio);
      if (wave?.bins?.length) {
        globalWaveSources.push({
          wave,
          seqStartMs: cStart,
          seqEndMs: cEnd,
          srcInMs: clip.source_in_ms,
          clipRef: clip,
          audioChain: clip.audio_chain,
          envelopes: clip.envelopes,
        });
      }
    }

    for (const lane of seq.lanes) {
      if (lane.muted) continue;
      for (const aCue of lane.cues) {
        if (!aCue.asset_handle || aCue.audio_chain?.muted) continue;
        const aStart = resolveCueStartMs(seq, aCue);
        const aEnd = aStart + aCue.duration_ms;
        const asset = libMap.get(aCue.asset_handle);
        if (!asset || !asset.probe.has_audio) continue;
        const wave = ctx.getOrAnalyzeWaveform(asset, lane.kind === "music" || usesAudio);
        if (wave?.bins?.length) {
          globalWaveSources.push({
            wave,
            seqStartMs: aStart,
            seqEndMs: aEnd,
            srcInMs: aCue.source_in_ms ?? 0,
            audioChain: aCue.audio_chain,
            envelopes: aCue.envelopes,
          });
        }
      }
    }

    if (globalWaveSources.length > 0) {
      hasGlobalAudio = true;
      for (let f = 0; f < totalGlobalAudioFrames; f++) {
        const globalSec = f / globalAudioFps;
        const seqMs = globalSec * 1000;
        let lMax = 0;
        let mMax = 0;
        let hMax = 0;

        for (const ws of globalWaveSources) {
          if (seqMs < ws.seqStartMs || seqMs > ws.seqEndMs) continue;
          const srcMs = ws.clipRef
            ? sequenceMsToSourceMs(ws.clipRef, seqMs)
            : ws.srcInMs + (seqMs - ws.seqStartMs);
          const binDur = Math.max(1, ws.wave.duration_ms / ws.wave.bins.length);
          const binIdx = Math.max(
            0,
            Math.min(ws.wave.bins.length - 1, Math.floor(srcMs / binDur))
          );
          const bin = ws.wave.bins[binIdx];
          if (bin) {
            const itemLocalMs = Math.max(0, seqMs - ws.seqStartMs);
            const itemDurMs = Math.max(1, ws.seqEndMs - ws.seqStartMs);
            let totalDb = ws.audioChain?.gain_db ?? 0;
            const gainEnv = ws.envelopes?.find((e) => e.parameter === "audio_chain.gain_db");
            if (gainEnv && gainEnv.points.length > 0) {
              totalDb += evaluateEnvelopeAt(gainEnv, itemLocalMs);
            }
            const linearGain = Math.pow(10, totalDb / 20);
            const fadeInMs = ws.audioChain?.fade_in_ms ?? 0;
            const fadeOutMs = ws.audioChain?.fade_out_ms ?? 0;
            const fadeInMul =
              fadeInMs > 0 && itemLocalMs < fadeInMs ? Math.max(0, itemLocalMs / fadeInMs) : 1;
            const fadeOutMul =
              fadeOutMs > 0 && itemDurMs - itemLocalMs < fadeOutMs
                ? Math.max(0, (itemDurMs - itemLocalMs) / fadeOutMs)
                : 1;
            const effectiveGain = linearGain * fadeInMul * fadeOutMul;
            const amp = Math.max(0.05, bin.rms_norm) * effectiveGain;
            lMax = Math.max(lMax, bin.low_energy * amp);
            mMax = Math.max(mMax, bin.mid_energy * amp);
            hMax = Math.max(hMax, bin.high_energy * amp);
          }
        }

        gLowArr[f] = lMax;
        gMidArr[f] = mMax;
        gHighArr[f] = hMax;
      }

      const normalizeGlobalBand = (arr: number[]): void => {
        let maxVal = 0;
        let minVal = Number.POSITIVE_INFINITY;
        for (const v of arr) {
          if (v > maxVal) maxVal = v;
          if (v < minVal) minVal = v;
        }
        if (maxVal <= 1e-4) {
          arr.fill(0);
          return;
        }
        const span = maxVal - minVal;
        for (let i = 0; i < arr.length; i++) {
          const norm =
            span > 1e-4
              ? 0.05 + 0.95 * ((arr[i] - minVal) / span)
              : Math.min(1, arr[i] / maxVal);
          arr[i] = Number(Math.max(0, Math.min(1, norm)).toFixed(globalAudioPrecision));
        }
      };
      normalizeGlobalBand(gLowArr);
      normalizeGlobalBand(gMidArr);
      normalizeGlobalBand(gHighArr);
    }
  }

  return hasGlobalAudio
    ? {
        fps: globalAudioFps,
        t0: 0,
        bands: ["low", "mid", "high"] as ["low", "mid", "high"],
        low: gLowArr,
        mid: gMidArr,
        high: gHighArr,
      }
    : {
        fps: 0,
        t0: 0,
        bands: ["low", "mid", "high"] as ["low", "mid", "high"],
        low: [],
        mid: [],
        high: [],
      };
}

/**
 * Full-sequence beat grid in absolute sequence seconds — the same music source the
 * local per-cue grid comes from (music lane `ln_bgm` first, spine audio fallback),
 * but collected across the whole sequence instead of clipped to one cue window.
 * Trimming the music moves this grid (its times are sequence-mapped through the
 * cue/clip trims); `C.beats` stays window-local.
 */
function compileGlobalBeats(
  ctx: BridgeCueExportContext,
  seqDurationSec: number
): CutholBridgeGlobalV1["beats"] {
  const { seq, libMap, ledger } = ctx;
  const toGlobalSec = (seqMs: number): number => Number((seqMs / 1000).toFixed(4));

  let bpm = 0;
  const beatEntries: Array<{ t: number; strength: number; down: boolean }> = [];
  const gridEntries: Array<{ t: number; down: boolean }> = [];

  if (ledger) {
    const musicSources: Array<{
      handle: string;
      digest: string;
      seqStartMs: number;
      durMs: number;
      srcInMs: number;
      isMusicLane: boolean;
      clipRef?: SpineClip;
    }> = [];

    for (const lane of seq.lanes) {
      if (lane.muted || lane.kind !== "music") continue;
      for (const mCue of lane.cues) {
        if (!mCue.asset_handle || mCue.audio_chain?.muted) continue;
        const mStart = resolveCueStartMs(seq, mCue);
        const asset = libMap.get(mCue.asset_handle);
        if (asset) {
          musicSources.push({
            handle: asset.handle,
            digest: asset.digest_sha256,
            seqStartMs: mStart,
            durMs: mCue.duration_ms,
            srcInMs: mCue.source_in_ms ?? 0,
            isMusicLane: true,
          });
        }
      }
    }

    if (musicSources.length === 0) {
      for (const clip of seq.spine.clips) {
        if (clip.audio_chain.muted) continue;
        const asset = libMap.get(clip.asset_handle);
        if (asset) {
          musicSources.push({
            handle: asset.handle,
            digest: asset.digest_sha256,
            seqStartMs: clip.timeline_in_ms,
            durMs: clip.duration_ms,
            srcInMs: clip.source_in_ms,
            isMusicLane: false,
            clipRef: clip,
          });
        }
      }
    }

    for (const src of musicSources) {
      const beatData = ctx.getOrAnalyzeBeats(src);
      if (!beatData) continue;
      const effectiveBpm = beatData.grid_bpm ?? beatData.estimated_bpm;
      if (bpm === 0 && effectiveBpm > 0) {
        const rate = src.clipRef ? src.clipRef.playback.rate : 1;
        bpm = Number((effectiveBpm * rate).toFixed(2));
      }

      const projectSrcMsToSeqMs = (bSrcMs: number): number | null => {
        if (src.clipRef) {
          if (bSrcMs < src.clipRef.source_in_ms || bSrcMs > src.clipRef.source_out_ms) return null;
          return sourceMsToSequenceMs(src.clipRef, bSrcMs);
        }
        if (bSrcMs < src.srcInMs || bSrcMs > src.srcInMs + src.durMs) return null;
        return src.seqStartMs + (bSrcMs - src.srcInMs);
      };

      const rawGridMs = Array.isArray(beatData.grid_ms) ? beatData.grid_ms : [];
      rawGridMs.forEach((gSrcMs, idx) => {
        const seqMs = projectSrcMsToSeqMs(gSrcMs);
        if (seqMs === null || seqMs < 0 || seqMs > seqDurationSec * 1000) return;
        gridEntries.push({ t: toGlobalSec(seqMs), down: idx % 4 === 0 });
      });

      if (Array.isArray(beatData.onsets) && beatData.onsets.length > 0) {
        beatData.onsets.forEach((onset, idx) => {
          const seqMs = projectSrcMsToSeqMs(onset.time_ms);
          if (seqMs === null || seqMs < 0 || seqMs > seqDurationSec * 1000) return;
          beatEntries.push({
            t: toGlobalSec(seqMs),
            strength: onset.strength,
            down: onset.strength >= 0.85 || idx % 4 === 0,
          });
        });
      } else {
        beatData.beats_ms.forEach((bSrcMs, idx) => {
          const seqMs = projectSrcMsToSeqMs(bSrcMs);
          if (seqMs === null || seqMs < 0 || seqMs > seqDurationSec * 1000) return;
          const isDown = idx % 4 === 0;
          beatEntries.push({
            t: toGlobalSec(seqMs),
            strength: isDown ? 1.0 : idx % 2 === 0 ? 0.78 : 0.5,
            down: isDown,
          });
        });
      }
    }
  }

  beatEntries.sort((a, b) => a.t - b.t);
  const dedupedBeatEntries: typeof beatEntries = [];
  for (const b of beatEntries) {
    const prev = dedupedBeatEntries[dedupedBeatEntries.length - 1];
    if (prev && Math.abs(prev.t - b.t) < 0.02) {
      if (b.strength > prev.strength) prev.strength = b.strength;
      prev.down = prev.down || b.down;
    } else {
      dedupedBeatEntries.push({ ...b });
    }
  }

  gridEntries.sort((a, b) => a.t - b.t);
  const dedupedGridEntries: typeof gridEntries = [];
  for (const g of gridEntries) {
    const prev = dedupedGridEntries[dedupedGridEntries.length - 1];
    if (prev && Math.abs(prev.t - g.t) < 0.02) {
      prev.down = prev.down || g.down;
    } else {
      dedupedGridEntries.push({ ...g });
    }
  }

  const gridTimes = dedupedGridEntries.map((g) => g.t);
  const downbeatTimes =
    dedupedGridEntries.length > 0
      ? dedupedGridEntries.filter((g) => g.down).map((g) => g.t)
      : dedupedBeatEntries.filter((b) => b.down).map((b) => b.t);

  return {
    bpm,
    ...(gridTimes.length > 0 ? { offset: gridTimes[0], phase: gridTimes[0], grid: gridTimes } : {}),
    times: dedupedBeatEntries.map((b) => b.t),
    strength: dedupedBeatEntries.map((b) => b.strength),
    downbeats: downbeatTimes,
  };
}

function compileGlobalCutsAndSegments(
  ctx: BridgeCueExportContext,
  seqDurationMs: number,
  seqDurationSec: number,
  toGlobalSec: (seqMs: number) => number
): {
  globalDedupedCuts: Array<{ t: number; clipId?: string; kind?: "spine_cut" | "scene_cut" }>;
  globalSegments: CutholBridgeSegment[];
} {
  const { seq, libMap, ledger } = ctx;

  // Global cuts & segments across [0 .. seqDurationSec]
  const globalCutsList: Array<{ t: number; clipId?: string; kind?: "spine_cut" | "scene_cut" }> = [];
  for (const clip of seq.spine.clips) {
    if (clip.timeline_in_ms > 0 && clip.timeline_in_ms < seqDurationMs) {
      globalCutsList.push({
        t: toGlobalSec(clip.timeline_in_ms),
        clipId: clip.id,
        kind: "spine_cut",
      });
    }
    if (ledger) {
      const asset = libMap.get(clip.asset_handle);
      if (asset) {
        const sc = ledger.getLatestScenes<SceneAnalysisResult>(asset.digest_sha256);
        if (sc?.cuts?.length) {
          for (const c of sc.cuts) {
            if (c.time_ms <= clip.source_in_ms || c.time_ms >= clip.source_out_ms) continue;
            const seqCutMs = sourceMsToSequenceMs(clip, c.time_ms);
            if (seqCutMs > 0 && seqCutMs < seqDurationMs) {
              globalCutsList.push({
                t: toGlobalSec(seqCutMs),
                clipId: clip.id,
                kind: "scene_cut",
              });
            }
          }
        }
      }
    }
  }
  globalCutsList.sort((a, b) => a.t - b.t);
  const globalDedupedCuts: typeof globalCutsList = [];
  for (const c of globalCutsList) {
    if (
      globalDedupedCuts.length === 0 ||
      Math.abs(globalDedupedCuts[globalDedupedCuts.length - 1].t - c.t) > 0.04
    ) {
      globalDedupedCuts.push(c);
    }
  }

  const globalCutBounds = [0, ...globalDedupedCuts.map((c) => c.t), seqDurationSec];
  const globalSegments: CutholBridgeSegment[] = [];
  for (let i = 0; i < globalCutBounds.length - 1; i++) {
    const t0 = globalCutBounds[i];
    const t1 = globalCutBounds[i + 1];
    if (t1 <= t0) continue;
    const midSeqMs = ((t0 + t1) / 2) * 1000;
    const ownerClip = seq.spine.clips.find(
      (c) => midSeqMs >= c.timeline_in_ms && midSeqMs <= c.timeline_in_ms + c.duration_ms
    );
    globalSegments.push({
      t0,
      t1,
      index: globalSegments.length,
      duration: Number((t1 - t0).toFixed(3)),
      ...(ownerClip ? { clipId: ownerClip.id } : {}),
    });
  }

  return { globalDedupedCuts, globalSegments };
}

export function compileGlobalBridgeSlice(ctx: BridgeCueExportContext): CutholBridgeGlobalV1 {
  // 5. Build full-sequence (`global`) intelligence in absolute timeline seconds [0 .. seqDurationSec]
  // with single sequence-wide 3-band audio normalization and compact resolution for long (40-50 min) edits.
  const seqDurationMs = Math.max(ctx.cueEndMs, computeSequenceDurationMs(ctx.seq));
  const seqDurationSec = Number((seqDurationMs / 1000).toFixed(4));
  const toGlobalSec = (seqMs: number): number => Number((seqMs / 1000).toFixed(3));

  const { globalDedupedWords, globalPauses } = compileGlobalWordsAndPauses(
    ctx,
    seqDurationMs,
    seqDurationSec,
    toGlobalSec
  );
  const globalBeats = compileGlobalBeats(ctx, seqDurationSec);
  const globalAudio = compileGlobalAudioEnvelope(ctx, seqDurationSec);
  const { globalDedupedCuts, globalSegments } = compileGlobalCutsAndSegments(
    ctx,
    seqDurationMs,
    seqDurationSec,
    toGlobalSec
  );

  const globalHashable = {
    duration: seqDurationSec,
    words: globalDedupedWords,
    pauses: globalPauses,
    beats: globalBeats,
    audio: globalAudio,
    cuts: globalDedupedCuts.map((c) => ({ t: c.t, ...(c.kind ? { kind: c.kind } : {}) })),
  };

  const globalHash =
    "sha256:" +
    crypto
      .createHash("sha256")
      .update(JSON.stringify(globalHashable))
      .digest("hex")
      .slice(0, 16);

  return {
    hash: globalHash,
    duration: seqDurationSec,
    words: globalDedupedWords,
    pauses: globalPauses,
    beats: globalBeats,
    audio: globalHashable.audio,
    cuts: globalDedupedCuts,
    segments: globalSegments,
  };
}
