/**
 * Dialogue Cleanup Workflow & Repetition/Restart Candidates
 * (`src/test/cleanup_workflow.test.ts`).
 *
 * Covers all 5 permanent improvements (using offline synthetic transcripts — no paid API calls):
 * 1. Full-spine / multi-clip `speech.cleanup` in a single atomic operation (1 journal entry, 1 undo).
 * 2. Persistent source-anchored candidate IDs (`cf_<asset>_<start>_<end>`, `rr_<asset>_<start>_<end>`)
 *    that remain invariant across `dry_run` calls and after spine cuts/splits.
 * 3. Phrase repetition (2..6 words, Turkish inflectional stem matches, skipped particles) & sentence
 *    restart candidates (`repetition_candidates`): never cut automatically; agent selects groups or
 *    which attempt to keep (`:keep=1`, `#1`) via `cut_candidates` with acoustic edge alignment.
 * 4. Sub-150ms remnant sliver merging (`APPLIED_WITH_SLIVER_MERGE` / `SHORT_SILENT_REMNANT_REMOVED`)
 *    and `verifySequence` `CUTHOL-G309` (`SHORT_SPINE_CLIP`, WARN) on `< 150ms` spine clips.
 * 5. Compact MCP output: `rules` returned only on `dry_run` / `verbose`, and `mix.normalize` summarizing
 *    `adjusted_clips` to the first 8 items + `adjusted_clips_count` (`verbose=true` for full list).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence, stepJournal } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { CutholMcpServer } from "../mcp/server.js";
import { normalizeSequenceAudio } from "../mix/audio_mix.js";
import { appendSpineClip, exciseSpineRanges, splitSpineClip, trimSpineClip } from "../sequence/spine.js";
import { cleanupClipDialogue } from "../speech/cleanup.js";
import { transcribeLibraryAsset } from "../speech/transcribe.js";
import { verifySequence } from "../verify/gates.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/cleanup_workflow");

function mcpText(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

test("1. Repetition/restart candidates , persistent IDs, attempt selection (:keep=1), and zero automatic word cuts", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_repetition_candidates");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Repetition Candidates", aspect: "16:9", fps: 30 });

  const mediaFile = path.join(wsDir, "talk_restarts.mp4");
  // Generate 16s video with speech-level tone bursts and real silent pauses
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#0F172A:s=640x360:r=30:d=16",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='if(between(t,2.0,2.7)+between(t,6.2,6.9)+between(t,11.0,11.8),0,0.25*sin(2*PI*220*t))':s=16000:d=16",
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

  // Synthetic transcript containing:
  // - 3-attempt phrase restart with Turkish suffix variation ("bazı modellerin farklı görev" / "görev alan" / "görev alanları vardır")
  // - Fluent contextual fillers ("yani" at 5200..5450ms and "hani" at 9400..9650ms)
  // - 2-attempt stem-matched restart ("iki farkla prompt verdim" -> "iki farklı prompt verdim")
  // - Immediate word repeat ("çok çok")
  fs.writeFileSync(
    `${mediaFile}.transcript.json`,
    JSON.stringify({
      language: "tr",
      words: [
        // Attempt 1 (100..1200ms)
        { word: "bazı", punctuated_word: "Bazı", source_start_ms: 100, source_end_ms: 350 },
        { word: "modellerin", punctuated_word: "modellerin", source_start_ms: 360, source_end_ms: 700 },
        { word: "farklı", punctuated_word: "farklı", source_start_ms: 710, source_end_ms: 950 },
        { word: "görev", punctuated_word: "görev", source_start_ms: 960, source_end_ms: 1200 },
        // Attempt 2 (1300..1980ms, followed by silent pause 2000..2700ms)
        { word: "bazı", punctuated_word: "bazı", source_start_ms: 1300, source_end_ms: 1480 },
        { word: "modellerin", punctuated_word: "modellerin", source_start_ms: 1490, source_end_ms: 1680 },
        { word: "farklı", punctuated_word: "farklı", source_start_ms: 1690, source_end_ms: 1830 },
        { word: "görev", punctuated_word: "görev", source_start_ms: 1840, source_end_ms: 1980 },
        // Attempt 3 (2720..4200ms - complete sentence)
        { word: "bazı", punctuated_word: "bazı", source_start_ms: 2720, source_end_ms: 2980 },
        { word: "modellerin", punctuated_word: "modellerin", source_start_ms: 2990, source_end_ms: 3320 },
        { word: "farklı", punctuated_word: "farklı", source_start_ms: 3330, source_end_ms: 3600 },
        { word: "görev", punctuated_word: "görev", source_start_ms: 3610, source_end_ms: 3850 },
        { word: "alanları", punctuated_word: "alanları", source_start_ms: 3860, source_end_ms: 4200 },
        { word: "vardır", punctuated_word: "vardır.", source_start_ms: 4210, source_end_ms: 4600 },
        // Fluent contextual filler #1 ("yani" at 5200..5450ms)
        { word: "bugün", punctuated_word: "Bugün", source_start_ms: 4700, source_end_ms: 5180 },
        { word: "yani", punctuated_word: "yani", source_start_ms: 5200, source_end_ms: 5450 },
        { word: "test", punctuated_word: "test", source_start_ms: 5470, source_end_ms: 5800 },
        { word: "yaptık", punctuated_word: "yaptık.", source_start_ms: 5820, source_end_ms: 6180 },
        // Pause 6200..6900ms, then stem-matched restart ("iki farkla prompt verdim" -> "iki farklı prompt verdim")
        { word: "iki", punctuated_word: "İki", source_start_ms: 6920, source_end_ms: 7120 },
        { word: "farkla", punctuated_word: "farkla", source_start_ms: 7130, source_end_ms: 7420 },
        { word: "prompt", punctuated_word: "prompt", source_start_ms: 7430, source_end_ms: 7720 },
        { word: "verdim", punctuated_word: "verdim,", source_start_ms: 7730, source_end_ms: 8050 },
        { word: "iki", punctuated_word: "iki", source_start_ms: 8150, source_end_ms: 8350 },
        { word: "farklı", punctuated_word: "farklı", source_start_ms: 8360, source_end_ms: 8650 },
        { word: "prompt", punctuated_word: "prompt", source_start_ms: 8660, source_end_ms: 8950 },
        { word: "verdim", punctuated_word: "verdim.", source_start_ms: 8960, source_end_ms: 9350 },
        // Fluent contextual filler #2 ("hani" at 9400..9650ms) + immediate word repeat ("çok çok")
        { word: "hani", punctuated_word: "Hani", source_start_ms: 9400, source_end_ms: 9650 },
        { word: "çok", punctuated_word: "çok", source_start_ms: 9680, source_end_ms: 9900 },
        { word: "çok", punctuated_word: "çok", source_start_ms: 9920, source_end_ms: 10150 },
        { word: "hızlı", punctuated_word: "hızlı", source_start_ms: 10170, source_end_ms: 10550 },
        { word: "çalıştı", punctuated_word: "çalıştı.", source_start_ms: 10570, source_end_ms: 10980 },
        // Pause 11000..11800ms, then closing words + fluent filler #3 ("şey" at 12400..12650ms)
        { word: "sonuç", punctuated_word: "Sonuç", source_start_ms: 11820, source_end_ms: 12380 },
        { word: "şey", punctuated_word: "şey", source_start_ms: 12400, source_end_ms: 12650 },
        { word: "başarılı", punctuated_word: "başarılı.", source_start_ms: 12670, source_end_ms: 13500 },
      ],
    }),
    "utf8"
  );

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 14000 });
  await transcribeLibraryAsset({ workspaceDir: wsDir, handle: "vid_01", provider: "local", language: "tr" });

  // 1a. Dry-run without selecting any candidates: only pauses are planned for automatic cut;
  //     NO repetitions or contextual fillers are cut automatically!
  const dry1 = cleanupClipDialogue({ workspaceDir: wsDir, dryRun: true });
  assert.ok(dry1.cuts.every((c) => c.kind === "pause"), "Without cut_candidates, only pauses may be cut automatically");
  assert.equal(dry1.review_candidates.length, 3, "Expected 3 fluent contextual filler candidates");
  assert.ok(dry1.repetition_candidates.length >= 3, "Expected at least 3 repetition/restart candidates");

  // Verify persistent source-anchored ID format
  assert.equal(dry1.review_candidates[0].id, "cf_vid_01_5200_5450");
  assert.equal(dry1.review_candidates[1].id, "cf_vid_01_9400_9650");
  assert.equal(dry1.review_candidates[2].id, "cf_vid_01_12400_12650");

  const multiAttemptCand = dry1.repetition_candidates.find((r) =>
    r.matched_phrase.includes("bazı modellerin farklı görev")
  );
  assert.ok(multiAttemptCand, "Must detect 3-attempt 'bazı modellerin farklı görev' restart group");
  assert.equal(multiAttemptCand!.attempts.length, 3);
  assert.equal(multiAttemptCand!.suggested_keep_attempt, 3);
  assert.match(multiAttemptCand!.id, /^rr_vid_01_100_/);

  const stemRestartCand = dry1.repetition_candidates.find((r) =>
    r.matched_phrase.includes("iki farkla prompt verdim")
  );
  assert.ok(stemRestartCand, "Must detect inflectional stem-matched 'iki farkla/farklı prompt verdim' restart");
  assert.equal(stemRestartCand!.attempts.length, 2);

  // 1b. Agent selects `multiAttemptCand.id` (default keep=#3) and `stemRestartCand.id:keep=1` (override to keep attempt #1!)
  const applied = cleanupClipDialogue({
    workspaceDir: wsDir,
    cutCandidates: [multiAttemptCand!.id, `${stemRestartCand!.id}:keep=1`],
    dryRun: false,
  });
  assert.equal(applied.verification?.ok, true);
  assert.equal(applied.verification?.warning_count, 0, "No <150ms sliver clip warnings should occur");

  const seqAfter = loadSequence(wsDir).sequence;
  // Verify that for multiAttemptCand, attempts 1 & 2 (100..1980ms) were excised and attempt 3 (2720..4200ms) was kept
  const coversSource = (s: number, e: number) =>
    seqAfter.spine.clips.some((c) => c.source_in_ms <= s && c.source_out_ms >= e);
  assert.equal(coversSource(100, 1200), false, "Attempt #1 of multiAttemptCand must be excised");
  assert.equal(coversSource(2750, 4200), true, "Attempt #3 of multiAttemptCand must be kept");

  // Verify that for stemRestartCand with `:keep=1`, attempt #1 (6920..8050ms) was KEPT and attempt #2 (8150..9350ms) was EXCISED!
  assert.equal(coversSource(6950, 8000), true, "Attempt #1 of stemRestartCand must be kept when :keep=1 is specified");
  assert.equal(coversSource(8200, 9300), false, "Attempt #2 of stemRestartCand must be excised when :keep=1 is specified");

  // 1c. Run dry_run again across all split clips on the spine and verify persistent IDs of the 3 untouched contextual fillers!
  const dry2 = cleanupClipDialogue({ workspaceDir: wsDir, dryRun: true });
  assert.equal(dry2.clips_processed, seqAfter.spine.clips.length);
  for (const origCf of dry1.review_candidates) {
    const afterCf = dry2.review_candidates.find((c) => c.id === origCf.id);
    assert.ok(afterCf, `Persistent ID ${origCf.id} must still exist in post-cut dry_run`);
    assert.equal(afterCf!.word, origCf.word);
    assert.equal(afterCf!.source_start_ms, origCf.source_start_ms);
    assert.equal(afterCf!.source_end_ms, origCf.source_end_ms);
  }
});

test("2. Multi-clip full-spine atomic cleanup (single journal entry, single undo) & <150ms sliver elimination + CUTHOL-G309 warning", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_multiclip_and_slivers");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Multi-Clip Atomic Cleanup", aspect: "16:9", fps: 30 });

  const mediaFile = path.join(wsDir, "multi_talk.mp4");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#1E293B:s=640x360:r=30:d=12",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='if(between(t,1.5,2.3)+between(t,5.0,5.9)+between(t,8.5,9.4),0,0.25*sin(2*PI*220*t))':s=16000:d=12",
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

  fs.writeFileSync(
    `${mediaFile}.transcript.json`,
    JSON.stringify({
      language: "tr",
      words: [
        { word: "birinci", punctuated_word: "Birinci", source_start_ms: 100, source_end_ms: 1420 },
        // 80ms gap before pause 1500..2300ms
        { word: "ikinci", punctuated_word: "ikinci", source_start_ms: 2320, source_end_ms: 3800 },
        { word: "üçüncü", punctuated_word: "üçüncü", source_start_ms: 3900, source_end_ms: 4920 },
        // pause 5000..5900ms
        { word: "dördüncü", punctuated_word: "dördüncü", source_start_ms: 5920, source_end_ms: 8420 },
        // pause 8500..9400ms
        { word: "beşinci", punctuated_word: "beşinci.", source_start_ms: 9420, source_end_ms: 11500 },
      ],
    }),
    "utf8"
  );

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 11800 });
  await transcribeLibraryAsset({ workspaceDir: wsDir, handle: "vid_01", provider: "local", language: "tr" });

  // Simulate manual splits creating 3 clips PLUS a 90ms silent remnant clip in between (1420..1510ms)
  splitSpineClip({
    workspaceDir: wsDir,
    clipId: "sp_01",
    splitPointsMs: [1420, 1510, 4500, 8000],
  });

  // Verify that `verifySequence` flags the 90ms clip (< 150ms) with CUTHOL-G309 (WARN)
  const seqWithSliver = loadSequence(wsDir).sequence;
  const verBefore = verifySequence(seqWithSliver);
  assert.equal(verBefore.ok, true);
  assert.ok(
    verBefore.diagnostics.some((d) => d.code === "CUTHOL-G309"),
    `Expected CUTHOL-G309 warning on 90ms spine clip, got ${JSON.stringify(verBefore.diagnostics)}`
  );

  const revBeforeCleanup = seqWithSliver.meta.revision;

  // Run speech.cleanup across ALL spine clips in ONE atomic call (no clipId specified)
  const cleanAll = cleanupClipDialogue({
    workspaceDir: wsDir,
    dryRun: false,
  });

  const seqAfterCleanup = loadSequence(wsDir).sequence;
  assert.equal(
    seqAfterCleanup.meta.revision,
    revBeforeCleanup + 1,
    "Full-spine cleanup must advance journal by exactly 1 revision"
  );
  assert.equal(
    seqAfterCleanup.spine.clips.filter((c) => c.duration_ms < 150).length,
    0,
    "All <150ms silent remnant clips must be eliminated after cleanup"
  );

  const verAfter = verifySequence(seqAfterCleanup);
  assert.equal(verAfter.error_count, 0);
  assert.equal(
    verAfter.diagnostics.filter((d) => d.code === "CUTHOL-G309").length,
    0,
    "Zero CUTHOL-G309 warnings must remain after cleanup"
  );
  assert.ok(cleanAll.cuts_count >= 3);

  // Single undo restores the entire spine back to `revBeforeCleanup`
  stepJournal(wsDir, "undo", 1);
  const seqAfterUndo = loadSequence(wsDir).sequence;
  assert.equal(seqAfterUndo.meta.revision, revBeforeCleanup);
  assert.equal(seqAfterUndo.spine.clips.length, seqWithSliver.spine.clips.length);
});

test("3. Compact MCP output: speech.cleanup omits rules outside dry_run and mix.normalize caps adjusted_clips at 8", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_compact_mcp");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Compact MCP Output", aspect: "16:9", fps: 30 });

  const mediaFile = path.join(wsDir, "speech_norm.mp4");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#0F172A:s=640x360:r=30:d=12",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=16000:duration=12",
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

  fs.writeFileSync(
    `${mediaFile}.transcript.json`,
    JSON.stringify({
      language: "tr",
      words: [
        { word: "merhaba", punctuated_word: "Merhaba", source_start_ms: 100, source_end_ms: 600 },
        { word: "arkadaşlar", punctuated_word: "arkadaşlar.", source_start_ms: 1500, source_end_ms: 2200 },
      ],
    }),
    "utf8"
  );

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 12000 });
  await transcribeLibraryAsset({ workspaceDir: wsDir, handle: "vid_01", provider: "local", language: "tr" });

  const mcp = new CutholMcpServer({ defaultDir: wsDir });

  // 3a. dry_run=true includes `rules` in Result JSON
  const dryMcp = await mcp.callTool("speech", { action: "cleanup", dry_run: true });
  assert.equal(dryMcp.isError, false, mcpText(dryMcp));
  const dryTxt = mcpText(dryMcp);
  assert.ok(dryTxt.includes('"rules":'), "dry_run=true must include decision_trace.rules");

  // 3b. dry_run=false (mutating cleanup) omits `rules` from Result JSON
  const applyMcp = await mcp.callTool("speech", { action: "cleanup" });
  assert.equal(applyMcp.isError, false, mcpText(applyMcp));
  const applyTxt = mcpText(applyMcp);
  assert.ok(!applyTxt.includes('"rules":'), "Non-dry-run speech.cleanup must omit verbose rules text");

  // Split into 12 clips (>= 8) so we can verify mix.normalize adjusted_clips capping
  const firstClipId = loadSequence(wsDir).sequence.spine.clips[0].id;
  splitSpineClip({
    workspaceDir: wsDir,
    clipId: firstClipId,
    splitPointsMs: [100, 200, 300, 400],
  });
  const lastClipId = loadSequence(wsDir).sequence.spine.clips.at(-1)!.id;
  splitSpineClip({
    workspaceDir: wsDir,
    clipId: lastClipId,
    splitPointsMs: [100, 200, 300, 400, 500, 600],
  });

  // 3c. mix.normalize on >8 clips caps adjusted_clips at 8 in compact mode and reports adjusted_clips_count + adjusted_clips_omitted
  const normMcp = await mcp.callTool("mix", { action: "normalize", target_lufs: -14 });
  assert.equal(normMcp.isError, false, mcpText(normMcp));
  const normTxt = mcpText(normMcp);
  assert.ok(!normTxt.includes("[truncated"), "mix.normalize MCP output must not truncate");
  const resultLine = normTxt.split("\n").find((l) => l.startsWith("Result: "));
  assert.ok(resultLine, "Expected Result: JSON line from mix.normalize");
  const normJson = JSON.parse(resultLine!.slice("Result: ".length)) as {
    adjusted_clips_count: number;
    adjusted_clips: unknown[];
    adjusted_clips_omitted?: number;
  };
  assert.ok(normJson.adjusted_clips_count >= 12);
  assert.equal(normJson.adjusted_clips.length, 8, "Compact mix.normalize must return only the first 8 adjusted_clips");
  assert.equal(normJson.adjusted_clips_omitted, normJson.adjusted_clips_count - 8);

  // Full list available when detailed: true
  const normDetailed = normalizeSequenceAudio({
    workspaceDir: wsDir,
    targetLufs: -14,
    detailed: true,
  });
  assert.equal(normDetailed.adjusted_clips.length, normDetailed.adjusted_clips_count);
});
