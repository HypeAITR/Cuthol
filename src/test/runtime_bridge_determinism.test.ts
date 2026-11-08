/**
 * Verification Suite (`src/test/runtime_bridge_determinism.test.ts`):
 * - `window.__cuthol` (`cuthol-runtime.js`) 6 core deterministic functions (`word`, `beats`, `audio`, `cuts`, `drive`, `value`)
 * - GSAP `seek()` callback-suppression resilience via setter-proxy tweens across random seek order
 * - Window-local `sliceHash` conditional disk writes (edits outside a composition's window do NOT touch `cuthol-data.js` or invalidate cache)
 * - Recursive composition directory hashing (`hashDirectoryRecursive` covering `assets/`, nested CSS/fonts/sub-compositions)
 * - Live HyperFrames (`npx hyperframes lint` & `snapshot`) execution with `window.__cuthol` + `--variables-file`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import gsap from "gsap";
import {
  exportBridgeDataForCue,
  hashDirectoryRecursive,
  syncCompositionBridgeFiles,
} from "../compositor/bridge_exporter.js";
import {
  CUTHOL_BRIDGE_SCHEMA,
  createCutholRuntime,
  CutholBridgeV1,
  normTurkish,
} from "../compositor/cuthol_runtime.js";
import {
  scaffoldHyperFramesComposition,
  validateHyperFramesCompositionContract,
} from "../compositor/hyperframes_bridge.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { analyzeAssetBeats } from "../library/beats.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { analyzeAssetWaveform } from "../library/waveform.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip, splitSpineClip, trimSpineClip } from "../sequence/spine.js";
import { TranscriptDocument } from "../speech/providers.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/runtime_bridge_determinism_tests");

function createSyntheticTestMedia(dir: string): { clip1Path: string; clip2Path: string } {
  fs.mkdirSync(dir, { recursive: true });
  const clip1Path = path.join(dir, "clip1.mp4");
  const clip2Path = path.join(dir, "clip2.mp4");

  if (!fs.existsSync(clip1Path)) {
    spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=30:duration=5",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=220:sample_rate=16000:duration=5",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        clip1Path,
      ],
      { encoding: "utf8" }
    );
  }
  if (!fs.existsSync(clip2Path)) {
    spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=30:duration=5",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=16000:duration=5",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        clip2Path,
      ],
      { encoding: "utf8" }
    );
  }

  return { clip1Path, clip2Path };
}

test("1. window.__cuthol 6 Core Functions & GSAP seek() Random-Order Determinism", () => {
  // 1a. Plain Turkish character folding (no fragile number-to-word expansion)
  assert.equal(normTurkish("İSTANBUL'da"), "istanbulda");
  assert.equal(normTurkish("IŞIK HIZINDA"), "isik hizinda");
  assert.equal(normTurkish("Çağdaş & Özgür!"), "cagdas ozgur");
  assert.equal(normTurkish("%99,4 başarı."), "%99.4 basari");

  const sampleBridge: CutholBridgeV1 = {
    schema: CUTHOL_BRIDGE_SCHEMA,
    hash: "sha256:1234567890abcdef",
    composition: {
      id: "main",
      cueId: "cue_01",
      duration: 6,
      fps: 30,
      width: 1920,
      height: 1080,
      sequenceStartSec: 2,
    },
    props: { headline: "CUTHOL V2", target: 99.4 },
    words: [
      { t0: -0.15, t1: 0.35, text: "Merhaba", clipped: true },
      { t0: 0.4, t1: 0.9, text: "İstanbul'da" },
      { t0: 1.0, t1: 1.4, text: "yapay" },
      { t0: 1.42, t1: 1.8, text: "zeka" },
      { t0: 2.1, t1: 2.75, text: "doksan" },
      { t0: 2.76, t1: 3.3, text: "dokuz" },
      { t0: 3.5, t1: 4.1, text: "ışık" },
      { t0: 4.12, t1: 4.7, text: "hızında" },
    ],
    beats: {
      bpm: 120,
      times: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0],
      strength: [1.0, 0.5, 0.8, 0.5, 1.0, 0.5, 0.8, 0.5],
      downbeats: [0.5, 2.5],
    },
    audio: {
      fps: 10,
      t0: 0,
      bands: ["low", "mid", "high"],
      low: [0.1, 0.3, 0.9, 0.5, 0.2, 0.1, 0.8, 0.4, 0.2, 0.1],
      mid: [0.2, 0.4, 0.6, 0.8, 0.4, 0.2, 0.5, 0.7, 0.3, 0.2],
      high: [0.05, 0.1, 0.2, 0.3, 0.1, 0.05, 0.15, 0.25, 0.1, 0.05],
    },
    cuts: [
      { t: 2.0, clipId: "sp_02", kind: "spine_cut" },
      { t: 4.5, clipId: "sp_03", kind: "scene_cut" },
    ],
    safeZone: {
      px: { x: 192, y: 108, w: 1536, h: 864 },
    },
  };

  const C = createCutholRuntime(sampleBridge, { extraVar: "from_hf" });
  assert.equal(C.ok, true);
  assert.equal(C.props.headline, "CUTHOL V2");
  assert.equal(C.props.extraVar, "from_hf");

  // (1) C.word
  const wClipped = C.word("merhaba");
  assert.equal(wClipped.found, true);
  assert.equal(wClipped.start, 0); // clamped from -0.15 to 0
  assert.equal(wClipped.clipped, true);

  const wIst = C.word("İSTANBULDA");
  assert.equal(wIst.found, true);
  assert.equal(wIst.start, 0.4);
  assert.equal(wIst.end, 0.9);

  const wPhrase = C.word("doksan dokuz", { pre: 0.1, post: 0.2 });
  assert.equal(wPhrase.found, true);
  assert.equal(wPhrase.start, 2.0); // 2.1 - 0.1
  assert.equal(wPhrase.end, 3.5); // 3.3 + 0.2
  assert.equal(wPhrase.text, "doksan dokuz");

  const wMissing = C.word("olmayan ifade", { fallback: 1.25 });
  assert.equal(wMissing.found, false);
  assert.equal(wMissing.start, 1.25);
  assert.ok(C.warnings.some((w) => w.includes("olmayan ifade")));

  // (2) C.beats
  const allBeats = C.beats();
  assert.equal(allBeats.length, 8);
  const strongBeats = C.beats({ strong: true, threshold: 0.75 });
  assert.deepEqual(strongBeats, [0.5, 1.5, 2.5, 3.5]);
  const subBeats = C.beats({ from: 0.5, to: 1.6, div: 2 });
  assert.deepEqual(subBeats, [0.5, 0.75, 1.0, 1.25, 1.5]);

  // (3) C.audio
  assert.equal(C.audio("low", 0.2), 0.9);
  assert.equal(C.audio("low", 0.25), 0.7); // midpoint between 0.9 and 0.5
  const smoothed = C.audio("low", 0.2, 0.1);
  assert.ok(smoothed > 0.3 && smoothed < 0.9);

  // (4) C.cuts
  const cutInfo = C.cuts();
  assert.deepEqual(cutInfo.cuts, [2.0, 4.5]);
  assert.equal(cutInfo.segments.length, 3);
  assert.deepEqual(
    cutInfo.segments.map((s) => [s.t0, s.t1]),
    [
      [0, 2.0],
      [2.0, 4.5],
      [4.5, 6.0],
    ]
  );

  // (5) & (6) C.drive & C.value with real GSAP timeline across random seek order
  const tl = gsap.timeline({ paused: true });
  let drivenT = -1;
  let counterVal = -1;

  C.drive(tl, (t) => {
    drivenT = t;
  });
  C.value(
    tl,
    { from: 0, to: 100, at: 1.0, duration: 2.0, ease: "none" },
    (v) => {
      counterVal = v;
    }
  );
  tl.set({}, {}, C.duration);

  const seekSequence = [4.2, 1.5, 5.8, 0.0, 2.0, 1.5, 3.0, 0.5, 2.0];
  for (const targetSec of seekSequence) {
    tl.seek(targetSec); // default suppressEvents = true!
    assert.ok(
      Math.abs(drivenT - targetSec) < 1e-5,
      `Expected C.drive to update at seek(${targetSec}), got ${drivenT}`
    );
    const expectedCounter =
      targetSec <= 1.0 ? 0 : targetSec >= 3.0 ? 100 : ((targetSec - 1.0) / 2.0) * 100;
    assert.ok(
      Math.abs(counterVal - expectedCounter) < 1e-3,
      `Expected C.value at seek(${targetSec}) to be ${expectedCounter}, got ${counterVal}`
    );
  }
});

test("2. Window-Local sliceHash Conditional Writes (Out-of-Window Edit Invariance) & In-Window Cut Update", () => {
  const wsDir = path.join(TEST_ROOT, "ws_slice_invariance");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const mediaDir = path.join(TEST_ROOT, "media");
  const { clip1Path, clip2Path } = createSyntheticTestMedia(mediaDir);

  initWorkspace({ dir: wsDir, title: "Bridge Slice Invariance Test", aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [clip1Path, clip2Path] });
  analyzeAssetWaveform({ workspaceDir: wsDir, handle: "vid_01", bins: 50 });
  analyzeAssetBeats({ workspaceDir: wsDir, handle: "vid_01" });

  // Seed a transcript for vid_01 in the SQLite ledger
  const { paths, sequence: seq0 } = loadSequence(wsDir);
  const vid01 = seq0.library.find((x) => x.handle === "vid_01")!;
  const ledger = new MediaLedger(paths.ledgerFile);
  const fakeDoc: TranscriptDocument = {
    provider: "local",
    model: "test-fixture",
    language: "tr",
    duration_ms: 5000,
    text: "Cuthol kurgu verisi doğrudan animasyona aktarılıyor.",
    words: [
      { word: "Cuthol", punctuated_word: "Cuthol", source_start_ms: 600, source_end_ms: 1100, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "kurgu", punctuated_word: "kurgu", source_start_ms: 1150, source_end_ms: 1600, confidence: 0.98, is_filler: false, is_repetition: false },
      { word: "verisi", punctuated_word: "verisi", source_start_ms: 1650, source_end_ms: 2200, confidence: 0.98, is_filler: false, is_repetition: false },
      { word: "doğrudan", punctuated_word: "doğrudan", source_start_ms: 2300, source_end_ms: 2900, confidence: 0.97, is_filler: false, is_repetition: false },
      { word: "animasyona", punctuated_word: "animasyona", source_start_ms: 2950, source_end_ms: 3600, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "aktarılıyor.", punctuated_word: "aktarılıyor.", source_start_ms: 3650, source_end_ms: 4300, confidence: 0.99, is_filler: false, is_repetition: false },
    ],
    disfluencies: [],
  };
  ledger.setTranscript(vid01.digest_sha256, "local:tr", fakeDoc);
  ledger.close();

  // Append sp_01 (0..5000ms) and sp_02 (5000..10000ms)
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01" });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_02" });

  // Scaffold & mount composition at 500..3500ms (inside sp_01)
  const compDir = path.join(wsDir, "compositions/reactive_card");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    compositionId: "main",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 3000,
    preset: "counter",
    props: { headline: " DOĞRULUK", phrase: "kurgu verisi", target: 99.4 },
    transparent: false,
  });

  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 500,
    durationMs: 3000,
    composition: {
      composition_dir: "compositions/reactive_card",
      entry_html: "index.html",
      props: { headline: "DOĞRULUK", phrase: "kurgu verisi", target: 99.4 },
      transparent: false,
    },
  });

  const dataJsonPath = path.join(compDir, "assets/cuthol-data.json");
  assert.ok(fs.existsSync(dataJsonPath), "Expected cuthol-data.json to be generated on addLaneCue");

  const bridge1 = JSON.parse(fs.readFileSync(dataJsonPath, "utf8")) as CutholBridgeV1;
  assert.equal(bridge1.schema, "cuthol.bridge/1");
  // Verify NO global revision field exists on bridge1
  assert.equal("version" in bridge1, false, "Bridge JSON must not include global sequence revision");
  assert.ok(bridge1.words.length >= 4, "Expected words inside 500..3500ms to be exported");
  // "Cuthol" was at 600..1100ms in sequence -> local 0.1..0.6s relative to cueStart=500ms!
  assert.equal(bridge1.words[0].text, "Cuthol");
  assert.equal(bridge1.words[0].t0, 0.1);
  assert.equal(bridge1.words[0].t1, 0.6);

  // Set a sentinel mtime in the past on cuthol-data.json to verify conditional write skips it
  const pastDate = new Date(Date.now() - 60_000);
  fs.utimesSync(dataJsonPath, pastDate, pastDate);
  const mtimeBeforeOutEdit = fs.statSync(dataJsonPath).mtimeMs;

  // Now trim sp_02 (5000..10000ms -> 5000..7500ms), which is completely OUTSIDE cue_01 [500..3500ms]
  trimSpineClip({
    workspaceDir: wsDir,
    clipId: "sp_02",
    sourceOutMs: 2500,
  });

  const mtimeAfterOutEdit = fs.statSync(dataJsonPath).mtimeMs;
  const bridgeAfterOutEdit = JSON.parse(fs.readFileSync(dataJsonPath, "utf8")) as CutholBridgeV1;
  assert.equal(
    bridgeAfterOutEdit.hash,
    bridge1.hash,
    "Out-of-window spine edit must NOT change composition sliceHash"
  );
  assert.equal(
    mtimeAfterOutEdit,
    mtimeBeforeOutEdit,
    "Out-of-window spine edit must NOT touch cuthol-data.json on disk"
  );

  // Also verify direct syncCompositionBridgeFiles returns updated: false
  const { paths: p2, sequence: seq2 } = loadSequence(wsDir);
  const cueAfterOut = seq2.lanes.find((l) => l.id === "ln_motion")!.cues[0];
  const syncRes = syncCompositionBridgeFiles(seq2, cueAfterOut, p2)!;
  assert.equal(syncRes.updated, false, "Expected conditional write to return updated: false");

  // Now perform an IN-WINDOW edit: split sp_01 at 2000ms sequence time (which is 1.5s inside cue_01)
  splitSpineClip({
    workspaceDir: wsDir,
    clipId: "sp_01",
    splitPointsMs: [2000],
    isSequenceTime: true,
  });

  const bridgeAfterInEdit = JSON.parse(fs.readFileSync(dataJsonPath, "utf8")) as CutholBridgeV1;
  assert.notEqual(
    bridgeAfterInEdit.hash,
    bridge1.hash,
    "In-window spine split MUST update sliceHash"
  );
  assert.ok(
    bridgeAfterInEdit.cuts?.some((c) => Math.abs(c.t - 1.5) < 0.01),
    "Expected new spine cut at local t=1.5s inside composition bridge data"
  );
});

test("3. Recursive Directory Hashing (hashDirectoryRecursive) & Live HyperFrames lint + snapshot with window.__cuthol", () => {
  const compDir = path.join(TEST_ROOT, "comp_live_hf");
  fs.rmSync(compDir, { recursive: true, force: true });

  scaffoldHyperFramesComposition({
    targetDir: compDir,
    compositionId: "main",
    width: 1280,
    height: 720,
    fps: 30,
    durationMs: 3000,
    preset: "counter",
    props: {
      headline: "AKTİF KULLANICI ARTIŞI",
      phrase: "doksan dokuz",
      target: 99.4,
      accent: "#38BDF8",
    },
    transparent: false,
  });

  // Inject real word timings into assets/cuthol-data.js so "doksan dokuz" is spoken at 0.5..1.2s
  const customBridge: CutholBridgeV1 = {
    schema: CUTHOL_BRIDGE_SCHEMA,
    hash: "sha256:livehf0123456789",
    composition: {
      id: "main",
      cueId: "cue_01",
      duration: 3,
      fps: 30,
      width: 1280,
      height: 720,
      sequenceStartSec: 0,
    },
    props: {
      headline: "AKTİF KULLANICI ARTIŞI",
      phrase: "doksan dokuz",
      target: 99.4,
      accent: "#38BDF8",
    },
    words: [
      { t0: 0.1, t1: 0.45, text: "Oranımız" },
      { t0: 0.5, t1: 0.85, text: "doksan" },
      { t0: 0.86, t1: 1.2, text: "dokuz" },
    ],
    beats: { bpm: 120, times: [0.5, 1.0, 1.5, 2.0, 2.5], strength: [1, 0.5, 0.8, 0.5, 1], downbeats: [0.5, 2.5] },
    audio: { fps: 10, t0: 0, bands: ["low", "mid", "high"], low: [0.5, 0.8], mid: [0.4, 0.6], high: [0.2, 0.3] },
    cuts: [],
    segments: [{ t0: 0, t1: 3, index: 0, duration: 3 }],
    safeZone: { px: { x: 64, y: 36, w: 1152, h: 648 } },
  };
  const jsonStr = JSON.stringify(customBridge, null, 2);
  fs.writeFileSync(path.join(compDir, "assets/cuthol-data.json"), jsonStr, "utf8");
  fs.writeFileSync(
    path.join(compDir, "assets/cuthol-data.js"),
    `window.__CUTHOL_DATA__ = ${jsonStr};\n`,
    "utf8"
  );

  // 3a. Verify contract & live `npx hyperframes lint`
  const lintRes = validateHyperFramesCompositionContract(compDir, "index.html", true);
  assert.equal(
    lintRes.ok,
    true,
    `Expected scaffolded composition with cuthol-data.js & cuthol-runtime.js to pass hyperframes lint: ${lintRes.findings.join("; ")}`
  );

  // 3b. Verify recursive directory hashing detects changes in nested subdirectories (`assets/`, `compositions/`)
  const h1 = hashDirectoryRecursive(compDir);
  fs.mkdirSync(path.join(compDir, "assets/nested"), { recursive: true });
  fs.writeFileSync(path.join(compDir, "assets/nested/extra.css"), ".stat-card { border-width: 6px; }", "utf8");
  const h2 = hashDirectoryRecursive(compDir);
  assert.notEqual(h1, h2, "hashDirectoryRecursive MUST change when a file inside assets/nested/ is added");

  fs.writeFileSync(path.join(compDir, "assets/nested/extra.css"), ".stat-card { border-width: 8px; }", "utf8");
  const h3 = hashDirectoryRecursive(compDir);
  assert.notEqual(h2, h3, "hashDirectoryRecursive MUST change when a file inside assets/nested/ is modified");

  // Ignored directory (`snapshots/`) must NOT change the hash
  fs.mkdirSync(path.join(compDir, "snapshots"), { recursive: true });
  fs.writeFileSync(path.join(compDir, "snapshots/dummy.png"), "ignored", "utf8");
  const h4 = hashDirectoryRecursive(compDir);
  assert.equal(h3, h4, "hashDirectoryRecursive MUST ignore snapshots/ output directory");

  // 3c. Run live `hyperframes snapshot` at t=0.2s (before word "doksan dokuz"), t=0.8s (mid-count), and t=1.8s (after word "doksan dokuz")
  const snapOutDir = path.join(compDir, "snapshots_test");
  const hfBin = path.resolve(process.cwd(), "node_modules/hyperframes/bin/hyperframes.mjs");
  const snapProc = spawnSync(
    process.execPath,
    [hfBin, "snapshot", compDir, "--at", "0.2,0.8,1.8", "--no-end", "--describe", "false", "--output", snapOutDir],
    { encoding: "utf8", timeout: 60_000 }
  );
  assert.equal(
    snapProc.status,
    0,
    `Expected hyperframes snapshot to succeed, stderr: ${snapProc.stderr}`
  );
  const snapFiles = fs.readdirSync(snapOutDir).filter((f) => f.endsWith(".png"));
  assert.ok(snapFiles.length >= 3, `Expected >= 3 PNG snapshots in ${snapOutDir}, got: ${snapFiles.join(", ")}`);

  // 3d. Verify beat_cards, audio_glow, and cut_phases reactive archetypes also pass contract + CLI lint
  for (const preset of ["beat_cards", "audio_glow", "cut_phases", "blank"] as const) {
    const pDir = path.join(TEST_ROOT, `comp_preset_${preset}`);
    fs.rmSync(pDir, { recursive: true, force: true });
    scaffoldHyperFramesComposition({
      targetDir: pDir,
      compositionId: "main",
      width: 1280,
      height: 720,
      fps: 30,
      durationMs: 3000,
      preset,
      props: { headline: `TEST ${preset.toUpperCase()}`, subline: "REACTIVE BRIDGE" },
      transparent: false,
    });
    const pCheck = validateHyperFramesCompositionContract(pDir, "index.html", true);
    assert.equal(
      pCheck.ok,
      true,
      `Expected reactive preset '${preset}' to pass hyperframes lint: ${pCheck.findings.join("; ")}`
    );
  }
});
