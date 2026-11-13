// Render progress for Cuthol Live: mirrors the core/progress stages of a running
// render into `.cuthol/live/progress.json` (LiveProgress) with an ETA. Cheap by
// design: one small atomic file write at most twice a second; the render plan,
// the outputs and the stderr lines are untouched. `CUTHOL_LIVE_PROGRESS=0`
// disables the file (escape hatch for measuring the overhead: none found).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setProgressHook,
  setProgressLiveContext,
  type ProgressHookEvent,
  type ProgressLiveContext,
  type ProgressMode,
} from "../core/progress.js";
import { writeJsonFileAtomically } from "./live_config.js";
import { resolveLivePaths } from "./live_paths.js";
import { LIVE_SCHEMA, type LiveProgress } from "./live_types.js";

/** Canonical render stage order; unknown stages sort after these. */
export const LIVE_RENDER_STAGE_ORDER = [
  "overlay",
  "audio segment",
  "encode",
  "blank scan",
  "edge scan",
  "audio health",
] as const;

/** Share of each stage in the total when no history exists yet (measured on the demo project, draft_480p). */
const DEFAULT_STAGE_SHARES: Record<string, number> = {
  overlay: 0.45,
  "audio segment": 0.03,
  encode: 0.35,
  "blank scan": 0.07,
  "edge scan": 0.02,
  "audio health": 0.08,
};

const WRITE_INTERVAL_MS = 500;
const SPEED_EMA_ALPHA = 0.35;
const HISTORY_CAP = 50;

/**
 * Coarse total for a first render (no history): draft encodes near realtime
 * plus cold-composition time. Replaced by history after one render.
 */
export function fallbackTotalSec(footageSec: number, comps: number): number {
  return Math.min(600, Math.max(15, footageSec * 1.2 + comps * 8));
}

// --------------------------------------------------------------------------- history

export interface RenderHistoryEntry {
  at: string;
  preset: string;
  frames: number;
  comps: number;
  total_sec: number;
  stages: Record<string, number>;
}

export function resolveRenderHistoryFile(): string | null {
  const override = process.env.CUTHOL_LIVE_HISTORY_FILE;
  if (override === "0") return null;
  if (override) return override;
  return path.join(os.homedir(), ".cuthol", "live", "render_history.json");
}

export function loadRenderHistory(): RenderHistoryEntry[] {
  const file = resolveRenderHistoryFile();
  if (!file) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is RenderHistoryEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as RenderHistoryEntry).preset === "string" &&
        typeof (e as RenderHistoryEntry).total_sec === "number" &&
        (e as RenderHistoryEntry).total_sec > 0 &&
        typeof (e as RenderHistoryEntry).frames === "number" &&
        typeof (e as RenderHistoryEntry).stages === "object"
    );
  } catch {
    return [];
  }
}

/** Best effort: a history write must never fail a render. */
export function recordRenderHistory(entry: RenderHistoryEntry): void {
  const file = resolveRenderHistoryFile();
  if (!file) return;
  try {
    const entries = loadRenderHistory();
    entries.push(entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonFileAtomically(file, entries.slice(-HISTORY_CAP));
  } catch {
    // Ignore: history is advisory.
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Each stage's share of the total render time: median of same-preset history,
 * default share when the stage never ran there. Normalized to sum 1.
 */
export function predictStageShares(preset: string, stages: string[]): Record<string, number> {
  const past = loadRenderHistory().filter((e) => e.preset === preset);
  const shares: Record<string, number> = {};
  for (const name of stages) {
    const seen = past
      .map((e) => (e.stages[name] ?? 0) / e.total_sec)
      .filter((v) => v > 0 && v <= 1);
    shares[name] = seen.length > 0 ? median(seen) : (DEFAULT_STAGE_SHARES[name] ?? 0.02);
  }
  const sum = Object.values(shares).reduce((a, b) => a + b, 0);
  if (sum > 0) for (const name of stages) shares[name] /= sum;
  return shares;
}

/**
 * Total render seconds for this shape: same-preset history scaled by frame
 * count (median), other presets when none, null when there is no history.
 * Both ratios are clamped: history from a wildly different shape (a short
 * comp-heavy project, another preset) must not scale a small past run into a
 * hours-long prediction for this one.
 */
export function predictTotalSec(preset: string, frames: number, comps: number): number | null {
  const all = loadRenderHistory().filter((e) => e.frames > 0);
  if (all.length === 0) return null;
  const same = all.filter((e) => e.preset === preset);
  const pool = same.length > 0 ? same : all;
  const scaled = pool.map((e) => {
    const frameRatio = Math.min(5, Math.max(0.2, Math.max(1, frames) / Math.max(1, e.frames)));
    // Compositions dominate overlay time: scale their part by comp count too.
    const overlaySec = e.stages["overlay"] ?? 0;
    const restSec = Math.max(0, e.total_sec - overlaySec);
    const compRatio =
      overlaySec > 0 && (e.comps ?? 0) > 0
        ? Math.min(4, Math.max(0.25, comps / Math.max(1, e.comps ?? 1)))
        : comps > 0 ? 1 : 0;
    return restSec * frameRatio + overlaySec * frameRatio * compRatio;
  });
  return Math.max(1, median(scaled));
}

// --------------------------------------------------------------------------- ETA

export interface EtaStageInput {
  name: string;
  done: number;
  total: number;
  state: "queued" | "running" | "done" | "failed";
  /** Seconds since the stage started; speeds younger than 5 s are startup noise. */
  elapsedSec?: number;
}

/** Stage age from which a measured speed beats the share estimate. */
export const ETA_SPEED_WARMUP_SEC = 5;

/**
 * How far past its share estimate one stage's measured speed may push the ETA.
 * Early speeds are noisy (one composition finished during spin-up reads as a
 * crawl); without the clamp a first render opens with hours of Remaining.
 */
export const ETA_SPEED_OVERRUN_FACTOR = 3;

/**
 * Remaining seconds: running stages past warmup from their EMA speed, younger
 * or speed-less stages from their share of the predicted total (scaled by the
 * unfinished fraction). A measured speed may report a stage as slower than its
 * share estimate, but never by more than ETA_SPEED_OVERRUN_FACTOR. Null when
 * nothing is known yet.
 */
export function estimateEtaSec(args: {
  stages: EtaStageInput[];
  shares: Record<string, number>;
  speeds: Record<string, number>;
  predictedTotalSec: number | null;
}): number | null {
  let remaining = 0;
  let known = false;
  for (const s of args.stages) {
    if (s.state === "done") continue;
    if (s.total > 0 && s.done >= s.total) continue;
    const speed = args.speeds[s.name] ?? 0;
    const warmed = s.elapsedSec == null || s.elapsedSec >= ETA_SPEED_WARMUP_SEC;
    const leftFrac = s.total > 0 ? Math.max(0, 1 - s.done / s.total) : 1;
    if (s.state === "running" && speed > 0 && s.total > 0 && warmed) {
      let stageEta = (s.total - s.done) / speed;
      if (args.predictedTotalSec != null && args.predictedTotalSec > 0) {
        stageEta = Math.min(stageEta, ETA_SPEED_OVERRUN_FACTOR * (args.shares[s.name] ?? 0) * args.predictedTotalSec * leftFrac);
      }
      remaining += stageEta;
      known = true;
      continue;
    }
    if (args.predictedTotalSec != null && args.predictedTotalSec > 0) {
      remaining += (args.shares[s.name] ?? 0) * args.predictedTotalSec * leftFrac;
      known = true;
    }
  }
  if (!known) return null;
  return Math.max(0, Math.round(remaining));
}

function orderStages(names: string[]): string[] {
  const order = [...LIVE_RENDER_STAGE_ORDER];
  return [...names].sort((a, b) => {
    const ia = order.indexOf(a as (typeof order)[number]);
    const ib = order.indexOf(b as (typeof order)[number]);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

// --------------------------------------------------------------------------- session

interface StageRuntime {
  name: string;
  done: number;
  total: number;
  state: "queued" | "running" | "done" | "failed";
  mode: ProgressMode;
  /** Exponential moving average speed in units/sec. */
  emaSpeed: number;
  lastDone: number;
  lastAtMs: number;
  startedAtMs: number;
  endedAtMs: number;
}

export interface LiveRenderBeginOptions {
  projectDir: string;
  preset: string;
  frames: number;
  comps: number;
  footageSec: number;
  expectOverlay: boolean;
  encoder?: string;
  workers?: number;
  output?: string;
}

interface LiveRenderSession {
  projectDir: string;
  preset: string;
  encoder?: string;
  workers?: number;
  output?: string;
  frames: number;
  comps: number;
  startedAtMs: number;
  shares: Record<string, number>;
  predictedTotalSec: number;
  stages: Map<string, StageRuntime>;
  lastWriteMs: number;
  finished: boolean;
  findings: string[];
  finalState: LiveProgress["state"];
  error?: LiveProgress["error"];
}

let session: LiveRenderSession | null = null;

function newStageRuntime(name: string): StageRuntime {
  return {
    name,
    done: 0,
    total: 0,
    state: "queued",
    mode: "count",
    emaSpeed: 0,
    lastDone: 0,
    lastAtMs: 0,
    startedAtMs: 0,
    endedAtMs: 0,
  };
}

function buildLiveContext(s: LiveRenderSession): ProgressLiveContext {
  return {
    file: resolveLivePaths(s.projectDir).progressFile,
    preset: s.preset,
    startedAt: s.startedAtMs,
    ...(s.encoder ? { encoder: s.encoder } : {}),
    ...(s.workers ? { workers: s.workers } : {}),
    ...(s.output ? { output: s.output } : {}),
    shares: { ...s.shares },
    predictedTotal: s.predictedTotalSec,
    expected: orderStages([...s.stages.keys()]),
    finished: [...s.stages.values()]
      .filter((st) => st.state === "done")
      .map((st) => ({ name: st.name, done: st.done, total: st.total })),
  };
}

function refreshLiveContext(s: LiveRenderSession): void {
  if (!s.finished) setProgressLiveContext(buildLiveContext(s));
}

/** True while a render owns the progress hook (test seam: no public reset needed, begin replaces). */
export function liveRenderActive(): boolean {
  return session !== null && !session.finished;
}

export function beginLiveRender(opts: LiveRenderBeginOptions): void {
  if (process.env.CUTHOL_LIVE_PROGRESS === "0") {
    session = null;
    return;
  }
  const expected = [
    ...(opts.expectOverlay ? ["overlay"] : []),
    "encode",
    "blank scan",
    "edge scan",
    "audio health",
  ];
  const shares = predictStageShares(opts.preset, [...expected, "audio segment"]);
  const predictedTotalSec =
    predictTotalSec(opts.preset, opts.frames, opts.comps) ?? fallbackTotalSec(opts.footageSec, opts.comps);
  const stages = new Map<string, StageRuntime>();
  for (const name of expected) stages.set(name, newStageRuntime(name));
  session = {
    projectDir: opts.projectDir,
    preset: opts.preset,
    encoder: opts.encoder,
    workers: opts.workers,
    output: opts.output,
    frames: opts.frames,
    comps: opts.comps,
    startedAtMs: Date.now(),
    shares,
    predictedTotalSec,
    stages,
    lastWriteMs: 0,
    finished: false,
    findings: [],
    finalState: "running",
  };
  setProgressLiveContext(buildLiveContext(session));
  setProgressHook(handleProgressEvent);
  writeProgress(true);
}

function handleProgressEvent(ev: ProgressHookEvent): void {
  const s = session;
  if (!s || s.finished || ev.type === "stop" || ev.depth !== 1) return;
  let st = s.stages.get(ev.name);
  if (!st) {
    st = newStageRuntime(ev.name);
    s.stages.set(ev.name, st);
  }
  const now = Date.now();
  if (ev.type === "begin") {
    st.mode = ev.mode;
    if (st.state === "queued") {
      st.state = "running";
      st.done = 0;
      st.total = ev.total;
      st.startedAtMs = now;
      st.lastDone = 0;
      st.lastAtMs = now;
      // A later stage starting means an earlier expected one never ran (e.g.
      // a render path without it): close it so the window never shows it queued.
      for (const name of LIVE_RENDER_STAGE_ORDER) {
        if (name === ev.name) break;
        const earlier = s.stages.get(name);
        if (earlier && earlier.state === "queued") {
          earlier.state = "done";
          earlier.startedAtMs = now;
          earlier.endedAtMs = now;
        }
      }
    }
  } else if (ev.type === "set") {
    st.mode = ev.mode;
    if (st.state === "queued") {
      st.state = "running";
      st.startedAtMs = now;
      st.lastDone = 0;
      st.lastAtMs = now;
    }
    if (ev.total > 0) st.total = ev.total;
    const done = Math.max(0, Math.min(st.total > 0 ? st.total : ev.done, ev.done));
    if (done !== st.done) {
      const dtSec = (now - st.lastAtMs) / 1000;
      if (dtSec > 0 && done > st.lastDone) {
        const inst = (done - st.lastDone) / dtSec;
        st.emaSpeed = st.emaSpeed > 0 ? SPEED_EMA_ALPHA * inst + (1 - SPEED_EMA_ALPHA) * st.emaSpeed : inst;
      }
      st.done = done;
      st.lastDone = done;
      st.lastAtMs = now;
    }
  } else if (ev.type === "finish") {
    if (st.total > 0) st.done = st.total;
    else if (ev.total > 0) {
      st.total = ev.total;
      st.done = ev.total;
    } else {
      st.done = Math.max(st.done, 1);
      st.total = Math.max(st.total, st.done);
    }
    st.state = "done";
    if (!st.startedAtMs) st.startedAtMs = now;
    st.endedAtMs = now;
  }
  refreshLiveContext(s);
  writeProgress(false);
}

function writeProgress(force: boolean): void {
  const s = session;
  if (!s) return;
  const now = Date.now();
  if (!force && now - s.lastWriteMs < WRITE_INTERVAL_MS) return;
  s.lastWriteMs = now;
  const names = orderStages([...s.stages.keys()]);
  const shareSum = names.reduce((a, n) => a + (s.shares[n] ?? 0), 0);
  let fraction = 0;
  for (const n of names) {
    const st = s.stages.get(n)!;
    const frac = st.total > 0 ? Math.min(1, st.done / st.total) : st.state === "done" ? 1 : 0;
    fraction += ((s.shares[n] ?? 0) / (shareSum > 0 ? shareSum : 1)) * frac;
  }
  const speeds: Record<string, number> = {};
  for (const n of names) speeds[n] = s.stages.get(n)!.emaSpeed;
  const elapsedSec = Math.max(0, Math.round(((now - s.startedAtMs) / 1000) * 10) / 10);
  const progress: LiveProgress = {
    schema: LIVE_SCHEMA,
    kind: "render",
    preset: s.preset,
    state: s.finished ? s.finalState : "running",
    started_at: new Date(s.startedAtMs).toISOString(),
    updated_at: new Date(now).toISOString(),
    stages: names.map((n) => {
      const st = s.stages.get(n)!;
      return { name: st.name, done: st.done, total: st.total, state: st.state };
    }),
    fraction: s.finished && s.finalState === "done" ? 1 : Math.min(1, Math.max(0, fraction)),
    eta_sec:
      s.finished && s.finalState !== "running"
        ? 0
        : estimateEtaSec({
            stages: names.map((n) => {
              const st = s.stages.get(n)!;
              return {
                name: st.name,
                done: st.done,
                total: st.total,
                state: st.state,
                elapsedSec: st.startedAtMs > 0 ? (now - st.startedAtMs) / 1000 : 0,
              };
            }),
            shares: s.shares,
            speeds,
            predictedTotalSec: s.predictedTotalSec,
          }),
    elapsed_sec: elapsedSec,
    ...(s.encoder ? { encoder: s.encoder } : {}),
    ...(s.workers ? { workers: s.workers } : {}),
    ...(s.output ? { output: s.output } : {}),
    ...(s.finished && s.finalState === "done" ? { findings: [...s.findings] } : {}),
    ...(s.finished && s.finalState === "failed" && s.error ? { error: { ...s.error } } : {}),
  };
  try {
    const lp = resolveLivePaths(s.projectDir);
    fs.mkdirSync(lp.dir, { recursive: true });
    writeJsonFileAtomically(lp.progressFile, progress);
  } catch {
    // Progress must never fail a render.
  }
}

export function finishLiveRender(findings: string[]): void {
  const s = session;
  if (!s || s.finished) return;
  const now = Date.now();
  for (const [name, st] of s.stages) {
    if (!st.startedAtMs) {
      s.stages.delete(name);
      continue;
    }
    st.state = "done";
    if (st.total > 0) st.done = st.total;
    if (!st.endedAtMs) st.endedAtMs = now;
  }
  s.findings = [...findings];
  s.finalState = "done";
  s.finished = true;
  setProgressHook(null);
  setProgressLiveContext(null);
  writeProgress(true);
  const stageSecs: Record<string, number> = {};
  for (const st of s.stages.values()) {
    if (st.startedAtMs > 0 && st.endedAtMs >= st.startedAtMs) {
      stageSecs[st.name] = Math.max(0.05, (st.endedAtMs - st.startedAtMs) / 1000);
    }
  }
  recordRenderHistory({
    at: new Date(now).toISOString(),
    preset: s.preset,
    frames: s.frames,
    comps: s.comps,
    total_sec: Math.max(0.1, (now - s.startedAtMs) / 1000),
    stages: stageSecs,
  });
}

/**
 * Marks the render failed: every stage that was still running becomes `failed`
 * (later stages stay queued — they never ran), and the stopping diagnostic is
 * recorded on the progress document for the window. Failed runs never pollute
 * the ETA history.
 */
export function failLiveRender(error?: { code: string; message: string; suggestion?: string }): void {
  const s = session;
  if (!s || s.finished) return;
  const now = Date.now();
  for (const st of s.stages.values()) {
    if (st.state === "running") {
      st.state = "failed";
      if (!st.startedAtMs) st.startedAtMs = now;
      st.endedAtMs = now;
    }
  }
  if (error) s.error = { code: error.code, message: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}) };
  s.finalState = "failed";
  s.finished = true;
  setProgressHook(null);
  setProgressLiveContext(null);
  writeProgress(true);
}