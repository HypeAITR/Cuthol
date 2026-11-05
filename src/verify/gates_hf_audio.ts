// G416: a composition cue that plays audio HyperFrames itself would mix,
// but Cuthol renders overlays as picture-only blobs, so that sound never enters the Cuthol mix.
import fs from "node:fs";
import path from "node:path";
import { CutholDiagnostic, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import { WorkspacePaths } from "../core/workspace.js";

export interface HfCompositionAudioMarker {
  /** File (relative to the composition dir) where the marker was found. */
  file: string;
  kind: "audio" | "video" | "audio-group" | "js";
  /** Human detail embedded in the G416 text, e.g. `index.html'de <audio src="assets/tone.wav">`. */
  detail: string;
}

const IGNORED_SCAN_SUBDIRS = new Set([
  ".hyperframes",
  "snapshots",
  "renders",
  "build",
  "node_modules",
  ".git",
  ".cuthol",
]);

const IGNORED_SCAN_FILES = new Set([
  "cuthol-data.js",
  "cuthol-data.json",
  "cuthol-runtime.js",
  "cuthol-vars.json",
  "cuthol-bbox.json",
  "gsap.min.js",
]);

function isIgnoredScanFile(name: string): boolean {
  return IGNORED_SCAN_FILES.has(name) || name.startsWith(".cuthol-");
}

function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function stripJsComments(js: string): string {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^\p{L}\p{N}_$:"'\\])\/\/[^\r\n]*/gu, "$1");
}

/** Attribute names on one open tag (lowercased), values excluded so `src="muted.mp4"` is safe. */
function tagAttributeNames(tag: string): Set<string> {
  const names = new Set<string>();
  const inner = tag.replace(/^<[^\s/>]+/, "").replace(/\/?>$/, "");
  const re = /([^\s=/>]+)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    if (m[1]) names.add(m[1].toLowerCase());
  }
  return names;
}

function tagSrc(tag: string): string | null {
  const m = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  if (!m) return null;
  return (m[2] ?? m[3] ?? m[4] ?? "").trim();
}

function isRemoteSrc(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src);
}

function stripSrcQuery(src: string): string {
  return src.split(/[?#]/)[0].trim();
}

/** True when the local media file carries at least one audio stream (ffprobe). */
export function compositionVideoFileHasAudio(
  absMediaPath: string,
  cache?: Map<string, boolean>
): boolean {
  const key = path.resolve(absMediaPath);
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;
  // Unprovable (missing binary, unreadable file) counts as audible: only a clean
  // "no audio stream" answer silences the warning.
  let hasAudio = true;
  try {
    const proc = spawnWatchedSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        absMediaPath,
      ],
      { encoding: "utf8", step: "ffprobe composition video audio" }
    );
    if (proc.status === 0) {
      hasAudio = String(proc.stdout || "").trim().length > 0;
    }
  } catch {
    hasAudio = true;
  }
  cache?.set(key, hasAudio);
  return hasAudio;
}

function scanHtmlForAudioMarkers(
  htmlPath: string,
  relPath: string,
  audioProbeCache: Map<string, boolean>
): HfCompositionAudioMarker[] {
  const markers: HfCompositionAudioMarker[] = [];
  let html: string;
  try {
    html = stripHtmlComments(fs.readFileSync(htmlPath, "utf8"));
  } catch {
    return markers;
  }
  const htmlDir = path.dirname(htmlPath);

  const audioTags = html.match(/<audio\b[^>]*>/gi) ?? [];
  for (const tag of audioTags) {
    if (tagAttributeNames(tag).has("muted")) continue;
    const src = tagSrc(tag);
    if (src !== null && stripSrcQuery(src) === "") continue;
    if (src === null) {
      const inner = html.slice(
        html.indexOf(tag) + tag.length,
        html.indexOf(tag) + tag.length + 4096
      );
      const endIdx = inner.search(/<\/audio\s*>/i);
      const scope = endIdx >= 0 ? inner.slice(0, endIdx) : "";
      if (!/<source\b[^>]*\bsrc\s*=/i.test(scope)) continue;
    }
    markers.push({
      file: relPath,
      kind: "audio",
      detail: `${relPath}'de <audio${src ? ` src="${src}"` : ""}>`,
    });
  }

  const videoRe = /<video\b[^>]*>/gi;
  let vm: RegExpExecArray | null;
  while ((vm = videoRe.exec(html)) !== null) {
    const tag = vm[0];
    if (tagAttributeNames(tag).has("muted")) continue;
    let src = tagSrc(tag);
    if (src === null) {
      const after = html.slice(vm.index + tag.length, vm.index + tag.length + 4096);
      const endIdx = after.search(/<\/video\s*>/i);
      const scope = endIdx >= 0 ? after.slice(0, endIdx) : "";
      const sourceTag = /<source\b[^>]*>/i.exec(scope)?.[0];
      src = sourceTag ? tagSrc(sourceTag) : null;
    }
    if (src === null || stripSrcQuery(src) === "") continue;
    if (isRemoteSrc(src)) {
      markers.push({ file: relPath, kind: "video", detail: `${relPath}'de <video src="${src}">` });
      continue;
    }
    const absMedia = path.resolve(htmlDir, stripSrcQuery(src));
    if (!fs.existsSync(absMedia)) continue;
    if (compositionVideoFileHasAudio(absMedia, audioProbeCache)) {
      markers.push({
        file: relPath,
        kind: "video",
        detail: `${relPath}'de sesli <video src="${src}">`,
      });
    }
  }

  if (/<hf-audio-group[\s/>]/i.test(html)) {
    markers.push({
      file: relPath,
      kind: "audio-group",
      detail: `${relPath}'de <hf-audio-group>`,
    });
  }
  return markers;
}

function scanJsForAudioMarkers(jsPath: string, relPath: string): HfCompositionAudioMarker[] {
  let js: string;
  try {
    js = stripJsComments(fs.readFileSync(jsPath, "utf8"));
  } catch {
    return [];
  }
  if (
    /<audio\b|<video\b|hf-audio-group|createElement\s*\(\s*["']?(audio|video)\b|new\s+Audio\s*\(/i.test(
      js
    )
  ) {
    return [
      {
        file: relPath,
        kind: "js",
        detail: `${relPath} JavaScript dosyasında ses öğesi`,
      },
    ];
  }
  return [];
}

/**
 * Lists composition audio that plays in HyperFrames but never enters the Cuthol mix
 * (Cuthol renders overlays picture-only). `muted` tags, videos whose file carries no
 * audio stream, and tags without a source are excluded so the check stays quiet.
 */
export function detectCompositionAudioNotInMix(
  compDir: string,
  entryHtml = "index.html",
  audioProbeCache?: Map<string, boolean>
): HfCompositionAudioMarker[] {
  const markers: HfCompositionAudioMarker[] = [];
  try {
    const absCompDir = path.resolve(compDir);
    if (!fs.existsSync(absCompDir)) return markers;
    if (!fs.existsSync(path.join(absCompDir, entryHtml || "index.html"))) return markers;
    const cache = audioProbeCache ?? new Map<string, boolean>();
    const walk = (dir: string, depth: number): void => {
      if (depth > 3 || !fs.existsSync(dir)) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (IGNORED_SCAN_SUBDIRS.has(ent.name) || isIgnoredScanFile(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full, depth + 1);
        } else if (ent.isFile()) {
          const lower = ent.name.toLowerCase();
          const rel = path.relative(absCompDir, full).replace(/\\/g, "/");
          if (lower.endsWith(".html") || lower.endsWith(".htm")) {
            markers.push(...scanHtmlForAudioMarkers(full, rel, cache));
          } else if (lower.endsWith(".js")) {
            markers.push(...scanJsForAudioMarkers(full, rel));
          }
        }
      }
    };
    walk(absCompDir, 0);
  } catch {
    return markers;
  }
  return markers;
}

/** G4_STAGE verify pass: emits CUTHOL-G416 per composition cue with unmixed audio. */
export function verifyCompositionAudio(
  seq: CutholSequence,
  paths: WorkspacePaths | undefined,
  diagnostics: CutholDiagnostic[]
): void {
  if (!paths) return;
  const audioProbeCache = new Map<string, boolean>();
  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (cue.kind !== "composition" || !cue.composition) continue;
      const compDir = path.isAbsolute(cue.composition.composition_dir)
        ? cue.composition.composition_dir
        : path.resolve(paths.rootDir, cue.composition.composition_dir);
      const markers = detectCompositionAudioNotInMix(
        compDir,
        cue.composition.entry_html,
        audioProbeCache
      );
      if (markers.length === 0) continue;
      const detail =
        markers.length === 1
          ? markers[0].detail
          : `${markers[0].detail} (+${markers.length - 1} ses öğesi daha)`;
      diagnostics.push(DIAGNOSTICS.COMPOSITION_AUDIO_SILENT(cue.id, detail));
    }
  }
}
