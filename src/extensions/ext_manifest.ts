// Extension manifest types, closed-schema validation and path/network safety checks (split out of manager.ts).
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  AssetKind
} from "../core/schema.js";
import { ExtensionFxSpec, parseManifestFxSection } from "./ext_fx.js";
import { ExtensionTransitionSpec, parseManifestTransitionsSection } from "./ext_transitions.js";

export const EXTENSION_MANIFEST_FILENAME = "cuthol-extension.json";

export const EXTENSION_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

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
  /** ffmpeg only. `copy` (default) keeps audio; `drop` strips it with `-an`. */
  audio?: "copy" | "drop";
  /** Seconds before the child is killed. `0` means no limit. Omitted node processors use 120. */
  timeout_sec?: number;
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
  /** Seconds before the planner child is killed. `0` means no limit. Omitted planners use 120. */
  timeout_sec?: number;
}

export type ExtensionProviderKind = "asr" | "tts" | "media";

export interface ExtensionProviderSpec {
  description?: string;
  /** Relative path to the Node script inside the extension directory (required). */
  script: string;
  /** Static per-extension configuration passed to every provider invocation. */
  config?: Record<string, unknown>;
  /**
   * Environment variable names the provider needs (e.g. `["SOME_API_KEY"]`).
   * Values are read from the process environment or the project `.env` at call time,
   * passed to the provider child process only, and never written anywhere.
   */
  env?: string[];
}

export interface ExtensionProvidersSection {
  asr?: ExtensionProviderSpec;
  tts?: ExtensionProviderSpec;
  media?: ExtensionProviderSpec;
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
  /** Speech and media providers (`asr`, `tts`, `media`) served by this extension. */
  providers?: ExtensionProvidersSection;
  /** Per-clip effects for `spine fx` (extensions/ext_fx.ts). */
  fx?: Record<string, ExtensionFxSpec>;
  /** Spine transition kinds (extensions/ext_transitions.ts). */
  transitions?: Record<string, ExtensionTransitionSpec>;
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
    /** Present only when the extension has a `providers` section. */
    providers?: string[];
    /** Present only when the extension has an `fx` section. */
    fx?: string[];
    /** Present only when the extension has a `transitions` section. */
    transitions?: string[];
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
  "providers",
  "planners",
  "recipes",
  "fx",
  "transitions",
  "guide",
]);

const ALLOWED_PLANNER_KEYS = new Set(["kind", "description", "script", "params", "timeout_sec"]);

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
  "audio",
  "timeout_sec",
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

const ALLOWED_PROVIDER_KINDS = new Set(["asr", "tts", "media"]);

const ALLOWED_PROVIDER_KEYS = new Set(["description", "script", "config", "env"]);

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
        `'${targetPath}' escapes the extension folder ('${absParent}').`
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
          `uses network access ('${pat.label}') without declaring 'network: true' in its manifest.`
        )
      );
    }
  }
}

const ASSET_KINDS: readonly AssetKind[] = ["footage", "audio", "graphic", "voiceover", "composition"];

function parseAssetKind(value: unknown, procName: string, extName: string): AssetKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (ASSET_KINDS as readonly string[]).includes(value)) {
    return value as AssetKind;
  }
  throw new CutholError(
    DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
      extName,
      `'processors.${procName}.asset_kind' is invalid (${JSON.stringify(value)}). Valid kinds: ${ASSET_KINDS.join(", ")}.`
    )
  );
}

function parseProcessorAudio(value: unknown, kind: string, procName: string, extName: string): "copy" | "drop" | undefined {
  if (value === undefined) return undefined;
  if (kind !== "ffmpeg") {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'processors.${procName}.audio' can only be used on 'kind: "ffmpeg"' processors ('copy' or 'drop').`
      )
    );
  }
  if (value !== "copy" && value !== "drop") {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'processors.${procName}.audio' must be 'copy' or 'drop' (got: ${JSON.stringify(value)}).`
      )
    );
  }
  return value;
}

function parseTimeoutSec(value: unknown, owner: string, extName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'${owner}.timeout_sec' must be an integer >= 0 (0 = no limit).`
      )
    );
  }
  return value;
}

export function validateParamsMap(
  rawParams: unknown,
  extLabel: string,
  ownerLabel: string
): Record<string, ExtensionParamDef> {
  if (rawParams === undefined) return {};
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extLabel,
        `'${ownerLabel}.params' must be an object.`
      )
    );
  }
  const out: Record<string, ExtensionParamDef> = {};
  for (const [pName, pVal] of Object.entries(rawParams as Record<string, unknown>)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(pName)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extLabel,
          `'${ownerLabel}.params.${pName}' is an invalid parameter name.`
        )
      );
    }
    if (!pVal || typeof pVal !== "object" || Array.isArray(pVal)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extLabel,
          `'${ownerLabel}.params.${pName}' must be a schema object.`
        )
      );
    }
    const pObj = pVal as Record<string, unknown>;
    for (const k of Object.keys(pObj)) {
      if (!ALLOWED_PARAM_KEYS.has(k)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            extLabel,
            `'${ownerLabel}.params.${pName}' has an unknown field '${k}'.`
          )
        );
      }
    }
    const pType = pObj.type;
    if (pType !== "number" && pType !== "string" && pType !== "boolean") {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extLabel,
          `'${ownerLabel}.params.${pName}.type' must be 'number', 'string', or 'boolean'.`
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
 * Environment variable name validation for `providers.*.env` declarations.
 */

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function parseManifestProvidersSection(
  rawProviders: unknown,
  extName: string
): ExtensionProvidersSection | undefined {
  if (rawProviders === undefined) return undefined;
  if (!rawProviders || typeof rawProviders !== "object" || Array.isArray(rawProviders)) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'providers' must be an object.`)
    );
  }
  const obj = rawProviders as Record<string, unknown>;
  if (Object.keys(obj).length === 0) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'providers' must define at least one of 'asr', 'tts', or 'media'.`
      )
    );
  }
  const out: ExtensionProvidersSection = {};
  for (const [kind, rawSpec] of Object.entries(obj)) {
    if (!ALLOWED_PROVIDER_KINDS.has(kind)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extName,
          `Unknown providers kind '${kind}' (allowed: ${[...ALLOWED_PROVIDER_KINDS].join(", ")}).`
        )
      );
    }
    if (!rawSpec || typeof rawSpec !== "object" || Array.isArray(rawSpec)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'providers.${kind}' must be an object.`)
      );
    }
    const spec = rawSpec as Record<string, unknown>;
    for (const k of Object.keys(spec)) {
      if (!ALLOWED_PROVIDER_KEYS.has(k)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            extName,
            `'providers.${kind}' has an unknown field '${k}' (allowed: ${[...ALLOWED_PROVIDER_KEYS].join(", ")}).`
          )
        );
      }
    }
    const script = typeof spec.script === "string" ? spec.script.trim() : "";
    if (!isSafeRelativeSubpath(script) || !/\.(c|m)?js$/i.test(script)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extName,
          `'providers.${kind}.script' must be a relative '.js' file inside the extension folder.`
        )
      );
    }
    let config: Record<string, unknown> | undefined;
    if (spec.config !== undefined) {
      if (!spec.config || typeof spec.config !== "object" || Array.isArray(spec.config)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            extName,
            `'providers.${kind}.config' must be an object.`
          )
        );
      }
      config = spec.config as Record<string, unknown>;
    }
    let env: string[] | undefined;
    if (spec.env !== undefined) {
      if (!Array.isArray(spec.env)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            extName,
            `'providers.${kind}.env' must be an array of environment variable names (e.g. ["SOME_API_KEY"]).`
          )
        );
      }
      env = [];
      for (let i = 0; i < spec.env.length; i++) {
        const v = spec.env[i];
        if (typeof v !== "string" || !ENV_VAR_NAME_RE.test(v.trim())) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              extName,
              `'providers.${kind}.env[${i}]' is not a valid environment variable name (${JSON.stringify(v)}).`
            )
          );
        }
        env.push(v.trim());
      }
    }
    (out as Record<string, ExtensionProviderSpec>)[kind] = {
      ...(typeof spec.description === "string" ? { description: spec.description } : {}),
      script,
      ...(config !== undefined ? { config } : {}),
      ...(env !== undefined ? { env } : {}),
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
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(label, "The manifest root value must be a JSON object.")
    );
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_MANIFEST_KEYS.has(key)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          label,
          `Unknown manifest field '${key}' (allowed: ${[...ALLOWED_MANIFEST_KEYS].join(", ")}).`
        )
      );
    }
  }

  if (typeof obj.name !== "string" || !EXTENSION_NAME_RE.test(obj.name.trim())) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        label,
        `'name' is required and must match '${EXTENSION_NAME_RE.source}' (lowercase, digits, '-' or '_').`
      )
    );
  }
  const name = obj.name.trim();
  if (expectedFolderName && name !== expectedFolderName) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        label,
        `Manifest 'name' ('${name}') does not match the extension folder name ('${expectedFolderName}').`
      )
    );
  }

  if (typeof obj.version !== "string" || !obj.version.trim()) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'version' must be a non-empty string (e.g. "1.0.0").`)
    );
  }

  if (typeof obj.description !== "string" || !obj.description.trim()) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'description' must be a non-empty description string.`)
    );
  }

  if (obj.network !== undefined && typeof obj.network !== "boolean") {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'network' must be a boolean (true/false).`)
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
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'helper' has unknown fields: ${extraKeys.join(", ")}.`)
        );
      }
      entry = typeof hObj.entry === "string" ? hObj.entry.trim() : "";
      helperSpec = { entry };
    } else {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'helper' must be a JS file path or '{ "entry": "helper.js" }'.`)
      );
    }
    if (!isSafeRelativeSubpath(entry) || !entry.endsWith(".js")) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          name,
          `'helper' file path ('${entry}') must be a relative '.js' file inside the extension.`
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
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'assets' has unknown fields: ${extraKeys.join(", ")}.`)
        );
      }
      dir = typeof aObj.dir === "string" ? aObj.dir.trim() : "";
      assetsSpec = { dir };
    } else {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'assets' must be a relative folder name (e.g. "assets").`)
      );
    }
    if (!isSafeRelativeSubpath(dir)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          name,
          `'assets' folder path ('${dir}') must be a safe relative path inside the extension.`
        )
      );
    }
  }

  let processorsSpec: Record<string, ExtensionProcessorSpec> | undefined;
  if (obj.processors !== undefined) {
    if (!obj.processors || typeof obj.processors !== "object" || Array.isArray(obj.processors)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'processors' must be an object.`)
      );
    }
    processorsSpec = {};
    for (const [procName, rawProc] of Object.entries(obj.processors as Record<string, unknown>)) {
      if (!EXTENSION_NAME_RE.test(procName)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `Invalid processor name '${procName}'.`)
        );
      }
      if (!rawProc || typeof rawProc !== "object" || Array.isArray(rawProc)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'processors.${procName}' must be an object.`)
        );
      }
      const pObj = rawProc as Record<string, unknown>;
      for (const k of Object.keys(pObj)) {
        if (!ALLOWED_PROCESSOR_KEYS.has(k)) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              name,
              `'processors.${procName}' has an unknown field '${k}' (allowed: ${[...ALLOWED_PROCESSOR_KEYS].join(", ")}).`
            )
          );
        }
      }
      if (pObj.kind !== "ffmpeg" && pObj.kind !== "node") {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            name,
            `'processors.${procName}.kind' must be 'ffmpeg' or 'node'.`
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
              `'processors.${procName}' (kind=ffmpeg) needs at least one of 'filter', 'audio_filter', 'video_filter', or 'ffmpeg_args'.`
            )
          );
        }
      } else {
        const script = typeof pObj.script === "string" ? pObj.script.trim() : "";
        if (!isSafeRelativeSubpath(script) || !/\.(c|m)?js$/i.test(script)) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              name,
              `'processors.${procName}.script' must be a relative '.js' file inside the extension folder.`
            )
          );
        }
      }
      const assetKind = parseAssetKind(pObj.asset_kind, procName, name);
      const audioMode = parseProcessorAudio(pObj.audio, pObj.kind, procName, name);
      const timeoutSec = parseTimeoutSec(pObj.timeout_sec, `processors.${procName}`, name);
      processorsSpec[procName] = {
        kind: pObj.kind,
        ...(typeof pObj.description === "string" ? { description: pObj.description } : {}),
        ...(typeof pObj.output_ext === "string" ? { output_ext: pObj.output_ext } : {}),
        ...(assetKind !== undefined ? { asset_kind: assetKind } : {}),
        ...(Object.keys(params).length > 0 ? { params } : {}),
        ...(typeof pObj.filter === "string" ? { filter: pObj.filter.trim() } : {}),
        ...(typeof pObj.audio_filter === "string" ? { audio_filter: pObj.audio_filter.trim() } : {}),
        ...(typeof pObj.video_filter === "string" ? { video_filter: pObj.video_filter.trim() } : {}),
        ...(Array.isArray(pObj.ffmpeg_args)
          ? { ffmpeg_args: pObj.ffmpeg_args.map((x) => String(x)) }
          : {}),
        ...(audioMode !== undefined ? { audio: audioMode } : {}),
        ...(timeoutSec !== undefined ? { timeout_sec: timeoutSec } : {}),
        ...(typeof pObj.script === "string" ? { script: pObj.script.trim() } : {}),
      };
    }
  }

  let plannersSpec: Record<string, ExtensionPlannerSpec> | undefined;
  if (obj.planners !== undefined) {
    if (!obj.planners || typeof obj.planners !== "object" || Array.isArray(obj.planners)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'planners' must be an object.`)
      );
    }
    plannersSpec = {};
    for (const [planName, rawPlan] of Object.entries(obj.planners as Record<string, unknown>)) {
      if (!EXTENSION_NAME_RE.test(planName)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `Invalid planner name '${planName}'.`)
        );
      }
      if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'planners.${planName}' must be an object.`)
        );
      }
      const plObj = rawPlan as Record<string, unknown>;
      for (const k of Object.keys(plObj)) {
        if (!ALLOWED_PLANNER_KEYS.has(k)) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              name,
              `'planners.${planName}' has an unknown field '${k}' (allowed: ${[...ALLOWED_PLANNER_KEYS].join(", ")}).`
            )
          );
        }
      }
      if (plObj.kind !== undefined && plObj.kind !== "node" && plObj.kind !== "planner") {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            name,
            `'planners.${planName}.kind' must be 'node' or 'planner'.`
          )
        );
      }
      const script = typeof plObj.script === "string" ? plObj.script.trim() : "";
      if (!isSafeRelativeSubpath(script) || !/\.(c|m)?js$/i.test(script)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            name,
            `'planners.${planName}.script' must be a relative '.js' file inside the extension folder.`
          )
        );
      }
      const params = validateParamsMap(plObj.params, name, `planners.${planName}`);
      const timeoutSec = parseTimeoutSec(plObj.timeout_sec, `planners.${planName}`, name);
      plannersSpec[planName] = {
        ...(typeof plObj.kind === "string" ? { kind: plObj.kind as "node" | "planner" } : {}),
        ...(typeof plObj.description === "string" ? { description: plObj.description } : {}),
        script,
        ...(Object.keys(params).length > 0 ? { params } : {}),
        ...(timeoutSec !== undefined ? { timeout_sec: timeoutSec } : {}),
      };
    }
  }

  let recipesSpec: Record<string, ExtensionRecipeSpec> | undefined;
  if (obj.recipes !== undefined) {
    if (!obj.recipes || typeof obj.recipes !== "object" || Array.isArray(obj.recipes)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'recipes' must be an object.`)
      );
    }
    recipesSpec = {};
    for (const [recName, rawRec] of Object.entries(obj.recipes as Record<string, unknown>)) {
      if (!EXTENSION_NAME_RE.test(recName)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `Invalid recipe name '${recName}'.`)
        );
      }
      if (!rawRec || typeof rawRec !== "object" || Array.isArray(rawRec)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(name, `'recipes.${recName}' must be an object.`)
        );
      }
      const rObj = rawRec as Record<string, unknown>;
      for (const k of Object.keys(rObj)) {
        if (!ALLOWED_RECIPE_KEYS.has(k)) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              name,
              `'recipes.${recName}' has an unknown field '${k}'.`
            )
          );
        }
      }
      if (!Array.isArray(rObj.steps) || rObj.steps.length === 0) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            name,
            `'recipes.${recName}.steps' must be a non-empty step array.`
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
              `'recipes.${recName}.steps[${i}]' must be an object.`
            )
          );
        }
        const sObj = rawStep as Record<string, unknown>;
        for (const k of Object.keys(sObj)) {
          if (!ALLOWED_STEP_KEYS.has(k)) {
            throw new CutholError(
              DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
                name,
                `'recipes.${recName}.steps[${i}]' has an unknown field '${k}'.`
              )
            );
          }
        }
        if (typeof sObj.tool !== "string" || !sObj.tool.trim()) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              name,
              `'recipes.${recName}.steps[${i}].tool' is required.`
            )
          );
        }
        if (sObj.args !== undefined && (!sObj.args || typeof sObj.args !== "object" || Array.isArray(sObj.args))) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
              name,
              `'recipes.${recName}.steps[${i}].args' must be an object.`
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

  const providersSpec = parseManifestProvidersSection(obj.providers, name);

  const fxSpec = parseManifestFxSection(obj.fx, name);
  const transitionsSpec = parseManifestTransitionsSection(obj.transitions, name);

  let guideSpec: string | undefined;
  if (obj.guide !== undefined) {
    if (typeof obj.guide !== "string" || !isSafeRelativeSubpath(obj.guide.trim())) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          name,
          `'guide' must be a relative file path inside the extension folder (e.g. "README.md").`
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
    ...(providersSpec !== undefined ? { providers: providersSpec } : {}),
    ...(fxSpec !== undefined ? { fx: fxSpec } : {}),
    ...(transitionsSpec !== undefined ? { transitions: transitionsSpec } : {}),
    ...(guideSpec !== undefined ? { guide: guideSpec } : {}),
  };
}
