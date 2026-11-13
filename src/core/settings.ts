// Cuthol settings layer (v1): user + project JSON files with per-key
// { value, set_by, at } records. Environment variables always win and are
// resolved by the existing env.ts resolvers, never stored here.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "./diagnostics.js";

/** Write JSON so a crash never leaves a half-written file (tmp + rename). */
export function writeSettingsFileAtomically(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp_${process.pid}_${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

export type SettingSetBy = "agent" | "human";
export type SettingSource = "env" | "project" | "user" | "default";

export const SETTING_KEYS = [
  "render.encoder",
  "render.gpu",
  "render.workers",
  "render.overlay_concurrency",
  "render.output_dir",
  "render.stall_timeout_sec",
  "cache.dir",
  "live.mode",
  "live.browser",
  "live.shortcuts",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const AGENT_SETTABLE: ReadonlySet<string> = new Set([
  "render.encoder",
  "render.gpu",
  "render.workers",
  "render.overlay_concurrency",
  "render.output_dir",
  "render.stall_timeout_sec",
  "cache.dir",
  "live.mode",
]);

const ENCODERS = ["auto", "nvenc", "amf", "qsv", "vaapi", "videotoolbox", "x264"];

export interface SettingRecord {
  value: unknown;
  set_by: SettingSetBy;
  at: string;
}

export interface SettingView {
  key: SettingKey;
  value: unknown;
  source: SettingSource;
  set_by: SettingSetBy | null;
  readonly: boolean;
  readonly_reason: string | null;
}

/** Actor for a write: explicit human calls (window server, CUTHOL_LIVE_ACTOR=human) or agent. */
export function currentSettingsActor(): SettingSetBy {
  return process.env.CUTHOL_LIVE_ACTOR === "human" ? "human" : "agent";
}

export function resolveUserSettingsFile(): string | null {
  const override = process.env.CUTHOL_SETTINGS_FILE;
  if (override === "0") return null;
  if (override) return override;
  return path.join(os.homedir(), ".cuthol", "settings.json");
}

export function resolveProjectSettingsFile(projectDir: string): string {
  return path.join(path.resolve(projectDir), ".cuthol", "settings.json");
}

type SettingsDoc = Record<string, SettingRecord | unknown>;

function readDoc(file: string | null): SettingsDoc {
  if (!file) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as SettingsDoc;
  } catch {
    // Missing, unreadable or corrupt: treated as empty.
  }
  return {};
}

function asRecord(raw: unknown): SettingRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!("value" in r)) return null;
  const setBy = r.set_by === "human" ? "human" : "agent";
  const at = typeof r.at === "string" ? r.at : new Date(0).toISOString();
  return { value: r.value, set_by: setBy, at };
}

/** Legacy `live_mode` string (older user file) mapped to the new record shape. */
function legacyLiveMode(doc: SettingsDoc): SettingRecord | null {
  const raw = doc.live_mode;
  if (typeof raw !== "string") return null;
  const mode = raw.trim().toLowerCase();
  if (mode !== "ask" && mode !== "on" && mode !== "off") return null;
  return { value: mode, set_by: "human", at: new Date(0).toISOString() };
}

/** Default value for every key. */
export function defaultSettingValue(key: SettingKey): unknown {
  switch (key) {
    case "render.encoder":
      return "auto";
    case "render.gpu":
      return true;
    case "render.workers":
      return "auto";
    case "render.overlay_concurrency":
      return "auto";
    case "render.output_dir":
      return "output";
    case "render.stall_timeout_sec":
      return 300;
    case "cache.dir":
      return path.join(os.homedir(), ".cuthol", "cache");
    case "live.mode":
      return "ask";
    case "live.browser":
      return "auto";
    case "live.shortcuts":
      return { ...DEFAULT_SHORTCUTS };
    default:
      return null;
  }
}

/** Environment variable bound to a key (null when the key has none). */
export function settingEnvVar(key: SettingKey): string | null {
  switch (key) {
    case "render.encoder":
      return "CUTHOL_ENCODER";
    case "render.gpu":
      return "CUTHOL_DISABLE_GPU";
    case "render.workers":
      return "CUTHOL_WORKERS";
    case "render.overlay_concurrency":
      return "CUTHOL_OVERLAY_CONCURRENCY";
    case "render.output_dir":
      return null;
    case "render.stall_timeout_sec":
      return "CUTHOL_STALL_TIMEOUT_SEC";
    case "cache.dir":
      return "CUTHOL_CACHE_DIR";
    case "live.mode":
      return "CUTHOL_LIVE";
    case "live.browser":
    case "live.shortcuts":
      return null;
    default:
      return null;
  }
}

/** Raw environment value for a key (undefined when the variable is unset or blank). */
export function envSettingValue(key: SettingKey): string | undefined {
  const name = settingEnvVar(key);
  if (!name) return undefined;
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.trim();
}

/** Validate and normalize a user-supplied value; throws a G-coded diagnostic on failure. */
export function validateSettingValue(key: SettingKey, value: unknown): unknown {
  const invalid = (expected: string): CutholError =>
    new CutholError(DIAGNOSTICS.SETTINGS_INVALID_VALUE(key, JSON.stringify(value) ?? "?", expected));
  switch (key) {
    case "render.encoder": {
      if (typeof value !== "string") throw invalid("one of " + ENCODERS.join("|"));
      const v: string = value.trim().toLowerCase();
      if (v === "libx264") return "x264";
      if (!ENCODERS.includes(v)) throw invalid("one of " + ENCODERS.join("|"));
      return v;
    }
    case "render.gpu": {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        if (["1", "true", "on", "yes", "enable", "enabled"].includes(v)) return true;
        if (["0", "false", "off", "no", "disable", "disabled"].includes(v)) return false;
      }
      throw invalid("true|false");
    }
    case "render.workers":
    case "render.overlay_concurrency": {
      if (typeof value === "string" && value.trim().toLowerCase() === "auto") return "auto";
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
      const max = key === "render.workers" ? 32 : 16;
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > max) {
        throw invalid(`1-${max} or "auto"`);
      }
      return n;
    }
    case "render.output_dir":
    case "cache.dir": {
      if (typeof value !== "string" || !value.trim()) throw invalid("a non-empty path");
      return (value as string).trim();
    }
    case "render.stall_timeout_sec": {
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
      if (!Number.isFinite(n) || n < 0) throw invalid("a non-negative number of seconds");
      return n;
    }
    case "live.mode": {
      if (typeof value !== "string") throw invalid("ask|on|off");
      const v: string = (value as string).trim().toLowerCase();
      if (v !== "ask" && v !== "on" && v !== "off") throw invalid("ask|on|off");
      return v;
    }
    case "live.browser": {
      const v = typeof value === "string" ? value.trim().toLowerCase() : "";
      // "auto" = the user's default browser; otherwise an installed browser id
      // (chrome, edge, firefox, brave, ...). An id no longer installed falls back to auto.
      if (v !== "auto" && !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(v)) throw invalid('"auto" or a browser id such as chrome, edge, firefox');
      return v;
    }
    case "live.shortcuts": {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("an action-to-key map");
      const out: Record<string, string> = {};
      for (const [action, binding] of Object.entries(value as Record<string, unknown>)) {
        if (!DEFAULT_SHORTCUTS[action] && typeof binding !== "string") throw invalid("an action-to-key map");
        if (typeof binding !== "string" || !binding.trim()) throw invalid("an action-to-key map");
        out[action] = binding.trim();
      }
      return { ...DEFAULT_SHORTCUTS, ...out };
    }
    default:
      throw invalid("a known settings key");
  }
}

export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

export function isAgentSettable(key: SettingKey): boolean {
  return AGENT_SETTABLE.has(key);
}

/** Display a value the way the window and the inbox line show it. */
export function displaySettingValue(key: SettingKey, value: unknown): string {
  if (key === "render.gpu") return value ? "on" : "off";
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function projectRecord(projectDir: string, key: SettingKey): SettingRecord | null {
  const doc = readDoc(resolveProjectSettingsFile(projectDir));
  return asRecord(doc[key]);
}

function userRecord(key: SettingKey): SettingRecord | null {
  const doc = readDoc(resolveUserSettingsFile());
  const direct = asRecord(doc[key]);
  if (direct) return direct;
  if (key === "live.mode") return legacyLiveMode(doc);
  return null;
}

/** Parse an env string through the same validation (null when the env value is invalid). */
function envRecord(key: SettingKey): unknown | undefined {
  const raw = envSettingValue(key);
  if (raw === undefined) return undefined;
  if (key === "render.gpu") {
    const v = raw.toLowerCase();
    if (["1", "true", "on", "yes", "enable", "enabled"].includes(v)) return false;
    if (["0", "false", "off", "no", "disable", "disabled", "none"].includes(v)) return true;
    return true;
  }
  try {
    return validateSettingValue(key, raw);
  } catch {
    return undefined;
  }
}

export interface ResolvedSetting {
  value: unknown;
  source: SettingSource;
  set_by: SettingSetBy | null;
}

export interface StoredSetting {
  value: unknown;
  scope: "project" | "user";
  set_by: SettingSetBy;
}

/** Stored record only (project first, then user); null when neither file sets the key. */
export function storedSetting(projectDir: string, key: SettingKey): StoredSetting | null {
  try {
    const p = projectRecord(projectDir, key);
    if (p) return { value: p.value, scope: "project", set_by: p.set_by };
  } catch {
    // fall through
  }
  try {
    const u = userRecord(key);
    if (u) return { value: u.value, scope: "user", set_by: u.set_by };
  } catch {
    // fall through
  }
  return null;
}

/** Project root for settings lookup: explicit override, else the current workspace. */
export function settingsProjectDir(): string {
  const override = process.env.CUTHOL_PROJECT_DIR;
  if (override && override.trim()) return override;
  return process.cwd();
}

/** Precedence: env > project > user > default. Never throws. */
export function resolveSetting(projectDir: string, key: SettingKey): ResolvedSetting {
  const env = envRecord(key);
  if (env !== undefined) return { value: env, source: "env", set_by: null };
  try {
    const p = projectRecord(projectDir, key);
    if (p) return { value: p.value, source: "project", set_by: p.set_by };
  } catch {
    // fall through
  }
  try {
    const u = userRecord(key);
    if (u) return { value: u.value, source: "user", set_by: u.set_by };
  } catch {
    // fall through
  }
  return { value: defaultSettingValue(key), source: "default", set_by: null };
}

/** Full view of every key for `list` and the window. */
export function listSettings(projectDir: string): SettingView[] {
  return SETTING_KEYS.map((key) => {
    const r = resolveSetting(projectDir, key);
    const envName = settingEnvVar(key);
    const readonly = r.source === "env" && envName !== null;
    return {
      key,
      value: r.value,
      source: r.source,
      set_by: r.set_by,
      readonly,
      readonly_reason: readonly ? `Set by environment variable ${envName}` : null,
    };
  });
}

function settingsScope(key: SettingKey): "project" | "user" {
  return key === "render.output_dir" ? "project" : "user";
}

function writeRecord(file: string, key: SettingKey, record: SettingRecord): void {
  let doc: SettingsDoc = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) doc = raw as SettingsDoc;
  } catch {
    // Missing or corrupt: start fresh but keep the unknown keys we can.
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeSettingsFileAtomically(file, { ...doc, [key]: record });
  } catch (e) {
    throw new CutholError(
      DIAGNOSTICS.SETTINGS_WRITE_FAILED(file, e instanceof Error ? e.message : String(e))
    );
  }
}

/** Store a validated value; project-scoped keys go to the project file, the rest user-wide. */
export function setSetting(
  projectDir: string,
  key: string,
  value: unknown,
  actor?: SettingSetBy
): ResolvedSetting {
  if (!isSettingKey(key)) {
    throw new CutholError(DIAGNOSTICS.SETTINGS_UNKNOWN_KEY(key));
  }
  if (!isAgentSettable(key) && (actor ?? currentSettingsActor()) === "agent") {
    throw new CutholError(DIAGNOSTICS.SETTINGS_AGENT_READONLY(key));
  }
  const normalized = validateSettingValue(key, value);
  const who = actor ?? currentSettingsActor();
  const record: SettingRecord = { value: normalized, set_by: who, at: new Date().toISOString() };
  if (settingsScope(key) === "project") {
    writeRecord(resolveProjectSettingsFile(projectDir), key, record);
    return { value: normalized, source: "project", set_by: who };
  }
  const file = resolveUserSettingsFile();
  if (!file) {
    throw new CutholError(DIAGNOSTICS.SETTINGS_WRITE_FAILED("(user settings disabled)", "CUTHOL_SETTINGS_FILE=0"));
  }
  writeRecord(file, key, record);
  return { value: normalized, source: "user", set_by: who };
}

/** Remove a stored value from both files; env and defaults still apply. Returns true when something was removed. */
export function resetSetting(projectDir: string, key: string): boolean {
  if (!isSettingKey(key)) {
    throw new CutholError(DIAGNOSTICS.SETTINGS_UNKNOWN_KEY(key));
  }
  let removed = false;
  for (const file of [resolveProjectSettingsFile(projectDir), resolveUserSettingsFile()]) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      if (raw && typeof raw === "object" && key in raw) {
        delete raw[key];
        writeSettingsFileAtomically(file, raw);
        removed = true;
      }
    } catch {
      // Unreadable file: nothing to remove.
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Shortcuts: the single table every window keydown handler binds through.
// ---------------------------------------------------------------------------

export interface ShortcutDef {
  action: string;
  label: string;
  defaultKey: string;
}

/** Canonical window shortcuts; `code` is a KeyboardEvent.code, `+`-joined for chords. */
export const DEFAULT_SHORTCUTS: Record<string, string> = {
  "play-pause": "Space",
  "step-forward": "ArrowRight",
  "step-back": "ArrowLeft",
  "step-forward-10": "Shift+ArrowRight",
  "step-back-10": "Shift+ArrowLeft",
  "go-start": "Home",
  "go-end": "End",
  "new-note": "KeyN",
  "send-notes": "Ctrl+Enter",
  "close-panel": "Escape",
};

export const SHORTCUT_LABELS: Record<string, string> = {
  "play-pause": "Play / pause",
  "step-forward": "Step one frame forward",
  "step-back": "Step one frame back",
  "step-forward-10": "Step 10 frames forward",
  "step-back-10": "Step 10 frames back",
  "go-start": "Go to start",
  "go-end": "Go to end",
  "new-note": "New note at playhead",
  "send-notes": "Send notes to the agent",
  "close-panel": "Close panel",
};

/** Effective shortcut map: stored overrides merged over the defaults. Never throws. */
export function resolveShortcuts(projectDir: string): Record<string, string> {
  try {
    const r = resolveSetting(projectDir, "live.shortcuts");
    if (r.value && typeof r.value === "object" && !Array.isArray(r.value)) {
      return { ...DEFAULT_SHORTCUTS, ...(r.value as Record<string, string>) };
    }
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_SHORTCUTS };
}
