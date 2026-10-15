/**
 * Visual Subject & Speaker Face Tracking Engine (`src/library/subject.ts`).
 *
 * Determines the horizontal (`center_x_pct`) and vertical (`center_y_pct`) position
 * of the primary visual subject (typically a speaking person or foreground object)
 * over time using a deterministic, zero-dependency multi-cue signal pipeline:
 *
 * 1. Low-resolution RGB24 frame stream extraction via FFmpeg (`160px` width @ `4 fps`).
 * 2. Temporal background & pixel-activity modeling (`temporalStd`) to suppress static
 *    background clutter (such as furniture or equipment in the room) while avoiding
 *    temporal-mean ghosting via multiplicative border-background contrast (`distBg * actWeight`).
 * 3. Multi-cue candidate channels:
 *    - `face_skin`: ITU-R BT.601 YCbCr + RGB chrominance skin-cluster detector with
 *      contiguous peak-window bounds and upper-cranial (`0.10H .. 0.42H`) hair/head
 *      silhouette symmetry expansion.
 *    - `foreground_motion`: Moving foreground object detector for non-human / synthetic subjects.
 *    - `static_saliency`: Border-contrast visual saliency fallback for stationary non-face subjects.
 * 4. Calm camera trajectory planner (`planCalmReframeTrajectory`):
 *    - 3-point median spike removal + zero-phase Gaussian smoothing.
 *    - Hysteresis deadband & plateau locking so the crop stays rock-solid when the
 *      speaker is stationary, and pans with `ease_in_out` ramps when they shift.
 *    - Aspect-ratio and static-clip guards so 16:9 projects and stationary centered clips
 *      produce zero unnecessary pan keyframes.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { ParameterEnvelopePoint, SpineClip } from "../core/schema.js";
import { loadSequence, updateSequenceInPlace } from "../core/workspace.js";
import { resolveLibraryItemPath } from "./probe.js";

export type SubjectDetectionMethod =
  | "face_skin"
  | "foreground_motion"
  | "static_saliency"
  | "manual_override";

export interface SubjectSamplePoint {
  source_ms: number;
  center_x_pct: number;
  center_y_pct: number;
  left_x_pct: number;
  right_x_pct: number;
  confidence: number;
}

export interface SubjectTrackAnalysis {
  handle: string;
  sha256: string;
  duration_ms: number;
  sample_fps: number;
  detection_method: SubjectDetectionMethod;
  mean_confidence: number;
  min_confidence: number;
  subject_spread_x_pct: number;
  mean_center_x_pct: number;
  samples: SubjectSamplePoint[];
}

export interface ReframeFocalPoint {
  offset_ms: number;
  source_ms: number;
  center_x_pct: number;
  center_y_pct: number;
  x_pct: number;
  confidence: number;
}

export interface PlannedClipReframe {
  clip_id: string;
  asset_handle: string;
  mode: "subject_track" | "center_lock" | "off";
  detection_method: SubjectDetectionMethod;
  applied_pan: boolean;
  horizontal_pan_available: boolean;
  scale_x: number;
  scale_y: number;
  static_x_pct: number;
  max_pan_x_pct: number;
  mean_confidence: number;
  min_confidence: number;
  low_confidence_ranges_ms: Array<{ start_ms: number; end_ms: number; min_confidence: number }>;
  subject_spread_x_pct: number;
  focal_points: ReframeFocalPoint[];
  envelope_points: ParameterEnvelopePoint[];
}

function computeSkinProbability(r: number, g: number, b: number): number {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (y < 40 || y > 240) return 0;
  if (r <= g || g < b * 0.82 || r - g < 6 || r - b < 12) return 0;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const dCb = (cb - 108) / 15;
  const dCr = (cr - 150) / 15;
  const d2 = dCb * dCb + dCr * dCr;
  if (d2 > 5.0) return 0;
  return Math.exp(-0.5 * d2);
}

function estimateFrameBorderBackground(
  buf: Buffer,
  frameOffset: number,
  w: number,
  h: number,
  forFaceBand: boolean
): { r: number; g: number; b: number } {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;

  if (forFaceBand) {
    const yMax = Math.max(2, Math.floor(h * 0.08));
    const xStart = Math.floor(w * 0.25);
    const xEnd = Math.floor(w * 0.85);
    for (let y = 1; y < yMax; y++) {
      for (let x = xStart; x < xEnd; x++) {
        const idx = frameOffset + (y * w + x) * 3;
        sumR += buf[idx];
        sumG += buf[idx + 1];
        sumB += buf[idx + 2];
        count++;
      }
    }
  } else {
    const padX = Math.max(2, Math.floor(w * 0.05));
    const padY = Math.max(2, Math.floor(h * 0.06));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < padX || x >= w - padX || y < padY || y >= h - padY) {
          const idx = frameOffset + (y * w + x) * 3;
          sumR += buf[idx];
          sumG += buf[idx + 1];
          sumB += buf[idx + 2];
          count++;
        }
      }
    }
  }

  if (count === 0) return { r: 128, g: 128, b: 128 };
  return { r: sumR / count, g: sumG / count, b: sumB / count };
}

function median3Filter(values: number[]): number[] {
  if (values.length <= 2) return [...values];
  return values.map((v, i) => {
    const a = values[Math.max(0, i - 1)];
    const b = v;
    const c = values[Math.min(values.length - 1, i + 1)];
    return [a, b, c].sort((x, y) => x - y)[1];
  });
}

function zeroPhaseGaussianSmooth(values: number[], radius = 2, sigma = 1.25): number[] {
  if (values.length <= 1 || radius <= 0) return [...values];
  return values.map((_, i) => {
    let sw = 0;
    let sv = 0;
    for (let k = -radius; k <= radius; k++) {
      const idx = Math.max(0, Math.min(values.length - 1, i + k));
      const w = Math.exp(-0.5 * Math.pow(k / sigma, 2));
      sw += w;
      sv += w * values[idx];
    }
    return sv / sw;
  });
}

/**
 * Extracts and caches the raw visual subject trajectory across a library video asset.
 */
export function analyzeAssetSubjectTrack(options: {
  workspaceDir: string;
  handle: string;
  sampleFps?: number;
  force?: boolean;
}): SubjectTrackAnalysis {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const item = sequence.library.find((x) => x.handle === options.handle);
  if (!item) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.handle));
  }
  if (!item.probe.has_video) {
    throw new CutholError(
      DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
        "subject tracker",
        `'${options.handle}' kaynağında görüntü akışı (video stream) bulunmuyor.`
      )
    );
  }

  const durMs = Math.max(100, item.probe.duration_ms);
  const defaultFps = durMs <= 4000 ? 8 : 4;
  const sampleFps = Math.max(1, Math.min(15, options.sampleFps ?? defaultFps));

  fs.mkdirSync(paths.blobsDir, { recursive: true });
  const cachePath = path.join(
    paths.blobsDir,
    `subject_track_${item.digest_sha256.slice(0, 16)}_${sampleFps}fps_v1.json`
  );

  if (!options.force && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as SubjectTrackAnalysis;
      if (cached && Array.isArray(cached.samples) && cached.samples.length > 0) {
        return { ...cached, handle: item.handle };
      }
    } catch {
      // recompute if cache file is corrupted
    }
  }

  const absFile = resolveLibraryItemPath(paths.rootDir, item);
  const W = 160;
  const rawAr =
    item.probe.width > 0 && item.probe.height > 0 ? item.probe.width / item.probe.height : 16 / 9;
  const H = Math.max(40, Math.min(280, Math.round(W / rawAr / 2) * 2));

  const proc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      absFile,
      "-vf",
      `fps=${sampleFps},scale=${W}:${H}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: 96 * 1024 * 1024, timeout: 60_000 }
  );

  if (proc.status !== 0) {
    throw new CutholError(
      DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
        "ffmpeg subject extract",
        (proc.stderr?.toString("utf8") || "rawvideo extract failed").slice(-400)
      )
    );
  }

  const buf = proc.stdout as Buffer;
  const frameSize = W * H * 3;
  const numFrames = Math.floor(buf.length / frameSize);

  if (numFrames === 0) {
    const fallback: SubjectTrackAnalysis = {
      handle: item.handle,
      sha256: item.digest_sha256,
      duration_ms: item.probe.duration_ms,
      sample_fps: sampleFps,
      detection_method: "static_saliency",
      mean_confidence: 0,
      min_confidence: 0,
      subject_spread_x_pct: 0,
      mean_center_x_pct: 50,
      samples: [
        {
          source_ms: 0,
          center_x_pct: 50,
          center_y_pct: 50,
          left_x_pct: 35,
          right_x_pct: 65,
          confidence: 0,
        },
      ],
    };
    return fallback;
  }

  const numPixels = W * H;
  const meanR = new Float32Array(numPixels);
  const meanG = new Float32Array(numPixels);
  const meanB = new Float32Array(numPixels);
  const temporalStd = new Float32Array(numPixels);

  for (let f = 0; f < numFrames; f++) {
    const off = f * frameSize;
    for (let i = 0; i < numPixels; i++) {
      const pIdx = off + i * 3;
      meanR[i] += buf[pIdx];
      meanG[i] += buf[pIdx + 1];
      meanB[i] += buf[pIdx + 2];
    }
  }
  for (let i = 0; i < numPixels; i++) {
    meanR[i] /= numFrames;
    meanG[i] /= numFrames;
    meanB[i] /= numFrames;
  }

  for (let f = 0; f < numFrames; f++) {
    const off = f * frameSize;
    for (let i = 0; i < numPixels; i++) {
      const pIdx = off + i * 3;
      const dr = buf[pIdx] - meanR[i];
      const dg = buf[pIdx + 1] - meanG[i];
      const db = buf[pIdx + 2] - meanB[i];
      temporalStd[i] += (dr * dr + dg * dg + db * db) / 3;
    }
  }

  let maxTempStd = 0;
  for (let i = 0; i < numPixels; i++) {
    temporalStd[i] = Math.sqrt(temporalStd[i] / numFrames);
    if (temporalStd[i] > maxTempStd) maxTempStd = temporalStd[i];
  }

  interface FrameChannelEst {
    cxPct: number;
    cyPct: number;
    leftPct: number;
    rightPct: number;
    conf: number;
    concentration: number;
  }

  const faceEsts: FrameChannelEst[] = [];
  const fgEsts: FrameChannelEst[] = [];

  const winW = Math.max(8, Math.round(W * 0.24));
  const stdFloor = Math.max(3.5, maxTempStd * 0.15);

  for (let f = 0; f < numFrames; f++) {
    const off = f * frameSize;
    const topBg = estimateFrameBorderBackground(buf, off, W, H, true);
    const borderBg = estimateFrameBorderBackground(buf, off, W, H, false);

    // --- Channel A: Face / Head-Shoulder Detector ---
    const colSkin = new Float32Array(W);
    const rowSkin = new Float32Array(H);
    let totalSkinMass = 0;

    const yFace0 = Math.floor(H * 0.10);
    const yFace1 = Math.floor(H * 0.68);
    const xFace0 = Math.floor(W * 0.04);
    const xFace1 = Math.floor(W * 0.96);

    for (let y = yFace0; y < yFace1; y++) {
      for (let x = xFace0; x < xFace1; x++) {
        const i = y * W + x;
        const pIdx = off + i * 3;
        const s = computeSkinProbability(buf[pIdx], buf[pIdx + 1], buf[pIdx + 2]);
        if (s > 0.15) {
          const actW =
            maxTempStd > 6.0
              ? Math.min(1.0, Math.max(0.05, (temporalStd[i] - stdFloor) / 10.0))
              : 1.0;
          const val = s * actW;
          colSkin[x] += val;
          rowSkin[y] += val;
          totalSkinMass += val;
        }
      }
    }

    let bestSkinSum = 0;
    let bestSkinX0 = Math.round((W - winW) / 2);
    for (let x0 = 0; x0 <= W - winW; x0++) {
      let s = 0;
      for (let x = x0; x < x0 + winW; x++) s += colSkin[x];
      if (s > bestSkinSum) {
        bestSkinSum = s;
        bestSkinX0 = x0;
      }
    }

    let peakSkinCol = 0;
    let peakSkinX = bestSkinX0 + Math.floor(winW / 2);
    for (let x = bestSkinX0; x < bestSkinX0 + winW; x++) {
      if (colSkin[x] > peakSkinCol) {
        peakSkinCol = colSkin[x];
        peakSkinX = x;
      }
    }

    // Contiguous cluster expansion from peakSkinX (bridging 1px gaps)
    const skinThresh = peakSkinCol * 0.18;
    let skinL = peakSkinX;
    let skinR = peakSkinX;
    if (peakSkinCol > 0.1) {
      while (
        skinL > 0 &&
        (colSkin[skinL - 1] >= skinThresh || (skinL > 1 && colSkin[skinL - 2] >= skinThresh))
      ) {
        skinL--;
      }
      while (
        skinR < W - 1 &&
        (colSkin[skinR + 1] >= skinThresh || (skinR < W - 2 && colSkin[skinR + 2] >= skinThresh))
      ) {
        skinR++;
      }
    }

    // Expand up to 4px (~2.5% width) into upper cranial hair/temple silhouette [0.10H .. 0.42H]
    const yHead0 = Math.floor(H * 0.10);
    const yHead1 = Math.floor(H * 0.42);
    let headL = skinL;
    let headR = skinR;
    for (let step = 1; step <= 4; step++) {
      if (headL - 1 >= 0) {
        let fg = 0;
        for (let y = yHead0; y < yHead1; y++) {
          const pIdx = off + (y * W + (headL - 1)) * 3;
          const distBg = Math.sqrt(
            ((buf[pIdx] - topBg.r) ** 2 +
              (buf[pIdx + 1] - topBg.g) ** 2 +
              (buf[pIdx + 2] - topBg.b) ** 2) /
              3
          );
          if (distBg > 28) fg++;
        }
        if (fg / Math.max(1, yHead1 - yHead0) > 0.25) headL--;
        else break;
      }
    }
    for (let step = 1; step <= 4; step++) {
      if (headR + 1 < W) {
        let fg = 0;
        for (let y = yHead0; y < yHead1; y++) {
          const pIdx = off + (y * W + (headR + 1)) * 3;
          const distBg = Math.sqrt(
            ((buf[pIdx] - topBg.r) ** 2 +
              (buf[pIdx + 1] - topBg.g) ** 2 +
              (buf[pIdx + 2] - topBg.b) ** 2) /
              3
          );
          if (distBg > 28) fg++;
        }
        if (fg / Math.max(1, yHead1 - yHead0) > 0.25) headR++;
        else break;
      }
    }

    let faceCy = H * 0.38;
    let rowSum = 0;
    let rowWy = 0;
    for (let y = yFace0; y < yFace1; y++) {
      rowSum += rowSkin[y];
      rowWy += rowSkin[y] * y;
    }
    if (rowSum > 0.1) faceCy = rowWy / rowSum;

    const skinConcentration = totalSkinMass > 0.1 ? bestSkinSum / totalSkinMass : 0;
    const rawFaceConf = Math.min(1.0, bestSkinSum / (winW * (yFace1 - yFace0) * 0.12));
    const faceConf = skinConcentration >= 0.42 ? rawFaceConf : rawFaceConf * 0.2;

    faceEsts.push({
      cxPct: (((headL + headR) / 2) / W) * 100,
      cyPct: (faceCy / H) * 100,
      leftPct: (headL / W) * 100,
      rightPct: (headR / W) * 100,
      conf: faceConf,
      concentration: skinConcentration,
    });

    // --- Channel B/C: Moving Foreground & Border-Contrast Saliency Detector ---
    const colFg = new Float32Array(W);
    const rowFg = new Float32Array(H);
    let totalFgMass = 0;
    const yFg0 = Math.floor(H * 0.06);
    const yFg1 = Math.floor(H * 0.94);

    for (let y = yFg0; y < yFg1; y++) {
      for (let x = 2; x < W - 2; x++) {
        const i = y * W + x;
        const pIdx = off + i * 3;
        const r = buf[pIdx];
        const g = buf[pIdx + 1];
        const b = buf[pIdx + 2];

        const distBorder = Math.sqrt(
          ((r - borderBg.r) ** 2 + (g - borderBg.g) ** 2 + (b - borderBg.b) ** 2) / 3
        );
        if (distBorder < 14) continue;

        // Multiplicative weighting by temporalStd suppresses static clutter while avoiding ghosting at old positions
        const actFactor =
          maxTempStd > 5.0
            ? Math.min(1.0, Math.max(0.08, (temporalStd[i] - 2.0) / (maxTempStd * 0.35)))
            : 1.0;
        const score = (distBorder / 120) * actFactor;
        colFg[x] += score;
        rowFg[y] += score;
        totalFgMass += score;
      }
    }

    let bestFgSum = 0;
    let bestFgX0 = Math.round((W - winW) / 2);
    let bestFgWx = 0;
    for (let x0 = 0; x0 <= W - winW; x0++) {
      let s = 0;
      let wx = 0;
      for (let x = x0; x < x0 + winW; x++) {
        s += colFg[x];
        wx += colFg[x] * x;
      }
      if (s > bestFgSum) {
        bestFgSum = s;
        bestFgX0 = x0;
        bestFgWx = wx;
      }
    }

    let peakFgCol = 0;
    let peakFgX = bestFgX0 + Math.floor(winW / 2);
    for (let x = bestFgX0; x < bestFgX0 + winW; x++) {
      if (colFg[x] > peakFgCol) {
        peakFgCol = colFg[x];
        peakFgX = x;
      }
    }

    const fgThresh = peakFgCol * 0.2;
    let fgL = peakFgX;
    let fgR = peakFgX;
    if (peakFgCol > 0.05) {
      while (fgL > 0 && (colFg[fgL - 1] >= fgThresh || (fgL > 1 && colFg[fgL - 2] >= fgThresh))) {
        fgL--;
      }
      while (
        fgR < W - 1 &&
        (colFg[fgR + 1] >= fgThresh || (fgR < W - 2 && colFg[fgR + 2] >= fgThresh))
      ) {
        fgR++;
      }
    }

    const fgCentroidX = bestFgSum > 0.05 ? bestFgWx / bestFgSum : W / 2;
    const fgBoxMidX = (fgL + fgR) / 2;
    const fgCx = 0.65 * fgBoxMidX + 0.35 * fgCentroidX;

    let fgCy = H / 2;
    let fgRowSum = 0;
    let fgRowWy = 0;
    for (let y = yFg0; y < yFg1; y++) {
      fgRowSum += rowFg[y];
      fgRowWy += rowFg[y] * y;
    }
    if (fgRowSum > 0.05) fgCy = fgRowWy / fgRowSum;

    const fgConcentration = totalFgMass > 0.05 ? bestFgSum / totalFgMass : 0;
    const fgConf = Math.min(1.0, bestFgSum / (winW * (yFg1 - yFg0) * 0.06));

    fgEsts.push({
      cxPct: (fgCx / W) * 100,
      cyPct: (fgCy / H) * 100,
      leftPct: (fgL / W) * 100,
      rightPct: (fgR / W) * 100,
      conf: fgConcentration >= 0.3 ? fgConf : fgConf * 0.3,
      concentration: fgConcentration,
    });
  }

  const avgFaceConf = faceEsts.reduce((acc, e) => acc + e.conf, 0) / Math.max(1, faceEsts.length);
  const avgFaceConc =
    faceEsts.reduce((acc, e) => acc + e.concentration, 0) / Math.max(1, faceEsts.length);

  const useFaceChannel = avgFaceConf >= 0.25 && avgFaceConc >= 0.45;
  const detectionMethod: SubjectDetectionMethod = useFaceChannel
    ? "face_skin"
    : maxTempStd > 5.0
    ? "foreground_motion"
    : "static_saliency";

  const selected = useFaceChannel ? faceEsts : fgEsts;

  // Interpolate over any isolated low-confidence dropout frames (< 0.15)
  const rawCx = selected.map((s) => s.cxPct);
  const rawCy = selected.map((s) => s.cyPct);
  for (let i = 0; i < selected.length; i++) {
    if (selected[i].conf < 0.15) {
      let prevIdx = i - 1;
      while (prevIdx >= 0 && selected[prevIdx].conf < 0.15) prevIdx--;
      let nextIdx = i + 1;
      while (nextIdx < selected.length && selected[nextIdx].conf < 0.15) nextIdx++;
      if (prevIdx >= 0 && nextIdx < selected.length) {
        const u = (i - prevIdx) / (nextIdx - prevIdx);
        rawCx[i] = rawCx[prevIdx] + (rawCx[nextIdx] - rawCx[prevIdx]) * u;
        rawCy[i] = rawCy[prevIdx] + (rawCy[nextIdx] - rawCy[prevIdx]) * u;
      } else if (prevIdx >= 0) {
        rawCx[i] = rawCx[prevIdx];
        rawCy[i] = rawCy[prevIdx];
      } else if (nextIdx < selected.length) {
        rawCx[i] = rawCx[nextIdx];
        rawCy[i] = rawCy[nextIdx];
      }
    }
  }

  const smoothCx = zeroPhaseGaussianSmooth(median3Filter(rawCx), 2, 1.25);
  const smoothCy = zeroPhaseGaussianSmooth(median3Filter(rawCy), 2, 1.25);

  const samples: SubjectSamplePoint[] = selected.map((s, i) => ({
    source_ms: Math.round((i / sampleFps) * 1000),
    center_x_pct: Number(smoothCx[i].toFixed(2)),
    center_y_pct: Number(smoothCy[i].toFixed(2)),
    left_x_pct: Number(s.leftPct.toFixed(2)),
    right_x_pct: Number(s.rightPct.toFixed(2)),
    confidence: Number(s.conf.toFixed(3)),
  }));

  const minCx = Math.min(...smoothCx);
  const maxCx = Math.max(...smoothCx);
  const meanCx = smoothCx.reduce((a, b) => a + b, 0) / Math.max(1, smoothCx.length);
  const meanConf = samples.reduce((a, b) => a + b.confidence, 0) / Math.max(1, samples.length);
  const minConf = Math.min(...samples.map((s) => s.confidence));

  const result: SubjectTrackAnalysis = {
    handle: item.handle,
    sha256: item.digest_sha256,
    duration_ms: item.probe.duration_ms,
    sample_fps: sampleFps,
    detection_method: detectionMethod,
    mean_confidence: Number(meanConf.toFixed(3)),
    min_confidence: Number(minConf.toFixed(3)),
    subject_spread_x_pct: Number((maxCx - minCx).toFixed(2)),
    mean_center_x_pct: Number(meanCx.toFixed(2)),
    samples,
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(result, null, 2), "utf8");
  } catch {
    // non-blocking cache write
  }

  const refId = `subj_${item.digest_sha256.slice(0, 8)}`;
  const current = sequence.library.find((x) => x.handle === item.handle);
  if (current && current.analysis_refs.subject !== refId) {
    updateSequenceInPlace(options.workspaceDir, (seq) => {
      const target = seq.library.find((x) => x.handle === item.handle);
      if (target) {
        target.analysis_refs.subject = refId;
      }
    });
  }

  return result;
}

/**
 * Converts a raw `SubjectTrackAnalysis` (or manual overrides) over a `SpineClip`'s source range
 * into a calm, jitter-free horizontal reframe plan (`scale_x`, `placement.x_pct`, `envelopes`, `focal_points`).
 */
export function planCalmReframeTrajectory(options: {
  clip: SpineClip;
  stageWidth: number;
  stageHeight: number;
  assetWidth: number;
  assetHeight: number;
  track?: SubjectTrackAnalysis;
  mode?: "subject_track" | "center_lock" | "off";
  deadbandPct?: number;
  fixedCenterXPct?: number;
  manualPoints?: Array<{ offset_ms: number; center_x_pct: number; center_y_pct?: number }>;
  replaceManualPoints?: boolean;
  sourceMsToClipLocalMsFn: (clip: SpineClip, sourceMs: number) => number;
  clipLocalMsToSourceMsFn: (clip: SpineClip, localMs: number) => number;
}): PlannedClipReframe {
  const {
    clip,
    stageWidth,
    stageHeight,
    assetWidth,
    assetHeight,
    track,
    sourceMsToClipLocalMsFn,
    clipLocalMsToSourceMsFn,
  } = options;
  const mode = options.mode ?? "subject_track";
  const deadbandPct = Math.max(0.5, Math.min(15.0, options.deadbandPct ?? 3.2));

  const stageAr = stageWidth > 0 && stageHeight > 0 ? stageWidth / stageHeight : 9 / 16;
  const assetAr = assetWidth > 0 && assetHeight > 0 ? assetWidth / assetHeight : 16 / 9;

  // Horizontal pan is only possible when the source aspect ratio is wider than the stage aspect ratio
  const rawScaleX = assetAr / stageAr;
  const horizontalPanAvailable = rawScaleX > 1.03 && mode !== "off";
  const effectiveScaleX = horizontalPanAvailable ? Number(rawScaleX.toFixed(4)) : 1.0;
  // Leave a 0.4% safety margin so integer pixel rounding at 480p/1080p never exposes the stage backdrop
  const maxPanXPct = horizontalPanAvailable
    ? Math.max(0, Number((((effectiveScaleX - 1) / 2) * 100 - 0.4).toFixed(2)))
    : 0;

  const centerToXPct = (centerXPct: number): number => {
    if (!horizontalPanAvailable || maxPanXPct <= 0) return 0;
    const raw = (50 - centerXPct) * effectiveScaleX;
    return Number(Math.max(-maxPanXPct, Math.min(maxPanXPct, raw)).toFixed(2));
  };

  if (mode === "off") {
    return {
      clip_id: clip.id,
      asset_handle: clip.asset_handle,
      mode: "off",
      detection_method: "manual_override",
      applied_pan: false,
      horizontal_pan_available: horizontalPanAvailable,
      scale_x: 1,
      scale_y: 1,
      static_x_pct: 0,
      max_pan_x_pct: maxPanXPct,
      mean_confidence: 1,
      min_confidence: 1,
      low_confidence_ranges_ms: [],
      subject_spread_x_pct: 0,
      focal_points: [],
      envelope_points: [],
    };
  }

  if (mode === "center_lock" && (!options.manualPoints || options.manualPoints.length === 0)) {
    const targetCx = options.fixedCenterXPct ?? 50;
    const targetXPct = centerToXPct(targetCx);
    const needsPan = horizontalPanAvailable && Math.abs(targetXPct) >= 0.5;
    const focal: ReframeFocalPoint = {
      offset_ms: 0,
      source_ms: clip.source_in_ms,
      center_x_pct: Number(targetCx.toFixed(2)),
      center_y_pct: 50,
      x_pct: needsPan ? targetXPct : 0,
      confidence: 1,
    };
    return {
      clip_id: clip.id,
      asset_handle: clip.asset_handle,
      mode: "center_lock",
      detection_method: options.fixedCenterXPct !== undefined ? "manual_override" : "static_saliency",
      applied_pan: needsPan,
      horizontal_pan_available: horizontalPanAvailable,
      scale_x: needsPan ? effectiveScaleX : 1,
      scale_y: 1,
      static_x_pct: needsPan ? targetXPct : 0,
      max_pan_x_pct: maxPanXPct,
      mean_confidence: 1,
      min_confidence: 1,
      low_confidence_ranges_ms: [],
      subject_spread_x_pct: 0,
      focal_points: [focal],
      envelope_points: [],
    };
  }

  // Handle explicit full manual override (--points ... --replace)
  if (
    options.manualPoints &&
    options.manualPoints.length > 0 &&
    (options.replaceManualPoints || !track)
  ) {
    const sortedManual = [...options.manualPoints]
      .map((p) => ({
        offset_ms: Math.max(0, Math.min(clip.duration_ms, Math.round(p.offset_ms))),
        center_x_pct: Math.max(0, Math.min(100, p.center_x_pct)),
        center_y_pct: Math.max(0, Math.min(100, p.center_y_pct ?? 45)),
      }))
      .sort((a, b) => a.offset_ms - b.offset_ms);

    const focals: ReframeFocalPoint[] = sortedManual.map((p) => ({
      offset_ms: p.offset_ms,
      source_ms: clipLocalMsToSourceMsFn(clip, p.offset_ms),
      center_x_pct: Number(p.center_x_pct.toFixed(2)),
      center_y_pct: Number(p.center_y_pct.toFixed(2)),
      x_pct: centerToXPct(p.center_x_pct),
      confidence: 1.0,
    }));

    const cxVals = focals.map((f) => f.center_x_pct);
    const spread = cxVals.length > 1 ? Math.max(...cxVals) - Math.min(...cxVals) : 0;
    const isDynamic = horizontalPanAvailable && focals.length > 1 && spread >= 0.5;
    const isOffsetStatic =
      horizontalPanAvailable && !isDynamic && Math.abs(focals[0].x_pct) >= 0.5;
    const appliedPan = isDynamic || isOffsetStatic;

    const envPts: ParameterEnvelopePoint[] = isDynamic
      ? focals.map((f) => ({
          offset_ms: f.offset_ms,
          value: f.x_pct,
          easing: "ease_in_out" as const,
        }))
      : [];

    return {
      clip_id: clip.id,
      asset_handle: clip.asset_handle,
      mode: "subject_track",
      detection_method: "manual_override",
      applied_pan: appliedPan,
      horizontal_pan_available: horizontalPanAvailable,
      scale_x: appliedPan ? effectiveScaleX : 1,
      scale_y: 1,
      static_x_pct: appliedPan ? focals[0].x_pct : 0,
      max_pan_x_pct: maxPanXPct,
      mean_confidence: 1,
      min_confidence: 1,
      low_confidence_ranges_ms: [],
      subject_spread_x_pct: Number(spread.toFixed(2)),
      focal_points: focals,
      envelope_points: envPts,
    };
  }

  // Extract clip-local samples from `track`
  const clipSamples = (track?.samples ?? []).filter(
    (s) => s.source_ms >= clip.source_in_ms - 250 && s.source_ms <= clip.source_out_ms + 250
  );

  if (clipSamples.length === 0) {
    return {
      clip_id: clip.id,
      asset_handle: clip.asset_handle,
      mode: "subject_track",
      detection_method: track?.detection_method ?? "static_saliency",
      applied_pan: false,
      horizontal_pan_available: horizontalPanAvailable,
      scale_x: 1,
      scale_y: 1,
      static_x_pct: 0,
      max_pan_x_pct: maxPanXPct,
      mean_confidence: 0,
      min_confidence: 0,
      low_confidence_ranges_ms: [],
      subject_spread_x_pct: 0,
      focal_points: [],
      envelope_points: [],
    };
  }

  // Identify low-confidence ranges (< 0.40) for agent diagnostics
  const lowConfRanges: Array<{ start_ms: number; end_ms: number; min_confidence: number }> = [];
  let curLow: { start_ms: number; end_ms: number; min_confidence: number } | null = null;
  for (const s of clipSamples) {
    const localMs = Math.max(0, Math.min(clip.duration_ms, sourceMsToClipLocalMsFn(clip, s.source_ms)));
    if (s.confidence < 0.4) {
      if (!curLow) {
        curLow = { start_ms: localMs, end_ms: localMs + 250, min_confidence: s.confidence };
      } else {
        curLow.end_ms = Math.max(curLow.end_ms, localMs + 250);
        curLow.min_confidence = Math.min(curLow.min_confidence, s.confidence);
      }
    } else if (curLow) {
      lowConfRanges.push(curLow);
      curLow = null;
    }
  }
  if (curLow) lowConfRanges.push(curLow);

  const cxList = clipSamples.map((s) => s.center_x_pct);
  const cyList = clipSamples.map((s) => s.center_y_pct);
  const confList = clipSamples.map((s) => s.confidence);

  const minCx = Math.min(...cxList);
  const maxCx = Math.max(...cxList);
  const spreadCx = maxCx - minCx;
  const meanCx = cxList.reduce((a, b) => a + b, 0) / cxList.length;
  const meanCy = cyList.reduce((a, b) => a + b, 0) / cyList.length;
  const meanConf = confList.reduce((a, b) => a + b, 0) / confList.length;
  const minConf = Math.min(...confList);

  // If 16:9 stage (no horizontal pan available) OR subject is stationary across the clip:
  if (!horizontalPanAvailable || spreadCx <= deadbandPct) {
    // Stationary subject: only offset statically if subject is meaningfully off-center (> 3.0% from 50%)
    const isOffCenter = horizontalPanAvailable && Math.abs(meanCx - 50) > 3.0;
    const lockedCx = isOffCenter ? Number(meanCx.toFixed(2)) : 50;
    const lockedXPct = isOffCenter ? centerToXPct(lockedCx) : 0;

    const focal: ReframeFocalPoint = {
      offset_ms: 0,
      source_ms: clip.source_in_ms,
      center_x_pct: Number(meanCx.toFixed(2)),
      center_y_pct: Number(meanCy.toFixed(2)),
      x_pct: lockedXPct,
      confidence: Number(meanConf.toFixed(3)),
    };

    return {
      clip_id: clip.id,
      asset_handle: clip.asset_handle,
      mode: "subject_track",
      detection_method: track?.detection_method ?? "face_skin",
      applied_pan: isOffCenter,
      horizontal_pan_available: horizontalPanAvailable,
      scale_x: isOffCenter ? effectiveScaleX : 1,
      scale_y: 1,
      static_x_pct: lockedXPct,
      max_pan_x_pct: maxPanXPct,
      mean_confidence: Number(meanConf.toFixed(3)),
      min_confidence: Number(minConf.toFixed(3)),
      low_confidence_ranges_ms: lowConfRanges,
      subject_spread_x_pct: Number(spreadCx.toFixed(2)),
      focal_points: [focal],
      envelope_points: [],
    };
  }

  // Dynamic subject trajectory: segment into calm plateaus + smooth transitions
  interface Segment {
    startIdx: number;
    endIdx: number;
    val: number;
    cy: number;
    conf: number;
  }

  const computeSegStats = (sIdx: number, eIdx: number): Segment => {
    const slX = cxList.slice(sIdx, eIdx + 1);
    const slY = cyList.slice(sIdx, eIdx + 1);
    const slC = confList.slice(sIdx, eIdx + 1);
    return {
      startIdx: sIdx,
      endIdx: eIdx,
      val: slX.reduce((a, b) => a + b, 0) / slX.length,
      cy: slY.reduce((a, b) => a + b, 0) / slY.length,
      conf: slC.reduce((a, b) => a + b, 0) / slC.length,
    };
  };

  const segments: Segment[] = [];
  let segStart = 0;
  for (let i = 1; i <= cxList.length; i++) {
    if (i === cxList.length) {
      segments.push(computeSegStats(segStart, i - 1));
      break;
    }
    const slice = cxList.slice(segStart, i + 1);
    if (Math.max(...slice) - Math.min(...slice) > deadbandPct + 0.3) {
      segments.push(computeSegStats(segStart, i - 1));
      segStart = i;
    }
  }

  // Consolidate short transition steps and merge adjacent plateaus with bounded spread
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const len = s.endIdx - s.startIdx + 1;
      if (len <= 3 && i > 0 && i < segments.length - 1) {
        const prev = segments[i - 1];
        const next = segments[i + 1];
        if (
          s.val >= Math.min(prev.val, next.val) - 0.5 &&
          s.val <= Math.max(prev.val, next.val) + 0.5
        ) {
          segments.splice(i, 1);
          i--;
          continue;
        }
      }
      if (len <= 5 && segments.length > 1) {
        const prev = i > 0 ? segments[i - 1] : null;
        const next = i < segments.length - 1 ? segments[i + 1] : null;
        const bestNeighbor =
          prev && next
            ? Math.abs(s.val - prev.val) <= Math.abs(s.val - next.val)
              ? prev
              : next
            : prev || next;
        if (bestNeighbor && Math.abs(s.val - bestNeighbor.val) < deadbandPct + 0.4) {
          const mergedStart = Math.min(bestNeighbor.startIdx, s.startIdx);
          const mergedEnd = Math.max(bestNeighbor.endIdx, s.endIdx);
          const mergedSlice = cxList.slice(mergedStart, mergedEnd + 1);
          if (Math.max(...mergedSlice) - Math.min(...mergedSlice) <= deadbandPct + 1.6) {
            const updated = computeSegStats(mergedStart, mergedEnd);
            bestNeighbor.startIdx = updated.startIdx;
            bestNeighbor.endIdx = updated.endIdx;
            bestNeighbor.val = updated.val;
            bestNeighbor.cy = updated.cy;
            bestNeighbor.conf = updated.conf;
            segments.splice(i, 1);
            i--;
          }
        }
      }
    }

    for (let i = 1; i < segments.length; i++) {
      const prev = segments[i - 1];
      const curr = segments[i];
      const mergedSlice = cxList.slice(prev.startIdx, curr.endIdx + 1);
      if (
        Math.abs(curr.val - prev.val) < deadbandPct * 0.78 &&
        Math.max(...mergedSlice) - Math.min(...mergedSlice) <= deadbandPct + 1.4
      ) {
        const updated = computeSegStats(prev.startIdx, curr.endIdx);
        prev.endIdx = updated.endIdx;
        prev.val = updated.val;
        prev.cy = updated.cy;
        prev.conf = updated.conf;
        segments.splice(i, 1);
        i--;
      }
    }
  }

  // Convert segments into clip-local focal points & envelope keyframes
  const focals: ReframeFocalPoint[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const startSrcMs = clipSamples[seg.startIdx].source_ms;
    const endSrcMs = clipSamples[seg.endIdx].source_ms;
    const rawStartMs =
      i === 0
        ? 0
        : Math.max(0, Math.min(clip.duration_ms, sourceMsToClipLocalMsFn(clip, startSrcMs)));
    const rawEndMs =
      i === segments.length - 1
        ? clip.duration_ms
        : Math.max(rawStartMs, Math.min(clip.duration_ms, sourceMsToClipLocalMsFn(clip, endSrcMs)));
    const segDurMs = rawEndMs - rawStartMs;
    const cx = Number(seg.val.toFixed(2));
    const cy = Number(seg.cy.toFixed(2));
    const conf = Number(seg.conf.toFixed(3));
    const xPct = centerToXPct(cx);

    if (segDurMs < 1400 && i > 0 && i < segments.length - 1) {
      const midMs = Math.round((rawStartMs + rawEndMs) / 2);
      focals.push({
        offset_ms: midMs,
        source_ms: clipLocalMsToSourceMsFn(clip, midMs),
        center_x_pct: cx,
        center_y_pct: cy,
        x_pct: xPct,
        confidence: conf,
      });
    } else {
      const rampMargin = Math.min(300, Math.floor(segDurMs * 0.2));
      const holdStart = i === 0 ? 0 : rawStartMs + rampMargin;
      const holdEnd =
        i === segments.length - 1 ? clip.duration_ms : Math.max(holdStart, rawEndMs - rampMargin);
      focals.push({
        offset_ms: holdStart,
        source_ms: clipLocalMsToSourceMsFn(clip, holdStart),
        center_x_pct: cx,
        center_y_pct: cy,
        x_pct: xPct,
        confidence: conf,
      });
      if (holdEnd > holdStart + 50) {
        focals.push({
          offset_ms: holdEnd,
          source_ms: clipLocalMsToSourceMsFn(clip, holdEnd),
          center_x_pct: cx,
          center_y_pct: cy,
          x_pct: xPct,
          confidence: conf,
        });
      }
    }
  }

  // Apply any partial manual patch points (--points without --replace) on top of detected focals
  if (options.manualPoints && options.manualPoints.length > 0 && !options.replaceManualPoints) {
    for (const mp of options.manualPoints) {
      const offMs = Math.max(0, Math.min(clip.duration_ms, Math.round(mp.offset_ms)));
      const cx = Number(Math.max(0, Math.min(100, mp.center_x_pct)).toFixed(2));
      const cy = Number(Math.max(0, Math.min(100, mp.center_y_pct ?? meanCy)).toFixed(2));
      const xPct = centerToXPct(cx);

      // Replace any auto focal points within +/- 1200ms of the manual pin
      for (let j = focals.length - 1; j >= 0; j--) {
        if (Math.abs(focals[j].offset_ms - offMs) <= 1200) {
          focals.splice(j, 1);
        }
      }
      focals.push({
        offset_ms: offMs,
        source_ms: clipLocalMsToSourceMsFn(clip, offMs),
        center_x_pct: cx,
        center_y_pct: cy,
        x_pct: xPct,
        confidence: 1.0,
      });
    }
  }

  focals.sort((a, b) => a.offset_ms - b.offset_ms);
  const dedupedFocals: ReframeFocalPoint[] = [];
  for (const f of focals) {
    if (dedupedFocals.length > 0 && dedupedFocals[dedupedFocals.length - 1].offset_ms === f.offset_ms) {
      dedupedFocals[dedupedFocals.length - 1] = f;
    } else {
      dedupedFocals.push(f);
    }
  }

  const envelopePoints: ParameterEnvelopePoint[] = dedupedFocals.map((f) => ({
    offset_ms: f.offset_ms,
    value: f.x_pct,
    easing: "ease_in_out",
  }));

  return {
    clip_id: clip.id,
    asset_handle: clip.asset_handle,
    mode: "subject_track",
    detection_method:
      options.manualPoints && options.manualPoints.length > 0
        ? "manual_override"
        : track?.detection_method ?? "face_skin",
    applied_pan: true,
    horizontal_pan_available: horizontalPanAvailable,
    scale_x: effectiveScaleX,
    scale_y: 1,
    static_x_pct: dedupedFocals[0]?.x_pct ?? 0,
    max_pan_x_pct: maxPanXPct,
    mean_confidence: Number(meanConf.toFixed(3)),
    min_confidence: Number(minConf.toFixed(3)),
    low_confidence_ranges_ms: lowConfRanges,
    subject_spread_x_pct: Number(spreadCx.toFixed(2)),
    focal_points: dedupedFocals,
    envelope_points: envelopePoints,
  };
}

export function formatSubjectTrackDigest(track: SubjectTrackAnalysis): Record<string, unknown> {
  const step = Math.max(1, Math.floor(track.samples.length / 20));
  const previewSamples = track.samples.filter(
    (_, idx) => idx % step === 0 || idx === track.samples.length - 1
  );
  return {
    handle: track.handle,
    duration_ms: track.duration_ms,
    detection_method: track.detection_method,
    mean_confidence: track.mean_confidence,
    min_confidence: track.min_confidence,
    subject_spread_x_pct: track.subject_spread_x_pct,
    mean_center_x_pct: track.mean_center_x_pct,
    total_samples: track.samples.length,
    preview_samples: previewSamples,
  };
}
