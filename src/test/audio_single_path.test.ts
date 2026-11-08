/**
 * (`src/test/audio_single_path.test.ts`).
 *
 * Verifies:
 * 1. `compileSequenceRenderPlan` builds its entire audio filter graph by delegating to `compileSequenceAudioPlan`
 *    (spine audio, atempo speed chains, denoise, voice clarity, gain/ducking envelopes, fades, delays, master gain & limiter).
 * 2. `normalizeSequenceAudio` (`achieved_lufs`) matches the actual rendered MP4 (`ffmpeg -af ebur128=peak=true`)
 *    within <= 0.3 LU both on a standard multi-bus mix and on a speed-modified (`rate=1.25`) + fade + gain-envelope variation.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { compileSequenceAudioPlan, compileSequenceRenderPlan } from "../compositor/compiler.js";
import { initWorkspace, loadSequence, stepJournal } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { duckMusicUnderDialogue, normalizeSequenceAudio, polishVoiceAudio } from "../mix/audio_mix.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip, setItemEnvelope, setSpineSpeed } from "../sequence/spine.js";
import { commitVerifiedMutation } from "../verify/gates.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/audio_single_path_test");

function countFfmpegInputs(inputArgs: string[]): number {
  let count = 0;
  for (const arg of inputArgs) {
    if (arg === "-i") count++;
  }
  return count;
}

function measureMp4Ebur128(mp4Path: string): { lufs: number; peakDbtp: number } {
  const proc = spawnSync(
    "ffmpeg",
    ["-nostats", "-v", "info", "-i", mp4Path, "-af", "ebur128=peak=true", "-f", "null", "-"],
    { encoding: "utf8" }
  );
  const stderr = proc.stderr || "";
  const block = stderr.slice(stderr.lastIndexOf("Summary:"));
  const lufs = Number(/I:\s*([-\d.]+)\s*LUFS/i.exec(block)?.[1]);
  const peakDbtp = Number(/Peak:\s*([-\d.]+)\s*dBFS/i.exec(block)?.[1]);
  return { lufs, peakDbtp };
}

test("1. Single audio compilation path: compileSequenceRenderPlan audio graph is produced identically by compileSequenceAudioPlan", () => {
  const wsDir = path.join(TEST_ROOT, "ws_single_graph");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Single Audio Graph Path Test", aspect: "16:9", fps: 30 });

  const mediaDir = path.join(wsDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const spineMp4 = path.join(mediaDir, "spine_talk.mp4");
  const voWav = path.join(mediaDir, "vo_narration.wav");
  const bgmWav = path.join(mediaDir, "bgm_music.wav");

  // Spine video with speech-like audio
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1E293B:s=640x360:r=30:d=6",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.22*sin(2*PI*220*t)+0.10*sin(2*PI*660*t)':s=48000:c=stereo:d=6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    spineMp4,
  ]);

  // Voiceover audio
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.20*sin(2*PI*300*t)+0.08*sin(2*PI*900*t)':s=48000:c=mono:d=5",
    "-c:a",
    "pcm_s16le",
    voWav,
  ]);

  // BGM audio
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.15*sin(2*PI*110*t)|0.15*sin(2*PI*110*t)':s=48000:d=6",
    "-c:a",
    "pcm_s16le",
    bgmWav,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [spineMp4, voWav, bgmWav] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 6000 });
  setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", rate: 1.25 });

  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_vo",
    kind: "voiceover",
    explicitId: "cue_vo",
    assetHandle: "aud_01",
    atMs: 300,
    durationMs: 4200,
  });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    explicitId: "cue_bgm",
    assetHandle: "aud_02",
    atMs: 0,
    durationMs: 4800,
  });

  polishVoiceAudio({ workspaceDir: wsDir, clipIds: ["sp_01", "cue_vo"], nrDb: 12, enableClarity: true });
  duckMusicUnderDialogue({ workspaceDir: wsDir, bgmLaneId: "ln_bgm", duckDb: -10 });

  commitVerifiedMutation(wsDir, "configure-fades", (seq) => {
    seq.spine.clips[0].audio_chain.fade_in_ms = 250;
    seq.spine.clips[0].audio_chain.fade_out_ms = 400;
    for (const lane of seq.lanes) {
      for (const cue of lane.cues) {
        if (cue.audio_chain) {
          cue.audio_chain.fade_in_ms = 300;
          cue.audio_chain.fade_out_ms = 500;
        }
      }
    }
  });

  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_01",
    parameter: "audio_chain.gain_db",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 2000, value: -2.5, easing: "ease_in_out" },
      { offset_ms: 4500, value: 1.0, easing: "ease_out" },
    ],
  });

  normalizeSequenceAudio({ workspaceDir: wsDir, targetLufs: -14.0, truePeakDbtp: -1.0 });

  const { paths, sequence } = loadSequence(wsDir);
  const renderPlan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  const standaloneAudioPlan = compileSequenceAudioPlan(sequence, paths);

  const totalRenderInputs = countFfmpegInputs(renderPlan.inputArgs);
  const totalAudioInputs = countFfmpegInputs(standaloneAudioPlan.inputArgs);
  const videoInputOffset = totalRenderInputs - totalAudioInputs;

  const offsetAudioPlan = compileSequenceAudioPlan(sequence, paths, sequence.stage.master_audio, {
    inputIndexOffset: videoInputOffset,
  });

  // 1. The trailing inputArgs of compileSequenceRenderPlan must be identical to compileSequenceAudioPlan.inputArgs
  assert.deepEqual(
    renderPlan.inputArgs.slice(renderPlan.inputArgs.length - standaloneAudioPlan.inputArgs.length),
    standaloneAudioPlan.inputArgs,
    "compileSequenceRenderPlan must append the exact audio inputArgs from compileSequenceAudioPlan"
  );

  // 2. The audio portion of renderPlan.filterComplex must match offsetAudioPlan.filterComplex character-for-character
  assert.ok(
    renderPlan.filterComplex.endsWith(`;${offsetAudioPlan.filterComplex}`),
    "compileSequenceRenderPlan filterComplex must embed compileSequenceAudioPlan filterComplex verbatim"
  );

  // 3. Shift [k:a] indices back by videoInputOffset and verify exact equality with standalone measurement audio plan
  const renderAudioChains = renderPlan.filterComplex
    .split(";")
    .filter((c) => c.includes(":a]") || c.startsWith("[a_") || c.includes("[aout]"))
    .join(";");
  const normalizedRenderAudio = renderAudioChains.replace(/\[(\d+):a\]/g, (_, idx) => {
    return `[${Number(idx) - videoInputOffset}:a]`;
  });
  assert.equal(
    normalizedRenderAudio,
    standaloneAudioPlan.filterComplex,
    "Normalized render audio filter graph must be 100% identical to standalone compileSequenceAudioPlan graph"
  );
});

test("2. Measurement vs render loudness parity (<= 0.3 LU) on baseline mix and speed 1.25x + fade + envelope variation", () => {
  const wsDir = path.join(TEST_ROOT, "ws_lufs_parity");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Audio Loudness Parity Test", aspect: "16:9", fps: 30 });

  const mediaDir = path.join(wsDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const spineMp4 = path.join(mediaDir, "spine_av.mp4");
  const voWav = path.join(mediaDir, "vo.wav");
  const bgmWav = path.join(mediaDir, "bgm.wav");

  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#0F172A:s=640x360:r=30:d=8",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.18*sin(2*PI*200*t)+0.09*sin(2*PI*500*t)':s=48000:c=stereo:d=8",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    spineMp4,
  ]);

  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.24*sin(2*PI*260*t)+0.12*sin(2*PI*780*t)':s=48000:c=mono:d=7.5",
    "-c:a",
    "pcm_s16le",
    voWav,
  ]);

  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.16*sin(2*PI*110*t)+0.08*sin(2*PI*330*t)|0.16*sin(2*PI*110*t)+0.08*sin(2*PI*330*t)':s=48000:d=8",
    "-c:a",
    "pcm_s16le",
    bgmWav,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [spineMp4, voWav, bgmWav] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 8000 });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_vo",
    kind: "voiceover",
    explicitId: "cue_01",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: 7500,
  });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    explicitId: "cue_02",
    assetHandle: "aud_02",
    atMs: 0,
    durationMs: 8000,
  });
  duckMusicUnderDialogue({ workspaceDir: wsDir, bgmLaneId: "ln_bgm", duckDb: -12 });

  // Case A: Baseline normalize + draft render ebur128 check
  const normBase = normalizeSequenceAudio({ workspaceDir: wsDir, targetLufs: -14.0, truePeakDbtp: -1.0 });
  const baseMp4 = path.join(wsDir, "output", "base_draft.mp4");
  renderSequenceToMp4({ workspaceDir: wsDir, outputPath: baseMp4, preset: "draft_480p" });
  const baseMeasured = measureMp4Ebur128(baseMp4);
  const baseDiff = Math.abs(normBase.achieved_lufs - baseMeasured.lufs);
  assert.ok(
    baseDiff <= 0.3,
    `Expected baseline |achieved_lufs (${normBase.achieved_lufs}) - rendered_lufs (${baseMeasured.lufs})| <= 0.3 LU, got ${baseDiff.toFixed(2)} LU`
  );

  const revBeforeVariation = loadSequence(wsDir).sequence.meta.revision;

  // Case B: Speed 1.25x + fade-in/out + gain envelope variation
  setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", rate: 1.25 });
  commitVerifiedMutation(wsDir, "add-fades", (seq) => {
    seq.spine.clips[0].audio_chain.fade_in_ms = 400;
    seq.spine.clips[0].audio_chain.fade_out_ms = 600;
    for (const lane of seq.lanes) {
      for (const cue of lane.cues) {
        if (cue.audio_chain) {
          cue.audio_chain.fade_in_ms = 400;
          cue.audio_chain.fade_out_ms = 600;
        }
      }
    }
  });
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "cue_01",
    parameter: "audio_chain.gain_db",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 3000, value: -3.5, easing: "ease_in_out" },
      { offset_ms: 6000, value: 1.5, easing: "ease_in_out" },
    ],
  });

  const normVar = normalizeSequenceAudio({ workspaceDir: wsDir, targetLufs: -14.0, truePeakDbtp: -1.0 });
  const varMp4 = path.join(wsDir, "output", "var_draft.mp4");
  renderSequenceToMp4({ workspaceDir: wsDir, outputPath: varMp4, preset: "draft_480p" });
  const varMeasured = measureMp4Ebur128(varMp4);
  const varDiff = Math.abs(normVar.achieved_lufs - varMeasured.lufs);
  assert.ok(
    varDiff <= 0.3,
    `Expected variation |achieved_lufs (${normVar.achieved_lufs}) - rendered_lufs (${varMeasured.lufs})| <= 0.3 LU, got ${varDiff.toFixed(2)} LU`
  );

  // Undo variation back to baseline
  while (loadSequence(wsDir).sequence.meta.revision > revBeforeVariation) {
    stepJournal(wsDir, "undo");
  }
  assert.equal(loadSequence(wsDir).sequence.meta.revision, revBeforeVariation);
});
