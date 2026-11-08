// The sequence render: overlays, segments, encode, post-render checks (split out of renderer.ts).
import fs from "node:fs";
import path from "node:path";
import {
  computeRenderDurationMs,
  computeSequenceDurationMs,
} from "../core/timeline.js";
import {
  compileSequenceRenderPlan,
  RenderPreset,
} from "../compositor/compiler.js";
import {
  beginOverlayCollect,
  beginOverlayRenderTracking,
  finishOverlayRenderTracking,
  RenderOverlaySummary,
  runCollectedOverlays,
} from "../compositor/hyperframes_bridge.js";
import { resolveDraftOverlayRes, setDraftNativeOverlayCapture } from "../compositor/hf_render.js";
import {
  type RenderEncoderFallback,
  resolveVideoEncoderForRender,
  type VideoEncoderCodec,
} from "./encoder.js";
import {
  CutholError,
  DIAGNOSTICS,
} from "../core/diagnostics.js";
import {
  resolveHyperFramesWorkers,
  resolveMaxClipsPerRenderSegment,
  resolveOverlayConcurrency,
} from "../core/env.js";
import { progressBegin, progressStop } from "../core/progress.js";
import { CutholSequence } from "../core/schema.js";
import { loadSequence, WorkspacePaths } from "../core/workspace.js";
import { ffmpegVersionWarningDiagnostics } from "../core/ffmpeg_version.js";
import { verifySequence, VerificationReport } from "../verify/gates.js";
import { PostRenderAudioHealthResult, scanRenderedMp4AudioHealth } from "./render_audio_health.js";
import { PostRenderBlankScanResult, scanRenderedMp4ForBlankFrames, scanRenderedMp4ForEdgeStrips } from "./render_scan.js";
import { computeRenderTimeSegments } from "./render_segments.js";
import {
  PreparedSequenceRender,
  RenderEncodeStageResult,
  renderMultiSegmentPath,
  renderSingleSegmentPath,
} from "./render_encode.js";

export interface RenderStageTimingsMs {
  verify_ms: number;
  compile_and_overlays_ms: number;
  encode_ms: number;
  blank_scan_ms: number;
  edge_strip_scan_ms?: number;
  audio_health_ms?: number;
  total_ms: number;
}

export interface RenderOutputSummary {
  ok: boolean;
  output_path: string;
  preset: RenderPreset;
  width: number;
  height: number;
  fps: number;
  duration_ms: number;
  size_bytes: number;
  encoder: VideoEncoderCodec;
  encoder_fallback: RenderEncoderFallback | null;
  workers: number;
  single_stage: boolean;
  overlays?: RenderOverlaySummary;
  timings_ms: RenderStageTimingsMs;
  verification: VerificationReport;
  blank_scan?: PostRenderBlankScanResult;
  audio_health?: PostRenderAudioHealthResult;
}

export function countActiveUniqueCompositions(seq: CutholSequence, rootDir: string): number {
  const dirs = new Set<string>();
  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (cue.kind === "composition" && cue.composition?.composition_dir) {
        const abs = path.isAbsolute(cue.composition.composition_dir)
          ? path.resolve(cue.composition.composition_dir)
          : path.resolve(rootDir, cue.composition.composition_dir);
        dirs.add(abs);
      }
    }
  }
  return dirs.size;
}

function prepareSequenceRender(options: {
  workspaceDir: string;
  outputPath?: string;
  preset?: RenderPreset;
  workers?: number;
  encoder?: string;
  overlayRes?: string;
}): PreparedSequenceRender {
  const tTotal0 = Date.now();
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const tVerify0 = Date.now();
  const verification = verifySequence(sequence, paths);
  const verifyMs = Date.now() - tVerify0;
  if (!verification.ok) {
    const firstErr = verification.diagnostics.find((d) => d.severity === "ERROR")!;
    throw new CutholError(firstErr);
  }
  // Render start repeats the ffmpeg/ffprobe version warning when verify did
  // not already carry it (same short WARN, never duplicated).
  for (const diag of ffmpegVersionWarningDiagnostics()) {
    if (!verification.diagnostics.some((d) => d.code === diag.code && d.what === diag.what)) {
      verification.diagnostics.push(diag);
      verification.warning_count += 1;
    }
  }
  const g205Diag = verification.diagnostics.find((d) => d.code === "CUTHOL-G205");
  if (g205Diag) {
    throw new CutholError({ ...g205Diag, severity: "ERROR" });
  }
  // An empty sequence would only produce a short clip of backdrop colour; refuse instead of writing it.
  if (computeSequenceDurationMs(sequence) <= 0) {
    throw new CutholError(DIAGNOSTICS.EMPTY_SEQUENCE("ERROR"));
  }

  const preset: RenderPreset = options.preset ?? "master_1080p";
  const workers = resolveHyperFramesWorkers(options.workers);
  const encDecision = resolveVideoEncoderForRender(options.encoder);
  const activeEncoder: VideoEncoderCodec = encDecision.encoder;
  const encoderFallback: RenderEncoderFallback | null = encDecision.fallback;

  const defaultOut = path.join(paths.rootDir, "output", `render_r${sequence.meta.revision}_${preset}.mp4`);
  const resolvedOut = options.outputPath
    ? path.isAbsolute(options.outputPath)
      ? options.outputPath
      : path.resolve(paths.rootDir, options.outputPath)
    : defaultOut;

  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.mkdirSync(paths.blobsDir, { recursive: true });
  const tmpOut = `${resolvedOut}.${process.pid}.${Date.now()}.tmp.mp4`;

  const totalDurationMs = computeRenderDurationMs(sequence);
  const maxItemsPerSegment = resolveMaxClipsPerRenderSegment();
  const segments = computeRenderTimeSegments(sequence, totalDurationMs, maxItemsPerSegment);

  const uniqueCompCount = countActiveUniqueCompositions(sequence, paths.rootDir);
  const overlayConcurrency = resolveOverlayConcurrency({
    workersPerOverlay: workers,
    coldOverlayCount: uniqueCompCount > 0 ? uniqueCompCount : 1,
  });
  const nativeCapture =
    preset === "draft_480p" && resolveDraftOverlayRes(options.overlayRes) === "native";
  setDraftNativeOverlayCapture(nativeCapture);
  beginOverlayRenderTracking({
    concurrency: overlayConcurrency,
    workers,
    nativeCaptureForMasterReuse: nativeCapture,
  });
  if (uniqueCompCount > 0) progressBegin("overlay", uniqueCompCount);

  let overlayPrepassMs = 0;
  if (uniqueCompCount >= 2 && overlayConcurrency > 1) {
    const tPrepass0 = Date.now();
    beginOverlayCollect();
    compileSequenceRenderPlan(sequence, paths, preset, { includeAudio: false, workers });
    runCollectedOverlays({ workers });
    overlayPrepassMs = Date.now() - tPrepass0;
  }

  return {
    tTotal0,
    paths,
    sequence,
    verification,
    verifyMs,
    preset,
    workers,
    activeEncoder,
    encoderFallback,
    resolvedOut,
    tmpOut,
    totalDurationMs,
    maxItemsPerSegment,
    segments,
    overlayPrepassMs,
  };
}

function runPostRenderChecks(params: {
  resolvedOut: string;
  sequence: CutholSequence;
  paths: WorkspacePaths;
  totalDurationMs: number;
  maxItemsPerSegment: number;
  verification: VerificationReport;
}): {
  blankScan: PostRenderBlankScanResult;
  blankScanMs: number;
  edgeStripScanMs: number;
  audioHealth: PostRenderAudioHealthResult;
  audioHealthMs: number;
} {
  const {
    resolvedOut,
    sequence,
    paths,
    totalDurationMs,
    maxItemsPerSegment,
    verification,
  } = params;

  const tScan0 = Date.now();
  const blankScan = scanRenderedMp4ForBlankFrames(resolvedOut, sequence);
  const blankScanMs = Date.now() - tScan0;
  for (const diag of blankScan.diagnostics) {
    verification.diagnostics.push(diag);
    verification.warning_count += 1;
  }
  const tEdge0 = Date.now();
  const edgeStrip = scanRenderedMp4ForEdgeStrips(resolvedOut, totalDurationMs);
  const edgeStripScanMs = Date.now() - tEdge0;
  if (edgeStrip) {
    verification.diagnostics.push(edgeStrip);
    verification.warning_count += 1;
  }
  const tAudioHealth0 = Date.now();
  const audioHealth = scanRenderedMp4AudioHealth(resolvedOut, sequence, paths, {
    maxItemsPerSegment,
  });
  const audioHealthMs = Date.now() - tAudioHealth0;
  for (const diag of audioHealth.diagnostics) {
    verification.diagnostics.push(diag);
    verification.warning_count += 1;
  }

  return {
    blankScan,
    blankScanMs,
    edgeStripScanMs,
    audioHealth,
    audioHealthMs,
  };
}

function buildRenderOutputSummary(params: {
  prep: PreparedSequenceRender;
  encodeResult: RenderEncodeStageResult;
  sizeBytes: number;
  blankScan: PostRenderBlankScanResult;
  blankScanMs: number;
  edgeStripScanMs: number;
  audioHealth: PostRenderAudioHealthResult;
  audioHealthMs: number;
}): RenderOutputSummary {
  const {
    prep,
    encodeResult,
    sizeBytes,
    blankScan,
    blankScanMs,
    edgeStripScanMs,
    audioHealth,
    audioHealthMs,
  } = params;
  const overlaySummary = finishOverlayRenderTracking();
  const totalMs = Date.now() - prep.tTotal0;

  return {
    ok: true,
    output_path: prep.resolvedOut,
    preset: prep.preset,
    width: encodeResult.renderWidth,
    height: encodeResult.renderHeight,
    fps: encodeResult.fps,
    duration_ms: prep.totalDurationMs,
    size_bytes: sizeBytes,
    encoder: encodeResult.activeEncoder,
    encoder_fallback: encodeResult.encoderFallback,
    workers: prep.workers,
    single_stage: encodeResult.singleStageUsed,
    overlays: overlaySummary,
    timings_ms: {
      verify_ms: prep.verifyMs,
      compile_and_overlays_ms: encodeResult.compileAndOverlaysMs,
      encode_ms: encodeResult.encodeMs,
      blank_scan_ms: blankScanMs,
      edge_strip_scan_ms: edgeStripScanMs,
      audio_health_ms: audioHealthMs,
      total_ms: totalMs,
    },
    verification: prep.verification,
    blank_scan: blankScan,
    audio_health: audioHealth,
  };
}

export function renderSequenceToMp4(options: {
  workspaceDir: string;
  outputPath?: string;
  preset?: RenderPreset;
  workers?: number;
  encoder?: string;
  overlayRes?: string;
}): RenderOutputSummary {
  try {
    const prep = prepareSequenceRender(options);

    const encodeResult =
      prep.segments.length <= 1
        ? renderSingleSegmentPath(prep)
        : renderMultiSegmentPath(prep);

    fs.renameSync(prep.tmpOut, prep.resolvedOut);
    const stat = fs.statSync(prep.resolvedOut);
    const {
      blankScan,
      blankScanMs,
      edgeStripScanMs,
      audioHealth,
      audioHealthMs,
    } = runPostRenderChecks({
      resolvedOut: prep.resolvedOut,
      sequence: prep.sequence,
      paths: prep.paths,
      totalDurationMs: prep.totalDurationMs,
      maxItemsPerSegment: prep.maxItemsPerSegment,
      verification: prep.verification,
    });

    return buildRenderOutputSummary({
      prep,
      encodeResult,
      sizeBytes: stat.size,
      blankScan,
      blankScanMs,
      edgeStripScanMs,
      audioHealth,
      audioHealthMs,
    });
  } finally {
    setDraftNativeOverlayCapture(false);
    progressStop();
  }
}
