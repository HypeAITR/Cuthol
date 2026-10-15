/**
 * Cuthol Visual Multi-Track NLE Timeline Renderer (`src/monitor/timeline_view.ts`).
 *
 * Renders `cuthol monitor timeline` (`timeline.png`) using `PngCanvas`:
 * - Time ruler with grid ticks across the sequence duration
 * - Over-spine visual lanes (`z_index >= 0`: captions, titles, compositions, B-roll)
 * - Magnetic `SPINE` track (`sp_01`, `sp_02`, transitions, speed badges, embedded mini waveform)
 * - Under-spine audio lanes (`z_index < 0`: voiceover `ln_vo`, music `ln_bgm` with visual ducking
 *   gain envelope curve `-12 dB` valleys and beat onset ticks)
 */

import fs from "node:fs";
import path from "node:path";
import { computeSequenceDurationMs, resolveCueStartMs } from "../brief/inspector.js";
import { PngCanvas, RgbaColor } from "../core/png_canvas.js";
import { LaneCue } from "../core/schema.js";
import { formatTimecode } from "../core/time.js";
import { loadSequence } from "../core/workspace.js";
import { BeatAnalysisResult } from "../library/beats.js";
import { MediaLedger } from "../library/ledger.js";
import { WaveformAnalysisResult } from "../library/waveform.js";
import { evaluateEnvelopeAt, sequenceMsToSourceMs } from "../sequence/spine.js";

export interface MonitorTimelineResult {
  ok: boolean;
  png_path: string;
  width: number;
  height: number;
  duration_ms: number;
  spine_clips_count: number;
  lanes_count: number;
  cues_count: number;
}

function colorForCueKind(kind: LaneCue["kind"]): { fill: RgbaColor; border: RgbaColor } {
  switch (kind) {
    case "composition":
      return { fill: [88, 28, 135, 230], border: [192, 132, 252, 255] };
    case "title":
      return { fill: [12, 74, 110, 230], border: [56, 189, 248, 255] };
    case "caption":
      return { fill: [15, 118, 110, 230], border: [45, 212, 191, 255] };
    case "broll":
      return { fill: [20, 83, 45, 230], border: [74, 222, 128, 255] };
    case "voiceover":
      return { fill: [124, 45, 18, 230], border: [251, 146, 60, 255] };
    case "music":
      return { fill: [30, 58, 138, 230], border: [96, 165, 250, 255] };
    default:
      return { fill: [51, 65, 85, 230], border: [148, 163, 184, 255] };
  }
}

export function captureMonitorTimeline(options: {
  workspaceDir: string;
  width?: number;
  includeEmptyLanes?: boolean;
  outputPath?: string;
}): MonitorTimelineResult {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const totalDurationMs = Math.max(1000, computeSequenceDurationMs(sequence));

  const sortedLanesDesc = [...sequence.lanes]
    .filter((l) => options.includeEmptyLanes || l.cues.length > 0 || l.locked)
    .sort((a, b) => b.z_index - a.z_index);
  const overLanes = sortedLanesDesc.filter((l) => l.z_index >= 0);
  const underLanes = sortedLanesDesc.filter((l) => l.z_index < 0);

  const canvasW = Math.max(960, Math.min(2400, options.width ?? 1440));
  const headerH = 44;
  const rulerH = 28;
  const laneRowH = 54;
  const spineRowH = 72;
  const rowGap = 8;
  const bottomPad = 20;
  const leftLabelW = 190;
  const rightPad = 24;
  const trackAreaX = leftLabelW;
  const trackAreaW = canvasW - leftLabelW - rightPad;

  const totalRowsCount = overLanes.length + 1 + underLanes.length;
  const canvasH =
    headerH +
    rulerH +
    12 +
    overLanes.length * (laneRowH + rowGap) +
    (spineRowH + rowGap) +
    underLanes.length * (laneRowH + rowGap) +
    bottomPad;

  const canvas = new PngCanvas(canvasW, canvasH, [11, 15, 23, 255]);

  // 1. Header bar
  canvas.fillRect(0, 0, canvasW, headerH, [19, 26, 38, 255]);
  const totalCues = sequence.lanes.reduce((acc, l) => acc + l.cues.length, 0);
  canvas.drawText(
    `CUTHOL TIMELINE | ${sequence.meta.project_id} R${sequence.meta.revision} | DUR ${formatTimecode(totalDurationMs)} (${totalDurationMs}MS) | SPINE ${sequence.spine.clips.length} | CUES ${totalCues}`,
    16,
    14,
    [241, 245, 249, 255],
    2
  );

  // 2. Time Ruler & Vertical Grid Lines
  canvas.fillRect(0, headerH, canvasW, rulerH, [15, 21, 32, 255]);
  const msToX = (ms: number): number =>
    trackAreaX + Math.round((Math.max(0, Math.min(totalDurationMs, ms)) / totalDurationMs) * trackAreaW);

  const rawStepMs = totalDurationMs <= 5000 ? 500 : totalDurationMs <= 20000 ? 1000 : 2000;
  for (let tMs = 0; tMs <= totalDurationMs; tMs += rawStepMs) {
    const gx = msToX(tMs);
    canvas.drawLine(gx, headerH + rulerH - 6, gx, canvasH - bottomPad, [30, 41, 59, 180], 1);
    canvas.drawLine(gx, headerH + rulerH - 8, gx, headerH + rulerH, [148, 163, 184, 255], 1);
    const secLabel = `${(tMs / 1000).toFixed(tMs % 1000 === 0 ? 0 : 1)}S`;
    canvas.drawText(secLabel, Math.max(trackAreaX, gx - 10), headerH + 8, [148, 163, 184, 255], 1);
  }

  // Also draw red dashed warning line if any lane cue extends past spine end
  const spineEndMs = sequence.spine.clips.reduce(
    (mx, c) => Math.max(mx, c.timeline_in_ms + c.duration_ms),
    0
  );
  if (spineEndMs > 0 && spineEndMs < totalDurationMs) {
    const sx = msToX(spineEndMs);
    canvas.drawLine(sx, headerH + rulerH, sx, canvasH - bottomPad, [239, 68, 68, 220], 2);
    canvas.drawLine(sx + 1, headerH + rulerH, sx + 1, canvasH - bottomPad, [239, 68, 68, 220], 2);
    canvas.drawText("SPINE END", Math.max(trackAreaX + 4, sx - 58), headerH + rulerH + 2, [248, 113, 113, 255], 1);
  }

  const libMap = new Map(sequence.library.map((item) => [item.handle, item]));
  const ledger = fs.existsSync(paths.ledgerFile) ? new MediaLedger(paths.ledgerFile) : null;

  try {
    let curY = headerH + rulerH + 10;

    const drawLaneRow = (lane: (typeof sequence.lanes)[number]): void => {
      // Track label cell
      canvas.fillRect(8, curY, leftLabelW - 14, laneRowH, [20, 29, 43, 255]);
      canvas.strokeRect(8, curY, leftLabelW - 14, laneRowH, 1, [51, 65, 85, 255]);
      const lockTag = lane.locked ? " [LOCK]" : "";
      const muteTag = lane.muted ? " [MUTE]" : "";
      canvas.drawText(
        `${lane.id}${lockTag}${muteTag}`,
        14,
        curY + 10,
        lane.locked ? [250, 204, 21, 255] : [226, 232, 240, 255],
        1
      );
      canvas.drawText(
        `${lane.kind.toUpperCase()} Z:${lane.z_index}`,
        14,
        curY + 28,
        [148, 163, 184, 255],
        1
      );

      // Track background
      canvas.fillRect(trackAreaX, curY, trackAreaW, laneRowH, [16, 23, 35, 255]);
      canvas.strokeRect(trackAreaX, curY, trackAreaW, laneRowH, 1, [38, 50, 70, 255]);

      for (const cue of lane.cues) {
        const startMs = resolveCueStartMs(sequence, cue);
        const endMs = startMs + cue.duration_ms;
        const visStartMs = Math.max(0, Math.min(totalDurationMs, startMs));
        const visEndMs = Math.max(visStartMs, Math.min(totalDurationMs, endMs));
        const x0 = msToX(visStartMs);
        const x1 = Math.max(x0 + 6, msToX(visEndMs));
        const w = x1 - x0;
        const { fill, border } = colorForCueKind(cue.kind);

        canvas.fillRect(x0, curY + 4, w, laneRowH - 8, fill);
        canvas.strokeRect(x0, curY + 4, w, laneRowH - 8, 2, border);

        const anchorTag = cue.anchor ? `@${cue.anchor.ref}` : "";
        const modeTag =
          cue.composition?.mode === "scene_host" ? "[B:HOST]" : cue.composition ? "[A:ALPHA]" : "";
        const cueTitle = `${cue.id}${anchorTag}${modeTag}`;
        if (w >= 36) {
          canvas.drawText(cueTitle.slice(0, Math.floor((w - 8) / 6)), x0 + 5, curY + 10, [255, 255, 255, 255], 1);
        }

        // If music/audio cue has a gain_db ducking envelope, plot the envelope curve across the cue block!
        const gainEnv = cue.envelopes.find((e) => e.parameter === "audio_chain.gain_db");
        if (gainEnv && gainEnv.points.length > 0 && w >= 12) {
          let prevPx = x0;
          let prevPy = curY + 20;
          const steps = Math.max(8, Math.min(240, Math.floor(w / 3)));
          const visSpanMs = Math.max(1, visEndMs - visStartMs);
          for (let s = 0; s <= steps; s++) {
            const ratio = s / steps;
            const seqSampleMs = visStartMs + ratio * visSpanMs;
            const localMs = Math.max(0, Math.min(cue.duration_ms, seqSampleMs - startMs));
            const dbVal = evaluateEnvelopeAt(gainEnv, localMs); // typically 0 dB .. -12 dB
            const normDip = Math.max(-18, Math.min(3, dbVal));
            // 0 dB sits near top (curY + 18), -12 dB dips toward bottom (curY + laneRowH - 10)
            const py = Math.round(curY + 20 + ((-normDip) / 16) * (laneRowH - 30));
            const px = Math.round(x0 + ratio * w);
            if (s > 0) {
              canvas.drawLine(prevPx, prevPy, px, py, [250, 204, 21, 255], 2);
              canvas.drawLine(prevPx, prevPy + 1, px, py + 1, [250, 204, 21, 255], 2);
            }
            prevPx = px;
            prevPy = py;
          }
        }

        // If music cue has cached beats, draw beat ticks along the bottom edge
        if (ledger && cue.asset_handle && (cue.kind === "music" || lane.kind === "music")) {
          const asset = libMap.get(cue.asset_handle);
          if (asset) {
            const beatData = ledger.getLatestBeats<BeatAnalysisResult>(asset.digest_sha256);
            if (beatData?.beats_ms?.length) {
              const srcIn = cue.source_in_ms ?? 0;
              beatData.beats_ms.forEach((bMs, idx) => {
                if (bMs < srcIn || bMs > srcIn + cue.duration_ms) return;
                const seqBeatMs = startMs + (bMs - srcIn);
                if (seqBeatMs < 0 || seqBeatMs > totalDurationMs) return;
                const bx = msToX(seqBeatMs);
                if (bx >= x0 && bx <= x1) {
                  const tickH = idx % 4 === 0 ? 10 : 5;
                  canvas.drawLine(
                    bx,
                    curY + laneRowH - 5 - tickH,
                    bx,
                    curY + laneRowH - 5,
                    idx % 4 === 0 ? [244, 114, 182, 255] : [147, 197, 253, 200],
                    1
                  );
                }
              });
            }
          }
        }
      }

      curY += laneRowH + rowGap;
    };

    // 3. Over-spine visual lanes (top)
    for (const lane of overLanes) {
      drawLaneRow(lane);
    }

    // 4. Primary Narrative SPINE row (center)
    canvas.fillRect(8, curY, leftLabelW - 14, spineRowH, [30, 41, 59, 255]);
    canvas.strokeRect(8, curY, leftLabelW - 14, spineRowH, 2, [56, 189, 248, 255]);
    canvas.drawText("SPINE (MAIN)", 14, curY + 14, [56, 189, 248, 255], 1);
    canvas.drawText(`${sequence.spine.clips.length} CLIPS`, 14, curY + 34, [226, 232, 240, 255], 1);

    canvas.fillRect(trackAreaX, curY, trackAreaW, spineRowH, [18, 28, 44, 255]);
    canvas.strokeRect(trackAreaX, curY, trackAreaW, spineRowH, 2, [56, 189, 248, 180]);

    for (const clip of sequence.spine.clips) {
      const startMs = clip.timeline_in_ms;
      const endMs = startMs + clip.duration_ms;
      const x0 = msToX(startMs);
      const x1 = Math.max(x0 + 8, msToX(endMs));
      const w = x1 - x0;

      canvas.fillRect(x0, curY + 4, w, spineRowH - 8, [15, 62, 96, 235]);
      canvas.strokeRect(x0, curY + 4, w, spineRowH - 8, 2, [56, 189, 248, 255]);

      const rateTag =
        clip.playback.speed_ramp && clip.playback.speed_ramp.length > 0
          ? " [RAMP]"
          : Math.abs(clip.playback.rate - 1.0) > 0.01
            ? ` [${clip.playback.rate}X]`
            : "";
      const envTag = clip.envelopes.length > 0 ? ` [ENV:${clip.envelopes.length}]` : "";
      const clipLabel = `${clip.id}:${clip.asset_handle}${rateTag}${envTag}`;
      if (w >= 40) {
        canvas.drawText(clipLabel.slice(0, Math.floor((w - 8) / 6)), x0 + 6, curY + 10, [255, 255, 255, 255], 1);
      }

      // Draw mini waveform bars inside spine clip if cached
      if (ledger && !clip.audio_chain.muted) {
        const asset = libMap.get(clip.asset_handle);
        if (asset) {
          const wave = ledger.getLatestWaveform<WaveformAnalysisResult>(asset.digest_sha256);
          if (wave?.bins?.length && w >= 16) {
            const barCount = Math.max(4, Math.min(120, Math.floor(w / 4)));
            const waveBottomY = curY + spineRowH - 8;
            const maxBarH = 26;
            const binDur = Math.max(0.001, wave.duration_ms / wave.bins.length);
            for (let b = 0; b < barCount; b++) {
              const ratio = (b + 0.5) / barCount;
              const seqMs = startMs + ratio * clip.duration_ms;
              const srcMs = sequenceMsToSourceMs(clip, seqMs);
              const bIdx = Math.max(0, Math.min(wave.bins.length - 1, Math.floor(srcMs / binDur)));
              const peak = wave.bins[bIdx]?.peak_norm ?? 0.05;
              const bh = Math.max(2, Math.round(peak * maxBarH));
              const bx = Math.round(x0 + ratio * w);
              canvas.drawLine(bx, waveBottomY - bh, bx, waveBottomY, [125, 211, 252, 210], 2);
              canvas.drawLine(bx + 1, waveBottomY - bh, bx + 1, waveBottomY, [125, 211, 252, 210], 2);
            }
          }
        }
      }
    }

    // Second pass on SPINE: draw transition_out indicators at their exact render time window:
    // - Cross-transitions (`hasNextClip && kind !== "fade"`): `[endMs .. endMs + duration_ms]` (matching `tpad` hold + incoming fade)
    // - Fade-to-black / tail transitions (`!hasNextClip || kind === "fade"`): `[endMs - duration_ms .. endMs]`
    for (let i = 0; i < sequence.spine.clips.length; i++) {
      const clip = sequence.spine.clips[i];
      if (!clip.transition_out || clip.transition_out.duration_ms <= 0) continue;
      const hasNextClip = i < sequence.spine.clips.length - 1;
      const startMs = clip.timeline_in_ms;
      const endMs = startMs + clip.duration_ms;
      const isCrossTrans = hasNextClip && clip.transition_out.kind !== "fade";
      const tStartMs = isCrossTrans
        ? endMs
        : Math.max(startMs, endMs - clip.transition_out.duration_ms);
      const tEndMs = isCrossTrans
        ? endMs + clip.transition_out.duration_ms
        : endMs;
      const tx0 = msToX(tStartMs);
      const tx1 = Math.max(tx0 + 8, msToX(tEndMs));
      const transW = tx1 - tx0;
      canvas.fillRect(tx0, curY + 6, transW, spineRowH - 12, [245, 158, 11, 165]);
      canvas.drawLine(tx0, curY + spineRowH - 6, tx1, curY + 6, [251, 191, 36, 255], 2);
      canvas.drawLine(tx0, curY + spineRowH - 7, tx1, curY + 5, [251, 191, 36, 255], 2);
    }

    curY += spineRowH + rowGap;

    // 5. Under-spine lanes (bottom: audio, music, voiceover)
    for (const lane of underLanes) {
      drawLaneRow(lane);
    }
  } finally {
    ledger?.close();
  }

  const defaultOut = path.join(paths.monitorDir, `timeline_r${sequence.meta.revision}.png`);
  const resolvedOut = options.outputPath
    ? path.isAbsolute(options.outputPath)
      ? options.outputPath
      : path.resolve(paths.rootDir, options.outputPath)
    : defaultOut;

  canvas.saveAs(resolvedOut);

  return {
    ok: true,
    png_path: resolvedOut,
    width: canvasW,
    height: canvasH,
    duration_ms: totalDurationMs,
    spine_clips_count: sequence.spine.clips.length,
    lanes_count: totalRowsCount - 1,
    cues_count: totalCues,
  };
}
