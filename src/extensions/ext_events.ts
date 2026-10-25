// Composition-declared events and the read-only planner snapshot (split out of manager.ts).
import fs from "node:fs";
import path from "node:path";
import {
  CutholSequence
} from "../core/schema.js";
import { parseTimeMs } from "../core/time.js";
import { resolveCueStartMs } from "../core/timeline.js";
import {
  WorkspacePaths
} from "../core/workspace.js";
import { exportBridgeDataForCue } from "../compositor/bridge_exporter.js";
import { normTurkish } from "../compositor/cuthol_runtime.js";
import { MediaLedger } from "../library/ledger.js";
import { projectTranscriptAcrossSequence } from "../sequence/spine.js";
import { TranscriptDocument } from "../speech/providers.js";
import { ResolvedExtension } from "./ext_manifest.js";

export interface CompositionDeclaredEvent {
  id: string;
  name: string;
  kind?: string;
  cue_id: string;
  lane_id: string;
  composition_dir: string;
  local_ms: number;
  local_sec: number;
  sequence_ms: number;
  sequence_sec: number;
  meta?: Record<string, unknown>;
  source: "events_json" | "html_script" | "html_attr" | "js_call";
}

export interface PlannerCompositionSnapshot {
  cue_id: string;
  lane_id: string;
  composition_dir: string;
  entry_html: string;
  at_ms: number;
  duration_ms: number;
  end_ms: number;
  props: Record<string, unknown>;
  words: Array<{
    word: string;
    norm: string;
    local_ms: number;
    local_end_ms: number;
    local_sec: number;
    local_end_sec: number;
    sequence_ms: number;
    sequence_end_ms: number;
    sequence_sec: number;
    sequence_end_sec: number;
  }>;
  events: CompositionDeclaredEvent[];
  cuts: Array<{
    local_ms: number;
    local_sec: number;
    sequence_ms: number;
    sequence_sec: number;
    kind: string;
  }>;
}

export interface CutholPlannerSnapshot {
  schema: "cuthol.planner.snapshot/1";
  workspace_dir: string;
  extension_dir: string;
  params: Record<string, number | string | boolean>;
  sequence: CutholSequence;
  words: Array<{
    word: string;
    norm: string;
    source_start_ms: number;
    source_end_ms: number;
    sequence_start_ms: number;
    sequence_end_ms: number;
    sequence_start_sec: number;
    sequence_end_sec: number;
    owner_id: string;
    asset_handle: string;
  }>;
  compositions: PlannerCompositionSnapshot[];
  events: CompositionDeclaredEvent[];
}

function parseFlexibleLocalMs(rawVal: unknown, treatPlainNumberAsSec = false): number | null {
  if (typeof rawVal === "number" && Number.isFinite(rawVal)) {
    return Math.max(0, Math.round(treatPlainNumberAsSec ? rawVal * 1000 : rawVal));
  }
  if (typeof rawVal === "string") {
    const trimmed = rawVal.trim();
    if (!trimmed) return null;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return null;
      return Math.max(0, Math.round(treatPlainNumberAsSec ? n * 1000 : n));
    }
    try {
      return Math.max(0, parseTimeMs(trimmed));
    } catch {
      return null;
    }
  }
  return null;
}

function parseRawEventObject(
  raw: unknown,
  cueId: string,
  laneId: string,
  compDirRel: string,
  cueStartMs: number,
  source: CompositionDeclaredEvent["source"],
  index: number
): CompositionDeclaredEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const rawName = obj.name ?? obj.event ?? obj.type ?? obj.label ?? obj.id;
  if (typeof rawName !== "string" || !rawName.trim()) return null;
  const name = rawName.trim();

  let localMs: number | null = null;
  if (obj.at_ms !== undefined) localMs = parseFlexibleLocalMs(obj.at_ms, false);
  else if (obj.offset_ms !== undefined) localMs = parseFlexibleLocalMs(obj.offset_ms, false);
  else if (obj.local_ms !== undefined) localMs = parseFlexibleLocalMs(obj.local_ms, false);
  else if (obj.time_ms !== undefined) localMs = parseFlexibleLocalMs(obj.time_ms, false);
  else if (obj.at_sec !== undefined) localMs = parseFlexibleLocalMs(obj.at_sec, true);
  else if (obj.local_sec !== undefined) localMs = parseFlexibleLocalMs(obj.local_sec, true);
  else if (obj.t !== undefined) localMs = parseFlexibleLocalMs(obj.t, true);
  else if (obj.sec !== undefined) localMs = parseFlexibleLocalMs(obj.sec, true);
  else if (obj.time !== undefined) {
    localMs =
      typeof obj.time === "number"
        ? parseFlexibleLocalMs(obj.time, true)
        : parseFlexibleLocalMs(obj.time, false);
  } else if (obj.at !== undefined) {
    localMs =
      typeof obj.at === "number" && !Number.isInteger(obj.at) && obj.at < 600
        ? parseFlexibleLocalMs(obj.at, true)
        : parseFlexibleLocalMs(obj.at, false);
  }

  if (localMs === null || !Number.isFinite(localMs)) return null;

  const meta: Record<string, unknown> = {};
  if (obj.meta && typeof obj.meta === "object" && !Array.isArray(obj.meta)) {
    Object.assign(meta, obj.meta as Record<string, unknown>);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (
      ![
        "id",
        "name",
        "event",
        "kind",
        "type",
        "label",
        "at",
        "at_ms",
        "offset_ms",
        "local_ms",
        "time_ms",
        "at_sec",
        "local_sec",
        "t",
        "sec",
        "time",
        "meta",
      ].includes(k)
    ) {
      meta[k] = v;
    }
  }

  const kindStr =
    typeof obj.kind === "string" && obj.kind.trim()
      ? obj.kind.trim()
      : typeof obj.type === "string" && obj.type.trim() && obj.type !== rawName
        ? obj.type.trim()
        : undefined;

  return {
    id:
      typeof obj.id === "string" && obj.id.trim() && obj.id !== rawName
        ? obj.id.trim()
        : `${cueId}_ev_${index}`,
    name,
    ...(kindStr ? { kind: kindStr } : {}),
    cue_id: cueId,
    lane_id: laneId,
    composition_dir: compDirRel,
    local_ms: localMs,
    local_sec: Number((localMs / 1000).toFixed(4)),
    sequence_ms: cueStartMs + localMs,
    sequence_sec: Number(((cueStartMs + localMs) / 1000).toFixed(4)),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    source,
  };
}

/**
 * Extracts composition-declared events without opening a browser:
 * 1. `events.json`, `cuthol-events.json`, `assets/events.json`, or `assets/cuthol-events.json`
 * 2. `<script id="cuthol-events" type="application/json">` (or `data-cuthol-events`) in entry HTML
 * 3. HTML elements with `data-cuthol-event="<name>"` (or `data-event="<name>"`) and `data-cuthol-at` / `data-at` / `data-start`
 * 4. Static JS calls `C.event("name", timeSecOrMs, meta)` or `/* @cuthol-event name 800ms * /` comments
 */
export function extractCompositionDeclaredEvents(options: {
  absCompDir: string;
  compDirRel: string;
  entryHtml: string;
  cueId: string;
  laneId: string;
  cueStartMs: number;
  cueDurationMs: number;
}): CompositionDeclaredEvent[] {
  const { absCompDir, compDirRel, entryHtml, cueId, laneId, cueStartMs } = options;
  if (!fs.existsSync(absCompDir)) return [];

  const events: CompositionDeclaredEvent[] = [];
  let seqIdx = 1;

  // 1. JSON files in composition folder
  const jsonCandidates = [
    path.join(absCompDir, "events.json"),
    path.join(absCompDir, "cuthol-events.json"),
    path.join(absCompDir, "assets", "events.json"),
    path.join(absCompDir, "assets", "cuthol-events.json"),
  ];
  for (const candidate of jsonCandidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { events?: unknown }).events)
          ? ((parsed as { events: unknown[] }).events)
          : [];
      for (const rawEv of list) {
        const ev = parseRawEventObject(
          rawEv,
          cueId,
          laneId,
          compDirRel,
          cueStartMs,
          "events_json",
          seqIdx
        );
        if (ev) {
          events.push(ev);
          seqIdx++;
        }
      }
    } catch {
      // ignore malformed optional event file
    }
  }

  // 2 & 3 & 4. Entry HTML (script JSON blocks, data-cuthol-event attributes, JS C.event calls)
  const entryPath = path.join(absCompDir, entryHtml || "index.html");
  if (fs.existsSync(entryPath)) {
    let html = "";
    try {
      html = fs.readFileSync(entryPath, "utf8");
    } catch {
      html = "";
    }

    if (html) {
      // 2a. <script id="cuthol-events" type="application/json">...</script>
      const scriptBlockRe =
        /<script\b[^>]*(?:\bid=["']cuthol-events["']|\bdata-cuthol-events\b)[^>]*>([\s\S]*?)<\/script>/gi;
      let sm: RegExpExecArray | null;
      while ((sm = scriptBlockRe.exec(html)) !== null) {
        try {
          const parsed = JSON.parse(sm[1].trim()) as unknown;
          const list = Array.isArray(parsed)
            ? parsed
            : parsed &&
                typeof parsed === "object" &&
                Array.isArray((parsed as { events?: unknown }).events)
              ? ((parsed as { events: unknown[] }).events)
              : [];
          for (const rawEv of list) {
            const ev = parseRawEventObject(
              rawEv,
              cueId,
              laneId,
              compDirRel,
              cueStartMs,
              "html_script",
              seqIdx
            );
            if (ev) {
              events.push(ev);
              seqIdx++;
            }
          }
        } catch {
          // ignore
        }
      }

      // 3. HTML elements with data-cuthol-event="..."
      const tagRe = /<([a-zA-Z0-9_-]+)\b([^>]*?\bdata-(?:cuthol-)?event\s*=\s*["'][^"']+["'][^>]*)>/gi;
      let tm: RegExpExecArray | null;
      while ((tm = tagRe.exec(html)) !== null) {
        const attrs = tm[2];
        const getAttr = (attrName: string): string | null => {
          const r = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
          const m = r.exec(attrs);
          return m ? (m[1] ?? m[2] ?? null) : null;
        };
        const evName = getAttr("data-cuthol-event") ?? getAttr("data-event");
        if (!evName || !evName.trim()) continue;
        const rawAt =
          getAttr("data-cuthol-at") ??
          getAttr("data-event-at") ??
          getAttr("data-at") ??
          getAttr("data-time");
        const rawStart = getAttr("data-start");
        let localMs: number | null = null;
        if (rawAt !== null) {
          localMs = parseFlexibleLocalMs(rawAt, false);
        } else if (rawStart !== null) {
          localMs = parseFlexibleLocalMs(
            rawStart,
            /^-?\d+(?:\.\d+)?$/.test(rawStart.trim())
          );
        }
        if (localMs === null) continue;

        let meta: Record<string, unknown> | undefined;
        const rawMeta = getAttr("data-cuthol-meta") ?? getAttr("data-event-meta");
        if (rawMeta) {
          try {
            const parsedMeta = JSON.parse(rawMeta);
            if (parsedMeta && typeof parsedMeta === "object" && !Array.isArray(parsedMeta)) {
              meta = parsedMeta as Record<string, unknown>;
            }
          } catch {
            // ignore
          }
        }
        const rawAsset = getAttr("data-cuthol-asset") ?? getAttr("data-event-asset");
        if (rawAsset) {
          meta = { ...(meta ?? {}), asset_handle: rawAsset };
        }
        const rawKind = getAttr("data-cuthol-kind") ?? getAttr("data-event-kind");

        events.push({
          id: `${cueId}_ev_${seqIdx++}`,
          name: evName.trim(),
          ...(rawKind ? { kind: rawKind.trim() } : {}),
          cue_id: cueId,
          lane_id: laneId,
          composition_dir: compDirRel,
          local_ms: localMs,
          local_sec: Number((localMs / 1000).toFixed(4)),
          sequence_ms: cueStartMs + localMs,
          sequence_sec: Number(((cueStartMs + localMs) / 1000).toFixed(4)),
          ...(meta ? { meta } : {}),
          source: "html_attr",
        });
      }

      // 4. Static JS calls: C.event("paper_drop", 0.8, { ... }) or window.__cuthol.event("paper_drop", "800ms")
      const jsCallRe =
        /\b(?:C|__cuthol)\s*\.\s*event\s*\(\s*["']([^"']+)["']\s*,\s*([0-9]+(?:\.[0-9]+)?|["'][^"']+["'])(?:\s*,\s*(\{[^{}]*\}))?\s*\)/g;
      let jm: RegExpExecArray | null;
      while ((jm = jsCallRe.exec(html)) !== null) {
        const evName = jm[1].trim();
        const rawTimeToken = jm[2].trim();
        let localMs: number | null = null;
        if (rawTimeToken.startsWith('"') || rawTimeToken.startsWith("'")) {
          localMs = parseFlexibleLocalMs(rawTimeToken.slice(1, -1), false);
        } else {
          const num = Number(rawTimeToken);
          localMs = Number.isFinite(num)
            ? Math.max(0, Math.round(num <= 120 && !rawTimeToken.endsWith("00") ? num * 1000 : num))
            : null;
        }
        if (localMs === null) continue;
        let meta: Record<string, unknown> | undefined;
        if (jm[3]) {
          try {
            meta = JSON.parse(jm[3]) as Record<string, unknown>;
          } catch {
            // ignore
          }
        }
        events.push({
          id: `${cueId}_ev_${seqIdx++}`,
          name: evName,
          cue_id: cueId,
          lane_id: laneId,
          composition_dir: compDirRel,
          local_ms: localMs,
          local_sec: Number((localMs / 1000).toFixed(4)),
          sequence_ms: cueStartMs + localMs,
          sequence_sec: Number(((cueStartMs + localMs) / 1000).toFixed(4)),
          ...(meta ? { meta } : {}),
          source: "js_call",
        });
      }
    }
  }

  // Deduplicate identical (name, local_ms) entries within the same composition cue
  const deduped: CompositionDeclaredEvent[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const key = `${ev.name}@${ev.local_ms}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ev);
  }
  deduped.sort((a, b) => a.sequence_ms - b.sequence_ms || a.name.localeCompare(b.name));
  return deduped;
}

export function buildPlannerSnapshot(
  seq: CutholSequence,
  paths: WorkspacePaths,
  ext: ResolvedExtension,
  params: Record<string, number | string | boolean>
): CutholPlannerSnapshot {
  const ledger = fs.existsSync(paths.ledgerFile) ? new MediaLedger(paths.ledgerFile) : null;
  const projectedWords: CutholPlannerSnapshot["words"] = [];

  try {
    if (ledger) {
      const seenHandles = new Set<string>();
      const candidateHandles: string[] = [];
      for (const clip of seq.spine.clips) {
        if (!clip.audio_chain.muted && !seenHandles.has(clip.asset_handle)) {
          seenHandles.add(clip.asset_handle);
          candidateHandles.push(clip.asset_handle);
        }
      }
      for (const lane of seq.lanes) {
        if (lane.muted) continue;
        for (const cue of lane.cues) {
          if (cue.asset_handle && !cue.audio_chain?.muted && !seenHandles.has(cue.asset_handle)) {
            seenHandles.add(cue.asset_handle);
            candidateHandles.push(cue.asset_handle);
          }
        }
      }

      for (const handle of candidateHandles) {
        const asset = seq.library.find((a) => a.handle === handle);
        if (!asset) continue;
        const doc = ledger.getLatestTranscript<TranscriptDocument>(asset.digest_sha256);
        if (!doc?.words?.length) continue;
        const rawWords = doc.words.map((w) => ({
          word: w.punctuated_word || w.word,
          source_start_ms: w.source_start_ms,
          source_end_ms: w.source_end_ms,
          confidence: w.confidence,
        }));
        const projected = projectTranscriptAcrossSequence(seq, handle, rawWords);
        for (const pw of projected) {
          if (pw.excised || pw.sequence_start_ms === null || pw.sequence_end_ms === null) continue;
          projectedWords.push({
            word: pw.word,
            norm: normTurkish(pw.word),
            source_start_ms: pw.source_start_ms,
            source_end_ms: pw.source_end_ms,
            sequence_start_ms: pw.sequence_start_ms,
            sequence_end_ms: pw.sequence_end_ms,
            sequence_start_sec: Number((pw.sequence_start_ms / 1000).toFixed(4)),
            sequence_end_sec: Number((pw.sequence_end_ms / 1000).toFixed(4)),
            owner_id: pw.clip_id ?? handle,
            asset_handle: handle,
          });
        }
      }
    }

    // Also include embedded words on caption cues if not already covered
    if (projectedWords.length === 0) {
      for (const lane of seq.lanes) {
        if (lane.muted) continue;
        for (const cue of lane.cues) {
          if (!cue.typography?.words?.length) continue;
          for (const tw of cue.typography.words) {
            if (tw.excised || tw.sequence_start_ms === null || tw.sequence_end_ms === null) continue;
            projectedWords.push({
              word: tw.word,
              norm: normTurkish(tw.word),
              source_start_ms: tw.source_start_ms,
              source_end_ms: tw.source_end_ms,
              sequence_start_ms: tw.sequence_start_ms,
              sequence_end_ms: tw.sequence_end_ms,
              sequence_start_sec: Number((tw.sequence_start_ms / 1000).toFixed(4)),
              sequence_end_sec: Number((tw.sequence_end_ms / 1000).toFixed(4)),
              owner_id: tw.clip_id ?? cue.id,
              asset_handle: cue.asset_handle ?? cue.id,
            });
          }
        }
      }
    }
  } finally {
    ledger?.close();
  }

  projectedWords.sort((a, b) => a.sequence_start_ms - b.sequence_start_ms);

  const compositions: PlannerCompositionSnapshot[] = [];
  const allEvents: CompositionDeclaredEvent[] = [];

  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (!cue.composition && cue.kind !== "composition") continue;
      const compDirRel = cue.composition?.composition_dir ?? "";
      if (!compDirRel) continue;
      const absCompDir = path.isAbsolute(compDirRel)
        ? compDirRel
        : path.resolve(paths.rootDir, compDirRel);
      const entryHtml = cue.composition?.entry_html || "index.html";
      const cueStartMs = resolveCueStartMs(seq, cue);
      const cueEndMs = cueStartMs + cue.duration_ms;

      const bridge = exportBridgeDataForCue(seq, cue, paths);
      const compWords = bridge.words.map((bw) => {
        const localMs = Math.round(bw.t0 * 1000);
        const localEndMs = Math.round(bw.t1 * 1000);
        const seqMs = cueStartMs + localMs;
        const seqEndMs = cueStartMs + localEndMs;
        return {
          word: bw.text,
          norm: normTurkish(bw.text),
          local_ms: localMs,
          local_end_ms: localEndMs,
          local_sec: bw.t0,
          local_end_sec: bw.t1,
          sequence_ms: seqMs,
          sequence_end_ms: seqEndMs,
          sequence_sec: Number((seqMs / 1000).toFixed(4)),
          sequence_end_sec: Number((seqEndMs / 1000).toFixed(4)),
        };
      });

      const compCuts = (bridge.cuts ?? []).map((bc) => {
        const localMs = Math.round(bc.t * 1000);
        const seqMs = cueStartMs + localMs;
        return {
          local_ms: localMs,
          local_sec: bc.t,
          sequence_ms: seqMs,
          sequence_sec: Number((seqMs / 1000).toFixed(4)),
          kind: bc.kind ?? "spine_cut",
        };
      });

      const declaredEvents = extractCompositionDeclaredEvents({
        absCompDir,
        compDirRel,
        entryHtml,
        cueId: cue.id,
        laneId: lane.id,
        cueStartMs,
        cueDurationMs: cue.duration_ms,
      });
      allEvents.push(...declaredEvents);

      compositions.push({
        cue_id: cue.id,
        lane_id: lane.id,
        composition_dir: compDirRel,
        entry_html: entryHtml,
        at_ms: cueStartMs,
        duration_ms: cue.duration_ms,
        end_ms: cueEndMs,
        props: cue.composition?.props ?? {},
        words: compWords,
        events: declaredEvents,
        cuts: compCuts,
      });
    }
  }

  allEvents.sort((a, b) => a.sequence_ms - b.sequence_ms || a.name.localeCompare(b.name));

  return {
    schema: "cuthol.planner.snapshot/1",
    workspace_dir: paths.rootDir,
    extension_dir: ext.dir,
    params,
    sequence: structuredClone(seq),
    words: projectedWords,
    compositions,
    events: allEvents,
  };
}
