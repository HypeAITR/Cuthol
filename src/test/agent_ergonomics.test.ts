/**
 * Agent Ergonomics Verification Suite
 * (`src/test/agent_ergonomics.test.ts`).
 *
 * Covers all 4 agent ergonomics fixes:
 * 1. Contextual filler review candidates (`review_candidates` / `Review candidates` table in dry-run)
 *    and single-call selective excision via `cut_candidates` without altering automatic cut counts/savings.
 * 2. Compact `spine.reframe` MCP response (`Reframe summary` with per-clip confidence, pan range,
 *    and plateau count, plus bounded JSON `Result:` that never truncates mid-JSON at 12k chars).
 * 3. `mix.beat_align` reporting 0ms shifts as `ALREADY_ON_BEAT` instead of `SHIFTED_TO_BEAT`.
 * 4. Monotonic handle allocation (`seq.meta.handle_counters`) so deleted clip/cue handles (`sp_13`, `cue_02`, ...)
 *    are never re-issued, remaining consistent across undo/redo and backward-compatible with legacy sequence files.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { initWorkspace, loadSequence, stepJournal } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { queryLibraryAnalysis } from "../library/query.js";
import { CutholMcpServer } from "../mcp/server.js";
import { alignClipsToBeats } from "../mix/audio_mix.js";
import { addLaneCue, removeLaneCues } from "../sequence/lanes.js";
import { appendSpineClip, removeSpineClips, splitSpineClip } from "../sequence/spine.js";
import { cleanupClipDialogue } from "../speech/cleanup.js";
import { transcribeLibraryAsset } from "../speech/transcribe.js";
import { verifySequence } from "../verify/gates.js";
import { fixturePath } from "./fixtures.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/agent_ergonomics_tests");
const T1_K_DIR = fixturePath("t1_K");
const BEAT_K_DIR = fixturePath("beat_K");

function mcpText(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

test("1. Contextual filler review candidates in t1_K & single-call selective excision via cut_candidates", async () => {
  // 1a. Verify on t1_K (if present) that automatic cuts & saved duration match baseline (18 cuts, 25104ms, 0 overlaps)
  // while contextual fillers ("yani", "şey") appear in the separate review_candidates group.
  if (fs.existsSync(path.join(T1_K_DIR, "cuthol.sequence.json"))) {
    const dryRes = cleanupClipDialogue({
      workspaceDir: T1_K_K_SAFE_PATH(),
      clipId: "sp_01",
      dryRun: true,
    });

    assert.equal(dryRes.cuts_count, 18, "Automatic cut count on t1_K must remain 18");
    assert.equal(dryRes.saved_source_ms, 25104, "Automatic saved_source_ms on t1_K must remain 25104ms");
    assert.equal(dryRes.saved_sequence_ms, 25104, "Automatic saved_sequence_ms on t1_K must remain 25104ms");

    // Separate review group must list the 8 fluent contextual fillers (7 "yani" + 1 "şey")
    assert.equal(dryRes.review_candidates.length, 8);
    const yaniCandidates = dryRes.review_candidates.filter((rc) => rc.word === "yani");
    assert.equal(yaniCandidates.length, 7, "Expected 7 'yani' review candidates in t1_K");
    for (const rc of dryRes.review_candidates) {
      assert.match(rc.id, /^cf_[a-z0-9_]+_\d+_\d+$/);
      assert.ok(rc.source_end_ms > rc.source_start_ms);
      assert.ok(rc.context.includes(`[${rc.punctuated_word}]`));
    }

    // Verify 0 word overlaps (>30ms) across all automatic pause cuts (check_overlaps.mjs equivalent)
    const words: Array<{ w: string; s: number; e: number }> = [];
    let cursor: string | null = "0";
    while (cursor !== null) {
      const q = queryLibraryAnalysis({
        workspaceDir: T1_K_DIR,
        handle: "vid_01",
        kind: "transcript",
        limit: 100,
        maxTokens: 100000,
        cursor,
      });
      for (const item of q.items as Array<{ word: string; source_start_ms: number; source_end_ms: number }>) {
        words.push({ w: item.word, s: item.source_start_ms, e: item.source_end_ms });
      }
      cursor = q.next_cursor ?? null;
    }
    for (const c of dryRes.cuts) {
      if (c.kind === "filler" || c.kind === "repetition") continue;
      const hits = words.filter(
        (w) => Math.min(c.padded_source_end_ms, w.e) - Math.max(c.padded_source_start_ms, w.s) > 30
      );
      assert.equal(hits.length, 0, `Unexpected overlapping cut: ${JSON.stringify(c)} -> ${JSON.stringify(hits)}`);
    }

    // Verify MCP dry-run text formatting includes the separate "Review candidates" section
    const mcp = new CutholMcpServer({ defaultDir: T1_K_DIR });
    const mcpDry = await mcp.callTool("speech", { action: "cleanup", clip: "sp_01", dry_run: true });
    assert.equal(mcpDry.isError, false);
    const txt = mcpText(mcpDry);
    assert.ok(txt.includes("Review candidates (8 contextual filler(s)"));
    assert.ok(txt.includes('cf_vid_01_16785_16945 "Yani" source=16785..16945ms'));
    assert.ok(txt.includes('cf_vid_01_81730_81890 "yani" source=81730..81890ms'));
  }

  // 1b. Synthetic workspace test: agent inspects review_candidates in dry_run and cuts chosen ones in a single call
  const wsDir = path.join(TEST_ROOT, "ws_contextual_filler_review");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Contextual Filler Review", aspect: "9:16", fps: 30 });

  const mediaFile = path.join(wsDir, "talk.mp4");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "color=c=#0F172A:s=640x360:r=30:d=6",
      "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=16000:duration=6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", mediaFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);

  fs.writeFileSync(
    `${mediaFile}.transcript.json`,
    JSON.stringify({
      language: "tr",
      words: [
        { word: "bugün", punctuated_word: "Bugün", source_start_ms: 100, source_end_ms: 450 },
        // cf_01: hesitation "yani" in fluent speech (no pause after) -> agent will choose to cut
        { word: "yani", punctuated_word: "yani", source_start_ms: 500, source_end_ms: 780 },
        { word: "modeli", punctuated_word: "modeli", source_start_ms: 780, source_end_ms: 1200 },
        { word: "denedik", punctuated_word: "denedik.", source_start_ms: 1200, source_end_ms: 1700 },
        // cf_02: meaningful "yani" ("pahalı yani anti grafik") -> agent will keep
        { word: "pahalı", punctuated_word: "Pahalı,", source_start_ms: 1750, source_end_ms: 2200 },
        { word: "yani", punctuated_word: "yani", source_start_ms: 2200, source_end_ms: 2450 },
        { word: "açıklama", punctuated_word: "açıklama.", source_start_ms: 2450, source_end_ms: 3100 },
        // cf_03: another fluent "yani" -> agent will choose to cut
        { word: "sonra", punctuated_word: "Sonra", source_start_ms: 3200, source_end_ms: 3600 },
        { word: "yani", punctuated_word: "yani", source_start_ms: 3600, source_end_ms: 3900 },
        { word: "bitti", punctuated_word: "bitti.", source_start_ms: 3900, source_end_ms: 4500 },
      ],
    }),
    "utf8"
  );

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4600 });
  await transcribeLibraryAsset({ workspaceDir: wsDir, handle: "vid_01", provider: "local", language: "tr" });

  const dry = cleanupClipDialogue({ workspaceDir: wsDir, clipId: "sp_01", dryRun: true });
  assert.equal(dry.cuts_count, 0, "Fluent contextual fillers must not be cut automatically");
  assert.equal(dry.review_candidates.length, 3, "All 3 fluent 'yani' tokens must be listed in review_candidates");
  assert.deepEqual(
    dry.review_candidates.map((r) => r.id.replace(/^cf_vid_01_(\d+)_\d+$/, "$1")),
    dry.review_candidates.map((r) => String(r.source_start_ms))
  );

  // Agent selects cf_01 and cf_03 (keeping meaningful cf_02) in a single MCP call
  const mcp = new CutholMcpServer({ defaultDir: wsDir });
  const applyRes = await mcp.callTool("speech", {
    action: "cleanup",
    clip: "sp_01",
    cut_candidates: ["cf_01", "cf_03"],
  });
  assert.equal(applyRes.isError, false, mcpText(applyRes));

  const afterSeq = loadSequence(wsDir).sequence;
  // Kept clips should exclude [500..780] (cf_01) and [3600..3900] (cf_03), while preserving [2200..2450] (cf_02)
  const coversSourceRange = (s: number, e: number) =>
    afterSeq.spine.clips.some((c) => c.source_in_ms <= s && c.source_out_ms >= e);
  assert.equal(coversSourceRange(500, 780), false, "cf_01 must be excised");
  assert.equal(coversSourceRange(2200, 2450), true, "cf_02 (meaningful 'yani') must be preserved");
  assert.equal(coversSourceRange(3600, 3900), false, "cf_03 must be excised");
});

function T1_K_K_SAFE_PATH(): string {
  return T1_K_DIR;
}

test("2. spine.reframe MCP response is a compact summary and never truncates mid-JSON", async () => {
  // 2a. Real stdio MCP session against t1_K (if present): spine(action=reframe, all_spine=true) then workspace(action=undo)
  if (fs.existsSync(path.join(T1_K_DIR, "cuthol.sequence.json"))) {
    const revBefore = loadSequence(T1_K_DIR).sequence.meta.revision;
    const child = spawn(process.execPath, ["dist/cli.js", "mcp", "--dir", T1_K_DIR], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = readline.createInterface({ input: child.stdout });
    const pending = new Map<number, (msg: Record<string, unknown>) => void>();
    rl.on("line", (line) => {
      const msg = JSON.parse(line) as { id?: number } & Record<string, unknown>;
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    });
    const rpc = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    try {
      await rpc(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "ergonomics-test", version: "1.0" },
      });
      const reframeMsg = await rpc(2, "tools/call", {
        name: "spine",
        arguments: { action: "reframe", all_spine: true },
      });
      const resObj = reframeMsg.result as { content: Array<{ type: string; text?: string }>; isError: boolean };
      assert.equal(resObj.isError, false);
      const txt = mcpText(resObj);
      assert.ok(txt.length < 3000, `Expected compact reframe response (<3000 chars), got ${txt.length} chars`);
      assert.ok(!txt.includes("[truncated"), "Reframe MCP response must not be truncated");
      assert.ok(txt.includes("Reframe summary (1 clip(s), mode=subject_track):"));
      assert.match(txt, /sp_01 \(vid_01, face_skin\): conf=.*pan=.*plateaus=/);

      const resultLine = txt.split("\n").find((l) => l.startsWith("Result: "));
      assert.ok(resultLine, "Expected Result: JSON line");
      const parsedResult = JSON.parse(resultLine!.slice("Result: ".length)) as {
        clips_count: number;
      };
      assert.equal(parsedResult.clips_count, 1);

      const undoMsg = await rpc(3, "tools/call", {
        name: "workspace",
        arguments: { action: "undo" },
      });
      const undoObj = undoMsg.result as { isError: boolean };
      assert.equal(undoObj.isError, false);
    } finally {
      child.kill();
    }

    const revAfter = loadSequence(T1_K_DIR).sequence.meta.revision;
    assert.equal(revAfter, revBefore, "t1_K revision must be restored after undo");
  }

  // 2b. Multi-clip stress test (15 clips): verify MCP spine.reframe never exceeds 12k chars or slices JSON
  const wsDir = path.join(TEST_ROOT, "ws_reframe_multiclip_mcp");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Reframe Multi-Clip MCP", aspect: "9:16", fps: 30 });

  const mediaFile = path.join(wsDir, "wide_speaker.mp4");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi",
      "-i", "color=c=#1E293B:s=640x360:r=30:d=15,drawbox=x='100+300*sin(t)':y=80:w=90:h=140:color=#E0AC69@1.0:t=fill",
      "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", mediaFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 15000 });
  splitSpineClip({
    workspaceDir: wsDir,
    clipId: "sp_01",
    splitPointsMs: [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000],
  });

  const mcp = new CutholMcpServer({ defaultDir: wsDir });
  const multiReframe = await mcp.callTool("spine", { action: "reframe", all_spine: true });
  assert.equal(multiReframe.isError, false, mcpText(multiReframe));
  const multiTxt = mcpText(multiReframe);
  assert.ok(!multiTxt.includes("[truncated"), `Multi-clip reframe must not truncate, got:\n${multiTxt}`);
  assert.ok(multiTxt.length < 4000, `Expected bounded response <4000 chars for 15 clips, got ${multiTxt.length}`);
  assert.ok(multiTxt.includes("Reframe summary (15 clip(s), mode=subject_track):"));
  const resLine = multiTxt.split("\n").find((l) => l.startsWith("Result: "));
  assert.ok(resLine);
  const parsedMulti = JSON.parse(resLine!.slice("Result: ".length)) as { clips_count: number };
  assert.equal(parsedMulti.clips_count, 15);
});

test("3. mix.beat_align reports 0ms shifts as ALREADY_ON_BEAT on beat_K and synthetic sequences", () => {
  if (fs.existsSync(path.join(BEAT_K_DIR, "cuthol.sequence.json"))) {
    const revBefore = loadSequence(BEAT_K_DIR).sequence.meta.revision;

    // First run on beat_K: shifts clips to the beat grid
    const run1 = alignClipsToBeats({
      workspaceDir: BEAT_K_DIR,
      bgmHandle: "aud_01",
    });
    assert.equal(run1.aligned_clips.length, 6);
    assert.ok(run1.aligned_clips.every((c) => c.shift_ms !== 0 && c.reason_code === "SHIFTED_TO_BEAT"));
    assert.equal(run1.decision_trace.summary.by_reason.SHIFTED_TO_BEAT, 6);

    // Second consecutive run on beat_K: all clips are already on the beat (0ms shift) -> all ALREADY_ON_BEAT
    const run2 = alignClipsToBeats({
      workspaceDir: BEAT_K_DIR,
      bgmHandle: "aud_01",
    });
    assert.equal(run2.aligned_clips.length, 6);
    for (const c of run2.aligned_clips) {
      assert.equal(c.shift_ms, 0, `Expected 0ms shift on second run for ${c.clip_id}`);
      assert.equal(c.reason_code, "ALREADY_ON_BEAT", `Expected ALREADY_ON_BEAT on second run for ${c.clip_id}`);
    }
    assert.equal(run2.decision_trace.summary.by_reason.ALREADY_ON_BEAT, 6);
    assert.equal(run2.decision_trace.summary.by_reason.SHIFTED_TO_BEAT, undefined);
    assert.ok(run2.decision_trace.decisions.every((d) => d.reason_code === "ALREADY_ON_BEAT"));

    // Undo both runs so beat_K stays at its original revision
    const undoRes = stepJournal(BEAT_K_DIR, "undo", { steps: 2 });
    assert.equal(undoRes.revision, revBefore);
  }
});

test("4. Deleted clip/cue handles are never re-issued, stay consistent across undo/redo, and legacy sequence files load cleanly", () => {
  const wsDir = path.join(TEST_ROOT, "ws_monotonic_handles");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Monotonic Handles", aspect: "9:16", fps: 30 });

  const mediaFile = path.join(wsDir, "clip.mp4");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "color=c=#0F172A:s=640x360:r=30:d=4",
      "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=16000:duration=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", mediaFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });

  // Append sp_01, sp_02, sp_03
  const c1 = appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 1000 }).clip;
  const c2 = appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 1000, sourceOutMs: 2000 }).clip;
  const c3 = appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 2000, sourceOutMs: 3000 }).clip;
  assert.deepEqual([c1.id, c2.id, c3.id], ["sp_01", "sp_02", "sp_03"]);

  // Delete middle clip (sp_02) and tail clip (sp_03)
  removeSpineClips({ workspaceDir: wsDir, clipIds: ["sp_02", "sp_03"] });

  // Append a new clip -> must be sp_04, NOT sp_02 or sp_03
  const c4 = appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 500, sourceOutMs: 1500 }).clip;
  assert.equal(c4.id, "sp_04", "Deleted clip handle must never be re-issued");

  // Same for cues: add cue_01, cue_02 -> delete cue_02 -> add new cue -> must be cue_03
  const q1 = addLaneCue({ workspaceDir: wsDir, laneId: "ln_titles", text: "One", atMs: 0, durationMs: 800 }).cue;
  const q2 = addLaneCue({ workspaceDir: wsDir, laneId: "ln_titles", text: "Two", atMs: 800, durationMs: 800 }).cue;
  assert.deepEqual([q1.id, q2.id], ["cue_01", "cue_02"]);
  removeLaneCues({ workspaceDir: wsDir, cueIds: ["cue_02"] });
  const q3 = addLaneCue({ workspaceDir: wsDir, laneId: "ln_titles", text: "Three", atMs: 800, durationMs: 800 }).cue;
  assert.equal(q3.id, "cue_03", "Deleted cue handle must never be re-issued");

  // Undo and redo consistency:
  // Undo adding cue_03 -> redo adding cue_03 -> still cue_03 and unique
  stepJournal(wsDir, "undo", { steps: 1 });
  assert.deepEqual(
    loadSequence(wsDir).sequence.lanes.find((l) => l.id === "ln_titles")!.cues.map((c) => c.id),
    ["cue_01"]
  );
  stepJournal(wsDir, "redo", { steps: 1 });
  assert.deepEqual(
    loadSequence(wsDir).sequence.lanes.find((l) => l.id === "ln_titles")!.cues.map((c) => c.id),
    ["cue_01", "cue_03"]
  );

  // Undo back before sp_02/sp_03 deletion (r11 -> r5 = 6 steps)
  stepJournal(wsDir, "undo", { steps: 6 });
  assert.deepEqual(
    loadSequence(wsDir).sequence.spine.clips.map((c) => c.id),
    ["sp_01", "sp_02", "sp_03"]
  );
  // Adding a clip now must still produce a unique handle (sp_04)
  const cAfterUndo = appendSpineClip({
    workspaceDir: wsDir,
    assetHandle: "vid_01",
    sourceInMs: 0,
    sourceOutMs: 1000,
  }).clip;
  assert.equal(cAfterUndo.id, "sp_04");

  // Legacy sequence file compatibility (no meta.handle_counters field, highest clip is sp_13, deleted first):
  const rawLegacy = JSON.parse(fs.readFileSync(paths.sequenceFile, "utf8")) as Record<string, unknown>;
  const metaObj = rawLegacy.meta as Record<string, unknown>;
  delete metaObj.handle_counters;
  const spineObj = rawLegacy.spine as { clips: Array<Record<string, unknown>> };
  spineObj.clips[spineObj.clips.length - 1].id = "sp_13";
  fs.writeFileSync(paths.sequenceFile, JSON.stringify(rawLegacy, null, 2), "utf8");

  const loadedLegacy = loadSequence(wsDir).sequence;
  assert.equal(loadedLegacy.meta.handle_counters, undefined);
  assert.equal(verifySequence(loadedLegacy, paths).ok, true);

  // Remove sp_13 on the legacy sequence and append a new clip -> must allocate sp_14, not sp_13!
  removeSpineClips({ workspaceDir: wsDir, clipIds: ["sp_13"] });
  const afterLegacyAppend = appendSpineClip({
    workspaceDir: wsDir,
    assetHandle: "vid_01",
    sourceInMs: 0,
    sourceOutMs: 1000,
  }).clip;
  assert.equal(afterLegacyAppend.id, "sp_14", "Deleting sp_13 on a legacy sequence and appending must yield sp_14");
});
