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
  SpineClip,
  syncSequenceHandleCounters,
  TimelineMarker,
  TypographySpec,
} from "../core/schema.js";
import {
  resolveDefaultLaneMaxWidthPct,
  resolveDefaultLaneTypographyFontSizePx,
} from "../core/standards.js";
import { minClipDurationMs } from "../core/time.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";
import {
  applyNumericDeltaOrValue,
  applyOpacityDeltaOrValue,
  clipLocalMsToSourceMs,
  computeClipDurationMs,
  reflowSpine,
  sequenceMsToSourceMs,
  sliceEnvelopes,
  sliceReframeFocalPoints,
  sliceSpeedRamp,
  sourceMsToClipLocalMs,
  TimeCoordinateSpace,
} from "./spine.js";

function collectAllCueIds(seq: CutholSequence): string[] {
  const ids: string[] = [];
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      ids.push(cue.id);
    }
  }
  return ids;
}

export function syncCueAnchors(seq: CutholSequence): void {
  const cueById = new Map<string, LaneCue>();
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      if (cue.anchor) {
        cue.at_ms = resolveCueStartMs(seq, cue);
      }
      cueById.set(cue.id, cue);
    }
  }
  // Two passes to resolve chained cue_anchor references
  for (let pass = 0; pass < 2; pass++) {
    for (const lane of seq.lanes) {
      for (const cue of lane.cues) {
        if (cue.cue_anchor) {
          const refCue = cueById.get(cue.cue_anchor.ref);
          if (refCue) {
            cue.at_ms = Math.max(0, resolveCueStartMs(seq, refCue) + cue.cue_anchor.offset_ms);
          }
        }
      }
    }
  }
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
  gainDb?: number;
  muted?: boolean;
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
        kind === "music" ||
        kind === "sfx" ||
        kind === "voiceover" ||
        kind === "broll" ||
        options.gainDb !== undefined ||
        options.muted !== undefined
          ? createDefaultAudioChain()
          : undefined;
      if (audioChain) {
        if (options.gainDb !== undefined && Number.isFinite(options.gainDb)) {
          audioChain.gain_db = options.gainDb;
        }
        if (options.muted !== undefined) {
          audioChain.muted = options.muted;
        }
      }

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
      } else if (
        !options.explicitDuration &&
        sourceOutMs === undefined &&
        asset &&
        !isStillGraphic(asset) &&
        asset.probe.duration_ms > 0
      ) {
        // The default length must never run past the end of the media: cap it at what is left.
        const remainingMs = asset.probe.duration_ms - (sourceInMs ?? 0);
        if (remainingMs > 0 && remainingMs < durationMs) durationMs = remainingMs;
      }

      const playback =
        options.rate !== undefined || options.preservePitch !== undefined
          ? {
              rate,
              preserve_pitch: options.preservePitch ?? true,
            }
          : undefined;

      let spineAnchor: CueAnchor | null = options.anchor ?? null;
      let cueAnchor: CueAnchor | null = null;
      if (options.anchor) {
        const isSpineRef = seq.spine.clips.some((c) => c.id === options.anchor!.ref);
        if (!isSpineRef) {
          const refCue = seq.lanes
            .flatMap((l) => l.cues)
            .find((c) => c.id === options.anchor!.ref);
          if (refCue) {
            spineAnchor = null;
            cueAnchor = { ref: refCue.id, offset_ms: options.anchor.offset_ms };
          }
        }
      }

      const newCue: LaneCue = {
        id,
        kind,
        asset_handle: options.assetHandle,
        anchor: spineAnchor,
        ...(cueAnchor ? { cue_anchor: cueAnchor } : {}),
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
      syncCueAnchors(seq);
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
  muted?: boolean;
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

      if (options.anchor !== undefined) {
        if (options.anchor === null) {
          targetCue.anchor = null;
          delete targetCue.cue_anchor;
        } else {
          const isSpineRef = seq.spine.clips.some((c) => c.id === options.anchor!.ref);
          const refCue = !isSpineRef
            ? seq.lanes.flatMap((l) => l.cues).find((c) => c.id === options.anchor!.ref)
            : undefined;
          if (refCue) {
            targetCue.anchor = null;
            targetCue.cue_anchor = { ref: refCue.id, offset_ms: options.anchor.offset_ms };
          } else {
            targetCue.anchor = options.anchor;
            delete targetCue.cue_anchor;
          }
        }
      }
      if (options.atMs !== undefined) {
        targetCue.at_ms = options.atMs;
        if (options.anchor === undefined) {
          targetCue.anchor = null;
          delete targetCue.cue_anchor;
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
      if (options.muted !== undefined) {
        if (!targetCue.audio_chain) targetCue.audio_chain = createDefaultAudioChain();
        targetCue.audio_chain.muted = options.muted;
      }

      targetCue.at_ms = resolveCueStartMs(seq, targetCue);
      syncCueAnchors(seq);
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
        for (const cue of lane.cues) {
          if (cue.cue_anchor && targetSet.has(cue.cue_anchor.ref)) {
            delete cue.cue_anchor;
          }
        }
      }
      return Array.from(targetSet);
    }
  );

  return { removedIds: result, revision, verification };
}

export type LaneExciseRippleAcross = "lane" | "all_lanes" | "all" | "spine" | "none";

export interface LaneCueExciseRequest {
  cueId: string;
  ranges: Array<{ start_ms: number; end_ms: number }>;
  coordinateSpace?: TimeCoordinateSpace | "cue_local";
  isSourceTime?: boolean;
  ripple?: boolean;
  across?: LaneExciseRippleAcross;
}

export interface LaneCueExciseResult {
  newCues: LaneCue[];
  shiftedCueIds: string[];
  savedSequenceMs: number;
  savedSourceMs: number;
}

function resolveLaneExciseRequest(options: LaneCueExciseRequest): {
  coordSpace: TimeCoordinateSpace | "cue_local";
  across: LaneExciseRippleAcross;
  shouldRipple: boolean;
} {
  const coordSpace: TimeCoordinateSpace | "cue_local" =
    options.coordinateSpace ??
    (options.isSourceTime === true
      ? "source"
      : options.isSourceTime === false
        ? "clip_local"
        : "source");
  const across: LaneExciseRippleAcross =
    options.ripple === false ? "none" : (options.across ?? "lane");
  return { coordSpace, across, shouldRipple: across !== "none" };
}

/** Applies one lane-cue excise to `seq` in memory. Does not read or write the project. */
export function applyLaneCueExciseToSequence(
  seq: CutholSequence,
  options: LaneCueExciseRequest
): LaneCueExciseResult {
  const { coordSpace, across, shouldRipple } = resolveLaneExciseRequest(options);

  let targetLane: ParallelLane | undefined;
  let targetIdx = -1;
  for (const lane of seq.lanes) {
    const idx = lane.cues.findIndex((c) => c.id === options.cueId);
    if (idx >= 0) {
      targetLane = lane;
      targetIdx = idx;
      break;
    }
  }
  if (!targetLane || targetIdx === -1) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.cueId));
  }
  const target = targetLane.cues[targetIdx];

  if (
    target.composition ||
    target.kind === "composition" ||
    target.kind === "title" ||
    target.kind === "caption"
  ) {
    throw new CutholError(DIAGNOSTICS.INVALID_CUE_EXCISE_KIND(target.id, target.kind));
  }
  const asset = target.asset_handle
    ? seq.library.find((a) => a.handle === target.asset_handle)
    : undefined;
  if (asset && isStillGraphic(asset)) {
    throw new CutholError(DIAGNOSTICS.INVALID_CUE_EXCISE_KIND(target.id, "still_graphic"));
  }
  if (!target.asset_handle) {
    throw new CutholError(DIAGNOSTICS.INVALID_CUE_EXCISE_KIND(target.id, target.kind));
  }

  const targetStartMs = resolveCueStartMs(seq, target);
  const targetEndMs = targetStartMs + target.duration_ms;
  const rate = getCuePlaybackRate(target);
  const targetSrcIn = target.source_in_ms ?? 0;
  const rawSpanMs = Math.max(1, Math.round(target.duration_ms * rate));
  const targetSrcOut =
    target.source_out_ms ??
    (asset && !isStillGraphic(asset)
      ? Math.min(asset.probe.duration_ms, targetSrcIn + rawSpanMs)
      : targetSrcIn + rawSpanMs);

  const cutRanges = options.ranges
    .map((r) => {
      let rawSrcStart: number;
      let rawSrcEnd: number;
      if (coordSpace === "source") {
        rawSrcStart = r.start_ms;
        rawSrcEnd = r.end_ms;
      } else if (coordSpace === "sequence") {
        rawSrcStart = targetSrcIn + Math.round((r.start_ms - targetStartMs) * rate);
        rawSrcEnd = targetSrcIn + Math.round((r.end_ms - targetStartMs) * rate);
      } else {
        rawSrcStart = targetSrcIn + Math.round(r.start_ms * rate);
        rawSrcEnd = targetSrcIn + Math.round(r.end_ms * rate);
      }
      return {
        start: Math.max(targetSrcIn, rawSrcStart),
        end: Math.min(targetSrcOut, rawSrcEnd),
      };
    })
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const mergedCuts: Array<{ start: number; end: number }> = [];
  for (const r of cutRanges) {
    if (mergedCuts.length === 0 || r.start > mergedCuts[mergedCuts.length - 1].end) {
      mergedCuts.push({ ...r });
    } else {
      mergedCuts[mergedCuts.length - 1].end = Math.max(
        mergedCuts[mergedCuts.length - 1].end,
        r.end
      );
    }
  }

  if (mergedCuts.length === 0) {
    return {
      newCues: [target],
      shiftedCueIds: [] as string[],
      savedSequenceMs: 0,
      savedSourceMs: 0,
    };
  }

  const minFrameDurMs = minClipDurationMs(seq.stage.fps, 2);
  const rawKeptIntervals: Array<{ start: number; end: number }> = [];
  let srcCursor = targetSrcIn;
  for (const cut of mergedCuts) {
    if (cut.start > srcCursor) {
      rawKeptIntervals.push({ start: srcCursor, end: cut.start });
    }
    srcCursor = Math.max(srcCursor, cut.end);
  }
  if (srcCursor < targetSrcOut) {
    rawKeptIntervals.push({ start: srcCursor, end: targetSrcOut });
  }

  const keptIntervals = rawKeptIntervals.filter(
    (iv) => Math.max(1, Math.round((iv.end - iv.start) / rate)) >= minFrameDurMs
  );

  const existingCueIds = new Set(collectAllCueIds(seq));
  const newCues: LaneCue[] = [];
  let timelineCursorMs = targetStartMs;

  for (let i = 0; i < keptIntervals.length; i++) {
    const iv = keptIntervals[i];
    const subId = i === 0 ? target.id : allocateNextHandle(existingCueIds, "cue", seq);
    existingCueIds.add(subId);
    const subDurMs = Math.max(1, Math.round((iv.end - iv.start) / rate));
    const origPieceOffsetMs = Math.round((iv.start - targetSrcIn) / rate);
    const subAtMs = shouldRipple ? timelineCursorMs : targetStartMs + origPieceOffsetMs;
    const deltaFromTargetStartMs = subAtMs - targetStartMs;

    const subAnchor: CueAnchor | null = target.anchor
      ? {
          ref: target.anchor.ref,
          offset_ms: Math.max(0, target.anchor.offset_ms + deltaFromTargetStartMs),
        }
      : null;
    const subCueAnchor: CueAnchor | undefined = target.cue_anchor
      ? {
          ref: target.cue_anchor.ref,
          offset_ms: Math.max(0, target.cue_anchor.offset_ms + deltaFromTargetStartMs),
        }
      : undefined;

    const subAudioChain = target.audio_chain ? structuredClone(target.audio_chain) : undefined;
    if (subAudioChain) {
      if (i > 0) subAudioChain.fade_in_ms = 0;
      if (i < keptIntervals.length - 1) subAudioChain.fade_out_ms = 0;
    }

    const subCue: LaneCue = {
      ...structuredClone(target),
      id: subId,
      anchor: subAnchor,
      ...(subCueAnchor ? { cue_anchor: subCueAnchor } : {}),
      at_ms: subAtMs,
      duration_ms: subDurMs,
      source_in_ms: iv.start,
      source_out_ms: iv.end,
      ...(subAudioChain ? { audio_chain: subAudioChain } : {}),
      envelopes: sliceEnvelopes(
        target.envelopes,
        origPieceOffsetMs,
        origPieceOffsetMs + subDurMs
      ),
    };
    if (!subCueAnchor) {
      delete subCue.cue_anchor;
    }
    newCues.push(subCue);
    timelineCursorMs += subDurMs;
  }

  const totalKeptTimelineMs = newCues.reduce((sum, c) => sum + c.duration_ms, 0);
  const savedSequenceMs = shouldRipple
    ? Math.max(0, target.duration_ms - totalKeptTimelineMs)
    : 0;
  const savedSourceMs = mergedCuts.reduce((sum, c) => sum + (c.end - c.start), 0);

  // Compute timeline cut intervals [startSeqMs .. endSeqMs] for cumulative shift calculation
  const cutSeqIntervals = mergedCuts.map((c) => {
    const st = targetStartMs + Math.round((c.start - targetSrcIn) / rate);
    const en = targetStartMs + Math.round((c.end - targetSrcIn) / rate);
    return { start_ms: st, end_ms: en, dur_ms: Math.max(0, en - st) };
  });

  const shiftBeforeSeqMs = (tMs: number): number => {
    if (!shouldRipple) return 0;
    if (tMs <= targetStartMs) return 0;
    if (tMs >= targetEndMs) return savedSequenceMs;
    let shift = 0;
    for (const ci of cutSeqIntervals) {
      if (tMs >= ci.end_ms) {
        shift += ci.dur_ms;
      } else if (tMs > ci.start_ms) {
        shift += tMs - ci.start_ms;
      }
    }
    return Math.min(savedSequenceMs, shift);
  };

  const shiftedCueIds = new Set<string>();

  // 1. Re-anchor any cues across all lanes that were anchored directly to `target.id`
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      if (cue.id === target.id) continue;
      const activeRef =
        cue.cue_anchor?.ref === target.id
          ? cue.cue_anchor
          : cue.anchor?.ref === target.id
            ? cue.anchor
            : null;
      if (!activeRef) continue;

      const localOffMs = activeRef.offset_ms;
      if (newCues.length === 0) {
        const newAt = Math.max(0, targetStartMs + Math.max(0, localOffMs - savedSequenceMs));
        cue.at_ms = newAt;
        cue.anchor = null;
        delete cue.cue_anchor;
        shiftedCueIds.add(cue.id);
      } else {
        const overhangMs = Math.max(0, localOffMs - target.duration_ms);
        const leadInMs = Math.min(0, localOffMs);
        const clampedLocalMs = Math.max(0, Math.min(target.duration_ms, localOffMs));
        const cueSrcMs = targetSrcIn + Math.round(clampedLocalMs * rate);
        const matchingSub =
          newCues.find(
            (sub) => cueSrcMs >= sub.source_in_ms! && cueSrcMs <= sub.source_out_ms!
          ) ??
          newCues.find((sub) => sub.source_in_ms! >= cueSrcMs) ??
          newCues[newCues.length - 1];
        const clampedSrc = Math.max(
          matchingSub.source_in_ms!,
          Math.min(matchingSub.source_out_ms!, cueSrcMs)
        );
        const newSubOffsetMs = Math.max(
          0,
          Math.round((clampedSrc - matchingSub.source_in_ms!) / rate) + overhangMs + leadInMs
        );
        cue.anchor = null;
        cue.cue_anchor = {
          ref: matchingSub.id,
          offset_ms: newSubOffsetMs,
        };
        const oldAt = cue.at_ms;
        cue.at_ms = Math.max(0, matchingSub.at_ms + newSubOffsetMs);
        if (cue.at_ms !== oldAt || matchingSub.id !== target.id) {
          shiftedCueIds.add(cue.id);
        }
      }
    }
  }

  // 2. Replace `target` on `targetLane` with `newCues` and ripple subsequent cues on `targetLane`
  targetLane.cues.splice(targetIdx, 1, ...newCues);
  const newCueIdSet = new Set(newCues.map((c) => c.id));

  if (shouldRipple && savedSequenceMs > 0) {
    for (const cue of targetLane.cues) {
      if (newCueIdSet.has(cue.id) || shiftedCueIds.has(cue.id)) continue;
      if (cue.cue_anchor) continue; // handled by syncCueAnchors
      const cueStart = resolveCueStartMs(seq, cue);
      const shift = shiftBeforeSeqMs(cueStart);
      if (shift > 0) {
        cue.at_ms = Math.max(0, cueStart - shift);
        if (cue.anchor) {
          cue.anchor.offset_ms = Math.max(0, cue.anchor.offset_ms - shift);
        }
        shiftedCueIds.add(cue.id);
      }
    }
  }

  // 3. Update any existing caption cues whose embedded words came from `target.id`
  if (shouldRipple) {
    for (const lane of seq.lanes) {
      if (lane.id === targetLane.id) continue;
      const updatedLaneCues: LaneCue[] = [];
      for (const cue of lane.cues) {
        if (
          cue.typography?.words &&
          cue.typography.words.some((w) => w.clip_id === target.id)
        ) {
          for (const tw of cue.typography.words) {
            if (tw.clip_id !== target.id || tw.excised) continue;
            const wMid = (tw.source_start_ms + tw.source_end_ms) / 2;
            const wDur = Math.max(1, tw.source_end_ms - tw.source_start_ms);
            const matchingSub = newCues.find((sub) => {
              const sIn = sub.source_in_ms ?? 0;
              const sOut = sub.source_out_ms ?? sIn;
              const ov = Math.min(sOut, tw.source_end_ms) - Math.max(sIn, tw.source_start_ms);
              return ov > 0 && ((wMid >= sIn && wMid < sOut) || ov >= wDur * 0.5);
            });
            if (!matchingSub) {
              tw.excised = true;
              tw.sequence_start_ms = null;
              tw.sequence_end_ms = null;
              tw.clip_id = null;
            } else {
              const sIn = matchingSub.source_in_ms ?? 0;
              const sOut = matchingSub.source_out_ms ?? sIn;
              const cStart = Math.max(sIn, tw.source_start_ms);
              const cEnd = Math.min(sOut, tw.source_end_ms);
              const seqSt = matchingSub.at_ms + Math.round((cStart - sIn) / rate);
              const seqEn = Math.max(
                seqSt + 1,
                matchingSub.at_ms +
                  Math.min(matchingSub.duration_ms, Math.round((cEnd - sIn) / rate))
              );
              tw.source_start_ms = cStart;
              tw.source_end_ms = cEnd;
              tw.sequence_start_ms = seqSt;
              tw.sequence_end_ms = seqEn;
              tw.clip_id = matchingSub.id;
              tw.excised = false;
            }
          }
          const activeWords = cue.typography.words.filter(
            (w) => !w.excised && w.sequence_start_ms !== null && w.sequence_end_ms !== null
          );
          if (activeWords.length === 0) {
            shiftedCueIds.add(cue.id);
            continue; // Drop completely excised caption cue
          }
          const newCapStart = activeWords[0].sequence_start_ms!;
          const newCapEnd = Math.max(
            newCapStart + minFrameDurMs,
            activeWords[activeWords.length - 1].sequence_end_ms!
          );
          cue.at_ms = newCapStart;
          cue.duration_ms = newCapEnd - newCapStart;
          cue.typography.text = activeWords.map((w) => w.word).join(" ");
          shiftedCueIds.add(cue.id);
        }
        updatedLaneCues.push(cue);
      }
      lane.cues = updatedLaneCues;
    }
  }

  // 4. Optional ripple across other lanes (`across === "all_lanes" || across === "all"`)
  if (shouldRipple && savedSequenceMs > 0 && (across === "all_lanes" || across === "all")) {
    for (const lane of seq.lanes) {
      if (lane.id === targetLane.id || lane.locked) continue;
      for (const cue of lane.cues) {
        if (shiftedCueIds.has(cue.id) || cue.cue_anchor) continue;
        if (across === "all" && cue.anchor) continue; // Spine reflow will shift spine-anchored cues
        const cueStart = resolveCueStartMs(seq, cue);
        const shift = shiftBeforeSeqMs(cueStart);
        if (shift > 0) {
          cue.at_ms = Math.max(0, cueStart - shift);
          if (cue.anchor) {
            cue.anchor.offset_ms = Math.max(0, cue.anchor.offset_ms - shift);
          }
          shiftedCueIds.add(cue.id);
        }
      }
    }
  }

  // 5. Optional ripple across primary spine (`across === "all" || across === "spine"`)
  if (shouldRipple && savedSequenceMs > 0 && (across === "all" || across === "spine")) {
    const existingSpineIds = new Set(seq.spine.clips.map((c) => c.id));
    const nextSpineClips: SpineClip[] = [];

    for (const clip of seq.spine.clips) {
      const clipStart = clip.timeline_in_ms;
      const clipEnd = clipStart + clip.duration_ms;
      const overlappingCuts = cutSeqIntervals.filter(
        (ci) => ci.end_ms > clipStart && ci.start_ms < clipEnd
      );
      if (overlappingCuts.length === 0) {
        nextSpineClips.push(clip);
        continue;
      }

      const clipCutSrcRanges = overlappingCuts
        .map((ci) => ({
          start: Math.max(
            clip.source_in_ms,
            sequenceMsToSourceMs(clip, Math.max(clipStart, ci.start_ms))
          ),
          end: Math.min(
            clip.source_out_ms,
            sequenceMsToSourceMs(clip, Math.min(clipEnd, ci.end_ms))
          ),
        }))
        .filter((r) => r.end > r.start)
        .sort((a, b) => a.start - b.start);

      let cCursor = clip.source_in_ms;
      const cKept: Array<{ start: number; end: number }> = [];
      for (const cr of clipCutSrcRanges) {
        if (cr.start > cCursor) cKept.push({ start: cCursor, end: cr.start });
        cCursor = Math.max(cCursor, cr.end);
      }
      if (cCursor < clip.source_out_ms) {
        cKept.push({ start: cCursor, end: clip.source_out_ms });
      }

      const validClipIntervals = cKept.filter((iv) => {
        const probe: SpineClip = {
          ...structuredClone(clip),
          source_in_ms: iv.start,
          source_out_ms: iv.end,
        };
        return computeClipDurationMs(probe) >= minFrameDurMs;
      });

      const clipSpan = Math.max(1, clip.source_out_ms - clip.source_in_ms);
      const generatedSubClips: SpineClip[] = [];
      for (let i = 0; i < validClipIntervals.length; i++) {
        const iv = validClipIntervals[i];
        const subClipId =
          i === 0 ? clip.id : allocateNextHandle(existingSpineIds, "sp", seq);
        existingSpineIds.add(subClipId);
        const subRamp = sliceSpeedRamp(
          clip.playback.speed_ramp,
          clipSpan,
          clip.playback.rate,
          iv.start - clip.source_in_ms,
          iv.end - clip.source_in_ms
        );
        const subClip: SpineClip = {
          ...structuredClone(clip),
          id: subClipId,
          source_in_ms: iv.start,
          source_out_ms: iv.end,
          playback: { ...clip.playback, speed_ramp: subRamp },
          duration_ms: 1,
          transition_out: i === validClipIntervals.length - 1 ? clip.transition_out : null,
          envelopes: [],
        };
        subClip.duration_ms = computeClipDurationMs(subClip);
        const localSt = sourceMsToClipLocalMs(clip, iv.start);
        subClip.envelopes = sliceEnvelopes(
          clip.envelopes,
          localSt,
          localSt + subClip.duration_ms
        );
        if (clip.treatments.reframe.focal_points.length > 0) {
          subClip.treatments.reframe.focal_points = sliceReframeFocalPoints(
            clip.treatments.reframe.focal_points,
            localSt,
            localSt + subClip.duration_ms
          );
        }
        generatedSubClips.push(subClip);
      }

      // Re-anchor spine-anchored cues on this clip
      if (generatedSubClips.length > 0) {
        for (const lane of seq.lanes) {
          for (const cue of lane.cues) {
            if (cue.anchor && cue.anchor.ref === clip.id) {
              const cueSrcMs = clipLocalMsToSourceMs(clip, cue.anchor.offset_ms);
              const matchingSub =
                generatedSubClips.find(
                  (sub) => cueSrcMs >= sub.source_in_ms && cueSrcMs <= sub.source_out_ms
                ) ??
                generatedSubClips.find((sub) => sub.source_in_ms >= cueSrcMs) ??
                generatedSubClips[generatedSubClips.length - 1];
              const clampedSrc = Math.max(
                matchingSub.source_in_ms,
                Math.min(matchingSub.source_out_ms, cueSrcMs)
              );
              cue.anchor = {
                ref: matchingSub.id,
                offset_ms: Math.max(0, sourceMsToClipLocalMs(matchingSub, clampedSrc)),
              };
              shiftedCueIds.add(cue.id);
            }
          }
        }
      }
      nextSpineClips.push(...generatedSubClips);
    }

    seq.spine.clips = nextSpineClips;
    reflowSpine(seq);
  }

  syncSequenceHandleCounters(seq);
  syncCueAnchors(seq);

  return {
    newCues,
    shiftedCueIds: Array.from(shiftedCueIds),
    savedSequenceMs,
    savedSourceMs,
  };
}

/**
 * Excises (cuts out) one or more time intervals from an audio or video media lane cue
 * (`voiceover`, `music`, `sfx`, `broll`) in a single atomic transaction.
 *
 * - Supports `"source"` (default), `"sequence"`, and `"clip_local"` / `"cue_local"` coordinate spaces.
 * - By default (`ripple=true`, `across="lane"`), closes the excised gap on the target lane,
 *   shifts subsequent cues on the same lane, re-anchors any cues anchored to the excised cue
 *   (or to shifted cues), and updates any pre-generated caption cues bound to the excised cue.
 * - `across="all_lanes"` also ripples unlocked cues on other lanes; `across="all"` (or `"spine"`)
 *   additionally excises the corresponding timeline spans from the primary spine.
 * - Visual non-stream cues (`composition`, `title`, `caption`, or still graphics) are rejected with
 *   `CUTHOL-G310` (`INVALID_CUE_EXCISE_KIND`).
 */
export function exciseLaneCueRanges(options: {
  workspaceDir: string;
  cueId: string;
  ranges: Array<{ start_ms: number; end_ms: number }>;
  coordinateSpace?: TimeCoordinateSpace | "cue_local";
  isSourceTime?: boolean;
  ripple?: boolean;
  across?: LaneExciseRippleAcross;
}): {
  remainingCues: LaneCue[];
  shiftedCueIds: string[];
  savedSequenceMs: number;
  savedSourceMs: number;
  across: LaneExciseRippleAcross;
  revision: number;
  verification: VerificationReport;
} {
  const { coordSpace, across } = resolveLaneExciseRequest(options);

  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `lane.excise(${options.cueId},${coordSpace},across=${across})`,
    (seq) => applyLaneCueExciseToSequence(seq, options)
  );

  return {
    remainingCues: result.newCues,
    shiftedCueIds: result.shiftedCueIds,
    savedSequenceMs: result.savedSequenceMs,
    savedSourceMs: result.savedSourceMs,
    across,
    revision,
    verification,
  };
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
