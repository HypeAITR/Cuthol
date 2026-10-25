// Stderr progress lines for a running render. The render thread blocks inside
// the subprocess wait, so a worker repeats the latest sample about every 2s.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

export const CUTHOL_PROGRESS_PREFIX = "cuthol:progress ";

const MIN_INTERVAL_MS = 2000;

export type ProgressMode = "count" | "ffmpeg-frames" | "ffmpeg-jobs" | "watch";

export interface ProgressWatch {
  mode?: ProgressMode;
  paths?: string[];
  expectedFrames?: number[];
}

interface Stage {
  name: string;
  done: number;
  total: number;
  startedAt: number;
  lastEmitAt: number;
  mode: ProgressMode;
  paths: string[];
  expectedFrames: number[];
}

const WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const flag = new Int32Array(workerData.sab);
const prefix = ${JSON.stringify(CUTHOL_PROGRESS_PREFIX)};
let state = {
  name: "",
  done: 0,
  total: 0,
  startedAt: Date.now(),
  mode: "count",
  paths: [],
  expectedFrames: [],
  pid: workerData.pid,
};
let highWater = 0;

function eta(done, total, startedAt) {
  if (!(total > 0) || done <= 0) return "";
  if (done >= total) return " eta 0s";
  const sec = Math.max(0, Math.round(((Date.now() - startedAt) / done) * (total - done) / 1000));
  return sec < 90 ? " eta " + sec + "s" : " eta " + Math.round(sec / 60) + "m";
}

function readProgressTexts() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()); } catch { return out; }
  const filePrefix = "cuthol_ffprog_" + state.pid + "_";
  for (const name of names) {
    if (!name.startsWith(filePrefix) || !name.endsWith(".txt")) continue;
    const full = path.join(os.tmpdir(), name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs + 1000 < state.startedAt) continue;
      const readSize = Math.min(st.size, 8192);
      const buf = Buffer.allocUnsafe(readSize);
      const fd = fs.openSync(full, "r");
      try { fs.readSync(fd, buf, 0, readSize, Math.max(0, st.size - readSize)); }
      finally { fs.closeSync(fd); }
      out.push(buf.toString("utf8"));
    } catch { /* ignore a file that disappeared */ }
  }
  return out;
}

function countPng(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => /^frame_\\d+\\.png$/i.test(name)).length;
  } catch {
    return 0;
  }
}

function sample() {
  let sampled = state.done;
  if (state.mode === "ffmpeg-frames" || state.mode === "ffmpeg-jobs") {
    const texts = readProgressTexts();
    if (state.mode === "ffmpeg-jobs") {
      sampled = texts.reduce((n, text) => n + (text.includes("progress=end") ? 1 : 0), 0);
    } else {
      let frames = 0;
      for (const text of texts) {
        let frame = 0;
        for (const line of text.split(/\\r?\\n/)) {
          const eq = line.indexOf("=");
          if (eq <= 0 || line.slice(0, eq).trim() !== "frame") continue;
          const n = Number(line.slice(eq + 1).trim());
          if (Number.isFinite(n) && n > frame) frame = n;
        }
        frames += frame;
      }
      if (frames > 0) sampled = frames;
    }
  } else if (state.mode === "watch" && state.paths.length > 0) {
    let ready = 0;
    for (let i = 0; i < state.paths.length; i++) {
      const target = state.paths[i];
      const expect = state.expectedFrames[i] || 0;
      try {
        if (!fs.statSync(target).isDirectory()) continue;
        let n = countPng(target);
        const framesDir = path.join(target, "frames");
        if (fs.existsSync(framesDir)) n = Math.max(n, countPng(framesDir));
        if (expect > 0 && n >= Math.max(1, expect - 1)) ready += 1;
      } catch { /* output not created yet */ }
    }
    sampled = ready;
  }
  if (sampled > highWater) highWater = sampled;
  if (state.done > highWater) highWater = state.done;
  return state.total > 0 ? Math.min(state.total, highWater) : highWater;
}

const port = parentPort;
const timer = setInterval(() => {
  if (!port || Atomics.load(flag, 0) !== 1 || !state.name || !(state.total > 0)) return;
  const done = sample();
  const count = " " + done + "/" + state.total;
  if (Atomics.load(flag, 0) !== 1) return;
  fs.writeSync(2, prefix + state.name + count + eta(done, state.total, state.startedAt) + "\\n");
}, ${MIN_INTERVAL_MS});

port?.on("message", (msg) => {
  if (!msg || msg.type === "stop") {
    clearInterval(timer);
    process.exit(0);
  }
  if (msg.type !== "update") return;
  const nameChanged = Boolean(msg.name) && msg.name !== state.name;
  state = {
    name: msg.name ?? state.name,
    done: typeof msg.done === "number" ? msg.done : state.done,
    total: typeof msg.total === "number" ? msg.total : state.total,
    startedAt: typeof msg.startedAt === "number" ? msg.startedAt : state.startedAt,
    mode: msg.mode || state.mode,
    paths: Array.isArray(msg.paths) ? msg.paths : state.paths,
    expectedFrames: Array.isArray(msg.expectedFrames) ? msg.expectedFrames : state.expectedFrames,
    pid: state.pid,
  };
  if (nameChanged) highWater = state.done;
});
`;

let stage: Stage | null = null;
const stack: Stage[] = [];
let poller: Worker | null = null;
let flag: Int32Array | null = null;
let workerFileUrl: URL | null = null;

function progressWorkerUrl(): URL {
  if (workerFileUrl) return workerFileUrl;
  const file = path.join(os.tmpdir(), "cuthol_progress_worker.mjs");
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    current = "";
  }
  if (current !== WORKER_SOURCE) fs.writeFileSync(file, WORKER_SOURCE);
  workerFileUrl = pathToFileURL(file);
  return workerFileUrl;
}

function formatEta(current: Stage): string {
  if (current.total <= 0 || current.done <= 0) return "";
  if (current.done >= current.total) return " eta 0s";
  const sec = Math.max(
    0,
    Math.round(((Date.now() - current.startedAt) / current.done) * (current.total - current.done) / 1000)
  );
  return sec < 90 ? ` eta ${sec}s` : ` eta ${Math.round(sec / 60)}m`;
}

function emit(force: boolean): void {
  if (!stage || stage.total <= 0) return;
  const now = Date.now();
  if (!force && stage.lastEmitAt !== 0 && now - stage.lastEmitAt < MIN_INTERVAL_MS) return;
  stage.lastEmitAt = now;
  fs.writeSync(
    2,
    `${CUTHOL_PROGRESS_PREFIX}${stage.name} ${stage.done}/${stage.total}${formatEta(stage)}\n`
  );
}

function postStage(): void {
  if (!stage || !poller) return;
  poller.postMessage({
    type: "update",
    name: stage.name,
    done: stage.done,
    total: stage.total,
    startedAt: stage.startedAt,
    mode: stage.mode,
    paths: stage.paths,
    expectedFrames: stage.expectedFrames,
  });
}

function ensurePoller(): void {
  if (poller) return;
  const sab = new SharedArrayBuffer(4);
  flag = new Int32Array(sab);
  Atomics.store(flag, 0, 0);
  try {
    poller = new Worker(progressWorkerUrl(), {
      workerData: { sab, pid: process.pid },
    });
    poller.unref();
    poller.on("error", () => {
      poller = null;
      flag = null;
    });
  } catch {
    poller = null;
    flag = null;
  }
}

function setPolling(active: boolean): void {
  if (flag) Atomics.store(flag, 0, active ? 1 : 0);
}

export function progressBegin(name: string, total: number, watch?: ProgressWatch): void {
  if (stage) stack.push(stage);
  stage = {
    name,
    done: 0,
    total: Math.max(0, Math.floor(total)),
    startedAt: Date.now(),
    lastEmitAt: 0,
    mode: watch?.mode ?? "count",
    paths: watch?.paths ? [...watch.paths] : [],
    expectedFrames: watch?.expectedFrames ? [...watch.expectedFrames] : [],
  };
  ensurePoller();
  emit(true);
  setPolling(true);
  postStage();
}

export function progressWatch(watch: ProgressWatch): void {
  if (!stage) return;
  if (watch.mode) stage.mode = watch.mode;
  if (watch.paths) stage.paths = [...watch.paths];
  if (watch.expectedFrames) stage.expectedFrames = [...watch.expectedFrames];
  postStage();
}

export function progressSet(done: number, total?: number): void {
  if (!stage) return;
  if (typeof total === "number") stage.total = Math.max(0, Math.floor(total));
  stage.done = Math.max(0, Math.floor(done));
  emit(stage.total > 0 && stage.done >= stage.total);
  postStage();
}

/** Updates the active stage only when it is `name`, so a later stage is left alone. */
export function progressSetStage(name: string, done: number, total?: number): void {
  if (!stage || stage.name !== name) return;
  progressSet(done, total);
}

export function progressFinish(name?: string): void {
  if (!stage) return;
  if (name && stage.name !== name) return;
  if (stage.total <= 0) {
    stage.total = 1;
    stage.done = 1;
  } else {
    stage.done = stage.total;
  }
  setPolling(false);
  emit(true);
  stage = stack.pop() ?? null;
  if (stage) {
    setPolling(true);
    postStage();
  }
}

export function progressStop(): void {
  setPolling(false);
  stack.length = 0;
  stage = null;
  const worker = poller;
  poller = null;
  flag = null;
  if (!worker) return;
  worker.postMessage({ type: "stop" });
  void worker.terminate();
}
