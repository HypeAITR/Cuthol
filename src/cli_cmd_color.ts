// CLI 'color' command group: measure (map, diff, clusters, kind), propose (solve, compare) and apply (set, look,
// migrate). Cuthol never changes colour by itself: only `set`, `look bind/create` and `migrate` write, and they
// write exactly what the agent asked for, then return the render-free prediction of the result.
import fs from "node:fs";
import path from "node:path";
import { boolFlag, numFlag, strFlag } from "./cli_args.js";
import { CLI_NOT_HANDLED, CliCommandContext, CliCommandResult, emitEnvelopeJson } from "./cli_output.js";
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import { loadSequence } from "./core/workspace.js";
import type { CutholSequence } from "./core/schema.js";
import { ColorItemRef, itemColorProgram, listColorItems, sourceKindOf } from "./color/blocks.js";
import { ColorFlagError, describeStage, parseColorFlags } from "./color/cli_parse.js";
import { clusterItems } from "./color/cluster.js";
import { colorDiff } from "./color/diff.js";
import { loadReferenceFrames, sampleItemFrames } from "./color/frames.js";
import { colorMap } from "./color/map.js";
import { predictStage } from "./color/predict.js";
import { colorSolve } from "./color/solve.js";
import { detectSourceKind } from "./color/source_kind.js";
import type { ColorFrameSet, ColorLookSpec, ColorSourceKind, ColorStageSpec } from "./color/types.js";
import { renderVariantSheet } from "./color/variants.js";
import {
  bindLook,
  migrateItem,
  removeLook,
  setItemColor,
  setSourceColor,
  upsertLook,
} from "./sequence/color_edit.js";

const fail = (action: string, reason: string): never => {
  throw new CutholError(DIAGNOSTICS.COLOR_COMMAND_FAILED(action, reason));
};

function findItem(seq: CutholSequence, id: string): ColorItemRef {
  const item = listColorItems(seq).find((i) => i.id === id);
  if (!item) throw new CutholError(DIAGNOSTICS.COLOR_ITEM_MISSING(id));
  return item;
}

const isItemId = (s: string): boolean => /^(sp|cue)_[A-Za-z0-9_]+$/.test(s);

/** Frames of an item (`sp_XX`/`cue_XX`) or of an image/video file. */
function framesOf(workspaceDir: string, ref: string, graded = false): ColorFrameSet {
  if (isItemId(ref)) return sampleItemFrames({ workspaceDir, itemId: ref, stage: graded ? "graded" : "source" });
  const abs = path.resolve(workspaceDir, ref);
  if (!fs.existsSync(abs)) fail("frames", `'${ref}' is neither an item id (sp_XX, cue_XX) nor an existing file`);
  return loadReferenceFrames(abs);
}

function predictionLines(workspaceDir: string, seq: CutholSequence, rootDir: string, itemId: string): {
  lines: string[];
  side_effects: string[];
  mean_change_de: number;
} {
  const item = findItem(seq, itemId);
  const prog = itemColorProgram(seq, rootDir, item);
  const source = sampleItemFrames({ workspaceDir, itemId, stage: "source" });
  const before = colorMap(source);
  const pred = predictStage(source, prog.fn, { before });
  return { lines: pred.lines, side_effects: pred.side_effects, mean_change_de: pred.mean_change_de };
}

function targetsOf(workspaceDir: string, seq: CutholSequence, flags: Record<string, string | boolean>, rest: string[]): string[] {
  const one = strFlag(flags, "item") ?? strFlag(flags, "clip");
  const many = strFlag(flags, "items");
  const cluster = strFlag(flags, "cluster");
  const ids = [...(one ? [one] : []), ...(many ? many.split(",").map((s) => s.trim()).filter(Boolean) : [])];
  if (cluster) {
    const maps = listColorItems(seq).map((i) => ({ itemId: i.id, assetHandle: i.asset_handle, map: colorMap(sampleItemFrames({ workspaceDir, itemId: i.id })) }));
    const c = clusterItems(maps).find((x) => x.id === cluster);
    if (!c) fail("set", `no cluster '${cluster}' (run 'cuthol color clusters')`);
    ids.push(...c!.items);
  }
  if (!ids.length && rest[0] && isItemId(rest[0])) ids.push(rest[0]);
  return [...new Set(ids)];
}

export async function runColorCommand(ctx: CliCommandContext): Promise<CliCommandResult> {
  void CLI_NOT_HANDLED;
  const { action, rest, flags, workspaceDir } = ctx;
  const out = (sub: string, payload: Record<string, unknown>): void =>
    emitEnvelopeJson(workspaceDir, `color.${sub}`, { action: `color.${sub}`, ...payload });

  try {
    switch (action) {
      case "map": {
        const image = strFlag(flags, "image");
        const ref = image ?? strFlag(flags, "item") ?? strFlag(flags, "clip") ?? rest[0];
        if (!ref) fail("map", "give --item <sp_XX|cue_XX> or --image <file>");
        const at = strFlag(flags, "at");
        const frames = image
          ? loadReferenceFrames(path.resolve(workspaceDir, image))
          : sampleItemFrames({
              workspaceDir,
              itemId: ref!,
              count: numFlag(flags, "frames"),
              atMs: at ? at.split(",").map((s) => parseTimeMs(s)) : undefined,
              stage: boolFlag(flags, "graded", false) ? "graded" : "source",
            });
        const map = colorMap(frames, { label: ref });
        out("map", { item: ref, lines: map.lines, fields: map.fields, evidence: map.evidence });
        return;
      }
      case "diff": {
        const a = strFlag(flags, "a") ?? rest[0];
        const b = strFlag(flags, "b") ?? rest[1];
        if (!a || !b) fail("diff", "give --a <item|file> --b <item|file>");
        const d = colorDiff(colorMap(framesOf(workspaceDir, a!)), colorMap(framesOf(workspaceDir, b!)));
        out("diff", { a, b, lines: d.lines, deltas: d.deltas, overlap: d.overlap });
        return;
      }
      case "solve": {
        const mode = (strFlag(flags, "mode") ?? (strFlag(flags, "before") ? "pair" : "match")) as "match" | "pair" | "technical";
        const { paths } = loadSequence(workspaceDir);
        if (mode === "pair") {
          const before = strFlag(flags, "before");
          const after = strFlag(flags, "after");
          if (!before || !after) fail("solve", "pair mode needs --before <file> --after <file> [--name <look>]");
          const r = colorSolve({ mode, from: framesOf(workspaceDir, before!), to: framesOf(workspaceDir, after!), rootDir: paths.rootDir, name: strFlag(flags, "name") });
          out("solve", { mode, lines: r.lines, patch: r.patch, lut_uri: r.lut_uri, predicted_residual_de: r.predicted_residual_de });
          return;
        }
        const item = strFlag(flags, "item") ?? strFlag(flags, "from") ?? rest[0];
        if (!item) fail("solve", "give --item <sp_XX|cue_XX>");
        const from = sampleItemFrames({ workspaceDir, itemId: item! });
        let to: ColorFrameSet | undefined;
        if (mode === "match") {
          const target = strFlag(flags, "to") ?? rest[1];
          if (!target) fail("solve", "match mode needs --to <item|file> (the look to match); use --mode technical for exposure/white balance limits");
          // Another item is matched as it looks now (after its own grade); a file as it is.
          to = framesOf(workspaceDir, target!, true);
        }
        const targets = strFlag(flags, "targets")?.split(",").map((s) => s.trim()).filter(Boolean) as Array<"exposure" | "white_balance" | "legal_range"> | undefined;
        const r = colorSolve({ mode, from, to, technical: targets, rootDir: paths.rootDir, name: strFlag(flags, "name") });
        const lines = r.lines.map((l) => l.split("<item>").join(item!));
        out("solve", { mode, item, lines, patch: r.patch, predicted_residual_de: r.predicted_residual_de, applied: false });
        return;
      }
      case "set": {
        const { sequence } = loadSequence(workspaceDir);
        const ids = targetsOf(workspaceDir, sequence, flags, rest);
        if (!ids.length) fail("set", "give --item <id>, --items <a,b> or --cluster <cN>");
        const reason = strFlag(flags, "reason");
        const results: Array<Record<string, unknown>> = [];
        for (const id of ids) {
          const { sequence: seq } = loadSequence(workspaceDir);
          const cur = findItem(seq, id).stage;
          const parsed = parseColorFlags(
            {
              wb: strFlag(flags, "wb"),
              exposure: strFlag(flags, "exposure"),
              tone: strFlag(flags, "tone"),
              curve: strFlag(flags, "curve"),
              wheel: strFlag(flags, "wheel"),
              hsl: strFlag(flags, "hsl"),
              sat: strFlag(flags, "sat"),
              vibrance: strFlag(flags, "vibrance"),
              look: strFlag(flags, "look"),
              amount: strFlag(flags, "amount"),
              remove: strFlag(flags, "remove"),
              patch: strFlag(flags, "patch"),
            },
            cur
          );
          if (!Object.keys(parsed.patch).length && !parsed.remove.length) fail("set", "nothing to set: give block flags (--wb, --exposure, --tone, --curve, --wheel, --hsl, --sat, --vibrance, --look, --amount), --remove or --patch");
          const res = setItemColor({ workspaceDir, itemId: id, patch: parsed.patch, remove: parsed.remove, replace: boolFlag(flags, "replace", false), reason });
          const { sequence: after, paths } = loadSequence(workspaceDir);
          let pred: ReturnType<typeof predictionLines>;
          // A person's slider edit from Cuthol Live needs no prediction (it decodes frames and would
          // make every save take seconds); the agent reads the change from the Live notes instead.
          if (process.env.CUTHOL_LIVE_ACTOR === "human") {
            results.push({ item: id, stage: describeStage(res.color), revision: res.revision, lines: [`${id}: ${describeStage(res.color)}`] });
            continue;
          }
          try {
            pred = predictionLines(workspaceDir, after, paths.rootDir, id);
          } catch (err) {
            const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
            pred = { lines: [`prediction unavailable (${why}); the edit is saved, check with 'cuthol monitor frame'`], side_effects: [], mean_change_de: NaN };
          }
          results.push({
            item: id,
            stage: describeStage(res.color),
            revision: res.revision,
            verification: res.verification,
            lines: [`${id}: ${describeStage(res.color)}`, ...pred.lines],
            side_effects: pred.side_effects,
            mean_change_de: pred.mean_change_de,
          });
        }
        out("set", { item: ids.length === 1 ? ids[0] : undefined, items: results, lines: results.flatMap((r) => r.lines as string[]) });
        return;
      }
      case "compare": {
        const id = strFlag(flags, "item") ?? strFlag(flags, "clip") ?? rest[0];
        if (!id) fail("compare", "give --item <sp_XX|cue_XX> --variants '<json array of patches>'");
        const raw = strFlag(flags, "variants");
        let variants: Array<Record<string, unknown>> = [];
        if (raw) {
          try {
            variants = JSON.parse(raw);
          } catch {
            fail("compare", "--variants must be a JSON array of stage patches");
          }
          if (!Array.isArray(variants)) fail("compare", "--variants must be a JSON array");
        }
        const { sequence, paths } = loadSequence(workspaceDir);
        const item = findItem(sequence, id!);
        const source = sampleItemFrames({ workspaceDir, itemId: id! });
        const list = [
          ...(item.stage ? [{ label: "current", fn: itemColorProgram(sequence, paths.rootDir, item).fn }] : []),
          ...variants.map((v, i) => {
            const { label, ...patch } = v as { label?: string } & Record<string, unknown>;
            const stage = { ...(item.stage ?? {}), ...(parseColorFlags({ patch }, item.stage).patch) } as ColorStageSpec;
            return { label: label ?? String.fromCharCode(65 + i), fn: itemColorProgram(sequence, paths.rootDir, item, stage).fn };
          }),
        ];
        const png = path.resolve(workspaceDir, strFlag(flags, "out") ?? path.join(".cuthol", "monitor", `color_compare_${id}.png`));
        const r = renderVariantSheet({ source, variants: list, outPng: png });
        out("compare", { item: id, png: r.png, lines: r.lines, applied: false });
        return;
      }
      case "look":
        return runLook(ctx, out);
      case "kind": {
        const handle = strFlag(flags, "handle") ?? rest[0];
        if (!handle) fail("kind", "give --handle <vid_XX>");
        const { sequence } = loadSequence(workspaceDir);
        const asset = sequence.library.find((a) => a.handle === handle);
        if (!asset) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(handle!));
        const user = listColorItems(sequence).find((i) => i.asset_handle === handle);
        const frames = user ? sampleItemFrames({ workspaceDir, itemId: user.id }) : loadReferenceFrames(asset.uri);
        const measured = detectSourceKind(frames);
        const set = strFlag(flags, "set") as ColorSourceKind | undefined;
        if (set && !["camera", "screen", "graphic"].includes(set)) fail("kind", "--set camera|screen|graphic");
        const input = strFlag(flags, "input") as "auto" | "none" | "hlg_to_sdr" | "pq_to_sdr" | undefined;
        if (input && !["auto", "none", "hlg_to_sdr", "pq_to_sdr"].includes(input)) fail("kind", "--input auto|none|hlg_to_sdr|pq_to_sdr");
        const res = setSourceColor({ workspaceDir, assetHandle: handle!, patch: { kind_measured: measured.kind, ...(set ? { kind: set } : {}), ...(input ? { input } : {}) } });
        const eff = set ?? asset.color_source?.kind ?? measured.kind;
        out("kind", {
          handle,
          color_source: res.color_source,
          revision: res.revision,
          lines: [`${handle}: ${eff}${set || asset.color_source?.kind ? " (set)" : ""}, measured ${measured.kind} (${Math.round(measured.confidence * 100)}%: ${measured.evidence})${input ? `, input ${input}` : ""}`],
        });
        return;
      }
      case "clusters": {
        const { sequence } = loadSequence(workspaceDir);
        const items = listColorItems(sequence);
        const maps = items.map((i) => ({ itemId: i.id, assetHandle: i.asset_handle, map: colorMap(sampleItemFrames({ workspaceDir, itemId: i.id })) }));
        const clusters = clusterItems(maps);
        const graded = new Set(items.filter((i) => i.stage && Object.keys(i.stage).length).map((i) => i.id));
        const lines = clusters.map((c) => {
          const marks = c.items.map((id) => (graded.has(id) ? `${id}*` : id));
          const mixed = c.items.some((id) => graded.has(id)) && c.items.some((id) => !graded.has(id));
          return `${c.id}: ${marks.join(" ")}${mixed ? "  <- some members ungraded" : ""}`;
        });
        out("clusters", { clusters, lines: [...lines, "* = has a colour stage"] });
        return;
      }
      case "migrate": {
        const { sequence } = loadSequence(workspaceDir);
        const all = boolFlag(flags, "all", false);
        const id = strFlag(flags, "item") ?? strFlag(flags, "clip") ?? rest[0];
        const legacy = (c: CutholSequence["spine"]["clips"][number]): boolean => {
          const g = c.treatments.color_grade;
          return g.brightness !== 0 || g.contrast !== 1 || g.saturation !== 1 || g.temperature_k !== 6500 || g.lut_uri !== null;
        };
        const ids = all ? sequence.spine.clips.filter(legacy).map((c) => c.id) : id ? [id] : [];
        if (!ids.length) fail("migrate", all ? "no clip has a legacy grade" : "give --item <sp_XX> or --all");
        const lines: string[] = [];
        for (const cid of ids) {
          const r = migrateItem({ workspaceDir, itemId: cid });
          lines.push(`${cid}: legacy grade -> ${describeStage(r.color)}`);
        }
        out("migrate", { items: ids, lines });
        return;
      }
      default:
        fail(action ?? "", "unknown action (map, diff, solve, set, compare, look, kind, clusters, migrate)");
    }
  } catch (err) {
    if (err instanceof ColorFlagError) throw new CutholError(DIAGNOSTICS.COLOR_COMMAND_FAILED(action ?? "", err.message));
    throw err;
  }
}

function runLook(ctx: CliCommandContext, out: (sub: string, p: Record<string, unknown>) => void): void {
  const { rest, flags, workspaceDir } = ctx;
  const sub = rest[0] ?? "list";
  const { sequence, paths } = loadSequence(workspaceDir);
  const looks = sequence.looks ?? [];
  const nextId = (): string => {
    let n = looks.length + 1;
    while (looks.some((l) => l.id === `look_${String(n).padStart(2, "0")}`)) n++;
    return `look_${String(n).padStart(2, "0")}`;
  };
  const scopeOf = (): ColorLookSpec["scope"] => {
    const k = strFlag(flags, "kinds");
    return k ? { kinds: k.split(",").map((s) => s.trim()) as ColorSourceKind[] } : undefined;
  };
  const applyTo = (): ColorLookSpec["apply_to"] => {
    const a = strFlag(flags, "apply-to");
    return a === undefined ? undefined : a === "all" ? "all" : a.split(",").map((s) => s.trim());
  };
  const lineOf = (l: ColorLookSpec): string =>
    `${l.id} '${l.name}': ${l.lut_uri ? `lut ${l.lut_uri}` : describeStage(l.blocks)} amount ${l.amount ?? 1}, reaches ${l.apply_to === "all" ? "all" : Array.isArray(l.apply_to) ? l.apply_to.join(",") : "bound items only"} [${(l.scope?.kinds ?? ["camera"]).join(",")}]`;

  if (sub === "list") {
    out("look", { sub, looks, lines: looks.length ? looks.map(lineOf) : ["no Looks"] });
    return;
  }
  if (sub === "create" || sub === "from-pair") {
    const name = strFlag(flags, "name");
    if (!name) fail(`look ${sub}`, "give --name <name>");
    const look: ColorLookSpec = { id: nextId(), name: name!, amount: numFlag(flags, "amount") ?? 1, apply_to: applyTo(), scope: scopeOf() };
    if (sub === "from-pair") {
      const before = strFlag(flags, "before");
      const after = strFlag(flags, "after");
      if (!before || !after) fail("look from-pair", "give --before <file> --after <file>");
      const r = colorSolve({ mode: "pair", from: framesOf(workspaceDir, before!), to: framesOf(workspaceDir, after!), rootDir: paths.rootDir, name: name! });
      if (!r.lut_uri) fail("look from-pair", "the solver returned no LUT");
      look.lut_uri = r.lut_uri;
      look.origin = { kind: "pair", note: `residual ΔE ${r.predicted_residual_de.toFixed(2)}` };
    } else {
      const fromItem = strFlag(flags, "from-item");
      const lut = strFlag(flags, "lut");
      const blocks = strFlag(flags, "blocks");
      if ([fromItem, lut, blocks].filter(Boolean).length !== 1) fail("look create", "give exactly one of --from-item <id>, --lut <file.cube>, --blocks '<json>'");
      if (fromItem) {
        const st = findItem(sequence, fromItem).stage;
        if (!st) fail("look create", `${fromItem} has no colour stage`);
        const { look: _l, ...b } = st!;
        look.blocks = b;
        look.origin = { kind: "blocks", note: `from ${fromItem}` };
      } else if (lut) {
        const abs = path.resolve(workspaceDir, lut);
        if (!fs.existsSync(abs)) fail("look create", `LUT '${lut}' not found`);
        const rel = path.relative(paths.rootDir, abs);
        let uri = rel;
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          const dst = path.join(paths.rootDir, "looks", path.basename(abs));
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(abs, dst);
          uri = path.relative(paths.rootDir, dst);
        }
        look.lut_uri = uri.split(path.sep).join("/");
        look.origin = { kind: "file" };
      } else {
        look.blocks = parseColorFlags({ patch: blocks }).patch;
        look.origin = { kind: "blocks" };
      }
    }
    const r = upsertLook({ workspaceDir, look });
    out("look", { sub, look: r.look, revision: r.revision, verification: r.verification, lines: [lineOf(r.look)] });
    return;
  }
  if (sub === "bind") {
    const id = strFlag(flags, "look") ?? rest[1];
    const items = strFlag(flags, "items") ?? strFlag(flags, "item");
    if (!id || !items) fail("look bind", "give --look <look_XX> --items <ids>|all");
    const ids = items === "all" ? listColorItems(sequence).filter((i) => sourceKindOf(sequence, i.asset_handle) === "camera").map((i) => i.id) : items!.split(",").map((s) => s.trim());
    const lines: string[] = [];
    for (const it of ids) {
      const r = bindLook({ workspaceDir, itemId: it, lookId: id!, amount: numFlag(flags, "amount") });
      lines.push(`${it}: ${describeStage(r.color)}`);
    }
    out("look", { sub, look: id, items: ids, lines });
    return;
  }
  if (sub === "remove") {
    const id = strFlag(flags, "look") ?? rest[1];
    if (!id) fail("look remove", "give --look <look_XX>");
    const r = removeLook({ workspaceDir, lookId: id! });
    out("look", { sub, look: id, removed: r.removed, revision: r.revision, lines: [r.removed ? `${id} removed (bindings cleared)` : `${id} not found`] });
    return;
  }
  fail("look", `unknown look action '${sub}' (create, from-pair, bind, list, remove)`);
}

function parseTimeMs(raw: string): number {
  const s = raw.trim();
  const m = /^(-?\d+(?:\.\d+)?)(ms|s)?$/.exec(s);
  if (!m) fail("map", `--at: '${raw}' is not a time (e.g. 1500ms or 1.5s)`);
  return m![2] === "s" ? Number(m![1]) * 1000 : Number(m![1]);
}
