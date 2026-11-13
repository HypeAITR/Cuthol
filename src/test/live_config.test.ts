// Live config + render progress + ETA + MCP surface.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { commitSequenceMutation, initWorkspace, loadSequence, stepJournal } from "../core/workspace.js";
import { progressBegin, progressFinish, progressSet, progressStop } from "../core/progress.js";
import { resolveLiveConfig, setLiveConfig } from "../live/live_config.js";
import {
  beginLiveRender,
  estimateEtaSec,
  failLiveRender,
  finishLiveRender,
  liveRenderActive,
  loadRenderHistory,
  predictStageShares,
  predictTotalSec,
} from "../live/live_progress.js";
import { resolveLivePaths } from "../live/live_paths.js";
import type { LiveProgress } from "../live/live_types.js";
import { buildCliArgv, findActionSpec, validateActionArgs } from "../mcp/catalog.js";
import { verifySequence } from "../verify/gates.js";

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

test("live config priority: env > project > user > default, invalid values skipped", () => {
  const dir = makeProject("ws_live_config_priority");
  const settingsFile = path.join(dir, "user_settings.json");
  withEnv({ CUTHOL_LIVE: undefined, CUTHOL_SETTINGS_FILE: settingsFile }, () => {
    assert.deepEqual(resolveLiveConfig(dir), { mode: "ask", source: "default" });

    fs.writeFileSync(settingsFile, JSON.stringify({ live_mode: "on" }));
    assert.deepEqual(resolveLiveConfig(dir), { mode: "on", source: "user" });

    setLiveConfig(dir, "off", "project");
    assert.deepEqual(resolveLiveConfig(dir), { mode: "off", source: "project" });

    process.env.CUTHOL_LIVE = "on";
    assert.deepEqual(resolveLiveConfig(dir), { mode: "on", source: "env" });

    // Invalid values fall through to the next source instead of breaking.
    process.env.CUTHOL_LIVE = "bogus";
    assert.deepEqual(resolveLiveConfig(dir), { mode: "off", source: "project" });
    commitSequenceMutation(dir, "test.corrupt-live-mode", (seq) => {
      seq.review = { ...(seq.review ?? {}), live_mode: "bogus" as "on" };
    });
    assert.deepEqual(resolveLiveConfig(dir), { mode: "on", source: "user" });
    fs.writeFileSync(settingsFile, JSON.stringify({ live_mode: "bogus" }));
    assert.deepEqual(resolveLiveConfig(dir), { mode: "ask", source: "default" });
  });
});

test("live config: project scope is journaled and undoable, user scope is atomic", () => {
  const dir = makeProject("ws_live_config_undo");
  const settingsFile = path.join(dir, "user_settings.json");
  withEnv({ CUTHOL_LIVE: undefined, CUTHOL_SETTINGS_FILE: settingsFile }, () => {
    const before = loadSequence(dir).sequence.meta.revision;
    const resolved = setLiveConfig(dir, "on", "project");
    assert.deepEqual(resolved, { mode: "on", source: "project" });
    assert.equal(loadSequence(dir).sequence.meta.revision, before + 1);
    assert.equal(loadSequence(dir).sequence.review?.live_mode, "on");

    stepJournal(dir, "undo", 1);
    assert.equal(loadSequence(dir).sequence.review?.live_mode, undefined);
    assert.deepEqual(resolveLiveConfig(dir), { mode: "ask", source: "default" });

    // User scope preserves other keys and survives a corrupt file.
    // The new `live.mode` record is written alongside the legacy key.
    fs.writeFileSync(settingsFile, JSON.stringify({ other: 1 }));
    assert.deepEqual(setLiveConfig(dir, "off", "user"), { mode: "off", source: "user" });
    const dual = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    assert.equal(dual.other, 1);
    assert.equal(dual.live_mode, "off");
    assert.deepEqual((dual["live.mode"] as { value: string }).value, "off");
    fs.writeFileSync(settingsFile, "{not json");
    assert.deepEqual(setLiveConfig(dir, "on", "user"), { mode: "on", source: "user" });
    const fresh = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    assert.equal(fresh.live_mode, "on");
    assert.deepEqual((fresh["live.mode"] as { value: string }).value, "on");

    // Invalid mode is refused with G613.
    assert.throws(() => setLiveConfig(dir, "bogus" as "on", "project"), (e: unknown) => {
      assert.match(String(e), /CUTHOL-G613/);
      return true;
    });
  });
});

test("live config: G1 ignores review.live_mode", () => {
  const dir = makeProject("ws_live_config_g1");
  withEnv({ CUTHOL_LIVE: undefined }, () => {
    setLiveConfig(dir, "off", "project");
    const { sequence, paths } = loadSequence(dir);
    const report = verifySequence(sequence, paths, ["G1_SCHEMA"]);
    assert.equal(
      report.diagnostics.filter((d) => d.severity === "ERROR").length,
      0,
      JSON.stringify(report.diagnostics)
    );
  });
});

test("live progress file format with fake stages", async () => {
  const dir = makeProject("ws_live_progress_format");
  const historyFile = path.join(dir, "render_history.json");
  withEnv({ CUTHOL_LIVE_HISTORY_FILE: historyFile, CUTHOL_LIVE_PROGRESS: undefined }, () => {
    const progressFile = resolveLivePaths(dir).progressFile;
    assert.equal(fs.existsSync(progressFile), false);
    try {
      beginLiveRender({
        projectDir: dir,
        preset: "draft_480p",
        frames: 600,
        comps: 0,
        footageSec: 20,
        expectOverlay: false,
        encoder: "libx264",
        workers: 4,
        output: "out.mp4",
      });
      assert.equal(liveRenderActive(), true);
      const started = JSON.parse(fs.readFileSync(progressFile, "utf8")) as LiveProgress;
      assert.equal(started.schema, "cuthol.live/1");
      assert.equal(started.kind, "render");
      assert.equal(started.state, "running");
      assert.equal(started.preset, "draft_480p");
      assert.equal(started.encoder, "libx264");
      assert.equal(started.workers, 4);
      assert.equal(started.output, "out.mp4");
      assert.deepEqual(
        started.stages.map((s) => s.name),
        ["encode", "blank scan", "edge scan", "audio health"]
      );
      assert.ok(started.stages.every((s) => s.state === "queued" && s.done === 0));

      progressBegin("encode", 100);
      progressSet(50);
      // A throttled write lands after the 500 ms window: fraction and ETA move.
      const t0 = Date.now();
      while (Date.now() - t0 < 600) {
        // Busy-wait: wall-clock throttle, keeps the test deterministic.
      }
      progressSet(51);
      const mid = JSON.parse(fs.readFileSync(progressFile, "utf8")) as LiveProgress;
      const encode = mid.stages.find((s) => s.name === "encode")!;
      assert.equal(encode.state, "running");
      assert.equal(encode.done, 51);
      assert.equal(encode.total, 100);
      assert.ok(mid.fraction > 0 && mid.fraction < 1, `fraction ${mid.fraction}`);
      assert.ok(mid.elapsed_sec >= 0);
      assert.ok(mid.eta_sec === null || mid.eta_sec >= 0);

      progressFinish("encode");
      progressStop();
      finishLiveRender(["G502"]);
      assert.equal(liveRenderActive(), false);
      const done = JSON.parse(fs.readFileSync(progressFile, "utf8")) as LiveProgress;
      assert.equal(done.state, "done");
      assert.equal(done.fraction, 1);
      assert.equal(done.eta_sec, 0);
      assert.deepEqual(done.findings, ["G502"]);
      assert.ok(done.stages.every((s) => s.state === "done"));

      // History recorded the run for future ETAs.
      const history = loadRenderHistory();
      assert.equal(history.length, 1);
      assert.equal(history[0].preset, "draft_480p");
      assert.equal(history[0].frames, 600);
      assert.ok(history[0].total_sec > 0);
    } finally {
      failLiveRender();
    }
  });
});

test("live progress: overlay expected stages and failed state", () => {
  const dir = makeProject("ws_live_progress_failed");
  const historyFile = path.join(dir, "render_history.json");
  withEnv({ CUTHOL_LIVE_HISTORY_FILE: historyFile, CUTHOL_LIVE_PROGRESS: undefined }, () => {
    try {
      beginLiveRender({
        projectDir: dir,
        preset: "master_1080p",
        frames: 100,
        comps: 2,
        footageSec: 4,
        expectOverlay: true,
      });
      progressBegin("overlay", 2);
      progressFinish("overlay");
      progressStop();
      failLiveRender();
      const progress = JSON.parse(fs.readFileSync(resolveLivePaths(dir).progressFile, "utf8")) as LiveProgress;
      assert.equal(progress.state, "failed");
      assert.ok(progress.stages.some((s) => s.name === "overlay" && s.state === "done"));
      assert.equal(progress.findings, undefined);
      // Failed runs do not pollute the history.
      assert.deepEqual(loadRenderHistory(), []);
    } finally {
      failLiveRender();
    }
  });
});

test("ETA model: EMA speeds, shares and history scaling", () => {
  // Running stage from speed, queued stages from shares of the predicted total.
  assert.equal(
    estimateEtaSec({
      stages: [
        { name: "encode", done: 50, total: 100, state: "running" },
        { name: "blank scan", done: 0, total: 100, state: "queued" },
      ],
      shares: { encode: 0.8, "blank scan": 0.2 },
      speeds: { encode: 25 },
      predictedTotalSec: 100,
    }),
    2 + 20
  );
  // No speed yet: the running stage also falls back to its share, scaled by
  // the unfinished fraction (0.5 * 60 * 0.9 = 27).
  assert.equal(
    estimateEtaSec({
      stages: [{ name: "encode", done: 10, total: 100, state: "running" }],
      shares: { encode: 0.5 },
      speeds: {},
      predictedTotalSec: 60,
    }),
    27
  );
  // A young stage ignores its noisy speed and uses the share estimate.
  assert.equal(
    estimateEtaSec({
      stages: [{ name: "encode", done: 74, total: 1620, state: "running", elapsedSec: 2 }],
      shares: { encode: 0.4 },
      speeds: { encode: 20 },
      predictedTotalSec: 100,
    }),
    38
  );
  // Past warmup the measured speed wins: (1620-772)/150 = 5.65 -> 6.
  assert.equal(
    estimateEtaSec({
      stages: [{ name: "encode", done: 772, total: 1620, state: "running", elapsedSec: 8 }],
      shares: { encode: 0.4 },
      speeds: { encode: 150 },
      predictedTotalSec: 100,
    }),
    6
  );
  // Nothing known: null (the window shows a dash).
  assert.equal(
    estimateEtaSec({
      stages: [{ name: "encode", done: 0, total: 100, state: "running" }],
      shares: {},
      speeds: {},
      predictedTotalSec: null,
    }),
    null
  );
  // Finished stages contribute nothing.
  assert.equal(
    estimateEtaSec({
      stages: [{ name: "encode", done: 100, total: 100, state: "done" }],
      shares: { encode: 1 },
      speeds: {},
      predictedTotalSec: 60,
    }),
    null
  );

  // History: same-preset medians, frame scaling, empty history.
  const dir = path.join(TEST_ROOT, "ws_live_eta_history");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const historyFile = path.join(dir, "render_history.json");
  withEnv({ CUTHOL_LIVE_HISTORY_FILE: historyFile }, () => {
    assert.equal(predictTotalSec("draft_480p", 600, 0), null);
    const fallback = predictStageShares("draft_480p", ["encode", "blank scan"]);
    assert.ok(Math.abs(fallback.encode + fallback["blank scan"] - 1) < 1e-9);

    fs.writeFileSync(
      historyFile,
      JSON.stringify([
        { at: "2026-01-01T00:00:00.000Z", preset: "draft_480p", frames: 300, comps: 0, total_sec: 60, stages: { encode: 48, "blank scan": 12 } },
        { at: "2026-01-02T00:00:00.000Z", preset: "draft_480p", frames: 300, comps: 0, total_sec: 80, stages: { encode: 60, "blank scan": 20 } },
        { at: "2026-01-03T00:00:00.000Z", preset: "master_1080p", frames: 300, comps: 0, total_sec: 600, stages: { encode: 590 } },
      ])
    );
    const shares = predictStageShares("draft_480p", ["encode", "blank scan"]);
    assert.ok(Math.abs(shares.encode - 0.775) < 1e-9, JSON.stringify(shares));
    assert.ok(Math.abs(shares["blank scan"] - 0.225) < 1e-9, JSON.stringify(shares));
    // Double the frames of the median 70 s run.
    assert.equal(predictTotalSec("draft_480p", 600, 0), 140);
    // Other presets are used when the preset has no history.
    assert.equal(predictTotalSec("audio_only" as "draft_480p", 300, 0), 80);
  });
});

test("MCP catalog: live actions and CLI argv translation", () => {
  for (const action of ["live_open", "live_status", "live_wait", "live_config"]) {
    assert.ok(findActionSpec("workspace", action), `workspace.${action} registered`);
  }
  const config = findActionSpec("workspace", "live_config")!;
  assert.deepEqual(
    config.params.map((p) => p.name),
    ["mode", "global"]
  );
  const wait = findActionSpec("workspace", "live_wait")!;
  assert.deepEqual(
    wait.params.map((p) => p.name),
    ["timeout"]
  );

  const ok = validateActionArgs(config, { mode: "on", global: true });
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.values, { mode: "on", global: true });
  const bad = validateActionArgs(config, { mode: "sometimes" });
  assert.equal(bad.issues.length, 1);
  assert.equal(bad.issues[0].kind, "bad_enum");

  assert.deepEqual(buildCliArgv(config, { mode: "off", global: true }, "/proj"), [
    "live",
    "config",
    "--mode=off",
    "--global=true",
    "--dir=/proj",
  ]);
  assert.deepEqual(buildCliArgv(wait, { timeout: 60 }, "/proj"), ["live", "wait", "--timeout=60", "--dir=/proj"]);
  const open = findActionSpec("workspace", "live_open")!;
  assert.deepEqual(buildCliArgv(open, {}, "/proj"), ["live", "open", "--dir=/proj"]);
});
