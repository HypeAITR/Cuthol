// Composition coordinate extraction: browser measurement orchestration, cache, and summaries.
//
// One Chrome process (`puppeteer-core`), a fresh page per composition, measured against the
// same HTML render serves (locally bundled fonts). Every frame is discovered and measured in
// a single in-page loop per chunk; results stream back to Node chunk by chunk. Measured local
// (composition-pixel) boxes are cached; stage-pixel summaries and queried frames are mapped
// from cache with the cue's current placement, so placement edits never re-measure.
// Elements also carry their measured ancestor (`parent`) and design group (`group`); frames
// carry glyph/pixel ink boxes (`ink`) wherever they differ from the item box.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer, { Browser, Page } from "puppeteer-core";
import { CutholError, CutholDiagnostic, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence, LaneCue } from "../core/schema.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import { resolveCueStartMs } from "../core/timeline.js";
import { loadSequence, WorkspacePaths } from "../core/workspace.js";
import { syncCompositionBridgeFiles } from "./bridge_exporter.js";
import {
  analyzeCompositionDataUsage,
  computeUsedBridgePayloadHashes,
  hashCompositionFilesExcludingBridgeData,
} from "./bridge_hash.js";
import {
  computeCoordsCacheKey,
  COORDS_ENGINE_VERSION,
  COORDS_SCHEMA,
  coordsCachePath,
  readCoordsCache,
  writeCoordsCache,
} from "./coords_cache.js";
import {
  CoordsInpageElement,
  CoordsInpageFrame,
  coordsInpageInstall,
  coordsInpageSetInkData,
  coordsLoopRun,
} from "./coords_inpage.js";
import { resolveImageFileInkMargins } from "./coords_ink.js";
import {
  CoordsBox,
  mapLocalBoxToStage,
  roundBox1,
  unionStageBoxes,
} from "./coords_map.js";
import {
  findLocalHyperFramesCliMjs,
  readInvokedHyperFramesVersion,
} from "./hf_common.js";
import { syncScalarVarsAndComputeCompositionHash } from "./hf_cache_state.js";
import {
  buildScriptErrorRecord,
  CompositionScriptError,
  CompositionScriptRecord,
  parsePageErrorLocation,
  readScriptErrorRecord,
  writeScriptErrorRecord,
} from "./hf_script_errors.js";

/**
 * Element rows per cue in the envelope summary; the full list lives in the cache file.
 * `--all` returns counts only (a 30-cue project stays short); a `--cue` query lists the elements.
 */
export const COORDS_SUMMARY_ITEMS_PER_CUE = 40;
export const COORDS_SUMMARY_ITEMS_ALL = 0;

export interface CoordsDocElement {
  key: string;
  kind: string;
  label: string;
  /** Index of the nearest measured ancestor element (absent = none). */
  parent?: number;
  /**
   * Index of the element that owns this element's design group: the nearest measured ancestor that
   * paints (background, border or shadow) and is not stage-sized. Elements that share a group were
   * laid out together (a card and its own text); rules do not report overlap inside one group.
   */
  group?: number;
}

export type CoordsDocItem = [number, number, number, number, number, number, number];

/**
 * Ink box of one element in one frame: `[elementIndex, x, y, w, h]` in composition pixels.
 * Text: union of the glyph ink of its lines (not the line box). Image: the box minus the asset's
 * transparent margins. Present only when it differs from the item box by more than 0.5 px.
 */
export type CoordsDocInk = [number, number, number, number, number];

/**
 * Rotated corners of one element in one frame: `[elementIndex, x1, y1, x2, y2, x3, y3, x4, y4]`
 * in composition pixels. Present only for elements with a non-trivial 2D transform chain;
 * geometry queries intersect these quads (falling back to boxes where absent).
 */
export type CoordsDocQuad = [number, number, number, number, number, number, number, number, number];

export interface CoordsDocFrame {
  f: number;
  items: CoordsDocItem[];
  ink?: CoordsDocInk[];
  quads?: CoordsDocQuad[];
  ink_quads?: CoordsDocQuad[];
}

export interface CoordsDocument {
  /** Written as the current schema; readers accept `/1` too (ink/parent/group absent). */
  schema: "cuthol.coords/1" | "cuthol.coords/2";
  cue_id: string;
  composition: string;
  composition_dir: string;
  width: number;
  height: number;
  fps: number;
  frame_count: number;
  cue_duration_ms: number;
  sequence_start_frame: number;
  stage: { width: number; height: number; fps: number };
  mapping: {
    composition_size: { width: number; height: number };
    stage_size: { width: number; height: number };
    placement_at_measure: LaneCue["placement"];
    placement_envelopes: string[];
    note: string;
  };
  engine_version: string;
  hyperframes_version: string;
  fonts_bundled: boolean;
  /** sha256 of `cuthol.sequence.json` bytes at measure time; guards the no-sync fast path. */
  sequence_digest: string;
  elements: CoordsDocElement[];
  frames: CoordsDocFrame[];
}

export interface CoordsSummaryItem {
  key: string;
  kind: string;
  label: string;
  frames: [number, number];
  box: [number, number, number, number];
}

export interface CoordsQueriedFrame {
  sequence_frame: number;
  local_frame: number;
  boxes: Array<{ key: string; kind: string; box: [number, number, number, number] }>;
}

export interface CoordsCueResult {
  cue: string;
  composition: string;
  frames: number;
  cached: boolean;
  ms: number;
  elements: number;
  file: string;
  items: CoordsSummaryItem[];
  items_total: number;
  queried_frames?: CoordsQueriedFrame[];
}

export interface CoordsSkippedCue {
  cue: string;
  reason: string;
}

export interface CoordsRunResult {
  cues: CoordsCueResult[];
  skipped_cues: CoordsSkippedCue[];
  warnings: CutholDiagnostic[];
  cues_total: number;
  cues_measured: number;
  cues_cached: number;
  cues_skipped: number;
}

let coordsBrowserLaunchCount = 0;

/** Test hook: how many browser processes this module launched. */
export function getCoordsBrowserLaunchCount(): number {
  return coordsBrowserLaunchCount;
}

/** Test hook: reset the browser launch counter. */
export function resetCoordsBrowserLaunchCount(): void {
  coordsBrowserLaunchCount = 0;
}

/**
 * Parses the frame selector (`--frames a..b` xor `--at sn[,sn...]`, sequence frames).
 * Returns null when neither is given (summary only). Throws on misuse.
 */
export function parseCoordsFrameSelector(
  framesRaw: string | undefined,
  atRaw: string | undefined
): number[] | null {
  if (framesRaw !== undefined && atRaw !== undefined) {
    throw new CutholError(
      DIAGNOSTICS.UNKNOWN_FLAG(
        "--frames + --at",
        "composition.coords",
        "cuthol composition coords --cue <cue_XX> --frames <a..b>"
      )
    );
  }
  if (framesRaw !== undefined) {
    const m = /^(\d+)\.\.(\d+)$/.exec(framesRaw.trim());
    if (!m || Number(m[1]) > Number(m[2])) {
      throw new CutholError(
        DIAGNOSTICS.UNKNOWN_FLAG(
          `--frames ${framesRaw}`,
          "composition.coords",
          "cuthol composition coords --cue <cue_XX> --frames <a..b>"
        )
      );
    }
    const out: number[] = [];
    for (let f = Number(m[1]); f <= Number(m[2]); f++) out.push(f);
    return out;
  }
  if (atRaw !== undefined) {
    const parts = atRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) {
      throw new CutholError(
        DIAGNOSTICS.UNKNOWN_FLAG(
          `--at ${atRaw}`,
          "composition.coords",
          "cuthol composition coords --cue <cue_XX> --at <sn>[,<sn>...]"
        )
      );
    }
    return [...new Set(parts.map(Number))].sort((x, y) => x - y);
  }
  return null;
}

export interface CompositionMeta {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
}

/** Reads the composition's own pixel size; fps/frame count come from the stage and cue. */
export function readCompositionPixelSize(
  compDir: string,
  entryHtml: string
): { width: number; height: number } | null {
  try {
    const html = fs.readFileSync(path.join(compDir, entryHtml), "utf8");
    const w = html.match(/\bdata-width\s*=\s*["'](\d+)["']/i);
    const h = html.match(/\bdata-height\s*=\s*["'](\d+)["']/i);
    if (!w || !h) return null;
    const width = Number(w[1]);
    const height = Number(h[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  } catch {
    return null;
  }
}

let cachedChromePath: string | null = null;

/** Chrome executable via the renderer's public command (`browser path`, `ensure` when needed). */
export function resolveCoordsChromePath(): string {
  if (cachedChromePath && fs.existsSync(cachedChromePath)) return cachedChromePath;
  const hfBin = findLocalHyperFramesCliMjs();
  const readPath = (): string | null => {
    try {
      const proc = spawnWatchedSync(process.execPath, [hfBin, "browser", "path"], {
        encoding: "utf8",
        step: "hyperframes browser path",
      });
      const line = String(proc.stdout || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.length > 0);
      if (line && fs.existsSync(line)) return line;
    } catch {
      // fall through to ensure
    }
    return null;
  };
  let exe = readPath();
  if (!exe) {
    spawnWatchedSync(process.execPath, [hfBin, "browser", "ensure"], {
      encoding: "utf8",
      step: "hyperframes browser ensure",
    });
    exe = readPath();
  }
  if (!exe) throw new Error("Chrome executable not found via 'hyperframes browser path'.");
  cachedChromePath = exe;
  return exe;
}

type FontBundlerFn = (compDir: string) => Promise<string>;

function findFontBundlerModulePath(): string | null {
  const cliDir = path.dirname(findLocalHyperFramesCliMjs());
  const distDir = path.resolve(cliDir, "..", "dist");
  let entries: string[];
  try {
    entries = fs.readdirSync(distDir);
  } catch {
    return null;
  }
  const name = entries.find((f) => /^bundleWithLocalizedFonts-.*\.js$/.test(f));
  return name ? path.join(distDir, name) : null;
}

/**
 * Resolves the renderer's internal font-bundling module (no public command writes the
 * packaged HTML to disk). Throws when the module cannot be found or loaded, so a
 * renderer upgrade that moves it fails loudly (the caller falls back to raw HTML).
 */
export async function resolveCoordsFontBundler(): Promise<FontBundlerFn> {
  const modPath = findFontBundlerModulePath();
  if (!modPath) {
    throw new Error(
      `font bundler module not found in renderer dist (version ${readInvokedHyperFramesVersion()})`
    );
  }
  const mod = (await import(pathToFileURL(modPath).href)) as {
    bundleWithLocalizedFonts?: unknown;
  };
  if (typeof mod.bundleWithLocalizedFonts !== "function") {
    throw new Error(`font bundler export missing in ${path.basename(modPath)}`);
  }
  return mod.bundleWithLocalizedFonts as FontBundlerFn;
}

/** Launches the shared measurement browser (exported for the script-error probe). */
export async function launchScriptProbeBrowser(): Promise<Browser> {
  return launchCoordsBrowser();
}

async function launchCoordsBrowser(): Promise<Browser> {
  coordsBrowserLaunchCount++;
  return puppeteer.launch({
    executablePath: resolveCoordsChromePath(),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--force-device-scale-factor=1",
      "--mute-audio",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-gpu-compositing",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
}

const COORDS_MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

function startCoordsStaticServer(
  rootDir: string,
  entryHtml: string,
  bundledHtml: string | null
): Promise<{ server: http.Server; url: string }> {
  const root = path.resolve(rootDir);
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url || "/", "http://x").pathname);
      if (bundledHtml && (urlPath === "/" || urlPath === `/${entryHtml}`)) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(bundledHtml);
        return;
      }
      const file = path.normalize(
        path.join(root, urlPath === "/" ? entryHtml : urlPath.replace(/^\//, ""))
      );
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end("no");
        return;
      }
      const size = fs.statSync(file).size;
      const type = COORDS_MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
      const rangeHeader = req.headers.range;
      const range =
        typeof rangeHeader === "string" ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null;
      if (range) {
        const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
        const end = range[2] === "" ? size - 1 : Math.min(size - 1, Number(range[2]));
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
          res.writeHead(416, { "content-range": `bytes */${size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          "content-type": type,
          "accept-ranges": "bytes",
          "content-range": `bytes ${start}-${end}/${size}`,
          "content-length": String(end - start + 1),
        });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, {
        "content-type": type,
        "accept-ranges": "bytes",
        "content-length": String(size),
      });
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(500);
      res.end("err");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/${entryHtml}` });
    });
  });
}

interface OpenedComposition {
  page: Page;
  server: http.Server;
  errors: string[];
  elements: CoordsInpageElement[];
  /** Structured page issues with load/run phase (kept alongside `errors` for records). */
  issues: Array<{ phase: "load" | "run"; kind: "pageerror" | "console"; text: string; err: unknown }>;
  /** Flips to `run` once page load settles; listeners tag new issues with it. */
  phaseRef: { phase: "load" | "run" };
}

async function openCompositionPage(
  browser: Browser,
  compDir: string,
  entryHtml: string,
  meta: CompositionMeta,
  bundledHtml: string | null
): Promise<OpenedComposition> {
  const { server, url } = await startCoordsStaticServer(compDir, entryHtml, bundledHtml);
  const page = await browser.newPage();
  const errors: string[] = [];
  const issues: OpenedComposition["issues"] = [];
  const phaseRef: OpenedComposition["phaseRef"] = { phase: "load" };
  page.on("pageerror", (e) => {
    const text = `pageerror: ${String((e as Error)?.message || e).slice(0, 300)}`;
    errors.push(text);
    issues.push({ phase: phaseRef.phase, kind: "pageerror", text, err: e });
  });
  page.on("console", (m) => {
    try {
      if (m.type() === "error") {
        const text = `console: ${m.text().slice(0, 300)}`;
        errors.push(text);
        issues.push({ phase: phaseRef.phase, kind: "console", text, err: null });
      }
    } catch {
      // ignore listener failure
    }
  });
  try {
    await page.evaluateOnNewDocument("window.__timelines = window.__timelines || {};");
    // Puppeteer does not reliably surface unhandled promise rejections as `pageerror`
    // on every version, so the page records them itself (drained after the run).
    await page.evaluateOnNewDocument(`(() => {
      const w = window;
      w.__cutholRejections = [];
      w.addEventListener("unhandledrejection", (ev) => {
        try {
          const list = w.__cutholRejections;
          if (Array.isArray(list) && list.length < 10) {
            const reason = ev && ev.reason !== undefined ? ev.reason : "rejected";
            const text = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
            list.push({ t: Date.now(), text: String(text).slice(0, 500) });
          }
        } catch {
          // ignore recorder failure
        }
      });
    })();`);
    await page.setViewport({
      width: meta.width,
      height: meta.height,
      deviceScaleFactor: 1,
    });
    const resp = await page.goto(url, { waitUntil: "load", timeout: 30000 });
    if (!resp || !resp.ok()) {
      throw new Error(`composition page HTTP ${resp ? resp.status() : "no-response"}`);
    }
    await page
      .evaluate(async () => {
        try {
          await Promise.all(
            Array.from(document.images, (im) => im.decode().catch(() => undefined))
          );
        } catch {
          // ignore
        }
        try {
          await Promise.race([
            document.fonts.ready,
            new Promise((r) => setTimeout(r, 2000)),
          ]);
        } catch {
          // ignore
        }
      })
      .catch(() => undefined);
    const discovered = (await page.evaluate(coordsInpageInstall, {
      w: meta.width,
      h: meta.height,
    })) as CoordsInpageElement[];
    phaseRef.phase = "run";
    return { page, server, errors, elements: discovered ?? [], issues, phaseRef };
  } catch (err) {
    try {
      await page.close({ runBeforeUnload: false });
    } catch {
      // ignore
    }
    try {
      server.close();
    } catch {
      // ignore
    }
    throw err;
  }
}

async function closeCompositionPage(opened: OpenedComposition): Promise<void> {
  try {
    await opened.page.close({ runBeforeUnload: false });
  } catch {
    // ignore
  }
  try {
    opened.server.close();
  } catch {
    // ignore
  }
}

/** Serialized into the page: reports whether the main timeline registered. */
function inpageTimelineStatus(): { expected: boolean; registered: boolean } {
  const w = window as unknown as Record<string, unknown>;
  const root =
    document.querySelector('[data-composition-id="main"]') ||
    document.querySelector("[data-composition-id]");
  const id = root ? root.getAttribute("data-composition-id") : null;
  const expected = root ? !root.hasAttribute("data-no-timeline") : true;
  const tls = (w.__timelines || {}) as Record<string, unknown>;
  const key = id || "main";
  const tl = tls[key];
  return { expected, registered: tl !== undefined && tl !== null };
}

async function readTimelineStatus(page: Page): Promise<{ expected: boolean; registered: boolean }> {
  try {
    const res = (await page.evaluate(inpageTimelineStatus)) as {
      expected: boolean;
      registered: boolean;
    };
    return { expected: res.expected !== false, registered: res.registered === true };
  } catch {
    return { expected: true, registered: false };
  }
}

interface RecordedRejection {
  t: number;
  text: string;
}

async function drainRecordedRejections(page: Page): Promise<RecordedRejection[]> {
  try {
    const recs = (await page.evaluate(
      `(() => {
        const w = window;
        const list = Array.isArray(w.__cutholRejections) ? w.__cutholRejections.slice(0, 10) : [];
        w.__cutholRejections = [];
        return list;
      })();`
    )) as Array<{ t: unknown; text: unknown }>;
    return recs
      .filter((r) => r && typeof r.text === "string")
      .map((r) => ({ t: typeof r.t === "number" ? r.t : 0, text: String(r.text) }));
  } catch {
    return [];
  }
}

/**
 * Merges a page run's listener issues and recorded rejections into structured script
 * errors. `loadEndMs` (node clock) splits load-phase from run-phase rejections.
 */
export function collectPageScriptErrors(
  issues: Array<{ phase: "load" | "run"; kind: "pageerror" | "console"; text: string; err: unknown }>,
  rejections: RecordedRejection[],
  loadEndMs: number
): CompositionScriptError[] {
  const out: CompositionScriptError[] = [];
  for (const it of issues) {
    const text = it.text.replace(/^(pageerror|console):\s*/, "");
    if (!text.trim()) continue;
    const loc = it.kind === "pageerror" ? parsePageErrorLocation(it.err) : {};
    out.push({
      phase: it.phase,
      kind: it.kind === "pageerror" ? "pageerror" : "console",
      text,
      ...loc,
    });
  }
  for (const r of rejections) {
    const firstLine = r.text.split("\n")[0].trim() || "unhandled promise rejection";
    out.push({
      phase: r.t > 0 && r.t < loadEndMs ? "load" : "run",
      kind: "rejection",
      text: firstLine,
      ...parsePageErrorLocation(r.text),
    });
  }
  return out;
}

/** Tool tag binding script-error records to the measuring renderer version. */
export function scriptErrorToolTag(): string {
  try {
    return `hf:${readInvokedHyperFramesVersion()}`;
  } catch {
    return "hf:unknown";
  }
}

/**
 * Reads the script-error record matching the CURRENT composition files (null when
 * unknown — never "clean"). Pure reads, no browser: this is what `verify` uses.
 */
export function readCurrentScriptErrorRecord(
  projectDir: string,
  absCompDir: string,
  entryHtml: string
): CompositionScriptRecord | null {
  try {
    const filesHash = hashCompositionFilesExcludingBridgeData(absCompDir);
    return readScriptErrorRecord(projectDir, filesHash, entryHtml, scriptErrorToolTag());
  } catch {
    return null;
  }
}

/**
 * Writes a script-error record for the current composition files (best effort) and
 * returns it, so the caller can turn it into diagnostics without re-reading.
 */
export function writeCurrentScriptErrorRecord(
  projectDir: string,
  params: {
    absCompDir: string;
    entryHtml: string;
    source: CompositionScriptRecord["source"];
    timelineExpected: boolean;
    timelineRegistered: boolean;
    errors: CompositionScriptError[];
  }
): CompositionScriptRecord {
  const toolTag = scriptErrorToolTag();
  const record = buildScriptErrorRecord({
    filesHash: hashCompositionFilesExcludingBridgeData(params.absCompDir),
    entryHtml: params.entryHtml,
    toolTag,
    source: params.source,
    timelineExpected: params.timelineExpected,
    timelineRegistered: params.timelineRegistered,
    errors: params.errors,
  });
  writeScriptErrorRecord(projectDir, record, toolTag);
  return record;
}

export interface ScriptProbeOptions {
  compDir: string;
  entryHtml: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  /** Shared browser; when absent the probe launches and closes its own. */
  browser?: Browser;
}

export interface ScriptProbeResult {
  errors: CompositionScriptError[];
  timelineExpected: boolean;
  timelineRegistered: boolean;
  ms: number;
}

/**
 * Lightweight composition page probe: loads the raw page (no font bundling, no frame
 * loop), polls for timeline registration, then seeks three timeline samples so
 * `tl.call` callbacks fire the way render seeks fire them. Used by `monitor` and
 * `preview` when no record matches the current files; the caller stores the result.
 */
export async function probeCompositionScriptErrors(
  options: ScriptProbeOptions
): Promise<ScriptProbeResult> {
  const t0 = Date.now();
  const { server, url } = await startCoordsStaticServer(options.compDir, options.entryHtml, null);
  const browser = options.browser ?? (await launchCoordsBrowser());
  const ownBrowser = options.browser === undefined;
  const page = await browser.newPage();
  const issues: Array<{ phase: "load" | "run"; kind: "pageerror" | "console"; text: string; err: unknown }> = [];
  const phaseRef = { phase: "load" as "load" | "run" };
  page.on("pageerror", (e) => {
    const text = `pageerror: ${String((e as Error)?.message || e).slice(0, 300)}`;
    issues.push({ phase: phaseRef.phase, kind: "pageerror", text, err: e });
  });
  page.on("console", (m) => {
    try {
      if (m.type() === "error") {
        issues.push({ phase: phaseRef.phase, kind: "console", text: `console: ${m.text().slice(0, 300)}`, err: null });
      }
    } catch {
      // ignore listener failure
    }
  });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  try {
    await page.evaluateOnNewDocument("window.__timelines = window.__timelines || {};");
    await page.evaluateOnNewDocument(`(() => {
      const w = window;
      w.__cutholRejections = [];
      w.addEventListener("unhandledrejection", (ev) => {
        try {
          const list = w.__cutholRejections;
          if (Array.isArray(list) && list.length < 10) {
            const reason = ev && ev.reason !== undefined ? ev.reason : "rejected";
            const text = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
            list.push({ t: Date.now(), text: String(text).slice(0, 500) });
          }
        } catch {
          // ignore recorder failure
        }
      });
    })();`);
    await page.setViewport({
      width: Math.max(1, Math.round(options.width)),
      height: Math.max(1, Math.round(options.height)),
      deviceScaleFactor: 1,
    });
    const resp = await page.goto(url, { waitUntil: "load", timeout: 30000 });
    if (!resp || !resp.ok()) {
      throw new Error(`composition page HTTP ${resp ? resp.status() : "no-response"}`);
    }
    await page
      .evaluate(async () => {
        try {
          await Promise.race([
            document.fonts.ready,
            new Promise((r) => setTimeout(r, 2000)),
          ]);
        } catch {
          // ignore
        }
      })
      .catch(() => undefined);
    await page.evaluate(coordsInpageInstall, {
      w: Math.max(1, Math.round(options.width)),
      h: Math.max(1, Math.round(options.height)),
    });
    const loadEndMs = Date.now();
    phaseRef.phase = "run";
    // Async patterns (`fonts.ready`) register late: poll briefly before judging.
    let status = await readTimelineStatus(page);
    const pollEnd = Date.now() + 3000;
    while (status.expected && !status.registered && Date.now() < pollEnd) {
      await sleep(250);
      status = await readTimelineStatus(page);
    }
    // Timeline samples fire `tl.call` callbacks like render seeks do. A throw inside
    // the evaluated seek rejects here instead of emitting `pageerror` (the exception
    // crosses the CDP bridge), so a rejected seek is itself a run-phase page error.
    const dur = Math.max(0.1, options.durationSec || 0);
    for (const frac of [0.25, 0.5, 0.75]) {
      try {
        await page.evaluate((t: number) => {
          const api = (window as unknown as Record<string, { seek?: (t: number) => void }>)["__cxcoords"];
          if (api && typeof api.seek === "function") api.seek(t);
        }, dur * frac);
        await sleep(120);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const firstLine = msg.split("\n")[0].trim() || "timeline seek threw";
        issues.push({ phase: "run", kind: "pageerror", text: `pageerror: ${firstLine.slice(0, 300)}`, err });
      }
    }
    // Throws swallowed by the in-page seek (see `recordSeekError`): drain them as
    // run-phase page errors.
    try {
      const seekErrors = (await page.evaluate(() => {
        const api = (
          window as unknown as Record<string, { seekErrors?: () => unknown }>
        )["__cxcoords"];
        return typeof api?.seekErrors === "function" ? api.seekErrors() : [];
      })) as unknown;
      if (Array.isArray(seekErrors)) {
        for (const s of seekErrors) {
          if (typeof s === "string" && s) {
            issues.push({ phase: "run", kind: "pageerror", text: `pageerror: ${s}`, err: null });
          }
        }
      }
    } catch {
      // drain failure must never fail the probe
    }
    const rejections = await drainRecordedRejections(page);
    status = await readTimelineStatus(page);
    return {
      errors: collectPageScriptErrors(issues, rejections, loadEndMs),
      timelineExpected: status.expected,
      timelineRegistered: status.registered,
      ms: Date.now() - t0,
    };
  } finally {
    try {
      await page.close({ runBeforeUnload: false });
    } catch {
      // ignore
    }
    try {
      server.close();
    } catch {
      // ignore
    }
    if (ownBrowser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  }
}

async function extractAllFrames(
  page: Page,
  meta: CompositionMeta,
  onChunkElements?: (elements: CoordsInpageElement[]) => Promise<void>
): Promise<{ frames: CoordsInpageFrame[]; elements: CoordsInpageElement[]; seekErrors: string[] }> {
  const all = Array.from({ length: meta.frameCount }, (_, i) => i);
  const chunk = 300;
  const frames: CoordsInpageFrame[] = [];
  const seekErrors: string[] = [];
  let elements: CoordsInpageElement[] = [];
  for (let i = 0; i < all.length; i += chunk) {
    const part = all.slice(i, i + chunk);
    const res = await page.evaluate(coordsLoopRun, {
      frames: part,
      fps: meta.fps,
      rescan: true,
    });
    frames.push(...res.frames);
    elements = res.elements;
    for (const s of res.seekErrors ?? []) {
      if (typeof s === "string" && s && seekErrors.length < 5 && !seekErrors.includes(s)) {
        seekErrors.push(s);
      }
    }
    if (onChunkElements) {
      try {
        await onChunkElements(elements);
      } catch {
        // ink data is best effort and must never break the measurement
      }
    }
  }
  return { frames, elements, seekErrors };
}

/** Drops in-page-only fields (`asset`); keeps the stored element shape. */
function toDocElements(elements: CoordsInpageElement[]): CoordsDocElement[] {
  return elements.map((el) => {
    const out: CoordsDocElement = { key: el.key, kind: el.kind, label: el.label };
    if (el.parent !== undefined) out.parent = el.parent;
    if (el.group !== undefined) out.group = el.group;
    return out;
  });
}

/** Drops elements visible in no frame and remaps indices (items, ink, parent/group). */
export function pruneCoordsElements(
  elements: CoordsDocElement[],
  frames: CoordsDocFrame[]
): CoordsDocElement[] {
  const used = new Set<number>();
  for (const fr of frames) for (const it of fr.items) used.add(it[0]);
  const map = new Map<number, number>();
  const kept: CoordsDocElement[] = [];
  elements.forEach((el, i) => {
    if (used.has(i)) {
      map.set(i, kept.length);
      kept.push(el);
    }
  });
  // A pruned parent falls back to the nearest kept ancestor; a pruned group is
  // dropped (rules cannot use a group owner that has no box in any frame).
  const keptAncestor = (start: number | undefined): number | undefined => {
    let idx = start;
    const seen = new Set<number>();
    while (idx !== undefined && !map.has(idx) && !seen.has(idx)) {
      seen.add(idx);
      idx = elements[idx]?.parent;
    }
    return idx === undefined ? undefined : map.get(idx);
  };
  for (const el of kept) {
    const p = keptAncestor(el.parent);
    if (p === undefined) delete el.parent;
    else el.parent = p;
    if (el.group !== undefined) {
      const g = map.get(el.group);
      if (g === undefined) delete el.group;
      else el.group = g;
    }
  }
  const remapQuad = (row: number[]): CoordsDocQuad => [
    map.get(row[0]) as number,
    row[1],
    row[2],
    row[3],
    row[4],
    row[5],
    row[6],
    row[7],
    row[8],
  ];
  for (const fr of frames) {
    fr.items = fr.items.map(
      (it) => [map.get(it[0]) as number, it[1], it[2], it[3], it[4], it[5], it[6]]
    );
    if (fr.ink) {
      fr.ink = fr.ink
        .filter((row) => map.has(row[0]))
        .map((row): CoordsDocInk => [
          map.get(row[0]) as number,
          row[1],
          row[2],
          row[3],
          row[4],
        ]);
    }
    // In-page frames carry quads under camelCase keys; the document stores snake_case.
    const raw = fr as unknown as Record<string, unknown>;
    const quads = raw.quads;
    const inkQuads = raw.ink_quads ?? raw.inkQuads;
    delete raw.inkQuads;
    if (Array.isArray(quads)) {
      const keptQuads = (quads as number[][]).filter((row) => map.has(row[0])).map(remapQuad);
      if (keptQuads.length > 0) fr.quads = keptQuads;
      else delete fr.quads;
    }
    if (Array.isArray(inkQuads)) {
      const keptInkQuads = (inkQuads as number[][]).filter((row) => map.has(row[0])).map(remapQuad);
      if (keptInkQuads.length > 0) fr.ink_quads = keptInkQuads;
      else delete fr.ink_quads;
    }
  }
  return kept;
}

function shortReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";
}

interface MeasuredCue {
  cue: LaneCue;
  cueStartMs: number;
  sequenceStartFrame: number;
  absCompDir: string;
  entryHtml: string;
  frameCount: number;
  compWidth: number;
  compHeight: number;
  cacheKey: string;
  doc: CoordsDocument | null;
  cached: boolean;
  ms: number;
}

function buildCoordsDocument(params: {
  cueId: string;
  compositionDir: string;
  compWidth: number;
  compHeight: number;
  stageFps: number;
  frameCount: number;
  cueDurationMs: number;
  sequenceStartFrame: number;
  stageWidth: number;
  stageHeight: number;
  placement: LaneCue["placement"];
  placementEnvelopes: string[];
  hyperframesVersion: string;
  fontsBundled: boolean;
  sequenceDigest: string;
  elements: CoordsDocElement[];
  frames: CoordsDocFrame[];
}): CoordsDocument {
  return {
    schema: COORDS_SCHEMA,
    cue_id: params.cueId,
    composition: path.basename(params.compositionDir),
    composition_dir: params.compositionDir,
    width: params.compWidth,
    height: params.compHeight,
    fps: params.stageFps,
    frame_count: params.frameCount,
    cue_duration_ms: params.cueDurationMs,
    sequence_start_frame: params.sequenceStartFrame,
    stage: { width: params.stageWidth, height: params.stageHeight, fps: params.stageFps },
    mapping: {
      composition_size: { width: params.compWidth, height: params.compHeight },
      stage_size: { width: params.stageWidth, height: params.stageHeight },
      placement_at_measure: params.placement,
      placement_envelopes: params.placementEnvelopes,
      note: "Stage boxes are mapped with the cue's current placement at query time; this snapshot records measure-time values.",
    },
    engine_version: COORDS_ENGINE_VERSION,
    hyperframes_version: params.hyperframesVersion,
    fonts_bundled: params.fontsBundled,
    sequence_digest: params.sequenceDigest,
    elements: params.elements,
    frames: params.frames,
  };
}

function summarizeCue(
  measured: MeasuredCue,
  doc: CoordsDocument,
  stageW: number,
  stageH: number,
  querySequenceFrames: number[] | null,
  itemLimit: number
): { result: CoordsCueResult; unmappableFrames: number } {
  const { cue, sequenceStartFrame } = measured;
  const fps = doc.fps;
  let unmappableFrames = 0;

  const mapCtx = {
    compWidth: doc.width,
    compHeight: doc.height,
    stageWidth: stageW,
    stageHeight: stageH,
  };
  const mapItem = (f: number, it: CoordsDocItem): CoordsBox => {
    const localMs = (f / Math.max(1, fps)) * 1000;
    const mapped = mapLocalBoxToStage(
      { x: it[1], y: it[2], w: it[3], h: it[4] },
      cue,
      mapCtx,
      localMs
    );
    if (mapped.unmappable) unmappableFrames++;
    return mapped.box;
  };

  // Per-element visible sequence-frame range + union stage box over that range (first N rows).
  const items: CoordsSummaryItem[] = [];
  doc.elements.forEach((el, elIdx) => {
    if (elIdx >= itemLimit) return;
    let first = -1;
    let last = -1;
    const stageBoxes: CoordsBox[] = [];
    for (const fr of doc.frames) {
      const it = fr.items.find((x) => x[0] === elIdx);
      if (!it) continue;
      if (first < 0) first = fr.f;
      last = fr.f;
      stageBoxes.push(mapItem(fr.f, it));
    }
    if (first < 0) return;
    const union = unionStageBoxes(stageBoxes);
    if (!union) return;
    items.push({
      key: el.key,
      kind: el.kind,
      label: el.label,
      frames: [sequenceStartFrame + first, sequenceStartFrame + last],
      box: roundBox1(union),
    });
  });

  const result: CoordsCueResult = {
    cue: cue.id,
    composition: path.basename(cue.composition?.composition_dir ?? doc.composition_dir),
    frames: doc.frame_count,
    cached: measured.cached,
    ms: measured.ms,
    elements: doc.elements.length,
    file: "",
    items,
    items_total: doc.elements.length,
  };

  if (querySequenceFrames && querySequenceFrames.length > 0) {
    const queried: CoordsQueriedFrame[] = [];
    for (const sn of querySequenceFrames) {
      const local = sn - sequenceStartFrame;
      if (local < 0 || local >= doc.frame_count) continue;
      const fr = doc.frames.find((x) => x.f === local);
      if (!fr) continue;
      queried.push({
        sequence_frame: sn,
        local_frame: local,
        boxes: fr.items.map((it) => {
          const el = doc.elements[it[0]];
          return {
            key: el?.key ?? `#${it[0]}`,
            kind: el?.kind ?? "box",
            box: roundBox1(mapItem(local, it)),
          };
        }),
      });
    }
    result.queried_frames = queried;
  }
  return { result, unmappableFrames };
}

function resolveTargetCues(
  sequence: CutholSequence,
  cueIds: string[] | undefined,
  all: boolean
): { targets: Array<{ laneId: string; cue: LaneCue }>; skipped: CoordsSkippedCue[] } {
  const targets: Array<{ laneId: string; cue: LaneCue }> = [];
  const skipped: CoordsSkippedCue[] = [];
  if (all) {
    for (const lane of sequence.lanes) {
      for (const cue of lane.cues) {
        if (!cue.composition) continue;
        if (lane.muted) {
          skipped.push({ cue: cue.id, reason: `lane '${lane.id}' is muted` });
          continue;
        }
        targets.push({ laneId: lane.id, cue });
      }
    }
    return { targets, skipped };
  }
  for (const id of cueIds ?? []) {
    let found: { laneId: string; cue: LaneCue } | null = null;
    for (const lane of sequence.lanes) {
      const cue = lane.cues.find((c) => c.id === id);
      if (cue) {
        found = { laneId: lane.id, cue };
        break;
      }
    }
    if (!found) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(id));
    if (!found.cue.composition) {
      throw new CutholError(
        DIAGNOSTICS.UNKNOWN_FLAG(
          `--cue ${id}`,
          "composition.coords",
          "cuthol composition coords --cue <composition_cue_XX>"
        )
      );
    }
    targets.push(found);
  }
  return { targets, skipped };
}

interface CueKeyInputs {
  filesHash: string;
  usedSliceHash: string;
  usedGlobalHash: string;
  propsHash: string;
}

// Same props digest formula the overlay key uses (`hf_cache_state.ts`).
function hashCueProps(props: Record<string, unknown> | undefined): string {
  return crypto.createHash("sha256").update(JSON.stringify(props ?? {})).digest("hex").slice(0, 16);
}

/** Pure key inputs from on-disk files (no sync): backs the no-sync fast path. */
function readCueKeyInputs(
  absCompDir: string,
  entryHtml: string,
  props: Record<string, unknown> | undefined,
  hfVersion: string
): CueKeyInputs {
  // Same suffix convention as `syncScalarVarsAndComputeCompositionHash`, so fast-path
  // keys equal slow-path keys.
  const filesHash = `${hashCompositionFilesExcludingBridgeData(absCompDir)}|hf:${hfVersion}`;
  const usage = analyzeCompositionDataUsage(absCompDir, entryHtml, props);
  let parsedBridge = null;
  const dataJsonPath = path.join(absCompDir, "assets", "cuthol-data.json");
  if (fs.existsSync(dataJsonPath)) {
    try {
      parsedBridge = JSON.parse(fs.readFileSync(dataJsonPath, "utf8"));
    } catch {
      parsedBridge = null;
    }
  }
  const { usedSliceHash, usedGlobalHash } = computeUsedBridgePayloadHashes(parsedBridge, usage);
  return { filesHash, usedSliceHash, usedGlobalHash, propsHash: hashCueProps(props) };
}

/** Content digest of the bridge files a sync may rewrite (change detector). */
function snapshotBridgeFiles(absCompDir: string): string {
  const parts: string[] = [];
  for (const name of ["cuthol-data.json", "cuthol-data.js", "cuthol-vars.json", "cuthol-runtime.js"]) {
    try {
      const buf = fs.readFileSync(path.join(absCompDir, "assets", name));
      parts.push(`${name}:${buf.length}:${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16)}`);
    } catch {
      parts.push(`${name}:missing`);
    }
  }
  return parts.join("|");
}

function prepareMeasuredCue(
  sequence: CutholSequence,
  paths: WorkspacePaths,
  projectDir: string,
  target: { laneId: string; cue: LaneCue },
  stageW: number,
  stageH: number,
  stageFps: number,
  hfVersion: string,
  sequenceDigest: string,
  refresh: boolean,
  warnings: CutholDiagnostic[],
  skipped: CoordsSkippedCue[]
): MeasuredCue | null {
  const { cue } = target;
  const t0 = Date.now();
  const comp = cue.composition!;
  const absCompDir = path.isAbsolute(comp.composition_dir)
    ? comp.composition_dir
    : path.resolve(projectDir, comp.composition_dir);
  const entryHtml = comp.entry_html || "index.html";
  // Missing entry fails fast (before any sync/browser): a 404 page must never "measure".
  if (!fs.existsSync(path.join(absCompDir, entryHtml))) {
    const reason = `composition entry '${comp.composition_dir}/${entryHtml}' not found`;
    warnings.push(DIAGNOSTICS.COORDS_MEASUREMENT_FAILED(cue.id, reason));
    skipped.push({ cue: cue.id, reason });
    return null;
  }
  const cueStartMs = resolveCueStartMs(sequence, cue);
  const sequenceStartFrame = Math.round((cueStartMs * stageFps) / 1000);
  const frameCount = Math.max(1, Math.round((cue.duration_ms / 1000) * stageFps));
  const pixelSize =
    readCompositionPixelSize(absCompDir, entryHtml) ?? { width: stageW, height: stageH };

  const makeEntry = (cacheKey: string): MeasuredCue => ({
    cue,
    cueStartMs,
    sequenceStartFrame,
    absCompDir,
    entryHtml,
    frameCount,
    compWidth: pixelSize.width,
    compHeight: pixelSize.height,
    cacheKey,
    doc: null,
    cached: false,
    ms: 0,
  });

  // Fast path: pure reads, no sync. A hit is valid only when the sequence bytes are
  // identical to measure time (so on-disk bridge data cannot have gone stale behind
  // the key) — any edit, however small, takes the slow path below.
  let fastInputs: CueKeyInputs | null = null;
  if (!refresh) {
    try {
      fastInputs = readCueKeyInputs(absCompDir, entryHtml, comp.props, hfVersion);
      const fastKey = computeCoordsCacheKey({
        ...fastInputs,
        durationMs: cue.duration_ms,
        stageWidth: stageW,
        stageHeight: stageH,
        stageFps,
        hyperframesVersion: hfVersion,
      });
      const hit = readCoordsCache(projectDir, fastKey);
      if (hit && hit.sequence_digest === sequenceDigest) {
        const entry = makeEntry(fastKey);
        entry.doc = hit;
        entry.cached = true;
        entry.ms = Date.now() - t0;
        return entry;
      }
    } catch {
      fastInputs = null;
      // fall through to the slow path
    }
  }

  // Slow path: the same bridge inputs render uses (read/call only; render performs
  // the same sync before compiling, so this cannot change the render plan).
  const bridgeSnapshot = snapshotBridgeFiles(absCompDir);
  let syncUpdated = false;
  try {
    const syncRes = syncCompositionBridgeFiles(sequence, cue, paths);
    syncUpdated = syncRes?.updated === true;
  } catch {
    // non-blocking bridge sync, like the compiler
  }
  let filesHash = "";
  let usedSliceHash = "";
  let usedGlobalHash = "";
  let propsHash = "";
  // When the sync changed no bridge file, the fast-path inputs are still exact
  // (the sync only writes bridge files, and none changed) — skip the re-hash.
  if (fastInputs && !syncUpdated && bridgeSnapshot === snapshotBridgeFiles(absCompDir)) {
    ({ filesHash, usedSliceHash, usedGlobalHash, propsHash } = fastInputs);
  } else {
    try {
      const htmlSource = fs.readFileSync(path.join(absCompDir, entryHtml), "utf8");
      const hashInfo = syncScalarVarsAndComputeCompositionHash({
        absCompDir,
        entryHtml,
        htmlSource,
        width: stageW,
        height: stageH,
        fps: stageFps,
        durationMs: cue.duration_ms,
        props: comp.props ?? {},
        transparent: comp.transparent,
        mode: comp.mode ?? "overlay_alpha",
      });
      filesHash = hashInfo.filesHash;
      usedSliceHash = hashInfo.usedSliceHash;
      usedGlobalHash = hashInfo.usedGlobalHash;
      propsHash = hashInfo.propsHash;
    } catch (err) {
      const reason = shortReason(err);
      warnings.push(DIAGNOSTICS.COORDS_MEASUREMENT_FAILED(cue.id, reason));
      skipped.push({ cue: cue.id, reason });
      return null;
    }
  }
  const cacheKey = computeCoordsCacheKey({
    filesHash,
    usedSliceHash,
    usedGlobalHash,
    propsHash,
    durationMs: cue.duration_ms,
    stageWidth: stageW,
    stageHeight: stageH,
    stageFps,
    hyperframesVersion: hfVersion,
  });
  const entry = makeEntry(cacheKey);
  if (!refresh) {
    const hit = readCoordsCache(projectDir, cacheKey);
    if (hit) {
      // Slow-path hit: inputs match post-sync state, so the boxes are valid; refresh
      // the guard digest so the next identical run takes the fast path.
      if (hit.sequence_digest !== sequenceDigest) {
        hit.sequence_digest = sequenceDigest;
        try {
          writeCoordsCache(projectDir, cacheKey, hit);
        } catch {
          // cache write failure must not fail the read
        }
      }
      entry.doc = hit;
      entry.cached = true;
      entry.ms = Date.now() - t0;
    }
  }
  return entry;
}

interface AssetInkMargins {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Maps a discovered image asset URL to its transparent margins. `http(s)` URLs served
 * by the measurement server resolve to files under the composition directory (`data:`
 * sources are measured in-page on a canvas and never reach this function). Anything
 * unresolvable returns null (item box fallback).
 */
function resolveAssetInkMargins(
  assetUrl: string,
  absCompDir: string
): AssetInkMargins | null {
  try {
    if (!/^https?:/i.test(assetUrl)) return null;
    const urlPath = decodeURIComponent(new URL(assetUrl).pathname).replace(/^\/+/, "");
    const file = path.normalize(path.join(absCompDir, urlPath));
    const root = path.resolve(absCompDir);
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    const m = resolveImageFileInkMargins(file);
    if (!m) return null;
    return {
      left: m.left,
      top: m.top,
      right: m.right,
      bottom: m.bottom,
      width: m.width,
      height: m.height,
    };
  } catch {
    return null;
  }
}

async function measureMisses(
  browser: Browser,
  projectDir: string,
  misses: MeasuredCue[],
  stageW: number,
  stageH: number,
  stageFps: number,
  hfVersion: string,
  sequenceDigest: string,
  warnings: CutholDiagnostic[],
  skipped: CoordsSkippedCue[]
): Promise<void> {
  let bundler: FontBundlerFn | null = null;
  let bundlerError: string | null = null;
  try {
    bundler = await resolveCoordsFontBundler();
  } catch (err) {
    bundlerError = shortReason(err);
  }
  for (const m of misses) {
    const t0 = Date.now();
    try {
      let bundledHtml: string | null = null;
      let fontsBundled = false;
      if (bundler) {
        // The bundler logs informational warnings (oversize assets it leaves on disk);
        // the static server below serves those files, so keep stderr clean for the agent.
        const savedConsole = {
          log: console.log,
          info: console.info,
          warn: console.warn,
          error: console.error,
        };
        try {
          console.log = () => undefined;
          console.info = () => undefined;
          console.warn = () => undefined;
          console.error = () => undefined;
          bundledHtml = await bundler(m.absCompDir);
          fontsBundled = true;
        } catch (err) {
          warnings.push(DIAGNOSTICS.COORDS_FONTS_NOT_BUNDLED(m.cue.id, shortReason(err)));
        } finally {
          console.log = savedConsole.log;
          console.info = savedConsole.info;
          console.warn = savedConsole.warn;
          console.error = savedConsole.error;
        }
      } else if (bundlerError) {
        warnings.push(DIAGNOSTICS.COORDS_FONTS_NOT_BUNDLED(m.cue.id, bundlerError));
      }
      const meta: CompositionMeta = {
        width: m.compWidth,
        height: m.compHeight,
        fps: stageFps,
        frameCount: m.frameCount,
      };
      const opened = await openCompositionPage(
        browser,
        m.absCompDir,
        m.entryHtml,
        meta,
        bundledHtml
      );
      const loadEndMs = Date.now();
      try {
        // Image ink margins, resolved once per asset URL (late-discovered images
        // with new URLs are pushed after each chunk for the frames after that).
        const seenAssets = new Set<string>();
        const pushInkData = async (elements: CoordsInpageElement[]): Promise<void> => {
          const fresh: Record<string, AssetInkMargins> = {};
          for (const el of elements) {
            if (el.kind !== "image" || !el.asset || seenAssets.has(el.asset)) continue;
            seenAssets.add(el.asset);
            const margins = resolveAssetInkMargins(el.asset, m.absCompDir);
            if (margins) fresh[el.asset] = margins;
          }
          if (Object.keys(fresh).length > 0) {
            await opened.page.evaluate(coordsInpageSetInkData, { margins: fresh });
          }
        };
        try {
          await pushInkData(opened.elements);
        } catch {
          // ink data is best effort and must never break the measurement
        }
        const { frames, elements, seekErrors } = await extractAllFrames(opened.page, meta, pushInkData);
        // Throws swallowed by the in-page seek (e.g. `tl.call` callbacks render also
        // swallows): run-phase page errors for the warnings and the record below.
        for (const s of seekErrors) {
          opened.errors.push(`pageerror: ${s}`);
          opened.issues.push({ phase: "run", kind: "pageerror", text: `pageerror: ${s}`, err: null });
        }
        const kept = pruneCoordsElements(
          toDocElements(elements),
          frames as CoordsDocFrame[]
        );
        const doc = buildCoordsDocument({
          cueId: m.cue.id,
          compositionDir: m.cue.composition!.composition_dir,
          compWidth: m.compWidth,
          compHeight: m.compHeight,
          stageFps,
          frameCount: m.frameCount,
          cueDurationMs: m.cue.duration_ms,
          sequenceStartFrame: m.sequenceStartFrame,
          stageWidth: stageW,
          stageHeight: stageH,
          placement: m.cue.placement,
          placementEnvelopes: m.cue.envelopes.map((e) => e.parameter),
          hyperframesVersion: hfVersion,
          fontsBundled,
          sequenceDigest,
          elements: kept,
          frames: frames as CoordsDocFrame[],
        });
        writeCoordsCache(projectDir, m.cacheKey, doc);
        m.doc = doc;
        m.ms = Date.now() - t0;
        if (opened.errors.length > 0) {
          const first = opened.errors[0];
          const extra = opened.errors.length > 1 ? ` (+${opened.errors.length - 1} more)` : "";
          warnings.push(DIAGNOSTICS.COORDS_PAGE_ISSUES(m.cue.id, `${first}${extra}`));
        }
        // Script-error record: every measurement (clean ones too) refreshes the
        // content-keyed record that `verify` and `monitor` read without a browser.
        // Best effort; a record failure must never fail the measurement.
        try {
          const rejections = await drainRecordedRejections(opened.page);
          const status = await readTimelineStatus(opened.page);
          const scriptErrors = collectPageScriptErrors(opened.issues, rejections, loadEndMs);
          writeCurrentScriptErrorRecord(projectDir, {
            absCompDir: m.absCompDir,
            entryHtml: m.entryHtml,
            source: "coords",
            timelineExpected: status.expected,
            timelineRegistered: status.registered,
            errors: scriptErrors,
          });
        } catch {
          // ignore record failure
        }
      } finally {
        await closeCompositionPage(opened);
      }
    } catch (err) {
      const reason = shortReason(err);
      warnings.push(DIAGNOSTICS.COORDS_MEASUREMENT_FAILED(m.cue.id, reason));
      skipped.push({ cue: m.cue.id, reason });
    }
  }
}

export interface MeasureCompositionCuesOptions {
  workspaceDir: string;
  cueIds?: string[];
  all?: boolean;
  refresh?: boolean;
  querySequenceFrames?: number[] | null;
}

export async function measureCompositionCues(
  options: MeasureCompositionCuesOptions
): Promise<CoordsRunResult> {
  const { sequence, paths } = loadSequence(options.workspaceDir);
  const projectDir = paths.rootDir;
  const stageW = sequence.stage.width;
  const stageH = sequence.stage.height;
  const stageFps = Math.max(1, sequence.stage.fps);
  const refresh = options.refresh === true;
  const query = options.querySequenceFrames ?? null;
  const hfVersion = readInvokedHyperFramesVersion();
  let sequenceDigest = "";
  try {
    sequenceDigest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(paths.sequenceFile))
      .digest("hex");
  } catch {
    sequenceDigest = "";
  }

  const warnings: CutholDiagnostic[] = [];
  const { targets, skipped } = resolveTargetCues(sequence, options.cueIds, options.all === true);
  const cuesTotal = targets.length + skipped.length;

  // Cache keys first: an unchanged project measures nothing and opens no browser.
  const measured: MeasuredCue[] = [];
  for (const target of targets) {
    const entry = prepareMeasuredCue(
      sequence,
      paths,
      projectDir,
      target,
      stageW,
      stageH,
      stageFps,
      hfVersion,
      sequenceDigest,
      refresh,
      warnings,
      skipped
    );
    if (entry) measured.push(entry);
  }

  // Measure the misses with one browser, one fresh page per composition.
  const misses = measured.filter((m) => m.doc === null);
  if (misses.length > 0) {
    let browser: Browser | null = null;
    try {
      browser = await launchCoordsBrowser();
    } catch (err) {
      for (const m of misses) {
        const reason = `browser launch failed: ${shortReason(err)}`;
        warnings.push(DIAGNOSTICS.COORDS_MEASUREMENT_FAILED(m.cue.id, reason));
        skipped.push({ cue: m.cue.id, reason });
      }
    }
    if (browser) {
      try {
        await measureMisses(
          browser,
          projectDir,
          misses,
          stageW,
          stageH,
          stageFps,
          hfVersion,
          sequenceDigest,
          warnings,
          skipped
        );
      } finally {
        try {
          await browser.close();
        } catch {
          // ignore
        }
      }
    }
    for (let i = measured.length - 1; i >= 0; i--) {
      if (measured[i].doc === null) measured.splice(i, 1);
    }
  }

  // Summaries + queried frames, mapped with each cue's current placement.
  const cues: CoordsCueResult[] = [];
  for (const m of measured) {
    const doc = m.doc!;
    const itemLimit = options.all === true ? COORDS_SUMMARY_ITEMS_ALL : COORDS_SUMMARY_ITEMS_PER_CUE;
    const { result, unmappableFrames } = summarizeCue(m, doc, stageW, stageH, query, itemLimit);
    // Forward slashes: valid absolute path on Windows, shorter in JSON envelopes.
    result.file = coordsCachePath(projectDir, m.cacheKey).replace(/\\/g, "/");
    if (unmappableFrames > 0) {
      warnings.push(
        DIAGNOSTICS.COORDS_PAGE_ISSUES(
          m.cue.id,
          `${unmappableFrames} frame box(es) used static placement (non-finite enveloped value)`
        )
      );
    }
    cues.push(result);
  }
  // Deterministic cue order: sequence frame, then cue id.
  const startOf = new Map(measured.map((m) => [m.cue.id, m.sequenceStartFrame]));
  cues.sort((a, b) => (startOf.get(a.cue) ?? 0) - (startOf.get(b.cue) ?? 0) || (a.cue < b.cue ? -1 : a.cue > b.cue ? 1 : 0));

  return {
    cues,
    skipped_cues: skipped,
    warnings,
    cues_total: cuesTotal,
    cues_measured: measured.filter((m) => !m.cached).length,
    cues_cached: measured.filter((m) => m.cached).length,
    cues_skipped: skipped.length,
  };
}
