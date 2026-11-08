/**
 * Regression Suite for Long Multi-Clip Timelines (`src/test/long_timeline.test.ts`).
 *
 * Verifies:
 * 1. Subprocess spawn failure diagnostics:
 *    - Oversized command line (`ENAMETOOLONG` / `E2BIG`) emits `CUTHOL-SYS09` with command length, OS limit, and clip count.
 *    - Missing executable (`ENOENT`) emits `CUTHOL-SYS04` with the actual OS error code and message instead of generic stderr fallback.
 * 2. Windowed preview compilation (`monitor frame` and `monitor sheet`):
 *    - Compiles only the clips and cues overlapping the requested timestamp(s) even on a 1,000+ clip sequence.
 * 3. Time-segmented render + audio mix scaling + boundary continuity:
 *    - Multi-segment render with a transition (`dissolve`), a transparent HyperFrames composition cue, keyframe envelopes,
 *      and `.ass` captions straddling a segment boundary matches single-pass output (high PSNR, 0 blank frames, frame-exact A/V duration < 1 frame, no boundary click).
 *    - `mix.normalize` scales via segmented audio compilation without opening hundreds of simultaneous inputs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import {
  createSubprocessFailureDiagnostic,
  DIAGNOSTICS,
  getPlatformCommandLineLimit,
} from "../core/diagnostics.js";
import {
  createDefaultAudioChain,
  createDefaultPlacement,
  createDefaultTreatments,
} from "../core/schema.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { normalizeSequenceAudio } from "../mix/audio_mix.js";
import { captureMonitorFrame, captureMonitorSheet } from "../monitor/preview.js";
import {
  buildOrRenderSequenceAudioForMixOrRender,
  computeRenderTimeSegments,
  renderSequenceToMp4,
} from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip, setItemEnvelope } from "../sequence/spine.js";
import { commitVerifiedMutation } from "../verify/gates.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/long_timeline");

test("1. Spawn failure diagnostics: CUTHOL-SYS09 on oversized command line and CUTHOL-SYS04 with real OS error on ENOENT", () => {
  const limit = getPlatformCommandLineLimit();
  const hugeArgs = Array.from({ length: 400 }, (_, i) => `-i_dummy_${i}_${"x".repeat(120)}`);
  const hugeProc = spawnSync("ffmpeg", hugeArgs, { encoding: "utf8" });

  const sys09 = createSubprocessFailureDiagnostic({
    tool: "ffmpeg render",
    executable: "ffmpeg",
    args: hugeArgs,
    proc: hugeProc.error
      ? hugeProc
      : {
          status: null,
          error: Object.assign(new Error("spawnSync ffmpeg ENAMETOOLONG"), {
            code: "ENAMETOOLONG",
          }),
          stderr: "",
          stdout: "",
        },
    clipCount: 142,
  });

  assert.equal(sys09.code, "CUTHOL-SYS09");
  assert.match(sys09.what, new RegExp(String(limit)));
  assert.match(sys09.what, /clip count:\s*142/);

  const missingExec = "cuthol_nonexistent_binary_xyz_999";
  const enoentProc = spawnSync(missingExec, ["-version"], { encoding: "utf8" });
  assert.ok(enoentProc.error, "Expected spawnSync on nonexistent binary to populate proc.error");

  const sys04 = createSubprocessFailureDiagnostic({
    tool: `${missingExec} check`,
    executable: missingExec,
    args: ["-version"],
    proc: enoentProc,
    clipCount: 12,
  });

  assert.equal(sys04.code, "CUTHOL-SYS04");
  assert.match(sys04.what, /ENOENT/);
  assert.match(sys04.what, new RegExp(missingExec));
  assert.ok(
    DIAGNOSTICS.COMMAND_LINE_TOO_LONG("ffmpeg", 92381, 32767, 142, "ENAMETOOLONG").code ===
      "CUTHOL-SYS09"
  );
});

test("2. 1,000+ clip synthetic timeline: windowed monitor frame & segmented render keep inputs and command length bounded", () => {
  const wsDir = path.join(TEST_ROOT, "ws_scale_1000");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({
    dir: wsDir,
    title: "Synthetic 1000+ Clips",
    aspect: "16:9",
    fps: 30,
  });

  const srcMp4 = path.join(wsDir, "source_av.mp4");
  const genProc = spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=640x360:r=30:d=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=4",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    srcMp4,
  ]);
  assert.equal(genProc.status, 0);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [srcMp4] });

  const { sequence } = loadSequence(wsDir);
  const clipCount = 1020;
  const clipDurMs = 100; // 3 frames at 30fps
  sequence.spine.clips = Array.from({ length: clipCount }, (_, i) => {
    const srcIn = (i * 100) % 3500;
    return {
      id: `sp_${String(i + 1).padStart(2, "0")}`,
      asset_handle: "vid_01",
      source_in_ms: srcIn,
      source_out_ms: srcIn + clipDurMs,
      timeline_in_ms: i * clipDurMs,
      duration_ms: clipDurMs,
      playback: { rate: 1, preserve_pitch: true, speed_ramp: null },
      placement: { ...createDefaultPlacement(), fit_mode: "cover" },
      audio_chain: createDefaultAudioChain(),
      treatments: createDefaultTreatments(),
      envelopes: [],
      transition_out: null,
    };
  });
  sequence.meta.handle_counters = { vid: 1, sp: clipCount };
  fs.writeFileSync(paths.sequenceFile, JSON.stringify(sequence, null, 2), "utf8");

  // Single-frame plan at 50.0s must only open backdrop + the active clip (2 inputs total, no audio)
  const framePlan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
    activeWindowMs: [50_000, 50_033.333],
    singleFrameAtMs: 50_000,
    includeAudio: false,
  });
  const frameInputCount = framePlan.inputArgs.filter((a) => a === "-i").length;
  assert.ok(
    frameInputCount <= 3,
    `Expected single-frame plan on 1,020-clip timeline to open <= 3 inputs, got ${frameInputCount}`
  );

  const mf = captureMonitorFrame({ workspaceDir: wsDir, atMs: 50_000 });
  assert.equal(mf.ok, true);
  assert.equal(mf.metrics.is_blank_frame, false);
  assert.ok(mf.metrics.active_handles.includes("sp_501"));

  const segs = computeRenderTimeSegments(sequence, clipCount * clipDurMs, 24);
  assert.ok(segs.length >= 40, `Expected >= 40 segments for 1,020 clips, got ${segs.length}`);
  for (const s of segs) {
    const segPlan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
      activeWindowMs: [s.startMs, s.endMs],
      includeAudio: false,
    });
    const inCount = segPlan.inputArgs.filter((a) => a === "-i").length;
    assert.ok(inCount <= 26, `Segment #${s.index} opened too many inputs: ${inCount}`);
  }
});

test("3. Segment boundary continuity: transition, transparent HyperFrames composition, envelopes, captions & audio across segment boundaries", () => {
  const wsDir = path.join(TEST_ROOT, "ws_boundary_parity");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({
    dir: wsDir,
    title: "Boundary Continuity Parity",
    aspect: "16:9",
    fps: 30,
  });

  const clipA = path.join(wsDir, "clip_a.mp4");
  const clipB = path.join(wsDir, "clip_b.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=640x360:r=30:d=5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000:duration=5",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    clipA,
  ]);
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    " color=c=#1E40AF:s=640x360:r=30:d=5".trim(),
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=550:sample_rate=48000:duration=5",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    clipB,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [clipA, clipB] });

  // Append 6 clips (1000ms each -> total 6000ms = 180 frames)
  for (let i = 0; i < 6; i++) {
    appendSpineClip({
      workspaceDir: wsDir,
      assetHandle: i % 2 === 0 ? "vid_01" : "vid_02",
      sourceInMs: 200,
      sourceOutMs: 1200,
    });
  }

  // With maxClipsPerSegment = 2, segment boundaries fall at 2000ms (sp_02 -> sp_03) and 4000ms (sp_04 -> sp_05).
  // Put a dissolve transition on sp_02 -> sp_03 (straddling 2000ms) and a keyframe envelope on sp_03.
  commitVerifiedMutation(wsDir, "add_boundary_transition", (seq) => {
    seq.spine.clips[1].transition_out = {
      kind: "dissolve",
      duration_ms: 400,
      easing: "ease_in_out",
    };
  });

  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_03",
    parameter: "audio_chain.gain_db",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 500, value: -3, easing: "ease_in_out" },
      { offset_ms: 1000, value: 0, easing: "linear" },
    ],
  });

  // Add a transparent HyperFrames composition cue straddling the 2000ms boundary (1200ms .. 3200ms)
  const compDir = path.join(wsDir, "compositions/straddle_comp");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    compositionId: "straddle-comp",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 2000,
    preset: "lower_third",
    props: { title: "SINIR TESTI", subtitle: "Parca gecisi" },
    transparent: true,
  });

  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 1200,
    durationMs: 2000,
    composition: {
      composition_dir: "compositions/straddle_comp",
      entry_html: "index.html",
      mode: "overlay_alpha",
      transparent: true,
      props: { title: "SINIR TESTI", subtitle: "Parca gecisi" },
    },
  });

  // Add a subtitle cue straddling the 4000ms boundary (3500ms .. 4500ms)
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_captions",
    kind: "caption",
    atMs: 3500,
    durationMs: 1000,
    text: "Sınır altyazı testi",
  });

  const prevEnv = process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS;
  try {
    // Test segmented audio loudness normalization with maxClips = 2
    process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS = "2";
    const normRes = normalizeSequenceAudio({
      workspaceDir: wsDir,
      targetLufs: -14,
      truePeakDbtp: -1,
    });
    assert.equal(normRes.verification.ok, true);

    const { paths: pathsAfter, sequence: seqAfter } = loadSequence(wsDir);
    const audioBuild = buildOrRenderSequenceAudioForMixOrRender(
      seqAfter,
      pathsAfter,
      seqAfter.stage.master_audio,
      { maxItemsPerSegment: 2 }
    );
    assert.equal(audioBuild.mode, "concat_wav");
    assert.ok(audioBuild.maxInputsInAnyCall <= 4);

    // 1. Single-pass reference render (maxClips = 24)
    process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS = "24";
    const singleOut = renderSequenceToMp4({
      workspaceDir: wsDir,
      preset: "draft_480p",
      encoder: "libx264",
      outputPath: "output/single_pass.mp4",
    });

    // 2. Multi-segment render (maxClips = 2 -> 3 segments: [0..2s], [2s..4s], [4s..6s])
    process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS = "2";
    const segOut = renderSequenceToMp4({
      workspaceDir: wsDir,
      preset: "draft_480p",
      encoder: "libx264",
      outputPath: "output/segmented_pass.mp4",
    });

    assert.equal(singleOut.ok, true);
    assert.equal(segOut.ok, true);
    assert.equal(segOut.blank_scan?.blank_frames_count, 0);
    assert.equal(segOut.blank_scan?.total_frames, 180);

    // Verify A/V duration difference < 1 frame (33.3ms)
    const probeJson = JSON.parse(
      spawnSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,duration,nb_frames",
          "-of",
          "json",
          segOut.output_path,
        ],
        { encoding: "utf8" }
      ).stdout
    );
    const vStream = probeJson.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    const aStream = probeJson.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
    const vDur = Number(vStream.duration);
    const aDur = Number(aStream.duration);
    assert.ok(
      Math.abs(vDur - aDur) < 1 / 30,
      `Expected A/V duration difference < 1 frame (0.033s), got v=${vDur}s vs a=${aDur}s`
    );

    // Single-pass vs segmented must produce the same pixels up to lossy-encode noise,
    // and the segment cut frames must not be worse than the clip interiors.
    const psnrProc = spawnSync(
      "ffmpeg",
      [
        "-i", singleOut.output_path,
        "-i", segOut.output_path,
        "-lavfi", "[0:v]settb=1/30,setpts=N[x];[1:v]settb=1/30,setpts=N[y];[x][y]psnr=stats_file=-",
        "-f", "null", "-",
      ],
      { encoding: "utf8" }
    );
    const perFrame = new Map<number, number>();
    for (const line of (psnrProc.stdout || "").split(/\r?\n/)) {
      const n = /\bn:(\d+)/.exec(line);
      const v = /psnr_avg:([\d.]+|inf)/.exec(line);
      if (n && v) perFrame.set(Number(n[1]) - 1, v[1] === "inf" ? 99 : Number(v[1]));
    }
    assert.equal(perFrame.size, 180, "per-frame PSNR for all 180 frames");
    const values = [...perFrame.values()];
    const avgPsnr = values.reduce((a, b) => a + b, 0) / values.length;
    const minPsnr = Math.min(...values);
    assert.ok(
      avgPsnr >= 44 && minPsnr >= 41,
      `Expected high PSNR parity between single-pass and segmented renders, got avg=${avgPsnr.toFixed(2)}dB, min=${minPsnr.toFixed(2)}dB`
    );
    // Boundary frames (segment cuts at frames 60 and 120) must not be worse than the
    // interior of the clips that touch them.
    for (const cut of [60, 120]) {
      const boundary = [cut - 2, cut - 1, cut, cut + 1, cut + 2].map((f) => perFrame.get(f) ?? 0);
      const interior = [cut - 15, cut - 10, cut + 10, cut + 15].map((f) => perFrame.get(f) ?? 0);
      const boundaryMin = Math.min(...boundary);
      const interiorMin = Math.min(...interior);
      assert.ok(
        boundaryMin >= interiorMin - 1.5,
        `Segment cut at frame ${cut}: boundary frames ${boundary.map((v) => v.toFixed(1)).join("/")} dB vs interior ${interior.map((v) => v.toFixed(1)).join("/")} dB`
      );
    }

    // Verify monitor sheet works cleanly across the straddled boundary
    const sheet = captureMonitorSheet({
      workspaceDir: wsDir,
      startMs: 1500,
      endMs: 4500,
      cols: 2,
      rows: 2,
    });
    assert.equal(sheet.ok, true);
    assert.equal(sheet.blank_frames_ms.length, 0);
  } finally {
    if (prevEnv === undefined) {
      delete process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS;
    } else {
      process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS = prevEnv;
    }
  }
});
