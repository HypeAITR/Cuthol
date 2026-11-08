/**
 * Editing Tools (Spine Mute, Lane Excise, Extension Planner & Ergonomics)
 * (`src/test/editing_tools.test.ts`).
 *
 * Synthetic, offline (zero paid API calls) end-to-end verification of:
 * 1. Spine clip muting (`spine.mute` / `spine.unmute` for single clip, clip list, or all_spine),
 *    Cue Sheet `muted` round-trip (`export` -> `plan` -> `apply`), `mix.normalize` skipping muted
 *    clips (`skipped_muted_count`) without altering non-muted normalize output, and rendered audio proof.
 * 2. `lane.excise`: atomic multi-range excision on audio/video lane cues (`source`, `sequence`, `clip_local`),
 *    default same-lane ripple + re-anchoring of dependent cues (`anchor="cue_XX"`) + transcript word
 *    time shift + sample-level cross-correlation proof (< 1 ms offset), optional `across` modes,
 *    rejection of non-stream visual cues (`[CUTHOL-G310]`), and single-step undo.
 * 3. Extension Planner (`planners` in `cuthol-extension.json`): browserless composition event extraction
 *    (`events.json`, HTML `data-cuthol-event`, `<script id="cuthol-events">`, `C.event`), sequence-projected
 *    words in read-only snapshot, variable-length Cue Sheet patch validation (`dry_run` plan + single-revision
 *    `apply` + single-step `undo`), `[CUTHOL-G206]` write/network sandboxing, and zero-mutation rollback on
 *    invalid patches.
 * 4. `lane.add_cue --gain-db` and compact `workspace.open` summary on a 17-item library (`verbose=true` for full table).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSequence } from "../core/workspace.js";
import { CutholMcpServer } from "../mcp/server.js";
import { normalizeSequenceAudio } from "../mix/audio_mix.js";
import { compileSequenceAudioPlan } from "../compositor/compiler.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import {
  applyCueSheet,
  exportSequenceToCueSheet,
  planCueSheet,
} from "../sequence/cuesheet.js";
import { projectTranscriptAcrossSequence } from "../sequence/spine.js";

function safeRm(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  } catch {
    // ignore transient Windows cleanup lock
  }
}

function mcpText(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function makeTestVideoWithTone(
  outPath: string,
  durationSec: number,
  freqHz: number,
  colorHex = "0x1E293B"
): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${colorHex}:s=640x360:r=30:d=${durationSec}`,
      "-f",
      "lavfi",
      "-i",
      `aevalsrc='0.35*sin(2*PI*${freqHz}*t)*(0.6+0.4*sin(2*PI*3*t))':s=48000:d=${durationSec}`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      outPath,
    ],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(proc.status, 0, proc.stderr);
}

/**
 * Generates a 48 kHz mono WAV with a non-periodicchirp + multi-frequency signature so any window
 * has a unique cross-correlation peak with sub-sample (< 0.1 ms) precision.
 */
function makeUniqueSignatureWav(
  outPath: string,
  durationSec: number,
  sampleRate = 48000,
  seedOffset = 0
): Float64Array {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const totalSamples = Math.round(durationSec * sampleRate);
  const samples = new Float64Array(totalSamples);
  const pcmBuf = Buffer.alloc(44 + totalSamples * 2);

  // RIFF WAVE header (16-bit PCM mono)
  pcmBuf.write("RIFF", 0);
  pcmBuf.writeUInt32LE(36 + totalSamples * 2, 4);
  pcmBuf.write("WAVE", 8);
  pcmBuf.write("fmt ", 12);
  pcmBuf.writeUInt32LE(16, 16);
  pcmBuf.writeUInt16LE(1, 20); // PCM
  pcmBuf.writeUInt16LE(1, 22); // 1 channel
  pcmBuf.writeUInt32LE(sampleRate, 24);
  pcmBuf.writeUInt32LE(sampleRate * 2, 28);
  pcmBuf.writeUInt16LE(2, 32);
  pcmBuf.writeUInt16LE(16, 34);
  pcmBuf.write("data", 36);
  pcmBuf.writeUInt32LE(totalSamples * 2, 40);

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    // Quadratic chirp + prime-irrational FM + amplitude modulation so no two windows correlate
    const phase1 = 2 * Math.PI * ((180 + seedOffset * 13) * t + 7.5 * t * t);
    const phase2 = 2 * Math.PI * ((310 + seedOffset * 7) * t + 45 * Math.sin(2 * Math.PI * 1.732 * t));
    const phase3 = 2 * Math.PI * ((670 + seedOffset * 19) * t + 30 * Math.cos(2 * Math.PI * 2.236 * t));
    const env = 0.55 + 0.35 * Math.sin(2 * Math.PI * 0.41 * t + 0.3 + seedOffset);
    const val = env * (0.45 * Math.sin(phase1) + 0.35 * Math.sin(phase2) + 0.2 * Math.sin(phase3));
    samples[i] = val;
    const s16 = Math.max(-32767, Math.min(32767, Math.round(val * 28000)));
    pcmBuf.writeInt16LE(s16, 44 + i * 2);
  }

  fs.writeFileSync(outPath, pcmBuf);
  return samples;
}

function decodeAudioToMonoFloat64(mediaPath: string, sampleRate = 48000): Float64Array {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      mediaPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "s16le",
      "pipe:1",
    ],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  );
  assert.equal(proc.status, 0, proc.stderr?.toString("utf8") ?? "ffmpeg decode failed");
  const raw = proc.stdout as Buffer;
  const count = Math.floor(raw.length / 2);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = raw.readInt16LE(i * 2) / 28000;
  }
  return out;
}

function computeRms(arr: Float64Array, startSample: number, endSample: number): number {
  const st = Math.max(0, startSample);
  const en = Math.min(arr.length, endSample);
  if (en <= st) return 0;
  let sumSq = 0;
  for (let i = st; i < en; i++) {
    sumSq += arr[i] * arr[i];
  }
  return Math.sqrt(sumSq / (en - st));
}

function normalizedCrossCorrelation(
  a: Float64Array,
  aStart: number,
  b: Float64Array,
  bStart: number,
  length: number
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    const va = a[aStart + i] ?? 0;
    const vb = b[bStart + i] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA * normB);
  return denom > 1e-12 ? dot / denom : 0;
}

test("1. Spine mute/unmute (single, list, all_spine), Cue Sheet round-trip, mix.normalize skip & rendered audio proof", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-mute-"));
  const projDir = path.join(tmpDir, "proj");
  const mediaDir = path.join(tmpDir, "media");

  try {
    const vid1Path = path.join(mediaDir, "clip1.mp4");
    const vid2Path = path.join(mediaDir, "clip2.mp4");
    const voPath = path.join(mediaDir, "vo.wav");
    makeTestVideoWithTone(vid1Path, 2.0, 440, "0x1D4ED8");
    makeTestVideoWithTone(vid2Path, 2.0, 880, "0x047857");
    makeUniqueSignatureWav(voPath, 4.0);

    const mcp = new CutholMcpServer({ structuredOutput: true });
    await mcp.callTool("workspace", { action: "init", dir: projDir, aspect: "16:9", fps: 30 });
    await mcp.callTool("library", { action: "ingest", files: [vid1Path, vid2Path, voPath] });
    await mcp.callTool("spine", { action: "append", asset: "vid_01" });
    await mcp.callTool("spine", { action: "append", asset: "vid_02" });
    await mcp.callTool("lane", {
      action: "add_cue",
      lane: "ln_vo",
      kind: "voiceover",
      asset: "aud_01",
      at: "0s",
      duration: "4s",
      gain_db: -3.5,
    });

    // Verify lane.add_cue --gain-db was applied
    const seqInitial = loadSequence(projDir).sequence;
    const voCueInitial = seqInitial.lanes.find((l) => l.id === "ln_vo")?.cues[0];
    assert.ok(voCueInitial, "vo cue must exist");
    assert.equal(voCueInitial.audio_chain?.gain_db, -3.5, "lane.add_cue must apply gain_db=-3.5");

    // Counter-metric: normalize on an unmuted project has no skipped_muted_count and adjusts all 3 items
    const normUnmuted = normalizeSequenceAudio({ workspaceDir: projDir, targetLufs: -14 });
    assert.equal(normUnmuted.adjusted_clips_count, 3);
    assert.equal(normUnmuted.skipped_muted_count, undefined, "unmuted project must not emit skipped_muted_count");
    assert.deepEqual(
      normUnmuted.adjusted_clips.map((c) => c.id),
      ["sp_01", "sp_02", "cue_01"]
    );

    // Undo normalize back to clean state
    const undoNorm = await mcp.callTool("workspace", { action: "undo" });
    assert.equal(undoNorm.isError, false, mcpText(undoNorm));

    // Mute sp_01 via MCP spine(action="mute", clip="sp_01")
    const muteRes = await mcp.callTool("spine", { action: "mute", clip: "sp_01" });
    assert.equal(muteRes.isError, false, mcpText(muteRes));
    let seq = loadSequence(projDir).sequence;
    assert.equal(seq.spine.clips[0].audio_chain.muted, true);
    assert.equal(seq.spine.clips[1].audio_chain.muted, false);

    // Run mix.normalize while sp_01 is muted: sp_01 must NOT be adjusted or listed in adjusted_clips
    const normMuted = normalizeSequenceAudio({ workspaceDir: projDir, targetLufs: -14 });
    assert.equal(normMuted.adjusted_clips_count, 2);
    assert.equal(normMuted.skipped_muted_count, 1);
    assert.deepEqual(
      normMuted.adjusted_clips.map((c) => c.id),
      ["sp_02", "cue_01"],
      "muted clip sp_01 must not appear in adjusted_clips"
    );
    seq = loadSequence(projDir).sequence;
    assert.equal(seq.spine.clips[0].audio_chain.gain_db, 0, "muted clip gain_db must remain untouched");
    assert.equal(seq.spine.clips[0].audio_chain.loudness_target_lufs, null);

    // Undo normalize, then mute ln_vo cue so we can measure rendered spine audio directly
    await mcp.callTool("workspace", { action: "undo" });
    await mcp.callTool("lane", { action: "update_cue", cue: "cue_01", muted: true });

    const outMp4 = path.join(projDir, "render_mute_test.mp4");
    const renderRes = renderSequenceToMp4({
      workspaceDir: projDir,
      preset: "draft_480p",
      outputPath: outMp4,
    });
    assert.ok(fs.existsSync(renderRes.output_path));

    const renderedPcm = decodeAudioToMonoFloat64(renderRes.output_path, 48000);
    const src1Pcm = decodeAudioToMonoFloat64(vid1Path, 48000);
    const src2Pcm = decodeAudioToMonoFloat64(vid2Path, 48000);

    // Measure 0.2s..1.8s (inside muted sp_01) vs 2.2s..3.8s (inside unmuted sp_02)
    const rmsSp1 = computeRms(renderedPcm, Math.round(0.2 * 48000), Math.round(1.8 * 48000));
    const rmsSp2 = computeRms(renderedPcm, Math.round(2.2 * 48000), Math.round(3.8 * 48000));
    const corrSp1 = normalizedCrossCorrelation(
      renderedPcm,
      Math.round(0.2 * 48000),
      src1Pcm,
      Math.round(0.2 * 48000),
      Math.round(1.5 * 48000)
    );
    let maxCorrSp2 = -1;
    for (let lag = -512; lag <= 512; lag += 4) {
      const c = normalizedCrossCorrelation(
        renderedPcm,
        Math.round(2.2 * 48000),
        src2Pcm,
        Math.round(0.2 * 48000) + lag,
        Math.round(1.2 * 48000)
      );
      if (c > maxCorrSp2) maxCorrSp2 = c;
    }

    assert.ok(rmsSp1 < 1e-4, `Expected muted sp_01 RMS < 1e-4, got ${rmsSp1}`);
    assert.ok(Math.abs(corrSp1) < 1e-3, `Expected muted sp_01 correlation ~ 0, got ${corrSp1}`);
    assert.ok(rmsSp2 > 0.1, `Expected unmuted sp_02 RMS > 0.1, got ${rmsSp2}`);
    assert.ok(maxCorrSp2 > 0.95, `Expected unmuted sp_02 correlation > 0.95, got ${maxCorrSp2}`);

    // Cue Sheet export / plan / apply round-trip preserves `muted`
    const exportedSheet = exportSequenceToCueSheet(loadSequence(projDir).sequence);
    assert.equal(exportedSheet.spine?.[0]?.muted, true);
    assert.equal(exportedSheet.spine?.[1]?.muted, false);
    assert.equal(exportedSheet.cues?.[0]?.muted, true);

    // Flip mute states in Cue Sheet and apply
    exportedSheet.spine![0].muted = false;
    exportedSheet.spine![1].muted = true;
    exportedSheet.cues![0].muted = false;
    const planRes = planCueSheet(projDir, exportedSheet);
    assert.equal(planRes.would_commit, true);
    assert.deepEqual(planRes.diff.spine_updated, ["sp_01", "sp_02"]);
    applyCueSheet(projDir, exportedSheet);

    seq = loadSequence(projDir).sequence;
    assert.equal(seq.spine.clips[0].audio_chain.muted, false);
    assert.equal(seq.spine.clips[1].audio_chain.muted, true);
    assert.equal(seq.lanes.find((l) => l.id === "ln_vo")?.cues[0]?.audio_chain?.muted, false);

    // Mute all_spine, then unmute list, then undo
    await mcp.callTool("spine", { action: "mute", all_spine: true });
    seq = loadSequence(projDir).sequence;
    assert.ok(seq.spine.clips.every((c) => c.audio_chain.muted === true));

    const revBeforeUnmute = seq.meta.revision;
    await mcp.callTool("spine", { action: "unmute", clips: ["sp_01", "sp_02"] });
    seq = loadSequence(projDir).sequence;
    assert.ok(seq.spine.clips.every((c) => c.audio_chain.muted === false));

    await mcp.callTool("workspace", { action: "undo", expect_rev: seq.meta.revision });
    seq = loadSequence(projDir).sequence;
    assert.equal(seq.meta.revision, revBeforeUnmute);
    assert.ok(seq.spine.clips.every((c) => c.audio_chain.muted === true));
  } finally {
    safeRm(tmpDir);
  }
});

test("2. lane.excise on 30s voiceover cue (remove 10..14s -> 26s, < 1ms audio correlation, anchored SFX shift, word timing shift, visual cue guard, single-step undo)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-excise-"));
  const projDir = path.join(tmpDir, "proj");
  const mediaDir = path.join(tmpDir, "media");

  try {
    const sampleRate = 48000;
    const vo30Path = path.join(mediaDir, "vo30.wav");
    const sfxPath = path.join(mediaDir, "sfx.wav");
    const vidPath = path.join(mediaDir, "bg.mp4");

    const sourceSamples = makeUniqueSignatureWav(vo30Path, 30.0, sampleRate);
    makeUniqueSignatureWav(sfxPath, 0.5, sampleRate);
    makeTestVideoWithTone(vidPath, 30.0, 220, "0x0F172A");

    // Write a local sidecar transcript for vo30.wav so `speech transcribe --provider local` works offline
    const sidecarWords = [
      { word: "giriş", punctuated_word: "Giriş", source_start_ms: 2000, source_end_ms: 2600, confidence: 0.99 },
      { word: "merhaba", punctuated_word: "merhaba", source_start_ms: 8000, source_end_ms: 8600, confidence: 0.99 },
      { word: "hatalı", punctuated_word: "hatalı", source_start_ms: 11000, source_end_ms: 11700, confidence: 0.95 },
      { word: "cümle", punctuated_word: "cümle.", source_start_ms: 12200, source_end_ms: 13100, confidence: 0.95 },
      { word: "devam", punctuated_word: "Devam", source_start_ms: 15000, source_end_ms: 15600, confidence: 0.99 },
      { word: "ediyoruz", punctuated_word: "ediyoruz", source_start_ms: 16000, source_end_ms: 16800, confidence: 0.99 },
      { word: "kapanış", punctuated_word: "kapanış.", source_start_ms: 25000, source_end_ms: 25800, confidence: 0.99 },
    ];
    fs.writeFileSync(
      `${vo30Path}.transcript.json`,
      JSON.stringify({ language: "tr", text: "Giriş merhaba hatalı cümle. Devam ediyoruz kapanış.", words: sidecarWords }, null, 2),
      "utf8"
    );

    const mcp = new CutholMcpServer({ structuredOutput: true });
    await mcp.callTool("workspace", { action: "init", dir: projDir, aspect: "16:9", fps: 30 });
    await mcp.callTool("library", { action: "ingest", files: [vidPath, vo30Path, sfxPath] });
    await mcp.callTool("spine", { action: "append", asset: "vid_01" });
    await mcp.callTool("spine", { action: "mute", clip: "sp_01" });

    // Place 30s voiceover on ln_vo as cue_01
    const addVo = await mcp.callTool("lane", {
      action: "add_cue",
      lane: "ln_vo",
      kind: "voiceover",
      asset: "aud_01",
      at: "0s",
      duration: "30s",
      id: "cue_01",
    });
    assert.equal(addVo.isError, false, mcpText(addVo));

    // Place a subsequent cue on the same ln_vo lane at 31s (31000ms) to verify same-lane ripple
    await mcp.callTool("lane", {
      action: "add_cue",
      lane: "ln_vo",
      kind: "voiceover",
      asset: "aud_02",
      at: "31s",
      duration: "500ms",
      id: "cue_tail",
    });

    // Place an SFX cue on ln_sfx anchored to cue_01 at offset 18s (18000ms)
    const addSfx = await mcp.callTool("lane", {
      action: "add_cue",
      lane: "ln_sfx",
      kind: "sfx",
      asset: "aud_02",
      anchor: "cue_01",
      offset: "18s",
      duration: "500ms",
      gain_db: -6,
      id: "cue_sfx",
    });
    assert.equal(addSfx.isError, false, mcpText(addSfx));

    // Place a title cue on ln_titles to test visual cue guard
    await mcp.callTool("lane", {
      action: "add_cue",
      lane: "ln_titles",
      kind: "title",
      text: "Başlık",
      at: "1s",
      duration: "3s",
      id: "cue_title",
    });

    // Transcribe aud_01 offline via local provider & generate captions + mount a composition to verify C.word
    const transRes = await mcp.callTool("speech", {
      action: "transcribe",
      handle: "aud_01",
      provider: "local",
      lang: "tr",
    });
    assert.equal(transRes.isError, false, mcpText(transRes));

    const capRes = await mcp.callTool("speech", { action: "captions", lang: "tr" });
    assert.equal(capRes.isError, false, mcpText(capRes));

    await mcp.callTool("composition", {
      action: "scaffold",
      comp_dir: "compositions/word_check",
      preset: "blank",
      duration: "26s",
    });
    await mcp.callTool("lane", {
      action: "add_composition",
      lane: "ln_motion",
      comp_dir: "compositions/word_check",
      at: "0s",
      duration: "26s",
      id: "cue_comp",
    });

    // Visual non-stream cue (title / composition) must be rejected by lane.excise with CUTHOL-G310
    const badTitleExcise = await mcp.callTool("lane", {
      action: "excise",
      cue: "cue_title",
      ranges: ["500ms..1500ms"],
    });
    assert.equal(badTitleExcise.isError, true);
    assert.match(mcpText(badTitleExcise), /CUTHOL-G310/);

    const revBeforeExcise = loadSequence(projDir).sequence.meta.revision;

    // Excise 10s..14s from 30s voiceover cue_01
    const exciseRes = await mcp.callTool("lane", {
      action: "excise",
      cue: "cue_01",
      ranges: ["10s..14s"],
      coord: "source",
    });
    assert.equal(exciseRes.isError, false, mcpText(exciseRes));

    const seqAfter = loadSequence(projDir).sequence;
    assert.equal(
      seqAfter.meta.revision,
      revBeforeExcise + 1,
      "lane.excise must commit as a single atomic revision"
    );

    const voLane = seqAfter.lanes.find((l) => l.id === "ln_vo")!;
    assert.equal(voLane.cues.length, 3, "ln_vo must contain 2 split VO parts + shifted cue_tail");
    const [part1, part2, tailAfter] = voLane.cues;
    assert.equal(part1.id, "cue_01");
    assert.equal(part1.at_ms, 0);
    assert.equal(part1.duration_ms, 10000);
    assert.equal(part1.source_in_ms, 0);
    assert.equal(part1.source_out_ms, 10000);

    assert.equal(part2.at_ms, 10000);
    assert.equal(part2.duration_ms, 16000);
    assert.equal(part2.source_in_ms, 14000);
    assert.equal(part2.source_out_ms, 30000);
    assert.equal(part1.duration_ms + part2.duration_ms, 26000, "Total voiceover duration must be 26000ms (26s)");
    assert.equal(tailAfter.id, "cue_tail");
    assert.equal(tailAfter.at_ms, 27000, "Subsequent cue_tail on same lane must shift from 31000ms -> 27000ms");

    // Verify anchored SFX cue shifted from 18000ms -> 14000ms (4s earlier) and re-anchored to part2
    const sfxCue = seqAfter.lanes.find((l) => l.id === "ln_sfx")!.cues.find((c) => c.id === "cue_sfx")!;
    assert.equal(sfxCue.at_ms, 14000, "Anchored SFX cue at 18s must shift by 4s to 14000ms");
    assert.equal(sfxCue.cue_anchor?.ref, part2.id);
    assert.equal(sfxCue.cue_anchor?.offset_ms, 4000);

    // Verify transcript word projection shifted by 4000ms after the cut and marked 10..14s words as excised
    const projectedWords = projectTranscriptAcrossSequence(seqAfter, "aud_01", sidecarWords);
    const wGiris = projectedWords.find((w) => w.word === "giriş")!;
    const wHatali = projectedWords.find((w) => w.word === "hatalı")!;
    const wCumle = projectedWords.find((w) => w.word === "cümle")!;
    const wDevam = projectedWords.find((w) => w.word === "devam")!;
    const wKapanis = projectedWords.find((w) => w.word === "kapanış")!;

    assert.equal(wGiris.excised, false);
    assert.equal(wGiris.sequence_start_ms, 2000);
    assert.equal(wHatali.excised, true);
    assert.equal(wHatali.sequence_start_ms, null);
    assert.equal(wCumle.excised, true);
    assert.equal(wCumle.sequence_start_ms, null);
    assert.equal(wDevam.excised, false);
    assert.equal(wDevam.sequence_start_ms, 11000, "Word at 15000ms source must shift by 4000ms to 11000ms");
    assert.equal(wKapanis.excised, false);
    assert.equal(wKapanis.sequence_start_ms, 21000, "Word at 25000ms source must shift by 4000ms to 21000ms");

    // Verify composition bridge data (assets/cuthol-data.json -> C.word) also shifted by 4.0s
    const bridgeJsonPath = path.join(projDir, "compositions", "word_check", "assets", "cuthol-data.json");
    assert.ok(fs.existsSync(bridgeJsonPath), "Composition cuthol-data.json must be synced");
    const bridgeData = JSON.parse(fs.readFileSync(bridgeJsonPath, "utf8")) as {
      words: Array<{ text: string; t0: number; t1: number }>;
    };
    const bridgeDevam = bridgeData.words.find((w) => w.text.toLowerCase() === "devam");
    assert.ok(bridgeDevam, "Devam must exist in composition bridge words");
    assert.equal(bridgeDevam.t0, 11.0, "Bridge word 'Devam' local/sequence start must be 11.0s");
    assert.ok(
      !bridgeData.words.some((w) => w.text.toLowerCase() === "hatalı"),
      "Excised word 'hatalı' must not appear in composition bridge words"
    );

    // Measure compiled sequence audio correlation after 10.0s against source 14.0s (mute SFX temporarily on a clone to measure pure VO)
    const { paths, sequence: seqForAudio } = loadSequence(projDir);
    const clonedForVoMeasure = structuredClone(seqForAudio);
    for (const l of clonedForVoMeasure.lanes) {
      if (l.id !== "ln_vo") l.muted = true;
    }
    const audioPlan = compileSequenceAudioPlan(clonedForVoMeasure, paths, undefined, {
      applyMasterFinalize: false,
    });
    assert.equal(audioPlan.hasActiveAudio, true);

    const outVoWav = path.join(tmpDir, "compiled_vo.wav");
    const ffOut = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        ...audioPlan.inputArgs,
        "-filter_complex",
        audioPlan.filterComplex,
        "-map",
        audioPlan.audioOutPad,
        "-ac",
        "1",
        "-ar",
        String(sampleRate),
        "-c:a",
        "pcm_s16le",
        outVoWav,
      ],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(ffOut.status, 0, ffOut.stderr);

    const compiledSamples = decodeAudioToMonoFloat64(outVoWav, sampleRate);
    // Search lag in [-240 .. +240] samples (-5ms .. +5ms) comparing compiled [10.2s .. 13.2s] to source [14.2s .. 17.2s]
    const winStartCompiled = Math.round(10.2 * sampleRate);
    const winStartSource = Math.round(14.2 * sampleRate);
    const winLen = Math.round(3.0 * sampleRate);

    let bestLagSamples = 0;
    let bestCorr = -1;
    for (let lag = -240; lag <= 240; lag++) {
      const c = normalizedCrossCorrelation(
        compiledSamples,
        winStartCompiled,
        sourceSamples,
        winStartSource + lag,
        winLen
      );
      if (c > bestCorr) {
        bestCorr = c;
        bestLagSamples = lag;
      }
    }
    const offsetMs = Math.abs((bestLagSamples / sampleRate) * 1000);
    assert.ok(bestCorr > 0.99, `Expected post-cut correlation > 0.99 with source 14s, got ${bestCorr}`);
    assert.ok(offsetMs < 1.0, `Expected post-cut alignment offset < 1.0ms, got ${offsetMs.toFixed(3)}ms (${bestLagSamples} samples)`);

    // Single-step undo restores 30s cue_01, cue_sfx at 18000ms, and original word timings
    const undoRes = await mcp.callTool("workspace", {
      action: "undo",
      expect_rev: seqAfter.meta.revision,
    });
    assert.equal(undoRes.isError, false, mcpText(undoRes));

    const seqRestored = loadSequence(projDir).sequence;
    assert.equal(seqRestored.meta.revision, revBeforeExcise);
    const restoredVoLane = seqRestored.lanes.find((l) => l.id === "ln_vo")!;
    assert.equal(restoredVoLane.cues.length, 2);
    assert.equal(restoredVoLane.cues[0].id, "cue_01");
    assert.equal(restoredVoLane.cues[0].duration_ms, 30000);
    assert.equal(restoredVoLane.cues[1].id, "cue_tail");
    assert.equal(restoredVoLane.cues[1].at_ms, 31000);
    const restoredSfx = seqRestored.lanes.find((l) => l.id === "ln_sfx")!.cues[0];
    assert.equal(restoredSfx.at_ms, 18000);

    // Also test across="all" (rippling spine + all lanes simultaneously in one atomic step)
    const acrossAllRes = await mcp.callTool("lane", {
      action: "excise",
      cue: "cue_01",
      ranges: ["10s..14s"],
      coord: "sequence",
      across: "all",
    });
    assert.equal(acrossAllRes.isError, false, mcpText(acrossAllRes));
    const seqAcrossAll = loadSequence(projDir).sequence;
    const totalSpineDur = seqAcrossAll.spine.clips.reduce((s, c) => s + c.duration_ms, 0);
    assert.equal(totalSpineDur, 26000, "across='all' must also excise 4000ms from the 30s spine clip");
    await mcp.callTool("workspace", { action: "undo" });
  } finally {
    safeRm(tmpDir);
  }
});

test("3. Extension planner: two compositions' declared events + word timing -> variable SFX cues, dry_run, single-revision apply, undo, G206 security & invalid patch rollback", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-planner-"));
  const projDir = path.join(tmpDir, "proj");
  const extRootDir = path.join(tmpDir, "ext_store");
  const mediaDir = path.join(tmpDir, "media");

  const prevExtEnv = process.env.CUTHOL_EXTENSIONS_DIR;
  process.env.CUTHOL_EXTENSIONS_DIR = extRootDir;

  try {
    const vidPath = path.join(mediaDir, "bg.mp4");
    const voPath = path.join(mediaDir, "vo.wav");
    const sfxDropPath = path.join(mediaDir, "paper_drop.wav");
    const sfxWhooshPath = path.join(mediaDir, "whoosh.wav");

    makeTestVideoWithTone(vidPath, 12.0, 220);
    makeUniqueSignatureWav(voPath, 12.0);
    makeUniqueSignatureWav(sfxDropPath, 0.4);
    makeUniqueSignatureWav(sfxWhooshPath, 0.35);

    fs.writeFileSync(
      `${voPath}.transcript.json`,
      JSON.stringify({
        language: "tr",
        text: "Şimdi kağıt düşüyor ve vurgu yapılıyor.",
        words: [
          { word: "Şimdi", punctuated_word: "Şimdi", source_start_ms: 1000, source_end_ms: 1400, confidence: 0.99 },
          { word: "kağıt", punctuated_word: "kağıt", source_start_ms: 2000, source_end_ms: 2500, confidence: 0.99 },
          { word: "vurgu", punctuated_word: "vurgu", source_start_ms: 6400, source_end_ms: 6900, confidence: 0.99 },
        ],
      }),
      "utf8"
    );

    const mcp = new CutholMcpServer({ structuredOutput: true });
    await mcp.callTool("workspace", { action: "init", dir: projDir, aspect: "16:9", fps: 30 });
    await mcp.callTool("library", {
      action: "ingest",
      files: [vidPath, voPath, sfxDropPath, sfxWhooshPath],
    });
    await mcp.callTool("spine", { action: "append", asset: "vid_01" });
    await mcp.callTool("lane", {
      action: "add_cue",
      lane: "ln_vo",
      kind: "voiceover",
      asset: "aud_01",
      at: "0s",
      duration: "12s",
    });
    await mcp.callTool("speech", {
      action: "transcribe",
      handle: "aud_01",
      provider: "local",
      lang: "tr",
    });

    // Composition 1 (mounted at 2000ms..6000ms): declares events via events.json
    await mcp.callTool("composition", {
      action: "scaffold",
      comp_dir: "compositions/scene_one",
      preset: "blank",
      duration: "4s",
    });
    fs.writeFileSync(
      path.join(projDir, "compositions", "scene_one", "events.json"),
      JSON.stringify(
        [
          { name: "paper_drop", at_ms: 800, meta: { gain_db: -4 } },
          { name: "card_whoosh", at_sec: 2.1, meta: { gain_db: -7 } },
        ],
        null,
        2
      ),
      "utf8"
    );
    await mcp.callTool("lane", {
      action: "add_composition",
      lane: "ln_motion",
      comp_dir: "compositions/scene_one",
      at: "2s",
      duration: "4s",
      id: "cue_comp_1",
    });

    // Composition 2 (mounted at 7000ms..11000ms): declares event via HTML data-cuthol-event attribute
    await mcp.callTool("composition", {
      action: "scaffold",
      comp_dir: "compositions/scene_two",
      preset: "blank",
      duration: "4s",
    });
    const comp2HtmlPath = path.join(projDir, "compositions", "scene_two", "index.html");
    const comp2Html = fs
      .readFileSync(comp2HtmlPath, "utf8")
      .replace(
        "</div>",
        '  <div id="sheet" data-cuthol-event="paper_drop" data-cuthol-at="1250ms" data-cuthol-meta=\'{"gain_db":-5}\'></div>\n</div>'
      );
    fs.writeFileSync(comp2HtmlPath, comp2Html, "utf8");
    await mcp.callTool("lane", {
      action: "add_composition",
      lane: "ln_motion",
      comp_dir: "compositions/scene_two",
      at: "7s",
      duration: "4s",
      id: "cue_comp_2",
    });

    // Create project-scoped planner extension `paper_sfx`
    const createExt = await mcp.callTool("extension", {
      action: "create",
      name: "paper_sfx",
      scope: "project",
      template: "planner",
      description: "Places SFX cues on paper_drop / card_whoosh events and target keyword",
    });
    assert.equal(createExt.isError, false, mcpText(createExt));

    const extDir = path.join(projDir, ".cuthol", "extensions", "paper_sfx");
    const plannerManifest = {
      schema_version: "1.0.0",
      name: "paper_sfx",
      version: "1.0.0",
      description: "Event and word driven SFX planner",
      planners: {
        sync_sfx: {
          description: "Generates SFX cues for paper_drop, card_whoosh and keyword matches.",
          script: "planner.js",
          params: {
            drop_asset: { type: "string", default: "aud_02" },
            whoosh_asset: { type: "string", default: "aud_03" },
            keyword: { type: "string", default: "vurgu" },
            mode: { type: "string", default: "normal" },
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(extDir, "cuthol-extension.json"),
      JSON.stringify(plannerManifest, null, 2),
      "utf8"
    );

    const plannerJs = [
      `#!/usr/bin/env node`,
      `const fs = require("node:fs");`,
      `const path = require("node:path");`,
      `const [snapshotPath, outputPath, rawParams] = process.argv.slice(2);`,
      `const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));`,
      `const params = rawParams ? JSON.parse(rawParams) : (snap.params || {});`,
      `if (params.mode === "write_violation") {`,
      `  fs.writeFileSync(path.join(snap.workspace_dir, "hacked.txt"), "bad", "utf8");`,
      `}`,
      `if (params.mode === "sandbox_violation") {`,
      `  fs.writeFileSync(path.join(path.dirname(outputPath), "extra_unauthorized.txt"), "bad", "utf8");`,
      `}`,
      `if (params.mode === "bad_patch") {`,
      `  fs.writeFileSync(outputPath, JSON.stringify({ cues: [{ lane_id: "ln_sfx", kind: "sfx", asset_handle: "aud_999", at_ms: 1000, duration_ms: 400 }] }), "utf8");`,
      `  process.exit(0);`,
      `}`,
      `const cues = [];`,
      `for (const ev of snap.events) {`,
      `  if (ev.name === "paper_drop") {`,
      `    cues.push({`,
      `      lane_id: "ln_sfx",`,
      `      kind: "sfx",`,
      `      asset_handle: params.drop_asset,`,
      `      at_ms: ev.sequence_ms,`,
      `      duration_ms: 400,`,
      `      gain_db: (ev.meta && typeof ev.meta.gain_db === "number") ? ev.meta.gain_db : -5,`,
      `    });`,
      `  } else if (ev.name === "card_whoosh") {`,
      `    cues.push({`,
      `      lane_id: "ln_sfx",`,
      `      kind: "sfx",`,
      `      asset_handle: params.whoosh_asset,`,
      `      at_ms: ev.sequence_ms,`,
      `      duration_ms: 350,`,
      `      gain_db: (ev.meta && typeof ev.meta.gain_db === "number") ? ev.meta.gain_db : -6,`,
      `    });`,
      `  }`,
      `}`,
      `for (const w of snap.words) {`,
      `  if (w.norm === params.keyword) {`,
      `    cues.push({`,
      `      lane_id: "ln_sfx",`,
      `      kind: "sfx",`,
      `      asset_handle: params.whoosh_asset,`,
      `      at_ms: w.sequence_start_ms,`,
      `      duration_ms: 350,`,
      `      gain_db: -4,`,
      `    });`,
      `  }`,
      `}`,
      `fs.writeFileSync(outputPath, JSON.stringify({ cues, notes: ["Generated " + cues.length + " SFX cues"] }, null, 2), "utf8");`,
    ].join("\n");
    fs.writeFileSync(path.join(extDir, "planner.js"), plannerJs, "utf8");

    const revBeforePlan = loadSequence(projDir).sequence.meta.revision;

    // 3a. Dry-run planner: shows plan (4 cues: 2800ms, 4100ms, 8250ms, 6400ms) without changing revision
    const dryRes = await mcp.callTool("extension", {
      action: "run",
      name: "paper_sfx",
      planner: "sync_sfx",
      dry_run: true,
    });
    assert.equal(dryRes.isError, false, mcpText(dryRes));
    assert.equal(loadSequence(projDir).sequence.meta.revision, revBeforePlan);
    const dryEnv = dryRes.envelope as {
      would_commit?: boolean;
      cues_added?: string[];
      snapshot_summary?: { compositions_count: number; declared_events_count: number; projected_words_count: number };
    };
    assert.equal(dryEnv.would_commit, true);
    assert.equal(dryEnv.cues_added?.length, 4);
    assert.equal(dryEnv.snapshot_summary?.compositions_count, 2);
    assert.equal(dryEnv.snapshot_summary?.declared_events_count, 3);
    assert.equal(dryEnv.snapshot_summary?.projected_words_count, 3);

    // 3b. Apply planner: commits all 4 SFX cues in a SINGLE atomic revision (rN -> r(N+1))
    const runRes = await mcp.callTool("extension", {
      action: "run",
      name: "paper_sfx",
      planner: "sync_sfx",
    });
    assert.equal(runRes.isError, false, mcpText(runRes));

    const seqAfterApply = loadSequence(projDir).sequence;
    assert.equal(
      seqAfterApply.meta.revision,
      revBeforePlan + 1,
      "Planner apply must increment revision by exactly 1"
    );
    const sfxLane = seqAfterApply.lanes.find((l) => l.id === "ln_sfx")!;
    assert.equal(sfxLane.cues.length, 4);
    const sfxTimes = sfxLane.cues.map((c) => c.at_ms).sort((a, b) => a - b);
    // comp1: 2000+800=2800, 2000+2100=4100; word 'vurgu': 6400; comp2: 7000+1250=8250
    assert.deepEqual(sfxTimes, [2800, 4100, 6400, 8250]);

    // 3c. Single undo reverts all 4 generated SFX cues at once
    const undoRes = await mcp.callTool("workspace", {
      action: "undo",
      expect_rev: seqAfterApply.meta.revision,
    });
    assert.equal(undoRes.isError, false, mcpText(undoRes));
    const seqAfterUndo = loadSequence(projDir).sequence;
    assert.equal(seqAfterUndo.meta.revision, revBeforePlan);
    assert.equal(seqAfterUndo.lanes.find((l) => l.id === "ln_sfx")?.cues.length ?? 0, 0);

    // 3d. Invalid patch (dangling asset handle aud_999) applies NOTHING and keeps revision unchanged
    const badPatchRes = await mcp.callTool("extension", {
      action: "run",
      name: "paper_sfx",
      planner: "sync_sfx",
      params: { mode: "bad_patch" },
    });
    assert.equal(badPatchRes.isError, true);
    assert.match(mcpText(badPatchRes), /CUTHOL-G103/);
    assert.equal(loadSequence(projDir).sequence.meta.revision, revBeforePlan);
    assert.equal(loadSequence(projDir).sequence.lanes.find((l) => l.id === "ln_sfx")?.cues.length ?? 0, 0);

    // 3e. Security violation: writing outside output file (workspace write & sandbox extra file) -> CUTHOL-G206
    const writeViolRes = await mcp.callTool("extension", {
      action: "run",
      name: "paper_sfx",
      planner: "sync_sfx",
      params: { mode: "write_violation" },
    });
    assert.equal(writeViolRes.isError, true);
    assert.match(mcpText(writeViolRes), /CUTHOL-G206/);
    assert.equal(fs.existsSync(path.join(projDir, "hacked.txt")), false);

    const sandboxViolRes = await mcp.callTool("extension", {
      action: "run",
      name: "paper_sfx",
      planner: "sync_sfx",
      params: { mode: "sandbox_violation" },
    });
    assert.equal(sandboxViolRes.isError, true);
    assert.match(mcpText(sandboxViolRes), /CUTHOL-G206/);

    // 3f. Network restriction: planner using fetch() when manifest has network: false -> CUTHOL-G206
    fs.writeFileSync(
      path.join(extDir, "planner.js"),
      `const fs = require("node:fs"); fetch("https://example.com");\n`,
      "utf8"
    );
    const netViolRes = await mcp.callTool("extension", {
      action: "run",
      name: "paper_sfx",
      planner: "sync_sfx",
    });
    assert.equal(netViolRes.isError, true);
    assert.match(mcpText(netViolRes), /CUTHOL-G206/);
  } finally {
    if (prevExtEnv === undefined) delete process.env.CUTHOL_EXTENSIONS_DIR;
    else process.env.CUTHOL_EXTENSIONS_DIR = prevExtEnv;
    safeRm(tmpDir);
  }
});

test("4. workspace.open compact summary on 17-item library vs verbose full table", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-open-"));
  const projDir = path.join(tmpDir, "proj");
  const mediaDir = path.join(tmpDir, "media");

  try {
    const files: string[] = [];
    for (let i = 1; i <= 17; i++) {
      const p = path.join(mediaDir, `sfx_${String(i).padStart(2, "0")}.wav`);
      makeUniqueSignatureWav(p, 0.25, 48000, i);
      files.push(p);
    }

    const mcp = new CutholMcpServer();
    await mcp.callTool("workspace", { action: "init", dir: projDir, aspect: "9:16", fps: 30 });
    await mcp.callTool("library", { action: "ingest", files });

    // Default workspace.open returns a short summary (counts + first 3 items) instead of a 17-row table
    const openCompact = await mcp.callTool("workspace", { action: "open", dir: projDir });
    assert.equal(openCompact.isError, false);
    const compactText = mcpText(openCompact);
    const compactLines = compactText.trim().split(/\r?\n/);
    assert.ok(
      compactLines.length <= 8,
      `Expected compact workspace.open output <= 8 lines, got ${compactLines.length}:\n${compactText}`
    );
    assert.match(compactText, /Library \(17 items\)/);
    assert.match(compactText, /\+14 more/);

    // Optional verbose=true returns the full overview table including all 17 handles
    const openVerbose = await mcp.callTool("workspace", {
      action: "open",
      dir: projDir,
      verbose: true,
    });
    assert.equal(openVerbose.isError, false);
    const verboseText = mcpText(openVerbose);
    assert.match(verboseText, /aud_17/);
    assert.ok(verboseText.split(/\r?\n/).length > 20);
  } finally {
    safeRm(tmpDir);
  }
});
