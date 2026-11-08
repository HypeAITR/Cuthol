/**
 * Comprehensive Unit & End-to-End Verification Suite (`src/test/captions_compositor_render.test.ts`).
 *
 * Tests:
 * 1. `.ass` Typography, Turkish UTF-8 & Active-Word Highlight Compiler (`ass_generator.ts`)
 * 2. HyperFrames Scaffolding, `/hyperframes-core` Contract Validator & CLI `npx hyperframes lint` (`hyperframes_bridge.ts`)
 * 3. Multi-Layer Compositor Filter-Graph & Audio Chain Compilation (`compiler.ts`)
 * 4. Monitor Blank-Frame Detection (`CUTHOL-G502`) vs Active Frame Telemetry (`preview.ts`)
 * 5. End-to-End Multi-Layer Render (Spine + PIP B-Roll + HyperFrames Composition + Turkish Active-Word Captions + BGM -> `monitor sheet`, `monitor frame` & `render master_1080p`)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  compileTypographyAssFile,
  formatAssTime,
  hexToAssColor,
} from "../compositor/ass_generator.js";
import {
  scaffoldHyperFramesComposition,
  validateHyperFramesCompositionContract,
} from "../compositor/hyperframes_bridge.js";
import {
  compileEnvelopeToFfmpegExpr,
  compileSequenceRenderPlan,
  escapeFfmpegFilterPath,
} from "../compositor/compiler.js";
import { verifySequence } from "../verify/gates.js";
import { captureMonitorFrame, captureMonitorSheet } from "../monitor/preview.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import {
  appendSpineClip,
  exciseSpineRanges,
  integrateSourceOffsetToClipLocalMs,
  invertClipLocalMsToSourceOffset,
  projectTranscriptAcrossSequence,
  sequenceMsToSourceMs,
  setItemEnvelope,
  setSpineSpeed,
  setSpineTransition,
  sourceMsToSequenceMs,
} from "../sequence/spine.js";
import { addLaneCue } from "../sequence/lanes.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");

test("1. ASS Typography, Turkish UTF-8 & Active-Word Highlight Compiler", () => {
  assert.equal(hexToAssColor("#38BDF8", 1.0), "&H00F8BD38");
  assert.equal(hexToAssColor("#FFFFFF", 0.0), "&HFFFFFFFF");
  assert.equal(formatAssTime(62450), "0:01:02.45");

  const wsDir = path.join(TEST_ROOT, "captions_compositor_render_ass_unit");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "ASS Test", aspect: "9:16", fps: 30 });

  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_titles",
    kind: "title",
    atMs: 500,
    durationMs: 2500,
    yPct: -35,
    text: "Türkçe Başlık: Şığüöçİ",
  });

  // Add caption with word-level active highlight tokens
  commitSequenceMutation(wsDir, "test.add_karaoke_caption", (seq) => {
    const capLane = seq.lanes.find((l) => l.id === "ln_captions")!;
    capLane.cues.push({
      id: "cue_cap_1",
      kind: "caption",
      anchor: null,
      at_ms: 1000,
      duration_ms: 2000,
      placement: {
        x_pct: 0,
        y_pct: 25,
        scale_x: 1,
        scale_y: 1,
        rotation_deg: 0,
        opacity: 1,
        fit_mode: "cover",
        crop: null,
        mirror_x: false,
        mirror_y: false,
      },
      typography: {
        text: "Merhaba yeni dünya",
        active_word_color_hex: "#FACC15",
        words: [
          { word: "Merhaba", source_start_ms: 1000, source_end_ms: 1600, sequence_start_ms: 1000, sequence_end_ms: 1600 },
          { word: "yeni", source_start_ms: 1600, source_end_ms: 2200, sequence_start_ms: 1600, sequence_end_ms: 2200 },
          { word: "dünya", source_start_ms: 2200, source_end_ms: 3000, sequence_start_ms: 2200, sequence_end_ms: 3000 },
        ],
        font_family: "Arial",
        font_size_px: 48,
        font_weight: 800,
        color_hex: "#FFFFFF",
        stroke_color_hex: "#000000",
        stroke_width_px: 3,
        box_color_hex: null,
        box_opacity: 0,
        align: "center",
        max_width_pct: 80,
      },
      envelopes: [],
    });
  });

  const { paths, sequence } = loadSequence(wsDir);
  const assPath = path.join(paths.blobsDir, "unit_test.ass");
  const res = compileTypographyAssFile(sequence, assPath);

  assert.equal(res.hasTypographyCues, true);
  assert.equal(res.cuesCount, 2);
  const content = fs.readFileSync(assPath, "utf8");
  const titleDialogueLine = content
    .split(/\r?\n/)
    .find((line) => line.startsWith("Dialogue:") && line.includes("Style_cue_01"));
  assert.ok(titleDialogueLine, "Expected ASS Dialogue line for title cue_01");
  const titleAssText = titleDialogueLine.replace(/^Dialogue:[^}]*\}/, "");
  const titleWrappedLines = titleAssText.split("\\N");
  assert.ok(
    titleWrappedLines.length >= 1 && titleWrappedLines.length <= 2,
    `Expected title to wrap into at most 2 lines on 9:16 stage, got ${titleWrappedLines.length}: ${titleAssText}`
  );
  assert.equal(titleWrappedLines.join(" "), "Türkçe Başlık: Şığüöçİ");
  // Verify inline active-word highlight tag `{\1c&H0015CCFA}` was generated for each word interval
  assert.ok(content.includes("{\\1c&H0015CCFA}Merhaba{\\1c&H00FFFFFF} yeni dünya"));
  assert.ok(content.includes("Merhaba {\\1c&H0015CCFA}yeni{\\1c&H00FFFFFF} dünya"));
  assert.ok(content.includes("Merhaba yeni {\\1c&H0015CCFA}dünya{\\1c&H00FFFFFF}"));
});

test("2. HyperFrames Scaffolding, /hyperframes-core Contract Validator & CLI hyperframes lint", () => {
  const wsDir = path.join(TEST_ROOT, "captions_compositor_render_hf_unit");
  fs.rmSync(wsDir, { recursive: true, force: true });

  // 2a. Standalone composition scaffold + CLI lint check
  const standaloneDir = path.join(wsDir, "comp_standalone");
  scaffoldHyperFramesComposition({
    targetDir: standaloneDir,
    compositionId: "main",
    width: 1080,
    height: 1920,
    fps: 30,
    durationMs: 4000,
    preset: "title_card",
    props: { headline: "CUTHOL STUDIO", subline: "HYPERFRAMES ENGINE" },
    asSubComposition: false,
  });

  const validStandalone = validateHyperFramesCompositionContract(standaloneDir, "index.html", true);
  assert.equal(
    validStandalone.ok,
    true,
    `Expected standalone HyperFrames composition to pass contract & CLI lint, got: ${validStandalone.findings.join("; ")}`
  );

  // 2b. Sub-composition (<template>) scaffold + contract check
  const subCompDir = path.join(wsDir, "comp_sub");
  scaffoldHyperFramesComposition({
    targetDir: subCompDir,
    compositionId: "stat-card",
    width: 1080,
    height: 1920,
    fps: 30,
    durationMs: 3000,
    preset: "stat_callout",
    props: { value: "100%", headline: "DETERMINISTIC" },
    asSubComposition: true,
  });

  const validSub = validateHyperFramesCompositionContract(subCompDir, "index.html", false, true);
  assert.equal(validSub.ok, true);
  assert.equal(validSub.composition_id, "stat-card");

  // 2c. Negative contract tests: verify pitfalls are caught
  const brokenDir = path.join(wsDir, "comp_broken");
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(
    path.join(brokenDir, "index.html"),
    `<!doctype html><html><head><style>#root{color:red}</style></head><body><template>
      <div id="root" data-composition-id="my-comp" data-width="1080" data-height="1920">
        <video src="a.mp4" crossorigin="anonymous"></video>
      </div>
      <script>
        const x = Math.random();
        const tl = gsap.timeline();
        window.__timelines["wrong-id"] = tl;
      </script>
    </template></body></html>`,
    "utf8"
  );

  const invalidRes = validateHyperFramesCompositionContract(brokenDir, "index.html", false);
  assert.equal(invalidRes.ok, false);
  assert.ok(invalidRes.findings.length >= 5);
});

test("3. Multi-Layer Compositor Filter-Graph & Audio Chain Compilation", () => {
  const wsDir = path.join(TEST_ROOT, "captions_compositor_render_compiler_unit");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Compiler Unit", aspect: "16:9", fps: 30 });

  const mediaFile = path.join(wsDir, "clip.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#2563EB:s=1280x720:r=30:d=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    mediaFile,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });

  commitSequenceMutation(wsDir, "test.configure_filters", (seq) => {
    const c = seq.spine.clips[0];
    c.audio_chain.denoise.enabled = true;
    c.audio_chain.voice_clarity.enabled = true;
    c.audio_chain.gain_db = -2.5;
    c.audio_chain.fade_in_ms = 200;
    c.audio_chain.fade_out_ms = 300;
    c.treatments.color_grade.brightness = 0.05;
    c.treatments.color_grade.contrast = 1.15;
    c.placement.mirror_x = true;
    c.transition_out = { kind: "dissolve", duration_ms: 400, easing: "ease_in_out" };
  });

  const { sequence } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");

  assert.equal(plan.renderWidth, 854);
  assert.equal(plan.renderHeight, 480);
  assert.match(plan.filterComplex, /hflip/);
  assert.match(plan.filterComplex, /eq=brightness=0\.05:contrast=1\.15/);
  assert.match(plan.filterComplex, /fade=t=out:st=2\.600:d=0\.400:alpha=1/);
  assert.match(plan.filterComplex, /afftdn=nr=12\.0:nf=-50\.0/);
  assert.match(plan.filterComplex, /highpass=f=80,equalizer=f=3000/);
  assert.match(plan.filterComplex, /volume=-2\.50dB/);
  assert.match(plan.filterComplex, /afade=t=in:st=0(\.000)?:d=0\.200/);
});

test("4. Monitor Blank-Frame Detection (CUTHOL-G502) vs Active Frame Luma Telemetry", () => {
  const wsDir = path.join(TEST_ROOT, "captions_compositor_render_blank_frame");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Blank Frame Test", aspect: "16:9", fps: 30 });

  const mediaFile = path.join(wsDir, "black_then_bright.mp4");
  // 0..2s pure black (#000000), 2..4s bright cyan (#38BDF8)
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#000000:s=640x360:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=c=#38BDF8:s=640x360:r=30:d=2",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[vout]",
    "-map",
    "[vout]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    mediaFile,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });

  // Sample at 800ms (inside black section) with boxes=false so only scene luma is measured
  const blankFrame = captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 800,
    showBoxes: false,
  });
  assert.equal(blankFrame.metrics.is_blank_frame, true);
  assert.ok(blankFrame.metrics.luma_mean < 6.0);
  assert.equal(blankFrame.diagnostics.length, 1);
  assert.equal(blankFrame.diagnostics[0].code, "CUTHOL-G502");

  // Sample at 3000ms (inside bright cyan section)
  const brightFrame = captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 3000,
    showBoxes: false,
  });
  assert.equal(brightFrame.metrics.is_blank_frame, false);
  assert.ok(brightFrame.metrics.luma_mean > 100);
  assert.equal(brightFrame.diagnostics.length, 0);
});

test("5. End-to-End Multi-Layer Composition (Spine + PIP B-Roll + HyperFrames Lower-Third + Turkish Active-Word Captions + BGM -> Sheet, Frame & Master Render)", () => {
  const wsDir = path.join(TEST_ROOT, "captions_compositor_render_e2e_showcase");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({
    dir: wsDir,
    title: "Çok Katmanlı Kurgu",
    aspect: "9:16",
    fps: 30,
  });

  const mediaDir = path.join(wsDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const mainVideo = path.join(mediaDir, "main_scenes.mp4");
  const pipGraphic = path.join(mediaDir, "pip_badge.mp4");
  const bgmAudio = path.join(mediaDir, "bgm.wav");

  // Main footage: 0..3s deep indigo (#1E3A8A) with grid pattern, 3..6s warm teal (#0F766E)
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1E3A8A:s=1080x1920:r=30:d=3,drawgrid=w=120:h=120:t=2:c=#3B82F6@0.35",
    "-f",
    "lavfi",
    "-i",
    "color=c=#0F766E:s=1080x1920:r=30:d=3,drawgrid=w=120:h=120:t=2:c=#14B8A6@0.35",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=320:sample_rate=48000:duration=6",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[vout]",
    "-map",
    "[vout]",
    "-map",
    "2:a",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    mainVideo,
  ]);

  // PIP B-roll card: bright coral (#F97316) with white border
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#F97316:s=600x400:r=30:d=4,drawbox=x=0:y=0:w=600:h=400:color=white:t=12",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    pipGraphic,
  ]);

  // BGM track
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.3*exp(-15*mod(t,0.5))*sin(2*PI*110*t)':s=48000:d=6",
    "-c:a",
    "pcm_s16le",
    bgmAudio,
  ]);

  ingestAssetsIntoWorkspace({
    workspaceDir: wsDir,
    filePaths: [mainVideo, pipGraphic, bgmAudio],
  });

  // 1. Add two spine clips (0..3000ms and 3000..6000ms) with dissolve transition on sp_01
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 3000, sourceOutMs: 6000 });
  setSpineTransition({
    workspaceDir: wsDir,
    clipId: "sp_01",
    transition: { kind: "dissolve", duration_ms: 400, easing: "ease_in_out" },
  });

  // 2. Add PIP B-roll cue on ln_broll (1000..4500ms, centered upper-middle card)
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_broll",
    kind: "broll",
    assetHandle: "vid_02",
    atMs: 1000,
    durationMs: 3500,
    xPct: 0,
    yPct: -12,
    scale: 0.55,
  });

  // 3. Scaffold & mount a HyperFrames composition on ln_motion (500..5000ms)
  const hfCompDir = path.join(wsDir, "compositions/intro_badge");
  scaffoldHyperFramesComposition({
    targetDir: hfCompDir,
    compositionId: "main",
    width: 1080,
    height: 1920,
    fps: 30,
    durationMs: 4500,
    preset: "lower_third",
    props: { headline: "HYPERFRAMES KATMANI", subline: "KODLA HAREKETLİ GRAFİK" },
    bgColorHex: "#00FF00",
  });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 500,
    durationMs: 4500,
    composition: {
      composition_dir: "compositions/intro_badge",
      entry_html: "index.html",
      props: { headline: "HYPERFRAMES KATMANI" },
      transparent: true,
    },
  });

  // 4. Add Turkish Title on ln_titles (200..5800ms)
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_titles",
    kind: "title",
    atMs: 200,
    durationMs: 5600,
    xPct: 0,
    yPct: -36,
    fontSizePx: 58,
    colorHex: "#FFFFFF",
    text: "CUTHOL AJAN KURGU STÜDYOSU",
  });

  // 5. Add Active-Word Highlighted Turkish Caption on ln_captions (800..5200ms)
  commitSequenceMutation(wsDir, "test.add_active_word_caption", (seq) => {
    const capLane = seq.lanes.find((l) => l.id === "ln_captions")!;
    capLane.cues.push({
      id: "cue_04",
      kind: "caption",
      anchor: null,
      at_ms: 800,
      duration_ms: 4400,
      placement: {
        x_pct: 0,
        y_pct: 26,
        scale_x: 1,
        scale_y: 1,
        rotation_deg: 0,
        opacity: 1,
        fit_mode: "cover",
        crop: null,
        mirror_x: false,
        mirror_y: false,
      },
      typography: {
        text: "Çok katmanlı akıllı video kurgu",
        active_word_color_hex: "#FACC15",
        words: [
          { word: "Çok", source_start_ms: 800, source_end_ms: 1700, sequence_start_ms: 800, sequence_end_ms: 1700 },
          { word: "katmanlı", source_start_ms: 1700, source_end_ms: 2800, sequence_start_ms: 1700, sequence_end_ms: 2800 },
          { word: "akıllı", source_start_ms: 2800, source_end_ms: 3900, sequence_start_ms: 2800, sequence_end_ms: 3900 },
          { word: "video", source_start_ms: 3900, source_end_ms: 4600, sequence_start_ms: 3900, sequence_end_ms: 4600 },
          { word: "kurgu", source_start_ms: 4600, source_end_ms: 5200, sequence_start_ms: 4600, sequence_end_ms: 5200 },
        ],
        font_family: "Arial",
        font_size_px: 48,
        font_weight: 800,
        color_hex: "#FFFFFF",
        stroke_color_hex: "#0F172A",
        stroke_width_px: 4,
        box_color_hex: null,
        box_opacity: 0,
        align: "center",
        max_width_pct: 82,
      },
      envelopes: [],
    });
  });

  // 6. Add BGM on ln_bgm (0..6000ms)
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: 6000,
  });

  // 7. Capture 2x2 Monitor Contact Sheet & Single Frame at 2200ms
  const sheetOut = path.join(paths.monitorDir, "showcase_sheet_2x2.png");
  const sheetRes = captureMonitorSheet({
    workspaceDir: wsDir,
    cols: 2,
    rows: 2,
    showBoxes: true,
    outputPath: sheetOut,
  });
  assert.equal(sheetRes.ok, true);
  assert.equal(sheetRes.blank_frames_ms.length, 0);
  assert.ok(fs.existsSync(sheetOut));

  const frameOut = path.join(paths.monitorDir, "showcase_frame_2200ms.png");
  const frameRes = captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 2200,
    showBoxes: true,
    outputPath: frameOut,
  });
  assert.equal(frameRes.ok, true);
  assert.equal(frameRes.metrics.is_blank_frame, false);
  assert.ok(frameRes.metrics.active_handles.includes("sp_01"));
  assert.ok(frameRes.metrics.active_handles.includes("cue_01"));
  assert.ok(frameRes.metrics.active_handles.includes("cue_02"));
  assert.ok(frameRes.metrics.active_handles.includes("cue_03"));
  assert.ok(frameRes.metrics.active_handles.includes("cue_04"));

  // 8. Render Master 1080p Delivery MP4 and verify with ffprobe
  const masterMp4 = path.join(wsDir, "output/showcase_master.mp4");
  const renderRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "master_1080p",
    outputPath: masterMp4,
  });
  assert.equal(renderRes.ok, true);
  assert.equal(renderRes.width, 1080);
  assert.equal(renderRes.height, 1920);
  assert.ok(renderRes.size_bytes > 20_000);
});

test("6. Speed-Ramp Integral Calculus, Excised Null-Timestamp Words & Envelope FFmpeg Expressions", () => {
  const wsDir = path.join(TEST_ROOT, "captions_compositor_render_speed_ramp_and_excised_words");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Speed Ramp & Excised Words", aspect: "16:9", fps: 30 });

  const mediaFile = path.join(wsDir, "source_6s.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#334155:s=640x360:r=30:d=6",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    mediaFile,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });

  // 1. Apply linear speed_ramp from 1.0x at 0ms to 2.0x at 4000ms:
  // Exact integral: \int_0^4000 du / (1 + u/4000) = 4000 * ln(2) = 2772.5887ms -> 2773ms
  setSpineSpeed({
    workspaceDir: wsDir,
    clipId: "sp_01",
    speedRamp: [
      { source_offset_ms: 0, rate: 1.0 },
      { source_offset_ms: 4000, rate: 2.0 },
    ],
  });

  let seq = loadSequence(wsDir).sequence;
  const sp1 = seq.spine.clips[0];
  const expectedDur = Math.round(4000 * Math.log(2)); // 2773ms
  assert.equal(sp1.duration_ms, expectedDur);

  // Verify forward & inverse integral round-trip at source 2000ms (where rate = 1.5x, integral = 4000*ln(1.5) = 1621.86ms)
  const localAt2000 = integrateSourceOffsetToClipLocalMs(sp1, 2000);
  assert.ok(Math.abs(localAt2000 - 4000 * Math.log(1.5)) < 1e-6);
  const invertedSrc = invertClipLocalMsToSourceOffset(sp1, localAt2000);
  assert.ok(Math.abs(invertedSrc - 2000) < 1e-6);

  const seqAt2500 = sourceMsToSequenceMs(sp1, 2500);
  const roundTripSrc = sequenceMsToSourceMs(sp1, seqAt2500);
  assert.ok(Math.abs(roundTripSrc - 2500) <= 2);

  // 2. Reset speed_ramp to constant 1.0x, excise [1000..2500ms], and project transcript words across the sequence
  setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", rate: 1.0, speedRamp: null });
  exciseSpineRanges({
    workspaceDir: wsDir,
    clipId: "sp_01",
    ranges: [{ start_ms: 1000, end_ms: 2500 }],
    coordinateSpace: "source",
  });

  seq = loadSequence(wsDir).sequence;
  // sp_01 covers [0..1000ms] (timeline 0..1000ms), sp_02 covers [2500..4000ms] (timeline 1000..2500ms)
  const projected = projectTranscriptAcrossSequence(seq, "vid_01", [
    { word: "Birinci", source_start_ms: 200, source_end_ms: 800 },
    { word: "SilinenDolgu", source_start_ms: 1300, source_end_ms: 1900 }, // inside excised 1000..2500ms!
    { word: "İkinci", source_start_ms: 2600, source_end_ms: 3200 },
  ]);

  assert.equal(projected.length, 3);
  assert.equal(projected[0].excised, false);
  assert.equal(projected[0].sequence_start_ms, 200);
  assert.equal(projected[0].clip_id, "sp_01");

  // Excised word MUST have sequence_start_ms === null and sequence_end_ms === null!
  assert.equal(projected[1].excised, true);
  assert.equal(projected[1].sequence_start_ms, null);
  assert.equal(projected[1].sequence_end_ms, null);
  assert.equal(projected[1].clip_id, null);

  // Word in sp_02 [2500..4000ms] at source 2600..3200ms maps to sequence 1100..1700ms!
  assert.equal(projected[2].excised, false);
  assert.equal(projected[2].sequence_start_ms, 1100);
  assert.equal(projected[2].sequence_end_ms, 1700);
  assert.equal(projected[2].clip_id, "sp_02");

  // Verify ASS compiler skips the excised word (`sequence_start_ms: null`)
  commitSequenceMutation(wsDir, "test.add_projected_caption", (s) => {
    s.lanes.find((l) => l.id === "ln_captions")!.cues.push({
      id: "cue_proj",
      kind: "caption",
      anchor: null,
      at_ms: 0,
      duration_ms: 2500,
      placement: {
        x_pct: 0,
        y_pct: 25,
        scale_x: 1,
        scale_y: 1,
        rotation_deg: 0,
        opacity: 1,
        fit_mode: "cover",
        crop: null,
        mirror_x: false,
        mirror_y: false,
      },
      typography: {
        text: "Birinci İkinci",
        active_word_color_hex: "#FACC15",
        words: projected,
        font_family: "Arial",
        font_size_px: 44,
        font_weight: 700,
        color_hex: "#FFFFFF",
        stroke_color_hex: "#000000",
        stroke_width_px: 2,
        box_color_hex: null,
        box_opacity: 0,
        align: "center",
        max_width_pct: 80,
      },
      envelopes: [],
    });
  });

  const assOut = path.join(paths.blobsDir, "excised_check.ass");
  compileTypographyAssFile(loadSequence(wsDir).sequence, assOut);
  const assContent = fs.readFileSync(assOut, "utf8");
  assert.ok(!assContent.includes("SilinenDolgu"), "Excised null-timestamp word must never appear in ASS output");
  assert.ok(assContent.includes("Birinci"));
  assert.ok(assContent.includes("İkinci"));

  // 3. Verify envelope compilation into FFmpeg expressions (`placement.x_pct` and `audio_chain.gain_db`)
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_01",
    parameter: "placement.x_pct",
    points: [
      { offset_ms: 0, value: -10, easing: "linear" },
      { offset_ms: 1000, value: 10, easing: "linear" },
    ],
  });
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: "sp_01",
    parameter: "audio_chain.gain_db",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 500, value: -12, easing: "linear" },
    ],
  });

  const plan = compileSequenceRenderPlan(loadSequence(wsDir).sequence, paths, "draft_480p");
  assert.match(plan.filterComplex, /overlay=x='if\(lt\(t,0\)/);
  assert.match(plan.filterComplex, /volume='if\(lt\(t,0\),1,if\(lt\(t,0\.5\)/);
});

test("7. Regression suite", () => {
  // FFmpeg filter path escaping
  assert.equal(
    escapeFfmpegFilterPath("D:\\folder\\sub:name,test'[1].ass"),
    "D\\:/folder/sub\\:name\\,test\\'\\[1\\].ass"
  );

  // Easing curves in compileEnvelopeToFfmpegExpr
  const easeInExpr = compileEnvelopeToFfmpegExpr({
    envelope: {
      parameter: "placement.x_pct",
      points: [
        { offset_ms: 0, value: 0, easing: "linear" },
        { offset_ms: 1000, value: 20, easing: "ease_in" },
      ],
    },
    timeBaseOffsetMs: 0,
    mode: "pixel_offset",
    baseCenterPx: 100,
    canvasDimPx: 1000,
  });
  assert.ok(easeInExpr?.includes("pow(((t-0)/1),2)"), `Expected pow(...,2) for ease_in, got ${easeInExpr}`);

  const wsDir = path.join(TEST_ROOT, "captions_compositor_render_regression_suite");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Regression", aspect: "9:16", fps: 30 });

  const mediaFile = path.join(wsDir, "bright_clip.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#38BDF8:s=640x360:r=30:d=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    mediaFile,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 2000, sourceOutMs: 4000 });

  // Cross-dissolve between sp_01 and sp_02 + rotation_deg + crop
  commitSequenceMutation(wsDir, "test.setup_regression_checks", (seq) => {
    seq.spine.clips[0].transition_out = { kind: "dissolve", duration_ms: 400, easing: "ease_in_out" };
    seq.spine.clips[0].placement.rotation_deg = 5;
    seq.spine.clips[0].placement.crop = { left_pct: 5, top_pct: 5, right_pct: 5, bottom_pct: 5 };

    // Create a broll lane at z_index: 40 between ln_titles (z_index: 25) and a top caption lane (z_index: 60)
    const titlesLane = seq.lanes.find((l) => l.id === "ln_titles")!;
    titlesLane.z_index = 25;
    titlesLane.cues.push({
      id: "cue_low_title",
      kind: "title",
      anchor: null,
      at_ms: 200,
      duration_ms: 1500,
      placement: {
        x_pct: 0,
        y_pct: -20,
        scale_x: 1,
        scale_y: 1,
        rotation_deg: 0,
        opacity: 1,
        fit_mode: "cover",
        crop: null,
        mirror_x: false,
        mirror_y: false,
      },
      typography: {
        text: "Alt Başlık",
        font_family: "Verdana",
        font_size_px: 48,
        font_weight: 700,
        color_hex: "#FFFFFF",
        stroke_color_hex: "#000000",
        stroke_width_px: 2,
        box_color_hex: null,
        box_opacity: 0,
        align: "center",
        max_width_pct: 80,
      },
      envelopes: [],
    });

    const brollLane = seq.lanes.find((l) => l.id === "ln_broll")!;
    brollLane.z_index = 40;
    brollLane.cues.push({
      id: "cue_mid_broll",
      kind: "broll",
      asset_handle: "vid_01",
      anchor: null,
      at_ms: 200,
      duration_ms: 1000,
      source_in_ms: 0,
      source_out_ms: 3500, // longer than duration_ms (1000ms) -> must be clamped to 1000ms!
      placement: {
        x_pct: 0,
        y_pct: -20,
        scale_x: 0.5,
        scale_y: 0.5,
        rotation_deg: 0,
        opacity: 1,
        fit_mode: "cover",
        crop: null,
        mirror_x: false,
        mirror_y: false,
      },
      envelopes: [],
    });

    // Boost gain_db on an audio lane cue -> must trigger CUTHOL-G501 in G5_SIGNAL
    const bgmLane = seq.lanes.find((l) => l.id === "ln_bgm")!;
    bgmLane.cues.push({
      id: "cue_loud_bgm",
      kind: "music",
      asset_handle: "vid_01",
      anchor: null,
      at_ms: 0,
      duration_ms: 2000,
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
      audio_chain: {
        gain_db: 15,
        muted: false,
        fade_in_ms: 0,
        fade_out_ms: 0,
        denoise: { enabled: false, nr_db: 12, noise_floor_db: -50 },
        voice_clarity: { enabled: false, highpass_hz: 80, presence_boost_db: 2.5, compressor_ratio: 3 },
        loudness_target_lufs: null,
        true_peak_ceiling_dbtp: -1.0,
      },
      envelopes: [],
    });
  });

  const seq = loadSequence(wsDir).sequence;
  const plan = compileSequenceRenderPlan(seq, paths, "draft_480p");

  // Verify ln_titles ASS filter appears BEFORE cue_mid_broll overlay in filterComplex!
  const assIdx = plan.filterComplex.indexOf("typography_r");
  const brollOverlayIdx = plan.filterComplex.indexOf("[v_cue_cue_mid_broll]overlay");
  assert.ok(assIdx > 0 && brollOverlayIdx > assIdx, "Typography at z_index=25 must be applied before broll at z_index=40");

  // Verify cue_mid_broll trim end is clamped to 1.000s, not 3.500s
  assert.match(plan.filterComplex, /trim=start=0\.000:end=1\.000/);

  // Verify sp_01 uses tpad=stop_mode=clone:stop_duration=0.400 and sp_02 uses fade=t=in:st=0:d=0.400:alpha=1
  assert.match(plan.filterComplex, /tpad=stop_mode=clone:stop_duration=0\.400/);
  assert.match(plan.filterComplex, /fade=t=in:st=0:d=0\.400:alpha=1/);

  // Verify crop and rotate are applied
  assert.match(plan.filterComplex, /crop=w=iw\*0\.9000:h=ih\*0\.9000/);
  assert.match(plan.filterComplex, /rotate=0\.0873:ow='rotw\(0\.0873\)':oh='roth\(0\.0873\)':c=none/);

  // Verify alimiter has level=disabled
  assert.match(plan.filterComplex, /alimiter=limit=0\.891:level=disabled/);

  // Verify PlayResX is native 1080x1920 even in draft_480p, and font_family Verdana is preserved
  const assText = fs.readFileSync(plan.assFilePath!, "utf8");
  assert.match(assText, /PlayResX: 1080/);
  assert.match(assText, /PlayResY: 1920/);
  assert.match(assText, /Style: Style_cue_low_title,Verdana,48/);

  // Verify G5_SIGNAL detects +15dB gain on lane cue `cue_loud_bgm`
  const ver = verifySequence(seq, paths);
  assert.ok(ver.diagnostics.some((d) => d.code === "CUTHOL-G501" && d.subject_id === "cue_loud_bgm"));

  // Verify Seeking at exact end of sequence (4000ms) or past it (4500ms) clamps safely and does NOT produce false blank frame!
  const eofFrame = captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 4500,
    showBoxes: false,
  });
  assert.equal(eofFrame.metrics.is_blank_frame, false);
  assert.ok(eofFrame.metrics.luma_mean > 50);
});
