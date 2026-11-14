/**
 * Package-local dependency resolution (`src/core/package_resolve.ts`).
 *
 * When Cuthol runs from a clone, `hyperframes` and `gsap` live in
 * `<package root>/node_modules/...`. When Cuthol is installed via npm as a
 * dependency of another project, npm hoists them into a parent `node_modules`,
 * so the package-root path does not exist. Node's own resolver
 * (`createRequire(import.meta.url).resolve(...)`) follows the same lookup the
 * runtime uses, so it finds the hoisted copy; the package-root path stays as a
 * fallback for layouts where the resolver cannot see the dependency.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT_DIR = path.resolve(MODULE_DIR, "../..");

/** Package root (two levels above `dist/core` or `src/core`). */
export function packageRootDir(): string {
  return PACKAGE_ROOT_DIR;
}

/**
 * Resolves `relPath` (relative to the package root, e.g.
 * `node_modules/gsap/dist/gsap.min.js`) against Node's module resolver first,
 * then the package-root path as a fallback. Returns the first path that exists,
 * or `null` when neither exists.
 */
export function resolvePackageFile(packageName: string, subPath: string, fallbackRelPath: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve(`${packageName}/${subPath}`);
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // Fall through to the package-root fallback below.
  }
  const fallback = path.resolve(PACKAGE_ROOT_DIR, fallbackRelPath);
  return fs.existsSync(fallback) ? fallback : null;
}

/** Locates the HyperFrames CLI entry (`hyperframes.mjs`); `null` when absent. */
export function resolveHyperFramesCliMjs(): string | null {
  const viaResolver = resolvePackageFile("hyperframes", "bin/hyperframes.mjs", "node_modules/hyperframes/bin/hyperframes.mjs");
  if (viaResolver) return viaResolver;
  const cwdCandidate = path.resolve(process.cwd(), "node_modules/hyperframes/bin/hyperframes.mjs");
  return fs.existsSync(cwdCandidate) ? cwdCandidate : null;
}

/** Locates the bundled `gsap.min.js`; `null` when absent. */
export function resolveBundledGsapMinJs(): string | null {
  const viaResolver = resolvePackageFile("gsap", "dist/gsap.min.js", "node_modules/gsap/dist/gsap.min.js");
  if (viaResolver) return viaResolver;
  const cwdCandidate = path.resolve(process.cwd(), "node_modules/gsap/dist/gsap.min.js");
  return fs.existsSync(cwdCandidate) ? cwdCandidate : null;
}
