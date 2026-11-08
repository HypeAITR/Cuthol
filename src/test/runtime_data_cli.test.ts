/**
 *  (`src/test/runtime_data_cli.test.ts`):
 * 1. Full-sequence `C.global` API (`C.global.word`, `C.global.audio`, `C.cueStart`) on `gfx_O`
 *    + local `C.word` / `C.audio` invariance (counter-metric).
 * 2. `cuthol-data.js` size verification on 34.4s `gfx_O` and synthetic 45-minute (6,750 words) edit.
 * 3. Exact `<script>` tag matching in `syncCompositionBridgeFiles` (byte-for-byte preservation of
 *    `<script src="assets/cuthol-runtime.js?x"></script>` and custom user scripts).
 * 4. CLI `--compact` / `--format text` parity with `CutholMcpServer` across edit, verify, and error commands,
 *    while preserving default JSON envelope output.
 * 5. Relative path resolution (CLI `cwd` vs MCP project `dir`) and `CUTHOL-G201` absolute path reporting.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  exportBridgeDataForCue,
  syncAllCompositionBridges,
  syncCompositionBridgeFiles,
} from "../compositor/bridge_exporter.js";
import {
  createCutholRuntime,
  CutholBridgeV1,
  getCutholRuntimeJsSource,
} from "../compositor/cuthol_runtime.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { CutholMcpServer } from "../mcp/server.js";
import { fixturePath, missingFixture } from "./fixtures.js";

const REPO_ROOT = process.cwd();
const CLI_PATH = path.resolve(REPO_ROOT, "dist/cli.js");
const GFX_O_DIR = fixturePath("gfx_O");

test("1. gfx_O: C.global.word finds out-of-window words in seg3, C.global.audio matches across seg2 & seg3, and local C.word/C.audio stay identical", { skip: missingFixture("gfx_O") }, () => {
  const { paths, sequence } = loadSequence(GFX_O_DIR);
  const motionLane = sequence.lanes.find((l) => l.id === "ln_motion")!;
  const cueSeg2 = motionLane.cues.find((c) => c.composition?.composition_dir === "compositions/seg2")!;
  const cueSeg3 = motionLane.cues.find((c) => c.composition?.composition_dir === "compositions/seg3")!;

  // Sync all compositions in gfx_O
  syncAllCompositionBridges(sequence, paths);

  const seg2DataPath = path.join(GFX_O_DIR, "compositions/seg2/assets/cuthol-data.json");
  const seg3DataPath = path.join(GFX_O_DIR, "compositions/seg3/assets/cuthol-data.json");
  const seg3JsPath = path.join(GFX_O_DIR, "compositions/seg3/assets/cuthol-data.js");

  const seg2Bridge = JSON.parse(fs.readFileSync(seg2DataPath, "utf8")) as CutholBridgeV1;
  const seg3Bridge = JSON.parse(fs.readFileSync(seg3DataPath, "utf8")) as CutholBridgeV1;

  // Verify local slice against a bridge stripped of `global` (before/after counter-metric)
  const { global: _strippedGlobal, ...seg3LocalOnly } = seg3Bridge;
  const C_localBefore = createCutholRuntime(seg3LocalOnly);
  const C_seg2 = createCutholRuntime(seg2Bridge);
  const C_seg3 = createCutholRuntime(seg3Bridge);

  // Counter-metric: local C.word and C.audio outputs are bit-for-bit identical before vs after
  assert.deepEqual(C_seg3.word("abd"), C_localBefore.word("abd"));
  assert.deepEqual(C_seg3.word("firkateyni"), C_localBefore.word("firkateyni"));
  assert.deepEqual(C_seg3.word("dohada"), C_localBefore.word("dohada"));
  assert.deepEqual(C_seg3.word("iki yüz"), C_localBefore.word("iki yüz"));
  assert.equal(C_seg3.word("iki yüz").found, false, "Out-of-window word must remain found:false in local C.word");

  for (const localT of [0.0, 1.0, 2.5, 4.0, 6.0, 8.5]) {
    for (const band of ["low", "mid", "high"] as const) {
      assert.equal(
        C_seg3.audio(band, localT, 0.05),
        C_localBefore.audio(band, localT, 0.05),
        `Local C.audio(${band}, ${localT}) must not change`
      );
    }
  }

  // Cue start and global sequence duration on seg3 (starts at 18.0s in a 34.4s sequence)
  assert.equal(C_seg3.cueStart, 18);
  assert.equal(C_seg3.sequenceStartSec, 18);
  assert.equal(C_seg3.sequenceDuration, 34.4);
  assert.equal(C_seg3.global.cueStart, 18);
  assert.equal(C_seg3.global.duration, 34.4);
  assert.equal(C_seg3.toGlobal(2.5), 20.5);
  assert.equal(C_seg3.toLocal(27.656), 9.656);

  // Out-of-window word lookup via C.global.word in seg3
  const wIkiYuz = C_seg3.global.word("iki yüz");
  assert.equal(wIkiYuz.found, true, "C.global.word('iki yüz') must find the word spoken at ~27.66s");
  assert.equal(wIkiYuz.text, "iki yüz");
  assert.ok(wIkiYuz.start > 27.0 && wIkiYuz.start < 28.5);
  assert.equal(wIkiYuz.inWindow, false);
  assert.equal(wIkiYuz.localStart, Number((wIkiYuz.start - 18).toFixed(4)));

  const wKisaca = C_seg3.global.word("kısaca");
  assert.equal(wKisaca.found, true, "C.global.word('kısaca') must find the opening word at 0.08s");
  assert.equal(wKisaca.start, 0.08);
  assert.equal(wKisaca.inWindow, false);

  // Sequence-wide audio normalization: C.global.audio must return identical values in seg2 and seg3 for the same absolute t
  const sampleGlobalTimes = [0.5, 5.0, 9.0, 12.5, 18.0, 21.3, 26.6, 28.0, 33.0];
  for (const absT of sampleGlobalTimes) {
    for (const band of ["low", "mid", "high"] as const) {
      const v2 = C_seg2.global.audio(band, absT, 0.05);
      const v3 = C_seg3.global.audio(band, absT, 0.05);
      assert.equal(
        v2,
        v3,
        `Expected C.global.audio('${band}', ${absT}) to match between seg2 (${v2}) and seg3 (${v3})`
      );
    }
    // Shorthand C.global.audio(t, smoothSec) defaults to "mid"
    assert.equal(
      C_seg2.global.audio(absT, 0.05),
      C_seg3.global.audio(absT, 0.05),
      `Expected shorthand C.global.audio(${absT}) to match between seg2 and seg3`
    );
    assert.equal(C_seg3.global.audio(absT, 0.05), C_seg3.global.audio("mid", absT, 0.05));
  }

  // Also verify browser UMD bundle (`cuthol-data.js` + `cuthol-runtime.js`) in a fresh VM window context
  const sandbox: Record<string, unknown> = { window: {} };
  sandbox.self = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(seg3JsPath, "utf8"), sandbox);
  vm.runInContext(getCutholRuntimeJsSource(), sandbox);
  const winCuthol = (sandbox.window as { __cuthol: ReturnType<typeof createCutholRuntime> }).__cuthol;
  assert.equal(winCuthol.ok, true);
  assert.equal(winCuthol.cueStart, 18);
  assert.deepEqual({ ...winCuthol.global.word("iki yüz") }, wIkiYuz);
  assert.equal(winCuthol.global.audio("mid", 18.0, 0.05), C_seg3.global.audio("mid", 18.0, 0.05));

  // Verify 34.4s cuthol-data.js size is compact (< 25 KB)
  const seg3JsBytes = fs.statSync(seg3JsPath).size;
  assert.ok(seg3JsBytes > 1000 && seg3JsBytes < 25_000, `Expected 34s cuthol-data.js < 25KB, got ${seg3JsBytes}`);
  void cueSeg2;
  void cueSeg3;
});

test("2. Data size on synthetic 45-minute transcript (6,750 words + 3-band audio envelope) stays compact", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-45min-"));
  try {
    initWorkspace({ dir: tmpDir, aspect: "16:9", fps: 30, title: "45 Min Size Test" });
    const { paths, sequence } = loadSequence(tmpDir);
    const durMs = 45 * 60 * 1000; // 2,700,000 ms
    const fakeSha = "b".repeat(64);

    sequence.library.push({
      handle: "vid_01",
      kind: "footage",
      uri: "long.mp4",
      digest_sha256: fakeSha,
      probe: {
        duration_ms: durMs,
        width: 1920,
        height: 1080,
        fps: 30,
        has_video: true,
        has_audio: true,
        video_codec: "h264",
        audio_codec: "aac",
        sample_rate: 48000,
        channels: 2,
        size_bytes: 100_000_000,
      },
      analysis_refs: {},
    });

    sequence.spine.clips.push({
      id: "sp_01",
      asset_handle: "vid_01",
      source_in_ms: 0,
      source_out_ms: durMs,
      timeline_in_ms: 0,
      duration_ms: durMs,
      playback: { rate: 1, preserve_pitch: true, speed_ramp: null },
      placement: {
        x_pct: 0,
        y_pct: 0,
        scale_x: 1,
        scale_y: 1,
        rotation_deg: 0,
        opacity: 1,
        fit_mode: "cover",
        crop: null,
        mirror_x: false,
        mirror_y: false,
      },
      audio_chain: {
        gain_db: 0,
        muted: false,
        fade_in_ms: 0,
        fade_out_ms: 0,
        denoise: { enabled: false, nr_db: 12, noise_floor_db: -50 },
        voice_clarity: { enabled: false, highpass_hz: 80, presence_boost_db: 2.5, compressor_ratio: 3 },
        loudness_target_lufs: null,
        true_peak_ceiling_dbtp: -1,
      },
      treatments: {
        cutout: { mode: "none", chroma_key_hex: null, similarity: 0.15, blend: 0.05, feather_px: 0 },
        mask: null,
        motion_blur: { enabled: false, shutter_deg: 180, subframes: 4 },
        reframe: { enabled: false, mode: "center_lock", focal_points: [] },
        color_grade: { brightness: 0, contrast: 1, saturation: 1, temperature_k: 6500, lut_uri: null },
      },
      transition_out: null,
      envelopes: [],
    });

    const cue = {
      id: "cue_01",
      kind: "composition" as const,
      anchor: null,
      at_ms: 600_000,
      duration_ms: 8000,
      placement: {
        x_pct: 0,
        y_pct: 0,
        scale_x: 1,
        scale_y: 1,
        rotation_deg: 0,
        opacity: 1,
        fit_mode: "cover" as const,
        crop: null,
        mirror_x: false,
        mirror_y: false,
      },
      composition: {
        composition_dir: "compositions/seg",
        entry_html: "index.html",
        props: {},
        transparent: true,
        mode: "overlay_alpha" as const,
      },
      envelopes: [],
    };
    sequence.lanes.find((l) => l.id === "ln_motion")!.cues.push(cue);

    const ledger = new MediaLedger(paths.ledgerFile);
    const vocab = [
      "türkiye",
      "israil",
      "savaş",
      "analiz",
      "ekonomi",
      "strateji",
      "savunma",
      "teknoloji",
      "deniz",
      "hava",
      "radar",
      "sistem",
    ];
    const words = [];
    let cursorMs = 200;
    for (let i = 0; i < 6750; i++) {
      const w = i === 6700 ? "hedefkelime" : vocab[i % vocab.length];
      const start = cursorMs;
      const end = start + 280;
      words.push({
        word: w,
        punctuated_word: w,
        source_start_ms: start,
        source_end_ms: end,
        confidence: 0.98,
        is_filler: false,
        is_repetition: false,
      });
      cursorMs = end + (i % 12 === 11 ? 320 : 100);
    }
    ledger.setTranscript(fakeSha, "local:tr", {
      provider: "local",
      model: "synth",
      language: "tr",
      duration_ms: durMs,
      text: "synthetic 45m",
      words,
      disfluencies: [],
    });

    const bins = [];
    for (let b = 0; b < 1600; b++) {
      const binDur = durMs / 1600;
      bins.push({
        index: b,
        start_ms: Math.round(b * binDur),
        end_ms: Math.round((b + 1) * binDur),
        rms_norm: 0.2 + 0.6 * Math.abs(Math.sin(b * 0.17)),
        peak_norm: 0.9,
        low_energy: 0.3 + 0.5 * Math.abs(Math.cos(b * 0.11)),
        mid_energy: 0.2 + 0.7 * Math.abs(Math.sin(b * 0.23)),
        high_energy: 0.1 + 0.4 * Math.abs(Math.sin(b * 0.31)),
      });
    }
    ledger.setWaveform(fakeSha, 1600, {
      handle: "vid_01",
      sha256: fakeSha,
      duration_ms: durMs,
      sample_rate: 16000,
      bins,
      silences: [],
    });
    ledger.close();

    const bridgeData = exportBridgeDataForCue(sequence, cue, paths);
    const jsPayload = `/* Auto-generated by Cuthol (${bridgeData.hash}) — window-local + global timeline slice */\nwindow.__CUTHOL_DATA__ = ${JSON.stringify(bridgeData)};\n`;
    const byteSize = Buffer.byteLength(jsPayload, "utf8");

    assert.equal(bridgeData.global?.words.length, 6750);
    assert.equal(bridgeData.global?.audio?.fps, 5);
    assert.ok(
      byteSize < 750 * 1024,
      `Expected 45-min cuthol-data.js to stay under 750 KB, got ${byteSize} bytes`
    );

    const C = createCutholRuntime(bridgeData);
    const lateWord = C.global.word("hedefkelime");
    assert.equal(lateWord.found, true);
    assert.ok(lateWord.start > 2500, `Expected 'hedefkelime' past 41 minutes, got ${lateWord.start}s`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("3. syncCompositionBridgeFiles preserves extra user <script> tags (including cuthol-runtime.js?x) byte-for-byte", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-scripts-"));
  try {
    initWorkspace({ dir: tmpDir, aspect: "1:1", fps: 30, title: "Script Tag Preservation" });
    const compDir = path.join(tmpDir, "compositions/custom");
    fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });

    const originalHtml = [
      "<!doctype html>",
      '<html lang="tr">',
      "  <head>",
      '    <meta charset="UTF-8" />',
      '    <script src="assets/gsap.min.js"></script>',
      "    <!-- custom user runtime reference before cuthol-data.js -->",
      '    <script src="assets/cuthol-runtime.js?x"></script>',
      '    <script src="assets/ozet-full.js"></script>',
      '    <script src="assets/cuthol-data.js"></script>',
      '    <script src="assets/cuthol-runtime.js"></script>',
      '    <script data-user="1" src="assets/extra-widget.js"></script>',
      "  </head>",
      "  <body>",
      '    <div id="root" data-composition-id="main" data-width="1080" data-height="1080" data-fps="30" data-duration="5"></div>',
      "  </body>",
      "</html>",
      "",
    ].join("\n");

    const entryHtmlPath = path.join(compDir, "index.html");
    fs.writeFileSync(entryHtmlPath, originalHtml, "utf8");
    const beforeBytes = fs.readFileSync(entryHtmlPath);

    const { paths, sequence } = loadSequence(tmpDir);
    const cue = {
      id: "cue_01",
      kind: "composition" as const,
      anchor: null,
      at_ms: 0,
      duration_ms: 5000,
      placement: {
        x_pct: 0,
        y_pct: 0,
        scale_x: 1,
        scale_y: 1,
        rotation_deg: 0,
        opacity: 1,
        fit_mode: "cover" as const,
        crop: null,
        mirror_x: false,
        mirror_y: false,
      },
      composition: {
        composition_dir: "compositions/custom",
        entry_html: "index.html",
        props: {},
        transparent: true,
        mode: "overlay_alpha" as const,
      },
      envelopes: [],
    };
    sequence.lanes.find((l) => l.id === "ln_motion")!.cues.push(cue);

    syncCompositionBridgeFiles(sequence, cue, paths);
    const afterBytes = fs.readFileSync(entryHtmlPath);

    assert.equal(
      Buffer.compare(beforeBytes, afterBytes),
      0,
      "HTML with <script src=\"assets/cuthol-runtime.js?x\"> and user scripts must be preserved byte-for-byte"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("4. CLI --compact and --format text produce identical output to MCP across edit, verify, and error commands", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-cli-"));
  const tmpDirMcp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-mcp-"));
  try {
    initWorkspace({ dir: tmpDir, aspect: "1:1", fps: 30, title: "Compact Test" });
    initWorkspace({ dir: tmpDirMcp, aspect: "1:1", fps: 30, title: "Compact Test" });

    const bgMp4 = fs.existsSync(path.join(GFX_O_DIR, "media/bg.mp4")) ? path.join(GFX_O_DIR, "media/bg.mp4") : synthBackgroundMp4(tmpDir);
    spawnSync(process.execPath, [CLI_PATH, "library", "ingest", bgMp4, "--dir", tmpDir], { encoding: "utf8" });
    spawnSync(process.execPath, [CLI_PATH, "library", "ingest", bgMp4, "--dir", tmpDirMcp], { encoding: "utf8" });

    const srv = new CutholMcpServer({ defaultDir: tmpDirMcp });

    // (a) Edit command: spine.append
    const cliEdit = spawnSync(
      process.execPath,
      [CLI_PATH, "spine", "append", "--asset", "vid_01", "--in", "0s", "--out", "4s", "--dir", tmpDir, "--compact"],
      { encoding: "utf8" }
    );
    const mcpEdit = await srv.callTool("spine", {
      action: "append",
      asset: "vid_01",
      in: "0s",
      out: "4s",
      dir: tmpDirMcp,
    });
    assert.equal(cliEdit.status, 0);
    assert.equal(cliEdit.stdout.trim(), mcpEdit.content[0].text!.trim());

    // (b) Verify command: --compact and --format text
    const cliVerify = spawnSync(
      process.execPath,
      [CLI_PATH, "verify", "--dir", tmpDir, "--compact"],
      { encoding: "utf8" }
    );
    const cliVerifyFormatText = spawnSync(
      process.execPath,
      [CLI_PATH, "verify", "--dir", tmpDir, "--format", "text"],
      { encoding: "utf8" }
    );
    const mcpVerify = await srv.callTool("verify", { dir: tmpDirMcp });
    assert.equal(cliVerify.status, 0);
    assert.equal(cliVerify.stdout.trim(), mcpVerify.content[0].text!.trim());
    assert.equal(cliVerifyFormatText.stdout.trim(), mcpVerify.content[0].text!.trim());

    // Default CLI output without --compact remains JSON
    const cliVerifyJson = spawnSync(
      process.execPath,
      [CLI_PATH, "verify", "--dir", tmpDir],
      { encoding: "utf8" }
    );
    const parsedDefault = JSON.parse(cliVerifyJson.stdout);
    assert.equal(parsedDefault.schema_version, "cuthol.envelope/1");
    assert.equal(parsedDefault.ok, true);

    // (c) Error command: spine.trim on non-existent clip
    const cliErr = spawnSync(
      process.execPath,
      [CLI_PATH, "spine", "trim", "--clip", "sp_99", "--in", "0s", "--out", "2s", "--dir", tmpDir, "--compact"],
      { encoding: "utf8" }
    );
    const mcpErr = await srv.callTool("spine", {
      action: "trim",
      clip: "sp_99",
      in: "0s",
      out: "2s",
      dir: tmpDirMcp,
    });
    assert.equal(cliErr.status, 1);
    assert.equal(cliErr.stderr.trim(), mcpErr.content[0].text!.trim());
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpDirMcp, { recursive: true, force: true });
  }
});

test("5. Relative paths: CLI resolves against cwd and G201 shows the tried absolute path; MCP resolves against project dir", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-paths-"));
  try {
    initWorkspace({ dir: tmpDir, aspect: "1:1", fps: 30, title: "Path Resolution Test" });
    const mediaSub = path.join(tmpDir, "media");
    fs.mkdirSync(mediaSub, { recursive: true });
    if (fs.existsSync(path.join(GFX_O_DIR, "media/bg.png"))) fs.copyFileSync(path.join(GFX_O_DIR, "media/bg.png"), path.join(mediaSub, "bg.png"));
    else assert.equal(spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x2030c0:size=640x360", "-frames:v", "1", path.join(mediaSub, "bg.png")]).status, 0);

    // Running CLI from REPO_ROOT with relative path `media/bg.png` and `--dir tmpDir` tries `<REPO_ROOT>/media/bg.png`
    // and fails with G201 showing the exact tried absolute path.
    const expectedTriedAbs = path.resolve(REPO_ROOT, "media/bg.png");
    const cliMissing = spawnSync(
      process.execPath,
      [CLI_PATH, "library", "ingest", "media/bg.png", "--dir", tmpDir, "--compact"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    assert.equal(cliMissing.status, 1);
    assert.ok(
      cliMissing.stderr.includes("CUTHOL-G201"),
      `Expected CUTHOL-G201 in stderr, got: ${cliMissing.stderr}`
    );
    assert.ok(
      cliMissing.stderr.includes(expectedTriedAbs),
      `Expected G201 message to include tried absolute path '${expectedTriedAbs}', got: ${cliMissing.stderr}`
    );

    // Running MCP with relative path `media/bg.png` resolves against `tmpDir` (project folder) and succeeds
    const srv = new CutholMcpServer({ defaultDir: tmpDir });
    const mcpIngest = await srv.callTool("library", {
      action: "ingest",
      files: ["media/bg.png"],
      dir: tmpDir,
    });
    assert.equal(mcpIngest.isError, false, `Expected MCP ingest to succeed: ${mcpIngest.content[0]?.text}`);
    assert.ok(mcpIngest.content[0]?.text?.includes("OK library.ingest"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/** Small stand-in for the recorded fixture background when it is not present. */
function synthBackgroundMp4(dir: string): string {
  const out = path.join(dir, "..", `${path.basename(dir)}-bg.mp4`);
  const res = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return out;
}
