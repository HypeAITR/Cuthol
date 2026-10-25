/**
 * Cuthol Primary Narrative Spine & Envelope Engine (`src/sequence/spine.ts`).
 *
 * Implements magnetic spine reflow, append, split (with automatic cue re-anchoring
 * and envelope partitioning), trim, multi-range excise (ripple cut), remove, reorder,
 * spatial transform (absolute & relative deltas), playback speed, transitions,
 * and deterministic keyframe envelope evaluation.
 */

export { integrateSourceOffsetToClipLocalMs, invertClipLocalMsToSourceOffset, computeClipDurationMs, evaluateSpeedRampAtOffset, sliceSpeedRamp, sourceMsToSequenceMs, sequenceMsToSourceMs, clipLocalMsToSourceMs, sourceMsToClipLocalMs, projectTranscriptWordsToClip, projectTranscriptAcrossSequence, reflowSpine } from "./spine_time.js";
export type { TimeCoordinateSpace } from "./spine_time.js";
export { evaluateEnvelopeAt, sliceEnvelopes, sliceReframeFocalPoints } from "./spine_envelope.js";
export { appendSpineClip, splitSpineClip, trimSpineClip, exciseSpineRanges, removeSpineClips, reorderSpineClip, applyNumericDeltaOrValue, applyOpacityDeltaOrValue, transformSpineClip, setSpineSpeed, setSpineTransition, setItemEnvelope, setSpineMute } from "./spine_edit.js";
export { reframeSpineClips } from "./spine_reframe.js";
export type { ReframeSpineOptions, ReframeSpineResult } from "./spine_reframe.js";


