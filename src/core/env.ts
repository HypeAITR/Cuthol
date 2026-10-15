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

const DISABLED_TOKENS = new Set(["0", "false", "off", "none", "no", "disable", "disabled"]);
const ENABLED_TOKENS = new Set(["1", "true", "on", "yes", "enable", "enabled"]);

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
