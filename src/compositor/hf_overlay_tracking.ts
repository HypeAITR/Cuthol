// Overlay render bookkeeping: per-render summary, concurrent pre-pass collector and runner, HyperFrames pipeline summary parsing (split out of hyperframes_bridge.ts).
import fs from "node:fs";
import path from "node:path";
import { CutholDiagnostic, createSubprocessFailureDiagnostic, CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  resolveHyperFramesWorkers,
  resolveOverlayConcurrency
} from "../core/env.js";
import {
  type ParallelFfmpegJob,
  runWatchedParallelFfmpegJobsSync,
  spawnWatchedSync,
} from "../core/subprocess.js";
import { progressSetStage, progressWatch } from "../core/progress.js";
import { isValidVideoBlobOnDisk } from "./hf_blobs.js";
import { ensureHyperFramesRenderLockDefault, hyperFramesProcessEnv } from "./hf_common.js";

export type OverlayCacheReason =
  | "cached"
  | "new"
  | "html_changed"
  | "renderer_version_changed"
  | "slice_changed"
  | "global_used_changed"
  | "props_changed"
  | "backdrop_changed"
  | "blob_missing";

export interface HyperFramesPipelineSummaryInfo {
  hf_summary: string | null;
  capture_mode: string | null;
  gpu_mode: string | null;
  streaming_encode: boolean;
  stages_sec: Record<string, number>;
}

function parseDurationSecToken(raw: string): number | null {
  const s = raw.trim();
  const minSec = /^(\d+)m\s+([\d.]+)s$/i.exec(s);
  if (minSec) {
    return Number((Number(minSec[1]) * 60 + Number(minSec[2])).toFixed(3));
  }
  const secOnly = /^([\d.]+)s$/i.exec(s);
  if (secOnly) {
    return Number(Number(secOnly[1]).toFixed(3));
  }
  return null;
}

/**
 * Extracts HyperFrames' pipeline summary line (`<mode> capture · <gpu> gpu · compile ... · capture ... · encode ...`)
 * from stdout/stderr and parses capture mode, GPU mode, streaming encode status, and stage timings.
 */
export function parseHyperFramesPipelineSummary(
  rawStdout: string,
  rawStderr = ""
): HyperFramesPipelineSummaryInfo {
  const combined = `${rawStdout || ""}\n${rawStderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = combined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let summaryLine: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (
      /\b[a-z0-9_-]+\s+capture\b/i.test(line) &&
      (line.includes("·") || /\b(?:compile|setup|encode)\s+\d/i.test(line))
    ) {
      summaryLine = line;
      break;
    }
  }

  let captureMode: string | null = null;
  let gpuMode: string | null = null;
  let streamingEncode = false;
  const stagesSec: Record<string, number> = {};

  if (summaryLine) {
    const segments = summaryLine.split(/\s*·\s*/).map((s) => s.trim());
    for (const seg of segments) {
      const capMatch = /^([a-z0-9_-]+)\s+capture$/i.exec(seg);
      if (capMatch) {
        captureMode = capMatch[1].toLowerCase();
        continue;
      }
      const gpuMatch = /^([a-z0-9_-]+)\s+gpu$/i.exec(seg);
      if (gpuMatch) {
        gpuMode = gpuMatch[1].toLowerCase();
        continue;
      }
      const encStreamMatch = /^encode\s+\(during\s+capture\)\s+(.+)$/i.exec(seg);
      if (encStreamMatch) {
        streamingEncode = true;
        const sec = parseDurationSecToken(encStreamMatch[1]);
        if (sec !== null) stagesSec.encode = sec;
        continue;
      }
      const stageMatch = /^(compile|extract|audio|probe|setup|capture|encode|assemble)\s+(.+)$/i.exec(seg);
      if (stageMatch) {
        const key = stageMatch[1].toLowerCase();
        const sec = parseDurationSecToken(stageMatch[2]);
        if (sec !== null) stagesSec[key] = sec;
      }
    }
  }

  return {
    hf_summary: summaryLine,
    capture_mode: captureMode,
    gpu_mode: gpuMode,
    streaming_encode: streamingEncode,
    stages_sec: stagesSec,
  };
}

/** One composition whose script failed while sibling timelines stayed alive (G415 source). */
export interface HyperFramesScriptErrorIsolated {
  /** Host slot element id (`bad-slot`); falls back to the composition id when the slot is unknown. */
  element: string;
  composition_id: string | null;
  /** The script failure text (`Error: ...`), truncated. */
  error: string;
}

/** An isolated script error attributed to the overlay composition that produced it. */
export interface HyperFramesScriptErrorReport extends HyperFramesScriptErrorIsolated {
  composition: string;
}

/**
 * Finds isolated composition-script failures in HyperFrames render output (0.8.191+, PR #6156).
 * A sub-composition whose script throws is skipped with an empty timeline and only a warning when
 * another live timeline exists; without this parse that overlay part comes out silently blank.
 * Matches two stderr signals (stdout never carries them, but is scanned too):
 * - `[script_error_isolated] A composition script failed, so its animation was skipped and the
 *   render went on: <element> (runtime-error:<compId> <error>)` (also as `[FrameCapture:...]`),
 * - the raw page signal `[HyperFrames] composition script error: <compId> <error>`, which also
 *   covers `data-no-timeline` slots that go blank with no isolation warning at all.
 * Entries from both signals are deduplicated per composition+error.
 */
export function parseHyperFramesScriptErrorIsolated(
  rawStdout: string,
  rawStderr = ""
): HyperFramesScriptErrorIsolated[] {
  const combined = `${rawStdout || ""}\n${rawStderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  const found: HyperFramesScriptErrorIsolated[] = [];
  const seen = new Set<string>();
  const isolatedRe =
    /\[script_error_isolated\]\s*A composition script failed, so its animation was skipped and the render went on:\s*(\S+)\s*\(runtime-error:([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = isolatedRe.exec(combined)) !== null) {
    const element = m[1].trim();
    const runtimeError = m[2].trim();
    const sp = runtimeError.indexOf(" ");
    const compositionId = sp > 0 ? runtimeError.slice(0, sp) : null;
    const error = (sp > 0 ? runtimeError.slice(sp + 1) : runtimeError).slice(0, 300);
    const key = `${element}::${compositionId ?? ""}::${error}`;
    if (element && !seen.has(key)) {
      seen.add(key);
      found.push({ element, composition_id: compositionId, error });
    }
  }
  const rawRe = /\[HyperFrames\] composition script error:\s*(\S+)\s+([^\r\n]+)/g;
  while ((m = rawRe.exec(combined)) !== null) {
    const compositionId = m[1].trim();
    const error = m[2].trim().slice(0, 300);
    const covered = found.some(
      (f) =>
        f.composition_id === compositionId &&
        (f.error === error || error.startsWith(f.error) || f.error.startsWith(error))
    );
    if (covered || !compositionId) continue;
    const key = `::${compositionId}::${error}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ element: compositionId, composition_id: compositionId, error });
  }
  return found;
}

export function readBlobMetaSummary(blobPath: string): Partial<HyperFramesPipelineSummaryInfo> & { script_errors?: HyperFramesScriptErrorIsolated[] } {
  const metaPath = `${blobPath}.meta.json`;
  if (!fs.existsSync(metaPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return {
      hf_summary: typeof parsed.hf_summary === "string" ? parsed.hf_summary : null,
      capture_mode: typeof parsed.capture_mode === "string" ? parsed.capture_mode : null,
      gpu_mode: typeof parsed.gpu_mode === "string" ? parsed.gpu_mode : null,
      streaming_encode: Boolean(parsed.streaming_encode),
      stages_sec:
        parsed.stages_sec && typeof parsed.stages_sec === "object" ? parsed.stages_sec : {},
      script_errors: Array.isArray(parsed.script_errors)
        ? (parsed.script_errors as Array<Record<string, unknown>>)
            .filter((s) => typeof s.element === "string" && typeof s.error === "string")
            .map((s) => ({
              element: s.element as string,
              composition_id: typeof s.composition_id === "string" ? s.composition_id : null,
              error: s.error as string,
            }))
        : undefined,
    };
  } catch {
    return {};
  }
}

export interface OverlayRenderItemSummary {
  composition: string;
  composition_dir: string;
  blob_path: string;
  cached: boolean;
  reason: OverlayCacheReason;
  elapsed_ms: number;
  capture_mode?: string | null;
  gpu_mode?: string | null;
  streaming_encode?: boolean;
  hf_summary?: string | null;
  stages_sec?: Record<string, number>;
  script_errors?: HyperFramesScriptErrorIsolated[];
}

export interface RenderOverlaySummary {
  total: number;
  cached: number;
  rendered: number;
  concurrency?: number;
  workers?: number;
  capture_modes?: Record<string, number>;
  gpu_modes?: Record<string, number>;
  stage_totals_sec?: Record<string, number>;
  script_errors?: HyperFramesScriptErrorReport[];
  diagnostics?: CutholDiagnostic[];
  reasons: Record<string, number>;
  elapsed_ms: number;
  rerendered: Array<{
    composition: string;
    reason: OverlayCacheReason;
    elapsed_ms: number;
    capture_mode?: string | null;
    gpu_mode?: string | null;
    streaming_encode?: boolean;
    hf_summary?: string | null;
    stages_sec?: Record<string, number>;
  }>;
  summary: string;
}

let activeOverlayTrackingMap: Map<string, OverlayRenderItemSummary> | null = null;

let activeOverlayPrepassWallMs = 0;

let activeOverlayConcurrencyMeta: { concurrency: number; workers: number } | null = null;

let activeNativeCaptureForMasterReuse = false;

export function beginOverlayRenderTracking(meta?: {
  concurrency?: number;
  workers?: number;
  nativeCaptureForMasterReuse?: boolean;
}): void {
  activeOverlayTrackingMap = new Map<string, OverlayRenderItemSummary>();
  activeOverlayPrepassWallMs = 0;
  activeNativeCaptureForMasterReuse = Boolean(meta?.nativeCaptureForMasterReuse);
  activeOverlayConcurrencyMeta = meta
    ? {
        concurrency: meta.concurrency ?? 1,
        workers: meta.workers ?? resolveHyperFramesWorkers(),
      }
    : null;
}

export function setOverlayRenderExecutionMeta(meta: { concurrency: number; workers: number }): void {
  activeOverlayConcurrencyMeta = { ...meta };
}

export function finishOverlayRenderTracking(): RenderOverlaySummary {
  const items = activeOverlayTrackingMap ? [...activeOverlayTrackingMap.values()] : [];
  const wallPrepassMs = activeOverlayPrepassWallMs;
  const execMeta = activeOverlayConcurrencyMeta;
  const nativeCaptureForMasterReuse = activeNativeCaptureForMasterReuse;
  activeOverlayTrackingMap = null;
  activeOverlayPrepassWallMs = 0;
  activeOverlayConcurrencyMeta = null;
  activeNativeCaptureForMasterReuse = false;

  const scriptErrors: HyperFramesScriptErrorReport[] = [];
  const scriptErrorKeys = new Set<string>();
  const total = items.length;
  let cached = 0;
  let rendered = 0;
  let sumElapsedMs = 0;
  const reasons: Record<string, number> = {};
  const captureModes: Record<string, number> = {};
  const gpuModes: Record<string, number> = {};
  const stageTotalsSec: Record<string, number> = {};
  const rerendered: RenderOverlaySummary["rerendered"] = [];

  for (const item of items) {
    sumElapsedMs += item.elapsed_ms;
    if (item.script_errors) {
      for (const s of item.script_errors) {
        const key = `${item.composition}::${s.element}::${s.composition_id ?? ""}::${s.error}`;
        if (!scriptErrorKeys.has(key)) {
          scriptErrorKeys.add(key);
          scriptErrors.push({ composition: item.composition, ...s });
        }
      }
    }
    if (item.capture_mode) {
      captureModes[item.capture_mode] = (captureModes[item.capture_mode] ?? 0) + 1;
    }
    if (item.gpu_mode) {
      gpuModes[item.gpu_mode] = (gpuModes[item.gpu_mode] ?? 0) + 1;
    }
    if (item.cached) {
      cached += 1;
    } else {
      rendered += 1;
      reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
      if (item.stages_sec) {
        for (const [k, v] of Object.entries(item.stages_sec)) {
          if (typeof v === "number" && Number.isFinite(v)) {
            stageTotalsSec[k] = Number(((stageTotalsSec[k] ?? 0) + v).toFixed(3));
          }
        }
      }
      rerendered.push({
        composition: item.composition,
        reason: item.reason,
        elapsed_ms: item.elapsed_ms,
        ...(item.capture_mode ? { capture_mode: item.capture_mode } : {}),
        ...(item.gpu_mode ? { gpu_mode: item.gpu_mode } : {}),
        ...(item.streaming_encode !== undefined ? { streaming_encode: item.streaming_encode } : {}),
        ...(item.hf_summary ? { hf_summary: item.hf_summary } : {}),
        ...(item.stages_sec && Object.keys(item.stages_sec).length > 0
          ? { stages_sec: item.stages_sec }
          : {}),
      });
    }
  }

  const elapsedMs = wallPrepassMs > 0 ? wallPrepassMs : sumElapsedMs;
  const secStr = `${(elapsedMs / 1000).toFixed(2)}s`;
  let summary: string;
  if (total === 0) {
    summary = `0 overlays (${secStr})`;
  } else if (rendered === 0) {
    summary = nativeCaptureForMasterReuse
      ? `${cached}/${total} cached, 0 rendered (native capture for master reuse; ${secStr})`
      : `${cached}/${total} cached, 0 rendered (${secStr})`;
  } else {
    const reasonParts = Object.entries(reasons)
      .map(([r, c]) => `${r}=${c}`)
      .join(", ");
    const names = rerendered
      .slice(0, 5)
      .map((r) => `${r.composition}:${r.reason}`)
      .join(", ");
    const more = rerendered.length > 5 ? ` +${rerendered.length - 5}` : "";
    const modeParts: string[] = [];
    if (Object.keys(captureModes).length > 0) {
      modeParts.push(
        `capture=${Object.entries(captureModes)
          .map(([m, c]) => `${m}:${c}`)
          .join(",")}`
      );
    }
    if (execMeta) {
      modeParts.push(`K=${execMeta.concurrency}xW=${execMeta.workers}`);
    }
    if (nativeCaptureForMasterReuse) {
      modeParts.push("native capture for master reuse");
    }
    const modeSuffix = modeParts.length > 0 ? `; ${modeParts.join(", ")}` : "";
    summary = `${cached}/${total} cached, ${rendered} rendered (${reasonParts}; ${names}${more}${modeSuffix}) in ${secStr}`;
  }
  const scriptErrorDiagnostics: CutholDiagnostic[] = scriptErrors.map((s) =>
    DIAGNOSTICS.SCRIPT_ERROR_ISOLATED(s.composition, s.element, s.composition_id, s.error)
  );
  if (scriptErrors.length > 0) {
    const shown = scriptErrors
      .slice(0, 3)
      .map((s) => `${s.composition}/${s.element}`)
      .join(", ");
    summary += `; script_error_isolated(${scriptErrors.length}): ${shown}${scriptErrors.length > 3 ? ` +${scriptErrors.length - 3} more` : ""}`;
  }

  return {
    total,
    cached,
    rendered,
    ...(execMeta ? { concurrency: execMeta.concurrency, workers: execMeta.workers } : {}),
    ...(Object.keys(captureModes).length > 0 ? { capture_modes: captureModes } : {}),
    ...(Object.keys(gpuModes).length > 0 ? { gpu_modes: gpuModes } : {}),
    ...(Object.keys(stageTotalsSec).length > 0 ? { stage_totals_sec: stageTotalsSec } : {}),
    ...(scriptErrors.length > 0 ? { script_errors: scriptErrors } : {}),
    ...(scriptErrorDiagnostics.length > 0 ? { diagnostics: scriptErrorDiagnostics } : {}),
    reasons,
    elapsed_ms: elapsedMs,
    rerendered,
    summary,
  };
}

export function recordOverlayRenderOutcome(item: OverlayRenderItemSummary): void {
  if (!activeOverlayTrackingMap) return;
  const key = path.resolve(item.composition_dir);
  const existing = activeOverlayTrackingMap.get(key);
  if (!existing) {
    activeOverlayTrackingMap.set(key, { ...item });
    progressSetStage("overlay", activeOverlayTrackingMap.size);
    return;
  }
  if (!item.cached) {
    existing.cached = false;
    existing.reason = item.reason;
    existing.blob_path = item.blob_path;
    existing.elapsed_ms = item.elapsed_ms;
    if (item.capture_mode) existing.capture_mode = item.capture_mode;
    if (item.gpu_mode) existing.gpu_mode = item.gpu_mode;
    if (item.streaming_encode !== undefined) existing.streaming_encode = item.streaming_encode;
    if (item.hf_summary) existing.hf_summary = item.hf_summary;
    if (item.stages_sec) existing.stages_sec = item.stages_sec;
    if (item.script_errors) existing.script_errors = item.script_errors;
  } else if (existing.cached) {
    existing.elapsed_ms += item.elapsed_ms;
  }
}

interface CollectedOverlayJob {
  compName: string;
  compositionDir: string;
  absCompDir: string;
  outBlob: string;
  tmpBlob: string;
  watchTargetPath: string;
  expectedFrames?: number;
  args: string[];
  fallbackNoGpuArgs: string[] | null;
  wantGpu: boolean;
  workers: number;
  stageDirToClean: string | null;
  finalizeSuccess: (params: {
    usedGpu: boolean;
    gpuFallbackReason: string | null;
    elapsedMs: number;
    stdoutStr: string;
    stderrStr: string;
  }) => void;
  cleanupTemp: () => void;
}

export let overlayCollector: CollectedOverlayJob[] | null = null;

export function beginOverlayCollect(): void {
  overlayCollector = [];
}

export function isOverlayCollectActive(): boolean {
  return overlayCollector !== null;
}

export function hasPendingCollectedOverlayForPaths(candidatePaths: string[]): boolean {
  if (!overlayCollector || overlayCollector.length === 0) return false;
  const pendingSet = new Set(overlayCollector.map((j) => path.resolve(j.outBlob)));
  return candidatePaths.some((p) => {
    if (!p || p.startsWith("-")) return false;
    try {
      const resolved = path.resolve(p);
      return pendingSet.has(resolved) || pendingSet.has(path.dirname(resolved));
    } catch {
      return false;
    }
  });
}

export function buildHyperFramesFailureError(
  compositionDir: string,
  renderArgs: string[],
  proc: {
    status: number | null;
    signal?: NodeJS.Signals | null;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    error?: Error;
    stalled?: boolean;
    stalledMs?: number;
    stallThresholdMs?: number;
    lastProgress?: string;
    commandSummary?: string;
  }
): CutholError {
  const stdoutStr =
    typeof proc.stdout === "string"
      ? proc.stdout
      : proc.stdout
        ? proc.stdout.toString("utf8")
        : "";
  const stderrStr =
    typeof proc.stderr === "string"
      ? proc.stderr
      : proc.stderr
        ? proc.stderr.toString("utf8")
        : "";

  if (proc.stalled) {
    return new CutholError(
      createSubprocessFailureDiagnostic({
        tool: `hyperframes render (${compositionDir})`,
        executable: process.execPath,
        args: renderArgs,
        proc: {
          status: proc.status,
          error: proc.error,
          stderr: stderrStr,
          stalled: proc.stalled,
          stalledMs: proc.stalledMs,
          stallThresholdMs: proc.stallThresholdMs,
          lastProgress: proc.lastProgress,
          commandSummary: proc.commandSummary,
        },
      })
    );
  }

  const logLines = `${stderrStr}\n${stdoutStr}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("[INFO]"));
  const errorLines = logLines.filter((l) => /error|fail|exception|timeout|cannot|not found/i.test(l));
  // Never cut the head: the first line names the failure ("Failed: Render blocked by ...").
  // Only pathological logs (multi-KB lines) lose their tail, never their meaning.
  const joined =
    (errorLines.length > 0 ? errorLines : logLines).slice(-3).join(" | ") ||
    `exit=${proc.status ?? proc.signal}`;
  const detail = proc.error
    ? proc.error.message
    : joined.length > 2000
      ? `${joined.slice(0, 2000)}…`
      : joined;
  return new CutholError(DIAGNOSTICS.HYPERFRAMES_RENDER_FAILED(compositionDir, detail));
}

/**
 * Executes all collected cold overlay renders concurrently (up to `K` at a time, each with `W` workers),
 * finalizes every successful overlay into `.cuthol/blobs/`, and if any overlay failed, throws its exact
 * `CUTHOL-G503` / `CUTHOL-SYS10` error after all sibling jobs have finished.
 */
export function runCollectedOverlays(options?: {
  concurrency?: number | null;
  workers?: number | null;
  keepCollecting?: boolean;
}): {
  jobs: number;
  concurrency: number;
  workers: number;
  elapsed_ms: number;
} {
  ensureHyperFramesRenderLockDefault();
  const jobs = overlayCollector ?? [];
  overlayCollector = options?.keepCollecting ? [] : null;
  const w = resolveHyperFramesWorkers(options?.workers);

  if (jobs.length === 0) {
    const k0 = resolveOverlayConcurrency({
      overrideConcurrency: options?.concurrency,
      workersPerOverlay: w,
    });
    if (!activeOverlayConcurrencyMeta) {
      activeOverlayConcurrencyMeta = { concurrency: k0, workers: w };
    }
    return { jobs: 0, concurrency: k0, workers: w, elapsed_ms: 0 };
  }

  const k = resolveOverlayConcurrency({
    overrideConcurrency: options?.concurrency,
    workersPerOverlay: w,
    coldOverlayCount: jobs.length,
  });
  activeOverlayConcurrencyMeta = { concurrency: k, workers: w };

  const t0 = Date.now();
  progressWatch({
    mode: "watch",
    paths: jobs.map((j) => j.watchTargetPath),
    expectedFrames: jobs.map((j) => j.expectedFrames ?? 0),
  });
  const parallelJobs: ParallelFfmpegJob[] = jobs.map((j, idx) => ({
    executable: process.execPath,
    args: j.args,
    cwd: process.cwd(),
    step: `hyperframes render (${j.compName}, ${idx + 1}/${jobs.length})`,
    watchedPaths: [j.watchTargetPath],
    cleanupPathsOnStall: [j.watchTargetPath],
  }));

  const results = runWatchedParallelFfmpegJobsSync(
    parallelJobs,
    jobs.map(() => 512 * 1024 * 1024),
    k
  );
  const wallElapsedMs = Date.now() - t0;
  activeOverlayPrepassWallMs += wallElapsedMs;

  let firstFailure: CutholError | null = null;
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const r = results[i];
    let status = r?.status ?? null;
    let stdoutStr = r?.stdout ? r.stdout.toString("utf8") : "";
    let stderrStr = r?.stderr ?? "";
    let errObj = r?.error;
    let stalled = Boolean(r?.stalled);
    let stalledMs = r?.stalledMs;
    let stallThresholdMs = r?.stallThresholdMs;
    let lastProgress = r?.lastProgress;
    let commandSummary = r?.commandSummary;
    let jobElapsedMs = r?.elapsedMs ?? wallElapsedMs;
    let usedGpu = j.wantGpu;
    let gpuFallbackReason: string | null = null;

    try {
      if (
        j.wantGpu &&
        j.fallbackNoGpuArgs &&
        (status !== 0 || !isValidVideoBlobOnDisk(j.tmpBlob, j.expectedFrames))
      ) {
        usedGpu = false;
        gpuFallbackReason = stalled
          ? "stalled"
          : "HyperFrames GPU encode failed; retried with libx264";
        if (fs.existsSync(j.tmpBlob)) {
          try {
            fs.rmSync(j.tmpBlob, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
        const retryProc = spawnWatchedSync(process.execPath, j.fallbackNoGpuArgs, {
          encoding: "utf8",
          maxBuffer: 512 * 1024 * 1024,
          env: hyperFramesProcessEnv(),
          step: `hyperframes render (${j.compName}, retry cpu)`,
          watchedPaths: [j.watchTargetPath],
          cleanupPathsOnStall: [j.watchTargetPath],
        });
        status = retryProc.status;
        stdoutStr = String(retryProc.stdout || "");
        stderrStr = String(retryProc.stderr || "");
        errObj = retryProc.error;
        stalled = Boolean(retryProc.stalled);
        stalledMs = retryProc.stalledMs;
        stallThresholdMs = retryProc.stallThresholdMs;
        lastProgress = retryProc.lastProgress;
        commandSummary = retryProc.commandSummary;
        jobElapsedMs += retryProc.elapsedMs ?? 0;
      }

      if (
        !stalled &&
        (status !== 0 || !isValidVideoBlobOnDisk(j.tmpBlob, j.expectedFrames)) &&
        /\bEPERM\b|\bEACCES\b|\bEBUSY\b/i.test(`${stderrStr}\n${stdoutStr}`)
      ) {
        if (fs.existsSync(j.tmpBlob)) {
          try {
            fs.rmSync(j.tmpBlob, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
        const epermRetry = spawnWatchedSync(process.execPath, j.args, {
          encoding: "utf8",
          maxBuffer: 512 * 1024 * 1024,
          env: hyperFramesProcessEnv(),
          step: `hyperframes render (${j.compName}, retry eperm)`,
          watchedPaths: [j.watchTargetPath],
          cleanupPathsOnStall: [j.watchTargetPath],
        });
        status = epermRetry.status;
        stdoutStr = String(epermRetry.stdout || "");
        stderrStr = String(epermRetry.stderr || "");
        errObj = epermRetry.error;
        stalled = Boolean(epermRetry.stalled);
        stalledMs = epermRetry.stalledMs;
        stallThresholdMs = epermRetry.stallThresholdMs;
        lastProgress = epermRetry.lastProgress;
        commandSummary = epermRetry.commandSummary;
        jobElapsedMs += epermRetry.elapsedMs ?? 0;
      }

      if (status === 0 && isValidVideoBlobOnDisk(j.tmpBlob, j.expectedFrames)) {
        j.finalizeSuccess({
          usedGpu,
          gpuFallbackReason,
          elapsedMs: jobElapsedMs,
          stdoutStr,
          stderrStr,
        });
      } else if (!firstFailure) {
        firstFailure = buildHyperFramesFailureError(j.compositionDir, j.args, {
          status,
          stdout: stdoutStr,
          stderr: stderrStr,
          error: errObj,
          stalled,
          stalledMs,
          stallThresholdMs,
          lastProgress,
          commandSummary,
        });
      }
    } finally {
      j.cleanupTemp();
    }
  }

  if (firstFailure) {
    throw firstFailure;
  }

  return {
    jobs: jobs.length,
    concurrency: k,
    workers: w,
    elapsed_ms: wallElapsedMs,
  };
}
