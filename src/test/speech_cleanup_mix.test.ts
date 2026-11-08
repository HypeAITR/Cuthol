/**
 * Comprehensive Unit & Live Cloud Integration Suite (`src/test/speech_cleanup_mix.test.ts`).
 *
 * Tests:
 * 1. Disfluency annotation (pauses, TR/EN fillers, repetitions), character-to-word alignment & local provider door (`providers.ts`)
 * 2. Dialogue cleanup (`75ms` collar padding, dry-run vs source-space excise) & automatic skipping of excised words in `speech captions` (`cleanup.ts`, `captions.ts`)
 * 3. Audio mixing: ITU-R BS.1770-4 loudness normalization, `afftdn` voice polish, envelope auto-ducking & beat alignment (`audio_mix.ts`)
 * 4. Live Cloud API Integration (`.env` `ELEVENLABS_API_KEY` + `DEEPGRAM_API_KEY`) with SQLite ledger cache verification & visual monitor frame inspection
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { loadDotEnvIfNeeded } from "../core/env.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { addLaneCue } from "../sequence/lanes.js";
import {
  annotateWordsAndDisfluencies,
  characterAlignmentToWordTokens,
} from "../speech/providers.js";
import { transcribeLibraryAsset } from "../speech/transcribe.js";
import { synthesizeVoiceover } from "../speech/synthesize.js";
import { cleanupClipDialogue } from "../speech/cleanup.js";
import { generateSequenceCaptions } from "../speech/captions.js";
import {
  alignClipsToBeats,
  duckMusicUnderDialogue,
  normalizeSequenceAudio,
  polishVoiceAudio,
} from "../mix/audio_mix.js";
import { captureMonitorFrame } from "../monitor/preview.js";
import { missingKeys } from "./fixtures.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");

test("1. Disfluency annotation (pauses, TR/EN fillers, repetitions), character alignment & local provider door", async () => {
  // 1a. Disfluency detector unit test
  const raw = [
    { word: "Merhaba", punctuated_word: "Merhaba,", source_start_ms: 500, source_end_ms: 900 }, // 500ms leading silence (>=400ms)
    { word: "şey", punctuated_word: "şey", source_start_ms: 1000, source_end_ms: 1350 }, // Turkish filler
    { word: "bugün", punctuated_word: "bugün", source_start_ms: 1900, source_end_ms: 2300 }, // 550ms pause before "bugün"
    { word: "çok", punctuated_word: "çok", source_start_ms: 2400, source_end_ms: 2700 },
    { word: "çok", punctuated_word: "çok", source_start_ms: 2780, source_end_ms: 3100 }, // immediate repetition (<800ms gap)
    { word: "güzel.", punctuated_word: "güzel.", source_start_ms: 3200, source_end_ms: 3700 },
  ];

  const { words, disfluencies } = annotateWordsAndDisfluencies(raw, 4300, 400);
  assert.equal(words.length, 6);
  assert.equal(words[1].is_filler, true);
  assert.equal(words[4].is_repetition, true);

  const kinds = disfluencies.map((d) => d.kind);
  // Leading silence (0..500), filler ("şey"), inter-word pause (1350..1900), repetition ("çok"), trailing silence (3700..4300)
  assert.deepEqual(kinds, ["pause", "filler", "pause", "repetition", "pause"]);

  // 1b. ElevenLabs character-level alignment to word-level tokens
  const wordTokens = characterAlignmentToWordTokens({
    characters: [..."Selam dünya!".split("")],
    character_start_times_seconds: [0.1, 0.15, 0.2, 0.25, 0.3, 0.38, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7],
    character_end_times_seconds: [0.15, 0.2, 0.25, 0.3, 0.38, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.78],
  });
  assert.equal(wordTokens.length, 2);
  assert.equal(wordTokens[0].punctuated_word, "Selam");
  assert.equal(wordTokens[0].source_start_ms, 100);
  assert.equal(wordTokens[0].source_end_ms, 380);
  assert.equal(wordTokens[1].punctuated_word, "dünya!");
  assert.equal(wordTokens[1].source_start_ms, 450);
  assert.equal(wordTokens[1].source_end_ms, 780);

  // 1c. Local TTS & Local ASR provider doors + SQLite cache hit
  const wsDir = path.join(TEST_ROOT, "speech_cleanup_mix_local_providers");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Local Speech Providers" });

  const tts1 = await synthesizeVoiceover({
    workspaceDir: wsDir,
    text: "Yerel ses motoru testi başarılı.",
    provider: "local",
    placeOnLane: "ln_vo",
  });
  assert.equal(tts1.cached, false);
  assert.equal(tts1.asset.handle, "vo_01");
  assert.equal(tts1.words.length, 5);
  assert.ok(tts1.placed_cue);

  // Second call with identical text & provider must hit SQLite tts_cache
  const tts2 = await synthesizeVoiceover({
    workspaceDir: wsDir,
    text: "Yerel ses motoru testi başarılı.",
    provider: "local",
  });
  assert.equal(tts2.cached, true);
});

test("2. Dialogue cleanup (collar padding, dry-run vs source-space excise) & skipping excised words in captions", async () => {
  const wsDir = path.join(TEST_ROOT, "speech_cleanup_mix_cleanup_and_captions");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Cleanup & Captions", aspect: "9:16", fps: 30 });

  const mediaFile = path.join(wsDir, "talking_head.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1E293B:s=1080x1920:r=30:d=5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=240:sample_rate=48000:duration=5",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    mediaFile,
  ]);

  // Write a sidecar transcript with a filler ("şey" at 900..1400ms) and a 900ms pause (1400..2300ms)
  fs.writeFileSync(
    `${mediaFile}.transcript.json`,
    JSON.stringify({
      language: "tr",
      words: [
        { word: "Bugün", punctuated_word: "Bugün", source_start_ms: 100, source_end_ms: 750 },
        { word: "şey", punctuated_word: "şey", source_start_ms: 900, source_end_ms: 1400 },
        { word: "kurgu", punctuated_word: "kurgu", source_start_ms: 2300, source_end_ms: 3000 },
        { word: "tamamlandı.", punctuated_word: "tamamlandı.", source_start_ms: 3100, source_end_ms: 4200 },
      ],
    }),
    "utf8"
  );

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4500 });

  await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    provider: "local",
    language: "tr",
  });

  // Dry-run cleanup
  const dry = cleanupClipDialogue({
    workspaceDir: wsDir,
    clipId: "sp_01",
    minPauseMs: 400,
    padMs: 50,
    dryRun: true,
  });
  assert.equal(dry.dry_run, true);
  assert.ok(dry.cuts_count >= 2);
  assert.equal(loadSequence(wsDir).sequence.spine.clips.length, 1);

  // Execute cleanup -> excises filler ("şey") and pause (1400..2300ms)
  const applied = cleanupClipDialogue({
    workspaceDir: wsDir,
    clipId: "sp_01",
    minPauseMs: 400,
    padMs: 50,
    dryRun: false,
  });
  assert.equal(applied.dry_run, false);
  assert.ok((applied.remaining_clips?.length ?? 0) >= 2);

  // Generate active_word captions across the edited spine
  const capRes = generateSequenceCaptions({
    workspaceDir: wsDir,
    style: "active_word",
    language: "tr",
  });
  assert.ok(capRes.cues_created >= 1);
  const allCaptionText = capRes.cues.map((c) => c.typography?.text ?? "").join(" ");
  assert.ok(!allCaptionText.includes("şey"), "Filler word 'şey' must be excluded from captions");
  assert.ok(allCaptionText.includes("Bugün"));
  assert.ok(allCaptionText.includes("kurgu"));
  assert.ok(allCaptionText.includes("tamamlandı."));
});

test("3. Audio mixing: ITU-R BS.1770-4 loudness normalization, afftdn voice polish, BGM ducking & beat-align", () => {
  const wsDir = path.join(TEST_ROOT, "speech_cleanup_mix_audio_mix");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Audio Mix Test", aspect: "16:9", fps: 30 });

  const mediaDir = path.join(wsDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const dialogueVid = path.join(mediaDir, "dialogue.mp4");
  const bgmWav = path.join(mediaDir, "bgm_120bpm.wav");

  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1E3A8A:s=640x360:r=30:d=6",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=300:sample_rate=48000:duration=6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    dialogueVid,
  ]);

  // 120 BPM (0.5s period) beat track
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.75*exp(-20*mod(t,0.5))*sin(2*PI*120*t)+0.35*exp(-30*mod(t,0.5))*sin(2*PI*2200*t)':s=48000:d=6",
    "-c:a",
    "pcm_s16le",
    bgmWav,
  ]);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [dialogueVid, bgmWav] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 1850 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 2000, sourceOutMs: 3900 });

  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: 5000,
  });

  // 3a. Normalize to -14 LUFS / -1 dBTP
  const normRes = normalizeSequenceAudio({ workspaceDir: wsDir, targetLufs: -14.0, truePeakDbtp: -1.0 });
  assert.equal(normRes.adjusted_clips.length, 2);
  assert.equal(normRes.verification.ok, true);

  // 3b. Polish voice (afftdn + voice_clarity)
  const polishRes = polishVoiceAudio({ workspaceDir: wsDir, nrDb: 14.0 });
  assert.deepEqual(polishRes.polished_clips, ["sp_01", "sp_02"]);
  const sp1 = loadSequence(wsDir).sequence.spine.clips[0];
  assert.equal(sp1.audio_chain.denoise.enabled, true);
  assert.equal(sp1.audio_chain.denoise.nr_db, 14.0);
  assert.equal(sp1.audio_chain.voice_clarity.enabled, true);

  // 3c. Duck BGM under dialogue (-12 dB)
  const duckRes = duckMusicUnderDialogue({ workspaceDir: wsDir, duckDb: -12.0 });
  assert.equal(duckRes.ducked_cues.length, 1);
  assert.ok(duckRes.ducked_cues[0].envelope_points.some((p) => p.value === -12.0));

  // 3d. Beat-align spine clips to aud_01 beats
  const beatRes = alignClipsToBeats({ workspaceDir: wsDir, bgmHandle: "aud_01" });
  assert.ok(beatRes.estimated_bpm >= 115 && beatRes.estimated_bpm <= 125);
  assert.equal(beatRes.aligned_clips.length, 2);
});

test("4. Live Cloud API Integration (ElevenLabs with-timestamps TTS + Deepgram Nova-3 ASR + SQLite Cache + Visual Frame)", { skip: missingKeys("ELEVENLABS_API_KEY", "DEEPGRAM_API_KEY") }, async () => {
  loadDotEnvIfNeeded();

  const wsDir = path.join(TEST_ROOT, "speech_cleanup_mix_live_cloud");
  fs.rmSync(wsDir, { recursive: true, force: true });
  const { paths } = initWorkspace({ dir: wsDir, title: "Live Cloud ASR & TTS", aspect: "9:16", fps: 30 });

  const bgVid = path.join(wsDir, "bg.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#0F172A:s=1080x1920:r=30:d=6,drawgrid=w=120:h=120:t=2:c=#1E293B",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    bgVid,
  ]);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [bgVid] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 5000 });

  // 1. Live ElevenLabs TTS with-timestamps
  const ttsText = "Cuthol yapay zeka ajanları için açık kaynaklı bir kurgu motorudur.";
  const ttsLive = await synthesizeVoiceover({
    workspaceDir: wsDir,
    text: ttsText,
    provider: "elevenlabs",
    language: "tr",
    placeOnLane: "ln_vo",
    atMs: 200,
  });
  assert.equal(ttsLive.provider, "elevenlabs");
  assert.equal(ttsLive.cached, false);
  assert.ok(ttsLive.words.length >= 6, `Expected >= 6 aligned words from ElevenLabs, got ${ttsLive.words.length}`);
  assert.ok(ttsLive.duration_ms > 1500);

  // Verify second call hits SQLite cache with zero API usage
  const ttsCached = await synthesizeVoiceover({
    workspaceDir: wsDir,
    text: ttsText,
    provider: "elevenlabs",
    language: "tr",
  });
  assert.equal(ttsCached.cached, true);

  // 2. Copy the synthesized audio to a separate standalone audio file (`recorded_sample.mp3`)
  // and ingest as `aud_01` to test live Deepgram Nova-3 ASR without overwriting `vo_01`'s exact TTS alignment!
  const voAbsPath = path.resolve(wsDir, ttsLive.asset.uri);
  const separateAudioPath = path.join(wsDir, "recorded_sample.mp3");
  fs.copyFileSync(voAbsPath, separateAudioPath);
  // Append 1 trailing zero byte so its SHA-256 is distinct from `vo_01` and forces a real Deepgram API call
  fs.appendFileSync(separateAudioPath, Buffer.from([0]));

  const [asrTargetAsset] = ingestAssetsIntoWorkspace({
    workspaceDir: wsDir,
    filePaths: [separateAudioPath],
  });

  const asrLive = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: asrTargetAsset.handle,
    provider: "deepgram",
    language: "tr",
    keyterms: ["Cuthol"],
  });
  assert.equal(asrLive.transcript.provider, "deepgram");
  assert.ok(asrLive.transcript.words.length >= 5, `Expected >= 5 words from Deepgram, got ${asrLive.transcript.words.length}`);

  // Verify second call to Deepgram hits SQLite cache
  const asrCached = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: asrTargetAsset.handle,
    provider: "deepgram",
    language: "tr",
  });
  assert.equal(asrCached.cached, true);

  // 3. Generate active_word captions from `vo_01`'s exact ElevenLabs alignment and capture a monitor frame
  const capRes = generateSequenceCaptions({
    workspaceDir: wsDir,
    style: "active_word",
    language: "tr",
  });
  assert.ok(capRes.cues_created >= 1);
  assert.ok(capRes.cues[0].typography?.text.includes("Cuthol"), `Expected ground-truth 'Cuthol' in caption, got: ${capRes.cues[0].typography?.text}`);

  const frameOut = path.join(paths.monitorDir, "live_cloud_caption_frame.png");
  const frameRes = captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 1200,
    showBoxes: true,
    outputPath: frameOut,
  });
  assert.equal(frameRes.ok, true);
  assert.equal(frameRes.metrics.is_blank_frame, false);
  assert.ok(fs.existsSync(frameOut));
});
