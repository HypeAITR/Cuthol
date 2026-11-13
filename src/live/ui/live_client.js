// Connection to the live server. Contract:
//   createApi() -> LiveApi   token from `?t=` of the page URL
//   connect(store, api)      EventSource(`/events?t=`), maps server events onto the store:
//     hello      -> nothing (protocol check)
//     snapshot   -> store.set({snapshot, sequence, revision, scenes, activity, lock, progress, mode:"agent"}, "snapshot")
//     delta      -> store.set({sequence, revision, scenes, activity:[entry, ...activity], lastChanged: entry.changed}, "delta")
//                  (same-revision deltas refresh the content without appending an activity row)
//     progress   -> store.set({progress}, "progress")
//     lock       -> store.set({lock}, "lock")
//     notes      -> store.emit("notes", packets)
//   on error: store.set({mode:"offline"}, "connection"); retry with backoff; on open: emit("connection","open").
//   A rejected token (403) or a server gone past recovery means the server was
//   restarted with a new address: retries stop and the window says plainly to
//   reopen it (emit("connection","restarted")).

const SCHEMA = "cuthol.live/1";
const MAX_ACTIVITY = 50;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;
/** Consecutive unreachable retries after a live connection before the server counts as restarted. */
const RESTART_AFTER_FAILURES = 5;
const PROBE_TIMEOUT_MS = 5000;

export function createApi() {
  const token = new URLSearchParams(location.search).get("t") ?? "";
  // A path that already carries the token (server-built thumbnail URLs) is used as is.
  const url = (p) => (/[?&]t=/.test(p) ? p : `${p}${p.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`);
  return {
    token,
    url,
    get: async (p) => (await fetch(url(p))).json(),
    post: async (p, body) => (await fetch(url(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })).json(),
  };
}

function applySnapshot(store, s) {
  store.set(
    {
      snapshot: s,
      sequence: s.sequence,
      revision: s.revision,
      scenes: s.scenes ?? [],
      activity: s.activity ?? [],
      lock: s.lock ?? null,
      progress: s.progress ?? null,
      mode: "agent",
    },
    "snapshot"
  );
}

function applyDelta(store, d) {
  const entry = d.entry;
  // A same-revision delta (in-place update, external hand-edit) carries fresh
  // content but no new revision: update the content, do not append a duplicate
  // activity row.
  const newRevision = typeof d.revision === "number" ? d.revision : store.state.revision;
  const sameRevision = newRevision === store.state.revision;
  const activity = entry && !sameRevision ? [entry, ...(store.state.activity ?? [])].slice(0, MAX_ACTIVITY) : (store.state.activity ?? []);
  const sequence = d.sequence ?? store.state.sequence;
  const scenes = d.scenes ?? store.state.scenes;
  let snapshot = store.state.snapshot;
  if (snapshot) {
    snapshot = { ...snapshot, revision: newRevision, sequence, scenes, activity };
    // Project header fields live on the snapshot; keep them in sync so a
    // same-revision content change (title, backdrop) shows without a reload.
    if (sequence && typeof sequence === "object") {
      const project = { ...(snapshot.project ?? {}) };
      if (sequence.meta?.title != null) project.title = sequence.meta.title;
      if (sequence.stage?.backdrop?.color != null) project.backdrop = sequence.stage.backdrop.color;
      snapshot.project = project;
    }
  }
  store.set(
    {
      sequence,
      revision: newRevision,
      scenes,
      activity,
      snapshot,
      lastChanged: entry?.changed ?? [],
    },
    "delta"
  );
}

// Exported for tests (the window uses connect()).
export { applyDelta };

export function connect(store, api) {
  let es = null;
  let retryMs = RETRY_BASE_MS;
  let retryTimer = null;
  let closed = false;
  let everConnected = false;
  let consecFailures = 0;
  let restartNoticed = false;
  let deadToken = false;

  const cleanup = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (es) {
      try {
        es.close();
      } catch {
        // already closed
      }
      es = null;
    }
  };

  const scheduleRetry = () => {
    if (closed || deadToken || retryTimer) return;
    store.set({ mode: "offline" }, "connection");
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      open();
    }, retryMs);
  };

  // The server rotates port and token on every restart, so a window on a dead
  // token can never reconnect: stop the retry loop and say plainly to reopen
  // the window instead of sitting on "Disconnected" forever.
  const noticeRestart = (stopRetries) => {
    if (stopRetries) deadToken = true;
    if (restartNoticed) return;
    restartNoticed = true;
    store.set({ mode: "offline" }, "connection");
    store.emit("connection", "restarted");
    // The status pill belongs to the window shell; until it renders this
    // state, say it here so the hint is never misleading.
    if (typeof document !== "undefined") {
      try {
        const text = document.getElementById("status-text");
        if (text) text.textContent = "Server restarted — reopen this window with 'cuthol live open'";
      } catch {
        // shell markup missing; the store event still carries the state
      }
    }
  };

  // EventSource reports no status: a plain fetch classifies the failure.
  // "restarted" (token rejected) is permanent; anything else may recover.
  const probe = async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(api.url("/api/snapshot"), { signal: ctrl.signal });
        if (res.status === 403) return "restarted";
        if (res.ok) return "ok";
        return "down";
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return "down";
    }
  };

  const onError = () => {
    cleanup();
    void probe().then((result) => {
      if (closed || deadToken) return;
      if (result === "restarted") {
        noticeRestart(true);
        return;
      }
      if (result === "ok") {
        consecFailures = 0;
        scheduleRetry();
        return;
      }
      consecFailures++;
      if (everConnected && consecFailures >= RESTART_AFTER_FAILURES) noticeRestart(false);
      scheduleRetry();
    });
  };

  const open = () => {
    if (closed) return;
    cleanup();
    try {
      es = new EventSource(api.url("/events"));
    } catch {
      scheduleRetry();
      return;
    }
    es.addEventListener("hello", (ev) => {
      try {
        const h = JSON.parse(ev.data);
        if (h.schema && h.schema !== SCHEMA) console.warn(`[live] schema mismatch: server ${h.schema}, client ${SCHEMA}`);
      } catch {
        // ignore malformed hello
      }
    });
    es.addEventListener("snapshot", (ev) => {
      try {
        applySnapshot(store, JSON.parse(ev.data));
      } catch (e) {
        console.error("[live] bad snapshot", e);
      }
    });
    es.addEventListener("delta", (ev) => {
      try {
        applyDelta(store, JSON.parse(ev.data));
      } catch (e) {
        console.error("[live] bad delta", e);
      }
    });
    es.addEventListener("comps", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        store.set({ scenes: msg.scenes ?? store.state.scenes, lastChanged: msg.dirs ?? [] }, "comps");
        store.emit("comps", msg);
      } catch (e) {
        console.error("[live] bad comps", e);
      }
    });
    es.addEventListener("progress", (ev) => {
      try {
        store.set({ progress: JSON.parse(ev.data) }, "progress");
      } catch (e) {
        console.error("[live] bad progress", e);
      }
    });
    es.addEventListener("lock", (ev) => {
      try {
        store.set({ lock: JSON.parse(ev.data) }, "lock");
      } catch (e) {
        console.error("[live] bad lock", e);
      }
    });
    es.addEventListener("notes", (ev) => {
      try {
        store.emit("notes", JSON.parse(ev.data));
      } catch (e) {
        console.error("[live] bad notes", e);
      }
    });
    es.addEventListener("settings", (ev) => {
      try {
        store.emit("settings", JSON.parse(ev.data));
      } catch (e) {
        console.error("[live] bad settings", e);
      }
    });
    es.addEventListener("error", (ev) => {
      try {
        const data = typeof ev.data === "string" && ev.data ? JSON.parse(ev.data) : null;
        if (data) console.error("[live] server error", data);
      } catch {
        // EventSource connection error (no data): handled by onerror below
      }
    });
    es.onopen = () => {
      retryMs = RETRY_BASE_MS;
      consecFailures = 0;
      store.emit("connection", "open");
      // Reconnects (and the first connect, if the snapshot event was missed)
      // resync full state; cheap and idempotent.
      api
        .get("/api/snapshot")
        .then((s) => {
          everConnected = true;
          applySnapshot(store, s);
        })
        .catch(() => scheduleRetry());
    };
    es.onerror = () => {
      onError();
    };
  };

  open();
  return () => {
    closed = true;
    cleanup();
  };
}
