/**
 * Beat Grid & Tempo/Phase Locking Tests (`src/test/beats_grid.test.ts`).
 *
 * Verifies:
 * 1. Synthetic click and drum tracks at 90 BPM and 128 BPM with known phase offsets:
 *    - `grid_bpm` within ±1.0 BPM of ground truth
 *    - `phase_ms` within ±20 ms of ground truth
 *    - `grid_ms` covers entire track duration with zero gaps, while `onsets` (with strength) are kept separate
 *    - `formatBeatsDigest` and `queryLibraryAnalysis` expose `grid` and `onsets` separately
 * 2. Real `music.mp3` across sensitivities 1.0, 1.35, and 1.8:
 *    - `grid_bpm` across all 3 sensitivities differs by <= 2%
 *    - `grid_ms` spans the full 39.5s duration with no gaps
 *    - Strong onsets have low median distance to nearest grid beat
 * 3. `window.__cuthol` (`C.beats()` vs `C.beats({ grid: true })` & `C.beatGrid()`):
 *    - Preserves legacy `C.beats()` onset behavior while providing regular grid via `C.beats({ grid: true })` and `C.beatGrid()`
 * 4. `mix.beat_align`:
 *    - Aligns to regular beat grid by default (`align_mode: "grid"`) and supports optional onset alignment (`alignTo: "onsets"` / `--mode onsets`)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { exportBridgeDataForCue } from "../compositor/bridge_exporter.js";
import { createCutholRuntime, getCutholRuntimeJsSource } from "../compositor/cuthol_runtime.js";
import { initWorkspace, loadSequence, stepJournal } from "../core/workspace.js";
import { analyzeAssetBeats } from "../library/beats.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { formatBeatsDigest, queryLibraryAnalysis } from "../library/query.js";
import { alignClipsToBeats } from "../mix/audio_mix.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";
import { TRIAL_MEDIA_DIR } from "./fixtures.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/beats_grid_test");
const TRIAL_MUSIC_MP3 = path.join(TRIAL_MEDIA_DIR, "music.mp3");

function synthesizeClickTrack(filePath: string, bpm: number, phaseMs: number, durationSec: number): void {
  const periodSec = (60 / bpm).toFixed(6);
  const phaseSec = (phaseMs / 1000).toFixed(6);
  const expr = `if(gte(t,${phaseSec}),0.85*exp(-25*mod(t-${phaseSec},${periodSec}))*sin(2*PI*180*t)+0.40*exp(-40*mod(t-${phaseSec},${periodSec}))*sin(2*PI*2200*t),0)`;
  const proc = spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='${expr}':s=16000:d=${durationSec}`,
    "-c:a",
    "pcm_s16le",
    filePath,
  ]);
  assert.equal(proc.status, 0, proc.stderr?.toString());
}

function synthesizeDrumTrack(filePath: string, bpm: number, phaseMs: number, durationSec: number): void {
  const beatSec = 60 / bpm;
  const twoBeatSec = beatSec * 2;
  const eighthSec = beatSec / 2;
  const phaseSec = (phaseMs / 1000).toFixed(6);
  const expr =
    `if(gte(t,${phaseSec}),` +
    `0.85*exp(-22*mod(t-${phaseSec},${twoBeatSec.toFixed(6)}))*sin(2*PI*110*t)` +
    `+0.75*exp(-28*mod(t-${phaseSec}+${beatSec.toFixed(6)},${twoBeatSec.toFixed(6)}))*(0.5*sin(2*PI*280*t)+0.5*sin(2*PI*1900*t))` +
    `+0.18*exp(-45*mod(t-${phaseSec},${eighthSec.toFixed(6)}))*sin(2*PI*5200*t)` +
    `,0)`;
  const proc = spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='${expr}':s=16000:d=${durationSec}`,
    "-c:a",
    "pcm_s16le",
    filePath,
  ]);
  assert.equal(proc.status, 0, proc.stderr?.toString());
}

function circularPhaseDistanceMs(aMs: number, bMs: number, periodMs: number): number {
  const diff = Math.abs(aMs - bMs) % periodMs;
  return Math.min(diff, periodMs - diff);
}

test("1. Synthetic 90 BPM & 128 BPM click and drum tracks: grid BPM within ±1 BPM, phase within ±20 ms, and digest separates grid & onsets", () => {
  const wsDir = path.join(TEST_ROOT, "ws_synthetic");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Synthetic Beat Grid Test", aspect: "16:9", fps: 30 });

  const mediaDir = path.join(wsDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });

  const click90 = path.join(mediaDir, "click_90bpm_p160.wav");
  const click128 = path.join(mediaDir, "click_128bpm_p115.wav");
  const drum90 = path.join(mediaDir, "drum_90bpm_p180.wav");
  const drum128 = path.join(mediaDir, "drum_128bpm_p0.wav");

  synthesizeClickTrack(click90, 90, 160, 10);
  synthesizeClickTrack(click128, 128, 115, 10);
  synthesizeDrumTrack(drum90, 90, 180, 10);
  synthesizeDrumTrack(drum128, 128, 0, 10);

  ingestAssetsIntoWorkspace({
    workspaceDir: wsDir,
    filePaths: [click90, click128, drum90, drum128],
  });

  const cases = [
    { handle: "aud_01", label: "Click 90 BPM @ 160ms", expectedBpm: 90, expectedPhaseMs: 160 },
    { handle: "aud_02", label: "Click 128 BPM @ 115ms", expectedBpm: 128, expectedPhaseMs: 115 },
    { handle: "aud_03", label: "Drum 90 BPM @ 180ms", expectedBpm: 90, expectedPhaseMs: 180 },
    { handle: "aud_04", label: "Drum 128 BPM @ 0ms", expectedBpm: 128, expectedPhaseMs: 0 },
  ];

  for (const tc of cases) {
    const res = analyzeAssetBeats({ workspaceDir: wsDir, handle: tc.handle, sensitivity: 1.35 });
    const bpmErr = Math.abs(res.grid_bpm - tc.expectedBpm);
    const periodMs = 60_000 / tc.expectedBpm;
    const phaseErr = circularPhaseDistanceMs(res.phase_ms, tc.expectedPhaseMs, periodMs);

    assert.ok(
      bpmErr <= 1.0,
      `${tc.label}: expected grid_bpm within ${tc.expectedBpm} ± 1.0 BPM, got ${res.grid_bpm} BPM`
    );
    assert.ok(
      phaseErr <= 20,
      `${tc.label}: expected phase_ms within ${tc.expectedPhaseMs} ± 20 ms, got ${res.phase_ms} ms (err=${phaseErr.toFixed(1)} ms)`
    );
    assert.ok(res.grid_ms.length >= 12, `${tc.label}: expected regular grid_ms across 10s`);
    assert.ok(res.onsets.length > 0 && res.onsets.every((o) => o.strength > 0 && o.strength <= 1));

    // Verify digest structure separates grid and onsets
    const digestEnv = formatBeatsDigest(res);
    assert.equal(digestEnv.grid_bpm, res.grid_bpm);
    assert.equal(digestEnv.phase_ms, res.phase_ms);
    assert.equal(digestEnv.digest.counts.grid_beats, res.grid_count);
    assert.equal(digestEnv.digest.counts.onsets, res.onsets_count);
    assert.ok(Array.isArray(digestEnv.digest.grid.preview_ms));
    assert.ok(Array.isArray(digestEnv.digest.onsets.preview));
  }

  // Verify library.query returns grid beats by default and onset items when filtered by text="onset"
  const qGrid = queryLibraryAnalysis({ workspaceDir: wsDir, handle: "aud_02", kind: "beats", range: "0s..5s" });
  assert.ok(qGrid.items.length >= 9);
  const qOnsets = queryLibraryAnalysis({
    workspaceDir: wsDir,
    handle: "aud_02",
    kind: "beats",
    text: "onset",
    range: "0s..5s",
  });
  assert.ok(qOnsets.items.length >= 9);
  assert.equal((qOnsets.items[0] as { kind?: string }).kind, "onset");
});

test("2. Real music.mp3: grid BPM invariant (<= 2% diff) across sensitivities 1.0 / 1.35 / 1.8, full 39.5s coverage without gaps, and strong onset alignment", () => {
  if (!fs.existsSync(TRIAL_MUSIC_MP3)) return;

  const wsDir = path.join(TEST_ROOT, "ws_music_mp3");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Real Music Beat Grid Test", aspect: "9:16", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [TRIAL_MUSIC_MP3] });

  const r10 = analyzeAssetBeats({ workspaceDir: wsDir, handle: "aud_01", sensitivity: 1.0 });
  const r135 = analyzeAssetBeats({ workspaceDir: wsDir, handle: "aud_01", sensitivity: 1.35 });
  const r18 = analyzeAssetBeats({ workspaceDir: wsDir, handle: "aud_01", sensitivity: 1.8 });

  const bpms = [r10.grid_bpm, r135.grid_bpm, r18.grid_bpm];
  const minBpm = Math.min(...bpms);
  const maxBpm = Math.max(...bpms);
  const relDiffPct = ((maxBpm - minBpm) / Math.max(1, minBpm)) * 100;

  assert.ok(
    relDiffPct <= 2.0,
    `Expected grid_bpm across sensitivities 1.0/1.35/1.8 to differ by <= 2%, got ${bpms.join(" / ")} (${relDiffPct.toFixed(2)}%)`
  );

  // Onsets count must still scale with sensitivity while grid remains locked
  assert.ok(
    r10.onsets_count < r135.onsets_count && r135.onsets_count < r18.onsets_count,
    `Expected onsets_count to increase with sensitivity: ${r10.onsets_count} < ${r135.onsets_count} < ${r18.onsets_count}`
  );

  for (const r of [r10, r135, r18]) {
    assert.ok(r.grid_ms.length >= 75, `Expected >= 75 grid beats over 39.5s, got ${r.grid_ms.length}`);
    assert.ok(r.grid_ms[0] <= r.beat_period_ms, `Expected first grid beat within first period, got ${r.grid_ms[0]}ms`);
    assert.ok(
      r.grid_ms[r.grid_ms.length - 1] >= r.duration_ms - r.beat_period_ms - 5,
      `Expected last grid beat near end of ${r.duration_ms}ms, got ${r.grid_ms[r.grid_ms.length - 1]}ms`
    );
    // Check there are NO gaps ( specifically in 1.66s..6.08s where raw onsets previously had a 4.4s hole!)
    for (let i = 1; i < r.grid_ms.length; i++) {
      const dt = r.grid_ms[i] - r.grid_ms[i - 1];
      assert.ok(
        Math.abs(dt - r.beat_period_ms) <= 2,
        `Expected uniform grid step ~${r.beat_period_ms}ms, got ${dt}ms at index ${i}`
      );
    }
    const beatsInGap = r.grid_ms.filter((t) => t >= 1660 && t <= 6080);
    assert.ok(beatsInGap.length >= 8, `Expected >= 8 regular grid beats in 1.66s..6.08s, got ${beatsInGap.length}`);

    // Strong onsets median distance to nearest grid beat
    const strongOnsets = r.onsets.filter((o) => o.strength >= 0.55);
    assert.ok(strongOnsets.length >= 8);
    const dists = strongOnsets
      .map((o) => Math.min(...r.grid_ms.map((g) => Math.abs(o.time_ms - g))))
      .sort((a, b) => a - b);
    const medianDistMs = dists[Math.floor(dists.length / 2)];
    assert.ok(
      medianDistMs <= 25,
      `Expected strong onsets median distance to grid <= 25ms for sens=${r.sensitivity}, got ${medianDistMs}ms`
    );
  }
});

test("3. window.__cuthol C.beats({ grid: true }) and C.beatGrid() vs legacy C.beats() onset behavior", () => {
  const wsDir = path.join(TEST_ROOT, "ws_bridge_beats");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Bridge Beat Grid Test", aspect: "16:9", fps: 30 });

  const mediaDir = path.join(wsDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const vidPath = path.join(mediaDir, "bg.mp4");
  const bgmPath = path.join(mediaDir, "bgm_120.wav");

  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#0F172A:s=640x360:r=30:d=6",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    vidPath,
  ]);
  synthesizeDrumTrack(bgmPath, 120, 0, 6);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [vidPath, bgmPath] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 6000 });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    explicitId: "cue_bgm",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: 6000,
  });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_titles",
    kind: "title",
    explicitId: "cue_title",
    atMs: 0,
    durationMs: 4000,
    text: "Beat Grid Test",
  });

  const { paths, sequence } = loadSequence(wsDir);
  const titleCue = sequence.lanes.find((l) => l.id === "ln_titles")!.cues[0];
  const bridgeData = exportBridgeDataForCue(sequence, titleCue, paths);

  assert.ok(Array.isArray(bridgeData.beats?.grid) && bridgeData.beats!.grid!.length >= 7);
  assert.ok(Array.isArray(bridgeData.beats?.times) && bridgeData.beats!.times.length > 0);

  // Verify TypeScript runtime
  const C = createCutholRuntime(bridgeData);
  const gridBeats = C.beats({ grid: true });
  const gridAlias = C.beatGrid();
  assert.deepEqual(gridBeats, gridAlias);
  assert.equal(gridBeats.length, 8); // 4s @ 120 BPM = 8 beats [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5]

  const gridDownbeats = C.beats({ grid: true, strong: true });
  assert.equal(gridDownbeats.length, 2); // every 4th grid beat

  const gridSubdivided = C.beatGrid({ from: 0, to: 1.0, div: 2 });
  assert.equal(gridSubdivided.length, 4); // [0, 0.25, 0.5, 0.75]

  // Verify UMD JS runtime matches TypeScript runtime identically
  const sandbox: Record<string, unknown> = { window: { __CUTHOL_DATA__: bridgeData } };
  vm.createContext(sandbox);
  vm.runInContext(getCutholRuntimeJsSource(), sandbox);
  const umdC = (sandbox.window as { __cuthol: typeof C }).__cuthol;
  assert.deepEqual(Array.from(umdC.beats({ grid: true })), gridBeats);
  assert.deepEqual(Array.from(umdC.beatGrid({ from: 0, to: 1.0, div: 2 })), gridSubdivided);
  assert.deepEqual(Array.from(umdC.beats()), C.beats());
});

test("4. mix.beat_align: aligns to regular grid by default and supports optional onset alignment", () => {
  if (!fs.existsSync(TRIAL_MUSIC_MP3)) return;

  const wsDir = path.join(TEST_ROOT, "ws_beat_align_modes");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Beat Align Grid vs Onsets", aspect: "9:16", fps: 30 });

  const mediaDir = path.join(wsDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const clipMp4 = path.join(mediaDir, "clip.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1E293B:s=360x640:r=30:d=16",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    clipMp4,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [clipMp4, TRIAL_MUSIC_MP3] });
  for (let i = 0; i < 6; i++) {
    appendSpineClip({
      workspaceDir: wsDir,
      assetHandle: "vid_01",
      sourceInMs: i * 1000,
      sourceOutMs: i * 1000 + 2000,
    });
  }

  // Default: align to regular beat grid -> all 6 clips snap to regular 4-beat bars (~1875ms each)
  const gridAlignRes = alignClipsToBeats({
    workspaceDir: wsDir,
    bgmHandle: "aud_01",
  });
  assert.equal(gridAlignRes.align_mode, "grid");
  assert.equal(gridAlignRes.aligned_clips.length, 6);
  assert.equal(gridAlignRes.skipped_clips.length, 0);

  stepJournal(wsDir, "undo");

  // Explicit onset mode (`alignTo: "onsets"`): clips in the 1.66s..6.08s onset gap are skipped as OUT_OF_TOLERANCE
  const onsetAlignRes = alignClipsToBeats({
    workspaceDir: wsDir,
    bgmHandle: "aud_01",
    alignTo: "onsets",
  });
  assert.equal(onsetAlignRes.align_mode, "onsets");
  assert.ok(
    onsetAlignRes.skipped_clips.some((s) => s.reason_code === "OUT_OF_TOLERANCE"),
    "Expected onset alignment mode to skip clips falling inside the 1.66s..6.08s onset gap"
  );
});
