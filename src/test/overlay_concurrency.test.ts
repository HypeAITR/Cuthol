import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import {
  parseHyperFramesPipelineSummary,
  scaffoldHyperFramesComposition,
} from "../compositor/hyperframes_bridge.js";
import { CutholError } from "../core/diagnostics.js";
import {
  resolveHyperFramesWorkers,
  resolveOverlayConcurrency,
} from "../core/env.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import {
  renderSequenceToMp4,
  scanRenderedMp4ForEdgeStrips,
} from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip, setSpineTransition } from "../sequence/spine.js";

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

function createSyntheticVideo(
  outPath: string,
  width = 320,
  height = 180,
  durationSec = 2,
  vf = "null"
): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=s=${width}x${height}:r=30:d=${durationSec}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=330:sample_rate=48000:duration=${durationSec}`,
      "-vf",
      vf,
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
  assert.equal(proc.status, 0, `ffmpeg synthetic video failed: ${proc.stderr}`);
}

test("1. Worker (W) and overlay concurrency (K) defaults/overrides + HyperFrames pipeline summary parser", () => {
  const prevW = process.env.CUTHOL_WORKERS;
  const prevK = process.env.CUTHOL_OVERLAY_CONCURRENCY;
  try {
    delete process.env.CUTHOL_WORKERS;
    delete process.env.CUTHOL_OVERLAY_CONCURRENCY;

    const defaultW = resolveHyperFramesWorkers();
    if (process.platform === "win32" || process.platform === "darwin") {
      assert.equal(defaultW, 1, "Windows/macOS default W should be 1");
    } else {
      assert.ok(defaultW === 1 || defaultW === 2, `Linux default W should be 1 or 2, got ${defaultW}`);
    }

    const defaultK = resolveOverlayConcurrency({ workersPerOverlay: defaultW });
    assert.ok(defaultK >= 1 && defaultK <= 12, `Expected hardware K in [1..12], got ${defaultK}`);
    assert.equal(
      resolveOverlayConcurrency({ workersPerOverlay: defaultW, coldOverlayCount: 2 }),
      Math.min(defaultK, 2)
    );

    process.env.CUTHOL_WORKERS = "4";
    assert.equal(resolveHyperFramesWorkers(), 4);
    assert.equal(resolveHyperFramesWorkers(2), 2);

    process.env.CUTHOL_OVERLAY_CONCURRENCY = "1";
    assert.equal(resolveOverlayConcurrency(), 1);
    process.env.CUTHOL_OVERLAY_CONCURRENCY = "5";
    assert.equal(resolveOverlayConcurrency({ coldOverlayCount: 10 }), 5);
    assert.equal(resolveOverlayConcurrency({ coldOverlayCount: 3 }), 3);
  } finally {
    if (prevW === undefined) delete process.env.CUTHOL_WORKERS;
    else process.env.CUTHOL_WORKERS = prevW;
    if (prevK === undefined) delete process.env.CUTHOL_OVERLAY_CONCURRENCY;
    else process.env.CUTHOL_OVERLAY_CONCURRENCY = prevK;
  }

  const parsedStream = parseHyperFramesPipelineSummary(
    "\u001b[32m◇\u001b[39m  out.mov\n   4.2 MB · 2.0s video · rendered in 8.4s\n   \u001b[2mscreenshot capture · hardware gpu · compile 0.1s · probe 0.4s · setup 0.5s · capture 7.9s · encode (during capture) 7.8s\u001b[22m\n"
  );
  assert.equal(parsedStream.capture_mode, "screenshot");
  assert.equal(parsedStream.gpu_mode, "hardware");
  assert.equal(parsedStream.streaming_encode, true);
  assert.deepEqual(parsedStream.stages_sec, {
    compile: 0.1,
    probe: 0.4,
    setup: 0.5,
    capture: 7.9,
    encode: 7.8,
  });
  assert.ok(parsedStream.hf_summary?.includes("screenshot capture · hardware gpu"));

  const parsedSeparate = parseHyperFramesPipelineSummary(
    "   drawelement capture · software gpu · compile 0.2s · capture 1m 2.5s · encode 3.1s\n"
  );
  assert.equal(parsedSeparate.capture_mode, "drawelement");
  assert.equal(parsedSeparate.gpu_mode, "software");
  assert.equal(parsedSeparate.streaming_encode, false);
  assert.deepEqual(parsedSeparate.stages_sec, {
    compile: 0.2,
    capture: 62.5,
    encode: 3.1,
  });
});

test("2. Opaque clip format=rgba bypass for spine and B-roll vs preserved RGBA path for transitions/envelopes/opacity/graphics", () => {
  const tmpDir = makeTempDir("cuthol-rgba-");
  try {
    const wsDir = path.join(tmpDir, "ws");
    initWorkspace({ dir: wsDir, title: "rgba", aspect: "16:9", fps: 30 });

    const vid1 = path.join(tmpDir, "v1.mp4");
    createSyntheticVideo(vid1, 1920, 1080, 1);

    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [vid1] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01" }); // sp_01
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01" }); // sp_02
    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_broll",
      kind: "broll",
      assetHandle: "vid_01",
      atMs: 200,
      durationMs: 600,
    });

    // (a) Opaque, full-frame, untransformed, transition-less, envelope-less -> zero `format=rgba`
    const loaded1 = loadSequence(wsDir);
    const planOpaque = compileSequenceRenderPlan(loaded1.sequence, loaded1.paths, "draft_480p");
    assert.equal(
      planOpaque.filterComplex.includes("format=rgba"),
      false,
      `Expected no format=rgba in opaque untransformed filtergraph, got: ${planOpaque.filterComplex}`
    );

    // (b) Add a dissolve transition between sp_01 and sp_02 -> both sp_01 and sp_02 keep `format=rgba`
    setSpineTransition({
      workspaceDir: wsDir,
      clipId: "sp_01",
      transition: {
        kind: "dissolve",
        duration_ms: 200,
        easing: "ease_in_out",
      },
    });
    const loadedTrans = loadSequence(wsDir);
    const planTrans = compileSequenceRenderPlan(loadedTrans.sequence, loadedTrans.paths, "draft_480p");
    const sp0Chain = planTrans.filterComplex
      .split(";")
      .find((c) => c.endsWith("[v_sp_0]"))!;
    const sp1Chain = planTrans.filterComplex
      .split(";")
      .find((c) => c.endsWith("[v_sp_1]"))!;
    const cueChain = planTrans.filterComplex
      .split(";")
      .find((c) => c.includes("[v_cue_"))!;
    assert.equal(sp0Chain.includes("format=rgba"), true, "sp_01 with outgoing transition must keep format=rgba");
    assert.equal(sp1Chain.includes("format=rgba"), true, "sp_02 with incoming transition must keep format=rgba");
    assert.equal(cueChain.includes("format=rgba"), false, "Opaque full-frame B-roll cue still skips format=rgba");

    // (c) Set opacity < 1 on B-roll cue -> B-roll cue now keeps `format=rgba`
    loadedTrans.sequence.lanes
      .find((l) => l.id === "ln_broll")!
      .cues[0].placement.opacity = 0.75;
    fs.writeFileSync(loadedTrans.paths.sequenceFile, JSON.stringify(loadedTrans.sequence, null, 2), "utf8");
    const loadedOp = loadSequence(wsDir);
    const planOp = compileSequenceRenderPlan(loadedOp.sequence, loadedOp.paths, "draft_480p");
    const cueChainOp = planOp.filterComplex
      .split(";")
      .find((c) => c.includes("[v_cue_"))!;
    assert.equal(cueChainOp.includes("format=rgba"), true, "Semi-transparent B-roll cue must use format=rgba");
  } finally {
    safeRm(tmpDir);
  }
});

test("3. One-pass G506 edge strip scan matches multi-pass decision on clean, right-strip, bottom-strip, and both-strip videos", () => {
  const tmpDir = makeTempDir("cuthol-edge-");
  try {
    const cleanMp4 = path.join(tmpDir, "clean.mp4");
    const rightMp4 = path.join(tmpDir, "right.mp4");
    const bottomMp4 = path.join(tmpDir, "bottom.mp4");
    const bothMp4 = path.join(tmpDir, "both.mp4");

    createSyntheticVideo(cleanMp4, 640, 360, 1.5, "drawbox=x=0:y=0:w=640:h=360:color=0xFFD23F:t=fill");
    createSyntheticVideo(
      rightMp4,
      640,
      360,
      1.5,
      "drawbox=x=0:y=0:w=640:h=360:color=0xFFD23F:t=fill,drawbox=x=632:y=0:w=8:h=360:color=black:t=fill"
    );
    createSyntheticVideo(
      bottomMp4,
      640,
      360,
      1.5,
      "drawbox=x=0:y=0:w=640:h=360:color=0xFFD23F:t=fill,drawbox=x=0:y=352:w=640:h=8:color=black:t=fill"
    );
    createSyntheticVideo(
      bothMp4,
      640,
      360,
      1.5,
      "drawbox=x=0:y=0:w=640:h=360:color=0xFFD23F:t=fill,drawbox=x=632:y=0:w=8:h=360:color=black:t=fill,drawbox=x=0:y=352:w=640:h=8:color=black:t=fill"
    );

    for (const [file, expectedEdges] of [
      [cleanMp4, null],
      [rightMp4, "right"],
      [bottomMp4, "bottom"],
      [bothMp4, "right and bottom"],
    ] as const) {
      delete process.env.CUTHOL_EDGE_SCAN_ONEPASS;
      const onePassDiag = scanRenderedMp4ForEdgeStrips(file, 1500);

      process.env.CUTHOL_EDGE_SCAN_ONEPASS = "0";
      const legacyDiag = scanRenderedMp4ForEdgeStrips(file, 1500);
      delete process.env.CUTHOL_EDGE_SCAN_ONEPASS;

      if (expectedEdges === null) {
        assert.equal(onePassDiag, null);
        assert.equal(legacyDiag, null);
      } else {
        assert.ok(onePassDiag && legacyDiag);
        assert.equal(onePassDiag.code, "CUTHOL-G506");
        assert.equal(onePassDiag.what, legacyDiag.what);
        assert.ok(onePassDiag.what.includes(expectedEdges), `Expected ${expectedEdges} in ${onePassDiag.what}`);
      }
    }
  } finally {
    delete process.env.CUTHOL_EDGE_SCAN_ONEPASS;
    safeRm(tmpDir);
  }
});

test("4. Concurrent overlay pre-pass (K=3), .meta.json HF summary, warm cache, and sibling completion on G503 failure", () => {
  const tmpDir = makeTempDir("cuthol-concurrent-");
  const prevK = process.env.CUTHOL_OVERLAY_CONCURRENCY;
  const prevW = process.env.CUTHOL_WORKERS;
  try {
    process.env.CUTHOL_OVERLAY_CONCURRENCY = "3";
    process.env.CUTHOL_WORKERS = "1";

    const wsDir = path.join(tmpDir, "ws");
    initWorkspace({ dir: wsDir, title: "concurrent", aspect: "16:9", fps: 30 });

    // Use compact 320x180 stage so each composition renders quickly
    const seqPath = path.join(wsDir, "cuthol.sequence.json");
    const seqInit = JSON.parse(fs.readFileSync(seqPath, "utf8"));
    seqInit.stage.width = 320;
    seqInit.stage.height = 180;
    fs.writeFileSync(seqPath, JSON.stringify(seqInit, null, 2), "utf8");

    const spineVid = path.join(tmpDir, "spine.mp4");
    createSyntheticVideo(spineVid, 320, 180, 2);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [spineVid] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01" });

    for (let i = 1; i <= 3; i++) {
      const compDir = path.join(wsDir, "compositions", `c0${i}`);
      scaffoldHyperFramesComposition({
        targetDir: compDir,
        compositionId: "main",
        width: 320,
        height: 180,
        fps: 30,
        durationMs: 500,
        preset: "badge_overlay",
        props: { title: `KART ${i}` },
        transparent: true,
      });
      addLaneCue({
        workspaceDir: wsDir,
        laneId: "ln_motion",
        kind: "composition",
        atMs: (i - 1) * 600,
        durationMs: 500,
        composition: {
          composition_dir: `compositions/c0${i}`,
          entry_html: "index.html",
          props: { title: `KART ${i}` },
          transparent: true,
        },
      });
    }

    const coldRes = renderSequenceToMp4({
      workspaceDir: wsDir,
      preset: "master_1080p",
      outputPath: "output/cold.mp4",
    });
    assert.equal(coldRes.ok, true);
    assert.ok(coldRes.overlays);
    assert.equal(coldRes.overlays.total, 3);
    assert.equal(coldRes.overlays.rendered, 3);
    assert.equal(coldRes.overlays.cached, 0);
    assert.equal(coldRes.overlays.concurrency, 3);
    assert.equal(coldRes.overlays.workers, 1);
    assert.ok(
      coldRes.overlays.capture_modes && Object.keys(coldRes.overlays.capture_modes).length > 0,
      `Expected capture_modes in overlays summary, got: ${JSON.stringify(coldRes.overlays)}`
    );
    assert.equal(typeof coldRes.timings_ms.edge_strip_scan_ms, "number");

    for (const item of coldRes.overlays.rerendered) {
      assert.ok(item.capture_mode, `Expected capture_mode on ${item.composition}`);
      assert.ok(item.hf_summary && item.hf_summary.includes("capture"), `Expected hf_summary on ${item.composition}`);
      assert.ok(item.stages_sec && typeof item.stages_sec.capture === "number");
    }

    const blobsDir = path.join(wsDir, ".cuthol", "blobs");
    const metaFiles = fs.readdirSync(blobsDir).filter((f) => f.startsWith("hf_comp_") && f.endsWith(".meta.json"));
    assert.equal(metaFiles.length, 3);
    for (const mf of metaFiles) {
      const meta = JSON.parse(fs.readFileSync(path.join(blobsDir, mf), "utf8"));
      assert.equal(meta.workers, 1);
      assert.ok(typeof meta.hf_summary === "string" && meta.hf_summary.includes("capture"));
      assert.ok(typeof meta.capture_mode === "string" && meta.capture_mode.length > 0);
    }

    // Warm render hits 3/3 cached overlays and spawns zero HyperFrames renders
    const warmRes = renderSequenceToMp4({
      workspaceDir: wsDir,
      preset: "master_1080p",
      outputPath: "output/warm.mp4",
    });
    assert.equal(warmRes.ok, true);
    assert.equal(warmRes.overlays?.total, 3);
    assert.equal(warmRes.overlays?.cached, 3);
    assert.equal(warmRes.overlays?.rendered, 0);
    assert.ok(warmRes.overlays?.capture_modes);

    // Partial failure test: clear overlay blobs/states, inject runtime error in c02, verify c01 & c03 still finish & cache while c02 raises CUTHOL-G503
    for (const f of fs.readdirSync(blobsDir)) {
      if (f.startsWith("hf_comp_") || f.startsWith("hf_state_")) {
        fs.rmSync(path.join(blobsDir, f), { recursive: true, force: true });
      }
    }
    const c02HtmlPath = path.join(wsDir, "compositions", "c02", "index.html");
    const c02OrigHtml = fs.readFileSync(c02HtmlPath, "utf8");
    const c02BrokenHtml = c02OrigHtml.replace(
      'window.__timelines["main"] = tl;',
      'if (typeof window !== "undefined") { throw new Error("SYNTHETIC_C02_OVERLAY_FAILURE"); }\n      window.__timelines["main"] = tl;'
    );
    fs.writeFileSync(c02HtmlPath, c02BrokenHtml, "utf8");

    assert.throws(
      () =>
        renderSequenceToMp4({
          workspaceDir: wsDir,
          preset: "master_1080p",
          outputPath: "output/broken.mp4",
        }),
      (err: unknown) => {
        assert.ok(err instanceof CutholError);
        assert.equal(err.diagnostic.code, "CUTHOL-G503");
        assert.match(err.diagnostic.what, /c02/);
        return true;
      }
    );

    const remainingAlphaBlobs = fs
      .readdirSync(blobsDir)
      .filter((f) => f.startsWith("hf_comp_") && (f.endsWith(".pngseq") || f.endsWith(".mov")));
    assert.equal(
      remainingAlphaBlobs.length,
      2,
      `Sibling overlays c01 and c03 should have completed and been cached despite c02 failure, found: ${remainingAlphaBlobs.join(", ")}`
    );

    // Restore c02 and run with CUTHOL_OVERLAY_CONCURRENCY=1: c01 & c03 hit cache from the failed run, only c02 renders sequentially
    fs.writeFileSync(c02HtmlPath, c02OrigHtml, "utf8");
    process.env.CUTHOL_OVERLAY_CONCURRENCY = "1";
    const seqRetryRes = renderSequenceToMp4({
      workspaceDir: wsDir,
      preset: "master_1080p",
      outputPath: "output/seq_retry.mp4",
    });
    assert.equal(seqRetryRes.ok, true);
    assert.equal(seqRetryRes.overlays?.total, 3);
    assert.equal(seqRetryRes.overlays?.cached, 2);
    assert.equal(seqRetryRes.overlays?.rendered, 1);
    assert.equal(seqRetryRes.overlays?.concurrency, 1);
    assert.equal(seqRetryRes.overlays?.rerendered[0]?.composition, "c02");
  } finally {
    if (prevK === undefined) delete process.env.CUTHOL_OVERLAY_CONCURRENCY;
    else process.env.CUTHOL_OVERLAY_CONCURRENCY = prevK;
    if (prevW === undefined) delete process.env.CUTHOL_WORKERS;
    else process.env.CUTHOL_WORKERS = prevW;
    safeRm(tmpDir);
  }
});
