/**
 * N3: `brief` shows speed ramps (start->end rate, point count, pitch mode) in
 * every lens. N4: the `spine speed` help line and the G110 suggestion for
 * `--no-preserve-pitch` state the explicit `--preserve-pitch true|false` form.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderSequenceBrief } from "../brief/inspector.js";
import { suggestFlagFix } from "../cli_args.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip, setSpineSpeed } from "../sequence/spine.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rampedWorkspace(): string {
  const tmp = makeTempRoot("cuthol-audio-ramp-brief-");
  const wsDir = path.join(tmp, "proj");
  initWorkspace({ dir: wsDir, title: "brief ramp", aspect: "16:9", fps: 30 });
  const media = path.join(tmp, "tone.mp4");
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:d=4",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=4",
      "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      media,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
  setSpineSpeed({
    workspaceDir: wsDir,
    clipId: "sp_01",
    speedRamp: [
      { source_offset_ms: 0, rate: 1.0 },
      { source_offset_ms: 4000, rate: 3.0 },
    ],
  });
  return wsDir;
}

test("brief shows the ramp in the overview lens", () => {
  const wsDir = rampedWorkspace();
  try {
    const { sequence } = loadSequence(wsDir);
    const md = renderSequenceBrief(sequence, { lens: "overview" });
    assert.match(md, /ramp 1->3x/, "overview must show the ramp rate range");
    assert.match(md, /2 pts/, "overview must show the ramp point count");
    assert.match(md, /pitch kept/, "overview must show pitch preservation for preserve_pitch=true");
  } finally {
    fs.rmSync(path.dirname(wsDir), { recursive: true, force: true });
  }
});

test("brief shows the ramp in the flow lens", () => {
  const wsDir = rampedWorkspace();
  try {
    const { sequence } = loadSequence(wsDir);
    const md = renderSequenceBrief(sequence, { lens: "flow" });
    assert.match(md, /ramp 1->3x/, "flow must show the ramp rate range");
    assert.match(md, /2 pts/, "flow must show the ramp point count");
  } finally {
    fs.rmSync(path.dirname(wsDir), { recursive: true, force: true });
  }
});

test("brief shows the ramp in the canvas lens", () => {
  const wsDir = rampedWorkspace();
  try {
    const { sequence } = loadSequence(wsDir);
    const md = renderSequenceBrief(sequence, { lens: "canvas" });
    assert.match(md, /ramp 1->3x/, "canvas must show the ramp rate range");
  } finally {
    fs.rmSync(path.dirname(wsDir), { recursive: true, force: true });
  }
});

test("brief detail lens keeps the raw speed_ramp", () => {
  const wsDir = rampedWorkspace();
  try {
    const { sequence } = loadSequence(wsDir);
    const md = renderSequenceBrief(sequence, { lens: "detail", targetIds: ["sp_01"] });
    assert.match(md, /speed_ramp/, "detail lens must expose speed_ramp");
    assert.match(md, /preserve_pitch/, "Detail lens must expose preserve_pitch");
  } finally {
    fs.rmSync(path.dirname(wsDir), { recursive: true, force: true });
  }
});

test("spine speed help states the explicit preserve-pitch form", () => {
  const proc = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr);
  const out = `${proc.stdout}\n${proc.stderr}`;
  assert.match(
    out,
    /--preserve-pitch true\|false/,
    "help must show [--preserve-pitch true|false]"
  );
});

test("G110 suggests --preserve-pitch false for --no-preserve-pitch", () => {
  assert.equal(
    suggestFlagFix("no-preserve-pitch", "spine", "speed"),
    "cuthol spine speed --preserve-pitch false"
  );
});
