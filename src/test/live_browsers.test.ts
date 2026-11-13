/**
 * Installed-browser inventory: registry parsing with fake `reg query` output,
 * default-browser detection (current and older Windows keys), the pick order
 * for the `live.browser` setting, and non-Chromium browsers opening as a
 * normal window. Nothing here reads the real registry or opens a window.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { browserIdFromExe, listInstalledBrowsers, pickLiveBrowser, type BrowserInventory } from "../live/live_browsers.js";
import { openLiveWindow } from "../live/live_window.js";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const FIREFOX = "C:\\Program Files\\Mozilla Firefox\\firefox.exe";

const HKLM_OUT = [
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet",
  "    (Default)    REG_SZ    IEXPLORE.EXE",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome",
  "    (Default)    REG_SZ    Google Chrome",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\\Capabilities",
  "    ApplicationName    REG_SZ    Google Chrome",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\\Capabilities\\URLAssociations",
  "    https    REG_SZ    ChromeHTML",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\\shell\\open\\command",
  `    (Default)    REG_SZ    "${CHROME}"`,
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\IEXPLORE.EXE\\shell\\open\\command",
  '    (Default)    REG_SZ    "C:\\Program Files\\Internet Explorer\\iexplore.exe"',
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Microsoft Edge",
  "    (Default)    REG_SZ    Microsoft Edge",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Microsoft Edge\\Capabilities",
  "    ApplicationName    REG_SZ    @C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe,-1",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Microsoft Edge\\Capabilities\\URLAssociations",
  "    https    REG_SZ    MSEdgeHTM",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Microsoft Edge\\shell\\open\\command",
  `    (Default)    REG_SZ    "${EDGE}"`,
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\FIREFOX.EXE",
  "    (Default)    REG_SZ    Mozilla Firefox",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\FIREFOX.EXE\\Capabilities\\URLAssociations",
  "    https    REG_SZ    FirefoxURL-308046B0AF4A39CB",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\FIREFOX.EXE\\shell\\open\\command",
  `    (Default)    REG_SZ    "${FIREFOX}" -osint`,
  "",
].join("\r\n");

function fakeReg(defaults: { latest?: string; legacy?: string }) {
  return (args: string[]): string | null => {
    const key = args[1];
    if (key === "HKLM\\SOFTWARE\\Clients\\StartMenuInternet") return HKLM_OUT;
    if (key.endsWith("UserChoiceLatest\\ProgId")) return defaults.latest ? `\r\n${key}\r\n    ProgId    REG_SZ    ${defaults.latest}\r\n` : null;
    if (key.endsWith("https\\UserChoice")) return defaults.legacy ? `\r\n${key}\r\n    ProgId    REG_SZ    ${defaults.legacy}\r\n` : null;
    return null;
  };
}

const installed = new Set([CHROME, EDGE, FIREFOX].map((p) => p.toLowerCase()));
const seams = (d: { latest?: string; legacy?: string }) => ({
  platform: "win32" as const,
  runReg: fakeReg(d),
  exists: (p: string) => installed.has(p.toLowerCase()),
});

test("browsers: registry lists Chrome, Edge, Firefox; Internet Explorer skipped; names readable", () => {
  const inv = listInstalledBrowsers(seams({ latest: "ChromeHTML" }));
  assert.deepEqual(inv.browsers.map((b) => b.id), ["chrome", "edge", "firefox"]);
  assert.deepEqual(inv.browsers.map((b) => b.name), ["Google Chrome", "Microsoft Edge", "Mozilla Firefox"]);
  assert.deepEqual(inv.browsers.map((b) => b.chromium), [true, true, false]);
  assert.equal(inv.browsers[2].exe, FIREFOX);
});

test("browsers: the newer UserChoiceLatest key wins over the older UserChoice", () => {
  assert.equal(listInstalledBrowsers(seams({ latest: "ChromeHTML", legacy: "MSEdgeHTM" })).defaultId, "chrome");
  assert.equal(listInstalledBrowsers(seams({ legacy: "MSEdgeHTM" })).defaultId, "edge");
  assert.equal(listInstalledBrowsers(seams({ latest: "FirefoxURL-308046B0AF4A39CB" })).defaultId, "firefox");
  assert.equal(listInstalledBrowsers(seams({})).defaultId, null);
});

test("browsers: pick order is named, then default, then Chrome, then Edge", () => {
  const inv: BrowserInventory = listInstalledBrowsers(seams({ latest: "FirefoxURL-308046B0AF4A39CB" }));
  assert.equal(pickLiveBrowser(inv, "auto")?.id, "firefox");
  assert.equal(pickLiveBrowser(inv, "edge")?.id, "edge");
  assert.equal(pickLiveBrowser(inv, "opera")?.id, "firefox");
  assert.equal(pickLiveBrowser({ ...inv, defaultId: null }, "auto")?.id, "chrome");
  assert.equal(pickLiveBrowser({ browsers: [], defaultId: null }, "auto"), null);
});

test("browsers: ids from executable names", () => {
  assert.equal(browserIdFromExe(EDGE), "edge");
  assert.equal(browserIdFromExe(CHROME), "chrome");
  assert.equal(browserIdFromExe("/usr/bin/google-chrome"), "chrome");
  assert.equal(browserIdFromExe("/usr/bin/microsoft-edge"), "edge");
  assert.equal(browserIdFromExe(FIREFOX), "firefox");
});

test("openLiveWindow: a non-Chromium default opens as a normal window, Chromium in app mode", () => {
  const inv = listInstalledBrowsers(seams({ latest: "FirefoxURL-308046B0AF4A39CB" }));
  const calls: Array<{ browser: string; args: string[] }> = [];
  const spawnApp = (browser: string, args: string[]) => { calls.push({ browser, args }); return 1; };
  const ff = openLiveWindow("http://127.0.0.1:9/?t=tok", "/tmp/proj", { platform: "win32", env: {}, inventory: inv, prefer: "auto", spawnApp });
  assert.equal(ff.mode, "browser");
  assert.equal(calls[0].browser, FIREFOX);
  assert.deepEqual(calls[0].args, ["http://127.0.0.1:9/?t=tok"]);
  const ch = openLiveWindow("http://127.0.0.1:9/?t=tok", "/tmp/proj", { platform: "win32", env: {}, inventory: inv, prefer: "chrome", spawnApp });
  assert.equal(ch.mode, "app");
  assert.equal(calls[1].browser, CHROME);
  assert.ok(calls[1].args.some((a) => a.startsWith("--user-data-dir=") && a.endsWith("profile-chrome")));
});
