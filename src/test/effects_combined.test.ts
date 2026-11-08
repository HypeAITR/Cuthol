/**
 * cross-gate interaction tests (effect gates combined).
 *
 * (a) colour grade + fx on one clip keep stage order (colour before fx) in the
 *     render plan; (b) a ramped clip carrying fx and a cubic-bezier envelope
 *     compiles and verifies; (c) mirror edge fill + an extension push
 *     transition on the same clips compile together; (d) a cubic-bezier eased
 *     extension transition uses the shared cubic solver (no G122/G120).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import {
  addSpineFx,
  appendSpineClip,
  setItemEnvelope,
  setSpineGrade,
  setSpineSpeed,
  setSpineTransition,
  transformSpineClip,
} from "../sequence/spine.js";
import { verifySequence } from "../verify/gates.js";

const MERGEDEMO_MANIFEST: Record<string, unknown> = {
  name: "mergedemo",
  version: "1.0.0",
  description: "merge interaction fixture (fx + transition in one manifest)",
  fx: {
    soft_blur: {
      description: "Gaussian blur",
      params: { sigma: { type: "number", default: 4, min: 0, max: 50 } },
      animatable: ["sigma"],
      video_filter: "gblur=sigma={{sigma}}",
    },
  },
  transitions: {
    itme: {
      description: "push: incoming slides in from the right, outgoing slides out left",
      incoming_x: "if(lt(t,{{t1}}),{{W}}-{{W}}*{{p}},{{x}})",
      outgoing_x: "if(lt(t,{{t1}}),{{x}}-{{W}}*{{p}},{{x}}-{{W}})",
    },
  },
};

function withMergeWorkspace(clips: number, fn: (wsDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-merge-"));
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "merge", aspect: "16:9", fps: 30 });
    const extDir = path.join(wsDir, ".cuthol", "extensions", "mergedemo");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, "cuthol-extension.json"),
      JSON.stringify(MERGEDEMO_MANIFEST, null, 2),
      "utf8"
    );
    enableExtensionInWorkspace({ workspaceDir: wsDir, name: "mergedemo" });
    for (let i = 0; i < clips; i++) {
      const media = path.join(tmp, `src${i}.mp4`);
      const proc = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x240:rate=30:duration=4",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=4",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-shortest",
          media,
        ],
        { encoding: "utf8" }
      );
      assert.equal(proc.status, 0, `ffmpeg src${i}: ${proc.stderr ?? ""}`);
      const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
      appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle });
    }
    fn(wsDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The filter chain feeding one spine pad (`[v_sp_<idx>]`) inside the render plan. */
function spineClipChain(filterComplex: string, idx: number): string {
  const seg = filterComplex
    .split(";")
    .find((s) => s.trimEnd().endsWith(`[v_sp_${idx}]`));
  assert.ok(seg, `spine chain [v_sp_${idx}] missing`);
  return seg;
}

function errorCodes(wsDir: string): string[] {
  const { sequence, paths } = loadSequence(wsDir);
  return verifySequence(sequence, paths)
    .diagnostics.filter((d) => d.severity === "ERROR")
    .map((d) => d.code);
}

test("merge (a): grade then fx on one clip keep stage order in the render plan", () => {
  withMergeWorkspace(1, (ws) => {
    setSpineGrade({ workspaceDir: ws, clipId: "sp_01", brightness: 0.1 });
    addSpineFx({ workspaceDir: ws, clipId: "sp_01", kind: "ext:mergedemo/soft_blur", params: { sigma: 8 } });
    const { sequence, paths } = loadSequence(ws);
    const chain = spineClipChain(compileSequenceRenderPlan(sequence, paths, "draft_480p").filterComplex, 0);
    assert.ok(chain.includes("eq=brightness=0.10"), chain);
    assert.ok(chain.includes("gblur=sigma=8"), chain);
    assert.ok(chain.indexOf("eq=brightness=0.10") < chain.indexOf("gblur=sigma=8"), chain);
    assert.deepEqual(errorCodes(ws), []);
  });
});

test("merge (b): ramped clip with fx and a cubic-bezier envelope compiles and verifies", () => {
  withMergeWorkspace(1, (ws) => {
    setSpineSpeed({
      workspaceDir: ws,
      clipId: "sp_01",
      speedRamp: [
        { source_offset_ms: 0, rate: 1 },
        { source_offset_ms: 4000, rate: 2 },
      ],
    });
    addSpineFx({ workspaceDir: ws, clipId: "sp_01", filter: "gblur=sigma=2" });
    setItemEnvelope({
      workspaceDir: ws,
      targetId: "sp_01",
      parameter: "placement.opacity",
      points: [
        { offset_ms: 0, value: 1.0, easing: "linear" },
        { offset_ms: 1000, value: 0.5, easing: "cubic_bezier", bezier: [0.25, 0.1, 0.25, 1] },
      ],
    });
    const { sequence, paths } = loadSequence(ws);
    const chain = spineClipChain(compileSequenceRenderPlan(sequence, paths, "draft_480p").filterComplex, 0);
    assert.ok(chain.includes("setpts="), chain);
    assert.ok(chain.includes("log("), `ramp integral missing: ${chain}`);
    assert.ok(chain.includes("gblur=sigma=2"), chain);
    assert.deepEqual(errorCodes(ws), []);
  });
});

test("merge (c): mirror edge fill plus an ext push transition compile together", () => {
  withMergeWorkspace(2, (ws) => {
    transformSpineClip({ workspaceDir: ws, clipId: "sp_01", scale: 0.6, edge: "mirror" });
    setSpineTransition({
      workspaceDir: ws,
      clipId: "sp_01",
      transition: { kind: "ext:mergedemo/itme", duration_ms: 1000, easing: "linear" },
    });
    const { sequence, paths } = loadSequence(ws);
    const filterComplex = compileSequenceRenderPlan(sequence, paths, "draft_480p").filterComplex;
    assert.ok(filterComplex.includes("fillborders="), filterComplex);
    assert.ok(filterComplex.includes("mode=mirror"), filterComplex);
    assert.ok(filterComplex.includes("854-854*"), `push motion missing: ${filterComplex}`);
    assert.deepEqual(errorCodes(ws), []);
  });
});

test("merge (d): cubic-bezier eased ext transition uses the shared solver", () => {
  withMergeWorkspace(2, (ws) => {
    setSpineTransition({
      workspaceDir: ws,
      clipId: "sp_01",
      transition: {
        kind: "ext:mergedemo/itme",
        duration_ms: 800,
        easing: "cubic_bezier",
        bezier: [0.42, 0, 0.58, 1],
      },
    });
    const { sequence, paths } = loadSequence(ws);
    const filterComplex = compileSequenceRenderPlan(sequence, paths, "draft_480p").filterComplex;
    assert.ok(filterComplex.includes("st(2,"), `bezier solver missing: ${filterComplex.slice(0, 600)}`);
    assert.ok(filterComplex.includes("ld(0)"), filterComplex.slice(0, 600));
    const { diagnostics } = verifySequence(sequence, paths);
    assert.ok(
      !diagnostics.some((d) => d.code === "CUTHOL-G122" || d.code === "CUTHOL-G120"),
      JSON.stringify(diagnostics)
    );
    assert.deepEqual(errorCodes(ws), []);
  });
});
