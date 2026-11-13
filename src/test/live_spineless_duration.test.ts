/**
 * Live preview duration on a spine-less project (`src/test/live_spineless_duration.test.ts`):
 * the delta must carry the sequence duration computed from spine *and* lanes,
 * so the window never falls back to a spine-only recomputation (which is 0
 * when the spine is empty).
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { computeSequenceDurationMs } from "../core/timeline.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { addLaneCue } from "../sequence/lanes.js";
import { buildDelta, buildSnapshot } from "../live/live_state.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-spineless-"));
const MEDIA = path.join(ROOT, "tone.mp4");

function ffmpegTone(): void {
  if (fs.existsSync(MEDIA)) return;
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "color=c=0x4488FF:s=160x160:r=30:d=8",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8",
      "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", MEDIA,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

/** Graphics-only project: 0 spine clips, one music cue + one long broll cue. */
function makeSpineless(name: string): string {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  ffmpegTone();
  initWorkspace({ dir, title: name, aspect: "16:9", fps: 30 });
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: dir, filePaths: [MEDIA] });
  addLaneCue({
    workspaceDir: dir, laneId: "ln_bgm", assetHandle: item.handle,
    kind: "music", atMs: 0, durationMs: 8000,
  });
  addLaneCue({
    workspaceDir: dir, laneId: "ln_broll", assetHandle: item.handle,
    atMs: 1000, durationMs: 5000,
  });
  return dir;
}

test("delta carries the lane-driven duration on a spine-less project", () => {
  const dir = makeSpineless("gfx");
  const { sequence, paths } = loadSequence(dir);
  const seq = sequence as any;
  assert.equal(seq.spine.clips.length, 0);
  const duration = computeSequenceDurationMs(sequence as any);
  assert.equal(duration, 8000);

  const snapshot = buildSnapshot(dir);
  assert.equal(snapshot.project.duration_ms, 8000);

  const delta = buildDelta({
    projectDir: dir,
    fromRevision: 0,
    toRevision: seq.meta.revision,
    oldSequence: null,
    newSequence: sequence,
    operation: "lane.add-cue",
    timestamp: new Date().toISOString(),
  });
  assert.equal(delta.duration_ms, duration);
  assert.equal(delta.duration_ms, snapshot.project.duration_ms);
  assert.ok(paths);
});

test("delta duration matches the snapshot after a lanes-only edit", () => {
  const dir = makeSpineless("gfx2");
  const before = loadSequence(dir).sequence as any;
  const beforeDuration = computeSequenceDurationMs(before);
  assert.equal(before.spine.clips.length, 0);
  addLaneCue({
    workspaceDir: dir, laneId: "ln_bgm", assetHandle: before.library[0].handle,
    kind: "music", atMs: 8000, durationMs: 4000,
  });
  const after = loadSequence(dir).sequence as any;
  const snapshot = buildSnapshot(dir);
  const delta = buildDelta({
    projectDir: dir,
    fromRevision: before.meta.revision,
    toRevision: after.meta.revision,
    oldSequence: before,
    newSequence: after,
    operation: "lane.add-cue",
    timestamp: new Date().toISOString(),
  });
  assert.equal(computeSequenceDurationMs(after), beforeDuration + 4000);
  assert.equal(delta.duration_ms, snapshot.project.duration_ms);
  assert.ok(delta.duration_ms > 0);
});
