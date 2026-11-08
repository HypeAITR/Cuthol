// Engine-neutral composition audio (stem) contract.
//
// A composition engine (today HyperFrames, later other engines) renders picture;
// this contract carries the composition's own sound into the Cuthol mix as a
// separate per-cue audio file (the "stem"). The engine produces the stem with its
// own mix (effects and automation intact); Cuthol places it at the cue's lane
// time through the single shared audio-graph compiler, so measurement and
// render follow the same code path. Only one "extract the sound" adapter is
// written per engine; this file names no engine.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CompositionAudioMode, LaneCue } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";

export interface CompositionAudioRequest {
  cueId: string;
  /** Absolute composition directory. */
  compositionDir: string;
  entryHtml: string;
  cueDurationMs: number;
  props: Record<string, unknown>;
  /** Overlay cache directory; the stem lives beside the overlay blobs. */
  blobsDir: string;
  fps: number;
  width: number;
  height: number;
}

/** One adapter per composition engine. Only the adapter names its engine. */
export interface CompositionAudioAdapter {
  /** Engine tag recorded in the stem sidecar (e.g. "hyperframes"). */
  readonly engine: string;
  /** Engine version tag recorded in the stem sidecar. */
  readEngineVersion(): string;
  /** Content key: same inputs as overlay invalidation (files, used data, props, renderer). */
  cacheKeyFor(request: CompositionAudioRequest): string;
  /** Cheap static check (no render): does the composition hold any audible element? */
  hasAudio(request: CompositionAudioRequest): boolean;
  /**
   * Renders/extracts the engine mix to `outputWavPath` (48 kHz stereo PCM).
   * Returns the stem duration, or null when the engine rendered silence.
   * Throws an Error carrying the reason when extraction fails.
   */
  extractStem(
    request: CompositionAudioRequest,
    outputWavPath: string
  ): { durationMs: number } | null;
}

export type CompositionStemState =
  | { kind: "off" }
  | { kind: "muted" }
  | { kind: "no-markers" }
  | { kind: "mixed"; stemPath: string; stemDurationMs: number; audioKey: string }
  | { kind: "pending"; audioKey: string }
  | { kind: "silent"; audioKey: string }
  | { kind: "error"; audioKey: string; reason: string };

export interface EnsuredCompositionStem {
  stemPath: string;
  stemDurationMs: number;
  audioKey: string;
}

interface StemSidecar {
  version: 1;
  engine: string;
  engine_version: string;
  status: "audio" | "silent" | "error";
  stem?: string;
  duration_ms?: number;
  sample_rate?: number;
  channels?: number;
  reason?: string;
}

export function resolveCompositionAudioMode(cue: Pick<LaneCue, "composition_audio">): CompositionAudioMode {
  return cue.composition_audio ?? "mix";
}

export function stemFileNameForKey(audioKey: string): string {
  return `compaudio_${audioKey}.wav`;
}

export function stemSidecarNameForKey(audioKey: string): string {
  return `compaudio_${audioKey}.stem.json`;
}

/** Builds the engine-neutral stem request for a composition cue, or null for other cues. */
export function compositionAudioRequestForCue(
  cue: LaneCue,
  paths: WorkspacePaths,
  stage: { fps: number; width: number; height: number }
): CompositionAudioRequest | null {
  if (cue.kind !== "composition" || !cue.composition) return null;
  const compositionDir = path.isAbsolute(cue.composition.composition_dir)
    ? cue.composition.composition_dir
    : path.resolve(paths.rootDir, cue.composition.composition_dir);
  return {
    cueId: cue.id,
    compositionDir,
    entryHtml: cue.composition.entry_html || "index.html",
    cueDurationMs: cue.duration_ms,
    props: cue.composition.props ?? {},
    blobsDir: paths.blobsDir,
    fps: stage.fps,
    width: stage.width,
    height: stage.height,
  };
}

function readStemSidecar(blobsDir: string, audioKey: string): StemSidecar | null {
  const sidecarPath = path.join(blobsDir, stemSidecarNameForKey(audioKey));
  if (!fs.existsSync(sidecarPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as StemSidecar;
    if (!parsed || parsed.version !== 1 || typeof parsed.status !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStemSidecar(blobsDir: string, audioKey: string, sidecar: StemSidecar): void {
  try {
    fs.mkdirSync(blobsDir, { recursive: true });
    fs.writeFileSync(
      path.join(blobsDir, stemSidecarNameForKey(audioKey)),
      JSON.stringify(sidecar, null, 2),
      "utf8"
    );
  } catch {
    // Non-blocking: a missing sidecar only means the stem is re-extracted next time.
  }
}

/**
 * Reads the stem state without rendering anything: mode switch, mute, static
 * audio markers, then the content-keyed sidecar. A "mixed" state requires both
 * the sidecar record and the stem file on disk.
 */
export function readCompositionStemState(
  cue: LaneCue,
  request: CompositionAudioRequest,
  adapter: CompositionAudioAdapter,
  options?: { laneMuted?: boolean }
): CompositionStemState {
  if (resolveCompositionAudioMode(cue) === "off") return { kind: "off" };
  if (options?.laneMuted || cue.audio_chain?.muted) return { kind: "muted" };
  if (!adapter.hasAudio(request)) return { kind: "no-markers" };
  const audioKey = adapter.cacheKeyFor(request);
  const sidecar = readStemSidecar(request.blobsDir, audioKey);
  if (!sidecar || sidecar.engine !== adapter.engine) return { kind: "pending", audioKey };
  if (sidecar.status === "error") {
    return { kind: "error", audioKey, reason: sidecar.reason || "unknown extraction failure" };
  }
  if (sidecar.status === "silent") return { kind: "silent", audioKey };
  const stemPath = path.join(request.blobsDir, stemFileNameForKey(audioKey));
  if (sidecar.status === "audio" && typeof sidecar.duration_ms === "number" && fs.existsSync(stemPath)) {
    return { kind: "mixed", stemPath, stemDurationMs: sidecar.duration_ms, audioKey };
  }
  return { kind: "pending", audioKey };
}

/**
 * Ensures the stem exists on disk: reuses the cached stem when the composition
 * is unchanged, extracts (and records) a new one when it changed, and records
 * silent/failed outcomes in the sidecar so verification can report them.
 * Returns null when there is no stem to mix (off, muted, no markers, silent, failed).
 */
export function ensureCompositionStem(
  cue: LaneCue,
  request: CompositionAudioRequest,
  adapter: CompositionAudioAdapter,
  options?: { laneMuted?: boolean }
): EnsuredCompositionStem | null {
  const state = readCompositionStemState(cue, request, adapter, options);
  if (state.kind === "mixed") {
    return { stemPath: state.stemPath, stemDurationMs: state.stemDurationMs, audioKey: state.audioKey };
  }
  if (state.kind !== "pending" && state.kind !== "error") return null;
  const audioKey = state.audioKey;
  const stemPath = path.join(request.blobsDir, stemFileNameForKey(audioKey));
  const engineVersion = adapter.readEngineVersion();
  try {
    const extracted = adapter.extractStem(request, stemPath);
    if (!extracted) {
      writeStemSidecar(request.blobsDir, audioKey, {
        version: 1,
        engine: adapter.engine,
        engine_version: engineVersion,
        status: "silent",
      });
      return null;
    }
    writeStemSidecar(request.blobsDir, audioKey, {
      version: 1,
      engine: adapter.engine,
      engine_version: engineVersion,
      status: "audio",
      stem: stemFileNameForKey(audioKey),
      duration_ms: extracted.durationMs,
      sample_rate: 48000,
      channels: 2,
    });
    return { stemPath, stemDurationMs: extracted.durationMs, audioKey };
  } catch (err) {
    writeStemSidecar(request.blobsDir, audioKey, {
      version: 1,
      engine: adapter.engine,
      engine_version: engineVersion,
      status: "error",
      reason: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    });
    return null;
  }
}

/** Cache-busting fingerprint for tests and reports (content key without touching the cache). */
export function compositionAudioKeyForTesting(
  request: CompositionAudioRequest,
  adapter: CompositionAudioAdapter
): string {
  return adapter.cacheKeyFor(request);
}

export function stemCacheFileDigest(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}
