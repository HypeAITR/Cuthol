/**
 * 4K/alpha presets and timeline interchange export.
 *
 * - master_2160p renders at 2x the stage dimensions; master_alpha keeps the
 *   stage size but compiles a transparent yuva420p pipeline.
 * - master_alpha encodes ProRes 4444 when this ffmpeg build provides
 *   prores_ks, else VP9 with alpha.
 * - Each export format carries spine clip in/out frames; compositions and
 *   captions are reported (never silently dropped).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { alphaOutputExtension, buildAlphaCodecArgs } from "../render/encoder_args.js";
import { exportTimeline } from "../export/timeline.js";
import { CutholSequence } from "../core/schema.js";

function bareSequence(): CutholSequence {
  return {
    schema_version: "1.0.0",
    meta: {
      project_id: "output-test",
      title: "Output Test",
      revision: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    stage: {
      width: 1920,
      height: 1080,
      aspect: "16:9",
      fps: 30,
      timebase: "ms",
      color_space: "bt709",
      backdrop: { kind: "solid", color: "#101010", blur_sigma: 0 },
    },
    library: [],
    spine: { magnetic: true, clips: [] },
    lanes: [],
    markers: [],
  } as unknown as CutholSequence;
}

const fakePaths = (rootDir: string): any => ({
  rootDir,
  blobsDir: path.join(rootDir, ".cuthol", "blobs"),
});

test("master_2160p is 2x the stage, master_alpha keeps stage size with alpha", () => {
  const seq = bareSequence();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-out-"));
  const noAudio = { includeAudio: false };
  const p2160 = compileSequenceRenderPlan(seq, fakePaths(dir), "master_2160p", noAudio);
  assert.equal(p2160.renderWidth, 3840);
  assert.equal(p2160.renderHeight, 2160);
  const p1080 = compileSequenceRenderPlan(seq, fakePaths(dir), "master_1080p", noAudio);
  assert.equal(p1080.renderWidth, 1920);
  assert.equal(p1080.renderHeight, 1080);
  const pAlpha = compileSequenceRenderPlan(seq, fakePaths(dir), "master_alpha", noAudio);
  assert.equal(pAlpha.renderWidth, 1920);
  assert.equal(pAlpha.renderHeight, 1080);
  assert.match(pAlpha.filterComplex, /yuva420p/);
  assert.doesNotMatch(p1080.filterComplex, /yuva420p/);
  assert.match(pAlpha.inputArgs.join(" "), /color=c=0x00000000/);
});

test("alpha codec choice keeps the alpha plane in both containers", () => {
  const prores = buildAlphaCodecArgs("prores_ks");
  assert.ok(prores.includes("prores_ks") && prores.includes("yuva444p10le"));
  assert.equal(alphaOutputExtension("prores_ks"), ".mov");
  const vp9 = buildAlphaCodecArgs("libvpx-vp9");
  assert.ok(vp9.includes("libvpx-vp9") && vp9.includes("yuva420p"));
  assert.equal(alphaOutputExtension("libvpx-vp9"), ".webm");
});

function exportSequence(): CutholSequence {
  const seq = bareSequence();
  seq.library = [
    { handle: "vid_01", uri: "media/talk.mp4" },
    { handle: "aud_01", uri: "media/music.mp3" },
    { handle: "aud_02", uri: "media/voice.mp3" },
  ] as unknown as CutholSequence["library"];
  const clips: CutholSequence["spine"]["clips"] = [];
  let at = 0;
  for (let i = 0; i < 6; i++) {
    const dur = 2000;
    clips.push({
      id: `sp_0${i + 1}`,
      asset_handle: "vid_01",
      source_in_ms: i * 1000,
      source_out_ms: i * 1000 + (i === 2 ? 3000 : dur),
      timeline_in_ms: at,
      duration_ms: dur,
      playback: { rate: i === 2 ? 1.5 : 1, preserve_pitch: true, speed_ramp: null },
      placement: { x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1, fit_mode: "cover", crop: null, mirror_x: false, mirror_y: false },
      audio_chain: { gain_db: 0, muted: false, fade_in_ms: 0, fade_out_ms: 0, denoise: { enabled: false, nr_db: 0, noise_floor_db: 0 }, voice_clarity: { enabled: false, highpass_hz: 0, presence_boost_db: 0, compressor_ratio: 0 }, loudness_target_lufs: null, true_peak_ceiling_dbtp: -1 },
      treatments: {},
      transition_out: i === 1 ? { kind: "dissolve", duration_ms: 500, easing: "linear" } : null,
      envelopes: [],
    } as unknown as CutholSequence["spine"]["clips"][number]);
    at += dur;
  }
  seq.spine.clips = clips;
  seq.lanes = [
    {
      id: "ln_broll",
      kind: "lane",
      z_index: 1,
      muted: false,
      cues: [
        {
          id: "cue_broll",
          kind: "broll",
          asset_handle: "vid_01",
          anchor: null,
          at_ms: 1000,
          duration_ms: 2000,
          placement: { x_pct: 0, y_pct: 0, scale_x: 0.5, scale_y: 0.5, rotation_deg: 0, opacity: 1, fit_mode: "cover", crop: null, mirror_x: false, mirror_y: false },
          envelopes: [],
        },
      ],
    },
    {
      id: "ln_music",
      kind: "lane",
      z_index: -1,
      muted: false,
      cues: [
        {
          id: "cue_music",
          kind: "music",
          asset_handle: "aud_01",
          anchor: null,
          at_ms: 0,
          duration_ms: 12000,
          placement: { x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1, fit_mode: "cover", crop: null, mirror_x: false, mirror_y: false },
          audio_chain: { gain_db: -6, muted: false, fade_in_ms: 0, fade_out_ms: 0, denoise: { enabled: false, nr_db: 0, noise_floor_db: 0 }, voice_clarity: { enabled: false, highpass_hz: 0, presence_boost_db: 0, compressor_ratio: 0 }, loudness_target_lufs: null, true_peak_ceiling_dbtp: -1 },
          envelopes: [],
        },
      ],
    },
    {
      id: "ln_vo",
      kind: "lane",
      z_index: -1,
      muted: false,
      cues: [
        {
          id: "cue_vo",
          kind: "voiceover",
          asset_handle: "aud_02",
          anchor: null,
          at_ms: 2000,
          duration_ms: 4000,
          placement: { x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1, fit_mode: "cover", crop: null, mirror_x: false, mirror_y: false },
          audio_chain: { gain_db: 2, muted: false, fade_in_ms: 0, fade_out_ms: 0, denoise: { enabled: false, nr_db: 0, noise_floor_db: 0 }, voice_clarity: { enabled: false, highpass_hz: 0, presence_boost_db: 0, compressor_ratio: 0 }, loudness_target_lufs: null, true_peak_ceiling_dbtp: -1 },
          envelopes: [],
        },
      ],
    },
    {
      id: "ln_comp",
      kind: "lane",
      z_index: 2,
      muted: false,
      cues: [
        {
          id: "cue_comp",
          kind: "composition",
          anchor: null,
          at_ms: 3000,
          duration_ms: 2000,
          composition: { composition_dir: "compositions/title" },
          placement: { x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1, fit_mode: "cover", crop: null, mirror_x: false, mirror_y: false },
          envelopes: [],
        },
      ],
    },
  ] as unknown as CutholSequence["lanes"];
  seq.markers = [
    { id: "mk_1", at_ms: 5000, label: "Chapter 2", category: "chapter" },
  ];
  return seq;
}

test("all four export formats carry clip in/out frames and report gaps", () => {
  const seq = exportSequence();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-export-"));
  for (const format of ["fcpxml", "xmeml", "edl", "otio"] as const) {
    const res = exportTimeline(seq, fakePaths(dir), format);
    assert.ok(res.content.length > 100, `${format} content`);
    // Frame-grid check: sp_03 runs timeline 4000..6000ms = frames 120..180 at 30fps,
    // with source 2000..5000ms = frames 60..150 and rate 1.5.
    if (format === "otio") {
      const doc: any = JSON.parse(res.content);
      const spineTrack = doc.tracks.children[0];
      assert.equal(spineTrack.children.length, 6);
      const third = spineTrack.children[2];
      assert.equal(third.source_range.start_time.value, 60);
      assert.equal(third.source_range.duration.value, 90);
      assert.equal(third.metadata.speed, 1.5);
    }
    if (format === "edl") {
      assert.match(res.content, /FROM CLIP NAME: sp_03/);
      assert.match(res.content, /00:00:02:00 00:00:05:00 00:00:04:00 00:00:06:00/);
    }
    if (format === "fcpxml") {
      assert.match(res.content, /<clip name="sp_03"/);
      assert.match(res.content, /Cross Dissolve/);
      assert.match(res.content, /<\?xml/);
    }
    if (format === "xmeml") {
      assert.match(res.content, /<xmeml version="5">/);
      assert.match(res.content, /crossdissolve/);
    }
    assert.ok(
      res.notExported.some((l) => l.startsWith("compositions:")),
      `${format} reports the composition gap`
    );
  }
});
