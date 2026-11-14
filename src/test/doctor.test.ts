/**
 * `cuthol doctor` checks (`src/test/doctor.test.ts`).
 * Pure checks run on injected probes: missing ffmpeg, old ffmpeg,
 * no browser, missing keys (and the key value never appears in output).
 */

import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkBrowser,
  checkFfmpeg,
  checkHyperframes,
  checkNode,
  checkSkills,
  checkSpeechKeys,
  collectDoctorChecks,
  type DoctorProbes,
} from "../core/doctor.js";

function healthy(): DoctorProbes {
  return {
    nodeVersion: "v22.5.0",
    nodeEnginesRange: ">=22.5.0",
    ffmpegMajor: 8,
    ffmpegToken: "8.1.1",
    ffprobeMajor: 8,
    ffprobeToken: "8.1.1",
    chromiumBrowsers: ["Google Chrome"],
    hyperframesResolved: true,
    hyperframesVersion: "0.9.15",
    hyperframesPinned: "0.9.15",
    gsapPresent: true,
    deepgramKeyPresent: true,
    elevenlabsKeyPresent: true,
    skillsSummary: "claude-code: 1 installed",
  };
}

test("healthy probes: all checks ok", () => {
  for (const check of collectDoctorChecks(healthy())) {
    assert.equal(check.status, "ok", `${check.id}: ${check.found}`);
  }
});

test("node below engines range fails", () => {
  const check = checkNode({ nodeVersion: "v20.1.0", nodeEnginesRange: ">=22.5.0" });
  assert.equal(check.status, "fail");
  assert.match(check.fix, /Node\.js/);
});

test("missing ffmpeg fails", () => {
  const check = checkFfmpeg({ ffmpegMajor: null, ffprobeMajor: null });
  assert.equal(check.status, "fail");
  assert.match(check.found, /not found on PATH/);
});

test("ffmpeg 7.x warns, not fails", () => {
  const check = checkFfmpeg({ ffmpegMajor: 7, ffmpegToken: "7.1", ffprobeMajor: 7, ffprobeToken: "7.1" });
  assert.equal(check.status, "warn");
});

test("no browser fails", () => {
  const check = checkBrowser({ chromiumBrowsers: [] });
  assert.equal(check.status, "fail");
});

test("missing speech keys warn and report presence only", () => {
  const check = checkSpeechKeys({
    deepgramKeyPresent: false,
    elevenlabsKeyPresent: false,
  });
  assert.equal(check.status, "warn");
  assert.match(check.found, /missing/);
});

test("one key present still warns without leaking any value", () => {
  const check = checkSpeechKeys({ deepgramKeyPresent: true, elevenlabsKeyPresent: false });
  assert.equal(check.status, "warn");
  const blob = JSON.stringify(check);
  assert.doesNotMatch(blob, /sk-[A-Za-z0-9]/);
  assert.doesNotMatch(blob, /secret/i);
});

test("key present asserts the value never appears in output", () => {
  const fakeValue = "zz-top-secret-doctor-probe-9f8e7d6c5b4a";
  process.env.DEEPGRAM_API_KEY = fakeValue;
  try {
    const check = checkSpeechKeys({ deepgramKeyPresent: true, elevenlabsKeyPresent: true });
    assert.equal(check.status, "ok");
    assert.doesNotMatch(JSON.stringify(check), new RegExp(fakeValue));
  } finally {
    delete process.env.DEEPGRAM_API_KEY;
  }
});

test("no agent tool detected warns", () => {
  const check = checkSkills({ skillsSummary: null });
  assert.equal(check.status, "warn");
});

test("unresolvable hyperframes fails", () => {
  const check = checkHyperframes({ hyperframesResolved: false, gsapPresent: true });
  assert.equal(check.status, "fail");
});

test("missing gsap fails", () => {
  const check = checkHyperframes({ hyperframesResolved: true, hyperframesVersion: "0.9.15", gsapPresent: false });
  assert.equal(check.status, "fail");
});
