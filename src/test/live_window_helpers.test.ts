// Live window helpers: pure functions behind the window (thumbnail URLs, render
// strip states, edit toasts, note restore, timeline picking).
// @ts-ignore - plain JS UI modules without types; resolved at runtime
import { sceneThumbPath } from "../../src/live/ui/scenes.js";
// @ts-ignore - plain JS UI modules without types; resolved at runtime
import { displayStageState, stageProgressText } from "../../src/live/ui/topbar.js";
// @ts-ignore - plain JS UI modules without types; resolved at runtime
import { friendlyEditError } from "../../src/live/ui/edit.js";
// @ts-ignore - plain JS UI modules without types; resolved at runtime
import { mergeRestoredSent, packetToSentEntry } from "../../src/live/ui/notes.js";
// @ts-ignore - plain JS UI modules without types; resolved at runtime
import { pickItemAt } from "../../src/live/ui/timeline.js";
import test from "node:test";
import assert from "node:assert/strict";

test("content-keyed thumb URL is used as is (no revision query)", () => {
  assert.equal(sceneThumbPath({ id: "sc_3", thumb: "/api/thumb/sc_3?k=abc123" }, 108), "/api/thumb/sc_3?k=abc123");
});

test("fallback thumb URL carries only the scene bust revision", () => {
  assert.equal(sceneThumbPath({ id: "sc_3" }, 108), "/api/thumb/sc_3?v=108");
  assert.equal(sceneThumbPath({ id: "sc_3" }, null), "/api/thumb/sc_3");
});

test("a running stage shows failed once the render failed", () => {
  assert.equal(displayStageState("failed", "running"), "failed");
  assert.equal(displayStageState("failed", "done"), "done");
  assert.equal(displayStageState("running", "running"), "running");
  assert.equal(displayStageState("done", "done"), "done");
});

test("stage counter text from done/total", () => {
  assert.equal(stageProgressText({ done: 2, total: 5 }), "2/5");
  assert.equal(stageProgressText({ done: 0, total: 5 }), "0/5");
  assert.equal(stageProgressText({ done: 5, total: 5 }), "5/5");
  assert.equal(stageProgressText({ done: 0, total: 0 }), "");
  assert.equal(stageProgressText({}), "");
  assert.equal(stageProgressText(null), "");
});

test("redo/undo boundary failures get plain sentences", () => {
  assert.equal(
    friendlyEditError({ message: "Live edit 'redo' on '' failed: [CUTHOL-SYS03] No further revision to go to in the 'redo' direction in the journal." }),
    "Nothing to redo"
  );
  assert.equal(
    friendlyEditError({ message: "[CUTHOL-SYS03] No further revision to go to in the 'undo' direction in the journal." }),
    "Nothing to undo"
  );
  // The live edit API's own boundary wording (journal checked before applying).
  assert.equal(
    friendlyEditError({ message: "[CUTHOL-G618] Live edit 'redo' was not applied: nothing to redo. | Suggestion: Undo an edit first, or make a new edit." }),
    "Nothing to redo"
  );
  assert.equal(
    friendlyEditError({ message: "[CUTHOL-G618] Live edit 'undo' was not applied: nothing to undo. | Suggestion: Make an edit first." }),
    "Nothing to undo"
  );
  assert.equal(
    friendlyEditError({ message: "[CUTHOL-G618] Live edit 'redo' was not applied: edits need the human pause. | Suggestion: Pause the agent first." }),
    "edits need the human pause."
  );
});

test("codes, server prefix and suggestions are stripped", () => {
  assert.equal(
    friendlyEditError({ message: "Live edit 'trim' on 'sp_02' failed: [CUTHOL-G619] Clip not found | Suggestion: retry." }),
    "Clip not found"
  );
  assert.equal(friendlyEditError({ note: "[CUTHOL-G618] stale revision" }), "stale revision");
  assert.equal(friendlyEditError({}), "request failed");
  assert.equal(friendlyEditError({ message: "Live edit 'x' on 'y' failed: " }), "Edit failed");
  const long = friendlyEditError({ message: `[CUTHOL-G619] ${"z".repeat(300)}` });
  assert.ok(long.length <= 160 && long.endsWith("…"));
});

test("inbox packets restore as waiting, newest first", () => {
  const packets = [
    { id: "p1", created_at: "t1", notes: [{ n: 1, text: "first", at_ms: 1000, frame: 30, point: { x: 1, y: 1 }, elements: [] }] },
    { id: "p2", created_at: "t2", notes: [{ n: 1, text: "second", at_ms: 2000, frame: 60, point: { x: 2, y: 2 }, elements: [] }] },
  ];
  const next = mergeRestoredSent(packets, []);
  assert.deepEqual(next.map((e: any) => [e.id, e.status]), [["p2", "waiting"], ["p1", "waiting"]]);
  assert.equal(next[0].count, 1);
  assert.match(next[0].lines[0], /second/);
});

test("delivered entries survive, stale waiting flips to delivered", () => {
  const packets = [{ id: "p1", created_at: "t1", notes: [{ n: 1, text: "a", at_ms: 0, frame: 0, point: { x: 0, y: 0 }, elements: [] }] }];
  const candidates = [
    { id: "p0", frame: 1, count: 1, lines: ["x"], status: "delivered", sentAt: "t0", deliveredAt: "17:00" },
    { id: "p9", frame: 2, count: 1, lines: ["y"], status: "waiting", sentAt: "t9", deliveredAt: null },
  ];
  const next = mergeRestoredSent(packets, candidates);
  assert.deepEqual(next.map((e: any) => [e.id, e.status]), [["p1", "waiting"], ["p0", "delivered"], ["p9", "delivered"]]);
  assert.equal(next[1].deliveredAt, "17:00");
  assert.equal(next[2].deliveredAt, "earlier");
});

test("an inbox id wins over a stored delivered copy", () => {
  const packets = [{ id: "p1", created_at: "t1", notes: [{ n: 1, text: "a", at_ms: 0, frame: 0, point: { x: 0, y: 0 }, elements: [] }] }];
  const next = mergeRestoredSent(packets, [{ id: "p1", status: "delivered", deliveredAt: "17:00" }]);
  assert.equal(next.length, 1);
  assert.equal(next[0].status, "waiting");
  assert.equal(next[0].deliveredAt, null);
});

test("overlap click picks the topmost (last painted) item", () => {
  const items = [
    { id: "cue_07", start: 5760, end: 8760 },
    { id: "cue_08", start: 7280, end: 9360 },
  ];
  assert.equal(pickItemAt(items, 8000)?.id, "cue_08");
  assert.equal(pickItemAt(items, 6000)?.id, "cue_07");
  assert.equal(pickItemAt(items, 9000)?.id, "cue_08");
  assert.equal(pickItemAt(items, 1000), null);
  assert.equal(pickItemAt([], 8000), null);
});
