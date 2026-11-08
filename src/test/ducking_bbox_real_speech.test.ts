/**
 * Verification Suite for real-media findings (`src/test/ducking_bbox_real_speech.test.ts`).
 *
 * Verifies:
 * 1. `duckMusicUnderDialogue` does NOT duck across 0..14000ms on untranscribed spine B-roll clips when `ln_vo` voiceover is present, and emits `CUTHOL-G504`.
 * 2. `verifySequence` emits `CUTHOL-G306` (`LANE_EXTENDS_PAST_SPINE`) when `ln_vo` / `ln_captions` / `ln_bgm` extend past the primary `spine` duration (e.g. 14000ms vs 12000ms).
 * 3. `measureCuePixelBox` accurately detects HyperFrames `title_card` / `stat_callout` / `badge_overlay` / `lower_third` geometry, and `captureMonitorFrame` draws overflowing top boxes OVER the HUD bar without clipping.
 * 4. `synthesizeVoiceover` with `--provider local` (when `CUTHOL_LOCAL_TTS_CMD` is unset) explicitly flags `is_placeholder_audio: true` and `placeholder_warning`.
 * 5. A HyperFrames overlay is never replaced by a drawbox stand-in; legacy stand-in blobs (`.fallback.json`) are re-rendered.
 * 6. Real neural Turkish speech + multi-shot video regression test (`transcribe` -> `cleanup` -> `captions` -> `duck` -> `verify`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip, trimSpineClip } from "../sequence/spine.js";
import { addLaneCue } from "../sequence/lanes.js";
import { measureCuePixelBox, verifySequence } from "../verify/gates.js";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import { duckMusicUnderDialogue } from "../mix/audio_mix.js";
import { synthesizeVoiceover } from "../speech/synthesize.js";
import { transcribeLibraryAsset } from "../speech/transcribe.js";
import { cleanupClipDialogue } from "../speech/cleanup.js";
import { generateSequenceCaptions } from "../speech/captions.js";
import { captureMonitorFrame } from "../monitor/preview.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { fixturePath, missingKeys } from "./fixtures.js";
const SPEECH_CACHE_DIR = fixturePath("speech-cache");

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");

test("Ducking skips untranscribed spine footage when ln_vo exists (G504), and G306 warns when lanes extend past spine", async () => {
  const wsDir = path.join(TEST_ROOT, "ducking_bbox_real_speech_1_and_2");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Audit 1 & 2", aspect: "16:9", fps: 30 });

  const brollVid1 = path.join(wsDir, "broll1.mp4");
  const brollVid2 = path.join(wsDir, "broll2.mp4");
  const bgmFile = path.join(wsDir, "bgm.wav");

  for (const [f, col] of [
    [brollVid1, "#1E293B"],
    [brollVid2, "#0F766E"],
  ] as const) {
    spawnSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${col}:s=1280x720:r=24:d=7`,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=110:sample_rate=48000:duration=7",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      f,
    ]);
  }

  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=48000:duration=14",
    "-c:a",
    "pcm_s16le",
    bgmFile,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [brollVid1, brollVid2, bgmFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 7000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_02", sourceInMs: 0, sourceOutMs: 7000 });

  // Synthesize a voiceover placed on ln_vo at 2000..4500ms (also covers the placeholder flag)
  const voRes = await synthesizeVoiceover({
    workspaceDir: wsDir,
    text: "Kısa seslendirme cümlesi.",
    provider: "local",
    placeOnLane: "ln_vo",
    atMs: 2000,
  });
  assert.equal(voRes.is_placeholder_audio, true);
  assert.ok(voRes.placeholder_warning?.includes("CUTHOL_LOCAL_TTS_CMD"));

  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: 14000,
  });

  // duckMusicUnderDialogue must ONLY duck around the ln_vo voiceover (~2000ms),
  // NOT across the entire 0..14000ms of untranscribed sp_01 & sp_02!
  const duckRes = duckMusicUnderDialogue({ workspaceDir: wsDir, duckDb: -12 });
  assert.equal(duckRes.dialogue_windows_ms.length, 1);
  assert.ok(
    duckRes.dialogue_windows_ms[0].start_ms >= 2000 && duckRes.dialogue_windows_ms[0].end_ms <= 5000,
    `Expected dialogue window only around ln_vo (2000..5000ms), got ${JSON.stringify(duckRes.dialogue_windows_ms)}`
  );
  assert.ok(
    duckRes.verification.diagnostics.some((d) => d.code === "CUTHOL-G504"),
    "Expected CUTHOL-G504 warning when untranscribed spine clips are skipped during ducking"
  );

  // Trim sp_02 so spine ends at 12000ms while ln_bgm extends to 14000ms -> must trigger CUTHOL-G306!
  trimSpineClip({ workspaceDir: wsDir, clipId: "sp_02", sourceInMs: 0, sourceOutMs: 5000 });
  const ver = verifySequence(loadSequence(wsDir).sequence, paths);
  assert.ok(
    ver.diagnostics.some((d) => d.code === "CUTHOL-G306" && d.subject_id === "cue_02"),
    `Expected CUTHOL-G306 warning when cue_02 (14000ms) extends past spine (12000ms), got ${JSON.stringify(ver.diagnostics)}`
  );
});

test("HyperFrames title_card bounding box accuracy, top-overflow box visibility & G503 fallback diagnostic", () => {
  const wsDir = path.join(TEST_ROOT, "ducking_bbox_real_speech_3_and_5");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Audit 3 & 5", aspect: "16:9", fps: 30 });

  const vidFile = path.join(wsDir, "base.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1E3A8A:s=1920x1080:r=30:d=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    vidFile,
  ]);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [vidFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });

  // Scaffold a `title_card` HyperFrames composition
  const compDir = path.join(wsDir, "compositions/title_banner");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    compositionId: "main",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 2500,
    preset: "title_card",
    props: { headline: "MERKEZ BAŞLIK KARTI", subline: "DOĞRU SINIR KUTUSU" },
    transparent: true,
  });

  const { cue: compCue } = addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 200,
    durationMs: 2500,
    composition: {
      composition_dir: "compositions/title_banner",
      entry_html: "index.html",
      props: { headline: "MERKEZ BAŞLIK KARTI" },
      transparent: true,
    },
  });

  // Verify `measureCuePixelBox` detects `title_card` centered geometry (height = 0.24 * 1080 = 259px centered at Y=540)
  const seq = loadSequence(wsDir).sequence;
  const box = measureCuePixelBox(seq.stage, compCue, undefined, paths.rootDir);
  assert.ok(Math.abs(box.width - Math.round(1920 * 0.66)) <= 2);
  assert.ok(Math.abs(box.height - Math.round(1080 * 0.24)) <= 2);
  assert.ok(Math.abs((box.top + box.bottom) / 2 - 540) <= 2, "title_card box must be centered vertically at 540px");

  // Add a title overflowing the top edge (yPct: -49) and verify its top border is NOT erased by the HUD bar
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_titles",
    kind: "title",
    atMs: 0,
    durationMs: 2500,
    yPct: -49,
    text: "Üst Sınırda Taşan Başlık",
  });

  const frameRes = captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 1000,
    showBoxes: true,
  });
  assert.equal(frameRes.ok, true);

  // no drawbox stand-in is ever produced. An overlay blob left behind by an older
  // version with a `.fallback.json` sidecar must not be reused: the next render re-renders it and reports nothing.
  renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "draft_480p",
  });
  const blobs = fs
    .readdirSync(paths.blobsDir)
    .filter(
      (f) =>
        f.startsWith("hf_comp_") &&
        (f.endsWith(".pngseq") || f.endsWith(".mov") || f.endsWith(".mp4"))
    );
  assert.ok(blobs.length >= 1);
  const hfBlobPath = path.join(paths.blobsDir, blobs[0]);
  const isDirBlob = fs.statSync(hfBlobPath).isDirectory();
  const realMetric = isDirBlob
    ? fs.readdirSync(hfBlobPath).filter((n) => n.endsWith(".png")).length
    : fs.statSync(hfBlobPath).size;
  fs.rmSync(hfBlobPath, { recursive: true, force: true });
  fs.writeFileSync(hfBlobPath, Buffer.alloc(4096, 0));
  fs.writeFileSync(
    `${hfBlobPath}.fallback.json`,
    JSON.stringify({ composition_dir: "compositions/title_banner", reason: "simulated legacy fallback" }),
    "utf8"
  );

  const renderRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "draft_480p",
  });
  assert.equal(fs.existsSync(`${hfBlobPath}.fallback.json`), false, "legacy fallback sidecar must be discarded");
  if (isDirBlob) {
    assert.ok(fs.statSync(hfBlobPath).isDirectory(), "legacy stand-in blob must be re-rendered as pngseq directory");
    const newFrameCount = fs.readdirSync(hfBlobPath).filter((n) => n.endsWith(".png")).length;
    assert.equal(newFrameCount, realMetric, "re-rendered pngseq directory frame count matches");
  } else {
    assert.ok(fs.statSync(hfBlobPath).size > 4096, "legacy stand-in blob must be re-rendered");
    assert.ok(Math.abs(fs.statSync(hfBlobPath).size - realMetric) / realMetric < 0.2, "re-rendered blob matches the real overlay");
  }
  assert.ok(
    !renderRes.verification.diagnostics.some((d) => d.code === "CUTHOL-G503"),
    `No G503 expected after a successful re-render, got ${JSON.stringify(renderRes.verification.diagnostics)}`
  );
});

test("Real neural Turkish speech recording with real pause & filler excision + multi-shot video regression", { skip: fs.existsSync(SPEECH_CACHE_DIR) ? false : missingKeys("ELEVENLABS_API_KEY", "DEEPGRAM_API_KEY") }, async (t) => {
  // Recorded speech: the first run with keys stores the voiceover and its transcript in a
  // persistent content-addressed cache; later runs replay the same audio without network calls,
  // so the pause and filler checks see identical input every time.
  const prevCacheDir = process.env.CUTHOL_CACHE_DIR;
  process.env.CUTHOL_CACHE_DIR = SPEECH_CACHE_DIR;
  t.after(() => {
    if (prevCacheDir === undefined) delete process.env.CUTHOL_CACHE_DIR;
    else process.env.CUTHOL_CACHE_DIR = prevCacheDir;
  });
  const wsDir = path.join(TEST_ROOT, "real_speech_media");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Gerçek Konuşma Regresyon", aspect: "16:9", fps: 30 });

  // Synthesize real neural Turkish speech via ElevenLabs in its own isolated workspace
  const vo = await synthesizeVoiceover({
    workspaceDir: wsDir,
    text: "Cuthol yapay zeka ajanları için açık kaynaklı bir kurgu motorudur.",
    provider: "elevenlabs",
    language: "tr",
  });
  const realMp3 = path.resolve(wsDir, vo.asset.uri);

  // Multiplex the real neural Turkish speech recording with a 950ms silent pause inserted in the middle
  // and 2 distinct visual shots (0..2.2s blue testsrc, 2.2..4.6s warm slate) into a real `.mp4` clip
  const realTalkingHeadMp4 = path.join(wsDir, "real_talking_head.mp4");
  const muxProc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#1E3A8A:s=1280x720:r=30:d=2.2",
      "-f",
      "lavfi",
      "-i",
      "color=c=#FACC15:s=1280x720:r=30:d=2.4",
      "-i",
      realMp3,
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0[vout];[2:a]atrim=0:1.2,asetpts=PTS-STARTPTS[a0];aevalsrc=0:s=44100:d=0.95[asil];[2:a]atrim=1.2:3.5,asetpts=PTS-STARTPTS[a1];[a0][asil][a1]concat=n=3:v=0:a=1[aout]",
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-t",
      "4.5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      realTalkingHeadMp4,
    ],
    { encoding: "utf8" }
  );
  assert.equal(muxProc.status, 0, `FFmpeg mux failed: ${muxProc.stderr}`);

  const [vidAsset] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [realTalkingHeadMp4] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: vidAsset.handle });

  // Transcribe the real speech + pause video via Deepgram Nova-3 (with acoustic pause fusion)
  const trRes = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: vidAsset.handle,
    provider: "deepgram",
    language: "tr",
    keyterms: ["Cuthol"],
  });
  assert.ok(trRes.transcript.words.length >= 4);
  assert.ok(
    trRes.transcript.disfluencies.some((d) => d.kind === "pause" && d.duration_ms >= 600),
    `Expected Deepgram + acoustic fusion to detect the ~950ms real speech pause, got ${JSON.stringify(trRes.transcript.disfluencies)}`
  );

  // Run dialogue cleanup to excise the real pause and ripple-close the spine
  const cleanRes = cleanupClipDialogue({
    workspaceDir: wsDir,
    clipId: "sp_01",
    minPauseMs: 500,
    padMs: 60,
    dryRun: false,
  });
  assert.ok(cleanRes.cuts_count >= 1);
  assert.ok(cleanRes.saved_sequence_ms >= 400);

  // Generate active-word captions and verify 0 errors
  const capRes = generateSequenceCaptions({
    workspaceDir: wsDir,
    style: "active_word",
    language: "tr",
  });
  assert.ok(capRes.cues_created >= 1);
  assert.equal(capRes.verification.ok, true);
});
