// Cuthol Live window launcher: opens the live URL in a Chromium app-mode window.
//
// The browser follows the `live.browser` setting: "auto" is the user's default
// browser (live_browsers.ts), else a named installed browser; Chromium browsers
// open in app mode, others as a normal window. When nothing is found the URL opens
// in the default browser instead. Launch failures never throw: they surface as
// the CUTHOL-G606 warning and the agent keeps working.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { resolveSetting } from "../core/settings.js";
import { browserIdFromExe, listInstalledBrowsers, pickLiveBrowser, type BrowserInventory } from "./live_browsers.js";

export interface LiveWindowResult {
  opened: boolean;
  /** "app" = Chromium app-mode window, "browser" = default browser fallback, "none" = not opened. */
  mode: "app" | "browser" | "none";
  browser?: string;
  note?: string;
}

/** Injectable seams so tests can drive browser discovery with fake paths. */
export interface BrowserSearchEnv {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  /** PATH lookup; returns the executable path or null. */
  which?: (cmd: string) => string | null;
  /** Windows registry read; returns the value or null. */
  readRegistry?: (key: string, valueName: string) => string | null;
  /** App-mode launch; returns the child pid. Injected by tests to avoid opening a window. */
  spawnApp?: (browser: string, args: string[]) => number | undefined;
  /** Default-browser fallback. Injected by tests to avoid opening a window. */
  openUrl?: (url: string, platform: NodeJS.Platform) => void;
  /** `live.browser` value: "auto" (the default browser) or an installed browser id. */
  prefer?: string;
  /** Installed browsers; injected by tests. */
  inventory?: BrowserInventory;
}

const LIVE_WINDOW_SIZE = "1600,900";

/**
 * Dedicated profile so the Live window keeps its own size/position and runs no
 * extensions. Edge keeps the original folder; other browsers get their own,
 * since profiles are not shared between browsers.
 */
export function liveProfileDir(homeDir: string = os.homedir(), browser?: string): string {
  const id = browser ? browserIdFromExe(browser) : "edge";
  return path.join(homeDir, ".cuthol", "live", id === "edge" ? "profile" : `profile-${id}`);
}

function defaultWhich(cmd: string, platform: NodeJS.Platform): string | null {
  try {
    const probe = platform === "win32" ? "where" : "which";
    const out = execFileSync(probe, [cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    return first ?? null;
  } catch {
    return null;
  }
}

function defaultReadRegistry(key: string, valueName: string): string | null {
  // `reg query <key> /ve` prints the (Default) value; parse the last token run.
  try {
    const args = valueName === "(Default)" ? ["query", key, "/ve"] : ["query", key, "/v", valueName];
    const out = execFileSync("reg", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      const m = /REG_SZ\s+(.+)$/.exec(line.trim());
      if (m) return m[1].trim();
    }
    return null;
  } catch {
    return null;
  }
}

function windowsCandidates(env: NodeJS.ProcessEnv): { edge: string[]; chrome: string[] } {
  const edge: string[] = [];
  const chrome: string[] = [];
  const push = (list: string[], ...parts: string[]) => list.push(path.join(...parts));
  if (env["ProgramFiles"]) {
    push(edge, env["ProgramFiles"], "Microsoft", "Edge", "Application", "msedge.exe");
    push(chrome, env["ProgramFiles"], "Google", "Chrome", "Application", "chrome.exe");
  }
  if (env["ProgramFiles(x86)"]) {
    push(edge, env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe");
    push(chrome, env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe");
  }
  if (env["LocalAppData"]) {
    push(edge, env["LocalAppData"], "Microsoft", "Edge", "Application", "msedge.exe");
    push(chrome, env["LocalAppData"], "Google", "Chrome", "Application", "chrome.exe");
  }
  return { edge, chrome };
}

/**
 * Finds a Chromium-based browser executable, or null when none is installed.
 * Windows: Edge (registry, then usual paths), then Chrome. macOS: Chrome, Edge,
 * Chromium app bundles. Linux: `google-chrome`, `chromium`, `microsoft-edge` on PATH.
 */
export function findChromiumBrowser(search: BrowserSearchEnv = {}): string | null {
  const platform = search.platform ?? process.platform;
  const env = search.env ?? process.env;
  const exists = search.exists ?? ((p: string) => fs.existsSync(p));
  const which = search.which ?? ((cmd: string) => defaultWhich(cmd, platform));
  const readRegistry = search.readRegistry ?? defaultReadRegistry;

  const prefer = search.prefer ?? "auto";
  if (platform === "win32") {
    const { edge, chrome } = windowsCandidates(env);
    const viaRegistry = (exe: string): string | null => {
      for (const hive of ["HKCU", "HKLM"]) {
        const hit = readRegistry(`${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, "(Default)");
        if (hit && exists(hit)) return hit;
      }
      return null;
    };
    const findEdge = () => viaRegistry("msedge.exe") ?? edge.find((p) => exists(p)) ?? null;
    const findChrome = () => viaRegistry("chrome.exe") ?? chrome.find((p) => exists(p)) ?? null;
    // Edge ships with Windows, so an installed Chrome is the user's own choice.
    const hit = prefer === "edge" ? findEdge() ?? findChrome() : findChrome() ?? findEdge();
    if (hit) return hit;
    return prefer === "edge" ? which("msedge") ?? which("chrome") : which("chrome") ?? which("msedge");
  }
  if (platform === "darwin") {
    const chromeApp = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const edgeApp = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    const order = prefer === "edge" ? [edgeApp, chromeApp] : [chromeApp, edgeApp];
    for (const hit of [...order, "/Applications/Chromium.app/Contents/MacOS/Chromium"]) {
      if (exists(hit)) return hit;
    }
    return null;
  }
  const linuxOrder = prefer === "edge" ? ["microsoft-edge", "google-chrome", "chromium"] : ["google-chrome", "chromium", "microsoft-edge"];
  for (const cmd of linuxOrder) {
    const hit = which(cmd);
    if (hit) return hit;
  }
  return null;
}

/** True when the window must not be opened (tests and headless runs). */
export function liveWindowSuppressed(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean {
  if (env["CUTHOL_LIVE_NO_WINDOW"] === "1") return true;
  return argv.includes("--no-window");
}

function defaultSpawnApp(browser: string, args: string[]): number | undefined {
  const child = spawn(browser, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => {});
  child.unref();
  return child.pid;
}

function defaultOpenUrl(url: string, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    // `start` is a cmd builtin; the empty title arg keeps URLs with `&` intact.
    spawn("cmd", ["/c", "start", '""', url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  if (platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

/**
 * Opens the Live window for a URL in an app-mode Chromium window (Edge/Chrome/Chromium),
 * else the default browser. Never throws: failures return `opened: false` with a G606
 * warning on stderr so the agent's work continues.
 */
export function openLiveWindow(url: string, projectDir: string, search: BrowserSearchEnv = {}): LiveWindowResult {
  if (liveWindowSuppressed(search.env ?? process.env)) {
    return { opened: false, mode: "none", note: "window suppressed (CUTHOL_LIVE_NO_WINDOW=1 or --no-window)" };
  }
  const platform = search.platform ?? process.platform;
  const spawnApp = search.spawnApp ?? defaultSpawnApp;
  const openUrl = search.openUrl ?? defaultOpenUrl;
  let prefer = search.prefer;
  if (!prefer) {
    try {
      prefer = String(resolveSetting(projectDir, "live.browser").value);
    } catch {
      prefer = "auto";
    }
  }
  // Real runs read the installed-browser list; tests that inject path seams
  // drive the fixed Chromium search instead.
  const injectedPaths = Boolean(search.exists || search.which || search.readRegistry);
  const inventory = search.inventory ?? (injectedPaths ? null : listInstalledBrowsers());
  const picked = inventory ? pickLiveBrowser(inventory, prefer) : null;
  if (picked && !picked.chromium) {
    // No app mode outside the Chromium family: a normal window of that browser.
    try {
      spawnApp(picked.exe, [url]);
      return { opened: true, mode: "browser", browser: picked.exe, note: `${picked.name} has no app mode; opened as a normal window` };
    } catch (e) {
      const d = DIAGNOSTICS.LIVE_WINDOW_OPEN_FAILED(String(e instanceof Error ? e.message : e));
      console.error(d.formatted);
    }
  }
  const browser = picked?.chromium ? picked.exe : findChromiumBrowser({ ...search, prefer });
  if (!browser) {
    try {
      openUrl(url, platform);
      return { opened: true, mode: "browser", note: "no Chromium browser found; opened in the default browser" };
    } catch (e) {
      const d = DIAGNOSTICS.LIVE_WINDOW_OPEN_FAILED(String(e instanceof Error ? e.message : e));
      console.error(d.formatted);
      return { opened: false, mode: "none", note: d.what };
    }
  }
  try {
    const profileDir = liveProfileDir(os.homedir(), browser);
    const args = [`--app=${url}`, `--user-data-dir=${profileDir}`];
    // First launch only: afterwards the profile keeps the user's own size/position.
    if (!fs.existsSync(profileDir)) args.push(`--window-size=${LIVE_WINDOW_SIZE}`);
    spawnApp(browser, args);
    return { opened: true, mode: "app", browser };
  } catch (e) {
    const d = DIAGNOSTICS.LIVE_WINDOW_OPEN_FAILED(String(e instanceof Error ? e.message : e));
    console.error(d.formatted);
    try {
      openUrl(url, platform);
      return { opened: true, mode: "browser", browser, note: `app-mode launch failed (${d.what}); opened in the default browser` };
    } catch {
      return { opened: false, mode: "none", browser, note: d.what };
    }
  }
}
