/**
 * (Speech Cleanup & Caption Accuracy)
 * (`src/test/speech_pauses_fillers.test.ts`).
 *
 * Covers:
 * 1. Recording-relative silence floor in `analyzeAssetWaveform` and word-safe acoustic pause fusion in `transcribeLibraryAsset`.
 * 2. `OVERLAPS_WORD` rejection in `cleanupClipDialogue` (`decision_trace`) + zero overlapping cuts on `t1`.
 * 3. Contextual filler gating ("şey", "yani", "hani", "acaba" only when pause-isolated) and preserving all unexcised words in captions.
 * 4. Project/transcript language-based CPS threshold (19 CPS for Turkish even on ASCII-only captions like "modelleri.", 17 CPS for English).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { queryLibraryAnalysis } from "../library/query.js";
import { analyzeAssetWaveform, measureAssetAcousticWindows } from "../library/waveform.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";
import { generateSequenceCaptions } from "../speech/captions.js";
import { cleanupClipDialogue } from "../speech/cleanup.js";
import { annotateWordsAndDisfluencies, TranscriptDocument } from "../speech/providers.js";
import { transcribeLibraryAsset } from "../speech/transcribe.js";
import { verifySequence } from "../verify/gates.js";
import { fixturePath } from "./fixtures.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/speech_pauses_fillers_tests");

test("1. Adaptive silence floor on quiet (-29 LUFS) recordings & word-safe acoustic pause fusion", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_adaptive_waveform");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Adaptive Silence Floor", aspect: "9:16", fps: 30 });

  // Synthesize a 4.5s quiet speech-level recording (~ -35 dBFS active tone with a real silence gap at 1.5..2.4s)
  const quietMedia = path.join(wsDir, "quiet_talk.mp4");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#0F172A:s=640x360:r=30:d=4.5",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='if(between(t,1.5,2.4),0.0001*sin(2*PI*200*t),0.018*sin(2*PI*240*t)+0.008*sin(2*PI*900*t))':s=16000:d=4.5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      quietMedia,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, `FFmpeg failed: ${ff.stderr}`);

  // Sidecar transcript where "diyeyim" is spoken during the quiet -35 dBFS region (2.5..3.1s)
  fs.writeFileSync(
    `${quietMedia}.transcript.json`,
    JSON.stringify({
      language: "tr",
      words: [
        { word: "şöyle", punctuated_word: "Şöyle", source_start_ms: 200, source_end_ms: 850 },
        { word: "bakalım", punctuated_word: "bakalım,", source_start_ms: 900, source_end_ms: 1480 },
        // Real acoustic silence at 1500..2400ms (900ms)
        { word: "diyeyim", punctuated_word: "diyeyim.", source_start_ms: 2450, source_end_ms: 3100 },
        { word: "tamam", punctuated_word: "Tamam.", source_start_ms: 3200, source_end_ms: 4100 },
      ],
    }),
    "utf8"
  );

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [quietMedia] });
  const wf = analyzeAssetWaveform({ workspaceDir: wsDir, handle: "vid_01", bins: 90 });

  // Quiet signal (~ -35 dBFS) must adapt silence_floor_dbfs well below fixed -38 dBFS
  assert.ok(
    typeof wf.silence_floor_dbfs === "number" && wf.silence_floor_dbfs < -45,
    `Expected adaptive silence_floor_dbfs < -45 dBFS on quiet track, got ${wf.silence_floor_dbfs}`
  );
  // Only the genuine 1500..2400ms silence gap should be detected, NOT the -35 dBFS speech regions
  assert.equal(wf.silence_intervals.length, 1, `Expected 1 silence interval, got ${JSON.stringify(wf.silence_intervals)}`);
  assert.ok(wf.silence_intervals[0].start_ms >= 1450 && wf.silence_intervals[0].end_ms <= 2450);

  const tr = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    provider: "local",
    language: "tr",
  });
  for (const d of tr.transcript.disfluencies) {
    if (d.kind !== "pause") continue;
    for (const w of tr.transcript.words) {
      const ov = Math.min(d.source_end_ms, w.source_end_ms) - Math.max(d.source_start_ms, w.source_start_ms);
      assert.ok(ov <= 0, `Pause ${d.label} [${d.source_start_ms}..${d.source_end_ms}] overlapped word ${w.word}`);
    }
  }
});

test("2. cleanupClipDialogue rejects word-overlapping pause candidates with OVERLAPS_WORD and passes t1", () => {
  const wsDir = path.join(TEST_ROOT, "ws_overlaps_word_trace");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "OVERLAPS_WORD Trace", aspect: "9:16", fps: 30 });

  const mediaFile = path.join(wsDir, "sample.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1E293B:s=640x360:r=30:d=5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=16000:duration=5",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    mediaFile,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4800 });

  const seq0 = loadSequence(wsDir).sequence;
  const vid01 = seq0.library[0];
  const ledger = new MediaLedger(paths.ledgerFile);
  const docWithFalseAcousticPause: TranscriptDocument = {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: 4800,
    text: "Şöyle diyeyim arkadaşlar kurgu tamam.",
    words: [
      { word: "şöyle", punctuated_word: "Şöyle", source_start_ms: 200, source_end_ms: 600, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "diyeyim", punctuated_word: "diyeyim.", source_start_ms: 680, source_end_ms: 1180, confidence: 0.99, is_filler: false, is_repetition: false },
      // Real pause 1180..2100ms (920ms)
      { word: "arkadaşlar", punctuated_word: "arkadaşlar", source_start_ms: 2100, source_end_ms: 2800, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "kurgu", punctuated_word: "kurgu", source_start_ms: 2850, source_end_ms: 3400, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "tamam", punctuated_word: "tamam.", source_start_ms: 3450, source_end_ms: 4100, confidence: 0.99, is_filler: false, is_repetition: false },
    ],
    disfluencies: [
      // Bogus acoustic pause swallowing "diyeyim" (620..1250ms)
      { kind: "pause", source_start_ms: 620, source_end_ms: 1250, duration_ms: 630, label: "<acoustic_pause 630ms>" },
      // Genuine inter-word pause (1180..2100ms)
      { kind: "pause", source_start_ms: 1180, source_end_ms: 2100, duration_ms: 920, label: "<pause 920ms>" },
    ],
  };
  ledger.setTranscript(vid01.digest_sha256, "tr", docWithFalseAcousticPause);
  ledger.close();

  const cleanRes = cleanupClipDialogue({
    workspaceDir: wsDir,
    clipId: "sp_01",
    minPauseMs: 400,
    padMs: 75,
    dryRun: true,
  });

  assert.equal(cleanRes.cuts_count, 1, "Only the genuine inter-word pause must be cut");
  assert.equal(cleanRes.cuts[0].raw_source_start_ms, 1180);
  assert.equal(cleanRes.cuts[0].raw_source_end_ms, 2100);
  assert.equal(cleanRes.decision_trace.summary.by_reason.OVERLAPS_WORD, 1);
  const rejectedOverlap = cleanRes.decision_trace.decisions.find((d) => d.reason_code === "OVERLAPS_WORD");
  assert.ok(rejectedOverlap, "Expected OVERLAPS_WORD decision in decision_trace");
  assert.ok(String(rejectedOverlap.measured?.overlapping_words).includes("diyeyim."));

  // Also verify against t1 if present on disk (read-only dryRun + query)
  const reproT1Dir = fixturePath("t1");
  if (fs.existsSync(path.join(reproT1Dir, "cuthol.sequence.json"))) {
    const t1Clean = cleanupClipDialogue({
      workspaceDir: reproT1Dir,
      clipId: "sp_01",
      dryRun: true,
    });
    assert.ok(t1Clean.cuts_count >= 15, `Expected >= 15 acoustically verified pause cuts in t1, got ${t1Clean.cuts_count}`);
    assert.ok(t1Clean.saved_source_ms >= 25000, `Expected >= 25000ms saved in t1, got ${t1Clean.saved_source_ms}`);
    assert.ok(
      (t1Clean.decision_trace.summary.by_reason.UNTRANSCRIBED_AUDIO ?? 0) >= 1,
      `Expected >= 1 UNTRANSCRIBED_AUDIO decision in t1, got ${JSON.stringify(t1Clean.decision_trace.summary.by_reason)}`
    );
    assert.ok(
      (t1Clean.decision_trace.summary.by_reason.ACOUSTIC_GAP_TOO_SHORT ?? 0) >= 5,
      `Expected >= 5 ACOUSTIC_GAP_TOO_SHORT decisions in t1, got ${JSON.stringify(t1Clean.decision_trace.summary.by_reason)}`
    );

    const t1Words: Array<{ word: string; source_start_ms: number; source_end_ms: number }> = [];
    let cursor: string | null = "0";
    while (cursor !== null) {
      const q = queryLibraryAnalysis({
        workspaceDir: reproT1Dir,
        handle: "vid_01",
        kind: "transcript",
        limit: 100,
        maxTokens: 100000,
        cursor,
      });
      t1Words.push(
        ...(q.items as Array<{ word: string; source_start_ms: number; source_end_ms: number }>)
      );
      cursor = q.next_cursor ?? null;
    }

    for (const c of t1Clean.cuts) {
      if (c.kind === "filler" || c.kind === "repetition") continue;
      const hits = t1Words.filter(
        (w) =>
          Math.min(c.padded_source_end_ms, w.source_end_ms) -
            Math.max(c.padded_source_start_ms, w.source_start_ms) >
          0
      );
      assert.equal(
        hits.length,
        0,
        `Cut ${c.label} (${c.padded_source_start_ms}-${c.padded_source_end_ms}) overlapped words: ${JSON.stringify(hits)}`
      );
    }
  }
});

test("3. Contextual Turkish discourse words ('şey', 'yani', 'hani', 'acaba') & full unexcised caption fidelity", () => {
  // 3a. Fluent "şöyle bir şey var" and "yani sen" must NOT be marked as fillers, whereas pause-isolated "şey" and unconditional "ıı" ARE marked
  const annotated = annotateWordsAndDisfluencies(
    [
      { word: "şöyle", punctuated_word: "şöyle", source_start_ms: 100, source_end_ms: 400 },
      { word: "bir", punctuated_word: "bir", source_start_ms: 400, source_end_ms: 560 },
      { word: "şey", punctuated_word: "şey", source_start_ms: 560, source_end_ms: 720 },
      { word: "var", punctuated_word: "var.", source_start_ms: 720, source_end_ms: 1050 },
      { word: "yani", punctuated_word: "Yani", source_start_ms: 1050, source_end_ms: 1220 },
      { word: "sen", punctuated_word: "sen", source_start_ms: 1220, source_end_ms: 1450 },
      // Pause-isolated hesitation "şey" (200ms gap before, 450ms pause after)
      { word: "şey", punctuated_word: "şey", source_start_ms: 1650, source_end_ms: 1950 },
      // Unconditional filler "ıı" even with small gaps
      { word: "ıı", punctuated_word: "ıı", source_start_ms: 2400, source_end_ms: 2550 },
      { word: "tamam", punctuated_word: "tamam.", source_start_ms: 2560, source_end_ms: 3000 },
    ],
    3200,
    400
  );

  assert.equal(annotated.words[2].word, "şey");
  assert.equal(annotated.words[2].is_filler, false, "Fluent 'şöyle bir şey var' must not flag 'şey' as filler");
  assert.equal(annotated.words[4].word, "yani");
  assert.equal(annotated.words[4].is_filler, false, "Fluent 'Yani sen' must not flag 'yani' as filler");
  assert.equal(annotated.words[6].word, "şey");
  assert.equal(annotated.words[6].is_filler, true, "Pause-isolated 'şey' must be flagged as filler");
  assert.equal(annotated.words[7].word, "ıı");
  assert.equal(annotated.words[7].is_filler, true, "Unconditional 'ıı' must always be flagged as filler");

  // 3b. Captions must display EVERY unexcised spoken word (even if legacy cache marked is_filler: true)
  const wsDir = path.join(TEST_ROOT, "ws_captions_unexcised");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Unexcised Captions", aspect: "9:16", fps: 30 });

  const mediaFile = path.join(wsDir, "talk.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#0F172A:s=640x360:r=30:d=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=240:sample_rate=16000:duration=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    mediaFile,
  ]);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2500 });

  const vid01 = loadSequence(wsDir).sequence.library[0];
  const ledger = new MediaLedger(paths.ledgerFile);
  ledger.setTranscript(vid01.digest_sha256, "tr", {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: 2500,
    text: "şöyle bir şey var.",
    words: [
      { word: "şöyle", punctuated_word: "şöyle", source_start_ms: 200, source_end_ms: 600, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "bir", punctuated_word: "bir", source_start_ms: 600, source_end_ms: 760, confidence: 1.0, is_filler: false, is_repetition: false },
      // Simulate legacy cached transcript where 'şey' was marked is_filler: true
      { word: "şey", punctuated_word: "şey", source_start_ms: 760, source_end_ms: 920, confidence: 1.0, is_filler: true, is_repetition: false },
      { word: "var", punctuated_word: "var.", source_start_ms: 920, source_end_ms: 1240, confidence: 0.95, is_filler: false, is_repetition: false },
    ],
    disfluencies: [
      { kind: "filler", source_start_ms: 760, source_end_ms: 920, duration_ms: 160, label: "şey" },
    ],
  });
  ledger.close();

  // Cleanup must NOT cut 'şey' because it has 0ms gaps on both sides
  const cleanRes = cleanupClipDialogue({ workspaceDir: wsDir, clipId: "sp_01", dryRun: false });
  assert.equal(cleanRes.cuts_count, 0, "Fluent 'şey' in 'şöyle bir şey var' must not be excised by cleanup");

  // Captions must include 'şey' so the viewer reads "şöyle bir şey var."
  const capRes = generateSequenceCaptions({ workspaceDir: wsDir, style: "active_word", language: "tr" });
  assert.equal(capRes.cues.length, 1);
  assert.equal(capRes.cues[0].typography?.text, "şöyle bir şey var.");
});

test("4. G4_STAGE CPS threshold selects 19 CPS for Turkish transcripts even on ASCII-only captions, and 17 CPS for English", () => {
  const wsTr = path.join(TEST_ROOT, "ws_cps_tr");
  const wsEn = path.join(TEST_ROOT, "ws_cps_en");
  fs.rmSync(wsTr, { recursive: true, force: true });
  fs.rmSync(wsEn, { recursive: true, force: true });

  const { paths: pathsTr } = initWorkspace({ dir: wsTr, title: "TR CPS", aspect: "9:16", fps: 30 });
  const { paths: pathsEn } = initWorkspace({ dir: wsEn, title: "EN CPS", aspect: "9:16", fps: 30 });

  const mediaFile = path.join(TEST_ROOT, "cps_dummy.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#0F172A:s=640x360:r=30:d=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=240:sample_rate=16000:duration=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    mediaFile,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsTr, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsTr, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2500 });
  const shaTr = loadSequence(wsTr).sequence.library[0].digest_sha256;
  const ledgerTr = new MediaLedger(pathsTr.ledgerFile);
  ledgerTr.setTranscript(shaTr, "tr", {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: 2500,
    text: "Tamam dostlar.",
    words: [],
    disfluencies: [],
  });
  ledgerTr.close();

  // 18 characters in 1000ms = 18.0 CPS, with ZERO Turkish-specific characters (ç,ğ,ı,ö,ş,ü):
  // "Ben modeli denedim" (18 chars) -> Turkish project must use 19 CPS limit (no G402 warning)
  addLaneCue({
    workspaceDir: wsTr,
    laneId: "ln_captions",
    kind: "caption",
    atMs: 200,
    durationMs: 1000,
    text: "Ben modeli denedim",
  });
  const verTr = verifySequence(loadSequence(wsTr).sequence, pathsTr);
  assert.ok(
    !verTr.diagnostics.some((d) => d.code === "CUTHOL-G402"),
    `Expected 0 G402 warnings for 18.0 CPS ASCII-only caption in Turkish project, got: ${JSON.stringify(verTr.diagnostics)}`
  );

  // Same 18.0 CPS caption in an English transcript project must use 17 CPS limit and emit G402
  ingestAssetsIntoWorkspace({ workspaceDir: wsEn, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsEn, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2500 });
  const shaEn = loadSequence(wsEn).sequence.library[0].digest_sha256;
  const ledgerEn = new MediaLedger(pathsEn.ledgerFile);
  ledgerEn.setTranscript(shaEn, "en", {
    provider: "local",
    model: "test",
    language: "en",
    duration_ms: 2500,
    text: "A very nice today!",
    words: [],
    disfluencies: [],
  });
  ledgerEn.close();

  addLaneCue({
    workspaceDir: wsEn,
    laneId: "ln_captions",
    kind: "caption",
    atMs: 200,
    durationMs: 1000,
    text: "A very nice today!",
  });
  const verEn = verifySequence(loadSequence(wsEn).sequence, pathsEn);
  assert.ok(
    verEn.diagnostics.some((d) => d.code === "CUTHOL-G402"),
    "Expected G402 warning for 18.0 CPS caption in English project (limit 17 CPS)"
  );
});

test("5. cleanupClipDialogue trims word-overlapping pauses to inter-word gaps (TRIMMED_TO_WORD_GAP), splits multi-gap candidates, and rejects when trimmed gap < minPauseMs", () => {
  const wsDir = path.join(TEST_ROOT, "ws_trim_to_word_gap");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Trim To Word Gap", aspect: "9:16", fps: 30 });

  const mediaFile = path.join(wsDir, "trim_sample.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1E293B:s=640x360:r=30:d=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=16000:duration=10",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    mediaFile,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 9800 });

  const vid01 = loadSequence(wsDir).sequence.library[0];
  const ledger = new MediaLedger(paths.ledgerFile);
  const syntheticDoc: TranscriptDocument = {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: 9800,
    text: "Bugün konuşacağız. Gemini toplam tahmini dolar civarı.",
    words: [
      { word: "bugün", punctuated_word: "Bugün", source_start_ms: 3500, source_end_ms: 4100, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "konuşacağız", punctuated_word: "konuşacağız.", source_start_ms: 4160, source_end_ms: 4405, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "gemini", punctuated_word: "Gemini", source_start_ms: 5760, source_end_ms: 6080, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "tahmini", punctuated_word: "tahmini", source_start_ms: 6600, source_end_ms: 7000, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "dolar", punctuated_word: "dolar", source_start_ms: 8500, source_end_ms: 8900, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "civarı", punctuated_word: "civarı.", source_start_ms: 9220, source_end_ms: 9600, confidence: 0.99, is_filler: false, is_repetition: false },
    ],
    disfluencies: [
      // Case A: 4375..5675ms (1300ms) touches "konuşacağız." (4160..4405ms) by 30ms -> must trim to [4405..5675ms] (1270ms) and cut [4480..5600ms]
      { kind: "pause", source_start_ms: 4375, source_end_ms: 5675, duration_ms: 1300, label: "<acoustic_pause 1300ms>" },
      // Case B: 6050..8550ms spans across "Gemini" tail, "tahmini" (6600..7000ms), and "dolar" head -> must split into two gaps: [6080..6600ms] (520ms) and [7000..8500ms] (1500ms)
      { kind: "pause", source_start_ms: 6050, source_end_ms: 8550, duration_ms: 2500, label: "<acoustic_pause 2500ms>" },
      // Case C: 8880..9250ms touches "dolar" and "civarı." leaving only [8900..9220ms] (320ms < 400ms) -> must be rejected with OVERLAPS_WORD
      { kind: "pause", source_start_ms: 8880, source_end_ms: 9250, duration_ms: 370, label: "<acoustic_pause 370ms>" },
    ],
  };
  // Make Case C raw duration >= 400ms (8860..9260ms = 400ms) so it reaches word-trimming and gets rejected because trimmed gap is 320ms < 400ms
  syntheticDoc.disfluencies[2] = {
    kind: "pause",
    source_start_ms: 8860,
    source_end_ms: 9260,
    duration_ms: 400,
    label: "<acoustic_pause 400ms>",
  };
  ledger.setTranscript(vid01.digest_sha256, "tr", syntheticDoc);
  ledger.close();

  const res = cleanupClipDialogue({
    workspaceDir: wsDir,
    clipId: "sp_01",
    minPauseMs: 400,
    padMs: 75,
    dryRun: true,
  });

  assert.equal(res.cuts_count, 3, `Expected 3 cuts (1 from Case A + 2 from Case B), got ${res.cuts_count}`);

  // Case A cut: trimmed to [4405..5675], padded by 75ms -> [4480..5600]
  assert.equal(res.cuts[0].raw_source_start_ms, 4405);
  assert.equal(res.cuts[0].raw_source_end_ms, 5675);
  assert.equal(res.cuts[0].padded_source_start_ms, 4480);
  assert.equal(res.cuts[0].padded_source_end_ms, 5600);
  assert.equal(res.cuts[0].trimmed_to_word_gap, true);

  // Case B cut 1: trimmed to [6080..6600], padded by 75ms -> [6155..6525]
  assert.equal(res.cuts[1].raw_source_start_ms, 6080);
  assert.equal(res.cuts[1].raw_source_end_ms, 6600);
  assert.equal(res.cuts[1].padded_source_start_ms, 6155);
  assert.equal(res.cuts[1].padded_source_end_ms, 6525);

  // Case B cut 2: trimmed to [7000..8500], padded by 75ms -> [7075..8425]
  assert.equal(res.cuts[2].raw_source_start_ms, 7000);
  assert.equal(res.cuts[2].raw_source_end_ms, 8500);
  assert.equal(res.cuts[2].padded_source_start_ms, 7075);
  assert.equal(res.cuts[2].padded_source_end_ms, 8425);

  // Verify decision_trace records TRIMMED_TO_WORD_GAP with original and trimmed ranges, plus OVERLAPS_WORD for Case C
  assert.equal(res.decision_trace.summary.by_reason.TRIMMED_TO_WORD_GAP, 3);
  assert.equal(res.decision_trace.summary.by_reason.OVERLAPS_WORD, 1);

  const trimmedDec = res.decision_trace.decisions.find(
    (d) => d.reason_code === "TRIMMED_TO_WORD_GAP" && d.measured?.original_span === "4375..5675"
  );
  assert.ok(trimmedDec, "Expected TRIMMED_TO_WORD_GAP decision for 4375..5675ms");
  assert.equal(trimmedDec.measured?.trimmed_span, "4405..5675");
  assert.deepEqual(trimmedDec.span, [4480, 5600]);

  const rejectedDec = res.decision_trace.decisions.find((d) => d.reason_code === "OVERLAPS_WORD");
  assert.ok(rejectedDec, "Expected OVERLAPS_WORD rejection when trimmed gap < minPauseMs");
  assert.equal(rejectedDec.measured?.trimmed_gap_ms, 320);
  assert.equal(rejectedDec.measured?.trimmed_span, "8900..9220");
});

test("6. Acoustic edge verification shrinks cuts out of word tails, drops short remainders (< minPauseMs), and splits around untranscribed audio bursts (> 120ms)", () => {
  const wsDir = path.join(TEST_ROOT, "ws_acoustic_edges_and_bursts");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Acoustic Edges & Bursts", aspect: "9:16", fps: 30 });

  // Synthesize an 8.0s media file where:
  // - 0.20..1.10s (200..1100ms): spoken word "bakın," (ASR ends early at 900ms, audio tail continues to 1100ms)
  // - 1.10..2.10s (1100..2100ms): 1000ms true acoustic silence
  // - 2.10..3.15s (2100..3150ms): spoken phrase "şimdi kısa" (ASR ends at 2900ms, audio tail continues to 3150ms)
  // - 3.15..3.40s (3150..3400ms): only 250ms true acoustic silence (< 400ms minPauseMs, even though ASR gap is 2900..3400ms = 500ms)
  // - 3.40..4.00s (3400..4000ms): spoken word "ara"
  // - 4.00..4.70s (4000..4700ms): 700ms true acoustic silence before untranscribed burst
  // - 4.70..5.10s (4700..5100ms): 400ms (> 120ms) untranscribed audio burst (e.g. voiced filler "ııı" missed by ASR)
  // - 5.10..6.20s (5100..6200ms): 1100ms true acoustic silence after untranscribed burst
  // - 6.20..7.50s (6200..7500ms): spoken word "tamam."
  const mediaFile = path.join(wsDir, "acoustic_edges.mp4");
  const aevalExpr = [
    "between(t,0.20,1.10)",
    "between(t,2.10,3.15)",
    "between(t,3.40,4.00)",
    "between(t,4.70,5.10)",
    "between(t,6.20,7.50)",
  ].join("+");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#0F172A:s=640x360:r=30:d=8.0",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc='if(${aevalExpr},0.08*sin(2*PI*220*t)+0.04*sin(2*PI*660*t),0.00005*sin(2*PI*180*t))':s=16000:d=8.0`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      mediaFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, `FFmpeg failed: ${ff.stderr}`);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 7600 });

  const vid01 = loadSequence(wsDir).sequence.library[0];
  const ledger = new MediaLedger(paths.ledgerFile);
  const doc: TranscriptDocument = {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: 7600,
    text: "Bakın, şimdi kısa ara tamam.",
    words: [
      // ASR ends "bakın," at 900ms, 200ms earlier than actual audio tail (1100ms)
      { word: "bakın", punctuated_word: "Bakın,", source_start_ms: 200, source_end_ms: 900, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "şimdi", punctuated_word: "şimdi", source_start_ms: 2100, source_end_ms: 2500, confidence: 0.99, is_filler: false, is_repetition: false },
      // ASR ends "kısa" at 2900ms, 250ms earlier than actual audio tail (3150ms)
      { word: "kısa", punctuated_word: "kısa", source_start_ms: 2500, source_end_ms: 2900, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "ara", punctuated_word: "ara", source_start_ms: 3400, source_end_ms: 4000, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "tamam", punctuated_word: "tamam.", source_start_ms: 6200, source_end_ms: 7500, confidence: 0.99, is_filler: false, is_repetition: false },
    ],
    disfluencies: [
      // Pause 1: ASR says 900..2100ms (1200ms), but 900..1100ms has speech tail -> must shrink start to >= 1100ms
      { kind: "pause", source_start_ms: 900, source_end_ms: 2100, duration_ms: 1200, label: "<pause 1200ms>" },
      // Pause 2: ASR says 2900..3400ms (500ms >= 400ms), but 2900..3150ms has speech tail leaving only ~250ms (< 400ms) -> must be dropped!
      { kind: "pause", source_start_ms: 2900, source_end_ms: 3400, duration_ms: 500, label: "<pause 500ms>" },
      // Pause 3: ASR says 4000..6200ms (2200ms), but 4700..5100ms has a 400ms untranscribed audio burst -> must split into two cuts around 4700..5100ms!
      { kind: "pause", source_start_ms: 4000, source_end_ms: 6200, duration_ms: 2200, label: "<pause 2200ms>" },
    ],
  };
  ledger.setTranscript(vid01.digest_sha256, "tr", doc);
  ledger.close();

  const res = cleanupClipDialogue({
    workspaceDir: wsDir,
    clipId: "sp_01",
    minPauseMs: 400,
    padMs: 75,
    dryRun: true,
  });

  // Expected 3 cuts:
  // 1) Shrunk Pause 1: starts after the 1100ms audio tail (never cutting 900..1100ms)
  // 2) First half of Pause 3: before the 4700..5100ms untranscribed burst
  // 3) Second half of Pause 3: after the 4700..5100ms untranscribed burst
  // (Pause 2 at 2900..3400ms is dropped because acoustic silence is ~250ms < 400ms)
  assert.equal(res.cuts_count, 3, `Expected 3 cuts, got ${JSON.stringify(res.cuts)}`);

  // Cut 1 must not start before 1100ms (the true acoustic end of "Bakın,")
  assert.ok(
    res.cuts[0].padded_source_start_ms >= 1100,
    `Expected Cut 1 start >= 1100ms (past word tail), got ${res.cuts[0].padded_source_start_ms}`
  );
  assert.equal(res.cuts[0].padded_source_end_ms, 2025);

  // Cuts 2 and 3 must split cleanly around the 4700..5100ms untranscribed audio burst
  assert.ok(
    res.cuts[1].padded_source_end_ms <= 4700,
    `Expected Cut 2 end <= 4700ms (before untranscribed burst), got ${res.cuts[1].padded_source_end_ms}`
  );
  assert.ok(
    res.cuts[2].padded_source_start_ms >= 5100,
    `Expected Cut 3 start >= 5100ms (after untranscribed burst), got ${res.cuts[2].padded_source_start_ms}`
  );
  assert.equal(res.cuts[1].split_around_untranscribed_audio, true);
  assert.equal(res.cuts[2].split_around_untranscribed_audio, true);

  // Verify decision_trace records UNTRANSCRIBED_AUDIO, SPLIT_AROUND_UNTRANSCRIBED_AUDIO, and ACOUSTIC_GAP_TOO_SHORT
  assert.equal(res.decision_trace.summary.by_reason.UNTRANSCRIBED_AUDIO, 1);
  assert.equal(res.decision_trace.summary.by_reason.SPLIT_AROUND_UNTRANSCRIBED_AUDIO, 2);
  assert.equal(res.decision_trace.summary.by_reason.ACOUSTIC_GAP_TOO_SHORT, 1);

  const burstDec = res.decision_trace.decisions.find((d) => d.reason_code === "UNTRANSCRIBED_AUDIO");
  assert.ok(burstDec, "Expected UNTRANSCRIBED_AUDIO decision in decision_trace");
  assert.ok(burstDec.span[0] >= 4675 && burstDec.span[1] <= 5150);

  // Verify every single window inside all planned cuts is below silence_floor_dbfs
  const profile = measureAssetAcousticWindows({ workspaceDir: wsDir, handle: "vid_01" })!;
  assert.ok(profile && profile.has_silence_variation);
  for (const c of res.cuts) {
    const w0 = Math.floor(c.padded_source_start_ms / profile.window_ms);
    const w1 = Math.ceil(c.padded_source_end_ms / profile.window_ms);
    for (let w = w0; w < w1; w++) {
      assert.ok(
        profile.window_dbfs[w] <= profile.silence_floor_dbfs,
        `Expected window ${w * 25}..${(w + 1) * 25}ms inside cut [${c.padded_source_start_ms}..${c.padded_source_end_ms}] to be <= ${profile.silence_floor_dbfs} dBFS, got ${profile.window_dbfs[w]}`
      );
    }
  }
});
