import fs from "node:fs";
import path from "node:path";
import { diffSequenceJson } from "../core/external_changes.js";
import { computeSequenceDurationMs } from "../core/timeline.js";
import { loadJournalManifest, loadSequence, type JournalEntry } from "../core/workspace.js";
import { readLiveLock, resolveRevisionActor } from "./live_lock.js";
import { computeSceneThumbKey, setSceneThumbProjectDir } from "./live_thumbs.js";
import { resolveLivePaths } from "./live_paths.js";
import { LIVE_SCHEMA, type LiveActivityEntry, type LiveDelta, type LiveProgress, type LiveSceneSummary, type LiveSnapshot } from "./live_types.js";

/** One spine clip / lane cue per id, compared by serialized content. */
export interface ChangedHandles {
  changed: string[];
  addedSpine: string[];
  removedSpine: string[];
  addedCues: string[];
  removedCues: string[];
}

function clipsById(seq: any): Map<string, any> {
  const m = new Map<string, any>();
  for (const c of seq?.spine?.clips ?? []) if (c && typeof c.id === "string") m.set(c.id, c);
  return m;
}

function cuesById(seq: any): Map<string, { cue: any; laneId: string }> {
  const m = new Map<string, { cue: any; laneId: string }>();
  for (const lane of seq?.lanes ?? []) {
    for (const cue of lane?.cues ?? []) {
      if (cue && typeof cue.id === "string") m.set(cue.id, { cue, laneId: lane.id });
    }
  }
  return m;
}

/** Spine clip and cue handles that differ between two sequence documents. */
export function diffHandles(oldSeq: unknown, newSeq: unknown): ChangedHandles {
  const out: ChangedHandles = { changed: [], addedSpine: [], removedSpine: [], addedCues: [], removedCues: [] };
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      out.changed.push(id);
    }
  };
  const oldClips = clipsById(oldSeq);
  const newClips = clipsById(newSeq);
  for (const [id, c] of newClips) {
    const p = oldClips.get(id);
    if (!p) {
      out.addedSpine.push(id);
      push(id);
    } else if (JSON.stringify(p) !== JSON.stringify(c)) {
      push(id);
    }
  }
  for (const id of oldClips.keys()) {
    if (!newClips.has(id)) {
      out.removedSpine.push(id);
      push(id);
    }
  }
  const oldCues = cuesById(oldSeq);
  const newCues = cuesById(newSeq);
  for (const [id, e] of newCues) {
    const p = oldCues.get(id);
    if (!p) {
      out.addedCues.push(id);
      push(id);
    } else if (JSON.stringify(p.cue) !== JSON.stringify(e.cue)) {
      push(id);
    }
  }
  for (const id of oldCues.keys()) {
    if (!newCues.has(id)) {
      out.removedCues.push(id);
      push(id);
    }
  }
  return out;
}

/** `spine.trim(sp_03)` -> `spine.trim`; `lane.add-cue` -> `lane.add`. */
export function shortOperation(operation: string): string {
  const base = operation.split("(")[0].trim() || operation;
  switch (base) {
    case "lane.add-cue":
    case "lane.add-composition":
      return "lane.add";
    case "lane.remove-cue":
    case "lane.remove-cues":
      return "lane.remove";
    case "lane.update-cue":
      return "lane.update";
    case "journal.undo":
      return "undo";
    case "journal.redo":
      return "redo";
    default:
      return base;
  }
}

function formatDeltaMs(deltaMs: number): string {
  const abs = Math.abs(Math.round(deltaMs));
  const sign = deltaMs < 0 ? "−" : "+";
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}s`;
  return `${sign}${abs}ms`;
}

function cueDetail(cue: any): string {
  if (cue?.composition) return `(composition ${cue.composition.composition_dir ?? "?"})`;
  if (cue?.asset_handle) return `(${cue.kind ?? "cue"} ${cue.asset_handle})`;
  // Titles carry typography too, so the kind — not the payload shape — decides.
  return `(${cue?.kind ?? "cue"})`;
}

/**
 * One-line human summary of a revision, e.g. `spine.trim sp_03 −1.0s`,
 * `lane.add cue_13 (composition comps/title)`, `speech.captions +23 captions`.
 */
export function summarizeRevision(oldSeq: unknown, newSeq: unknown, operation: string): { summary: string; changed: string[] } {
  const diff = diffHandles(oldSeq, newSeq);
  const op = shortOperation(operation);
  const changed = diff.changed;

  if (op === "spine.trim" && changed.length >= 1) {
    const id = changed[0];
    const before = clipsById(oldSeq).get(id);
    const after = clipsById(newSeq).get(id);
    if (before && after && before.duration_ms !== after.duration_ms) {
      return { summary: `${op} ${id} ${formatDeltaMs(after.duration_ms - before.duration_ms)}`, changed };
    }
    return { summary: `${op} ${id}`, changed };
  }
  if (op === "lane.add" && diff.addedCues.length >= 1) {
    const id = diff.addedCues[0];
    const cue = cuesById(newSeq).get(id)?.cue;
    const more = diff.addedCues.length > 1 ? ` +${diff.addedCues.length - 1} more` : "";
    return { summary: `${op} ${id} ${cueDetail(cue)}${more}`, changed };
  }
  if (op === "speech.captions") {
    return { summary: `${op} +${diff.addedCues.length} captions`, changed };
  }
  if ((op === "undo" || op === "redo") && changed.length > 0) {
    const shown = changed.slice(0, 3).join(" ");
    const more = changed.length > 3 ? ` +${changed.length - 3} more` : "";
    return { summary: `${op} ${shown}${more}`, changed };
  }
  if (changed.length === 0) return { summary: op, changed };
  const shown = changed.slice(0, 3).join(" ");
  const more = changed.length > 3 ? ` +${changed.length - 3} more` : "";
  return { summary: `${op} ${shown}${more}`, changed };
}

function snapshotFileFor(journalDir: string, revision: number): string {
  return path.join(journalDir, `rev_${String(revision).padStart(4, "0")}.json`);
}

export function readRevisionSnapshot(journalDir: string, revision: number): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(snapshotFileFor(journalDir, revision), "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Activity entry for one journal revision (snapshots give changed/summary). */
export function activityEntryForRevision(
  projectDir: string,
  journalDir: string,
  entry: JournalEntry
): LiveActivityEntry {
  const snap = readRevisionSnapshot(journalDir, entry.revision);
  const prev = readRevisionSnapshot(journalDir, entry.revision - 1);
  let summary = shortOperation(entry.operation);
  let changed: string[] = (entry.affected_ids ?? []).filter((id) => id.startsWith("sp_") || id.startsWith("cue_"));
  if (snap && prev) {
    const s = summarizeRevision(prev, snap, entry.operation);
    summary = s.summary;
    changed = s.changed;
  } else if (snap && !prev && changed.length > 0) {
    summary = `${shortOperation(entry.operation)} ${changed.slice(0, 3).join(" ")}`;
  }
  return {
    revision: entry.revision,
    timestamp: entry.timestamp,
    operation: entry.operation,
    summary,
    changed,
    actor: resolveRevisionActor(projectDir, entry.operation, entry.timestamp, entry.revision),
  };
}

/** One activity entry per revision in (fromRev, toRev], oldest first (for resume packets). */
export function activityEntriesForRange(projectDir: string, fromRev: number, toRev: number): LiveActivityEntry[] {
  const { paths } = loadSequence(projectDir);
  const manifest = loadJournalManifest(paths);
  return manifest.entries
    .filter((e) => e.revision > fromRev && e.revision <= toRev && e.revision <= manifest.cursor_revision)
    .map((e) => activityEntryForRevision(projectDir, paths.journalDir, e));
}

/**
 * Naive scenes: one per spine clip. The thumbnail URL carries the picture's
 * content key (changes only when the picture changes, so the window can keep
 * every other scene's cached image across revisions) plus the server token,
 * so the window uses it as a plain `<img src>` with no further auth step.
 */
export function buildScenes(seq: any, token?: string, projectDir?: string): LiveSceneSummary[] {
  setSceneThumbProjectDir(projectDir);
  const clips: any[] = seq?.spine?.clips ?? [];
  return clips.map((c, i) => {
    const scene: LiveSceneSummary = {
      id: `sc_${i + 1}`,
      start_ms: c.timeline_in_ms ?? 0,
      end_ms: (c.timeline_in_ms ?? 0) + (c.duration_ms ?? 0),
      label: c.asset_handle ?? c.id,
      members: [c.id],
    };
    scene.thumb = `/api/thumb/${scene.id}?k=${computeSceneThumbKey(seq, scene, projectDir)}${token ? `&t=${token}` : ""}`;
    return scene;
  });
}

export function buildActivity(projectDir: string, limit = 50): LiveActivityEntry[] {
  const { paths } = loadSequence(projectDir);
  const manifest = loadJournalManifest(paths);
  return manifest.entries
    .filter((e) => e.revision <= manifest.cursor_revision)
    .slice(-limit)
    .reverse()
    .map((e) => activityEntryForRevision(projectDir, paths.journalDir, e));
}

export function readProgress(projectDir: string): LiveProgress | null {
  try {
    return JSON.parse(fs.readFileSync(resolveLivePaths(projectDir).progressFile, "utf8")) as LiveProgress;
  } catch {
    return null;
  }
}

export function buildSnapshot(projectDir: string, token?: string): LiveSnapshot {
  const { sequence } = loadSequence(projectDir);
  const seq: any = sequence;
  const stage = seq.stage ?? {};
  return {
    schema: LIVE_SCHEMA,
    revision: seq.meta?.revision ?? 0,
    project: {
      title: seq.meta?.title ?? path.basename(projectDir),
      dir: path.resolve(projectDir),
      fps: stage.fps ?? 30,
      width: stage.width ?? 1920,
      height: stage.height ?? 1080,
      aspect: stage.aspect ?? "16:9",
      duration_ms: computeSequenceDurationMs(sequence),
      backdrop: stage.backdrop?.color ?? "#0D0F12",
    },
    sequence,
    scenes: buildScenes(seq, token, projectDir),
    activity: buildActivity(projectDir),
    lock: readLiveLock(projectDir),
    progress: readProgress(projectDir),
  };
}

/** Journal identity the server remembered for a revision (see classifyCursorMove). */
export interface RevisionSignature {
  operation: string;
  timestamp: string;
}

/**
 * What a cursor move means. A move up past everything known is a new commit; a
 * move up onto an unchanged journal entry is a redo; a move up onto a replaced
 * entry is a new commit that pruned the redo branch (same revision number, new
 * content) — the journal entry, not the revision number, tells them apart. A
 * move down is an undo; no move is an in-place update.
 */
export function classifyCursorMove(args: {
  fromRevision: number;
  cursor: number;
  entries: { revision: number; operation: string; timestamp: string }[];
  known: ReadonlyMap<number, RevisionSignature>;
}): { operation: string; timestamp: string } {
  const { fromRevision, cursor } = args;
  if (cursor > fromRevision) {
    const entry = args.entries.find((e) => e.revision === cursor);
    const prev = args.known.get(cursor);
    if (entry && prev && entry.operation === prev.operation && entry.timestamp === prev.timestamp) {
      return { operation: "journal.redo", timestamp: new Date().toISOString() };
    }
    return { operation: entry?.operation ?? "sequence.update", timestamp: entry?.timestamp ?? new Date().toISOString() };
  }
  if (cursor < fromRevision) return { operation: "journal.undo", timestamp: new Date().toISOString() };
  return { operation: "sequence.update", timestamp: new Date().toISOString() };
}

/** Full delta between two revisions (paths reuse the external-changes JSON diff). */
export function buildDelta(args: {
  projectDir: string;
  fromRevision: number;
  toRevision: number;
  oldSequence: unknown;
  newSequence: unknown;
  operation: string;
  timestamp: string;
  /** Server token, embedded into the scene thumbnail URLs (see buildScenes). */
  token?: string;
}): LiveDelta {
  const { summary, changed } = summarizeRevision(args.oldSequence, args.newSequence, args.operation);
  return {
    schema: LIVE_SCHEMA,
    from_revision: args.fromRevision,
    revision: args.toRevision,
    entry: {
      revision: args.toRevision,
      timestamp: args.timestamp,
      operation: args.operation,
      summary,
      changed,
      actor: resolveRevisionActor(args.projectDir, args.operation, args.timestamp, args.toRevision, args.fromRevision),
    },
    paths: diffSequenceJson(args.oldSequence, args.newSequence),
    sequence: args.newSequence,
    scenes: buildScenes(args.newSequence, args.token, args.projectDir),
    duration_ms: computeSequenceDurationMs(args.newSequence as any),
  };
}
