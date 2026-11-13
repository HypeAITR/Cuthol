/**
 * Cuthol Live preview proxies (`src/live/live_proxy.ts`).
 *
 * For every video asset used on the spine the manager builds a small proxy
 * (short side 540 px, H.264, short GOP of ~0.5 s for fast scrubbing, AAC audio)
 * under `<project>/.cuthol/live/proxies/<content-hash>.mp4`.
 *
 * - Content-addressed cache: the hash covers the source path, size, mtime and
 *   the encoder settings version, so an unchanged asset is never re-encoded.
 * - At most one ffmpeg runs at a time (FIFO queue); the encoder runs at
 *   `BELOW_NORMAL` priority on Windows so editing stays smooth.
 * - Progress comes from ffmpeg's `-progress` file, the same mechanism the
 *   subprocess watchdog (`src/core/subprocess.ts`) uses, and stalls are
 *   detected with the shared watchdog thresholds (`resolveStallWatchdogConfig`).
 *   The encode itself is async (spawn) so the live server event loop never
 *   blocks; the sync `spawnWatchedSync` helper would stall SSE/media serving.
 * - Until a proxy is ready the window plays the original media (`/media/<handle>`).
 * - Audio-only assets never enter the queue (ffmpeg has no video stream to
 *   map); they report a terminal `missing` status so the window keeps the
 *   `/media` fallback without spawning a doomed encoder on every poll.
 * - A failed encode is remembered per content hash: polling the status does
 *   not re-spawn ffmpeg for the same bytes. A changed source (new hash) or a
 *   server restart retries.
 *
 * Endpoint contract (owned by the live server file; this module only exports
 * the handler so it can be mounted):
 *   GET /api/proxy/<handle>  -> 200 proxy mp4 (Range supported) when ready,
 *                                202 + JSON status while queued/encoding,
 *                                404 when the handle is unknown, 410+JSON on failure.
 *   SSE `proxy` event         -> { handle, status, progress } on every change.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { resolveStallWatchdogConfig } from "../core/env.js";
import { loadSequence } from "../core/workspace.js";
import { resolveLivePaths } from "./live_paths.js";

/** Bump when the encoder settings change so stale proxies are rebuilt. */
export const LIVE_PROXY_ARGS_VERSION = "live-proxy/1";

export type LiveProxyStatusName = "ready" | "queued" | "encoding" | "missing" | "failed";

export interface LiveProxyStatus {
  handle: string;
  status: LiveProxyStatusName;
  /** 0..1 encode progress (1 when ready). */
  progress: number;
  /** Absolute proxy file path when ready. */
  file: string | null;
  /** Short human detail for failed/missing states. */
  detail?: string;
}

export interface LiveProxyEmit {
  (event: "proxy", data: LiveProxyStatus): void;
}

interface QueuedJob {
  handle: string;
  source: string;
  fps: number;
  durationMs: number;
  key: string;
  file: string;
}

function proxyKeyFor(source: string, stat: fs.Stats): string {
  return crypto
    .createHash("sha1")
    .update(`${LIVE_PROXY_ARGS_VERSION}|${source}|${stat.size}|${Math.round(stat.mtimeMs)}`)
    .digest("hex")
    .slice(0, 16);
}

/** GOP length for ~0.5 s keyframe intervals at the given fps. */
export function proxyGopForFps(fps: number): number {
  const safe = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return Math.max(1, Math.round(safe * 0.5));
}

export function proxyFfmpegArgs(source: string, dest: string, fps: number): string[] {
  const gop = proxyGopForFps(fps);
  return [
    "-v",
    "error",
    "-y",
    "-i",
    source,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    "scale='if(gt(iw,ih),-2,540)':'if(gt(iw,ih),540,-2)',format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "28",
    "-g",
    String(gop),
    "-keyint_min",
    String(gop),
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    dest,
  ];
}

function parseProgressFile(file: string): number | null {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8");
    let outUs = -1;
    for (const line of text.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k === "out_time_us") {
        const n = Number(v);
        if (Number.isFinite(n) && n >= outUs) outUs = n;
      } else if (k === "progress" && v === "end") {
        return 1;
      }
    }
    return outUs >= 0 ? outUs : null;
  } catch {
    return null;
  }
}

function killTree(pid: number): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
    } catch {}
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

export class LiveProxyManager {
  private projectDir: string;
  private emit: LiveProxyEmit | null;
  private queue: QueuedJob[] = [];
  private running: QueuedJob | null = null;
  private runningPid: number | null = null;

  /** Stop the queue and kill the running encoder, if any (test teardown). */
  shutdown(): void {
    this.queue.length = 0;
    if (this.runningPid) killTree(this.runningPid);
    this.runningPid = null;
  }
  private states = new Map<string, LiveProxyStatus>();
  private ensuredRevisions = new Set<number>();
  /** Terminal encode failures by handle, each pinned to the content hash that failed. */
  private failedByKey = new Map<string, { key: string; detail: string }>();

  constructor(projectDir: string, emit?: LiveProxyEmit) {
    this.projectDir = path.resolve(projectDir);
    this.emit = emit ?? null;
  }

  private publish(status: LiveProxyStatus): void {
    this.states.set(status.handle, status);
    try {
      this.emit?.("proxy", status);
    } catch {}
  }

  /** Status snapshot for one handle (loads the sequence to resolve the asset). */
  status(handle: string): LiveProxyStatus {
    const known = this.states.get(handle);
    if (known) return { ...known };
    const resolved = this.resolveAsset(handle);
    if (!resolved) return { handle, status: "missing", progress: 0, file: null, detail: "unknown handle" };
    if ("audioOnly" in resolved)
      return { handle, status: "missing", progress: 0, file: null, detail: "audio-only asset has no video proxy" };
    if (fs.existsSync(resolved.file)) {
      const ready: LiveProxyStatus = { handle, status: "ready", progress: 1, file: resolved.file };
      this.states.set(handle, ready);
      return { ...ready };
    }
    const failed = this.failedByKey.get(handle);
    if (failed && failed.key === resolved.key)
      return { handle, status: "failed", progress: 0, file: null, detail: failed.detail };
    return { handle, status: "queued", progress: 0, file: null };
  }

  private resolveAsset(handle: string): (QueuedJob & { size: number }) | { audioOnly: true } | null {
    let sequence: any;
    try {
      sequence = loadSequence(this.projectDir).sequence as any;
    } catch {
      return null;
    }
    const asset = (sequence.library ?? []).find((a: any) => a.handle === handle);
    if (!asset?.uri) return null;
    if (asset?.probe && asset.probe.has_video === false) return { audioOnly: true };
    const source = path.isAbsolute(asset.uri) ? asset.uri : path.resolve(this.projectDir, asset.uri);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(source);
    } catch {
      return null;
    }
    const key = proxyKeyFor(source, stat);
    const file = path.join(resolveLivePaths(this.projectDir).proxiesDir, `${key}.mp4`);
    return {
      handle,
      source,
      fps: Number(asset.probe?.fps) > 0 ? Number(asset.probe.fps) : 30,
      durationMs: Number(asset.probe?.duration_ms) > 0 ? Number(asset.probe.duration_ms) : 0,
      key,
      file,
      size: stat.size,
    };
  }

  /** Queue proxies for every video asset referenced by the spine (idempotent per revision). */
  ensureForSequence(sequence: any): LiveProxyStatus[] {
    const revision = Number(sequence?.meta?.revision ?? -1);
    const handles = new Set<string>();
    for (const clip of sequence?.spine?.clips ?? []) {
      if (clip?.asset_handle) handles.add(clip.asset_handle);
    }
    const out: LiveProxyStatus[] = [];
    for (const handle of handles) out.push(this.ensure(handle));
    // Remember the revision so repeated snapshots do not re-scan pointlessly;
    // `ensure` itself is idempotent, this only skips the loop.
    // Bound the memory: drop state for handles that left the sequence and keep
    // only recent revisions (an editing session touches many revisions).
    if (revision >= 0) this.ensuredRevisions.add(revision);
    if (this.ensuredRevisions.size > 40) {
      const sorted = [...this.ensuredRevisions].sort((a, b) => a - b);
      for (const old of sorted.slice(0, sorted.length - 40)) this.ensuredRevisions.delete(old);
    }
    for (const known of [...this.states.keys()]) {
      if (!handles.has(known)) this.states.delete(known);
    }
    for (const known of [...this.failedByKey.keys()]) {
      if (!handles.has(known)) this.failedByKey.delete(known);
    }
    return out;
  }

  /** Queue one handle; returns its current status. */
  ensure(handle: string): LiveProxyStatus {
    const resolved = this.resolveAsset(handle);
    if (!resolved) {
      const missing: LiveProxyStatus = { handle, status: "missing", progress: 0, file: null, detail: "asset file not found" };
      this.publish(missing);
      return { ...missing };
    }
    if ("audioOnly" in resolved) {
      const missing: LiveProxyStatus = { handle, status: "missing", progress: 0, file: null, detail: "audio-only asset has no video proxy" };
      this.publish(missing);
      return { ...missing };
    }
    if (fs.existsSync(resolved.file)) {
      const ready: LiveProxyStatus = { handle, status: "ready", progress: 1, file: resolved.file };
      this.failedByKey.delete(handle);
      this.publish(ready);
      return { ...ready };
    }
    if (this.running?.handle === handle) return { ...this.states.get(handle)! };
    const failed = this.failedByKey.get(handle);
    if (failed && failed.key === resolved.key && !this.queue.some((j) => j.handle === handle)) {
      return { handle, status: "failed", progress: 0, file: null, detail: failed.detail };
    }
    if (!this.queue.some((j) => j.handle === handle)) {
      this.failedByKey.delete(handle);
      this.queue.push(resolved);
      this.publish({ handle, status: "queued", progress: 0, file: null });
      void this.pump();
    }
    return { ...this.states.get(handle)! };
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = job;
    try {
      await this.encode(job);
    } finally {
      this.running = null;
      void this.pump();
    }
  }

  private encode(job: QueuedJob): Promise<void> {
    return new Promise((resolve) => {
      const lp = resolveLivePaths(this.projectDir);
      fs.mkdirSync(lp.proxiesDir, { recursive: true });
      // Drop temp files of dead encoders (a killed server leaves .part/.progress behind).
      try {
        for (const name of fs.readdirSync(lp.proxiesDir)) {
          const m = /^(.*)\.(part|progress)-(\d+)\.(mp4|txt)$/.exec(name);
          if (!m) continue;
          const pid = Number(m[3]);
          let alive = false;
          try {
            process.kill(pid, 0);
            alive = true;
          } catch {}
          if (!alive) {
            try {
              fs.unlinkSync(path.join(lp.proxiesDir, name));
            } catch {}
          }
        }
      } catch {}
      const tmp = `${job.file}.part-${process.pid}.mp4`;
      const progressFile = `${job.file}.progress-${process.pid}.txt`;
      try {
        fs.unlinkSync(tmp);
      } catch {}
      try {
        fs.unlinkSync(progressFile);
      } catch {}
      const args = ["-nostdin", "-progress", progressFile, "-stats_period", "0.2", ...proxyFfmpegArgs(job.source, tmp, job.fps)];
      let child;
      try {
        child = spawn("ffmpeg", args, { cwd: this.projectDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        this.publish({ handle: job.handle, status: "failed", progress: 0, file: null, detail: `spawn failed: ${String(e)}` });
        resolve();
        return;
      }
      // Stay out of the editor's way: lowest useful priority on Windows.
      try {
        if (process.platform === "win32" && child.pid) {
          const prio = (os.constants.priority as any).PRIORITY_BELOW_NORMAL;
          if (typeof prio === "number") os.setPriority(child.pid, prio);
        } else if (child.pid) {
          os.setPriority(child.pid, 10);
        }
      } catch {}
      this.runningPid = child.pid ?? null;
      let stderrTail = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-500);
      });
      const watchdog = resolveStallWatchdogConfig();
      const stallMs = watchdog.enabled ? watchdog.stallTimeoutMs : 0;
      const startupMs = watchdog.enabled ? watchdog.startupTimeoutMs : 0;
      let lastProgressAt = Date.now();
      let sawProgress = false;
      let lastOutUs = -1;
      let finished = false;
      const finish = (ok: boolean, detail?: string) => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        this.runningPid = null;
        try {
          fs.unlinkSync(progressFile);
        } catch {}
        if (ok) {
          try {
            fs.renameSync(tmp, job.file);
          } catch (e) {
            try {
              fs.unlinkSync(tmp);
            } catch {}
            const renameDetail = `rename failed: ${String(e)}`;
            this.failedByKey.set(job.handle, { key: job.key, detail: renameDetail });
            this.publish({ handle: job.handle, status: "failed", progress: 0, file: null, detail: renameDetail });
            resolve();
            return;
          }
          this.failedByKey.delete(job.handle);
          this.publish({ handle: job.handle, status: "ready", progress: 1, file: job.file });
        } else {
          try {
            fs.unlinkSync(tmp);
          } catch {}
          const failDetail = detail ?? "ffmpeg failed";
          this.failedByKey.set(job.handle, { key: job.key, detail: failDetail });
          this.publish({ handle: job.handle, status: "failed", progress: 0, file: null, detail: failDetail });
        }
        resolve();
      };
      const timer = setInterval(() => {
        if (finished) return;
        const parsed = parseProgressFile(progressFile);
        if (parsed !== null && parsed !== 1) {
          if (parsed > lastOutUs) {
            lastOutUs = parsed;
            lastProgressAt = Date.now();
            sawProgress = true;
          }
          if (job.durationMs > 0) {
            const frac = Math.max(0, Math.min(0.999, parsed / 1000 / job.durationMs));
            this.publish({ handle: job.handle, status: "encoding", progress: Number(frac.toFixed(3)), file: null });
          } else {
            this.publish({ handle: job.handle, status: "encoding", progress: 0, file: null });
          }
        } else if (parsed === 1) {
          lastProgressAt = Date.now();
          sawProgress = true;
        }
        const limit = sawProgress ? stallMs : startupMs;
        if (limit > 0 && Date.now() - lastProgressAt > limit) {
          if (child.pid) killTree(child.pid);
          finish(false, `encode stalled for ${Math.round(limit / 1000)}s and was stopped`);
        }
      }, 250);
      timer.unref?.();
      this.publish({ handle: job.handle, status: "encoding", progress: 0, file: null });
      child.on("error", (e) => finish(false, `ffmpeg error: ${e.message}`));
      child.on("close", (code) => {
        if (code === 0 && fs.existsSync(tmp)) finish(true);
        else finish(false, `ffmpeg exited with code ${code}${stderrTail ? `: ${stderrTail.trim().split(/\r?\n/).pop()}` : ""}`);
      });
    });
  }
}

/**
 * Mount point for `GET /api/proxy/<handle>`. Returns true when the request was
 * handled (caller must not write afterwards). The live server owns auth, the
 * token check and the SSE fan-out; it passes an emit that forwards to clients.
 */
export async function routeProxyRequest(
  manager: LiveProxyManager,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handle: string
): Promise<boolean> {
  const status = manager.ensure(handle);
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("status") === "1") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(status));
      return true;
    }
  } catch {}
  if (status.status === "missing") {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify(status));
    return true;
  }
  if (status.status === "failed") {
    res.writeHead(410, { "Content-Type": "application/json" }).end(JSON.stringify(status));
    return true;
  }
  if (status.status !== "ready" || !status.file) {
    res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify(status));
    return true;
  }
  serveFileWithRange(req, res, status.file, "video/mp4");
  return true;
}

function serveFileWithRange(req: http.IncomingMessage, res: http.ServerResponse, file: string, type: string): void {
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}
