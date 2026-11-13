/**
 * Live server (`src/test/live_server.test.ts`): token + Host rejection, real
 * deltas (trim, undo) over SSE, lock protocol (G601, human actor, stale drop),
 * note packets riding the next CLI/MCP response exactly once, idle CPU.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CutholError } from "../core/diagnostics.js";
import { initWorkspace, loadSequence, stepJournal } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { drainLiveInbox, LIVE_PAUSED_LINE, peekLiveInbox } from "../live/live_inbox.js";
import { readLiveLock } from "../live/live_lock.js";
import { resolveLivePaths } from "../live/live_paths.js";
import { ensureLiveServer, stopLiveServer, type LiveStatus } from "../live/live_server.js";
import type { LiveDelta, LiveServerInfo, LiveSnapshot } from "../live/live_types.js";
import { CutholMcpServer } from "../mcp/server.js";
import { appendSpineClip, trimSpineClip } from "../sequence/spine.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-server-"));
const WORKSPACES: string[] = [];

function ffmpegTone(outPath: string, seconds: number): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x4488FF:s=160x160:r=30:d=${seconds}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      "-shortest",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      outPath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

/** Workspace with one ingested clip on the spine (rev 3: init, ingest, append). */
function makeWorkspace(name: string): string {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  initWorkspace({ dir, title: name, aspect: "16:9", fps: 30 });
  const media = path.join(ROOT, `${name}.mp4`);
  if (!fs.existsSync(media)) ffmpegTone(media, 4);
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: dir, filePaths: [media] });
  appendSpineClip({ workspaceDir: dir, assetHandle: item.handle });
  WORKSPACES.push(dir);
  return dir;
}

function runCli(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function parseJsonStream(out: { stdout: string; stderr: string }): Record<string, unknown> {
  for (const text of [out.stdout, out.stderr]) {
    const trimmed = text.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      // try the other stream
    }
  }
  throw new Error(`no JSON envelope\nstdout=${out.stdout.slice(0, 500)}\nstderr=${out.stderr.slice(0, 500)}`);
}

function httpRequest(
  port: number,
  reqPath: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => {
          body += c.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
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

/** Opens /events and records events until `stop()`; resolves on first snapshot. */
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Total CPU time of another process in ms (null when the platform cannot tell). */
function processCpuMs(pid: number): number | null {
  try {
    if (process.platform === "win32") {
      const proc = spawnSync(
        "powershell",
        ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).TotalProcessorTime.TotalMilliseconds`],
        { encoding: "utf8" }
      );
      const v = Number((proc.stdout ?? "").trim().replace(",", "."));
      return Number.isFinite(v) ? v : null;
    }
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(/\s+/);
      const ticks = Number(stat[13]) + Number(stat[14]);
      return Number.isFinite(ticks) ? (ticks / 100) * 1000 : null;
    }
  } catch {
    // fall through
  }
  return null;
}

test.after(async () => {
  for (const dir of WORKSPACES) {
    try {
      await stopLiveServer(dir);
    } catch {
      // best effort
    }
    try {
      const info = JSON.parse(fs.readFileSync(resolveLivePaths(dir).serverFile, "utf8")) as LiveServerInfo;
      if (pidAlive(info.pid)) process.kill(info.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

test("rejects missing token and forged Host/Origin", async () => {
  const dir = makeWorkspace("ws_auth");
  const info = await ensureLiveServer(dir);
  try {
    const noToken = await httpRequest(info.port, "/api/snapshot");
    assert.equal(noToken.status, 403);
    const badHost = await httpRequest(info.port, `/api/snapshot?t=${info.token}`, { headers: { Host: "evil.example:9999" } });
    assert.equal(badHost.status, 403);
    const badOrigin = await httpRequest(info.port, `/api/lock?t=${info.token}`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ holder: "human" }),
    });
    assert.equal(badOrigin.status, 403);
    const ok = await httpRequest(info.port, `/api/snapshot?t=${info.token}`);
    assert.equal(ok.status, 200);
    assert.equal((JSON.parse(ok.body) as LiveSnapshot).schema, "cuthol.live/1");
    assert.equal(ok.headers["x-content-type-options"], "nosniff");
    assert.equal(ok.headers["content-security-policy"], "frame-ancestors 'self'");
    // a token of the right length but wrong value, and one of another length, are both refused
    const flipped = (info.token[0] === "a" ? "b" : "a") + info.token.slice(1);
    assert.equal((await httpRequest(info.port, `/api/snapshot?t=${flipped}`)).status, 403);
    assert.equal((await httpRequest(info.port, `/api/snapshot?t=${info.token}x`)).status, 403);
    // static files never resolve outside the window folder (dot segments, encoded or not)
    for (const p of ["/../live_server.js", "/%2e%2e/live_server.js", "/..%2flive_server.js", "/..%5clive_server.js"]) {
      const r = await httpRequest(info.port, p);
      assert.notEqual(r.status, 200, `served ${p}`);
    }
    // a second ensure reuses the same server
    const again = await ensureLiveServer(dir);
    assert.equal(again.pid, info.pid);
    assert.equal(again.port, info.port);
  } finally {
    await stopLiveServer(dir);
  }
});

test("streams trim deltas with changed handles and summaries", async () => {
  const dir = makeWorkspace("ws_delta");
  const info = await ensureLiveServer(dir);
  const sse = openSse(info.port, info.token);
  try {
    const before = await Promise.race([
      sse.ready,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no snapshot")), 10000)),
    ]);
    const revBefore = before.revision;
    const t0 = Date.now();
    trimSpineClip({ workspaceDir: dir, clipId: "sp_01", sourceOutMs: 3000 });
    const delta = await waitFor(
      () => {
        const ev = sse.events.find((e) => e.name === "delta");
        return ev ? (JSON.parse(ev.data) as LiveDelta) : null;
      },
      10000,
      "delta"
    );
    const latencyMs = Date.now() - t0;
    assert.ok(latencyMs < 5000, `delta took ${latencyMs} ms`);
    assert.equal(delta.revision, revBefore + 1);
    assert.equal(delta.from_revision, revBefore);
    assert.ok(delta.entry.changed.includes("sp_01"), `changed=${JSON.stringify(delta.entry.changed)}`);
    assert.match(delta.entry.summary, /^spine\.trim sp_01/);
    assert.ok(delta.paths.length > 0, "paths must reuse the JSON diff");
    assert.equal(delta.entry.actor, "agent");
  } finally {
    sse.stop();
    await stopLiveServer(dir);
  }
});

test("emits deltas for undo and redo", async () => {
  const dir = makeWorkspace("ws_undo");
  trimSpineClip({ workspaceDir: dir, clipId: "sp_01", sourceOutMs: 3000 });
  const info = await ensureLiveServer(dir);
  const sse = openSse(info.port, info.token);
  try {
    await Promise.race([
      sse.ready,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no snapshot")), 10000)),
    ]);
    const revBefore = loadSequence(dir).sequence.meta.revision;
    stepJournal(dir, "undo");
    const undo = await waitFor(
      () => {
        const ev = sse.events.find((e) => e.name === "delta");
        return ev ? (JSON.parse(ev.data) as LiveDelta) : null;
      },
      10000,
      "undo delta"
    );
    assert.equal(undo.revision, revBefore - 1);
    assert.equal(undo.entry.operation, "journal.undo");
    assert.match(undo.entry.summary, /^undo /);
    assert.ok(undo.entry.changed.includes("sp_01"));
    sse.events.length = 0;
    stepJournal(dir, "redo");
    const redo = await waitFor(
      () => {
        const ev = sse.events.find((e) => e.name === "delta");
        return ev ? (JSON.parse(ev.data) as LiveDelta) : null;
      },
      10000,
      "redo delta"
    );
    assert.equal(redo.revision, revBefore);
    assert.equal(redo.entry.operation, "journal.redo");
    assert.match(redo.entry.summary, /^redo /);
  } finally {
    sse.stop();
    await stopLiveServer(dir);
  }
});

test("pause lets the agent finish one step and tells it to wait, then blocks; allows human; drops when the server dies", async () => {
  const dir = makeWorkspace("ws_lock");
  const info = await ensureLiveServer(dir);
  try {
    const lockRes = await httpRequest(info.port, `/api/lock?t=${info.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder: "human" }),
    });
    assert.equal(lockRes.status, 200);
    assert.equal(readLiveLock(dir)?.holder, "human");

    // the step the agent is on when the user pauses goes through once ...
    trimSpineClip({ workspaceDir: dir, clipId: "sp_01", sourceOutMs: 2800 });
    assert.equal(readLiveLock(dir)?.agent_grace_used, true);
    // ... and every response while paused starts with the wait instruction
    const pausedPayload = drainLiveInbox(dir);
    assert.ok(pausedPayload?.paused);
    assert.equal(pausedPayload?.lines[0], LIVE_PAUSED_LINE);
    // the next agent write is refused
    assert.throws(() => trimSpineClip({ workspaceDir: dir, clipId: "sp_01", sourceOutMs: 2500 }), (e: unknown) => {
      assert.ok(e instanceof CutholError);
      assert.equal(e.diagnostic.code, "CUTHOL-G601");
      return true;
    });

    process.env.CUTHOL_LIVE_ACTOR = "human";
    try {
      trimSpineClip({ workspaceDir: dir, clipId: "sp_01", sourceOutMs: 2500 });
    } finally {
      delete process.env.CUTHOL_LIVE_ACTOR;
    }
    assert.equal(readLiveLock(dir)?.holder, "human");

    // the server dies without cleanup: the lock must read as dropped
    process.kill(info.pid, "SIGKILL");
    await waitFor(() => (!pidAlive(info.pid) ? true : null), 5000, "server death");
    assert.equal(readLiveLock(dir), null);
    trimSpineClip({ workspaceDir: dir, clipId: "sp_01", sourceOutMs: 2000 });
    const status = runCli(["live", "status", "--dir", dir]);
    assert.equal(status.status, 0);
    assert.ok(!(parseJsonStream(status).live as LiveStatus).running);
  } finally {
    await stopLiveServer(dir);
  }
});

test("note packets ride the next CLI response exactly once", async () => {
  const dir = makeWorkspace("ws_notes");
  const info = await ensureLiveServer(dir);
  try {
    // one pixel png, base64
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const post = await httpRequest(info.port, `/api/notes?t=${info.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        notes: [{ n: 1, text: "boxed in", at_ms: 1000, frame: 30, point: { x: 80, y: 40, nx: 0.5, ny: 0.25 }, elements: [] }],
        sheet_png_base64: pngBase64,
      }),
    });
    assert.equal(post.status, 200);
    const inbox = await httpRequest(info.port, `/api/inbox?t=${info.token}`);
    assert.equal(inbox.status, 200);
    assert.equal(peekLiveInbox(dir).length, 1);

    const first = runCli(["brief", "--json", "--dir", dir]);
    assert.equal(first.status, 0);
    const env1 = parseJsonStream(first);
    const notes1 = env1.live_notes as { packets: Array<{ id: string }>; lines: string[]; images: string[] };
    assert.ok(notes1, "first response must carry live_notes");
    assert.equal(notes1.packets.length, 1);
    assert.ok(notes1.lines.some((l) => l.includes("boxed in")));
    assert.equal(notes1.images.length, 1);
    assert.ok(fs.existsSync(notes1.images[0]));

    const second = runCli(["brief", "--json", "--dir", dir]);
    assert.equal(second.status, 0);
    assert.ok(!("live_notes" in parseJsonStream(second)), "second response must not repeat live_notes");
  } finally {
    await stopLiveServer(dir);
  }
});

test("attaches notes to error and markdown responses", async () => {
  const dir = makeWorkspace("ws_notes2");
  const info = await ensureLiveServer(dir);
  try {
    const post = await httpRequest(info.port, `/api/notes?t=${info.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        notes: [{ n: 1, text: "on the error path", at_ms: 500, frame: 15, point: { x: 1, y: 1, nx: 0, ny: 0 }, elements: [] }],
      }),
    });
    assert.equal(post.status, 200);
    const failed = runCli(["spine", "trim", "--dir", dir, "--clip", "sp_99"]);
    assert.notEqual(failed.status, 0);
    const errEnv = parseJsonStream(failed);
    const errNotes = errEnv.live_notes as { lines: string[] } | undefined;
    assert.ok(errNotes, "error envelope must carry live_notes");
    assert.ok(errNotes.lines.some((l) => l.includes("on the error path")));
  } finally {
    await stopLiveServer(dir);
  }

  const dir2 = makeWorkspace("ws_notes3");
  const info2 = await ensureLiveServer(dir2);
  try {
    const post = await httpRequest(info2.port, `/api/notes?t=${info2.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        notes: [{ n: 1, text: "on the markdown path", at_ms: 500, frame: 15, point: { x: 1, y: 1, nx: 0, ny: 0 }, elements: [] }],
      }),
    });
    assert.equal(post.status, 200);
    const md = runCli(["brief", "--dir", dir2]);
    assert.equal(md.status, 0);
    assert.ok(md.stdout.includes("Live notes from the user (handle these first):"));
    assert.ok(md.stdout.includes("on the markdown path"));
    const md2 = runCli(["brief", "--dir", dir2]);
    assert.ok(!md2.stdout.includes("Live notes from the user"));
  } finally {
    await stopLiveServer(dir2);
  }
});

test("MCP responses carry note lines and sheet images", async () => {
  const dir = makeWorkspace("ws_mcp");
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const inboxDir = resolveLivePaths(dir).inboxDir;
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(path.join(inboxDir, "n_mcp1.png"), Buffer.from(pngBase64, "base64"));
  const { writeLiveNotePacket } = await import("../live/live_inbox.js");
  writeLiveNotePacket(dir, {
    id: "n_mcp1",
    created_at: new Date().toISOString(),
    revision: loadSequence(dir).sequence.meta.revision,
    notes: [{ n: 1, text: "via mcp", at_ms: 100, frame: 3, point: { x: 2, y: 3, nx: 0, ny: 0 }, elements: [] }],
    sheet: ".cuthol/live/inbox/n_mcp1.png",
  });
  const mcp = new CutholMcpServer({ defaultDir: dir });
  const msg = (await mcp.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "verify", arguments: {} },
  })) as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean } };
  const content = msg.result?.content ?? [];
  const text = content.find((c) => c.type === "text")?.text ?? "";
  assert.ok(text.includes("Live notes from the user (handle these first):"), text.slice(0, 400));
  assert.ok(text.includes("via mcp"));
  assert.ok(
    content.some((c) => c.type === "image"),
    `expected an inline image, got [${content.map((c) => c.type).join(",")}]`
  );
});

test("idles near zero CPU", async function () {
  const probe = process.platform === "win32" || process.platform === "linux";
  if (!probe) {
    console.log("skip: no per-process CPU readout on this platform");
    return;
  }
  const dir = makeWorkspace("ws_idle");
  const info = await ensureLiveServer(dir);
  try {
    await new Promise((r) => setTimeout(r, 1000));
    const cpu0 = processCpuMs(info.pid);
    assert.ok(cpu0 !== null, "need a CPU readout");
    await new Promise((r) => setTimeout(r, 5000));
    const cpu1 = processCpuMs(info.pid);
    assert.ok(cpu1 !== null, "need a CPU readout");
    assert.ok(cpu1 - cpu0 < 100, `idle 5 s cost ${cpu1 - cpu0} ms CPU`);
  } finally {
    await stopLiveServer(dir);
  }
});
