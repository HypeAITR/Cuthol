// CLI argument parsing: known/boolean flag lexicon, typo suggestions, typed flag readers (split out of cli.ts).
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import { parseTimeMs } from "./core/time.js";

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
  "all",
  "refresh",
  "force",
  // cuthol live
  "global",
  "no-window",
]);

export const KNOWN_CLI_FLAGS = new Set([
  ...BOOLEAN_FLAGS,
  // cuthol live
  "port",
  "timeout",
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
  // spine grade flags.
  "brightness",
  "contrast",
  "saturation",
  "temperature",
  "lut",
  "fit",
  "edge",
  "filter",
  "fx",
  "rate",
  "ramp",
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
  "comp",
  "comp-dir",
  "composition-dir",
  "composition-audio",
  "dir-comp",
  "entry",
  "props",
  "mode",
  "scaffold",
  "preset",
  "cue",
  "cues",
  "elements",
  "frames",
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
  "overlay-res",
  "across",
  "query",
  "min",
  "max",
  "asr",
  "tts",
  "agent",
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
  // No `--no-*` negation pattern exists; disabling pitch preservation is an
  // explicit value, so point at it directly.
  if (unknownFlag === "no-preserve-pitch") {
    return `cuthol ${group}${action ? ` ${action}` : ""} --preserve-pitch false`;
  }
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
      `cuthol ${commandName.replace(".", " ")} --props '{"headline":"Headline"}'`
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
        `--${name} (missing value)`,
        "cli",
        `--${name} <value>`
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
        `--${name} (missing numeric value)`,
        "cli",
        `--${name} <number>`
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

const EXCISE_RANGES_SUGGEST = "separate ranges with commas: --ranges 2s..3s,6s..7s";

interface RestBudget {
  /** Trailing positionals after the group and action. */
  max: number;
  unbounded?: boolean;
  /** Flags that already fill the `rest[0]` slot. */
  occupiedBy?: string[];
  /** Boolean flags that fill that slot only when true. */
  occupiedWhenTrue?: string[];
  /** One further positional, only when `rest[0]` is this token and the flag is absent. */
  extraWhenFirstIs?: { token: string; unlessFlag: string };
  suggest?: string;
}

// Accepted trailing positionals. Commands not listed accept none.
const REST_BUDGETS: Record<string, RestBudget> = {
  "workspace.init": { max: 1 },
  "workspace.open": { max: 1 },
  "workspace.backdrop": { max: 1, occupiedBy: ["color"] },
  "workspace.journal": { max: 1, extraWhenFirstIs: { token: "tag", unlessFlag: "name" } },
  "workspace.changes": { max: 1 },

  "library.ingest": { max: 0, unbounded: true },
  "library.loudness": { max: 1, occupiedBy: ["handle"] },
  "library.waveform": { max: 1, occupiedBy: ["handle"] },
  "library.beats": { max: 1, occupiedBy: ["handle"] },
  "library.scenes": { max: 1, occupiedBy: ["handle"] },
  "library.detach-audio": { max: 1, occupiedBy: ["handle"] },
  "library.query": { max: 1, occupiedBy: ["handle"] },
  "library.subject": { max: 1, occupiedBy: ["handle"] },
  "library.search": { max: 0 },
  "library.fetch": { max: 0 },

  "spine.append": { max: 1, occupiedBy: ["asset"] },
  "spine.split": { max: 1, occupiedBy: ["clip"] },
  "spine.trim": { max: 1, occupiedBy: ["clip"] },
  "spine.excise": { max: 1, occupiedBy: ["clip"], suggest: EXCISE_RANGES_SUGGEST },
  "spine.remove": { max: 1, occupiedBy: ["clips", "clip"] },
  "spine.reorder": { max: 1, occupiedBy: ["clip"] },
  "spine.transform": { max: 1, occupiedBy: ["clip"] },
  "spine.speed": { max: 1, occupiedBy: ["clip"] },
  "spine.transition": { max: 1, occupiedBy: ["clip"] },
  "spine.grade": { max: 1, occupiedBy: ["clip"] },
  "spine.fx": { max: 1 },
  "spine.envelope": { max: 1, occupiedBy: ["clip", "id"] },
  "spine.reframe": { max: 1, occupiedBy: ["clips", "clip"], occupiedWhenTrue: ["all-spine"] },
  "spine.mute": { max: 1, occupiedBy: ["clips", "clip"], occupiedWhenTrue: ["all-spine"] },
  "spine.unmute": { max: 1, occupiedBy: ["clips", "clip"], occupiedWhenTrue: ["all-spine"] },

  "lane.lock": { max: 1, occupiedBy: ["lane"] },
  "lane.unlock": { max: 1, occupiedBy: ["lane"] },
  "lane.add-composition": { max: 1, occupiedBy: ["comp-dir", "composition-dir", "dir-comp"] },
  "lane.update-cue": { max: 1, occupiedBy: ["cue", "id"] },
  "lane.excise": { max: 1, occupiedBy: ["cue", "id", "clip"], suggest: EXCISE_RANGES_SUGGEST },
  "lane.remove-cue": { max: 1, occupiedBy: ["cues", "cue"] },

  "composition.scaffold": { max: 1, occupiedBy: ["comp-dir", "composition-dir"] },
  "composition.preview": { max: 1, occupiedBy: ["cue", "id"] },
  "composition.check": { max: 1, occupiedBy: ["cue", "id"] },

  "cue.export": { max: 1, occupiedBy: ["file"] },
  "cue.diff": { max: 1, occupiedBy: ["file"] },
  "cue.plan": { max: 1, occupiedBy: ["file"] },
  "cue.apply": { max: 1, occupiedBy: ["file"] },

  "speech.transcribe": { max: 1, occupiedBy: ["handle"] },
  "speech.synthesize": { max: 1, occupiedBy: ["text"] },
  "speech.cleanup": { max: 1, occupiedBy: ["clip", "cue", "cues"] },
  "speech.verify-cleanup": { max: 1, occupiedBy: ["clip", "clips"], occupiedWhenTrue: ["all-spine"] },
  "speech.providers": { max: 0 },

  "mix.polish-voice": { max: 1, occupiedBy: ["clips", "clip"] },
  "mix.beat-align": { max: 1, occupiedBy: ["bgm-handle"] },

  "settings": { max: 0 },
  "settings.list": { max: 0 },
  "settings.get": { max: 1 },
  "settings.set": { max: 2 },
  "settings.reset": { max: 1 },

  "monitor.frame": { max: 1, occupiedBy: ["at"] },

  "render.draft_480p": { max: 1, occupiedBy: ["out"] },
  "render.master_1080p": { max: 1, occupiedBy: ["out"] },

  "extension.create": { max: 1, occupiedBy: ["name"] },
  "extension.show": { max: 1, occupiedBy: ["name"] },
  "extension.enable": { max: 1, occupiedBy: ["name"] },
  "extension.disable": { max: 1, occupiedBy: ["name"] },
  "extension.promote": { max: 1, occupiedBy: ["name"] },
  "extension.remove": { max: 1, occupiedBy: ["name"] },
  "extension.run": { max: 1, occupiedBy: ["name"] },
};

function restBudgetFor(group: string, action: string | undefined): RestBudget {
  if (action) {
    const specific = REST_BUDGETS[`${group}.${action}`];
    if (specific) return specific;
  }
  return REST_BUDGETS[group] ?? { max: 0 };
}

/** Reject positionals the command does not read, instead of dropping them. */
export function assertNoExtraPositionals(
  group: string,
  action: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>
): void {
  const spec = restBudgetFor(group, action);
  if (spec.unbounded) return;
  let max = spec.max;
  const slotTaken =
    (spec.occupiedBy ?? []).some((name) => flags[name] !== undefined) ||
    (spec.occupiedWhenTrue ?? []).some((name) => boolFlag(flags, name) === true);
  if (slotTaken) max = Math.max(0, max - 1);
  const extraSlot = spec.extraWhenFirstIs;
  if (extraSlot && rest[0] === extraSlot.token && flags[extraSlot.unlessFlag] === undefined) {
    max += 1;
  }
  if (rest.length <= max) return;
  const extra = rest.slice(max).join(" ");
  const command = `${group}${action ? `.${action}` : ""}`;
  const suggest = spec.suggest ?? `cuthol ${group}${action ? ` ${action}` : ""}`;
  throw new CutholError(DIAGNOSTICS.UNKNOWN_FLAG(extra, command, suggest));
}

/** Split `a..b,c..d` into millisecond ranges. A piece without `..` names itself in the error. */
export function parseExciseRanges(rangesRaw: string): Array<{ start_ms: number; end_ms: number }> {
  return rangesRaw.split(",").map((raw) => {
    const piece = raw.trim();
    const sep = piece.indexOf("..");
    const hasOneSeparator = sep > 0 && piece.indexOf("..", sep + 2) === -1 && !piece.endsWith("..");
    const start = hasOneSeparator ? piece.slice(0, sep).trim() : "";
    const end = hasOneSeparator ? piece.slice(sep + 2).trim() : "";
    if (!piece || !hasOneSeparator || !start || !end) {
      throw new CutholError(DIAGNOSTICS.INVALID_EXCISE_RANGE(piece || raw.trim() || rangesRaw));
    }
    try {
      return { start_ms: parseTimeMs(start), end_ms: parseTimeMs(end) };
    } catch (err) {
      if (err instanceof CutholError && err.diagnostic.code === "CUTHOL-SYS02") {
        throw new CutholError(DIAGNOSTICS.INVALID_EXCISE_RANGE(piece));
      }
      throw err;
    }
  });
}
