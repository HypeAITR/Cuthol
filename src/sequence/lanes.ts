/**
 * Cuthol Parallel Lanes & Anchored Cues Manager (`src/sequence/lanes.ts`).
 *
 * Manages typed overlay lanes (`broll`, `caption`, `title`, `music`, `sfx`, `voiceover`, `composition`),
 * spine-relative cue anchoring (`anchor: { ref: "sp_01", offset_ms }`), HyperFrames composition mounts,
 * and timeline markers.
 */

import { resolveCueStartMs } from "../core/timeline.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  allocateNextHandle,
  createDefaultAudioChain,
  createDefaultPlacement,
  CueAnchor,
  CutholSequence,
  getCuePlaybackRate,
  HyperFramesMountSpec,
  isStillGraphic,
  LaneCue,
  LaneKind,
  ParallelLane,
  syncSequenceHandleCounters,
  TimelineMarker,
  TypographySpec,
} from "../core/schema.js";
import {
  resolveDefaultLaneMaxWidthPct,
  resolveDefaultLaneTypographyFontSizePx,
} from "../core/standards.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";
import { applyNumericDeltaOrValue, applyOpacityDeltaOrValue } from "./spine.js";

function collectAllCueIds(seq: CutholSequence): string[] {
  const ids: string[] = [];
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      ids.push(cue.id);
    }
  }
  return ids;
}

function ensureLaneExists(seq: CutholSequence, laneId: string, kind: LaneKind, zIndex?: number): ParallelLane {
  let lane = seq.lanes.find((l) => l.id === laneId);
  if (!lane) {
    let defaultZ: number;
    if (zIndex !== undefined) {
      defaultZ = zIndex;
    } else if (kind === "music" || kind === "sfx" || kind === "voiceover") {
      defaultZ = -10;
    } else if (kind === "composition") {
      const maxCompZ = seq.lanes
        .filter((l) => l.kind === "composition")
        .reduce((max, l) => Math.max(max, l.z_index), 20);
      defaultZ = maxCompZ + 1;
    } else {
      defaultZ = 15;
    }
    lane = {
      id: laneId,
      kind,
      z_index: defaultZ,
      muted: false,
      locked: false,
      cues: [],
    };
    seq.lanes.push(lane);
  }
  return lane;
}

export function addLaneCue(options: {
  workspaceDir: string;
  laneId: string;
  kind?: LaneKind;
  explicitId?: string;
  assetHandle?: string;
  anchor?: CueAnchor | null;
  atMs?: number;
  durationMs: number;
  explicitDuration?: boolean;
  sourceInMs?: number;
  sourceOutMs?: number;
  rate?: number;
  preservePitch?: boolean;
  zIndex?: number;
  xPct?: number;
  yPct?: number;
  scale?: number;
  rotationDeg?: number | string;
  opacity?: number;
  text?: string;
  fontSizePx?: number;
  colorHex?: string;
  maxWidthPct?: number;
  composition?: HyperFramesMountSpec;
}): { cue: LaneCue; revision: number; verification: VerificationReport } {
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `lane.add-cue(${options.laneId})`,
    (seq) => {
      const existingLane = seq.lanes.find((l) => l.id === options.laneId);
      const kind = options.kind ?? existingLane?.kind ?? "title";
      const lane = ensureLaneExists(seq, options.laneId, kind, options.zIndex);

      const id = options.explicitId ?? allocateNextHandle(collectAllCueIds(seq), "cue", seq);
      syncSequenceHandleCounters(seq, [id]);

      if (
        options.rate !== undefined &&
        (!Number.isFinite(options.rate) || options.rate < 0.1 || options.rate > 16.0)
      ) {
        throw new CutholError(DIAGNOSTICS.INVALID_PLAYBACK_RATE(id, options.rate));
      }

      const placement = createDefaultPlacement();
      if (options.xPct !== undefined) placement.x_pct = options.xPct;
      if (options.yPct !== undefined) placement.y_pct = options.yPct;
      if (options.scale !== undefined) {
        placement.scale_x = options.scale;
        placement.scale_y = options.scale;
      }
      if (options.rotationDeg !== undefined) {
        placement.rotation_deg = applyNumericDeltaOrValue(
          placement.rotation_deg,
          options.rotationDeg
        );
      }
      if (options.opacity !== undefined) placement.opacity = options.opacity;

      let typography: TypographySpec | undefined;
      if (options.text !== undefined || kind === "title" || kind === "caption") {
        typography = {
          text: options.text ?? "",
          font_family: "Inter",
          font_size_px:
            options.fontSizePx ?? resolveDefaultLaneTypographyFontSizePx(seq.stage, kind),
          font_weight: 700,
          color_hex: options.colorHex ?? "#FFFFFF",
          stroke_color_hex: "#000000",
          stroke_width_px: 2,
          box_color_hex: null,
          box_opacity: 0,
          align: "center",
          max_width_pct: options.maxWidthPct ?? resolveDefaultLaneMaxWidthPct(seq.stage),
        };
      }

      const audioChain =
        kind === "music" || kind === "sfx" || kind === "voiceover" || kind === "broll"
          ? createDefaultAudioChain()
          : undefined;

      let sourceInMs = options.sourceInMs;
      let sourceOutMs = options.sourceOutMs;
      let durationMs = options.durationMs;
      const rate = options.rate ?? 1.0;
      const asset = options.assetHandle
        ? seq.library.find((a) => a.handle === options.assetHandle)
        : undefined;

      if (options.rate !== undefined || options.preservePitch !== undefined) {
        const srcIn = sourceInMs ?? 0;
        if (sourceOutMs !== undefined) {
          sourceInMs = srcIn;
          if (!options.explicitDuration) {
            durationMs = Math.max(1, Math.round(Math.max(1, sourceOutMs - srcIn) / rate));
          }
        } else if (asset && !isStillGraphic(asset)) {
          sourceInMs = srcIn;
          if (options.explicitDuration) {
            sourceOutMs = Math.min(
              asset.probe.duration_ms,
              srcIn + Math.max(1, Math.round(durationMs * rate))
            );
            durationMs = Math.max(1, Math.round(Math.max(1, sourceOutMs - srcIn) / rate));
          } else {
            sourceOutMs = asset.probe.duration_ms;
            durationMs = Math.max(1, Math.round(Math.max(1, sourceOutMs - srcIn) / rate));
          }
        }
      }

      const playback =
        options.rate !== undefined || options.preservePitch !== undefined
          ? {
              rate,
              preserve_pitch: options.preservePitch ?? true,
            }
          : undefined;

      const newCue: LaneCue = {
        id,
        kind,
        asset_handle: options.assetHandle,
        anchor: options.anchor ?? null,
        at_ms: options.atMs ?? 0,
        duration_ms: durationMs,
        source_in_ms: sourceInMs,
        source_out_ms: sourceOutMs,
        ...(playback ? { playback } : {}),
        ...(options.zIndex !== undefined ? { z_index: options.zIndex } : {}),
        placement,
        audio_chain: audioChain,
        typography,
        composition: options.composition,
        envelopes: [],
      };

      newCue.at_ms = resolveCueStartMs(seq, newCue);
      lane.cues.push(newCue);
      return newCue;
    }
  );

  return { cue: result, revision, verification };
}

export function updateLaneCue(options: {
  workspaceDir: string;
  cueId: string;
  atMs?: number;
  durationMs?: number;
  sourceInMs?: number;
  sourceOutMs?: number;
  rate?: number;
  preservePitch?: boolean;
  zIndex?: number;
  anchor?: CueAnchor | null;
  xPct?: string | number;
  yPct?: string | number;
  scale?: string | number;
  rotationDeg?: string | number;
  opacity?: string | number;
  text?: string;
  fontSizePx?: number;
  maxWidthPct?: number;
  gainDb?: number;
}): { cue: LaneCue; revision: number; verification: VerificationReport } {
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `lane.update-cue(${options.cueId})`,
    (seq) => {
      let targetCue: LaneCue | undefined;
      for (const lane of seq.lanes) {
        const found = lane.cues.find((c) => c.id === options.cueId);
        if (found) {
          targetCue = found;
          break;
        }
      }
      if (!targetCue) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.cueId));
      }

      if (
        options.rate !== undefined &&
        (!Number.isFinite(options.rate) || options.rate < 0.1 || options.rate > 16.0)
      ) {
        throw new CutholError(DIAGNOSTICS.INVALID_PLAYBACK_RATE(targetCue.id, options.rate));
      }

      const oldRate = getCuePlaybackRate(targetCue);
      const oldDurationMs = targetCue.duration_ms;
      const asset = targetCue.asset_handle
        ? seq.library.find((a) => a.handle === targetCue.asset_handle)
        : undefined;

      if (options.anchor !== undefined) targetCue.anchor = options.anchor;
      if (options.atMs !== undefined) {
        targetCue.at_ms = options.atMs;
        if (options.anchor === undefined) {
          targetCue.anchor = null;
        }
      }
      if (options.sourceInMs !== undefined) targetCue.source_in_ms = options.sourceInMs;
      if (options.sourceOutMs !== undefined) targetCue.source_out_ms = options.sourceOutMs;

      if (options.rate !== undefined || options.preservePitch !== undefined) {
        const nextRate = options.rate ?? oldRate;
        const nextPreservePitch =
          options.preservePitch ?? targetCue.playback?.preserve_pitch ?? true;

        if (options.rate !== undefined) {
          const srcIn = targetCue.source_in_ms ?? 0;
          let srcOut = targetCue.source_out_ms;
          if (srcOut === undefined) {
            const rawSpan = Math.max(1, Math.round(oldDurationMs * oldRate));
            srcOut =
              asset && !isStillGraphic(asset)
                ? Math.min(asset.probe.duration_ms, srcIn + rawSpan)
                : srcIn + rawSpan;
          }
          targetCue.source_in_ms = srcIn;
          targetCue.source_out_ms = srcOut;
          if (options.durationMs === undefined) {
            const srcSpan = Math.max(1, srcOut - srcIn);
            targetCue.duration_ms = Math.max(1, Math.round(srcSpan / nextRate));
          }
        }

        targetCue.playback = {
          rate: nextRate,
          preserve_pitch: nextPreservePitch,
        };
      }

      if (options.durationMs !== undefined) {
        targetCue.duration_ms = options.durationMs;
        if (targetCue.source_out_ms !== undefined && options.sourceOutMs === undefined) {
          const effRate = getCuePlaybackRate(targetCue);
          const srcIn = targetCue.source_in_ms ?? 0;
          const newSpan = Math.max(1, Math.round(options.durationMs * effRate));
          targetCue.source_out_ms =
            asset && !isStillGraphic(asset)
              ? Math.min(asset.probe.duration_ms, srcIn + newSpan)
              : srcIn + newSpan;
        }
      }

      if (
        targetCue.duration_ms !== oldDurationMs &&
        oldDurationMs > 0 &&
        targetCue.envelopes.length > 0
      ) {
        for (const env of targetCue.envelopes) {
          for (const pt of env.points) {
            pt.offset_ms = Math.min(
              targetCue.duration_ms,
              Math.max(0, Math.round((pt.offset_ms * targetCue.duration_ms) / oldDurationMs))
            );
          }
        }
      }

      if (options.zIndex !== undefined) {
        targetCue.z_index = options.zIndex;
      }
      if (options.xPct !== undefined) {
        targetCue.placement.x_pct = applyNumericDeltaOrValue(targetCue.placement.x_pct, options.xPct);
      }
      if (options.yPct !== undefined) {
        targetCue.placement.y_pct = applyNumericDeltaOrValue(targetCue.placement.y_pct, options.yPct);
      }
      if (options.scale !== undefined) {
        targetCue.placement.scale_x = applyNumericDeltaOrValue(targetCue.placement.scale_x, options.scale);
        targetCue.placement.scale_y = applyNumericDeltaOrValue(targetCue.placement.scale_y, options.scale);
      }
      if (options.rotationDeg !== undefined) {
        targetCue.placement.rotation_deg = applyNumericDeltaOrValue(
          targetCue.placement.rotation_deg,
          options.rotationDeg
        );
      }
      if (options.opacity !== undefined) {
        targetCue.placement.opacity = applyOpacityDeltaOrValue(
          targetCue.placement.opacity,
          options.opacity
        );
      }
      if (
        options.text !== undefined ||
        options.fontSizePx !== undefined ||
        options.maxWidthPct !== undefined
      ) {
        if (!targetCue.typography) {
          targetCue.typography = {
            text: options.text ?? "",
            font_family: "Inter",
            font_size_px:
              options.fontSizePx ??
              resolveDefaultLaneTypographyFontSizePx(seq.stage, targetCue.kind),
            font_weight: 700,
            color_hex: "#FFFFFF",
            stroke_color_hex: "#000000",
            stroke_width_px: 2,
            box_color_hex: null,
            box_opacity: 0,
            align: "center",
            max_width_pct: options.maxWidthPct ?? resolveDefaultLaneMaxWidthPct(seq.stage),
          };
        } else {
          if (options.text !== undefined) targetCue.typography.text = options.text;
          if (options.fontSizePx !== undefined) targetCue.typography.font_size_px = options.fontSizePx;
          if (options.maxWidthPct !== undefined) targetCue.typography.max_width_pct = options.maxWidthPct;
        }
      }
      if (options.gainDb !== undefined) {
        if (!targetCue.audio_chain) targetCue.audio_chain = createDefaultAudioChain();
        targetCue.audio_chain.gain_db = options.gainDb;
      }

      targetCue.at_ms = resolveCueStartMs(seq, targetCue);
      return targetCue;
    }
  );

  return { cue: result, revision, verification };
}

export function removeLaneCues(options: {
  workspaceDir: string;
  cueIds: string[];
}): { removedIds: string[]; revision: number; verification: VerificationReport } {
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `lane.remove-cues(${options.cueIds.join(",")})`,
    (seq) => {
      syncSequenceHandleCounters(seq);
      const targetSet = new Set(options.cueIds);
      const allExisting = new Set(collectAllCueIds(seq));
      for (const id of targetSet) {
        if (!allExisting.has(id)) {
          throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(id));
        }
      }
      for (const lane of seq.lanes) {
        lane.cues = lane.cues.filter((c) => !targetSet.has(c.id));
      }
      return Array.from(targetSet);
    }
  );

  return { removedIds: result, revision, verification };
}

export function addTimelineMarker(options: {
  workspaceDir: string;
  atMs: number;
  label: string;
  category?: TimelineMarker["category"];
}): { marker: TimelineMarker; revision: number } {
  const { result, revision } = commitVerifiedMutation(
    options.workspaceDir,
    `marker.add(${options.atMs}ms)`,
    (seq) => {
      const id = allocateNextHandle(seq.markers.map((m) => m.id), "mk", seq);
      const marker: TimelineMarker = {
        id,
        at_ms: options.atMs,
        label: options.label,
        category: options.category ?? "note",
      };
      seq.markers.push(marker);
      seq.markers.sort((a, b) => a.at_ms - b.at_ms);
      return marker;
    }
  );
  return { marker: result, revision };
}
