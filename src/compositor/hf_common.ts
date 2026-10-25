// HyperFrames bridge shared pieces: package root, local CLI/GSAP lookup, public types, encoder hint helpers (split out of hyperframes_bridge.ts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveVideoEncoderPreference
} from "../core/env.js";
import { probeAndVerifyVideoEncoder } from "../render/encoder.js";

const PACKAGE_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
  const pkgCandidate = path.resolve(PACKAGE_ROOT_DIR, "node_modules/hyperframes/bin/hyperframes.mjs");
  if (fs.existsSync(pkgCandidate)) {
    return pkgCandidate;
  }
  return path.resolve(process.cwd(), "node_modules/hyperframes/bin/hyperframes.mjs");
}

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
  const pkgCandidate = path.resolve(PACKAGE_ROOT_DIR, "node_modules/gsap/dist/gsap.min.js");
  if (fs.existsSync(pkgCandidate)) {
    return pkgCandidate;
  }
  const cwdCandidate = path.resolve(process.cwd(), "node_modules/gsap/dist/gsap.min.js");
  if (fs.existsSync(cwdCandidate)) {
    return cwdCandidate;
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
