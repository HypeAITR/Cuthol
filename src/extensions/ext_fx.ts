// Manifest `fx` section: per-clip effects an extension contributes to `spine fx`.
// Each entry is `{ description?, params?, video_filter, animatable? }`; `video_filter` is
// an ffmpeg video filter template with `{{param}}` placeholders, applied on the clip in the render graph
// (compositor/compile_spine_fx.ts). The gate may add keys to ALLOWED_FX_KEYS (closed schema: unknown keys fail).
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { ExtensionParamDef, validateParamsMap } from "./ext_manifest.js";

export interface ExtensionFxSpec {
  description?: string;
  params?: Record<string, ExtensionParamDef>;
  /** ffmpeg video filter template, e.g. `"gblur=sigma={{sigma}}"`. */
  video_filter: string;
  /**
   * Names of number params whose filter option accepts a per-frame expression, so an envelope
   * `fx.<id>.<param>` may animate them. Any other envelope on this effect is G119 (never silent).
   */
  animatable?: string[];
}

export const ALLOWED_FX_KEYS = new Set(["description", "params", "video_filter", "animatable"]);

export const EFFECT_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

const FX_PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;

/** Names in `animatable` must be declared number params (envelopes carry numbers). */
function parseFxAnimatable(
  raw: unknown,
  params: Record<string, ExtensionParamDef>,
  extName: string,
  fxName: string
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}.animatable' bir metin dizisi olmalıdır (zarflanabilir parametre adları).`
      )
    );
  }
  const seen = new Set<string>();
  for (const name of raw) {
    if (seen.has(name)) continue;
    seen.add(name);
    const def = params[name];
    if (!def) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extName,
          `'fx.${fxName}.animatable' içindeki '${name}' bildirilen bir parametre değil.`
        )
      );
    }
    if (def.type !== "number") {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extName,
          `'fx.${fxName}.animatable' içindeki '${name}' sayı türünde değil (zarflar sayı taşır).`
        )
      );
    }
  }
  return [...seen];
}

/** Every `{{name}}` in the template must be a declared param, otherwise compile would emit it raw. */
function assertFxPlaceholdersDeclared(
  template: string,
  params: Record<string, ExtensionParamDef>,
  extName: string,
  fxName: string
): void {
  FX_PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FX_PLACEHOLDER_RE.exec(template)) !== null) {
    if (!(m[1] in params)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extName,
          `'fx.${fxName}.video_filter' içindeki '{{${m[1]}}}' bildirilen bir parametre değil ('params' altında tanımlayın).`
        )
      );
    }
  }
}

/** fx templates compile into one shared chain, so graph separators would corrupt neighbouring filters. */
function assertFxTemplateSafe(template: string, extName: string, fxName: string): void {
  const bad = template.match(/[[;\]]/);
  if (bad) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}.video_filter' grafik ayırıcısı ('${bad[0]}') içeremez (tek zincirde derlenir).`
      )
    );
  }
}

export function parseManifestFxSection(
  raw: unknown,
  extName: string
): Record<string, ExtensionFxSpec> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CutholError(DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'fx' alanı bir nesne olmalıdır.`));
  }
  const out: Record<string, ExtensionFxSpec> = {};
  for (const [fxName, rawFx] of Object.entries(raw as Record<string, unknown>)) {
    if (!EFFECT_NAME_RE.test(fxName)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'fx.${fxName}' geçersiz ad (küçük harf, [a-z0-9_-]).`)
      );
    }
    if (!rawFx || typeof rawFx !== "object" || Array.isArray(rawFx)) {
      throw new CutholError(DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'fx.${fxName}' bir nesne olmalıdır.`));
    }
    const obj = rawFx as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (!ALLOWED_FX_KEYS.has(k)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            extName,
            `'fx.${fxName}' içinde bilinmeyen alan '${k}' (izin verilenler: ${[...ALLOWED_FX_KEYS].join(", ")}).`
          )
        );
      }
    }
    if (typeof obj.video_filter !== "string" || !obj.video_filter.trim()) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'fx.${fxName}.video_filter' alanı zorunludur (ffmpeg süzgeci).`)
      );
    }
    const params = validateParamsMap(obj.params, extName, `fx.${fxName}`);
    const videoFilter = (obj.video_filter as string).trim();
    assertFxTemplateSafe(videoFilter, extName, fxName);
    assertFxPlaceholdersDeclared(videoFilter, params, extName, fxName);
    const animatable = parseFxAnimatable(obj.animatable, params, extName, fxName);
    out[fxName] = {
      ...(typeof obj.description === "string" ? { description: obj.description } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
      ...(animatable.length > 0 ? { animatable } : {}),
      video_filter: videoFilter,
    };
  }
  return out;
}
