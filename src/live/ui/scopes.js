/* Scopes panel: luma waveform, RGB parade or vectorscope, histogram, computed in the
   browser from the graded canvas (downsampled readPixels). Off
   by default; zero cost when closed (no readPixels, no RAF). */

/** Tetrahedral sampling of a decoded LUT (shared with the grade path tests). */
export function tetrahedralGrade(lut, p) {
  const n = lut.size, d = lut.data, s = n - 1;
  const x = Math.min(1, Math.max(0, p[0])) * s;
  const y = Math.min(1, Math.max(0, p[1])) * s;
  const z = Math.min(1, Math.max(0, p[2])) * s;
  const r0 = Math.min(Math.floor(x), s - 1), g0 = Math.min(Math.floor(y), s - 1), b0 = Math.min(Math.floor(z), s - 1);
  const fr = x - r0, fg = y - g0, fb = z - b0;
  const idx = (r, g, b) => ((b * n + g) * n + r) * 3;
  const c000 = idx(r0, g0, b0), c111 = idx(r0 + 1, g0 + 1, b0 + 1);
  let c1, c2, t1, t2, t3;
  if (fr > fg) {
    if (fg > fb) { c1 = idx(r0 + 1, g0, b0); c2 = idx(r0 + 1, g0 + 1, b0); t1 = fr; t2 = fg; t3 = fb; }
    else if (fr > fb) { c1 = idx(r0 + 1, g0, b0); c2 = idx(r0 + 1, g0, b0 + 1); t1 = fr; t2 = fb; t3 = fg; }
    else { c1 = idx(r0, g0, b0 + 1); c2 = idx(r0 + 1, g0, b0 + 1); t1 = fb; t2 = fr; t3 = fg; }
  } else if (fb > fg) { c1 = idx(r0, g0, b0 + 1); c2 = idx(r0, g0 + 1, b0 + 1); t1 = fb; t2 = fg; t3 = fr; }
  else if (fb > fr) { c1 = idx(r0, g0 + 1, b0); c2 = idx(r0, g0 + 1, b0 + 1); t1 = fg; t2 = fb; t3 = fr; }
  else { c1 = idx(r0, g0 + 1, b0); c2 = idx(r0 + 1, g0 + 1, b0); t1 = fg; t2 = fr; t3 = fb; }
  for (let c = 0; c < 3; c++) p[c] = (1 - t1) * d[c000 + c] + (t1 - t2) * d[c1 + c] + (t2 - t3) * d[c2 + c] + t3 * d[c111 + c];
}

/** Base64 Float32 RGB -> Float32Array. */
export function decodeLut(json) {
  const bin = atob(json.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** Downsampled readPixels of a canvas (max 160 wide); null when the canvas is missing. */
export function grabFrame(canvas, maxW = 240) {
  // A canvas (graded picture) or a <video> (ungraded item).
  const sw = canvas ? (canvas.videoWidth ?? canvas.width) : 0;
  const sh = canvas ? (canvas.videoHeight ?? canvas.height) : 0;
  if (!canvas || !sw || !sh) return null;
  const w = Math.min(maxW, sw);
  const h = Math.max(1, Math.round((sh * w) / sw));
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  tmp.getContext("2d").drawImage(canvas, 0, 0, w, h);
  return tmp.getContext("2d").getImageData(0, 0, w, h);
}

export function lumaHistogram(image) {
  const hist = new Array(64).fill(0);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    hist[Math.min(63, y >> 2)]++;
  }
  return hist;
}

export function rgbParade(image, cols = 96) {
  const r = new Array(cols).fill(0), g = new Array(cols).fill(0), b = new Array(cols).fill(0);
  const d = image.data, w = image.width, h = image.height;
  for (let x = 0; x < w; x++) {
    const c = Math.min(cols - 1, Math.floor((x / w) * cols));
    for (let y = 0; y < h; y += 2) {
      const o = (y * w + x) * 4;
      r[c] += d[o]; g[c] += d[o + 1]; b[c] += d[o + 2];
    }
  }
  return { r, g, b };
}

/**
 * Paints a real scope from a downsampled frame: every pixel adds to a density buffer, so the trace
 * reads like a broadcast scope (not one averaged dot per column).
 * - waveform: x = image column, y = BT.709 luma
 * - parade: R, G, B waveforms side by side
 * - vectorscope: BT.709 Cb/Cr, graticule ring at 75% and the skin-tone line
 * - histogram: R, G, B and luma
 */
export function paintScopes(el, image, mode) {
  const x = el.getContext("2d");
  const W = el.width, H = el.height;
  x.fillStyle = "#000";
  x.fillRect(0, 0, W, H);
  if (!image) { x.fillStyle = "#888"; x.font = "11px sans-serif"; x.fillText("no frame", 8, 16); return; }
  const d = image.data, w = image.width, h = image.height;
  const out = x.createImageData(W, H);
  const o = out.data;
  const acc = new Float32Array(W * H * 3);
  const add = (px, py, r, g, b) => {
    if (px < 0 || py < 0 || px >= W || py >= H) return;
    const k = ((py | 0) * W + (px | 0)) * 3;
    acc[k] += r; acc[k + 1] += g; acc[k + 2] += b;
  };
  const grid = (rows) => {
    x.strokeStyle = "rgba(255,255,255,0.12)";
    x.lineWidth = 1;
    for (const f of rows) { x.beginPath(); x.moveTo(0, Math.round(f * H) + 0.5); x.lineTo(W, Math.round(f * H) + 0.5); x.stroke(); }
  };
  if (mode === "waveform" || mode === "parade") {
    const lanes = mode === "parade" ? 3 : 1;
    const laneW = W / lanes;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const i = (py * w + px) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (lanes === 1) {
          const yv = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          add((px / w) * laneW, (1 - yv / 255) * (H - 1), 1, 1, 1);
        } else {
          const X = (px / w) * laneW;
          add(X, (1 - r / 255) * (H - 1), 1, 0, 0);
          add(laneW + X, (1 - g / 255) * (H - 1), 0, 1, 0);
          add(2 * laneW + X, (1 - b / 255) * (H - 1), 0, 0, 1);
        }
      }
    }
  } else if (mode === "vectorscope") {
    const R = Math.min(W, H) / 2 - 4, cx = W / 2, cy = H / 2;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const yv = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const cb = (b - yv) / 1.8556, cr = (r - yv) / 1.5748;
      add(cx + cb * 2 * R, cy - cr * 2 * R, 0.6, 1, 0.6);
    }
  }
  if (mode !== "histogram") {
    let peak = 1;
    for (let k = 0; k < acc.length; k++) if (acc[k] > peak) peak = acc[k];
    const gain = 255 / Math.log1p(peak);
    for (let p = 0, k = 0; p < W * H; p++, k += 3) {
      o[p * 4] = Math.log1p(acc[k]) * gain;
      o[p * 4 + 1] = Math.log1p(acc[k + 1]) * gain;
      o[p * 4 + 2] = Math.log1p(acc[k + 2]) * gain;
      o[p * 4 + 3] = 255;
    }
    x.putImageData(out, 0, 0);
    if (mode === "vectorscope") {
      const R = Math.min(W, H) / 2 - 4, cx = W / 2, cy = H / 2;
      x.strokeStyle = "rgba(255,255,255,0.2)";
      x.beginPath(); x.arc(cx, cy, R * 0.75, 0, Math.PI * 2); x.stroke();
      x.beginPath(); x.moveTo(cx - 4, cy); x.lineTo(cx + 4, cy); x.moveTo(cx, cy - 4); x.lineTo(cx, cy + 4); x.stroke();
      // Skin-tone line (about 123° in the Cb/Cr plane, upper left).
      const a = (123 * Math.PI) / 180;
      x.strokeStyle = "rgba(255,190,140,0.35)";
      x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.cos(a) * R, cy - Math.sin(a) * R); x.stroke();
    } else {
      grid([0, 0.25, 0.5, 0.75, 1]);
      if (mode === "parade") {
        x.strokeStyle = "rgba(255,255,255,0.15)";
        for (const f of [1 / 3, 2 / 3]) { x.beginPath(); x.moveTo(Math.round(f * W) + 0.5, 0); x.lineTo(Math.round(f * W) + 0.5, H); x.stroke(); }
      }
    }
    return;
  }
  // histogram: R, G, B, luma (64 bins)
  const bins = 64;
  const hr = new Array(bins).fill(0), hg = new Array(bins).fill(0), hb = new Array(bins).fill(0), hy = new Array(bins).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    hr[d[i] >> 2]++; hg[d[i + 1] >> 2]++; hb[d[i + 2] >> 2]++;
    hy[Math.min(63, Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) >> 2)]++;
  }
  const m = Math.max(1, ...hr, ...hg, ...hb, ...hy);
  const draw = (hist, color) => {
    x.fillStyle = color;
    hist.forEach((v, i) => { const hh = (v / m) * (H - 6); x.fillRect((i / bins) * W, H - hh, W / bins, hh); });
  };
  x.globalCompositeOperation = "lighter";
  draw(hr, "rgba(255,60,60,0.55)");
  draw(hg, "rgba(60,255,60,0.55)");
  draw(hb, "rgba(80,120,255,0.55)");
  x.globalCompositeOperation = "source-over";
  x.strokeStyle = "rgba(255,255,255,0.8)";
  x.beginPath();
  hy.forEach((v, i) => { const X = (i + 0.5) * (W / bins), Y = H - (v / m) * (H - 6); if (i) x.lineTo(X, Y); else x.moveTo(X, Y); });
  x.stroke();
}

/** Scopes panel owned by the inspector region. Zero cost when closed. */
export function mountScopesPanel(host, ctx, getGradeCanvas) {
  let open = false, mode = "waveform", raf = 0, last = 0;
  host.innerHTML = `<div class="sc-head"><button class="sc-toggle">Scopes</button>
    <select class="sc-mode" hidden><option value="waveform">waveform</option><option value="parade">parade</option><option value="vectorscope">vectorscope</option><option value="histogram">histogram</option></select></div>
    <canvas class="sc-canvas" width="360" height="220" hidden></canvas>`;
  const btn = host.querySelector(".sc-toggle"), sel = host.querySelector(".sc-mode"), canvas = host.querySelector(".sc-canvas");
  // The graded picture when the item has a grade, otherwise the visible video.
  const source = () => getGradeCanvas() ?? [...document.querySelectorAll(".pv-video")].find((v) => v.style.visibility !== "hidden" && v.readyState >= 2) ?? null;
  const tick = (now) => {
    if (!open) return;
    if (!last || now - last > 66) {
      last = now;
      try { paintScopes(canvas, grabFrame(source()), mode); } catch (e) { console.error("[color] scopes", e); }
    }
    raf = requestAnimationFrame(tick);
  };
  btn.addEventListener("click", () => {
    open = !open;
    sel.hidden = !open; canvas.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) { last = 0; raf = requestAnimationFrame(tick); } else cancelAnimationFrame(raf);
  });
  sel.addEventListener("change", () => { mode = sel.value; last = 0; });
  return {
    setItem() {},
    get open() { return open; },
    destroy() { open = false; cancelAnimationFrame(raf); },
  };
}
