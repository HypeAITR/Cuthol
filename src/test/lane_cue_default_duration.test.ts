// `lane add-cue` without --duration: the default length is capped at the media that is left,
// so a sound shorter than the default is accepted instead of failing the out-point check.
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/lane_cue_default_duration");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

function ffmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function cli(dir: string, args: string[]): { status: number; out: Record<string, unknown> } {
  const proc = spawnSync(process.execPath, [CLI, ...args, "--dir", dir, "--json"], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    windowsHide: true,
  });
  const text = (proc.stdout || proc.stderr || "").trim();
  return { status: proc.status ?? 1, out: JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) };
}

function setup(name: string, seconds: number): string {
  const dir = path.join(TEST_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-ar", "48000", wav]);
  assert.equal(cli(dir, ["workspace", "init", dir, "--aspect", "16:9"]).status, 0);
  assert.equal(cli(dir, ["library", "ingest", wav]).status, 0);
  return dir;
}

function cueDuration(out: Record<string, unknown>): number {
  const cue = (out as { cue?: { duration_ms?: number } }).cue;
  assert.ok(cue, JSON.stringify(out).slice(0, 400));
  return cue.duration_ms as number;
}

test("sound shorter than the default length is added at its own length", () => {
  const dir = setup("short", 2.136);
  const res = cli(dir, ["lane", "add-cue", "--lane", "ln_sfx", "--kind", "sfx", "--asset", "aud_01", "--at", "0s"]);
  assert.equal(res.status, 0, JSON.stringify(res.out).slice(0, 400));
  assert.ok(Math.abs(cueDuration(res.out) - 2136) <= 2, `duration ${cueDuration(res.out)}`);
});

test("default stays 3000ms when the media is longer", () => {
  const dir = setup("long", 5);
  const res = cli(dir, ["lane", "add-cue", "--lane", "ln_sfx", "--kind", "sfx", "--asset", "aud_01", "--at", "0s"]);
  assert.equal(res.status, 0);
  assert.equal(cueDuration(res.out), 3000);
});

test("cap respects --in: only the media after the in-point counts", () => {
  const dir = setup("in_point", 2.5);
  const res = cli(dir, ["lane", "add-cue", "--lane", "ln_sfx", "--kind", "sfx", "--asset", "aud_01", "--at", "0s", "--in", "1000ms"]);
  assert.equal(res.status, 0, JSON.stringify(res.out).slice(0, 400));
  assert.ok(Math.abs(cueDuration(res.out) - 1500) <= 2, `duration ${cueDuration(res.out)}`);
});

test("an explicit duration past the media end is still rejected", () => {
  const dir = setup("explicit", 2.136);
  const res = cli(dir, ["lane", "add-cue", "--lane", "ln_sfx", "--kind", "sfx", "--asset", "aud_01", "--at", "0s", "--duration", "3000ms"]);
  assert.notEqual(res.status, 0);
  assert.match(JSON.stringify(res.out), /CUTHOL-G202/);
});
