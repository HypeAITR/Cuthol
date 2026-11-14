/**
 * Post-render colour check: rendered frames against the render-free prediction
 * (G510 INFO when the grade rendered as predicted, G512 WARN on a mismatch).
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { itemColorProgram, listColorItems } from "../color/blocks.js";
import { decodeFrameRgb24 } from "../color/frames.js";
import { checkRenderedColor, meanDeltaEBetweenFrames } from "../color/render_check.js";
import { initWorkspace, loadSequence, updateSequenceInPlace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";

const TEST_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-crc-"));

let cachedMedia: string | null = null;
/** Static, desaturated-smooth pattern: same picture at every instant, and no 100%-saturated
 * patches whose 4:2:0 error the grade would amplify (fully saturated charts sit above the
 * 0.6-1.5 camera-footage floor even when the pipeline is correct). */
function ensureMedia(): string {
  if (cachedMedia && fs.existsSync(cachedMedia)) return cachedMedia;
  const out = path.join(TEST_TMP, "crc_src.mp4");
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x360:rate=30",
      "-vf",
      "hue=s=0.4,gblur=sigma=2:steps=2",
      "-t",
      "4",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      out,
    ],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(proc.status, 0, `synthetic media failed: ${proc.stderr}`);
  cachedMedia = out;
  return out;
}

function makeWs(name: string, media?: string): string {
  const wsDir = path.join(TEST_TMP, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media ?? ensureMedia()] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
  updateSequenceInPlace(wsDir, (seq) => {
    seq.spine.clips[0].treatments.color = {
      white_balance: { temp_mired: 40, tint: 0 },
      exposure: { stops: 0.3 },
    };
  });
  return wsDir;
}

/** Encodes one rgb24 frame (repeated to 2 s) to an mp4 standing in for the render. */
function encodeLoopedFrame(wsDir: string, name: string, rgb: Buffer, w: number, h: number): string {
  const repeats = 60;
  const raw = path.join(TEST_TMP, `${name}.raw`);
  const multi = Buffer.alloc(rgb.length * repeats);
  for (let k = 0; k < repeats; k++) rgb.copy(multi, k * rgb.length);
  fs.writeFileSync(raw, multi);
  const out = path.join(wsDir, `${name}.mp4`);
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      `${w}x${h}`,
      "-r",
      "30",
      "-i",
      raw,
      "-vf",
      "scale=out_color_matrix=bt709:out_range=tv",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      out,
    ],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(proc.status, 0, `frame encode failed: ${proc.stderr}`);
  return out;
}

function requireAsset(wsDir: string): string {
  const { sequence } = loadSequence(wsDir);
  const uri = (sequence.library[0] as { uri?: string }).uri ?? "";
  return path.isAbsolute(uri) ? uri : path.join(wsDir, uri);
}

test("identical frames compare to ~0 dE; a red/blue swap compares to >> 3 dE", () => {
  const n = 997 * 3;
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = ((i * 2654435761) % 1000) / 1000;
    a[i] = v;
    b[i] = v;
  }
  assert.ok(meanDeltaEBetweenFrames(a, b) < 1e-6, `identical frames: ${meanDeltaEBetweenFrames(a, b)}`);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i += 3) {
    c[i] = b[i + 2];
    c[i + 1] = b[i + 1];
    c[i + 2] = b[i];
  }
  assert.ok(meanDeltaEBetweenFrames(a, c) > 3, `swapped frames: ${meanDeltaEBetweenFrames(a, c)}`);
});

test("swapped channels in the 'render' raise G512 naming the item", () => {
  const wsDir = makeWs("crc-broken");
  const src = decodeFrameRgb24(requireAsset(wsDir), 1.0, 128);
  const swapped = Buffer.from(src.data);
  for (let i = 0; i < swapped.length; i += 3) {
    const r = swapped[i];
    swapped[i] = swapped[i + 2];
    swapped[i + 2] = r;
  }
  const rendered = encodeLoopedFrame(wsDir, "crc_broken", swapped, src.width, src.height);
  const t0 = Date.now();
  const diags = checkRenderedColor({ workspaceDir: wsDir, renderedFile: rendered });
  const ms = Date.now() - t0;
  assert.ok(ms < 30000, `check took ${ms}ms`);
  const warn = diags.find((d) => d.code === "CUTHOL-G512");
  assert.ok(warn, `expected a G512 WARN, got ${JSON.stringify(diags.map((d) => d.code))}`);
  assert.equal(warn.severity, "WARN");
  assert.ok(warn.subject_id === "sp_01" || warn.what.includes("sp_01"), warn.formatted);
  assert.ok(warn.what.includes("0.6"), warn.formatted);
});

test("a render matching the prediction reports G510 with per-item means", () => {
  const wsDir = makeWs("crc-ok");
  const { sequence } = loadSequence(wsDir);
  const item = listColorItems(sequence).find((c) => c.id === "sp_01")!;
  const { fn } = itemColorProgram(sequence, wsDir, item);
  const src = decodeFrameRgb24(requireAsset(wsDir), 1.0, 128);
  const graded = Buffer.alloc(src.data.length);
  const p: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < src.data.length; i += 3) {
    p[0] = src.data[i] / 255;
    p[1] = src.data[i + 1] / 255;
    p[2] = src.data[i + 2] / 255;
    fn(p);
    graded[i] = Math.round(Math.min(1, Math.max(0, p[0])) * 255);
    graded[i + 1] = Math.round(Math.min(1, Math.max(0, p[1])) * 255);
    graded[i + 2] = Math.round(Math.min(1, Math.max(0, p[2])) * 255);
  }
  const rendered = encodeLoopedFrame(wsDir, "crc_ok", graded, src.width, src.height);
  const t0 = Date.now();
  const diags = checkRenderedColor({ workspaceDir: wsDir, renderedFile: rendered });
  const ms = Date.now() - t0;
  assert.ok(ms < 30000, `check took ${ms}ms`);
  assert.ok(!diags.some((d) => d.severity === "WARN"), `no WARN expected: ${JSON.stringify(diags)}`);
  const info = diags.find((d) => d.code === "CUTHOL-G510");
  assert.ok(info, `expected a G510 INFO, got ${JSON.stringify(diags.map((d) => d.code))}`);
  assert.ok(info.what.includes("sp_01"), info.formatted);
});
