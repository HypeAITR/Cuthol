/**
 * Launch L2: ffmpeg/ffprobe major-version warning (`src/test/ffmpeg_version.test.ts`).
 * No real ffmpeg is touched for the warning path: old versions are injected via
 * environment override lines, parsed by the same parser as real `-version` output.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  clearFfmpegVersionCache,
  FFMPEG_TESTED_MAJOR,
  ffmpegVersionWarningDiagnostics,
  getFfmpegVersionInfo,
  parseFfmpegMajorVersion,
} from "../core/ffmpeg_version.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { verifySequence } from "../verify/gates.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/ffmpeg_version");

function setFakeVersions(ffmpegLine: string | undefined, ffprobeLine: string | undefined): void {
  if (ffmpegLine === undefined) delete process.env.CUTHOL_FAKE_FFMPEG_VERSION_LINE;
  else process.env.CUTHOL_FAKE_FFMPEG_VERSION_LINE = ffmpegLine;
  if (ffprobeLine === undefined) delete process.env.CUTHOL_FAKE_FFPROBE_VERSION_LINE;
  else process.env.CUTHOL_FAKE_FFPROBE_VERSION_LINE = ffprobeLine;
  clearFfmpegVersionCache();
}

function clearFakeVersions(): void {
  delete process.env.CUTHOL_FAKE_FFMPEG_VERSION_LINE;
  delete process.env.CUTHOL_FAKE_FFPROBE_VERSION_LINE;
  clearFfmpegVersionCache();
}

test("version parser reads realistic -version first lines", () => {
  const cases: Array<{ line: string; major: number | null; token?: string }> = [
    {
      line: "ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers",
      major: 8,
      token: "8.1.1-full_build-www.gyan.dev",
    },
    {
      line: "ffmpeg version 6.1.1-full_build-www.gyan.dev Copyright (c) 2000-2023 the FFmpeg developers",
      major: 6,
      token: "6.1.1-full_build-www.gyan.dev",
    },
    {
      line: "ffmpeg version n8.1 Copyright (c) 2000-2026 the FFmpeg developers",
      major: 8,
      token: "8.1",
    },
    {
      line: "ffmpeg version N-12345-gabcdef1234 Copyright (c) 2000-2026 the FFmpeg developers",
      major: null,
    },
    {
      line: "ffprobe version 7.0.2 Copyright (c) 2007-2024 the FFmpeg developers",
      major: 7,
      token: "7.0.2",
    },
    {
      line: "ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021 the FFmpeg developers",
      major: 4,
      token: "4.4.2-0ubuntu0.22.04.1",
    },
    { line: "", major: null },
    { line: "not a version line", major: null },
  ];
  for (const c of cases) {
    const parsed = parseFfmpegMajorVersion(c.line);
    assert.equal(parsed?.major ?? null, c.major, c.line);
    if (c.token !== undefined) assert.equal(parsed?.token, c.token, c.line);
  }
  assert.equal(FFMPEG_TESTED_MAJOR, 8);
});

test("ffmpeg/ffprobe below 8 warn once each from verify G2 (CUTHOL-G212)", () => {
  const wsDir = path.join(TEST_ROOT, "ws_old_ffmpeg");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "old ffmpeg", aspect: "16:9", fps: 30 });
  setFakeVersions(
    "ffmpeg version 6.1.1-full_build-www.gyan.dev Copyright (c) 2000-2023 the FFmpeg developers",
    "ffprobe version 6.1.1-full_build-www.gyan.dev Copyright (c) 2007-2023 the FFmpeg developers"
  );
  try {
    const { paths, sequence } = loadSequence(wsDir);
    const report = verifySequence(sequence, paths);
    const warns = report.diagnostics.filter((d) => d.code === "CUTHOL-G212");
    assert.equal(warns.length, 2);
    for (const w of warns) {
      assert.equal(w.severity, "WARN");
      assert.equal(w.gate, "G2_ASSETS");
      assert.match(w.formatted, /^\[CUTHOL-G212\] .* \| Suggestion: .+/);
      assert.ok(w.what.length <= 220, `warning must stay short: ${w.what}`);
    }
    const tools = warns.map((w) => w.what).join("\n");
    assert.ok(tools.includes("ffmpeg 6.1.1"), tools);
    assert.ok(tools.includes("ffprobe 6.1.1"), tools);
    assert.ok(tools.includes("8"), tools);
  } finally {
    clearFakeVersions();
  }
});

test("git builds without a readable version do not warn", () => {
  const wsDir = path.join(TEST_ROOT, "ws_git_ffmpeg");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "git ffmpeg", aspect: "16:9", fps: 30 });
  setFakeVersions(
    "ffmpeg version N-12345-gabcdef1234 Copyright (c) 2000-2026 the FFmpeg developers",
    "ffprobe version N-12345-gabcdef1234 Copyright (c) 2007-2026 the FFmpeg developers"
  );
  try {
    const { paths, sequence } = loadSequence(wsDir);
    const report = verifySequence(sequence, paths);
    assert.ok(!report.diagnostics.some((d) => d.code === "CUTHOL-G212"));
  } finally {
    clearFakeVersions();
  }
});

test("version probe is cached per process until cleared", () => {
  setFakeVersions(
    "ffmpeg version 6.0 Copyright (c) 2000-2023 the FFmpeg developers",
    "ffprobe version 6.0 Copyright (c) 2007-2023 the FFmpeg developers"
  );
  try {
    assert.equal(getFfmpegVersionInfo().ffmpeg?.major, 6);
    // Change the injected line without clearing: the cached probe wins.
    process.env.CUTHOL_FAKE_FFMPEG_VERSION_LINE =
      "ffmpeg version 7.0 Copyright (c) 2000-2024 the FFmpeg developers";
    assert.equal(getFfmpegVersionInfo().ffmpeg?.major, 6);
    clearFfmpegVersionCache();
    assert.equal(getFfmpegVersionInfo().ffmpeg?.major, 7);
    assert.equal(ffmpegVersionWarningDiagnostics().length, 2);
  } finally {
    clearFakeVersions();
  }
});

test("real environment warns exactly when its major is below 8", () => {
  clearFakeVersions();
  const info = getFfmpegVersionInfo();
  const warns = ffmpegVersionWarningDiagnostics();
  const expectWarn =
    (info.ffmpeg !== null && info.ffmpeg.major < FFMPEG_TESTED_MAJOR ? 1 : 0) +
    (info.ffprobe !== null && info.ffprobe.major < FFMPEG_TESTED_MAJOR ? 1 : 0);
  assert.equal(warns.length, expectWarn);
});
