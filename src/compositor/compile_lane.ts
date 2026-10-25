// Per-lane filter-graph compilation: HyperFrames composition cues, visual asset cues, and lane typography (split out of compiler.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveCueStartMs } from "../core/timeline.js";
import { CutholSequence, getCuePlaybackRate, isStillGraphic, maxSourceDurationMs } from "../core/schema.js";
import {
  probeStandaloneVideoColorMetadata,
  resolveLibraryItemPath,
  resolveSourceColorSpec,
  SourceColorSpec,
} from "../library/probe.js";
import { compileTypographyAssFile } from "./ass_generator.js";
import { syncCompositionBridgeFiles } from "./bridge_exporter.js";
import {
  isOverlayCollectActive,
  isPngSequenceBlobDir,
  renderHyperFramesCompositionToMp4,
  renderHyperFramesSingleFramePng,
} from "./hyperframes_bridge.js";
import {
  StaticStillLayerSpec,
  extractSceneHostBackdropSlice,
  extractStaticBackdropPngSlice,
} from "./compile_backdrop.js";
import {
  BT709_TO_YUV420P,
  buildSourceScaleFilter,
  BT709_TO_RGBA,
  BT709_TO_YUVA420P,
  BT709_TO_YUV444P10,
  BT709_TO_YUVA444P10,
  BT709_SETPARAMS,
} from "./compile_color.js";
import {
  compileEnvelopeToFfmpegExpr,
  buildSubpixelScaleOrPanFilters,
  buildSeekableMediaInput,
  escapeFfmpegFilterPath,
} from "./compile_filters.js";
import type { DrawnVisualLayer, VideoGraphCompileContext } from "./compiler.js";

type LaneSpec = CutholSequence["lanes"][number];
type LaneCueSpec = LaneSpec["cues"][number];

function prepareCompositionCueInput(
  ctx: VideoGraphCompileContext,
  cue: LaneCueSpec,
  cueStartMs: number,
  cueEndMs: number
): {
  compMode: NonNullable<LaneCueSpec["composition"]>["mode"];
  hfIdx: number;
  frameDurMs: number;
  isFullFrameUnscaled: boolean;
  effectiveTransparent: boolean;
} {
  const { seq, paths, renderWidth, renderHeight, fps, compileOptions } = ctx;
  const composition = cue.composition!;
  try {
    syncCompositionBridgeFiles(seq, cue, paths);
  } catch {
    // non-blocking bridge sync
  }
  const compDir = path.isAbsolute(composition.composition_dir)
    ? composition.composition_dir
    : path.resolve(paths.rootDir, composition.composition_dir);

  const compMode = composition.mode ?? "overlay_alpha";
  let hfIdx: number;
  const frameDurMs = 1000 / Math.max(1, fps);

  const isFullFrameUnscaled =
    Math.abs(cue.placement.scale_x - 1) < 1e-3 &&
    Math.abs(cue.placement.scale_y - 1) < 1e-3 &&
    Math.abs(cue.placement.x_pct) < 1e-3 &&
    Math.abs(cue.placement.y_pct) < 1e-3 &&
    Math.abs(cue.placement.rotation_deg) < 1e-3 &&
    cue.placement.opacity >= 0.999 &&
    !cue.placement.crop &&
    !cue.placement.mirror_x &&
    !cue.placement.mirror_y &&
    !cue.envelopes.some((e) => e.parameter.startsWith("placement."));

  const overlappingUnder = ctx.drawnVisualLayers.filter(
    (l) => l.startMs < cueEndMs && l.endMs > cueStartMs
  );
  const hasMovingUnderneath = overlappingUnder.some((l) => l.kind !== "still_graphic");
  const hasOnlyStaticStillUnderneath =
    overlappingUnder.length > 0 &&
    !hasMovingUnderneath &&
    overlappingUnder.every((l) => l.startMs <= cueStartMs && l.endMs >= cueEndMs);

  let effectiveTransparent = composition.transparent;
  let opaqueBackdropColor: string | undefined;
  let backdropImagePath: string | undefined;
  let bakedUnderneathIds: string[] = [];

  if (
    compileOptions?.singleFrameAtMs !== undefined &&
    compMode !== "scene_host" &&
    compileOptions.singleFrameAtMs + frameDurMs >= cueStartMs &&
    compileOptions.singleFrameAtMs <= cueEndMs
  ) {
    // Preserve exact floating-point `singleFrameAtMs` (without integer ms truncation)
    // so 30fps `frameIdx = 3k + 1` never drifts by 1 frame.
    const localSec = Math.max(0, (compileOptions.singleFrameAtMs - cueStartMs) / 1000);
    const singleFrame = renderHyperFramesSingleFramePng({
      compositionDir: compDir,
      entryHtml: composition.entry_html,
      blobsDir: paths.blobsDir,
      width: renderWidth,
      height: renderHeight,
      fps,
      durationMs: cue.duration_ms,
      localSec,
      props: composition.props,
      transparent: composition.transparent,
      mode: compMode,
    });
    ctx.hyperframesBlobs.push(singleFrame.pngPath);
    hfIdx = ctx.addInput([
      "-loop",
      "1",
      "-framerate",
      String(fps),
      "-t",
      (cue.duration_ms / 1000 + 2 / fps).toFixed(3),
      "-i",
      singleFrame.pngPath,
    ]);
  } else {
    const backdropVideoPath =
      compMode === "scene_host"
        ? extractSceneHostBackdropSlice(
            seq,
            paths,
            cueStartMs,
            cue.duration_ms,
            renderWidth,
            renderHeight,
            fps,
            ctx.inputArgs.length <= 48
              ? {
                  inputArgs: [...ctx.inputArgs],
                  filterChains: [...ctx.filterChains],
                  videoPad: ctx.currentVideoPad,
                }
              : undefined
          )
        : undefined;

    if (compMode !== "scene_host" && isFullFrameUnscaled && !hasMovingUnderneath) {
      if (overlappingUnder.length === 0) {
        effectiveTransparent = false;
        opaqueBackdropColor = seq.stage.backdrop.color;
      } else if (hasOnlyStaticStillUnderneath) {
        const stillSpecs = overlappingUnder
          .map((l) => l.stillSpec)
          .filter((s): s is StaticStillLayerSpec => Boolean(s));
        const stillPng =
          stillSpecs.length === overlappingUnder.length
            ? extractStaticBackdropPngSlice(
                seq,
                paths,
                renderWidth,
                renderHeight,
                fps,
                stillSpecs
              )
            : undefined;
        if (stillPng) {
          effectiveTransparent = false;
          opaqueBackdropColor = seq.stage.backdrop.color;
          backdropImagePath = stillPng;
          bakedUnderneathIds = overlappingUnder.map((l) => l.id);
        }
      }
    }

    const hfBlob = renderHyperFramesCompositionToMp4({
      compositionDir: compDir,
      entryHtml: composition.entry_html,
      blobsDir: paths.blobsDir,
      width: renderWidth,
      height: renderHeight,
      fps,
      durationMs: cue.duration_ms,
      props: composition.props,
      transparent: effectiveTransparent,
      mode: compMode,
      backdropVideoPath,
      opaqueBackdropColor,
      backdropImagePath,
      workers: compileOptions?.workers,
      useGpu: compileOptions?.useGpu,
    });
    ctx.hyperframesBlobs.push(hfBlob);
    const isPngSeqBlob = isPngSequenceBlobDir(hfBlob);
    hfIdx = isPngSeqBlob
      ? ctx.addInput([
          "-framerate",
          String(fps),
          "-start_number",
          "1",
          "-i",
          path.join(hfBlob, "frame_%06d.png"),
        ])
      : ctx.addInput(["-i", hfBlob]);

    const blobColorSpec = isPngSeqBlob
      ? ({ isRgb: true, inMatrix: "bt709", inRange: "pc", sourceRule: "rgb" } as const)
      : resolveSourceColorSpec(
          probeStandaloneVideoColorMetadata(hfBlob),
          hfBlob,
          { isHyperFramesBlob: true }
        );

    ctx.drawnVisualLayers.push({
      id: cue.id,
      startMs: cueStartMs,
      endMs: cueEndMs,
      kind:
        !effectiveTransparent &&
        isFullFrameUnscaled &&
        hfBlob.endsWith(".mp4") &&
        !blobColorSpec.isRgb &&
        blobColorSpec.inMatrix === "bt709" &&
        blobColorSpec.inRange === "tv"
          ? "opaque_comp"
          : "moving",
      blobPath: hfBlob,
      bakedUnderneathIds,
    });
  }

  return {
    compMode,
    hfIdx,
    frameDurMs,
    isFullFrameUnscaled,
    effectiveTransparent,
  };
}

function compileCompositionLaneCue(
  ctx: VideoGraphCompileContext,
  cue: LaneCueSpec,
  cueStartMs: number,
  cueEndMs: number,
  cueStartSec: string,
  cueEndSec: string,
  isCueInActiveWindow: boolean
): void {
  if (!isCueInActiveWindow) {
    ctx.drawnVisualLayers.push({
      id: cue.id,
      startMs: cueStartMs,
      endMs: cueEndMs,
      kind: "moving",
    });
    return;
  }

  const {
    renderWidth,
    renderHeight,
    fps,
    compileOptions,
    activeWin,
    winLeadStartMs,
    winEndMs,
    winLeadStartSec,
    winEndPadSec,
  } = ctx;

  const {
    compMode,
    hfIdx,
    frameDurMs,
    isFullFrameUnscaled,
    effectiveTransparent,
  } = prepareCompositionCueInput(ctx, cue, cueStartMs, cueEndMs);

  const hfSxEnv = cue.envelopes.find((e) => e.parameter === "placement.scale_x");
  const hfSyEnv = cue.envelopes.find((e) => e.parameter === "placement.scale_y");
  const hfSxExpr = compileEnvelopeToFfmpegExpr({ envelope: hfSxEnv, timeBaseOffsetMs: 0, mode: "raw" });
  const hfSyExpr = compileEnvelopeToFfmpegExpr({ envelope: hfSyEnv, timeBaseOffsetMs: 0, mode: "raw" });
  const hfHasDynScale = Boolean(hfSxExpr || hfSyExpr);
  const xEnv = cue.envelopes.find((e) => e.parameter === "placement.x_pct");
  const yEnv = cue.envelopes.find((e) => e.parameter === "placement.y_pct");

  const targetW = hfHasDynScale
    ? renderWidth
    : Math.max(8, Math.round((renderWidth * Math.abs(cue.placement.scale_x)) / 2) * 2);
  const targetH = hfHasDynScale
    ? renderHeight
    : Math.max(8, Math.round((renderHeight * Math.abs(cue.placement.scale_y)) / 2) * 2);
  const hfRadAbs = (Math.abs(cue.placement.rotation_deg) * Math.PI) / 180;
  const hfEffW =
    Math.abs(cue.placement.rotation_deg) > 0.01
      ? Math.round(targetW * Math.abs(Math.cos(hfRadAbs)) + targetH * Math.abs(Math.sin(hfRadAbs)))
      : targetW;
  const hfEffH =
    Math.abs(cue.placement.rotation_deg) > 0.01
      ? Math.round(targetW * Math.abs(Math.sin(hfRadAbs)) + targetH * Math.abs(Math.cos(hfRadAbs)))
      : targetH;
  const baseCenterX = Math.round((renderWidth - hfEffW) / 2);
  const baseCenterY = Math.round((renderHeight - hfEffH) / 2);

  const activeHfBlobPath = ctx.hyperframesBlobs[ctx.hyperframesBlobs.length - 1] ?? "";
  const hfColorSpec: SourceColorSpec =
    !activeHfBlobPath ||
    isPngSequenceBlobDir(activeHfBlobPath) ||
    activeHfBlobPath.toLowerCase().endsWith(".png") ||
    activeHfBlobPath.toLowerCase().endsWith(".ffv1.mov")
      ? { isRgb: true, inMatrix: "bt709", inRange: "pc", sourceRule: "rgb" }
      : resolveSourceColorSpec(
          probeStandaloneVideoColorMetadata(activeHfBlobPath),
          activeHfBlobPath,
          { isHyperFramesBlob: true }
        );

  const hfFilters: string[] = [buildSourceScaleFilter(targetW, targetH, hfColorSpec)];
  if (cue.placement.mirror_x) hfFilters.push("hflip");
  if (cue.placement.mirror_y) hfFilters.push("vflip");
  const hfRotEnv = cue.envelopes.find((e) => e.parameter === "placement.rotation_deg");
  const hfRotExpr = compileEnvelopeToFfmpegExpr({
    envelope: hfRotEnv,
    timeBaseOffsetMs: 0,
    mode: "raw",
  });
  const hfOpEnv = cue.envelopes.find((e) => e.parameter === "placement.opacity");
  const hfOpExpr = compileEnvelopeToFfmpegExpr({
    envelope: hfOpEnv,
    timeBaseOffsetMs: 0,
    mode: "raw",
  });
  // RGB sources (PNG sequence, single-frame PNG, FFV1 BGRA) stay in RGB until converted to BT.709 YUV;
  // YUV overlay blobs (ProRes / MP4) convert to RGBA using their resolved input color matrix.
  hfFilters.push(hfColorSpec.isRgb ? "format=rgba" : BT709_TO_RGBA);
  if (hfRotExpr) {
    const radExpr = `((${hfRotExpr})*PI/180)`;
    hfFilters.push(`rotate=a='${radExpr}':ow='rotw(${radExpr})':oh='roth(${radExpr})':c=none`);
  } else if (Math.abs(cue.placement.rotation_deg) > 0.01) {
    const rad = ((cue.placement.rotation_deg * Math.PI) / 180).toFixed(4);
    hfFilters.push(`rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`);
  }
  if (hfOpExpr) {
    const opExprT = hfOpExpr.replace(/\bt\b/g, "T");
    hfFilters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*(${opExprT}),0,255)'`);
  } else if (cue.placement.opacity < 0.999) {
    hfFilters.push(`colorchannelmixer=aa=${cue.placement.opacity.toFixed(3)}`);
  }
  const isSingleFrameHfPng =
    compileOptions?.singleFrameAtMs !== undefined &&
    compMode !== "scene_host" &&
    compileOptions.singleFrameAtMs + frameDurMs >= cueStartMs &&
    compileOptions.singleFrameAtMs <= cueEndMs;
  const hfLocalTimeExpr = isSingleFrameHfPng
    ? Math.max(0, (compileOptions!.singleFrameAtMs! - cueStartMs) / 1000).toFixed(6)
    : `((in-1)/${fps})`;
  const sxPart = hfSxExpr ? `abs(${hfSxExpr})` : String(Math.abs(cue.placement.scale_x));
  const syPart = hfSyExpr ? `abs(${hfSyExpr})` : String(Math.abs(cue.placement.scale_y));
  hfFilters.push(
    ...buildSubpixelScaleOrPanFilters({
      hasDynamicScale: hfHasDynScale,
      sxPart,
      syPart,
      xEnv,
      yEnv,
      staticXPct: cue.placement.x_pct,
      staticYPct: cue.placement.y_pct,
      baseCenterX,
      baseCenterY,
      renderWidth,
      renderHeight,
      localTimeExpr: hfLocalTimeExpr,
    })
  );
  hfFilters.push(
    `tpad=stop_mode=clone:stop_duration=${(2 / fps).toFixed(3)}`,
    `settb=AVTB`,
    `setpts=PTS-STARTPTS+${cueStartSec}/TB`
  );
  if (
    activeWin &&
    compileOptions?.singleFrameAtMs === undefined &&
    (cueStartMs < winLeadStartMs - 1e-3 || cueEndMs > winEndMs + 1e-3)
  ) {
    hfFilters.push(`trim=start=${winLeadStartSec}:end=${winEndPadSec}`);
  }

  const hfPad = `[v_hf_${cue.id}]`;
  ctx.filterChains.push(`[${hfIdx}:v]${hfFilters.join(",")}${hfPad}`);

  const xExpr = hfHasDynScale
    ? hfRotExpr
      ? `(W-w)/2`
      : String(baseCenterX)
    : compileEnvelopeToFfmpegExpr({
        envelope: xEnv,
        timeBaseOffsetMs: cueStartMs,
        mode: "pixel_offset",
        baseCenterPx: baseCenterX,
        canvasDimPx: renderWidth,
      }) ??
      (hfRotExpr
        ? `(W-w)/2+${Math.round((cue.placement.x_pct / 100) * renderWidth)}`
        : String(Math.round(baseCenterX + (cue.placement.x_pct / 100) * renderWidth)));

  const yExpr = hfHasDynScale
    ? hfRotExpr
      ? `(H-h)/2`
      : String(baseCenterY)
    : compileEnvelopeToFfmpegExpr({
        envelope: yEnv,
        timeBaseOffsetMs: cueStartMs,
        mode: "pixel_offset",
        baseCenterPx: baseCenterY,
        canvasDimPx: renderHeight,
      }) ??
      (hfRotExpr
        ? `(H-h)/2+${Math.round((cue.placement.y_pct / 100) * renderHeight)}`
        : String(Math.round(baseCenterY + (cue.placement.y_pct / 100) * renderHeight)));

  if (!effectiveTransparent && isFullFrameUnscaled && compileOptions?.singleFrameAtMs === undefined) {
    const ovYuvPad = `[vc_oyuv_${++ctx.vStepCounter}]`;
    const nextPad = `[vc_${ctx.vStepCounter}]`;
    ctx.filterChains.push(
      `${hfPad}${BT709_TO_YUVA420P}${ovYuvPad}`,
      `${ctx.currentVideoPad}${ovYuvPad}overlay=x='${xExpr}':y='${yExpr}':eval=frame:enable='between(t,${cueStartSec},${cueEndSec})':eof_action=pass:repeatlast=0,${BT709_TO_YUV420P}${nextPad}`
    );
    ctx.currentVideoPad = nextPad;
  } else {
    const base10Pad = `[vc_b10_${++ctx.vStepCounter}]`;
    const ov10Pad = `[vc_o10_${ctx.vStepCounter}]`;
    const nextPad = `[vc_${ctx.vStepCounter}]`;
    ctx.filterChains.push(
      `${ctx.currentVideoPad}${BT709_TO_YUV444P10}${base10Pad}`,
      `${hfPad}${BT709_TO_YUVA444P10}${ov10Pad}`,
      `${base10Pad}${ov10Pad}overlay=x='${xExpr}':y='${yExpr}':format=yuv444p10:alpha=straight:eval=frame:enable='between(t,${cueStartSec},${cueEndSec})':eof_action=pass:repeatlast=0,${BT709_TO_YUV420P}${nextPad}`
    );
    ctx.currentVideoPad = nextPad;
  }
}

function buildVisualAssetCueFilterChain(
  ctx: VideoGraphCompileContext,
  params: {
    cue: LaneCueSpec;
    asset: CutholSequence["library"][number];
    absAssetPath: string;
    isStill: boolean;
    cueRate: number;
    srcInMs: number;
    srcOutMs: number;
    srcInSec: string;
    srcOutSec: string;
    cueStartMs: number;
    cueEndMs: number;
    cueStartSec: string;
  }
): {
  vFilters: string[];
  cueSpatialFilters: string[];
  xExpr: string;
  yExpr: string;
} {
  const {
    renderWidth,
    renderHeight,
    fps,
    activeWin,
    winLeadStartMs,
    winEndMs,
    winLeadStartSec,
    winEndPadSec,
  } = ctx;
  const {
    cue,
    asset,
    absAssetPath,
    isStill,
    cueRate,
    srcInMs,
    srcOutMs,
    srcInSec,
    srcOutSec,
    cueStartMs,
    cueEndMs,
    cueStartSec,
  } = params;

  const cropWRatio = cue.placement.crop
    ? Math.max(0.05, 1 - (cue.placement.crop.left_pct + cue.placement.crop.right_pct) / 100)
    : 1.0;
  const cropHRatio = cue.placement.crop
    ? Math.max(0.05, 1 - (cue.placement.crop.top_pct + cue.placement.crop.bottom_pct) / 100)
    : 1.0;
  const assetAr =
    asset.probe.width > 0 && asset.probe.height > 0
      ? (asset.probe.width * cropWRatio) / (asset.probe.height * cropHRatio)
      : renderWidth / renderHeight;
  const cueSxEnv = cue.envelopes.find((e) => e.parameter === "placement.scale_x");
  const cueSyEnv = cue.envelopes.find((e) => e.parameter === "placement.scale_y");
  const cueSxExpr = compileEnvelopeToFfmpegExpr({ envelope: cueSxEnv, timeBaseOffsetMs: 0, mode: "raw" });
  const cueSyExpr = compileEnvelopeToFfmpegExpr({ envelope: cueSyEnv, timeBaseOffsetMs: 0, mode: "raw" });
  const cueHasDynScale = Boolean(cueSxExpr || cueSyExpr);
  const xEnv = cue.envelopes.find((e) => e.parameter === "placement.x_pct");
  const yEnv = cue.envelopes.find((e) => e.parameter === "placement.y_pct");

  // Compute targetH from cropped assetAr * scale_y
  const targetW = cueHasDynScale
    ? renderWidth
    : Math.max(8, Math.round((renderWidth * Math.abs(cue.placement.scale_x)) / 2) * 2);
  const targetH = cueHasDynScale
    ? Math.max(8, Math.round((renderWidth / assetAr) / 2) * 2)
    : Math.max(8, Math.round(((renderWidth / assetAr) * Math.abs(cue.placement.scale_y)) / 2) * 2);
  const cueRadAbs = (Math.abs(cue.placement.rotation_deg) * Math.PI) / 180;
  const cueEffW =
    Math.abs(cue.placement.rotation_deg) > 0.01
      ? Math.round(targetW * Math.abs(Math.cos(cueRadAbs)) + targetH * Math.abs(Math.sin(cueRadAbs)))
      : targetW;
  const cueEffH =
    Math.abs(cue.placement.rotation_deg) > 0.01
      ? Math.round(targetW * Math.abs(Math.sin(cueRadAbs)) + targetH * Math.abs(Math.cos(cueRadAbs)))
      : targetH;
  const baseCenterX = Math.round((renderWidth - cueEffW) / 2);
  const baseCenterY = Math.round((renderHeight - cueEffH) / 2);

  // Reset PTS to 0 right after `trim` (`setpts=PTS-STARTPTS`) so local keyframe
  // envelopes (`rotate`, `geq` opacity, `scale`) evaluate over `t = 0 .. cueDuration` even when `srcInMs > 0`.
  // Frame-exact tail padding ensures non-30fps / VFR sources cover every output frame until `cueEndSec`.
  const cueSrcFps = Math.max(1, asset.probe.fps || fps);
  const cueRawSrcSpanSec = Math.max(0, (srcOutMs - srcInMs) / (1000 * cueRate));
  const cueDurSec = cue.duration_ms / 1000;
  const cueTailPadSec = Math.max(
    0.1,
    Math.max(0, cueDurSec - cueRawSrcSpanSec) + 3 / (cueSrcFps * cueRate) + 2 / fps
  ).toFixed(3);
  const needsPreTrimEofPad =
    !isStill &&
    asset.probe.duration_ms > 0 &&
    srcOutMs >= Math.max(0, asset.probe.duration_ms - 5000);
  const cueStillPadSec = (cueDurSec + 2 / fps).toFixed(3);
  const vFilters: string[] = isStill
    ? [`fps=${fps}:eof_action=pass`, `tpad=stop_mode=clone:stop_duration=${cueStillPadSec}`]
    : [
        `settb=AVTB`,
        ...(needsPreTrimEofPad ? [`tpad=stop_mode=clone:stop_duration=3.000`] : []),
        `trim=start=${srcInSec}:end=${srcOutSec}`,
        cueRate === 1.0
          ? `setpts=PTS-STARTPTS`
          : `setpts=(PTS-STARTPTS)/${cueRate.toFixed(4)}`,
        `fps=${fps}:eof_action=pass`,
        `tpad=stop_mode=clone:stop_duration=${cueTailPadSec}`,
      ];
  const cueSpatialFilterStartIdx = vFilters.length;

  const cueColorSpec = resolveSourceColorSpec(asset.probe, absAssetPath);
  if (cueColorSpec.isRgb) {
    vFilters.push("format=rgba");
  }

  if (cue.placement.crop) {
    const cr = cue.placement.crop;
    const wRatio = cropWRatio.toFixed(4);
    const hRatio = cropHRatio.toFixed(4);
    const xRatio = (cr.left_pct / 100).toFixed(4);
    const yRatio = (cr.top_pct / 100).toFixed(4);
    vFilters.push(`crop=w=iw*${wRatio}:h=ih*${hRatio}:x=iw*${xRatio}:y=ih*${yRatio}`);
  }

  if (cue.placement.fit_mode === "contain") {
    vFilters.push(
      buildSourceScaleFilter(targetW, targetH, cueColorSpec, "decrease"),
      `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black@0`
    );
  } else {
    vFilters.push(buildSourceScaleFilter(targetW, targetH, cueColorSpec));
  }
  if (cue.placement.mirror_x) vFilters.push("hflip");
  if (cue.placement.mirror_y) vFilters.push("vflip");
  const cueRgbaIdx = vFilters.length;
  let cueUsesRgba = true;
  vFilters.push(cueColorSpec.isRgb ? "format=rgba" : BT709_TO_RGBA);

  const cueRotEnv = cue.envelopes.find((e) => e.parameter === "placement.rotation_deg");
  const cueRotExpr = compileEnvelopeToFfmpegExpr({
    envelope: cueRotEnv,
    timeBaseOffsetMs: 0,
    mode: "raw",
  });
  if (cueRotExpr) {
    const radExpr = `((${cueRotExpr})*PI/180)`;
    vFilters.push(`rotate=a='${radExpr}':ow='rotw(${radExpr})':oh='roth(${radExpr})':c=none`);
  } else if (Math.abs(cue.placement.rotation_deg) > 0.01) {
    const rad = ((cue.placement.rotation_deg * Math.PI) / 180).toFixed(4);
    vFilters.push(`rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`);
  }
  const cueOpEnv = cue.envelopes.find((e) => e.parameter === "placement.opacity");
  const cueOpExpr = compileEnvelopeToFfmpegExpr({
    envelope: cueOpEnv,
    timeBaseOffsetMs: 0,
    mode: "raw",
  });
  if (cueOpExpr) {
    const opExprT = cueOpExpr.replace(/\bt\b/g, "T");
    vFilters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*(${opExprT}),0,255)'`);
  } else if (cue.placement.opacity < 0.999) {
    vFilters.push(`colorchannelmixer=aa=${cue.placement.opacity.toFixed(3)}`);
  }
  // Opaque, full-frame, untransformed, envelope-less B-roll footage cues skip the RGBA round-trip.
  if (
    process.env.CUTHOL_EXP_NORGBA !== "0" &&
    !isStill &&
    !cueColorSpec.isRgb &&
    asset.kind === "footage" &&
    !/\.(?:png|webp|gif|mov)$/i.test(absAssetPath) &&
    cue.placement.fit_mode !== "contain" &&
    !cueRotExpr &&
    Math.abs(cue.placement.rotation_deg) <= 0.01 &&
    !cueOpExpr &&
    cue.placement.opacity >= 0.999 &&
    !cueHasDynScale &&
    !xEnv &&
    !yEnv &&
    !cue.envelopes.some((e) => e.parameter.startsWith("placement.")) &&
    targetW === renderWidth &&
    targetH === renderHeight &&
    Math.abs(cue.placement.scale_x - 1) < 1e-3 &&
    Math.abs(cue.placement.scale_y - 1) < 1e-3 &&
    Math.abs(cue.placement.x_pct) < 0.01 &&
    Math.abs(cue.placement.y_pct) < 0.01
  ) {
    vFilters.splice(cueRgbaIdx, 1);
    cueUsesRgba = false;
  }
  const sxPart = cueSxExpr ? `abs(${cueSxExpr})` : String(Math.abs(cue.placement.scale_x));
  const syPart = cueSyExpr ? `abs(${cueSyExpr})` : String(Math.abs(cue.placement.scale_y));
  vFilters.push(
    ...buildSubpixelScaleOrPanFilters({
      hasDynamicScale: cueHasDynScale,
      sxPart,
      syPart,
      xEnv,
      yEnv,
      staticXPct: cue.placement.x_pct,
      staticYPct: cue.placement.y_pct,
      baseCenterX,
      baseCenterY,
      renderWidth,
      renderHeight,
      localTimeExpr: `((in-1)/${fps})`,
    })
  );
  vFilters.push(
    cueUsesRgba || cueHasDynScale || xEnv || yEnv ? BT709_TO_YUVA420P : BT709_TO_YUV420P
  );
  const cueSpatialFilters = vFilters.slice(cueSpatialFilterStartIdx);
  vFilters.push(`settb=AVTB`, `setpts=PTS-STARTPTS+${cueStartSec}/TB`);
  if (activeWin && (cueStartMs < winLeadStartMs - 1e-3 || cueEndMs > winEndMs + 1e-3)) {
    vFilters.push(`trim=start=${winLeadStartSec}:end=${winEndPadSec}`);
  }

  const xExpr = cueHasDynScale
    ? cueRotExpr
      ? `(W-w)/2`
      : String(baseCenterX)
    : compileEnvelopeToFfmpegExpr({
        envelope: xEnv,
        timeBaseOffsetMs: cueStartMs,
        mode: "pixel_offset",
        baseCenterPx: baseCenterX,
        canvasDimPx: renderWidth,
      }) ??
      (cueRotExpr
        ? `(W-w)/2+${Math.round((cue.placement.x_pct / 100) * renderWidth)}`
        : String(Math.round(baseCenterX + (cue.placement.x_pct / 100) * renderWidth)));

  const yExpr = cueHasDynScale
    ? cueRotExpr
      ? `(H-h)/2`
      : String(baseCenterY)
    : compileEnvelopeToFfmpegExpr({
        envelope: yEnv,
        timeBaseOffsetMs: cueStartMs,
        mode: "pixel_offset",
        baseCenterPx: baseCenterY,
        canvasDimPx: renderHeight,
      }) ??
      (cueRotExpr
        ? `(H-h)/2+${Math.round((cue.placement.y_pct / 100) * renderHeight)}`
        : String(Math.round(baseCenterY + (cue.placement.y_pct / 100) * renderHeight)));

  return {
    vFilters,
    cueSpatialFilters,
    xExpr,
    yExpr,
  };
}

function compileAssetLaneCue(
  ctx: VideoGraphCompileContext,
  cue: LaneCueSpec,
  cueStartMs: number,
  cueEndMs: number,
  cueStartSec: string,
  cueEndSec: string,
  isCueInActiveWindow: boolean
): void {
  const { seq, paths, fps, compileOptions } = ctx;
  const asset = ctx.libMap.get(cue.asset_handle!);
  if (!asset) return;

  const absAssetPath = resolveLibraryItemPath(paths.rootDir, asset);
  const cueRate = getCuePlaybackRate(cue);
  const srcInMs = cue.source_in_ms ?? 0;
  // Always bound srcOutMs by both asset.probe.duration_ms and srcInMs + cue.duration_ms * cueRate
  const maxOutByDuration =
    cueRate === 1.0
      ? srcInMs + cue.duration_ms
      : srcInMs + Math.round(cue.duration_ms * cueRate);
  const requestedOut = cue.source_out_ms ?? maxOutByDuration;
  const srcOutMs = Math.min(maxSourceDurationMs(asset), requestedOut, maxOutByDuration);

  const isAudioOnlyKind =
    cue.kind === "music" || cue.kind === "sfx" || cue.kind === "voiceover";

  if (
    !isAudioOnlyKind &&
    asset.probe.has_video &&
    (cue.kind === "broll" || asset.kind === "graphic" || asset.kind === "footage")
  ) {
    const isStill = isStillGraphic(asset);
    const layerKind: DrawnVisualLayer["kind"] =
      isStill &&
      cue.envelopes.length === 0 &&
      Math.abs(cue.placement.rotation_deg) < 1e-3 &&
      cue.placement.opacity >= 0.999
        ? "still_graphic"
        : "moving";
    const drawnCueLayer: DrawnVisualLayer = {
      id: cue.id,
      startMs: cueStartMs,
      endMs: cueEndMs,
      kind: layerKind,
    };
    ctx.drawnVisualLayers.push(drawnCueLayer);
    if (!isCueInActiveWindow) {
      return;
    }

    const allowCueSeek =
      compileOptions?.singleFrameAtMs !== undefined ||
      asset.probe.duration_ms >= 180_000 ||
      seq.spine.clips.length > 24;
    const cueSeek = isStill
      ? null
      : buildSeekableMediaInput(
          absAssetPath,
          srcInMs,
          srcOutMs,
          asset.probe.duration_ms,
          allowCueSeek
        );
    const srcInSec = cueSeek ? cueSeek.localSrcInSec : (srcInMs / 1000).toFixed(3);
    const srcOutSec = cueSeek ? cueSeek.localSrcOutSec : (srcOutMs / 1000).toFixed(3);
    const inIdx = isStill
      ? ctx.addInput([
          "-loop",
          "1",
          "-framerate",
          String(fps),
          "-t",
          (cue.duration_ms / 1000 + 2 / fps).toFixed(3),
          "-i",
          absAssetPath,
        ])
      : ctx.addInput(cueSeek!.inputArgs);

    const { vFilters, cueSpatialFilters, xExpr, yExpr } = buildVisualAssetCueFilterChain(ctx, {
      cue,
      asset,
      absAssetPath,
      isStill,
      cueRate,
      srcInMs,
      srcOutMs,
      srcInSec,
      srcOutSec,
      cueStartMs,
      cueEndMs,
      cueStartSec,
    });

    const cuePad = `[v_cue_${cue.id}]`;
    ctx.filterChains.push(`[${inIdx}:v]${vFilters.join(",")}${cuePad}`);

    if (layerKind === "still_graphic") {
      drawnCueLayer.stillSpec = {
        id: cue.id,
        assetHandle: asset.handle,
        assetDigest: asset.digest_sha256,
        absAssetPath,
        spatialFilters: cueSpatialFilters,
        xExpr,
        yExpr,
      };
    }

    const nextPad = `[vc_${++ctx.vStepCounter}]`;
    ctx.filterChains.push(
      `${ctx.currentVideoPad}${cuePad}overlay=x='${xExpr}':y='${yExpr}':eval=frame:enable='between(t,${cueStartSec},${cueEndSec})':eof_action=pass,${BT709_SETPARAMS}${nextPad}`
    );
    ctx.currentVideoPad = nextPad;
  }
}

function compileLaneTypography(ctx: VideoGraphCompileContext, lane: LaneSpec): void {
  const { seq, paths, preset } = ctx;
  const laneAssHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ stage: seq.stage, spine: seq.spine.clips, lane }))
    .digest("hex")
    .slice(0, 8);
  const assOutFile = path.join(
    paths.blobsDir,
    `typography_r${seq.meta.revision}_${lane.id}_${preset}_${laneAssHash}.ass`
  );
  const assResult = compileTypographyAssFile(seq, assOutFile, new Set([lane.id]));
  if (assResult.hasTypographyCues) {
    const rotatedTypoCues = lane.cues.filter(
      (c) => Boolean(c.typography) && Math.abs(c.placement.rotation_deg) > 0.01
    );
    if (rotatedTypoCues.length > 0 && fs.existsSync(assResult.filePath)) {
      let assContent = fs.readFileSync(assResult.filePath, "utf8");
      for (const rc of rotatedTypoCues) {
        const assAngle = Number((-rc.placement.rotation_deg).toFixed(2));
        const stylePrefix = `Style: Style_${rc.id},`;
        assContent = assContent
          .split(/\r?\n/)
          .map((line) => {
            if (line.startsWith(stylePrefix)) {
              const parts = line.split(",");
              if (parts.length >= 14) {
                parts[13] = String(assAngle);
                return parts.join(",");
              }
            }
            if (line.includes(`,Style_${rc.id},`) && line.includes("{\\an5\\pos(")) {
              return line.replace(
                /\{\\an5\\pos\(([^)]+)\)\}/g,
                `{\\an5\\pos($1)\\frz${assAngle}}`
              );
            }
            return line;
          })
          .join("\r\n");
      }
      fs.writeFileSync(assResult.filePath, assContent, "utf8");
    }
    ctx.assFilePaths.push(assResult.filePath);
    const relAssPath = path.relative(paths.rootDir, assResult.filePath);
    const escapedAssPath = escapeFfmpegFilterPath(relAssPath);
    const nextPad = `[vc_${++ctx.vStepCounter}]`;
    ctx.filterChains.push(`${ctx.currentVideoPad}ass=filename=${escapedAssPath},${BT709_SETPARAMS}${nextPad}`);
    ctx.currentVideoPad = nextPad;
  }
}

export function compileLane(ctx: VideoGraphCompileContext, lane: LaneSpec): void {
  if (lane.muted) return;

  let laneHasTypography = false;
  const orderedCues = lane.cues.some((c) => c.z_index !== undefined)
    ? [...lane.cues].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0))
    : lane.cues;

  for (const cue of orderedCues) {
    const cueStartMs = resolveCueStartMs(ctx.seq, cue);
    const cueEndMs = cueStartMs + cue.duration_ms;
    const cueStartSec = (cueStartMs / 1000).toFixed(3);
    const cueEndSec = (cueEndMs / 1000).toFixed(3);
    const isCueInActiveWindow =
      !ctx.activeWin || (cueEndMs > ctx.winStartMs - 1e-3 && cueStartMs < ctx.winEndMs + 1e-3);

    if (cue.typography && cue.typography.text.trim()) {
      ctx.drawnVisualLayers.push({
        id: cue.id,
        startMs: cueStartMs,
        endMs: cueEndMs,
        kind: "moving",
      });
      if (isCueInActiveWindow) {
        laneHasTypography = true;
      }
    }

    // 2a. HyperFrames Composition Cue
    if (cue.kind === "composition" && cue.composition) {
      compileCompositionLaneCue(
        ctx,
        cue,
        cueStartMs,
        cueEndMs,
        cueStartSec,
        cueEndSec,
        isCueInActiveWindow
      );
      continue;
    }

    // 2b. Asset-Backed Lane Cue (B-roll, Graphic, Music, SFX, Voiceover)
    if (cue.asset_handle) {
      compileAssetLaneCue(
        ctx,
        cue,
        cueStartMs,
        cueEndMs,
        cueStartSec,
        cueEndSec,
        isCueInActiveWindow
      );
    }
  }

  // Compile and apply typography for this lane right at its `z_index` level,
  // keeping native `seq.stage.width x seq.stage.height` PlayResX/Y so libass scales outlines/margins accurately!
  if (laneHasTypography && !isOverlayCollectActive()) {
    compileLaneTypography(ctx, lane);
  }
}
