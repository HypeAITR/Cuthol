/**
 * External (out-of-journal) project change tracking (`src/core/external_changes.ts`).
 *
 * Part of a Cuthol project lives outside the journal: the composition folders
 * mounted via `lane add_composition` (HTML/CSS/JS/assets inside `comp_dir`) and,
 * when edited by hand, `cuthol.sequence.json` itself. This module keeps a
 * per-revision "known state" of those files (relative path -> sha256) with
 * content-addressed blobs, detects out-of-band edits, and offers
 * `workspace changes show/adopt/revert` to resolve them.
 *
 * Exclusion rule for composition files mirrors the bridge's own writes:
 * - `hashCompositionFilesExcludingBridgeData` (`src/compositor/bridge_hash.ts`):
 *   transient dirs (`.hyperframes`, `snapshots`, `renders`, `build`,
 *   `node_modules`, `.git`, `.cuthol`), temp names (`.tmp.*`, `.cuthol-*`,
 *   `*.tmp.mp4`, `*.tmp.mov`, `cuthol-bbox.json`) and the bridge data files
 *   (`assets/cuthol-data.json`, `assets/cuthol-data.js`, `assets/cuthol-bbox.json`).
 * - `src/compositor/bridge_extension_assets.ts` + `bridge_exporter.ts` step 4/4b:
 *   Cuthol-synced files (`assets/cuthol-runtime.js`, `assets/cuthol-vars.json`,
 *   `assets/cuthol-ext-*.js`, `assets/gsap.min.js`, `assets/ext/**`).
 * None of these count as "external changes".
 *
 * Storage (all under the project state dir, never in `cuthol.sequence.json`):
 * - `.cuthol/extchange/rev_NNNN.json`: known composition-file state per revision.
 * - `.cuthol/extchange/reverted_rev_NNNN.json`: pre-revert disk state, so
 *   `journal undo` of a revert revision restores the pre-revert content.
 * - `.cuthol/blobs/extchange/<sha256>`: content-addressed file contents
 *   (same content stored once; separate subfolder of the existing blobs layout).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "./diagnostics.js";
import { CutholSequence } from "./schema.js";
import {
  commitSequenceMutation,
  loadJournalManifest,
  resolveWorkspacePaths,
  WorkspacePaths,
} from "./workspace.js";
import { verifySequence } from "../verify/gates.js";
import { resolveExtension } from "../extensions/manager.js";

export const EXTCHANGE_STATE_SUBDIR = "extchange";
export const EXTCHANGE_BLOBS_SUBDIR = "extchange";

/**
 * Contents up to this size are stored as blobs (needed for `show` diffs,
 * `revert`, and adopt/revert undo/redo). Larger files are tracked by
 * hash + size + mtime only. 1 MiB: composition sources (HTML/CSS/JS/SVG/JSON,
 * fonts) are virtually always smaller; above that are videos and large images
 * where a per-revision copy would bloat `.cuthol`. Large files are still
 * detected, listed, and adoptable by hash — only byte-restore is unavailable,
 * and `revert`/undo say so explicitly instead of silently skipping them.
 */
export const MAX_STORED_CONTENT_BYTES = 1024 * 1024;

export const SHOW_DIFF_MAX_LINES_PER_FILE = 60;
export const SHOW_DIFF_MAX_FILES = 10;

export const ADOPT_OPERATION_PREFIX = "workspace.changes.adopt";
export const REVERT_OPERATION_PREFIX = "workspace.changes.revert";

// --- Exclusion rule (mirrors the bridge; see file header) ---

const IGNORED_COMPOSITION_SUBDIRS = new Set([
  ".hyperframes",
  "snapshots",
  "renders",
  "build",
  "node_modules",
  ".git",
  ".cuthol",
]);

const EXCLUDED_BRIDGE_DATA_RELS = new Set([
  "assets/cuthol-data.json",
  "assets/cuthol-data.js",
  "assets/cuthol-bbox.json",
]);

const EXCLUDED_CUTHOL_SYNCED_RELS = new Set([
  "assets/cuthol-runtime.js",
  "assets/cuthol-vars.json",
  "assets/gsap.min.js",
]);

function isExcludedFileName(name: string): boolean {
  return (
    name.startsWith(".tmp.") ||
    name.startsWith(".cuthol-") ||
    name.endsWith(".tmp.mp4") ||
    name.endsWith(".tmp.mov") ||
    name === "cuthol-bbox.json"
  );
}

/** True when `rel` (slash-separated, relative to the composition dir) is Cuthol-written. */
export function isExcludedCompositionPath(rel: string): boolean {
  if (EXCLUDED_BRIDGE_DATA_RELS.has(rel) || EXCLUDED_CUTHOL_SYNCED_RELS.has(rel)) return true;
  if (rel.startsWith("assets/ext/")) return true;
  if (
    rel.startsWith("assets/cuthol-ext-") &&
    rel.endsWith(".js") &&
    !rel.slice("assets/".length).includes("/")
  ) {
    return true;
  }
  return false;
}

// --- Types ---

export interface TrackedFileEntry {
  sha: string;
  size: number;
  mtime_ms: number;
  /** False for large files: content not stored, byte-restore unavailable. */
  stored: boolean;
}

export interface CompKnownState {
  /** `composition_dir` exactly as stored in the sequence. */
  dir: string;
  entry_html: string;
  cue_ids: string[];
  files: Record<string, TrackedFileEntry>;
}

export interface RevCompManifest {
  version: 1;
  revision: number;
  created_at: string;
  compositions: Record<string, CompKnownState>;
}

export interface RevertSidecarFile {
  comp: string;
  rel: string;
  /** sha of the pre-revert disk content (`deleted` kind has no disk content). */
  sha: string | null;
  size: number;
  /** Blob holding the pre-revert content; null when not stored (large file). */
  blob: string | null;
  kind: "added" | "modified" | "deleted";
}

export interface RevertSidecar {
  version: 1;
  revision: number;
  created_at: string;
  operation: string;
  /** Blob holding the pre-revert raw `cuthol.sequence.json`; null when it was clean. */
  sequence_blob: string | null;
  files: RevertSidecarFile[];
}

export interface MountedComposition {
  /** Key: `composition_dir` as stored in the sequence (first-seen spelling). */
  key: string;
  absDir: string;
  entry_html: string;
  cue_ids: string[];
}

export interface CompChangeSet {
  key: string;
  dir: string;
  entry_html: string;
  cue_ids: string[];
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface SequenceChange {
  status: "modified" | "corrupt";
  detail: string;
}

export interface ExternalChanges {
  has_changes: boolean;
  /** Stable short digest of the change set (MCP full-vs-reminder tracking). */
  digest: string;
  cursor_revision: number;
  sequence: SequenceChange | null;
  compositions: CompChangeSet[];
  counts: { comps: number; added: number; modified: number; deleted: number; sequence: number };
}

// --- Small helpers ---

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function writeFileAtomically(filePath: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp_${process.pid}_${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, data);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    fs.copyFileSync(tmpPath, filePath);
    fs.unlinkSync(tmpPath);
  }
}

/** Canonical JSON (sorted keys) for order-insensitive comparison and digests. */
export function canonicalizeJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalizeJson(v ?? null)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha12Hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
}

// --- Mounts, walking, hashing ---

/** Composition folders mounted by the sequence, deduplicated by resolved path. */
export function listMountedCompositions(seq: CutholSequence, rootDir: string): MountedComposition[] {
  const byAbs = new Map<string, MountedComposition>();
  for (const lane of seq.lanes ?? []) {
    for (const cue of lane.cues ?? []) {
      if (cue.kind !== "composition" || !cue.composition) continue;
      const stored = cue.composition.composition_dir;
      const absDir = path.isAbsolute(stored) ? path.resolve(stored) : path.resolve(rootDir, stored);
      const existing = byAbs.get(absDir);
      if (existing) {
        if (!existing.cue_ids.includes(cue.id)) existing.cue_ids.push(cue.id);
      } else {
        byAbs.set(absDir, {
          key: stored,
          absDir,
          entry_html: cue.composition.entry_html || "index.html",
          cue_ids: [cue.id],
        });
      }
    }
  }
  return [...byAbs.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Tracked relative paths (slash-separated, sorted) of one composition folder. */
export function walkTrackedCompositionFiles(absDir: string): string[] {
  const out: string[] = [];
  const absRoot = path.resolve(absDir);
  if (!fs.existsSync(absRoot)) return out;
  const visited = new Set<string>([safeRealpath(absRoot)]);
  const walk = (currentDir: string, relPrefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (isExcludedFileName(entry.name)) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = path.join(currentDir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (IGNORED_COMPOSITION_SUBDIRS.has(entry.name)) continue;
        const real = safeRealpath(full);
        if (visited.has(real)) continue;
        visited.add(real);
        walk(full, rel);
      } else if (isFile) {
        if (isExcludedCompositionPath(rel)) continue;
        out.push(rel);
      }
    }
  };
  walk(absRoot, "");
  return out;
}

function hashBuffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Current disk state of mounted compositions. Files whose size+mtime match
 * `prev` reuse its hash (fast path: no read); only changed files are hashed.
 */
export function snapshotCompDiskState(
  seq: CutholSequence,
  paths: WorkspacePaths,
  prev: { compositions: Record<string, CompKnownState> } | null
): Record<string, CompKnownState> {
  const state: Record<string, CompKnownState> = {};
  for (const comp of listMountedCompositions(seq, paths.rootDir)) {
    const prevComp = prev?.compositions[comp.key];
    const files: Record<string, TrackedFileEntry> = {};
    for (const rel of walkTrackedCompositionFiles(comp.absDir)) {
      const full = path.join(comp.absDir, rel);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const mtimeMs = Math.round(st.mtimeMs * 1000) / 1000;
      const prevEntry = prevComp?.files[rel];
      if (prevEntry && prevEntry.size === st.size && prevEntry.mtime_ms === mtimeMs) {
        files[rel] = prevEntry;
        continue;
      }
      let buf: Buffer;
      try {
        buf = fs.readFileSync(full);
      } catch {
        if (prevEntry) files[rel] = prevEntry;
        continue;
      }
      // Size changed between stat and read: trust the bytes just read.
      const size = buf.length;
      const sha = hashBuffer(buf);
      if (prevEntry && prevEntry.sha === sha) {
        files[rel] = { ...prevEntry, size, mtime_ms: mtimeMs };
        continue;
      }
      if (buf.length <= MAX_STORED_CONTENT_BYTES) ensureContentBlob(paths, sha, buf);
      files[rel] = {
        sha,
        size,
        mtime_ms: mtimeMs,
        stored: buf.length <= MAX_STORED_CONTENT_BYTES,
      };
    }
    state[comp.key] = { dir: comp.key, entry_html: comp.entry_html, cue_ids: comp.cue_ids, files };
  }
  return state;
}

// --- Blob store + manifest files ---

export function extBlobsDir(paths: WorkspacePaths): string {
  return path.join(paths.blobsDir, EXTCHANGE_BLOBS_SUBDIR);
}

export function extStateDir(paths: WorkspacePaths): string {
  return path.join(paths.stateDir, EXTCHANGE_STATE_SUBDIR);
}

export function ensureContentBlob(paths: WorkspacePaths, sha: string, content: Buffer): void {
  const file = path.join(extBlobsDir(paths), sha);
  if (fs.existsSync(file)) return;
  writeFileAtomically(file, content);
}

export function readContentBlob(paths: WorkspacePaths, sha: string): Buffer | null {
  const file = path.join(extBlobsDir(paths), sha);
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function revManifestName(rev: number): string {
  return `rev_${String(rev).padStart(4, "0")}.json`;
}

export function readRevManifest(paths: WorkspacePaths, rev: number): RevCompManifest | null {
  const file = path.join(extStateDir(paths), revManifestName(rev));
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RevCompManifest;
    if (!parsed || parsed.version !== 1 || typeof parsed.compositions !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeRevManifest(
  paths: WorkspacePaths,
  rev: number,
  compositions: Record<string, CompKnownState>
): RevCompManifest {
  const manifest: RevCompManifest = {
    version: 1,
    revision: rev,
    created_at: new Date().toISOString(),
    compositions,
  };
  writeFileAtomically(path.join(extStateDir(paths), revManifestName(rev)), JSON.stringify(manifest));
  return manifest;
}

function revertSidecarName(rev: number): string {
  return `reverted_rev_${String(rev).padStart(4, "0")}.json`;
}

export function readRevertSidecar(paths: WorkspacePaths, rev: number): RevertSidecar | null {
  const file = path.join(extStateDir(paths), revertSidecarName(rev));
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RevertSidecar;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeRevertSidecar(paths: WorkspacePaths, sidecar: RevertSidecar): void {
  writeFileAtomically(
    path.join(extStateDir(paths), revertSidecarName(sidecar.revision)),
    JSON.stringify(sidecar)
  );
}

/** Deletes known-state files of pruned (undone-then-overwritten) revisions. */
export function pruneExtchangeRevisions(paths: WorkspacePaths, prunedRevs: number[]): void {
  const dir = extStateDir(paths);
  for (const rev of prunedRevs) {
    for (const name of [revManifestName(rev), revertSidecarName(rev)]) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        // missing is fine
      }
    }
  }
}

/** Fresh project: drop all known-state files and stored contents. */
export function clearExtchangeState(paths: WorkspacePaths): void {
  for (const dir of [extStateDir(paths), extBlobsDir(paths)]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }
  }
}

// --- Diffing ---

export function diffCompStates(
  prev: Record<string, CompKnownState>,
  curr: Record<string, CompKnownState>
): CompChangeSet[] {
  const out: CompChangeSet[] = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  for (const key of [...keys].sort()) {
    const p = prev[key];
    const c = curr[key];
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    if (p && c) {
      for (const rel of Object.keys(c.files).sort()) {
        const pe = p.files[rel];
        if (!pe) added.push(rel);
        else if (pe.sha !== c.files[rel].sha) modified.push(rel);
      }
      for (const rel of Object.keys(p.files).sort()) {
        if (!c.files[rel]) deleted.push(rel);
      }
    } else if (c && !p) {
      added.push(...Object.keys(c.files).sort());
    } else if (p && !c) {
      deleted.push(...Object.keys(p.files).sort());
    }
    if (added.length + modified.length + deleted.length === 0) continue;
    const shape = c ?? p!;
    out.push({
      key,
      dir: shape.dir,
      entry_html: shape.entry_html,
      cue_ids: shape.cue_ids,
      added,
      modified,
      deleted,
    });
  }
  return out;
}

/** Top-level keys whose canonical JSON differs (for the sequence.json summary). */
export function topLevelKeyDiff(a: unknown, b: unknown): string[] {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return canonicalizeJson(a) === canonicalizeJson(b) ? [] : ["(kök)"];
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  const out: string[] = [];
  for (const k of [...keys].sort()) {
    if (canonicalizeJson(ra[k]) !== canonicalizeJson(rb[k])) out.push(k);
  }
  return out;
}

// --- Detection ---

export interface CursorSequenceBaseline {
  cursor_revision: number;
  snapshot_raw: string | null;
  snapshot_parsed: unknown;
}

/** Journal snapshot at the cursor revision (baseline for `cuthol.sequence.json`). */
export function loadCursorSequenceBaseline(paths: WorkspacePaths): CursorSequenceBaseline {
  const manifest = loadJournalManifest(paths);
  const entry = manifest.entries.find((e) => e.revision === manifest.cursor_revision);
  if (!entry) {
    return { cursor_revision: manifest.cursor_revision, snapshot_raw: null, snapshot_parsed: null };
  }
  const snapPath = path.join(paths.journalDir, entry.snapshot_file);
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(snapPath, "utf8");
  } catch {
    return { cursor_revision: manifest.cursor_revision, snapshot_raw: null, snapshot_parsed: null };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { cursor_revision: manifest.cursor_revision, snapshot_raw: raw, snapshot_parsed: null };
  }
  return { cursor_revision: manifest.cursor_revision, snapshot_raw: raw, snapshot_parsed: parsed };
}

/**
 * Detects out-of-journal edits: composition files added/changed/deleted on
 * disk versus the cursor revision's known state, plus `cuthol.sequence.json`
 * diverging from the journal snapshot. Fast path: size+mtime per file, sha256
 * only for stat-changed files. Never throws for a corrupt sequence file (it
 * reports it); throws only when `dir` holds no Cuthol project at all.
 *
 * First run on a pre-existing project silently records the current disk state
 * as the baseline (grandfathering): otherwise every file would look "added".
 */
export function detectExternalChanges(dir: string): ExternalChanges {
  const paths = resolveWorkspacePaths(dir);
  fs.mkdirSync(extStateDir(paths), { recursive: true });
  fs.mkdirSync(extBlobsDir(paths), { recursive: true });

  if (!fs.existsSync(paths.sequenceFile)) {
    throw new CutholError(DIAGNOSTICS.WORKSPACE_NOT_FOUND(paths.rootDir));
  }
  const diskRaw = fs.readFileSync(paths.sequenceFile, "utf8");
  let diskParsed: CutholSequence | null = null;
  let diskCorrupt: string | null = null;
  try {
    diskParsed = JSON.parse(diskRaw) as CutholSequence;
  } catch (err) {
    diskCorrupt = err instanceof Error ? err.message : String(err);
  }

  const baseline = loadCursorSequenceBaseline(paths);
  const mountSeq =
    diskParsed ?? (baseline.snapshot_parsed as CutholSequence | null) ?? null;

  let compositions: CompChangeSet[] = [];
  let currState: Record<string, CompKnownState> | null = null;
  if (mountSeq) {
    let known = readRevManifest(paths, baseline.cursor_revision);
    if (!known) {
      const state = snapshotCompDiskState(mountSeq, paths, null);
      known = writeRevManifest(paths, baseline.cursor_revision, state);
    }
    currState = snapshotCompDiskState(mountSeq, paths, known);
    compositions = diffCompStates(known.compositions, currState);
  }

  let sequence: SequenceChange | null = null;
  if (diskCorrupt !== null) {
    sequence = {
      status: "corrupt",
      detail: `dosya geçerli bir JSON değil (${diskCorrupt})`,
    };
  } else if (baseline.snapshot_raw !== null && baseline.snapshot_parsed !== null && diskParsed) {
    if (canonicalizeJson(diskParsed) !== canonicalizeJson(baseline.snapshot_parsed)) {
      const keys = topLevelKeyDiff(baseline.snapshot_parsed, diskParsed);
      const diskRev = (diskParsed as { meta?: { revision?: unknown } }).meta?.revision;
      sequence = {
        status: "modified",
        detail:
          keys.length > 0
            ? `farklı üst düzey alanlar: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ` (+${keys.length - 8})` : ""}${typeof diskRev === "number" && diskRev !== baseline.cursor_revision ? ` (diskte r${diskRev}, journal imleci r${baseline.cursor_revision})` : ""}`
            : "içerik journal'daki son durumdan farklı",
      };
    }
  }

  const counts = {
    comps: compositions.length,
    added: compositions.reduce((n, c) => n + c.added.length, 0),
    modified: compositions.reduce((n, c) => n + c.modified.length, 0),
    deleted: compositions.reduce((n, c) => n + c.deleted.length, 0),
    sequence: sequence ? 1 : 0,
  };
  const has_changes =
    compositions.length > 0 || sequence !== null;
  // The digest covers content hashes (not just file lists), so further edits
  // to the same file count as a grown change set (full MCP note again).
  const currShas = (key: string, rels: string[]): Array<[string, string | null]> =>
    rels.map((rel) => [rel, currState?.[key]?.files[rel]?.sha ?? null]);
  const digest = sha12Hex(
    canonicalizeJson({
      s: sequence ? [sequence.status, hashBuffer(Buffer.from(diskRaw, "utf8"))] : null,
      c: compositions.map((c) => [
        c.key,
        currShas(c.key, c.added),
        currShas(c.key, c.modified),
        c.deleted,
      ]),
    })
  );
  return { has_changes, digest, cursor_revision: baseline.cursor_revision, sequence, compositions, counts };
}

// --- Notice texts (Turkish, single line) ---

function formatCount(n: number, singular: string): string {
  return `${n} dosya ${singular}`;
}

function truncateList(items: string[], max: number): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} (+${items.length - max})`;
}

function describeCompChange(c: CompChangeSet): string {
  const parts: string[] = [];
  if (c.modified.length > 0)
    parts.push(`${formatCount(c.modified.length, "değişti")}: ${truncateList(c.modified, 5)}`);
  if (c.added.length > 0)
    parts.push(`${formatCount(c.added.length, "eklendi")}: ${truncateList(c.added, 5)}`);
  if (c.deleted.length > 0)
    parts.push(`${formatCount(c.deleted.length, "silindi")}: ${truncateList(c.deleted, 5)}`);
  return `\`${c.key}\` (${parts.join("; ")})`;
}

/**
 * Full one-line notice. `flavor` picks the command dialect: CLI text for
 * `workspace open` / `brief`, MCP tool syntax for MCP results.
 */
export function formatExternalNotice(
  changes: ExternalChanges,
  flavor: "cli" | "mcp"
): string | null {
  if (!changes.has_changes) return null;
  const parts: string[] = changes.compositions.map(describeCompChange);
  if (changes.sequence) {
    parts.push(
      changes.sequence.status === "corrupt"
        ? `\`cuthol.sequence.json\` bozulmuş (${changes.sequence.detail})`
        : `\`cuthol.sequence.json\` dışarıdan düzenlendi (${changes.sequence.detail})`
    );
  }
  const show = flavor === "cli" ? "`cuthol workspace changes show`" : '`workspace(action="changes_show")`';
  const adopt =
    flavor === "cli" ? "`cuthol workspace changes adopt`" : '`workspace(action="changes_adopt")`';
  const revert =
    flavor === "cli" ? "`cuthol workspace changes revert`" : '`workspace(action="changes_revert")`';
  const prefix = flavor === "cli" ? "> Proje değişikliği tespit edildi: " : "NOTE Proje değişikliği tespit edildi: ";
  return (
    `${prefix}${parts.join("; ")}. ` +
    `Değişiklikleri Cuthol'a yazdıralım mı? ${show} (fark) · ${adopt} (benimse: yeni revizyon, geri alınabilir) · ${revert} (Cuthol'daki son hâle döndür).`
  );
}

/** Single-line MCP reminder for repeat calls while the same change persists. */
export function formatExternalReminder(changes: ExternalChanges): string | null {
  if (!changes.has_changes) return null;
  const total = changes.counts.added + changes.counts.modified + changes.counts.deleted;
  const comps = changes.compositions.map((c) => `\`${c.key}\``).join(", ");
  const seqBit = changes.sequence ? " + `cuthol.sequence.json`" : "";
  return (
    `NOTE Dış değişiklik sürüyor (${changes.digest}: ${comps}${seqBit}, ${total} dosya${seqBit ? " + sekans" : ""}): ` +
    `ayrıntı için \`workspace(action="changes_show")\`.`
  );
}

// --- Unified diff (small dependency-free LCS) ---

function isTextBuffer(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return false;
  }
  return true;
}

export interface FileDiff {
  old_lines: number;
  new_lines: number;
  lines: string[];
  truncated: boolean;
}

/** Short unified diff (`-`/`+` lines with `@@` hunks), capped at `maxLines`. */
export function unifiedDiff(oldText: string, newText: string, maxLines: number): FileDiff {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length * b.length > 4_000_000) {
    return { old_lines: a.length, new_lines: b.length, lines: [`(dosya çok büyük: ${a.length} satır → ${b.length} satır, fark gösterilmiyor)`], truncated: true };
  }
  const hugeLine = (ls: string[]): boolean => ls.some((l) => l.length > 2000);
  if (hugeLine(a) || hugeLine(b)) {
    return { old_lines: a.length, new_lines: b.length, lines: ["(satırlar çok uzun, fark gösterilmiyor)"], truncated: true };
  }
  // LCS table over lines.
  const n = a.length;
  const m = b.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => table[i * (m + 1) + j];
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  // Walk the edit script.
  type Op = { t: " " | "-" | "+"; aIdx: number; bIdx: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", aIdx: i, bIdx: j });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ t: "-", aIdx: i, bIdx: j });
      i++;
    } else {
      ops.push({ t: "+", aIdx: i, bIdx: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ t: "-", aIdx: i, bIdx: j });
    i++;
  }
  while (j < m) {
    ops.push({ t: "+", aIdx: i, bIdx: j });
    j++;
  }
  // Hunks with 3 lines of context.
  const changedIdx = new Set<number>();
  ops.forEach((op, k) => {
    if (op.t !== " ") {
      for (let d = -3; d <= 3; d++) {
        if (k + d >= 0 && k + d < ops.length) changedIdx.add(k + d);
      }
    }
  });
  const lines: string[] = [];
  let truncated = false;
  let k = 0;
  const capLine = (s: string): string => (s.length > 300 ? `${s.slice(0, 300)}…` : s);
  while (k < ops.length) {
    if (!changedIdx.has(k)) {
      k++;
      continue;
    }
    const start = k;
    while (k < ops.length && changedIdx.has(k)) k++;
    const slice = ops.slice(start, k);
    const a0 = slice[0].aIdx;
    const b0 = slice[0].bIdx;
    const a1 = slice[slice.length - 1].aIdx + (slice[slice.length - 1].t === "+" ? 0 : 1);
    const b1 = slice[slice.length - 1].bIdx + (slice[slice.length - 1].t === "-" ? 0 : 1);
    lines.push(`@@ -${a0 + 1},${a1 - a0} +${b0 + 1},${b1 - b0} @@`);
    for (const op of slice) {
      const text = op.t === "+" ? b[op.bIdx] : a[op.aIdx];
      lines.push(`${op.t}${capLine(text)}`);
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }
  return { old_lines: n, new_lines: m, lines, truncated };
}

// --- `workspace changes show` ---

export interface ShowFileDiff {
  rel: string;
  kind: "added" | "modified" | "deleted";
  note: string | null;
  diff: FileDiff | null;
}

export interface ShowComp {
  key: string;
  dir: string;
  entry_html: string;
  cue_ids: string[];
  files: ShowFileDiff[];
}

export interface ShowPayload {
  has_changes: boolean;
  digest: string;
  cursor_revision: number;
  sequence: SequenceChange | null;
  sequence_diff_keys: string[] | null;
  compositions: ShowComp[];
  summary_text: string;
}

/**
 * Matches `--comp` against mounted compositions: stored `composition_dir`,
 * its basename, the absolute path, or a mounting cue id.
 */
export function matchCompFilter(
  seq: CutholSequence,
  rootDir: string,
  filter: string | undefined
): MountedComposition[] {
  const mounts = listMountedCompositions(seq, rootDir);
  if (!filter) return mounts;
  const f = filter.trim();
  const matched = mounts.filter(
    (c) =>
      c.key === f ||
      path.basename(c.key) === f ||
      c.absDir === path.resolve(rootDir, f) ||
      c.absDir === path.resolve(f) ||
      c.cue_ids.includes(f)
  );
  if (matched.length === 0) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(f));
  }
  return matched;
}

export function buildChangesShow(dir: string, compFilter?: string): ShowPayload {
  const paths = resolveWorkspacePaths(dir);
  const changes = detectExternalChanges(dir);
  const diskRaw = fs.readFileSync(paths.sequenceFile, "utf8");
  let diskParsed: CutholSequence | null = null;
  try {
    diskParsed = JSON.parse(diskRaw) as CutholSequence;
  } catch {
    diskParsed = null;
  }
  const baseline = loadCursorSequenceBaseline(paths);
  const mountSeq =
    diskParsed ?? (baseline.snapshot_parsed as CutholSequence | null) ?? null;
  const known = readRevManifest(paths, changes.cursor_revision);
  const allowedKeys = mountSeq
    ? new Set(matchCompFilter(mountSeq, paths.rootDir, compFilter).map((c) => c.key))
    : new Set<string>();

  const comps: ShowComp[] = [];
  let diffBudget = SHOW_DIFF_MAX_FILES;
  for (const c of changes.compositions) {
    if (compFilter && !allowedKeys.has(c.key)) continue;
    const absDir = path.isAbsolute(c.dir) ? c.dir : path.resolve(paths.rootDir, c.dir);
    const prevFiles = known?.compositions[c.key]?.files ?? {};
    const files: ShowFileDiff[] = [];
    const kinds: Array<{ rel: string; kind: "added" | "modified" | "deleted" }> = [
      ...c.modified.map((rel) => ({ rel, kind: "modified" as const })),
      ...c.added.map((rel) => ({ rel, kind: "added" as const })),
      ...c.deleted.map((rel) => ({ rel, kind: "deleted" as const })),
    ];
    for (const { rel, kind } of kinds) {
      let note: string | null = null;
      let diff: FileDiff | null = null;
      const prevEntry = prevFiles[rel];
      const full = path.join(absDir, rel);
      const oldBuf =
        kind === "added" ? Buffer.alloc(0) : prevEntry ? readContentBlob(paths, prevEntry.sha) : null;
      let newBuf: Buffer | null = null;
      if (kind !== "deleted") {
        try {
          newBuf = fs.readFileSync(full);
        } catch {
          newBuf = null;
        }
      } else {
        newBuf = Buffer.alloc(0);
      }
      if ((kind !== "added" && !oldBuf) || (kind !== "deleted" && !newBuf)) {
        note =
          prevEntry && !prevEntry.stored
            ? "(büyük dosya: içeriği saklanmıyor, fark gösterilmiyor)"
            : "(içerik okunamadı)";
      } else if (
        (oldBuf as Buffer).length + (newBuf as Buffer).length > 256 * 1024 ||
        !isTextBuffer(oldBuf as Buffer) ||
        !isTextBuffer(newBuf as Buffer)
      ) {
        note = "(ikili veya büyük dosya, fark gösterilmiyor)";
      } else if (diffBudget > 0) {
        diffBudget--;
        diff = unifiedDiff(
          (oldBuf as Buffer).toString("utf8"),
          (newBuf as Buffer).toString("utf8"),
          SHOW_DIFF_MAX_LINES_PER_FILE
        );
      } else {
        note = `(fark bütçesi doldu; ilk ${SHOW_DIFF_MAX_FILES} dosyanın farkı gösterildi)`;
      }
      files.push({ rel, kind, note, diff });
    }
    comps.push({ key: c.key, dir: c.dir, entry_html: c.entry_html, cue_ids: c.cue_ids, files });
  }

  let sequence_diff_keys: string[] | null = null;
  if (changes.sequence?.status === "modified" && diskParsed && baseline.snapshot_parsed) {
    sequence_diff_keys = topLevelKeyDiff(baseline.snapshot_parsed, diskParsed);
  }

  const scopedChanges = compFilter ? comps.length > 0 || changes.sequence !== null : changes.has_changes;
  const out: string[] = [];
  if (!scopedChanges) {
    out.push("Dış değişiklik yok: disk durumu journal'daki son revizyonla eşleşiyor.");
  } else {
    out.push(`Dış değişiklikler (journal imleci r${changes.cursor_revision}, özet ${changes.digest}):`);
    if (changes.sequence) {
      out.push(
        changes.sequence.status === "corrupt"
          ? `- \`cuthol.sequence.json\`: BOZUK — ${changes.sequence.detail}. \`adopt\` reddedilir; dosyayı düzeltin ya da \`revert\` ile journal'daki son hâle döndürün.`
          : `- \`cuthol.sequence.json\`: dışarıdan düzenlendi — ${changes.sequence.detail}.`
      );
    }
    for (const c of comps) {
      out.push(`- \`${c.key}\` (${c.files.length} dosya):`);
      for (const f of c.files) {
        const tag = f.kind === "added" ? "+" : f.kind === "deleted" ? "-" : "~";
        out.push(`  ${tag} ${f.rel}${f.note ? ` ${f.note}` : ""}`);
        if (f.diff && f.diff.lines.length > 0) {
          for (const dl of f.diff.lines) out.push(`    ${dl}`);
          if (f.diff.truncated) out.push(`    (… fark kesildi, ilk ${SHOW_DIFF_MAX_LINES_PER_FILE} satır)`);
        }
      }
    }
  }
  return {
    has_changes: scopedChanges,
    digest: changes.digest,
    cursor_revision: changes.cursor_revision,
    sequence: changes.sequence,
    sequence_diff_keys,
    compositions: comps,
    summary_text: out.join("\n"),
  };
}

// --- `workspace changes adopt` ---

export interface AdoptResult {
  adopted: boolean;
  revision: number;
  previous_revision: number;
  operation: string;
  adopted_comps: string[];
  adopted_files: number;
  sequence_folded: boolean;
  verification: { ok: boolean; error_count: number; warning_count: number } | null;
  summary_text: string;
}

function describeChangeSetShort(c: CompChangeSet): string {
  const bits: string[] = [];
  if (c.modified.length > 0) bits.push(`~${c.modified.length}`);
  if (c.added.length > 0) bits.push(`+${c.added.length}`);
  if (c.deleted.length > 0) bits.push(`-${c.deleted.length}`);
  return `${c.key} (${bits.join(" ")})`;
}

/**
 * Blesses the current disk state as a new revision. Composition files in
 * scope become the known state; an externally edited `cuthol.sequence.json`
 * is always folded in (commits load it as the base) but only after schema
 * validation and G1–G3 gates pass. `journal undo` of the new revision
 * restores the previous file contents (see `restoreForJournalTraversal`).
 */
export function adoptExternalChanges(dir: string, compFilter?: string): AdoptResult {
  const paths = resolveWorkspacePaths(dir);
  const changes = detectExternalChanges(dir);
  const diskRaw = fs.readFileSync(paths.sequenceFile, "utf8");
  let diskParsed: CutholSequence | null = null;
  let diskCorruptMsg: string | null = null;
  try {
    diskParsed = JSON.parse(diskRaw) as CutholSequence;
  } catch (err) {
    diskCorruptMsg = err instanceof Error ? err.message : String(err);
  }
  const baseline = loadCursorSequenceBaseline(paths);
  const mountSeq =
    diskParsed ?? (baseline.snapshot_parsed as CutholSequence | null) ?? null;
  if (!mountSeq) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_COMPOSITION_CONTRACT(
        "cuthol.sequence.json",
        `dosya geçerli bir JSON değil (${diskCorruptMsg ?? "bilinmeyen ayrıştırma hatası"}); düzeltin ya da 'cuthol workspace changes revert' ile journal'daki son hâle döndürün`
      )
    );
  }
  const allowedKeys = new Set(matchCompFilter(mountSeq, paths.rootDir, compFilter).map((c) => c.key));
  const scoped = changes.compositions.filter((c) => !compFilter || allowedKeys.has(c.key));

  if (!changes.has_changes || (scoped.length === 0 && !changes.sequence)) {
    return {
      adopted: false,
      revision: changes.cursor_revision,
      previous_revision: changes.cursor_revision,
      operation: "workspace.changes.adopt",
      adopted_comps: [],
      adopted_files: 0,
      sequence_folded: false,
      verification: null,
      summary_text: "Benimsenecek dış değişiklik yok.",
    };
  }

  // Sequence part: schema validation + G1–G3 before accepting. A corrupt file
  // is rejected (no existing G1 code names unparseable JSON, so the closest
  // G1 schema/contract diagnostic carries the truthful detail).
  let verification: AdoptResult["verification"] = null;
  if (changes.sequence) {
    if (!diskParsed) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_COMPOSITION_CONTRACT(
          "cuthol.sequence.json",
          `dosya geçerli bir JSON değil (${diskCorruptMsg ?? "bilinmeyen ayrıştırma hatası"}); 'adopt' reddedildi, dosya ve journal değişmedi`
        )
      );
    }
    const report = verifySequence(diskParsed, paths, ["G1_SCHEMA", "G2_ASSETS", "G3_TIMING"]);
    verification = {
      ok: report.ok,
      error_count: report.error_count,
      warning_count: report.warning_count,
    };
    if (!report.ok) {
      const firstError = report.diagnostics.find((d) => d.severity === "ERROR")!;
      throw new CutholError(firstError, report.diagnostics);
    }
  }

  const opBits = scoped.map(describeChangeSetShort);
  if (changes.sequence) opBits.push("cuthol.sequence.json");
  const operation = `${ADOPT_OPERATION_PREFIX}(${opBits.join(", ") || "değişiklik yok"}): dış değişiklik benimsendi`;

  const { revision } = commitSequenceMutation(
    dir,
    operation,
    () => ({ adopted: true }),
    { allowExternalRewrite: true }
  );

  // Bless scoped compositions from post-commit disk (bridge sync runs inside
  // the commit); unscoped compositions keep their carried (still flagged) state.
  const committed = readRevManifest(paths, revision);
  const fresh = snapshotCompDiskState(
    diskParsed as CutholSequence,
    paths,
    committed ?? readRevManifest(paths, changes.cursor_revision)
  );
  const merged: Record<string, CompKnownState> = { ...(committed?.compositions ?? {}) };
  for (const c of scoped) {
    if (fresh[c.key]) merged[c.key] = fresh[c.key];
    else delete merged[c.key];
  }
  writeRevManifest(paths, revision, merged);

  const adoptedFiles = scoped.reduce(
    (n, c) => n + c.added.length + c.modified.length + c.deleted.length,
    0
  );
  return {
    adopted: true,
    revision,
    previous_revision: changes.cursor_revision,
    operation,
    adopted_comps: scoped.map((c) => c.key),
    adopted_files: adoptedFiles,
    sequence_folded: changes.sequence !== null,
    verification,
    summary_text:
      `Dış değişiklik benimsendi → r${revision} (${scoped.map(describeChangeSetShort).join("; ") || "yalnız sekans"}` +
      `${changes.sequence ? "; cuthol.sequence.json katıldı (G1–G3 geçti)" : ""}). ` +
      `'cuthol workspace journal undo' ile geri alınabilir.`,
  };
}

// --- `workspace changes revert` ---

export interface RevertResult {
  reverted: boolean;
  revision: number;
  previous_revision: number;
  operation: string;
  reverted_comps: string[];
  reverted_files: number;
  sequence_restored: boolean;
  summary_text: string;
}

/**
 * Restores disk files to the cursor revision's known state, then records the
 * revert itself as a revision. The pre-revert content is stashed in a sidecar
 * so `journal undo` of the revert revision brings it back. Atomic: when any
 * file cannot be restored (large file whose content was never stored), nothing
 * is written at all.
 */
export function revertExternalChanges(dir: string, compFilter?: string): RevertResult {
  const paths = resolveWorkspacePaths(dir);
  const changes = detectExternalChanges(dir);
  const baseline = loadCursorSequenceBaseline(paths);
  const diskRaw = fs.readFileSync(paths.sequenceFile, "utf8");
  let diskParsed: CutholSequence | null = null;
  try {
    diskParsed = JSON.parse(diskRaw) as CutholSequence;
  } catch {
    diskParsed = null;
  }
  const mountSeq =
    diskParsed ?? (baseline.snapshot_parsed as CutholSequence | null) ?? null;
  const allowedKeys = mountSeq
    ? new Set(matchCompFilter(mountSeq, paths.rootDir, compFilter).map((c) => c.key))
    : new Set<string>();
  const scoped = changes.compositions.filter((c) => !compFilter || allowedKeys.has(c.key));
  // `cuthol.sequence.json` is always in scope (commits fold it): `--comp`
  // narrows only composition files.
  const seqInScope = changes.sequence !== null;

  if (scoped.length === 0 && !seqInScope) {
    return {
      reverted: false,
      revision: changes.cursor_revision,
      previous_revision: changes.cursor_revision,
      operation: "workspace.changes.revert",
      reverted_comps: [],
      reverted_files: 0,
      sequence_restored: false,
      summary_text: "Geri alınacak dış değişiklik yok.",
    };
  }

  const known = readRevManifest(paths, changes.cursor_revision);
  if (!known) {
    throw new Error("Bilinen durum kaydı bulunamadı; önce 'cuthol workspace changes show' çalıştırın.");
  }

  // Validate the whole plan before writing anything (atomicity).
  const unrestorable: string[] = [];
  interface RestoreFile { comp: CompChangeSet; rel: string; kind: "added" | "modified" | "deleted" }
  const plan: RestoreFile[] = [];
  for (const c of scoped) {
    const prevFiles = known.compositions[c.key]?.files ?? {};
    for (const rel of c.modified) {
      plan.push({ comp: c, rel, kind: "modified" });
      const pe = prevFiles[rel];
      if (!pe || (!pe.stored && !readContentBlob(paths, pe.sha))) {
        unrestorable.push(`${c.key}/${rel} (değişti; önceki içerik saklanmıyor — büyük dosya)`);
      } else if (pe.stored && !readContentBlob(paths, pe.sha)) {
        unrestorable.push(`${c.key}/${rel} (önceki içerik kayıp)`);
      }
    }
    for (const rel of c.deleted) {
      plan.push({ comp: c, rel, kind: "deleted" });
      const pe = prevFiles[rel];
      if (!pe || (!pe.stored && !readContentBlob(paths, pe.sha))) {
        unrestorable.push(`${c.key}/${rel} (silindi; önceki içerik saklanmıyor — büyük dosya)`);
      } else if (pe.stored && !readContentBlob(paths, pe.sha)) {
        unrestorable.push(`${c.key}/${rel} (önceki içerik kayıp)`);
      }
    }
    for (const rel of c.added) {
      plan.push({ comp: c, rel, kind: "added" });
    }
  }
  if (seqInScope && baseline.snapshot_raw === null) {
    unrestorable.push("cuthol.sequence.json (journal anlık görüntüsü yok)");
  }
  if (unrestorable.length > 0) {
    throw new Error(
      `'revert' durduruldu: bazı dosyalar geri yüklenemez (hiçbir şey yazılmadı):\n- ${unrestorable.join("\n- ")}\n` +
        `Büyük dosyaları elle eski hâline getirin ya da 'cuthol workspace changes adopt' ile benimseyin.`
    );
  }

  // Stash pre-revert contents (content-addressed; the sidecar references them).
  const sidecarFiles: RevertSidecarFile[] = [];
  for (const { comp, rel, kind } of plan) {
    if (kind === "deleted") {
      sidecarFiles.push({ comp: comp.key, rel, sha: null, size: 0, blob: null, kind });
      continue;
    }
    const absDir = path.isAbsolute(comp.dir) ? comp.dir : path.resolve(paths.rootDir, comp.dir);
    const buf = fs.readFileSync(path.join(absDir, rel));
    const sha = hashBuffer(buf);
    let blob: string | null = null;
    if (buf.length <= MAX_STORED_CONTENT_BYTES) {
      ensureContentBlob(paths, sha, buf);
      blob = sha;
    }
    sidecarFiles.push({ comp: comp.key, rel, sha, size: buf.length, blob, kind });
  }
  let sequenceBlob: string | null = null;
  if (seqInScope) {
    const buf = Buffer.from(diskRaw, "utf8");
    const sha = hashBuffer(buf);
    ensureContentBlob(paths, sha, buf);
    sequenceBlob = sha;
  }

  // Restore disk to the known state.
  for (const { comp, rel, kind } of plan) {
    const absDir = path.isAbsolute(comp.dir) ? comp.dir : path.resolve(paths.rootDir, comp.dir);
    const full = path.join(absDir, rel);
    if (kind === "added") {
      try {
        fs.unlinkSync(full);
      } catch {
        // already gone
      }
      continue;
    }
    const pe = known.compositions[comp.key]?.files[rel];
    const content = pe ? readContentBlob(paths, pe.sha) : null;
    if (!pe || !content) {
      throw new Error(`İçerik kaybı: ${comp.key}/${rel} geri yüklenemedi (hiçbir revizyon yazılmadı).`);
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    writeFileAtomically(full, content);
  }
  if (seqInScope) {
    writeFileAtomically(paths.sequenceFile, baseline.snapshot_raw as string);
  }

  const opBits = scoped.map(describeChangeSetShort);
  if (seqInScope) opBits.push("cuthol.sequence.json");
  const operation = `${REVERT_OPERATION_PREFIX}(${opBits.join(", ")}): dış değişiklik geri alındı`;

  const { revision } = commitSequenceMutation(
    dir,
    operation,
    () => ({ reverted: true }),
    { allowExternalRewrite: true }
  );

  writeRevertSidecar(paths, {
    version: 1,
    revision,
    created_at: new Date().toISOString(),
    operation,
    sequence_blob: sequenceBlob,
    files: sidecarFiles,
  });

  const revertedFiles = plan.length;
  return {
    reverted: true,
    revision,
    previous_revision: changes.cursor_revision,
    operation,
    reverted_comps: scoped.map((c) => c.key),
    reverted_files: revertedFiles,
    sequence_restored: seqInScope,
    summary_text:
      `Dış değişiklik geri alındı → r${revision} (${scoped.map(describeChangeSetShort).join("; ") || "yalnız sekans"}` +
      `${seqInScope ? "; cuthol.sequence.json journal'daki hâle döndü" : ""}). ` +
      `Bu revert de bir revizyon: 'cuthol workspace journal undo' revert-öncesi içeriği geri getirir.`,
  };
}

// --- Journal integration: commit guards ---

export interface CommitPrestate {
  cursor_revision: number;
  /** Known state at the cursor (grandfathered from disk when missing). */
  prevManifest: RevCompManifest;
  /** Disk state captured before the mutator ran. */
  before: Record<string, CompKnownState>;
  /** Pending external changes at capture time. */
  pending: CompChangeSet[];
  /** True when disk `cuthol.sequence.json` differs from the cursor snapshot. */
  sequenceFolded: boolean;
}

/**
 * Captures composition disk state before a journal mutator runs. When
 * `stashPending` is set, the current content of externally-changed files is
 * stored so it can be restored if the mutator overwrites it (G211).
 */
export function captureCommitPrestate(
  paths: WorkspacePaths,
  seq: CutholSequence,
  options: { stashPending?: boolean } = {}
): CommitPrestate {
  const baseline = loadCursorSequenceBaseline(paths);
  let prevManifest = readRevManifest(paths, baseline.cursor_revision);
  if (!prevManifest) {
    prevManifest = writeRevManifest(
      paths,
      baseline.cursor_revision,
      snapshotCompDiskState(seq, paths, null)
    );
  }
  const before = snapshotCompDiskState(seq, paths, prevManifest);
  const pending = diffCompStates(prevManifest.compositions, before);
  if (options.stashPending) {
    for (const c of pending) {
      const absDir = path.isAbsolute(c.dir) ? c.dir : path.resolve(paths.rootDir, c.dir);
      for (const rel of [...c.modified, ...c.added]) {
        const entry = before[c.key]?.files[rel];
        if (!entry || !entry.stored) continue;
        if (readContentBlob(paths, entry.sha)) continue;
        try {
          const buf = fs.readFileSync(path.join(absDir, rel));
          if (buf.length <= MAX_STORED_CONTENT_BYTES) ensureContentBlob(paths, entry.sha, buf);
        } catch {
          // unreadable now; the overwrite check will report it
        }
      }
    }
  }
  let sequenceFolded = false;
  if (baseline.snapshot_raw !== null && baseline.snapshot_parsed !== null) {
    sequenceFolded = canonicalizeJson(seq) !== canonicalizeJson(baseline.snapshot_parsed);
  }
  return {
    cursor_revision: baseline.cursor_revision,
    prevManifest,
    before,
    pending,
    sequenceFolded,
  };
}

/**
 * Post-mutator G211 check: a Cuthol commit must not silently overwrite
 * externally-changed composition files (e.g. an extension sync inside the
 * mutator rewriting the entry HTML). Overwritten files are restored from the
 * pre-mutator stash and the commit is refused. Call before any journal write.
 */
export function assertMutatorKeptExternalFiles(paths: WorkspacePaths, prestate: CommitPrestate): void {
  if (prestate.pending.length === 0) return;
  const overwritten: string[] = [];
  const unrestored: string[] = [];
  for (const c of prestate.pending) {
    const absDir = path.isAbsolute(c.dir) ? c.dir : path.resolve(paths.rootDir, c.dir);
    for (const rel of [...c.modified, ...c.added]) {
      const beforeEntry = prestate.before[c.key]?.files[rel];
      if (!beforeEntry) continue;
      let nowSha: string | null = null;
      try {
        nowSha = hashBuffer(fs.readFileSync(path.join(absDir, rel)));
      } catch {
        nowSha = null;
      }
      if (nowSha === beforeEntry.sha) continue;
      overwritten.push(`${c.key}/${rel}`);
      const stashed = beforeEntry.stored ? readContentBlob(paths, beforeEntry.sha) : null;
      if (stashed) {
        try {
          fs.mkdirSync(path.join(absDir, path.dirname(rel)), { recursive: true });
          writeFileAtomically(path.join(absDir, rel), stashed);
        } catch {
          unrestored.push(`${c.key}/${rel}`);
        }
      } else {
        unrestored.push(`${c.key}/${rel} (büyük dosya, önceki içerik saklanmıyor)`);
      }
    }
  }
  if (overwritten.length === 0) return;
  throw new CutholError(
    DIAGNOSTICS.EXTERNAL_CHANGE_WOULD_BE_OVERWRITTEN(
      overwritten.slice(0, 5).join(", ") + (overwritten.length > 5 ? ` (+${overwritten.length - 5})` : ""),
      `bu Cuthol işlemi dışarıdan değiştirilmiş dosyaların üzerine yazacaktı; işlem durduruldu, dosya(lar) eski hâline döndürüldü` +
        (unrestored.length > 0 ? ` (geri döndürülemeyen: ${unrestored.slice(0, 3).join(", ")})` : "")
    )
  );
}

// --- Bridge entry-HTML rewrite prediction (read-only mirror of bridge_exporter step 4/4b) ---

const EXACT_DATA_TAG_RE = /<script\s+src=(["'])assets\/cuthol-data\.js\1\s*><\/script>/i;
const EXACT_RUNTIME_TAG_RE = /<script\s+src=(["'])assets\/cuthol-runtime\.js\1\s*><\/script>/i;

function exactHelperTagRe(extName: string): RegExp {
  return new RegExp(`<script\\s+src=(["'])assets\\/cuthol-ext-${extName}\\.js\\1\\s*><\\/script>`, "i");
}

const STALE_HELPER_TAG_RE =
  /[ \t]*<script\s+src=(["'])assets\/cuthol-ext-([a-z0-9_-]+)\.js\1\s*><\/script>\r?\n?/gi;

/**
 * Would `syncCompositionBridgeFiles` rewrite this entry HTML? Replicates the
 * tag-presence/order predicate of `bridge_exporter.ts` (step 4: data/runtime
 * tags; step 4b: active helper tags + stale helper removal) without writing.
 */
export function bridgeWouldRewriteEntryHtml(html: string, activeHelperNames: string[]): boolean {
  const dataMatch = EXACT_DATA_TAG_RE.exec(html);
  const runtimeMatch = EXACT_RUNTIME_TAG_RE.exec(html);
  const dataIdx = dataMatch ? dataMatch.index : -1;
  const runtimeIdx = runtimeMatch ? runtimeMatch.index : -1;
  let nextHtml = html;
  if (dataIdx === -1 && runtimeIdx === -1) {
    if (/<template[\s>]/i.test(html) && /<script[\s>]/i.test(html)) {
      nextHtml = html.replace(/<script[\s>]/i, `__DATA__\n      __RUNTIME__\n      $&`);
    } else if (/<\/head>/i.test(html)) {
      nextHtml = html.replace(/<\/head>/i, `    __DATA__\n    __RUNTIME__\n  </head>`);
    } else if (/<script[\s>]/i.test(html)) {
      nextHtml = html.replace(/<script[\s>]/i, `__DATA__\n__RUNTIME__\n$&`);
    }
  } else if (dataIdx === -1 || runtimeIdx === -1 || runtimeIdx < dataIdx) {
    return true;
  }
  if (nextHtml !== html) return true;
  const activeSet = new Set(activeHelperNames);
  STALE_HELPER_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STALE_HELPER_TAG_RE.exec(nextHtml)) !== null) {
    if (!activeSet.has(m[2])) return true;
  }
  STALE_HELPER_TAG_RE.lastIndex = 0;
  for (const extName of activeHelperNames) {
    if (!exactHelperTagRe(extName).test(nextHtml)) return true;
  }
  return false;
}

function activeExtensionHelperNames(seq: CutholSequence, rootDir: string): string[] {
  const names: string[] = [];
  for (const ref of seq.extensions ?? []) {
    try {
      const ext = resolveExtension(ref.name, rootDir);
      if (ext.helperRelPath && fs.existsSync(path.join(ext.dir, ext.helperRelPath))) {
        names.push(ext.name);
      }
    } catch {
      // unresolved here; Gate 2 reports it
    }
  }
  return names;
}

/**
 * Pre-commit G211 check: the trailing bridge sync must not silently revert
 * the user's own edit to an externally-changed entry HTML (re-added deleted
 * script tags, restored tag order, removed a user-added stale helper tag).
 * Pure tag additions (first-time injection) are allowed: they preserve user
 * content and are reported by detection until adopted. Call before any journal
 * write. Purely predictive (reads only); `adopt`/`revert` commits bypass it
 * because they resolve the external change by blessing the post-sync state.
 */
export function assertBridgeWontRewriteExternal(
  paths: WorkspacePaths,
  seqNew: CutholSequence,
  prestate: CommitPrestate
): void {
  if (prestate.pending.length === 0) return;
  let helpers: string[] | null = null;
  for (const c of prestate.pending) {
    if (!c.modified.includes(c.entry_html) && !c.added.includes(c.entry_html)) continue;
    const absDir = path.isAbsolute(c.dir) ? c.dir : path.resolve(paths.rootDir, c.dir);
    let diskHtml: string | null = null;
    try {
      diskHtml = fs.readFileSync(path.join(absDir, c.entry_html), "utf8");
    } catch {
      continue;
    }
    if (helpers === null) helpers = activeExtensionHelperNames(seqNew, paths.rootDir);
    if (!bridgeWouldRewriteEntryHtml(diskHtml, helpers)) continue;
    // A rewrite is predicted. Block only when it would revert the user's edit.
    const knownEntry = prestate.prevManifest.compositions[c.key]?.files[c.entry_html];
    const knownHtml =
      knownEntry?.stored === true
        ? readContentBlob(paths, knownEntry.sha)?.toString("utf8") ?? null
        : null;
    if (knownHtml === null || bridgeRewriteRevertsUserEdit(knownHtml, diskHtml, helpers)) {
      const lost = knownHtml === null ? "bilinen içerik saklanmıyor" : "kullanıcının düzenlemesi geri döndürülecekti";
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_CHANGE_WOULD_BE_OVERWRITTEN(
          `${c.key}/${c.entry_html}`,
          `Cuthol köprü eşitleme dışarıdan değiştirilmiş giriş HTML'ini yeniden yazacaktı (${lost}); işlem durduruldu, dosya değişmedi`
        )
      );
    }
  }
}

function tagOrder(html: string): number {
  const d = EXACT_DATA_TAG_RE.exec(html);
  const r = EXACT_RUNTIME_TAG_RE.exec(html);
  if (!d || !r) return 0;
  return d.index < r.index ? 1 : -1;
}

/**
 * True when the bridge's entry-HTML rewrite would revert part of the user's
 * own diff (deleted tags, swapped order, user-added stale helper tag).
 * Pure additions onto a file that never had the tags are allowed.
 */
export function bridgeRewriteRevertsUserEdit(
  knownHtml: string,
  diskHtml: string,
  activeHelperNames: string[]
): boolean {
  const knownHasData = EXACT_DATA_TAG_RE.test(knownHtml);
  const diskHasData = EXACT_DATA_TAG_RE.test(diskHtml);
  const knownHasRuntime = EXACT_RUNTIME_TAG_RE.test(knownHtml);
  const diskHasRuntime = EXACT_RUNTIME_TAG_RE.test(diskHtml);
  if ((knownHasData && !diskHasData) || (knownHasRuntime && !diskHasRuntime)) return true;
  if (knownHasData && knownHasRuntime && diskHasData && diskHasRuntime) {
    if (tagOrder(knownHtml) === 1 && tagOrder(diskHtml) === -1) return true;
  }
  for (const name of activeHelperNames) {
    const re = exactHelperTagRe(name);
    if (re.test(knownHtml) && !re.test(diskHtml)) return true;
  }
  // Stale helper tags the user added themselves would be removed by the sync.
  const staleNames = (html: string): Set<string> => {
    const out = new Set<string>();
    STALE_HELPER_TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STALE_HELPER_TAG_RE.exec(html)) !== null) {
      if (!activeHelperNames.includes(m[2])) out.add(m[2]);
    }
    STALE_HELPER_TAG_RE.lastIndex = 0;
    return out;
  };
  const knownStale = staleNames(knownHtml);
  for (const name of staleNames(diskHtml)) {
    if (!knownStale.has(name)) return true;
  }
  return false;
}

/**
 * Records the new revision's known state after the trailing bridge sync.
 * Carry rule per file: when the pre-mutator disk matched the previous known
 * state, the post-sync disk becomes known (absorbs Cuthol's own writes);
 * otherwise the previous entry is carried so the external change keeps being
 * reported. Newly mounted compositions are recorded from disk.
 */
export function finalizeCommitManifest(
  paths: WorkspacePaths,
  newRevision: number,
  seqNew: CutholSequence,
  prestate: CommitPrestate
): RevCompManifest {
  const after = snapshotCompDiskState(seqNew, paths, { compositions: prestate.before });
  const merged: Record<string, CompKnownState> = {};
  for (const [key, afterComp] of Object.entries(after)) {
    const prevComp = prestate.prevManifest.compositions[key];
    const beforeComp = prestate.before[key];
    if (!prevComp || !beforeComp) {
      merged[key] = afterComp;
      continue;
    }
    const files: Record<string, TrackedFileEntry> = {};
    for (const [rel, afterEntry] of Object.entries(afterComp.files)) {
      const prevEntry = prevComp.files[rel];
      const beforeEntry = beforeComp.files[rel];
      if (!prevEntry || !beforeEntry) {
        files[rel] = afterEntry;
      } else if (beforeEntry.sha === prevEntry.sha) {
        files[rel] = afterEntry;
      } else {
        files[rel] = prevEntry;
      }
    }
    for (const [rel, prevEntry] of Object.entries(prevComp.files)) {
      if (files[rel] || afterComp.files[rel]) continue;
      const beforeEntry = beforeComp.files[rel];
      // Deleted from disk after the commit: Cuthol's own deletion is absorbed,
      // an external deletion keeps being reported.
      if (!beforeEntry || beforeEntry.sha === prevEntry.sha) continue;
      files[rel] = prevEntry;
    }
    merged[key] = { ...afterComp, files };
  }
  // Compositions mounted before but no longer mounted are dropped (an
  // unmounted folder is not tracked), matching pre-change behaviour.
  return writeRevManifest(paths, newRevision, merged);
}

/**
 * `updateSequenceInPlace` (analysis cache writes) runs the bridge sync without
 * creating a revision. When no external change was pending before, the sync's
 * own tag injections are absorbed into the cursor manifest; otherwise the
 * manifest is left untouched so the external change keeps being reported.
 */
export function refreshManifestIfWasClean(
  paths: WorkspacePaths,
  seqNew: CutholSequence,
  prestate: CommitPrestate
): void {
  if (prestate.pending.length > 0) return;
  const after = snapshotCompDiskState(seqNew, paths, prestate.prevManifest);
  writeRevManifest(paths, prestate.cursor_revision, after);
}

// --- Journal integration: undo/redo file restore (adopt/revert revisions) ---

export interface TraversalRestoreNote {
  revision: number;
  note: string;
}

function hashDiskFile(full: string): string | null {
  try {
    return hashBuffer(fs.readFileSync(full));
  } catch {
    return null;
  }
}

function writeRestoredFile(absDir: string, rel: string, content: Buffer): void {
  const full = path.join(absDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  writeFileAtomically(full, content);
}

/**
 * Restores composition files (and the sequence file for reverts) when
 * `journal undo/redo` traverses adopt/revert revisions. Only files whose
 * expected content changed between the two revisions are touched, and only
 * when the disk still holds the expected "from" content — a newer external
 * edit on top is never overwritten (it is skipped with a note and keeps being
 * reported by detection). Returns per-revision notes for the undo summary.
 */
export function restoreForJournalTraversal(
  paths: WorkspacePaths,
  direction: "undo" | "redo",
  traversedRevisions: number[],
  operations: Map<number, string>,
  targetRevision: number
): TraversalRestoreNote[] {
  const notes: TraversalRestoreNote[] = [];
  for (const rev of traversedRevisions) {
    const op = operations.get(rev) ?? "";
    if (op.startsWith(ADOPT_OPERATION_PREFIX)) {
      const note = restoreAdoptTraversal(paths, direction, rev);
      if (note) notes.push({ revision: rev, note });
    } else if (op.startsWith(REVERT_OPERATION_PREFIX)) {
      const note = restoreRevertTraversal(paths, direction, rev, targetRevision);
      if (note) notes.push({ revision: rev, note });
    }
  }
  return notes;
}

function restoreAdoptTraversal(
  paths: WorkspacePaths,
  direction: "undo" | "redo",
  rev: number
): string | null {
  const fromRev = direction === "undo" ? rev : rev - 1;
  const toRev = direction === "undo" ? rev - 1 : rev;
  const fromManifest = readRevManifest(paths, fromRev);
  const toManifest = readRevManifest(paths, toRev);
  if (!fromManifest || !toManifest) return null;
  const changed = diffCompStates(fromManifest.compositions, toManifest.compositions);
  // Note: diff(from, to) kinds are from→to; undo(adopt) goes rev→rev-1.
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const c of changed) {
    const absDir = path.isAbsolute(c.dir) ? c.dir : path.resolve(paths.rootDir, c.dir);
    const fromFiles = fromManifest.compositions[c.key]?.files ?? {};
    const toFiles = toManifest.compositions[c.key]?.files ?? {};
    const apply = (rel: string, kind: "added" | "modified" | "deleted"): void => {
      const full = path.join(absDir, rel);
      if (kind === "added") {
        // to-state has the file, from-state lacks it: create when still absent.
        if (fs.existsSync(full)) {
          skipped.push(`${c.key}/${rel} (yeniden oluşturulmuş, dokunulmadı)`);
          return;
        }
        const content = toFiles[rel]?.stored ? readContentBlob(paths, toFiles[rel].sha) : null;
        if (!content) {
          skipped.push(`${c.key}/${rel} (içerik saklanmıyor — büyük dosya)`);
          return;
        }
        writeRestoredFile(absDir, rel, content);
        restored.push(`${c.key}/${rel}`);
        return;
      }
      if (kind === "deleted") {
        // to-state lacks the file: delete only when disk still matches from-state.
        const expect = fromFiles[rel];
        if (!expect || hashDiskFile(full) !== expect.sha) {
          skipped.push(`${c.key}/${rel} (üzerine yeni değişiklik yapılmış, silinmedi)`);
          return;
        }
        try {
          fs.unlinkSync(full);
          restored.push(`${c.key}/${rel}`);
        } catch {
          skipped.push(`${c.key}/${rel} (silinemedi)`);
        }
        return;
      }
      const expect = fromFiles[rel];
      const target = toFiles[rel];
      if (!expect || !target) {
        skipped.push(`${c.key}/${rel} (beklenen durum yok)`);
        return;
      }
      if (hashDiskFile(full) !== expect.sha) {
        skipped.push(`${c.key}/${rel} (üzerine yeni değişiklik yapılmış, korunuyor)`);
        return;
      }
      if (!target.stored) {
        skipped.push(`${c.key}/${rel} (hedef içerik saklanmıyor — büyük dosya)`);
        return;
      }
      const content = readContentBlob(paths, target.sha);
      if (!content) {
        skipped.push(`${c.key}/${rel} (hedef içerik kayıp)`);
        return;
      }
      writeRestoredFile(absDir, rel, content);
      restored.push(`${c.key}/${rel}`);
    };
    // `diffCompStates(from, to)`: added = in to only, deleted = in from only.
    for (const rel of c.added) apply(rel, "added");
    for (const rel of c.deleted) apply(rel, "deleted");
    for (const rel of c.modified) apply(rel, "modified");
  }
  if (restored.length === 0 && skipped.length === 0) return null;
  const bits: string[] = [];
  if (restored.length > 0) bits.push(`kompozisyon dosyaları r${toRev} hâline döndürüldü (${restored.length} dosya)`);
  if (skipped.length > 0) bits.push(`korunan/atlanan: ${skipped.slice(0, 4).join("; ")}${skipped.length > 4 ? ` (+${skipped.length - 4})` : ""}`);
  return bits.join("; ");
}

function restoreRevertTraversal(
  paths: WorkspacePaths,
  direction: "undo" | "redo",
  rev: number,
  targetRevision: number
): string | null {
  const sidecar = readRevertSidecar(paths, rev);
  const manifest = readRevManifest(paths, rev);
  if (!sidecar || !manifest) return null;
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const f of sidecar.files) {
    const compState = manifest.compositions[f.comp];
    const absDir = compState
      ? path.isAbsolute(compState.dir)
        ? compState.dir
        : path.resolve(paths.rootDir, compState.dir)
      : path.isAbsolute(f.comp)
        ? f.comp
        : path.resolve(paths.rootDir, f.comp);
    const full = path.join(absDir, f.rel);
    if (direction === "undo") {
      // Bring back the pre-revert disk content; expect the reverted (r`rev`) state.
      if (f.kind === "added") {
        // Pre-revert the file existed (revert deleted it): recreate when still absent.
        if (fs.existsSync(full)) {
          skipped.push(`${f.comp}/${f.rel} (yeniden oluşturulmuş, dokunulmadı)`);
          continue;
        }
        if (!f.blob) {
          skipped.push(`${f.comp}/${f.rel} (revert-öncesi içerik saklanmıyor — büyük dosya)`);
          continue;
        }
        const content = readContentBlob(paths, f.blob);
        if (!content) {
          skipped.push(`${f.comp}/${f.rel} (revert-öncesi içerik kayıp)`);
          continue;
        }
        writeRestoredFile(absDir, f.rel, content);
        restored.push(`${f.comp}/${f.rel}`);
        continue;
      }
      if (f.kind === "deleted") {
        // Pre-revert the file was absent (revert recreated it): delete when unchanged.
        const expect = compState?.files[f.rel];
        if (!expect || hashDiskFile(full) !== expect.sha) {
          skipped.push(`${f.comp}/${f.rel} (üzerine yeni değişiklik yapılmış, silinmedi)`);
          continue;
        }
        try {
          fs.unlinkSync(full);
          restored.push(`${f.comp}/${f.rel}`);
        } catch {
          skipped.push(`${f.comp}/${f.rel} (silinemedi)`);
        }
        continue;
      }
      const expect = compState?.files[f.rel];
      if (!expect || hashDiskFile(full) !== expect.sha) {
        skipped.push(`${f.comp}/${f.rel} (üzerine yeni değişiklik yapılmış, korunuyor)`);
        continue;
      }
      if (!f.blob) {
        skipped.push(`${f.comp}/${f.rel} (revert-öncesi içerik saklanmıyor — büyük dosya)`);
        continue;
      }
      const content = readContentBlob(paths, f.blob);
      if (!content) {
        skipped.push(`${f.comp}/${f.rel} (revert-öncesi içerik kayıp)`);
        continue;
      }
      writeRestoredFile(absDir, f.rel, content);
      restored.push(`${f.comp}/${f.rel}`);
    } else {
      // Redo the revert: expect the pre-revert (sidecar) state, write r`rev` state.
      if (f.kind === "added") {
        if (f.sha === null || hashDiskFile(full) !== f.sha) {
          skipped.push(`${f.comp}/${f.rel} (revert-öncesi içerikten farklı, silinmedi)`);
          continue;
        }
        try {
          fs.unlinkSync(full);
          restored.push(`${f.comp}/${f.rel}`);
        } catch {
          skipped.push(`${f.comp}/${f.rel} (silinemedi)`);
        }
        continue;
      }
      if (f.kind === "deleted") {
        if (fs.existsSync(full)) {
          skipped.push(`${f.comp}/${f.rel} (yeniden oluşturulmuş, dokunulmadı)`);
          continue;
        }
        const target = compState?.files[f.rel];
        const content = target?.stored ? readContentBlob(paths, target.sha) : null;
        if (!target || !content) {
          skipped.push(`${f.comp}/${f.rel} (hedef içerik yok)`);
          continue;
        }
        writeRestoredFile(absDir, f.rel, content);
        restored.push(`${f.comp}/${f.rel}`);
        continue;
      }
      if (f.sha === null || hashDiskFile(full) !== f.sha) {
        skipped.push(`${f.comp}/${f.rel} (revert-öncesi içerikten farklı, korunuyor)`);
        continue;
      }
      const target = compState?.files[f.rel];
      const content = target?.stored ? readContentBlob(paths, target.sha) : null;
      if (!target || !content) {
        skipped.push(`${f.comp}/${f.rel} (hedef içerik yok)`);
        continue;
      }
      writeRestoredFile(absDir, f.rel, content);
      restored.push(`${f.comp}/${f.rel}`);
    }
  }
  // Sequence file part. stepJournal already wrote the traversal target
  // snapshot, so only one case needs action: undo landing exactly on the
  // revert's parent (target == rev-1) brings back the pre-revert raw bytes.
  // (Redo of a revert needs nothing: snapshot(rev) already is the reverted
  // state. Undo past the revert keeps snapshot(target): restoring older
  // pre-revert bytes there would clobber the traversal target.)
  if (sidecar.sequence_blob && direction === "undo" && targetRevision === rev - 1) {
    const preRevertRaw = readContentBlob(paths, sidecar.sequence_blob)?.toString("utf8") ?? null;
    if (preRevertRaw === null) {
      skipped.push("cuthol.sequence.json (revert-öncesi içerik kayıp)");
    } else {
      let diskRaw: string | null = null;
      try {
        diskRaw = fs.readFileSync(paths.sequenceFile, "utf8");
      } catch {
        diskRaw = null;
      }
      const expectRaw = snapshotRawForRevision(paths, rev - 1);
      if (diskRaw !== null && expectRaw !== null && diskRaw === expectRaw) {
        writeFileAtomically(paths.sequenceFile, preRevertRaw);
        restored.push("cuthol.sequence.json");
      } else {
        skipped.push("cuthol.sequence.json (beklenen durumdan farklı, korunuyor)");
      }
    }
  }
  if (restored.length === 0 && skipped.length === 0) return null;
  const bits: string[] = [];
  if (restored.length > 0) bits.push(`r${rev} revert kaydı uygulandı (${restored.length} dosya)`);
  if (skipped.length > 0) bits.push(`korunan/atlanan: ${skipped.slice(0, 4).join("; ")}${skipped.length > 4 ? ` (+${skipped.length - 4})` : ""}`);
  return bits.join("; ");
}

function snapshotRawForRevision(paths: WorkspacePaths, rev: number): string | null {
  const manifest = loadJournalManifest(paths);
  const entry = manifest.entries.find((e) => e.revision === rev);
  if (!entry) return null;
  try {
    return fs.readFileSync(path.join(paths.journalDir, entry.snapshot_file), "utf8");
  } catch {
    return null;
  }
}






