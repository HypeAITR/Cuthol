/**
 * Colour: spine colour envelopes, colour temperature and LUT.
 *
 * NOTE (compatibility): the static imports below reference only pre-colour modules and exports, so this file
 * also compiles and runs on the tree before the effect gates (where the behaviour tests fail and the CLI/catalog tests fail).
 * The new grade API itself is exercised through the CLI, never through a direct import.
 */
process.env.CUTHOL_ENCODER = "x264";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSpineClipColorFilters } from "../compositor/compile_spine_color.js";
import { CutholError } from "../core/diagnostics.js";
import { createDefaultPlacement, createDefaultTreatments, CutholSequence } from "../core/schema.js";
import { initWorkspace, loadSequence, updateSequenceInPlace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { findActionSpec } from "../mcp/catalog.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { appendSpineClip, setItemEnvelope } from "../sequence/spine.js";
import { verifySequence } from "../verify/gates.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const TEST_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-h7-"));

const IDENTITY_CUBE = `TITLE "h7 identity"
LUT_3D_SIZE 2
DOMAIN_MIN 0.0 0.0 0.0
DOMAIN_MAX 1.0 1.0 1.0
0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
`;

// .cube data order is R-fastest: entry (r,g,b) -> (b,g,r).
const SWAP_RB_CUBE = `TITLE "h7 swap r/b"
LUT_3D_SIZE 2
DOMAIN_MIN 0.0 0.0 0.0
DOMAIN_MAX 1.0 1.0 1.0
0.0 0.0 0.0
0.0 0.0 1.0
0.0 1.0 0.0
0.0 1.0 1.0
1.0 0.0 0.0
1.0 0.0 1.0
1.0 1.0 0.0
1.0 1.0 1.0
`;

let cachedMedia: string | null = null;
function ensureMedia(): string {
  if (cachedMedia && fs.existsSync(cachedMedia)) return cachedMedia;
  const out = path.join(TEST_TMP, "h7_src.mp4");
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
      "6",
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

let cachedBars: string | null = null;
function ensureBarsMedia(): string {
  if (cachedBars && fs.existsSync(cachedBars)) return cachedBars;
  const out = path.join(TEST_TMP, "h7_bars.mp4");
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "smptebars=size=640x360:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "2",
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
  assert.equal(proc.status, 0, `bars media failed: ${proc.stderr}`);
  cachedBars = out;
  return out;
}

function makeWs(name: string, clipOutMs: number, media?: string): string {
  const wsDir = path.join(TEST_TMP, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media ?? ensureMedia()] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: clipOutMs });
  return wsDir;
}

type SpineClipSpec = CutholSequence["spine"]["clips"][number];

function fakeColorClip(over: Partial<SpineClipSpec> = {}): SpineClipSpec {
  return {
    id: "sp_01",
    asset_handle: "vid_01",
    source_in_ms: 0,
    source_out_ms: 2000,
    timeline_in_ms: 0,
    duration_ms: 2000,
    playback: { rate: 1, preserve_pitch: true, speed_ramp: null },
    placement: createDefaultPlacement(),
    audio_chain: {
      gain_db: 0,
      muted: false,
      fade_in_ms: 0,
      fade_out_ms: 0,
      denoise: { enabled: false, nr_db: 12, noise_floor_db: -50 },
      voice_clarity: { enabled: false, highpass_hz: 80, presence_boost_db: 2.5, compressor_ratio: 3 },
      loudness_target_lufs: null,
      true_peak_ceiling_dbtp: -1,
    },
    treatments: createDefaultTreatments(),
    transition_out: null,
    envelopes: [],
    ...over,
  } as SpineClipSpec;
}

function compileColor(
  clip: SpineClipSpec,
  rootDir: string,
  opts: { isRgb?: boolean; pixFmt?: string | null } = {}
): string[] {
  const ctx = { paths: { rootDir } } as never;
  return buildSpineClipColorFilters(ctx, {
    clip,
    asset: { probe: { pix_fmt: opts.pixFmt ?? null } } as never,
    absAssetPath: "",
    clipColorSpec: {
      isRgb: opts.isRgb ?? false,
      inMatrix: "bt709",
      inRange: "tv",
      sourceRule: "tagged",
    } as never,
  });
}

function extractFrame(mp4: string, tSec: number, outPng: string): void {
  const proc = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-i", mp4, "-ss", String(tSec), "-frames:v", "1", outPng],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, `frame extract @${tSec}s failed: ${proc.stderr}`);
  assert.ok(fs.existsSync(outPng), `missing frame ${outPng}`);
}

function signalYAvg(png: string, plane?: "r" | "g" | "b"): number {
  const vf = plane
    ? `extractplanes=${plane},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`
    : `signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`;
  const proc = spawnSync("ffmpeg", ["-v", "error", "-i", png, "-vf", vf, "-f", "null", "-"], {
    encoding: "utf8",
  });
  assert.equal(proc.status, 0, `signalstats failed for ${png}: ${proc.stderr}`);
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(proc.stdout);
  assert.ok(m, `no YAVG in signalstats output for ${png}: ${proc.stdout}`);
  return Number(m[1]);
}

function psnrAverage(aPng: string, bPng: string): number {
  const proc = spawnSync("ffmpeg", ["-v", "info", "-i", aPng, "-i", bPng, "-lavfi", "psnr", "-f", "null", "-"], {
    encoding: "utf8",
  });
  assert.equal(proc.status, 0, `psnr failed: ${proc.stderr}`);
  const m = /average:([inf\d.]+)/.exec(proc.stderr);
  assert.ok(m, `no psnr average in: ${proc.stderr.slice(-400)}`);
  return m[1] === "inf" ? Number.POSITIVE_INFINITY : Number(m[1]);
}

function codesOf(seq: CutholSequence, wsDir?: string): string[] {
  const { sequence, paths } = wsDir ? loadSequence(wsDir) : { sequence: seq, paths: undefined };
  void seq;
  return verifySequence(sequence, paths).diagnostics.map((d) => d.code);
}

test("static grade output is byte-stable (defaults: no filter; statics: legacy eq string)", () => {
  const wsDir = path.join(TEST_TMP, "ws_static");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "static", aspect: "16:9", fps: 30 });
  assert.deepEqual(compileColor(fakeColorClip(), wsDir), []);
  const graded = fakeColorClip();
  graded.treatments.color_grade.brightness = 0.05;
  graded.treatments.color_grade.contrast = 1.15;
  graded.treatments.color_grade.saturation = 0.8;
  assert.deepEqual(compileColor(graded, wsDir), ["eq=brightness=0.05:contrast=1.15:saturation=0.80"]);
});

test("colour envelopes compile to eval=frame expressions and win over statics", () => {
  const wsDir = path.join(TEST_TMP, "ws_env");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "env", aspect: "16:9", fps: 30 });
  const clip = fakeColorClip();
  clip.treatments.color_grade.brightness = 0.5;
  clip.envelopes = [
    {
      parameter: "treatments.color_grade.brightness",
      points: [
        { offset_ms: 0, value: 0, easing: "linear" },
        { offset_ms: 1000, value: 0.3, easing: "linear" },
      ],
    },
  ];
  const filters = compileColor(clip, wsDir);
  assert.equal(filters.length, 1);
  assert.ok(filters[0].startsWith("eq="), filters[0]);
  assert.ok(filters[0].includes(":eval=frame"), filters[0]);
  assert.ok(filters[0].includes("brightness='"), filters[0]);
  assert.ok(!filters[0].includes("0.50"), `static value must lose to the envelope: ${filters[0]}`);
  assert.ok(filters[0].includes("contrast=1.00"), filters[0]);
});

test("temperature: neutral emits nothing, 3200K compiles, out-of-range is G124", () => {
  const wsDir = makeWs("ws_temp", 1000);
  const neutral = fakeColorClip();
  assert.deepEqual(compileColor(neutral, wsDir), []);
  const warm = fakeColorClip();
  warm.treatments.color_grade.temperature_k = 3200;
  assert.deepEqual(compileColor(warm, wsDir), ["colortemperature=temperature=3200"]);

  for (const bad of [999, 40001]) {
    updateSequenceInPlace(wsDir, (seq) => {
      seq.spine.clips[0].treatments.color_grade.temperature_k = bad;
    });
    const { sequence, paths } = loadSequence(wsDir);
    const rep = verifySequence(sequence, paths);
    assert.equal(rep.ok, false);
    assert.ok(
      rep.diagnostics.some((d) => d.code === "CUTHOL-G124" && d.severity === "ERROR"),
      `expected G124 for ${bad}K, got ${JSON.stringify(rep.diagnostics.map((d) => d.code))}`
    );
  }
  for (const good of [1000, 40000, 6500]) {
    updateSequenceInPlace(wsDir, (seq) => {
      seq.spine.clips[0].treatments.color_grade.temperature_k = good;
    });
    const codes = codesOf(loadSequence(wsDir).sequence, wsDir);
    assert.ok(!codes.includes("CUTHOL-G124"), `unexpected G124 for ${good}K`);
    assert.ok(!codes.includes("CUTHOL-G409"), `unexpected G409 for ${good}K`);
  }
});

test("LUT: missing/outside-project/bad-extension is G414 and blocks render; valid .cube compiles", () => {
  const wsDir = makeWs("ws_lut", 1000);
  const lutDir = path.join(wsDir, "luts");
  fs.mkdirSync(lutDir, { recursive: true });
  fs.writeFileSync(path.join(lutDir, "film.cube"), IDENTITY_CUBE, "utf8");

  const LUT = "lut3d=file='luts/film.cube'";
  const good = fakeColorClip();
  good.treatments.color_grade.lut_uri = "luts/film.cube";
  assert.deepEqual(compileColor(good, wsDir), ["format=yuv444p", LUT, "format=yuv420p"]);

  const rgb = fakeColorClip();
  rgb.treatments.color_grade.lut_uri = "luts/film.cube";
  assert.deepEqual(compileColor(rgb, wsDir, { isRgb: true }), [LUT]);

  const y444 = fakeColorClip();
  y444.treatments.color_grade.lut_uri = "luts/film.cube";
  assert.deepEqual(compileColor(y444, wsDir, { pixFmt: "yuv444p" }), [LUT]);

  const y422 = fakeColorClip();
  y422.treatments.color_grade.lut_uri = "luts/film.cube";
  assert.deepEqual(compileColor(y422, wsDir, { pixFmt: "yuv422p" }), [
    "format=yuv444p",
    LUT,
    "format=yuv422p",
  ]);

  const yuva = fakeColorClip();
  yuva.treatments.color_grade.lut_uri = "luts/film.cube";
  assert.deepEqual(compileColor(yuva, wsDir, { pixFmt: "yuva420p" }), [
    "format=yuva444p",
    LUT,
    "format=yuva420p",
  ]);

  const absInside = fakeColorClip();
  absInside.treatments.color_grade.lut_uri = path.join(wsDir, "luts", "film.cube");
  assert.equal(compileColor(absInside, wsDir)[1], LUT);

  for (const badUri of ["luts/missing.cube", "../outside.cube", "luts/film.txt"]) {
    if (badUri.endsWith(".txt")) fs.writeFileSync(path.join(lutDir, "film.txt"), "nope", "utf8");
    updateSequenceInPlace(wsDir, (seq) => {
      seq.spine.clips[0].treatments.color_grade.lut_uri = badUri;
    });
    const { sequence, paths } = loadSequence(wsDir);
    const rep = verifySequence(sequence, paths);
    assert.ok(
      rep.diagnostics.some((d) => d.code === "CUTHOL-G414" && d.severity === "ERROR"),
      `expected G414 for '${badUri}', got ${JSON.stringify(rep.diagnostics.map((d) => d.code))}`
    );
  }

  updateSequenceInPlace(wsDir, (seq) => {
    seq.spine.clips[0].treatments.color_grade.lut_uri = "luts/missing.cube";
  });
  const outMp4 = path.join(wsDir, "output", "must_not_exist.mp4");
  assert.throws(
    () => renderSequenceToMp4({ workspaceDir: wsDir, outputPath: outMp4, preset: "draft_480p" }),
    (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G414"
  );
  assert.equal(fs.existsSync(outMp4), false, "render with a missing LUT must not start");
});

test("G409 fires only for motion_blur/mask/lane colour envelopes", () => {
  const wsDir = path.join(TEST_TMP, "ws_g409");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "g409", aspect: "16:9", fps: 30 });
  fs.mkdirSync(path.join(wsDir, "luts"), { recursive: true });
  fs.writeFileSync(path.join(wsDir, "luts", "ok.cube"), IDENTITY_CUBE, "utf8");
  updateSequenceInPlace(wsDir, (seq) => {
    seq.spine.clips.push({
      id: "sp_dirty",
      asset_handle: "vid_01",
      source_in_ms: 0,
      source_out_ms: 2000,
      timeline_in_ms: 0,
      duration_ms: 2000,
      playback: { rate: 1, preserve_pitch: true, speed_ramp: null },
      placement: createDefaultPlacement(),
      audio_chain: {
        gain_db: 0,
        muted: true,
        fade_in_ms: 0,
        fade_out_ms: 0,
        denoise: { enabled: false, nr_db: 12, noise_floor_db: -50 },
        voice_clarity: { enabled: false, highpass_hz: 80, presence_boost_db: 2.5, compressor_ratio: 3 },
        loudness_target_lufs: null,
        true_peak_ceiling_dbtp: -1,
      },
      treatments: {
        ...createDefaultTreatments(),
        motion_blur: { enabled: true, shutter_deg: 180, subframes: 4 },
        mask: {
          shape: "rect",
          center_x_pct: 50,
          center_y_pct: 50,
          width_pct: 50,
          height_pct: 50,
          feather_px: 0,
          invert: false,
        },
        color_grade: { brightness: 0, contrast: 1, saturation: 1, temperature_k: 4500, lut_uri: "luts/ok.cube" },
      },
      transition_out: null,
      envelopes: [
        {
          parameter: "treatments.color_grade.brightness",
          points: [{ offset_ms: 0, value: 0, easing: "linear" }],
        },
      ],
    });
    seq.lanes
      .find((l) => l.id === "ln_broll")!
      .cues.push({
        id: "cue_grade",
        kind: "broll",
        anchor: null,
        at_ms: 0,
        duration_ms: 2000,
        placement: createDefaultPlacement(),
        envelopes: [
          {
            parameter: "treatments.color_grade.saturation",
            points: [{ offset_ms: 0, value: 1, easing: "linear" }],
          },
        ],
      });
  });
  const { sequence, paths } = loadSequence(wsDir);
  const rep = verifySequence(sequence, paths, ["G4_STAGE"]);
  const g409 = rep.diagnostics.filter((d) => d.code === "CUTHOL-G409");
  const fields = g409.map((d) => `${d.subject_id} ${d.what}`);
  assert.ok(
    fields.some((f) => f.includes("sp_dirty") && f.includes("treatments.motion_blur")),
    JSON.stringify(fields)
  );
  assert.ok(
    fields.some((f) => f.includes("sp_dirty") && f.includes("treatments.mask")),
    JSON.stringify(fields)
  );
  assert.ok(
    fields.some((f) => f.includes("cue_grade") && f.includes("treatments.color_grade.saturation")),
    JSON.stringify(fields)
  );
  assert.ok(
    !fields.some((f) => f.includes("temperature_k") || f.includes("lut_uri")),
    JSON.stringify(fields)
  );
  assert.ok(
    !fields.some((f) => f.includes("sp_dirty") && f.includes("color_grade.")),
    JSON.stringify(fields)
  );
});

test("render: brightness envelope ramps frame YAVG up over the clip", () => {
  const wsDir = makeWs("ws_env_render", 2000);
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_01",
    parameter: "treatments.color_grade.brightness",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 1000, value: 0.3, easing: "linear" },
    ],
  });
  const outMp4 = path.join(wsDir, "output", "env.mp4");
  const rendered = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: outMp4, preset: "draft_480p" });
  assert.equal(rendered.ok, true);
  const y: number[] = [];
  for (const t of [0, 0.5, 1]) {
    const png = path.join(wsDir, `env_${t}.png`);
    extractFrame(outMp4, t, png);
    y.push(signalYAvg(png));
  }
  assert.ok(y[0] < y[1] && y[1] < y[2], `YAVG must rise 0s->0.5s->1s, got ${y.join(", ")}`);
  assert.ok(y[2] - y[0] > 10, `ramp span too small: ${y.join(", ")}`);
});

test("render: 3200K is red-heavy, 9000K is blue-heavy", () => {
  const ratios: number[] = [];
  for (const [name, kelvin] of [["ws_t3200", 3200], ["ws_t9000", 9000]] as const) {
    const wsDir = makeWs(name, 1000);
    updateSequenceInPlace(wsDir, (seq) => {
      seq.spine.clips[0].treatments.color_grade.temperature_k = kelvin;
    });
    const outMp4 = path.join(wsDir, "output", `t${kelvin}.mp4`);
    const rendered = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: outMp4, preset: "draft_480p" });
    assert.equal(rendered.ok, true);
    const png = path.join(wsDir, `t${kelvin}.png`);
    extractFrame(outMp4, 0.5, png);
    ratios.push(signalYAvg(png, "r") / Math.max(1, signalYAvg(png, "b")));
  }
  assert.ok(ratios[0] > 1.2, `3200K must be red-heavy, R/B=${ratios[0]}`);
  assert.ok(ratios[1] < 1.0, `9000K must be blue-heavy, R/B=${ratios[1]}`);
});

test("render: identity LUT matches no-LUT (PSNR>=45dB), swap-RB LUT differs strongly", () => {
  const wsDir = makeWs("ws_lut_render", 1000, ensureBarsMedia());
  fs.mkdirSync(path.join(wsDir, "luts"), { recursive: true });
  fs.writeFileSync(path.join(wsDir, "luts", "identity.cube"), IDENTITY_CUBE, "utf8");
  fs.writeFileSync(path.join(wsDir, "luts", "swap.cube"), SWAP_RB_CUBE, "utf8");

  const plainMp4 = path.join(wsDir, "output", "plain.mp4");
  assert.equal(
    renderSequenceToMp4({ workspaceDir: wsDir, outputPath: plainMp4, preset: "draft_480p" }).ok,
    true
  );
  updateSequenceInPlace(wsDir, (seq) => {
    seq.spine.clips[0].treatments.color_grade.lut_uri = "luts/identity.cube";
  });
  const identMp4 = path.join(wsDir, "output", "identity.mp4");
  assert.equal(
    renderSequenceToMp4({ workspaceDir: wsDir, outputPath: identMp4, preset: "draft_480p" }).ok,
    true
  );
  updateSequenceInPlace(wsDir, (seq) => {
    seq.spine.clips[0].treatments.color_grade.lut_uri = "luts/swap.cube";
  });
  const swapMp4 = path.join(wsDir, "output", "swap.mp4");
  assert.equal(
    renderSequenceToMp4({ workspaceDir: wsDir, outputPath: swapMp4, preset: "draft_480p" }).ok,
    true
  );

  const plainPng = path.join(wsDir, "plain.png");
  const identPng = path.join(wsDir, "identity.png");
  const swapPng = path.join(wsDir, "swap.png");
  extractFrame(plainMp4, 0.5, plainPng);
  extractFrame(identMp4, 0.5, identPng);
  extractFrame(swapMp4, 0.5, swapPng);
  const identPsnr = psnrAverage(plainPng, identPng);
  assert.ok(identPsnr >= 45, `identity LUT must be near-transparent, PSNR=${identPsnr}`);
  const swapPsnr = psnrAverage(plainPng, swapPng);
  assert.ok(swapPsnr < 40, `swap-RB LUT must differ strongly, PSNR=${swapPsnr}`);
});

test("CLI spine grade writes grade fields and rejects bad values", () => {
  const wsDir = makeWs("ws_cli_grade", 1000);
  fs.mkdirSync(path.join(wsDir, "luts"), { recursive: true });
  fs.writeFileSync(path.join(wsDir, "luts", "film.cube"), IDENTITY_CUBE, "utf8");

  const runGrade = (args: string[]) =>
    spawnSync(process.execPath, [CLI, "spine", "grade", "--dir", wsDir, ...args], { encoding: "utf8" });

  let proc = runGrade(["--clip", "sp_01", "--brightness", "0.1", "--contrast", "1.2", "--temperature", "5600"]);
  assert.equal(proc.status, 0, `grade failed: ${proc.stderr}`);
  let seq = loadSequence(wsDir).sequence;
  assert.equal(seq.spine.clips[0].treatments.color_grade.brightness, 0.1);
  assert.equal(seq.spine.clips[0].treatments.color_grade.contrast, 1.2);
  assert.equal(seq.spine.clips[0].treatments.color_grade.temperature_k, 5600);

  proc = runGrade(["--clip", "sp_01", "--lut", "luts/film.cube"]);
  assert.equal(proc.status, 0, `grade --lut failed: ${proc.stderr}`);
  seq = loadSequence(wsDir).sequence;
  assert.equal(seq.spine.clips[0].treatments.color_grade.lut_uri, "luts/film.cube");

  proc = runGrade(["--clip", "sp_01", "--lut", "none"]);
  assert.equal(proc.status, 0, `grade --lut none failed: ${proc.stderr}`);
  seq = loadSequence(wsDir).sequence;
  assert.equal(seq.spine.clips[0].treatments.color_grade.lut_uri, null);

  proc = runGrade(["--clip", "sp_01", "--temperature", "50000"]);
  assert.notEqual(proc.status, 0, "out-of-range temperature must fail");
  assert.ok(proc.stderr.includes("CUTHOL-G124"), proc.stderr);

  proc = runGrade(["--clip", "sp_01", "--lut", "luts/missing.cube"]);
  assert.notEqual(proc.status, 0, "missing LUT must fail");
  assert.ok(proc.stderr.includes("CUTHOL-G414"), proc.stderr);
});

test("MCP catalog carries the spine grade action", () => {
  const spec = findActionSpec("spine", "grade");
  assert.ok(spec, "spine.grade must exist in ACTION_SPECS");
  assert.deepEqual(spec.argv, ["spine", "grade"]);
  const names = spec.params.map((p) => p.name);
  for (const want of ["clip", "brightness", "contrast", "saturation", "temperature", "lut"]) {
    assert.ok(names.includes(want), `grade param '${want}' missing in ${names.join(",")}`);
  }
});
