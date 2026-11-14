// Color effect menu (opened from the Effects tab over the right column): before/after, scopes,
// and sliders that nudge the grade while the agent is paused. Dragging previews an unsaved LUT;
// releasing commits through the edit path (`color set --patch … --reason taste`), so the change
// reaches the agent like any other human edit.

const FIELDS = [
  ["white_balance.temp_mired", "Temp", -100, 100, 1],
  ["white_balance.tint", "Tint", -0.5, 0.5, 0.01],
  ["exposure.stops", "Exposure", -3, 3, 0.05],
  ["tone.contrast", "Contrast", -1, 1, 0.01],
  ["tone.shadows", "Shadows", -1, 1, 0.01],
  ["tone.highlights", "Highlights", -1, 1, 0.01],
  ["saturation.saturation", "Saturation", 0, 2, 0.01],
  ["saturation.vibrance", "Vibrance", -1, 1, 0.01],
  ["look.amount", "Look", 0, 1, 0.01],
];
const DEFAULTS = { "saturation.saturation": 1 };

function valueOf(stage, path) {
  const [block, field] = path.split(".");
  const v = stage?.[block]?.[field];
  return typeof v === "number" ? v : (DEFAULTS[path] ?? 0);
}

function findItem(ctx, id) {
  const seq = ctx.store.state.sequence;
  const clip = seq?.spine?.clips?.find((c) => c.id === id);
  if (clip) return { id, stage: clip.treatments?.color ?? null };
  for (const lane of seq?.lanes ?? []) {
    const cue = lane?.cues?.find((q) => q.id === id);
    if (cue) return { id, stage: cue.color ?? null };
  }
  return null;
}

/** @param {HTMLElement} body @param {any} ctx @param {(id: string|null) => void} setTitle */
export function mount(body, ctx, setTitle) {
  // The item graded at the playhead right now (the grade event may have fired before this menu opened).
  let gradedItem = ctx.colorGrade?.state?.item ?? null;
  let scopesApi = null;
  let dragging = false;
  const paused = () => ctx.store.state.lock?.holder === "human";
  const currentId = () => {
    const sel = ctx.store.state.selection;
    if (sel && sel.kind !== "scene") return sel.id;
    return gradedItem;
  };

  body.innerHTML = `
    <div class="clp">
      <div class="clp-row">
        <button class="clp-ab" type="button" aria-pressed="true" title="Toggle before/after">After</button>
        <span class="clp-state dim"></span>
      </div>
      <div class="clp-scopes"></div>
      <div class="clp-sliders"></div>
      <div class="clp-hint dim"></div>
    </div>`;
  const ab = body.querySelector(".clp-ab");
  const stateEl = body.querySelector(".clp-state");
  const slidersEl = body.querySelector(".clp-sliders");
  const hint = body.querySelector(".clp-hint");

  ab.addEventListener("click", () => {
    const g = ctx.colorGrade;
    if (!g) return;
    g.state.bypass = !g.state.bypass;
    ab.setAttribute("aria-pressed", String(!g.state.bypass));
    ab.textContent = g.state.bypass ? "Before" : "After";
    g.drawFrame?.();
  });

  import("./scopes.js").then(({ mountScopesPanel }) => {
    scopesApi = mountScopesPanel(body.querySelector(".clp-scopes"), ctx, () => ctx.colorGrade?.state?.canvas ?? null);
    const id = currentId();
    if (id) scopesApi.setItem(id);
    body.querySelector(".clp-scopes .sc-toggle")?.click();
  });

  function render() {
    // Never rebuild under the pointer or while a save is on its way (it would flash the old values).
    if (dragging || commitBusy) return;
    const id = currentId();
    setTitle(id);
    const item = id ? findItem(ctx, id) : null;
    const isPaused = paused();
    if (!item) {
      stateEl.textContent = "Select a clip or cue.";
      slidersEl.innerHTML = "";
      hint.textContent = "";
      return;
    }
    const blocks = item.stage ? Object.keys(item.stage) : [];
    stateEl.textContent = blocks.length ? blocks.join(" · ") : "untouched";
    ab.disabled = !blocks.length;
    slidersEl.className = `clp-sliders${isPaused ? "" : " disabled"}`;
    slidersEl.innerHTML = FIELDS.filter(([p]) => p !== "look.amount" || item.stage?.look)
      .map(([path, label, lo, hi, step]) => {
        const v = valueOf(item.stage, path);
        return `<label class="clp-slider"><span>${label}</span><input type="range" data-path="${path}" min="${lo}" max="${hi}" step="${step}" value="${v}"><output class="mono">${v}</output></label>`;
      }).join("");
    hint.textContent = isPaused ? "Drag to preview, release to save." : "Pause the agent to adjust the grade.";
    if (scopesApi) scopesApi.setItem(id);
    const sliders = [...slidersEl.querySelectorAll("input")];
    // Only the slider that moved goes into the edit, as one block field; the rest of the stage stays as saved.
    const stageWith = (el) => {
      const base = JSON.parse(JSON.stringify(pendingStage ?? item.stage ?? {}));
      const [block, field] = el.dataset.path.split(".");
      if (block === "look" && !base.look) return base;
      base[block] = { ...(base[block] ?? {}), [field]: Number(el.value) };
      if (block === "white_balance") base.white_balance.tint = base.white_balance.tint ?? 0;
      if (block === "white_balance") base.white_balance.temp_mired = base.white_balance.temp_mired ?? 0;
      return base;
    };
    for (const el of sliders) {
      // The menu is never rebuilt while a slider is held (a rebuild under the pointer made values jump).
      el.addEventListener("pointerdown", () => { dragging = true; });
      el.addEventListener("input", () => {
        el.nextElementSibling.textContent = el.value;
        if (!paused()) return;
        schedulePreview(item.id, stageWith(el));
      });
      const release = () => {
        if (!dragging) return;
        dragging = false;
        if (!paused()) { render(); return; }
        pendingStage = stageWith(el);
        queueCommit(item.id);
      };
      el.addEventListener("pointerup", release);
      el.addEventListener("pointercancel", release);
      el.addEventListener("change", () => { dragging = true; release(); });
    }
  }

  // Drag preview: at most one request in flight, always for the latest values.
  let previewBusy = false;
  let previewNext = null;
  async function schedulePreview(id, stage) {
    previewNext = { id, stage };
    if (previewBusy) return;
    previewBusy = true;
    while (previewNext) {
      const job = previewNext;
      previewNext = null;
      try { await ctx.colorGrade?.previewStage(job.id, job.stage); }
      catch (e) { console.error("[color] drag preview", e); }
    }
    previewBusy = false;
  }

  // Commits run one at a time with the revision the previous one produced, so a quick second
  // release is never refused as stale; the latest values always win.
  let pendingStage = null;
  let commitBusy = false;
  async function queueCommit(id) {
    if (commitBusy) return;
    commitBusy = true;
    while (pendingStage) {
      const stage = pendingStage;
      try {
        const r = await ctx.api.post("/api/edit", {
          action: "color", target: id,
          params: { patch: stage, reason: "taste" },
          expect_rev: ctx.store.state.revision,
        });
        if (r && r.ok === true && typeof r.revision === "number" && r.revision > (ctx.store.state.revision ?? 0)) {
          ctx.store.state.revision = r.revision;
        }
        if (!r || r.ok !== true) console.error("[color] commit", r);
      } catch (e) { console.error("[color] commit", e); }
      if (pendingStage === stage) pendingStage = null;
    }
    commitBusy = false;
    render();
  }

  const onGrade = (e) => { if (e.detail?.item) { gradedItem = e.detail.item; render(); } };
  window.addEventListener("cuthol:grade", onGrade);
  const offs = ["snapshot", "delta", "state", "lock"].map((ev) => ctx.store.on(ev, render));
  render();
  return {
    destroy() {
      window.removeEventListener("cuthol:grade", onGrade);
      for (const off of offs) if (typeof off === "function") off();
      scopesApi?.destroy?.();
      const g = ctx.colorGrade;
      if (g && g.state.bypass) { g.state.bypass = false; g.drawFrame?.(); }
    },
  };
}
