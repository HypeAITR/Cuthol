/**
 * HyperFrames Composition Bridge, Contract Validator & Renderer (`src/compositor/hyperframes_bridge.ts`).
 *
 * Bridges Cuthol's `composition` lane cues with the HyperFrames HTML/GSAP engine:
 * 1. `scaffoldHyperFramesComposition`: Creates deterministic, offline-self-contained
 *    HyperFrames compositions (with local `assets/gsap.min.js`, zero CDN/Math.random/Date.now,
 *    and strict adherence to `/hyperframes-core` rules).
 * 2. `validateHyperFramesCompositionContract`: Audits a composition directory for
 *    `/hyperframes-core` contract compliance (`data-composition-id` matching `window.__timelines`,
 *    no `<head><style>` in `<template>` sub-compositions, no `gsap_css_transform_conflict`, etc.)
 *    plus optional `npx hyperframes lint`.
 * 3. `renderHyperFramesCompositionToMp4`: Content-addressed (`SHA-256`) rendering of a
 *    HyperFrames composition into `.cuthol/blobs/hf_<hash>.mp4` via `npx hyperframes render`.
 */

export { isNvencHardwareAvailable, shouldUseNvencForRender } from "./hf_common.js";
export type { HyperFramesPresetKind, HyperFramesScaffoldOptions, HyperFramesValidationResult, HyperFramesLintFinding, HyperFramesLintResult } from "./hf_common.js";
export { isDuplicateImgMediaDiscoveryFinding, lintHyperFramesComposition } from "./hf_lint.js";
export { scaffoldHyperFramesComposition, validateHyperFramesCompositionContract, detectSceneHostFeaturesInComposition } from "./hf_scaffold.js";
export { parseHyperFramesPipelineSummary, beginOverlayRenderTracking, setOverlayRenderExecutionMeta, finishOverlayRenderTracking, beginOverlayCollect, isOverlayCollectActive, hasPendingCollectedOverlayForPaths, runCollectedOverlays } from "./hf_overlay_tracking.js";
export type { OverlayCacheReason, HyperFramesPipelineSummaryInfo, OverlayRenderItemSummary, RenderOverlaySummary } from "./hf_overlay_tracking.js";
export { isPngSequenceBlobDir, inspectPngSequenceDir, isValidVideoBlobOnDisk } from "./hf_blobs.js";
export type { OverlayBlobExt } from "./hf_blobs.js";
export { renderHyperFramesCompositionToMp4, isDraftNativeOverlayCapture } from "./hf_render.js";
export { resolveFramePngInPngSequenceDir, renderHyperFramesSingleFramePng, renderHyperFramesBatchFramesPng, recordCompositionAlphaBboxSidecar } from "./hf_frames.js";
export type { MeasuredAlphaBboxPct } from "./hf_frames.js";

