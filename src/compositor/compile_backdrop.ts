// Backdrop slices under compositions: scene-host video slice and static still PNG (split out of compiler.ts).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CutholSequence } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import {
  ensureLibraryItemVideoProbe, resolveLibraryItemPath,
  resolveSourceColorSpec
} from "../library/probe.js";
import { sequenceMsToSourceMs } from "../sequence/spine.js";
import {
  hasPendingCollectedOverlayForPaths,
  isOverlayCollectActive, runCollectedOverlays
} from "./hyperframes_bridge.js";
import { BT709_TO_YUV420P, buildSourceScaleFilter, BT709_SETPARAMS } from "./compile_color.js";

export function extractSceneHostBackdropSlice(
  seq: CutholSequence,
  paths: WorkspacePaths,
  cueStartMs: number,
  cueDurationMs: number,
  renderWidth: number,
  renderHeight: number,
  fps: number,
  underneathGraph?: {
    inputArgs: string[];
    filterChains: string[];
    videoPad: string;
  }
): string | undefined {
  const cueEndMs = cueStartMs + cueDurationMs;
  const cueStartSec = Number((cueStartMs / 1000).toFixed(3));
  const cueEndSec = Number((cueEndMs / 1000).toFixed(3));
  const durSec = Number((cueDurationMs / 1000).toFixed(3));

  // Render the exact underneath composite graph (backdrop + z_index < 0 lanes + spine with speed ramps,
  // transitions, color grades, crops, and fit modes) over [cueStartSec, cueEndSec] so boundary frames match 100%.
  if (underneathGraph && underneathGraph.inputArgs.length > 0) {
    if (
      isOverlayCollectActive() &&
      hasPendingCollectedOverlayForPaths(underneathGraph.inputArgs)
    ) {
      runCollectedOverlays({ keepCollecting: true });
    }
    const graphFilter = [
      "sws_flags=accurate_rnd+full_chroma_int",
      ...underneathGraph.filterChains,
      `${underneathGraph.videoPad}trim=start=${cueStartSec}:end=${cueEndSec},setpts=PTS-STARTPTS,fps=${fps}:eof_action=pass,tpad=stop_mode=clone:stop_duration=${(2 / fps).toFixed(3)},${BT709_TO_YUV420P},settb=AVTB[v_sh_out]`,
    ].join(";");

    const sliceHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          libDigests: seq.library.map((x) => `${x.handle}:${x.digest_sha256}`),
          inputArgs: underneathGraph.inputArgs,
          graphFilter,
          cueStartSec,
          durSec,
          w: renderWidth,
          h: renderHeight,
          fps,
        })
      )
      .digest("hex")
      .slice(0, 14);

    fs.mkdirSync(paths.blobsDir, { recursive: true });
    const outMp4 = path.join(paths.blobsDir, `sh_backdrop_${sliceHash}.mp4`);
    if (fs.existsSync(outMp4) && fs.statSync(outMp4).size > 500) {
      return outMp4;
    }

    const tmpMp4 = `${outMp4}.${process.pid}.${Date.now()}.tmp.mp4`;
    const proc = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        ...underneathGraph.inputArgs,
        "-filter_complex",
        graphFilter,
        "-map",
        "[v_sh_out]",
        "-t",
        String(durSec),
        "-an",
        "-c:v",
        "libx264",
        "-crf",
        "14",
        "-preset",
        "fast",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        tmpMp4,
      ],
      { cwd: paths.rootDir, encoding: "utf8" }
    );
    if (proc.status === 0 && fs.existsSync(tmpMp4) && fs.statSync(tmpMp4).size > 500) {
      fs.renameSync(tmpMp4, outMp4);
      return outMp4;
    }
    if (fs.existsSync(tmpMp4)) {
      try {
        fs.unlinkSync(tmpMp4);
      } catch {
        // ignore
      }
    }
  }

  const clip = seq.spine.clips.find(
    (c) => c.timeline_in_ms < cueEndMs && c.timeline_in_ms + c.duration_ms > cueStartMs
  );
  if (!clip) return undefined;
  const asset = seq.library.find((item) => item.handle === clip.asset_handle);
  if (!asset || !asset.probe.has_video) return undefined;

  const absAsset = resolveLibraryItemPath(paths.rootDir, asset);
  ensureLibraryItemVideoProbe(asset, paths.rootDir);
  const assetColorSpec = resolveSourceColorSpec(asset.probe, absAsset);
  const srcStartMs = sequenceMsToSourceMs(clip, Math.max(clip.timeline_in_ms, cueStartMs));
  const srcStartSec = Number((srcStartMs / 1000).toFixed(3));

  const sliceHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        digest: asset.digest_sha256,
        srcStartSec,
        durSec,
        w: renderWidth,
        h: renderHeight,
        fps,
        colorSpec: {
          isRgb: assetColorSpec.isRgb,
          inMatrix: assetColorSpec.inMatrix,
          inRange: assetColorSpec.inRange,
        },
      })
    )
    .digest("hex")
    .slice(0, 14);

  fs.mkdirSync(paths.blobsDir, { recursive: true });
  const outMp4 = path.join(paths.blobsDir, `sh_backdrop_${sliceHash}.mp4`);
  if (fs.existsSync(outMp4) && fs.statSync(outMp4).size > 500) {
    return outMp4;
  }

  const shScalePrefix = assetColorSpec.isRgb ? "format=rgba," : "";
  const shScaleStep = buildSourceScaleFilter(renderWidth, renderHeight, assetColorSpec, "increase");
  const tmpMp4 = `${outMp4}.${process.pid}.tmp.mp4`;
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-ss",
      String(srcStartSec),
      "-i",
      absAsset,
      "-t",
      String(durSec),
      "-vf",
      `fps=${fps}:eof_action=pass,tpad=stop_mode=clone:stop_duration=${(2 / fps).toFixed(3)},${shScalePrefix}${shScaleStep},crop=${renderWidth}:${renderHeight},${BT709_TO_YUV420P},settb=AVTB`,
      "-an",
      "-c:v",
      "libx264",
      "-crf",
      "14",
      "-preset",
      "fast",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-color_range",
      "tv",
      tmpMp4,
    ],
    { encoding: "utf8" }
  );
  if (proc.status === 0 && fs.existsSync(tmpMp4) && fs.statSync(tmpMp4).size > 500) {
    fs.renameSync(tmpMp4, outMp4);
    return outMp4;
  }
  return undefined;
}

export interface StaticStillLayerSpec {
  id: string;
  assetHandle: string;
  assetDigest: string;
  absAssetPath: string;
  spatialFilters: string[];
  xExpr: string;
  yExpr: string;
}

export function extractStaticBackdropPngSlice(
  seq: CutholSequence,
  paths: WorkspacePaths,
  renderWidth: number,
  renderHeight: number,
  fps: number,
  stillLayers: StaticStillLayerSpec[]
): string | undefined {
  if (stillLayers.length === 0) return undefined;
  const bgHex = seq.stage.backdrop.color.replace(/^#/, "0x");
  const inputArgs: string[] = [
    "-f",
    "lavfi",
    "-i",
    `color=c=${bgHex}:s=${renderWidth}x${renderHeight}:r=${fps}:d=0.1,format=rgb24,${BT709_TO_YUV420P},settb=AVTB`,
  ];
  const chains: string[] = ["sws_flags=accurate_rnd+full_chroma_int"];
  let pad = "[0:v]";
  for (let idx = 0; idx < stillLayers.length; idx++) {
    const layer = stillLayers[idx];
    const inIdx = idx + 1;
    inputArgs.push("-loop", "1", "-framerate", String(fps), "-t", "0.1", "-i", layer.absAssetPath);
    const layerPad = `[v_st_${idx}]`;
    const nextPad = `[vc_st_${idx + 1}]`;
    chains.push(
      `[${inIdx}:v]settb=AVTB,fps=${fps}:eof_action=pass,${layer.spatialFilters.join(",")},settb=AVTB${layerPad}`,
      `${pad}${layerPad}overlay=x='${layer.xExpr}':y='${layer.yExpr}':eval=frame:eof_action=pass,${BT709_SETPARAMS}${nextPad}`
    );
    pad = nextPad;
  }
  chains.push(
    `${pad}fps=${fps}:eof_action=pass,scale=${renderWidth}:${renderHeight}:in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24[v_still_out]`
  );
  const graphFilter = chains.join(";");

  const sliceHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        bgHex,
        w: renderWidth,
        h: renderHeight,
        fps,
        layers: stillLayers.map((l) => ({
          handle: l.assetHandle,
          digest: l.assetDigest,
          filters: l.spatialFilters,
          x: l.xExpr,
          y: l.yExpr,
        })),
      })
    )
    .digest("hex")
    .slice(0, 14);

  fs.mkdirSync(paths.blobsDir, { recursive: true });
  const outPng = path.join(paths.blobsDir, `sh_still_${sliceHash}.png`);
  if (fs.existsSync(outPng) && fs.statSync(outPng).size > 200) {
    return outPng;
  }

  const tmpPng = `${outPng}.${process.pid}.${Date.now()}.tmp.png`;
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      ...inputArgs,
      "-filter_complex",
      graphFilter,
      "-map",
      "[v_still_out]",
      "-frames:v",
      "1",
      tmpPng,
    ],
    { cwd: paths.rootDir, encoding: "utf8" }
  );
  if (proc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 200) {
    fs.renameSync(tmpPng, outPng);
    return outPng;
  }
  if (fs.existsSync(tmpPng)) {
    try {
      fs.unlinkSync(tmpPng);
    } catch {
      // ignore
    }
  }
  return undefined;
}
