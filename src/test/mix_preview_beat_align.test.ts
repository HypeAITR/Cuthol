/**
 * (`src/test/mix_preview_beat_align.test.ts`).
 *
 * Verifies:
 * 1. `mix.normalize` closed-loop master bus calibration reaches target LUFS (±1.0 LU) and true peak (<= -1.0 dBTP)
 *    in the actual rendered MP4 even when individual speech clips have high crest factor or mono-to-stereo pan loss,
 *    and explicitly reports `target_reached: false` + `warning` when target cannot be reached.
 * 2. `composition.preview` compiles the full multi-clip spine underneath `[cueStart, cueEnd]` so each sampled
 *    timestamp on the 3-column contact sheet displays the true active spine shot at that moment.
 * 3. `mix.beat_align` enforces `tolerance_ms` (and CLI `--tolerance` / `--preserve-duration`), leaves out-of-tolerance
 *    clips untouched with `OUT_OF_TOLERANCE` in `decision_trace`, and warns on significant total duration changes.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { previewAndCheckComposition } from "../compositor/composition_preview.js";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import { PngCanvas } from "../core/png_canvas.js";
import { initWorkspace, loadSequence, stepJournal } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { alignClipsToBeats, duckMusicUnderDialogue, normalizeSequenceAudio } from "../mix/audio_mix.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/mix_preview_beat_align_test");

test("1. mix.normalize: closed-loop master bus calibration reaches target LUFS (±1 LU) & true peak (<= -1 dBTP) in rendered MP4", () => {
  const wsDir = path.join(TEST_ROOT, "ws_norm_master");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Master Mix Normalize Test", aspect: "16:9", fps: 30 });

  const mediaDir = path.join(wsDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const brollMp4 = path.join(mediaDir, "broll.mp4");
  const voMp3 = path.join(mediaDir, "vo_high_crest_mono.wav");
  const bgmWav = path.join(mediaDir, "bgm_stereo.wav");

  // Silent video spine
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1E293B:s=640x360:r=30:d=6",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    brollMp4,
  ]);

  // Mono voiceover with ~ -19 LUFS integrated loudness but a single transient spike near -0.8 dBTP at t=0.2s
  // (reproducing the exact condition where per-clip peak clamping previously stalled gain at -0.2 dB)
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='if(between(t,0.20,0.22),0.90*sin(2*PI*800*t),0.14*sin(2*PI*240*t)+0.08*sin(2*PI*900*t))':s=48000:c=mono:d=6",
    "-c:a",
    "pcm_s16le",
    voMp3,
  ]);

  // Stereo background music
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.18*sin(2*PI*110*t)+0.10*sin(2*PI*440*t)|0.18*sin(2*PI*110*t)+0.10*sin(2*PI*440*t)':s=48000:d=6",
    "-c:a",
    "pcm_s16le",
    bgmWav,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [brollMp4, voMp3, bgmWav] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 6000 });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_vo",
    kind: "voiceover",
    explicitId: "cue_01",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: 6000,
  });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    explicitId: "cue_02",
    assetHandle: "aud_02",
    atMs: 0,
    durationMs: 6000,
  });
  duckMusicUnderDialogue({
    workspaceDir: wsDir,
    bgmLaneId: "ln_bgm",
    duckDb: -12,
  });

  const normRes = normalizeSequenceAudio({
    workspaceDir: wsDir,
    targetLufs: -14.0,
    truePeakDbtp: -1.0,
  });

  assert.equal(normRes.verification.ok, true);
  assert.equal(normRes.verification.warning_count, 0, "G5_SIGNAL must not emit false CUTHOL-G501 warnings");
  assert.equal(normRes.target_reached, true, "Expected normalize to reach -14 LUFS target");
  assert.ok(
    Math.abs(normRes.achieved_lufs - -14.0) <= 1.0,
    `Expected achieved_lufs within -14 ± 1.0 LUFS, got ${normRes.achieved_lufs}`
  );
  assert.ok(
    normRes.achieved_true_peak_dbtp <= -1.0,
    `Expected achieved_true_peak_dbtp <= -1.0 dBTP, got ${normRes.achieved_true_peak_dbtp}`
  );
  assert.ok(normRes.master_gain_db > 2.0, `Expected positive master bus makeup gain, got ${normRes.master_gain_db}`);

  // Render draft MP4 and independently verify with ffmpeg ebur128=peak=true
  const outMp4 = path.join(wsDir, "output", "norm_out.mp4");
  const renderRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    outputPath: outMp4,
    preset: "draft_480p",
  });
  assert.equal(renderRes.ok, true);

  const eburProc = spawnSync(
    "ffmpeg",
    ["-nostats", "-v", "info", "-i", outMp4, "-af", "ebur128=peak=true", "-f", "null", "-"],
    { encoding: "utf8" }
  );
  const stderr = eburProc.stderr || "";
  const summaryBlock = stderr.slice(stderr.lastIndexOf("Summary:"));
  const renderedLufs = Number(/I:\s*([-\d.]+)\s*LUFS/i.exec(summaryBlock)?.[1]);
  const renderedPeak = Number(/Peak:\s*([-\d.]+)\s*dBFS/i.exec(summaryBlock)?.[1]);

  assert.ok(
    Number.isFinite(renderedLufs) && Math.abs(renderedLufs - -14.0) <= 1.0,
    `Rendered MP4 integrated loudness must be -14 ± 1 LUFS, got ${renderedLufs} LUFS`
  );
  assert.ok(
    Number.isFinite(renderedPeak) && renderedPeak <= -1.0,
    `Rendered MP4 true peak must be <= -1.0 dBTP, got ${renderedPeak} dBTP`
  );

  // Undo must cleanly revert stage.master_audio
  stepJournal(wsDir, "undo");
  assert.equal(loadSequence(wsDir).sequence.stage.master_audio, undefined);

  // Extremely quiet signal (-100 dBFS) where even maximum clip + master gain cannot reach -14 LUFS:
  // must report target_reached=false & explicit warning
  const silentWs = path.join(TEST_ROOT, "ws_norm_unreachable");
  fs.rmSync(silentWs, { recursive: true, force: true });
  initWorkspace({ dir: silentWs, title: "Unreachable Loudness Test", aspect: "16:9", fps: 30 });
  const quietWav = path.join(mediaDir, "sparse_impulse.wav");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.00001*sin(2*PI*400*t)':s=48000:c=mono:d=4",
    "-c:a",
    "pcm_s16le",
    quietWav,
  ]);
  ingestAssetsIntoWorkspace({ workspaceDir: silentWs, filePaths: [brollMp4, quietWav] });
  appendSpineClip({ workspaceDir: silentWs, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
  addLaneCue({
    workspaceDir: silentWs,
    laneId: "ln_vo",
    kind: "voiceover",
    explicitId: "cue_01",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: 4000,
  });
  const unreachRes = normalizeSequenceAudio({ workspaceDir: silentWs, targetLufs: -14.0 });
  assert.equal(unreachRes.target_reached, false, "Ultra-sparse impulse audio must report target_reached=false");
  assert.ok(
    typeof unreachRes.warning === "string" && unreachRes.warning.includes("-14"),
    "Expected explicit warning when target cannot be reached"
  );
});

test("2. composition.preview: multi-clip spine renders distinct underlying shots at each sampled timestamp", () => {
  const wsDir = path.join(TEST_ROOT, "ws_multi_preview");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Multi Spine Preview Test", aspect: "16:9", fps: 30 });

  const mediaDir = path.join(wsDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const redMp4 = path.join(mediaDir, "shot1_red.mp4");
  const greenMp4 = path.join(mediaDir, "shot2_green.mp4");
  const blueMp4 = path.join(mediaDir, "shot3_blue.mp4");

  for (const [file, hex] of [
    [redMp4, "#DC2626"],
    [greenMp4, "#16A34A"],
    [blueMp4, "#2563EB"],
  ] as const) {
    spawnSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${hex}:s=640x360:r=30:d=3`,
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
  }

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [redMp4, greenMp4, blueMp4] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 }); // 0..2s Red
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_02", sourceInMs: 0, sourceOutMs: 2000 }); // 2..4s Green
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_03", sourceInMs: 0, sourceOutMs: 2000 }); // 4..6s Blue

  const compDir = path.join(wsDir, "compositions/badge_multi");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    compositionId: "main",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 6000,
    preset: "badge_overlay",
    transparent: true,
  });

  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    explicitId: "cue_01",
    atMs: 0,
    durationMs: 6000,
    composition: {
      composition_dir: "compositions/badge_multi",
      entry_html: "index.html",
      props: {},
      transparent: true,
    },
  });

  const prevRes = previewAndCheckComposition({
    workspaceDir: wsDir,
    cueId: "cue_01",
    atSeconds: [1.0, 3.0, 5.0],
  });

  assert.equal(prevRes.ok, true);
  assert.equal(prevRes.alpha_gate.passed, true);
  assert.ok(fs.existsSync(prevRes.contact_sheet_path));

  // Decode contact sheet and sample center of Column 2 ("2. REAL FOOTAGE COMPOSITE") for rows 0, 1, 2
  const sheetW = 12 + 3 * (420 + 12);
  const cellH = Math.round((420 * 1080) / 1920);
  const sheetH = 44 + 24 + 12 + 3 * (cellH + 12);
  const rawProc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      prevRes.contact_sheet_path,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    { maxBuffer: sheetW * sheetH * 4 + 1024 * 1024 }
  );
  const pixels = rawProc.stdout as Buffer;
  const sampleCol2Center = (rowIdx: number): [number, number, number] => {
    const cx = 12 + (420 + 12) + 210; // Center X of Column 2
    const cy = 44 + 24 + 12 + rowIdx * (cellH + 12) + Math.floor(cellH / 2);
    const idx = (cy * sheetW + cx) * 4;
    return [pixels[idx], pixels[idx + 1], pixels[idx + 2]];
  };

  const [r0, g0, b0] = sampleCol2Center(0); // t=1.0s -> sp_01 (Red)
  const [r1, g1, b1] = sampleCol2Center(1); // t=3.0s -> sp_02 (Green)
  const [r2, g2, b2] = sampleCol2Center(2); // t=5.0s -> sp_03 (Blue)

  assert.ok(r0 > 150 && g0 < 80 && b0 < 80, `Row 0 (t=1s) must show Red clip sp_01, got RGB(${r0},${g0},${b0})`);
  assert.ok(g1 > 120 && r1 < 80 && b1 < 80, `Row 1 (t=3s) must show Green clip sp_02, got RGB(${r1},${g1},${b1})`);
  assert.ok(b2 > 150 && r2 < 80 && g2 < 100, `Row 2 (t=5s) must show Blue clip sp_03, got RGB(${r2},${g2},${b2})`);
  void PngCanvas;
});

test("3. mix.beat_align: enforces tolerance, reports OUT_OF_TOLERANCE, supports --tolerance CLI flag & warns on large duration shifts", () => {
  const wsDir = path.join(TEST_ROOT, "ws_beat_tolerance");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Beat Align Tolerance Test", aspect: "9:16", fps: 30 });

  const mediaDir = path.join(wsDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const clipMp4 = path.join(mediaDir, "clip.mp4");
  const sparseBeatsWav = path.join(mediaDir, "sparse_beats.wav");

  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#334155:s=360x640:r=30:d=12",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    clipMp4,
  ]);

  // Create a beat track with impulses at t = 1.4s, 6.08s, 8.12s, 10.18s, 15.2s (leaving a huge gap between 1.4s and 6.08s)
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='(if(between(t,1.40,1.46)+between(t,6.06,6.12)+between(t,8.10,8.16)+between(t,10.16,10.22)+between(t,15.20,15.26),0.95,0.01))*sin(2*PI*140*t)':s=48000:d=18",
    "-c:a",
    "pcm_s16le",
    sparseBeatsWav,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [clipMp4, sparseBeatsWav] });
  for (let i = 0; i < 6; i++) {
    appendSpineClip({
      workspaceDir: wsDir,
      assetHandle: "vid_01",
      sourceInMs: i * 1000,
      sourceOutMs: i * 1000 + 2000,
    });
  }

  // 3a. Align with explicit 250ms tolerance: clips far from beats must remain 2000ms and emit OUT_OF_TOLERANCE
  const resDefault = alignClipsToBeats({
    workspaceDir: wsDir,
    bgmHandle: "aud_01",
    toleranceMs: 250,
  });

  for (const aligned of resDefault.aligned_clips) {
    const shift = Math.abs(aligned.new_duration_ms - aligned.old_duration_ms);
    assert.ok(
      shift <= resDefault.tolerance_ms + 35,
      `Clip ${aligned.clip_id} shifted by ${shift}ms > tolerance ${resDefault.tolerance_ms}ms`
    );
  }
  assert.ok(
    resDefault.skipped_clips.some((s) => s.reason_code === "OUT_OF_TOLERANCE"),
    "Expected out-of-tolerance clips to be skipped with OUT_OF_TOLERANCE"
  );
  assert.ok(
    resDefault.decision_trace.decisions.some((d) => d.reason_code === "OUT_OF_TOLERANCE"),
    "Expected OUT_OF_TOLERANCE in decision_trace.decisions"
  );
  assert.ok(
    (resDefault.decision_trace.summary.by_reason.OUT_OF_TOLERANCE ?? 0) >= 2,
    "Expected OUT_OF_TOLERANCE count in decision_trace.summary.by_reason"
  );

  // Revert and test CLI `--tolerance` flag + duration warning when a huge tolerance (4000ms) is forced
  stepJournal(wsDir, "undo");
  const cliJs = path.resolve(process.cwd(), "dist/cli.js");
  const wideProc = spawnSync(
    process.execPath,
    [cliJs, "mix", "beat-align", "--bgm-handle", "aud_01", "--tolerance", "4000ms", "--dir", wsDir],
    { encoding: "utf8" }
  );
  assert.equal(wideProc.status, 0, wideProc.stderr);
  const wideJson = JSON.parse(wideProc.stdout);
  assert.equal(wideJson.tolerance_ms, 4000);
  assert.ok(
    typeof wideJson.duration_warning === "string" && wideJson.duration_warning.length > 0,
    "Expected duration_warning when wide tolerance causes significant total duration change"
  );
});
