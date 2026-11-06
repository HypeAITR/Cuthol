/**
 * Cuthol Workspace & Transactional Journal Manager (`JournalGuard`).
 *
 * Manages `cuthol.sequence.json`, `.cuthol/journal/` revision snapshots,
 * and atomic undo/redo operations.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { syncAllCompositionBridges } from "../compositor/bridge_exporter.js";
import { CutholError, DIAGNOSTICS } from "./diagnostics.js";
import {
  buildEnvelopeState,
  computeSequenceDelta,
  CutholEnvelopeHistory,
  CutholEnvelopeState,
  InverseOperationKind,
} from "./envelope.js";
import { AspectPreset, createEmptySequence, CutholSequence } from "./schema.js";
import { formatTimecode } from "./time.js";
import { computeSequenceDurationMs } from "./timeline.js";
import {
  assertBridgeWontRewriteExternal,
  assertMutatorKeptExternalFiles,
  captureCommitPrestate,
  clearExtchangeState,
  detectExternalChanges,
  ExternalChanges,
  finalizeCommitManifest,
  formatExternalNotice,
  pruneExtchangeRevisions,
  refreshManifestIfWasClean,
  restoreForJournalTraversal,
} from "./external_changes.js";

export const SEQUENCE_FILENAME = "cuthol.sequence.json";
export const STATE_DIRNAME = ".cuthol";
export const JOURNAL_INDEX_FILENAME = "journal.json";

export interface JournalEntry {
  revision: number;
  timestamp: string;
  operation: string;
  tag: string | null;
  snapshot_file: string;
  delta_summary?: string;
  inverse_kind?: InverseOperationKind;
  inverse_summary?: string;
  affected_ids?: string[];
  touches_protected?: boolean;
  protected_ids?: string[];
  /** Set when this commit folded an externally edited `cuthol.sequence.json` without adopt. */
  absorbed_external_sequence?: string;
}

export interface JournalManifest {
  cursor_revision: number;
  entries: JournalEntry[];
}

export interface WorkspacePaths {
  rootDir: string;
  sequenceFile: string;
  stateDir: string;
  ledgerFile: string;
  journalDir: string;
  journalIndexFile: string;
  monitorDir: string;
  blobsDir: string;
}

export function resolveWorkspacePaths(dir: string): WorkspacePaths {
  const rootDir = path.resolve(dir);
  const stateDir = path.join(rootDir, STATE_DIRNAME);
  return {
    rootDir,
    sequenceFile: path.join(rootDir, SEQUENCE_FILENAME),
    stateDir,
    ledgerFile: path.join(stateDir, "ledger.sqlite"),
    journalDir: path.join(stateDir, "journal"),
    journalIndexFile: path.join(stateDir, JOURNAL_INDEX_FILENAME),
    monitorDir: path.join(stateDir, "monitor"),
    blobsDir: path.join(stateDir, "blobs"),
  };
}

export function ensureWorkspaceDirectories(paths: WorkspacePaths): void {
  fs.mkdirSync(paths.rootDir, { recursive: true });
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.journalDir, { recursive: true });
  fs.mkdirSync(paths.monitorDir, { recursive: true });
  fs.mkdirSync(paths.blobsDir, { recursive: true });
}

function writeJsonAtomically(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp_${process.pid}_${crypto.randomUUID()}`;
  const serialized = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, serialized, "utf8");

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const isTransientLock = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (isTransientLock && attempt < maxAttempts) {
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * attempt);
        } catch {
          // SharedArrayBuffer fallback if unavailable
        }
        continue;
      }
      if (isTransientLock) {
        try {
          fs.copyFileSync(tmpPath, filePath);
          fs.unlinkSync(tmpPath);
          return;
        } catch {
          // Fall through to cleanup and rethrow original error
        }
      }
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // Ignore cleanup failure
        }
      }
      throw err;
    }
  }
}

export function initWorkspace(options: {
  dir: string;
  title?: string;
  aspect?: AspectPreset;
  fps?: number;
}): { paths: WorkspacePaths; sequence: CutholSequence } {
  const paths = resolveWorkspacePaths(options.dir);
  ensureWorkspaceDirectories(paths);

  // Clean up any stale revision snapshots if re-initializing an existing workspace directory
  if (fs.existsSync(paths.journalDir)) {
    for (const file of fs.readdirSync(paths.journalDir)) {
      if (/^rev_\d+\.json$/.test(file)) {
        try {
          fs.unlinkSync(path.join(paths.journalDir, file));
        } catch {
          // Ignore unlink errors
        }
      }
    }
  }

  const projectId = path.basename(paths.rootDir).replace(/[^a-zA-Z0-9_-]/g, "_") || "cuthol_project";
  const sequence = createEmptySequence({
    projectId,
    title: options.title ?? path.basename(paths.rootDir),
    aspect: options.aspect ?? "9:16",
    fps: options.fps ?? 30,
  });

  writeJsonAtomically(paths.sequenceFile, sequence);

  const snapName = `rev_0001.json`;
  writeJsonAtomically(path.join(paths.journalDir, snapName), sequence);

  const manifest: JournalManifest = {
    cursor_revision: 1,
    entries: [
      {
        revision: 1,
        timestamp: sequence.meta.created_at,
        operation: "workspace.init",
        tag: "initial",
        snapshot_file: snapName,
      },
    ],
  };
  writeJsonAtomically(paths.journalIndexFile, manifest);
  clearExtchangeState(paths);

  return { paths, sequence };
}

export function loadSequence(dir: string): { paths: WorkspacePaths; sequence: CutholSequence } {
  const paths = resolveWorkspacePaths(dir);
  if (!fs.existsSync(paths.sequenceFile)) {
    throw new CutholError(DIAGNOSTICS.WORKSPACE_NOT_FOUND(paths.rootDir));
  }
  ensureWorkspaceDirectories(paths);
  const raw = fs.readFileSync(paths.sequenceFile, "utf8");
  const sequence = JSON.parse(raw) as CutholSequence;
  return { paths, sequence };
}

export function loadJournalManifest(paths: WorkspacePaths): JournalManifest {
  if (!fs.existsSync(paths.journalIndexFile)) {
    return { cursor_revision: 1, entries: [] };
  }
  return JSON.parse(fs.readFileSync(paths.journalIndexFile, "utf8")) as JournalManifest;
}

/**
 * Executes a mutating operation inside a transactional `JournalGuard`.
 * If the callback throws (or verification fails), the sequence file remains untouched.
 * If it succeeds, the revision increments and a snapshot is recorded in `.cuthol/journal/`.
 */
export interface CommitSequenceMutationOptions {
  /**
   * Skips the G211 bridge-rewrite guard. Only `workspace changes adopt/revert`
   * set this: they resolve the external change by blessing the post-sync state.
   */
  allowExternalRewrite?: boolean;
}

export function commitSequenceMutation<T>(
  dir: string,
  operation: string,
  mutator: (seq: CutholSequence, paths: WorkspacePaths) => T,
  options: CommitSequenceMutationOptions = {}
): { result: T; sequence: CutholSequence; revision: number } {
  const { paths, sequence } = loadSequence(dir);
  const cloned: CutholSequence = structuredClone(sequence);
  const extPrestate = captureCommitPrestate(paths, sequence, { stashPending: true });

  const result = mutator(cloned, paths);

  // G211: a Cuthol commit must not silently overwrite externally-changed
  // composition files. Both checks run before any journal write.
  assertMutatorKeptExternalFiles(paths, extPrestate);
  if (!options.allowExternalRewrite) {
    assertBridgeWontRewriteExternal(paths, cloned, extPrestate);
  }

  const manifest = loadJournalManifest(paths);
  const prunedEntries = manifest.entries.filter((e) => e.revision > manifest.cursor_revision);
  const activeEntries = manifest.entries.filter((e) => e.revision <= manifest.cursor_revision);
  if (activeEntries.length === 0) {
    const baseRev = Math.max(1, sequence.meta.revision || 1);
    const baseSnapName = `rev_${String(baseRev).padStart(4, "0")}.json`;
    const baseSnapPath = path.join(paths.journalDir, baseSnapName);
    if (!fs.existsSync(baseSnapPath)) {
      writeJsonAtomically(baseSnapPath, sequence);
    }
    activeEntries.push({
      revision: baseRev,
      timestamp: sequence.meta.updated_at || new Date().toISOString(),
      operation: "workspace.recover",
      tag: null,
      snapshot_file: baseSnapName,
    });
  }
  const nextRevision = activeEntries[activeEntries.length - 1].revision + 1;

  cloned.meta.revision = nextRevision;
  cloned.meta.updated_at = new Date().toISOString();

  const deltaInfo = computeSequenceDelta(sequence, cloned, operation);

  const snapName = `rev_${String(nextRevision).padStart(4, "0")}.json`;
  const snapPath = path.join(paths.journalDir, snapName);

  writeJsonAtomically(snapPath, cloned);
  writeJsonAtomically(paths.sequenceFile, cloned);

  const absorbedExternalNote = extPrestate.sequenceFolded
    ? "externally-edited cuthol.sequence.json folded into this revision (without adopt)"
    : undefined;
  activeEntries.push({
    revision: nextRevision,
    timestamp: cloned.meta.updated_at,
    operation,
    tag: null,
    snapshot_file: snapName,
    delta_summary: absorbedExternalNote
      ? `${deltaInfo.summary} | ${absorbedExternalNote}`
      : deltaInfo.summary,
    ...(absorbedExternalNote ? { absorbed_external_sequence: absorbedExternalNote } : {}),
    inverse_kind: deltaInfo.inverse_kind,
    inverse_summary: deltaInfo.inverse_summary,
    affected_ids: deltaInfo.affected_ids,
    touches_protected: deltaInfo.touches_protected,
    protected_ids: deltaInfo.protected_ids,
  });

  const nextManifest: JournalManifest = {
    cursor_revision: nextRevision,
    entries: activeEntries,
  };
  writeJsonAtomically(paths.journalIndexFile, nextManifest);

  pruneExtchangeRevisions(
    paths,
    prunedEntries.map((e) => e.revision)
  );
  // Remove orphaned redo snapshot files only after new revision and manifest are safely committed
  const activeSnapSet = new Set(activeEntries.map((e) => e.snapshot_file));
  for (const pruned of prunedEntries) {
    if (activeSnapSet.has(pruned.snapshot_file)) continue;
    const orphanPath = path.join(paths.journalDir, pruned.snapshot_file);
    if (fs.existsSync(orphanPath)) {
      try {
        fs.unlinkSync(orphanPath);
      } catch {
        // Ignore orphan cleanup failure
      }
    }
  }

  try {
    syncAllCompositionBridges(cloned, paths);
  } catch {
    // non-blocking bridge sync
  }

  try {
    finalizeCommitManifest(paths, nextRevision, cloned, extPrestate);
  } catch {
    // non-blocking known-state recording (a later detection re-baselines)
  }

  return { result, sequence: cloned, revision: nextRevision };
}

/**
 * Updates cached metadata (such as `analysis_refs`) in `cuthol.sequence.json` and the active
 * revision snapshot without incrementing `meta.revision` or polluting the undo/redo journal stack.
 */
export function updateSequenceInPlace(
  dir: string,
  mutator: (seq: CutholSequence, paths: WorkspacePaths) => void
): CutholSequence {
  const { paths, sequence } = loadSequence(dir);
  const cloned: CutholSequence = structuredClone(sequence);
  const extPrestate = captureCommitPrestate(paths, sequence);
  mutator(cloned, paths);

  writeJsonAtomically(paths.sequenceFile, cloned);

  const manifest = loadJournalManifest(paths);
  const currentEntry = manifest.entries.find((e) => e.revision === manifest.cursor_revision);
  if (currentEntry) {
    const snapPath = path.join(paths.journalDir, currentEntry.snapshot_file);
    if (fs.existsSync(snapPath)) {
      writeJsonAtomically(snapPath, cloned);
    }
  }

  try {
    syncAllCompositionBridges(cloned, paths);
  } catch {
    // non-blocking bridge sync
  }

  try {
    refreshManifestIfWasClean(paths, cloned, extPrestate);
  } catch {
    // non-blocking known-state refresh
  }

  return cloned;
}

export interface StepJournalOptions {
  steps?: number;
  toRevision?: number;
  expectRevision?: number;
  dryRun?: boolean;
  allowProtected?: string[];
}

export interface StepJournalResult {
  sequence: CutholSequence;
  previous_revision: number;
  revision: number;
  operation: string;
  dry_run: boolean;
  reverted_entries: Array<{
    revision: number;
    operation: string;
    inverse_kind: InverseOperationKind;
    inverse_summary: string;
    affected_ids: string[];
  }>;
  state: CutholEnvelopeState;
  history: CutholEnvelopeHistory;
}

export function buildEnvelopeHistory(
  manifest: JournalManifest,
  currentSeq?: CutholSequence
): CutholEnvelopeHistory {
  const idx = manifest.entries.findIndex((e) => e.revision === manifest.cursor_revision);
  const undoDepth = Math.max(0, idx);
  const redoDepth = idx >= 0 ? Math.max(0, manifest.entries.length - 1 - idx) : 0;

  // Check currently locked lanes in `currentSeq` so dynamically locked cues are also marked protected
  const lockedCueIds = new Set<string>();
  if (currentSeq) {
    for (const lane of currentSeq.lanes) {
      if (lane.locked) {
        for (const c of lane.cues) {
          lockedCueIds.add(c.id);
        }
      }
    }
  }

  let undoPreview: CutholEnvelopeHistory["undo_preview"] = null;
  if (idx > 0) {
    const curEntry = manifest.entries[idx];
    const affects = curEntry.affected_ids ?? [];
    const dynamicProtected = affects.some((id) => lockedCueIds.has(id));
    undoPreview = {
      revision: curEntry.revision,
      operation: curEntry.operation,
      delta_summary: curEntry.delta_summary ?? curEntry.operation,
      inverse_kind: curEntry.inverse_kind ?? "modifying",
      inverse_summary: curEntry.inverse_summary ?? `${curEntry.operation} will be undone`,
      affects,
      touches_protected: Boolean(curEntry.touches_protected || dynamicProtected),
    };
  }

  let nextRedo: CutholEnvelopeHistory["next_redo"] = null;
  if (idx >= 0 && idx + 1 < manifest.entries.length) {
    const rEntry = manifest.entries[idx + 1];
    nextRedo = {
      revision: rEntry.revision,
      operation: rEntry.operation,
      delta_summary: rEntry.delta_summary ?? rEntry.operation,
      affects: rEntry.affected_ids ?? [],
    };
  }

  const activeSlice = idx >= 0 ? manifest.entries.slice(Math.max(0, idx - 4), idx + 1) : [];
  const breadcrumb = activeSlice.map(
    (e) => `r${e.revision} ${e.delta_summary ?? e.operation}`
  );

  return {
    undo_depth: undoDepth,
    redo_depth: redoDepth,
    undo_preview: undoPreview,
    next_redo: nextRedo,
    breadcrumb,
  };
}

export function buildWorkspaceEnvelopeHeader(dir: string): {
  schema_version: "cuthol.envelope/1";
  state: CutholEnvelopeState;
  delta?: { summary: string; affected_ids: string[] };
  history: CutholEnvelopeHistory;
} {
  const { paths, sequence } = loadSequence(dir);
  const manifest = loadJournalManifest(paths);
  const curEntry = manifest.entries.find((e) => e.revision === manifest.cursor_revision);
  return {
    schema_version: "cuthol.envelope/1",
    state: buildEnvelopeState(sequence),
    ...(curEntry
      ? {
          delta: {
            summary: curEntry.delta_summary ?? curEntry.operation,
            affected_ids: curEntry.affected_ids ?? [],
          },
        }
      : {}),
    history: buildEnvelopeHistory(manifest, sequence),
  };
}

export function stepJournal(
  dir: string,
  direction: "undo" | "redo",
  stepsOrOpts: number | StepJournalOptions = 1
): StepJournalResult {
  const opts: StepJournalOptions =
    typeof stepsOrOpts === "number" ? { steps: stepsOrOpts } : stepsOrOpts;

  const { paths, sequence: currentSeq } = loadSequence(dir);
  const manifest = loadJournalManifest(paths);
  const idx = manifest.entries.findIndex((e) => e.revision === manifest.cursor_revision);
  if (idx === -1) {
    throw new CutholError(DIAGNOSTICS.JOURNAL_REVISION_UNAVAILABLE(direction));
  }

  if (opts.expectRevision !== undefined && opts.expectRevision !== manifest.cursor_revision) {
    throw new CutholError(
      DIAGNOSTICS.REVISION_MISMATCH(opts.expectRevision, manifest.cursor_revision)
    );
  }

  let targetIdx: number;
  if (opts.toRevision !== undefined) {
    targetIdx = manifest.entries.findIndex((e) => e.revision === opts.toRevision);
    if (
      targetIdx === -1 ||
      (direction === "undo" && targetIdx >= idx) ||
      (direction === "redo" && targetIdx <= idx)
    ) {
      throw new CutholError(DIAGNOSTICS.JOURNAL_REVISION_UNAVAILABLE(direction));
    }
  } else {
    const steps = opts.steps ?? 1;
    if (!Number.isInteger(steps) || steps < 1) {
      throw new CutholError(DIAGNOSTICS.JOURNAL_REVISION_UNAVAILABLE(direction));
    }
    targetIdx = direction === "undo" ? idx - steps : idx + steps;
  }

  if (targetIdx < 0 || targetIdx >= manifest.entries.length) {
    throw new CutholError(DIAGNOSTICS.JOURNAL_REVISION_UNAVAILABLE(direction));
  }

  const targetEntry = manifest.entries[targetIdx];
  const snapPath = path.join(paths.journalDir, targetEntry.snapshot_file);
  if (!fs.existsSync(snapPath)) {
    throw new CutholError(DIAGNOSTICS.JOURNAL_REVISION_UNAVAILABLE(direction));
  }
  const restored = JSON.parse(fs.readFileSync(snapPath, "utf8")) as CutholSequence;

  // Compute which entries are being reverted/replayed and check for locked/protected targets
  const traversedEntries =
    direction === "undo"
      ? manifest.entries.slice(targetIdx + 1, idx + 1).reverse()
      : manifest.entries.slice(idx + 1, targetIdx + 1);

  const lockedLaneIds = new Set<string>();
  const lockedCueIds = new Set<string>();
  const cueToLane = new Map<string, string>();
  for (const seqSnap of [currentSeq, restored]) {
    for (const lane of seqSnap.lanes) {
      for (const c of lane.cues) {
        cueToLane.set(c.id, lane.id);
      }
      if (lane.locked) {
        lockedLaneIds.add(lane.id);
        for (const c of lane.cues) {
          lockedCueIds.add(c.id);
        }
      }
    }
  }

  const allowSet = new Set(opts.allowProtected ?? []);
  const isProtectedIdAllowed = (id: string, scopeIds: Iterable<string>): boolean => {
    if (allowSet.has(id)) return true;
    const parentLane = cueToLane.get(id);
    if (parentLane && allowSet.has(parentLane)) return true;
    if (lockedLaneIds.has(id)) {
      const cuesInScope = [...scopeIds].filter((sid) => cueToLane.get(sid) === id);
      if (cuesInScope.length > 0 && cuesInScope.every((cid) => allowSet.has(cid))) {
        return true;
      }
    }
    return false;
  };

  const blockedProtectedIds = new Set<string>();

  const revertedDetails = traversedEntries.map((e) => {
    const aff = e.affected_ids ?? [];
    const scopeProtected = new Set<string>([...aff, ...(e.protected_ids ?? [])]);
    for (const id of aff) {
      if (lockedCueIds.has(id) && !isProtectedIdAllowed(id, scopeProtected)) {
        blockedProtectedIds.add(id);
      }
    }
    for (const pid of e.protected_ids ?? []) {
      if (!isProtectedIdAllowed(pid, scopeProtected)) {
        blockedProtectedIds.add(pid);
      }
    }
    const baseInvKind: InverseOperationKind = e.inverse_kind ?? "modifying";
    const effectiveInvKind: InverseOperationKind =
      direction === "redo"
        ? baseInvKind === "destructive"
          ? "additive"
          : baseInvKind === "additive"
            ? "destructive"
            : "modifying"
        : baseInvKind;
    return {
      revision: e.revision,
      operation: e.operation,
      inverse_kind: effectiveInvKind,
      inverse_summary:
        direction === "undo"
          ? e.inverse_summary ?? `${e.operation} will be undone`
          : e.delta_summary ?? e.operation,
      affected_ids: aff,
    };
  });

  // Also check direct diff between currentSeq and restored on locked lanes
  const directDelta = computeSequenceDelta(currentSeq, restored, `journal.${direction}`);
  if (directDelta.touches_protected) {
    for (const pid of directDelta.protected_ids) {
      if (!isProtectedIdAllowed(pid, directDelta.protected_ids)) {
        blockedProtectedIds.add(pid);
      }
    }
  }

  if (blockedProtectedIds.size > 0 && !opts.dryRun) {
    throw new CutholError(
      DIAGNOSTICS.PROTECTED_TARGET([...blockedProtectedIds], `workspace.journal.${direction}`)
    );
  }

  // G211: the trailing bridge sync must not silently revert the user's own
  // edit to an externally-changed entry HTML (checked before any write).
  if (!opts.dryRun) {
    const extPrestate = captureCommitPrestate(paths, currentSeq);
    assertBridgeWontRewriteExternal(paths, restored, extPrestate);
  }

  const prevRev = manifest.cursor_revision;
  if (!opts.dryRun) {
    writeJsonAtomically(paths.sequenceFile, restored);
    manifest.cursor_revision = targetEntry.revision;
    writeJsonAtomically(paths.journalIndexFile, manifest);
    try {
      syncAllCompositionBridges(restored, paths);
    } catch {
      // non-blocking bridge sync
    }
    try {
      const restoreNotes = restoreForJournalTraversal(
        paths,
        direction,
        traversedEntries.map((e) => e.revision),
        new Map(traversedEntries.map((e) => [e.revision, e.operation] as [number, string])),
        targetEntry.revision
      );
      if (restoreNotes.length > 0) {
        const byRev = new Map(restoreNotes.map((x) => [x.revision, x.note] as [number, string]));
        for (const rd of revertedDetails) {
          const note = byRev.get(rd.revision);
          if (note) rd.inverse_summary = `${rd.inverse_summary} | ${note}`;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (revertedDetails.length > 0) {
        revertedDetails[0].inverse_summary += ` | file restore error: ${msg}`;
      }
    }
  } else {
    manifest.cursor_revision = targetEntry.revision;
  }

  return {
    sequence: restored,
    previous_revision: prevRev,
    revision: targetEntry.revision,
    operation: targetEntry.operation,
    dry_run: Boolean(opts.dryRun),
    reverted_entries: revertedDetails,
    state: buildEnvelopeState(restored),
    history: buildEnvelopeHistory(manifest, restored),
  };
}

export function setLaneLockStatus(options: {
  workspaceDir: string;
  laneId: string;
  locked: boolean;
}): { laneId: string; locked: boolean; revision: number } {
  const { result, revision } = commitSequenceMutation(
    options.workspaceDir,
    `lane.${options.locked ? "lock" : "unlock"}(${options.laneId})`,
    (seq) => {
      const lane = seq.lanes.find((l) => l.id === options.laneId);
      if (!lane) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.laneId));
      }
      lane.locked = options.locked;
      return { laneId: lane.id, locked: lane.locked };
    }
  );
  return { ...result, revision };
}

export function tagCurrentRevision(dir: string, tag: string): JournalEntry {
  const { paths } = loadSequence(dir);
  const manifest = loadJournalManifest(paths);
  const entry = manifest.entries.find((e) => e.revision === manifest.cursor_revision);
  if (!entry) {
    throw new CutholError(DIAGNOSTICS.JOURNAL_REVISION_UNAVAILABLE("undo"));
  }
  entry.tag = tag;
  writeJsonAtomically(paths.journalIndexFile, manifest);
  return entry;
}

export function formatWorkspaceOpenSummary(
  seq: CutholSequence,
  options: { verbose?: boolean; maxItems?: number; noticeLine?: string } = {}
): string {
  const maxItems = options.maxItems ?? 3;
  const totalMs = computeSequenceDurationMs(seq);
  const totalCues = seq.lanes.reduce((sum, l) => sum + l.cues.length, 0);
  const lines: string[] = [];
  if (options.noticeLine) lines.push(options.noticeLine);

  lines.push(
    `- Project: **${seq.meta.title}** (\`${seq.meta.project_id}\`) | Rev: \`r${seq.meta.revision}\` | Stage: \`${seq.stage.width}x${seq.stage.height}\` (\`${seq.stage.aspect}\`) @ \`${seq.stage.fps}fps\` | Backdrop: \`${seq.stage.backdrop.color}\` | Duration: \`${totalMs}ms\` (\`${formatTimecode(totalMs)}\`)`
  );

  if (seq.library.length === 0) {
    lines.push(`- Library (0 items): _(empty)_`);
  } else if (options.verbose) {
    lines.push(`- Library (${seq.library.length} items):`);
    for (const item of seq.library) {
      const dims = item.probe.has_video
        ? `${item.probe.width}x${item.probe.height}@${item.probe.fps}fps`
        : "audio-only";
      lines.push(
        `  - \`${item.handle}\` (${item.kind}, ${item.probe.duration_ms}ms, ${dims}, uri: \`${item.uri}\`)`
      );
    }
  } else {
    const shownLib = seq.library.slice(0, maxItems).map((item) => {
      return `\`${item.handle}\` (${item.kind}, ${item.probe.duration_ms}ms)`;
    });
    const moreLib =
      seq.library.length > maxItems
        ? ` … (+${seq.library.length - maxItems} more; pass verbose=true or run brief for full table)`
        : "";
    lines.push(`- Library (${seq.library.length} items): ${shownLib.join(", ")}${moreLib}`);
  }

  if (seq.spine.clips.length === 0) {
    lines.push(`- Primary Spine (0 clips): _(empty)_`);
  } else if (options.verbose) {
    lines.push(`- Primary Spine (${seq.spine.clips.length} clips):`);
    for (const clip of seq.spine.clips) {
      const endMs = clip.timeline_in_ms + clip.duration_ms;
      const muteTag = clip.audio_chain.muted ? ", MUTED" : "";
      lines.push(
        `  - \`${clip.id}\` (\`${clip.asset_handle}\`): timeline \`${clip.timeline_in_ms}..${endMs}ms\` | source \`${clip.source_in_ms}..${clip.source_out_ms}ms\`${muteTag}`
      );
    }
  } else {
    const shownClips = seq.spine.clips.slice(0, maxItems).map((clip) => {
      const endMs = clip.timeline_in_ms + clip.duration_ms;
      const muteTag = clip.audio_chain.muted ? ", muted" : "";
      return `\`${clip.id}\` (${clip.asset_handle}, ${clip.timeline_in_ms}..${endMs}ms${muteTag})`;
    });
    const moreClips =
      seq.spine.clips.length > maxItems ? ` … (+${seq.spine.clips.length - maxItems} more)` : "";
    lines.push(`- Primary Spine (${seq.spine.clips.length} clips): ${shownClips.join(", ")}${moreClips}`);
  }

  if (seq.lanes.length === 0) {
    lines.push(`- Parallel Lanes (0 lanes, 0 cues): _(none)_`);
  } else {
    const laneParts = seq.lanes.map((lane) => {
      const firstCues = lane.cues
        .slice(0, 2)
        .map((c) => c.id)
        .join(",");
      const cuePreview =
        lane.cues.length > 0
          ? ` [${firstCues}${lane.cues.length > 2 ? `…+${lane.cues.length - 2}` : ""}]`
          : "";
      return `\`${lane.id}\` (${lane.kind}: ${lane.cues.length} cue${lane.cues.length === 1 ? "" : "s"}${lane.muted ? ", MUTED" : ""}${cuePreview})`;
    });
    lines.push(
      `- Parallel Lanes (${seq.lanes.length} lanes, ${totalCues} cues): ${laneParts.join(", ")}`
    );
  }

  if (seq.extensions && seq.extensions.length > 0) {
    lines.push(
      `- Enabled Extensions (${seq.extensions.length}): ${seq.extensions.map((e) => `\`${e.name}\` v${e.version}`).join(", ")}`
    );
  }

  return lines.join("\n");
}

export interface ExternalChangesSummary {
  digest: string;
  cursor_revision: number;
  counts: ExternalChanges["counts"];
  sequence: ExternalChanges["sequence"];
  compositions: ExternalChanges["compositions"];
  notice: string;
  diagnostic: ReturnType<typeof DIAGNOSTICS.EXTERNAL_CHANGES_PRESENT>;
}

export function toExternalChangesSummary(
  changes: ExternalChanges,
  notice: string
): ExternalChangesSummary {
  const bits = changes.compositions.map(
    (c) => `${c.key}: ${c.added.length + c.modified.length + c.deleted.length} file${c.added.length + c.modified.length + c.deleted.length === 1 ? "" : "s"}`
  );
  if (changes.sequence) bits.push("cuthol.sequence.json");
  return {
    digest: changes.digest,
    cursor_revision: changes.cursor_revision,
    counts: changes.counts,
    sequence: changes.sequence,
    compositions: changes.compositions,
    notice,
    diagnostic: DIAGNOSTICS.EXTERNAL_CHANGES_PRESENT(bits.join("; ") || "changes"),
  };
}

export function openWorkspaceSummary(
  dir: string,
  options: { verbose?: boolean; maxItems?: number } = {}
): {
  workspace_dir: string;
  project_id: string;
  title: string;
  revision: number;
  duration_ms: number;
  counts: {
    library: number;
    spine_clips: number;
    lanes: number;
    cues: number;
  };
  library_preview: Array<{ handle: string; kind: string; duration_ms: number; uri: string }>;
  library_omitted?: number;
  spine_preview: Array<{
    id: string;
    asset_handle: string;
    timeline_in_ms: number;
    duration_ms: number;
    muted: boolean;
  }>;
  spine_omitted?: number;
  lanes_summary: Array<{ id: string; kind: string; cues_count: number; muted: boolean }>;
  summary_text: string;
  external_changes?: ExternalChangesSummary;
} {
  const { paths, sequence } = loadSequence(dir);
  let externalChanges: ExternalChanges | null = null;
  let externalNotice: string | null = null;
  try {
    externalChanges = detectExternalChanges(paths.rootDir);
    externalNotice = formatExternalNotice(externalChanges, "cli");
  } catch {
    externalChanges = null;
    externalNotice = null;
  }
  const maxItems = options.verbose ? sequence.library.length : (options.maxItems ?? 3);
  const maxSpine = options.verbose ? sequence.spine.clips.length : (options.maxItems ?? 3);
  const totalMs = computeSequenceDurationMs(sequence);
  const totalCues = sequence.lanes.reduce((sum, l) => sum + l.cues.length, 0);

  const libSlice = sequence.library.slice(0, maxItems).map((item) => ({
    handle: item.handle,
    kind: item.kind,
    duration_ms: item.probe.duration_ms,
    uri: item.uri,
  }));
  const libOmitted = Math.max(0, sequence.library.length - libSlice.length);

  const spineSlice = sequence.spine.clips.slice(0, maxSpine).map((clip) => ({
    id: clip.id,
    asset_handle: clip.asset_handle,
    timeline_in_ms: clip.timeline_in_ms,
    duration_ms: clip.duration_ms,
    muted: clip.audio_chain.muted,
  }));
  const spineOmitted = Math.max(0, sequence.spine.clips.length - spineSlice.length);

  return {
    workspace_dir: paths.rootDir,
    project_id: sequence.meta.project_id,
    title: sequence.meta.title,
    revision: sequence.meta.revision,
    duration_ms: totalMs,
    counts: {
      library: sequence.library.length,
      spine_clips: sequence.spine.clips.length,
      lanes: sequence.lanes.length,
      cues: totalCues,
    },
    library_preview: libSlice,
    ...(libOmitted > 0 ? { library_omitted: libOmitted } : {}),
    spine_preview: spineSlice,
    ...(spineOmitted > 0 ? { spine_omitted: spineOmitted } : {}),
    lanes_summary: sequence.lanes.map((l) => ({
      id: l.id,
      kind: l.kind,
      cues_count: l.cues.length,
      muted: l.muted,
    })),
    summary_text: formatWorkspaceOpenSummary(sequence, {
      ...options,
      ...(externalNotice ? { noticeLine: externalNotice } : {}),
    }),
    ...(externalChanges && externalNotice
      ? { external_changes: toExternalChangesSummary(externalChanges, externalNotice) }
      : {}),
  };
}

