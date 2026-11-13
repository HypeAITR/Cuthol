// Cuthol Live human edits: POST /api/edit {action, target, params, expect_rev}.
// Every operation runs as the same CLI command the agent would run (async child
// process, CUTHOL_LIVE_ACTOR=human), so journal, locks and verification behave
// identically. Neither the window nor this module writes the sequence directly.
import { execFile } from "node:child_process";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { loadJournalManifest, loadSequence } from "../core/workspace.js";
import { sequenceMsToSourceMs } from "../sequence/spine_time.js";
import { peekLiveInbox } from "./live_inbox.js";
import { readLiveLock, resolveRevisionActor } from "./live_lock.js";
import { resolveLivePaths } from "./live_paths.js";
import { activityEntriesForRange } from "./live_state.js";
import { LIVE_ACTOR_ENV, type LiveActivityEntry } from "./live_types.js";

export interface LiveEditBody {
  action?: unknown;
  target?: unknown;
  params?: unknown;
  expect_rev?: unknown;
}

export interface LiveEditResult {
  status: number;
  json: Record<string, unknown>;
}

const EDIT_ACTIONS = ["split", "trim", "delete", "move-cue", "cue-duration", "mute", "lane-lock", "lane-mute", "undo", "redo"] as const;
export type LiveEditAction = (typeof EDIT_ACTIONS)[number];

/** Resume summary shows one line per operation, then `+N more`. */
const CLI_TIMEOUT_MS = 120_000;

function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}): LiveEditResult {
  return { status, json: { ok: false, code, message, ...extra } };
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function numParam(params: Record<string, unknown>, name: string): number | undefined {
  const v = params[name];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function clipsOf(seq: any): any[] {
  return Array.isArray(seq?.spine?.clips) ? seq.spine.clips : [];
}

function lanesOf(seq: any): any[] {
  return Array.isArray(seq?.lanes) ? seq.lanes : [];
}

function findClip(seq: any, id: string): any | null {
  return clipsOf(seq).find((c) => c?.id === id) ?? null;
}

function findCue(seq: any, id: string): { cue: any; lane: any } | null {
  for (const lane of lanesOf(seq)) {
    const cue = (lane?.cues ?? []).find((q: any) => q?.id === id);
    if (cue) return { cue, lane };
  }
  return null;
}

function clipEnd(clip: any): number {
  return (clip.timeline_in_ms ?? 0) + (clip.duration_ms ?? 0);
}

/** Sequence-time start of a cue (same rule the timeline view uses). */
function cueStartMs(seq: any, cue: any): number {
  if (cue?.anchor?.ref) {
    const clip = findClip(seq, cue.anchor.ref);
    if (clip) return (clip.timeline_in_ms ?? 0) + (cue.anchor.offset_ms ?? 0);
  }
  if (cue?.cue_anchor?.ref) {
    const ref = findCue(seq, cue.cue_anchor.ref)?.cue;
    if (ref && !ref.cue_anchor) return cueStartMs(seq, ref) + (cue.cue_anchor.offset_ms ?? 0);
  }
  return cue?.at_ms ?? 0;
}

const ms = (n: number): string => `${Math.round(n)}ms`;

/**
 * Maps one window edit onto CLI argv (without the node/cli prefix and --dir).
 * Reads the sequence only to resolve ids and time coordinates; throws a plain
 * Error describing invalid requests (the caller turns it into a 400).
 */
export function buildEditCliArgs(body: LiveEditBody, seq: unknown): string[] {
  const action = body.action;
  if (typeof action !== "string" || !(EDIT_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`unknown action '${String(action)}' (expected one of ${EDIT_ACTIONS.join(", ")})`);
  }
  const params = asRecord(body.params);
  const target = typeof body.target === "string" ? body.target : "";

  if (action === "undo" || action === "redo") {
    const steps = numParam(params, "steps") ?? 1;
    if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error(`'steps' must be an integer 1..100`);
    const args = ["workspace", "journal", action, "--expect-rev", String(body.expect_rev)];
    if (steps > 1) args.push("--steps", String(steps));
    return args;
  }

  if (action === "lane-lock") return buildLaneLockArgs({ ...body, action, target }, seq);
  if (action === "lane-mute") return buildLaneMuteArgs({ ...body, action, target }, seq);

  if (!target) throw new Error(`'${action}' needs a target handle`);
  const isCue = target.startsWith("cue_");
  const isClip = target.startsWith("sp_");
  if (!isCue && !isClip) throw new Error(`unknown target '${target}'`);

  if (action === "delete") {
    if (isClip) {
      if (!findClip(seq, target)) throw new Error(`unknown clip '${target}'`);
      return ["spine", "remove", "--clip", target];
    }
    if (!findCue(seq, target)) throw new Error(`unknown cue '${target}'`);
    return ["lane", "remove-cue", "--cue", target];
  }

  if (action === "split") {
    if (!isClip) throw new Error(`'split' needs a spine clip, got '${target}'`);
    const clip = findClip(seq, target);
    if (!clip) throw new Error(`unknown clip '${target}'`);
    const at = numParam(params, "at_ms");
    if (at === undefined) throw new Error(`'split' needs params.at_ms (sequence time)`);
    const local = at - (clip.timeline_in_ms ?? 0);
    if (!(local > 0 && local < (clip.duration_ms ?? 0))) {
      throw new Error(`split point ${ms(at)} is outside clip '${target}' (${ms(clip.timeline_in_ms ?? 0)}..${ms(clipEnd(clip))})`);
    }
    return ["spine", "split", "--clip", target, "--at", ms(at), "--sequence-time"];
  }

  if (action === "trim") {
    if (!isClip) throw new Error(`'trim' needs a spine clip, got '${target}'`);
    const clip = findClip(seq, target);
    if (!clip) throw new Error(`unknown clip '${target}'`);
    const edge = params.edge;
    const to = numParam(params, "to_ms");
    if (edge !== "in" && edge !== "out") throw new Error(`'trim' needs params.edge "in" or "out"`);
    if (to === undefined) throw new Error(`'trim' needs params.to_ms (sequence time of the ${edge} edge)`);
    const start = clip.timeline_in_ms ?? 0;
    const dur = clip.duration_ms ?? 0;
    if (!(to > start && to < start + dur)) {
      throw new Error(`trim ${edge} edge ${ms(to)} is outside clip '${target}' (${ms(start)}..${ms(start + dur)})`);
    }
    const src = Math.round(sequenceMsToSourceMs(clip, to));
    if (!(src > clip.source_in_ms && src < clip.source_out_ms)) {
      throw new Error(`trim ${edge} edge ${ms(to)} maps outside the clip's source range`);
    }
    return edge === "in"
      ? ["spine", "trim", "--clip", target, "--in", ms(src)]
      : ["spine", "trim", "--clip", target, "--out", ms(src)];
  }

  if (action === "move-cue") {
    if (!isCue) throw new Error(`'move-cue' needs a cue, got '${target}'`);
    const found = findCue(seq, target);
    if (!found) throw new Error(`unknown cue '${target}'`);
    const to = numParam(params, "to_ms");
    if (to === undefined) throw new Error(`'move-cue' needs params.to_ms (sequence time)`);
    if (to < 0) throw new Error(`'move-cue' needs params.to_ms >= 0`);
    const { cue } = found;
    // Optional duration in the same call (cue leading-edge drags move and resize at once).
    const dur = numParam(params, "duration_ms");
    if (dur !== undefined && !(dur >= 1)) throw new Error(`'move-cue' needs params.duration_ms >= 1`);
    const withDur = (args: string[]): string[] => (dur === undefined ? args : [...args, "--duration", ms(dur)]);
    if (cue?.anchor?.ref) {
      const clip = findClip(seq, cue.anchor.ref);
      if (!clip) throw new Error(`cue '${target}' is anchored to missing clip '${cue.anchor.ref}'`);
      const offset = Math.round(to - (clip.timeline_in_ms ?? 0));
      return withDur(["lane", "update-cue", "--cue", target, "--anchor", cue.anchor.ref, "--offset", ms(offset)]);
    }
    if (cue?.cue_anchor?.ref) {
      const ref = findCue(seq, cue.cue_anchor.ref)?.cue;
      if (!ref || ref.cue_anchor) throw new Error(`cue '${target}' has a nested cue anchor the window cannot move`);
      const offset = Math.round(to - cueStartMs(seq, ref));
      return withDur(["lane", "update-cue", "--cue", target, "--anchor", cue.cue_anchor.ref, "--offset", ms(offset)]);
    }
    return withDur(["lane", "update-cue", "--cue", target, "--at", ms(to)]);
  }

  if (action === "cue-duration") {
    if (!isCue) throw new Error(`'cue-duration' needs a cue, got '${target}'`);
    if (!findCue(seq, target)) throw new Error(`unknown cue '${target}'`);
    const dur = numParam(params, "duration_ms");
    if (dur === undefined || !(dur >= 1)) throw new Error(`'cue-duration' needs params.duration_ms >= 1`);
    return ["lane", "update-cue", "--cue", target, "--duration", ms(dur)];
  }

  // mute
  const muted = params.muted;
  if (typeof muted !== "boolean") throw new Error(`'mute' needs params.muted true or false`);
  if (isCue) {
    if (!findCue(seq, target)) throw new Error(`unknown cue '${target}'`);
    return ["lane", "update-cue", "--cue", target, "--muted", muted ? "true" : "false"];
  }
  if (!findClip(seq, target)) throw new Error(`unknown clip '${target}'`);
  // The real muted flag (audio_chain.muted): mute/unmute round-trips exactly
  // and never leaves an envelope behind.
  return muted ? ["spine", "mute", "--clip", target] : ["spine", "unmute", "--clip", target];
}

function buildLaneLockArgs(body: LiveEditBody, seq: unknown): string[] {
  const params = asRecord(body.params);
  const target = typeof body.target === "string" ? body.target : "";
  const rawLane = typeof params.lane === "string" && params.lane ? params.lane : target;
  const locked = params.locked;
  if (typeof rawLane !== "string" || !rawLane) throw new Error(`'lane-lock' needs a lane id (target or params.lane)`);
  if (typeof locked !== "boolean") throw new Error(`'lane-lock' needs params.locked true or false`);
  const lanes = lanesOf(seq);
  if (lanes.length > 0 && !lanes.some((l) => l?.id === rawLane)) throw new Error(`unknown lane '${rawLane}'`);
  return ["lane", locked ? "lock" : "unlock", "--lane", rawLane];
}

function buildLaneMuteArgs(body: LiveEditBody, seq: unknown): string[] {
  const params = asRecord(body.params);
  const target = typeof body.target === "string" ? body.target : "";
  const rawLane = typeof params.lane === "string" && params.lane ? params.lane : target;
  const muted = params.muted;
  if (typeof rawLane !== "string" || !rawLane) throw new Error(`'lane-mute' needs a lane id (target or params.lane)`);
  if (typeof muted !== "boolean") throw new Error(`'lane-mute' needs params.muted true or false`);
  if (rawLane === "spine") throw new Error(`'lane-mute' cannot target the spine (mute a spine clip instead)`);
  const lanes = lanesOf(seq);
  if (lanes.length > 0 && !lanes.some((l) => l?.id === rawLane)) throw new Error(`unknown lane '${rawLane}'`);
  return ["lane", muted ? "mute" : "unmute", "--lane", rawLane];
}

function cliPath(): string {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  return path.resolve(here, "../cli.js");
}

function runCli(projectDir: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath(), ...args, "--dir", projectDir],
      {
        env: { ...process.env, [LIVE_ACTOR_ENV]: "human", CUTHOL_SKILLS_AUTO: "0" },
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const status = error && "code" in (error as object) ? Number((error as { code: unknown }).code) || 1 : error ? 1 : 0;
        resolve({ status, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    );
  });
}

// One long-lived worker thread runs the edits with the CLI's own handlers
// (live_edit_worker.ts): the modules load once instead of once per edit.
// Edits run one at a time, in order. If the worker cannot start, the edit
// falls back to a CLI subprocess.
type EditRun = { status: number; stdout: string; stderr: string };
let editWorker: Worker | null = null;
let editWorkerBroken = false;
let editSeq = 0;
const editWaiters = new Map<number, (r: EditRun) => void>();
let editChain: Promise<unknown> = Promise.resolve();

function getEditWorker(): Worker | null {
  if (editWorkerBroken) return null;
  if (editWorker) return editWorker;
  try {
    const w = new Worker(new URL("./live_edit_worker.js", import.meta.url));
    w.on("message", (m: { id: number } & EditRun) => {
      editWaiters.get(m.id)?.({ status: m.status, stdout: m.stdout, stderr: m.stderr });
      editWaiters.delete(m.id);
    });
    const fail = (why: string): void => {
      editWorker = null;
      for (const [, done] of editWaiters) done({ status: 1, stdout: "", stderr: `edit worker stopped: ${why}` });
      editWaiters.clear();
    };
    w.on("error", (e) => fail(e.message));
    w.on("exit", (code) => fail(`exit ${code}`));
    w.unref();
    editWorker = w;
    return w;
  } catch {
    editWorkerBroken = true;
    return null;
  }
}

/** Starts the edit worker and lets it load and verify once, so the first edit is quick. */
export function warmEditWorker(projectDir: string): void {
  getEditWorker()?.postMessage({ warm: projectDir });
}

function runEdit(projectDir: string, args: string[]): Promise<EditRun> {
  const next = editChain.then(
    () =>
      new Promise<EditRun>((resolve) => {
        const w = getEditWorker();
        if (!w) {
          void runCli(projectDir, args).then(resolve);
          return;
        }
        const id = ++editSeq;
        const timer = setTimeout(() => {
          editWaiters.delete(id);
          resolve({ status: 1, stdout: "", stderr: `edit timed out after ${CLI_TIMEOUT_MS} ms` });
        }, CLI_TIMEOUT_MS);
        editWaiters.set(id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        w.postMessage({ id, args, projectDir });
      })
  );
  editChain = next.catch(() => undefined);
  return next;
}

/** First diagnostic line of a failed CLI run, else the leading output. */
function cliFailureDetail(stdout: string, stderr: string): string {
  const combined = `${stderr}\n${stdout}`;
  const m = /\[CUTHOL-[A-Z0-9-]+\][^\n]*/.exec(combined);
  const raw = (m ? m[0] : combined.trim().split("\n")[0] ?? "").trim();
  const cut = raw || "the command exited with an error and no message";
  return cut.length > 500 ? `${cut.slice(0, 497)}…` : cut;
}

/**
 * Every CLI envelope drains the Live inbox, including this server's own human
 * runs. Pending packets belong to the agent's next response, so anything our
 * run consumed is moved back right away.
 */
function restoreInboxDrainedByOurRun(projectDir: string, pendingBefore: Set<string>): void {
  try {
    const { inboxDir } = resolveLivePaths(projectDir);
    const pendingNow = new Set(peekLiveInbox(projectDir).map((p) => p.id));
    const delivered = path.join(inboxDir, "delivered");
    for (const id of pendingBefore) {
      if (pendingNow.has(id)) continue;
      for (const ext of [".json", ".png"]) {
        const src = path.join(delivered, `${id}${ext}`);
        if (fs.existsSync(src)) {
          try {
            fs.renameSync(src, path.join(inboxDir, `${id}${ext}`));
          } catch {
            // another process already moved it
          }
        }
      }
    }
  } catch {
    // inbox repair never breaks an edit
  }
}

function currentCursor(projectDir: string): number {
  const { paths } = loadSequence(projectDir);
  return loadJournalManifest(paths).cursor_revision;
}

/**
 * Handles one validated POST /api/edit body. Status 200 on success, 400 on a
 * bad request, 409 on a revision conflict, 500 when the CLI command fails.
 */
export async function handleLiveEdit(projectDir: string, body: LiveEditBody): Promise<LiveEditResult> {
  const root = path.resolve(projectDir);
  const action = typeof body.action === "string" ? body.action : "(unknown)";
  const target = typeof body.target === "string" ? body.target : "";
  const g619 = (detail: string): LiveEditResult => {
    const d = DIAGNOSTICS.LIVE_EDIT_COMMAND_FAILED(action, target || "(request)", detail);
    return fail(400, d.code, d.formatted);
  };

  if (!(EDIT_ACTIONS as readonly string[]).includes(action)) {
    return g619(`unknown action '${action}' (expected one of ${EDIT_ACTIONS.join(", ")})`);
  }
  const expectRev = body.expect_rev;
  if (typeof expectRev !== "number" || !Number.isInteger(expectRev)) {
    return g619(`'expect_rev' must be the integer revision the window currently shows`);
  }

  let seq: unknown;
  let cursor: number;
  try {
    seq = loadSequence(root).sequence;
    cursor = currentCursor(root);
  } catch (e) {
    const d = DIAGNOSTICS.LIVE_EDIT_COMMAND_FAILED(action, target || "(request)", `the project state could not be read (${e instanceof Error ? e.message : String(e)})`);
    return fail(500, d.code, d.formatted);
  }

  if (expectRev !== cursor) {
    const d = DIAGNOSTICS.LIVE_EDIT_REVISION_CONFLICT(action, `the window shows r${expectRev} but the timeline is at r${cursor}`);
    return fail(409, d.code, d.formatted, { revision: cursor });
  }
  const lock = readLiveLock(root);
  if (!lock || lock.holder !== "human") {
    const d = DIAGNOSTICS.LIVE_EDIT_REVISION_CONFLICT(
      action,
      "edits need the human pause",
      "Pause the agent first (the window's pause button), then retry the edit."
    );
    return fail(409, d.code, d.formatted, { revision: cursor });
  }

  // Undo/redo stay inside the human's own revisions of this pause, and inside
  // the journal: stepping past the edge is refused here with a plain message
  // instead of failing in the CLI with a raw journal diagnostic.
  if (action === "undo" || action === "redo") {
    const steps = numParam(asRecord(body.params), "steps") ?? 1;
    if (!Number.isInteger(steps) || steps < 1 || steps > 100) return g619(`'steps' must be an integer 1..100`);
    const { paths } = loadSequence(root);
    const manifest = loadJournalManifest(paths);
    const revs = action === "undo"
      ? Array.from({ length: steps }, (_, i) => cursor - i)
      : Array.from({ length: steps }, (_, i) => cursor + 1 + i);
    let available = 0;
    for (const rev of revs) {
      const entry = manifest.entries.find((e) => e.revision === rev);
      if (!entry) {
        const d = DIAGNOSTICS.LIVE_EDIT_REVISION_CONFLICT(
          action,
          available === 0 ? `nothing to ${action}` : `only ${available} of ${steps} ${action} steps available`,
          action === "undo" ? "Make an edit first, then undo it." : "Undo an edit first, or make a new edit."
        );
        return fail(409, d.code, d.formatted, { revision: cursor });
      }
      if (rev <= lock.revision || resolveRevisionActor(root, entry.operation, entry.timestamp, entry.revision) !== "human") {
        const d = DIAGNOSTICS.LIVE_EDIT_REVISION_CONFLICT(
          action,
          `${action} would ${action === "undo" ? "revert" : "re-apply"} r${rev}, which is not one of your edits from this pause`
        );
        return fail(409, d.code, d.formatted, { revision: cursor });
      }
      available++;
    }
  }

  let args: string[];
  try {
    args = buildEditCliArgs({ ...body, action, target }, seq);
  } catch (e) {
    return g619(e instanceof Error ? e.message : String(e));
  }

  const pendingBefore = new Set(peekLiveInbox(root).map((p) => p.id));
  const run = await runEdit(root, args);
  restoreInboxDrainedByOurRun(root, pendingBefore);
  if (run.status !== 0) {
    const d = DIAGNOSTICS.LIVE_EDIT_COMMAND_FAILED(action, target || "(request)", cliFailureDetail(run.stdout, run.stderr));
    return fail(500, d.code, d.formatted, { revision: cursor });
  }
  let revision = cursor;
  try {
    revision = currentCursor(root);
  } catch {
    // keep the pre-edit cursor
  }
  return { status: 200, json: { ok: true, revision, command: args.join(" ") } };
}

// --- resume summary ------------------------------------------------------

/** Journal entries of a pause range that the human made, oldest first. */
export function humanEditsEntriesForRange(projectDir: string, fromRev: number, toRev: number): LiveActivityEntry[] {
  return activityEntriesForRange(projectDir, fromRev, toRev).filter((e) => e.actor === "human");
}

// Line formatting lives with the inbox renderer (loaded on every response).
export { formatHumanEditLines, RESUME_LINE_LIMIT } from "./live_inbox.js";

// --- HTTP ------------------------------------------------------------------

function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** POST /api/edit route handler (registered by the live server). */
export async function routeLiveEditRequest(
  projectDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: LiveEditBody;
  try {
    body = JSON.parse(await readBody(req)) as LiveEditBody;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, message: "bad json" }));
    return;
  }
  const out = await handleLiveEdit(projectDir, body ?? {});
  res.writeHead(out.status, { "Content-Type": "application/json" }).end(JSON.stringify(out.json));
}

