// Post-render audio health check against the source audio (split out of renderer.ts).
import os from "node:os";
import { progressBegin, progressFinish, progressSet, progressWatch } from "../core/progress.js";
import {
  type ParallelFfmpegJob, spawnWatchedSync
} from "../core/subprocess.js";
import {
  computeRenderDurationMs, resolveCueStartMs
} from "../core/timeline.js";
import {
  CutholDiagnostic, DIAGNOSTICS
} from "../core/diagnostics.js";
import {
  resolveMaxClipsPerRenderSegment
} from "../core/env.js";
import { CutholSequence, getCuePlaybackRate, maxSourceDurationMs } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { resolveLibraryItemPath } from "../library/probe.js";
import { runParallelFfmpegJobsSync } from "./render_frames.js";
import { computeRenderTimeSegments, RenderTimeSegment } from "./render_segments.js";

export interface AudioHealthCheckPoint {
  item_id: string;
  segment_index: number;
  check_at_ms: number;
  window_ms: number;
  measured_offset_ms: number;
  similarity: number;
  ok: boolean;
  detail?: string;
}

export interface PostRenderAudioHealthResult {
  checked_points: number;
  scan_duration_ms: number;
  points: AudioHealthCheckPoint[];
  issues: Array<{
    item_id: string;
    check_at_ms: number;
    measured_offset_ms: number;
    similarity: number;
    detail: string;
  }>;
  diagnostics: CutholDiagnostic[];
}

function buildHealthCheckAtempoChain(rate: number): string[] {
  const filters: string[] = [];
  let r = Math.max(0.1, Math.min(16.0, rate));
  while (r > 2.0) {
    filters.push("atempo=2.0");
    r /= 2.0;
  }
  while (r < 0.5) {
    filters.push("atempo=0.5");
    r /= 0.5;
  }
  if (Math.abs(r - 1.0) > 0.001) {
    filters.push(`atempo=${r.toFixed(4)}`);
  }
  return filters;
}

function computeNormalizedCrossCorrelation(
  refSignal: Float32Array,
  targetSignal: Float32Array,
  targetCenterStartIdx: number,
  maxLagSamples: number,
  sampleRate: number
): { offsetMs: number; similarity: number } {
  const winLen = refSignal.length;
  if (winLen < 32 || targetSignal.length < 32) {
    return { offsetMs: 0, similarity: 0 };
  }

  let refMean = 0;
  for (let i = 0; i < winLen; i++) refMean += refSignal[i];
  refMean /= winLen;

  let refEnergy = 0;
  for (let i = 0; i < winLen; i++) {
    const v = refSignal[i] - refMean;
    refEnergy += v * v;
  }
  if (refEnergy < 1e-9) {
    return { offsetMs: 0, similarity: 0 };
  }

  const minLag = Math.max(-maxLagSamples, -targetCenterStartIdx);
  const maxLag = Math.min(maxLagSamples, targetSignal.length - winLen - targetCenterStartIdx);
  if (maxLag < minLag) {
    return { offsetMs: 0, similarity: 0 };
  }

  // Coarse search with step=4 samples, then fine search ±6 samples around coarse peak
  const evalLag = (lag: number): number => {
    const base = targetCenterStartIdx + lag;
    let sumRef = 0;
    let sumTgt = 0;
    let sumRefSq = 0;
    let sumTgtSq = 0;
    let sumProd = 0;
    const stride = winLen > 4000 ? 2 : 1;
    let count = 0;
    for (let i = 0; i < winLen; i += stride) {
      const r = refSignal[i];
      const t = targetSignal[base + i];
      sumRef += r;
      sumTgt += t;
      sumRefSq += r * r;
      sumTgtSq += t * t;
      sumProd += r * t;
      count++;
    }
    if (count < 8) return 0;
    const cov = sumProd - (sumRef * sumTgt) / count;
    const varR = Math.max(0, sumRefSq - (sumRef * sumRef) / count);
    const varT = Math.max(0, sumTgtSq - (sumTgt * sumTgt) / count);
    const denom = Math.sqrt(varR * varT);
    return denom > 1e-9 ? cov / denom : 0;
  };

  let bestLag = 0;
  let bestCorr = -2;
  const coarseStep = 4;
  for (let lag = minLag; lag <= maxLag; lag += coarseStep) {
    const c = evalLag(lag);
    if (c > bestCorr) {
      bestCorr = c;
      bestLag = lag;
    }
  }
  // Always evaluate lag=0 explicitly
  if (0 >= minLag && 0 <= maxLag) {
    const c0 = evalLag(0);
    if (c0 > bestCorr) {
      bestCorr = c0;
      bestLag = 0;
    }
  }

  const fineStart = Math.max(minLag, bestLag - coarseStep * 2);
  const fineEnd = Math.min(maxLag, bestLag + coarseStep * 2);
  const fineScores = new Map<number, number>();
  for (let lag = fineStart; lag <= fineEnd; lag++) {
    const c = evalLag(lag);
    fineScores.set(lag, c);
    if (c > bestCorr) {
      bestCorr = c;
      bestLag = lag;
    }
  }

  // Parabolic interpolation for sub-sample precision
  let subLag = bestLag;
  const cPrev = fineScores.get(bestLag - 1);
  const cCurr = fineScores.get(bestLag);
  const cNext = fineScores.get(bestLag + 1);
  if (cPrev !== undefined && cCurr !== undefined && cNext !== undefined) {
    const denom = cPrev - 2 * cCurr + cNext;
    if (Math.abs(denom) > 1e-9) {
      const delta = Math.max(-0.5, Math.min(0.5, (0.5 * (cPrev - cNext)) / denom));
      subLag = bestLag + delta;
    }
  }

  return {
    offsetMs: Number(((subLag * 1000) / sampleRate).toFixed(3)),
    similarity: Number(Math.max(-1, Math.min(1, bestCorr)).toFixed(4)),
  };
}

/**
 * Post-render audio health check: verifies that audio items (especially cues crossing segment boundaries
 * or delayed within a segment) are present at their expected timeline positions in the rendered MP4
 * via normalized cross-correlation against their source audio.
 */
export function scanRenderedMp4AudioHealth(
  mp4Path: string,
  seq: CutholSequence,
  paths: WorkspacePaths,
  options?: { maxItemsPerSegment?: number }
): PostRenderAudioHealthResult {
  progressBegin("audio health", 1);
  try {
  const t0 = Date.now();
  const sampleRate = 16000;
  const totalDurationMs = computeRenderDurationMs(seq);
  const libMap = new Map(seq.library.map((item) => [item.handle, item]));

  interface ActiveAudioItemInfo {
    id: string;
    kind: "spine" | "voiceover" | "music" | "sfx" | "broll";
    absAssetPath: string;
    srcInMs: number;
    srcOutMs: number;
    effectiveRate: number;
    preservePitch?: boolean;
    sampleRate?: number | null;
    timelineStartMs: number;
    postTrimDurationMs: number;
    fadeInMs: number;
    fadeOutMs: number;
  }

  const audioItems: ActiveAudioItemInfo[] = [];

  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (!cue.asset_handle) continue;
      const asset = libMap.get(cue.asset_handle);
      if (
        !asset ||
        !asset.probe.has_audio ||
        cue.audio_chain?.muted ||
        !(cue.kind === "music" || cue.kind === "sfx" || cue.kind === "voiceover" || cue.kind === "broll")
      ) {
        continue;
      }
      const cueStartMs = resolveCueStartMs(seq, cue);
      const absAssetPath = resolveLibraryItemPath(paths.rootDir, asset);
      const cueRate = getCuePlaybackRate(cue);
      const srcInMs = cue.source_in_ms ?? 0;
      const maxOutByDuration =
        cueRate === 1.0
          ? srcInMs + cue.duration_ms
          : srcInMs + Math.round(cue.duration_ms * cueRate);
      const requestedOut = cue.source_out_ms ?? maxOutByDuration;
      const srcOutMs = Math.min(maxSourceDurationMs(asset), requestedOut, maxOutByDuration);
      const effectiveRate = Math.max(0.1, Math.min(16.0, cueRate));
      const postTrimDurationMs =
        cueRate === 1.0 ? Math.max(0, srcOutMs - srcInMs) : cue.duration_ms;
      if (postTrimDurationMs < 250) continue;

      audioItems.push({
        id: cue.id,
        kind: cue.kind,
        absAssetPath,
        srcInMs,
        srcOutMs,
        effectiveRate,
        preservePitch: cue.playback?.preserve_pitch,
        sampleRate: asset.probe.sample_rate,
        timelineStartMs: cueStartMs,
        postTrimDurationMs,
        fadeInMs: cue.audio_chain?.fade_in_ms ?? 0,
        fadeOutMs: cue.audio_chain?.fade_out_ms ?? 0,
      });
    }
  }

  for (const clip of seq.spine.clips) {
    const asset = libMap.get(clip.asset_handle);
    if (!asset || !asset.probe.has_audio || clip.audio_chain.muted) continue;
    if (clip.duration_ms < 250) continue;
    const absAssetPath = resolveLibraryItemPath(paths.rootDir, asset);
    const effectiveRate = Math.max(
      0.1,
      Math.min(16.0, (clip.source_out_ms - clip.source_in_ms) / Math.max(1, clip.duration_ms))
    );
    audioItems.push({
      id: clip.id,
      kind: "spine",
      absAssetPath,
      srcInMs: clip.source_in_ms,
      srcOutMs: clip.source_out_ms,
      effectiveRate,
      preservePitch: clip.playback.preserve_pitch,
      sampleRate: asset.probe.sample_rate,
      timelineStartMs: clip.timeline_in_ms,
      postTrimDurationMs: clip.duration_ms,
      fadeInMs: clip.audio_chain.fade_in_ms,
      fadeOutMs: clip.audio_chain.fade_out_ms,
    });
  }

  if (audioItems.length === 0) {
    return {
      checked_points: 0,
      scan_duration_ms: Date.now() - t0,
      points: [],
      issues: [],
      diagnostics: [],
    };
  }

  const maxItemsPerSegment = options?.maxItemsPerSegment ?? resolveMaxClipsPerRenderSegment();
  const segments = computeRenderTimeSegments(seq, totalDurationMs, maxItemsPerSegment);

  interface CheckCandidate {
    item: ActiveAudioItemInfo;
    seg: RenderTimeSegment;
    probeStartMs: number;
    probeEndMs: number;
    crossesBoundary: boolean;
  }

  const candidates: CheckCandidate[] = [];
  const seenKeys = new Set<string>();
  const addCandidate = (
    item: ActiveAudioItemInfo,
    seg: RenderTimeSegment,
    probeStartMs: number,
    probeEndMs: number,
    crossesBoundary: boolean
  ): void => {
    const st = Math.max(0, Math.round(probeStartMs));
    const en = Math.min(totalDurationMs, Math.round(probeEndMs));
    if (en - st < 250) return;
    const key = `${item.id}:${seg.index}:${st}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    candidates.push({ item, seg, probeStartMs: st, probeEndMs: en, crossesBoundary });
  };

  for (const seg of segments) {
    for (const item of audioItems) {
      const itemStart = item.timelineStartMs;
      const itemEnd = itemStart + item.postTrimDurationMs;
      const ovStart = Math.max(seg.startMs, itemStart);
      const ovEnd = Math.min(seg.endMs, itemEnd);
      if (ovEnd - ovStart < 250) continue;

      const crossesEnd = itemEnd > seg.endMs + 10 && seg.endMs < totalDurationMs - 10;
      const crossesStart = itemStart < seg.startMs - 10 && seg.startMs > 10;

      if (crossesEnd || crossesStart) {
        if (itemStart >= seg.startMs - 1 && crossesEnd) {
          // Starts inside this segment and extends past segment end (the exact adelay+atrim risk pattern)
          addCandidate(item, seg, ovStart, Math.min(ovEnd, ovStart + 6000), true);
          if (ovEnd - ovStart > 6500) {
            addCandidate(item, seg, Math.max(ovStart, ovEnd - 4000), ovEnd, true);
          }
        } else if (crossesStart) {
          // Continues from previous segment across the boundary
          addCandidate(item, seg, ovStart, Math.min(ovEnd, ovStart + 5000), true);
        }
      }
    }
  }

  // Also sample primary dialogue/voiceover/music items if few boundary-crossing candidates exist
  if (candidates.length < 4) {
    const primaryItems = audioItems
      .filter((it) => it.kind === "voiceover" || it.kind === "spine" || it.kind === "music")
      .sort((a, b) => b.postTrimDurationMs - a.postTrimDurationMs)
      .slice(0, 4);
    for (const item of primaryItems) {
      const itemStart = item.timelineStartMs;
      const itemEnd = itemStart + item.postTrimDurationMs;
      const seg =
        segments.find((s) => itemStart >= s.startMs - 1 && itemStart < s.endMs + 1) ?? segments[0];
      const ovStart = Math.max(seg.startMs, itemStart);
      const ovEnd = Math.min(seg.endMs, itemEnd);
      if (ovEnd - ovStart >= 300) {
        addCandidate(item, seg, ovStart, Math.min(ovEnd, ovStart + 5000), false);
      }
    }
  }

  if (candidates.length === 0) {
    return {
      checked_points: 0,
      scan_duration_ms: Date.now() - t0,
      points: [],
      issues: [],
      diagnostics: [],
    };
  }

  // Decode rendered MP4 audio stream at 16 kHz mono f32le (bounded to target window span)
  const minCheckMs = Math.max(0, Math.min(...candidates.map((c) => c.seg.startMs)) - 1000);
  const maxCheckMs = Math.min(
    totalDurationMs,
    Math.max(...candidates.map((c) => c.probeEndMs)) + 1500
  );
  const renderReadSpanSec = Math.max(1, (maxCheckMs - minCheckMs) / 1000);
  const renderSeekArgs =
    minCheckMs >= 5000 ? ["-ss", (minCheckMs / 1000).toFixed(3)] : [];
  const renderBaseOffsetMs = minCheckMs >= 5000 ? Number((minCheckMs / 1000).toFixed(3)) * 1000 : 0;

  const renderAudioProc = spawnWatchedSync(
    "ffmpeg",
    [
      "-v",
      "error",
      ...renderSeekArgs,
      "-t",
      (renderReadSpanSec + 2).toFixed(3),
      "-i",
      mp4Path,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "f32le",
      "pipe:1",
    ],
    {
      cwd: paths.rootDir,
      maxBuffer: Math.ceil((renderReadSpanSec + 5) * sampleRate * 4) + 4 * 1024 * 1024,
      step: "ffmpeg audio health scan",
    }
  );
  if (renderAudioProc.status !== 0 || !renderAudioProc.stdout || renderAudioProc.stdout.length < 128) {
    return {
      checked_points: 0,
      scan_duration_ms: Date.now() - t0,
      points: [],
      issues: [],
      diagnostics: [],
    };
  }
  const renderBuf = renderAudioProc.stdout as Buffer;
  const renderPcm = new Float32Array(
    renderBuf.buffer,
    renderBuf.byteOffset,
    Math.floor(renderBuf.byteLength / 4)
  );

  // Decode each candidate's source audio slice in parallel
  const sourceJobs: ParallelFfmpegJob[] = candidates.map((c) => {
    const localStartMs = Math.max(0, c.probeStartMs - c.item.timelineStartMs);
    const localEndMs = Math.min(
      c.item.postTrimDurationMs,
      c.probeEndMs - c.item.timelineStartMs
    );
    const srcStartMs = c.item.srcInMs + localStartMs * c.item.effectiveRate;
    const srcEndMs = Math.min(
      c.item.srcOutMs,
      c.item.srcInMs + localEndMs * c.item.effectiveRate + 100
    );
    const seekSec = srcStartMs >= 3000 ? Math.floor((srcStartMs - 1000) / 1000) : 0;
    const relStartSec = Math.max(0, srcStartMs / 1000 - seekSec).toFixed(6);
    const relEndSec = Math.max(0.01, srcEndMs / 1000 - seekSec).toFixed(6);
    const rateFilters =
      c.item.preservePitch === false && Math.abs(c.item.effectiveRate - 1.0) > 0.001
        ? (() => {
            const sr = c.item.sampleRate && c.item.sampleRate > 0 ? c.item.sampleRate : 48000;
            const pitched = Math.max(4000, Math.min(384000, Math.round(sr * c.item.effectiveRate)));
            return [`asetrate=${pitched}`, `aresample=${sr}`, `asetpts=PTS-STARTPTS`];
          })()
        : buildHealthCheckAtempoChain(c.item.effectiveRate);
    const af = [
      `atrim=start=${relStartSec}:end=${relEndSec}`,
      `asetpts=PTS-STARTPTS`,
      ...rateFilters,
      `aresample=${sampleRate}`,
    ].join(",");

    return {
      args: [
        "-v",
        "error",
        ...(seekSec > 0 ? ["-ss", String(seekSec)] : []),
        "-t",
        String(Math.ceil((srcEndMs - seekSec * 1000) / 1000 + 2)),
        "-i",
        c.item.absAssetPath,
        "-vn",
        "-af",
        af,
        "-ac",
        "1",
        "-ar",
        String(sampleRate),
        "-f",
        "f32le",
        "pipe:1",
      ],
      cwd: paths.rootDir,
    };
  });

  progressSet(0, candidates.length);
  progressWatch({ mode: "ffmpeg-jobs" });
  const sourceResults = runParallelFfmpegJobsSync(
    sourceJobs,
    candidates.map(() => 4 * 1024 * 1024),
    Math.max(2, Math.min(os.cpus().length, 6))
  );

  const points: AudioHealthCheckPoint[] = [];
  const issues: PostRenderAudioHealthResult["issues"] = [];

  for (let idx = 0; idx < candidates.length; idx++) {
    const c = candidates[idx];
    const srRes = sourceResults[idx];
    if (!srRes || srRes.status !== 0 || srRes.stdout.byteLength < 256) {
      progressSet(idx + 1, candidates.length);
      continue;
    }

    const srcPcm = new Float32Array(
      srRes.stdout.buffer,
      srRes.stdout.byteOffset,
      Math.floor(srRes.stdout.byteLength / 4)
    );
    const probeSamples = srcPcm.length;
    const winMs = Math.min(
      1200,
      Math.max(250, Math.floor((probeSamples * 1000) / sampleRate) - 40)
    );
    const winSamples = Math.max(64, Math.round((winMs / 1000) * sampleRate));
    if (probeSamples < winSamples) continue;

    // Pick the highest-energy (non-silent, non-fade-edge) sub-window in srcPcm
    const stepSamples = Math.max(16, Math.floor(sampleRate * 0.05));
    let bestOffsetSamples = 0;
    let bestRms = 0;
    for (let s = 0; s + winSamples <= probeSamples; s += stepSamples) {
      const localAtMs = c.probeStartMs - c.item.timelineStartMs + (s * 1000) / sampleRate;
      if (c.item.fadeInMs > 0 && localAtMs < c.item.fadeInMs * 0.5) continue;
      if (
        c.item.fadeOutMs > 0 &&
        localAtMs + winMs > c.item.postTrimDurationMs - c.item.fadeOutMs * 0.5
      ) {
        continue;
      }
      let sumSq = 0;
      for (let k = 0; k < winSamples; k += 2) {
        const v = srcPcm[s + k];
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / Math.ceil(winSamples / 2));
      if (rms > bestRms) {
        bestRms = rms;
        bestOffsetSamples = s;
      }
    }

    if (bestRms < 0.002) {
      // Source region is near-silent; skip correlation
      continue;
    }

    const refSlice = srcPcm.subarray(bestOffsetSamples, bestOffsetSamples + winSamples);
    const checkAtMs = c.probeStartMs + (bestOffsetSamples * 1000) / sampleRate;
    const renderCenterIdx = Math.round(((checkAtMs - renderBaseOffsetMs) / 1000) * sampleRate);
    if (renderCenterIdx < 0 || renderCenterIdx + winSamples > renderPcm.length) continue;

    const maxLagSamples = Math.round(0.45 * sampleRate); // ±450 ms search window
    let { offsetMs, similarity } = computeNormalizedCrossCorrelation(
      refSlice,
      renderPcm,
      renderCenterIdx,
      maxLagSamples,
      sampleRate
    );

    let ok = similarity >= 0.52 && Math.abs(offsetMs) <= 20;
    let detail: string | undefined;

    if (!ok) {
      // Check if an in-segment delayed cue lost its adelay and shifted to the start of the segment
      if (c.item.timelineStartMs > c.seg.startMs + 25) {
        const shiftedAtMs = c.seg.startMs + (checkAtMs - c.item.timelineStartMs);
        const shiftedCenterIdx = Math.round(
          ((shiftedAtMs - renderBaseOffsetMs) / 1000) * sampleRate
        );
        if (shiftedCenterIdx >= 0 && shiftedCenterIdx + winSamples <= renderPcm.length) {
          const earlyMatch = computeNormalizedCrossCorrelation(
            refSlice,
            renderPcm,
            shiftedCenterIdx,
            Math.round(0.25 * sampleRate),
            sampleRate
          );
          if (earlyMatch.similarity >= 0.52 && earlyMatch.similarity > similarity + 0.15) {
            offsetMs = Number(
              (shiftedAtMs + earlyMatch.offsetMs - checkAtMs).toFixed(2)
            );
            similarity = earlyMatch.similarity;
            ok = false;
            detail = `in-segment delay lost, audio drifted to the segment head (${Math.round(c.seg.startMs)}ms)`;
          }
        }
      }

      if (!detail) {
        // Measure rendered RMS in the expected window to distinguish silence vs multi-track masking
        let renderSumSq = 0;
        for (let k = 0; k < winSamples; k++) {
          const v = renderPcm[renderCenterIdx + k];
          renderSumSq += v * v;
        }
        const renderRms = Math.sqrt(renderSumSq / winSamples);
        const overlappingOtherItems = audioItems.filter(
          (other) =>
            other.id !== c.item.id &&
            other.timelineStartMs < checkAtMs + winMs &&
            other.timelineStartMs + other.postTrimDurationMs > checkAtMs
        );

        if (renderRms < Math.min(0.0005, bestRms * 0.08)) {
          ok = false;
          detail = "no signal in the expected audio window (digital silence)";
        } else if (similarity >= 0.52 && Math.abs(offsetMs) > 20) {
          ok = false;
          detail = `large time offset vs the source (${offsetMs >= 0 ? "+" : ""}${offsetMs.toFixed(1)}ms)`;
        } else if (overlappingOtherItems.length > 0 && renderRms >= bestRms * 0.15) {
          // Another active track (e.g. loud dialogue over ducked BGM or loud SFX) masks single-track NCC
          ok = true;
        } else {
          ok = false;
          detail = `low correlation vs the source (similarity=${similarity.toFixed(2)})`;
        }
      }
    }

    const pt: AudioHealthCheckPoint = {
      item_id: c.item.id,
      segment_index: c.seg.index,
      check_at_ms: Number(checkAtMs.toFixed(1)),
      window_ms: winMs,
      measured_offset_ms: offsetMs,
      similarity,
      ok,
      ...(detail ? { detail } : {}),
    };
    points.push(pt);
    if (!ok && detail) {
      issues.push({
        item_id: c.item.id,
        check_at_ms: pt.check_at_ms,
        measured_offset_ms: offsetMs,
        similarity,
        detail,
      });
    }
    progressSet(idx + 1, candidates.length);
  }

  const diagnostics: CutholDiagnostic[] =
    issues.length > 0 ? [DIAGNOSTICS.RENDER_AUDIO_ALIGNMENT_MISMATCH(issues)] : [];

  return {
    checked_points: points.length,
    scan_duration_ms: Date.now() - t0,
    points,
    issues,
    diagnostics,
  };
  } finally {
    progressFinish("audio health");
  }
}
