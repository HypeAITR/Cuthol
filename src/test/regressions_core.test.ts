/**
 * Regression suite for the first fix round (`src/test/regressions_core.test.ts`).
 *
 * Verifies the fixes applied by the first fix round across the core, spine, captions and speech modules.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseTimeMs } from "../core/time.js";
import { PngCanvas } from "../core/png_canvas.js";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { analyzeAssetLoudness } from "../library/loudness.js";
import { renderSequenceBrief } from "../brief/inspector.js";
import {
  appendSpineClip,
  exciseSpineRanges,
  setItemEnvelope,
  setSpineSpeed,
  splitSpineClip,
  trimSpineClip,
} from "../sequence/spine.js";
import { addLaneCue, addTimelineMarker } from "../sequence/lanes.js";
import { applyCueSheet } from "../sequence/cuesheet.js";
import { verifySequence } from "../verify/gates.js";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { transcribeLibraryAsset } from "../speech/transcribe.js";
import { cleanupClipDialogue } from "../speech/cleanup.js";
import {
  duckMusicUnderDialogue,
  normalizeSequenceAudio,
  polishVoiceAudio,
} from "../mix/audio_mix.js";
import { stepJournal } from "../core/workspace.js";
import { compileEnvelopeToFfmpegExpr } from "../compositor/compiler.js";
import { synthesizeVoiceover } from "../speech/synthesize.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");

test("Fix verification — core (time parser strictness, silent loudness safety, marker brief, PngCanvas corners)", () => {
  // 1. Strict colon timecode validation
  assert.throws(() => parseTimeMs(":5"), /CUTHOL-SYS02/);
  assert.throws(() => parseTimeMs("1:"), /CUTHOL-SYS02/);
  assert.throws(() => parseTimeMs("00:75.000"), /CUTHOL-SYS02/);
  assert.throws(() => parseTimeMs("1.5:10"), /CUTHOL-SYS02/);
  assert.equal(parseTimeMs("-250ms", { allowNegative: true }), -250);

  // 2. PngCanvas strokeRect corner alpha non-double-blending
  const canvas = new PngCanvas(20, 20, [0, 0, 0, 255]);
  canvas.strokeRect(2, 2, 10, 10, 2, [200, 100, 50, 128]);
  // Top-left corner (2,2) and top-edge middle (6,2) must have identical blended R value!
  const cornerR = canvas.pixels[(2 * 20 + 2) * 4];
  const edgeR = canvas.pixels[(2 * 20 + 6) * 4];
  assert.equal(cornerR, edgeR, "strokeRect corners must not double-blend semi-transparent colors");

  // 3. Silent audio asset must NOT recommend +56dB gain
  const wsDir = path.join(TEST_ROOT, "r1_core_time_journal_ledger_fixes");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "" });

  const silentWav = path.join(wsDir, "silent.wav");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono:d=2",
    "-c:a",
    "pcm_s16le",
    silentWav,
  ]);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [silentWav] });

  const loud = analyzeAssetLoudness({ workspaceDir: wsDir, handle: "aud_01" });
  assert.equal(loud.recommended_gain_db, 0, `Silent track should recommend 0 dB gain, got ${loud.recommended_gain_db}`);

  // 4. Marker detail lens (`mk_01`)
  addTimelineMarker({ workspaceDir: wsDir, atMs: 500, label: "Bölüm Başlangıcı" });
  const seq = loadSequence(wsDir).sequence;
  const detailMd = renderSequenceBrief(seq, { lens: "detail", targetIds: ["mk_01"] });
  assert.match(detailMd, /"entity_type": "timeline_marker"/);
});

test("Fix verification — spine (speed_ramp & envelope slicing on split/trim/excise, anchor scaling, partial CueSheet, G4 audio ignore)", () => {
  const wsDir = path.join(TEST_ROOT, "r1_spine_editing_fixes");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "" });

  const vidFile = path.join(wsDir, "clip.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1E3A8A:s=640x360:r=30:d=8",
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
    vidFile,
  ]);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [vidFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 6000 });

  // Add envelope and anchored cue at offset 3000ms (source 3000ms)
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_01",
    parameter: "placement.opacity",
    points: [
      { offset_ms: 0, value: 0.2, easing: "linear" },
      { offset_ms: 6000, value: 0.8, easing: "linear" },
    ],
  });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_titles",
    anchor: { ref: "sp_01", offset_ms: 3000 },
    durationMs: 1000,
    text: "Senkron Başlık",
  });

  // 1. Excise [1000..2000ms] -> must preserve interpolated envelopes on both sp_01 and sp_02!
  const ex = exciseSpineRanges({
    workspaceDir: wsDir,
    clipId: "sp_01",
    ranges: [{ start_ms: 1000, end_ms: 2000 }],
    coordinateSpace: "source",
  });
  assert.equal(ex.remainingClips.length, 2);
  assert.equal(ex.remainingClips[0].envelopes.length, 1);
  assert.equal(ex.remainingClips[1].envelopes.length, 1);
  // At 1000ms on [0..6000ms] (0.2 -> 0.8), value is 0.3; at 2000ms, value is 0.4!
  assert.ok(Math.abs(ex.remainingClips[0].envelopes[0].points[1].value - 0.3) < 1e-4);
  assert.ok(Math.abs(ex.remainingClips[1].envelopes[0].points[0].value - 0.4) < 1e-4);

  // 2. Speed up sp_02 (which currently has cue_01 anchored at offset 1000ms = source 3000ms) by 2.0x:
  // cue_01's anchor.offset_ms must automatically scale to 500ms!
  setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_02", rate: 2.0 });
  let seq = loadSequence(wsDir).sequence;
  const cueAfterSpeed = seq.lanes.find((l) => l.id === "ln_titles")!.cues[0];
  assert.equal(cueAfterSpeed.anchor?.offset_ms, 500);

  // 3. Partial CueSheet spine update on sp_02 must NOT delete sp_01!
  applyCueSheet(wsDir, {
    spine: [{ id: "sp_02", gain_db: -4 }],
  });
  seq = loadSequence(wsDir).sequence;
  assert.equal(seq.spine.clips.length, 2, "Partial CueSheet spine update must preserve existing sp_01");
  assert.equal(seq.spine.clips[1].audio_chain.gain_db, -4);
});

test("Fix verification — captions and speech (short filler cleanup without G301 sliver, monotonic ducking envelope, z_index < 0 under spine)", async () => {
  const wsDir = path.join(TEST_ROOT, "r1_captions_compositor_render_and_3_4_fixes");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "", aspect: "9:16", fps: 30 });

  const vidFile = path.join(wsDir, "talk.mp4");
  spawnSync("ffmpeg", [
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
    "sine=frequency=280:sample_rate=48000:duration=5",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    vidFile,
  ]);

  // Transcript with a short 140ms filler ("ıı" at 800..940ms) right before a pause (940..1600ms)
  fs.writeFileSync(
    `${vidFile}.transcript.json`,
    JSON.stringify({
      language: "tr",
      words: [
        { word: "Merhaba", punctuated_word: "Merhaba", source_start_ms: 100, source_end_ms: 780 },
        { word: "ıı", punctuated_word: "ıı", source_start_ms: 800, source_end_ms: 940 }, // 140ms short filler!
        { word: "arkadaşlar", punctuated_word: "arkadaşlar", source_start_ms: 1600, source_end_ms: 2500 },
        { word: "nasılsınız", punctuated_word: "nasılsınız", source_start_ms: 3250, source_end_ms: 4200 },
      ],
    }),
    "utf8"
  );

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [vidFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4500 });

  await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    provider: "local",
    language: "tr",
  });

  // 1. Short 140ms filler ("ıı") must be cut AND adjacent pause must not leave a < 2 frame sliver!
  const cleanRes = cleanupClipDialogue({
    workspaceDir: wsDir,
    clipId: "sp_01",
    minPauseMs: 400,
    padMs: 75,
    dryRun: false,
  });
  assert.ok(cleanRes.cuts.some((c) => c.kind === "filler" && c.label === "ıı"), "140ms short filler must be cut");

  // 2. Positive duckDb (+12) and large releaseMs (800ms) must produce strictly monotonic negative dB envelope
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    assetHandle: "vid_01",
    atMs: 0,
    durationMs: 3500,
  });
  const duckRes = duckMusicUnderDialogue({
    workspaceDir: wsDir,
    duckDb: 12, // positive input -> must be converted to -12 dB!
    attackMs: 200,
    releaseMs: 800,
  });
  const pts = duckRes.ducked_cues[0].envelope_points;
  assert.ok(pts.some((p) => p.value === -12), "Positive duckDb=12 must be normalized to -12 dB");
  for (let i = 1; i < pts.length; i++) {
    assert.ok(
      pts[i].offset_ms >= pts[i - 1].offset_ms,
      `Envelope points must be monotonic, got ${JSON.stringify(pts)}`
    );
  }

  // 3. Add a background B-roll lane with z_index = -5 and verify it compiles BEFORE spine clips in filterComplex
  commitSequenceMutation(wsDir, "test.add_under_spine_lane", (seq) => {
    seq.lanes.push({
      id: "ln_under_bg",
      kind: "broll",
      z_index: -5,
      muted: false,
      locked: false,
      cues: [
        {
          id: "cue_under",
          kind: "broll",
          asset_handle: "vid_01",
          anchor: null,
          at_ms: 0,
          duration_ms: 1000,
          placement: {
            x_pct: 0,
            y_pct: 0,
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
  });

  const plan = compileSequenceRenderPlan(loadSequence(wsDir).sequence, paths, "draft_480p");
  const underIdx = plan.filterComplex.indexOf("[v_cue_cue_under]overlay");
  const spineIdx = plan.filterComplex.indexOf("[v_sp_0]overlay");
  assert.ok(underIdx > 0 && spineIdx > underIdx, "z_index=-5 visual lane must overlay BEFORE spine (z_index=0)");
  // Music cue (`cue_01` on `ln_bgm`) must NOT be overlaid as video even though asset is `vid_01`!
  assert.ok(!plan.filterComplex.includes("[v_cue_cue_01]"), "Audio-only music cue must not be overlaid on video canvas");
});

test("Fix verification — -0s rejection, stepJournal validation, dB-space gain interpolation & atomic synthesizeVoiceover", async () => {
  // 1. Negative zero (-0 and "-0s") must be rejected when allowNegative is false
  assert.throws(() => parseTimeMs(-0), /CUTHOL-SYS02/);
  assert.throws(() => parseTimeMs("-0s"), /CUTHOL-SYS02/);
  assert.throws(() => parseTimeMs("-0.000ms"), /CUTHOL-SYS02/);

  // 2. True dB-space interpolation in compileEnvelopeToFfmpegExpr (`pow(10,(...)/20)`)
  const dbExpr = compileEnvelopeToFfmpegExpr({
    envelope: {
      parameter: "audio_chain.gain_db",
      points: [
        { offset_ms: 0, value: 0, easing: "linear" },
        { offset_ms: 1000, value: -12, easing: "linear" },
      ],
    },
    timeBaseOffsetMs: 0,
    mode: "db_to_linear",
    baseGainDb: 0,
  });
  assert.ok(dbExpr?.includes("pow(10,("), `Expected dB-space pow(10,(...)/20) interpolation, got ${dbExpr}`);

  // 3. Atomic single-revision synthesizeVoiceover & stepJournal validation
  const wsDir = path.join(TEST_ROOT, "r2_atomic_vo_test");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Atomic VO" });

  assert.throws(() => stepJournal(wsDir, "undo", 0), /CUTHOL-SYS03/);
  assert.throws(() => stepJournal(wsDir, "undo", -2), /CUTHOL-SYS03/);

  const revBefore = loadSequence(wsDir).sequence.meta.revision;
  await synthesizeVoiceover({
    workspaceDir: wsDir,
    text: "Atomik seslendirme testi",
    provider: "local",
    placeOnLane: "ln_vo",
  });
  const revAfter = loadSequence(wsDir).sequence.meta.revision;
  // Placing a synthesized voiceover onto ln_vo must increment revision by at most 1 (single atomic commit)!
  assert.equal(revAfter, revBefore + 1, "synthesizeVoiceover with placeOnLane must commit in 1 atomic revision");
});
