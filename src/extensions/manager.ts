/**
 * Cuthol Extension Environment (`src/extensions/manager.ts`).
 *
 * Provides a clean, deterministic extension system for AI agents:
 * - Persistent extensions in `~/.cuthol/extensions/<name>/` (redirectable via `CUTHOL_EXTENSIONS_DIR` / `CUTHOL_CACHE_DIR`).
 * - Project-local (temporary) extensions in `<project>/.cuthol/extensions/<name>/` (overrides persistent on name collision).
 * - Closed, validated manifest (`cuthol-extension.json`) with 5 optional capability kinds:
 *   1. Composition helper (`helper`) -> injected after `cuthol-runtime.js` as `window.__cuthol.ext.<name>`
 *   2. Asset pack (`assets`) -> synced to `assets/ext/<name>/...` in mounted compositions
 *   3. Media processor (`processors`) -> declarative `ffmpeg` filter chains or sandboxed child-process `node` scripts,
 *      cached by `(input_digest + ext_version + ext_hash + params)` and ingested into the library with journal undo
 *   4. Recipe (`recipes`) -> parameterized sequence of Cuthol actions committed as a single atomic undo step
 *   5. Guide (`guide` / `README.md`) -> readable via `guide(topic="ext:<name>")`
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { computeSequenceDelta } from "../core/envelope.js";
import { resolveSharedExtensionsConfig } from "../core/env.js";
import {
  allocateNextHandle,
  AssetKind,
  assetPrefixForKind,
  CutholSequence,
  LibraryItem,
  MountedExtensionRef,
} from "../core/schema.js";
import {
  ensureWorkspaceDirectories,
  JournalEntry,
  loadJournalManifest,
  loadSequence,
  resolveWorkspacePaths,
  WorkspacePaths,
} from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { probeLocalMediaFile, resolveLibraryItemPath } from "../library/probe.js";
import { commitVerifiedMutation, verifySequence } from "../verify/gates.js";

export const EXTENSION_MANIFEST_FILENAME = "cuthol-extension.json";
const EXTENSION_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export type ExtensionScope = "project" | "persistent";

export interface ExtensionParamDef {
  type: "number" | "string" | "boolean";
  default?: number | string | boolean;
  description?: string;
  required?: boolean;
  min?: number;
  max?: number;
  enum?: Array<string | number>;
}

export interface ExtensionProcessorSpec {
  kind: "ffmpeg" | "node";
  description?: string;
  output_ext?: string;
  asset_kind?: AssetKind;
  params?: Record<string, ExtensionParamDef>;
  /** Audio/general filter expression for `kind: "ffmpeg"`, e.g. `"atempo={{rate}}"`. */
  filter?: string;
  audio_filter?: string;
  video_filter?: string;
  ffmpeg_args?: string[];
  /** Relative path to Node script inside the extension directory for `kind: "node"`. */
  script?: string;
}

export interface ExtensionRecipeStepSpec {
  id?: string;
  tool: string;
  action?: string;
  args?: Record<string, unknown>;
}

export interface ExtensionRecipeSpec {
  description?: string;
  params?: Record<string, ExtensionParamDef>;
  steps: ExtensionRecipeStepSpec[];
}

export interface ExtensionManifest {
  schema_version?: "1.0.0";
  name: string;
  version: string;
  description: string;
  network?: boolean;
  helper?: string | { entry: string };
  assets?: string | { dir: string };
  processors?: Record<string, ExtensionProcessorSpec>;
  recipes?: Record<string, ExtensionRecipeSpec>;
  guide?: string;
}

export interface ResolvedExtension {
  name: string;
  version: string;
  description: string;
  network: boolean;
  scope: ExtensionScope;
  dir: string;
  manifestPath: string;
  contentHash: string;
  manifest: ExtensionManifest;
  helperRelPath: string | null;
  assetsRelDir: string | null;
  guideRelPath: string | null;
  shadowedPersistentDir?: string | null;
}

export interface ExtensionListItem {
  name: string;
  version: string;
  description: string;
  scope: ExtensionScope;
  dir: string;
  manifest_path: string;
  content_hash: string;
  network: boolean;
  enabled: boolean;
  enabled_version?: string;
  enabled_hash?: string;
  hash_mismatch?: boolean;
  shadowed_persistent: boolean;
  provides: {
    helper: string | null;
    assets: string | null;
    processors: string[];
    recipes: string[];
    guide: string | null;
  };
}

const ALLOWED_MANIFEST_KEYS = new Set([
  "schema_version",
  "name",
  "version",
  "description",
  "network",
  "helper",
  "assets",
  "processors",
  "recipes",
  "guide",
]);

const ALLOWED_PROCESSOR_KEYS = new Set([
  "kind",
  "description",
  "output_ext",
  "asset_kind",
  "params",
  "filter",
  "audio_filter",
  "video_filter",
  "ffmpeg_args",
  "script",
]);

const ALLOWED_PARAM_KEYS = new Set([
  "type",
  "default",
  "description",
  "required",
  "min",
  "max",
  "enum",
]);

const ALLOWED_RECIPE_KEYS = new Set(["description", "params", "steps"]);
const ALLOWED_STEP_KEYS = new Set(["id", "tool", "action", "args"]);

function isSafeRelativeSubpath(rel: string): boolean {
  if (!rel || typeof rel !== "string") return false;
  const trimmed = rel.trim();
  if (!trimmed || path.isAbsolute(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    return false;
  }
  const norm = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (norm === ".." || norm.startsWith("../") || norm.includes("/../")) {
    return false;
  }
  return true;
}

export function assertStayInsideDir(parentDir: string, targetPath: string, extName: string): string {
  const absParent = path.resolve(parentDir);
  const absTarget = path.resolve(absParent, targetPath);
  const rel = path.relative(absParent, absTarget);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
        extName,
        `'${targetPath}' yolu eklenti klasörü ('${absParent}') dışına çıkıyor.`
      )
    );
  }
  return absTarget;
}

function validateParamsMap(
  rawParams: unknown,
  extLabel: string,
  ownerLabel: string
): Record<string, ExtensionParamDef> {
  if (rawParams === undefined) return {};
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extLabel,
        `'${ownerLabel}.params' bir nesne olmalıdır.`
      )
    );
  }
  const out: Record<string, ExtensionParamDef> = {};
  for (const [pName, pVal] of Object.entries(rawParams as Record<string, unknown>)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(pName)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extLabel,
          `'${ownerLabel}.params.${pName}' geçersiz parametre adı.`
        )
      );
    }
    if (!pVal || typeof pVal !== "object" || Array.isArray(pVal)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extLabel,
          `'${ownerLabel}.params.${pName}' bir şema nesnesi olmalıdır.`
        )
      );
    }
    const pObj = pVal as Record<string, unknown>;
    for (const k of Object.keys(pObj)) {
      if (!ALLOWED_PARAM_KEYS.has(k)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            extLabel,
            `'${ownerLabel}.params.${pName}' içinde bilinmeyen alan '${k}'.`
          )
        );
      }
    }
    const pType = pObj.type;
    if (pType !== "number" && pType !== "string" && pType !== "boolean") {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extLabel,
          `'${ownerLabel}.params.${pName}.type' değeri 'number', 'string' veya 'boolean' olmalıdır.`
        )
      );
    }
    out[pName] = {
      type: pType,
      ...(pObj.default !== undefined ? { default: pObj.default as number | string | boolean } : {}),
      ...(typeof pObj.description === "string" ? { description: pObj.description } : {}),
      ...(typeof pObj.required === "boolean" ? { required: pObj.required } : {}),
      ...(typeof pObj.min === "number" ? { min: pObj.min } : {}),
      ...(typeof pObj.max === "number" ? { max: pObj.max } : {}),
      ...(Array.isArray(pObj.enum) ? { enum: pObj.enum as Array<string | number> } : {}),
    };
  }
  return out;
}

/**
 * Validates `cuthol-extension.json` against the closed extension manifest schema.
 */
export function validateExtensionManifest(
  raw: unknown,
  expectedFolderName?: string,
  sourcePathForError?: string
): ExtensionManifest {
  const label = expectedFolderName || sourcePathForError || "extension";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(label, "Manifest kök değeri bir JSON nesnesi olmalıdır.")
    );
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_MANIFEST_KEYS.has(key)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          label,
          `Bilinmeyen manifest alanı '${key}' (izin verilenler: ${[...ALLOWED_MANIFEST_KEYS].join(", ")}).`
        )
      );
    }
  }

  if (typeof obj.name !== "string" || !EXTENSION_NAME_RE.test(obj.name.trim())) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        label,
        `'name' alanı zorunludur ve '${EXTENSION_NAME_RE.source}' desenine uymalıdır (küçük harf, rakam, '-' veya '_').`
      )
    );
  }
  const name = obj.name.trim();
  if (expectedFolderName && name !== expectedFolderName) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        label,
        `Manifest 'name' alanı ('${name}') eklenti klasör adıyla ('${expectedFolderName}') eşleşmiyor.`
      )
    );
  }

  if (typeof obj.version !== "string" || !obj.version.trim()) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'version' alanı boş olmayan bir metin olmalıdır (ör. "1.0.0").`)
    );
  }

  if (typeof obj.description !== "string" || !obj.description.trim()) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'description' alanı boş olmayan bir açıklama metni olmalıdır.`)
    );
  }

  if (obj.network !== undefined && typeof obj.network !== "boolean") {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'network' alanı boolean (true/false) olmalıdır.`)
    );
  }

  let helperSpec: ExtensionManifest["helper"] | undefined;
  if (obj.helper !== undefined) {
    let entry = "";
    if (typeof obj.helper === "string") {
      entry = obj.helper.trim();
      helperSpec = entry;
    } else if (obj.helper && typeof obj.helper === "object" && !Array.isArray(obj.helper)) {
      const hObj = obj.helper as Record<string, unknown>;
      const extraKeys = Object.keys(hObj).filter((k) => k !== "entry");
      if (extraKeys.length > 0) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'helper' içinde bilinmeyen alan: ${extraKeys.join(", ")}.`)
        );
      }
      entry = typeof hObj.entry === "string" ? hObj.entry.trim() : "";
      helperSpec = { entry };
    } else {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'helper' alanı bir JS dosya yolu veya '{ "entry": "helper.js" }' olmalıdır.`)
      );
    }
    if (!isSafeRelativeSubpath(entry) || !entry.endsWith(".js")) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          name,
          `'helper' dosya yolu ('${entry}') eklenti içinde göreli bir '.js' dosyası olmalıdır.`
        )
      );
    }
  }

  let assetsSpec: ExtensionManifest["assets"] | undefined;
  if (obj.assets !== undefined) {
    let dir = "";
    if (typeof obj.assets === "string") {
      dir = obj.assets.trim();
      assetsSpec = dir;
    } else if (obj.assets && typeof obj.assets === "object" && !Array.isArray(obj.assets)) {
      const aObj = obj.assets as Record<string, unknown>;
      const extraKeys = Object.keys(aObj).filter((k) => k !== "dir");
      if (extraKeys.length > 0) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'assets' içinde bilinmeyen alan: ${extraKeys.join(", ")}.`)
        );
      }
      dir = typeof aObj.dir === "string" ? aObj.dir.trim() : "";
      assetsSpec = { dir };
    } else {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'assets' alanı göreli bir klasör adı (ör. "assets") olmalıdır.`)
      );
    }
    if (!isSafeRelativeSubpath(dir)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          name,
          `'assets' klasör yolu ('${dir}') eklenti içinde güvenli göreli bir yol olmalıdır.`
        )
      );
    }
  }

  let processorsSpec: Record<string, ExtensionProcessorSpec> | undefined;
  if (obj.processors !== undefined) {
    if (!obj.processors || typeof obj.processors !== "object" || Array.isArray(obj.processors)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'processors' alanı bir nesne olmalıdır.`)
      );
    }
    processorsSpec = {};
    for (const [procName, rawProc] of Object.entries(obj.processors as Record<string, unknown>)) {
      if (!EXTENSION_NAME_RE.test(procName)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `Geçersiz işlemci adı '${procName}'.`)
        );
      }
      if (!rawProc || typeof rawProc !== "object" || Array.isArray(rawProc)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'processors.${procName}' bir nesne olmalıdır.`)
        );
      }
      const pObj = rawProc as Record<string, unknown>;
      for (const k of Object.keys(pObj)) {
        if (!ALLOWED_PROCESSOR_KEYS.has(k)) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              name,
              `'processors.${procName}' içinde bilinmeyen alan '${k}' (izin verilenler: ${[...ALLOWED_PROCESSOR_KEYS].join(", ")}).`
            )
          );
        }
      }
      if (pObj.kind !== "ffmpeg" && pObj.kind !== "node") {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            name,
            `'processors.${procName}.kind' değeri 'ffmpeg' veya 'node' olmalıdır.`
          )
        );
      }
      const params = validateParamsMap(pObj.params, name, `processors.${procName}`);
      if (pObj.kind === "ffmpeg") {
        const hasFilter =
          (typeof pObj.filter === "string" && pObj.filter.trim().length > 0) ||
          (typeof pObj.audio_filter === "string" && pObj.audio_filter.trim().length > 0) ||
          (typeof pObj.video_filter === "string" && pObj.video_filter.trim().length > 0) ||
          (Array.isArray(pObj.ffmpeg_args) && pObj.ffmpeg_args.length > 0);
        if (!hasFilter) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              name,
              `'processors.${procName}' (kind=ffmpeg) için 'filter', 'audio_filter', 'video_filter' veya 'ffmpeg_args' alanlarından en az biri gereklidir.`
            )
          );
        }
      } else {
        const script = typeof pObj.script === "string" ? pObj.script.trim() : "";
        if (!isSafeRelativeSubpath(script) || !/\.(c|m)?js$/i.test(script)) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              name,
              `'processors.${procName}.script' eklenti klasörü içinde göreli bir '.js' dosyası olmalıdır.`
            )
          );
        }
      }
      processorsSpec[procName] = {
        kind: pObj.kind,
        ...(typeof pObj.description === "string" ? { description: pObj.description } : {}),
        ...(typeof pObj.output_ext === "string" ? { output_ext: pObj.output_ext } : {}),
        ...(typeof pObj.asset_kind === "string" ? { asset_kind: pObj.asset_kind as AssetKind } : {}),
        ...(Object.keys(params).length > 0 ? { params } : {}),
        ...(typeof pObj.filter === "string" ? { filter: pObj.filter.trim() } : {}),
        ...(typeof pObj.audio_filter === "string" ? { audio_filter: pObj.audio_filter.trim() } : {}),
        ...(typeof pObj.video_filter === "string" ? { video_filter: pObj.video_filter.trim() } : {}),
        ...(Array.isArray(pObj.ffmpeg_args)
          ? { ffmpeg_args: pObj.ffmpeg_args.map((x) => String(x)) }
          : {}),
        ...(typeof pObj.script === "string" ? { script: pObj.script.trim() } : {}),
      };
    }
  }

  let recipesSpec: Record<string, ExtensionRecipeSpec> | undefined;
  if (obj.recipes !== undefined) {
    if (!obj.recipes || typeof obj.recipes !== "object" || Array.isArray(obj.recipes)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'recipes' alanı bir nesne olmalıdır.`)
      );
    }
    recipesSpec = {};
    for (const [recName, rawRec] of Object.entries(obj.recipes as Record<string, unknown>)) {
      if (!EXTENSION_NAME_RE.test(recName)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `Geçersiz tarif adı '${recName}'.`)
        );
      }
      if (!rawRec || typeof rawRec !== "object" || Array.isArray(rawRec)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'recipes.${recName}' bir nesne olmalıdır.`)
        );
      }
      const rObj = rawRec as Record<string, unknown>;
      for (const k of Object.keys(rObj)) {
        if (!ALLOWED_RECIPE_KEYS.has(k)) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              name,
              `'recipes.${recName}' içinde bilinmeyen alan '${k}'.`
            )
          );
        }
      }
      if (!Array.isArray(rObj.steps) || rObj.steps.length === 0) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            name,
            `'recipes.${recName}.steps' boş olmayan bir adım dizisi olmalıdır.`
          )
        );
      }
      const params = validateParamsMap(rObj.params, name, `recipes.${recName}`);
      const steps: ExtensionRecipeStepSpec[] = [];
      for (let i = 0; i < rObj.steps.length; i++) {
        const rawStep = rObj.steps[i];
        if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              name,
              `'recipes.${recName}.steps[${i}]' bir nesne olmalıdır.`
            )
          );
        }
        const sObj = rawStep as Record<string, unknown>;
        for (const k of Object.keys(sObj)) {
          if (!ALLOWED_STEP_KEYS.has(k)) {
            throw new CutholError(
              DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
                name,
                `'recipes.${recName}.steps[${i}]' içinde bilinmeyen alan '${k}'.`
              )
            );
          }
        }
        if (typeof sObj.tool !== "string" || !sObj.tool.trim()) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              name,
              `'recipes.${recName}.steps[${i}].tool' alanı zorunludur.`
            )
          );
        }
        if (sObj.args !== undefined && (!sObj.args || typeof sObj.args !== "object" || Array.isArray(sObj.args))) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              name,
              `'recipes.${recName}.steps[${i}].args' bir nesne olmalıdır.`
            )
          );
        }
        steps.push({
          ...(typeof sObj.id === "string" && sObj.id.trim() ? { id: sObj.id.trim() } : {}),
          tool: sObj.tool.trim(),
          ...(typeof sObj.action === "string" && sObj.action.trim() ? { action: sObj.action.trim() } : {}),
          ...(sObj.args ? { args: sObj.args as Record<string, unknown> } : {}),
        });
      }
      recipesSpec[recName] = {
        ...(typeof rObj.description === "string" ? { description: rObj.description } : {}),
        ...(Object.keys(params).length > 0 ? { params } : {}),
        steps,
      };
    }
  }

  let guideSpec: string | undefined;
  if (obj.guide !== undefined) {
    if (typeof obj.guide !== "string" || !isSafeRelativeSubpath(obj.guide.trim())) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          name,
          `'guide' alanı eklenti klasörü içinde göreli bir dosya yolu (ör. "README.md") olmalıdır.`
        )
      );
    }
    guideSpec = obj.guide.trim();
  }

  return {
    schema_version: "1.0.0",
    name,
    version: obj.version.trim(),
    description: obj.description.trim(),
    network: Boolean(obj.network),
    ...(helperSpec !== undefined ? { helper: helperSpec } : {}),
    ...(assetsSpec !== undefined ? { assets: assetsSpec } : {}),
    ...(processorsSpec !== undefined ? { processors: processorsSpec } : {}),
    ...(recipesSpec !== undefined ? { recipes: recipesSpec } : {}),
    ...(guideSpec !== undefined ? { guide: guideSpec } : {}),
  };
}

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

function listFilesRecursiveRelative(rootDir: string): Array<{ path: string; size_bytes: number }> {
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

export type ExtensionTemplateKind =
  | "full"
  | "helper"
  | "processor_ffmpeg"
  | "processor_node"
  | "assets"
  | "recipe";

export function createExtension(options: {
  name: string;
  workspaceDir?: string | null;
  scope?: ExtensionScope;
  template?: ExtensionTemplateKind;
  description?: string;
  version?: string;
  network?: boolean;
  overwrite?: boolean;
}): {
  name: string;
  scope: ExtensionScope;
  dir: string;
  manifest_path: string;
  content_hash: string;
  files_created: string[];
} {
  const cleanName = (options.name || "").trim();
  if (!EXTENSION_NAME_RE.test(cleanName)) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        cleanName || "extension",
        `Geçersiz eklenti adı '${cleanName}'. Eklenti adları küçük harfle başlamalı ve yalnızca [a-z0-9_-] içermelidir.`
      )
    );
  }

  const { projectExtensionsDir, persistentExtensionsDir } = resolveExtensionRoots(
    options.workspaceDir
  );
  const scope: ExtensionScope =
    options.scope ?? (projectExtensionsDir ? "project" : "persistent");

  let targetRoot: string | null =
    scope === "project" ? projectExtensionsDir : persistentExtensionsDir;
  if (!targetRoot && scope === "project" && options.workspaceDir) {
    targetRoot = path.join(path.resolve(options.workspaceDir), ".cuthol", "extensions");
  }
  if (!targetRoot) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        cleanName,
        scope === "persistent"
          ? "Kalıcı eklenti klasörü devre dışı ('CUTHOL_EXTENSIONS_DIR=0'). '--scope project' kullanın veya 'CUTHOL_EXTENSIONS_DIR' dizinini açın."
          : "Proje eklenti klasörü çözümlenemedi. Bir çalışma alanı ('--dir') belirtin veya '--scope persistent' kullanın."
      )
    );
  }

  const extDir = path.join(targetRoot, cleanName);
  if (fs.existsSync(extDir) && !options.overwrite) {
    throw new CutholError(DIAGNOSTICS.EXTENSION_ALREADY_EXISTS(cleanName, extDir));
  }

  fs.mkdirSync(extDir, { recursive: true });
  const tpl: ExtensionTemplateKind = options.template ?? "full";
  const version = options.version?.trim() || "1.0.0";
  const description =
    options.description?.trim() || `Cuthol '${cleanName}' extension (${tpl}).`;

  const manifest: ExtensionManifest = {
    schema_version: "1.0.0",
    name: cleanName,
    version,
    description,
    ...(options.network ? { network: true } : {}),
    guide: "README.md",
  };

  const filesCreated: string[] = [];

  if (tpl === "full" || tpl === "helper") {
    manifest.helper = "helper.js";
    const helperContent = [
      `/* Cuthol Composition Helper: window.__cuthol.ext.${cleanName} */`,
      `(function (root) {`,
      `  var C = (root && root.__cuthol) ? root.__cuthol : (root.__cuthol = {});`,
      `  C.ext = C.ext || {};`,
      `  C.ext[${JSON.stringify(cleanName)}] = {`,
      `    version: ${JSON.stringify(version)},`,
      `    sample: function (t) {`,
      `      return typeof C.audio === "function" ? C.audio("mid", t) : 0;`,
      `    }`,
      `  };`,
      `})(typeof window !== "undefined" ? window : globalThis);`,
      ``,
    ].join("\n");
    fs.writeFileSync(path.join(extDir, "helper.js"), helperContent, "utf8");
    filesCreated.push("helper.js");
  }

  if (tpl === "full" || tpl === "assets") {
    manifest.assets = "assets";
    const assetsDir = path.join(extDir, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(
      path.join(assetsDir, "info.json"),
      JSON.stringify({ extension: cleanName, version }, null, 2),
      "utf8"
    );
    filesCreated.push("assets/info.json");
  }

  if (tpl === "full" || tpl === "processor_ffmpeg") {
    manifest.processors = {
      ...(manifest.processors ?? {}),
      atempo: {
        kind: "ffmpeg",
        description: "Speeds up or slows down audio using FFmpeg atempo filter.",
        output_ext: ".wav",
        asset_kind: "audio",
        params: {
          rate: {
            type: "number",
            default: 1.25,
            min: 0.5,
            max: 2.0,
            description: "Tempo multiplier (0.5 .. 2.0).",
          },
        },
        audio_filter: "atempo={{rate}}",
      },
    };
  }

  if (tpl === "processor_node") {
    manifest.processors = {
      ...(manifest.processors ?? {}),
      transform: {
        kind: "node",
        description: "Transforms an input file via a sandboxed child-process Node script.",
        script: "processor.js",
        params: {
          gain_db: {
            type: "number",
            default: 0,
            description: "Optional gain offset parameter.",
          },
        },
      },
    };
    const procScript = [
      `#!/usr/bin/env node`,
      `const fs = require("node:fs");`,
      `const [inputPath, outputPath, rawParams] = process.argv.slice(2);`,
      `const params = rawParams ? JSON.parse(rawParams) : {};`,
      `fs.copyFileSync(inputPath, outputPath);`,
      `process.stdout.write(JSON.stringify({ ok: true, params }) + "\\n");`,
      ``,
    ].join("\n");
    fs.writeFileSync(path.join(extDir, "processor.js"), procScript, "utf8");
    filesCreated.push("processor.js");
  }

  if (tpl === "full" || tpl === "recipe") {
    manifest.recipes = {
      ...(manifest.recipes ?? {}),
      quick_vo: {
        description: "Runs the atempo processor on an audio handle and places it on ln_vo.",
        params: {
          handle: { type: "string", required: true, description: "Input audio library handle." },
          rate: { type: "number", default: 1.25, description: "Playback rate for atempo." },
          at: { type: "string", default: "0s", description: "Timeline start position." },
        },
        steps: [
          {
            id: "speed_step",
            tool: "extension",
            action: "run",
            args: {
              name: cleanName,
              processor: "atempo",
              input: "{{handle}}",
              params: { rate: "{{rate}}" },
            },
          },
          {
            id: "place_vo",
            tool: "lane",
            action: "add_cue",
            args: {
              lane: "ln_vo",
              asset: "{{steps.speed_step.handle}}",
              at: "{{at}}",
              duration: "{{steps.speed_step.duration_ms}}",
            },
          },
        ],
      },
    };
  }

  const readmeContent = [
    `# ${cleanName} (v${version})`,
    ``,
    description,
    ``,
    `## Capabilities`,
    manifest.helper ? `- **Composition helper:** \`window.__cuthol.ext.${cleanName}\` (\`${manifest.helper}\`)` : null,
    manifest.assets ? `- **Asset pack:** \`assets/ext/${cleanName}/...\`` : null,
    manifest.processors
      ? `- **Processors:** ${Object.keys(manifest.processors).map((k) => `\`${k}\``).join(", ")}`
      : null,
    manifest.recipes
      ? `- **Recipes:** ${Object.keys(manifest.recipes).map((k) => `\`${k}\``).join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n") + "\n";

  fs.writeFileSync(path.join(extDir, "README.md"), readmeContent, "utf8");
  filesCreated.push("README.md");

  const manifestPath = path.join(extDir, EXTENSION_MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  filesCreated.unshift(EXTENSION_MANIFEST_FILENAME);

  const loaded = loadExtensionFromDir(extDir, scope, cleanName);
  return {
    name: loaded.name,
    scope: loaded.scope,
    dir: loaded.dir,
    manifest_path: loaded.manifestPath,
    content_hash: loaded.contentHash,
    files_created: filesCreated,
  };
}

function copyDirectoryRecursiveSync(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".tmp")) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursiveSync(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function promoteExtension(options: {
  name: string;
  workspaceDir: string;
  overwrite?: boolean;
}): {
  name: string;
  version: string;
  from_dir: string;
  persistent_dir: string;
  content_hash: string;
} {
  const projExt = resolveExtension(options.name, options.workspaceDir, "project");
  const { persistentExtensionsDir } = resolveExtensionRoots(options.workspaceDir);
  if (!persistentExtensionsDir) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        projExt.name,
        "Kalıcı eklenti klasörü devre dışı ('CUTHOL_EXTENSIONS_DIR=0')."
      )
    );
  }
  const targetDir = path.join(persistentExtensionsDir, projExt.name);
  if (fs.existsSync(targetDir) && options.overwrite === false) {
    throw new CutholError(DIAGNOSTICS.EXTENSION_ALREADY_EXISTS(projExt.name, targetDir));
  }
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  copyDirectoryRecursiveSync(projExt.dir, targetDir);
  const loaded = loadExtensionFromDir(targetDir, "persistent", projExt.name);
  return {
    name: loaded.name,
    version: loaded.version,
    from_dir: projExt.dir,
    persistent_dir: loaded.dir,
    content_hash: loaded.contentHash,
  };
}

export function removeExtension(options: {
  name: string;
  workspaceDir?: string | null;
  scope?: ExtensionScope;
}): {
  name: string;
  removed_scope: ExtensionScope;
  removed_dir: string;
} {
  const ext = resolveExtension(options.name, options.workspaceDir, options.scope);
  fs.rmSync(ext.dir, { recursive: true, force: true });
  return {
    name: ext.name,
    removed_scope: ext.scope,
    removed_dir: ext.dir,
  };
}

export function enableExtensionInWorkspace(options: {
  workspaceDir: string;
  name: string;
  scope?: ExtensionScope;
  dryRun?: boolean;
}): {
  extension: MountedExtensionRef;
  manifest_path: string;
  updated_previous: boolean;
  previous_hash: string | null;
  dry_run?: boolean;
} {
  const ext = resolveExtension(options.name, options.workspaceDir, options.scope);
  const { sequence } = loadSequence(options.workspaceDir);
  const existing = (sequence.extensions ?? []).find((e) => e.name === ext.name) ?? null;

  const newRef: MountedExtensionRef = {
    name: ext.name,
    version: ext.version,
    content_hash: ext.contentHash,
    scope: ext.scope,
    enabled_at: new Date().toISOString(),
  };

  if (options.dryRun) {
    return {
      extension: newRef,
      manifest_path: ext.manifestPath,
      updated_previous: Boolean(existing),
      previous_hash: existing?.content_hash ?? null,
      dry_run: true,
    };
  }

  commitVerifiedMutation(options.workspaceDir, "extension.enable", (seq) => {
    if (!seq.extensions) seq.extensions = [];
    const idx = seq.extensions.findIndex((e) => e.name === ext.name);
    if (idx >= 0) {
      seq.extensions[idx] = newRef;
    } else {
      seq.extensions.push(newRef);
    }
    seq.extensions.sort((a, b) => a.name.localeCompare(b.name));
  });

  return {
    extension: newRef,
    manifest_path: ext.manifestPath,
    updated_previous: Boolean(existing),
    previous_hash: existing?.content_hash ?? null,
  };
}

export function disableExtensionInWorkspace(options: {
  workspaceDir: string;
  name: string;
  dryRun?: boolean;
}): {
  disabled: string;
  was_enabled: boolean;
  previous_ref: MountedExtensionRef | null;
  dry_run?: boolean;
} {
  const cleanName = options.name.trim();
  const { sequence } = loadSequence(options.workspaceDir);
  const existing = (sequence.extensions ?? []).find((e) => e.name === cleanName) ?? null;

  if (options.dryRun || !existing) {
    return {
      disabled: cleanName,
      was_enabled: Boolean(existing),
      previous_ref: existing,
      ...(options.dryRun ? { dry_run: true } : {}),
    };
  }

  commitVerifiedMutation(options.workspaceDir, "extension.disable", (seq) => {
    if (!seq.extensions) return;
    seq.extensions = seq.extensions.filter((e) => e.name !== cleanName);
    if (seq.extensions.length === 0) {
      delete seq.extensions;
    }
  });

  return {
    disabled: cleanName,
    was_enabled: true,
    previous_ref: existing,
  };
}

function resolveValidatedParams(
  schema: Record<string, ExtensionParamDef> | undefined,
  supplied: Record<string, unknown> | undefined,
  extName: string,
  targetLabel: string
): Record<string, number | string | boolean> {
  const defs = schema ?? {};
  const raw = supplied ?? {};
  const out: Record<string, number | string | boolean> = {};

  for (const k of Object.keys(raw)) {
    if (!(k in defs) && Object.keys(defs).length > 0) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          extName,
          targetLabel,
          `Bilinmeyen parametre '${k}' (geçerli parametreler: ${Object.keys(defs).join(", ")}).`
        )
      );
    }
  }

  for (const [k, def] of Object.entries(defs)) {
    const val = raw[k] !== undefined ? raw[k] : def.default;
    if (val === undefined || val === null) {
      if (def.required) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            targetLabel,
            `Zorunlu parametre '${k}' eksik.`
          )
        );
      }
      continue;
    }
    if (def.type === "number") {
      const n = typeof val === "number" ? val : Number(val);
      if (!Number.isFinite(n)) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            targetLabel,
            `'${k}' parametresi sayı olmalıdır (verilen: ${JSON.stringify(val)}).`
          )
        );
      }
      if (def.min !== undefined && n < def.min) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            targetLabel,
            `'${k}' parametresi (${n}) alt sınırın (${def.min}) altında.`
          )
        );
      }
      if (def.max !== undefined && n > def.max) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            targetLabel,
            `'${k}' parametresi (${n}) üst sınırın (${def.max}) üzerinde.`
          )
        );
      }
      out[k] = n;
    } else if (def.type === "boolean") {
      out[k] =
        typeof val === "boolean"
          ? val
          : ["true", "1", "yes"].includes(String(val).toLowerCase());
    } else {
      const s = String(val);
      out[k] = s;
    }
    if (def.enum && !def.enum.includes(out[k] as string | number)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          extName,
          targetLabel,
          `'${k}' parametresi şu değerlerden biri olmalıdır: ${def.enum.join(", ")}.`
        )
      );
    }
  }

  if (Object.keys(defs).length === 0) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
        out[k] = v;
      }
    }
  }

  return out;
}

function interpolateFilterTemplate(
  template: string,
  params: Record<string, number | string | boolean>,
  extName: string,
  procName: string
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_, key: string) => {
    if (!(key in params)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          extName,
          procName,
          `Filtre şablonundaki '{{${key}}}' parametresi için değer verilmedi.`
        )
      );
    }
    const val = String(params[key]);
    if (/[;&|`$\r\n]/.test(val)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
          extName,
          `'${key}' filtre parametresi güvenlik açısından izin verilmeyen karakterler içeriyor.`
        )
      );
    }
    return val;
  });
}

function buildAtEmpoChainIfNeeded(filterExpr: string): string {
  return filterExpr.replace(/\batempo\s*=\s*([0-9]+(?:\.[0-9]+)?)/gi, (_, rawRate: string) => {
    let rate = Number(rawRate);
    if (!Number.isFinite(rate) || rate <= 0) return `atempo=${rawRate}`;
    const stages: string[] = [];
    while (rate > 2.0 + 1e-6) {
      stages.push("atempo=2.0");
      rate /= 2.0;
    }
    while (rate < 0.5 - 1e-6) {
      stages.push("atempo=0.5");
      rate /= 0.5;
    }
    stages.push(`atempo=${Number(rate.toFixed(6))}`);
    return stages.join(",");
  });
}

export function runExtensionProcessor(options: {
  workspaceDir: string;
  extensionName: string;
  processorName?: string;
  inputHandleOrPath: string;
  targetHandle?: string;
  params?: Record<string, unknown>;
  scope?: ExtensionScope;
  dryRun?: boolean;
}): {
  extension: string;
  version: string;
  processor: string;
  kind: "ffmpeg" | "node";
  cached: boolean;
  cache_key: string;
  elapsed_ms: number;
  input_handle: string | null;
  input_path: string;
  input_sha256: string;
  output_asset: LibraryItem;
  params: Record<string, number | string | boolean>;
  security_notice: {
    manifest_path: string;
    script_path: string | null;
    network_declared: boolean;
  };
  script_output?: Record<string, unknown> | null;
  dry_run?: boolean;
} {
  const startedAt = Date.now();
  const ext = resolveExtension(options.extensionName, options.workspaceDir, options.scope);
  const procs = ext.manifest.processors ?? {};
  const procNames = Object.keys(procs);
  if (procNames.length === 0) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
        ext.name,
        options.processorName || "processor",
        `'${ext.name}' eklentisinde tanımlı hiçbir işlemci ('processors') yok.`
      )
    );
  }

  const procName =
    options.processorName?.trim() || (procNames.length === 1 ? procNames[0] : "");
  if (!procName || !procs[procName]) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
        ext.name,
        procName || "(belirtilmedi)",
        `İşlemci bulunamadı. Mevcut işlemciler: ${procNames.join(", ")}.`
      )
    );
  }
  const proc = procs[procName];
  const resolvedParams = resolveValidatedParams(
    proc.params,
    options.params,
    ext.name,
    `processor:${procName}`
  );

  const { paths, sequence } = loadSequence(options.workspaceDir);
  const ledger = new MediaLedger(paths.ledgerFile);

  try {
    let inputAbsPath: string;
    let inputHandle: string | null = null;
    const libItem = sequence.library.find((item) => item.handle === options.inputHandleOrPath);
    if (libItem) {
      inputHandle = libItem.handle;
      inputAbsPath = resolveLibraryItemPath(paths.rootDir, libItem);
    } else {
      const candidate = path.isAbsolute(options.inputHandleOrPath)
        ? options.inputHandleOrPath
        : path.resolve(paths.rootDir, options.inputHandleOrPath);
      inputAbsPath = fs.existsSync(candidate)
        ? candidate
        : path.resolve(options.inputHandleOrPath);
    }

    if (!fs.existsSync(inputAbsPath)) {
      throw new CutholError(
        DIAGNOSTICS.MISSING_FILE_ON_DISK(options.inputHandleOrPath, inputAbsPath)
      );
    }

    const { sha256: inputSha256, probe: inputProbe } = probeLocalMediaFile(inputAbsPath, ledger);
    const sortedParamsKeys = Object.keys(resolvedParams).sort();
    const canonicalParams: Record<string, unknown> = {};
    for (const k of sortedParamsKeys) canonicalParams[k] = resolvedParams[k];

    const rawCacheKey = [
      "cuthol.ext.proc/1",
      inputSha256,
      ext.name,
      ext.version,
      ext.contentHash,
      procName,
      JSON.stringify(canonicalParams),
    ].join("|");
    const cacheKey = crypto.createHash("sha256").update(rawCacheKey).digest("hex");

    const scriptAbsPath =
      proc.kind === "node" && proc.script
        ? assertStayInsideDir(ext.dir, proc.script, ext.name)
        : null;

    const securityNotice = {
      manifest_path: ext.manifestPath,
      script_path: scriptAbsPath,
      network_declared: ext.network,
    };

    const inExt = path.extname(inputAbsPath) || (inputProbe.has_video ? ".mp4" : ".wav");
    const outExtRaw = proc.output_ext?.trim() || inExt;
    const outExt = outExtRaw.startsWith(".") ? outExtRaw : `.${outExtRaw}`;

    if (options.dryRun) {
      const cachedHit = ledger.getExtensionProcessorResult<Record<string, unknown>>(
        cacheKey,
        paths.blobsDir
      );
      return {
        extension: ext.name,
        version: ext.version,
        processor: procName,
        kind: proc.kind,
        cached: Boolean(cachedHit),
        cache_key: cacheKey,
        elapsed_ms: Date.now() - startedAt,
        input_handle: inputHandle,
        input_path: inputAbsPath,
        input_sha256: inputSha256,
        output_asset:
          libItem ?? {
            handle: options.targetHandle ?? "aud_dry",
            kind: proc.asset_kind ?? "audio",
            uri: `.cuthol/blobs/ext_${ext.name}_${procName}_${cacheKey.slice(0, 12)}${outExt}`,
            digest_sha256: cacheKey,
            probe: inputProbe,
            analysis_refs: {},
          },
        params: resolvedParams,
        security_notice: securityNotice,
        dry_run: true,
      };
    }

    ensureWorkspaceDirectories(paths);
    let finalOutputPath: string;
    let cached = false;
    let scriptOutput: Record<string, unknown> | null = null;

    const cachedEntry = ledger.getExtensionProcessorResult<{
      script_output?: Record<string, unknown> | null;
    }>(cacheKey, paths.blobsDir);

    if (cachedEntry && fs.existsSync(cachedEntry.outputPath)) {
      cached = true;
      finalOutputPath = cachedEntry.outputPath;
      scriptOutput = cachedEntry.meta?.script_output ?? null;
    } else {
      finalOutputPath = path.join(
        paths.blobsDir,
        `ext_${ext.name}_${procName}_${cacheKey.slice(0, 14)}${outExt}`
      );
      const tmpOutputPath = `${finalOutputPath}.tmp_${process.pid}_${Date.now()}${outExt}`;

      if (proc.kind === "ffmpeg") {
        const ffArgs: string[] = ["-y", "-v", "error", "-i", inputAbsPath];
        const afRaw = proc.audio_filter ?? (!proc.video_filter ? proc.filter : undefined);
        const vfRaw = proc.video_filter;
        if (afRaw) {
          const interpolatedAf = buildAtEmpoChainIfNeeded(
            interpolateFilterTemplate(afRaw, resolvedParams, ext.name, procName)
          );
          ffArgs.push("-af", interpolatedAf);
        }
        if (vfRaw) {
          const interpolatedVf = interpolateFilterTemplate(
            vfRaw,
            resolvedParams,
            ext.name,
            procName
          );
          ffArgs.push("-vf", interpolatedVf);
        }
        if (proc.ffmpeg_args && proc.ffmpeg_args.length > 0) {
          for (const argTpl of proc.ffmpeg_args) {
            ffArgs.push(interpolateFilterTemplate(argTpl, resolvedParams, ext.name, procName));
          }
        }
        if (vfRaw && !afRaw && inputProbe.has_audio && [".mp4", ".mov", ".mkv"].includes(outExt.toLowerCase())) {
          ffArgs.push("-c:a", "copy");
        }
        if (afRaw && !vfRaw && inputProbe.has_video && [".mp4", ".mov", ".mkv"].includes(outExt.toLowerCase())) {
          ffArgs.push("-c:v", "copy");
        }
        ffArgs.push(tmpOutputPath);

        const ffProc = spawnSync("ffmpeg", ffArgs, {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
        if (ffProc.status !== 0 || !fs.existsSync(tmpOutputPath)) {
          if (fs.existsSync(tmpOutputPath)) {
            try {
              fs.unlinkSync(tmpOutputPath);
            } catch {
              // ignore
            }
          }
          throw new CutholError(
            DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
              ext.name,
              procName,
              `ffmpeg hatası: ${(ffProc.stderr || ffProc.stdout || "bilinmeyen hata").trim()}`
            )
          );
        }
      } else {
        // Node processor in isolated child process
        const extFilesBefore = new Map(
          listFilesRecursiveRelative(ext.dir).map((f) => [
            f.path,
            crypto.createHash("sha256").update(fs.readFileSync(path.join(ext.dir, f.path))).digest("hex"),
          ])
        );
        const extHashBefore = hashExtensionDirectory(ext.dir);
        const isolatedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cuthol-ext-node-${ext.name}-`));
        const sandboxOutPath = path.join(isolatedTmpDir, `out${outExt}`);

        try {
          const nodeProc = spawnSync(
            process.execPath,
            [scriptAbsPath!, inputAbsPath, sandboxOutPath, JSON.stringify(resolvedParams)],
            {
              cwd: isolatedTmpDir,
              env: {
                ...process.env,
                CUTHOL_EXT_NAME: ext.name,
                CUTHOL_EXT_VERSION: ext.version,
                CUTHOL_EXT_INPUT: inputAbsPath,
                CUTHOL_EXT_OUTPUT: sandboxOutPath,
                CUTHOL_EXT_PARAMS: JSON.stringify(resolvedParams),
              },
              encoding: "utf8",
              timeout: 120_000,
              maxBuffer: 8 * 1024 * 1024,
              windowsHide: true,
            }
          );

          const extHashAfter = hashExtensionDirectory(ext.dir);
          if (extHashAfter !== extHashBefore) {
            // Clean up any unauthorized files written into extension directory
            for (const f of listFilesRecursiveRelative(ext.dir)) {
              if (!extFilesBefore.has(f.path)) {
                try {
                  fs.unlinkSync(path.join(ext.dir, f.path));
                } catch {
                  // ignore
                }
              }
            }
            throw new CutholError(
              DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
                ext.name,
                `İşlemci betiği eklenti klasörünün içine yazma girişiminde bulundu.`
              )
            );
          }

          // Check if the script wrote any unauthorized files in isolatedTmpDir other than sandboxOutPath
          const sandboxEntries = fs.readdirSync(isolatedTmpDir);
          const extraEntries = sandboxEntries.filter((e) => e !== path.basename(sandboxOutPath));
          if (extraEntries.length > 0) {
            throw new CutholError(
              DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
                ext.name,
                `İşlemci betiği Cuthol'un verdiği çıktı yolu dışına ('${extraEntries.join(", ")}') dosya yazdı.`
              )
            );
          }

          if (nodeProc.status !== 0) {
            throw new CutholError(
              DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
                ext.name,
                procName,
                `Node betiği çıkış kodu ${nodeProc.status}: ${(nodeProc.stderr || nodeProc.stdout || "").trim()}`
              )
            );
          }

          if (!fs.existsSync(sandboxOutPath)) {
            throw new CutholError(
              DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
                ext.name,
                procName,
                `Node betiği beklenen çıktı dosyasını üretmedi.`
              )
            );
          }

          const stdoutTrimmed = (nodeProc.stdout || "").trim();
          if (stdoutTrimmed) {
            const lastLine = stdoutTrimmed.split(/\r?\n/).pop()!.trim();
            try {
              const parsed = JSON.parse(lastLine);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                scriptOutput = parsed as Record<string, unknown>;
              }
            } catch {
              throw new CutholError(
                DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
                  ext.name,
                  procName,
                  `Node betiği stdout üzerinde geçerli bir JSON döndürmedi: '${lastLine.slice(0, 120)}'`
                )
              );
            }
          }

          fs.copyFileSync(sandboxOutPath, tmpOutputPath);
        } finally {
          fs.rmSync(isolatedTmpDir, { recursive: true, force: true });
        }
      }

      fs.renameSync(tmpOutputPath, finalOutputPath);
      ledger.setExtensionProcessorResult(cacheKey, finalOutputPath, {
        extension: ext.name,
        version: ext.version,
        processor: procName,
        params: resolvedParams,
        script_output: scriptOutput,
      });
    }

    const { sha256: outSha256, probe: outProbe, kind: detectedKind } = probeLocalMediaFile(
      finalOutputPath,
      ledger
    );
    const finalKind: AssetKind = proc.asset_kind ?? detectedKind;

    const { result: outputAsset } = commitVerifiedMutation(
      options.workspaceDir,
      `extension.run:${ext.name}.${procName}`,
      (seq) => {
        const existing = seq.library.find(
          (item) =>
            item.digest_sha256 === outSha256 &&
            (!options.targetHandle || item.handle === options.targetHandle)
        );
        if (existing) {
          return existing;
        }
        const handle =
          options.targetHandle ?? allocateNextHandle(seq, assetPrefixForKind(finalKind));
        if (seq.library.some((item) => item.handle === handle)) {
          throw new CutholError(DIAGNOSTICS.DUPLICATE_HANDLE(handle));
        }
        const relUri = path.relative(paths.rootDir, finalOutputPath).replace(/\\/g, "/");
        const uri = relUri.startsWith("..") ? finalOutputPath.replace(/\\/g, "/") : relUri;
        const item: LibraryItem = {
          handle,
          kind: finalKind,
          uri,
          digest_sha256: outSha256,
          probe: outProbe,
          analysis_refs: {},
        };
        seq.library.push(item);
        return item;
      }
    );

    return {
      extension: ext.name,
      version: ext.version,
      processor: procName,
      kind: proc.kind,
      cached,
      cache_key: cacheKey,
      elapsed_ms: Date.now() - startedAt,
      input_handle: inputHandle,
      input_path: inputAbsPath,
      input_sha256: inputSha256,
      output_asset: outputAsset,
      params: resolvedParams,
      security_notice: securityNotice,
      ...(scriptOutput ? { script_output: scriptOutput } : {}),
    };
  } finally {
    ledger.close();
  }
}

function resolveTemplateValue(
  rawVal: unknown,
  params: Record<string, number | string | boolean>,
  stepOutputs: Map<string, Record<string, unknown>>,
  lastHandle: string | null
): unknown {
  if (typeof rawVal === "string") {
    const exactMatch = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/.exec(rawVal);
    if (exactMatch) {
      const expr = exactMatch[1];
      if (expr === "last_handle" && lastHandle !== null) return lastHandle;
      if (expr.startsWith("steps.")) {
        const [, stepId, field] = expr.split(".");
        const stepObj = stepOutputs.get(stepId);
        if (stepObj && field in stepObj) return stepObj[field];
      }
      if (expr in params) return params[expr];
    }
    return rawVal.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, expr: string) => {
      if (expr === "last_handle" && lastHandle !== null) return lastHandle;
      if (expr.startsWith("steps.")) {
        const [, stepId, field] = expr.split(".");
        const stepObj = stepOutputs.get(stepId);
        if (stepObj && field in stepObj && stepObj[field] !== undefined) {
          return String(stepObj[field]);
        }
      }
      if (expr in params) return String(params[expr]);
      return `{{${expr}}}`;
    });
  }
  if (Array.isArray(rawVal)) {
    return rawVal.map((item) => resolveTemplateValue(item, params, stepOutputs, lastHandle));
  }
  if (rawVal && typeof rawVal === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawVal as Record<string, unknown>)) {
      out[k] = resolveTemplateValue(v, params, stepOutputs, lastHandle);
    }
    return out;
  }
  return rawVal;
}

function buildCliArgsFromRecipeStep(
  tool: string,
  action: string | undefined,
  args: Record<string, unknown>,
  workspaceDir: string
): string[] {
  const argv: string[] = [tool];
  if (action) argv.push(action.replace(/_/g, "-"));

  for (const [rawKey, rawVal] of Object.entries(args)) {
    if (rawVal === undefined || rawVal === null) continue;
    if (tool === "library" && action === "ingest" && rawKey === "files") {
      const files = Array.isArray(rawVal) ? rawVal.map(String) : [String(rawVal)];
      argv.push(...files);
      continue;
    }
    const flag = rawKey.replace(/_/g, "-");
    if (typeof rawVal === "boolean") {
      if (rawVal) argv.push(`--${flag}=true`);
      else argv.push(`--${flag}=false`);
    } else if (Array.isArray(rawVal)) {
      argv.push(`--${flag}=${rawVal.map(String).join(",")}`);
    } else if (typeof rawVal === "object") {
      argv.push(`--${flag}=${JSON.stringify(rawVal)}`);
    } else {
      argv.push(`--${flag}=${String(rawVal)}`);
    }
  }
  argv.push(`--dir=${workspaceDir}`);
  return argv;
}

/**
 * Executes a parameterized extension recipe as a single atomic journal unit:
 * - Every step's outcome is reported individually in `steps_executed`.
 * - If any step fails, the sequence and journal are rolled back to the pre-recipe state.
 * - On success, all sequence mutations across the recipe are collapsed into a single undo revision (`rN -> r(N+1)`).
 */
export function runExtensionRecipe(options: {
  workspaceDir: string;
  extensionName: string;
  recipeName?: string;
  params?: Record<string, unknown>;
  scope?: ExtensionScope;
  dryRun?: boolean;
}): {
  extension: string;
  version: string;
  recipe: string;
  undo_policy: "single_atomic_revision";
  params: Record<string, number | string | boolean>;
  steps_executed: Array<{
    index: number;
    id: string;
    tool: string;
    action: string | null;
    handle: string | null;
    summary: string;
  }>;
  last_handle: string | null;
  security_notice: {
    manifest_path: string;
    script_paths: string[];
    network_declared: boolean;
  };
  dry_run?: boolean;
} {
  const ext = resolveExtension(options.extensionName, options.workspaceDir, options.scope);
  const scriptPaths = Object.values(ext.manifest.processors ?? {})
    .filter((p) => p.kind === "node" && p.script)
    .map((p) => path.resolve(ext.dir, p.script!));
  const securityNotice = {
    manifest_path: ext.manifestPath,
    script_paths: scriptPaths,
    network_declared: ext.network,
  };
  const recipes = ext.manifest.recipes ?? {};
  const recNames = Object.keys(recipes);
  if (recNames.length === 0) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
        ext.name,
        options.recipeName || "recipe",
        `'${ext.name}' eklentisinde tanımlı hiçbir tarif ('recipes') yok.`
      )
    );
  }

  const recName = options.recipeName?.trim() || (recNames.length === 1 ? recNames[0] : "");
  if (!recName || !recipes[recName]) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
        ext.name,
        recName || "(belirtilmedi)",
        `Tarif bulunamadı. Mevcut tarifler: ${recNames.join(", ")}.`
      )
    );
  }
  const recipe = recipes[recName];
  const resolvedParams = resolveValidatedParams(
    recipe.params,
    options.params,
    ext.name,
    `recipe:${recName}`
  );

  if (options.dryRun) {
    return {
      extension: ext.name,
      version: ext.version,
      recipe: recName,
      undo_policy: "single_atomic_revision",
      params: resolvedParams,
      steps_executed: recipe.steps.map((s, idx) => ({
        index: idx + 1,
        id: s.id ?? `step_${idx + 1}`,
        tool: s.tool,
        action: s.action ?? null,
        handle: null,
        summary: `dry-run: ${s.tool}${s.action ? `.${s.action}` : ""}`,
      })),
      last_handle: null,
      security_notice: securityNotice,
      dry_run: true,
    };
  }

  const paths = resolveWorkspacePaths(options.workspaceDir);
  const { sequence: preSeq } = loadSequence(options.workspaceDir);
  const preSeqRaw = fs.readFileSync(paths.sequenceFile, "utf8");
  const preManifest = loadJournalManifest(paths);
  const preManifestRaw = fs.existsSync(paths.journalIndexFile)
    ? fs.readFileSync(paths.journalIndexFile, "utf8")
    : null;
  const preRev = preSeq.meta.revision;

  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli.js");
  const stepOutputs = new Map<string, Record<string, unknown>>();
  const stepsExecuted: Array<{
    index: number;
    id: string;
    tool: string;
    action: string | null;
    handle: string | null;
    summary: string;
  }> = [];
  let lastHandle: string | null = null;

  try {
    for (let i = 0; i < recipe.steps.length; i++) {
      const step = recipe.steps[i];
      const stepId = step.id ?? `step_${i + 1}`;
      const resolvedArgs = (resolveTemplateValue(
        step.args ?? {},
        resolvedParams,
        stepOutputs,
        lastHandle
      ) ?? {}) as Record<string, unknown>;

      if (step.tool === "extension" && (!step.action || step.action === "run")) {
        const targetExt = String(resolvedArgs.name ?? ext.name);
        const procName =
          typeof resolvedArgs.processor === "string" ? resolvedArgs.processor : undefined;
        const inputVal = String(resolvedArgs.input ?? resolvedArgs.handle ?? "");
        const stepParams =
          resolvedArgs.params && typeof resolvedArgs.params === "object"
            ? (resolvedArgs.params as Record<string, unknown>)
            : {};
        const procRes = runExtensionProcessor({
          workspaceDir: options.workspaceDir,
          extensionName: targetExt,
          processorName: procName,
          inputHandleOrPath: inputVal,
          targetHandle:
            typeof resolvedArgs.target_handle === "string" ? resolvedArgs.target_handle : undefined,
          params: stepParams,
        });
        const handle = procRes.output_asset.handle;
        lastHandle = handle;
        stepOutputs.set(stepId, {
          handle,
          id: handle,
          uri: procRes.output_asset.uri,
          duration_ms: `${procRes.output_asset.probe.duration_ms}ms`,
          cached: procRes.cached,
        });
        stepsExecuted.push({
          index: i + 1,
          id: stepId,
          tool: "extension",
          action: "run",
          handle,
          summary: `${targetExt}.${procRes.processor} -> ${handle} (${procRes.cached ? "cached" : "processed"})`,
        });
        continue;
      }

      const cliArgv = buildCliArgsFromRecipeStep(
        step.tool,
        step.action,
        resolvedArgs,
        paths.rootDir
      );
      const proc = spawnSync(process.execPath, [cliPath, ...cliArgv], {
        cwd: paths.rootDir,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });

      if (proc.status !== 0) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            ext.name,
            `recipe:${recName}#${stepId}`,
            `Adım ${i + 1} (${step.tool}.${step.action ?? ""}) başarısız oldu: ${(proc.stderr || proc.stdout || "").trim()}`
          )
        );
      }

      let parsedEnv: Record<string, unknown> = {};
      try {
        parsedEnv = JSON.parse(proc.stdout) as Record<string, unknown>;
      } catch {
        parsedEnv = {};
      }

      let producedHandle: string | null = null;
      if (Array.isArray(parsedEnv.ingested) && parsedEnv.ingested[0]?.handle) {
        producedHandle = String(parsedEnv.ingested[0].handle);
      } else if (parsedEnv.clip && typeof (parsedEnv.clip as { id?: unknown }).id === "string") {
        producedHandle = String((parsedEnv.clip as { id: string }).id);
      } else if (parsedEnv.cue && typeof (parsedEnv.cue as { id?: unknown }).id === "string") {
        producedHandle = String((parsedEnv.cue as { id: string }).id);
      } else if (parsedEnv.asset && typeof (parsedEnv.asset as { handle?: unknown }).handle === "string") {
        producedHandle = String((parsedEnv.asset as { handle: string }).handle);
      } else if (typeof parsedEnv.handle === "string") {
        producedHandle = parsedEnv.handle;
      }

      if (producedHandle) lastHandle = producedHandle;
      stepOutputs.set(stepId, {
        ...parsedEnv,
        handle: producedHandle,
        id: producedHandle,
      });
      const deltaSummary =
        parsedEnv.delta && typeof (parsedEnv.delta as { summary?: unknown }).summary === "string"
          ? String((parsedEnv.delta as { summary: string }).summary)
          : `${step.tool}${step.action ? `.${step.action}` : ""}`;
      stepsExecuted.push({
        index: i + 1,
        id: stepId,
        tool: step.tool,
        action: step.action ?? null,
        handle: producedHandle,
        summary: deltaSummary,
      });
    }

    // Collapse all mutations from the recipe into a single atomic revision (preRev + 1)
    const { sequence: postSeq } = loadSequence(options.workspaceDir);
    if (JSON.stringify(postSeq) !== JSON.stringify(preSeq)) {
      const targetRev = preRev + 1;
      postSeq.meta.revision = targetRev;
      postSeq.meta.updated_at = new Date().toISOString();

      const ver = verifySequence(postSeq, paths);
      if (!ver.ok) {
        const firstErr = ver.diagnostics.find((d) => d.severity === "ERROR")!;
        throw new CutholError(firstErr, ver.diagnostics);
      }

      // Remove intermediate snapshots > targetRev
      if (fs.existsSync(paths.journalDir)) {
        for (const f of fs.readdirSync(paths.journalDir)) {
          const m = /^rev_(\d+)\.json$/.exec(f);
          if (m && parseInt(m[1], 10) > targetRev) {
            try {
              fs.unlinkSync(path.join(paths.journalDir, f));
            } catch {
              // ignore
            }
          }
        }
      }

      const snapName = `rev_${String(targetRev).padStart(4, "0")}.json`;
      fs.writeFileSync(paths.sequenceFile, JSON.stringify(postSeq, null, 2), "utf8");
      fs.writeFileSync(path.join(paths.journalDir, snapName), JSON.stringify(postSeq, null, 2), "utf8");

      const operationName = `extension.run:${ext.name}.${recName}`;
      const deltaInfo = computeSequenceDelta(preSeq, postSeq, operationName);
      const baseEntries = preManifest.entries.filter((e) => e.revision <= preRev);
      const newEntry: JournalEntry = {
        revision: targetRev,
        timestamp: postSeq.meta.updated_at,
        operation: operationName,
        tag: null,
        snapshot_file: snapName,
        delta_summary: deltaInfo.summary,
        inverse_kind: deltaInfo.inverse_kind,
        inverse_summary: deltaInfo.inverse_summary,
        affected_ids: deltaInfo.affected_ids,
        touches_protected: deltaInfo.touches_protected,
        protected_ids: deltaInfo.protected_ids,
      };
      const nextManifest = {
        cursor_revision: targetRev,
        entries: [...baseEntries, newEntry],
      };
      fs.writeFileSync(paths.journalIndexFile, JSON.stringify(nextManifest, null, 2), "utf8");
    }
  } catch (err) {
    // Full atomic rollback to pre-recipe state
    fs.writeFileSync(paths.sequenceFile, preSeqRaw, "utf8");
    if (preManifestRaw !== null) {
      fs.writeFileSync(paths.journalIndexFile, preManifestRaw, "utf8");
    }
    throw err;
  }

  return {
    extension: ext.name,
    version: ext.version,
    recipe: recName,
    undo_policy: "single_atomic_revision",
    params: resolvedParams,
    steps_executed: stepsExecuted,
    last_handle: lastHandle,
    security_notice: securityNotice,
  };
}
