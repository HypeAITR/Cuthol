// Image ink margins: transparent-edge insets of raster assets, resolved once per file.
//
// An <img> element box covers the whole drawn bitmap, including fully transparent edges
// (a logo PNG is often centered in a large transparent canvas). Rules must compare the
// visible ink instead, so the transparent margins of each asset file are resolved here on
// the Node side (ffmpeg decodes to rgba, the alpha > 12 bounding box is measured) and the
// in-page extractor applies them to the drawn image rectangle (`object-fit` aware).
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnWatchedSync } from "../core/subprocess.js";

/** Pixels with alpha above this count as ink (same threshold the overlay boxes use). */
export const INK_ALPHA_THRESHOLD = 12;

/** Upper bound of the margin cache; oldest entries are evicted first. */
export const IMAGE_INK_CACHE_LIMIT = 512;

export interface ImageInkMargins {
  /** Fractional insets of the ink box within the asset: 0..1 of the intrinsic size. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Intrinsic bitmap size in px (the fractions above are relative to this). */
  width: number;
  height: number;
  /** sha256 of the asset bytes the margins were resolved from. */
  digest: string;
}

const marginsCache = new Map<string, ImageInkMargins | null>();

function cacheStore(digest: string, value: ImageInkMargins | null): ImageInkMargins | null {
  if (marginsCache.size >= IMAGE_INK_CACHE_LIMIT) {
    const oldest = marginsCache.keys().next().value as string | undefined;
    if (oldest !== undefined) marginsCache.delete(oldest);
  }
  marginsCache.set(digest, value);
  return value;
}

/** Test hook: drops all cached margins. */
export function clearImageInkMarginCache(): void {
  marginsCache.clear();
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function decodePixels(
  absPath: string
): { width: number; height: number; rgba: Buffer } | null {
  let dim: { width: number; height: number } | null = null;
  try {
    const probe = spawnWatchedSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        absPath,
      ],
      { encoding: "utf8", step: "ffprobe image size", maxBuffer: 1024 * 1024 }
    );
    const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(String(probe.stdout || ""));
    if (probe.status === 0 && m) {
      dim = { width: Number(m[1]), height: Number(m[2]) };
    }
  } catch {
    dim = null;
  }
  if (!dim || dim.width <= 0 || dim.height <= 0) return null;
  const want = dim.width * dim.height * 4;
  try {
    const proc = spawnWatchedSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        absPath,
        "-vf",
        "format=rgba",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "pipe:1",
      ],
      { step: "ffmpeg image rgba", maxBuffer: want + 65536 }
    );
    const buf = proc.stdout as Buffer;
    if (proc.status !== 0 || !Buffer.isBuffer(buf) || buf.length < want) return null;
    return { width: dim.width, height: dim.height, rgba: buf.subarray(0, want) };
  } catch {
    return null;
  }
}

function marginsFromRgba(
  width: number,
  height: number,
  rgba: Buffer,
  digest: string
): ImageInkMargins | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (rgba[row + x * 4 + 3] > INK_ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  // Speck robustness: an edge row/column counts only with >= 3 ink pixels (a lone
  // dust pixel vanishes when the asset renders scaled down, but would otherwise own
  // the margin; the in-page canvas path mirrors this rule exactly).
  const rowCount = (y: number): number => {
    let n = 0;
    for (let x = minX; x <= maxX && n < 3; x++) {
      if (rgba[(y * width + x) * 4 + 3] > INK_ALPHA_THRESHOLD) n++;
    }
    return n;
  };
  const colCount = (x: number): number => {
    let n = 0;
    for (let y = minY; y <= maxY && n < 3; y++) {
      if (rgba[(y * width + x) * 4 + 3] > INK_ALPHA_THRESHOLD) n++;
    }
    return n;
  };
  while (minY <= maxY && rowCount(minY) < 3) minY++;
  while (maxY >= minY && rowCount(maxY) < 3) maxY--;
  while (minX <= maxX && colCount(minX) < 3) minX++;
  while (maxX >= minX && colCount(maxX) < 3) maxX--;
  if (maxX < minX || maxY < minY) return null;
  return {
    left: minX / width,
    top: minY / height,
    right: (width - maxX - 1) / width,
    bottom: (height - maxY - 1) / height,
    width,
    height,
    digest,
  };
}

/**
 * Resolves the transparent margins of one raster file. Returns null when the file cannot
 * be decoded or no pixel passes the alpha threshold (the caller falls back to the item
 * box). Results (including misses) are cached by file digest.
 */
export function resolveImageFileInkMargins(absPath: string): ImageInkMargins | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  const digest = sha256Hex(bytes);
  const hit = marginsCache.get(digest);
  if (hit !== undefined) return hit;
  // Formats without an alpha channel are fully opaque by construction.
  if (/\.(jpe?g|bmp)$/i.test(absPath)) {
    const dim = decodePixels(absPath);
    if (!dim) return cacheStore(digest, null);
    return cacheStore(digest, {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: dim.width,
      height: dim.height,
      digest,
    });
  }
  const decoded = decodePixels(absPath);
  if (!decoded) return cacheStore(digest, null);
  return cacheStore(digest, marginsFromRgba(decoded.width, decoded.height, decoded.rgba, digest));
}

