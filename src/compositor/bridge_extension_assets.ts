// Copies enabled extension assets into compositions and detects stale copies (split out of bridge_exporter.ts).
import fs from "node:fs";
import path from "node:path";
import {
  CutholSequence
} from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { resolveExtension } from "../extensions/manager.js";
import { findBundledGsapMinJs } from "./bridge_hash.js";

/**
 * Synchronizes enabled project extension asset packs (`assets/ext/<name>/`), helper scripts
 * (`assets/cuthol-ext-<name>.js`), and bundled `assets/gsap.min.js` into a composition folder
 * BEFORE HyperFrames contract/lint checks run so `missing_local_asset` never fires a false alarm
 * on extension assets.
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
                const dExists = fs.existsSync(dFull);
                // Only seed missing files during verification; never silently overwrite an existing composition copy
                if (!dExists) {
                  fs.writeFileSync(dFull, sBuf);
                  updated = true;
                  updatedFiles.push(relFile);
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
            const wrappedHelper =
              `if (typeof window !== "undefined") { window.__cuthol = window.__cuthol || {}; window.__cuthol.ext = window.__cuthol.ext || {}; }\n` +
              rawHelper;
            const destHelperPath = path.join(assetsDir, `cuthol-ext-${ext.name}.js`);
            const existingHelper = fs.existsSync(destHelperPath)
              ? fs.readFileSync(destHelperPath, "utf8")
              : null;
            if (existingHelper === null) {
              fs.writeFileSync(destHelperPath, wrappedHelper, "utf8");
              updated = true;
              updatedFiles.push(`assets/cuthol-ext-${ext.name}.js`);
            }
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
