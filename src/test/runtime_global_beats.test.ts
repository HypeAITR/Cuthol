// C.global.beats is the full-sequence beat grid in sequence seconds, not the
// cue-local grid shifted by cueStart. Music at 0, cue at 10 s: the first global
// beat is the first beat of the music (not ~10 s); local beats stay window-local.
// Trimming the music moves the global grid and changes the cache key.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { computeUsedBridgePayloadHashes } from "../compositor/bridge_hash.js";
import { exportBridgeDataForCue } from "../compositor/bridge_exporter.js";
import { createCutholRuntime } from "../compositor/cuthol_runtime.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { addLaneCue, updateLaneCue } from "../sequence/lanes.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/runtime_global_beats_test");

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
    "-y", "-v", "error", "-f", "lavfi", "-i",
    `aevalsrc='${expr}':s=16000:d=${durationSec}`,
    "-c:a", "pcm_s16le", filePath,
  ]);
  assert.equal(proc.status, 0, proc.stderr?.toString());
}

test("global beats are the full-sequence grid; trimming the music moves them and the cache key", () => {
  const wsDir = path.join(TEST_ROOT, "ws_global_beats");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Global Beats Test", aspect: "16:9", fps: 30 });

  const mediaDir = path.join(wsDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const bgmPath = path.join(mediaDir, "bgm_120.wav");
  synthesizeDrumTrack(bgmPath, 120, 0, 20);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [bgmPath] });

  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    explicitId: "cue_bgm",
    assetHandle: "aud_01",
    atMs: 10000 - 10000,
    durationMs: 20000,
  });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_titles",
    kind: "title",
    explicitId: "cue_title",
    atMs: 10000,
    durationMs: 2000,
    text: "Global Beats",
  });

  const { paths, sequence } = loadSequence(wsDir);
  const titleCue = sequence.lanes.find((l) => l.id === "ln_titles")!.cues[0];
  const bridge = exportBridgeDataForCue(sequence, titleCue, paths);

  const globalTimes = bridge.global?.beats?.times ?? [];
  assert.ok(globalTimes.length > 0, "global beats must be present");
  // First beat of the music, not the cue window start (~10 s).
  assert.ok(
    globalTimes[0] < 1.0,
    `C.global.beats[0].t should be near the first beat of the music, got ${globalTimes[0]}`
  );
  // Local beats stay window-local.
  const localTimes = bridge.beats?.times ?? [];
  assert.ok(localTimes.length > 0, "local beats must be present");
  assert.ok(localTimes[0] >= 0 && localTimes[0] < 1.0, `local beats stay local, got ${localTimes[0]}`);

  const C = createCutholRuntime(bridge);
  const runtimeGlobal = C.global.beats();
  assert.ok(runtimeGlobal.length > 0);
  assert.ok(Math.abs(runtimeGlobal[0] - globalTimes[0]) < 1e-6);

  const usage = {
    usesLocalWords: false, usesLocalBeats: true, usesLocalAudio: false, usesLocalCuts: false,
    usesSequenceTiming: false, usesGlobalWords: false, usesGlobalBeats: true,
    usesGlobalAudio: false, usesGlobalCuts: false, usesGlobalTiming: false, usesAnyGlobal: true,
  };
  const beforeHashes = computeUsedBridgePayloadHashes(bridge, usage);
  const beforeGlobalHash = bridge.global?.hash ?? "";
  assert.notEqual(beforeHashes.usedGlobalHash, "unused");

  // Trim the first 2 s off the music: the global grid must move and the key must change.
  updateLaneCue({ workspaceDir: wsDir, cueId: "cue_bgm", sourceInMs: 2000, durationMs: 18000 });

  const trimmed = loadSequence(wsDir);
  const trimmedBridge = exportBridgeDataForCue(trimmed.sequence, titleCue, trimmed.paths);
  const trimmedTimes = trimmedBridge.global?.beats?.times ?? [];
  assert.ok(trimmedTimes.length > 0);
  assert.ok(
    trimmedTimes.length < globalTimes.length,
    `trimming the music must shorten the global grid, was ${globalTimes.length}, now ${trimmedTimes.length}`
  );
  assert.notEqual(trimmedBridge.global?.hash ?? "", beforeGlobalHash);
  const afterHashes = computeUsedBridgePayloadHashes(trimmedBridge, usage);
  assert.notEqual(afterHashes.usedGlobalHash, beforeHashes.usedGlobalHash);
});
