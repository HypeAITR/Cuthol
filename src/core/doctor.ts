// Environment checks behind `cuthol doctor` (`src/core/doctor.ts`).
//
// Each check returns one line: an id, a status (`ok` / `warn` / `fail`),
// what was found, and a one-line fix. Checks are pure functions of their
// probe input so tests can drive every outcome without touching the machine;
// `collectDoctorChecks` fills the probes with one real lookup each.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FFMPEG_TESTED_MAJOR, getFfmpegVersionInfo } from "./ffmpeg_version.js";
import { listInstalledBrowsers } from "../live/live_browsers.js";
import { findLocalHyperFramesCliMjs } from "../compositor/hf_common.js";
import { listSkillsStatus } from "./skills_install.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  found: string;
  fix: string;
}

export interface DoctorProbes {
  nodeVersion?: string;
  nodeEnginesRange?: string;
  ffmpegMajor?: number | null;
  ffmpegToken?: string | null;
  ffprobeMajor?: number | null;
  ffprobeToken?: string | null;
  chromiumBrowsers?: string[];
  hyperframesResolved?: boolean;
  hyperframesVersion?: string | null;
  hyperframesPinned?: string;
  gsapPresent?: boolean;
  deepgramKeyPresent?: boolean;
  elevenlabsKeyPresent?: boolean;
  skillsSummary?: string | null;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT_DIR = path.resolve(MODULE_DIR, "../..");

function readPackageJsonField(field: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT_DIR, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    if (field === "engines.node") {
      const engines = pkg.engines as { node?: unknown } | undefined;
      return typeof engines?.node === "string" ? engines.node : null;
    }
    if (field === "hyperframes") {
      const deps = pkg.dependencies as Record<string, unknown> | undefined;
      return typeof deps?.hyperframes === "string" ? deps.hyperframes : null;
    }
  } catch {
    // unreadable package.json: the check reports it instead of throwing
  }
  return null;
}

function satisfiesEngines(version: string, range: string): boolean {
  const clean = version.trim().replace(/^v/i, "");
  const major = Number(/^(\d+)/.exec(clean)?.[1] ?? NaN);
  if (!Number.isFinite(major)) return false;
  const m = />=\s*(\d+)(?:\.(\d+))?/.exec(range);
  if (!m) return major >= 22;
  const needMajor = Number(m[1]);
  if (major !== needMajor) return major > needMajor;
  if (m[2] === undefined) return true;
  const minor = Number(/^(\d+)/.exec(clean.split(".")[1] ?? "0")?.[1] ?? 0);
  return minor >= Number(m[2]);
}

export function checkNode(probes: DoctorProbes = {}): DoctorCheck {
  const version = probes.nodeVersion ?? process.version;
  const range = probes.nodeEnginesRange ?? readPackageJsonField("engines.node") ?? ">=22.5.0";
  if (satisfiesEngines(version, range)) {
    return { id: "node", status: "ok", found: `node ${version} satisfies ${range}`, fix: "none" };
  }
  return {
    id: "node",
    status: "fail",
    found: `node ${version} does not satisfy ${range}`,
    fix: `Install Node.js ${range} (see https://nodejs.org).`,
  };
}

export function checkFfmpeg(probes: DoctorProbes = {}): DoctorCheck {
  const ffmpegMajor = probes.ffmpegMajor ?? null;
  const ffprobeMajor = probes.ffprobeMajor ?? null;
  const ffmpegToken = probes.ffmpegToken ?? null;
  const ffprobeToken = probes.ffprobeToken ?? null;
  if (ffmpegMajor === null || ffprobeMajor === null) {
    const missing = ffmpegMajor === null ? "ffmpeg" : "ffprobe";
    return {
      id: "ffmpeg",
      status: "fail",
      found: `${missing} not found on PATH`,
      fix: "Install ffmpeg 8.x (ffmpeg and ffprobe) and put it on PATH. [CUTHOL-G625]",
    };
  }
  const short = (toolMajor: number, token: string | null): string =>
    token ? `${toolMajor}.x (${token.split("-")[0]})` : `${toolMajor}.x`;
  if (ffmpegMajor !== FFMPEG_TESTED_MAJOR || ffprobeMajor !== FFMPEG_TESTED_MAJOR) {
    return {
      id: "ffmpeg",
      status: "warn",
      found: `ffmpeg ${short(ffmpegMajor, ffmpegToken)} / ffprobe ${short(ffprobeMajor, ffprobeToken)} (tested: ${FFMPEG_TESTED_MAJOR}.x)`,
      fix: `Install ffmpeg ${FFMPEG_TESTED_MAJOR}.x on PATH. [CUTHOL-G212]`,
    };
  }
  return {
    id: "ffmpeg",
    status: "ok",
    found: `ffmpeg ${short(ffmpegMajor, ffmpegToken)} / ffprobe ${short(ffprobeMajor, ffprobeToken)}`,
    fix: "none",
  };
}

export function checkBrowser(probes: DoctorProbes = {}): DoctorCheck {
  const names = probes.chromiumBrowsers ?? [];
  if (names.length === 0) {
    return {
      id: "browser",
      status: "fail",
      found: "no Chrome/Chromium found",
      fix: "Install Google Chrome or Microsoft Edge and retry. [CUTHOL-G626]",
    };
  }
  return {
    id: "browser",
    status: "ok",
    found: `Chromium browser(s): ${names.join(", ")}`,
    fix: "none",
  };
}

export function checkHyperframes(probes: DoctorProbes = {}): DoctorCheck {
  if (!probes.hyperframesResolved) {
    return {
      id: "hyperframes",
      status: "fail",
      found: "hyperframes package not resolvable",
      fix: "Reinstall the Cuthol package (`npm install`).",
    };
  }
  const parts: string[] = [`hyperframes ${probes.hyperframesVersion ?? "unknown"}`];
  if (probes.hyperframesPinned && probes.hyperframesVersion !== probes.hyperframesPinned) {
    parts.push(`(pinned ${probes.hyperframesPinned})`);
  }
  parts.push(probes.gsapPresent ? "gsap present" : "gsap MISSING");
  if (!probes.gsapPresent) {
    return {
      id: "hyperframes",
      status: "fail",
      found: parts.join(", "),
      fix: "Reinstall the Cuthol package (`npm install`).",
    };
  }
  return { id: "hyperframes", status: "ok", found: parts.join(", "), fix: "none" };
}

export function checkSpeechKeys(probes: DoctorProbes = {}): DoctorCheck {
  const deepgram = probes.deepgramKeyPresent === true;
  const elevenlabs = probes.elevenlabsKeyPresent === true;
  const names: string[] = [];
  if (deepgram) names.push("DEEPGRAM_API_KEY");
  if (elevenlabs) names.push("ELEVENLABS_API_KEY");
  if (names.length === 2) {
    return { id: "speech-keys", status: "ok", found: "DEEPGRAM_API_KEY, ELEVENLABS_API_KEY present", fix: "none" };
  }
  if (names.length === 1) {
    const missing = deepgram ? "ELEVENLABS_API_KEY" : "DEEPGRAM_API_KEY";
    return {
      id: "speech-keys",
      status: "warn",
      found: `${names[0]} present, ${missing} missing (speech partly unavailable)`,
      fix: `Add ${missing} to the environment or project .env; or use an extension provider via 'cuthol speech providers'.`,
    };
  }
  return {
    id: "speech-keys",
    status: "warn",
    found: "DEEPGRAM_API_KEY, ELEVENLABS_API_KEY missing (speech is optional)",
    fix: "Add them to the environment or project .env; or use an extension provider via 'cuthol speech providers'.",
  };
}

export function checkSkills(probes: DoctorProbes = {}): DoctorCheck {
  const summary = probes.skillsSummary ?? null;
  if (summary === null) {
    return {
      id: "skills",
      status: "warn",
      found: "no agent tool detected (skills status unavailable)",
      fix: "Run 'cuthol setup' to register Cuthol with your agent tool.",
    };
  }
  return { id: "skills", status: "ok", found: summary, fix: "none" };
}

export function summarizeSkillsStatus(report: ReturnType<typeof listSkillsStatus>): string | null {
  const detected = report.targets.filter((t) => t.detected);
  if (detected.length === 0) return null;
  const parts: string[] = [];
  for (const target of detected) {
    const counts = new Map<string, number>();
    for (const skill of target.skills) counts.set(skill.status, (counts.get(skill.status) ?? 0) + 1);
    const detail = [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(", ");
    parts.push(`${target.id}: ${detail}`);
  }
  return parts.join("; ");
}

function defaultProbes(): DoctorProbes {
  const info = getFfmpegVersionInfo();
  const inventory = listInstalledBrowsers();
  const chromium = inventory.browsers.filter((b) => b.chromium).map((b) => b.name);
  const hfCli = findLocalHyperFramesCliMjs();
  const hfResolved = fs.existsSync(hfCli);
  let hfVersion: string | null = null;
  try {
    const hfPkg = path.resolve(path.dirname(hfCli), "../package.json");
    const parsed = JSON.parse(fs.readFileSync(hfPkg, "utf8")) as { version?: unknown };
    hfVersion = typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    hfVersion = null;
  }
  let gsapPresent = false;
  try {
    gsapPresent = fs.existsSync(path.resolve(PACKAGE_ROOT_DIR, "node_modules/gsap/package.json"));
  } catch {
    gsapPresent = false;
  }
  let skillsSummary: string | null = null;
  try {
    skillsSummary = summarizeSkillsStatus(listSkillsStatus());
  } catch {
    skillsSummary = null;
  }
  return {
    ffmpegMajor: info.ffmpeg?.major ?? null,
    ffmpegToken: info.ffmpeg?.token ?? null,
    ffprobeMajor: info.ffprobe?.major ?? null,
    ffprobeToken: info.ffprobe?.token ?? null,
    chromiumBrowsers: chromium,
    hyperframesResolved: hfResolved,
    hyperframesVersion: hfVersion,
    hyperframesPinned: readPackageJsonField("hyperframes") ?? undefined,
    gsapPresent,
    deepgramKeyPresent: (process.env.DEEPGRAM_API_KEY ?? "").trim().length > 0,
    elevenlabsKeyPresent: (process.env.ELEVENLABS_API_KEY ?? "").trim().length > 0,
    skillsSummary,
  };
}

export function collectDoctorChecks(probes?: DoctorProbes): DoctorCheck[] {
  const p = probes ?? defaultProbes();
  return [checkNode(p), checkFfmpeg(p), checkBrowser(p), checkHyperframes(p), checkSpeechKeys(p), checkSkills(p)];
}
