// Geometry query over measured composition coordinates: pure frame math,
// browser-measured boxes, cache behaviour, and the CLI surface (JSON + compact).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findBundledGsapMinJs } from "../compositor/bridge_hash.js";
import {
  CoordsDocElement,
  CoordsDocFrame,
  CoordsDocument,
  getCoordsBrowserLaunchCount,
  resetCoordsBrowserLaunchCount,
} from "../compositor/coords_extract.js";
import {
  detailGeometryFrame,
  isGeometryAtValue,
  listGeometryFrame,
  parseGeometryMoment,
  runGeometryQuery,
} from "../compositor/coords_query.js";
import { CutholDiagnostic } from "../core/diagnostics.js";
import { createEmptySequence, CutholSequence, LaneCue, SpatialPlacement } from "../core/schema.js";
import { commitSequenceMutation, initWorkspace } from "../core/workspace.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-coords-query-"));
const CLI = path.resolve(process.cwd(), "dist/cli.js");

// ---------------------------------------------------------------------------
// Pure builders (no browser): hand-made sequence + coordinate documents.
// ---------------------------------------------------------------------------

function placement(): SpatialPlacement {
  return {
    x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1,
    fit_mode: "cover", crop: null, mirror_x: false, mirror_y: false,
  };
}

function compCue(
  id: string, atMs: number, durMs: number, compDir: string, z?: number
): LaneCue {
  return {
    id, kind: "composition", anchor: null, at_ms: atMs, duration_ms: durMs,
    ...(z === undefined ? {} : { z_index: z }),
    placement: placement(),
    composition: {
      composition_dir: compDir, entry_html: "index.html", props: {},
      transparent: true, mode: "overlay_alpha",
    },
    envelopes: [],
  };
}

function querySequence(lanes: Array<{ id: string; z: number; cues: LaneCue[] }>): CutholSequence {
  const seq = createEmptySequence({ projectId: "q", title: "q", aspect: "16:9", fps: 30 });
  assert.equal(seq.stage.width, 1920);
  assert.equal(seq.stage.height, 1080);
  for (const lane of lanes) {
    seq.lanes.push({
      id: lane.id, kind: "composition", z_index: lane.z,
      muted: false, locked: false, cues: lane.cues,
    });
  }
  return seq;
}

interface TestEl {
  key: string;
  kind?: string;
  label?: string;
  parent?: number;
  group?: number;
}

function queryDoc(o: {
  cueId: string;
  startFrame: number;
  frameCount: number;
  compDir: string;
  elements: TestEl[];
  frames: Array<{
    f: number;
    items: Array<[number, number, number, number, number, number, number]>;
    ink?: Array<[number, number, number, number, number]>;
  }>;
}): CoordsDocument {
  const elements: CoordsDocElement[] = o.elements.map((e) => ({
    key: e.key, kind: e.kind ?? "box", label: e.label ?? e.key,
    ...(e.parent === undefined ? {} : { parent: e.parent }),
    ...(e.group === undefined ? {} : { group: e.group }),
  }));
  const frames: CoordsDocFrame[] = o.frames.map((f) => ({
    f: f.f, items: f.items, ...(f.ink ? { ink: f.ink } : {}),
  }));
  return {
    schema: "cuthol.coords/2",
    cue_id: o.cueId,
    composition: path.basename(o.compDir),
    composition_dir: o.compDir,
    width: 1920, height: 1080, fps: 30,
    frame_count: o.frameCount,
    cue_duration_ms: Math.round((o.frameCount / 30) * 1000),
    sequence_start_frame: o.startFrame,
    stage: { width: 1920, height: 1080, fps: 30 },
    mapping: {
      composition_size: { width: 1920, height: 1080 },
      stage_size: { width: 1920, height: 1080 },
      placement_at_measure: placement(),
      placement_envelopes: [],
      note: "test",
    },
    engine_version: "3",
    hyperframes_version: "test",
    fonts_bundled: true,
    sequence_digest: "test",
    elements,
    frames,
  };
}

function approx(actual: number, expected: number, tol = 0.11): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${expected} ± ${tol}, got ${actual}`
  );
}

// ---------------------------------------------------------------------------
// A. Pure frame math (no browser).
// ---------------------------------------------------------------------------

test("A1. disjoint boxes: gaps, distance, no intersection", () => {
  const seq = querySequence([
    { id: "ln_a", z: 10, cues: [compCue("cue_01", 0, 1000, "compositions/geo")] },
  ]);
  const doc = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 30, compDir: "compositions/geo",
    elements: [{ key: "a" }, { key: "b" }],
    frames: [{ f: 0, items: [[0, 100, 100, 200, 100, 1, 0], [1, 400, 100, 200, 100, 1, 1]] }],
  });
  const res = detailGeometryFrame({
    sequence: seq, docs: [doc], sequenceFrame: 0, refs: ["a", "b"], defaultCueId: "cue_01",
  });
  assert.equal(res.elements.length, 2);
  assert.equal(res.pairs.length, 1);
  const p = res.pairs[0];
  assert.equal(p.a, "cue_01/a");
  assert.equal(p.b, "cue_01/b");
  assert.equal(p.gap_x, 100);
  assert.equal(p.gap_y, 0);
  assert.equal(p.distance, 100);
  assert.equal(p.intersection, 0);
  assert.equal(p.overlap_ratio, 0);
  assert.equal(p.top, "cue_01/b");
  assert.equal(p.relation, "none");
  const a = res.elements[0];
  assert.deepEqual(a.item, [100, 100, 200, 100]);
  assert.equal(a.ink, null);
  assert.deepEqual(a.edges, { left: 100, top: 100, right: 1620, bottom: 880 });
  assert.equal(a.outside_ratio, 0);
  assert.equal(a.visible, true);
});

test("A2. overlap: intersection area, smaller-area ratio, zero distance", () => {
  const seq = querySequence([
    { id: "ln_a", z: 10, cues: [compCue("cue_01", 0, 1000, "compositions/geo")] },
  ]);
  const doc = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 30, compDir: "compositions/geo",
    elements: [{ key: "a" }, { key: "b" }],
    frames: [{ f: 0, items: [[0, 100, 100, 200, 100, 1, 0], [1, 250, 150, 200, 100, 1, 1]] }],
  });
  const res = detailGeometryFrame({
    sequence: seq, docs: [doc], sequenceFrame: 0, refs: ["a", "b"], defaultCueId: "cue_01",
  });
  const p = res.pairs[0];
  assert.equal(p.intersection, 2500);
  assert.equal(p.overlap_ratio, 0.125);
  assert.equal(p.gap_x, 0);
  assert.equal(p.gap_y, 0);
  assert.equal(p.distance, 0);
  assert.equal(p.top, "cue_01/b");
});

test("A3. topmost: cross-cue by cue layer, same-comp tie by document order", () => {
  const seq = querySequence([
    { id: "ln_a", z: 10, cues: [compCue("cue_01", 0, 2000, "compositions/geo")] },
    { id: "ln_b", z: 20, cues: [compCue("cue_02", 1000, 2000, "compositions/geo2")] },
  ]);
  const d1 = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 60, compDir: "compositions/geo",
    elements: [{ key: "a" }],
    frames: [{ f: 45, items: [[0, 100, 100, 200, 100, 1, 99]] }],
  });
  const d2 = queryDoc({
    cueId: "cue_02", startFrame: 30, frameCount: 60, compDir: "compositions/geo2",
    elements: [{ key: "x" }],
    frames: [{ f: 15, items: [[0, 150, 120, 200, 100, 1, 0]] }],
  });
  // cue_02 lives on the higher lane, so x is on top despite the lower z.
  const cross = detailGeometryFrame({
    sequence: seq, docs: [d1, d2], sequenceFrame: 45, refs: ["cue_01/a", "cue_02/x"],
  });
  assert.equal(cross.pairs[0].top, "cue_02/x");

  // Same composition, equal z: later document order (higher element index) paints on top.
  const tie = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 30, compDir: "compositions/geo",
    elements: [{ key: "a" }, { key: "b" }],
    frames: [{ f: 0, items: [[0, 100, 100, 200, 100, 1, 5], [1, 100, 100, 200, 100, 1, 5]] }],
  });
  const same = detailGeometryFrame({
    sequence: seq, docs: [tie], sequenceFrame: 0, refs: ["a", "b"], defaultCueId: "cue_01",
  });
  assert.equal(same.pairs[0].top, "cue_01/b");
});

test("A4. relations: ancestor, descendant, same_group, none", () => {
  const seq = querySequence([
    { id: "ln_a", z: 10, cues: [compCue("cue_01", 0, 1000, "compositions/geo")] },
  ]);
  const doc = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 30, compDir: "compositions/geo",
    elements: [
      { key: "card" },
      { key: "t1", kind: "text", parent: 0, group: 0 },
      { key: "t2", kind: "text", parent: 0, group: 0 },
      { key: "lone" },
    ],
    frames: [{
      f: 0,
      items: [
        [0, 0, 0, 500, 300, 1, 0], [1, 10, 10, 100, 40, 1, 1],
        [2, 10, 60, 100, 40, 1, 2], [3, 900, 900, 50, 50, 1, 3],
      ],
    }],
  });
  // Pairs are canonical (cue, key); the relation reads as "a is <relation> of b".
  const r1 = detailGeometryFrame({
    sequence: seq, docs: [doc], sequenceFrame: 0,
    refs: ["t1", "card"], defaultCueId: "cue_01",
  });
  assert.equal(r1.pairs[0].a, "cue_01/card");
  assert.equal(r1.pairs[0].b, "cue_01/t1");
  assert.equal(r1.pairs[0].relation, "ancestor");
  const r2 = detailGeometryFrame({
    sequence: seq, docs: [doc], sequenceFrame: 0,
    refs: ["t1", "t2"], defaultCueId: "cue_01",
  });
  assert.equal(r2.pairs[0].relation, "same_group");
  const r3 = detailGeometryFrame({
    sequence: seq, docs: [doc], sequenceFrame: 0,
    refs: ["lone", "t1"], defaultCueId: "cue_01",
  });
  assert.equal(r3.pairs[0].a, "cue_01/lone");
  assert.equal(r3.pairs[0].relation, "none");
  // Element rows carry parent/group keys.
  const t1 = r2.elements.find((e) => e.key === "t1")!;
  assert.equal(t1.parent, "card");
  assert.equal(t1.group, "card");
});

test("A5. edges from the effective box; outside ratio; negative means overflow", () => {
  const seq = querySequence([
    { id: "ln_a", z: 10, cues: [compCue("cue_01", 0, 1000, "compositions/geo")] },
  ]);
  const doc = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 30, compDir: "compositions/geo",
    elements: [{ key: "over", kind: "text" }, { key: "in" }],
    frames: [{
      f: 0,
      items: [[0, -60, 500, 200, 80, 1, 0], [1, 100, 100, 200, 100, 1, 1]],
      ink: [[0, -40, 510, 150, 50]],
    }],
  });
  const res = detailGeometryFrame({
    sequence: seq, docs: [doc], sequenceFrame: 0,
    refs: ["over", "in"], defaultCueId: "cue_01",
  });
  const over = res.elements.find((e) => e.key === "over")!;
  // Ink wins over the item box: edges and ratio come from [-40, 510, 150x50].
  assert.deepEqual(over.item, [-60, 500, 200, 80]);
  assert.deepEqual(over.ink, [-40, 510, 150, 50]);
  assert.deepEqual(over.edges, { left: -40, top: 510, right: 1920 - 110, bottom: 1080 - 560 });
  approx(over.outside_ratio!, 40 / 150);
  const inner = res.elements.find((e) => e.key === "in")!;
  assert.equal(inner.outside_ratio, 0);
});

test("A6. missing measured row falls back to the nearest frame and reports it", () => {
  const seq = querySequence([
    { id: "ln_a", z: 10, cues: [compCue("cue_01", 0, 1000, "compositions/geo")] },
  ]);
  const doc = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 30, compDir: "compositions/geo",
    elements: [{ key: "a" }],
    frames: [
      { f: 0, items: [[0, 10, 10, 50, 50, 1, 0]] },
      { f: 2, items: [[0, 30, 10, 50, 50, 1, 0]] },
    ],
  });
  const res = detailGeometryFrame({
    sequence: seq, docs: [doc], sequenceFrame: 1, refs: ["a"], defaultCueId: "cue_01",
  });
  // Frames 0 and 2 tie for nearest to local 1; the lower frame wins.
  assert.equal(res.frames[0].local_frame, 0);
  assert.deepEqual(res.elements[0].item, [10, 10, 50, 50]);
});

test("A7. out-of-range cue: structure resolves, geometry is null", () => {
  const seq = querySequence([
    { id: "ln_a", z: 10, cues: [compCue("cue_01", 0, 1000, "compositions/geo")] },
  ]);
  const doc = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 30, compDir: "compositions/geo",
    elements: [{ key: "card" }, { key: "t1", kind: "text", parent: 0, group: 0 }],
    frames: [{ f: 0, items: [[0, 0, 0, 500, 300, 1, 0], [1, 10, 10, 100, 40, 1, 1]] }],
  });
  const res = detailGeometryFrame({
    sequence: seq, docs: [doc], sequenceFrame: 29, refs: ["card", "t1"], defaultCueId: "cue_01",
  });
  assert.equal(res.frames[0].active, true);
  const far = detailGeometryFrame({
    sequence: seq, docs: [doc], sequenceFrame: 500, refs: ["card", "t1"], defaultCueId: "cue_01",
  });
  assert.equal(far.frames[0].active, false);
  assert.equal(far.frames[0].local_frame, null);
  for (const el of far.elements) {
    assert.equal(el.visible, false);
    assert.equal(el.item, null);
    assert.equal(el.ink, null);
    assert.equal(el.opacity, null);
    assert.equal(el.z, null);
    assert.equal(el.edges, null);
    assert.equal(el.outside_ratio, null);
  }
  const p = far.pairs[0];
  assert.equal(p.gap_x, null);
  assert.equal(p.distance, null);
  assert.equal(p.intersection, null);
  assert.equal(p.overlap_ratio, null);
  assert.equal(p.top, null);
  assert.equal(p.relation, "ancestor");
});

test("A8. list mode: visible elements only, short rows", () => {
  const seq = querySequence([
    { id: "ln_a", z: 10, cues: [compCue("cue_01", 0, 1000, "compositions/geo")] },
  ]);
  const doc = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 30, compDir: "compositions/geo",
    elements: [{ key: "a" }, { key: "b" }, { key: "gone" }],
    frames: [{ f: 0, items: [[0, 100, 100, 50, 50, 1, 0], [1, 200, 200, 50, 50, 0.5, 1]] }],
  });
  const res = listGeometryFrame({ sequence: seq, docs: [doc], sequenceFrame: 0, defaultCueId: "cue_01" });
  assert.equal(res.elements.length, 2);
  assert.deepEqual(Object.keys(res.elements[0]).sort(), [
    "cue", "ink", "item", "key", "kind", "label", "opacity", "z",
  ]);
  assert.equal(res.elements[1].opacity, 0.5);
});

test("A9. unknown key errors with the nearest suggestion (CUTHOL-G428)", () => {
  const seq = querySequence([
    { id: "ln_a", z: 10, cues: [compCue("cue_01", 0, 1000, "compositions/geo")] },
  ]);
  const doc = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 30, compDir: "compositions/geo",
    elements: [{ key: "card" }, { key: "title", kind: "text" }],
    frames: [{ f: 0, items: [[0, 0, 0, 100, 100, 1, 0], [1, 0, 0, 100, 40, 1, 1]] }],
  });
  assert.throws(
    () =>
      detailGeometryFrame({
        sequence: seq, docs: [doc], sequenceFrame: 0,
        refs: ["titel"], defaultCueId: "cue_01",
      }),
    (err: unknown) => {
      const diag = (err as { diagnostic?: CutholDiagnostic }).diagnostic;
      assert.ok(diag, "must throw a CutholError with a diagnostic");
      assert.equal(diag.code, "CUTHOL-G428");
      assert.match(diag.what, /titel/);
      assert.match(diag.suggestion ?? "", /title/);
      return true;
    }
  );
});

test("A10. bare keys need one cue; moments parse as time or frames", () => {
  const seq = querySequence([
    { id: "ln_a", z: 10, cues: [compCue("cue_01", 0, 2000, "compositions/geo")] },
    { id: "ln_b", z: 20, cues: [compCue("cue_02", 1000, 2000, "compositions/geo2")] },
  ]);
  const d1 = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 60, compDir: "compositions/geo",
    elements: [{ key: "a" }],
    frames: [{ f: 45, items: [[0, 100, 100, 50, 50, 1, 0]] }],
  });
  const d2 = queryDoc({
    cueId: "cue_02", startFrame: 30, frameCount: 60, compDir: "compositions/geo2",
    elements: [{ key: "x" }],
    frames: [{ f: 15, items: [[0, 100, 100, 50, 50, 1, 0]] }],
  });
  assert.throws(
    () => detailGeometryFrame({ sequence: seq, docs: [d1, d2], sequenceFrame: 45, refs: ["a"] }),
    (err: unknown) => {
      const diag = (err as { diagnostic?: CutholDiagnostic }).diagnostic;
      assert.ok(diag);
      assert.equal(diag.code, "CUTHOL-G429");
      return true;
    }
  );
  const ok = detailGeometryFrame({
    sequence: seq, docs: [d1, d2], sequenceFrame: 45, refs: ["cue_01/a", "cue_02/x"],
  });
  assert.equal(ok.pairs.length, 1);

  assert.deepEqual(parseGeometryMoment("1500ms", 30), { sequence_frame: 45, sequence_ms: 1500 });
  assert.deepEqual(parseGeometryMoment("1.5s", 30), { sequence_frame: 45, sequence_ms: 1500 });
  assert.deepEqual(parseGeometryMoment("45f", 30), { sequence_frame: 45, sequence_ms: 1500 });
  assert.deepEqual(parseGeometryMoment("75", 30), { sequence_frame: 75, sequence_ms: 2500 });
  assert.equal(isGeometryAtValue("75,90"), false);
  assert.equal(isGeometryAtValue("75"), false);
  assert.equal(isGeometryAtValue("1500ms"), true);
  assert.equal(isGeometryAtValue("45f"), true);
});

test("A11. paint order follows lane order when cue z points the other way", () => {
  const seq = querySequence([
    { id: "ln_a", z: 10, cues: [compCue("cue_01", 0, 2000, "compositions/geo", 50)] },
    { id: "ln_b", z: 20, cues: [compCue("cue_02", 0, 2000, "compositions/geo2")] },
  ]);
  const d1 = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 60, compDir: "compositions/geo",
    elements: [{ key: "a" }],
    frames: [{ f: 0, items: [[0, 100, 100, 200, 100, 1, 0]] }],
  });
  const d2 = queryDoc({
    cueId: "cue_02", startFrame: 0, frameCount: 60, compDir: "compositions/geo2",
    elements: [{ key: "x" }],
    frames: [{ f: 0, items: [[0, 150, 120, 200, 100, 1, 0]] }],
  });
  const res = detailGeometryFrame({
    sequence: seq, docs: [d1, d2], sequenceFrame: 0, refs: ["cue_01/a", "cue_02/x"],
  });
  assert.equal(res.pairs[0].top, "cue_02/x");
});

test("A12. mixed cue z in one lane defaults the missing z to 0", () => {
  const seq = querySequence([
    {
      id: "ln_a", z: -10,
      cues: [
        compCue("cue_01", 0, 2000, "compositions/geo"),
        compCue("cue_02", 0, 2000, "compositions/geo2", -1),
      ],
    },
  ]);
  const d1 = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 60, compDir: "compositions/geo",
    elements: [{ key: "a" }],
    frames: [{ f: 0, items: [[0, 100, 100, 200, 100, 1, 0]] }],
  });
  const d2 = queryDoc({
    cueId: "cue_02", startFrame: 0, frameCount: 60, compDir: "compositions/geo2",
    elements: [{ key: "x" }],
    frames: [{ f: 0, items: [[0, 150, 120, 200, 100, 1, 0]] }],
  });
  const res = detailGeometryFrame({
    sequence: seq, docs: [d1, d2], sequenceFrame: 0, refs: ["cue_01/a", "cue_02/x"],
  });
  // cue_02 sorts at -1, cue_01 at the default 0, so cue_01 paints later.
  assert.equal(res.pairs[0].top, "cue_01/a");
});

test("A13. no cue z in one lane keeps array order", () => {
  const seq = querySequence([
    {
      id: "ln_a", z: 10,
      cues: [
        compCue("cue_01", 0, 2000, "compositions/geo"),
        compCue("cue_02", 0, 2000, "compositions/geo2"),
      ],
    },
  ]);
  const d1 = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 60, compDir: "compositions/geo",
    elements: [{ key: "a" }],
    frames: [{ f: 0, items: [[0, 100, 100, 200, 100, 1, 0]] }],
  });
  const d2 = queryDoc({
    cueId: "cue_02", startFrame: 0, frameCount: 60, compDir: "compositions/geo2",
    elements: [{ key: "x" }],
    frames: [{ f: 0, items: [[0, 150, 120, 200, 100, 1, 0]] }],
  });
  const res = detailGeometryFrame({
    sequence: seq, docs: [d1, d2], sequenceFrame: 0, refs: ["cue_01/a", "cue_02/x"],
  });
  assert.equal(res.pairs[0].top, "cue_02/x");
});

test("A14. tied lane z keeps lane array order", () => {
  const seq = querySequence([
    { id: "ln_a", z: 10, cues: [compCue("cue_01", 0, 2000, "compositions/geo")] },
    { id: "ln_b", z: 10, cues: [compCue("cue_02", 0, 2000, "compositions/geo2")] },
  ]);
  const d1 = queryDoc({
    cueId: "cue_01", startFrame: 0, frameCount: 60, compDir: "compositions/geo",
    elements: [{ key: "a" }],
    frames: [{ f: 0, items: [[0, 100, 100, 200, 100, 1, 0]] }],
  });
  const d2 = queryDoc({
    cueId: "cue_02", startFrame: 0, frameCount: 60, compDir: "compositions/geo2",
    elements: [{ key: "x" }],
    frames: [{ f: 0, items: [[0, 150, 120, 200, 100, 1, 0]] }],
  });
  const res = detailGeometryFrame({
    sequence: seq, docs: [d1, d2], sequenceFrame: 0, refs: ["cue_01/a", "cue_02/x"],
  });
  assert.equal(res.pairs[0].top, "cue_02/x");
});

// ---------------------------------------------------------------------------
// B. Browser-measured boxes (small synthetic compositions).
// ---------------------------------------------------------------------------

const GSAP = findBundledGsapMinJs();
assert.ok(GSAP, "bundled gsap.min.js must exist");

function compHtml(bodyInner: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}#root{position:relative;overflow:hidden}</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="2">
${bodyInner}
</div>
<script src="assets/gsap.min.js"></script>
<script>
window.__timelines = window.__timelines || {};
window.__timelines["main"] = gsap.timeline({paused:true});
</script>
</body></html>
`;
}

const GEO_HTML = compHtml(
  `<div id="a" style="position:absolute;left:100px;top:100px;width:200px;height:100px;background:#f00"></div>
<div id="b" style="position:absolute;left:400px;top:100px;width:200px;height:100px;background:#0f0"></div>
<div id="card" style="position:absolute;left:700px;top:100px;width:300px;height:150px;background:#224;transform:rotate(20deg)"><div id="ctext" style="font-size:48px;color:#fff;padding:20px">Rotated ink</div></div>
<div id="over" style="position:absolute;left:-60px;top:500px;font-size:72px;color:#ff0;white-space:nowrap">Overflow edge</div>`
);

const GEO2_HTML = compHtml(
  `<div id="x" style="position:absolute;left:250px;top:150px;width:200px;height:100px;background:#00f"></div>`
);

function writeComp(projDir: string, name: string, html: string): void {
  const dir = path.join(projDir, "compositions", name);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
  fs.copyFileSync(GSAP as string, path.join(dir, "assets", "gsap.min.js"));
}

// Two overlapping cues on two lanes: cue_01 (ln_a, z 10) at 0..2000ms,
// cue_02 (ln_b, z 20) at 1000..3000ms. Both cover 1500ms (frame 45).
function makeQueryProject(): string {
  const projDir = fs.mkdtempSync(path.join(TEST_ROOT, "proj-"));
  initWorkspace({ dir: projDir, title: "query", aspect: "16:9", fps: 30 });
  writeComp(projDir, "geo", GEO_HTML);
  writeComp(projDir, "geo2", GEO2_HTML);
  const mkCue = (id: string, atMs: number, comp: string): LaneCue => ({
    id, kind: "composition", anchor: null, at_ms: atMs, duration_ms: 2000,
    placement: placement(),
    composition: {
      composition_dir: `compositions/${comp}`, entry_html: "index.html", props: {},
      transparent: true, mode: "overlay_alpha",
    },
    envelopes: [],
  });
  commitSequenceMutation(projDir, "test.add_query_cues", (seq) => {
    seq.lanes.push({
      id: "ln_a", kind: "composition", z_index: 10,
      muted: false, locked: false, cues: [mkCue("cue_01", 0, "geo")],
    });
    seq.lanes.push({
      id: "ln_b", kind: "composition", z_index: 20,
      muted: false, locked: false, cues: [mkCue("cue_02", 1000, "geo2")],
    });
  });
  return projDir;
}

let sharedProject: string | null = null;
function queryProject(): string {
  if (!sharedProject) sharedProject = makeQueryProject();
  return sharedProject;
}

test("B1. known boxes: gap, intersection, ratio, topmost, relation", async () => {
  const ws = queryProject();
  const res = await runGeometryQuery({
    workspaceDir: ws, cueId: "cue_01", atRaw: "1500ms", elementsRaw: "a,b",
  });
  assert.equal(res.mode, "geometry");
  assert.equal(res.detail, true);
  assert.equal(res.sequence_frame, 45);
  assert.equal(res.sequence_ms, 1500);
  assert.equal(res.elements.length, 2);
  assert.equal(res.pairs.length, 1);
  const p = res.pairs[0];
  approx(p.gap_x!, 100, 1);
  assert.equal(p.gap_y, 0);
  approx(p.distance!, 100, 1);
  assert.equal(p.intersection, 0);
  assert.equal(p.overlap_ratio, 0);
  assert.equal(p.top, "cue_01/b");
  assert.equal(p.relation, "none");
});

test("B2. text inside a rotated card has ink smaller than its box", async () => {
  const ws = queryProject();
  const res = await runGeometryQuery({
    workspaceDir: ws, cueId: "cue_01", atRaw: "1500ms", elementsRaw: "ctext,card",
  });
  const text = res.elements.find((e) => e.key === "ctext")!;
  assert.ok(text.item, "text must have an item box");
  assert.ok(text.ink, "rotated text must have an ink box");
  const itemArea = text.item[2] * text.item[3];
  const inkArea = text.ink[2] * text.ink[3];
  assert.ok(inkArea < itemArea, `ink ${inkArea} must be smaller than item ${itemArea}`);
  assert.equal(text.parent, "card");
  assert.equal(text.group, "card");
  const pair = res.pairs[0];
  assert.equal(pair.a, "cue_01/card");
  assert.equal(pair.relation, "ancestor");
});

test("B3. overflowing text: negative edge distance and outside ratio", async () => {
  const ws = queryProject();
  const res = await runGeometryQuery({
    workspaceDir: ws, cueId: "cue_01", atRaw: "1500ms", elementsRaw: "over",
  });
  const over = res.elements[0];
  assert.equal(over.visible, true);
  assert.ok(over.item);
  assert.ok(over.item[0] < 0, `item x must be negative, got ${over.item[0]}`);
  assert.ok(over.edges);
  assert.ok(over.edges.left < 0, `left edge must be negative, got ${over.edges.left}`);
  assert.ok(
    over.outside_ratio! > 0 && over.outside_ratio! < 1,
    `outside ratio must be partial, got ${over.outside_ratio}`
  );
});

test("B4. elements from two different cues", async () => {
  const ws = queryProject();
  const res = await runGeometryQuery({
    workspaceDir: ws, atRaw: "1500ms", elementsRaw: "cue_01/a,cue_02/x",
  });
  assert.equal(res.elements.length, 2);
  assert.equal(res.pairs.length, 1);
  const p = res.pairs[0];
  approx(p.intersection!, 2500, 150);
  approx(p.overlap_ratio!, 0.125, 0.02);
  assert.equal(p.distance, 0);
  assert.equal(p.top, "cue_02/x");
  assert.equal(p.relation, "none");
});

test("B5. unknown key suggests the nearest measured key", async () => {
  const ws = queryProject();
  await assert.rejects(
    runGeometryQuery({ workspaceDir: ws, cueId: "cue_01", atRaw: "1500ms", elementsRaw: "a,ctex" }),
    (err: unknown) => {
      const diag = (err as { diagnostic?: CutholDiagnostic }).diagnostic;
      assert.ok(diag);
      assert.equal(diag.code, "CUTHOL-G428");
      assert.match(diag.what, /ctex/);
      assert.match(diag.suggestion ?? "", /ctext/);
      return true;
    }
  );
});

test("B6. no --elements: short list of the visible elements", async () => {
  const ws = queryProject();
  const res = await runGeometryQuery({ workspaceDir: ws, cueId: "cue_01", atRaw: "45f" });
  assert.equal(res.detail, false);
  assert.deepEqual(res.pairs, []);
  const keys = res.elements.map((e) => e.key).sort();
  assert.deepEqual(keys, ["a", "b", "card", "ctext", "over"]);
  for (const el of res.elements) {
    assert.deepEqual(Object.keys(el).sort(), [
      "cue", "ink", "item", "key", "kind", "label", "opacity", "z",
    ]);
  }
});

test("B7. cache miss measures and writes; second call reads the cache", async () => {
  const ws = makeQueryProject();
  resetCoordsBrowserLaunchCount();
  const t0 = Date.now();
  const first = await runGeometryQuery({
    workspaceDir: ws, cueId: "cue_01", atRaw: "1500ms", elementsRaw: "a,b",
  });
  const d1 = Date.now() - t0;
  assert.equal(first.cues[0].cached, false);
  assert.deepEqual(first.measured, ["cue_01"]);
  assert.equal(getCoordsBrowserLaunchCount(), 1, "one browser for the miss");
  const cacheFiles = fs.readdirSync(path.join(ws, ".cuthol", "coords"));
  assert.ok(cacheFiles.length > 0, "measurement must write the cache");

  const t1 = Date.now();
  const second = await runGeometryQuery({
    workspaceDir: ws, cueId: "cue_01", atRaw: "1500ms", elementsRaw: "a,b",
  });
  const d2 = Date.now() - t1;
  assert.equal(second.cues[0].cached, true);
  assert.deepEqual(second.measured, []);
  assert.equal(getCoordsBrowserLaunchCount(), 1, "cache hit must not open a browser");
  assert.deepEqual(second.elements, first.elements);
  console.log(`geometry cache: miss=${d1}ms hit=${d2}ms`);
});

// ---------------------------------------------------------------------------
// C. CLI surface (JSON envelope + compact text); legacy frame queries unchanged.
// ---------------------------------------------------------------------------

function cli(args: string[]): { ok: boolean; result: any; raw: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // Success envelopes print on stdout; error envelopes print on stderr.
  let env: any = null;
  for (const text of [`${proc.stdout ?? ""}`, `${proc.stderr ?? ""}`]) {
    const trimmed = text.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      env = JSON.parse(trimmed.slice(start, end + 1));
      break;
    } catch {
      // try the other stream
    }
  }
  const raw = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  return {
    ok: env ? Boolean(env.ok) : proc.status === 0,
    result: env?.result ?? env,
    raw: raw.slice(0, 3000),
  };
}

test("C1. CLI detail query returns the geometry envelope", () => {
  const ws = queryProject();
  const q = cli([
    "composition", "coords", "--at", "1500ms", "--cue", "cue_01",
    "--elements", "a,b", "--dir", ws,
  ]);
  assert.ok(q.ok, q.raw);
  assert.equal(q.result.mode, "geometry");
  assert.equal(q.result.detail, true);
  assert.equal(q.result.sequence_frame, 45);
  assert.equal(q.result.elements.length, 2);
  assert.equal(q.result.pairs.length, 1);
  assert.equal(q.result.pairs[0].top, "cue_01/b");
});

test("C2. CLI list query via a frame moment", () => {
  const ws = queryProject();
  const q = cli(["composition", "coords", "--at", "45f", "--cue", "cue_01", "--dir", ws]);
  assert.ok(q.ok, q.raw);
  assert.equal(q.result.mode, "geometry");
  assert.equal(q.result.detail, false);
  assert.equal(q.result.elements.length, 5);
  assert.deepEqual(q.result.pairs, []);
});

test("C3. CLI compact text: one line per element, one per pair", () => {
  const ws = queryProject();
  const proc = spawnSync(
    process.execPath,
    [CLI, "composition", "coords", "--at", "1500ms", "--cue", "cue_01",
      "--elements", "a,b", "--compact", "--dir", ws],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0, `${proc.stdout ?? ""}${proc.stderr ?? ""}`.slice(0, 2000));
  const text = `${proc.stdout ?? ""}`;
  assert.match(text, /^OK composition\.coords/m);
  const lines = text.split(/\r?\n/);
  const elementLines = lines.filter((l) => !l.includes("<->") && /^cue_01\/[ab] /.test(l));
  assert.equal(elementLines.length, 2);
  const pairLines = lines.filter((l) => l.includes(" <-> "));
  assert.equal(pairLines.length, 1);
  assert.ok(pairLines[0].includes("cue_01/a <-> cue_01/b"));
});

test("C4. legacy bare-frame --at still returns queried frames", () => {
  const ws = queryProject();
  const q = cli(["composition", "coords", "--cue", "cue_01", "--at", "15", "--dir", ws]);
  assert.ok(q.ok, q.raw);
  assert.equal(q.result.mode, undefined);
  assert.ok(Array.isArray(q.result.cues[0].queried_frames), q.raw);
  assert.equal(q.result.cues[0].queried_frames[0].sequence_frame, 15);
});

test("C5. bare --at with --elements reads as a frame moment", () => {
  const ws = queryProject();
  const q = cli([
    "composition", "coords", "--at", "45", "--cue", "cue_01",
    "--elements", "a,b", "--dir", ws,
  ]);
  assert.ok(q.ok, q.raw);
  assert.equal(q.result.mode, "geometry");
  assert.equal(q.result.sequence_frame, 45);
});

test("C6. geometry misuse errors (CUTHOL-G429)", () => {
  const ws = queryProject();
  const noAt = cli(["composition", "coords", "--cue", "cue_01", "--elements", "a", "--dir", ws]);
  assert.equal(noAt.ok, false);
  assert.equal(noAt.result?.diagnostic?.code ?? noAt.result?.code, "CUTHOL-G429");
  const frames = cli([
    "composition", "coords", "--at", "1500ms", "--frames", "40..50",
    "--cue", "cue_01", "--dir", ws,
  ]);
  assert.equal(frames.ok, false);
});
