/**
 * Provider selection: flag > env > project default > builtin, journaled defaults
 * (`src/test/providers_select.test.ts`). No network.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CutholError } from "../core/diagnostics.js";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import {
  ASR_ENV_VAR,
  TTS_ENV_VAR,
  describeProviderResolution,
  getProjectProviderDefaults,
  resolveAsrProvider,
  resolveTtsProvider,
  setProjectProviderDefaults,
} from "../speech/provider_select.js";
import { synthesizeVoiceover } from "../speech/synthesize.js";
import { transcribeLibraryAsset } from "../speech/transcribe.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/providers_select");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

function clearProviderEnv(): { asr?: string; tts?: string } {
  const saved = { asr: process.env[ASR_ENV_VAR], tts: process.env[TTS_ENV_VAR] };
  delete process.env[ASR_ENV_VAR];
  delete process.env[TTS_ENV_VAR];
  return saved;
}

function restoreProviderEnv(saved: { asr?: string; tts?: string }): void {
  if (saved.asr === undefined) delete process.env[ASR_ENV_VAR];
  else process.env[ASR_ENV_VAR] = saved.asr;
  if (saved.tts === undefined) delete process.env[TTS_ENV_VAR];
  else process.env[TTS_ENV_VAR] = saved.tts;
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function writeToneWav(wavFile: string, durationSec: number): void {
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=220:sample_rate=16000:duration=${durationSec}`,
      "-c:a",
      "pcm_s16le",
      wavFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);
}

test("resolution order is flag > env > project > builtin", () => {
  const wsDir = path.join(TEST_ROOT, "ws_order");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "order", aspect: "16:9", fps: 30 });
  const saved = clearProviderEnv();
  try {
    assert.deepEqual(resolveAsrProvider({ workspaceDir: wsDir }), { id: "deepgram", source: "builtin" });
    assert.deepEqual(resolveTtsProvider({ workspaceDir: wsDir }), { id: "elevenlabs", source: "builtin" });

    setProjectProviderDefaults(wsDir, { asr: "local", tts: "local" });
    assert.deepEqual(resolveAsrProvider({ workspaceDir: wsDir }), { id: "local", source: "project" });
    assert.deepEqual(resolveTtsProvider({ workspaceDir: wsDir }), { id: "local", source: "project" });

    process.env[ASR_ENV_VAR] = "ext:env-asr";
    process.env[TTS_ENV_VAR] = "ext:env-tts";
    assert.deepEqual(resolveAsrProvider({ workspaceDir: wsDir }), { id: "ext:env-asr", source: "env" });
    assert.deepEqual(resolveTtsProvider({ workspaceDir: wsDir }), { id: "ext:env-tts", source: "env" });

    assert.deepEqual(resolveAsrProvider({ workspaceDir: wsDir, explicit: "deepgram" }), {
      id: "deepgram",
      source: "flag",
    });
    assert.deepEqual(
      resolveTtsProvider({ workspaceDir: wsDir, explicit: "ext:flag-tts" }),
      { id: "ext:flag-tts", source: "flag" }
    );
  } finally {
    restoreProviderEnv(saved);
  }
});

test("invalid provider ids fail with CUTHOL-G230 in every layer", () => {
  const wsDir = path.join(TEST_ROOT, "ws_invalid");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "invalid", aspect: "16:9", fps: 30 });
  const saved = clearProviderEnv();
  try {
    assert.throws(
      () => resolveAsrProvider({ workspaceDir: wsDir, explicit: "bogus" }),
      (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G230"
    );
    assert.throws(
      () => resolveTtsProvider({ workspaceDir: wsDir, explicit: "ext:Bad-Name" }),
      (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G230"
    );
    assert.throws(
      () => setProjectProviderDefaults(wsDir, { asr: "bogus" }),
      (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G230"
    );
    // Invalid values never get stored.
    assert.deepEqual(getProjectProviderDefaults(wsDir), {});

    process.env[ASR_ENV_VAR] = "bogus";
    assert.throws(
      () => resolveAsrProvider({ workspaceDir: wsDir }),
      (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G230"
    );
    delete process.env[ASR_ENV_VAR];

    // A hand-edited bad stored value fails at use time (not at load time).
    commitSequenceMutation(wsDir, "test.corrupt-default", (seq) => {
      seq.providers = { asr: "bogus" };
    });
    assert.throws(
      () => resolveAsrProvider({ workspaceDir: wsDir }),
      (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G230"
    );
  } finally {
    restoreProviderEnv(saved);
  }
});

test("project defaults are journaled, shown, cleared, and undoable over the CLI", () => {
  const wsDir = path.join(TEST_ROOT, "ws_cli_defaults");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "cli", aspect: "16:9", fps: 30 });
  const saved = clearProviderEnv();
  try {
    const revBefore = loadSequence(wsDir).sequence.meta.revision;
    const set = runCli(["speech", "providers", "--asr", "local", "--tts", "local", "--dir", wsDir]);
    assert.equal(set.status, 0, set.stderr);
    const setEnv = JSON.parse(set.stdout) as { defaults?: { asr?: string; tts?: string } };
    assert.deepEqual(setEnv.defaults, { asr: "local", tts: "local" });
    assert.equal(loadSequence(wsDir).sequence.meta.revision, revBefore + 1);

    const shown = runCli(["speech", "providers", "--dir", wsDir]);
    assert.equal(shown.status, 0, shown.stderr);
    const shownEnv = JSON.parse(shown.stdout) as {
      stored?: { asr?: string; tts?: string };
      effective?: { asr?: { id?: string; source?: string } };
    };
    assert.deepEqual(shownEnv.stored, { asr: "local", tts: "local" });
    assert.equal(shownEnv.effective?.asr?.id, "local");
    assert.equal(shownEnv.effective?.asr?.source, "project");

    const cleared = runCli(["speech", "providers", "--asr", "builtin", "--dir", wsDir]);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.deepEqual(getProjectProviderDefaults(wsDir), { tts: "local" });

    const undone = runCli(["workspace", "journal", "undo", "--dir", wsDir]);
    assert.equal(undone.status, 0, undone.stderr);
    assert.deepEqual(getProjectProviderDefaults(wsDir), { asr: "local", tts: "local" });

    assert.deepEqual(describeProviderResolution(wsDir).stored, { asr: "local", tts: "local" });
  } finally {
    restoreProviderEnv(saved);
  }
});

test("env defaults apply without flags (local ASR sidecar, ext TTS)", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_env_use");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "env", aspect: "16:9", fps: 30 });
  const saved = clearProviderEnv();
  const savedLocalTtsCmd = process.env.CUTHOL_LOCAL_TTS_CMD;
  delete process.env.CUTHOL_LOCAL_TTS_CMD;
  try {
    const wavFile = path.join(wsDir, "talk.wav");
    writeToneWav(wavFile, 2);
    fs.writeFileSync(
      `${wavFile}.transcript.json`,
      JSON.stringify({ language: "tr", words: [{ word: "merhaba", source_start_ms: 100, source_end_ms: 500 }] }),
      "utf8"
    );
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [wavFile] });

    process.env[ASR_ENV_VAR] = "local";
    const tr = await transcribeLibraryAsset({ workspaceDir: wsDir, handle: "aud_01", language: "tr" });
    assert.equal(tr.transcript.provider, "local");

    // A project default also applies without flags.
    delete process.env[ASR_ENV_VAR];
    setProjectProviderDefaults(wsDir, { asr: "local" });
    const tr2 = await transcribeLibraryAsset({ workspaceDir: wsDir, handle: "aud_01", language: "tr" });
    assert.equal(tr2.transcript.provider, "local");
    assert.equal(tr2.cached, true);
  } finally {
    restoreProviderEnv(saved);
    if (savedLocalTtsCmd !== undefined) process.env.CUTHOL_LOCAL_TTS_CMD = savedLocalTtsCmd;
  }
});

test("local door stays backward compatible without any provider setting", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_local_compat");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "compat", aspect: "16:9", fps: 30 });
  const saved = clearProviderEnv();
  const savedLocalTtsCmd = process.env.CUTHOL_LOCAL_TTS_CMD;
  delete process.env.CUTHOL_LOCAL_TTS_CMD;
  try {
    const wavFile = path.join(wsDir, "talk.wav");
    writeToneWav(wavFile, 2);
    fs.writeFileSync(
      `${wavFile}.transcript.json`,
      JSON.stringify({ language: "tr", words: [{ word: "merhaba", source_start_ms: 100, source_end_ms: 500 }] }),
      "utf8"
    );
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [wavFile] });

    const tr = await transcribeLibraryAsset({
      workspaceDir: wsDir,
      handle: "aud_01",
      language: "tr",
      provider: "local",
    });
    assert.equal(tr.transcript.provider, "local");
    assert.equal(tr.transcript.model, "local-sidecar");

    const vo = await synthesizeVoiceover({ workspaceDir: wsDir, text: "merhaba", provider: "local" });
    assert.equal(vo.provider, "local");
    assert.equal(vo.is_placeholder_audio, true);
    assert.equal(vo.has_alignment, true);
    assert.equal(vo.alignment_kind, "word");
    assert.equal(vo.alignment_warning, undefined);
  } finally {
    restoreProviderEnv(saved);
    if (savedLocalTtsCmd !== undefined) process.env.CUTHOL_LOCAL_TTS_CMD = savedLocalTtsCmd;
  }
});
