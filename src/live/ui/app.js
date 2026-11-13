// Cuthol Live window shell. Owns: the store, the connection bootstrap, the
// top bar (logo, project, render pill, settings), the resizable layout
// (timeline height, right-column width, persisted in localStorage), the tall
// project arrangement, and mounting every region. Regions never talk to each
// other directly: they read `ctx.store.state` and react to store events; they
// change shared UI state only through `ctx.store.set`.
import { connect, createApi } from "./live_client.js";

/**
 * @typedef {Object} LiveUiState
 * @property {"offline"|"agent"|"human"|"render"} mode    who holds the timeline (render = a render is running)
 * @property {any|null} snapshot     last LiveSnapshot (see src/live/live_types.ts)
 * @property {any|null} sequence     current cuthol.sequence.json document
 * @property {number} revision
 * @property {any[]} scenes          LiveSceneSummary[]
 * @property {any[]} activity        LiveActivityEntry[] newest first
 * @property {any|null} lock         LiveLock | null
 * @property {any|null} progress     LiveProgress | null
 * @property {{id:string, kind:"clip"|"cue"|"scene"}|null} selection
 * @property {number} playheadMs
 * @property {boolean} playing
 * @property {boolean} annotate      notes tool active
 * @property {string[]} lastChanged  handles changed by the latest delta (for highlights)
 * @property {number|null} agentMs   timeline time of the agent's latest change (amber line)
 * @property {boolean} agentFollow   timeline follows the agent line
 * @property {string[]} agentIds     clip/cue ids changed by recent agent revisions (amber dots)
 * @property {number[]} noteTimes    sent-note times in ms (ruler diamonds)
 *
 * @typedef {Object} LiveStore
 * @property {LiveUiState} state
 * @property {(event:string, fn:(payload:any)=>void)=>()=>void} on
 * @property {(event:string, payload?:any)=>void} emit
 * @property {(patch:Partial<LiveUiState>, event?:string)=>void} set   merges and emits `event` (default "state")
 *
 * @typedef {Object} LiveApi
 * @property {string} token
 * @property {(path:string)=>string} url                 absolute URL with the token
 * @property {(path:string)=>Promise<any>} get
 * @property {(path:string, body:any)=>Promise<any>} post
 *
 * @typedef {Object} LiveContext
 * @property {LiveStore} store
 * @property {LiveApi} api
 *
 * Store events (payloads): "snapshot" (LiveSnapshot), "delta" (LiveDelta), "progress" (LiveProgress),
 * "lock" (LiveLock|null), "notes" (LiveNotePacket[] still unread by the agent), "connection" ("open"|"closed"),
 * "selection", "playhead" (ms), "state" (patch).
 */

function createStore() {
  const listeners = new Map();
  /** @type {LiveUiState} */
  const state = { mode: "offline", snapshot: null, sequence: null, revision: 0, scenes: [], activity: [], lock: null, progress: null, selection: null, playheadMs: 0, playing: false, annotate: false, lastChanged: [], agentMs: null, agentFollow: false, agentIds: [], noteTimes: [] };
  const on = (event, fn) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); return () => listeners.get(event).delete(fn); };
  const emit = (event, payload) => { for (const fn of listeners.get(event) ?? []) { try { fn(payload); } catch (e) { console.error(`[live] ${event} listener`, e); } } };
  const set = (patch, event = "state") => { Object.assign(state, patch); emit(event, patch); };
  return { state, on, emit, set };
}

const store = createStore();
const api = createApi();
/** @type {LiveContext} */
const ctx = { store, api };

function modeFrom(state) {
  if (state.mode === "offline") return "offline";
  if (state.progress && state.progress.state === "running") return "render";
  if (state.lock && state.lock.holder === "human") return "human";
  return "agent";
}

function syncMode() {
  const next = modeFrom(store.state);
  if (store.state.mode !== next) store.set({ mode: next });
  document.body.dataset.mode = store.state.mode;
}

for (const ev of ["snapshot", "delta", "lock", "progress", "connection"]) store.on(ev, syncMode);

store.on("snapshot", (s) => {
  const p = s?.snapshot?.project ?? s?.project;
  const title = p?.title ?? "Cuthol Live";
  document.getElementById("project-title").textContent = title;
  document.title = `${title} — Cuthol Live`;
  const tall = (p?.width ?? 0) < (p?.height ?? 0);
  document.body.classList.toggle("tall", tall);
  arrangeTall(tall);
});

// Tall projects stack everything right of the full-height preview column.
const mid = document.getElementById("mid");
const rightCol = document.getElementById("rightcol");
const app = document.getElementById("app");
const home = new Map();
function arrangeTall(tall) {
  const tl = document.querySelector('[data-region="timeline"]');
  const scenes = document.querySelector('[data-region="scenes"]');
  if (!tl || !scenes) return;
  if (!home.has(tl)) {
    home.set(tl, tl.parentElement);
    home.set(scenes, scenes.parentElement);
  }
  if (tall) {
    rightCol.insertBefore(scenes, rightCol.firstChild);
    rightCol.appendChild(tl);
  } else {
    mid.insertBefore(scenes, mid.firstChild);
    app.appendChild(tl);
  }
}

// Resizable layout: timeline height + right-column width, remembered.
const LAYOUT_KEY = "cuthol.live.layout.v1";
try {
  const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}");
  const root = document.documentElement;
  if (Number.isFinite(saved.sideW)) root.style.setProperty("--side-w", `${Math.min(520, Math.max(240, saved.sideW))}px`);
  if (Number.isFinite(saved.tlH)) root.style.setProperty("--tl-h", `${Math.min(600, Math.max(160, saved.tlH))}px`);
} catch { /* corrupted prefs never break the window */ }
function saveLayout() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const px = (v) => Number(String(v ?? "").replace("px", "")) || null;
    const sideW = px(cs.getPropertyValue("--side-w"));
    const tlH = px(cs.getPropertyValue("--tl-h"));
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ sideW, tlH }));
  } catch { /* prefs are best-effort */ }
}
function dragSplitter(el, axis, prop, min, max) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.classList.add("drag");
    el.setPointerCapture(e.pointerId);
    const start = axis === "x" ? e.clientX : e.clientY;
    const cs = getComputedStyle(document.documentElement);
    const base = Number(String(cs.getPropertyValue(prop)).replace("px", "")) || (axis === "x" ? 320 : 300);
    const move = (ev) => {
      const d = (axis === "x" ? ev.clientX : ev.clientY) - start;
      // The side column shrinks when the splitter moves right; the timeline
      // shrinks when its splitter moves down.
      const next = Math.min(max, Math.max(min, base + (axis === "x" ? -d : -d)));
      document.documentElement.style.setProperty(prop, `${next}px`);
    };
    const up = () => {
      el.classList.remove("drag");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      saveLayout();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}
dragSplitter(document.getElementById("hsplit"), "x", "--side-w", 240, 520);
dragSplitter(document.getElementById("vsplit"), "y", "--tl-h", 160, 600);

const REGIONS = ["topbar", "scenes", "preview", "activity", "tabs", "timeline", "edit"];
for (const name of REGIONS) {
  try {
    const mod = await import(`./${name}.js`);
    mod.mount(document.querySelector(`[data-region="${name}"]`), ctx);
  } catch (e) {
    console.error(`[live] region ${name} failed to mount`, e);
  }
}

connect(store, api);
syncMode();
