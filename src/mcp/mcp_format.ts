// Turns CLI envelopes into short MCP text results: hints, diagnostics, compact tables (split out of server.ts).
import fs from "node:fs";
import path from "node:path";
import { CUTHOL_PROGRESS_PREFIX } from "../core/progress.js";
import {
  ActionSpec, findActionSpec,
  TOOL_SPECS
} from "./catalog.js";

const MAX_PAYLOAD_CHARS = 12_000;

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

export function readWorkspaceRevision(dir: string): number | null {
  try {
    const seq = JSON.parse(fs.readFileSync(path.join(dir, "cuthol.sequence.json"), "utf8")) as { meta?: { revision?: number } };
    return typeof seq.meta?.revision === "number" ? seq.meta.revision : null;
  } catch {
    return null;
  }
}

export const readRevision = readWorkspaceRevision;

export function tryParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Drops render progress lines so a stderr error envelope still parses. */
export function stripCutholProgress(stderr: string): { text: string; lastLine: string | null } {
  const kept: string[] = [];
  let lastLine: string | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    if (line.trim().startsWith(CUTHOL_PROGRESS_PREFIX)) lastLine = line.trim();
    else kept.push(line);
  }
  return { text: kept.join("\n"), lastLine };
}

export function findValuesByKey(node: unknown, key: string, found: string[] = []): string[] {
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

function cleanupCallTarget(env: Record<string, unknown>, values: Record<string, unknown>): string {
  const cueId = typeof env.cue_id === "string" ? env.cue_id : "";
  if (cueId.includes(",")) return `cues=${cueId}`;
  if (cueId) return `cue=${cueId}`;
  return `clip=${String(env.clip_id ?? values.clip ?? "sp_01")}`;
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
  const distantRepetitions = Array.isArray(env.distant_repetition_candidates)
    ? (env.distant_repetition_candidates as Array<Record<string, unknown>>)
    : [];
  const preservedUntranscribed = Array.isArray(env.preserved_untranscribed)
    ? (env.preserved_untranscribed as Array<Record<string, unknown>>)
    : [];
  const tailCandidates = Array.isArray(env.tail_without_audio_candidates)
    ? (env.tail_without_audio_candidates as Array<Record<string, unknown>>)
    : [];
  const decisions = Array.isArray(trace?.decisions) ? trace!.decisions! : [];
  if (
    decisions.length === 0 &&
    cuts.length === 0 &&
    reviewCandidates.length === 0 &&
    repetitionCandidates.length === 0 &&
    distantRepetitions.length === 0 &&
    preservedUntranscribed.length === 0 &&
    tailCandidates.length === 0
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
      const reqStart = cut?.requested_source_start_ms ?? m.requested_source_start_ms;
      const reqEnd = cut?.requested_source_end_ms ?? m.requested_source_end_ms;
      const appliedStart = cut?.applied_source_start_ms ?? m.applied_source_start_ms;
      const appliedEnd = cut?.applied_source_end_ms ?? m.applied_source_end_ms;
      const edgeReason = cut?.edge_reason ?? m.edge_reason;
      const edgeInfo =
        reqStart !== undefined && reqEnd !== undefined
          ? `req=${reqStart}..${reqEnd}ms applied=${appliedStart ?? "?"}..${appliedEnd ?? "?"}ms${edgeReason ? ` edge=${String(edgeReason)}` : ""}`
          : null;
      const details = [`cut=${cutMs}ms`, origSpan, trimmedSpan, words, burstInfo, edgeInfo]
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
    const targetArg = cleanupCallTarget(env, values);
    outLines.push(
      `  … ${rows.length - nextOffset} more candidate(s); next page: speech(action=cleanup, ${targetArg}, dry_run=true, cursor="${nextOffset}", limit=${limit})`
    );
  }
  if (isDryRunOrVerbose && reviewCandidates.length > 0) {
    const targetArg = cleanupCallTarget(env, values);
    const firstCfId = String(reviewCandidates[0]?.id ?? "cf_01");
    outLines.push(
      `Review candidates (${reviewCandidates.length} contextual filler(s) — not cut automatically; pass cut_candidates=["${firstCfId}", ...] to speech(action=cleanup, ${targetArg}, ...) to cut chosen ones in one call):`
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
      outLines.push(formatRepetitionCandidateLine(rr));
    }
  }
  if (isDryRunOrVerbose && distantRepetitions.length > 0) {
    const firstRrId = String(distantRepetitions[0]?.id ?? "rr_01");
    outLines.push(
      `Distant repetition / restart candidates (${distantRepetitions.length} candidate(s), gap>8000ms — not cut automatically; pass cut_candidates=["${firstRrId}", ...] to cut chosen ones):`
    );
    for (const rr of distantRepetitions) {
      outLines.push(formatRepetitionCandidateLine(rr));
    }
  }
  if (preservedUntranscribed.length > 0) {
    const shown = preservedUntranscribed.slice(0, 10);
    const heading =
      preservedUntranscribed.length > shown.length
        ? `Preserved untranscribed audio (showing ${shown.length} of ${preservedUntranscribed.length}):`
        : `Preserved untranscribed audio (${preservedUntranscribed.length}):`;
    outLines.push(heading);
    for (const span of shown) {
      const near =
        span.near_candidate_id !== undefined && span.near_candidate_id !== null
          ? `, near=${String(span.near_candidate_id)}`
          : "";
      outLines.push(
        `  ${String(span.clip_id ?? "?")} ${String(span.source_start_ms)}..${String(span.source_end_ms)}ms (${String(span.duration_ms)}ms, max=${String(span.max_dbfs)}dBFS${near})`
      );
    }
  }
  if (isDryRunOrVerbose && tailCandidates.length > 0) {
    const firstTailId = String(tailCandidates[0]?.id ?? "ta_01");
    outLines.push(
      `Image-only tail candidates (${tailCandidates.length} [tail_without_audio] — not cut automatically; pass cut_candidates=["${firstTailId}", ...] to cut chosen ones):`
    );
    for (const tail of tailCandidates) {
      outLines.push(
        `  ${String(tail.id ?? "?")} [tail_without_audio] ${String(tail.clip_id ?? "?")} source=${String(tail.source_start_ms)}..${String(tail.source_end_ms)}ms (${String(tail.duration_ms)}ms)`
      );
    }
  }
  return outLines.join("\n");
}

function formatRepetitionCandidateLine(rr: Record<string, unknown>): string {
  const id = String(rr.id ?? "?");
  const kind = String(rr.kind ?? "phrase_repeat");
  const phrase = String(rr.matched_phrase ?? "");
  const cStart = rr.suggested_cut_start_ms ?? "?";
  const cEnd = rr.suggested_cut_end_ms ?? "?";
  const cDur = rr.suggested_cut_duration_ms ?? "?";
  const keepAtt = rr.suggested_keep_attempt ?? "?";
  const gap = typeof rr.gap_ms === "number" ? `, gap=${rr.gap_ms}ms` : "";
  const ctx = String(rr.context ?? "");
  return `  ${id} [${kind}] "${phrase}" suggested_cut=${cStart}..${cEnd}ms (${cDur}ms, keep=#${keepAtt}${gap}) · ${ctx}`;
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
  const isVerifyCleanup = spec.tool === "speech" && spec.action === "verify_cleanup";
  const isReframe = spec.tool === "spine" && spec.action === "reframe";
  for (const [k, v] of Object.entries(env)) {
    if (ENVELOPE_KEYS.has(k)) continue;
    if (spec.mutates && !detailed && MUTATION_ECHO_KEYS.has(k) && !(isReframe && k === "clips")) continue;
    if (
      isCleanup &&
      (k === "cuts" ||
        k === "review_candidates" ||
        k === "repetition_candidates" ||
        k === "distant_repetition_candidates" ||
        (!detailed && k === "clip_ids" && Array.isArray(v) && v.length > 8))
    ) {
      continue;
    }
    if (
      isVerifyCleanup &&
      (k === "missing_words" ||
        k === "repeated_phrases" ||
        k === "unexpected_words" ||
        k === "substituted_words")
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
    if (
      spec.tool === "render" &&
      k === "overlays" &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      const overlays = { ...(v as Record<string, unknown>) };
      if (!detailed && Array.isArray(overlays.rerendered)) {
        overlays.rerendered = (overlays.rerendered as unknown[]).slice(0, 5);
      }
      payload[k] = overlays;
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

function formatRenderChecks(env: Record<string, unknown>): string | null {
  const blank = env.blank_scan as { blank_frames_count?: number; total_frames?: number } | undefined;
  const audio = env.audio_health as {
    checked_points?: number;
    points?: unknown[];
    issues?: unknown[];
  } | undefined;
  if (!blank && !audio && typeof env.encoder !== "string") return null;
  const blankCount = typeof blank?.blank_frames_count === "number" ? blank.blank_frames_count : 0;
  const totalFrames = typeof blank?.total_frames === "number" ? blank.total_frames : 0;
  const points =
    typeof audio?.checked_points === "number"
      ? audio.checked_points
      : Array.isArray(audio?.points)
        ? audio.points.length
        : 0;
  const issueCount = Array.isArray(audio?.issues) ? audio.issues.length : 0;
  const audioText =
    issueCount > 0 ? `audio ${issueCount} issues (${points} points)` : `audio ok (${points} points)`;
  const encoder = typeof env.encoder === "string" && env.encoder ? env.encoder : "?";
  return `Checks: blank ${blankCount}/${totalFrames} · ${audioText} · encoder ${encoder}`;
}

function verifyMs(value: unknown): string {
  return typeof value === "number" ? String(value) : "?";
}

function formatVerifyCleanupSummary(env: Record<string, unknown>): string | null {
  if (typeof env.match_rate !== "number" && !Array.isArray(env.missing_words)) return null;
  const missing = Array.isArray(env.missing_words)
    ? (env.missing_words as Array<Record<string, unknown>>)
    : [];
  const repeated = Array.isArray(env.repeated_phrases)
    ? (env.repeated_phrases as Array<Record<string, unknown>>)
    : [];
  const unexpected = Array.isArray(env.unexpected_words)
    ? (env.unexpected_words as Array<Record<string, unknown>>)
    : [];
  const substituted = Array.isArray(env.substituted_words)
    ? (env.substituted_words as Array<Record<string, unknown>>)
    : [];
  const expected = typeof env.expected_word_count === "number" ? env.expected_word_count : 0;
  const matched = typeof env.matched_word_count === "number" ? env.matched_word_count : 0;
  const rate = typeof env.match_rate === "number" ? env.match_rate : 0;
  const lenient =
    typeof env.match_rate_lenient === "number" ? ` · lenient ${env.match_rate_lenient}` : "";
  const provider = typeof env.provider === "string" ? env.provider : "?";
  const cached = env.cached === true ? "cached" : "live";
  const lines = [
    `Verify cleanup: match ${matched}/${expected} (${rate})${lenient} · missing ${missing.length} · repeated ${repeated.length} · unexpected ${unexpected.length} · substituted ${substituted.length} · ${provider} · ${cached}`,
  ];
  const pushPage = (title: string, rows: string[], total: number): void => {
    if (total === 0) return;
    lines.push(`${title} (${total}${total > rows.length ? `, showing ${rows.length}` : ""}):`);
    lines.push(...rows);
    if (total > rows.length) lines.push(`  … ${total - rows.length} more`);
  };
  pushPage(
    "Missing words",
    missing.slice(0, 10).map((word) => {
      const cut = word.neighbor_cut_id ? ` cut=${String(word.neighbor_cut_id)}` : "";
      const clip = word.clip_id ? ` clip=${String(word.clip_id)}` : "";
      return `  ${String(word.word)} seq=${verifyMs(word.sequence_start_ms)}..${verifyMs(word.sequence_end_ms)}ms src=${verifyMs(word.source_start_ms)}..${verifyMs(word.source_end_ms)}ms${clip}${cut}`;
    }),
    missing.length
  );
  pushPage(
    "Repeated phrases",
    repeated.slice(0, 10).map((phrase) => {
      const repeats = Array.isArray(phrase.repeats)
        ? (phrase.repeats as Array<Record<string, unknown>>)
        : [];
      const times = repeats
        .map((span) => `${verifyMs(span.sequence_start_ms)}..${verifyMs(span.sequence_end_ms)}ms`)
        .join(" then ");
      const preserved = phrase.preserved_untranscribed as Record<string, unknown> | undefined;
      const link = preserved
        ? ` preserved=${String(preserved.clip_id)} src=${verifyMs(preserved.source_start_ms)}..${verifyMs(preserved.source_end_ms)}ms`
        : "";
      const n = typeof phrase.occurrences === "number" ? phrase.occurrences : repeats.length;
      return `  "${String(phrase.phrase)}" ×${n} ${times}${link}`;
    }),
    repeated.length
  );
  pushPage(
    "Unexpected words",
    unexpected.slice(0, 10).map((word) => {
      const frag = word.fragment_candidate === true ? ", fragment" : "";
      return `  ${String(word.word)} seq=${verifyMs(word.sequence_start_ms)}..${verifyMs(word.sequence_end_ms)}ms (${verifyMs(word.duration_ms)}ms${frag})`;
    }),
    unexpected.length
  );
  pushPage(
    "Substituted words",
    substituted.slice(0, 5).map((word) => {
      const sim = typeof word.similarity === "number" ? ` sim=${word.similarity}` : "";
      const clip = word.clip_id ? ` clip=${String(word.clip_id)}` : "";
      return `  ${String(word.expected)} → ${String(word.heard)}${sim} seq=${verifyMs(word.sequence_start_ms)}..${verifyMs(word.sequence_end_ms)}ms src=${verifyMs(word.source_start_ms)}..${verifyMs(word.source_end_ms)}ms${clip}`;
    }),
    substituted.length
  );
  return lines.join("\n");
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
  if (spec.tool === "speech" && spec.action === "verify_cleanup") {
    const summary = formatVerifyCleanupSummary(env);
    if (summary) lines.push(summary);
  }
  if (spec.tool === "spine" && spec.action === "reframe") {
    const reframeTable = formatReframeSummaryTable(env);
    if (reframeTable) lines.push(reframeTable);
  }

  if (ok && spec.tool === "render") {
    const checks = formatRenderChecks(env);
    if (checks) lines.push(checks);
  }

  const payload = compactPayload(env, spec, dryRun || values.verbose === true, values);
  if (payload) lines.push(`Result: ${payload}`);

  return { text: lines.join("\n"), isError: !ok };
}
