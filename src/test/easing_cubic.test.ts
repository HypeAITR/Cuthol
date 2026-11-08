/**
 * cubic-bezier easing in parameter envelopes (`src/test/easing_cubic.test.ts`).
 *
 * - Compiled FFmpeg expressions evaluated by ffmpeg itself (`aevalsrc` + `f32le`
 *   sampling) agree with `evaluateEnvelopeAt` (max normalized error < 1e-3;
 *   requirement is <= 0.002).
 * - The four legacy easings compile to byte-identical text (pre-gate output).
 * - `spine split` preserves bezier segments (de Casteljau subdivision).
 * - CLI `--easing "cubic-bezier(...)"`, MCP `bezier` param, G120 at input + verify.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileEnvelopeToFfmpegExpr } from "../compositor/compile_filters.js";
import { CutholError } from "../core/diagnostics.js";
import { cubicBezierY, parseEasingFlag } from "../core/easing.js";
import { CubicBezierControlPoints, ParameterEnvelope } from "../core/schema.js";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { buildCliArgv, findActionSpec } from "../mcp/catalog.js";
import {
  appendSpineClip,
  evaluateEnvelopeAt,
  setItemEnvelope,
  sliceEnvelopes,
  splitSpineClip,
} from "../sequence/spine.js";
import { verifySequence } from "../verify/gates.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

const CURVES: Record<string, CubicBezierControlPoints> = {
  css_default: [0.25, 0.1, 0.25, 1],
  css_inout: [0.42, 0, 0.58, 1],
  linear_eq: [0, 0, 1, 1],
  extreme: [0.9, -0.5, 0.1, 1.5],
};

function sampleFfmpegExpr(expr: string, pointCount: number, rate = 4000): number[] {
  const dur = pointCount / rate;
  const out = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-e1-")),
    "samples.raw"
  );
  const proc = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=exprs='${expr}':s=${rate}:d=${dur}`,
      "-f",
      "f32le",
      "-ac",
      "1",
      "-ar",
      String(rate),
      "-y",
      out,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, `aevalsrc failed: ${(proc.stderr ?? "").slice(-800)}`);
  const buf = fs.readFileSync(out);
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  const vals = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  return Array.from(vals.slice(0, pointCount));
}

function cli(args: string[]): { ok: boolean; raw: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  let env: { ok?: boolean } | null = null;
  try {
    env = JSON.parse(`${proc.stdout ?? ""}`);
  } catch {
    // keep raw for the assertion message
  }
  return { ok: Boolean(env?.ok), raw: raw.slice(0, 4000) };
}

function ensureVideo(): string {
  const dir = path.join(TEST_ROOT, "easing_cubic_media");
  fs.mkdirSync(dir, { recursive: true });
  const videoPath = path.join(dir, "source_6s.mp4");
  if (!fs.existsSync(videoPath)) {
    const proc = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=30:d=6",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=6",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        videoPath,
      ],
      { encoding: "utf8" }
    );
    assert.equal(proc.status, 0, `FFmpeg failed: ${proc.stderr}`);
  }
  return videoPath;
}

function setupWs(name: string): string {
  const wsDir = path.join(TEST_ROOT, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [ensureVideo()] });
  return wsDir;
}

function twoPointEnv(
  bezier: CubicBezierControlPoints,
  lo = 0,
  hi = 1
): ParameterEnvelope {
  return {
    parameter: "placement.opacity",
    points: [
      { offset_ms: 0, value: lo, easing: "linear" },
      { offset_ms: 1000, value: hi, easing: "cubic_bezier", bezier },
    ],
  };
}

test("1. Compiled cubic-bezier expression matches the JS evaluator (ffmpeg-evaluated)", () => {
  for (const [name, b] of Object.entries(CURVES)) {
    const env = twoPointEnv(b, 0.2, 0.9);
    const expr = compileEnvelopeToFfmpegExpr({
      envelope: env,
      timeBaseOffsetMs: 0,
      mode: "raw",
    });
    assert.ok(expr && expr.includes("ld(0)"), `${name}: expected the Newton solver fragment`);
    const samples = sampleFfmpegExpr(expr, 4000);
    let maxErr = 0;
    for (let i = 0; i < samples.length; i++) {
      const expected = evaluateEnvelopeAt(env, (i / 4000) * 1000);
      const err = Math.abs(samples[i] - expected);
      if (err > maxErr) maxErr = err;
    }
    console.log(`   [e1] ${name}: max |ffmpeg - js| = ${maxErr.toExponential(2)} (len ${expr.length})`);
    assert.ok(maxErr < 1e-3, `${name}: max error ${maxErr} exceeds 1e-3`);
  }
});

test("2. Gain (dB-space) and pixel_offset envelopes use the same cubic easing", () => {
  const b: CubicBezierControlPoints = [0.25, 0.1, 0.25, 1];
  const dbEnv: ParameterEnvelope = {
    parameter: "audio_chain.gain_db",
    points: [
      { offset_ms: 0, value: -6, easing: "linear" },
      { offset_ms: 1000, value: 0, easing: "cubic_bezier", bezier: b },
    ],
  };
  const dbExpr = compileEnvelopeToFfmpegExpr({
    envelope: dbEnv,
    timeBaseOffsetMs: 0,
    mode: "db_to_linear",
    baseGainDb: 0,
  });
  assert.ok(dbExpr && dbExpr.includes("ld(0)"), "dB envelope must carry the cubic solver");
  const dbSamples = sampleFfmpegExpr(dbExpr, 800, 800);
  let dbMaxErr = 0;
  for (let i = 0; i < dbSamples.length; i++) {
    const u = cubicBezierY(b, i / 800);
    const expected = Math.pow(10, (-6 + 6 * u) / 20);
    dbMaxErr = Math.max(dbMaxErr, Math.abs(dbSamples[i] - expected));
  }
  console.log(`   [e1] db_to_linear: max err = ${dbMaxErr.toExponential(2)}`);
  assert.ok(dbMaxErr < 1e-3, `dB max error ${dbMaxErr} exceeds 1e-3`);

  const pxEnv: ParameterEnvelope = {
    parameter: "placement.x_pct",
    points: [
      { offset_ms: 0, value: -10, easing: "linear" },
      { offset_ms: 1000, value: 10, easing: "cubic_bezier", bezier: b },
    ],
  };
  const pxExpr = compileEnvelopeToFfmpegExpr({
    envelope: pxEnv,
    timeBaseOffsetMs: 0,
    mode: "pixel_offset",
    baseCenterPx: 320,
    canvasDimPx: 640,
  });
  assert.ok(pxExpr && pxExpr.includes("ld(0)"), "pixel envelope must carry the cubic solver");
  const pxSamples = sampleFfmpegExpr(pxExpr, 800, 800);
  let pxMaxErr = 0;
  for (let i = 0; i < pxSamples.length; i++) {
    const u = cubicBezierY(b, i / 800);
    const expected = 320 + ((-10 + 20 * u) / 100) * 640;
    pxMaxErr = Math.max(pxMaxErr, Math.abs(pxSamples[i] - expected) / 128);
  }
  console.log(`   [e1] pixel_offset: max normalized err = ${pxMaxErr.toExponential(2)}`);
  assert.ok(pxMaxErr < 1e-3, `pixel max normalized error ${pxMaxErr} exceeds 1e-3`);
});

test("3. Legacy four easings compile to byte-identical text", () => {
  const mk = (easing: ParameterEnvelope["points"][number]["easing"]): ParameterEnvelope => ({
    parameter: "placement.opacity",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 2000, value: 1, easing },
    ],
  });
  const expr = (e: ParameterEnvelope["points"][number]["easing"]): string | null =>
    compileEnvelopeToFfmpegExpr({ envelope: mk(e), timeBaseOffsetMs: 0, mode: "raw" });
  assert.equal(expr("linear"), "if(lt(t,0),0,if(lt(t,2),0+(1)*((t-0)/2),1))");
  assert.equal(expr("ease_in"), "if(lt(t,0),0,if(lt(t,2),0+(1)*pow(((t-0)/2),2),1))");
  assert.equal(expr("ease_out"), "if(lt(t,0),0,if(lt(t,2),0+(1)*(1-pow(1-((t-0)/2),2)),1))");
  assert.equal(
    expr("ease_in_out"),
    "if(lt(t,0),0,if(lt(t,2),0+(1)*(pow(((t-0)/2),2)*(3-2*((t-0)/2))),1))"
  );
  const dbEnv: ParameterEnvelope = {
    parameter: "audio_chain.gain_db",
    points: [
      { offset_ms: 0, value: -6, easing: "linear" },
      { offset_ms: 1000, value: 0, easing: "ease_in_out" },
    ],
  };
  assert.equal(
    compileEnvelopeToFfmpegExpr({
      envelope: dbEnv,
      timeBaseOffsetMs: 500,
      mode: "db_to_linear",
      baseGainDb: 2,
    }),
    "if(lt(t,0.5),0.631,if(lt(t,1.5),pow(10,(-4+(6)*(pow(((t-0.5)/1),2)*(3-2*((t-0.5)/1))))/20),1.2589))"
  );
});

test("4. JS evaluator: endpoints, symmetry, solver residual", () => {
  for (const b of Object.values(CURVES)) {
    assert.equal(cubicBezierY(b, 0), 0);
    assert.equal(cubicBezierY(b, 1), 1);
    assert.equal(cubicBezierY(b, -0.5), 0);
    assert.equal(cubicBezierY(b, 1.5), 1);
  }
  assert.ok(Math.abs(cubicBezierY([0.42, 0, 0.58, 1], 0.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(cubicBezierY([0, 0, 1, 1], 0.5) - 0.5) < 1e-9);
  const env = twoPointEnv([0.9, -0.5, 0.1, 1.5]);
  assert.equal(evaluateEnvelopeAt(env, -100), 0);
  assert.equal(evaluateEnvelopeAt(env, 5000), 1);
  const missing: ParameterEnvelope = {
    parameter: "placement.opacity",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 1000, value: 1, easing: "cubic_bezier" },
    ],
  };
  assert.equal(evaluateEnvelopeAt(missing, 500), 0.5);
});

test("5. sliceEnvelopes keeps the bezier curve across a cut (unit)", () => {
  const env = twoPointEnv([0.25, 0.1, 0.25, 1]);
  for (const [s, e] of [[500, 1500], [0, 700], [700, 2000], [0, 1000]] as Array<[number, number]>) {
    const [sliced] = sliceEnvelopes([env], s, Math.min(e, 1000));
    assert.ok(sliced.points.length >= 2);
    for (let k = 0; k <= 8; k++) {
      const local = ((Math.min(e, 1000) - s) * k) / 8;
      const a = evaluateEnvelopeAt({ parameter: env.parameter, points: sliced.points }, local);
      const b = evaluateEnvelopeAt(env, s + local);
      assert.ok(Math.abs(a - b) < 2e-6, `slice [${s},${e}] @${local}: ${a} vs ${b}`);
    }
  }
  const [full] = sliceEnvelopes([env], 0, 1000);
  assert.deepEqual(full.points[1].bezier, [0.25, 0.1, 0.25, 1]);
});

test("6. spine split preserves bezier segments end to end", () => {
  const b1: CubicBezierControlPoints = [0.25, 0.1, 0.25, 1];
  const b2: CubicBezierControlPoints = [0.42, 0, 0.58, 1];
  const plant = (wsDir: string): void => {
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    setItemEnvelope({
      workspaceDir: wsDir,
      targetId: "sp_01",
      parameter: "placement.opacity",
      points: [
        { offset_ms: 0, value: 0, easing: "linear" },
        { offset_ms: 2000, value: 0.6, easing: "cubic_bezier", bezier: b1 },
        { offset_ms: 4000, value: 1, easing: "cubic_bezier", bezier: b2 },
      ],
    });
  };
  const checkPieces = (wsDir: string, splits: number[]): void => {
    const before = loadSequence(wsDir).sequence.spine.clips[0].envelopes[0];
    splitSpineClip({ workspaceDir: wsDir, clipId: "sp_01", splitPointsMs: splits });
    const clips = loadSequence(wsDir).sequence.spine.clips;
    let cursor = 0;
    for (const clip of clips) {
      const env = clip.envelopes.find((x) => x.parameter === "placement.opacity")!;
      for (let k = 0; k <= 6; k++) {
        const local = (clip.duration_ms * k) / 6;
        const a = evaluateEnvelopeAt(env, local);
        const b = evaluateEnvelopeAt(before, cursor + local);
        assert.ok(Math.abs(a - b) < 2e-6, `piece @${cursor + local}: ${a} vs ${b}`);
      }
      cursor += clip.duration_ms;
    }
  };
  checkPieces(plantAndReturn("easing_cubic_split_mid"), [1000, 3000]);
  const wsVerbatim = plantAndReturn("easing_cubic_split_verbatim");
  splitSpineClip({ workspaceDir: wsVerbatim, clipId: "sp_01", splitPointsMs: [2000] });
  const pieces = loadSequence(wsVerbatim).sequence.spine.clips;
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces[0].envelopes[0].points.at(-1)?.bezier, b1);
  assert.deepEqual(pieces[1].envelopes[0].points.at(-1)?.bezier, b2);

  function plantAndReturn(name: string): string {
    const wsDir = setupWs(name);
    plant(wsDir);
    return wsDir;
  }
});

test("7. CLI --easing forms and G120 input errors", () => {
  assert.deepEqual(parseEasingFlag(undefined), { easing: "ease_in_out" });
  assert.deepEqual(parseEasingFlag("linear"), { easing: "linear" });
  assert.deepEqual(parseEasingFlag("cubic-bezier(0.25,0.1,0.25,1)"), {
    easing: "cubic_bezier",
    bezier: [0.25, 0.1, 0.25, 1],
  });
  assert.deepEqual(parseEasingFlag("cubic_bezier(0.42, 0, 0.58, 1)"), {
    easing: "cubic_bezier",
    bezier: [0.42, 0, 0.58, 1],
  });
  assert.deepEqual(parseEasingFlag("0.25,0.1,0.25,1"), {
    easing: "cubic_bezier",
    bezier: [0.25, 0.1, 0.25, 1],
  });
  for (const bad of ["cubic_bezier", "cubic-bezier(0.25,0.1)", "cubic-bezier(2,0,0,1)", "cubic-bezier(0,0,1.5,1)", "0.25,foo,0.25,1"]) {
    assert.throws(() => parseEasingFlag(bad), /CUTHOL-G120/, bad);
  }

  const wsDir = path.join(TEST_ROOT, "easing_cubic_cli");
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "16:9", "--fps", "30"]).ok);
  const add = cli(["lane", "add-cue", "--lane", "ln_titles", "--kind", "title", "--text", "hi", "--duration", "2000ms", "--dir", wsDir]);
  assert.ok(add.ok, add.raw);
  const cueId = /cue_\d+/.exec(add.raw)?.[0] ?? "cue_01";
  const good = cli([
    "spine", "envelope", "--clip", cueId, "--param", "placement.opacity",
    "--points", "0ms:0,2000ms:1", "--easing", "cubic-bezier(0.25,0.1,0.25,1)", "--dir", wsDir,
  ]);
  assert.ok(good.ok, good.raw);
  const cue = loadSequence(wsDir).sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId)!;
  assert.deepEqual(cue.envelopes[0].points[1], {
    offset_ms: 2000,
    value: 1,
    easing: "cubic_bezier",
    bezier: [0.25, 0.1, 0.25, 1],
  });
  const bad = cli([
    "spine", "envelope", "--clip", cueId, "--param", "placement.opacity",
    "--points", "0ms:0,2000ms:1", "--easing", "cubic-bezier(0.25,0.1,9,1)", "--dir", wsDir,
  ]);
  assert.equal(bad.ok, false);
  assert.match(bad.raw, /CUTHOL-G120/);
});

test("8. Verify gate catches bad bezier (G120) and accepts good curves", () => {
  const wsDir = setupWs("easing_cubic_verify");
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
  assert.throws(
    () =>
      setItemEnvelope({
        workspaceDir: wsDir,
        targetId: "sp_01",
        parameter: "placement.opacity",
        points: [
          { offset_ms: 0, value: 0, easing: "linear" },
          { offset_ms: 2000, value: 1, easing: "cubic_bezier", bezier: [0, 0, 5, 1] },
        ],
      }),
    /CUTHOL-G120/
  );
  commitSequenceMutation(wsDir, "test.plant-bad-bezier", (seq) => {
    seq.spine.clips[0].envelopes.push({
      parameter: "placement.opacity",
      points: [
        { offset_ms: 0, value: 0, easing: "linear" },
        { offset_ms: 2000, value: 1, easing: "cubic_bezier" },
      ],
    });
  });
  const rep = verifySequence(loadSequence(wsDir).sequence);
  assert.equal(rep.ok, false);
  assert.ok(rep.diagnostics.some((d) => d.code === "CUTHOL-G120"), JSON.stringify(rep.diagnostics));
  commitSequenceMutation(wsDir, "test.fix-bezier", (seq) => {
    seq.spine.clips[0].envelopes[0].points[1].bezier = [0.25, 0.1, 0.25, 1];
  });
  const rep2 = verifySequence(loadSequence(wsDir).sequence);
  assert.ok(!rep2.diagnostics.some((d) => d.code === "CUTHOL-G120"), JSON.stringify(rep2.diagnostics));
});

test("9. MCP envelope action: cubic_bezier easing + bezier param mapping", () => {
  const spec = findActionSpec("spine", "envelope");
  assert.ok(spec);
  const easing = spec.params.find((p) => p.name === "easing")!;
  assert.ok(easing.enum?.includes("cubic_bezier"), JSON.stringify(easing.enum));
  const bezier = spec.params.find((p) => p.name === "bezier")!;
  assert.equal(bezier.flag, "easing");
  const argv = buildCliArgv(
    spec,
    { clip: "sp_01", param: "placement.opacity", points: ["0ms:0", "2s:1"], bezier: "0.25,0.1,0.25,1" },
    "/p"
  );
  assert.deepEqual(argv, [
    "spine",
    "envelope",
    "--clip=sp_01",
    "--param=placement.opacity",
    "--points=0ms:0,2s:1",
    "--easing=0.25,0.1,0.25,1",
    "--dir=/p",
  ]);
});

test("10. Draft render with a cubic-bezier opacity envelope", { timeout: 600_000 }, () => {
  const wsDir = setupWs("easing_cubic_render");
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_01",
    parameter: "placement.opacity",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 2000, value: 1, easing: "cubic_bezier", bezier: [0.25, 0.1, 0.25, 1] },
    ],
  });
  const outMp4 = path.join(wsDir, "e1_draft.mp4");
  const proc = spawnSync(
    process.execPath,
    [CLI, "render", "--preset", "draft_480p", "--out", outMp4, "--dir", wsDir],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CUTHOL_ENCODER: "x264" } }
  );
  assert.equal(proc.status, 0, `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`.slice(-2000));
  assert.ok(fs.existsSync(outMp4) && fs.statSync(outMp4).size > 1000);
  const framePng = path.join(wsDir, "e1_frame_mid.png");
  const grab = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-ss", "1.0", "-i", outMp4, "-frames:v", "1", framePng],
    { encoding: "utf8" }
  );
  assert.equal(grab.status, 0, grab.stderr);
  console.log(`   [e1] render=${outMp4} frame=${framePng}`);
});
