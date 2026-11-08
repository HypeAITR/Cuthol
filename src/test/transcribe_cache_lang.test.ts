/**
 * Launch L1: transcript cache is keyed by the document's real language
 * (`src/test/transcribe_cache_lang.test.ts`). No paid API: the local provider
 * door (sidecars, `CUTHOL_LOCAL_ASR_CMD`) and directly seeded cache records.
 *
 * Rules pinned here:
 * - Default transcribe language is auto-detection, never silent `tr`.
 * - An explicit `--lang en` never resolves to another language's record, not
 *   even through the generic `auto`/`latest` keys.
 * - A cache hit is re-keyed only under its real language; a record whose key
 *   language disagrees with `doc.language` (poisoned) is skipped on read.
 * - `speech transcribe --refresh` (and the MCP `refresh` param) skips the
 *   cache, re-transcribes, and replaces the stored record.
 * - Old-scheme correct records (bare/provider/generic keys) still hit.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CutholError } from "../core/diagnostics.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { buildCliArgv, findActionSpec } from "../mcp/catalog.js";
import { appendSpineClip } from "../sequence/spine.js";
import { generateSequenceCaptions } from "../speech/captions.js";
import { cleanupClipDialogue } from "../speech/cleanup.js";
import { TranscriptDocument } from "../speech/providers.js";
import { loadCachedTranscriptForAsset, transcribeLibraryAsset } from "../speech/transcribe.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/transcribe_cache_lang");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

type TranscribeOptions = Parameters<typeof transcribeLibraryAsset>[0];

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

function setupMedia(name: string, durationSec = 3): { wsDir: string; mediaFile: string } {
  const wsDir = path.join(TEST_ROOT, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  const mediaFile = path.join(wsDir, "talk.mp4");
  writeToneMp4(mediaFile, durationSec);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  return { wsDir, mediaFile };
}

function makeDoc(
  language: string,
  text: string,
  words: Array<{ word: string; source_start_ms: number; source_end_ms: number }>,
  durationMs = 3000
): TranscriptDocument {
  return {
    provider: "local",
    model: "test",
    language,
    duration_ms: durationMs,
    text,
    words: words.map((w) => ({
      word: w.word,
      punctuated_word: w.word,
      source_start_ms: w.source_start_ms,
      source_end_ms: w.source_end_ms,
      confidence: 0.99,
      is_filler: false,
      is_repetition: false,
    })),
    disfluencies: [],
  };
}

const TR_DOC = () =>
  makeDoc("tr", "merhaba dunya bugun", [
    { word: "merhaba", source_start_ms: 100, source_end_ms: 500 },
    { word: "dunya", source_start_ms: 600, source_end_ms: 1000 },
    { word: "bugun", source_start_ms: 1100, source_end_ms: 1500 },
  ]);

const EN_DOC = () =>
  makeDoc("en", "hello world today", [
    { word: "hello", source_start_ms: 100, source_end_ms: 500 },
    { word: "world", source_start_ms: 600, source_end_ms: 1000 },
    { word: "today", source_start_ms: 1100, source_end_ms: 1500 },
  ]);

function seedKeys(wsDir: string, handle: string, keys: string[], doc: TranscriptDocument): void {
  const { paths, sequence } = loadSequence(wsDir);
  const item = sequence.library.find((x) => x.handle === handle);
  assert.ok(item);
  const ledger = new MediaLedger(paths.ledgerFile);
  try {
    for (const key of keys) ledger.setTranscript(item.digest_sha256, key, doc);
  } finally {
    ledger.close();
  }
}

function readKey(wsDir: string, handle: string, key: string): TranscriptDocument | null {
  const { paths, sequence } = loadSequence(wsDir);
  const item = sequence.library.find((x) => x.handle === handle);
  assert.ok(item);
  const ledger = new MediaLedger(paths.ledgerFile);
  try {
    return ledger.getTranscript<TranscriptDocument>(item.digest_sha256, key);
  } finally {
    ledger.close();
  }
}

function writeSidecar(
  mediaFile: string,
  doc: { language?: string; text?: string; words: Array<Record<string, unknown>> }
): void {
  fs.writeFileSync(`${mediaFile}.transcript.json`, JSON.stringify(doc), "utf8");
}

function blankDeepgramKey(): string | undefined {
  const prev = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_API_KEY = "";
  return prev;
}

function restoreDeepgramKey(prev: string | undefined): void {
  if (prev === undefined) delete process.env.DEEPGRAM_API_KEY;
  else process.env.DEEPGRAM_API_KEY = prev;
}

function ensureBuiltinProvider(): string | undefined {
  const prev = process.env.CUTHOL_ASR_PROVIDER;
  delete process.env.CUTHOL_ASR_PROVIDER;
  return prev;
}

function restoreProviderEnv(prev: string | undefined): void {
  if (prev === undefined) delete process.env.CUTHOL_ASR_PROVIDER;
  else process.env.CUTHOL_ASR_PROVIDER = prev;
}

test("explicit --lang en never resolves to a Turkish record under generic keys (builtin, no paid call)", async () => {
  const { wsDir } = setupMedia("ws_explicit_ignores_generic");
  // Realistic leftover: a Turkish transcript reachable only via generic keys.
  seedKeys(wsDir, "vid_01", ["auto", "latest"], TR_DOC());
  const prevKey = blankDeepgramKey();
  const prevProvider = ensureBuiltinProvider();
  try {
    // On fixed code this misses the cache and fails before any network call
    // (no API key); on buggy code it returns the Turkish record as cached.
    await assert.rejects(
      transcribeLibraryAsset({ workspaceDir: wsDir, handle: "vid_01", language: "en" }),
      (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-SYS05",
      "expected a cache miss (missing API key before any network call), not a cached Turkish record"
    );
  } finally {
    restoreDeepgramKey(prevKey);
    restoreProviderEnv(prevProvider);
  }
});

test("poisoned local:en record is skipped; fresh English replaces it, Turkish keys untouched", async () => {
  const { wsDir, mediaFile } = setupMedia("ws_poison_skipped");
  writeSidecar(mediaFile, {
    language: "en",
    text: "hello world today",
    words: [
      { word: "hello", source_start_ms: 100, source_end_ms: 500 },
      { word: "world", source_start_ms: 600, source_end_ms: 1000 },
      { word: "today", source_start_ms: 1100, source_end_ms: 1500 },
    ],
  });
  // Poisoned state left by the old writer: the Turkish document filed under
  // English keys, alongside its legitimate Turkish keys.
  seedKeys(wsDir, "vid_01", ["local:en", "en", "auto", "latest", "local:tr", "tr"], TR_DOC());

  const res = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    language: "en",
    provider: "local",
  });
  assert.equal(res.cached, false);
  assert.equal(res.transcript.language, "en");
  assert.ok(res.transcript.text.includes("hello"));

  assert.equal(readKey(wsDir, "vid_01", "local:en")?.language, "en");
  assert.equal(readKey(wsDir, "vid_01", "en")?.language, "en");
  assert.equal(readKey(wsDir, "vid_01", "auto")?.language, "en");
  assert.equal(readKey(wsDir, "vid_01", "latest")?.language, "en");
  assert.equal(readKey(wsDir, "vid_01", "local:tr")?.language, "tr");
  assert.equal(readKey(wsDir, "vid_01", "tr")?.language, "tr");
});

test("--refresh skips the cache, re-transcribes, and replaces the stored record", async () => {
  const { wsDir, mediaFile } = setupMedia("ws_refresh");
  const sidecar = (text: string) => ({
    language: "en",
    text,
    words: [{ word: text.split(" ")[0], source_start_ms: 100, source_end_ms: 500 }],
  });
  writeSidecar(mediaFile, sidecar("first version here"));
  const first = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    language: "en",
    provider: "local",
  });
  assert.equal(first.cached, false);

  const cached = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    language: "en",
    provider: "local",
  });
  assert.equal(cached.cached, true);
  assert.ok(cached.transcript.text.includes("first"));

  writeSidecar(mediaFile, sidecar("second version here"));
  const refreshed = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    language: "en",
    provider: "local",
    refresh: true,
  } as TranscribeOptions);
  assert.equal(refreshed.cached, false);
  assert.ok(refreshed.transcript.text.includes("second"));
  assert.ok(readKey(wsDir, "vid_01", "local:en")?.text.includes("second"));
});

test("cache hit is keyed only by its real language (no generic rewrite, no other-language keys)", async () => {
  const { wsDir, mediaFile } = setupMedia("ws_hit_keying");
  writeSidecar(mediaFile, {
    language: "en",
    text: "hello world today",
    words: [{ word: "hello", source_start_ms: 100, source_end_ms: 500 }],
  });
  seedKeys(wsDir, "vid_01", ["local:en"], EN_DOC());

  const res = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    language: "en",
    provider: "local",
  });
  assert.equal(res.cached, true);
  assert.equal(res.transcript.language, "en");

  assert.equal(readKey(wsDir, "vid_01", "en")?.language, "en");
  assert.equal(readKey(wsDir, "vid_01", "tr"), null);
  assert.equal(readKey(wsDir, "vid_01", "local:tr"), null);
  assert.equal(readKey(wsDir, "vid_01", "deepgram:tr"), null);
  assert.equal(readKey(wsDir, "vid_01", "auto"), null);
  assert.equal(readKey(wsDir, "vid_01", "latest"), null);
});

test("backward compat: old-scheme correct records still hit (builtin and local)", async () => {
  const builtin = setupMedia("ws_compat_builtin");
  seedKeys(builtin.wsDir, "vid_01", ["en", "deepgram:en", "auto", "latest"], EN_DOC());
  const prevKey = blankDeepgramKey();
  const prevProvider = ensureBuiltinProvider();
  try {
    // A hit never touches the network; the blanked key turns a regressed miss
    // into a loud error instead of a paid call.
    const hit = await transcribeLibraryAsset({
      workspaceDir: builtin.wsDir,
      handle: "vid_01",
      language: "en",
    });
    assert.equal(hit.cached, true);
    assert.equal(hit.transcript.language, "en");
  } finally {
    restoreDeepgramKey(prevKey);
    restoreProviderEnv(prevProvider);
  }

  const local = setupMedia("ws_compat_local");
  seedKeys(local.wsDir, "vid_01", ["local:en", "en", "auto", "latest"], EN_DOC());
  const localHit = await transcribeLibraryAsset({
    workspaceDir: local.wsDir,
    handle: "vid_01",
    language: "en",
    provider: "local",
  });
  assert.equal(localHit.cached, true);
  assert.equal(localHit.transcript.language, "en");
});

test("loadCachedTranscriptForAsset skips a poisoned key (key language vs doc.language mismatch)", () => {
  const { wsDir } = setupMedia("ws_loadcached_poison");
  seedKeys(wsDir, "vid_01", ["en"], TR_DOC());
  assert.throws(
    () => loadCachedTranscriptForAsset(wsDir, "vid_01", "en"),
    (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-SYS06"
  );
});

test("loadCachedTranscriptForAsset keeps lenient downstream fallback for other languages", () => {
  const { wsDir } = setupMedia("ws_loadcached_lenient");
  seedKeys(wsDir, "vid_01", ["local:en", "en", "auto", "latest"], EN_DOC());
  // Downstream readers (cleanup, captions, ducking) prefer the requested
  // language but still accept the recorded transcript instead of failing.
  const doc = loadCachedTranscriptForAsset(wsDir, "vid_01", "tr");
  assert.equal(doc.language, "en");
});

test("default transcribe language is auto-detection, never silent tr", async () => {
  const { wsDir, mediaFile } = setupMedia("ws_auto_default");
  writeSidecar(mediaFile, {
    language: "en",
    text: "hello world today",
    words: [
      { word: "hello", source_start_ms: 100, source_end_ms: 500 },
      { word: "world", source_start_ms: 600, source_end_ms: 1000 },
      { word: "today", source_start_ms: 1100, source_end_ms: 1500 },
    ],
  });
  const res = await transcribeLibraryAsset({ workspaceDir: wsDir, handle: "vid_01", provider: "local" });
  assert.equal(res.cached, false);
  assert.equal(res.transcript.language, "en");
  assert.equal(readKey(wsDir, "vid_01", "local:en")?.language, "en");
  assert.equal(readKey(wsDir, "vid_01", "tr"), null);
  assert.equal(readKey(wsDir, "vid_01", "local:tr"), null);
});

test("provider without auto-detection support asks for an explicit language (CUTHOL-G213)", async () => {
  const { wsDir } = setupMedia("ws_auto_unsupported");
  const stubPath = path.join(TEST_ROOT, "ws_auto_unsupported_cmd.cjs");
  fs.writeFileSync(
    stubPath,
    [
      "console.log(JSON.stringify({ words: [{ word: 'hello', source_start_ms: 100, source_end_ms: 500 }] }));",
      "",
    ].join("\n"),
    "utf8"
  );
  const prevCmd = process.env.CUTHOL_LOCAL_ASR_CMD;
  process.env.CUTHOL_LOCAL_ASR_CMD = `"${process.execPath}" "${stubPath}"`;
  try {
    await assert.rejects(
      transcribeLibraryAsset({ workspaceDir: wsDir, handle: "vid_01", provider: "local" }),
      (err: unknown) => {
        if (!(err instanceof CutholError) || err.diagnostic.code !== "CUTHOL-G213") return false;
        assert.match(err.diagnostic.suggestion, /--lang/);
        return true;
      }
    );
  } finally {
    if (prevCmd === undefined) delete process.env.CUTHOL_LOCAL_ASR_CMD;
    else process.env.CUTHOL_LOCAL_ASR_CMD = prevCmd;
  }
});

test("CLI speech transcribe --refresh re-transcribes end to end", () => {
  const { wsDir, mediaFile } = setupMedia("ws_cli_refresh");
  const sidecar = (text: string) => ({
    language: "en",
    text,
    words: [{ word: text.split(" ")[0], source_start_ms: 100, source_end_ms: 500 }],
  });
  const runCli = (args: string[]) => {
    const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    assert.equal(proc.status, 0, proc.stderr);
    return JSON.parse(proc.stdout) as { ok: boolean; cached?: boolean; digest?: { stats?: { text_preview?: string } } };
  };
  writeSidecar(mediaFile, sidecar("first version here"));
  const first = runCli(["speech", "transcribe", "--handle", "vid_01", "--lang", "en", "--provider", "local", "--dir", wsDir]);
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);

  writeSidecar(mediaFile, sidecar("second version here"));
  const refreshed = runCli(["speech", "transcribe", "--handle", "vid_01", "--lang", "en", "--provider", "local", "--refresh", "--dir", wsDir]);
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.cached, false);
  assert.ok(refreshed.digest?.stats?.text_preview?.includes("second"));
});

test("MCP speech.transcribe has refresh and auto-detect lang", () => {
  const spec = findActionSpec("speech", "transcribe");
  assert.ok(spec);
  const refresh = spec.params.find((p) => p.name === "refresh");
  assert.ok(refresh, "speech.transcribe must accept a refresh param");
  assert.equal(refresh.type, "boolean");
  const argv = buildCliArgv(spec, { handle: "vid_01", refresh: true }, TEST_ROOT);
  assert.ok(argv.includes("--refresh=true"), argv.join(" "));

  const lang = spec.params.find((p) => p.name === "lang");
  assert.ok(lang);
  assert.match(lang.description, /auto/);

  const argvNoLang = buildCliArgv(spec, { handle: "vid_01" }, TEST_ROOT);
  assert.ok(!argvNoLang.some((a) => a.startsWith("--lang")), argvNoLang.join(" "));
});

test("cleanup and captions read the recorded language without --lang", async () => {
  const { wsDir } = setupMedia("ws_downstream_en");
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
  seedKeys(wsDir, "vid_01", ["local:en", "en", "auto", "latest"], EN_DOC());

  const dry = cleanupClipDialogue({ workspaceDir: wsDir, dryRun: true });
  assert.ok(Array.isArray(dry.cuts));

  const caps = generateSequenceCaptions({ workspaceDir: wsDir });
  assert.ok(caps.cues_created >= 1);
});

test("voiceover without --lang records 'und' for non-Turkish text and 'tr' only with Turkish-only letters", async () => {
  const { guessTextLanguage, synthesizeVoiceover } = await import("../speech/synthesize.js");
  assert.equal(guessTextLanguage("Today we are checking the release build."), "und");
  assert.equal(guessTextLanguage("Bugün sürümü kontrol ediyoruz, şimdi."), "tr");
  assert.equal(guessTextLanguage("Ça marche très bien, über alles."), "und");

  const wsDir = path.join(TEST_ROOT, "ws_tts_lang");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "tts lang", aspect: "16:9", fps: 30 });
  const vo = await synthesizeVoiceover({ workspaceDir: wsDir, text: "Today we are checking the release build.", provider: "local" });
  const handle = (vo as { asset: { handle: string } }).asset.handle;
  assert.equal(readKey(wsDir, handle, "auto")?.language, "und");
  assert.equal(readKey(wsDir, handle, "tr"), null, "an English voiceover must not be filed as Turkish");

  // An explicit language never reuses the undetermined voiceover record.
  const prevKey = blankDeepgramKey();
  const prevProvider = ensureBuiltinProvider();
  try {
    await assert.rejects(
      transcribeLibraryAsset({ workspaceDir: wsDir, handle, language: "en" }),
      (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-SYS05"
    );
  } finally {
    restoreDeepgramKey(prevKey);
    restoreProviderEnv(prevProvider);
  }
});
