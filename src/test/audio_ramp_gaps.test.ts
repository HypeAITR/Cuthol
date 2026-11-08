/**
 * N1 regression: no silent spans in pitch-preserving ramp audio where the source
 * has signal. Pink noise must render without any >= 3 ms exact-zero run, and
 * every tick of the tick clip must carry energy at its expected ramp time.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceAudioPlan } from "../compositor/compiler.js";
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

function renderAudioToWav(plan: { inputArgs: string[]; filterComplex: string; audioOutPad: string }, outWav: string): void {
  runFfmpeg([
    ...plan.inputArgs,
    "-filter_complex", plan.filterComplex,
    "-map", plan.audioOutPad,
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
    outWav,
  ]);
}

function rampedProject(tmp: string, media: string): { wsDir: string; clip: SpineClipSpec } {
  const wsDir = path.join(tmp, "proj");
  initWorkspace({ dir: wsDir, title: "audio ramp gaps", aspect: "16:9", fps: 30 });
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
  const clip = loadSequence(wsDir).sequence.spine.clips[0] as SpineClipSpec;
  assert.equal(clip.playback.preserve_pitch, true);
  return { wsDir, clip };
}

test("audio ramp gaps: pink noise ramp has no >= 3 ms exact-zero run", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-ramp-noise-");
  try {
    const media = path.join(tmp, "noise.mkv");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
      "-f", "lavfi", "-i", "anoisesrc=d=8:c=pink:r=48000:a=0.5:seed=42",
      "-t", "8",
      "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
      "-c:a", "pcm_s16le",
      media,
    ]);
    const { wsDir } = rampedProject(tmp, media);
    const { sequence, paths } = loadSequence(wsDir);
    const plan = compileSequenceAudioPlan(sequence, paths);
    const out = path.join(tmp, "noise.wav");
    renderAudioToWav(plan, out);
    const x = decodeAudioF32Mono(out);
    // Trailing master pad (alimiter tail) is excluded from the scan.
    const scanEnd = Math.floor(((sequence.spine.clips[0].duration_ms - 10) / 1000) * 48000);
    const minRun = Math.floor(0.003 * 48000);
    let i = 0;
    while (i < Math.min(scanEnd, x.length)) {
      if (x[i] === 0) {
        let j = i;
        while (j < x.length && x[j] === 0) j++;
        assert.ok(
          j - i < minRun,
          `exact-zero run ${(i / 48).toFixed(1)}..${(j / 48).toFixed(1)}ms (${j - i} samples) in ramped noise`
        );
        i = j;
      } else {
        i++;
      }
    }
    console.log(`ramped noise (pp=true): no exact-zero run >= 3 ms in ${scanEnd / 48}ms`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("audio ramp gaps: every tick carries energy at its expected ramp time", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-ramp-tick-energy-");
  try {
    const tick = "if(lt(mod(t,1.0),0.012),0.9*sin(2*PI*1500*t),0)";
    const media = path.join(tmp, "ticks.mkv");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
      "-f", "lavfi", "-i", `aevalsrc='${tick}|${tick}':s=48000:d=8`,
      "-t", "8",
      "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
      "-c:a", "pcm_s16le",
      media,
    ]);
    const { wsDir, clip } = rampedProject(tmp, media);
    const { sequence, paths } = loadSequence(wsDir);
    const plan = compileSequenceAudioPlan(sequence, paths);
    const out = path.join(tmp, "ticks.wav");
    renderAudioToWav(plan, out);
    const x = decodeAudioF32Mono(out, 48000);
    for (const s of [1000, 2000, 3000, 4000, 5000, 6000, 7000]) {
      const expMs = sourceMsToClipLocalMs(clip, s);
      const a = Math.max(0, Math.floor(((expMs - FRAME_MS) / 1000) * 48000));
      const b = Math.min(x.length, Math.ceil(((expMs + FRAME_MS) / 1000) * 48000));
      let peak = 0;
      for (let k = a; k < b; k++) peak = Math.max(peak, Math.abs(x[k]));
      assert.ok(
        peak > 0.2,
        `S=${s}: no tick energy near expected ${expMs.toFixed(1)}ms (peak ${peak.toFixed(3)} in +-1 frame)`
      );
    }
    console.log("ramped ticks (pp=true): all 7 expected windows carry tick energy");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
