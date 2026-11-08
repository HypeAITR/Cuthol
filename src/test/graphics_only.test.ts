/**
 * graphics-only projects (no spine clips).
 *
 * 1. A project whose picture comes entirely from HyperFrames compositions on a lane, with a voiceover lane
 *    for sound: the sequence length is the end of the latest lane cue, verify is clean, render produces
 *    exactly that many frames, and the frames show the composition, not the stage backdrop.
 * 2. A stretch where no visual cue is on screen (voiceover only) is reported by verify (G308) and by the
 *    post-render scan; the composition-covered frames are not.
 * 3. A project with nothing on it is reported clearly (G307): a warning from verify, a refusal from render.
 * 4. `workspace backdrop` changes the base colour of a graphics-only video through the journal.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const CLI = path.resolve(process.cwd(), "dist/cli.js");
const COMP_COLOR = "#E0402A";

function cli(args: string[]): { ok: boolean; result: any; raw: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const raw = `${proc.stdout ?? ""}`;
  let env: any = null;
  try {
    env = JSON.parse(raw);
  } catch {
    // keep raw for the assertion message
  }
  return {
    ok: Boolean(env?.ok),
    result: env?.result ?? env,
    raw: raw.slice(0, 3000) + (proc.stderr ?? "").slice(0, 1000),
  };
}

function codes(diags: any[] | undefined): string[] {
  return (diags ?? []).map((d: any) => d.code);
}

function pixelAt(mp4: string, atSec: number): number[] {
  const px = spawnSync(
    "ffmpeg",
    ["-v", "error", "-ss", String(atSec), "-i", mp4, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: 1024 }
  ).stdout as Buffer;
  return [...px];
}

function countFrames(mp4: string): number {
  const out = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", mp4],
    { encoding: "utf8" }
  ).stdout;
  return Number(String(out).trim());
}

/** Workspace with a 4 s tone on ln_vo and one opaque full-frame composition scaffolded (not yet placed). */
function setUpGraphicsOnlyWorkspace(name: string): { wsDir: string; compDir: string } {
  const wsDir = path.join(TEST_ROOT, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "1:1", "--fps", "30"]).ok);

  const wav = path.join(wsDir, "vo.wav");
  assert.equal(
    spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=4", "-ac", "2", wav]).status,
    0
  );
  const ingest = cli(["library", "ingest", wav, "--dir", wsDir]);
  assert.ok(ingest.ok, ingest.raw);
  const vo = cli(["lane", "add-cue", "--lane", "ln_vo", "--kind", "voiceover", "--asset", "aud_01", "--at", "0ms", "--duration", "4000ms", "--dir", wsDir]);
  assert.ok(vo.ok, vo.raw);

  const compDir = path.join(wsDir, "compositions", "card");
  const scaffold = cli(["composition", "scaffold", "--comp-dir", compDir, "--duration", "3s", "--dir", wsDir]);
  assert.ok(scaffold.ok, scaffold.raw);
  const indexHtml = path.join(compDir, "index.html");
  const html = fs.readFileSync(indexHtml, "utf8");
  fs.writeFileSync(
    indexHtml,
    html.replace("</style>", `  html, body, #root { background: ${COMP_COLOR} !important; }\n</style>`),
    "utf8"
  );
  return { wsDir, compDir };
}

test("1. Graphics-only project: length from lanes, clean verify, render shows the compositions", () => {
  const { wsDir, compDir } = setUpGraphicsOnlyWorkspace("graphics_only");

  // Voiceover alone: nothing visual on screen, verify says so (G308) instead of staying silent.
  const voOnly = cli(["verify", "--dir", wsDir]);
  assert.ok(voOnly.ok, voOnly.raw);
  assert.ok(codes(voOnly.result.diagnostics).includes("CUTHOL-G308"), voOnly.raw);

  // Two compositions back to back cover 0..4400 ms, past the 4000 ms voiceover.
  const c1 = cli(["lane", "add-composition", "--lane", "ln_motion", "--comp-dir", compDir, "--at", "0ms", "--duration", "2000ms", "--dir", wsDir]);
  assert.ok(c1.ok, c1.raw);
  const c2 = cli(["lane", "add-composition", "--lane", "ln_motion", "--comp-dir", compDir, "--at", "2000ms", "--duration", "2400ms", "--dir", wsDir]);
  assert.ok(c2.ok, c2.raw);

  const verify = cli(["verify", "--dir", wsDir]);
  assert.ok(verify.ok, verify.raw);
  assert.equal(verify.result.error_count, 0, verify.raw);
  assert.equal(verify.result.warning_count, 0, verify.raw);

  const brief = spawnSync(process.execPath, [CLI, "brief", "--dir", wsDir], { encoding: "utf8" }).stdout;
  assert.match(brief, /Sequence Duration: `4400ms`/);
  assert.match(brief, /graphics-only/);

  const frame = cli(["monitor", "frame", "--at", "3s", "--boxes", "false", "--dir", wsDir]);
  assert.ok(frame.ok, frame.raw);
  assert.equal(frame.result.metrics.is_blank_frame, false, frame.raw);
  assert.ok(frame.result.metrics.active_handles.includes("cue_03"), frame.raw);

  const preview = cli(["composition", "preview", "--cue", "cue_02", "--at", "0.5", "--dir", wsDir]);
  assert.equal(preview.result.ok, true, preview.raw);
  assert.equal(preview.result.alpha_gate.covers_footage, false, preview.raw);
  // A voiceover under the composition is not footage to check contrast against.
  assert.equal(preview.result.contrast_check_ran_on_footage, false, preview.raw);

  const render = cli(["render", "--preset", "draft_480p", "--out", "output/gfx.mp4", "--dir", wsDir]);
  assert.ok(render.ok, render.raw);
  assert.equal(render.result.duration_ms, 4400, render.raw);
  assert.equal(render.result.blank_scan.total_frames, 132, render.raw);
  assert.equal(render.result.blank_scan.blank_frames_count, 0, JSON.stringify(render.result.blank_scan.events));

  const outMp4 = path.join(wsDir, "output", "gfx.mp4");
  assert.equal(countFrames(outMp4), 132);
  // 1 s and 4.2 s (past the voiceover) both show the composition colour, not the dark stage backdrop.
  for (const t of [1, 4.2]) {
    const [r, g, b] = pixelAt(outMp4, t);
    assert.ok(r > 180 && g < 110 && b < 90, `expected composition colour at ${t}s, got rgb(${r},${g},${b})`);
  }
  const audioDur = Number(
    spawnSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=duration", "-of", "csv=p=0", outMp4], {
      encoding: "utf8",
    }).stdout.trim()
  );
  assert.ok(Math.abs(audioDur - 4.4) < 0.05, `audio duration ${audioDur}`);
});

test("2. Backdrop-only stretch in a graphics-only project is reported by verify and the render scan", () => {
  const { wsDir, compDir } = setUpGraphicsOnlyWorkspace("backdrop_gap");
  assert.ok(cli(["lane", "add-composition", "--lane", "ln_motion", "--comp-dir", compDir, "--at", "0ms", "--duration", "2000ms", "--dir", wsDir]).ok);

  const verify = cli(["verify", "--dir", wsDir]);
  assert.ok(verify.ok, verify.raw);
  const gap = verify.result.diagnostics.find((d: any) => d.code === "CUTHOL-G308");
  assert.ok(gap, verify.raw);
  assert.match(gap.what, /2000\.\.4000ms/);

  const render = cli(["render", "--preset", "draft_480p", "--out", "output/gap.mp4", "--dir", wsDir]);
  assert.ok(render.ok, render.raw);
  assert.equal(render.result.duration_ms, 4000, render.raw);
  const scan = render.result.blank_scan;
  assert.equal(scan.total_frames, 120, render.raw);
  // Only the voiceover-only frames (2.0..4.0 s); the composition frames before them are not judged. The
  // overlay window is half-open, so the frame at exactly 2.0 s no longer shows the cue.
  assert.equal(scan.events.length, 1, JSON.stringify(scan.events));
  assert.equal(scan.events[0].start_frame, 60, JSON.stringify(scan.events));
  assert.equal(scan.events[0].end_frame, 120, JSON.stringify(scan.events));
  assert.equal(scan.events[0].clip_id, "", JSON.stringify(scan.events));
  assert.ok(codes(scan.diagnostics).includes("CUTHOL-G502"), render.raw);
});

test("3. An empty project is reported clearly: verify warns, render refuses", () => {
  const wsDir = path.join(TEST_ROOT, "empty");
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "16:9", "--fps", "30"]).ok);

  const verify = cli(["verify", "--dir", wsDir]);
  assert.ok(verify.ok, verify.raw);
  assert.equal(verify.result.error_count, 0, verify.raw);
  assert.deepEqual(codes(verify.result.diagnostics), ["CUTHOL-G307"], verify.raw);

  const render = cli(["render", "--preset", "draft_480p", "--dir", wsDir]);
  assert.equal(render.ok, false, render.raw);
  assert.match(render.raw, /CUTHOL-G307/);
  assert.ok(!fs.existsSync(path.join(wsDir, "output")) || fs.readdirSync(path.join(wsDir, "output")).length === 0);

  const sheet = cli(["monitor", "sheet", "--grid", "2x1", "--dir", wsDir]);
  assert.ok(sheet.ok, sheet.raw);
  assert.deepEqual(codes(sheet.result.diagnostics), ["CUTHOL-G307"], sheet.raw);

  const brief = spawnSync(process.execPath, [CLI, "brief", "--lens", "flow", "--dir", wsDir], { encoding: "utf8" }).stdout;
  assert.match(brief, /the sequence is empty/);
});

test("4. workspace backdrop sets the base colour (journaled, undoable) and render, monitor and blank scan use it", () => {
  const { wsDir, compDir } = setUpGraphicsOnlyWorkspace("backdrop_color");
  assert.ok(cli(["lane", "add-composition", "--lane", "ln_motion", "--comp-dir", compDir, "--at", "0ms", "--duration", "2000ms", "--dir", wsDir]).ok);
  const seqFile = path.join(wsDir, "cuthol.sequence.json");
  const readColor = (): string => JSON.parse(fs.readFileSync(seqFile, "utf8")).stage.backdrop.color;
  const before = readColor();

  const bad = cli(["workspace", "backdrop", "--color", "#12345", "--dir", wsDir]);
  assert.equal(bad.ok, false, bad.raw);
  assert.match(bad.raw, /CUTHOL-SYS07/);
  assert.equal(readColor(), before);

  const set = cli(["workspace", "backdrop", "--color", "#ffd340", "--dir", wsDir]);
  assert.ok(set.ok, set.raw);
  assert.equal(set.result.backdrop.color, "#FFD340", set.raw);
  assert.equal(set.result.previous_color, before, set.raw);
  assert.equal(readColor(), "#FFD340");
  assert.match(set.raw, /stage\.backdrop\.color=#FFD340 \(was /);

  const render = cli(["render", "--preset", "draft_480p", "--out", "output/yellow.mp4", "--dir", wsDir]);
  assert.ok(render.ok, render.raw);
  const outMp4 = path.join(wsDir, "output", "yellow.mp4");
  // 3 s has only the voiceover: the frame is the new backdrop colour.
  const [r, g, b] = pixelAt(outMp4, 3);
  assert.ok(Math.abs(r - 255) <= 6 && Math.abs(g - 211) <= 6 && Math.abs(b - 64) <= 8, `expected #FFD340 at 3s, got rgb(${r},${g},${b})`);
  // The blank detector compares against the new colour, so the voiceover-only stretch is still found.
  assert.equal(render.result.blank_scan.events.length, 1, JSON.stringify(render.result.blank_scan.events));

  const frame = cli(["monitor", "frame", "--at", "3s", "--boxes", "false", "--dir", wsDir]);
  assert.ok(frame.ok, frame.raw);
  assert.equal(frame.result.metrics.is_blank_frame, true, frame.raw);
  assert.ok(frame.result.metrics.luma_mean > 180, frame.raw);

  const rev = JSON.parse(fs.readFileSync(seqFile, "utf8")).meta.revision;
  const undo = cli(["workspace", "journal", "undo", "--expect-rev", String(rev), "--dir", wsDir]);
  assert.ok(undo.ok, undo.raw);
  assert.equal(readColor(), before);
});
