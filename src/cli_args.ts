// CLI argument parsing: known/boolean flag lexicon, typo suggestions, typed flag readers (split out of cli.ts).
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  "help",
  "json",
  "compact",
  "verbose",
  "full-bins",
  "sequence-time",
  "source-time",
  "cascade-cues",
  "preserve-pitch",
  "mirror-x",
  "mirror-y",
  "transparent",
  "remove-pauses",
  "remove-fillers",
  "remove-repetitions",
  "dry-run",
  "clarity",
  "boxes",
  "all-spine",
  "replace",
  "include-empty",
  "preserve-duration",
  "network",
  "overwrite",
  "muted",
  "ripple",
]);

export const KNOWN_CLI_FLAGS = new Set([
  ...BOOLEAN_FLAGS,
  "format",
  "dir",
  "project",
  "aspect",
  "fps",
  "title",
  "steps",
  "to",
  "expect-rev",
  "allow-protected",
  "name",
  "file",
  "handle",
  "target-lufs",
  "bins",
  "png",
  "sensitivity",
  "threshold",
  "target-handle",
  "kind",
  "range",
  "text",
  "limit",
  "cursor",
  "max-tokens",
  "asset",
  "in",
  "out",
  "id",
  "clip",
  "clips",
  "at",
  "ranges",
  "coord",
  "before",
  "after",
  "index",
  "x",
  "y",
  "scale",
  "scale-x",
  "scale-y",
  "rotation",
  "rotate",
  "opacity",
  "fit",
  "rate",
  "duration",
  "easing",
  "param",
  "points",
  "lane",
  "anchor",
  "offset",
  "size",
  "color",
  "max-width",
  "comp-dir",
  "composition-dir",
  "dir-comp",
  "entry",
  "props",
  "mode",
  "scaffold",
  "preset",
  "cue",
  "cues",
  "gain-db",
  "z-index",
  "gates",
  "lang",
  "provider",
  "voice",
  "model",
  "speed",
  "place-on-lane",
  "min-pause",
  "pad",
  "cut-candidates",
  "style",
  "max-words",
  "max-chars",
  "true-peak",
  "nr-db",
  "bgm-lane",
  "duck-db",
  "attack",
  "release",
  "bgm-handle",
  "tolerance",
  "tolerance-ms",
  "grid",
  "start",
  "end",
  "width",
  "lens",
  "window",
  "deadband",
  "focal-points",
  "scope",
  "template",
  "description",
  "version",
  "processor",
  "planner",
  "recipe",
  "input",
  "params",
  "topic",
  "workers",
  "encoder",
  "across",
]);

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export function suggestFlagFix(unknownFlag: string, group: string, action?: string): string {
  const aliasMap: Record<string, string> = {
    compdir: "comp-dir",
    composition: "comp-dir",
    rev: "expect-rev",
    revision: "expect-rev",
    "output-format": "json",
    from: "start",
    proj: "dir",
  };
  let best = aliasMap[unknownFlag];
  if (!best) {
    let bestDist = Infinity;
    for (const known of KNOWN_CLI_FLAGS) {
      const d = levenshtein(unknownFlag, known);
      if (d < bestDist) {
        bestDist = d;
        best = known;
      }
    }
  }
  return `cuthol ${group}${action ? ` ${action}` : ""} --${best ?? "help"}`;
}

export function parsePropsJsonFlag(raw: string, commandName: string): Record<string, unknown> {
  try {
    const cleaned = raw.replace(/\bNaN\b|\bInfinity\b|-Infinity\b/g, "null");
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to diagnostic error
  }
  throw new CutholError(
    DIAGNOSTICS.UNKNOWN_FLAG(
      `--props ${raw}`,
      commandName,
      `cuthol ${commandName.replace(".", " ")} --props '{"headline":"Başlık"}'`
    )
  );
}

export function parseArgv(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx > 0) {
        const key = token.slice(2, eqIdx);
        flags[key] = token.slice(eqIdx + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (BOOLEAN_FLAGS.has(key)) {
          if (next === "true" || next === "false" || next === "1" || next === "0") {
            flags[key] = next;
            i++;
          } else {
            flags[key] = true;
          }
        } else if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

export function strFlag(flags: Record<string, string | boolean>, name: string, fallback?: string): string | undefined {
  const val = flags[name];
  if (typeof val === "string") return val;
  if (val === true && name !== "scaffold" && !BOOLEAN_FLAGS.has(name)) {
    throw new CutholError(
      DIAGNOSTICS.UNKNOWN_FLAG(
        `--${name} (eksik değer / missing value)`,
        "cli",
        `--${name} <değer>`
      )
    );
  }
  return fallback;
}

export function numFlag(flags: Record<string, string | boolean>, name: string, fallback?: number): number | undefined {
  const val = flags[name];
  if (typeof val === "string") {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  if (val === true && !BOOLEAN_FLAGS.has(name)) {
    throw new CutholError(
      DIAGNOSTICS.UNKNOWN_FLAG(
        `--${name} (eksik sayısal değer / missing numeric value)`,
        "cli",
        `--${name} <sayı>`
      )
    );
  }
  return fallback;
}

export function boolFlag(flags: Record<string, string | boolean>, name: string, fallback?: boolean): boolean | undefined {
  const val = flags[name];
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    if (val === "true" || val === "1") return true;
    if (val === "false" || val === "0") return false;
  }
  return fallback;
}
