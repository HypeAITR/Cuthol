// G416: a composition cue that plays audio the engine itself mixes. Cuthol takes
// that sound into its own mix as a per-cue stem (engine-neutral composition
// audio contract); the cue stays silent only while no stem exists yet, when the
// cue opts out with `composition_audio: "off"`, or when extraction fails (G435).
import fs from "node:fs";
import path from "node:path";
import {
  compositionAudioRequestForCue,
  readCompositionStemState,
  resolveCompositionAudioMode,
} from "../compositor/composition_audio.js";
import { hyperFramesCompositionAudioAdapter } from "../compositor/composition_audio_hf.js";
import { CutholDiagnostic, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import { WorkspacePaths } from "../core/workspace.js";

export interface HfCompositionAudioMarker {
  /** File (relative to the composition dir) where the marker was found. */
  file: string;
  kind: "audio" | "video" | "audio-group" | "js";
  /** Human detail embedded in the G416 text, e.g. `in index.html: <audio src="assets/tone.wav">`. */
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
      detail: `in ${relPath}: <audio${src ? ` src="${src}"` : ""}>`,
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
      markers.push({ file: relPath, kind: "video", detail: `in ${relPath}: <video src="${src}">` });
      continue;
    }
    const absMedia = path.resolve(htmlDir, stripSrcQuery(src));
    if (!fs.existsSync(absMedia)) continue;
    if (compositionVideoFileHasAudio(absMedia, audioProbeCache)) {
      markers.push({
        file: relPath,
        kind: "video",
        detail: `audible <video src="${src}"> in ${relPath}`,
      });
    }
  }

  if (/<hf-audio-group[\s/>]/i.test(html)) {
    markers.push({
      file: relPath,
      kind: "audio-group",
      detail: `in ${relPath}: <hf-audio-group>`,
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
        detail: `audio element in ${relPath} JavaScript file`,
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

/** G4_STAGE verify pass: reports each composition cue's stem state (never renders). */
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
      if (cue.audio_chain?.muted) continue;
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
          : `${markers[0].detail} (+${markers.length - 1} more audio elements)`;
      if (resolveCompositionAudioMode(cue) === "off") {
        diagnostics.push(DIAGNOSTICS.COMPOSITION_AUDIO_OFF(cue.id, detail));
        continue;
      }
      const request = compositionAudioRequestForCue(cue, paths, {
        fps: seq.stage.fps,
        width: seq.stage.width,
        height: seq.stage.height,
      });
      if (!request) continue;
      const state = readCompositionStemState(cue, request, hyperFramesCompositionAudioAdapter);
      if (state.kind === "mixed") {
        diagnostics.push(
          DIAGNOSTICS.COMPOSITION_AUDIO_IN_MIX(
            cue.id,
            state.stemDurationMs,
            `The stem follows this cue's gain, mute, envelopes and ducking; to drop it, run 'cuthol lane update-cue --cue ${cue.id} --composition-audio off'.`
          )
        );
      } else if (state.kind === "error") {
        diagnostics.push(DIAGNOSTICS.COMPOSITION_STEM_FAILED(cue.id, state.reason));
      } else if (state.kind === "silent") {
        diagnostics.push(DIAGNOSTICS.COMPOSITION_RENDER_SILENT(cue.id, detail));
      } else if (state.kind === "pending") {
        diagnostics.push(DIAGNOSTICS.COMPOSITION_AUDIO_SILENT(cue.id, detail));
      }
    }
  }
}
