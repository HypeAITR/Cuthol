// Spine clip stage 4 — per-clip effect chain (`clip.fx`, `spine fx`).
// Runs after the colour stage and before cutout / RGBA conversion / rotation / opacity /
// edge / scale-pan. The source asset is never replaced, so transcript bindings (words → clip) stay intact.
// Only two kinds exist: the built-in raw chain (`kind: "ffmpeg"`, `params.filter`) and extension effects
// (`kind: "ext:<extension>/<name>"`, template + params from the manifest `fx` section). Anything else is G118,
// envelopes on non-animatable params are G119. An enabled fx is never dropped silently.
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type { ClipFxSpec, CutholSequence, EffectParamValue, ParameterEnvelope } from "../core/schema.js";
import type { resolveSourceColorSpec } from "../library/probe.js";
import type { VideoGraphCompileContext } from "./compiler.js";
import { compileEnvelopeToFfmpegExpr } from "./compile_filters.js";
import type { ExtensionParamDef } from "../extensions/ext_manifest.js";
import {
  getSequenceEffectRegistry,
  isExtensionEffectRef,
  parseExtensionEffectRef,
} from "../extensions/ext_effects.js";
import type { ResolvedEffectDef } from "../extensions/ext_effects.js";
import type { ExtensionFxSpec } from "../extensions/ext_fx.js";

type SpineClipSpec = CutholSequence["spine"]["clips"][number];

/** The only built-in fx kind (effects themselves live in extensions, so no other built-in is added). */
export const BUILTIN_FX_KIND = "ffmpeg";

/**
 * Filters rejected inside a built-in (`kind: "ffmpeg"`) chain, with rationale:
 * - `movie` / `amovie` read arbitrary files or URLs as new graph inputs. The fx stage compiles into one
 *   hermetic chain fed by the clip's own input; an outside source breaks that assumption and turns a sequence
 *   field into a file/URL read primitive.
 * - `sendcmd` executes filter commands from a file at render time (a second program hidden in data).
 * - `zmq` / `azmq` open network sockets for live remote control of the filter graph.
 */
const BANNED_BUILTIN_FX_FILTERS = new Set(["movie", "amovie", "sendcmd", "zmq", "azmq"]);

/**
 * Filter options that read external files (e.g. `lut3d=file=...`, `subtitles=filename=...`). Rejecting the
 * option key keeps file-backed effects where they belong: in extensions (sandboxed, hash-pinned), never in a
 * raw user chain. Residual: positional filename args (`subtitles=/x`) are not detected; document, don't chase.
 */
const FILE_READING_FX_OPTIONS = new Set(["file", "filename", "path"]);

/** Split on a separator, ignoring separators inside single quotes and parens. Brackets are rejected earlier. */
function splitTopLevel(text: string, sep: "," | ":"): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && i + 1 < text.length) {
        cur += text[i + 1];
        i++;
      } else if (ch === "'") {
        quote = false;
      }
      continue;
    }
    if (ch === "'") {
      quote = true;
      cur += ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Filter name is the leading identifier of a segment (`scale=w=..` → `scale`). */
function fxSegmentFilterName(segment: string): string {
  const m = /^\s*([A-Za-z][A-Za-z0-9_]*)/.exec(segment);
  return m ? m[1].toLowerCase() : "";
}

/** Option keys of one filter segment (`key=value` pieces of the args after the first `=`). */
function fxSegmentOptionKeys(segment: string): string[] {
  const eq = segment.indexOf("=");
  if (eq === -1) return [];
  const keys: string[] = [];
  for (const piece of splitTopLevel(segment.slice(eq + 1), ":")) {
    const keyEq = piece.indexOf("=");
    if (keyEq === -1) continue;
    keys.push(piece.slice(0, keyEq).trim().toLowerCase());
  }
  return keys;
}

/**
 * Validates a built-in (`kind: "ffmpeg"`) raw chain. Returns the English G118 detail, or null when valid.
 * Shared by the compiler and the verify gate so both always agree.
 */
export function checkBuiltinFxFilterChain(chain: unknown): string | null {
  if (typeof chain !== "string" || !chain.trim()) {
    return `'filter' must be a non-empty filter chain (e.g. "gblur=sigma=3").`;
  }
  const trimmed = chain.trim();
  const badChar = trimmed.match(/[[;\]]/);
  if (badChar) {
    return `chain must not contain the graph separator ('${badChar[0]}') (compiled as a single chain).`;
  }
  if (/[\r\n\x00]/.test(trimmed)) {
    return `chain must not contain line breaks.`;
  }
  for (const seg of splitTopLevel(trimmed, ",")) {
    const name = fxSegmentFilterName(seg);
    if (!name) {
      return `unresolvable filter segment ('${seg.trim().slice(0, 40)}').`;
    }
    if (BANNED_BUILTIN_FX_FILTERS.has(name)) {
      return `'${name}' filter is forbidden in a raw chain (it reads files or opens external commands/remote control).`;
    }
    for (const key of fxSegmentOptionKeys(seg)) {
      if (FILE_READING_FX_OPTIONS.has(key)) {
        return `'${key}=' in the '${name}' filter reads a file; effects using files must be defined in an extension.`;
      }
    }
  }
  return null;
}

/**
 * Validates supplied fx params against the manifest `ExtensionParamDef` map (type, min/max, enum, required,
 * default). Every failure throws through `fail` so callers attach their own G118 context.
 */
export function resolveFxParams(
  defs: Record<string, ExtensionParamDef> | undefined,
  supplied: Record<string, EffectParamValue> | undefined,
  fail: (detail: string) => CutholError
): Record<string, EffectParamValue> {
  const schema = defs ?? {};
  const raw: Record<string, unknown> = supplied ?? {};
  const out: Record<string, EffectParamValue> = {};
  const names = Object.keys(schema);
  if (names.length > 0) {
    for (const k of Object.keys(raw)) {
      if (!(k in schema)) {
        throw fail(`unknown parameter '${k}' (valid parameters: ${names.join(", ")}).`);
      }
    }
  }
  for (const [k, def] of Object.entries(schema)) {
    const val: unknown = raw[k] !== undefined ? raw[k] : def.default;
    if (val === undefined || val === null) {
      if (def.required) {
        throw fail(`required parameter '${k}' is missing.`);
      }
      continue;
    }
    if (def.type === "number") {
      const n =
        typeof val === "number" ? val : typeof val === "string" && val.trim() !== "" ? Number(val) : NaN;
      if (!Number.isFinite(n)) {
        throw fail(`'${k}' must be a number (given: ${JSON.stringify(val)}).`);
      }
      if (def.min !== undefined && n < def.min) {
        throw fail(`'${k}' (${n}) is below the minimum (${def.min}).`);
      }
      if (def.max !== undefined && n > def.max) {
        throw fail(`'${k}' (${n}) is above the maximum (${def.max}).`);
      }
      out[k] = n;
    } else if (def.type === "boolean") {
      if (typeof val === "boolean") {
        out[k] = val;
      } else if (typeof val === "string") {
        const t = val.trim().toLowerCase();
        if (t === "true" || t === "1") out[k] = true;
        else if (t === "false" || t === "0") out[k] = false;
        else throw fail(`'${k}' must be true/false (given: ${JSON.stringify(val)}).`);
      } else {
        throw fail(`'${k}' must be true/false (given: ${JSON.stringify(val)}).`);
      }
    } else {
      if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") {
        throw fail(`'${k}' must be text (given: ${JSON.stringify(val)}).`);
      }
      out[k] = typeof val === "string" ? val : String(val);
    }
    if (def.enum && !def.enum.includes(out[k] as string | number)) {
      throw fail(`'${k}' must be one of: ${def.enum.join(", ")}.`);
    }
  }
  if (names.length === 0) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
        out[k] = v;
      }
    }
  }
  return out;
}

/** Formats a static param value for ffmpeg filtergraph syntax. Null = unserializable (control chars). */
export function formatFxParamValue(value: EffectParamValue): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) return null;
  return value.replace(/[\\':,[\];]/g, (ch) => `\\${ch}`);
}

const FX_TEMPLATE_PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;

/** Substitutes `{{param}}` with animated expressions (already quoted) or escaped static values. */
function substituteFxTemplate(
  template: string,
  values: Record<string, EffectParamValue>,
  animated: Map<string, string>,
  fail: (detail: string) => CutholError
): string {
  const out = template.replace(FX_TEMPLATE_PLACEHOLDER_RE, (_m, name: string) => {
    const expr = animated.get(name);
    if (expr !== undefined) return expr;
    if (!(name in values)) {
      throw fail(`no value for the '${name}' parameter (define a default or pass '--param ${name}=<value>').`);
    }
    const formatted = formatFxParamValue(values[name]);
    if (formatted === null) {
      throw fail(`'${name}' parameter value cannot be written into the filter (it contains a control character).`);
    }
    return formatted;
  });
  if (out.includes("{{") || out.includes("}}")) {
    throw fail(`template contains an unresolvable placeholder ('${out.slice(0, 80)}').`);
  }
  return out;
}

const FX_ENVELOPE_RE = /^fx\.([^.]+)\.([^.]+)$/;

/** Groups `fx.<id>.<param>` envelopes by fx id. Fx ids and param names never contain dots. */
function collectFxEnvelopes(clip: SpineClipSpec): Map<string, Map<string, ParameterEnvelope>> {
  const byFx = new Map<string, Map<string, ParameterEnvelope>>();
  for (const env of clip.envelopes) {
    const m = FX_ENVELOPE_RE.exec(env.parameter);
    if (!m) continue;
    let inner = byFx.get(m[1]);
    if (!inner) {
      inner = new Map();
      byFx.set(m[1], inner);
    }
    inner.set(m[2], env);
  }
  return byFx;
}

/** Resolves an `ext:<extension>/<name>` kind through the sequence effect registry, or throws G118. */
function lookupExtensionFx(
  kind: string,
  seq: CutholSequence,
  rootDir: string | undefined,
  fail: (detail: string, suggestion?: string) => CutholError
): ResolvedEffectDef<ExtensionFxSpec> {
  if (!isExtensionEffectRef(kind)) {
    throw fail(
      `unknown kind '${kind}' (the only built-in kind is 'ffmpeg'; extension kinds are in 'ext:<extension>/<name>' form).`
    );
  }
  if (!rootDir) {
    throw fail(`effect record '${kind}' could not be resolved without a project directory.`);
  }
  const reg = getSequenceEffectRegistry(seq, rootDir);
  const found = reg.fx.get(kind);
  if (found) return found;
  const ref = parseExtensionEffectRef(kind) ?? { extension: kind, name: kind };
  const loadErr = reg.load_errors.get(ref.extension);
  if (loadErr !== undefined) {
    throw fail(
      `extension '${ref.extension}' failed to load: ${loadErr}`,
      `check the manifest with 'cuthol extension show --name ${ref.extension}'.`
    );
  }
  const enabled = (seq.extensions ?? []).some((e) => e.name === ref.extension);
  if (!enabled) {
    throw fail(
      `extension '${ref.extension}' is not enabled in this project.`,
      `enable it with 'cuthol extension enable --name ${ref.extension}' or remove the effect.`
    );
  }
  throw fail(
    `extension '${ref.extension}' has no effect named '${ref.name}'.`,
    `list the available effects with 'cuthol extension show --name ${ref.extension}'.`
  );
}

export function buildSpineClipFxFilters(
  ctx: VideoGraphCompileContext,
  params: {
    clip: SpineClipSpec;
    asset: CutholSequence["library"][number];
    absAssetPath: string;
    clipColorSpec: ReturnType<typeof resolveSourceColorSpec>;
    /** Output size of the clip chain at this point (after fit/scale), pixels. */
    targetW: number;
    targetH: number;
  }
): string[] {
  const { clip } = params;
  const all = clip.fx ?? [];
  const active = all.filter((f) => f.enabled !== false);
  if (active.length === 0) return [];
  void params.asset;
  void params.absAssetPath;
  void params.clipColorSpec;
  void params.targetW;
  void params.targetH;
  const seq = ctx.seq;
  const rootDir = ctx.paths?.rootDir as string | undefined;
  const byFx = collectFxEnvelopes(clip);
  const seenIds = new Set(active.map((f) => f.id));
  const disabledIds = new Set(all.filter((f) => f.enabled === false).map((f) => f.id));
  const out: string[] = [];
  for (const fx of active) {
    const fail = (detail: string, suggestion?: string) =>
      new CutholError(DIAGNOSTICS.SPINE_FX_INVALID(clip.id, fx.id, fx.kind, detail, suggestion));
    const envFail = (parameter: string, reason: string) =>
      new CutholError(DIAGNOSTICS.SPINE_FX_ENVELOPE_UNSUPPORTED(clip.id, parameter, reason));
    const ownEnvelopes = byFx.get(fx.id) ?? new Map<string, ParameterEnvelope>();
    if (fx.kind === BUILTIN_FX_KIND) {
      if (ownEnvelopes.size > 0) {
        const first = [...ownEnvelopes.keys()][0];
        throw envFail(
          `fx.${fx.id}.${first}`,
          `parameters of the built-in 'ffmpeg' chain cannot be enveloped (the chain is a single text).`
        );
      }
      const supplied: Record<string, unknown> = (fx.params ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(supplied)) {
        if (k !== "filter") {
          throw fail(`unknown parameter '${k}' (the built-in kind only takes 'filter').`);
        }
      }
      const problem = checkBuiltinFxFilterChain(supplied.filter);
      if (problem) throw fail(problem);
      out.push((supplied.filter as string).trim());
      continue;
    }
    const def = lookupExtensionFx(fx.kind, seq, rootDir, fail);
    const values = resolveFxParams(def.spec.params, fx.params as Record<string, EffectParamValue>, fail);
    const animatable = new Set(def.spec.animatable ?? []);
    const animated = new Map<string, string>();
    for (const [param, env] of ownEnvelopes) {
      const declared = (def.spec.params ?? {})[param];
      if (!declared) {
        throw envFail(`fx.${fx.id}.${param}`, `effect '${fx.kind}' has no parameter named '${param}'.`);
      }
      if (!animatable.has(param)) {
        throw envFail(
          `fx.${fx.id}.${param}`,
          `'${param}' is not envelopable (the extension did not declare it in the 'animatable' list).`
        );
      }
      const expr = compileEnvelopeToFfmpegExpr({ envelope: env, timeBaseOffsetMs: 0, mode: "raw" });
      if (expr === null) continue; // point-less envelope: no animation, the static value is used
      animated.set(param, `'${expr}'`);
    }
    out.push(substituteFxTemplate(def.spec.video_filter, values, animated, fail));
  }
  for (const [fxId, inner] of byFx) {
    if (seenIds.has(fxId) || disabledIds.has(fxId)) continue; // a disabled effect's envelope is dormant, not G119
    const first = [...inner.keys()][0];
    throw new CutholError(
      DIAGNOSTICS.SPINE_FX_ENVELOPE_UNSUPPORTED(clip.id, `fx.${fxId}.${first}`, `no effect with id '${fxId}' exists on this clip.`)
    );
  }
  return out;
}

/** True when the clip carries anything the fx gate must look at (entries or fx envelopes). */
export function spineClipNeedsFxCheck(clip: SpineClipSpec): boolean {
  return (
    (clip.fx ?? []).length > 0 || clip.envelopes.some((e) => e.parameter.startsWith("fx."))
  );
}
