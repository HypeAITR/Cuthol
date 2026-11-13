/**
 * Lane-level mute (`src/test/lane_mute.test.ts`): CLI mute/unmute with journal,
 * revision, undo/redo and diagnostics, plus the Live edit-API argument builder.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildEditCliArgs } from "../live/live_edit_api.js";
import { initWorkspace, loadJournalManifest, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { addLaneCue } from "../sequence/lanes.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-lane-mute-"));
const MEDIA = path.join(ROOT, "tone.mp4");

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CUTHOL_ENCODER: "x264" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function ffmpegTone(): void {
  if (fs.existsSync(MEDIA)) return;
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "color=c=0x4488FF:s=160x160:r=30:d=6",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
      "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", MEDIA,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function makeProject(name: string): string {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  ffmpegTone();
  initWorkspace({ dir, title: name, aspect: "16:9", fps: 30 });
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: dir, filePaths: [MEDIA] });
  addLaneCue({
    workspaceDir: dir, laneId: "ln_bgm", assetHandle: item.handle,
    kind: "music", atMs: 0, durationMs: 6000,
  });
  return dir;
}

function laneMuted(dir: string, laneId: string): boolean {
  const seq = loadSequence(dir).sequence as any;
  return Boolean(seq.lanes.find((l: any) => l.id === laneId)?.muted);
}

function cursorOf(dir: string): number {
  return loadJournalManifest(loadSequence(dir).paths).cursor_revision;
}

function parseEnvelope(stdout: string, stderr: string): Record<string, unknown> {
  for (const text of [stdout, stderr]) {
    const trimmed = text.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      // try the other stream
    }
  }
  throw new Error(`no JSON envelope\nstdout=${stdout.slice(0, 800)}\nstderr=${stderr.slice(0, 800)}`);
}

test("lane mute/unmute via CLI, with journal, revision and undo", () => {
  const dir = makeProject("mute1");
  assert.equal(laneMuted(dir, "ln_bgm"), false);
  const rev0 = cursorOf(dir);

  const muted = runCli(["lane", "mute", "--lane", "ln_bgm", "--dir", dir]);
  assert.equal(muted.status, 0, muted.stderr || muted.stdout);
  const muteEnv = parseEnvelope(muted.stdout, muted.stderr);
  assert.equal(muteEnv.action, "lane.mute");
  assert.equal((muteEnv as any).muted, true);
  assert.equal(laneMuted(dir, "ln_bgm"), true);
  assert.ok(cursorOf(dir) > rev0);

  const unmuted = runCli(["lane", "unmute", "--lane", "ln_bgm", "--dir", dir]);
  assert.equal(unmuted.status, 0, unmuted.stderr || unmuted.stdout);
  assert.equal(parseEnvelope(unmuted.stdout, unmuted.stderr).action, "lane.unmute");
  assert.equal(laneMuted(dir, "ln_bgm"), false);

  // Undo restores the muted state (mute is journaled like lock).
  runCli(["lane", "mute", "--lane", "ln_bgm", "--dir", dir]);
  assert.equal(laneMuted(dir, "ln_bgm"), true);
  const undo = runCli(["workspace", "journal", "undo", "--dir", dir]);
  assert.equal(undo.status, 0, undo.stderr || undo.stdout);
  assert.equal(laneMuted(dir, "ln_bgm"), false);
  const redo = runCli(["workspace", "journal", "redo", "--dir", dir]);
  assert.equal(redo.status, 0, redo.stderr || redo.stdout);
  assert.equal(laneMuted(dir, "ln_bgm"), true);
});

test("lane mute rejects unknown lanes and the spine", () => {
  const dir = makeProject("mute2");
  const unknown = runCli(["lane", "mute", "--lane", "ln_nope", "--dir", dir]);
  assert.notEqual(unknown.status, 0);
  assert.match(`${unknown.stdout}\n${unknown.stderr}`, /CUTHOL-G101/);

  const spine = runCli(["lane", "mute", "--lane", "spine", "--dir", dir]);
  assert.notEqual(spine.status, 0);
  assert.match(`${spine.stdout}\n${spine.stderr}`, /CUTHOL-G125/);
  assert.match(`${spine.stdout}\n${spine.stderr}`, /not a lane/);
});

test("live edit API maps lane-mute onto the CLI", () => {
  const dir = makeProject("mute3");
  const seq = loadSequence(dir).sequence;
  assert.deepEqual(
    buildEditCliArgs({ action: "lane-mute", target: "ln_bgm", params: { lane: "ln_bgm", muted: true } }, seq),
    ["lane", "mute", "--lane", "ln_bgm"]
  );
  assert.deepEqual(
    buildEditCliArgs({ action: "lane-mute", target: "ln_bgm", params: { lane: "ln_bgm", muted: false } }, seq),
    ["lane", "unmute", "--lane", "ln_bgm"]
  );
  assert.throws(
    () => buildEditCliArgs({ action: "lane-mute", target: "ln_nope", params: { lane: "ln_nope", muted: true } }, seq),
    /unknown lane 'ln_nope'/
  );
  assert.throws(
    () => buildEditCliArgs({ action: "lane-mute", target: "ln_bgm", params: { lane: "ln_bgm" } }, seq),
    /params\.muted true or false/
  );
  assert.throws(
    () => buildEditCliArgs({ action: "lane-mute", target: "spine", params: { lane: "spine", muted: true } }, seq),
    /cannot target the spine/
  );
});
