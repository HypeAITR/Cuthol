/**
 * (gate `ramp`): video speed ramp, CLI `--ramp`, MCP `ramp` parameter.
 *
 * Earlier, `playback.speed_ramp` was correct at the sequence layer but played video
 * at the average rate (`compile_spine_timing.ts`). This file proves the ramp also
 * applies to video, that duration/words/reflow stay intact, and that the
 * interfaces (`--ramp`, MCP) work.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import {
  buildSpineClipTimingFilters,
  computeSpineClipEffectiveRate,
} from "../compositor/compile_spine_timing.js";
import type { CutholSequence } from "../core/schema.js";
import { initWorkspace, loadSequence, stepJournal } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { buildCliArgv, findActionSpec } from "../mcp/catalog.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import {
  appendSpineClip,
  computeClipDurationMs,
  invertClipLocalMsToSourceOffset,
  setSpineSpeed,
} from "../sequence/spine.js";

type SpineClipSpec = CutholSequence["spine"]["clips"][number];

const CLI = path.resolve(process.cwd(), "dist/cli.js");

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runFfmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? ""}`.slice(0, 2000));
}

function cli(args: string[]): { ok: boolean; text: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  let ok = false;
  try {
    ok = Boolean(JSON.parse(proc.stdout ?? "").ok);
  } catch {
    ok = false;
  }
  return { ok, text: raw.slice(0, 6000) };
}

function fakeClip(over: Partial<SpineClipSpec>): SpineClipSpec {
  return {
    id: "sp_01",
    asset_handle: "vid_01",
    source_in_ms: 0,
    source_out_ms: 4000,
    timeline_in_ms: 0,
    duration_ms: 4000,
    playback: { rate: 1.0, preserve_pitch: true, speed_ramp: null },
    placement: {
      x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1,
      fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false,
    },
    audio_chain: {
      gain_db: 0, muted: false, fade_in_ms: 0, fade_out_ms: 0,
      denoise: { enabled: false, nr_db: 12, noise_floor_db: -50 },
      voice_clarity: { enabled: false, highpass_hz: 80, presence_boost_db: 0, compressor_ratio: 1 },
      loudness_target_lufs: null, true_peak_ceiling_dbtp: -1,
    },
    treatments: {
      cutout: { mode: "none", chroma_key_hex: null, similarity: 0.2, blend: 0.1, feather_px: 0 },
      mask: null,
      motion_blur: { enabled: false, shutter_deg: 180, subframes: 1 },
      reframe: { enabled: false, mode: "center_lock", focal_points: [] },
      color_grade: { brightness: 0, contrast: 1, saturation: 1, temperature_k: 6500, lut_uri: null },
    } as unknown as SpineClipSpec["treatments"],
    transition_out: null,
    envelopes: [],
    ...over,
  } as SpineClipSpec;
}

function fakeAsset(): CutholSequence["library"][number] {
  return {
    handle: "vid_01",
    kind: "footage",
    uri: "src.mp4",
    digest_sha256: "x",
    probe: {
      duration_ms: 20000, width: 320, height: 180, fps: 30,
      has_video: true, has_audio: false, video_codec: "h264", audio_codec: null,
      sample_rate: null, channels: null, size_bytes: 1,
    },
    analysis_refs: {},
  } as CutholSequence["library"][number];
}

function timingFilters(clip: SpineClipSpec): string[] {
  const asset = fakeAsset();
  return buildSpineClipTimingFilters({
    clip,
    asset,
    isStill: false,
    fps: 30,
    srcInSec: (clip.source_in_ms / 1000).toFixed(3),
    srcOutSec: (clip.source_out_ms / 1000).toFixed(3),
    effectiveRate: computeSpineClipEffectiveRate(clip),
  });
}

test("timing filters in an unramped clip are byte-identical to the pre-gate text", () => {
  for (const ramp of [null, [{ source_offset_ms: 0, rate: 2.0 }]] as Array<
    SpineClipSpec["playback"]["speed_ramp"]
  >) {
    const clip = fakeClip({ playback: { rate: 1.0, preserve_pitch: true, speed_ramp: ramp } });
    clip.duration_ms = 4000;
    const filters = timingFilters(clip);
    const eff = computeSpineClipEffectiveRate(clip);
    const expected = [
      "settb=AVTB",
      "trim=start=0.000:end=4.000",
      `setpts=(PTS-STARTPTS)/${eff.toFixed(4)}`,
      "fps=30:eof_action=pass",
      filters[5] ?? "",
    ];
    // The tpad term must match the formula exactly (3 source frames + 2 output frames).
    const tailPad = Math.max(0.1, Math.max(0, 4 - 4 / eff) + 3 / (30 * eff) + 2 / 30).toFixed(3);
    expected[4] = `tpad=stop_mode=clone:stop_duration=${tailPad}`;
    // no needsPreTrimEofPad (8s source, 0..4s clip): 5 filters.
    assert.deepEqual(filters.slice(0, 5), expected);
  }
});

test("ramped clip contains the logarithmic setpts integral", () => {
  const clip = fakeClip({
    playback: {
      rate: 1.0,
      preserve_pitch: true,
      speed_ramp: [
        { source_offset_ms: 0, rate: 1.0 },
        { source_offset_ms: 4000, rate: 2.0 },
      ],
    },
  });
  clip.duration_ms = computeClipDurationMs(clip);
  assert.equal(clip.duration_ms, Math.round(4000 * Math.log(2)));
  const filters = timingFilters(clip);
  const setpts = filters.find((f) => f.startsWith("setpts="));
  assert.ok(setpts, filters.join(" | "));
  assert.ok(setpts.includes("log("), setpts);
  assert.ok(setpts.includes("STARTT"), setpts);
  assert.ok(setpts.startsWith("setpts='(") && setpts.endsWith("/TB'"), setpts);
  assert.ok(filters.some((f) => f.startsWith("fps=30")), filters.join(" | "));
  assert.ok(filters.some((f) => f.startsWith("tpad=")), filters.join(" | "));
});

test("CLI --ramp writes, duration and next clip shift, undo reverts", () => {
  const tmp = makeTempRoot("cuthol-ramp-cli-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "ramp cli", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "src.mp4");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 4000, sourceOutMs: 6000 });

    const res = cli(["spine", "speed", "--clip", "sp_01", "--ramp", "0s:1,2s:4", "--dir", wsDir]);
    assert.equal(res.ok, true, res.text);

    let seq = loadSequence(wsDir).sequence;
    const sp1 = seq.spine.clips[0];
    const sp2 = seq.spine.clips[1];
    assert.deepEqual(sp1.playback.speed_ramp, [
      { source_offset_ms: 0, rate: 1 },
      { source_offset_ms: 2000, rate: 4 },
    ]);
    assert.equal(sp1.duration_ms, computeClipDurationMs(sp1));
    assert.ok(sp1.duration_ms < 4000, `expected shortening: ${sp1.duration_ms}`);
    assert.equal(sp2.timeline_in_ms, sp1.timeline_in_ms + sp1.duration_ms);
    const onDisk = JSON.parse(fs.readFileSync(path.join(wsDir, "cuthol.sequence.json"), "utf8"));
    assert.deepEqual(onDisk.spine.clips[0].playback.speed_ramp, [
      { source_offset_ms: 0, rate: 1 },
      { source_offset_ms: 2000, rate: 4 },
    ]);

    stepJournal(wsDir, "undo");
    seq = loadSequence(wsDir).sequence;
    assert.equal(seq.spine.clips[0].playback.speed_ramp, null);
    assert.equal(seq.spine.clips[0].duration_ms, 4000);
    assert.equal(seq.spine.clips[1].timeline_in_ms, 4000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI --ramp rejects invalid inputs with G116", () => {
  const tmp = makeTempRoot("cuthol-ramp-bad-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "ramp bad", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "src.mp4");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });

    const cases: Array<[string, string[]]> = [
      ["artmayan ofset", ["spine", "speed", "--clip", "sp_01", "--ramp", "1s:1,1s:2", "--dir", wsDir]],
      ["zero rate", ["spine", "speed", "--clip", "sp_01", "--ramp", "0s:0,2s:1", "--dir", wsDir]],
      ["rate above 16", ["spine", "speed", "--clip", "sp_01", "--ramp", "0s:1,2s:17", "--dir", wsDir]],
      ["offset out of range", ["spine", "speed", "--clip", "sp_01", "--ramp", "0s:1,9s:1", "--dir", wsDir]],
      ["single point", ["spine", "speed", "--clip", "sp_01", "--ramp", "0s:1", "--dir", wsDir]],
      ["rate+ramp", ["spine", "speed", "--clip", "sp_01", "--rate", "2", "--ramp", "0s:1,2s:2", "--dir", wsDir]],
    ];
    for (const [label, args] of cases) {
      const res = cli(args);
      assert.equal(res.ok, false, `${label}: ${res.text}`);
      assert.match(res.text, /CUTHOL-G116/, `${label}: ${res.text}`);
      assert.match(res.text, /--ramp/, `${label} suggestion line: ${res.text}`);
    }
    // Failed attempts must not change the array.
    const seq = loadSequence(wsDir).sequence;
    assert.equal(seq.spine.clips[0].playback.speed_ramp, null);
    assert.equal(seq.spine.clips[0].duration_ms, 4000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI --ramp none removes the ramp", () => {
  const tmp = makeTempRoot("cuthol-ramp-none-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "ramp none", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "src.mp4");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    setSpineSpeed({
      workspaceDir: wsDir,
      clipId: "sp_01",
      speedRamp: [
        { source_offset_ms: 0, rate: 1 },
        { source_offset_ms: 4000, rate: 2 },
      ],
    });
    let seq = loadSequence(wsDir).sequence;
    assert.ok(seq.spine.clips[0].playback.speed_ramp);

    const res = cli(["spine", "speed", "--clip", "sp_01", "--ramp", "none", "--dir", wsDir]);
    assert.equal(res.ok, true, res.text);
    seq = loadSequence(wsDir).sequence;
    assert.equal(seq.spine.clips[0].playback.speed_ramp, null);
    assert.equal(seq.spine.clips[0].duration_ms, 4000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("setSpineSpeed ramp validation yields G116", () => {
  const tmp = makeTempRoot("cuthol-ramp-fn-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "ramp fn", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "src.mp4");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });

    assert.throws(
      () =>
        setSpineSpeed({
          workspaceDir: wsDir,
          clipId: "sp_01",
          speedRamp: [{ source_offset_ms: 0, rate: 1 }],
        }),
      /CUTHOL-G116/
    );
    assert.throws(
      () =>
        setSpineSpeed({
          workspaceDir: wsDir,
          clipId: "sp_01",
          speedRamp: [
            { source_offset_ms: 2000, rate: 1 },
            { source_offset_ms: 1000, rate: 2 },
          ],
        }),
      /CUTHOL-G116/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("MCP speed ramp parameter converts to the CLI --ramp flag", () => {
  const spec = findActionSpec("spine", "speed");
  assert.ok(spec);
  const ramp = spec.params.find((p) => p.name === "ramp");
  assert.ok(ramp, spec.params.map((p) => p.name).join(","));
  const rate = spec.params.find((p) => p.name === "rate");
  assert.ok(rate);
  assert.ok(!rate.required, "rate is no longer required (ramp can be given alone)");
  const argv = buildCliArgv(spec, { clip: "sp_01", ramp: ["0s:1", "2s:4"] }, "/p");
  assert.ok(argv.includes("--ramp=0s:1,2s:4"), argv.join(" "));
  const argvNone = buildCliArgv(spec, { clip: "sp_01", ramp: ["none"] }, "/p");
  assert.ok(argvNone.includes("--ramp=none"), argvNone.join(" "));
});

function ffprobeStream(file: string, entries: string): string {
  const proc = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", `stream=${entries}`, "-of", "default=noprint_wrappers=1", file],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr ?? "");
  return proc.stdout ?? "";
}

function readYPlaneFrames(file: string, width: number, height: number): Buffer {
  // Read the Y plane from a yuv444p dump. The `-pix_fmt gray` conversion is not
  // used because its limited-range scaling ((Y-16)*255/219) clips small values to zero.
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "yuv444p", "-"],
    { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0, String(proc.stderr ?? "").slice(0, 1000));
  const buf = proc.stdout as Buffer;
  assert.ok(buf.length >= width * height * 3, `short raw video: ${buf.length}`);
  return buf;
}

function frameAverage(buf: Buffer, index: number, width: number, height: number): number {
  const ySize = width * height;
  const frameSize = ySize * 3;
  const off = index * frameSize;
  assert.ok(off + frameSize <= buf.length, `frame ${index} missing (${buf.length} bytes)`);
  let sum = 0;
  // Y-plane mean: the frame must be flat gray.
  for (let i = off; i < off + ySize; i += 7) sum += buf[i];
  const n = Math.ceil(ySize / 7);
  return sum / n;
}

test("ramped clip frames match the source frames (±1 frame)", { timeout: 300_000 }, () => {
  const tmp = makeTempRoot("cuthol-ramp-frame-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "ramp frame", aspect: "16:9", fps: 30 });
    // Lossless source carrying its frame number in brightness. Because the pipeline
    // clips to TV range (Y<16 → 16), values are kept in the 16..235 band.
    const media = path.join(tmp, "src.mp4");
    runFfmpeg([
      "-f", "lavfi", "-i", "nullsrc=s=320x180:r=30,geq=lum='16+mod(N,220)':cb=128:cr=128",
      "-t", "8", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p", media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    setSpineSpeed({
      workspaceDir: wsDir,
      clipId: "sp_01",
      speedRamp: [
        { source_offset_ms: 0, rate: 1.0 },
        { source_offset_ms: 4000, rate: 2.0 },
      ],
    });
    const { sequence, paths } = loadSequence(wsDir);
    const clip = sequence.spine.clips[0];
    assert.equal(clip.duration_ms, Math.round(4000 * Math.log(2)));

    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", { includeAudio: false });
    const outMp4 = path.join(tmp, "ramp.mp4");
    const proc = spawnSync(
      "ffmpeg",
      [
        "-y", "-v", "error",
        ...plan.inputArgs,
        "-filter_complex", plan.filterComplex,
        "-map", plan.videoOutPad,
        "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p",
        outMp4,
      ],
      { encoding: "utf8" }
    );
    assert.equal(proc.status, 0, `${proc.stderr ?? ""}`.slice(0, 3000));

    const info = ffprobeStream(outMp4, "width,height,nb_frames,duration");
    const width = Number(/width=(\d+)/.exec(info)?.[1]);
    const height = Number(/height=(\d+)/.exec(info)?.[1]);
    const nbFrames = Number(/nb_frames=(\d+)/.exec(info)?.[1]);
    assert.ok(width > 0 && height > 0, info);
    const expectedFrames = Math.round((clip.duration_ms / 1000) * 30);
    assert.ok(
      Math.abs(nbFrames - expectedFrames) <= 2,
      `frame count ${nbFrames}, expected ~${expectedFrames} (${info})`
    );

    const raw = readYPlaneFrames(outMp4, width, height);
    for (const localMs of [500, 1500, 2500]) {
      const frameIdx = Math.min(nbFrames - 1, Math.round((localMs / 1000) * 30));
      const measured = frameAverage(raw, frameIdx, width, height);
      const srcOffsetMs = invertClipLocalMsToSourceOffset(clip, (frameIdx / 30) * 1000);
      const expectedN = 16 + (Math.floor((srcOffsetMs / 1000) * 30) % 220);
      const diff = Math.abs(measured - expectedN);
      assert.ok(diff <= 1.5, `t=${localMs}ms frame=${frameIdx}: measured=${measured.toFixed(2)} expected=~${expectedN} (source offset ${srcOffsetMs.toFixed(1)}ms)`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ramped draft render duration and audio/video sync", { timeout: 300_000 }, () => {
  const tmp = makeTempRoot("cuthol-ramp-render-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "ramp render", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "src.mp4");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    setSpineSpeed({
      workspaceDir: wsDir,
      clipId: "sp_01",
      speedRamp: [
        { source_offset_ms: 0, rate: 1.0 },
        { source_offset_ms: 4000, rate: 2.0 },
      ],
    });
    const clip = loadSequence(wsDir).sequence.spine.clips[0];
    const outMp4 = path.join(tmp, "draft.mp4");
    const res = renderSequenceToMp4({ workspaceDir: wsDir, preset: "draft_480p", outputPath: outMp4 });
    assert.equal(res.ok, true);
    assert.ok(fs.existsSync(outMp4));

    const info = ffprobeStream(outMp4, "codec_type,nb_frames,duration");
    const durations = [...info.matchAll(/duration=([\d.]+)/g)].map((m) => Number(m[1]) * 1000);
    assert.ok(durations.length >= 1, info);
    for (const d of durations) {
      assert.ok(Math.abs(d - clip.duration_ms) < 300, `duration ${d}ms, clip ${clip.duration_ms}ms (${info})`);
    }
    if (durations.length >= 2) {
      assert.ok(Math.abs(durations[0] - durations[1]) < 300, `audio/video gap (${info})`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
