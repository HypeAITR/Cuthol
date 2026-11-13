// Cuthol Live settings API: read-only-safe GET view and human POST writes.
// Window writes are stamped `set_by: "human"` and queued for the agent as an
// inbox packet, so they arrive with the agent's next CLI/MCP response.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { resolveSharedCacheConfig } from "../core/env.js";
import {
  DEFAULT_SHORTCUTS,
  displaySettingValue,
  envSettingValue,
  isSettingKey,
  listSettings,
  resetSetting,
  resolveSetting,
  resolveShortcuts,
  setSetting,
  settingEnvVar,
  SHORTCUT_LABELS,
  storedSetting,
  type SettingKey,
} from "../core/settings.js";
import { loadJournalManifest, loadSequence } from "../core/workspace.js";
import { listInstalledBrowsers, type BrowserInventory } from "./live_browsers.js";
import { writeLiveNotePacket } from "./live_inbox.js";

export interface SettingsOptionMeta {
  kind: "select" | "toggle" | "number" | "text" | "shortcuts";
  label: string;
  hint: string;
  options?: string[];
  /** Display text per option value (falls back to the value). */
  option_labels?: Record<string, string>;
  /** Extra line under the control. */
  note?: string;
  /** Shown but not changeable (e.g. the card list while acceleration is off). */
  locked?: boolean;
  min?: number;
  max?: number;
}

/** Browser choices built from what is installed; the default browser is named. */
function browserMeta(base: SettingsOptionMeta): SettingsOptionMeta {
  let inv: BrowserInventory;
  try {
    inv = listInstalledBrowsers();
  } catch {
    return base;
  }
  const def = inv.browsers.find((b) => b.id === inv.defaultId) ?? null;
  const labels: Record<string, string> = { auto: "auto" };
  for (const b of inv.browsers) labels[b.id] = b.chromium ? b.name : `${b.name} (opens as a normal window)`;
  return {
    ...base,
    hint: def
      ? `Normally your default browser is used (for you: ${def.name}). Applies the next time the window opens.`
      : "Normally your default browser is used. Applies the next time the window opens.",
    options: ["auto", ...inv.browsers.map((b) => b.id)],
    option_labels: labels,
  };
}

const META: Record<SettingKey, SettingsOptionMeta> = {
  "render.encoder": {
    kind: "select",
    label: "Graphics card",
    hint: "Card that encodes the video; auto picks the fastest one that works.",
    options: ["auto", "nvenc", "amf", "qsv", "vaapi", "videotoolbox", "x264"],
  },
  "render.gpu": {
    kind: "toggle",
    label: "Hardware acceleration",
    hint: "Encode renders on the graphics card. Off encodes on the CPU (slower).",
  },
  "render.workers": {
    kind: "select",
    label: "Render workers",
    hint: "Parallel render workers (1-32) or auto.",
    options: ["auto", "1", "2", "4", "8", "16", "32"],
  },
  "render.overlay_concurrency": {
    kind: "select",
    label: "Overlay concurrency",
    hint: "Cold compositions rendered in parallel (1-16) or auto.",
    options: ["auto", "1", "2", "4", "8", "16"],
  },
  "render.output_dir": {
    kind: "text",
    label: "Output folder",
    hint: "Render output path, relative to the project or absolute.",
  },
  "render.stall_timeout_sec": {
    kind: "number",
    label: "Stall timeout (s)",
    hint: "Watchdog timeout for renders without progress; 0 disables.",
    min: 0,
  },
  "cache.dir": {
    kind: "text",
    label: "Cache folder",
    hint: "Shared content-addressed cache location.",
  },
  "live.mode": {
    kind: "select",
    label: "Window mode",
    hint: "Whether the Live window opens automatically.",
    options: ["ask", "on", "off"],
  },
  "live.browser": {
    kind: "select",
    label: "Browser",
    hint: "Which browser draws the window. Applies the next time the window opens.",
    options: ["auto"],
  },
  "live.shortcuts": {
    kind: "shortcuts",
    label: "Shortcuts",
    hint: "Window keyboard shortcuts; click a row and press the new key.",
  },
};

export interface SettingsEntryView {
  key: SettingKey;
  value: unknown;
  display: string;
  source: "env" | "project" | "user" | "default";
  set_by: "agent" | "human" | null;
  readonly: boolean;
  readonly_reason: string | null;
  agent_badge: boolean;
  meta: SettingsOptionMeta;
}

export interface SettingsAbout {
  detected_encoder: string;
  gpu: string;
  cpu_cores: number;
  ffmpeg: string;
  hyperframes: string;
  cache_dir: string | null;
  cache_size: string;
}

/** Window-facing settings list, with control metadata and agent badges. */
export function getSettingsView(projectDir: string): { settings: SettingsEntryView[]; about: SettingsAbout } {
  const listed = listSettings(projectDir);
  const gpuOn = listed.find((s) => s.key === "render.gpu")?.value !== false;
  const settings = listed.map((s) => ({
    ...s,
    display: displaySettingValue(s.key, s.value),
    agent_badge: s.set_by === "agent" && !WINDOW_PREFERENCE_KEYS.has(s.key),
    meta:
      s.key === "live.browser"
        ? browserMeta(META[s.key])
        : s.key === "render.encoder"
          ? graphicsCardMeta(META[s.key], gpuOn)
          : META[s.key],
  }));
  // The acceleration switch reads first; the card list sits under it.
  const gpuIdx = settings.findIndex((s) => s.key === "render.gpu");
  const encIdx = settings.findIndex((s) => s.key === "render.encoder");
  if (gpuIdx > encIdx && encIdx >= 0) settings.splice(encIdx, 0, ...settings.splice(gpuIdx, 1));
  return { settings, about: getSettingsAbout() };
}

/** Encoder preference each graphics card maps to, by vendor name. */
export function encoderForGpuName(name: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "darwin") return "videotoolbox";
  if (/nvidia|geforce|quadro|rtx/i.test(name)) return "nvenc";
  if (/\bamd\b|radeon/i.test(name)) return platform === "linux" ? "vaapi" : "amf";
  if (/intel/i.test(name)) return platform === "linux" ? "vaapi" : "qsv";
  return null;
}

/**
 * Card choices from the cards in this machine: auto plus one entry per card
 * (labelled with its name). With acceleration off the control is locked to CPU.
 */
function graphicsCardMeta(base: SettingsOptionMeta, gpuOn: boolean): SettingsOptionMeta {
  if (!gpuOn) {
    return { ...base, options: ["x264"], option_labels: { x264: "CPU" }, locked: true, hint: "Hardware acceleration is off, so the CPU encodes." };
  }
  const labels: Record<string, string> = { auto: "auto", x264: "CPU" };
  const options = ["auto"];
  for (const name of detectGpuNames()) {
    const enc = encoderForGpuName(name);
    if (!enc || options.includes(enc)) continue;
    options.push(enc);
    labels[enc] = name;
  }
  return { ...base, options, option_labels: labels };
}

let gpuNamesCache: { at: number; names: string[] } | null = null;

/** Graphics card names (cached for five minutes; the probe takes about a second). */
function detectGpuNames(): string[] {
  if (gpuNamesCache && Date.now() - gpuNamesCache.at < 300_000) return gpuNamesCache.names;
  let names: string[] = [];
  try {
    if (process.platform === "win32") {
      // wmic is gone from current Windows builds; the CIM query works everywhere.
      const r = spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_VideoController).Name"],
        { encoding: "utf8", timeout: 8000, windowsHide: true }
      );
      names = (typeof r.stdout === "string" ? r.stdout : "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && l.toLowerCase() !== "name");
    } else if (process.platform === "darwin") {
      const line = firstLine("system_profiler", ["SPDisplaysDataType"]);
      if (line && line !== "unknown") names = [line];
    } else {
      const r = spawnSync("lspci", [], { encoding: "utf8", timeout: 5000, windowsHide: true });
      const out = typeof r.stdout === "string" ? r.stdout : "";
      names = out
        .split("\n")
        .filter((l) => /vga|3d|display/i.test(l))
        .map((l) => l.replace(/^.*?:\s*/, "").trim());
    }
  } catch {
    names = [];
  }
  gpuNamesCache = { at: Date.now(), names };
  return names;
}

function firstLine(cmd: string, args: string[]): string {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
    const out = typeof r.stdout === "string" ? r.stdout : "";
    const line = out.split("\n")[0]?.trim();
    return line ? line.slice(0, 80) : "unknown";
  } catch {
    return "unknown";
  }
}

/** Read-only environment facts; every probe is best-effort and never throws. */
export function getSettingsAbout(): SettingsAbout {
  let detected = "unknown";
  try {
    detected = readCachedEncoderProbe() ?? "unknown";
  } catch {
    detected = "unknown";
  }
  let gpu = "unknown";
  try {
    const names = detectGpuNames();
    if (names.length) gpu = names.join(" / ").slice(0, 120);
  } catch {
    gpu = "unknown";
  }
  let cacheDir: string | null = null;
  let cacheSize = "unknown";
  try {
    const shared = resolveSharedCacheConfig();
    cacheDir = shared.cacheDir;
    if (shared.enabled && shared.cacheDir) cacheSize = formatDirSize(shared.cacheDir);
  } catch {
    cacheDir = null;
  }
  return {
    detected_encoder: detected,
    gpu,
    cpu_cores: Math.max(1, os.cpus().length),
    ffmpeg: (() => {
      const line = firstLine("ffmpeg", ["-version"]);
      return /^ffmpeg version (\S+)/i.exec(line)?.[1] ?? line;
    })(),
    hyperframes: readHyperframesVersion(),
    cache_dir: cacheDir,
    cache_size: cacheSize,
  };
}

function readCachedEncoderProbe(): string | null {
  const override = process.env.CUTHOL_ENCODER_CACHE_FILE?.trim();
  const files: string[] = [];
  if (override) files.push(path.resolve(override));
  try {
    const shared = resolveSharedCacheConfig();
    if (shared.enabled && shared.cacheDir) {
      files.push(path.join(shared.cacheDir, "encoder_probes_v2.json"));
    }
  } catch {
    // ignore
  }
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        entries?: Record<string, { ok?: boolean; encoder?: string }>;
      };
      const entries = parsed?.entries ?? {};
      const ok = Object.values(entries).find((e) => e && e.ok);
      if (ok?.encoder) return String(ok.encoder);
    } catch {
      // unreadable cache: try the next file
    }
  }
  return null;
}

function readHyperframesVersion(): string {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    for (let dir = here; ; ) {
      const pkg = path.join(dir, "package.json");
      if (fs.existsSync(pkg)) {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8")) as {
          dependencies?: Record<string, string>;
        };
        const v = parsed?.dependencies?.hyperframes;
        if (v) return `hyperframes ${v}`;
        return "unknown";
      }
      const up = path.dirname(dir);
      if (up === dir) return "unknown";
      dir = up;
    }
  } catch {
    return "unknown";
  }
}

function formatDirSize(dir: string): string {
  let total = 0;
  let seen = 0;
  const stack: string[] = [dir];
  try {
    while (stack.length && seen < 5000) {
      const cur = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (seen >= 5000) break;
        seen += 1;
        const full = path.join(cur, e.name);
        try {
          if (e.isDirectory()) stack.push(full);
          else if (e.isFile()) total += fs.statSync(full).size;
        } catch {
          // unreadable entry: skip
        }
      }
    }
  } catch {
    return "unknown";
  }
  if (total < 1024) return `${total} B`;
  if (total < 1024 ** 2) return `${(total / 1024).toFixed(1)} KB`;
  if (total < 1024 ** 3) return `${(total / 1024 ** 2).toFixed(1)} MB`;
  return `${(total / 1024 ** 3).toFixed(2)} GB`;
}

/** Window preferences (shortcuts, how the window opens) are the human's own; the agent never hears about them. */
const WINDOW_PREFERENCE_KEYS: ReadonlySet<string> = new Set(["live.mode", "live.browser", "live.shortcuts"]);

/**
 * Queue the human change so it rides with the agent's next CLI/MCP response.
 * Window preferences and saves that leave the value unchanged are not queued.
 */
export function queueSettingNotice(projectDir: string, key: string, oldDisplay: string, newDisplay: string): void {
  if (WINDOW_PREFERENCE_KEYS.has(key) || oldDisplay === newDisplay) return;
  let revision = 0;
  try {
    revision = loadJournalManifest(loadSequence(projectDir).paths).cursor_revision ?? 0;
  } catch {
    revision = 0;
  }
  writeLiveNotePacket(projectDir, {
    id: `setting_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
    created_at: new Date().toISOString(),
    revision,
    notes: [],
    setting: { key, old_value: oldDisplay, new_value: newDisplay },
  });
}

function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      if (chunks.length > 64) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * Mounted by the live server file:
 *   GET  /api/settings          full window view
 *   POST /api/settings          {key, value} or {key, reset:true}; human write
 */
export async function routeLiveSettingsRequest(
  projectDir: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): Promise<boolean> {
  const send = (code: number, body: unknown): boolean => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
    return true;
  };
  if (req.method === "GET") {
    try {
      return send(200, { ok: true, ...getSettingsView(projectDir) });
    } catch (e) {
      return send(500, {
        ok: false,
        diagnostic: (e as CutholError)?.diagnostic ?? DIAGNOSTICS.SETTINGS_WRITE_FAILED("(settings view)", String(e)),
      });
    }
  }
  if (req.method === "POST") {
    const body = (await readBody(req)) as { key?: unknown; value?: unknown; reset?: unknown } | null;
    const key = body?.key;
    if (typeof key !== "string" || !isSettingKey(key)) {
      return send(400, { ok: false, diagnostic: DIAGNOSTICS.SETTINGS_UNKNOWN_KEY(String(key ?? "(missing)")) });
    }
    const envName = settingEnvVar(key);
    if (envName && envSettingValue(key) !== undefined) {
      return send(409, { ok: false, diagnostic: DIAGNOSTICS.SETTINGS_ENV_LOCKED(key, envName) });
    }
    try {
      if (body?.reset === true) {
        const before = resolveSetting(projectDir, key);
        resetSetting(projectDir, key);
        const after = resolveSetting(projectDir, key);
        queueSettingNotice(projectDir, key, displaySettingValue(key, before.value), displaySettingValue(key, after.value));
        return send(200, { ok: true, ...getSettingsView(projectDir) });
      }
      // The window writes `live.shortcuts` as the human; the agent CLI path
      // refuses it (G622) because window-only keys are not agent-settable.
      const before = resolveSetting(projectDir, key);
      let value = body?.value;
      if (typeof value === "string" && (key === "render.workers" || key === "render.overlay_concurrency" || key === "render.stall_timeout_sec")) {
        const n = Number(value.trim());
        value = value.trim().toLowerCase() === "auto" ? "auto" : Number.isFinite(n) ? n : value;
      }
      if (key === "render.gpu" && typeof value === "string") {
        value = ["1", "true", "on"].includes(value.trim().toLowerCase());
      }
      const r = setSetting(projectDir, key, value, "human");
      queueSettingNotice(projectDir, key, displaySettingValue(key, before.value), displaySettingValue(key, r.value));
      return send(200, { ok: true, ...getSettingsView(projectDir) });
    } catch (e) {
      const diag = (e as CutholError)?.diagnostic;
      const code = diag?.code === "CUTHOL-G621" ? 400 : 500;
      return send(code, { ok: false, diagnostic: diag ?? DIAGNOSTICS.SETTINGS_WRITE_FAILED("(settings write)", String(e)) });
    }
  }
  return false;
}

export { DEFAULT_SHORTCUTS, SHORTCUT_LABELS, displaySettingValue, resolveShortcuts, storedSetting };
