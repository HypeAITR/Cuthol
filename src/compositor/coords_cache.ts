// Coordinate cache: key computation and atomic cache files.
//
// The key summarizes the same composition content the overlay cache keys on (composition
// files excluding bridge data + the used bridge payload hashes) plus cue duration, stage
// size/fps, the coordinate engine version, and the renderer version. Placement is NOT part
// of the key: mapping is cheap, so measured local boxes are reused across placement edits.
// Files live at `<project>/.cuthol/coords/<key>.json` and are written atomically.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { renameWithRetrySync } from "./hf_common.js";
import type { CoordsDocument } from "./coords_extract.js";

/** Bumped when the measurement rules change; old cache files are treated as misses. */
export const COORDS_ENGINE_VERSION = "3";

export const COORDS_SCHEMA = "cuthol.coords/2";

export interface CoordsCacheKeyMaterial {
  filesHash: string;
  usedSliceHash: string;
  usedGlobalHash: string;
  propsHash: string;
  durationMs: number;
  stageWidth: number;
  stageHeight: number;
  stageFps: number;
  hyperframesVersion: string;
}

export function computeCoordsCacheKey(material: CoordsCacheKeyMaterial): string {
  const payload = {
    files: material.filesHash,
    slice: material.usedSliceHash,
    global: material.usedGlobalHash,
    props: material.propsHash,
    dur: material.durationMs,
    stage: [material.stageWidth, material.stageHeight, material.stageFps],
    engine: COORDS_ENGINE_VERSION,
    hf: material.hyperframesVersion,
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

export function coordsCacheDir(projectDir: string): string {
  return path.join(path.resolve(projectDir), ".cuthol", "coords");
}

export function coordsCachePath(projectDir: string, key: string): string {
  return path.join(coordsCacheDir(projectDir), `${key}.json`);
}

/** Reads a cache entry; returns null on any miss (missing, unreadable, stale schema/engine). */
export function readCoordsCache(projectDir: string, key: string): CoordsDocument | null {
  const file = coordsCachePath(projectDir, key);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CoordsDocument>;
    if (parsed.schema !== COORDS_SCHEMA) return null;
    if (parsed.engine_version !== COORDS_ENGINE_VERSION) return null;
    if (!Array.isArray(parsed.elements) || !Array.isArray(parsed.frames)) return null;
    return parsed as CoordsDocument;
  } catch {
    return null;
  }
}

/**
 * Writes a cache entry atomically (temp file + rename, so a half-written file never
 * lands in the cache). Returns the absolute file path.
 */
export function writeCoordsCache(projectDir: string, key: string, doc: CoordsDocument): string {
  const dir = coordsCacheDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = coordsCachePath(projectDir, key);
  const tmp = path.join(dir, `.tmp.coords_${process.pid}_${Date.now()}_${key}.json`);
  fs.writeFileSync(tmp, JSON.stringify(doc), "utf8");
  try {
    renameWithRetrySync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
  return file;
}
