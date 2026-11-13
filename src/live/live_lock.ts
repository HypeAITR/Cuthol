import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
// Deferred use only (inside recordHumanWrite): workspace.ts imports this module
// for the lock check, so this edge is circular by construction; neither side
// calls the other at module-evaluation time.
import { resolveWorkspacePaths } from "../core/workspace.js";
import { resolveLivePaths } from "./live_paths.js";
import { LIVE_ACTOR_ENV, type LiveLock } from "./live_types.js";

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Current lock, or null when absent, unreadable or stale (owning server gone). */
export function readLiveLock(projectDir: string): LiveLock | null {
  const file = resolveLivePaths(projectDir).lockFile;
  let lock: LiveLock;
  try {
    lock = JSON.parse(fs.readFileSync(file, "utf8")) as LiveLock;
  } catch {
    return null;
  }
  if (!lock || (lock.holder !== "human" && lock.holder !== "agent")) return null;
  if (!pidAlive(lock.server_pid)) return null;
  return lock;
}

/**
 * Called before every sequence write (commitSequenceMutation, journal undo/redo,
 * in-place updates). While the human holds the lock only writes the live server
 * runs on the human's behalf (env CUTHOL_LIVE_ACTOR=human) may pass.
 * Cheap when Live is not in use: one failed stat.
 */
export function assertLiveWriteAllowed(projectDir: string, operation: string): void {
  if (process.env[LIVE_ACTOR_ENV] === "human") {
    recordHumanWrite(projectDir, operation);
    return;
  }
  const lock = readLiveLock(projectDir);
  if (!lock || lock.holder !== "human") return;
  if (!lock.agent_grace_used) {
    // The step the agent was on when the user paused finishes; its response
    // carries the wait instruction (drainLiveInbox). Writes after it are refused.
    try {
      fs.writeFileSync(resolveLivePaths(projectDir).lockFile, JSON.stringify({ ...lock, agent_grace_used: true }, null, 2));
    } catch {
      // cannot record the grace: refuse to be safe
      throw new CutholError(DIAGNOSTICS.LIVE_PAUSED_BY_USER(operation, lock.since));
    }
    return;
  }
  throw new CutholError(DIAGNOSTICS.LIVE_PAUSED_BY_USER(operation, lock.since));
}

// --- Human-actor evidence -----------------------------------------------
// The journal does not record who made a revision, so every write that passes
// via CUTHOL_LIVE_ACTOR=human appends one line here, stamped with the journal
// cursor just before the write. The live server binds that stamp to the exact
// revision the write produced (commits land on cursor + 1, in-place updates on
// the cursor itself, undo/redo moves start from it), so an agent revision is
// never mistaken for a human one even when both run the same operation within
// seconds of each other.

/** File the lock check appends to whenever a write passes thanks to the human actor env. */
export const LIVE_ACTORS_FILE = "actors.jsonl";
const MAX_ACTOR_LINES = 1000;
/** Undo/redo evidence older than this never matches a fresh cursor move. */
const ACTOR_MOVE_WINDOW_MS = 60_000;

interface ActorEvidence {
  actor: "human";
  operation: string;
  at: string;
  /** Journal cursor just before the write (absent on lines written before revision binding). */
  cursor?: number;
}

/** Journal cursor right now, or undefined when the manifest cannot be read. */
function currentCursorForEvidence(projectDir: string): number | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveWorkspacePaths(projectDir).journalIndexFile, "utf8")) as {
      cursor_revision?: unknown;
    };
    return typeof parsed?.cursor_revision === "number" ? parsed.cursor_revision : undefined;
  } catch {
    return undefined;
  }
}

/** Records that one write passed as the human actor (called from the lock check). */
export function recordHumanWrite(projectDir: string, operation: string): void {
  try {
    const dir = resolveLivePaths(projectDir).dir;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LIVE_ACTORS_FILE);
    const evidence: ActorEvidence = { actor: "human", operation, at: new Date().toISOString() };
    const cursor = currentCursorForEvidence(projectDir);
    if (cursor !== undefined) evidence.cursor = cursor;
    fs.appendFileSync(file, `${JSON.stringify(evidence)}\n`);
    trimActorFile(file);
  } catch {
    // actor tracking never breaks a write
  }
}

function trimActorFile(file: string): void {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length > MAX_ACTOR_LINES) {
      fs.writeFileSync(file, `${lines.slice(-MAX_ACTOR_LINES).join("\n")}\n`);
    }
  } catch {
    // ignore
  }
}

function readActorEvidence(projectDir: string): ActorEvidence[] {
  try {
    const file = path.join(resolveLivePaths(projectDir).dir, LIVE_ACTORS_FILE);
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ActorEvidence)
      .filter((e) => e && e.actor === "human" && typeof e.operation === "string" && typeof e.at === "string");
  } catch {
    return [];
  }
}

/**
 * Who made a revision: `human` when a human-actor write produced exactly this
 * revision, else `agent`. Commits match on the operation plus the produced
 * revision (cursor stamp + 1); in-place updates on the cursor itself; undo/redo
 * moves when the human recently started a move inside the observed cursor
 * range (one delta may coalesce several steps, and the same range may be
 * re-traversed later by the other actor). Human writes always pass through the
 * lock check (which logs the evidence), so absence of evidence means the agent
 * (or an unattended process) wrote it. Lines without a cursor stamp never
 * match.
 */
export function resolveRevisionActor(
  projectDir: string,
  operation: string,
  timestampIso: string,
  revision: number,
  fromRevision?: number
): "agent" | "human" {
  const at = Date.parse(timestampIso);
  for (const e of readActorEvidence(projectDir)) {
    if (e.operation !== operation || typeof e.cursor !== "number") continue;
    if (operation === "journal.undo" || operation === "journal.redo") {
      // Cursor moves down (undo: started inside (revision, fromRevision]) or
      // up (redo: started inside [fromRevision, revision)); stale evidence
      // from an earlier traversal of the same range does not match.
      if (fromRevision === undefined || !Number.isFinite(at)) continue;
      const eat = Date.parse(e.at);
      if (!Number.isFinite(eat) || Math.abs(eat - at) > ACTOR_MOVE_WINDOW_MS) continue;
      if (operation === "journal.undo" && e.cursor > revision && e.cursor <= fromRevision) return "human";
      if (operation === "journal.redo" && e.cursor >= fromRevision && e.cursor < revision) return "human";
      continue;
    }
    if (operation === "sequence.update") {
      if (e.cursor === revision) return "human";
      continue;
    }
    if (e.cursor + 1 === revision) return "human";
  }
  return "agent";
}
