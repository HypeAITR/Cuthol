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

/** Live hook (Cuthol Live render progress): mirrors stage events out of process. */
export interface ProgressHookEvent {
  type: "begin" | "set" | "finish" | "stop";
  name: string;
  done: number;
  total: number;
  /** Stack depth of the stage (1 = outermost). */
  depth: number;
  /** How the stage advances (ffmpeg modes are sampled, count is set). */
  mode: ProgressMode;
}

export type ProgressHook = (event: ProgressHookEvent) => void;

let progressHook: ProgressHook | null = null;

/** Registers the single live listener (null clears it). Never affects stderr output. */
export function setProgressHook(hook: ProgressHook | null): void {
  progressHook = hook;
}

/**
 * What the progress worker needs to keep `.cuthol/live/progress.json` fresh
 * while the main thread blocks inside long subprocess calls (encode): the
 * worker samples ffmpeg `-progress` files and rewrites the file every tick.
 * Finished stages ride along because the worker only tracks the current one.
 */
export interface ProgressLiveContext {
  file: string;
  preset: string;
  startedAt: number;
  encoder?: string;
  workers?: number;
  output?: string;
  shares: Record<string, number>;
  predictedTotal: number;
  expected: string[];
  finished: { name: string; done: number; total: number }[];
}

let liveContext: ProgressLiveContext | null = null;

/** Live file context the worker mirrors; null stops worker-side writes. */
export function setProgressLiveContext(ctx: ProgressLiveContext | null): void {
  liveContext = ctx;
}

function notifyHook(event: ProgressHookEvent): void {
  if (!progressHook) return;
  try {
    progressHook(event);
  } catch {
    // A listener must never break the running command.
  }
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
  live: null,
  knownJobs: [],
  endedJobs: [],
  completedJobs: 0,
};
let highWater = 0;

function eta(done, total, startedAt) {
  if (!(total > 0) || done <= 0) return "";
  if (done >= total) return " eta 0s";
  const sec = Math.max(0, Math.round(((Date.now() - startedAt) / done) * (total - done) / 1000));
  return sec < 90 ? " eta " + sec + "s" : " eta " + Math.round(sec / 60) + "m";
}

function readProgressFiles() {
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
      out.push({ name: name, text: buf.toString("utf8") });
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
    const files = readProgressFiles();
    if (state.mode === "ffmpeg-jobs") {
      const current = new Set();
      for (const f of files) {
        current.add(f.name);
        if (state.knownJobs.indexOf(f.name) < 0) state.knownJobs.push(f.name);
        if (f.text.indexOf("progress=end") >= 0 && state.endedJobs.indexOf(f.name) < 0) state.endedJobs.push(f.name);
      }
      // A job's -progress file is deleted as soon as the job completes, so the
      // end marker is usually gone before the next tick: a file seen on an
      // earlier tick and missing now means one more finished job. (A failed
      // job that is retried over-counts by one until the stage ends; the
      // stage still closes at its total.)
      for (let i = state.knownJobs.length - 1; i >= 0; i--) {
        const n = state.knownJobs[i];
        if (!current.has(n) && state.endedJobs.indexOf(n) < 0) {
          state.completedJobs += 1;
          state.knownJobs.splice(i, 1);
        }
      }
      sampled = state.endedJobs.length + state.completedJobs;
    } else {
      let frames = 0;
      for (const f of files) {
        const text = f.text;
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

function writeLiveFile(done) {
  const L = state.live;
  if (!L || !L.file) return;
  const now = Date.now();
  const stages = [];
  let fraction = 0;
  let shareSum = 0;
  let eta = 0;
  let etaKnown = false;
  for (const name of L.expected) {
    let s = null;
    for (const f of L.finished) {
      if (f.name === name) {
        s = { name: name, done: f.done, total: f.total, state: "done" };
        break;
      }
    }
    if (!s && name === state.name) s = { name: name, done: done, total: state.total, state: "running" };
    if (!s) s = { name: name, done: 0, total: 0, state: "queued" };
    stages.push(s);
    const share = L.shares[name] || 0;
    shareSum += share;
    const frac = s.total > 0 ? Math.min(1, s.done / s.total) : (s.state === "done" ? 1 : 0);
    fraction += share * frac;
    if (s.state === "done") continue;
    // Speeds younger than 5 s are startup noise (ffmpeg spin-up): use the
    // share estimate until the stage has run long enough to trust its speed.
    const stageAgeSec = (now - state.startedAt) / 1000;
    if (s.state === "running" && s.total > 0 && s.done > 0 && stageAgeSec >= 5) {
      const speed = s.done / Math.max(0.5, stageAgeSec);
      if (speed > 0) {
        // A measured crawl may overrun the share estimate, but never by more
        // than 3x (mirrors estimateEtaSec in live_progress.ts).
        const leftFrac = s.total > 0 ? Math.max(0, 1 - s.done / s.total) : 1;
        let stageEta = (s.total - s.done) / speed;
        if (L.predictedTotal > 0) stageEta = Math.min(stageEta, 3 * share * L.predictedTotal * leftFrac);
        eta += stageEta;
        etaKnown = true;
      }
    } else if (L.predictedTotal > 0) {
      const leftFrac = s.total > 0 ? Math.max(0, 1 - s.done / s.total) : 1;
      eta += share * L.predictedTotal * leftFrac;
      etaKnown = true;
    }
  }
  if (shareSum > 0) fraction = fraction / shareSum;
  const doc = {
    schema: "cuthol.live/1",
    kind: "render",
    preset: L.preset,
    state: "running",
    started_at: new Date(L.startedAt).toISOString(),
    updated_at: new Date(now).toISOString(),
    stages: stages,
    fraction: Math.min(1, Math.max(0, fraction)),
    eta_sec: etaKnown ? Math.max(0, Math.round(eta)) : null,
    elapsed_sec: Math.round(((now - L.startedAt) / 1000) * 10) / 10,
  };
  if (L.encoder) doc.encoder = L.encoder;
  if (L.workers) doc.workers = L.workers;
  if (L.output) doc.output = L.output;
  try {
    const tmp = L.file + ".tmp_" + state.pid + "_" + Math.random().toString(36).slice(2);
    fs.writeFileSync(tmp, JSON.stringify(doc));
    fs.renameSync(tmp, L.file);
  } catch {
    // A live write must never break the render.
  }
}

const port = parentPort;
const timer = setInterval(() => {
  if (!port || Atomics.load(flag, 0) !== 1 || !state.name || !(state.total > 0)) return;
  const done = sample();
  const count = " " + done + "/" + state.total;
  if (Atomics.load(flag, 0) !== 1) return;
  fs.writeSync(2, prefix + state.name + count + eta(done, state.total, state.startedAt) + "\\n");
  port.postMessage({ type: "sample", name: state.name, done });
  try {
    writeLiveFile(done);
  } catch {
    // A live write must never kill the progress ticker.
  }
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
    live: state.live,
    knownJobs: state.knownJobs,
    endedJobs: state.endedJobs,
    completedJobs: state.completedJobs,
  };
  if ("live" in msg) state.live = msg.live || null;
  if (nameChanged) {
    highWater = state.done;
    state.knownJobs = [];
    state.endedJobs = [];
    state.completedJobs = 0;
  }
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
    live: progressHook ? liveContext : null,
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
    // Samples feed the live hook only; without a listener nothing changes.
    poller.on("message", (msg: unknown) => {
      if (!progressHook || !msg || typeof msg !== "object") return;
      const sample = msg as { type?: unknown; name?: unknown; done?: unknown };
      if (sample.type !== "sample" || !stage || stage.name !== sample.name) return;
      if (typeof sample.done !== "number" || !Number.isFinite(sample.done)) return;
      const sampled = Math.max(0, Math.floor(sample.done));
      if (sampled <= stage.done) return;
      stage.done = stage.total > 0 ? Math.min(stage.total, sampled) : sampled;
      notifyHook({ type: "set", name: stage.name, done: stage.done, total: stage.total, depth: stack.length + 1, mode: stage.mode });
    });
    // Attaching the listener refs the worker again; release it so commands
    // that never call progressStop still exit (samples keep flowing anyway).
    poller.unref();
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
  notifyHook({ type: "begin", name: stage.name, done: 0, total: stage.total, depth: stack.length + 1, mode: stage.mode });
}

export function progressWatch(watch: ProgressWatch): void {
  if (!stage) return;
  if (watch.mode) stage.mode = watch.mode;
  if (watch.paths) stage.paths = [...watch.paths];
  if (watch.expectedFrames) stage.expectedFrames = [...watch.expectedFrames];
  postStage();
  notifyHook({ type: "set", name: stage.name, done: stage.done, total: stage.total, depth: stack.length + 1, mode: stage.mode });
}

export function progressSet(done: number, total?: number): void {
  if (!stage) return;
  if (typeof total === "number") stage.total = Math.max(0, Math.floor(total));
  stage.done = Math.max(0, Math.floor(done));
  emit(stage.total > 0 && stage.done >= stage.total);
  postStage();
  notifyHook({ type: "set", name: stage.name, done: stage.done, total: stage.total, depth: stack.length + 1, mode: stage.mode });
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
  notifyHook({ type: "finish", name: stage.name, done: stage.done, total: stage.total, depth: stack.length + 1, mode: stage.mode });
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
  notifyHook({ type: "stop", name: "", done: 0, total: 0, depth: 0, mode: "count" });
  const worker = poller;
  poller = null;
  flag = null;
  if (!worker) return;
  worker.postMessage({ type: "stop" });
  void worker.terminate();
}
