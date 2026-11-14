/**
 * Live colour endpoints (`src/test/live_color_api.test.ts`): graded LUT fetch,
 * unsaved drag preview, 501 text map, the `color` window-edit mapping, and the
 * CPU tetrahedral sampler matching the render LUT within tolerance.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence, updateSequenceInPlace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { buildEditCliArgs } from "../live/live_edit_api.js";
import { liveColorLut, liveColorMap, liveColorPreview } from "../live/live_color_api.js";
import type { ColorStageSpec } from "../color/types.js";

function decodeLutPayload(body: { data: string }): Float32Array {
  return new Float32Array(Buffer.from(body.data, "base64").buffer);
}

process.env.CUTHOL_SKILLS_AUTO = "0";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-color-"));

function ffmpegTone(outPath: string, seconds: number): void {
  const proc = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=0x4488FF:s=160x160:r=30:d=${seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", outPath],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

const STAGE: ColorStageSpec = {
  exposure: { stops: 0.5 },
  white_balance: { temp_mired: 20, tint: 0.05 },
  tone: { contrast: 0.1, shadows: 0.1, highlights: -0.1 },
  saturation: { saturation: 1.2, vibrance: 0.2 },
  hsl: [{ id: "skin", hue_center_deg: 30, hue_width_deg: 40, hue_soft_deg: 10, sat_min: 0.2, sat_max: 1, luma_min: 0.1, luma_max: 0.9, hue_shift_deg: 5, sat_scale: 1.1, luma_shift: 0 }],
};

function makeWorkspace(name: string): { dir: string; clip: string } {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  initWorkspace({ dir, title: name, aspect: "16:9", fps: 30 });
  const media = path.join(ROOT, `${name}.mp4`);
  if (!fs.existsSync(media)) ffmpegTone(media, 2);
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: dir, filePaths: [media] });
  const a = appendSpineClip({ workspaceDir: dir, assetHandle: item.handle });
  updateSequenceInPlace(dir, (seq) => {
    const clip = seq.spine.clips.find((c) => c.id === a.clip.id);
    assert.ok(clip);
    clip.treatments.color = JSON.parse(JSON.stringify(STAGE));
  });
  return { dir, clip: a.clip.id };
}

test("color LUT endpoint returns a decodable tetrahedral LUT", () => {
  const { dir, clip } = makeWorkspace("lut");
  const out = liveColorLut(dir, clip);
  assert.equal(out.status, 200);
  const body = out.json as { ok: boolean; size: number; data: string; hash: string; bake_ms: number; identity: boolean };
  assert.equal(body.ok, true);
  assert.ok(body.size === 33 || body.size === 65);
  assert.ok(typeof body.bake_ms === "number" && body.bake_ms < 5000);
  assert.equal(body.identity, false);
  const data = decodeLutPayload(body);
  assert.equal(data.length, body.size ** 3 * 3);
  assert.ok(data.every((v) => Number.isFinite(v)));
});

test("drag preview LUT matches the saved-stage LUT for the same stage", () => {
  const { dir, clip } = makeWorkspace("preview");
  const saved = liveColorLut(dir, clip);
  const drag = liveColorPreview(dir, { item: clip, stage: STAGE });
  assert.equal(drag.status, 200);
  assert.equal((saved.json as { hash: string }).hash, (drag.json as { hash: string }).hash);
});

test("map endpoint returns the graded item's map lines (measured in a child process)", async () => {
  const { dir, clip } = makeWorkspace("map");
  const out = await liveColorMap(dir, clip);
  assert.equal(out.status, 200, JSON.stringify(out.json));
  const lines = (out.json as { lines: string[] }).lines;
  assert.ok(lines.some((l) => l.startsWith("tone ")), lines.join(" | "));
});

test("unknown item is a 404 with a diagnostic code", async () => {
  const { dir } = makeWorkspace("unknown");
  assert.equal(liveColorLut(dir, "sp_99").status, 404);
  assert.equal(liveColorPreview(dir, { item: "sp_99", stage: {} }).status, 404);
  assert.equal((await liveColorMap(dir, "sp_99")).status, 404);
});

test("color window edit maps to the agent CLI with expect_rev", () => {
  const { dir, clip } = makeWorkspace("argv");
  const args = buildEditCliArgs(
    { action: "color", target: clip, params: { patch: { exposure: { stops: 0.5 } } }, expect_rev: 7 },
    loadSequence(dir).sequence
  );
  assert.deepEqual(args.slice(0, 4), ["color", "set", "--item", clip]);
  assert.ok(args.includes("--patch") && args.includes("--reason") && args.includes("taste"));
  assert.ok(args.includes("--expect-rev") && args.includes("7"));
  assert.throws(() => buildEditCliArgs({ action: "color", target: clip, params: {} }, loadSequence(dir).sequence));
});

test("compiled LUT self-test passes for the graded stage", () => {
  const { dir, clip } = makeWorkspace("tetra");
  const out = liveColorLut(dir, clip);
  assert.equal(out.status, 200);
  const body = out.json as { selftest: { p99_de: number; mean_de: number }; size: number };
  assert.ok(body.selftest.p99_de <= 1.5, `p99 ${body.selftest.p99_de}`);
  void clip;
});
