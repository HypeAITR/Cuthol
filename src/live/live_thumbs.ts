// Scene thumbnails for the Live window: one small JPEG per scene, rendered through
// the existing `monitor frame` path and cached by content hash. Only scenes whose
// visual inputs changed are re-rendered; everything runs off the agent's path.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import { captureMonitorFrame } from "../monitor/preview.js";
import { resolveLivePaths } from "./live_paths.js";
import type { LiveSceneSummary } from "./live_types.js";

export const LIVE_THUMB_WIDTH = 240;
export const LIVE_THUMB_INDEX = "index.json";

export interface SceneThumbIndex {
  [sceneId: string]: string;
}

function readThumbIndex(projectDir: string): SceneThumbIndex {
  try {
    const raw = fs.readFileSync(path.join(resolveLivePaths(projectDir).thumbsDir, LIVE_THUMB_INDEX), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as SceneThumbIndex;
  } catch {}
  return {};
}

function writeThumbIndex(projectDir: string, index: SceneThumbIndex): void {
  try {
    const dir = resolveLivePaths(projectDir).thumbsDir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LIVE_THUMB_INDEX), JSON.stringify(index, null, 2));
  } catch {}
}

function logThumbWarning(projectDir: string, sceneId: string, detail: string): void {
  try {
    const line = `${DIAGNOSTICS.LIVE_THUMB_FAILED(sceneId, detail).formatted}\n`;
    fs.mkdirSync(resolveLivePaths(projectDir).dir, { recursive: true });
    fs.appendFileSync(resolveLivePaths(projectDir).logFile, line);
  } catch {}
}

/**
 * Project directory hint for composition source fingerprinting. The scene key
 * must stay computable from `(sequence, scene)` because long-lived callers
 * build it without a project directory at hand; those callers run in the same
 * process as code that knows the directory (snapshot/delta builders, the
 * refresh worker), which records it here first. The key never throws when the
 * hint is missing or stale — it just falls back to the composition path.
 */
let thumbProjectDirHint: string | null = null;

export function setSceneThumbProjectDir(projectDir: string | null | undefined): void {
  if (typeof projectDir === "string" && projectDir.length > 0) {
    thumbProjectDirHint = projectDir;
  } else if (projectDir === null) {
    thumbProjectDirHint = null;
  }
}

const IGNORED_COMP_CHILD_DIRS = new Set([
  ".hyperframes",
  "snapshots",
  "renders",
  "build",
  "node_modules",
  ".git",
  ".cuthol",
]);

/** Shared ignore rule: files Cuthol itself writes into composition directories. */
export const COMP_IGNORE_DIRS: ReadonlySet<string> = IGNORED_COMP_CHILD_DIRS;
export function isCompIgnoredFile(relPath: string, name: string): boolean {
  return isIgnoredCompEntry(relPath, name);
}

function isIgnoredCompEntry(relPath: string, name: string): boolean {
  if (name.startsWith(".cuthol-") || name.startsWith(".tmp.")) return true;
  if (name.endsWith(".tmp.mp4") || name.endsWith(".tmp.mov")) return true;
  if (name === "cuthol-bbox.json") return true;
  if (relPath === "assets/cuthol-data.json" || relPath === "assets/cuthol-data.js") return true;
  return false;
}

const compDirFingerprintCache = new Map<string, { listing: string; fingerprint: string }>();

/**
 * Cheap fingerprint of a composition directory: a `(relative path, size,
 * mtime)` listing hashed down to 16 hex chars. It detects outside edits
 * (which change size or mtime) without reading file contents on the
 * server's event loop; heavy content hashing stays in the overlay cache.
 * The per-directory result is memoized on the listing itself, so repeated
 * key computations only re-stat the files. Returns null when the directory
 * cannot be listed (the key then falls back to the composition path).
 */
export function fingerprintCompositionDir(absCompDir: string): string | null {
  try {
    const absRoot = path.resolve(absCompDir);
    const entries: string[] = [];
    const walk = (dir: string, relPrefix: string): void => {
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of dirents) {
        const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
        if (isIgnoredCompEntry(rel, ent.name)) continue;
        const full = path.join(dir, ent.name);
        let isDir = ent.isDirectory();
        let isFile = ent.isFile();
        if (ent.isSymbolicLink()) {
          try {
            const st = fs.statSync(full);
            isDir = st.isDirectory();
            isFile = st.isFile();
          } catch {
            continue;
          }
        }
        if (isDir) {
          if (IGNORED_COMP_CHILD_DIRS.has(ent.name)) continue;
          walk(full, rel);
        } else if (isFile) {
          try {
            const st = fs.statSync(full);
            entries.push(`${rel}:${st.size}:${st.mtimeMs}`);
          } catch {
            // Ignore transient files that vanish mid-listing.
          }
        }
      }
    };
    walk(absRoot, "");
    if (entries.length === 0 && !fs.existsSync(absRoot)) return null;
    const listing = entries.join("\n");
    const cached = compDirFingerprintCache.get(absRoot);
    if (cached && cached.listing === listing) return cached.fingerprint;
    const fingerprint = crypto.createHash("sha256").update(listing).digest("hex").slice(0, 16);
    compDirFingerprintCache.set(absRoot, { listing, fingerprint });
    return fingerprint;
  } catch {
    return null;
  }
}

function resolveThumbProjectDir(explicit?: string): string | null {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return thumbProjectDirHint;
}

/**
 * Content hash of everything that can change the scene's picture: the scene span,
 * its member clips, every visual input of the overlapping lane cues (timing,
 * placement, composition identity, composition props, composition source files,
 * envelopes, typography) and the whole stage (size and backdrop). A trim, grade,
 * cue, style or outside composition edit changes the hash, so only affected
 * scenes re-render.
 *
 * Composition sources enter through a cheap `(path, size, mtime)` directory
 * listing (see `fingerprintCompositionDir`), not a content hash: this runs on
 * the server's event loop on every thumbnail request and after every revision.
 * The optional `projectDir` (or the module hint recorded by the snapshot/delta
 * builders and the refresh entry points) resolves relative composition
 * directories; without a usable directory the key falls back to the
 * composition path and props, never throws, and stays stable.
 */
export function computeSceneThumbKey(sequence: any, scene: LiveSceneSummary, projectDir?: string): string {
  const projectRoot = resolveThumbProjectDir(projectDir);
  const clips: any[] = sequence?.spine?.clips ?? [];
  const members = new Set(scene.members ?? []);
  const memberClips = clips.filter((c) => members.has(c.id));
  const lanes: any[] = sequence?.lanes ?? [];
  const overlapping: unknown[] = [];
  for (const lane of lanes) {
    for (const cue of lane?.cues ?? []) {
      const start = cue.at_ms ?? 0;
      const end = start + (cue.duration_ms ?? 0);
      if (end <= scene.start_ms || start >= scene.end_ms) continue;
      const compDir: string | null = cue.composition?.composition_dir ?? null;
      let compFiles: string | null = null;
      if (typeof compDir === "string" && projectRoot) {
        compFiles = fingerprintCompositionDir(path.resolve(projectRoot, compDir));
      }
      overlapping.push({
        id: cue.id,
        kind: cue.kind,
        at_ms: cue.at_ms,
        duration_ms: cue.duration_ms,
        anchor: cue.anchor ?? null,
        placement: cue.placement ?? null,
        composition: cue.composition
          ? {
              composition_dir: cue.composition.composition_dir ?? null,
              entry_html: cue.composition.entry_html ?? null,
              props: cue.composition.props ?? null,
              transparent: cue.composition.transparent ?? null,
              mode: cue.composition.mode ?? null,
              files: compFiles,
            }
          : null,
        typography: cue.typography ?? null,
        envelopes: cue.envelopes ?? null,
      });
    }
  }
  const payload = {
    scene: { id: scene.id, start_ms: scene.start_ms, end_ms: scene.end_ms },
    stage: sequence?.stage ?? null,
    clips: memberClips,
    cues: overlapping,
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

export function sceneThumbFile(projectDir: string, key: string): string {
  return path.join(resolveLivePaths(projectDir).thumbsDir, `${key}.jpg`);
}

/** Removes cached JPEGs no scene points at any more (best effort, never throws). */
export function pruneSceneThumbs(projectDir: string, liveKeys: Set<string>): void {
  try {
    const dir = resolveLivePaths(projectDir).thumbsDir;
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!/^[0-9a-f]{16}\.jpg$/.test(name)) continue;
      if (!liveKeys.has(name.slice(0, 16))) {
        try { fs.unlinkSync(path.join(dir, name)); } catch {}
      }
    }
  } catch {}
}

function renderThumbJpeg(projectDir: string, atMs: number, outFile: string): void {
  const tmpPng = path.join(os.tmpdir(), `cuthol-thumb-${process.pid}-${Date.now()}.png`);
  try {
    captureMonitorFrame({ workspaceDir: projectDir, atMs, showBoxes: false, outputPath: tmpPng });
    spawnWatchedSync(
      "ffmpeg",
      ["-y", "-v", "error", "-i", tmpPng, "-vf", `scale=${LIVE_THUMB_WIDTH}:-1`, "-q:v", "4", outFile],
      { step: "live scene thumbnail" }
    );
  } finally {
    try { fs.unlinkSync(tmpPng); } catch {}
  }
}

/**
 * Returns the cached JPEG for a scene, rendering it first when the content hash
 * changed. Returns null on failure (a G607 warning goes to the live server log);
 * never throws.
 */
export function ensureSceneThumb(projectDir: string, sequence: any, scene: LiveSceneSummary): string | null {
  try {
    setSceneThumbProjectDir(projectDir);
    const key = computeSceneThumbKey(sequence, scene, projectDir);
    const file = sceneThumbFile(projectDir, key);
    const index = readThumbIndex(projectDir);
    if (index[scene.id] === key && fs.existsSync(file)) return file;
    fs.mkdirSync(resolveLivePaths(projectDir).thumbsDir, { recursive: true });
    const atMs = scene.end_ms > scene.start_ms ? Math.round((scene.start_ms + scene.end_ms) / 2) : scene.start_ms;
    if (!fs.existsSync(file)) renderThumbJpeg(projectDir, atMs, file);
    const next = readThumbIndex(projectDir);
    next[scene.id] = key;
    writeThumbIndex(projectDir, next);
    pruneSceneThumbs(projectDir, new Set(Object.values(next)));
    return fs.existsSync(file) ? file : null;
  } catch (e) {
    logThumbWarning(projectDir, scene.id, String(e instanceof Error ? e.message : e));
    return null;
  }
}

export interface SceneThumbResponse {
  status: 200 | 404 | 503;
  /** Absolute JPEG path when status is 200. */
  file?: string;
  contentType?: string;
  /** Cache key for ETag-style cache busting. */
  key?: string;
  note?: string;
}

/**
 * Handler for `GET /api/thumb/<scene-id>` (wired by the live server owner): renders
 * on cache miss and answers with the JPEG path. Synchronous by design — scenes are
 * few and already cached after the first background refresh.
 */
export function handleSceneThumbRequest(
  projectDir: string,
  sequence: any,
  scenes: LiveSceneSummary[],
  sceneId: string
): SceneThumbResponse {
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene) return { status: 404, note: `unknown scene '${sceneId}'` };
  const file = ensureSceneThumb(projectDir, sequence, scene);
  if (!file) return { status: 503, note: `thumbnail for '${sceneId}' is not available (see G607 in the live server log)` };
  return { status: 200, file, contentType: "image/jpeg", key: computeSceneThumbKey(sequence, scene, projectDir) };
}

/**
 * Background refresh after a revision: renders only the scenes whose content hash
 * changed, one at a time with yields in between so the server stays responsive.
 * Resolves to the ids that were (re)rendered; never rejects.
 */
export async function refreshSceneThumbs(
  projectDir: string,
  sequence: any,
  scenes: LiveSceneSummary[]
): Promise<string[]> {
  const done: string[] = [];
  setSceneThumbProjectDir(projectDir);
  const index = readThumbIndex(projectDir);
  for (const scene of scenes) {
    await new Promise((r) => setImmediate(r));
    try {
      const key = computeSceneThumbKey(sequence, scene, projectDir);
      if (index[scene.id] === key && fs.existsSync(sceneThumbFile(projectDir, key))) continue;
      const file = ensureSceneThumb(projectDir, sequence, scene);
      if (file) {
        index[scene.id] = key;
        done.push(scene.id);
      }
    } catch {
      // ensureSceneThumb already logged; keep the loop alive.
    }
  }
  return done;
}
