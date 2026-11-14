/**
 * Colour block math and LUT baking (`src/color/math.ts`, `src/color/lut.ts`, `src/color/blocks.ts`).
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildMonotoneCurve,
  decode24,
  deltaE2000,
  evalMonotoneCurve,
  isIdentityStage,
  LUMA_B,
  LUMA_G,
  LUMA_R,
  MID_GREY_ENCODED,
  stagePixelFunction,
  whiteBalanceGains,
} from "../color/math.js";
import {
  applyLutToPixels,
  bakeLut,
  compileLut,
  cubePixelFunction,
  LUT_DEFAULT_SIZE,
  LUT_FINE_SIZE,
  parseCube,
  randomRgbSamples,
  serializeCube,
  selfTestLut,
} from "../color/lut.js";
import { parseColorParam, resolveItemLook, validateColorBlocks, withColorParam } from "../color/blocks.js";
import type { ColorStageSpec } from "../color/types.js";
import type { CutholSequence } from "../core/schema.js";

type Px = [number, number, number];
const run = (fn: (p: Px) => void, p: Px): Px => {
  const q: Px = [...p];
  fn(q);
  return q;
};

test("CIEDE2000 matches published reference pairs", () => {
  // Sharma, Wu, Dalal (2005) test data, pairs 1, 7 and 17.
  assert.ok(Math.abs(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485]) - 2.0425) < 1e-3);
  assert.ok(Math.abs(deltaE2000([50, 0, 0], [50, -1, 2]) - 2.3669) < 1e-3);
  assert.ok(Math.abs(deltaE2000([50, 2.5, 0], [73, 25, -18]) - 27.1492) < 1e-3);
});

test("empty and neutral stages are identity", () => {
  assert.equal(isIdentityStage(undefined), true);
  assert.equal(isIdentityStage({ exposure: { stops: 0 }, white_balance: { temp_mired: 0, tint: 0 }, tone: { contrast: 0 } }), true);
  assert.equal(isIdentityStage({ exposure: { stops: 0.5 } }), false);
  assert.equal(isIdentityStage({ exposure: { stops: 0.5, enabled: false } }), true);
  const fn = stagePixelFunction({});
  const s = randomRgbSamples(200);
  for (let i = 0; i < s.length; i += 3) {
    const q = run(fn, [s[i], s[i + 1], s[i + 2]]);
    assert.ok(Math.abs(q[0] - s[i]) < 1e-6 && Math.abs(q[1] - s[i + 1]) < 1e-6 && Math.abs(q[2] - s[i + 2]) < 1e-6);
  }
});

test("white balance: zero is identity, warm raises red and lowers blue, luma is kept", () => {
  const g0 = whiteBalanceGains(0, 0);
  for (const v of g0) assert.ok(Math.abs(v - 1) < 1e-9);
  const warm = whiteBalanceGains(60, 0);
  assert.ok(warm[0] > 1 && warm[2] < 1);
  const cool = whiteBalanceGains(-60, 0);
  assert.ok(cool[0] < 1 && cool[2] > 1);
  for (const g of [warm, cool, whiteBalanceGains(0, 0.5)]) {
    assert.ok(Math.abs(LUMA_R * g[0] + LUMA_G * g[1] + LUMA_B * g[2] - 1) < 1e-9);
  }
  assert.ok(whiteBalanceGains(0, 0.5)[1] < 1, "positive tint = less green (magenta)");
});

test("exposure +1 stop doubles linear light", () => {
  const fn = stagePixelFunction({ exposure: { stops: 1 } });
  const q = run(fn, [MID_GREY_ENCODED, MID_GREY_ENCODED, MID_GREY_ENCODED]);
  assert.ok(Math.abs(decode24(q[0]) - 0.36) < 1e-6);
});

test("amount 0 disables a block, amount 0.5 is halfway", () => {
  const full = run(stagePixelFunction({ exposure: { stops: 1 } }), [0.4, 0.4, 0.4]);
  const half = run(stagePixelFunction({ exposure: { stops: 1, amount: 0.5 } }), [0.4, 0.4, 0.4]);
  const none = run(stagePixelFunction({ exposure: { stops: 1, amount: 0 } }), [0.4, 0.4, 0.4]);
  assert.ok(Math.abs(none[0] - 0.4) < 1e-9);
  assert.ok(Math.abs(half[0] - (0.4 + full[0]) / 2) < 1e-9);
});

test("tone and curves stay monotone and keep end points", () => {
  const fn = stagePixelFunction({
    tone: { contrast: 1, shadows: -1, highlights: 1, blacks: -1, whites: 1 },
    curves: { master: [[0.25, 0.15], [0.75, 0.9]] },
  });
  let prev = -1;
  for (let i = 0; i <= 200; i++) {
    const x = i / 200;
    const y = run(fn, [x, x, x])[0];
    assert.ok(y >= prev - 1e-9, `non-monotone at ${x}`);
    prev = y;
  }
  const c = buildMonotoneCurve([[0.25, 0.15], [0.75, 0.9]])!;
  assert.ok(Math.abs(evalMonotoneCurve(c, 0.25) - 0.15) < 1e-9);
  assert.ok(Math.abs(evalMonotoneCurve(c, 0.75) - 0.9) < 1e-9);
  assert.equal(evalMonotoneCurve(c, 0), 0);
  assert.equal(evalMonotoneCurve(c, 1), 1);
});

test("HSL qualifier changes only its hue window and leaves greys alone", () => {
  const stage: ColorStageSpec = { hsl: [{ id: "hsl_01", hue_center_deg: 120, hue_width_deg: 40, sat_scale: 0, hue_shift_deg: 0 }] };
  const fn = stagePixelFunction(stage);
  const green = run(fn, [0.2, 0.7, 0.2]);
  assert.ok(Math.abs(green[0] - green[1]) < 0.02, "green desaturated");
  const red = run(fn, [0.8, 0.2, 0.2]);
  assert.deepEqual(red.map((v) => v.toFixed(6)), ["0.800000", "0.200000", "0.200000"]);
  const grey = run(fn, [0.5, 0.5, 0.5]);
  assert.deepEqual(grey.map((v) => v.toFixed(6)), ["0.500000", "0.500000", "0.500000"]);
});

test("LUT: identity bake samples back exactly; .cube round trip", () => {
  const lut = bakeLut(() => {}, LUT_DEFAULT_SIZE);
  const s = randomRgbSamples(500);
  const out = applyLutToPixels(lut, s);
  for (let i = 0; i < s.length; i++) assert.ok(Math.abs(out[i] - s[i]) < 1e-5);
  const parsed = parseCube(serializeCube(lut));
  assert.equal(parsed.size, LUT_DEFAULT_SIZE);
  const fn = cubePixelFunction(parsed);
  const q = run(fn, [0.3, 0.6, 0.9]);
  assert.ok(Math.abs(q[0] - 0.3) < 1e-5 && Math.abs(q[2] - 0.9) < 1e-5);
  assert.throws(() => parseCube("LUT_3D_SIZE 2\n0 0 0\n"), /expected 8 rows/);
});

test("LUT compiler: global stack stays at 33 within limit; narrow HSL moves to 65", () => {
  const global = stagePixelFunction({
    white_balance: { temp_mired: 25, tint: 0.1 },
    exposure: { stops: 0.4 },
    tone: { contrast: 0.3, shadows: 0.2 },
    saturation: { saturation: 1.1, vibrance: 0.3 },
  });
  const g = compileLut(global);
  assert.equal(g.lut.size, LUT_DEFAULT_SIZE);
  assert.ok(g.selftest.p99_de <= 1.0, `p99 ${g.selftest.p99_de}`);
  const narrow = stagePixelFunction({
    hsl: [{ id: "hsl_01", hue_center_deg: 30, hue_width_deg: 6, hue_soft_deg: 3, hue_shift_deg: -25, sat_scale: 1.8 }],
  });
  const n = compileLut(narrow);
  const coarse = selfTestLut(bakeLut(narrow, LUT_DEFAULT_SIZE), narrow, randomRgbSamples(4096));
  if (coarse.p99_de > 1.0) assert.equal(n.lut.size, LUT_FINE_SIZE);
  assert.ok(n.selftest.p99_de <= coarse.p99_de);
});

test("colour parameter paths parse and set", () => {
  assert.deepEqual(parseColorParam("color.exposure.stops"), { block: "exposure", field: "stops" });
  assert.deepEqual(parseColorParam("color.hsl.hsl_01.sat_scale"), { block: "hsl", hslId: "hsl_01", field: "sat_scale" });
  assert.deepEqual(parseColorParam("color.wheels.lift.amount"), { block: "wheels", wheel: "lift", field: "amount" });
  assert.equal(parseColorParam("color.exposure.bogus"), null);
  assert.equal(parseColorParam("placement.x_pct"), null);
  const s = withColorParam(undefined, "color.white_balance.temp_mired", 30);
  assert.deepEqual(s.white_balance, { temp_mired: 30, tint: 0 });
  assert.equal(validateColorBlocks("sp_01", { exposure: { stops: 20 } }).length, 1);
  assert.equal(validateColorBlocks("sp_01", { hsl: [{ id: "a", hue_center_deg: 0, hue_width_deg: 10 }, { id: "a", hue_center_deg: 0, hue_width_deg: 10 }] }).length, 1);
});

test("Look resolution: binding wins; apply_to respects scope kinds", () => {
  const seq = {
    library: [
      { handle: "vid_01", kind: "footage" },
      { handle: "vid_02", kind: "footage", color_source: { kind: "screen" } },
    ],
    looks: [{ id: "look_01", name: "warm", blocks: { exposure: { stops: 0.2 } }, apply_to: "all", amount: 0.8 }],
  } as unknown as CutholSequence;
  const cam = resolveItemLook(seq, { id: "sp_01", track: "spine", asset_handle: "vid_01", stage: undefined });
  assert.equal(cam.look?.id, "look_01");
  assert.equal(cam.amount, 0.8);
  const scr = resolveItemLook(seq, { id: "sp_02", track: "spine", asset_handle: "vid_02", stage: undefined });
  assert.equal(scr.look, null);
  const bound = resolveItemLook(seq, { id: "sp_02", track: "spine", asset_handle: "vid_02", stage: { look: { id: "look_01", amount: 0.3 } } });
  assert.equal(bound.via, "binding");
  assert.equal(bound.amount, 0.3);
});

test("cube files written to disk read back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-color-"));
  const fn = stagePixelFunction({ exposure: { stops: -0.5 } });
  const lut = bakeLut(fn, 17);
  const file = path.join(dir, "x.cube");
  fs.writeFileSync(file, serializeCube(lut));
  const back = cubePixelFunction(parseCube(fs.readFileSync(file, "utf8")));
  const a = run(fn, [0.5, 0.5, 0.5]);
  const b = run(back, [0.5, 0.5, 0.5]);
  assert.ok(Math.abs(a[0] - b[0]) < 1e-4);
  fs.rmSync(dir, { recursive: true, force: true });
});
