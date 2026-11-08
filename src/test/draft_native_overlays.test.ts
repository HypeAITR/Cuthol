// Draft overlay capture can be asked to write the same blob a later master render will use.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./test_setup.js";

import { resolveDraftOverlayRes } from "../compositor/hf_render.js";
import { initWorkspace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { buildCliArgv, findActionSpec } from "../mcp/catalog.js";
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
      "color=c=0x335577:s=320x180:r=30:d=0.6",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=48000:duration=0.6",
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

function writeComp(wsDir: string, name: string, color: string, box: string): void {
  const compDir = path.join(wsDir, "compositions", name);
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
      <div id="box" style="position:absolute;${box};background:${color}"></div>
    </div>
    <script>
      const C = window.__cuthol;
      const tl = gsap.timeline({ paused: true });
      tl.set({}, {}, C.duration);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`;
  fs.writeFileSync(path.join(compDir, "index.html"), html, "utf8");
}

function buildProject(wsDir: string): void {
  initWorkspace({ dir: wsDir, title: "draft-native", aspect: "16:9", fps: 30 });
  const seqPath = path.join(wsDir, "cuthol.sequence.json");
  const seqInit = JSON.parse(fs.readFileSync(seqPath, "utf8"));
  seqInit.stage.width = 320;
  seqInit.stage.height = 180;
  fs.writeFileSync(seqPath, JSON.stringify(seqInit, null, 2), "utf8");

  const clipPath = path.join(path.dirname(wsDir), "clip.mp4");
  if (!fs.existsSync(clipPath)) createSyntheticToneVideo(clipPath);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [clipPath] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 600 });

  writeComp(wsDir, "comp_a", "#E11D48", "left:8px;top:8px;width:80px;height:50px");
  writeComp(wsDir, "comp_b", "#22C55E", "left:120px;top:60px;width:70px;height:70px");
  writeComp(wsDir, "comp_c", "#38BDF8", "left:40px;top:120px;width:200px;height:28px");
  for (const name of ["comp_a", "comp_b", "comp_c"]) {
    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_motion",
      kind: "composition",
      atMs: 0,
      durationMs: 400,
      composition: {
        composition_dir: `compositions/${name}`,
        entry_html: "index.html",
        props: {},
        transparent: true,
      },
    });
  }
}

interface RenderEnvelope {
  ok?: boolean;
  output_path?: string;
  width?: number;
  height?: number;
  overlays?: {
    total?: number;
    cached?: number;
    rendered?: number;
    summary?: string;
    reasons?: Record<string, number>;
  };
}

function runRender(wsDir: string, args: string[]): { ms: number; status: number | null; stdout: string; stderr: string; json: RenderEnvelope | null } {
  const t0 = Date.now();
  const proc = spawnSync(
    process.execPath,
    [CLI, "render", ...args, "--dir", wsDir],
    {
      encoding: "utf8",
      timeout: 240_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CUTHOL_ENCODER: "x264" },
    }
  );
  const stdout = String(proc.stdout ?? "");
  let json: RenderEnvelope | null = null;
  try {
    json = JSON.parse(stdout) as RenderEnvelope;
  } catch {
    json = null;
  }
  return { ms: Date.now() - t0, status: proc.status, stdout, stderr: String(proc.stderr ?? ""), json };
}

function overlayPngSizes(wsDir: string): Array<{ name: string; w: number; h: number }> {
  const dir = path.join(wsDir, ".cuthol", "blobs");
  const names = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("hf_comp_") && name.endsWith(".pngseq"))
    .sort();
  return names.map((name) => {
    const png = path.join(dir, name, "frame_000001.png");
    const buf = fs.readFileSync(png);
    return { name, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  });
}

function frameMd5(filePath: string, stream: "v" | "a"): string[] {
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", filePath, "-map", `0:${stream}:0`, "-f", "framemd5", "-"],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0, `framemd5 ${stream} failed: ${proc.stderr}`);
  return String(proc.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",")[5] ?? "");
}

test("overlay-res flag beats CUTHOL_DRAFT_OVERLAY_RES; MCP passes overlay-res without a leading dash", () => {
  const prev = process.env.CUTHOL_DRAFT_OVERLAY_RES;
  try {
    process.env.CUTHOL_DRAFT_OVERLAY_RES = "native";
    assert.equal(resolveDraftOverlayRes(undefined), "native");
    assert.equal(resolveDraftOverlayRes("draft"), "draft");
    assert.equal(resolveDraftOverlayRes("NATIVE"), "native");
    process.env.CUTHOL_DRAFT_OVERLAY_RES = "draft";
    assert.equal(resolveDraftOverlayRes(undefined), "draft");
    assert.equal(resolveDraftOverlayRes(""), "draft");
    assert.throws(() => resolveDraftOverlayRes("4k"), /overlay-res/);
  } finally {
    if (prev === undefined) delete process.env.CUTHOL_DRAFT_OVERLAY_RES;
    else process.env.CUTHOL_DRAFT_OVERLAY_RES = prev;
  }

  const renderSpec = findActionSpec("render", null);
  assert.ok(renderSpec);
  const overlayParam = renderSpec.params.find((param) => param.name === "overlay_res");
  assert.ok(overlayParam);
  assert.equal(overlayParam.flag, "overlay-res");
  const argv = buildCliArgv(renderSpec, { preset: "draft_480p", overlay_res: "native" }, "/p");
  assert.ok(argv.includes("--overlay-res=native"), argv.join(" "));
  assert.equal(argv.some((arg) => arg.startsWith("----")), false);
});

test("draft --overlay-res native fills the master cache; default draft does not", { timeout: 600_000 }, () => {
  const tmpDir = makeTempDir("cuthol-draft-native-");
  try {
    const wsNative = path.join(tmpDir, "ws-native");
    buildProject(wsNative);
    const wsDefault = path.join(tmpDir, "ws-default");
    const wsCold = path.join(tmpDir, "ws-cold");
    fs.cpSync(wsNative, wsDefault, { recursive: true });
    fs.cpSync(wsNative, wsCold, { recursive: true });

    const nativeDraft = runRender(wsNative, [
      "--preset",
      "draft_480p",
      "--overlay-res",
      "native",
      "--workers",
      "1",
      "--out",
      "output/draft.mp4",
    ]);
    assert.equal(nativeDraft.status, 0, nativeDraft.stdout || nativeDraft.stderr);
    assert.equal(nativeDraft.json?.ok, true, nativeDraft.stdout);
    assert.equal(nativeDraft.json?.overlays?.total, 3, JSON.stringify(nativeDraft.json?.overlays));
    assert.equal(nativeDraft.json?.overlays?.rendered, 3, JSON.stringify(nativeDraft.json?.overlays));
    assert.match(nativeDraft.json?.overlays?.summary ?? "", /native capture for master reuse/);
    assert.equal(nativeDraft.json?.width, 854);
    assert.equal(nativeDraft.json?.height, 480);
    const nativeSizes = overlayPngSizes(wsNative);
    assert.equal(nativeSizes.length, 3, JSON.stringify(nativeSizes));
    for (const size of nativeSizes) {
      assert.equal(size.w, 320, JSON.stringify(size));
      assert.equal(size.h, 180, JSON.stringify(size));
    }
    const blobsAfterDraft = nativeSizes.map((size) => size.name);

    const nativeMaster = runRender(wsNative, [
      "--preset",
      "master_1080p",
      "--workers",
      "1",
      "--out",
      "output/master.mp4",
    ]);
    assert.equal(nativeMaster.status, 0, nativeMaster.stdout || nativeMaster.stderr);
    assert.equal(nativeMaster.json?.overlays?.rendered, 0, JSON.stringify(nativeMaster.json?.overlays));
    assert.equal(nativeMaster.json?.overlays?.cached, 3, JSON.stringify(nativeMaster.json?.overlays));
    assert.match(nativeMaster.json?.overlays?.summary ?? "", /0 rendered/);
    assert.equal(nativeMaster.json?.width, 320);
    assert.equal(nativeMaster.json?.height, 180);
    assert.deepEqual(
      overlayPngSizes(wsNative).map((size) => size.name),
      blobsAfterDraft
    );

    const coldMaster = runRender(wsCold, [
      "--preset",
      "master_1080p",
      "--overlay-res",
      "native",
      "--workers",
      "1",
      "--out",
      "output/cold.mp4",
    ]);
    assert.equal(coldMaster.status, 0, coldMaster.stdout || coldMaster.stderr);
    assert.equal(coldMaster.json?.overlays?.rendered, 3, JSON.stringify(coldMaster.json?.overlays));
    assert.doesNotMatch(coldMaster.json?.overlays?.summary ?? "", /native capture for master reuse/);
    assert.deepEqual(
      frameMd5(nativeMaster.json!.output_path!, "v"),
      frameMd5(coldMaster.json!.output_path!, "v")
    );
    assert.deepEqual(
      frameMd5(nativeMaster.json!.output_path!, "a"),
      frameMd5(coldMaster.json!.output_path!, "a")
    );

    const defaultDraft = runRender(wsDefault, [
      "--preset",
      "draft_480p",
      "--workers",
      "1",
      "--out",
      "output/draft.mp4",
    ]);
    assert.equal(defaultDraft.status, 0, defaultDraft.stdout || defaultDraft.stderr);
    assert.equal(defaultDraft.json?.overlays?.rendered, 3, JSON.stringify(defaultDraft.json?.overlays));
    assert.doesNotMatch(defaultDraft.json?.overlays?.summary ?? "", /native capture for master reuse/);
    const defaultSizes = overlayPngSizes(wsDefault);
    assert.equal(defaultSizes.length, 3, JSON.stringify(defaultSizes));
    for (const size of defaultSizes) {
      assert.equal(size.w, 854, JSON.stringify(size));
      assert.equal(size.h, 480, JSON.stringify(size));
    }

    const defaultMaster = runRender(wsDefault, [
      "--preset",
      "master_1080p",
      "--workers",
      "1",
      "--out",
      "output/master.mp4",
    ]);
    assert.equal(defaultMaster.status, 0, defaultMaster.stdout || defaultMaster.stderr);
    assert.equal(defaultMaster.json?.overlays?.rendered, 3, JSON.stringify(defaultMaster.json?.overlays));
    assert.equal(defaultMaster.json?.overlays?.cached, 0, JSON.stringify(defaultMaster.json?.overlays));

    const nativePairMs = nativeDraft.ms + nativeMaster.ms;
    const defaultPairMs = defaultDraft.ms + defaultMaster.ms;
    console.log(
      `TIMING draft+master default ${defaultPairMs} ms (draft ${defaultDraft.ms} + master ${defaultMaster.ms}); native+master ${nativePairMs} ms (draft ${nativeDraft.ms} + master ${nativeMaster.ms})`
    );
  } finally {
    safeRm(tmpDir);
  }
});

function createPatternStill(outPath: string): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x112233:s=640x360:r=1:d=1",
      "-vf",
      "drawbox=x=40:y=30:w=220:h=90:color=0xE11D48:t=fill,drawbox=x=400:y=200:w=160:h=110:color=0x22C55E:t=fill",
      "-frames:v",
      "1",
      outPath,
    ],
    { encoding: "utf8", timeout: 30_000 }
  );
  assert.equal(proc.status, 0, `ffmpeg still failed: ${proc.stderr}`);
}

function overlayBlobNames(wsDir: string): string[] {
  const dir = path.join(wsDir, ".cuthol", "blobs");
  return fs
    .readdirSync(dir)
    .filter((name) => /^hf_comp_[0-9a-f]+\.(?:mp4|pngseq|mov|ffv1\.mov)$/.test(name))
    .sort();
}

function buildOpaqueBackdropProject(wsDir: string, mediaDir: string): void {
  initWorkspace({ dir: wsDir, title: "draft-native-opaque", aspect: "16:9", fps: 30 });
  const seqPath = path.join(wsDir, "cuthol.sequence.json");
  const seqInit = JSON.parse(fs.readFileSync(seqPath, "utf8"));
  seqInit.stage.width = 320;
  seqInit.stage.height = 180;
  fs.writeFileSync(seqPath, JSON.stringify(seqInit, null, 2), "utf8");

  const stillPath = path.join(mediaDir, "still.png");
  const clipPath = path.join(mediaDir, "clip.mp4");
  if (!fs.existsSync(stillPath)) createPatternStill(stillPath);
  if (!fs.existsSync(clipPath)) createSyntheticToneVideo(clipPath);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [stillPath, clipPath] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "img_01", sourceInMs: 0, sourceOutMs: 400 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 400 });

  writeComp(wsDir, "comp_opaque", "#F8FAFC", "left:12px;top:12px;width:70px;height:36px");
  writeComp(wsDir, "comp_alpha", "#38BDF8", "left:180px;top:90px;width:90px;height:40px");
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 0,
    durationMs: 400,
    composition: {
      composition_dir: "compositions/comp_opaque",
      entry_html: "index.html",
      props: {},
      transparent: true,
    },
  });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 400,
    durationMs: 400,
    composition: {
      composition_dir: "compositions/comp_alpha",
      entry_html: "index.html",
      props: {},
      transparent: true,
    },
  });
}

test("draft --overlay-res native bakes the master still so opaque blob names match a cold master", { timeout: 600_000 }, () => {
  const tmpDir = makeTempDir("cuthol-draft-native-opaque-");
  try {
    const mediaDir = path.join(tmpDir, "media");
    fs.mkdirSync(mediaDir, { recursive: true });
    const wsNative = path.join(tmpDir, "ws-native");
    buildOpaqueBackdropProject(wsNative, mediaDir);
    const wsCold = path.join(tmpDir, "ws-cold");
    fs.cpSync(wsNative, wsCold, { recursive: true });

    const nativeDraft = runRender(wsNative, [
      "--preset",
      "draft_480p",
      "--overlay-res",
      "native",
      "--workers",
      "1",
      "--out",
      "output/draft.mp4",
    ]);
    assert.equal(nativeDraft.status, 0, nativeDraft.stdout || nativeDraft.stderr);
    assert.equal(nativeDraft.json?.ok, true, nativeDraft.stdout);
    assert.equal(nativeDraft.json?.overlays?.rendered, 2, JSON.stringify(nativeDraft.json?.overlays));
    assert.match(nativeDraft.json?.overlays?.summary ?? "", /native capture for master reuse/);

    const nativeMaster = runRender(wsNative, [
      "--preset",
      "master_1080p",
      "--workers",
      "1",
      "--out",
      "output/master.mp4",
    ]);
    assert.equal(nativeMaster.status, 0, nativeMaster.stdout || nativeMaster.stderr);
    assert.equal(nativeMaster.json?.overlays?.rendered, 0, JSON.stringify(nativeMaster.json?.overlays));
    assert.equal(nativeMaster.json?.overlays?.cached, 2, JSON.stringify(nativeMaster.json?.overlays));
    assert.match(nativeMaster.json?.overlays?.summary ?? "", /0 rendered/);

    const coldMaster = runRender(wsCold, [
      "--preset",
      "master_1080p",
      "--workers",
      "1",
      "--out",
      "output/cold.mp4",
    ]);
    assert.equal(coldMaster.status, 0, coldMaster.stdout || coldMaster.stderr);
    assert.equal(coldMaster.json?.overlays?.rendered, 2, JSON.stringify(coldMaster.json?.overlays));

    const nativeNames = overlayBlobNames(wsNative);
    const coldNames = overlayBlobNames(wsCold);
    assert.equal(nativeNames.filter((name) => name.endsWith(".mp4")).length, 1, JSON.stringify(nativeNames));
    assert.equal(nativeNames.filter((name) => name.endsWith(".pngseq")).length, 1, JSON.stringify(nativeNames));
    assert.deepEqual(nativeNames, coldNames);
    assert.deepEqual(
      frameMd5(nativeMaster.json!.output_path!, "v"),
      frameMd5(coldMaster.json!.output_path!, "v")
    );
  } finally {
    safeRm(tmpDir);
  }
});
