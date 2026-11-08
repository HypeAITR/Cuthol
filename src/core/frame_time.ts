/**
 * The one definition of cue visibility on the frame grid.
 *
 * A lane cue covers the half-open interval `[start_ms, end_ms)`: output frame
 * `n` (frame time `n / fps` seconds) shows the cue iff
 * `start_ms <= n * 1000 / fps < end_ms`. Render, draft, `monitor frame` /
 * `monitor sheet`, the blank-frame detector and the duration helpers all share
 * these predicates so the cue end boundary never disagrees between paths.
 */

/**
 * Overlap epsilon in milliseconds. Cue edges are integer milliseconds and
 * window edges sit on the frame grid, so a true overlap is either exactly
 * zero or at least ~0.33 ms (the closest a 24/25/30/60 fps frame grid comes
 * to an integer millisecond without touching it); anything below one
 * microsecond is floating-point dust. Same convention as the render segment
 * overlap test.
 */
export const CUE_WINDOW_EPSILON_MS = 1e-3;

/** True when frame time `tMs` shows a cue running `[startMs, endMs)`. */
export function cueCoversTimeMs(startMs: number, endMs: number, tMs: number): boolean {
  return tMs >= startMs && tMs < endMs;
}

/**
 * True when the half-open cue interval `[startMs, endMs)` overlaps the
 * half-open window `[windowStartMs, windowEndMs)`. An exact-boundary touch
 * (cue end == window start) is not an overlap: no frame of the window shows
 * the cue.
 */
export function cueOverlapsWindowMs(
  startMs: number,
  endMs: number,
  windowStartMs: number,
  windowEndMs: number
): boolean {
  return (
    startMs < windowEndMs - CUE_WINDOW_EPSILON_MS &&
    endMs > windowStartMs + CUE_WINDOW_EPSILON_MS
  );
}

/**
 * FFmpeg `overlay:enable` expression showing exactly the frames with
 * `startSec <= t < endSec`. (`between(t, a, b)` is closed on both ends and
 * would wrongly include the frame at the end instant.)
 */
export function buildCueOverlayEnableExpr(startSec: string, endSec: string): string {
  return `gte(t,${startSec})*lt(t,${endSec})`;
}

/**
 * True when the single-frame fast path applies at `singleFrameAtMs`: the
 * instant is inside `[cueStartMs, cueEndMs)`, with one frame of pre-roll
 * tolerance before the start (served from the cue's first frame and hidden
 * by the overlay enable outside `[start, end)`).
 */
export function singleFrameInstantHitsCue(
  singleFrameAtMs: number,
  cueStartMs: number,
  cueEndMs: number,
  frameDurMs: number
): boolean {
  return singleFrameAtMs + frameDurMs >= cueStartMs && singleFrameAtMs < cueEndMs;
}
