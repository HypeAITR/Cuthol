/**
 * Verification Suite (`src/test/envelope_undo_cli_mcp.test.ts`):
 * 1. `cuthol.envelope/1` State Delta & Breadcrumb, Targeted Undo (`--to`, `--expect-rev`, `--dry-run`)
 *    & Protected Target Lock (`CUTHOL-G111` `PROTECTED_TARGET` preventing accidental title deletion)
 * 2. Progressive Disclosure (`digest` + `queryLibraryAnalysis`) & Explainable `decision_trace`
 *    on `duckMusicUnderDialogue`, `cleanupClipDialogue`, `generateSequenceCaptions`, `normalizeSequenceAudio`
 * 3. Self-Describing CLI (`help --json`, `UNKNOWN_FLAG` `CUTHOL-G110`) & `CutholMcpServer`
 *    (8 core tools -> `discover_capabilities`, stale output invalidation, loop guard, JSON argument repair)
 * 4. Offline Real-Media End-to-End Workflow (zero paid API calls, recorded Turkish speech fixture +
 *    multi-scene video + music ducking + reactive `window.__cuthol` HyperFrames composition).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { previewAndCheckComposition } from "../compositor/composition_preview.js";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import { CutholError } from "../core/diagnostics.js";
import {
  buildWorkspaceEnvelopeHeader,
  initWorkspace,
  loadSequence,
  setLaneLockStatus,
  stepJournal,
} from "../core/workspace.js";
import { analyzeAssetBeats } from "../library/beats.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { formatTranscribeDigest, queryLibraryAnalysis } from "../library/query.js";
import { analyzeAssetWaveform } from "../library/waveform.js";
import { findActionSpec, validateActionArgs } from "../mcp/catalog.js";
import { CutholMcpServer, repairToolArguments } from "../mcp/server.js";
import { duckMusicUnderDialogue, normalizeSequenceAudio } from "../mix/audio_mix.js";
import { captureMonitorFrame } from "../monitor/preview.js";
import { captureMonitorTimeline } from "../monitor/timeline_view.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";
import { generateSequenceCaptions } from "../speech/captions.js";
import { cleanupClipDialogue } from "../speech/cleanup.js";
import { TranscriptDocument } from "../speech/providers.js";
import { transcribeLibraryAsset } from "../speech/transcribe.js";
import { runWorkspaceVerification } from "../verify/gates.js";
import { fixturePath } from "./fixtures.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/envelope_undo_cli_mcp_tests");

function ensureOfflineFixtureMedia(dir: string): {
  speechVidPath: string;
  brollVidPath: string;
  musicPath: string;
} {
  fs.mkdirSync(dir, { recursive: true });
  const speechVidPath = path.join(dir, "offline_speech_vid.mp4");
  const brollVidPath = path.join(dir, "offline_broll_vid.mp4");
  const musicPath = path.join(dir, "offline_bgm.mp3");

  // Reuse real recorded Turkish neural speech if present in the fixtures folder, else synthesize deterministic speech-like waveform with real pauses
  const existingRealVo = path.resolve(
    process.cwd(),
    fixturePath("real-speech/real_turkish_vo.mp3")
  );

  if (!fs.existsSync(speechVidPath)) {
    if (fs.existsSync(existingRealVo)) {
      spawnSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=1280x720:rate=30:duration=6",
          "-i",
          existingRealVo,
          "-t",
          "6",
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          speechVidPath,
        ],
        { encoding: "utf8" }
      );
    } else {
      spawnSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=1280x720:rate=30:duration=6",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=260:sample_rate=16000:duration=6",
          "-af",
          "volume='if(between(t,1.8,2.45),0.001,1.0)':eval=frame",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          speechVidPath,
        ],
        { encoding: "utf8" }
      );
    }
  }

  if (!fs.existsSync(brollVidPath)) {
    spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x1E293B:s=1280x720:r=30:d=4",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=16000:cl=mono:d=4",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        brollVidPath,
      ],
      { encoding: "utf8" }
    );
  }

  if (!fs.existsSync(musicPath)) {
    spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=110:sample_rate=16000:duration=8",
        "-af",
        "volume='if(lt(mod(t,0.5),0.08),0.9,0.2)':eval=frame",
        "-c:a",
        "libmp3lame",
        musicPath,
      ],
      { encoding: "utf8" }
    );
  }

  return { speechVidPath, brollVidPath, musicPath };
}

test("1. cuthol.envelope/1 State Delta, Targeted Undo (--to, --expect-rev, --dry-run) & Protected Title Lock (CUTHOL-G111)", () => {
  const wsDir = path.join(TEST_ROOT, "ws_undo_protection");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { speechVidPath } = ensureOfflineFixtureMedia(path.join(TEST_ROOT, "media"));

  initWorkspace({ dir: wsDir, title: "Undo Protection Test", aspect: "16:9", fps: 30 }); // r1
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [speechVidPath] }); // r2
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 }); // r3

  // r4: Add title cue ("Kapadokya'da 3 Gün") on ln_titles
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_titles",
    kind: "title",
    explicitId: "cue_title",
    atMs: 300,
    durationMs: 2500,
    text: "Kapadokya'da 3 Gün",
  });

  // r5: Lock ln_titles so the title cannot be accidentally deleted during sequential undo!
  setLaneLockStatus({ workspaceDir: wsDir, laneId: "ln_titles", locked: true });

  // r6: Add BGM cue on ln_bgm
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    explicitId: "cue_bgm",
    assetHandle: "vid_01",
    atMs: 0,
    durationMs: 3500,
  });

  const envAtR6 = buildWorkspaceEnvelopeHeader(wsDir);
  assert.equal(envAtR6.state.revision, 6);
  assert.ok(envAtR6.state.state_digest.includes("r6"));
  assert.equal(envAtR6.history.undo_preview?.inverse_kind, "destructive");
  assert.ok(envAtR6.history.undo_preview?.inverse_summary.includes("cue_bgm"));
  assert.ok(envAtR6.history.breadcrumb.length >= 4);

  // 1a. Optimistic concurrency check: wrong --expect-rev must fail with CUTHOL-G109
  assert.throws(
    () => stepJournal(wsDir, "undo", { expectRevision: 99 }),
    (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G109",
    "Expected CUTHOL-G109 REVISION_MISMATCH when expectRevision does not match cursor"
  );

  // 1b. Dry-run targeted undo to r3: previews reverting r6, r5, r4 without modifying disk
  const dryRes = stepJournal(wsDir, "undo", {
    toRevision: 3,
    expectRevision: 6,
    dryRun: true,
  });
  assert.equal(dryRes.dry_run, true);
  assert.equal(dryRes.reverted_entries.length, 3);
  assert.equal(loadSequence(wsDir).sequence.meta.revision, 6, "Dry-run must not mutate sequence on disk");

  // 1c. Real targeted undo to r3 WITHOUT allowProtected -> MUST be blocked by CUTHOL-G111 (PROTECTED_TARGET) because cue_title on locked ln_titles would be deleted!
  assert.throws(
    () => stepJournal(wsDir, "undo", { toRevision: 3, expectRevision: 6 }),
    (err: unknown) => err instanceof CutholError && err.diagnostic.code === "CUTHOL-G111",
    "Expected CUTHOL-G111 PROTECTED_TARGET when undo would delete locked cue_title"
  );
  assert.equal(loadSequence(wsDir).sequence.meta.revision, 6, "Blocked undo must leave revision at 6");

  // 1d. Undo 1 step (r6 -> r5, removing only unprotected cue_bgm) succeeds!
  const undo1 = stepJournal(wsDir, "undo", { steps: 1, expectRevision: 6 });
  assert.equal(undo1.revision, 5);
  assert.equal(loadSequence(wsDir).sequence.lanes.find((l) => l.id === "ln_titles")!.cues.length, 1);

  // 1e. Explicit allowProtected allows reverting past r4 when the agent intentionally authorizes it
  const undoAllowed = stepJournal(wsDir, "undo", {
    toRevision: 3,
    expectRevision: 5,
    allowProtected: ["cue_title", "ln_titles"],
  });
  assert.equal(undoAllowed.revision, 3);
});

test("2. Progressive Disclosure (digest + library query) & Explainable decision_trace on duck/cleanup/captions/normalize", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_digest_and_trace");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { speechVidPath, brollVidPath, musicPath } = ensureOfflineFixtureMedia(path.join(TEST_ROOT, "media"));

  initWorkspace({ dir: wsDir, title: "Digest & Trace Test", aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({
    workspaceDir: wsDir,
    filePaths: [speechVidPath, brollVidPath, musicPath],
  });

  // Seed offline recorded Turkish transcript for vid_01 so zero cloud API call is needed
  const { paths, sequence: seq0 } = loadSequence(wsDir);
  const vid01 = seq0.library.find((x) => x.handle === "vid_01")!;
  const ledger = new MediaLedger(paths.ledgerFile);
  const recordedTrDoc: TranscriptDocument = {
    provider: "local",
    model: "offline-recorded-fixture",
    language: "tr",
    duration_ms: 6000,
    text: "Selam İstanbul'da yapay zeka ajanları kurgu yapıyor ve yüzde doksan dokuz başarı sağlıyor.",
    words: [
      { word: "Selam", punctuated_word: "Selam,", source_start_ms: 100, source_end_ms: 420, confidence: 0.99, is_filler: false, is_repetition: false },
      // 180ms pause here (420..600ms) -> near-miss (< 400ms threshold)
      { word: "İstanbul'da", punctuated_word: "İstanbul'da", source_start_ms: 600, source_end_ms: 1120, confidence: 0.98, is_filler: false, is_repetition: false },
      { word: "yapay", punctuated_word: "yapay", source_start_ms: 1150, source_end_ms: 1480, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "zeka", punctuated_word: "zeka", source_start_ms: 1500, source_end_ms: 1800, confidence: 0.99, is_filler: false, is_repetition: false },
      // 650ms pause here (1800..2450ms) -> APPLIED cut (>= 400ms threshold)
      { word: "ajanları", punctuated_word: "ajanları", source_start_ms: 2450, source_end_ms: 2950, confidence: 0.97, is_filler: false, is_repetition: false },
      { word: "kurgu", punctuated_word: "kurgu", source_start_ms: 3000, source_end_ms: 3400, confidence: 0.98, is_filler: false, is_repetition: false },
      { word: "yapıyor.", punctuated_word: "yapıyor.", source_start_ms: 3420, source_end_ms: 3900, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "doksan", punctuated_word: "doksan", source_start_ms: 4100, source_end_ms: 4550, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "dokuz", punctuated_word: "dokuz", source_start_ms: 4560, source_end_ms: 5050, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "başarı.", punctuated_word: "başarı.", source_start_ms: 5100, source_end_ms: 5650, confidence: 0.65, is_filler: false, is_repetition: false },
    ],
    disfluencies: [
      { kind: "pause", source_start_ms: 420, source_end_ms: 600, duration_ms: 180, label: "<pause 180ms>" },
      { kind: "pause", source_start_ms: 1800, source_end_ms: 2450, duration_ms: 650, label: "<pause 650ms>" },
    ],
  };
  ledger.setTranscript(vid01.digest_sha256, "local:tr", recordedTrDoc);
  ledger.close();

  // Append sp_01 (transcribed speech vid_01) and sp_02 (untranscribed B-roll vid_02)
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 6000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_02", sourceInMs: 0, sourceOutMs: 3000 });

  // 2a. Progressive Disclosure: Transcribe digest & paginated library query
  const trRes = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    language: "tr",
    provider: "local",
  });
  const trDigest = formatTranscribeDigest(trRes);
  assert.equal(trDigest.digest.kind, "transcript");
  assert.equal(trDigest.digest.counts.words, 10);
  assert.ok(trDigest.digest.preview.items.length <= 6);
  assert.ok(trDigest.digest.attention.some((a) => a.reason === "LOW_CONFIDENCE"));

  // Query by Turkish diacritic-insensitive text ("ISTANBULDA")
  const qText = queryLibraryAnalysis({
    workspaceDir: wsDir,
    handle: "vid_01",
    kind: "transcript",
    text: "ISTANBULDA",
  });
  assert.equal(qText.matched, 1);

  // Query with pagination (--limit 3)
  const qPage1 = queryLibraryAnalysis({
    workspaceDir: wsDir,
    handle: "vid_01",
    kind: "transcript",
    limit: 3,
  });
  assert.equal(qPage1.returned, 3);
  assert.equal(qPage1.truncated, true);
  assert.equal(qPage1.next_cursor, "3");

  // 2b. Cleanup decision_trace: must report 1 APPLIED cut (650ms) and 1 TOO_SHORT near-miss (180ms)
  const cleanRes = cleanupClipDialogue({
    workspaceDir: wsDir,
    clipId: "sp_01",
    minPauseMs: 400,
    padMs: 75,
  });
  assert.equal(cleanRes.cuts_count, 1);
  assert.equal(cleanRes.decision_trace.feature, "silence_cut");
  assert.equal(cleanRes.decision_trace.summary.accepted, 1);
  assert.equal(cleanRes.decision_trace.near_misses.length, 1);
  assert.equal(cleanRes.decision_trace.near_misses[0].reason_code, "TOO_SHORT");
  assert.equal(cleanRes.decision_trace.near_misses[0].measured?.gap_ms, 180);

  // 2c. Captions decision_trace
  const capRes = generateSequenceCaptions({
    workspaceDir: wsDir,
    style: "active_word",
    language: "tr",
  });
  assert.ok(capRes.cues_created >= 2);
  assert.equal(capRes.decision_trace.feature, "auto_caption");
  assert.ok(capRes.decision_trace.rules.length >= 3);

  // 2d. Ducking decision_trace: must explain that untranscribed B-roll clip on spine was skipped (NO_TRANSCRIPT_SKIPPED)
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: 7500,
  });
  const duckRes = duckMusicUnderDialogue({
    workspaceDir: wsDir,
    bgmLaneId: "ln_bgm",
    duckDb: -12,
  });
  assert.equal(duckRes.decision_trace.feature, "ducking");
  assert.ok(
    duckRes.decision_trace.near_misses.some((nm) => nm.reason_code === "NO_TRANSCRIPT_SKIPPED"),
    "Expected ducking decision_trace to explain that untranscribed B-roll clip was skipped"
  );

  // 2e. Normalize decision_trace
  const normRes = normalizeSequenceAudio({ workspaceDir: wsDir, targetLufs: -14 });
  assert.equal(normRes.decision_trace.feature, "loudness_normalize");
});

test("3. Self-Describing CLI (UNKNOWN_FLAG CUTHOL-G110, help --json) & CutholMcpServer (8 Core Tools -> discover_capabilities, Stale Notice, Loop Guard)", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_mcp_and_cli");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { speechVidPath } = ensureOfflineFixtureMedia(path.join(TEST_ROOT, "media"));

  const cliJs = path.resolve(process.cwd(), "dist/cli.js");

  // 3a. CLI `help --json` returns self-describing tool schemas and flag lexicon
  const helpProc = spawnSync(process.execPath, [cliJs, "help", "lane", "--json"], {
    encoding: "utf8",
  });
  assert.equal(helpProc.status, 0);
  const helpJson = JSON.parse(helpProc.stdout);
  assert.equal(helpJson.ok, true);
  assert.equal(helpJson.tools[0].name, "lane");
  assert.ok(helpJson.flag_lexicon.composition_dir.includes("--comp-dir"));

  // 3b. CLI unknown flag `--compdir` fails with CUTHOL-G110 and suggests `--comp-dir`
  const badFlagProc = spawnSync(
    process.execPath,
    [cliJs, "lane", "add-composition", "--compdir", "./my_comp"],
    { encoding: "utf8" }
  );
  assert.notEqual(badFlagProc.status, 0);
  const badFlagJson = JSON.parse(badFlagProc.stderr);
  assert.equal(badFlagJson.diagnostic.code, "CUTHOL-G110");
  assert.ok(badFlagJson.diagnostic.suggestion.includes("--comp-dir"));

  // 3c. All tools are visible by default; progressive mode hides specialists until discover_capabilities
  const mcpAll = new CutholMcpServer();
  const listAll = await mcpAll.handleJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const allTools = (listAll!.result as { tools: Array<{ name: string }> }).tools;
  assert.equal(allTools.length, 14, "Expected all 14 tools by default");
  assert.ok(allTools.some((t) => t.name === "render") && allTools.some((t) => t.name === "guide"));
  assert.ok(allTools.some((t) => t.name === "extension"));

  const mcp = new CutholMcpServer({ progressive: true });
  const list1 = await mcp.handleJsonRpcRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const initialTools = (list1!.result as { tools: Array<{ name: string }> }).tools;
  assert.equal(initialTools.length, 9, "8 core tools + discover_capabilities in progressive mode");
  assert.equal(initialTools.some((t) => t.name === "speech"), false);
  await mcp.callTool("discover_capabilities", { groups: ["speech", "mix", "composition"] });
  const list2 = await mcp.handleJsonRpcRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const unlockedTools = (list2!.result as { tools: Array<{ name: string }> }).tools;
  assert.equal(unlockedTools.some((t) => t.name === "speech"), true);
  assert.equal(unlockedTools.some((t) => t.name === "composition"), true);

  // 3d. Argument repair (aliases, kebab-case keys, NaN removal) + catalog validation/coercion
  const repaired = repairToolArguments({
    project: wsDir,
    composition_dir: "compositions/card",
    "dry-run": "false",
    badNum: Number.NaN,
  });
  assert.equal(repaired.dir, wsDir);
  assert.equal(repaired.comp_dir, "compositions/card");
  assert.equal(repaired.dry_run, "false");
  assert.equal("badNum" in repaired, false);
  const scaffoldSpec = findActionSpec("composition", "scaffold")!;
  const checked = validateActionArgs(scaffoldSpec, {
    comp_dir: "compositions/card",
    props: '{"headline":"REPAIRED","target":99.4}',
    transparent: "true",
  });
  assert.equal(checked.issues.length, 0);
  assert.deepEqual(checked.values.props, { headline: "REPAIRED", target: 99.4 });
  assert.equal(checked.values.transparent, true);
  const wrongArg = validateActionArgs(findActionSpec("spine", "trim")!, { clip: "sp_01", at: "2s" });
  assert.ok(wrongArg.issues.some((i) => i.kind === "unknown_arg" && i.message.includes("split")));

  // 3e. Session project folder + change detection when the project is edited outside the session
  const initRes = await mcp.callTool("workspace", { action: "init", dir: wsDir, aspect: "16:9", fps: 30 });
  assert.equal(initRes.isError, false);
  const ingestRes = await mcp.callTool("library", { action: "ingest", files: [speechVidPath] });
  assert.equal(ingestRes.isError, false, "dir is remembered after workspace.init");
  const briefRes = await mcp.callTool("brief", { lens: "overview" });
  assert.equal(briefRes.isError, false);
  assert.ok(String(briefRes.content[0].text).includes("vid_01"));

  const outside = spawnSync(process.execPath, [cliJs, "spine", "append", "--asset", "vid_01", "--in", "0s", "--out", "3s", "--dir", wsDir], {
    encoding: "utf8",
  });
  assert.equal(outside.status, 0);
  const afterOutside = await mcp.callTool("spine", { action: "trim", clip: "sp_01", out: "2500ms" });
  assert.equal(afterOutside.isError, false);
  assert.ok(String(afterOutside.content[0].text).startsWith("NOTE the project changed outside this session"));
  assert.ok(String(afterOutside.content[0].text).includes("Undo (expect_rev"));

  // 3f. Loop Guard: the 3rd identical failing call is not executed
  const badArgs = { action: "trim", clip: "sp_99", out: "2s" };
  const fail1 = await mcp.callTool("spine", badArgs);
  assert.equal(fail1.isError, true);
  assert.ok(String(fail1.content[0].text).includes("CUTHOL-G101"));
  const fail2 = await mcp.callTool("spine", badArgs);
  assert.equal(fail2.isError, true);
  const fail3 = await mcp.callTool("spine", badArgs);
  assert.equal(fail3.isError, true);
  assert.ok(String(fail3.content[0].text).includes("CUTHOL-LOOP-GUARD"));
});

test("4. End-to-End Offline Real-Media Production Workflow with Reactive window.__cuthol HyperFrames Composition", () => {
  const wsDir = path.join(TEST_ROOT, "ws_offline_e2e_final");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { speechVidPath, musicPath } = ensureOfflineFixtureMedia(path.join(TEST_ROOT, "media"));

  initWorkspace({ dir: wsDir, title: "Cuthol v2 Offline E2E", aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [speechVidPath, musicPath] });
  analyzeAssetWaveform({ workspaceDir: wsDir, handle: "vid_01", bins: 80 });
  analyzeAssetBeats({ workspaceDir: wsDir, handle: "aud_01" });

  // Seed recorded Turkish transcript on vid_01
  const { paths, sequence: seq0 } = loadSequence(wsDir);
  const vid01 = seq0.library.find((x) => x.handle === "vid_01")!;
  const ledger = new MediaLedger(paths.ledgerFile);
  ledger.setTranscript(vid01.digest_sha256, "local:tr", {
    provider: "local",
    model: "offline-recorded-fixture",
    language: "tr",
    duration_ms: 6000,
    text: "Cuthol kurgu motoru doksan dokuz doğrulukla çalışıyor.",
    words: [
      { word: "Cuthol", punctuated_word: "Cuthol", source_start_ms: 200, source_end_ms: 650, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "kurgu", punctuated_word: "kurgu", source_start_ms: 700, source_end_ms: 1150, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "motoru", punctuated_word: "motoru", source_start_ms: 1200, source_end_ms: 1700, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "doksan", punctuated_word: "doksan", source_start_ms: 1850, source_end_ms: 2350, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "dokuz", punctuated_word: "dokuz", source_start_ms: 2360, source_end_ms: 2850, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "doğrulukla", punctuated_word: "doğrulukla", source_start_ms: 2950, source_end_ms: 3600, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "çalışıyor.", punctuated_word: "çalışıyor.", source_start_ms: 3650, source_end_ms: 4300, confidence: 0.99, is_filler: false, is_repetition: false },
    ],
    disfluencies: [],
  });
  ledger.close();

  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4800 });
  generateSequenceCaptions({ workspaceDir: wsDir, style: "active_word", language: "tr" });

  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: 4800,
  });
  duckMusicUnderDialogue({ workspaceDir: wsDir, bgmLaneId: "ln_bgm", duckDb: -12 });

  // Scaffold & mount reactive `counter` composition that counts to 99.4 when "doksan dokuz" is spoken!
  const compDir = path.join(wsDir, "compositions/reactive_stat");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    compositionId: "main",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 3200,
    preset: "counter",
    props: {
      headline: "DOĞRULUK ORANI",
      phrase: "doksan dokuz",
      target: 99.4,
      accent: "#38BDF8",
    },
    transparent: true,
  });

  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    explicitId: "cue_stat",
    atMs: 1000,
    durationMs: 3200,
    composition: {
      composition_dir: "compositions/reactive_stat",
      entry_html: "index.html",
      props: {
        headline: "DOĞRULUK ORANI",
        phrase: "doksan dokuz",
        target: 99.4,
        accent: "#38BDF8",
      },
      transparent: true,
      mode: "overlay_alpha",
    },
  });

  const ver = runWorkspaceVerification(wsDir);
  assert.equal(ver.ok, true, `Expected 0 verification errors, got: ${JSON.stringify(ver.diagnostics)}`);

  const compPrev = previewAndCheckComposition({
    workspaceDir: wsDir,
    cueId: "cue_stat",
    atSeconds: [0.9, 2.2],
  });
  assert.equal(compPrev.ok, true);
  assert.equal(compPrev.alpha_gate.passed, true);

  const tlOut = captureMonitorTimeline({ workspaceDir: wsDir });
  assert.equal(tlOut.ok, true);

  const frameOut = captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 3200,
    showBoxes: true,
  });
  assert.equal(frameOut.ok, true);

  const renderOut = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "draft_480p",
  });
  assert.equal(renderOut.ok, true);
  assert.ok(fs.existsSync(renderOut.output_path) && renderOut.size_bytes > 5000);
});
