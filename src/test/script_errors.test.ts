// Visibility N5: composition page script errors surface in monitor, preview, and
// verify instead of a healthy-looking static frame.
//
// Matrix: a throw before the timeline registers is G430 ERROR (render stops);
// a throw while the timeline runs (tl.call) or an unhandled rejection is G431 WARN;
// a console.error is G432 WARN. Records are content-keyed: fixing the script
// orphans the old record, and verify reads records without opening a browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findBundledGsapMinJs } from "../compositor/bridge_hash.js";
import { previewAndCheckComposition } from "../compositor/composition_preview.js";
import {
  buildScriptErrorRecord,
  classifyScriptErrors,
  dedupeScriptErrors,
  parseCheckRuntimeScriptErrors,
  parsePageErrorLocation,
  scriptErrorsDir,
  scriptRecordToDiagnostic,
} from "../compositor/hf_script_errors.js";
import { CutholDiagnostic, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence, LaneCue, SpatialPlacement } from "../core/schema.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { captureMonitorFrame, captureMonitorSheet } from "../monitor/preview.js";
import { verifySequence } from "../verify/gates.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-vis-script-"));
const GSAP = findBundledGsapMinJs();
assert.ok(GSAP, "bundled gsap.min.js must exist");

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

function compHtml(script: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}#root{position:relative;width:1920px;height:1080px;overflow:hidden}#box{position:absolute;left:100px;top:100px;width:400px;height:300px;background:#1F8AFF}</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="1">
<div id="box"></div>
</div>
<script src="assets/gsap.min.js"></script>
<script>
${script}
</script>
</body></html>
`;
}

const HEALTHY_SCRIPT = `const tl = gsap.timeline({ paused: true });
tl.to("#box", { x: 50, duration: 0.5 }, 0);
tl.set({}, {}, 1);
window.__timelines["main"] = tl;`;

const PRE_SCRIPT = `noSuchFunctionBeforeTimeline();
const tl = gsap.timeline({ paused: true });
tl.set({}, {}, 1);
window.__timelines["main"] = tl;`;

const POST_SCRIPT = `const tl = gsap.timeline({ paused: true });
tl.set({}, {}, 1);
window.__timelines["main"] = tl;
tl.call(() => { throw new Error("post-timeline boom"); }, null, 0.5);`;

const CONSOLE_SCRIPT = `const tl = gsap.timeline({ paused: true });
tl.set({}, {}, 1);
window.__timelines["main"] = tl;
console.error("shader compile failed: vUv missing");`;

const REJECTION_SCRIPT = `const tl = gsap.timeline({ paused: true });
tl.set({}, {}, 1);
window.__timelines["main"] = tl;
Promise.reject(new Error("async asset failed"));`;

function makeProject(name: string, script: string): string {
  const projDir = fs.mkdtempSync(path.join(TEST_ROOT, `${name}-`));
  initWorkspace({ dir: projDir, title: name, aspect: "16:9", fps: 30 });
  const compDir = path.join(projDir, "compositions", "cmp");
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(compDir, "index.html"), compHtml(script), "utf8");
  fs.copyFileSync(GSAP as string, path.join(compDir, "assets", "gsap.min.js"));
  const seqPath = path.join(projDir, "cuthol.sequence.json");
  const seq = JSON.parse(fs.readFileSync(seqPath, "utf8")) as CutholSequence;
  const cue: LaneCue = {
    id: "cue_01",
    kind: "composition",
    anchor: null,
    at_ms: 0,
    duration_ms: 1000,
    z_index: 0,
    placement: placement(),
    composition: {
      composition_dir: "compositions/cmp",
      entry_html: "index.html",
      props: {},
      transparent: true,
      mode: "overlay_alpha",
      scene_host: null,
    },
    envelopes: [],
  } as LaneCue;
  const lane = seq.lanes.find((l) => l.id === "ln_motion") ?? seq.lanes[0];
  lane.cues.push(cue);
  fs.writeFileSync(seqPath, JSON.stringify(seq, null, 2), "utf8");
  return projDir;
}

function codes(diags: CutholDiagnostic[]): string[] {
  return diags.map((d) => d.code);
}

test("pure: check runtime findings parse (page_error, console_error, legacy)", () => {
  const parsed = parseCheckRuntimeScriptErrors({
    ok: false,
    runtime: {
      ok: false,
      findings: [
        { code: "page_error", severity: "error", message: "boom is not defined", sourceFile: "index.html", line: 12 },
        { code: "console_error", severity: "error", message: "shader failed", sourceFile: "assets/fx.js", line: 3 },
        { code: "other_rule", severity: "info", message: "" },
      ],
    },
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].kind, "pageerror");
  assert.equal(parsed[0].file, "index.html");
  assert.equal(parsed[0].line, 12);
  assert.equal(parsed[1].kind, "console");
  const legacy = parseCheckRuntimeScriptErrors({ runtime: { console_error: ["legacy boom"] } });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].kind, "console");
  assert.deepEqual(parseCheckRuntimeScriptErrors({ ok: true }), []);
  assert.deepEqual(parseCheckRuntimeScriptErrors(null), []);
});

test("pure: severity classification (pre-timeline ERROR, rest WARN, clean NONE)", () => {
  assert.equal(
    classifyScriptErrors([{ phase: "load", kind: "pageerror", text: "x is not defined" }], true, false),
    "ERROR"
  );
  assert.equal(
    classifyScriptErrors([{ phase: "load", kind: "rejection", text: "async x" }], true, false),
    "ERROR"
  );
  // Timeline registered: the same throw no longer blocks the render.
  assert.equal(
    classifyScriptErrors([{ phase: "run", kind: "pageerror", text: "boom" }], true, true),
    "WARN"
  );
  // Console output never blocks registration.
  assert.equal(
    classifyScriptErrors([{ phase: "load", kind: "console", text: "shader failed" }], true, false),
    "WARN"
  );
  // data-no-timeline designs expect no timeline.
  assert.equal(
    classifyScriptErrors([{ phase: "load", kind: "pageerror", text: "x" }], false, false),
    "WARN"
  );
  assert.equal(classifyScriptErrors([], true, false), "NONE");
});

test("pure: records dedupe, cap, and map to G430/G431/G432", () => {
  const rec = buildScriptErrorRecord({
    filesHash: "abc",
    entryHtml: "index.html",
    toolTag: "hf:0.9.15",
    source: "probe",
    timelineExpected: true,
    timelineRegistered: false,
    errors: [
      { phase: "load", kind: "pageerror", text: "dup" },
      { phase: "load", kind: "pageerror", text: "dup" },
      { phase: "run", kind: "console", text: "second" },
    ],
  });
  assert.equal(rec.errors.length, 2);
  assert.equal(rec.severity, "ERROR");
  const diag = scriptRecordToDiagnostic("cue_01", rec);
  assert.ok(diag);
  assert.equal(diag?.code, "CUTHOL-G430");
  assert.ok(diag?.what.includes("static unanimated page"));
  const warnRec = buildScriptErrorRecord({
    filesHash: "abc",
    entryHtml: "index.html",
    toolTag: "hf:0.9.15",
    source: "probe",
    timelineExpected: true,
    timelineRegistered: true,
    errors: [{ phase: "run", kind: "pageerror", text: "boom" }],
  });
  assert.equal(scriptRecordToDiagnostic("cue_01", warnRec)?.code, "CUTHOL-G431");
  const consoleRec = buildScriptErrorRecord({
    filesHash: "abc",
    entryHtml: "index.html",
    toolTag: "hf:0.9.15",
    source: "probe",
    timelineExpected: true,
    timelineRegistered: true,
    errors: [{ phase: "load", kind: "console", text: "shader failed" }],
  });
  assert.equal(scriptRecordToDiagnostic("cue_01", consoleRec)?.code, "CUTHOL-G432");
  const cleanRec = buildScriptErrorRecord({
    filesHash: "abc",
    entryHtml: "index.html",
    toolTag: "hf:0.9.15",
    source: "probe",
    timelineExpected: true,
    timelineRegistered: true,
    errors: [],
  });
  assert.equal(scriptRecordToDiagnostic("cue_01", cleanRec), null);
  // Dedupe ignores location (first wins) and caps entries.
  const many = Array.from({ length: 20 }, (_, i) => ({
    phase: "load" as const,
    kind: "pageerror" as const,
    text: `err${i}`,
  }));
  assert.equal(dedupeScriptErrors(many).length, 8);
});

test("pure: page error location parses served URLs", () => {
  const err = new Error("x is not defined");
  err.stack = `ReferenceError: x is not defined
    at foo (http://127.0.0.1:51234/index.html:35:7)
    at http://127.0.0.1:51234/assets/app.js:10:3`;
  assert.deepEqual(parsePageErrorLocation(err), { file: "index.html", line: 35 });
  assert.deepEqual(parsePageErrorLocation(new Error("no-stack-info")), {});
});

test("pure: G430/G431/G432 diagnostic shapes", () => {
  const e = DIAGNOSTICS.COMPOSITION_SCRIPT_FAILED_BEFORE_TIMELINE("cue_01", "x is not defined", "index.html:35");
  assert.equal(e.code, "CUTHOL-G430");
  assert.equal(e.severity, "ERROR");
  assert.equal(e.gate, "G4_STAGE");
  assert.ok(e.formatted.includes("| Suggestion:"));
  const w = DIAGNOSTICS.COMPOSITION_SCRIPT_FAILED_AFTER_TIMELINE("cue_01", "boom", null);
  assert.equal(w.code, "CUTHOL-G431");
  assert.equal(w.severity, "WARN");
  const c = DIAGNOSTICS.COMPOSITION_CONSOLE_ERROR("cue_01", "shader failed", "assets/fx.js");
  assert.equal(c.code, "CUTHOL-G432");
  assert.equal(c.severity, "WARN");
});

test("browser: pre-timeline throw -> monitor frame G430 ERROR + record", () => {
  const projDir = makeProject("pre", PRE_SCRIPT);
  const res = captureMonitorFrame({ workspaceDir: projDir, atMs: 500 });
  assert.equal(res.ok, true);
  assert.ok(codes(res.diagnostics).includes("CUTHOL-G430"), JSON.stringify(res.diagnostics));
  const diag = res.diagnostics.find((d) => d.code === "CUTHOL-G430");
  assert.equal(diag?.severity, "ERROR");
  assert.ok(diag?.what.includes("noSuchFunctionBeforeTimeline"));
  assert.ok(diag?.what.includes("static unanimated page"));
  // A content-keyed record now exists for verify to read.
  const files = fs.readdirSync(scriptErrorsDir(projDir));
  assert.equal(files.length, 1);
  const record = JSON.parse(
    fs.readFileSync(path.join(scriptErrorsDir(projDir), files[0]), "utf8")
  ) as { severity: string; timeline_registered: boolean };
  assert.equal(record.severity, "ERROR");
  assert.equal(record.timeline_registered, false);
});

test("browser: post-timeline throw -> monitor frame G431 WARN", () => {
  const projDir = makeProject("post", POST_SCRIPT);
  const res = captureMonitorFrame({ workspaceDir: projDir, atMs: 500 });
  assert.equal(res.ok, true);
  assert.ok(codes(res.diagnostics).includes("CUTHOL-G431"), JSON.stringify(res.diagnostics));
  assert.ok(!codes(res.diagnostics).includes("CUTHOL-G430"));
  assert.ok((res.diagnostics.find((d) => d.code === "CUTHOL-G431")?.what ?? "").includes("post-timeline boom"));
});

test("browser: console.error and unhandled rejection -> WARN, healthy stays silent", () => {
  const consoleProj = makeProject("console", CONSOLE_SCRIPT);
  const consoleRes = captureMonitorFrame({ workspaceDir: consoleProj, atMs: 500 });
  assert.ok(codes(consoleRes.diagnostics).includes("CUTHOL-G432"), JSON.stringify(consoleRes.diagnostics));
  const rejectionProj = makeProject("rejection", REJECTION_SCRIPT);
  const rejectionRes = captureMonitorFrame({ workspaceDir: rejectionProj, atMs: 500 });
  assert.ok(codes(rejectionRes.diagnostics).includes("CUTHOL-G431"), JSON.stringify(rejectionRes.diagnostics));
  const healthyProj = makeProject("healthy", HEALTHY_SCRIPT);
  const healthyRes = captureMonitorFrame({ workspaceDir: healthyProj, atMs: 500 });
  assert.deepEqual(
    codes(healthyRes.diagnostics).filter((c) => c === "CUTHOL-G430" || c === "CUTHOL-G431" || c === "CUTHOL-G432"),
    []
  );
});

test("browser: verify reports the cached record without measuring (record untouched)", () => {
  const projDir = makeProject("verifycache", PRE_SCRIPT);
  captureMonitorFrame({ workspaceDir: projDir, atMs: 500 });
  const recordFile = path.join(scriptErrorsDir(projDir), fs.readdirSync(scriptErrorsDir(projDir))[0]);
  const before = fs.readFileSync(recordFile, "utf8");
  const { sequence, paths } = loadSequence(projDir);
  const report = verifySequence(sequence, paths);
  assert.equal(report.ok, false);
  assert.ok(codes(report.diagnostics).includes("CUTHOL-G430"));
  // Verify is a pure read: the record bytes are identical afterwards.
  assert.equal(fs.readFileSync(recordFile, "utf8"), before);
});

test("browser: fixing the script orphans the record (verify goes quiet)", () => {
  const projDir = makeProject("fixit", PRE_SCRIPT);
  captureMonitorFrame({ workspaceDir: projDir, atMs: 500 });
  const before = loadSequence(projDir);
  assert.ok(codes(verifySequence(before.sequence, before.paths).diagnostics).includes("CUTHOL-G430"));
  fs.writeFileSync(path.join(projDir, "compositions", "cmp", "index.html"), compHtml(HEALTHY_SCRIPT), "utf8");
  const after = loadSequence(projDir);
  const report = verifySequence(after.sequence, after.paths);
  assert.ok(!codes(report.diagnostics).includes("CUTHOL-G430"), JSON.stringify(report.diagnostics));
});

test("browser: composition preview carries G430 for a pre-timeline throw", () => {
  const projDir = makeProject("preview", PRE_SCRIPT);
  const res = previewAndCheckComposition({ workspaceDir: projDir, cueId: "cue_01" });
  assert.ok(codes(res.diagnostics).includes("CUTHOL-G430"), JSON.stringify(res.diagnostics));
});

test("browser: monitor sheet carries one G430 across cells", () => {
  const projDir = makeProject("sheet", PRE_SCRIPT);
  const res = captureMonitorSheet({ workspaceDir: projDir, cols: 1, rows: 1 });
  assert.equal(res.ok, true);
  assert.deepEqual(
    codes(res.diagnostics).filter((c) => c === "CUTHOL-G430"),
    ["CUTHOL-G430"]
  );
});
