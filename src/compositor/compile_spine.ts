// Per-clip spine filter-graph compilation: source input, speed, transforms, envelopes, and transitions (split out of compiler.ts).
//
// Clip chain stage order (each stage lives in its own module):
//   1. timing      compile_spine_timing.ts      trim, rate / speed ramp, fps, tail pad
//   2. geometry    (here)                       crop, fit (contain/cover/fill) scale, mirror
//   3. colour      compile_spine_color.ts       color_grade, colour envelopes, LUT, temperature
//   4. fx          compile_spine_fx.ts          per-clip effect chain (`clip.fx`, built-in or extension)
//   5. alpha       (here)                       chroma cutout or RGBA conversion, rotation, opacity
//   6. transitions compile_spine_transition.ts  outgoing then incoming filters
//   7. edge        compile_spine_edge.ts        `placement.edge` fill before the clip is moved
//   8. scale/pan   compile_filters.ts           sub-pixel scale / pan, output pixel format, timeline offset
// The overlay position is built in overlaySpineClip: base x/y → edge hook (compile_spine_edge.ts) → still-image spec
// → incoming transition position → outgoing transition position (compile_spine_transition.ts).
import { CutholSequence, isStillGraphic, TransitionSpec } from "../core/schema.js";
import { buildSpineClipTimingFilters, computeSpineClipEffectiveRate } from "./compile_spine_timing.js";
import { buildSpineClipColorFilters } from "./compile_spine_color.js";
import { buildSpineClipFxFilters } from "./compile_spine_fx.js";
import {
  applySpineClipEdgeToOverlay,
  buildSpineClipEdgeFilters,
  spineClipEdgeRequiresRgba,
} from "./compile_spine_edge.js";
import {
  applyIncomingTransitionPosition,
  applyOutgoingTransitionPosition,
  buildIncomingTransitionFilters,
  buildOutgoingTransitionFilters,
  incomingTransitionScaleFactor,
  transitionHoldTailMs,
} from "./compile_spine_transition.js";
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
  const incomingScaleFactor = incomingTransitionScaleFactor(incomingTransition);
  const spHasDynScale = Boolean(spSxExpr || spSyExpr || incomingScaleFactor);
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

  // Stage 1: timing
  const vFilters: string[] = buildSpineClipTimingFilters({
    clip,
    asset,
    isStill,
    fps,
    srcInSec,
    srcOutSec,
    effectiveRate,
  });
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

  // Stage 3: colour
  vFilters.push(...buildSpineClipColorFilters(ctx, { clip, asset, absAssetPath, clipColorSpec }));
  // Stage 4: per-clip fx chain
  vFilters.push(
    ...buildSpineClipFxFilters(ctx, { clip, asset, absAssetPath, clipColorSpec, targetW, targetH })
  );

  // Stage 5: alpha
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
    incomingScaleFactor,
    spSxExpr,
    spSyExpr,
    spHasDynScale,
    spRotExpr,
    spOpExpr,
    xEnv,
    yEnv,
    baseCenterX,
    baseCenterY,
    targetW,
    targetH,
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
    incomingScaleFactor: string | null;
    spSxExpr: string | null;
    spSyExpr: string | null;
    spHasDynScale: boolean;
    spRotExpr: string | null;
    spOpExpr: string | null;
    xEnv: EnvelopeSpec | undefined;
    yEnv: EnvelopeSpec | undefined;
    baseCenterX: number;
    baseCenterY: number;
    targetW: number;
    targetH: number;
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
    incomingScaleFactor,
    spSxExpr,
    spSyExpr,
    spHasDynScale,
    spRotExpr,
    spOpExpr,
    xEnv,
    yEnv,
    baseCenterX,
    baseCenterY,
    targetW,
    targetH,
    vFilters,
    spSpatialFilterStartIdx,
    clipColorSpec,
    spRgbaIdx,
  } = params;
  let { spUsesRgba } = params;

  // Stage 6: transitions (outgoing, then incoming) — without Porter-Duff alpha dip
  vFilters.push(...buildOutgoingTransitionFilters(ctx, { i, clip, hasNextClip, outTrans }));
  vFilters.push(...buildIncomingTransitionFilters(ctx, { clip, incomingTransition }));

  const sxPart = spSxExpr
    ? incomingScaleFactor
      ? `abs(${spSxExpr})*(${incomingScaleFactor})`
      : `abs(${spSxExpr})`
    : incomingScaleFactor
      ? `${Math.abs(clip.placement.scale_x)}*(${incomingScaleFactor})`
      : String(Math.abs(clip.placement.scale_x));
  const syPart = spSyExpr
    ? incomingScaleFactor
      ? `abs(${spSyExpr})*(${incomingScaleFactor})`
      : `abs(${spSyExpr})`
    : incomingScaleFactor
      ? `${Math.abs(clip.placement.scale_y)}*(${incomingScaleFactor})`
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
    Math.abs(clip.placement.y_pct) < 0.01 &&
    !spineClipEdgeRequiresRgba(clip)
  ) {
    vFilters.splice(spRgbaIdx, 1);
    spUsesRgba = false;
  }

  // Stage 7: edge mode
  vFilters.push(
    ...buildSpineClipEdgeFilters(ctx, { clip, targetW, targetH, hasDynamicScale: spHasDynScale })
  );

  // Stage 8: scale / pan
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
    hasNextClip: boolean;
    outTrans: TransitionSpec | null;
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
    hasNextClip,
    outTrans,
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

  // Edge mode may change the drawn frame size / content offset
  ({ xExpr, yExpr } = applySpineClipEdgeToOverlay(ctx, { clip, xExpr, yExpr, hasDynamicScale: spHasDynScale }));

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

  // Incoming position-based transitions (wipe / slide)
  ({ xExpr, yExpr } = applyIncomingTransitionPosition(ctx, { clip, incomingTransition, xExpr, yExpr }));
  // Outgoing position-based transitions (extension kinds, e.g. a push)
  ({ xExpr, yExpr } = applyOutgoingTransitionPosition(ctx, { clip, hasNextClip, outTrans, xExpr, yExpr }));

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
  const holdTailMs = transitionHoldTailMs(clip, hasNextClip);

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
  const effectiveRate = computeSpineClipEffectiveRate(clip);

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
    hasNextClip,
    outTrans,
    incomingTransition,
    isStaticStillClip,
    drawnSpineLayer,
    ...filterResult,
  });
}
