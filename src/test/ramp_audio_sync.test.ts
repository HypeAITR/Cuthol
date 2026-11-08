/**
 * Ramp audio: audio follows the speed ramp's integral map too.
 *
 * Earlier, `playback.speed_ramp` applied to video only; audio was processed at a single
 * average rate and drifted hundreds of ms from video/captions mid-ramp.
 * This file proves sliced audio (atrim + slice rate + 5ms crossfade +
 * join) follows the same map.
 *
 * Measured results (from this file's tests, ramp 1->2 / 4s, 24 slices):
 * - sync: pulses within <= ~22ms of video and expectation (limit 1 frame = 33.3ms)
 * - tick: inter-sample jumps at slice joints 2.7x/2.0x of unramped (limit 4x)
 * - duration: clip audio = clip duration +-0.4ms (limit +-1ms)
 * - segment: windowed audio matches the full plan at sample level (every sample +-2
 *   neighbors <1e-3; worst measured 8.6e-5; inter-clip trim quantization
 *   differs by at most 2 samples)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceAudioPlan, compileSequenceRenderPlan } from "../compositor/compiler.js";
import type { CutholSequence } from "../core/schema.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip, setSpineSpeed } from "../sequence/spine.js";
import { invertClipLocalMsToSourceOffset, sourceMsToClipLocalMs } from "../sequence/spine_time.js";

type SpineClipSpec = CutholSequence["spine"]["clips"][number];

const FRAME_33MS = 1000 / 30;
const EVIDENCE_DIR = path.resolve(process.cwd(), "test-workspace/ramp_audio_sync");

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runFfmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? ""}`.slice(0, 2000));
}

function decodeAudioF32Mono(file: string, sr = 48000): Float32Array {
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-map", "0:a", "-f", "f32le", "-acodec", "pcm_f32le", "-ar", String(sr), "-ac", "1", "-"],
    { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0, "audio decode failed");
  const buf = proc.stdout as Buffer;
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** First-sample times (s) of events whose amplitude exceeds `thr`. */
function findPulseEvents(x: Float32Array, sr: number, thr: number, minGapSec: number): number[] {
  const ev: number[] = [];
  let i = 0;
  const gap = Math.floor(minGapSec * sr);
  while (i < x.length) {
    if (Math.abs(x[i]) > thr) {
      ev.push(i / sr);
      i += gap;
    } else {
      i++;
    }
  }
  return ev;
}

function probeVideoSize(file: string): { w: number; h: number } {
  const proc = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", "-select_streams", "v:0", file],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr ?? "");
  const [w, h] = (proc.stdout ?? "").trim().split(",").map(Number);
  assert.ok(w > 0 && h > 0, `size unreadable: ${proc.stdout ?? ""}`);
  return { w, h };
}

function frameAverageY(file: string, w: number, h: number): number[] {
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "yuv444p", "-"],
    { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0, "video decode failed");
  const buf = proc.stdout as Buffer;
  const ySize = w * h;
  const frameSize = ySize * 3;
  const n = Math.floor(buf.length / frameSize);
  const av: number[] = [];
  for (let f = 0; f < n; f++) {
    let s = 0;
    let c = 0;
    const off = f * frameSize;
    for (let i = off; i < off + ySize; i += 37) {
      s += buf[i];
      c++;
    }
    av.push(s / c);
  }
  return av;
}

/** First-frame indices of consecutive bright frames (each group one flash). */
function brightGroups(av: number[], thr: number): number[][] {
  const groups: number[][] = [];
  for (let f = 0; f < av.length; f++) {
    if (av[f] <= thr) continue;
    const g = groups[groups.length - 1];
    if (g && f === g[g.length - 1] + 1) g.push(f);
    else groups.push([f]);
  }
  return groups;
}

function renderAudioToWav(plan: { inputArgs: string[]; filterComplex: string; audioOutPad: string }, outWav: string): void {
  runFfmpeg([
    ...plan.inputArgs,
    "-filter_complex", plan.filterComplex,
    "-map", plan.audioOutPad,
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
    outWav,
  ]);
}

/**
 * Sync measurement: lossless source with an audio pulse every 0.5s plus a simultaneous
 * 2-frame white flash; ramped clip (1->2 / 4s) rendered A/V; for every inner event
 * (S=500..3500) audio and video times must match each other and the
 * `sourceMsToClipLocalMs` expectation within +-1 frame.
 */
async function runSyncCase(options: { withBed: boolean; preservePitch: boolean; evidence: boolean }): Promise<void> {
  const tmp = makeTempRoot("cuthol-audioramp-sync-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "audioramp sync", aspect: "16:9", fps: 30 });
    const pulse = "if(lt(mod(t,0.5),0.008),0.6,0)";
    const expr = options.withBed ? `(${pulse}+0.2*sin(2*PI*440*t))` : pulse.replace(/0\.6/g, "0.7");
    const media = path.join(tmp, "clicks.mkv");
    runFfmpeg([
      "-f", "lavfi", "-i", "nullsrc=s=320x180:r=30,geq=lum='if(lt(mod(T,0.5),0.05),235,16)':cb=128:cr=128",
      "-f", "lavfi", "-i", `aevalsrc='${expr}|${expr}':s=48000:d=8`,
      "-t", "8",
      "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
      "-c:a", "pcm_s16le",
      media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    setSpineSpeed({
      workspaceDir: wsDir,
      clipId: "sp_01",
      speedRamp: [
        { source_offset_ms: 0, rate: 1.0 },
        { source_offset_ms: 4000, rate: 2.0 },
      ],
    });
    setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", preservePitch: options.preservePitch });
    const { sequence, paths } = loadSequence(wsDir);
    const clip: SpineClipSpec = sequence.spine.clips[0];

    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {});
    const out = path.join(tmp, "sync.mkv");
    runFfmpeg([
      ...plan.inputArgs,
      "-filter_complex", plan.filterComplex,
      "-map", plan.videoOutPad, "-map", plan.audioOutPad,
      "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
      "-c:a", "pcm_s16le",
      out,
    ]);

    const sr = 48000;
    const audio = decodeAudioF32Mono(out, sr);
    const thr = options.withBed ? 0.45 : 0.35;
    const audioEvents = findPulseEvents(audio, sr, thr, 0.1);
    assert.ok(audioEvents.length >= 7, `too few audio pulses: ${audioEvents.length}`);

    const { w, h } = probeVideoSize(out);
    const groups = brightGroups(frameAverageY(out, w, h), 100);
    const videoEvents = groups.map((g) => g[0] / 30);
    assert.ok(videoEvents.length >= 7, `too few flash groups: ${videoEvents.length}`);

    if (options.evidence) {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      const flashT = videoEvents[1] ?? videoEvents[0];
      const flashPng = path.join(EVIDENCE_DIR, "sync_flash.png");
      const darkPng = path.join(EVIDENCE_DIR, "sync_dark.png");
      runFfmpeg(["-ss", String(flashT), "-i", out, "-frames:v", "1", flashPng]);
      runFfmpeg(["-ss", String(flashT + 0.12), "-i", out, "-frames:v", "1", darkPng]);
      console.log(`evidence frames: ${flashPng} (white flash) ${darkPng} (dark frame)`);
    }

    let worst = 0;
    for (const s of [500, 1000, 1500, 2000, 2500, 3000, 3500]) {
      const exp = sourceMsToClipLocalMs(clip, s) / 1000;
      const nearA = audioEvents.reduce((b, t) => (Math.abs(t - exp) < Math.abs(b - exp) ? t : b), 1e9);
      const nearV = videoEvents.reduce((b, t) => (Math.abs(t - exp) < Math.abs(b - exp) ? t : b), 1e9);
      assert.ok(Math.abs(nearA - exp) * 1000 < 50, `S=${s}: no audio event (nearest ${(nearA - exp) * 1000}ms)`);
      assert.ok(Math.abs(nearV - exp) * 1000 < 50, `S=${s}: no flash (nearest ${(nearV - exp) * 1000}ms)`);
      const dA = Math.abs(nearA - exp) * 1000;
      const dV = Math.abs(nearV - exp) * 1000;
      const dAV = Math.abs(nearA - nearV) * 1000;
      worst = Math.max(worst, dA, dV, dAV);
      assert.ok(dA <= FRAME_33MS, `S=${s}: audio-expectation ${dA.toFixed(1)}ms > 1 frame`);
      assert.ok(dV <= FRAME_33MS, `S=${s}: video-expectation ${dV.toFixed(1)}ms > 1 frame`);
      assert.ok(dAV <= FRAME_33MS, `S=${s}: audio-video ${dAV.toFixed(1)}ms > 1 frame`);
    }
    console.log(`sync (bed=${options.withBed}, pp=${options.preservePitch}): worst ${worst.toFixed(1)}ms`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("audioramp sync: ticks on the floor, preserve_pitch=true (real measure)", { timeout: 300_000 }, async () => {
  await runSyncCase({ withBed: true, preservePitch: true, evidence: true });
});

test("audioramp sync: ticks on the floor, preserve_pitch=false", { timeout: 300_000 }, async () => {
  await runSyncCase({ withBed: true, preservePitch: false, evidence: false });
});

test("audioramp sync: ticks in silence, preserve_pitch=false", { timeout: 300_000 }, async () => {
  await runSyncCase({ withBed: false, preservePitch: false, evidence: false });
});

test("audioramp sync: ticks in silence, preserve_pitch=true", { timeout: 300_000 }, async () => {
  await runSyncCase({ withBed: false, preservePitch: true, evidence: false });
});

function rampedSineProject(tmpPrefix: string, ramp: { source_offset_ms: number; rate: number }[] | null): { wsDir: string; clip: SpineClipSpec } {
  const tmp = makeTempRoot(tmpPrefix);
  const wsDir = path.join(tmp, "proj");
  initWorkspace({ dir: wsDir, title: "audioramp", aspect: "16:9", fps: 30 });
  const media = path.join(tmp, "sine.mkv");
  runFfmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=8",
    "-t", "8",
    "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le",
    media,
  ]);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
  if (ramp) {
    setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", speedRamp: ramp });
  }
  const clip = loadSequence(wsDir).sequence.spine.clips[0] as SpineClipSpec;
  return { wsDir, clip };
}

test("audioramp structure: ramped audio uses slices + crossfades (pp=true/false)", () => {
  const tmp = makeTempRoot("cuthol-audioramp-struct-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "audioramp struct", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "src.mkv");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=8",
      "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    setSpineSpeed({
      workspaceDir: wsDir, clipId: "sp_01",
      speedRamp: [
        { source_offset_ms: 0, rate: 1.0 },
        { source_offset_ms: 4000, rate: 2.0 },
      ],
    });
    for (const pp of [true, false]) {
      setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", preservePitch: pp });
      const { sequence, paths } = loadSequence(wsDir);
      const plan = compileSequenceAudioPlan(sequence, paths);
      const m = /asplit=(\d+)/.exec(plan.filterComplex);
      assert.ok(m, `pp=${pp}: no slice split (asplit):\n${plan.filterComplex.slice(0, 400)}`);
      assert.ok(Number(m[1]) >= 2, `pp=${pp}: slice count ${m[1]}`);
      assert.ok(
        plan.filterComplex.includes("acrossfade") || /concat=n=\d+/.test(plan.filterComplex),
        `pp=${pp}: no join (acrossfade/concat)`
      );
      if (pp) {
        assert.ok(plan.filterComplex.includes("atempo="), "pp=true: no atempo");
      } else {
        assert.ok(plan.filterComplex.includes("asetrate="), "pp=false: no asetrate");
        assert.ok(plan.filterComplex.includes("aresample="), "pp=false: no aresample");
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function maxSampleJumpInterior(x: Float32Array, sr: number, skipMs: number): { jump: number; atMs: number } {
  const a = Math.floor((skipMs * sr) / 1000);
  const b = x.length - a;
  let jump = 0;
  let at = -1;
  for (let i = Math.max(1, a); i < Math.min(x.length, b); i++) {
    const d = Math.abs(x[i] - x[i - 1]);
    if (d > jump) {
      jump = d;
      at = i;
    }
  }
  return { jump, atMs: (at / sr) * 1000 };
}

test("audioramp tick: joint jumps within a reasonable multiple of unramped", { timeout: 180_000 }, () => {
  const mk = (ramp: { source_offset_ms: number; rate: number }[] | null, pp: boolean): number => {
    const { wsDir } = rampedSineProject("cuthol-audioramp-click-", ramp);
    try {
      if (ramp) setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", preservePitch: pp });
      const { sequence, paths } = loadSequence(wsDir);
      const plan = compileSequenceAudioPlan(sequence, paths);
      const out = path.join(path.dirname(wsDir), `click_${pp}_${ramp ? "r" : "n"}.wav`);
      renderAudioToWav(plan, out);
      const x = decodeAudioF32Mono(out);
      return maxSampleJumpInterior(x, 48000, 50).jump;
    } finally {
      fs.rmSync(path.dirname(wsDir), { recursive: true, force: true });
    }
  };
  const ref = mk(null, true);
  const t = mk(
    [
      { source_offset_ms: 0, rate: 1.0 },
      { source_offset_ms: 4000, rate: 2.0 },
    ],
    true
  );
  const f = mk(
    [
      { source_offset_ms: 0, rate: 1.0 },
      { source_offset_ms: 4000, rate: 2.0 },
    ],
    false
  );
  console.log(`tick: unramped=${ref.toFixed(5)} ppT=${t.toFixed(5)} (${(t / ref).toFixed(2)}x) ppF=${f.toFixed(5)} (${(f / ref).toFixed(2)}x)`);
  assert.ok(t <= 4 * ref, `pp=true jump ${t.toFixed(5)} > 4x unramped ${ref.toFixed(5)}`);
  assert.ok(f <= 4 * ref, `pp=false jump ${f.toFixed(5)} > 4x unramped ${ref.toFixed(5)}`);
});

test("audioramp duration: clip audio = clip duration (±1ms)", { timeout: 180_000 }, () => {
  for (const pp of [true, false]) {
    const tmp = makeTempRoot("cuthol-audioramp-dur-");
    try {
      const wsDir = path.join(tmp, "proj");
      initWorkspace({ dir: wsDir, title: "audioramp dur", aspect: "16:9", fps: 30 });
      const media = path.join(tmp, "dc.mkv");
      runFfmpeg([
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
        "-f", "lavfi", "-i", "aevalsrc='0.5|0.5':s=48000:d=8",
        "-t", "8", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", media,
      ]);
      ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
      appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
      setSpineSpeed({
        workspaceDir: wsDir, clipId: "sp_01",
        speedRamp: [
          { source_offset_ms: 0, rate: 1.0 },
          { source_offset_ms: 4000, rate: 2.0 },
        ],
      });
      setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", preservePitch: pp });
      const { sequence, paths } = loadSequence(wsDir);
      const clip = sequence.spine.clips[0] as SpineClipSpec;
      const plan = compileSequenceAudioPlan(sequence, paths);
      const out = path.join(tmp, "dur.wav");
      renderAudioToWav(plan, out);
      const x = decodeAudioF32Mono(out);
      let last = -1;
      for (let i = x.length - 1; i >= 0; i--) {
        if (Math.abs(x[i]) > 0.25) {
          last = i;
          break;
        }
      }
      assert.ok(last > 0, "no audio found");
      const endMs = ((last + 1) / 48000) * 1000;
      const diff = endMs - clip.duration_ms;
      console.log(`duration pp=${pp}: audio end=${endMs.toFixed(3)}ms clip=${clip.duration_ms}ms diff=${diff.toFixed(3)}ms`);
      assert.ok(Math.abs(diff) <= 1.0, `pp=${pp}: audio duration diff ${diff.toFixed(3)}ms > 1ms`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test("audioramp segment: windowed audio matches the full plan at sample level", { timeout: 300_000 }, () => {
  const tmp = makeTempRoot("cuthol-audioramp-seg-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "audioramp seg", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "chirp.mkv");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
      "-f", "lavfi", "-i",
      "aevalsrc='0.35*sin(2*PI*(220+180*sin(2*PI*3.7*t))*t)+0.25*sin(2*PI*(510+290*cos(2*PI*7.3*t))*t)+0.15*sin(2*PI*113*t*t)':s=48000:d=10",
      "-t", "10", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 4000, sourceOutMs: 8000 });
    const ramp = [
      { source_offset_ms: 0, rate: 1.0 },
      { source_offset_ms: 4000, rate: 2.0 },
    ];
    setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", speedRamp: ramp });
    setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_02", speedRamp: ramp });
    const { sequence, paths } = loadSequence(wsDir);

    const fullPlan = compileSequenceAudioPlan(sequence, paths);
    const fullWav = path.join(tmp, "full.wav");
    renderAudioToWav(fullPlan, fullWav);
    const F = decodeAudioF32Mono(fullWav);

    for (const win of [[1000, 2000], [2000, 4000]] as Array<[number, number]>) {
      const winPlan = compileSequenceAudioPlan(sequence, paths, undefined, { activeWindowMs: win });
      const winWav = path.join(tmp, `win_${win[0]}.wav`);
      renderAudioToWav(winPlan, winWav);
      const W = decodeAudioF32Mono(winWav);
      const sr = 48000;
      const skip = Math.floor(0.05 * sr);
      const cmpLen = Math.min(W.length - 2 * skip, (win[1] - win[0] - 100) * (sr / 1000));
      assert.ok(cmpLen > 10000, "window too short");
      // Each clip has its own trim quantization (±2 samples); compare every sample
      // against the best ±2 neighbors (sample-wise bit-identity).
      let maxDiff = 0;
      let worstShift = 0;
      for (let i = 0; i < cmpLen; i += 1) {
        const wi = skip + i;
        const fi = Math.floor((win[0] / 1000) * sr) + skip + i;
        let bd = Infinity;
        let bs = 0;
        for (let sh = -2; sh <= 2; sh++) {
          if (wi < 0 || wi >= W.length || fi + sh < 0 || fi + sh >= F.length) continue;
          const d = Math.abs(W[wi] - F[fi + sh]);
          if (d < bd) {
            bd = d;
            bs = sh;
          }
        }
        if (bd > maxDiff) {
          maxDiff = bd;
          worstShift = bs;
        }
      }
      console.log(`segment [${win[0]},${win[1]}]: max diff=${maxDiff.toFixed(6)} (worst shift ${worstShift})`);
      assert.ok(maxDiff < 1e-3, `window diff ${maxDiff.toFixed(6)} >= 1e-3`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("audioramp window mapping: read range computed from the integral map", () => {
  const tmp = makeTempRoot("cuthol-audioramp-winmap-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "audioramp winmap", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "src.mkv");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=8",
      "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    setSpineSpeed({
      workspaceDir: wsDir, clipId: "sp_01",
      speedRamp: [
        { source_offset_ms: 0, rate: 1.0 },
        { source_offset_ms: 4000, rate: 2.0 },
      ],
    });
    const { sequence, paths } = loadSequence(wsDir);
    const clip = sequence.spine.clips[0] as SpineClipSpec;
    const plan = compileSequenceAudioPlan(sequence, paths, undefined, { activeWindowMs: [1000, 2000] });
    const m = /atrim=start=([\d.]+)/.exec(plan.filterComplex);
    assert.ok(m, "no atrim in the windowed plan");
    // Window [1000,2000], clip from the start: with 500ms pre-roll the read locally
    // starts at 500ms; the source comes from the inverse integral (not the average rate).
    const expectedSrcMs = Math.floor(invertClipLocalMsToSourceOffset(clip, 500));
    const gotSrcMs = Number(m[1]) * 1000;
    const avgSrcMs = Math.floor(500 * ((clip.source_out_ms - clip.source_in_ms) / clip.duration_ms));
    console.log(`window read: expected(integral)=${expectedSrcMs}ms in-plan=${gotSrcMs.toFixed(1)}ms if-average-rate=${avgSrcMs}ms`);
    assert.ok(Math.abs(gotSrcMs - expectedSrcMs) < 2, `read ${gotSrcMs.toFixed(1)}ms != integral ${expectedSrcMs}ms`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("audioramp unramped: no slice trace in the audio filter text", () => {
  const tmp = makeTempRoot("cuthol-audioramp-noramp-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "audioramp noramp", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "src.mkv");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=8",
      "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", rate: 1.25 });
    const { sequence, paths } = loadSequence(wsDir);
    const plan = compileSequenceAudioPlan(sequence, paths);
    assert.ok(!plan.filterComplex.includes("asplit="), "unramped plan has asplit");
    assert.ok(!plan.filterComplex.includes("acrossfade"), "unramped plan has acrossfade");
    assert.ok(!plan.filterComplex.includes("concat="), "unramped plan has concat");
    assert.ok(plan.filterComplex.includes("atempo=1.2500"), `expected atempo missing:\n${plan.filterComplex}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("audioramp G410: no audio warning on a mild ramp", () => {
  const tmp = makeTempRoot("cuthol-audioramp-g410a-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "audioramp g410", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "src.mkv");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=8",
      "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    const res = setSpineSpeed({
      workspaceDir: wsDir,
      clipId: "sp_01",
      speedRamp: [
        { source_offset_ms: 0, rate: 1.0 },
        { source_offset_ms: 4000, rate: 2.0 },
      ],
      preservePitch: false,
    });
    const g410 = res.verification.diagnostics.filter((d) => d.code === "CUTHOL-G410");
    assert.equal(g410.length, 0, `G410 fired on a mild ramp: ${JSON.stringify(g410.map((d) => d.what))}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("audioramp G410: honest quality warning at edge rates", () => {
  const tmp = makeTempRoot("cuthol-audioramp-g410b-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "audioramp g410x", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "src.mkv");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=8",
      "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    const res = setSpineSpeed({
      workspaceDir: wsDir,
      clipId: "sp_01",
      speedRamp: [
        { source_offset_ms: 0, rate: 1.0 },
        { source_offset_ms: 4000, rate: 4.0 },
      ],
      preservePitch: true,
    });
    const g410 = res.verification.diagnostics.filter((d) => d.code === "CUTHOL-G410");
    assert.equal(g410.length, 1, `no G410 at edge rates: ${JSON.stringify(res.verification.diagnostics.map((d) => d.code))}`);
    assert.match(g410[0].what, /0\.5\.\.2\.0/, `warning does not describe the out-of-range rate: ${g410[0].what}`);
    assert.ok(!/average rate/.test(g410[0].what), `old "average rate" message still there: ${g410[0].what}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("audioramp G410: no audio warning on a silent clip", () => {
  const tmp = makeTempRoot("cuthol-audioramp-g410c-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "audioramp g410s", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "silent.mp4");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
      "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    const res = setSpineSpeed({
      workspaceDir: wsDir,
      clipId: "sp_01",
      speedRamp: [
        { source_offset_ms: 0, rate: 1.0 },
        { source_offset_ms: 4000, rate: 4.0 },
      ],
    });
    const g410 = res.verification.diagnostics.filter((d) => d.code === "CUTHOL-G410");
    assert.equal(g410.length, 0, `G410 fired on a silent clip: ${JSON.stringify(g410.map((d) => d.what))}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

