// Colour-stage verification gates (G1_SCHEMA additions G130-G139).
//
// Validates block-based colour stages (`treatments.color` on spine clips,
// `color` on visual lane cues) and project Looks (`seq.looks`): value ranges,
// Look bindings, and scope checks. Colour measurement/render checks live with
// their owners; this file only covers schema-level colour validation.
import fs from "node:fs";
import path from "node:path";
import { listColorItems, resolveItemLook, sourceKindOf } from "../color/blocks.js";
import { CutholDiagnostic, DIAGNOSTICS } from "../core/diagnostics.js";
import { ColorStageSpec, COLOR_STAGE_ORDER } from "../color/types.js";
import { CutholSequence } from "../core/schema.js";

function checkAmount(
  diagnostics: CutholDiagnostic[],
  subjectId: string,
  block: string,
  amount: unknown
): void {
  if (amount === undefined) return;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1) {
    diagnostics.push(DIAGNOSTICS.COLOR_BLOCK_AMOUNT_RANGE(subjectId, block, amount));
  }
}

function checkStage(
  diagnostics: CutholDiagnostic[],
  subjectId: string,
  stage: ColorStageSpec | null | undefined,
  lookIds: Set<string>
): void {
  if (stage === undefined || stage === null) return;
  for (const name of COLOR_STAGE_ORDER) {
    const block = (stage as Record<string, unknown>)[name] as { enabled?: unknown; amount?: unknown } | undefined;
    if (block === undefined || block === null) continue;
    checkAmount(diagnostics, subjectId, name, block.amount);
  }
  const look = stage.look;
  if (look !== undefined && look !== null) {
    checkAmount(diagnostics, subjectId, "look", look.amount);
    if (typeof look.id === "string" && look.id.length > 0 && !lookIds.has(look.id)) {
      diagnostics.push(DIAGNOSTICS.COLOR_LOOK_UNKNOWN(subjectId, look.id));
    }
  }
}

const HDR_TRANSFERS = new Set(["arib-std-b67", "smpte2084"]);

/** Technical colour checks that never decode frames (G133-G137). Appearance is never a warning. */
function verifyColorTechnical(seq: CutholSequence, rootDir: string | undefined, diagnostics: CutholDiagnostic[]): void {
  if (rootDir) {
    for (const look of seq.looks ?? []) {
      if (!look.lut_uri) continue;
      const abs = path.resolve(rootDir, look.lut_uri);
      const rel = path.relative(path.resolve(rootDir), abs);
      const bad = rel.startsWith("..") || path.isAbsolute(rel) || !/\.(cube|3dl)$/i.test(abs) || !fs.existsSync(abs);
      if (bad) diagnostics.push(DIAGNOSTICS.COLOR_LOOK_LUT_MISSING(look.id, look.lut_uri));
    }
  }
  const items = listColorItems(seq);
  for (const item of items) {
    const r = resolveItemLook(seq, item);
    if (r.via === "apply_to" && r.conflicts.length && r.look) {
      diagnostics.push(DIAGNOSTICS.COLOR_LOOKS_OVERLAP(item.id, [r.look.id, ...r.conflicts]));
    }
    if (r.via === "binding" && r.look) {
      const kind = sourceKindOf(seq, item.asset_handle);
      if (kind !== "camera") diagnostics.push(DIAGNOSTICS.COLOR_LOOK_ON_DESIGNED_SOURCE(item.id, r.look.id, kind));
    }
  }
  for (const asset of seq.library) {
    const t = (asset.probe.color_transfer ?? "").toLowerCase();
    if (HDR_TRANSFERS.has(t) && asset.color_source?.input === "none") {
      diagnostics.push(DIAGNOSTICS.COLOR_HDR_WITHOUT_TRANSFORM(asset.handle, t));
    }
  }
  const hasStage = (s: ColorStageSpec | undefined): boolean => Boolean(s && Object.keys(s).length);
  const byAsset = new Map<string, typeof items>();
  for (const i of items.filter((x) => x.track === "spine" && x.asset_handle)) {
    const list = byAsset.get(i.asset_handle!) ?? [];
    list.push(i);
    byAsset.set(i.asset_handle!, list);
  }
  for (const [asset, list] of byAsset) {
    const graded = list.filter((i) => hasStage(i.stage)).map((i) => i.id);
    if (!graded.length) continue;
    for (const i of list) {
      if (!hasStage(i.stage) && !resolveItemLook(seq, i).look) diagnostics.push(DIAGNOSTICS.COLOR_SIBLING_UNGRADED(i.id, asset, graded));
    }
  }
}

/** G1_SCHEMA colour checks (G130-G139, ERROR -> rollback). */
export function verifyColorGates(seq: CutholSequence, diagnostics: CutholDiagnostic[], rootDir?: string): void {
  verifyColorTechnical(seq, rootDir, diagnostics);
  const lookIds = new Set<string>((seq.looks ?? []).map((l) => l.id));
  const seen = new Set<string>();
  for (const look of seq.looks ?? []) {
    if (seen.has(look.id)) {
      diagnostics.push(DIAGNOSTICS.COLOR_LOOK_DUPLICATE(look.id));
    } else {
      seen.add(look.id);
    }
  }
  for (const clip of seq.spine.clips) {
    checkStage(diagnostics, clip.id, clip.treatments.color ?? undefined, lookIds);
  }
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      const color = (cue as { color?: ColorStageSpec | null }).color;
      checkStage(diagnostics, cue.id, color ?? undefined, lookIds);
    }
  }
}
