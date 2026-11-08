/**
 * Edge mode (`placement.edge` on spine clips): fill-plan math, overlay correction, CLI/MCP surface,
 * G121/G412 findings, and rendered-frame coverage proofs (red backdrop must not leak through mirror/clamp).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip, setItemEnvelope, transformSpineClip } from "../sequence/spine.js";
import { setStageBackdropColor } from "../sequence/stage.js";
import { addLaneCue } from "../sequence/lanes.js";
import {
  applySpineClipEdgeToOverlay,
  buildSpineClipEdgeFilters,
  planSpineClipEdge,
  spineClipEdgeRequiresRgba,
} from "../compositor/compile_spine_edge.js";
import { compileSequenceRenderPlan, VideoGraphCompileContext } from "../compositor/compiler.js";
import { runSpineCommand } from "../cli_cmd_spine.js";
import { TIMELINE_ACTION_SPECS } from "../mcp/catalog_specs_timeline.js";
import { verifySequence } from "../verify/gates.js";
import { renderSingleCompositeFrameRgb24 } from "../render/renderer.js";
import { CutholSequence } from "../core/schema.js";

type SpineClipSpec = CutholSequence["spine"]["clips"][number];

function fakeClip(over: Partial<SpineClipSpec>): SpineClipSpec {
  return {
    id: "sp_01",
    placement: { x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1, fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false },
    envelopes: [],
    ...over,
  } as SpineClipSpec;
}

function fakeCtx(renderWidth = 1920, renderHeight = 1080, clips: SpineClipSpec[] = []): VideoGraphCompileContext {
  return {
    renderWidth,
    renderHeight,
    seq: { spine: { clips } },
    libMap: new Map(),
  } as unknown as VideoGraphCompileContext;
}

function shrunkPlacement(edge: "mirror" | "clamp" | "transparent" | undefined): SpineClipSpec["placement"] {
  return { x_pct: 0, y_pct: 0, scale_x: 0.6, scale_y: 0.6, rotation_deg: 0, opacity: 1, fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false, edge };
}

test("omitted/transparent edge → no plan, no filters, identity overlay (byte-identical default)", () => {
  const ctx = fakeCtx();
  for (const edge of [undefined, "transparent"] as const) {
    const clip = fakeClip({ placement: { x_pct: 5, y_pct: -3, scale_x: 0.6, scale_y: 0.6, rotation_deg: 12, opacity: 1, fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false, edge } });
    assert.deepEqual(planSpineClipEdge(ctx, clip, 1152, 648, false), { kind: "none" });
    assert.deepEqual(buildSpineClipEdgeFilters(ctx, { clip, targetW: 1152, targetH: 648, hasDynamicScale: false }), []);
    assert.deepEqual(
      applySpineClipEdgeToOverlay(ctx, { clip, xExpr: "384", yExpr: "216", hasDynamicScale: false }),
      { xExpr: "384", yExpr: "216" }
    );
    assert.equal(spineClipEdgeRequiresRgba(clip), false);
  }
});

test("mirror on a shrunk static clip → pad + mirror ring sized to the overlay position, overlay shifted back", () => {
  const ctx = fakeCtx();
  const clip = fakeClip({ placement: shrunkPlacement("mirror") });
  assert.equal(spineClipEdgeRequiresRgba(clip), true);
  assert.deepEqual(planSpineClipEdge(ctx, clip, 1152, 648, false), {
    kind: "strip",
    pad: { left: 422, right: 422, top: 238, bottom: 238 },
  });
  const filters = buildSpineClipEdgeFilters(ctx, { clip, targetW: 1152, targetH: 648, hasDynamicScale: false });
  assert.equal(filters[0], "format=rgba");
  assert.match(filters[1], /^pad=w=1996:h=1124:x=422:y=238:color=black@0$/);
  assert.match(filters[2], /fillborders=left=422:right=422:top=238:bottom=238:mode=mirror/);
  assert.deepEqual(
    applySpineClipEdgeToOverlay(ctx, { clip, xExpr: "384", yExpr: "216", hasDynamicScale: false }),
    { xExpr: "-38", yExpr: "-22" }
  );
});

test("clamp fills the ring with stretched edge pixels in one pass", () => {
  const ctx = fakeCtx();
  const clip = fakeClip({ placement: shrunkPlacement("clamp") });
  const filters = buildSpineClipEdgeFilters(ctx, { clip, targetW: 1152, targetH: 648, hasDynamicScale: false });
  assert.deepEqual(filters.length, 3);
  assert.match(filters[2], /mode=smear/);
});

test("mirror ring wider than the frame grows by doubling (mirror reflects a single frame-width)", () => {
  const ctx = fakeCtx();
  // scale 0.2 → 384px wide frame, ~806px ring per side: needs two mirror steps per side.
  const clip = fakeClip({ placement: { x_pct: 0, y_pct: 0, scale_x: 0.2, scale_y: 0.2, rotation_deg: 0, opacity: 1, fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false, edge: "mirror" } });
  const filters = buildSpineClipEdgeFilters(ctx, { clip, targetW: 384, targetH: 216, hasDynamicScale: false });
  const pads = filters.filter((f) => f.startsWith("pad="));
  assert.ok(pads.length >= 2, `expected doubling steps, got: ${filters.join(" | ")}`);
  assert.ok(filters.every((f) => f.includes("mode=mirror") || !f.startsWith("fillborders")));
  assert.deepEqual(planSpineClipEdge(ctx, clip, 384, 216, false), {
    kind: "strip",
    pad: { left: 806, right: 806, top: 454, bottom: 454 },
  });
});

test("panned clip: ring covers the whole envelope travel, expression overlay wrapped", () => {
  const ctx = fakeCtx();
  const clip = fakeClip({
    placement: shrunkPlacement("mirror"),
    envelopes: [{ parameter: "placement.x_pct", points: [{ offset_ms: 0, value: -15, easing: "linear" }, { offset_ms: 4000, value: 15, easing: "linear" }] }],
  });
  // x travel 384±288 → left/right pads 710/710; y unchanged 238/238.
  assert.deepEqual(planSpineClipEdge(ctx, clip, 1152, 648, false), {
    kind: "strip",
    pad: { left: 710, right: 710, top: 238, bottom: 238 },
  });
  assert.deepEqual(
    applySpineClipEdgeToOverlay(ctx, { clip, xExpr: "if(lt(t,4),1,2)", yExpr: "216", hasDynamicScale: false }),
    { xExpr: "(if(lt(t,4),1,2))-710", yExpr: "-22" }
  );
});

test("full-cover static clip → no filters at all, overlay untouched", () => {
  const ctx = fakeCtx();
  const clip = fakeClip({ placement: { x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1, fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false, edge: "mirror" } });
  assert.deepEqual(planSpineClipEdge(ctx, clip, 1920, 1080, false), {
    kind: "strip",
    pad: { left: 0, right: 0, top: 0, bottom: 0 },
  });
  assert.deepEqual(buildSpineClipEdgeFilters(ctx, { clip, targetW: 1920, targetH: 1080, hasDynamicScale: false }), []);
  assert.deepEqual(
    applySpineClipEdgeToOverlay(ctx, { clip, xExpr: "0", yExpr: "0", hasDynamicScale: false }),
    { xExpr: "0", yExpr: "0" }
  );
});

test("fully off-stage clip → no filters (transparent behaviour is correct there)", () => {
  const ctx = fakeCtx();
  const clip = fakeClip({ placement: { x_pct: 150, y_pct: 0, scale_x: 0.6, scale_y: 0.6, rotation_deg: 0, opacity: 1, fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false, edge: "mirror" } });
  assert.deepEqual(buildSpineClipEdgeFilters(ctx, { clip, targetW: 1152, targetH: 648, hasDynamicScale: false }), []);
  assert.deepEqual(
    applySpineClipEdgeToOverlay(ctx, { clip, xExpr: "3264", yExpr: "216", hasDynamicScale: false }),
    { xExpr: "3264", yExpr: "216" }
  );
});

test("static rotation → de-rotate plan: clean crop, filled surround rect, exact overlay shift", () => {
  const ctx = fakeCtx();
  const clip = fakeClip({ placement: { x_pct: 0, y_pct: 0, scale_x: 0.7, scale_y: 0.7, rotation_deg: 15, opacity: 1, fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false, edge: "mirror" } });
  const plan = planSpineClipEdge(ctx, clip, 1344, 756, false);
  if (plan.kind !== "derotate") assert.fail(`expected derotate plan, got ${plan.kind}`);
  assert.deepEqual(
    { Rw: plan.Rw, Rh: plan.Rh, bboxW: plan.bboxW, bboxH: plan.bboxH, offX: plan.offX, offY: plan.offY, ring: plan.ring },
    {
      Rw: 2212, Rh: 1586, bboxW: 2547, bboxH: 2104, offX: 527, offY: 513,
      ring: { left: 434, right: 434, top: 415, bottom: 415 },
    }
  );
  const filters = buildSpineClipEdgeFilters(ctx, { clip, targetW: 1344, targetH: 756, hasDynamicScale: false });
  assert.equal(filters[0], "format=rgba");
  assert.match(filters[1], /^rotate=-0\.2618:ow='rotw\(-0\.2618\)':oh='roth\(-0\.2618\)':c=none$/);
  assert.match(filters[2], /^crop=w=1344:h=756:x=189:y=336$/);
  assert.match(filters[3], /^pad=w=2212:h=1586:x=434:y=415:color=black@0$/);
  assert.match(filters[4], /fillborders=left=434:right=434:top=415:bottom=415:mode=mirror/);
  assert.match(filters[5], /^rotate=0\.2618:ow='rotw\(0\.2618\)':oh='roth\(0\.2618\)':c=none$/);
  assert.deepEqual(
    applySpineClipEdgeToOverlay(ctx, { clip, xExpr: "213", yExpr: "1", hasDynamicScale: false }),
    { xExpr: "-314", yExpr: "-512" }
  );
});

test("static 90-degree rotation → strip path (frame stays opaque), no de-rotation", () => {
  const ctx = fakeCtx();
  const clip = fakeClip({ placement: { x_pct: 0, y_pct: 0, scale_x: 0.7, scale_y: 0.7, rotation_deg: 90, opacity: 1, fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false, edge: "mirror" } });
  const plan = planSpineClipEdge(ctx, clip, 1344, 756, false);
  assert.equal(plan.kind, "strip");
  const filters = buildSpineClipEdgeFilters(ctx, { clip, targetW: 1344, targetH: 756, hasDynamicScale: false });
  assert.ok(!filters.some((f) => f.startsWith("rotate=")), filters.join(" | "));
  assert.ok(filters.some((f) => f.includes("mode=mirror")), filters.join(" | "));
});

test("rotation envelope without position envelope → overlay untouched (runtime-size centering)", () => {
  const ctx = fakeCtx();
  const clip = fakeClip({
    placement: { x_pct: 10, y_pct: 0, scale_x: 0.6, scale_y: 0.6, rotation_deg: 0, opacity: 1, fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false, edge: "mirror" },
    envelopes: [{ parameter: "placement.rotation_deg", points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 4000, value: 20, easing: "linear" }] }],
  });
  const plan = planSpineClipEdge(ctx, clip, 1152, 648, false);
  assert.equal(plan.kind, "derotate");
  const filters = buildSpineClipEdgeFilters(ctx, { clip, targetW: 1152, targetH: 648, hasDynamicScale: false });
  assert.ok(filters.some((f) => f.startsWith("rotate=a='-((")), filters.join(" | "));
  assert.ok(filters.some((f) => f.startsWith("crop=") && f.includes("in_w")), filters.join(" | "));
  assert.deepEqual(
    applySpineClipEdgeToOverlay(ctx, { clip, xExpr: "(W-w)/2+192", yExpr: "(H-h)/2", hasDynamicScale: false }),
    { xExpr: "(W-w)/2+192", yExpr: "(H-h)/2" }
  );
});

test("rotation envelope with x envelope → overlay re-anchored to the content center", () => {
  const ctx = fakeCtx();
  const clip = fakeClip({
    placement: shrunkPlacement("clamp"),
    envelopes: [
      { parameter: "placement.rotation_deg", points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 4000, value: 20, easing: "linear" }] },
      { parameter: "placement.x_pct", points: [{ offset_ms: 0, value: -10, easing: "linear" }, { offset_ms: 4000, value: 10, easing: "linear" }] },
    ],
  });
  assert.equal(planSpineClipEdge(ctx, clip, 1152, 648, false).kind, "derotate");
  assert.deepEqual(
    applySpineClipEdgeToOverlay(ctx, { clip, xExpr: "if(lt(t,4),1,2)", yExpr: "(H-h)/2", hasDynamicScale: false }),
    { xExpr: "(if(lt(t,4),1,2))+576-w/2", yExpr: "(H-h)/2" }
  );
});

test("dynamic scale (zoom-out envelope) → grown ring keeps stage covered, overlay corrected", () => {
  const clip = fakeClip({
    placement: { x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1, fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false, edge: "mirror" },
    envelopes: [
      { parameter: "placement.scale_x", points: [{ offset_ms: 0, value: 1, easing: "linear" }, { offset_ms: 4000, value: 0.5, easing: "linear" }] },
      { parameter: "placement.scale_y", points: [{ offset_ms: 0, value: 1, easing: "linear" }, { offset_ms: 4000, value: 0.5, easing: "linear" }] },
    ],
  });
  const ctx = fakeCtx(1920, 1080, [clip]);
  // k = (1920 + 2*38) / (0.5*1920) ≈ 2.08 → target 3997x2248.
  assert.deepEqual(planSpineClipEdge(ctx, clip, 1920, 1080, true), {
    kind: "strip",
    pad: { left: 1038, right: 1039, top: 584, bottom: 584 },
  });
  const filters = buildSpineClipEdgeFilters(ctx, { clip, targetW: 1920, targetH: 1080, hasDynamicScale: true });
  assert.equal(filters[0], "format=rgba");
  assert.ok(filters.some((f) => f.includes("mode=mirror")), filters.join(" | "));
  assert.deepEqual(
    applySpineClipEdgeToOverlay(ctx, { clip, xExpr: "0", yExpr: "0", hasDynamicScale: true }),
    { xExpr: "-1038", yExpr: "-584" }
  );
});

test("dynamic scale growth is capped (extreme zoom-out degrades to partial cover, never explodes)", () => {
  const clip = fakeClip({
    placement: { x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1, fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false, edge: "mirror" },
    envelopes: [{ parameter: "placement.scale_x", points: [{ offset_ms: 0, value: 1, easing: "linear" }, { offset_ms: 4000, value: 0.05, easing: "linear" }] }],
  });
  const ctx = fakeCtx(1920, 1080, [clip]);
  assert.deepEqual(planSpineClipEdge(ctx, clip, 1920, 1080, true), {
    kind: "strip",
    pad: { left: 1920, right: 1920, top: 1080, bottom: 1080 },
  });
});

test("unknown edge value → loud error, never silent", () => {
  const ctx = fakeCtx();
  const clip = fakeClip({ placement: { x_pct: 0, y_pct: 0, scale_x: 0.6, scale_y: 0.6, rotation_deg: 0, opacity: 1, fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false, edge: "blur" as never } });
  assert.throws(() => planSpineClipEdge(ctx, clip, 1152, 648, false), /placement\.edge 'blur'/);
  assert.throws(() => buildSpineClipEdgeFilters(ctx, { clip, targetW: 1152, targetH: 648, hasDynamicScale: false }), /placement\.edge 'blur'/);
  assert.throws(() => applySpineClipEdgeToOverlay(ctx, { clip, xExpr: "0", yExpr: "0", hasDynamicScale: false }), /placement\.edge 'blur'/);
});

test("contain letterbox bars take the edge mode; exact-fit contain stays untouched", () => {
  const clip = fakeClip({
    asset_handle: "vid_01",
    placement: { x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1, fit_mode: "contain", crop: null, mirror_x: false, mirror_y: false, edge: "mirror" },
  } as Partial<SpineClipSpec>);
  // 16:9 source contained in a 9:16 target → tall top/bottom bars.
  const ctx = fakeCtx(1080, 1920, [clip]);
  (ctx.libMap as Map<string, unknown>).set("vid_01", { probe: { width: 1920, height: 1080 } });
  const filters = buildSpineClipEdgeFilters(ctx, { clip, targetW: 1080, targetH: 1920, hasDynamicScale: false });
  assert.equal(filters[0], "format=rgba");
  assert.match(filters[1], /^fillborders=top=656:bottom=656:mode=mirror$/);
  // Exact-fit source (same aspect) → no bar fill, no surround → no filters at all.
  (ctx.libMap as Map<string, unknown>).set("vid_01", { probe: { width: 1080, height: 1920 } });
  assert.deepEqual(buildSpineClipEdgeFilters(ctx, { clip, targetW: 1080, targetH: 1920, hasDynamicScale: false }), []);
});

// ---------------------------------------------------------------- CLI / MCP surface

test("spine transform --edge: mirror sets, transparent clears, invalid rejects", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-edge-cli-"));
  try {
    initWorkspace({ dir: wsDir, title: "edge cli", aspect: "16:9", fps: 30 });
    const media = path.join(wsDir, "src.mp4");
    assert.equal(spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", media]).status, 0);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });

    const set = transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", edge: "mirror" });
    assert.equal(set.placement.edge, "mirror");
    assert.equal(loadSequence(wsDir).sequence.spine.clips[0].placement.edge, "mirror");

    const cleared = transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", edge: "transparent" });
    assert.equal("edge" in cleared.placement, false);
    assert.equal("edge" in loadSequence(wsDir).sequence.spine.clips[0].placement, false);

    assert.throws(() => transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", edge: "blur" as never }), /--edge blur/);
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test("spine transform handler reads the --edge flag", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-edge-cmd-"));
  try {
    initWorkspace({ dir: wsDir, title: "edge cmd", aspect: "16:9", fps: 30 });
    const media = path.join(wsDir, "src.mp4");
    assert.equal(spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", media]).status, 0);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => { logs.push(String(msg)); };
    try {
      runSpineCommand({ group: "spine", action: "transform", rest: [], flags: { clip: "sp_01", edge: "clamp" }, workspaceDir: wsDir, formatFlag: "" });
    } finally {
      console.log = origLog;
    }
    assert.equal(loadSequence(wsDir).sequence.spine.clips[0].placement.edge, "clamp");
    assert.ok(logs.length > 0, "expected an envelope on stdout");
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test("MCP spine transform exposes the edge enum", () => {
  const spec = TIMELINE_ACTION_SPECS.find((s) => s.tool === "spine" && s.action === "transform")!;
  const edge = spec.params.find((p) => p.name === "edge")!;
  assert.deepEqual(edge.enum, ["transparent", "mirror", "clamp"]);
});

// ---------------------------------------------------------------- gates

test("G412 warns on an ineffective edge (static full cover), stays quiet otherwise", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-edge-g412-"));
  try {
    initWorkspace({ dir: wsDir, title: "g412", aspect: "16:9", fps: 30 });
    const media = path.join(wsDir, "src.mp4");
    assert.equal(spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", media]).status, 0);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 3000, sourceOutMs: 6000 });

    transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", edge: "mirror" });
    let seq = loadSequence(wsDir).sequence;
    let g412 = verifySequence(seq).diagnostics.filter((d) => d.code === "CUTHOL-G412");
    assert.equal(g412.length, 1);
    assert.equal(g412[0].subject_id, "sp_01");
    assert.equal(g412[0].severity, "WARN");

    // Shrinking the clip makes the edge effective → warning clears.
    transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", scale: "0.6" });
    seq = loadSequence(wsDir).sequence;
    assert.equal(verifySequence(seq).diagnostics.filter((d) => d.code === "CUTHOL-G412").length, 0);

    // Full-cover but panning via envelope → motion → no warning.
    transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", scale: "1.0" });
    setItemEnvelope({ workspaceDir: wsDir, targetId: "sp_01", parameter: "placement.x_pct", points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 3000, value: 10, easing: "linear" }] });
    seq = loadSequence(wsDir).sequence;
    assert.equal(verifySequence(seq).diagnostics.filter((d) => d.code === "CUTHOL-G412").length, 0);
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test("G121 errors on a lane cue carrying edge (unsupported this wave, never silently ignored)", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-edge-g121-"));
  try {
    initWorkspace({ dir: wsDir, title: "g121", aspect: "16:9", fps: 30 });
    const media = path.join(wsDir, "src.mp4");
    assert.equal(spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", media]).status, 0);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    addLaneCue({ workspaceDir: wsDir, laneId: "ln_titles", kind: "title", text: "Hi", atMs: 0, durationMs: 1000 });

    const { paths, sequence } = loadSequence(wsDir);
    const cue = sequence.lanes.find((l) => l.id === "ln_titles")!.cues[0];
    cue.placement.edge = "mirror";
    fs.writeFileSync(paths.sequenceFile, JSON.stringify(sequence, null, 2), "utf8");

    const report = verifySequence(loadSequence(wsDir).sequence);
    const g121 = report.diagnostics.filter((d) => d.code === "CUTHOL-G121");
    assert.equal(g121.length, 1);
    assert.equal(g121[0].severity, "ERROR");
    assert.equal(report.ok, false);
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test("no-edge project compiles with no fillborders in the filter plan", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-edge-plan-"));
  try {
    initWorkspace({ dir: wsDir, title: "plan", aspect: "16:9", fps: 30 });
    const media = path.join(wsDir, "src.mp4");
    assert.equal(spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", media]).status, 0);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", scale: "0.6", xPct: "10" });
    const { paths, sequence } = loadSequence(wsDir);
    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
    assert.ok(!plan.filterComplex.includes("fillborders"), plan.filterComplex.slice(0, 400));
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- rendered coverage proofs

const EDGE_PROOF_ROOT = path.resolve(process.cwd(), "test-workspace", "edge_modes");

function ensureRedFreeTestsrc(targetMp4: string): void {
  if (fs.existsSync(targetMp4)) return;
  fs.mkdirSync(path.dirname(targetMp4), { recursive: true });
  // Patterned clip (testsrc2) with the red channel removed, so near-pure-red pixels can only be backdrop bleed.
  const proc = spawnSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:d=4",
    "-vf", "colorchannelmixer=rr=0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", targetMp4,
  ]);
  assert.equal(proc.status, 0, proc.stderr?.toString());
}

function ensureRedFreeStill(targetPng: string): void {
  if (fs.existsSync(targetPng)) return;
  fs.mkdirSync(path.dirname(targetPng), { recursive: true });
  const proc = spawnSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-vf", "colorchannelmixer=rr=0",
    "-frames:v", "1", targetPng,
  ]);
  assert.equal(proc.status, 0, proc.stderr?.toString());
}

/** Fraction of near-pure-red pixels (the red stage backdrop leaking through). */
function backdropRedRatio(rgb: Buffer): number {
  let red = 0;
  const px = rgb.length / 3;
  for (let i = 0; i < rgb.length; i += 3) {
    if (rgb[i] > 200 && rgb[i + 1] < 80 && rgb[i + 2] < 80) red++;
  }
  return red / px;
}

function renderFrameAt(wsDir: string, atMs: number): { ratio: number; width: number; height: number; rgb: Buffer } {
  const { paths, sequence } = loadSequence(wsDir);
  const frame = renderSingleCompositeFrameRgb24(sequence, paths, atMs, "draft_480p");
  return { ratio: backdropRedRatio(frame.rgbBuf), width: frame.width, height: frame.height, rgb: frame.rgbBuf };
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function setupPanProject(wsDir: string, edge: "transparent" | "mirror" | "clamp"): void {
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: `pan ${edge}`, aspect: "16:9", fps: 30 });
  setStageBackdropColor({ workspaceDir: wsDir, color: "#FF0000" });
  ensureRedFreeTestsrc(path.join(EDGE_PROOF_ROOT, "shared", "clip_nored.mp4"));
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [path.join(EDGE_PROOF_ROOT, "shared", "clip_nored.mp4")] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
  transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", scale: "0.6" });
  setItemEnvelope({
    workspaceDir: wsDir, targetId: "sp_01", parameter: "placement.x_pct",
    points: [{ offset_ms: 0, value: -15, easing: "linear" }, { offset_ms: 4000, value: 15, easing: "linear" }],
  });
  if (edge !== "transparent") transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", edge });
}

test("rendered pan: transparent leaks red backdrop, mirror/clamp cover the stage", () => {
  const ratios: Record<string, number> = {};
  for (const edge of ["transparent", "mirror", "clamp"] as const) {
    const wsDir = path.join(EDGE_PROOF_ROOT, `ws_pan_${edge}`);
    setupPanProject(wsDir, edge);
    ratios[edge] = renderFrameAt(wsDir, 2000).ratio;
  }
  assert.ok(ratios.transparent > 0.05, `transparent should leak backdrop, got ${ratios.transparent}`);
  assert.ok(ratios.mirror < 0.005, `mirror should cover the stage, got ${ratios.mirror}`);
  assert.ok(ratios.clamp < 0.005, `clamp should cover the stage, got ${ratios.clamp}`);
});

test("rendered fill is a true mirror / true edge-stretch and the content stays put", () => {
  for (const edge of ["transparent", "mirror", "clamp"] as const) {
    setupPanProject(path.join(EDGE_PROOF_ROOT, `ws_pan_${edge}`), edge);
  }
  const t = renderFrameAt(path.join(EDGE_PROOF_ROOT, "ws_pan_transparent"), 2000);
  const m = renderFrameAt(path.join(EDGE_PROOF_ROOT, "ws_pan_mirror"), 2000);
  const c = renderFrameAt(path.join(EDGE_PROOF_ROOT, "ws_pan_clamp"), 2000);
  const W = t.width;
  const H = t.height;
  // At t=2000ms the x envelope rests at 0 → content centered at 0.6 scale.
  const cw = Math.round(W * 0.6);
  const ch = Math.round(H * 0.6);
  const cx0 = Math.round((W - cw) / 2);
  const cy0 = Math.round((H - ch) / 2);
  const centerCrop = (rgb: Buffer): Buffer => {
    const out = Buffer.alloc(cw * ch * 3);
    for (let y = 0; y < ch; y++) {
      rgb.copy(out, y * cw * 3, ((cy0 + y) * W + cx0) * 3, ((cy0 + y) * W + cx0 + cw) * 3);
    }
    return out;
  };
  // Same content pixels with and without the fill (a shifted clip would differ wildly).
  assert.ok(meanAbsDiff(centerCrop(t.rgb), centerCrop(m.rgb)) < 6.0, "mirror must not move the content");
  assert.ok(meanAbsDiff(centerCrop(t.rgb), centerCrop(c.rgb)) < 6.0, "clamp must not move the content");
  // Left ring mirrors the adjacent content strip (center row).
  const row = Math.floor(H / 2);
  const px = (rgb: Buffer, x: number): [number, number, number] => {
    const i = (row * W + x) * 3;
    return [rgb[i], rgb[i + 1], rgb[i + 2]];
  };
  let sym = 0;
  let n = 0;
  for (let d = 4; d < cx0 - 4; d++) {
    const ring = px(m.rgb, cx0 - d);
    const src = px(m.rgb, cx0 + d);
    sym += Math.abs(ring[0] - src[0]) + Math.abs(ring[1] - src[1]) + Math.abs(ring[2] - src[2]);
    n += 3;
  }
  assert.ok(sym / n < 3.0, `left ring should mirror the content, got ${(sym / n).toFixed(2)}`);
  // Clamp ring repeats the content edge column.
  const edge = px(c.rgb, cx0);
  let cl = 0;
  n = 0;
  for (let x = 0; x < cx0 - 4; x++) {
    const p = px(c.rgb, x);
    cl += Math.abs(p[0] - edge[0]) + Math.abs(p[1] - edge[1]) + Math.abs(p[2] - edge[2]);
    n += 3;
  }
  assert.ok(cl / n < 3.0, `clamp ring should repeat the edge, got ${(cl / n).toFixed(2)}`);
});

test("rendered dynamic zoom-out with mirror covers the stage", () => {
  const wsDir = path.join(EDGE_PROOF_ROOT, "ws_dyn_mirror");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "dyn", aspect: "16:9", fps: 30 });
  setStageBackdropColor({ workspaceDir: wsDir, color: "#FF0000" });
  ensureRedFreeTestsrc(path.join(EDGE_PROOF_ROOT, "shared", "clip_nored.mp4"));
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [path.join(EDGE_PROOF_ROOT, "shared", "clip_nored.mp4")] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
  for (const param of ["placement.scale_x", "placement.scale_y"] as const) {
    setItemEnvelope({
      workspaceDir: wsDir, targetId: "sp_01", parameter: param,
      points: [{ offset_ms: 0, value: 1, easing: "linear" }, { offset_ms: 4000, value: 0.5, easing: "linear" }],
    });
  }
  transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", edge: "mirror" });
  const { ratio } = renderFrameAt(wsDir, 3900);
  assert.ok(ratio < 0.005, `zoomed-out mirror should cover the stage, got ${ratio}`);
});

test("rendered static rotation: mirror and clamp cover the stage", () => {
  const ratios: Record<string, number> = {};
  for (const edge of ["transparent", "mirror", "clamp"] as const) {
    const wsDir = path.join(EDGE_PROOF_ROOT, `ws_rot_${edge}`);
    fs.rmSync(wsDir, { recursive: true, force: true });
    initWorkspace({ dir: wsDir, title: `rot ${edge}`, aspect: "16:9", fps: 30 });
    setStageBackdropColor({ workspaceDir: wsDir, color: "#FF0000" });
    ensureRedFreeTestsrc(path.join(EDGE_PROOF_ROOT, "shared", "clip_nored.mp4"));
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [path.join(EDGE_PROOF_ROOT, "shared", "clip_nored.mp4")] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", scale: "0.7", rotationDeg: "15" });
    if (edge !== "transparent") transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", edge });
    ratios[edge] = renderFrameAt(wsDir, 2000).ratio;
  }
  assert.ok(ratios.transparent > 0.05, `transparent rotation should leak backdrop, got ${ratios.transparent}`);
  assert.ok(ratios.mirror < 0.005, `rotated mirror should cover the stage, got ${ratios.mirror}`);
  assert.ok(ratios.clamp < 0.005, `rotated clamp should cover the stage, got ${ratios.clamp}`);
});

test("rendered animated rotation with mirror covers the stage", () => {
  const wsDir = path.join(EDGE_PROOF_ROOT, "ws_rotenv_mirror");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "rotenv", aspect: "16:9", fps: 30 });
  setStageBackdropColor({ workspaceDir: wsDir, color: "#FF0000" });
  ensureRedFreeTestsrc(path.join(EDGE_PROOF_ROOT, "shared", "clip_nored.mp4"));
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [path.join(EDGE_PROOF_ROOT, "shared", "clip_nored.mp4")] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
  transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", scale: "0.7" });
  setItemEnvelope({
    workspaceDir: wsDir, targetId: "sp_01", parameter: "placement.rotation_deg",
    points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 4000, value: 20, easing: "linear" }],
  });
  transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", edge: "mirror" });
  for (const atMs of [500, 2000, 3500]) {
    const { ratio } = renderFrameAt(wsDir, atMs);
    assert.ok(ratio < 0.01, `animated rotation at ${atMs}ms should cover the stage, got ${ratio}`);
  }
});

test("rendered still-image spine clip with mirror covers the stage", () => {
  const wsDir = path.join(EDGE_PROOF_ROOT, "ws_still_mirror");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "still", aspect: "16:9", fps: 30 });
  setStageBackdropColor({ workspaceDir: wsDir, color: "#FF0000" });
  ensureRedFreeStill(path.join(EDGE_PROOF_ROOT, "shared", "still_nored.png"));
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [path.join(EDGE_PROOF_ROOT, "shared", "still_nored.png")] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "img_01", sourceInMs: 0, sourceOutMs: 4000 });
  transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", scale: "0.6" });
  transformSpineClip({ workspaceDir: wsDir, clipId: "sp_01", edge: "mirror" });
  const { ratio } = renderFrameAt(wsDir, 2000);
  assert.ok(ratio < 0.005, `mirrored still should cover the stage, got ${ratio}`);
});
