/**
 * speech cleanup on an audio lane cue uses the same cut planner as a spine clip.
 * The same synthetic take is a voiceover cue in one project and a black-video
 * spine clip in another. Dry-run source ranges must match. Applying the cue
 * cuts shortens that cue in one revision, shifts word times, and undoes cleanly.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadSequence, initWorkspace, resolveWorkspacePaths } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { buildCliArgv, findActionSpec, validateActionArgs } from "../mcp/catalog.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip, projectTranscriptAcrossSequence } from "../sequence/spine.js";
import { annotateWordsAndDisfluencies, TranscriptDocument } from "../speech/providers.js";
import { commitVerifiedMutation } from "../verify/gates.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/cleanup_audio_cue");
const CLI = path.resolve(process.cwd(), "dist/cli.js");
const SPEECH_SEC = 8;

function ffmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function extractPcm(file: string): Buffer {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-vn",
      "-af",
      "aresample=async=1:first_pts=0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0, proc.stderr?.toString() ?? "pcm extract failed");
  return proc.stdout;
}

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_ENCODER: "x264" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: proc.status ?? 1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

function parseEnvelope(stdout: string, stderr: string): Record<string, unknown> {
  for (const text of [stdout, stderr]) {
    const trimmed = text.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      // try the other stream
    }
  }
  throw new Error(`no JSON envelope\nstdout=${stdout.slice(0, 1200)}\nstderr=${stderr.slice(0, 1200)}`);
}

function diagnosticCode(env: Record<string, unknown>): string {
  const diagnostic = env.diagnostic as { code?: string } | undefined;
  return diagnostic?.code ?? "";
}

function probeMs(wsDir: string, handle: string): number {
  const item = loadSequence(wsDir).sequence.library.find((asset) => asset.handle === handle);
  assert.ok(item, handle);
  return item.probe.duration_ms;
}

function seedTranscript(wsDir: string, handle: string, doc: TranscriptDocument): void {
  const { paths, sequence } = loadSequence(wsDir);
  const item = sequence.library.find((asset) => asset.handle === handle);
  assert.ok(item, handle);
  const ledger = new MediaLedger(paths.ledgerFile);
  ledger.setTranscript(item.digest_sha256, "tr", doc);
  ledger.setTranscript(item.digest_sha256, "local:tr", doc);
  ledger.setTranscript(item.digest_sha256, "latest", doc);
  ledger.close();
}

function laneAndSpine(wsDir: string): { lanes: unknown; spine: unknown; revision: number } {
  const sequence = loadSequence(wsDir).sequence;
  return {
    lanes: structuredClone(sequence.lanes),
    spine: structuredClone(sequence.spine),
    revision: sequence.meta.revision,
  };
}

function readJournal(wsDir: string): {
  count: number;
  cursor: number;
  operations: string[];
  revisions: number[];
  snapshots: string[];
  snapshotFiles: string[];
} {
  const paths = resolveWorkspacePaths(wsDir);
  const manifest = JSON.parse(fs.readFileSync(paths.journalIndexFile, "utf8")) as {
    cursor_revision: number;
    entries: Array<{ revision: number; operation: string; snapshot_file: string }>;
  };
  return {
    count: manifest.entries.length,
    cursor: manifest.cursor_revision,
    operations: manifest.entries.map((entry) => entry.operation),
    revisions: manifest.entries.map((entry) => entry.revision),
    snapshots: fs
      .readdirSync(paths.journalDir)
      .filter((name) => name.endsWith(".json"))
      .sort(),
    snapshotFiles: manifest.entries.map((entry) => entry.snapshot_file).sort(),
  };
}

function sequenceFileBytes(wsDir: string): Buffer {
  return fs.readFileSync(resolveWorkspacePaths(wsDir).sequenceFile);
}

interface CutLike {
  kind?: string;
  raw_source_start_ms?: number;
  raw_source_end_ms?: number;
  padded_source_start_ms?: number;
  padded_source_end_ms?: number;
}

function cutSignature(cuts: CutLike[]): string[] {
  return [...cuts]
    .map((cut) =>
      [
        cut.kind,
        cut.raw_source_start_ms,
        cut.raw_source_end_ms,
        cut.padded_source_start_ms,
        cut.padded_source_end_ms,
      ].join(":")
    )
    .sort();
}

interface RepLike {
  kind?: string;
  matched_phrase?: string;
  source_start_ms?: number;
  source_end_ms?: number;
  gap_ms?: number;
  suggested_cut_start_ms?: number;
  suggested_cut_end_ms?: number;
  attempts?: Array<{ source_start_ms?: number; source_end_ms?: number; suggested_action?: string }>;
}

function repetitionSignature(candidates: RepLike[]): string[] {
  return [...candidates]
    .map((candidate) => {
      const attempts = (candidate.attempts ?? [])
        .map((attempt) => `${attempt.source_start_ms}-${attempt.source_end_ms}:${attempt.suggested_action}`)
        .join(",");
      return [
        candidate.kind,
        candidate.matched_phrase,
        candidate.source_start_ms,
        candidate.source_end_ms,
        candidate.gap_ms,
        candidate.suggested_cut_start_ms,
        candidate.suggested_cut_end_ms,
        attempts,
      ].join(":");
    })
    .sort();
}

test("audio cue cleanup matches a wrapped spine clip, then applies and undoes", { timeout: 180_000 }, () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  const cleanupSpec = findActionSpec("speech", "cleanup");
  assert.ok(cleanupSpec);
  const cueArgs = validateActionArgs(cleanupSpec, { cue: "cue_01", across: "lane", dry_run: true });
  assert.equal(cueArgs.issues.length, 0, JSON.stringify(cueArgs.issues));
  const cueArgv = buildCliArgv(cleanupSpec, cueArgs.values, TEST_ROOT);
  assert.ok(cueArgv.includes("--cue=cue_01"));
  assert.ok(cueArgv.includes("--across=lane"));
  assert.ok(cueArgv.includes("--dry-run=true"));
  const cuesArgs = validateActionArgs(cleanupSpec, { cues: ["cue_01", "cue_02"] });
  assert.equal(cuesArgs.issues.length, 0, JSON.stringify(cuesArgs.issues));
  const cuesArgv = buildCliArgv(cleanupSpec, cuesArgs.values, TEST_ROOT);
  assert.ok(cuesArgv.includes("--cues=cue_01,cue_02"));

  const wav = path.join(TEST_ROOT, "speech.wav");
  const mov = path.join(TEST_ROOT, "speech.mov");
  const beep = path.join(TEST_ROOT, "beep.wav");
  const speechExpr = [
    "0.4*sin(2*PI*220*t)*between(t,0.2,0.7)",
    "0.4*sin(2*PI*180*t)*between(t,1.0,1.4)",
    "0.4*sin(2*PI*240*t)*between(t,2.5,3.0)",
    "0.4*sin(2*PI*240*t)*between(t,4.2,4.7)",
    "0.4*sin(2*PI*260*t)*between(t,5.0,5.6)",
  ].join("+");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='${speechExpr}':s=16000:d=${SPEECH_SEC}`,
    "-c:a",
    "pcm_s16le",
    wav,
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=320x180:r=30:d=${SPEECH_SEC}`,
    "-i",
    wav,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    "-muxpreload",
    "0",
    "-muxdelay",
    "0",
    mov,
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=16000:duration=0.5",
    "-c:a",
    "pcm_s16le",
    beep,
  ]);

  const wavPcm = extractPcm(wav);
  const movPcm = extractPcm(mov);
  const sharedBytes = Math.min(wavPcm.length, movPcm.length);
  assert.ok(sharedBytes >= 16000 * 7, `pcm bytes wav=${wavPcm.length} mov=${movPcm.length}`);
  const wavHead = wavPcm.subarray(0, sharedBytes);
  const movHead = movPcm.subarray(0, sharedBytes);
  assert.ok(wavHead.equals(movHead), "wrapped video audio must match the wav samples");

  const wsA = path.join(TEST_ROOT, "cue");
  const wsB = path.join(TEST_ROOT, "spine");
  initWorkspace({ dir: wsA, title: "cue", aspect: "16:9", fps: 30 });
  initWorkspace({ dir: wsB, title: "spine", aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsA, filePaths: [wav, beep] });
  ingestAssetsIntoWorkspace({ workspaceDir: wsB, filePaths: [mov] });

  const wavMs = probeMs(wsA, "aud_01");
  const movMs = probeMs(wsB, "vid_01");
  const beepMs = probeMs(wsA, "aud_02");
  assert.ok(wavMs >= 7800 && movMs >= 7800, `durations wav=${wavMs} mov=${movMs}`);
  const span = Math.min(wavMs, movMs);
  assert.ok(beepMs >= 400, `beep ${beepMs}`);

  const annotated = annotateWordsAndDisfluencies(
    [
      { word: "merhaba", source_start_ms: 200, source_end_ms: 700 },
      { word: "ıı", source_start_ms: 1000, source_end_ms: 1400 },
      { word: "bugün", source_start_ms: 2500, source_end_ms: 3000 },
      { word: "bugün", source_start_ms: 4200, source_end_ms: 4700 },
      { word: "bitti", source_start_ms: 5000, source_end_ms: 5600 },
    ],
    span,
    400
  );
  const doc: TranscriptDocument = {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: span,
    text: annotated.words.map((word) => word.word).join(" "),
    words: annotated.words,
    disfluencies: annotated.disfluencies,
  };
  assert.ok(doc.disfluencies.some((spanItem) => spanItem.kind === "filler"));
  assert.ok(doc.disfluencies.some((spanItem) => spanItem.kind === "pause"));

  addLaneCue({
    workspaceDir: wsA,
    laneId: "ln_vo",
    kind: "voiceover",
    explicitId: "cue_01",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: span,
    sourceInMs: 0,
    sourceOutMs: span,
  });
  addLaneCue({
    workspaceDir: wsA,
    laneId: "ln_vo",
    kind: "sfx",
    explicitId: "cue_tail",
    assetHandle: "aud_02",
    atMs: span,
    durationMs: beepMs,
    sourceInMs: 0,
    sourceOutMs: beepMs,
  });
  addLaneCue({
    workspaceDir: wsA,
    laneId: "ln_sfx",
    kind: "sfx",
    explicitId: "cue_sfx",
    assetHandle: "aud_02",
    anchor: { ref: "cue_01", offset_ms: 1500 },
    atMs: 0,
    durationMs: Math.min(400, beepMs),
    sourceInMs: 0,
    sourceOutMs: Math.min(400, beepMs),
  });
  addLaneCue({
    workspaceDir: wsA,
    laneId: "ln_titles",
    kind: "title",
    explicitId: "cue_title",
    text: "Baslik",
    atMs: 100,
    durationMs: 2000,
  });
  appendSpineClip({
    workspaceDir: wsB,
    assetHandle: "vid_01",
    explicitId: "sp_01",
    sourceInMs: 0,
    sourceOutMs: span,
  });
  seedTranscript(wsA, "aud_01", doc);
  seedTranscript(wsB, "vid_01", doc);

  const dryA = runCli(["speech", "cleanup", "--cue", "cue_01", "--dry-run", "--dir", wsA]);
  const dryB = runCli(["speech", "cleanup", "--clip", "sp_01", "--dry-run", "--dir", wsB]);
  assert.equal(dryA.status, 0, dryA.stderr.slice(0, 1500));
  assert.equal(dryB.status, 0, dryB.stderr.slice(0, 1500));
  const envA = parseEnvelope(dryA.stdout, dryA.stderr);
  const envB = parseEnvelope(dryB.stdout, dryB.stderr);
  const cutsA = envA.cuts as CutLike[];
  const cutsB = envB.cuts as CutLike[];
  assert.ok(cutsA.length > 0, "cue dry-run produced no cuts");
  assert.deepEqual(cutSignature(cutsA), cutSignature(cutsB));
  assert.ok(cutsA.some((cut) => cut.kind === "filler"));
  assert.ok(cutsA.some((cut) => cut.kind === "pause"));
  const repsA = envA.repetition_candidates as RepLike[];
  const repsB = envB.repetition_candidates as RepLike[];
  assert.deepEqual(repetitionSignature(repsA), repetitionSignature(repsB));
  assert.ok(repsA.some((candidate) => candidate.kind === "sentence_restart"));
  assert.deepEqual(envA.tail_without_audio_candidates, []);
  assert.deepEqual(envB.tail_without_audio_candidates, []);
  assert.equal(envA.cue_id, "cue_01");
  assert.equal(envA.across, "lane");
  assert.equal(envB.cue_id, undefined);

  const revBeforeErrors = loadSequence(wsA).sequence.meta.revision;
  const titleRun = runCli(["speech", "cleanup", "--cue", "cue_title", "--dry-run", "--dir", wsA]);
  assert.notEqual(titleRun.status, 0);
  assert.equal(diagnosticCode(parseEnvelope(titleRun.stdout, titleRun.stderr)), "CUTHOL-G313");
  const missingRun = runCli(["speech", "cleanup", "--cue", "cue_tail", "--dry-run", "--dir", wsA]);
  assert.notEqual(missingRun.status, 0);
  assert.equal(diagnosticCode(parseEnvelope(missingRun.stdout, missingRun.stderr)), "CUTHOL-SYS06");
  assert.equal(loadSequence(wsA).sequence.meta.revision, revBeforeErrors);

  const before = laneAndSpine(wsA);
  const tailBefore = loadSequence(wsA).sequence.lanes
    .flatMap((lane) => lane.cues)
    .find((cue) => cue.id === "cue_tail");
  const titleBefore = loadSequence(wsA).sequence.lanes
    .flatMap((lane) => lane.cues)
    .find((cue) => cue.id === "cue_title");
  assert.ok(tailBefore && titleBefore);
  const wordsBefore = projectTranscriptAcrossSequence(loadSequence(wsA).sequence, "aud_01", doc.words);
  const bittiBefore = wordsBefore.find((word) => word.word === "bitti" && !word.excised);
  const fillerBefore = wordsBefore.find((word) => word.word === "ıı");
  assert.ok(bittiBefore?.sequence_start_ms != null);
  assert.equal(fillerBefore?.excised, false);

  const applied = runCli(["speech", "cleanup", "--cue", "cue_01", "--dir", wsA]);
  assert.equal(applied.status, 0, applied.stderr.slice(0, 1500));
  const envApplied = parseEnvelope(applied.stdout, applied.stderr);
  const savedSource = envApplied.saved_source_ms as number;
  const savedSequence = envApplied.saved_sequence_ms as number;
  assert.ok(savedSource > 0);
  assert.equal(loadSequence(wsA).sequence.meta.revision, before.revision + 1);

  const afterSeq = loadSequence(wsA).sequence;
  const voPieces = afterSeq.lanes
    .find((lane) => lane.id === "ln_vo")!
    .cues.filter((cue) => cue.asset_handle === "aud_01");
  assert.ok(voPieces.length > 1);
  const pieceSum = voPieces.reduce((sum, cue) => sum + cue.duration_ms, 0);
  assert.equal(pieceSum, span - savedSource);
  const tailAfter = afterSeq.lanes.flatMap((lane) => lane.cues).find((cue) => cue.id === "cue_tail");
  const titleAfter = afterSeq.lanes.flatMap((lane) => lane.cues).find((cue) => cue.id === "cue_title");
  const sfxAfter = afterSeq.lanes.flatMap((lane) => lane.cues).find((cue) => cue.id === "cue_sfx");
  assert.ok(tailAfter && titleAfter && sfxAfter);
  assert.equal(tailAfter.at_ms, tailBefore.at_ms - savedSequence);
  assert.equal(titleAfter.at_ms, titleBefore.at_ms);
  assert.ok(voPieces.some((cue) => cue.id === sfxAfter.cue_anchor?.ref));
  assert.equal(
    sfxAfter.at_ms,
    voPieces.find((cue) => cue.id === sfxAfter.cue_anchor?.ref)!.at_ms + (sfxAfter.cue_anchor?.offset_ms ?? 0)
  );

  const wordsAfter = projectTranscriptAcrossSequence(afterSeq, "aud_01", doc.words);
  const fillerAfter = wordsAfter.find((word) => word.word === "ıı");
  const bittiAfter = wordsAfter.find((word) => word.word === "bitti" && !word.excised);
  assert.equal(fillerAfter?.excised, true);
  assert.equal(fillerAfter?.sequence_start_ms, null);
  assert.ok(bittiAfter?.sequence_start_ms != null);
  const removedBeforeBitti = (envApplied.cuts as CutLike[])
    .filter((cut) => (cut.padded_source_end_ms ?? 0) <= 5000)
    .reduce((sum, cut) => sum + ((cut.padded_source_end_ms ?? 0) - (cut.padded_source_start_ms ?? 0)), 0);
  assert.ok(removedBeforeBitti > 0);
  assert.equal(bittiAfter.sequence_start_ms, bittiBefore.sequence_start_ms! - removedBeforeBitti);

  const undone = runCli(["workspace", "journal", "undo", "--dir", wsA]);
  assert.equal(undone.status, 0, undone.stderr.slice(0, 1500));
  const restored = laneAndSpine(wsA);
  assert.equal(restored.revision, before.revision);
  assert.deepEqual(restored.lanes, before.lanes);
  assert.deepEqual(restored.spine, before.spine);

  const wsC = path.join(TEST_ROOT, "two");
  initWorkspace({ dir: wsC, title: "two", aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsC, filePaths: [wav] });
  const spanC = Math.min(span, probeMs(wsC, "aud_01"));
  addLaneCue({
    workspaceDir: wsC,
    laneId: "ln_vo",
    kind: "voiceover",
    explicitId: "cue_01",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: spanC,
    sourceInMs: 0,
    sourceOutMs: spanC,
  });
  addLaneCue({
    workspaceDir: wsC,
    laneId: "ln_sfx",
    kind: "sfx",
    explicitId: "cue_02",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: spanC,
    sourceInMs: 0,
    sourceOutMs: spanC,
  });
  const docC: TranscriptDocument = { ...doc, duration_ms: spanC };
  seedTranscript(wsC, "aud_01", docC);
  const beforeC = laneAndSpine(wsC);
  const journalBeforeC = readJournal(wsC);
  const two = runCli(["speech", "cleanup", "--cues", "cue_01,cue_02", "--dir", wsC]);
  assert.equal(two.status, 0, two.stderr.slice(0, 1500));
  const envTwo = parseEnvelope(two.stdout, two.stderr);
  assert.equal(loadSequence(wsC).sequence.meta.revision, beforeC.revision + 1);
  const journalAfterC = readJournal(wsC);
  assert.equal(journalAfterC.count, journalBeforeC.count + 1);
  assert.deepEqual(
    journalAfterC.operations.slice(0, journalBeforeC.count),
    journalBeforeC.operations
  );
  assert.equal(journalAfterC.operations[journalAfterC.count - 1], "speech.cleanup(2_cues)");
  assert.equal(journalAfterC.cursor, beforeC.revision + 1);
  assert.ok(journalAfterC.revisions.every((revision) => revision <= journalAfterC.cursor));
  assert.deepEqual(journalAfterC.snapshots, journalAfterC.snapshotFiles);
  assert.equal(envTwo.cue_id, "cue_01,cue_02");
  const savedTwo = envTwo.saved_source_ms as number;
  assert.ok(savedTwo > 0);
  const seqC = loadSequence(wsC).sequence;
  for (const laneId of ["ln_vo", "ln_sfx"]) {
    const pieces = seqC.lanes.find((lane) => lane.id === laneId)!.cues;
    assert.ok(pieces.length > 1, laneId);
    const sum = pieces.reduce((total, cue) => total + cue.duration_ms, 0);
    assert.equal(sum, spanC - savedTwo / 2);
  }
  const undoC = runCli(["workspace", "journal", "undo", "--dir", wsC]);
  assert.equal(undoC.status, 0, undoC.stderr.slice(0, 1500));
  const restoredC = laneAndSpine(wsC);
  assert.equal(restoredC.revision, beforeC.revision);
  assert.deepEqual(restoredC.lanes, beforeC.lanes);
  assert.deepEqual(restoredC.spine, beforeC.spine);
});

test("multi-cue cleanup leaves the project untouched when the second cue fails", { timeout: 180_000 }, () => {
  const root = path.resolve(process.cwd(), "test-workspace/cleanup_audio_cue_rollback");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const wav = path.join(root, "speech.wav");
  const speechExpr = [
    "0.4*sin(2*PI*220*t)*between(t,0.2,0.7)",
    "0.4*sin(2*PI*180*t)*between(t,1.0,1.4)",
    "0.4*sin(2*PI*240*t)*between(t,2.5,3.0)",
    "0.4*sin(2*PI*240*t)*between(t,4.2,4.7)",
    "0.4*sin(2*PI*260*t)*between(t,5.0,5.6)",
  ].join("+");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='${speechExpr}':s=16000:d=${SPEECH_SEC}`,
    "-c:a",
    "pcm_s16le",
    wav,
  ]);

  const ws = path.join(root, "proj");
  initWorkspace({ dir: ws, title: "rollback", aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: ws, filePaths: [wav] });
  const span = probeMs(ws, "aud_01");
  assert.ok(span >= 7800, `duration ${span}`);
  const annotated = annotateWordsAndDisfluencies(
    [
      { word: "merhaba", source_start_ms: 200, source_end_ms: 700 },
      { word: "ıı", source_start_ms: 1000, source_end_ms: 1400 },
      { word: "bugün", source_start_ms: 2500, source_end_ms: 3000 },
      { word: "bugün", source_start_ms: 4200, source_end_ms: 4700 },
      { word: "bitti", source_start_ms: 5000, source_end_ms: 5600 },
    ],
    span,
    400
  );
  const doc: TranscriptDocument = {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: span,
    text: annotated.words.map((word) => word.word).join(" "),
    words: annotated.words,
    disfluencies: annotated.disfluencies,
  };
  addLaneCue({
    workspaceDir: ws,
    laneId: "ln_vo",
    kind: "voiceover",
    explicitId: "cue_01",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: span,
    sourceInMs: 0,
    sourceOutMs: span,
  });
  addLaneCue({
    workspaceDir: ws,
    laneId: "ln_sfx",
    kind: "sfx",
    explicitId: "cue_02",
    assetHandle: "aud_01",
    atMs: span,
    durationMs: span,
    sourceInMs: 0,
    sourceOutMs: span,
  });
  seedTranscript(ws, "aud_01", doc);

  // cue_02's only bound word sits outside every source piece cue_01 can keep.
  // The first excise therefore drops cue_02, and the second excise fails.
  commitVerifiedMutation(ws, "test.bind-word", (seq) => {
    const cue = seq.lanes.flatMap((lane) => lane.cues).find((item) => item.id === "cue_02");
    assert.ok(cue);
    cue.typography = {
      text: "ara",
      words: [
        {
          word: "ara",
          source_start_ms: -5000,
          source_end_ms: -4000,
          sequence_start_ms: 0,
          sequence_end_ms: 100,
          clip_id: "cue_01",
          excised: false,
        },
      ],
      font_family: "Inter",
      font_size_px: 48,
      font_weight: 700,
      color_hex: "#FFFFFF",
      stroke_color_hex: "#000000",
      stroke_width_px: 2,
      box_color_hex: null,
      box_opacity: 0,
      align: "center",
      max_width_pct: 80,
    };
  });

  const dry = runCli(["speech", "cleanup", "--cues", "cue_01,cue_02", "--dry-run", "--dir", ws]);
  assert.equal(dry.status, 0, dry.stderr.slice(0, 1500));
  const dryCuts = parseEnvelope(dry.stdout, dry.stderr).cuts as Array<{ clip_id?: string }>;
  assert.ok(dryCuts.some((cut) => cut.clip_id === "cue_01"));
  assert.ok(dryCuts.some((cut) => cut.clip_id === "cue_02"));

  const bytesBefore = sequenceFileBytes(ws);
  const revisionBefore = loadSequence(ws).sequence.meta.revision;
  const journalBefore = readJournal(ws);
  const failed = runCli(["speech", "cleanup", "--cues", "cue_01,cue_02", "--dir", ws]);
  assert.notEqual(failed.status, 0);
  const diagnostic = parseEnvelope(failed.stdout, failed.stderr).diagnostic as {
    code?: string;
    subject_id?: string;
  };
  assert.equal(diagnostic.code, "CUTHOL-G101");
  assert.equal(diagnostic.subject_id, "cue_02");
  assert.equal(loadSequence(ws).sequence.meta.revision, revisionBefore);
  assert.ok(sequenceFileBytes(ws).equals(bytesBefore));
  const journalAfter = readJournal(ws);
  assert.equal(journalAfter.count, journalBefore.count);
  assert.deepEqual(journalAfter.operations, journalBefore.operations);
  assert.equal(journalAfter.cursor, journalBefore.cursor);
  assert.deepEqual(journalAfter.snapshots, journalBefore.snapshots);
});
