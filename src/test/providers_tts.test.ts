/**
 * Extension TTS providers (`ext:`): aligned/character/unaligned synthesis, cache, diagnostics
 * (`src/test/providers_tts.test.ts`). No network; fake providers are tiny local scripts.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CutholError } from "../core/diagnostics.js";
import { initWorkspace } from "../core/workspace.js";
import { generateSequenceCaptions } from "../speech/captions.js";
import { synthesizeVoiceover } from "../speech/synthesize.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/providers_tts");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

function writeExtension(
  wsDir: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>
): string {
  const dir = path.join(wsDir, ".cuthol", "extensions", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cuthol-extension.json"), JSON.stringify(manifest, null, 2), "utf8");
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content, "utf8");
  }
  return dir;
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
      `sine=frequency=330:sample_rate=48000:duration=${durationSec}`,
      "-c:a",
      "pcm_s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      wavFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);
}

// Fake TTS: copies a sample wav to the output path; alignment mode comes from
// `config.mode` ("word" | "character" | "none").
function writeTtsExtension(wsDir: string, name: string, mode: string, version = "1.0.0"): void {
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const [requestPath, responsePath] = process.argv.slice(2);",
    "const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));",
    "fs.copyFileSync(path.join(request.extension_dir, 'sample.wav'), request.output_audio_path);",
    `const mode = ${JSON.stringify(mode)};`,
    "let response;",
    "if (mode === 'word') {",
    "  response = { alignment: 'word', words: [",
    "    { word: 'selam', start_ms: 100, end_ms: 600 },",
    "    { word: 'dunya', start_ms: 700, end_ms: 1400 },",
    "  ] };",
    "} else if (mode === 'character') {",
    "  response = { alignment: 'character', characters: {",
    "    characters: ['h', 'i', ' ', 'y', 'o'],",
    "    character_start_times_seconds: [0.1, 0.2, 0.3, 0.5, 0.6],",
    "    character_end_times_seconds: [0.2, 0.3, 0.4, 0.6, 0.8],",
    "  } };",
    "} else {",
    "  response = { alignment: 'none' };",
    "}",
    "fs.writeFileSync(responsePath, JSON.stringify(response));",
    "",
  ].join("\n");
  const dir = writeExtension(
    wsDir,
    name,
    {
      schema_version: "1.0.0",
      name,
      version,
      description: "fake tts",
      providers: { tts: { script: "tts.cjs", config: { mode } } },
    },
    { "tts.cjs": script }
  );
  writeToneWav(path.join(dir, "sample.wav"), 2);
}

test("ext TTS with word alignment produces vo_XX with timings and caches", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_tts_word");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Ext TTS", aspect: "16:9", fps: 30 });
  writeTtsExtension(wsDir, "fake-tts", "word");

  const first = await synthesizeVoiceover({
    workspaceDir: wsDir,
    text: "selam dunya",
    provider: "ext:fake-tts",
  });
  assert.equal(first.cached, false);
  assert.equal(first.provider, "ext:fake-tts");
  assert.match(first.asset.handle, /^vo_\d+$/);
  assert.equal(first.words.length, 2);
  assert.ok(first.words[0].source_start_ms < first.words[0].source_end_ms);
  assert.ok(first.words[1].source_start_ms >= first.words[0].source_end_ms);
  assert.equal(first.has_alignment, true);
  assert.equal(first.alignment_kind, "word");
  assert.equal(first.alignment_warning, undefined);
  assert.equal(first.diagnostics, undefined);

  const second = await synthesizeVoiceover({
    workspaceDir: wsDir,
    text: "selam dunya",
    provider: "ext:fake-tts",
  });
  assert.equal(second.cached, true);
  assert.equal(second.words.length, 2);
  assert.equal(second.alignment_kind, "word");
});

test("ext TTS with character alignment derives word tokens", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_tts_char");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Ext TTS char", aspect: "16:9", fps: 30 });
  writeTtsExtension(wsDir, "char-tts", "character");

  const res = await synthesizeVoiceover({
    workspaceDir: wsDir,
    text: "hi yo",
    provider: "ext:char-tts",
  });
  assert.equal(res.has_alignment, true);
  assert.equal(res.alignment_kind, "character");
  assert.equal(res.words.length, 2);
  assert.equal(res.words[0].punctuated_word, "hi");
  assert.equal(res.words[1].punctuated_word, "yo");
});

test("ext TTS without alignment warns honestly and invents no timings", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_tts_none");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Ext TTS none", aspect: "16:9", fps: 30 });
  writeTtsExtension(wsDir, "none-tts", "none");

  const res = await synthesizeVoiceover({
    workspaceDir: wsDir,
    text: "hizalamasiz ses denemesi",
    provider: "ext:none-tts",
    placeOnLane: "ln_vo",
  });
  assert.match(res.asset.handle, /^vo_\d+$/);
  assert.equal(res.words.length, 0);
  assert.equal(res.has_alignment, false);
  assert.equal(res.alignment_kind, "none");
  assert.match(res.alignment_warning ?? "", /without word or character alignment/);
  assert.ok((res.diagnostics ?? []).some((d) => d.code === "CUTHOL-G235"));

  // The CLI envelope carries the same warning.
  const proc = spawnSync(
    process.execPath,
    [CLI, "speech", "synthesize", "--text", "baska bir cumle", "--provider", "ext:none-tts", "--dir", wsDir],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr);
  const envelope = JSON.parse(proc.stdout) as {
    has_alignment?: boolean;
    words?: unknown[];
    alignment_warning?: string;
    diagnostics?: Array<{ code?: string }>;
  };
  assert.equal(envelope.has_alignment, false);
  assert.equal(envelope.words?.length, 0);
  assert.match(envelope.alignment_warning ?? "", /without word or character alignment/);
  assert.ok((envelope.diagnostics ?? []).some((d) => d.code === "CUTHOL-G235"));

  // No fake timings downstream: captions from the unaligned voiceover build no cues.
  const caps = generateSequenceCaptions({ workspaceDir: wsDir });
  assert.equal(caps.cues_created, 0);
});

test("ext TTS cache is separate per provider version and from local", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_tts_cache");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Ext TTS cache", aspect: "16:9", fps: 30 });
  writeTtsExtension(wsDir, "fake-tts", "word");

  const text = "onbellek ayrimi denemesi";
  const first = await synthesizeVoiceover({ workspaceDir: wsDir, text, provider: "ext:fake-tts" });
  assert.equal(first.cached, false);

  writeTtsExtension(wsDir, "fake-tts", "word", "2.0.0");
  const bumped = await synthesizeVoiceover({ workspaceDir: wsDir, text, provider: "ext:fake-tts" });
  assert.equal(bumped.cached, false);

  const again = await synthesizeVoiceover({ workspaceDir: wsDir, text, provider: "ext:fake-tts" });
  assert.equal(again.cached, true);

  const savedLocalTtsCmd = process.env.CUTHOL_LOCAL_TTS_CMD;
  delete process.env.CUTHOL_LOCAL_TTS_CMD;
  try {
    const local = await synthesizeVoiceover({ workspaceDir: wsDir, text, provider: "local" });
    assert.equal(local.cached, false);
    assert.equal(local.provider, "local");
    assert.equal(local.is_placeholder_audio, true);
  } finally {
    if (savedLocalTtsCmd !== undefined) process.env.CUTHOL_LOCAL_TTS_CMD = savedLocalTtsCmd;
  }
});

test("broken ext TTS output fails with CUTHOL-G233 (missing audio: G234)", async () => {
  const modes: Array<{ name: string; script: string[]; code: string }> = [
    {
      name: "bad-alignment-value",
      script: [
        "const fs = require('node:fs');",
        "const [requestPath, responsePath] = process.argv.slice(2);",
        "const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));",
        "fs.copyFileSync(require('node:path').join(request.extension_dir, 'sample.wav'), request.output_audio_path);",
        "fs.writeFileSync(responsePath, JSON.stringify({ alignment: 'sometimes' }));",
      ],
      code: "CUTHOL-G233",
    },
    {
      name: "none-with-timings",
      script: [
        "const fs = require('node:fs');",
        "const [requestPath, responsePath] = process.argv.slice(2);",
        "const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));",
        "fs.copyFileSync(require('node:path').join(request.extension_dir, 'sample.wav'), request.output_audio_path);",
        "fs.writeFileSync(responsePath, JSON.stringify({ alignment: 'none', words: [{ word: 'x', start_ms: 0, end_ms: 10 }] }));",
      ],
      code: "CUTHOL-G233",
    },
    {
      name: "no-audio",
      script: [
        "const fs = require('node:fs');",
        "const [requestPath, responsePath] = process.argv.slice(2);",
        "JSON.parse(fs.readFileSync(requestPath, 'utf8'));",
        "fs.writeFileSync(responsePath, JSON.stringify({ alignment: 'none' }));",
      ],
      code: "CUTHOL-G234",
    },
  ];
  for (const m of modes) {
    const wsDir = path.join(TEST_ROOT, `ws_tts_bad_${m.name}`);
    fs.rmSync(wsDir, { recursive: true, force: true });
    initWorkspace({ dir: wsDir, title: "bad", aspect: "16:9", fps: 30 });
    const dir = writeExtension(
      wsDir,
      "bad-tts",
      {
        schema_version: "1.0.0",
        name: "bad-tts",
        version: "1.0.0",
        description: "bad",
        providers: { tts: { script: "tts.cjs" } },
      },
      { "tts.cjs": [...m.script, ""].join("\n") }
    );
    writeToneWav(path.join(dir, "sample.wav"), 2);
    await assert.rejects(
      synthesizeVoiceover({ workspaceDir: wsDir, text: "deneme", provider: "ext:bad-tts" }),
      (err: unknown) => err instanceof CutholError && err.diagnostic.code === m.code,
      m.name
    );
  }
});
