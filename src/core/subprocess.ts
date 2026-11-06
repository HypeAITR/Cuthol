/**
 * Progress Watchdog & Subprocess Runner for Cuthol (`src/core/subprocess.ts`).
 *
 * Replaces raw `spawnSync` calls for media, composition, and analysis subprocesses with a
 * synchronous API backed by an asynchronous progress watchdog worker.
 * - Never enforces a wall-clock duration cap: processes that continue making progress run as long as needed.
 * - Terminates the entire process tree (`taskkill /T /F` on Windows, process group kill on POSIX)
 *   only when progress stalls for `CUTHOL_STALL_TIMEOUT_SEC` (default 300s; `0` disables the watchdog).
 */

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { summarizeCommandForDiagnostic } from "./diagnostics.js";
import { resolveStallWatchdogConfig } from "./env.js";

export interface WatchedSubprocessOptions extends SpawnSyncOptions {
  /** Human-readable step name for diagnostics (e.g. "ffmpeg render", "hyperframes render"). */
  step?: string;
  /** Optional explicit file or directory paths whose size growth indicates progress. */
  watchedPaths?: string[];
  /** Optional temporary file/directory paths to remove if the subprocess stalls. */
  cleanupPathsOnStall?: string[];
  /** Optional override for stall timeout in milliseconds (0 disables watchdog). */
  stallTimeoutMs?: number | null;
  /** Optional override for initial startup timeout before first progress in milliseconds. */
  startupTimeoutMs?: number | null;
}

export interface WatchedSubprocessResult<T = Buffer | string> {
  pid: number;
  output: Array<T | null>;
  stdout: T;
  stderr: T;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stalled?: boolean;
  stalledMs?: number;
  stallThresholdMs?: number;
  lastProgress?: string;
  commandSummary?: string;
  step?: string;
  elapsedMs?: number;
}

export interface ParallelFfmpegJob {
  /** Executable to spawn (defaults to `"ffmpeg"`). */
  executable?: string;
  args: string[];
  cwd: string;
  step?: string;
  watchedPaths?: string[];
  cleanupPathsOnStall?: string[];
}

export interface ParallelFfmpegJobResult {
  status: number | null;
  stdout: Buffer;
  stderr: string;
  error?: Error;
  stalled?: boolean;
  stalledMs?: number;
  stallThresholdMs?: number;
  lastProgress?: string;
  commandSummary?: string;
  elapsedMs?: number;
}

interface WorkerJobRequest {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  maxBuffer: number;
  step: string;
  watchedPaths: string[];
  cleanupPathsOnStall: string[];
  stallTimeoutMs: number;
  startupTimeoutMs: number;
  pollIntervalMs: number;
  simulateNvencStall?: boolean;
  simulateHwEncoderStall?: string;
}

interface WorkerJobResponse {
  pid: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdoutAb: ArrayBuffer;
  stderrAb: ArrayBuffer;
  errorCode?: string;
  errorMessage?: string;
  stalled?: boolean;
  stalledMs?: number;
  stallThresholdMs?: number;
  lastProgress?: string;
  commandSummary?: string;
  elapsedMs?: number;
}

let sharedWatchdogWorker: Worker | null = null;

const WATCHDOG_WORKER_SCRIPT = `
const { parentPort } = require("node:worker_threads");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let jobSeq = 0;

function killProcessTree(pid) {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 10000,
      });
    } catch {}
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      spawnSync("pkill", ["-KILL", "-P", String(pid)], {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {}
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function measurePathProgressBytes(targetPath) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return 0;
    const st = fs.statSync(targetPath);
    if (st.isFile()) return st.size;
    if (st.isDirectory()) {
      // Avoid holding open Win32 directory/file handles inside HyperFrames .hf-transaction-* staging folders
      // while ArtifactTransaction.commit() renames the staging directory on Windows.
      let total = Math.round(st.mtimeMs || 0);
      for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
        if (entry.name.includes(".hf-transaction-")) {
          continue;
        }
        const sub = path.join(targetPath, entry.name);
        if (entry.isFile()) {
          try {
            total += fs.statSync(sub).size + 1;
          } catch {}
        }
      }
      return total;
    }
  } catch {}
  return 0;
}

function unlinkWithRetrySync(filePath) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (!fs.existsSync(filePath)) return;
      const st = fs.statSync(filePath);
      if (st.isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
      }
      return;
    } catch {
      const until = Date.now() + 25;
      while (Date.now() < until) {}
    }
  }
}

function removeCleanupPaths(pathsToRemove) {
  if (!Array.isArray(pathsToRemove)) return;
  for (const p of pathsToRemove) {
    if (!p) continue;
    unlinkWithRetrySync(p);
  }
}

function parseFfmpegProgressFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    if (st.size <= 0) return null;
    const readSize = Math.min(st.size, 8192);
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(readSize);
    try {
      fs.readSync(fd, buf, 0, readSize, Math.max(0, st.size - readSize));
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.toString("utf8");
    let frame = -1;
    let outTimeUs = -1;
    let totalSize = -1;
    let progressState = "";
    for (const rawLine of text.split(/\\r?\\n/)) {
      const eq = rawLine.indexOf("=");
      if (eq <= 0) continue;
      const k = rawLine.slice(0, eq).trim();
      const v = rawLine.slice(eq + 1).trim();
      if (k === "frame") {
        const n = Number(v);
        if (Number.isFinite(n) && n >= frame) frame = n;
      } else if (k === "out_time_us" || k === "out_time_ms") {
        const n = Number(v);
        if (Number.isFinite(n) && n >= outTimeUs) outTimeUs = n;
      } else if (k === "total_size") {
        const n = Number(v);
        if (Number.isFinite(n) && n >= totalSize) totalSize = n;
      } else if (k === "progress") {
        progressState = v;
      }
    }
    return { frame, outTimeUs, totalSize, progressState };
  } catch {
    return null;
  }
}

function inferWatchedPaths(args, cwd, explicitPaths) {
  const set = new Set();
  if (Array.isArray(explicitPaths)) {
    for (const p of explicitPaths) {
      if (p) set.add(path.isAbsolute(p) ? p : path.resolve(cwd, p));
    }
  }
  if (Array.isArray(args) && args.length > 0) {
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--output" || args[i] === "-o") {
        const val = args[i + 1];
        if (val && !val.startsWith("-")) {
          set.add(path.isAbsolute(val) ? val : path.resolve(cwd, val));
        }
      }
    }
    const lastArg = args[args.length - 1];
    if (
      lastArg &&
      !lastArg.startsWith("-") &&
      lastArg !== "pipe:1" &&
      lastArg !== "pipe:2" &&
      !lastArg.startsWith("pipe:") &&
      lastArg !== "null" &&
      !/\\.(?:c?js|mjs|ts)$/i.test(lastArg)
    ) {
      set.add(path.isAbsolute(lastArg) ? lastArg : path.resolve(cwd, lastArg));
    }
  }
  return Array.from(set);
}

function runOneWatchedJob(job) {
  return new Promise((resolve) => {
    const seqId = ++jobSeq;
    const exeBase = path.basename(job.executable || "").toLowerCase();
    const isFfmpeg = exeBase === "ffmpeg" || exeBase === "ffmpeg.exe";

    let effectiveExe = job.executable;
    let effectiveArgs = Array.isArray(job.args) ? job.args.slice() : [];
    let progressFile = null;

    const hwEncoders = ["h264_nvenc", "h264_amf", "h264_qsv", "h264_vaapi", "h264_videotoolbox"];
    const activeHwEnc = hwEncoders.find((enc) => effectiveArgs.includes(enc)) || null;
    const isNullMux =
      effectiveArgs.includes("-f") && effectiveArgs[effectiveArgs.indexOf("-f") + 1] === "null";
    const isProbeJob = /\bprobe\b/i.test(job.step || "");
    const rawHwStall = String(
      job.simulateHwEncoderStall || process.env.CUTHOL_SIMULATE_HW_ENCODER_STALL || ""
    )
      .trim()
      .toLowerCase();
    const matchesHwStall =
      Boolean(activeHwEnc) &&
      !isNullMux &&
      !isProbeJob &&
      (rawHwStall === "1" ||
        rawHwStall === "true" ||
        rawHwStall === "all" ||
        (activeHwEnc &&
          (rawHwStall.split(/[,;\s]+/).includes(activeHwEnc) ||
            rawHwStall.split(/[,;\s]+/).includes(activeHwEnc.replace(/^h264_/, "")))));
    const simulateNvencStall =
      isFfmpeg &&
      !isNullMux &&
      !isProbeJob &&
      ((Boolean(job.simulateNvencStall || process.env.CUTHOL_SIMULATE_NVENC_STALL === "1") &&
        effectiveArgs.includes("h264_nvenc")) ||
        matchesHwStall);

    if (simulateNvencStall) {
      effectiveExe = process.execPath;
      effectiveArgs = ["-e", "setInterval(() => {}, 10000);"];
    } else if (isFfmpeg && !effectiveArgs.includes("-progress")) {
      progressFile = path.join(
        os.tmpdir(),
        "cuthol_ffprog_" + process.pid + "_" + seqId + "_" + Date.now() + ".txt"
      );
      effectiveArgs = ["-nostdin", "-progress", progressFile, "-stats_period", "0.2", ...effectiveArgs];
    }

    const watchedPaths = inferWatchedPaths(job.args, job.cwd || process.cwd(), job.watchedPaths);
    const newlyCreatedWatchedPaths = watchedPaths.filter((p) => {
      try {
        return !fs.existsSync(p);
      } catch {
        return false;
      }
    });
    const outChunks = [];
    const errChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let maxBufferExceeded = false;
    const maxBuffer = job.maxBuffer || 256 * 1024 * 1024;

    const startTime = Date.now();
    let lastProgressTime = startTime;
    let hasProgress = false;
    let lastProgressDesc = "no progress/output produced";

    let maxFrame = -1;
    let maxOutTimeUs = -1;
    let maxTotalSize = -1;
    let sawEnd = false;
    let maxWatchedBytes = 0;
    for (const wp of watchedPaths) {
      maxWatchedBytes += measurePathProgressBytes(wp);
    }
    let prevPolledStdoutBytes = 0;
    let lastStderrSnippet = "";
    let lastStreamSnippet = "";

    let settled = false;
    let pendingStallResult = null;
    let timer = null;
    let child = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (progressFile) {
        unlinkWithRetrySync(progressFile);
      }
      if (result && result.stalled) {
        removeCleanupPaths(job.cleanupPathsOnStall);
        removeCleanupPaths(newlyCreatedWatchedPaths);
      }
      const stdoutBuf = outChunks.length > 0 ? Buffer.concat(outChunks) : Buffer.alloc(0);
      const stderrBuf = errChunks.length > 0 ? Buffer.concat(errChunks) : Buffer.alloc(0);
      const stdoutAb = stdoutBuf.buffer.slice(
        stdoutBuf.byteOffset,
        stdoutBuf.byteOffset + stdoutBuf.byteLength
      );
      const stderrAb = stderrBuf.buffer.slice(
        stderrBuf.byteOffset,
        stderrBuf.byteOffset + stderrBuf.byteLength
      );
      resolve({
        pid: child && child.pid ? child.pid : 0,
        status: result.status,
        signal: result.signal || null,
        stdoutAb,
        stderrAb,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        stalled: Boolean(result.stalled),
        stalledMs: result.stalledMs,
        stallThresholdMs: result.stallThresholdMs,
        lastProgress: result.lastProgress,
        commandSummary: result.commandSummary,
        elapsedMs: Date.now() - startTime,
      });
    }

    try {
      child = spawn(effectiveExe, effectiveArgs, {
        cwd: job.cwd || process.cwd(),
        env: job.env || process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      finish({
        status: null,
        signal: null,
        errorCode: err && err.code ? String(err.code) : undefined,
        errorMessage: err && err.message ? String(err.message) : String(err),
      });
      return;
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBuffer) {
        outChunks.push(chunk);
      } else {
        maxBufferExceeded = true;
      }
      lastProgressTime = Date.now();
      hasProgress = true;
      if (!isFfmpeg) {
        const line = chunk.toString("utf8").trim().split(/\\r?\\n/).pop();
        if (line) lastStreamSnippet = line.slice(0, 80);
        lastProgressDesc = lastStreamSnippet ? "stdout: " + lastStreamSnippet : "stdout=" + stdoutBytes + "B";
      } else if (maxFrame < 0 && maxOutTimeUs < 0) {
        lastProgressDesc = "stdout=" + stdoutBytes + "B";
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) {
        errChunks.push(chunk);
      }
      const text = chunk.toString("utf8").trim();
      if (text) {
        const lastLine = text.split(/\\r?\\n/).pop() || "";
        if (lastLine) lastStderrSnippet = lastLine.slice(0, 100);
      }
      if (!isFfmpeg) {
        lastProgressTime = Date.now();
        hasProgress = true;
        lastProgressDesc = lastStderrSnippet
          ? "stderr: " + lastStderrSnippet
          : "stderr=" + stderrBytes + "B";
      } else if (/\\b(?:time[:=]|t:\\s*\\d|lavfi\\.scd\\.time)/i.test(text)) {
        lastProgressTime = Date.now();
        hasProgress = true;
        lastProgressDesc = lastStderrSnippet || "stderr=" + stderrBytes + "B";
      }
    });

    function pollProgress() {
      if (settled) return;
      const now = Date.now();

      if (progressFile) {
        const prog = parseFfmpegProgressFile(progressFile);
        if (prog) {
          const frameAdvanced = prog.frame >= 0 && prog.frame > maxFrame;
          const timeAdvanced = prog.outTimeUs >= 0 && prog.outTimeUs > maxOutTimeUs;
          const sizeAdvanced = prog.totalSize > 0 && prog.totalSize > maxTotalSize;
          const endAdvanced = prog.progressState === "end" && !sawEnd;
          if (frameAdvanced || timeAdvanced || sizeAdvanced || endAdvanced) {
            if (prog.frame > maxFrame) maxFrame = prog.frame;
            if (prog.outTimeUs > maxOutTimeUs) maxOutTimeUs = prog.outTimeUs;
            if (prog.totalSize > maxTotalSize) maxTotalSize = prog.totalSize;
            if (prog.progressState === "end") sawEnd = true;
            lastProgressTime = now;
            hasProgress = true;
            const parts = [];
            if (maxFrame >= 0) parts.push("frame=" + maxFrame);
            if (maxOutTimeUs >= 0) parts.push("out_time=" + (maxOutTimeUs / 1e6).toFixed(2) + "s");
            if (maxTotalSize > 0) parts.push("size=" + maxTotalSize + "B");
            if (parts.length > 0) {
              lastProgressDesc = parts.join(", ");
            }
          }
        }
      }

      if (stdoutBytes > prevPolledStdoutBytes) {
        prevPolledStdoutBytes = stdoutBytes;
        lastProgressTime = now;
        hasProgress = true;
      }

      const stallThreshold = hasProgress ? job.stallTimeoutMs : job.startupTimeoutMs;
      if (now - lastProgressTime >= Math.min(2000, Math.max(100, Math.floor((stallThreshold || 2000) / 3)))) {
        let curWatchedBytes = 0;
        for (const wp of watchedPaths) {
          curWatchedBytes += measurePathProgressBytes(wp);
        }
        if (curWatchedBytes > maxWatchedBytes) {
          maxWatchedBytes = curWatchedBytes;
          lastProgressTime = now;
          hasProgress = true;
          if (maxFrame < 0 && maxOutTimeUs < 0) {
            lastProgressDesc = lastStreamSnippet
              ? "stdout: " + lastStreamSnippet + ", file_size=" + curWatchedBytes + "B"
              : "file_size=" + curWatchedBytes + "B";
          }
        }
      }

      if (stallThreshold > 0 && !pendingStallResult) {
        const elapsedSinceProgress = now - lastProgressTime;
        if (elapsedSinceProgress >= stallThreshold) {
          pendingStallResult = {
            status: null,
            signal: "SIGKILL",
            errorCode: "ETIMEDOUT",
            errorMessage: "Subprocess stalled without progress for " + elapsedSinceProgress + "ms",
            stalled: true,
            stalledMs: elapsedSinceProgress,
            stallThresholdMs: stallThreshold,
            lastProgress: lastProgressDesc,
          };
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          const pidToKill = child && child.pid ? child.pid : 0;
          killProcessTree(pidToKill);
          try {
            if (child && child.stdout) child.stdout.destroy();
            if (child && child.stderr) child.stderr.destroy();
          } catch {}
          setTimeout(() => {
            if (!settled && pendingStallResult) {
              finish(pendingStallResult);
            }
          }, 150);
        }
      }
    }

    if (job.stallTimeoutMs > 0 || job.startupTimeoutMs > 0) {
      const interval = Math.max(40, Math.min(1000, job.pollIntervalMs || 250));
      timer = setInterval(pollProgress, interval);
    }

    child.on("error", (err) => {
      if (pendingStallResult) {
        finish(pendingStallResult);
        return;
      }
      finish({
        status: null,
        signal: null,
        errorCode: err && err.code ? String(err.code) : undefined,
        errorMessage: err && err.message ? String(err.message) : String(err),
      });
    });

    child.on("close", (code, signal) => {
      if (pendingStallResult) {
        finish(pendingStallResult);
        return;
      }
      if (maxBufferExceeded) {
        finish({
          status: code,
          signal,
          errorCode: "ENOBUFS",
          errorMessage: "spawnWatchedSync stdout maxBuffer exceeded",
        });
        return;
      }
      finish({
        status: code,
        signal,
      });
    });
  });
}

parentPort.on("message", async (msg) => {
  const { jobs, concurrency, port, sab } = msg;
  const signal = new Int32Array(sab);
  const results = new Array(jobs.length);
  let nextIdx = 0;
  const workerCount = Math.max(1, Math.min(jobs.length, concurrency || 1));

  async function workerLoop() {
    while (true) {
      const i = nextIdx++;
      if (i >= jobs.length) break;
      results[i] = await runOneWatchedJob(jobs[i]);
    }
  }

  try {
    await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
    const transferList = [];
    for (const r of results) {
      if (r && r.stdoutAb) transferList.push(r.stdoutAb);
      if (r && r.stderrAb) transferList.push(r.stderrAb);
    }
    port.postMessage({ ok: true, results }, transferList);
  } catch (err) {
    port.postMessage({ ok: false, error: String(err) });
  } finally {
    port.close();
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0, 1);
  }
});
`;

function getWatchdogWorker(): Worker {
  if (sharedWatchdogWorker) return sharedWatchdogWorker;
  const worker = new Worker(WATCHDOG_WORKER_SCRIPT, { eval: true });
  worker.unref();
  worker.on("error", () => {
    if (sharedWatchdogWorker === worker) {
      sharedWatchdogWorker = null;
    }
  });
  worker.on("exit", () => {
    if (sharedWatchdogWorker === worker) {
      sharedWatchdogWorker = null;
    }
  });
  sharedWatchdogWorker = worker;
  return worker;
}

/**
 * Runs a single child process synchronously while monitoring its progress asynchronously.
 * If progress stops for `CUTHOL_STALL_TIMEOUT_SEC` (default 300s), terminates the process tree
 * and returns a result with `stalled: true`. When `CUTHOL_STALL_TIMEOUT_SEC=0`, falls back to
 * direct `spawnSync` with no wall-clock timeout.
 */
export function spawnWatchedSync(
  executable: string,
  args: readonly string[] = [],
  options?: WatchedSubprocessOptions
): WatchedSubprocessResult<any> {
  const watchdogCfg = resolveStallWatchdogConfig({
    stallTimeoutMs: options?.stallTimeoutMs,
    startupTimeoutMs: options?.startupTimeoutMs,
  });

  const encoding =
    typeof options?.encoding === "string" && options.encoding !== "buffer"
      ? (options.encoding as BufferEncoding)
      : null;
  const step = options?.step ?? `${path.basename(executable)} ${args[0] ?? ""}`.trim();
  const cmdSummary = summarizeCommandForDiagnostic(executable, args);

  if (!watchdogCfg.enabled) {
    const cleanOpts: SpawnSyncOptions = { ...options };
    delete (cleanOpts as Record<string, unknown>).timeout;
    delete (cleanOpts as Record<string, unknown>).step;
    delete (cleanOpts as Record<string, unknown>).watchedPaths;
    delete (cleanOpts as Record<string, unknown>).cleanupPathsOnStall;
    delete (cleanOpts as Record<string, unknown>).stallTimeoutMs;
    delete (cleanOpts as Record<string, unknown>).startupTimeoutMs;
    if (!cleanOpts.maxBuffer) {
      cleanOpts.maxBuffer = 256 * 1024 * 1024;
    }
    const t0 = Date.now();
    const raw = spawnSync(executable, args, cleanOpts);
    return {
      pid: raw.pid,
      output: raw.output as any,
      stdout: raw.stdout as any,
      stderr: raw.stderr as any,
      status: raw.status,
      signal: raw.signal,
      error: raw.error,
      stalled: false,
      commandSummary: cmdSummary,
      step,
      elapsedMs: Date.now() - t0,
    };
  }

  const jobReq: WorkerJobRequest = {
    executable,
    args: Array.from(args),
    cwd: options?.cwd ? String(options.cwd) : process.cwd(),
    env: options?.env ? ({ ...options.env } as Record<string, string | undefined>) : undefined,
    maxBuffer: options?.maxBuffer ?? 256 * 1024 * 1024,
    step,
    watchedPaths: options?.watchedPaths ?? [],
    cleanupPathsOnStall: options?.cleanupPathsOnStall ?? [],
    stallTimeoutMs: watchdogCfg.stallTimeoutMs,
    startupTimeoutMs: watchdogCfg.startupTimeoutMs,
    pollIntervalMs: watchdogCfg.pollIntervalMs,
    simulateNvencStall: process.env.CUTHOL_SIMULATE_NVENC_STALL === "1",
    simulateHwEncoderStall: process.env.CUTHOL_SIMULATE_HW_ENCODER_STALL,
  };

  const worker = getWatchdogWorker();
  const { port1, port2 } = new MessageChannel();
  const sab = new SharedArrayBuffer(4);
  const signal = new Int32Array(sab);
  worker.postMessage({ jobs: [jobReq], concurrency: 1, port: port2, sab }, [port2]);
  Atomics.wait(signal, 0, 0);
  const received = receiveMessageOnPort(port1);
  port1.close();

  const res: WorkerJobResponse | undefined = received?.message?.results?.[0];
  if (!res) {
    const fallbackErr = new Error(
      received?.message?.error ?? "Watchdog worker failed to return subprocess result"
    );
    return {
      pid: 0,
      output: [null, encoding ? "" : Buffer.alloc(0), encoding ? "" : Buffer.alloc(0)],
      stdout: encoding ? "" : Buffer.alloc(0),
      stderr: encoding ? "" : Buffer.alloc(0),
      status: null,
      signal: null,
      error: fallbackErr,
      stalled: false,
      commandSummary: cmdSummary,
      step,
    };
  }

  const stdoutBuf = Buffer.from(res.stdoutAb);
  const stderrBuf = Buffer.from(res.stderrAb);
  const stdoutVal = encoding ? stdoutBuf.toString(encoding) : stdoutBuf;
  const stderrVal = encoding ? stderrBuf.toString(encoding) : stderrBuf;

  let errObj: NodeJS.ErrnoException | undefined;
  if (res.errorCode || res.errorMessage) {
    errObj = new Error(res.errorMessage || "subprocess failed");
    if (res.errorCode) errObj.code = res.errorCode;
  }

  return {
    pid: res.pid,
    output: [null, stdoutVal, stderrVal],
    stdout: stdoutVal,
    stderr: stderrVal,
    status: res.status,
    signal: res.signal,
    error: errObj,
    stalled: Boolean(res.stalled),
    stalledMs: res.stalledMs,
    stallThresholdMs: res.stallThresholdMs,
    lastProgress: res.lastProgress,
    commandSummary: cmdSummary,
    step,
    elapsedMs: res.elapsedMs,
  };
}

/**
 * Runs multiple FFmpeg (or Node/HyperFrames) jobs in parallel with per-job progress watchdog monitoring.
 */
export function runWatchedParallelFfmpegJobsSync(
  jobs: ParallelFfmpegJob[],
  maxBuffers: number[],
  concurrency = Math.max(2, Math.min(os.cpus().length, 12))
): ParallelFfmpegJobResult[] {
  if (jobs.length === 0) return [];
  if (jobs.length === 1) {
    const exe = jobs[0].executable ?? "ffmpeg";
    const proc = spawnWatchedSync(exe, jobs[0].args, {
      cwd: jobs[0].cwd,
      maxBuffer: maxBuffers[0] ?? 32 * 1024 * 1024,
      step: jobs[0].step ?? "ffmpeg parallel job",
      watchedPaths: jobs[0].watchedPaths,
      cleanupPathsOnStall: jobs[0].cleanupPathsOnStall,
    });
    return [
      {
        status: proc.status,
        stdout: (proc.stdout as Buffer) ?? Buffer.alloc(0),
        stderr: proc.stderr ? proc.stderr.toString("utf8") : "",
        error: proc.error,
        stalled: proc.stalled,
        stalledMs: proc.stalledMs,
        stallThresholdMs: proc.stallThresholdMs,
        lastProgress: proc.lastProgress,
        commandSummary: proc.commandSummary,
        elapsedMs: proc.elapsedMs,
      },
    ];
  }

  const watchdogCfg = resolveStallWatchdogConfig();
  if (!watchdogCfg.enabled) {
    return jobs.map((job, idx) => {
      const exe = job.executable ?? "ffmpeg";
      const proc = spawnWatchedSync(exe, job.args, {
        cwd: job.cwd,
        maxBuffer: maxBuffers[idx] ?? 32 * 1024 * 1024,
        step: job.step ?? "ffmpeg parallel job",
      });
      return {
        status: proc.status,
        stdout: (proc.stdout as Buffer) ?? Buffer.alloc(0),
        stderr: proc.stderr ? proc.stderr.toString("utf8") : "",
        error: proc.error,
        stalled: false,
        commandSummary: proc.commandSummary,
        elapsedMs: proc.elapsedMs,
      };
    });
  }

  try {
    const worker = getWatchdogWorker();
    const { port1, port2 } = new MessageChannel();
    const sab = new SharedArrayBuffer(4);
    const signal = new Int32Array(sab);
    const workerJobs: WorkerJobRequest[] = jobs.map((j, idx) => ({
      executable: j.executable ?? "ffmpeg",
      args: Array.from(j.args),
      cwd: j.cwd || process.cwd(),
      maxBuffer: maxBuffers[idx] ?? 32 * 1024 * 1024,
      step: j.step ?? "ffmpeg parallel job",
      watchedPaths: j.watchedPaths ?? [],
      cleanupPathsOnStall: j.cleanupPathsOnStall ?? [],
      stallTimeoutMs: watchdogCfg.stallTimeoutMs,
      startupTimeoutMs: watchdogCfg.startupTimeoutMs,
      pollIntervalMs: watchdogCfg.pollIntervalMs,
      simulateNvencStall: process.env.CUTHOL_SIMULATE_NVENC_STALL === "1",
      simulateHwEncoderStall: process.env.CUTHOL_SIMULATE_HW_ENCODER_STALL,
    }));
    worker.postMessage({ jobs: workerJobs, concurrency, port: port2, sab }, [port2]);
    Atomics.wait(signal, 0, 0);
    const received = receiveMessageOnPort(port1);
    port1.close();
    if (received?.message?.ok && Array.isArray(received.message.results)) {
      return (received.message.results as WorkerJobResponse[]).map((r, idx) => {
        let errObj: NodeJS.ErrnoException | undefined;
        const stderrStr = Buffer.from(r.stderrAb).toString("utf8");
        if (r.errorCode || r.errorMessage) {
          errObj = new Error(r.errorMessage || stderrStr || "spawn failed");
          if (r.errorCode) errObj.code = r.errorCode;
        }
        const exe = jobs[idx].executable ?? "ffmpeg";
        return {
          status: r.status,
          stdout: Buffer.from(r.stdoutAb),
          stderr: stderrStr,
          error: errObj,
          stalled: Boolean(r.stalled),
          stalledMs: r.stalledMs,
          stallThresholdMs: r.stallThresholdMs,
          lastProgress: r.lastProgress,
          commandSummary: summarizeCommandForDiagnostic(exe, jobs[idx].args),
          elapsedMs: r.elapsedMs,
        };
      });
    }
  } catch {
    // Fallback to sequential watched execution below if worker messaging fails
  }

  return jobs.map((job, idx) => {
    const exe = job.executable ?? "ffmpeg";
    const proc = spawnWatchedSync(exe, job.args, {
      cwd: job.cwd,
      maxBuffer: maxBuffers[idx] ?? 32 * 1024 * 1024,
      step: job.step ?? "ffmpeg parallel job",
      watchedPaths: job.watchedPaths,
      cleanupPathsOnStall: job.cleanupPathsOnStall,
    });
    return {
      status: proc.status,
      stdout: (proc.stdout as Buffer) ?? Buffer.alloc(0),
      stderr: proc.stderr ? proc.stderr.toString("utf8") : "",
      error: proc.error,
      stalled: proc.stalled,
      stalledMs: proc.stalledMs,
      stallThresholdMs: proc.stallThresholdMs,
      lastProgress: proc.lastProgress,
      commandSummary: proc.commandSummary,
      elapsedMs: proc.elapsedMs,
    };
  });
}
