// Composition scaffolding and the composition contract validator (split out of hyperframes_bridge.ts).
import fs from "node:fs";
import path from "node:path";
import {
  extractScalarHyperFramesVariables
} from "./bridge_exporter.js";
import {
  CUTHOL_BRIDGE_SCHEMA,
  CutholBridgeV1,
  getCutholRuntimeJsSource,
} from "./cuthol_runtime.js";
import { HyperFramesScaffoldOptions, findLocalGsapMinJs, HyperFramesValidationResult, HyperFramesLintFinding } from "./hf_common.js";
import { lintHyperFramesComposition } from "./hf_lint.js";

/**
 * Generates a deterministic, offline-self-contained HyperFrames HTML composition
 * that obeys all `/hyperframes-core` lint and determinism rules.
 */
export function scaffoldHyperFramesComposition(options: HyperFramesScaffoldOptions): {
  compositionDir: string;
  entryHtml: string;
  compositionId: string;
} {
  const compDir = path.resolve(options.targetDir);
  const assetsDir = path.join(compDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  // Copy local gsap.min.js into composition assets/ so no network/CDN request occurs
  const gsapSrc = findLocalGsapMinJs();
  const gsapDest = path.join(assetsDir, "gsap.min.js");
  fs.copyFileSync(gsapSrc, gsapDest);

  const rawCompId = options.compositionId ?? "main";
  const compId = rawCompId.replace(/[^a-zA-Z0-9_-]/g, "_") || "main";
  const durationSec = Number((options.durationMs / 1000).toFixed(3));
  const preset = options.preset ?? "lower_third";
  const props = options.props ?? {};

  // Write initial cuthol-runtime.js, cuthol-data.json/js, and cuthol-vars.json
  const runtimeDest = path.join(assetsDir, "cuthol-runtime.js");
  fs.writeFileSync(runtimeDest, getCutholRuntimeJsSource(), "utf8");

  const safeMarginX = Math.round(options.width * 0.05);
  const safeMarginY = Math.round(options.height * 0.05);
  const initialBridgePayload: CutholBridgeV1 = {
    schema: CUTHOL_BRIDGE_SCHEMA,
    hash: "sha256:initial000000000",
    composition: {
      id: compId,
      cueId: compId,
      duration: durationSec,
      fps: options.fps,
      width: options.width,
      height: options.height,
      sequenceStartSec: 0,
    },
    props,
    words: [],
    sentences: [],
    pauses: [],
    beats: { bpm: 120, times: [], strength: [], downbeats: [] },
    audio: { fps: 0, t0: 0, bands: ["low", "mid", "high"], low: [], mid: [], high: [] },
    cuts: [],
    segments: [{ t0: 0, t1: durationSec, index: 0, duration: durationSec }],
    safeZone: {
      px: {
        x: safeMarginX,
        y: safeMarginY,
        w: options.width - safeMarginX * 2,
        h: options.height - safeMarginY * 2,
      },
    },
  };
  const dataJsonPath = path.join(assetsDir, "cuthol-data.json");
  const dataJsPath = path.join(assetsDir, "cuthol-data.js");
  if (!fs.existsSync(dataJsonPath)) {
    const jsonStr = JSON.stringify(initialBridgePayload, null, 2);
    fs.writeFileSync(dataJsonPath, jsonStr, "utf8");
    fs.writeFileSync(dataJsPath, `window.__CUTHOL_DATA__ = ${jsonStr};\n`, "utf8");
  }

  const scalarVars = extractScalarHyperFramesVariables(props);
  fs.writeFileSync(path.join(assetsDir, "cuthol-vars.json"), JSON.stringify(scalarVars, null, 2), "utf8");

  const varDeclarations = Object.entries(scalarVars).map(([key, val]) => ({
    id: key,
    type:
      typeof val === "number"
        ? "number"
        : typeof val === "boolean"
          ? "boolean"
          : /^#[0-9a-fA-F]{3,8}$/.test(String(val))
            ? "color"
            : "string",
    label: key,
    default: val,
  }));
  const varsAttr =
    varDeclarations.length > 0
      ? ` data-composition-variables='${JSON.stringify(varDeclarations).replace(/'/g, "&#39;")}'`
      : "";

  const headline = String(props.headline ?? props.title ?? "CUTHOL MOTION");
  const subline = String(props.subline ?? props.subtitle ?? "DETERMINISTIC AGENT STUDIO");
  const metricValue = String(props.value ?? "99.4%");
  const rawAccent = String(props.accent ?? "#38BDF8");
  const accentHex = /^#[0-9a-fA-F]{3,8}$/.test(rawAccent) ? rawAccent : "#38BDF8";

  // When transparent is true (or legacy #00FF00 chromakey was passed), use true CSS `transparent`
  const wantTransparent =
    options.transparent === true ||
    options.bgColorHex === "transparent" ||
    (options.bgColorHex?.toUpperCase() === "#00FF00" && options.transparent !== false);
  const rawBg = wantTransparent ? "transparent" : (options.bgColorHex ?? "#0F172A");
  const bgHex =
    rawBg === "transparent" || /^#[0-9a-fA-F]{3,8}$/.test(rawBg) ? rawBg : "#0F172A";

  // Scale GSAP entrance tween timings proportionally when durationSec < 0.7s
  const ts = Math.min(1, Math.max(0.1, durationSec / 0.7));
  const st = (sec: number): number => Number((sec * ts).toFixed(3));

  let innerMarkup = "";
  let gsapScript = "";

  if (preset === "stat_callout") {
    innerMarkup = `
      <section id="${compId}-slot" class="clip" data-start="0" data-duration="${durationSec}">
        <div id="${compId}-card" class="stat-card">
          <div id="${compId}-val" class="stat-value">${escapeHtml(metricValue)}</div>
          <div id="${compId}-lbl" class="stat-label">${escapeHtml(headline)}</div>
        </div>
      </section>`;
    gsapScript = `
      const C = window.__cuthol;
      const P = Object.assign({}, (C && C.props) || {}, (window.__hyperframes && typeof window.__hyperframes.getVariables === "function" && window.__hyperframes.getVariables()) || {});
      const valNode = document.getElementById("${compId}-val");
      const lblNode = document.getElementById("${compId}-lbl");
      if (valNode && P.value !== undefined) valNode.textContent = String(P.value);
      if (lblNode && (P.headline !== undefined || P.title !== undefined)) lblNode.textContent = String(P.headline !== undefined ? P.headline : P.title);
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#${compId}-card", { y: 60, opacity: 0, scale: 0.92 }, { y: 0, opacity: 1, scale: 1, duration: ${st(0.45)}, ease: "power3.out" }, ${st(0.05)});
      tl.fromTo("#${compId}-val", { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: ${st(0.35)}, ease: "power2.out" }, ${st(0.2)});
      tl.fromTo("#${compId}-lbl", { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: ${st(0.35)}, ease: "power2.out" }, ${st(0.3)});
      window.__timelines["${compId}"] = tl;`;
  } else if (preset === "title_card") {
    innerMarkup = `
      <section id="${compId}-slot" class="clip" data-start="0" data-duration="${durationSec}">
        <div id="${compId}-banner" class="title-banner">
          <div id="${compId}-pill" class="pill">${escapeHtml(subline)}</div>
          <h1 id="${compId}-title" class="headline">${escapeHtml(headline)}</h1>
        </div>
      </section>`;
    gsapScript = `
      const C = window.__cuthol;
      const P = Object.assign({}, (C && C.props) || {}, (window.__hyperframes && typeof window.__hyperframes.getVariables === "function" && window.__hyperframes.getVariables()) || {});
      const pillNode = document.getElementById("${compId}-pill");
      const titleNode = document.getElementById("${compId}-title");
      if (pillNode && (P.subline !== undefined || P.subtitle !== undefined)) pillNode.textContent = String(P.subline !== undefined ? P.subline : P.subtitle);
      if (titleNode && (P.headline !== undefined || P.title !== undefined)) titleNode.textContent = String(P.headline !== undefined ? P.headline : P.title);
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#${compId}-banner", { y: 50, opacity: 0 }, { y: 0, opacity: 1, duration: ${st(0.5)}, ease: "power3.out" }, ${st(0.05)});
      tl.fromTo("#${compId}-pill", { scale: 0.85, opacity: 0 }, { scale: 1, opacity: 1, duration: ${st(0.35)}, ease: "back.out(1.6)" }, ${st(0.15)});
      tl.fromTo("#${compId}-title", { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: ${st(0.45)}, ease: "power3.out" }, ${st(0.22)});
      window.__timelines["${compId}"] = tl;`;
  } else if (preset === "badge_overlay") {
    innerMarkup = `
      <section id="${compId}-slot" class="clip" data-start="0" data-duration="${durationSec}">
        <div id="${compId}-badge" class="badge-overlay-box">
          <div id="${compId}-dot" class="badge-dot"></div>
          <div id="${compId}-h1" class="badge-text">${escapeHtml(headline)}</div>
        </div>
      </section>`;
    gsapScript = `
      const C = window.__cuthol;
      const P = Object.assign({}, (C && C.props) || {}, (window.__hyperframes && typeof window.__hyperframes.getVariables === "function" && window.__hyperframes.getVariables()) || {});
      const h1Node = document.getElementById("${compId}-h1");
      if (h1Node && (P.headline !== undefined || P.title !== undefined)) h1Node.textContent = String(P.headline !== undefined ? P.headline : P.title);
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#${compId}-badge", { y: -40, opacity: 0, scale: 0.9 }, { y: 0, opacity: 1, scale: 1, duration: ${st(0.4)}, ease: "back.out(1.5)" }, ${st(0.05)});
      tl.fromTo("#${compId}-dot", { scale: 0 }, { scale: 1, duration: ${st(0.3)}, ease: "power2.out" }, ${st(0.15)});
      tl.fromTo("#${compId}-h1", { x: 12, opacity: 0 }, { x: 0, opacity: 1, duration: ${st(0.35)}, ease: "power2.out" }, ${st(0.18)});
      window.__timelines["${compId}"] = tl;`;
  } else if (preset === "counter") {
    const targetPhrase = String(props.phrase ?? props.word ?? "doksan dokuz");
    const targetNum = Number(props.target ?? 99.4);
    innerMarkup = `
      <section id="${compId}-slot" class="clip" data-start="0" data-duration="${durationSec}">
        <div id="${compId}-card" class="stat-card">
          <div id="${compId}-val" class="stat-value" style="font-variant-numeric:tabular-nums">0.0</div>
          <div id="${compId}-lbl" class="stat-label">${escapeHtml(headline)}</div>
        </div>
      </section>`;
    gsapScript = `
      const C = window.__cuthol;
      const P = Object.assign({}, (C && C.props) || {}, (window.__hyperframes && typeof window.__hyperframes.getVariables === "function" && window.__hyperframes.getVariables()) || {});
      const tl = gsap.timeline({ paused: true });
      const valEl = document.getElementById("${compId}-val");
      const lblEl = document.getElementById("${compId}-lbl");
      if (lblEl && (P.headline !== undefined || P.title !== undefined)) lblEl.textContent = String(P.headline !== undefined ? P.headline : P.title);
      const phrase = String(P.phrase !== undefined ? P.phrase : (P.word !== undefined ? P.word : ${JSON.stringify(targetPhrase)}));
      const numTarget = Number(P.target !== undefined ? P.target : ${targetNum});
      const hit = C.word(phrase, { fallback: ${st(0.2)} });
      const hitStart = Math.max(0, hit.start);
      tl.fromTo("#${compId}-card", { y: 40, opacity: 0, scale: 0.94 }, { y: 0, opacity: 1, scale: 1, duration: ${st(0.4)}, ease: "power3.out" }, Math.max(0, hitStart - 0.1));
      C.value(tl, { from: 0, to: numTarget, at: hitStart, duration: Math.max(hit.duration, ${st(0.6)}), ease: "power2.out" }, function (v) {
        if (valEl) valEl.textContent = v.toFixed(1);
      });
      tl.fromTo("#${compId}-lbl", { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: ${st(0.35)}, ease: "power2.out" }, hitStart + 0.1);
      tl.set({}, {}, C.duration || ${durationSec});
      window.__timelines["${compId}"] = tl;`;
  } else if (preset === "beat_cards") {
    innerMarkup = `
      <section id="${compId}-slot" class="clip" data-start="0" data-duration="${durationSec}">
        <div id="${compId}-stage" style="position:relative;width:100%;height:100%"></div>
      </section>`;
    gsapScript = `
      const C = window.__cuthol;
      const P = Object.assign({}, (C && C.props) || {}, (window.__hyperframes && typeof window.__hyperframes.getVariables === "function" && window.__hyperframes.getVariables()) || {});
      const hText = String(P.headline !== undefined ? P.headline : (P.title !== undefined ? P.title : ${JSON.stringify(headline)}));
      const tl = gsap.timeline({ paused: true });
      const stage = document.getElementById("${compId}-stage");
      const beats = C.beats({ strong: true });
      const list = beats.length > 0 ? beats : [0.1, 0.5, 0.9];
      list.slice(0, 6).forEach(function (t, i) {
        const el = document.createElement("div");
        el.className = "badge-overlay-box";
        el.style.top = (C.safe.y + i * 92) + "px";
        el.style.right = C.safe.x + "px";
        el.textContent = hText + " #" + (i + 1);
        stage.appendChild(el);
        gsap.set(el, { opacity: 0 });
        tl.fromTo(el, { opacity: 0, scale: 1.35, x: 40 }, { opacity: 1, scale: 1, x: 0, duration: 0.25, ease: "expo.out" }, Math.max(0, t));
      });
      tl.set({}, {}, C.duration || ${durationSec});
      window.__timelines["${compId}"] = tl;`;
  } else if (preset === "audio_glow") {
    innerMarkup = `
      <section id="${compId}-slot" class="clip" data-start="0" data-duration="${durationSec}">
        <div id="${compId}-banner" class="title-banner">
          <div id="${compId}-pill" class="pill">${escapeHtml(subline)}</div>
          <h1 id="${compId}-title" class="headline">${escapeHtml(headline)}</h1>
        </div>
      </section>`;
    gsapScript = `
      const C = window.__cuthol;
      const P = Object.assign({}, (C && C.props) || {}, (window.__hyperframes && typeof window.__hyperframes.getVariables === "function" && window.__hyperframes.getVariables()) || {});
      const pillNode = document.getElementById("${compId}-pill");
      const titleNode = document.getElementById("${compId}-title");
      if (pillNode && (P.subline !== undefined || P.subtitle !== undefined)) pillNode.textContent = String(P.subline !== undefined ? P.subline : P.subtitle);
      if (titleNode && (P.headline !== undefined || P.title !== undefined)) titleNode.textContent = String(P.headline !== undefined ? P.headline : P.title);
      const tl = gsap.timeline({ paused: true });
      const banner = document.getElementById("${compId}-banner");
      C.drive(tl, function (t) {
        const low = C.audio("low", t, 0.06);
        const mid = C.audio("mid", t, 0.04);
        gsap.set(banner, { scale: 0.95 + 0.12 * low, opacity: 0.75 + 0.25 * mid });
      });
      tl.set({}, {}, C.duration || ${durationSec});
      window.__timelines["${compId}"] = tl;`;
  } else if (preset === "cut_phases") {
    innerMarkup = `
      <section id="${compId}-slot" class="clip" data-start="0" data-duration="${durationSec}">
        <div id="${compId}-stage" style="position:relative;width:100%;height:100%"></div>
      </section>`;
    gsapScript = `
      const C = window.__cuthol;
      const P = Object.assign({}, (C && C.props) || {}, (window.__hyperframes && typeof window.__hyperframes.getVariables === "function" && window.__hyperframes.getVariables()) || {});
      const hText = String(P.headline !== undefined ? P.headline : (P.title !== undefined ? P.title : ${JSON.stringify(headline)}));
      const tl = gsap.timeline({ paused: true });
      const stage = document.getElementById("${compId}-stage");
      const segs = C.cuts().segments;
      segs.forEach(function (seg) {
        const el = document.createElement("div");
        el.className = "lower-third-box";
        const bar = document.createElement("div");
        bar.className = "accent-bar";
        const col = document.createElement("div");
        col.className = "text-col";
        const titleEl = document.createElement("div");
        titleEl.className = "lt-title";
        titleEl.textContent = hText + " (" + (seg.index + 1) + ")";
        col.appendChild(titleEl);
        el.appendChild(bar);
        el.appendChild(col);
        stage.appendChild(el);
        gsap.set(el, { opacity: 0 });
        tl.fromTo(el, { opacity: 0, x: -50 }, { opacity: 1, x: 0, duration: Math.min(0.35, seg.duration * 0.5), ease: "power3.out" }, Math.max(0, seg.t0));
        if (seg.t1 < C.duration) tl.set(el, { opacity: 0 }, seg.t1);
      });
      tl.set({}, {}, C.duration || ${durationSec});
      window.__timelines["${compId}"] = tl;`;
  } else if (preset === "blank") {
    innerMarkup = `
      <section id="${compId}-slot" class="clip" data-start="0" data-duration="${durationSec}">
        <div id="${compId}-content"></div>
      </section>`;
    gsapScript = `
      const C = window.__cuthol;
      const tl = gsap.timeline({ paused: true });
      tl.set({}, {}, C.duration || ${durationSec});
      window.__timelines["${compId}"] = tl;`;
  } else {
    // lower_third
    innerMarkup = `
      <section id="${compId}-slot" class="clip" data-start="0" data-duration="${durationSec}">
        <div id="${compId}-bar" class="lower-third-box">
          <div id="${compId}-accent" class="accent-bar"></div>
          <div class="text-col">
            <div id="${compId}-h1" class="lt-title">${escapeHtml(headline)}</div>
            <div id="${compId}-h2" class="lt-sub">${escapeHtml(subline)}</div>
          </div>
        </div>
      </section>`;
    gsapScript = `
      const C = window.__cuthol;
      const P = Object.assign({}, (C && C.props) || {}, (window.__hyperframes && typeof window.__hyperframes.getVariables === "function" && window.__hyperframes.getVariables()) || {});
      const h1Node = document.getElementById("${compId}-h1");
      const h2Node = document.getElementById("${compId}-h2");
      if (h1Node && (P.headline !== undefined || P.title !== undefined)) h1Node.textContent = String(P.headline !== undefined ? P.headline : P.title);
      if (h2Node && (P.subline !== undefined || P.subtitle !== undefined)) h2Node.textContent = String(P.subline !== undefined ? P.subline : P.subtitle);
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#${compId}-bar", { x: -80, opacity: 0 }, { x: 0, opacity: 1, duration: ${st(0.45)}, ease: "power3.out" }, ${st(0.05)});
      tl.fromTo("#${compId}-accent", { scaleY: 0 }, { scaleY: 1, duration: ${st(0.35)}, ease: "power2.out" }, ${st(0.15)});
      tl.fromTo("#${compId}-h1", { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: ${st(0.35)}, ease: "power2.out" }, ${st(0.2)});
      tl.fromTo("#${compId}-h2", { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: ${st(0.35)}, ease: "power2.out" }, ${st(0.28)});
      window.__timelines["${compId}"] = tl;`;
  }

  const baseCssBlock = `
      body {
        margin: 0;
        background: ${bgHex};
        color: #F8FAFC;
        font-family: system-ui, -apple-system, sans-serif;
      }
      #root {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: ${bgHex};
      }
      .clip {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }`;

  const presetCssBlock =
    preset === "blank"
      ? ""
      : `
      .title-banner {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 20px;
        padding: 48px 64px;
        background: #0F172A;
        border: 4px solid ${accentHex};
        border-radius: 24px;
      }
      .pill {
        display: block;
        padding: 10px 24px;
        background: ${accentHex};
        color: #0F172A;
        font-weight: 800;
        font-size: 28px;
        border-radius: 999px;
      }
      .headline {
        margin: 0;
        font-size: 68px;
        font-weight: 900;
        color: #FFFFFF;
        text-align: center;
      }
      .stat-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 44px 68px;
        background: #1E293B;
        border: 4px solid ${accentHex};
        border-radius: 28px;
      }
      .stat-value {
        font-size: 96px;
        font-weight: 900;
        color: ${accentHex};
      }
      .stat-label {
        font-size: 34px;
        font-weight: 700;
        color: #E2E8F0;
        margin-top: 12px;
      }
      .lower-third-box {
        position: absolute;
        left: 90px;
        top: 58%;
        display: flex;
        flex-direction: row;
        align-items: stretch;
        background: #0F172A;
        border: 3px solid ${accentHex};
        border-radius: 18px;
        padding: 24px 36px;
        gap: 22px;
      }
      .accent-bar {
        width: 10px;
        background: ${accentHex};
        border-radius: 6px;
      }
      .text-col {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 6px;
      }
      .lt-title {
        font-size: 46px;
        font-weight: 800;
        color: #FFFFFF;
      }
      .lt-sub {
        font-size: 28px;
        font-weight: 600;
        color: ${accentHex};
      }
      .badge-overlay-box {
        position: absolute;
        right: 72px;
        top: 72px;
        display: flex;
        flex-direction: row;
        align-items: center;
        background: #0F172A;
        border: 3px solid ${accentHex};
        border-radius: 999px;
        padding: 16px 32px;
        gap: 14px;
      }
      .badge-dot {
        width: 16px;
        height: 16px;
        border-radius: 999px;
        background: ${accentHex};
      }
      .badge-text {
        font-size: 32px;
        font-weight: 800;
        color: #FFFFFF;
      }`;

  const cssBlock = baseCssBlock + presetCssBlock;

  let htmlContent: string;
  if (options.asSubComposition) {
    // Sub-composition contract: <style>, <div id="root">, and <script> MUST sit inside <template>
    htmlContent = `<!doctype html>
<html lang="en"${varsAttr}>
  <head>
    <meta charset="UTF-8" />
  </head>
  <body>
    <template>
      <style>${cssBlock}
      </style>
      <div
        id="root"
        data-composition-id="${compId}"
        data-width="${options.width}"
        data-height="${options.height}"
        data-fps="${options.fps}"
        data-duration="${durationSec}"
      >${innerMarkup}
      </div>
      <script src="assets/cuthol-data.js"></script>
      <script src="assets/cuthol-runtime.js"></script>
      <script>${gsapScript}
      </script>
    </template>
  </body>
</html>
`;
  } else {
    // Standalone root contract: <div id="root"> sits directly in <body>, no <template>
    htmlContent = `<!doctype html>
<html lang="en"${varsAttr}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${options.width}, height=${options.height}" />
    <title>Cuthol HyperFrames Composition</title>
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>${cssBlock}
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="${compId}"
      data-start="0"
      data-width="${options.width}"
      data-height="${options.height}"
      data-fps="${options.fps}"
      data-duration="${durationSec}"
    >${innerMarkup}
    </div>
    <script>${gsapScript}
    </script>
  </body>
</html>
`;
  }

  const entryPath = path.join(compDir, "index.html");
  fs.writeFileSync(entryPath, htmlContent, "utf8");

  const hfConfig = {
    name: compId,
    entry: "index.html",
    width: options.width,
    height: options.height,
    fps: options.fps,
  };
  fs.writeFileSync(path.join(compDir, "hyperframes.json"), JSON.stringify(hfConfig, null, 2), "utf8");

  return {
    compositionDir: compDir,
    entryHtml: "index.html",
    compositionId: compId,
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Deterministically validates a HyperFrames HTML composition file against the
 * `/hyperframes-core` contract rules (`data-composition-id`, `window.__timelines`,
 * `<template>` rules, determinism bans, no `crossorigin` on media).
 */
export function validateHyperFramesCompositionContract(
  compositionDir: string,
  entryHtml = "index.html",
  runCliLint = false,
  expectSubComposition = false
): HyperFramesValidationResult {
  const htmlPath = path.join(path.resolve(compositionDir), entryHtml);
  if (!fs.existsSync(htmlPath)) {
    return {
      ok: false,
      composition_id: null,
      findings: [`Missing composition entry HTML: ${htmlPath}`],
    };
  }

  const html = fs.readFileSync(htmlPath, "utf8");
  const findings: string[] = [];

  const compIdMatch = /data-composition-id=(["'])([^"']+)\1/.exec(html);
  const compId = compIdMatch ? compIdMatch[2] : null;
  if (!compId) {
    findings.push("Missing 'data-composition-id' attribute on composition root.");
  }

  if (compId && !html.includes(`window.__timelines["${compId}"]`) && !html.includes(`window.__timelines['${compId}']`)) {
    findings.push(`Missing timeline registration 'window.__timelines["${compId}"] = ...' matching root data-composition-id.`);
  }

  if (!/gsap\.timeline\s*\(\s*\{[^}]*\bpaused\s*:\s*true\b/s.test(html)) {
    findings.push("Timeline must be created paused: 'gsap.timeline({ paused: true })'.");
  }

  if (/Math\.random\s*\(/.test(html) || /Date\.now\s*\(/.test(html)) {
    findings.push("Determinism violation: unseeded Math.random() or Date.now() found in composition.");
  }

  if (/<(video|audio)\b[^>]*\bcrossorigin\b/i.test(html)) {
    findings.push("Media violation: 'crossorigin' attribute on <video> or <audio> breaks preview/render.");
  }

  // Check <audio> without id attribute (`media_missing_id`)
  const audioTags = html.match(/<audio\b[^>]*>/gi) ?? [];
  for (const tag of audioTags) {
    if (!/\bid\s*=\s*["'][^"']+["']/i.test(tag)) {
      findings.push("Media violation (media_missing_id): every <audio> tag requires a unique id attribute.");
    }
  }

  // Check standalone vs sub-composition <template> contract
  const hasTemplateTag = /<template[\s>]/i.test(html);
  if (expectSubComposition === false && hasTemplateTag) {
    findings.push("Contract violation (standalone_composition_wrapped_in_template): standalone composition must not wrap root in <template>.");
  } else if (expectSubComposition === true && !hasTemplateTag) {
    findings.push("Contract violation: sub-composition must wrap root in <template>.");
  }

  // If `<template>` is used (sub-composition), `<style>` or `<script>` must not sit inside `<head>`
  if (hasTemplateTag && /<head>[\s\S]*?<(style|script)[\s>][\s\S]*?<\/head>/i.test(html)) {
    findings.push("Sub-composition pitfall: <style> or <script> inside <head> is discarded when <template> is cloned.");
  }

  // Check `.clip` or `#<clipId>` tweened with `autoAlpha`, `visibility`, or `display` (`gsap_animates_clip_element`)
  // Scan balanced parentheses per tween call so separate statements never bleed across `;` or `)` boundaries.
  const clipTargets = ["\\.clip"];
  const clipTagRe = /<[a-zA-Z0-9_-]+\b[^>]*\bclass\s*=\s*(["'])[^"']*\bclip\b[^"']*\1[^>]*>/gi;
  let clipTagMatch: RegExpExecArray | null;
  while ((clipTagMatch = clipTagRe.exec(html)) !== null) {
    const idMatch = /\bid\s*=\s*(["'])([^"']+)\1/i.exec(clipTagMatch[0]);
    if (idMatch?.[2]) {
      clipTargets.push(`#${idMatch[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    }
  }
  const scriptBlocks = (html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [html]).join("\n");
  const clipTargetPattern = `(?:${clipTargets.join("|")})`;
  const tweenStartRe = new RegExp(
    `\\b(?:to|from|fromTo|set)\\s*\\(\\s*(["'])${clipTargetPattern}\\1`,
    "gi"
  );
  let tweenMatch: RegExpExecArray | null;
  let hasClipTweenViolation = false;
  while ((tweenMatch = tweenStartRe.exec(scriptBlocks)) !== null) {
    const openParenIdx = scriptBlocks.indexOf("(", tweenMatch.index);
    if (openParenIdx < 0) continue;
    let depth = 0;
    let endIdx = scriptBlocks.length;
    for (let k = openParenIdx; k < scriptBlocks.length; k++) {
      const ch = scriptBlocks[k];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          endIdx = k + 1;
          break;
        }
      }
    }
    const callBody = scriptBlocks.slice(openParenIdx, endIdx);
    if (/\b(?:autoAlpha|visibility|display)\s*:/i.test(callBody)) {
      hasClipTweenViolation = true;
      break;
    }
  }
  if (hasClipTweenViolation) {
    findings.push("Contract violation (gsap_animates_clip_element): never tween autoAlpha, visibility, or display on a .clip element.");
  }

  // Check `<video data-start>` nested inside another non-root element with `data-start` (`video_nested_in_timed_element`)
  // Use an open-tag stack so sibling `<section data-start>...</section><video data-start>` is never flagged as nested.
  const voidHtmlTags = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
  ]);
  const htmlNoCommentsOrScripts = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const tagTokenRe = /<\/?([a-zA-Z0-9_-]+)\b([^>]*?)(\/?)>/g;
  const openTagStack: Array<{ tag: string; isTimedNonRoot: boolean }> = [];
  let hasNestedTimedVideo = false;
  let tagTok: RegExpExecArray | null;
  while ((tagTok = tagTokenRe.exec(htmlNoCommentsOrScripts)) !== null) {
    const full = tagTok[0];
    const tagName = tagTok[1].toLowerCase();
    const attrs = tagTok[2] ?? "";
    const selfClose = tagTok[3] === "/" || voidHtmlTags.has(tagName);
    if (full.startsWith("</")) {
      for (let s = openTagStack.length - 1; s >= 0; s--) {
        if (openTagStack[s].tag === tagName) {
          openTagStack.length = s;
          break;
        }
      }
      continue;
    }
    const hasDataStart = /\bdata-start\s*=/i.test(attrs);
    const isCompRoot = /\bdata-composition-id\s*=/i.test(attrs);
    if (tagName === "video" && hasDataStart) {
      if (openTagStack.some((anc) => anc.isTimedNonRoot)) {
        hasNestedTimedVideo = true;
        break;
      }
    }
    if (!selfClose) {
      openTagStack.push({
        tag: tagName,
        isTimedNonRoot: hasDataStart && !isCompRoot,
      });
    }
  }
  if (hasNestedTimedVideo) {
    findings.push("Contract violation (video_nested_in_timed_element): <video data-start> must not sit inside another timed element.");
  }

  let lintFindings: HyperFramesLintFinding[] | undefined;
  let lintInfoFindings: HyperFramesLintFinding[] | undefined;
  let lintCached: boolean | undefined;

  if (runCliLint && findings.length === 0) {
    const lintRes = lintHyperFramesComposition(compositionDir, entryHtml);
    lintFindings = lintRes.findings;
    lintInfoFindings = lintRes.info_findings;
    lintCached = lintRes.cached;
    for (const lf of lintRes.findings) {
      if (lf.severity === "error") {
        findings.push(
          `hyperframes lint (${lf.code}): ${lf.message}${lf.fixHint ? ` — ${lf.fixHint}` : ""}`
        );
      }
    }
  }

  return {
    ok: findings.length === 0,
    composition_id: compId,
    findings,
    ...(lintFindings !== undefined ? { lint_findings: lintFindings } : {}),
    ...(lintInfoFindings !== undefined ? { lint_info_findings: lintInfoFindings } : {}),
    ...(lintCached !== undefined ? { lint_cached: lintCached } : {}),
  };
}

/**
 * Detects whether a composition uses pixel-reading CSS/DOM features (`backdrop-filter`,
 * `mix-blend-mode != normal`) that require `--mode scene_host` (Mode B) to see underlying footage.
 * Never switches mode automatically; returns feature names for `CUTHOL-G406` advisory.
 */
export function detectSceneHostFeaturesInComposition(
  compositionDir: string,
  entryHtml = "index.html"
): string[] {
  const absDir = path.resolve(compositionDir);
  const htmlPath = path.join(absDir, entryHtml);
  if (!fs.existsSync(htmlPath)) return [];

  const features = new Set<string>();
  const scanSource = (src: string): void => {
    const cleaned = src
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    if (/(?:-webkit-)?backdrop-filter\s*:\s*(?!none\b|initial\b|inherit\b|unset\b)/i.test(cleaned)) {
      features.add("backdrop-filter");
    }
    if (/mix-blend-mode\s*:\s*(?!normal\b|initial\b|inherit\b|unset\b)/i.test(cleaned)) {
      features.add("mix-blend-mode");
    }
  };

  try {
    scanSource(fs.readFileSync(htmlPath, "utf8"));
    const assetsDir = path.join(absDir, "assets");
    if (fs.existsSync(assetsDir)) {
      for (const f of fs.readdirSync(assetsDir)) {
        if (f.endsWith(".css")) {
          scanSource(fs.readFileSync(path.join(assetsDir, f), "utf8"));
        }
      }
    }
  } catch {
    // ignore read errors
  }
  return [...features];
}
