// Per-clip spine filter-graph compilation: source input, speed, transforms, envelopes, and transitions (split out of compiler.ts).
import { CutholSequence, isStillGraphic, TransitionSpec } from "../core/schema.js";
import { resolveLibraryItemPath, resolveSourceColorSpec } from "../library/probe.js";
import {
  BT709_TO_YUV420P,
  buildSourceScaleFilter,
  BT709_TO_RGBA,
  BT709_TO_YUVA420P,
  BT709_SETPARAMS,
} from "./compile_color.js";
import {
  compileEnvelopeToFfmpegExpr,
  buildSubpixelScaleOrPanFilters,
  buildSeekableMediaInput,
} from "./compile_filters.js";
import type { DrawnVisualLayer, VideoGraphCompileContext } from "./compiler.js";

type SpineClipSpec = CutholSequence["spine"]["clips"][number];
type EnvelopeSpec = SpineClipSpec["envelopes"][number];

function buildSpineClipFilterChain(
  ctx: VideoGraphCompileContext,
  params: {
    i: number;
    clip: SpineClipSpec;
    asset: CutholSequence["library"][number];
    absAssetPath: string;
    isStill: boolean;
    inIdx: number;
    srcInSec: string;
    srcOutSec: string;
    tlInSec: string;
    clipStartMs: number;
    clipEndMs: number;
    effectiveRate: number;
    hasNextClip: boolean;
    outTrans: TransitionSpec | null;
    incomingTransition: TransitionSpec | null;
  }
): {
  clipPad: string;
  spHasDynScale: boolean;
  spRotExpr: string | null;
  xEnv: EnvelopeSpec | undefined;
  yEnv: EnvelopeSpec | undefined;
  baseCenterX: number;
  baseCenterY: number;
  spSpatialFilters: string[];
} {
  const {
    seq,
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
    i,
    clip,
    asset,
    absAssetPath,
    isStill,
    inIdx,
    srcInSec,
    srcOutSec,
    tlInSec,
    clipStartMs,
    clipEndMs,
    effectiveRate,
    hasNextClip,
    outTrans,
    incomingTransition,
  } = params;

  const spSxEnv = clip.envelopes.find((e) => e.parameter === "placement.scale_x");
  const spSyEnv = clip.envelopes.find((e) => e.parameter === "placement.scale_y");
  const spSxExpr = compileEnvelopeToFfmpegExpr({ envelope: spSxEnv, timeBaseOffsetMs: 0, mode: "raw" });
  const spSyExpr = compileEnvelopeToFfmpegExpr({ envelope: spSyEnv, timeBaseOffsetMs: 0, mode: "raw" });
  const isZoomInIncoming =
    incomingTransition !== null &&
    incomingTransition.duration_ms > 0 &&
    incomingTransition.kind === "zoom_in";
  const spHasDynScale = Boolean(spSxExpr || spSyExpr || isZoomInIncoming);
  const xEnv = clip.envelopes.find((e) => e.parameter === "placement.x_pct");
  const yEnv = clip.envelopes.find((e) => e.parameter === "placement.y_pct");

  const targetW = spHasDynScale
    ? renderWidth
    : Math.max(8, Math.round((renderWidth * Math.abs(clip.placement.scale_x)) / 2) * 2);
  const targetH = spHasDynScale
    ? renderHeight
    : Math.max(8, Math.round((renderHeight * Math.abs(clip.placement.scale_y)) / 2) * 2);
  const spRadAbs = (Math.abs(clip.placement.rotation_deg) * Math.PI) / 180;
  const spEffW =
    Math.abs(clip.placement.rotation_deg) > 0.01
      ? Math.round(targetW * Math.abs(Math.cos(spRadAbs)) + targetH * Math.abs(Math.sin(spRadAbs)))
      : targetW;
  const spEffH =
    Math.abs(clip.placement.rotation_deg) > 0.01
      ? Math.round(targetW * Math.abs(Math.sin(spRadAbs)) + targetH * Math.abs(Math.cos(spRadAbs)))
      : targetH;
  const baseCenterX = Math.round((renderWidth - spEffW) / 2);
  const baseCenterY = Math.round((renderHeight - spEffH) / 2);

  const srcFps = Math.max(1, asset.probe.fps || fps);
  const rawSrcSpanSec = Math.max(0, (clip.source_out_ms - clip.source_in_ms) / 1000);
  const scaledSrcSpanSec = rawSrcSpanSec / effectiveRate;
  const clipDurSec = clip.duration_ms / 1000;
  const tailPadSec = isStill
    ? (clipDurSec + 2 / fps).toFixed(3)
    : Math.max(
        0.1,
        Math.max(0, clipDurSec - scaledSrcSpanSec) + 3 / (srcFps * effectiveRate) + 2 / fps
      ).toFixed(3);

  const needsPreTrimEofPad =
    !isStill &&
    asset.probe.duration_ms > 0 &&
    clip.source_out_ms >= Math.max(0, asset.probe.duration_ms - 5000);
  const vFilters: string[] = [
    `settb=AVTB`,
    ...(needsPreTrimEofPad ? [`tpad=stop_mode=clone:stop_duration=3.000`] : []),
    `trim=start=${srcInSec}:end=${srcOutSec}`,
    `setpts=(PTS-STARTPTS)/${effectiveRate.toFixed(4)}`,
    `fps=${fps}:eof_action=pass`,
    `tpad=stop_mode=clone:stop_duration=${tailPadSec}`,
  ];
  const spSpatialFilterStartIdx = vFilters.length;
  const clipColorSpec = resolveSourceColorSpec(asset.probe, absAssetPath);
  if (clipColorSpec.isRgb) {
    vFilters.push("format=rgba");
  }

  // Apply crop if configured
  if (clip.placement.crop) {
    const cr = clip.placement.crop;
    const wRatio = Math.max(0.05, 1 - (cr.left_pct + cr.right_pct) / 100).toFixed(4);
    const hRatio = Math.max(0.05, 1 - (cr.top_pct + cr.bottom_pct) / 100).toFixed(4);
    const xRatio = (cr.left_pct / 100).toFixed(4);
    const yRatio = (cr.top_pct / 100).toFixed(4);
    vFilters.push(`crop=w=iw*${wRatio}:h=ih*${hRatio}:x=iw*${xRatio}:y=ih*${yRatio}`);
  }

  if (clip.placement.fit_mode === "contain") {
    vFilters.push(
      buildSourceScaleFilter(targetW, targetH, clipColorSpec, "decrease"),
      `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black@0`
    );
  } else if (clip.placement.fit_mode === "cover") {
    vFilters.push(
      buildSourceScaleFilter(targetW, targetH, clipColorSpec, "increase"),
      `crop=${targetW}:${targetH}`
    );
  } else {
    vFilters.push(buildSourceScaleFilter(targetW, targetH, clipColorSpec));
  }

  if (clip.placement.mirror_x) vFilters.push("hflip");
  if (clip.placement.mirror_y) vFilters.push("vflip");

  const cg = clip.treatments.color_grade;
  if (cg.brightness !== 0 || cg.contrast !== 1 || cg.saturation !== 1) {
    vFilters.push(
      `eq=brightness=${cg.brightness.toFixed(2)}:contrast=${cg.contrast.toFixed(2)}:saturation=${cg.saturation.toFixed(2)}`
    );
  }

  let spRgbaIdx = -1;
  let spUsesRgba = true;
  if (clip.treatments.cutout.mode === "chroma" && clip.treatments.cutout.chroma_key_hex) {
    const keyColor = clip.treatments.cutout.chroma_key_hex.replace(/^#/, "0x");
    const toRgbaStep = clipColorSpec.isRgb ? "format=rgba" : BT709_TO_RGBA;
    vFilters.push(
      `${toRgbaStep},colorkey=${keyColor}:${clip.treatments.cutout.similarity.toFixed(2)}:${clip.treatments.cutout.blend.toFixed(2)}`
    );
  } else {
    spRgbaIdx = vFilters.length;
    vFilters.push(clipColorSpec.isRgb ? "format=rgba" : BT709_TO_RGBA);
  }

  // Apply rotation_deg / envelopes with dynamic output bounding box
  const spRotEnv = clip.envelopes.find((e) => e.parameter === "placement.rotation_deg");
  const spRotExpr = compileEnvelopeToFfmpegExpr({
    envelope: spRotEnv,
    timeBaseOffsetMs: 0,
    mode: "raw",
  });
  if (spRotExpr) {
    const radExpr = `((${spRotExpr})*PI/180)`;
    vFilters.push(`rotate=a='${radExpr}':ow='rotw(${radExpr})':oh='roth(${radExpr})':c=none`);
  } else if (Math.abs(clip.placement.rotation_deg) > 0.01) {
    const rad = ((clip.placement.rotation_deg * Math.PI) / 180).toFixed(4);
    vFilters.push(`rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`);
  }

  const spOpEnv = clip.envelopes.find((e) => e.parameter === "placement.opacity");
  const spOpExpr = compileEnvelopeToFfmpegExpr({
    envelope: spOpEnv,
    timeBaseOffsetMs: 0,
    mode: "raw",
  });
  if (spOpExpr) {
    const opExprT = spOpExpr.replace(/\bt\b/g, "T");
    vFilters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*(${opExprT}),0,255)'`);
  } else if (clip.placement.opacity < 0.999) {
    vFilters.push(`colorchannelmixer=aa=${clip.placement.opacity.toFixed(3)}`);
  }

  return appendSpineClipTransitionsAndScale(ctx, {
    i,
    clip,
    asset,
    absAssetPath,
    isStill,
    inIdx,
    tlInSec,
    clipStartMs,
    clipEndMs,
    hasNextClip,
    outTrans,
    incomingTransition,
    isZoomInIncoming,
    spSxExpr,
    spSyExpr,
    spHasDynScale,
    spRotExpr,
    spOpExpr,
    xEnv,
    yEnv,
    baseCenterX,
    baseCenterY,
    vFilters,
    spSpatialFilterStartIdx,
    clipColorSpec,
    spRgbaIdx,
    spUsesRgba,
  });
}

function appendSpineClipTransitionsAndScale(
  ctx: VideoGraphCompileContext,
  params: {
    i: number;
    clip: SpineClipSpec;
    asset: CutholSequence["library"][number];
    absAssetPath: string;
    isStill: boolean;
    inIdx: number;
    tlInSec: string;
    clipStartMs: number;
    clipEndMs: number;
    hasNextClip: boolean;
    outTrans: TransitionSpec | null;
    incomingTransition: TransitionSpec | null;
    isZoomInIncoming: boolean;
    spSxExpr: string | null;
    spSyExpr: string | null;
    spHasDynScale: boolean;
    spRotExpr: string | null;
    spOpExpr: string | null;
    xEnv: EnvelopeSpec | undefined;
    yEnv: EnvelopeSpec | undefined;
    baseCenterX: number;
    baseCenterY: number;
    vFilters: string[];
    spSpatialFilterStartIdx: number;
    clipColorSpec: ReturnType<typeof resolveSourceColorSpec>;
    spRgbaIdx: number;
    spUsesRgba: boolean;
  }
): {
  clipPad: string;
  spHasDynScale: boolean;
  spRotExpr: string | null;
  xEnv: EnvelopeSpec | undefined;
  yEnv: EnvelopeSpec | undefined;
  baseCenterX: number;
  baseCenterY: number;
  spSpatialFilters: string[];
} {
  const {
    seq,
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
    i,
    clip,
    asset,
    absAssetPath,
    isStill,
    inIdx,
    tlInSec,
    clipStartMs,
    clipEndMs,
    hasNextClip,
    outTrans,
    incomingTransition,
    isZoomInIncoming,
    spSxExpr,
    spSyExpr,
    spHasDynScale,
    spRotExpr,
    spOpExpr,
    xEnv,
    yEnv,
    baseCenterX,
    baseCenterY,
    vFilters,
    spSpatialFilterStartIdx,
    clipColorSpec,
    spRgbaIdx,
  } = params;
  let { spUsesRgba } = params;

  // Handle outgoing & incoming transitions cleanly without Porter-Duff alpha dip
  const nextClip = hasNextClip ? seq.spine.clips[i + 1] : null;
  const nextCoversStage =
    nextClip !== null &&
    outTrans?.kind !== "zoom_in" &&
    Math.abs(nextClip.placement.scale_x) >= 0.999 &&
    Math.abs(nextClip.placement.scale_y) >= 0.999 &&
    Math.abs(nextClip.placement.x_pct) < 0.01 &&
    Math.abs(nextClip.placement.y_pct) < 0.01 &&
    Math.abs(nextClip.placement.rotation_deg) < 0.01 &&
    !nextClip.placement.crop &&
    nextClip.placement.fit_mode !== "contain" &&
    nextClip.placement.opacity >= 0.999 &&
    !nextClip.envelopes.some(
      (e) =>
        e.parameter === "placement.scale_x" ||
        e.parameter === "placement.scale_y" ||
        e.parameter === "placement.x_pct" ||
        e.parameter === "placement.y_pct" ||
        e.parameter === "placement.rotation_deg" ||
        e.parameter === "placement.opacity"
    );

  if (outTrans && outTrans.duration_ms > 0) {
    const fadeDurSec = (outTrans.duration_ms / 1000).toFixed(3);
    if (!hasNextClip || outTrans.kind === "fade") {
      const fadeStartSec = Math.max(0, (clip.duration_ms - outTrans.duration_ms) / 1000).toFixed(3);
      vFilters.push(`fade=t=out:st=${fadeStartSec}:d=${fadeDurSec}:alpha=1`);
    } else if (nextCoversStage) {
      // Hold last frame at 100% alpha under full-frame incoming next clip so total opacity stays 1.0 (zero backdrop bleed)
      vFilters.push(`tpad=stop_mode=clone:stop_duration=${fadeDurSec}`);
    } else {
      const holdFadeStartSec = (clip.duration_ms / 1000).toFixed(3);
      vFilters.push(
        `tpad=stop_mode=clone:stop_duration=${fadeDurSec}`,
        `fade=t=out:st=${holdFadeStartSec}:d=${fadeDurSec}:alpha=1`
      );
    }
  }

  if (incomingTransition && incomingTransition.duration_ms > 0) {
    const inDurSec = (incomingTransition.duration_ms / 1000).toFixed(3);
    if (
      incomingTransition.kind === "dissolve" ||
      incomingTransition.kind === "fade" ||
      incomingTransition.kind === "zoom_in"
    ) {
      vFilters.push(`fade=t=in:st=0:d=${inDurSec}:alpha=1`);
    }
  }

  const inDurSec = incomingTransition ? (incomingTransition.duration_ms / 1000).toFixed(3) : "0.001";
  const zoomFactor = isZoomInIncoming
    ? `if(lt(t,${inDurSec}),0.88+0.12*(t/${inDurSec}),1)`
    : "1";
  const sxPart = spSxExpr
    ? isZoomInIncoming
      ? `abs(${spSxExpr})*(${zoomFactor})`
      : `abs(${spSxExpr})`
    : isZoomInIncoming
      ? `${Math.abs(clip.placement.scale_x)}*(${zoomFactor})`
      : String(Math.abs(clip.placement.scale_x));
  const syPart = spSyExpr
    ? isZoomInIncoming
      ? `abs(${spSyExpr})*(${zoomFactor})`
      : `abs(${spSyExpr})`
    : isZoomInIncoming
      ? `${Math.abs(clip.placement.scale_y)}*(${zoomFactor})`
      : String(Math.abs(clip.placement.scale_y));

  // Opaque, full-frame, untransformed, transition-less, envelope-less footage spine clips skip the RGBA round-trip.
  if (
    process.env.CUTHOL_EXP_NORGBA !== "0" &&
    spRgbaIdx >= 0 &&
    !isStill &&
    !clipColorSpec.isRgb &&
    asset.kind === "footage" &&
    !/\.(?:png|webp|gif|mov)$/i.test(absAssetPath) &&
    clip.placement.fit_mode !== "contain" &&
    !spRotExpr &&
    Math.abs(clip.placement.rotation_deg) <= 0.01 &&
    !spOpExpr &&
    clip.placement.opacity >= 0.999 &&
    !(outTrans && outTrans.duration_ms > 0) &&
    !(incomingTransition && incomingTransition.duration_ms > 0) &&
    !spHasDynScale &&
    !xEnv &&
    !yEnv &&
    !clip.envelopes.some((e) => e.parameter.startsWith("placement.")) &&
    Math.abs(clip.placement.scale_x - 1) < 1e-3 &&
    Math.abs(clip.placement.scale_y - 1) < 1e-3 &&
    Math.abs(clip.placement.x_pct) < 0.01 &&
    Math.abs(clip.placement.y_pct) < 0.01
  ) {
    vFilters.splice(spRgbaIdx, 1);
    spUsesRgba = false;
  }

  vFilters.push(
    ...buildSubpixelScaleOrPanFilters({
      hasDynamicScale: spHasDynScale,
      sxPart,
      syPart,
      xEnv,
      yEnv,
      staticXPct: clip.placement.x_pct,
      staticYPct: clip.placement.y_pct,
      baseCenterX,
      baseCenterY,
      renderWidth,
      renderHeight,
      localTimeExpr: `((in-1)/${fps})`,
    })
  );
  vFilters.push(
    spUsesRgba || spHasDynScale || xEnv || yEnv ? BT709_TO_YUVA420P : BT709_TO_YUV420P
  );

  const spSpatialFilters = vFilters.slice(spSpatialFilterStartIdx);
  vFilters.push(`settb=AVTB`, `setpts=PTS+${tlInSec}/TB`);
  if (activeWin && (clipStartMs < winLeadStartMs - 1e-3 || clipEndMs > winEndMs + 1e-3)) {
    vFilters.push(`trim=start=${winLeadStartSec}:end=${winEndPadSec}`);
  }

  const clipPad = `[v_sp_${i}]`;
  ctx.filterChains.push(`[${inIdx}:v]${vFilters.join(",")}${clipPad}`);

  return {
    clipPad,
    spHasDynScale,
    spRotExpr,
    xEnv,
    yEnv,
    baseCenterX,
    baseCenterY,
    spSpatialFilters,
  };
}

function overlaySpineClip(
  ctx: VideoGraphCompileContext,
  params: {
    clip: SpineClipSpec;
    asset: CutholSequence["library"][number];
    absAssetPath: string;
    tlInSec: string;
    tlOutSec: string;
    incomingTransition: TransitionSpec | null;
    isStaticStillClip: boolean;
    drawnSpineLayer: DrawnVisualLayer;
    clipPad: string;
    spHasDynScale: boolean;
    spRotExpr: string | null;
    xEnv: EnvelopeSpec | undefined;
    yEnv: EnvelopeSpec | undefined;
    baseCenterX: number;
    baseCenterY: number;
    spSpatialFilters: string[];
  }
): void {
  const { renderWidth, renderHeight } = ctx;
  const {
    clip,
    asset,
    absAssetPath,
    tlInSec,
    tlOutSec,
    incomingTransition,
    isStaticStillClip,
    drawnSpineLayer,
    clipPad,
    spHasDynScale,
    spRotExpr,
    xEnv,
    yEnv,
    baseCenterX,
    baseCenterY,
    spSpatialFilters,
  } = params;

  let xExpr = spHasDynScale
    ? spRotExpr
      ? `(W-w)/2`
      : String(baseCenterX)
    : compileEnvelopeToFfmpegExpr({
        envelope: xEnv,
        timeBaseOffsetMs: clip.timeline_in_ms,
        mode: "pixel_offset",
        baseCenterPx: baseCenterX,
        canvasDimPx: renderWidth,
      }) ??
      (spRotExpr
        ? `(W-w)/2+${Math.round((clip.placement.x_pct / 100) * renderWidth)}`
        : String(Math.round(baseCenterX + (clip.placement.x_pct / 100) * renderWidth)));

  let yExpr = spHasDynScale
    ? spRotExpr
      ? `(H-h)/2`
      : String(baseCenterY)
    : compileEnvelopeToFfmpegExpr({
        envelope: yEnv,
        timeBaseOffsetMs: clip.timeline_in_ms,
        mode: "pixel_offset",
        baseCenterPx: baseCenterY,
        canvasDimPx: renderHeight,
      }) ??
      (spRotExpr
        ? `(H-h)/2+${Math.round((clip.placement.y_pct / 100) * renderHeight)}`
        : String(Math.round(baseCenterY + (clip.placement.y_pct / 100) * renderHeight)));

  if (isStaticStillClip) {
    drawnSpineLayer.stillSpec = {
      id: clip.id,
      assetHandle: asset.handle,
      assetDigest: asset.digest_sha256,
      absAssetPath,
      spatialFilters: spSpatialFilters,
      xExpr,
      yExpr,
    };
  }

  // Animate incoming wipe_left / wipe_right / slide_up transitions
  if (incomingTransition && incomingTransition.duration_ms > 0) {
    const t0 = Number((clip.timeline_in_ms / 1000).toFixed(3));
    const dt = Number((incomingTransition.duration_ms / 1000).toFixed(3));
    const t1 = Number((t0 + dt).toFixed(3));
    if (incomingTransition.kind === "wipe_left") {
      xExpr = `if(lt(t,${t1}),${renderWidth}-${renderWidth}*(t-${t0})/${dt},${xExpr})`;
    } else if (incomingTransition.kind === "wipe_right") {
      xExpr = `if(lt(t,${t1}),-${renderWidth}+${renderWidth}*(t-${t0})/${dt},${xExpr})`;
    } else if (incomingTransition.kind === "slide_up") {
      yExpr = `if(lt(t,${t1}),${renderHeight}-${renderHeight}*(t-${t0})/${dt},${yExpr})`;
    }
  }

  const nextPad = `[vc_${++ctx.vStepCounter}]`;
  ctx.filterChains.push(
    `${ctx.currentVideoPad}${clipPad}overlay=x='${xExpr}':y='${yExpr}':eval=frame:enable='between(t,${tlInSec},${tlOutSec})':eof_action=pass,${BT709_SETPARAMS}${nextPad}`
  );
  ctx.currentVideoPad = nextPad;
}

export function compileSpineClip(ctx: VideoGraphCompileContext, i: number): void {
  const { seq, paths, fps, compileOptions, activeWin, winStartMs, winEndMs } = ctx;
  const clip = seq.spine.clips[i];
  const prevClip = i > 0 ? seq.spine.clips[i - 1] : null;
  const incomingTransition: TransitionSpec | null = prevClip?.transition_out ?? null;

  const asset = ctx.libMap.get(clip.asset_handle);
  if (!asset || !asset.probe.has_video) return;

  // If this clip has a cross-transition (`dissolve`, `wipe_left`, `wipe_right`, `slide_up`, `zoom_in`)
  // into `clips[i+1]`, hold its final frame under `clips[i+1]` during the transition duration so there is ZERO dip to backdrop!
  const hasNextClip = i < seq.spine.clips.length - 1;
  const outTrans = clip.transition_out;
  const holdTailMs =
    hasNextClip && outTrans && outTrans.kind !== "fade" ? outTrans.duration_ms : 0;

  const clipStartMs = clip.timeline_in_ms;
  const clipEndMs = clip.timeline_in_ms + clip.duration_ms + holdTailMs;
  const isStaticStillClip =
    isStillGraphic(asset) &&
    clip.envelopes.length === 0 &&
    (!clip.transition_out || clip.transition_out.duration_ms <= 0) &&
    (!incomingTransition || incomingTransition.duration_ms <= 0);
  const drawnSpineLayer: DrawnVisualLayer = {
    id: clip.id,
    startMs: clipStartMs,
    endMs: clipEndMs,
    kind: isStaticStillClip ? "still_graphic" : "moving",
  };
  ctx.drawnVisualLayers.push(drawnSpineLayer);

  if (activeWin && (clipEndMs <= winStartMs - 1e-3 || clipStartMs >= winEndMs + 1e-3)) {
    return;
  }

  const absAssetPath = resolveLibraryItemPath(paths.rootDir, asset);
  const isStill = isStillGraphic(asset);
  const allowClipSeek =
    compileOptions?.singleFrameAtMs !== undefined ||
    asset.probe.duration_ms >= 180_000 ||
    seq.spine.clips.length > 24;
  const clipSeek = isStill
    ? null
    : buildSeekableMediaInput(
        absAssetPath,
        clip.source_in_ms,
        clip.source_out_ms,
        asset.probe.duration_ms,
        allowClipSeek
      );
  // A still image is a single frame: loop it so it covers the whole source range of the clip.
  const inIdx = isStill
    ? ctx.addInput([
        "-loop",
        "1",
        "-framerate",
        String(fps),
        "-t",
        (clip.source_out_ms / 1000 + 2 / fps).toFixed(3),
        "-i",
        absAssetPath,
      ])
    : ctx.addInput(clipSeek!.inputArgs);

  const srcInSec = clipSeek ? clipSeek.localSrcInSec : (clip.source_in_ms / 1000).toFixed(3);
  const srcOutSec = clipSeek ? clipSeek.localSrcOutSec : (clip.source_out_ms / 1000).toFixed(3);
  const tlInSec = (clip.timeline_in_ms / 1000).toFixed(3);
  const tlOutSec = (clipEndMs / 1000).toFixed(3);

  // Compute effectiveRate from integrated `clip.duration_ms` so speed_ramp durations match exactly
  const effectiveRate = Math.max(
    0.1,
    Math.min(16.0, (clip.source_out_ms - clip.source_in_ms) / Math.max(1, clip.duration_ms))
  );

  const filterResult = buildSpineClipFilterChain(ctx, {
    i,
    clip,
    asset,
    absAssetPath,
    isStill,
    inIdx,
    srcInSec,
    srcOutSec,
    tlInSec,
    clipStartMs,
    clipEndMs,
    effectiveRate,
    hasNextClip,
    outTrans,
    incomingTransition,
  });

  overlaySpineClip(ctx, {
    clip,
    asset,
    absAssetPath,
    tlInSec,
    tlOutSec,
    incomingTransition,
    isStaticStillClip,
    drawnSpineLayer,
    ...filterResult,
  });
}
