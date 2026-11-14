// Short CLI flag syntax for colour blocks -> a ColorStageSpec patch (pure, tested).
//
//   --wb 25[,0.1]                       white_balance {temp_mired, tint}
//   --exposure -0.4                     exposure {stops}
//   --tone contrast=0.2,shadows=-0.1    tone fields
//   --curve "master=0:0,0.25:0.18,1:1;r=0.5:0.55"
//   --wheel "lift=200,0.15[,luma];gain=30,0.05"   hue_deg, amount, luma
//   --hsl "hsl_01=center:25,width:30,shift:-6,sat:1.15[,soft:..,luma:..,satmin:..,satmax:..,lumamin:..,lumamax:..]"
//   --sat 1.1  --vibrance 0.3           saturation {saturation, vibrance}
//   --look look_01[:0.6]                look binding
//   --amount tone=0.5,hsl_01=0.8        block amounts (HSL by id)
//   --remove tone,hsl:hsl_01            blocks to drop
import type { ColorCurvePoint, ColorStageBlockName, ColorStageSpec, HslQualifierBlock } from "./types.js";
import { COLOR_STAGE_ORDER } from "./types.js";

export class ColorFlagError extends Error {}

const num = (raw: string, what: string): number => {
  const v = Number(raw.trim());
  if (raw.trim() === "" || !Number.isFinite(v)) throw new ColorFlagError(`${what}: '${raw}' is not a number`);
  return v;
};

const kv = (raw: string, what: string): Array<[string, string]> =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.search(/[=:]/);
      if (i <= 0) throw new ColorFlagError(`${what}: expected key=value, got '${pair}'`);
      return [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
    });

const TONE_KEYS = ["contrast", "pivot", "shadows", "highlights", "blacks", "whites"];
const HSL_KEYS: Record<string, keyof HslQualifierBlock> = {
  center: "hue_center_deg",
  width: "hue_width_deg",
  soft: "hue_soft_deg",
  shift: "hue_shift_deg",
  sat: "sat_scale",
  luma: "luma_shift",
  satmin: "sat_min",
  satmax: "sat_max",
  lumamin: "luma_min",
  lumamax: "luma_max",
};

export interface ColorFlagInput {
  wb?: string;
  exposure?: string;
  tone?: string;
  curve?: string;
  wheel?: string;
  hsl?: string;
  sat?: string;
  vibrance?: string;
  look?: string;
  amount?: string;
  remove?: string;
  /** JSON stage patch, merged first; flags override it. */
  patch?: string | Record<string, unknown>;
}

export interface ParsedColorFlags {
  patch: ColorStageSpec;
  remove: Array<ColorStageBlockName | `hsl:${string}`>;
}

export function parseColorFlags(f: ColorFlagInput, current?: ColorStageSpec): ParsedColorFlags {
  let patch: ColorStageSpec = {};
  if (f.patch !== undefined) {
    const obj = typeof f.patch === "string" ? safeJson(f.patch) : f.patch;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new ColorFlagError("--patch must be a JSON object");
    for (const k of Object.keys(obj)) {
      if (!(COLOR_STAGE_ORDER as readonly string[]).includes(k)) {
        throw new ColorFlagError(`--patch: unknown block '${k}' (blocks: ${COLOR_STAGE_ORDER.join(", ")})`);
      }
    }
    patch = obj as ColorStageSpec;
  }
  if (f.wb !== undefined) {
    const [m, t] = f.wb.split(",");
    patch.white_balance = { ...current?.white_balance, ...patch.white_balance, temp_mired: num(m, "--wb mired"), tint: t !== undefined ? num(t, "--wb tint") : (current?.white_balance?.tint ?? 0) };
  }
  if (f.exposure !== undefined) patch.exposure = { ...current?.exposure, stops: num(f.exposure, "--exposure") };
  if (f.tone !== undefined) {
    const t: Record<string, number> = { ...(current?.tone as Record<string, number> | undefined), ...(patch.tone as Record<string, number> | undefined) };
    for (const [k, v] of kv(f.tone, "--tone")) {
      if (!TONE_KEYS.includes(k)) throw new ColorFlagError(`--tone: unknown field '${k}' (${TONE_KEYS.join(", ")})`);
      t[k] = num(v, `--tone ${k}`);
    }
    patch.tone = t;
  }
  if (f.curve !== undefined) {
    const c: Record<string, ColorCurvePoint[]> = {};
    for (const part of f.curve.split(";").map((s) => s.trim()).filter(Boolean)) {
      const i = part.indexOf("=");
      const ch = i > 0 ? part.slice(0, i).trim() : "master";
      if (!["master", "r", "g", "b"].includes(ch)) throw new ColorFlagError(`--curve: channel '${ch}' (master, r, g, b)`);
      const pts = (i > 0 ? part.slice(i + 1) : part).split(",").map((p) => {
        const [x, y] = p.split(":");
        if (y === undefined) throw new ColorFlagError(`--curve: point '${p}' must be x:y`);
        return [num(x, "--curve x"), num(y, "--curve y")] as ColorCurvePoint;
      });
      c[ch] = pts;
    }
    patch.curves = { ...current?.curves, ...c };
  }
  if (f.wheel !== undefined) {
    const w: Record<string, unknown> = { ...(current?.wheels as Record<string, unknown> | undefined) };
    for (const part of f.wheel.split(";").map((s) => s.trim()).filter(Boolean)) {
      const i = part.indexOf("=");
      const name = part.slice(0, i).trim();
      if (i <= 0 || !["lift", "gamma", "gain", "offset"].includes(name)) throw new ColorFlagError(`--wheel: use lift|gamma|gain|offset=hue,amount[,luma]`);
      const [h, a, l] = part.slice(i + 1).split(",");
      w[name] = { hue_deg: num(h, "--wheel hue"), amount: num(a ?? "", "--wheel amount"), ...(l !== undefined ? { luma: num(l, "--wheel luma") } : {}) };
    }
    patch.wheels = w;
  }
  if (f.hsl !== undefined) {
    const list: HslQualifierBlock[] = [];
    for (const part of f.hsl.split(";").map((s) => s.trim()).filter(Boolean)) {
      const i = part.indexOf("=");
      if (i <= 0) throw new ColorFlagError(`--hsl: use <id>=center:25,width:30,shift:-6,sat:1.15`);
      const id = part.slice(0, i).trim();
      const prev = current?.hsl?.find((h) => h.id === id);
      const q: Record<string, unknown> = { ...(prev ?? { hue_center_deg: 0, hue_width_deg: 30 }), id };
      for (const [k, v] of kv(part.slice(i + 1), "--hsl")) {
        const field = HSL_KEYS[k];
        if (!field) throw new ColorFlagError(`--hsl: unknown field '${k}' (${Object.keys(HSL_KEYS).join(", ")})`);
        q[field] = num(v, `--hsl ${k}`);
      }
      list.push(q as unknown as HslQualifierBlock);
    }
    patch.hsl = list;
  }
  if (f.sat !== undefined || f.vibrance !== undefined) {
    patch.saturation = {
      ...current?.saturation,
      ...patch.saturation,
      ...(f.sat !== undefined ? { saturation: num(f.sat, "--sat") } : {}),
      ...(f.vibrance !== undefined ? { vibrance: num(f.vibrance, "--vibrance") } : {}),
    };
  }
  if (f.look !== undefined) {
    const [id, a] = f.look.split(":");
    if (!id.trim()) throw new ColorFlagError("--look: give a Look id");
    patch.look = { id: id.trim(), ...(a !== undefined ? { amount: num(a, "--look amount") } : {}) };
  }
  if (f.amount !== undefined) {
    for (const [k, v] of kv(f.amount, "--amount")) {
      const a = num(v, `--amount ${k}`);
      const hslHit = (patch.hsl ?? current?.hsl ?? []).find((h) => h.id === k);
      if (hslHit) {
        const list = patch.hsl ?? (current?.hsl ?? []).map((h) => ({ ...h }));
        const target = list.find((h) => h.id === k)!;
        target.amount = a;
        patch.hsl = list;
        continue;
      }
      if (!(COLOR_STAGE_ORDER as readonly string[]).includes(k) || k === "hsl") throw new ColorFlagError(`--amount: unknown block '${k}'`);
      const key = k as Exclude<ColorStageBlockName, "hsl">;
      const existing = ((patch as Record<string, unknown>)[key] ?? (current as Record<string, unknown> | undefined)?.[key]) as Record<string, unknown> | undefined;
      if (!existing) throw new ColorFlagError(`--amount: block '${k}' is not set on this item`);
      (patch as Record<string, unknown>)[key] = { ...existing, amount: a };
    }
  }
  const remove: ParsedColorFlags["remove"] = [];
  if (f.remove !== undefined) {
    for (const r of f.remove.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (r.startsWith("hsl:") || (COLOR_STAGE_ORDER as readonly string[]).includes(r)) remove.push(r as ColorStageBlockName);
      else throw new ColorFlagError(`--remove: unknown block '${r}'`);
    }
  }
  return { patch, remove };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    throw new ColorFlagError("--patch must be valid JSON");
  }
}

/** One-line description of a stage in block units (for agent output). */
export function describeStage(stage: ColorStageSpec | undefined): string {
  if (!stage || Object.keys(stage).length === 0) return "untouched";
  const parts: string[] = [];
  const f = (v: number | undefined, d = 2): string => (v === undefined ? "" : (v > 0 ? "+" : "") + Number(v.toFixed(d)));
  const am = (b: { amount?: number } | undefined): string => (b?.amount !== undefined && b.amount !== 1 ? `@${b.amount}` : "");
  const off = (b: { enabled?: boolean } | undefined): string => (b?.enabled === false ? "(off)" : "");
  if (stage.white_balance) parts.push(`wb ${f(stage.white_balance.temp_mired, 0)}mired tint ${f(stage.white_balance.tint)}${am(stage.white_balance)}${off(stage.white_balance)}`);
  if (stage.exposure) parts.push(`exp ${f(stage.exposure.stops)}${am(stage.exposure)}${off(stage.exposure)}`);
  if (stage.tone) {
    const t = Object.entries(stage.tone).filter(([k]) => TONE_KEYS.includes(k)).map(([k, v]) => `${k} ${f(v as number)}`);
    parts.push(`tone ${t.join(" ")}${am(stage.tone)}${off(stage.tone)}`);
  }
  if (stage.curves) parts.push(`curves ${Object.keys(stage.curves).filter((k) => ["master", "r", "g", "b"].includes(k)).join("/")}${am(stage.curves)}${off(stage.curves)}`);
  if (stage.wheels) {
    const w = (["lift", "gamma", "gain", "offset"] as const).filter((k) => stage.wheels![k]).map((k) => `${k} ${stage.wheels![k]!.hue_deg}°/${stage.wheels![k]!.amount}`);
    parts.push(`wheels ${w.join(" ")}${am(stage.wheels)}${off(stage.wheels)}`);
  }
  for (const q of stage.hsl ?? []) {
    parts.push(`hsl ${q.id} ${q.hue_center_deg}°±${q.hue_width_deg / 2} shift ${f(q.hue_shift_deg ?? 0, 0)} sat ×${q.sat_scale ?? 1}${q.luma_shift ? ` luma ${f(q.luma_shift)}` : ""}${am(q)}${off(q)}`);
  }
  if (stage.saturation) parts.push(`sat ×${stage.saturation.saturation ?? 1} vib ${f(stage.saturation.vibrance ?? 0)}${am(stage.saturation)}${off(stage.saturation)}`);
  if (stage.look) parts.push(`look ${stage.look.id}${stage.look.amount !== undefined ? `@${stage.look.amount}` : ""}`);
  return parts.join(" | ");
}

/** The `color set` flags that write `patch` (inverse of parseColorFlags for the common blocks). */
export function stageToFlags(patch: ColorStageSpec): string {
  const r = (v: number): string => String(Number(v.toFixed(3)));
  const q = (s: string): string => (/[\s;]/.test(s) ? `"${s}"` : s);
  const out: string[] = [];
  if (patch.white_balance) out.push(`--wb ${r(patch.white_balance.temp_mired ?? 0)},${r(patch.white_balance.tint ?? 0)}`);
  if (patch.exposure) out.push(`--exposure ${r(patch.exposure.stops ?? 0)}`);
  if (patch.tone) {
    const t = Object.entries(patch.tone).filter(([k, v]) => k !== "amount" && k !== "enabled" && typeof v === "number" && v !== 0);
    if (t.length) out.push(`--tone ${t.map(([k, v]) => `${k}=${r(v as number)}`).join(",")}`);
  }
  if (patch.curves) {
    const c = (["master", "r", "g", "b"] as const).filter((k) => patch.curves![k]?.length).map((k) => `${k}=${patch.curves![k]!.map(([x, y]) => `${r(x)}:${r(y)}`).join(",")}`);
    if (c.length) out.push(`--curve ${q(c.join(";"))}`);
  }
  if (patch.wheels) {
    const w = (["lift", "gamma", "gain", "offset"] as const).filter((k) => patch.wheels![k]).map((k) => {
      const v = patch.wheels![k]!;
      return `${k}=${r(v.hue_deg)},${r(v.amount)}${v.luma ? `,${r(v.luma)}` : ""}`;
    });
    if (w.length) out.push(`--wheel ${q(w.join(";"))}`);
  }
  if (patch.hsl?.length) {
    const inv = Object.fromEntries(Object.entries(HSL_KEYS).map(([k, v]) => [v, k]));
    out.push(`--hsl ${q(patch.hsl.map((h) => `${h.id}=${Object.entries(h).filter(([k, v]) => inv[k] && typeof v === "number").map(([k, v]) => `${inv[k]}:${r(v as number)}`).join(",")}`).join(";"))}`);
  }
  if (patch.saturation?.saturation !== undefined && patch.saturation.saturation !== 1) out.push(`--sat ${r(patch.saturation.saturation)}`);
  if (patch.saturation?.vibrance) out.push(`--vibrance ${r(patch.saturation.vibrance)}`);
  if (patch.look) out.push(`--look ${patch.look.id}${patch.look.amount !== undefined ? `:${r(patch.look.amount)}` : ""}`);
  return out.join(" ");
}
