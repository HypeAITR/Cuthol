// Music ducking under dialogue (split out of audio_mix.ts).
import { resolveCueStartMs } from "../core/timeline.js";
import { DecisionTrace, DecisionTraceItem } from "../core/decision_trace.js";
import {
  CutholError,
  DIAGNOSTICS
} from "../core/diagnostics.js";
import { ParameterEnvelopePoint } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { loadSequence } from "../core/workspace.js";
import { analyzeAssetWaveform } from "../library/waveform.js";
import {
  sourceMsToSequenceMs
} from "../sequence/spine.js";
import { loadCachedTranscriptForAsset } from "../speech/transcribe.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";
import { calibrateSequenceMasterAudio } from "./mix_normalize.js";

/**
 * Generates smooth gain reduction envelopes (`audio_chain.gain_db`) on `bgmLaneId` music cues
 * whenever active dialogue speech is present on the spine or `ln_vo` voiceover lane.
 */
export function duckMusicUnderDialogue(options: {
  workspaceDir: string;
  bgmLaneId?: string;
  duckDb?: number;
  attackMs?: number;
  releaseMs?: number;
  language?: string;
}): {
  bgm_lane: string;
  dialogue_windows_ms: Array<{ start_ms: number; end_ms: number }>;
  ducked_cues: Array<{ cue_id: string; envelope_points: ParameterEnvelopePoint[] }>;
  decision_trace: DecisionTrace;
  revision: number;
  verification: VerificationReport;
} {
  const bgmLaneId = options.bgmLaneId ?? "ln_bgm";
  const rawDuckDb =
    options.duckDb !== undefined && Number.isFinite(options.duckDb) && options.duckDb !== 0
      ? -Math.abs(options.duckDb)
      : OPEN_STANDARDS.DUCKING.DEFAULT_ATTENUATION_DB;
  const duckDb = Math.max(
    OPEN_STANDARDS.DUCKING.MIN_ATTENUATION_DB,
    Math.min(OPEN_STANDARDS.DUCKING.MAX_ATTENUATION_DB, rawDuckDb)
  );
  const rawAttackMs =
    options.attackMs !== undefined && Number.isFinite(options.attackMs)
      ? options.attackMs
      : OPEN_STANDARDS.DUCKING.DEFAULT_ATTACK_MS;
  const attackMs = Math.max(
    OPEN_STANDARDS.DUCKING.MIN_ATTACK_MS,
    Math.min(OPEN_STANDARDS.DUCKING.MAX_ATTACK_MS, rawAttackMs)
  );
  const rawReleaseMs =
    options.releaseMs !== undefined && Number.isFinite(options.releaseMs)
      ? options.releaseMs
      : OPEN_STANDARDS.DUCKING.DEFAULT_RELEASE_MS;
  const releaseMs = Math.max(
    OPEN_STANDARDS.DUCKING.MIN_RELEASE_MS,
    Math.min(OPEN_STANDARDS.DUCKING.MAX_RELEASE_MS, rawReleaseMs)
  );
  const lang = options.language ?? "tr";

  const { sequence: initialSeq } = loadSequence(options.workspaceDir);

  // Collect active dialogue intervals in sequence milliseconds
  const rawWindows: Array<{ start_ms: number; end_ms: number }> = [];
  const untranscribedSpineClips: typeof initialSeq.spine.clips = [];

  for (const clip of initialSeq.spine.clips) {
    if (clip.audio_chain.muted) continue;
    try {
      const doc = loadCachedTranscriptForAsset(options.workspaceDir, clip.asset_handle, lang);
      for (const w of doc.words) {
        if (w.is_filler || w.is_repetition) continue;
        if (w.source_end_ms <= clip.source_in_ms || w.source_start_ms >= clip.source_out_ms) continue;
        const st = sourceMsToSequenceMs(clip, Math.max(clip.source_in_ms, w.source_start_ms));
        const en = sourceMsToSequenceMs(clip, Math.min(clip.source_out_ms, w.source_end_ms));
        if (en > st) rawWindows.push({ start_ms: st, end_ms: en });
      }
    } catch {
      const asset = initialSeq.library.find((x) => x.handle === clip.asset_handle);
      if (asset?.probe.has_audio) {
        untranscribedSpineClips.push(clip);
      }
    }
  }

  for (const lane of initialSeq.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      const isVoCue = lane.id === "ln_vo" || lane.kind === "voiceover" || cue.kind === "voiceover";
      if (!isVoCue || cue.audio_chain?.muted || !cue.asset_handle) continue;
      const cueStart = resolveCueStartMs(initialSeq, cue);
      const cueSourceIn = cue.source_in_ms ?? 0;
      const cueSourceOut = Math.min(
        cue.source_out_ms ?? cueSourceIn + cue.duration_ms,
        cueSourceIn + cue.duration_ms
      );
      try {
        const doc = loadCachedTranscriptForAsset(options.workspaceDir, cue.asset_handle, lang);
        let addedAnyWord = false;
        for (const w of doc.words) {
          if (w.is_filler || w.is_repetition) continue;
          if (w.source_end_ms <= cueSourceIn || w.source_start_ms >= cueSourceOut) continue;
          const clampedStart = Math.max(cueSourceIn, w.source_start_ms);
          const clampedEnd = Math.min(cueSourceOut, w.source_end_ms);
          if (clampedEnd <= clampedStart) continue;
          const st = cueStart + (clampedStart - cueSourceIn);
          const en = cueStart + Math.min(cue.duration_ms, clampedEnd - cueSourceIn);
          if (en > st) {
            rawWindows.push({ start_ms: st, end_ms: en });
            addedAnyWord = true;
          }
        }
        if (!addedAnyWord && doc.words.length === 0) {
          rawWindows.push({ start_ms: cueStart, end_ms: cueStart + cue.duration_ms });
        }
      } catch {
        const asset = initialSeq.library.find((x) => x.handle === cue.asset_handle);
        if (!asset || asset.probe.has_audio) {
          rawWindows.push({ start_ms: cueStart, end_ms: cueStart + cue.duration_ms });
        }
      }
    }
  }

  // Never blindly treat an untranscribed spine clip's entire duration as dialogue!
  const untranscribedMode: "skipped" | "acoustic_vad" =
    rawWindows.length > 0 ? "skipped" : "acoustic_vad";
  let duckingWarningDiag: ReturnType<typeof DIAGNOSTICS.DUCKING_WITHOUT_TRANSCRIPT> | null = null;
  if (untranscribedSpineClips.length > 0) {
    const clipIds = untranscribedSpineClips.map((c) => c.id);
    if (untranscribedMode === "skipped") {
      duckingWarningDiag = DIAGNOSTICS.DUCKING_WITHOUT_TRANSCRIPT(clipIds, "skipped");
    } else {
      duckingWarningDiag = DIAGNOSTICS.DUCKING_WITHOUT_TRANSCRIPT(clipIds, "acoustic_vad");
      for (const clip of untranscribedSpineClips) {
        try {
          const wave = analyzeAssetWaveform({
            workspaceDir: options.workspaceDir,
            handle: clip.asset_handle,
            bins: 160,
          });
          for (const bin of wave.bins) {
            if (bin.end_ms <= clip.source_in_ms || bin.start_ms >= clip.source_out_ms) continue;
            const isAboveFloor = bin.db_fs > OPEN_STANDARDS.DIALOGUE_CLEANUP.SILENCE_FLOOR_DBFS;
            const hasSpeechFormant = bin.mid_energy >= 0.12;
            if (isAboveFloor && hasSpeechFormant) {
              const st = sourceMsToSequenceMs(clip, Math.max(clip.source_in_ms, bin.start_ms));
              const en = sourceMsToSequenceMs(clip, Math.min(clip.source_out_ms, bin.end_ms));
              if (en > st) rawWindows.push({ start_ms: st, end_ms: en });
            }
          }
        } catch {
          // ignore if waveform fails
        }
      }
    }
  }

  rawWindows.sort((a, b) => a.start_ms - b.start_ms);

  // Merge speech windows separated by <= max(600ms, attackMs + releaseMs) to prevent pumping and ramp inversions
  const mergeGapThresholdMs = Math.max(600, attackMs + releaseMs);
  const mergedWindows: Array<{ start_ms: number; end_ms: number }> = [];
  for (const w of rawWindows) {
    if (
      mergedWindows.length === 0 ||
      w.start_ms - mergedWindows[mergedWindows.length - 1].end_ms > mergeGapThresholdMs
    ) {
      mergedWindows.push({ ...w });
    } else {
      mergedWindows[mergedWindows.length - 1].end_ms = Math.max(
        mergedWindows[mergedWindows.length - 1].end_ms,
        w.end_ms
      );
    }
  }

  const { result: duckedCues, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `mix.duck(${bgmLaneId},${duckDb}dB)`,
    (seq) => {
      const lane = seq.lanes.find((l) => l.id === bgmLaneId);
      if (!lane) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(bgmLaneId));
      }

      const out: Array<{ cue_id: string; envelope_points: ParameterEnvelopePoint[] }> = [];

      for (const cue of lane.cues) {
        const cueStart = resolveCueStartMs(seq, cue);
        const cueEnd = cueStart + cue.duration_ms;

        const overlappingWins = mergedWindows.filter(
          (win) => win.end_ms > cueStart && win.start_ms < cueEnd
        );
        let initialValue = 0;
        if (overlappingWins.length > 0) {
          const firstSpeechStart = Math.max(0, overlappingWins[0].start_ms - cueStart);
          if (firstSpeechStart === 0) {
            initialValue = duckDb;
          } else if (firstSpeechStart < attackMs && attackMs > 0) {
            initialValue = Number((duckDb * (1 - firstSpeechStart / attackMs)).toFixed(2));
          }
        }

        const pts: ParameterEnvelopePoint[] = [{ offset_ms: 0, value: initialValue, easing: "linear" }];

        for (const win of overlappingWins) {
          const localSpeechStart = Math.max(0, win.start_ms - cueStart);
          const localSpeechEnd = Math.min(cue.duration_ms, win.end_ms - cueStart);

          const rampDownStart = Math.max(0, localSpeechStart - attackMs);
          const rampUpEnd = Math.min(cue.duration_ms, localSpeechEnd + releaseMs);

          if (rampDownStart > pts[pts.length - 1].offset_ms) {
            pts.push({ offset_ms: rampDownStart, value: 0, easing: "linear" });
          }
          pts.push({ offset_ms: localSpeechStart, value: duckDb, easing: "ease_out" });
          pts.push({ offset_ms: localSpeechEnd, value: duckDb, easing: "linear" });
          pts.push({ offset_ms: rampUpEnd, value: 0, easing: "ease_in_out" });
        }

        if (pts[pts.length - 1].offset_ms < cue.duration_ms) {
          pts.push({ offset_ms: cue.duration_ms, value: pts[pts.length - 1].value, easing: "linear" });
        }

        // Sort chronologically and deduplicate identical offset_ms keeping the lowest (most attenuated) value
        pts.sort((a, b) => a.offset_ms - b.offset_ms);
        const deduped: ParameterEnvelopePoint[] = [];
        for (const p of pts) {
          if (deduped.length > 0 && deduped[deduped.length - 1].offset_ms === p.offset_ms) {
            if (p.value <= deduped[deduped.length - 1].value) {
              deduped[deduped.length - 1].value = p.value;
              deduped[deduped.length - 1].easing = p.easing;
            }
          } else {
            deduped.push(p);
          }
        }

        const existingEnvIdx = cue.envelopes.findIndex((e) => e.parameter === "audio_chain.gain_db");
        if (existingEnvIdx >= 0) {
          cue.envelopes[existingEnvIdx].points = deduped;
        } else {
          cue.envelopes.push({ parameter: "audio_chain.gain_db", points: deduped });
        }

        out.push({ cue_id: cue.id, envelope_points: deduped });
      }

      if (seq.stage.master_audio) {
        const { paths } = loadSequence(options.workspaceDir);
        calibrateSequenceMasterAudio(
          seq,
          paths,
          seq.stage.master_audio.target_lufs,
          seq.stage.master_audio.true_peak_ceiling_dbtp
        );
      }

      return out;
    }
  );

  if (duckingWarningDiag) {
    verification.diagnostics.push(duckingWarningDiag);
    verification.warning_count += 1;
  }

  const duckDecisions: DecisionTraceItem[] = [];
  const nearMisses: DecisionTraceItem[] = [];

  mergedWindows.forEach((win, idx) => {
    duckDecisions.push({
      id: `duck_win_${idx + 1}`,
      span: [win.start_ms, win.end_ms],
      action: "applied",
      reason_code: "APPLIED",
      measured: { speech_duration_ms: win.end_ms - win.start_ms, attenuation_db: duckDb },
      threshold: { merge_gap_ms: mergeGapThresholdMs },
      note: `dialogue active in [${win.start_ms}..${win.end_ms}ms]; music dipped ${duckDb} dB`,
    });
  });

  for (const skippedClip of untranscribedSpineClips) {
    const modeUsed = untranscribedMode;
    const item: DecisionTraceItem = {
      id: skippedClip.id,
      span: [skippedClip.timeline_in_ms, skippedClip.timeline_in_ms + skippedClip.duration_ms],
      action: modeUsed === "skipped" ? "skipped" : "applied",
      reason_code: modeUsed === "skipped" ? "NO_TRANSCRIPT_SKIPPED" : "ACOUSTIC_VAD_FALLBACK",
      measured: { clip_duration_ms: skippedClip.duration_ms },
      note:
        modeUsed === "skipped"
          ? `clip '${skippedClip.id}' (${skippedClip.asset_handle}) has no transcript; treated as B-roll and skipped because the project has another dialogue source`
          : `clip '${skippedClip.id}' has no transcript; acoustic energy/formant VAD used`,
      refs: [skippedClip.id, skippedClip.asset_handle],
    };
    duckDecisions.push(item);
    if (modeUsed === "skipped") {
      nearMisses.push(item);
    }
  }

  const duckByReason: Record<string, number> = {};
  for (const d of duckDecisions) {
    duckByReason[d.reason_code] = (duckByReason[d.reason_code] ?? 0) + 1;
  }
  const duckAcceptedCount = duckDecisions.filter((d) => d.action === "applied").length;

  const totalDuckedMs = mergedWindows.reduce((acc, w) => acc + (w.end_ms - w.start_ms), 0);
  const decisionTrace: DecisionTrace = {
    trace_id: `tr_duck_r${revision}`,
    feature: "ducking",
    algorithm: { id: "duck.transcript-and-vad", version: "2.0.0" },
    revision,
    params: {
      duck_db: {
        value: duckDb,
        default: OPEN_STANDARDS.DUCKING.DEFAULT_ATTENUATION_DB,
        unit: "dB",
        source: options.duckDb !== undefined ? "user" : "default",
      },
      attack_ms: {
        value: attackMs,
        default: OPEN_STANDARDS.DUCKING.DEFAULT_ATTACK_MS,
        unit: "ms",
        source: options.attackMs !== undefined ? "user" : "default",
      },
      release_ms: {
        value: releaseMs,
        default: OPEN_STANDARDS.DUCKING.DEFAULT_RELEASE_MS,
        unit: "ms",
        source: options.releaseMs !== undefined ? "user" : "default",
      },
      merge_gap_ms: {
        value: mergeGapThresholdMs,
        default: 600,
        unit: "ms",
        source: "default",
      },
    },
    rules: [
      "R1: Transcribed spine clips and 'ln_vo' voiceover words are the primary dialogue triggers",
      "R2: Untranscribed spine clips are skipped (NO_TRANSCRIPT_SKIPPED) when the project has 'ln_vo' or a transcribed clip; otherwise acoustic energy/formant VAD is used",
      "R3: Speech windows with a gap <= merge_gap_ms are merged to avoid pumping",
      "R4: Each dialogue window gets duck_db attenuation with an attack_ms down-ramp and a release_ms up-ramp",
    ],
    summary: {
      text: `${rawWindows.length} raw speech spans -> ${mergedWindows.length} merged ducking windows (${duckDb} dB over ${totalDuckedMs}ms); ${untranscribedSpineClips.length} untranscribed clips examined`,
      candidates: duckDecisions.length,
      accepted: duckAcceptedCount,
      rejected: nearMisses.length,
      by_reason: duckByReason,
      effect: {
        raw_speech_windows: rawWindows.length,
        ducked_windows: mergedWindows.length,
        total_ducked_ms: totalDuckedMs,
        attenuation_db: duckDb,
      },
    },
    decisions: duckDecisions,
    near_misses: nearMisses,
  };

  return {
    bgm_lane: bgmLaneId,
    dialogue_windows_ms: mergedWindows,
    ducked_cues: duckedCues,
    decision_trace: decisionTrace,
    revision,
    verification,
  };
}
