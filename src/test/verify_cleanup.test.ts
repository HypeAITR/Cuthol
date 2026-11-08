/**
 * speech verify-cleanup: compare a fresh transcript of the spine speech
 * with the words the edit kept. The local ASR stub avoids any paid API.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadJournalManifest, loadSequence, initWorkspace, resolveWorkspacePaths } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { formatEnvelopeCompact } from "../mcp/mcp_format.js";
import { appendSpineClip, exciseSpineRanges } from "../sequence/spine.js";
import { TranscriptDocument } from "../speech/providers.js";
import { verifyCleanup } from "../speech/verify_cleanup.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/verify_cleanup");
const CLI = path.resolve(process.cwd(), "dist/cli.js");
const SCRIPT = path.join(TEST_ROOT, "asr.cjs");

fs.mkdirSync(TEST_ROOT, { recursive: true });
fs.writeFileSync(
  SCRIPT,
  [
    "const fs = require('fs');",
    "const spec = process.env.CUTHOL_VERIFY_ASR_JSON;",
    "if (!spec) { console.error('CUTHOL_VERIFY_ASR_JSON is not set'); process.exit(1); }",
    "const counter = process.env.CUTHOL_VERIFY_ASR_COUNTER;",
    "if (counter) {",
    "  let n = 0;",
    "  try { n = Number(fs.readFileSync(counter, 'utf8')); } catch (err) { n = 0; }",
    "  fs.writeFileSync(counter, String((Number.isFinite(n) ? n : 0) + 1));",
    "}",
    "process.stdout.write(fs.readFileSync(spec, 'utf8'));",
    "",
  ].join("\n"),
  "utf8"
);

interface StubWord {
  word: string;
  source_start_ms: number;
  source_end_ms: number;
}

function writeToneMedia(mediaFile: string, durationSec: number): void {
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
      `aevalsrc='0.22*sin(2*PI*220*t)':s=16000:d=${durationSec}`,
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

function word(text: string, start: number, end: number): TranscriptDocument["words"][number] {
  return {
    word: text,
    punctuated_word: text,
    source_start_ms: start,
    source_end_ms: end,
    confidence: 0.99,
    is_filler: false,
    is_repetition: false,
  };
}

function seedTranscript(wsDir: string, words: TranscriptDocument["words"], text: string): void {
  const { paths, sequence } = loadSequence(wsDir);
  const vid = sequence.library[0];
  const ledger = new MediaLedger(paths.ledgerFile);
  const doc: TranscriptDocument = {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: vid.probe.duration_ms,
    text,
    words,
    disfluencies: [],
  };
  ledger.setTranscript(vid.digest_sha256, "tr", doc);
  ledger.setTranscript(vid.digest_sha256, "local:tr", doc);
  ledger.setTranscript(vid.digest_sha256, "latest", doc);
  ledger.close();
}

function setupProject(name: string, sourceWords: TranscriptDocument["words"], text: string): string {
  const wsDir = path.join(TEST_ROOT, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  const mediaFile = path.join(wsDir, "talk.mp4");
  writeToneMedia(mediaFile, 4);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
  seedTranscript(wsDir, sourceWords, text);
  return wsDir;
}

function writeStub(name: string, words: StubWord[]): string {
  const file = path.join(TEST_ROOT, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ words }), "utf8");
  return file;
}

async function runVerify(
  wsDir: string,
  stubFile: string,
  counterFile: string,
  provider?: "local"
): Promise<Awaited<ReturnType<typeof verifyCleanup>>> {
  const prev = {
    key: process.env.DEEPGRAM_API_KEY,
    cmd: process.env.CUTHOL_LOCAL_ASR_CMD,
    json: process.env.CUTHOL_VERIFY_ASR_JSON,
    counter: process.env.CUTHOL_VERIFY_ASR_COUNTER,
  };
  process.env.DEEPGRAM_API_KEY = "";
  process.env.CUTHOL_LOCAL_ASR_CMD = `"${process.execPath}" "${SCRIPT}"`;
  process.env.CUTHOL_VERIFY_ASR_JSON = stubFile;
  process.env.CUTHOL_VERIFY_ASR_COUNTER = counterFile;
  try {
    return await verifyCleanup({
      workspaceDir: wsDir,
      allSpine: true,
      ...(provider ? { provider } : {}),
      language: "tr",
    });
  } finally {
    if (prev.key === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = prev.key;
    if (prev.cmd === undefined) delete process.env.CUTHOL_LOCAL_ASR_CMD;
    else process.env.CUTHOL_LOCAL_ASR_CMD = prev.cmd;
    if (prev.json === undefined) delete process.env.CUTHOL_VERIFY_ASR_JSON;
    else process.env.CUTHOL_VERIFY_ASR_JSON = prev.json;
    if (prev.counter === undefined) delete process.env.CUTHOL_VERIFY_ASR_COUNTER;
    else process.env.CUTHOL_VERIFY_ASR_COUNTER = prev.counter;
  }
}

function projectSnapshot(wsDir: string): { sequence: string; revision: number; cursor: number } {
  const paths = resolveWorkspacePaths(wsDir);
  const sequence = fs.readFileSync(paths.sequenceFile, "utf8");
  const revision = loadSequence(wsDir).sequence.meta.revision;
  const cursor = loadJournalManifest(paths).cursor_revision;
  return { sequence, revision, cursor };
}

test("verify-cleanup scenarios", { timeout: 180_000 }, async () => {
  const kept = [
    word("merhaba", 200, 500),
    word("dostlar", 520, 900),
    word("bugun", 920, 1300),
  ];

  // (a) expected words are the words the new pass hears.
  const wsA = setupProject("match", kept, "merhaba dostlar bugun");
  const beforeA = projectSnapshot(wsA);
  const stubA = writeStub("match", [
    { word: "merhaba", source_start_ms: 200, source_end_ms: 500 },
    { word: "dostlar", source_start_ms: 520, source_end_ms: 900 },
    { word: "bugun", source_start_ms: 920, source_end_ms: 1300 },
  ]);
  const counterA = path.join(TEST_ROOT, "match.count");
  fs.rmSync(counterA, { force: true });
  const match = await runVerify(wsA, stubA, counterA);
  assert.equal(match.missing_words.length, 0, "scenario a missing");
  assert.equal(match.repeated_phrases.length, 0, "scenario a repeated");
  assert.equal(match.unexpected_words.length, 0, "scenario a unexpected");
  assert.equal(match.match_rate, 1);
  assert.equal(match.provider, "local");
  assert.equal(match.cached, false);
  assert.equal(match.dry_run, true);
  const matchAgain = await runVerify(wsA, stubA, counterA);
  assert.equal(matchAgain.cached, true);
  assert.equal(matchAgain.missing_words.length, 0);
  assert.equal(fs.readFileSync(counterA, "utf8").trim(), "1");
  const afterA = projectSnapshot(wsA);
  assert.equal(afterA.revision, beforeA.revision);
  assert.equal(afterA.cursor, beforeA.cursor);
  assert.equal(afterA.sequence, beforeA.sequence);

  // (b) one kept word is absent from the new pass, next to an excised gap.
  const wsB = setupProject("missing", [
    word("merhaba", 100, 400),
    word("dostlar", 1050, 1400),
    word("bugun", 1500, 1900),
  ], "merhaba dostlar bugun");
  exciseSpineRanges({
    workspaceDir: wsB,
    clipId: "sp_01",
    ranges: [{ start_ms: 600, end_ms: 1000 }],
    coordinateSpace: "source",
  });
  const beforeB = projectSnapshot(wsB);
  const stubB = writeStub("missing", [
    { word: "merhaba", source_start_ms: 100, source_end_ms: 400 },
    { word: "bugun", source_start_ms: 1100, source_end_ms: 1500 },
  ]);
  const missing = await runVerify(wsB, stubB, path.join(TEST_ROOT, "missing.count"), "local");
  assert.equal(missing.missing_words.length, 1, JSON.stringify(missing.missing_words));
  assert.equal(missing.missing_words[0].word, "dostlar");
  assert.equal(missing.missing_words[0].source_start_ms, 1050);
  assert.equal(missing.missing_words[0].source_end_ms, 1400);
  assert.equal(typeof missing.missing_words[0].sequence_start_ms, "number");
  const clips = loadSequence(wsB).sequence.spine.clips
    .filter((clip) => clip.asset_handle === "vid_01")
    .sort((a, b) => a.source_in_ms - b.source_in_ms);
  assert.equal(clips.length, 2);
  const gapStart = clips[0].source_out_ms;
  const gapEnd = clips[1].source_in_ms;
  assert.equal(missing.missing_words[0].neighbor_cut_id, `ex_vid_01_${gapStart}_${gapEnd}`);
  assert.ok(missing.missing_words[0].source_start_ms - gapEnd <= 250);
  const afterB = projectSnapshot(wsB);
  assert.equal(afterB.revision, beforeB.revision);
  assert.equal(afterB.sequence, beforeB.sequence);

  // (c) the new pass hears one phrase twice in a row.
  const wsC = setupProject("repeat", [
    word("merhaba", 200, 500),
    word("dostlar", 520, 800),
  ], "merhaba dostlar");
  const beforeC = projectSnapshot(wsC);
  const stubC = writeStub("repeat", [
    { word: "merhaba", source_start_ms: 200, source_end_ms: 500 },
    { word: "dostlar", source_start_ms: 520, source_end_ms: 800 },
    { word: "merhaba", source_start_ms: 2000, source_end_ms: 2300 },
    { word: "dostlar", source_start_ms: 2320, source_end_ms: 2600 },
  ]);
  const repeated = await runVerify(wsC, stubC, path.join(TEST_ROOT, "repeat.count"), "local");
  assert.equal(repeated.repeated_phrases.length, 1, JSON.stringify(repeated.repeated_phrases));
  assert.equal(repeated.repeated_phrases[0].occurrences, 2);
  assert.match(repeated.repeated_phrases[0].phrase, /merhaba dostlar/);
  assert.equal(repeated.repeated_phrases[0].repeats.length, 2);
  const link = repeated.repeated_phrases[0].preserved_untranscribed;
  assert.ok(link, "repeated phrase should link a preserved untranscribed run");
  assert.equal(link.clip_id, "sp_01");
  assert.ok(link.sequence_start_ms <= 2000 && link.sequence_end_ms >= 2600, JSON.stringify(link));
  const afterC = projectSnapshot(wsC);
  assert.equal(afterC.revision, beforeC.revision);
  assert.equal(afterC.sequence, beforeC.sequence);

  // (d) the CLI action reports the comparison and leaves the revision alone.
  const wsD = setupProject("cli", kept, "merhaba dostlar bugun");
  const beforeD = projectSnapshot(wsD);
  const stubD = writeStub("cli", [
    { word: "merhaba", source_start_ms: 200, source_end_ms: 500 },
    { word: "dostlar", source_start_ms: 520, source_end_ms: 900 },
    { word: "bugun", source_start_ms: 920, source_end_ms: 1300 },
  ]);
  const proc = spawnSync(
    process.execPath,
    [CLI, "speech", "verify-cleanup", "--all-spine", "--provider", "local", "--lang", "tr", "--dir", wsD],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DEEPGRAM_API_KEY: "",
        CUTHOL_LOCAL_ASR_CMD: `"${process.execPath}" "${SCRIPT}"`,
        CUTHOL_VERIFY_ASR_JSON: stubD,
      },
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  assert.equal(proc.status, 0, `${proc.stderr}\n${proc.stdout}`);
  const env = JSON.parse(proc.stdout) as {
    ok?: boolean;
    command?: string;
    dry_run?: boolean;
    missing_words?: unknown[];
    state?: { revision?: number };
  };
  assert.equal(env.ok, true);
  assert.equal(env.command, "speech.verify-cleanup");
  assert.equal(env.dry_run, true);
  assert.equal(env.missing_words?.length, 0);
  assert.equal(env.state?.revision, beforeD.revision);
  const afterD = projectSnapshot(wsD);
  assert.equal(afterD.revision, beforeD.revision);
  assert.equal(afterD.cursor, beforeD.cursor);
  assert.equal(afterD.sequence, beforeD.sequence);
});

test("compact verify-cleanup text keeps the first 10 findings of each kind", () => {
  const missing = Array.from({ length: 12 }, (_, i) => ({
    word: `w${i}`,
    sequence_start_ms: i * 100,
    sequence_end_ms: i * 100 + 40,
    source_start_ms: i * 100,
    source_end_ms: i * 100 + 40,
    clip_id: "sp_01",
  }));
  const repeated = Array.from({ length: 11 }, (_, i) => ({
    phrase: `p${i} q${i}`,
    occurrences: 2,
    sequence_start_ms: i * 1000,
    sequence_end_ms: i * 1000 + 800,
    repeats: [
      { sequence_start_ms: i * 1000, sequence_end_ms: i * 1000 + 300 },
      { sequence_start_ms: i * 1000 + 400, sequence_end_ms: i * 1000 + 800 },
    ],
  }));
  const unexpected = Array.from({ length: 11 }, (_, i) => ({
    word: `u${i}`,
    sequence_start_ms: 5000 + i * 50,
    sequence_end_ms: 5000 + i * 50 + 30,
    duration_ms: 30,
    fragment_candidate: true,
  }));
  const { text } = formatEnvelopeCompact({
    envelope: {
      ok: true,
      command: "speech.verify-cleanup",
      dry_run: true,
      match_rate: 0,
      expected_word_count: 12,
      heard_word_count: 11,
      matched_word_count: 0,
      provider: "local",
      cached: false,
      missing_words: missing,
      repeated_phrases: repeated,
      unexpected_words: unexpected,
    },
    command: "speech.verify-cleanup",
    values: {},
  });
  assert.match(text, /Verify cleanup: match 0\/12/);
  assert.match(text, /Missing words \(12, showing 10\)/);
  assert.match(text, /w0 seq=0\.\.40ms src=0\.\.40ms clip=sp_01/);
  assert.match(text, /w9 seq=900\.\.940ms/);
  assert.doesNotMatch(text, /w10/);
  assert.match(text, /2 more/);
  assert.match(text, /Repeated phrases \(11, showing 10\)/);
  assert.match(text, /p0 q0/);
  assert.doesNotMatch(text, /p10/);
  assert.match(text, /Unexpected words \(11, showing 10\)/);
  assert.match(text, /u0 seq=5000\.\.5030ms \(30ms, fragment\)/);
  assert.doesNotMatch(text, /u10/);
  assert.match(text, /DRY-RUN speech\.verify_cleanup/);
});

test("verify-cleanup puts a spelling difference in substituted_words and a dropped word in missing_words", { timeout: 180_000 }, async () => {
  const wsSpell = setupProject(
    "spell",
    [word("merhaba", 200, 500), word("hızlanabilir", 520, 900)],
    "merhaba hızlanabilir"
  );
  const stubSpell = writeStub("spell", [
    { word: "merhaba", source_start_ms: 200, source_end_ms: 500 },
    { word: "hızlanılabilir", source_start_ms: 520, source_end_ms: 900 },
  ]);
  const spelling = await runVerify(wsSpell, stubSpell, path.join(TEST_ROOT, "spell.count"), "local");
  assert.equal(spelling.missing_words.length, 0, JSON.stringify(spelling.missing_words));
  assert.equal(spelling.unexpected_words.length, 0, JSON.stringify(spelling.unexpected_words));
  assert.equal(spelling.substituted_words.length, 1, JSON.stringify(spelling.substituted_words));
  const diff = spelling.substituted_words[0];
  assert.equal(diff.expected, "hızlanabilir");
  assert.equal(diff.heard, "hızlanılabilir");
  assert.ok(diff.similarity >= 0.6 && diff.similarity < 1, String(diff.similarity));
  assert.equal(diff.source_start_ms, 520);
  assert.equal(diff.source_end_ms, 900);
  assert.equal(diff.sequence_start_ms, 520);
  assert.equal(diff.sequence_end_ms, 900);
  assert.equal(diff.clip_id, "sp_01");
  assert.equal(spelling.match_rate, 0.5);
  assert.equal(spelling.match_rate_lenient, 1);
  assert.equal(spelling.matched_word_count, 1);

  const wsDrop = setupProject(
    "dropped",
    [word("merhaba", 200, 500), word("dostlar", 520, 900)],
    "merhaba dostlar"
  );
  const stubDrop = writeStub("dropped", [
    { word: "merhaba", source_start_ms: 200, source_end_ms: 500 },
  ]);
  const dropped = await runVerify(wsDrop, stubDrop, path.join(TEST_ROOT, "dropped.count"), "local");
  assert.equal(dropped.missing_words.length, 1, JSON.stringify(dropped.missing_words));
  assert.equal(dropped.missing_words[0].word, "dostlar");
  assert.equal(dropped.substituted_words.length, 0);
  assert.equal(dropped.unexpected_words.length, 0);
  assert.equal(dropped.match_rate, 0.5);
  assert.equal(dropped.match_rate_lenient, 0.5);
});

test("compact verify-cleanup text shows substituted words last and caps them at 5", () => {
  const substituted = Array.from({ length: 7 }, (_, i) => ({
    expected: `exp${i}`,
    heard: `heard${i}`,
    similarity: 0.8,
    sequence_start_ms: i * 100,
    sequence_end_ms: i * 100 + 40,
    source_start_ms: i * 100,
    source_end_ms: i * 100 + 40,
    clip_id: "sp_01",
  }));
  const { text } = formatEnvelopeCompact({
    envelope: {
      ok: true,
      command: "speech.verify-cleanup",
      dry_run: true,
      match_rate: 0.5,
      match_rate_lenient: 0.9,
      expected_word_count: 10,
      heard_word_count: 10,
      matched_word_count: 5,
      provider: "local",
      cached: false,
      missing_words: [
        {
          word: "dostlar",
          sequence_start_ms: 1,
          sequence_end_ms: 2,
          source_start_ms: 1,
          source_end_ms: 2,
          clip_id: "sp_01",
        },
      ],
      repeated_phrases: [
        {
          phrase: "merhaba dostlar",
          occurrences: 2,
          sequence_start_ms: 10,
          sequence_end_ms: 20,
          repeats: [
            { sequence_start_ms: 10, sequence_end_ms: 14 },
            { sequence_start_ms: 15, sequence_end_ms: 20 },
          ],
        },
      ],
      unexpected_words: [],
      substituted_words: substituted,
    },
    command: "speech.verify-cleanup",
    values: {},
  });
  assert.match(text, /missing 1 · repeated 1 · unexpected 0 · substituted 7/);
  assert.match(text, /lenient 0\.9/);
  const missingAt = text.indexOf("Missing words");
  const repeatedAt = text.indexOf("Repeated phrases");
  const substitutedAt = text.indexOf("Substituted words");
  assert.ok(missingAt >= 0 && repeatedAt > missingAt && substitutedAt > repeatedAt);
  assert.match(text, /Substituted words \(7, showing 5\)/);
  assert.match(text, /exp0 → heard0 sim=0\.8 seq=0\.\.40ms src=0\.\.40ms clip=sp_01/);
  assert.match(text, /exp4 → heard4/);
  assert.doesNotMatch(text, /exp5/);
  assert.match(text, /2 more/);
  assert.doesNotMatch(text, /"substituted_words"/);
});
