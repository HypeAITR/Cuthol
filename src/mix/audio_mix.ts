/**
 * Cuthol Audio Mixing, Loudness Normalization, Voice Polish, Auto-Ducking & Beat Alignment (`src/mix/audio_mix.ts`).
 */

import { spawnSync } from "node:child_process";
import { resolveCueStartMs } from "../brief/inspector.js";
import { compileSequenceAudioPlan } from "../compositor/compiler.js";
import { DecisionTrace, DecisionTraceItem } from "../core/decision_trace.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { createDefaultAudioChain, CutholSequence, maxSourceDurationMs, ParameterEnvelopePoint } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { loadSequence, WorkspacePaths } from "../core/workspace.js";
import { analyzeAssetBeats } from "../library/beats.js";
import { analyzeAssetLoudness } from "../library/loudness.js";
import { analyzeAssetWaveform } from "../library/waveform.js";
import {
  clipLocalMsToSourceMs,
  computeClipDurationMs,
  integrateSourceOffsetToClipLocalMs,
  reflowSpine,
  sliceEnvelopes,
  sliceSpeedRamp,
  sourceMsToSequenceMs,
} from "../sequence/spine.js";
import { loadCachedTranscriptForAsset } from "../speech/transcribe.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";

export interface NormalizeAudioResult {
  target_lufs: number;
  true_peak_dbtp: number;
  measured_mix_before_lufs: number;
  measured_mix_before_peak_dbtp: number;
  achieved_lufs: number;
  achieved_true_peak_dbtp: number;
  master_gain_db: number;
  target_reached: boolean;
  warning?: string;
  adjusted_clips: Array<{
    id: string;
    integrated_lufs: number;
    applied_gain_db: number;
    effective_mix_gain_db: number;
  }>;
  decision_trace: DecisionTrace;
  revision: number;
  verification: VerificationReport;
}

function parseEbur128MixSummary(stderr: string): {
  integrated_lufs: number;
  true_peak_dbtp: number;
} {
  const summaryIdx = stderr.lastIndexOf("Summary:");
  const block = summaryIdx >= 0 ? stderr.slice(summaryIdx) : stderr;
  const iMatch = /I:\s*([-\d.]+)\s*LUFS/i.exec(block);
  const tpMatch = /Peak:\s*([-\d.]+)\s*dBFS/i.exec(block);
  const integrated = iMatch ? Number(iMatch[1]) : -70.0;
  const peak = tpMatch ? Number(tpMatch[1]) : -70.0;
  return {
    integrated_lufs: Number.isFinite(integrated) ? Number(integrated.toFixed(2)) : -70.0,
    true_peak_dbtp: Number.isFinite(peak) ? Number(peak.toFixed(2)) : -70.0,
  };
}

function measureSequenceMixLoudness(
  seq: CutholSequence,
  paths: WorkspacePaths,
  overrideMasterAudio: CutholSequence["stage"]["master_audio"]
): { hasActiveAudio: boolean; integrated_lufs: number; true_peak_dbtp: number } {
  const plan = compileSequenceAudioPlan(seq, paths, overrideMasterAudio);
  if (!plan.hasActiveAudio) {
    return { hasActiveAudio: false, integrated_lufs: -70.0, true_peak_dbtp: -70.0 };
  }

  const filterWithEbur = `${plan.filterComplex};${plan.audioOutPad}ebur128=peak=true[ebur_out]`;
  const proc = spawnSync(
    "ffmpeg",
    [
      "-nostats",
      "-v",
      "info",
      ...plan.inputArgs,
      "-filter_complex",
      filterWithEbur,
      "-map",
      "[ebur_out]",
      "-t",
      (plan.totalDurationMs / 1000).toFixed(3),
      "-f",
      "null",
      "-",
    ],
    {
      cwd: paths.rootDir,
      encoding: "utf8",
      // ebur128 logs ~10 lines per second of audio and runs over the whole mix: no wall-clock limit.
      maxBuffer: 256 * 1024 * 1024,
    }
  );

  const stderr = `${proc.stderr || ""}\n${proc.stdout || ""}`;
  const parsed = parseEbur128MixSummary(stderr);
  return {
    hasActiveAudio: true,
    integrated_lufs: parsed.integrated_lufs,
    true_peak_dbtp: parsed.true_peak_dbtp,
  };
}

function calibrateSequenceMasterAudio(
  seq: CutholSequence,
  paths: WorkspacePaths,
  targetLufs: number,
  truePeakDbtp: number
): {
  before: { hasActiveAudio: boolean; integrated_lufs: number; true_peak_dbtp: number };
  after: { hasActiveAudio: boolean; integrated_lufs: number; true_peak_dbtp: number };
  masterGainDb: number;
  targetReached: boolean;
} {
  const before = measureSequenceMixLoudness(seq, paths, {
    gain_db: 0,
    target_lufs: targetLufs,
    true_peak_ceiling_dbtp: truePeakDbtp,
  });

  if (!before.hasActiveAudio || !Number.isFinite(before.integrated_lufs) || before.integrated_lufs <= -65) {
    seq.stage.master_audio = {
      gain_db: 0,
      target_lufs: targetLufs,
      true_peak_ceiling_dbtp: truePeakDbtp,
    };
    return {
      before,
      after: before,
      masterGainDb: 0,
      targetReached: false,
    };
  }

  let masterGainDb = Number(
    Math.max(-24, Math.min(24, targetLufs - before.integrated_lufs)).toFixed(2)
  );
  let after = before;

  if (Math.abs(masterGainDb) > 0.05 || before.true_peak_dbtp > truePeakDbtp) {
    after = measureSequenceMixLoudness(seq, paths, {
      gain_db: masterGainDb,
      target_lufs: targetLufs,
      true_peak_ceiling_dbtp: truePeakDbtp,
    });

    for (let iter = 0; iter < 3; iter++) {
      const residual = targetLufs - after.integrated_lufs;
      if (Math.abs(residual) <= 0.15) break;
      const nextGain = Number(
        Math.max(-30, Math.min(30, masterGainDb + residual * 1.2)).toFixed(2)
      );
      if (Math.abs(nextGain - masterGainDb) < 0.05) break;
      masterGainDb = nextGain;
      after = measureSequenceMixLoudness(seq, paths, {
        gain_db: masterGainDb,
        target_lufs: targetLufs,
        true_peak_ceiling_dbtp: truePeakDbtp,
      });
    }
  }

  seq.stage.master_audio = {
    gain_db: masterGainDb,
    target_lufs: targetLufs,
    true_peak_ceiling_dbtp: truePeakDbtp,
  };

  const targetReached =
    after.hasActiveAudio &&
    Math.abs(after.integrated_lufs - targetLufs) <= 1.0 &&
    after.true_peak_dbtp <= truePeakDbtp + 0.15;

  return {
    before,
    after,
    masterGainDb,
    targetReached,
  };
}

export function normalizeSequenceAudio(options: {
  workspaceDir: string;
  targetLufs?: number;
  truePeakDbtp?: number;
  clipIds?: string[];
}): NormalizeAudioResult {
  const rawTargetLufs =
    options.targetLufs !== undefined && Number.isFinite(options.targetLufs)
      ? options.targetLufs
      : OPEN_STANDARDS.LOUDNESS.DEFAULT_TARGET_LUFS;
  const targetLufs = Math.max(
    OPEN_STANDARDS.LOUDNESS.MIN_TARGET_LUFS,
    Math.min(OPEN_STANDARDS.LOUDNESS.MAX_TARGET_LUFS, rawTargetLufs)
  );
  const rawTruePeak =
    options.truePeakDbtp !== undefined && Number.isFinite(options.truePeakDbtp)
      ? options.truePeakDbtp
      : OPEN_STANDARDS.LOUDNESS.DEFAULT_TRUE_PEAK_DBTP;
  const truePeakDbtp = Math.max(
    OPEN_STANDARDS.LOUDNESS.MIN_TRUE_PEAK_DBTP,
    Math.min(OPEN_STANDARDS.LOUDNESS.MAX_TRUE_PEAK_DBTP, rawTruePeak)
  );

  const { paths, sequence: initialSeq } = loadSequence(options.workspaceDir);
  const targetSet = options.clipIds ? new Set(options.clipIds) : null;

  if (targetSet) {
    const knownIds = new Set<string>([
      ...initialSeq.spine.clips.map((c) => c.id),
      ...initialSeq.lanes.flatMap((l) => l.cues.map((c) => c.id)),
    ]);
    for (const reqId of targetSet) {
      if (!knownIds.has(reqId)) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(reqId));
      }
    }
  }

  // Pre-compute loudness on all relevant library assets (spine clips + voiceover/audio lane cues)
  const loudnessByAsset = new Map<string, { integrated_lufs: number; true_peak_dbtp: number }>();
  const ensureLoudnessForAsset = (assetHandle: string | undefined): void => {
    if (!assetHandle || loudnessByAsset.has(assetHandle)) return;
    const asset = initialSeq.library.find((x) => x.handle === assetHandle);
    if (asset?.probe.has_audio) {
      const m = analyzeAssetLoudness({
        workspaceDir: options.workspaceDir,
        handle: asset.handle,
        targetLufs,
      });
      loudnessByAsset.set(asset.handle, {
        integrated_lufs: m.integrated_lufs,
        true_peak_dbtp: m.true_peak_dbtp,
      });
    }
  };

  for (const clip of initialSeq.spine.clips) {
    if (targetSet && !targetSet.has(clip.id)) continue;
    ensureLoudnessForAsset(clip.asset_handle);
  }
  for (const lane of initialSeq.lanes) {
    for (const cue of lane.cues) {
      const includeCue = targetSet ? targetSet.has(cue.id) : lane.id === "ln_vo" || cue.kind === "voiceover";
      if (!includeCue) continue;
      ensureLoudnessForAsset(cue.asset_handle);
    }
  }
  const fallbackToAllAudioCues = !targetSet && loudnessByAsset.size === 0;
  if (fallbackToAllAudioCues) {
    for (const lane of initialSeq.lanes) {
      for (const cue of lane.cues) {
        ensureLoudnessForAsset(cue.asset_handle);
      }
    }
  }

  const spanById = new Map<string, [number, number]>();
  const { result: mutRes, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `mix.normalize(${targetLufs}LUFS)`,
    (seq) => {
      const list: Array<{
        id: string;
        integrated_lufs: number;
        applied_gain_db: number;
        effective_mix_gain_db: number;
      }> = [];
      for (const clip of seq.spine.clips) {
        if (targetSet && !targetSet.has(clip.id)) continue;
        const m = loudnessByAsset.get(clip.asset_handle);
        if (!m) continue;

        const desiredGain = targetLufs - m.integrated_lufs;
        const maxSafeGain = truePeakDbtp - m.true_peak_dbtp;
        const appliedGain = Number(Math.max(-24, Math.min(24, desiredGain, maxSafeGain)).toFixed(2));

        clip.audio_chain.gain_db = appliedGain;
        clip.audio_chain.loudness_target_lufs = targetLufs;
        clip.audio_chain.true_peak_ceiling_dbtp = truePeakDbtp;
        spanById.set(clip.id, [clip.timeline_in_ms, clip.timeline_in_ms + clip.duration_ms]);

        list.push({
          id: clip.id,
          integrated_lufs: m.integrated_lufs,
          applied_gain_db: appliedGain,
          effective_mix_gain_db: appliedGain,
        });
      }

      for (const lane of seq.lanes) {
        for (const cue of lane.cues) {
          const includeCue = targetSet
            ? targetSet.has(cue.id)
            : fallbackToAllAudioCues || lane.id === "ln_vo" || cue.kind === "voiceover";
          if (!includeCue || !cue.asset_handle) continue;
          const m = loudnessByAsset.get(cue.asset_handle);
          if (!m) continue;

          const desiredGain = targetLufs - m.integrated_lufs;
          const maxSafeGain = truePeakDbtp - m.true_peak_dbtp;
          const appliedGain = Number(Math.max(-24, Math.min(24, desiredGain, maxSafeGain)).toFixed(2));

          if (!cue.audio_chain) {
            cue.audio_chain = createDefaultAudioChain();
          }
          cue.audio_chain.gain_db = appliedGain;
          cue.audio_chain.loudness_target_lufs = targetLufs;
          cue.audio_chain.true_peak_ceiling_dbtp = truePeakDbtp;
          const cueStart = resolveCueStartMs(seq, cue);
          spanById.set(cue.id, [cueStart, cueStart + cue.duration_ms]);

          list.push({
            id: cue.id,
            integrated_lufs: m.integrated_lufs,
            applied_gain_db: appliedGain,
            effective_mix_gain_db: appliedGain,
          });
        }
      }

      const cal = calibrateSequenceMasterAudio(seq, paths, targetLufs, truePeakDbtp);
      for (const item of list) {
        item.effective_mix_gain_db = Number((item.applied_gain_db + cal.masterGainDb).toFixed(2));
      }
      return { list, cal };
    }
  );

  const adjusted = mutRes.list;
  const { before: mixBefore, after: mixAfter, masterGainDb, targetReached } = mutRes.cal;
  const warningMsg = !targetReached
    ? `Hedef ses seviyesine (${targetLufs} LUFS) tam ulaşılamadı: ölçülen son karışım ${mixAfter.integrated_lufs} LUFS (gerçek tepe ${mixAfter.true_peak_dbtp} dBTP, tavan ${truePeakDbtp} dBTP).`
    : undefined;

  const normDecisions: DecisionTraceItem[] = adjusted.map((item) => {
    const desired = Number((targetLufs - item.integrated_lufs).toFixed(2));
    const clamped = Math.abs(desired - item.applied_gain_db) > 0.05;
    return {
      id: item.id,
      span: spanById.get(item.id) ?? [0, 0],
      action: clamped ? "clamped" : "applied",
      reason_code: clamped ? "TRUE_PEAK_CLAMPED" : "APPLIED",
      measured: {
        integrated_lufs: item.integrated_lufs,
        desired_gain_db: desired,
        applied_gain_db: item.applied_gain_db,
        effective_mix_gain_db: item.effective_mix_gain_db,
      },
      threshold: { target_lufs: targetLufs, true_peak_dbtp: truePeakDbtp },
    };
  });

  normDecisions.push({
    id: "master_bus",
    span: [0, Math.max(0, ...Array.from(spanById.values()).map((s) => s[1]))],
    action: targetReached ? "applied" : "clamped",
    reason_code: targetReached ? "MASTER_MIX_CALIBRATED" : "TARGET_NOT_REACHED",
    measured: {
      mix_before_lufs: mixBefore.integrated_lufs,
      mix_before_peak_dbtp: mixBefore.true_peak_dbtp,
      master_gain_db: masterGainDb,
      achieved_lufs: mixAfter.integrated_lufs,
      achieved_true_peak_dbtp: mixAfter.true_peak_dbtp,
    },
    threshold: { target_lufs: targetLufs, true_peak_dbtp: truePeakDbtp },
    note: targetReached
      ? `Ana ses karışımı ${mixBefore.integrated_lufs} LUFS -> ${mixAfter.integrated_lufs} LUFS (tepe ${mixAfter.true_peak_dbtp} dBTP, master kazanç ${masterGainDb >= 0 ? "+" : ""}${masterGainDb} dB) seviyesine kalibre edildi`
      : warningMsg,
  });

  const byReason: Record<string, number> = {};
  for (const d of normDecisions) {
    byReason[d.reason_code] = (byReason[d.reason_code] ?? 0) + 1;
  }

  const decisionTrace: DecisionTrace = {
    trace_id: `tr_norm_r${revision}`,
    feature: "loudness_normalize",
    algorithm: { id: "loudness.itu-bs1770-4.master-calibrated", version: "2.1.0" },
    revision,
    params: {
      target_lufs: {
        value: targetLufs,
        default: OPEN_STANDARDS.LOUDNESS.DEFAULT_TARGET_LUFS,
        unit: "LUFS",
        source: options.targetLufs !== undefined ? "user" : "default",
      },
      true_peak_dbtp: {
        value: truePeakDbtp,
        default: OPEN_STANDARDS.LOUDNESS.DEFAULT_TRUE_PEAK_DBTP,
        unit: "dBTP",
        source: options.truePeakDbtp !== undefined ? "user" : "default",
      },
    },
    rules: [
      "R1: Her klip/seslendirme için ITU-R BS.1770-4 Integrated LUFS ve True Peak (dBTP) ölçülüp ön-kazanç atanır",
      "R2: Derlenen tam sekans ses karışımı (amix + zarflar + filtreler + alimiter) ebur128=peak=true ile ölçülür ve master bus kazancı kapalı çevrimle hedef LUFS'a kalibre edilir",
    ],
    summary: {
      text: targetReached
        ? `${adjusted.length} ses öğesi ve ana karışım normalize edildi: ${mixBefore.integrated_lufs} LUFS -> ${mixAfter.integrated_lufs} LUFS (hedef ${targetLufs} LUFS, gerçek tepe ${mixAfter.true_peak_dbtp} dBTP, master kazanç ${masterGainDb >= 0 ? "+" : ""}${masterGainDb} dB)`
        : `UYARI: ${warningMsg}`,
      candidates: normDecisions.length,
      accepted: normDecisions.filter((d) => d.action === "applied").length,
      rejected: normDecisions.filter((d) => d.reason_code === "TARGET_NOT_REACHED").length,
      by_reason: byReason,
      effect: {
        adjusted_count: adjusted.length,
        measured_mix_before_lufs: mixBefore.integrated_lufs,
        achieved_lufs: mixAfter.integrated_lufs,
        achieved_true_peak_dbtp: mixAfter.true_peak_dbtp,
        master_gain_db: masterGainDb,
        target_reached: targetReached ? 1 : 0,
      },
    },
    decisions: normDecisions,
    near_misses: normDecisions.filter((d) => d.action === "clamped"),
  };

  return {
    target_lufs: targetLufs,
    true_peak_dbtp: truePeakDbtp,
    measured_mix_before_lufs: mixBefore.integrated_lufs,
    measured_mix_before_peak_dbtp: mixBefore.true_peak_dbtp,
    achieved_lufs: mixAfter.integrated_lufs,
    achieved_true_peak_dbtp: mixAfter.true_peak_dbtp,
    master_gain_db: masterGainDb,
    target_reached: targetReached,
    ...(warningMsg ? { warning: warningMsg } : {}),
    adjusted_clips: adjusted,
    decision_trace: decisionTrace,
    revision,
    verification,
  };
}

export function polishVoiceAudio(options: {
  workspaceDir: string;
  clipIds?: string[];
  nrDb?: number;
  noiseFloorDb?: number;
  enableClarity?: boolean;
  highpassHz?: number;
  presenceBoostDb?: number;
}): { polished_clips: string[]; revision: number; verification: VerificationReport } {
  const rawNrDb =
    options.nrDb !== undefined && Number.isFinite(options.nrDb)
      ? options.nrDb
      : OPEN_STANDARDS.DENOISE_AFFTDN.DEFAULT_NR_DB;
  const nrDb = Math.max(
    OPEN_STANDARDS.DENOISE_AFFTDN.MIN_NR_DB,
    Math.min(OPEN_STANDARDS.DENOISE_AFFTDN.MAX_NR_DB, rawNrDb)
  );
  const rawNoiseFloorDb =
    options.noiseFloorDb !== undefined && Number.isFinite(options.noiseFloorDb)
      ? options.noiseFloorDb
      : OPEN_STANDARDS.DENOISE_AFFTDN.DEFAULT_NOISE_FLOOR_DB;
  const noiseFloorDb = Math.max(
    OPEN_STANDARDS.DENOISE_AFFTDN.MIN_NOISE_FLOOR_DB,
    Math.min(OPEN_STANDARDS.DENOISE_AFFTDN.MAX_NOISE_FLOOR_DB, rawNoiseFloorDb)
  );
  const enableClarity = options.enableClarity ?? true;
  const rawHighpassHz =
    options.highpassHz !== undefined && Number.isFinite(options.highpassHz)
      ? options.highpassHz
      : OPEN_STANDARDS.VOICE_CLARITY.DEFAULT_HIGHPASS_HZ;
  const highpassHz = Math.max(
    OPEN_STANDARDS.VOICE_CLARITY.MIN_HIGHPASS_HZ,
    Math.min(OPEN_STANDARDS.VOICE_CLARITY.MAX_HIGHPASS_HZ, rawHighpassHz)
  );
  const rawPresenceBoostDb =
    options.presenceBoostDb !== undefined && Number.isFinite(options.presenceBoostDb)
      ? options.presenceBoostDb
      : OPEN_STANDARDS.VOICE_CLARITY.DEFAULT_PRESENCE_BOOST_DB;
  const presenceBoostDb = Math.max(
    OPEN_STANDARDS.VOICE_CLARITY.MIN_PRESENCE_BOOST_DB,
    Math.min(OPEN_STANDARDS.VOICE_CLARITY.MAX_PRESENCE_BOOST_DB, rawPresenceBoostDb)
  );
  const targetSet = options.clipIds ? new Set(options.clipIds) : null;

  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    "mix.polish-voice",
    (seq) => {
      if (targetSet) {
        const knownIds = new Set<string>([
          ...seq.spine.clips.map((c) => c.id),
          ...seq.lanes.flatMap((l) => l.cues.map((c) => c.id)),
        ]);
        for (const reqId of targetSet) {
          if (!knownIds.has(reqId)) {
            throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(reqId));
          }
        }
      }

      const libMap = new Map(seq.library.map((x) => [x.handle, x]));
      const ids: string[] = [];
      for (const clip of seq.spine.clips) {
        if (targetSet && !targetSet.has(clip.id)) continue;
        const asset = libMap.get(clip.asset_handle);
        if (!asset?.probe.has_audio) continue;
        clip.audio_chain.denoise = {
          enabled: true,
          nr_db: nrDb,
          noise_floor_db: noiseFloorDb,
        };
        clip.audio_chain.voice_clarity = {
          enabled: enableClarity,
          highpass_hz: highpassHz,
          presence_boost_db: presenceBoostDb,
          compressor_ratio: OPEN_STANDARDS.VOICE_CLARITY.DEFAULT_COMPRESSOR_RATIO,
        };
        ids.push(clip.id);
      }

      for (const lane of seq.lanes) {
        for (const cue of lane.cues) {
          const includeCue = targetSet
            ? targetSet.has(cue.id)
            : lane.id === "ln_vo" || lane.kind === "voiceover" || cue.kind === "voiceover";
          if (!includeCue || !cue.asset_handle) continue;
          const asset = libMap.get(cue.asset_handle);
          if (!asset?.probe.has_audio) continue;
          if (!cue.audio_chain) {
            cue.audio_chain = createDefaultAudioChain();
          }
          cue.audio_chain.denoise = {
            enabled: true,
            nr_db: nrDb,
            noise_floor_db: noiseFloorDb,
          };
          cue.audio_chain.voice_clarity = {
            enabled: enableClarity,
            highpass_hz: highpassHz,
            presence_boost_db: presenceBoostDb,
            compressor_ratio: OPEN_STANDARDS.VOICE_CLARITY.DEFAULT_COMPRESSOR_RATIO,
          };
          ids.push(cue.id);
        }
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
      return ids;
    }
  );

  return { polished_clips: result, revision, verification };
}

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
      note: `[${win.start_ms}..${win.end_ms}ms] aralığında diyalog aktif; müzik ${duckDb} dB kısıldı`,
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
          ? `'${skippedClip.id}' (${skippedClip.asset_handle}) klibinde transkript yok; projede başka diyalog kaynağı olduğu için B-roll kabul edilip atlandı`
          : `'${skippedClip.id}' klibinde transkript yok; akustik enerji/formant VAD kullanıldı`,
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
      "R1: Transkriptli omurga klipleri ve 'ln_vo' seslendirme kelimeleri birincil diyalog tetikleyicisi olarak alınır",
      "R2: Projede 'ln_vo' veya transkriptli klip varsa transkriptsiz omurga klipleri atlanır (NO_TRANSCRIPT_SKIPPED); hiçbiri yoksa akustik enerji/formant VAD kullanılır",
      "R3: Aralarındaki boşluk <= merge_gap_ms olan konuşma pencereleri pompalanmayı önlemek için birleştirilir",
      "R4: Her diyalog penceresine attack_ms iniş ve release_ms çıkış rampalarıyla duck_db zayıflatma uygulanır",
    ],
    summary: {
      text: `${rawWindows.length} ham konuşma aralığı -> ${mergedWindows.length} birleştirilmiş ducking penceresi (${totalDuckedMs}ms boyunca ${duckDb} dB); ${untranscribedSpineClips.length} transkriptsiz klip incelendi`,
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

/**
 * Aligns the cut points (`duration_ms` / `source_out_ms`) of target `spine` clips
 * to the detected musical beats (`beats_ms[]`) of `bgmHandle` within `toleranceMs`.
 */
export function alignClipsToBeats(options: {
  workspaceDir: string;
  bgmHandle: string;
  clipIds?: string[];
  sensitivity?: number;
  toleranceMs?: number;
  preserveDuration?: boolean;
  alignTo?: "grid" | "onsets";
  useGrid?: boolean;
}): {
  bgm_handle: string;
  align_mode: "grid" | "onsets";
  estimated_bpm: number;
  phase_ms: number;
  tolerance_ms: number;
  old_total_duration_ms: number;
  new_total_duration_ms: number;
  total_duration_delta_ms: number;
  duration_warning?: string;
  aligned_clips: Array<{
    clip_id: string;
    old_duration_ms: number;
    new_duration_ms: number;
    shift_ms: number;
    beat_time_ms: number;
    reason_code: "SHIFTED_TO_BEAT" | "ALREADY_ON_BEAT";
  }>;
  skipped_clips: Array<{
    clip_id: string;
    duration_ms: number;
    nearest_beat_ms: number | null;
    distance_ms: number | null;
    reason_code: "OUT_OF_TOLERANCE" | "NO_VALID_BEAT_IN_RANGE";
  }>;
  decision_trace: DecisionTrace;
  revision: number;
  verification: VerificationReport;
} {
  const beatAnalysis = analyzeAssetBeats({
    workspaceDir: options.workspaceDir,
    handle: options.bgmHandle,
    sensitivity: options.sensitivity,
  });

  const requestedMode: "grid" | "onsets" =
    options.alignTo === "onsets" || options.useGrid === false ? "onsets" : "grid";
  const hasGrid = Array.isArray(beatAnalysis.grid_ms) && beatAnalysis.grid_ms.length > 0;
  const alignMode: "grid" | "onsets" = requestedMode === "grid" && hasGrid ? "grid" : "onsets";
  const beats =
    alignMode === "grid"
      ? beatAnalysis.grid_ms
      : (beatAnalysis.onsets_ms ?? beatAnalysis.beats_ms);
  const beatPeriodMs = beatAnalysis.estimated_bpm > 0 ? 60_000 / beatAnalysis.estimated_bpm : 500;
  const defaultToleranceMs = Math.max(120, Math.min(500, Math.round(beatPeriodMs * 0.5)));
  const toleranceMs =
    options.toleranceMs !== undefined && Number.isFinite(options.toleranceMs)
      ? Math.max(20, Math.round(options.toleranceMs))
      : defaultToleranceMs;
  const preserveDuration = options.preserveDuration ?? false;

  const targetSet = options.clipIds ? new Set(options.clipIds) : null;

  const alignedSpanById = new Map<string, [number, number]>();
  const skippedTargetClips: Array<{
    clip_id: string;
    duration_ms: number;
    desired_end_ms: number;
    nearest_beat_ms: number | null;
    distance_ms: number | null;
    span: [number, number];
    min_allowed_ms: number;
    max_timeline_ms: number;
    reason_code: "OUT_OF_TOLERANCE" | "NO_VALID_BEAT_IN_RANGE";
  }> = [];

  let oldTotalDurationMs = 0;
  let newTotalDurationMs = 0;

  const { result: aligned, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `mix.beat-align(${options.bgmHandle})`,
    (seq) => {
      oldTotalDurationMs = seq.spine.clips.reduce((acc, c) => acc + c.duration_ms, 0);
      const libMap = new Map(seq.library.map((x) => [x.handle, x]));
      const changes: Array<{
        clip_id: string;
        old_duration_ms: number;
        new_duration_ms: number;
        shift_ms: number;
        beat_time_ms: number;
        reason_code: "SHIFTED_TO_BEAT" | "ALREADY_ON_BEAT";
      }> = [];

      let runningTimelineMs = 0;
      const minFrameDurMs = Math.ceil(
        (OPEN_STANDARDS.SIGNAL_SANITY.MIN_CLIP_FRAMES * 1000) / Math.max(1, seq.stage.fps)
      );

      for (let idx = 0; idx < seq.spine.clips.length; idx++) {
        const clip = seq.spine.clips[idx];
        const prevClip = idx > 0 ? seq.spine.clips[idx - 1] : null;
        const oldDur = clip.duration_ms;
        const oldSourceSpan = Math.max(1, clip.source_out_ms - clip.source_in_ms);
        if (targetSet && !targetSet.has(clip.id)) {
          runningTimelineMs += oldDur;
          continue;
        }

        const asset = libMap.get(clip.asset_handle);
        const maxSourceOut = asset ? maxSourceDurationMs(asset) : clip.source_out_ms;
        const maxSourceSpan = Math.max(1, maxSourceOut - clip.source_in_ms);
        const extendedRamp =
          clip.playback.speed_ramp && clip.playback.speed_ramp.length > 0 && maxSourceSpan > oldSourceSpan
            ? [
                ...clip.playback.speed_ramp,
                {
                  source_offset_ms: maxSourceSpan,
                  rate: clip.playback.speed_ramp[clip.playback.speed_ramp.length - 1].rate,
                },
              ]
            : clip.playback.speed_ramp;
        const tempMaxClip = {
          ...clip,
          source_out_ms: clip.source_in_ms + maxSourceSpan,
          playback: { ...clip.playback, speed_ramp: extendedRamp },
        };
        const maxTimelineDur = Math.max(
          1,
          Math.floor(integrateSourceOffsetToClipLocalMs(tempMaxClip, maxSourceSpan))
        );
        const desiredEndMs = runningTimelineMs + oldDur;
        const minTransitionBudgetMs = Math.max(
          (clip.transition_out?.duration_ms ?? 0) * 2,
          (prevClip?.transition_out?.duration_ms ?? 0) * 2
        );
        const minAllowedDur = Math.max(200, minFrameDurMs, minTransitionBudgetMs);

        // Find closest beat >= runningTimelineMs + minAllowedDur and <= runningTimelineMs + maxTimelineDur
        let bestBeat: number | null = null;
        let bestDist = Number.MAX_SAFE_INTEGER;
        for (const b of beats) {
          if (b < runningTimelineMs + minAllowedDur) continue;
          if (b > runningTimelineMs + maxTimelineDur) break;
          const dist = Math.abs(b - desiredEndMs);
          if (dist < bestDist) {
            bestDist = dist;
            bestBeat = b;
          }
        }

        if (bestBeat !== null && bestDist <= toleranceMs) {
          const targetDur = bestBeat - runningTimelineMs;
          let actualNewDur = oldDur;
          if (targetDur !== oldDur) {
            const mappedSourceOut = clipLocalMsToSourceMs(tempMaxClip, targetDur);
            const newSourceOut = Math.max(
              clip.source_in_ms + 1,
              Math.min(maxSourceOut, mappedSourceOut)
            );
            const newSourceSpan = Math.max(1, newSourceOut - clip.source_in_ms);
            if (clip.playback.speed_ramp && clip.playback.speed_ramp.length > 0) {
              clip.playback.speed_ramp = sliceSpeedRamp(
                extendedRamp,
                Math.max(oldSourceSpan, newSourceSpan),
                clip.playback.rate,
                0,
                newSourceSpan
              );
            }
            clip.source_out_ms = newSourceOut;
            actualNewDur = computeClipDurationMs(clip);
            clip.duration_ms = actualNewDur;
            clip.envelopes = sliceEnvelopes(clip.envelopes, 0, actualNewDur);

            for (const lane of seq.lanes) {
              for (const cue of lane.cues) {
                if (cue.anchor?.ref === clip.id && cue.anchor.offset_ms > actualNewDur) {
                  cue.anchor.offset_ms = Math.max(0, Math.min(actualNewDur, cue.anchor.offset_ms));
                }
              }
            }
          }

          const shiftMs = actualNewDur - oldDur;
          changes.push({
            clip_id: clip.id,
            old_duration_ms: oldDur,
            new_duration_ms: actualNewDur,
            shift_ms: shiftMs,
            beat_time_ms: bestBeat,
            reason_code: shiftMs === 0 ? "ALREADY_ON_BEAT" : "SHIFTED_TO_BEAT",
          });
        } else if (bestBeat !== null) {
          skippedTargetClips.push({
            clip_id: clip.id,
            duration_ms: oldDur,
            desired_end_ms: desiredEndMs,
            nearest_beat_ms: bestBeat,
            distance_ms: bestDist,
            span: [runningTimelineMs, runningTimelineMs + oldDur],
            min_allowed_ms: runningTimelineMs + minAllowedDur,
            max_timeline_ms: runningTimelineMs + maxTimelineDur,
            reason_code: "OUT_OF_TOLERANCE",
          });
        } else {
          skippedTargetClips.push({
            clip_id: clip.id,
            duration_ms: oldDur,
            desired_end_ms: desiredEndMs,
            nearest_beat_ms: null,
            distance_ms: null,
            span: [runningTimelineMs, runningTimelineMs + oldDur],
            min_allowed_ms: runningTimelineMs + minAllowedDur,
            max_timeline_ms: runningTimelineMs + maxTimelineDur,
            reason_code: "NO_VALID_BEAT_IN_RANGE",
          });
        }

        runningTimelineMs += clip.duration_ms;
      }

      if (preserveDuration && seq.spine.clips.length > 0 && runningTimelineMs !== oldTotalDurationMs) {
        const lastClip = seq.spine.clips[seq.spine.clips.length - 1];
        const prevClip = seq.spine.clips.length > 1 ? seq.spine.clips[seq.spine.clips.length - 2] : null;
        const asset = libMap.get(lastClip.asset_handle);
        const maxSourceOut = asset ? maxSourceDurationMs(asset) : lastClip.source_out_ms;
        const maxSourceSpan = Math.max(1, maxSourceOut - lastClip.source_in_ms);
        const tempMaxClip = { ...lastClip, source_out_ms: lastClip.source_in_ms + maxSourceSpan };
        const maxTimelineDur = Math.max(
          1,
          Math.floor(integrateSourceOffsetToClipLocalMs(tempMaxClip, maxSourceSpan))
        );
        const minTransitionBudgetMs = Math.max(
          (lastClip.transition_out?.duration_ms ?? 0) * 2,
          (prevClip?.transition_out?.duration_ms ?? 0) * 2
        );
        const minAllowedDur = Math.max(200, minFrameDurMs, minTransitionBudgetMs);
        const prefixDur = runningTimelineMs - lastClip.duration_ms;
        const wantedLastDur = Math.max(
          minAllowedDur,
          Math.min(maxTimelineDur, oldTotalDurationMs - prefixDur)
        );
        const mappedSourceOut = clipLocalMsToSourceMs(tempMaxClip, wantedLastDur);
        lastClip.source_out_ms = Math.max(
          lastClip.source_in_ms + 1,
          Math.min(maxSourceOut, mappedSourceOut)
        );
        lastClip.duration_ms = computeClipDurationMs(lastClip);
        lastClip.envelopes = sliceEnvelopes(lastClip.envelopes, 0, lastClip.duration_ms);
      }

      // Ensure transition_out budgets remain valid across all neighbor pairs after duration adjustments
      for (let i = 0; i < seq.spine.clips.length; i++) {
        const curr = seq.spine.clips[i];
        if (curr.transition_out) {
          const next = seq.spine.clips[i + 1];
          const maxTrans = next
            ? Math.floor(Math.min(curr.duration_ms, next.duration_ms) / 2)
            : Math.floor(curr.duration_ms / 2);
          if (curr.transition_out.duration_ms > maxTrans) {
            curr.transition_out =
              maxTrans > 0 ? { ...curr.transition_out, duration_ms: maxTrans } : null;
          }
        }
      }

      reflowSpine(seq);
      newTotalDurationMs = seq.spine.clips.reduce((acc, c) => acc + c.duration_ms, 0);
      for (const clip of seq.spine.clips) {
        alignedSpanById.set(clip.id, [clip.timeline_in_ms, clip.timeline_in_ms + clip.duration_ms]);
      }
      return changes;
    }
  );

  const totalDurationDeltaMs = newTotalDurationMs - oldTotalDurationMs;
  const significantDurationChange =
    Math.abs(totalDurationDeltaMs) > Math.max(toleranceMs, 500) ||
    (oldTotalDurationMs > 0 && Math.abs(totalDurationDeltaMs) / oldTotalDurationMs > 0.08);
  const durationWarning = significantDurationChange
    ? `Toplam omurga süresi belirgin şekilde değişti: ${oldTotalDurationMs}ms -> ${newTotalDurationMs}ms (${totalDurationDeltaMs >= 0 ? "+" : ""}${totalDurationDeltaMs}ms). Süreyi korumak için '--preserve-duration' veya daha dar '--tolerance' kullanabilirsiniz.`
    : undefined;

  const beatDecisions: DecisionTraceItem[] = aligned.map((c) => {
    const shiftMs = c.new_duration_ms - c.old_duration_ms;
    const isAlreadyOnBeat = shiftMs === 0;
    return {
      id: c.clip_id,
      span: alignedSpanById.get(c.clip_id) ?? [0, c.new_duration_ms],
      action: isAlreadyOnBeat ? "applied" : "shifted",
      reason_code: isAlreadyOnBeat ? "ALREADY_ON_BEAT" : "SHIFTED_TO_BEAT",
      measured: {
        old_duration_ms: c.old_duration_ms,
        new_duration_ms: c.new_duration_ms,
        shift_ms: shiftMs,
        beat_time_ms: c.beat_time_ms,
      },
      threshold: {
        tolerance_ms: toleranceMs,
      },
      ...(isAlreadyOnBeat
        ? {
            note: `'${c.clip_id}' bitiş noktası (${c.beat_time_ms}ms) zaten müzik vuruşu üzerinde olduğu için kaydırılmadı (0ms)`,
          }
        : {}),
    };
  });

  const beatNearMisses: DecisionTraceItem[] = skippedTargetClips.map((s): DecisionTraceItem => {
    if (s.reason_code === "OUT_OF_TOLERANCE") {
      return {
        id: s.clip_id,
        span: alignedSpanById.get(s.clip_id) ?? s.span,
        action: "skipped",
        reason_code: "OUT_OF_TOLERANCE",
        measured: {
          duration_ms: s.duration_ms,
          desired_end_ms: s.desired_end_ms,
          nearest_beat_ms: s.nearest_beat_ms ?? 0,
          distance_ms: s.distance_ms ?? 0,
        },
        threshold: {
          tolerance_ms: toleranceMs,
        },
        margin: (s.distance_ms ?? 0) - toleranceMs,
        note: `'${s.clip_id}' bitiş noktasına (${s.desired_end_ms}ms) en yakın vuruş ${s.nearest_beat_ms}ms (${s.distance_ms}ms uzakta > tolerans ±${toleranceMs}ms); klip süresi değiştirilmedi`,
      };
    }
    return {
      id: s.clip_id,
      span: alignedSpanById.get(s.clip_id) ?? s.span,
      action: "skipped",
      reason_code: "NO_VALID_BEAT_IN_RANGE",
      threshold: {
        min_end_ms: s.min_allowed_ms,
        max_end_ms: s.max_timeline_ms,
        tolerance_ms: toleranceMs,
      },
      note: `'${s.clip_id}' klibinin geçerli süre aralığında (${s.min_allowed_ms}..${s.max_timeline_ms}ms) müzik vuruşu bulunamadı`,
    };
  });

  const allBeatDecisions = [...beatDecisions, ...beatNearMisses].sort(
    (a, b) => a.span[0] - b.span[0]
  );
  const byReason: Record<string, number> = {};
  for (const d of allBeatDecisions) {
    byReason[d.reason_code] = (byReason[d.reason_code] ?? 0) + 1;
  }

  const shiftedCount = aligned.filter((c) => c.shift_ms !== 0).length;
  const alreadyOnBeatCount = aligned.filter((c) => c.shift_ms === 0).length;
  const outOfTolCount = skippedTargetClips.filter((s) => s.reason_code === "OUT_OF_TOLERANCE").length;
  const summaryParts = [
    `${aligned.length}/${allBeatDecisions.length} klip '${options.bgmHandle}' ${alignMode === "grid" ? "vuruş ızgarasına" : "onset'lerine"} (${beatAnalysis.estimated_bpm} BPM, faz ${beatAnalysis.phase_ms ?? 0}ms, tolerans ±${toleranceMs}ms) hizalandı (${shiftedCount} kaydırıldı, ${alreadyOnBeatCount} zaten vuruşta)`,
  ];
  if (outOfTolCount > 0) {
    summaryParts.push(`${outOfTolCount} klip tolerans dışında kaldığı için korundu (OUT_OF_TOLERANCE)`);
  }
  if (durationWarning) {
    summaryParts.push(`UYARI: ${durationWarning}`);
  }

  const decisionTrace: DecisionTrace = {
    trace_id: `tr_beat_r${revision}`,
    feature: "beat_align",
    algorithm: { id: "beat.snap-nearest-tolerant", version: "2.2.0" },
    revision,
    params: {
      bgm_handle: { value: options.bgmHandle, default: options.bgmHandle, source: "user" },
      align_mode: {
        value: alignMode,
        default: "grid",
        source: options.alignTo !== undefined || options.useGrid !== undefined ? "user" : "default",
      },
      sensitivity: {
        value: options.sensitivity ?? 1.35,
        default: 1.35,
        source: options.sensitivity !== undefined ? "user" : "default",
      },
      tolerance_ms: {
        value: toleranceMs,
        default: defaultToleranceMs,
        unit: "ms",
        source: options.toleranceMs !== undefined ? "user" : "default",
      },
      preserve_duration: {
        value: preserveDuration,
        default: false,
        source: options.preserveDuration !== undefined ? "user" : "default",
      },
    },
    rules: [
      `R1: Her hedef klibin bitiş noktası yalnızca ±${toleranceMs}ms tolerans içindeki en yakın müzik vuruşuna (${alignMode === "grid" ? "grid_ms" : "onsets_ms"}) hizalanır`,
      "R2: En yakın vuruşu tolerans dışında kalan kliplere dokunulmaz ve OUT_OF_TOLERANCE olarak işaretlenir",
      "R3: Fiziksel kaynak süresi (probe.duration_ms) ve geçiş (transition_out) alt sınırları korunur",
    ],
    summary: {
      text: summaryParts.join("; "),
      candidates: allBeatDecisions.length,
      accepted: aligned.length,
      rejected: beatNearMisses.length,
      by_reason: byReason,
      effect: {
        aligned_count: aligned.length,
        shifted_count: shiftedCount,
        already_on_beat_count: alreadyOnBeatCount,
        skipped_count: beatNearMisses.length,
        tolerance_ms: toleranceMs,
        estimated_bpm: beatAnalysis.estimated_bpm,
        phase_ms: beatAnalysis.phase_ms ?? 0,
        old_total_duration_ms: oldTotalDurationMs,
        new_total_duration_ms: newTotalDurationMs,
        total_duration_delta_ms: totalDurationDeltaMs,
      },
    },
    decisions: allBeatDecisions,
    near_misses: beatNearMisses,
  };

  return {
    bgm_handle: options.bgmHandle,
    align_mode: alignMode,
    estimated_bpm: beatAnalysis.estimated_bpm,
    phase_ms: beatAnalysis.phase_ms ?? 0,
    tolerance_ms: toleranceMs,
    old_total_duration_ms: oldTotalDurationMs,
    new_total_duration_ms: newTotalDurationMs,
    total_duration_delta_ms: totalDurationDeltaMs,
    ...(durationWarning ? { duration_warning: durationWarning } : {}),
    aligned_clips: aligned,
    skipped_clips: skippedTargetClips.map((s) => ({
      clip_id: s.clip_id,
      duration_ms: s.duration_ms,
      nearest_beat_ms: s.nearest_beat_ms,
      distance_ms: s.distance_ms,
      reason_code: s.reason_code,
    })),
    decision_trace: decisionTrace,
    revision,
    verification,
  };
}
