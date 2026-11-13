// Cuthol Live window opening behaviour: env > project > user > default.
// Project scope is journaled (undoable); user scope is one atomic file write.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { currentSettingsActor, storedSetting } from "../core/settings.js";
import { commitSequenceMutation, loadSequence } from "../core/workspace.js";
import type { LiveConfigResolved, LiveMode } from "./live_types.js";

/** New-format user record (`live.mode`); null when neither file sets it. */
function readStoredLiveMode(projectDir: string): LiveMode | null {
  try {
    const stored = storedSetting(projectDir, "live.mode");
    if (stored) return parseLiveMode(stored.value);
  } catch {
    // Unreadable settings: fall through to the legacy key.
  }
  return null;
}

const LIVE_MODES: readonly LiveMode[] = ["ask", "on", "off"];

export function isLiveMode(value: unknown): value is LiveMode {
  return typeof value === "string" && (LIVE_MODES as readonly string[]).includes(value.trim().toLowerCase());
}

/** Accepts `ask|on|off` (case-insensitive, trimmed); anything else is null (the source is skipped). */
export function parseLiveMode(value: unknown): LiveMode | null {
  if (!isLiveMode(value)) return null;
  return value.trim().toLowerCase() as LiveMode;
}

/**
 * User settings file, or null when tests disabled it (`CUTHOL_SETTINGS_FILE=0`
 * in test_setup.ts). `CUTHOL_SETTINGS_FILE` redirects it at a temp file.
 */
export function resolveUserSettingsFile(): string | null {
  const override = process.env.CUTHOL_SETTINGS_FILE;
  if (override === "0") return null;
  if (override) return override;
  return path.join(os.homedir(), ".cuthol", "settings.json");
}

/** Write JSON so a crash never leaves a half-written file (tmp + rename). */
export function writeJsonFileAtomically(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp_${process.pid}_${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

/** env CUTHOL_LIVE > project (sequence `review.live_mode`) > user (`live_mode`) > "ask". */
export function resolveLiveConfig(projectDir: string): LiveConfigResolved {
  const env = parseLiveMode(process.env.CUTHOL_LIVE);
  if (env) return { mode: env, source: "env" };
  try {
    const { sequence } = loadSequence(projectDir);
    const project = parseLiveMode(sequence.review?.live_mode);
    if (project) return { mode: project, source: "project" };
  } catch {
    // Missing or unreadable project: fall through to the user setting.
  }
  // New settings record first (`live.mode`), then the legacy `live_mode` string.
  const stored = readStoredLiveMode(projectDir);
  if (stored) return { mode: stored, source: "user" };
  const userFile = resolveUserSettingsFile();
  if (userFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(userFile, "utf8")) as { live_mode?: unknown };
      const user = parseLiveMode(raw?.live_mode);
      if (user) return { mode: user, source: "user" };
    } catch {
      // Missing, unreadable or corrupt user file: fall through to the default.
    }
  }
  return { mode: "ask", source: "default" };
}

export function setLiveConfig(
  projectDir: string,
  mode: LiveMode,
  scope: "project" | "user"
): LiveConfigResolved {
  if (!isLiveMode(mode)) {
    throw new CutholError(DIAGNOSTICS.LIVE_CONFIG_INVALID_MODE("the --mode flag", String(mode)));
  }
  const normalized = parseLiveMode(mode)!;
  if (scope === "project") {
    commitSequenceMutation(projectDir, "live.config", (seq) => {
      seq.review = { ...(seq.review ?? {}), live_mode: normalized };
    });
    return { mode: normalized, source: "project" };
  }
  // New format: a `live.mode` settings record, plus the legacy `live_mode`
  // string in the same file so older readers keep working. One atomic write.
  try {
    const file = resolveUserSettingsFile();
    if (!file) {
      throw new CutholError(
        DIAGNOSTICS.LIVE_CONFIG_WRITE_FAILED("(user settings disabled)", "CUTHOL_SETTINGS_FILE=0")
      );
    }
    let current: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) current = raw as Record<string, unknown>;
    } catch {
      // Missing or corrupt: start from an empty object.
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonFileAtomically(file, {
      ...current,
      "live.mode": { value: normalized, set_by: currentSettingsActor(), at: new Date().toISOString() },
      live_mode: normalized,
    });
    return { mode: normalized, source: "user" };
  } catch (e) {
    if (e instanceof CutholError) throw e;
    throw new CutholError(
      DIAGNOSTICS.LIVE_CONFIG_WRITE_FAILED("(user settings)", e instanceof Error ? e.message : String(e))
    );
  }
}
