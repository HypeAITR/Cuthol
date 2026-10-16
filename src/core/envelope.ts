/**
 * Cuthol Unified State Delta & Breadcrumb Response Envelope (`src/core/envelope.ts`).
 *
 * Implements `cuthol.envelope/1`:
 * - Computes structural diffs (`computeSequenceDelta`) between revisions so every journal entry
 *   knows what it changed (`delta_summary`) and what undoing it will destroy/modify (`inverse_summary`).
 * - Provides `state` (`state_digest`, `state_hash`, `counts`), `delta`, and `history`
 *   (`undo_preview`, `next_redo`, `breadcrumb`) for both CLI (`--json`) and `cuthol-mcp`.
 */

import crypto from "node:crypto";
import { computeSequenceDurationMs } from "./timeline.js";
import { CutholSequence } from "./schema.js";

export type InverseOperationKind = "additive" | "modifying" | "destructive";

export interface SequenceDeltaInfo {
  summary: string;
  inverse_kind: InverseOperationKind;
  inverse_summary: string;
  affected_ids: string[];
  touches_protected: boolean;
  protected_ids: string[];
}

export interface HistoryEntryPreview {
  revision: number;
  operation: string;
  delta_summary: string;
  inverse_kind: InverseOperationKind;
  inverse_summary: string;
  affects: string[];
  touches_protected: boolean;
}

export interface CutholEnvelopeState {
  project_id: string;
  revision: number;
  state_hash: string;
  state_digest: string;
  duration_ms: number;
  counts: {
    library_assets: number;
    spine_clips: number;
    lanes: number;
    cues: number;
    compositions: number;
    captions: number;
    locked_lanes: number;
  };
}

export interface CutholEnvelopeHistory {
  undo_depth: number;
  redo_depth: number;
  undo_preview: HistoryEntryPreview | null;
  next_redo: {
    revision: number;
    operation: string;
    delta_summary: string;
    affects: string[];
  } | null;
  breadcrumb: string[];
}

function estimateSequenceDurationMs(seq: CutholSequence): number {
  return Math.max(0, Math.round(computeSequenceDurationMs(seq)));
}

function describeSpineClipChanges(
  prevClip: CutholSequence["spine"]["clips"][number],
  nextClip: CutholSequence["spine"]["clips"][number]
): string {
  const details: string[] = [];
  if (JSON.stringify(prevClip.transition_out) !== JSON.stringify(nextClip.transition_out)) {
    if (nextClip.transition_out) {
      details.push(`transition:${nextClip.transition_out.kind} ${nextClip.transition_out.duration_ms}ms`);
    } else {
      details.push("transition:none");
    }
  }
  if (prevClip.duration_ms !== nextClip.duration_ms) {
    details.push(`duration:${prevClip.duration_ms}ms->${nextClip.duration_ms}ms`);
  }
  if (
    prevClip.playback.rate !== nextClip.playback.rate ||
    JSON.stringify(prevClip.playback.speed_ramp) !== JSON.stringify(nextClip.playback.speed_ramp)
  ) {
    details.push(`speed:${prevClip.playback.rate}x->${nextClip.playback.rate}x`);
  }
  if (JSON.stringify(prevClip.envelopes) !== JSON.stringify(nextClip.envelopes)) {
    const params = nextClip.envelopes.map((e) => e.parameter.split(".").pop()).join(",");
    details.push(`envelopes:${nextClip.envelopes.length}${params ? `[${params}]` : ""}`);
  }
  if (JSON.stringify(prevClip.audio_chain) !== JSON.stringify(nextClip.audio_chain)) {
    details.push(`audio:gain=${nextClip.audio_chain.gain_db}dB`);
  }
  if (JSON.stringify(prevClip.placement) !== JSON.stringify(nextClip.placement)) {
    details.push("placement");
  }
  return details.length > 0 ? `${nextClip.id} (${details.join(", ")})` : nextClip.id;
}
function describeCueShort(cue: CutholSequence["lanes"][number]["cues"][number]): string {
  if (cue.typography?.text) {
    const snippet = cue.typography.text.replace(/\s+/g, " ").trim().slice(0, 26);
    return `${cue.id} (${cue.kind}: '${snippet}')`;
  }
  if (cue.composition) {
    return `${cue.id} (composition: '${cue.composition.composition_dir}')`;
  }
  if (cue.asset_handle) {
    return `${cue.id} (${cue.kind}: ${cue.asset_handle})`;
  }
  return `${cue.id} (${cue.kind})`;
}

/**
 * Compares `prevSeq` and `nextSeq` to generate a concise, deterministic `delta_summary`
 * and `inverse_summary` (what happens when this revision is undone).
 */
export function computeSequenceDelta(
  prevSeq: CutholSequence,
  nextSeq: CutholSequence,
  operation: string
): SequenceDeltaInfo {
  const addedItems: string[] = [];
  const removedItems: string[] = [];
  const modifiedItems: string[] = [];
  const affectedIds = new Set<string>();
  const protectedIds = new Set<string>();

  // 1. Library assets
  const prevLib = new Map(prevSeq.library.map((a) => [a.handle, a]));
  const nextLib = new Map(nextSeq.library.map((a) => [a.handle, a]));
  for (const [h, a] of nextLib) {
    if (!prevLib.has(h)) {
      addedItems.push(`${h} (${a.kind})`);
      affectedIds.add(h);
    }
  }
  for (const [h, a] of prevLib) {
    if (!nextLib.has(h)) {
      removedItems.push(`${h} (${a.kind})`);
      affectedIds.add(h);
    }
  }

  // 2. Spine clips
  const prevSpine = new Map(prevSeq.spine.clips.map((c) => [c.id, c]));
  const nextSpine = new Map(nextSeq.spine.clips.map((c) => [c.id, c]));
  for (const [id, c] of nextSpine) {
    if (!prevSpine.has(id)) {
      addedItems.push(`${id} (${c.asset_handle} ${c.duration_ms}ms)`);
      affectedIds.add(id);
    } else {
      const p = prevSpine.get(id)!;
      if (JSON.stringify(p) !== JSON.stringify(c)) {
        modifiedItems.push(describeSpineClipChanges(p, c));
        affectedIds.add(id);
      }
    }
  }
  for (const [id, c] of prevSpine) {
    if (!nextSpine.has(id)) {
      removedItems.push(`${id} (${c.asset_handle})`);
      affectedIds.add(id);
    }
  }

  // 3. Lane cues & locked status
  const prevCues = new Map<string, { cue: CutholSequence["lanes"][number]["cues"][number]; laneId: string; locked: boolean }>();
  for (const l of prevSeq.lanes) {
    for (const c of l.cues) {
      prevCues.set(c.id, { cue: c, laneId: l.id, locked: l.locked });
    }
  }
  const nextCues = new Map<string, { cue: CutholSequence["lanes"][number]["cues"][number]; laneId: string; locked: boolean }>();
  for (const l of nextSeq.lanes) {
    for (const c of l.cues) {
      nextCues.set(c.id, { cue: c, laneId: l.id, locked: l.locked });
    }
  }

  for (const [id, entry] of nextCues) {
    if (!prevCues.has(id)) {
      addedItems.push(`${describeCueShort(entry.cue)} on ${entry.laneId}`);
      affectedIds.add(id);
      if (entry.locked) {
        protectedIds.add(id);
        protectedIds.add(entry.laneId);
      }
    } else {
      const p = prevCues.get(id)!;
      if (JSON.stringify(p.cue) !== JSON.stringify(entry.cue)) {
        modifiedItems.push(describeCueShort(entry.cue));
        affectedIds.add(id);
        if (entry.locked || p.locked) {
          protectedIds.add(id);
          protectedIds.add(entry.laneId);
        }
      }
    }
  }

  for (const [id, entry] of prevCues) {
    if (!nextCues.has(id)) {
      removedItems.push(`${describeCueShort(entry.cue)} from ${entry.laneId}`);
      affectedIds.add(id);
      if (entry.locked) {
        protectedIds.add(id);
        protectedIds.add(entry.laneId);
      }
    }
  }

  // Also check if lanes were added/removed or lane.locked / lane.muted changed directly
  const prevLaneMap = new Map(prevSeq.lanes.map((l) => [l.id, l]));
  const nextLaneMap = new Map(nextSeq.lanes.map((l) => [l.id, l]));
  for (const [lid, nl] of nextLaneMap) {
    const pl = prevLaneMap.get(lid);
    if (!pl) {
      addedItems.push(`${nl.id} (lane:${nl.kind})`);
      affectedIds.add(nl.id);
    } else if (pl.locked !== nl.locked || pl.muted !== nl.muted) {
      modifiedItems.push(`${nl.id} (locked=${nl.locked}, muted=${nl.muted})`);
      affectedIds.add(nl.id);
    }
  }
  for (const [lid, pl] of prevLaneMap) {
    if (!nextLaneMap.has(lid)) {
      removedItems.push(`${pl.id} (lane:${pl.kind})`);
      affectedIds.add(pl.id);
      if (pl.locked) {
        protectedIds.add(pl.id);
      }
    }
  }

  // 4. Markers & Stage
  const prevMarkers = new Map(prevSeq.markers.map((m) => [m.id, m]));
  const nextMarkers = new Map(nextSeq.markers.map((m) => [m.id, m]));
  for (const [mid, m] of nextMarkers) {
    const pm = prevMarkers.get(mid);
    if (!pm) {
      addedItems.push(`${mid} (marker:${m.label})`);
      affectedIds.add(mid);
    } else if (JSON.stringify(pm) !== JSON.stringify(m)) {
      modifiedItems.push(`${mid} (marker:${m.label})`);
      affectedIds.add(mid);
    }
  }
  for (const [mid, pm] of prevMarkers) {
    if (!nextMarkers.has(mid)) {
      removedItems.push(`${mid} (marker:${pm.label})`);
      affectedIds.add(mid);
    }
  }

  if (prevSeq.stage.backdrop.color !== nextSeq.stage.backdrop.color) {
    modifiedItems.push(`stage.backdrop.color=${nextSeq.stage.backdrop.color} (was ${prevSeq.stage.backdrop.color})`);
    affectedIds.add("stage");
  }
  // Any other stage change (size, fps, master audio) keeps its general description.
  const nextStageWithPrevColor = {
    ...nextSeq.stage,
    backdrop: { ...nextSeq.stage.backdrop, color: prevSeq.stage.backdrop.color },
  };
  if (JSON.stringify(prevSeq.stage) !== JSON.stringify(nextStageWithPrevColor)) {
    modifiedItems.push(`stage (${nextSeq.stage.width}x${nextSeq.stage.height}@${nextSeq.stage.fps}fps)`);
    affectedIds.add("stage");
  }
  if (prevSeq.spine.magnetic !== nextSeq.spine.magnetic) {
    modifiedItems.push(`spine.magnetic=${nextSeq.spine.magnetic}`);
    affectedIds.add("spine");
  }

  const parts: string[] = [];
  if (addedItems.length > 0) parts.push(`+${addedItems.slice(0, 3).join(", ")}${addedItems.length > 3 ? ` (+${addedItems.length - 3} more)` : ""}`);
  if (removedItems.length > 0) parts.push(`-${removedItems.slice(0, 3).join(", ")}${removedItems.length > 3 ? ` (-${removedItems.length - 3} more)` : ""}`);
  if (modifiedItems.length > 0) parts.push(`~${modifiedItems.slice(0, 3).join(", ")}${modifiedItems.length > 3 ? ` (~${modifiedItems.length - 3} more)` : ""}`);

  const summary = parts.length > 0 ? `${operation}: ${parts.join(" | ")}` : operation;

  // Undoing an ADD is DESTRUCTIVE (it deletes the added item!); undoing a REMOVE is ADDITIVE (it restores the removed item)
  let inverseKind: InverseOperationKind = "modifying";
  const invParts: string[] = [];
  if (addedItems.length > 0) {
    inverseKind = "destructive";
    invParts.push(`SİLİNİR: ${addedItems.slice(0, 3).join(", ")}`);
  }
  if (removedItems.length > 0) {
    if (inverseKind !== "destructive") inverseKind = "additive";
    invParts.push(`GERİ YÜKLENİR: ${removedItems.slice(0, 3).join(", ")}`);
  }
  if (modifiedItems.length > 0) {
    invParts.push(`ESKİ HALİNE DÖNER: ${modifiedItems.slice(0, 3).join(", ")}`);
  }
  const inverseSummary =
    invParts.length > 0 ? invParts.join(" | ") : `${operation} işlemi geri alınır`;

  return {
    summary,
    inverse_kind: inverseKind,
    inverse_summary: inverseSummary,
    affected_ids: [...affectedIds],
    touches_protected: protectedIds.size > 0,
    protected_ids: [...protectedIds],
  };
}

export function buildEnvelopeState(seq: CutholSequence): CutholEnvelopeState {
  const durationMs = estimateSequenceDurationMs(seq);
  const hashPayload = {
    stage: seq.stage,
    library: seq.library.map((a) => `${a.handle}:${a.digest_sha256}`),
    spine: seq.spine,
    lanes: seq.lanes,
    markers: seq.markers,
  };
  const stateHash =
    "sha256:" +
    crypto.createHash("sha256").update(JSON.stringify(hashPayload)).digest("hex").slice(0, 12);

  let cuesCount = 0;
  let compCount = 0;
  let capCount = 0;
  let lockedLanes = 0;
  for (const l of seq.lanes) {
    if (l.locked) lockedLanes++;
    cuesCount += l.cues.length;
    for (const c of l.cues) {
      if (c.kind === "composition") compCount++;
      if (c.kind === "caption") capCount++;
    }
  }

  const durSec = (durationMs / 1000).toFixed(2);
  const stateDigest = `r${seq.meta.revision} · ${durSec}s · ${seq.spine.clips.length} sp · ${cuesCount} cue (${compCount} comp, ${capCount} cap)${lockedLanes > 0 ? ` · ${lockedLanes} locked` : ""}`;

  return {
    project_id: seq.meta.project_id,
    revision: seq.meta.revision,
    state_hash: stateHash,
    state_digest: stateDigest,
    duration_ms: durationMs,
    counts: {
      library_assets: seq.library.length,
      spine_clips: seq.spine.clips.length,
      lanes: seq.lanes.length,
      cues: cuesCount,
      compositions: compCount,
      captions: capCount,
      locked_lanes: lockedLanes,
    },
  };
}
