/**
 * Minimal `.env` Loader for Cuthol (`src/core/env.ts`).
 *
 * Reads key-value pairs from `.env` in the current working directory (or parent directories)
 * without logging or exposing secret values.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "./diagnostics.js";

let sqliteWarningFilterInstalled = false;

/**
 * Suppresses only Node.js's built-in `ExperimentalWarning: SQLite is an experimental feature...`
 * while preserving all other warnings (including other ExperimentalWarnings and DeprecationWarnings).
 */
export function suppressSqliteExperimentalWarning(): void {
  if (sqliteWarningFilterInstalled) return;
  sqliteWarningFilterInstalled = true;
  const origEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const msg = typeof warning === "string" ? warning : warning?.message ?? "";
    if (/SQLite is an experimental feature/i.test(msg)) {
      return;
    }
    return (origEmitWarning as (...a: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;
}

suppressSqliteExperimentalWarning();

export interface SharedCacheConfig {
  enabled: boolean;
  cacheDir: string | null;
  sqlitePath: string | null;
  blobsDir: string | null;
}

export interface SharedExtensionsConfig {
  enabled: boolean;
  extensionsDir: string | null;
}

export type VideoEncoderPreference =
  | "auto"
  | "nvenc"
  | "amf"
  | "qsv"
  | "vaapi"
  | "videotoolbox"
  | "libx264";

export type AlphaOverlayFormat = "pngseq" | "ffv1" | "mov";

export interface StallWatchdogConfig {
  enabled: boolean;
  stallTimeoutMs: number;
  startupTimeoutMs: number;
  pollIntervalMs: number;
}

const DISABLED_TOKENS = new Set(["0", "false", "off", "none", "no", "disable", "disabled"]);
const ENABLED_TOKENS = new Set(["1", "true", "on", "yes", "enable", "enabled"]);

/**
 * Resolves the progress watchdog configuration for long-running child processes.
 * - Controlled via `CUTHOL_STALL_TIMEOUT_SEC` (default: 300 seconds = 5 minutes; `0` disables the watchdog).
 * - Optional `CUTHOL_STALL_STARTUP_TIMEOUT_SEC` overrides the initial wait before first progress/output
 *   (defaults to `stallTimeoutMs`).
 * - Progress-based only: advancing processes are never interrupted regardless of total wall-clock duration.
 */
export function resolveStallWatchdogConfig(overrides?: {
  stallTimeoutMs?: number | null;
  startupTimeoutMs?: number | null;
}): StallWatchdogConfig {
  if (typeof overrides?.stallTimeoutMs === "number") {
    if (!Number.isFinite(overrides.stallTimeoutMs) || overrides.stallTimeoutMs <= 0) {
      return { enabled: false, stallTimeoutMs: 0, startupTimeoutMs: 0, pollIntervalMs: 250 };
    }
    const stallMs = Math.max(100, Math.round(overrides.stallTimeoutMs));
    const startupMs =
      typeof overrides.startupTimeoutMs === "number" &&
      Number.isFinite(overrides.startupTimeoutMs) &&
      overrides.startupTimeoutMs > 0
        ? Math.max(100, Math.round(overrides.startupTimeoutMs))
        : stallMs;
    const pollIntervalMs = Math.max(50, Math.min(1000, Math.floor(Math.min(stallMs, startupMs) / 8)));
    return {
      enabled: true,
      stallTimeoutMs: stallMs,
      startupTimeoutMs: startupMs,
      pollIntervalMs,
    };
  }

  const rawStall = process.env.CUTHOL_STALL_TIMEOUT_SEC;
  let stallTimeoutMs = 300_000;
  if (rawStall !== undefined && rawStall.trim() !== "") {
    const clean = rawStall.trim().toLowerCase();
    if (DISABLED_TOKENS.has(clean)) {
      return { enabled: false, stallTimeoutMs: 0, startupTimeoutMs: 0, pollIntervalMs: 250 };
    }
    const parsed = Number(clean);
    if (Number.isFinite(parsed)) {
      if (parsed <= 0) {
        return { enabled: false, stallTimeoutMs: 0, startupTimeoutMs: 0, pollIntervalMs: 250 };
      }
      stallTimeoutMs = Math.max(100, Math.round(parsed * 1000));
    }
  }

  let startupTimeoutMs = stallTimeoutMs;
  if (
    typeof overrides?.startupTimeoutMs === "number" &&
    Number.isFinite(overrides.startupTimeoutMs) &&
    overrides.startupTimeoutMs > 0
  ) {
    startupTimeoutMs = Math.max(100, Math.round(overrides.startupTimeoutMs));
  } else {
    const rawStartup = process.env.CUTHOL_STALL_STARTUP_TIMEOUT_SEC;
    if (rawStartup !== undefined && rawStartup.trim() !== "") {
      const parsedStartup = Number(rawStartup.trim());
      if (Number.isFinite(parsedStartup) && parsedStartup > 0) {
        startupTimeoutMs = Math.max(100, Math.round(parsedStartup * 1000));
      }
    }
  }

  const pollIntervalMs = Math.max(
    50,
    Math.min(1000, Math.floor(Math.min(stallTimeoutMs, startupTimeoutMs) / 8))
  );
  return {
    enabled: true,
    stallTimeoutMs,
    startupTimeoutMs,
    pollIntervalMs,
  };
}

/**
 * Resolves the explicit worker count (`W`) passed to each `hyperframes render --workers <W>` invocation.
 * Never relies on HyperFrames `auto`.
 * - Can be overridden via `overrideWorkers` (`render --workers <W>`) or `CUTHOL_WORKERS` / `CUTHOL_RENDER_WORKERS` / `CUTHOL_HYPERFRAMES_WORKERS`.
 * - Hardware defaults:
 *   - Windows & macOS: `W = 1` (keeps single-worker streaming encode / `drawElement` path active and avoids
 *     multi-worker separate chunk encode overhead; multi-core parallelism comes from concurrent overlays `K`).
 *   - Linux: `W = 2` on >2 logical cores (`1` on <=2 cores), since Linux BeginFrame scales to 1-2 workers per composition
 *     while leaving remaining cores for concurrent overlays `K`.
 */
export function resolveHyperFramesWorkers(overrideWorkers?: number | null): number {
  if (typeof overrideWorkers === "number" && Number.isFinite(overrideWorkers) && overrideWorkers >= 1) {
    return Math.max(1, Math.min(32, Math.floor(overrideWorkers)));
  }

  const rawCandidates = [
    process.env.CUTHOL_WORKERS,
    process.env.CUTHOL_RENDER_WORKERS,
    process.env.CUTHOL_HYPERFRAMES_WORKERS,
  ];
  for (const raw of rawCandidates) {
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.max(1, Math.min(32, Math.floor(parsed)));
    }
  }

  if (process.platform === "win32" || process.platform === "darwin") {
    return 1;
  }

  const cpuCount = Math.max(1, os.cpus().length);
  return cpuCount <= 2 ? 1 : 2;
}

/**
 * Resolves the number of cold HyperFrames composition overlays (`K`) rendered concurrently
 * during the render pre-pass.
 * - Can be overridden via `options.overrideConcurrency` or `CUTHOL_OVERLAY_CONCURRENCY` (`1` forces sequential rendering).
 * - Hardware default: `K = floor(logical_cores / W)`, bounded by total RAM (~40% budget at ~1.0 GB per `W` worker tree),
 *   current free RAM (preserving >=1.0 GB free headroom at ~450 MB per headless Chrome worker), and `coldOverlayCount`.
 */
export function resolveOverlayConcurrency(options?: {
  overrideConcurrency?: number | null;
  workersPerOverlay?: number | null;
  coldOverlayCount?: number | null;
}): number {
  const coldCap =
    typeof options?.coldOverlayCount === "number" &&
    Number.isFinite(options.coldOverlayCount) &&
    options.coldOverlayCount >= 1
      ? Math.max(1, Math.floor(options.coldOverlayCount))
      : null;

  if (
    typeof options?.overrideConcurrency === "number" &&
    Number.isFinite(options.overrideConcurrency) &&
    options.overrideConcurrency >= 1
  ) {
    const explicit = Math.max(1, Math.min(32, Math.floor(options.overrideConcurrency)));
    return coldCap !== null ? Math.min(explicit, coldCap) : explicit;
  }

  const rawEnv = process.env.CUTHOL_OVERLAY_CONCURRENCY;
  if (rawEnv !== undefined && rawEnv.trim() !== "") {
    const parsed = Number(rawEnv.trim());
    if (Number.isFinite(parsed) && parsed >= 1) {
      const explicit = Math.max(1, Math.min(32, Math.floor(parsed)));
      return coldCap !== null ? Math.min(explicit, coldCap) : explicit;
    }
  }

  const w = Math.max(1, resolveHyperFramesWorkers(options?.workersPerOverlay));
  const cpuCount = Math.max(1, os.cpus().length);
  const byCpu = Math.max(1, Math.floor(cpuCount / w));

  const totalMemGb = os.totalmem() / 1024 ** 3;
  const freeMemGb = os.freemem() / 1024 ** 3;
  // Total RAM cap: allocate at most ~40% of total system RAM (~1.0 GB per worker process tree -> 6 on 16 GB with W=1)
  const byTotalMem = Math.max(1, Math.floor((totalMemGb * 0.4) / Math.max(0.5, 1.0 * w)));
  // Free RAM cap: keep at least 0.8 GB of currently free RAM untouched (~0.35 GB per headless Chrome worker)
  const availFreeGb = Math.max(0.35 * w, freeMemGb - 0.8);
  const byFreeMem = Math.max(1, Math.floor(availFreeGb / (0.35 * w)));

  const resolved = Math.max(1, Math.min(byCpu, byTotalMem, byFreeMem, 12));
  return coldCap !== null ? Math.min(resolved, coldCap) : resolved;
}

/**
 * Resolves the maximum number of active spine clips / media inputs per render segment
 * before switching to time-segmented compilation and concatenation.
 * - Defaults to 24 clips per segment so simultaneous demuxer/decoder instances and command length stay bounded.
 * - Can be overridden via `CUTHOL_RENDER_SEGMENT_MAX_CLIPS`.
 */
export function resolveMaxClipsPerRenderSegment(overrideMax?: number | null): number {
  if (typeof overrideMax === "number" && Number.isFinite(overrideMax) && overrideMax >= 1) {
    return Math.max(1, Math.min(128, Math.floor(overrideMax)));
  }
  const raw = process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS;
  if (raw !== undefined && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.max(1, Math.min(128, Math.floor(parsed)));
    }
  }
  return 24;
}

/**
 * Resolves the intermediate storage format for transparent (`overlay_alpha`) HyperFrames overlays.
 * - Default is `"pngseq"` (`hyperframes render --format png-sequence` directory with `frame_%06d.png`),
 *   which skips intermediate video encoding (`prores_ks`) and keeps lossless 8-bit straight RGBA.
 * - When `CUTHOL_ALPHA_FORMAT=ffv1` is set, or when `expectedFrames >= CUTHOL_ALPHA_FFV1_MIN_FRAMES`
 *   (default: 3600 frames = 2 min at 30 fps; `0` disables threshold packing), packs the captured PNG
 *   frames into a single lossless RGBA FFV1 `.ffv1.mov` container with exact `1/fps` frame timing.
 * - `CUTHOL_ALPHA_FORMAT=mov` selects legacy ProRes 4444 `.mov`.
 */
export function resolveAlphaOverlayFormat(expectedFrames?: number): AlphaOverlayFormat {
  const raw = process.env.CUTHOL_ALPHA_FORMAT?.trim().toLowerCase();
  if (raw === "mov" || raw === "prores") {
    return "mov";
  }
  if (raw === "ffv1") {
    return "ffv1";
  }
  if (raw === "png" || raw === "png-sequence" || raw === "pngseq") {
    const rawMin = process.env.CUTHOL_ALPHA_FFV1_MIN_FRAMES?.trim();
    if (!rawMin) return "pngseq";
  }

  let ffv1MinFrames = 3600;
  const rawMin = process.env.CUTHOL_ALPHA_FFV1_MIN_FRAMES?.trim();
  if (rawMin !== undefined && rawMin !== "") {
    if (DISABLED_TOKENS.has(rawMin.toLowerCase())) {
      ffv1MinFrames = 0;
    } else {
      const parsed = Number(rawMin);
      if (Number.isFinite(parsed)) {
        ffv1MinFrames = parsed <= 0 ? 0 : Math.max(10, Math.floor(parsed));
      }
    }
  }

  if (
    ffv1MinFrames > 0 &&
    typeof expectedFrames === "number" &&
    Number.isFinite(expectedFrames) &&
    expectedFrames >= ffv1MinFrames
  ) {
    return "ffv1";
  }

  return "pngseq";
}

/**
 * Resolves the video encoder preference for final and intermediate MP4 encoding.
 * - Controlled via `CUTHOL_ENCODER=auto|nvenc|amf|qsv|vaapi|videotoolbox|x264`
 *   (or legacy `CUTHOL_VIDEO_ENCODER`).
 * - Set `CUTHOL_DISABLE_NVENC=1` or `CUTHOL_DISABLE_GPU=1` to force `libx264` when no explicit hardware
 *   vendor is requested (or to disable NVENC specifically).
 */
export function resolveVideoEncoderPreference(
  overrideEncoder?: string | null
): VideoEncoderPreference {
  const candidates = [
    overrideEncoder ?? undefined,
    process.env.CUTHOL_ENCODER,
    process.env.CUTHOL_VIDEO_ENCODER,
  ];

  const disableGpu =
    Boolean(process.env.CUTHOL_DISABLE_GPU) &&
    ENABLED_TOKENS.has(process.env.CUTHOL_DISABLE_GPU!.trim().toLowerCase());
  const disableNvenc =
    Boolean(process.env.CUTHOL_DISABLE_NVENC) &&
    ENABLED_TOKENS.has(process.env.CUTHOL_DISABLE_NVENC!.trim().toLowerCase());

  for (const raw of candidates) {
    if (raw === undefined) continue;
    const lower = raw.trim().toLowerCase();
    if (!lower) continue;
    if (
      DISABLED_TOKENS.has(lower) ||
      lower === "libx264" ||
      lower === "x264" ||
      lower === "cpu" ||
      lower === "software" ||
      lower === "sw"
    ) {
      return "libx264";
    }
    if (lower === "nvenc" || lower === "h264_nvenc" || lower === "nvidia") {
      return disableNvenc || disableGpu ? "libx264" : "nvenc";
    }
    if (lower === "amf" || lower === "h264_amf" || lower === "amd") {
      return disableGpu ? "libx264" : "amf";
    }
    if (lower === "qsv" || lower === "h264_qsv" || lower === "intel") {
      return disableGpu ? "libx264" : "qsv";
    }
    if (lower === "vaapi" || lower === "h264_vaapi") {
      return disableGpu ? "libx264" : "vaapi";
    }
    if (lower === "videotoolbox" || lower === "h264_videotoolbox" || lower === "vt") {
      return disableGpu ? "libx264" : "videotoolbox";
    }
    if (lower === "auto" || lower === "gpu" || lower === "hw") {
      if (disableGpu || disableNvenc) {
        return "libx264";
      }
      return "auto";
    }
  }

  if (disableGpu || disableNvenc) {
    return "libx264";
  }

  return "auto";
}

/**
 * Resolves the user-level content-addressed shared cache location.
 * - Can be redirected via `CUTHOL_CACHE_DIR` (or `CUTHOL_SHARED_CACHE_DIR` / `CUTHOL_USER_CACHE_DIR`).
 * - Can be disabled via `CUTHOL_CACHE_DIR=0|false|off|none` or `CUTHOL_DISABLE_SHARED_CACHE=1`.
 */
export function resolveSharedCacheConfig(overrideDir?: string | false | null): SharedCacheConfig {
  if (overrideDir === false) {
    return { enabled: false, cacheDir: null, sqlitePath: null, blobsDir: null };
  }

  if (typeof overrideDir === "string" && overrideDir.trim()) {
    const cleanOverride = overrideDir.trim();
    if (DISABLED_TOKENS.has(cleanOverride.toLowerCase())) {
      return { enabled: false, cacheDir: null, sqlitePath: null, blobsDir: null };
    }
    const resolved = path.resolve(cleanOverride);
    if (/\.(sqlite|sqlite3|db)$/i.test(resolved)) {
      const dir = path.dirname(resolved);
      return {
        enabled: true,
        cacheDir: dir,
        sqlitePath: resolved,
        blobsDir: path.join(dir, "blobs"),
      };
    }
    return {
      enabled: true,
      cacheDir: resolved,
      sqlitePath: path.join(resolved, "ledger.sqlite"),
      blobsDir: path.join(resolved, "blobs"),
    };
  }

  const disableFlags = [
    process.env.CUTHOL_DISABLE_SHARED_CACHE,
    process.env.CUTHOL_NO_SHARED_CACHE,
    process.env.CUTHOL_DISABLE_CACHE,
    process.env.CUTHOL_NO_CACHE,
  ];
  for (const flag of disableFlags) {
    if (flag && ENABLED_TOKENS.has(flag.trim().toLowerCase())) {
      return { enabled: false, cacheDir: null, sqlitePath: null, blobsDir: null };
    }
  }

  const rawLocationCandidates = [
    process.env.CUTHOL_CACHE_DIR,
    process.env.CUTHOL_SHARED_CACHE_DIR,
    process.env.CUTHOL_USER_CACHE_DIR,
    process.env.CUTHOL_CACHE,
    process.env.CUTHOL_SHARED_CACHE,
  ];

  for (const raw of rawLocationCandidates) {
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (DISABLED_TOKENS.has(lower)) {
      return { enabled: false, cacheDir: null, sqlitePath: null, blobsDir: null };
    }
    if (ENABLED_TOKENS.has(lower)) {
      continue;
    }
    const resolved = path.resolve(trimmed);
    if (/\.(sqlite|sqlite3|db)$/i.test(resolved)) {
      const dir = path.dirname(resolved);
      return {
        enabled: true,
        cacheDir: dir,
        sqlitePath: resolved,
        blobsDir: path.join(dir, "blobs"),
      };
    }
    return {
      enabled: true,
      cacheDir: resolved,
      sqlitePath: path.join(resolved, "ledger.sqlite"),
      blobsDir: path.join(resolved, "blobs"),
    };
  }

  const isNodeTestRunner =
    Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes("--test");
  const defaultDir = isNodeTestRunner
    ? path.join(os.tmpdir(), `cuthol-shared-cache-${process.pid}`)
    : path.join(os.homedir(), ".cuthol", "cache");
  return {
    enabled: true,
    cacheDir: defaultDir,
    sqlitePath: path.join(defaultDir, "ledger.sqlite"),
    blobsDir: path.join(defaultDir, "blobs"),
  };
}

/**
 * Resolves the user-level persistent extensions root (`~/.cuthol/extensions`).
 * - Can be redirected via `CUTHOL_EXTENSIONS_DIR` (or `CUTHOL_USER_EXTENSIONS_DIR` / `CUTHOL_SHARED_EXTENSIONS_DIR`).
 * - Can be disabled via `CUTHOL_EXTENSIONS_DIR=0|false|off|none` or `CUTHOL_DISABLE_EXTENSIONS=1`.
 * - If `CUTHOL_EXTENSIONS_DIR` is not set and `CUTHOL_CACHE_DIR` is redirected to a directory,
 *   defaults to the sibling `extensions/` directory under the same root; if `CUTHOL_CACHE_DIR=0`,
 *   persistent extensions are disabled so tests never touch `~/.cuthol/extensions`.
 */
export function resolveSharedExtensionsConfig(
  overrideDir?: string | false | null
): SharedExtensionsConfig {
  if (overrideDir === false) {
    return { enabled: false, extensionsDir: null };
  }
  if (typeof overrideDir === "string" && overrideDir.trim()) {
    const cleanOverride = overrideDir.trim();
    if (DISABLED_TOKENS.has(cleanOverride.toLowerCase())) {
      return { enabled: false, extensionsDir: null };
    }
    return { enabled: true, extensionsDir: path.resolve(cleanOverride) };
  }

  const disableFlags = [
    process.env.CUTHOL_DISABLE_EXTENSIONS,
    process.env.CUTHOL_NO_EXTENSIONS,
    process.env.CUTHOL_DISABLE_SHARED_EXTENSIONS,
  ];
  for (const flag of disableFlags) {
    if (flag && ENABLED_TOKENS.has(flag.trim().toLowerCase())) {
      return { enabled: false, extensionsDir: null };
    }
  }

  const rawExtCandidates = [
    process.env.CUTHOL_EXTENSIONS_DIR,
    process.env.CUTHOL_SHARED_EXTENSIONS_DIR,
    process.env.CUTHOL_USER_EXTENSIONS_DIR,
  ];
  for (const raw of rawExtCandidates) {
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (DISABLED_TOKENS.has(lower)) {
      return { enabled: false, extensionsDir: null };
    }
    if (ENABLED_TOKENS.has(lower)) {
      continue;
    }
    return { enabled: true, extensionsDir: path.resolve(trimmed) };
  }

  const cacheCfg = resolveSharedCacheConfig();
  if (!cacheCfg.enabled || !cacheCfg.cacheDir) {
    return { enabled: false, extensionsDir: null };
  }

  const cacheBase = path.basename(cacheCfg.cacheDir).toLowerCase();
  const rootCutholDir =
    cacheBase === "cache" ? path.dirname(cacheCfg.cacheDir) : cacheCfg.cacheDir;
  return {
    enabled: true,
    extensionsDir: path.join(rootCutholDir, "extensions"),
  };
}

const loadedDirs = new Set<string>();

export function loadDotEnvIfNeeded(startDir = process.cwd()): void {
  const resolvedStart = path.resolve(startDir);
  if (loadedDirs.has(resolvedStart)) return;

  let dir = resolvedStart;
  for (let depth = 0; depth < 4; depth++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) {
      loadedDirs.add(resolvedStart);
      const content = fs.readFileSync(candidate, "utf8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eqIdx = line.indexOf("=");
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx).trim().replace(/^export\s+/, "").trim();
        if (!key) continue;
        let val = line.slice(eqIdx + 1).trim();
        if (val.startsWith('"') || val.startsWith("'")) {
          const quoteChar = val[0];
          let closeIdx = -1;
          for (let i = 1; i < val.length; i++) {
            if (val[i] === quoteChar && val[i - 1] !== "\\") {
              closeIdx = i;
              break;
            }
          }
          if (closeIdx > 0) {
            val = val.slice(1, closeIdx);
          } else {
            val = val.slice(1);
          }
        } else {
          val = val.replace(/\s+#.*$/, "").trim();
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

export function requireApiKey(envVarName: string, serviceName: string, startDir?: string): string {
  if (startDir) {
    loadDotEnvIfNeeded(startDir);
  }
  loadDotEnvIfNeeded(process.cwd());
  const key = process.env[envVarName]?.trim();
  if (!key) {
    throw new CutholError(DIAGNOSTICS.MISSING_API_KEY(envVarName, serviceName));
  }
  return key;
}
