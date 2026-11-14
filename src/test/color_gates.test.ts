/**
 * Colour verify gates (G130-G139): block amount ranges, unknown/duplicate Looks.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDefaultAudioChain,
  createDefaultPlacement,
  createDefaultTreatments,
  createEmptySequence,
  ParameterEnvelope,
  SpineClip,
  VisualTreatments,
} from "../core/schema.js";
import { CutholDiagnostic } from "../core/diagnostics.js";
import { verifyColorGates } from "../verify/gates_color.js";
import { verifySequence } from "../verify/gates.js";

function spineClip(
  id: string,
  treatments: VisualTreatments,
  envelopes: ParameterEnvelope[] = []
): SpineClip {
  return {
    id,
    asset_handle: "vid_01",
    source_in_ms: 0,
    source_out_ms: 1000,
    timeline_in_ms: 0,
    duration_ms: 1000,
    playback: { rate: 1, preserve_pitch: true, speed_ramp: null },
    placement: createDefaultPlacement(),
    audio_chain: createDefaultAudioChain(),
    treatments,
    transition_out: null,
    envelopes,
  };
}

function seqWith() {
  return createEmptySequence({ projectId: "color-g", title: "color" });
}

test("color gates: valid stage and known look pass", () => {
  const seq = seqWith();
  seq.looks = [{ id: "lk_warm", name: "Warm" }];
  const t = createDefaultTreatments();
  t.color = { exposure: { stops: 0.5 }, look: { id: "lk_warm" } };
  seq.spine.clips.push(spineClip("sp_01", t));
  const diags: CutholDiagnostic[] = [];
  verifyColorGates(seq, diags);
  assert.equal(diags.length, 0);
  const report = verifySequence(seq);
  assert.ok(!report.diagnostics.some((d) => d.code === "CUTHOL-G130" || d.code === "CUTHOL-G131" || d.code === "CUTHOL-G132"));
});

test("color gates: bad amount, unknown look and duplicate look error", () => {
  const seq = seqWith();
  seq.looks = [
    { id: "lk_a", name: "A" },
    { id: "lk_a", name: "A dup" },
  ];
  const t = createDefaultTreatments();
  t.color = { exposure: { stops: 0.5, amount: 2 }, look: { id: "lk_missing" } };
  seq.spine.clips.push(spineClip("sp_01", t));
  const report = verifySequence(seq);
  const codes = report.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("CUTHOL-G130"), `expected G130, got ${codes}`);
  assert.ok(codes.includes("CUTHOL-G131"), `expected G131, got ${codes}`);
  assert.ok(codes.includes("CUTHOL-G132"), `expected G132, got ${codes}`);
  assert.ok(!report.ok);
});

test("color envelopes do not warn as unapplied render fields", () => {
  const seq = seqWith();
  const t = createDefaultTreatments();
  seq.spine.clips.push(
    spineClip("sp_01", t, [
      { parameter: "color.exposure.stops", points: [{ offset_ms: 0, value: 0, easing: "linear" }] },
    ])
  );
  const report = verifySequence(seq);
  assert.ok(
    !report.diagnostics.some((d) => d.code === "CUTHOL-G409" && d.what.includes("color.exposure.stops")),
    JSON.stringify(report.diagnostics.map((d) => d.formatted))
  );
});

test("technical colour gates: LUT file, overlapping Looks, Look on a screen source, HDR without transform, ungraded sibling", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-cgates-"));
  const seq = createEmptySequence({ projectId: "g", title: "g" });
  const probe = { width: 1920, height: 1080, duration_ms: 5000 } as never;
  seq.library.push(
    { handle: "vid_01", kind: "footage", uri: "a.mp4", digest_sha256: "x", probe, analysis_refs: {} },
    { handle: "vid_02", kind: "footage", uri: "b.mp4", digest_sha256: "y", probe: { ...(probe as object), color_transfer: "arib-std-b67" } as never, analysis_refs: {}, color_source: { kind: "screen", input: "none" } }
  );
  const graded = spineClip("sp_01", { ...createDefaultTreatments(), color: { exposure: { stops: 0.3 } } });
  const sibling = spineClip("sp_02", createDefaultTreatments());
  const screen = { ...spineClip("sp_03", { ...createDefaultTreatments(), color: { look: { id: "look_01" } } }), asset_handle: "vid_02" };
  seq.spine.clips.push(graded, sibling, screen);
  seq.looks = [
    { id: "look_01", name: "a", blocks: { saturation: { saturation: 1.1 } }, apply_to: "all" },
    { id: "look_02", name: "b", lut_uri: "looks/missing.cube", apply_to: "all" },
  ];
  const d: CutholDiagnostic[] = [];
  verifyColorGates(seq, d, root);
  const codes = d.map((x) => x.code);
  for (const c of ["CUTHOL-G133", "CUTHOL-G134", "CUTHOL-G135", "CUTHOL-G136"]) assert.ok(codes.includes(c), `${c} in ${codes}`);
  // sp_02 is reached by a Look through apply_to, so it is not "ungraded".
  assert.ok(!codes.includes("CUTHOL-G137"), String(codes));
  seq.looks = [];
  screen.treatments.color = undefined;
  const d2: CutholDiagnostic[] = [];
  verifyColorGates(seq, d2, root);
  assert.deepEqual(
    d2.filter((x) => x.code === "CUTHOL-G137").map((x) => x.subject_id),
    ["sp_02"]
  );
  fs.rmSync(root, { recursive: true, force: true });
});
