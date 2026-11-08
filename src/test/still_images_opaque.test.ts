/**
 * graphics-led videos.
 *
 * 1. A still image can be held on the spine for longer than its 5 s default (no G202) and renders on every
 *    frame (it is looped, not shown as a single frame followed by the stage backdrop).
 * 2. CUTHOL-G505 (opaque overlay) is raised only when moving footage plays under the overlay; the same
 *    full-frame opaque composition over a still image is a deliberate design and passes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

function cli(args: string[]): { ok: boolean; result: any; raw: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const raw = `${proc.stdout ?? ""}`;
  let env: any = null;
  try {
    env = JSON.parse(raw);
  } catch {
    // keep raw for the assertion message
  }
  return { ok: Boolean(env?.ok), result: env?.result ?? env, raw: raw.slice(0, 2000) + (proc.stderr ?? "").slice(0, 1000) };
}

function makeStillAndVideo(wsDir: string): { png: string; mp4: string } {
  const png = path.join(wsDir, "bg.png");
  const mp4 = path.join(wsDir, "clip.mp4");
  assert.equal(
    spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0xF0E8D0:s=320x320", "-frames:v", "1", png]).status,
    0
  );
  assert.equal(
    spawnSync("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=320x320:r=30:d=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", mp4,
    ]).status,
    0
  );
  return { png, mp4 };
}

test("1. A still image holds on the spine beyond 5 s and renders on every frame", () => {
  const wsDir = path.join(TEST_ROOT, "still_spine");
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "1:1", "--fps", "30"]).ok);
  const { png, mp4 } = makeStillAndVideo(wsDir);
  assert.ok(cli(["library", "ingest", png, mp4, "--dir", wsDir]).ok);
  const append = cli(["spine", "append", "--asset", "img_01", "--in", "0s", "--out", "8s", "--dir", wsDir]);
  assert.ok(append.ok, append.raw);
  assert.ok(cli(["spine", "append", "--asset", "vid_01", "--in", "0s", "--out", "2s", "--dir", wsDir]).ok);

  const verify = cli(["verify", "--dir", wsDir]);
  assert.ok(verify.ok, verify.raw);
  assert.equal(verify.result.error_count, 0, verify.raw);

  const render = cli(["render", "--preset", "draft_480p", "--out", "output/still.mp4", "--dir", wsDir]);
  assert.ok(render.ok, render.raw);
  assert.equal(render.result.blank_scan.total_frames, 300, render.raw);
  assert.equal(render.result.blank_scan.blank_frames_count, 0, JSON.stringify(render.result.blank_scan.events));

  // The frame at 7 s must still be the cream still, not the dark stage backdrop.
  const outMp4 = path.join(wsDir, "output", "still.mp4");
  const px = spawnSync(
    "ffmpeg",
    ["-v", "error", "-ss", "7", "-i", outMp4, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: 1024 }
  ).stdout as Buffer;
  assert.ok(px.length === 3 && px[0] > 200 && px[1] > 200, `expected the still at 7 s, got rgb(${[...px]})`);
});

test("2. G505 is raised for an opaque overlay over moving footage, not over a still", () => {
  const wsDir = path.join(TEST_ROOT, "opaque_overlay");
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "1:1", "--fps", "30"]).ok);
  const { png, mp4 } = makeStillAndVideo(wsDir);
  assert.ok(cli(["library", "ingest", png, mp4, "--dir", wsDir]).ok);
  assert.ok(cli(["spine", "append", "--asset", "img_01", "--in", "0s", "--out", "3s", "--dir", wsDir]).ok);
  assert.ok(cli(["spine", "append", "--asset", "vid_01", "--in", "0s", "--out", "3s", "--dir", wsDir]).ok);

  const compDir = path.join(wsDir, "compositions", "opaque");
  assert.ok(cli(["composition", "scaffold", "--comp-dir", compDir, "--duration", "1s", "--dir", wsDir]).ok);
  const indexHtml = path.join(compDir, "index.html");
  const html = fs.readFileSync(indexHtml, "utf8");
  fs.writeFileSync(
    indexHtml,
    html.replace("</style>", "  html, body, #root { background: #224488 !important; }\n</style>"),
    "utf8"
  );
  // cue_01 over the still (0.5–1.5 s), cue_02 over the moving video (3.5–4.5 s)
  assert.ok(cli(["lane", "add-composition", "--lane", "ln_motion", "--comp-dir", compDir, "--at", "500ms", "--duration", "1000ms", "--dir", wsDir]).ok);
  assert.ok(cli(["lane", "add-composition", "--lane", "ln_motion", "--comp-dir", compDir, "--at", "3500ms", "--duration", "1000ms", "--dir", wsDir]).ok);

  const overStill = cli(["composition", "preview", "--cue", "cue_01", "--at", "0.5", "--dir", wsDir]);
  assert.equal(overStill.result.alpha_gate.covers_footage, false, overStill.raw);
  assert.equal(overStill.result.ok, true, overStill.raw);
  assert.ok(!overStill.result.diagnostics.some((d: any) => d.code === "CUTHOL-G505"), overStill.raw);

  const overVideo = cli(["composition", "preview", "--cue", "cue_02", "--at", "0.5", "--dir", wsDir]);
  assert.equal(overVideo.result.alpha_gate.covers_footage, true, overVideo.raw);
  assert.equal(overVideo.result.ok, false, overVideo.raw);
  assert.ok(overVideo.result.diagnostics.some((d: any) => d.code === "CUTHOL-G505"), overVideo.raw);
});
