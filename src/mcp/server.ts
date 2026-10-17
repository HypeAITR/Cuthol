/**
 * Cuthol MCP Server (`src/mcp/server.ts` — `cuthol mcp` / `cuthol-mcp`).
 *
 * A thin, stateless-per-call adapter over the `cuthol` CLI:
 * - Every tool call is validated against the declarative catalog (`./catalog.ts`) and executed as a
 *   CLI child process, so the CLI remains the single implementation of editing behaviour.
 * - Calls on the same project are serialized (the journal is not safe for concurrent writers).
 * - Long actions (render, monitor, preview, ASR/TTS) stream `notifications/progress` when the client
 *   sends a progress token and can be cancelled with `notifications/cancelled`.
 * - Results are compact text (status · state digest · change · undo preview · warnings · payload);
 *   monitor/preview PNGs are returned as inline images so the agent can actually look at the edit.
 * - The session remembers the project folder after `workspace.init` / `workspace.open`.
 * - A `guide` tool serves the skill manual for clients that cannot load skill files.
 */

import { ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  ACTION_SPECS,
  ActionSpec,
  actionsForTool,
  buildCliArgv,
  buildToolDefinition,
  closestName,
  findActionSpec,
  TOOL_SPECS,
  validateActionArgs,
  WORKSPACELESS_TOOLS,
} from "./catalog.js";
import { formatWorkspaceOpenSummary, loadSequence } from "../core/workspace.js";
import { resolveExtension } from "../extensions/manager.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT_DIR = path.resolve(MODULE_DIR, "../..");
const DEFAULT_CLI_PATH = path.resolve(MODULE_DIR, "../cli.js");
const SKILL_DIR = path.join(PACKAGE_ROOT_DIR, "skills", "cuthol");
const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const MAX_PAYLOAD_CHARS = 12_000;
const MAX_IMAGE_WIDTH = 1600;

export const GUIDE_TOPICS: Record<string, string> = {
  overview: "SKILL.md",
  editing: "references/editing.md",
  speech_mix: "references/speech-and-mix.md",
  compositions: "references/compositions.md",
  verify_monitor: "references/verify-and-monitor.md",
  extensions: "references/extensions.md",
  mcp: "references/mcp.md",
};

/** Tools visible before `discover_capabilities` when progressive disclosure is enabled. */
const PROGRESSIVE_CORE_TOOLS = new Set(["workspace", "library", "brief", "spine", "lane", "verify", "monitor", "guide"]);
const SPECIALIST_TOOLS = ["composition", "speech", "mix", "cue", "render", "extension"];

export const SERVER_INSTRUCTIONS = `Cuthol is a video editor you drive through tools. A project is a folder with cuthol.sequence.json.

Workflow:
1. workspace.init (new folder, set aspect/fps) or workspace.open (existing). The session then remembers the folder; pass dir only to switch projects.
2. library.ingest your media -> handles (vid_01, aud_01, img_01).
3. Build the primary storyline with spine.append/trim/split/excise/reframe (clips sp_01.. play back-to-back, edits ripple).
4. Put titles, captions, b-roll, music (ln_bgm), voiceover (ln_vo) and HyperFrames overlays (ln_motion) on lanes as cues (cue_01..). Anchor a cue to a clip (anchor=sp_XX) when it must follow edits.
5. Speech: speech.transcribe -> speech.cleanup (dry_run first) -> speech.captions. Mix: mix.normalize, mix.duck, mix.beat_align.
6. Look before you claim anything: monitor.frame / monitor.sheet return images; verify must show 0 errors; then render.

Rules:
- Times are '1500ms', '1.5s' or '00:01.500'. Lane x/y are % offsets from the centre of the stage.
- Every edit returns the new revision, what changed and what an undo would revert. Undo with expect_rev; use dry_run when unsure.
- Errors explain the fix ("Öneri"). Do not repeat an identical failing call; change the arguments.
- For your own animations: composition.scaffold preset=blank, write index.html (your file tools or composition.write) using window.__cuthol (C.word, C.beats, C.beatGrid, C.audio, C.cuts, C.drive, C.value), mount with lane.add_composition, then composition.preview. Read guide(topic='compositions') first.
- For reusable custom helpers, brand kits, media processors or multi-step recipes: use the extension tool (list/create/show/enable/disable/promote/remove/run) and read guide(topic='extensions') or guide(topic='ext:<name>').
- Read guide(topic=...) for details: overview, editing, speech_mix, compositions, verify_monitor, extensions, mcp.`;

export interface McpContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content: McpContent[];
  isError: boolean;
  /** Parsed CLI envelope (not sent over the wire unless `structuredOutput` is enabled). */
  envelope?: Record<string, unknown> | null;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface CutholMcpServerOptions {
  /** Project folder used when a call has no `dir` and no project was opened yet. */
  defaultDir?: string;
  /** Hide specialist tools until `discover_capabilities` (off by default). */
  progressive?: boolean;
  /** Also send `structuredContent` (full CLI envelope) in tool results. */
  structuredOutput?: boolean;
  cliPath?: string;
  onNotification?: (notif: JsonRpcNotification) => void;
}

interface CallContext {
  requestId?: string | number | null;
  progressToken?: string | number;
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  elapsedMs: number;
}

/** Normalizes common LLM argument quirks before validation. */
export function repairToolArguments(rawArgs: unknown): Record<string, unknown> {
  let obj: unknown = rawArgs;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj.replace(/\bNaN\b|-?\bInfinity\b/g, "null"));
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Record<string, unknown> = {};
  for (const [rawKey, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = rawKey.replace(/^-+/, "").replace(/-/g, "_");
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    out[key] = v;
  }
  const aliases: Record<string, string> = {
    project: "dir",
    workspace: "dir",
    workspace_dir: "dir",
    composition_dir: "comp_dir",
    dir_comp: "comp_dir",
    to_rev: "to",
    focal_points: "points",
    tolerance_ms: "tolerance",
    review_candidates: "cut_candidates",
    review_cuts: "cut_candidates",
    candidate_ids: "cut_candidates",
    include_candidates: "cut_candidates",
  };
  for (const [from, to] of Object.entries(aliases)) {
    if (out[from] !== undefined && out[to] === undefined) {
      out[to] = out[from];
    }
    if (from !== to) delete out[from];
  }
  if (typeof out.action === "string") out.action = out.action.trim().replace(/-/g, "_");
  return out;
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT_DIR, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function readWorkspaceRevision(dir: string): number | null {
  try {
    const seq = JSON.parse(fs.readFileSync(path.join(dir, "cuthol.sequence.json"), "utf8")) as { meta?: { revision?: number } };
    return typeof seq.meta?.revision === "number" ? seq.meta.revision : null;
  } catch {
    return null;
  }
}

const readRevision = readWorkspaceRevision;

function tryParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findValuesByKey(node: unknown, key: string, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) findValuesByKey(item, key, found);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === key && typeof v === "string") found.push(v);
      else findValuesByKey(v, key, found);
    }
  }
  return found;
}

interface DiagnosticLike {
  code?: string;
  severity?: string;
  what?: string;
  suggestion?: string;
  formatted?: string;
}

function collectDiagnostics(env: Record<string, unknown>): DiagnosticLike[] {
  const out: DiagnosticLike[] = [];
  const seen = new Set<string>();
  const push = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const d of list as DiagnosticLike[]) {
      const sig = `${d.code}|${d.what}`;
      if (!seen.has(sig)) {
        seen.add(sig);
        out.push(d);
      }
    }
  };
  push(env.diagnostics);
  const ver = env.verification as Record<string, unknown> | undefined;
  if (ver) push(ver.diagnostics);
  return out;
}

/** CLI-style suggestions ("cuthol brief --lens overview") translated to tool-call wording. */
export function translateCliHint(text: string): string {
  const flagToArg = (flags: string): string[] =>
    flags
      .trim()
      .split(/\s(?=--)/)
      .filter(Boolean)
      .map((f) => {
        const [k, ...rest] = f.replace(/^--/, "").split(/[ =]/);
        return rest.length ? `${k.replace(/-/g, "_")}=${rest.join(" ")}` : `${k.replace(/-/g, "_")}=true`;
      });
  const withCommands = text.replace(
    /'?cuthol ([a-z]+)(?: ([a-z][a-z-]*))?(?: (list|undo|redo|tag))?((?: --[a-z-]+(?:[ =](?!--)[^\s'|]+(?<!,))?)*)'?/g,
    (match: string, group: string, action: string | undefined, sub: string | undefined, flags: string) => {
      if (!TOOL_SPECS.some((t) => t.name === group)) return match;
      let act = action ? action.replace(/-/g, "_") : undefined;
      if (group === "workspace" && action === "journal") act = sub && sub !== "list" ? sub : "journal";
      const actionDef = act ? findActionSpec(group, act) : undefined;
      const args = flagToArg(flags ?? "");
      const parts = [actionDef?.action ? `action=${actionDef.action}` : act ? `action=${act}` : null, ...args];
      return `${group}(${parts.filter(Boolean).join(", ")})`;
    }
  );
  // Remaining standalone flags such as '--expect-rev 10'
  return withCommands.replace(/'?--([a-z][a-z-]*)(?:[ =]([^\s'|]+(?<!,)))?'?/g, (_m, k: string, v: string | undefined) =>
    v ? `${k.replace(/-/g, "_")}=${v}` : k.replace(/-/g, "_")
  );
}

const ENVELOPE_KEYS = new Set([
  "ok",
  "command",
  "schema_version",
  "state",
  "delta",
  "history",
  "action",
  "verification",
  "diagnostics",
  "diagnostic",
  "error",
]);

/** Keys of edit results that only repeat what the `Changed:` line already says. */
const MUTATION_ECHO_KEYS = new Set(["clip", "cue", "clips", "remaining_clips", "remainingClips", "remainingCues", "envelope", "revision", "sequence"]);
const HINT_KEYS = new Set(["query_hints", "hint", "hints", "suggestion", "next_step", "override_hint"]);

function translateHints(node: unknown, key?: string): unknown {
  if (typeof node === "string") return key && HINT_KEYS.has(key) ? translateCliHint(node) : node;
  if (Array.isArray(node)) return node.map((x) => translateHints(x, key));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = translateHints(v, k);
    return out;
  }
  return node;
}

function formatCleanupCandidatesTable(
  env: Record<string, unknown>,
  values: Record<string, unknown>
): string | null {
  const trace = env.decision_trace as
    | {
        summary?: {
          candidates?: number;
          accepted?: number;
          rejected?: number;
          by_reason?: Record<string, number>;
        };
        decisions?: Array<{
          id?: string;
          span?: [number, number];
          action?: string;
          reason_code?: string;
          measured?: Record<string, unknown>;
          refs?: string[];
          note?: string;
        }>;
      }
    | undefined;
  const cuts = Array.isArray(env.cuts)
    ? (env.cuts as Array<Record<string, unknown>>)
    : [];
  const reviewCandidates = Array.isArray(env.review_candidates)
    ? (env.review_candidates as Array<Record<string, unknown>>)
    : [];
  const repetitionCandidates = Array.isArray(env.repetition_candidates)
    ? (env.repetition_candidates as Array<Record<string, unknown>>)
    : [];
  const decisions = Array.isArray(trace?.decisions) ? trace!.decisions! : [];
  if (
    decisions.length === 0 &&
    cuts.length === 0 &&
    reviewCandidates.length === 0 &&
    repetitionCandidates.length === 0
  ) {
    return null;
  }

  const isDryRunOrVerbose = env.dry_run === true || values.dry_run === true || values.verbose === true;

  const rows: string[] = [];
  let appliedIdx = 0;

  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    const spanStr = Array.isArray(d.span) ? `${d.span[0]}..${d.span[1]}ms` : "?";
    const m = (d.measured ?? {}) as Record<string, unknown>;

    if (d.action === "applied") {
      const cut = cuts[appliedIdx++];
      const kind = String(cut?.kind ?? m.kind ?? "pause");
      const label = cut?.label ? ` ${String(cut.label)}` : "";
      const cutMs = cut?.cut_duration_ms ?? m.cut_ms ?? "?";
      const rawStart = cut?.raw_source_start_ms;
      const rawEnd = cut?.raw_source_end_ms;
      const origSpan = m.original_span ? `orig=${String(m.original_span)}ms` : null;
      const trimmedSpan = m.trimmed_span
        ? `gap=${String(m.trimmed_span)}ms`
        : m.silent_span
          ? `silent=${String(m.silent_span)}ms`
          : m.acoustic_silent_span
            ? `silent=${String(m.acoustic_silent_span)}ms`
            : rawStart !== undefined && rawEnd !== undefined
              ? `raw=${rawStart}..${rawEnd}ms`
              : null;
      const words = m.overlapping_words
        ? `words=${String(m.overlapping_words)}`
        : Array.isArray(d.refs) && d.refs.length
          ? `words=${d.refs.join(", ")}`
          : null;
      const burstInfo = m.untranscribed_audio_spans
        ? `kept_audio=${String(m.untranscribed_audio_spans)}`
        : null;
      const details = [`cut=${cutMs}ms`, origSpan, trimmedSpan, words, burstInfo]
        .filter(Boolean)
        .join(", ");
      rows.push(`  #${i + 1} [${d.reason_code ?? "APPLIED"}] ${kind}${label} ${spanStr} (${details})`);
    } else {
      const reason = d.reason_code ?? "REJECTED";
      const parts: string[] = [];
      if (m.trimmed_span !== undefined) {
        parts.push(`trimmed=${String(m.trimmed_span)}ms (${m.trimmed_gap_ms ?? "?"}ms)`);
      } else if (m.silent_span !== undefined) {
        parts.push(`silent=${String(m.silent_span)}ms (${m.acoustic_silent_ms ?? "?"}ms)`);
      } else if (m.acoustic_silent_ms !== undefined) {
        parts.push(`silent=${String(m.acoustic_silent_ms)}ms`);
      } else if (m.audio_ms !== undefined) {
        parts.push(`audio=${String(m.audio_ms)}ms`);
      } else if (m.gap_ms !== undefined) {
        parts.push(`gap=${String(m.gap_ms)}ms`);
      }
      if (m.max_dbfs !== undefined) parts.push(`max=${String(m.max_dbfs)}dBFS`);
      if (m.silence_floor_dbfs !== undefined) parts.push(`floor=${String(m.silence_floor_dbfs)}dBFS`);
      if (m.parent_pause_span !== undefined) parts.push(`in=${String(m.parent_pause_span)}ms`);
      if (m.overlapping_words) parts.push(`words=${String(m.overlapping_words)}`);
      else if (Array.isArray(d.refs) && d.refs.length) parts.push(`words=${d.refs.join(", ")}`);
      rows.push(
        `  #${i + 1} [REJECTED:${reason}] ${spanStr}${parts.length ? ` (${parts.join(", ")})` : ""}`
      );
    }
  }

  const rawCursor = values.cursor !== undefined ? parseInt(String(values.cursor), 10) : 0;
  const offset = Number.isFinite(rawCursor) && rawCursor > 0 ? rawCursor : 0;
  const defaultLimit = isDryRunOrVerbose ? 80 : 12;
  const rawLimit =
    typeof values.limit === "number" && Number.isFinite(values.limit) ? values.limit : defaultLimit;
  const limit = Math.max(1, Math.min(200, Math.floor(rawLimit)));
  const sliced = rows.slice(offset, offset + limit);
  const nextOffset = offset + sliced.length;
  const hasMore = nextOffset < rows.length;

  const byReason = trace?.summary?.by_reason
    ? Object.entries(trace.summary.by_reason)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    : "";
  const header = `Candidates (${rows.length > 0 ? `${offset + 1}..${nextOffset} of ${rows.length}` : "0"}${byReason ? ` · ${byReason}` : ""}):`;
  const outLines = [header, ...sliced];
  if (hasMore) {
    const clipArg = String(env.clip_id ?? values.clip ?? "sp_01");
    outLines.push(
      `  … ${rows.length - nextOffset} more candidate(s); next page: speech(action=cleanup, clip=${clipArg}, dry_run=true, cursor="${nextOffset}", limit=${limit})`
    );
  }
  if (isDryRunOrVerbose && reviewCandidates.length > 0) {
    const clipArg = String(env.clip_id ?? values.clip ?? "sp_01");
    const firstCfId = String(reviewCandidates[0]?.id ?? "cf_01");
    outLines.push(
      `Review candidates (${reviewCandidates.length} contextual filler(s) — not cut automatically; pass cut_candidates=["${firstCfId}", ...] to speech(action=cleanup, clip=${clipArg}, ...) to cut chosen ones in one call):`
    );
    for (const rc of reviewCandidates) {
      const id = String(rc.id ?? "?");
      const word = String(rc.punctuated_word ?? rc.word ?? "?");
      const sStart = rc.source_start_ms ?? "?";
      const sEnd = rc.source_end_ms ?? "?";
      const dur = rc.duration_ms ?? "?";
      const gapB = rc.gap_before_ms ?? 0;
      const gapA = rc.gap_after_ms ?? 0;
      const ctx = String(rc.context ?? "");
      outLines.push(
        `  ${id} "${word}" source=${sStart}..${sEnd}ms (${dur}ms, gaps=${gapB}ms/${gapA}ms) · "${ctx}"`
      );
    }
  }
  if (isDryRunOrVerbose && repetitionCandidates.length > 0) {
    const firstRrId = String(repetitionCandidates[0]?.id ?? "rr_01");
    outLines.push(
      `Repetition / restart candidates (${repetitionCandidates.length} candidate(s) — not cut automatically; pass cut_candidates=["${firstRrId}", "${firstRrId}:keep=1", ...] to cut chosen ones):`
    );
    for (const rr of repetitionCandidates) {
      const id = String(rr.id ?? "?");
      const kind = String(rr.kind ?? "phrase_repeat");
      const phrase = String(rr.matched_phrase ?? "");
      const cStart = rr.suggested_cut_start_ms ?? "?";
      const cEnd = rr.suggested_cut_end_ms ?? "?";
      const cDur = rr.suggested_cut_duration_ms ?? "?";
      const keepAtt = rr.suggested_keep_attempt ?? "?";
      const ctx = String(rr.context ?? "");
      outLines.push(
        `  ${id} [${kind}] "${phrase}" suggested_cut=${cStart}..${cEnd}ms (${cDur}ms, keep=#${keepAtt}) · ${ctx}`
      );
    }
  }
  return outLines.join("\n");
}

function summarizeReframeClipPlan(p: Record<string, unknown>): Record<string, unknown> {
  const focals = Array.isArray(p.focal_points)
    ? (p.focal_points as Array<Record<string, unknown>>)
    : [];
  let plateaus = 0;
  for (let i = 0; i < focals.length; i++) {
    const cx = Number(focals[i].center_x_pct ?? 50);
    const prevCx = i > 0 ? Number(focals[i - 1].center_x_pct ?? 50) : NaN;
    if (i === 0 || Math.abs(cx - prevCx) >= 0.05) plateaus++;
  }
  const xVals = focals.map((f) => Number(f.x_pct ?? 0)).filter(Number.isFinite);
  const cxVals = focals.map((f) => Number(f.center_x_pct ?? 50)).filter(Number.isFinite);
  const staticX = Number(p.static_x_pct ?? 0);
  const minX = xVals.length > 0 ? Number(Math.min(...xVals).toFixed(2)) : staticX;
  const maxX = xVals.length > 0 ? Number(Math.max(...xVals).toFixed(2)) : staticX;
  const minCx = cxVals.length > 0 ? Number(Math.min(...cxVals).toFixed(2)) : 50;
  const maxCx = cxVals.length > 0 ? Number(Math.max(...cxVals).toFixed(2)) : 50;
  const rawLowConf = Array.isArray(p.low_confidence_ranges_ms)
    ? (p.low_confidence_ranges_ms as Array<Record<string, unknown>>)
    : [];
  const lowConf = rawLowConf.slice(0, 3);

  return {
    clip_id: p.clip_id,
    asset_handle: p.asset_handle,
    mode: p.mode,
    detection_method: p.asset_handle ? p.detection_method : undefined,
    applied_pan: p.applied_pan,
    scale_x: p.scale_x,
    pan_x_pct_range: [minX, maxX],
    center_x_pct_range: [minCx, maxCx],
    subject_spread_x_pct: p.subject_spread_x_pct,
    plateaus,
    focal_points_count: focals.length,
    mean_confidence: p.mean_confidence,
    min_confidence: p.min_confidence,
    ...(rawLowConf.length > 0
      ? {
          low_confidence_count: rawLowConf.length,
          low_confidence_ranges_ms: lowConf,
        }
      : {}),
  };
}

function formatReframeSummaryTable(env: Record<string, unknown>): string | null {
  if (!Array.isArray(env.clips) || env.clips.length === 0) return null;
  const plans = env.clips as Array<Record<string, unknown>>;
  const mode = String(env.mode ?? "subject_track");
  const lines: string[] = [`Reframe summary (${plans.length} clip(s), mode=${mode}):`];

  for (const raw of plans) {
    const s = summarizeReframeClipPlan(raw);
    const [minX, maxX] = s.pan_x_pct_range as [number, number];
    const [minCx, maxCx] = s.center_x_pct_range as [number, number];
    const lowConf = Array.isArray(s.low_confidence_ranges_ms)
      ? (s.low_confidence_ranges_ms as Array<{ start_ms?: number; end_ms?: number; min_confidence?: number }>)
      : [];
    const lowConfCount =
      typeof s.low_confidence_count === "number" ? s.low_confidence_count : lowConf.length;
    const lowConfSuffix =
      lowConf.length > 0
        ? `, low_conf=${lowConf.map((r) => `${r.start_ms}..${r.end_ms}ms(${r.min_confidence})`).join(",")}${lowConfCount > lowConf.length ? `(+${lowConfCount - lowConf.length})` : ""}`
        : "";
    lines.push(
      `  ${String(s.clip_id)} (${String(s.asset_handle)}, ${String(s.detection_method)}): conf=${String(s.mean_confidence)} (min=${String(s.min_confidence)}${lowConfSuffix}), pan=${minX}%..${maxX}% (center_x=${minCx}%..${maxCx}%, spread=${String(s.subject_spread_x_pct)}%, scale_x=${String(s.scale_x)}), plateaus=${String(s.plateaus)} (${String(s.focal_points_count)} pts)`
    );
  }
  return lines.join("\n");
}

/**
 * Builds the `Result:` JSON. Edit results drop the echoed objects (the `Changed:` line covers them)
 * and keep only the summary of a decision trace unless the call was a dry run.
 */
function compactPayload(
  env: Record<string, unknown>,
  spec: ActionSpec,
  detailed: boolean,
  values: Record<string, unknown> = {}
): string | null {
  const payload: Record<string, unknown> = {};
  const isCleanup = spec.tool === "speech" && spec.action === "cleanup";
  const isReframe = spec.tool === "spine" && spec.action === "reframe";
  for (const [k, v] of Object.entries(env)) {
    if (ENVELOPE_KEYS.has(k)) continue;
    if (spec.mutates && !detailed && MUTATION_ECHO_KEYS.has(k) && !(isReframe && k === "clips")) continue;
    if (
      isCleanup &&
      (k === "cuts" ||
        k === "review_candidates" ||
        k === "repetition_candidates" ||
        (!detailed && k === "clip_ids" && Array.isArray(v) && v.length > 8))
    ) {
      continue;
    }
    if (
      spec.tool === "mix" &&
      spec.action === "normalize" &&
      k === "adjusted_clips" &&
      Array.isArray(v) &&
      !detailed
    ) {
      payload.adjusted_clips_count =
        typeof env.adjusted_clips_count === "number" ? env.adjusted_clips_count : v.length;
      payload[k] = v.slice(0, 8);
      if (v.length > 8) {
        payload.adjusted_clips_omitted = v.length - 8;
      }
      continue;
    }
    if (isReframe && k === "clips" && Array.isArray(v)) {
      payload.clips_count = v.length;
      if (values.verbose === true) {
        payload[k] = (v as Array<Record<string, unknown>>).map((p) => summarizeReframeClipPlan(p));
      }
      continue;
    }
    if (k === "ingested" && Array.isArray(v)) {
      payload[k] = (v as Array<Record<string, unknown>>).map((it) => {
        const probe = (it.probe ?? {}) as Record<string, unknown>;
        return {
          handle: it.handle,
          kind: it.kind,
          uri: it.uri,
          duration_ms: probe.duration_ms,
          ...(probe.has_video
            ? {
                size: `${probe.width}x${probe.height}@${probe.fps}`,
                ...(probe.is_vfr ? { is_vfr: true, r_frame_rate: probe.r_frame_rate } : {}),
              }
            : {}),
          has_audio: probe.has_audio,
        };
      });
      continue;
    }
    if (k === "decision_trace" && v && typeof v === "object") {
      const trace = v as Record<string, unknown>;
      if (isCleanup) {
        payload[k] = {
          summary: trace.summary,
          params: trace.params,
          ...(detailed ? { rules: trace.rules } : {}),
        };
        continue;
      }
      if (!detailed) {
        payload[k] = { summary: trace.summary, note: "full trace with dry_run=true" };
        continue;
      }
    }
    payload[k] = v;
  }
  if (Object.keys(payload).length === 0) return null;

  // Never slice a `library.query` page in the middle of JSON: trim `items` at item boundary if needed
  if (spec.tool === "library" && spec.action === "query" && Array.isArray(payload.items)) {
    const items = [...(payload.items as Array<Record<string, unknown>>)];
    const origReturned = items.length;
    const nextCursorFromCli =
      typeof payload.next_cursor === "string" && /^\d+$/.test(payload.next_cursor)
        ? parseInt(payload.next_cursor, 10)
        : null;
    const rawCursor =
      values.cursor !== undefined && /^\d+$/.test(String(values.cursor).trim())
        ? parseInt(String(values.cursor).trim(), 10)
        : 0;
    const pageOffset =
      nextCursorFromCli !== null ? Math.max(0, nextCursorFromCli - origReturned) : rawCursor;
    let translated = translateHints(payload) as Record<string, unknown>;
    let text = JSON.stringify(translated);
    if (text.length > MAX_PAYLOAD_CHARS && items.length > 1) {
      while (items.length > 1 && text.length > MAX_PAYLOAD_CHARS) {
        items.pop();
        const nextCursor = String(pageOffset + items.length);
        payload.items = items;
        payload.returned = items.length;
        payload.truncated = true;
        payload.truncated_by = "max_tokens";
        payload.next_cursor = nextCursor;
        payload.hint = `Sayfa MCP sınırına göre ${items.length} öğeye daraltıldı. Devamı için cursor="${nextCursor}" kullanın.`;
        translated = translateHints(payload) as Record<string, unknown>;
        text = JSON.stringify(translated);
      }
    }
    return text;
  }

  let text = JSON.stringify(translateHints(payload));
  if (text.length > MAX_PAYLOAD_CHARS) {
    text = `${text.slice(0, MAX_PAYLOAD_CHARS)}… [truncated ${text.length - MAX_PAYLOAD_CHARS} chars; use library.query or a narrower window]`;
  }
  return text;
}

export function resolveActionSpecForCommand(
  commandOrTool: string,
  explicitAction?: string | null,
  subAction?: string | null
): ActionSpec {
  const raw = (commandOrTool || "").trim();
  if (raw.startsWith("workspace.journal.")) {
    const sub = raw.split(".")[2] ?? "list";
    const act = sub === "list" ? "journal" : sub;
    const found = findActionSpec("workspace", act);
    if (found) return found;
  }
  const parts = raw.split(".");
  const tool = parts[0] || "cli";
  const rawAct =
    parts.length > 1
      ? parts.slice(1).join("_")
      : explicitAction
        ? explicitAction
        : null;
  let act = rawAct ? rawAct.replace(/-/g, "_") : null;
  if (tool === "workspace" && act === "journal") {
    act = subAction && subAction !== "list" ? subAction : "journal";
  }
  if (tool === "render" && (act === "draft_480p" || act === "master_1080p")) {
    act = null;
  }
  if (tool === "brief" && act) {
    act = null;
  }
  const found = findActionSpec(tool, act);
  if (found) return found;
  const single = findActionSpec(tool, null);
  if (single && !act) return single;
  return {
    tool,
    action: act,
    argv: [],
    summary: "",
    params: [],
    mutates: false,
  };
}

export interface FormatEnvelopeCompactOptions {
  envelope: Record<string, unknown>;
  spec?: ActionSpec | null;
  command?: string;
  dir?: string;
  values?: Record<string, unknown>;
  revisionBefore?: number | null;
  exitCode?: number | null;
}

/**
 * Shared compact text formatter used by both the MCP server (`CutholMcpServer`)
 * and the CLI (`--compact` / `--format text`).
 */
export function formatEnvelopeCompact(options: FormatEnvelopeCompactOptions): {
  text: string;
  isError: boolean;
} {
  const env = options.envelope;
  const spec =
    options.spec ??
    resolveActionSpecForCommand(String(options.command ?? env.command ?? "cli"));
  const dir = options.dir ?? process.cwd();
  const values = options.values ?? {};
  const revisionBefore = options.revisionBefore ?? null;
  const exitCode = options.exitCode ?? 0;

  const label = spec.action ? `${spec.tool}.${spec.action}` : spec.tool;
  const ok = env.ok !== false && exitCode === 0;
  const dryRun = env.dry_run === true || values.dry_run === true;
  const isJournalPreview =
    spec.tool === "workspace" && (spec.action === "undo" || spec.action === "redo");
  const lines: string[] = [];
  const state = env.state as Record<string, unknown> | undefined;
  if (dryRun && ok) {
    const nowRev = readRevision(dir);
    const stateSuffix = state?.state_digest
      ? isJournalPreview
        ? ` · would become: ${String(state.state_digest)}`
        : ` · current: ${String(state.state_digest)}`
      : "";
    lines.push(`DRY-RUN ${label} · nothing changed (still r${nowRev ?? "?"})${stateSuffix}`);
  } else {
    lines.push(`${ok ? "OK" : "FAILED"} ${label}${state?.state_digest ? ` · ${String(state.state_digest)}` : ""}`);
  }

  if (!ok) {
    const diag = env.diagnostic as DiagnosticLike | undefined;
    const err = env.error as { code?: string; message?: string; suggestion?: string } | string | undefined;
    if (diag) {
      lines.push(`[${diag.code}] ${diag.what}${diag.suggestion ? ` | Öneri: ${translateCliHint(diag.suggestion)}` : ""}`);
    } else if (typeof err === "string") {
      lines.push(translateCliHint(err));
    } else if (err) {
      lines.push(`[${err.code ?? "ERROR"}] ${err.message ?? ""}${err.suggestion ? ` | Öneri: ${translateCliHint(err.suggestion)}` : ""}`);
    } else if (Array.isArray(env.contract_findings) && env.contract_findings.length > 0) {
      for (const cf of (env.contract_findings as string[]).slice(0, 6)) {
        lines.push(`[CUTHOL-G105] ${cf}`);
      }
    }
  }

  // The CLI envelope always carries the journal head; only report it when this call advanced it
  // (or when `workspace.undo`/`redo` explicitly synthesized a dry-run preview delta).
  const revisionNow = typeof state?.revision === "number" ? (state.revision as number) : null;
  const advanced = revisionBefore === null || revisionNow === null || revisionNow !== revisionBefore;
  if (spec.mutates && ok && !dryRun && !advanced) {
    lines.push(`No change to the edit (still r${revisionNow}).`);
  }
  const delta = env.delta as { summary?: string } | undefined;
  if (dryRun && ok) {
    if (isJournalPreview && delta?.summary && delta.summary !== env.command) {
      lines.push(`Would change: ${delta.summary}`);
    } else if (spec.tool === "speech" && spec.action === "cleanup") {
      const cutsCount = typeof env.cuts_count === "number" ? env.cuts_count : 0;
      const savedSeq = typeof env.saved_sequence_ms === "number" ? env.saved_sequence_ms : 0;
      const savedSrc = typeof env.saved_source_ms === "number" ? env.saved_source_ms : 0;
      const targetClip = String(env.clip_id ?? values.clip ?? "sp_01");
      lines.push(
        `Would change: excise ${cutsCount} span(s) on ${targetClip} (save ${savedSeq}ms timeline / ${savedSrc}ms source)`
      );
    } else if (spec.tool === "spine" && spec.action === "reframe" && Array.isArray(env.clips)) {
      const plans = env.clips as Array<Record<string, unknown>>;
      const preview = plans
        .slice(0, 6)
        .map((p) => {
          const s = summarizeReframeClipPlan(p);
          const [minX, maxX] = s.pan_x_pct_range as [number, number];
          return `${String(s.clip_id)}(pan=${minX}%..${maxX}%, plateaus=${String(s.plateaus)}, conf=${String(s.mean_confidence)})`;
        })
        .join(", ");
      const more = plans.length > 6 ? ` (+${plans.length - 6} more)` : "";
      lines.push(`Would change: reframe ${preview}${more}`);
    } else if (spec.tool === "extension" && spec.action === "run" && env.kind === "planner") {
      const added = Array.isArray(env.cues_added) ? env.cues_added.length : 0;
      const updated = Array.isArray(env.cues_updated) ? env.cues_updated.length : 0;
      const removed = Array.isArray(env.cues_removed) ? env.cues_removed.length : 0;
      lines.push(
        `Would change: planner ${String(env.extension)}.${String(env.planner)} (+${added} cue(s), ~${updated} updated, -${removed} removed)`
      );
    }
  } else if (spec.mutates && advanced && delta?.summary && delta.summary !== env.command) {
    lines.push(`Changed: ${delta.summary}`);
  }
  const history = env.history as { undo_preview?: { revision?: number; inverse_summary?: string } | null } | undefined;
  if (spec.mutates && ok && !dryRun && advanced && history?.undo_preview?.inverse_summary) {
    lines.push(`Undo (expect_rev ${history.undo_preview.revision}): ${history.undo_preview.inverse_summary}`);
  }

  if (spec.tool === "mix" && spec.action === "normalize" && typeof env.achieved_lufs === "number") {
    const reached = env.target_reached === true;
    const beforeLufs =
      typeof env.measured_mix_before_lufs === "number" ? `${env.measured_mix_before_lufs} → ` : "";
    const masterGain =
      typeof env.master_gain_db === "number"
        ? ` · master_gain ${env.master_gain_db >= 0 ? "+" : ""}${env.master_gain_db} dB`
        : "";
    const skippedMuted =
      typeof env.skipped_muted_count === "number" && env.skipped_muted_count > 0
        ? ` · skipped_muted=${env.skipped_muted_count}`
        : "";
    lines.push(
      `Loudness: ${beforeLufs}${env.achieved_lufs} LUFS (target ${env.target_lufs} LUFS, true_peak ${env.achieved_true_peak_dbtp ?? "?"} / ${env.true_peak_dbtp ?? -1} dBTP${masterGain}) · target_reached=${reached}${skippedMuted}`
    );
    if (!reached && typeof env.warning === "string") {
      lines.push(`WARN [TARGET_NOT_REACHED] ${translateCliHint(env.warning)}`);
    }
  }
  if (spec.tool === "mix" && spec.action === "beat_align" && typeof env.duration_warning === "string") {
    lines.push(`WARN [DURATION_CHANGED] ${translateCliHint(env.duration_warning)}`);
  }

  const verification = env.verification as {
    ok?: boolean;
    error_count?: number;
    warning_count?: number;
    info_count?: number;
  } | undefined;
  if (verification && typeof verification.error_count === "number") {
    const infoSuffix =
      typeof verification.info_count === "number" && verification.info_count > 0
        ? `, ${verification.info_count} info`
        : "";
    lines.push(
      `Verify: ${verification.error_count} error(s), ${verification.warning_count ?? 0} warning(s)${infoSuffix}`
    );
  }
  const diags = collectDiagnostics(env);
  for (const d of diags.slice(0, 12)) {
    const sevLabel =
      d.severity === "ERROR" ? "ERROR" : d.severity === "INFO" ? "INFO" : "WARN";
    lines.push(
      `${sevLabel} [${d.code}] ${d.what}${d.suggestion ? ` | Öneri: ${translateCliHint(d.suggestion)}` : ""}`
    );
  }
  if (diags.length > 12) lines.push(`… ${diags.length - 12} more diagnostic(s); run verify.`);

  if (spec.tool === "speech" && spec.action === "cleanup") {
    const table = formatCleanupCandidatesTable(env, values);
    if (table) lines.push(table);
  }
  if (spec.tool === "spine" && spec.action === "reframe") {
    const reframeTable = formatReframeSummaryTable(env);
    if (reframeTable) lines.push(reframeTable);
  }

  const payload = compactPayload(env, spec, dryRun || values.verbose === true, values);
  if (payload) lines.push(`Result: ${payload}`);

  return { text: lines.join("\n"), isError: !ok };
}

export class CutholMcpServer {
  private readonly options: CutholMcpServerOptions;
  private readonly cliPath: string;
  private sessionDir: string | null;
  private readonly unlockedSpecialists = new Set<string>();
  private readonly lastKnownRevision = new Map<string, number>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly running = new Map<string, ChildProcess>();
  private lastFailedSignature: string | null = null;
  private consecutiveFailures = 0;
  public readonly sentNotifications: JsonRpcNotification[] = [];

  constructor(options: CutholMcpServerOptions = {}) {
    this.options = options;
    this.cliPath = options.cliPath ?? DEFAULT_CLI_PATH;
    this.sessionDir = options.defaultDir ? path.resolve(options.defaultDir) : null;
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    const notif: JsonRpcNotification = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
    this.sentNotifications.push(notif);
    this.options.onNotification?.(notif);
  }

  public getToolDefinitions(): Array<Record<string, unknown>> {
    const defs: Array<Record<string, unknown>> = TOOL_SPECS.filter(
      (t) => !this.options.progressive || PROGRESSIVE_CORE_TOOLS.has(t.name) || this.unlockedSpecialists.has(t.name)
    ).map((t) => buildToolDefinition(t));
    if (this.options.progressive && this.unlockedSpecialists.size < SPECIALIST_TOOLS.length) {
      defs.push({
        name: "discover_capabilities",
        title: "Unlock more tools",
        description: `Unlock specialist tools: ${SPECIALIST_TOOLS.join(", ")} (or 'all').`,
        inputSchema: {
          type: "object",
          properties: {
            groups: { type: "array", items: { type: "string", enum: [...SPECIALIST_TOOLS, "all"] } },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      });
    }
    return defs;
  }

  public async handleJsonRpcRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;
    const isNotification = req.id === undefined;
    try {
      switch (req.method) {
        case "initialize": {
          const requested = String((req.params as { protocolVersion?: unknown } | undefined)?.protocolVersion ?? "");
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
              serverInfo: { name: "cuthol", title: "Cuthol video editor", version: readPackageVersion() },
              capabilities: { tools: { listChanged: true } },
              instructions: SERVER_INSTRUCTIONS,
            },
          };
        }
        case "notifications/initialized":
          return null;
        case "notifications/cancelled": {
          const target = String((req.params as { requestId?: unknown } | undefined)?.requestId ?? "");
          this.running.get(target)?.kill();
          return null;
        }
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: this.getToolDefinitions() } };
        case "resources/list":
          return { jsonrpc: "2.0", id, result: { resources: [] } };
        case "prompts/list":
          return { jsonrpc: "2.0", id, result: { prompts: [] } };
        case "tools/call": {
          const params = (req.params ?? {}) as {
            name?: string;
            arguments?: unknown;
            _meta?: { progressToken?: string | number };
          };
          const result = await this.callTool(String(params.name ?? ""), params.arguments, {
            requestId: id,
            progressToken: params._meta?.progressToken,
          });
          const wire: Record<string, unknown> = { content: result.content, isError: result.isError };
          if (this.options.structuredOutput && result.envelope) wire.structuredContent = result.envelope;
          return { jsonrpc: "2.0", id, result: wire };
        }
        default:
          if (isNotification) return null;
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
      }
    } catch (err) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  private textResult(text: string, isError: boolean, envelope: Record<string, unknown> | null = null): McpToolResult {
    return { content: [{ type: "text", text }], isError, envelope };
  }

  /** Executes one tool call and returns an MCP tool result. Never throws. */
  public async callTool(toolName: string, rawArgs: unknown, ctx: CallContext = {}): Promise<McpToolResult> {
    const args = repairToolArguments(rawArgs);

    if (toolName === "discover_capabilities") {
      return this.discoverCapabilities(args);
    }

    const toolSpec = TOOL_SPECS.find((t) => t.name === toolName);
    if (!toolSpec) {
      const near = closestName(toolName, [...TOOL_SPECS.map((t) => t.name), "discover_capabilities"]);
      return this.textResult(
        `FAILED unknown tool '${toolName}'.${near ? ` Did you mean '${near}'?` : ""} Tools: ${TOOL_SPECS.map((t) => t.name).join(", ")}.`,
        true
      );
    }
    if (this.options.progressive && SPECIALIST_TOOLS.includes(toolName) && !this.unlockedSpecialists.has(toolName)) {
      this.unlockedSpecialists.add(toolName);
      this.notify("notifications/tools/list_changed");
    }

    const actions = actionsForTool(toolName);
    const singleAction = actions.length === 1 && actions[0].action === null;
    const actionName = singleAction ? null : typeof args.action === "string" ? args.action : null;
    const spec = findActionSpec(toolName, actionName);
    if (!spec) {
      const names = actions.map((a) => a.action as string);
      const near = actionName ? closestName(actionName, names) : null;
      return this.textResult(
        `FAILED ${toolName}: ${actionName ? `unknown action '${actionName}'.` : "missing 'action'."}${near ? ` Did you mean '${near}'?` : ""} Actions: ${names.join(", ")}.`,
        true
      );
    }

    const label = spec.action ? `${spec.tool}.${spec.action}` : spec.tool;
    const signature = `${label}:${JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]))}`;
    if (this.lastFailedSignature === signature && this.consecutiveFailures >= 2) {
      return this.textResult(
        `FAILED ${label}: this exact call already failed ${this.consecutiveFailures} times in a row and was not run again (CUTHOL-LOOP-GUARD). Read the previous error, check handles with brief, and change the arguments.`,
        true
      );
    }

    const { values, issues } = validateActionArgs(spec, args);
    if (issues.length) {
      return this.recordOutcome(
        signature,
        this.textResult(`FAILED ${label}: invalid arguments.\n${issues.map((i) => `- ${i.message}`).join("\n")}`, true)
      );
    }

    if (spec.tool === "guide") {
      const hintDir =
        typeof args.dir === "string" && args.dir.trim()
          ? path.resolve(args.dir.trim())
          : this.sessionDir;
      return this.recordOutcome(
        signature,
        this.readGuide(String(values.topic ?? "overview"), hintDir),
        false
      );
    }

    // Resolve the project folder.
    let workspaceDir: string | null = null;
    if (!WORKSPACELESS_TOOLS.has(spec.tool)) {
      if (typeof args.dir === "string" && args.dir.trim()) {
        workspaceDir = path.resolve(args.dir.trim());
      } else if (spec.tool === "workspace" && (spec.action === "init" || spec.action === "open")) {
        workspaceDir = null;
      } else if (this.sessionDir) {
        workspaceDir = this.sessionDir;
      } else if (fs.existsSync(path.join(process.cwd(), "cuthol.sequence.json"))) {
        workspaceDir = process.cwd();
      }
      const isWorkspacelessExtensionAction =
        spec.tool === "extension" &&
        (spec.action === "list" ||
          spec.action === "show" ||
          (spec.action === "create" && values.scope === "persistent") ||
          (spec.action === "remove" && values.scope === "persistent"));
      if (!workspaceDir && isWorkspacelessExtensionAction) {
        workspaceDir = process.cwd();
      }
      if (!workspaceDir) {
        return this.textResult(
          spec.action === "init"
            ? "FAILED workspace.init needs 'dir': the folder to create the project in."
            : spec.action === "open"
              ? "FAILED workspace.open needs 'dir': a folder that contains cuthol.sequence.json."
              : `FAILED ${label}: no project selected. Call workspace.init (new project) or workspace.open (existing) with 'dir', or pass 'dir' here.`,
          true
        );
      }
      if (
        !(spec.tool === "workspace" && spec.action === "init") &&
        !isWorkspacelessExtensionAction &&
        !fs.existsSync(path.join(workspaceDir, "cuthol.sequence.json"))
      ) {
        return this.textResult(
          `FAILED ${label}: '${workspaceDir}' is not a Cuthol project (no cuthol.sequence.json). Use workspace.init to create one.`,
          true
        );
      }
    }

    const dir = workspaceDir as string;
    const run = async (): Promise<McpToolResult> => {
      if (spec.tool === "workspace" && spec.action === "open") {
        this.sessionDir = dir;
        this.lastKnownRevision.set(dir, readRevision(dir) ?? 0);
        if (values.verbose === true) {
          const brief = await this.runCli(["brief", "--lens=overview", `--dir=${dir}`], dir, spec, ctx);
          return this.textResult(`OK workspace.open · session project is now ${dir}\n\n${brief.stdout.trim()}`, false);
        }
        const { sequence } = loadSequence(dir);
        const summary = formatWorkspaceOpenSummary(sequence, { verbose: false });
        return this.textResult(`OK workspace.open · session project is now ${dir}\n\n${summary}`, false);
      }

      if (spec.tool === "composition" && (spec.action === "write" || spec.action === "read")) {
        return this.compositionFile(spec.action, dir, values);
      }

      if (spec.tool === "lane" && spec.action === "add_composition" && !values.scaffold) {
        const compDir = path.resolve(dir, String(values.comp_dir));
        const entry = String(values.entry ?? "index.html");
        if (!fs.existsSync(path.join(compDir, entry))) {
          return this.textResult(
            `FAILED lane.add_composition: ${path.join(compDir, entry)} does not exist. Create it first with composition(action=scaffold, comp_dir=${String(values.comp_dir)}, preset=blank) and edit index.html, or pass scaffold=<preset>.`,
            true
          );
        }
      }

      const before = readRevision(dir);
      const known = this.lastKnownRevision.get(dir);
      const externalChange = known !== undefined && before !== null && before !== known;

      const argv = buildCliArgv(spec, values, dir);
      const res = await this.runCli(argv, dir, spec, ctx);
      const result = this.formatResult(spec, res, dir, values, before);

      const after = readRevision(dir);
      if (after !== null) this.lastKnownRevision.set(dir, after);
      if (spec.tool === "workspace" && spec.action === "init" && !result.isError) {
        this.sessionDir = dir;
      }
      if (externalChange && result.content[0]?.type === "text") {
        result.content[0].text = `NOTE the project changed outside this session (r${known} -> r${before}); re-read it with brief before relying on earlier results.\n${result.content[0].text}`;
      }
      return result;
    };

    const outcome = spec.mutates || spec.long ? await this.enqueue(dir, run) : await run();
    return this.recordOutcome(signature, outcome, spec.mutates);
  }

  /**
   * Loop guard bookkeeping. Successful read-only calls (brief, monitor …) between two identical
   * failures do not reset the counter: re-reading and then repeating the same failing call is still a loop.
   */
  private recordOutcome(signature: string, result: McpToolResult, resetsGuard = true): McpToolResult {
    if (!result.isError && !resetsGuard) return result;
    if (result.isError) {
      if (this.lastFailedSignature === signature) this.consecutiveFailures += 1;
      else {
        this.lastFailedSignature = signature;
        this.consecutiveFailures = 1;
      }
    } else {
      this.lastFailedSignature = null;
      this.consecutiveFailures = 0;
    }
    return result;
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    this.queues.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  }

  private discoverCapabilities(args: Record<string, unknown>): McpToolResult {
    const requested = Array.isArray(args.groups) ? (args.groups as string[]) : ["all"];
    const before = this.unlockedSpecialists.size;
    for (const g of requested) {
      if (g === "all") SPECIALIST_TOOLS.forEach((s) => this.unlockedSpecialists.add(s));
      else if (SPECIALIST_TOOLS.includes(g)) this.unlockedSpecialists.add(g);
    }
    const changed = this.unlockedSpecialists.size > before;
    if (changed) this.notify("notifications/tools/list_changed");
    return this.textResult(
      `OK discover_capabilities · unlocked: ${[...this.unlockedSpecialists].join(", ") || "(none)"}${changed ? " · tools/list_changed sent" : ""}`,
      false
    );
  }

  /** Reads or writes a text file strictly inside `<project>/<comp_dir>/`. */
  private compositionFile(mode: "write" | "read", dir: string, values: Record<string, unknown>): McpToolResult {
    const compDir = path.resolve(dir, String(values.comp_dir));
    const fileRel = String(values.file ?? "index.html");
    const target = path.resolve(compDir, fileRel);
    const inside = (parent: string, child: string): boolean => {
      const rel = path.relative(parent, child);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    };
    if (!inside(dir, compDir) || !inside(compDir, target)) {
      return this.textResult(`FAILED composition.${mode}: '${fileRel}' must stay inside the project's composition folder.`, true);
    }
    if (!/\.(html|css|js|json|svg)$/i.test(target)) {
      return this.textResult(`FAILED composition.${mode}: only .html, .css, .js, .json and .svg files are allowed.`, true);
    }
    if (mode === "read") {
      if (!fs.existsSync(target)) {
        return this.textResult(`FAILED composition.read: ${target} does not exist.`, true);
      }
      return this.textResult(fs.readFileSync(target, "utf8"), false);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content = String(values.content);
    fs.writeFileSync(target, content, "utf8");
    const hints: string[] = [];
    if (/index\.html$/i.test(target)) {
      if (!/data-composition-id=/.test(content)) hints.push("missing data-composition-id on the root element");
      if (!/window\.__timelines\[/.test(content)) hints.push("timeline is not registered in window.__timelines");
      if (!/paused\s*:\s*true/.test(content)) hints.push("timeline should be created with { paused: true }");
      if (/https?:\/\//.test(content)) hints.push("remote URLs will not load during render; put files in assets/");
    }
    return this.textResult(
      `OK composition.write · ${content.length} chars → ${target}` +
        (hints.length ? `\nWARN ${hints.join("; ")}` : "") +
        "\nNext: lane.add_composition (first time) or composition.preview to look at it.",
      false
    );
  }

  private readGuide(topic: string, workspaceDir?: string | null): McpToolResult {
    const trimmed = (topic || "overview").trim();
    if (/^ext:/i.test(trimmed)) {
      const extName = trimmed.slice(4).trim();
      try {
        const ext = resolveExtension(extName, workspaceDir);
        const guideRel = ext.guideRelPath ?? "README.md";
        const guideFile = path.join(ext.dir, guideRel);
        if (!fs.existsSync(guideFile)) {
          return this.textResult(
            `FAILED guide: extension '${ext.name}' does not have a guide file ('${guideRel}') in ${ext.dir}.`,
            true
          );
        }
        const text = fs.readFileSync(guideFile, "utf8").replace(/^---[\s\S]*?---\s*/, "");
        return this.textResult(text, false);
      } catch (err) {
        return this.textResult(
          `FAILED guide: ${err instanceof Error ? err.message : String(err)}`,
          true
        );
      }
    }
    const rel = GUIDE_TOPICS[trimmed];
    const file = rel ? path.join(SKILL_DIR, rel) : null;
    if (!file || !fs.existsSync(file)) {
      return this.textResult(
        `FAILED guide: topic '${trimmed}' not available. Topics: ${Object.keys(GUIDE_TOPICS).join(", ")}, or ext:<name>.`,
        true
      );
    }
    const text = fs.readFileSync(file, "utf8").replace(/^---[\s\S]*?---\s*/, "");
    return this.textResult(text, false);
  }

  private runCli(argv: string[], cwd: string, spec: ActionSpec, ctx: CallContext): Promise<CliRun> {
    const timeoutMs = Number(process.env.CUTHOL_MCP_TIMEOUT_MS) || (spec.long ? 30 * 60_000 : 10 * 60_000);
    return new Promise((resolve) => {
      const started = Date.now();
      fs.mkdirSync(cwd, { recursive: true });
      const child = spawn(process.execPath, [this.cliPath, ...argv], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const key = ctx.requestId !== undefined && ctx.requestId !== null ? String(ctx.requestId) : null;
      if (key) this.running.set(key, child);

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));

      let tick = 0;
      const progressTimer =
        ctx.progressToken !== undefined
          ? setInterval(() => {
              tick += 1;
              this.notify("notifications/progress", {
                progressToken: ctx.progressToken,
                progress: tick,
                message: `${spec.action ? `${spec.tool}.${spec.action}` : spec.tool} running · ${Math.round((Date.now() - started) / 1000)}s`,
              });
            }, 3000)
          : null;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.on("exit", (_code, signal) => {
        if (signal && !timedOut) cancelled = true;
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (progressTimer) clearInterval(progressTimer);
        if (key) this.running.delete(key);
        resolve({ code, stdout, stderr, timedOut, cancelled, elapsedMs: Date.now() - started });
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        if (progressTimer) clearInterval(progressTimer);
        if (key) this.running.delete(key);
        resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut, cancelled, elapsedMs: Date.now() - started });
      });
    });
  }

  private formatResult(
    spec: ActionSpec,
    run: CliRun,
    dir: string,
    values: Record<string, unknown> = {},
    revisionBefore: number | null = null
  ): McpToolResult {
    const label = spec.action ? `${spec.tool}.${spec.action}` : spec.tool;
    if (run.timedOut || run.cancelled) {
      return this.textResult(
        `FAILED ${label}: ${run.timedOut ? `timed out after ${Math.round(run.elapsedMs / 1000)}s` : "cancelled"}. The edit itself was not committed unless a later brief shows a new revision.`,
        true
      );
    }

    if (spec.textOutput && run.code === 0) {
      return this.textResult(run.stdout.trim(), false);
    }

    const env = tryParseJson(run.stdout) ?? tryParseJson(run.stderr);
    if (!env) {
      const raw = (run.stderr || run.stdout).trim().slice(-1500);
      return this.textResult(`FAILED ${label} (exit ${run.code}): ${raw || "no output"}`, true);
    }

    const { text, isError } = formatEnvelopeCompact({
      envelope: env,
      spec,
      dir,
      values,
      revisionBefore,
      exitCode: run.code,
    });

    const content: McpContent[] = [{ type: "text", text }];
    if (spec.imageKeys?.length) {
      for (const key of spec.imageKeys) {
        for (const p of findValuesByKey(env, key)) {
          const abs = path.isAbsolute(p) ? p : path.resolve(dir, p);
          const img = this.loadImage(abs);
          if (img) content.push(img);
        }
      }
    }
    return { content, isError, envelope: env };
  }

  /** Downscales a PNG to a JPEG preview (keeps tokens bounded) and returns it as MCP image content. */
  private loadImage(pngPath: string): McpContent | null {
    if (!fs.existsSync(pngPath)) return null;
    const preview = pngPath.replace(/\.png$/i, "") + ".mcp.jpg";
    const proc = spawnSync(
      "ffmpeg",
      ["-v", "error", "-y", "-i", pngPath, "-vf", `scale='min(${MAX_IMAGE_WIDTH},iw)':-2`, "-q:v", "4", preview],
      { timeout: 30_000, windowsHide: true }
    );
    if (proc.status === 0 && fs.existsSync(preview)) {
      return { type: "image", data: fs.readFileSync(preview).toString("base64"), mimeType: "image/jpeg" };
    }
    const size = fs.statSync(pngPath).size;
    if (size < 4 * 1024 * 1024) {
      return { type: "image", data: fs.readFileSync(pngPath).toString("base64"), mimeType: "image/png" };
    }
    return null;
  }
}

/** Tool definitions as advertised over MCP (also used by `cuthol help --json`). */
export const CUTHOL_MCP_TOOLS = TOOL_SPECS.map((t) => buildToolDefinition(t));

/** All catalogued actions (for documentation and tests). */
export const CUTHOL_MCP_ACTIONS = ACTION_SPECS;

export function startMcpStdioServer(options: Omit<CutholMcpServerOptions, "onNotification"> = {}): void {
  const write = (msg: unknown): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const server = new CutholMcpServer({
    progressive: process.env.CUTHOL_MCP_PROGRESSIVE === "1",
    structuredOutput: process.env.CUTHOL_MCP_STRUCTURED === "1",
    defaultDir: options.defaultDir ?? process.env.CUTHOL_WORKSPACE,
    ...options,
    onNotification: write,
  });
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch (err) {
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `Parse error: ${err instanceof Error ? err.message : String(err)}` },
      });
      return;
    }
    void server.handleJsonRpcRequest(req).then((res) => {
      if (res && req.id !== undefined) write(res);
    });
  });
}
