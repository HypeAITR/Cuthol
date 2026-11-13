// Activity feed: agent revisions newest first. The header carries the agent
// state dot and the Pause/Resume button (the pause button itself is mounted
// here by the edit region). Rows show revision, clip tag and timecode;
// clicking a row selects the clip and moves the playhead to it.
//
// State dot (never text alone):
//   working = agent holds the lock (or no lock yet) and the newest agent
//             revision is fresh (< 90 s old)      → solid amber
//   paused  = the human holds the lock           → blinking gray pause glyph
//   error   = disconnected, or the render failed → red triangle
//   idle    = anything else                      → hollow ring
/** @param {HTMLElement|null} root  @param {import('./app.js').LiveContext} ctx */
export function mount(root, ctx) {
  if (!root) return;
  root.innerHTML = `
    <div class="panel-head"><span class="ac-dot" data-acstate="idle" title="Agent state"><svg viewBox="0 0 12 12" aria-hidden="true"><circle class="ac-ring" cx="6" cy="6" r="4"/><circle class="ac-fill" cx="6" cy="6" r="4"/><path class="ac-bars" d="M4.5 3.5 V8.5 M7.5 3.5 V8.5"/><path class="ac-tri" d="M4.5 2.8 L8.8 6 L4.5 9.2 Z"/></svg></span>Activity<span class="spacer"></span><span id="ac-pause-slot"></span></div>
    <div class="panel-body ac-list"></div>`;
  const list = root.querySelector(".ac-list");
  let seenMaxRev = 0;
  let fadeGen = 0;

  const cueStartMs = (seq, cue) => {
    if (!cue?.anchor?.ref) return cue?.at_ms ?? 0;
    const clip = seq?.spine?.clips?.find((c) => c.id === cue.anchor.ref);
    return clip ? clip.timeline_in_ms + (cue.anchor.offset_ms ?? 0) : cue.at_ms ?? 0;
  };

  function locate(seq, id) {
    const clip = seq?.spine?.clips?.find((c) => c.id === id);
    if (clip) return { id, kind: "clip", atMs: clip.timeline_in_ms ?? 0, tag: clip.asset_handle ?? clip.id };
    for (const lane of seq?.lanes ?? []) {
      const cue = lane?.cues?.find((q) => q.id === id);
      if (cue) return { id, kind: "cue", atMs: cueStartMs(seq, cue), tag: cue.id };
    }
    return null;
  }

  const timecode = (ms) => {
    const f = Math.max(1, Math.round(ctx.store.state.snapshot?.project?.fps ?? 30));
    const totalFrames = Math.max(0, Math.floor((ms / 1000) * f));
    const ff = totalFrames % f;
    const s = Math.floor(totalFrames / f);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}:${p(ff)}`;
  };

  /** Newest agent revision and its age; the dot's working/idle split. */
  function agentState() {
    const { activity, lock, mode, progress } = ctx.store.state;
    if (mode === "offline") return "error";
    if (progress && progress.state === "failed") return "error";
    if (lock?.holder === "human" || mode === "human") return "paused";
    const latest = (activity ?? []).find((e) => e.actor === "agent");
    if (!latest) return "idle";
    const age = Date.now() - Date.parse(latest.timestamp ?? 0);
    if (!Number.isFinite(age) || age > 90000) return "idle";
    return "working";
  }

  function render() {
    const { activity } = ctx.store.state;
    const prevMax = seenMaxRev;
    for (const e of activity ?? []) seenMaxRev = Math.max(seenMaxRev, e.revision ?? 0);
    const dot = root.querySelector(".ac-dot");
    if (dot) dot.dataset.acstate = agentState();
    const paused = agentState() === "paused";
    list.innerHTML = "";
    if (!activity?.length) {
      list.innerHTML = `<div class="ac-empty muted">No edits yet</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    activity.forEach((entry, i) => {
      const row = document.createElement("button");
      row.className = "ac-row";
      row.type = "button";
      const first = (entry.changed ?? [])[0];
      const hit = first ? locate(ctx.store.state.sequence, first) : null;
      row.innerHTML =
        (paused && i === 0 ? `<span class="ac-paused" title="Agent paused"></span>` : "") +
        `<span class="ac-rev mono">r${entry.revision}</span>` +
        `<span class="ac-tag">${escapeHtml(hit?.tag ?? entry.summary ?? entry.operation ?? "")}</span>` +
        `<span class="ac-tc dim mono">${hit ? timecode(hit.atMs) : ""}</span>`;
      if ((entry.revision ?? 0) > prevMax && prevMax > 0) row.classList.add("is-changed");
      row.title = `${entry.summary ?? entry.operation ?? ""} · ${entry.timestamp ?? ""}`;
      if (hit) {
        row.addEventListener("click", () => {
          ctx.store.set({ selection: { id: hit.id, kind: hit.kind }, playheadMs: hit.atMs });
        });
      } else {
        row.disabled = true;
      }
      frag.appendChild(row);
    });
    list.appendChild(frag);
    const gen = ++fadeGen;
    if (list.querySelector(".is-changed")) {
      setTimeout(() => {
        if (gen !== fadeGen) return;
        for (const el of list.querySelectorAll(".is-changed")) el.classList.remove("is-changed");
      }, 1000);
    }
  }

  ctx.store.on("snapshot", render);
  ctx.store.on("delta", render);
  ctx.store.on("lock", render);
  ctx.store.on("progress", render);
  ctx.store.on("connection", render);
  ctx.store.on("state", (patch) => { if (!patch || "activity" in patch) render(); });
  render();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
