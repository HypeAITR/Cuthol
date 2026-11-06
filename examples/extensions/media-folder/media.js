#!/usr/bin/env node
// Reference media provider for the Cuthol provider contract.
// Serves music/sfx files from a local folder: each audio file plus an optional
// sidecar `<file>.json` with { title, kind, tags, mood, license, source_url }.
// Shows how a real service-backed provider plugs in; uses no network access.
//
// Usage: node media.js <requestJsonPath> <responseJsonPath>
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const AUDIO_EXTS = new Set([
  ".wav", ".mp3", ".flac", ".ogg", ".oga", ".m4a", ".aac", ".opus", ".aiff", ".aif", ".wma",
]);

function fail(msg) {
  process.stderr.write(`media-folder: ${msg}\n`);
  process.exit(1);
}

function resolveTracksDir(request, config) {
  const raw = config.directory;
  if (typeof raw !== "string" || !raw.trim()) {
    fail("manifest providers.media.config.directory is not configured.");
  }
  const dir = path.isAbsolute(raw.trim())
    ? raw.trim()
    : path.resolve(request.extension_dir || ".", raw.trim());
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    fail(`tracks directory was not found: ${dir}`);
  }
  return dir;
}

function readSidecar(tracksDir, fileName) {
  const sidecarPath = path.join(tracksDir, `${fileName}.json`);
  if (!fs.existsSync(sidecarPath)) return {};
  try {
    const raw = fs.readFileSync(sidecarPath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    fail(`sidecar '${fileName}.json' is not valid JSON: ${err.message}`);
  }
  return {};
}

// Minimal WAV duration reader (chunk-walking, no dependencies). Returns ms or null.
function wavDurationMs(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const header = Buffer.alloc(12);
      if (fs.readSync(fd, header, 0, 12, 0) !== 12) return null;
      if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
        return null;
      }
      const fileSize = fs.fstatSync(fd).size;
      let offset = 12;
      let byteRate = 0;
      let dataBytes = 0;
      while (offset + 8 <= fileSize) {
        const chunkHead = Buffer.alloc(8);
        if (fs.readSync(fd, chunkHead, 0, 8, offset) !== 8) break;
        const id = chunkHead.toString("ascii", 0, 4);
        const size = chunkHead.readUInt32LE(4);
        if (id === "fmt " && size >= 16) {
          const fmt = Buffer.alloc(16);
          fs.readSync(fd, fmt, 0, 16, offset + 8);
          byteRate = fmt.readUInt32LE(8);
        } else if (id === "data") {
          dataBytes = size;
        }
        offset += 8 + size + (size % 2);
      }
      if (byteRate > 0 && dataBytes > 0) {
        return Math.round((dataBytes / byteRate) * 1000);
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function prettyTitle(fileName) {
  const base = fileName.replace(/\.[A-Za-z0-9]{2,5}$/, "");
  return base.replace(/[_-]+/g, " ").trim() || fileName;
}

function scanTracks(tracksDir, defaultKind) {
  const entries = fs.readdirSync(tracksDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!AUDIO_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
    const meta = readSidecar(tracksDir, entry.name);
    const kind = meta.kind === "sfx" || meta.kind === "music" ? meta.kind : defaultKind;
    const tags = Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === "string") : [];
    let durationMs = null;
    if (meta.duration_ms !== undefined && meta.duration_ms !== null) {
      const n = Number(meta.duration_ms);
      durationMs = Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    } else if (path.extname(entry.name).toLowerCase() === ".wav") {
      durationMs = wavDurationMs(path.join(tracksDir, entry.name));
    }
    out.push({
      id: entry.name,
      title: typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : prettyTitle(entry.name),
      kind,
      tags,
      mood: typeof meta.mood === "string" ? meta.mood : "",
      license: typeof meta.license === "string" ? meta.license : "",
      source_url: typeof meta.source_url === "string" ? meta.source_url : "",
      duration_ms: durationMs,
    });
  }
  return out;
}

function runSearch(request, config, tracksDir, tracks) {
  const query = String(request.query || "").trim().toLowerCase();
  const minMs = request.min_duration_ms ?? null;
  const maxMs = request.max_duration_ms ?? null;
  const limit = Number.isFinite(Number(request.limit)) ? Math.max(1, Number(request.limit)) : 20;
  const hits = tracks.filter((t) => {
    if (t.kind !== request.kind) return false;
    if (query) {
      const hay = `${t.title} ${t.id} ${t.tags.join(" ")} ${t.mood}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    if (t.duration_ms !== null) {
      if (minMs !== null && t.duration_ms < minMs) return false;
      if (maxMs !== null && t.duration_ms > maxMs) return false;
    }
    return true;
  });
  return {
    candidates: hits.slice(0, limit).map((t) => ({
      id: t.id,
      title: t.title,
      duration_ms: t.duration_ms,
      license: t.license || null,
      source_url: t.source_url || null,
      tags: t.tags,
    })),
  };
}

function runGet(request, config, tracksDir, tracks) {
  const id = String(request.id || "");
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    return { found: false };
  }
  const track = tracks.find((t) => t.id === id);
  const absPath = path.resolve(tracksDir, id);
  if (!track || !absPath.startsWith(path.resolve(tracksDir) + path.sep) || !fs.existsSync(absPath)) {
    return { found: false };
  }
  if (!request.output_audio_path) fail("request has no output_audio_path.");
  fs.copyFileSync(absPath, request.output_audio_path);
  return {
    found: true,
    title: track.title,
    license: track.license || null,
    source_url: track.source_url || null,
    duration_ms: track.duration_ms,
    filename: track.id,
  };
}

function main() {
  const [requestPath, responsePath] = process.argv.slice(2);
  if (!requestPath || !responsePath) fail("expected <requestJsonPath> <responseJsonPath>.");
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  const config = request.config || {};
  const defaultKind = config.default_kind === "sfx" ? "sfx" : "music";
  const tracksDir = resolveTracksDir(request, config);
  const tracks = scanTracks(tracksDir, defaultKind);
  let response;
  if (request.operation === "search") {
    response = runSearch(request, config, tracksDir, tracks);
  } else if (request.operation === "fetch") {
    response = runGet(request, config, tracksDir, tracks);
  } else {
    fail(`unknown operation '${request.operation}' (expected "search" or "fetch").`);
  }
  fs.writeFileSync(responsePath, JSON.stringify(response), "utf8");
}

main();
