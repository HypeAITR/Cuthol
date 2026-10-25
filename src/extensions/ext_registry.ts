// Finding, loading, hashing, listing and showing extensions (split out of manager.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { resolveSharedExtensionsConfig } from "../core/env.js";
import {
  MountedExtensionRef
} from "../core/schema.js";
import {
  loadSequence
} from "../core/workspace.js";
import { ExtensionScope, ResolvedExtension, EXTENSION_MANIFEST_FILENAME, validateExtensionManifest, assertStayInsideDir, EXTENSION_NAME_RE, ExtensionListItem, ExtensionManifest } from "./ext_manifest.js";

/**
 * Computes a deterministic SHA-256 content hash across all files in an extension directory.
 */
export function hashExtensionDirectory(extDir: string): string {
  const absRoot = path.resolve(extDir);
  const hash = crypto.createHash("sha256").update("cuthol-ext-v1\n");

  const walk = (currDir: string, relPrefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".tmp") || entry.name === ".DS_Store") continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = path.join(currDir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        const buf = fs.readFileSync(full);
        const fileHash = crypto.createHash("sha256").update(buf).digest("hex");
        hash.update(`file:${rel}:${buf.length}:${fileHash}\n`);
      }
    }
  };

  walk(absRoot, "");
  return `sha256:${hash.digest("hex").slice(0, 16)}`;
}

export function resolveExtensionRoots(workspaceDir?: string | null): {
  projectExtensionsDir: string | null;
  persistentExtensionsDir: string | null;
} {
  let projectExtensionsDir: string | null = null;
  if (workspaceDir && workspaceDir.trim()) {
    const absWs = path.resolve(workspaceDir);
    if (fs.existsSync(path.join(absWs, "cuthol.sequence.json"))) {
      projectExtensionsDir = path.join(absWs, ".cuthol", "extensions");
    }
  }
  const sharedExtCfg = resolveSharedExtensionsConfig();
  return {
    projectExtensionsDir,
    persistentExtensionsDir: sharedExtCfg.enabled ? sharedExtCfg.extensionsDir : null,
  };
}

export function loadExtensionFromDir(
  extDir: string,
  scope: ExtensionScope,
  expectedName?: string,
  shadowedPersistentDir?: string | null
): ResolvedExtension {
  const absDir = path.resolve(extDir);
  const folderName = expectedName ?? path.basename(absDir);
  const manifestPath = path.join(absDir, EXTENSION_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        folderName,
        `'${manifestPath}' dosyası bulunamadı.`
      )
    );
  }
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        folderName,
        `JSON sözdizimi hatası: ${err instanceof Error ? err.message : String(err)}`
      )
    );
  }

  const manifest = validateExtensionManifest(parsedRaw, folderName, manifestPath);
  const helperRelPath =
    typeof manifest.helper === "string"
      ? manifest.helper
      : manifest.helper?.entry ?? null;
  if (helperRelPath) {
    const absHelper = assertStayInsideDir(absDir, helperRelPath, manifest.name);
    if (!fs.existsSync(absHelper)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          manifest.name,
          `Manifestte belirtilen yardımcı JS dosyası ('${helperRelPath}') bulunamadı.`
        )
      );
    }
  }

  const assetsRelDir =
    typeof manifest.assets === "string"
      ? manifest.assets
      : manifest.assets?.dir ?? null;
  if (assetsRelDir) {
    const absAssets = assertStayInsideDir(absDir, assetsRelDir, manifest.name);
    if (!fs.existsSync(absAssets) || !fs.statSync(absAssets).isDirectory()) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          manifest.name,
          `Manifestte belirtilen varlık klasörü ('${assetsRelDir}') bulunamadı.`
        )
      );
    }
  }

  if (manifest.processors) {
    for (const [procName, proc] of Object.entries(manifest.processors)) {
      if (proc.kind === "node" && proc.script) {
        const absScript = assertStayInsideDir(absDir, proc.script, manifest.name);
        if (!fs.existsSync(absScript)) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              manifest.name,
              `'processors.${procName}.script' dosyası ('${proc.script}') bulunamadı.`
            )
          );
        }
      }
    }
  }

  if (manifest.planners) {
    for (const [planName, planner] of Object.entries(manifest.planners)) {
      const absScript = assertStayInsideDir(absDir, planner.script, manifest.name);
      if (!fs.existsSync(absScript)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            manifest.name,
            `'planners.${planName}.script' dosyası ('${planner.script}') bulunamadı.`
          )
        );
      }
    }
  }

  const defaultReadme = path.join(absDir, manifest.guide ?? "README.md");
  const guideRelPath = fs.existsSync(defaultReadme) ? (manifest.guide ?? "README.md") : null;
  const contentHash = hashExtensionDirectory(absDir);

  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    network: Boolean(manifest.network),
    scope,
    dir: absDir,
    manifestPath,
    contentHash,
    manifest,
    helperRelPath,
    assetsRelDir,
    guideRelPath,
    shadowedPersistentDir: shadowedPersistentDir ?? null,
  };
}

/**
 * Resolves an extension by name. Project-local (`.cuthol/extensions/<name>`) wins over
 * persistent (`~/.cuthol/extensions/<name>`) unless `explicitScope` is specified.
 */
export function resolveExtension(
  name: string,
  workspaceDir?: string | null,
  explicitScope?: ExtensionScope
): ResolvedExtension {
  const cleanName = (name || "").trim();
  if (!EXTENSION_NAME_RE.test(cleanName)) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        cleanName || "extension",
        `Geçersiz eklenti adı '${cleanName}'. Eklenti adları küçük harfle başlamalı ve yalnızca [a-z0-9_-] içermelidir.`
      )
    );
  }

  const { projectExtensionsDir, persistentExtensionsDir } = resolveExtensionRoots(workspaceDir);
  const searched: string[] = [];

  const projCandidate = projectExtensionsDir ? path.join(projectExtensionsDir, cleanName) : null;
  const persCandidate = persistentExtensionsDir ? path.join(persistentExtensionsDir, cleanName) : null;

  if (explicitScope === "project") {
    if (projCandidate) searched.push(projCandidate);
    if (projCandidate && fs.existsSync(projCandidate)) {
      return loadExtensionFromDir(
        projCandidate,
        "project",
        cleanName,
        persCandidate && fs.existsSync(persCandidate) ? persCandidate : null
      );
    }
    throw new CutholError(DIAGNOSTICS.EXTENSION_NOT_FOUND(cleanName, searched));
  }

  if (explicitScope === "persistent") {
    if (persCandidate) searched.push(persCandidate);
    if (persCandidate && fs.existsSync(persCandidate)) {
      return loadExtensionFromDir(persCandidate, "persistent", cleanName, null);
    }
    throw new CutholError(DIAGNOSTICS.EXTENSION_NOT_FOUND(cleanName, searched));
  }

  if (projCandidate) {
    searched.push(projCandidate);
    if (fs.existsSync(projCandidate)) {
      return loadExtensionFromDir(
        projCandidate,
        "project",
        cleanName,
        persCandidate && fs.existsSync(persCandidate) ? persCandidate : null
      );
    }
  }

  if (persCandidate) {
    searched.push(persCandidate);
    if (fs.existsSync(persCandidate)) {
      return loadExtensionFromDir(persCandidate, "persistent", cleanName, null);
    }
  }

  throw new CutholError(DIAGNOSTICS.EXTENSION_NOT_FOUND(cleanName, searched));
}

function scanExtensionsInRoot(rootDir: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!rootDir || !fs.existsSync(rootDir)) return map;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return map;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const full = path.join(rootDir, entry.name);
    if (fs.existsSync(path.join(full, EXTENSION_MANIFEST_FILENAME))) {
      map.set(entry.name, full);
    }
  }
  return map;
}

export function listExtensions(workspaceDir?: string | null): {
  extensions: ExtensionListItem[];
  enabled_in_project: MountedExtensionRef[];
  project_extensions_dir: string | null;
  persistent_extensions_dir: string | null;
  invalid_extensions?: Array<{ name: string; dir: string; error: string }>;
} {
  const { projectExtensionsDir, persistentExtensionsDir } = resolveExtensionRoots(workspaceDir);
  const projMap = scanExtensionsInRoot(projectExtensionsDir);
  const persMap = scanExtensionsInRoot(persistentExtensionsDir);

  let enabledRefs: MountedExtensionRef[] = [];
  if (workspaceDir && fs.existsSync(path.join(path.resolve(workspaceDir), "cuthol.sequence.json"))) {
    try {
      const { sequence } = loadSequence(workspaceDir);
      enabledRefs = sequence.extensions ?? [];
    } catch {
      enabledRefs = [];
    }
  }
  const enabledMap = new Map(enabledRefs.map((e) => [e.name, e]));

  const allNames = new Set<string>([...projMap.keys(), ...persMap.keys()]);
  const sortedNames = [...allNames].sort((a, b) => a.localeCompare(b));

  const items: ExtensionListItem[] = [];
  const invalid: Array<{ name: string; dir: string; error: string }> = [];

  for (const name of sortedNames) {
    const inProj = projMap.get(name);
    const inPers = persMap.get(name);
    const winningDir = inProj ?? inPers!;
    const winningScope: ExtensionScope = inProj ? "project" : "persistent";
    try {
      const ext = loadExtensionFromDir(winningDir, winningScope, name, inProj && inPers ? inPers : null);
      const mounted = enabledMap.get(name);
      items.push({
        name: ext.name,
        version: ext.version,
        description: ext.description,
        scope: ext.scope,
        dir: ext.dir,
        manifest_path: ext.manifestPath,
        content_hash: ext.contentHash,
        network: ext.network,
        enabled: Boolean(mounted),
        ...(mounted
          ? {
              enabled_version: mounted.version,
              enabled_hash: mounted.content_hash,
              hash_mismatch:
                mounted.content_hash !== ext.contentHash || mounted.version !== ext.version,
            }
          : {}),
        shadowed_persistent: Boolean(inProj && inPers),
        provides: {
          helper: ext.helperRelPath,
          assets: ext.assetsRelDir,
          processors: Object.keys(ext.manifest.processors ?? {}),
          planners: Object.keys(ext.manifest.planners ?? {}),
          recipes: Object.keys(ext.manifest.recipes ?? {}),
          guide: ext.guideRelPath,
        },
      });
    } catch (err) {
      invalid.push({
        name,
        dir: winningDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    extensions: items,
    enabled_in_project: enabledRefs,
    project_extensions_dir: projectExtensionsDir,
    persistent_extensions_dir: persistentExtensionsDir,
    ...(invalid.length > 0 ? { invalid_extensions: invalid } : {}),
  };
}

export function listFilesRecursiveRelative(rootDir: string): Array<{ path: string; size_bytes: number }> {
  const out: Array<{ path: string; size_bytes: number }> = [];
  const walk = (curr: string, relPrefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(curr, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".tmp") || entry.name === ".DS_Store") continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = path.join(curr, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        out.push({ path: rel, size_bytes: fs.statSync(full).size });
      }
    }
  };
  walk(rootDir, "");
  return out;
}

export function showExtension(options: {
  name: string;
  workspaceDir?: string | null;
  scope?: ExtensionScope;
}): {
  name: string;
  version: string;
  description: string;
  scope: ExtensionScope;
  dir: string;
  manifest_path: string;
  content_hash: string;
  network: boolean;
  enabled: boolean;
  enabled_ref: MountedExtensionRef | null;
  hash_mismatch: boolean;
  shadowed_persistent_dir: string | null;
  manifest: ExtensionManifest;
  files: Array<{ path: string; size_bytes: number }>;
} {
  const ext = resolveExtension(options.name, options.workspaceDir, options.scope);
  let enabledRef: MountedExtensionRef | null = null;
  if (
    options.workspaceDir &&
    fs.existsSync(path.join(path.resolve(options.workspaceDir), "cuthol.sequence.json"))
  ) {
    try {
      const { sequence } = loadSequence(options.workspaceDir);
      enabledRef = (sequence.extensions ?? []).find((e) => e.name === ext.name) ?? null;
    } catch {
      enabledRef = null;
    }
  }

  return {
    name: ext.name,
    version: ext.version,
    description: ext.description,
    scope: ext.scope,
    dir: ext.dir,
    manifest_path: ext.manifestPath,
    content_hash: ext.contentHash,
    network: ext.network,
    enabled: Boolean(enabledRef),
    enabled_ref: enabledRef,
    hash_mismatch: Boolean(
      enabledRef &&
        (enabledRef.content_hash !== ext.contentHash || enabledRef.version !== ext.version)
    ),
    shadowed_persistent_dir: ext.shadowedPersistentDir ?? null,
    manifest: ext.manifest,
    files: listFilesRecursiveRelative(ext.dir),
  };
}
