// Visibility N7: hand edits to `cuthol.sequence.json` report as a JSON-path diff
// (`sequence_diff`): changed values as `path: old → new`, added/removed items by
// identity (`+cue_07`, `-sp_03`). Identified arrays match by id/handle/parameter,
// never by position.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildChangesShow, diffSequenceJson } from "../core/external_changes.js";
import { initWorkspace, resolveWorkspacePaths } from "../core/workspace.js";

function seq(clips: Array<Record<string, unknown>>, lanes: Array<Record<string, unknown>> = []): Record<string, unknown> {
  return {
    meta: { revision: 3 },
    stage: { width: 1920 },
    spine: { clips },
    lanes,
    library: [],
  };
}

function clip(id: string, opacity = 1): Record<string, unknown> {
  return { id, placement: { opacity, x_pct: 0 }, envelopes: [] };
}

test("N7: changed scalar reports its JSON path", () => {
  const diff = diffSequenceJson(seq([clip("sp_01"), clip("sp_02")]), seq([clip("sp_01"), clip("sp_02", 0.5)]));
  assert.deepEqual(diff, ["spine.clips[1].placement.opacity: 1 → 0.5"]);
});

test("N7: removed and added items report bare identities", () => {
  const diff = diffSequenceJson(
    seq([clip("sp_01"), clip("sp_02"), clip("sp_03")]),
    seq([clip("sp_01"), clip("sp_02")])
  );
  assert.deepEqual(diff, ["-sp_03"]);
  const added = diffSequenceJson(seq([clip("sp_01")]), seq([clip("sp_01"), clip("sp_09")]));
  assert.deepEqual(added, ["+sp_09"]);
});

test("N7: moved identities diff by content, not by position", () => {
  // sp_02 moves from index 1 to index 0 with a changed opacity: one content line
  // under its NEW index plus the reorder line — no false add/remove pair.
  const diff = diffSequenceJson(
    seq([clip("sp_01"), clip("sp_02")]),
    seq([clip("sp_02", 0.5), clip("sp_01")])
  );
  assert.deepEqual(diff, [
    "spine.clips[0].placement.opacity: 1 → 0.5",
    "spine.clips: order sp_01,sp_02 → sp_02,sp_01",
  ]);
});

test("N7: pure reorder reports only the order line", () => {
  const diff = diffSequenceJson(seq([clip("sp_01"), clip("sp_02")]), seq([clip("sp_02"), clip("sp_01")]));
  assert.deepEqual(diff, ["spine.clips: order sp_01,sp_02 → sp_02,sp_01"]);
});

test("N7: library matches by handle, cues by id", () => {
  const oldSeq = {
    library: [{ handle: "vid_01", gain_db: 0 }],
    lanes: [{ id: "ln_motion", cues: [{ id: "cue_01", duration_ms: 1000 }] }],
  };
  const newSeq = {
    library: [
      { handle: "vid_01", gain_db: -3 },
      { handle: "vid_02", gain_db: 0 },
    ],
    lanes: [{ id: "ln_motion", cues: [{ id: "cue_01", duration_ms: 1000 }, { id: "cue_07", duration_ms: 500 }] }],
  };
  assert.deepEqual(diffSequenceJson(oldSeq, newSeq), [
    "library[0].gain_db: 0 → -3",
    "+vid_02",
    "+cue_07",
  ]);
});

test("N7: envelopes match by parameter, unidentified arrays by index", () => {
  const oldSeq = {
    clip: {
      envelopes: [{ parameter: "placement.opacity", points: [{ t: 0, v: 0 }] }],
      tags: ["a", "b"],
    },
  };
  const newSeq = {
    clip: {
      envelopes: [{ parameter: "placement.opacity", points: [{ t: 0, v: 1 }] }],
      tags: ["a", "c", "d"],
    },
  };
  assert.deepEqual(diffSequenceJson(oldSeq, newSeq), [
    "clip.envelopes[0].points[0].v: 0 → 1",
    'clip.tags[1]: "b" → "c"',
    'clip.tags[2]: + "d"',
  ]);
});

test("N7: identical trees diff empty (formatting-insensitive)", () => {
  const a = seq([clip("sp_01")]);
  const b = JSON.parse(JSON.stringify(a)) as unknown;
  assert.deepEqual(diffSequenceJson(a, b), []);
});

test("show: hand-edited project file lists paths in JSON and short text", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-vis-n7-"));
  initWorkspace({ dir: ws, title: "n7", aspect: "16:9", fps: 30 });
  const paths = resolveWorkspacePaths(ws);
  const parsed = JSON.parse(fs.readFileSync(paths.sequenceFile, "utf8")) as Record<string, unknown>;
  (parsed.stage as Record<string, unknown>).width = 1280;
  const lanes = parsed.lanes as Array<Record<string, unknown>>;
  (lanes[0].cues as unknown[]).push({ id: "cue_99", kind: "title", duration_ms: 500 });
  fs.writeFileSync(paths.sequenceFile, JSON.stringify(parsed, null, 2), "utf8");
  const shown = buildChangesShow(ws);
  assert.deepEqual(shown.sequence_diff, ["stage.width: 1920 → 1280", "+cue_99"]);
  assert.ok(shown.summary_text.includes("stage.width: 1920 → 1280"), shown.summary_text);
  assert.ok(shown.summary_text.includes("+cue_99"), shown.summary_text);
  assert.ok(!shown.summary_text.includes("more lines in JSON"));
});
