// Settings panel: modal opened by the top-bar gear. Sections Render,
// Storage, Live, Shortcuts, About share the window's tokens; no gradients.
// Reads GET /api/settings, writes POST /api/settings, refreshes on the
// server's "settings" broadcast. Prefix: .st-
import {
  SHORTCUT_LABELS,
  chordLabel,
  eventChord,
  resolveShortcuts,
  shortcutActions,
  shortcutConflicts,
} from "./shortcuts.js";

const SECTIONS = [
  { id: "render", label: "Render" },
  { id: "storage", label: "Storage" },
  { id: "live", label: "Live" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "about", label: "About" },
];

const SECTION_OF = {
  "render.encoder": "render",
  "render.gpu": "render",
  "render.workers": "render",
  "render.overlay_concurrency": "render",
  "render.stall_timeout_sec": "render",
  "render.output_dir": "storage",
  "cache.dir": "storage",
  "live.mode": "live",
  "live.browser": "live",
  "live.shortcuts": "shortcuts",
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** @param {HTMLElement|null} _root unused (panel floats over the workspace) @param {import('./app.js').LiveContext} ctx */
export function mount(_root, ctx) {
  const { store, api } = ctx;
  let overlay = null;
  let activeSection = "render";
  let view = null;
  let loading = false;
  let captureAction = null;
  let toastTimer = 0;

  async function refresh() {
    loading = true;
    try {
      view = await api.get("/api/settings");
    } catch {
      view = null;
    }
    loading = false;
    if (overlay) renderBody();
  }

  function open() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "st-overlay";
    overlay.innerHTML = `
      <div class="st-modal" role="dialog" aria-label="Settings">
        <div class="st-head">
          <span class="st-title">Settings</span>
          <button class="icon-btn st-close" aria-label="Close settings"><svg class="icon" viewBox="0 0 24 24"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button>
        </div>
        <div class="st-main">
          <nav class="st-nav" aria-label="Sections"></nav>
          <div class="st-body"></div>
        </div>
        <div class="st-toast" hidden></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector(".st-close").addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".st-nav").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-section]");
      if (btn) { activeSection = btn.dataset.section; renderBody(); }
    });
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keydown", onCapture, true);
    void refresh();
    renderBody();
  }

  function close() {
    if (!overlay) return;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("keydown", onCapture, true);
    overlay.remove();
    overlay = null;
    captureAction = null;
  }

  function onKey(e) {
    if (e.key === "Escape" && !captureAction) { e.stopPropagation(); close(); }
  }

  function onCapture(e) {
    if (!overlay || !captureAction) return;
    const tag = (e.target?.tagName ?? "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;
    e.preventDefault();
    e.stopPropagation();
    const chord = eventChord(e);
    const entry = (view?.settings ?? []).find((s) => s.key === "live.shortcuts");
    const map = resolveShortcuts(entry?.value);
    if (!chord || chord === "Escape") {
      captureAction = null;
      const bd = overlay.querySelector(".st-body");
      if (bd) renderShortcuts(bd);
      return;
    }
    const action = captureAction;
    const next = { ...map, [action]: chord };
    const conflicts = shortcutConflicts(next, chord, action);
    captureAction = null;
    void (async () => {
      const res = await api.post("/api/settings", { key: "live.shortcuts", value: next });
      if (res?.ok) {
        view = res;
        if (overlay) renderShortcuts(overlay.querySelector(".st-body"));
        toast(conflicts.length ? `Saved (also used by ${conflicts.join(", ")})` : "Saved");
      } else toast(res?.diagnostic?.message ?? "Save failed", true);
    })();
  }

  function toast(msg, isErr) {
    if (!overlay) return;
    const el = overlay.querySelector(".st-toast");
    el.hidden = false;
    el.textContent = msg;
    el.dataset.state = isErr ? "error" : "ok";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function rowError(key, msg) {
    if (!overlay) return;
    const slot = overlay.querySelector(`[data-err-for="${CSS.escape(key)}"]`);
    if (slot) { slot.hidden = !msg; slot.textContent = msg ?? ""; }
  }

  function renderBody() {
    if (!overlay) return;
    const nav = overlay.querySelector(".st-nav");
    nav.innerHTML = SECTIONS.map((s) =>
      `<button data-section="${s.id}" aria-current="${s.id === activeSection}">${esc(s.label)}</button>`).join("");
    const body = overlay.querySelector(".st-body");
    if (!view) {
      body.innerHTML = loading
        ? `<div class="st-empty">Loading…</div>`
        : `<div class="st-empty">Settings unavailable (server offline?).</div>`;
      return;
    }
    if (activeSection === "about") { renderAbout(body); return; }
    if (activeSection === "shortcuts") { renderShortcuts(body); return; }
    const rows = (view.settings ?? []).filter((s) => SECTION_OF[s.key] === activeSection);
    body.innerHTML = rows.map(renderRow).join("");
    wireRows(body);
  }

  function badge(s) {
    if (s.readonly) return `<span class="st-lock" title="${esc(s.readonly_reason ?? "Locked")}" aria-label="Locked">L</span>`;
    if (s.agent_badge) return `<span class="st-agent" title="Set by the agent" aria-label="Set by the agent">?</span>`;
    return "";
  }

  function renderRow(s) {
    const m = s.meta ?? {};
    const dis = s.readonly || m.locked ? "disabled" : "";
    let control = "";
    if (m.kind === "select") {
      // The stored value may sit between presets (e.g. 7 workers from the
      // environment); list it first so the control shows the truth. A locked
      // control shows its single fixed option instead.
      const cur = m.locked ? String(m.options?.[0] ?? s.value) : String(s.value);
      const opts = (m.options ?? []).map(String);
      const all = opts.includes(cur) ? opts : [cur, ...opts];
      const labelOf = (o) => m.option_labels?.[o] ?? o;
      control = `<select data-key="${esc(s.key)}" ${dis}>` + all.map((o) =>
        `<option value="${esc(o)}" ${cur === o ? "selected" : ""}>${esc(labelOf(o))}</option>`).join("") + `</select>`;
    } else if (m.kind === "toggle") {
      control = `<button class="st-toggle" data-key="${esc(s.key)}" data-on="${s.value ? "1" : "0"}" aria-pressed="${s.value ? "true" : "false"}" ${dis}><i></i></button>`;
    } else if (m.kind === "number") {
      control = `<input type="number" data-key="${esc(s.key)}" value="${esc(s.value)}" min="${m.min ?? ""}" ${dis}>`;
    } else {
      control = `<input type="text" data-key="${esc(s.key)}" value="${esc(s.display ?? s.value)}" spellcheck="false" ${dis}>`;
    }
    const lockNote = s.readonly
      ? `<div class="st-note">${esc(s.readonly_reason ?? "")}</div>`
      : m.note ? `<div class="st-note">${esc(m.note)}</div>` : "";
    return `<div class="st-row">
      <div class="st-label">${esc(m.label ?? s.key)} ${badge(s)}<div class="st-hint">${esc(m.hint ?? "")}</div></div>
      <div class="st-control">${control}<div class="st-err" data-err-for="${esc(s.key)}" hidden></div>${lockNote}</div>
    </div>`;
  }

  function wireRows(body) {
    for (const sel of body.querySelectorAll("select[data-key]")) {
      sel.addEventListener("change", () => save(sel.dataset.key, sel.value, sel));
    }
    for (const btn of body.querySelectorAll(".st-toggle[data-key]")) {
      btn.addEventListener("click", () => save(btn.dataset.key, btn.dataset.on !== "1", btn));
    }
    for (const input of body.querySelectorAll('input[data-key]')) {
      input.addEventListener("change", () => {
        let v = input.value;
        if (input.type === "number") v = v === "" ? v : Number(v);
        save(input.dataset.key, v, input);
      });
    }
  }

  async function save(key, value, el) {
    rowError(key, null);
    if (el) el.disabled = true;
    try {
      const next = await api.post("/api/settings", { key, value });
      if (next?.ok) {
        view = next;
        renderBody();
        toast("Saved");
      } else {
        rowError(key, next?.diagnostic?.message ?? next?.diagnostic?.what ?? "Save failed");
      }
    } catch (e) {
      rowError(key, String((e && e.message) || e));
    } finally {
      if (el && overlay) {
        const fresh = overlay.querySelector(`[data-key="${CSS.escape(key)}"]`);
        if (fresh) fresh.disabled = false;
      }
    }
  }

  function renderAbout(body) {
    const a = view.about ?? {};
    const rows = [
      ["Detected encoder", a.detected_encoder],
      ["Graphics", a.gpu],
      ["CPU cores", a.cpu_cores],
      ["ffmpeg", a.ffmpeg],
      ["HyperFrames", a.hyperframes],
      ["Cache folder", a.cache_dir],
      ["Cache size", a.cache_size],
    ];
    body.innerHTML = `<div class="st-about">` + rows.map(([k, v]) =>
      `<div class="st-row"><div class="st-label">${esc(k)}</div><div class="st-control st-static mono">${esc(v ?? "unknown")}</div></div>`
    ).join("") + `</div>`;
  }

  function renderShortcuts(body) {
    const entry = (view.settings ?? []).find((s) => s.key === "live.shortcuts");
    const map = resolveShortcuts(entry?.value);
    body.innerHTML =
      `<div class="st-note">Click a row, then press the new key. Typing in text boxes never triggers shortcuts.</div>` +
      shortcutActions().map((action) => {
        const conflicts = captureAction ? [] : shortcutConflicts(map, map[action], action);
        return `<div class="st-row st-shortcut" data-action="${esc(action)}" tabindex="0" role="button" aria-label="Reassign ${esc(action)}">
          <div class="st-label">${esc(SHORTCUT_LABELS[action] ?? action)}</div>
          <div class="st-control"><kbd>${esc(captureAction === action ? "press a key…" : chordLabel(map[action]))}</kbd>
          ${conflicts.length ? `<div class="st-warn">Also used by ${esc(conflicts.join(", "))}</div>` : ""}</div>
        </div>`;
      }).join("") +
      `<button class="st-reset">Reset to defaults</button>`;
    for (const row of body.querySelectorAll(".st-shortcut")) {
      const start = (e) => { e.preventDefault(); captureAction = row.dataset.action; renderShortcuts(body); };
      row.addEventListener("click", start);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") start(e); });
    }
    body.querySelector(".st-reset").addEventListener("click", async () => {
      const res = await api.post("/api/settings", { key: "live.shortcuts", value: {} });
      if (res?.ok) { view = res; renderShortcuts(body); toast("Shortcuts reset"); }
      else toast("Reset failed", true);
    });
  }

  store.on("settings", (v) => {
    if (v && overlay) {
      // Re-render open rows only when no capture or edit is in flight.
      const typing = document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
      if (!captureAction && !typing) { view = v; renderBody(); }
      else view = v;
    }
  });

  return { open, close, refresh };
}

