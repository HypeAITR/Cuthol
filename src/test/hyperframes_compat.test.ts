import "./test_setup.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  HYPERFRAMES_RENDER_LOCK_CUTHOL_DEFAULT,
  HYPERFRAMES_RENDER_LOCK_ENV_VAR,
  ensureHyperFramesRenderLockDefault,
  hyperFramesProcessEnv,
  readInvokedHyperFramesVersion,
  resolveHyperFramesRenderLockValue,
} from "../compositor/hf_common.js";
import {
  beginOverlayRenderTracking,
  finishOverlayRenderTracking,
  lintHyperFramesComposition,
  parseHyperFramesPipelineSummary,
  parseHyperFramesScriptErrorIsolated,
  renderHyperFramesCompositionToMp4,
  scaffoldHyperFramesComposition,
} from "../compositor/hyperframes_bridge.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { addLaneCue } from "../sequence/lanes.js";
import { verifySequence } from "../verify/gates.js";
import { detectCompositionAudioNotInMix } from "../verify/gates_hf_audio.js";

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

function withLockEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env[HYPERFRAMES_RENDER_LOCK_ENV_VAR];
  try {
    if (value === undefined) delete process.env[HYPERFRAMES_RENDER_LOCK_ENV_VAR];
    else process.env[HYPERFRAMES_RENDER_LOCK_ENV_VAR] = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env[HYPERFRAMES_RENDER_LOCK_ENV_VAR];
    else process.env[HYPERFRAMES_RENDER_LOCK_ENV_VAR] = prev;
  }
}

test("1. render-lock env: unset/blank resolves to the Cuthol default, an explicit user value wins", () => {
  assert.equal(HYPERFRAMES_RENDER_LOCK_ENV_VAR, "HYPERFRAMES_RENDER_LOCK");
  assert.equal(HYPERFRAMES_RENDER_LOCK_CUTHOL_DEFAULT, "off");
  withLockEnv(undefined, () => {
    assert.equal(resolveHyperFramesRenderLockValue(), "off");
    assert.equal(hyperFramesProcessEnv()[HYPERFRAMES_RENDER_LOCK_ENV_VAR], "off");
  });
  withLockEnv("   ", () => {
    assert.equal(resolveHyperFramesRenderLockValue(), "off");
  });
  withLockEnv("1", () => {
    assert.equal(resolveHyperFramesRenderLockValue(), "1");
    assert.equal(hyperFramesProcessEnv()[HYPERFRAMES_RENDER_LOCK_ENV_VAR], "1");
  });
  withLockEnv("0", () => {
    assert.equal(resolveHyperFramesRenderLockValue(), "0");
  });
});

test("2. ensureHyperFramesRenderLockDefault writes the default without clobbering the user", () => {
  withLockEnv(undefined, () => {
    ensureHyperFramesRenderLockDefault();
    assert.equal(process.env[HYPERFRAMES_RENDER_LOCK_ENV_VAR], "off");
  });
  withLockEnv("1", () => {
    ensureHyperFramesRenderLockDefault();
    assert.equal(process.env[HYPERFRAMES_RENDER_LOCK_ENV_VAR], "1");
  });
});

test("3. pipeline summary parser reads real 0.9.15 summary lines (compat pin)", () => {
  const pngseq = parseHyperFramesPipelineSummary(
    "   screenshot capture · hardware gpu · compile 0.3s · extract 0.0s · audio 0.0s · probe 0.0s · setup 0.9s · capture 3.7s · encode 0.0s\n"
  );
  assert.equal(pngseq.capture_mode, "screenshot");
  assert.equal(pngseq.gpu_mode, "hardware");
  assert.equal(pngseq.streaming_encode, false);
  assert.deepEqual(pngseq.stages_sec, {
    compile: 0.3,
    extract: 0.0,
    audio: 0.0,
    probe: 0.0,
    setup: 0.9,
    capture: 3.7,
    encode: 0.0,
  });
  const streaming = parseHyperFramesPipelineSummary(
    "",
    "   drawelement capture · hardware gpu · compile 0.2s · extract 0.0s · audio 0.0s · probe 0.0s · setup 0.9s · capture 53.5s · encode (during capture) 53.5s · assemble 0.1s\n"
  );
  assert.equal(streaming.capture_mode, "drawelement");
  assert.equal(streaming.streaming_encode, true);
  assert.equal(streaming.stages_sec.capture, 53.5);
  assert.equal(streaming.stages_sec.encode, 53.5);
  assert.equal(streaming.stages_sec.assemble, 0.1);
});

const TWOSUB_STDERR = [
  "[Browser:ERROR] [HyperFrames] composition script error: bad Error: SYNTHETIC_BAD_SUBCOMPOSITION_FAILURE",
  "[FrameCapture:script_error_isolated] A composition script failed, so its animation was skipped and the render went on: bad-slot (runtime-error:bad Error: SYNTHETIC_BAD_SUBCOMPOSITION_FAILURE). {",
  "  sources: [ 'runtime-error:bad Error: SYNTHETIC_BAD_SUBCOMPOSITION_FAILURE' ],",
  "  pendingCompositionIds: [ 'bad' ],",
  '  [WARN] Render completed capture with correctness warnings {"strictness":"best-effort","warningCodes":["script_error_isolated"]}',
  "  [script_error_isolated] A composition script failed, so its animation was skipped and the render went on: bad-slot (runtime-error:bad Error: SYNTHETIC_BAD_SUBCOMPOSITION_FAILURE).",
].join("\n");

test("4. script_error_isolated parser: isolated warning, raw page signal, dedupe, healthy silence", () => {
  const both = parseHyperFramesScriptErrorIsolated("", TWOSUB_STDERR);
  assert.equal(both.length, 1);
  assert.equal(both[0].element, "bad-slot");
  assert.equal(both[0].composition_id, "bad");
  assert.match(both[0].error, /SYNTHETIC_BAD_SUBCOMPOSITION_FAILURE/);

  const rawOnly = parseHyperFramesScriptErrorIsolated(
    "",
    "[Browser:ERROR] [HyperFrames] composition script error: bad Error: SYNTHETIC_BAD_SUBCOMPOSITION_FAILURE\n"
  );
  assert.equal(rawOnly.length, 1);
  assert.equal(rawOnly[0].composition_id, "bad");
  assert.match(rawOnly[0].error, /SYNTHETIC_BAD_SUBCOMPOSITION_FAILURE/);

  const healthy = parseHyperFramesScriptErrorIsolated(
    "   screenshot capture · hardware gpu · compile 0.3s · capture 3.7s · encode 0.0s\n",
    "[initSession:screenshot] pollSubCompositionTimelines complete (ready) (632ms)\n[INFO] [Render] drawElement self-verify passed\n"
  );
  assert.deepEqual(healthy, []);
});

test("5. G415/G416 diagnostic shapes", () => {
  const d = DIAGNOSTICS.SCRIPT_ERROR_ISOLATED("c02", "bad-slot", "bad", "Error: X");
  assert.equal(d.code, "CUTHOL-G415");
  assert.equal(d.gate, "G4_STAGE");
  assert.equal(d.severity, "WARN");
  assert.match(d.what, /bad-slot/);
  assert.match(d.what, /bad/);
  assert.match(d.what, /Error: X/);
  assert.match(d.suggestion, /cuthol render/);
  const same = DIAGNOSTICS.SCRIPT_ERROR_ISOLATED("c02", "bad", "bad", "Error: X");
  assert.doesNotMatch(same.what, /sub-composition/);
  const a = DIAGNOSTICS.COMPOSITION_AUDIO_SILENT("cue_01", "audible <audio> in index.html");
  assert.equal(a.code, "CUTHOL-G416");
  assert.equal(a.gate, "G4_STAGE");
  assert.equal(a.severity, "WARN");
  assert.match(a.suggestion, /ln_sfx/);
});

function writeAudioCompFixture(dir: string, indexHtml: string, extraFiles: Record<string, string> = {}): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), indexHtml, "utf8");
  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
}

function compHtmlWith(bodyInner: string): string {
  return `<!doctype html>
<html>
<head><meta charset="UTF-8" /></head>
<body>
<div id="root" data-composition-id="main" data-width="320" data-height="180" data-fps="30" data-duration="1">
${bodyInner}
</div>
<script src="assets/gsap.min.js"></script>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  tl.set({}, {}, 1);
  window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
}

function createSyntheticMp4(outPath: string, withAudio: boolean): void {
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=1",
  ];
  if (withAudio) {
    args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=1");
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-shortest",
    ...(withAudio ? ["-c:a", "aac"] : ["-an"]),
    outPath
  );
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 60_000 });
  assert.equal(proc.status, 0, `ffmpeg fixture failed: ${proc.stderr}`);
}

test("6. G416 detector: audible markers warn; muted, silent video and sourceless tags stay quiet", () => {
  const tmp = makeTempDir("cuthol-hyperframes_compat-g416-");
  try {
    const audibleMp4 = path.join(tmp, "audible_src.mp4");
    const silentMp4 = path.join(tmp, "silent_src.mp4");
    createSyntheticMp4(audibleMp4, true);
    createSyntheticMp4(silentMp4, false);

    const audible = path.join(tmp, "audible");
    writeAudioCompFixture(
      audible,
      compHtmlWith('  <audio id="tone" src="assets/tone.wav" data-start="0" data-duration="1"></audio>')
    );
    fs.writeFileSync(path.join(audible, "assets/tone.wav"), "RIFF-fake", "utf8");
    assert.equal(detectCompositionAudioNotInMix(audible).length, 1);

    const mutedAudio = path.join(tmp, "muted_audio");
    writeAudioCompFixture(
      mutedAudio,
      compHtmlWith('  <audio src="assets/tone.wav" muted data-start="0" data-duration="1"></audio>')
    );
    assert.deepEqual(detectCompositionAudioNotInMix(mutedAudio), []);

    const noSrc = path.join(tmp, "no_src");
    writeAudioCompFixture(noSrc, compHtmlWith("  <audio data-start=\"0\" data-duration=\"1\"></audio>"));
    assert.deepEqual(detectCompositionAudioNotInMix(noSrc), []);

    const commented = path.join(tmp, "commented");
    writeAudioCompFixture(
      commented,
      compHtmlWith('  <!-- <audio src="assets/tone.wav"></audio> -->')
    );
    assert.deepEqual(detectCompositionAudioNotInMix(commented), []);

    const vidAudible = path.join(tmp, "vid_audible");
    writeAudioCompFixture(
      vidAudible,
      compHtmlWith('  <video class="clip" src="assets/clip.mp4" data-start="0" data-duration="1"></video>')
    );
    fs.copyFileSync(audibleMp4, path.join(vidAudible, "assets/clip.mp4"));
    assert.equal(detectCompositionAudioNotInMix(vidAudible).length, 1);

    const vidSilent = path.join(tmp, "vid_silent");
    writeAudioCompFixture(
      vidSilent,
      compHtmlWith('  <video class="clip" src="assets/clip.mp4" data-start="0" data-duration="1"></video>')
    );
    fs.copyFileSync(silentMp4, path.join(vidSilent, "assets/clip.mp4"));
    assert.deepEqual(detectCompositionAudioNotInMix(vidSilent), []);

    const vidMuted = path.join(tmp, "vid_muted");
    writeAudioCompFixture(
      vidMuted,
      compHtmlWith('  <video src="assets/clip.mp4" muted playsinline data-start="0" data-duration="1"></video>')
    );
    fs.copyFileSync(audibleMp4, path.join(vidMuted, "assets/clip.mp4"));
    assert.deepEqual(detectCompositionAudioNotInMix(vidMuted), []);

    const trickyName = path.join(tmp, "tricky_name");
    writeAudioCompFixture(
      trickyName,
      compHtmlWith('  <video src="assets/muted.mp4" data-start="0" data-duration="1"></video>')
    );
    fs.copyFileSync(audibleMp4, path.join(trickyName, "assets/muted.mp4"));
    assert.equal(detectCompositionAudioNotInMix(trickyName).length, 1);

    const group = path.join(tmp, "group");
    writeAudioCompFixture(group, compHtmlWith("  <hf-audio-group id=\"sfx\"></hf-audio-group>"));
    assert.equal(detectCompositionAudioNotInMix(group).length, 1);

    const jsMarker = path.join(tmp, "js_marker");
    writeAudioCompFixture(jsMarker, compHtmlWith("  <div></div>"), {
      "assets/player.js": "const el = document.createElement('video');\nel.setAttribute('src', 'clip.mp4');\n",
    });
    assert.equal(detectCompositionAudioNotInMix(jsMarker).length, 1);

    const jsNewAudio = path.join(tmp, "js_new_audio");
    writeAudioCompFixture(jsNewAudio, compHtmlWith("  <div></div>"), {
      "assets/sfx.js": "const sfx = new Audio('assets/hit.mp3');\n",
    });
    assert.equal(detectCompositionAudioNotInMix(jsNewAudio).length, 1);

    const jsComment = path.join(tmp, "js_comment");
    writeAudioCompFixture(jsComment, compHtmlWith("  <div></div>"), {
      "assets/notes.js": "// remember: strip <video> tags here\n/* <audio> placeholder */\nconst x = 1;\n",
    });
    assert.deepEqual(detectCompositionAudioNotInMix(jsComment), []);

    const remote = path.join(tmp, "remote");
    writeAudioCompFixture(
      remote,
      compHtmlWith('  <video src="https://example.com/clip.mp4" data-start="0" data-duration="1"></video>')
    );
    assert.equal(detectCompositionAudioNotInMix(remote).length, 1);

    const missingEntry = path.join(tmp, "missing_entry");
    fs.mkdirSync(missingEntry, { recursive: true });
    assert.deepEqual(detectCompositionAudioNotInMix(missingEntry), []);
  } finally {
    safeRm(tmp);
  }
});

test("7. G416 in verify: a composition cue with audio warns; a muted lane stays quiet", () => {
  const tmp = makeTempDir("cuthol-hyperframes_compat-g416v-");
  try {
    const wsDir = path.join(tmp, "ws");
    initWorkspace({ dir: wsDir, title: "g416", aspect: "16:9", fps: 30 });
    const compDir = path.join(wsDir, "compositions", "aud");
    writeAudioCompFixture(
      compDir,
      compHtmlWith('  <audio id="tone" src="assets/tone.wav" data-start="0" data-duration="1"></audio>')
    );
    fs.copyFileSync(GSAP_MIN_JS, path.join(compDir, "assets/gsap.min.js"));
    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_motion",
      kind: "composition",
      atMs: 0,
      durationMs: 1000,
      composition: {
        composition_dir: "compositions/aud",
        entry_html: "index.html",
        props: {},
        transparent: true,
      },
    });
    const loaded = loadSequence(wsDir);
    const rep = verifySequence(loaded.sequence, loaded.paths, ["G4_STAGE"]);
    const found = rep.diagnostics.filter((d) => d.code === "CUTHOL-G416");
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, "WARN");
    assert.match(found[0].what, /cue_/);

    loaded.sequence.lanes.find((l) => l.id === "ln_motion")!.muted = true;
    fs.writeFileSync(loaded.paths.sequenceFile, JSON.stringify(loaded.sequence, null, 2), "utf8");
    const reloaded = loadSequence(wsDir);
    const repMuted = verifySequence(reloaded.sequence, reloaded.paths, ["G4_STAGE"]);
    assert.deepEqual(
      repMuted.diagnostics.filter((d) => d.code === "CUTHOL-G416"),
      []
    );
  } finally {
    safeRm(tmp);
  }
});

const GSAP_MIN_JS = path.resolve("node_modules/gsap/dist/gsap.min.js");

function writeSubcompFixture(root: string, opts: { onlyBad: boolean; noTimelineOnBad: boolean }): string {
  const dir = path.join(root, opts.onlyBad ? "singlebad" : "twosub");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "compositions"), { recursive: true });
  assert.ok(fs.existsSync(GSAP_MIN_JS), `gsap missing at ${GSAP_MIN_JS}`);
  fs.copyFileSync(GSAP_MIN_JS, path.join(dir, "assets/gsap.min.js"));
  const goodSlot = opts.onlyBad
    ? ""
    : '  <div id="good-slot" class="clip" data-composition-id="good" data-composition-src="compositions/good.html" data-start="0" data-duration="1" data-track-index="1" data-width="320" data-height="180"></div>\n';
  const hostHtml = `<!doctype html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
  body, #root { background: transparent; }
  #root { position: relative; width: 100%; height: 100%; overflow: hidden; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-width="320" data-height="180" data-fps="30" data-duration="1">
${goodSlot}  <div id="bad-slot"${opts.noTimelineOnBad ? " data-no-timeline" : ""} class="clip" data-composition-id="bad" data-composition-src="compositions/bad.html" data-start="0" data-duration="1" data-track-index="2" data-width="320" data-height="180"></div>
</div>
<script src="assets/gsap.min.js"></script>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  tl.to({}, { duration: 1 });
  window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
  const goodHtml = `<!doctype html>
<html>
<head><meta charset="UTF-8" /></head>
<body>
<template>
  <style>
    #root { position: absolute; inset: 0; background: transparent; }
    #good-box { position: absolute; left: 10px; top: 10px; width: 100px; height: 40px; background: #22aa55; }
  </style>
  <div id="root" data-composition-id="good" data-width="320" data-height="180">
    <div id="good-box"></div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.fromTo("#good-box", { x: 0 }, { x: 60, duration: 1, ease: "none" });
    window.__timelines["good"] = tl;
  </script>
</template>
</body>
</html>
`;
  const badHtml = `<!doctype html>
<html>
<head><meta charset="UTF-8" /></head>
<body>
<template>
  <style>
    #root { position: absolute; inset: 0; background: transparent; }
    #bad-box { position: absolute; left: 10px; top: 60px; width: 100px; height: 40px; background: #cc2222; }
  </style>
  <div id="root" data-composition-id="bad" data-width="320" data-height="180">
    <div id="bad-box"></div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    throw new Error("SYNTHETIC_BAD_SUBCOMPOSITION_FAILURE");
    const tl = gsap.timeline({ paused: true });
    window.__timelines["bad"] = tl;
  </script>
</template>
</body>
</html>
`;
  fs.writeFileSync(path.join(dir, "index.html"), hostHtml, "utf8");
  if (!opts.onlyBad) {
    fs.writeFileSync(path.join(dir, "compositions/good.html"), goodHtml, "utf8");
  }
  fs.writeFileSync(path.join(dir, "compositions/bad.html"), badHtml, "utf8");
  return dir;
}

function renderFixture(compDir: string, blobsDir: string): string {
  return renderHyperFramesCompositionToMp4({
    compositionDir: compDir,
    entryHtml: "index.html",
    blobsDir,
    width: 320,
    height: 180,
    fps: 30,
    durationMs: 1000,
    props: {},
    transparent: true,
  });
}

test("8. G415 end to end: a failing sub-composition render surfaces script_errors + G415, cached replays too", () => {
  const tmp = makeTempDir("cuthol-hyperframes_compat-g415-");
  try {
    const compDir = writeSubcompFixture(tmp, { onlyBad: false, noTimelineOnBad: true });
    const blobsDir = path.join(tmp, "blobs");
    beginOverlayRenderTracking();
    const blob = renderFixture(compDir, blobsDir);
    const sum = finishOverlayRenderTracking();
    assert.ok(fs.existsSync(blob), "overlay blob rendered despite the failing script");
    assert.ok(sum.script_errors && sum.script_errors.length === 1);
    assert.equal(sum.script_errors[0].composition_id, "bad");
    assert.match(sum.script_errors[0].error, /SYNTHETIC_BAD_SUBCOMPOSITION_FAILURE/);
    assert.ok(sum.diagnostics?.some((d) => d.code === "CUTHOL-G415"));
    assert.match(sum.summary, /script_error_isolated/);

    beginOverlayRenderTracking();
    renderFixture(compDir, blobsDir);
    const warm = finishOverlayRenderTracking();
    assert.equal(warm.cached, 1);
    assert.equal(warm.rendered, 0);
    assert.ok(warm.script_errors && warm.script_errors.length === 1);
    assert.ok(warm.diagnostics?.some((d) => d.code === "CUTHOL-G415"));
  } finally {
    safeRm(tmp);
  }
});

test("9. a lone failing composition still fails through HYPERFRAMES_RENDER_FAILED (CUTHOL-G503)", () => {
  const tmp = makeTempDir("cuthol-hyperframes_compat-g503-");
  try {
    const compDir = writeSubcompFixture(tmp, { onlyBad: true, noTimelineOnBad: false });
    const blobsDir = path.join(tmp, "blobs");
    beginOverlayRenderTracking();
    try {
      assert.throws(
        () => renderFixture(compDir, blobsDir),
        (err: unknown) => {
          assert.ok(err instanceof CutholError);
          assert.equal(err.diagnostic.code, "CUTHOL-G503");
          return true;
        }
      );
    } finally {
      finishOverlayRenderTracking();
    }
  } finally {
    safeRm(tmp);
  }
});

test("10. two renders under the Cuthol default env overlap with no render-slot wait", async () => {
  const tmp = makeTempDir("cuthol-hyperframes_compat-lock-");
  try {
    const hfBin = path.resolve("node_modules/hyperframes/bin/hyperframes.mjs");
    assert.ok(fs.existsSync(hfBin), `hyperframes CLI missing at ${hfBin}`);
    const dirs = [0, 1].map((i) => {
      const d = path.join(tmp, `lock${i}`);
      scaffoldHyperFramesComposition({
        targetDir: d,
        compositionId: "main",
        width: 320,
        height: 180,
        fps: 30,
        durationMs: 500,
        preset: "badge_overlay",
        props: { title: `KART ${i}` },
        transparent: true,
      });
      return d;
    });
    const env = hyperFramesProcessEnv();
    assert.equal(env[HYPERFRAMES_RENDER_LOCK_ENV_VAR], "off");
    const runOne = (dir: string, out: string): Promise<{ start: number; end: number; code: number | null; stderr: string }> =>
      new Promise((resolve) => {
        const start = Date.now();
        let stderr = "";
        const child = spawn(
          process.execPath,
          [hfBin, "render", dir, "--format", "png-sequence", "--quality", "draft", "--workers", "1", "--output", out],
          { env, stdio: ["ignore", "ignore", "pipe"] }
        );
        child.stderr.on("data", (c) => {
          stderr += c.toString("utf8");
        });
        child.on("close", (code) => resolve({ start, end: Date.now(), code, stderr }));
      });
    const [ra, rb] = await Promise.all([
      runOne(dirs[0], path.join(tmp, "out0")),
      runOne(dirs[1], path.join(tmp, "out1")),
    ]);
    assert.equal(ra.code, 0, `render A failed: ${ra.stderr.slice(-400)}`);
    assert.equal(rb.code, 0, `render B failed: ${rb.stderr.slice(-400)}`);
    const overlapMs = Math.min(ra.end, rb.end) - Math.max(ra.start, rb.start);
    assert.ok(overlapMs > 0, `expected overlapping renders, got ${overlapMs}ms`);
    assert.doesNotMatch(ra.stderr, /Waiting for another render/);
    assert.doesNotMatch(rb.stderr, /Waiting for another render/);
  } finally {
    safeRm(tmp);
  }
});

test("11. invoked HyperFrames version is 0.9.15", () => {
  const prev = process.env.CUTHOL_HF_VERSION_OVERRIDE;
  try {
    delete process.env.CUTHOL_HF_VERSION_OVERRIDE;
    assert.equal(readInvokedHyperFramesVersion(), "0.9.15");
  } finally {
    if (prev === undefined) delete process.env.CUTHOL_HF_VERSION_OVERRIDE;
    else process.env.CUTHOL_HF_VERSION_OVERRIDE = prev;
  }
});

test("12. lint JSON shape unchanged on 0.9.15 (compat pin)", () => {
  const tmp = makeTempDir("cuthol-hyperframes_compat-lint-");
  try {
    const compDir = path.join(tmp, "comp");
    scaffoldHyperFramesComposition({
      targetDir: compDir,
      compositionId: "main",
      width: 320,
      height: 180,
      fps: 30,
      durationMs: 500,
      preset: "badge_overlay",
      props: { title: "LINT" },
      transparent: true,
    });
    const res = lintHyperFramesComposition(compDir, "index.html");
    assert.equal(res.ok, true);
    for (const f of [...res.findings, ...res.info_findings]) {
      assert.equal(typeof f.code, "string");
      assert.ok(f.severity === "error" || f.severity === "warning" || f.severity === "info");
      assert.equal(typeof f.message, "string");
    }
  } finally {
    safeRm(tmp);
  }
});
