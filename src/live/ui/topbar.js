// Top bar: the window's fixed control area. Left: logo + project name.
// Right: render status pill + settings. The pill shows idle / percent·ETA /
// done / failed; clicking it opens the stage breakdown (the old render
// region's data, including progress.error).
/**
 * Stage state as shown. A stage still marked running after the render failed
 * is the stage that failed (older writers never flip it), so it shows failed.
 */
export function displayStageState(overall, stage) {
  if (overall === "failed" && stage === "running") return "failed";
  return stage ?? "queued";
}

/** `done/total` counter for a stage with measurable units, else "". */
export function stageProgressText(stage) {
  const done = stage?.done;
  const total = stage?.total;
  if (typeof done !== "number" || typeof total !== "number" || total <= 0) return "";
  return `${done}/${total}`;
}

/** @param {HTMLElement|null} root  @param {import('./app.js').LiveContext} ctx */
export function mount(root, ctx) {
  if (!root) return;
  const store = ctx.store;
  root.innerHTML = `
    <div class="tb-brand" title="Cuthol Live">
      <svg width="26" height="26" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="30" fill="none" stroke="var(--text-1)" stroke-width="17" stroke-dasharray="160 30" transform="rotate(30 50 50)"/><path d="M44 38 L62 50 L44 62 Z" fill="var(--text-1)"/></svg>
    </div>
    <div class="tb-project"><span id="project-title">Cuthol Live</span></div>
    <div class="spacer"></div>
    <button class="tb-pill" id="render-pill" data-state="idle" type="button" aria-haspopup="true" aria-expanded="false">
      <span class="tb-dot"></span><span id="render-pill-text">Render idle</span>
    </button>
    <button class="icon-btn" id="btn-settings" title="Settings" aria-label="Settings">
      <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
    </button>
    <div class="tb-pop" id="render-pop" hidden></div>`;

  const settingsBtn = root.querySelector("#btn-settings");
  if (settingsBtn && !settingsBtn.dataset.stWired) {
    settingsBtn.dataset.stWired = "1";
    let panel = null;
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (panel) { panel.open(); return; }
      import("./settings.js").then((m) => { panel = m.mount(null, ctx); panel.open(); }).catch(() => {});
    });
  }
  const pill = root.querySelector("#render-pill");
  const text = root.querySelector("#render-pill-text");
  const pop = root.querySelector("#render-pop");

  const fmtDur = (sec) => {
    if (sec == null || !Number.isFinite(sec)) return "—";
    const s = Math.max(0, Math.round(sec));
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    return `${h}:${m}:${String(s % 60).padStart(2, "0")}`;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function render() {
    const p = store.state.progress;
    let state = "idle";
    let label = "Render idle";
    if (p) {
      const pct = Math.round(100 * (p.state === "done" ? 1 : Math.min(1, Math.max(0, p.fraction ?? 0))));
      if (p.state === "running") {
        state = "running";
        label = `${p.preset} ${pct}% · ${fmtDur(p.eta_sec)}`;
      } else if (p.state === "done") {
        state = "done";
        label = `Done ${pct}%`;
      } else if (p.state === "failed") {
        state = "failed";
        label = "Render failed";
      } else if (p.state === "cancelled") {
        state = "idle";
        label = "Render cancelled";
      }
    }
    pill.dataset.state = state;
    text.textContent = label;
    if (!pop.hidden) renderPop();
  }

  function renderPop() {
    const p = store.state.progress;
    if (!p) {
      pop.innerHTML = `<div class="tb-pop-empty">No render yet</div>`;
      return;
    }
    const pct = Math.round(100 * (p.state === "done" ? 1 : Math.min(1, Math.max(0, p.fraction ?? 0))));
    const stages = (p.stages ?? []).map((s) => {
      const shown = displayStageState(p.state, s.state);
      const count = stageProgressText(s);
      return `<li class="tb-stage-${esc(shown)}">${esc(s.name)}${count ? esc(` ${count}`) : ""}</li>`;
    }).join("");
    const err = p.state === "failed" && p.error
      ? `<div class="tb-err"><span class="mono">${esc(p.error.code ?? "error")}</span> ${esc(p.error.message ?? "")}</div>`
      : "";
    pop.innerHTML =
      `<div class="tb-pop-head">${esc(p.preset)} · ${pct}% · ETA ${esc(fmtDur(p.eta_sec))} · elapsed ${esc(fmtDur(p.elapsed_sec))}</div>` +
      `<ul class="tb-stages">${stages}</ul>${err}`;
  }

  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    pill.setAttribute("aria-expanded", String(!pop.hidden));
    if (!pop.hidden) renderPop();
  });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !pop.contains(e.target)) {
      pop.hidden = true;
      pill.setAttribute("aria-expanded", "false");
    }
  });

  store.on("snapshot", render);
  store.on("progress", render);
  store.on("delta", render);
  render();
}
