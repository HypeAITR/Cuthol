// Installed web browsers and the user's default browser, for the Live window.
//
// Windows: browsers register themselves under Clients\StartMenuInternet
// (machine and user hives); the default comes from the https URL association
// (UserChoiceLatest on current Windows 11, UserChoice before it). macOS and
// Linux: a fixed list of well-known locations / PATH names; the default is
// not detected there. Chromium-based browsers can open the window in app mode;
// others open it as a normal browser window.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface InstalledBrowser {
  /** Stable short id used as the `live.browser` value (e.g. "chrome", "edge", "firefox"). */
  id: string;
  /** Display name (e.g. "Google Chrome"). */
  name: string;
  /** Executable path. */
  exe: string;
  /** True when the browser supports `--app` / `--user-data-dir` (Chromium family). */
  chromium: boolean;
}

export interface BrowserInventory {
  browsers: InstalledBrowser[];
  /** Id of the user's default browser, or null when unknown. */
  defaultId: string | null;
}

export interface BrowserInventorySeams {
  platform?: NodeJS.Platform;
  /** `reg query` runner: returns stdout, or null when the key does not exist. */
  runReg?: (args: string[]) => string | null;
  exists?: (p: string) => boolean;
  which?: (cmd: string) => string | null;
}

const CHROMIUM_IDS = new Set(["chrome", "edge", "brave", "vivaldi", "chromium"]);

/** Short id from an executable path: msedge.exe → edge, google-chrome → chrome. */
export function browserIdFromExe(exe: string): string {
  let base = path.basename(exe.replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");
  if (base === "msedge" || base === "microsoft-edge" || base === "microsoft edge") base = "edge";
  if (base === "google-chrome" || base === "google chrome") base = "chrome";
  if (base === "chromium-browser") base = "chromium";
  return base.replace(/[^a-z0-9._-]/g, "-");
}

function defaultRunReg(args: string[]): string | null {
  try {
    return execFileSync("reg", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch {
    return null;
  }
}

function defaultWhich(cmd: string): string | null {
  try {
    const out = execFileSync("which", [cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? null;
  } catch {
    return null;
  }
}

/** Parses `reg query <key> /s` output into key path → (value name → data). */
export function parseRegQuery(out: string): Map<string, Map<string, string>> {
  const keys = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const raw of out.split(/\r?\n/)) {
    if (/^HKEY_/i.test(raw)) {
      current = new Map();
      keys.set(raw.trim().toLowerCase(), current);
      continue;
    }
    const m = /^\s+(.+?)\s{2,}REG_(?:SZ|EXPAND_SZ)\s{2,}(.*)$/.exec(raw);
    if (m && current) current.set(m[1].trim().toLowerCase(), m[2].trim());
  }
  return keys;
}

/** First token of a shell command line: `"C:\x\y.exe" --flag` → `C:\x\y.exe`. */
function exeFromCommand(cmd: string): string {
  const t = cmd.trim();
  if (t.startsWith('"')) return t.slice(1, t.indexOf('"', 1) > 0 ? t.indexOf('"', 1) : undefined);
  const m = /^(.+?\.exe)\b/i.exec(t);
  return m ? m[1] : t.split(/\s+/)[0];
}

function windowsInventory(runReg: (args: string[]) => string | null, exists: (p: string) => boolean): BrowserInventory {
  const roots = [
    "HKCU\\SOFTWARE\\Clients\\StartMenuInternet",
    "HKLM\\SOFTWARE\\Clients\\StartMenuInternet",
    "HKLM\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet",
  ];
  const browsers: InstalledBrowser[] = [];
  const progIdToId = new Map<string, string>();
  const seenExe = new Set<string>();
  for (const root of roots) {
    const out = runReg(["query", root, "/s"]);
    if (!out) continue;
    const keys = parseRegQuery(out);
    const rootLc = root.toLowerCase().replace(/^hkcu/, "hkey_current_user").replace(/^hklm/, "hkey_local_machine");
    for (const [keyPath, values] of keys) {
      if (!keyPath.startsWith(rootLc + "\\")) continue;
      const rel = keyPath.slice(rootLc.length + 1);
      if (rel.includes("\\")) continue; // only direct children are browsers
      if (rel === "iexplore.exe") continue; // retired; launches Edge
      const command = keys.get(`${keyPath}\\shell\\open\\command`)?.get("(default)");
      if (!command) continue;
      const exe = exeFromCommand(command);
      if (!exe || !exists(exe)) continue;
      const id = browserIdFromExe(exe);
      const progId = keys.get(`${keyPath}\\capabilities\\urlassociations`)?.get("https");
      if (progId) progIdToId.set(progId.toLowerCase(), id);
      if (seenExe.has(exe.toLowerCase()) || browsers.some((b) => b.id === id)) continue;
      seenExe.add(exe.toLowerCase());
      // Names starting with "@" are resource references, not readable text.
      const name =
        [keys.get(`${keyPath}\\capabilities`)?.get("applicationname"), values.get("(default)")].find(
          (n) => n && !n.startsWith("@")
        ) ?? id;
      browsers.push({ id, name, exe, chromium: CHROMIUM_IDS.has(id) });
    }
  }
  let defaultProgId: string | null = null;
  for (const key of [
    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoiceLatest\\ProgId",
    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
  ]) {
    const out = runReg(["query", key, "/v", "ProgId"]);
    const m = out ? /ProgId\s+REG_SZ\s+(\S+)/i.exec(out) : null;
    if (m) {
      defaultProgId = m[1];
      break;
    }
  }
  let defaultId = defaultProgId ? progIdToId.get(defaultProgId.toLowerCase()) ?? null : null;
  // Browsers that skip Capabilities still use well-known ProgIds.
  if (!defaultId && defaultProgId) {
    const p = defaultProgId.toLowerCase();
    const guess = p.startsWith("chromehtml") ? "chrome" : p.startsWith("msedgehtm") ? "edge" : p.startsWith("firefoxurl") ? "firefox" : p.startsWith("bravehtml") ? "brave" : null;
    if (guess && browsers.some((b) => b.id === guess)) defaultId = guess;
  }
  return { browsers, defaultId };
}

function unixInventory(platform: NodeJS.Platform, exists: (p: string) => boolean, which: (c: string) => string | null): BrowserInventory {
  const browsers: InstalledBrowser[] = [];
  const add = (exe: string | null, name: string) => {
    if (!exe) return;
    const id = browserIdFromExe(exe);
    if (browsers.some((b) => b.id === id)) return;
    browsers.push({ id, name, exe, chromium: CHROMIUM_IDS.has(id) });
  };
  if (platform === "darwin") {
    for (const [exe, name] of [
      ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "Google Chrome"],
      ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Microsoft Edge"],
      ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "Brave"],
      ["/Applications/Chromium.app/Contents/MacOS/Chromium", "Chromium"],
      ["/Applications/Firefox.app/Contents/MacOS/firefox", "Firefox"],
    ]) {
      if (exists(exe)) add(exe, name);
    }
    for (const b of browsers) if (b.name === "Brave") b.id = "brave";
    for (const b of browsers) b.chromium = CHROMIUM_IDS.has(b.id);
    return { browsers, defaultId: null };
  }
  for (const [cmd, name] of [
    ["google-chrome", "Google Chrome"],
    ["chromium", "Chromium"],
    ["chromium-browser", "Chromium"],
    ["microsoft-edge", "Microsoft Edge"],
    ["brave-browser", "Brave"],
    ["firefox", "Firefox"],
  ]) {
    const hit = which(cmd);
    if (hit) add(hit, name);
  }
  for (const b of browsers) if (b.name === "Brave") { b.id = "brave"; b.chromium = true; }
  return { browsers, defaultId: null };
}

let cache: { at: number; inv: BrowserInventory } | null = null;

/** Installed browsers and the default; cached for a minute when no seams are given. */
export function listInstalledBrowsers(seams: BrowserInventorySeams = {}): BrowserInventory {
  const injected = Object.keys(seams).length > 0;
  if (!injected && cache && Date.now() - cache.at < 60_000) return cache.inv;
  const platform = seams.platform ?? process.platform;
  const exists = seams.exists ?? ((p: string) => fs.existsSync(p));
  const inv =
    platform === "win32"
      ? windowsInventory(seams.runReg ?? defaultRunReg, exists)
      : unixInventory(platform, exists, seams.which ?? defaultWhich);
  if (!injected) cache = { at: Date.now(), inv };
  return inv;
}

/**
 * The browser the window should use for a `live.browser` value: the named one
 * when installed, otherwise ("auto" or missing) the default browser, otherwise
 * the first Chromium browser (Chrome before Edge), otherwise anything found.
 */
export function pickLiveBrowser(inv: BrowserInventory, prefer: string): InstalledBrowser | null {
  const byId = (id: string | null) => (id ? inv.browsers.find((b) => b.id === id) ?? null : null);
  return (
    (prefer !== "auto" ? byId(prefer) : null) ??
    byId(inv.defaultId) ??
    byId("chrome") ??
    byId("edge") ??
    inv.browsers.find((b) => b.chromium) ??
    inv.browsers[0] ??
    null
  );
}
