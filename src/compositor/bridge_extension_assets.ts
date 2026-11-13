// Copies enabled extension assets into compositions and detects stale copies (split out of bridge_exporter.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CutholSequence
} from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { resolveExtension } from "../extensions/manager.js";
import { findBundledGsapMinJs } from "./bridge_hash.js";

/**
 * First line prepended to every Cuthol-written helper copy. A helper copy starting
 * with this marker was written by Cuthol (not by the user), so a stale one may be
 * refreshed in place; anything else is left alone and reported as drift (G205).
 */
export const CUTHOL_EXT_HELPER_MARKER =
  `if (typeof window !== "undefined") { window.__cuthol = window.__cuthol || {}; window.__cuthol.ext = window.__cuthol.ext || {}; }`;

const EXT_SYNC_SIDECAR = ".cuthol-ext-sync.json";

interface ExtSyncSidecar {
  version: 1;
  extensions: Record<string, { contentHash: string; files: Record<string, string> }>;
}

function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function readExtSyncSidecar(assetsDir: string): ExtSyncSidecar {
  try {
    const raw = fs.readFileSync(path.join(assetsDir, EXT_SYNC_SIDECAR), "utf8");
    const parsed = JSON.parse(raw) as Partial<ExtSyncSidecar>;
    if (parsed.version === 1 && parsed.extensions && typeof parsed.extensions === "object") {
      return { version: 1, extensions: parsed.extensions };
    }
  } catch {
    // missing or corrupt sidecar: treat as no records
  }
  return { version: 1, extensions: {} };
}

function writeExtSyncSidecar(assetsDir: string, sidecar: ExtSyncSidecar): void {
  try {
    fs.writeFileSync(path.join(assetsDir, EXT_SYNC_SIDECAR), JSON.stringify(sidecar), "utf8");
  } catch {
    // sidecar is best-effort bookkeeping; the copies themselves are authoritative
  }
}

/**
 * Synchronizes enabled project extension asset packs (`assets/ext/<name>/`), helper scripts
 * (`assets/cuthol-ext-<name>.js`), and bundled `assets/gsap.min.js` into a composition folder
 * BEFORE HyperFrames contract/lint checks run so `missing_local_asset` never fires a false alarm
 * on extension assets.
 *
 * Refresh rule: after the pinned extension hash changes, Cuthol-written copies are refreshed
 * in place (helper copies carrying the marker line; asset-pack files whose current bytes match
 * the last synced bytes recorded in `assets/.cuthol-ext-sync.json`). A file the user edited
 * inside the composition never matches those proofs, so it is left alone and
 * `detectCompositionExtensionCopyDrift` keeps reporting it (G205).
 */
export function syncEnabledExtensionAssetsToComposition(
  seq: CutholSequence,
  compDir: string,
  entryHtml = "index.html",
  paths?: WorkspacePaths
): { updated: boolean; updatedFiles: string[] } {
  const absCompDir =
    paths && !path.isAbsolute(compDir) ? path.resolve(paths.rootDir, compDir) : path.resolve(compDir);
  if (!fs.existsSync(absCompDir)) return { updated: false, updatedFiles: [] };

  const assetsDir = path.join(absCompDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  let updated = false;
  const updatedFiles: string[] = [];
  const sidecar = readExtSyncSidecar(assetsDir);
  let sidecarDirty = false;
  const recordSyncedFile = (extName: string, contentHash: string, rel: string, hash: string): void => {
    const prev = sidecar.extensions[extName];
    if (!prev || prev.contentHash !== contentHash || prev.files[rel] !== hash) {
      sidecar.extensions[extName] = {
        contentHash,
        files: { ...(prev?.files ?? {}), [rel]: hash },
      };
      sidecarDirty = true;
    }
  };

  const enabledRefs = seq.extensions ?? [];
  const activeHelperNames: string[] = [];
  if (enabledRefs.length > 0 && paths) {
    for (const extRef of enabledRefs) {
      try {
        const ext = resolveExtension(extRef.name, paths.rootDir);
        const isPinnedMatch =
          ext.contentHash === extRef.content_hash && ext.version === extRef.version;
        if (ext.assetsRelDir) {
          const srcAssetsDir = path.join(ext.dir, ext.assetsRelDir);
          const destAssetsDir = path.join(assetsDir, "ext", ext.name);
          const syncDirConditionally = (sDir: string, dDir: string, relPref: string): void => {
            fs.mkdirSync(dDir, { recursive: true });
            for (const ent of fs.readdirSync(sDir, { withFileTypes: true })) {
              if (ent.name.startsWith(".tmp") || ent.name === ".DS_Store") continue;
              const sFull = path.join(sDir, ent.name);
              const dFull = path.join(dDir, ent.name);
              const relFile = `${relPref}/${ent.name}`;
              if (ent.isDirectory()) {
                syncDirConditionally(sFull, dFull, relFile);
              } else if (ent.isFile()) {
                const sBuf = fs.readFileSync(sFull);
                const sHash = sha256Hex(sBuf);
                if (!fs.existsSync(dFull)) {
                  fs.writeFileSync(dFull, sBuf);
                  updated = true;
                  updatedFiles.push(relFile);
                  recordSyncedFile(ext.name, ext.contentHash, relFile, sHash);
                } else {
                  const dHash = sha256Hex(fs.readFileSync(dFull));
                  if (dHash === sHash) {
                    recordSyncedFile(ext.name, ext.contentHash, relFile, sHash);
                  } else if (sidecar.extensions[ext.name]?.files[relFile] === dHash) {
                    // Cuthol-written copy from an older pinned hash: refresh in place.
                    fs.writeFileSync(dFull, sBuf);
                    updated = true;
                    updatedFiles.push(relFile);
                    recordSyncedFile(ext.name, ext.contentHash, relFile, sHash);
                  }
                  // Otherwise the user edited the copy (or it predates sidecar
                  // bookkeeping and differs): leave it alone, drift keeps G205.
                }
              }
            }
          };
          if (fs.existsSync(srcAssetsDir)) {
            syncDirConditionally(srcAssetsDir, destAssetsDir, `assets/ext/${ext.name}`);
          }
        }
        if (ext.helperRelPath) {
          const srcHelperPath = path.join(ext.dir, ext.helperRelPath);
          if (fs.existsSync(srcHelperPath)) {
            activeHelperNames.push(ext.name);
            const rawHelper = fs.readFileSync(srcHelperPath, "utf8");
            const wrappedHelper = CUTHOL_EXT_HELPER_MARKER + "\n" + rawHelper;
            const relHelper = `assets/cuthol-ext-${ext.name}.js`;
            const destHelperPath = path.join(assetsDir, `cuthol-ext-${ext.name}.js`);
            const existingHelper = fs.existsSync(destHelperPath)
              ? fs.readFileSync(destHelperPath, "utf8")
              : null;
            const wrappedHash = sha256Hex(wrappedHelper);
            if (existingHelper === null) {
              fs.writeFileSync(destHelperPath, wrappedHelper, "utf8");
              updated = true;
              updatedFiles.push(relHelper);
              recordSyncedFile(ext.name, ext.contentHash, relHelper, wrappedHash);
            } else if (existingHelper === wrappedHelper) {
              recordSyncedFile(ext.name, ext.contentHash, relHelper, wrappedHash);
            } else if (
              (() => {
                const recorded = sidecar.extensions[ext.name]?.files[relHelper];
                // With a sync record, only the exact bytes Cuthol last wrote count as
                // Cuthol-written; an edit anywhere in the file (marker line kept) is the user's.
                // Without one (copies seeded before the record existed) the marker line is
                // the only proof available.
                return recorded !== undefined
                  ? recorded === sha256Hex(existingHelper)
                  : existingHelper.startsWith(CUTHOL_EXT_HELPER_MARKER);
              })()
            ) {
              // Cuthol-written copy from an older pinned hash: refresh in place.
              fs.writeFileSync(destHelperPath, wrappedHelper, "utf8");
              updated = true;
              updatedFiles.push(relHelper);
              recordSyncedFile(ext.name, ext.contentHash, relHelper, wrappedHash);
            }
            // Otherwise the user edited the copy: leave it alone, drift keeps G205.
          }
        }
      } catch {
        // Verified by Gate 2 (`verifySequence`)
      }
    }
  }

  const entryHtmlPath = path.join(absCompDir, entryHtml || "index.html");
  if (fs.existsSync(entryHtmlPath)) {
    const html = fs.readFileSync(entryHtmlPath, "utf8");
    const gsapPath = path.join(assetsDir, "gsap.min.js");
    if (/src=["']assets\/gsap\.min\.js["']/i.test(html) && !fs.existsSync(gsapPath)) {
      const bundledGsap = findBundledGsapMinJs();
      if (bundledGsap) {
        fs.copyFileSync(bundledGsap, gsapPath);
        updated = true;
        updatedFiles.push("assets/gsap.min.js");
      }
    }
  }

  if (sidecarDirty) writeExtSyncSidecar(assetsDir, sidecar);

  return { updated, updatedFiles };
}

/**
 * Checks whether any mounted composition's local copy of an enabled extension (`assets/cuthol-ext-<name>.js`
 * or `assets/ext/<name>/...`) differs from the extension's source files on disk.
 */
export function detectCompositionExtensionCopyDrift(
  seq: CutholSequence,
  extName: string,
  paths: WorkspacePaths
): { drifted: boolean; driftedCompositions: string[] } {
  const driftedCompositions: string[] = [];
  let ext;
  try {
    ext = resolveExtension(extName, paths.rootDir);
  } catch {
    return { drifted: false, driftedCompositions };
  }

  const wrappedHelper = (() => {
    if (!ext.helperRelPath) return null;
    const srcHelperPath = path.join(ext.dir, ext.helperRelPath);
    if (!fs.existsSync(srcHelperPath)) return null;
    const rawHelper = fs.readFileSync(srcHelperPath, "utf8");
    return (
      `if (typeof window !== "undefined") { window.__cuthol = window.__cuthol || {}; window.__cuthol.ext = window.__cuthol.ext || {}; }\n` +
      rawHelper
    );
  })();

  const checkDirEqual = (sDir: string, dDir: string): boolean => {
    if (!fs.existsSync(sDir)) return true;
    if (!fs.existsSync(dDir)) return false;
    for (const ent of fs.readdirSync(sDir, { withFileTypes: true })) {
      if (ent.name.startsWith(".tmp") || ent.name === ".DS_Store") continue;
      const sFull = path.join(sDir, ent.name);
      const dFull = path.join(dDir, ent.name);
      if (ent.isDirectory()) {
        if (!checkDirEqual(sFull, dFull)) return false;
      } else if (ent.isFile()) {
        if (!fs.existsSync(dFull)) return false;
        if (Buffer.compare(fs.readFileSync(sFull), fs.readFileSync(dFull)) !== 0) return false;
      }
    }
    return true;
  };

  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (cue.kind !== "composition" || !cue.composition) continue;
      const compDir = path.isAbsolute(cue.composition.composition_dir)
        ? cue.composition.composition_dir
        : path.resolve(paths.rootDir, cue.composition.composition_dir);
      if (!fs.existsSync(compDir)) continue;
      const assetsDir = path.join(compDir, "assets");
      let compDrifted = false;
      if (wrappedHelper !== null) {
        const destHelperPath = path.join(assetsDir, `cuthol-ext-${ext.name}.js`);
        if (!fs.existsSync(destHelperPath) || fs.readFileSync(destHelperPath, "utf8") !== wrappedHelper) {
          compDrifted = true;
        }
      }
      if (!compDrifted && ext.assetsRelDir) {
        const srcAssetsDir = path.join(ext.dir, ext.assetsRelDir);
        const destAssetsDir = path.join(assetsDir, "ext", ext.name);
        if (!checkDirEqual(srcAssetsDir, destAssetsDir)) {
          compDrifted = true;
        }
      }
      if (compDrifted && !driftedCompositions.includes(cue.composition.composition_dir)) {
        driftedCompositions.push(cue.composition.composition_dir);
      }
    }
  }

  return { drifted: driftedCompositions.length > 0, driftedCompositions };
}
