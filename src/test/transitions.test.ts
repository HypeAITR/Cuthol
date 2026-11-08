/**
 * — extension spine transitions (`ext:<extension>/<name>`).
 *
 * Fixture extension `trdemo` (test-only, not a shipped example):
 * - `itme`: push — incoming slides in from the right while outgoing slides out left.
 * - `olcekli_giris`: scaled entry — incoming scales 0.8→1 and fades in over the held frame.
 * - `solma`: fade-like fixture with `hold_outgoing: false` (transparent tail, no tpad).
 * - `yonlu`: param fixture (string enum + ranged number).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceAudioPlan } from "../compositor/compiler.js";
import type { VideoGraphCompileContext } from "../compositor/compiler.js";
import {
  applyIncomingTransitionPosition,
  applyOutgoingTransitionPosition,
  buildIncomingTransitionFilters,
  buildOutgoingTransitionFilters,
  incomingTransitionScaleFactor,
  transitionHoldTailMs,
} from "../compositor/compile_spine_transition.js";
import { compileCubicBezierEasedU } from "../core/easing.js";
import type { CutholSequence, TransitionSpec } from "../core/schema.js";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { resolveTransitionParams } from "../extensions/ext_transitions.js";
import { disableExtensionInWorkspace, enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { resolveExtension, showExtension } from "../extensions/ext_registry.js";
import { buildCliArgv, findActionSpec, validateActionArgs } from "../mcp/catalog.js";
import { appendSpineClip, setSpineTransition } from "../sequence/spine.js";
import { verifySequence } from "../verify/gates.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const PROOF_DIR = path.resolve(process.cwd(), "test-workspace", "transitions_proof");

function cli(args: string[]): { ok: boolean; env: any; raw: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const raw = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  let env: any = null;
  try {
    env = JSON.parse(String(proc.stdout ?? ""));
  } catch {
    try {
      env = JSON.parse(String(proc.stderr ?? "")); // error envelopes go to stderr
    } catch {
      // keep raw for the assertion message
    }
  }
  return { ok: Boolean(env?.ok), env, raw: raw.slice(0, 4000) };
}

function makeSolidMp4(dir: string, name: string, color: string, sec: number): string {
  const out = path.join(dir, name);
  const r = spawnSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=640x360:r=30:d=${sec}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:d=${sec}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out,
  ]);
  assert.equal(r.status, 0, `ffmpeg ${name}: ${r.stderr?.toString() ?? ""}`);
  return out;
}

const TRDEMO_TRANSITIONS: Record<string, unknown> = {
  itme: {
    description: "push: incoming slides in from the right, outgoing slides out left",
    incoming_x: "if(lt(t,{{t1}}),{{W}}-{{W}}*{{p}},{{x}})",
    outgoing_x: "if(lt(t,{{t1}}),{{x}}-{{W}}*{{p}},{{x}}-{{W}})",
  },
  olcekli_giris: {
    description: "scaled entry: incoming scales 0.8->1 and fades in over the held frame",
    incoming_scale: "0.8+0.2*{{p}}",
    incoming_filter: "fade=t=in:st=0:d={{dur}}:alpha=1",
  },
  solma: {
    description: "fade-like: outgoing is not held under the next clip",
    hold_outgoing: false,
  },
  yonlu: {
    description: "param fixture",
    params: {
      yon: { type: "string", enum: ["sol", "sag"], default: "sol" },
      hiz: { type: "number", default: 1, min: 0.5, max: 4 },
    },
    incoming_x: "if(lt(t,{{t1}}),{{x}},{{x}})",
  },
};

function writeExtension(wsDir: string, name: string, manifest: Record<string, unknown>): void {
  const dir = path.join(wsDir, ".cuthol", "extensions", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cuthol-extension.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function writeTrDemo(wsDir: string, transitions: Record<string, unknown> = TRDEMO_TRANSITIONS): void {
  writeExtension(wsDir, "trdemo", {
    name: "trdemo",
    version: "1.0.0",
    description: "test fixture transitions (not a shipped example).",
    transitions,
  });
}

function freshWorkspace(): { wsDir: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-transitions-"));
  const wsDir = path.join(tmp, "proj");
  initWorkspace({ dir: wsDir, title: "transitions-", aspect: "16:9", fps: 30 });
  return { wsDir, tmp };
}

/** Two 2 s clips (sp_01 red, sp_02 blue) with `trdemo` enabled. Caller owns cleanup of `tmp`. */
function setupTwoClipProject(): { wsDir: string; tmp: string } {
  const { wsDir, tmp } = freshWorkspace();
  writeTrDemo(wsDir);
  enableExtensionInWorkspace({ workspaceDir: wsDir, name: "trdemo" });
  const red = makeSolidMp4(wsDir, "red.mp4", "red", 3);
  const blue = makeSolidMp4(wsDir, "blue.mp4", "blue", 3);
  const ing = cli(["library", "ingest", red, blue, "--dir", wsDir]);
  assert.ok(ing.ok, ing.raw);
  const { sequence } = loadSequence(wsDir);
  const handleOf = (name: string): string => {
    const item = sequence.library.find((l) => l.uri.endsWith(name));
    assert.ok(item, `ingested ${name}`);
    return item.handle;
  };
  appendSpineClip({ workspaceDir: wsDir, assetHandle: handleOf("red.mp4"), sourceInMs: 0, sourceOutMs: 2000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: handleOf("blue.mp4"), sourceInMs: 0, sourceOutMs: 2000 });
  return { wsDir, tmp };
}

function fakeCtx(seq: CutholSequence, wsDir: string): VideoGraphCompileContext {
  const { paths } = loadSequence(wsDir);
  return { seq, paths, renderWidth: 1920, renderHeight: 1080 } as unknown as VideoGraphCompileContext;
}

function setTransition(wsDir: string, transition: TransitionSpec): CutholSequence {
  setSpineTransition({ workspaceDir: wsDir, clipId: "sp_01", transition });
  return loadSequence(wsDir).sequence;
}

test("builtin transition output is byte-identical to the earlier output (all six kinds)", () => {
  const { wsDir, tmp } = setupTwoClipProject();
  try {
    const dur = 400;
    const kinds = ["dissolve", "fade", "wipe_left", "wipe_right", "slide_up", "zoom_in"] as const;
    for (const kind of kinds) {
      const seq = setTransition(wsDir, { kind, duration_ms: dur, easing: "ease_in_out" });
      const ctx = fakeCtx(seq, wsDir);
      const [sp01, sp02] = seq.spine.clips;
      const out = buildOutgoingTransitionFilters(ctx, { i: 0, clip: sp01, hasNextClip: true, outTrans: sp01.transition_out });
      const inc = buildIncomingTransitionFilters(ctx, { clip: sp02, incomingTransition: sp01.transition_out });
      const inPos = applyIncomingTransitionPosition(ctx, { clip: sp02, incomingTransition: sp01.transition_out, xExpr: "0", yExpr: "0" });
      const outPos = applyOutgoingTransitionPosition(ctx, { clip: sp01, hasNextClip: true, outTrans: sp01.transition_out, xExpr: "0", yExpr: "0" });
      const scale = incomingTransitionScaleFactor(sp01.transition_out);
      const hold = transitionHoldTailMs(sp01, true);
      if (kind === "dissolve") {
        assert.deepEqual(out, ["tpad=stop_mode=clone:stop_duration=0.400"]);
        assert.deepEqual(inc, ["fade=t=in:st=0:d=0.400:alpha=1"]);
        assert.deepEqual([inPos.xExpr, inPos.yExpr], ["0", "0"]);
        assert.deepEqual([outPos.xExpr, outPos.yExpr], ["0", "0"]);
        assert.equal(scale, null);
        assert.equal(hold, 400);
      } else if (kind === "fade") {
        assert.deepEqual(out, ["fade=t=out:st=1.600:d=0.400:alpha=1"]);
        assert.deepEqual(inc, ["fade=t=in:st=0:d=0.400:alpha=1"]);
        assert.equal(hold, 0);
        assert.equal(scale, null);
      } else if (kind === "wipe_left") {
        assert.deepEqual(out, ["tpad=stop_mode=clone:stop_duration=0.400"]);
        assert.deepEqual(inc, []);
        assert.equal(inPos.xExpr, "if(lt(t,2.4),1920-1920*(t-2)/0.4,0)");
        assert.equal(inPos.yExpr, "0");
      } else if (kind === "wipe_right") {
        assert.equal(inPos.xExpr, "if(lt(t,2.4),-1920+1920*(t-2)/0.4,0)");
        assert.deepEqual(inc, []);
      } else if (kind === "slide_up") {
        assert.equal(inPos.yExpr, "if(lt(t,2.4),1080-1080*(t-2)/0.4,0)");
        assert.equal(inPos.xExpr, "0");
        assert.deepEqual(inc, []);
      } else {
        assert.deepEqual(out, ["tpad=stop_mode=clone:stop_duration=0.400", "fade=t=out:st=2.000:d=0.400:alpha=1"]);
        assert.deepEqual(inc, ["fade=t=in:st=0:d=0.400:alpha=1"]);
        assert.equal(scale, "if(lt(t,0.400),0.88+0.12*(t/0.400),1)");
        assert.equal(hold, 400);
      }
    }
    // Dissolve over a non-covering next clip (tpad + fade out).
    commitSequenceMutation(wsDir, "test dim sp_02", (seq) => {
      seq.spine.clips[1].placement.opacity = 0.5;
    });
    const seq = setTransition(wsDir, { kind: "dissolve", duration_ms: dur, easing: "ease_in_out" });
    const ctx = fakeCtx(seq, wsDir);
    assert.deepEqual(
      buildOutgoingTransitionFilters(ctx, { i: 0, clip: seq.spine.clips[0], hasNextClip: true, outTrans: seq.spine.clips[0].transition_out }),
      ["tpad=stop_mode=clone:stop_duration=0.400", "fade=t=out:st=2.000:d=0.400:alpha=1"]
    );
    // Any kind on the last clip fades out. 
    assert.deepEqual(
      buildOutgoingTransitionFilters(ctx, { i: 1, clip: seq.spine.clips[1], hasNextClip: false, outTrans: { kind: "dissolve", duration_ms: dur, easing: "ease_in_out" } }),
      ["fade=t=out:st=1.600:d=0.400:alpha=1"]
    );
    assert.equal(transitionHoldTailMs(seq.spine.clips[1], false), 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("push moves both sides: incoming from the right, outgoing to the left", () => {
  const { wsDir, tmp } = setupTwoClipProject();
  try {
    const seq = setTransition(wsDir, { kind: "ext:trdemo/itme", duration_ms: 1000, easing: "linear" });
    const ctx = fakeCtx(seq, wsDir);
    const [sp01, sp02] = seq.spine.clips;
    assert.deepEqual(
      buildOutgoingTransitionFilters(ctx, { i: 0, clip: sp01, hasNextClip: true, outTrans: sp01.transition_out }),
      ["tpad=stop_mode=clone:stop_duration=1.000"]
    );
    assert.deepEqual(buildIncomingTransitionFilters(ctx, { clip: sp02, incomingTransition: sp01.transition_out }), []);
    const inPos = applyIncomingTransitionPosition(ctx, { clip: sp02, incomingTransition: sp01.transition_out, xExpr: "0", yExpr: "0" });
    assert.equal(inPos.xExpr, "if(lt(t,3),1920-1920*(min(max(((t-2)/1),0),1)),0)");
    assert.equal(inPos.yExpr, "0");
    const outPos = applyOutgoingTransitionPosition(ctx, { clip: sp01, hasNextClip: true, outTrans: sp01.transition_out, xExpr: "0", yExpr: "0" });
    assert.equal(outPos.xExpr, "if(lt(t,3),0-1920*(min(max(((t-2)/1),0),1)),0-1920)");
    assert.equal(outPos.yExpr, "0");
    assert.equal(transitionHoldTailMs(sp01, true), 1000);
    assert.equal(incomingTransitionScaleFactor(sp01.transition_out), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("easing shapes extension progress; cubic_bezier rides the shared solver", () => {
  const { wsDir, tmp } = setupTwoClipProject();
  try {
    const seq = setTransition(wsDir, { kind: "ext:trdemo/itme", duration_ms: 1000, easing: "ease_in" });
    const ctx = fakeCtx(seq, wsDir);
    const inPos = applyIncomingTransitionPosition(ctx, {
      clip: seq.spine.clips[1],
      incomingTransition: seq.spine.clips[0].transition_out,
      xExpr: "0",
      yExpr: "0",
    });
    assert.equal(inPos.xExpr, "if(lt(t,3),1920-1920*(pow(min(max(((t-2)/1),0),1),2)),0)");
    // cubic_bezier: progress carries the shared cubic solver expression.
    const bezier: TransitionSpec = { kind: "ext:trdemo/itme", duration_ms: 1000, easing: "cubic_bezier", bezier: [0.25, 0.1, 0.25, 1] };
    const p = compileCubicBezierEasedU([0.25, 0.1, 0.25, 1], "min(max(((t-2)/1),0),1)");
    const bezierPos = applyIncomingTransitionPosition(ctx, {
      clip: seq.spine.clips[1],
      incomingTransition: bezier,
      xExpr: "0",
      yExpr: "0",
    });
    assert.equal(bezierPos.xExpr, `if(lt(t,3),1920-1920*${p},0)`);
    // ...and verify accepts it (no G122, no G120).
    commitSequenceMutation(wsDir, "test plant bezier", (s) => {
      s.spine.clips[0].transition_out = bezier;
    });
    const planted = loadSequence(wsDir).sequence;
    const report = verifySequence(planted, loadSequence(wsDir).paths);
    assert.ok(!report.diagnostics.some((d) => d.code === "CUTHOL-G122" || d.code === "CUTHOL-G120"), JSON.stringify(report.diagnostics));
    // Invalid bezier on a transition is G120 (compile throws, verify reports).
    const bad: TransitionSpec = { kind: "ext:trdemo/itme", duration_ms: 1000, easing: "cubic_bezier" };
    assert.throws(
      () => applyIncomingTransitionPosition(ctx, { clip: seq.spine.clips[1], incomingTransition: bad, xExpr: "0", yExpr: "0" }),
      /CUTHOL-G120/
    );
    commitSequenceMutation(wsDir, "test plant bad bezier", (s) => {
      s.spine.clips[0].transition_out = bad;
    });
    const badReport = verifySequence(loadSequence(wsDir).sequence, loadSequence(wsDir).paths);
    assert.ok(badReport.diagnostics.some((d) => d.code === "CUTHOL-G120"), JSON.stringify(badReport.diagnostics));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scaled entry compiles to a guarded scale+pad and a fade", () => {
  const { wsDir, tmp } = setupTwoClipProject();
  try {
    const seq = setTransition(wsDir, { kind: "ext:trdemo/olcekli_giris", duration_ms: 400, easing: "linear" });
    const ctx = fakeCtx(seq, wsDir);
    const [sp01, sp02] = seq.spine.clips;
    const guarded = "if(lt(t,0.400),(0.8+0.2*(min(max((t/0.4),0),1))),1)";
    assert.deepEqual(buildIncomingTransitionFilters(ctx, { clip: sp02, incomingTransition: sp01.transition_out }), [
      `scale=w='iw*(${guarded})':h='ih*(${guarded})':eval=frame`,
      "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black@0",
      "fade=t=in:st=0:d=0.400:alpha=1",
    ]);
    assert.deepEqual(
      buildOutgoingTransitionFilters(ctx, { i: 0, clip: sp01, hasNextClip: true, outTrans: sp01.transition_out }),
      ["tpad=stop_mode=clone:stop_duration=0.400"]
    );
    const inPos = applyIncomingTransitionPosition(ctx, { clip: sp02, incomingTransition: sp01.transition_out, xExpr: "0", yExpr: "0" });
    assert.deepEqual([inPos.xExpr, inPos.yExpr], ["0", "0"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("hold_outgoing false renders a transparent tail without tpad", () => {
  const { wsDir, tmp } = setupTwoClipProject();
  try {
    const seq = setTransition(wsDir, { kind: "ext:trdemo/solma", duration_ms: 400, easing: "linear" });
    const ctx = fakeCtx(seq, wsDir);
    assert.deepEqual(
      buildOutgoingTransitionFilters(ctx, { i: 0, clip: seq.spine.clips[0], hasNextClip: true, outTrans: seq.spine.clips[0].transition_out }),
      ["fade=t=out:st=1.600:d=0.400:alpha=1"]
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("manifest transitions section: new keys parse, bad ones are G112", () => {
  const { wsDir, tmp } = freshWorkspace();
  try {
    writeTrDemo(wsDir);
    const ext = resolveExtension("trdemo", wsDir);
    assert.ok(ext.manifest.transitions?.itme);
    assert.equal(ext.manifest.transitions?.olcekli_giris.incoming_scale, "0.8+0.2*{{p}}");
    assert.equal(ext.manifest.transitions?.solma.hold_outgoing, false);
    // Unknown field.
    writeTrDemo(wsDir, { x: { script: "evil.js" } });
    assert.throws(() => resolveExtension("trdemo", wsDir), /CUTHOL-G112/);
    // Wrong type.
    writeTrDemo(wsDir, { x: { hold_outgoing: "yes" } });
    assert.throws(() => resolveExtension("trdemo", wsDir), /CUTHOL-G112/);
    // Unknown placeholder.
    writeTrDemo(wsDir, { x: { incoming_x: "{{bogus}}" } });
    assert.throws(() => resolveExtension("trdemo", wsDir), /CUTHOL-G112/);
    // Overlay-only var in a chain template.
    writeTrDemo(wsDir, { x: { incoming_filter: "null,{{W}}" } });
    assert.throws(() => resolveExtension("trdemo", wsDir), /CUTHOL-G112/);
    // Minimal entries still parse (minimal shape).
    writeTrDemo(wsDir, { tiny: { description: "ok" } });
    assert.ok(resolveExtension("trdemo", wsDir).manifest.transitions?.tiny);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("params fill defaults and coerce; violations are G123", () => {
  const { wsDir, tmp } = setupTwoClipProject();
  try {
    const seq = setTransition(wsDir, {
      kind: "ext:trdemo/yonlu",
      duration_ms: 400,
      easing: "linear",
      params: { yon: "sag", hiz: "2" },
    });
    assert.deepEqual(seq.spine.clips[0].transition_out?.params, { yon: "sag", hiz: 2 });
    const seq2 = setTransition(wsDir, { kind: "ext:trdemo/yonlu", duration_ms: 400, easing: "linear" });
    assert.deepEqual(seq2.spine.clips[0].transition_out?.params, { yon: "sol", hiz: 1 });
    const badCases: Array<Record<string, string | number>> = [{ bilinmeyen: 1 }, { hiz: 9 }, { yon: "yukari" }, { hiz: "hizli" }];
    for (const bad of badCases) {
      assert.throws(
        () => setSpineTransition({ workspaceDir: wsDir, clipId: "sp_01", transition: { kind: "ext:trdemo/yonlu", duration_ms: 400, easing: "linear", params: bad } }),
        /CUTHOL-G123/,
        JSON.stringify(bad)
      );
    }
    // No silent passthrough for undeclared params.
    assert.throws(
      () => setSpineTransition({ workspaceDir: wsDir, clipId: "sp_01", transition: { kind: "ext:trdemo/itme", duration_ms: 400, easing: "linear", params: { yon: "sol" } } }),
      /CUTHOL-G123/
    );
    // Builtins take no params.
    assert.throws(
      () => setSpineTransition({ workspaceDir: wsDir, clipId: "sp_01", transition: { kind: "dissolve", duration_ms: 400, easing: "linear", params: { yon: "sol" } } }),
      /CUTHOL-G123/
    );
    // Failed edits roll back (previous transition untouched).
    assert.equal(loadSequence(wsDir).sequence.spine.clips[0].transition_out?.kind, "ext:trdemo/yonlu");
    // Direct unit checks: required, boolean coercion, non-scalar.
    assert.throws(
      () => resolveTransitionParams({ params: { a: { type: "string", required: true } } }, {}, "ext:t/x", "sp_01"),
      /CUTHOL-G123/
    );
    assert.deepEqual(
      resolveTransitionParams({ params: { b: { type: "boolean" } } }, { b: "false" }, "ext:t/x", "sp_01"),
      { b: false }
    );
    assert.throws(
      () => resolveTransitionParams({ params: { s: { type: "string" } } }, { s: { o: 1 } as unknown as string }, "ext:t/x", "sp_01"),
      /CUTHOL-G123/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("unknown, malformed or disabled extension transitions are G122 (verify + compile)", () => {
  const { wsDir, tmp } = setupTwoClipProject();
  try {
    assert.throws(
      () => setSpineTransition({ workspaceDir: wsDir, clipId: "sp_01", transition: { kind: "ext:nope/none", duration_ms: 400, easing: "linear" } }),
      /CUTHOL-G122/
    );
    assert.equal(loadSequence(wsDir).sequence.spine.clips[0].transition_out, null);
    assert.throws(
      () => setSpineTransition({ workspaceDir: wsDir, clipId: "sp_01", transition: { kind: "ext:Bad" as TransitionSpec["kind"], duration_ms: 400, easing: "linear" } }),
      /CUTHOL-G122/
    );
    const seq = loadSequence(wsDir).sequence;
    const ctx = fakeCtx(seq, wsDir);
    const bad: TransitionSpec = { kind: "ext:nope/none", duration_ms: 400, easing: "linear" };
    assert.throws(() => buildIncomingTransitionFilters(ctx, { clip: seq.spine.clips[1], incomingTransition: bad }), /CUTHOL-G122/);
    assert.throws(
      () => buildOutgoingTransitionFilters(ctx, { i: 0, clip: seq.spine.clips[0], hasNextClip: true, outTrans: bad }),
      /CUTHOL-G122/
    );
    assert.throws(
      () => applyIncomingTransitionPosition(ctx, { clip: seq.spine.clips[1], incomingTransition: bad, xExpr: "0", yExpr: "0" }),
      /CUTHOL-G122/
    );
    assert.throws(
      () => applyOutgoingTransitionPosition(ctx, { clip: seq.spine.clips[0], hasNextClip: true, outTrans: bad, xExpr: "0", yExpr: "0" }),
      /CUTHOL-G122/
    );
    // Disabling an extension whose transitions are in use is refused (G122): replace them first.
    setTransition(wsDir, { kind: "ext:trdemo/itme", duration_ms: 1000, easing: "linear" });
    assert.throws(() => disableExtensionInWorkspace({ workspaceDir: wsDir, name: "trdemo" }), /CUTHOL-G122/);
    // Missing extension on disk: render refuses to start with G122 and writes no output.
    fs.rmSync(path.join(wsDir, ".cuthol", "extensions", "trdemo"), { recursive: true, force: true });
    const outRel = path.join("output", "blocked.mp4");
    const render = cli(["render", "--preset", "draft_480p", "--encoder", "libx264", "--out", outRel, "--dir", wsDir]);
    assert.equal(render.ok, false, render.raw);
    assert.equal(render.env?.diagnostic?.code, "CUTHOL-G122", render.raw);
    assert.equal(fs.existsSync(path.join(wsDir, outRel)), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("changed extension content warns G413 on transitions that use it", () => {
  const { wsDir, tmp } = setupTwoClipProject();
  try {
    setTransition(wsDir, { kind: "ext:trdemo/itme", duration_ms: 1000, easing: "linear" });
    const clean = loadSequence(wsDir);
    assert.ok(!verifySequence(clean.sequence, clean.paths).diagnostics.some((d) => d.code === "CUTHOL-G413"));
    fs.writeFileSync(path.join(wsDir, ".cuthol", "extensions", "trdemo", "extra.txt"), "drift");
    const drifted = loadSequence(wsDir);
    const report = verifySequence(drifted.sequence, drifted.paths);
    const g413 = report.diagnostics.filter((d) => d.code === "CUTHOL-G413");
    assert.equal(g413.length, 1, JSON.stringify(report.diagnostics));
    assert.equal(g413[0].severity, "WARN");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("G303 duration bound applies to extension transitions", () => {
  const { wsDir, tmp } = setupTwoClipProject();
  try {
    assert.throws(
      () => setSpineTransition({ workspaceDir: wsDir, clipId: "sp_01", transition: { kind: "ext:trdemo/itme", duration_ms: 1500, easing: "linear" } }),
      /CUTHOL-G303/
    );
    setTransition(wsDir, { kind: "ext:trdemo/itme", duration_ms: 1000, easing: "linear" });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("extension transitions reuse the builtin audio path (identical audio plan)", () => {
  const { wsDir, tmp } = setupTwoClipProject();
  try {
    setTransition(wsDir, { kind: "dissolve", duration_ms: 400, easing: "linear" });
    const a = loadSequence(wsDir);
    const planA = compileSequenceAudioPlan(a.sequence, a.paths);
    setTransition(wsDir, { kind: "ext:trdemo/itme", duration_ms: 400, easing: "linear" });
    const b = loadSequence(wsDir);
    const planB = compileSequenceAudioPlan(b.sequence, b.paths);
    assert.equal(planB.filterComplex, planA.filterComplex);
    assert.deepEqual(planB.inputArgs, planA.inputArgs);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI sets ext transitions with --param; MCP catalog exposes kind + params; show lists transitions", () => {
  const { wsDir, tmp } = setupTwoClipProject();
  try {
    const r = cli(["spine", "transition", "--clip", "sp_01", "--kind", "ext:trdemo/yonlu", "--duration", "400ms", "--param", "yon=sag", "--dir", wsDir]);
    assert.ok(r.ok, r.raw);
    assert.deepEqual(loadSequence(wsDir).sequence.spine.clips[0].transition_out?.params, { yon: "sag", hiz: 1 });
    const bad = cli(["spine", "transition", "--clip", "sp_01", "--kind", "dissolve", "--param", "a=b", "--dir", wsDir]);
    assert.equal(bad.ok, false, bad.raw);
    assert.equal(bad.env?.diagnostic?.code, "CUTHOL-G123", bad.raw);
    const malformed = cli(["spine", "transition", "--clip", "sp_01", "--kind", "ext:trdemo/yonlu", "--param", "yon", "--dir", wsDir]);
    assert.equal(malformed.ok, false, malformed.raw);
    const spec = findActionSpec("spine", "transition");
    assert.ok(spec);
    const kindParam = spec.params.find((p) => p.name === "kind");
    assert.ok(kindParam);
    assert.equal(kindParam.enum, undefined);
    assert.ok(kindParam.description.includes("ext:<extension>/<name>"));
    const paramsParam = spec.params.find((p) => p.name === "params");
    assert.ok(paramsParam);
    assert.equal(paramsParam.type, "object");
    const v = validateActionArgs(spec, { clip: "sp_01", kind: "ext:trdemo/itme", params: { yon: "sol" } });
    assert.deepEqual(v.issues, []);
    const argv = buildCliArgv(spec, v.values, wsDir);
    assert.ok(argv.includes('--params={"yon":"sol"}'), JSON.stringify(argv));
    const shown = showExtension({ name: "trdemo", workspaceDir: wsDir });
    assert.deepEqual(Object.keys(shown.manifest.transitions ?? {}).sort(), ["itme", "olcekli_giris", "solma", "yonlu"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function frameSize(mp4: string): { w: number; h: number } {
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", mp4], { encoding: "utf8" });
  const [w, h] = String(probe.stdout).trim().split(",").map(Number);
  assert.ok(w > 0 && h > 0, `no dimensions for ${mp4}`);
  return { w, h };
}

function decodeRgbFrame(mp4: string, atSec: number, w: number, h: number): Buffer {
  const dec = spawnSync("ffmpeg", ["-v", "error", "-ss", String(atSec), "-i", mp4, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 128 * 1024 * 1024 });
  assert.equal(dec.status, 0, `decode ${mp4}@${atSec}s`);
  const b = dec.stdout as Buffer;
  assert.equal(b.length, w * h * 3, `short decode ${mp4}@${atSec}s`);
  return b;
}

/** First blue-dominant column on the middle row (the push boundary). */
function pushBoundaryX(frame: Buffer, w: number, h: number): number {
  const y = Math.floor(h / 2);
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    if (frame[i + 2] - frame[i] > 40) return x;
  }
  return w;
}

test("push renders side-by-side at 50% with the boundary near stage center", () => {
  const { wsDir, tmp } = setupTwoClipProject();
  try {
    setTransition(wsDir, { kind: "ext:trdemo/itme", duration_ms: 1000, easing: "linear" });
    const render = cli(["render", "--preset", "draft_480p", "--encoder", "libx264", "--out", "output/push.mp4", "--dir", wsDir]);
    assert.ok(render.ok, render.raw);
    assert.equal(render.env?.blank_scan?.blank_frames_count, 0, render.raw);
    assert.equal(render.env?.blank_scan?.total_frames, 120, render.raw);
    const outMp4 = path.join(wsDir, "output", "push.mp4");
    const { w, h } = frameSize(outMp4);
    fs.mkdirSync(PROOF_DIR, { recursive: true });
    for (const [frac, at] of [[0.25, 2.25], [0.5, 2.5], [0.75, 2.75]] as const) {
      const png = path.join(PROOF_DIR, `push_${frac * 100}.png`);
      const ex = spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", String(at), "-i", outMp4, "-frames:v", "1", png]);
      assert.equal(ex.status, 0, `extract ${png}`);
      const frame = decodeRgbFrame(outMp4, at, w, h);
      const x = pushBoundaryX(frame, w, h);
      const expected = frac === 0.5 ? 0.5 * w : frac === 0.25 ? 0.75 * w : 0.25 * w;
      const tol = frac === 0.5 ? 0.05 * w : 0.1 * w;
      assert.ok(Math.abs(x - expected) <= tol, `at=${at}s boundary x=${x}, expected ~${Math.round(expected)} (w=${w})`);
    }
    const mid = decodeRgbFrame(outMp4, 2.5, w, h);
    const y = Math.floor(h / 2);
    const li = (y * w + Math.floor(w * 0.05)) * 3;
    const ri = (y * w + Math.floor(w * 0.95)) * 3;
    assert.ok(mid[li] - mid[li + 2] > 80, "left edge shows the outgoing red clip");
    assert.ok(mid[ri + 2] - mid[ri] > 80, "right edge shows the incoming blue clip");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


