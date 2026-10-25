// Cached preview composite MP4 and frame prefetch for the monitor (split out of renderer.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type ParallelFfmpegJob, spawnWatchedSync
} from "../core/subprocess.js";
import {
  computeRenderDurationMs, resolveCueStartMs
} from "../core/timeline.js";
import { hashDirectoryRecursive, syncCompositionBridgeFiles } from "../compositor/bridge_exporter.js";
import {
  compileSequenceRenderPlan,
  RenderPreset
} from "../compositor/compiler.js";
import {
  beginOverlayCollect, isPngSequenceBlobDir,
  isValidVideoBlobOnDisk,
  renderHyperFramesBatchFramesPng, resolveFramePngInPngSequenceDir,
  runCollectedOverlays
} from "../compositor/hyperframes_bridge.js";
import {
  BT709_COLOR_OUTPUT_ARGS
} from "./encoder.js";
import {
  createSubprocessFailureDiagnostic, CutholError, estimateCommandLineLength
} from "../core/diagnostics.js";
import {
  resolveHyperFramesWorkers,
  resolveMaxClipsPerRenderSegment,
  resolveOverlayConcurrency,
} from "../core/env.js";
import { CutholSequence } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { verifySequence } from "../verify/gates.js";
import { runParallelFfmpegJobsSync } from "./render_frames.js";
import { renderSequenceToMp4, countActiveUniqueCompositions } from "./render_main.js";
import { computeRenderTimeSegments } from "./render_segments.js";

/**
 * Renders or retrieves a content-addressed preview MP4 for the current sequence state
 * so `monitor frame` and `monitor sheet` can sample arbitrary timestamps rapidly.
 */
export function ensurePreviewCompositeMp4(
  seq: CutholSequence,
  paths: WorkspacePaths,
  preset: RenderPreset = "draft_480p"
): { mp4Path: string; width: number; height: number; durationMs: number } {
  // Verify structural/asset/timing gates before preview composite
  const verification = verifySequence(seq, paths, ["G1_SCHEMA", "G2_ASSETS", "G3_TIMING"]);
  if (!verification.ok) {
    const firstErr = verification.diagnostics.find((d) => d.severity === "ERROR")!;
    throw new CutholError(firstErr);
  }

  // Synchronize bridge data files (`cuthol-data.js` / `cuthol-vars.json`) BEFORE
  // hashing composition directories so speech/beat/cut changes invalidate `stateHash` immediately.
  const compContents: string[] = [];
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      if (cue.composition) {
        try {
          syncCompositionBridgeFiles(seq, cue, paths);
        } catch {
          // non-blocking bridge sync
        }
        const compDir = path.isAbsolute(cue.composition.composition_dir)
          ? cue.composition.composition_dir
          : path.resolve(paths.rootDir, cue.composition.composition_dir);
        if (fs.existsSync(compDir)) {
          compContents.push(`${cue.id}:${hashDirectoryRecursive(compDir)}`);
        }
      }
    }
  }

  const stateHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        stage: seq.stage,
        libraryDigests: seq.library.map((x) => `${x.handle}:${x.digest_sha256}`),
        spine: seq.spine,
        lanes: seq.lanes,
        compContents,
        preset,
      })
    )
    .digest("hex")
    .slice(0, 14);

  const totalDurationMs = computeRenderDurationMs(seq);
  const scaleFactor = preset === "draft_480p" ? 480 / Math.min(seq.stage.width, seq.stage.height) : 1.0;
  const renderWidth = Math.max(16, Math.round((seq.stage.width * scaleFactor) / 2) * 2);
  const renderHeight = Math.max(16, Math.round((seq.stage.height * scaleFactor) / 2) * 2);

  const cachedMp4 = path.join(paths.blobsDir, `preview_comp_${stateHash}.mp4`);
  // Return immediately on cache hit BEFORE invoking compileSequenceRenderPlan side effects
  if (fs.existsSync(cachedMp4) && fs.statSync(cachedMp4).size > 1000) {
    return {
      mp4Path: cachedMp4,
      width: renderWidth,
      height: renderHeight,
      durationMs: totalDurationMs,
    };
  }

  const maxItemsPerSegment = resolveMaxClipsPerRenderSegment();
  const segments = computeRenderTimeSegments(seq, totalDurationMs, maxItemsPerSegment);
  if (segments.length > 1) {
    const rendered = renderSequenceToMp4({
      workspaceDir: paths.rootDir,
      outputPath: cachedMp4,
      preset,
      encoder: "libx264",
    });
    return {
      mp4Path: rendered.output_path,
      width: rendered.width,
      height: rendered.height,
      durationMs: rendered.duration_ms,
    };
  }

  const previewCompCount = countActiveUniqueCompositions(seq, paths.rootDir);
  const previewWorkers = resolveHyperFramesWorkers();
  const previewConcurrency = resolveOverlayConcurrency({
    workersPerOverlay: previewWorkers,
    coldOverlayCount: previewCompCount > 0 ? previewCompCount : 1,
  });
  if (previewCompCount >= 2 && previewConcurrency > 1) {
    beginOverlayCollect();
    compileSequenceRenderPlan(seq, paths, preset, { includeAudio: false, workers: previewWorkers });
    runCollectedOverlays({ workers: previewWorkers });
  }

  const plan = compileSequenceRenderPlan(seq, paths, preset, { workers: previewWorkers });

  fs.mkdirSync(paths.blobsDir, { recursive: true });
  const tmpMp4 = path.join(
    paths.blobsDir,
    `preview_comp_${stateHash}.${process.pid}.${Date.now()}.tmp.mp4`
  );
  const filterScriptPath = `${tmpMp4}.filter.txt`;
  const useScript =
    plan.filterComplex.length > 4000 ||
    estimateCommandLineLength("ffmpeg", plan.inputArgs) + plan.filterComplex.length > 12000;
  if (useScript) {
    fs.writeFileSync(filterScriptPath, plan.filterComplex, "utf8");
  }

  const ffArgs: string[] = [
    "-y",
    "-v",
    "error",
    ...plan.inputArgs,
    ...(useScript
      ? ["-/filter_complex", filterScriptPath]
      : ["-filter_complex", plan.filterComplex]),
    "-map",
    plan.videoOutPad,
    "-map",
    plan.audioOutPad,
    "-t",
    (plan.totalDurationMs / 1000).toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "20",
    "-g",
    "1", // All-intra frames for exact millisecond seeking in monitor
    "-pix_fmt",
    "yuv420p",
    ...BT709_COLOR_OUTPUT_ARGS,
    "-c:a",
    "aac",
    tmpMp4,
  ];

  try {
    const proc = spawnWatchedSync("ffmpeg", ffArgs, {
      cwd: paths.rootDir,
      encoding: "utf8",
      // No wall-clock limit: a full render scales with sequence length (long videos take hours).
      maxBuffer: 256 * 1024 * 1024,
      step: "ffmpeg preview composite",
      watchedPaths: [tmpMp4],
      cleanupPathsOnStall: [tmpMp4],
    });

    if (proc.status !== 0 || proc.error || !fs.existsSync(tmpMp4)) {
      if (fs.existsSync(tmpMp4)) {
        try {
          fs.unlinkSync(tmpMp4);
        } catch {
          // ignore cleanup error
        }
      }
      throw new CutholError(
        createSubprocessFailureDiagnostic({
          tool: "ffmpeg preview composite",
          executable: "ffmpeg",
          args: ffArgs,
          proc,
          clipCount: seq.spine.clips.length,
          fallbackDetail: "preview composite failed",
        })
      );
    }
  } finally {
    if (fs.existsSync(filterScriptPath)) {
      try {
        fs.unlinkSync(filterScriptPath);
      } catch {
        // ignore
      }
    }
  }

  fs.renameSync(tmpMp4, cachedMp4);

  return {
    mp4Path: cachedMp4,
    width: plan.renderWidth,
    height: plan.renderHeight,
    durationMs: plan.totalDurationMs,
  };
}

/**
 * Pre-renders all active HyperFrames composition frames needed across `timestampsMs` in a single
 * batched `snapshot --at` call per composition cue so subsequent `renderSingleCompositeFrameRgb24`
 * calls hit the `hf_frame_<hash>_f<idx>.png` cache directly.
 */
export function prefetchCompositeFramesForTimestamps(
  seq: CutholSequence,
  paths: WorkspacePaths,
  timestampsMs: number[],
  preset: RenderPreset = "draft_480p"
): void {
  if (timestampsMs.length === 0) return;

  const totalDurationMs = computeRenderDurationMs(seq);
  const fps = Math.max(1, seq.stage.fps);
  const lastFrameIdx = Math.max(0, Math.floor((totalDurationMs / 1000) * fps - 1));
  const maxSafeMs = Math.max(0, Math.floor(lastFrameIdx * (1000 / fps)));
  const frameDurMs = 1000 / fps;

  const scaleFactor = preset === "draft_480p" ? 480 / Math.min(seq.stage.width, seq.stage.height) : 1.0;
  const renderWidth = Math.max(16, Math.round((seq.stage.width * scaleFactor) / 2) * 2);
  const renderHeight = Math.max(16, Math.round((seq.stage.height * scaleFactor) / 2) * 2);

  const exactFrameTimesMs = timestampsMs.map((atMs) => {
    const clampedMs = Math.max(0, Math.min(Math.round(atMs), maxSafeMs));
    const frameIdx = Math.max(0, Math.min(lastFrameIdx, Math.floor((clampedMs / 1000) * fps + 1e-6)));
    return (frameIdx * 1000) / fps;
  });

  const sortedLanes = [...seq.lanes].sort((a, b) => a.z_index - b.z_index);
  for (const lane of sortedLanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (cue.kind !== "composition" || !cue.composition) continue;
      const compMode = cue.composition.mode ?? "overlay_alpha";
      if (compMode === "scene_host") continue;

      const cueStartMs = resolveCueStartMs(seq, cue);
      const cueEndMs = cueStartMs + cue.duration_ms;

      const localSecs: number[] = [];
      for (const exactFrameMs of exactFrameTimesMs) {
        if (exactFrameMs + frameDurMs >= cueStartMs && exactFrameMs <= cueEndMs) {
          localSecs.push(Math.max(0, (exactFrameMs - cueStartMs) / 1000));
        }
      }
      if (localSecs.length === 0) continue;

      try {
        syncCompositionBridgeFiles(seq, cue, paths);
      } catch {
        // non-blocking bridge sync
      }

      const compDir = path.isAbsolute(cue.composition.composition_dir)
        ? cue.composition.composition_dir
        : path.resolve(paths.rootDir, cue.composition.composition_dir);

      const entryPath = path.join(compDir, cue.composition.entry_html);
      let allFramesAlreadyCached = false;
      if (fs.existsSync(entryPath)) {
        try {
          const htmlSource = fs.readFileSync(entryPath, "utf8");
          const wMatch = /\bdata-width\s*=\s*(["'])(\d+)\1/i.exec(htmlSource);
          const hMatch = /\bdata-height\s*=\s*(["'])(\d+)\1/i.exec(htmlSource);
          const nativeWidth = wMatch ? Math.max(16, Number(wMatch[2])) : renderWidth;
          const nativeHeight = hMatch ? Math.max(16, Number(hMatch[2])) : renderHeight;
          const recursiveDirHash = hashDirectoryRecursive(compDir);
          const computeCandidateHash = (
            w: number,
            h: number,
            transparent: boolean,
            backdropDigest: string
          ): string =>
            crypto
              .createHash("sha256")
              .update(recursiveDirHash)
              .update(
                JSON.stringify({
                  entry: cue.composition!.entry_html,
                  w,
                  h,
                  fps,
                  dur: cue.duration_ms,
                  props: cue.composition!.props,
                  transparent,
                  mode: compMode,
                  backdropDigest,
                })
              )
              .digest("hex")
              .slice(0, 16);

          const compHash = computeCandidateHash(
            renderWidth,
            renderHeight,
            cue.composition.transparent,
            ""
          );

          const durationSec = Math.max(0.1, Number((cue.duration_ms / 1000).toFixed(3)));
          const totalFrames = Math.max(1, Math.round(durationSec * fps));
          const missingByFrame = new Map<
            number,
            { fIdx: number; outPng: string; tmpPng: string; seekSec: string }
          >();
          for (const localSec of localSecs) {
            const fIdx = Math.max(0, Math.min(totalFrames - 1, Math.floor(localSec * fps + 1e-6)));
            if (missingByFrame.has(fIdx)) continue;
            const outPng = path.join(paths.blobsDir, `hf_frame_${compHash}_f${fIdx}.png`);
            if (!fs.existsSync(outPng) || fs.statSync(outPng).size <= 200) {
              const tmpPng = `${outPng}.${process.pid}.${fIdx}.tmp.png`;
              missingByFrame.set(fIdx, {
                fIdx,
                outPng,
                tmpPng,
                seekSec: (fIdx / fps).toFixed(6),
              });
            }
          }

          if (missingByFrame.size === 0) {
            const bboxSidecarPath = path.join(compDir, "assets/cuthol-bbox.json");
            if (!cue.composition.transparent || fs.existsSync(bboxSidecarPath)) {
              allFramesAlreadyCached = true;
            }
          } else if (missingByFrame.size > 1) {
            const bgColorDigest = `color:${seq.stage.backdrop.color.trim().toLowerCase()}`;
            const candidateSpecs: Array<{ hash: string; needsScale: boolean }> = [
              { hash: compHash, needsScale: false },
              {
                hash: computeCandidateHash(renderWidth, renderHeight, false, bgColorDigest),
                needsScale: false,
              },
              {
                hash: computeCandidateHash(
                  nativeWidth,
                  nativeHeight,
                  cue.composition.transparent,
                  ""
                ),
                needsScale: nativeWidth !== renderWidth || nativeHeight !== renderHeight,
              },
              {
                hash: computeCandidateHash(nativeWidth, nativeHeight, false, bgColorDigest),
                needsScale: nativeWidth !== renderWidth || nativeHeight !== renderHeight,
              },
            ];

            let cachedBlob: string | null = null;
            let extractVf = "format=rgba";
            let needsScaleFromBlob = false;
            for (const spec of candidateSpecs) {
              for (const ext of ["pngseq", "ffv1.mov", "mov", "mp4"] as const) {
                const cand = path.join(paths.blobsDir, `hf_comp_${spec.hash}.${ext}`);
                if (isValidVideoBlobOnDisk(cand, ext === "pngseq" ? totalFrames : undefined)) {
                  cachedBlob = cand;
                  needsScaleFromBlob = spec.needsScale;
                  extractVf = spec.needsScale
                    ? `scale=${renderWidth}:${renderHeight},format=rgba`
                    : "format=rgba";
                  break;
                }
              }
              if (cachedBlob) break;
            }

            if (cachedBlob) {
              fs.mkdirSync(paths.blobsDir, { recursive: true });
              const missingList = [...missingByFrame.values()];
              let extractedCount = 0;

              if (isPngSequenceBlobDir(cachedBlob) && !needsScaleFromBlob) {
                for (const m of missingList) {
                  const srcPng = resolveFramePngInPngSequenceDir(cachedBlob, m.fIdx);
                  if (srcPng) {
                    try {
                      fs.copyFileSync(srcPng, m.tmpPng);
                      if (fs.existsSync(m.tmpPng) && fs.statSync(m.tmpPng).size > 64) {
                        fs.renameSync(m.tmpPng, m.outPng);
                        extractedCount++;
                      }
                    } catch {
                      // ignore
                    }
                  }
                }
              } else {
                const extractJobs: ParallelFfmpegJob[] = missingList.map((m) => {
                  if (isPngSequenceBlobDir(cachedBlob!)) {
                    const srcPng =
                      resolveFramePngInPngSequenceDir(cachedBlob!, m.fIdx) ??
                      path.join(cachedBlob!, "frame_000001.png");
                    return {
                      args: [
                        "-y",
                        "-v",
                        "error",
                        "-i",
                        srcPng,
                        "-vf",
                        extractVf,
                        "-frames:v",
                        "1",
                        m.tmpPng,
                      ],
                      cwd: paths.rootDir,
                    };
                  }
                  return {
                    args: [
                      "-y",
                      "-v",
                      "error",
                      "-ss",
                      m.seekSec,
                      "-i",
                      cachedBlob!,
                      "-vf",
                      extractVf,
                      "-frames:v",
                      "1",
                      m.tmpPng,
                    ],
                    cwd: paths.rootDir,
                  };
                });
                const extractResults = runParallelFfmpegJobsSync(
                  extractJobs,
                  missingList.map(() => 4 * 1024 * 1024)
                );
                for (let i = 0; i < missingList.length; i++) {
                  const m = missingList[i];
                  if (
                    extractResults[i]?.status === 0 &&
                    fs.existsSync(m.tmpPng) &&
                    fs.statSync(m.tmpPng).size > 200
                  ) {
                    fs.renameSync(m.tmpPng, m.outPng);
                    extractedCount++;
                  } else if (fs.existsSync(m.tmpPng)) {
                    try {
                      fs.unlinkSync(m.tmpPng);
                    } catch {
                      // ignore
                    }
                  }
                }
              }
              if (extractedCount === missingList.length) {
                const bboxSidecarPath = path.join(compDir, "assets/cuthol-bbox.json");
                if (!cue.composition.transparent || fs.existsSync(bboxSidecarPath)) {
                  allFramesAlreadyCached = true;
                }
              }
            }
          }
        } catch {
          // fall through to renderHyperFramesBatchFramesPng
        }
      }

      if (!allFramesAlreadyCached) {
        renderHyperFramesBatchFramesPng({
          compositionDir: compDir,
          entryHtml: cue.composition.entry_html,
          blobsDir: paths.blobsDir,
          width: renderWidth,
          height: renderHeight,
          fps,
          durationMs: cue.duration_ms,
          localSecs,
          props: cue.composition.props,
          transparent: cue.composition.transparent,
          mode: compMode,
        });
      }
    }
  }
}
