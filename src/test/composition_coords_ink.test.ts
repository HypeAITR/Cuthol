// Composition coordinate ink boxes and design groups: text glyph boxes, image
// transparent margins, object-fit mapping, rotated images, parent/group links.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findBundledGsapMinJs } from "../compositor/bridge_hash.js";
import { resolveImageFileInkMargins } from "../compositor/coords_ink.js";
import {
  CoordsDocument,
  getCoordsBrowserLaunchCount,
  measureCompositionCues,
  pruneCoordsElements,
  resetCoordsBrowserLaunchCount,
} from "../compositor/coords_extract.js";
import { CutholSequence, LaneCue, SpatialPlacement } from "../core/schema.js";
import { PngCanvas } from "../core/png_canvas.js";
import { initWorkspace } from "../core/workspace.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-coords-ink-"));

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

const STILL = `window.__timelines = window.__timelines || {}; window.__timelines["main"] = gsap.timeline({paused:true});`;

function writeComp(
  projDir: string,
  name: string,
  html: string,
  assets: Record<string, Buffer> = {}
): string {
  const dir = path.join(projDir, "compositions", name);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
  fs.copyFileSync(GSAP as string, path.join(dir, "assets", "gsap.min.js"));
  for (const [file, bytes] of Object.entries(assets)) {
    const target = path.join(dir, "assets", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  return dir;
}

interface FixtureCue {
  id: string;
  comp: string;
  atMs: number;
}

function makeProject(
  cues: FixtureCue[],
  comps: Record<string, { html: string; assets?: Record<string, Buffer> }>
): string {
  const projDir = fs.mkdtempSync(path.join(TEST_ROOT, "proj-"));
  initWorkspace({ dir: projDir, title: "coords-ink", aspect: "16:9", fps: 30 });
  for (const [name, comp] of Object.entries(comps)) {
    writeComp(projDir, name, comp.html, comp.assets ?? {});
  }
  const seqPath = path.join(projDir, "cuthol.sequence.json");
  const seq = JSON.parse(fs.readFileSync(seqPath, "utf8")) as CutholSequence;
  const laneCues: LaneCue[] = cues.map((c, i) => ({
    id: c.id,
    kind: "composition",
    anchor: null,
    at_ms: c.atMs,
    duration_ms: 1000,
    z_index: i,
    placement: placement(),
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

function boxOf(
  doc: CoordsDocument,
  key: string,
  f: number
): [number, number, number, number] | null {
  const idx = doc.elements.findIndex((e) => e.key === key);
  if (idx < 0) return null;
  const fr = doc.frames.find((x) => x.f === f);
  if (!fr) return null;
  const it = fr.items.find((x) => x[0] === idx);
  return it ? [it[1], it[2], it[3], it[4]] : null;
}

function inkOf(
  doc: CoordsDocument,
  key: string,
  f: number
): [number, number, number, number] | null {
  const idx = doc.elements.findIndex((e) => e.key === key);
  if (idx < 0) return null;
  const fr = doc.frames.find((x) => x.f === f);
  if (!fr || !fr.ink) return null;
  const row = fr.ink.find((x) => x[0] === idx);
  return row ? [row[1], row[2], row[3], row[4]] : null;
}

/** 100x100 PNG: transparent, opaque red square (20,30)-(80,70). */
function marginPng(): Buffer {
  const canvas = new PngCanvas(100, 100, [0, 0, 0, 0]);
  canvas.fillRect(20, 30, 60, 40, [255, 0, 0, 255]);
  return canvas.toPngBuffer();
}

/** Same square plus lone dust pixels that must not own the margins. */
function speckPng(): Buffer {
  const canvas = new PngCanvas(100, 100, [0, 0, 0, 0]);
  canvas.fillRect(20, 30, 60, 40, [255, 0, 0, 255]);
  canvas.setPixel(2, 2, [255, 0, 0, 255]);
  canvas.setPixel(97, 90, [255, 0, 0, 255]);
  return canvas.toPngBuffer();
}

/** 100x100 fully opaque PNG. */
function solidPng(): Buffer {
  const canvas = new PngCanvas(100, 100, [0, 128, 255, 255]);
  return canvas.toPngBuffer();
}

const TEXT_HTML = compHtml(
  `<div id="headline" style="position:absolute;left:100px;top:100px;font-family:Arial,sans-serif;font-size:48px;line-height:72px;color:#fff">AgjY</div>`,
  STILL
);

const IMAGE_HTML = compHtml(
  `<img id="logo" src="assets/logo.png" style="position:absolute;left:50px;top:60px;width:100px;height:100px">`,
  STILL
);

const CONTAIN_HTML = compHtml(
  `<img id="fit" src="assets/logo.png" style="position:absolute;left:200px;top:100px;width:200px;height:100px;object-fit:contain;object-position:center">`,
  STILL
);

const ROTATED_HTML = compHtml(
  `<img id="spin" src="assets/logo.png" style="position:absolute;left:400px;top:300px;width:100px;height:100px;transform:rotate(30deg)">`,
  STILL
);

const OPAQUE_HTML = compHtml(
  `<img id="flat" src="assets/solid.png" style="position:absolute;left:50px;top:60px;width:100px;height:100px">`,
  STILL
);

const GROUP_HTML = compHtml(
  `<div id="bg" style="position:absolute;left:0;top:0;width:1920px;height:1080px;background:#112233">
<div id="card" style="position:absolute;left:100px;top:100px;width:400px;height:200px;background:#ffffff;border-radius:8px">
<div id="title" style="font-family:Arial,sans-serif;font-size:48px;line-height:56px;color:#000">Hello</div>
</div>
</div>`,
  STILL
);

const SLIDE_HTML = compHtml(
  `<div id="slide" style="position:absolute;left:100px;top:100px;font-family:Arial,sans-serif;font-size:48px;line-height:56px;color:#fff">Moving</div>`,
  `const tl = gsap.timeline({paused:true});
tl.fromTo("#slide", {x:0}, {x:500, duration:1, ease:"none"}, 0);
window.__timelines = window.__timelines || {};
window.__timelines["main"] = tl;`
);

const STROKE_HTML = compHtml(
  `<div id="plain" style="position:absolute;left:100px;top:100px;font-family:Arial,sans-serif;font-size:48px;line-height:56px;color:#fff">Stroke</div>
<div id="lined" style="position:absolute;left:100px;top:200px;font-family:Arial,sans-serif;font-size:48px;line-height:56px;color:#fff;-webkit-text-stroke:4px #f00">Stroke</div>`,
  STILL
);

const ROWS_HTML = compHtml(
  `<div id="row1" style="position:absolute;left:100px;top:100px;font-family:Arial,sans-serif;font-size:48px;line-height:56px;color:#fff">FIRST</div>
<div id="row2" style="position:absolute;left:100px;top:156px;font-family:Arial,sans-serif;font-size:48px;line-height:56px;color:#fff">SECOND</div>`,
  STILL
);

test("1. text ink is the glyph box, smaller than the line box", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "text", atMs: 0 }], {
    text: { html: TEXT_HTML },
  });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  assert.equal(res.cues_skipped, 0);
  const doc = readDoc(res.cues[0].file);
  assert.equal(doc.schema, "cuthol.coords/2");
  assert.equal(doc.engine_version, "4");
  const item = boxOf(doc, "headline", 0);
  assert.ok(item, "frame 0 must list #headline");
  // Range line boxes hug the font content height, not the 72px line-height.
  assert.ok(item[3] > 50 && item[3] < 65, `line box height=${item[3]}`);
  const ink = inkOf(doc, "headline", 0);
  assert.ok(ink, "frame 0 must carry an ink row for #headline");
  assert.ok(ink[3] < item[3] - 5, `ink height=${ink[3]} must trim the 72px line box`);
  assert.ok(ink[2] <= item[2] + 0.1, `ink width=${ink[2]} item width=${item[2]}`);
  assert.ok(ink[0] >= item[0] - 0.1 && ink[0] + ink[2] <= item[0] + item[2] + 0.1);
  assert.ok(ink[1] >= item[1] - 0.1 && ink[1] + ink[3] <= item[1] + item[3] + 0.1);
});

test("2. image ink trims the asset transparent margins", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "img", atMs: 0 }], {
    img: { html: IMAGE_HTML, assets: { "logo.png": marginPng() } },
  });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  const doc = readDoc(res.cues[0].file);
  const item = boxOf(doc, "logo", 0);
  assert.ok(item);
  assert.deepEqual(item.map(Math.round), [50, 60, 100, 100]);
  const ink = inkOf(doc, "logo", 0);
  assert.ok(ink, "opaque-centered PNG must produce an ink row");
  assert.ok(Math.abs(ink[0] - 70) <= 0.5, `ink x=${ink[0]}`);
  assert.ok(Math.abs(ink[1] - 90) <= 0.5, `ink y=${ink[1]}`);
  assert.ok(Math.abs(ink[2] - 60) <= 0.5, `ink w=${ink[2]}`);
  assert.ok(Math.abs(ink[3] - 40) <= 0.5, `ink h=${ink[3]}`);
});

test("3. image ink follows object-fit contain", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "fit", atMs: 0 }], {
    fit: { html: CONTAIN_HTML, assets: { "logo.png": marginPng() } },
  });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  const doc = readDoc(res.cues[0].file);
  const item = boxOf(doc, "fit", 0);
  assert.ok(item);
  assert.deepEqual(item.map(Math.round), [200, 100, 200, 100]);
  // Contained 100x100 drawing centers at x +50; margins apply to the drawing.
  const ink = inkOf(doc, "fit", 0);
  assert.ok(ink, "contained image must produce an ink row");
  assert.ok(Math.abs(ink[0] - 270) <= 0.6, `ink x=${ink[0]}`);
  assert.ok(Math.abs(ink[1] - 130) <= 0.6, `ink y=${ink[1]}`);
  assert.ok(Math.abs(ink[2] - 60) <= 0.6, `ink w=${ink[2]}`);
  assert.ok(Math.abs(ink[3] - 40) <= 0.6, `ink h=${ink[3]}`);
});

test("4. rotated image ink is the rotated ink rectangle", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "rot", atMs: 0 }], {
    rot: { html: ROTATED_HTML, assets: { "logo.png": marginPng() } },
  });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  const doc = readDoc(res.cues[0].file);
  const item = boxOf(doc, "spin", 0);
  assert.ok(item);
  const ink = inkOf(doc, "spin", 0);
  assert.ok(ink, "rotated image must produce an ink row");
  // Ink rectangle 60x40 rotated 30deg about the shared center.
  const cos = Math.cos(Math.PI / 6);
  const sin = Math.sin(Math.PI / 6);
  assert.ok(Math.abs(ink[2] - (60 * cos + 40 * sin)) <= 1, `ink w=${ink[2]}`);
  assert.ok(Math.abs(ink[3] - (60 * sin + 40 * cos)) <= 1, `ink h=${ink[3]}`);
  assert.ok(
    Math.abs(ink[0] + ink[2] / 2 - (item[0] + item[2] / 2)) <= 1,
    `ink/item center x: ${ink[0] + ink[2] / 2} vs ${item[0] + item[2] / 2}`
  );
  assert.ok(
    Math.abs(ink[1] + ink[3] / 2 - (item[1] + item[3] / 2)) <= 1,
    `ink/item center y: ${ink[1] + ink[3] / 2} vs ${item[1] + item[3] / 2}`
  );
  assert.ok(ink[2] * ink[3] < item[2] * item[3] * 0.5, "ink area must be far smaller");
});

test("5. opaque fill-fit image and painted boxes carry no ink row", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "opq", atMs: 0 }], {
    opq: { html: OPAQUE_HTML, assets: { "solid.png": solidPng() } },
  });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  const doc = readDoc(res.cues[0].file);
  assert.ok(boxOf(doc, "flat", 0), "opaque image must still be listed");
  assert.equal(inkOf(doc, "flat", 0), null, "ink equal to the item box must be omitted");
  assert.equal(inkOf(doc, "flat", 15), null);
});

test("6. parent and group link a card with its own text", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "grp", atMs: 0 }], {
    grp: { html: GROUP_HTML },
  });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  const doc = readDoc(res.cues[0].file);
  const idx = (key: string): number => doc.elements.findIndex((e) => e.key === key);
  const bg = idx("bg");
  const card = idx("card");
  const title = idx("title");
  assert.ok(bg >= 0 && card >= 0 && title >= 0, "bg, card and title must be tracked");
  assert.equal(doc.elements[title].parent, card);
  assert.equal(doc.elements[title].group, card);
  assert.equal(doc.elements[card].parent, bg);
  assert.equal(doc.elements[card].group, undefined, "stage-sized bg is not a group");
  assert.equal(doc.elements[bg].parent, undefined);
  assert.equal(doc.elements[bg].group, undefined);
  assert.equal(inkOf(doc, "card", 0), null, "painted card keeps the item box");
});

test("7. stacked title rows separate in ink while line boxes touch", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "rows", atMs: 0 }], {
    rows: { html: ROWS_HTML },
  });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  const doc = readDoc(res.cues[0].file);
  const top = boxOf(doc, "row1", 0);
  const bottom = boxOf(doc, "row2", 0);
  assert.ok(top && bottom);
  // Range boxes (font content height) overlap at a 56px pitch.
  assert.ok(top[1] + top[3] >= bottom[1] - 0.6, "line boxes overlap or touch");
  const inkTop = inkOf(doc, "row1", 0);
  const inkBottom = inkOf(doc, "row2", 0);
  assert.ok(inkTop && inkBottom, "both rows must carry ink");
  assert.ok(
    inkTop[1] + inkTop[3] < inkBottom[1] - 1,
    `ink rows must separate: ${inkTop[1] + inkTop[3]} vs ${inkBottom[1]}`
  );
});

test("8. a /1 cache file is re-measured into /2", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "text", atMs: 0 }], {
    text: { html: TEXT_HTML },
  });
  const first = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  assert.equal(first.cues[0].cached, false);
  const file = first.cues[0].file;
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as CoordsDocument;
  doc.schema = "cuthol.coords/1";
  (doc as unknown as Record<string, unknown>).engine_version = "1";
  fs.writeFileSync(file, JSON.stringify(doc), "utf8");
  resetCoordsBrowserLaunchCount();
  const second = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  assert.equal(second.cues[0].cached, false, "stale /1 entry must be a cache miss");
  assert.equal(getCoordsBrowserLaunchCount(), 1);
  const fresh = readDoc(second.cues[0].file);
  assert.equal(fresh.schema, "cuthol.coords/2");
  assert.equal(fresh.engine_version, "4");
  assert.ok(inkOf(fresh, "headline", 0), "re-measured doc must carry ink");
});

test("9. two refreshed measurements produce identical ink JSON", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "img", atMs: 0 }], {
    img: { html: IMAGE_HTML, assets: { "logo.png": marginPng() } },
  });
  const a = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"], refresh: true });
  const b = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"], refresh: true });
  const bytesA = fs.readFileSync(a.cues[0].file, "utf8");
  const bytesB = fs.readFileSync(b.cues[0].file, "utf8");
  assert.equal(bytesB, bytesA);
  assert.ok(JSON.parse(bytesA).frames[0].ink, "doc must contain ink rows");
});

test("11. translated text keeps ink during and after GSAP x motion", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "slide", atMs: 0 }], {
    slide: { html: SLIDE_HTML },
  });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  const doc = readDoc(res.cues[0].file);
  // Pure translation maps local px 1:1, so ink tracks the motion every frame.
  for (const f of [0, 15, 29]) {
    const item = boxOf(doc, "slide", f);
    const ink = inkOf(doc, "slide", f);
    assert.ok(item && ink, `frame ${f} must list #slide with ink`);
    assert.ok(Math.abs(item[0] - (100 + (f / 30) * 500)) <= 0.6, `frame ${f}: x=${item[0]}`);
    assert.ok(ink[0] >= item[0] - 0.1 && ink[0] + ink[2] <= item[0] + item[2] + 0.1);
    assert.ok(ink[3] < item[3] - 3, `frame ${f}: ink trims vertically`);
  }
  const y0 = inkOf(doc, "slide", 0)?.[1];
  const y1 = inkOf(doc, "slide", 15)?.[1];
  assert.ok(y0 !== undefined && y1 !== undefined && Math.abs(y0 - y1) <= 0.5, "no vertical jitter");
});

test("12. file margins resolve the alpha box of a synthetic PNG", () => {
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, "inkfile-"));
  const file = path.join(dir, "logo.png");
  fs.writeFileSync(file, marginPng());
  const m = resolveImageFileInkMargins(file);
  assert.ok(m, "synthetic PNG must resolve");
  assert.equal(m.width, 100);
  assert.equal(m.height, 100);
  assert.ok(Math.abs(m.left - 0.2) < 1e-9, `left=${m.left}`);
  assert.ok(Math.abs(m.top - 0.3) < 1e-9, `top=${m.top}`);
  assert.ok(Math.abs(m.right - 0.2) < 1e-9, `right=${m.right}`);
  assert.ok(Math.abs(m.bottom - 0.3) < 1e-9, `bottom=${m.bottom}`);
  assert.equal(resolveImageFileInkMargins(path.join(dir, "missing.png")), null);
  const dusty = path.join(dir, "dust.png");
  fs.writeFileSync(dusty, speckPng());
  const dm = resolveImageFileInkMargins(dusty);
  assert.ok(dm, "dusty PNG must resolve");
  assert.ok(Math.abs(dm.left - 0.2) < 1e-9, `dust left=${dm.left}`);
  assert.ok(Math.abs(dm.top - 0.3) < 1e-9, `dust top=${dm.top}`);
  assert.ok(Math.abs(dm.right - 0.2) < 1e-9, `dust right=${dm.right}`);
  assert.ok(Math.abs(dm.bottom - 0.3) < 1e-9, `dust bottom=${dm.bottom}`);
});

test("13. stroked text ink covers the stroke ring", async () => {
  const proj = makeProject([{ id: "cue_01", comp: "stroke", atMs: 0 }], {
    stroke: { html: STROKE_HTML },
  });
  const res = await measureCompositionCues({ workspaceDir: proj, cueIds: ["cue_01"] });
  const doc = readDoc(res.cues[0].file);
  const plain = inkOf(doc, "plain", 0);
  const lined = inkOf(doc, "lined", 0);
  const plainItem = boxOf(doc, "plain", 0);
  const linedItem = boxOf(doc, "lined", 0);
  assert.ok(plain && lined && plainItem && linedItem, "both texts must carry item + ink");
  // Same string and font: compare ink insets within each item box. A 4px stroke
  // straddles the glyph edge, so the stroked ink sits ~2px further out per side.
  const inset = (
    ink: [number, number, number, number],
    item: [number, number, number, number]
  ): [number, number, number, number] => [
    ink[0] - item[0],
    ink[1] - item[1],
    item[0] + item[2] - (ink[0] + ink[2]),
    item[1] + item[3] - (ink[1] + ink[3]),
  ];
  const pi = inset(plain, plainItem);
  const li = inset(lined, linedItem);
  for (let e = 0; e < 4; e++) {
    assert.ok(li[e] <= pi[e] - 1.5, `stroke edge ${e}: ${li[e]} vs ${pi[e]}`);
    assert.ok(li[e] >= pi[e] - 3.5, `stroke pad bounded, edge ${e}: ${li[e]} vs ${pi[e]}`);
  }
});

test("10. prune remaps ink rows and falls back pruned parents", () => {
  const elements = [
    { key: "a", kind: "box", label: "a" },
    { key: "b", kind: "box", label: "b", parent: 0 },
    { key: "c", kind: "text", label: "c", parent: 1, group: 0 },
    { key: "d", kind: "text", label: "d", parent: 0, group: 1 },
  ];
  const frames = [
    {
      f: 0,
      items: [
        [0, 0, 0, 10, 10, 1, 0],
        [2, 1, 1, 8, 8, 1, 2],
        [3, 2, 2, 4, 4, 1, 3],
      ],
      ink: [
        [2, 1, 2, 8, 6],
        [3, 2, 2, 4, 3],
      ],
    },
  ] as unknown as CoordsDocument["frames"];
  const kept = pruneCoordsElements(elements, frames);
  assert.deepEqual(
    kept.map((e) => e.key),
    ["a", "c", "d"]
  );
  // c: parent 1 pruned -> nearest kept ancestor 0; group 0 -> 0.
  assert.equal(kept[1].parent, 0);
  assert.equal(kept[1].group, 0);
  // d: group 1 pruned -> dropped.
  assert.equal(kept[2].parent, 0);
  assert.equal(kept[2].group, undefined);
  assert.deepEqual(frames[0].ink, [
    [1, 1, 2, 8, 6],
    [2, 2, 2, 4, 3],
  ]);
});
