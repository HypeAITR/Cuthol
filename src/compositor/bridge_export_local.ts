// Window-local compilers (words, beats, audio envelope, cuts/segments) for per-cue bridge export.
import {
  AudioProcessingChain,
  getCuePlaybackRate,
  ParameterEnvelope,
  SpineClip,
} from "../core/schema.js";
import { resolveCueStartMs } from "../core/timeline.js";
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
  CutholBridgeSegment,
  CutholBridgeV1,
  CutholBridgeWord,
  normTurkish,
} from "./cuthol_runtime.js";
import type { BridgeCueExportContext } from "./bridge_export_cue.js";

export function compileLocalWordsPausesSentences(ctx: BridgeCueExportContext): {
  dedupedWords: CutholBridgeWord[];
  pauses: Array<{ t0: number; t1: number }>;
  sentences: Array<{ t0: number; t1: number; text: string }>;
} {
  const { seq, cue, durationSec, toLocalSec, overlapsWindow, libMap, ledger } = ctx;

  // 1. Collect Words (from caption/voiceover cues AND spine/voiceover asset transcripts)
  const rawSeqWords: Array<{
    seqStartMs: number;
    seqEndMs: number;
    text: string;
    conf?: number;
  }> = [];

  // 1a. Words already embedded on caption/voiceover cues
  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    for (const otherCue of lane.cues) {
      if (otherCue.id === cue.id) continue;
      const cStart = resolveCueStartMs(seq, otherCue);
      const cEnd = cStart + otherCue.duration_ms;
      if (!overlapsWindow(cStart, cEnd)) continue;

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
          if (we > ws && overlapsWindow(ws, we)) {
            rawSeqWords.push({
              seqStartMs: ws,
              seqEndMs: we,
              text: tw.word,
              conf: tw.confidence,
            });
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
              if (overlapsWindow(ws, we)) {
                rawSeqWords.push({
                  seqStartMs: ws,
                  seqEndMs: we,
                  text: w.word,
                  conf: w.confidence,
                });
              }
            }
          }
        }
      }
    }
  }

  // 1b. Words from SpineClips overlapping the composition window
  if (ledger) {
    for (const clip of seq.spine.clips) {
      const clipStart = clip.timeline_in_ms;
      const clipEnd = clipStart + clip.duration_ms;
      if (!overlapsWindow(clipStart, clipEnd) || clip.audio_chain.muted) continue;

      const asset = libMap.get(clip.asset_handle);
      if (!asset) continue;
      const doc = ledger.getLatestTranscript<TranscriptDocument>(asset.digest_sha256);
      if (!doc?.words?.length) continue;

      const projected = projectTranscriptWordsToClip(clip, doc.words);
      for (const pw of projected) {
        if (pw.excised || pw.sequence_start_ms === null || pw.sequence_end_ms === null) continue;
        if (overlapsWindow(pw.sequence_start_ms, pw.sequence_end_ms)) {
          rawSeqWords.push({
            seqStartMs: pw.sequence_start_ms,
            seqEndMs: pw.sequence_end_ms,
            text: pw.word,
            conf: pw.confidence,
          });
        }
      }
    }
  }

  // Sort and deduplicate words that appear in both spine transcript and generated captions
  rawSeqWords.sort((a, b) => a.seqStartMs - b.seqStartMs || a.seqEndMs - b.seqEndMs);
  const dedupedWords: CutholBridgeWord[] = [];
  for (const rw of rawSeqWords) {
    const rawT0 = toLocalSec(rw.seqStartMs);
    const rawT1 = toLocalSec(rw.seqEndMs);
    const isClipped = rawT0 < 0 || rawT1 > durationSec;
    const t0 = Number(Math.max(0, rawT0).toFixed(4));
    const t1 = Number(Math.min(durationSec, rawT1).toFixed(4));
    if (t1 <= t0) continue;

    const normCurr = normTurkish(rw.text);
    const prev = dedupedWords[dedupedWords.length - 1];
    if (prev && normTurkish(prev.text) === normCurr) {
      const overlapSec = Math.min(prev.t1, t1) - Math.max(prev.t0, t0);
      if (Math.abs(prev.t0 - t0) < 0.025 || overlapSec > 0) {
        continue;
      }
    }
    dedupedWords.push({
      t0,
      t1,
      text: rw.text,
      ...(rw.conf !== undefined ? { conf: Number(rw.conf.toFixed(3)) } : {}),
      ...(isClipped ? { clipped: true } : {}),
    });
  }

  // Build pauses & sentences from deduped local words
  const pauses: Array<{ t0: number; t1: number }> = [];
  const sentences: Array<{ t0: number; t1: number; text: string }> = [];
  if (dedupedWords.length > 0) {
    let sentStart = Math.max(0, dedupedWords[0].t0);
    let sentTokens: string[] = [];

    for (let i = 0; i < dedupedWords.length; i++) {
      const curr = dedupedWords[i];
      const next = dedupedWords[i + 1];
      sentTokens.push(curr.text);

      const gapSec = next ? next.t0 - curr.t1 : 0;
      if (next && gapSec >= 0.2) {
        pauses.push({
          t0: Number(Math.max(0, curr.t1).toFixed(4)),
          t1: Number(Math.min(durationSec, next.t0).toFixed(4)),
        });
      }

      const isPunctBreak = /[.!?…]$/.test(curr.text);
      if (!next || isPunctBreak || gapSec >= 0.4) {
        sentences.push({
          t0: Number(sentStart.toFixed(4)),
          t1: Number(Math.min(durationSec, curr.t1).toFixed(4)),
          text: sentTokens.join(" "),
        });
        if (next) {
          sentStart = Math.max(0, next.t0);
          sentTokens = [];
        }
      }
    }
  }

  return { dedupedWords, pauses, sentences };
}

export function compileLocalBeats(ctx: BridgeCueExportContext): {
  bpm: number;
  dedupedBeatEntries: Array<{ t: number; strength: number; down: boolean }>;
  dedupedGridEntries: Array<{ t: number; down: boolean }>;
} {
  const { seq, cueStartMs, cueEndMs, toLocalSec, overlapsWindow, libMap, ledger } = ctx;

  // 2. Collect Beats (prefer music lane `ln_bgm` overlapping window, fallback to spine clip beats)
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
        const mEnd = mStart + mCue.duration_ms;
        if (!overlapsWindow(mStart, mEnd)) continue;
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
        if (!overlapsWindow(clip.timeline_in_ms, clip.timeline_in_ms + clip.duration_ms)) continue;
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
        if (seqMs !== null && seqMs >= cueStartMs && seqMs < cueEndMs) {
          gridEntries.push({
            t: toLocalSec(seqMs),
            down: idx % 4 === 0,
          });
        }
      });

      if (Array.isArray(beatData.onsets) && beatData.onsets.length > 0) {
        beatData.onsets.forEach((onset, idx) => {
          const seqMs = projectSrcMsToSeqMs(onset.time_ms);
          if (seqMs !== null && seqMs >= cueStartMs && seqMs < cueEndMs) {
            beatEntries.push({
              t: toLocalSec(seqMs),
              strength: onset.strength,
              down: onset.strength >= 0.85 || idx % 4 === 0,
            });
          }
        });
      } else {
        beatData.beats_ms.forEach((bSrcMs, idx) => {
          const seqMs = projectSrcMsToSeqMs(bSrcMs);
          if (seqMs !== null && seqMs >= cueStartMs && seqMs < cueEndMs) {
            const isDown = idx % 4 === 0;
            const strength = isDown ? 1.0 : idx % 2 === 0 ? 0.78 : 0.5;
            beatEntries.push({
              t: toLocalSec(seqMs),
              strength,
              down: isDown,
            });
          }
        });
      }
    }
  }

  beatEntries.sort((a, b) => a.t - b.t);
  const dedupedBeatEntries: typeof beatEntries = [];
  for (const b of beatEntries) {
    const prev = dedupedBeatEntries[dedupedBeatEntries.length - 1];
    if (prev && Math.abs(prev.t - b.t) < 0.02) {
      if (b.strength > prev.strength) {
        prev.strength = b.strength;
      }
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

  return { bpm, dedupedBeatEntries, dedupedGridEntries };
}

export function compileLocalAudioEnvelope(
  ctx: BridgeCueExportContext
): CutholBridgeV1["audio"] {
  const {
    seq,
    cueStartMs,
    durationSec,
    overlapsWindow,
    libMap,
    usesAudio,
    ledger,
    failedAudioHandles,
    activeWindowAudioHandles,
    bridgeWarnings,
  } = ctx;

  // 3. Collect 3-Band Audio Envelope (`low`, `mid`, `high` @ 25 Hz across composition window)
  const audioFps = 25;
  const totalAudioFrames = Math.max(2, Math.ceil(durationSec * audioFps) + 1);
  const lowArr = new Array<number>(totalAudioFrames).fill(0);
  const midArr = new Array<number>(totalAudioFrames).fill(0);
  const highArr = new Array<number>(totalAudioFrames).fill(0);
  let hasAudioEnvelope = false;

  if (ledger) {
    // Gather waveform caches for active spine clips, voiceovers, and music cues
    const waveSources: Array<{
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
      if (!overlapsWindow(cStart, cEnd)) continue;
      const asset = libMap.get(clip.asset_handle);
      if (!asset || !asset.probe.has_audio) continue;
      activeWindowAudioHandles.add(asset.handle);
      const wave = ctx.getOrAnalyzeWaveform(asset, usesAudio);
      if (wave?.bins?.length) {
        waveSources.push({
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
        if (!overlapsWindow(aStart, aEnd)) continue;
        const asset = libMap.get(aCue.asset_handle);
        if (!asset || !asset.probe.has_audio) continue;
        activeWindowAudioHandles.add(asset.handle);
        const wave = ctx.getOrAnalyzeWaveform(asset, lane.kind === "music" || usesAudio);
        if (wave?.bins?.length) {
          waveSources.push({
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

    if (waveSources.length > 0) {
      hasAudioEnvelope = true;
      for (let f = 0; f < totalAudioFrames; f++) {
        const localSec = f / audioFps;
        const seqMs = cueStartMs + localSec * 1000;
        let lMax = 0;
        let mMax = 0;
        let hMax = 0;

        for (const ws of waveSources) {
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

        lowArr[f] = lMax;
        midArr[f] = mMax;
        highArr[f] = hMax;
      }

      // Normalize each frequency band (`low`, `mid`, `high`) independently to [0..1] across the window
      // so `C.audio(band, t)` always delivers full 0..1 dynamic range on real music!
      const normalizeBandToUnitRange = (arr: number[]): void => {
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
          arr[i] = Number(Math.max(0, Math.min(1, norm)).toFixed(3));
        }
      };
      normalizeBandToUnitRange(lowArr);
      normalizeBandToUnitRange(midArr);
      normalizeBandToUnitRange(highArr);
    }
  }

  if (usesAudio) {
    if (failedAudioHandles.size > 0) {
      bridgeWarnings.push(
        `Waveform analysis for audio energy (C.audio) failed (${Array.from(failedAudioHandles).join(", ")}) — C.audio returns 0`
      );
    } else if (!hasAudioEnvelope) {
      bridgeWarnings.push(
        activeWindowAudioHandles.size > 0
          ? `No waveform data found for audio energy (C.audio) (${Array.from(activeWindowAudioHandles).join(", ")}) — C.audio returns 0`
          : `No active audio source in the composition window — C.audio returns 0`
      );
    }
  }

  return hasAudioEnvelope
    ? {
        fps: audioFps,
        t0: 0,
        bands: ["low", "mid", "high"] as ["low", "mid", "high"],
        low: lowArr,
        mid: midArr,
        high: highArr,
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

export function compileLocalCutsAndSegments(ctx: BridgeCueExportContext): {
  dedupedCuts: Array<{ t: number; clipId?: string; kind?: "spine_cut" | "scene_cut" }>;
  segments: CutholBridgeSegment[];
} {
  const { seq, cueStartMs, cueEndMs, durationSec, toLocalSec, overlapsWindow, libMap, ledger } = ctx;

  // 4. Collect Cuts & Segments inside (cueStartMs, cueEndMs)
  const cutsList: Array<{ t: number; clipId?: string; kind?: "spine_cut" | "scene_cut" }> = [];
  for (const clip of seq.spine.clips) {
    if (clip.timeline_in_ms > cueStartMs && clip.timeline_in_ms < cueEndMs) {
      cutsList.push({
        t: toLocalSec(clip.timeline_in_ms),
        clipId: clip.id,
        kind: "spine_cut",
      });
    }
    if (ledger && overlapsWindow(clip.timeline_in_ms, clip.timeline_in_ms + clip.duration_ms)) {
      const asset = libMap.get(clip.asset_handle);
      if (asset) {
        const sc = ledger.getLatestScenes<SceneAnalysisResult>(asset.digest_sha256);
        if (sc?.cuts?.length) {
          for (const c of sc.cuts) {
            if (c.time_ms <= clip.source_in_ms || c.time_ms >= clip.source_out_ms) continue;
            const seqCutMs = sourceMsToSequenceMs(clip, c.time_ms);
            if (seqCutMs > cueStartMs && seqCutMs < cueEndMs) {
              cutsList.push({
                t: toLocalSec(seqCutMs),
                clipId: clip.id,
                kind: "scene_cut",
              });
            }
          }
        }
      }
    }
  }
  cutsList.sort((a, b) => a.t - b.t);
  const dedupedCuts: typeof cutsList = [];
  for (const c of cutsList) {
    if (dedupedCuts.length === 0 || Math.abs(dedupedCuts[dedupedCuts.length - 1].t - c.t) > 0.04) {
      dedupedCuts.push(c);
    }
  }

  // Build contiguous segments covering [0 .. durationSec]
  const cutBounds = [0, ...dedupedCuts.map((c) => c.t), durationSec];
  const segments: CutholBridgeSegment[] = [];
  for (let i = 0; i < cutBounds.length - 1; i++) {
    const t0 = cutBounds[i];
    const t1 = cutBounds[i + 1];
    if (t1 <= t0) continue;
    const midSeqMs = cueStartMs + ((t0 + t1) / 2) * 1000;
    const ownerClip = seq.spine.clips.find(
      (c) => midSeqMs >= c.timeline_in_ms && midSeqMs <= c.timeline_in_ms + c.duration_ms
    );
    segments.push({
      t0,
      t1,
      index: segments.length,
      duration: Number((t1 - t0).toFixed(4)),
      ...(ownerClip ? { clipId: ownerClip.id } : {}),
    });
  }

  return { dedupedCuts, segments };
}
