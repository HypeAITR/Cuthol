/**
 * Cuthol Sequence Video/Audio Render Engine (`src/render/renderer.ts`).
 *
 * Executes a `CompiledRenderPlan` via FFmpeg 8.1 to produce either a delivery MP4
 * (`master_1080p`) or a fast inspection proxy (`draft_480p`).
 */

export { scanRenderedMp4ForEdgeStrips, scanRenderedMp4ForBlankFrames } from "./render_scan.js";
export type { BlankFrameEvent, PostRenderBlankScanResult } from "./render_scan.js";
export { scanRenderedMp4AudioHealth } from "./render_audio_health.js";
export type { AudioHealthCheckPoint, PostRenderAudioHealthResult } from "./render_audio_health.js";
export { computeRenderTimeSegments, buildOrRenderSequenceAudioForMixOrRender } from "./render_segments.js";
export type { RenderTimeSegment, SegmentedAudioBuildResult } from "./render_segments.js";
export { ensurePreviewCompositeMp4, prefetchCompositeFramesForTimestamps } from "./render_preview.js";
export { renderMultipleCompositeFramesRgb24, renderSingleCompositeFrameRgb24 } from "./render_frames.js";
export type { CellBboxSidecarUpdate } from "./render_frames.js";
export { renderSequenceToMp4 } from "./render_main.js";
export type { RenderStageTimingsMs, RenderOutputSummary } from "./render_main.js";


export type { RenderEncoderFallback, VideoEncoderCodec } from "./encoder.js";
