/**
 * Cuthol Live composition file server (`src/live/live_comp_serve.ts`).
 *
 * The preview region shows HyperFrames compositions in same-origin iframes so
 * it can seek their timelines (`__player.renderSeek` -> `__hf.seek` ->
 * `__player.seek` -> `__timelines`, the same chain as the coordinate engine).
 * Same-origin iframes need the composition directory served by the live server.
 *
 * Endpoint contract (owned by the live server file; this module only exports
 * the handler so it can be mounted):
 *   GET /comp/<cueId>/<path...>  -> composition file, entry at /comp/<cueId>/
 *     - cue resolved from the current sequence (kind `composition` or `title`
 *       with a `composition.composition_dir`); lane must not be muted
 *     - path is confined to the composition dir (traversal -> 403)
 *     - unknown cue / missing dir -> 404 + JSON (CUTHOL-G611)
 */
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { loadSequence } from "../core/workspace.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export interface LiveCompResolve {
  cueId: string;
  dir: string;
  entryHtml: string;
}

/** Resolve a composition cue to its on-disk directory (null when not servable). */
export function resolveLiveComp(projectDir: string, cueId: string): LiveCompResolve | null {
  let sequence: any;
  try {
    sequence = loadSequence(projectDir).sequence as any;
  } catch {
    return null;
  }
  for (const lane of sequence?.lanes ?? []) {
    if (lane?.muted) continue;
    for (const cue of lane?.cues ?? []) {
      if (cue?.id !== cueId) continue;
      const dirRel = cue?.composition?.composition_dir;
      if (typeof dirRel !== "string" || !dirRel) return null;
      const dir = path.resolve(projectDir, dirRel);
      const root = path.resolve(projectDir);
      if (dir !== root && !dir.startsWith(root + path.sep)) return null;
      try {
        if (!fs.statSync(dir).isDirectory()) return null;
      } catch {
        return null;
      }
      return { cueId, dir, entryHtml: cue.composition.entry_html ?? "index.html" };
    }
  }
  return null;
}

/**
 * Mount point for `GET /comp/<cueId>/...`. `subPath` is the decoded path after
 * the cue id ("" or "/" serves the entry html). Returns true when handled.
 */
export function routeLiveCompRequest(
  projectDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cueId: string,
  subPath: string
): boolean {
  const resolved = resolveLiveComp(projectDir, cueId);
  if (!resolved) {
    const diag = DIAGNOSTICS.LIVE_COMP_SERVE_BLOCKED(cueId, "unknown cue or composition dir outside the project");
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, diagnostic: diag }));
    return true;
  }
  const rel = subPath === "" || subPath === "/" ? resolved.entryHtml : subPath.replace(/^\/+/, "");
  const file = path.resolve(resolved.dir, rel);
  if (file !== resolved.dir && !file.startsWith(resolved.dir + path.sep)) {
    res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "path escapes the composition dir" }));
    return true;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "not found" }));
    return true;
  }
  if (stat.isDirectory()) {
    const index = path.join(file, "index.html");
    try {
      fs.statSync(index);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "not found" }));
      return true;
    }
    serveStatic(res, index);
    return true;
  }
  serveStatic(res, file);
  return true;
}

/**
 * Same bootstrap the coordinate extractor injects (`evaluateOnNewDocument` in
 * coords_extract.ts): composition scripts register into `window.__timelines`.
 * Injected into served bytes only; project files are never modified.
 */
const COMP_BOOTSTRAP = `<script>window.__timelines=window.__timelines||{};</script><style>html,body{height:100%!important;margin:0!important;}</style>`;

function serveStatic(res: http.ServerResponse, file: string): void {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  if (ext === ".html" || ext === ".htm") {
    let html = fs.readFileSync(file, "utf8");
    if (!html.includes("__timelines=window.__timelines||{}")) {
      const headMatch = /<head[^>]*>/i.exec(html);
      html = headMatch
        ? html.slice(0, headMatch.index + headMatch[0].length) + COMP_BOOTSTRAP + html.slice(headMatch.index + headMatch[0].length)
        : COMP_BOOTSTRAP + html;
    }
    const buf = Buffer.from(html, "utf8");
    res.writeHead(200, { "Content-Type": type, "Content-Length": buf.length, "Cache-Control": "no-cache" });
    res.end(buf);
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": fs.statSync(file).size, "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}
