/**
 * Long video render speed optimizations:
 * 1. Explicit HyperFrames worker count (`resolveHyperFramesWorkers`, env override, CLI/render option).
 * 2. Opaque MP4 + single-stage remux when no moving footage is underneath a full-frame composition,
 *    preserving `.ass` / upper-layer compositing when upper layers exist, and preserving true alpha
 *    ProRes 4444 `.mov` when moving footage plays underneath.
 * 3. `draft_480p` renders composition overlays at 480p resolution under a separate cache key without
 *    clobbering `master_1080p` full-resolution blobs, while keeping `monitor frame/sheet` equivalence.
 * 4. Hardware `h264_nvenc` final encoding when available, with explicit fallback reporting (`encoder_fallback`)
 *    when NVENC is unavailable or disabled via `CUTHOL_DISABLE_NVENC=1`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveHyperFramesWorkers, resolveVideoEncoderPreference } from "../core/env.js";
import { isNvencHardwareAvailable } from "../compositor/hyperframes_bridge.js";
import { captureMonitorFrame, captureMonitorSheet } from "../monitor/preview.js";
import { renderSequenceToMp4 } from "../render/renderer.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

function cli(
  args: string[],
  envExtra?: Record<string, string>
): { ok: boolean; result: any; raw: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: envExtra ? { ...process.env, ...envExtra } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = `${proc.stdout ?? ""}`;
  let env: any = null;
  try {
    env = JSON.parse(raw);
  } catch {
    // keep raw for assertion messages
  }
  return {
    ok: Boolean(env?.ok),
    result: env?.result ?? env,
    raw: raw.slice(0, 3000) + (proc.stderr ?? "").slice(0, 1000),
  };
}

function probeVideoDimensions(filePath: string): { width: number; height: number } {
  const proc = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr);
  const stream = JSON.parse(proc.stdout).streams?.[0];
  return { width: Number(stream?.width ?? 0), height: Number(stream?.height ?? 0) };
}

function samplePixelRgb(filePath: string, atSec: number, x: number, y: number): [number, number, number] {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      String(atSec),
      "-i",
      filePath,
      "-vf",
      `format=rgb24,crop=1:1:${x}:${y}`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: 4096 }
  );
  assert.equal(proc.status, 0, proc.stderr?.toString("utf8"));
  const buf = proc.stdout as Buffer;
  return [buf[0], buf[1], buf[2]];
}

test("1. Worker count resolution: hardware default, environment override, and explicit option", () => {
  const prevWorkers = process.env.CUTHOL_WORKERS;
  try {
    delete process.env.CUTHOL_WORKERS;
    const hwDefault = resolveHyperFramesWorkers();
    assert.ok(Number.isInteger(hwDefault) && hwDefault >= 1 && hwDefault <= 8);

    process.env.CUTHOL_WORKERS = "5";
    assert.equal(resolveHyperFramesWorkers(), 5);
    assert.equal(resolveHyperFramesWorkers(3), 3);
  } finally {
    if (prevWorkers === undefined) {
      delete process.env.CUTHOL_WORKERS;
    } else {
      process.env.CUTHOL_WORKERS = prevWorkers;
    }
  }
});

test("2. Opaque single-stage fast path without footage, multi-layer composition with titles, and alpha path over moving footage", () => {
  const wsDir = path.join(TEST_ROOT, "stages");
  fs.rmSync(wsDir, { recursive: true, force: true });

  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "1:1", "--fps", "30"]).ok);
  assert.ok(cli(["workspace", "backdrop", "--color", "#FFD23F", "--dir", wsDir]).ok);

  const wavPath = path.join(wsDir, "tone.wav");
  assert.equal(
    spawnSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:sample_rate=48000:duration=1",
      "-ac",
      "2",
      wavPath,
    ]).status,
    0
  );
  assert.ok(cli(["library", "ingest", wavPath, "--dir", wsDir]).ok);
  assert.ok(
    cli([
      "lane",
      "add-cue",
      "--lane",
      "ln_vo",
      "--kind",
      "voiceover",
      "--asset",
      "aud_01",
      "--at",
      "0ms",
      "--duration",
      "1000ms",
      "--dir",
      wsDir,
    ]).ok
  );

  // Create a transparent composition with a centered blue box over transparent background
  const compDir = path.join(wsDir, "compositions", "main");
  assert.ok(
    cli([
      "composition",
      "scaffold",
      "--comp-dir",
      compDir,
      "--preset",
      "blank",
      "--duration",
      "1s",
      "--dir",
      wsDir,
    ]).ok
  );
  const indexHtml = path.join(compDir, "index.html");
  let html = fs.readFileSync(indexHtml, "utf8");
  html = html
    .replace(
      "</style>",
      `  #center-box { position: absolute; left: 340px; top: 340px; width: 400px; height: 400px; background: #2346D8; }\n</style>`
    )
    .replace("</section>", `  <div id="center-box"></div>\n      </section>`);
  fs.writeFileSync(indexHtml, html, "utf8");

  assert.ok(
    cli([
      "lane",
      "add-composition",
      "--lane",
      "ln_motion",
      "--comp-dir",
      compDir,
      "--at",
      "0ms",
      "--duration",
      "1000ms",
      "--dir",
      wsDir,
    ]).ok
  );

  // (a) No footage underneath & no upper visual layer -> opaque .mp4 blob + single_stage: true
  const singleRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "draft_480p",
    outputPath: "output/single_stage.mp4",
    workers: 2,
  });
  assert.equal(singleRes.ok, true);
  assert.equal(singleRes.workers, 2);
  assert.equal(singleRes.single_stage, true);
  assert.equal(singleRes.blank_scan?.blank_frames_count, 0);

  const blobsDir = path.join(wsDir, ".cuthol", "blobs");
  const blobsAfterSingle = fs.readdirSync(blobsDir);
  assert.equal(
    blobsAfterSingle.some((f) => f.startsWith("hf_comp_") && (f.endsWith(".pngseq") || f.endsWith(".mov"))),
    false,
    `Expected no alpha (.pngseq/.mov) blob when no moving footage is underneath, found: ${blobsAfterSingle.join(", ")}`
  );
  assert.equal(
    blobsAfterSingle.some((f) => f.startsWith("hf_comp_") && f.endsWith(".mp4")),
    true,
    "Expected an opaque .mp4 composition blob"
  );

  // Corner pixel (20, 20) shows the yellow stage backdrop (#FFD23F), center (240, 240) shows the blue box (#2346D8)
  const [cr, cg, cb] = samplePixelRgb(singleRes.output_path, 0.5, 20, 20);
  assert.ok(cr > 220 && cg > 180 && cb < 100, `Expected yellow backdrop at corner, got rgb(${cr},${cg},${cb})`);
  const [br, bg, bb] = samplePixelRgb(singleRes.output_path, 0.5, 240, 240);
  assert.ok(br < 80 && bg < 110 && bb > 180, `Expected blue box at center, got rgb(${br},${bg},${bb})`);

  // (b) Add an upper typography title layer -> composition stays opaque .mp4, single_stage becomes false
  assert.ok(
    cli([
      "lane",
      "add-cue",
      "--lane",
      "ln_titles",
      "--kind",
      "title",
      "--text",
      "ÜST KATMAN",
      "--at",
      "0ms",
      "--duration",
      "1000ms",
      "--dir",
      wsDir,
    ]).ok
  );
  const withTitleRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "draft_480p",
    outputPath: "output/with_title.mp4",
    workers: 2,
  });
  assert.equal(withTitleRes.ok, true);
  assert.equal(withTitleRes.single_stage, false);
  const blobsAfterTitle = fs.readdirSync(blobsDir);
  assert.equal(
    blobsAfterTitle.some((f) => f.startsWith("hf_comp_") && (f.endsWith(".pngseq") || f.endsWith(".mov"))),
    false,
    "Composition below title still does not need an alpha (.pngseq/.mov) blob"
  );

  // (c) Add moving video footage on the spine -> alpha png-sequence path is used (`hf_comp_*.pngseq`)
  const redMp4 = path.join(wsDir, "moving_red.mp4");
  assert.equal(
    spawnSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=480x480:r=30:d=1",
      "-vf",
      "drawbox=x=0:y=0:w=480:h=480:color=0xD92626:t=fill",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      redMp4,
    ]).status,
    0
  );
  assert.ok(cli(["library", "ingest", redMp4, "--dir", wsDir]).ok);
  assert.ok(
    cli([
      "spine",
      "append",
      "--asset",
      "vid_01",
      "--in",
      "0ms",
      "--out",
      "1000ms",
      "--dir",
      wsDir,
    ]).ok
  );

  const overFootageRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "draft_480p",
    outputPath: "output/over_footage.mp4",
    workers: 2,
  });
  assert.equal(overFootageRes.ok, true);
  assert.equal(overFootageRes.single_stage, false);
  const blobsAfterFootage = fs.readdirSync(blobsDir);
  const alphaPngSeqBlob = blobsAfterFootage.find(
    (f) => f.startsWith("hf_comp_") && f.endsWith(".pngseq")
  );
  assert.ok(
    alphaPngSeqBlob,
    `Expected alpha .pngseq directory blob when moving footage is underneath, found: ${blobsAfterFootage.join(", ")}`
  );
  const alphaFrames = fs
    .readdirSync(path.join(blobsDir, alphaPngSeqBlob))
    .filter((f) => /^frame_\d+\.png$/i.test(f));
  assert.equal(alphaFrames.length, 30, "Expected 30 PNG frames for 1s @ 30fps alpha overlay");
  // Corner pixel (20, 20) now shows the red moving spine footage, while (240, 310) shows the blue overlay box below the centered title
  const [fr, fg, fb] = samplePixelRgb(overFootageRes.output_path, 0.5, 20, 20);
  assert.ok(fr > 170 && fg < 80 && fb < 80, `Expected red spine footage at corner, got rgb(${fr},${fg},${fb})`);
  const [cbr, cbg, cbb] = samplePixelRgb(overFootageRes.output_path, 0.5, 240, 310);
  assert.ok(cbr < 80 && cbg < 110 && cbb > 180, `Expected blue overlay at (240,310), got rgb(${cbr},${cbg},${cbb})`);
});

test("3. draft_480p renders composition at 480p with separate cache key from master_1080p and preserves monitor equivalence", () => {
  const wsDir = path.join(TEST_ROOT, "resolution_cache");
  fs.rmSync(wsDir, { recursive: true, force: true });

  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "1:1", "--fps", "30"]).ok);
  assert.ok(cli(["workspace", "backdrop", "--color", "#FFD23F", "--dir", wsDir]).ok);

  const compDir = path.join(wsDir, "compositions", "card");
  assert.ok(
    cli([
      "composition",
      "scaffold",
      "--comp-dir",
      compDir,
      "--duration",
      "1s",
      "--dir",
      wsDir,
    ]).ok
  );
  assert.ok(
    cli([
      "lane",
      "add-composition",
      "--lane",
      "ln_motion",
      "--comp-dir",
      compDir,
      "--at",
      "0ms",
      "--duration",
      "1000ms",
      "--dir",
      wsDir,
    ]).ok
  );

  const draftRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "draft_480p",
    outputPath: "output/draft.mp4",
    workers: 2,
  });
  assert.equal(draftRes.width, 480);
  assert.equal(draftRes.height, 480);

  const blobsDir = path.join(wsDir, ".cuthol", "blobs");
  const draftBlobs = fs
    .readdirSync(blobsDir)
    .filter((f) => f.startsWith("hf_comp_") && f.endsWith(".mp4"));
  assert.equal(draftBlobs.length, 1);
  const draftBlobDims = probeVideoDimensions(path.join(blobsDir, draftBlobs[0]));
  assert.deepEqual(draftBlobDims, { width: 480, height: 480 });

  const masterRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "master_1080p",
    outputPath: "output/master.mp4",
    workers: 2,
  });
  assert.equal(masterRes.width, 1080);
  assert.equal(masterRes.height, 1080);

  const allBlobs = fs
    .readdirSync(blobsDir)
    .filter((f) => f.startsWith("hf_comp_") && f.endsWith(".mp4"));
  assert.equal(allBlobs.length, 2, "draft_480p and master_1080p must have distinct blob cache keys");
  const masterBlob = allBlobs.find((f) => f !== draftBlobs[0])!;
  const masterBlobDims = probeVideoDimensions(path.join(blobsDir, masterBlob));
  assert.deepEqual(masterBlobDims, { width: 1080, height: 1080 });
  // Verify the draft blob is still 480x480
  assert.deepEqual(probeVideoDimensions(path.join(blobsDir, draftBlobs[0])), {
    width: 480,
    height: 480,
  });

  // Monitor sheet and frame consistency
  const sheetRes = captureMonitorSheet({
    workspaceDir: wsDir,
    startMs: 200,
    endMs: 800,
    cols: 2,
    rows: 1,
    showBoxes: true,
  });
  assert.equal(sheetRes.ok, true);
  for (const cell of sheetRes.frames) {
    const frameRes = captureMonitorFrame({
      workspaceDir: wsDir,
      atMs: cell.timestamp_ms,
      showBoxes: true,
    });
    assert.equal(frameRes.metrics.luma_mean, cell.luma_mean);
    assert.equal(frameRes.metrics.luma_std, cell.luma_std);
  }
});

test("4. Hardware NVENC selection and explicit libx264 fallback reporting", () => {
  const wsDir = path.join(TEST_ROOT, "nvenc_fallback");
  fs.rmSync(wsDir, { recursive: true, force: true });

  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "16:9", "--fps", "30"]).ok);
  const srcVid = path.join(wsDir, "src.mp4");
  assert.equal(
    spawnSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=640x360:r=30:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      srcVid,
    ]).status,
    0
  );
  assert.ok(cli(["library", "ingest", srcVid, "--dir", wsDir]).ok);
  assert.ok(
    cli(["spine", "append", "--asset", "vid_01", "--in", "0ms", "--out", "1000ms", "--dir", wsDir]).ok
  );

  // Default behavior depends on whether the host has NVENC hardware
  const defaultRender = cli([
    "render",
    "--preset",
    "draft_480p",
    "--out",
    "output/default.mp4",
    "--dir",
    wsDir,
  ]);
  assert.ok(defaultRender.ok, defaultRender.raw);
  if (isNvencHardwareAvailable()) {
    assert.equal(defaultRender.result.encoder, "h264_nvenc");
    assert.equal(defaultRender.result.encoder_fallback, null);
  } else {
    assert.equal(defaultRender.result.encoder, "libx264");
    assert.ok(defaultRender.result.encoder_fallback);
    assert.equal(defaultRender.result.encoder_fallback.from, "h264_nvenc");
    assert.equal(defaultRender.result.encoder_fallback.to, "libx264");
  }

  // Forcing NVENC off via CUTHOL_DISABLE_NVENC=1 always falls back to libx264 and reports it in the result
  const forcedCpu = cli(
    ["render", "--preset", "draft_480p", "--out", "output/forced_cpu.mp4", "--dir", wsDir],
    { CUTHOL_DISABLE_NVENC: "1" }
  );
  assert.ok(forcedCpu.ok, forcedCpu.raw);
  assert.equal(forcedCpu.result.encoder, "libx264");
  assert.ok(forcedCpu.result.encoder_fallback, "Expected encoder_fallback object when NVENC is disabled");
  assert.equal(forcedCpu.result.encoder_fallback.from, "h264_nvenc");
  assert.equal(forcedCpu.result.encoder_fallback.to, "libx264");
  assert.match(forcedCpu.result.encoder_fallback.reason, /CUTHOL_DISABLE_NVENC|libx264/i);
  assert.equal(resolveVideoEncoderPreference("libx264"), "libx264");
});
