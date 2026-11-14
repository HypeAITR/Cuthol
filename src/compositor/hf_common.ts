// HyperFrames bridge shared pieces: package root, local CLI/GSAP lookup, public types, encoder hint helpers (split out of hyperframes_bridge.ts).
import fs from "node:fs";
import path from "node:path";
import {
  resolveVideoEncoderPreference
} from "../core/env.js";
import { probeAndVerifyVideoEncoder } from "../render/encoder.js";
import { resolveBundledGsapMinJs, resolveHyperFramesCliMjs } from "../core/package_resolve.js";

export type HyperFramesPresetKind =
  | "title_card"
  | "lower_third"
  | "stat_callout"
  | "badge_overlay"
  | "counter"
  | "beat_cards"
  | "audio_glow"
  | "cut_phases"
  | "blank";

export interface HyperFramesScaffoldOptions {
  targetDir: string;
  compositionId?: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  preset?: HyperFramesPresetKind;
  props?: Record<string, unknown>;
  bgColorHex?: string;
  transparent?: boolean;
  asSubComposition?: boolean;
}

export interface HyperFramesValidationResult {
  ok: boolean;
  composition_id: string | null;
  findings: string[];
  lint_findings?: HyperFramesLintFinding[];
  lint_info_findings?: HyperFramesLintFinding[];
  lint_cached?: boolean;
}

export interface HyperFramesLintFinding {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  fixHint?: string;
  selector?: string;
  elementId?: string;
  snippet?: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface HyperFramesLintResult {
  ok: boolean;
  cached: boolean;
  content_hash: string;
  findings: HyperFramesLintFinding[];
  info_findings: HyperFramesLintFinding[];
}

export function findLocalHyperFramesCliMjs(): string {
  const resolved = resolveHyperFramesCliMjs();
  if (resolved) {
    return resolved;
  }
  return path.resolve(process.cwd(), "node_modules/hyperframes/bin/hyperframes.mjs");
}

/**
 * Name of the HyperFrames render-slot switch (HyperFrames 0.9.14+ takes a machine-wide
 * single render slot and queues a second render unless this is `off`/`0`/`false`).
 */
export const HYPERFRAMES_RENDER_LOCK_ENV_VAR = "HYPERFRAMES_RENDER_LOCK";

/** Value Cuthol uses so its concurrent overlay renders run side by side. */
export const HYPERFRAMES_RENDER_LOCK_CUTHOL_DEFAULT = "off";

/**
 * Resolves the `HYPERFRAMES_RENDER_LOCK` value for HyperFrames processes Cuthol spawns.
 *
 * Rule (documented in `skills/cuthol/references/compositions.md`): an explicitly set,
 * non-empty user value always wins and Cuthol never touches it (e.g. `HYPERFRAMES_RENDER_LOCK=1`
 * deliberately re-enables the machine-wide slot and Cuthol's parallel overlay pre-pass queues
 * behind it). When the variable is unset or blank, Cuthol uses `off` so concurrent overlay
 * renders keep running side by side instead of silently serializing.
 */
export function resolveHyperFramesRenderLockValue(): string {
  const raw = process.env[HYPERFRAMES_RENDER_LOCK_ENV_VAR];
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw;
  }
  return HYPERFRAMES_RENDER_LOCK_CUTHOL_DEFAULT;
}

/**
 * Environment for a HyperFrames child process spawned by Cuthol: the current process
 * environment plus the resolved `HYPERFRAMES_RENDER_LOCK` value. Pass the result as
 * `env` to every direct `spawnWatchedSync` HyperFrames invocation.
 */
export function hyperFramesProcessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [HYPERFRAMES_RENDER_LOCK_ENV_VAR]: resolveHyperFramesRenderLockValue(),
  };
}

/**
 * Writes the Cuthol default into `process.env` when the user did not set the variable.
 * This covers the concurrent overlay path (`runCollectedOverlays` -> `runWatchedParallelFfmpegJobsSync`),
 * which cannot take a per-job `env`: the watchdog worker inherits `process.env` once at creation,
 * so the default must be present before the first spawn. Called once at module load below (imports
 * always run before the first spawn in the CLI and in tests) and defensively before overlay runs.
 */
export function ensureHyperFramesRenderLockDefault(): void {
  const raw = process.env[HYPERFRAMES_RENDER_LOCK_ENV_VAR];
  if (typeof raw !== "string" || raw.trim() === "") {
    process.env[HYPERFRAMES_RENDER_LOCK_ENV_VAR] = HYPERFRAMES_RENDER_LOCK_CUTHOL_DEFAULT;
  }
}

ensureHyperFramesRenderLockDefault();

/** Written into the overlay cache key when the invoked HyperFrames package version cannot be read. */
export const HYPERFRAMES_RENDERER_VERSION_UNREADABLE = "unreadable";

let cachedHyperFramesPackageVersion: string | null = null;

function readNonEmptyPackageVersion(pkgJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as { version?: unknown };
    if (typeof parsed.version !== "string") return null;
    const version = parsed.version.trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

function readHyperFramesPackageVersionFromCli(): string | null {
  const cliDir = path.dirname(findLocalHyperFramesCliMjs());
  // CLI is `<package>/bin/hyperframes.mjs`; the manifest is the package root, then the CLI directory.
  const candidates = [
    path.resolve(cliDir, "..", "package.json"),
    path.resolve(cliDir, "package.json"),
  ];
  for (const pkgJsonPath of candidates) {
    const version = readNonEmptyPackageVersion(pkgJsonPath);
    if (version) return version;
  }
  return null;
}

/**
 * Version of the HyperFrames package whose CLI this process invokes.
 * `CUTHOL_HF_VERSION_OVERRIDE` is for tests only.
 * Never returns an empty string.
 */
export function readInvokedHyperFramesVersion(): string {
  const override = process.env.CUTHOL_HF_VERSION_OVERRIDE;
  if (typeof override === "string" && override.trim() !== "") {
    return override.trim();
  }
  if (cachedHyperFramesPackageVersion === null) {
    cachedHyperFramesPackageVersion =
      readHyperFramesPackageVersionFromCli() ?? HYPERFRAMES_RENDERER_VERSION_UNREADABLE;
  }
  return cachedHyperFramesPackageVersion;
}

export function findLocalGsapMinJs(): string {
  const resolved = resolveBundledGsapMinJs();
  if (resolved) {
    return resolved;
  }
  throw new Error("Local node_modules/gsap/dist/gsap.min.js not found.");
}

export function copyDirRecursiveSync(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === "snapshots" || entry.name === "renders" || entry.name === ".hyperframes") {
      continue;
    }
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursiveSync(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * Probes whether FFmpeg's `h264_nvenc` hardware encoder is functional and passes BT.709 color verification.
 * Result is memoized per process; honors `CUTHOL_DISABLE_NVENC` / `CUTHOL_ENCODER`.
 */
export function isNvencHardwareAvailable(): boolean {
  return probeAndVerifyVideoEncoder("h264_nvenc").ok;
}

export function shouldUseNvencForRender(overrideEncoder?: string | null): {
  useNvenc: boolean;
  fallbackReason: string | null;
} {
  const pref = resolveVideoEncoderPreference(overrideEncoder);
  if (pref === "libx264") {
    return {
      useNvenc: false,
      fallbackReason: "NVENC disabled by configuration (CUTHOL_DISABLE_NVENC / CUTHOL_VIDEO_ENCODER=libx264)",
    };
  }
  const probe = probeAndVerifyVideoEncoder("h264_nvenc");
  if (!probe.ok) {
    return {
      useNvenc: false,
      fallbackReason: probe.reason ?? "h264_nvenc hardware encoder is not available on this machine",
    };
  }
  return { useNvenc: true, fallbackReason: null };
}

export function renameWithRetrySync(srcPath: string, dstPath: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (fs.existsSync(dstPath)) {
        fs.rmSync(dstPath, { recursive: true, force: true });
      }
      fs.renameSync(srcPath, dstPath);
      return;
    } catch (err) {
      lastErr = err;
      const until = Date.now() + 50 * (attempt + 1);
      while (Date.now() < until) {}
    }
  }
  throw lastErr;
}
