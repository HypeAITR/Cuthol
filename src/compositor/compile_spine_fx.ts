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
 * Validates a built-in (`kind: "ffmpeg"`) raw chain. Returns the Turkish G118 detail, or null when valid.
 * Shared by the compiler and the verify gate so both always agree.
 */
export function checkBuiltinFxFilterChain(chain: unknown): string | null {
  if (typeof chain !== "string" || !chain.trim()) {
    return `'filter' boş olmayan bir süzgeç zinciri olmalıdır (ör. "gblur=sigma=3").`;
  }
  const trimmed = chain.trim();
  const badChar = trimmed.match(/[[;\]]/);
  if (badChar) {
    return `zincir grafik ayırıcısı ('${badChar[0]}') içeremez (tek zincirde derlenir).`;
  }
  if (/[\r\n\x00]/.test(trimmed)) {
    return `zincir satır sonu içeremez.`;
  }
  for (const seg of splitTopLevel(trimmed, ",")) {
    const name = fxSegmentFilterName(seg);
    if (!name) {
      return `çözümlenemeyen süzgeç parçası ('${seg.trim().slice(0, 40)}').`;
    }
    if (BANNED_BUILTIN_FX_FILTERS.has(name)) {
      return `'${name}' süzgeci ham zincirde yasak (dosya okur ya da dış komut/uzaktan denetim açar).`;
    }
    for (const key of fxSegmentOptionKeys(seg)) {
      if (FILE_READING_FX_OPTIONS.has(key)) {
        return `'${name}' süzgecinde '${key}=' dosya okur; dosya kullanan efektler eklentide tanımlanmalıdır.`;
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
        throw fail(`bilinmeyen parametre '${k}' (geçerli parametreler: ${names.join(", ")}).`);
      }
    }
  }
  for (const [k, def] of Object.entries(schema)) {
    const val: unknown = raw[k] !== undefined ? raw[k] : def.default;
    if (val === undefined || val === null) {
      if (def.required) {
        throw fail(`zorunlu parametre '${k}' eksik.`);
      }
      continue;
    }
    if (def.type === "number") {
      const n =
        typeof val === "number" ? val : typeof val === "string" && val.trim() !== "" ? Number(val) : NaN;
      if (!Number.isFinite(n)) {
        throw fail(`'${k}' parametresi sayı olmalıdır (verilen: ${JSON.stringify(val)}).`);
      }
      if (def.min !== undefined && n < def.min) {
        throw fail(`'${k}' parametresi (${n}) alt sınırın (${def.min}) altında.`);
      }
      if (def.max !== undefined && n > def.max) {
        throw fail(`'${k}' parametresi (${n}) üst sınırın (${def.max}) üzerinde.`);
      }
      out[k] = n;
    } else if (def.type === "boolean") {
      if (typeof val === "boolean") {
        out[k] = val;
      } else if (typeof val === "string") {
        const t = val.trim().toLowerCase();
        if (t === "true" || t === "1") out[k] = true;
        else if (t === "false" || t === "0") out[k] = false;
        else throw fail(`'${k}' parametresi true/false olmalıdır (verilen: ${JSON.stringify(val)}).`);
      } else {
        throw fail(`'${k}' parametresi true/false olmalıdır (verilen: ${JSON.stringify(val)}).`);
      }
    } else {
      if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") {
        throw fail(`'${k}' parametresi metin olmalıdır (verilen: ${JSON.stringify(val)}).`);
      }
      out[k] = typeof val === "string" ? val : String(val);
    }
    if (def.enum && !def.enum.includes(out[k] as string | number)) {
      throw fail(`'${k}' parametresi şu değerlerden biri olmalıdır: ${def.enum.join(", ")}.`);
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
      throw fail(`'${name}' parametresi için değer yok (varsayılan tanımlayın ya da '--param ${name}=<değer>' ile verin).`);
    }
    const formatted = formatFxParamValue(values[name]);
    if (formatted === null) {
      throw fail(`'${name}' parametre değeri süzgece yazılamıyor (denetim karakteri içeriyor).`);
    }
    return formatted;
  });
  if (out.includes("{{") || out.includes("}}")) {
    throw fail(`şablon çözümlenemeyen yer tutucu içeriyor ('${out.slice(0, 80)}').`);
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
      `bilinmeyen tür '${kind}' (yerleşik tür yalnız 'ffmpeg'; eklenti türleri 'ext:<eklenti>/<ad>' biçimindedir).`
    );
  }
  if (!rootDir) {
    throw fail(`'${kind}' efekt kaydı proje dizini olmadan çözümlenemedi.`);
  }
  const reg = getSequenceEffectRegistry(seq, rootDir);
  const found = reg.fx.get(kind);
  if (found) return found;
  const ref = parseExtensionEffectRef(kind) ?? { extension: kind, name: kind };
  const loadErr = reg.load_errors.get(ref.extension);
  if (loadErr !== undefined) {
    throw fail(
      `'${ref.extension}' eklentisi yüklenemedi: ${loadErr}`,
      `'cuthol extension show --name ${ref.extension}' ile manifesti denetleyin.`
    );
  }
  const enabled = (seq.extensions ?? []).some((e) => e.name === ref.extension);
  if (!enabled) {
    throw fail(
      `'${ref.extension}' eklentisi bu projede etkin değil.`,
      `'cuthol extension enable --name ${ref.extension}' ile etkinleştirin ya da efekti kaldırın.`
    );
  }
  throw fail(
    `'${ref.extension}' eklentisinde '${ref.name}' adında bir efekt yok.`,
    `'cuthol extension show --name ${ref.extension}' ile mevcut efektleri görün.`
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
          `yerleşik 'ffmpeg' zincirinin parametreleri zarflanamaz (zincir tek metindir).`
        );
      }
      const supplied: Record<string, unknown> = (fx.params ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(supplied)) {
        if (k !== "filter") {
          throw fail(`bilinmeyen parametre '${k}' (yerleşik tür yalnız 'filter' alır).`);
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
        throw envFail(`fx.${fx.id}.${param}`, `'${fx.kind}' efektinde '${param}' adında bir parametre yok.`);
      }
      if (!animatable.has(param)) {
        throw envFail(
          `fx.${fx.id}.${param}`,
          `'${param}' zarflanabilir değil (eklenti 'animatable' listesinde bildirmemiş).`
        );
      }
      const expr = compileEnvelopeToFfmpegExpr({ envelope: env, timeBaseOffsetMs: 0, mode: "raw" });
      if (expr === null) continue; // noktasız zarf: animasyon yok, durağan değer kullanılır
      animated.set(param, `'${expr}'`);
    }
    out.push(substituteFxTemplate(def.spec.video_filter, values, animated, fail));
  }
  for (const [fxId, inner] of byFx) {
    if (seenIds.has(fxId) || disabledIds.has(fxId)) continue; // kapalı efektin zarfı uykudadır, G119 değil
    const first = [...inner.keys()][0];
    throw new CutholError(
      DIAGNOSTICS.SPINE_FX_ENVELOPE_UNSUPPORTED(clip.id, `fx.${fxId}.${first}`, `'${fxId}' kimlikli bir efekt bu klipte yok.`)
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
