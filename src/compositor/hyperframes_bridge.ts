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

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSubprocessFailureDiagnostic, CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  type AlphaOverlayFormat,
  resolveAlphaOverlayFormat,
  resolveHyperFramesWorkers,
  resolveOverlayConcurrency,
  resolveVideoEncoderPreference,
} from "../core/env.js";
import { probeAndVerifyVideoEncoder } from "../render/encoder.js";
import {
  type ParallelFfmpegJob,
  runWatchedParallelFfmpegJobsSync,
  spawnWatchedSync,
} from "../core/subprocess.js";
import {
  analyzeCompositionDataUsage,
  computeUsedBridgePayloadHashes,
  extractScalarHyperFramesVariables,
  hashCompositionFilesExcludingBridgeData,
  hashDirectoryRecursive,
} from "./bridge_exporter.js";
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

export function isDuplicateImgMediaDiscoveryFinding(
  finding: {
    code?: string;
    message?: string;
    snippet?: string;
    selector?: string;
  },
  absCompDir?: string,
  entryHtml = "index.html"
): boolean {
  if (finding.code !== "duplicate_media_discovery_risk") return false;
  const msg = String(finding.message ?? "");
  const snippet = String(finding.snippet ?? "");
  const selector = String(finding.selector ?? "");

  if (
    /\bmatching\s+(?:video|audio)\s+entries\b/i.test(msg) ||
    /^\s*<?(?:video|audio)\b/i.test(snippet) ||
    /^\s*(?:video|audio)\b/i.test(selector)
  ) {
    return false;
  }
  if (
    /\bmatching\s+img\s+entries\b/i.test(msg) ||
    /^\s*<?img\b/i.test(snippet) ||
    /^\s*img\b/i.test(selector)
  ) {
    return true;
  }

  if (absCompDir) {
    try {
      const htmlPath = path.join(path.resolve(absCompDir), entryHtml || "index.html");
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, "utf8");
        const videoAudioSrcs = new Set<string>();
        let hasDupVideoAudio = false;
        const vaRe = /<(?:video|audio)\b[^>]*?\bsrc\s*=\s*(["'])([^"']+)\1/gi;
        let m: RegExpExecArray | null;
        while ((m = vaRe.exec(html)) !== null) {
          const src = m[2].trim();
          if (videoAudioSrcs.has(src)) {
            hasDupVideoAudio = true;
            break;
          }
          videoAudioSrcs.add(src);
        }
        if (hasDupVideoAudio) return false;

        const imgSrcs = new Set<string>();
        const imgRe = /<img\b[^>]*?\bsrc\s*=\s*(["'])([^"']+)\1/gi;
        while ((m = imgRe.exec(html)) !== null) {
          const src = m[2].trim();
          if (imgSrcs.has(src)) return true;
          imgSrcs.add(src);
        }
      }
    } catch {
      // ignore read failure
    }
  }
  return false;
}

function normalizeLintEntryForCuthol(
  raw: Omit<HyperFramesLintResult, "cached">,
  absCompDir: string,
  entryHtml: string
): Omit<HyperFramesLintResult, "cached"> {
  const findings: HyperFramesLintFinding[] = [];
  const infoFindings: HyperFramesLintFinding[] = [...(raw.info_findings ?? [])];

  for (const f of raw.findings ?? []) {
    if (
      SIZE_AND_SPLIT_LINT_CODES.has(f.code) ||
      isDuplicateImgMediaDiscoveryFinding(f, absCompDir, entryHtml)
    ) {
      const infoItem: HyperFramesLintFinding = { ...f, severity: "info" };
      if (
        !infoFindings.some(
          (x) => x.code === infoItem.code && x.message === infoItem.message && x.snippet === infoItem.snippet
        )
      ) {
        infoFindings.push(infoItem);
      }
    } else {
      findings.push(f);
    }
  }

  return {
    ok: findings.every((f) => f.severity !== "error"),
    content_hash: raw.content_hash,
    findings,
    info_findings: infoFindings,
  };
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
        const normalized = normalizeLintEntryForCuthol(parsed, absCompDir, entryHtml);
        lintMemoryCache.set(contentHash, normalized);
        return { ...normalized, cached: true };
      }
    } catch {
      // ignore corrupt cache file
    }
  }

  const findings: HyperFramesLintFinding[] = [];
  const infoFindings: HyperFramesLintFinding[] = [];
  const hfBin = findLocalHyperFramesCliMjs();

  if (fs.existsSync(hfBin)) {
    const proc = spawnWatchedSync(process.execPath, [hfBin, "lint", absCompDir, "--json"], {
      encoding: "utf8",
      step: "hyperframes lint",
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
          const isImgDup = isDuplicateImgMediaDiscoveryFinding(
            {
              code,
              message: f.message,
              snippet: f.snippet,
              selector: f.selector,
            },
            absCompDir,
            entryHtml
          );
          const item: HyperFramesLintFinding = {
            code,
            severity:
              SIZE_AND_SPLIT_LINT_CODES.has(code) || isImgDup
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

  const entry = normalizeLintEntryForCuthol(
    {
      ok: findings.every((f) => f.severity !== "error"),
      content_hash: contentHash,
      findings,
      info_findings: infoFindings,
    },
    absCompDir,
    entryHtml
  );
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

/**
 * Probes whether FFmpeg's `h264_nvenc` hardware encoder is functional and passes BT.709 color verification.
 * Result is memoized per process; honors `CUTHOL_DISABLE_NVENC` / `CUTHOL_ENCODER`.
 */
export function isNvencHardwareAvailable(): boolean {
  return probeAndVerifyVideoEncoder("h264_nvenc").ok;
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
  const probe = probeAndVerifyVideoEncoder("h264_nvenc");
  if (!probe.ok) {
    return {
      useNvenc: false,
      fallbackReason: probe.reason ?? "h264_nvenc hardware encoder is not available on this machine",
    };
  }
  return { useNvenc: true, fallbackReason: null };
}

export type OverlayCacheReason =
  | "cached"
  | "new"
  | "html_changed"
  | "slice_changed"
  | "global_used_changed"
  | "props_changed"
  | "backdrop_changed";

export interface HyperFramesPipelineSummaryInfo {
  hf_summary: string | null;
  capture_mode: string | null;
  gpu_mode: string | null;
  streaming_encode: boolean;
  stages_sec: Record<string, number>;
}

function parseDurationSecToken(raw: string): number | null {
  const s = raw.trim();
  const minSec = /^(\d+)m\s+([\d.]+)s$/i.exec(s);
  if (minSec) {
    return Number((Number(minSec[1]) * 60 + Number(minSec[2])).toFixed(3));
  }
  const secOnly = /^([\d.]+)s$/i.exec(s);
  if (secOnly) {
    return Number(Number(secOnly[1]).toFixed(3));
  }
  return null;
}

/**
 * Extracts HyperFrames' pipeline summary line (`<mode> capture · <gpu> gpu · compile ... · capture ... · encode ...`)
 * from stdout/stderr and parses capture mode, GPU mode, streaming encode status, and stage timings.
 */
export function parseHyperFramesPipelineSummary(
  rawStdout: string,
  rawStderr = ""
): HyperFramesPipelineSummaryInfo {
  const combined = `${rawStdout || ""}\n${rawStderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = combined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let summaryLine: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (
      /\b[a-z0-9_-]+\s+capture\b/i.test(line) &&
      (line.includes("·") || /\b(?:compile|setup|encode)\s+\d/i.test(line))
    ) {
      summaryLine = line;
      break;
    }
  }

  let captureMode: string | null = null;
  let gpuMode: string | null = null;
  let streamingEncode = false;
  const stagesSec: Record<string, number> = {};

  if (summaryLine) {
    const segments = summaryLine.split(/\s*·\s*/).map((s) => s.trim());
    for (const seg of segments) {
      const capMatch = /^([a-z0-9_-]+)\s+capture$/i.exec(seg);
      if (capMatch) {
        captureMode = capMatch[1].toLowerCase();
        continue;
      }
      const gpuMatch = /^([a-z0-9_-]+)\s+gpu$/i.exec(seg);
      if (gpuMatch) {
        gpuMode = gpuMatch[1].toLowerCase();
        continue;
      }
      const encStreamMatch = /^encode\s+\(during\s+capture\)\s+(.+)$/i.exec(seg);
      if (encStreamMatch) {
        streamingEncode = true;
        const sec = parseDurationSecToken(encStreamMatch[1]);
        if (sec !== null) stagesSec.encode = sec;
        continue;
      }
      const stageMatch = /^(compile|extract|audio|probe|setup|capture|encode|assemble)\s+(.+)$/i.exec(seg);
      if (stageMatch) {
        const key = stageMatch[1].toLowerCase();
        const sec = parseDurationSecToken(stageMatch[2]);
        if (sec !== null) stagesSec[key] = sec;
      }
    }
  }

  return {
    hf_summary: summaryLine,
    capture_mode: captureMode,
    gpu_mode: gpuMode,
    streaming_encode: streamingEncode,
    stages_sec: stagesSec,
  };
}

function readBlobMetaSummary(blobPath: string): Partial<HyperFramesPipelineSummaryInfo> {
  const metaPath = `${blobPath}.meta.json`;
  if (!fs.existsSync(metaPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return {
      hf_summary: typeof parsed.hf_summary === "string" ? parsed.hf_summary : null,
      capture_mode: typeof parsed.capture_mode === "string" ? parsed.capture_mode : null,
      gpu_mode: typeof parsed.gpu_mode === "string" ? parsed.gpu_mode : null,
      streaming_encode: Boolean(parsed.streaming_encode),
      stages_sec:
        parsed.stages_sec && typeof parsed.stages_sec === "object" ? parsed.stages_sec : {},
    };
  } catch {
    return {};
  }
}

export interface OverlayRenderItemSummary {
  composition: string;
  composition_dir: string;
  blob_path: string;
  cached: boolean;
  reason: OverlayCacheReason;
  elapsed_ms: number;
  capture_mode?: string | null;
  gpu_mode?: string | null;
  streaming_encode?: boolean;
  hf_summary?: string | null;
  stages_sec?: Record<string, number>;
}

export interface RenderOverlaySummary {
  total: number;
  cached: number;
  rendered: number;
  concurrency?: number;
  workers?: number;
  capture_modes?: Record<string, number>;
  gpu_modes?: Record<string, number>;
  stage_totals_sec?: Record<string, number>;
  reasons: Record<string, number>;
  elapsed_ms: number;
  rerendered: Array<{
    composition: string;
    reason: OverlayCacheReason;
    elapsed_ms: number;
    capture_mode?: string | null;
    gpu_mode?: string | null;
    streaming_encode?: boolean;
    hf_summary?: string | null;
    stages_sec?: Record<string, number>;
  }>;
  summary: string;
}

let activeOverlayTrackingMap: Map<string, OverlayRenderItemSummary> | null = null;
let activeOverlayPrepassWallMs = 0;
let activeOverlayConcurrencyMeta: { concurrency: number; workers: number } | null = null;

export function beginOverlayRenderTracking(meta?: { concurrency?: number; workers?: number }): void {
  activeOverlayTrackingMap = new Map<string, OverlayRenderItemSummary>();
  activeOverlayPrepassWallMs = 0;
  activeOverlayConcurrencyMeta = meta
    ? {
        concurrency: meta.concurrency ?? 1,
        workers: meta.workers ?? resolveHyperFramesWorkers(),
      }
    : null;
}

export function setOverlayRenderExecutionMeta(meta: { concurrency: number; workers: number }): void {
  activeOverlayConcurrencyMeta = { ...meta };
}

export function finishOverlayRenderTracking(): RenderOverlaySummary {
  const items = activeOverlayTrackingMap ? [...activeOverlayTrackingMap.values()] : [];
  const wallPrepassMs = activeOverlayPrepassWallMs;
  const execMeta = activeOverlayConcurrencyMeta;
  activeOverlayTrackingMap = null;
  activeOverlayPrepassWallMs = 0;
  activeOverlayConcurrencyMeta = null;

  const total = items.length;
  let cached = 0;
  let rendered = 0;
  let sumElapsedMs = 0;
  const reasons: Record<string, number> = {};
  const captureModes: Record<string, number> = {};
  const gpuModes: Record<string, number> = {};
  const stageTotalsSec: Record<string, number> = {};
  const rerendered: RenderOverlaySummary["rerendered"] = [];

  for (const item of items) {
    sumElapsedMs += item.elapsed_ms;
    if (item.capture_mode) {
      captureModes[item.capture_mode] = (captureModes[item.capture_mode] ?? 0) + 1;
    }
    if (item.gpu_mode) {
      gpuModes[item.gpu_mode] = (gpuModes[item.gpu_mode] ?? 0) + 1;
    }
    if (item.cached) {
      cached += 1;
    } else {
      rendered += 1;
      reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
      if (item.stages_sec) {
        for (const [k, v] of Object.entries(item.stages_sec)) {
          if (typeof v === "number" && Number.isFinite(v)) {
            stageTotalsSec[k] = Number(((stageTotalsSec[k] ?? 0) + v).toFixed(3));
          }
        }
      }
      rerendered.push({
        composition: item.composition,
        reason: item.reason,
        elapsed_ms: item.elapsed_ms,
        ...(item.capture_mode ? { capture_mode: item.capture_mode } : {}),
        ...(item.gpu_mode ? { gpu_mode: item.gpu_mode } : {}),
        ...(item.streaming_encode !== undefined ? { streaming_encode: item.streaming_encode } : {}),
        ...(item.hf_summary ? { hf_summary: item.hf_summary } : {}),
        ...(item.stages_sec && Object.keys(item.stages_sec).length > 0
          ? { stages_sec: item.stages_sec }
          : {}),
      });
    }
  }

  const elapsedMs = wallPrepassMs > 0 ? wallPrepassMs : sumElapsedMs;
  const secStr = `${(elapsedMs / 1000).toFixed(2)}s`;
  let summary: string;
  if (total === 0) {
    summary = `0 overlays (${secStr})`;
  } else if (rendered === 0) {
    summary = `${cached}/${total} cached, 0 rendered (${secStr})`;
  } else {
    const reasonParts = Object.entries(reasons)
      .map(([r, c]) => `${r}=${c}`)
      .join(", ");
    const names = rerendered
      .slice(0, 5)
      .map((r) => `${r.composition}:${r.reason}`)
      .join(", ");
    const more = rerendered.length > 5 ? ` +${rerendered.length - 5}` : "";
    const modeParts: string[] = [];
    if (Object.keys(captureModes).length > 0) {
      modeParts.push(
        `capture=${Object.entries(captureModes)
          .map(([m, c]) => `${m}:${c}`)
          .join(",")}`
      );
    }
    if (execMeta) {
      modeParts.push(`K=${execMeta.concurrency}xW=${execMeta.workers}`);
    }
    const modeSuffix = modeParts.length > 0 ? `; ${modeParts.join(", ")}` : "";
    summary = `${cached}/${total} cached, ${rendered} rendered (${reasonParts}; ${names}${more}${modeSuffix}) in ${secStr}`;
  }

  return {
    total,
    cached,
    rendered,
    ...(execMeta ? { concurrency: execMeta.concurrency, workers: execMeta.workers } : {}),
    ...(Object.keys(captureModes).length > 0 ? { capture_modes: captureModes } : {}),
    ...(Object.keys(gpuModes).length > 0 ? { gpu_modes: gpuModes } : {}),
    ...(Object.keys(stageTotalsSec).length > 0 ? { stage_totals_sec: stageTotalsSec } : {}),
    reasons,
    elapsed_ms: elapsedMs,
    rerendered,
    summary,
  };
}

function recordOverlayRenderOutcome(item: OverlayRenderItemSummary): void {
  if (!activeOverlayTrackingMap) return;
  const key = path.resolve(item.composition_dir);
  const existing = activeOverlayTrackingMap.get(key);
  if (!existing) {
    activeOverlayTrackingMap.set(key, { ...item });
    return;
  }
  if (!item.cached) {
    existing.cached = false;
    existing.reason = item.reason;
    existing.blob_path = item.blob_path;
    existing.elapsed_ms = item.elapsed_ms;
    if (item.capture_mode) existing.capture_mode = item.capture_mode;
    if (item.gpu_mode) existing.gpu_mode = item.gpu_mode;
    if (item.streaming_encode !== undefined) existing.streaming_encode = item.streaming_encode;
    if (item.hf_summary) existing.hf_summary = item.hf_summary;
    if (item.stages_sec) existing.stages_sec = item.stages_sec;
  } else if (existing.cached) {
    existing.elapsed_ms += item.elapsed_ms;
  }
}

interface CollectedOverlayJob {
  compName: string;
  compositionDir: string;
  absCompDir: string;
  outBlob: string;
  tmpBlob: string;
  watchTargetPath: string;
  expectedFrames?: number;
  args: string[];
  fallbackNoGpuArgs: string[] | null;
  wantGpu: boolean;
  workers: number;
  stageDirToClean: string | null;
  finalizeSuccess: (params: {
    usedGpu: boolean;
    gpuFallbackReason: string | null;
    elapsedMs: number;
    stdoutStr: string;
    stderrStr: string;
  }) => void;
  cleanupTemp: () => void;
}

let overlayCollector: CollectedOverlayJob[] | null = null;

export function beginOverlayCollect(): void {
  overlayCollector = [];
}

export function isOverlayCollectActive(): boolean {
  return overlayCollector !== null;
}

export function hasPendingCollectedOverlayForPaths(candidatePaths: string[]): boolean {
  if (!overlayCollector || overlayCollector.length === 0) return false;
  const pendingSet = new Set(overlayCollector.map((j) => path.resolve(j.outBlob)));
  return candidatePaths.some((p) => {
    if (!p || p.startsWith("-")) return false;
    try {
      const resolved = path.resolve(p);
      return pendingSet.has(resolved) || pendingSet.has(path.dirname(resolved));
    } catch {
      return false;
    }
  });
}

function buildHyperFramesFailureError(
  compositionDir: string,
  renderArgs: string[],
  proc: {
    status: number | null;
    signal?: NodeJS.Signals | null;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    error?: Error;
    stalled?: boolean;
    stalledMs?: number;
    stallThresholdMs?: number;
    lastProgress?: string;
    commandSummary?: string;
  }
): CutholError {
  const stdoutStr =
    typeof proc.stdout === "string"
      ? proc.stdout
      : proc.stdout
        ? proc.stdout.toString("utf8")
        : "";
  const stderrStr =
    typeof proc.stderr === "string"
      ? proc.stderr
      : proc.stderr
        ? proc.stderr.toString("utf8")
        : "";

  if (proc.stalled) {
    return new CutholError(
      createSubprocessFailureDiagnostic({
        tool: `hyperframes render (${compositionDir})`,
        executable: process.execPath,
        args: renderArgs,
        proc: {
          status: proc.status,
          error: proc.error,
          stderr: stderrStr,
          stalled: proc.stalled,
          stalledMs: proc.stalledMs,
          stallThresholdMs: proc.stallThresholdMs,
          lastProgress: proc.lastProgress,
          commandSummary: proc.commandSummary,
        },
      })
    );
  }

  const logLines = `${stderrStr}\n${stdoutStr}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("[INFO]"));
  const errorLines = logLines.filter((l) => /error|fail|exception|timeout|cannot|not found/i.test(l));
  const detail = proc.error
    ? proc.error.message
    : (errorLines.length > 0 ? errorLines : logLines).slice(-3).join(" | ").slice(-400) ||
      `exit=${proc.status ?? proc.signal}`;
  return new CutholError(DIAGNOSTICS.HYPERFRAMES_RENDER_FAILED(compositionDir, detail));
}

/**
 * Executes all collected cold overlay renders concurrently (up to `K` at a time, each with `W` workers),
 * finalizes every successful overlay into `.cuthol/blobs/`, and if any overlay failed, throws its exact
 * `CUTHOL-G503` / `CUTHOL-SYS10` error after all sibling jobs have finished.
 */
export function runCollectedOverlays(options?: {
  concurrency?: number | null;
  workers?: number | null;
  keepCollecting?: boolean;
}): {
  jobs: number;
  concurrency: number;
  workers: number;
  elapsed_ms: number;
} {
  const jobs = overlayCollector ?? [];
  overlayCollector = options?.keepCollecting ? [] : null;
  const w = resolveHyperFramesWorkers(options?.workers);

  if (jobs.length === 0) {
    const k0 = resolveOverlayConcurrency({
      overrideConcurrency: options?.concurrency,
      workersPerOverlay: w,
    });
    if (!activeOverlayConcurrencyMeta) {
      activeOverlayConcurrencyMeta = { concurrency: k0, workers: w };
    }
    return { jobs: 0, concurrency: k0, workers: w, elapsed_ms: 0 };
  }

  const k = resolveOverlayConcurrency({
    overrideConcurrency: options?.concurrency,
    workersPerOverlay: w,
    coldOverlayCount: jobs.length,
  });
  activeOverlayConcurrencyMeta = { concurrency: k, workers: w };

  const t0 = Date.now();
  const parallelJobs: ParallelFfmpegJob[] = jobs.map((j, idx) => ({
    executable: process.execPath,
    args: j.args,
    cwd: process.cwd(),
    step: `hyperframes render (${j.compName}, ${idx + 1}/${jobs.length})`,
    watchedPaths: [j.watchTargetPath],
    cleanupPathsOnStall: [j.watchTargetPath],
  }));

  const results = runWatchedParallelFfmpegJobsSync(
    parallelJobs,
    jobs.map(() => 512 * 1024 * 1024),
    k
  );
  const wallElapsedMs = Date.now() - t0;
  activeOverlayPrepassWallMs += wallElapsedMs;

  let firstFailure: CutholError | null = null;
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const r = results[i];
    let status = r?.status ?? null;
    let stdoutStr = r?.stdout ? r.stdout.toString("utf8") : "";
    let stderrStr = r?.stderr ?? "";
    let errObj = r?.error;
    let stalled = Boolean(r?.stalled);
    let stalledMs = r?.stalledMs;
    let stallThresholdMs = r?.stallThresholdMs;
    let lastProgress = r?.lastProgress;
    let commandSummary = r?.commandSummary;
    let jobElapsedMs = r?.elapsedMs ?? wallElapsedMs;
    let usedGpu = j.wantGpu;
    let gpuFallbackReason: string | null = null;

    try {
      if (
        j.wantGpu &&
        j.fallbackNoGpuArgs &&
        (status !== 0 || !isValidVideoBlobOnDisk(j.tmpBlob, j.expectedFrames))
      ) {
        usedGpu = false;
        gpuFallbackReason = stalled
          ? "stalled"
          : "HyperFrames GPU encode failed; retried with libx264";
        if (fs.existsSync(j.tmpBlob)) {
          try {
            fs.rmSync(j.tmpBlob, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
        const retryProc = spawnWatchedSync(process.execPath, j.fallbackNoGpuArgs, {
          encoding: "utf8",
          maxBuffer: 512 * 1024 * 1024,
          step: `hyperframes render (${j.compName}, retry cpu)`,
          watchedPaths: [j.watchTargetPath],
          cleanupPathsOnStall: [j.watchTargetPath],
        });
        status = retryProc.status;
        stdoutStr = String(retryProc.stdout || "");
        stderrStr = String(retryProc.stderr || "");
        errObj = retryProc.error;
        stalled = Boolean(retryProc.stalled);
        stalledMs = retryProc.stalledMs;
        stallThresholdMs = retryProc.stallThresholdMs;
        lastProgress = retryProc.lastProgress;
        commandSummary = retryProc.commandSummary;
        jobElapsedMs += retryProc.elapsedMs ?? 0;
      }

      if (
        !stalled &&
        (status !== 0 || !isValidVideoBlobOnDisk(j.tmpBlob, j.expectedFrames)) &&
        /\bEPERM\b|\bEACCES\b|\bEBUSY\b/i.test(`${stderrStr}\n${stdoutStr}`)
      ) {
        if (fs.existsSync(j.tmpBlob)) {
          try {
            fs.rmSync(j.tmpBlob, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
        const epermRetry = spawnWatchedSync(process.execPath, j.args, {
          encoding: "utf8",
          maxBuffer: 512 * 1024 * 1024,
          step: `hyperframes render (${j.compName}, retry eperm)`,
          watchedPaths: [j.watchTargetPath],
          cleanupPathsOnStall: [j.watchTargetPath],
        });
        status = epermRetry.status;
        stdoutStr = String(epermRetry.stdout || "");
        stderrStr = String(epermRetry.stderr || "");
        errObj = epermRetry.error;
        stalled = Boolean(epermRetry.stalled);
        stalledMs = epermRetry.stalledMs;
        stallThresholdMs = epermRetry.stallThresholdMs;
        lastProgress = epermRetry.lastProgress;
        commandSummary = epermRetry.commandSummary;
        jobElapsedMs += epermRetry.elapsedMs ?? 0;
      }

      if (status === 0 && isValidVideoBlobOnDisk(j.tmpBlob, j.expectedFrames)) {
        j.finalizeSuccess({
          usedGpu,
          gpuFallbackReason,
          elapsedMs: jobElapsedMs,
          stdoutStr,
          stderrStr,
        });
      } else if (!firstFailure) {
        firstFailure = buildHyperFramesFailureError(j.compositionDir, j.args, {
          status,
          stdout: stdoutStr,
          stderr: stderrStr,
          error: errObj,
          stalled,
          stalledMs,
          stallThresholdMs,
          lastProgress,
          commandSummary,
        });
      }
    } finally {
      j.cleanupTemp();
    }
  }

  if (firstFailure) {
    throw firstFailure;
  }

  return {
    jobs: jobs.length,
    concurrency: k,
    workers: w,
    elapsed_ms: wallElapsedMs,
  };
}

const fileSha256Memo = new Map<string, string>();

function hashFileContentSha256(filePath: string): string {
  try {
    const abs = path.resolve(filePath);
    const st = fs.statSync(abs);
    const memoKey = `${abs}:${st.size}:${st.mtimeMs}`;
    const hit = fileSha256Memo.get(memoKey);
    if (hit) return hit;
    const digest = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 16);
    fileSha256Memo.set(memoKey, digest);
    return digest;
  } catch {
    return "missing";
  }
}

const stillThumb16x9Memo = new Map<string, Buffer | null>();

function getStillImageThumb16x9Rgb24(pngPath: string): Buffer | null {
  try {
    const abs = path.resolve(pngPath);
    if (!fs.existsSync(abs)) return null;
    const st = fs.statSync(abs);
    const memoKey = `${abs}:${st.size}`;
    if (stillThumb16x9Memo.has(memoKey)) {
      return stillThumb16x9Memo.get(memoKey) ?? null;
    }
    const sidecarPath = `${abs}.thumb16x9.rgb`;
    if (fs.existsSync(sidecarPath) && fs.statSync(sidecarPath).size === 16 * 9 * 3) {
      const buf = fs.readFileSync(sidecarPath);
      stillThumb16x9Memo.set(memoKey, buf);
      return buf;
    }
    const proc = spawnWatchedSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        abs,
        "-vf",
        "scale=16:9:flags=area:in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { maxBuffer: 65536, step: "ffmpeg still thumb" }
    );
    const out = proc.stdout as Buffer;
    if (proc.status === 0 && out && out.length >= 16 * 9 * 3) {
      const slice = Buffer.from(out.subarray(0, 16 * 9 * 3));
      stillThumb16x9Memo.set(memoKey, slice);
      try {
        fs.writeFileSync(sidecarPath, slice);
      } catch {
        // ignore sidecar write error
      }
      return slice;
    }
    stillThumb16x9Memo.set(memoKey, null);
    return null;
  } catch {
    return null;
  }
}

function areStillBackdropsVisuallyEquivalent(pngA?: string, pngB?: string): boolean {
  if (!pngA && !pngB) return true;
  if (!pngA || !pngB) return false;
  const absA = path.resolve(pngA);
  const absB = path.resolve(pngB);
  if (absA === absB) return true;
  if (!fs.existsSync(absA) || !fs.existsSync(absB)) return false;
  if (hashFileContentSha256(absA) === hashFileContentSha256(absB)) return true;

  const thumbA = getStillImageThumb16x9Rgb24(absA);
  const thumbB = getStillImageThumb16x9Rgb24(absB);
  if (!thumbA || !thumbB || thumbA.length !== thumbB.length) return false;

  let diffSum = 0;
  let maxDiff = 0;
  for (let i = 0; i < thumbA.length; i++) {
    const d = Math.abs(thumbA[i] - thumbB[i]);
    diffSum += d;
    if (d > maxDiff) maxDiff = d;
  }
  const mae = diffSum / thumbA.length;
  return mae <= 3.5 && maxDiff <= 24;
}

interface CompositionCacheStateRecord {
  compositionDir: string;
  filesHash: string;
  usedSliceHash: string;
  usedGlobalHash: string;
  propsHash: string;
  durationMs: number;
  transparent: boolean;
  mode: string;
  backdropDigest: string;
  backdropImagePath?: string;
  cachedBlobs: Record<string, string>;
}

function getCompositionStateFilePath(blobsDir: string, absCompDir: string): string {
  const compKey = crypto.createHash("sha256").update(path.resolve(absCompDir)).digest("hex").slice(0, 16);
  return path.join(blobsDir, `hf_state_${compKey}.json`);
}

function readCompositionCacheState(blobsDir: string, absCompDir: string): CompositionCacheStateRecord | null {
  const statePath = getCompositionStateFilePath(blobsDir, absCompDir);
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as CompositionCacheStateRecord;
  } catch {
    return null;
  }
}

function writeCompositionCacheState(
  blobsDir: string,
  absCompDir: string,
  state: CompositionCacheStateRecord
): void {
  try {
    fs.mkdirSync(blobsDir, { recursive: true });
    const statePath = getCompositionStateFilePath(blobsDir, absCompDir);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // ignore state write error
  }
}

function clearBridgeMetaLastDataChangeReason(absCompDir: string): void {
  const metaPath = path.join(absCompDir, "assets/.cuthol-bridge-meta.json");
  if (!fs.existsSync(metaPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (parsed && parsed.lastDataChangeReason) {
      parsed.lastDataChangeReason = null;
      fs.writeFileSync(metaPath, JSON.stringify(parsed, null, 2), "utf8");
    }
  } catch {
    // ignore
  }
}

function compositionOccludesHtmlBackdrop(absCompDir: string, htmlSource: string): boolean {
  // Only an explicit author declaration on the composition root counts: `data-cuthol-opaque="true"`
  // means the composition paints its own opaque full-frame surface for its whole duration,
  // so the stage backdrop underneath can never show through.
  const declared =
    /<[^>]*\bdata-composition-id\b[^>]*\bdata-cuthol-opaque\s*=\s*["']?true\b|<[^>]*\bdata-cuthol-opaque\s*=\s*["']?true\b[^>]*\bdata-composition-id\b/i.test(
      htmlSource
    );
  if (!declared) return false;
  // Safety: transparent root or masks can still reveal the backdrop.
  if (/#root\s*\{[^}]*\bbackground(?:-color)?\s*:\s*transparent\b/i.test(htmlSource)) {
    return false;
  }
  if (/\bmask-composite\b|\b-webkit-mask\b/i.test(htmlSource)) {
    return false;
  }
  return true;
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
  legacyHash: string;
  legacyNativeHash: string;
  filesHash: string;
  usedSliceHash: string;
  usedGlobalHash: string;
  propsHash: string;
  backdropDigest: string;
  legacyBackdropDigest: string;
  legacyDirHash: string;
  validLegacyDirHashes: string[];
  lastDataChangeReason: "slice_changed" | "global_used_changed" | null;
  scalarVars: Record<string, string | number | boolean>;
  isSceneHost: boolean;
  nativeWidth: number;
  nativeHeight: number;
  targetWidth: number;
  targetHeight: number;
  computeCandidateKey: (dirH: string, w: number, h: number, bd: string) => string;
} {
  // Synchronize `assets/cuthol-vars.json` BEFORE hashing so the cache key is never computed against stale variables.
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

  const filesHash = hashCompositionFilesExcludingBridgeData(options.absCompDir);
  const usage = analyzeCompositionDataUsage(options.absCompDir, options.entryHtml, options.props);
  const dataJsonPath = path.join(options.absCompDir, "assets/cuthol-data.json");
  let parsedBridge: Partial<CutholBridgeV1> | null = null;
  if (fs.existsSync(dataJsonPath)) {
    try {
      parsedBridge = JSON.parse(fs.readFileSync(dataJsonPath, "utf8")) as Partial<CutholBridgeV1>;
    } catch {
      parsedBridge = null;
    }
  }
  const { usedSliceHash, usedGlobalHash } = computeUsedBridgePayloadHashes(parsedBridge, usage);
  const propsHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(options.props ?? {}))
    .digest("hex")
    .slice(0, 16);

  const effectiveDirHash = crypto
    .createHash("sha256")
    .update(`files:${filesHash}\nslice:${usedSliceHash}\nglobal:${usedGlobalHash}\n`)
    .digest("hex");

  const legacyDirHash = hashDirectoryRecursive(options.absCompDir);

  let validLegacyDirHashes: string[] = [];
  let lastDataChangeReason: "slice_changed" | "global_used_changed" | null = null;
  const metaSidecarPath = path.join(options.absCompDir, "assets/.cuthol-bridge-meta.json");
  if (fs.existsSync(metaSidecarPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaSidecarPath, "utf8"));
      if (Array.isArray(meta.validLegacyDirHashes)) {
        validLegacyDirHashes = meta.validLegacyDirHashes;
      }
      if (
        meta.lastDataChangeReason === "slice_changed" ||
        meta.lastDataChangeReason === "global_used_changed"
      ) {
        lastDataChangeReason = meta.lastDataChangeReason;
      }
    } catch {
      // ignore
    }
  }

  let backdropDigest = "";
  let legacyBackdropDigest = "";
  const selfOccludesBackdrop =
    !options.transparent &&
    !isSceneHost &&
    compositionOccludesHtmlBackdrop(options.absCompDir, options.htmlSource);
  if (isSceneHost && options.backdropVideoPath) {
    backdropDigest = `video-sha256:${hashFileContentSha256(options.backdropVideoPath)}`;
    try {
      const st = fs.statSync(options.backdropVideoPath);
      legacyBackdropDigest = `${path.basename(options.backdropVideoPath)}:${st.size}:${st.mtimeMs}`;
    } catch {
      legacyBackdropDigest = "none";
    }
  } else if (!options.transparent && selfOccludesBackdrop) {
    backdropDigest = "self-opaque";
    if (options.backdropImagePath) {
      try {
        const st = fs.statSync(options.backdropImagePath);
        legacyBackdropDigest = `still:${path.basename(options.backdropImagePath)}:${st.size}`;
      } catch {
        legacyBackdropDigest = "still:none";
      }
    } else if (options.opaqueBackdropColor) {
      legacyBackdropDigest = `color:${options.opaqueBackdropColor.trim().toLowerCase()}`;
    }
  } else if (!options.transparent && options.backdropImagePath) {
    backdropDigest = `still-sha256:${hashFileContentSha256(options.backdropImagePath)}`;
    try {
      const st = fs.statSync(options.backdropImagePath);
      legacyBackdropDigest = `still:${path.basename(options.backdropImagePath)}:${st.size}`;
    } catch {
      legacyBackdropDigest = "still:none";
    }
  } else if (!options.transparent && options.opaqueBackdropColor) {
    backdropDigest = `color:${options.opaqueBackdropColor.trim().toLowerCase()}`;
    legacyBackdropDigest = backdropDigest;
  }

  const computeCandidateKey = (dirH: string, w: number, h: number, bd: string): string =>
    crypto
      .createHash("sha256")
      .update(dirH)
      .update(
        JSON.stringify({
          entry: options.entryHtml,
          w,
          h,
          fps: options.fps,
          dur: options.durationMs,
          props: options.props,
          transparent: options.transparent,
          mode: options.mode,
          backdropDigest: bd,
        })
      )
      .digest("hex")
      .slice(0, 16);

  // Resolution-specific cache key depending ONLY on composition files + used slice + used global data.
  const hash = computeCandidateKey(effectiveDirHash, targetWidth, targetHeight, backdropDigest);
  const nativeHash = computeCandidateKey(effectiveDirHash, nativeWidth, nativeHeight, backdropDigest);
  const legacyHash = computeCandidateKey(legacyDirHash, targetWidth, targetHeight, legacyBackdropDigest);
  const legacyNativeHash = computeCandidateKey(legacyDirHash, nativeWidth, nativeHeight, legacyBackdropDigest);

  return {
    hash,
    nativeHash,
    legacyHash,
    legacyNativeHash,
    filesHash,
    usedSliceHash,
    usedGlobalHash,
    propsHash,
    backdropDigest,
    legacyBackdropDigest,
    legacyDirHash,
    validLegacyDirHashes,
    lastDataChangeReason,
    scalarVars,
    isSceneHost,
    nativeWidth,
    nativeHeight,
    targetWidth,
    targetHeight,
    computeCandidateKey,
  };
}

function renameWithRetrySync(srcPath: string, dstPath: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (fs.existsSync(dstPath)) {
        fs.rmSync(dstPath, { recursive: true, force: true });
      }
      fs.renameSync(srcPath, dstPath);
      return;
    } catch (err) {
      lastErr = err;
      const until = Date.now() + 50 * (attempt + 1);
      while (Date.now() < until) {}
    }
  }
  throw lastErr;
}

export type OverlayBlobExt = "pngseq" | "ffv1.mov" | "mov" | "mp4";

export function isPngSequenceBlobDir(blobPath: string): boolean {
  if (!blobPath) return false;
  if (blobPath.endsWith(".pngseq")) return true;
  try {
    return fs.existsSync(blobPath) && fs.statSync(blobPath).isDirectory();
  } catch {
    return false;
  }
}

export function inspectPngSequenceDir(dirPath: string): {
  valid: boolean;
  frameCount: number;
  totalBytes: number;
  firstFramePath: string | null;
  lastFramePath: string | null;
} {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) {
      return { valid: false, frameCount: 0, totalBytes: 0, firstFramePath: null, lastFramePath: null };
    }
    const st = fs.statSync(dirPath);
    if (!st.isDirectory()) {
      return { valid: false, frameCount: 0, totalBytes: 0, firstFramePath: null, lastFramePath: null };
    }
    const pngNames = fs
      .readdirSync(dirPath)
      .filter((name) => /^frame_\d+\.png$/i.test(name))
      .sort();
    const frameCount = pngNames.length;
    if (frameCount === 0) {
      return { valid: false, frameCount: 0, totalBytes: 0, firstFramePath: null, lastFramePath: null };
    }
    const firstFramePath = path.join(dirPath, pngNames[0]);
    const lastFramePath = path.join(dirPath, pngNames[frameCount - 1]);
    const firstSize = fs.statSync(firstFramePath).size;
    const lastSize = fs.statSync(lastFramePath).size;
    if (firstSize <= 64 || lastSize <= 64) {
      return { valid: false, frameCount, totalBytes: 0, firstFramePath, lastFramePath };
    }
    let totalBytes = 0;
    for (const name of pngNames) {
      try {
        totalBytes += fs.statSync(path.join(dirPath, name)).size;
      } catch {
        return { valid: false, frameCount, totalBytes: 0, firstFramePath, lastFramePath };
      }
    }
    return {
      valid: totalBytes > 128,
      frameCount,
      totalBytes,
      firstFramePath,
      lastFramePath,
    };
  } catch {
    return { valid: false, frameCount: 0, totalBytes: 0, firstFramePath: null, lastFramePath: null };
  }
}

export function isValidVideoBlobOnDisk(blobPath: string, expectedFrames?: number): boolean {
  if (!blobPath || !fs.existsSync(blobPath)) return false;
  const legacyFallbackSidecar = `${blobPath}.fallback.json`;
  if (fs.existsSync(legacyFallbackSidecar)) {
    for (const stale of [blobPath, legacyFallbackSidecar]) {
      try {
        fs.rmSync(stale, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    return false;
  }
  try {
    const st = fs.statSync(blobPath);
    if (st.isDirectory()) {
      const info = inspectPngSequenceDir(blobPath);
      if (!info.valid) return false;
      if (typeof expectedFrames === "number" && Number.isFinite(expectedFrames) && expectedFrames > 0) {
        if (info.frameCount < Math.max(1, expectedFrames - 1)) {
          return false;
        }
      }
      return true;
    }
    return st.isFile() && st.size > 1000;
  } catch {
    return false;
  }
}

function resolveCachedCompositionVideoBlob(params: {
  absCompDir: string;
  entryPath: string;
  blobsDir: string;
  ext: OverlayBlobExt;
  expectedFrames?: number;
  durationMs: number;
  transparent: boolean;
  mode: "overlay_alpha" | "scene_host";
  backdropImagePath?: string;
  hashInfo: ReturnType<typeof syncScalarVarsAndComputeCompositionHash>;
}): {
  cachedBlobPath: string | null;
  isExactTargetRes: boolean;
  missReason: OverlayCacheReason;
  matchedBackdropImagePath?: string;
} {
  const {
    absCompDir,
    entryPath,
    blobsDir,
    ext,
    expectedFrames,
    durationMs,
    transparent,
    mode,
    backdropImagePath,
    hashInfo,
  } = params;
  const {
    hash,
    nativeHash,
    legacyHash,
    legacyNativeHash,
    filesHash,
    usedSliceHash,
    usedGlobalHash,
    propsHash,
    backdropDigest,
    legacyDirHash,
    validLegacyDirHashes,
    lastDataChangeReason,
    nativeWidth,
    nativeHeight,
    targetWidth,
    targetHeight,
    computeCandidateKey,
  } = hashInfo;

  const outBlob = path.join(blobsDir, `hf_comp_${hash}.${ext}`);
  if (isValidVideoBlobOnDisk(outBlob, expectedFrames)) {
    return {
      cachedBlobPath: outBlob,
      isExactTargetRes: true,
      missReason: "cached",
      matchedBackdropImagePath: backdropImagePath,
    };
  }

  if (nativeHash !== hash) {
    const nativeBlob = path.join(blobsDir, `hf_comp_${nativeHash}.${ext}`);
    if (isValidVideoBlobOnDisk(nativeBlob, expectedFrames)) {
      return {
        cachedBlobPath: nativeBlob,
        isExactTargetRes: false,
        missReason: "cached",
        matchedBackdropImagePath: backdropImagePath,
      };
    }
  }

  const prevState = readCompositionCacheState(blobsDir, absCompDir);
  if (prevState) {
    if (prevState.filesHash !== filesHash) {
      return { cachedBlobPath: null, isExactTargetRes: false, missReason: "html_changed" };
    }
    if (prevState.usedSliceHash !== usedSliceHash) {
      return { cachedBlobPath: null, isExactTargetRes: false, missReason: "slice_changed" };
    }
    if (prevState.usedGlobalHash !== usedGlobalHash) {
      return { cachedBlobPath: null, isExactTargetRes: false, missReason: "global_used_changed" };
    }
    if (prevState.propsHash !== propsHash || prevState.durationMs !== durationMs) {
      return { cachedBlobPath: null, isExactTargetRes: false, missReason: "props_changed" };
    }
    if (prevState.transparent !== transparent || prevState.mode !== mode) {
      return { cachedBlobPath: null, isExactTargetRes: false, missReason: "backdrop_changed" };
    }

    const exactBdTargetKey = `${targetWidth}x${targetHeight}:${ext}:${backdropDigest}`;
    const exactBdNativeKey = `${nativeWidth}x${nativeHeight}:${ext}:${backdropDigest}`;
    if (
      prevState.cachedBlobs?.[exactBdTargetKey] &&
      isValidVideoBlobOnDisk(prevState.cachedBlobs[exactBdTargetKey], expectedFrames)
    ) {
      return {
        cachedBlobPath: prevState.cachedBlobs[exactBdTargetKey],
        isExactTargetRes: true,
        missReason: "cached",
        matchedBackdropImagePath: backdropImagePath,
      };
    }
    if (
      prevState.cachedBlobs?.[exactBdNativeKey] &&
      isValidVideoBlobOnDisk(prevState.cachedBlobs[exactBdNativeKey], expectedFrames)
    ) {
      return {
        cachedBlobPath: prevState.cachedBlobs[exactBdNativeKey],
        isExactTargetRes: targetWidth === nativeWidth && targetHeight === nativeHeight,
        missReason: "cached",
        matchedBackdropImagePath: backdropImagePath,
      };
    }

    const backdropMatches =
      prevState.backdropDigest === backdropDigest ||
      (!transparent &&
        Boolean(backdropImagePath && prevState.backdropImagePath) &&
        areStillBackdropsVisuallyEquivalent(backdropImagePath, prevState.backdropImagePath));

    if (backdropMatches) {
      const targetResKey = `${targetWidth}x${targetHeight}:${ext}`;
      const nativeResKey = `${nativeWidth}x${nativeHeight}:${ext}`;
      const savedTarget = prevState.cachedBlobs?.[targetResKey];
      if (savedTarget && isValidVideoBlobOnDisk(savedTarget, expectedFrames)) {
        return {
          cachedBlobPath: savedTarget,
          isExactTargetRes: true,
          missReason: "cached",
          matchedBackdropImagePath: prevState.backdropImagePath ?? backdropImagePath,
        };
      }
      const savedNative = prevState.cachedBlobs?.[nativeResKey];
      if (savedNative && isValidVideoBlobOnDisk(savedNative, expectedFrames)) {
        return {
          cachedBlobPath: savedNative,
          isExactTargetRes: targetWidth === nativeWidth && targetHeight === nativeHeight,
          missReason: "cached",
          matchedBackdropImagePath: prevState.backdropImagePath ?? backdropImagePath,
        };
      }
    }
  }

  if (lastDataChangeReason) {
    return {
      cachedBlobPath: null,
      isExactTargetRes: false,
      missReason: lastDataChangeReason,
    };
  }

  // Backward-compatible lookup for pre-existing `.cuthol/blobs/hf_comp_<legacyHash>` caches
  // when neither composition files nor used bridge slices have changed.
  const canTryLegacyBlobs =
    !prevState ||
    (prevState.filesHash === filesHash &&
      prevState.usedSliceHash === usedSliceHash &&
      prevState.usedGlobalHash === usedGlobalHash &&
      prevState.propsHash === propsHash &&
      prevState.durationMs === durationMs &&
      prevState.transparent === transparent &&
      prevState.mode === mode);

  if (canTryLegacyBlobs) {
    const legOut = path.join(blobsDir, `hf_comp_${legacyHash}.${ext}`);
    if (isValidVideoBlobOnDisk(legOut, expectedFrames)) {
      return {
        cachedBlobPath: legOut,
        isExactTargetRes: true,
        missReason: "cached",
        matchedBackdropImagePath: backdropImagePath,
      };
    }
    const legNat = path.join(blobsDir, `hf_comp_${legacyNativeHash}.${ext}`);
    if (isValidVideoBlobOnDisk(legNat, expectedFrames)) {
      return {
        cachedBlobPath: legNat,
        isExactTargetRes: targetWidth === nativeWidth && targetHeight === nativeHeight,
        missReason: "cached",
        matchedBackdropImagePath: backdropImagePath,
      };
    }

    const candidateDirHashes = [
      legacyDirHash,
      ...validLegacyDirHashes.filter((h) => h !== legacyDirHash),
    ];
    for (const candDirH of candidateDirHashes) {
      for (const [w, h, exact] of [
        [targetWidth, targetHeight, true] as const,
        [nativeWidth, nativeHeight, targetWidth === nativeWidth && targetHeight === nativeHeight] as const,
      ]) {
        const directCand = path.join(
          blobsDir,
          `hf_comp_${computeCandidateKey(candDirH, w, h, hashInfo.legacyBackdropDigest)}.${ext}`
        );
        if (isValidVideoBlobOnDisk(directCand, expectedFrames)) {
          return {
            cachedBlobPath: directCand,
            isExactTargetRes: exact,
            missReason: "cached",
            matchedBackdropImagePath: backdropImagePath,
          };
        }
      }
    }

    if (!transparent && backdropImagePath && fs.existsSync(blobsDir)) {
      try {
        const stillFiles = fs.readdirSync(blobsDir).filter((f) => f.startsWith("sh_still_") && f.endsWith(".png"));
        for (const candDirH of candidateDirHashes) {
          for (const [w, h, exact] of [
            [targetWidth, targetHeight, true] as const,
            [nativeWidth, nativeHeight, targetWidth === nativeWidth && targetHeight === nativeHeight] as const,
          ]) {
            for (const sf of stillFiles) {
              const sfFull = path.join(blobsDir, sf);
              let sfSize = 0;
              try {
                sfSize = fs.statSync(sfFull).size;
              } catch {
                continue;
              }
              const bd = `still:${sf}:${sfSize}`;
              const candHash = computeCandidateKey(candDirH, w, h, bd);
              const candBlob = path.join(blobsDir, `hf_comp_${candHash}.${ext}`);
              if (isValidVideoBlobOnDisk(candBlob, expectedFrames)) {
                if (
                  backdropDigest === "self-opaque" ||
                  areStillBackdropsVisuallyEquivalent(backdropImagePath, sfFull)
                ) {
                  return {
                    cachedBlobPath: candBlob,
                    isExactTargetRes: exact,
                    missReason: "cached",
                    matchedBackdropImagePath: sfFull,
                  };
                }
              }
            }
          }
        }
      } catch {
        // ignore directory scan error
      }
    }
  }

  if (prevState) {
    return { cachedBlobPath: null, isExactTargetRes: false, missReason: "backdrop_changed" };
  }

  // Determine initial miss reason when no prior state file existed
  let missReason: OverlayCacheReason = "new";
  const dataJsonPath = path.join(absCompDir, "assets/cuthol-data.json");
  if (fs.existsSync(blobsDir) && fs.existsSync(dataJsonPath)) {
    try {
      const hasAnyExistingCompBlobs = fs
        .readdirSync(blobsDir)
        .some(
          (f) =>
            f.startsWith("hf_comp_") &&
            (f.endsWith(".mp4") || f.endsWith(".mov") || f.endsWith(".pngseq"))
        );
      if (hasAnyExistingCompBlobs) {
        const htmlMtime = fs.statSync(entryPath).mtimeMs;
        const dataMtime = fs.statSync(dataJsonPath).mtimeMs;
        if (htmlMtime > dataMtime + 50) {
          missReason = "html_changed";
        }
      }
    } catch {
      // ignore
    }
  }

  return { cachedBlobPath: null, isExactTargetRes: false, missReason };
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
 * Renders a HyperFrames composition into a cached overlay blob in `blobsDir`:
 * - Mode A (`overlay_alpha`, `transparent: true`):
 *   - Default (`pngseq`): Lossless RGBA PNG directory `hf_comp_<hash>.pngseq` (`frame_%06d.png`) via
 *     `hyperframes render --format png-sequence` (zero intermediate video encode step).
 *   - Long-overlay / single-file option (`ffv1`): Lossless RGBA FFV1 `.ffv1.mov` with exact `1/fps`
 *     frame timing (`CUTHOL_ALPHA_FORMAT=ffv1` or `>= CUTHOL_ALPHA_FFV1_MIN_FRAMES`).
 *   - Legacy option (`mov`): ProRes 4444 `.mov` (`CUTHOL_ALPHA_FORMAT=mov`).
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
  const tStart = Date.now();
  const absCompDir = path.resolve(options.compositionDir);
  const compName = path.basename(absCompDir) || "main";
  const entryPath = path.join(absCompDir, options.entryHtml);
  if (!fs.existsSync(entryPath)) {
    throw new CutholError(DIAGNOSTICS.MISSING_FILE_ON_DISK("composition", entryPath));
  }

  const mode = options.mode ?? "overlay_alpha";
  const isSceneHostCandidate =
    mode === "scene_host" && Boolean(options.backdropVideoPath && fs.existsSync(options.backdropVideoPath));
  const useTrueAlpha = options.transparent && !isSceneHostCandidate;
  const durationSec = Math.max(0.1, Number((options.durationMs / 1000).toFixed(3)));
  const expectedFrames = Math.max(1, Math.round(durationSec * options.fps));
  const alphaFormat: AlphaOverlayFormat = useTrueAlpha
    ? resolveAlphaOverlayFormat(expectedFrames)
    : "mov";

  let htmlSource = fs.readFileSync(entryPath, "utf8");
  // Upgrade any legacy #00FF00 background on body/#root to true CSS `transparent` when rendering with alpha or stage backdrop
  if (
    (useTrueAlpha || options.opaqueBackdropColor || options.backdropImagePath) &&
    /(?:body|#root)\s*\{[^}]*?background\s*:\s*#00ff00\b/i.test(htmlSource)
  ) {
    htmlSource = htmlSource.replace(
      /((?:body|#root)\s*\{[^}]*?)background\s*:\s*#00ff00\b/gi,
      "$1background: transparent"
    );
    fs.writeFileSync(entryPath, htmlSource, "utf8");
  }

  const hashInfo = syncScalarVarsAndComputeCompositionHash({
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
  const { hash, scalarVars, isSceneHost, nativeWidth, nativeHeight, targetWidth, targetHeight } = hashInfo;

  fs.mkdirSync(options.blobsDir, { recursive: true });
  const ext: OverlayBlobExt = !useTrueAlpha
    ? "mp4"
    : alphaFormat === "pngseq"
      ? "pngseq"
      : alphaFormat === "ffv1"
        ? "ffv1.mov"
        : "mov";
  const outBlob = path.join(options.blobsDir, `hf_comp_${hash}.${ext}`);

  const persistStateForBlob = (resolvedBlob: string, isExactRes: boolean, matchedBackdrop?: string): void => {
    const prev = readCompositionCacheState(options.blobsDir, absCompDir);
    const cachedBlobs: Record<string, string> = { ...(prev?.cachedBlobs ?? {}) };
    const resKey = isExactRes
      ? `${targetWidth}x${targetHeight}:${ext}`
      : `${nativeWidth}x${nativeHeight}:${ext}`;
    cachedBlobs[resKey] = resolvedBlob;
    cachedBlobs[`${resKey}:${hashInfo.backdropDigest}`] = resolvedBlob;
    writeCompositionCacheState(options.blobsDir, absCompDir, {
      compositionDir: absCompDir,
      filesHash: hashInfo.filesHash,
      usedSliceHash: hashInfo.usedSliceHash,
      usedGlobalHash: hashInfo.usedGlobalHash,
      propsHash: hashInfo.propsHash,
      durationMs: options.durationMs,
      transparent: options.transparent,
      mode,
      backdropDigest: hashInfo.backdropDigest,
      backdropImagePath: matchedBackdrop ?? options.backdropImagePath,
      cachedBlobs,
    });
    clearBridgeMetaLastDataChangeReason(absCompDir);
  };

  const cacheLookup = resolveCachedCompositionVideoBlob({
    absCompDir,
    entryPath,
    blobsDir: options.blobsDir,
    ext,
    expectedFrames: useTrueAlpha && ext === "pngseq" ? expectedFrames : undefined,
    durationMs: options.durationMs,
    transparent: options.transparent,
    mode,
    backdropImagePath: options.backdropImagePath,
    hashInfo,
  });

  if (cacheLookup.cachedBlobPath) {
    if (overlayCollector) {
      return cacheLookup.cachedBlobPath;
    }
    persistStateForBlob(
      cacheLookup.cachedBlobPath,
      cacheLookup.isExactTargetRes,
      cacheLookup.matchedBackdropImagePath
    );
    const cachedMeta = readBlobMetaSummary(cacheLookup.cachedBlobPath);
    recordOverlayRenderOutcome({
      composition: compName,
      composition_dir: absCompDir,
      blob_path: cacheLookup.cachedBlobPath,
      cached: true,
      reason: "cached",
      elapsed_ms: Date.now() - tStart,
      ...cachedMeta,
    });
    return cacheLookup.cachedBlobPath;
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

  const usesPngSequenceCapture = useTrueAlpha && (alphaFormat === "pngseq" || alphaFormat === "ffv1");
  const uniqueSuffix = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tmpWorkDir = usesPngSequenceCapture
    ? path.join(options.blobsDir, `hf_tmp_${hash}_${uniqueSuffix}`)
    : null;
  if (tmpWorkDir) {
    fs.mkdirSync(tmpWorkDir, { recursive: true });
  }
  const tmpBlob = tmpWorkDir
    ? path.join(tmpWorkDir, "frames")
    : path.join(options.blobsDir, `hf_comp_${hash}.${uniqueSuffix}.tmp.${ext}`);
  const watchTargetPath = tmpWorkDir ?? tmpBlob;
  const workers = resolveHyperFramesWorkers(options.workers);

  const needsStage =
    (isSceneHost && Boolean(options.backdropVideoPath)) ||
    (!useTrueAlpha && Boolean(options.opaqueBackdropColor || options.backdropImagePath)) ||
    targetWidth !== nativeWidth ||
    targetHeight !== nativeHeight;

  let targetRenderDir = absCompDir;
  let tempSceneHostDir: string | null = null;
  let deferredToCollector = false;

  const finalizeRenderedBlob = (params: {
    usedGpu: boolean;
    gpuFallbackReason: string | null;
    elapsedMs: number;
    stdoutStr: string;
    stderrStr: string;
  }): void => {
    let frameCountMeta: number | undefined;
    let totalBytesMeta: number | undefined;

    if (usesPngSequenceCapture) {
      const pngInfo = inspectPngSequenceDir(tmpBlob);
      frameCountMeta = pngInfo.frameCount;
      totalBytesMeta = pngInfo.totalBytes;

      if (alphaFormat === "ffv1") {
        const tmpFfv1 = path.join(tmpWorkDir!, "alpha.ffv1.mov");
        const packProc = spawnWatchedSync(
          "ffmpeg",
          [
            "-y",
            "-v",
            "error",
            "-framerate",
            String(options.fps),
            "-start_number",
            "1",
            "-i",
            path.join(tmpBlob, "frame_%06d.png"),
            "-c:v",
            "ffv1",
            "-level",
            "3",
            "-coder",
            "1",
            "-context",
            "1",
            "-g",
            "1",
            "-pix_fmt",
            "rgba",
            "-r",
            String(options.fps),
            "-video_track_timescale",
            String(Math.round(options.fps * 1000)),
            tmpFfv1,
          ],
          {
            encoding: "utf8",
            step: `ffmpeg pack ffv1 (${compName})`,
            watchedPaths: [tmpFfv1],
            cleanupPathsOnStall: [tmpFfv1],
          }
        );
        if (packProc.status !== 0 || !isValidVideoBlobOnDisk(tmpFfv1)) {
          throw new CutholError(
            DIAGNOSTICS.HYPERFRAMES_RENDER_FAILED(
              options.compositionDir,
              `FFV1 alpha paketleme başarısız oldu: ${(packProc.stderr || "").trim().slice(-200)}`
            )
          );
        }
        if (fs.existsSync(outBlob)) {
          fs.rmSync(outBlob, { recursive: true, force: true });
        }
        renameWithRetrySync(tmpFfv1, outBlob);
        totalBytesMeta = fs.statSync(outBlob).size;
      } else {
        renameWithRetrySync(tmpBlob, outBlob);
      }
    } else {
      renameWithRetrySync(tmpBlob, outBlob);
      try {
        totalBytesMeta = fs.statSync(outBlob).size;
      } catch {
        // ignore
      }
    }

    const hfSummaryInfo = parseHyperFramesPipelineSummary(params.stdoutStr, params.stderrStr);
    const metaEncoder = !useTrueAlpha
      ? params.usedGpu
        ? "h264_nvenc"
        : "libx264"
      : alphaFormat === "pngseq"
        ? "png-sequence"
        : alphaFormat === "ffv1"
          ? "ffv1"
          : "prores_ks";

    try {
      fs.writeFileSync(
        `${outBlob}.meta.json`,
        JSON.stringify(
          {
            encoder: metaEncoder,
            format: ext,
            ...(frameCountMeta !== undefined ? { frame_count: frameCountMeta } : {}),
            ...(totalBytesMeta !== undefined ? { size_bytes: totalBytesMeta } : {}),
            gpu_fallback_reason: params.gpuFallbackReason,
            workers,
            width: targetWidth,
            height: targetHeight,
            hf_summary: hfSummaryInfo.hf_summary,
            capture_mode: hfSummaryInfo.capture_mode,
            gpu_mode: hfSummaryInfo.gpu_mode,
            streaming_encode: hfSummaryInfo.streaming_encode,
            stages_sec: hfSummaryInfo.stages_sec,
          },
          null,
          2
        ),
        "utf8"
      );
    } catch {
      // non-blocking metadata write
    }
    persistStateForBlob(outBlob, true, options.backdropImagePath);
    recordOverlayRenderOutcome({
      composition: compName,
      composition_dir: absCompDir,
      blob_path: outBlob,
      cached: false,
      reason: cacheLookup.missReason,
      elapsed_ms: params.elapsedMs,
      ...hfSummaryInfo,
    });
    if (useTrueAlpha) {
      recordCompositionAlphaBboxSidecar(absCompDir, outBlob, durationSec * 0.5);
    }
  };

  try {
    if (overlayCollector && overlayCollector.some((j) => j.outBlob === outBlob)) {
      return outBlob;
    }

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
        transparent: useTrueAlpha,
        opaqueBackdropColor: options.opaqueBackdropColor,
        backdropImagePath: options.backdropImagePath,
      });
      targetRenderDir = tempSceneHostDir;
    }

    // HyperFrames' own GPU encode gives no measurable speed-up here (frame capture dominates) and its rate
    // control is not configurable from outside, so it is only used when asked for explicitly.
    const wantGpu = !useTrueAlpha && options.useGpu === true;
    const isDraftScale = targetWidth <= 854 && targetHeight <= 854 && (targetWidth < nativeWidth || targetHeight < nativeHeight);
    const effectiveCrf = options.crf ?? (isDraftScale ? 24 : wantGpu ? 22 : 19);

    const buildRenderArgs = (withGpu: boolean): string[] => {
      const hfFormat = !useTrueAlpha
        ? "mp4"
        : usesPngSequenceCapture
          ? "png-sequence"
          : "mov";
      const args = [
        hfBin,
        "render",
        targetRenderDir,
        "--format",
        hfFormat,
        "--quality",
        isSceneHost || (!useTrueAlpha && !isDraftScale) ? "looks" : "draft",
        "--workers",
        String(workers),
        "--output",
        tmpBlob,
      ];
      if (!useTrueAlpha) {
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
    const expectedFramesCheck = usesPngSequenceCapture ? expectedFrames : undefined;

    if (overlayCollector) {
      const stageDirToClean = tempSceneHostDir;
      const workDirToClean = tmpWorkDir;
      overlayCollector.push({
        compName,
        compositionDir: options.compositionDir,
        absCompDir,
        outBlob,
        tmpBlob,
        watchTargetPath,
        expectedFrames: expectedFramesCheck,
        args: renderArgs,
        fallbackNoGpuArgs: wantGpu ? buildRenderArgs(false) : null,
        wantGpu,
        workers,
        stageDirToClean,
        finalizeSuccess: finalizeRenderedBlob,
        cleanupTemp: () => {
          if (workDirToClean && fs.existsSync(workDirToClean)) {
            try {
              fs.rmSync(workDirToClean, { recursive: true, force: true });
            } catch {
              // ignore
            }
          } else if (fs.existsSync(tmpBlob)) {
            try {
              fs.rmSync(tmpBlob, { recursive: true, force: true });
            } catch {
              // ignore
            }
          }
          if (stageDirToClean && fs.existsSync(stageDirToClean)) {
            try {
              fs.rmSync(stageDirToClean, { recursive: true, force: true });
            } catch {
              // ignore
            }
          }
        },
      });
      deferredToCollector = true;
      return outBlob;
    }

    // No wall-clock limit: render time grows with composition length (long videos take hours).
    // A large output buffer keeps progress logging of long renders from killing the process (ENOBUFS).
    const hfProc = spawnWatchedSync(process.execPath, renderArgs, {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      step: "hyperframes render",
      watchedPaths: [watchTargetPath],
      cleanupPathsOnStall: [watchTargetPath],
    });
    let finalHfProc = hfProc;
    let usedGpu = wantGpu;
    let gpuFallbackReason: string | null = null;

    if (
      wantGpu &&
      (finalHfProc.status !== 0 || !isValidVideoBlobOnDisk(tmpBlob, expectedFramesCheck))
    ) {
      usedGpu = false;
      gpuFallbackReason = finalHfProc.stalled
        ? "stalled"
        : "HyperFrames GPU encode failed; retried with libx264";
      if (fs.existsSync(tmpBlob)) {
        try {
          fs.rmSync(tmpBlob, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      finalHfProc = spawnWatchedSync(process.execPath, buildRenderArgs(false), {
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
        step: "hyperframes render",
        watchedPaths: [watchTargetPath],
        cleanupPathsOnStall: [watchTargetPath],
      });
    }

    if (hfProc.status === 0 || finalHfProc.status === 0) {
      if (isValidVideoBlobOnDisk(tmpBlob, expectedFramesCheck)) {
        finalizeRenderedBlob({
          usedGpu,
          gpuFallbackReason,
          elapsedMs: Date.now() - tStart,
          stdoutStr: String(finalHfProc.stdout || ""),
          stderrStr: String(finalHfProc.stderr || ""),
        });
        return outBlob;
      }
    }

    throw buildHyperFramesFailureError(options.compositionDir, renderArgs, finalHfProc);
  } finally {
    if (!deferredToCollector) {
      if (tmpWorkDir && fs.existsSync(tmpWorkDir)) {
        try {
          fs.rmSync(tmpWorkDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      } else if (fs.existsSync(tmpBlob)) {
        try {
          fs.rmSync(tmpBlob, { recursive: true, force: true });
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
}

export function resolveFramePngInPngSequenceDir(dirPath: string, frameIdx: number): string | null {
  try {
    if (!isPngSequenceBlobDir(dirPath) || !fs.existsSync(dirPath)) return null;
    const directCandidate = path.join(dirPath, `frame_${String(frameIdx + 1).padStart(6, "0")}.png`);
    if (fs.existsSync(directCandidate) && fs.statSync(directCandidate).size > 64) {
      return directCandidate;
    }
    const pngNames = fs
      .readdirSync(dirPath)
      .filter((name) => /^frame_\d+\.png$/i.test(name))
      .sort();
    if (pngNames.length === 0) return null;
    const clampedIdx = Math.max(0, Math.min(pngNames.length - 1, frameIdx));
    const fallbackCandidate = path.join(dirPath, pngNames[clampedIdx]);
    return fs.existsSync(fallbackCandidate) && fs.statSync(fallbackCandidate).size > 64
      ? fallbackCandidate
      : null;
  } catch {
    return null;
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

  if (isPngSequenceBlobDir(videoPath)) {
    const srcFramePng = resolveFramePngInPngSequenceDir(videoPath, frameIdx);
    if (!srcFramePng) return false;
    if (!scaleToWidth || !scaleToHeight) {
      try {
        fs.copyFileSync(srcFramePng, tmpPng);
        if (fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 64) {
          fs.renameSync(tmpPng, outPng);
          return true;
        }
      } catch {
        // fall through
      }
    } else {
      const scaleProc = spawnWatchedSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-i",
          srcFramePng,
          "-vf",
          `scale=${scaleToWidth}:${scaleToHeight}:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba`,
          "-frames:v",
          "1",
          tmpPng,
        ],
        {
          encoding: "utf8",
          step: "ffmpeg scale pngseq frame",
          watchedPaths: [tmpPng],
          cleanupPathsOnStall: [tmpPng],
        }
      );
      if (scaleProc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 64) {
        fs.renameSync(tmpPng, outPng);
        return true;
      }
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

  const seekSec = (frameIdx / fps).toFixed(6);
  const vfBase =
    scaleToWidth && scaleToHeight
      ? `scale=${scaleToWidth}:${scaleToHeight},format=rgba`
      : "format=rgba";
  const seekProc = spawnWatchedSync(
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
    {
      encoding: "utf8",
      step: "ffmpeg extract blob frame",
      watchedPaths: [tmpPng],
      cleanupPathsOnStall: [tmpPng],
    }
  );
  if (seekProc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 200) {
    fs.renameSync(tmpPng, outPng);
    return true;
  }
  const extProc = spawnWatchedSync(
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
    {
      encoding: "utf8",
      step: "ffmpeg extract blob frame",
      watchedPaths: [tmpPng],
      cleanupPathsOnStall: [tmpPng],
    }
  );
  if (extProc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 200) {
    fs.renameSync(tmpPng, outPng);
    return true;
  }
  // Fallback to last frame (`-sseof -0.1`) if `frameIdx` exceeded encoded frame count by 1
  const eofProc = spawnWatchedSync(
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
    {
      encoding: "utf8",
      step: "ffmpeg extract blob frame",
      watchedPaths: [tmpPng],
      cleanupPathsOnStall: [tmpPng],
    }
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

  const hashInfo = syncScalarVarsAndComputeCompositionHash({
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
  const { hash, nativeHash, legacyHash, isSceneHost, nativeWidth, nativeHeight, targetWidth, targetHeight } =
    hashInfo;

  fs.mkdirSync(options.blobsDir, { recursive: true });
  const outPng = path.join(options.blobsDir, `hf_frame_${hash}_f${frameIdx}.png`);
  if (fs.existsSync(outPng) && fs.statSync(outPng).size > 200) {
    if (options.transparent && !isSceneHost) {
      recordCompositionAlphaBboxSidecar(absCompDir, outPng);
    }
    return { pngPath: outPng, snappedSec, frameIdx };
  }
  const legPng = path.join(options.blobsDir, `hf_frame_${legacyHash}_f${frameIdx}.png`);
  if (legacyHash !== hash && fs.existsSync(legPng) && fs.statSync(legPng).size > 200) {
    if (options.transparent && !isSceneHost) {
      recordCompositionAlphaBboxSidecar(absCompDir, legPng);
    }
    return { pngPath: legPng, snappedSec, frameIdx };
  }

  for (const candExt of ["pngseq", "ffv1.mov", "mov", "mp4"] as const) {
    const resolved = resolveCachedCompositionVideoBlob({
      absCompDir,
      entryPath,
      blobsDir: options.blobsDir,
      ext: candExt,
      expectedFrames: candExt === "pngseq" ? totalFrames : undefined,
      durationMs: options.durationMs,
      transparent: candExt !== "mp4",
      mode,
      backdropImagePath: options.backdropImagePath,
      hashInfo,
    });
    if (resolved.cachedBlobPath) {
      const extracted = resolved.isExactTargetRes
        ? extractFrameFromVideoBlob(resolved.cachedBlobPath, frameIdx, options.fps, outPng)
        : extractFrameFromVideoBlob(
            resolved.cachedBlobPath,
            frameIdx,
            options.fps,
            outPng,
            targetWidth,
            targetHeight
          );
      if (extracted) {
        if (options.transparent && !isSceneHost && !resolved.cachedBlobPath.endsWith(".mp4")) {
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
      const snapProc = spawnWatchedSync(
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
        {
          encoding: "utf8",
          step: "hyperframes snapshot",
          watchedPaths: [tmpSnapDir],
          cleanupPathsOnStall: [tmpSnapDir],
        }
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

  const findValidBlobForHash = (h: string): string | null => {
    for (const ext of ["pngseq", "ffv1.mov", "mov", "mp4"] as const) {
      const cand = path.join(options.blobsDir, `hf_comp_${h}.${ext}`);
      if (isValidVideoBlobOnDisk(cand, ext === "pngseq" ? totalFrames : undefined)) {
        return cand;
      }
    }
    return null;
  };

  let scaleW: number | undefined;
  let scaleH: number | undefined;
  let videoToExtract = findValidBlobForHash(hash);
  if (!videoToExtract && nativeHash !== hash) {
    const nativeBlob = findValidBlobForHash(nativeHash);
    if (nativeBlob) {
      videoToExtract = nativeBlob;
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

      const snapProc = spawnWatchedSync(
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
        {
          encoding: "utf8",
          step: "hyperframes snapshot",
          watchedPaths: [tmpSnapDir],
          cleanupPathsOnStall: [tmpSnapDir],
        }
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
    let effectiveMediaPath = mediaPath;
    if (isPngSequenceBlobDir(mediaPath)) {
      const info = inspectPngSequenceDir(mediaPath);
      if (!info.valid || info.frameCount <= 0) return null;
      const midIdx = Math.floor(info.frameCount / 2);
      const midPng = resolveFramePngInPngSequenceDir(mediaPath, midIdx);
      if (!midPng) return null;
      effectiveMediaPath = midPng;
    }
    const probeW = 320;
    const probeH = 180;
    const args: string[] = ["-v", "error"];
    if (atSec !== undefined && atSec > 0 && !effectiveMediaPath.endsWith(".png")) {
      args.push("-ss", atSec.toFixed(3));
    }
    args.push(
      "-i",
      effectiveMediaPath,
      "-vf",
      `scale=${probeW}:${probeH}:flags=neighbor:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1"
    );
    const proc = spawnWatchedSync("ffmpeg", args, {
      maxBuffer: probeW * probeH * 4 + 65536,
      step: "ffmpeg alpha bbox",
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
