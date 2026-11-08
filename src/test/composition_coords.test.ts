// Composition coordinate extraction: measurement rules, stage mapping, cache, determinism.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findBundledGsapMinJs } from "../compositor/bridge_hash.js";
import {
  CoordsDocument,
  getCoordsBrowserLaunchCount,
  measureCompositionCues,
  resetCoordsBrowserLaunchCount,
  resolveCoordsFontBundler,
} from "../compositor/coords_extract.js";
import { CutholSequence, LaneCue, SpatialPlacement } from "../core/schema.js";
import { initWorkspace } from "../core/workspace.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-coords-"));

function placement(over: Partial<SpatialPlacement> = {}): SpatialPlacement {
  return {
    x_pct: 0,
    y_pct: 0,
    scale_x: 1,
    scale_y: 1,
    rotation_deg: 0,
    opacity: 1,
    fit_mode: "cover",
    crop: null,
    mirror_x: false,
    mirror_y: false,
    ...over,
  };
}

function compHtml(bodyInner: string, script: string, style = ""): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}#root{position:relative;overflow:hidden}${style}</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="1">
${bodyInner}
</div>
<script src="assets/gsap.min.js"></script>
<script>
${script}
</script>
</body></html>
`;
}

const GSAP = findBundledGsapMinJs();
assert.ok(GSAP, "bundled gsap.min.js must exist");

function writeComp(projDir: string, name: string, html: string): string {
  const dir = path.join(projDir, "compositions", name);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
  fs.copyFileSync(GSAP as string, path.join(dir, "assets", "gsap.min.js"));
  return dir;
}

interface FixtureCue {
  id: string;
  comp: string;
  atMs: number;
  placement?: Partial<SpatialPlacement>;
}

function makeProject(cues: FixtureCue[], comps: Record<string, string>): string {
  const projDir = fs.mkdtempSync(path.join(TEST_ROOT, "proj-"));
  initWorkspace({ dir: projDir, title: "coords", aspect: "16:9", fps: 30 });
  for (const [name, html] of Object.entries(comps)) writeComp(projDir, name, html);
  const seqPath = path.join(projDir, "cuthol.sequence.json");
  const seq = JSON.parse(fs.readFileSync(seqPath, "utf8")) as CutholSequence;
  assert.equal(seq.stage.width, 1920);
  assert.equal(seq.stage.height, 1080);
  assert.equal(seq.stage.fps, 30);
  const laneCues: LaneCue[] = cues.map((c, i) => ({
    id: c.id,
    kind: "composition",
    anchor: null,
    at_ms: c.atMs,
    duration_ms: 1000,
    z_index: i,
    placement: placement(c.placement),
    composition: {
      composition_dir: `compositions/${c.comp}`,
      entry_html: "index.html",
      props: {},
      transparent: true,
      mode: "overlay_alpha",
    },
    envelopes: [],
  }));
  seq.lanes.push({
    id: "ln_motion",
    kind: "composition",
    z_index: 10,
    muted: false,
    locked: false,
    cues: laneCues,
  });
  fs.writeFileSync(seqPath, JSON.stringify(seq, null, 2), "utf8");
  return projDir;
}

function readDoc(file: string): CoordsDocument {
  return JSON.parse(fs.readFileSync(file, "utf8")) as CoordsDocument;
}

function boxOf(doc: CoordsDocument, key: string, f: number): [number, number, number, number] | null {
  const idx = doc.elements.findIndex((e) => e.key === key);
  if (idx < 0) return null;
  const fr = doc.frames.find((x) => x.f === f);
  if (!fr) return null;
  const it = fr.items.find((x) => x[0] === idx);
  return it ? [it[1], it[2], it[3], it[4]] : null;
}

function opacityOf(doc: CoordsDocument, key: string, f: number): number | null {
  const idx = doc.elements.findIndex((e) => e.key === key);
  if (idx < 0) return null;
  const fr = doc.frames.find((x) => x.f === f);
  const it = fr?.items.find((x) => x[0] === idx);
  return it ? it[5] : null;
}

const MOVE_HTML = compHtml(
  `<div id="box" style="position:absolute;left:0;top:100px;width:100px;height:100px;background:#f00"></div>`,
  `const tl = gsap.timeline({paused:true});
tl.fromTo("#box", {x:0}, {x:1000, duration:1, ease:"none"}, 0);
window.__timelines = window.__timelines || {};
window.__timelines["main"] = tl;`
);

const LATE_HTML = compHtml(
  `<div id="msg" style="position:absolute;left:50px;top:50px;font-size:48px;color:#fff"></div>`,
  `const el = document.getElementById("msg");
const tl = gsap.timeline({paused:true});
tl.call(() => { el.textContent = "hello world"; }, [], 10/30);
tl.set({}, {}, 1);
window.__timelines = window.__timelines || {};
window.__timelines["main"] = tl;`
);

const CSS_HTML = compHtml(
  `<div id="slide" style="position:absolute;left:0;top:200px;width:100px;height:100px;background:#0f0;animation:mv 1s linear forwards"></div>
<div id="spin" style="position:absolute;left:800px;top:400px;width:100px;height:100px;background:#00f;animation:rt 1s linear forwards"></div>`,
  `window.__timelines = window.__timelines || {}; window.__timelines["main"] = gsap.timeline({paused:true});`,
  `@keyframes mv { from { transform: translateX(0); } to { transform: translateX(500px); } }
@keyframes rt { from { transform: rotate(0deg); } to { transform: rotate(180deg); } }`
);

const FADE_HTML = compHtml(
  `<div id="fade" style="position:absolute;left:0;top:300px;width:100px;height:100px;background:#ff0"></div>
<div id="outer" style="position:absolute;left:400px;top:300px;opacity:0.5"><div id="inner" style="width:80px;height:60px;background:#0ff;opacity:0.5"></div></div>
<div id="dia" style="position:absolute;left:700px;top:300px;width:100px;height:100px;background:#f0f;transform:rotate(45deg)"></div>`,
  `const tl = gsap.timeline({paused:true});
tl.fromTo("#fade", {opacity:1}, {opacity:0, duration:0.5, ease:"none"}, 0);
tl.set({}, {}, 1);
window.__timelines = window.__timelines || {};
window.__timelines["main"] = tl;`
);

test("1. known linear motion matches every frame within 0.5px", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "move", atMs: 0 }], { move: MOVE_HTML });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  assert.equal(res.cues.length, 1);
  assert.equal(res.cues_skipped, 0);
  const doc = readDoc(res.cues[0].file);
  assert.equal(doc.schema, "cuthol.coords/2");
  assert.equal(doc.frame_count, 30);
  assert.equal(doc.sequence_start_frame, 0);
  for (let f = 0; f < 30; f++) {
    const b = boxOf(doc, "box", f);
    assert.ok(b, `frame ${f} must list #box`);
    const expected = (f / 30) * 1000;
    assert.ok(Math.abs(b[0] - expected) <= 0.5, `frame ${f}: x=${b[0]} expected=${expected}`);
    assert.ok(Math.abs(b[1] - 100) <= 0.5, `frame ${f}: y=${b[1]}`);
    assert.ok(Math.abs(b[2] - 100) <= 0.5 && Math.abs(b[3] - 100) <= 0.5, `frame ${f}: size`);
  }
});

test("2. late-filled text appears from frame 10 (seek runs tl.call)", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "late", atMs: 0 }], { late: LATE_HTML });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  const doc = readDoc(res.cues[0].file);
  for (let f = 0; f < 10; f++) {
    assert.equal(boxOf(doc, "msg", f), null, `frame ${f} must not list #msg yet`);
  }
  for (let f = 10; f < 30; f++) {
    const b = boxOf(doc, "msg", f);
    assert.ok(b, `frame ${f} must list #msg`);
    assert.ok(b[2] > 10 && b[3] > 10, `frame ${f}: text box size ${b[2]}x${b[3]}`);
  }
  const el = doc.elements.find((e) => e.key === "msg");
  assert.equal(el?.kind, "text");
});

test("3. CSS keyframes motion is pinned to film time", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "css", atMs: 0 }], { css: CSS_HTML });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  const doc = readDoc(res.cues[0].file);
  for (const f of [0, 7, 15, 29]) {
    const b = boxOf(doc, "slide", f);
    assert.ok(b, `frame ${f} must list #slide`);
    const expected = (f / 30) * 500;
    assert.ok(Math.abs(b[0] - expected) <= 1, `frame ${f}: x=${b[0]} expected=${expected}`);
  }
  // 180deg over 30 frames: frame 15 is at 90deg (100x100 again), frame 7-8 near 45deg (~141.4).
  const mid = boxOf(doc, "spin", 15);
  assert.ok(mid);
  assert.ok(Math.abs(mid[2] - 100) <= 1.5, `frame 15 width=${mid[2]}`);
  const diag = boxOf(doc, "spin", 8);
  assert.ok(diag);
  const angle = (8 / 30) * Math.PI;
  const expectedW = 100 * Math.abs(Math.cos(angle)) + 100 * Math.abs(Math.sin(angle));
  assert.ok(Math.abs(diag[2] - expectedW) <= 1.5, `frame 8 width=${diag[2]} expected=${expectedW}`);
});

test("4. opacity chains and rotated box axis alignment", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "fade", atMs: 0 }], { fade: FADE_HTML });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  const doc = readDoc(res.cues[0].file);
  // Fading element: mid opacity ~0.53 at frame 7, gone once it reaches 0.
  const midOp = opacityOf(doc, "fade", 7);
  assert.ok(midOp !== null && Math.abs(midOp - 0.533) <= 0.05, `frame 7 opacity=${midOp}`);
  assert.equal(boxOf(doc, "fade", 20), null, "opacity 0 element must be dropped");
  // Parent opacity multiplies: 0.5 * 0.5 = 0.25.
  const innerOp = opacityOf(doc, "inner", 0);
  assert.ok(innerOp !== null && Math.abs(innerOp - 0.25) <= 0.01, `inner opacity=${innerOp}`);
  // Static 45deg rotation: 100x100 -> ~141.4 AABB.
  const d = boxOf(doc, "dia", 0);
  assert.ok(d);
  assert.ok(Math.abs(d[2] - 141.4) <= 0.6, `dia width=${d[2]}`);
  assert.ok(Math.abs(d[3] - 141.4) <= 0.6, `dia height=${d[3]}`);
});

test("5. nonzero cue start and placed mapping to stage pixels", async () => {
  const proj = makeProject(
    [
      {
        id: "cue_01",
        comp: "move",
        atMs: 2000,
        placement: { scale_x: 0.5, scale_y: 0.5, x_pct: 10, y_pct: -5 },
      },
    ],
    { move: MOVE_HTML }
  );
  const res = await measureCompositionCues({
    workspaceDir: proj,
    cueIds: ["cue_01"],
    querySequenceFrames: [60, 89],
  });
  assert.equal(res.cues.length, 1);
  const cue = res.cues[0];
  const doc = readDoc(cue.file);
  assert.equal(doc.sequence_start_frame, 60);
  // Compiler formula: target 960x540, base (480,270), offset +(192,-54) -> (672,216).
  const q = cue.queried_frames ?? [];
  assert.equal(q.length, 2);
  assert.equal(q[0].sequence_frame, 60);
  assert.equal(q[0].local_frame, 0);
  const b0 = q[0].boxes.find((b) => b.key === "box");
  assert.ok(b0);
  assert.deepEqual(b0.box, [672, 266, 50, 50]);
  const b1 = q[1].boxes.find((b) => b.key === "box");
  assert.ok(b1);
  const expectedX = 672 + ((29 / 30) * 1000 * 960) / 1920;
  assert.ok(Math.abs(b1.box[0] - expectedX) <= 0.6, `x=${b1.box[0]} expected=${expectedX}`);
  assert.deepEqual([b1.box[1], b1.box[2], b1.box[3]], [266, 50, 50]);
  // Summary rows carry sequence frames and stage-pixel union boxes.
  const row = cue.items.find((i) => i.key === "box");
  assert.ok(row);
  assert.deepEqual(row.frames, [60, 89]);
  assert.ok(Math.abs(row.box[0] - 672) <= 0.1, `union x=${row.box[0]}`);
  assert.ok(Math.abs(row.box[1] - 266) <= 0.1, `union y=${row.box[1]}`);
  assert.ok(Math.abs(row.box[2] - 533.4) <= 0.4, `union w=${row.box[2]}`);
  assert.equal(row.box[3], 50);
});

test("6. cache: hit reuses without a browser, file change re-measures, placement-only change reuses", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "move", atMs: 0 }], { move: MOVE_HTML });
  resetCoordsBrowserLaunchCount();
  const first = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  assert.equal(first.cues[0].cached, false);
  assert.equal(getCoordsBrowserLaunchCount(), 1);
  const second = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  assert.equal(second.cues[0].cached, true);
  assert.equal(getCoordsBrowserLaunchCount(), 1);
  assert.equal(second.cues[0].file, first.cues[0].file);

  // Composition file change -> re-measure.
  const htmlPath = path.join(proj, "compositions", "move", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  fs.writeFileSync(htmlPath, html.replace("background:#f00", "background:#f01"), "utf8");
  const third = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  assert.equal(third.cues[0].cached, false);
  assert.equal(getCoordsBrowserLaunchCount(), 2);
  assert.notEqual(third.cues[0].file, first.cues[0].file);
  fs.writeFileSync(htmlPath, html, "utf8");

  // Placement-only change -> cache hit, but stage boxes move.
  const seqPath = path.join(proj, "cuthol.sequence.json");
  const seq = JSON.parse(fs.readFileSync(seqPath, "utf8")) as CutholSequence;
  const cue = seq.lanes.flatMap((l) => l.cues).find((c) => c.id === "cue_01")!;
  cue.placement = placement({ scale_x: 0.5, scale_y: 0.5 });
  fs.writeFileSync(seqPath, JSON.stringify(seq), "utf8");
  const fourth = await measureCompositionCues({
    workspaceDir: proj,
    cueIds: ["cue_01"],
    querySequenceFrames: [0],
  });
  assert.equal(fourth.cues[0].cached, true);
  assert.equal(getCoordsBrowserLaunchCount(), 2);
  assert.equal(fourth.cues[0].file, first.cues[0].file);
  const qb = fourth.cues[0].queried_frames?.[0]?.boxes.find((b) => b.key === "box");
  assert.ok(qb);
  assert.deepEqual(qb.box, [480, 320, 50, 50]);
});

test("7. two measurements produce identical JSON", async () => {
  const proj = makeProject(
    [
      { id: "cue_01", comp: "move", atMs: 0 },
      { id: "cue_02", comp: "late", atMs: 1000 },
    ],
    { move: MOVE_HTML, late: LATE_HTML }
  );
  const a = await measureCompositionCues({ workspaceDir: proj, all: true, refresh: true });
  assert.equal(a.cues.length, 2);
  const bytesA = a.cues.map((c) => fs.readFileSync(c.file, "utf8"));
  const b = await measureCompositionCues({ workspaceDir: proj, all: true, refresh: true });
  const bytesB = b.cues.map((c) => fs.readFileSync(c.file, "utf8"));
  assert.deepEqual(bytesB, bytesA);
});

test("9. missing composition entry skips the cue with G417 (no browser)", async () => {
  const projDir = fs.mkdtempSync(path.join(TEST_ROOT, "proj-"));
  initWorkspace({ dir: projDir, title: "coords", aspect: "16:9", fps: 30 });
  const seqPath = path.join(projDir, "cuthol.sequence.json");
  const seq = JSON.parse(fs.readFileSync(seqPath, "utf8")) as CutholSequence;
  seq.lanes.push({
    id: "ln_motion",
    kind: "composition",
    z_index: 10,
    muted: false,
    locked: false,
    cues: [
      {
        id: "cue_01",
        kind: "composition",
        anchor: null,
        at_ms: 0,
        duration_ms: 1000,
        z_index: 0,
        placement: placement(),
        composition: {
          composition_dir: "compositions/ghost",
          entry_html: "index.html",
          props: {},
          transparent: true,
          mode: "overlay_alpha",
        },
        envelopes: [],
      },
    ],
  });
  fs.writeFileSync(seqPath, JSON.stringify(seq), "utf8");
  resetCoordsBrowserLaunchCount();
  const res = await measureCompositionCues({ workspaceDir: projDir, cueIds: ["cue_01"] });
  assert.equal(res.cues.length, 0);
  assert.equal(res.cues_skipped, 1);
  assert.equal(res.skipped_cues[0].cue, "cue_01");
  assert.ok(res.warnings.some((w) => w.code === "CUTHOL-G417" && w.severity === "WARN"));
  assert.equal(getCoordsBrowserLaunchCount(), 0);
});

test("8. font bundler resolves on the installed renderer version", async () => {
  const dir = path.join(TEST_ROOT, "bundler-comp");
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), MOVE_HTML, "utf8");
  const bundler = await resolveCoordsFontBundler();
  assert.equal(typeof bundler, "function");
  const out = await bundler(dir);
  assert.ok(out.length > 100, "bundled html must be substantial");
  assert.ok(out.includes("data-composition-id"), "bundled html keeps the composition root");
});
