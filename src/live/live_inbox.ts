import fs from "node:fs";
import path from "node:path";
import { formatTimecode } from "../core/time.js";
import { resolveLivePaths } from "./live_paths.js";
import { readLiveLock } from "./live_lock.js";
import { LIVE_ACTOR_ENV, LIVE_SCHEMA, type LiveActivityEntry, type LiveNotePacket, type LiveNotesPayload } from "./live_types.js";

/** Writes one packet atomically into the inbox (the live server calls this). */
export function writeLiveNotePacket(projectDir: string, packet: Omit<LiveNotePacket, "schema">): string {
  const { inboxDir } = resolveLivePaths(projectDir);
  fs.mkdirSync(inboxDir, { recursive: true });
  const file = path.join(inboxDir, `${packet.id}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: LIVE_SCHEMA, ...packet }, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

/** Packets waiting for the agent, oldest first, without consuming them. */
export function peekLiveInbox(projectDir: string): LiveNotePacket[] {
  const { inboxDir } = resolveLivePaths(projectDir);
  let names: string[];
  try {
    names = fs.readdirSync(inboxDir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: LiveNotePacket[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(inboxDir, n), "utf8")) as LiveNotePacket);
    } catch {
      // half-written or foreign file: skip
    }
  }
  return out;
}

function fmtMs(ms: number): string {
  try {
    return formatTimecode(ms);
  } catch {
    return `${(ms / 1000).toFixed(2)}s`;
  }
}

/** Compact one-line-per-item rendering, the form the agent reads. */
/** Header of the live-notes block in compact/markdown responses (handle first). */
export const LIVE_NOTES_HEADER = "Live notes from the user (handle these first):";

/** The live-notes block as response lines: blank separator, header, one indented line each. */
export function formatLiveNotesBlock(lines: string[]): string[] {
  return ["", LIVE_NOTES_HEADER, ...lines.map((l) => `  ${l}`)];
}

export function formatLiveNoteLines(packets: LiveNotePacket[]): string[] {
  const lines: string[] = [];
  for (const p of packets) {
    if (p.human_edits) {
      const e = p.human_edits;
      lines.push(`User edited the timeline while you were paused (r${e.from_revision}→r${e.to_revision}):`);
      lines.push(...formatHumanEditLines(e.entries));
    }
    for (const n of p.notes) {
      const text = String(n.text ?? "").replace(/\s+/g, " ").trim();
      const els = (n.elements ?? []).slice(0, 3).map((el) => el.ref);
      // A point-less note is a general note: mark it so the agent sees there
      // is no pin. Pinned notes keep the old shape (no suffix without elements).
      const where = els.length ? ` → ${els.join(" ∩ ")}${n.overlap_px2 ? ` ${Math.round(n.overlap_px2)} px²` : ""}` : (n.point ? "" : " (general note, no pin)");
      lines.push(`#${n.n} ${fmtNoteTime(n.at_ms)} "${text}"${where}`);
    }
    if (p.setting) lines.push(`human changed setting ${p.setting.key}: ${p.setting.old_value} → ${p.setting.new_value}`);
    if (p.sheet) lines.push(`sheet: ${p.sheet}`);
  }
  return lines;
}

/** `mm:ss.cc`, the time form the window shows next to each pin. */
function fmtNoteTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const mm = String(Math.floor(t / 60000)).padStart(2, "0");
  const ss = String(Math.floor(t / 1000) % 60).padStart(2, "0");
  const cc = String(Math.floor((t % 1000) / 10)).padStart(2, "0");
  return `${mm}:${ss}.${cc}`;
}

/** Most human-edit lines one response carries; the rest collapse into `+N more`. */
export const RESUME_LINE_LIMIT = 12;

/**
 * One compact line per human edit, oldest first: `human r45 spine.trim sp_03 −1.0s`.
 * Past the limit a single `+N more` line follows.
 */
export function formatHumanEditLines(entries: LiveActivityEntry[], limit: number = RESUME_LINE_LIMIT): string[] {
  const sorted = [...entries].sort((a, b) => a.revision - b.revision);
  const lines = sorted.slice(0, limit).map((e) => `human r${e.revision} ${e.summary}`);
  if (sorted.length > limit) lines.push(`+${sorted.length - limit} more`);
  return lines;
}

/**
 * Consumes the inbox: returns everything waiting and moves the files to
 * `inbox/delivered/`. Returns null (and touches nothing) when empty, so a
 * project that never used Live pays one failed readdir.
 */
export function drainLiveInbox(projectDir: string): LiveNotesPayload | null {
  const paused = pausedNotice(projectDir);
  const packets = peekLiveInbox(projectDir);
  if (packets.length === 0) return paused ? { packets: [], lines: [paused.line], images: [], paused: { since: paused.since } } : null;
  const { inboxDir } = resolveLivePaths(projectDir);
  const delivered = path.join(inboxDir, "delivered");
  fs.mkdirSync(delivered, { recursive: true });
  const images: string[] = [];
  for (const p of packets) {
    for (const ext of [".json", ".png"]) {
      const src = path.join(inboxDir, `${p.id}${ext}`);
      if (fs.existsSync(src)) {
        try {
          fs.renameSync(src, path.join(delivered, `${p.id}${ext}`));
        } catch {
          // another process consumed it first
        }
      }
    }
    if (p.sheet) {
      const moved = path.join(delivered, path.basename(p.sheet));
      const abs = fs.existsSync(moved) ? moved : path.resolve(projectDir, p.sheet);
      if (fs.existsSync(abs)) images.push(abs);
      p.sheet = path.relative(path.resolve(projectDir), abs).split(path.sep).join("/");
    }
  }
  const lines = formatLiveNoteLines(packets);
  return paused
    ? { packets, lines: [paused.line, ...lines], images, paused: { since: paused.since } }
    : { packets, lines, images };
}

/** Line telling the agent it was paused (null when not paused or when the human's own edit runs). */
export const LIVE_PAUSED_LINE =
  "PAUSED: the user paused you in Cuthol Live to edit the timeline. The write you already started is still applied as the last allowed one; further writes are refused with G601. Run `cuthol live wait` (MCP: workspace live_wait) now. It returns when they resume, with their changes.";

function pausedNotice(projectDir: string): { line: string; since: string } | null {
  if (process.env[LIVE_ACTOR_ENV] === "human") return null;
  const lock = readLiveLock(projectDir);
  return lock && lock.holder === "human" ? { line: LIVE_PAUSED_LINE, since: lock.since } : null;
}
