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
  HyperFramesMountSpec,
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
    const defaultZ =
      zIndex ?? (kind === "music" || kind === "sfx" || kind === "voiceover" ? -10 : 15);
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
  sourceInMs?: number;
  sourceOutMs?: number;
  xPct?: number;
  yPct?: number;
  scale?: number;
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
      const lane = ensureLaneExists(seq, options.laneId, kind);

      const id = options.explicitId ?? allocateNextHandle(collectAllCueIds(seq), "cue", seq);
      syncSequenceHandleCounters(seq, [id]);
      const placement = createDefaultPlacement();
      if (options.xPct !== undefined) placement.x_pct = options.xPct;
      if (options.yPct !== undefined) placement.y_pct = options.yPct;
      if (options.scale !== undefined) {
        placement.scale_x = options.scale;
        placement.scale_y = options.scale;
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

      const newCue: LaneCue = {
        id,
        kind,
        asset_handle: options.assetHandle,
        anchor: options.anchor ?? null,
        at_ms: options.atMs ?? 0,
        duration_ms: options.durationMs,
        source_in_ms: options.sourceInMs,
        source_out_ms: options.sourceOutMs,
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
  anchor?: CueAnchor | null;
  xPct?: string | number;
  yPct?: string | number;
  scale?: string | number;
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

      if (options.anchor !== undefined) targetCue.anchor = options.anchor;
      if (options.atMs !== undefined) {
        targetCue.at_ms = options.atMs;
        if (options.anchor === undefined) {
          targetCue.anchor = null;
        }
      }
      if (options.durationMs !== undefined) targetCue.duration_ms = options.durationMs;
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
