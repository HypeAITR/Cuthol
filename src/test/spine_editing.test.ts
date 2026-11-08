/**
 * Comprehensive Unit & Integration Verification Suite (`src/test/spine_editing.test.ts`).
 *
 * Tests:
 * 1. Spine append, magnetic reflow & playback speed rescaling (`spine.ts`)
 * 2. Spine split with envelope partitioning & automatic lane cue re-anchoring (`spine.ts`)
 * 3. Spine trim, multi-range excise (ripple cut), remove (cascade vs detach) & reorder (`spine.ts`)
 * 4. Spatial transform relative deltas (`+=`, `-=`) & `evaluateEnvelopeAt` easing curves (`spine.ts`)
 * 5. 5-Gate Verifier `G1_SCHEMA`, `G2_ASSETS`, `G3_TIMING` & automatic `JournalGuard` rollback (`gates.ts`)
 * 6. `G4_STAGE` & `G5_SIGNAL`: `measureCuePixelBox`, EBU R95 / 9:16 safe zones, BBC CPS, `z_index` occlusion & True Peak (`gates.ts`)
 * 7. Declarative Cue Sheet `diff`, `plan` (dry-run), `apply`, `export` & cross-lane handle preservation (`cuesheet.ts`)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { analyzeAssetLoudness } from "../library/loudness.js";
import {
  appendSpineClip,
  evaluateEnvelopeAt,
  exciseSpineRanges,
  removeSpineClips,
  reorderSpineClip,
  setItemEnvelope,
  setSpineSpeed,
  setSpineTransition,
  sequenceMsToSourceMs,
  sourceMsToSequenceMs,
  projectTranscriptWordsToClip,
  splitSpineClip,
  transformSpineClip,
  trimSpineClip,
} from "../sequence/spine.js";
import { addLaneCue, updateLaneCue } from "../sequence/lanes.js";
import {
  applyCueSheet,
  CutholCueSheet,
  exportSequenceToCueSheet,
  mergeCueSheetIntoSequence,
  planCueSheet,
} from "../sequence/cuesheet.js";
import { measureCuePixelBox, verifySequence } from "../verify/gates.js";
import { ParameterEnvelope } from "../core/schema.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const SHARED_MEDIA_DIR = path.join(TEST_ROOT, "shared_media_3_2");

function ensureSharedTestVideo(): string {
  fs.mkdirSync(SHARED_MEDIA_DIR, { recursive: true });
  const videoPath = path.join(SHARED_MEDIA_DIR, "source_8s.mp4");
  if (!fs.existsSync(videoPath)) {
    const proc = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=#1E293B:s=1080x1920:r=30:d=8",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=8",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        videoPath,
      ],
      { encoding: "utf8" }
    );
    assert.equal(proc.status, 0, `FFmpeg failed: ${proc.stderr}`);
  }
  return videoPath;
}

function setupFreshWorkspace(name: string): { wsDir: string; videoPath: string } {
  const wsDir = path.join(TEST_ROOT, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: name, aspect: "9:16", fps: 30 });
  const videoPath = ensureSharedTestVideo();
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [videoPath] });
  return { wsDir, videoPath };
}

test("1. Spine append, magnetic reflow & playback speed rescaling", () => {
  const { wsDir } = setupFreshWorkspace("spine_editing_spine_reflow");

  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 2000, sourceOutMs: 4000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 4000, sourceOutMs: 6000 });

  let seq = loadSequence(wsDir).sequence;
  assert.deepEqual(
    seq.spine.clips.map((c) => ({ id: c.id, in: c.timeline_in_ms, dur: c.duration_ms })),
    [
      { id: "sp_01", in: 0, dur: 2000 },
      { id: "sp_02", in: 2000, dur: 2000 },
      { id: "sp_03", in: 4000, dur: 2000 },
    ]
  );

  // Add an envelope on sp_02 (0ms -> 2000ms) and change speed to 2.0x
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_02",
    parameter: "placement.scale_x",
    points: [
      { offset_ms: 0, value: 1.0, easing: "linear" },
      { offset_ms: 2000, value: 1.4, easing: "linear" },
    ],
  });

  setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_02", rate: 2.0 });

  seq = loadSequence(wsDir).sequence;
  // sp_02 duration halves to 1000ms, sp_03 shifts to timeline_in_ms = 3000ms
  assert.equal(seq.spine.clips[1].duration_ms, 1000);
  assert.equal(seq.spine.clips[1].envelopes[0].points[1].offset_ms, 1000);
  assert.equal(seq.spine.clips[2].timeline_in_ms, 3000);
});

test("2. Spine split with envelope partitioning & automatic lane cue re-anchoring", () => {
  const { wsDir } = setupFreshWorkspace("spine_editing_split_reanchor");

  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_01",
    parameter: "placement.scale_x",
    points: [
      { offset_ms: 0, value: 1.0, easing: "linear" },
      { offset_ms: 4000, value: 2.0, easing: "linear" },
    ],
  });

  // cue_01 at +500ms (first half), cue_02 at +2500ms (second half)
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_titles",
    anchor: { ref: "sp_01", offset_ms: 500 },
    durationMs: 1000,
    text: "İlk Yarı",
  });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_titles",
    anchor: { ref: "sp_01", offset_ms: 2500 },
    durationMs: 1000,
    text: "İkinci Yarı",
  });

  // Split sp_01 at 2000ms
  const { clips } = splitSpineClip({
    workspaceDir: wsDir,
    clipId: "sp_01",
    splitPointsMs: [2000],
  });
  assert.equal(clips.length, 2);
  assert.equal(clips[0].id, "sp_01");
  assert.equal(clips[1].id, "sp_02");

  // Left envelope ends at 1.5, right envelope starts at 1.5 and ends at 2.0
  assert.equal(clips[0].envelopes[0].points[1].value, 1.5);
  assert.equal(clips[1].envelopes[0].points[0].value, 1.5);
  assert.equal(clips[1].envelopes[0].points[1].value, 2.0);

  // Verify cue_02 was automatically re-anchored to sp_02 (+500ms) so its resolved timeline start stays at 2500ms!
  const seq = loadSequence(wsDir).sequence;
  const titles = seq.lanes.find((l) => l.id === "ln_titles")!.cues;
  assert.deepEqual(titles[0].anchor, { ref: "sp_01", offset_ms: 500 });
  assert.equal(titles[0].at_ms, 500);
  assert.deepEqual(titles[1].anchor, { ref: "sp_02", offset_ms: 500 });
  assert.equal(titles[1].at_ms, 2500);
});

test("3. Spine trim, multi-range excise (ripple cut), reorder & remove", () => {
  const { wsDir } = setupFreshWorkspace("spine_editing_excise_reorder");

  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 6000 });

  // Excise two pauses: 1000..2000ms and 3500..4500ms -> keeps [0..1000], [2000..3500], [4500..6000]
  const { remainingClips } = exciseSpineRanges({
    workspaceDir: wsDir,
    clipId: "sp_01",
    ranges: [
      { start_ms: 1000, end_ms: 2000 },
      { start_ms: 3500, end_ms: 4500 },
    ],
  });
  assert.equal(remainingClips.length, 3);
  assert.deepEqual(
    remainingClips.map((c) => ({
      id: c.id,
      src: [c.source_in_ms, c.source_out_ms],
      tl: [c.timeline_in_ms, c.timeline_in_ms + c.duration_ms],
    })),
    [
      { id: "sp_01", src: [0, 1000], tl: [0, 1000] },
      { id: "sp_02", src: [2000, 3500], tl: [1000, 2500] },
      { id: "sp_03", src: [4500, 6000], tl: [2500, 4000] },
    ]
  );

  // Anchor a cue to sp_03 (+100ms -> currently at 2600ms), then move sp_03 before sp_01
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_titles",
    anchor: { ref: "sp_03", offset_ms: 100 },
    durationMs: 800,
    text: "Taşınan Başlık",
  });

  reorderSpineClip({ workspaceDir: wsDir, clipId: "sp_03", beforeClipId: "sp_01" });

  let seq = loadSequence(wsDir).sequence;
  assert.deepEqual(seq.spine.clips.map((c) => c.id), ["sp_03", "sp_01", "sp_02"]);
  // Because sp_03 is now at 0ms, its anchored cue_01 automatically moved to 100ms!
  const cue = seq.lanes.find((l) => l.id === "ln_titles")!.cues[0];
  assert.equal(cue.at_ms, 100);

  // Remove sp_03 with cascadeAnchoredCues: false -> cue_01 detaches to absolute at_ms=100
  removeSpineClips({ workspaceDir: wsDir, clipIds: ["sp_03"], cascadeAnchoredCues: false });
  seq = loadSequence(wsDir).sequence;
  assert.deepEqual(seq.spine.clips.map((c) => c.id), ["sp_01", "sp_02"]);
  const detachedCue = seq.lanes.find((l) => l.id === "ln_titles")!.cues[0];
  assert.equal(detachedCue.anchor, null);
  assert.equal(detachedCue.at_ms, 100);

  // Trim sp_01 from 0..1000ms to 200..900ms (700ms duration)
  trimSpineClip({ workspaceDir: wsDir, clipId: "sp_01", sourceInMs: 200, sourceOutMs: 900 });
  seq = loadSequence(wsDir).sequence;
  assert.equal(seq.spine.clips[0].duration_ms, 700);
  assert.equal(seq.spine.clips[1].timeline_in_ms, 700);
});

test("4. Spatial transform relative deltas & envelope easing curves", () => {
  const { wsDir } = setupFreshWorkspace("spine_editing_transform_easing");
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });

  transformSpineClip({
    workspaceDir: wsDir,
    clipId: "sp_01",
    xPct: "+=15%",
    yPct: "-=10%",
    scale: "+=0.25",
    rotationDeg: "+=12deg",
    opacity: "80%",
    mirrorX: true,
  });

  const clip = loadSequence(wsDir).sequence.spine.clips[0];
  assert.equal(clip.placement.x_pct, 15);
  assert.equal(clip.placement.y_pct, -10);
  assert.equal(clip.placement.scale_x, 1.25);
  assert.equal(clip.placement.rotation_deg, 12);
  assert.equal(clip.placement.opacity, 0.8);
  assert.equal(clip.placement.mirror_x, true);

  // Test easing math at t = 0.5 (offset = 500ms on [0..1000ms] range [0.0 -> 1.0])
  const makeEnv = (easing: "linear" | "ease_in" | "ease_out" | "ease_in_out"): ParameterEnvelope => ({
    parameter: "placement.opacity",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 1000, value: 1, easing },
    ],
  });

  assert.equal(evaluateEnvelopeAt(makeEnv("linear"), 500), 0.5);
  assert.equal(evaluateEnvelopeAt(makeEnv("ease_in"), 500), 0.25);
  assert.equal(evaluateEnvelopeAt(makeEnv("ease_out"), 500), 0.75);
  assert.equal(evaluateEnvelopeAt(makeEnv("ease_in_out"), 500), 0.5);
});

test("5. 5-Gate Verifier G1_SCHEMA, G2_ASSETS, G3_TIMING & automatic JournalGuard rollback", () => {
  const { wsDir } = setupFreshWorkspace("spine_editing_gates_1_2_3");
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 2000, sourceOutMs: 4000 });

  const validRev = loadSequence(wsDir).sequence.meta.revision;

  // G202: Attempting to append or trim beyond physical asset duration (8000ms) must throw CUTHOL-G202 and roll back!
  assert.throws(() => {
    trimSpineClip({ workspaceDir: wsDir, clipId: "sp_01", sourceOutMs: 12000 });
  }, /CUTHOL-G202/);
  assert.equal(loadSequence(wsDir).sequence.meta.revision, validRev);

  // G301: Attempting to trim a clip below 2 frames (< 67ms at 30fps) must throw CUTHOL-G301 and roll back!
  assert.throws(() => {
    trimSpineClip({ workspaceDir: wsDir, clipId: "sp_01", sourceInMs: 0, sourceOutMs: 30 });
  }, /CUTHOL-G301/);
  assert.equal(loadSequence(wsDir).sequence.meta.revision, validRev);

  // G303: Transition longer than half of neighbor clip duration (> 1000ms) must throw CUTHOL-G303 and roll back!
  assert.throws(() => {
    setSpineTransition({
      workspaceDir: wsDir,
      clipId: "sp_01",
      transition: { kind: "dissolve", duration_ms: 1500, easing: "ease_in_out" },
    });
  }, /CUTHOL-G303/);
  assert.equal(loadSequence(wsDir).sequence.meta.revision, validRev);

  // G304: Invalid playback rate (32x) must throw CUTHOL-G304
  assert.throws(() => {
    setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", rate: 32.0 });
  }, /CUTHOL-G304/);

  // G305: Envelope point beyond clip duration (3500ms > 2000ms) must throw CUTHOL-G305
  assert.throws(() => {
    setItemEnvelope({
      workspaceDir: wsDir,
      targetId: "sp_01",
      parameter: "placement.opacity",
      points: [{ offset_ms: 3500, value: 1.0, easing: "linear" }],
    });
  }, /CUTHOL-G305/);

  // Direct verifySequence test for G102 (duplicate handle), G103 (dangling asset), G104 (dangling anchor), G302 (spine discontinuity)
  const mutated = structuredClone(loadSequence(wsDir).sequence);
  mutated.spine.clips[1].id = "sp_01"; // duplicate handle G102
  mutated.spine.clips[1].asset_handle = "vid_99"; // dangling asset G103
  mutated.spine.clips[1].timeline_in_ms = 2500; // spine gap G302
  mutated.lanes[0].cues.push({
    ...structuredClone(mutated.spine.clips[0]),
    id: "cue_bad",
    kind: "title",
    anchor: { ref: "sp_missing", offset_ms: 0 },
    at_ms: 0,
    duration_ms: 1000,
    envelopes: [],
  });

  const rep = verifySequence(mutated);
  assert.equal(rep.ok, false);
  const codes = new Set(rep.diagnostics.map((d) => d.code));
  assert.ok(codes.has("CUTHOL-G102"));
  assert.ok(codes.has("CUTHOL-G103"));
  assert.ok(codes.has("CUTHOL-G104"));
  assert.ok(codes.has("CUTHOL-G302"));
});

test("6. G4_STAGE & G5_SIGNAL: Safe zones, BBC caption CPS, z_index occlusion & True Peak", () => {
  const { wsDir } = setupFreshWorkspace("spine_editing_gates_4_5");
  analyzeAssetLoudness({ workspaceDir: wsDir, handle: "vid_01" });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 5000 });

  // 1. Add a title pushed into the bottom 18% social UI chrome (y_pct = +44% on 1920px height) -> G401
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_titles",
    atMs: 0,
    durationMs: 3000,
    yPct: 44,
    text: "Alt Sınır İhlali",
  });

  // 2. Add a fast caption (45 chars in 1000ms = 45 CPS > 17 CPS BBC limit) -> G402
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_captions",
    kind: "caption",
    atMs: 0,
    durationMs: 1000,
    text: "Bu altyazı bir saniye için çok fazla karakter içeriyor!",
  });

  // 3. Add a high-z_index broll layer (`z_index: 50`) covering the title at the same time & position -> G403
  const { paths, sequence } = loadSequence(wsDir);
  sequence.lanes.push({
    id: "ln_top_blocker",
    kind: "broll",
    z_index: 50,
    muted: false,
    locked: false,
    cues: [
      {
        id: "cue_blocker",
        kind: "broll",
        asset_handle: "vid_01",
        anchor: null,
        at_ms: 0,
        duration_ms: 3000,
        placement: {
          x_pct: 0,
          y_pct: 40,
          scale_x: 1,
          scale_y: 1,
          rotation_deg: 0,
          opacity: 1,
          fit_mode: "cover",
          crop: null,
          mirror_x: false,
          mirror_y: false,
        },
        envelopes: [],
      },
    ],
  });

  // 4. Boost spine clip gain_db by +20 dB without loudness normalization -> exceeds -1.0 dBTP ceiling (G501)
  sequence.spine.clips[0].audio_chain.gain_db = 20.0;

  const box = measureCuePixelBox(sequence.stage, sequence.lanes.find((l) => l.id === "ln_titles")!.cues[0]);
  assert.ok(box.width > 100 && box.height > 40);

  const report = verifySequence(sequence, paths);
  const warnCodes = new Set(report.diagnostics.map((d) => d.code));
  assert.ok(warnCodes.has("CUTHOL-G401"), `Expected G401 safe zone warning, got ${JSON.stringify(report.diagnostics)}`);
  assert.ok(warnCodes.has("CUTHOL-G402"), `Expected G402 caption CPS warning`);
  assert.ok(warnCodes.has("CUTHOL-G403"), `Expected G403 text occlusion warning`);
  assert.ok(warnCodes.has("CUTHOL-G501"), `Expected G501 true peak warning`);
});

test("7. Declarative Cue Sheet diff, plan (dry-run), apply, export & cross-lane handle preservation", () => {
  const { wsDir } = setupFreshWorkspace("spine_editing_cuesheet");

  const sheet1: CutholCueSheet = {
    title: "Cue Sheet Sahnesi",
    spine: [
      {
        id: "sp_01",
        asset_handle: "vid_01",
        source_in_ms: 0,
        source_out_ms: 3000,
        denoise: true,
        transition_out: { kind: "dissolve", duration_ms: 400, easing: "ease_in_out" },
      },
      {
        id: "sp_02",
        asset_handle: "vid_01",
        source_in_ms: 3000,
        source_out_ms: 6000,
      },
    ],
    cues: [
      {
        id: "cue_01",
        lane_id: "ln_titles",
        kind: "title",
        anchor: { ref: "sp_01", offset_ms: 200 },
        duration_ms: 2000,
        typography: { text: "Giriş Başlığı" },
      },
    ],
  };

  // Dry-run plan must not mutate disk revision
  const planRes = planCueSheet(wsDir, sheet1);
  assert.equal(planRes.would_commit, true);
  assert.deepEqual(planRes.diff.spine_added, ["sp_01", "sp_02"]);
  assert.deepEqual(planRes.diff.cues_added, ["cue_01"]);
  assert.equal(loadSequence(wsDir).sequence.spine.clips.length, 0);

  // Apply sheet1
  const applyRes = applyCueSheet(wsDir, sheet1);
  assert.equal(applyRes.verification.ok, true);
  assert.equal(loadSequence(wsDir).sequence.spine.clips.length, 2);

  // Move cue_01 from ln_titles to ln_captions while keeping id="cue_01", and delete sp_02
  const sheet2: CutholCueSheet = {
    spine: [{ id: "sp_02", op: "delete" }],
    cues: [
      {
        id: "cue_01",
        lane_id: "ln_captions",
        kind: "caption",
        typography: { text: "Altyazıya Taşındı" },
      },
    ],
  };

  const applyRes2 = applyCueSheet(wsDir, sheet2);
  assert.deepEqual(applyRes2.diff.spine_removed, ["sp_02"]);
  assert.deepEqual(applyRes2.diff.cues_updated, ["cue_01"]);

  const seqAfter = loadSequence(wsDir).sequence;
  assert.equal(seqAfter.spine.clips.length, 1);
  assert.equal(seqAfter.lanes.find((l) => l.id === "ln_titles")!.cues.length, 0);
  assert.equal(seqAfter.lanes.find((l) => l.id === "ln_captions")!.cues[0].id, "cue_01");

  // Export back to CueSheet and verify round-trip diff has 0 additions/removals
  const exported = exportSequenceToCueSheet(seqAfter);
  const { diff: roundTripDiff } = mergeCueSheetIntoSequence(seqAfter, exported);
  assert.equal(roundTripDiff.spine_added.length, 0);
  assert.equal(roundTripDiff.cues_added.length, 0);
  assert.equal(roundTripDiff.spine_removed.length, 0);
  assert.equal(roundTripDiff.cues_removed.length, 0);
});

test("8. Dual-clock (source_ms <-> sequence_ms) transcript projection, source-space excise on trimmed+sped-up clip, and EN(17 CPS) vs TR(19 CPS)", () => {
  const { wsDir } = setupFreshWorkspace("spine_editing_dual_clock_and_cps");

  // sp_01: 1500ms intro (0..1500ms)
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 1500 });
  // sp_02: trimmed [2000..8000ms] (6000ms source span), sped up to 1.5x -> duration = 4000ms, timeline = 1500..5500ms
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 2000, sourceOutMs: 8000 });
  setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_02", rate: 1.5 });

  let seq = loadSequence(wsDir).sequence;
  const sp2 = seq.spine.clips[1];
  assert.equal(sp2.timeline_in_ms, 1500);
  assert.equal(sp2.duration_ms, 4000);

  // Verify bidirectional coordinate math on trimmed + shifted + 1.5x sped-up clip:
  // Source 3500ms is +1500ms into clip source -> at 1.5x that is +1000ms on timeline -> sequence = 1500 + 1000 = 2500ms
  assert.equal(sourceMsToSequenceMs(sp2, 3500), 2500);
  assert.equal(sequenceMsToSourceMs(sp2, 2500), 3500);

  // Project raw ASR words (measured on full 0..8000ms file) onto sp_02 [2000..8000ms @ 1.5x]
  const projectedWords = projectTranscriptWordsToClip(sp2, [
    { word: "erken", source_start_ms: 500, source_end_ms: 1200 }, // outside sp_02 -> filtered out
    { word: "merhaba", source_start_ms: 2000, source_end_ms: 2600 }, // -> seq 1500..1900ms
    { word: "dünya", source_start_ms: 5000, source_end_ms: 5900 }, // -> seq 3500..4100ms
  ]);
  assert.equal(projectedWords.length, 2);
  assert.deepEqual(projectedWords[0], {
    word: "merhaba",
    source_start_ms: 2000,
    source_end_ms: 2600,
    sequence_start_ms: 1500,
    sequence_end_ms: 1900,
    clip_id: "sp_02",
    excised: false,
    confidence: undefined,
  });
  assert.deepEqual(projectedWords[1], {
    word: "dünya",
    source_start_ms: 5000,
    source_end_ms: 5900,
    sequence_start_ms: 3500,
    sequence_end_ms: 4100,
    clip_id: "sp_02",
    excised: false,
    confidence: undefined,
  });

  // Anchor a cue to sp_02 at local offset +3000ms (which corresponds to source 2000 + 3000*1.5 = 6500ms)
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_titles",
    anchor: { ref: "sp_02", offset_ms: 3000 },
    durationMs: 800,
    text: "Kaynak 6500ms Noktası",
  });

  // Now excise a transcript pause in SOURCE coordinates: [3500ms .. 5000ms] from sp_02!
  const exRes = exciseSpineRanges({
    workspaceDir: wsDir,
    clipId: "sp_02",
    ranges: [{ start_ms: 3500, end_ms: 5000 }],
    coordinateSpace: "source",
  });
  assert.equal(exRes.remainingClips.length, 2);
  // First part: source 2000..3500ms (1500ms / 1.5x = 1000ms duration, timeline 1500..2500ms)
  assert.equal(exRes.remainingClips[0].id, "sp_02");
  assert.equal(exRes.remainingClips[0].source_in_ms, 2000);
  assert.equal(exRes.remainingClips[0].source_out_ms, 3500);
  assert.equal(exRes.remainingClips[0].duration_ms, 1000);
  // Second part: source 5000..8000ms (3000ms / 1.5x = 2000ms duration, timeline 2500..4500ms)
  assert.equal(exRes.remainingClips[1].id, "sp_03");
  assert.equal(exRes.remainingClips[1].source_in_ms, 5000);
  assert.equal(exRes.remainingClips[1].source_out_ms, 8000);
  assert.equal(exRes.remainingClips[1].duration_ms, 2000);

  // Verify the cue at source 6500ms automatically re-anchored to sp_03 with offset (6500-5000)/1.5 = 1000ms (timeline 3500ms)!
  seq = loadSequence(wsDir).sequence;
  const reanchoredCue = seq.lanes.find((l) => l.id === "ln_titles")!.cues[0];
  assert.deepEqual(reanchoredCue.anchor, { ref: "sp_03", offset_ms: 1000 });
  assert.equal(reanchoredCue.at_ms, 3500);

  // Verify EN (17 CPS Netflix) vs TR (19 CPS Turkish adaptation) and that G4 warnings DO NOT block commit!
  // 18 chars in 1000ms = 18.0 CPS:
  // - Turkish ("Çok güzel bir gün!" = 18 chars) <= 19 CPS -> 0 warnings
  const trCue = addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_captions",
    kind: "caption",
    atMs: 0,
    durationMs: 1000,
    text: "Çok güzel bir gün!",
  });
  assert.ok(!trCue.verification.diagnostics.some((d) => d.code === "CUTHOL-G402"));

  // - English ("A very nice today!" = 18 chars) > 17 CPS -> emits G402 WARN, but STILL commits (ok: true)!
  const enCue = addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_captions",
    kind: "caption",
    atMs: 1200,
    durationMs: 1000,
    text: "A very nice today!",
  });
  assert.equal(enCue.verification.ok, true);
  assert.ok(enCue.verification.diagnostics.some((d) => d.code === "CUTHOL-G402"));
});
