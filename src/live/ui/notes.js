// Notes region: click a point or drag an area on the preview frame, write a
// note; every note on one frame ships as a single packet to the agent with the
// elements under each pin and one contact-sheet image. Prefix: .nt-
//
// The overlay never touches the preview DOM: it aligns a fixed layer to the
// stage rectangle and converts through the project stage size (letterbox-aware).
import { DEFAULT_SHORTCUTS, eventChord, loadShortcuts, matchShortcut, resolveShortcuts } from "./shortcuts.js";

// -- pure helpers (also imported by the node unit test; no DOM here) ---------

/** Sequence frame at a playhead position (matches the preview timecode). */
export function frameAtMs(playheadMs, fps) {
  const f = Math.max(1, Number(fps) || 30);
  return Math.max(0, Math.floor((Math.max(0, Number(playheadMs) || 0) / 1000) * f));
}

/**
 * Client (CSS px) click to stage pixels. The stage rect keeps the project
 * aspect, but the mapping stays correct under letterboxing: uniform scale plus
 * a centered offset.
 */
export function clientToStage(clientX, clientY, rect, stageW, stageH) {
  const W = Math.max(1, stageW);
  const H = Math.max(1, stageH);
  const scale = Math.min(rect.width / W, rect.height / H);
  const offX = rect.left + (rect.width - W * scale) / 2;
  const offY = rect.top + (rect.height - H * scale) / 2;
  return { x: (clientX - offX) / scale, y: (clientY - offY) / scale, scale };
}

/** Stage pixels back to client (CSS px) coordinates within the same rect. */
export function stageToClient(stageX, stageY, rect, stageW, stageH) {
  const W = Math.max(1, stageW);
  const H = Math.max(1, stageH);
  const scale = Math.min(rect.width / W, rect.height / H);
  const offX = rect.left + (rect.width - W * scale) / 2;
  const offY = rect.top + (rect.height - H * scale) / 2;
  return { x: offX + stageX * scale, y: offY + stageY * scale, scale };
}

/** Group notes/drafts by frame; one frame ships as one packet. */
export function groupNotesByFrame(items) {
  const groups = new Map();
  for (const it of items ?? []) {
    const key = it.frame;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return groups;
}

/** Compact note timestamp `MM:SS.cc` for packet lines. */
export function formatNoteTime(atMs) {
  const ms = Math.max(0, Math.round(Number(atMs) || 0));
  const mm = String(Math.floor(ms / 60000)).padStart(2, "0");
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
  const cc = String(Math.floor((ms % 1000) / 10)).padStart(2, "0");
  return `${mm}:${ss}.${cc}`;
}

/** One packet line per note, the form the agent reads. */
export function formatNoteLine(note) {
  const text = String(note.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const refs = (note.elements ?? []).slice(0, 3).map((el) => el.ref);
  const where = refs.length
    ? ` → ${refs.join(" ∩ ")}${note.overlap_px2 ? ` ${Math.round(note.overlap_px2)} px²` : ""}`
    : "";
  return `#${note.n} ${formatNoteTime(note.at_ms)} "${text}"${where}`;
}

/** Whole packet as paste-ready plain text (Copy as text). */
export function formatPacketText(notes) {
  return (notes ?? []).map(formatNoteLine).join("\n");
}

/** An inbox packet as a sent-list entry (still waiting for the agent). */
export function packetToSentEntry(packet) {
  const notes = packet?.notes ?? [];
  const first = notes[0] ?? {};
  return {
    id: packet?.id ?? "",
    frame: first.frame ?? 0,
    count: notes.length,
    lines: notes.map(formatNoteLine),
    status: "waiting",
    sentAt: packet?.created_at ?? "",
    deliveredAt: null,
  };
}

/**
 * Rebuild the sent list after a (re)load: inbox packets are waiting (newest
 * first); known entries that left the inbox were delivered while away.
 */
export function mergeRestoredSent(inboxPackets, candidates) {
  const pending = new Set((inboxPackets ?? []).map((p) => p?.id));
  const known = new Map((candidates ?? []).filter((c) => c?.id).map((c) => [c.id, c]));
  const next = [];
  for (const p of [...(inboxPackets ?? [])].reverse()) {
    if (!p?.id || !pending.has(p.id)) continue;
    const prev = known.get(p.id);
    next.push(prev ? { ...prev, status: "waiting", deliveredAt: null } : packetToSentEntry(p));
  }
  for (const c of candidates ?? []) {
    if (!c?.id || pending.has(c.id) || next.some((n) => n.id === c.id)) continue;
    next.push(c.status === "delivered" ? { ...c } : { ...c, status: "delivered", deliveredAt: c.deliveredAt ?? "earlier" });
  }
  return next;
}

// -- region ---------------------------------------------------------------

const COORDS_RETRY_MS = 2000;
const COORDS_MAX_RETRIES = 6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** @param {HTMLElement|null} root  @param {import('./app.js').LiveContext} ctx */
export function mount(root, ctx) {
  if (!root) return;
  const store = ctx.store;
  const api = ctx.api;

  /** @type {Map<number, any[]>} frame -> drafts on that frame */
  const drafts = new Map();
  /** @type {Array<{id:string, frame:number, count:number, lines:string[], status:string, sentAt:string, deliveredAt:string|null}>} */
  const sent = [];
  let selectedN = null;
  let sending = false;
  let pinEls = new Map();
  let pinSignature = "";
  let rafId = 0;

  const stageSize = () => {
    const p = store.state.snapshot?.project ?? {};
    return { w: p.width ?? 1920, h: p.height ?? 1080, fps: p.fps ?? 30 };
  };
  const currentFrame = () => frameAtMs(store.state.playheadMs ?? 0, stageSize().fps);
  const currentDrafts = () => drafts.get(currentFrame()) ?? [];
  const stageEl = () => document.querySelector(".pv-stage");

  const frameLabel = (frame) => {
    const { fps } = stageSize();
    return `f${frame} · ${formatNoteTime((frame / Math.max(1, fps)) * 1000)}`;
  };

  // -- panel --------------------------------------------------------------
  root.innerHTML = `
    <div class="panel-head">notes<span class="spacer"></span><span class="nt-frame mono"></span></div>
    <div class="panel-body nt-body">
      <div class="nt-empty"></div>
      <ul class="nt-list"></ul>
      <div class="nt-actions">
        <button class="nt-general" type="button" title="Note without a frame pin">General note</button>
        <button class="nt-send" type="button">Send notes</button>
        <button class="nt-discard" type="button">Discard</button>
        <span class="nt-hint mono">Ctrl+Enter</span>
      </div>
      <div class="nt-delivery">Notes reach the agent with its next step; it cannot be woken while idle.</div>
      <ul class="nt-sent"></ul>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const frameEl = $(".nt-frame");
  const emptyEl = $(".nt-empty");
  const listEl = $(".nt-list");
  const sentEl = $(".nt-sent");
  const sendBtn = $(".nt-send");
  const discardBtn = $(".nt-discard");

  // -- overlay layer (fixed, aligned to the stage rect; preview DOM untouched)
  const layer = document.createElement("div");
  layer.className = "nt-layer";
  layer.hidden = true;
  document.body.appendChild(layer);
  const marquee = document.createElement("div");
  marquee.className = "nt-marquee";
  marquee.hidden = true;
  layer.appendChild(marquee);

  const layerRect = () => {
    const st = stageEl();
    if (!st) return null;
    const r = st.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return r;
  };

  const syncLayerBox = () => {
    const r = layerRect();
    if (!r) {
      layer.hidden = true;
      return null;
    }
    layer.hidden = false;
    layer.style.left = `${r.left}px`;
    layer.style.top = `${r.top}px`;
    layer.style.width = `${r.width}px`;
    layer.style.height = `${r.height}px`;
    return r;
  };

  const renumber = (frame) => {
    for (const [i, d] of (drafts.get(frame) ?? []).entries()) d.n = i + 1;
  };

  const setDraftElements = (frame, n, patch) => {
    const list = drafts.get(frame) ?? [];
    const d = list.find((x) => x.n === n);
    if (!d) return;
    Object.assign(d, patch);
    const row = listEl.querySelector(`[data-n="${n}"] .nt-els`);
    if (row && frame === currentFrame()) row.innerHTML = elementsHtml(d);
    const pin = pinEls.get(n);
    if (pin) pin.classList.toggle("is-pending", d.elState === "pending" || d.elState === "loading");
  };

  const elementsHtml = (d) => {
    if (!d.point) return `<span class="nt-noels">general note</span>`;
    if (d.elState === "loading" || d.elState === "pending") return `<span class="nt-measuring">measuring…</span>`;
    if (d.elState === "error") return `<span class="nt-noels">elements unavailable</span>`;
    if (!d.elements || d.elements.length === 0) return `<span class="nt-noels">no elements</span>`;
    const names = d.elements.slice(0, 3).map((e) => `<span class="nt-el">${escapeHtml(e.ref)}</span>`).join(`<span class="nt-sep"> · </span>`);
    return names;
  };

  const fetchElements = async (frame, n, attempt = 0) => {
    const list = drafts.get(frame) ?? [];
    const d = list.find((x) => x.n === n);
    if (!d) return;
    setDraftElements(frame, n, { elState: attempt === 0 ? "loading" : "pending" });
    const q = new URLSearchParams({ at_ms: String(Math.round(d.at_ms)), x: String(Math.round(d.point.x * 10) / 10), y: String(Math.round(d.point.y * 10) / 10) });
    if (d.area) {
      q.set("w", String(Math.round(d.area[2] * 10) / 10));
      q.set("h", String(Math.round(d.area[3] * 10) / 10));
      q.set("x", String(Math.round(d.area[0] * 10) / 10));
      q.set("y", String(Math.round(d.area[1] * 10) / 10));
    }
    let res = null;
    try {
      res = await api.get(`/api/coords?${q.toString()}`);
    } catch {
      setDraftElements(frame, n, { elState: "error" });
      return;
    }
    if (!res || res.ok !== true) {
      setDraftElements(frame, n, { elState: "error" });
      return;
    }
    if (res.pending) {
      if (attempt < COORDS_MAX_RETRIES) {
        setDraftElements(frame, n, { elState: "pending" });
        setTimeout(() => fetchElements(frame, n, attempt + 1), COORDS_RETRY_MS);
      } else {
        setDraftElements(frame, n, { elState: "error" });
      }
      return;
    }
    setDraftElements(frame, n, { elState: "ready", elements: res.elements ?? [], overlap_px2: res.overlap_px2 });
  };

  const addDraft = (point, area) => {
    if (store.state.playing) store.set({ playing: false });
    const frame = currentFrame();
    const atMs = Math.round(store.state.playheadMs ?? 0);
    const list = drafts.get(frame) ?? [];
    const general = point == null;
    const d = { n: list.length + 1, text: "", at_ms: atMs, frame, point: point ?? null, area, elements: [], overlap_px2: undefined, elState: general ? "ready" : "loading" };
    list.push(d);
    drafts.set(frame, list);
    selectedN = d.n;
    if (!general) void fetchElements(frame, d.n);
    renderPanel();
    rebuildPins(true);
    const ta = listEl.querySelector(`.nt-text[data-n="${d.n}"]`);
    if (ta) ta.focus();
  };

  // A general note has no pin: same queue, no contact-sheet cell.
  const addGeneralDraft = () => {
    store.set({ annotate: true });
    addDraft(null, undefined);
  };

  const deleteDraft = (n) => {
    const frame = currentFrame();
    const list = (drafts.get(frame) ?? []).filter((d) => d.n !== n);
    if (list.length) {
      drafts.set(frame, list);
      renumber(frame);
    } else {
      drafts.delete(frame);
    }
    if (selectedN === n) selectedN = null;
    renderPanel();
    rebuildPins(true);
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const renderPanel = () => {
    const frame = currentFrame();
    const list = currentDrafts();
    frameEl.textContent = list.length || store.state.snapshot ? `@ ${frameLabel(frame)}` : "";
    const annotate = !!store.state.annotate;
    emptyEl.textContent = !store.state.snapshot
      ? "Waiting for the project…"
      : list.length === 0
        ? (annotate ? "Click the frame for a point, drag for an area." : "Press N, then click the frame — or add a general note.")
        : "";
    emptyEl.hidden = emptyEl.textContent === "";
    listEl.innerHTML = list.map((d) => `
      <li class="nt-row${d.n === selectedN ? " is-selected" : ""}" data-n="${d.n}">
        <span class="nt-num">${d.n}</span>
        <div class="nt-main">
          <textarea class="nt-text" rows="2" placeholder="Note ${d.n}…" data-n="${d.n}">${escapeHtml(d.text)}</textarea>
          <div class="nt-els">${elementsHtml(d)}</div>
        </div>
        <button class="icon-btn nt-del" type="button" data-n="${d.n}" title="Delete note ${d.n}" aria-label="Delete note ${d.n}">
          <svg class="icon" viewBox="0 0 24 24"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>
        </button>
      </li>`).join("");
    for (const t of listEl.querySelectorAll(".nt-text")) {
      t.addEventListener("input", () => {
        const d = list.find((x) => x.n === Number(t.dataset.n));
        if (d) d.text = t.value;
        syncSendState();
      });
      t.addEventListener("focus", () => {
        selectedN = Number(t.dataset.n);
        for (const r of listEl.querySelectorAll(".nt-row")) r.classList.toggle("is-selected", Number(r.dataset.n) === selectedN);
        for (const [n, pin] of pinEls) pin.classList.toggle("is-selected", n === selectedN);
      });
    }
    for (const b of listEl.querySelectorAll(".nt-del")) {
      b.addEventListener("click", () => deleteDraft(Number(b.dataset.n)));
    }
    const otherFrames = [...drafts.keys()].filter((f) => f !== frame).length;
    syncSendState();
    renderSent(otherFrames);
  };

  const syncSendState = () => {
    const list = currentDrafts();
    const ready = !sending && list.length > 0 && list.every((d) => d.text.trim().length > 0);
    sendBtn.disabled = !ready;
    discardBtn.disabled = sending || list.length === 0;
    sendBtn.textContent = sending ? "Sending…" : `Send notes${list.length > 1 ? ` (${list.length})` : ""}`;
  };

  const renderSent = (otherFrames = 0) => {
    const rows = sent.map((p) => `
      <li class="nt-packet" data-status="${p.status}">
        <span class="nt-pcount mono">${p.count} note${p.count > 1 ? "s" : ""} · f${p.frame}</span>
        <span class="nt-status">${p.status === "waiting" ? "waiting for agent" : `delivered ${p.deliveredAt ?? ""}`}</span>
        ${p.status === "waiting" ? `<button class="nt-copy" type="button" data-id="${p.id}">Copy as text</button>` : ""}
      </li>`).join("");
    const extra = otherFrames > 0 ? `<li class="nt-other">${otherFrames} other frame${otherFrames > 1 ? "s" : ""} with drafts — seek there to send.</li>` : "";
    sentEl.innerHTML = rows + extra;
    for (const b of sentEl.querySelectorAll(".nt-copy")) {
      b.addEventListener("click", () => copyPacketText(b.dataset.id, b));
    }
  };

  const copyPacketText = async (id, btn) => {
    const p = sent.find((x) => x.id === id);
    if (!p) return;
    const text = p.lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // clipboard unavailable; the text stays visible in the packet
      }
      ta.remove();
    }
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = prev; }, 1500);
    }
  };

  const toLiveNote = (d) => {
    const { w, h } = stageSize();
    return {
      n: d.n,
      text: d.text.trim(),
      at_ms: Math.round(d.at_ms),
      frame: d.frame,
      ...(d.point
        ? { point: { x: Math.round(d.point.x * 10) / 10, y: Math.round(d.point.y * 10) / 10, nx: Math.round((d.point.x / Math.max(1, w)) * 10000) / 10000, ny: Math.round((d.point.y / Math.max(1, h)) * 10000) / 10000 } }
        : {}),
      ...(d.area ? { area: [Math.round(d.area[0] * 10) / 10, Math.round(d.area[1] * 10) / 10, Math.round(d.area[2] * 10) / 10, Math.round(d.area[3] * 10) / 10] } : {}),
      elements: d.elements ?? [],
      ...(d.overlap_px2 ? { overlap_px2: d.overlap_px2 } : {}),
    };
  };

  const sendCurrentFrame = async () => {
    const frame = currentFrame();
    const list = currentDrafts();
    if (sending || list.length === 0 || !list.every((d) => d.text.trim().length > 0)) return;
    sending = true;
    syncSendState();
    const notes = list.map(toLiveNote);
    let res = null;
    try {
      res = await api.post("/api/notes", { notes, revision: store.state.revision ?? 0 });
    } catch {
      res = null;
    }
    sending = false;
    if (!res || res.ok !== true || !res.id) {
      syncSendState();
      return;
    }
    sent.unshift({
      id: res.id,
      frame,
      count: notes.length,
      lines: notes.map(formatNoteLine),
      status: "waiting",
      sentAt: new Date().toISOString(),
      deliveredAt: null,
    });
    saveStoredSent();
    drafts.delete(frame);
    selectedN = null;
    renderPanel();
    rebuildPins(true);
  };

  // -- pins -----------------------------------------------------------------
  const rebuildPins = (force = false) => {
    const sig = `${currentFrame()}:${currentDrafts().map((d) => d.n).join(",")}`;
    if (!force && sig === pinSignature) return;
    pinSignature = sig;
    for (const [, el] of pinEls) el.remove();
    pinEls = new Map();
    layer.querySelectorAll(".nt-area").forEach((el) => el.remove());
    for (const d of currentDrafts()) {
      if (!d.point) continue; // general note: panel row only, no pin
      if (d.area) {
        const box = document.createElement("div");
        box.className = "nt-area";
        box.dataset.n = String(d.n);
        layer.appendChild(box);
      }
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "nt-pin";
      pin.dataset.n = String(d.n);
      pin.textContent = String(d.n);
      pin.title = `Note ${d.n} — select`;
      pin.classList.toggle("is-pending", d.elState === "pending" || d.elState === "loading");
      pin.classList.toggle("is-selected", d.n === selectedN);
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedN = d.n;
        for (const [, p] of pinEls) p.classList.toggle("is-selected", Number(p.dataset.n) === selectedN);
        renderPanel();
        const ta = listEl.querySelector(`.nt-text[data-n="${d.n}"]`);
        if (ta) ta.focus();
      });
      layer.appendChild(pin);
      pinEls.set(d.n, pin);
    }
    positionPins();
  };

  const positionPins = () => {
    const r = layerRect();
    if (!r) return;
    const { w, h } = stageSize();
    // Positions are relative to the layer, which exactly covers the stage rect.
    const local = { left: 0, top: 0, width: r.width, height: r.height };
    for (const d of currentDrafts()) {
      if (!d.point) continue;
      const pin = pinEls.get(d.n);
      if (pin) {
        const p = stageToClient(d.point.x, d.point.y, local, w, h);
        pin.style.left = `${p.x}px`;
        pin.style.top = `${p.y}px`;
      }
      if (d.area) {
        const box = layer.querySelector(`.nt-area[data-n="${d.n}"]`);
        if (box) {
          const a = stageToClient(d.area[0], d.area[1], local, w, h);
          const b = stageToClient(d.area[0] + d.area[2], d.area[1] + d.area[3], local, w, h);
          box.style.left = `${Math.min(a.x, b.x)}px`;
          box.style.top = `${Math.min(a.y, b.y)}px`;
          box.style.width = `${Math.abs(b.x - a.x)}px`;
          box.style.height = `${Math.abs(b.y - a.y)}px`;
        }
      }
    }
  };

  // -- pointer: click = point, drag = area -----------------------------------
  let gesture = null;
  layer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = layerRect();
    if (!r) return;
    const { w, h } = stageSize();
    const s = clientToStage(e.clientX, e.clientY, r, w, h);
    gesture = { startX: clamp(s.x, 0, w), startY: clamp(s.y, 0, h), dragging: false };
    layer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  layer.addEventListener("pointermove", (e) => {
    if (!gesture) return;
    const r = layerRect();
    if (!r) return;
    const { w, h } = stageSize();
    const s = clientToStage(e.clientX, e.clientY, r, w, h);
    const cx = clamp(s.x, 0, w);
    const cy = clamp(s.y, 0, h);
    if (!gesture.dragging) {
      // Drag threshold in client px, measured on the layer box.
      const a = stageToClient(gesture.startX, gesture.startY, { left: r.left, top: r.top, width: r.width, height: r.height }, w, h);
      if (Math.hypot(e.clientX - a.x, e.clientY - a.y) > 4) gesture.dragging = true;
    }
    if (gesture.dragging) {
      const a = stageToClient(Math.min(gesture.startX, cx), Math.min(gesture.startY, cy), { left: 0, top: 0, width: r.width, height: r.height }, w, h);
      const b = stageToClient(Math.max(gesture.startX, cx), Math.max(gesture.startY, cy), { left: 0, top: 0, width: r.width, height: r.height }, w, h);
      marquee.hidden = false;
      marquee.style.left = `${a.x}px`;
      marquee.style.top = `${a.y}px`;
      marquee.style.width = `${Math.max(1, b.x - a.x)}px`;
      marquee.style.height = `${Math.max(1, b.y - a.y)}px`;
      gesture.curX = cx;
      gesture.curY = cy;
    }
  });
  const endGesture = (e) => {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    marquee.hidden = true;
    const { w, h } = stageSize();
    if (g.dragging && g.curX !== undefined) {
      const x0 = clamp(Math.min(g.startX, g.curX), 0, w);
      const y0 = clamp(Math.min(g.startY, g.curY), 0, h);
      const x1 = clamp(Math.max(g.startX, g.curX), 0, w);
      const y1 = clamp(Math.max(g.startY, g.curY), 0, h);
      if (x1 - x0 >= 8 && y1 - y0 >= 8) {
        addDraft({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, [x0, y0, x1 - x0, y1 - y0]);
        return;
      }
      addDraft({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, undefined);
      return;
    }
    const r = layerRect();
    if (!r) return;
    const s = clientToStage(e.clientX, e.clientY, r, w, h);
    addDraft({ x: clamp(s.x, 0, w), y: clamp(s.y, 0, h) }, undefined);
  };
  layer.addEventListener("pointerup", endGesture);
  layer.addEventListener("pointercancel", () => {
    gesture = null;
    marquee.hidden = true;
  });

  // -- wiring ----------------------------------------------------------------
  root.querySelector(".nt-general")?.addEventListener("click", (e) => { e.stopPropagation(); addGeneralDraft(); });
  // Clicking the panel opens the note box (same as N): annotate on.
  root.addEventListener("pointerdown", (e) => {
    if (e.target?.closest?.("textarea,input,button")) return;
    if (!store.state.annotate) store.set({ annotate: true });
  }, true);
  sendBtn.addEventListener("click", () => void sendCurrentFrame());
  discardBtn.addEventListener("click", () => {
    drafts.delete(currentFrame());
    selectedN = null;
    renderPanel();
    rebuildPins(true);
  });
  // Note keys run through the shared shortcut table (shortcuts.js). The send
  // chord must also fire while typing, so it compares chords directly.
  let shortcutMap = { ...DEFAULT_SHORTCUTS };
  loadShortcuts(api).then((m) => { shortcutMap = m; }).catch(() => { /* defaults stand */ });
  store.on("settings", (view) => {
    try {
      const entry = (view?.settings ?? []).find((s) => s.key === "live.shortcuts");
      if (entry?.value && typeof entry.value === "object") shortcutMap = resolveShortcuts(entry.value);
    } catch { /* keep the last good map */ }
  });
  root.addEventListener("keydown", (e) => {
    if (eventChord(e) === shortcutMap["send-notes"]) {
      e.preventDefault();
      void sendCurrentFrame();
    }
  });
  window.addEventListener("keydown", (e) => {
    if (matchShortcut(shortcutMap, e, "new-note")) {
      e.preventDefault();
      store.set({ annotate: !store.state.annotate });
    }
  });

  // The sent list survives reloads: waiting packets are re-read from the
  // server inbox, delivered ones from local storage (the server exposes no
  // delivered list).
  const sentStoreKey = () => `cuthol.live.sent.v1.${store.state.snapshot?.project?.dir ?? "default"}`;
  const loadStoredSent = () => {
    try {
      const arr = JSON.parse(localStorage.getItem(sentStoreKey()) ?? "[]");
      return Array.isArray(arr) ? arr.filter((e) => e?.id) : [];
    } catch {
      return [];
    }
  };
  const saveStoredSent = () => {
    try {
      localStorage.setItem(sentStoreKey(), JSON.stringify(sent.slice(0, 30)));
    } catch {
      // private mode: the session list still works
    }
  };
  let inboxLoading = false;
  const restoreFromInbox = async () => {
    if (inboxLoading) return;
    inboxLoading = true;
    try {
      const packets = await api.get("/api/inbox");
      if (!Array.isArray(packets)) return;
      const withNotes = packets.filter((p) => (p?.notes?.length ?? 0) > 0);
      const candidates = [...sent];
      for (const s of loadStoredSent()) {
        if (!candidates.some((c) => c.id === s.id)) candidates.push(s);
      }
      const next = mergeRestoredSent(withNotes, candidates);
      sent.length = 0;
      sent.push(...next);
      saveStoredSent();
      renderSent();
    } catch {
      // offline: keep the session list
    } finally {
      inboxLoading = false;
    }
  };

  // Notes events carry the packets the agent has NOT read yet; a sent id that
  // disappears from the list was delivered.
  store.on("notes", (packets) => {
    const pending = new Set((packets ?? []).map((p) => p.id));
    let changed = false;
    for (const p of sent) {
      if (p.status === "waiting" && !pending.has(p.id)) {
        p.status = "delivered";
        p.deliveredAt = new Date().toTimeString().slice(0, 5);
        changed = true;
      }
    }
    if (changed) {
      saveStoredSent();
      renderSent();
    }
  });

  let lastFrame = -1;
  const onState = () => {
    const annotate = !!store.state.annotate;
    if (annotate && store.state.playing) store.set({ playing: false });
    const frame = currentFrame();
    if (frame !== lastFrame) {
      lastFrame = frame;
      selectedN = null;
      renderPanel();
      rebuildPins(true);
    }
  };
  store.on("state", onState);
  store.on("playhead", onState);
  store.on("snapshot", () => {
    lastFrame = -1;
    onState();
    void restoreFromInbox();
  });
  store.on("delta", () => renderPanel());

  const tick = () => {
    rafId = requestAnimationFrame(tick);
    if (!store.state.annotate || !store.state.snapshot) {
      if (!layer.hidden) layer.hidden = true;
      return;
    }
    const r = syncLayerBox();
    if (r) {
      rebuildPins(false);
      positionPins();
    }
  };
  rafId = requestAnimationFrame(tick);

  // Test hook: drafts and sent packets without touching the DOM.
  window.__liveNotes = {
    drafts: () => [...drafts.entries()].map(([frame, list]) => ({ frame, notes: list.map((d) => ({ ...d })) })),
    sent: () => sent.map((p) => ({ ...p })),
    send: () => sendCurrentFrame(),
  };

  renderPanel();
}
