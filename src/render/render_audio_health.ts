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
import { CutholSequence, getCuePlaybackRate, maxSourceDurationMs, SpeedRampPoint } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { resolveLibraryItemPath } from "../library/probe.js";
import { compileSequenceAudioPlan } from "../compositor/compile_audio.js";
import { integrateRampSourceOffsetToLocalMs, invertRampLocalMsToSourceOffset } from "../sequence/spine_time.js";
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
): { offsetMs: number; similarity: number; inconclusive: boolean } {
  const inconclusiveNone = { offsetMs: 0, similarity: 0, inconclusive: false };
  const winLen = refSignal.length;
  if (winLen < 32 || targetSignal.length < 32) {
    return inconclusiveNone;
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
    return inconclusiveNone;
  }

  const minLag = Math.max(-maxLagSamples, -targetCenterStartIdx);
  const maxLag = Math.min(maxLagSamples, targetSignal.length - winLen - targetCenterStartIdx);
  if (maxLag < minLag) {
    return inconclusiveNone;
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
  const coarsePairs: Array<{ lag: number; corr: number }> = [];
  for (let lag = minLag; lag <= maxLag; lag += coarseStep) {
    const c = evalLag(lag);
    coarsePairs.push({ lag, corr: c });
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

  // A perfectly periodic signal (pure sine) correlates almost equally well at
  // lags far from the peak, so no shift measurement is meaningful. Speech and
  // other aperiodic signals have no strong far rivals (pitch correlation
  // decays with distance), so the check stays conclusive for them.
  let inconclusive = false;
  if (bestCorr >= 0.5) {
    const farSamples = Math.round(0.15 * sampleRate);
    const rivalBar = 0.98 * bestCorr;
    for (const p of coarsePairs) {
      if (Math.abs(p.lag - bestLag) > farSamples && p.corr >= rivalBar) {
        inconclusive = true;
        break;
      }
    }
  }

  return {
    offsetMs: Number(((subLag * 1000) / sampleRate).toFixed(3)),
    similarity: Number(Math.max(-1, Math.min(1, bestCorr)).toFixed(4)),
    inconclusive,
  };
}

interface GapScanItem {
  id: string;
  absAssetPath: string;
  srcInMs: number;
  srcOutMs: number;
  effectiveRate: number;
  timelineStartMs: number;
  postTrimDurationMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  rampSpanMs?: number;
  rampFallbackRate?: number;
  ramp?: SpeedRampPoint[] | null;
}

/**
 * Output-gap scan: finds spans >= 3 ms where the render is (near-)silent and
 * reports the ones where a mapped source has clear signal. Spans over silent
 * sources, fade zones, or unmapped (muted/excised/past-end) regions never
 * count, so a hit means rendered audio was actually lost. Dense source spans
 * (noise, tone) flag directly; sparse spans (isolated transients) flag only
 * events missing from the output near their mapped instant, so WSOLA-shifted
 * but present events never count.
 */
function scanRenderedOutputGaps(options: {
  renderPcm: Float32Array;
  sampleRate: number;
  totalDurationMs: number;
  audioItems: GapScanItem[];
  paths: WorkspacePaths;
}): PostRenderAudioHealthResult["issues"] {
  const { renderPcm, sampleRate, totalDurationMs, audioItems, paths } = options;
  const issues: PostRenderAudioHealthResult["issues"] = [];
  const hop = Math.max(1, Math.round(sampleRate / 1000));
  const winCount = Math.min(
    Math.floor(renderPcm.length / hop),
    Math.max(0, Math.ceil(totalDurationMs))
  );
  if (audioItems.length === 0 || winCount < 3) return issues;

  const quietLin = Math.pow(10, -60 / 20);
  const quiet: boolean[] = new Array(winCount);
  for (let w = 0; w < winCount; w++) {
    let sumSq = 0;
    const base = w * hop;
    for (let i = base; i < base + hop; i++) sumSq += renderPcm[i] * renderPcm[i];
    quiet[w] = Math.sqrt(sumSq / hop) < quietLin;
  }
  interface GapSpan {
    startMs: number;
    endMs: number;
  }
  const gaps: GapSpan[] = [];
  let w = 0;
  while (w < winCount) {
    if (!quiet[w]) {
      w++;
      continue;
    }
    let e = w;
    while (e < winCount && quiet[e]) e++;
    if (e - w >= 3) gaps.push({ startMs: (w * hop * 1000) / sampleRate, endMs: (e * hop * 1000) / sampleRate });
    w = e;
  }
  if (gaps.length === 0) return issues;

  interface GapSourceJob {
    gap: GapSpan;
    item: GapScanItem;
    srcStartMs: number;
    srcEndMs: number;
  }
  const jobs: GapSourceJob[] = [];
  for (const gap of gaps) {
    const centerMs = (gap.startMs + gap.endMs) / 2;
    for (const item of audioItems) {
      const itemStart = item.timelineStartMs;
      const itemEnd = itemStart + item.postTrimDurationMs;
      if (gap.endMs <= itemStart || gap.startMs >= itemEnd) continue;
      // Fade zones ramp through silence by design; never count them.
      if (centerMs < itemStart + item.fadeInMs + 50) continue;
      if (centerMs > itemEnd - item.fadeOutMs - 50) continue;
      const localG0 = Math.max(0, Math.min(item.postTrimDurationMs, gap.startMs - itemStart));
      const localG1 = Math.max(0, Math.min(item.postTrimDurationMs, gap.endMs - itemStart));
      if (localG1 <= localG0) continue;
      const ramped = Boolean(item.ramp && item.ramp.length >= 2 && item.rampSpanMs && item.rampFallbackRate);
      const srcG0 = ramped
        ? item.srcInMs +
          invertRampLocalMsToSourceOffset(item.rampSpanMs as number, item.rampFallbackRate as number, item.ramp ?? null, localG0)
        : item.srcInMs + localG0 * item.effectiveRate;
      const srcG1 = ramped
        ? item.srcInMs +
          invertRampLocalMsToSourceOffset(item.rampSpanMs as number, item.rampFallbackRate as number, item.ramp ?? null, localG1)
        : item.srcInMs + localG1 * item.effectiveRate;
      if (!Number.isFinite(srcG0) || !Number.isFinite(srcG1)) continue;
      // Core mapped span only (no padding): a loud sample counts only if the
      // source instant it belongs to maps inside the quiet output span, so
      // inter-tick silence next to a loud tick never counts.
      const srcStartMs = Math.max(item.srcInMs, Math.min(srcG0, srcG1));
      const srcEndMs = Math.min(item.srcOutMs, Math.max(srcG0, srcG1));
      if (srcEndMs <= srcStartMs) continue;
      jobs.push({ gap, item, srcStartMs, srcEndMs });
    }
  }
  if (jobs.length === 0) return issues;

  const ffmpegJobs: ParallelFfmpegJob[] = jobs.map((j) => ({
    args: [
      "-v",
      "error",
      "-i",
      j.item.absAssetPath,
      "-vn",
      "-af",
      `atrim=start=${(j.srcStartMs / 1000).toFixed(6)}:end=${(j.srcEndMs / 1000).toFixed(6)},asetpts=PTS-STARTPTS,aresample=${sampleRate}`,
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "f32le",
      "pipe:1",
    ],
    cwd: paths.rootDir,
  }));
  const results = runParallelFfmpegJobsSync(
    ffmpegJobs,
    ffmpegJobs.map(() => 1024 * 1024),
    Math.max(2, Math.min(os.cpus().length, 6))
  );
  const loudLin = 0.02;
  const loudNeed = Math.ceil(0.003 * sampleRate);
  const outputRmsNear = (centerMs: number, halfMs: number): number => {
    const a = Math.max(0, Math.floor(((centerMs - halfMs) / 1000) * sampleRate));
    const b = Math.min(renderPcm.length, Math.ceil(((centerMs + halfMs) / 1000) * sampleRate));
    if (b <= a) return 0;
    let sumSq = 0;
    for (let k = a; k < b; k++) sumSq += renderPcm[k] * renderPcm[k];
    return Math.sqrt(sumSq / (b - a));
  };
  const flagged = new Set<string>();
  for (let i = 0; i < jobs.length; i++) {
    const res = results[i];
    if (!res || res.status !== 0 || res.stdout.byteLength < 64) continue;
    const pcm = new Float32Array(res.stdout.buffer, res.stdout.byteOffset, Math.floor(res.stdout.byteLength / 4));
    const j = jobs[i];
    // Dense spans (noise, tone): loud throughout while the output is quiet.
    let loud = 0;
    for (let k = 0; k < pcm.length; k++) {
      if (Math.abs(pcm[k]) > loudLin) loud++;
    }
    let flag = pcm.length > 0 && loud / pcm.length > 0.5;
    if (!flag && loud >= loudNeed) {
      // Sparse spans: cluster loud samples into events; an event counts only
      // when missing from the output near its mapped instant, so a WSOLA-
      // shifted but present event never counts.
      const mergeGap = Math.ceil(0.005 * sampleRate);
      const clusters: Array<{ start: number; end: number }> = [];
      let k = 0;
      while (k < pcm.length) {
        if (Math.abs(pcm[k]) <= loudLin) {
          k++;
          continue;
        }
        let e = k;
        while (e < pcm.length) {
          let n = e + 1;
          while (n < pcm.length && Math.abs(pcm[n]) <= loudLin) n++;
          if (n - e - 1 >= mergeGap || n >= pcm.length) break;
          e = n;
        }
        clusters.push({ start: k, end: Math.min(pcm.length, e + 1) });
        k = e + 1;
      }
      const itemStart = j.item.timelineStartMs;
      const rampedItem = Boolean(j.item.ramp && j.item.ramp.length >= 2 && j.item.rampSpanMs && j.item.rampFallbackRate);
      let unrendered = 0;
      for (const cluster of clusters) {
        const srcCenterMs = j.srcStartMs + (((cluster.start + cluster.end) / 2 / sampleRate) * 1000);
        const fwdMs = rampedItem
          ? itemStart +
            integrateRampSourceOffsetToLocalMs(
              j.item.rampSpanMs as number, j.item.rampFallbackRate as number, j.item.ramp ?? null, srcCenterMs - j.item.srcInMs
            )
          : itemStart + (srcCenterMs - j.item.srcInMs) / Math.max(1e-9, j.item.effectiveRate);
        if (!Number.isFinite(fwdMs) || outputRmsNear(fwdMs, 30) <= loudLin) {
          unrendered += cluster.end - cluster.start;
        }
      }
      flag = unrendered >= loudNeed;
    }
    if (!flag) continue;
    const key = `${j.item.id}@${Math.round(j.gap.startMs)}`;
    if (flagged.has(key)) continue;
    flagged.add(key);
    issues.push({
      item_id: j.item.id,
      check_at_ms: Math.round(((j.gap.startMs + j.gap.endMs) / 2) * 10) / 10,
      measured_offset_ms: 0,
      similarity: 0,
      detail: `silent gap ${Math.round(j.gap.startMs)}..${Math.round(j.gap.endMs)}ms in output while source has signal`,
    });
  }
  return issues;
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
    assetHandle: string;
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
    rampSpanMs?: number;
    rampFallbackRate?: number;
    ramp?: SpeedRampPoint[] | null;
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
        assetHandle: asset.handle,
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
        ramp: null,
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
      assetHandle: clip.asset_handle,
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
      rampSpanMs: Math.max(1, clip.source_out_ms - clip.source_in_ms),
      rampFallbackRate: clip.playback.rate,
      ramp: clip.playback.speed_ramp,
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

  // Decode the full rendered MP4 audio stream at 16 kHz mono f32le. The gap
  // detector below scans the whole render (slice-joint gaps can sit anywhere,
  // not just near correlation candidates), and full-decode sample alignment is
  // exact (no seek rounding).
  const renderBaseOffsetMs = 0;
  const renderReadSpanSec = Math.max(1, totalDurationMs / 1000);

  const renderAudioProc = spawnWatchedSync(
    "ffmpeg",
    [
      "-v",
      "error",
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

  // Reference audio per candidate. Unramped items keep the legacy single-rate
  // source decode. Ramped items get an exact reference: the candidate probe
  // window recompiled through the real audio compiler (same ramp integral map,
  // same slicer, same stretcher), with every other audio item muted so the
  // reference holds exactly this item's rendered contribution.
  const isRampedCandidate = (c: CheckCandidate): boolean =>
    Boolean(c.item.ramp && c.item.ramp.length >= 2);
  const renderRampedReference = (
    c: CheckCandidate
  ): { status: number; stdout: Buffer } | { skipped: string } => {
    let plan: { inputArgs: string[]; filterComplex: string; audioOutPad: string };
    try {
      const clone: CutholSequence = structuredClone(seq);
      for (const clip of clone.spine.clips) {
        if (clip.id !== c.item.id) clip.audio_chain.muted = true;
      }
      for (const lane of clone.lanes) {
        for (const cue of lane.cues) {
          if (cue.id !== c.item.id && cue.audio_chain) cue.audio_chain.muted = true;
        }
      }
      plan = compileSequenceAudioPlan(clone, paths, undefined, {
        activeWindowMs: [c.probeStartMs, c.probeEndMs],
        applyMasterFinalize: false,
      });
    } catch (err) {
      return { skipped: `reference compile failed (${err instanceof Error ? err.message : String(err)})` };
    }
    const spanSec = Math.max(0.5, (c.probeEndMs - c.probeStartMs) / 1000);
    const proc = spawnWatchedSync(
      "ffmpeg",
      [
        "-v",
        "error",
        ...plan.inputArgs,
        "-filter_complex",
        plan.filterComplex,
        "-map",
        plan.audioOutPad,
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
        maxBuffer: Math.ceil((spanSec + 5) * sampleRate * 4) + 1024 * 1024,
        step: "ffmpeg audio health ramp reference",
      }
    );
    if (proc.status !== 0 || !proc.stdout || (proc.stdout as Buffer).length < 256) {
      return { skipped: "reference render unavailable" };
    }
    return { status: 0, stdout: proc.stdout as Buffer };
  };

  const rampedRefByIdx = new Map<number, { status: number | null; stdout: Buffer }>();
  const skippedRampByIdx = new Map<number, string>();
  const legacyIdx: number[] = [];
  const sourceJobs: ParallelFfmpegJob[] = [];
  candidates.forEach((c, idx) => {
    if (!isRampedCandidate(c)) {
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

      legacyIdx.push(idx);
      sourceJobs.push({
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
      });
      return;
    }
    if (
      !c.item.rampSpanMs ||
      !c.item.rampFallbackRate ||
      !Number.isFinite(invertRampLocalMsToSourceOffset(
        c.item.rampSpanMs, c.item.rampFallbackRate, c.item.ramp ?? null, c.probeStartMs - c.item.timelineStartMs
      ))
    ) {
      skippedRampByIdx.set(idx, "ramp map unavailable");
      return;
    }
    const ref = renderRampedReference(c);
    if ("skipped" in ref) {
      skippedRampByIdx.set(idx, ref.skipped);
    } else {
      rampedRefByIdx.set(idx, ref);
    }
  });

  progressSet(0, candidates.length);
  progressWatch({ mode: "ffmpeg-jobs" });
  const legacyResults = runParallelFfmpegJobsSync(
    sourceJobs,
    sourceJobs.map(() => 4 * 1024 * 1024),
    Math.max(2, Math.min(os.cpus().length, 6))
  );
  const legacyByIdx = new Map<number, { status: number | null; stdout: Buffer }>();
  legacyIdx.forEach((idx, pos) => {
    const r = legacyResults[pos];
    if (r) legacyByIdx.set(idx, { status: r.status, stdout: r.stdout as Buffer });
  });

  const points: AudioHealthCheckPoint[] = [];
  const issues: PostRenderAudioHealthResult["issues"] = [];

  for (let idx = 0; idx < candidates.length; idx++) {
    const c = candidates[idx];
    const skippedReason = skippedRampByIdx.get(idx);
    if (skippedReason !== undefined) {
      points.push({
        item_id: c.item.id,
        segment_index: c.seg.index,
        check_at_ms: c.probeStartMs,
        window_ms: Math.max(0, c.probeEndMs - c.probeStartMs),
        measured_offset_ms: 0,
        similarity: 0,
        ok: true,
        detail: `skipped (ramp: ${skippedReason})`,
      });
      progressSet(idx + 1, candidates.length);
      continue;
    }
    const srRes = rampedRefByIdx.get(idx) ?? legacyByIdx.get(idx);
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
    const ncc = computeNormalizedCrossCorrelation(
      refSlice,
      renderPcm,
      renderCenterIdx,
      maxLagSamples,
      sampleRate
    );
    let { offsetMs, similarity } = ncc;
    const { inconclusive } = ncc;

    // A perfectly periodic signal (pure sine) matches almost equally well at
    // many lags: report inconclusive instead of alarming on a meaningless lag.
    if (inconclusive) {
      points.push({
        item_id: c.item.id,
        segment_index: c.seg.index,
        check_at_ms: Number(checkAtMs.toFixed(1)),
        window_ms: winMs,
        measured_offset_ms: offsetMs,
        similarity,
        ok: true,
        detail: "inconclusive (periodic signal: shift unmeasurable)",
      });
      progressSet(idx + 1, candidates.length);
      continue;
    }

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

  // Output-gap scan: spans >= 3 ms where the render is (near-)silent while a
  // mapped source has clear signal. Silent sources, fade zones and muted or
  // excised (unmapped) spans never count, so this only fires on lost audio.
  const gapIssues = scanRenderedOutputGaps({
    renderPcm,
    sampleRate,
    totalDurationMs,
    audioItems,
    paths,
  });
  issues.push(...gapIssues);

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
