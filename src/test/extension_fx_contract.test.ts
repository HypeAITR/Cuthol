/**
 * Effect contract: manifest `fx` / `transitions` sections, the sequence effect registry, and the
 * "never ignore silently" placeholders of the fx and edge stages. Gates replace the placeholder tests
 * (marked PLACEHOLDER) with real behaviour tests; the manifest/registry tests stay.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { listExtensions, resolveExtension } from "../extensions/ext_registry.js";
import {
  getSequenceEffectRegistry,
  isExtensionEffectRef,
  parseExtensionEffectRef,
} from "../extensions/ext_effects.js";
import { applySpineClipEdgeToOverlay, buildSpineClipEdgeFilters, spineClipEdgeRequiresRgba } from "../compositor/compile_spine_edge.js";
import { buildSpineClipFxFilters } from "../compositor/compile_spine_fx.js";
import type { VideoGraphCompileContext } from "../compositor/compiler.js";
import type { CutholSequence } from "../core/schema.js";

function withWorkspace(fn: (wsDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-"));
  const wsDir = path.join(tmp, "proj");
  try {
    initWorkspace({ dir: wsDir, title: "", aspect: "16:9", fps: 30 });
    fn(wsDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeExtension(wsDir: string, manifest: Record<string, unknown>): string {
  const dir = path.join(wsDir, ".cuthol", "extensions", String(manifest.name));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cuthol-extension.json"), JSON.stringify(manifest, null, 2), "utf8");
  return dir;
}

const BASE = { name: "fxdemo", version: "1.0.0", description: "contract demo" };

test("manifest fx/transitions sections parse, list and load into the sequence effect registry", () => {
  withWorkspace((ws) => {
    writeExtension(ws, {
      ...BASE,
      fx: {
        soft_blur: {
          description: "Gaussian blur",
          params: { sigma: { type: "number", default: 4, min: 0, max: 50 } },
          video_filter: "gblur=sigma={{sigma}}",
        },
      },
      transitions: { push_left: { description: "push" } },
    });
    const ext = resolveExtension("fxdemo", ws);
    assert.equal(ext.manifest.fx?.soft_blur.video_filter, "gblur=sigma={{sigma}}");
    assert.ok(ext.manifest.transitions?.push_left);
    const listed = listExtensions(ws).extensions.find((e) => e.name === "fxdemo");
    assert.deepEqual(listed?.provides.fx, ["soft_blur"]);
    assert.deepEqual(listed?.provides.transitions, ["push_left"]);

    enableExtensionInWorkspace({ workspaceDir: ws, name: "fxdemo" });
    const { sequence, paths } = loadSequence(ws);
    const reg = getSequenceEffectRegistry(sequence, paths.rootDir);
    const fx = reg.fx.get("ext:fxdemo/soft_blur");
    assert.ok(fx, "fx registered");
    assert.equal(fx.pinned_match, true);
    assert.ok(reg.transitions.get("ext:fxdemo/push_left"));
    assert.equal(reg.load_errors.size, 0);
  });
});

test("extensions without fx/transitions keep their listing unchanged (no empty keys)", () => {
  withWorkspace((ws) => {
    writeExtension(ws, { ...BASE, name: "plain" });
    const listed = listExtensions(ws).extensions.find((e) => e.name === "plain");
    assert.ok(listed);
    assert.equal("fx" in listed.provides, false);
    assert.equal("transitions" in listed.provides, false);
  });
});

test("closed schema: unknown fx key, missing video_filter and bad names are rejected", () => {
  withWorkspace((ws) => {
    writeExtension(ws, { ...BASE, name: "bad1", fx: { a: { video_filter: "null", shader: "x" } } });
    assert.throws(() => resolveExtension("bad1", ws), /unknown field 'shader'/);
    writeExtension(ws, { ...BASE, name: "bad2", fx: { a: { description: "no filter" } } });
    assert.throws(() => resolveExtension("bad2", ws), /video_filter/);
    writeExtension(ws, { ...BASE, name: "bad3", transitions: { Bad: {} } });
    assert.throws(() => resolveExtension("bad3", ws), /invalid name/);
  });
});

test("effect refs", () => {
  assert.equal(isExtensionEffectRef("ext:fxdemo/soft_blur"), true);
  assert.equal(isExtensionEffectRef("dissolve"), false);
  assert.equal(isExtensionEffectRef("ext:FX/x"), false);
  assert.deepEqual(parseExtensionEffectRef("ext:a-b/c_d"), { extension: "a-b", name: "c_d" });
});

function fakeClip(over: Partial<CutholSequence["spine"]["clips"][number]>): CutholSequence["spine"]["clips"][number] {
  return {
    id: "sp_01",
    placement: { x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1, fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false },
    envelopes: [],
    ...over,
  } as CutholSequence["spine"]["clips"][number];
}

test("spine fx stage compiles the per-clip effect chain (P3)", () => {
  const ctx = {} as VideoGraphCompileContext;
  const p = { asset: {} as never, absAssetPath: "", clipColorSpec: {} as never, targetW: 1920, targetH: 1080 };
  assert.deepEqual(buildSpineClipFxFilters(ctx, { ...p, clip: fakeClip({}) }), []);
  assert.deepEqual(
    buildSpineClipFxFilters(ctx, { ...p, clip: fakeClip({ fx: [{ id: "fx_01", kind: "ffmpeg", params: { filter: "gblur=sigma=3" }, enabled: false }] }) }),
    []
  );
  assert.deepEqual(
    buildSpineClipFxFilters(ctx, { ...p, clip: fakeClip({ fx: [{ id: "fx_01", kind: "ffmpeg", params: { filter: "gblur=sigma=3" } }] }) }),
    ["gblur=sigma=3"]
  );
  assert.throws(() =>
    buildSpineClipFxFilters(ctx, { ...p, clip: fakeClip({ fx: [{ id: "fx_01", kind: "nope", params: {} }] }) }),
    /CUTHOL-G118/
  );
});

test("edge stage: transparent/omitted → no filters + identity overlay; mirror/clamp → fill ring + corrected overlay", () => {
  const ctx = {} as VideoGraphCompileContext;
  const p = { targetW: 1920, targetH: 1080, hasDynamicScale: false };
  const plain = fakeClip({});
  assert.deepEqual(buildSpineClipEdgeFilters(ctx, { ...p, clip: plain }), []);
  assert.equal(spineClipEdgeRequiresRgba(plain), false);
  const mirror = fakeClip({});
  mirror.placement.edge = "mirror";
  assert.equal(spineClipEdgeRequiresRgba(mirror), true);
  assert.deepEqual(applySpineClipEdgeToOverlay(ctx, { clip: plain, xExpr: "0", yExpr: "0", hasDynamicScale: false }), { xExpr: "0", yExpr: "0" });
  const ctx2 = { renderWidth: 1920, renderHeight: 1080, seq: { spine: { clips: [] } }, libMap: new Map() } as unknown as VideoGraphCompileContext;
  const shrunk = fakeClip({ placement: { ...plain.placement, scale_x: 0.6, scale_y: 0.6, edge: "mirror" } });
  const filters = buildSpineClipEdgeFilters(ctx2, { targetW: 1152, targetH: 648, hasDynamicScale: false, clip: shrunk });
  assert.equal(filters[0], "format=rgba");
  assert.match(filters[1], /^pad=w=1996:h=1124:x=422:y=238:color=black@0$/);
  assert.match(filters[2], /fillborders=left=422:right=422:top=238:bottom=238:mode=mirror/);
  assert.deepEqual(applySpineClipEdgeToOverlay(ctx2, { clip: shrunk, xExpr: "384", yExpr: "216", hasDynamicScale: false }), { xExpr: "-38", yExpr: "-22" });
  const clampClip = fakeClip({ placement: { ...plain.placement, scale_x: 0.6, scale_y: 0.6, edge: "clamp" } });
  const clampFilters = buildSpineClipEdgeFilters(ctx2, { targetW: 1152, targetH: 648, hasDynamicScale: false, clip: clampClip });
  assert.match(clampFilters.join(","), /mode=smear/);
});
