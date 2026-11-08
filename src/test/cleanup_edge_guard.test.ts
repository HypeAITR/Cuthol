/**
 * Selected-range cleanup edges must not cross into kept speech when ASR starts the next word late.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { measureAssetAcousticWindows } from "../library/waveform.js";
import { appendSpineClip } from "../sequence/spine.js";
import { cleanupClipDialogue, PlannedCutInterval } from "../speech/cleanup.js";
import { TranscriptDocument } from "../speech/providers.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/cleanup_edge_guard");

function firstActiveWindowMs(
  profile: NonNullable<ReturnType<typeof measureAssetAcousticWindows>>,
  atOrAfterMs: number
): number {
  const startW = Math.max(0, Math.floor(atOrAfterMs / profile.window_ms));
  for (let w = startW; w < profile.window_dbfs.length; w++) {
    if (profile.window_dbfs[w] > profile.silence_floor_dbfs) return w * profile.window_ms;
  }
  return -1;
}

test("selected cut edge stays one window before a kept-word attack that ASR starts 300–400ms late", () => {
  const wsDir = path.join(TEST_ROOT, "ws_late_asr_attack");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Late ASR Attack", aspect: "16:9", fps: 30 });

  // 0.50..0.90s abandoned attempt, 2.00..2.07s real attack (80ms, under the 120ms untranscribed
  // burst rule), 2.07..2.20s dip, 2.20..2.80s rest of the kept word. ASR places that word at 2.35s.
  const mediaFile = path.join(wsDir, "late_attack.mp4");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#0F172A:s=640x360:r=30:d=4",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='if(between(t,0.50,0.90)+between(t,2.00,2.07)+between(t,2.20,2.80),0.22*sin(2*PI*220*t),0)':s=16000:d=4",
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
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });

  const vid = loadSequence(wsDir).sequence.library[0];
  const ledger = new MediaLedger(paths.ledgerFile);
  const doc: TranscriptDocument = {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: 4000,
    text: "şey Dostlar.",
    words: [
      { word: "şey", punctuated_word: "şey", source_start_ms: 520, source_end_ms: 880, confidence: 0.99, is_filler: true, is_repetition: false },
      { word: "dostlar", punctuated_word: "Dostlar.", source_start_ms: 2350, source_end_ms: 2750, confidence: 0.99, is_filler: false, is_repetition: false },
    ],
    disfluencies: [
      { kind: "pause", source_start_ms: 880, source_end_ms: 2350, duration_ms: 1470, label: "<pause 1470ms>" },
    ],
  };
  ledger.setTranscript(vid.digest_sha256, "tr", doc);
  ledger.setTranscript(vid.digest_sha256, "latest", doc);
  ledger.close();

  const profile = measureAssetAcousticWindows({ workspaceDir: wsDir, handle: "vid_01" });
  assert.ok(profile && profile.has_silence_variation);
  const attackMs = firstActiveWindowMs(profile, 1500);
  assert.ok(
    attackMs >= 1900 && attackMs <= 2100,
    `Expected the kept-word attack near 2000ms, found ${attackMs}ms (floor ${profile.silence_floor_dbfs})`
  );
  const keptLimitMs = attackMs - profile.window_ms;

  const assertEdgesStayBeforeAttack = (cuts: PlannedCutInterval[], requestedEnd: number) => {
    for (const c of cuts) {
      const crosses =
        c.padded_source_start_ms < attackMs && c.padded_source_end_ms > keptLimitMs;
      assert.equal(
        crosses,
        false,
        `Cut ${c.kind} ${c.padded_source_start_ms}..${c.padded_source_end_ms} crosses the attack at ${attackMs}ms (limit ${keptLimitMs}ms)`
      );
    }
    const selected = cuts.find((c) => c.requested_source_end_ms === requestedEnd);
    assert.ok(selected, `Selected cut for requested end ${requestedEnd}ms is missing from ${JSON.stringify(cuts.map((c) => ({ kind: c.kind, raw: [c.raw_source_start_ms, c.raw_source_end_ms], padded: [c.padded_source_start_ms, c.padded_source_end_ms], req: c.requested_source_end_ms })))}`);
    assert.equal(selected.requested_source_start_ms, 400);
    assert.equal(selected.requested_source_end_ms, requestedEnd);
    assert.equal(typeof selected.applied_source_start_ms, "number");
    assert.ok(
      (selected.applied_source_end_ms ?? selected.padded_source_end_ms) <= keptLimitMs,
      `Applied end ${selected.applied_source_end_ms} is not before the attack window ${attackMs}ms`
    );
    return selected;
  };

  // Requested end sits in the silence before the attack. Unfixed refinement walks forward
  // and stops after the attack, on the far side of the dip.
  const extended = cleanupClipDialogue({
    workspaceDir: wsDir,
    allSpine: true,
    cutCandidates: ["vid_01:400..1900ms"],
    dryRun: true,
  });
  const extendedCut = assertEdgesStayBeforeAttack(extended.cuts, 1900);
  assert.ok(
    (extendedCut.applied_source_end_ms ?? 0) > 1900,
    `Expected the silent gap to extend the edge outward, got ${extendedCut.applied_source_end_ms}`
  );
  assert.ok(
    extendedCut.edge_reason === "extended_into_silence" ||
      extendedCut.edge_reason === "split_around_untranscribed_audio",
    `Unexpected edge_reason ${extendedCut.edge_reason}`
  );

  // Requested end sits inside the attack. The edge has to move inward, ahead of that attack.
  const pulled = cleanupClipDialogue({
    workspaceDir: wsDir,
    allSpine: true,
    cutCandidates: ["vid_01:400..2050ms"],
    dryRun: true,
  });
  const pulledCut = assertEdgesStayBeforeAttack(pulled.cuts, 2050);
  assert.ok(
    (pulledCut.applied_source_end_ms ?? 99999) < 2050,
    `Expected the in-speech edge to pull inward, got ${pulledCut.applied_source_end_ms}`
  );
  assert.equal(pulledCut.edge_reason, "pulled_in_before_speech");
});

test("selected cut keeps an untranscribed run that ends inside the requested range", () => {
  const wsDir = path.join(TEST_ROOT, "ws_interior_untranscribed");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Interior Untranscribed", aspect: "16:9", fps: 30 });

  // 0.50..0.90s cut word, 1.50..2.30s untranscribed speech inside the selection,
  // 3.00..3.70s kept word. ASR places that word at 3.40s. Requested end is 2.70s,
  // in the silence after the untranscribed run and before the kept-word attack.
  const mediaFile = path.join(wsDir, "interior_run.mp4");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#0F172A:s=640x360:r=30:d=5",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='if(between(t,0.50,0.90)+between(t,1.50,2.30)+between(t,3.00,3.70),0.22*sin(2*PI*220*t),0)':s=16000:d=5",
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
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 5000 });

  const vid = loadSequence(wsDir).sequence.library[0];
  const ledger = new MediaLedger(paths.ledgerFile);
  const doc: TranscriptDocument = {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: 5000,
    text: "şey Dostlar.",
    words: [
      { word: "şey", punctuated_word: "şey", source_start_ms: 520, source_end_ms: 880, confidence: 0.99, is_filler: true, is_repetition: false },
      { word: "dostlar", punctuated_word: "Dostlar.", source_start_ms: 3400, source_end_ms: 3680, confidence: 0.99, is_filler: false, is_repetition: false },
    ],
    disfluencies: [
      { kind: "pause", source_start_ms: 880, source_end_ms: 3400, duration_ms: 2520, label: "<pause 2520ms>" },
    ],
  };
  ledger.setTranscript(vid.digest_sha256, "tr", doc);
  ledger.setTranscript(vid.digest_sha256, "latest", doc);
  ledger.close();

  const profile = measureAssetAcousticWindows({ workspaceDir: wsDir, handle: "vid_01" });
  assert.ok(profile && profile.has_silence_variation);
  const win = profile.window_ms;
  const runs: Array<{ start: number; end: number }> = [];
  let runStart = -1;
  const fromW = Math.floor(1000 / win);
  const toW = Math.floor(2700 / win);
  for (let w = fromW; w <= toW; w++) {
    const active = w < toW && profile.window_dbfs[w] > profile.silence_floor_dbfs;
    if (active && runStart < 0) runStart = w * win;
    else if (!active && runStart >= 0) {
      const end = w * win;
      if (end - runStart > 120 && w < toW) runs.push({ start: runStart, end });
      runStart = -1;
    }
  }
  assert.equal(runs.length, 1, `Expected one interior run before 2700ms, found ${JSON.stringify(runs)}`);
  const burst = runs[0];
  const mid = Math.floor((burst.start + burst.end) / 2);
  const attackMs = firstActiveWindowMs(profile, burst.end + 50);
  assert.ok(
    attackMs > burst.end && attackMs < 3400,
    `Expected the kept-word attack after ${burst.end}ms and before the ASR word, found ${attackMs}ms`
  );
  const keptLimitMs = attackMs - win;

  const result = cleanupClipDialogue({
    workspaceDir: wsDir,
    allSpine: true,
    cutCandidates: ["vid_01:400..2700ms"],
    dryRun: true,
  });

  const covering = result.cuts.filter(
    (c) => c.padded_source_start_ms < mid && c.padded_source_end_ms > mid
  );
  assert.equal(
    covering.length,
    0,
    `Untranscribed run ${burst.start}..${burst.end} is cut by ${JSON.stringify(covering.map((c) => ({ kind: c.kind, padded: [c.padded_source_start_ms, c.padded_source_end_ms], reason: c.edge_reason })))}`
  );

  const selected = result.cuts.find((c) => c.requested_source_end_ms === 2700);
  assert.ok(selected, "Selected cut is missing");
  assert.equal(selected.edge_reason, "split_around_untranscribed_audio");
  assert.ok(
    (selected.applied_source_end_ms ?? selected.padded_source_end_ms) <= burst.start,
    `Selected cut ends at ${selected.applied_source_end_ms}, inside the run that starts at ${burst.start}`
  );
  const spans = selected.untranscribed_audio_spans ?? [];
  assert.ok(
    spans.some((s) => s.start_ms <= mid && s.end_ms >= mid),
    `Run was not recorded in untranscribed_audio_spans: ${JSON.stringify(spans)}`
  );

  for (const c of result.cuts) {
    const crosses = c.padded_source_start_ms < attackMs && c.padded_source_end_ms > keptLimitMs;
    assert.equal(
      crosses,
      false,
      `Cut ${c.kind} ${c.padded_source_start_ms}..${c.padded_source_end_ms} crosses the attack at ${attackMs}ms (limit ${keptLimitMs}ms)`
    );
  }
});
