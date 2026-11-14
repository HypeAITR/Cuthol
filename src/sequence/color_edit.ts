// Journaled colour edits (owner: interface). Used by `cuthol color set|look ...|kind|migrate`, MCP and Live.
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type { ColorLookSpec, ColorSourceSpec, ColorStageBlockName, ColorStageSpec } from "../color/types.js";
import { COLOR_STAGE_ORDER } from "../color/types.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";

export interface SetItemColorOptions {
  workspaceDir: string;
  /** Spine clip (`sp_*`) or visual lane cue (`cue_*`). */
  itemId: string;
  /** Blocks to write. Without `replace`, each given block replaces that block; `hsl` entries merge by `id`. */
  patch: ColorStageSpec;
  /** Blocks (or `hsl:<id>`) to remove before applying the patch. */
  remove?: Array<ColorStageBlockName | `hsl:${string}`>;
  /** Replace the whole stage with `patch`. */
  replace?: boolean;
  /** Why the agent made this change (match, technical, taste); kept in the journal label. */
  reason?: string;
}

export interface SetItemColorResult {
  item: string;
  color: ColorStageSpec | undefined;
  revision: number;
  verification: VerificationReport;
}

function resolveItemStage(seq: { spine: { clips: Array<{ id: string; treatments: { color?: ColorStageSpec } }> }; lanes: Array<{ cues: Array<{ id: string; color?: ColorStageSpec }> }> }, itemId: string): { get(): ColorStageSpec | undefined; set(v: ColorStageSpec | undefined): void } {
  if (itemId.startsWith("sp_")) {
    const clip = seq.spine.clips.find((c) => c.id === itemId);
    if (!clip) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(itemId));
    return { get: () => clip.treatments.color, set: (v) => { clip.treatments.color = v; } };
  }
  if (itemId.startsWith("cue_")) {
    for (const lane of seq.lanes) {
      const cue = lane.cues.find((c) => c.id === itemId);
      if (cue) return { get: () => cue.color, set: (v) => { cue.color = v; } };
    }
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(itemId));
  }
  throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(itemId));
}

export function setItemColor(opts: SetItemColorOptions): SetItemColorResult {
  const { result, revision, verification } = commitVerifiedMutation(
    opts.workspaceDir,
    `color.set(${opts.itemId})${opts.reason ? ` ${opts.reason}` : ""}`,
    (seq) => {
      const ref = resolveItemStage(seq as never, opts.itemId);
      let stage: ColorStageSpec = opts.replace ? {} : { ...(ref.get() ?? {}) };
      if (opts.remove) {
        for (const r of opts.remove) {
          if (r.startsWith("hsl:")) {
            const id = r.slice(4);
            if (stage.hsl) {
              stage.hsl = stage.hsl.filter((h) => h.id !== id);
              if (stage.hsl.length === 0) delete stage.hsl;
            }
          } else {
            delete stage[r as ColorStageBlockName];
          }
        }
      }
      for (const name of COLOR_STAGE_ORDER) {
        const pv = (opts.patch as Record<string, unknown>)[name];
        if (pv === undefined) continue;
        if (name === "hsl") {
          const incoming = (pv ?? []) as Array<{ id: string } & Record<string, unknown>>;
          const base = [...(stage.hsl ?? [])];
          for (const h of incoming) {
            const i = base.findIndex((b) => b.id === h.id);
            if (i >= 0) base[i] = h as never;
            else base.push(h as never);
          }
          if (base.length > 0) stage.hsl = base as never;
          else delete stage.hsl;
        } else {
          (stage as Record<string, unknown>)[name] = pv;
        }
      }
      const empty = Object.keys(stage).length === 0;
      ref.set(empty ? undefined : stage);
      return ref.get();
    }
  );
  return { item: opts.itemId, color: result, revision, verification };
}

export function upsertLook(opts: { workspaceDir: string; look: ColorLookSpec }): {
  look: ColorLookSpec;
  revision: number;
  verification: VerificationReport;
} {
  const { result, revision, verification } = commitVerifiedMutation(
    opts.workspaceDir,
    `color.look.upsert(${opts.look.id})`,
    (seq) => {
      if (!seq.looks) seq.looks = [];
      const i = seq.looks.findIndex((l) => l.id === opts.look.id);
      if (i >= 0) seq.looks[i] = opts.look;
      else seq.looks.push(opts.look);
      return opts.look;
    }
  );
  return { look: result, revision, verification };
}

export function removeLook(opts: { workspaceDir: string; lookId: string }): {
  removed: boolean;
  revision: number;
  verification: VerificationReport;
} {
  const { result, revision, verification } = commitVerifiedMutation(
    opts.workspaceDir,
    `color.look.remove(${opts.lookId})`,
    (seq) => {
      let removed = false;
      if (seq.looks) {
        const before = seq.looks.length;
        seq.looks = seq.looks.filter((l) => l.id !== opts.lookId);
        removed = seq.looks.length !== before;
      }
      for (const clip of seq.spine.clips) {
        if (clip.treatments.color?.look?.id === opts.lookId) delete clip.treatments.color.look;
      }
      for (const lane of seq.lanes) {
        for (const cue of lane.cues) {
          if (cue.color?.look?.id === opts.lookId) delete cue.color.look;
        }
      }
      return removed;
    }
  );
  return { removed: result, revision, verification };
}

export function bindLook(opts: { workspaceDir: string; itemId: string; lookId: string; amount?: number }): SetItemColorResult {
  const { result, revision, verification } = commitVerifiedMutation(
    opts.workspaceDir,
    `color.set(${opts.itemId})`,
    (seq) => {
      const exists = (seq.looks ?? []).some((l) => l.id === opts.lookId);
      if (!exists) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(opts.lookId));
      const ref = resolveItemStage(seq as never, opts.itemId);
      const stage: ColorStageSpec = { ...(ref.get() ?? {}) };
      stage.look = opts.amount !== undefined ? { id: opts.lookId, amount: opts.amount } : { id: opts.lookId };
      ref.set(stage);
      return ref.get();
    }
  );
  return { item: opts.itemId, color: result, revision, verification };
}

export function unbindLook(opts: { workspaceDir: string; itemId: string }): SetItemColorResult {
  const { result, revision, verification } = commitVerifiedMutation(
    opts.workspaceDir,
    `color.set(${opts.itemId})`,
    (seq) => {
      const ref = resolveItemStage(seq as never, opts.itemId);
      const stage: ColorStageSpec = { ...(ref.get() ?? {}) };
      delete stage.look;
      ref.set(Object.keys(stage).length === 0 ? undefined : stage);
      return ref.get();
    }
  );
  return { item: opts.itemId, color: result, revision, verification };
}

export function setSourceColor(opts: { workspaceDir: string; assetHandle: string; patch: ColorSourceSpec }): {
  color_source: ColorSourceSpec;
  revision: number;
  verification: VerificationReport;
} {
  const { result, revision, verification } = commitVerifiedMutation(
    opts.workspaceDir,
    `color.kind(${opts.assetHandle})`,
    (seq) => {
      const item = seq.library.find((l) => l.handle === opts.assetHandle);
      if (!item) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(opts.assetHandle));
      item.color_source = { ...(item.color_source ?? {}), ...opts.patch };
      return item.color_source;
    }
  );
  return { color_source: result, revision, verification };
}

function kelvinToMired(k: number): number {
  return 1000000 / k - 1000000 / 6500;
}

export function migrateItem(opts: { workspaceDir: string; itemId: string }): SetItemColorResult {
  const { result, revision, verification } = commitVerifiedMutation(
    opts.workspaceDir,
    `color.set(${opts.itemId})`,
    (seq) => {
      const clip = (seq.spine.clips as Array<{ id: string; treatments: { color_grade: { brightness: number; contrast: number; saturation: number; temperature_k: number; lut_uri: string | null }; color?: ColorStageSpec } }>).find((c) => c.id === opts.itemId);
      if (!clip) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(opts.itemId));
      const g = clip.treatments.color_grade;
      const stage: ColorStageSpec = { ...(clip.treatments.color ?? {}) };
      const isDefault = g.brightness === 0 && g.contrast === 1 && g.saturation === 1 && g.temperature_k === 6500 && g.lut_uri === null;
      if (!isDefault) {
        if (g.temperature_k !== 6500) stage.white_balance = { temp_mired: kelvinToMired(g.temperature_k), tint: 0 };
        if (g.saturation !== 1) stage.saturation = { ...(stage.saturation ?? {}), saturation: g.saturation };
        if (g.contrast !== 1 || g.brightness !== 0) {
          stage.tone = { ...(stage.tone ?? {}), contrast: g.contrast !== 1 ? g.contrast - 1 : (stage.tone?.contrast ?? 0), blacks: g.brightness !== 0 ? g.brightness : stage.tone?.blacks, whites: g.brightness !== 0 ? g.brightness : stage.tone?.whites };
        }
        if (g.lut_uri !== null) {
          const looks = (seq.looks ?? []) as ColorLookSpec[];
          let look = looks.find((l) => l.lut_uri === g.lut_uri);
          if (!look) {
            look = { id: `look_migrated_${looks.length + 1}`, name: `Migrated ${looks.length + 1}`, lut_uri: g.lut_uri, origin: { kind: "file" } };
            looks.push(look);
            seq.looks = looks;
          }
          stage.look = { id: look.id };
        }
      }
      clip.treatments.color = Object.keys(stage).length === 0 ? undefined : stage;
      clip.treatments.color_grade = { brightness: 0, contrast: 1, saturation: 1, temperature_k: 6500, lut_uri: null };
      return clip.treatments.color;
    }
  );
  return { item: opts.itemId, color: result, revision, verification };
}
