// G431 false alarm: a WebGL shader compiler *warning* (Windows ANGLE/D3D info log
// that Three.js forwards via console.error) must never read as "page script threw".
// Warning-only compiler logs map to G433 INFO; real throws, shader errors, and
// failed links keep G431/G432.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScriptErrorRecord,
  isWarningOnlyCompilerLog,
  parseCheckRuntimeScriptErrors,
  scriptRecordToDiagnostic,
} from "../compositor/hf_script_errors.js";

const WARNING_LOG =
  "THREE.WebGLProgram: Program Info Log: warning X4122: sum of 0.996094 and -2.98545e-017 " +
  "cannot be represented accurately in double precision at index.html:2696";

test("pure: warning-only compiler log is detected generically", () => {
  assert.equal(isWarningOnlyCompilerLog(WARNING_LOG), true);
  assert.equal(isWarningOnlyCompilerLog("WebGLProgram: Program Info Log: warning X3556: something"), true);
  assert.equal(isWarningOnlyCompilerLog("shader compile warning: unused varying"), true);
  // Real problems stay non-warning: errors, failures, exceptions.
  assert.equal(isWarningOnlyCompilerLog("THREE.WebGLProgram: Program Info Log: error X3000: syntax error"), false);
  assert.equal(isWarningOnlyCompilerLog("THREE.WebGLProgram: Program Info Log: ERROR: link failed"), false);
  assert.equal(isWarningOnlyCompilerLog("shader compile failed: vUv missing"), false);
  assert.equal(isWarningOnlyCompilerLog("boom is not defined"), false);
  assert.equal(isWarningOnlyCompilerLog("warning: something odd happened"), false);
});

test("pure: renderer finding with warning-only text maps to console kind, not pageerror", () => {
  const parsed = parseCheckRuntimeScriptErrors({
    runtime: {
      findings: [
        { code: "page_error", severity: "error", message: WARNING_LOG, sourceFile: "index.html", line: 2696 },
      ],
    },
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, "console");
});

test("pure: warning-only console record maps to G433 INFO, real throw stays G431", () => {
  const warnRec = buildScriptErrorRecord({
    filesHash: "abc",
    entryHtml: "index.html",
    toolTag: "hf:0.9.15",
    source: "probe",
    timelineExpected: true,
    timelineRegistered: true,
    errors: [{ phase: "run", kind: "console", text: WARNING_LOG }],
  });
  const warnDiag = scriptRecordToDiagnostic("cue_01", warnRec);
  assert.ok(warnDiag);
  assert.equal(warnDiag?.code, "CUTHOL-G433");
  assert.equal(warnDiag?.severity, "INFO");
  assert.ok(!/page script threw/.test(warnDiag?.what ?? ""));

  const throwRec = buildScriptErrorRecord({
    filesHash: "abc",
    entryHtml: "index.html",
    toolTag: "hf:0.9.15",
    source: "probe",
    timelineExpected: true,
    timelineRegistered: true,
    errors: [{ phase: "run", kind: "pageerror", text: "post-timeline boom" }],
  });
  assert.equal(scriptRecordToDiagnostic("cue_01", throwRec)?.code, "CUTHOL-G431");

  const errorRec = buildScriptErrorRecord({
    filesHash: "abc",
    entryHtml: "index.html",
    toolTag: "hf:0.9.15",
    source: "probe",
    timelineExpected: true,
    timelineRegistered: true,
    errors: [{ phase: "run", kind: "console", text: "THREE.WebGLProgram: Program Info Log: ERROR: link failed" }],
  });
  assert.equal(scriptRecordToDiagnostic("cue_01", errorRec)?.code, "CUTHOL-G432");
});
