/**
 * Live server and state (`src/test/live_state_sync.test.ts`).
 * Revision classification (redo vs pruned-branch commit), revision-bound actor
 * evidence, activity summaries, content-keyed scene thumbnails, render failure
 * data + ETA sanity, notes validation, human-edit guards, client delta merge.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { progressBegin, progressStop, setProgressHook } from "../core/progress.js";
import { commitSequenceMutation, initWorkspace, loadJournalManifest, loadSequence, stepJournal } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { handleLiveEdit } from "../live/live_edit_api.js";
import { resolveRevisionActor } from "../live/live_lock.js";
import { handleLiveNotesPost } from "../live/live_notes_api.js";
import { resolveLivePaths } from "../live/live_paths.js";
import {
  beginLiveRender,
  estimateEtaSec,
  failLiveRender,
  predictTotalSec,
} from "../live/live_progress.js";
import { ensureLiveServer, stopLiveServer } from "../live/live_server.js";
import { buildScenes, classifyCursorMove, shortOperation, summarizeRevision } from "../live/live_state.js";
import { LIVE_ACTOR_ENV, LIVE_SCHEMA, type LiveDelta, type LiveProgress, type LiveSnapshot } from "../live/live_types.js";
import { appendSpineClip, trimSpineClip } from "../sequence/spine.js";
// @ts-ignore - plain JS UI module without types; resolved at runtime
import { applyDelta } from "../../src/live/ui/live_client.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-r1-"));
const WORKSPACES: string[] = [];

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function makeProject(name: string): string {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  initWorkspace({ dir, title: name, aspect: "16:9", fps: 30 });
  WORKSPACES.push(dir);
  return dir;
}

function ffmpegTone(outPath: string, seconds: number): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=0x4488FF:s=160x160:r=30:d=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", outPath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

/** Workspace with one ingested clip on the spine. */
function makeMediaProject(name: string): { dir: string; media: string } {
  const dir = makeProject(name);
  const media = path.join(ROOT, `${name}.mp4`);
  if (!fs.existsSync(media)) ffmpegTone(media, 4);
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: dir, filePaths: [media] });
  appendSpineClip({ workspaceDir: dir, assetHandle: item.handle });
  return { dir, media };
}

function cursorOf(dir: string): number {
  return loadJournalManifest(loadSequence(dir).paths).cursor_revision;
}

function takeHumanLock(dir: string): void {
  const lp = resolveLivePaths(dir);
  fs.mkdirSync(lp.dir, { recursive: true });
  fs.writeFileSync(
    lp.lockFile,
    JSON.stringify({ schema: LIVE_SCHEMA, holder: "human", since: new Date().toISOString(), revision: cursorOf(dir), server_pid: process.pid })
  );
}

function httpRequest(
  port: number,
  reqPath: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => {
          body += c.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

interface SseEvent {
  name: string;
  data: string;
}

function openSse(port: number, token: string): { events: SseEvent[]; ready: Promise<LiveSnapshot>; stop: () => void } {
  const events: SseEvent[] = [];
  let snapshotResolve: (s: LiveSnapshot) => void = () => {};
  const ready = new Promise<LiveSnapshot>((r) => {
    snapshotResolve = r;
  });
  let snapshotDone = false;
  const req = http.get({ host: "127.0.0.1", port, path: `/events?t=${token}` }, (res) => {
    let buf = "";
    res.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (raw.startsWith(":")) continue;
        const m = /^event: (\S+)\ndata: ([\s\S]*)$/.exec(raw);
        if (!m) continue;
        events.push({ name: m[1], data: m[2] });
        if (m[1] === "snapshot" && !snapshotDone) {
          snapshotDone = true;
          snapshotResolve(JSON.parse(m[2]) as LiveSnapshot);
        }
      }
    });
  });
  return { events, ready, stop: () => req.destroy() };
}

async function waitFor<T>(fn: () => T | null, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test.after(async () => {
  for (const dir of WORKSPACES) {
    try {
      await stopLiveServer(dir);
    } catch {
      // best effort
    }
  }
});

// --- G1: revision classification -------------------------------------------

test("classifyCursorMove: commit, redo, pruned-branch commit, undo, in-place", () => {
  const entries = [
    { revision: 1, operation: "workspace.init", timestamp: "2026-01-01T00:00:00.000Z" },
    { revision: 2, operation: "spine.trim(sp_01)", timestamp: "2026-01-01T00:00:01.000Z" },
  ];
  const known = new Map([
    [1, { operation: "workspace.init", timestamp: "2026-01-01T00:00:00.000Z" }],
  ]);
  // New commit past the known head uses the journal entry.
  assert.deepEqual(
    classifyCursorMove({ fromRevision: 1, cursor: 2, entries, known }).operation,
    "spine.trim(sp_01)"
  );
  // Undo then redo of the unchanged entry is a redo.
  const known2 = new Map([
    [1, { operation: "workspace.init", timestamp: "2026-01-01T00:00:00.000Z" }],
    [2, { operation: "spine.trim(sp_01)", timestamp: "2026-01-01T00:00:01.000Z" }],
  ]);
  assert.equal(classifyCursorMove({ fromRevision: 1, cursor: 2, entries, known: known2 }).operation, "journal.redo");
  // Undo then a NEW commit reuses the revision number with a replaced entry:
  // same number, new content — a commit, not a redo.
  const pruned = [
    { revision: 1, operation: "workspace.init", timestamp: "2026-01-01T00:00:00.000Z" },
    { revision: 2, operation: "spine.split(sp_01)", timestamp: "2026-01-01T00:00:05.000Z" },
  ];
  const prunedMove = classifyCursorMove({ fromRevision: 1, cursor: 2, entries: pruned, known: known2 });
  assert.equal(prunedMove.operation, "spine.split(sp_01)");
  assert.equal(prunedMove.timestamp, "2026-01-01T00:00:05.000Z");
  // Cursor down is an undo, no move an in-place update.
  assert.equal(classifyCursorMove({ fromRevision: 2, cursor: 1, entries, known: known2 }).operation, "journal.undo");
  assert.equal(classifyCursorMove({ fromRevision: 2, cursor: 2, entries, known: known2 }).operation, "sequence.update");
  // A move up with no entry at the cursor degrades to an update, never a redo.
  assert.equal(classifyCursorMove({ fromRevision: 2, cursor: 3, entries, known: known2 }).operation, "sequence.update");
});

test("server: undo then a new commit streams the real operation, not redo", async () => {
  const { dir } = makeMediaProject("r1_prune");
  const info = await ensureLiveServer(dir);
  const sse = openSse(info.port, info.token);
  try {
    const before = await Promise.race([
      sse.ready,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no snapshot")), 10000)),
    ]);
    const base = before.revision;
    trimSpineClip({ workspaceDir: dir, clipId: "sp_01", sourceOutMs: 3000 });
    await waitFor(() => sse.events.find((e) => e.name === "delta") ?? null, 10000, "trim delta");
    sse.events.length = 0;
    stepJournal(dir, "undo");
    const undo = await waitFor(
      () => {
        const ev = sse.events.find((e) => e.name === "delta");
        return ev ? (JSON.parse(ev.data) as LiveDelta) : null;
      },
      10000,
      "undo delta"
    );
    assert.equal(undo.entry.operation, "journal.undo");
    sse.events.length = 0;
    // New commit on the undone cursor: reuses the revision number, prunes the branch.
    trimSpineClip({ workspaceDir: dir, clipId: "sp_01", sourceOutMs: 2500 });
    const pruned = await waitFor(
      () => {
        const ev = sse.events.find((e) => e.name === "delta");
        return ev ? (JSON.parse(ev.data) as LiveDelta) : null;
      },
      10000,
      "pruned-branch delta"
    );
    assert.equal(pruned.from_revision, base);
    assert.equal(pruned.revision, base + 1);
    assert.match(pruned.entry.operation, /^spine\.trim/);
    assert.match(pruned.entry.summary, /^spine\.trim sp_01/);
    assert.equal(pruned.entry.actor, "agent");
  } finally {
    sse.stop();
    await stopLiveServer(dir);
  }
});

// --- G2: revision-bound actors ----------------------------------------------

test("actor: same operation seconds apart binds to its own revision", () => {
  const dir = makeProject("r1_actor");
  const op = "lane.update-cue(cue_04)";
  commitSequenceMutation(dir, op, (seq) => {
    seq.meta.title = "agent pass";
  });
  const agentRev = cursorOf(dir);
  withEnv({ [LIVE_ACTOR_ENV]: "human" }, () => {
    commitSequenceMutation(dir, op, (seq) => {
      seq.meta.title = "human pass";
    });
  });
  const humanRev = cursorOf(dir);
  assert.equal(humanRev, agentRev + 1);
  const manifest = loadJournalManifest(loadSequence(dir).paths);
  const agentEntry = manifest.entries.find((e) => e.revision === agentRev)!;
  const humanEntry = manifest.entries.find((e) => e.revision === humanRev)!;
  // Same operation, ~0 s apart: the agent revision stays agent.
  assert.equal(resolveRevisionActor(dir, agentEntry.operation, agentEntry.timestamp, agentRev), "agent");
  assert.equal(resolveRevisionActor(dir, humanEntry.operation, humanEntry.timestamp, humanRev), "human");
});

test("actor: human undo/redo moves match, agent moves without evidence do not", () => {
  const dir = makeProject("r1_actor_moves");
  commitSequenceMutation(dir, "spine.trim(sp_01)", (seq) => {
    seq.meta.title = "v2";
  });
  const head = cursorOf(dir);
  withEnv({ [LIVE_ACTOR_ENV]: "human" }, () => {
    stepJournal(dir, "undo");
  });
  assert.equal(cursorOf(dir), head - 1);
  const now = new Date().toISOString();
  assert.equal(resolveRevisionActor(dir, "journal.undo", now, head - 1, head), "human");
  withEnv({ [LIVE_ACTOR_ENV]: "human" }, () => {
    stepJournal(dir, "redo");
  });
  assert.equal(cursorOf(dir), head);
  assert.equal(resolveRevisionActor(dir, "journal.redo", new Date().toISOString(), head, head - 1), "human");
  // An agent move over a range the human never touched stays agent.
  assert.equal(resolveRevisionActor(dir, "journal.undo", new Date().toISOString(), head - 2, head - 1), "agent");
});

// --- G3: activity summaries --------------------------------------------------

test("summaries: lane.remove-cues shortens, title is not a caption", () => {
  assert.equal(shortOperation("lane.remove-cues(cue_27)"), "lane.remove");
  assert.equal(shortOperation("lane.remove-cue(cue_27)"), "lane.remove");
  const oldSeq = { spine: { clips: [] }, lanes: [{ id: "ln_titles", cues: [] }] };
  const titleCue = { id: "cue_02", kind: "title", typography: { text: "Q1 probe" }, at_ms: 2000, duration_ms: 3000 };
  const newSeq = { spine: { clips: [] }, lanes: [{ id: "ln_titles", cues: [titleCue] }] };
  const title = summarizeRevision(oldSeq, newSeq, "lane.add-cue(ln_titles)");
  assert.equal(title.summary, "lane.add cue_02 (title)");
  const captionCue = { ...titleCue, kind: "caption" };
  const capSeq = { spine: { clips: [] }, lanes: [{ id: "ln_titles", cues: [captionCue] }] };
  assert.equal(summarizeRevision(oldSeq, capSeq, "lane.add-cue(ln_titles)").summary, "lane.add cue_02 (caption)");
});

// --- G4: content-keyed thumbnails --------------------------------------------

function thumbSceneSeq() {
  return {
    spine: { clips: [{ id: "sp_01", timeline_in_ms: 0, duration_ms: 4000, asset_handle: "vid_01" }] },
    lanes: [],
    stage: { width: 1920, height: 1080 },
  };
}

test("scenes carry content-keyed thumb URLs, stable until the picture changes", () => {
  const a = thumbSceneSeq();
  const thumbA = buildScenes(a)[0].thumb!;
  assert.match(thumbA, /^\/api\/thumb\/sc_1\?k=[0-9a-f]{16}$/);
  assert.equal(buildScenes(thumbSceneSeq())[0].thumb, thumbA);
  const b = thumbSceneSeq();
  (b.spine.clips[0] as { duration_ms: number }).duration_ms = 3000;
  assert.notEqual(buildScenes(b)[0].thumb, thumbA);
  assert.match(buildScenes(a, "tok123")[0].thumb!, /^\/api\/thumb\/sc_1\?k=[0-9a-f]{16}&t=tok123$/);
});

test("server: snapshot thumb URLs load as-is, with no extra auth step", async () => {
  const { dir } = makeMediaProject("r1_thumb");
  const info = await ensureLiveServer(dir);
  const sse = openSse(info.port, info.token);
  try {
    const snap = await Promise.race([
      sse.ready,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no snapshot")), 10000)),
    ]);
    assert.ok(snap.scenes.length > 0);
    const thumb = snap.scenes[0].thumb ?? "";
    assert.match(thumb, /^\/api\/thumb\/sc_1\?k=[0-9a-f]{16}&t=[0-9a-f]+$/);
    // The window drops the URL into an <img> untouched: it must answer alone.
    const img = await httpRequest(info.port, thumb);
    assert.equal(img.status, 200);
    assert.match(img.headers["content-type"] ?? "", /image\/(jpeg|svg\+xml)/);
  } finally {
    sse.stop();
    await stopLiveServer(dir);
  }
});

test("server: missing media answers a placeholder, not a bare failure", { timeout: 120_000 }, async () => {
  const { dir, media } = makeMediaProject("r1_thumb_missing");
  fs.rmSync(media, { force: true });
  const info = await ensureLiveServer(dir);
  try {
    const res = await httpRequest(info.port, `/api/thumb/sc_1?t=${info.token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] ?? "", /svg/);
    assert.match(res.body, /Thumbnail unavailable/);
  } finally {
    await stopLiveServer(dir);
  }
});

// --- G5: failure data + ETA ---------------------------------------------------

test("ETA: a measured crawl overruns the share estimate by at most 3x", () => {
  // 99 units left at 0.01/s would read 9900 s uncapped; the clamp holds it at
  // 3 * 0.5 * 100 * 0.99 = 148.5 -> 149.
  assert.equal(
    estimateEtaSec({
      stages: [{ name: "encode", done: 1, total: 100, state: "running", elapsedSec: 10 }],
      shares: { encode: 0.5 },
      speeds: { encode: 0.01 },
      predictedTotalSec: 100,
    }),
    149
  );
  // A sane speed is untouched: (100-50)/25 = 2.
  assert.equal(
    estimateEtaSec({
      stages: [{ name: "encode", done: 50, total: 100, state: "running", elapsedSec: 10 }],
      shares: { encode: 0.5 },
      speeds: { encode: 25 },
      predictedTotalSec: 100,
    }),
    2
  );
});

test("history: frame scaling clamps across wildly different shapes", () => {
  const dir = makeProject("r1_eta_history");
  const historyFile = path.join(dir, "render_history.json");
  fs.writeFileSync(
    historyFile,
    JSON.stringify([
      { at: "2026-01-01T00:00:00.000Z", preset: "draft_480p", frames: 300, comps: 0, total_sec: 60, stages: { encode: 60 } },
    ])
  );
  withEnv({ CUTHOL_LIVE_HISTORY_FILE: historyFile }, () => {
    // 20x the frames would scale 60 s to 1200 s; the 5x clamp holds it at 300.
    assert.equal(predictTotalSec("draft_480p", 6000, 0), 300);
    // In-range scaling is untouched: 2x frames -> 120.
    assert.equal(predictTotalSec("draft_480p", 600, 0), 120);
  });
});

test("progress worker counts finished ffmpeg jobs by vanished files", async () => {
  // ffmpeg -progress files are deleted as soon as their job completes, usually
  // before the next 2 s sampler tick: a multi-segment encode used to sit at
  // 0/N until the stage ended. Files seen on one tick and gone on the next
  // count as finished jobs now.
  const seen: number[] = [];
  setProgressHook((ev) => {
    if (ev.type === "set" && ev.name === "encode") seen.push(ev.done);
  });
  const files = [1, 2].map((n) => path.join(os.tmpdir(), `cuthol_ffprog_${process.pid}_r1jobs_${n}.txt`));
  try {
    for (const f of files) fs.writeFileSync(f, "frame=10\nfps=30\nprogress=continue\n");
    progressBegin("encode", 2, { mode: "ffmpeg-jobs" });
    // Let one tick observe both files, then finish the jobs one at a time.
    await new Promise((r) => setTimeout(r, 2500));
    fs.rmSync(files[0], { force: true });
    await waitFor(() => (seen.some((d) => d >= 1) ? true : null), 10000, "first finished job");
    fs.rmSync(files[1], { force: true });
    await waitFor(() => (seen.some((d) => d >= 2) ? true : null), 10000, "second finished job");
    assert.ok(seen.every((d) => d <= 2), `done never exceeds the total: ${JSON.stringify(seen)}`);
  } finally {
    progressStop();
    setProgressHook(null);
    for (const f of files) fs.rmSync(f, { force: true });
  }
});

test("failLiveRender: running stages fail, the diagnostic rides the document", () => {
  const dir = makeProject("r1_fail");
  withEnv({ CUTHOL_LIVE_HISTORY_FILE: path.join(dir, "history.json"), CUTHOL_LIVE_PROGRESS: undefined }, () => {
    try {
      beginLiveRender({ projectDir: dir, preset: "draft_480p", frames: 100, comps: 1, footageSec: 4, expectOverlay: true });
      progressBegin("overlay", 1);
      failLiveRender({ code: "CUTHOL-G503", message: "overlay failed", suggestion: "retry" });
      const progress = JSON.parse(fs.readFileSync(resolveLivePaths(dir).progressFile, "utf8")) as LiveProgress;
      assert.equal(progress.state, "failed");
      assert.ok(progress.stages.some((s) => s.name === "overlay" && s.state === "failed"));
      assert.deepEqual(progress.error, { code: "CUTHOL-G503", message: "overlay failed", suggestion: "retry" });
      // Queued stages never ran: they stay queued, and history stays clean.
      assert.ok(progress.stages.some((s) => s.name === "encode" && s.state === "queued"));
      assert.equal(fs.existsSync(path.join(dir, "history.json")), false);
    } finally {
      progressStop();
      setProgressHook(null);
      failLiveRender();
    }
  });
});

// --- G9: notes validation ------------------------------------------------------

const ONE_PX_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function validNoteBody(n: number, text: string): Record<string, unknown> {
  return { n, text, at_ms: 1000, frame: 30, point: { x: 80, y: 40, nx: 0.5, ny: 0.25 }, elements: [] };
}

test("notes: textless notes are refused, over-limit cuts are counted", async () => {
  const dir = makeProject("r1_notes");
  const noop = () => {};
  await assert.rejects(handleLiveNotesPost(dir, { notes: [{ n: 1, at_ms: 0, frame: 0, point: { x: 1, y: 1 }, elements: [] }] }, 1, noop));
  await assert.rejects(handleLiveNotesPost(dir, { notes: [validNoteBody(1, "   ")] }, 1, noop));
  const many = Array.from({ length: 34 }, (_, i) => validNoteBody(i + 1, `note ${i + 1}`));
  const posted = await handleLiveNotesPost(dir, { notes: many, sheet_png_base64: ONE_PX_PNG }, 1, noop);
  assert.equal(posted.received, 34);
  assert.equal(posted.stored, 32);
  assert.equal(posted.dropped_over_limit, 2);
  assert.equal(posted.dropped_invalid, 0);
  const mixed = await handleLiveNotesPost(
    dir,
    { notes: [validNoteBody(1, "kept"), { n: 2, at_ms: 0, frame: 0, point: { x: 1, y: 1 }, elements: [] }], sheet_png_base64: ONE_PX_PNG },
    1,
    noop
  );
  assert.equal(mixed.stored, 1);
  assert.equal(mixed.dropped_invalid, 1);
});

test("server: over-limit notes answer counts, textless answers 400", async () => {
  const { dir } = makeMediaProject("r1_notes_api");
  const info = await ensureLiveServer(dir);
  try {
    const bad = await httpRequest(info.port, `/api/notes?t=${info.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: [{ n: 1, at_ms: 0, frame: 0, point: { x: 1, y: 1 }, elements: [] }] }),
    });
    assert.equal(bad.status, 400);
    const many = Array.from({ length: 34 }, (_, i) => validNoteBody(i + 1, `note ${i + 1}`));
    const res = await httpRequest(info.port, `/api/notes?t=${info.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: many, sheet_png_base64: ONE_PX_PNG }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), {
      ok: true,
      id: (JSON.parse(res.body) as { id: string }).id,
      received: 34,
      stored: 32,
      dropped_over_limit: 2,
      dropped_invalid: 0,
    });
  } finally {
    await stopLiveServer(dir);
  }
});

// --- G10: human-edit guards ------------------------------------------------------

test("edit: redo past the journal edge is a clean 409, not a raw failure", async () => {
  const dir = makeProject("r1_edge");
  takeHumanLock(dir);
  const cursor = cursorOf(dir);
  const redo = await handleLiveEdit(dir, { action: "redo", expect_rev: cursor });
  assert.equal(redo.status, 409);
  assert.equal(redo.json.code, "CUTHOL-G618");
  assert.match(String(redo.json.message), /nothing to redo/);
  assert.doesNotMatch(String(redo.json.message), /CUTHOL-SYS03/);
  const undo = await handleLiveEdit(dir, { action: "undo", expect_rev: cursor });
  assert.equal(undo.status, 409);
  assert.match(String(undo.json.message), /not one of your edits|nothing to undo/);
});

test("edit: lockless requests suggest the pause, not a timeline change", async () => {
  const dir = makeProject("r1_nolock");
  const out = await handleLiveEdit(dir, { action: "delete", target: "sp_01", expect_rev: cursorOf(dir) });
  assert.equal(out.status, 409);
  assert.equal(out.json.code, "CUTHOL-G618");
  assert.match(String(out.json.message), /Pause the agent first/);
  assert.doesNotMatch(String(out.json.message), /timeline changed/);
});

test("edit: mute/unmute round-trips on the real flag without envelopes", async () => {
  const { dir } = makeMediaProject("r1_mute");
  takeHumanLock(dir);
  const clipId = (loadSequence(dir).sequence as unknown as { spine: { clips: { id: string }[] } }).spine.clips[0].id;
  const muted = await handleLiveEdit(dir, { action: "mute", target: clipId, params: { muted: true }, expect_rev: cursorOf(dir) });
  assert.equal(muted.status, 200);
  const mid = (loadSequence(dir).sequence as unknown as { spine: { clips: { audio_chain: { muted: boolean }; envelopes: unknown[] }[] } }).spine.clips[0];
  assert.equal(mid.audio_chain.muted, true);
  assert.deepEqual(mid.envelopes ?? [], []);
  const unmuted = await handleLiveEdit(dir, { action: "mute", target: clipId, params: { muted: false }, expect_rev: cursorOf(dir) });
  assert.equal(unmuted.status, 200);
  const after = (loadSequence(dir).sequence as unknown as { spine: { clips: { audio_chain: { muted: boolean }; envelopes: unknown[] }[] } }).spine.clips[0];
  assert.equal(after.audio_chain.muted, false);
  assert.deepEqual(after.envelopes ?? [], []);
});

// --- client: delta merge ---------------------------------------------------------

function fakeStore() {
  const state: Record<string, unknown> = {
    revision: 45,
    sequence: { meta: { title: "old", revision: 45 }, stage: { backdrop: { color: "#000000" } } },
    scenes: [],
    activity: [{ revision: 45, summary: "spine.trim sp_01", changed: [] }],
    snapshot: {
      revision: 45,
      sequence: { meta: { title: "old" } },
      scenes: [],
      activity: [{ revision: 45 }],
      project: { title: "old", backdrop: "#000000" },
    },
    lastChanged: [],
  };
  return {
    state,
    set(patch: Record<string, unknown>) {
      Object.assign(state, patch);
    },
    on() {},
    emit() {},
  };
}

test("client: same-revision deltas refresh content without a duplicate row", () => {
  const store = fakeStore();
  applyDelta(store as never, {
    revision: 45,
    from_revision: 45,
    entry: { revision: 45, summary: "sequence.update", changed: ["sp_01"] },
    sequence: { meta: { title: "new", revision: 45 }, stage: { backdrop: { color: "#112233" } } },
    scenes: [{ id: "sc_1" }],
  } as never);
  assert.equal((store.state.activity as unknown[]).length, 1);
  assert.equal(((store.state.sequence as Record<string, Record<string, string>>).meta).title, "new");
  assert.equal((store.state.scenes as unknown[]).length, 1);
  assert.deepEqual(store.state.lastChanged, ["sp_01"]);
  const project = (store.state.snapshot as Record<string, Record<string, string>>).project;
  assert.equal(project.title, "new");
  assert.equal(project.backdrop, "#112233");
  // A real new revision still prepends its row.
  applyDelta(store as never, {
    revision: 46,
    from_revision: 45,
    entry: { revision: 46, summary: "spine.trim sp_01", changed: ["sp_01"] },
    sequence: { meta: { title: "new", revision: 46 }, stage: { backdrop: { color: "#112233" } } },
    scenes: [{ id: "sc_1" }],
  } as never);
  assert.equal((store.state.activity as unknown[]).length, 2);
  assert.equal(store.state.revision, 46);
});
