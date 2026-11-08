/**
 * Gate noise: unused VFR (G207), unapplied treatment fields (G409),
 * post-normalize true peak (G501), and the MCP external-change note.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createDefaultAudioChain,
  createDefaultPlacement,
  createDefaultTreatments,
  createEmptySequence,
  CutholSequence,
  LibraryItem,
  ParameterEnvelope,
  SpineClip,
  VisualTreatments,
} from "../core/schema.js";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { CutholMcpServer } from "../mcp/server.js";
import { normalizeSequenceAudio } from "../mix/audio_mix.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";
import { runWorkspaceVerification, verifySequence } from "../verify/gates.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace", "verify_gate_noise");

function ffmpeg(args: string[]): void {
  const out = args[args.length - 1];
  if (out && !out.startsWith("-")) fs.mkdirSync(path.dirname(out), { recursive: true });
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function footage(handle: string, over: Partial<LibraryItem["probe"]> = {}): LibraryItem {
  return {
    handle,
    kind: "footage",
    uri: `${handle}.mp4`,
    digest_sha256: handle.padEnd(64, "0"),
    probe: {
      duration_ms: 4000,
      width: 640,
      height: 360,
      fps: 30,
      has_video: true,
      has_audio: false,
      video_codec: "h264",
      audio_codec: null,
      sample_rate: null,
      channels: null,
      size_bytes: 1000,
      color_space: "bt709",
      color_range: "tv",
      pix_fmt: "yuv420p",
      is_vfr: false,
      r_frame_rate: "30/1",
      avg_frame_rate: "30/1",
      ...over,
    },
    analysis_refs: {},
  };
}

function spineClip(
  id: string,
  handle: string,
  treatments: VisualTreatments = createDefaultTreatments(),
  envelopes: ParameterEnvelope[] = []
): SpineClip {
  return {
    id,
    asset_handle: handle,
    source_in_ms: 0,
    source_out_ms: 1000,
    timeline_in_ms: 0,
    duration_ms: 1000,
    playback: { rate: 1, preserve_pitch: true, speed_ramp: null },
    placement: createDefaultPlacement(),
    audio_chain: createDefaultAudioChain(),
    treatments,
    transition_out: null,
    envelopes,
  };
}

function g207Count(seq: CutholSequence): number {
  return verifySequence(seq).diagnostics.filter((d) => d.code === "CUTHOL-G207").length;
}

test("1. G207 only for a spine clip or a cue on an unmuted lane", () => {
  const unused = createEmptySequence({ projectId: "g207", title: "g207", aspect: "16:9", fps: 30 });
  unused.library.push(footage("vid_vfr", { is_vfr: true, r_frame_rate: "60/1", avg_frame_rate: "30/1" }));
  unused.library.push(
    footage("vid_rates", { is_vfr: undefined, r_frame_rate: "60/1", avg_frame_rate: "30/1" })
  );
  unused.library.push(footage("vid_bt", { is_vfr: false, color_space: "bt2020" }));
  assert.equal(g207Count(unused), 0, "library-only VFR must not emit G207");
  assert.equal(
    verifySequence(unused).diagnostics.filter((d) => d.code === "CUTHOL-G208").length,
    1,
    "unused BT.2020 source still emits G208"
  );

  const muted = createEmptySequence({ projectId: "g207m", title: "g207m", aspect: "16:9", fps: 30 });
  muted.library.push(footage("vid_vfr", { is_vfr: true }));
  const mutedLane = muted.lanes.find((l) => l.id === "ln_broll");
  assert.ok(mutedLane);
  mutedLane.muted = true;
  mutedLane.cues.push({
    id: "cue_muted",
    kind: "broll",
    asset_handle: "vid_vfr",
    anchor: null,
    at_ms: 0,
    duration_ms: 1000,
    source_in_ms: 0,
    source_out_ms: 1000,
    placement: createDefaultPlacement(),
    envelopes: [],
  });
  assert.equal(g207Count(muted), 0, "VFR used only by a muted lane must not emit G207");

  const played = createEmptySequence({ projectId: "g207p", title: "g207p", aspect: "16:9", fps: 30 });
  played.library.push(footage("vid_vfr", { is_vfr: true }));
  played.library.push(footage("vid_cfr", { is_vfr: false }));
  const broll = played.lanes.find((l) => l.id === "ln_broll");
  assert.ok(broll);
  broll.cues.push({
    id: "cue_vfr",
    kind: "broll",
    asset_handle: "vid_vfr",
    anchor: null,
    at_ms: 0,
    duration_ms: 1000,
    source_in_ms: 0,
    source_out_ms: 1000,
    placement: createDefaultPlacement(),
    audio_chain: { ...createDefaultAudioChain(), muted: true },
    envelopes: [],
  });
  const onLane = verifySequence(played).diagnostics.filter((d) => d.code === "CUTHOL-G207");
  assert.equal(onLane.length, 1, "unmuted lane cue uses the VFR asset");
  assert.equal(onLane[0].severity, "INFO");
  assert.equal(onLane[0].subject_id, "vid_vfr");

  const onSpine = createEmptySequence({ projectId: "g207s", title: "g207s", aspect: "16:9", fps: 30 });
  onSpine.library.push(footage("vid_vfr", { is_vfr: true }));
  onSpine.library.push(footage("vid_cfr", { is_vfr: false }));
  onSpine.spine.clips.push(spineClip("sp_vfr", "vid_vfr"));
  onSpine.spine.clips.push({ ...spineClip("sp_cfr", "vid_cfr"), timeline_in_ms: 1000 });
  const spineHits = verifySequence(onSpine).diagnostics.filter((d) => d.code === "CUTHOL-G207");
  assert.equal(spineHits.length, 1);
  assert.equal(spineHits[0].subject_id, "vid_vfr");
  assert.match(spineHits[0].what, /VFR/);
});

test("1b. G207 workspace path ignores an ingested VFR file until a clip or unmuted cue uses it", () => {
  const ws = path.join(TEST_ROOT, "ws_vfr");
  fs.rmSync(ws, { recursive: true, force: true });
  initWorkspace({ dir: ws, title: "VFR gate", aspect: "16:9", fps: 30 });

  const seg15 = path.join(ws, "seg15.mp4");
  const seg60 = path.join(ws, "seg60.mp4");
  const vfrMp4 = path.join(ws, "vfr.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc=s=320x180:r=15:d=0.6", "-c:v", "libx264", "-pix_fmt", "yuv420p", seg15]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc=s=320x180:r=60:d=0.6", "-c:v", "libx264", "-pix_fmt", "yuv420p", seg60]);
  ffmpeg([
    "-i", seg15, "-i", seg60,
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map", "[v]", "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    vfrMp4,
  ]);

  const vfr = ingestAssetsIntoWorkspace({ workspaceDir: ws, filePaths: [vfrMp4] })[0];
  assert.equal(vfr.probe.is_vfr, true, "fixture must actually be VFR");
  const unused = runWorkspaceVerification(ws).diagnostics.filter((d) => d.code === "CUTHOL-G207");
  assert.equal(unused.length, 0, "ingested but unused VFR must not emit G207");

  addLaneCue({
    workspaceDir: ws,
    laneId: "ln_broll",
    kind: "broll",
    explicitId: "cue_vfr",
    assetHandle: vfr.handle,
    atMs: 0,
    durationMs: 500,
    sourceInMs: 0,
    sourceOutMs: 500,
  });
  commitSequenceMutation(ws, "mute broll", (seq) => {
    const lane = seq.lanes.find((l) => l.id === "ln_broll");
    if (!lane) throw new Error("ln_broll missing");
    lane.muted = true;
  });
  assert.equal(
    runWorkspaceVerification(ws).diagnostics.filter((d) => d.code === "CUTHOL-G207").length,
    0,
    "muted lane must not keep G207"
  );

  commitSequenceMutation(ws, "unmute broll", (seq) => {
    const lane = seq.lanes.find((l) => l.id === "ln_broll");
    if (!lane) throw new Error("ln_broll missing");
    lane.muted = false;
  });
  const onLane = runWorkspaceVerification(ws).diagnostics.filter((d) => d.code === "CUTHOL-G207");
  assert.equal(onLane.length, 1);
  assert.equal(onLane[0].subject_id, vfr.handle);

  commitSequenceMutation(ws, "mute broll again", (seq) => {
    const lane = seq.lanes.find((l) => l.id === "ln_broll");
    if (!lane) throw new Error("ln_broll missing");
    lane.muted = true;
  });
  appendSpineClip({
    workspaceDir: ws,
    assetHandle: vfr.handle,
    sourceInMs: 0,
    sourceOutMs: Math.min(500, vfr.probe.duration_ms),
  });
  const onSpine = runWorkspaceVerification(ws).diagnostics.filter((d) => d.code === "CUTHOL-G207");
  assert.equal(onSpine.length, 1, "spine clip still emits G207");
  assert.equal(onSpine[0].severity, "INFO");
  assert.match(onSpine[0].what, /VFR/);
});

function g409(seq: CutholSequence, id: string, field: string): void {
  const hit = verifySequence(seq).diagnostics.find(
    (d) => d.code === "CUTHOL-G409" && d.subject_id === id && d.what.includes(`'${field}'`)
  );
  assert.ok(hit, `expected G409 for ${id} ${field}, got ${JSON.stringify(verifySequence(seq).diagnostics.filter((d) => d.code === "CUTHOL-G409"))}`);
  assert.equal(hit.severity, "WARN");
  assert.match(hit.what, /is not applied to the render in this version/);
}

test("2. G409 warns when a stored treatment or lane-cue color envelope is not applied", () => {
  const defaults = createDefaultTreatments();
  const dirty = createEmptySequence({ projectId: "g409", title: "g409", aspect: "16:9", fps: 30 });
  dirty.library.push(footage("vid_01"));
  dirty.spine.clips.push(
    spineClip(
      "sp_dirty",
      "vid_01",
      {
        ...defaults,
        motion_blur: { enabled: true, shutter_deg: 90, subframes: 8 },
        mask: {
          shape: "ellipse",
          center_x_pct: 0,
          center_y_pct: 0,
          width_pct: 40,
          height_pct: 40,
          feather_px: 2,
          invert: false,
        },
        color_grade: { ...defaults.color_grade, temperature_k: 4500, lut_uri: "looks/warm.cube" },
      },
      [
        {
          parameter: "treatments.color_grade.brightness",
          points: [
            { offset_ms: 0, value: 0, easing: "linear" },
            { offset_ms: 1000, value: 0.2, easing: "ease_in_out" },
          ],
        },
        {
          parameter: "treatments.color_grade.contrast",
          points: [{ offset_ms: 0, value: 1.2, easing: "linear" }],
        },
        {
          parameter: "treatments.color_grade.saturation",
          points: [{ offset_ms: 0, value: 0.8, easing: "linear" }],
        },
      ]
    )
  );
  for (const field of ["treatments.motion_blur", "treatments.mask"]) {
    g409(dirty, "sp_dirty", field);
  }
  // temperature, LUT and colour envelopes are compiled on spine clips now, so G409 must not name them
  // (a missing LUT file is G414, covered in color_grade.test.ts).
  const dirtyG409 = verifySequence(dirty).diagnostics.filter(
    (d) => d.code === "CUTHOL-G409" && d.subject_id === "sp_dirty"
  );
  for (const field of [
    "treatments.color_grade.temperature_k",
    "treatments.color_grade.lut_uri",
    "treatments.color_grade.brightness",
    "treatments.color_grade.contrast",
    "treatments.color_grade.saturation",
  ]) {
    assert.equal(
      dirtyG409.some((d) => d.what.includes(`'${field}'`)),
      false,
      `${field} is compiled on spine clips and must not raise G409`
    );
  }
  assert.equal(dirtyG409.length, 2, "only motion_blur and mask remain unapplied on the spine clip");

  const plain = createEmptySequence({ projectId: "g409d", title: "g409d", aspect: "16:9", fps: 30 });
  plain.library.push(footage("vid_01"));
  plain.spine.clips.push(spineClip("sp_plain", "vid_01"));
  assert.equal(
    verifySequence(plain).diagnostics.some((d) => d.code === "CUTHOL-G409"),
    false,
    "defaults and no color envelope must not warn"
  );

  const graded = createEmptySequence({ projectId: "g409g", title: "g409g", aspect: "16:9", fps: 30 });
  graded.library.push(footage("vid_01"));
  const treatments = createDefaultTreatments();
  treatments.color_grade.brightness = 0.05;
  treatments.color_grade.contrast = 1.15;
  treatments.color_grade.saturation = 0.8;
  graded.spine.clips.push(spineClip("sp_eq", "vid_01", treatments));
  assert.equal(
    verifySequence(graded).diagnostics.some((d) => d.code === "CUTHOL-G409"),
    false,
    "constant brightness, contrast and saturation are compiled"
  );

  const cueSeq = createEmptySequence({ projectId: "g409c", title: "g409c", aspect: "16:9", fps: 30 });
  cueSeq.library.push(footage("vid_01"));
  cueSeq.spine.clips.push(spineClip("sp_plain", "vid_01"));
  const lane = cueSeq.lanes.find((l) => l.id === "ln_broll");
  assert.ok(lane);
  lane.cues.push({
    id: "cue_grade",
    kind: "broll",
    asset_handle: "vid_01",
    anchor: null,
    at_ms: 0,
    duration_ms: 1000,
    placement: createDefaultPlacement(),
    envelopes: [
      {
        parameter: "treatments.color_grade.saturation",
        points: [
          { offset_ms: 0, value: 1, easing: "linear" },
          { offset_ms: 1000, value: 1.5, easing: "linear" },
        ],
      },
    ],
  });
  g409(cueSeq, "cue_grade", "treatments.color_grade.saturation");
  assert.equal(
    verifySequence(cueSeq).diagnostics.filter((d) => d.code === "CUTHOL-G409" && d.subject_id === "sp_plain").length,
    0
  );
});

test("3. speech with silence, mix normalize -14: G501 versus rendered true peak", () => {
  const ws = path.join(TEST_ROOT, "ws_g501");
  fs.rmSync(ws, { recursive: true, force: true });
  initWorkspace({ dir: ws, title: "G501 measure", aspect: "16:9", fps: 30 });
  const media = path.join(ws, "speech_gaps.mp4");
  const expr =
    "aevalsrc='if(between(t,0.35,1.05)+between(t,2.1,2.8)+between(t,3.9,4.5),0.18*sin(2*PI*190*t)+0.05*sin(2*PI*470*t),0)':s=48000:d=5";
  ffmpeg([
    "-f", "lavfi", "-i", "color=c=#1E293B:s=640x360:r=30:d=5",
    "-f", "lavfi", "-i", expr,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    media,
  ]);
  ingestAssetsIntoWorkspace({ workspaceDir: ws, filePaths: [media] });
  appendSpineClip({ workspaceDir: ws, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 5000 });
  const norm = normalizeSequenceAudio({ workspaceDir: ws, targetLufs: -14, truePeakDbtp: -1 });
  const seq = loadSequence(ws).sequence;
  const clip = seq.spine.clips[0];
  const verify = runWorkspaceVerification(ws);
  const g501 = verify.diagnostics.filter((d) => d.code === "CUTHOL-G501");

  const outMp4 = path.join(ws, "output", "g501.mp4");
  const rendered = renderSequenceToMp4({ workspaceDir: ws, outputPath: outMp4, preset: "draft_480p" });
  assert.equal(rendered.ok, true, JSON.stringify(rendered.verification.diagnostics.slice(0, 3)));
  const ebur = spawnSync(
    "ffmpeg",
    ["-nostats", "-v", "info", "-i", outMp4, "-af", "ebur128=peak=true", "-f", "null", "-"],
    { encoding: "utf8" }
  );
  const stderr = ebur.stderr || "";
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const renderedLufs = Number(/I:\s*([-\d.]+)\s*LUFS/i.exec(summary)?.[1]);
  const renderedPeak = Number(/Peak:\s*([-\d.]+)\s*dBFS/i.exec(summary)?.[1]);
  const measurement = {
    g501: g501.length,
    g501_what: g501.map((d) => d.what),
    gain_db: clip.audio_chain.gain_db,
    item_ceiling: clip.audio_chain.true_peak_ceiling_dbtp,
    master: seq.stage.master_audio ?? null,
    norm_peak: norm.achieved_true_peak_dbtp,
    norm_lufs: norm.achieved_lufs,
    master_gain_db: norm.master_gain_db,
    rendered_lufs: renderedLufs,
    rendered_peak_dbtp: renderedPeak,
  };
  console.log(`G501_MEASUREMENT ${JSON.stringify(measurement)}`);
  assert.equal(ebur.status, 0, summary || stderr.slice(-500));
  assert.ok(Number.isFinite(renderedPeak), `ebur128 peak missing: ${summary}`);
  if (renderedPeak <= -1) {
    assert.equal(
      g501.length,
      0,
      `rendered true peak ${renderedPeak} dBTP is within -1 but G501 fired`
    );
  }
});

function mcpText(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

function writeMeta(ws: string, patch: (meta: Record<string, unknown>) => void): { revision: number } {
  const seqPath = path.join(ws, "cuthol.sequence.json");
  const seq = JSON.parse(fs.readFileSync(seqPath, "utf8")) as { meta: Record<string, unknown> };
  patch(seq.meta);
  fs.writeFileSync(seqPath, JSON.stringify(seq));
  return { revision: seq.meta.revision as number };
}

test("4. MCP note names a recreated project and keeps the forward external note", async () => {
  const ws = path.join(TEST_ROOT, "ws_mcp");
  fs.rmSync(ws, { recursive: true, force: true });
  const clip = path.join(TEST_ROOT, "media", "clip.mp4");
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2",
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    clip,
  ]);

  const mcp = new CutholMcpServer();
  assert.equal((await mcp.callTool("workspace", { action: "init", dir: ws, aspect: "16:9", fps: 30 })).isError, false);
  assert.equal((await mcp.callTool("library", { action: "ingest", files: [clip] })).isError, false);
  const knownForward = loadSequence(ws).sequence.meta.revision;
  appendSpineClip({ workspaceDir: ws, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 1000 });
  const diskForward = loadSequence(ws).sequence.meta.revision;
  assert.ok(diskForward > knownForward);
  const forward = await mcp.callTool("brief", { lens: "overview" });
  const forwardText = mcpText(forward);
  assert.ok(
    forwardText.startsWith(
      `NOTE the project changed outside this session (r${knownForward} -> r${diskForward}); re-read it with brief before relying on earlier results.`
    ),
    forwardText.slice(0, 240)
  );
  assert.equal(forwardText.includes("project was recreated"), false);

  const knownId = loadSequence(ws).sequence.meta.revision;
  const bumped = writeMeta(ws, (meta) => {
    meta.revision = knownId + 3;
    meta.project_id = `${meta.project_id}_rebuilt`;
  });
  const identity = await mcp.callTool("brief", { lens: "overview" });
  const identityText = mcpText(identity);
  assert.ok(
    identityText.startsWith(
      `project was recreated (r${knownId} -> r${bumped.revision}); earlier results do not belong to this project`
    ),
    identityText.slice(0, 240)
  );
  assert.equal(identityText.includes("changed outside this session"), false);

  const beforeRecreate = loadSequence(ws).sequence.meta;
  fs.rmSync(path.join(ws, ".cuthol"), { recursive: true, force: true });
  initWorkspace({ dir: ws, title: "rebuilt", aspect: "16:9", fps: 30 });
  const recreated = loadSequence(ws).sequence.meta;
  assert.ok(recreated.revision < beforeRecreate.revision);
  assert.notEqual(recreated.created_at, beforeRecreate.created_at);
  const again = await mcp.callTool("brief", { lens: "overview" });
  const againText = mcpText(again);
  assert.ok(
    againText.includes(
      `project was recreated (r${beforeRecreate.revision} -> r${recreated.revision}); earlier results do not belong to this project`
    ),
    againText.slice(0, 300)
  );
});
