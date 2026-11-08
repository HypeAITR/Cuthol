/**
 * Extension processor fixes: manifest asset kinds, digest reuse, A/V duration
 * drift, child-process timeouts, and a writable sandbox tmp directory.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CutholError } from "../core/diagnostics.js";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { runExtensionPlanner } from "../extensions/ext_planner.js";
import { runExtensionProcessor } from "../extensions/ext_processor.js";
import { hashExtensionDirectory } from "../extensions/ext_registry.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";

interface RunDiag {
  code: string;
  severity: string;
  what: string;
  suggestion: string;
  formatted: string;
  subject_id?: string;
}

interface ProbeStream {
  codec_type?: string;
  duration?: string | number;
}

function diagsOf(result: object): RunDiag[] {
  return (result as { diagnostics?: RunDiag[] }).diagnostics ?? [];
}

function withWorkspace(fn: (wsDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-extfix-"));
  const wsDir = path.join(tmp, "proj");
  try {
    initWorkspace({ dir: wsDir, title: "extfix", aspect: "16:9", fps: 30 });
    fn(wsDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeExtension(wsDir: string, manifest: Record<string, unknown>, files?: Record<string, string>): string {
  const name = String(manifest.name);
  const dir = path.join(wsDir, ".cuthol", "extensions", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cuthol-extension.json"), JSON.stringify(manifest, null, 2), "utf8");
  for (const [rel, body] of Object.entries(files ?? {})) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
  }
  return dir;
}

function ffmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || "ffmpeg failed");
}

function makeAvMp4(outPath: string, durationSec = 6): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  ffmpeg([
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=320x240:rate=30:duration=${durationSec}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    outPath,
  ]);
}

function makeWav(outPath: string, durationSec = 0.4): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  ffmpeg([
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
}

function ffprobeStreams(filePath: string): ProbeStream[] {
  const proc = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", filePath],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || "ffprobe failed");
  const parsed = JSON.parse(proc.stdout) as { streams?: ProbeStream[] };
  return parsed.streams ?? [];
}

function expectError(fn: () => unknown): CutholError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CutholError) return err;
    throw err;
  }
  assert.fail("expected CutholError");
}

function baseManifest(name: string, processors: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: "1.0.0",
    name,
    version: "1.0.0",
    description: `${name} processor fixture`,
    processors,
  };
}

function ingestClip(wsDir: string, filePath: string): string {
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [filePath] });
  assert.ok(item);
  return item.handle;
}

const COPY_SCRIPT = [
  `const fs = require("node:fs");`,
  `const [inputPath, outputPath] = process.argv.slice(2);`,
  `fs.copyFileSync(inputPath, outputPath);`,
  `process.stdout.write(JSON.stringify({ ok: true }) + "\\n");`,
].join("\n");

const SLEEP_SCRIPT = [
  `const fs = require("node:fs");`,
  `const [inputPath, outputPath] = process.argv.slice(2);`,
  `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);`,
  `fs.copyFileSync(inputPath, outputPath);`,
  `process.stdout.write(JSON.stringify({ ok: true }) + "\\n");`,
].join("\n");

const TMP_SCRIPT = [
  `const fs = require("node:fs");`,
  `const path = require("node:path");`,
  `const [inputPath, outputPath] = process.argv.slice(2);`,
  `const tmp = process.env.CUTHOL_EXT_TMP;`,
  `const dir = tmp || process.cwd();`,
  `fs.writeFileSync(path.join(dir, "sendcmd.txt"), "0");`,
  `fs.copyFileSync(inputPath, outputPath);`,
  `process.stdout.write(JSON.stringify({ tmp: tmp || null }) + "\\n");`,
].join("\n");

const EVIL_SCRIPT = [
  `const fs = require("node:fs");`,
  `const path = require("node:path");`,
  `const [inputPath, outputPath] = process.argv.slice(2);`,
  `const tmp = process.env.CUTHOL_EXT_TMP;`,
  `if (tmp) fs.writeFileSync(path.join(tmp, "partial.txt"), "x");`,
  `fs.writeFileSync(path.join(process.cwd(), "evil.txt"), "x");`,
  `fs.copyFileSync(inputPath, outputPath);`,
].join("\n");

const PLAN_OK = [
  `const fs = require("node:fs");`,
  `const outputPath = process.argv[3];`,
  `fs.writeFileSync(outputPath, JSON.stringify({ cues: [] }));`,
].join("\n");

const PLAN_TMP = [
  `const fs = require("node:fs");`,
  `const path = require("node:path");`,
  `const outputPath = process.argv[3];`,
  `const tmp = process.env.CUTHOL_EXT_TMP;`,
  `const dir = tmp || path.dirname(outputPath);`,
  `fs.writeFileSync(path.join(dir, "notes.txt"), "ok");`,
  `fs.writeFileSync(outputPath, JSON.stringify({ cues: [] }));`,
].join("\n");

const PLAN_EVIL = [
  `const fs = require("node:fs");`,
  `const path = require("node:path");`,
  `const outputPath = process.argv[3];`,
  `fs.writeFileSync(path.join(process.cwd(), "evil.txt"), "x");`,
  `fs.writeFileSync(outputPath, JSON.stringify({ cues: [] }));`,
].join("\n");

const PLAN_SLEEP = [
  `const fs = require("node:fs");`,
  `const outputPath = process.argv[3];`,
  `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);`,
  `fs.writeFileSync(outputPath, JSON.stringify({ cues: [] }));`,
].join("\n");

function sandboxLeftovers(prefix: string): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix));
}

test("invalid asset_kind is rejected with G112 and the valid kinds", () => {
  withWorkspace((wsDir) => {
    const clip = path.join(wsDir, "clip.mp4");
    makeAvMp4(clip);
    const input = ingestClip(wsDir, clip);
    writeExtension(
      wsDir,
      baseManifest("ramp", {
        half: {
          kind: "ffmpeg",
          asset_kind: "video",
          video_filter: "hue=s=0",
        },
      })
    );

    let handle: string | undefined;
    let err: unknown;
    try {
      const result = runExtensionProcessor({
        workspaceDir: wsDir,
        extensionName: "ramp",
        processorName: "half",
        inputHandleOrPath: input,
      });
      handle = result.output_asset.handle;
    } catch (caught) {
      err = caught;
    }

    assert.ok(
      err instanceof CutholError,
      `expected G112, got handle ${handle ?? "(no result)"}`
    );
    assert.equal(err.diagnostic.code, "CUTHOL-G112");
    for (const kind of ["footage", "audio", "graphic", "voiceover", "composition"]) {
      assert.match(err.diagnostic.formatted, new RegExp(kind));
    }
    assert.match(err.diagnostic.formatted, /video/);
    assert.equal(
      loadSequence(wsDir).sequence.library.some((item) => item.handle.startsWith("undefined_")),
      false
    );

    writeExtension(
      wsDir,
      baseManifest("rampnum", {
        half: {
          kind: "ffmpeg",
          asset_kind: 1,
          video_filter: "hue=s=0",
        },
      })
    );
    const numErr = expectError(() =>
      runExtensionProcessor({
        workspaceDir: wsDir,
        extensionName: "rampnum",
        processorName: "half",
        inputHandleOrPath: input,
      })
    );
    assert.equal(numErr.diagnostic.code, "CUTHOL-G112");
    assert.match(numErr.diagnostic.formatted, /footage/);
  });
});

test("same digest with a different kind is not reused", () => {
  withWorkspace((wsDir) => {
    const clip = path.join(wsDir, "clip.mp4");
    makeAvMp4(clip);
    const input = ingestClip(wsDir, clip);
    writeExtension(
      wsDir,
      baseManifest("tagged", {
        grade: {
          kind: "ffmpeg",
          asset_kind: "footage",
          video_filter: "hue=s=0",
        },
      })
    );
    const run = () =>
      runExtensionProcessor({
        workspaceDir: wsDir,
        extensionName: "tagged",
        processorName: "grade",
        inputHandleOrPath: input,
      });

    const first = run();
    assert.equal(first.cached, false);
    assert.equal(first.output_asset.handle, "vid_02");
    assert.equal(first.output_asset.kind, "footage");

    commitSequenceMutation(wsDir, "retag-output-kind", (seq) => {
      const item = seq.library.find((entry) => entry.handle === "vid_02");
      assert.ok(item);
      (item as { kind: string }).kind = "video";
      item.handle = "undefined_02";
    });

    const second = run();
    assert.equal(second.cached, true);
    assert.match(second.output_asset.handle, /^vid_\d{2}$/);
    assert.notEqual(second.output_asset.handle, "undefined_02");
    assert.equal(second.output_asset.kind, "footage");
    assert.equal(second.output_asset.digest_sha256, first.output_asset.digest_sha256);

    const third = run();
    assert.equal(third.cached, true);
    assert.equal(third.output_asset.handle, second.output_asset.handle);

    const library = loadSequence(wsDir).sequence.library;
    assert.ok(library.some((item) => item.handle === "undefined_02" && (item.kind as string) === "video"));
    assert.ok(library.some((item) => item.handle === second.output_asset.handle && item.kind === "footage"));
  });
});

test("shortened video_filter warns when audio duration drifts, including a cache hit", () => {
  withWorkspace((wsDir) => {
    const clip = path.join(wsDir, "clip.mp4");
    makeAvMp4(clip);
    const input = ingestClip(wsDir, clip);
    writeExtension(
      wsDir,
      baseManifest("ramp", {
        half: {
          kind: "ffmpeg",
          asset_kind: "footage",
          video_filter: "setpts=0.5*PTS",
        },
      })
    );
    const run = () =>
      runExtensionProcessor({
        workspaceDir: wsDir,
        extensionName: "ramp",
        processorName: "half",
        inputHandleOrPath: input,
      });

    const first = run();
    assert.equal(first.cached, false);
    assert.equal(first.output_asset.probe.has_audio, true);
    assert.equal(first.output_asset.probe.has_video, true);
    const diag = diagsOf(first).find((item) => item.code === "CUTHOL-G209");
    assert.ok(diag, `expected CUTHOL-G209, diagnostics=${JSON.stringify(diagsOf(first))}`);
    assert.equal(diag.severity, "WARN");
    assert.match(diag.formatted, /\[CUTHOL-G209\]/);
    assert.match(diag.formatted, /\| Suggestion:/);
    assert.match(diag.suggestion, /"audio": "drop"/);
    assert.match(diag.suggestion, /audio_filter/);
    assert.equal(diag.subject_id, first.output_asset.handle);

    const match = diag.what.match(
      /video stream is (\d+) ms and audio is (\d+) ms; the gap is larger than one frame \((\d+) ms\)/
    );
    assert.ok(match, diag.what);
    const videoMs = Number(match[1]);
    const audioMs = Number(match[2]);
    const frameMs = Number(match[3]);
    assert.ok(Math.abs(audioMs - videoMs) > frameMs);
    assert.ok(frameMs >= 1 && frameMs <= 40);

    const outPath = path.isAbsolute(first.output_asset.uri)
      ? first.output_asset.uri
      : path.resolve(wsDir, first.output_asset.uri);
    const streams = ffprobeStreams(outPath);
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    assert.ok(video && audio);
    assert.ok(Math.abs(videoMs - Math.round(Number(video.duration) * 1000)) <= 1);
    assert.ok(Math.abs(audioMs - Math.round(Number(audio.duration) * 1000)) <= 1);
    assert.ok(Number(audio.duration) - Number(video.duration) > 1);

    const second = run();
    assert.equal(second.cached, true);
    assert.equal(second.output_asset.handle, first.output_asset.handle);
    assert.ok(diagsOf(second).some((item) => item.code === "CUTHOL-G209"));
  });
});

test("audio drop removes audio and invalid audio values are G112", () => {
  withWorkspace((wsDir) => {
    writeExtension(
      wsDir,
      baseManifest("badaudio", {
        half: {
          kind: "ffmpeg",
          audio: "mute",
          video_filter: "hue=s=0",
        },
      })
    );
    const bad = expectError(() =>
      runExtensionProcessor({
        workspaceDir: wsDir,
        extensionName: "badaudio",
        processorName: "half",
        inputHandleOrPath: "missing.mp4",
      })
    );
    assert.equal(bad.diagnostic.code, "CUTHOL-G112");
    assert.match(bad.diagnostic.formatted, /copy/);
    assert.match(bad.diagnostic.formatted, /drop/);
    assert.doesNotMatch(bad.diagnostic.formatted, /unknown field/);

    writeExtension(
      wsDir,
      baseManifest("nodeaudio", {
        transform: {
          kind: "node",
          script: "processor.js",
          audio: "drop",
        },
      }),
      { "processor.js": COPY_SCRIPT }
    );
    const nodeAudio = expectError(() =>
      runExtensionProcessor({
        workspaceDir: wsDir,
        extensionName: "nodeaudio",
        processorName: "transform",
        inputHandleOrPath: "missing.mp4",
      })
    );
    assert.equal(nodeAudio.diagnostic.code, "CUTHOL-G112");
    assert.match(nodeAudio.diagnostic.formatted, /ffmpeg/);
    assert.doesNotMatch(nodeAudio.diagnostic.formatted, /unknown field/);

    const clip = path.join(wsDir, "clip.mp4");
    makeAvMp4(clip);
    const input = ingestClip(wsDir, clip);
    writeExtension(
      wsDir,
      baseManifest("dropper", {
        half: {
          kind: "ffmpeg",
          asset_kind: "footage",
          audio: "drop",
          video_filter: "setpts=0.5*PTS",
        },
      })
    );
    const dropped = runExtensionProcessor({
      workspaceDir: wsDir,
      extensionName: "dropper",
      processorName: "half",
      inputHandleOrPath: input,
    });
    assert.equal(dropped.output_asset.probe.has_audio, false);
    assert.equal(dropped.output_asset.probe.has_video, true);
    assert.equal(diagsOf(dropped).some((item) => item.code === "CUTHOL-G209"), false);
    const outPath = path.isAbsolute(dropped.output_asset.uri)
      ? dropped.output_asset.uri
      : path.resolve(wsDir, dropped.output_asset.uri);
    const streams = ffprobeStreams(outPath);
    assert.equal(streams.some((stream) => stream.codec_type === "audio"), false);
    const video = streams.find((stream) => stream.codec_type === "video");
    assert.ok(video);
    assert.ok(Number(video.duration) < 4.5);
  });
});

test("timeout_sec is enforced, 0 disables the limit, and invalid values are G112", () => {
  withWorkspace((wsDir) => {
    const wav = path.join(wsDir, "tone.wav");
    makeWav(wav);
    const input = ingestClip(wsDir, wav);

    writeExtension(
      wsDir,
      baseManifest("slow", {
        nap: { kind: "node", script: "nap.js", timeout_sec: 1 },
      }),
      { "nap.js": SLEEP_SCRIPT }
    );
    const timed = expectError(() =>
      runExtensionProcessor({
        workspaceDir: wsDir,
        extensionName: "slow",
        processorName: "nap",
        inputHandleOrPath: input,
      })
    );
    assert.equal(timed.diagnostic.code, "CUTHOL-SYS08");
    assert.match(timed.diagnostic.formatted, /timeout_sec/);
    assert.match(timed.diagnostic.formatted, /'timeout_sec' limit 1 s exceeded/);

    writeExtension(
      wsDir,
      baseManifest("nolimit", {
        nap: { kind: "node", script: "nap.js", timeout_sec: 0 },
      }),
      { "nap.js": SLEEP_SCRIPT.replace("4000", "1500") }
    );
    const unlimited = runExtensionProcessor({
      workspaceDir: wsDir,
      extensionName: "nolimit",
      processorName: "nap",
      inputHandleOrPath: input,
    });
    assert.equal(unlimited.output_asset.kind, "audio");

    for (const bad of [-1, 1.5, "30"] as const) {
      writeExtension(
        wsDir,
        baseManifest("badtime", {
          nap: { kind: "node", script: "nap.js", timeout_sec: bad },
        }),
        { "nap.js": COPY_SCRIPT }
      );
      const err = expectError(() =>
        runExtensionProcessor({
          workspaceDir: wsDir,
          extensionName: "badtime",
          processorName: "nap",
          inputHandleOrPath: input,
        })
      );
      assert.equal(err.diagnostic.code, "CUTHOL-G112");
      assert.match(err.diagnostic.formatted, /timeout_sec/);
      assert.match(err.diagnostic.formatted, /integer/);
      assert.doesNotMatch(err.diagnostic.formatted, /unknown field/);
    }

    writeExtension(
      wsDir,
      {
        schema_version: "1.0.0",
        name: "planslow",
        version: "1.0.0",
        description: "planner timeout fixture",
        planners: {
          sync: { script: "planner.js", timeout_sec: 1 },
        },
      },
      { "planner.js": PLAN_SLEEP }
    );
    const planErr = expectError(() =>
      runExtensionPlanner({
        workspaceDir: wsDir,
        extensionName: "planslow",
        plannerName: "sync",
      })
    );
    assert.equal(planErr.diagnostic.code, "CUTHOL-SYS08");
    assert.match(planErr.diagnostic.formatted, /timeout_sec/);
    assert.match(planErr.diagnostic.formatted, /'timeout_sec' limit 1 s exceeded/);

    writeExtension(
      wsDir,
      {
        schema_version: "1.0.0",
        name: "planbad",
        version: "1.0.0",
        description: "planner invalid timeout fixture",
        planners: {
          sync: { script: "planner.js", timeout_sec: -5 },
        },
      },
      { "planner.js": PLAN_OK }
    );
    const planBad = expectError(() =>
      runExtensionPlanner({
        workspaceDir: wsDir,
        extensionName: "planbad",
        plannerName: "sync",
      })
    );
    assert.equal(planBad.diagnostic.code, "CUTHOL-G112");
    assert.match(planBad.diagnostic.formatted, /timeout_sec/);
    assert.doesNotMatch(planBad.diagnostic.formatted, /unknown field/);
  });
});

test("CUTHOL_EXT_TMP is writable for node processors and planners and is removed afterwards", () => {
  withWorkspace((wsDir) => {
    const wav = path.join(wsDir, "tone.wav");
    makeWav(wav);
    const input = ingestClip(wsDir, wav);

    writeExtension(
      wsDir,
      baseManifest("scratch", {
        transform: { kind: "node", script: "processor.js" },
      }),
      { "processor.js": TMP_SCRIPT }
    );
    const ran = runExtensionProcessor({
      workspaceDir: wsDir,
      extensionName: "scratch",
      processorName: "transform",
      inputHandleOrPath: input,
    });
    const tmpPath = ran.script_output?.tmp;
    assert.equal(typeof tmpPath, "string");
    assert.match(String(tmpPath), /[\\/]tmp$/);
    assert.equal(fs.existsSync(String(tmpPath)), false);
    assert.equal(sandboxLeftovers("cuthol-ext-node-scratch-").length, 0);

    writeExtension(
      wsDir,
      {
        schema_version: "1.0.0",
        name: "plantmp",
        version: "1.0.0",
        description: "planner tmp fixture",
        planners: { sync: { script: "planner.js" } },
      },
      { "planner.js": PLAN_TMP }
    );
    const planned = runExtensionPlanner({
      workspaceDir: wsDir,
      extensionName: "plantmp",
      plannerName: "sync",
    });
    assert.equal(planned.planner, "sync");
    assert.equal(sandboxLeftovers("cuthol-ext-planner-plantmp-").length, 0);
  });
});

test("existing processors keep dedupe, cache key, copied audio, default timeout, and the sandbox", () => {
  withWorkspace((wsDir) => {
    const clip = path.join(wsDir, "clip.mp4");
    makeAvMp4(clip);
    const video = ingestClip(wsDir, clip);
    const plainDir = writeExtension(
      wsDir,
      baseManifest("plain", {
        grade: { kind: "ffmpeg", video_filter: "hue=s=0" },
      })
    );
    const runPlain = () =>
      runExtensionProcessor({
        workspaceDir: wsDir,
        extensionName: "plain",
        processorName: "grade",
        inputHandleOrPath: video,
      });
    const first = runPlain();
    const second = runPlain();
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.output_asset.handle, first.output_asset.handle);
    assert.equal(diagsOf(first).some((item) => item.code === "CUTHOL-G209"), false);
    assert.equal(diagsOf(second).some((item) => item.code === "CUTHOL-G209"), false);
    assert.equal(first.output_asset.probe.has_audio, true);
    const outPath = path.isAbsolute(first.output_asset.uri)
      ? first.output_asset.uri
      : path.resolve(wsDir, first.output_asset.uri);
    const srcPath = path.isAbsolute(loadSequence(wsDir).sequence.library[0].uri)
      ? loadSequence(wsDir).sequence.library[0].uri
      : path.resolve(wsDir, loadSequence(wsDir).sequence.library[0].uri);
    const outAudio = ffprobeStreams(outPath).find((stream) => stream.codec_type === "audio");
    const srcAudio = ffprobeStreams(srcPath).find((stream) => stream.codec_type === "audio");
    assert.ok(outAudio && srcAudio);
    assert.ok(Math.abs(Number(outAudio.duration) - Number(srcAudio.duration)) < 0.001);

    const rawKey = [
      "cuthol.ext.proc/1",
      first.input_sha256,
      "plain",
      "1.0.0",
      hashExtensionDirectory(plainDir),
      "grade",
      "{}",
    ].join("|");
    assert.equal(first.cache_key, crypto.createHash("sha256").update(rawKey).digest("hex"));

    writeExtension(
      wsDir,
      baseManifest("marked", {
        grade: { kind: "ffmpeg", asset_kind: "footage", video_filter: "hue=s=0" },
      })
    );
    const marked1 = runExtensionProcessor({
      workspaceDir: wsDir,
      extensionName: "marked",
      processorName: "grade",
      inputHandleOrPath: video,
    });
    const marked2 = runExtensionProcessor({
      workspaceDir: wsDir,
      extensionName: "marked",
      processorName: "grade",
      inputHandleOrPath: video,
    });
    assert.equal(marked1.output_asset.kind, "footage");
    assert.match(marked1.output_asset.handle, /^vid_/);
    assert.equal(marked2.cached, true);
    assert.equal(marked2.output_asset.handle, marked1.output_asset.handle);
    assert.equal(diagsOf(marked1).some((item) => item.code === "CUTHOL-G209"), false);

    const wav = path.join(wsDir, "tone.wav");
    makeWav(wav);
    const audio = ingestClip(wsDir, wav);
    writeExtension(
      wsDir,
      baseManifest("copycat", {
        transform: { kind: "node", script: "processor.js" },
      }),
      { "processor.js": COPY_SCRIPT }
    );
    const copied = runExtensionProcessor({
      workspaceDir: wsDir,
      extensionName: "copycat",
      processorName: "transform",
      inputHandleOrPath: audio,
    });
    assert.equal(copied.script_output?.ok, true);
    assert.equal(sandboxLeftovers("cuthol-ext-node-copycat-").length, 0);

    writeExtension(
      wsDir,
      baseManifest("napdefault", {
        nap: { kind: "node", script: "nap.js" },
      }),
      { "nap.js": SLEEP_SCRIPT.replace("4000", "1500") }
    );
    const napped = runExtensionProcessor({
      workspaceDir: wsDir,
      extensionName: "napdefault",
      processorName: "nap",
      inputHandleOrPath: audio,
    });
    assert.equal(napped.output_asset.handle.length > 0, true);

    writeExtension(
      wsDir,
      baseManifest("rogue", {
        transform: { kind: "node", script: "processor.js" },
      }),
      { "processor.js": EVIL_SCRIPT }
    );
    const evil = expectError(() =>
      runExtensionProcessor({
        workspaceDir: wsDir,
        extensionName: "rogue",
        processorName: "transform",
        inputHandleOrPath: audio,
      })
    );
    assert.equal(evil.diagnostic.code, "CUTHOL-G206");
    assert.match(evil.diagnostic.what, /evil\.txt/);
    assert.doesNotMatch(evil.diagnostic.what, /\btmp\b/);
    assert.equal(sandboxLeftovers("cuthol-ext-node-rogue-").length, 0);

    writeExtension(
      wsDir,
      {
        schema_version: "1.0.0",
        name: "planclean",
        version: "1.0.0",
        description: "planner clean fixture",
        planners: { sync: { script: "planner.js" } },
      },
      { "planner.js": PLAN_OK }
    );
    const clean = runExtensionPlanner({
      workspaceDir: wsDir,
      extensionName: "planclean",
      plannerName: "sync",
    });
    assert.equal(clean.planner, "sync");
    assert.equal(sandboxLeftovers("cuthol-ext-planner-planclean-").length, 0);

    writeExtension(
      wsDir,
      {
        schema_version: "1.0.0",
        name: "planevil",
        version: "1.0.0",
        description: "planner sandbox fixture",
        planners: { sync: { script: "planner.js" } },
      },
      { "planner.js": PLAN_EVIL }
    );
    const planEvil = expectError(() =>
      runExtensionPlanner({
        workspaceDir: wsDir,
        extensionName: "planevil",
        plannerName: "sync",
      })
    );
    assert.equal(planEvil.diagnostic.code, "CUTHOL-G206");
    assert.match(planEvil.diagnostic.what, /evil\.txt/);
    assert.doesNotMatch(planEvil.diagnostic.what, /\btmp\b/);
    assert.equal(sandboxLeftovers("cuthol-ext-planner-planevil-").length, 0);
  });
});
