/**
 * Render progress lines, compact check summary, and overlay miss reasons.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncScalarVarsAndComputeCompositionHash, writeCompositionCacheState } from "../compositor/hf_cache_state.js";
import { resolveCachedCompositionVideoBlob } from "../compositor/hf_blobs.js";
import { initWorkspace } from "../core/workspace.js";
import { formatEnvelopeCompact, stripCutholProgress, tryParseJson } from "../mcp/mcp_format.js";
import { CutholMcpServer } from "../mcp/server.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");

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

function writeStaticComposition(wsDir: string): string {
  const compDir = path.join(wsDir, "compositions", "comp_static");
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  const html = `<!doctype html>
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
</html>`;
  fs.writeFileSync(path.join(compDir, "index.html"), html, "utf8");
  return compDir;
}

function initSmallProject(dir: string): { wsDir: string; compDir: string } {
  const wsDir = path.join(dir, "ws");
  initWorkspace({ dir: wsDir, title: "progress-output", aspect: "16:9", fps: 30 });
  const seqPath = path.join(wsDir, "cuthol.sequence.json");
  const seq = JSON.parse(fs.readFileSync(seqPath, "utf8"));
  seq.stage.width = 320;
  seq.stage.height = 180;
  fs.writeFileSync(seqPath, JSON.stringify(seq, null, 2), "utf8");
  const compDir = writeStaticComposition(wsDir);
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
  return { wsDir, compDir };
}

function lookupMiss(wsDir: string, compDir: string): string {
  const entryPath = path.join(compDir, "index.html");
  const htmlSource = fs.readFileSync(entryPath, "utf8");
  const hashInfo = syncScalarVarsAndComputeCompositionHash({
    absCompDir: compDir,
    entryHtml: "index.html",
    htmlSource,
    width: 320,
    height: 180,
    fps: 30,
    durationMs: 400,
    props: {},
    transparent: true,
    mode: "overlay_alpha",
  });
  const blobsDir = path.join(wsDir, ".cuthol", "blobs");
  fs.mkdirSync(blobsDir, { recursive: true });
  const found = resolveCachedCompositionVideoBlob({
    absCompDir: compDir,
    entryPath,
    blobsDir,
    ext: "pngseq",
    durationMs: 400,
    transparent: true,
    mode: "overlay_alpha",
    hashInfo,
  });
  return found.missReason;
}

function plantForeignBlobAndNewerHtml(wsDir: string, compDir: string): void {
  const blobsDir = path.join(wsDir, ".cuthol", "blobs");
  fs.mkdirSync(blobsDir, { recursive: true });
  fs.writeFileSync(path.join(blobsDir, "hf_comp_zzzzother.mp4"), Buffer.alloc(2048, 1));
  const htmlPath = path.join(compDir, "index.html");
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(htmlPath, later, later);
}

test("compact render text has a Checks line and does not dump every rerendered overlay", () => {
  const rerendered = Array.from({ length: 8 }, (_, i) => ({
    composition: `comp_${i}`,
    reason: "slice_changed",
    elapsed_ms: 1000 + i,
  }));
  const summary = "0/8 cached, 8 rendered (slice_changed=8; comp_0:slice_changed, comp_1:slice_changed, comp_2:slice_changed, comp_3:slice_changed, comp_4:slice_changed +3) in 1.00s";
  const envelope = {
    ok: true,
    command: "render",
    encoder: "h264_nvenc",
    blank_scan: { blank_frames_count: 0, total_frames: 10212, events: [], diagnostics: [] },
    audio_health: { checked_points: 9, points: new Array(9).fill({ ok: true }), issues: [], diagnostics: [] },
    overlays: { total: 8, cached: 0, rendered: 8, reasons: { slice_changed: 8 }, summary, rerendered },
  };
  const { text } = formatEnvelopeCompact({ envelope, command: "render", exitCode: 0 });
  assert.match(text, /Checks: blank 0\/10212 · audio ok \(9 points\) · encoder h264_nvenc/);
  assert.match(text, /comp_0:slice_changed/);
  assert.match(text, /\+3/);
  assert.equal(text.includes("comp_7"), false, text);
});

test("first lookup with no state file is new even when other blobs or a slice flag exist", () => {
  const dir = makeTempDir("cuthol-progress-new-");
  try {
    const foreign = initSmallProject(dir);
    plantForeignBlobAndNewerHtml(foreign.wsDir, foreign.compDir);
    assert.equal(lookupMiss(foreign.wsDir, foreign.compDir), "new");

    const flagged = initSmallProject(path.join(dir, "flagged"));
    const metaPath = path.join(flagged.compDir, "assets", ".cuthol-bridge-meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.lastDataChangeReason = "slice_changed";
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
    plantForeignBlobAndNewerHtml(flagged.wsDir, flagged.compDir);
    assert.equal(lookupMiss(flagged.wsDir, flagged.compDir), "new");
  } finally {
    safeRm(dir);
  }
});

test("missing blob after a saved state is blob_missing, not backdrop_changed", () => {
  const dir = makeTempDir("cuthol-progress-blob-");
  try {
    const { wsDir, compDir } = initSmallProject(dir);
    const entryPath = path.join(compDir, "index.html");
    const htmlSource = fs.readFileSync(entryPath, "utf8");
    const hashInfo = syncScalarVarsAndComputeCompositionHash({
      absCompDir: compDir,
      entryHtml: "index.html",
      htmlSource,
      width: 320,
      height: 180,
      fps: 30,
      durationMs: 400,
      props: {},
      transparent: true,
      mode: "overlay_alpha",
    });
    const blobsDir = path.join(wsDir, ".cuthol", "blobs");
    const missingBlob = path.join(blobsDir, "hf_comp_deleted.pngseq");
    const resKey = `${hashInfo.targetWidth}x${hashInfo.targetHeight}:pngseq`;
    writeCompositionCacheState(blobsDir, compDir, {
      compositionDir: compDir,
      filesHash: hashInfo.filesHash,
      usedSliceHash: hashInfo.usedSliceHash,
      usedGlobalHash: hashInfo.usedGlobalHash,
      propsHash: hashInfo.propsHash,
      durationMs: 400,
      transparent: true,
      mode: "overlay_alpha",
      backdropDigest: hashInfo.backdropDigest,
      cachedBlobs: {
        [resKey]: missingBlob,
        [`${resKey}:${hashInfo.backdropDigest}`]: missingBlob,
      },
    });
    const found = resolveCachedCompositionVideoBlob({
      absCompDir: compDir,
      entryPath,
      blobsDir,
      ext: "pngseq",
      durationMs: 400,
      transparent: true,
      mode: "overlay_alpha",
      hashInfo,
    });
    assert.equal(found.missReason, "blob_missing");
  } finally {
    safeRm(dir);
  }
});

test("progress lines stay off the stderr JSON envelope", () => {
  const envelope = {
    ok: false,
    schema_version: "cuthol.envelope/1",
    diagnostic: { code: "CUTHOL-G101", what: "no such clip" },
  };
  const mixed = `cuthol:progress encode 1/2 eta 4s\n${JSON.stringify(envelope, null, 2)}\n`;
  assert.equal(tryParseJson(mixed), null);
  const stripped = stripCutholProgress(mixed);
  assert.match(stripped.lastLine ?? "", /encode 1\/2/);
  const parsed = tryParseJson(stripped.text);
  assert.equal(parsed?.ok, false);
  assert.equal((parsed?.diagnostic as { code?: string } | undefined)?.code, "CUTHOL-G101");
});

function createColorClip(outPath: string): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x2244aa:s=320x180:r=30:d=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=2",
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
  assert.equal(proc.status, 0, proc.stderr);
}

test("CLI render writes progress lines and keeps stdout JSON; MCP still reads results and errors", { timeout: 180_000 }, async () => {
  const dir = makeTempDir("cuthol-progress-render-");
  try {
    const { wsDir, compDir } = initSmallProject(dir);
    const clipPath = path.join(dir, "clip.mp4");
    createColorClip(clipPath);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [clipPath] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
    plantForeignBlobAndNewerHtml(wsDir, compDir);
    const metaPath = path.join(compDir, "assets", ".cuthol-bridge-meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.lastDataChangeReason = "slice_changed";
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

    const outRel = "output/progress.mp4";
    const proc = spawnSync(
      process.execPath,
      [CLI, "render", "--preset", "master_1080p", "--encoder", "libx264", "--workers", "1", "--out", outRel, "--dir", wsDir],
      { encoding: "utf8", timeout: 150_000 }
    );
    assert.equal(proc.status, 0, proc.stderr || proc.stdout);
    const stderrLines = String(proc.stderr || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const progressLines = stderrLines.filter((line) => line.startsWith("cuthol:progress "));
    assert.ok(progressLines.length >= 1, `stderr:\n${proc.stderr}`);
    assert.match(stderrLines[stderrLines.length - 1], /\d+\/\d+/, proc.stderr);
    const parsed = JSON.parse(String(proc.stdout));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.overlays?.reasons?.new, 1, JSON.stringify(parsed.overlays));
    const compact = formatEnvelopeCompact({ envelope: parsed, command: "render", exitCode: 0 });
    assert.match(compact.text, /Checks: blank \d+\/\d+ · audio ok \(\d+ points\) · encoder \S+/);

    const mcp = new CutholMcpServer();
    const missing = await mcp.callTool("spine", {
      action: "trim",
      dir: wsDir,
      clip: "sp_missing",
      in: "0s",
      out: "1s",
    });
    assert.equal(missing.isError, true);
    assert.equal(missing.envelope?.ok, false);
    assert.match(String(missing.content[0]?.text ?? ""), /CUTHOL-G101/);

    mcp.sentNotifications.length = 0;
    const rendered = await mcp.callTool(
      "render",
      { dir: wsDir, out: "output/progress_mcp.mp4", preset: "master_1080p" },
      { progressToken: "render-1" }
    );
    assert.equal(rendered.isError, false, String(rendered.content[0]?.text ?? ""));
    assert.match(String(rendered.content[0]?.text ?? ""), /Checks: blank \d+\/\d+ · audio ok \(\d+ points\) · encoder \S+/);
    const progressNotes = mcp.sentNotifications.filter((note) => note.method === "notifications/progress");
    assert.ok(progressNotes.length >= 1, JSON.stringify(mcp.sentNotifications));
    assert.match(String(progressNotes[progressNotes.length - 1]?.params?.message ?? ""), /cuthol:progress /);
  } finally {
    safeRm(dir);
  }
});
