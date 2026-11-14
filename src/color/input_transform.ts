// Source input transform (HLG/PQ to SDR BT.709) as ffmpeg filters (owner: render).
//
// Runs before any colour block and before measurement sampling, so both see the same pixels.
import { spawnSync } from "node:child_process";
import type { CutholSequence } from "../core/schema.js";
import { probeHdrKind } from "../library/probe.js";

export type InputTransformKind = "none" | "hlg_to_sdr" | "pq_to_sdr";

export interface ResolvedInputTransform {
  kind: InputTransformKind;
  /** ffmpeg filters that bring a source to SDR BT.709 before the colour stage; [] when none is needed. */
  filters: string[];
  /** False when this ffmpeg build lacks a required filter (render must not start). */
  available: boolean;
}

type LibraryAsset = CutholSequence["library"][number];

/** Explicit per-asset override wins; otherwise `auto` follows the measured transfer tag. */
export function resolveInputTransformKind(asset: LibraryAsset): InputTransformKind {
  const explicit = asset.color_source?.input;
  if (explicit === "none" || explicit === "hlg_to_sdr" || explicit === "pq_to_sdr") return explicit;
  const hdr = probeHdrKind(asset.probe);
  if (hdr === "hlg") return "hlg_to_sdr";
  if (hdr === "pq") return "pq_to_sdr";
  return "none";
}

let cachedHlgFilters: string[] | null = null;
let cachedPqFilters: string[] | null = null;

/**
 * Resolves what input transform an asset gets. Measurement and verify call this to know
 * what the render will do without compiling a graph.
 */
export function resolveInputTransform(asset: LibraryAsset): ResolvedInputTransform {
  const kind = resolveInputTransformKind(asset);
  if (kind === "none") return { kind, filters: [], available: true };
  if (!inputTransformFiltersAvailable()) return { kind, filters: [], available: false };
  // HLG (scene-referred OOTF) and PQ (absolute 10000-nit curve) both land on linear light,
  // get a gentle filmic shoulder, then return to BT.709 SDR. `npl=100` keeps diffuse white
  // near SDR levels for PQ; HLG needs no scaling (its nominal peak already fits).
  if (kind === "hlg_to_sdr") {
    cachedHlgFilters ??= [
      "zscale=transfer=linear",
      "tonemap=hable:desat=0",
      "zscale=transfer=bt709:matrix=bt709:primaries=bt709:range=tv",
    ];
    return { kind, filters: [...cachedHlgFilters], available: true };
  }
  cachedPqFilters ??= [
    "zscale=transfer=linear:npl=100",
    "tonemap=hable:desat=0",
    "zscale=transfer=bt709:matrix=bt709:primaries=bt709:range=tv",
  ];
  return { kind, filters: [...cachedPqFilters], available: true };
}

/** ffmpeg filters that bring a source to SDR BT.709 before the colour stage; [] when none is needed. */
export function inputTransformFilters(asset: LibraryAsset): string[] {
  return resolveInputTransform(asset).filters;
}

/** True when this ffmpeg build has the filters the HDR path needs (`zscale`, `tonemap`). */
export function inputTransformFiltersAvailable(): boolean {
  return ffmpegHasFilter("zscale") && ffmpegHasFilter("tonemap");
}

const filterPresenceCache = new Map<string, boolean>();

function ffmpegHasFilter(name: string): boolean {
  const hit = filterPresenceCache.get(name);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    const proc = spawnSync("ffmpeg", ["-hide_banner", "-h", `filter=${name}`], {
      encoding: "utf8",
      windowsHide: true,
    });
    const out = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
    ok = proc.status === 0 && out.includes(`Filter ${name}`);
  } catch {
    ok = false;
  }
  filterPresenceCache.set(name, ok);
  return ok;
}
