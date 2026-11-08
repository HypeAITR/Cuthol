/**
 * N1 regression: pitch-preserving speed ramp must not lose audio at slice joints.
 *
 * A clip with a 12 ms 1500 Hz tick + white flash every second (generated in-test
 * with lavfi, same geometry as the field report: ramp 0s:1 -> 3s:3 over 8 s,
 * `preserve_pitch: true`) renders every tick within 1 frame of the exact ramp
 * integral, and every tick stays within 1 frame of its video flash.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import type { CutholSequence } from "../core/schema.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip, setSpineSpeed } from "../sequence/spine.js";
import { sourceMsToClipLocalMs } from "../sequence/spine_time.js";

type SpineClipSpec = CutholSequence["spine"]["clips"][number];

const FRAME_MS = 1000 / 30;

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

/** Rising-edge tick times (s) from 2 ms RMS windows. */
function findTickEvents(x: Float32Array, sr: number): number[] {
  const w = Math.floor(0.002 * sr);
  const winCount = Math.floor((x.length - w) / w);
  const e: number[] = [];
  let max = 0;
  for (let k = 0; k < winCount; k++) {
    let sumSq = 0;
    for (let i = k * w; i < (k + 1) * w; i++) sumSq += x[i] * x[i];
    const rms = Math.sqrt(sumSq / w);
    e.push(rms);
    if (rms > max) max = rms;
  }
  const thr = max * 0.3;
  const ev: number[] = [];
  for (let k = 1; k < e.length; k++) {
    if (e[k] > thr && e[k - 1] <= thr && (ev.length === 0 || (k * w) / sr - ev[ev.length - 1] > 0.15)) {
      ev.push((k * w) / sr);
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

test("audio ramp ticks: pitch-preserving ramp keeps all 8 ticks within 1 frame of video", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-ramp-ticks-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "audio ramp ticks", aspect: "16:9", fps: 30 });
    // 12 ms 1500 Hz tick + white flash every second for 8 s.
    const tick = "if(lt(mod(t,1.0),0.012),0.9*sin(2*PI*1500*t),0)";
    const media = path.join(tmp, "ticks.mkv");
    runFfmpeg([
      "-f", "lavfi", "-i", "nullsrc=s=320x180:r=30,geq=lum='if(lt(mod(T,1.0),0.04),235,16)':cb=128:cr=128",
      "-f", "lavfi", "-i", `aevalsrc='${tick}|${tick}':s=48000:d=8`,
      "-t", "8",
      "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
      "-c:a", "pcm_s16le",
      media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 8000 });
    setSpineSpeed({
      workspaceDir: wsDir,
      clipId: "sp_01",
      speedRamp: [
        { source_offset_ms: 0, rate: 1.0 },
        { source_offset_ms: 3000, rate: 3.0 },
      ],
    });
    const { sequence, paths } = loadSequence(wsDir);
    const clip: SpineClipSpec = sequence.spine.clips[0];
    assert.equal(clip.playback.preserve_pitch, true, "pitch preservation must default to true");

    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {});
    const out = path.join(tmp, "ramp.mkv");
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
    // The t=0 tick has no rising edge; check its energy directly.
    let headPeak = 0;
    for (let i = 0; i < Math.min(audio.length, Math.floor(0.05 * sr)); i++) {
      headPeak = Math.max(headPeak, Math.abs(audio[i]));
    }
    assert.ok(headPeak > 0.3, `t=0 tick lost (head peak ${headPeak.toFixed(3)})`);

    const audioEvents = findTickEvents(audio, sr);
    const { w, h } = probeVideoSize(out);
    const videoEvents = brightGroups(frameAverageY(out, w, h), 100).map((g) => g[0] / 30);
    assert.ok(videoEvents.length >= 8, `too few flash groups: ${videoEvents.length}`);

    let worst = 0;
    for (const s of [1000, 2000, 3000, 4000, 5000, 6000, 7000]) {
      const exp = sourceMsToClipLocalMs(clip, s) / 1000;
      const nearA = audioEvents.reduce((b, t) => (Math.abs(t - exp) < Math.abs(b - exp) ? t : b), 1e9);
      const nearV = videoEvents.reduce((b, t) => (Math.abs(t - exp) < Math.abs(b - exp) ? t : b), 1e9);
      assert.ok(
        Math.abs(nearA - exp) * 1000 <= FRAME_MS,
        `S=${s}: audio tick at ${(nearA - exp) * 1000}ms from expectation (lost or drifted)`
      );
      assert.ok(
        Math.abs(nearV - exp) * 1000 <= FRAME_MS,
        `S=${s}: video flash at ${(nearV - exp) * 1000}ms from expectation`
      );
      const dAV = Math.abs(nearA - nearV) * 1000;
      worst = Math.max(worst, Math.abs(nearA - exp) * 1000, dAV);
      assert.ok(dAV <= FRAME_MS, `S=${s}: tick-flash gap ${dAV.toFixed(1)}ms exceeds 1 frame`);
    }
    console.log(`ramp ticks (pp=true): 8/8 present, worst deviation ${worst.toFixed(1)}ms`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
