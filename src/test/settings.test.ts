// Settings layer: precedence, authorship, validation, effect on resolvers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initWorkspace } from "../core/workspace.js";
import {
  resolveHyperFramesWorkers,
  resolveOverlayConcurrency,
  resolveSharedCacheConfig,
  resolveStallWatchdogConfig,
  resolveVideoEncoderPreference,
} from "../core/env.js";
import {
  displaySettingValue,
  listSettings,
  resetSetting,
  resolveSetting,
  setSetting,
} from "../core/settings.js";
import { resolveLiveConfig, setLiveConfig } from "../live/live_config.js";
import { resolveRenderOutputDir } from "../render/render_main.js";
import { runSettingsCommand } from "../cli_cmd_settings.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");

function makeProject(name: string): string {
  const dir = path.join(TEST_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  initWorkspace({ dir, title: name, aspect: "16:9", fps: 30 });
  return dir;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function settingsFiles(dir: string): { user: string } {
  const user = path.join(dir, "user_settings.json");
  return { user };
}

test("settings precedence: env > project > user > default", () => {
  const dir = makeProject("ws_settings_priority");
  const { user } = settingsFiles(dir);
  withEnv(
    {
      CUTHOL_WORKERS: undefined,
      CUTHOL_SETTINGS_FILE: user,
      CUTHOL_PROJECT_DIR: dir,
      CUTHOL_LIVE_ACTOR: "agent",
    },
    () => {
      assert.deepEqual(resolveSetting(dir, "render.workers"), { value: "auto", source: "default", set_by: null });
      setSetting(dir, "render.workers", 4);
      assert.deepEqual(resolveSetting(dir, "render.workers"), { value: 4, source: "user", set_by: "agent" });
      process.env.CUTHOL_WORKERS = "7";
      assert.deepEqual(resolveSetting(dir, "render.workers"), { value: 7, source: "env", set_by: null });
    }
  );
});

test("settings set_by: agent CLI vs human actor; live_mode has no badge", () => {
  const dir = makeProject("ws_settings_setby");
  const { user } = settingsFiles(dir);
  withEnv({ CUTHOL_SETTINGS_FILE: user, CUTHOL_PROJECT_DIR: dir, CUTHOL_LIVE_ACTOR: "agent", CUTHOL_WORKERS: undefined }, () => {
    setSetting(dir, "render.workers", 2);
    const raw = JSON.parse(fs.readFileSync(user, "utf8")) as Record<string, { set_by: string }>;
    assert.equal(raw["render.workers"].set_by, "agent");
    process.env.CUTHOL_LIVE_ACTOR = "human";
    setSetting(dir, "render.workers", 3);
    const raw2 = JSON.parse(fs.readFileSync(user, "utf8")) as Record<string, { set_by: string }>;
    assert.equal(raw2["render.workers"].set_by, "human");
    const listed = listSettings(dir).find((s) => s.key === "live.mode")!;
    setSetting(dir, "live.mode", "on", "agent");
    const listed2 = listSettings(dir).find((s) => s.key === "live.mode")!;
    assert.equal(listed2.set_by, "agent");
    assert.equal(listed.source, "default");
  });
});

test("settings validation: G620 unknown key, G621 bad value, G622 window-only, G624 env lock", () => {
  const dir = makeProject("ws_settings_diags");
  const { user } = settingsFiles(dir);
  withEnv({ CUTHOL_SETTINGS_FILE: user, CUTHOL_PROJECT_DIR: dir, CUTHOL_LIVE_ACTOR: "agent", CUTHOL_WORKERS: undefined }, () => {
    assert.throws(() => setSetting(dir, "render.nope", 1), (e: unknown) =>
      String((e as { diagnostic?: { code?: string } }).diagnostic?.code).includes("G620")
    );
    assert.throws(() => setSetting(dir, "render.workers", 99), (e: unknown) =>
      String((e as { diagnostic?: { code?: string } }).diagnostic?.code).includes("G621")
    );
    assert.throws(() => setSetting(dir, "render.workers", "bogus"), /G621/);
    assert.throws(() => setSetting(dir, "live.shortcuts", { "play-pause": "KeyP" }, "agent"), /G622/);
    // Window (human actor) may write shortcuts.
    const r = setSetting(dir, "live.shortcuts", { "play-pause": "KeyP" }, "human");
    assert.equal((r.value as Record<string, string>)["play-pause"], "KeyP");
    // Env-locked keys are refused at the command layer (G624); resolution shows env wins.
    process.env.CUTHOL_WORKERS = "7";
    assert.equal(resolveSetting(dir, "render.workers").source, "env");
    assert.throws(
      () =>
        runSettingsCommand({
          group: "settings",
          action: "set",
          rest: ["render.workers", "4"],
          flags: {},
          workspaceDir: dir,
          formatFlag: "json",
        }),
      /G624/
    );
  });
  assert.equal(displaySettingValue("render.gpu", false), "off");
});

test("settings: CUTHOL_SETTINGS_FILE=0 disables the user file", () => {
  const dir = makeProject("ws_settings_disabled");
  withEnv({ CUTHOL_SETTINGS_FILE: "0", CUTHOL_PROJECT_DIR: dir, CUTHOL_WORKERS: undefined }, () => {
    assert.deepEqual(resolveSetting(dir, "render.workers"), { value: "auto", source: "default", set_by: null });
    assert.throws(() => setSetting(dir, "render.workers", 4), /G623/);
    assert.deepEqual(listSettings(dir).length, 10);
  });
});

test("settings: legacy live_mode file still reads; setLiveConfig migrates to live.mode", () => {
  const dir = makeProject("ws_settings_legacy");
  const { user } = settingsFiles(dir);
  withEnv({ CUTHOL_LIVE: undefined, CUTHOL_SETTINGS_FILE: user, CUTHOL_PROJECT_DIR: dir }, () => {
    fs.writeFileSync(user, JSON.stringify({ live_mode: "on" }));
    assert.deepEqual(resolveLiveConfig(dir), { mode: "on", source: "user" });
    assert.deepEqual(resolveSetting(dir, "live.mode"), { value: "on", source: "user", set_by: "human" });
    setLiveConfig(dir, "off", "user");
    const raw = JSON.parse(fs.readFileSync(user, "utf8")) as Record<string, unknown>;
    assert.ok("live.mode" in raw);
    assert.deepEqual(resolveLiveConfig(dir), { mode: "off", source: "user" });
  });
});

test("settings effect: workers/encoder/stall/cache resolvers read the layer; output_dir moves render output", () => {
  const dir = makeProject("ws_settings_effect");
  const { user } = settingsFiles(dir);
  withEnv(
    {
      CUTHOL_WORKERS: undefined,
      CUTHOL_OVERLAY_CONCURRENCY: undefined,
      CUTHOL_ENCODER: undefined,
      CUTHOL_DISABLE_GPU: undefined,
      CUTHOL_STALL_TIMEOUT_SEC: undefined,
      CUTHOL_CACHE_DIR: undefined,
      CUTHOL_SETTINGS_FILE: user,
      CUTHOL_PROJECT_DIR: dir,
      CUTHOL_LIVE_ACTOR: "agent",
    },
    () => {
      setSetting(dir, "render.workers", 4);
      assert.equal(resolveHyperFramesWorkers(), 4);
      setSetting(dir, "render.overlay_concurrency", 3);
      assert.equal(resolveOverlayConcurrency({ coldOverlayCount: 99 }), 3);
      setSetting(dir, "render.encoder", "x264");
      assert.equal(resolveVideoEncoderPreference(), "libx264");
      setSetting(dir, "render.gpu", false);
      assert.equal(resolveVideoEncoderPreference("nvenc"), "libx264");
      setSetting(dir, "render.stall_timeout_sec", 60);
      assert.equal(resolveStallWatchdogConfig().stallTimeoutMs, 60_000);
      const cacheDir = path.join(dir, "my-cache");
      setSetting(dir, "cache.dir", cacheDir);
      assert.equal(resolveSharedCacheConfig().cacheDir, cacheDir);
      // Env still wins over the layer.
      process.env.CUTHOL_WORKERS = "7";
      assert.equal(resolveHyperFramesWorkers(), 7);
      delete process.env.CUTHOL_WORKERS;
      // render.output_dir is project-scoped and moves the default output path.
      setSetting(dir, "render.output_dir", "renders");
      assert.equal(resolveRenderOutputDir(dir), path.join(dir, "renders"));
      assert.ok(resolveSetting(dir, "render.output_dir").source === "project");
      resetSetting(dir, "render.output_dir");
      assert.equal(resolveRenderOutputDir(dir), path.join(dir, "output"));
    }
  );
});
