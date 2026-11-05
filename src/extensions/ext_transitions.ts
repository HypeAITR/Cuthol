// Manifest `transitions` section: spine transition kinds an extension registers, used as
// `transition_out.kind = "ext:<extension>/<name>"`.
//
// A transition is declared, never coded: ffmpeg filter / expression templates with `{{placeholder}}`
// substitution. Placeholders are the transition's own `params` plus, per field:
//   chain fields (`outgoing_filter`, `incoming_filter`, `incoming_scale`, local clip time `t`):
//     `t0` (transition start in local seconds), `dur` (duration seconds), `p` (eased progress, [0,1])
//   overlay fields (`incoming_x/y`, `outgoing_x/y`, sequence time `t`):
//     `t0` (start, s), `t1` (end, s), `dur`, `p` (eased progress, [0,1]), `W`/`H` (stage px),
//     `x`/`y` (base overlay exprs)
// `{{p}}` already carries `TransitionSpec.easing` (linear/ease_*; cubic_bezier is rejected with G122).
// Unknown placeholders fail the manifest (G112); bad param values fail the edit/compile (G123).
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type { EffectParamValue } from "../core/schema.js";
import { ExtensionParamDef, validateParamsMap } from "./ext_manifest.js";
import { EFFECT_NAME_RE } from "./ext_fx.js";

export interface ExtensionTransitionSpec {
  description?: string;
  params?: Record<string, ExtensionParamDef>;
  /** Hold the outgoing clip under the incoming one during the transition. Default true (like dissolve/wipe). */
  hold_outgoing?: boolean;
  /** ffmpeg filter template appended to the outgoing clip chain (local clip time `t`). */
  outgoing_filter?: string;
  /** ffmpeg filter template appended to the incoming clip chain (local clip time `t`). */
  incoming_filter?: string;
  /**
   * Centered scale-factor template for the incoming clip (ffmpeg expression in local `t`,
   * e.g. `"0.8+0.2*{{p}}"`). Guarded to the transition window by the compiler (1.0 outside).
   */
  incoming_scale?: string;
  /** Overlay x/y templates for the incoming clip (sequence time `t`). Omitted = base position. */
  incoming_x?: string;
  incoming_y?: string;
  /** Overlay x/y templates for the outgoing clip (sequence time `t`). Omitted = base position. */
  outgoing_x?: string;
  outgoing_y?: string;
}

export const ALLOWED_TRANSITION_KEYS = new Set([
  "description",
  "params",
  "hold_outgoing",
  "outgoing_filter",
  "incoming_filter",
  "incoming_scale",
  "incoming_x",
  "incoming_y",
  "outgoing_x",
  "outgoing_y",
]);

/** Non-param placeholders allowed in chain templates (local clip time). */
const CHAIN_VARS = new Set(["t0", "dur", "p"]);
/** Non-param placeholders allowed in overlay templates (sequence time). */
const OVERLAY_VARS = new Set(["t0", "t1", "dur", "p", "W", "H", "x", "y"]);

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;

function checkTemplatePlaceholders(
  template: string,
  allowedVars: ReadonlySet<string>,
  params: Record<string, ExtensionParamDef>,
  extName: string,
  label: string
): void {
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(template)) !== null) {
    const name = m[1];
    if (allowedVars.has(name) || name in params) continue;
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'${label}' içindeki '{{${name}}}' bilinmiyor (bu alanda geçerli değişkenler: ${[...allowedVars].join(", ")}; parametreler: ${Object.keys(params).join(", ") || "yok"}).`
      )
    );
  }
}

function parseTemplateField(
  obj: Record<string, unknown>,
  key: string,
  trName: string,
  extName: string
): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v.trim()) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'transitions.${trName}.${key}' boş olmayan bir metin olmalıdır.`)
    );
  }
  return v.trim();
}

export function parseManifestTransitionsSection(
  raw: unknown,
  extName: string
): Record<string, ExtensionTransitionSpec> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CutholError(DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'transitions' alanı bir nesne olmalıdır.`));
  }
  const out: Record<string, ExtensionTransitionSpec> = {};
  for (const [trName, rawTr] of Object.entries(raw as Record<string, unknown>)) {
    if (!EFFECT_NAME_RE.test(trName)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'transitions.${trName}' geçersiz ad (küçük harf, [a-z0-9_-]).`)
      );
    }
    if (!rawTr || typeof rawTr !== "object" || Array.isArray(rawTr)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'transitions.${trName}' bir nesne olmalıdır.`)
      );
    }
    const obj = rawTr as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (!ALLOWED_TRANSITION_KEYS.has(k)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            extName,
            `'transitions.${trName}' içinde bilinmeyen alan '${k}' (izin verilenler: ${[...ALLOWED_TRANSITION_KEYS].join(", ")}).`
          )
        );
      }
    }
    if (obj.hold_outgoing !== undefined && typeof obj.hold_outgoing !== "boolean") {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'transitions.${trName}.hold_outgoing' boolean (true/false) olmalıdır.`)
      );
    }
    const params = validateParamsMap(obj.params, extName, `transitions.${trName}`);
    const outgoing_filter = parseTemplateField(obj, "outgoing_filter", trName, extName);
    const incoming_filter = parseTemplateField(obj, "incoming_filter", trName, extName);
    const incoming_scale = parseTemplateField(obj, "incoming_scale", trName, extName);
    const incoming_x = parseTemplateField(obj, "incoming_x", trName, extName);
    const incoming_y = parseTemplateField(obj, "incoming_y", trName, extName);
    const outgoing_x = parseTemplateField(obj, "outgoing_x", trName, extName);
    const outgoing_y = parseTemplateField(obj, "outgoing_y", trName, extName);
    const owner = `transitions.${trName}`;
    if (outgoing_filter) checkTemplatePlaceholders(outgoing_filter, CHAIN_VARS, params, extName, `${owner}.outgoing_filter`);
    if (incoming_filter) checkTemplatePlaceholders(incoming_filter, CHAIN_VARS, params, extName, `${owner}.incoming_filter`);
    if (incoming_scale) checkTemplatePlaceholders(incoming_scale, CHAIN_VARS, params, extName, `${owner}.incoming_scale`);
    if (incoming_x) checkTemplatePlaceholders(incoming_x, OVERLAY_VARS, params, extName, `${owner}.incoming_x`);
    if (incoming_y) checkTemplatePlaceholders(incoming_y, OVERLAY_VARS, params, extName, `${owner}.incoming_y`);
    if (outgoing_x) checkTemplatePlaceholders(outgoing_x, OVERLAY_VARS, params, extName, `${owner}.outgoing_x`);
    if (outgoing_y) checkTemplatePlaceholders(outgoing_y, OVERLAY_VARS, params, extName, `${owner}.outgoing_y`);
    out[trName] = {
      ...(typeof obj.description === "string" ? { description: obj.description } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
      ...(typeof obj.hold_outgoing === "boolean" ? { hold_outgoing: obj.hold_outgoing } : {}),
      ...(outgoing_filter ? { outgoing_filter } : {}),
      ...(incoming_filter ? { incoming_filter } : {}),
      ...(incoming_scale ? { incoming_scale } : {}),
      ...(incoming_x ? { incoming_x } : {}),
      ...(incoming_y ? { incoming_y } : {}),
      ...(outgoing_x ? { outgoing_x } : {}),
      ...(outgoing_y ? { outgoing_y } : {}),
    };
  }
  return out;
}

function paramFailure(kind: string, clipId: string, detail: string): CutholError {
  return new CutholError(DIAGNOSTICS.EXTENSION_TRANSITION_PARAM_INVALID(kind, clipId, detail));
}

/**
 * Validates supplied transition params against the manifest definition and returns the coerced
 * values (defaults filled). Unknown keys, missing required params, type/range/enum violations
 * and non-scalar values all fail with G123. Unlike processors, there is no silent passthrough:
 * a transition with no declared params rejects any supplied param.
 */
export function resolveTransitionParams(
  spec: ExtensionTransitionSpec,
  supplied: Record<string, EffectParamValue> | undefined,
  kind: string,
  clipId: string
): Record<string, EffectParamValue> {
  const defs = spec.params ?? {};
  const raw: Record<string, unknown> = supplied ?? {};
  for (const k of Object.keys(raw)) {
    if (!(k in defs)) {
      const valid = Object.keys(defs);
      throw paramFailure(
        kind,
        clipId,
        `Bilinmeyen parametre '${k}'${valid.length > 0 ? ` (geçerli parametreler: ${valid.join(", ")})` : " (bu geçiş parametre almıyor)"}.`
      );
    }
  }
  const out: Record<string, EffectParamValue> = {};
  for (const [k, def] of Object.entries(defs)) {
    const val = raw[k] !== undefined ? raw[k] : def.default;
    if (val === undefined || val === null) {
      if (def.required) throw paramFailure(kind, clipId, `Zorunlu parametre '${k}' eksik.`);
      continue;
    }
    if (def.type === "number") {
      const n = typeof val === "number" ? val : Number(val);
      if (!Number.isFinite(n)) {
        throw paramFailure(kind, clipId, `'${k}' parametresi sayı olmalıdır (verilen: ${JSON.stringify(val)}).`);
      }
      if (def.min !== undefined && n < def.min) {
        throw paramFailure(kind, clipId, `'${k}' parametresi (${n}) alt sınırın (${def.min}) altında.`);
      }
      if (def.max !== undefined && n > def.max) {
        throw paramFailure(kind, clipId, `'${k}' parametresi (${n}) üst sınırın (${def.max}) üzerinde.`);
      }
      out[k] = n;
    } else if (def.type === "boolean") {
      if (typeof val === "boolean") out[k] = val;
      else if (["true", "1", "yes"].includes(String(val).toLowerCase())) out[k] = true;
      else if (["false", "0", "no"].includes(String(val).toLowerCase())) out[k] = false;
      else throw paramFailure(kind, clipId, `'${k}' parametresi boolean olmalıdır (verilen: ${JSON.stringify(val)}).`);
    } else {
      if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") {
        throw paramFailure(kind, clipId, `'${k}' parametresi metin olmalıdır (verilen: ${JSON.stringify(val)}).`);
      }
      out[k] = String(val);
    }
    if (def.enum && !def.enum.includes(out[k] as string | number)) {
      throw paramFailure(kind, clipId, `'${k}' parametresi şu değerlerden biri olmalıdır: ${def.enum.join(", ")}.`);
    }
  }
  return out;
}

/** ffmpeg-friendly rendering of a validated param value inside a template. */
export function formatTransitionParamValue(value: EffectParamValue): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

/**
 * Substitutes `{{name}}` placeholders: compiler variables first, then validated params.
 * Unknown names and filter-breaking characters in values fail with G123 (never silently).
 */
export function substituteTransitionTemplate(
  template: string,
  vars: Record<string, string>,
  params: Record<string, EffectParamValue>,
  kind: string,
  clipId: string
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_match, name: string) => {
    if (name in vars) return vars[name];
    if (name in params) {
      const rendered = formatTransitionParamValue(params[name]);
      if (/[;&|`$\r\n]/.test(rendered)) {
        throw paramFailure(kind, clipId, `'${name}' parametre değeri süzgeçte kullanılamayacak karakterler içeriyor.`);
      }
      return rendered;
    }
    throw paramFailure(kind, clipId, `Şablondaki '{{${name}}}' için ne değişken ne parametre değeri var.`);
  });
}
