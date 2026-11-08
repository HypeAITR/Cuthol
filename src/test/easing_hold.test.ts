/**
 * Hold easing: step easing in parameter envelopes + unknown easing names
 * are CUTHOL-G120 on every path (`src/test/easing_hold.test.ts`).
 *
 * - `hold` holds the previous point's value until the endpoint instant, then jumps
 *   (ffmpeg expression, JS evaluator, all three compile modes, frame-boundary rule
 *   `t >= t1` via the existing `lt(t,t1)` nesting).
 * - `sliceEnvelopes` / `spine split` across the jump preserve pre-split values.
 * - Unknown easing names are G120 at CLI parse, API input (verify rollback), cue sheet
 *   entry and the MCP free-text path; `hold` in transitions is G120 (input + verify).
 * - The four legacy easings (+ dB text) compile byte-identical to the earlier output.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileEnvelopeToFfmpegExpr } from "../compositor/compile_filters.js";
import { parseEasingFlag } from "../core/easing.js";
import { EasingKind, ParameterEnvelope } from "../core/schema.js";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { buildCliArgv, findActionSpec, validateActionArgs } from "../mcp/catalog.js";
import { applyCueSheet, planCueSheet } from "../sequence/cuesheet.js";
import {
  appendSpineClip,
  evaluateEnvelopeAt,
  setItemEnvelope,
  setSpineTransition,
  sliceEnvelopes,
  splitSpineClip,
} from "../sequence/spine.js";
import { verifySequence } from "../verify/gates.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

function sampleFfmpegExpr(expr: string, pointCount: number, rate = 4000): number[] {
  const dur = pointCount / rate;
  const out = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-hold-")),
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
  const dir = path.join(TEST_ROOT, "easing_hold_media");
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

function meanLuma(pngPath: string): number {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "info",
      "-i",
      pngPath,
      "-vf",
      "signalstats,metadata=print:file=-:key=lavfi.signalstats.YAVG",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, `signalstats failed: ${proc.stderr ?? ""}`);
  const m = /YAVG=([0-9.]+)/.exec(`${proc.stdout ?? ""}${proc.stderr ?? ""}`);
  assert.ok(m, `no YAVG in output for ${pngPath}`);
  return Number(m[1]);
}

test("1. hold compiles to a step expression (exact text, all three modes)", () => {
  const env: ParameterEnvelope = {
    parameter: "placement.opacity",
    points: [
      { offset_ms: 0, value: 0.2, easing: "linear" },
      { offset_ms: 1000, value: 0.9, easing: "hold" },
      { offset_ms: 2000, value: 0.5, easing: "linear" },
    ],
  };
  assert.equal(
    compileEnvelopeToFfmpegExpr({ envelope: env, timeBaseOffsetMs: 0, mode: "raw" }),
    "if(lt(t,0),0.2,if(lt(t,1),0.2,if(lt(t,2),0.9+(-0.4)*((t-1)/1),0.5)))"
  );
  const dbEnv: ParameterEnvelope = {
    parameter: "audio_chain.gain_db",
    points: [
      { offset_ms: 0, value: -6, easing: "linear" },
      { offset_ms: 1000, value: 0, easing: "hold" },
    ],
  };
  assert.equal(
    compileEnvelopeToFfmpegExpr({ envelope: dbEnv, timeBaseOffsetMs: 0, mode: "db_to_linear", baseGainDb: 0 }),
    "if(lt(t,0),0.5012,if(lt(t,1),0.5012,1))"
  );
  const pxEnv: ParameterEnvelope = {
    parameter: "placement.x_pct",
    points: [
      { offset_ms: 0, value: -10, easing: "linear" },
      { offset_ms: 1000, value: 10, easing: "hold" },
    ],
  };
  assert.equal(
    compileEnvelopeToFfmpegExpr({
      envelope: pxEnv,
      timeBaseOffsetMs: 0,
      mode: "pixel_offset",
      baseCenterPx: 320,
      canvasDimPx: 640,
    }),
    "if(lt(t,0),256,if(lt(t,1),256,384))"
  );
});

test("2. ffmpeg-evaluated hold expression matches the JS evaluator (both sides of the jump)", () => {
  const env: ParameterEnvelope = {
    parameter: "placement.opacity",
    points: [
      { offset_ms: 0, value: 0.2, easing: "linear" },
      { offset_ms: 1000, value: 0.9, easing: "hold" },
      { offset_ms: 2000, value: 0.5, easing: "linear" },
    ],
  };
  const expr = compileEnvelopeToFfmpegExpr({ envelope: env, timeBaseOffsetMs: 0, mode: "raw" })!;
  const samples = sampleFfmpegExpr(expr, 8000);
  // One sample on each side of the jump instant (t = 1.0 is sample 4000).
  assert.ok(Math.abs(samples[3999] - 0.2) < 1e-6, `pre-jump: ${samples[3999]}`);
  assert.ok(Math.abs(samples[4000] - 0.9) < 1e-6, `jump instant: ${samples[4000]}`);
  let maxErr = 0;
  for (let i = 0; i < samples.length; i++) {
    const expected = evaluateEnvelopeAt(env, (i / 4000) * 1000);
    maxErr = Math.max(maxErr, Math.abs(samples[i] - expected));
  }
  console.log(`   [hold] raw: max |ffmpeg - js| = ${maxErr.toExponential(2)}`);
  assert.ok(maxErr < 1e-5, `max error ${maxErr} exceeds 1e-5`);

  const dbEnv: ParameterEnvelope = {
    parameter: "audio_chain.gain_db",
    points: [
      { offset_ms: 0, value: -6, easing: "linear" },
      { offset_ms: 1000, value: 0, easing: "hold" },
      { offset_ms: 2000, value: 0, easing: "linear" },
    ],
  };
  const dbExpr = compileEnvelopeToFfmpegExpr({
    envelope: dbEnv,
    timeBaseOffsetMs: 0,
    mode: "db_to_linear",
    baseGainDb: 0,
  })!;
  const dbSamples = sampleFfmpegExpr(dbExpr, 1600, 800);
  assert.ok(Math.abs(dbSamples[799] - Math.pow(10, -6 / 20)) < 1e-3, `dB pre-jump: ${dbSamples[799]}`);
  assert.ok(Math.abs(dbSamples[800] - 1) < 1e-6, `dB jump instant: ${dbSamples[800]}`);
});

test("3. JS evaluator hold semantics (unit)", () => {
  const env: ParameterEnvelope = {
    parameter: "placement.opacity",
    points: [
      { offset_ms: 0, value: 0.2, easing: "linear" },
      { offset_ms: 1000, value: 0.9, easing: "hold" },
      { offset_ms: 2000, value: 0.5, easing: "linear" },
    ],
  };
  assert.equal(evaluateEnvelopeAt(env, 0), 0.2);
  assert.equal(evaluateEnvelopeAt(env, 999), 0.2);
  assert.equal(evaluateEnvelopeAt(env, 1000), 0.9);
  assert.ok(Math.abs(evaluateEnvelopeAt(env, 1001) - 0.8996) < 1e-9);
  assert.equal(evaluateEnvelopeAt(env, 2000), 0.5);
  assert.equal(evaluateEnvelopeAt(env, -5), 0.2);
  assert.equal(evaluateEnvelopeAt(env, 5000), 0.5);
});

test("4. sliceEnvelopes keeps hold segments correct (unit)", () => {
  const env: ParameterEnvelope = {
    parameter: "placement.opacity",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 1000, value: 1, easing: "hold" },
      { offset_ms: 2000, value: 1, easing: "linear" },
    ],
  };
  // Cut strictly inside the hold segment: constant 0, the new value never enters.
  const [inner] = sliceEnvelopes([env], 400, 600);
  assert.deepEqual(
    inner.points.map((p) => p.value),
    [0, 0]
  );
  assert.equal(inner.points[1].offset_ms, 200);
  assert.equal(evaluateEnvelopeAt({ parameter: env.parameter, points: inner.points }, 199), 0);
  assert.equal(evaluateEnvelopeAt({ parameter: env.parameter, points: inner.points }, 200), 0);
  // Cut across the jump: the step survives at the shifted offset.
  const [across] = sliceEnvelopes([env], 400, 1400);
  const sliced = { parameter: env.parameter, points: across.points };
  assert.equal(evaluateEnvelopeAt(sliced, 599), 0);
  assert.equal(evaluateEnvelopeAt(sliced, 600), 1);
  assert.equal(evaluateEnvelopeAt(sliced, 601), 1);
  for (const [s, e] of [[0, 999], [0, 1000], [1000, 2000], [1001, 2000], [0, 2000]] as Array<[number, number]>) {
    const [cut] = sliceEnvelopes([env], s, e);
    const cutEnv = { parameter: env.parameter, points: cut.points };
    for (let k = 0; k <= 8; k++) {
      const local = ((e - s) * k) / 8;
      assert.ok(
        Math.abs(evaluateEnvelopeAt(cutEnv, local) - evaluateEnvelopeAt(env, s + local)) < 2e-6,
        `slice [${s},${e}] @${local}`
      );
    }
  }
});

test("5. spine split just before/after the jump preserves values end to end", () => {
  const plant = (wsDir: string): ParameterEnvelope => {
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    setItemEnvelope({
      workspaceDir: wsDir,
      targetId: "sp_01",
      parameter: "placement.opacity",
      points: [
        { offset_ms: 0, value: 0, easing: "linear" },
        { offset_ms: 2000, value: 1, easing: "hold" },
        { offset_ms: 4000, value: 1, easing: "linear" },
      ],
    });
    return loadSequence(wsDir).sequence.spine.clips[0].envelopes[0];
  };
  for (const splitMs of [1999, 2001]) {
    const wsDir = setupWs(`easing_hold_split_${splitMs}`);
    const before = plant(wsDir);
    splitSpineClip({ workspaceDir: wsDir, clipId: "sp_01", splitPointsMs: [splitMs] });
    const clips = loadSequence(wsDir).sequence.spine.clips;
    assert.equal(clips.length, 2);
    let cursor = 0;
    for (const clip of clips) {
      const piece = clip.envelopes.find((x) => x.parameter === "placement.opacity")!;
      for (let k = 0; k <= 6; k++) {
        const local = (clip.duration_ms * k) / 6;
        const a = evaluateEnvelopeAt(piece, local);
        const b = evaluateEnvelopeAt(before, cursor + local);
        assert.ok(Math.abs(a - b) < 2e-6, `split @${splitMs} piece @${cursor + local}: ${a} vs ${b}`);
      }
      cursor += clip.duration_ms;
    }
    const left = clips[0].envelopes.find((x) => x.parameter === "placement.opacity")!;
    assert.equal(
      evaluateEnvelopeAt(left, clips[0].duration_ms),
      splitMs === 1999 ? 0 : 1,
      `left piece end after split @${splitMs}`
    );
  }
});

test("6. parseEasingFlag: hold accepted, unknown names and transition-hold are G120", () => {
  assert.deepEqual(parseEasingFlag("hold"), { easing: "hold" });
  assert.deepEqual(parseEasingFlag("linear", { allowHold: false }), { easing: "linear" });
  for (const bad of ["foo", "Hold", "LINEAR", "ease-in", "step", ""]) {
    assert.throws(() => parseEasingFlag(bad), /CUTHOL-G120/, JSON.stringify(bad));
  }
  try {
    parseEasingFlag("foo");
    assert.fail("expected G120");
  } catch (err) {
    const msg = String(err);
    assert.match(msg, /CUTHOL-G120/);
    for (const name of ["linear", "ease_in", "ease_out", "ease_in_out", "hold", "cubic_bezier"]) {
      assert.ok(msg.includes(name), `suggestion lists '${name}': ${msg.slice(0, 400)}`);
    }
  }
  assert.throws(() => parseEasingFlag("hold", { allowHold: false }), /CUTHOL-G120/);
  try {
    parseEasingFlag("hold", { allowHold: false, subject: "sp_01" });
    assert.fail("expected G120");
  } catch (err) {
    assert.match(String(err), /unseen/);
  }
});

test("7. CLI: --easing foo and transition --easing hold are G120", () => {
  const wsDir = setupWs("easing_hold_cli");
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 2000, sourceOutMs: 4000 });
  const badEnv = cli([
    "spine", "envelope", "--clip", "sp_01", "--param", "placement.opacity",
    "--points", "0ms:0,2000ms:1", "--easing", "foo", "--dir", wsDir,
  ]);
  assert.equal(badEnv.ok, false);
  assert.match(badEnv.raw, /CUTHOL-G120/);
  const goodEnv = cli([
    "spine", "envelope", "--clip", "sp_01", "--param", "placement.opacity",
    "--points", "0ms:0,2000ms:1", "--easing", "hold", "--dir", wsDir,
  ]);
  assert.ok(goodEnv.ok, goodEnv.raw);
  assert.equal(loadSequence(wsDir).sequence.spine.clips[0].envelopes[0].points[1].easing, "hold");
  const badTr = cli([
    "spine", "transition", "--clip", "sp_01", "--kind", "dissolve",
    "--duration", "400ms", "--easing", "hold", "--dir", wsDir,
  ]);
  assert.equal(badTr.ok, false);
  assert.match(badTr.raw, /CUTHOL-G120/);
  const badTrName = cli([
    "spine", "transition", "--clip", "sp_01", "--kind", "dissolve",
    "--duration", "400ms", "--easing", "foo", "--dir", wsDir,
  ]);
  assert.equal(badTrName.ok, false);
  assert.match(badTrName.raw, /CUTHOL-G120/);
  const goodTr = cli([
    "spine", "transition", "--clip", "sp_01", "--kind", "dissolve",
    "--duration", "400ms", "--easing", "ease_in", "--dir", wsDir,
  ]);
  assert.ok(goodTr.ok, goodTr.raw);
});

test("8. API input, verify gate and cue sheet entry reject bad easings with G120", () => {
  const wsDir = setupWs("easing_hold_verify");
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
  assert.throws(
    () =>
      setItemEnvelope({
        workspaceDir: wsDir,
        targetId: "sp_01",
        parameter: "placement.opacity",
        points: [
          { offset_ms: 0, value: 0, easing: "linear" },
          { offset_ms: 2000, value: 1, easing: "foo" as unknown as EasingKind },
        ],
      }),
    /CUTHOL-G120/
  );
  assert.throws(
    () =>
      setSpineTransition({
        workspaceDir: wsDir,
        clipId: "sp_01",
        transition: { kind: "dissolve", duration_ms: 400, easing: "hold" },
      }),
    /CUTHOL-G120/
  );
  assert.throws(
    () =>
      setSpineTransition({
        workspaceDir: wsDir,
        clipId: "sp_01",
        transition: { kind: "dissolve", duration_ms: 400, easing: "foo" as unknown as EasingKind },
      }),
    /CUTHOL-G120/
  );
  // Plant one bad easing per path (spine envelope, lane cue envelope, transition).
  commitSequenceMutation(wsDir, "test.plant-bad-easing", (seq) => {
    seq.spine.clips[0].envelopes.push({
      parameter: "placement.opacity",
      points: [
        { offset_ms: 0, value: 0, easing: "linear" },
        { offset_ms: 2000, value: 1, easing: "foo" as unknown as EasingKind },
      ],
    });
    seq.lanes
      .find((l) => l.id === "ln_titles")!
      .cues.push({
        id: "cue_01",
        kind: "title",
        anchor: null,
        at_ms: 0,
        duration_ms: 2000,
        placement: seq.spine.clips[0].placement,
        typography: {
          text: "hi",
          font_family: "Inter",
          font_size_px: 56,
          font_weight: 700,
          color_hex: "#FFFFFF",
          stroke_color_hex: "#000000",
          stroke_width_px: 2,
          box_color_hex: null,
          box_opacity: 0,
          align: "center",
          max_width_pct: 76,
        },
        envelopes: [
          {
            parameter: "placement.opacity",
            points: [
              { offset_ms: 0, value: 0, easing: "linear" },
              { offset_ms: 2000, value: 1, easing: "bar" as unknown as EasingKind },
            ],
          },
        ],
      });
    seq.spine.clips[0].transition_out = { kind: "dissolve", duration_ms: 400, easing: "hold" };
  });
  const rep = verifySequence(loadSequence(wsDir).sequence);
  assert.equal(rep.ok, false);
  assert.equal(
    rep.diagnostics.filter((d) => d.code === "CUTHOL-G120").length,
    3,
    JSON.stringify(rep.diagnostics)
  );
  commitSequenceMutation(wsDir, "test.fix-easing", (seq) => {
    seq.spine.clips[0].envelopes[0].points[1].easing = "hold";
    seq.lanes.find((l) => l.id === "ln_titles")!.cues[0].envelopes[0].points[1].easing = "linear";
    seq.spine.clips[0].transition_out = { kind: "dissolve", duration_ms: 400, easing: "linear" };
  });
  const rep2 = verifySequence(loadSequence(wsDir).sequence);
  assert.ok(!rep2.diagnostics.some((d) => d.code === "CUTHOL-G120"), JSON.stringify(rep2.diagnostics));

  // Cue sheet entry: unknown envelope easing and hold-transition are G120 at plan and apply.
  const badSheet = {
    spine: [
      {
        id: "sp_01",
        envelopes: [
          {
            parameter: "placement.opacity",
            points: [
              { offset_ms: 0, value: 0, easing: "linear" },
              { offset_ms: 2000, value: 1, easing: "foo" },
            ],
          },
        ],
      },
    ],
  } as never;
  assert.throws(() => planCueSheet(wsDir, badSheet), /CUTHOL-G120/);
  assert.throws(() => applyCueSheet(wsDir, badSheet), /CUTHOL-G120/);
  const holdTrSheet = {
    spine: [{ id: "sp_01", transition_out: { kind: "dissolve", duration_ms: 400, easing: "hold" } }],
  } as never;
  assert.throws(() => planCueSheet(wsDir, holdTrSheet), /CUTHOL-G120/);
  const goodSheet = {
    spine: [
      {
        id: "sp_01",
        envelopes: [
          {
            parameter: "placement.opacity",
            points: [
              { offset_ms: 0, value: 0, easing: "linear" },
              { offset_ms: 2000, value: 1, easing: "hold" },
            ],
          },
        ],
      },
    ],
  } as never;
  const applied = applyCueSheet(wsDir, goodSheet);
  assert.equal(applied.verification.ok, true, JSON.stringify(applied.verification.diagnostics));
  assert.equal(loadSequence(wsDir).sequence.spine.clips[0].envelopes[0].points[1].easing, "hold");
});

test("9. MCP: envelope enum has hold, transition enum lacks it, free text maps to G120 input", () => {
  const envSpec = findActionSpec("spine", "envelope");
  assert.ok(envSpec);
  const envEasing = envSpec.params.find((p) => p.name === "easing")!;
  assert.ok(envEasing.enum?.includes("hold"), JSON.stringify(envEasing.enum));
  const trSpec = findActionSpec("spine", "transition");
  assert.ok(trSpec);
  const trEasing = trSpec.params.find((p) => p.name === "easing")!;
  assert.ok(!trEasing.enum?.includes("hold"), JSON.stringify(trEasing.enum));
  const badEnv = validateActionArgs(envSpec, {
    clip: "sp_01",
    param: "placement.opacity",
    points: ["0ms:0"],
    easing: "foo",
  });
  assert.ok(badEnv.issues.some((i) => i.kind === "bad_enum"), JSON.stringify(badEnv.issues));
  const badTr = validateActionArgs(trSpec, { clip: "sp_01", easing: "hold" });
  assert.ok(badTr.issues.some((i) => i.kind === "bad_enum"), JSON.stringify(badTr.issues));
  const argv = buildCliArgv(
    envSpec,
    { clip: "sp_01", param: "placement.opacity", points: ["0ms:0", "2s:1"], bezier: "foo" },
    "/p"
  );
  assert.ok(argv.includes("--easing=foo"), JSON.stringify(argv));
  assert.throws(() => parseEasingFlag("foo"), /CUTHOL-G120/);
});

test("10. Legacy four easings compile byte-identical to the earlier output", () => {
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

test("11. Draft render with a hold opacity envelope: pre-jump vs jump frame", { timeout: 600_000 }, () => {
  const wsDir = setupWs("easing_hold_render");
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_01",
    parameter: "placement.opacity",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 1000, value: 1, easing: "hold" },
    ],
  });
  const outMp4 = path.join(wsDir, "hold_draft.mp4");
  const proc = spawnSync(
    process.execPath,
    [CLI, "render", "--preset", "draft_480p", "--out", outMp4, "--dir", wsDir],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CUTHOL_ENCODER: "x264" } }
  );
  assert.equal(proc.status, 0, `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`.slice(-2000));
  assert.ok(fs.existsSync(outMp4) && fs.statSync(outMp4).size > 1000);
  const prePng = path.join(wsDir, "hold_frame_pre.png");
  const jumpPng = path.join(wsDir, "hold_frame_jump.png");
  for (const [n, png] of [[29, prePng], [30, jumpPng]] as Array<[number, string]>) {
    const grab = spawnSync(
      "ffmpeg",
      ["-y", "-v", "error", "-i", outMp4, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", png],
      { encoding: "utf8" }
    );
    assert.equal(grab.status, 0, grab.stderr);
  }
  const preY = meanLuma(prePng);
  const jumpY = meanLuma(jumpPng);
  console.log(`   [hold] pre-jump frame#29 YAVG=${preY.toFixed(3)} jump frame#30 YAVG=${jumpY.toFixed(3)}`);
  console.log(`   [hold] render=${outMp4} pre=${prePng} jump=${jumpPng}`);
  assert.ok(preY < 40, `pre-jump frame should show the dark backdrop, got YAVG=${preY} (0..255)`);
  assert.ok(jumpY > 70, `jump frame should show the video, got YAVG=${jumpY} (0..255)`);
});
