/**
 * Sequence extent: the one definition of "how long is this edit" and "what puts picture on screen when".
 *
 * The spine is the primary storyline, but it is optional. A project can be made entirely of lane content
 * (HyperFrames compositions, titles, graphics over voiceover and effects); its length then comes from the
 * lanes alone. Every command that needs the sequence length (render, monitor, brief, mix, verify, bridge data)
 * reads it from here so they never disagree.
 */

import { cueCoversTimeMs } from "./frame_time.js";
import { CutholSequence, LaneCue } from "./schema.js";

/**
 * Shortest output any compiled plan produces. ffmpeg needs a non-empty stream even for a sequence with nothing
 * on it (monitor previews of a fresh project); render refuses an empty sequence before this matters.
 */
export const MIN_RENDER_DURATION_MS = 500;

export function resolveCueStartMs(seq: CutholSequence, cue: LaneCue): number {
  if (!cue.anchor) {
    return cue.at_ms;
  }
  const anchorClip = seq.spine.clips.find((c) => c.id === cue.anchor?.ref);
  if (!anchorClip) {
    return cue.at_ms;
  }
  return anchorClip.timeline_in_ms + cue.anchor.offset_ms;
}

/** End of the last spine clip (0 when the spine is empty). */
export function computeSpineEndMs(seq: CutholSequence): number {
  let maxMs = 0;
  for (const clip of seq.spine.clips) {
    const end = clip.timeline_in_ms + clip.duration_ms;
    if (end > maxMs) maxMs = end;
  }
  return maxMs;
}

/** End of the last cue on an unmuted lane (0 when no lane has content). */
export function computeLaneEndMs(seq: CutholSequence): number {
  let maxMs = 0;
  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      const end = resolveCueStartMs(seq, cue) + cue.duration_ms;
      if (end > maxMs) maxMs = end;
    }
  }
  return maxMs;
}

/** Sequence length: whichever ends later, the spine or the unmuted lanes. 0 means nothing is on the timeline. */
export function computeSequenceDurationMs(seq: CutholSequence): number {
  return Math.max(computeSpineEndMs(seq), computeLaneEndMs(seq));
}

/** Length a compiled render/preview plan covers (never shorter than `MIN_RENDER_DURATION_MS`). */
export function computeRenderDurationMs(seq: CutholSequence, minDurationMs = 0): number {
  return Math.max(MIN_RENDER_DURATION_MS, minDurationMs, computeSequenceDurationMs(seq));
}

export type SequenceExtentSource = "spine" | "lanes" | "empty";

export interface SequenceExtent {
  duration_ms: number;
  spine_end_ms: number;
  lane_end_ms: number;
  /** `lanes` when the spine is empty and lane cues alone define the length (a graphics-only project). */
  source: SequenceExtentSource;
}

export function describeSequenceExtent(seq: CutholSequence): SequenceExtent {
  const spineEnd = computeSpineEndMs(seq);
  const laneEnd = computeLaneEndMs(seq);
  const duration = Math.max(spineEnd, laneEnd);
  const source: SequenceExtentSource =
    seq.spine.clips.length > 0 ? "spine" : duration > 0 ? "lanes" : "empty";
  return { duration_ms: duration, spine_end_ms: spineEnd, lane_end_ms: laneEnd, source };
}

function isAudioOnlyKind(kind: string): boolean {
  return kind === "music" || kind === "sfx" || kind === "voiceover";
}

/** True when the cue draws something on screen (composition, typography, or an asset with a picture). */
export function isVisualCue(seq: CutholSequence, cue: LaneCue): boolean {
  if (isAudioOnlyKind(cue.kind)) return false;
  if (cue.composition) return true;
  if (cue.typography && cue.typography.text.trim()) return true;
  if (!cue.asset_handle) return false;
  const asset = seq.library.find((item) => item.handle === cue.asset_handle);
  return Boolean(asset?.probe.has_video);
}

/** Ids of visual cues on unmuted, non-audio lanes that are on screen at `tMs`. */
export function activeVisualCueIdsAt(seq: CutholSequence, tMs: number): string[] {
  const ids: string[] = [];
  for (const lane of seq.lanes) {
    if (lane.muted || isAudioOnlyKind(lane.kind)) continue;
    for (const cue of lane.cues) {
      const start = resolveCueStartMs(seq, cue);
      if (cueCoversTimeMs(start, start + cue.duration_ms, tMs) && isVisualCue(seq, cue)) {
        ids.push(cue.id);
      }
    }
  }
  return ids;
}

/**
 * Stretches of a spine-less sequence where no visual cue is on screen, so only the stage backdrop shows.
 * Returns nothing when the spine has clips: the spine is the picture layer there and has its own checks.
 * Spans shorter than `minSpanMs` (default one frame) are ignored.
 */
export function findBackdropOnlySpans(
  seq: CutholSequence,
  minSpanMs?: number
): Array<{ start_ms: number; end_ms: number }> {
  if (seq.spine.clips.length > 0) return [];
  const durationMs = computeSequenceDurationMs(seq);
  if (durationMs <= 0) return [];
  const minSpan = minSpanMs ?? 1000 / Math.max(1, seq.stage.fps);

  const covered: Array<[number, number]> = [];
  for (const lane of seq.lanes) {
    if (lane.muted || isAudioOnlyKind(lane.kind)) continue;
    for (const cue of lane.cues) {
      if (!isVisualCue(seq, cue)) continue;
      const start = Math.max(0, resolveCueStartMs(seq, cue));
      const end = Math.min(durationMs, start + cue.duration_ms);
      if (end > start) covered.push([start, end]);
    }
  }
  covered.sort((a, b) => a[0] - b[0]);

  const spans: Array<{ start_ms: number; end_ms: number }> = [];
  let cursor = 0;
  for (const [start, end] of covered) {
    if (start - cursor >= minSpan) spans.push({ start_ms: cursor, end_ms: start });
    cursor = Math.max(cursor, end);
  }
  if (durationMs - cursor >= minSpan) spans.push({ start_ms: cursor, end_ms: durationMs });
  return spans;
}

/**
 * Stretches of a spine-less sequence whose on-screen picture comes only from
 * the given cues (every covering visual cue is in `cueIds`, and at least one
 * cue covers). Spans shorter than `minSpanMs` (default one frame) are ignored.
 * Returns nothing when the spine has clips or `cueIds` is empty.
 */
export function findSpansCoveredOnlyByCues(
  seq: CutholSequence,
  cueIds: Set<string>,
  minSpanMs?: number
): Array<{ start_ms: number; end_ms: number }> {
  if (seq.spine.clips.length > 0) return [];
  if (cueIds.size === 0) return [];
  const durationMs = computeSequenceDurationMs(seq);
  if (durationMs <= 0) return [];
  const minSpan = minSpanMs ?? 1000 / Math.max(1, seq.stage.fps);

  const visuals: Array<{ start: number; end: number; id: string }> = [];
  for (const lane of seq.lanes) {
    if (lane.muted || isAudioOnlyKind(lane.kind)) continue;
    for (const cue of lane.cues) {
      if (!isVisualCue(seq, cue)) continue;
      const start = Math.max(0, resolveCueStartMs(seq, cue));
      const end = Math.min(durationMs, start + cue.duration_ms);
      if (end > start) visuals.push({ start, end, id: cue.id });
    }
  }
  const bounds = new Set<number>([0, durationMs]);
  for (const v of visuals) {
    bounds.add(v.start);
    bounds.add(v.end);
  }
  const sorted = [...bounds].sort((a, b) => a - b);

  const spans: Array<{ start_ms: number; end_ms: number }> = [];
  let open: { start_ms: number; end_ms: number } | null = null;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b <= a) continue;
    const covering = visuals.filter((v) => v.start <= a && v.end >= b);
    if (covering.length > 0 && covering.every((v) => cueIds.has(v.id))) {
      if (open && open.end_ms === a) {
        open.end_ms = b;
      } else {
        open = { start_ms: a, end_ms: b };
        spans.push(open);
      }
    } else {
      open = null;
    }
  }
  return spans.filter((s) => s.end_ms - s.start_ms >= minSpan);
}
