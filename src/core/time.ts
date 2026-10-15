/**
 * Deterministic Integer Millisecond (`ms`) Time Utilities for Cuthol.
 */

import { CutholError, DIAGNOSTICS } from "./diagnostics.js";

export interface ParseTimeOptions {
  allowNegative?: boolean;
}

/**
 * Parses an explicit time literal (`1250ms`, `1.25s`, `0.5min`, `01:02.500`, or integer ms)
 * into exact integer milliseconds (`ms`).
 * Ambiguous unit suffixes like bare `m` are rejected to avoid minute vs millisecond confusion.
 */
export function parseTimeMs(input: string | number, options?: ParseTimeOptions): number {
  const allowNegative = options?.allowNegative ?? false;

  if (typeof input === "number") {
    if (!Number.isFinite(input) || (!allowNegative && (input < 0 || Object.is(input, -0)))) {
      throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(String(input)));
    }
    const rounded = Math.round(input);
    const normalized = Object.is(rounded, -0) ? 0 : rounded;
    if (!Number.isSafeInteger(normalized)) {
      throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(String(input)));
    }
    return normalized;
  }

  const raw = input.trim();
  if (!raw) {
    throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(input));
  }

  // MM:SS.mmm or HH:MM:SS.mmm (strict integer hours/minutes and < 60 min/sec bounds)
  if (raw.includes(":")) {
    const tcMatch = /^([+-])?(?:(\d+):)?([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/.exec(raw);
    if (!tcMatch) {
      throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(input));
    }
    const sign = tcMatch[1] === "-" ? -1 : 1;
    if (sign < 0 && !allowNegative) {
      throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(input));
    }
    const hrs = tcMatch[2] !== undefined ? Number(tcMatch[2]) : 0;
    const mins = Number(tcMatch[3]);
    const secs = Number(tcMatch[4]);
    if (
      !Number.isFinite(hrs) ||
      !Number.isFinite(mins) ||
      !Number.isFinite(secs) ||
      mins >= 60 ||
      secs >= 60
    ) {
      throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(input));
    }
    const totalMs = Math.round(sign * (hrs * 3600 + mins * 60 + secs) * 1000);
    const normalized = Object.is(totalMs, -0) ? 0 : totalMs;
    if (!Number.isSafeInteger(normalized)) {
      throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(input));
    }
    return normalized;
  }

  const match = /^([+-]?\d+(?:\.\d+)?)\s*(ms|s|sec|min|us)?$/i.exec(raw);
  if (!match) {
    throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(input));
  }

  const hasMinus = raw.startsWith("-");
  const value = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();

  if (!Number.isFinite(value) || (!allowNegative && (value < 0 || hasMinus))) {
    throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(input));
  }

  let resultMs: number;
  switch (unit) {
    case "us":
      resultMs = Math.round(value / 1000);
      break;
    case "ms":
      resultMs = Math.round(value);
      break;
    case "s":
    case "sec":
      resultMs = Math.round(value * 1000);
      break;
    case "min":
      resultMs = Math.round(value * 60_000);
      break;
    default:
      throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(input));
  }
  const normalized = Object.is(resultMs, -0) ? 0 : resultMs;
  if (!Number.isSafeInteger(normalized)) {
    throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(input));
  }
  return normalized;
}

/**
 * Formats integer milliseconds into both human-readable seconds (`12.34s`) and `MM:SS.mmm`.
 */
export function formatMsCompact(ms: number): string {
  const rounded = Math.round(ms);
  if (Math.abs(rounded) < 1000) {
    return `${rounded}ms`;
  }
  const s = (rounded / 1000).toFixed(2).replace(/\.?0+$/, "");
  return `${s}s (${rounded}ms)`;
}

export function formatTimecode(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const totalSec = Math.floor(clamped / 1000);
  const remMs = clamped % 1000;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(remMs).padStart(3, "0")}`;
}

export function minClipDurationMs(fps: number, minFrames = 2): number {
  return Math.ceil((1000 / Math.max(1, fps)) * minFrames);
}
