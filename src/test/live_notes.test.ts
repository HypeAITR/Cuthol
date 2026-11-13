// Live notes (region E): click-to-stage mapping, packet line format, frame
// grouping, topmost ordering, sheet geometry and the coords timeout path.
// @ts-ignore - plain JS UI module without types; resolved at runtime
import { clientToStage, formatNoteLine, formatNoteTime, formatPacketText, frameAtMs, groupNotesByFrame, stageToClient } from "../../src/live/ui/notes.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initWorkspace } from "../core/workspace.js";
import { formatLiveNoteLines } from "../live/live_inbox.js";
import {
  computeSheetCell,
  intersectionArea,
  queryElementsAtPoint,
  routeLiveCoordsRequest,
  SHEET_CELL_H,
  SHEET_CELL_W,
  sortTopmostFirst,
  stageToCell,
  withQueryTimeout,
} from "../live/live_notes_api.js";
import type { LiveNote, LiveNotePacket } from "../live/live_types.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");

function makeProject(name: string): string {
  const dir = path.join(TEST_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  initWorkspace({ dir, title: name, aspect: "16:9", fps: 30 });
  return dir;
}

function makeNote(n: number, text: string, frame: number, atMs: number): LiveNote {
  return {
    n,
    text,
    at_ms: atMs,
    frame,
    point: { x: 960, y: 540, nx: 0.5, ny: 0.5 },
    elements: [
      { ref: "cue_12/#title", box: [900, 500, 200, 60], z: 2 },
      { ref: "cue_12/#photo", box: [950, 520, 200, 60], z: 1 },
    ],
    overlap_px2: 1240,
  };
}

// -- frame + click mapping (UI pure helpers) --------------------------------

test("frameAtMs matches the preview timecode frame", () => {
  assert.equal(frameAtMs(0, 30), 0);
  assert.equal(frameAtMs(340100, 30), 10203);
  assert.equal(frameAtMs(33.3, 30), 0);
  assert.equal(frameAtMs(-50, 30), 0);
});

test("clientToStage maps a click on an exactly fitted stage", () => {
  const rect = { left: 100, top: 50, width: 960, height: 540 };
  const p = clientToStage(100 + 480, 50 + 270, rect, 1920, 1080);
  assert.ok(Math.abs(p.x - 960) < 1e-9);
  assert.ok(Math.abs(p.y - 540) < 1e-9);
  assert.equal(p.scale, 0.5);
});

test("clientToStage accounts for letterbox offset", () => {
  // Stage rect taller than the 16:9 picture: 30 px bars top and bottom.
  const rect = { left: 0, top: 0, width: 960, height: 600 };
  const top = clientToStage(480, 30, rect, 1920, 1080);
  assert.ok(Math.abs(top.x - 960) < 1e-9);
  assert.ok(Math.abs(top.y - 0) < 1e-9);
  const bottom = clientToStage(480, 570, rect, 1920, 1080);
  assert.ok(Math.abs(bottom.y - 1080) < 1e-9);
  const back = stageToClient(960, 540, rect, 1920, 1080);
  assert.ok(Math.abs(back.x - 480) < 1e-9);
  assert.ok(Math.abs(back.y - 300) < 1e-9);
});

// -- packet line format ------------------------------------------------------

test("formatNoteTime renders MM:SS.cc", () => {
  assert.equal(formatNoteTime(0), "00:00.00");
  assert.equal(formatNoteTime(340120), "05:40.12");
  assert.equal(formatNoteTime(61000), "01:01.00");
});

test("formatNoteLine renders one line per note", () => {
  const line = formatNoteLine(makeNote(1, "box drifts into the photo", 10203, 340120));
  assert.equal(line, '#1 05:40.12 "box drifts into the photo" → cue_12/#title ∩ cue_12/#photo 1240 px²');
});

test("formatNoteLine without elements has no arrow part", () => {
  const note = makeNote(2, "trim here", 9, 300);
  note.elements = [];
  delete note.overlap_px2;
  assert.equal(formatNoteLine(note), '#2 00:00.30 "trim here"');
});

test("formatPacketText keeps one line per note", () => {
  const notes = Array.from({ length: 8 }, (_, i) => makeNote(i + 1, `note ${i + 1}`, 5, 167));
  const lines = formatPacketText(notes).split("\n");
  assert.equal(lines.length, 8);
  assert.ok(lines[7].startsWith("#8 "));
});

test("inbox lines stay one per note for an 8-note packet", () => {
  const packet: LiveNotePacket = {
    schema: "cuthol.live/1",
    id: "n_test",
    created_at: new Date().toISOString(),
    revision: 1,
    notes: Array.from({ length: 8 }, (_, i) => makeNote(i + 1, `note ${i + 1}`, 5, 167)),
    sheet: ".cuthol/live/inbox/n_test.png",
  };
  const lines = formatLiveNoteLines([packet]);
  const noteLines = lines.filter((l) => !l.startsWith("sheet:"));
  assert.equal(noteLines.length, 8);
  for (let i = 0; i < 8; i++) assert.ok(noteLines[i].includes(`note ${i + 1}`));
});

// -- frame grouping ----------------------------------------------------------

test("groupNotesByFrame groups one frame into one packet", () => {
  const items = [
    { frame: 5, n: 1 },
    { frame: 5, n: 2 },
    { frame: 9, n: 1 },
  ];
  const groups = groupNotesByFrame(items);
  assert.equal(groups.size, 2);
  assert.equal(groups.get(5).length, 2);
  assert.equal(groups.get(9).length, 1);
});

// -- timeout path ------------------------------------------------------------

test("withQueryTimeout passes a fast answer through", async () => {
  const r = await withQueryTimeout(Promise.resolve(42), 1000);
  assert.deepEqual(r, { ok: true, value: 42 });
});

test("withQueryTimeout cuts a hanging query", async () => {
  const hanging = new Promise<number>(() => {});
  const t0 = Date.now();
  const r = await withQueryTimeout(hanging, 30);
  assert.deepEqual(r, { ok: false });
  assert.ok(Date.now() - t0 < 1000);
});

// -- ordering + overlap ------------------------------------------------------

test("sortTopmostFirst orders by lane, cue, then z", () => {
  const rows = [
    { ref: "a", box: [0, 0, 1, 1] as [number, number, number, number], z: 9, lane: 0, cue: 0 },
    { ref: "b", box: [0, 0, 1, 1] as [number, number, number, number], z: 1, lane: 1, cue: 0 },
    { ref: "c", box: [0, 0, 1, 1] as [number, number, number, number], z: 1, lane: 1, cue: 2 },
  ];
  assert.deepEqual(
    sortTopmostFirst(rows).map((r) => r.ref),
    ["c", "b", "a"]
  );
});

test("intersectionArea measures the shared rectangle", () => {
  assert.equal(intersectionArea([0, 0, 10, 10], [5, 5, 10, 10]), 25);
  assert.equal(intersectionArea([0, 0, 10, 10], [10, 0, 5, 5]), 0);
  assert.equal(intersectionArea([0, 0, 10, 10], [20, 20, 5, 5]), 0);
});

// -- sheet geometry ----------------------------------------------------------

test("computeSheetCell centers the crop and clamps at edges", () => {
  const mid = computeSheetCell(1920, 1080, 960, 540);
  assert.equal(mid.cropW, SHEET_CELL_W);
  assert.equal(mid.cropH, SHEET_CELL_H);
  assert.equal(mid.cropX, 960 - SHEET_CELL_W / 2);
  assert.equal(mid.cropY, 540 - SHEET_CELL_H / 2);
  assert.equal(mid.scale, 1);
  const corner = computeSheetCell(1920, 1080, 10, 10);
  assert.equal(corner.cropX, 0);
  assert.equal(corner.cropY, 0);
  const small = computeSheetCell(320, 180, 160, 90);
  assert.equal(small.cropW, 320);
  assert.equal(small.cropH, 180);
  assert.ok(small.scale > 1);
  const [cx, cy] = stageToCell(mid, 960, 540);
  assert.equal(cx, SHEET_CELL_W / 2);
  assert.equal(cy, SHEET_CELL_H / 2);
});

// -- coords endpoint ---------------------------------------------------------

test("queryElementsAtPoint on an empty project answers without measuring", async () => {
  const dir = makeProject("live-notes-empty");
  const inside = await queryElementsAtPoint(dir, 1000, 960, 540, 0, 0);
  assert.equal(inside.pending, false);
  assert.deepEqual(inside.elements, []);
  const outside = await queryElementsAtPoint(dir, 1000, 5000, 540, 0, 0);
  assert.equal(outside.pending, false);
  assert.deepEqual(outside.elements, []);
});

test("routeLiveCoordsRequest rejects bad query params", () => {
  const calls: Array<{ code: number; body: string }> = [];
  const res = {
    writeHead: (code: number) => ({ end: (body: string) => void calls.push({ code, body }) }),
  };
  const handledEmpty = routeLiveCoordsRequest("x", {} as never, res as never, new URLSearchParams(""));
  assert.equal(handledEmpty, true);
  const handledBad = routeLiveCoordsRequest("x", {} as never, res as never, new URLSearchParams("at_ms=-5&x=1&y=2"));
  assert.equal(handledBad, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.code === 400));
});
