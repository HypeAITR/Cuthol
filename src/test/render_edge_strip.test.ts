/**
 * The post-render edge check reports a black strip along the right or bottom edge (CUTHOL-G506) and stays
 * quiet when the picture reaches the edge.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scanRenderedMp4ForEdgeStrips } from "../render/renderer.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace", "render_edge_strip");

function makeVideo(file: string, vf: string): void {
  const proc = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0xFFD23F:s=1080x1080:r=30:d=2",
    "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ]);
  assert.equal(proc.status, 0, proc.stderr?.toString());
}

test("edge strip check flags a black right edge and passes a clean frame", () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  const clean = path.join(TEST_ROOT, "clean.mp4");
  const strip = path.join(TEST_ROOT, "strip.mp4");
  makeVideo(clean, "null");
  makeVideo(strip, "drawbox=x=1072:y=0:w=8:h=1080:color=black:t=fill");

  assert.equal(scanRenderedMp4ForEdgeStrips(clean, 2000), null);
  const diag = scanRenderedMp4ForEdgeStrips(strip, 2000);
  assert.ok(diag, "expected a diagnostic for the black right edge");
  assert.equal(diag!.code, "CUTHOL-G506");
  assert.match(diag!.what, /right/);
});
