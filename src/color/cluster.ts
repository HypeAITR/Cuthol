// Groups items shot in the same setup (owner: measurement).
import type { ColorMap } from "./types.js";

export interface ColorCluster {
  id: string;
  items: string[];
  lines: string[];
}

export function clusterItems(maps: Array<{ itemId: string; assetHandle?: string; map: ColorMap }>): ColorCluster[] {
  const clusters: ColorCluster[] = [];
  const feat = (m: ColorMap): number[] => {
    const f = m.fields as Record<string, number>;
    return [f.L_p50, f.md_a, f.md_b, f.M, f.chroma_p50, f.L_p75 - f.L_p25];
  };
  const dist = (a: number[], b: number[]): number =>
    Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2 * [4, 1, 1, 30, 0.02, 4][i], 0));
  for (const m of maps) {
    const f = feat(m.map);
    let best: ColorCluster | null = null;
    let bestD = 1.2;
    for (const c of clusters) {
      const rep = maps.find((x) => x.itemId === c.items[0])!.map;
      const d = dist(f, feat(rep));
      if (d < bestD) { bestD = d; best = c; }
    }
    const ah = maps.find((x) => x.itemId === m.itemId)?.assetHandle;
    const bh = best ? maps.find((x) => x.itemId === best.items[0])?.assetHandle : undefined;
    if (best && (bestD < 1.2 || (ah !== undefined && ah === bh))) {
      best.items.push(m.itemId);
    } else {
      clusters.push({ id: `setup_${clusters.length + 1}`, items: [m.itemId], lines: [] });
    }
  }
  for (const c of clusters) c.lines = [`${c.id}: ${c.items.join(", ")}`];
  return clusters;
}
