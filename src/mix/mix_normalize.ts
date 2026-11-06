// Loudness normalization with master calibration, and voice polish (split out of audio_mix.ts).
import fs from "node:fs";
import path from "node:path";
import { spawnWatchedSync } from "../core/subprocess.js";
import { resolveCueStartMs } from "../core/timeline.js";
import { DecisionTrace, DecisionTraceItem } from "../core/decision_trace.js";
import {
  createSubprocessFailureDiagnostic,
  CutholError,
  DIAGNOSTICS,
  estimateCommandLineLength,
} from "../core/diagnostics.js";
import { createDefaultAudioChain, CutholSequence } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { loadSequence, WorkspacePaths } from "../core/workspace.js";
import { analyzeAssetLoudness } from "../library/loudness.js";
import { buildOrRenderSequenceAudioForMixOrRender } from "../render/renderer.js";
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
  adjusted_clips_count: number;
  skipped_muted_count?: number;
  adjusted_clips: Array<{
    id: string;
    integrated_lufs: number;
    applied_gain_db: number;
    effective_mix_gain_db: number;
  }>;
  adjusted_clips_omitted?: number;
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
  const audioBuild = buildOrRenderSequenceAudioForMixOrRender(seq, paths, overrideMasterAudio);
  if (!audioBuild.hasActiveAudio) {
    return { hasActiveAudio: false, integrated_lufs: -70.0, true_peak_dbtp: -70.0 };
  }

  const inputArgs =
    audioBuild.mode === "direct_plan"
      ? audioBuild.directPlan!.inputArgs
      : ["-f", "concat", "-safe", "0", "-i", audioBuild.concatListPath!];
  const baseFilter =
    audioBuild.mode === "direct_plan"
      ? audioBuild.directPlan!.filterComplex
      : audioBuild.masterFilterComplex!;
  const filterWithEbur = `${baseFilter};${audioBuild.audioOutPad}ebur128=peak=true[ebur_out]`;

  fs.mkdirSync(paths.blobsDir, { recursive: true });
  const filterScriptPath = path.join(
    paths.blobsDir,
    `ebur_${process.pid}_${Date.now()}.filter.txt`
  );
  const useScript =
    filterWithEbur.length > 4000 ||
    estimateCommandLineLength("ffmpeg", inputArgs) + filterWithEbur.length > 12000;
  if (useScript) {
    fs.writeFileSync(filterScriptPath, filterWithEbur, "utf8");
  }

  const ffArgs = [
    "-nostats",
    "-v",
    "info",
    ...inputArgs,
    ...(useScript
      ? ["-/filter_complex", filterScriptPath]
      : ["-filter_complex", filterWithEbur]),
    "-map",
    "[ebur_out]",
    "-t",
    (audioBuild.totalDurationMs / 1000).toFixed(3),
    "-f",
    "null",
    "-",
  ];

  let proc;
  try {
    proc = spawnWatchedSync("ffmpeg", ffArgs, {
      cwd: paths.rootDir,
      encoding: "utf8",
      // ebur128 logs ~10 lines per second of audio and runs over the whole mix: no wall-clock limit.
      maxBuffer: 256 * 1024 * 1024,
      step: "ffmpeg mix loudness",
    });
  } finally {
    if (fs.existsSync(filterScriptPath)) {
      try {
        fs.unlinkSync(filterScriptPath);
      } catch {
        // ignore
      }
    }
  }

  if (proc.error || proc.status !== 0) {
    throw new CutholError(
      createSubprocessFailureDiagnostic({
        tool: "ffmpeg mix loudness",
        executable: "ffmpeg",
        args: ffArgs,
        proc,
        clipCount: seq.spine.clips.length,
        fallbackDetail: "loudness measurement failed",
      })
    );
  }

  const stderr = `${proc.stderr || ""}\n${proc.stdout || ""}`;
  const parsed = parseEbur128MixSummary(stderr);
  return {
    hasActiveAudio: true,
    integrated_lufs: parsed.integrated_lufs,
    true_peak_dbtp: parsed.true_peak_dbtp,
  };
}

export function calibrateSequenceMasterAudio(
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
  detailed?: boolean;
  maxListedClips?: number;
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
    if (clip.audio_chain.muted) continue;
    ensureLoudnessForAsset(clip.asset_handle);
  }
  for (const lane of initialSeq.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (cue.audio_chain?.muted) continue;
      const includeCue = targetSet ? targetSet.has(cue.id) : lane.id === "ln_vo" || cue.kind === "voiceover";
      if (!includeCue) continue;
      ensureLoudnessForAsset(cue.asset_handle);
    }
  }
  const fallbackToAllAudioCues = !targetSet && loudnessByAsset.size === 0;
  if (fallbackToAllAudioCues) {
    for (const lane of initialSeq.lanes) {
      if (lane.muted) continue;
      for (const cue of lane.cues) {
        if (cue.audio_chain?.muted) continue;
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
      let skippedMutedCount = 0;
      const libMap = new Map(seq.library.map((x) => [x.handle, x]));
      for (const clip of seq.spine.clips) {
        if (targetSet && !targetSet.has(clip.id)) continue;
        if (clip.audio_chain.muted) {
          const asset = libMap.get(clip.asset_handle);
          if (!asset || asset.probe.has_audio) {
            skippedMutedCount++;
          }
          continue;
        }
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
          if (lane.muted || cue.audio_chain?.muted) {
            const asset = libMap.get(cue.asset_handle);
            if (!asset || asset.probe.has_audio) {
              skippedMutedCount++;
            }
            continue;
          }
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
      return { list, cal, skippedMutedCount };
    }
  );

  const adjusted = mutRes.list;
  const skippedMutedCount = mutRes.skippedMutedCount;
  const { before: mixBefore, after: mixAfter, masterGainDb, targetReached } = mutRes.cal;
  const warningMsg = !targetReached
    ? `Target loudness (${targetLufs} LUFS) not fully reached: final measured mix ${mixAfter.integrated_lufs} LUFS (true peak ${mixAfter.true_peak_dbtp} dBTP, ceiling ${truePeakDbtp} dBTP).`
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
      ? `Main audio mix calibrated from ${mixBefore.integrated_lufs} LUFS to ${mixAfter.integrated_lufs} LUFS (peak ${mixAfter.true_peak_dbtp} dBTP, master gain ${masterGainDb >= 0 ? "+" : ""}${masterGainDb} dB)`
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
      "R1: ITU-R BS.1770-4 Integrated LUFS and True Peak (dBTP) are measured per clip/voiceover and a pre-gain is assigned",
      "R2: The compiled full-sequence audio mix (amix + envelopes + filters + alimiter) is measured with ebur128=peak=true and the master bus gain is calibrated to the target LUFS in a closed loop",
    ],
    summary: {
      text: targetReached
        ? `${adjusted.length} audio items and the main mix normalized: ${mixBefore.integrated_lufs} LUFS -> ${mixAfter.integrated_lufs} LUFS (target ${targetLufs} LUFS, true peak ${mixAfter.true_peak_dbtp} dBTP, master gain ${masterGainDb >= 0 ? "+" : ""}${masterGainDb} dB)`
        : `WARNING: ${warningMsg}`,
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

  const maxListed = Math.max(1, options.maxListedClips ?? 8);
  const returnedClips = options.detailed ? adjusted : adjusted.slice(0, maxListed);
  const omittedCount = Math.max(0, adjusted.length - returnedClips.length);

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
    adjusted_clips_count: adjusted.length,
    ...(skippedMutedCount > 0 ? { skipped_muted_count: skippedMutedCount } : {}),
    adjusted_clips: returnedClips,
    ...(omittedCount > 0 ? { adjusted_clips_omitted: omittedCount } : {}),
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
