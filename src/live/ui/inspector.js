// Inspector: read-only details of the selected clip, cue or scene.
/** @param {HTMLElement|null} root  @param {import('./app.js').LiveContext} ctx */
export function mount(root, ctx) {
  if (!root) return;
  root.innerHTML = `<div class="panel-head">Clip Info</div><div class="panel-body in-body"></div>`;
  const body = root.querySelector(".in-body");

  const fps = () => ctx.store.state.snapshot?.project?.fps ?? 30;
  const timecode = (ms) => {
    const f = Math.max(1, Math.round(fps()));
    const totalFrames = Math.max(0, Math.floor((ms / 1000) * f));
    const ff = totalFrames % f;
    const s = Math.floor(totalFrames / f);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}:${p(ff)}`;
  };
  const pct = (v) => (v == null || Number.isNaN(v) ? "—" : `${Math.round(v * 100)}%`);

  function findSelection() {
    const { sequence, selection, scenes } = ctx.store.state;
    if (!selection) return null;
    if (selection.kind === "scene") {
      const scene = (scenes ?? []).find((s) => s.id === selection.id);
      return scene ? { kind: "scene", scene } : null;
    }
    const clip = sequence?.spine?.clips?.find((c) => c.id === selection.id);
    if (clip) {
      const scene = (scenes ?? []).find((s) => (s.members ?? []).includes(clip.id));
      return { kind: "clip", clip, scene };
    }
    for (const lane of sequence?.lanes ?? []) {
      const cue = lane?.cues?.find((q) => q.id === selection.id);
      if (cue) return { kind: "cue", cue, lane };
    }
    return null;
  }

  function rowsFor(hit) {
    if (hit.kind === "scene") {
      const s = hit.scene;
      return [
        ["Range", `${timecode(s.start_ms)} → ${timecode(s.end_ms)}`],
        ["Duration", `${timecode((s.end_ms ?? 0) - (s.start_ms ?? 0))}`],
        ["Label", s.label ?? "—"],
        ["Members", (s.members ?? []).join(", ") || "—"],
      ];
    }
    if (hit.kind === "clip") {
      const c = hit.clip;
      return [
        ["Duration", `${timecode(c.duration_ms ?? 0)} · ${c.duration_ms ?? 0} ms`],
        ["Position", timecode(c.timeline_in_ms ?? 0)],
        ["Source in/out", `${timecode(c.source_in_ms ?? 0)} → ${timecode(c.source_out_ms ?? 0)}`],
        ["Scale", `${pct(c.placement?.scale_x)} × ${pct(c.placement?.scale_y)}`],
        ["Opacity", pct(c.placement?.opacity)],
        ["Rate", c.playback?.rate != null ? `${c.playback.rate}×` : "—"],
        ["Asset", c.asset_handle ?? "—"],
        ["Lane", "Spine"],
      ];
    }
    const q = hit.cue;
    const comp = q.composition ? `${q.composition.composition_dir ?? ""}` : null;
    return [
      ["Duration", `${timecode(q.duration_ms ?? 0)} · ${q.duration_ms ?? 0} ms`],
      ["Position", timecode(q.anchor ? cueStartApprox(q) : (q.at_ms ?? 0))],
      ["Kind", q.kind ?? "—"],
      ["Scale", `${pct(q.placement?.scale_x)} × ${pct(q.placement?.scale_y)}`],
      ["Opacity", pct(q.placement?.opacity)],
      ["Asset / Comp", comp || q.asset_handle || "—"],
      ["Lane", hit.lane?.id ?? "—"],
    ];
  }

  function cueStartApprox(q) {
    if (!q.anchor?.ref) return q.at_ms ?? 0;
    const clip = ctx.store.state.sequence?.spine?.clips?.find((c) => c.id === q.anchor.ref);
    return clip ? clip.timeline_in_ms + (q.anchor.offset_ms ?? 0) : q.at_ms ?? 0;
  }

  function thumbFor(hit) {
    const scene = hit.kind === "clip" ? hit.scene : hit.kind === "scene" ? hit.scene : null;
    if (!scene) return "";
    const src = ctx.api.url(`/api/thumb/${encodeURIComponent(scene.id)}?v=${ctx.store.state.revision ?? 0}`);
    return `<div class="in-thumbwrap"><img class="in-thumb" alt="" loading="lazy" src="${src}"></div>`;
  }

  function render() {
    const hit = findSelection();
    if (!hit) {
      body.innerHTML = `<div class="in-empty muted">Select a clip or cue<br>to inspect it</div>`;
      return;
    }
    const title = hit.kind === "scene" ? hit.scene.label ?? hit.scene.id
      : hit.kind === "clip" ? hit.clip.id : hit.cue.id;
    const sub = hit.kind === "scene" ? "Scene" : hit.kind === "clip" ? `Spine clip · ${hit.clip.asset_handle ?? ""}` : `Lane cue · ${hit.cue.kind ?? ""}`;
    body.innerHTML =
      `<div class="in-title">${escapeHtml(title)}</div><div class="in-sub dim">${escapeHtml(sub)}</div>` +
      thumbFor(hit) +
      `<dl class="in-rows">` + rowsFor(hit).map(([k, v]) => `<div class="in-row"><dt class="dim">${k}</dt><dd class="mono">${escapeHtml(v)}</dd></div>`).join("") + `</dl>`;
    const img = body.querySelector(".in-thumb");
    if (img) img.addEventListener("error", () => img.closest(".in-thumbwrap")?.remove());
  }

  ctx.store.on("snapshot", render);
  ctx.store.on("delta", render);
  ctx.store.on("state", render);
  render();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
