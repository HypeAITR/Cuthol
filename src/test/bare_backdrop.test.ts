/**
 * Bare backdrop under a transparent composition (K2): in a spine-less project,
 * a span whose only picture is a transparent composition with mostly-empty
 * alpha shows bare stage backdrop. Verify reports it once (single aggregate
 * INFO diagnostic naming the spans and the backdrop color). The alpha fill
 * comes from the cached composition measurement sidecar; without a
 * measurement, or with a spine, or with dense content, the check stays silent.
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
  return {
    ok: Boolean(env?.ok),
    result: env?.result ?? env,
    raw: raw.slice(0, 3000) + (proc.stderr ?? "").slice(0, 1000),
  };
}

function codes(diags: any[] | undefined): string[] {
  return (diags ?? []).map((d: any) => d.code);
}

function readSequence(wsDir: string): any {
  return JSON.parse(fs.readFileSync(path.join(wsDir, "cuthol.sequence.json"), "utf8"));
}

/** Transparent scaffold whose only painted pixel area is a centered 25%x25% box. */
function scaffoldSparseBoxComposition(wsDir: string, compName: string): string {
  const compDir = path.join(wsDir, "compositions", compName);
  const scaffold = cli(["composition", "scaffold", "--comp-dir", compDir, "--duration", "2s", "--dir", wsDir]);
  assert.ok(scaffold.ok, scaffold.raw);
  const indexHtml = path.join(compDir, "index.html");
  const html = fs.readFileSync(indexHtml, "utf8");
  fs.writeFileSync(
    indexHtml,
    html.replace(
      "</style>",
      "  #root > * { display: none !important; }\n" +
        "  #root::after { content: ''; position: absolute; left: 37.5%; top: 37.5%; width: 25%; height: 25%; background: #20E020; }\n</style>"
    ),
    "utf8"
  );
  return compDir;
}

/** Transparent scaffold painted fullscreen opaque green (dense alpha). */
function scaffoldDenseComposition(wsDir: string, compName: string): string {
  const compDir = path.join(wsDir, "compositions", compName);
  const scaffold = cli(["composition", "scaffold", "--comp-dir", compDir, "--duration", "2s", "--dir", wsDir]);
  assert.ok(scaffold.ok, scaffold.raw);
  const indexHtml = path.join(compDir, "index.html");
  const html = fs.readFileSync(indexHtml, "utf8");
  fs.writeFileSync(
    indexHtml,
    html.replace(
      "</style>",
      "  html, body, #root { background: #20E020 !important; }\n  #root > * { display: none !important; }\n</style>"
    ),
    "utf8"
  );
  return compDir;
}

function sidecarPath(compDir: string): string {
  return path.join(compDir, "assets", "cuthol-bbox.json");
}

test("spine-less spans under a mostly-empty transparent composition get one aggregate notice", () => {
  const wsDir = path.join(TEST_ROOT, "bare_backdrop_agg");
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "16:9", "--fps", "30"]).ok);
  const compDir = scaffoldSparseBoxComposition(wsDir, "badge");
  assert.ok(cli(["lane", "add-composition", "--lane", "ln_motion", "--comp-dir", compDir, "--at", "0ms", "--duration", "2000ms", "--dir", wsDir]).ok);
  assert.ok(cli(["lane", "add-composition", "--lane", "ln_motion", "--comp-dir", compDir, "--at", "3000ms", "--duration", "1000ms", "--dir", wsDir]).ok);

  const frame = cli(["monitor", "frame", "--at", "1000ms", "--boxes", "false", "--dir", wsDir]);
  assert.ok(frame.ok, frame.raw);
  assert.ok(fs.existsSync(sidecarPath(compDir)), "alpha measurement sidecar must exist before verify");

  const verify = cli(["verify", "--dir", wsDir]);
  assert.ok(verify.ok, verify.raw);
  const notices = (verify.result.diagnostics ?? []).filter((d: any) => d.code === "CUTHOL-G316");
  assert.equal(notices.length, 1, `expected a single aggregate notice, got: ${verify.raw}`);
  assert.equal(notices[0].severity, "INFO", verify.raw);
  assert.match(notices[0].what, /0\.\.2000ms/, verify.raw);
  assert.match(notices[0].what, /3000\.\.4000ms/, verify.raw);
  assert.match(notices[0].what, new RegExp(readSequence(wsDir).stage.backdrop.color.replace("#", "#?")), verify.raw);
  assert.match(notices[0].formatted, /Suggestion: /, verify.raw);
  // The truly empty middle stretch still reports G308 next to the new notice.
  const gap = (verify.result.diagnostics ?? []).find((d: any) => d.code === "CUTHOL-G308");
  assert.ok(gap, verify.raw);
  assert.match(gap.what, /2000\.\.3000ms/, verify.raw);
});

test("no notice when a spine is present", () => {
  const wsDir = path.join(TEST_ROOT, "bare_backdrop_spine");
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "16:9", "--fps", "30"]).ok);
  assert.equal(
    spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=3,format=yuv420p", path.join(wsDir, "red.mp4")]).status,
    0
  );
  assert.ok(cli(["library", "ingest", path.join(wsDir, "red.mp4"), "--dir", wsDir]).ok);
  assert.ok(cli(["spine", "append", "--asset", "vid_01", "--in", "0s", "--out", "3s", "--dir", wsDir]).ok);
  const compDir = scaffoldSparseBoxComposition(wsDir, "badge");
  assert.ok(cli(["lane", "add-composition", "--lane", "ln_motion", "--comp-dir", compDir, "--at", "1000ms", "--duration", "1000ms", "--dir", wsDir]).ok);

  const frame = cli(["monitor", "frame", "--at", "1500ms", "--boxes", "false", "--dir", wsDir]);
  assert.ok(frame.ok, frame.raw);
  assert.ok(fs.existsSync(sidecarPath(compDir)), "alpha measurement sidecar must exist before verify");

  const verify = cli(["verify", "--dir", wsDir]);
  assert.ok(verify.ok, verify.raw);
  assert.ok(!codes(verify.result.diagnostics).includes("CUTHOL-G316"), verify.raw);
});

test("no notice for dense fullscreen content", () => {
  const wsDir = path.join(TEST_ROOT, "bare_backdrop_dense");
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "16:9", "--fps", "30"]).ok);
  const compDir = scaffoldDenseComposition(wsDir, "card");
  assert.ok(cli(["lane", "add-composition", "--lane", "ln_motion", "--comp-dir", compDir, "--at", "0ms", "--duration", "2000ms", "--dir", wsDir]).ok);

  const frame = cli(["monitor", "frame", "--at", "1000ms", "--boxes", "false", "--dir", wsDir]);
  assert.ok(frame.ok, frame.raw);
  assert.ok(fs.existsSync(sidecarPath(compDir)), "alpha measurement sidecar must exist before verify");

  const verify = cli(["verify", "--dir", wsDir]);
  assert.ok(verify.ok, verify.raw);
  assert.ok(!codes(verify.result.diagnostics).includes("CUTHOL-G316"), verify.raw);
});

test("no notice without a cached alpha measurement", () => {
  const wsDir = path.join(TEST_ROOT, "bare_backdrop_unmeasured");
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "16:9", "--fps", "30"]).ok);
  const compDir = scaffoldSparseBoxComposition(wsDir, "badge");
  assert.ok(cli(["lane", "add-composition", "--lane", "ln_motion", "--comp-dir", compDir, "--at", "0ms", "--duration", "2000ms", "--dir", wsDir]).ok);
  assert.ok(!fs.existsSync(sidecarPath(compDir)), "no measurement must exist for this case");

  const verify = cli(["verify", "--dir", wsDir]);
  assert.ok(verify.ok, verify.raw);
  assert.ok(!codes(verify.result.diagnostics).includes("CUTHOL-G316"), verify.raw);
});
