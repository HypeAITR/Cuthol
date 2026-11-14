// Focused tests for the colour measurement modules: map, diff, solve, predict, source kind, clusters,
// variant sheets. Camera frames come from the trial media (skipped with a reason when missing); the
// screen-recording and landscape-like samples are generated with ffmpeg so the test runs anywhere.
import "./test_setup.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadReferenceFrames } from "../color/frames.js";
import { colorMap } from "../color/map.js";
import { colorDiff } from "../color/diff.js";
import { colorSolve } from "../color/solve.js";
import { predictStage } from "../color/predict.js";
import { clusterItems } from "../color/cluster.js";
import { detectSourceKind } from "../color/source_kind.js";
import { renderVariantSheet } from "../color/variants.js";
import { stagePixelFunction } from "../color/math.js";
import type { ColorFrameSet } from "../color/types.js";
import { missingFixture, TRIAL_MEDIA_DIR } from "./fixtures.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-cmeasure-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const NEED_MEDIA = missingFixture("trial-media/talk.mp4", "trial-media/broll_2.mp4");
const TALK = path.join(TRIAL_MEDIA_DIR, "talk.mp4");
const BROLL2 = path.join(TRIAL_MEDIA_DIR, "broll_2.mp4");

function ffmpeg(args: string[]): void {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
}

/** One PNG frame of a video at a fraction of its length (cached per call site). */
function frameAt(video: string, frac: number): string {
  const out = path.join(TMP, `${path.basename(video, ".mp4")}_${frac}.png`);
  if (fs.existsSync(out)) return out;
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], { encoding: "utf8", windowsHide: true });
  const dur = Number(String(probe.stdout).trim()) || 4;
  ffmpeg(["-ss", String(dur * frac), "-i", video, "-frames:v", "1", out]);
  return out;
}

/** A flat UI-like frame: white page, grey sidebar, coloured buttons, text-like dark bars. */
function screenLike(): string {
  const out = path.join(TMP, "screen.png");
  if (fs.existsSync(out)) return out;
  const boxes = [
    "drawbox=x=0:y=0:w=160:h=360:color=0xE5E7EB:t=fill",
    "drawbox=x=0:y=0:w=640:h=40:color=0x1F2937:t=fill",
    "drawbox=x=200:y=70:w=120:h=34:color=0x2563EB:t=fill",
    "drawbox=x=340:y=70:w=120:h=34:color=0x16A34A:t=fill",
    ...Array.from({ length: 8 }, (_, i) => `drawbox=x=200:y=${130 + i * 24}:w=${260 + (i % 3) * 60}:h=8:color=0x374151:t=fill`),
  ].join(",");
  ffmpeg(["-f", "lavfi", "-i", "color=c=0xFFFFFF:s=640x360:d=1", "-vf", boxes, "-frames:v", "1", out]);
  return out;
}

/** A colourful frame with almost no neutral pixels (stand-in for a sunset landscape). */
function colourful(): string {
  const out = path.join(TMP, "colourful.png");
  if (fs.existsSync(out)) return out;
  ffmpeg(["-f", "lavfi", "-i", "gradients=s=640x360:c0=0xFF7A1A:c1=0xC2185B:x0=0:y0=0:x1=640:y1=360:d=1", "-frames:v", "1", out]);
  return out;
}

function graded(set: ColorFrameSet, stage: Parameters<typeof stagePixelFunction>[0]): ColorFrameSet {
  const fn = stagePixelFunction(stage, null);
  return {
    ...set,
    frames: set.frames.map((f) => {
      const out = new Float32Array(f.length);
      const p: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < f.length; i += 3) {
        p[0] = f[i]; p[1] = f[i + 1]; p[2] = f[i + 2];
        fn(p);
        out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
      }
      return out;
    }),
  };
}

describe("color map", () => {
  it("emits six fixed-order lines with stable keys", { skip: NEED_MEDIA }, () => {
    const m = colorMap(loadReferenceFrames(frameAt(TALK, 0.5), { width: 128 }), { label: "talk" });
    assert.equal(m.lines.length, 6);
    assert.match(m.lines[0], /^tone /);
    assert.match(m.lines[1], /^neutral /);
    assert.match(m.lines[2], /^colour /);
    assert.match(m.lines[3], /^hues /);
    assert.match(m.lines[4], /^time /);
    assert.match(m.lines[5], /^evidence /);
    for (const k of ["L_p01", "L_p50", "L_p99", "neutral_cov", "M", "chroma_p50"]) {
      assert.equal(typeof m.fields[k], "number", k);
    }
  });

  it("flags missing neutral coverage as evidence instead of guessing", () => {
    const m = colorMap(loadReferenceFrames(colourful(), { width: 128 }));
    assert.ok(Array.isArray(m.evidence) && m.evidence.length > 0, "a colourful frame needs an evidence note");
    assert.ok((m.fields.neutral_cov as number) < 0.2 || m.evidence.some((e) => e.includes("neutral") || e.includes("selective") || e.includes("dominant")), JSON.stringify(m.evidence));
  });
});

describe("color diff", () => {
  it("reports exposure in stops with the right sign", { skip: NEED_MEDIA }, () => {
    const set = loadReferenceFrames(frameAt(TALK, 0.5), { width: 96 });
    const d = colorDiff(colorMap(set), colorMap(graded(set, { exposure: { stops: 0.5 } })));
    assert.ok(d.deltas.exposure_stops > 0.2, JSON.stringify(d.deltas));
    assert.ok(d.overlap >= 0 && d.overlap <= 1);
  });
});

describe("color solve", () => {
  it("match recovers a known grade within tolerance", { skip: NEED_MEDIA }, () => {
    const base = loadReferenceFrames(TALK, { width: 96, count: 3 });
    const truth = { white_balance: { temp_mired: 30, tint: 0 }, exposure: { stops: -0.7 }, saturation: { saturation: 0.7 } };
    const r = colorSolve({ mode: "match", from: base, to: graded(base, truth), rootDir: TMP });
    assert.ok(Math.abs((r.patch.white_balance?.temp_mired ?? 0) - 30) <= 8, JSON.stringify(r.patch));
    assert.ok(Math.abs((r.patch.exposure?.stops ?? 0) - -0.7) <= 0.15, JSON.stringify(r.patch));
    assert.ok(Math.abs((r.patch.saturation?.saturation ?? 1) - 0.7) <= 0.15, JSON.stringify(r.patch));
    assert.ok(r.lines[r.lines.length - 1].startsWith("cuthol color set "));
  });

  it("pair writes a .cube look and reports a small residual", { skip: NEED_MEDIA }, () => {
    const base = loadReferenceFrames(frameAt(TALK, 0.5), { width: 96 });
    const dir = fs.mkdtempSync(path.join(TMP, "pair-"));
    const r = colorSolve({ mode: "pair", from: base, to: graded(base, { saturation: { saturation: 0.6 } }), rootDir: dir, name: "t-look" });
    assert.ok(r.lut_uri?.endsWith(".cube"));
    assert.ok(fs.existsSync(path.join(dir, r.lut_uri!)));
    assert.ok(Number.isFinite(r.predicted_residual_de) && r.predicted_residual_de < 2, String(r.predicted_residual_de));
  });

  it("technical answers with a set command or a white-balance note", { skip: NEED_MEDIA }, () => {
    const set = loadReferenceFrames(frameAt(BROLL2, 0.5), { width: 96 });
    const r = colorSolve({ mode: "technical", from: set, rootDir: TMP, technical: ["exposure", "white_balance", "legal_range"] });
    assert.ok(r.lines.some((l) => l.startsWith("cuthol color set") || l.includes("white balance")), r.lines.join(" | "));
  });
});

describe("color predict", () => {
  it("flags a white wall turning colour on a warm highlight push", { skip: NEED_MEDIA }, () => {
    const base = loadReferenceFrames(TALK, { width: 96, count: 3 });
    const p = predictStage(base, stagePixelFunction({ white_balance: { temp_mired: 60, tint: 0.4 } }, null));
    assert.ok(p.side_effects.some((s) => s.includes("white wall turns")), JSON.stringify(p.side_effects));
    assert.ok(p.mean_change_de > 1);
  });

  it("predicts 7 frames at 256 px quickly", { skip: NEED_MEDIA }, () => {
    const base = loadReferenceFrames(TALK, { width: 256, count: 7 });
    const t0 = Date.now();
    predictStage(base, stagePixelFunction({ exposure: { stops: 0.5 } }, null));
    assert.ok(Date.now() - t0 < 3000, "predict too slow");
  });
});

describe("color source kind", () => {
  it("separates camera footage from screens and graphics", { skip: NEED_MEDIA }, () => {
    assert.equal(detectSourceKind(loadReferenceFrames(frameAt(TALK, 0.5), { width: 128 })).kind, "camera");
    assert.equal(detectSourceKind(loadReferenceFrames(screenLike(), { width: 128 })).kind, "screen");
    assert.equal(detectSourceKind(loadReferenceFrames(frameAt(BROLL2, 0.5), { width: 128 })).kind, "graphic");
  });
});

describe("color cluster and variants", () => {
  it("groups near-identical maps and splits different ones", { skip: NEED_MEDIA }, () => {
    const a = colorMap(loadReferenceFrames(frameAt(TALK, 0.2), { width: 96 }));
    const b = colorMap(loadReferenceFrames(frameAt(TALK, 0.5), { width: 96 }));
    const c = colorMap(loadReferenceFrames(screenLike(), { width: 96 }));
    const clusters = clusterItems([
      { itemId: "t1", map: a },
      { itemId: "t2", map: b },
      { itemId: "s1", map: c },
    ]);
    const same = clusters.find((x) => x.items.includes("t1"));
    assert.ok(same?.items.includes("t2"), JSON.stringify(clusters));
    assert.ok(!same?.items.includes("s1"));
  });

  it("renders a variant sheet with the untouched picture first", { skip: NEED_MEDIA }, () => {
    const r = renderVariantSheet({
      source: loadReferenceFrames(frameAt(TALK, 0.5), { width: 128 }),
      variants: [{ label: "warmer", fn: stagePixelFunction({ white_balance: { temp_mired: 40, tint: 0 } }, null) }],
      outPng: path.join(TMP, "variant-sheet.png"),
    });
    assert.ok(fs.existsSync(r.png));
    assert.match(r.lines[0], /untouched \| warmer/);
  });
});
