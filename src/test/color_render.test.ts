/**
 * Colour stage in the render: static `lut3d` compile, keyframed `haldclut` compile,
 * HDR input transform, and the G440–G444 diagnostics.
 */
process.env.CUTHOL_ENCODER = "x264";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compileColorStageFilters,
  compiledColorLutInfo,
  MAX_COLOR_KEYFRAMED_FRAMES,
  type ColorCompileItem,
} from "../color/compile.js";
import {
  inputTransformFilters,
  resolveInputTransform,
} from "../color/input_transform.js";
import { listColorItems } from "../color/blocks.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { initWorkspace, loadSequence, updateSequenceInPlace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip, setItemEnvelope } from "../sequence/spine_edit.js";

const TEST_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-cr-"));

let cachedMedia: string | null = null;
function ensureMedia(): string {
  if (cachedMedia && fs.existsSync(cachedMedia)) return cachedMedia;
  const out = path.join(TEST_TMP, "cr_src.mp4");
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "4",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      out,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, `synthetic media failed: ${proc.stderr}`);
  cachedMedia = out;
  return out;
}

function makeWs(name: string, clipOutMs: number): string {
  const wsDir = path.join(TEST_TMP, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [ensureMedia()] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: clipOutMs });
  return wsDir;
}

function compileForClip(
  wsDir: string,
  opts: { fps?: number; durationMs?: number; isRgb?: boolean } = {}
): { filters: string[]; inputs: string[][] } {
  const { sequence } = loadSequence(wsDir);
  const item = listColorItems(sequence).find((c) => c.track === "spine")!;
  assert.ok(item, "expected a spine item");
  const inputs: string[][] = [];
  const req: ColorCompileItem = {
    item,
    asset: sequence.library[0],
    envelopes: sequence.spine.clips[0].envelopes,
    fps: opts.fps ?? 30,
    durationMs: opts.durationMs ?? sequence.spine.clips[0].duration_ms,
    isRgb: opts.isRgb ?? false,
    backFormat: opts.isRgb ? "rgba" : "yuv420p",
    srcRange: "tv",
  };
  const filters = compileColorStageFilters(
    sequence,
    { rootDir: wsDir, addInput: (args: string[]) => (inputs.push(args), inputs.length - 1) },
    req
  );
  return { filters, inputs };
}

test("identity stage compiles to [] and reports null LUT info", () => {
  const wsDir = makeWs("ws_cr_identity", 1000);
  const { sequence } = loadSequence(wsDir);
  const item = listColorItems(sequence).find((c) => c.track === "spine")!;
  assert.deepEqual(compileForClip(wsDir).filters, []);
  assert.equal(compiledColorLutInfo(sequence, wsDir, item), null);
});

test("static stage compiles to one gbrp16le lut3d filter and writes the blob once", () => {
  const wsDir = makeWs("ws_cr_static", 1000);
  updateSequenceInPlace(wsDir, (seq) => {
    seq.spine.clips[0].treatments.color = {
      exposure: { stops: 0.5 },
      saturation: { saturation: 1.2 },
    };
  });
  const { sequence } = loadSequence(wsDir);
  const item = listColorItems(sequence).find((c) => c.track === "spine")!;
  const info = compiledColorLutInfo(sequence, wsDir, item);
  assert.ok(info, "expected LUT info");
  assert.equal(info!.size, 33);
  assert.ok(fs.existsSync(info!.file), `missing blob ${info!.file}`);
  assert.ok(info!.file.startsWith(path.join(wsDir, ".cuthol", "blobs", "color")), info!.file);
  const { filters, inputs } = compileForClip(wsDir);
  assert.equal(filters.length, 1);
  assert.match(filters[0], /format=gbrp16le,lut3d=file='.*\.cube',scale=out_color_matrix=bt709/);
  assert.match(filters[0], /format=yuv420p$/);
  assert.deepEqual(inputs, []);
  // Second compile reuses the blob (no rewrite, same hash).
  const mtime = fs.statSync(info!.file).mtimeMs;
  compileForClip(wsDir);
  assert.equal(fs.statSync(info!.file).mtimeMs, mtime);
});

test("keyframed exposure compiles to a haldclut frame sequence", () => {
  const wsDir = makeWs("ws_cr_key", 2000);
  updateSequenceInPlace(wsDir, (seq) => {
    seq.spine.clips[0].treatments.color = { exposure: { stops: 0 } };
  });
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_01",
    parameter: "color.exposure.stops",
    points: [
      { offset_ms: 0, value: -1, easing: "linear" },
      { offset_ms: 2000, value: 1, easing: "linear" },
    ],
  });
  const { filters, inputs } = compileForClip(wsDir);
  assert.equal(filters.length, 1);
  assert.match(filters[0], /haldclut/);
  assert.equal(inputs.length, 1);
  assert.ok(inputs[0].join(" ").includes("frame_%06d.png"));
  const dir = path.dirname(inputs[0][inputs[0].length - 1]);
  const frames = fs.readdirSync(dir).filter((f) => /^frame_\d+\.png$/.test(f));
  assert.equal(frames.length, 60);
});

test("keyframed frame limit raises G442 with the number", () => {
  const wsDir = makeWs("ws_cr_limit", 1000);
  updateSequenceInPlace(wsDir, (seq) => {
    seq.spine.clips[0].treatments.color = { exposure: { stops: 0 } };
  });
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_01",
    parameter: "color.exposure.stops",
    points: [
      { offset_ms: 0, value: -1, easing: "linear" },
      { offset_ms: 1000, value: 1, easing: "linear" },
    ],
  });
  const { sequence } = loadSequence(wsDir);
  const item = listColorItems(sequence).find((c) => c.track === "spine")!;
  const inputs: string[][] = [];
  assert.throws(
    () =>
      compileColorStageFilters(
        sequence,
        { rootDir: wsDir, addInput: (a: string[]) => (inputs.push(a), inputs.length - 1) },
        {
          item,
          asset: sequence.library[0],
          envelopes: sequence.spine.clips[0].envelopes,
          fps: MAX_COLOR_KEYFRAMED_FRAMES + 60,
          durationMs: 1000,
          isRgb: false,
          backFormat: "yuv420p",
          srcRange: "tv",
        }
      ),
    (err: unknown) =>
      err instanceof CutholError &&
      err.diagnostic.code === "CUTHOL-G442" &&
      err.diagnostic.what.includes(String(MAX_COLOR_KEYFRAMED_FRAMES + 60))
  );
});

test("input transform: SDR auto is none, transfer tags resolve, explicit wins", () => {
  const wsDir = makeWs("ws_cr_input", 1000);
  const { sequence } = loadSequence(wsDir);
  const asset = sequence.library[0];
  assert.equal(resolveInputTransform(asset).kind, "none");
  assert.deepEqual(inputTransformFilters(asset), []);
  const hlg = { ...asset, probe: { ...asset.probe, color_transfer: "arib-std-b67" } };
  assert.equal(resolveInputTransform(hlg as never).kind, "hlg_to_sdr");
  assert.ok(inputTransformFilters(hlg as never).length > 0);
  const pq = { ...asset, probe: { ...asset.probe, color_transfer: "smpte2084" } };
  assert.equal(resolveInputTransform(pq as never).kind, "pq_to_sdr");
  const off = {
    ...hlg,
    color_source: { ...(hlg as { color_source?: object }).color_source, input: "none" as const },
  };
  assert.equal(resolveInputTransform(off as never).kind, "none");
  const force = {
    ...asset,
    color_source: { input: "pq_to_sdr" as const },
  };
  assert.equal(resolveInputTransform(force as never).kind, "pq_to_sdr");
});

test("G440-G444 diagnostics exist with the right codes and severities", () => {
  assert.equal(DIAGNOSTICS.COLOR_LUT_SELFTEST_ABOVE_LIMIT("x", 1.5).code, "CUTHOL-G440");
  assert.equal(DIAGNOSTICS.COLOR_LUT_SELFTEST_ABOVE_LIMIT("x", 1.5).severity, "WARN");
  assert.ok(DIAGNOSTICS.COLOR_LUT_SELFTEST_ABOVE_LIMIT("x", 1.5).what.includes("1.50"));
  assert.equal(DIAGNOSTICS.COLOR_LOOK_LUT_UNREADABLE("x", "l.cube", "bad").code, "CUTHOL-G441");
  assert.equal(DIAGNOSTICS.COLOR_LOOK_LUT_UNREADABLE("x", "l.cube", "bad").severity, "ERROR");
  assert.equal(DIAGNOSTICS.COLOR_ENVELOPE_TOO_MANY_FRAMES("x", 7, 5).code, "CUTHOL-G442");
  assert.ok(DIAGNOSTICS.COLOR_ENVELOPE_TOO_MANY_FRAMES("x", 7, 5).what.includes("7"));
  assert.equal(DIAGNOSTICS.COLOR_INPUT_TRANSFORM_UNAVAILABLE("x", "hlg_to_sdr").code, "CUTHOL-G443");
  assert.equal(DIAGNOSTICS.COLOR_HALD_RENDER_FAILED("x", "boom").code, "CUTHOL-G444");
});

test("unreadable Look LUT raises G441", () => {
  const wsDir = makeWs("ws_cr_look", 1000);
  updateSequenceInPlace(wsDir, (seq) => {
    (seq as { looks?: unknown[] }).looks = [
      { id: "lk1", name: "bad", lut_uri: "looks/missing.cube", apply_to: "all" },
    ];
    seq.spine.clips[0].treatments.color = { saturation: { saturation: 1.1 } };
  });
  const { sequence } = loadSequence(wsDir);
  const item = listColorItems(sequence).find((c) => c.track === "spine")!;
  assert.throws(
    () => compiledColorLutInfo(sequence, wsDir, item),
    (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G441"
  );
});

test("keyframed colour keeps channel order: a constant warm envelope renders like the static stage", () => {
  // haldclut on planar RGB swaps red and blue in ffmpeg 8.1; the keyframed path must use packed RGB.
  const src = path.join(TEST_TMP, "cr_patch.mkv");
  const mk = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x8C6E5A:s=64x64:d=1", "-frames:v", "1", "-pix_fmt", "yuv420p", "-c:v", "ffv1", src], { encoding: "utf8" });
  assert.equal(mk.status, 0, mk.stderr);
  const run = (wsDir: string): number[] => {
    const { sequence } = loadSequence(wsDir);
    const item = listColorItems(sequence).find((c) => c.track === "spine")!;
    const inputs: string[][] = [];
    const filters = compileColorStageFilters(
      sequence,
      { rootDir: wsDir, addInput: (args: string[]) => (inputs.push(args), inputs.length) },
      { item, asset: sequence.library[0], envelopes: sequence.spine.clips[0].envelopes, fps: 30, durationMs: 1000, isRgb: false, backFormat: "yuv420p", srcRange: "tv" }
    );
    assert.equal(filters.length, 1);
    const args = ["-v", "error", "-i", src, ...inputs.flat(), "-filter_complex", `[0:v]${filters[0]},scale=in_color_matrix=bt709:in_range=tv,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"];
    const p = spawnSync("ffmpeg", args, { cwd: wsDir, encoding: "buffer" });
    assert.equal(p.status, 0, String(p.stderr));
    const b = p.stdout;
    let r = 0, g = 0, bl = 0;
    const n = b.length / 3;
    for (let i = 0; i < n; i++) { r += b[i * 3]; g += b[i * 3 + 1]; bl += b[i * 3 + 2]; }
    return [r / n, g / n, bl / n];
  };
  const wsStatic = makeWs("ws_cr_order_static", 1000);
  updateSequenceInPlace(wsStatic, (seq) => { seq.spine.clips[0].treatments.color = { white_balance: { temp_mired: 40, tint: 0 } }; });
  const wsKey = makeWs("ws_cr_order_key", 1000);
  updateSequenceInPlace(wsKey, (seq) => { seq.spine.clips[0].treatments.color = { white_balance: { temp_mired: 0, tint: 0 } }; });
  setItemEnvelope({
    workspaceDir: wsKey,
    targetId: "sp_01",
    parameter: "color.white_balance.temp_mired",
    points: [{ offset_ms: 0, value: 40, easing: "linear" }, { offset_ms: 1000, value: 40, easing: "linear" }],
  });
  const a = run(wsStatic);
  const k = run(wsKey);
  assert.ok(a[0] > a[2] + 20, `static warm: R ${a[0]} should exceed B ${a[2]}`);
  // Up to ~4/255 comes from interpolating twice (33-cube -> Hald 64-grid -> haldclut); a channel swap is ~40.
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(a[c] - k[c]) < 6, `channel ${c}: static ${a[c].toFixed(1)} vs keyframed ${k[c].toFixed(1)}`);
});
