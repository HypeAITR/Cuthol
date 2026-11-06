// Spine clip effect-chain operations (`spine fx` add / set / remove / list).
// Every mutation is revisioned and undoable through `commitVerifiedMutation`, so an invalid kind, bad
// params, or an unsupported envelope is refused with G118/G119 before anything is written. Removing an fx
// also removes its `fx.<id>.*` envelopes, otherwise the sequence would keep a dangling envelope (G119).
// Split/excise need no change here: they `structuredClone` the clip (fx rides along) and slice every envelope
// by clip-local time, which already covers `fx.<id>.<param>` envelopes.
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type { ClipFxSpec, EffectParamValue, SpineClip } from "../core/schema.js";
import { loadSequence } from "../core/workspace.js";
import { commitVerifiedMutation, type VerificationReport } from "../verify/gates.js";
import { BUILTIN_FX_KIND } from "../compositor/compile_spine_fx.js";

const FX_ID_RE = /^fx_(\d+)$/;

/** Next free `fx_XX` id inside one clip (per-clip numbering, never reused after remove). */
export function allocateFxId(existing: ClipFxSpec[] | undefined): string {
  let max = 0;
  for (const f of existing ?? []) {
    const m = FX_ID_RE.exec(f.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `fx_${String(max + 1).padStart(2, "0")}`;
}

function findClip(seq: { spine: { clips: SpineClip[] } }, clipId: string): SpineClip {
  const clip = seq.spine.clips.find((c) => c.id === clipId);
  if (!clip) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(clipId));
  }
  return clip;
}

function findFx(clip: SpineClip, fxId: string): ClipFxSpec {
  const fx = (clip.fx ?? []).find((f) => f.id === fxId);
  if (!fx) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(fxId));
  }
  return fx;
}

function assertScalarParams(
  params: Record<string, unknown>,
  clipId: string,
  fxId: string,
  kind: string
): Record<string, EffectParamValue> {
  const out: Record<string, EffectParamValue> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") {
      throw new CutholError(
        DIAGNOSTICS.SPINE_FX_INVALID(clipId, fxId, kind, `'${k}' must be a number, text or true/false.`)
      );
    }
    out[k] = v;
  }
  return out;
}

export function addSpineFx(options: {
  workspaceDir: string;
  clipId: string;
  /** Effect kind: `ext:<extension>/<name>`, or `ffmpeg` for a raw chain (then `filter` is required). */
  kind?: string;
  /** Raw filter chain; shorthand for `kind: "ffmpeg"` with `params.filter`. Exactly one of kind/filter. */
  filter?: string;
  params?: Record<string, unknown>;
  enabled?: boolean;
}): { fx: ClipFxSpec; revision: number; verification: VerificationReport } {
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.fx.add(${options.clipId})`,
    (seq) => {
      const clip = findClip(seq, options.clipId);
      const hasKind = options.kind !== undefined && options.kind !== "";
      const hasFilter = options.filter !== undefined && options.filter !== "";
      if (hasKind === hasFilter) {
        throw new CutholError(
          DIAGNOSTICS.SPINE_FX_INVALID(
            options.clipId,
            "fx_??",
            options.kind ?? BUILTIN_FX_KIND,
            `pass either '--kind <kind>' or '--filter "<chain>"' (not both, not neither).`
          )
        );
      }
      const kind = hasFilter ? BUILTIN_FX_KIND : options.kind!.trim();
      if (!kind) {
        throw new CutholError(
          DIAGNOSTICS.SPINE_FX_INVALID(options.clipId, "fx_??", kind, `kind must not be empty.`)
        );
      }
      const id = allocateFxId(clip.fx);
      const merged: Record<string, unknown> = { ...(options.params ?? {}) };
      if (hasFilter) merged.filter = options.filter;
      const entry: ClipFxSpec = {
        id,
        kind,
        params: assertScalarParams(merged, options.clipId, id, kind),
        ...(options.enabled === false ? { enabled: false as const } : {}),
      };
      clip.fx = [...(clip.fx ?? []), entry];
      return structuredClone(entry);
    }
  );

  return { fx: result, revision, verification };
}

export function setSpineFx(options: {
  workspaceDir: string;
  clipId: string;
  fxId: string;
  /** Param updates, merged over the stored params (not replaced). */
  params?: Record<string, unknown>;
  /** Replaces the whole chain; only for `kind: "ffmpeg"` entries. */
  filter?: string;
  enabled?: boolean;
}): { fx: ClipFxSpec; revision: number; verification: VerificationReport } {
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.fx.set(${options.clipId},${options.fxId})`,
    (seq) => {
      const clip = findClip(seq, options.clipId);
      const fx = findFx(clip, options.fxId);
      if (options.filter !== undefined) {
        if (fx.kind !== BUILTIN_FX_KIND) {
          throw new CutholError(
            DIAGNOSTICS.SPINE_FX_INVALID(
              options.clipId,
              options.fxId,
              fx.kind,
              `'--filter' can only be used with the built-in 'ffmpeg' kind.`
            )
          );
        }
        fx.params = { ...fx.params, filter: options.filter };
      }
      if (options.params) {
        fx.params = {
          ...fx.params,
          ...assertScalarParams(options.params, options.clipId, options.fxId, fx.kind),
        };
      }
      if (options.enabled !== undefined) {
        if (options.enabled) delete fx.enabled;
        else fx.enabled = false;
      }
      return structuredClone(fx);
    }
  );

  return { fx: result, revision, verification };
}

export function removeSpineFx(options: {
  workspaceDir: string;
  clipId: string;
  fxId: string;
}): { removed_id: string; revision: number; verification: VerificationReport } {
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.fx.remove(${options.clipId},${options.fxId})`,
    (seq) => {
      const clip = findClip(seq, options.clipId);
      findFx(clip, options.fxId);
      clip.fx = (clip.fx ?? []).filter((f) => f.id !== options.fxId);
      if (clip.fx.length === 0) delete clip.fx;
      const prefix = `fx.${options.fxId}.`;
      clip.envelopes = clip.envelopes.filter((e) => !e.parameter.startsWith(prefix));
      return options.fxId;
    }
  );

  return { removed_id: result, revision, verification };
}

export function listSpineFx(options: {
  workspaceDir: string;
  clipId: string;
}): { clip: string; fx: ClipFxSpec[] } {
  const { sequence } = loadSequence(options.workspaceDir);
  const clip = findClip(sequence, options.clipId);
  return { clip: clip.id, fx: structuredClone(clip.fx ?? []) };
}
