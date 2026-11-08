/**
 * `monitor sheet` batched single-frame path and frame/sheet consistency.
 *
 * 1. `captureMonitorSheet` captures only the requested cell timestamps via batched `snapshot --at`
 *    into `hf_frame_<hash>_f<idx>.png` without triggering a full-sequence `preview_comp_*.mp4` or
 *    `hf_comp_*.mov` render.
 * 2. Every cell in `captureMonitorSheet` passes through the exact same `renderSingleCompositeFrameRgb24`
 *    and `annotateRgb24BufferToCanvas` pipeline as `captureMonitorFrame`, yielding matching pixels and
 *    identical luma metrics.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { captureMonitorFrame, captureMonitorSheet } from "../monitor/preview.js";
import { loadSequence } from "../core/workspace.js";
import {
  renderMultipleCompositeFramesRgb24,
  renderSingleCompositeFrameRgb24,
} from "../render/renderer.js";
import {
  renderHyperFramesBatchFramesPng,
  renderHyperFramesSingleFramePng,
} from "../compositor/hyperframes_bridge.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

function cli(args: string[]): { ok: boolean; result: any; raw: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
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

function decodePngRegionRgb24(
  pngPath: string,
  crop?: { x: number; y: number; w: number; h: number }
): Buffer {
  const vfArgs = crop ? ["-vf", `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`] : [];
  const proc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      pngPath,
      ...vfArgs,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: 16 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0, proc.stderr?.toString("utf8") || "ffmpeg decode failed");
  return proc.stdout as Buffer;
}

function meanAbsPixelDiff(bufA: Buffer, bufB: Buffer): number {
  assert.equal(bufA.length, bufB.length, "RGB24 buffer lengths must match");
  let sum = 0;
  for (let i = 0; i < bufA.length; i++) {
    sum += Math.abs(bufA[i] - bufB[i]);
  }
  return sum / bufA.length;
}

test("monitor sheet renders only requested cell frames and matches monitor frame pixels", () => {
  const wsDir = path.join(TEST_ROOT, "monitor_sheet");
  fs.rmSync(wsDir, { recursive: true, force: true });

  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "1:1", "--fps", "30"]).ok);
  assert.ok(cli(["workspace", "backdrop", "--color", "#FFD23F", "--dir", wsDir]).ok);

  const compDir = path.join(wsDir, "compositions", "main");
  const scaffold = cli([
    "composition",
    "scaffold",
    "--comp-dir",
    compDir,
    "--duration",
    "6s",
    "--dir",
    wsDir,
  ]);
  assert.ok(scaffold.ok, scaffold.raw);

  // Add a time-dependent animated indicator bar so each cell timestamp is visually distinct
  const indexHtml = path.join(compDir, "index.html");
  const html = fs.readFileSync(indexHtml, "utf8");
  const customHtml = html
    .replace(
      "</style>",
      `  #gap-marker { position: absolute; left: 120px; top: 120px; width: 320px; height: 140px; background: #2346D8; border: 6px solid #111111; }\n</style>`
    )
    .replace(
      "</section>",
      `  <div id="gap-marker"></div>\n    </section>`
    )
    .replace(
      'window.__timelines["main"] = tl;',
      'tl.fromTo("#gap-marker", { x: 0, autoAlpha: 0 }, { x: 400, autoAlpha: 1, duration: 2.0, ease: "none", immediateRender: false }, 1.0);\n      tl.to("#gap-marker", { autoAlpha: 0, duration: 0.2 }, 4.2);\n      window.__timelines["main"] = tl;'
    );
  fs.writeFileSync(indexHtml, customHtml, "utf8");

  const addComp = cli([
    "lane",
    "add-composition",
    "--lane",
    "ln_motion",
    "--comp-dir",
    compDir,
    "--at",
    "0ms",
    "--duration",
    "6000ms",
    "--dir",
    wsDir,
  ]);
  assert.ok(addComp.ok, addComp.raw);

  const sheetRes = captureMonitorSheet({
    workspaceDir: wsDir,
    startMs: 1000,
    endMs: 5000,
    cols: 2,
    rows: 2,
    showBoxes: true,
  });
  assert.equal(sheetRes.ok, true);
  assert.equal(sheetRes.frames.length, 4);

  // Verify that full-sequence preview_comp_*.mp4 or hf_comp_*.mov was NOT generated
  const blobsDir = path.join(wsDir, ".cuthol", "blobs");
  const blobFiles = fs.existsSync(blobsDir) ? fs.readdirSync(blobsDir) : [];
  const fullPreviewBlobs = blobFiles.filter(
    (f) => f.startsWith("preview_comp_") || f.startsWith("hf_comp_")
  );
  assert.deepEqual(
    fullPreviewBlobs,
    [],
    `Expected no full-sequence blobs in .cuthol/blobs, found: ${fullPreviewBlobs.join(", ")}`
  );

  const cachedFramePngs = blobFiles.filter((f) => f.startsWith("hf_frame_") && f.endsWith(".png"));
  assert.equal(
    cachedFramePngs.length,
    4,
    `Expected 4 cached hf_frame_*.png files, found: ${cachedFramePngs.join(", ")}`
  );

  // Compare each cell in the contact sheet against captureMonitorFrame at the same timestamp
  const cellW = 480;
  const cellH = 480;
  const pad = 12;
  const headerH = 44;

  for (let idx = 0; idx < sheetRes.frames.length; idx++) {
    const cellMetrics = sheetRes.frames[idx];
    const frameRes = captureMonitorFrame({
      workspaceDir: wsDir,
      atMs: cellMetrics.timestamp_ms,
      showBoxes: true,
    });
    assert.equal(frameRes.ok, true);
    assert.equal(frameRes.metrics.timestamp_ms, cellMetrics.timestamp_ms);
    assert.equal(frameRes.metrics.luma_mean, cellMetrics.luma_mean);
    assert.equal(frameRes.metrics.luma_std, cellMetrics.luma_std);

    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const dstX = pad + col * (cellW + pad);
    const dstY = headerH + pad + row * (cellH + pad);

    // Exclude the 1px inner overlap of the 2px cell border (`strokeRect(dstX - 1, dstY - 1, cellW + 2, cellH + 2, 2)`)
    const cellRgb = decodePngRegionRgb24(sheetRes.png_path, {
      x: dstX + 1,
      y: dstY + 1,
      w: cellW - 2,
      h: cellH - 2,
    });
    const frameRgb = decodePngRegionRgb24(frameRes.png_path, {
      x: 1,
      y: 1,
      w: cellW - 2,
      h: cellH - 2,
    });
    const diff = meanAbsPixelDiff(cellRgb, frameRgb);
    assert.equal(
      diff,
      0,
      `Expected sheet cell ${idx} (${cellMetrics.timestamp_ms}ms) interior pixels to match monitor frame bit-for-bit, got mean pixel diff ${diff}`
    );
  }

  // Verify parallel `renderMultipleCompositeFramesRgb24` matches sequential `renderSingleCompositeFrameRgb24` bit-for-bit
  const { paths: wsPaths, sequence: wsSeq } = loadSequence(wsDir);
  const sampleTimestamps = sheetRes.frames.map((f) => f.timestamp_ms);
  const parallelFrames = renderMultipleCompositeFramesRgb24(
    wsSeq,
    wsPaths,
    sampleTimestamps,
    "draft_480p"
  );
  assert.equal(parallelFrames.length, sampleTimestamps.length);
  for (let idx = 0; idx < sampleTimestamps.length; idx++) {
    const singleFrame = renderSingleCompositeFrameRgb24(
      wsSeq,
      wsPaths,
      sampleTimestamps[idx],
      "draft_480p"
    );
    assert.equal(
      meanAbsPixelDiff(parallelFrames[idx].rgbBuf, singleFrame.rgbBuf),
      0,
      `Expected parallel cell buffer ${idx} to match sequential single-frame buffer with 0 pixel diff`
    );
  }

  // Verify direct `-ss` seek extraction from cached .mov and .mp4 blobs matches `select='eq(n\,<frameIdx>)'` bit-for-bit
  for (const ext of ["mov", "mp4"] as const) {
    const isTransparent = ext === "mov";
    for (const f of fs.readdirSync(blobsDir)) {
      if (f.startsWith("hf_frame_") || f.startsWith("hf_comp_")) {
        fs.rmSync(path.join(blobsDir, f), { force: true });
      }
    }

    // Probe the canonical hash for this transparency mode using a single frame
    const probe = renderHyperFramesSingleFramePng({
      compositionDir: compDir,
      entryHtml: "index.html",
      blobsDir,
      width: 1080,
      height: 1080,
      fps: 30,
      durationMs: 6000,
      localSec: 0,
      props: {},
      transparent: isTransparent,
      mode: "overlay_alpha",
    });
    const hashMatch = /^hf_frame_([0-9a-f]+)_f\d+\.png$/.exec(path.basename(probe.pngPath));
    assert.ok(hashMatch, `Could not parse hash from ${probe.pngPath}`);
    const compHash = hashMatch[1];
    fs.rmSync(probe.pngPath, { force: true });

    const blobPath = path.join(blobsDir, `hf_comp_${compHash}.${ext}`);
    const codecArgs =
      ext === "mov"
        ? ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"]
        : ["-c:v", "libx264", "-pix_fmt", "yuv420p"];
    const genProc = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x320:r=30:d=6",
        ...codecArgs,
        blobPath,
      ],
      { encoding: "utf8" }
    );
    assert.equal(genProc.status, 0, genProc.stderr);

    const testFrames = [0, 1, 2, 47, 95, 148, 179];
    const batchOut = renderHyperFramesBatchFramesPng({
      compositionDir: compDir,
      entryHtml: "index.html",
      blobsDir,
      width: 1080,
      height: 1080,
      fps: 30,
      durationMs: 6000,
      localSecs: testFrames.map((idx) => idx / 30),
      props: {},
      transparent: isTransparent,
      mode: "overlay_alpha",
    });
    assert.equal(batchOut.length, testFrames.length);

    for (let i = 0; i < testFrames.length; i++) {
      const fIdx = testFrames[i];
      const item = batchOut[i];
      assert.equal(item.frameIdx, fIdx);
      assert.ok(fs.existsSync(item.pngPath));

      const refProc = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          blobPath,
          "-vf",
          `select='eq(n\\,${fIdx})',format=rgba`,
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { maxBuffer: 16 * 1024 * 1024 }
      );
      assert.equal(refProc.status, 0);
      const gotRgb = decodePngRegionRgb24(item.pngPath);
      assert.equal(
        meanAbsPixelDiff(refProc.stdout as Buffer, gotRgb),
        0,
        `Frame ${fIdx} from cached .${ext} must match select='eq(n,${fIdx})' with 0 pixel diff`
      );
    }

    // Also test single-frame path after clearing one frame
    fs.rmSync(batchOut[3].pngPath, { force: true });
    const singleOut = renderHyperFramesSingleFramePng({
      compositionDir: compDir,
      entryHtml: "index.html",
      blobsDir,
      width: 1080,
      height: 1080,
      fps: 30,
      durationMs: 6000,
      localSec: testFrames[3] / 30,
      props: {},
      transparent: isTransparent,
      mode: "overlay_alpha",
    });
    assert.equal(singleOut.frameIdx, testFrames[3]);
    assert.ok(fs.existsSync(singleOut.pngPath));
  }
});
