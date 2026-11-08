/**
 * The example extensions in `examples/extensions/` stay true: every manifest
 * validates and enables, the planners, recipes, processors, effects and
 * transitions do what their READMEs say, the caption-kit helper is time-pure
 * and syncs into compositions, and one small draft render passes with the
 * example transitions and effects in the graph.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { validateExtensionManifest } from "../extensions/ext_manifest.js";

const REPO_ROOT = process.cwd();
const CLI_PATH = path.resolve(REPO_ROOT, "dist/cli.js");
const EXAMPLES_DIR = path.resolve(REPO_ROOT, "examples/extensions");
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-examples-"));
const MEDIA_DIR = path.join(TEST_ROOT, "media");

const TECHNIQUE_EXAMPLES = [
  "caption-kit",
  "film-look",
  "freeze-fade",
  "montage",
  "motion-transitions",
  "speed-ramps",
];

test.after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

function cli(ws: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI_PATH, ...args, "--dir", ws], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

function cliJson(ws: string, args: string[]): Json {
  const res = cli(ws, args);
  assert.equal(res.status, 0, `${args.join(" ")}\n${res.stderr}\n${res.stdout}`);
  return JSON.parse(res.stdout) as Json;
}

function cliFails(ws: string, args: string[], code: string): void {
  const res = cli(ws, args);
  assert.notEqual(res.status, 0, `expected ${args.join(" ")} to fail`);
  assert.match(res.stdout + res.stderr, new RegExp(code));
}

function ffmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || "ffmpeg failed");
}

function makeClip(name: string, source: string, freq: number): string {
  const out = path.join(MEDIA_DIR, name);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  ffmpeg([
    "-f", "lavfi", "-i", `${source}=size=320x180:rate=30:duration=6`,
    "-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=48000:duration=6`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", out,
  ]);
  return out;
}

function makeHit(): string {
  const out = path.join(MEDIA_DIR, "hit.wav");
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=1200:sample_rate=48000:duration=0.4", "-c:a", "pcm_s16le", out]);
  return out;
}

/** Project with vid_01..vid_03 (6 s, A/V), aud_01 (0.4 s) and the named examples copied in. */
function setupProject(name: string, examples: string[]): string {
  const ws = path.join(TEST_ROOT, name);
  initWorkspace({ dir: ws, title: name, aspect: "16:9", fps: 30 });
  const files = [
    makeClip("a.mp4", "testsrc2", 440),
    makeClip("b.mp4", "smptehdbars", 660),
    makeClip("c.mp4", "testsrc", 330),
    makeHit(),
  ];
  cliJson(ws, ["library", "ingest", ...files]);
  for (const ex of examples) {
    fs.cpSync(path.join(EXAMPLES_DIR, ex), path.join(ws, ".cuthol", "extensions", ex), { recursive: true });
    cliJson(ws, ["extension", "enable", "--name", ex]);
  }
  return ws;
}

function clip(ws: string, id: string) {
  const c = loadSequence(ws).sequence.spine.clips.find((x) => x.id === id);
  assert.ok(c, `clip ${id} missing`);
  return c;
}

function rev(ws: string): number {
  return Number(cliJson(ws, ["verify"]).revision);
}

/** Mean luma (0..255) of one rendered frame at `atSec`. */
function frameLuma(file: string, atSec: number): number {
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "error", "-ss", String(atSec), "-i", file, "-frames:v", "1", "-vf", "scale=1:1:flags=area,format=gray", "-f", "rawvideo", "-"],
    { windowsHide: true, maxBuffer: 1024 * 1024 }
  );
  assert.equal(proc.status, 0, String(proc.stderr));
  assert.equal(proc.stdout.length, 1);
  return proc.stdout[0];
}

test("every example manifest validates against the closed schema and enables", () => {
  const dirs = fs
    .readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const ex of TECHNIQUE_EXAMPLES) assert.ok(dirs.includes(ex), `example ${ex} missing`);
  for (const ex of dirs) {
    const raw = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, ex, "cuthol-extension.json"), "utf8"));
    const manifest = validateExtensionManifest(raw, ex);
    assert.equal(manifest.name, ex);
    assert.ok(fs.existsSync(path.join(EXAMPLES_DIR, ex, "README.md")), `${ex}/README.md missing`);
    const indexRow = fs.readFileSync(path.join(EXAMPLES_DIR, "README.md"), "utf8");
    assert.ok(indexRow.includes(`\`${ex}\``), `examples/extensions/README.md lacks a row for ${ex}`);
  }
  const ws = setupProject("enable_all", dirs);
  const enabled = (loadSequence(ws).sequence.extensions ?? []).map((e) => e.name).sort();
  assert.deepEqual(enabled, dirs);
});

test("caption-kit: helper is time-pure and the helper + asset pack sync into a composition", () => {
  const src = fs.readFileSync(path.join(EXAMPLES_DIR, "caption-kit", "helper.js"), "utf8");
  const sandbox: Json = { window: {} };
  vm.runInNewContext(src, sandbox);
  const kit = ((sandbox.window as Json).__cuthol as { ext: Record<string, Record<string, (...a: unknown[]) => unknown>> }).ext["caption-kit"];
  const words = [{ start: 0.2, end: 0.8 }, { start: 0.8, end: 1.4 }];
  assert.equal(kit.activeWord(words, 0.1), -1);
  assert.equal(kit.activeWord(words, 0.5), 0);
  assert.equal(kit.activeWord(words, 0.8), 1);
  assert.equal(kit.activeWord(words, 2), -1);
  assert.equal(kit.typewriter("LOWER THIRD", 0.5, 8), "LOWE");
  assert.equal(kit.typewriter("abc", 0, 8), "");
  assert.equal(kit.counter(250, 0, 2), 0);
  assert.equal(kit.counter(250, 2, 2), 250);
  assert.equal(kit.counter(250, 1, 2), kit.counter(250, 1, 2));

  const ws = setupProject("caption_kit", ["caption-kit"]);
  const compDir = path.join(ws, "compositions", "cap1");
  cliJson(ws, ["composition", "scaffold", "--comp-dir", "compositions/cap1", "--duration", "4s"]);
  fs.copyFileSync(path.join(EXAMPLES_DIR, "caption-kit", "demo", "index.html"), path.join(compDir, "index.html"));
  cliJson(ws, ["lane", "add-composition", "--lane", "ln_motion", "--comp-dir", "compositions/cap1", "--at", "0s", "--duration", "4s"]);
  const html = fs.readFileSync(path.join(compDir, "index.html"), "utf8");
  assert.match(html, /<script src="assets\/cuthol-runtime\.js"><\/script>\s*<script src="assets\/cuthol-ext-caption-kit\.js"><\/script>/);
  assert.ok(fs.existsSync(path.join(compDir, "assets", "cuthol-ext-caption-kit.js")));
  assert.ok(fs.existsSync(path.join(compDir, "assets", "ext", "caption-kit", "caption-kit.css")));
  assert.ok(fs.existsSync(path.join(compDir, "assets", "ext", "caption-kit", "pill.svg")));
  const v = cliJson(ws, ["verify"]);
  assert.equal(v.error_count, 0, JSON.stringify(v));
});

test("montage planners: assemble plans spine clips, event_sfx places cues on composition events", () => {
  const ws = setupProject("montage", ["montage"]);
  const params = JSON.stringify({ handles: "vid_01,vid_02,vid_99", clip_ms: 1500 });
  const dry = cliJson(ws, ["extension", "run", "--name", "montage", "--planner", "assemble", "--params", params, "--dry-run"]);
  assert.deepEqual((dry.diff as Json).spine_added, ["sp_01", "sp_02"]);
  assert.ok((dry.notes as string[]).some((n) => n.includes("skip unknown handle vid_99")));
  assert.equal(loadSequence(ws).sequence.spine.clips.length, 0, "dry run must not change the sequence");
  const revBefore = rev(ws);
  cliJson(ws, ["extension", "run", "--name", "montage", "--planner", "assemble", "--params", params]);
  const seq = loadSequence(ws).sequence;
  assert.equal(rev(ws), revBefore + 1, "planner applies in one revision");
  assert.deepEqual(seq.spine.clips.map((c) => [c.asset_handle, c.source_in_ms, c.source_out_ms]), [
    ["vid_01", 0, 1500],
    ["vid_02", 0, 1500],
  ]);

  cliJson(ws, ["composition", "scaffold", "--comp-dir", "compositions/ev", "--duration", "2s", "--preset", "lower_third"]);
  fs.writeFileSync(
    path.join(ws, "compositions", "ev", "events.json"),
    JSON.stringify([{ name: "paper_drop", at_ms: 400, meta: { gain_db: -9 } }, { name: "paper_drop", at_ms: 1200 }, { name: "other", at_ms: 600 }]),
    "utf8"
  );
  cliJson(ws, ["lane", "add-composition", "--lane", "ln_motion", "--comp-dir", "compositions/ev", "--at", "500ms", "--duration", "2s"]);
  cliJson(ws, ["extension", "run", "--name", "montage", "--planner", "event_sfx", "--params", JSON.stringify({ drop_asset: "aud_01" })]);
  const sfx = loadSequence(ws).sequence.lanes.find((l) => l.id === "ln_sfx");
  assert.ok(sfx);
  const cues = sfx.cues.map((c) => {
    const cue = c as unknown as { at_ms: number; asset_handle?: string; gain_db?: number };
    return [cue.at_ms, cue.asset_handle];
  });
  assert.deepEqual(cues, [[900, "aud_01"], [1700, "aud_01"]]);
  const v = cliJson(ws, ["verify"]);
  assert.equal(v.error_count, 0, JSON.stringify(v));
});

test("speed-ramps recipe: dry run lists three steps, apply is one revision, one undo reverts it", () => {
  const ws = setupProject("speed_ramps", ["speed-ramps"]);
  cliJson(ws, ["spine", "append", "--asset", "vid_01"]);
  const params = JSON.stringify({ clip: "sp_01", a: "1s", b: "2s", c: "3s", d: "4s", rate: 0.5 });
  const dry = cliJson(ws, ["extension", "run", "--name", "speed-ramps", "--recipe", "slow_middle", "--params", params, "--dry-run"]);
  assert.deepEqual((dry.steps_executed as Json[]).map((s) => s.id), ["ramp", "zoom_x", "zoom_y"]);
  assert.equal(clip(ws, "sp_01").duration_ms, 6000);
  const revBefore = rev(ws);
  cliJson(ws, ["extension", "run", "--name", "speed-ramps", "--recipe", "slow_middle", "--params", params]);
  const ramped = clip(ws, "sp_01");
  assert.equal(rev(ws), revBefore + 1);
  assert.ok(ramped.duration_ms > 6000, `slow ramp must lengthen the clip, got ${ramped.duration_ms}`);
  assert.deepEqual(ramped.envelopes.map((e) => e.parameter).sort(), ["placement.scale_x", "placement.scale_y"]);
  cliJson(ws, ["workspace", "journal", "undo"]);
  const back = clip(ws, "sp_01");
  assert.equal(back.duration_ms, 6000);
  assert.equal(back.envelopes.length, 0);

  // A mark beyond the source span fails and applies nothing.
  const bad = JSON.stringify({ clip: "sp_01", a: "1s", b: "2s", c: "3s", d: "9s" });
  const res = cli(ws, ["extension", "run", "--name", "speed-ramps", "--recipe", "fast_middle", "--params", bad]);
  assert.notEqual(res.status, 0);
  assert.equal(clip(ws, "sp_01").duration_ms, 6000);
});

test("freeze-fade processors: hold lengthens and drops audio, fade_in keeps duration and audio", () => {
  const ws = setupProject("freeze_fade", ["freeze-fade"]);
  const hold = cliJson(ws, ["extension", "run", "--name", "freeze-fade", "--processor", "hold", "--input", "vid_01", "--params", '{"seconds":1.5}']);
  const holdProbe = (hold.output_asset as Json).probe as Json;
  assert.ok(Math.abs(Number(holdProbe.duration_ms) - 7500) <= 40, JSON.stringify(holdProbe));
  assert.equal(holdProbe.has_audio, false);
  const fade = cliJson(ws, ["extension", "run", "--name", "freeze-fade", "--processor", "fade_in", "--input", "vid_02"]);
  const fadeProbe = (fade.output_asset as Json).probe as Json;
  assert.ok(Math.abs(Number(fadeProbe.duration_ms) - 6000) <= 40, JSON.stringify(fadeProbe));
  assert.equal(fadeProbe.has_audio, true);
  const diags = JSON.stringify([hold.diagnostics ?? [], fade.diagnostics ?? []]);
  assert.ok(!diags.includes("CUTHOL-G209"), diags);
});

test("film-look fx and motion-transitions register, validate params, and render a draft", () => {
  const ws = setupProject("look_and_transitions", ["film-look", "motion-transitions"]);
  for (const h of ["vid_01", "vid_02", "vid_03", "vid_01"]) cliJson(ws, ["spine", "append", "--asset", h, "--in", "0s", "--out", "2s"]);
  cliJson(ws, ["spine", "transition", "--clip", "sp_01", "--kind", "ext:motion-transitions/push", "--duration", "500ms", "--easing", "ease_in_out"]);
  cliJson(ws, ["spine", "transition", "--clip", "sp_02", "--kind", "ext:motion-transitions/flash", "--duration", "600ms"]);
  cliJson(ws, ["spine", "transition", "--clip", "sp_03", "--kind", "ext:motion-transitions/wipe_reveal", "--duration", "600ms", "--param", "span=0.6"]);
  cliFails(ws, ["spine", "transition", "--clip", "sp_03", "--kind", "ext:motion-transitions/wipe_reveal", "--duration", "600ms", "--param", "span=3"], "CUTHOL-G123");
  cliFails(ws, ["spine", "transition", "--clip", "sp_03", "--kind", "ext:motion-transitions/zoom_blur", "--duration", "600ms"], "CUTHOL-G122");
  assert.equal(clip(ws, "sp_03").transition_out?.kind, "ext:motion-transitions/wipe_reveal");

  cliJson(ws, ["spine", "fx", "add", "--clip", "sp_01", "--kind", "ext:film-look/film_grain", "--param", "strength=12"]);
  cliJson(ws, ["spine", "fx", "add", "--clip", "sp_02", "--kind", "ext:film-look/vignette"]);
  cliJson(ws, ["spine", "fx", "add", "--clip", "sp_04", "--kind", "ext:film-look/rgb_split", "--param", "shift_r=8,shift_b=-8"]);
  const pulse = cliJson(ws, ["spine", "fx", "add", "--clip", "sp_04", "--kind", "ext:film-look/pulse"]);
  const pulseId = (pulse.fx as Json).id as string;
  cliJson(ws, ["spine", "envelope", "--clip", "sp_04", "--param", `fx.${pulseId}.level`, "--points", "0ms:0,1s:0.3,1900ms:0"]);
  cliFails(ws, ["spine", "envelope", "--clip", "sp_01", "--param", "fx.fx_01.strength", "--points", "0ms:0,1s:20"], "CUTHOL-G119");
  cliFails(ws, ["spine", "fx", "add", "--clip", "sp_01", "--kind", "ext:film-look/vignette", "--param", "radius=2"], "CUTHOL-G118");

  const v = cliJson(ws, ["verify"]);
  assert.equal(v.error_count, 0, JSON.stringify(v));

  const out = path.join(ws, "out", "draft.mp4");
  const render = cliJson(ws, ["render", "--preset", "draft_480p", "--out", out]);
  assert.ok(fs.existsSync(out));
  assert.equal(render.duration_ms, 8000);
  const errs = JSON.stringify(render).match(/"severity":"ERROR"/g) ?? [];
  assert.equal(errs.length, 0, JSON.stringify(render).slice(0, 2000));
  // Flash window is the head of sp_03 (4.0..4.6 s): its middle is near white,
  // well above the plain clips on either side.
  const mid = frameLuma(out, 4.3);
  const before = frameLuma(out, 3.5);
  assert.ok(mid > 170, `flash middle luma ${mid}`);
  assert.ok(mid > before + 40, `flash ${mid} vs before ${before}`);
});
