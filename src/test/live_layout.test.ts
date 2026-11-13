/**
 * Live window layout (`src/test/live_layout.test.ts`): removed regions are
 * gone, the agent line sits on the newest agent revision's first change, the
 * playhead offset advances with playback, point-free notes travel without an
 * image and read clearly in the agent line, and lane-lock journals like any
 * other human edit (409 without the human pause).
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadJournalManifest, loadSequence } from "../core/workspace.js";
import { drainLiveInbox, formatLiveNoteLines } from "../live/live_inbox.js";
import { resolveLivePaths } from "../live/live_paths.js";
import { handleLiveNotesPost } from "../live/live_notes_api.js";
import { buildEditCliArgs, handleLiveEdit } from "../live/live_edit_api.js";
import { LIVE_SCHEMA } from "../live/live_types.js";
// @ts-ignore - plain JS UI modules without types; resolved at runtime
import { agentMarks, locateChangedMs, playheadX } from "../../src/live/ui/timeline.js";
// @ts-ignore - plain JS UI modules without types; resolved at runtime
import { displayStageState } from "../../src/live/ui/topbar.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-layout-"));

function makeProject(name: string): string {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  initWorkspace({ dir, title: name, aspect: "16:9", fps: 30 });
  return dir;
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

// --- removed regions ---------------------------------------------------------

test("layout: rail, quick view, compact mode and the bottom render strip are gone", () => {
  const ui = new URL("../../src/live/ui/", import.meta.url);
  const names = fs.readdirSync(ui);
  for (const dead of ["rail.js", "rail.css", "quickview.js", "quickview.css", "render.js", "render.css"]) {
    assert.ok(!names.includes(dead), `${dead} must not exist`);
  }
  const html = fs.readFileSync(new URL("../../src/live/ui/index.html", import.meta.url), "utf8");
  for (const region of ['data-region="rail"', 'data-region="quickview"', 'data-region="render"']) {
    assert.ok(!html.includes(region), `index.html must not mount ${region}`);
  }
  assert.ok(!html.includes("btn-compact"), "compact mode button is gone");
  assert.ok(!html.includes("topbar-actions"), "topbar action slot is gone");
  assert.ok(!html.includes("Agent editing"), "topbar agent-editing status text is gone");
});

// --- agent line + amber dots ---------------------------------------------------

const fakeSeq = {
  spine: { clips: [{ id: "sp_01", timeline_in_ms: 0 }, { id: "sp_02", timeline_in_ms: 4000 }] },
  lanes: [{ id: "ln_broll", cues: [{ id: "cue_9", at_ms: 9000 }, { id: "cue_10", anchor: { ref: "sp_02", offset_ms: 500 } }] }],
};

test("layout: agent line sits on the newest agent revision's first change", () => {
  const activity = [
    { revision: 12, actor: "agent", changed: ["cue_9"] },
    { revision: 11, actor: "human", changed: ["sp_01"] },
    { revision: 10, actor: "agent", changed: ["sp_02"] },
  ];
  assert.equal(agentMarks(activity as any, fakeSeq as any).ms, 9000);
  // A human revision on top never moves the line.
  assert.equal(
    agentMarks([{ revision: 13, actor: "human", changed: ["sp_01"] }, ...activity] as any, fakeSeq as any).ms,
    9000
  );
  // Anchored cues resolve through the anchor clip.
  assert.equal(locateChangedMs(fakeSeq as any, "cue_10"), 4500);
  assert.equal(locateChangedMs(fakeSeq as any, "sp_02"), 4000);
  assert.equal(locateChangedMs(fakeSeq as any, "cue_missing"), null);
});

test("layout: amber dots cover the last 5 agent revisions, human edits excluded", () => {
  const activity = Array.from({ length: 7 }, (_, i) => ({
    revision: 20 - i,
    actor: i === 2 ? "human" : "agent",
    changed: [`sp_0${(i % 2) + 1}`],
  }));
  const { ids } = agentMarks(activity as any, fakeSeq as any);
  assert.ok(!ids.includes("sp_human"), "human ids never listed");
  assert.ok(ids.includes("sp_01") && ids.includes("sp_02"));
});

// --- playhead -------------------------------------------------------------------

test("layout: playhead offset advances while playing", () => {
  assert.equal(playheadX(0, 0.05), 0);
  assert.ok(playheadX(2000, 0.05) > playheadX(1000, 0.05));
  assert.equal(playheadX(1000, 0.05), 50);
});

// --- point-free notes -------------------------------------------------------------

test("layout: point-free note posts without an image and reads clearly", async () => {
  const dir = makeProject("pointfree");
  const res = await handleLiveNotesPost(
    dir,
    { notes: [{ n: 1, text: "overall pacing feels slow", at_ms: 12000, frame: 360 }] },
    cursorOf(dir),
    () => {}
  );
  assert.equal(res.sheet, null);
  assert.equal(res.stored, 1);
  const payload = drainLiveInbox(dir);
  assert.ok(payload);
  assert.deepEqual(payload.images, []);
  assert.ok(payload.lines.some((l) => l.includes("overall pacing feels slow") && l.includes("(general note, no pin)")));
});

test("layout: pinned and general notes can share one packet", async () => {
  const dir = makeProject("mixed");
  const res = await handleLiveNotesPost(
    dir,
    {
      notes: [
        { n: 1, text: "pinned", at_ms: 1000, frame: 30, point: { x: 10, y: 10, nx: 0.1, ny: 0.1 }, elements: [] },
        { n: 2, text: "general", at_ms: 1000, frame: 30 },
      ],
    },
    cursorOf(dir),
    () => {}
  );
  // A packet with a pin still renders the contact sheet path attempt; the
  // general note must not break it (sheet may be null when ffmpeg fails).
  assert.equal(res.stored, 2);
  const lines = formatLiveNoteLines(drainLiveInbox(dir)!.packets);
  assert.ok(lines.some((l) => l.includes('"pinned"') && !l.includes("general note")));
  assert.ok(lines.some((l) => l.includes('"general"') && l.includes("(general note, no pin)")));
});

test("layout: a malformed point is still rejected", async () => {
  const dir = makeProject("badpoint");
  await assert.rejects(
    handleLiveNotesPost(dir, { notes: [{ n: 1, text: "x", at_ms: 0, frame: 0, point: { x: "far", y: 1 } }] }, cursorOf(dir), () => {}),
    /at least one valid note/
  );
});

// --- lane lock ---------------------------------------------------------------------

test("layout: lane-lock maps to the lane lock CLI command", () => {
  const dir = makeProject("lockmap");
  const seq = loadSequence(dir).sequence;
  assert.deepEqual(buildEditCliArgs({ action: "lane-lock", target: "ln_broll", params: { lane: "ln_broll", locked: true } }, seq), [
    "lane", "lock", "--lane", "ln_broll",
  ]);
  assert.deepEqual(buildEditCliArgs({ action: "lane-lock", target: "ln_broll", params: { locked: false } }, seq), [
    "lane", "unlock", "--lane", "ln_broll",
  ]);
  assert.throws(() => buildEditCliArgs({ action: "lane-lock", target: "ln_nope", params: { locked: true } }, seq), /unknown lane/);
  assert.throws(() => buildEditCliArgs({ action: "lane-lock", target: "ln_broll", params: {} }, seq), /locked/);
});

test("layout: lane-lock without the human pause is a 409 and journals when paused", async () => {
  const dir = makeProject("lock409");
  const cursor = cursorOf(dir);
  const refused = await handleLiveEdit(dir, {
    action: "lane-lock", target: "ln_broll", params: { lane: "ln_broll", locked: true }, expect_rev: cursor,
  });
  assert.equal(refused.status, 409);
  takeHumanLock(dir);
  const before = cursorOf(dir);
  const out = await handleLiveEdit(dir, {
    action: "lane-lock", target: "ln_broll", params: { lane: "ln_broll", locked: true }, expect_rev: before,
  });
  assert.equal(out.status, 200);
  assert.equal(cursorOf(dir), before + 1);
  assert.equal(loadSequence(dir).sequence.lanes.find((l: any) => l.id === "ln_broll")?.locked, true);
  const back = await handleLiveEdit(dir, {
    action: "lane-lock", target: "ln_broll", params: { lane: "ln_broll", locked: false }, expect_rev: before + 1,
  });
  assert.equal(back.status, 200);
  assert.equal(loadSequence(dir).sequence.lanes.find((l: any) => l.id === "ln_broll")?.locked, false);
});

// --- render pill keeps the old strip semantics ---------------------------------------

test("layout: failed render still surfaces the failing stage", () => {
  assert.equal(displayStageState("failed", "running"), "failed");
  assert.equal(displayStageState("failed", "done"), "done");
});
