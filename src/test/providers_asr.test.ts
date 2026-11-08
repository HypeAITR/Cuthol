/**
 * Extension ASR providers (`ext:`): transcript attach, cache separation, secrets, diagnostics
 * (`src/test/providers_asr.test.ts`). No network; fake providers are tiny local scripts.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CutholError } from "../core/diagnostics.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { validateExtensionManifest } from "../extensions/ext_manifest.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { generateSequenceCaptions } from "../speech/captions.js";
import { cleanupClipDialogue } from "../speech/cleanup.js";
import { transcribeLibraryAsset } from "../speech/transcribe.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/providers_asr");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

// Fake provider scripts use `.cjs` (with `require`) because test workspaces live under
// this repo's `type: module` package, where plain `.js` would parse as ESM.
function writeExtension(
  wsDir: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>
): void {
  const dir = path.join(wsDir, ".cuthol", "extensions", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cuthol-extension.json"), JSON.stringify(manifest, null, 2), "utf8");
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content, "utf8");
  }
}

function writeAsrExtension(
  wsDir: string,
  name: string,
  response: unknown,
  extra?: { version?: string; env?: string[]; rawResponse?: string }
): void {
  const script = [
    "const fs = require('node:fs');",
    "const [requestPath, responsePath] = process.argv.slice(2);",
    "const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));",
    extra?.rawResponse !== undefined
      ? `fs.writeFileSync(responsePath, ${JSON.stringify(extra.rawResponse)}, 'utf8');`
      : `fs.writeFileSync(responsePath, ${JSON.stringify(JSON.stringify(response))}, 'utf8');`,
    "",
  ].join("\n");
  writeExtension(
    wsDir,
    name,
    {
      schema_version: "1.0.0",
      name,
      version: extra?.version ?? "1.0.0",
      description: "fake asr",
      providers: {
        asr: {
          script: "asr.cjs",
          ...(extra?.env ? { env: extra.env } : {}),
        },
      },
    },
    { "asr.cjs": script }
  );
}

function writeToneMp4(mediaFile: string, durationSec: number): void {
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=#0F172A:s=320x180:r=30:d=${durationSec}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=220:sample_rate=16000:duration=${durationSec}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      mediaFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);
}

const FAKE_WORDS = {
  language: "tr",
  text: "merhaba dunya nasilsin",
  words: [
    { word: "merhaba", start_ms: 200, end_ms: 800, confidence: 0.9 },
    { word: "dunya", start_ms: 900, end_ms: 1500, confidence: 0.9 },
    // Long pause 1500..4500 for cleanup to find.
    { word: "nasilsin", start_ms: 4500, end_ms: 5200, confidence: 0.9 },
  ],
};

test("ext ASR transcript attaches to the sequence; cleanup and captions work on it", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_asr_attach");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Ext ASR", aspect: "16:9", fps: 30 });
  writeAsrExtension(wsDir, "fake-asr", FAKE_WORDS);

  const mediaFile = path.join(wsDir, "talk.mp4");
  writeToneMp4(mediaFile, 6);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 6000 });

  const tr = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    language: "tr",
    provider: "ext:fake-asr",
  });
  assert.equal(tr.cached, false);
  assert.equal(tr.transcript.provider, "ext:fake-asr");
  assert.equal(tr.transcript.words.length, 3);
  assert.ok(tr.projected_sequence_words.length > 0);

  const seq = loadSequence(wsDir).sequence;
  assert.match(seq.library[0].analysis_refs.transcript ?? "", /^asr_[0-9a-f]{8}$/);

  const dry = cleanupClipDialogue({ workspaceDir: wsDir, allSpine: true, dryRun: true });
  assert.ok(dry.cuts.length > 0, "expected the 3s pause to become a cut candidate");

  const caps = generateSequenceCaptions({ workspaceDir: wsDir });
  assert.ok(caps.cues_created > 0, "expected captions from the ext transcript");
});

test("cache: same provider hits cache, other providers and versions stay separate", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_asr_cache");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Ext ASR cache", aspect: "16:9", fps: 30 });
  writeAsrExtension(wsDir, "fake-asr", FAKE_WORDS);

  const mediaFile = path.join(wsDir, "talk.mp4");
  writeToneMp4(mediaFile, 6);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });

  const first = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    language: "tr",
    provider: "ext:fake-asr",
  });
  assert.equal(first.cached, false);
  const second = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    language: "tr",
    provider: "ext:fake-asr",
  });
  assert.equal(second.cached, true);
  assert.equal(second.transcript.provider, "ext:fake-asr");

  // A different provider gets its own record (sidecar-backed local door).
  fs.writeFileSync(
    `${mediaFile}.transcript.json`,
    JSON.stringify({
      language: "tr",
      words: [{ word: "yerel", source_start_ms: 100, source_end_ms: 500 }],
    }),
    "utf8"
  );
  const local = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    language: "tr",
    provider: "local",
  });
  assert.equal(local.cached, false);
  assert.equal(local.transcript.provider, "local");

  // The ext record is untouched by the local one.
  const third = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    language: "tr",
    provider: "ext:fake-asr",
  });
  assert.equal(third.cached, true);
  assert.equal(third.transcript.words.length, 3);

  // Bumping the extension version invalidates its cache record.
  writeAsrExtension(wsDir, "fake-asr", FAKE_WORDS, { version: "1.0.1" });
  const bumped = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    language: "tr",
    provider: "ext:fake-asr",
  });
  assert.equal(bumped.cached, false);
});

test("broken provider output fails with CUTHOL-G233", async () => {
  const cases: Array<{ name: string; response?: unknown; rawResponse?: string }> = [
    { name: "words-not-array", response: { words: "nope" } },
    { name: "word-missing-fields", response: { words: [{ word: "x" }] } },
    { name: "response-not-object", response: [1, 2, 3] },
    { name: "invalid-json", rawResponse: "{not json" },
  ];
  for (const c of cases) {
    const wsDir = path.join(TEST_ROOT, `ws_asr_bad_${c.name}`);
    fs.rmSync(wsDir, { recursive: true, force: true });
    initWorkspace({ dir: wsDir, title: "bad", aspect: "16:9", fps: 30 });
    writeAsrExtension(wsDir, "bad-asr", c.response, { rawResponse: c.rawResponse });
    const mediaFile = path.join(wsDir, "talk.mp4");
    writeToneMp4(mediaFile, 2);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
    await assert.rejects(
      transcribeLibraryAsset({
        workspaceDir: wsDir,
        handle: "vid_01",
        language: "tr",
        provider: "ext:bad-asr",
      }),
      (err: unknown) =>
        err instanceof CutholError && err.diagnostic.code === "CUTHOL-G233",
      c.name
    );
  }
});

test("missing declared env fails with CUTHOL-G232 naming the variable", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_asr_env_missing");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "env", aspect: "16:9", fps: 30 });
  const varName = "PROVIDERS_TEST_MISSING_KEY_X1";
  delete process.env[varName];
  writeAsrExtension(wsDir, "keyed-asr", FAKE_WORDS, { env: [varName] });
  const mediaFile = path.join(wsDir, "talk.mp4");
  writeToneMp4(mediaFile, 2);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  await assert.rejects(
    transcribeLibraryAsset({
      workspaceDir: wsDir,
      handle: "vid_01",
      language: "tr",
      provider: "ext:keyed-asr",
    }),
    (err: unknown) => {
      if (!(err instanceof CutholError) || err.diagnostic.code !== "CUTHOL-G232") return false;
      assert.match(err.diagnostic.what, new RegExp(varName));
      assert.match(err.diagnostic.suggestion, /\.env/);
      return true;
    }
  );
});

test("secrets: declared vars reach the script, others do not, values are never stored", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_asr_secrets");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "secrets", aspect: "16:9", fps: 30 });

  const declaredVar = "PROVIDERS_TEST_SECRET_A";
  const undeclaredVar = "PROVIDERS_TEST_SECRET_B";
  const secretA = `sk-provtest-${Date.now().toString(36)}-a1b2`;
  const secretB = `sk-provtest-${Date.now().toString(36)}-c3d4`;
  process.env[declaredVar] = secretA;
  process.env[undeclaredVar] = secretB;
  try {
    // The script reports what it saw through plain signal words (never values).
    const script = [
      "const fs = require('node:fs');",
      "const [requestPath, responsePath] = process.argv.slice(2);",
      "JSON.parse(fs.readFileSync(requestPath, 'utf8'));",
      `const sawA = process.env.${declaredVar} === ${JSON.stringify(secretA)};`,
      `const sawB = process.env.${undeclaredVar} !== undefined;`,
      "const pathOk = typeof process.env.PATH === 'string' && process.env.PATH.length > 0;",
      "const words = [",
      "  { word: sawA ? 'saw_declared_yes' : 'saw_declared_no', start_ms: 100, end_ms: 400 },",
      "  { word: sawB ? 'saw_undeclared_yes' : 'saw_undeclared_no', start_ms: 500, end_ms: 800 },",
      "  { word: pathOk ? 'path_yes' : 'path_no', start_ms: 900, end_ms: 1200 },",
      "];",
      "fs.writeFileSync(responsePath, JSON.stringify({ words }));",
      "",
    ].join("\n");
    writeExtension(
      wsDir,
      "secret-asr",
      {
        schema_version: "1.0.0",
        name: "secret-asr",
        version: "1.0.0",
        description: "secret probe",
        providers: { asr: { script: "asr.cjs", env: [declaredVar] } },
      },
      { "asr.cjs": script }
    );

    const mediaFile = path.join(wsDir, "talk.mp4");
    writeToneMp4(mediaFile, 2);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });

    // Exercise the CLI so stdout/stderr are captured too.
    const proc = spawnSync(
      process.execPath,
      [CLI, "speech", "transcribe", "--handle", "vid_01", "--lang", "tr", "--provider", "ext:secret-asr", "--dir", wsDir],
      { encoding: "utf8" }
    );
    assert.equal(proc.status, 0, proc.stderr);
    const envelope = JSON.parse(proc.stdout) as {
      digest?: { preview?: { items?: Array<{ word?: string }> } };
    };
    const seenWords = JSON.stringify(envelope.digest?.preview?.items ?? envelope);
    assert.ok(seenWords.includes("saw_declared_yes"), "declared var did not reach the script");
    assert.ok(seenWords.includes("saw_undeclared_no"), "undeclared var leaked into the script");
    assert.ok(seenWords.includes("path_yes"), "PATH was not passed to the script");
    assert.ok(!proc.stdout.includes(secretA), "secret value leaked into CLI stdout");
    assert.ok(!proc.stdout.includes(secretB), "undeclared secret leaked into CLI stdout");
    assert.ok(!proc.stderr.includes(secretA), "secret value leaked into CLI stderr");

    // Neither value may be stored anywhere (checked in the raw bytes).
    const ledgerDb = path.join(wsDir, ".cuthol", "ledger.sqlite");
    const ledgerRaw = fs.readFileSync(ledgerDb, "latin1");
    assert.ok(!ledgerRaw.includes(secretA), "secret value leaked into the ledger");
    assert.ok(!ledgerRaw.includes(secretB), "undeclared secret leaked into the ledger");

    const seqRaw = fs.readFileSync(path.join(wsDir, "cuthol.sequence.json"), "utf8");
    assert.ok(!seqRaw.includes(secretA) && !seqRaw.includes(secretB));
    for (const entry of fs.readdirSync(path.join(wsDir, ".cuthol", "journal"))) {
      const content = fs.readFileSync(path.join(wsDir, ".cuthol", "journal", entry), "utf8");
      assert.ok(!content.includes(secretA) && !content.includes(secretB), `leak in journal/${entry}`);
    }
  } finally {
    delete process.env[declaredVar];
    delete process.env[undeclaredVar];
  }
});

test("extension without an asr provider fails with CUTHOL-G231", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_asr_capability");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "capability", aspect: "16:9", fps: 30 });
  writeExtension(
    wsDir,
    "tts-only",
    {
      schema_version: "1.0.0",
      name: "tts-only",
      version: "1.0.0",
      description: "tts only",
      providers: { tts: { script: "tts.cjs" } },
    },
    { "tts.cjs": "process.exit(0);\n" }
  );
  const mediaFile = path.join(wsDir, "talk.mp4");
  writeToneMp4(mediaFile, 2);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  await assert.rejects(
    transcribeLibraryAsset({
      workspaceDir: wsDir,
      handle: "vid_01",
      language: "tr",
      provider: "ext:tts-only",
    }),
    (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G231"
  );
});

test("manifest providers section is closed-schema validated (G112)", () => {
  const bad: unknown[] = [
    { providers: {} },
    { providers: { video: { script: "x.cjs" } } },
    { providers: { asr: { script: "x.cjs", bogus: 1 } } },
    { providers: { asr: {} } },
    { providers: { asr: { script: "../evil.cjs" } } },
    { providers: { asr: { script: "a.cjs", config: [] } } },
    { providers: { asr: { script: "a.cjs", env: "KEY" } } },
    { providers: { asr: { script: "a.cjs", env: ["9bad"] } } },
  ];
  for (const providers of bad) {
    assert.throws(
      () =>
        validateExtensionManifest(
          { name: "t", version: "1", description: "d", ...(providers as Record<string, unknown>) },
          "t"
        ),
      (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G112",
      JSON.stringify(providers)
    );
  }
  const good = validateExtensionManifest(
    {
      name: "t",
      version: "1",
      description: "d",
      providers: { asr: { script: "a.cjs", config: { k: 1 }, env: ["A_KEY"] } },
    },
    "t"
  );
  assert.equal(good.providers?.asr?.script, "a.cjs");
});

test("provider scripts cannot use the network without declaring it (G206)", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_asr_net");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "net", aspect: "16:9", fps: 30 });
  writeExtension(
    wsDir,
    "net-asr",
    {
      schema_version: "1.0.0",
      name: "net-asr",
      version: "1.0.0",
      description: "net",
      providers: { asr: { script: "asr.cjs" } },
    },
    {
      "asr.cjs": [
        "const fs = require('node:fs');",
        "async function main() { await fetch('https://example.com/'); }",
        "main();",
        "",
      ].join("\n"),
    }
  );
  const mediaFile = path.join(wsDir, "talk.mp4");
  writeToneMp4(mediaFile, 2);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  await assert.rejects(
    transcribeLibraryAsset({
      workspaceDir: wsDir,
      handle: "vid_01",
      language: "tr",
      provider: "ext:net-asr",
    }),
    (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G206"
  );
});
