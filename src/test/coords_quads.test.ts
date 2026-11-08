// Visibility N8: rotated quads. Measurement records the four rotated corners for
// transformed elements (item + ink); geometry intersection/ratio/distance use
// convex-polygon math when at least one end has a quad (`shape: quad`), and
// axis-aligned math otherwise (`shape: box`).
//
// Hand derivation for the frozen value below (card 700x400 at (300,300) rotated
// -8° about its center (650,500); box 500x300 at (900,500); cos=0.9903, sin=-0.1392):
// card corners ≈ (275.6,350.7) (968.8,253.2) (1024.4,649.3) (331.2,746.8).
// The card∩box polygon is (900,500) (1003.4,500) (1024.4,649.3) (900,666.8):
// right edge crosses box top y=500 at x≈1003.4, bottom edge crosses box left
// x=900 at y≈666.8. Shoelace: |2234603.5-2198410|/2 ≈ 18097 (box math says 30714).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findBundledGsapMinJs } from "../compositor/bridge_hash.js";
import {
  CoordsDocElement,
  CoordsDocFrame,
  CoordsDocument,
  measureCompositionCues,
} from "../compositor/coords_extract.js";
import {
  convexPolygonDistance,
  convexPolygonIntersectionArea,
  detailGeometryFrame,
  mapLocalQuadToStage,
} from "../compositor/coords_query.js";
import { mapLocalBoxToStage } from "../compositor/coords_map.js";
import { createEmptySequence, CutholSequence, LaneCue, SpatialPlacement } from "../core/schema.js";
import { initWorkspace } from "../core/workspace.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-vis-quads-"));
const GSAP = findBundledGsapMinJs();
assert.ok(GSAP, "bundled gsap.min.js must exist");

function placement(over: Partial<SpatialPlacement> = {}): SpatialPlacement {
  return {
    x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1,
    fit_mode: "cover", crop: null, mirror_x: false, mirror_y: false, ...over,
  };
}

function stickCue(id: string, over: Partial<SpatialPlacement> = {}): LaneCue {
  return {
    id, kind: "composition", anchor: null, at_ms: 0, duration_ms: 1000,
    placement: placement(over),
    composition: {
      composition_dir: "compositions/cmp", entry_html: "index.html", props: {},
      transparent: true, mode: "overlay_alpha",
    },
    envelopes: [],
  } as LaneCue;
}

test("pure: convex polygon intersection and distance", () => {
  const a: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const b: Array<[number, number]> = [[5, 5], [15, 5], [15, 15], [5, 15]];
  assert.equal(convexPolygonIntersectionArea(a, b), 25);
  assert.equal(convexPolygonIntersectionArea(a, a), 100);
  // Winding-independent.
  const bRev = [...b].reverse() as Array<[number, number]>;
  assert.equal(convexPolygonIntersectionArea(a, bRev), 25);
  // Containment.
  const inner: Array<[number, number]> = [[2, 2], [4, 2], [4, 4], [2, 4]];
  assert.equal(convexPolygonIntersectionArea(a, inner), 4);
  // Disjoint: 3-4-5 triangle gap.
  const c: Array<[number, number]> = [[13, 10], [16, 10], [16, 13], [13, 13]];
  assert.equal(convexPolygonIntersectionArea(a, c), 0);
  assert.equal(convexPolygonDistance(a, c), 3);
  assert.equal(convexPolygonDistance(a, b), 0);
  const edgeTouch: Array<[number, number]> = [[10, 0], [20, 0], [20, 10], [10, 10]];
  assert.equal(convexPolygonIntersectionArea(a, edgeTouch), 0);
  assert.equal(convexPolygonDistance(a, edgeTouch), 0);
});

test("pure: quad mapping never drifts from box mapping", () => {
  const ctx = { compWidth: 1920, compHeight: 1080, stageWidth: 1920, stageHeight: 1080 };
  const variants: Partial<SpatialPlacement>[] = [
    {},
    { rotation_deg: 30 },
    { rotation_deg: -8, scale_x: 0.5, scale_y: 2 },
    { mirror_x: true, x_pct: 10, y_pct: -5 },
    { mirror_y: true, scale_x: 1.5, rotation_deg: 90 },
    { crop: { left_pct: 10, top_pct: 5, right_pct: 10, bottom_pct: 5 } },
  ];
  for (const over of variants) {
    const cue = stickCue("cue_01", over);
    const box = { x: 300, y: 300, w: 700, h: 400 };
    const mappedBox = mapLocalBoxToStage(box, cue, ctx, 500).box;
    const corners = mapLocalQuadToStage(
      [box.x, box.y, box.x + box.w, box.y, box.x + box.w, box.y + box.h, box.x, box.y + box.h],
      cue, ctx, 500
    );
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    // A box's own corners map to its mapped box (1e-9: same math, FP reassociation).
    const got = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    const want = [mappedBox.x, mappedBox.y, mappedBox.w, mappedBox.h];
    for (let i = 0; i < 4; i++) {
      assert.ok(Math.abs(got[i] - want[i]) < 1e-9, `${JSON.stringify(over)} [${i}]: ${got[i]} vs ${want[i]}`);
    }
  }
});

function quadDoc(): { seq: CutholSequence; docs: CoordsDocument[] } {
  const seq = createEmptySequence({ projectId: "q", title: "q", aspect: "16:9", fps: 30 });
  const cue = stickCue("cue_01");
  seq.lanes.push({ id: "ln_motion", kind: "composition", z_index: 0, muted: false, locked: false, cues: [cue] });
  const elements: CoordsDocElement[] = [
    { key: "card", kind: "box", label: "card" },
    { key: "box", kind: "box", label: "box" },
  ];
  const frames: CoordsDocFrame[] = [
    {
      f: 45,
      items: [
        [0, 275.6, 253.2, 748.9, 493.5, 1, 0],
        [1, 900, 500, 500, 300, 1, 1],
      ],
      quads: [[0, 275.6, 350.7, 968.8, 253.2, 1024.4, 649.3, 331.2, 746.8]],
    },
  ];
  const doc: CoordsDocument = {
    schema: "cuthol.coords/2",
    cue_id: "cue_01",
    composition: "cmp",
    composition_dir: "compositions/cmp",
    width: 1920, height: 1080, fps: 30,
    frame_count: 90,
    cue_duration_ms: 3000,
    sequence_start_frame: 0,
    stage: { width: 1920, height: 1080, fps: 30 },
    mapping: {
      composition_size: { width: 1920, height: 1080 },
      stage_size: { width: 1920, height: 1080 },
      placement_at_measure: placement(),
      placement_envelopes: [],
      note: "test",
    },
    engine_version: "4",
    hyperframes_version: "test",
    fonts_bundled: true,
    sequence_digest: "test",
    elements,
    frames,
  };
  return { seq, docs: [doc] };
}

test("pure: mixed quad×box pair uses polygon math and reports shape", () => {
  const { seq, docs } = quadDoc();
  const res = detailGeometryFrame({
    sequence: seq,
    docs,
    sequenceFrame: 45,
    refs: ["cue_01/card", "cue_01/box"],
  });
  assert.equal(res.pairs.length, 1);
  const pair = res.pairs[0];
  assert.equal(pair.shape, "quad");
  // Hand value 18097 (box math would say 30714); ±2%.
  assert.ok(
    Math.abs(pair.intersection! - 18097) / 18097 < 0.02,
    `intersection ${pair.intersection}`
  );
  assert.ok(Math.abs(pair.overlap_ratio! - 0.1206) < 0.0025, `ratio ${pair.overlap_ratio}`);
  assert.equal(pair.distance, 0);
});

test("pure: box×box pair keeps axis math and reports shape box", () => {
  const { seq, docs } = quadDoc();
  delete docs[0].frames[0].quads;
  const res = detailGeometryFrame({
    sequence: seq,
    docs,
    sequenceFrame: 45,
    refs: ["cue_01/card", "cue_01/box"],
  });
  const pair = res.pairs[0];
  assert.equal(pair.shape, "box");
  // Box math: 124.5 × 246.7 = 30714.15 (the old over-estimate, kept on purpose).
  assert.ok(Math.abs(pair.intersection! - 30714.15) < 0.2, `box intersection ${pair.intersection}`);
  assert.equal(pair.overlap_ratio, 0.2048);
});

function quadCompHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}#root{position:relative;width:1920px;height:1080px;overflow:hidden}#card{position:absolute;left:300px;top:300px;width:700px;height:400px;background:#D2CABA;transform:rotate(-8deg)}#cap{position:absolute;left:60px;top:120px;font-size:120px;font-weight:700;color:#1E1C19;white-space:nowrap}#box{position:absolute;left:900px;top:500px;width:500px;height:300px;background:#1F8AFF}#base{position:absolute;left:100px;top:800px;width:200px;height:100px;background:#3FA34D}</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="1">
<div id="card"><div id="cap">HELLO</div></div>
<div id="box"></div>
<div id="base"></div>
</div>
<script src="assets/gsap.min.js"></script>
<script>
const tl = gsap.timeline({ paused: true });
tl.set({}, {}, 1);
window.__timelines["main"] = tl;
</script>
</body></html>
`;
}

test("browser: measurement records quads consistent with boxes", async () => {
  const projDir = fs.mkdtempSync(path.join(TEST_ROOT, "quads-"));
  initWorkspace({ dir: projDir, title: "quads", aspect: "16:9", fps: 30 });
  const compDir = path.join(projDir, "compositions", "cmp");
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(compDir, "index.html"), quadCompHtml(), "utf8");
  fs.copyFileSync(GSAP as string, path.join(compDir, "assets", "gsap.min.js"));
  const seqPath = path.join(projDir, "cuthol.sequence.json");
  const seq = JSON.parse(fs.readFileSync(seqPath, "utf8")) as CutholSequence;
  const cue: LaneCue = {
    id: "cue_01", kind: "composition", anchor: null, at_ms: 0, duration_ms: 1000, z_index: 0,
    placement: placement(),
    composition: {
      composition_dir: "compositions/cmp", entry_html: "index.html", props: {},
      transparent: true, mode: "overlay_alpha", scene_host: null,
    },
    envelopes: [],
  } as LaneCue;
  (seq.lanes.find((l) => l.id === "ln_motion") ?? seq.lanes[0]).cues.push(cue);
  fs.writeFileSync(seqPath, JSON.stringify(seq), "utf8");
  const measured = await measureCompositionCues({ workspaceDir: projDir, cueIds: ["cue_01"], refresh: true });
  assert.equal(measured.cues_measured, 1);
  const docFile = measured.cues[0].file;
  const doc = JSON.parse(fs.readFileSync(docFile, "utf8")) as CoordsDocument;
  assert.equal(doc.engine_version, "4");
  const keyOf = new Map(doc.elements.map((e, i) => [e.key, i]));
  const cardIdx = keyOf.get("card");
  const boxIdx = keyOf.get("box");
  const baseIdx = keyOf.get("base");
  const capIdx = keyOf.get("cap");
  assert.ok(cardIdx !== undefined && boxIdx !== undefined && baseIdx !== undefined);
  let quadFrames = 0;
  for (const fr of doc.frames) {
    const items = new Map(fr.items.map((r) => [r[0], r.slice(1)] as [number, number[]]));
    const inks = new Map((fr.ink ?? []).map((r) => [r[0], r.slice(1)] as [number, number[]]));
    for (const q of fr.quads ?? []) {
      const box = items.get(q[0]);
      assert.ok(box, `quad without item box, frame ${fr.f}`);
      const xs = [q[1], q[3], q[5], q[7]];
      const ys = [q[2], q[4], q[6], q[8]];
      const edges = [
        Math.min(...xs) - box![0], Math.min(...ys) - box![1],
        Math.max(...xs) - (box![0] + box![2]), Math.max(...ys) - (box![1] + box![3]),
      ];
      assert.ok(edges.every((v) => Math.abs(v) <= 1.2), `quad/box mismatch f${fr.f}: ${JSON.stringify(q)} vs ${JSON.stringify(box)}`);
    }
    for (const q of fr.ink_quads ?? []) {
      const ink = inks.get(q[0]);
      assert.ok(ink, `ink quad without ink box, frame ${fr.f}`);
      const xs = [q[1], q[3], q[5], q[7]];
      const ys = [q[2], q[4], q[6], q[8]];
      const edges = [
        Math.min(...xs) - ink![0], Math.min(...ys) - ink![1],
        Math.max(...xs) - (ink![0] + ink![2]), Math.max(...ys) - (ink![1] + ink![3]),
      ];
      assert.ok(edges.every((v) => Math.abs(v) <= 1.2), `ink quad mismatch f${fr.f}`);
    }
    if ((fr.quads ?? []).some((q) => q[0] === cardIdx)) quadFrames++;
    // Unrotated elements keep boxes only.
    assert.ok(!(fr.quads ?? []).some((q) => q[0] === boxIdx), `box quad f${fr.f}`);
    assert.ok(!(fr.quads ?? []).some((q) => q[0] === baseIdx), `base quad f${fr.f}`);
  }
  assert.ok(quadFrames > 0, "card quads recorded");
  // Rotated text carries item + ink quads on at least one frame.
  const f0 = doc.frames[0];
  if (capIdx !== undefined) {
    assert.ok((f0.quads ?? []).some((q) => q[0] === capIdx), "cap item quad");
    if ((f0.ink ?? []).some((r) => r[0] === capIdx)) {
      assert.ok((f0.ink_quads ?? []).some((q) => q[0] === capIdx), "cap ink quad");
    }
  }
  // End to end: the measured card×box pair reports the hand intersection.
  const seqNow = JSON.parse(fs.readFileSync(seqPath, "utf8")) as CutholSequence;
  const geo = detailGeometryFrame({ sequence: seqNow, docs: [doc], sequenceFrame: 15, refs: ["cue_01/card", "cue_01/box"] });
  assert.equal(geo.pairs[0].shape, "quad");
  assert.ok(Math.abs(geo.pairs[0].intersection! - 18097) / 18097 < 0.02, `e2e intersection ${geo.pairs[0].intersection}`);
  // Unrotated control pair keeps box math.
  const boxGeo = detailGeometryFrame({ sequence: seqNow, docs: [doc], sequenceFrame: 15, refs: ["cue_01/box", "cue_01/base"] });
  assert.equal(boxGeo.pairs[0].shape, "box");
  assert.equal(boxGeo.pairs[0].intersection, 0);
  assert.ok((boxGeo.pairs[0].distance ?? 0) > 0);
});
