// Ink boxes under nested 2D transform chains: rotated card > translated/scaled row >
// text keeps glyph ink; a band in the line gap separates in ink while line boxes touch;
// three nested levels match twin-mapped geometry; legacy paths stay byte-identical.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findBundledGsapMinJs } from "../compositor/bridge_hash.js";
import {
  CoordsDocument,
  measureCompositionCues,
} from "../compositor/coords_extract.js";
import { CutholSequence, LaneCue, SpatialPlacement } from "../core/schema.js";
import { PngCanvas } from "../core/png_canvas.js";
import { initWorkspace } from "../core/workspace.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-coords-ink-tf-"));

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

function compHtml(bodyInner: string, script: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}#root{position:relative;overflow:hidden}</style></head>
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

const STILL = `window.__timelines = window.__timelines || {}; window.__timelines["main"] = gsap.timeline({paused:true});`;

function writeComp(
  projDir: string,
  name: string,
  html: string,
  assets: Record<string, Buffer> = {}
): void {
  const dir = path.join(projDir, "compositions", name);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
  fs.copyFileSync(GSAP as string, path.join(dir, "assets", "gsap.min.js"));
  for (const [file, bytes] of Object.entries(assets)) {
    fs.writeFileSync(path.join(dir, "assets", file), bytes);
  }
}

function makeProject(
  cues: string[],
  comps: Record<string, { html: string; assets?: Record<string, Buffer> }>
): string {
  const projDir = fs.mkdtempSync(path.join(TEST_ROOT, "proj-"));
  initWorkspace({ dir: projDir, title: "coords-ink-tf", aspect: "16:9", fps: 30 });
  for (const [name, comp] of Object.entries(comps)) {
    writeComp(projDir, name, comp.html, comp.assets ?? {});
  }
  const seqPath = path.join(projDir, "cuthol.sequence.json");
  const seq = JSON.parse(fs.readFileSync(seqPath, "utf8")) as CutholSequence;
  const laneCues: LaneCue[] = cues.map((comp, i) => ({
    id: `cue_${String(i + 1).padStart(2, "0")}`,
    kind: "composition",
    anchor: null,
    at_ms: i * 1000,
    duration_ms: 1000,
    z_index: i,
    placement: placement(),
    composition: {
      composition_dir: `compositions/${comp}`,
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

type Box = [number, number, number, number];

function boxOf(doc: CoordsDocument, key: string, f: number): Box | null {
  const idx = doc.elements.findIndex((e) => e.key === key);
  if (idx < 0) return null;
  const fr = doc.frames.find((x) => x.f === f);
  if (!fr) return null;
  const it = fr.items.find((x) => x[0] === idx);
  return it ? [it[1], it[2], it[3], it[4]] : null;
}

function inkOf(doc: CoordsDocument, key: string, f: number): Box | null {
  const idx = doc.elements.findIndex((e) => e.key === key);
  if (idx < 0) return null;
  const fr = doc.frames.find((x) => x.f === f);
  if (!fr || !fr.ink) return null;
  const row = fr.ink.find((x) => x[0] === idx);
  return row ? [row[1], row[2], row[3], row[4]] : null;
}

function interArea(a: Box, b: Box): number {
  return (
    Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]))
  );
}

function assertContained(ink: Box, item: Box, tol: number): void {
  assert.ok(ink[0] >= item[0] - tol, `ink x ${ink[0]} inside ${item[0]} (tol ${tol})`);
  assert.ok(ink[1] >= item[1] - tol, `ink y ${ink[1]} inside ${item[1]} (tol ${tol})`);
  assert.ok(ink[0] + ink[2] <= item[0] + item[2] + tol);
  assert.ok(ink[1] + ink[3] <= item[1] + item[3] + tol);
}

// Independent 2x2 affine math (CSS `transform: f g` composes M = F x G).
type M2 = [[number, number], [number, number]];
const mmult = (a: M2, b: M2): M2 => [
  [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1]],
  [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1]],
];
const rot = (deg: number): M2 => {
  const a = (deg * Math.PI) / 180;
  return [
    [Math.cos(a), -Math.sin(a)],
    [Math.sin(a), Math.cos(a)],
  ];
};
const scl = (x: number, y = x): M2 => [
  [x, 0],
  [0, y],
];
const skewX = (deg: number): M2 => [
  [1, Math.tan((deg * Math.PI) / 180)],
  [0, 1],
];
const aabbSize = (L: M2, w: number, h: number): [number, number] => [
  Math.abs(L[0][0]) * w + Math.abs(L[0][1]) * h,
  Math.abs(L[1][0]) * w + Math.abs(L[1][1]) * h,
];

/** 100x100 PNG: transparent, opaque red square (20,30)-(80,70). */
function marginPng(): Buffer {
  const canvas = new PngCanvas(100, 100, [0, 0, 0, 0]);
  canvas.fillRect(20, 30, 60, 40, [255, 0, 0, 255]);
  return canvas.toPngBuffer();
}

const TXT48 = `font-family:Arial,sans-serif;font-size:48px;line-height:56px;color:#111`;

const NEST_HTML = compHtml(
  `<div id="card" style="position:absolute;left:300px;top:200px;width:700px;height:400px;background:#eee;transform:rotate(-3deg)">` +
    `<div id="row" style="transform:translateY(20px) scale(1.1);transform-origin:0 0">` +
    `<div id="txt" style="position:absolute;left:60px;top:40px;width:560px;${TXT48}">HELLO WORLD</div>` +
    `</div></div>`,
  STILL
);
const TWIN_HTML = compHtml(
  `<div id="txt" style="position:absolute;left:60px;top:40px;width:560px;${TXT48}">HELLO WORLD</div>`,
  STILL
);
const BAND_HTML = compHtml(
  `<div id="card" style="position:absolute;left:300px;top:200px;width:700px;height:400px;background:#eee;transform:rotate(-3deg)">` +
    `<div id="row" style="transform:translateY(20px) scale(1.1);transform-origin:0 0">` +
    `<div id="txt" style="position:absolute;left:60px;top:40px;width:560px;${TXT48}">Hi</div>` +
    `<div id="band1" style="position:absolute;left:62px;top:39px;width:42px;height:4px;background:#f00"></div>` +
    `<div id="band2" style="position:absolute;left:62px;top:60px;width:42px;height:6px;background:#00f"></div>` +
    `</div></div>`,
  STILL
);
const DEEP3_HTML = compHtml(
  `<div id="outer" style="position:absolute;left:400px;top:200px;width:600px;height:300px;transform:rotate(2deg);transform-origin:0 0">` +
    `<div id="mid" style="transform:scale(1.15) skewX(3deg);transform-origin:0 0">` +
    `<div id="inner" style="transform:translate(30px,10px) rotate(-4deg);transform-origin:0 0">` +
    `<div id="txt" style="position:absolute;left:50px;top:30px;width:400px;${TXT48}">AgjY</div>` +
    `</div></div></div>`,
  STILL
);
const TWIN3_HTML = compHtml(
  `<div id="txt" style="position:absolute;left:50px;top:30px;width:400px;${TXT48}">AgjY</div>`,
  STILL
);
const DUN_HTML = compHtml(
  `<div id="txt" style="position:absolute;left:100px;top:100px;${TXT48}">AgjY</div>`,
  STILL
);
const ROTIMG_HTML = compHtml(
  `<img id="spin" src="assets/logo.png" style="position:absolute;left:400px;top:300px;width:100px;height:100px;transform:rotate(30deg)">`,
  STILL
);
const ANCIMG_HTML = compHtml(
  `<div id="wrap" style="position:absolute;left:300px;top:200px;width:200px;height:200px;transform:rotate(10deg)"><img id="pic" src="assets/logo.png" style="position:absolute;left:50px;top:60px;width:100px;height:100px"></div>`,
  STILL
);
const SGTXT_HTML = compHtml(
  `<div id="txt" style="position:absolute;left:100px;top:100px;${TXT48};transform:rotate(-5deg)">Hello</div>`,
  STILL
);
const SGTWIN_HTML = compHtml(
  `<div id="txt" style="position:absolute;left:100px;top:100px;${TXT48}">Hello</div>`,
  STILL
);
const ANCTXT_HTML = compHtml(
  `<div id="card" style="position:absolute;left:300px;top:200px;width:700px;height:400px;transform:rotate(-2deg)">` +
    `<div id="txt" style="position:absolute;left:60px;top:40px;width:560px;${TXT48}">Sample Text</div>` +
    `</div>`,
  STILL
);
const ANCTWIN_HTML = compHtml(
  `<div id="txt" style="position:absolute;left:60px;top:40px;width:560px;${TXT48}">Sample Text</div>`,
  STILL
);
const TRTXT_HTML = compHtml(
  `<div id="txt" style="position:absolute;left:100px;top:100px;${TXT48};transform:translateX(100px)">Moving</div>`,
  STILL
);
const NESTIMG_HTML = compHtml(
  `<div id="card" style="position:absolute;left:300px;top:200px;width:700px;height:400px;background:#eee;transform:rotate(-3deg)">` +
    `<div id="row" style="transform:translateY(20px) scale(1.1);transform-origin:0 0">` +
    `<img id="pic" src="assets/logo.png" style="position:absolute;left:60px;top:40px;width:200px;height:100px">` +
    `</div></div>`,
  STILL
);
const NESTIMGTWIN_HTML = compHtml(
  `<img id="pic" src="assets/logo.png" style="position:absolute;left:60px;top:40px;width:200px;height:100px">`,
  STILL
);

/** Composite linear of the card/row nest: rotate(-3deg) outside, scale(1.1) inside. */
const NEST_L = mmult(rot(-3), scl(1.1));
/** Composite linear of the three-level nest. */
const DEEP3_L = mmult(rot(2), mmult(mmult(scl(1.15), skewX(3)), rot(-4)));
/** Single-level linears: self-rotated text and text under a rotated card. */
const SG_L = rot(-5);
const ANC_L = rot(-2);

test("1. nested text ink is smaller than the line box and matches the mapped twin", async () => {
  const proj = makeProject(["nest", "twin"], {
    nest: { html: NEST_HTML },
    twin: { html: TWIN_HTML },
  });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01", "cue_02"] });
  assert.equal(res.cues_skipped, 0);
  const doc = readDoc(res.cues[0].file);
  const twin = readDoc(res.cues[1].file);
  const item = boxOf(doc, "txt", 0);
  assert.ok(item, "nested text must be listed");
  assert.deepEqual(item, [359.2, 257, 381.6, 84.6]);
  const ink = inkOf(doc, "txt", 0);
  assert.ok(ink, "nested text must carry an ink row");
  assert.ok(ink[2] < item[2] - 1, `ink w=${ink[2]} item w=${item[2]}`);
  assert.ok(ink[3] < item[3] - 1, `ink h=${ink[3]} item h=${item[3]}`);
  assertContained(ink, item, 0.5);
  // Independent check: map the untransformed twin ink through the known composite.
  const tLine = boxOf(twin, "txt", 0);
  const tInk = inkOf(twin, "txt", 0);
  assert.ok(tLine && tInk, "twin must carry item + ink");
  const [ew, eh] = aabbSize(NEST_L, tInk[2], tInk[3]);
  assert.ok(Math.abs(ink[2] - ew) <= 1, `ink w=${ink[2]} expected=${ew}`);
  assert.ok(Math.abs(ink[3] - eh) <= 1, `ink h=${ink[3]} expected=${eh}`);
  const dx = tInk[0] + tInk[2] / 2 - (tLine[0] + tLine[2] / 2);
  const dy = tInk[1] + tInk[3] / 2 - (tLine[1] + tLine[3] / 2);
  const ecx = item[0] + item[2] / 2 + NEST_L[0][0] * dx + NEST_L[0][1] * dy;
  const ecy = item[1] + item[3] / 2 + NEST_L[1][0] * dx + NEST_L[1][1] * dy;
  assert.ok(Math.abs(ink[0] + ink[2] / 2 - ecx) <= 1, "ink center x");
  assert.ok(Math.abs(ink[1] + ink[3] / 2 - ecy) <= 1, "ink center y");
  const f0 = JSON.stringify([doc.frames[0].items, doc.frames[0].ink]);
  for (const fr of doc.frames) {
    assert.equal(JSON.stringify([fr.items, fr.ink]), f0, `frame ${fr.f} identical`);
  }
});

test("2. a band in the line gap separates in ink; a pressing band intersects", async () => {
  const proj = makeProject(["band"], { band: { html: BAND_HTML } });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  const doc = readDoc(res.cues[0].file);
  const txt = boxOf(doc, "txt", 0);
  const b1 = boxOf(doc, "band1", 0);
  const b2 = boxOf(doc, "band2", 0);
  assert.deepEqual(txt, [359.2, 274.1, 55.4, 67.5]);
  assert.deepEqual(b1, [361.4, 275.4, 46.4, 6.8]);
  assert.deepEqual(b2, [362.6, 298.5, 46.5, 9]);
  assert.ok(txt && b1 && b2);
  assert.ok(interArea(txt, b1) > 0, "line box must touch the gap band");
  assert.ok(interArea(txt, b2) > 0, "line box must touch the pressing band");
  const ink = inkOf(doc, "txt", 0);
  assert.ok(ink, "nested text must carry an ink row");
  assertContained(ink, txt, 0.5);
  assert.equal(interArea(ink, b1), 0, "gap band must not touch glyph ink");
  assert.ok(interArea(ink, b2) > 0, "pressing band must touch glyph ink");
  assert.equal(inkOf(doc, "band1", 0), null, "painted boxes keep the item box");
});

test("3. three nested levels with origin 0 0 match the mapped twin within 1px", async () => {
  const proj = makeProject(["deep3", "twin3"], {
    deep3: { html: DEEP3_HTML },
    twin3: { html: TWIN3_HTML },
  });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01", "cue_02"] });
  const doc = readDoc(res.cues[0].file);
  const twin = readDoc(res.cues[1].file);
  const item = boxOf(doc, "txt", 0);
  assert.deepEqual(item, [494.7, 238.6, 128.2, 72.2]);
  assert.ok(item);
  const ink = inkOf(doc, "txt", 0);
  assert.ok(ink, "three-level text must carry an ink row");
  assertContained(ink, item, 0.5);
  const tLine = boxOf(twin, "txt", 0);
  const tInk = inkOf(twin, "txt", 0);
  assert.ok(tLine && tInk);
  const [ew, eh] = aabbSize(DEEP3_L, tInk[2], tInk[3]);
  assert.ok(Math.abs(ink[2] - ew) <= 1, `ink w=${ink[2]} expected=${ew}`);
  assert.ok(Math.abs(ink[3] - eh) <= 1, `ink h=${ink[3]} expected=${eh}`);
  const dx = tInk[0] + tInk[2] / 2 - (tLine[0] + tLine[2] / 2);
  const dy = tInk[1] + tInk[3] / 2 - (tLine[1] + tLine[3] / 2);
  const ecx = item[0] + item[2] / 2 + DEEP3_L[0][0] * dx + DEEP3_L[0][1] * dy;
  const ecy = item[1] + item[3] / 2 + DEEP3_L[1][0] * dx + DEEP3_L[1][1] * dy;
  assert.ok(Math.abs(ink[0] + ink[2] / 2 - ecx) <= 1, "ink center x");
  assert.ok(Math.abs(ink[1] + ink[3] / 2 - ecy) <= 1, "ink center y");
});

test("4. legacy-computed elements stay byte-identical", async () => {
  const proj = makeProject(["dun", "rotimg", "ancimg", "trtxt"], {
    dun: { html: DUN_HTML },
    rotimg: { html: ROTIMG_HTML, assets: { "logo.png": marginPng() } },
    ancimg: { html: ANCIMG_HTML, assets: { "logo.png": marginPng() } },
    trtxt: { html: TRTXT_HTML },
  });
  const res = await measureCompositionCues({
    workspaceDir: proj,
    cueIds: ["cue_01", "cue_02", "cue_03", "cue_04"],
  });
  const docs = res.cues.map((c) => readDoc(c.file));
  const cases: Array<{
    doc: CoordsDocument;
    key: string;
    item: Box;
    ink: Box | null;
  }> = [
    { doc: docs[0], key: "txt", item: [100, 98, 106.8, 59], ink: [100, 109, 106.2, 47] },
    { doc: docs[1], key: "spin", item: [381.7, 281.7, 136.6, 136.6], ink: [414, 317.7, 72, 64.6] },
    { doc: docs[2], key: "pic", item: [340.3, 251.9, 115.8, 115.8], ink: [365.2, 284.9, 66, 49.8] },
    { doc: docs[3], key: "txt", item: [200, 98, 167.6, 59], ink: [203, 109, 161.2, 47] },
  ];
  for (const c of cases) {
    assert.equal(c.doc.frames.length, 30);
    for (const fr of c.doc.frames) {
      assert.deepEqual(boxOf(c.doc, c.key, fr.f), c.item, `${c.key} f${fr.f} item`);
      assert.deepEqual(inkOf(c.doc, c.key, fr.f), c.ink, `${c.key} f${fr.f} ink`);
    }
  }
});

test("6. single-transform text matches the mapped twin", async () => {
  const proj = makeProject(["sgtxt", "sgtwin", "anctxt", "anctwin"], {
    sgtxt: { html: SGTXT_HTML },
    sgtwin: { html: SGTWIN_HTML },
    anctxt: { html: ANCTXT_HTML },
    anctwin: { html: ANCTWIN_HTML },
  });
  const res = await measureCompositionCues({
    workspaceDir: proj,
    cueIds: ["cue_01", "cue_02", "cue_03", "cue_04"],
  });
  const docs = res.cues.map((c) => readDoc(c.file));
  const cases: Array<{ doc: CoordsDocument; twin: CoordsDocument; item: Box; L: M2 }> = [
    { doc: docs[0], twin: docs[1], item: [97.6, 93.1, 120.4, 68.9], L: SG_L },
    { doc: docs[2], twin: docs[3], item: [354.5, 238.5, 281.2, 68.7], L: ANC_L },
  ];
  for (const c of cases) {
    const item = boxOf(c.doc, "txt", 0);
    assert.deepEqual(item, c.item);
    assert.ok(item);
    const ink = inkOf(c.doc, "txt", 0);
    assert.ok(ink, "single-transform text must carry an ink row");
    assertContained(ink, item, 0.5);
    const tLine = boxOf(c.twin, "txt", 0);
    const tInk = inkOf(c.twin, "txt", 0);
    assert.ok(tLine && tInk);
    const [ew, eh] = aabbSize(c.L, tInk[2], tInk[3]);
    assert.ok(Math.abs(ink[2] - ew) <= 1, `ink w=${ink[2]} expected=${ew}`);
    assert.ok(Math.abs(ink[3] - eh) <= 1, `ink h=${ink[3]} expected=${eh}`);
    const dx = tInk[0] + tInk[2] / 2 - (tLine[0] + tLine[2] / 2);
    const dy = tInk[1] + tInk[3] / 2 - (tLine[1] + tLine[3] / 2);
    const ecx = item[0] + item[2] / 2 + c.L[0][0] * dx + c.L[0][1] * dy;
    const ecy = item[1] + item[3] / 2 + c.L[1][0] * dx + c.L[1][1] * dy;
    assert.ok(Math.abs(ink[0] + ink[2] / 2 - ecx) <= 1, "ink center x");
    assert.ok(Math.abs(ink[1] + ink[3] / 2 - ecy) <= 1, "ink center y");
  }
});

test("5. nested image ink trims margins through the whole chain", async () => {
  const proj = makeProject(["nestimg", "nestimgtwin"], {
    nestimg: { html: NESTIMG_HTML, assets: { "logo.png": marginPng() } },
    nestimgtwin: { html: NESTIMGTWIN_HTML, assets: { "logo.png": marginPng() } },
  });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01", "cue_02"] });
  const doc = readDoc(res.cues[0].file);
  const twin = readDoc(res.cues[1].file);
  const item = boxOf(doc, "pic", 0);
  assert.deepEqual(item, [359.3, 267.5, 225.5, 121.4]);
  assert.ok(item);
  const ink = inkOf(doc, "pic", 0);
  assert.ok(ink, "nested image must carry an ink row");
  assertContained(ink, item, 0.5);
  assert.ok(
    ink[2] * ink[3] < item[2] * item[3] * 0.6,
    `ink area ${ink[2] * ink[3]} item area ${item[2] * item[3]}`
  );
  const tInk = inkOf(twin, "pic", 0);
  assert.ok(tInk);
  const [ew, eh] = aabbSize(NEST_L, tInk[2], tInk[3]);
  assert.ok(Math.abs(ink[2] - ew) <= 1, `ink w=${ink[2]} expected=${ew}`);
  assert.ok(Math.abs(ink[3] - eh) <= 1, `ink h=${ink[3]} expected=${eh}`);
  // Symmetric margins: ink shares the item center.
  assert.ok(Math.abs(ink[0] + ink[2] / 2 - (item[0] + item[2] / 2)) <= 0.5, "center x");
  assert.ok(Math.abs(ink[1] + ink[3] / 2 - (item[1] + item[3] / 2)) <= 0.5, "center y");
});
