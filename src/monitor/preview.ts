/**
 * Cuthol Visual Preview Monitor (`src/monitor/preview.ts`).
 *
 * Provides:
 * 1. `captureMonitorFrame` (`cuthol monitor frame --at 2400ms`):
 *    - Extracts exact RGB24 composite pixels at `atMs`.
 *    - Computes Rec. ITU-R BT.709 luma statistics (`luma_mean`, `luma_std`) and checks
 *      `G5_SIGNAL` Blank Frame Sanity (`CUTHOL-G502`).
 *    - Overlays EBU R95 / 9:16 Safe Zone guides, active element bounding boxes (`measureCuePixelBox`),
 *      and top HUD telemetry onto a PNG file.
 * 2. `captureMonitorSheet` (`cuthol monitor sheet --grid 3x3`):
 *    - Samples `cols * rows` timestamps across `[startMs .. endMs]`, renders each annotated cell,
 *      checks every cell for `G5_SIGNAL` blank frames, and composites a high-resolution Contact Sheet PNG.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnWatchedSync } from "../core/subprocess.js";
import {
  activeVisualCueIdsAt,
  computeRenderDurationMs,
  computeSequenceDurationMs,
  resolveCueStartMs,
} from "../core/timeline.js";
import {
  createSubprocessFailureDiagnostic,
  CutholDiagnostic,
  CutholError,
  DIAGNOSTICS,
} from "../core/diagnostics.js";
import { PngCanvas, RgbaColor } from "../core/png_canvas.js";
import { CutholSequence, LaneCue } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { formatTimecode } from "../core/time.js";
import { loadSequence } from "../core/workspace.js";
import {
  prefetchCompositeFramesForTimestamps,
  renderMultipleCompositeFramesRgb24,
  renderSingleCompositeFrameRgb24,
} from "../render/renderer.js";
import { readCurrentScriptErrorRecord } from "../compositor/coords_extract.js";
import {
  CompositionScriptRecord,
  probeScriptRecordsChildSync,
  ScriptProbeJob,
  scriptRecordToDiagnostic,
} from "../compositor/hf_script_errors.js";
import { evaluateEnvelopeAt } from "../sequence/spine.js";
import { measureCuePixelBox } from "../verify/gates.js";

export interface FrameLumaMetrics {
  timestamp_ms: number;
  luma_mean: number;
  luma_std: number;
  luma_min: number;
  luma_max: number;
  is_blank_frame: boolean;
  active_handles: string[];
}

export interface MonitorFrameResult {
  ok: boolean;
  png_path: string;
  width: number;
  height: number;
  metrics: FrameLumaMetrics;
  diagnostics: CutholDiagnostic[];
}

export interface MonitorSheetResult {
  ok: boolean;
  png_path: string;
  grid: string;
  cols: number;
  rows: number;
  width: number;
  height: number;
  window_start_ms: number;
  window_end_ms: number;
  frames: FrameLumaMetrics[];
  blank_frames_ms: number[];
  diagnostics: CutholDiagnostic[];
}

/**
 * Extracts raw RGB24 pixels at `atMs` from a composite MP4 and computes Rec. ITU-R BT.709 luma statistics.
 */
function extractRawFrameToCanvas(
  mp4Path: string,
  width: number,
  height: number,
  atMs: number,
  durationMs: number,
  seq: CutholSequence,
  showBoxes: boolean,
  rootDir?: string
): { canvas: PngCanvas; metrics: FrameLumaMetrics; diagnostic: CutholDiagnostic | null } {
  // Clamp timestamp to the exact last frame PTS index and fallback to -sseof -0.5 / -ss 0
  const fps = Math.max(1, seq.stage.fps);
  const lastFrameIdx = Math.max(0, Math.floor((durationMs / 1000) * fps - 1));
  const maxSafeMs = Math.max(0, Math.floor(lastFrameIdx * (1000 / fps)));
  let clampedMs = Math.max(0, Math.min(Math.round(atMs), maxSafeMs));
  const timeSec = (clampedMs / 1000).toFixed(3);

  const extractArgs = [
    "-v",
    "error",
    "-ss",
    timeSec,
    "-i",
    mp4Path,
    "-vf",
    "scale=flags=accurate_rnd+full_chroma_int:in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24",
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ];
  let proc = spawnWatchedSync("ffmpeg", extractArgs, {
    maxBuffer: width * height * 4 + 1024 * 1024,
    step: "ffmpeg frame extract",
  });

  if (proc.status !== 0 || proc.error) {
    throw new CutholError(
      createSubprocessFailureDiagnostic({
        tool: "ffmpeg frame extract",
        executable: "ffmpeg",
        args: extractArgs,
        proc,
        clipCount: seq.spine.clips.length,
        fallbackDetail: "frame extract failed",
      })
    );
  }

  let rgbBuf = proc.stdout as Buffer;
  const pixelCount = width * height;

  if (rgbBuf.length < pixelCount * 3) {
    const retryProc = spawnWatchedSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-sseof",
        "-0.5",
        "-i",
        mp4Path,
        "-vf",
        "scale=flags=accurate_rnd+full_chroma_int:in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { maxBuffer: width * height * 4 + 1024 * 1024, step: "ffmpeg frame extract" }
    );
    if (retryProc.status === 0 && (retryProc.stdout as Buffer).length >= pixelCount * 3) {
      proc = retryProc;
      rgbBuf = retryProc.stdout as Buffer;
      clampedMs = maxSafeMs;
    } else {
      const zeroProc = spawnWatchedSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-ss",
          "0.000",
          "-i",
          mp4Path,
          "-vf",
          "scale=flags=accurate_rnd+full_chroma_int:in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { maxBuffer: width * height * 4 + 1024 * 1024, step: "ffmpeg frame extract" }
      );
      if (zeroProc.status === 0 && (zeroProc.stdout as Buffer).length >= pixelCount * 3) {
        proc = zeroProc;
        rgbBuf = zeroProc.stdout as Buffer;
        clampedMs = 0;
      }
    }
  }

  if (rgbBuf.length < pixelCount * 3) {
    throw new CutholError(
      DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
        "ffmpeg frame extract",
        `Extracted rawvideo buffer (${rgbBuf.length}B) is smaller than expected frame (${pixelCount * 3}B) at ${clampedMs}ms`
      )
    );
  }

  return annotateRgb24BufferToCanvas(
    rgbBuf,
    width,
    height,
    clampedMs,
    seq,
    showBoxes,
    rootDir
  );
}

export interface BlankFrameEvaluation {
  luma_mean: number;
  luma_std: number;
  luma_min: number;
  luma_max: number;
  backdrop_flat_ratio: number;
  backdrop_luma_std: number;
  is_blank_frame: boolean;
}

export function parseBackdropColorRgb(colorStr: string | undefined): [number, number, number] {
  const raw = (colorStr ?? "#0D0F12").trim();
  const hexMatch = raw.match(/^(?:#|0x)([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  if (raw.toLowerCase() === "black") return [0, 0, 0];
  if (raw.toLowerCase() === "white") return [255, 255, 255];
  return [13, 15, 18];
}

export function evaluateRgb24FrameBlankness(
  rgbBuf: Buffer,
  width: number,
  height: number,
  backdropColorHex?: string
): BlankFrameEvaluation {
  const pixelCount = width * height;
  const [bgR, bgG, bgB] = parseBackdropColorRgb(backdropColorHex);

  let sumY = 0;
  let sumSqY = 0;
  let minY = 255;
  let maxY = 0;

  let bgCount = 0;
  let bgSumY = 0;
  let bgSumSqY = 0;
  let bgFlatCount = 0;

  let blkCount = 0;
  let blkSumY = 0;
  let blkSumSqY = 0;
  let blkFlatCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const r = rgbBuf[idx];
      const g = rgbBuf[idx + 1];
      const b = rgbBuf[idx + 2];

      // Rec. ITU-R BT.709 luma: Y = 0.2126*R + 0.7152*G + 0.0722*B
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sumY += luma;
      sumSqY += luma * luma;
      if (luma < minY) minY = luma;
      if (luma > maxY) maxY = luma;

      const dBg = Math.max(Math.abs(r - bgR), Math.abs(g - bgG), Math.abs(b - bgB));
      const dBlk = Math.max(r, g, b);

      if (dBg <= 6 || dBlk <= 6) {
        const nx = x + 1 < width ? x + 1 : Math.max(0, x - 1);
        const ny = y + 1 < height ? y + 1 : Math.max(0, y - 1);
        const idxX = (y * width + nx) * 3;
        const idxY = (ny * width + x) * 3;
        const diff =
          Math.abs(r - rgbBuf[idxX]) +
          Math.abs(g - rgbBuf[idxX + 1]) +
          Math.abs(b - rgbBuf[idxX + 2]) +
          Math.abs(r - rgbBuf[idxY]) +
          Math.abs(g - rgbBuf[idxY + 1]) +
          Math.abs(b - rgbBuf[idxY + 2]);
        const isLocalFlat = diff <= 2;

        if (dBg <= 6) {
          bgCount++;
          bgSumY += luma;
          bgSumSqY += luma * luma;
          if (isLocalFlat) bgFlatCount++;
        }
        if (dBlk <= 6) {
          blkCount++;
          blkSumY += luma;
          blkSumSqY += luma * luma;
          if (isLocalFlat) blkFlatCount++;
        }
      }
    }
  }

  const meanY = pixelCount > 0 ? sumY / pixelCount : 0;
  const varianceY = pixelCount > 0 ? Math.max(0, sumSqY / pixelCount - meanY * meanY) : 0;
  const stdY = Math.sqrt(varianceY);

  const bgMeanY = bgCount > 0 ? bgSumY / bgCount : 0;
  const bgStdY = bgCount > 0 ? Math.sqrt(Math.max(0, bgSumSqY / bgCount - bgMeanY * bgMeanY)) : 0;
  const bgFlatRatio = pixelCount > 0 ? bgFlatCount / pixelCount : 0;

  const blkMeanY = blkCount > 0 ? blkSumY / blkCount : 0;
  const blkStdY = blkCount > 0 ? Math.sqrt(Math.max(0, blkSumSqY / blkCount - blkMeanY * blkMeanY)) : 0;
  const blkFlatRatio = pixelCount > 0 ? blkFlatCount / pixelCount : 0;

  const minBgFlatRatio = Math.max(bgR, bgG, bgB) <= 4 ? 0.90 : 0.82;
  const isUniformDark =
    meanY <= OPEN_STANDARDS.SIGNAL_SANITY.BLANK_FRAME_LUMA_MEAN_MAX &&
    stdY <= OPEN_STANDARDS.SIGNAL_SANITY.BLANK_FRAME_LUMA_STD_MAX;
  const isBackdropFilled = bgFlatRatio >= minBgFlatRatio && bgStdY <= 1.5;
  const isPureBlackFilled = blkFlatRatio >= 0.90 && blkStdY <= 1.0;

  return {
    luma_mean: Number(meanY.toFixed(2)),
    luma_std: Number(stdY.toFixed(2)),
    luma_min: pixelCount > 0 ? Number(minY.toFixed(2)) : 0,
    luma_max: pixelCount > 0 ? Number(maxY.toFixed(2)) : 0,
    backdrop_flat_ratio: Number(bgFlatRatio.toFixed(4)),
    backdrop_luma_std: Number(bgStdY.toFixed(2)),
    is_blank_frame: isUniformDark || isBackdropFilled || isPureBlackFilled,
  };
}

export function annotateRgb24BufferToCanvas(
  rgbBuf: Buffer,
  width: number,
  height: number,
  clampedMs: number,
  seq: CutholSequence,
  showBoxes: boolean,
  rootDir?: string
): { canvas: PngCanvas; metrics: FrameLumaMetrics; diagnostic: CutholDiagnostic | null } {
  const pixelCount = width * height;
  const canvas = new PngCanvas(width, height, [0, 0, 0, 255]);

  for (let i = 0; i < pixelCount; i++) {
    const dstIdx = i * 4;
    canvas.pixels[dstIdx] = rgbBuf[i * 3];
    canvas.pixels[dstIdx + 1] = rgbBuf[i * 3 + 1];
    canvas.pixels[dstIdx + 2] = rgbBuf[i * 3 + 2];
    canvas.pixels[dstIdx + 3] = 255;
  }

  const evalRes = evaluateRgb24FrameBlankness(
    rgbBuf,
    width,
    height,
    seq.stage.backdrop?.color
  );
  const meanY = evalRes.luma_mean;
  const stdY = evalRes.luma_std;
  const minY = evalRes.luma_min;
  const maxY = evalRes.luma_max;
  const isBlank = evalRes.is_blank_frame;

  // Identify active spine clips (including outgoing cross-transition hold tail) and lane cues at `clampedMs`
  const activeHandles: string[] = [];
  for (let i = 0; i < seq.spine.clips.length; i++) {
    const clip = seq.spine.clips[i];
    const hasNextClip = i < seq.spine.clips.length - 1;
    const outTrans = clip.transition_out;
    const holdTailMs =
      hasNextClip && outTrans && outTrans.kind !== "fade" ? outTrans.duration_ms : 0;
    const end = clip.timeline_in_ms + clip.duration_ms + holdTailMs;
    if (clampedMs >= clip.timeline_in_ms && clampedMs < end) {
      activeHandles.push(clip.id);
    }
  }

  const scaleX = width / seq.stage.width;
  const scaleY = height / seq.stage.height;

  if (showBoxes) {
    // Draw EBU R95 / 9:16 Safe Zone boundary guide
    const safeLeft = Math.round(width * (OPEN_STANDARDS.SAFE_ZONES.TITLE_MARGIN_PCT / 100));
    const safeTop = Math.round(height * (OPEN_STANDARDS.SAFE_ZONES.TITLE_MARGIN_PCT / 100));
    const safeRight =
      seq.stage.aspect === "9:16"
        ? Math.round(width * (1 - OPEN_STANDARDS.SAFE_ZONES.VERTICAL_9_16_RIGHT_CHROME_PCT / 100))
        : width - safeLeft;
    const safeBottom =
      seq.stage.aspect === "9:16"
        ? Math.round(height * (1 - OPEN_STANDARDS.SAFE_ZONES.VERTICAL_9_16_BOTTOM_CHROME_PCT / 100))
        : height - safeTop;

    canvas.strokeRect(
      safeLeft,
      safeTop,
      safeRight - safeLeft,
      safeBottom - safeTop,
      1,
      [250, 204, 21, 140]
    );
  }

  const sortedLanes = [...seq.lanes].sort((a, b) => a.z_index - b.z_index);
  const libMap = new Map(seq.library.map((item) => [item.handle, item]));

  // First collect all active lane handles so the top HUD bar can be drawn BEFORE bounding boxes
  // (preventing the HUD bar from clipping boxes that overflow near the top edge!)
  for (const lane of sortedLanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      const start = resolveCueStartMs(seq, cue);
      const end = start + cue.duration_ms;
      if (clampedMs >= start && clampedMs < end) {
        activeHandles.push(cue.id);
      }
    }
  }

  const actualSeqDurMs = computeSequenceDurationMs(seq);
  const isPastActualSequenceTail =
    actualSeqDurMs > 0 && clampedMs >= actualSeqDurMs && activeHandles.length === 0;
  // Without a spine, frames are drawn by compositions/graphics; only a moment with no visual cue (the
  // backdrop alone) counts as blank. Same rule as the post-render scan.
  const isAuthoredGraphicsFrame =
    seq.spine.clips.length === 0 && activeVisualCueIdsAt(seq, clampedMs).length > 0;
  const effectiveIsBlank = isBlank && !isPastActualSequenceTail && !isAuthoredGraphicsFrame;

  // Draw top HUD bar on the frame FIRST
  canvas.fillRect(0, 0, width, 24, [13, 17, 23, 215]);
  const hudText = `T:${clampedMs}MS (${formatTimecode(clampedMs)}) | ACT:${activeHandles.join(",") || "NONE"} | Y:${meanY.toFixed(1)}`;
  canvas.drawText(hudText, 6, 8, effectiveIsBlank ? [248, 113, 113, 255] : [226, 232, 240, 255], 1);

  for (const lane of sortedLanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      const start = resolveCueStartMs(seq, cue);
      const end = start + cue.duration_ms;
      if (clampedMs >= start && clampedMs < end) {
        // Only draw visual bounding boxes on visual cues (skip audio-only cues: music, sfx, voiceover)
        const isAudioOnlyCue =
          cue.kind === "music" || cue.kind === "sfx" || cue.kind === "voiceover";

        if (showBoxes && !isAudioOnlyCue) {
          const asset = cue.asset_handle ? libMap.get(cue.asset_handle) : undefined;
          const cropWRatio = cue.placement.crop
            ? Math.max(0.05, 1 - (cue.placement.crop.left_pct + cue.placement.crop.right_pct) / 100)
            : 1.0;
          const cropHRatio = cue.placement.crop
            ? Math.max(0.05, 1 - (cue.placement.crop.top_pct + cue.placement.crop.bottom_pct) / 100)
            : 1.0;
          const assetAr =
            asset && asset.probe.width > 0 && asset.probe.height > 0
              ? (asset.probe.width * cropWRatio) / (asset.probe.height * cropHRatio)
              : undefined;

          const localOffsetMs = Math.max(0, clampedMs - start);
          let cueForBox: LaneCue = cue;
          if (cue.envelopes.length > 0) {
            const xEnv = cue.envelopes.find((e) => e.parameter === "placement.x_pct");
            const yEnv = cue.envelopes.find((e) => e.parameter === "placement.y_pct");
            const sxEnv = cue.envelopes.find((e) => e.parameter === "placement.scale_x");
            const syEnv = cue.envelopes.find((e) => e.parameter === "placement.scale_y");
            const rotEnv = cue.envelopes.find((e) => e.parameter === "placement.rotation_deg");
            cueForBox = {
              ...cue,
              placement: {
                ...cue.placement,
                x_pct: xEnv ? evaluateEnvelopeAt(xEnv, localOffsetMs) : cue.placement.x_pct,
                y_pct: yEnv ? evaluateEnvelopeAt(yEnv, localOffsetMs) : cue.placement.y_pct,
                scale_x: sxEnv ? evaluateEnvelopeAt(sxEnv, localOffsetMs) : cue.placement.scale_x,
                scale_y: syEnv ? evaluateEnvelopeAt(syEnv, localOffsetMs) : cue.placement.scale_y,
                rotation_deg: rotEnv ? evaluateEnvelopeAt(rotEnv, localOffsetMs) : cue.placement.rotation_deg,
              },
            };
          }

          // Pass rootDir so HyperFrames preset geometry is detected accurately
          const stageBox = measureCuePixelBox(seq.stage, cueForBox, assetAr, rootDir);

          const rawBx = Math.round(stageBox.left * scaleX);
          const rawBy = Math.round(stageBox.top * scaleY);
          const rawBw = Math.max(8, Math.round(stageBox.width * scaleX));
          const rawBh = Math.max(8, Math.round(stageBox.height * scaleY));

          // Clamp box to frame bounds so overflowing boxes still show all 4 border edges clearly
          const bx = Math.max(1, Math.min(width - 9, rawBx));
          const by = Math.max(1, Math.min(height - 9, rawBy));
          const bw = Math.max(8, Math.min(width - 1 - bx, rawBx + rawBw - bx));
          const bh = Math.max(8, Math.min(height - 1 - by, rawBy + rawBh - by));

          const boxColor: RgbaColor =
            cue.kind === "title" || cue.kind === "caption"
              ? [56, 189, 248, 235]
              : cue.kind === "composition"
              ? [192, 132, 252, 235]
              : [74, 222, 128, 235];

          canvas.strokeRect(bx, by, bw, bh, 2, boxColor);
          const label = `${cue.id}:${cue.kind}`;
          const badgeW = label.length * 6 + 8;
          const badgeX = Math.max(2, Math.min(width - badgeW - 2, bx));
          const badgeY = by >= 37 ? by - 13 : Math.min(height - 14, by + 3);
          canvas.fillRect(badgeX, badgeY, badgeW, 12, [15, 23, 42, 225]);
          canvas.drawText(label, badgeX + 4, badgeY + 2, boxColor, 1);
        }
      }
    }
  }

  const metrics: FrameLumaMetrics = {
    timestamp_ms: clampedMs,
    luma_mean: Number(meanY.toFixed(2)),
    luma_std: Number(stdY.toFixed(2)),
    luma_min: Number(minY.toFixed(2)),
    luma_max: Number(maxY.toFixed(2)),
    is_blank_frame: effectiveIsBlank,
    active_handles: activeHandles,
  };

  const diagnostic = effectiveIsBlank
    ? DIAGNOSTICS.BLANK_FRAME_DETECTED(clampedMs, metrics.luma_mean, metrics.luma_std)
    : null;

  return { canvas, metrics, diagnostic };
}

function activeCompositionCuesAt(sequence: CutholSequence, tMs: number): LaneCue[] {
  const ids = new Set(activeVisualCueIdsAt(sequence, tMs));
  const out: LaneCue[] = [];
  for (const lane of sequence.lanes) {
    for (const cue of lane.cues) {
      if (ids.has(cue.id) && cue.kind === "composition" && cue.composition) out.push(cue);
    }
  }
  return out;
}

/**
 * Script-error diagnostics for the compositions active at the rendered moment(s).
 * Reads content-keyed records (measurement / preview / earlier probes) and probes
 * only compositions with no record, so a broken script can never present a frame
 * as healthy while healthy projects pay the probe cost once.
 */
function collectCompositionScriptDiagnostics(
  sequence: CutholSequence,
  projectDir: string,
  cues: LaneCue[]
): CutholDiagnostic[] {
  const resolveDir = (cue: LaneCue): string | null => {
    const dir = cue.composition?.composition_dir;
    if (!dir) return null;
    try {
      return path.isAbsolute(dir) ? dir : path.resolve(projectDir, dir);
    } catch {
      return null;
    }
  };
  const seen = new Set<string>();
  const records = new Map<string, CompositionScriptRecord>();
  const missing: ScriptProbeJob[] = [];
  for (const cue of cues) {
    if (seen.has(cue.id) || !cue.composition) continue;
    seen.add(cue.id);
    const absCompDir = resolveDir(cue);
    if (!absCompDir) continue;
    const entryHtml = cue.composition.entry_html;
    const record = readCurrentScriptErrorRecord(projectDir, absCompDir, entryHtml);
    if (record) {
      records.set(cue.id, record);
    } else {
      missing.push({
        cueId: cue.id,
        absCompDir,
        entryHtml,
        width: sequence.stage.width,
        height: sequence.stage.height,
        fps: Math.max(1, sequence.stage.fps),
        durationSec: Math.max(0.2, cue.duration_ms / 1000),
      });
    }
  }
  if (missing.length > 0) {
    probeScriptRecordsChildSync(projectDir, missing);
    for (const job of missing) {
      const record = readCurrentScriptErrorRecord(projectDir, job.absCompDir, job.entryHtml);
      if (record) records.set(job.cueId, record);
    }
  }
  const diags: CutholDiagnostic[] = [];
  for (const cue of cues) {
    const record = records.get(cue.id);
    if (!record) continue;
    records.delete(cue.id);
    const diag = scriptRecordToDiagnostic(cue.id, record);
    if (diag) diags.push(diag);
  }
  return diags;
}

export function captureMonitorFrame(options: {
  workspaceDir: string;
  atMs: number;
  showBoxes?: boolean;
  outputPath?: string;
}): MonitorFrameResult {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const showBoxes = options.showBoxes ?? true;

  const { rgbBuf, width, height, clampedMs } = renderSingleCompositeFrameRgb24(
    sequence,
    paths,
    options.atMs,
    "draft_480p"
  );
  const { canvas, metrics, diagnostic } = annotateRgb24BufferToCanvas(
    rgbBuf,
    width,
    height,
    clampedMs,
    sequence,
    showBoxes,
    paths.rootDir
  );

  const defaultOut = path.join(paths.monitorDir, `frame_${Math.round(options.atMs)}ms.png`);
  const resolvedOut = options.outputPath
    ? path.isAbsolute(options.outputPath)
      ? options.outputPath
      : path.resolve(paths.rootDir, options.outputPath)
    : defaultOut;

  canvas.saveAs(resolvedOut);

  // On an empty sequence every frame is backdrop; say why once instead of reporting a blank frame.
  const baseDiagnostics =
    computeSequenceDurationMs(sequence) <= 0
      ? [DIAGNOSTICS.EMPTY_SEQUENCE("WARN")]
      : diagnostic
        ? [diagnostic]
        : [];
  const scriptDiagnostics = collectCompositionScriptDiagnostics(
    sequence,
    paths.rootDir,
    activeCompositionCuesAt(sequence, clampedMs)
  );

  return {
    ok: true,
    png_path: resolvedOut,
    width,
    height,
    metrics,
    diagnostics: [...baseDiagnostics, ...scriptDiagnostics],
  };
}

export function captureMonitorSheet(options: {
  workspaceDir: string;
  startMs?: number;
  endMs?: number;
  atMs?: number[];
  cols?: number;
  rows?: number;
  showBoxes?: boolean;
  outputPath?: string;
}): MonitorSheetResult {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const showBoxes = options.showBoxes ?? true;

  const durationMs = computeRenderDurationMs(sequence);
  const scaleFactor = 480 / Math.min(sequence.stage.width, sequence.stage.height);
  const cellW = Math.max(16, Math.round((sequence.stage.width * scaleFactor) / 2) * 2);
  const cellH = Math.max(16, Math.round((sequence.stage.height * scaleFactor) / 2) * 2);

  const actualSeqDurMs = computeSequenceDurationMs(sequence);
  const defaultEndMs = actualSeqDurMs > 0 ? Math.min(durationMs, actualSeqDurMs) : durationMs;

  const explicitTimestamps =
    options.atMs && options.atMs.length > 0
      ? options.atMs.map((t) =>
          Math.min(Math.max(0, durationMs - 1), Math.max(0, Math.round(t)))
        )
      : null;

  let cols: number;
  let rows: number;
  let winStart: number;
  let winEnd: number;
  const cellTimestampsMs: number[] = [];

  if (explicitTimestamps && explicitTimestamps.length > 0) {
    for (const tMs of explicitTimestamps) {
      cellTimestampsMs.push(tMs);
    }
    const count = cellTimestampsMs.length;
    if (options.cols !== undefined && options.rows !== undefined && options.cols * options.rows >= count) {
      cols = Math.max(1, Math.min(6, options.cols));
      rows = Math.max(1, Math.min(6, options.rows));
    } else if (options.cols !== undefined) {
      cols = Math.max(1, Math.min(6, options.cols));
      rows = Math.max(1, Math.ceil(count / cols));
    } else {
      cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(count))));
      rows = Math.max(1, Math.ceil(count / cols));
    }
    winStart = Math.min(...cellTimestampsMs);
    winEnd = Math.max(...cellTimestampsMs);
  } else {
    cols = Math.max(1, Math.min(6, options.cols ?? 3));
    rows = Math.max(1, Math.min(6, options.rows ?? 3));
    winStart = Math.max(0, Math.min(Math.max(0, defaultEndMs - 1), options.startMs ?? 0));
    winEnd = Math.max(winStart + 1, Math.min(durationMs, options.endMs ?? defaultEndMs));
    const span = Math.max(1, winEnd - winStart);
    const gridCells = cols * rows;
    for (let idx = 0; idx < gridCells; idx++) {
      // Sample midpoints of each equal sub-interval so we don't hit exact 0ms/endMs boundary transitions
      const sampleRatio = (idx + 0.5) / gridCells;
      const tMs = Math.min(winEnd - 1, Math.max(winStart, Math.round(winStart + span * sampleRatio)));
      cellTimestampsMs.push(tMs);
    }
  }

  const totalCells = cellTimestampsMs.length;

  prefetchCompositeFramesForTimestamps(sequence, paths, cellTimestampsMs, "draft_480p");

  const headerH = 44;
  const pad = 12;
  const sheetW = pad + cols * (cellW + pad);
  const sheetH = headerH + pad + rows * (cellH + pad);

  const sheetCanvas = new PngCanvas(sheetW, sheetH, [11, 15, 22, 255]);
  sheetCanvas.fillRect(0, 0, sheetW, headerH, [20, 26, 36, 255]);
  sheetCanvas.drawText(
    `CUTHOL MONITOR SHEET | ${sequence.meta.project_id} R${sequence.meta.revision} | GRID ${cols}X${rows} | ${winStart}..${winEnd}MS`,
    16,
    15,
    [235, 240, 248, 255],
    sheetW < 760 ? 1 : 2
  );

  const frames: FrameLumaMetrics[] = [];
  const blankFramesMs: number[] = [];
  const diagnostics: CutholDiagnostic[] = [];

  const renderedCells = renderMultipleCompositeFramesRgb24(
    sequence,
    paths,
    cellTimestampsMs,
    "draft_480p"
  );

  for (let idx = 0; idx < totalCells; idx++) {
    const { rgbBuf, width: frameW, height: frameH, clampedMs, bboxUpdates } = renderedCells[idx];
    if (showBoxes && bboxUpdates.length > 0) {
      for (const u of bboxUpdates) {
        if (u.bboxJson !== null) {
          try {
            fs.mkdirSync(path.dirname(u.bboxPath), { recursive: true });
            fs.writeFileSync(u.bboxPath, u.bboxJson, "utf8");
          } catch {
            // ignore sidecar write error
          }
        }
      }
    }
    const { canvas: cellCanvas, metrics, diagnostic } = annotateRgb24BufferToCanvas(
      rgbBuf,
      frameW,
      frameH,
      clampedMs,
      sequence,
      showBoxes,
      paths.rootDir
    );

    frames.push(metrics);
    if (metrics.is_blank_frame) {
      blankFramesMs.push(metrics.timestamp_ms);
    }
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }

    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const dstX = pad + col * (cellW + pad);
    const dstY = headerH + pad + row * (cellH + pad);

    // Blit cellCanvas onto sheetCanvas
    for (let py = 0; py < cellH; py++) {
      const srcRowStart = py * cellW * 4;
      const dstRowStart = ((dstY + py) * sheetW + dstX) * 4;
      sheetCanvas.pixels.set(
        cellCanvas.pixels.subarray(srcRowStart, srcRowStart + cellW * 4),
        dstRowStart
      );
    }

    // Cell border (red if blank frame detected, slate otherwise)
    sheetCanvas.strokeRect(
      dstX - 1,
      dstY - 1,
      cellW + 2,
      cellH + 2,
      2,
      metrics.is_blank_frame ? [239, 68, 68, 255] : [56, 70, 92, 255]
    );
  }

  const defaultOut = path.join(paths.monitorDir, `sheet_${cols}x${rows}_r${sequence.meta.revision}.png`);
  const resolvedOut = options.outputPath
    ? path.isAbsolute(options.outputPath)
      ? options.outputPath
      : path.resolve(paths.rootDir, options.outputPath)
    : defaultOut;

  sheetCanvas.saveAs(resolvedOut);
  if (actualSeqDurMs <= 0) {
    // On an empty sequence every cell is backdrop; one clear diagnostic replaces a blank-frame warning per cell.
    diagnostics.splice(0, diagnostics.length, DIAGNOSTICS.EMPTY_SEQUENCE("WARN"));
  }
  // Script errors for the distinct compositions active across the rendered cells.
  const sheetCues: LaneCue[] = [];
  for (const cell of renderedCells) {
    for (const cue of activeCompositionCuesAt(sequence, cell.clampedMs)) {
      if (!sheetCues.some((c) => c.id === cue.id)) sheetCues.push(cue);
    }
  }
  diagnostics.push(...collectCompositionScriptDiagnostics(sequence, paths.rootDir, sheetCues));

  return {
    ok: true,
    png_path: resolvedOut,
    grid: `${cols}x${rows}`,
    cols,
    rows,
    width: sheetW,
    height: sheetH,
    window_start_ms: winStart,
    window_end_ms: winEnd,
    frames,
    blank_frames_ms: blankFramesMs,
    diagnostics,
  };
}
