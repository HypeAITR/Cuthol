// Timeline: two-tier ruler (marker band + ticks), spine + lane tracks on
// viewport-sized canvases (only visible items are drawn), playhead, agent
// position line, zoom and selection. Read-only while the agent holds the
// lock; edit buttons stay disabled until the human takes over (region F
// wires them via `data-edit-action`).
//
// Ruler tiers: the top band carries the playhead triangle handle, the amber
// AGENT label and white note diamonds; the lower band carries ticks and time
// labels. The ruler row has no track header. Each track header (fixed
// 180–200 px) shows the lane name, a mute indicator (lane-level mute is not
// available in the CLI, so it never activates) and a working lane lock.
/** @param {HTMLElement|null} root  @param {import('./app.js').LiveContext} ctx */
export function mount(root, ctx) {
  if (!root) return;

  const ICONS = {
    split: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5 L20 19 M8 16.5 L20 5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8 V6 A2 2 0 0 0 14 4 H6 A2 2 0 0 0 4 6 V14 A2 2 0 0 0 6 16 H8"/>',
    delete: '<path d="M4 7 H20 M9 7 V5 A1 1 0 0 1 10 4 H14 A1 1 0 0 1 15 5 V7 M6.5 7 L7.5 20 H16.5 L17.5 7"/><path d="M10 11 V16.5 M14 11 V16.5"/>',
    duplicate: '<rect x="3" y="7" width="12" height="12" rx="2"/><path d="M15 7 V6 A2 2 0 0 1 17 4 H19 A2 2 0 0 1 21 6 V14 A2 2 0 0 1 19 16 H18"/>',
    eye: '<path d="M2.5 12 C5 6.5 8.5 4.5 12 4.5 C15.5 4.5 19 6.5 21.5 12 C19 17.5 15.5 19.5 12 19.5 C8.5 19.5 5 17.5 2.5 12 Z"/><circle cx="12" cy="12" r="3"/>',
    fit: '<path d="M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15"/>',
    mute: '<path d="M4 10 V14 H8 L13 19 V5 L8 10 Z"/><path d="M16.5 9.5 L21.5 14.5 M21.5 9.5 L16.5 14.5"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10 V7 A4 4 0 0 1 16 7 V10"/>',
    unlock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10 V7 A4 4 0 0 1 15.5 6.2"/>',
  };
  const editBtn = (action, label) =>
    `<button class="icon-btn" data-edit-action="${action}" title="${label} (disabled while the agent edits)" aria-label="${label}" disabled>` +
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[action]}</svg></button>`;

  root.innerHTML =
    `<div class="tl-toolbar" role="toolbar" aria-label="Timeline">` +
    editBtn("split", "Split") + editBtn("copy", "Copy") + editBtn("delete", "Delete") + editBtn("duplicate", "Duplicate") +
    `<span class="tl-mode" aria-hidden="true"></span><span class="spacer"></span>` +
    `<button class="icon-btn tl-empty" title="Show empty lanes" aria-label="Show empty lanes" aria-pressed="false">` +
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS.eye}</svg></button>` +
    `<input class="tl-zoom" type="range" min="0" max="1000" value="0" title="Zoom" aria-label="Zoom">` +
    `<button class="icon-btn tl-fit" title="Fit sequence" aria-label="Fit sequence">` +
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS.fit}</svg></button>` +
    `</div><div class="tl-body"><div class="tl-labels"><div class="tl-labels-inner"></div></div>` +
    `<div class="tl-scroll"><div class="tl-content"><div class="tl-view"><canvas class="tl-ruler"></canvas><div class="tl-tracks"></div></div>` +
    `<div class="tl-playhead" aria-hidden="true"></div><button class="tl-agent" type="button" title="Agent position — click to follow the agent" aria-label="Agent position"><span class="tl-agent-tag">AGENT</span></button></div></div></div>`;

  const scroll = root.querySelector(".tl-scroll");
  const content = root.querySelector(".tl-content");
  const view = root.querySelector(".tl-view");
  const ruler = root.querySelector(".tl-ruler");
  const tracksBox = root.querySelector(".tl-tracks");
  const labelsInner = root.querySelector(".tl-labels-inner");
  const labelsCol = root.querySelector(".tl-labels");
  const playheadEl = root.querySelector(".tl-playhead");
  const agentEl = root.querySelector(".tl-agent");
  const zoomInput = root.querySelector(".tl-zoom");

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const C = {
    video: css("--clip-video"), title: css("--clip-title"), caption: css("--clip-caption"), audio: css("--clip-audio"),
    wave: css("--wave"), text1: css("--text-1"), text2: css("--text-2"), text3: css("--text-3"),
    line: css("--line"), accent: css("--accent"), accentWeak: css("--accent-weak"), track: css("--bg-track"),
    amber: css("--amber") || "#d29922",
  };

  const RULER_H = 46;
  const RULER_BAND_H = 20;
  const TRACK_H = 44;
  const MAX_PX_PER_MS = 0.6;

  /** @type {Array<{key:string,label:string,sub:string,kind:string,locked:boolean,muted:boolean,items:Array<any>}>> */
  let tracks = [];
  let durationMs = 10000;
  let pxPerMs = 0.05;
  let showEmpty = false;
  let changedAt = 0;
  let needsDraw = false;
  const imgCache = new Map(); // url -> {img, state:"loading"|"ready"|"dead"}
  const stats = { draws: 0, lastDrawMs: 0, itemsDrawn: 0 };
  window.__tlStats = stats;

  const fps = () => ctx.store.state.snapshot?.project?.fps ?? 30;
  const timecode = (ms) => {
    const f = Math.max(1, Math.round(fps()));
    const totalFrames = Math.max(1, Math.floor((ms / 1000) * f));
    const ff = totalFrames % f;
    const s = Math.floor(totalFrames / f);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}:${p(ff)}`;
  };

  const cueStartMs = (seq, cue) => {
    if (!cue?.anchor?.ref) return cue?.at_ms ?? 0;
    const clip = seq?.spine?.clips?.find((c) => c.id === cue.anchor.ref);
    return clip ? clip.timeline_in_ms + (cue.anchor.offset_ms ?? 0) : cue.at_ms ?? 0;
  };

  /** Sequence-time position of a changed handle (agent line, activity jump). */
  const locateMs = (seq, id) => {
    const clip = seq?.spine?.clips?.find((c) => c.id === id);
    if (clip) return clip.timeline_in_ms ?? 0;
    for (const lane of seq?.lanes ?? []) {
      const cue = lane?.cues?.find((q) => q.id === id);
      if (cue) return cueStartMs(seq, cue);
    }
    return null;
  };

  const cueLabel = (cue) => {
    if (cue.typography?.text) return cue.typography.text.split("\n")[0];
    if (cue.asset_handle) return cue.asset_handle;
    if (cue.composition?.composition_dir) return String(cue.composition.composition_dir).split("/").pop();
    return cue.id;
  };

  const laneTitle = (kind) => ({
    title: "Titles", caption: "Captions", composition: "Compositions", music: "Music",
    sfx: "SFX", voiceover: "Voiceover", broll: "B-roll",
  }[kind] ?? (kind ? kind[0].toUpperCase() + kind.slice(1) : "Lane"));

  /** Agent line + amber dots from the latest agent revisions (no lock needed:
   * the activity feed is the window's own state). Dots mark clips and cues
   * touched by the last 5 agent revisions; the line sits on the first item
   * the newest agent revision changed. */
  function syncAgent() {
    const { activity, sequence } = ctx.store.state;
    const { ms, ids } = agentMarks(activity ?? [], sequence);
    const patch = {};
    if (ms !== ctx.store.state.agentMs) patch.agentMs = ms;
    if (JSON.stringify(ids) !== JSON.stringify(ctx.store.state.agentIds)) patch.agentIds = ids;
    if (Object.keys(patch).length) ctx.store.set(patch);
    positionAgent();
  }

  function rebuild() {
    const seq = ctx.store.state.sequence;
    tracks = [];
    durationMs = 1000;
    const clips = seq?.spine?.clips ?? [];
    const items = clips.map((c) => {
      const end = (c.timeline_in_ms ?? 0) + (c.duration_ms ?? 0);
      durationMs = Math.max(durationMs, end);
      return { id: c.id, kind: "clip", start: c.timeline_in_ms ?? 0, end, label: c.asset_handle ?? c.id, ref: c };
    });
    tracks.push({ key: "spine", label: "V1", sub: "Spine", kind: "spine", locked: false, muted: false, items });

    for (const lane of seq?.lanes ?? []) {
      const cues = lane?.cues ?? [];
      const laneItems = cues.map((q) => {
        const start = cueStartMs(seq, q);
        const end = start + (q.duration_ms ?? 0);
        durationMs = Math.max(durationMs, end);
        return { id: q.id, kind: "cue", cueKind: q.kind, start, end, label: cueLabel(q), ref: q, lane: lane.id };
      });
      tracks.push({ key: lane.id, label: "", sub: laneTitle(lane.kind), kind: lane.kind, locked: !!lane.locked, muted: !!lane.muted, items: laneItems });
    }
    // Short codes (V2/A1/T1…) count visible tracks only.
    let v = 2, a = 1, t = 1;
    for (const tr of showEmpty ? tracks : tracks.filter((x) => x.key === "spine" || x.items.length > 0)) {
      if (tr.key === "spine") continue;
      const k = tr.kind;
      tr.label = k === "caption" ? `T${t++}` : ["music", "sfx", "voiceover"].includes(k) ? `A${a++}` : `V${v++}`;
    }
    buildDom();
    layout();
    syncAgent();
  }

  function visibleTracks() {
    return showEmpty ? tracks : tracks.filter((tr) => tr.key === "spine" || tr.items.length > 0);
  }

  function buildDom() {
    labelsInner.innerHTML = ``;
    tracksBox.innerHTML = "";
    for (const tr of visibleTracks()) {
      const lab = document.createElement("div");
      lab.className = "tl-label";
      const isSpine = tr.key === "spine";
      lab.innerHTML =
        `<span class="tl-label-text"><span class="tl-label-code mono">${escapeHtml(tr.label)}</span>` +
        `<span class="tl-label-sub dim">${escapeHtml(tr.sub)}</span></span>` +
        (isSpine ? "" :
          `<button class="tl-head-btn tl-mute" type="button" disabled title="Lane mute is not available yet" aria-label="Lane muted" aria-pressed="${tr.muted}">` +
          `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS.mute}</svg></button>` +
          `<button class="tl-head-btn tl-lock" type="button" data-lane="${escapeHtml(tr.key)}" title="${tr.locked ? "Unlock lane" : "Lock lane"}" aria-label="${tr.locked ? "Unlock lane" : "Lock lane"}" aria-pressed="${tr.locked}" disabled>` +
          `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${tr.locked ? ICONS.lock : ICONS.unlock}</svg></button>`);
      lab.title = isSpine ? "Spine" : `${tr.sub} (${tr.key})`;
      labelsInner.appendChild(lab);
      const cv = document.createElement("canvas");
      cv.className = "tl-track";
      cv.dataset.track = tr.key;
      tracksBox.appendChild(cv);
      cv.addEventListener("click", (ev) => onTrackClick(ev, tr));
    }
    for (const b of labelsInner.querySelectorAll(".tl-lock")) {
      b.addEventListener("click", () => void toggleLaneLock(b.dataset.lane));
    }
    syncLockButtons();
    sizeCanvases();
  }

  async function toggleLaneLock(laneId) {
    const b = labelsInner.querySelector(`.tl-lock[data-lane="${CSS.escape(laneId)}"]`);
    const tr = tracks.find((t) => t.key === laneId);
    const locked = !(tr?.locked ?? false);
    if (b) b.disabled = true;
    try {
      const res = await ctx.api.post("/api/edit", {
        action: "lane-lock",
        target: laneId,
        params: { lane: laneId, locked },
        expect_rev: ctx.store.state.revision,
      });
      if (!res || !res.ok) {
        if (b) b.title = String(res?.message ?? "Lock failed — pause the agent first");
      }
    } catch {
      if (b) b.title = "Lock failed — no response from the server";
    }
    if (b) b.disabled = ctx.store.state.mode !== "human";
  }

  function syncLockButtons() {
    const human = ctx.store.state.mode === "human";
    for (const b of labelsInner.querySelectorAll(".tl-lock")) {
      if (document.activeElement !== b) b.disabled = !human;
      b.title = human ? (b.getAttribute("aria-pressed") === "true" ? "Unlock lane" : "Lock lane") : "Pause the agent to lock a lane";
    }
  }

  function fitZoom() {
    const w = Math.max(50, scroll.clientWidth - 8);
    return w / Math.max(1, durationMs);
  }

  function zoomTo(next, anchorMs = null) {
    const fit = fitZoom();
    const min = fit / 4;
    next = Math.min(MAX_PX_PER_MS, Math.max(min, next));
    if (anchorMs == null) anchorMs = (scroll.scrollLeft + scroll.clientWidth / 2) / pxPerMs;
    pxPerMs = next;
    layout();
    scroll.scrollLeft = Math.max(0, anchorMs * pxPerMs - scroll.clientWidth / 2);
    syncZoomSlider();
  }

  function layout() {
    if (!(pxPerMs > 0)) pxPerMs = fitZoom();
    content.style.width = `${Math.ceil(durationMs * pxPerMs) + 24}px`;
    view.style.width = `${scroll.clientWidth}px`;
    sizeCanvases();
    positionPlayhead();
    positionAgent();
    requestDraw();
  }

  function sizeCanvases() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, scroll.clientWidth);
    for (const cv of [ruler, ...tracksBox.querySelectorAll("canvas")]) {
      const h = cv === ruler ? RULER_H : TRACK_H;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
  }

  function requestDraw() {
    if (needsDraw) return;
    needsDraw = true;
    requestAnimationFrame(() => { needsDraw = false; draw(); });
  }

  function draw() {
    const t0 = performance.now();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const x0 = scroll.scrollLeft;
    const x1 = x0 + scroll.clientWidth;
    drawRuler(dpr, x0, x1);
    const vts = visibleTracks();
    const canvases = tracksBox.querySelectorAll("canvas");
    let drawn = 0;
    vts.forEach((tr, i) => { drawn += drawTrack(canvases[i], tr, dpr, x0, x1); });
    stats.draws++;
    stats.itemsDrawn = drawn;
    stats.lastDrawMs = performance.now() - t0;
  }

  /** Two tiers: marker band (playhead handle, AGENT label, note diamonds)
   * above the tick + timecode band. */
  function drawRuler(dpr, x0, x1) {
    const g = ruler.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = ruler.clientWidth;
    g.clearRect(0, 0, w, RULER_H);
    const { noteTimes } = ctx.store.state;
    // Note diamonds: white, one per sent note.
    g.fillStyle = "#e7e9ec";
    for (const t of noteTimes ?? []) {
      const x = t * pxPerMs - x0;
      if (x < -6 || x > w + 6) continue;
      const cy = RULER_BAND_H / 2;
      g.beginPath();
      g.moveTo(x, cy - 5);
      g.lineTo(x + 4, cy);
      g.lineTo(x, cy + 5);
      g.lineTo(x - 4, cy);
      g.closePath();
      g.fill();
    }
    // AGENT marker on the band.
    const ams = ctx.store.state.agentMs;
    if (typeof ams === "number") {
      const x = ams * pxPerMs - x0;
      if (x >= -40 && x <= w + 40) {
        g.fillStyle = C.amber;
        g.font = "600 9px Inter, system-ui, sans-serif";
        g.textBaseline = "middle";
        const label = "AGENT";
        const tw = g.measureText(label).width;
        const bx = Math.min(Math.max(x + 5, 2), w - tw - 12);
        roundRect(g, bx, 3, tw + 8, 13, 3);
        g.fill();
        g.fillStyle = "#0b0d0f";
        g.fillText(label, bx + 4, 10);
        // Amber dashed drop from the band into the tracks.
        g.strokeStyle = C.amber;
        g.lineWidth = 1;
        g.setLineDash([4, 3]);
        g.beginPath();
        g.moveTo(x, RULER_BAND_H);
        g.lineTo(x, RULER_H);
        g.stroke();
        g.setLineDash([]);
      }
    }
    // Ticks + timecodes on the lower band.
    g.fillStyle = C.text3;
    g.strokeStyle = C.line;
    g.font = "10px JetBrains Mono, Consolas, monospace";
    g.textBaseline = "top";
    const f = Math.max(1, Math.round(fps()));
    const frameMs = 1000 / f;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * frameMs);
    steps.push(5000, 10000, 15000, 30000, 60000);
    let step = steps[steps.length - 1];
    for (const s of steps) {
      if (s * pxPerMs >= 90) { step = s; break; }
    }
    const top = RULER_BAND_H + 4;
    const first = Math.floor((x0 / pxPerMs) / step) * step;
    let lastLabelRight = -Infinity;
    for (let ms = first; ms <= x1 / pxPerMs + step; ms += step) {
      const x = Math.round(ms * pxPerMs - x0) + 0.5;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, RULER_H - 4); g.stroke();
      const label = timecode(ms);
      const lw = g.measureText(label).width;
      if (x - 2 > lastLabelRight) {
        g.fillText(label, x + 3, top + 2);
        lastLabelRight = x + 3 + lw;
      }
      const minor = step / 5;
      if (minor * pxPerMs >= 7) {
        g.beginPath();
        for (let k = 1; k < 5; k++) {
          const mx = Math.round((ms + k * minor) * pxPerMs - x0) + 0.5;
          g.moveTo(mx, top + 9); g.lineTo(mx, RULER_H - 4);
        }
        g.stroke();
      }
    }
    g.fillStyle = C.line;
    g.fillRect(0, RULER_H - 1, w, 1);
  }

  const trackFill = (tr, it) => {
    if (tr.kind === "spine") return C.video;
    if (it.cueKind === "caption" || tr.kind === "caption") return C.caption;
    if (["music", "sfx", "voiceover"].includes(it.cueKind ?? tr.kind)) return C.audio;
    return C.title;
  };

  // Per-scene bust revision for servers that omit the content-keyed
  // `scene.thumb`: it advances only when that scene changed, so unrelated
  // edits keep stable thumbnail URLs (no reload).
  const thumbRev = new Map();
  function thumbUrlFor(clipId) {
    const { scenes, revision, lastChanged } = ctx.store.state;
    const scene = (scenes ?? []).find((s) => (s.members ?? []).includes(clipId));
    if (!scene) return null;
    if (scene.thumb) return ctx.api.url(scene.thumb);
    // The bust revision sticks: first-seen revision until the scene changed.
    // Falling back to the live revision here would mint a new URL (and a new
    // request) for every scene on every edit.
    if (!thumbRev.has(scene.id)) thumbRev.set(scene.id, revision ?? 0);
    else if ((scene.members ?? []).some((m) => (lastChanged ?? []).includes(m))) thumbRev.set(scene.id, revision ?? 0);
    return ctx.api.url(`/api/thumb/${encodeURIComponent(scene.id)}?v=${thumbRev.get(scene.id)}`);
  }

  function cachedImage(url, onReady) {
    let rec = imgCache.get(url);
    if (!rec) {
      const img = new Image();
      rec = { img, state: "loading" };
      imgCache.set(url, rec);
      // Scenes are few and each carries one thumbnail; 24 covers several
      // bust revisions without holding stale decoded images.
      if (imgCache.size > 24) {
        const firstKey = imgCache.keys().next().value;
        if (firstKey !== url) imgCache.delete(firstKey);
      }
      img.onload = () => { rec.state = "ready"; onReady(); };
      img.onerror = () => { rec.state = "dead"; };
      img.src = url;
    }
    return rec;
  }

  function drawTrack(cv, tr, dpr, x0, x1) {
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cv.clientWidth;
    g.clearRect(0, 0, w, TRACK_H);
    g.fillStyle = C.track;
    g.fillRect(0, 0, w, TRACK_H);
    const { selection, lastChanged, agentIds } = ctx.store.state;
    const changed = new Set(lastChanged ?? []);
    const agentSet = new Set(agentIds ?? []);
    const fresh = performance.now() - changedAt < 1000;
    const m0 = x0 / pxPerMs;
    const m1 = x1 / pxPerMs;
    let drawn = 0;
    for (const it of tr.items) {
      if (it.end < m0 || it.start > m1) continue; // virtualized: skip off-screen
      drawn++;
      const x = it.start * pxPerMs - x0;
      const iw = Math.max(2, (it.end - it.start) * pxPerMs);
      const y = 5, h = TRACK_H - 10;
      g.fillStyle = trackFill(tr, it);
      roundRect(g, x, y, iw, h, 4);
      g.fill();
      if (tr.kind === "spine") drawClipThumb(g, it, x, y, iw, h);
      else if (["music", "sfx", "voiceover"].includes(it.cueKind ?? tr.kind)) drawAudioCue(g, it, x, y, iw, h);
      else drawItemLabel(g, it.label, x, y, iw, h);
      if (tr.kind === "spine" && iw > 60) drawItemLabel(g, it.label, x, y + h - 15, iw, 14, true);
      const isSel = selection?.id === it.id;
      const isChanged = fresh && changed.has(it.id);
      if (isSel || isChanged) {
        g.strokeStyle = "#ffffff";
        g.lineWidth = isSel ? 2 : 1.5;
        roundRect(g, x + 1, y + 1, iw - 2, h - 2, 3);
        g.stroke();
        if (isSel && !isChanged) { g.fillStyle = C.accentWeak; roundRect(g, x + 1, y + 1, iw - 2, h - 2, 3); g.fill(); }
      }
      // Amber corner dot: the agent touched this clip or cue.
      if (agentSet.has(it.id) && iw > 10) {
        g.fillStyle = C.amber;
        g.beginPath();
        g.arc(x + iw - 7, y + 7, 3, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.fillStyle = C.line;
    g.fillRect(0, TRACK_H - 1, w, 1);
    return drawn;
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawClipThumb(g, it, x, y, w, h) {
    const url = thumbUrlFor(it.id);
    if (!url) return;
    const rec = cachedImage(url, requestDraw);
    if (rec.state !== "ready") return;
    const img = rec.img;
    if (!img.naturalWidth) return;
    g.save();
    roundRect(g, x, y, w, h, 4);
    g.clip();
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
    g.globalAlpha = 0.9;
    g.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    g.restore();
  }

  function drawItemLabel(g, text, x, y, w, h, small = false) {
    if (w < 24) return;
    g.save();
    roundRect(g, x, y, w, h, 4);
    g.clip();
    g.fillStyle = small ? C.text2 : C.text1;
    g.font = small ? "10px Inter, system-ui, sans-serif" : "11px Inter, system-ui, sans-serif";
    g.textBaseline = "middle";
    let label = String(text ?? "");
    const maxW = w - 12;
    if (g.measureText(label).width > maxW) {
      while (label.length > 1 && g.measureText(label + "…").width > maxW) label = label.slice(0, -1);
      label += "…";
    }
    g.fillText(label, x + 6, y + h / 2 + 0.5);
    g.restore();
  }

  // Audio cue: waveform plus a label, with the block outlined so it reads
  // as a block against the track background even without peak data.
  function drawAudioCue(g, it, x, y, w, h) {
    g.save();
    g.globalAlpha = 0.6;
    g.strokeStyle = C.wave;
    g.lineWidth = 1;
    roundRect(g, x + 0.5, y + 0.5, w - 1, h - 1, 4);
    g.stroke();
    g.restore();
    drawWave(g, it, x, y, w, h - 14);
    if (w > 60) drawItemLabel(g, it.label, x, y + h - 15, w, 14, true);
  }

  function drawWave(g, it, x, y, w, h) {
    // Peaks come from the waveform analysis once the server exposes it
    // (contract wish); until then a flat center bar marks audio cues.
    const peaks = Array.isArray(it.ref?.waveform_peaks) ? it.ref.waveform_peaks : null;
    g.fillStyle = C.wave;
    if (!peaks?.length) {
      g.fillRect(x + 4, y + h / 2 - 1, Math.max(0, w - 8), 2);
      return;
    }
    const n = peaks.length;
    const bw = Math.max(1, (w - 8) / n);
    for (let i = 0; i < n; i++) {
      const v = Math.min(1, Math.max(0.03, peaks[i]));
      const bh = v * (h - 12);
      g.fillRect(x + 4 + i * bw, y + h / 2 - bh / 2, Math.max(1, bw - 0.5), bh);
    }
  }

  function positionPlayhead() {
    playheadEl.style.transform = `translateX(${playheadX(ctx.store.state.playheadMs, pxPerMs)}px)`;
  }

  /** Amber agent line across the scrolled content; hidden without a fix. */
  function positionAgent() {
    const ms = ctx.store.state.agentMs;
    if (typeof ms !== "number") {
      agentEl.hidden = true;
      return;
    }
    agentEl.hidden = false;
    agentEl.style.transform = `translateX(${Math.round(ms * pxPerMs)}px)`;
    agentEl.classList.toggle("following", !!ctx.store.state.agentFollow);
  }

  function msAtEvent(ev) {
    const rect = ruler.getBoundingClientRect();
    return Math.max(0, (ev.clientX - rect.left + scroll.scrollLeft) / pxPerMs);
  }

  // Ruler scrubbing. Any manual move drops the agent follow.
  let scrubbing = false;
  ruler.addEventListener("pointerdown", (ev) => {
    scrubbing = true;
    ruler.setPointerCapture(ev.pointerId);
    ctx.store.set({ playheadMs: Math.round(msAtEvent(ev)), agentFollow: false });
  });
  ruler.addEventListener("pointermove", (ev) => {
    if (scrubbing) ctx.store.set({ playheadMs: Math.round(msAtEvent(ev)), agentFollow: false });
  });
  ruler.addEventListener("pointerup", () => { scrubbing = false; });

  // The agent line/tag locks the timeline onto the agent: later agent edits
  // scroll it into view. Clicking anywhere else on the timeline releases it.
  agentEl.addEventListener("click", (ev) => {
    ev.stopPropagation();
    ctx.store.set({ agentFollow: true });
    ensureMsVisible(ctx.store.state.agentMs);
  });

  function onTrackClick(ev, tr) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - rect.left + scroll.scrollLeft;
    const ms = x / pxPerMs;
    const hit = pickItemAt(tr.items, ms);
    if (hit) ctx.store.set({ selection: { id: hit.id, kind: hit.kind }, agentFollow: false });
    else ctx.store.set({ playheadMs: Math.round(ms), agentFollow: false });
  }

  // Smallest scroll that brings the playhead into the visible area.
  function ensureMsVisible(ms) {
    if (typeof ms !== "number") return;
    const x = ms * pxPerMs;
    const margin = 24;
    if (x < scroll.scrollLeft + margin) scroll.scrollLeft = Math.max(0, x - margin);
    else if (x > scroll.scrollLeft + scroll.clientWidth - margin) scroll.scrollLeft = x - scroll.clientWidth + margin;
  }
  function ensurePlayheadVisible() {
    ensureMsVisible(ctx.store.state.playheadMs);
  }

  // Zoom: slider + Ctrl+wheel anchored at the cursor; plain wheel pans.
  function syncZoomSlider() {
    const fit = fitZoom();
    const min = fit / 4;
    const ratio = Math.log(pxPerMs / min) / Math.log(MAX_PX_PER_MS / min);
    zoomInput.value = String(Math.round(Math.min(1, Math.max(0, ratio)) * 1000));
  }
  zoomInput.addEventListener("input", () => {
    const fit = fitZoom();
    const min = fit / 4;
    zoomTo(min * Math.pow(MAX_PX_PER_MS / min, Number(zoomInput.value) / 1000), ctx.store.state.playheadMs ?? 0);
  });
  scroll.addEventListener("wheel", (ev) => {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      const rect = ruler.getBoundingClientRect();
      const anchorMs = (ev.clientX - rect.left + scroll.scrollLeft) / pxPerMs;
      zoomTo(pxPerMs * (ev.deltaY < 0 ? 1.25 : 0.8), anchorMs);
    } else if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) {
      ev.preventDefault();
      scroll.scrollLeft += ev.deltaY;
    }
  }, { passive: false });
  root.querySelector(".tl-fit").addEventListener("click", () => {
    pxPerMs = fitZoom();
    layout();
    scroll.scrollLeft = 0;
    syncZoomSlider();
  });
  const emptyBtn = root.querySelector(".tl-empty");
  emptyBtn.addEventListener("click", () => {
    showEmpty = !showEmpty;
    emptyBtn.setAttribute("aria-pressed", showEmpty ? "true" : "false");
    emptyBtn.title = showEmpty ? "Hide empty lanes" : "Show empty lanes";
    rebuild();
  });

  scroll.addEventListener("scroll", () => {
    labelsCol.scrollTop = scroll.scrollTop;
    requestDraw();
  });

  function syncMode() {
    const human = ctx.store.state.mode === "human";
    for (const b of root.querySelectorAll("[data-edit-action]")) {
      b.toggleAttribute("disabled", !human);
      b.title = `${b.getAttribute("aria-label")}${human ? "" : " (disabled while the agent edits)"}`;
    }
    syncLockButtons();
  }

  new ResizeObserver(() => layout()).observe(scroll);

  ctx.store.on("snapshot", () => {
    thumbRev.clear();
    rebuild();
    changedAt = performance.now();
    syncMode();
    // Pending packets predate the connection: seed the ruler diamonds from
    // the inbox, then live "notes" events keep them current.
    ctx.api.get("/api/inbox").then((packets) => {
      if (!Array.isArray(packets)) return;
      const times = [...(ctx.store.state.noteTimes ?? [])];
      for (const p of packets) for (const n of p.notes ?? []) {
        if (typeof n.at_ms === "number" && !times.includes(n.at_ms)) times.push(n.at_ms);
      }
      ctx.store.set({ noteTimes: times.slice(-200) });
      requestDraw();
    }).catch(() => {});
  });
  ctx.store.on("delta", () => {
    rebuild();
    changedAt = performance.now();
    setTimeout(requestDraw, 1100);
    if (ctx.store.state.agentFollow) ensureMsVisible(ctx.store.state.agentMs);
  });
  ctx.store.on("notes", (packets) => {
    const times = [...(ctx.store.state.noteTimes ?? [])];
    for (const p of packets ?? []) for (const n of p.notes ?? []) {
      if (typeof n.at_ms === "number" && !times.includes(n.at_ms)) times.push(n.at_ms);
    }
    ctx.store.set({ noteTimes: times.slice(-200) });
    requestDraw();
  });
  ctx.store.on("state", (patch) => {
    if (!patch) return;
    if ("sequence" in patch || "scenes" in patch) rebuild();
    else if ("selection" in patch || "lastChanged" in patch || "agentIds" in patch) requestDraw();
    if ("playheadMs" in patch) {
      positionPlayhead();
      // A jump that also selects (scene/activity click) reveals the playhead;
      // plain playhead moves (playback, scrubbing) never steal the scroll.
      if ("selection" in patch) ensurePlayheadVisible();
      requestDraw();
    }
    if ("agentMs" in patch) {
      positionAgent();
      if (ctx.store.state.agentFollow) ensureMsVisible(ctx.store.state.agentMs);
      requestDraw();
    }
    if ("mode" in patch) syncMode();
  });
  // The preview publishes the running playhead on the "playhead" event, not a
  // state patch: without this the blue line never moves while video plays.
  ctx.store.on("playhead", () => positionPlayhead());
  ctx.store.on("connection", syncMode);

  rebuild();
  syncMode();
  syncZoomSlider();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Sequence-time of a changed handle, for the agent line. */
export function locateChangedMs(sequence, id) {
  const clip = sequence?.spine?.clips?.find((c) => c.id === id);
  if (clip) return clip.timeline_in_ms ?? 0;
  for (const lane of sequence?.lanes ?? []) {
    const cue = lane?.cues?.find((q) => q.id === id);
    if (cue) {
      if (!cue?.anchor?.ref) return cue?.at_ms ?? 0;
      const anchor = sequence?.spine?.clips?.find((c) => c.id === cue.anchor.ref);
      return anchor ? anchor.timeline_in_ms + (cue.anchor.offset_ms ?? 0) : cue.at_ms ?? 0;
    }
  }
  return null;
}

/**
 * Agent line position + amber-dot ids from the activity feed. The line sits
 * on the first item the newest agent revision changed; dots cover the last
 * 5 agent revisions. Human revisions never move the line.
 */
export function agentMarks(activity, sequence) {
  let ms = null;
  const ids = [];
  let seen = 0;
  for (const e of activity ?? []) {
    if (e?.actor !== "agent") continue;
    if (ms === null) {
      const first = (e.changed ?? [])[0];
      if (first != null) ms = locateChangedMs(sequence, first);
    }
    for (const id of e.changed ?? []) {
      if (!ids.includes(id)) ids.push(id);
    }
    if (++seen >= 5) break;
  }
  return { ms, ids };
}

/** Playhead content offset: the blue line advances with the playhead. */
export function playheadX(playheadMs, pxPerMs) {
  return Math.round((playheadMs ?? 0) * pxPerMs);
}

/**
 * Item under a track position. Items paint in order, so on overlap the last
 * match is the visible (topmost) one; the click selects what is seen.
 */
export function pickItemAt(items, ms) {
  let hit = null;
  for (const it of items ?? []) {
    if (ms >= it.start && ms <= it.end) hit = it;
  }
  return hit;
}
