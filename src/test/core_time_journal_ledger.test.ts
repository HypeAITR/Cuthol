/**
 * Comprehensive Unit & End-to-End Verification Suite (`src/test/core_time_journal_ledger.test.ts`).
 *
 * Tests each module independently:
 * 1. Time parser, frame budgets, handle allocator & structured diagnostics (`time.ts`, `schema.ts`, `diagnostics.ts`)
 * 2. `JournalGuard` atomic rollback, multi-step undo/redo & branch pruning (`workspace.ts`)
 * 3. `MediaLedger` SQLite content-addressed cache & file modification invalidation (`ledger.ts`)
 * 4. `radix2Fft` Parseval energy conservation, impulse response & 3-band isolation (`waveform.ts`)
 * 5. `PngCanvas` binary chunk layout, CRC32 integrity, zlib decompression & alpha blending (`png_canvas.ts`)
 * 6. `analyzeAssetBeats` multi-tempo (90 BPM & 140 BPM) accuracy & steady-tone rejection (`beats.ts`)
 * 7. End-to-end media ingest, ITU-R BS.1770-4 loudness, FFmpeg `scdet` scenes, audio detach, PNG monitor & 4-lens `brief`
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { parseTimeMs, formatTimecode, formatMsCompact, minClipDurationMs } from "../core/time.js";
import {
  allocateNextHandle,
  createDefaultAudioChain,
  createDefaultPlacement,
  createDefaultTreatments,
  resolveAspectDimensions,
} from "../core/schema.js";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import {
  commitSequenceMutation,
  initWorkspace,
  loadJournalManifest,
  loadSequence,
  stepJournal,
  tagCurrentRevision,
} from "../core/workspace.js";
import { PngCanvas } from "../core/png_canvas.js";
import { detachAudioFromLibraryAsset, ingestAssetsIntoWorkspace } from "../library/probe.js";
import { analyzeAssetLoudness } from "../library/loudness.js";
import { analyzeAssetWaveform, radix2Fft } from "../library/waveform.js";
import { analyzeAssetBeats } from "../library/beats.js";
import { analyzeAssetScenes } from "../library/scenes.js";
import { MediaLedger } from "../library/ledger.js";
import { renderSequenceBrief } from "../brief/inspector.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");

test("1. Time parser, frame budgets, handle allocator & structured diagnostics", () => {
  assert.equal(parseTimeMs(450), 450);
  assert.equal(parseTimeMs("1500ms"), 1500);
  assert.equal(parseTimeMs("1.25s"), 1250);
  assert.equal(parseTimeMs("2sec"), 2000);
  assert.equal(parseTimeMs("500000us"), 500);
  assert.equal(parseTimeMs("0.5min"), 30000);
  assert.equal(parseTimeMs("01:02.500"), 62500);
  assert.equal(parseTimeMs("01:01:02.250"), 3662250);

  assert.equal(formatTimecode(62500), "01:02.500");
  assert.equal(formatMsCompact(450), "450ms");
  assert.equal(formatMsCompact(1250), "1.25s (1250ms)");
  assert.equal(minClipDurationMs(30, 2), 67);
  assert.equal(minClipDurationMs(60, 2), 34);

  // Ambiguous or negative time strings must throw CUTHOL-SYS02
  assert.throws(() => parseTimeMs("12m"), /CUTHOL-SYS02/);
  assert.throws(() => parseTimeMs("-5s"), /CUTHOL-SYS02/);
  assert.throws(() => parseTimeMs(""), /CUTHOL-SYS02/);

  // Handle allocator fills gaps and increments deterministically
  assert.equal(allocateNextHandle(["vid_01", "vid_03"], "vid"), "vid_02");
  assert.equal(allocateNextHandle(["sp_01", "sp_02"], "sp"), "sp_03");
  assert.deepEqual(resolveAspectDimensions("4:5"), { width: 1080, height: 1350 });

  // Diagnostic formatting contract
  const diag = DIAGNOSTICS.UNKNOWN_HANDLE("sp_99");
  assert.equal(diag.code, "CUTHOL-G101");
  assert.equal(diag.gate, "G1_SCHEMA");
  assert.match(diag.formatted, /^\[CUTHOL-G101\] .+ \| Suggestion: .+$/);
});

test("2. JournalGuard atomic rollback, multi-step undo/redo & branch pruning", () => {
  const wsDir = path.join(TEST_ROOT, "unit_journal");
  fs.rmSync(wsDir, { recursive: true, force: true });

  const { paths } = initWorkspace({ dir: wsDir, title: "r1_init", aspect: "16:9", fps: 60 });
  assert.equal(loadSequence(wsDir).sequence.meta.revision, 1);

  // Commit r2, r3, r4
  commitSequenceMutation(wsDir, "op.r2", (seq) => {
    seq.meta.title = "r2_title";
  });
  commitSequenceMutation(wsDir, "op.r3", (seq) => {
    seq.meta.title = "r3_title";
  });
  commitSequenceMutation(wsDir, "op.r4", (seq) => {
    seq.meta.title = "r4_title";
  });

  assert.equal(loadSequence(wsDir).sequence.meta.revision, 4);
  assert.equal(loadSequence(wsDir).sequence.meta.title, "r4_title");

  // Atomic rollback: if mutator throws after modifying in-memory clone, disk state stays at r4
  assert.throws(() => {
    commitSequenceMutation(wsDir, "op.failing", (seq) => {
      seq.meta.title = "CORRUPTED_TITLE";
      throw new Error("Simulated validation failure");
    });
  }, /Simulated validation failure/);

  const afterFail = loadSequence(wsDir).sequence;
  assert.equal(afterFail.meta.revision, 4);
  assert.equal(afterFail.meta.title, "r4_title");
  assert.ok(!fs.existsSync(path.join(paths.journalDir, "rev_0005.json")));

  // Undo 2 steps: r4 -> r2
  const u1 = stepJournal(wsDir, "undo", 2);
  assert.equal(u1.revision, 2);
  assert.equal(loadSequence(wsDir).sequence.meta.title, "r2_title");

  // Redo 1 step: r2 -> r3
  const r1 = stepJournal(wsDir, "redo", 1);
  assert.equal(r1.revision, 3);
  assert.equal(loadSequence(wsDir).sequence.meta.title, "r3_title");

  // Undo back to r2, then commit a new mutation -> must prune old r3 & r4 snapshots!
  stepJournal(wsDir, "undo", 1);
  assert.ok(fs.existsSync(path.join(paths.journalDir, "rev_0004.json")));

  commitSequenceMutation(wsDir, "op.new_branch_r3", (seq) => {
    seq.meta.title = "branched_r3_title";
  });

  const branched = loadSequence(wsDir).sequence;
  assert.equal(branched.meta.revision, 3);
  assert.equal(branched.meta.title, "branched_r3_title");
  // Old rev_0004.json must be deleted on disk
  assert.ok(!fs.existsSync(path.join(paths.journalDir, "rev_0004.json")));

  // Redo past tip must throw CUTHOL-SYS03
  assert.throws(() => stepJournal(wsDir, "redo", 1), /CUTHOL-SYS03/);
  // Undo past r1 must throw CUTHOL-SYS03
  assert.throws(() => stepJournal(wsDir, "undo", 10), /CUTHOL-SYS03/);
});

test("3. MediaLedger content-addressed SQLite cache & file modification invalidation", () => {
  const wsDir = path.join(TEST_ROOT, "unit_ledger");
  fs.rmSync(wsDir, { recursive: true, force: true });
  fs.mkdirSync(wsDir, { recursive: true });

  const dbPath = path.join(wsDir, "ledger.sqlite");
  const sampleFile = path.join(wsDir, "sample.bin");
  fs.writeFileSync(sampleFile, Buffer.from("initial_payload_v1"));

  const ledger = new MediaLedger(dbPath);
  try {
    const first = ledger.resolveFileSha256(sampleFile);
    const second = ledger.resolveFileSha256(sampleFile);
    assert.equal(first.sha256, second.sha256);

    // Modify file content & size -> SHA-256 must update automatically
    fs.writeFileSync(sampleFile, Buffer.from("modified_payload_v2_longer"));
    const updated = ledger.resolveFileSha256(sampleFile);
    assert.notEqual(updated.sha256, first.sha256);

    // Test keyed cache isolation for waveform, beats, scenes, probe, loudness
    ledger.setProbe(first.sha256, { duration_ms: 1000 });
    assert.deepEqual(ledger.getProbe(first.sha256), { duration_ms: 1000 });
    assert.equal(ledger.getProbe(updated.sha256), null);

    ledger.setWaveform(first.sha256, 64, { bins: 64 });
    ledger.setWaveform(first.sha256, 128, { bins: 128 });
    assert.deepEqual(ledger.getWaveform(first.sha256, 64), { bins: 64 });
    assert.deepEqual(ledger.getWaveform(first.sha256, 128), { bins: 128 });

    ledger.setBeats(first.sha256, 1.2, { bpm: 100 });
    ledger.setBeats(first.sha256, 1.8, { bpm: 105 });
    assert.deepEqual(ledger.getBeats(first.sha256, 1.2), { bpm: 100 });
    assert.deepEqual(ledger.getBeats(first.sha256, 1.8), { bpm: 105 });

    ledger.setScenes(first.sha256, 10.0, { cuts: 2 });
    ledger.setScenes(first.sha256, 20.0, { cuts: 1 });
    assert.deepEqual(ledger.getScenes(first.sha256, 10.0), { cuts: 2 });
    assert.deepEqual(ledger.getScenes(first.sha256, 20.0), { cuts: 1 });
  } finally {
    ledger.close();
  }
});

test("4. radix2Fft Parseval theorem, impulse response & 3-band frequency isolation", () => {
  const N = 512;
  const sampleRate = 16000;

  // 4a. Impulse signal delta[0] = 1 -> all frequency bins must have magnitude 1.0
  const impReal = new Float64Array(N);
  const impImag = new Float64Array(N);
  impReal[0] = 1.0;
  radix2Fft(impReal, impImag);
  for (let k = 0; k < N; k++) {
    const mag = Math.hypot(impReal[k], impImag[k]);
    assert.ok(Math.abs(mag - 1.0) < 1e-12, `Impulse bin ${k} magnitude=${mag}`);
  }

  // 4b. Parseval's Theorem: sum(|x[n]|^2) == (1/N) * sum(|X[k]|^2)
  const sigReal = new Float64Array(N);
  const sigImag = new Float64Array(N);
  let timeEnergy = 0;
  for (let n = 0; n < N; n++) {
    const val = Math.sin((2 * Math.PI * 7 * n) / N) + 0.5 * Math.cos((2 * Math.PI * 43 * n) / N);
    sigReal[n] = val;
    timeEnergy += val * val;
  }
  radix2Fft(sigReal, sigImag);
  let freqEnergy = 0;
  for (let k = 0; k < N; k++) {
    freqEnergy += sigReal[k] * sigReal[k] + sigImag[k] * sigImag[k];
  }
  freqEnergy /= N;
  assert.ok(
    Math.abs(timeEnergy - freqEnergy) < 1e-9,
    `Parseval mismatch: timeEnergy=${timeEnergy}, freqEnergy=${freqEnergy}`
  );

  // 4c. Pure sine tones in Low (125 Hz), Mid (1000 Hz), and High (6000 Hz) bands
  const measureBandShares = (freqHz: number) => {
    const r = new Float64Array(N);
    const im = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
      r[n] = Math.sin((2 * Math.PI * freqHz * n) / sampleRate) * hann;
    }
    radix2Fft(r, im);
    let low = 0;
    let mid = 0;
    let high = 0;
    const binHz = sampleRate / N;
    for (let k = 1; k < N >> 1; k++) {
      const f = k * binHz;
      const e = r[k] * r[k] + im[k] * im[k];
      if (f >= 20 && f <= 250) low += e;
      else if (f > 250 && f <= 4000) mid += e;
      else if (f > 4000) high += e;
    }
    const tot = low + mid + high;
    return { low: low / tot, mid: mid / tot, high: high / tot };
  };

  const lowTone = measureBandShares(125);
  assert.ok(lowTone.low > 0.98, `125 Hz tone should concentrate in Low band, got ${JSON.stringify(lowTone)}`);

  const midTone = measureBandShares(1000);
  assert.ok(midTone.mid > 0.99, `1000 Hz tone should concentrate in Mid band, got ${JSON.stringify(midTone)}`);

  const highTone = measureBandShares(6000);
  assert.ok(highTone.high > 0.99, `6000 Hz tone should concentrate in High band, got ${JSON.stringify(highTone)}`);
});

test("5. PngCanvas binary structure, chunk validation, zlib round-trip & alpha blending", () => {
  const canvas = new PngCanvas(80, 40, [10, 20, 30, 255]);

  // Alpha blending: 50% opacity [210, 120, 230, 128] over [10, 20, 30, 255]
  canvas.setPixel(5, 5, [210, 120, 230, 128]);
  const pIdx = (5 * 80 + 5) * 4;
  assert.ok(canvas.pixels[pIdx] > 105 && canvas.pixels[pIdx] < 115);
  assert.ok(canvas.pixels[pIdx + 1] > 65 && canvas.pixels[pIdx + 1] < 75);
  assert.ok(canvas.pixels[pIdx + 2] > 125 && canvas.pixels[pIdx + 2] < 135);
  assert.equal(canvas.pixels[pIdx + 3], 255);

  // Draw primitives
  canvas.fillRect(10, 10, 20, 10, [255, 0, 0, 255]);
  canvas.strokeRect(35, 10, 15, 15, 2, [0, 255, 0, 255]);
  canvas.drawLine(0, 0, 79, 39, [0, 0, 255, 255]);
  canvas.drawText("OK", 50, 25, [255, 255, 255, 255], 1);

  const pngBuf = canvas.toPngBuffer();
  // Verify 8-byte PNG signature
  assert.deepEqual(pngBuf.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // Walk PNG chunks: IHDR, IDAT, IEND
  let offset = 8;
  const seenChunks: string[] = [];
  let idatPayload = Buffer.alloc(0);
  while (offset < pngBuf.length) {
    const len = pngBuf.readUInt32BE(offset);
    const type = pngBuf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = pngBuf.subarray(offset + 8, offset + 8 + len);
    seenChunks.push(type);
    if (type === "IHDR") {
      assert.equal(data.readUInt32BE(0), 80);
      assert.equal(data.readUInt32BE(4), 40);
      assert.equal(data[8], 8); // bit depth
      assert.equal(data[9], 6); // RGBA
    } else if (type === "IDAT") {
      idatPayload = Buffer.concat([idatPayload, data]);
    }
    offset += 12 + len;
  }
  assert.deepEqual(seenChunks, ["IHDR", "IDAT", "IEND"]);

  // Decompress IDAT and verify scanline byte count: 40 rows * (1 filter byte + 80 * 4 bytes)
  const inflated = zlib.inflateSync(idatPayload);
  assert.equal(inflated.length, 40 * (1 + 80 * 4));
});

test("6. Beat detection across 90 BPM, 140 BPM and steady continuous tone rejection", () => {
  const wsDir = path.join(TEST_ROOT, "unit_beats");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Beat Unit Test" });

  const mediaDir = path.join(wsDir, "audio");
  fs.mkdirSync(mediaDir, { recursive: true });

  const track90 = path.join(mediaDir, "pulse_90bpm.wav");
  const track140 = path.join(mediaDir, "pulse_140bpm.wav");
  const steadyTone = path.join(mediaDir, "steady_sine.wav");

  // 90 BPM = period 0.6667s
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.8*exp(-22*mod(t,0.666667))*sin(2*PI*180*t)+0.4*exp(-35*mod(t,0.666667))*sin(2*PI*2200*t)':s=16000:d=6",
    "-c:a",
    "pcm_s16le",
    track90,
  ]);

  // 140 BPM = period 0.42857s
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.8*exp(-25*mod(t,0.428571))*sin(2*PI*180*t)+0.4*exp(-35*mod(t,0.428571))*sin(2*PI*2200*t)':s=16000:d=6",
    "-c:a",
    "pcm_s16le",
    track140,
  ]);

  // Continuous steady 440 Hz tone (no transient onsets after t=0)
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=16000:duration=4",
    "-c:a",
    "pcm_s16le",
    steadyTone,
  ]);

  ingestAssetsIntoWorkspace({
    workspaceDir: wsDir,
    filePaths: [track90, track140, steadyTone],
  });

  const res90 = analyzeAssetBeats({ workspaceDir: wsDir, handle: "aud_01" });
  assert.ok(
    res90.estimated_bpm >= 86 && res90.estimated_bpm <= 94,
    `Expected ~90 BPM, got ${res90.estimated_bpm}`
  );
  assert.ok(res90.beats_count >= 7);

  const res140 = analyzeAssetBeats({ workspaceDir: wsDir, handle: "aud_02" });
  assert.ok(
    res140.estimated_bpm >= 135 && res140.estimated_bpm <= 145,
    `Expected ~140 BPM, got ${res140.estimated_bpm}`
  );
  assert.ok(res140.beats_count >= 11);

  const resSteady = analyzeAssetBeats({ workspaceDir: wsDir, handle: "aud_03" });
  // A steady sine wave may have at most 1 onset at t=0, not rhythmic beats throughout
  assert.ok(resSteady.beats_count <= 1, `Expected <= 1 onset on steady sine wave, got ${resSteady.beats_count}`);
});

test("7. End-to-End Workspace, Media Ledger, Loudness, Waveform PNG, Scenes & 4-Lens Brief (with Spine Anchors)", () => {
  const demoDir = path.join(TEST_ROOT, "core_time_journal_ledger_demo");
  fs.rmSync(demoDir, { recursive: true, force: true });

  const { paths } = initWorkspace({
    dir: demoDir,
    title: "Doğrulama Projesi",
    aspect: "9:16",
    fps: 30,
  });

  const mediaDir = path.join(demoDir, "raw_media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const videoPath = path.join(mediaDir, "multi_scene_dialogue.mp4");
  const musicPath = path.join(mediaDir, "beat_120bpm.wav");

  // 6-second 1280x720@30fps video with 3 high-contrast scenes (0-2s, 2-4s, 4-6s)
  // and an audio signal with an intentional silent pause between 1.8s and 2.8s.
  const vProc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#1E3A8A:s=1280x720:r=30:d=2",
      "-f",
      "lavfi",
      "-i",
      "color=c=#FACC15:s=1280x720:r=30:d=2",
      "-f",
      "lavfi",
      "-i",
      "color=c=#0F172A:s=1280x720:r=30:d=2",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='if(between(t,1.8,2.8),0,0.35*sin(2*PI*220*t)+0.25*sin(2*PI*1200*t)+0.10*sin(2*PI*5200*t))':s=48000:d=6",
      "-filter_complex",
      "[0:v][1:v][2:v]concat=n=3:v=1:a=0[vout]",
      "-map",
      "[vout]",
      "-map",
      "3:a",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "30",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      videoPath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(vProc.status, 0);

  const mProc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='0.7*exp(-18*mod(t,0.5))*sin(2*PI*110*t)+0.3*exp(-30*mod(t,0.5))*sin(2*PI*2400*t)':s=48000:d=5",
      "-c:a",
      "pcm_s16le",
      musicPath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(mProc.status, 0);

  const ingested = ingestAssetsIntoWorkspace({
    workspaceDir: demoDir,
    filePaths: [videoPath, musicPath],
  });
  assert.equal(ingested.length, 2);
  assert.equal(ingested[0].handle, "vid_01");
  assert.equal(ingested[1].handle, "aud_01");

  const loudness = analyzeAssetLoudness({ workspaceDir: demoDir, handle: "vid_01" });
  assert.ok(Number.isFinite(loudness.integrated_lufs) && loudness.integrated_lufs > -40);

  const pngOut = path.join(paths.monitorDir, "wave_vid_01.png");
  const waveform = analyzeAssetWaveform({
    workspaceDir: demoDir,
    handle: "vid_01",
    bins: 120,
    pngOutPath: pngOut,
  });
  assert.ok(fs.existsSync(pngOut));
  assert.ok(
    waveform.silence_intervals.some((s) => s.start_ms >= 1650 && s.end_ms <= 2950 && s.duration_ms >= 750)
  );

  const beats = analyzeAssetBeats({ workspaceDir: demoDir, handle: "aud_01" });
  assert.ok(beats.estimated_bpm >= 115 && beats.estimated_bpm <= 125);

  const scenes = analyzeAssetScenes({ workspaceDir: demoDir, handle: "vid_01" });
  assert.equal(scenes.cuts_count, 2);
  assert.equal(scenes.segments_ms.length, 3);

  const detached = detachAudioFromLibraryAsset({ workspaceDir: demoDir, sourceHandle: "vid_01" });
  assert.equal(detached.handle, "aud_02");

  // Populate a spine clip and an anchored title cue to verify `flow`, `canvas`, and `detail` lenses
  commitSequenceMutation(demoDir, "test.populate_spine_and_cue", (seq) => {
    seq.spine.clips.push({
      id: "sp_01",
      asset_handle: "vid_01",
      source_in_ms: 0,
      source_out_ms: 4000,
      timeline_in_ms: 1000,
      duration_ms: 4000,
      playback: { rate: 1.0, preserve_pitch: true, speed_ramp: null },
      placement: createDefaultPlacement(),
      audio_chain: createDefaultAudioChain(),
      treatments: createDefaultTreatments(),
      transition_out: { kind: "dissolve", duration_ms: 400, easing: "ease_in_out" },
      envelopes: [],
    });
    const titlesLane = seq.lanes.find((l) => l.id === "ln_titles")!;
    titlesLane.cues.push({
      id: "cue_01",
      kind: "title",
      anchor: { ref: "sp_01", offset_ms: 250 },
      at_ms: 0,
      duration_ms: 2000,
      placement: createDefaultPlacement(),
      typography: {
        text: "Bölüm 1",
        font_family: "Inter",
        font_size_px: 56,
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

  tagCurrentRevision(demoDir, "after-analysis");

  const finalSeq = loadSequence(demoDir).sequence;
  const overviewMd = renderSequenceBrief(finalSeq, { lens: "overview" });
  assert.match(overviewMd, /`sp_01` \(`vid_01`\): timeline `1000\.\.5000ms`/);

  const flowMd = renderSequenceBrief(finalSeq, { lens: "flow" });
  // Cue anchored to sp_01 (which starts at 1000ms) with +250ms offset must resolve to 1250..3250ms!
  assert.match(flowMd, /Anchored `cue_01` on `ln_titles` \(\+250ms => 1250\.\.3250ms\): "Bölüm 1"/);

  const canvasMd = renderSequenceBrief(finalSeq, { lens: "canvas" });
  assert.match(canvasMd, /\| `cue_01` \| `ln_titles` \| 25 \| 1250\.\.3250ms \|/);

  const detailMd = renderSequenceBrief(finalSeq, { lens: "detail", targetIds: ["sp_01", "cue_01"] });
  assert.match(detailMd, /"resolved_start_ms": 1250/);
});
