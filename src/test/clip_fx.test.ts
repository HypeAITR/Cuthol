/**
 * `spine fx`: per-clip effect chains compiled in the render graph (stage 4).
 * Extension fx (`ext:<ext>/<name>`) substitute manifest templates in order; the single built-in kind
 * (`ffmpeg`) passes a raw chain while graph separators and file-reading filters are rejected (G118).
 * Envelopes animate only manifest-declared `animatable` params, anything else is G119, and a drifted
 * extension pins G411. The source asset is never touched, so transcript bindings stay intact.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSpineCommand } from "../cli_cmd_spine.js";
import type { CliCommandContext } from "../cli_output.js";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { checkBuiltinFxFilterChain } from "../compositor/compile_spine_fx.js";
import { CutholError } from "../core/diagnostics.js";
import { commitSequenceMutation, initWorkspace, loadSequence, stepJournal } from "../core/workspace.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { resolveExtension } from "../extensions/ext_registry.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { renderSequenceToMp4 } from "../render/render_main.js";
import { appendSpineClip, exciseSpineRanges, setItemEnvelope, splitSpineClip } from "../sequence/spine.js";
import { addSpineFx, listSpineFx, removeSpineFx, setSpineFx } from "../sequence/spine_fx.js";
import { projectTranscriptWordsToClip } from "../sequence/spine_time.js";
import { verifySequence } from "../verify/gates.js";

function withFxWorkspace(fn: (wsDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fx-"));
  const wsDir = path.join(tmp, "proj");
  try {
    initWorkspace({ dir: wsDir, title: "fx", aspect: "16:9", fps: 30 });
    fn(wsDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeExtension(wsDir: string, manifest: Record<string, unknown>): string {
  const dir = path.join(wsDir, ".cuthol", "extensions", String(manifest.name));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cuthol-extension.json"), JSON.stringify(manifest, null, 2), "utf8");
  return dir;
}

function ffmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || "ffmpeg failed");
}

function makeAvMp4(outPath: string, durationSec = 4): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  ffmpeg([
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=320x240:rate=30:duration=${durationSec}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    outPath,
  ]);
}

/** A workspace with one 4 s clip; returns clip id + asset handle. */
function setupClip(wsDir: string): { clipId: string; handle: string } {
  const media = path.join(wsDir, "media", "a.mp4");
  makeAvMp4(media);
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  const { clip } = appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle });
  return { clipId: clip.id, handle: item.handle };
}

const FXDEMO_MANIFEST: Record<string, unknown> = {
  name: "fxdemo",
  version: "1.0.0",
  description: "fx test effects",
  fx: {
    soft_blur: {
      description: "Gaussian blur",
      params: { sigma: { type: "number", default: 4, min: 0, max: 50 } },
      animatable: ["sigma"],
      video_filter: "gblur=sigma={{sigma}}",
    },
    tint: {
      description: "fixed tint (not animatable)",
      params: { amount: { type: "number", default: 2 } },
      video_filter: "eq=brightness={{amount}}",
    },
    duo: {
      description: "two params",
      params: { a: { type: "number", default: 0 }, b: { type: "number", default: 0 } },
      video_filter: "eq=brightness={{a}}:contrast={{b}}",
    },
  },
};

/** The filter chain feeding one spine pad (`[v_sp_<idx>]`) inside the render plan. */
function spineClipChain(filterComplex: string, idx: number): string {
  const seg = filterComplex
    .split(";")
    .find((s) => s.trimEnd().endsWith(`[v_sp_${idx}]`));
  assert.ok(seg, `spine chain [v_sp_${idx}] missing`);
  return seg;
}

test("ext fx compiles into the clip chain after the colour stage, in add order", () => {
  withFxWorkspace((ws) => {
    writeExtension(ws, FXDEMO_MANIFEST);
    enableExtensionInWorkspace({ workspaceDir: ws, name: "fxdemo" });
    const { clipId } = setupClip(ws);
    commitSequenceMutation(ws, "test.color", (seq) => {
      seq.spine.clips[0].treatments.color_grade.brightness = 0.1;
    });
    addSpineFx({ workspaceDir: ws, clipId, kind: "ext:fxdemo/soft_blur", params: { sigma: 8 } });
    addSpineFx({ workspaceDir: ws, clipId, kind: "ext:fxdemo/tint" });
    const { sequence, paths } = loadSequence(ws);
    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
    const chain = spineClipChain(plan.filterComplex, 0);
    assert.ok(chain.includes("eq=brightness=0.10"), chain);
    assert.ok(chain.includes("gblur=sigma=8"), chain);
    assert.ok(chain.includes("eq=brightness=2"), chain);
    assert.ok(chain.indexOf("eq=brightness=0.10") < chain.indexOf("gblur=sigma=8"), chain);
    assert.ok(chain.indexOf("gblur=sigma=8") < chain.indexOf("eq=brightness=2"), chain);
  });
});

test("fx leaves asset binding and projected word times untouched", () => {
  withFxWorkspace((ws) => {
    const { clipId, handle } = setupClip(ws);
    const words = [
      { word: "merhaba", source_start_ms: 500, source_end_ms: 900 },
      { word: "dünya", source_start_ms: 1500, source_end_ms: 2100 },
    ];
    const before = loadSequence(ws).sequence.spine.clips[0];
    const beforeWords = projectTranscriptWordsToClip(before, words);
    addSpineFx({ workspaceDir: ws, clipId, filter: "gblur=sigma=3" });
    const after = loadSequence(ws).sequence.spine.clips[0];
    assert.equal(after.asset_handle, handle);
    assert.equal(after.asset_handle, before.asset_handle);
    assert.deepEqual(
      [after.source_in_ms, after.source_out_ms, after.duration_ms, after.timeline_in_ms],
      [before.source_in_ms, before.source_out_ms, before.duration_ms, before.timeline_in_ms]
    );
    assert.deepEqual(projectTranscriptWordsToClip(after, words), beforeWords);
  });
});

test("builtin chains reject graph separators and file-reading filters", () => {
  assert.equal(checkBuiltinFxFilterChain("gblur=sigma=3,unsharp"), null);
  assert.equal(checkBuiltinFxFilterChain("drawtext=text='a,b':fontsize=24"), null);
  assert.match(checkBuiltinFxFilterChain("movie=x.mp4") ?? "", /forbidden/);
  assert.match(checkBuiltinFxFilterChain("null,amovie=a.mp3") ?? "", /forbidden/);
  assert.match(checkBuiltinFxFilterChain("null,sendcmd=c='1 drawtext'") ?? "", /forbidden/);
  assert.match(checkBuiltinFxFilterChain("zmq=b=tcp") ?? "", /forbidden/);
  assert.match(checkBuiltinFxFilterChain("azmq=b=tcp") ?? "", /forbidden/);
  assert.match(checkBuiltinFxFilterChain("gblur=sigma=3;null") ?? "", /separator/);
  assert.match(checkBuiltinFxFilterChain("[0:v]null") ?? "", /separator/);
  assert.match(checkBuiltinFxFilterChain("lut3d=file=x.cube") ?? "", /reads a file/);
  assert.match(checkBuiltinFxFilterChain("subtitles=filename=x.srt") ?? "", /reads a file/);
  assert.match(checkBuiltinFxFilterChain("") ?? "", /non-empty/);
  assert.match(checkBuiltinFxFilterChain("gblur=sigma=3,,unsharp") ?? "", /unresolvable/);
  withFxWorkspace((ws) => {
    const { clipId } = setupClip(ws);
    assert.throws(() => addSpineFx({ workspaceDir: ws, clipId, filter: "movie=x.mp4" }), /CUTHOL-G118/);
    assert.throws(
      () => addSpineFx({ workspaceDir: ws, clipId, filter: "gblur=sigma=1;null" }),
      /CUTHOL-G118/
    );
    assert.deepEqual(listSpineFx({ workspaceDir: ws, clipId }).fx, []);
  });
});

test("unknown kind fails verify with G118 and render never starts", () => {
  withFxWorkspace((ws) => {
    setupClip(ws);
    commitSequenceMutation(ws, "test.inject", (seq) => {
      seq.spine.clips[0].fx = [{ id: "fx_01", kind: "nope", params: {} }];
    });
    const { sequence, paths } = loadSequence(ws);
    const report = verifySequence(sequence, paths);
    assert.equal(report.ok, false);
    assert.ok(
      report.diagnostics.some((d) => d.code === "CUTHOL-G118"),
      JSON.stringify(report.diagnostics)
    );
    assert.throws(
      () => renderSequenceToMp4({ workspaceDir: ws, outputPath: path.join(ws, "out.mp4"), preset: "draft_480p" }),
      /CUTHOL-G118/
    );
  });
});

test("clips without active fx compile byte-identically", () => {
  withFxWorkspace((ws) => {
    setupClip(ws);
    const planOf = (): string => {
      const { sequence, paths } = loadSequence(ws);
      return compileSequenceRenderPlan(sequence, paths, "draft_480p").filterComplex;
    };
    const plain = planOf();
    commitSequenceMutation(ws, "test.empty", (seq) => {
      seq.spine.clips[0].fx = [];
    });
    assert.equal(planOf(), plain);
    commitSequenceMutation(ws, "test.disabled", (seq) => {
      seq.spine.clips[0].fx = [
        { id: "fx_01", kind: "ffmpeg", params: { filter: "gblur=sigma=9" }, enabled: false },
      ];
    });
    assert.equal(planOf(), plain);
  });
});

test("fx ops allocate clip-scoped ids, merge on set, and undo cleanly", () => {
  withFxWorkspace((ws) => {
    const { clipId } = setupClip(ws);
    const r0 = loadSequence(ws).sequence.meta.revision;
    const a = addSpineFx({ workspaceDir: ws, clipId, filter: "gblur=sigma=3" });
    assert.equal(a.fx.id, "fx_01");
    assert.equal(a.fx.kind, "ffmpeg");
    assert.deepEqual(a.fx.params, { filter: "gblur=sigma=3" });
    const b = addSpineFx({ workspaceDir: ws, clipId, filter: "unsharp" });
    assert.equal(b.fx.id, "fx_02");
    assert.ok(b.revision > a.revision && a.revision > r0);
    const s = setSpineFx({ workspaceDir: ws, clipId, fxId: "fx_01", filter: "gblur=sigma=5" });
    assert.deepEqual(s.fx.params, { filter: "gblur=sigma=5" });
    assert.deepEqual(
      listSpineFx({ workspaceDir: ws, clipId }).fx.map((f) => f.id),
      ["fx_01", "fx_02"]
    );
    const r = removeSpineFx({ workspaceDir: ws, clipId, fxId: "fx_01" });
    assert.equal(r.removed_id, "fx_01");
    assert.deepEqual(
      listSpineFx({ workspaceDir: ws, clipId }).fx.map((f) => f.id),
      ["fx_02"]
    );
    const c = addSpineFx({ workspaceDir: ws, clipId, filter: "null" });
    assert.equal(c.fx.id, "fx_03");
    stepJournal(ws, "undo", 2);
    assert.deepEqual(
      listSpineFx({ workspaceDir: ws, clipId }).fx.map((f) => f.id),
      ["fx_01", "fx_02"]
    );
  });
});

test("remove deletes the fx envelopes; unknown fx ids are refused", () => {
  withFxWorkspace((ws) => {
    writeExtension(ws, FXDEMO_MANIFEST);
    enableExtensionInWorkspace({ workspaceDir: ws, name: "fxdemo" });
    const { clipId } = setupClip(ws);
    addSpineFx({ workspaceDir: ws, clipId, kind: "ext:fxdemo/soft_blur", params: { sigma: 4 } });
    setItemEnvelope({
      workspaceDir: ws,
      targetId: clipId,
      parameter: "fx.fx_01.sigma",
      points: [
        { offset_ms: 0, value: 2, easing: "linear" },
        { offset_ms: 1000, value: 6, easing: "linear" },
      ],
    });
    assert.ok(
      loadSequence(ws).sequence.spine.clips[0].envelopes.some((e) => e.parameter === "fx.fx_01.sigma")
    );
    removeSpineFx({ workspaceDir: ws, clipId, fxId: "fx_01" });
    const clip = loadSequence(ws).sequence.spine.clips[0];
    assert.equal(clip.fx, undefined);
    assert.ok(!clip.envelopes.some((e) => e.parameter.startsWith("fx.")), JSON.stringify(clip.envelopes));
    assert.throws(
      () => setSpineFx({ workspaceDir: ws, clipId, fxId: "fx_99", params: { sigma: 1 } }),
      /CUTHOL-G101/
    );
    assert.throws(() => removeSpineFx({ workspaceDir: ws, clipId, fxId: "fx_99" }), /CUTHOL-G101/);
  });
});

test("split and excise copy the fx list (and slice its envelopes) into every piece", () => {
  withFxWorkspace((ws) => {
    writeExtension(ws, FXDEMO_MANIFEST);
    enableExtensionInWorkspace({ workspaceDir: ws, name: "fxdemo" });
    const { clipId } = setupClip(ws);
    addSpineFx({ workspaceDir: ws, clipId, kind: "ext:fxdemo/soft_blur", params: { sigma: 4 } });
    setItemEnvelope({
      workspaceDir: ws,
      targetId: clipId,
      parameter: "fx.fx_01.sigma",
      points: [
        { offset_ms: 0, value: 2, easing: "linear" },
        { offset_ms: 4000, value: 6, easing: "linear" },
      ],
    });
    const { clips } = splitSpineClip({ workspaceDir: ws, clipId, splitPointsMs: [2000] });
    assert.equal(clips.length, 2);
    for (const c of clips) {
      assert.equal(c.fx?.length, 1);
      assert.equal(c.fx?.[0].kind, "ext:fxdemo/soft_blur");
      assert.deepEqual(c.fx?.[0].params, { sigma: 4 });
      const env = c.envelopes.find((e) => e.parameter === "fx.fx_01.sigma");
      assert.ok(env, `piece ${c.id} lost its fx envelope`);
      assert.ok(env.points.every((p) => p.offset_ms >= 0 && p.offset_ms <= c.duration_ms));
    }
    const { remainingClips } = exciseSpineRanges({
      workspaceDir: ws,
      clipId: clips[0].id,
      ranges: [{ start_ms: 500, end_ms: 1500 }],
    });
    assert.equal(remainingClips.length, 2);
    for (const c of remainingClips) {
      assert.equal(c.fx?.length, 1);
      assert.ok(c.envelopes.some((e) => e.parameter === "fx.fx_01.sigma"));
    }
  });
});

test("extension params validate type, range, enum, required and default (G118)", () => {
  withFxWorkspace((ws) => {
    writeExtension(ws, {
      name: "fxp",
      version: "1.0.0",
      description: "param matrix",
      fx: {
        grade: {
          params: {
            req: { type: "number", required: true },
            lim: { type: "number", default: 5, min: 0, max: 10 },
            mode: { type: "string", enum: ["a", "b"], default: "a" },
            flag: { type: "boolean", default: false },
          },
          video_filter: "eq=brightness={{req}}:contrast={{lim}},hue=s={{flag}}",
        },
      },
    });
    enableExtensionInWorkspace({ workspaceDir: ws, name: "fxp" });
    const { clipId } = setupClip(ws);
    const kind = "ext:fxp/grade";
    assert.throws(
      () => addSpineFx({ workspaceDir: ws, clipId, kind, params: { lim: 5 } }),
      /CUTHOL-G118/
    );
    assert.throws(
      () => addSpineFx({ workspaceDir: ws, clipId, kind, params: { req: 1, lim: 99 } }),
      /CUTHOL-G118/
    );
    assert.throws(
      () => addSpineFx({ workspaceDir: ws, clipId, kind, params: { req: 1, lim: -1 } }),
      /CUTHOL-G118/
    );
    assert.throws(
      () => addSpineFx({ workspaceDir: ws, clipId, kind, params: { req: 1, mode: "c" } }),
      /CUTHOL-G118/
    );
    assert.throws(
      () => addSpineFx({ workspaceDir: ws, clipId, kind, params: { req: "abc" } }),
      /CUTHOL-G118/
    );
    assert.throws(
      () => addSpineFx({ workspaceDir: ws, clipId, kind, params: { req: 1, bogus: 1 } }),
      /CUTHOL-G118/
    );
    const ok = addSpineFx({ workspaceDir: ws, clipId, kind, params: { req: 1, flag: true } });
    assert.equal(ok.fx.id, "fx_01");
    const { sequence, paths } = loadSequence(ws);
    const chain = spineClipChain(
      compileSequenceRenderPlan(sequence, paths, "draft_480p").filterComplex,
      0
    );
    assert.ok(chain.includes("eq=brightness=1:contrast=5"), chain);
    assert.ok(chain.includes("hue=s=1"), chain);
  });
});

test("only manifest-declared animatable params accept envelopes (G119 otherwise)", () => {
  withFxWorkspace((ws) => {
    writeExtension(ws, FXDEMO_MANIFEST);
    enableExtensionInWorkspace({ workspaceDir: ws, name: "fxdemo" });
    const { clipId } = setupClip(ws);
    addSpineFx({ workspaceDir: ws, clipId, kind: "ext:fxdemo/soft_blur", params: { sigma: 4 } });
    addSpineFx({ workspaceDir: ws, clipId, kind: "ext:fxdemo/tint" });
    addSpineFx({ workspaceDir: ws, clipId, filter: "gblur=sigma=2" });
    setItemEnvelope({
      workspaceDir: ws,
      targetId: clipId,
      parameter: "fx.fx_01.sigma",
      points: [
        { offset_ms: 0, value: 2, easing: "linear" },
        { offset_ms: 2000, value: 6, easing: "linear" },
      ],
    });
    const { sequence, paths } = loadSequence(ws);
    const chain = spineClipChain(
      compileSequenceRenderPlan(sequence, paths, "draft_480p").filterComplex,
      0
    );
    assert.ok(chain.includes("gblur=sigma='if(lt(t"), chain);
    assert.throws(
      () =>
        setItemEnvelope({
          workspaceDir: ws,
          targetId: clipId,
          parameter: "fx.fx_02.amount",
          points: [{ offset_ms: 0, value: 1, easing: "linear" }],
        }),
      /CUTHOL-G119/
    );
    assert.throws(
      () =>
        setItemEnvelope({
          workspaceDir: ws,
          targetId: clipId,
          parameter: "fx.fx_03.filter",
          points: [{ offset_ms: 0, value: 1, easing: "linear" }],
        }),
      /CUTHOL-G119/
    );
    assert.throws(
      () =>
        setItemEnvelope({
          workspaceDir: ws,
          targetId: clipId,
          parameter: "fx.fx_99.sigma",
          points: [{ offset_ms: 0, value: 1, easing: "linear" }],
        }),
      /CUTHOL-G119/
    );
  });
});

test("drifted extension versions warn G411 without blocking", () => {
  withFxWorkspace((ws) => {
    writeExtension(ws, FXDEMO_MANIFEST);
    enableExtensionInWorkspace({ workspaceDir: ws, name: "fxdemo" });
    const { clipId } = setupClip(ws);
    addSpineFx({ workspaceDir: ws, clipId, kind: "ext:fxdemo/soft_blur" });
    const clean = verifySequence(loadSequence(ws).sequence, loadSequence(ws).paths);
    assert.equal(clean.ok, true, JSON.stringify(clean.diagnostics));
    assert.ok(!clean.diagnostics.some((d) => d.code === "CUTHOL-G411"));
    writeExtension(ws, { ...FXDEMO_MANIFEST, version: "1.0.1" });
    const { sequence, paths } = loadSequence(ws);
    const drifted = verifySequence(sequence, paths);
    assert.equal(drifted.ok, true, JSON.stringify(drifted.diagnostics));
    const g411 = drifted.diagnostics.find((d) => d.code === "CUTHOL-G411");
    assert.ok(g411, JSON.stringify(drifted.diagnostics));
    assert.equal(g411.severity, "WARN");
  });
});

test("fx for a disabled extension is refused with an enable hint (G118)", () => {
  withFxWorkspace((ws) => {
    writeExtension(ws, FXDEMO_MANIFEST);
    const { clipId } = setupClip(ws);
    assert.throws(
      () => addSpineFx({ workspaceDir: ws, clipId, kind: "ext:fxdemo/soft_blur" }),
      /CUTHOL-G118/
    );
    try {
      addSpineFx({ workspaceDir: ws, clipId, kind: "ext:fxdemo/soft_blur" });
      assert.fail("must throw");
    } catch (err) {
      assert.ok(err instanceof CutholError);
      assert.match(err.diagnostic.suggestion, /extension enable --name fxdemo/);
    }
  });
});

test("manifest fx validation pins animatable, placeholders and template safety to G112", () => {
  withFxWorkspace((ws) => {
    const base = { name: "fxv", version: "1.0.0", description: "v" };
    writeExtension(ws, {
      ...base,
      fx: {
        e: {
          params: { s: { type: "number", default: 1 } },
          animatable: ["nope"],
          video_filter: "null",
        },
      },
    });
    assert.throws(() => resolveExtension("fxv", ws), /CUTHOL-G112/);
    writeExtension(ws, {
      ...base,
      fx: {
        e: {
          params: { s: { type: "string", default: "x" } },
          animatable: ["s"],
          video_filter: "null",
        },
      },
    });
    assert.throws(() => resolveExtension("fxv", ws), /CUTHOL-G112/);
    writeExtension(ws, {
      ...base,
      fx: {
        e: {
          params: { s: { type: "number", default: 1 } },
          video_filter: "gblur=sigma={{other}}",
        },
      },
    });
    assert.throws(() => resolveExtension("fxv", ws), /CUTHOL-G112/);
    writeExtension(ws, {
      ...base,
      fx: {
        e: {
          params: { s: { type: "number", default: 1 } },
          video_filter: "null;null",
        },
      },
    });
    assert.throws(() => resolveExtension("fxv", ws), /CUTHOL-G112/);
    writeExtension(ws, {
      ...base,
      fx: {
        e: {
          params: { s: { type: "number", default: 1 } },
          animatable: ["s"],
          video_filter: "gblur=sigma={{s}}",
        },
      },
    });
    assert.deepEqual(resolveExtension("fxv", ws).manifest.fx?.e.animatable, ["s"]);
  });
});

test("spine fx CLI adds, sets, lists and removes (repeatable --param)", () => {
  withFxWorkspace((ws) => {
    writeExtension(ws, FXDEMO_MANIFEST);
    enableExtensionInWorkspace({ workspaceDir: ws, name: "fxdemo" });
    const { clipId } = setupClip(ws);
    const run = (rest: string[], flags: Record<string, string | boolean>): void => {
      const ctx: CliCommandContext = {
        group: "spine",
        action: "fx",
        rest,
        flags,
        workspaceDir: ws,
        formatFlag: "",
      };
      const orig = console.log;
      console.log = () => {};
      try {
        runSpineCommand(ctx);
      } finally {
        console.log = orig;
      }
    };
    run(["add"], { clip: clipId, kind: "ext:fxdemo/soft_blur", param: "sigma=8" });
    assert.deepEqual(listSpineFx({ workspaceDir: ws, clipId }).fx[0].params, { sigma: 8 });
    const savedArgv = process.argv;
    process.argv = [
      "node",
      "cuthol",
      "spine",
      "fx",
      "add",
      "--clip",
      clipId,
      "--kind",
      "ext:fxdemo/duo",
      "--param",
      "a=1",
      "--param",
      "b=2",
    ];
    try {
      run(["add"], { clip: clipId, kind: "ext:fxdemo/duo" });
    } finally {
      process.argv = savedArgv;
    }
    assert.deepEqual(
      listSpineFx({ workspaceDir: ws, clipId }).fx.find((f) => f.kind === "ext:fxdemo/duo")?.params,
      { a: 1, b: 2 }
    );
    run(["set"], { clip: clipId, fx: "fx_01", params: '{"sigma": 9}' });
    assert.deepEqual(listSpineFx({ workspaceDir: ws, clipId }).fx[0].params, { sigma: 9 });
    run(["remove"], { clip: clipId, fx: "fx_01" });
    assert.ok(!listSpineFx({ workspaceDir: ws, clipId }).fx.some((f) => f.id === "fx_01"));
    run(["list"], { clip: clipId });
    assert.throws(() => run(["bogus"], { clip: clipId }), /subcommand/);
    assert.throws(() => run(["add"], { clip: clipId }), /either '--kind/);
  });
});

test("disabled fx emits no filters and its envelopes stay dormant", () => {
  withFxWorkspace((ws) => {
    writeExtension(ws, FXDEMO_MANIFEST);
    enableExtensionInWorkspace({ workspaceDir: ws, name: "fxdemo" });
    const { clipId } = setupClip(ws);
    addSpineFx({ workspaceDir: ws, clipId, kind: "ext:fxdemo/soft_blur", params: { sigma: 4 }, enabled: false });
    setItemEnvelope({
      workspaceDir: ws,
      targetId: clipId,
      parameter: "fx.fx_01.sigma",
      points: [{ offset_ms: 0, value: 2, easing: "linear" }],
    });
    const { sequence, paths } = loadSequence(ws);
    const report = verifySequence(sequence, paths);
    assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
    const chain = spineClipChain(
      compileSequenceRenderPlan(sequence, paths, "draft_480p").filterComplex,
      0
    );
    assert.ok(!chain.includes("gblur"), chain);
  });
});

test("string params are graph-escaped and chain order follows add order", () => {
  withFxWorkspace((ws) => {
    writeExtension(ws, {
      name: "fxs",
      version: "1.0.0",
      description: "s",
      fx: {
        cap: {
          params: { label: { type: "string", default: "a:b,c" } },
          video_filter: "drawtext=text={{label}}",
        },
      },
    });
    enableExtensionInWorkspace({ workspaceDir: ws, name: "fxs" });
    const { clipId } = setupClip(ws);
    addSpineFx({ workspaceDir: ws, clipId, filter: "gblur=sigma=3,unsharp" });
    addSpineFx({ workspaceDir: ws, clipId, kind: "ext:fxs/cap" });
    const { sequence, paths } = loadSequence(ws);
    const chain = spineClipChain(
      compileSequenceRenderPlan(sequence, paths, "draft_480p").filterComplex,
      0
    );
    assert.ok(chain.includes("gblur=sigma=3,unsharp"), chain);
    assert.ok(chain.includes("drawtext=text=a\\:b\\,c"), chain);
    assert.ok(chain.indexOf("gblur=sigma=3") < chain.indexOf("drawtext="), chain);
  });
});
