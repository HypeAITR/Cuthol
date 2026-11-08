/**
 * Cleanup result visibility: preserved untranscribed spans, the 150 ms spine-clip
 * boundary, image-only tails, and distant repetition grouping.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { formatEnvelopeCompact } from "../mcp/mcp_format.js";
import { appendSpineClip } from "../sequence/spine.js";
import { cleanupClipDialogue, DialogueCleanupResult } from "../speech/cleanup.js";
import { RepetitionRestartCandidate } from "../speech/repetitions.js";
import { TranscriptDocument } from "../speech/providers.js";
import { verifySequence } from "../verify/gates.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/cleanup_visibility");

interface PreservedSpan {
  clip_id: string;
  source_start_ms: number;
  source_end_ms: number;
  duration_ms: number;
  max_dbfs: number;
  near_candidate_id?: string;
}

interface TailCandidate {
  id: string;
  kind: string;
  clip_id: string;
  asset_handle?: string;
  source_start_ms: number;
  source_end_ms: number;
  duration_ms: number;
}

type CleanupView = DialogueCleanupResult & {
  preserved_untranscribed?: PreservedSpan[];
  distant_repetition_candidates?: Array<RepetitionRestartCandidate & { gap_ms?: number }>;
  tail_without_audio_candidates?: TailCandidate[];
};

function view(result: DialogueCleanupResult): CleanupView {
  return result as CleanupView;
}

function gapOf(candidate: RepetitionRestartCandidate): number | undefined {
  return (candidate as RepetitionRestartCandidate & { gap_ms?: number }).gap_ms;
}

function writeToneMedia(mediaFile: string, durationSec: number, silence: boolean): void {
  const expr = silence ? "0" : "0.22*sin(2*PI*220*t)";
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
      `aevalsrc='${expr}':s=16000:d=${durationSec}`,
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

function word(
  text: string,
  start: number,
  end: number,
  punctuated = text
): TranscriptDocument["words"][number] {
  return {
    word: text,
    punctuated_word: punctuated,
    source_start_ms: start,
    source_end_ms: end,
    confidence: 0.99,
    is_filler: false,
    is_repetition: false,
  };
}

test("preserved untranscribed spans are listed with a nearby candidate id", () => {
  const wsDir = path.join(TEST_ROOT, "ws_preserved");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Preserved Spans", aspect: "16:9", fps: 30 });

  const mediaFile = path.join(wsDir, "preserved.mp4");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#0F172A:s=320x180:r=30:d=10",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='if(between(t,1.50,2.20)+between(t,8.00,8.50)+between(t,2.40,3.90),0.22*sin(2*PI*220*t),0)':s=16000:d=10",
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

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 10000 });

  const vid = loadSequence(wsDir).sequence.library[0];
  const ledger = new MediaLedger(paths.ledgerFile);
  const doc: TranscriptDocument = {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: 10000,
    text: "model eğitimi model eğitimi",
    words: [
      word("model", 2400, 2700),
      word("eğitimi", 2710, 3100),
      word("model", 3200, 3500),
      word("eğitimi", 3510, 3900, "eğitimi."),
      word("bugün", 8600, 8900, "Bugün"),
      word("yani", 8920, 9200),
      word("bitti", 9220, 9600, "bitti."),
    ],
    disfluencies: [
      { kind: "pause", source_start_ms: 0, source_end_ms: 2400, duration_ms: 2400, label: "<pause 2400ms>" },
      { kind: "pause", source_start_ms: 3900, source_end_ms: 8600, duration_ms: 4700, label: "<pause 4700ms>" },
    ],
  };
  ledger.setTranscript(vid.digest_sha256, "tr", doc);
  ledger.setTranscript(vid.digest_sha256, "latest", doc);
  ledger.close();

  const dry = view(cleanupClipDialogue({ workspaceDir: wsDir, allSpine: true, dryRun: true }));
  const preserved = dry.preserved_untranscribed ?? [];
  assert.ok(preserved.length >= 2, `Expected preserved spans, got ${JSON.stringify(preserved)}`);

  const near = preserved.find((span) => span.source_start_ms < 3000 && span.source_end_ms > 1500);
  assert.ok(near, `Near burst missing from ${JSON.stringify(preserved)}`);
  assert.equal(near.clip_id, "sp_01");
  assert.ok(near.duration_ms >= 120);
  assert.equal(typeof near.max_dbfs, "number");
  assert.match(near.near_candidate_id ?? "", /^rr_/);

  const far = preserved.find((span) => span.source_start_ms >= 7000);
  assert.ok(far, `Far burst missing from ${JSON.stringify(preserved)}`);
  assert.equal(far.near_candidate_id, undefined);

  const filler = dry.review_candidates.find((candidate) => candidate.word === "yani");
  assert.ok(filler, "Expected the fluent yani review candidate");
  const selected = view(
    cleanupClipDialogue({
      workspaceDir: wsDir,
      allSpine: true,
      dryRun: true,
      cutCandidates: [filler.id],
    })
  );
  const farSelected = (selected.preserved_untranscribed ?? []).find((span) => span.source_start_ms >= 7000);
  assert.ok(farSelected, "Far burst missing after selecting the filler");
  assert.equal(farSelected.near_candidate_id, filler.id);

  const cutsBefore = dry.cuts_count;
  const savedBefore = dry.saved_source_ms;
  assert.equal(selected.cuts_count >= cutsBefore, true);
  assert.equal(typeof savedBefore, "number");
});

test("G309 flags a 150 ms spine clip and a cached short speech fragment is INFO", () => {
  const speechDir = path.join(TEST_ROOT, "ws_short_speech");
  fs.rmSync(speechDir, { recursive: true, force: true });
  initWorkspace({ dir: speechDir, title: "Short Speech", aspect: "16:9", fps: 30 });
  const speechFile = path.join(speechDir, "tone.mp4");
  writeToneMedia(speechFile, 1, false);
  ingestAssetsIntoWorkspace({ workspaceDir: speechDir, filePaths: [speechFile] });
  appendSpineClip({ workspaceDir: speechDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 150 });
  appendSpineClip({ workspaceDir: speechDir, assetHandle: "vid_01", sourceInMs: 150, sourceOutMs: 370 });
  appendSpineClip({ workspaceDir: speechDir, assetHandle: "vid_01", sourceInMs: 370, sourceOutMs: 670 });

  const beforeClips = loadSequence(speechDir).sequence.spine.clips;
  assert.deepEqual(
    beforeClips.map((clip) => clip.duration_ms),
    [150, 220, 300]
  );

  const beforeLoaded = loadSequence(speechDir);
  const before = verifySequence(beforeLoaded.sequence, beforeLoaded.paths);
  assert.ok(
    before.diagnostics.some((d) => d.code === "CUTHOL-G309" && d.subject_id === "sp_01"),
    `150 ms clip must raise G309, got ${JSON.stringify(before.diagnostics)}`
  );
  assert.equal(
    before.diagnostics.some((d) => d.code === "CUTHOL-G312"),
    false,
    "Short-speech INFO must stay quiet until an acoustic profile is cached"
  );

  cleanupClipDialogue({ workspaceDir: speechDir, allSpine: true, dryRun: true });
  const afterLoaded = loadSequence(speechDir);
  const after = verifySequence(afterLoaded.sequence, afterLoaded.paths);
  const fragment = after.diagnostics.find((d) => d.code === "CUTHOL-G312" && d.subject_id === "sp_02");
  assert.ok(fragment, `Expected G312 on the 220 ms clip, got ${JSON.stringify(after.diagnostics)}`);
  assert.equal(fragment.severity, "INFO");
  assert.match(fragment.what, /short speech fragment, possibly a restart leftover/);
  assert.equal(
    after.diagnostics.some((d) => d.code === "CUTHOL-G312" && d.subject_id === "sp_03"),
    false,
    "A 300 ms clip is outside the short-speech window"
  );
  assert.equal(
    after.diagnostics.some((d) => d.code === "CUTHOL-G309" && d.subject_id === "sp_02"),
    false
  );

  const silenceDir = path.join(TEST_ROOT, "ws_short_silence");
  fs.rmSync(silenceDir, { recursive: true, force: true });
  initWorkspace({ dir: silenceDir, title: "Short Silence", aspect: "16:9", fps: 30 });
  const silenceFile = path.join(silenceDir, "silence.mp4");
  writeToneMedia(silenceFile, 1, true);
  ingestAssetsIntoWorkspace({ workspaceDir: silenceDir, filePaths: [silenceFile] });
  appendSpineClip({ workspaceDir: silenceDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 220 });
  cleanupClipDialogue({ workspaceDir: silenceDir, allSpine: true, dryRun: true });
  const silentLoaded = loadSequence(silenceDir);
  const silent = verifySequence(silentLoaded.sequence, silentLoaded.paths);
  assert.equal(
    silent.diagnostics.some((d) => d.code === "CUTHOL-G312"),
    false,
    `Silence must not raise G312, got ${JSON.stringify(silent.diagnostics)}`
  );
});

test("an image-only tail after the audio stream is a review candidate and is not cut by default", () => {
  const wsDir = path.join(TEST_ROOT, "ws_tail");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Audio Tail", aspect: "16:9", fps: 30 });
  const mediaFile = path.join(wsDir, "tail.mov");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#111111:s=320x180:r=30:d=2",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='0.2*sin(2*PI*220*t)':s=16000:d=1.6",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "pcm_s16le",
      mediaFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  const probed = loadSequence(wsDir).sequence.library[0].probe.duration_ms;
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: probed });

  const vid = loadSequence(wsDir).sequence.library[0];
  const ledger = new MediaLedger(paths.ledgerFile);
  const doc: TranscriptDocument = {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: probed,
    text: "merhaba",
    words: [word("merhaba", 200, 700, "Merhaba.")],
    disfluencies: [],
  };
  ledger.setTranscript(vid.digest_sha256, "tr", doc);
  ledger.setTranscript(vid.digest_sha256, "latest", doc);
  ledger.close();

  const dry = view(cleanupClipDialogue({ workspaceDir: wsDir, allSpine: true, dryRun: true }));
  const tails = dry.tail_without_audio_candidates ?? [];
  assert.equal(tails.length, 1, `Expected one tail candidate, got ${JSON.stringify(tails)}`);
  const tail = tails[0];
  assert.equal(tail.kind, "tail_without_audio");
  assert.equal(tail.clip_id, "sp_01");
  assert.ok(tail.duration_ms >= Math.round(1000 / 30), `Tail ${tail.duration_ms}ms is shorter than one frame`);
  assert.ok(tail.source_start_ms >= 1400 && tail.source_start_ms <= 1700, JSON.stringify(tail));
  assert.equal(
    dry.cuts.some((cut) => cut.candidate_id === tail.id || (cut.kind as string) === "tail_without_audio"),
    false,
    "The tail must not be cut until it is selected"
  );

  const selected = view(
    cleanupClipDialogue({
      workspaceDir: wsDir,
      allSpine: true,
      dryRun: true,
      cutCandidates: [tail.id],
    })
  );
  assert.ok(
    selected.cuts.some((cut) => cut.candidate_id === tail.id),
    `Selecting the tail did not plan a cut: ${JSON.stringify(selected.cuts.map((cut) => ({ id: cut.candidate_id, kind: cut.kind, padded: [cut.padded_source_start_ms, cut.padded_source_end_ms] })))}`
  );
  assert.equal(dry.cuts_count, selected.cuts_count - 1);
});

test("repetition candidates carry gap_ms and gaps above 8s move to the distant list", () => {
  const wsDir = path.join(TEST_ROOT, "ws_distant");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Distant Repeats", aspect: "16:9", fps: 30 });
  const mediaFile = path.join(wsDir, "repeats.mp4");
  writeToneMedia(mediaFile, 16, false);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 16000 });

  const between = ["kalem", "defter", "masa", "sandalye", "pencere", "bahçe", "sokak", "cadde"];
  const words = [
    word("model", 200, 450),
    word("eğitimi", 460, 900),
    word("model", 1100, 1350),
    word("eğitimi", 1360, 1800, "eğitimi."),
    word("yapay", 2500, 2800),
    word("zeka", 2810, 3100),
    ...between.map((token, index) => word(token, 4000 + index * 1100, 4400 + index * 1100)),
    word("yapay", 14000, 14300),
    word("zeka", 14310, 14600, "zeka."),
  ];
  const vid = loadSequence(wsDir).sequence.library[0];
  const ledger = new MediaLedger(paths.ledgerFile);
  const doc: TranscriptDocument = {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: 16000,
    text: words.map((entry) => entry.word).join(" "),
    words,
    disfluencies: [],
  };
  ledger.setTranscript(vid.digest_sha256, "tr", doc);
  ledger.setTranscript(vid.digest_sha256, "latest", doc);
  ledger.close();

  const dry = view(cleanupClipDialogue({ workspaceDir: wsDir, allSpine: true, dryRun: true }));
  const near = dry.repetition_candidates.find((candidate) => candidate.matched_phrase.includes("model"));
  assert.ok(near, `Close repeat missing: ${JSON.stringify(dry.repetition_candidates.map((c) => c.matched_phrase))}`);
  assert.equal(typeof gapOf(near), "number");
  assert.ok((gapOf(near) ?? 99999) <= 8000, `Close gap_ms=${gapOf(near)}`);

  const distant = dry.distant_repetition_candidates ?? [];
  const far = distant.find((candidate) => candidate.matched_phrase.includes("yapay"));
  assert.ok(
    far,
    `Distant repeat missing. near=${JSON.stringify(dry.repetition_candidates.map((c) => ({ phrase: c.matched_phrase, gap: gapOf(c) })))} distant=${JSON.stringify(distant.map((c) => ({ phrase: c.matched_phrase, gap: c.gap_ms })))}`
  );
  assert.ok((far.gap_ms ?? 0) > 8000, `Expected gap_ms > 8000, got ${far.gap_ms}`);
  assert.match(far.id, /^rr_/);
  assert.equal(
    dry.repetition_candidates.some((candidate) => candidate.id === far.id),
    false,
    "A distant candidate must leave the normal list"
  );

  const selected = cleanupClipDialogue({
    workspaceDir: wsDir,
    allSpine: true,
    dryRun: true,
    cutCandidates: [far.id],
  });
  assert.ok(
    selected.cuts.some((cut) => cut.candidate_id === far.id),
    "A distant candidate must stay selectable via cut_candidates"
  );
});

test("compact cleanup text keeps preserved spans and distant repeats outside the page", () => {
  const preserved = Array.from({ length: 12 }, (_, index) => ({
    clip_id: "sp_01",
    source_start_ms: index * 1000,
    source_end_ms: index * 1000 + 400,
    duration_ms: 400,
    max_dbfs: -20,
    ...(index === 0 ? { near_candidate_id: "rr_vid_01_100_800" } : {}),
  }));
  const formatted = formatEnvelopeCompact({
    command: "speech.cleanup",
    values: { dry_run: true, cursor: "15", limit: 2 },
    envelope: {
      ok: true,
      dry_run: true,
      command: "speech.cleanup",
      clip_id: "sp_01",
      cuts_count: 0,
      cuts: [],
      saved_source_ms: 0,
      saved_sequence_ms: 0,
      review_candidates: [],
      repetition_candidates: [
        {
          id: "rr_vid_01_100_800",
          kind: "phrase_repeat",
          matched_phrase: "yakin tekrar",
          suggested_cut_start_ms: 100,
          suggested_cut_end_ms: 400,
          suggested_cut_duration_ms: 300,
          suggested_keep_attempt: 2,
          gap_ms: 200,
          context: "near",
        },
      ],
      distant_repetition_candidates: [
        {
          id: "rr_vid_01_1000_20000",
          kind: "phrase_repeat",
          matched_phrase: "uzak tekrar",
          suggested_cut_start_ms: 1000,
          suggested_cut_end_ms: 1800,
          suggested_cut_duration_ms: 800,
          suggested_keep_attempt: 2,
          gap_ms: 12000,
          context: "far",
        },
      ],
      preserved_untranscribed: preserved,
      tail_without_audio_candidates: [
        {
          id: "ta_vid_01_1600_2000",
          kind: "tail_without_audio",
          clip_id: "sp_01",
          source_start_ms: 1600,
          source_end_ms: 2000,
          duration_ms: 400,
        },
      ],
      decision_trace: {
        summary: { by_reason: { TOO_SHORT: 20 }, candidates: 20, accepted: 0, rejected: 20 },
        decisions: Array.from({ length: 20 }, (_, index) => ({
          id: `miss_${index}`,
          span: [index * 10, index * 10 + 5],
          action: "rejected",
          reason_code: "TOO_SHORT",
        })),
      },
    },
  });

  const text = formatted.text;
  assert.match(text, /16\.\.17 of 20/);
  assert.match(text, /Distant repetition \/ restart candidates \(1 candidate/);
  assert.match(text, /rr_vid_01_1000_20000/);
  assert.match(text, /gap=12000ms/);
  assert.match(text, /gap=200ms/);
  assert.match(text, /Preserved untranscribed audio \(showing 10 of 12\)/);
  assert.match(text, /sp_01 0\.\.400ms \(400ms, max=-20dBFS, near=rr_vid_01_100_800\)/);
  assert.match(text, /sp_01 9000\.\.9400ms/);
  assert.doesNotMatch(text, /10000\.\.10400ms/);
  assert.match(text, /tail_without_audio/);
  assert.match(text, /ta_vid_01_1600_2000/);
});
