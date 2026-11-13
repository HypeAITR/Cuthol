// Live settings API: GET/POST /api/settings, human inbox line, agent badge.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initWorkspace } from "../core/workspace.js";
import { setSetting } from "../core/settings.js";
import { drainLiveInbox, formatLiveNoteLines, peekLiveInbox } from "../live/live_inbox.js";
import { encoderForGpuName, routeLiveSettingsRequest } from "../live/live_settings_api.js";

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

interface FakeRes {
  status: number;
  body: unknown;
  writeHead(code: number): FakeRes;
  end(payload: string): void;
}

function fakeReq(method: string, body: unknown): unknown {
  const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
  return {
    method,
    on(ev: string, fn: (arg?: unknown) => void) {
      (handlers[ev] ??= []).push(fn);
      if (ev === "end") {
        setImmediate(() => {
          for (const d of handlers.data ?? []) d(Buffer.from(JSON.stringify(body)));
          for (const e of handlers.end ?? []) e();
        });
      }
      return this;
    },
  };
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    status: 0,
    body: null,
    writeHead(code: number) {
      res.status = code;
      return res;
    },
    end(payload: string) {
      res.body = JSON.parse(payload);
    },
  };
  return res;
}

async function callApi(
  dir: string,
  method: string,
  body: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = fakeRes();
  const handled = await routeLiveSettingsRequest(dir, fakeReq(method, body) as never, res as never);
  assert.equal(handled, true);
  return { status: res.status, body: res.body as Record<string, unknown> };
}

test("settings window: GET returns the full view; POST writes as human and queues the inbox line", async () => {
  const dir = makeProject("ws_live_settings_api");
  const user = path.join(dir, "user_settings.json");
  await withEnvAsync({ CUTHOL_SETTINGS_FILE: user, CUTHOL_PROJECT_DIR: dir, CUTHOL_LIVE_ACTOR: "agent" }, async () => {
    // Agent sets a value through the CLI path first.
    setSetting(dir, "render.workers", 2, "agent");

    const got = await callApi(dir, "GET", null);
    assert.equal(got.status, 200);
    const settings = got.body.settings as Array<Record<string, unknown>>;
    const workers = settings.find((s) => s.key === "render.workers")!;
    assert.equal(workers.value, 2);
    assert.equal(workers.set_by, "agent");
    assert.equal(workers.agent_badge, true);
    const mode = settings.find((s) => s.key === "live.mode")!;
    assert.equal(mode.agent_badge, false);

    // The window changes it: stored as human, queued for the agent.
    const posted = await callApi(dir, "POST", { key: "render.workers", value: 4 });
    assert.equal(posted.status, 200);
    const after = (posted.body.settings as Array<Record<string, unknown>>).find((s) => s.key === "render.workers")!;
    assert.equal(after.value, 4);
    assert.equal(after.set_by, "human");

    const packets = peekLiveInbox(dir);
    assert.equal(packets.length, 1);
    assert.equal(packets[0].setting?.key, "render.workers");
    assert.deepEqual(formatLiveNoteLines(packets), ["human changed setting render.workers: 2 → 4"]);
    const drained = drainLiveInbox(dir);
    assert.ok(drained && drained.lines.some((l) => l.includes("human changed setting render.workers")));
  });
});

test("settings window: invalid value rejected inline; env-locked key refused", async () => {
  const dir = makeProject("ws_live_settings_errors");
  const user = path.join(dir, "user_settings.json");
  await withEnvAsync({ CUTHOL_SETTINGS_FILE: user, CUTHOL_PROJECT_DIR: dir }, async () => {
    const bad = await callApi(dir, "POST", { key: "render.workers", value: 99 });
    assert.equal(bad.status, 400);
    assert.ok(JSON.stringify(bad.body).includes("G621"));
    const unknown = await callApi(dir, "POST", { key: "render.nope", value: 1 });
    assert.equal(unknown.status, 400);
    assert.ok(JSON.stringify(unknown.body).includes("G620"));
    process.env.CUTHOL_WORKERS = "7";
    try {
      const locked = await callApi(dir, "POST", { key: "render.workers", value: 4 });
      assert.equal(locked.status, 409);
      assert.ok(JSON.stringify(locked.body).includes("G624"));
    } finally {
      delete process.env.CUTHOL_WORKERS;
    }
  });
});

function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("settings window: shortcut, window-mode and unchanged saves never reach the agent", async () => {
  const dir = makeProject("ws_live_settings_quiet");
  const user = path.join(dir, "user_settings.json");
  await withEnvAsync({ CUTHOL_SETTINGS_FILE: user, CUTHOL_PROJECT_DIR: dir }, async () => {
    const view = await callApi(dir, "GET", null);
    const shortcuts = (view.body.settings as Array<Record<string, unknown>>).find((s) => s.key === "live.shortcuts")!;
    const changed = { ...(shortcuts.value as Record<string, string>), "step-back-10": "KeyL" };
    assert.equal((await callApi(dir, "POST", { key: "live.shortcuts", value: changed })).status, 200);
    assert.equal((await callApi(dir, "POST", { key: "live.shortcuts", value: changed })).status, 200);
    assert.equal((await callApi(dir, "POST", { key: "live.shortcuts", reset: true })).status, 200);
    assert.equal((await callApi(dir, "POST", { key: "live.mode", value: "on" })).status, 200);
    assert.equal((await callApi(dir, "POST", { key: "render.workers", value: 3 })).status, 200);
    assert.equal((await callApi(dir, "POST", { key: "render.workers", value: 3 })).status, 200);
    assert.deepEqual(formatLiveNoteLines(peekLiveInbox(dir)), [
      `human changed setting render.workers: ${(view.body.settings as Array<Record<string, unknown>>).find((s) => s.key === "render.workers")!.display} → 3`,
    ]);
  });
});

test("settings window: live.browser is a window preference (auto or a browser id), never sent to the agent", async () => {
  const dir = makeProject("ws_live_settings_browser");
  const user = path.join(dir, "user_settings.json");
  await withEnvAsync({ CUTHOL_SETTINGS_FILE: user, CUTHOL_PROJECT_DIR: dir }, async () => {
    const view = await callApi(dir, "GET", null);
    const meta = (view.body.settings as Array<Record<string, any>>).find((s) => s.key === "live.browser")!.meta;
    assert.equal(meta.options[0], "auto");
    assert.ok(String(meta.hint).startsWith("Normally your default browser is used"));
    const bad = await callApi(dir, "POST", { key: "live.browser", value: "not a browser!" });
    assert.equal(bad.status, 400);
    const ok = await callApi(dir, "POST", { key: "live.browser", value: "chrome" });
    assert.equal(ok.status, 200);
    const entry = (ok.body.settings as Array<Record<string, unknown>>).find((s) => s.key === "live.browser")!;
    assert.equal(entry.value, "chrome");
    assert.equal(peekLiveInbox(dir).length, 0);
  });
});

test("settings window: hardware acceleration comes first; off locks the card list to CPU", async () => {
  const dir = makeProject("ws_live_settings_gpu");
  const user = path.join(dir, "user_settings.json");
  await withEnvAsync({ CUTHOL_SETTINGS_FILE: user, CUTHOL_PROJECT_DIR: dir, CUTHOL_DISABLE_GPU: undefined }, async () => {
    const on = await callApi(dir, "GET", null);
    const keysOn = (on.body.settings as Array<Record<string, any>>).map((s) => s.key);
    assert.ok(keysOn.indexOf("render.gpu") < keysOn.indexOf("render.encoder"));
    const encOn = (on.body.settings as Array<Record<string, any>>).find((s) => s.key === "render.encoder")!;
    assert.equal(encOn.meta.label, "Graphics card");
    assert.equal(encOn.meta.options[0], "auto");
    assert.notEqual(encOn.meta.locked, true);
    const off = await callApi(dir, "POST", { key: "render.gpu", value: false });
    assert.equal(off.status, 200);
    const encOff = (off.body.settings as Array<Record<string, any>>).find((s) => s.key === "render.encoder")!;
    assert.equal(encOff.meta.locked, true);
    assert.deepEqual(encOff.meta.options, ["x264"]);
    assert.equal(encOff.meta.option_labels.x264, "CPU");
  });
});

test("settings window: graphics card names map to encoders by vendor", () => {
  assert.equal(encoderForGpuName("NVIDIA GeForce GTX 1650", "win32"), "nvenc");
  assert.equal(encoderForGpuName("AMD Radeon(TM) Graphics", "win32"), "amf");
  assert.equal(encoderForGpuName("Intel(R) UHD Graphics 630", "win32"), "qsv");
  assert.equal(encoderForGpuName("Intel(R) UHD Graphics 630", "linux"), "vaapi");
  assert.equal(encoderForGpuName("Microsoft Basic Display Adapter", "win32"), null);
});
