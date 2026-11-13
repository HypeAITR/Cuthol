// Scene strip: one row per scene (thumbnail, number, time range). Clicking a scene
// moves the playhead to its start and selects it. Thumbnails come from the live
// server; rows are keyed by scene id so an edit only touches the scenes it
// changed — the rest keep their <img> elements and never reload.
//
// Thumbnail URL: the scene carries a content-keyed URL (`scene.thumb`), used
// as is. Older servers omit it; then a stable per-scene URL is used and only
// re-busted when that scene changed.

/**
 * Thumbnail path for a scene (no token; the caller adds it via `api.url`).
 * Content-keyed URLs are returned untouched; the fallback carries the bust
 * revision of that scene's last change (null = bare stable URL).
 */
export function sceneThumbPath(scene, bustRev) {
  if (scene?.thumb) return scene.thumb;
  const v = bustRev == null ? "" : `?v=${bustRev}`;
  return `/api/thumb/${encodeURIComponent(scene?.id ?? "")}${v}`;
}

/** @param {HTMLElement|null} root  @param {import('./app.js').LiveContext} ctx */
export function mount(root, ctx) {
  if (!root) return;
  root.innerHTML = `<div class="panel-head">Scenes<span class="spacer"></span><span class="dim sc-count mono"></span></div><div class="panel-body sc-list"></div>`;
  const list = root.querySelector(".sc-list");
  const count = root.querySelector(".sc-count");

  const fmtRange = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  const sceneSig = (scene) => JSON.stringify([scene.start_ms, scene.end_ms, scene.label, scene.members]);
  const rowById = new Map(); // scene id -> { btn, img, num, range, sig, thumb }
  let fadeGen = 0;

  function makeRow(scene, num) {
    const btn = document.createElement("button");
    btn.className = "sc-row";
    btn.type = "button";
    btn.title = scene.label ?? scene.id;
    btn.dataset.scene = scene.id;
    btn.innerHTML =
      `<span class="sc-thumbwrap"><img class="sc-thumb" alt="" loading="lazy"><span class="sc-fallback" aria-hidden="true">${num}</span></span>` +
      `<span class="sc-meta"><span class="sc-num mono">${num}</span>` +
      `<span class="sc-range dim mono"></span></span>`;
    const img = btn.querySelector("img");
    img.addEventListener("load", () => btn.classList.add("sc-loaded"));
    btn.addEventListener("click", () => {
      ctx.store.set({ playheadMs: scene.start_ms ?? 0, selection: { id: scene.id, kind: "scene" } });
    });
    return { btn, img, num: btn.querySelector(".sc-num"), range: btn.querySelector(".sc-range"), sig: "", thumb: "" };
  }

  // Keyed reconcile: new scenes get rows, gone scenes lose them, kept rows are
  // patched in place. `bustAll` (fresh snapshot) re-busts every thumbnail;
  // otherwise only changed scenes reload their picture.
  function reconcile(bustAll) {
    const { scenes, selection, lastChanged, revision } = ctx.store.state;
    count.textContent = scenes.length ? String(scenes.length) : "";
    const selectedId = selection?.id;
    const changed = new Set(lastChanged ?? []);
    if (!scenes.length) {
      list.innerHTML = `<div class="sc-empty muted">No scenes</div>`;
      rowById.clear();
      return;
    }
    list.querySelector(".sc-empty")?.remove();
    const seen = new Set();
    let highlighted = false;
    scenes.forEach((scene, i) => {
      seen.add(scene.id);
      const num = String(i + 1).padStart(2, "0");
      let row = rowById.get(scene.id);
      if (!row) {
        row = makeRow(scene, num);
        rowById.set(scene.id, row);
      }
      const isChanged = (scene.members ?? []).some((m) => changed.has(m));
      const sig = sceneSig(scene);
      // Text/meta: cheap, refresh whenever the summary moved.
      if (row.sig !== sig || row.num.textContent !== num) {
        row.btn.title = scene.label ?? scene.id;
        const fb = row.btn.querySelector(".sc-fallback");
        if (fb) fb.textContent = num;
        row.num.textContent = num;
        row.range.textContent = `${fmtRange(scene.start_ms)} – ${fmtRange(scene.end_ms)}`;
        row.sig = sig;
      }
      // Thumbnail: reload only when the picture URL actually changed. The
      // fallback bust revision advances only for changed scenes, so unrelated
      // edits leave every <img> untouched (no new request).
      if (bustAll || isChanged || row.thumb === "") row.bustRev = revision ?? 0;
      else if (row.bustRev == null) row.bustRev = revision ?? 0;
      const url = ctx.api.url(sceneThumbPath(scene, row.bustRev));
      if (row.thumb !== url) {
        row.btn.classList.remove("sc-loaded");
        row.img.src = url;
        row.thumb = url;
      }
      if (selectedId === scene.id) row.btn.setAttribute("aria-current", "true");
      else row.btn.removeAttribute("aria-current");
      row.btn.classList.toggle("is-changed", isChanged);
      if (isChanged) highlighted = true;
      list.appendChild(row.btn); // appends in order; moves kept rows without reload
    });
    for (const [id, row] of rowById) {
      if (!seen.has(id)) {
        row.btn.remove();
        rowById.delete(id);
      }
    }
    if (highlighted) {
      const gen = ++fadeGen;
      setTimeout(() => {
        if (gen !== fadeGen) return;
        for (const row of list.querySelectorAll(".sc-row.is-changed")) row.classList.remove("is-changed");
      }, 1000);
    } else {
      fadeGen++;
    }
  }

  // Selection/playhead moves must not rebuild the <img> elements (flicker), so
  // scene-data patches reconcile the list while selection-only patches flip classes.
  function syncSelection() {
    const id = ctx.store.state.selection?.id;
    for (const row of list.querySelectorAll(".sc-row")) {
      if (row.dataset.scene === id) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
  }

  ctx.store.on("snapshot", () => reconcile(true));
  ctx.store.on("delta", () => reconcile(false));
  ctx.store.on("comps", () => reconcile(false));
  ctx.store.on("state", (patch) => {
    if (patch && ("selection" in patch || "playheadMs" in patch) && !("scenes" in patch)) syncSelection();
    else reconcile(false);
  });
  reconcile(true);
}
