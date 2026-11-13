/**
 * Live human edits (`src/test/live_edit.test.ts`): window action -> CLI argv
 * mapping, expect_rev conflicts, human-only undo/redo, resume summary lines
 * (format + 12-line cap), and inbox preservation across human CLI runs.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadJournalManifest, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { peekLiveInbox, writeLiveNotePacket } from "../live/live_inbox.js";
import { resolveLivePaths } from "../live/live_paths.js";
import {
  buildEditCliArgs,
  formatHumanEditLines,
  handleLiveEdit,
  humanEditsEntriesForRange,
} from "../live/live_edit_api.js";
import { LIVE_SCHEMA } from "../live/live_types.js";
import { appendSpineClip } from "../sequence/spine.js";
import { addLaneCue } from "../sequence/lanes.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-edit-"));

function ffmpegTone(outPath: string, seconds: number): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=0x4488FF:s=160x160:r=30:d=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", outPath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

/** Two spine clips + one anchored cue + one plain cue. Returns dir + handles. */
function makeWorkspace(name: string): { dir: string; clipA: string; clipB: string; cueAnchored: string; cuePlain: string } {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  initWorkspace({ dir, title: name, aspect: "16:9", fps: 30 });
  const media = path.join(ROOT, `${name}.mp4`);
  if (!fs.existsSync(media)) ffmpegTone(media, 6);
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: dir, filePaths: [media] });
  const a = appendSpineClip({ workspaceDir: dir, assetHandle: item.handle });
  const b = appendSpineClip({ workspaceDir: dir, assetHandle: item.handle });
  const anchored = addLaneCue({
    workspaceDir: dir, laneId: "ln_broll", assetHandle: item.handle,
    anchor: { ref: a.clip.id, offset_ms: 500 }, durationMs: 2000,
  });
  const plain = addLaneCue({
    workspaceDir: dir, laneId: "ln_broll", assetHandle: item.handle, atMs: 1000, durationMs: 1500,
  });
  return { dir, clipA: a.clip.id, clipB: b.clip.id, cueAnchored: anchored.cue.id, cuePlain: plain.cue.id };
}

function cursorOf(dir: string): number {
  return loadJournalManifest(loadSequence(dir).paths).cursor_revision;
}

function takeHumanLock(dir: string): void {
  const lp = resolveLivePaths(dir);
  fs.mkdirSync(lp.dir, { recursive: true });
  fs.writeFileSync(
    lp.lockFile,
    JSON.stringify({ schema: LIVE_SCHEMA, holder: "human", since: new Date().toISOString(), revision: cursorOf(dir), server_pid: process.pid })
  );
}

function seqOf(dir: string): unknown {
  return loadSequence(dir).sequence;
}

// --- action -> CLI mapping -------------------------------------------------

test("edit mapping: split/trim/delete", () => {
  const w = makeWorkspace("map1");
  const seq = seqOf(w.dir);
  const clip = (seq as any).spine.clips[0];
  const mid = clip.timeline_in_ms + Math.floor(clip.duration_ms / 2);
  assert.deepEqual(buildEditCliArgs({ action: "split", target: clip.id, params: { at_ms: mid } }, seq), [
    "spine", "split", "--clip", clip.id, "--at", `${mid}ms`, "--sequence-time",
  ]);
  const outEdge = clip.timeline_in_ms + clip.duration_ms - 500;
  const trimArgs = buildEditCliArgs({ action: "trim", target: clip.id, params: { edge: "out", to_ms: outEdge } }, seq);
  assert.equal(trimArgs[0], "spine");
  assert.equal(trimArgs[1], "trim");
  assert.deepEqual(trimArgs.slice(2, 4), ["--clip", clip.id]);
  assert.equal(trimArgs[4], "--out");
  assert.match(trimArgs[5], /^\d+ms$/);
  assert.deepEqual(buildEditCliArgs({ action: "delete", target: clip.id }, seq), ["spine", "remove", "--clip", clip.id]);
  assert.deepEqual(buildEditCliArgs({ action: "delete", target: w.cuePlain }, seq), ["lane", "remove-cue", "--cue", w.cuePlain]);
});

test("edit mapping: move-cue keeps anchors, plain cues use --at", () => {
  const w = makeWorkspace("map2");
  const seq = seqOf(w.dir);
  const clip = (seq as any).spine.clips[0];
  const to = clip.timeline_in_ms + 1200;
  assert.deepEqual(
    buildEditCliArgs({ action: "move-cue", target: w.cueAnchored, params: { to_ms: to } }, seq),
    ["lane", "update-cue", "--cue", w.cueAnchored, "--anchor", clip.id, "--offset", `${1200}ms`]
  );
  assert.deepEqual(
    buildEditCliArgs({ action: "move-cue", target: w.cuePlain, params: { to_ms: 2500, duration_ms: 900 } }, seq),
    ["lane", "update-cue", "--cue", w.cuePlain, "--at", "2500ms", "--duration", "900ms"]
  );
  assert.deepEqual(
    buildEditCliArgs({ action: "cue-duration", target: w.cuePlain, params: { duration_ms: 800 } }, seq),
    ["lane", "update-cue", "--cue", w.cuePlain, "--duration", "800ms"]
  );
});

test("edit mapping: mute uses --muted for cues, spine mute/unmute for clips", () => {
  const w = makeWorkspace("map3");
  const seq = seqOf(w.dir);
  assert.deepEqual(
    buildEditCliArgs({ action: "mute", target: w.cuePlain, params: { muted: true } }, seq),
    ["lane", "update-cue", "--cue", w.cuePlain, "--muted", "true"]
  );
  const clip = (seq as any).spine.clips[0];
  assert.deepEqual(buildEditCliArgs({ action: "mute", target: clip.id, params: { muted: true } }, seq), [
    "spine", "mute", "--clip", clip.id,
  ]);
  assert.deepEqual(buildEditCliArgs({ action: "mute", target: clip.id, params: { muted: false } }, seq), [
    "spine", "unmute", "--clip", clip.id,
  ]);
});

test("edit mapping: undo/redo carry --expect-rev", () => {
  const w = makeWorkspace("map4");
  const seq = seqOf(w.dir);
  const cursor = cursorOf(w.dir);
  assert.deepEqual(buildEditCliArgs({ action: "undo", expect_rev: cursor }, seq), [
    "workspace", "journal", "undo", "--expect-rev", String(cursor),
  ]);
  assert.deepEqual(buildEditCliArgs({ action: "redo", params: { steps: 2 }, expect_rev: cursor }, seq), [
    "workspace", "journal", "redo", "--expect-rev", String(cursor), "--steps", "2",
  ]);
});

test("edit mapping: invalid requests throw", () => {
  const w = makeWorkspace("map5");
  const seq = seqOf(w.dir);
  const clip = (seq as any).spine.clips[0];
  assert.throws(() => buildEditCliArgs({ action: "explode", target: clip.id }, seq), /unknown action/);
  assert.throws(() => buildEditCliArgs({ action: "split", target: clip.id, params: { at_ms: -5 } }, seq), /outside clip/);
  assert.throws(() => buildEditCliArgs({ action: "trim", target: clip.id, params: { edge: "out", to_ms: 10 ** 9 } }, seq), /outside clip/);
  assert.throws(() => buildEditCliArgs({ action: "move-cue", target: w.cuePlain, params: { to_ms: -1 } }, seq), />= 0/);
  assert.throws(() => buildEditCliArgs({ action: "mute", target: clip.id, params: {} }, seq), /muted/);
  assert.throws(() => buildEditCliArgs({ action: "delete", target: "sp_99" }, seq), /unknown clip/);
});

// --- conflicts -------------------------------------------------------------

test("edit: stale expect_rev is a 409 and changes nothing", async () => {
  const w = makeWorkspace("conf1");
  takeHumanLock(w.dir);
  const cursor = cursorOf(w.dir);
  const clip = (seqOf(w.dir) as any).spine.clips[0];
  const before = JSON.stringify((seqOf(w.dir) as any).spine);
  const out = await handleLiveEdit(w.dir, {
    action: "delete", target: clip.id, expect_rev: cursor - 1,
  });
  assert.equal(out.status, 409);
  assert.equal(out.json.code, "CUTHOL-G618");
  assert.equal(out.json.revision, cursor);
  assert.equal(JSON.stringify((seqOf(w.dir) as any).spine), before);
});

test("edit: no human lock is a 409", async () => {
  const w = makeWorkspace("conf2");
  const cursor = cursorOf(w.dir);
  const clip = (seqOf(w.dir) as any).spine.clips[0];
  const out = await handleLiveEdit(w.dir, { action: "delete", target: clip.id, expect_rev: cursor });
  assert.equal(out.status, 409);
  assert.equal(out.json.code, "CUTHOL-G618");
});

// --- undo scope -------------------------------------------------------------

test("edit: undo refuses an agent revision, allows a human one", async () => {
  const w = makeWorkspace("undo1");
  takeHumanLock(w.dir);
  // Head is an agent revision (no human evidence): refuse.
  const cursor = cursorOf(w.dir);
  const refused = await handleLiveEdit(w.dir, { action: "undo", expect_rev: cursor });
  assert.equal(refused.status, 409);
  assert.match(String(refused.json.message), /not one of your edits/);
  assert.equal(cursorOf(w.dir), cursor);
  // A human revision on top: allow.
  const clip = (seqOf(w.dir) as any).spine.clips[1];
  const mid = clip.timeline_in_ms + Math.floor(clip.duration_ms / 2);
  const split = await handleLiveEdit(w.dir, { action: "split", target: clip.id, params: { at_ms: mid }, expect_rev: cursor });
  assert.equal(split.status, 200);
  const cursor2 = cursorOf(w.dir);
  assert.equal(cursor2, cursor + 1);
  const undone = await handleLiveEdit(w.dir, { action: "undo", expect_rev: cursor2 });
  assert.equal(undone.status, 200);
  assert.equal(cursorOf(w.dir), cursor);
  // Back at the pause revision: the agent revision below is refused again.
  const refused2 = await handleLiveEdit(w.dir, { action: "undo", expect_rev: cursor });
  assert.equal(refused2.status, 409);
});

// --- resume summary --------------------------------------------------------

test("resume lines: one per op, oldest first, 12 cap with +N more", () => {
  const entries = Array.from({ length: 15 }, (_, i) => ({
    revision: 45 + i,
    timestamp: new Date().toISOString(),
    operation: "spine.trim",
    summary: `spine.trim sp_0${(i % 3) + 1} −1.0s`,
    changed: [],
    actor: "human" as const,
  }));
  const lines = formatHumanEditLines(entries);
  assert.equal(lines.length, 13);
  assert.equal(lines[0], "human r45 spine.trim sp_01 −1.0s");
  assert.equal(lines[11], "human r56 spine.trim sp_03 −1.0s");
  assert.equal(lines[12], "+3 more");
  assert.deepEqual(formatHumanEditLines([]), []);
  assert.deepEqual(formatHumanEditLines(entries.slice(0, 2)), [
    "human r45 spine.trim sp_01 −1.0s",
    "human r46 spine.trim sp_02 −1.0s",
  ]);
});

test("resume entries: only the human's revisions of the pause", async () => {
  const w = makeWorkspace("resume1");
  const atPause = cursorOf(w.dir);
  takeHumanLock(w.dir);
  const clip = (seqOf(w.dir) as any).spine.clips[0];
  const mid = clip.timeline_in_ms + Math.floor(clip.duration_ms / 2);
  // Human edit through the real path (subprocess records the actor evidence).
  const split = await handleLiveEdit(w.dir, { action: "split", target: clip.id, params: { at_ms: mid }, expect_rev: atPause });
  assert.equal(split.status, 200);
  const entries = humanEditsEntriesForRange(w.dir, atPause, cursorOf(w.dir));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actor, "human");
  assert.match(entries[0].summary, /spine\.split/);
  // The agent-only range below the pause yields nothing.
  assert.deepEqual(humanEditsEntriesForRange(w.dir, atPause - 2, atPause), []);
});

// --- inbox -----------------------------------------------------------------

test("edit: a human CLI run does not consume pending packets", async () => {
  const w = makeWorkspace("inbox1");
  takeHumanLock(w.dir);
  writeLiveNotePacket(w.dir, { id: "n_testpacket", created_at: new Date().toISOString(), revision: cursorOf(w.dir), notes: [] });
  assert.equal(peekLiveInbox(w.dir).length, 1);
  const clip = (seqOf(w.dir) as any).spine.clips[0];
  const mid = clip.timeline_in_ms + Math.floor(clip.duration_ms / 2);
  const out = await handleLiveEdit(w.dir, { action: "split", target: clip.id, params: { at_ms: mid }, expect_rev: cursorOf(w.dir) });
  assert.equal(out.status, 200);
  const pending = peekLiveInbox(w.dir);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, "n_testpacket");
});

// --- stale lock ------------------------------------------------------------

test("edit: a lock from a dead server is ignored (stale drop)", async () => {
  const w = makeWorkspace("stale1");
  const lp = resolveLivePaths(w.dir);
  fs.mkdirSync(lp.dir, { recursive: true });
  fs.writeFileSync(
    lp.lockFile,
    JSON.stringify({ schema: LIVE_SCHEMA, holder: "human", since: new Date().toISOString(), revision: cursorOf(w.dir), server_pid: 2 ** 30 })
  );
  const clip = (seqOf(w.dir) as any).spine.clips[0];
  const out = await handleLiveEdit(w.dir, { action: "delete", target: clip.id, expect_rev: cursorOf(w.dir) });
  // No live lock means no pause: the edit is refused as unpaused, exactly like
  // the agent path (which would be allowed through instead of blocked).
  assert.equal(out.status, 409);
  assert.match(String(out.json.message), /human pause/);
});
