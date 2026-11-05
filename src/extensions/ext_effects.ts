// Effect registry of a sequence: the `fx` and `transitions` that its enabled extensions provide, keyed by
// `ext:<extension>/<name>`. Shared by spine fx and extension transitions; compile, verify and
// CLI/MCP code read effect definitions only through this module.
import type { CutholSequence, ExtensionEffectRef } from "../core/schema.js";
import { resolveExtension } from "./ext_registry.js";
import type { ExtensionFxSpec } from "./ext_fx.js";
import type { ExtensionTransitionSpec } from "./ext_transitions.js";

export interface ResolvedEffectDef<T> {
  ref: ExtensionEffectRef;
  extension: string;
  name: string;
  /** Version / content hash of the extension that was actually loaded. */
  version: string;
  content_hash: string;
  /** False when the loaded extension differs from the version/hash pinned in `sequence.extensions`. */
  pinned_match: boolean;
  /** Absolute extension directory (for templates that reference files inside it). */
  dir: string;
  spec: T;
}

export interface SequenceEffectRegistry {
  fx: Map<ExtensionEffectRef, ResolvedEffectDef<ExtensionFxSpec>>;
  transitions: Map<ExtensionEffectRef, ResolvedEffectDef<ExtensionTransitionSpec>>;
  /** Enabled extensions that could not be loaded (name → error message); their effects are absent. */
  load_errors: Map<string, string>;
}

const EFFECT_REF_RE = /^ext:([a-z][a-z0-9_-]{0,63})\/([a-z][a-z0-9_-]{0,63})$/;

export function isExtensionEffectRef(kind: string): kind is ExtensionEffectRef {
  return EFFECT_REF_RE.test(kind);
}

export function parseExtensionEffectRef(kind: string): { extension: string; name: string } | null {
  const m = EFFECT_REF_RE.exec(kind);
  return m ? { extension: m[1], name: m[2] } : null;
}

export function formatExtensionEffectRef(extension: string, name: string): ExtensionEffectRef {
  return `ext:${extension}/${name}`;
}

export function loadSequenceEffectRegistry(seq: CutholSequence, rootDir: string): SequenceEffectRegistry {
  const reg: SequenceEffectRegistry = { fx: new Map(), transitions: new Map(), load_errors: new Map() };
  for (const ref of seq.extensions ?? []) {
    try {
      const ext = resolveExtension(ref.name, rootDir);
      const base = {
        extension: ext.name,
        version: ext.version,
        content_hash: ext.contentHash,
        pinned_match: ext.contentHash === ref.content_hash && ext.version === ref.version,
        dir: ext.dir,
      };
      for (const [name, spec] of Object.entries(ext.manifest.fx ?? {})) {
        const r = formatExtensionEffectRef(ext.name, name);
        reg.fx.set(r, { ...base, ref: r, name, spec });
      }
      for (const [name, spec] of Object.entries(ext.manifest.transitions ?? {})) {
        const r = formatExtensionEffectRef(ext.name, name);
        reg.transitions.set(r, { ...base, ref: r, name, spec });
      }
    } catch (err) {
      reg.load_errors.set(ref.name, err instanceof Error ? err.message : String(err));
    }
  }
  return reg;
}

const memo = new WeakMap<CutholSequence, { rootDir: string; reg: SequenceEffectRegistry }>();

/** Memoised per sequence object (one compile = one load); a different rootDir reloads. */
export function getSequenceEffectRegistry(seq: CutholSequence, rootDir: string): SequenceEffectRegistry {
  const hit = memo.get(seq);
  if (hit && hit.rootDir === rootDir) return hit.reg;
  const reg = loadSequenceEffectRegistry(seq, rootDir);
  memo.set(seq, { rootDir, reg });
  return reg;
}
