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

export type VideoEncoderPreference = "auto" | "nvenc" | "libx264";

const DISABLED_TOKENS = new Set(["0", "false", "off", "none", "no", "disable", "disabled"]);
const ENABLED_TOKENS = new Set(["1", "true", "on", "yes", "enable", "enabled"]);

/**
 * Resolves the explicit worker count passed to `hyperframes render --workers <N>`.
 * Never relies on HyperFrames `auto` (which can fall back to 1 worker).
 * - Can be overridden via `overrideWorkers` option or `CUTHOL_WORKERS` / `CUTHOL_RENDER_WORKERS` / `CUTHOL_HYPERFRAMES_WORKERS`.
 * - Defaults to a balanced hardware worker count based on logical CPU cores and total RAM (e.g. 6 on a 12-core machine).
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

  const cpuCount = Math.max(1, os.cpus().length);
  const totalMemGb = os.totalmem() / 1024 ** 3;
  const byCpu = cpuCount <= 2 ? 1 : Math.min(8, Math.floor(cpuCount / 2));
  const byMem = Math.max(1, Math.floor(totalMemGb / 2));
  return Math.max(1, Math.min(byCpu, byMem));
}

/**
 * Resolves the video encoder preference for final and intermediate MP4 encoding.
 * - Set `CUTHOL_DISABLE_NVENC=1` (or `CUTHOL_DISABLE_GPU=1` or `CUTHOL_VIDEO_ENCODER=libx264`) to force `libx264`.
 * - Set `CUTHOL_VIDEO_ENCODER=nvenc` to explicitly prefer `h264_nvenc`.
 */
export function resolveVideoEncoderPreference(
  overrideEncoder?: string | null
): VideoEncoderPreference {
  const candidates = [
    overrideEncoder ?? undefined,
    process.env.CUTHOL_VIDEO_ENCODER,
    process.env.CUTHOL_ENCODER,
  ];

  const disableFlags = [process.env.CUTHOL_DISABLE_NVENC, process.env.CUTHOL_DISABLE_GPU];
  for (const flag of disableFlags) {
    if (flag && ENABLED_TOKENS.has(flag.trim().toLowerCase())) {
      return "libx264";
    }
  }

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
    if (lower === "nvenc" || lower === "h264_nvenc" || lower === "gpu" || lower === "hw") {
      return "nvenc";
    }
    if (lower === "auto") {
      return "auto";
    }
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
