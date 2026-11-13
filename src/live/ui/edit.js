// Human editing: the Activity-header Pause/Resume button, click delegation for
// every [data-edit-action] button (timeline toolbar), extra toolbar buttons
// (mute/undo/redo), and a drag-handle overlay on the timeline.
// All edits go through POST /api/edit; the window never writes the sequence.
const ICONS = {
  pause: '<path d="M9 5 L9 19 M15 5 L15 19"/>',
  play: '<path d="M8 5 L18 12 L8 19 Z"/>',
  undo: '<path d="M7 5 L3 9 L7 13"/><path d="M3 9 H14 A6 6 0 0 1 14 21 H10"/>',
  redo: '<path d="M17 5 L21 9 L17 13"/><path d="M21 9 H10 A6 6 0 0 0 10 21 H14"/>',
  mute: '<path d="M4 10 V14 H8 L13 19 V5 L8 10 Z"/><path d="M16.5 9.5 L21.5 14.5 M21.5 9.5 L16.5 14.5"/>',
};

/**
 * A failed edit response as a short toast line: known boundary failures get a
 * plain sentence, otherwise the diagnostic code, server prefix and suggestion
 * are stripped and the rest is truncated.
 */
export function friendlyEditError(res) {
  const raw = String(res?.message ?? res?.note ?? "request failed");
  const unprefixed = raw.replace(/^Live edit '[^']*' on '[^']*' failed:\s*/i, "");
  const m = /^\[CUTHOL-[A-Z0-9-]+\]\s*(.*?)(?:\s*\|\s*Suggestion:.*)?$/s.exec(unprefixed);
  const what = (m ? m[1] : unprefixed.replace(/\s*\|\s*Suggestion:.*$/s, ""))
    .replace(/^Live edit '[^']*' was not applied:\s*/i, "")
    .trim();
  if (/no further revision to go to in the 'redo' direction|^nothing to redo\b/i.test(what)) return "Nothing to redo";
  if (/no further revision to go to in the 'undo' direction|^nothing to undo\b/i.test(what)) return "Nothing to undo";
  if (!what) return "Edit failed";
  return what.length > 160 ? `${what.slice(0, 157)}…` : what;
}

/** @param {HTMLElement|null} root  @param {import('./app.js').LiveContext} ctx */
export function mount(root, ctx) {
  void root; // this region injects into the top bar and the timeline; it owns no panel
  const store = ctx.store;
  const st = () => store.state;

  // --- toast ---------------------------------------------------------------
  const toastEl = document.createElement("div");
  toastEl.className = "ed-toast";
  toastEl.setAttribute("role", "status");
  document.body.appendChild(toastEl);
  let toastTimer = null;
  const toast = (text, ms = 4500) => {
    toastEl.textContent = String(text ?? "");
    toastEl.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  };
  const shortDiagnostic = (res) => friendlyEditError(res);

  // --- mode: nobody else writes "human" into the store, so the lock watcher
  // here derives it (see the report: contract gap). Offline is never overridden.
  const syncMode = () => {
    if (st().mode === "offline") {
      updateButtons();
      return;
    }
    const want = st().lock?.holder === "human" ? "human" : "agent";
    if (st().mode !== want) store.set({ mode: want });
    else updateButtons();
  };

  // --- Pause / Resume ------------------------------------------------------
  // The single Pause/Resume button lives in the Activity header (region C),
  // next to the agent state dot — never in the top bar.
  const actionsBox = document.getElementById("ac-pause-slot") ?? document.getElementById("topbar-actions");
  const pauseBtn = document.createElement("button");
  pauseBtn.className = "btn ed-pause";
  actionsBox?.appendChild(pauseBtn);
  let lockBusy = false;
  async function setPaused(paused) {
    if (lockBusy) return;
    lockBusy = true;
    updateButtons();
    try {
      await ctx.api.post("/api/lock", { holder: paused ? "human" : "agent" });
      if (paused) {
        armedLastStep = true;
      } else {
        armedLastStep = false;
      }
    } catch (e) {
      toast("Could not reach the server");
    } finally {
      lockBusy = false;
      updateButtons();
    }
  }

  function updateButtons() {
    const mode = st().mode;
    const human = mode === "human";
    const offline = mode === "offline";
    pauseBtn.disabled = offline || lockBusy;
    pauseBtn.innerHTML = human
      ? `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS.play}</svg><span>Resume</span>`
      : `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS.pause}</svg><span>Pause agent</span>`;
    pauseBtn.title = human ? "Resume the agent (your edits are queued for it)" : "Pause the agent and edit the timeline yourself";
    // The timeline toggles its own buttons too; the same values keep both in sync.
    for (const b of document.querySelectorAll("[data-edit-action]")) {
      const pause = b.dataset.editAction === "pause";
      const disabled = pause ? offline || lockBusy : !human;
      if (b.disabled !== disabled) b.disabled = disabled;
      b.setAttribute("aria-disabled", disabled ? "true" : "false");
    }
    layer.style.display = human && !drag && !editBusy ? "" : "none";
  }
  pauseBtn.addEventListener("click", () => setPaused(st().mode !== "human"));

  // First revision after Pause: an agent entry means one write slipped through.
  // (The "delta" payload is the store patch, not the LiveDelta, so the entry
  // is read from the activity head the delta just prepended.)
  let armedLastStep = st().lock?.holder === "human";
  store.on("delta", () => {
    if (armedLastStep) {
      armedLastStep = false;
      const entry = st().activity?.[0];
      if (entry && entry.actor === "agent") toast(`Agent finished one last step (r${entry.revision})`);
    }
  });

  // --- edit requests -------------------------------------------------------
  let editBusy = false;
  async function runEdit(body) {
    if (editBusy) return false;
    editBusy = true;
    updateButtons();
    try {
      const res = await ctx.api.post("/api/edit", { ...body, expect_rev: st().revision });
      if (res && res.ok) return true;
      toast(shortDiagnostic(res));
      return false;
    } catch (e) {
      toast("Edit failed: no response from the server");
      return false;
    } finally {
      editBusy = false;
      updateButtons();
      rebuildOverlay();
    }
  }

  // --- selection helpers ---------------------------------------------------
  const sequence = () => st().sequence;
  const clips = () => sequence()?.spine?.clips ?? [];
  const findClip = (id) => clips().find((c) => c?.id === id) ?? null;
  const findCue = (id) => {
    for (const lane of sequence()?.lanes ?? []) {
      const cue = (lane?.cues ?? []).find((q) => q?.id === id);
      if (cue) return { cue, lane };
    }
    return null;
  };
  const cueStart = (cue) => {
    if (cue?.anchor?.ref) {
      const clip = findClip(cue.anchor.ref);
      if (clip) return (clip.timeline_in_ms ?? 0) + (cue.anchor.offset_ms ?? 0);
    }
    return cue?.at_ms ?? 0;
  };
  const clipAtPlayhead = () => {
    const ph = st().playheadMs ?? 0;
    return clips().find((c) => ph >= (c.timeline_in_ms ?? 0) && ph < (c.timeline_in_ms ?? 0) + (c.duration_ms ?? 0)) ?? null;
  };
  const selectionTarget = () => {
    const sel = st().selection;
    if (!sel) return null;
    if (sel.kind === "clip" && findClip(sel.id)) return { id: sel.id, kind: "clip" };
    if (sel.kind === "cue" && findCue(sel.id)) return { id: sel.id, kind: "cue" };
    // Fall back to the id when the kind is missing or stale.
    if (findClip(sel.id)) return { id: sel.id, kind: "clip" };
    if (findCue(sel.id)) return { id: sel.id, kind: "cue" };
    return null;
  };
  const isMuted = (t) => {
    if (t.kind === "cue") return !!findCue(t.id)?.cue?.audio_chain?.muted;
    const clip = findClip(t.id);
    const env = (clip?.envelopes ?? []).find((e) => e?.parameter === "audio_chain.gain_db");
    return !!env && env.points.length > 0 && env.points.every((p) => (p?.value ?? 0) <= -30);
  };

  async function handleAction(action) {
    if (action === "pause") {
      setPaused(st().mode !== "human");
      return;
    }
    if (st().mode !== "human") return;
    if (action === "split") {
      const clip = clipAtPlayhead();
      if (!clip) {
        toast("Move the playhead over a clip to split it");
        return;
      }
      await runEdit({ action: "split", target: clip.id, params: { at_ms: Math.round(st().playheadMs ?? 0) } });
      return;
    }
    if (action === "delete") {
      const t = selectionTarget();
      if (!t) {
        toast("Select a clip or cue to delete it");
        return;
      }
      await runEdit({ action: "delete", target: t.id });
      return;
    }
    if (action === "mute") {
      const t = selectionTarget();
      if (!t) {
        toast("Select a clip or cue to mute it");
        return;
      }
      await runEdit({ action: "mute", target: t.id, params: { muted: !isMuted(t) } });
      return;
    }
    if (action === "undo" || action === "redo") {
      await runEdit({ action });
      return;
    }
    toast(`${action[0].toUpperCase()}${action.slice(1)} is not available in this version`);
  }

  document.addEventListener("click", (ev) => {
    const el = ev.target instanceof Element ? ev.target.closest("[data-edit-action]") : null;
    if (!el || el.disabled) return;
    void handleAction(el.dataset.editAction);
  });

  // --- why the edit tools are off: disabled buttons let the pointer through
  // (edit.css), so the toolbar finds the button under it and shows a hint.
  const hintEl = document.createElement("div");
  hintEl.className = "ed-hint";
  hintEl.setAttribute("role", "status");
  document.body.appendChild(hintEl);
  const hintText = () => {
    const mode = st().mode;
    if (mode === "offline") return "Not connected to Cuthol";
    if (mode === "render") return "Editing is off while a render runs";
    return "Pause the agent to edit";
  };
  const hideHint = () => hintEl.classList.remove("show");
  const hintToolbar = document.querySelector('[data-region="timeline"] .tl-toolbar');
  hintToolbar?.addEventListener("pointermove", (ev) => {
    const over = [...hintToolbar.querySelectorAll("[data-edit-action]")].find((b) => {
      if (!b.disabled) return false;
      const r = b.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    });
    if (!over) return hideHint();
    const label = over.getAttribute("aria-label") ?? "";
    hintEl.innerHTML =
      `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS.pause}</svg>` +
      `<span>${label ? `${label}: ` : ""}${hintText()}</span>`;
    const r = over.getBoundingClientRect();
    hintEl.classList.add("show");
    const w = hintEl.offsetWidth;
    hintEl.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
    hintEl.style.top = `${r.bottom + 6}px`;
  });
  hintToolbar?.addEventListener("pointerleave", hideHint);
  store.on("lock", hideHint);

  // --- extra toolbar buttons (mute/undo/redo live in the timeline toolbar;
  // B owns the file, so they are injected here and handled by delegation) ---
  const tlRegion = document.querySelector('[data-region="timeline"]');
  const toolbar = tlRegion?.querySelector(".tl-toolbar");
  if (toolbar && !toolbar.querySelector("[data-edit-action='mute']")) {
    const anchor = toolbar.querySelector(".tl-mode");
    const mk = (action, label, icon) => {
      const b = document.createElement("button");
      b.className = "icon-btn";
      b.dataset.editAction = action;
      b.title = label;
      b.setAttribute("aria-label", label);
      b.disabled = true;
      b.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
      return b;
    };
    const sep = document.createElement("span");
    sep.className = "ed-sep";
    sep.setAttribute("aria-hidden", "true");
    toolbar.insertBefore(sep, anchor);
    toolbar.insertBefore(mk("mute", "Mute", ICONS.mute), anchor);
    toolbar.insertBefore(mk("undo", "Undo my edit", ICONS.undo), anchor);
    toolbar.insertBefore(mk("redo", "Redo my edit", ICONS.redo), anchor);
  }

  // --- drag handles over the timeline ---------------------------------------
  // The timeline exposes no scale mapping, so geometry is measured from the
  // DOM (see the report: contract wish). Overlay coordinates are content
  // coordinates: x = t * pxPerMs, y from the track canvas rects.
  const scrollEl = tlRegion?.querySelector(".tl-scroll") ?? null;
  const contentEl = tlRegion?.querySelector(".tl-content") ?? null;
  const layer = document.createElement("div");
  layer.className = "ed-layer";
  layer.style.display = "none";
  contentEl?.appendChild(layer);
  let drag = null;

  const fps = () => Math.max(1, Math.round(st().snapshot?.project?.fps ?? 30));
  const frameMs = () => 1000 / fps();
  const snapFrame = (t) => Math.round(t / frameMs()) * frameMs();

  function durationMs() {
    let d = 1000;
    for (const c of clips()) d = Math.max(d, (c.timeline_in_ms ?? 0) + (c.duration_ms ?? 0));
    for (const lane of sequence()?.lanes ?? []) {
      for (const q of lane?.cues ?? []) d = Math.max(d, cueStart(q) + (q.duration_ms ?? 0));
    }
    return d;
  }

  function measureScale() {
    if (!contentEl || !scrollEl) return null;
    // Exact when the playhead is off zero: B positions it at playheadMs * pxPerMs.
    const ph = st().playheadMs ?? 0;
    const phEl = tlRegion.querySelector(".tl-playhead");
    if (ph > 0 && phEl) {
      const m = /matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([-\d.]+)/.exec(getComputedStyle(phEl).transform ?? "");
      if (m) {
        const ppm = Number(m[1]) / ph;
        if (ppm > 0 && Number.isFinite(ppm)) return ppm;
      }
    }
    const w = contentEl.clientWidth - 24;
    const ppm = w / Math.max(1, durationMs());
    return ppm > 0 && Number.isFinite(ppm) ? ppm : null;
  }

  function rowRect(trackKey, contentRect) {
    const cv = tlRegion.querySelector(`canvas[data-track="${CSS.escape(trackKey)}"]`);
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    return { y: r.top - contentRect.top, h: cv.clientHeight || r.height };
  }

  function selectedSpan() {
    const t = selectionTarget();
    if (!t) return null;
    if (t.kind === "clip") {
      const clip = findClip(t.id);
      if (!clip) return null;
      return { id: t.id, kind: "clip", start: clip.timeline_in_ms ?? 0, end: (clip.timeline_in_ms ?? 0) + (clip.duration_ms ?? 0), track: "spine" };
    }
    const found = findCue(t.id);
    if (!found) return null;
    const start = cueStart(found.cue);
    return { id: t.id, kind: "cue", start, end: start + (found.cue.duration_ms ?? 0), track: found.lane.id };
  }

  function rebuildOverlay() {
    if (!contentEl) return;
    layer.replaceChildren();
    drag = null;
    if (st().mode !== "human" || editBusy) {
      layer.style.display = "none";
      return;
    }
    const span = selectedSpan();
    const ppm = measureScale();
    if (!span || !ppm) {
      layer.style.display = "none";
      return;
    }
    const contentRect = contentEl.getBoundingClientRect();
    const row = rowRect(span.track, contentRect);
    if (!row) {
      layer.style.display = "none";
      return;
    }
    layer.style.display = "";
    const mkHandle = (cls, x, w, cursor, data) => {
      const h = document.createElement("div");
      h.className = `ed-handle ${cls}`;
      h.dataset.edHandle = data;
      h.style.left = `${x}px`;
      h.style.top = `${row.y + 5}px`;
      h.style.width = `${w}px`;
      h.style.height = `${Math.max(8, row.h - 10)}px`;
      h.style.cursor = cursor;
      h.addEventListener("pointerdown", (ev) => startDrag(ev, span, ppm, data));
      layer.appendChild(h);
    };
    const x0 = span.start * ppm;
    const x1 = span.end * ppm;
    const edgeW = Math.min(12, Math.max(8, (x1 - x0) / 4));
    if (span.kind === "clip") {
      mkHandle("ed-edge", x0 - edgeW / 2, edgeW, "ew-resize", "trim-in");
      mkHandle("ed-edge", x1 - edgeW / 2, edgeW, "ew-resize", "trim-out");
    } else {
      mkHandle("ed-edge", x0 - edgeW / 2, edgeW, "ew-resize", "cue-in");
      mkHandle("ed-body", x0 + edgeW / 2, Math.max(4, x1 - x0 - edgeW), "move", "cue-move");
      mkHandle("ed-edge", x1 - edgeW / 2, edgeW, "ew-resize", "cue-out");
    }
  }

  function startDrag(ev, span, ppm, what) {
    if (editBusy) return;
    ev.stopPropagation();
    ev.preventDefault();
    const ghost = document.createElement("div");
    ghost.className = "ed-ghost";
    layer.appendChild(ghost);
    const frame = frameMs();
    drag = { span, ppm, what, x0: ev.clientX, ghost };
    const target = ev.currentTarget;
    try {
      target.setPointerCapture(ev.pointerId);
    } catch {
      // capture is best-effort
    }
    const move = (e) => {
      if (!drag) return;
      const dt = (e.clientX - drag.x0) / ppm;
      let g0 = span.start;
      let g1 = span.end;
      if (what === "trim-in" || what === "cue-in") g0 = snapFrame(span.start + dt);
      else if (what === "trim-out" || what === "cue-out") g1 = snapFrame(span.end + dt);
      else {
        const d = snapFrame(span.start + dt) - span.start;
        g0 = span.start + d;
        g1 = span.end + d;
      }
      // Clamp inside sane bounds; the server validates strictly.
      if (what === "trim-in" || what === "trim-out") {
        g0 = Math.min(Math.max(g0, span.start), span.end - frame);
        g1 = Math.max(Math.min(g1, span.end), span.start + frame);
      } else if (what === "cue-in") {
        g0 = Math.min(Math.max(g0, 0), span.end - frame);
      } else if (what === "cue-out") {
        g1 = Math.max(g1, span.start + frame);
      } else {
        if (g0 < 0) {
          g1 -= g0;
          g0 = 0;
        }
      }
      drag.g0 = g0;
      drag.g1 = g1;
      const contentRect = contentEl.getBoundingClientRect();
      const row = rowRect(span.track, contentRect) ?? { y: 0, h: 44 };
      ghost.style.left = `${g0 * ppm}px`;
      ghost.style.top = `${row.y + 5}px`;
      ghost.style.width = `${Math.max(2, (g1 - g0) * ppm)}px`;
      ghost.style.height = `${Math.max(8, row.h - 10)}px`;
    };
    const up = async () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      const d = drag;
      drag = null;
      ghost.remove();
      if (!d || d.g0 === undefined) {
        rebuildOverlay();
        return;
      }
      const changed = what === "cue-move" ? d.g0 !== span.start : what.endsWith("in") ? d.g0 !== span.start : d.g1 !== span.end;
      if (!changed) {
        rebuildOverlay();
        return;
      }
      let body = null;
      if (what === "trim-in") body = { action: "trim", target: span.id, params: { edge: "in", to_ms: Math.round(d.g0) } };
      else if (what === "trim-out") body = { action: "trim", target: span.id, params: { edge: "out", to_ms: Math.round(d.g1) } };
      else if (what === "cue-move") body = { action: "move-cue", target: span.id, params: { to_ms: Math.round(d.g0) } };
      else if (what === "cue-out") body = { action: "cue-duration", target: span.id, params: { duration_ms: Math.round(d.g1 - span.start) } };
      else if (what === "cue-in") body = { action: "move-cue", target: span.id, params: { to_ms: Math.round(d.g0), duration_ms: Math.round(d.g1 - d.g0) } };
      if (body) await runEdit(body);
      else rebuildOverlay();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  // --- wiring --------------------------------------------------------------
  // The Activity header owns the pause button, so buttons are re-synced
  // after every one of these events.
  store.on("snapshot", () => { syncMode(); rebuildOverlay(); });
  store.on("lock", syncMode);
  store.on("connection", syncMode);
  store.on("delta", () => { updateButtons(); rebuildOverlay(); });
  store.on("progress", updateButtons);
  store.on("state", (patch) => {
    if (!patch) return;
    if ("mode" in patch) {
      updateButtons();
      rebuildOverlay();
    } else if ("selection" in patch || "sequence" in patch) rebuildOverlay();
    else if ("playheadMs" in patch && !drag) rebuildOverlay();
  });
  scrollEl?.addEventListener("scroll", () => { if (!drag) rebuildOverlay(); });
  tlRegion?.querySelector(".tl-zoom")?.addEventListener("input", () => rebuildOverlay());
  if (scrollEl && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => { if (!drag) rebuildOverlay(); }).observe(scrollEl);
  }

  syncMode();
  rebuildOverlay();
}
