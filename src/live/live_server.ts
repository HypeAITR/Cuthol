// Cuthol Live server: watches the project's own state (sequence, journal,
// lock, inbox, progress) and streams it to the window over SSE. The agent pays
// nothing: the server sleeps on fs.watch plus a 1 s fallback poll.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { loadJournalManifest, loadSequence } from "../core/workspace.js";
import { readLiveLock } from "./live_lock.js";
import { peekLiveInbox, writeLiveNotePacket } from "./live_inbox.js";
import { LIVE_UI_DIR, resolveLivePaths } from "./live_paths.js";
import { buildDelta, buildScenes, buildSnapshot, classifyCursorMove, readProgress, type RevisionSignature } from "./live_state.js";
import { humanEditsEntriesForRange, routeLiveEditRequest, warmEditWorker } from "./live_edit_api.js";
import { Worker } from "node:worker_threads";
import { computeSceneThumbKey, isCompIgnoredFile, sceneThumbFile, COMP_IGNORE_DIRS } from "./live_thumbs.js";
import { LiveProxyManager, routeProxyRequest } from "./live_proxy.js";
import { routeLiveCompRequest } from "./live_comp_serve.js";
import { routeLiveFrameRequest } from "./live_frame.js";
import { handleLiveNotesPost, routeLiveCoordsRequest } from "./live_notes_api.js";
import { getSettingsView, routeLiveSettingsRequest } from "./live_settings_api.js";
import { LIVE_SCHEMA, type LiveActivityEntry, type LiveLock, type LiveNotePacket, type LiveServerInfo } from "./live_types.js";

export { buildActivity, buildScenes, buildSnapshot } from "./live_state.js";

export interface LiveStatus {
  running: boolean;
  server: LiveServerInfo | null;
  lock: LiveLock | null;
  pending_packets: number;
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".woff2": "font/woff2" };

const SSE_KEEPALIVE_MS = 15_000;
const WATCH_DEBOUNCE_MS = 50;
const FALLBACK_POLL_MS = 1000;
const IDLE_CHECK_MS = 30_000;
const DEFAULT_IDLE_SEC = 600;
const MAX_LOG_BYTES = 256 * 1024;

function idleSeconds(): number {
  const raw = Number(process.env.CUTHOL_LIVE_IDLE_SEC ?? DEFAULT_IDLE_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_SEC;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Server info when a live server is actually running; a dead pid cleans the stale file. */
function readServerInfo(projectDir: string): LiveServerInfo | null {
  const file = resolveLivePaths(projectDir).serverFile;
  let info: LiveServerInfo;
  try {
    info = JSON.parse(fs.readFileSync(file, "utf8")) as LiveServerInfo;
  } catch {
    return null;
  }
  if (!info || !pidAlive(info.pid)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
    return null;
  }
  return info;
}

function writeJsonAtomically(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/** Starts the live server for a project as a detached process (or reuses a running one). */
export async function ensureLiveServer(projectDir: string): Promise<LiveServerInfo> {
  const root = path.resolve(projectDir);
  const running = readServerInfo(root);
  if (running) return running;
  const { spawn } = await import("node:child_process");
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const cli = path.resolve(here, "../cli.js");
  const logFile = resolveLivePaths(root).logFile;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [cli, "live", "serve", "--dir", root], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    windowsHide: true,
  });
  child.unref();
  try {
    fs.closeSync(logFd);
  } catch {
    // the child keeps its own copy
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const info = readServerInfo(root);
    if (info) return info;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new CutholError(DIAGNOSTICS.LIVE_SERVER_START_FAILED(root));
}

/** Runs the server in the current process until stopped. */
export async function runLiveServer(projectDir: string, opts: { port?: number } = {}): Promise<void> {
  const root = path.resolve(projectDir);
  const lp = resolveLivePaths(root);
  fs.mkdirSync(lp.dir, { recursive: true });
  fs.mkdirSync(lp.inboxDir, { recursive: true });
  const token = crypto.randomBytes(16).toString("hex");
  const clients = new Set<http.ServerResponse>();
  let lastDisconnectAt = Date.now();
  let shuttingDown = false;

  const log = (msg: string): void => {
    try {
      let size = 0;
      try {
        size = fs.statSync(lp.logFile).size;
      } catch {
        size = 0;
      }
      if (size > MAX_LOG_BYTES) {
        const tail = fs.readFileSync(lp.logFile, "utf8").slice(-MAX_LOG_BYTES / 2);
        fs.writeFileSync(lp.logFile, `…(rotated ${new Date().toISOString()})\n${tail}`);
      }
      fs.appendFileSync(lp.logFile, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      // logging never breaks the server
    }
  };

  const send = (res: http.ServerResponse, event: string, data: unknown): void => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // client went away; the close handler drops it
    }
  };
  const broadcast = (event: string, data: unknown): void => {
    for (const c of clients) send(c, event, data);
  };

  // Preview proxies and scene thumbnails are produced in the background after
  // each revision; proxy progress reaches the window as `proxy` events.
  const proxies = new LiveProxyManager(root, (event, data) => broadcast(event, data));
  // Thumbnails render in a worker thread: each one goes through the synchronous
  // monitor-frame path and would otherwise block deltas for seconds.
  let thumbsJob: Promise<void> | null = null;
  let thumbsAgain = false;
  const runThumbsWorker = (sequence: unknown): Promise<void> =>
    new Promise<void>((resolve) => {
      try {
        const worker = new Worker(new URL("./live_thumbs_worker.js", import.meta.url), {
          workerData: { projectDir: root, sequence, scenes: buildScenes(sequence) },
        });
        worker.on("message", (m: { error?: string }) => {
          if (m?.error) log(`thumbnails failed: ${m.error}`);
        });
        worker.on("error", (e) => {
          log(`thumbnail worker failed: ${e.message}`);
          resolve();
        });
        worker.on("exit", () => resolve());
      } catch (e) {
        log(`thumbnail worker failed: ${e instanceof Error ? e.message : String(e)}`);
        resolve();
      }
    });
  const refreshMedia = (sequence: unknown): void => {
    try {
      proxies.ensureForSequence(sequence);
    } catch (e) {
      log(`proxy refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (thumbsJob) {
      thumbsAgain = true;
      return;
    }
    thumbsJob = runThumbsWorker(sequence).then(() => {
      thumbsJob = null;
      if (thumbsAgain) {
        thumbsAgain = false;
        refreshMedia(lastSeq);
      }
    });
  };
  // Thumbnail serving: the window asks per scene (`/api/thumb/<id>?k=<key>` with
  // the content key from the scene summary, or a bare id). A render pass that
  // is still running is waited out in short slices, so each scene's request
  // returns as soon as its own file lands instead of at the end of the whole
  // pass. Once a full pass finished without producing the file, the scene
  // genuinely has no picture (missing media; the worker logged G607) and gets
  // a placeholder instead of a bare failure.
  const THUMB_POLL_MS = 250;
  const THUMB_WAIT_MS = 120_000;
  const THUMB_KEY_RE = /^[0-9a-f]{16}$/;
  const serveThumb = async (res: http.ServerResponse, sceneId: string, keyParam: string | null): Promise<void> => {
    const t0 = Date.now();
    let lastKey: string | null = null;
    let waitedPass = false;
    for (;;) {
      let sequence: unknown;
      try {
        sequence = loadSequence(root).sequence;
      } catch {
        res.writeHead(500, { "Content-Type": MIME[".json"] }).end(JSON.stringify({ ok: false, note: "project state unreadable" }));
        return;
      }
      const scene = buildScenes(sequence).find((s) => s.id === sceneId);
      if (!scene) {
        res.writeHead(404, { "Content-Type": MIME[".json"] }).end(JSON.stringify({ ok: false, note: `unknown scene '${sceneId}'` }));
        return;
      }
      // A stale but existing render for an older key still shows a picture.
      if (keyParam && THUMB_KEY_RE.test(keyParam)) {
        const oldFile = sceneThumbFile(root, keyParam);
        if (fs.existsSync(oldFile)) {
          res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache", ETag: `"${keyParam}"` });
          fs.createReadStream(oldFile).pipe(res);
          return;
        }
      }
      const key = computeSceneThumbKey(sequence, scene);
      const file = sceneThumbFile(root, key);
      if (fs.existsSync(file)) {
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache", ETag: `"${key}"` });
        fs.createReadStream(file).pipe(res);
        return;
      }
      if (key !== lastKey) {
        lastKey = key;
        waitedPass = false;
      }
      if (!thumbsJob) {
        if (waitedPass) {
          const svg = thumbPlaceholderSvg(sceneId);
          res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(svg) });
          res.end(svg);
          return;
        }
        refreshMedia(sequence);
      }
      if (Date.now() - t0 > THUMB_WAIT_MS) {
        log(DIAGNOSTICS.LIVE_THUMB_FAILED(sceneId, "timed out waiting for the thumbnail render").formatted);
        res.writeHead(503, { "Content-Type": MIME[".json"] }).end(JSON.stringify({ ok: false, note: `thumbnail for '${sceneId}' is not ready yet (see G607 in the live server log)` }));
        return;
      }
      if (thumbsJob) await Promise.race([thumbsJob, new Promise((r) => setTimeout(r, THUMB_POLL_MS))]);
      else await new Promise((r) => setTimeout(r, THUMB_POLL_MS));
      if (!thumbsJob) waitedPass = true;
    }
  };

  // --- revision tracking -------------------------------------------------
  // lastCursor/lastSeq describe the state the window already has.
  // knownEntrySigs remembers every journal entry's identity (operation +
  // timestamp); a cursor move up onto an unchanged entry is a redo, onto a
  // replaced entry a new commit that pruned the redo branch (same revision
  // number, new content). See classifyCursorMove in live_state.ts.
  let lastCursor = -1;
  let knownEntrySigs: Map<number, RevisionSignature> = new Map();
  let lastSeqJson = "";
  let lastSeq: unknown = null;

  const currentCursor = (): number => {
    try {
      return loadJournalManifest(loadSequence(root).paths).cursor_revision;
    } catch {
      return lastCursor;
    }
  };

  const checkRevisions = (): void => {
    let manifest;
    let sequence: unknown;
    try {
      const loaded = loadSequence(root);
      manifest = loadJournalManifest(loaded.paths);
      sequence = loaded.sequence;
    } catch (e) {
      log(`state read failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const cursor = manifest.cursor_revision;
    const seqJson = JSON.stringify(sequence);
    const refreshKnown = (): void => {
      knownEntrySigs = new Map(manifest.entries.map((e) => [e.revision, { operation: e.operation, timestamp: e.timestamp }]));
    };
    if (cursor === lastCursor && seqJson === lastSeqJson) {
      refreshKnown();
      return;
    }
    const from = lastCursor;
    const oldSeq = lastSeq;
    lastCursor = cursor;
    lastSeqJson = seqJson;
    lastSeq = sequence;
    if (oldSeq === null || from < 0) {
      refreshKnown();
      return; // first read: the window gets a snapshot
    }
    try {
      const { operation, timestamp } = classifyCursorMove({ fromRevision: from, cursor, entries: manifest.entries, known: knownEntrySigs });
      refreshKnown();
      const delta = buildDelta({ projectDir: root, fromRevision: from, toRevision: cursor, oldSequence: oldSeq, newSequence: sequence, operation, timestamp, token });
      broadcast("delta", delta);
      log(`r${from}→r${cursor} ${delta.entry.summary}`);
      refreshMedia(sequence);
    } catch (e) {
      log(`delta failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // --- lock / inbox / progress tracking -----------------------------------
  let lastLockJson = "";
  let lastInboxSig = "";
  let lastProgressJson = "";

  const checkLiveFiles = (): void => {
    try {
      const lockJson = JSON.stringify(readLiveLock(root));
      if (lockJson !== lastLockJson) {
        lastLockJson = lockJson;
        broadcast("lock", JSON.parse(lockJson) as LiveLock | null);
      }
    } catch {
      // ignore
    }
    try {
      const pending = peekLiveInbox(root);
      const sig = pending.map((p) => p.id).join(",");
      if (sig !== lastInboxSig) {
        lastInboxSig = sig;
        broadcast("notes", pending);
      }
    } catch {
      // ignore
    }
    try {
      const progressJson = JSON.stringify(readProgress(root));
      if (progressJson !== lastProgressJson) {
        lastProgressJson = progressJson;
        broadcast("progress", JSON.parse(progressJson) as unknown);
      }
    } catch {
      // ignore
    }
  };

  // --- composition directory watch (outside edits) ------------------------
  // Watches only composition directories referenced by lane cues of the current
  // sequence; re-attached whenever the sequence changes. Recursive on platforms
  // that support it, with the 1 s fallback poll below covering the rest.
  const compWatchers = new Map<string, fs.FSWatcher>();
  const pendingCompDirs = new Set<string>();
  let compDebounce: NodeJS.Timeout | null = null;
  const COMP_DEBOUNCE_MS = 300;
  const compDirsFromSequence = (sequence: unknown): string[] => {
    const dirs = new Set<string>();
    const lanes: any[] = (sequence as any)?.lanes ?? [];
    for (const lane of lanes) {
      for (const cue of lane?.cues ?? []) {
        const d: unknown = cue?.composition?.composition_dir;
        if (typeof d === "string" && d.length > 0) dirs.add(path.normalize(d));
      }
    }
    return [...dirs];
  };
  const attachCompWatchers = (sequence: unknown): void => {
    const wanted = new Set(compDirsFromSequence(sequence).map((d) => path.resolve(root, d)));
    for (const [abs, w] of compWatchers) {
      if (!wanted.has(abs)) {
        try { w.close(); } catch {}
        compWatchers.delete(abs);
      }
    }
    for (const abs of wanted) {
      if (compWatchers.has(abs)) continue;
      try {
        const st = fs.statSync(abs);
        if (!st.isDirectory()) continue;
      } catch { continue; }
      try {
        const opts: { recursive?: boolean } = {};
        if (process.platform === "win32" || process.platform === "darwin") opts.recursive = true;
        const w = fs.watch(abs, opts, (event, filename) => {
          const rel = typeof filename === "string" ? filename.split(path.sep).join("/") : "";
          const base = rel ? path.posix.basename(rel) : "";
          const top = rel ? rel.split("/")[0] : "";
          if (rel && (isCompIgnoredFile(rel, base) || (top && COMP_IGNORE_DIRS.has(top)))) return;
          // Windows also reports the parent folder when a file inside it is written
          // (e.g. Cuthol's own files under `assets/`); the file itself raises its
          // own event, so folder events are ignored. A vanished path still counts.
          if (rel) {
            try {
              if (fs.statSync(path.join(abs, rel)).isDirectory()) return;
            } catch {
              // deleted or renamed: a real change
            }
          }
          pendingCompDirs.add(path.relative(root, abs).split(path.sep).join("/"));
          if (compDebounce) return;
          compDebounce = setTimeout(() => {
            compDebounce = null;
            const dirs = [...pendingCompDirs];
            pendingCompDirs.clear();
            if (dirs.length === 0) return;
            try {
              const seq = loadSequence(root).sequence;
              const scenes = buildScenes(seq, token, root);
              broadcast("comps", { schema: LIVE_SCHEMA, dirs, scenes });
              log(`comps changed: ${dirs.join(", ")}`);
              refreshMedia(seq);
            } catch (e) {
              log(`comps check failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }, COMP_DEBOUNCE_MS);
          compDebounce.unref?.();
        });
        w.on("error", () => {});
        compWatchers.set(abs, w);
        watchers.push(w);
      } catch {
        // directory vanished between stat and watch; the poll covers it
      }
    }
  };
  const checkCompFallback = (): void => {
    // Cheap poll fallback: recompute attach set so added/removed cue dirs and
    // non-recursive platforms still converge within ~1 s.
    try {
      attachCompWatchers(lastSeq);
    } catch {}
  };

  const checkAll = (): void => {
    checkRevisions();
    attachCompWatchers(lastSeq);
    checkCompFallback();
    checkLiveFiles();
  };

  let debounceTimer: NodeJS.Timeout | null = null;
  const scheduleCheck = (): void => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      checkAll();
    }, WATCH_DEBOUNCE_MS);
  };

  // --- HTTP ---------------------------------------------------------------
  const isDataRoute = (pathname: string): boolean =>
    pathname === "/events" || pathname.startsWith("/api/") || pathname.startsWith("/media/") || pathname.startsWith("/comp/");

  // Composition iframes load their own sub-resources by relative URL, which carry
  // no token (fonts and images pulled in by CSS or scripts have no tokened
  // referer either). The window document sets a same-site cookie scoped to
  // /comp/ when it loads with the right token; the referer stays as a fallback.
  const COMP_COOKIE = "cuthol_live_comp";
  const compCookieToken = (req: http.IncomingMessage): string | null => {
    const raw = req.headers.cookie ?? "";
    for (const part of raw.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COMP_COOKIE) return v.join("=") || null;
    }
    return null;
  };
  const refererToken = (req: http.IncomingMessage): string | null => {
    try {
      const ref = req.headers.referer;
      if (!ref) return null;
      const u = new URL(ref);
      return u.pathname.startsWith("/comp/") ? u.searchParams.get("t") : null;
    } catch {
      return null;
    }
  };

  const checkHost = (req: http.IncomingMessage, port: number): boolean => {
    const host = (req.headers.host ?? "").toLowerCase();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };

  const checkOrigin = (req: http.IncomingMessage, port: number): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser callers send no Origin
    try {
      const url = new URL(origin);
      return (
        (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
        url.port === String(port) &&
        (url.protocol === "http:" || url.protocol === "https:")
      );
    } catch {
      return false;
    }
  };

  const readBody = (req: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const server = http.createServer((req, res) => {
    void (async () => {
      const port = (server.address() as { port: number }).port;
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!checkHost(req, port)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const tok =
        url.searchParams.get("t") ??
        req.headers["x-cuthol-live-token"] ??
        (url.pathname.startsWith("/comp/") ? (compCookieToken(req) ?? refererToken(req)) : null);
      // Static window files are public (they carry no project data); everything
      // else needs the per-server token.
      if (isDataRoute(url.pathname) && tok !== token) {
        res.writeHead(403).end("forbidden");
        return;
      }
      if (req.method === "POST" && !checkOrigin(req, port)) {
        res.writeHead(403).end("forbidden");
        return;
      }

      if (url.pathname === "/events" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        send(res, "hello", { schema: LIVE_SCHEMA });
        try {
          send(res, "snapshot", buildSnapshot(root, token));
        } catch (e) {
          send(res, "error", { message: String(e) });
        }
        clients.add(res);
        const keepalive = setInterval(() => {
          try {
            res.write(": keep-alive\n\n");
          } catch {
            // closed below
          }
        }, SSE_KEEPALIVE_MS);
        req.on("close", () => {
          clearInterval(keepalive);
          clients.delete(res);
          lastDisconnectAt = Date.now();
        });
        return;
      }
      if (url.pathname === "/api/snapshot" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": MIME[".json"] }).end(JSON.stringify(buildSnapshot(root, token)));
        return;
      }
      if (url.pathname === "/api/inbox" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": MIME[".json"] }).end(JSON.stringify(peekLiveInbox(root)));
        return;
      }
      if (url.pathname === "/api/lock" && req.method === "POST") {
        let body: { holder?: unknown };
        try {
          body = JSON.parse(await readBody(req, 64 * 1024)) as { holder?: unknown };
        } catch {
          res.writeHead(400).end("bad json");
          return;
        }
        if (body.holder === "human") {
          const lock: LiveLock = {
            schema: LIVE_SCHEMA,
            holder: "human",
            since: new Date().toISOString(),
            revision: currentCursor(),
            server_pid: process.pid,
          };
          writeJsonAtomically(lp.lockFile, lock);
          lastLockJson = JSON.stringify(lock);
          broadcast("lock", lock);
          log(`lock human at r${lock.revision}`);
          warmEditWorker(root);
          res.writeHead(200, { "Content-Type": MIME[".json"] }).end(JSON.stringify({ ok: true, lock }));
          return;
        }
        if (body.holder === "agent") {
          const prev = readLiveLock(root);
          try {
            fs.unlinkSync(lp.lockFile);
          } catch {
            // already gone
          }
          lastLockJson = JSON.stringify(null);
          broadcast("lock", null);
          // Queue the human's edits (if any) so the agent's next response carries them.
          let queued: LiveNotePacket | null = null;
          const toRev = currentCursor();
          const fromRev = prev && prev.holder === "human" ? prev.revision : toRev;
          let entries: LiveActivityEntry[] = [];
          try {
            entries = fromRev < toRev ? humanEditsEntriesForRange(root, fromRev, toRev) : [];
          } catch (e) {
            log(`resume summary failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (entries.length > 0) {
            queued = {
              schema: LIVE_SCHEMA,
              id: `n_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
              created_at: new Date().toISOString(),
              revision: toRev,
              notes: [],
              human_edits: { from_revision: fromRev, to_revision: toRev, entries },
            };
            writeLiveNotePacket(root, queued);
            lastInboxSig = peekLiveInbox(root).map((p) => p.id).join(",");
            broadcast("notes", peekLiveInbox(root));
          }
          log(`lock agent (resumed r${fromRev}→r${toRev}, ${entries.length} edits)`);
          res.writeHead(200, { "Content-Type": MIME[".json"] }).end(JSON.stringify({ ok: true, lock: null, queued: queued?.id ?? null }));
          return;
        }
        res.writeHead(400).end("holder must be human or agent");
        return;
      }
      if (url.pathname === "/api/notes" && req.method === "POST") {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        } catch {
          res.writeHead(400).end("bad json");
          return;
        }
        try {
          const posted = await handleLiveNotesPost(root, body, currentCursor(), log);
          lastInboxSig = peekLiveInbox(root).map((p) => p.id).join(",");
          broadcast("notes", peekLiveInbox(root));
          log(`note packet ${posted.id} (${posted.stored}/${posted.received} notes stored)`);
          res
            .writeHead(200, { "Content-Type": MIME[".json"] })
            .end(JSON.stringify({ ok: true, id: posted.id, received: posted.received, stored: posted.stored, dropped_over_limit: posted.dropped_over_limit, dropped_invalid: posted.dropped_invalid }));
        } catch {
          res.writeHead(400).end("bad notes body");
        }
        return;
      }
      if (url.pathname === "/api/coords" && req.method === "GET") {
        routeLiveCoordsRequest(root, req, res, url.searchParams);
        return;
      }
      if (url.pathname === "/api/settings" && (req.method === "GET" || req.method === "POST")) {
        const handled = await routeLiveSettingsRequest(root, req, res);
        if (handled) {
          lastInboxSig = peekLiveInbox(root).map((p) => p.id).join(",");
          broadcast("settings", getSettingsView(root));
          return;
        }
      }
      if (url.pathname === "/api/edit" && req.method === "POST") {
        await routeLiveEditRequest(root, req, res);
        return;
      }
      if (url.pathname.startsWith("/api/thumb/") && req.method === "GET") {
        await serveThumb(res, decodeURIComponent(url.pathname.slice("/api/thumb/".length)), url.searchParams.get("k"));
        return;
      }
      if (url.pathname.startsWith("/api/proxy/") && req.method === "GET") {
        await routeProxyRequest(proxies, req, res, decodeURIComponent(url.pathname.slice("/api/proxy/".length)));
        return;
      }
      if (url.pathname === "/api/frame" && req.method === "GET") {
        routeLiveFrameRequest(root, req, res, Number(url.searchParams.get("at")));
        return;
      }
      if (url.pathname.startsWith("/comp/") && req.method === "GET") {
        const rest = url.pathname.slice("/comp/".length);
        const slash = rest.indexOf("/");
        const cueId = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
        const sub = slash < 0 ? "" : decodeURIComponent(rest.slice(slash));
        routeLiveCompRequest(root, req, res, cueId, sub);
        return;
      }
      if (url.pathname.startsWith("/media/") && req.method === "GET") {
        // Library asset by handle: /media/vid_01 (Range supported for video seeking).
        const handle = decodeURIComponent(url.pathname.slice(7));
        const { sequence } = loadSequence(root);
        const asset = sequence.library.find((a) => a.handle === handle);
        const file = asset?.uri ? (path.isAbsolute(asset.uri) ? asset.uri : path.resolve(root, asset.uri)) : null;
        if (!file || !fs.existsSync(file)) {
          res.writeHead(404).end();
          return;
        }
        serveFile(req, res, file);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(404).end();
        return;
      }
      if (url.pathname === "/" && url.searchParams.get("t") === token) {
        res.setHeader("Set-Cookie", `${COMP_COOKIE}=${token}; Path=/comp/; HttpOnly; SameSite=Strict`);
      }
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = path.resolve(LIVE_UI_DIR, rel);
      if (!file.startsWith(LIVE_UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
      }
      serveFile(req, res, file);
    })().catch((e: unknown) => {
      log(`request failed: ${e instanceof Error ? e.message : String(e)}`);
      try {
        res.writeHead(500).end("internal error");
      } catch {
        // connection already gone
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const info: LiveServerInfo = { schema: LIVE_SCHEMA, pid: process.pid, port, token, started_at: new Date().toISOString(), project_dir: root, url: `http://127.0.0.1:${port}/?t=${token}` };
  writeJsonAtomically(lp.serverFile, info);
  log(`live server up on 127.0.0.1:${port} for ${root}`);

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("live server stopping");
    try {
      const cur = JSON.parse(fs.readFileSync(lp.serverFile, "utf8")) as LiveServerInfo;
      if (cur.pid === process.pid) fs.unlinkSync(lp.serverFile);
    } catch {
      // ignore
    }
    try {
      const lock = readLiveLock(root);
      if (lock && lock.server_pid === process.pid) fs.unlinkSync(lp.lockFile);
    } catch {
      // ignore
    }
    for (const c of clients) {
      try {
        c.end();
      } catch {
        // ignore
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Baseline without broadcasting: the window gets full state via snapshot.
  try {
    const loaded = loadSequence(root);
    const manifest = loadJournalManifest(loaded.paths);
    lastCursor = manifest.cursor_revision;
    knownEntrySigs = new Map(manifest.entries.map((e) => [e.revision, { operation: e.operation, timestamp: e.timestamp }]));
    lastSeq = loaded.sequence;
    lastSeqJson = JSON.stringify(loaded.sequence);
    lastLockJson = JSON.stringify(readLiveLock(root));
    lastInboxSig = peekLiveInbox(root).map((p) => p.id).join(",");
    lastProgressJson = JSON.stringify(readProgress(root));
    refreshMedia(loaded.sequence);
  } catch (e) {
    log(`baseline failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Prompt path: fs.watch with debounce. Atomic file replaces show up as
  // `rename` on the watched directories, so directories are watched, not files.
  const watchers: fs.FSWatcher[] = [];
  const watchDir = (dir: string): void => {
    try {
      const w = fs.watch(dir, scheduleCheck);
      w.on("error", () => {});
      watchers.push(w);
    } catch {
      // directory missing; the fallback poll still catches changes
    }
  };
  let sequenceFile = path.join(root, "cuthol.sequence.json");
  try {
    const p = loadSequence(root).paths;
    watchDir(p.stateDir);
    watchDir(p.journalDir);
    sequenceFile = p.sequenceFile;
  } catch {
    watchDir(path.join(root, ".cuthol"));
  }
  watchDir(lp.dir);
  watchDir(lp.inboxDir);
  // The sequence file lives in the project root (too noisy to watch whole) and
  // is replaced atomically, so watch the file itself and re-attach after replace.
  const watchSequenceFile = (): void => {
    let w: fs.FSWatcher;
    try {
      w = fs.watch(sequenceFile, (event) => {
        scheduleCheck();
        if (event === "rename") {
          try {
            w.close();
          } catch {
            // ignore
          }
          setTimeout(watchSequenceFile, 200).unref?.();
        }
      });
      w.on("error", () => {
        setTimeout(watchSequenceFile, 1000).unref?.();
      });
      watchers.push(w);
    } catch {
      setTimeout(watchSequenceFile, 1000).unref?.();
    }
  };
  watchSequenceFile();

  // Fallback path: 1 s poll of the same cheap check (one small manifest read).
  const pollTimer = setInterval(checkAll, FALLBACK_POLL_MS);
  pollTimer.unref?.();

  // Idle path: no window connected for a while -> stop (the window reopens via `live open`).
  const idleTimer = setInterval(() => {
    if (clients.size === 0 && Date.now() - lastDisconnectAt > idleSeconds() * 1000) {
      log("idle timeout, stopping");
      shutdown();
    }
  }, IDLE_CHECK_MS);
  idleTimer.unref?.();

  await new Promise(() => {});
}

/** Inline SVG tile served (200) when a scene genuinely has no thumbnail (missing media). */
function thumbPlaceholderSvg(sceneId: string): string {
  const label = sceneId.replace(/[<>&"']/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="135" viewBox="0 0 240 135"><rect width="240" height="135" fill="#1a1d21"/><text x="120" y="62" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#8a9099">Thumbnail unavailable</text><text x="120" y="82" text-anchor="middle" font-family="monospace" font-size="11" fill="#5a6068">${label}</text></svg>`;
}

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Cache-Control": "no-cache" });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

export function getLiveStatus(projectDir: string): LiveStatus {
  const server = readServerInfo(projectDir);
  return { running: !!server, server, lock: readLiveLock(projectDir), pending_packets: peekLiveInbox(projectDir).length };
}

export async function stopLiveServer(projectDir: string): Promise<boolean> {
  const info = readServerInfo(projectDir);
  if (!info) return false;
  try {
    process.kill(info.pid);
  } catch {
    // already gone
  }
  try {
    fs.unlinkSync(resolveLivePaths(projectDir).serverFile);
  } catch {
    // server removes it on exit
  }
  try {
    const lock = readLiveLock(projectDir);
    if (lock && lock.server_pid === info.pid) fs.unlinkSync(resolveLivePaths(projectDir).lockFile);
  } catch {
    // ignore
  }
  return true;
}

/** Blocks until the human releases the lock (or timeout). Queued human edits ride the next response. */
export async function waitForLiveResume(projectDir: string, timeoutSec: number): Promise<{ resumed: boolean; waited_sec: number }> {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    const lock = readLiveLock(projectDir);
    if (!lock || lock.holder !== "human") return { resumed: true, waited_sec: Math.round((Date.now() - t0) / 1000) };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { resumed: false, waited_sec: timeoutSec };
}
