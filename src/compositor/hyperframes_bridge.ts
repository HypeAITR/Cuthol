/**
 * HyperFrames Composition Bridge, Contract Validator & Renderer (`src/compositor/hyperframes_bridge.ts`).
 *
 * Bridges Cuthol's `composition` lane cues with the HyperFrames HTML/GSAP engine:
 * 1. `scaffoldHyperFramesComposition`: Creates deterministic, offline-self-contained
 *    HyperFrames compositions (with local `assets/gsap.min.js`, zero CDN/Math.random/Date.now,
 *    and strict adherence to `/hyperframes-core` rules).
 * 2. `validateHyperFramesCompositionContract`: Audits a composition directory for
 *    `/hyperframes-core` contract compliance (`data-composition-id` matching `window.__timelines`,
 *    no `<head><style>` in `<template>` sub-compositions, no `gsap_css_transform_conflict`, etc.)
 *    plus optional `npx hyperframes lint`.
 * 3. `renderHyperFramesCompositionToMp4`: Content-addressed (`SHA-256`) rendering of a
 *    HyperFrames composition into `.cuthol/blobs/hf_<hash>.mp4` via `npx hyperframes render`.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { resolveHyperFramesWorkers, resolveVideoEncoderPreference } from "../core/env.js";
import { extractScalarHyperFramesVariables, hashDirectoryRecursive } from "./bridge_exporter.js";
import {
  CUTHOL_BRIDGE_SCHEMA,
  CutholBridgeV1,
  getCutholRuntimeJsSource,
} from "./cuthol_runtime.js";

const PACKAGE_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export type HyperFramesPresetKind =
  | "title_card"
  | "lower_third"
  | "stat_callout"
  | "badge_overlay"
  | "counter"
  | "beat_cards"
  | "audio_glow"
  | "cut_phases"
  | "blank";

export interface HyperFramesScaffoldOptions {
  targetDir: string;
  compositionId?: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  preset?: HyperFramesPresetKind;
  props?: Record<string, unknown>;
  bgColorHex?: string;
  transparent?: boolean;
  asSubComposition?: boolean;
}

export interface HyperFramesValidationResult {
  ok: boolean;
  composition_id: string | null;
  findings: string[];
  lint_findings?: HyperFramesLintFinding[];
  lint_info_findings?: HyperFramesLintFinding[];
  lint_cached?: boolean;
}

export interface HyperFramesLintFinding {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  fixHint?: string;
  selector?: string;
  elementId?: string;
  snippet?: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface HyperFramesLintResult {
  ok: boolean;
  cached: boolean;
  content_hash: string;
  findings: HyperFramesLintFinding[];
  info_findings: HyperFramesLintFinding[];
}

const SIZE_AND_SPLIT_LINT_CODES = new Set([
  "composition_file_too_large",
  "nested_structure_needs_subcomposition",
  "timeline_track_too_dense",
]);

const LINT_IGNORED_BRIDGE_FILES = new Set([
  "assets/cuthol-data.json",
  "assets/cuthol-data.js",
  "assets/cuthol-vars.json",
  "assets/cuthol-runtime.js",
  "assets/cuthol-bbox.json",
  "cuthol-bbox.json",
]);

const lintMemoryCache = new Map<string, Omit<HyperFramesLintResult, "cached">>();

function computeCompositionLintHash(absCompDir: string, entryHtml: string): string {
  const hash = crypto.createHash("sha256").update(`hf-lint-v1:${entryHtml}\n`);
  const visitedDirs = new Set<string>();
  const walk = (currentDir: string, relPrefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (
        entry.name.startsWith(".tmp.") ||
        entry.name.endsWith(".tmp.mp4") ||
        entry.name.endsWith(".tmp.mov")
      ) {
        continue;
      }
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (LINT_IGNORED_BRIDGE_FILES.has(relPath)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === ".hyperframes" ||
          entry.name === "snapshots" ||
          entry.name === "renders" ||
          entry.name === "build" ||
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === ".cuthol"
        ) {
          continue;
        }
        let realDir = fullPath;
        try {
          realDir = fs.realpathSync(fullPath);
        } catch {
          realDir = path.resolve(fullPath);
        }
        if (visitedDirs.has(realDir)) continue;
        visitedDirs.add(realDir);
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        try {
          const buf = fs.readFileSync(fullPath);
          const digest = crypto.createHash("sha256").update(buf).digest("hex");
          hash.update(`file:${relPath}:${buf.length}:${digest}\n`);
        } catch {
          // ignore unreadable transient file
        }
      }
    }
  };
  walk(absCompDir, "");
  return hash.digest("hex");
}

export function lintHyperFramesComposition(
  compositionDir: string,
  entryHtml = "index.html",
  cacheDir?: string
): HyperFramesLintResult {
  const absCompDir = path.resolve(compositionDir);
  const entryPath = path.join(absCompDir, entryHtml);
  if (!fs.existsSync(entryPath)) {
    return {
      ok: false,
      cached: false,
      content_hash: "missing",
      findings: [
        {
          code: "missing_entry_html",
          severity: "error",
          message: `Missing composition entry HTML: ${entryPath}`,
        },
      ],
      info_findings: [],
    };
  }

  const contentHash = computeCompositionLintHash(absCompDir, entryHtml);
  const memHit = lintMemoryCache.get(contentHash);
  if (memHit) {
    return { ...memHit, cached: true };
  }

  const diskCachePath = cacheDir
    ? path.join(cacheDir, `hf_lint_${contentHash.slice(0, 24)}.json`)
    : null;
  if (diskCachePath && fs.existsSync(diskCachePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(diskCachePath, "utf8")) as Omit<
        HyperFramesLintResult,
        "cached"
      >;
      if (parsed && Array.isArray(parsed.findings) && parsed.content_hash === contentHash) {
        lintMemoryCache.set(contentHash, parsed);
        return { ...parsed, cached: true };
      }
    } catch {
      // ignore corrupt cache file
    }
  }

  const findings: HyperFramesLintFinding[] = [];
  const infoFindings: HyperFramesLintFinding[] = [];
  const hfBin = findLocalHyperFramesCliMjs();

  if (fs.existsSync(hfBin)) {
    const proc = spawnSync(process.execPath, [hfBin, "lint", absCompDir, "--json"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const rawOut = (proc.stdout || "").trim();
    const jsonStart = rawOut.indexOf("{");
    if (jsonStart >= 0) {
      try {
        const parsed = JSON.parse(rawOut.slice(jsonStart)) as {
          findings?: Array<{
            code?: string;
            severity?: "error" | "warning" | "info";
            message?: string;
            fixHint?: string;
            selector?: string;
            elementId?: string;
            snippet?: string;
            file?: string;
            line?: number;
            column?: number;
          }>;
        };
        for (const f of parsed.findings ?? []) {
          const code = String(f.code ?? "hyperframes_lint");
          const item: HyperFramesLintFinding = {
            code,
            severity: SIZE_AND_SPLIT_LINT_CODES.has(code)
              ? "info"
              : f.severity === "error" || f.severity === "warning"
                ? f.severity
                : "info",
            message: String(f.message ?? ""),
            ...(f.fixHint ? { fixHint: String(f.fixHint) } : {}),
            ...(f.selector ? { selector: String(f.selector) } : {}),
            ...(f.elementId ? { elementId: String(f.elementId) } : {}),
            ...(f.snippet ? { snippet: String(f.snippet) } : {}),
            ...(f.file ? { file: String(f.file) } : {}),
            ...(typeof f.line === "number" ? { line: f.line } : {}),
            ...(typeof f.column === "number" ? { column: f.column } : {}),
          };
          if (item.severity === "info") {
            infoFindings.push(item);
          } else {
            findings.push(item);
          }
        }
      } catch {
        if (proc.status !== 0) {
          findings.push({
            code: "hyperframes_lint_failed",
            severity: "warning",
            message: (proc.stderr || proc.stdout || "hyperframes lint failed").trim(),
          });
        }
      }
    } else if (proc.status !== 0) {
      findings.push({
        code: "hyperframes_lint_failed",
        severity: "warning",
        message: (proc.stderr || proc.stdout || "hyperframes lint failed").trim(),
      });
    }
  }

  const entry: Omit<HyperFramesLintResult, "cached"> = {
    ok: findings.every((f) => f.severity !== "error"),
    content_hash: contentHash,
    findings,
    info_findings: infoFindings,
  };
  lintMemoryCache.set(contentHash, entry);
  if (diskCachePath) {
    try {
      fs.mkdirSync(path.dirname(diskCachePath), { recursive: true });
      fs.writeFileSync(diskCachePath, JSON.stringify(entry, null, 2), "utf8");
    } catch {
      // ignore cache write failure
    }
  }

  return { ...entry, cached: false };
}

function findLocalHyperFramesCliMjs(): string {
  const pkgCandidate = path.resolve(PACKAGE_ROOT_DIR, "node_modules/hyperframes/bin/hyperframes.mjs");
  if (fs.existsSync(pkgCandidate)) {
    return pkgCandidate;
  }
  return path.resolve(process.cwd(), "node_modules/hyperframes/bin/hyperframes.mjs");
}

function findLocalGsapMinJs(): string {
  const pkgCandidate = path.resolve(PACKAGE_ROOT_DIR, "node_modules/gsap/dist/gsap.min.js");
  if (fs.existsSync(pkgCandidate)) {
    return pkgCandidate;
  }
  const cwdCandidate = path.resolve(process.cwd(), "node_modules/gsap/dist/gsap.min.js");
  if (fs.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }
  throw new Error("Local node_modules/gsap/dist/gsap.min.js not found.");
}

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

function copyDirRecursiveSync(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === "snapshots" || entry.name === "renders" || entry.name === ".hyperframes") {
      continue;
    }
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursiveSync(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

let cachedNvencAvailable: boolean | null = null;

/**
 * Probes whether FFmpeg's `h264_nvenc` hardware encoder is functional on this machine.
 * Result is memoized per process; honors `CUTHOL_DISABLE_NVENC` / `CUTHOL_VIDEO_ENCODER`.
 */
export function isNvencHardwareAvailable(): boolean {
  if (cachedNvencAvailable !== null) {
    return cachedNvencAvailable;
  }
  try {
    const proc = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=128x128:r=30:d=0.1",
        "-frames:v",
        "1",
        "-an",
        "-c:v",
        "h264_nvenc",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf8", timeout: 10_000 }
    );
    cachedNvencAvailable = proc.status === 0;
  } catch {
    cachedNvencAvailable = false;
  }
  return cachedNvencAvailable;
}

export function shouldUseNvencForRender(overrideEncoder?: string | null): {
  useNvenc: boolean;
  fallbackReason: string | null;
} {
  const pref = resolveVideoEncoderPreference(overrideEncoder);
  if (pref === "libx264") {
    return {
      useNvenc: false,
      fallbackReason: "NVENC disabled by configuration (CUTHOL_DISABLE_NVENC / CUTHOL_VIDEO_ENCODER=libx264)",
    };
  }
  if (!isNvencHardwareAvailable()) {
    return {
      useNvenc: false,
      fallbackReason: "h264_nvenc hardware encoder is not available on this machine",
    };
  }
  return { useNvenc: true, fallbackReason: null };
}

function syncScalarVarsAndComputeCompositionHash(options: {
  absCompDir: string;
  entryHtml: string;
  htmlSource: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  props: Record<string, unknown>;
  transparent: boolean;
  mode: "overlay_alpha" | "scene_host";
  backdropVideoPath?: string;
  opaqueBackdropColor?: string;
  backdropImagePath?: string;
}): {
  hash: string;
  nativeHash: string;
  scalarVars: Record<string, string | number | boolean>;
  isSceneHost: boolean;
  nativeWidth: number;
  nativeHeight: number;
  targetWidth: number;
  targetHeight: number;
} {
  // Synchronize `assets/cuthol-vars.json` BEFORE `hashDirectoryRecursive`
  // so `recursiveDirHash` is never computed against stale variables on disk.
  const varsFile = path.join(options.absCompDir, "assets/cuthol-vars.json");
  const scalarVars = extractScalarHyperFramesVariables(options.props);
  const nextVarsJson = JSON.stringify(scalarVars, null, 2);
  let currentVarsJson = "";
  if (fs.existsSync(varsFile)) {
    try {
      currentVarsJson = fs.readFileSync(varsFile, "utf8");
    } catch {
      currentVarsJson = "";
    }
  }
  if (currentVarsJson !== nextVarsJson && (Object.keys(scalarVars).length > 0 || fs.existsSync(varsFile))) {
    fs.mkdirSync(path.dirname(varsFile), { recursive: true });
    fs.writeFileSync(varsFile, nextVarsJson, "utf8");
  }

  const wMatch = /\bdata-width\s*=\s*(["'])(\d+)\1/i.exec(options.htmlSource);
  const hMatch = /\bdata-height\s*=\s*(["'])(\d+)\1/i.exec(options.htmlSource);
  const nativeWidth = wMatch ? Math.max(16, Number(wMatch[2])) : options.width;
  const nativeHeight = hMatch ? Math.max(16, Number(hMatch[2])) : options.height;
  const targetWidth = Math.max(16, Math.round(options.width / 2) * 2);
  const targetHeight = Math.max(16, Math.round(options.height / 2) * 2);

  const isSceneHost =
    options.mode === "scene_host" &&
    Boolean(options.backdropVideoPath && fs.existsSync(options.backdropVideoPath));

  const recursiveDirHash = hashDirectoryRecursive(options.absCompDir);
  let backdropDigest = "";
  if (isSceneHost && options.backdropVideoPath) {
    try {
      const st = fs.statSync(options.backdropVideoPath);
      backdropDigest = `${path.basename(options.backdropVideoPath)}:${st.size}:${st.mtimeMs}`;
    } catch {
      backdropDigest = "none";
    }
  } else if (!options.transparent && options.backdropImagePath) {
    try {
      const st = fs.statSync(options.backdropImagePath);
      backdropDigest = `still:${path.basename(options.backdropImagePath)}:${st.size}`;
    } catch {
      backdropDigest = "still:none";
    }
  } else if (!options.transparent && options.opaqueBackdropColor) {
    backdropDigest = `color:${options.opaqueBackdropColor.trim().toLowerCase()}`;
  }

  // Resolution-specific cache key so `draft_480p` and `master_1080p` never overwrite each other's blobs.
  const hash = crypto
    .createHash("sha256")
    .update(recursiveDirHash)
    .update(
      JSON.stringify({
        entry: options.entryHtml,
        w: targetWidth,
        h: targetHeight,
        fps: options.fps,
        dur: options.durationMs,
        props: options.props,
        transparent: options.transparent,
        mode: options.mode,
        backdropDigest,
      })
    )
    .digest("hex")
    .slice(0, 16);

  const nativeHash = crypto
    .createHash("sha256")
    .update(recursiveDirHash)
    .update(
      JSON.stringify({
        entry: options.entryHtml,
        w: nativeWidth,
        h: nativeHeight,
        fps: options.fps,
        dur: options.durationMs,
        props: options.props,
        transparent: options.transparent,
        mode: options.mode,
        backdropDigest,
      })
    )
    .digest("hex")
    .slice(0, 16);

  return {
    hash,
    nativeHash,
    scalarVars,
    isSceneHost,
    nativeWidth,
    nativeHeight,
    targetWidth,
    targetHeight,
  };
}

function stageCompositionRenderDir(options: {
  absCompDir: string;
  entryHtml: string;
  blobsDir: string;
  hash: string;
  durationSec: number;
  nativeWidth: number;
  nativeHeight: number;
  targetWidth: number;
  targetHeight: number;
  isSceneHost: boolean;
  backdropVideoPath?: string;
  transparent: boolean;
  opaqueBackdropColor?: string;
  backdropImagePath?: string;
}): string {
  const tempStageDir = path.join(
    options.blobsDir,
    `hf_stage_${options.hash}_${process.pid}_${Date.now()}`
  );
  fs.rmSync(tempStageDir, { recursive: true, force: true });
  copyDirRecursiveSync(options.absCompDir, tempStageDir);

  const stagedHtmlPath = path.join(tempStageDir, options.entryHtml);
  let stagedHtml = fs.readFileSync(stagedHtmlPath, "utf8");

  if (options.isSceneHost && options.backdropVideoPath) {
    const bgDest = path.join(tempStageDir, "assets/cuthol_scene_host_bg.mp4");
    fs.mkdirSync(path.dirname(bgDest), { recursive: true });
    fs.copyFileSync(options.backdropVideoPath, bgDest);

    stagedHtml = stagedHtml.replace(
      /((?:html|body|#root)\s*\{[^}]*?)\bbackground(?:-color)?\s*:\s*[^;}]+/gi,
      "$1background: transparent"
    );
    const zIndexHelperStyle = `<style id="cuthol-scene-host-style">html, body, #root { background: transparent !important; } .clip:not(#cuthol-scene-host-bg) { z-index: 1; }</style>`;
    if (/<\/head>/i.test(stagedHtml)) {
      stagedHtml = stagedHtml.replace(/<\/head>/i, `${zIndexHelperStyle}\n</head>`);
    } else {
      stagedHtml = `${zIndexHelperStyle}\n${stagedHtml}`;
    }

    const videoTag = `\n      <video id="cuthol-scene-host-bg" class="clip" src="assets/cuthol_scene_host_bg.mp4" data-start="0" data-duration="${options.durationSec}" data-track-index="0" muted playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0"></video>`;
    if (/(<[a-zA-Z0-9_-]+\b[^>]*\bdata-composition-id=(["'])[^"']+\2[^>]*>)/i.test(stagedHtml)) {
      stagedHtml = stagedHtml.replace(
        /(<[a-zA-Z0-9_-]+\b[^>]*\bdata-composition-id=(["'])[^"']+\2[^>]*>)/i,
        `$1${videoTag}`
      );
    } else {
      stagedHtml = stagedHtml.replace(
        /(<div\b[^>]*\bid=(["'])root\2[^>]*>)/i,
        `$1${videoTag}`
      );
    }
  } else if (!options.transparent && (options.opaqueBackdropColor || options.backdropImagePath)) {
    const bgColor = options.opaqueBackdropColor || "#000000";
    let bgRule = `background-color: ${bgColor} !important;`;
    if (options.backdropImagePath && fs.existsSync(options.backdropImagePath)) {
      const extImg = path.extname(options.backdropImagePath) || ".png";
      const bgImgDest = path.join(tempStageDir, `assets/cuthol_stage_backdrop${extImg}`);
      fs.mkdirSync(path.dirname(bgImgDest), { recursive: true });
      fs.copyFileSync(options.backdropImagePath, bgImgDest);
      bgRule = `background: ${bgColor} url("assets/cuthol_stage_backdrop${extImg}") center / cover no-repeat !important;`;
    }
    stagedHtml = stagedHtml.replace(
      /((?:html\s*,\s*body|html)\s*\{[^}]*?\bbackground(?:-color)?\s*:\s*transparent)\s*!important/gi,
      "$1"
    );
    const opaqueBgStyle = `<style id="cuthol-opaque-backdrop-style">html { ${bgRule} }</style>`;
    if (/<\/head>/i.test(stagedHtml)) {
      stagedHtml = stagedHtml.replace(/<\/head>/i, `${opaqueBgStyle}\n</head>`);
    } else {
      stagedHtml = `${opaqueBgStyle}\n${stagedHtml}`;
    }
  }

  if (options.targetWidth !== options.nativeWidth || options.targetHeight !== options.nativeHeight) {
    const scaleX = Number((options.targetWidth / options.nativeWidth).toFixed(6));
    const scaleY = Number((options.targetHeight / options.nativeHeight).toFixed(6));
    stagedHtml = stagedHtml
      .replace(/(\bdata-width\s*=\s*["'])\d+(["'])/i, `$1${options.targetWidth}$2`)
      .replace(/(\bdata-height\s*=\s*["'])\d+(["'])/i, `$1${options.targetHeight}$2`)
      .replace(
        /(<meta[^>]*name=["']viewport["'][^>]*content=["']width=)\d+(,\s*height=)\d+/i,
        `$1${options.targetWidth}$2${options.targetHeight}`
      );
    const scaleStyle = `<style id="cuthol-stage-scale-style">html, body { width: ${options.targetWidth}px !important; height: ${options.targetHeight}px !important; overflow: hidden !important; } body > [data-composition-id], #root[data-composition-id] { width: ${options.nativeWidth}px !important; height: ${options.nativeHeight}px !important; transform: scale(${scaleX}, ${scaleY}) !important; transform-origin: 0 0 !important; }</style>`;
    if (/<\/head>/i.test(stagedHtml)) {
      stagedHtml = stagedHtml.replace(/<\/head>/i, `${scaleStyle}\n</head>`);
    } else {
      stagedHtml = `${scaleStyle}\n${stagedHtml}`;
    }
  }

  fs.writeFileSync(stagedHtmlPath, stagedHtml, "utf8");
  return tempStageDir;
}

/**
 * Renders a HyperFrames composition into a cached video blob in `blobsDir`:
 * - Mode A (`overlay_alpha`, `transparent: true`): ProRes 4444 `.mov` (`yuva444p10le`, BT.709 straight alpha, zero chromakey).
 * - Mode B (`scene_host`): Mounts `backdropVideoPath` as `<video class="clip">` inside the composition and renders `.mp4` (`--video-frame-format png`).
 * - Opaque standalone (`transparent: false`): H.264 `.mp4` (with optional stage backdrop colour/still image baked in when no moving footage sits underneath).
 */
export function renderHyperFramesCompositionToMp4(options: {
  compositionDir: string;
  entryHtml: string;
  blobsDir: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  props: Record<string, unknown>;
  transparent: boolean;
  mode?: "overlay_alpha" | "scene_host";
  backdropVideoPath?: string;
  opaqueBackdropColor?: string;
  backdropImagePath?: string;
  workers?: number;
  useGpu?: boolean;
  crf?: number;
}): string {
  const absCompDir = path.resolve(options.compositionDir);
  const entryPath = path.join(absCompDir, options.entryHtml);
  if (!fs.existsSync(entryPath)) {
    throw new CutholError(DIAGNOSTICS.MISSING_FILE_ON_DISK("composition", entryPath));
  }

  const mode = options.mode ?? "overlay_alpha";
  const isSceneHostCandidate =
    mode === "scene_host" && Boolean(options.backdropVideoPath && fs.existsSync(options.backdropVideoPath));
  const useTrueAlphaMov = options.transparent && !isSceneHostCandidate;

  let htmlSource = fs.readFileSync(entryPath, "utf8");
  // Upgrade any legacy #00FF00 background on body/#root to true CSS `transparent` when rendering with alpha or stage backdrop
  if (
    (useTrueAlphaMov || options.opaqueBackdropColor || options.backdropImagePath) &&
    /(?:body|#root)\s*\{[^}]*?background\s*:\s*#00ff00\b/i.test(htmlSource)
  ) {
    htmlSource = htmlSource.replace(
      /((?:body|#root)\s*\{[^}]*?)background\s*:\s*#00ff00\b/gi,
      "$1background: transparent"
    );
    fs.writeFileSync(entryPath, htmlSource, "utf8");
  }

  const { hash, scalarVars, isSceneHost, nativeWidth, nativeHeight, targetWidth, targetHeight } =
    syncScalarVarsAndComputeCompositionHash({
      absCompDir,
      entryHtml: options.entryHtml,
      htmlSource,
      width: options.width,
      height: options.height,
      fps: options.fps,
      durationMs: options.durationMs,
      props: options.props,
      transparent: options.transparent,
      mode,
      backdropVideoPath: options.backdropVideoPath,
      opaqueBackdropColor: options.opaqueBackdropColor,
      backdropImagePath: options.backdropImagePath,
    });

  fs.mkdirSync(options.blobsDir, { recursive: true });
  const ext = useTrueAlphaMov ? "mov" : "mp4";
  const outBlob = path.join(options.blobsDir, `hf_comp_${hash}.${ext}`);
  // Blobs written by older versions as a placeholder box carry a `.fallback.json` sidecar; never reuse them.
  const legacyFallbackSidecar = `${outBlob}.fallback.json`;
  if (fs.existsSync(legacyFallbackSidecar)) {
    for (const stale of [outBlob, legacyFallbackSidecar]) {
      try {
        fs.unlinkSync(stale);
      } catch {
        // ignore
      }
    }
  }
  if (fs.existsSync(outBlob) && fs.statSync(outBlob).size > 1000) {
    return outBlob;
  }

  const hfBin = findLocalHyperFramesCliMjs();
  if (!fs.existsSync(hfBin)) {
    throw new CutholError(
      DIAGNOSTICS.HYPERFRAMES_RENDER_FAILED(
        options.compositionDir,
        "hyperframes CLI bulunamadı (npm install ile kurulmalı)"
      )
    );
  }

  const tmpBlob = path.join(
    options.blobsDir,
    `hf_comp_${hash}.${process.pid}.${Date.now()}.tmp.${ext}`
  );
  const durationSec = Math.max(0.1, Number((options.durationMs / 1000).toFixed(3)));
  const workers = resolveHyperFramesWorkers(options.workers);

  const needsStage =
    (isSceneHost && Boolean(options.backdropVideoPath)) ||
    (!useTrueAlphaMov && Boolean(options.opaqueBackdropColor || options.backdropImagePath)) ||
    targetWidth !== nativeWidth ||
    targetHeight !== nativeHeight;

  let targetRenderDir = absCompDir;
  let tempSceneHostDir: string | null = null;
  try {
    if (needsStage) {
      tempSceneHostDir = stageCompositionRenderDir({
        absCompDir,
        entryHtml: options.entryHtml,
        blobsDir: options.blobsDir,
        hash,
        durationSec,
        nativeWidth,
        nativeHeight,
        targetWidth,
        targetHeight,
        isSceneHost,
        backdropVideoPath: options.backdropVideoPath,
        transparent: useTrueAlphaMov,
        opaqueBackdropColor: options.opaqueBackdropColor,
        backdropImagePath: options.backdropImagePath,
      });
      targetRenderDir = tempSceneHostDir;
    }

    // HyperFrames' own GPU encode gives no measurable speed-up here (frame capture dominates) and its rate
    // control is not configurable from outside, so it is only used when asked for explicitly.
    const wantGpu = !useTrueAlphaMov && options.useGpu === true;
    const isDraftScale = targetWidth <= 854 && targetHeight <= 854 && (targetWidth < nativeWidth || targetHeight < nativeHeight);
    const effectiveCrf = options.crf ?? (isDraftScale ? 24 : wantGpu ? 22 : 19);

    const buildRenderArgs = (withGpu: boolean): string[] => {
      const args = [
        hfBin,
        "render",
        targetRenderDir,
        "--format",
        useTrueAlphaMov ? "mov" : "mp4",
        "--quality",
        isSceneHost || (!useTrueAlphaMov && !isDraftScale) ? "looks" : "draft",
        "--workers",
        String(workers),
        "--output",
        tmpBlob,
      ];
      if (!useTrueAlphaMov) {
        args.push("--crf", String(effectiveCrf));
        if (withGpu) {
          args.push("--gpu");
        }
      }
      if (isSceneHost) {
        args.push("--video-frame-format", "png");
      }
      const activeVarsFile = path.join(targetRenderDir, "assets/cuthol-vars.json");
      if (Object.keys(scalarVars).length > 0 && fs.existsSync(activeVarsFile)) {
        args.push("--variables-file", activeVarsFile);
      }
      return args;
    };

    const renderArgs = buildRenderArgs(wantGpu);

    // No wall-clock limit: render time grows with composition length (long videos take hours).
    // A large output buffer keeps progress logging of long renders from killing the process (ENOBUFS).
    const hfProc = spawnSync(process.execPath, renderArgs, {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
    let finalHfProc = hfProc;
    let usedGpu = wantGpu;
    let gpuFallbackReason: string | null = null;

    if (
      wantGpu &&
      (finalHfProc.status !== 0 || !fs.existsSync(tmpBlob) || fs.statSync(tmpBlob).size <= 1000)
    ) {
      usedGpu = false;
      gpuFallbackReason = "HyperFrames GPU encode failed; retried with libx264";
      if (fs.existsSync(tmpBlob)) {
        try {
          fs.unlinkSync(tmpBlob);
        } catch {
          // ignore
        }
      }
      finalHfProc = spawnSync(process.execPath, buildRenderArgs(false), {
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
      });
    }

    if (hfProc.status === 0 || finalHfProc.status === 0) {
      if (fs.existsSync(tmpBlob) && fs.statSync(tmpBlob).size > 1000) {
        fs.renameSync(tmpBlob, outBlob);
        try {
          fs.writeFileSync(
            `${outBlob}.meta.json`,
            JSON.stringify({
              encoder: useTrueAlphaMov ? "prores_ks" : usedGpu ? "h264_nvenc" : "libx264",
              gpu_fallback_reason: gpuFallbackReason,
              workers,
              width: targetWidth,
              height: targetHeight,
            }),
            "utf8"
          );
        } catch {
          // non-blocking metadata write
        }
        if (useTrueAlphaMov) {
          recordCompositionAlphaBboxSidecar(absCompDir, outBlob, durationSec * 0.5);
        }
        return outBlob;
      }
    }

    // Keep the lines that explain the failure; HyperFrames also logs [INFO] progress traces.
    const logLines = `${finalHfProc.stderr || ""}\n${finalHfProc.stdout || ""}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("[INFO]"));
    const errorLines = logLines.filter((l) => /error|fail|exception|timeout|cannot|not found/i.test(l));
    const detail = finalHfProc.error
      ? finalHfProc.error.message
      : (errorLines.length > 0 ? errorLines : logLines).slice(-3).join(" | ").slice(-400) ||
        `exit=${finalHfProc.status ?? finalHfProc.signal}`;
    throw new CutholError(DIAGNOSTICS.HYPERFRAMES_RENDER_FAILED(options.compositionDir, detail));
  } finally {
    if (fs.existsSync(tmpBlob)) {
      try {
        fs.unlinkSync(tmpBlob);
      } catch {
        // ignore cleanup error
      }
    }
    if (tempSceneHostDir && fs.existsSync(tempSceneHostDir)) {
      try {
        fs.rmSync(tempSceneHostDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

function extractFrameFromVideoBlob(
  videoPath: string,
  frameIdx: number,
  fps: number,
  outPng: string,
  scaleToWidth?: number,
  scaleToHeight?: number
): boolean {
  const tmpPng = `${outPng}.${process.pid}.tmp.png`;
  const seekSec = (frameIdx / fps).toFixed(6);
  const vfBase =
    scaleToWidth && scaleToHeight
      ? `scale=${scaleToWidth}:${scaleToHeight},format=rgba`
      : "format=rgba";
  const seekProc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-ss",
      seekSec,
      "-i",
      videoPath,
      "-vf",
      vfBase,
      "-frames:v",
      "1",
      tmpPng,
    ],
    { encoding: "utf8" }
  );
  if (seekProc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 200) {
    fs.renameSync(tmpPng, outPng);
    return true;
  }
  const extProc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      videoPath,
      "-vf",
      `select='eq(n\\,${frameIdx})',${vfBase}`,
      "-frames:v",
      "1",
      tmpPng,
    ],
    { encoding: "utf8" }
  );
  if (extProc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 200) {
    fs.renameSync(tmpPng, outPng);
    return true;
  }
  // Fallback to last frame (`-sseof -0.1`) if `frameIdx` exceeded encoded frame count by 1
  const eofProc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-sseof",
      "-0.1",
      "-i",
      videoPath,
      "-vf",
      vfBase,
      "-frames:v",
      "1",
      tmpPng,
    ],
    { encoding: "utf8" }
  );
  if (eofProc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 200) {
    fs.renameSync(tmpPng, outPng);
    return true;
  }
  if (fs.existsSync(tmpPng)) {
    try {
      fs.unlinkSync(tmpPng);
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Captures a single frame-grid-snapped RGBA PNG from a HyperFrames composition for fast `monitor frame --at <ms>`
 * without rendering the entire composition video when uncached.
 */
export function renderHyperFramesSingleFramePng(options: {
  compositionDir: string;
  entryHtml: string;
  blobsDir: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  localSec: number;
  props: Record<string, unknown>;
  transparent: boolean;
  mode?: "overlay_alpha" | "scene_host";
  backdropVideoPath?: string;
  opaqueBackdropColor?: string;
  backdropImagePath?: string;
}): { pngPath: string; snappedSec: number; frameIdx: number } {
  const absCompDir = path.resolve(options.compositionDir);
  const entryPath = path.join(absCompDir, options.entryHtml);
  if (!fs.existsSync(entryPath)) {
    throw new CutholError(DIAGNOSTICS.MISSING_FILE_ON_DISK("composition", entryPath));
  }

  const mode = options.mode ?? "overlay_alpha";
  let htmlSource = fs.readFileSync(entryPath, "utf8");
  if (options.transparent && mode !== "scene_host" && /(?:body|#root)\s*\{[^}]*?background\s*:\s*#00ff00\b/i.test(htmlSource)) {
    htmlSource = htmlSource.replace(
      /((?:body|#root)\s*\{[^}]*?)background\s*:\s*#00ff00\b/gi,
      "$1background: transparent"
    );
    fs.writeFileSync(entryPath, htmlSource, "utf8");
  }

  const durationSec = Math.max(0.1, Number((options.durationMs / 1000).toFixed(3)));
  const totalFrames = Math.max(1, Math.round(durationSec * options.fps));
  const frameIdx = Math.max(
    0,
    Math.min(totalFrames - 1, Math.floor(options.localSec * options.fps + 1e-6))
  );
  const snappedSec = Number((frameIdx / options.fps).toFixed(6));

  const { hash, nativeHash, isSceneHost, nativeWidth, nativeHeight, targetWidth, targetHeight } =
    syncScalarVarsAndComputeCompositionHash({
      absCompDir,
      entryHtml: options.entryHtml,
      htmlSource,
      width: options.width,
      height: options.height,
      fps: options.fps,
      durationMs: options.durationMs,
      props: options.props,
      transparent: options.transparent,
      mode,
      backdropVideoPath: options.backdropVideoPath,
      opaqueBackdropColor: options.opaqueBackdropColor,
      backdropImagePath: options.backdropImagePath,
    });

  fs.mkdirSync(options.blobsDir, { recursive: true });
  const outPng = path.join(options.blobsDir, `hf_frame_${hash}_f${frameIdx}.png`);
  if (fs.existsSync(outPng) && fs.statSync(outPng).size > 200) {
    if (options.transparent && !isSceneHost) {
      recordCompositionAlphaBboxSidecar(absCompDir, outPng);
    }
    return { pngPath: outPng, snappedSec, frameIdx };
  }

  // If the full video blob (.mov or .mp4) is ALREADY cached at target resolution, extract the exact frame `frameIdx` from it
  const cachedMov = path.join(options.blobsDir, `hf_comp_${hash}.mov`);
  const cachedMp4 = path.join(options.blobsDir, `hf_comp_${hash}.mp4`);
  const cachedVideo = fs.existsSync(cachedMov)
    ? cachedMov
    : fs.existsSync(cachedMp4)
      ? cachedMp4
      : null;

  if (cachedVideo && fs.statSync(cachedVideo).size > 1000) {
    if (extractFrameFromVideoBlob(cachedVideo, frameIdx, options.fps, outPng)) {
      if (options.transparent && !isSceneHost && cachedVideo.endsWith(".mov")) {
        recordCompositionAlphaBboxSidecar(absCompDir, outPng);
      }
      return { pngPath: outPng, snappedSec, frameIdx };
    }
  }

  // If a master-resolution video blob is already cached (`nativeHash`), scale from it instead of launching Chrome
  if (nativeHash !== hash) {
    const nativeMov = path.join(options.blobsDir, `hf_comp_${nativeHash}.mov`);
    const nativeMp4 = path.join(options.blobsDir, `hf_comp_${nativeHash}.mp4`);
    const nativeVideo = fs.existsSync(nativeMov)
      ? nativeMov
      : fs.existsSync(nativeMp4)
        ? nativeMp4
        : null;
    if (nativeVideo && fs.statSync(nativeVideo).size > 1000) {
      if (
        extractFrameFromVideoBlob(
          nativeVideo,
          frameIdx,
          options.fps,
          outPng,
          targetWidth,
          targetHeight
        )
      ) {
        if (options.transparent && !isSceneHost && nativeVideo.endsWith(".mov")) {
          recordCompositionAlphaBboxSidecar(absCompDir, outPng);
        }
        return { pngPath: outPng, snappedSec, frameIdx };
      }
    }
  }

  const hfBin = findLocalHyperFramesCliMjs();
  if (fs.existsSync(hfBin)) {
    const tmpSnapDir = path.join(
      options.blobsDir,
      `hf_snap_tmp_${hash}_f${frameIdx}_${process.pid}_${Date.now()}`
    );
    const needsStage =
      (isSceneHost && Boolean(options.backdropVideoPath)) ||
      (!options.transparent && Boolean(options.opaqueBackdropColor || options.backdropImagePath)) ||
      targetWidth !== nativeWidth ||
      targetHeight !== nativeHeight;
    let tempSceneHostDir: string | null = null;
    try {
      let targetSnapDir = absCompDir;
      if (needsStage) {
        tempSceneHostDir = stageCompositionRenderDir({
          absCompDir,
          entryHtml: options.entryHtml,
          blobsDir: options.blobsDir,
          hash,
          durationSec,
          nativeWidth,
          nativeHeight,
          targetWidth,
          targetHeight,
          isSceneHost,
          backdropVideoPath: options.backdropVideoPath,
          transparent: options.transparent,
          opaqueBackdropColor: options.opaqueBackdropColor,
          backdropImagePath: options.backdropImagePath,
        });
        targetSnapDir = tempSceneHostDir;
      }
      const snapProc = spawnSync(
        process.execPath,
        [
          hfBin,
          "snapshot",
          targetSnapDir,
          "--at",
          String(snappedSec),
          "--no-end",
          "--describe",
          "false",
          "--output",
          tmpSnapDir,
        ],
        { encoding: "utf8", timeout: 60_000 }
      );
      if (snapProc.status === 0 && fs.existsSync(tmpSnapDir)) {
        const pngFile = fs
          .readdirSync(tmpSnapDir)
          .sort()
          .find((f) => f.startsWith("frame-") && f.endsWith(".png"));
        if (pngFile) {
          const fullPng = path.join(tmpSnapDir, pngFile);
          fs.copyFileSync(fullPng, outPng);
          if (options.transparent && !isSceneHost) {
            recordCompositionAlphaBboxSidecar(absCompDir, outPng);
          }
          return { pngPath: outPng, snappedSec, frameIdx };
        }
      }
    } finally {
      if (fs.existsSync(tmpSnapDir)) {
        try {
          fs.rmSync(tmpSnapDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      if (tempSceneHostDir && fs.existsSync(tempSceneHostDir)) {
        try {
          fs.rmSync(tempSceneHostDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  // Fallback single-frame synthesis
  const fullBlob = renderHyperFramesCompositionToMp4({
    compositionDir: options.compositionDir,
    entryHtml: options.entryHtml,
    blobsDir: options.blobsDir,
    width: options.width,
    height: options.height,
    fps: options.fps,
    durationMs: options.durationMs,
    props: options.props,
    transparent: options.transparent,
    mode,
    backdropVideoPath: options.backdropVideoPath,
    opaqueBackdropColor: options.opaqueBackdropColor,
    backdropImagePath: options.backdropImagePath,
  });
  extractFrameFromVideoBlob(fullBlob, frameIdx, options.fps, outPng);
  return { pngPath: outPng, snappedSec, frameIdx };
}

function parseSnapshotFrameSecFromFilename(filePath: string): number | null {
  const base = path.basename(filePath);
  const m = /^frame-(?:\d+-at-)?([\d.]+)s\.png$/i.exec(base);
  if (!m) return null;
  const val = Number(m[1]);
  return Number.isFinite(val) ? val : null;
}

/**
 * Captures multiple frame-grid-snapped RGBA PNGs from a HyperFrames composition in a single
 * `snapshot --at t1,t2,...` invocation and writes them into the shared `hf_frame_<hash>_f<idx>.png`
 * cache so `renderSingleCompositeFrameRgb24` hits the cache for every cell in `monitor sheet`.
 */
export function renderHyperFramesBatchFramesPng(options: {
  compositionDir: string;
  entryHtml: string;
  blobsDir: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  localSecs: number[];
  props: Record<string, unknown>;
  transparent: boolean;
  mode?: "overlay_alpha" | "scene_host";
  backdropVideoPath?: string;
  opaqueBackdropColor?: string;
  backdropImagePath?: string;
}): Array<{ pngPath: string; snappedSec: number; frameIdx: number }> {
  if (options.localSecs.length === 0) {
    return [];
  }

  const absCompDir = path.resolve(options.compositionDir);
  const entryPath = path.join(absCompDir, options.entryHtml);
  if (!fs.existsSync(entryPath)) {
    throw new CutholError(DIAGNOSTICS.MISSING_FILE_ON_DISK("composition", entryPath));
  }

  const mode = options.mode ?? "overlay_alpha";
  let htmlSource = fs.readFileSync(entryPath, "utf8");
  if (
    options.transparent &&
    mode !== "scene_host" &&
    /(?:body|#root)\s*\{[^}]*?background\s*:\s*#00ff00\b/i.test(htmlSource)
  ) {
    htmlSource = htmlSource.replace(
      /((?:body|#root)\s*\{[^}]*?)background\s*:\s*#00ff00\b/gi,
      "$1background: transparent"
    );
    fs.writeFileSync(entryPath, htmlSource, "utf8");
  }

  const durationSec = Math.max(0.1, Number((options.durationMs / 1000).toFixed(3)));
  const totalFrames = Math.max(1, Math.round(durationSec * options.fps));

  const { hash, nativeHash, isSceneHost, nativeWidth, nativeHeight, targetWidth, targetHeight } =
    syncScalarVarsAndComputeCompositionHash({
      absCompDir,
      entryHtml: options.entryHtml,
      htmlSource,
      width: options.width,
      height: options.height,
      fps: options.fps,
      durationMs: options.durationMs,
      props: options.props,
      transparent: options.transparent,
      mode,
      backdropVideoPath: options.backdropVideoPath,
      opaqueBackdropColor: options.opaqueBackdropColor,
      backdropImagePath: options.backdropImagePath,
    });

  fs.mkdirSync(options.blobsDir, { recursive: true });

  const requestedItems = options.localSecs.map((localSec) => {
    const frameIdx = Math.max(
      0,
      Math.min(totalFrames - 1, Math.floor(localSec * options.fps + 1e-6))
    );
    const snappedSec = Number((frameIdx / options.fps).toFixed(6));
    const pngPath = path.join(options.blobsDir, `hf_frame_${hash}_f${frameIdx}.png`);
    return { pngPath, snappedSec, frameIdx };
  });

  const uniqueMissingByFrame = new Map<number, { pngPath: string; snappedSec: number; frameIdx: number }>();
  for (const item of requestedItems) {
    if (!fs.existsSync(item.pngPath) || fs.statSync(item.pngPath).size <= 200) {
      uniqueMissingByFrame.set(item.frameIdx, item);
    }
  }

  const missingTargets = [...uniqueMissingByFrame.values()].sort((a, b) => a.frameIdx - b.frameIdx);
  if (missingTargets.length === 0) {
    const bboxSidecarPath = path.join(absCompDir, "assets/cuthol-bbox.json");
    if (options.transparent && !isSceneHost && !fs.existsSync(bboxSidecarPath)) {
      recordCompositionAlphaBboxSidecar(absCompDir, requestedItems[0].pngPath);
    }
    return requestedItems;
  }

  const cachedMov = path.join(options.blobsDir, `hf_comp_${hash}.mov`);
  const cachedMp4 = path.join(options.blobsDir, `hf_comp_${hash}.mp4`);
  const cachedVideo = fs.existsSync(cachedMov)
    ? cachedMov
    : fs.existsSync(cachedMp4)
      ? cachedMp4
      : null;

  let scaleW: number | undefined;
  let scaleH: number | undefined;
  let videoToExtract = cachedVideo && fs.statSync(cachedVideo).size > 1000 ? cachedVideo : null;
  if (!videoToExtract && nativeHash !== hash) {
    const nativeMov = path.join(options.blobsDir, `hf_comp_${nativeHash}.mov`);
    const nativeMp4 = path.join(options.blobsDir, `hf_comp_${nativeHash}.mp4`);
    const nativeVideo = fs.existsSync(nativeMov)
      ? nativeMov
      : fs.existsSync(nativeMp4)
        ? nativeMp4
        : null;
    if (nativeVideo && fs.statSync(nativeVideo).size > 1000) {
      videoToExtract = nativeVideo;
      scaleW = targetWidth;
      scaleH = targetHeight;
    }
  }

  const stillMissing: Array<{ pngPath: string; snappedSec: number; frameIdx: number }> = [];
  if (videoToExtract) {
    for (const target of missingTargets) {
      if (
        !extractFrameFromVideoBlob(
          videoToExtract,
          target.frameIdx,
          options.fps,
          target.pngPath,
          scaleW,
          scaleH
        )
      ) {
        stillMissing.push(target);
      }
    }
  } else {
    stillMissing.push(...missingTargets);
  }

  const hfBin = findLocalHyperFramesCliMjs();
  if (stillMissing.length > 0 && fs.existsSync(hfBin)) {
    const tmpSnapDir = path.join(
      options.blobsDir,
      `hf_snap_batch_${hash}_${process.pid}_${Date.now()}`
    );
    const needsStage =
      (isSceneHost && Boolean(options.backdropVideoPath)) ||
      (!options.transparent && Boolean(options.opaqueBackdropColor || options.backdropImagePath)) ||
      targetWidth !== nativeWidth ||
      targetHeight !== nativeHeight;
    let tempSceneHostDir: string | null = null;
    try {
      let targetSnapDir = absCompDir;
      if (needsStage) {
        tempSceneHostDir = stageCompositionRenderDir({
          absCompDir,
          entryHtml: options.entryHtml,
          blobsDir: options.blobsDir,
          hash,
          durationSec,
          nativeWidth,
          nativeHeight,
          targetWidth,
          targetHeight,
          isSceneHost,
          backdropVideoPath: options.backdropVideoPath,
          transparent: options.transparent,
          opaqueBackdropColor: options.opaqueBackdropColor,
          backdropImagePath: options.backdropImagePath,
        });
        targetSnapDir = tempSceneHostDir;
      }

      const snapProc = spawnSync(
        process.execPath,
        [
          hfBin,
          "snapshot",
          targetSnapDir,
          "--at",
          stillMissing.map((t) => String(t.snappedSec)).join(","),
          "--no-end",
          "--describe",
          "false",
          "--output",
          tmpSnapDir,
        ],
        { encoding: "utf8", timeout: Math.max(60_000, stillMissing.length * 10_000) }
      );

      if (snapProc.status === 0 && fs.existsSync(tmpSnapDir)) {
        const capturedPngs = fs
          .readdirSync(tmpSnapDir)
          .filter((f) => f.startsWith("frame-") && f.endsWith(".png"))
          .map((f) => path.join(tmpSnapDir, f))
          .sort((a, b) => {
            const sa = parseSnapshotFrameSecFromFilename(a);
            const sb = parseSnapshotFrameSecFromFilename(b);
            if (sa !== null && sb !== null) return sa - sb;
            return a.localeCompare(b);
          });

        for (let i = 0; i < stillMissing.length; i++) {
          const target = stillMissing[i];
          let matchedPng: string | undefined;
          let bestDiff = Infinity;
          for (const candidate of capturedPngs) {
            const cSec = parseSnapshotFrameSecFromFilename(candidate);
            if (cSec !== null) {
              const diff = Math.abs(cSec - target.snappedSec);
              if (diff < bestDiff && diff <= Math.max(0.05, 1.5 / options.fps)) {
                bestDiff = diff;
                matchedPng = candidate;
              }
            }
          }
          if (!matchedPng && i < capturedPngs.length) {
            matchedPng = capturedPngs[i];
          }
          if (matchedPng && fs.existsSync(matchedPng)) {
            fs.copyFileSync(matchedPng, target.pngPath);
          }
        }
      }
    } finally {
      if (fs.existsSync(tmpSnapDir)) {
        try {
          fs.rmSync(tmpSnapDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      if (tempSceneHostDir && fs.existsSync(tempSceneHostDir)) {
        try {
          fs.rmSync(tempSceneHostDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  for (const target of stillMissing) {
    if (!fs.existsSync(target.pngPath) || fs.statSync(target.pngPath).size <= 200) {
      renderHyperFramesSingleFramePng({
        ...options,
        localSec: target.snappedSec,
      });
    }
  }

  if (options.transparent && !isSceneHost && requestedItems.length > 0) {
    const firstValid = requestedItems.find(
      (r) => fs.existsSync(r.pngPath) && fs.statSync(r.pngPath).size > 200
    );
    if (firstValid) {
      recordCompositionAlphaBboxSidecar(absCompDir, firstValid.pngPath);
    }
  }

  return requestedItems;
}

export interface MeasuredAlphaBboxPct {
  left_pct: number;
  top_pct: number;
  right_pct: number;
  bottom_pct: number;
  width_pct: number;
  height_pct: number;
}

/**
 * Measures the actual visible pixel bounding box (alpha > 12) from a rendered RGBA PNG frame
 * or ProRes 4444 .mov video and writes <absCompDir>/assets/cuthol-bbox.json so measureCuePixelBox
 * places the monitor/verification bounding box around the real custom graphic instead of guessing.
 */
export function recordCompositionAlphaBboxSidecar(
  absCompDir: string,
  mediaPath: string,
  atSec?: number
): MeasuredAlphaBboxPct | null {
  try {
    if (!fs.existsSync(mediaPath)) return null;
    const probeW = 320;
    const probeH = 180;
    const args: string[] = ["-v", "error"];
    if (atSec !== undefined && atSec > 0 && !mediaPath.endsWith(".png")) {
      args.push("-ss", atSec.toFixed(3));
    }
    args.push(
      "-i",
      mediaPath,
      "-vf",
      `scale=${probeW}:${probeH}:flags=neighbor,format=rgba`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1"
    );
    const proc = spawnSync("ffmpeg", args, {
      maxBuffer: probeW * probeH * 4 + 65536,
      timeout: 15_000,
    });
    const buf = proc.stdout as Buffer;
    if (proc.status !== 0 || !buf || buf.length < probeW * probeH * 4) return null;

    let minX = probeW;
    let minY = probeH;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < probeH; y++) {
      for (let x = 0; x < probeW; x++) {
        const a = buf[(y * probeW + x) * 4 + 3];
        if (a > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX || maxY < minY) return null;
    const bbox: MeasuredAlphaBboxPct = {
      left_pct: Number((minX / probeW).toFixed(4)),
      top_pct: Number((minY / probeH).toFixed(4)),
      right_pct: Number(((maxX + 1) / probeW).toFixed(4)),
      bottom_pct: Number(((maxY + 1) / probeH).toFixed(4)),
      width_pct: Number(((maxX - minX + 1) / probeW).toFixed(4)),
      height_pct: Number(((maxY - minY + 1) / probeH).toFixed(4)),
    };

    const bboxPath = path.join(path.resolve(absCompDir), "assets/cuthol-bbox.json");
    fs.mkdirSync(path.dirname(bboxPath), { recursive: true });
    fs.writeFileSync(bboxPath, JSON.stringify(bbox, null, 2), "utf8");
    return bbox;
  } catch {
    return null;
  }
}
