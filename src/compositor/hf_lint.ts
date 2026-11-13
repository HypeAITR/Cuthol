// HyperFrames lint wrapper with memoized results and Cuthol severity mapping (split out of hyperframes_bridge.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  spawnWatchedSync
} from "../core/subprocess.js";
import { HyperFramesLintResult, HyperFramesLintFinding, findLocalHyperFramesCliMjs, hyperFramesProcessEnv } from "./hf_common.js";

const SIZE_AND_SPLIT_LINT_CODES = new Set([
  "composition_file_too_large",
  "nested_structure_needs_subcomposition",
  "timeline_track_too_dense",
]);

const LINT_IGNORED_BRIDGE_FILES = new Set([
  "assets/cuthol-data.json",
  "assets/cuthol-data.js",
  "assets/cuthol-vars.json",
  "assets/cuthol-runtime.js",
  "assets/cuthol-bbox.json",
  "assets/.cuthol-bridge-meta.json",
  "cuthol-bbox.json",
]);

const lintMemoryCache = new Map<string, Omit<HyperFramesLintResult, "cached">>();

function computeCompositionLintHash(absCompDir: string, entryHtml: string): string {
  const hash = crypto.createHash("sha256").update(`hf-lint-v1:${entryHtml}\n`);
  const visitedDirs = new Set<string>();
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
        entry.name.endsWith(".tmp.mp4") ||
        entry.name.endsWith(".tmp.mov")
      ) {
        continue;
      }
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (LINT_IGNORED_BRIDGE_FILES.has(relPath)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === ".hyperframes" ||
          entry.name === "snapshots" ||
          entry.name === "renders" ||
          entry.name === "build" ||
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === ".cuthol"
        ) {
          continue;
        }
        let realDir = fullPath;
        try {
          realDir = fs.realpathSync(fullPath);
        } catch {
          realDir = path.resolve(fullPath);
        }
        if (visitedDirs.has(realDir)) continue;
        visitedDirs.add(realDir);
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        try {
          const buf = fs.readFileSync(fullPath);
          const digest = crypto.createHash("sha256").update(buf).digest("hex");
          hash.update(`file:${relPath}:${buf.length}:${digest}\n`);
        } catch {
          // ignore unreadable transient file
        }
      }
    }
  };
  walk(absCompDir, "");
  return hash.digest("hex");
}

export function isDuplicateImgMediaDiscoveryFinding(
  finding: {
    code?: string;
    message?: string;
    snippet?: string;
    selector?: string;
  },
  absCompDir?: string,
  entryHtml = "index.html"
): boolean {
  if (finding.code !== "duplicate_media_discovery_risk") return false;
  const msg = String(finding.message ?? "");
  const snippet = String(finding.snippet ?? "");
  const selector = String(finding.selector ?? "");

  if (
    /\bmatching\s+(?:video|audio)\s+entries\b/i.test(msg) ||
    /^\s*<?(?:video|audio)\b/i.test(snippet) ||
    /^\s*(?:video|audio)\b/i.test(selector)
  ) {
    return false;
  }
  if (
    /\bmatching\s+img\s+entries\b/i.test(msg) ||
    /^\s*<?img\b/i.test(snippet) ||
    /^\s*img\b/i.test(selector)
  ) {
    return true;
  }

  if (absCompDir) {
    try {
      const htmlPath = path.join(path.resolve(absCompDir), entryHtml || "index.html");
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, "utf8");
        const videoAudioSrcs = new Set<string>();
        let hasDupVideoAudio = false;
        const vaRe = /<(?:video|audio)\b[^>]*?\bsrc\s*=\s*(["'])([^"']+)\1/gi;
        let m: RegExpExecArray | null;
        while ((m = vaRe.exec(html)) !== null) {
          const src = m[2].trim();
          if (videoAudioSrcs.has(src)) {
            hasDupVideoAudio = true;
            break;
          }
          videoAudioSrcs.add(src);
        }
        if (hasDupVideoAudio) return false;

        const imgSrcs = new Set<string>();
        const imgRe = /<img\b[^>]*?\bsrc\s*=\s*(["'])([^"']+)\1/gi;
        while ((m = imgRe.exec(html)) !== null) {
          const src = m[2].trim();
          if (imgSrcs.has(src)) return true;
          imgSrcs.add(src);
        }
      }
    } catch {
      // ignore read failure
    }
  }
  return false;
}

function normalizeLintEntryForCuthol(
  raw: Omit<HyperFramesLintResult, "cached">,
  absCompDir: string,
  entryHtml: string
): Omit<HyperFramesLintResult, "cached"> {
  const findings: HyperFramesLintFinding[] = [];
  const infoFindings: HyperFramesLintFinding[] = [...(raw.info_findings ?? [])];

  for (const f of raw.findings ?? []) {
    if (
      SIZE_AND_SPLIT_LINT_CODES.has(f.code) ||
      isDuplicateImgMediaDiscoveryFinding(f, absCompDir, entryHtml)
    ) {
      const infoItem: HyperFramesLintFinding = { ...f, severity: "info" };
      if (
        !infoFindings.some(
          (x) => x.code === infoItem.code && x.message === infoItem.message && x.snippet === infoItem.snippet
        )
      ) {
        infoFindings.push(infoItem);
      }
    } else {
      findings.push(f);
    }
  }

  return {
    ok: findings.every((f) => f.severity !== "error"),
    content_hash: raw.content_hash,
    findings,
    info_findings: infoFindings,
  };
}

export function lintHyperFramesComposition(
  compositionDir: string,
  entryHtml = "index.html",
  cacheDir?: string
): HyperFramesLintResult {
  const absCompDir = path.resolve(compositionDir);
  const entryPath = path.join(absCompDir, entryHtml);
  if (!fs.existsSync(entryPath)) {
    return {
      ok: false,
      cached: false,
      content_hash: "missing",
      findings: [
        {
          code: "missing_entry_html",
          severity: "error",
          message: `Missing composition entry HTML: ${entryPath}`,
        },
      ],
      info_findings: [],
    };
  }

  const contentHash = computeCompositionLintHash(absCompDir, entryHtml);
  const memHit = lintMemoryCache.get(contentHash);
  if (memHit) {
    return { ...memHit, cached: true };
  }

  const diskCachePath = cacheDir
    ? path.join(cacheDir, `hf_lint_${contentHash.slice(0, 24)}.json`)
    : null;
  if (diskCachePath && fs.existsSync(diskCachePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(diskCachePath, "utf8")) as Omit<
        HyperFramesLintResult,
        "cached"
      >;
      if (parsed && Array.isArray(parsed.findings) && parsed.content_hash === contentHash) {
        const normalized = normalizeLintEntryForCuthol(parsed, absCompDir, entryHtml);
        lintMemoryCache.set(contentHash, normalized);
        return { ...normalized, cached: true };
      }
    } catch {
      // ignore corrupt cache file
    }
  }

  const findings: HyperFramesLintFinding[] = [];
  const infoFindings: HyperFramesLintFinding[] = [];
  const hfBin = findLocalHyperFramesCliMjs();

  if (fs.existsSync(hfBin)) {
    const proc = spawnWatchedSync(process.execPath, [hfBin, "lint", absCompDir, "--json"], {
      encoding: "utf8",
      env: hyperFramesProcessEnv(),
      step: "hyperframes lint",
    });
    const rawOut = (proc.stdout || "").trim();
    const jsonStart = rawOut.indexOf("{");
    if (jsonStart >= 0) {
      try {
        const parsed = JSON.parse(rawOut.slice(jsonStart)) as {
          findings?: Array<{
            code?: string;
            severity?: "error" | "warning" | "info";
            message?: string;
            fixHint?: string;
            selector?: string;
            elementId?: string;
            snippet?: string;
            file?: string;
            line?: number;
            column?: number;
          }>;
        };
        for (const f of parsed.findings ?? []) {
          const code = String(f.code ?? "hyperframes_lint");
          const isImgDup = isDuplicateImgMediaDiscoveryFinding(
            {
              code,
              message: f.message,
              snippet: f.snippet,
              selector: f.selector,
            },
            absCompDir,
            entryHtml
          );
          const item: HyperFramesLintFinding = {
            code,
            severity:
              SIZE_AND_SPLIT_LINT_CODES.has(code) || isImgDup
                ? "info"
                : f.severity === "error" || f.severity === "warning"
                  ? f.severity
                  : "info",
            message: String(f.message ?? ""),
            ...(f.fixHint ? { fixHint: String(f.fixHint) } : {}),
            ...(f.selector ? { selector: String(f.selector) } : {}),
            ...(f.elementId ? { elementId: String(f.elementId) } : {}),
            ...(f.snippet ? { snippet: String(f.snippet) } : {}),
            ...(f.file ? { file: String(f.file) } : {}),
            ...(typeof f.line === "number" ? { line: f.line } : {}),
            ...(typeof f.column === "number" ? { column: f.column } : {}),
          };
          if (item.severity === "info") {
            infoFindings.push(item);
          } else {
            findings.push(item);
          }
        }
      } catch {
        if (proc.status !== 0) {
          findings.push({
            code: "hyperframes_lint_failed",
            severity: "warning",
            message: (proc.stderr || proc.stdout || "hyperframes lint failed").trim(),
          });
        }
      }
    } else if (proc.status !== 0) {
      findings.push({
        code: "hyperframes_lint_failed",
        severity: "warning",
        message: (proc.stderr || proc.stdout || "hyperframes lint failed").trim(),
      });
    }
  }

  const entry = normalizeLintEntryForCuthol(
    {
      ok: findings.every((f) => f.severity !== "error"),
      content_hash: contentHash,
      findings,
      info_findings: infoFindings,
    },
    absCompDir,
    entryHtml
  );
  lintMemoryCache.set(contentHash, entry);
  if (diskCachePath) {
    try {
      fs.mkdirSync(path.dirname(diskCachePath), { recursive: true });
      fs.writeFileSync(diskCachePath, JSON.stringify(entry, null, 2), "utf8");
    } catch {
      // ignore cache write failure
    }
  }

  return { ...entry, cached: false };
}
