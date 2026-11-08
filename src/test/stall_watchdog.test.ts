import "./test_setup.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createSubprocessFailureDiagnostic, CutholError } from "../core/diagnostics.js";
import { resolveStallWatchdogConfig } from "../core/env.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import { initWorkspace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { appendSpineClip } from "../sequence/spine.js";

const TEST_ROOT = path.resolve("test-workspace/stall_watchdog");

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  if (process.platform === "win32") {
    const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const text = (out.stdout || "").trim();
    return text.includes(`"${pid}"`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("1. Stuck subprocess with child process tree: killed after ~2s stall threshold, emits CUTHOL-SYS10 diagnostic, leaves no orphan child, cleans up temp files", () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  const childPidFile = path.join(TEST_ROOT, "grandchild.pid");
  const tempArtifact = path.join(TEST_ROOT, "partial_output.tmp");
  const scriptPath = path.join(TEST_ROOT, "stalling_parent.cjs");

  fs.writeFileSync(
    scriptPath,
    `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid), "utf8");
    fs.writeFileSync(${JSON.stringify(tempArtifact)}, "partial-bytes", "utf8");
    process.stdout.write("step=initialized\\n");
    setInterval(() => {}, 10000);
    `,
    "utf8"
  );

  const prevStallEnv = process.env.CUTHOL_STALL_TIMEOUT_SEC;
  process.env.CUTHOL_STALL_TIMEOUT_SEC = "2";
  try {
    const t0 = Date.now();
    const proc = spawnWatchedSync(process.execPath, [scriptPath], {
      cwd: TEST_ROOT,
      encoding: "utf8",
      step: "synthetic render step",
      cleanupPathsOnStall: [tempArtifact],
    });
    const elapsedMs = Date.now() - t0;

    assert.equal(proc.stalled, true, "Expected subprocess to be marked as stalled");
    assert.ok(
      elapsedMs >= 1800 && elapsedMs <= 4500,
      `Expected stall termination around ~2s, got ${elapsedMs}ms`
    );

    const diag = createSubprocessFailureDiagnostic({
      tool: "synthetic render step",
      executable: process.execPath,
      args: [scriptPath],
      proc,
    });
    assert.equal(diag.code, "CUTHOL-SYS10");
    assert.match(diag.what, /synthetic render step/);
    assert.match(diag.what, /step=initialized/);
    assert.match(diag.what, /threshold=2\.0s/);
    assert.match(diag.what, /stalling_parent\.cjs/);

    assert.ok(fs.existsSync(childPidFile), "Grandchild PID file should have been written before stall");
    const grandchildPid = Number(fs.readFileSync(childPidFile, "utf8").trim());
    assert.ok(grandchildPid > 0, "Valid grandchild PID expected");
    assert.equal(
      isPidAlive(grandchildPid),
      false,
      `Grandchild process ${grandchildPid} should have been terminated with the process tree`
    );
    assert.equal(
      fs.existsSync(tempArtifact),
      false,
      "Temporary output artifact should be cleaned up on stall"
    );
  } finally {
    if (prevStallEnv === undefined) {
      delete process.env.CUTHOL_STALL_TIMEOUT_SEC;
    } else {
      process.env.CUTHOL_STALL_TIMEOUT_SEC = prevStallEnv;
    }
  }
});

test("2. FFmpeg -progress stall vs advancing process: stalled input stops after ~2s with frame/out_time diagnostic; 6s advancing encode with 2s threshold completes uninterrupted", async () => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const prevStallEnv = process.env.CUTHOL_STALL_TIMEOUT_SEC;
  process.env.CUTHOL_STALL_TIMEOUT_SEC = "2";

  try {
    // Part A: Real FFmpeg process reading from a stream that sends 15 frames (1.5s) and then stalls
    const pipeName =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cuthol_stall_ff_${process.pid}_${Date.now()}`
        : path.join(TEST_ROOT, `stall_${process.pid}.sock`);
    const stalledOutMp4 = path.join(TEST_ROOT, "stalled_ff.mp4");
    const pipeReadyFile = path.join(TEST_ROOT, "pipe.ready");

    const pipeServerProc = spawn(
      process.execPath,
      [
        "-e",
        `
        const net = require("node:net");
        const fs = require("node:fs");
        const srv = net.createServer((sock) => {
          sock.on("error", () => {});
          const frame = Buffer.alloc(64 * 64 * 3, 128);
          for (let i = 0; i < 15; i++) sock.write(frame);
        });
        srv.listen(${JSON.stringify(pipeName)}, () => {
          fs.writeFileSync(${JSON.stringify(pipeReadyFile)}, "1", "utf8");
        });
        setInterval(() => {}, 10000);
        `,
      ],
      { stdio: "ignore", windowsHide: true }
    );

    const waitStart = Date.now();
    while (!fs.existsSync(pipeReadyFile) && Date.now() - waitStart < 3000) {
      await new Promise((r) => setTimeout(r, 30));
    }

    try {
      const tStall0 = Date.now();
      const ffStallProc = spawnWatchedSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-f",
          "rawvideo",
          "-pixel_format",
          "rgb24",
          "-video_size",
          "64x64",
          "-framerate",
          "10",
          "-i",
          process.platform === "win32" ? pipeName : `unix:${pipeName}`,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-pix_fmt",
          "yuv420p",
          stalledOutMp4,
        ],
        {
          cwd: TEST_ROOT,
          encoding: "utf8",
          step: "ffmpeg pipe encode",
          cleanupPathsOnStall: [stalledOutMp4],
        }
      );
      const stallElapsedMs = Date.now() - tStall0;

      assert.equal(ffStallProc.stalled, true, "FFmpeg with stalled input should be terminated by watchdog");
      assert.ok(
        stallElapsedMs >= 1800 && stallElapsedMs <= 5000,
        `Expected FFmpeg stall termination around ~2s after last frame, got ${stallElapsedMs}ms`
      );
      const ffDiag = createSubprocessFailureDiagnostic({
        tool: "ffmpeg pipe encode",
        executable: "ffmpeg",
        args: ["-i", pipeName, stalledOutMp4],
        proc: ffStallProc,
      });
      assert.equal(ffDiag.code, "CUTHOL-SYS10");
      assert.match(ffDiag.what, /frame=15/);
      assert.match(ffDiag.what, /out_time=/);
      assert.equal(fs.existsSync(stalledOutMp4), false, "Stalled output MP4 should be cleaned up");
    } finally {
      try {
        pipeServerProc.kill("SIGKILL");
      } catch {}
    }

    // Part B (Counter-metric): Continuously advancing 6s FFmpeg encode (`-re`) with 2s stall threshold MUST NOT be interrupted
    const advancingOutMp4 = path.join(TEST_ROOT, "advancing_6s.mp4");
    const tAdv0 = Date.now();
    const ffAdvProc = spawnWatchedSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=6:size=160x90:rate=10",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        advancingOutMp4,
      ],
      {
        cwd: TEST_ROOT,
        encoding: "utf8",
        step: "ffmpeg advancing encode",
      }
    );
    const advElapsedMs = Date.now() - tAdv0;

    assert.equal(ffAdvProc.stalled, false, "Advancing FFmpeg process must never be killed by watchdog");
    assert.equal(ffAdvProc.status, 0, `Expected exit 0 for advancing FFmpeg, got ${ffAdvProc.status}`);
    assert.ok(
      advElapsedMs >= 5000,
      `Expected -re 6s encode to run for ~6s (>2s stall threshold), ran for ${advElapsedMs}ms`
    );
    assert.ok(
      fs.existsSync(advancingOutMp4) && fs.statSync(advancingOutMp4).size > 1000,
      "Advancing encode output MP4 should exist and be non-empty"
    );
  } finally {
    if (prevStallEnv === undefined) {
      delete process.env.CUTHOL_STALL_TIMEOUT_SEC;
    } else {
      process.env.CUTHOL_STALL_TIMEOUT_SEC = prevStallEnv;
    }
  }
});

test("3. NVENC stall simulation falls back once to libx264 with reason='stalled', while CUTHOL_STALL_TIMEOUT_SEC=0 disables watchdog", () => {
  const wsDir = path.join(TEST_ROOT, "nvenc_fallback_ws");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "NVENC Stall Fallback Test", aspect: "16:9", fps: 30 });

  const srcMp4 = path.join(wsDir, "source.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=1.5:size=320x180:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=1.5",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    srcMp4,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [srcMp4] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01" });

  const prevStallEnv = process.env.CUTHOL_STALL_TIMEOUT_SEC;
  const prevSimEnv = process.env.CUTHOL_SIMULATE_NVENC_STALL;

  try {
    // 1. Simulate NVENC stall with 1.5s stall timeout -> should retry once with libx264 and record reason: "stalled"
    process.env.CUTHOL_STALL_TIMEOUT_SEC = "1.5";
    process.env.CUTHOL_SIMULATE_NVENC_STALL = "1";

    const renderRes = renderSequenceToMp4({
      workspaceDir: wsDir,
      preset: "draft_480p",
      encoder: "nvenc",
    });

    assert.equal(renderRes.encoder, "libx264", "Should fall back to libx264 after NVENC stall");
    assert.ok(renderRes.encoder_fallback, "Expected encoder_fallback metadata to be populated");
    assert.equal(renderRes.encoder_fallback?.from, "h264_nvenc");
    assert.equal(renderRes.encoder_fallback?.to, "libx264");
    assert.equal(renderRes.encoder_fallback?.reason, "stalled");
    assert.ok(fs.existsSync(renderRes.output_path) && renderRes.size_bytes > 1000);

    // 2. Non-NVENC stall does NOT retry and throws CUTHOL-SYS10
    assert.throws(
      () => {
        const proc = spawnWatchedSync(
          process.execPath,
          ["-e", "setInterval(() => {}, 10000)"],
          { encoding: "utf8", step: "ffmpeg render", stallTimeoutMs: 500 }
        );
        if (proc.status !== 0 || proc.error) {
          throw new CutholError(
            createSubprocessFailureDiagnostic({
              tool: "ffmpeg render",
              executable: "ffmpeg",
              args: ["-c:v", "libx264", "out.mp4"],
              proc,
            })
          );
        }
      },
      (err: unknown) =>
        err instanceof CutholError && err.diagnostic.code === "CUTHOL-SYS10"
    );

    // 3. CUTHOL_STALL_TIMEOUT_SEC=0 disables the watchdog completely
    process.env.CUTHOL_STALL_TIMEOUT_SEC = "0";
    delete process.env.CUTHOL_SIMULATE_NVENC_STALL;
    const disabledCfg = resolveStallWatchdogConfig();
    assert.equal(disabledCfg.enabled, false, "Watchdog should be disabled when CUTHOL_STALL_TIMEOUT_SEC=0");

    const sleepProc = spawnWatchedSync(
      process.execPath,
      ["-e", "setTimeout(() => { process.stdout.write('ok'); }, 600);"],
      { encoding: "utf8", step: "disabled watchdog test" }
    );
    assert.equal(sleepProc.stalled, false);
    assert.equal(sleepProc.status, 0);
    assert.equal(sleepProc.stdout, "ok");
  } finally {
    if (prevStallEnv === undefined) {
      delete process.env.CUTHOL_STALL_TIMEOUT_SEC;
    } else {
      process.env.CUTHOL_STALL_TIMEOUT_SEC = prevStallEnv;
    }
    if (prevSimEnv === undefined) {
      delete process.env.CUTHOL_SIMULATE_NVENC_STALL;
    } else {
      process.env.CUTHOL_SIMULATE_NVENC_STALL = prevSimEnv;
    }
  }
});
