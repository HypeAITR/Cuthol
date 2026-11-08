/**
 * ffmpeg/ffprobe Major-Version Probe with Per-Process Caching
 * (`src/core/ffmpeg_version.ts`).
 *
 * Cuthol is measured against ffmpeg 8.x behavior (tempo, loudness, scene
 * analysis); older majors get a short G2 warning (CUTHOL-G212) from verify and
 * from render start (which runs the full verify). The `-version` probe runs at
 * most once per process; git builds without a readable version stay silent.
 * Tests inject fake first lines via `CUTHOL_FAKE_FFMPEG_VERSION_LINE` and
 * `CUTHOL_FAKE_FFPROBE_VERSION_LINE` (the real ffmpeg is never touched).
 */

import { CutholDiagnostic, DIAGNOSTICS } from "./diagnostics.js";
import { spawnWatchedSync } from "./subprocess.js";

export const FFMPEG_TESTED_MAJOR = 8;

export interface FfmpegToolVersion {
  tool: "ffmpeg" | "ffprobe";
  major: number;
  token: string;
  rawLine: string;
}

export interface FfmpegVersionInfo {
  ffmpeg: FfmpegToolVersion | null;
  ffprobe: FfmpegToolVersion | null;
}

/**
 * Reads the major version from a `-version` first line such as
 * `ffmpeg version 8.1.1-full_build-...` or `ffmpeg version n8.1`.
 * Returns null when no release version is readable (git builds like
 * `N-12345-g...`, empty output, missing binary): those never warn.
 */
export function parseFfmpegMajorVersion(
  firstLine: string
): { major: number; token: string } | null {
  const m = /\bversion\s+(?:[nN](?=\d))?(\d[\w.+-]*)/i.exec(firstLine.trim());
  if (!m) return null;
  const token = m[1];
  const major = Number(/^(\d+)/.exec(token)?.[1] ?? NaN);
  if (!Number.isFinite(major)) return null;
  return { major, token };
}

function probeToolVersion(tool: "ffmpeg" | "ffprobe"): FfmpegToolVersion | null {
  const fakeEnv =
    tool === "ffmpeg"
      ? process.env.CUTHOL_FAKE_FFMPEG_VERSION_LINE
      : process.env.CUTHOL_FAKE_FFPROBE_VERSION_LINE;
  let firstLine: string;
  if (fakeEnv !== undefined) {
    firstLine = fakeEnv.split(/\r?\n/)[0] ?? "";
  } else {
    try {
      const proc = spawnWatchedSync(tool, ["-version"], {
        encoding: "utf8",
        step: `${tool} version probe`,
        stallTimeoutMs: 5000,
      });
      if ((proc as { error?: unknown }).error) return null;
      firstLine = String(proc.stdout || "").split(/\r?\n/)[0] ?? "";
    } catch {
      return null;
    }
  }
  const parsed = parseFfmpegMajorVersion(firstLine);
  if (!parsed) return null;
  return { tool, major: parsed.major, token: parsed.token, rawLine: firstLine.trim() };
}

let cachedInfo: FfmpegVersionInfo | null = null;

export function getFfmpegVersionInfo(): FfmpegVersionInfo {
  if (!cachedInfo) {
    cachedInfo = {
      ffmpeg: probeToolVersion("ffmpeg"),
      ffprobe: probeToolVersion("ffprobe"),
    };
  }
  return cachedInfo;
}

export function clearFfmpegVersionCache(): void {
  cachedInfo = null;
}

/** One short WARN per tool whose major is below the tested one (at most two). */
export function ffmpegVersionWarningDiagnostics(): CutholDiagnostic[] {
  const info = getFfmpegVersionInfo();
  const out: CutholDiagnostic[] = [];
  for (const entry of [info.ffmpeg, info.ffprobe]) {
    if (entry && entry.major < FFMPEG_TESTED_MAJOR) {
      out.push(DIAGNOSTICS.FFMPEG_VERSION_BELOW_SUPPORTED(entry.tool, entry.token));
    }
  }
  return out;
}
