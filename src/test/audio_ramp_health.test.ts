/**
 * Post-render audio health: output-gap detection, ramp-aware G508 alignment,
 * and inconclusive verdicts for periodic signals.
 *
 * - A 10 ms zero gap injected into a loud tone region must raise a gap issue
 *   (folded into CUTHOL-G508); silent sources, fades and muted clips must not.
 * - A ramped clip whose audio is sample-accurate (preserve_pitch=false) must
 *   not raise G508; a truly shifted ramped clip must; a pure sine must be
 *   inconclusive instead of alarming.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { scanRenderedMp4AudioHealth } from "../render/render_audio_health.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { appendSpineClip, setSpineSpeed } from "../sequence/spine.js";

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runFfmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? ""}`.slice(0, 2000));
}

function toneMedia(outPath: string, seconds: number, freq = 440): void {
  runFfmpeg([
    "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=30:d=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=48000:d=${seconds}`,
    "-t", String(seconds),
    "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le",
    outPath,
  ]);
}

function tickMedia(outPath: string, seconds: number): void {
  const tick = "if(lt(mod(t,1.0),0.012),0.9*sin(2*PI*1500*t),0)";
  runFfmpeg([
    "-f", "lavfi", "-i", "nullsrc=s=320x180:r=30,geq=lum='if(lt(mod(T,1.0),0.04),235,16)':cb=128:cr=128",
    "-f", "lavfi", "-i", `aevalsrc='${tick}|${tick}':s=48000:d=${seconds}`,
    "-t", String(seconds),
    "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le",
    outPath,
  ]);
}

function decodeAudioS16Mono(file: string, sr = 48000): Int16Array {
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-map", "0:a", "-f", "s16le", "-acodec", "pcm_s16le", "-ar", String(sr), "-ac", "1", "-"],
    { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0, "audio decode failed");
  const buf = proc.stdout as Buffer;
  const n = Math.floor(buf.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

function encodeS16MonoWav(samples: Int16Array, sr: number, outWav: string): void {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  const proc = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "s16le", "-ar", String(sr), "-ac", "1", "-i", "pipe:0", "-c:a", "pcm_s16le", outWav],
    { input: buf, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0, "wav encode failed");
}

function hasG508(diagnostics: Array<{ code: string }>): boolean {
  return diagnostics.some((d) => d.code === "CUTHOL-G508");
}

const RAMP_1_TO_3 = [
  { source_offset_ms: 0, rate: 1.0 },
  { source_offset_ms: 3000, rate: 3.0 },
];

test("audio health gap: injected 10 ms silence in a loud region raises a gap issue", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-health-gap-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "gap detect", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "tone.mkv");
    toneMedia(media, 4);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    const cleanMp4 = path.join(wsDir, "output", "clean.mp4");
    const clean = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: cleanMp4, preset: "draft_480p" });
    assert.equal(clean.ok, true);

    // Inject a 10 ms digital-silence gap at 2 s (source is a loud tone there).
    const pcm = decodeAudioS16Mono(cleanMp4);
    const sr = 48000;
    const gapStart = 2 * sr;
    for (let i = gapStart; i < gapStart + Math.floor(0.01 * sr); i++) pcm[i] = 0;
    const doctoredWav = path.join(tmp, "doctored.wav");
    encodeS16MonoWav(pcm, sr, doctoredWav);
    const doctoredMp4 = path.join(tmp, "doctored.mp4");
    runFfmpeg(["-i", cleanMp4, "-i", doctoredWav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", doctoredMp4]);

    const { sequence, paths } = loadSequence(wsDir);
    const res = scanRenderedMp4AudioHealth(doctoredMp4, sequence, paths);
    const gapIssues = res.issues.filter((iss) => /gap|silence|drop-out/i.test(iss.detail));
    assert.ok(
      gapIssues.length > 0,
      `expected a gap issue for the injected 10 ms silence, got: ${JSON.stringify(res.issues)}`
    );
    assert.ok(hasG508(res.diagnostics), "expected CUTHOL-G508 for the injected gap");
    const near = gapIssues.find((iss) => Math.abs(iss.check_at_ms - 2000) < 500);
    assert.ok(near, `gap issue should point near 2000ms, got: ${JSON.stringify(gapIssues)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("audio health gap: silent source span raises no gap issue", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-health-silsrc-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "silent source", aspect: "16:9", fps: 30 });
    // Tone with a silent middle second (1..2 s).
    const expr = "if(lt(t,1.0),0.5*sin(2*PI*440*t),if(lt(t,2.0),0,0.5*sin(2*PI*440*t)))";
    const media = path.join(tmp, "partsilence.mkv");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:d=4",
      "-f", "lavfi", "-i", `aevalsrc='${expr}|${expr}':s=48000:d=4`,
      "-t", "4",
      "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
      "-c:a", "pcm_s16le",
      media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    const outMp4 = path.join(wsDir, "output", "render.mp4");
    const summary = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: outMp4, preset: "draft_480p" });
    assert.equal(summary.ok, true);
    const gapIssues = (summary.audio_health?.issues ?? []).filter((iss) => /gap|silence|drop-out/i.test(iss.detail));
    assert.equal(gapIssues.length, 0, `silent source must not raise gap issues: ${JSON.stringify(gapIssues)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("audio health gap: fade-out and muted clips raise no gap issue", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-health-fade-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "fade mute", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "tone.mkv");
    toneMedia(media, 4);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 2000, sourceOutMs: 4000 });
    commitSequenceMutation(wsDir, "test: fade and mute", (seq) => {
      seq.spine.clips[0].audio_chain.fade_out_ms = 1000;
      seq.spine.clips[1].audio_chain.muted = true;
    });
    const outMp4 = path.join(wsDir, "output", "render.mp4");
    const summary = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: outMp4, preset: "draft_480p" });
    assert.equal(summary.ok, true);
    const gapIssues = (summary.audio_health?.issues ?? []).filter((iss) => /gap|silence|drop-out/i.test(iss.detail));
    assert.equal(gapIssues.length, 0, `fade/mute must not raise gap issues: ${JSON.stringify(gapIssues)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("G508 ramp: sample-accurate ramped clip raises no alarm", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-health-rampneg-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "ramp no alarm", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "ticks.mkv");
    tickMedia(media, 8);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 8000 });
    // asetrate path: sample-exact ramp audio (ticks land within 1 ms of the map).
    setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", speedRamp: RAMP_1_TO_3, preservePitch: false });
    const outMp4 = path.join(wsDir, "output", "render.mp4");
    const summary = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: outMp4, preset: "draft_480p" });
    assert.equal(summary.ok, true);
    assert.equal(
      summary.audio_health?.issues.length ?? -1,
      0,
      `ramped clip must not raise G508 issues: ${JSON.stringify(summary.audio_health?.issues)}`
    );
    assert.ok(
      !hasG508(summary.verification.diagnostics),
      `ramped clip must not emit CUTHOL-G508: ${JSON.stringify(summary.verification.diagnostics.map((d) => d.code))}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("G508 ramp: truly shifted ramped clip still raises an alarm", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-health-ramppos-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "ramp shifted", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "ticks.mkv");
    tickMedia(media, 8);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 8000 });
    setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", speedRamp: RAMP_1_TO_3, preservePitch: false });
    const cleanMp4 = path.join(wsDir, "output", "clean.mp4");
    const clean = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: cleanMp4, preset: "draft_480p" });
    assert.equal(clean.ok, true);

    // Shift the whole rendered audio +120 ms.
    const proc = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", cleanMp4],
      { encoding: "utf8" }
    );
    assert.equal(proc.status, 0);
    const dur = Number((proc.stdout ?? "").trim());
    const shiftedMp4 = path.join(tmp, "shifted.mp4");
    runFfmpeg([
      "-i", cleanMp4,
      "-af", `adelay=120|120,atrim=end=${dur.toFixed(3)}`,
      "-map", "0:v", "-map", "0:a", "-c:v", "copy", "-c:a", "aac",
      shiftedMp4,
    ]);

    const { sequence, paths } = loadSequence(wsDir);
    const res = scanRenderedMp4AudioHealth(shiftedMp4, sequence, paths);
    assert.ok(res.issues.length > 0, "shifted ramped audio must raise a G508 issue");
    assert.ok(hasG508(res.diagnostics), "shifted ramped audio must emit CUTHOL-G508");
    const near = res.issues.find((iss) => Math.abs(Math.abs(iss.measured_offset_ms) - 120) < 50);
    assert.ok(
      near,
      `expected a detected offset near +-120ms, got: ${JSON.stringify(res.issues.map((i) => i.measured_offset_ms))}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("G508 inconclusive: pure sine raises no alarm", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-health-sine-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "sine", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "sine.mkv");
    toneMedia(media, 4, 440);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    const outMp4 = path.join(wsDir, "output", "render.mp4");
    const summary = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: outMp4, preset: "draft_480p" });
    assert.equal(summary.ok, true);
    assert.equal(
      summary.audio_health?.issues.length ?? -1,
      0,
      `periodic signal must be inconclusive, not an issue: ${JSON.stringify(summary.audio_health?.issues)}`
    );
    assert.ok(
      !hasG508(summary.verification.diagnostics),
      "periodic signal must not emit CUTHOL-G508"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
