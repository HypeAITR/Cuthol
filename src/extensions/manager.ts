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
import { parseTimeMs } from "../core/time.js";
import { resolveCueStartMs } from "../core/timeline.js";
import {
  ensureWorkspaceDirectories,
  JournalEntry,
  loadJournalManifest,
  loadSequence,
  resolveWorkspacePaths,
  WorkspacePaths,
} from "../core/workspace.js";
import { exportBridgeDataForCue } from "../compositor/bridge_exporter.js";
import { normTurkish } from "../compositor/cuthol_runtime.js";
import { MediaLedger } from "../library/ledger.js";
import { probeLocalMediaFile, resolveLibraryItemPath } from "../library/probe.js";
import {
  CueSheetCueEntry,
  CueSheetDiff,
  CutholCueSheet,
  mergeCueSheetIntoSequence,
} from "../sequence/cuesheet.js";
import { projectTranscriptAcrossSequence } from "../sequence/spine.js";
import { TranscriptDocument } from "../speech/providers.js";
import { commitVerifiedMutation, VerificationReport, verifySequence } from "../verify/gates.js";
import { syncAllCompositionBridges } from "../compositor/bridge_exporter.js";

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

export interface ExtensionPlannerSpec {
  kind?: "node" | "planner";
  description?: string;
  script: string;
  params?: Record<string, ExtensionParamDef>;
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
  planners?: Record<string, ExtensionPlannerSpec>;
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
    planners: string[];
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
  "planners",
  "recipes",
  "guide",
]);

const ALLOWED_PLANNER_KEYS = new Set(["kind", "description", "script", "params"]);

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

export function assertScriptRespectsNetworkPolicy(
  scriptAbsPath: string,
  ext: ResolvedExtension
): void {
  if (ext.network) return;
  let source = "";
  try {
    source = fs.readFileSync(scriptAbsPath, "utf8");
  } catch {
    return;
  }
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\r\n]*/g, "");
  const forbiddenPatterns: Array<{ re: RegExp; label: string }> = [
    { re: /\bfetch\s*\(/, label: "fetch()" },
    { re: /\bnew\s+WebSocket\s*\(/, label: "WebSocket" },
    {
      re: /(?:require|import)\s*\(?[\s'"]*(?:node:)?(?:http|https|http2|net|tls|dns|dgram)\b/,
      label: "node:http/https/net/tls/dns",
    },
    {
      re: /\b(?:http|https|net|tls)\s*\.\s*(?:request|get|connect|createConnection|createServer)\s*\(/,
      label: "http/https/net.request/connect",
    },
  ];
  for (const pat of forbiddenPatterns) {
    if (pat.re.test(stripped)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
          ext.name,
          `Eklenti manifestinde 'network: true' bildirmediği halde ağ erişimi ('${pat.label}') kullanıyor.`
        )
      );
    }
  }
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

  let plannersSpec: Record<string, ExtensionPlannerSpec> | undefined;
  if (obj.planners !== undefined) {
    if (!obj.planners || typeof obj.planners !== "object" || Array.isArray(obj.planners)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'planners' alanı bir nesne olmalıdır.`)
      );
    }
    plannersSpec = {};
    for (const [planName, rawPlan] of Object.entries(obj.planners as Record<string, unknown>)) {
      if (!EXTENSION_NAME_RE.test(planName)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `Geçersiz planlayıcı adı '${planName}'.`)
        );
      }
      if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'planners.${planName}' bir nesne olmalıdır.`)
        );
      }
      const plObj = rawPlan as Record<string, unknown>;
      for (const k of Object.keys(plObj)) {
        if (!ALLOWED_PLANNER_KEYS.has(k)) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              name,
              `'planners.${planName}' içinde bilinmeyen alan '${k}' (izin verilenler: ${[...ALLOWED_PLANNER_KEYS].join(", ")}).`
            )
          );
        }
      }
      if (plObj.kind !== undefined && plObj.kind !== "node" && plObj.kind !== "planner") {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            name,
            `'planners.${planName}.kind' değeri 'node' veya 'planner' olmalıdır.`
          )
        );
      }
      const script = typeof plObj.script === "string" ? plObj.script.trim() : "";
      if (!isSafeRelativeSubpath(script) || !/\.(c|m)?js$/i.test(script)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            name,
            `'planners.${planName}.script' eklenti klasörü içinde göreli bir '.js' dosyası olmalıdır.`
          )
        );
      }
      const params = validateParamsMap(plObj.params, name, `planners.${planName}`);
      plannersSpec[planName] = {
        ...(typeof plObj.kind === "string" ? { kind: plObj.kind as "node" | "planner" } : {}),
        ...(typeof plObj.description === "string" ? { description: plObj.description } : {}),
        script,
        ...(Object.keys(params).length > 0 ? { params } : {}),
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
    ...(plannersSpec !== undefined ? { planners: plannersSpec } : {}),
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
  | "recipe"
  | "planner";

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

  if (tpl === "planner") {
    manifest.planners = {
      ...(manifest.planners ?? {}),
      event_sfx: {
        description: "Reads composition declared events and word timings, and proposes SFX cues.",
        script: "planner.js",
        params: {
          asset_handle: {
            type: "string",
            required: false,
            description: "SFX library handle to place at matching events.",
          },
          lane_id: {
            type: "string",
            default: "ln_sfx",
            description: "Target audio lane for generated SFX cues.",
          },
          gain_db: {
            type: "number",
            default: -6,
            description: "Gain in dB for generated SFX cues.",
          },
        },
      },
    };
    const plannerScript = [
      `#!/usr/bin/env node`,
      `const fs = require("node:fs");`,
      `const [snapshotPath, outputPath, rawParams] = process.argv.slice(2);`,
      `const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));`,
      `const params = rawParams ? JSON.parse(rawParams) : (snapshot.params || {});`,
      `const laneId = params.lane_id || "ln_sfx";`,
      `const gainDb = typeof params.gain_db === "number" ? params.gain_db : -6;`,
      `const defaultAsset = params.asset_handle || (snapshot.sequence.library.find((a) => a.kind === "audio")?.handle);`,
      `const cues = [];`,
      `for (const ev of snapshot.events || []) {`,
      `  const assetHandle = (ev.meta && ev.meta.asset_handle) || defaultAsset;`,
      `  if (!assetHandle) continue;`,
      `  cues.push({`,
      `    lane_id: laneId,`,
      `    kind: "sfx",`,
      `    asset_handle: assetHandle,`,
      `    at_ms: ev.sequence_ms,`,
      `    duration_ms: (ev.meta && ev.meta.duration_ms) || 500,`,
      `    gain_db: (ev.meta && typeof ev.meta.gain_db === "number") ? ev.meta.gain_db : gainDb,`,
      `  });`,
      `}`,
      `fs.writeFileSync(outputPath, JSON.stringify({ cues }, null, 2), "utf8");`,
      ``,
    ].join("\n");
    fs.writeFileSync(path.join(extDir, "planner.js"), plannerScript, "utf8");
    filesCreated.push("planner.js");
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
    manifest.planners
      ? `- **Planners:** ${Object.keys(manifest.planners).map((k) => `\`${k}\``).join(", ")}`
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

  commitVerifiedMutation(options.workspaceDir, "extension.enable", (seq, paths) => {
    if (!seq.extensions) seq.extensions = [];
    const idx = seq.extensions.findIndex((e) => e.name === ext.name);
    if (idx >= 0) {
      seq.extensions[idx] = newRef;
    } else {
      seq.extensions.push(newRef);
    }
    seq.extensions.sort((a, b) => a.name.localeCompare(b.name));
    try {
      syncAllCompositionBridges(seq, paths, { explicit: true });
    } catch {
      // non-blocking bridge sync
    }
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
        assertScriptRespectsNetworkPolicy(scriptAbsPath!, ext);
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
        const planName =
          typeof resolvedArgs.planner === "string" ? resolvedArgs.planner : undefined;
        const inputVal = String(resolvedArgs.input ?? resolvedArgs.handle ?? "");
        const stepParams =
          resolvedArgs.params && typeof resolvedArgs.params === "object"
            ? (resolvedArgs.params as Record<string, unknown>)
            : {};
        if (planName) {
          const planRes = runExtensionPlanner({
            workspaceDir: options.workspaceDir,
            extensionName: targetExt,
            plannerName: planName,
            params: stepParams,
          });
          const firstAdded = planRes.cues_added[0] ?? null;
          if (firstAdded) lastHandle = firstAdded;
          stepOutputs.set(stepId, {
            handle: firstAdded,
            id: firstAdded,
            cues_added: planRes.cues_added,
          });
          stepsExecuted.push({
            index: i + 1,
            id: stepId,
            tool: "extension",
            action: "run",
            handle: firstAdded,
            summary: `${targetExt}.${planRes.planner} -> +${planRes.cues_added.length} cue(s)`,
          });
          continue;
        }
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

export interface CompositionDeclaredEvent {
  id: string;
  name: string;
  kind?: string;
  cue_id: string;
  lane_id: string;
  composition_dir: string;
  local_ms: number;
  local_sec: number;
  sequence_ms: number;
  sequence_sec: number;
  meta?: Record<string, unknown>;
  source: "events_json" | "html_script" | "html_attr" | "js_call";
}

export interface PlannerCompositionSnapshot {
  cue_id: string;
  lane_id: string;
  composition_dir: string;
  entry_html: string;
  at_ms: number;
  duration_ms: number;
  end_ms: number;
  props: Record<string, unknown>;
  words: Array<{
    word: string;
    norm: string;
    local_ms: number;
    local_end_ms: number;
    local_sec: number;
    local_end_sec: number;
    sequence_ms: number;
    sequence_end_ms: number;
    sequence_sec: number;
    sequence_end_sec: number;
  }>;
  events: CompositionDeclaredEvent[];
  cuts: Array<{
    local_ms: number;
    local_sec: number;
    sequence_ms: number;
    sequence_sec: number;
    kind: string;
  }>;
}

export interface CutholPlannerSnapshot {
  schema: "cuthol.planner.snapshot/1";
  workspace_dir: string;
  extension_dir: string;
  params: Record<string, number | string | boolean>;
  sequence: CutholSequence;
  words: Array<{
    word: string;
    norm: string;
    source_start_ms: number;
    source_end_ms: number;
    sequence_start_ms: number;
    sequence_end_ms: number;
    sequence_start_sec: number;
    sequence_end_sec: number;
    owner_id: string;
    asset_handle: string;
  }>;
  compositions: PlannerCompositionSnapshot[];
  events: CompositionDeclaredEvent[];
}

function parseFlexibleLocalMs(rawVal: unknown, treatPlainNumberAsSec = false): number | null {
  if (typeof rawVal === "number" && Number.isFinite(rawVal)) {
    return Math.max(0, Math.round(treatPlainNumberAsSec ? rawVal * 1000 : rawVal));
  }
  if (typeof rawVal === "string") {
    const trimmed = rawVal.trim();
    if (!trimmed) return null;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return null;
      return Math.max(0, Math.round(treatPlainNumberAsSec ? n * 1000 : n));
    }
    try {
      return Math.max(0, parseTimeMs(trimmed));
    } catch {
      return null;
    }
  }
  return null;
}

function parseRawEventObject(
  raw: unknown,
  cueId: string,
  laneId: string,
  compDirRel: string,
  cueStartMs: number,
  source: CompositionDeclaredEvent["source"],
  index: number
): CompositionDeclaredEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const rawName = obj.name ?? obj.event ?? obj.type ?? obj.label ?? obj.id;
  if (typeof rawName !== "string" || !rawName.trim()) return null;
  const name = rawName.trim();

  let localMs: number | null = null;
  if (obj.at_ms !== undefined) localMs = parseFlexibleLocalMs(obj.at_ms, false);
  else if (obj.offset_ms !== undefined) localMs = parseFlexibleLocalMs(obj.offset_ms, false);
  else if (obj.local_ms !== undefined) localMs = parseFlexibleLocalMs(obj.local_ms, false);
  else if (obj.time_ms !== undefined) localMs = parseFlexibleLocalMs(obj.time_ms, false);
  else if (obj.at_sec !== undefined) localMs = parseFlexibleLocalMs(obj.at_sec, true);
  else if (obj.local_sec !== undefined) localMs = parseFlexibleLocalMs(obj.local_sec, true);
  else if (obj.t !== undefined) localMs = parseFlexibleLocalMs(obj.t, true);
  else if (obj.sec !== undefined) localMs = parseFlexibleLocalMs(obj.sec, true);
  else if (obj.time !== undefined) {
    localMs =
      typeof obj.time === "number"
        ? parseFlexibleLocalMs(obj.time, true)
        : parseFlexibleLocalMs(obj.time, false);
  } else if (obj.at !== undefined) {
    localMs =
      typeof obj.at === "number" && !Number.isInteger(obj.at) && obj.at < 600
        ? parseFlexibleLocalMs(obj.at, true)
        : parseFlexibleLocalMs(obj.at, false);
  }

  if (localMs === null || !Number.isFinite(localMs)) return null;

  const meta: Record<string, unknown> = {};
  if (obj.meta && typeof obj.meta === "object" && !Array.isArray(obj.meta)) {
    Object.assign(meta, obj.meta as Record<string, unknown>);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (
      ![
        "id",
        "name",
        "event",
        "kind",
        "type",
        "label",
        "at",
        "at_ms",
        "offset_ms",
        "local_ms",
        "time_ms",
        "at_sec",
        "local_sec",
        "t",
        "sec",
        "time",
        "meta",
      ].includes(k)
    ) {
      meta[k] = v;
    }
  }

  const kindStr =
    typeof obj.kind === "string" && obj.kind.trim()
      ? obj.kind.trim()
      : typeof obj.type === "string" && obj.type.trim() && obj.type !== rawName
        ? obj.type.trim()
        : undefined;

  return {
    id:
      typeof obj.id === "string" && obj.id.trim() && obj.id !== rawName
        ? obj.id.trim()
        : `${cueId}_ev_${index}`,
    name,
    ...(kindStr ? { kind: kindStr } : {}),
    cue_id: cueId,
    lane_id: laneId,
    composition_dir: compDirRel,
    local_ms: localMs,
    local_sec: Number((localMs / 1000).toFixed(4)),
    sequence_ms: cueStartMs + localMs,
    sequence_sec: Number(((cueStartMs + localMs) / 1000).toFixed(4)),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    source,
  };
}

/**
 * Extracts composition-declared events without opening a browser:
 * 1. `events.json`, `cuthol-events.json`, `assets/events.json`, or `assets/cuthol-events.json`
 * 2. `<script id="cuthol-events" type="application/json">` (or `data-cuthol-events`) in entry HTML
 * 3. HTML elements with `data-cuthol-event="<name>"` (or `data-event="<name>"`) and `data-cuthol-at` / `data-at` / `data-start`
 * 4. Static JS calls `C.event("name", timeSecOrMs, meta)` or `/* @cuthol-event name 800ms * /` comments
 */
export function extractCompositionDeclaredEvents(options: {
  absCompDir: string;
  compDirRel: string;
  entryHtml: string;
  cueId: string;
  laneId: string;
  cueStartMs: number;
  cueDurationMs: number;
}): CompositionDeclaredEvent[] {
  const { absCompDir, compDirRel, entryHtml, cueId, laneId, cueStartMs } = options;
  if (!fs.existsSync(absCompDir)) return [];

  const events: CompositionDeclaredEvent[] = [];
  let seqIdx = 1;

  // 1. JSON files in composition folder
  const jsonCandidates = [
    path.join(absCompDir, "events.json"),
    path.join(absCompDir, "cuthol-events.json"),
    path.join(absCompDir, "assets", "events.json"),
    path.join(absCompDir, "assets", "cuthol-events.json"),
  ];
  for (const candidate of jsonCandidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { events?: unknown }).events)
          ? ((parsed as { events: unknown[] }).events)
          : [];
      for (const rawEv of list) {
        const ev = parseRawEventObject(
          rawEv,
          cueId,
          laneId,
          compDirRel,
          cueStartMs,
          "events_json",
          seqIdx
        );
        if (ev) {
          events.push(ev);
          seqIdx++;
        }
      }
    } catch {
      // ignore malformed optional event file
    }
  }

  // 2 & 3 & 4. Entry HTML (script JSON blocks, data-cuthol-event attributes, JS C.event calls)
  const entryPath = path.join(absCompDir, entryHtml || "index.html");
  if (fs.existsSync(entryPath)) {
    let html = "";
    try {
      html = fs.readFileSync(entryPath, "utf8");
    } catch {
      html = "";
    }

    if (html) {
      // 2a. <script id="cuthol-events" type="application/json">...</script>
      const scriptBlockRe =
        /<script\b[^>]*(?:\bid=["']cuthol-events["']|\bdata-cuthol-events\b)[^>]*>([\s\S]*?)<\/script>/gi;
      let sm: RegExpExecArray | null;
      while ((sm = scriptBlockRe.exec(html)) !== null) {
        try {
          const parsed = JSON.parse(sm[1].trim()) as unknown;
          const list = Array.isArray(parsed)
            ? parsed
            : parsed &&
                typeof parsed === "object" &&
                Array.isArray((parsed as { events?: unknown }).events)
              ? ((parsed as { events: unknown[] }).events)
              : [];
          for (const rawEv of list) {
            const ev = parseRawEventObject(
              rawEv,
              cueId,
              laneId,
              compDirRel,
              cueStartMs,
              "html_script",
              seqIdx
            );
            if (ev) {
              events.push(ev);
              seqIdx++;
            }
          }
        } catch {
          // ignore
        }
      }

      // 3. HTML elements with data-cuthol-event="..."
      const tagRe = /<([a-zA-Z0-9_-]+)\b([^>]*?\bdata-(?:cuthol-)?event\s*=\s*["'][^"']+["'][^>]*)>/gi;
      let tm: RegExpExecArray | null;
      while ((tm = tagRe.exec(html)) !== null) {
        const attrs = tm[2];
        const getAttr = (attrName: string): string | null => {
          const r = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
          const m = r.exec(attrs);
          return m ? (m[1] ?? m[2] ?? null) : null;
        };
        const evName = getAttr("data-cuthol-event") ?? getAttr("data-event");
        if (!evName || !evName.trim()) continue;
        const rawAt =
          getAttr("data-cuthol-at") ??
          getAttr("data-event-at") ??
          getAttr("data-at") ??
          getAttr("data-time");
        const rawStart = getAttr("data-start");
        let localMs: number | null = null;
        if (rawAt !== null) {
          localMs = parseFlexibleLocalMs(rawAt, false);
        } else if (rawStart !== null) {
          localMs = parseFlexibleLocalMs(
            rawStart,
            /^-?\d+(?:\.\d+)?$/.test(rawStart.trim())
          );
        }
        if (localMs === null) continue;

        let meta: Record<string, unknown> | undefined;
        const rawMeta = getAttr("data-cuthol-meta") ?? getAttr("data-event-meta");
        if (rawMeta) {
          try {
            const parsedMeta = JSON.parse(rawMeta);
            if (parsedMeta && typeof parsedMeta === "object" && !Array.isArray(parsedMeta)) {
              meta = parsedMeta as Record<string, unknown>;
            }
          } catch {
            // ignore
          }
        }
        const rawAsset = getAttr("data-cuthol-asset") ?? getAttr("data-event-asset");
        if (rawAsset) {
          meta = { ...(meta ?? {}), asset_handle: rawAsset };
        }
        const rawKind = getAttr("data-cuthol-kind") ?? getAttr("data-event-kind");

        events.push({
          id: `${cueId}_ev_${seqIdx++}`,
          name: evName.trim(),
          ...(rawKind ? { kind: rawKind.trim() } : {}),
          cue_id: cueId,
          lane_id: laneId,
          composition_dir: compDirRel,
          local_ms: localMs,
          local_sec: Number((localMs / 1000).toFixed(4)),
          sequence_ms: cueStartMs + localMs,
          sequence_sec: Number(((cueStartMs + localMs) / 1000).toFixed(4)),
          ...(meta ? { meta } : {}),
          source: "html_attr",
        });
      }

      // 4. Static JS calls: C.event("paper_drop", 0.8, { ... }) or window.__cuthol.event("paper_drop", "800ms")
      const jsCallRe =
        /\b(?:C|__cuthol)\s*\.\s*event\s*\(\s*["']([^"']+)["']\s*,\s*([0-9]+(?:\.[0-9]+)?|["'][^"']+["'])(?:\s*,\s*(\{[^{}]*\}))?\s*\)/g;
      let jm: RegExpExecArray | null;
      while ((jm = jsCallRe.exec(html)) !== null) {
        const evName = jm[1].trim();
        const rawTimeToken = jm[2].trim();
        let localMs: number | null = null;
        if (rawTimeToken.startsWith('"') || rawTimeToken.startsWith("'")) {
          localMs = parseFlexibleLocalMs(rawTimeToken.slice(1, -1), false);
        } else {
          const num = Number(rawTimeToken);
          localMs = Number.isFinite(num)
            ? Math.max(0, Math.round(num <= 120 && !rawTimeToken.endsWith("00") ? num * 1000 : num))
            : null;
        }
        if (localMs === null) continue;
        let meta: Record<string, unknown> | undefined;
        if (jm[3]) {
          try {
            meta = JSON.parse(jm[3]) as Record<string, unknown>;
          } catch {
            // ignore
          }
        }
        events.push({
          id: `${cueId}_ev_${seqIdx++}`,
          name: evName,
          cue_id: cueId,
          lane_id: laneId,
          composition_dir: compDirRel,
          local_ms: localMs,
          local_sec: Number((localMs / 1000).toFixed(4)),
          sequence_ms: cueStartMs + localMs,
          sequence_sec: Number(((cueStartMs + localMs) / 1000).toFixed(4)),
          ...(meta ? { meta } : {}),
          source: "js_call",
        });
      }
    }
  }

  // Deduplicate identical (name, local_ms) entries within the same composition cue
  const deduped: CompositionDeclaredEvent[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const key = `${ev.name}@${ev.local_ms}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ev);
  }
  deduped.sort((a, b) => a.sequence_ms - b.sequence_ms || a.name.localeCompare(b.name));
  return deduped;
}

export function buildPlannerSnapshot(
  seq: CutholSequence,
  paths: WorkspacePaths,
  ext: ResolvedExtension,
  params: Record<string, number | string | boolean>
): CutholPlannerSnapshot {
  const ledger = fs.existsSync(paths.ledgerFile) ? new MediaLedger(paths.ledgerFile) : null;
  const projectedWords: CutholPlannerSnapshot["words"] = [];

  try {
    if (ledger) {
      const seenHandles = new Set<string>();
      const candidateHandles: string[] = [];
      for (const clip of seq.spine.clips) {
        if (!clip.audio_chain.muted && !seenHandles.has(clip.asset_handle)) {
          seenHandles.add(clip.asset_handle);
          candidateHandles.push(clip.asset_handle);
        }
      }
      for (const lane of seq.lanes) {
        if (lane.muted) continue;
        for (const cue of lane.cues) {
          if (cue.asset_handle && !cue.audio_chain?.muted && !seenHandles.has(cue.asset_handle)) {
            seenHandles.add(cue.asset_handle);
            candidateHandles.push(cue.asset_handle);
          }
        }
      }

      for (const handle of candidateHandles) {
        const asset = seq.library.find((a) => a.handle === handle);
        if (!asset) continue;
        const doc = ledger.getLatestTranscript<TranscriptDocument>(asset.digest_sha256);
        if (!doc?.words?.length) continue;
        const rawWords = doc.words.map((w) => ({
          word: w.punctuated_word || w.word,
          source_start_ms: w.source_start_ms,
          source_end_ms: w.source_end_ms,
          confidence: w.confidence,
        }));
        const projected = projectTranscriptAcrossSequence(seq, handle, rawWords);
        for (const pw of projected) {
          if (pw.excised || pw.sequence_start_ms === null || pw.sequence_end_ms === null) continue;
          projectedWords.push({
            word: pw.word,
            norm: normTurkish(pw.word),
            source_start_ms: pw.source_start_ms,
            source_end_ms: pw.source_end_ms,
            sequence_start_ms: pw.sequence_start_ms,
            sequence_end_ms: pw.sequence_end_ms,
            sequence_start_sec: Number((pw.sequence_start_ms / 1000).toFixed(4)),
            sequence_end_sec: Number((pw.sequence_end_ms / 1000).toFixed(4)),
            owner_id: pw.clip_id ?? handle,
            asset_handle: handle,
          });
        }
      }
    }

    // Also include embedded words on caption cues if not already covered
    if (projectedWords.length === 0) {
      for (const lane of seq.lanes) {
        if (lane.muted) continue;
        for (const cue of lane.cues) {
          if (!cue.typography?.words?.length) continue;
          for (const tw of cue.typography.words) {
            if (tw.excised || tw.sequence_start_ms === null || tw.sequence_end_ms === null) continue;
            projectedWords.push({
              word: tw.word,
              norm: normTurkish(tw.word),
              source_start_ms: tw.source_start_ms,
              source_end_ms: tw.source_end_ms,
              sequence_start_ms: tw.sequence_start_ms,
              sequence_end_ms: tw.sequence_end_ms,
              sequence_start_sec: Number((tw.sequence_start_ms / 1000).toFixed(4)),
              sequence_end_sec: Number((tw.sequence_end_ms / 1000).toFixed(4)),
              owner_id: tw.clip_id ?? cue.id,
              asset_handle: cue.asset_handle ?? cue.id,
            });
          }
        }
      }
    }
  } finally {
    ledger?.close();
  }

  projectedWords.sort((a, b) => a.sequence_start_ms - b.sequence_start_ms);

  const compositions: PlannerCompositionSnapshot[] = [];
  const allEvents: CompositionDeclaredEvent[] = [];

  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (!cue.composition && cue.kind !== "composition") continue;
      const compDirRel = cue.composition?.composition_dir ?? "";
      if (!compDirRel) continue;
      const absCompDir = path.isAbsolute(compDirRel)
        ? compDirRel
        : path.resolve(paths.rootDir, compDirRel);
      const entryHtml = cue.composition?.entry_html || "index.html";
      const cueStartMs = resolveCueStartMs(seq, cue);
      const cueEndMs = cueStartMs + cue.duration_ms;

      const bridge = exportBridgeDataForCue(seq, cue, paths);
      const compWords = bridge.words.map((bw) => {
        const localMs = Math.round(bw.t0 * 1000);
        const localEndMs = Math.round(bw.t1 * 1000);
        const seqMs = cueStartMs + localMs;
        const seqEndMs = cueStartMs + localEndMs;
        return {
          word: bw.text,
          norm: normTurkish(bw.text),
          local_ms: localMs,
          local_end_ms: localEndMs,
          local_sec: bw.t0,
          local_end_sec: bw.t1,
          sequence_ms: seqMs,
          sequence_end_ms: seqEndMs,
          sequence_sec: Number((seqMs / 1000).toFixed(4)),
          sequence_end_sec: Number((seqEndMs / 1000).toFixed(4)),
        };
      });

      const compCuts = (bridge.cuts ?? []).map((bc) => {
        const localMs = Math.round(bc.t * 1000);
        const seqMs = cueStartMs + localMs;
        return {
          local_ms: localMs,
          local_sec: bc.t,
          sequence_ms: seqMs,
          sequence_sec: Number((seqMs / 1000).toFixed(4)),
          kind: bc.kind ?? "spine_cut",
        };
      });

      const declaredEvents = extractCompositionDeclaredEvents({
        absCompDir,
        compDirRel,
        entryHtml,
        cueId: cue.id,
        laneId: lane.id,
        cueStartMs,
        cueDurationMs: cue.duration_ms,
      });
      allEvents.push(...declaredEvents);

      compositions.push({
        cue_id: cue.id,
        lane_id: lane.id,
        composition_dir: compDirRel,
        entry_html: entryHtml,
        at_ms: cueStartMs,
        duration_ms: cue.duration_ms,
        end_ms: cueEndMs,
        props: cue.composition?.props ?? {},
        words: compWords,
        events: declaredEvents,
        cuts: compCuts,
      });
    }
  }

  allEvents.sort((a, b) => a.sequence_ms - b.sequence_ms || a.name.localeCompare(b.name));

  return {
    schema: "cuthol.planner.snapshot/1",
    workspace_dir: paths.rootDir,
    extension_dir: ext.dir,
    params,
    sequence: structuredClone(seq),
    words: projectedWords,
    compositions,
    events: allEvents,
  };
}

const ALLOWED_PATCH_ROOT_KEYS = new Set([
  "title",
  "stage",
  "spine",
  "cues",
  "notes",
  "summary",
  "ok",
]);

function normalizeAndValidatePlannerPatch(
  rawPatch: unknown,
  extName: string,
  plannerName: string
): { sheet: CutholCueSheet; notes: string[] } {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
        extName,
        `planner:${plannerName}`,
        `Planlayıcı çıktısı bir Cue Sheet JSON nesnesi olmalıdır.`
      )
    );
  }
  const topObj = rawPatch as Record<string, unknown>;
  const rootObj =
    topObj.patch && typeof topObj.patch === "object" && !Array.isArray(topObj.patch)
      ? (topObj.patch as Record<string, unknown>)
      : topObj;

  for (const k of Object.keys(rootObj)) {
    if (!ALLOWED_PATCH_ROOT_KEYS.has(k)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          extName,
          `planner:${plannerName}`,
          `Planlayıcı yamasında bilinmeyen alan '${k}' (izin verilenler: title, stage, spine, cues, notes).`
        )
      );
    }
  }

  const notes: string[] = [];
  if (Array.isArray(rootObj.notes)) {
    for (const n of rootObj.notes) notes.push(String(n));
  } else if (typeof topObj.summary === "string" && topObj.summary.trim()) {
    notes.push(topObj.summary.trim());
  }

  const sheet: CutholCueSheet = {};
  if (typeof rootObj.title === "string") sheet.title = rootObj.title;
  if (rootObj.stage !== undefined) {
    if (!rootObj.stage || typeof rootObj.stage !== "object" || Array.isArray(rootObj.stage)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          extName,
          `planner:${plannerName}`,
          `Planlayıcı yamasındaki 'stage' alanı bir nesne olmalıdır.`
        )
      );
    }
    sheet.stage = rootObj.stage as CutholCueSheet["stage"];
  }

  if (rootObj.spine !== undefined) {
    if (!Array.isArray(rootObj.spine)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          extName,
          `planner:${plannerName}`,
          `Planlayıcı yamasındaki 'spine' alanı bir dizi olmalıdır.`
        )
      );
    }
    sheet.spine = rootObj.spine as CutholCueSheet["spine"];
  }

  if (rootObj.cues !== undefined) {
    if (!Array.isArray(rootObj.cues)) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          extName,
          `planner:${plannerName}`,
          `Planlayıcı yamasındaki 'cues' alanı bir dizi olmalıdır.`
        )
      );
    }
    const normalizedCues: CueSheetCueEntry[] = [];
    for (let i = 0; i < rootObj.cues.length; i++) {
      const rawCue = rootObj.cues[i];
      if (!rawCue || typeof rawCue !== "object" || Array.isArray(rawCue)) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            `planner:${plannerName}`,
            `'cues[${i}]' bir nesne olmalıdır.`
          )
        );
      }
      const cObj = { ...(rawCue as Record<string, unknown>) };
      const laneId = typeof cObj.lane_id === "string" ? cObj.lane_id.trim() : typeof cObj.lane === "string" ? cObj.lane.trim() : "";
      if (!laneId && cObj.op !== "delete") {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            `planner:${plannerName}`,
            `'cues[${i}].lane_id' alanı zorunludur.`
          )
        );
      }
      cObj.lane_id = laneId || "ln_sfx";
      delete cObj.lane;

      if (cObj.asset !== undefined && cObj.asset_handle === undefined) {
        cObj.asset_handle = cObj.asset;
        delete cObj.asset;
      }

      if (cObj.at !== undefined && cObj.at_ms === undefined) {
        cObj.at_ms = typeof cObj.at === "number" ? cObj.at : parseTimeMs(String(cObj.at));
        delete cObj.at;
      } else if (typeof cObj.at_ms === "string") {
        cObj.at_ms = parseTimeMs(cObj.at_ms);
      }

      if (cObj.duration !== undefined && cObj.duration_ms === undefined) {
        cObj.duration_ms =
          typeof cObj.duration === "number" ? cObj.duration : parseTimeMs(String(cObj.duration));
        delete cObj.duration;
      } else if (typeof cObj.duration_ms === "string") {
        cObj.duration_ms = parseTimeMs(cObj.duration_ms);
      }

      if (cObj.in !== undefined && cObj.source_in_ms === undefined) {
        cObj.source_in_ms = typeof cObj.in === "number" ? cObj.in : parseTimeMs(String(cObj.in));
        delete cObj.in;
      }
      if (cObj.out !== undefined && cObj.source_out_ms === undefined) {
        cObj.source_out_ms = typeof cObj.out === "number" ? cObj.out : parseTimeMs(String(cObj.out));
        delete cObj.out;
      }

      if (
        cObj.at_ms !== undefined &&
        (typeof cObj.at_ms !== "number" || !Number.isFinite(cObj.at_ms) || cObj.at_ms < 0)
      ) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            `planner:${plannerName}`,
            `'cues[${i}].at_ms' negatif olmayan geçerli bir milisaniye değeri olmalıdır (verilen: ${String(cObj.at_ms)}).`
          )
        );
      }
      if (
        cObj.duration_ms !== undefined &&
        (typeof cObj.duration_ms !== "number" || !Number.isFinite(cObj.duration_ms) || cObj.duration_ms <= 0)
      ) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            extName,
            `planner:${plannerName}`,
            `'cues[${i}].duration_ms' pozitif bir milisaniye değeri olmalıdır (verilen: ${String(cObj.duration_ms)}).`
          )
        );
      }

      normalizedCues.push(cObj as unknown as CueSheetCueEntry);
    }
    sheet.cues = normalizedCues;
  }

  return { sheet, notes };
}

/**
 * Runs an extension planner script in an isolated child process:
 * - Passes a read-only `CutholPlannerSnapshot` (sequence + sequence-projected words + composition-declared events).
 * - Enforces file-write and network security rules (`CUTHOL-G206`).
 * - Validates the returned Cue Sheet patch via `mergeCueSheetIntoSequence` + `verifySequence` (`planCueSheet`).
 * - On `dryRun: true`, returns the plan without mutating the sequence.
 * - On `dryRun: false`, applies the patch in a single atomic revision (`rN -> r(N+1)`) so `undo` reverts all added/updated cues at once.
 */
export function runExtensionPlanner(options: {
  workspaceDir: string;
  extensionName: string;
  plannerName?: string;
  params?: Record<string, unknown>;
  scope?: ExtensionScope;
  dryRun?: boolean;
}): {
  extension: string;
  version: string;
  planner: string;
  kind: "planner";
  undo_policy: "single_atomic_revision";
  params: Record<string, number | string | boolean>;
  snapshot_summary: {
    compositions_count: number;
    declared_events_count: number;
    projected_words_count: number;
  };
  diff: CueSheetDiff;
  would_commit: boolean;
  cues_added: string[];
  cues_updated: string[];
  cues_removed: string[];
  notes?: string[];
  revision: number;
  verification: VerificationReport;
  security_notice: {
    manifest_path: string;
    script_path: string;
    network_declared: boolean;
  };
  dry_run?: boolean;
} {
  const ext = resolveExtension(options.extensionName, options.workspaceDir, options.scope);
  const planners = ext.manifest.planners ?? {};
  const planNames = Object.keys(planners);
  if (planNames.length === 0) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
        ext.name,
        options.plannerName || "planner",
        `'${ext.name}' eklentisinde tanımlı hiçbir planlayıcı ('planners') yok.`
      )
    );
  }

  const planName =
    options.plannerName?.trim() || (planNames.length === 1 ? planNames[0] : "");
  if (!planName || !planners[planName]) {
    throw new CutholError(
      DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
        ext.name,
        planName || "(belirtilmedi)",
        `Planlayıcı bulunamadı. Mevcut planlayıcılar: ${planNames.join(", ")}.`
      )
    );
  }

  const planner = planners[planName];
  const resolvedParams = resolveValidatedParams(
    planner.params,
    options.params,
    ext.name,
    `planner:${planName}`
  );
  const scriptAbsPath = assertStayInsideDir(ext.dir, planner.script, ext.name);
  assertScriptRespectsNetworkPolicy(scriptAbsPath, ext);

  const securityNotice = {
    manifest_path: ext.manifestPath,
    script_path: scriptAbsPath,
    network_declared: ext.network,
  };

  const { paths, sequence: initialSeq } = loadSequence(options.workspaceDir);
  const preSeqRaw = fs.readFileSync(paths.sequenceFile, "utf8");
  const snapshot = buildPlannerSnapshot(initialSeq, paths, ext, resolvedParams);

  const extFilesBefore = new Map(
    listFilesRecursiveRelative(ext.dir).map((f) => [
      f.path,
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(ext.dir, f.path)))
        .digest("hex"),
    ])
  );
  const extHashBefore = hashExtensionDirectory(ext.dir);
  const rootEntriesBefore = new Set(fs.readdirSync(paths.rootDir));

  const isolatedTmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `cuthol-ext-planner-${ext.name}-`)
  );
  const snapshotPath = path.join(isolatedTmpDir, "snapshot.json");
  const patchOutPath = path.join(isolatedTmpDir, "patch.json");

  let rawPatchObj: unknown;
  try {
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
    const nodeProc = spawnSync(
      process.execPath,
      [scriptAbsPath, snapshotPath, patchOutPath, JSON.stringify(resolvedParams)],
      {
        cwd: isolatedTmpDir,
        env: {
          ...process.env,
          CUTHOL_EXT_NAME: ext.name,
          CUTHOL_EXT_VERSION: ext.version,
          CUTHOL_EXT_DIR: ext.dir,
          CUTHOL_EXT_SNAPSHOT: snapshotPath,
          CUTHOL_EXT_OUTPUT: patchOutPath,
          CUTHOL_EXT_PARAMS: JSON.stringify(resolvedParams),
        },
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      }
    );

    // 1. Check extension folder write violation
    const extHashAfter = hashExtensionDirectory(ext.dir);
    if (extHashAfter !== extHashBefore) {
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
          `Planlayıcı betiği eklenti klasörünün içine yazma girişiminde bulundu.`
        )
      );
    }

    // 2. Check workspace folder write violation
    const postSeqRaw = fs.existsSync(paths.sequenceFile)
      ? fs.readFileSync(paths.sequenceFile, "utf8")
      : "";
    const rootEntriesAfter = fs.readdirSync(paths.rootDir);
    const extraRootEntries = rootEntriesAfter.filter((e) => !rootEntriesBefore.has(e));
    if (postSeqRaw !== preSeqRaw || extraRootEntries.length > 0) {
      fs.writeFileSync(paths.sequenceFile, preSeqRaw, "utf8");
      for (const extra of extraRootEntries) {
        try {
          fs.rmSync(path.join(paths.rootDir, extra), { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
          ext.name,
          `Planlayıcı betiği doğrudan çalışma alanı klasörüne ('${extraRootEntries.join(", ") || "cuthol.sequence.json"}') yazma girişiminde bulundu.`
        )
      );
    }

    // 3. Check sandbox extra files violation
    const sandboxEntries = fs.readdirSync(isolatedTmpDir);
    const extraSandbox = sandboxEntries.filter(
      (e) => e !== "snapshot.json" && e !== "patch.json"
    );
    if (extraSandbox.length > 0) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
          ext.name,
          `Planlayıcı betiği Cuthol'un verdiği çıktı yolu dışına ('${extraSandbox.join(", ")}') dosya yazdı.`
        )
      );
    }

    if (nodeProc.status !== 0) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
          ext.name,
          `planner:${planName}`,
          `Planlayıcı betiği çıkış kodu ${nodeProc.status}: ${(nodeProc.stderr || nodeProc.stdout || "").trim()}`
        )
      );
    }

    if (fs.existsSync(patchOutPath)) {
      const patchRaw = fs.readFileSync(patchOutPath, "utf8").trim();
      try {
        rawPatchObj = JSON.parse(patchRaw);
      } catch (err) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            ext.name,
            `planner:${planName}`,
            `Planlayıcı çıktı dosyası geçerli bir JSON değil: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
    } else {
      const stdoutTrimmed = (nodeProc.stdout || "").trim();
      if (!stdoutTrimmed) {
        throw new CutholError(
          DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
            ext.name,
            `planner:${planName}`,
            `Planlayıcı betiği ne çıktı dosyası ('patch.json') üretti ne de stdout üzerinde JSON döndürdü.`
          )
        );
      }
      const lastLine = stdoutTrimmed.split(/\r?\n/).pop()!.trim();
      try {
        rawPatchObj = JSON.parse(lastLine);
      } catch {
        try {
          rawPatchObj = JSON.parse(stdoutTrimmed);
        } catch {
          throw new CutholError(
            DIAGNOSTICS.EXTENSION_EXECUTION_FAILED(
              ext.name,
              `planner:${planName}`,
              `Planlayıcı betiği geçerli bir JSON döndürmedi: '${lastLine.slice(0, 120)}'`
            )
          );
        }
      }
    }
  } finally {
    fs.rmSync(isolatedTmpDir, { recursive: true, force: true });
  }

  const { sheet, notes } = normalizeAndValidatePlannerPatch(rawPatchObj, ext.name, planName);

  // Plan & validate via the Cue Sheet engine first (guarantees zero partial application on invalid patch)
  const { nextSeq: plannedSeq, diff: plannedDiff } = mergeCueSheetIntoSequence(initialSeq, sheet);
  const plannedVer = verifySequence(plannedSeq, paths);

  if (!plannedVer.ok) {
    const firstErr = plannedVer.diagnostics.find((d) => d.severity === "ERROR")!;
    throw new CutholError(firstErr, plannedVer.diagnostics);
  }

  const snapshotSummary = {
    compositions_count: snapshot.compositions.length,
    declared_events_count: snapshot.events.length,
    projected_words_count: snapshot.words.length,
  };

  if (options.dryRun) {
    return {
      extension: ext.name,
      version: ext.version,
      planner: planName,
      kind: "planner",
      undo_policy: "single_atomic_revision",
      params: resolvedParams,
      snapshot_summary: snapshotSummary,
      diff: plannedDiff,
      would_commit: plannedVer.ok,
      cues_added: plannedDiff.cues_added,
      cues_updated: plannedDiff.cues_updated,
      cues_removed: plannedDiff.cues_removed,
      ...(notes.length > 0 ? { notes } : {}),
      revision: initialSeq.meta.revision,
      verification: plannedVer,
      security_notice: securityNotice,
      dry_run: true,
    };
  }

  const hasChanges =
    plannedDiff.stage_changed ||
    plannedDiff.spine_added.length > 0 ||
    plannedDiff.spine_updated.length > 0 ||
    plannedDiff.spine_removed.length > 0 ||
    plannedDiff.cues_added.length > 0 ||
    plannedDiff.cues_updated.length > 0 ||
    plannedDiff.cues_removed.length > 0;

  if (!hasChanges) {
    return {
      extension: ext.name,
      version: ext.version,
      planner: planName,
      kind: "planner",
      undo_policy: "single_atomic_revision",
      params: resolvedParams,
      snapshot_summary: snapshotSummary,
      diff: plannedDiff,
      would_commit: true,
      cues_added: [],
      cues_updated: [],
      cues_removed: [],
      ...(notes.length > 0 ? { notes } : {}),
      revision: initialSeq.meta.revision,
      verification: plannedVer,
      security_notice: securityNotice,
    };
  }

  let appliedDiff: CueSheetDiff = plannedDiff;
  const { revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `extension.run:${ext.name}.${planName}`,
    (seq) => {
      const { nextSeq, diff } = mergeCueSheetIntoSequence(seq, sheet);
      appliedDiff = diff;
      Object.assign(seq, nextSeq);
    }
  );

  return {
    extension: ext.name,
    version: ext.version,
    planner: planName,
    kind: "planner",
    undo_policy: "single_atomic_revision",
    params: resolvedParams,
    snapshot_summary: snapshotSummary,
    diff: appliedDiff,
    would_commit: true,
    cues_added: appliedDiff.cues_added,
    cues_updated: appliedDiff.cues_updated,
    cues_removed: appliedDiff.cues_removed,
    ...(notes.length > 0 ? { notes } : {}),
    revision,
    verification,
    security_notice: securityNotice,
  };
}
