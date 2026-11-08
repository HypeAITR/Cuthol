/**
 * Launch S1/S2: one aggregate INFO for compositions never opened in a browser,
 * and a G503 message without render-progress residue
 * (`src/test/launch_messages.test.ts`). No browser is opened.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeCurrentScriptErrorRecord } from "../compositor/coords_extract.js";
import { buildHyperFramesFailureError } from "../compositor/hf_overlay_tracking.js";
import { CutholSequence, LaneCue, SpatialPlacement } from "../core/schema.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { verifySequence } from "../verify/gates.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/launch_messages");
const ESC = "\u001b";

function placement(): SpatialPlacement {
  return {
    x_pct: 0,
    y_pct: 0,
    scale_x: 1,
    scale_y: 1,
    rotation_deg: 0,
    opacity: 1,
    fit_mode: "cover",
    crop: null,
    mirror_x: false,
    mirror_y: false,
  };
}

function compositionCue(id: string, compDir: string): LaneCue {
  return {
    id,
    kind: "composition",
    anchor: null,
    at_ms: 0,
    duration_ms: 1000,
    z_index: 0,
    placement: placement(),
    composition: {
      composition_dir: compDir,
      entry_html: "index.html",
      props: {},
      transparent: true,
      mode: "overlay_alpha",
      scene_host: null,
    },
    envelopes: [],
  } as LaneCue;
}

function writeMinimalComposition(wsDir: string, name: string): string {
  const compDir = path.join(wsDir, "compositions", name);
  fs.mkdirSync(compDir, { recursive: true });
  fs.writeFileSync(
    path.join(compDir, "index.html"),
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><!-- ${name} --><div id="root"></div></body></html>`,
    "utf8"
  );
  return compDir;
}

test("S1: verify reports one aggregate INFO for never-probed compositions (CUTHOL-G509)", () => {
  const wsDir = path.join(TEST_ROOT, "ws_unprobed");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "unprobed", aspect: "16:9", fps: 30 });
  const probedDir = writeMinimalComposition(wsDir, "probed_ok");
  writeMinimalComposition(wsDir, "unprobed_a");
  writeMinimalComposition(wsDir, "unprobed_b");
  writeMinimalComposition(wsDir, "muted_one");

  const seqPath = path.join(wsDir, "cuthol.sequence.json");
  const seq = JSON.parse(fs.readFileSync(seqPath, "utf8")) as CutholSequence;
  const lane = seq.lanes.find((l) => l.id === "ln_motion") ?? seq.lanes[0];
  lane.cues.push(compositionCue("cue_01", "compositions/unprobed_a"));
  lane.cues.push(compositionCue("cue_02", "compositions/unprobed_b"));
  lane.cues.push(compositionCue("cue_03", "compositions/probed_ok"));
  seq.lanes.push({
    id: "ln_muted",
    kind: "composition",
    z_index: 5,
    muted: true,
    locked: false,
    cues: [compositionCue("cue_04", "compositions/muted_one")],
  });
  fs.writeFileSync(seqPath, JSON.stringify(seq, null, 2), "utf8");

  // One composition was measured before (clean record, no browser needed here).
  writeCurrentScriptErrorRecord(wsDir, {
    absCompDir: probedDir,
    entryHtml: "index.html",
    source: "probe",
    timelineExpected: true,
    timelineRegistered: true,
    errors: [],
  });

  const { sequence, paths } = loadSequence(wsDir);
  const report = verifySequence(sequence, paths);
  const infos = report.diagnostics.filter((d) => d.code === "CUTHOL-G509");
  assert.equal(infos.length, 1, `expected a single aggregate notice, got ${JSON.stringify(infos)}`);
  assert.equal(infos[0].severity, "INFO");
  assert.equal(infos[0].gate, "G4_STAGE");
  assert.match(infos[0].formatted, /^\[CUTHOL-G509\] .* \| Suggestion: .+/);
  assert.ok(infos[0].what.includes("2"), infos[0].what);
  assert.ok(
    infos[0].suggestion.includes("composition preview"),
    infos[0].suggestion
  );
});

test("S1: no notice when there is nothing unprobed", () => {
  const wsDir = path.join(TEST_ROOT, "ws_no_comps");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "no comps", aspect: "16:9", fps: 30 });
  const { sequence, paths } = loadSequence(wsDir);
  const report = verifySequence(sequence, paths);
  assert.ok(!report.diagnostics.some((d) => d.code === "CUTHOL-G509"));
});

const PROGRESS_STDERR = [
  `${ESC}[32m██████░░░░ 25%${ESC}[0m`,
  "[hyperframes] playerReadyTimeoutMs=45000 pollIntervalMs=250 maxConcurrentTimelines=4",
  "██████░░ 22%\rError: renderer crashed at frame 10",
  `25% ${ESC}[1mFailed: Render blocked by 1 correctness warning:`,
  "- sub_timeline_script_failure: A composition script threw before its timeline registered (still unregistered: main) (runtime-error:ReferenceError: oops is not defined [thrown at: hyperframes-composition://body:2:7]). Fix the error; a composition animated by…",
  '@hf-diagnostic {"kind":"SUB_TIMELINE_SCRIPT_FAILURE","subId":"sub"}',
].join("\n");

test("S2: G503 keeps the error sentences and drops progress bars, percent lines, and ANSI", () => {
  const err = buildHyperFramesFailureError("compositions/kart", ["render"], {
    status: 1,
    stdout: "",
    stderr: PROGRESS_STDERR,
  });
  assert.equal(err.diagnostic.code, "CUTHOL-G503");
  const what = err.diagnostic.what;
  assert.ok(what.includes("Failed: Render blocked by 1 correctness warning"), what);
  assert.ok(what.includes("sub_timeline_script_failure"), what);
  assert.ok(what.includes("ReferenceError: oops is not defined"), what);
  assert.ok(what.includes("[thrown at: hyperframes-composition://body:2:7]"), what);
  assert.ok(what.includes('@hf-diagnostic {"kind":"SUB_TIMELINE_SCRIPT_FAILURE"'), what);
  assert.ok(!what.includes("█"), what);
  assert.ok(!what.includes("░"), what);
  assert.ok(!what.includes("%"), what);
  assert.ok(!what.includes(ESC), what);
});

test("S2: pure progress output falls back to the exit code instead of leaking bars", () => {
  const err = buildHyperFramesFailureError("compositions/kart", ["render"], {
    status: 1,
    stdout: "",
    stderr: "██████ 55%\r████████░░ 80%",
  });
  assert.equal(err.diagnostic.code, "CUTHOL-G503");
  assert.ok(err.diagnostic.what.includes("exit=1"), err.diagnostic.what);
  assert.ok(!err.diagnostic.what.includes("█"), err.diagnostic.what);
});

test("S2 unit: progress-line cleaner strips ANSI, bars, and leading percents", async () => {
  const mod = (await import("../compositor/hf_overlay_tracking.js")) as Record<string, unknown>;
  const strip = mod.stripHyperFramesProgressLine as ((line: string) => string | null) | undefined;
  assert.equal(typeof strip, "function", "stripHyperFramesProgressLine must be exported");
  const clean = strip as (line: string) => string | null;
  assert.equal(clean(`${ESC}[31mError: boom${ESC}[0m`), "Error: boom");
  assert.equal(clean("██████░░░░ 25%"), null);
  assert.equal(clean("25% Failed: Render blocked"), "Failed: Render blocked");
  assert.equal(clean("████ 40%\rError: kept"), "Error: kept");
  assert.equal(clean("plain sentence stays"), "plain sentence stays");
});
