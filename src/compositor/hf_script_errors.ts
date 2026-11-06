// Composition page script-error records: shared cache, check-output parsing, and severity classification.
//
// Three producers run a composition page in a browser and record what the page threw or logged:
// coordinate measurement (every frame seek), `composition preview` (`hyperframes check --json`),
// and the lightweight monitor probe (page load plus a few timeline seeks). `verify` and `monitor`
// read these records back WITHOUT a browser: a record matches only the exact composition files
// it was measured against (same content hash), so fixing the script leaves the old record behind
// instead of reporting a stale error.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CutholDiagnostic, DIAGNOSTICS } from "../core/diagnostics.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import { renameWithRetrySync } from "./hf_common.js";

/** Where in the page run the error surfaced: page load, or a timeline seek after load. */
export type ScriptErrorPhase = "load" | "run";

/** `pageerror` (uncaught exception, including renderer `page_error` findings), `rejection` (unhandled promise rejection), `console` (console.error). */
export type ScriptErrorKind = "pageerror" | "rejection" | "console";

export interface CompositionScriptError {
  phase: ScriptErrorPhase;
  kind: ScriptErrorKind;
  /** Single-line error text, capped. */
  text: string;
  /** Page-relative file (`index.html`, `assets/app.js`) when known. */
  file?: string;
  /** 1-based line when known. */
  line?: number;
}

export interface CompositionScriptRecord {
  schema: "cuthol.script_errors/1";
  /** Composition files hash (bridge data excluded), as the overlay key uses it. */
  files_hash: string;
  entry_html: string;
  /** Measuring tool version tag (`hf:0.9.15`); part of the record key. */
  tool_tag: string;
  measured_at: string;
  source: "coords" | "preview" | "probe";
  /** False for `data-no-timeline` designs (a missing timeline is expected there). */
  timeline_expected: boolean;
  /** True when `window.__timelines[<composition-id>]` existed after load/seeks. */
  timeline_registered: boolean;
  /** Deduplicated by kind+text (location ignored), capped at 8 entries. */
  errors: CompositionScriptError[];
  severity: "ERROR" | "WARN" | "NONE";
}

/** Bumped when the record shape or classification changes; old records are ignored. */
export const SCRIPT_ERRORS_ENGINE = "2";

export const SCRIPT_ERROR_TEXT_MAX = 300;

export const SCRIPT_ERRORS_PER_RECORD_MAX = 8;

export function scriptErrorsDir(projectDir: string): string {
  return path.join(path.resolve(projectDir), ".cuthol", "script_errors");
}

/**
 * Record key: content hash plus entry file, so an edit invalidates the record.
 * `toolTag` (e.g. `hf:0.9.15`) binds the record to the measuring tool version, so a
 * renderer upgrade never reports another version's recording.
 */
export function computeScriptErrorKey(filesHash: string, entryHtml: string, toolTag: string): string {
  return crypto
    .createHash("sha256")
    .update(`cuthol.script_errors/1:${SCRIPT_ERRORS_ENGINE}:${toolTag}:${entryHtml}\n${filesHash}`)
    .digest("hex")
    .slice(0, 32);
}

function normalizeErrorText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, SCRIPT_ERROR_TEXT_MAX);
}

/** Dedupes by kind+text (first location wins) and caps the entry count. */
export function dedupeScriptErrors(errors: CompositionScriptError[]): CompositionScriptError[] {
  const seen = new Set<string>();
  const out: CompositionScriptError[] = [];
  for (const e of errors) {
    const text = normalizeErrorText(e.text);
    if (!text) continue;
    const key = `${e.kind}::${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ phase: e.phase, kind: e.kind, text, ...(e.file ? { file: e.file } : {}), ...(typeof e.line === "number" ? { line: e.line } : {}) });
    if (out.length >= SCRIPT_ERRORS_PER_RECORD_MAX) break;
  }
  return out;
}

/**
 * Severity rule: a thrown error (uncaught exception or rejected promise) with an expected
 * but missing timeline is ERROR (the overlay cannot render; render stops with CUTHOL-G503).
 * Anything else recorded (post-timeline throw, console message) is WARN. No errors is NONE.
 */
export function classifyScriptErrors(
  errors: CompositionScriptError[],
  timelineExpected: boolean,
  timelineRegistered: boolean
): "ERROR" | "WARN" | "NONE" {
  if (errors.length === 0) return "NONE";
  const thrown = errors.some((e) => e.kind === "pageerror" || e.kind === "rejection");
  if (thrown && timelineExpected && !timelineRegistered) return "ERROR";
  return "WARN";
}

export function buildScriptErrorRecord(params: {
  filesHash: string;
  entryHtml: string;
  toolTag: string;
  source: CompositionScriptRecord["source"];
  timelineExpected: boolean;
  timelineRegistered: boolean;
  errors: CompositionScriptError[];
}): CompositionScriptRecord {
  const errors = dedupeScriptErrors(params.errors);
  return {
    schema: "cuthol.script_errors/1",
    files_hash: params.filesHash,
    entry_html: params.entryHtml,
    tool_tag: params.toolTag,
    measured_at: new Date().toISOString(),
    source: params.source,
    timeline_expected: params.timelineExpected,
    timeline_registered: params.timelineRegistered,
    errors,
    severity: classifyScriptErrors(errors, params.timelineExpected, params.timelineRegistered),
  };
}

/** Atomic write (temp file + rename). Returns the absolute record path. */
export function writeScriptErrorRecord(
  projectDir: string,
  record: CompositionScriptRecord,
  toolTag: string
): string {
  const dir = scriptErrorsDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const key = computeScriptErrorKey(record.files_hash, record.entry_html, toolTag);
  const file = path.join(dir, `${key}.json`);
  const tmp = path.join(dir, `.tmp screrr_${process.pid}_${Date.now()}_${key}.json`);
  fs.writeFileSync(tmp, JSON.stringify(record), "utf8");
  try {
    renameWithRetrySync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
  return file;
}

/**
 * Reads the record for the CURRENT composition files (null on any miss or mismatch:
 * unknown is silent, never "clean"). Never throws for corrupt files.
 */
export function readScriptErrorRecord(
  projectDir: string,
  filesHash: string,
  entryHtml: string,
  toolTag: string
): CompositionScriptRecord | null {
  const file = path.join(scriptErrorsDir(projectDir), `${computeScriptErrorKey(filesHash, entryHtml, toolTag)}.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CompositionScriptRecord>;
    if (parsed.schema !== "cuthol.script_errors/1") return null;
    if (parsed.files_hash !== filesHash || parsed.entry_html !== entryHtml) return null;
    if (!Array.isArray(parsed.errors)) return null;
    if (parsed.severity !== "ERROR" && parsed.severity !== "WARN" && parsed.severity !== "NONE") {
      return null;
    }
    return parsed as CompositionScriptRecord;
  } catch {
    return null;
  }
}

/** `file:line` label for diagnostics (file and line when known; null otherwise). */
export function scriptErrorWhere(e: CompositionScriptError): string | null {
  if (e.file && typeof e.line === "number") return `${e.file}:${e.line}`;
  if (e.file) return e.file;
  return null;
}

/**
 * Turns one record into a G430/G431/G432 diagnostic (null when NONE). The first error
 * carries the message; the count suffix names the rest without pasting them.
 */
export function scriptRecordToDiagnostic(
  cueId: string,
  record: CompositionScriptRecord
): CutholDiagnostic | null {
  if (record.severity === "NONE" || record.errors.length === 0) return null;
  const first = record.errors[0];
  const extra = record.errors.length > 1 ? ` (+${record.errors.length - 1} more page error${record.errors.length - 1 === 1 ? "" : "s"})` : "";
  const text = `${first.text}${extra}`;
  const where = scriptErrorWhere(first);
  if (record.severity === "ERROR") {
    return DIAGNOSTICS.COMPOSITION_SCRIPT_FAILED_BEFORE_TIMELINE(cueId, text, where);
  }
  const thrownKind = first.kind === "pageerror" || first.kind === "rejection";
  if (thrownKind) {
    return DIAGNOSTICS.COMPOSITION_SCRIPT_FAILED_AFTER_TIMELINE(cueId, text, where);
  }
  return DIAGNOSTICS.COMPOSITION_CONSOLE_ERROR(cueId, text, where);
}

interface CheckRuntimeFinding {
  code?: unknown;
  severity?: unknown;
  message?: unknown;
  sourceFile?: unknown;
  file?: unknown;
  line?: unknown;
}

/**
 * Reads the runtime section of `hyperframes check --json` output (the renderer runs the
 * page in a browser: `browserSkipped:false`). Accepts the current `runtime.findings[]`
 * shape (`page_error` / `console_error` codes with `sourceFile` + `line`) and a legacy
 * `runtime.console_error` string or string list when present. Anything unparseable yields
 * no errors (the probe below still measures the page directly).
 */
export function parseCheckRuntimeScriptErrors(checkJson: unknown): CompositionScriptError[] {
  const out: CompositionScriptError[] = [];
  if (!checkJson || typeof checkJson !== "object") return out;
  const runtime = (checkJson as Record<string, unknown>).runtime;
  if (!runtime || typeof runtime !== "object") return out;
  const rec = runtime as Record<string, unknown>;

  const findings = Array.isArray(rec.findings) ? (rec.findings as CheckRuntimeFinding[]) : [];
  for (const f of findings) {
    if (!f || typeof f !== "object") continue;
    const code = String(f.code ?? "");
    const kind: ScriptErrorKind = code === "console_error" ? "console" : "pageerror";
    const message = typeof f.message === "string" ? f.message : "";
    if (!message.trim()) continue;
    const rawFile = typeof f.sourceFile === "string" ? f.sourceFile : typeof f.file === "string" ? f.file : "";
    const flat = rawFile.replace(/\\/g, "/");
    const file = !flat ? undefined : /:\/\/|^[A-Za-z]:\//.test(flat) ? flat.split("/").pop() || undefined : flat;
    const line = typeof f.line === "number" && Number.isFinite(f.line) && f.line > 0 ? Math.floor(f.line) : undefined;
    out.push({ phase: "load", kind, text: message, ...(file ? { file } : {}), ...(line !== undefined ? { line } : {}) });
  }

  const legacy = rec.console_error;
  const legacyList: unknown[] = typeof legacy === "string" ? [legacy] : Array.isArray(legacy) ? legacy : [];
  for (const item of legacyList) {
    if (typeof item !== "string" || !item.trim()) continue;
    out.push({ phase: "load", kind: "console", text: item });
  }
  return dedupeScriptErrors(out);
}

export interface ScriptProbeJob {
  cueId: string;
  absCompDir: string;
  entryHtml: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
}

// Monitor and preview stay synchronous (their dispatch is sync), so the browser probe
// runs in one child node process (`hf_script_probe_child.js`, same directory). The child
// probes every job with a shared browser and writes content-keyed records; any failure
// (missing dist, no browser, page hang) leaves records unknown, and the parent re-reads
// whatever the child managed to write. Never throws by design.

/** Synchronously probes compositions missing a record (see above). Never throws. */
export function probeScriptRecordsChildSync(projectDir: string, jobs: ScriptProbeJob[]): void {
  if (jobs.length === 0) return;
  try {
    const childJs = path.join(path.dirname(fileURLToPath(import.meta.url)), "hf_script_probe_child.js");
    if (!fs.existsSync(childJs)) return;
    spawnWatchedSync(
      process.execPath,
      [childJs, projectDir, JSON.stringify(jobs)],
      { encoding: "utf8", step: "composition script probe", stallTimeoutMs: 180000 }
    );
  } catch {
    // probe failure must never fail the caller: unknown stays silent
  }
}

/**
 * Extracts a page-relative `file` + `line` from a puppeteer page error (its stack carries
 * the served URL, e.g. `http://127.0.0.1:9/index.html:34:7`). Returns nulls when the stack
 * has no usable frame (message-only errors still report the text).
 */
export function parsePageErrorLocation(err: unknown): { file?: string; line?: number } {
  try {
    const stack =
      typeof err === "string" ? err : err instanceof Error ? String(err.stack || "") : "";
    const m = /https?:\/\/[^/\s]+(\/[^\s:)]+?)(?::(\d+))?(?::\d+)?(?:\s|\)|$)/.exec(stack);
    if (!m) return {};
    const file = m[1].replace(/^\//, "").split("?")[0] || undefined;
    const line = m[2] !== undefined ? Number(m[2]) : NaN;
    return {
      ...(file ? { file } : {}),
      ...(Number.isFinite(line) && line > 0 ? { line: Math.floor(line) } : {}),
    };
  } catch {
    return {};
  }
}
