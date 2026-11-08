// Overlay cache key must include the HyperFrames package version that renders the composition.
// CUTHOL_HF_VERSION_OVERRIDE is for tests only: it stands in for that package version.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./test_setup.js";

import { readInvokedHyperFramesVersion } from "../compositor/hf_common.js";
import { initWorkspace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function safeRm(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup error
  }
}

function createSyntheticToneVideo(outPath: string): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x180:r=30:d=0.4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=48000:duration=0.4",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      outPath,
    ],
    { encoding: "utf8", timeout: 30_000 }
  );
  assert.equal(proc.status, 0, `ffmpeg tone video failed: ${proc.stderr}`);
}

function listOverlayBlobs(wsDir: string): string[] {
  const dir = path.join(wsDir, ".cuthol", "blobs");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(
      (name) =>
        name.startsWith("hf_comp_") &&
        !name.includes(".tmp.") &&
        !name.endsWith(".meta.json") &&
        !name.endsWith(".json")
    )
    .sort();
}

test("overlay cache misses with renderer_version_changed when the HyperFrames version changes", { timeout: 180_000 }, () => {
  const tmpDir = makeTempDir("cuthol-hf-ver-");
  const prevOverride = process.env.CUTHOL_HF_VERSION_OVERRIDE;
  try {
    process.env.CUTHOL_HF_VERSION_OVERRIDE = "9.9.1-test";
    assert.equal(readInvokedHyperFramesVersion(), "9.9.1-test");

    const wsDir = path.join(tmpDir, "ws");
    initWorkspace({ dir: wsDir, title: "hf-ver", aspect: "16:9", fps: 30 });
    const seqPath = path.join(wsDir, "cuthol.sequence.json");
    const seqInit = JSON.parse(fs.readFileSync(seqPath, "utf8"));
    seqInit.stage.width = 320;
    seqInit.stage.height = 180;
    fs.writeFileSync(seqPath, JSON.stringify(seqInit, null, 2), "utf8");

    const clipPath = path.join(tmpDir, "clip.mp4");
    createSyntheticToneVideo(clipPath);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [clipPath] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01" });

    const compDir = path.join(wsDir, "compositions", "comp_static");
    fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(compDir, "index.html"),
      `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>html, body, #root { margin:0; width:320px; height:180px; background:transparent !important; overflow:hidden; }</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="320" data-height="180" data-fps="30" data-duration="0.4">
      <div id="box" style="position:absolute;left:10px;top:10px;width:60px;height:40px;background:#38BDF8">STATIC</div>
    </div>
    <script>
      const C = window.__cuthol;
      const tl = gsap.timeline({ paused: true });
      tl.to("#box", { x: 10, duration: 0.2 }, 0);
      tl.set({}, {}, C.duration);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`,
      "utf8"
    );

    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_motion",
      kind: "composition",
      atMs: 0,
      durationMs: 400,
      composition: {
        composition_dir: "compositions/comp_static",
        entry_html: "index.html",
        props: {},
        transparent: true,
      },
    });

    const render = (outputPath: string) =>
      renderSequenceToMp4({
        workspaceDir: wsDir,
        outputPath,
        preset: "master_1080p",
      });

    const r1 = render("output/r1.mp4");
    assert.ok(r1.overlays);
    assert.equal(r1.overlays.total, 1);
    assert.equal(r1.overlays.cached, 0);
    assert.equal(r1.overlays.rendered, 1);
    assert.equal(r1.overlays.reasons.new, 1);

    const r2 = render("output/r2.mp4");
    assert.ok(r2.overlays);
    assert.equal(r2.overlays.total, 1);
    assert.equal(r2.overlays.cached, 1);
    assert.equal(r2.overlays.rendered, 0, `same version must hit cache, got ${JSON.stringify(r2.overlays)}`);
    assert.equal(listOverlayBlobs(wsDir).length, 1);

    process.env.CUTHOL_HF_VERSION_OVERRIDE = "9.9.2-test";
    assert.equal(readInvokedHyperFramesVersion(), "9.9.2-test");
    const r3 = render("output/r3.mp4");
    assert.ok(r3.overlays);
    assert.equal(
      r3.overlays.rendered,
      1,
      `version change must re-render, got ${JSON.stringify(r3.overlays)}`
    );
    assert.equal(r3.overlays.cached, 0);
    assert.equal(r3.overlays.reasons.renderer_version_changed, 1, JSON.stringify(r3.overlays));
    assert.equal(r3.overlays.reasons.html_changed, undefined);
    const changedReason = String(r3.overlays.rerendered[0]?.reason ?? "");
    assert.equal(changedReason, "renderer_version_changed");
    assert.equal(listOverlayBlobs(wsDir).length, 2);
  } finally {
    if (prevOverride === undefined) delete process.env.CUTHOL_HF_VERSION_OVERRIDE;
    else process.env.CUTHOL_HF_VERSION_OVERRIDE = prevOverride;
    safeRm(tmpDir);
  }
});
