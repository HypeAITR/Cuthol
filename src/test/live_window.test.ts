/**
 * Live window launcher: browser discovery with fake paths, suppression flags,
 * app-mode arguments, default-browser fallback and the G606 warning path.
 * Nothing here opens a real window: launching is always injected or suppressed.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { findChromiumBrowser, liveProfileDir, liveWindowSuppressed, openLiveWindow, type BrowserSearchEnv } from "../live/live_window.js";

const WIN_ENV = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LocalAppData: "C:\\Users\\tester\\AppData\\Local",
};

function winSearch(existing: string[], registry: Record<string, string> = {}): BrowserSearchEnv {
  const set = new Set(existing.map((p) => p.toLowerCase()));
  return {
    platform: "win32",
    env: { ...WIN_ENV },
    exists: (p) => set.has(p.toLowerCase()),
    which: () => null,
    readRegistry: (key) => registry[key] ?? null,
  };
}

test("windows: auto prefers an installed Chrome over Edge", () => {
  const edgeReg = "C:\\Custom\\msedge.exe";
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const found = findChromiumBrowser(
    winSearch(
      [edgeReg, "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", chromePath],
      { "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe": edgeReg }
    )
  );
  assert.equal(found, chromePath);
});

test("windows: Edge is used when Chrome is absent (registry first)", () => {
  const edgeReg = "C:\\Custom\\msedge.exe";
  const found = findChromiumBrowser(
    winSearch([edgeReg, "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"], {
      "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe": edgeReg,
    })
  );
  assert.equal(found, edgeReg);
});

test("windows: prefer=edge puts Edge first, prefer=chrome falls back to Edge", () => {
  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  assert.equal(findChromiumBrowser({ ...winSearch([edgePath, chromePath]), prefer: "edge" }), edgePath);
  assert.equal(findChromiumBrowser({ ...winSearch([edgePath]), prefer: "chrome" }), edgePath);
});

test("profile folder: Edge keeps the original, Chrome gets its own", () => {
  assert.ok(liveProfileDir("/h", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe").endsWith("profile"));
  assert.ok(liveProfileDir("/h", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe").endsWith("profile-chrome"));
});

test("windows: Chrome registry is used when Edge is absent", () => {
  const chromeReg = "D:\\Browsers\\chrome.exe";
  const found = findChromiumBrowser(
    winSearch([chromeReg], { "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe": chromeReg })
  );
  assert.equal(found, chromeReg);
});

test("windows: registry hits that do not exist on disk are skipped", () => {
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const found = findChromiumBrowser(
    winSearch([chromePath], {
      "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe": "C:\\Ghost\\msedge.exe",
    })
  );
  assert.equal(found, chromePath);
});

test("windows: null when no browser exists", () => {
  assert.equal(findChromiumBrowser(winSearch([])), null);
});

test("macos: Chrome bundle first, then Edge, then Chromium", () => {
  const edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
  const chromium = "/Applications/Chromium.app/Contents/MacOS/Chromium";
  const exists = (p: string) => p === edge || p === chromium;
  assert.equal(findChromiumBrowser({ platform: "darwin", env: {}, exists }), edge);
  assert.equal(findChromiumBrowser({ platform: "darwin", env: {}, exists: (p) => p === chromium }), chromium);
  assert.equal(findChromiumBrowser({ platform: "darwin", env: {}, exists: () => false }), null);
});

test("linux: PATH order is google-chrome, chromium, microsoft-edge", () => {
  const bins: Record<string, string> = { chromium: "/usr/bin/chromium", "microsoft-edge": "/usr/bin/microsoft-edge" };
  assert.equal(
    findChromiumBrowser({ platform: "linux", env: {}, exists: () => true, which: (c) => bins[c] ?? null }),
    "/usr/bin/chromium"
  );
  assert.equal(
    findChromiumBrowser({ platform: "linux", env: {}, exists: () => true, which: (c) => (c === "google-chrome" ? "/opt/chrome" : bins[c] ?? null) }),
    "/opt/chrome"
  );
  assert.equal(
    findChromiumBrowser({ platform: "linux", env: {}, exists: () => true, which: () => null }),
    null
  );
});

test("suppression: env flag and --no-window argv", () => {
  assert.equal(liveWindowSuppressed({ CUTHOL_LIVE_NO_WINDOW: "1" }, ["node", "cli.js"]), true);
  assert.equal(liveWindowSuppressed({}, ["node", "cli.js", "live", "open", "--no-window"]), true);
  assert.equal(liveWindowSuppressed({}, ["node", "cli.js", "live", "open"]), false);
});

test("openLiveWindow: suppressed run opens nothing", () => {
  let launched = 0;
  const res = openLiveWindow("http://127.0.0.1:1/?t=x", "/tmp/proj", {
    platform: "linux",
    env: { CUTHOL_LIVE_NO_WINDOW: "1" },
    spawnApp: () => { launched++; return 1; },
    openUrl: () => { launched++; },
  });
  assert.equal(res.opened, false);
  assert.equal(res.mode, "none");
  assert.equal(launched, 0);
});

test("openLiveWindow: app-mode args carry --app, profile and window size", () => {
  const calls: Array<{ browser: string; args: string[] }> = [];
  const res = openLiveWindow("http://127.0.0.1:9/?t=tok", "/tmp/proj", {
    platform: "linux",
    env: {},
    exists: () => true,
    which: (c) => (c === "google-chrome" ? "/usr/bin/google-chrome" : null),
    spawnApp: (browser, args) => { calls.push({ browser, args }); return 42; },
  });
  assert.equal(res.opened, true);
  assert.equal(res.mode, "app");
  assert.equal(res.browser, "/usr/bin/google-chrome");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args[0] === "--app=http://127.0.0.1:9/?t=tok");
  assert.ok(calls[0].args.some((a) => a.startsWith("--user-data-dir=") && a.includes(".cuthol")));
});

test("openLiveWindow: missing browser falls back to the default browser", () => {
  const opened: string[] = [];
  const res = openLiveWindow("http://127.0.0.1:9/", "/tmp/proj", {
    platform: "linux",
    env: {},
    exists: () => true,
    which: () => null,
    openUrl: (url) => { opened.push(url); },
  });
  assert.equal(res.opened, true);
  assert.equal(res.mode, "browser");
  assert.deepEqual(opened, ["http://127.0.0.1:9/"]);
  assert.match(res.note ?? "", /default browser/);
});

test("openLiveWindow: double failure warns G606 and never throws", () => {
  const errLines: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => { errLines.push(a.map(String).join(" ")); };
  try {
    const res = openLiveWindow("http://127.0.0.1:9/", "/tmp/proj", {
      platform: "linux",
      env: {},
      exists: () => true,
      which: () => null,
      openUrl: () => { throw new Error("no opener"); },
    });
    assert.equal(res.opened, false);
    assert.equal(res.mode, "none");
    assert.ok(errLines.some((l) => l.includes("CUTHOL-G606")), `expected G606, got: ${errLines.join(" | ")}`);
  } finally {
    console.error = origError;
  }
});
