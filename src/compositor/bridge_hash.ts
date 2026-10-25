// Composition directory hashing and data-usage analysis behind the overlay cache key (split out of bridge_exporter.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CUTHOL_BRIDGE_SCHEMA,
  CUTHOL_RUNTIME_VERSION, CutholBridgeV1
} from "./cuthol_runtime.js";

const BRIDGE_PACKAGE_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Locates the package-local `gsap.min.js` so compositions never depend on a CDN. */
export function findBundledGsapMinJs(): string | null {
  const candidates = [
    path.resolve(BRIDGE_PACKAGE_ROOT_DIR, "node_modules/gsap/dist/gsap.min.js"),
    path.resolve(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const IGNORED_COMPOSITION_SUBDIRS = new Set([
  ".hyperframes",
  "snapshots",
  "renders",
  "build",
  "node_modules",
  ".git",
  ".cuthol",
]);

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Deterministically hashes an entire composition directory tree (including `assets/`,
 * `compositions/`, fonts, images, CSS, JS, HTML) while ignoring transient output directories.
 */
export function hashDirectoryRecursive(rootDir: string): string {
  const absRoot = path.resolve(rootDir);
  const visitedDirs = new Set<string>([safeRealpath(absRoot)]);
  const hash = crypto
    .createHash("sha256")
    .update(`cuthol-runtime-v:${CUTHOL_RUNTIME_VERSION}\n`);

  const walk = (currentDir: string, relPrefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (
        entry.name.startsWith(".tmp.") ||
        entry.name.startsWith(".cuthol-") ||
        entry.name.endsWith(".tmp.mp4") ||
        entry.name.endsWith(".tmp.mov") ||
        entry.name === "cuthol-bbox.json"
      ) {
        continue;
      }
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const targetStat = fs.statSync(fullPath);
          isDir = targetStat.isDirectory();
          isFile = targetStat.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        if (IGNORED_COMPOSITION_SUBDIRS.has(entry.name)) continue;
        const realDir = safeRealpath(fullPath);
        if (visitedDirs.has(realDir)) continue;
        visitedDirs.add(realDir);
        walk(fullPath, relPath);
      } else if (isFile) {
        try {
          const fileBuf = fs.readFileSync(fullPath);
          const fileDigest = crypto.createHash("sha256").update(fileBuf).digest("hex");
          hash.update(`file:${relPath}:${fileBuf.length}:${fileDigest}\n`);
        } catch {
          // ignore unreadable transient file
        }
      }
    }
  };

  walk(absRoot, "");
  return hash.digest("hex");
}

/**
 * Extracts only scalar variable values (`string`, `number`, `boolean`) compatible with
 * HyperFrames `--variables-file` / `data-composition-variables`.
 */
export function extractScalarHyperFramesVariables(
  props: Record<string, unknown> | undefined
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props) return out;
  for (const key of Object.keys(props).sort()) {
    const val = props[key];
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      out[key] = val;
    }
  }
  return out;
}

const AUDIO_USAGE_REGEX =
  /\b(?:C|__cuthol|global)\s*\.\s*audio\b|\.\s*audio\s*\.\s*(?:low|mid|high)\b|\baudio\s*\(\s*["'](?:low|mid|high)["']/;

export interface CompositionDataUsage {
  usesLocalWords: boolean;
  usesLocalBeats: boolean;
  usesLocalAudio: boolean;
  usesLocalCuts: boolean;
  usesSequenceTiming: boolean;
  usesGlobalWords: boolean;
  usesGlobalBeats: boolean;
  usesGlobalAudio: boolean;
  usesGlobalCuts: boolean;
  usesGlobalTiming: boolean;
  usesAnyGlobal: boolean;
}

function stripCommentsForUsageAnalysis(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(?<![:\\/])\/\/[^\r\n]*/g, " ");
}

/**
 * Inspects a composition's HTML and JS files (including injected extension helpers `cuthol-ext-*.js`,
 * excluding generated `cuthol-data.js`, `cuthol-runtime.js`, and `gsap.min.js`) to determine which
 * local and global timeline intelligence slices the composition actually reads.
 * If dynamic/ambiguous access is detected, errs on the safe side and marks the slice as used.
 */
export function analyzeCompositionDataUsage(
  compDir: string,
  entryHtml = "index.html",
  props?: Record<string, unknown>
): CompositionDataUsage {
  const allTrue: CompositionDataUsage = {
    usesLocalWords: true,
    usesLocalBeats: true,
    usesLocalAudio: true,
    usesLocalCuts: true,
    usesSequenceTiming: true,
    usesGlobalWords: true,
    usesGlobalBeats: true,
    usesGlobalAudio: true,
    usesGlobalCuts: true,
    usesGlobalTiming: true,
    usesAnyGlobal: true,
  };

  try {
    const absCompDir = path.resolve(compDir);
    if (!fs.existsSync(absCompDir)) return allTrue;
    const entryPath = path.join(absCompDir, entryHtml || "index.html");
    if (!fs.existsSync(entryPath)) return allTrue;

    const chunks: string[] = [];
    const collectSources = (dir: string, depth: number): void => {
      if (depth > 3 || !fs.existsSync(dir)) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (IGNORED_COMPOSITION_SUBDIRS.has(ent.name)) continue;
        if (
          ent.name === "cuthol-data.js" ||
          ent.name === "cuthol-data.json" ||
          ent.name === "cuthol-runtime.js" ||
          ent.name === "cuthol-vars.json" ||
          ent.name === "cuthol-bbox.json" ||
          ent.name.startsWith(".cuthol-") ||
          ent.name === "gsap.min.js"
        ) {
          continue;
        }
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          collectSources(full, depth + 1);
        } else if (ent.isFile() && /\.(?:html|js|mjs)$/i.test(ent.name)) {
          try {
            const raw = fs.readFileSync(full, "utf8");
            if (/\.html$/i.test(ent.name)) {
              const scripts = raw.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [raw];
              chunks.push(stripCommentsForUsageAnalysis(scripts.join("\n")));
            } else {
              chunks.push(stripCommentsForUsageAnalysis(raw));
            }
          } catch {
            // ignore unreadable file
          }
        }
      }
    };
    collectSources(absCompDir, 0);

    const combined = chunks.join("\n");
    const preset = typeof props?.preset === "string" ? props.preset : "";

    // Conservative fallback if dynamic property indexing, raw data access, or eval is present
    const hasAmbiguousDynamicAccess =
      /\beval\s*\(|\bnew\s+Function\b|\b__CUTHOL_DATA__\b|\.\s*data\b|\b(?:C|__cuthol)\s*\[/.test(
        combined
      );
    if (hasAmbiguousDynamicAccess) {
      return allTrue;
    }

    const mentionsGlobalProp = /\.\s*global\b|["']global["']/.test(combined);
    const strippedDirectGlobalMembers = combined.replace(
      /\.\s*global\s*\.\s*(?:word|words|pauses|sentences|beats|beatGrid|bpm|audio|cuts|segments|duration|cueStart|cueEnd|toLocal|toGlobal|drive|value)\b/g,
      ""
    );
    const hasAliasedGlobalObj =
      mentionsGlobalProp && /\.\s*global\b|["']global["']/.test(strippedDirectGlobalMembers);

    const usesGlobalWords =
      mentionsGlobalProp &&
      (/\.\s*global\s*\.\s*(?:word|words|pauses|sentences)\b/.test(combined) ||
        (hasAliasedGlobalObj && /\b(?:word|words|pauses|sentences)\b/.test(combined)));
    const usesGlobalBeats =
      mentionsGlobalProp &&
      (/\.\s*global\s*\.\s*(?:beats|beatGrid|bpm)\b/.test(combined) ||
        (hasAliasedGlobalObj && /\b(?:beats|beatGrid|bpm)\b/.test(combined)));
    const usesGlobalAudio =
      mentionsGlobalProp &&
      (/\.\s*global\s*\.\s*audio\b/.test(combined) ||
        (hasAliasedGlobalObj && /\baudio\b/.test(combined)));
    const usesGlobalCuts =
      mentionsGlobalProp &&
      (/\.\s*global\s*\.\s*(?:cuts|segments)\b/.test(combined) ||
        (hasAliasedGlobalObj && /\b(?:cuts|segments)\b/.test(combined)));
    const usesGlobalTiming =
      mentionsGlobalProp &&
      (/\.\s*global\s*\.\s*(?:duration|cueStart|cueEnd|toLocal|toGlobal)\b/.test(combined) ||
        hasAliasedGlobalObj);

    const anySpecificGlobal =
      usesGlobalWords || usesGlobalBeats || usesGlobalAudio || usesGlobalCuts || usesGlobalTiming;
    const forceAllGlobal = mentionsGlobalProp && !anySpecificGlobal;

    const usesLocalWords =
      preset === "word" ||
      /\.\s*(?:word\s*\(|words\b|sentences\b|pauses\b)/.test(combined);
    const usesLocalBeats =
      preset === "beat_cards" ||
      /\.\s*(?:beats\s*\(|beatGrid\s*\(|beats\b|bpm\b)/.test(combined);
    const usesLocalAudio =
      preset === "audio_glow" ||
      AUDIO_USAGE_REGEX.test(combined) ||
      /\.\s*audio\s*\(/.test(combined);
    const usesLocalCuts =
      preset === "cut_phases" ||
      /\.\s*(?:cuts\s*\(|cuts\b|segments\b)/.test(combined);
    const usesSequenceTiming =
      /\.\s*(?:sequenceStartSec|sequenceDuration|cueStart|cueEnd|toGlobal|toLocal)\b/.test(
        combined
      );

    return {
      usesLocalWords,
      usesLocalBeats,
      usesLocalAudio,
      usesLocalCuts,
      usesSequenceTiming,
      usesGlobalWords: usesGlobalWords || forceAllGlobal,
      usesGlobalBeats: usesGlobalBeats || forceAllGlobal,
      usesGlobalAudio: usesGlobalAudio || forceAllGlobal,
      usesGlobalCuts: usesGlobalCuts || forceAllGlobal,
      usesGlobalTiming: usesGlobalTiming || forceAllGlobal,
      usesAnyGlobal: mentionsGlobalProp,
    };
  } catch {
    return allTrue;
  }
}

/**
 * Hashes all files in a composition directory EXCEPT `assets/cuthol-data.json`,
 * `assets/cuthol-data.js`, `assets/cuthol-bbox.json`, and `.cuthol-*` metadata sidecars.
 */
export function hashCompositionFilesExcludingBridgeData(rootDir: string): string {
  const absRoot = path.resolve(rootDir);
  const visitedDirs = new Set<string>([safeRealpath(absRoot)]);
  const hash = crypto
    .createHash("sha256")
    .update(`cuthol-comp-files-v:${CUTHOL_RUNTIME_VERSION}\n`);

  const walk = (currentDir: string, relPrefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (
        entry.name.startsWith(".tmp.") ||
        entry.name.startsWith(".cuthol-") ||
        entry.name.endsWith(".tmp.mp4") ||
        entry.name.endsWith(".tmp.mov") ||
        entry.name === "cuthol-bbox.json"
      ) {
        continue;
      }
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (
        relPath === "assets/cuthol-data.json" ||
        relPath === "assets/cuthol-data.js" ||
        relPath === "assets/cuthol-bbox.json"
      ) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const targetStat = fs.statSync(fullPath);
          isDir = targetStat.isDirectory();
          isFile = targetStat.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        if (IGNORED_COMPOSITION_SUBDIRS.has(entry.name)) continue;
        const realDir = safeRealpath(fullPath);
        if (visitedDirs.has(realDir)) continue;
        visitedDirs.add(realDir);
        walk(fullPath, relPath);
      } else if (isFile) {
        try {
          const fileBuf = fs.readFileSync(fullPath);
          const fileDigest = crypto.createHash("sha256").update(fileBuf).digest("hex");
          hash.update(`file:${relPath}:${fileBuf.length}:${fileDigest}\n`);
        } catch {
          // ignore unreadable transient file
        }
      }
    }
  };

  walk(absRoot, "");
  return hash.digest("hex");
}

export function computeUsedBridgePayloadHashes(
  bridgeData: Partial<CutholBridgeV1> | null | undefined,
  usage: CompositionDataUsage
): { usedSliceHash: string; usedGlobalHash: string } {
  const d = bridgeData ?? {};
  const comp = d.composition ?? ({} as Partial<CutholBridgeV1["composition"]>);
  const usedLocalPayload: Record<string, unknown> = {
    schema: d.schema ?? CUTHOL_BRIDGE_SCHEMA,
    composition: {
      id: comp.id ?? "main",
      duration: comp.duration ?? 0,
      fps: comp.fps ?? 30,
      width: comp.width ?? 1920,
      height: comp.height ?? 1080,
      ...(usage.usesSequenceTiming ? { sequenceStartSec: comp.sequenceStartSec ?? 0 } : {}),
    },
    props: d.props ?? {},
    safeZone: d.safeZone ?? null,
  };

  if (usage.usesLocalWords) {
    usedLocalPayload.words = d.words ?? [];
    usedLocalPayload.sentences = d.sentences ?? [];
    usedLocalPayload.pauses = d.pauses ?? [];
  }
  if (usage.usesLocalBeats) {
    usedLocalPayload.beats = d.beats ?? null;
  }
  if (usage.usesLocalAudio) {
    usedLocalPayload.audio = d.audio ?? null;
  }
  if (usage.usesLocalCuts) {
    usedLocalPayload.cuts = (d.cuts ?? []).map((c) => ({
      t: c.t,
      ...(c.kind ? { kind: c.kind } : {}),
    }));
    usedLocalPayload.segments = (d.segments ?? []).map((s) => ({
      t0: s.t0,
      t1: s.t1,
      index: s.index,
      duration: s.duration,
    }));
  }

  const usedSliceHash =
    "sha256:" +
    crypto
      .createHash("sha256")
      .update(JSON.stringify(usedLocalPayload))
      .digest("hex")
      .slice(0, 16);

  if (!usage.usesAnyGlobal || !d.global) {
    return { usedSliceHash, usedGlobalHash: "unused" };
  }

  const g = d.global;
  const usedGlobalPayload: Record<string, unknown> = {};
  if (usage.usesGlobalTiming) {
    usedGlobalPayload.duration = g.duration ?? 0;
    usedGlobalPayload.sequenceStartSec = comp.sequenceStartSec ?? 0;
  }
  if (usage.usesGlobalWords) {
    usedGlobalPayload.words = g.words ?? [];
    usedGlobalPayload.pauses = g.pauses ?? [];
    usedGlobalPayload.sentences = g.sentences ?? [];
  }
  if (usage.usesGlobalBeats) {
    usedGlobalPayload.beats = g.beats ?? null;
  }
  if (usage.usesGlobalAudio) {
    usedGlobalPayload.audio = g.audio ?? null;
  }
  if (usage.usesGlobalCuts) {
    usedGlobalPayload.cuts = (g.cuts ?? []).map((c) => ({
      t: c.t,
      ...(c.kind ? { kind: c.kind } : {}),
    }));
    usedGlobalPayload.segments = (g.segments ?? []).map((s) => ({
      t0: s.t0,
      t1: s.t1,
      index: s.index,
      duration: s.duration,
    }));
  }

  const usedGlobalHash =
    "sha256:" +
    crypto
      .createHash("sha256")
      .update(JSON.stringify(usedGlobalPayload))
      .digest("hex")
      .slice(0, 16);

  return { usedSliceHash, usedGlobalHash };
}

/**
 * Checks whether a HyperFrames composition directory (entry HTML or user JS files)
 * references `C.audio` / `C.global.audio` / `data.audio`.
 */
export function compositionUsesAudio(compDir: string, entryHtml = "index.html"): boolean {
  const usage = analyzeCompositionDataUsage(compDir, entryHtml);
  return usage.usesLocalAudio || usage.usesGlobalAudio;
}

export function compositionUsesGlobal(compDir: string, entryHtml = "index.html"): boolean {
  return analyzeCompositionDataUsage(compDir, entryHtml).usesAnyGlobal;
}
