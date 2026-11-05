/**
 * Cuthol Declarative Cue Sheet Engine (`src/sequence/cuesheet.ts`).
 *
 * Allows an AI agent to declare desired `stage`, `spine`, and `lanes` state in a single
 * concise `CutholCueSheet` document (`cuthol.cues.json`), inspect a structural diff
 * (`diffCueSheet`), perform a dry-run validation (`planCueSheet`), or atomically apply
 * it (`applyCueSheet`) while preserving existing clip/cue handles.
 */

import { resolveCueStartMs } from "../core/timeline.js";
import {
  allocateNextHandle,
  AspectPreset,
  createDefaultAudioChain,
  createDefaultPlacement,
  createDefaultTreatments,
  CueAnchor,
  CutholSequence,
  HyperFramesMountSpec,
  LaneCue,
  LaneKind,
  ParameterEnvelope,
  resolveAspectDimensions,
  SpatialPlacement,
  SpeedRampPoint,
  SpineClip,
  syncSequenceHandleCounters,
  TransitionSpec,
  TypographySpec,
  VisualTreatments,
} from "../core/schema.js";
import { assertValidEasing } from "../core/easing.js";
import { loadSequence, WorkspacePaths } from "../core/workspace.js";
import { commitVerifiedMutation, VerificationReport, verifySequence } from "../verify/gates.js";
import { syncCueAnchors } from "./lanes.js";
import { computeClipDurationMs, reflowSpine } from "./spine.js";

export interface CueSheetSpineEntry {
  id: string;
  op?: "upsert" | "delete";
  asset_handle?: string;
  source_in_ms?: number;
  source_out_ms?: number;
  rate?: number;
  preserve_pitch?: boolean;
  speed_ramp?: SpeedRampPoint[] | null;
  placement?: Partial<SpatialPlacement>;
  gain_db?: number;
  muted?: boolean;
  fade_in_ms?: number;
  fade_out_ms?: number;
  denoise?: boolean;
  voice_clarity?: boolean;
  loudness_target_lufs?: number | null;
  true_peak_ceiling_dbtp?: number;
  treatments?: Partial<VisualTreatments>;
  transition_out?: TransitionSpec | null;
  envelopes?: ParameterEnvelope[];
}

export interface CueSheetCueEntry {
  id?: string;
  lane_id: string;
  op?: "upsert" | "delete";
  kind?: LaneKind;
  asset_handle?: string;
  anchor?: CueAnchor | null;
  at_ms?: number;
  duration_ms?: number;
  source_in_ms?: number;
  source_out_ms?: number;
  placement?: Partial<SpatialPlacement>;
  typography?: Partial<TypographySpec>;
  composition?: HyperFramesMountSpec;
  gain_db?: number;
  muted?: boolean;
  envelopes?: ParameterEnvelope[];
}

export interface CutholCueSheet {
  title?: string;
  stage?: {
    aspect?: AspectPreset;
    fps?: number;
    backdrop_color?: string;
    magnetic_spine?: boolean;
  };
  spine?: CueSheetSpineEntry[];
  cues?: CueSheetCueEntry[];
}

export interface CueSheetDiff {
  stage_changed: boolean;
  spine_added: string[];
  spine_updated: string[];
  spine_removed: string[];
  cues_added: string[];
  cues_updated: string[];
  cues_removed: string[];
}

/**
 * Applies a declarative `CutholCueSheet` onto a cloned `CutholSequence` in memory
 * and returns both the mutated sequence and a structured `CueSheetDiff`.
 */
/**
 * Cue-sheet easing entry check (CUTHOL-G120). Unknown easing names and
 * `hold` in transitions are rejected here, mirroring the verify gate.
 */
function assertCueSheetEasingsValid(sheet: CutholCueSheet): void {
  for (const entry of sheet.spine ?? []) {
    for (const env of entry.envelopes ?? []) {
      for (const pt of env.points ?? []) {
        assertValidEasing(`${entry.id} ${env.parameter}@${pt.offset_ms}ms`, pt.easing, pt.bezier);
      }
    }
    if (entry.transition_out) {
      assertValidEasing(entry.id, entry.transition_out.easing, entry.transition_out.bezier, {
        allowHold: false,
      });
    }
  }
  for (const entry of sheet.cues ?? []) {
    for (const env of entry.envelopes ?? []) {
      for (const pt of env.points ?? []) {
        assertValidEasing(
          `${entry.id ?? entry.lane_id} ${env.parameter}@${pt.offset_ms}ms`,
          pt.easing,
          pt.bezier
        );
      }
    }
  }
}

export function mergeCueSheetIntoSequence(
  baseSeq: CutholSequence,
  sheet: CutholCueSheet
): { nextSeq: CutholSequence; diff: CueSheetDiff } {
  assertCueSheetEasingsValid(sheet);
  const seq: CutholSequence = structuredClone(baseSeq);
  syncSequenceHandleCounters(seq);
  const diff: CueSheetDiff = {
    stage_changed: false,
    spine_added: [],
    spine_updated: [],
    spine_removed: [],
    cues_added: [],
    cues_updated: [],
    cues_removed: [],
  };

  if (sheet.title && sheet.title !== seq.meta.title) {
    seq.meta.title = sheet.title;
    diff.stage_changed = true;
  }

  if (sheet.stage) {
    if (sheet.stage.aspect && sheet.stage.aspect !== seq.stage.aspect) {
      const dims = resolveAspectDimensions(sheet.stage.aspect);
      seq.stage.aspect = sheet.stage.aspect;
      seq.stage.width = dims.width;
      seq.stage.height = dims.height;
      diff.stage_changed = true;
    }
    if (
      sheet.stage.fps !== undefined &&
      Number.isFinite(sheet.stage.fps) &&
      sheet.stage.fps >= 1 &&
      sheet.stage.fps <= 240 &&
      sheet.stage.fps !== seq.stage.fps
    ) {
      seq.stage.fps = sheet.stage.fps;
      diff.stage_changed = true;
    }
    if (sheet.stage.backdrop_color && sheet.stage.backdrop_color !== seq.stage.backdrop.color) {
      seq.stage.backdrop.color = sheet.stage.backdrop_color;
      diff.stage_changed = true;
    }
    if (sheet.stage.magnetic_spine !== undefined && sheet.stage.magnetic_spine !== seq.spine.magnetic) {
      seq.spine.magnetic = sheet.stage.magnetic_spine;
      diff.stage_changed = true;
    }
  }

  // Merge Spine Entries (preserving existing IDs, unmentioned clips, and explicit ordering)
  if (sheet.spine) {
    const existingById = new Map(seq.spine.clips.map((c) => [c.id, c]));
    const upsertedExistingClips: SpineClip[] = [];
    const upsertedExistingIds = new Set<string>();
    const prefixNewClipsBySlot: SpineClip[][] = [];
    let pendingNewClips: SpineClip[] = [];
    const deletedSpineIds = new Set<string>();

    for (const entry of sheet.spine) {
      if (entry.op === "delete") {
        if (existingById.has(entry.id) && !deletedSpineIds.has(entry.id)) {
          deletedSpineIds.add(entry.id);
          diff.spine_removed.push(entry.id);
        }
        continue;
      }

      const prev = existingById.get(entry.id);
      if (prev) {
        const updated: SpineClip = structuredClone(prev);
        if (entry.asset_handle !== undefined) updated.asset_handle = entry.asset_handle;
        if (entry.source_in_ms !== undefined) updated.source_in_ms = entry.source_in_ms;
        if (entry.source_out_ms !== undefined) updated.source_out_ms = entry.source_out_ms;
        if (entry.rate !== undefined) updated.playback.rate = entry.rate;
        if (entry.preserve_pitch !== undefined) updated.playback.preserve_pitch = entry.preserve_pitch;
        if (entry.speed_ramp !== undefined) updated.playback.speed_ramp = entry.speed_ramp;
        if (entry.placement) Object.assign(updated.placement, entry.placement);
        if (entry.gain_db !== undefined) updated.audio_chain.gain_db = entry.gain_db;
        if (entry.muted !== undefined) updated.audio_chain.muted = entry.muted;
        if (entry.fade_in_ms !== undefined) updated.audio_chain.fade_in_ms = entry.fade_in_ms;
        if (entry.fade_out_ms !== undefined) updated.audio_chain.fade_out_ms = entry.fade_out_ms;
        if (entry.denoise !== undefined) updated.audio_chain.denoise.enabled = entry.denoise;
        if (entry.voice_clarity !== undefined) updated.audio_chain.voice_clarity.enabled = entry.voice_clarity;
        if (entry.loudness_target_lufs !== undefined) {
          updated.audio_chain.loudness_target_lufs = entry.loudness_target_lufs;
        }
        if (entry.true_peak_ceiling_dbtp !== undefined) {
          updated.audio_chain.true_peak_ceiling_dbtp = entry.true_peak_ceiling_dbtp;
        }
        if (entry.treatments) {
          updated.treatments = { ...updated.treatments, ...entry.treatments };
        }
        if (entry.transition_out !== undefined) updated.transition_out = entry.transition_out;
        if (entry.envelopes !== undefined) updated.envelopes = entry.envelopes;
        updated.duration_ms = computeClipDurationMs(updated);

        prefixNewClipsBySlot.push(pendingNewClips);
        pendingNewClips = [];
        upsertedExistingClips.push(updated);
        upsertedExistingIds.add(entry.id);
        if (JSON.stringify(prev) !== JSON.stringify(updated)) {
          diff.spine_updated.push(entry.id);
        }
      } else {
        const assetHandle = entry.asset_handle ?? "";
        const asset = seq.library.find((x) => x.handle === assetHandle);
        const sourceIn = entry.source_in_ms ?? 0;
        const sourceOut = entry.source_out_ms ?? asset?.probe.duration_ms ?? 1000;
        const rate = entry.rate ?? 1.0;

        const created: SpineClip = {
          id: entry.id,
          asset_handle: assetHandle,
          source_in_ms: sourceIn,
          source_out_ms: sourceOut,
          timeline_in_ms: 0,
          duration_ms: 1,
          playback: {
            rate,
            preserve_pitch: entry.preserve_pitch ?? true,
            speed_ramp: entry.speed_ramp ?? null,
          },
          placement: { ...createDefaultPlacement(), ...(entry.placement ?? {}) },
          audio_chain: createDefaultAudioChain(),
          treatments: { ...createDefaultTreatments(), ...(entry.treatments ?? {}) },
          transition_out: entry.transition_out ?? null,
          envelopes: entry.envelopes ?? [],
        };
        if (entry.gain_db !== undefined) created.audio_chain.gain_db = entry.gain_db;
        if (entry.muted !== undefined) created.audio_chain.muted = entry.muted;
        if (entry.fade_in_ms !== undefined) created.audio_chain.fade_in_ms = entry.fade_in_ms;
        if (entry.fade_out_ms !== undefined) created.audio_chain.fade_out_ms = entry.fade_out_ms;
        if (entry.denoise !== undefined) created.audio_chain.denoise.enabled = entry.denoise;
        if (entry.voice_clarity !== undefined) created.audio_chain.voice_clarity.enabled = entry.voice_clarity;
        if (entry.loudness_target_lufs !== undefined) {
          created.audio_chain.loudness_target_lufs = entry.loudness_target_lufs;
        }
        if (entry.true_peak_ceiling_dbtp !== undefined) {
          created.audio_chain.true_peak_ceiling_dbtp = entry.true_peak_ceiling_dbtp;
        }
        created.duration_ms = computeClipDurationMs(created);

        pendingNewClips.push(created);
        diff.spine_added.push(entry.id);
      }
    }

    const mergedSpineClips: SpineClip[] = [];
    let existingSlotCursor = 0;
    for (const existingClip of seq.spine.clips) {
      if (deletedSpineIds.has(existingClip.id)) continue;
      if (upsertedExistingIds.has(existingClip.id)) {
        if (existingSlotCursor < upsertedExistingClips.length) {
          const prefixNew = prefixNewClipsBySlot[existingSlotCursor] ?? [];
          mergedSpineClips.push(...prefixNew, upsertedExistingClips[existingSlotCursor]);
          existingSlotCursor++;
        }
      } else {
        mergedSpineClips.push(existingClip);
      }
    }
    while (existingSlotCursor < upsertedExistingClips.length) {
      const prefixNew = prefixNewClipsBySlot[existingSlotCursor] ?? [];
      mergedSpineClips.push(...prefixNew, upsertedExistingClips[existingSlotCursor]);
      existingSlotCursor++;
    }
    if (pendingNewClips.length > 0) {
      mergedSpineClips.push(...pendingNewClips);
    }

    // Track if spine order changed among updated clips
    const prevOrder = seq.spine.clips.filter((c) => !deletedSpineIds.has(c.id)).map((c) => c.id);
    const nextOrder = mergedSpineClips.filter((c) => existingById.has(c.id)).map((c) => c.id);
    if (JSON.stringify(prevOrder) !== JSON.stringify(nextOrder)) {
      for (const id of nextOrder) {
        if (!diff.spine_updated.includes(id)) {
          diff.spine_updated.push(id);
        }
      }
    }

    seq.spine.clips = mergedSpineClips;
    reflowSpine(seq);
  }

  // Merge Lane Cues (preserving ID even if moved between lanes!)
  if (sheet.cues) {
    for (const entry of sheet.cues) {
      const allCueIds = seq.lanes.flatMap((l) => l.cues.map((c) => c.id));
      const resolvedId =
        entry.id && entry.id.trim() && entry.id.trim() !== "auto"
          ? entry.id.trim()
          : allocateNextHandle(allCueIds, "cue", seq);

      // Locate existing cue across all lanes
      let prevCue: LaneCue | undefined;
      let prevLaneId: string | undefined;
      for (const lane of seq.lanes) {
        const idx = lane.cues.findIndex((c) => c.id === resolvedId);
        if (idx >= 0) {
          prevCue = lane.cues[idx];
          prevLaneId = lane.id;
          lane.cues.splice(idx, 1);
          break;
        }
      }

      if (entry.op === "delete") {
        if (prevCue) diff.cues_removed.push(resolvedId);
        continue;
      }

      let targetLane = seq.lanes.find((l) => l.id === entry.lane_id);
      if (!targetLane) {
        const laneKind = entry.kind ?? prevCue?.kind ?? "title";
        targetLane = {
          id: entry.lane_id,
          kind: laneKind,
          z_index:
            laneKind === "music" || laneKind === "sfx" || laneKind === "voiceover" ? -10 : 15,
          muted: false,
          locked: false,
          cues: [],
        };
        seq.lanes.push(targetLane);
      }

      if (prevCue) {
        const updated: LaneCue = structuredClone(prevCue);
        if (entry.kind !== undefined) updated.kind = entry.kind;
        if (entry.asset_handle !== undefined) updated.asset_handle = entry.asset_handle;
        if (entry.anchor !== undefined) {
          if (entry.anchor === null) {
            updated.anchor = null;
            delete updated.cue_anchor;
          } else {
            const isSpine = seq.spine.clips.some((c) => c.id === entry.anchor!.ref);
            const isCue = !isSpine && seq.lanes.some((l) => l.cues.some((c) => c.id === entry.anchor!.ref));
            if (isCue) {
              updated.anchor = null;
              updated.cue_anchor = entry.anchor;
            } else {
              updated.anchor = entry.anchor;
              delete updated.cue_anchor;
            }
          }
        }
        if (entry.at_ms !== undefined) {
          updated.at_ms = entry.at_ms;
          if (entry.anchor === undefined && (prevCue.anchor !== null || prevCue.cue_anchor) && entry.at_ms !== prevCue.at_ms) {
            updated.anchor = null;
            delete updated.cue_anchor;
          }
        }
        if (entry.duration_ms !== undefined) updated.duration_ms = entry.duration_ms;
        if (entry.source_in_ms !== undefined) updated.source_in_ms = entry.source_in_ms;
        if (entry.source_out_ms !== undefined) updated.source_out_ms = entry.source_out_ms;
        if (entry.placement) Object.assign(updated.placement, entry.placement);
        if (entry.typography) {
          updated.typography = {
            ...updated.typography,
            text: entry.typography.text ?? updated.typography?.text ?? "",
            words:
              entry.typography.words !== undefined
                ? entry.typography.words
                : updated.typography?.words,
            font_family: entry.typography.font_family ?? updated.typography?.font_family ?? "Inter",
            font_size_px: entry.typography.font_size_px ?? updated.typography?.font_size_px ?? 48,
            font_weight: entry.typography.font_weight ?? updated.typography?.font_weight ?? 700,
            color_hex: entry.typography.color_hex ?? updated.typography?.color_hex ?? "#FFFFFF",
            active_word_color_hex:
              entry.typography.active_word_color_hex !== undefined
                ? entry.typography.active_word_color_hex
                : updated.typography?.active_word_color_hex,
            stroke_color_hex:
              entry.typography.stroke_color_hex !== undefined
                ? entry.typography.stroke_color_hex
                : updated.typography?.stroke_color_hex ?? "#000000",
            stroke_width_px: entry.typography.stroke_width_px ?? updated.typography?.stroke_width_px ?? 2,
            box_color_hex:
              entry.typography.box_color_hex !== undefined
                ? entry.typography.box_color_hex
                : updated.typography?.box_color_hex ?? null,
            box_opacity: entry.typography.box_opacity ?? updated.typography?.box_opacity ?? 0,
            align: entry.typography.align ?? updated.typography?.align ?? "center",
            max_width_pct: entry.typography.max_width_pct ?? updated.typography?.max_width_pct ?? 76,
          };
        }
        if (entry.composition !== undefined) updated.composition = entry.composition;
        if (entry.gain_db !== undefined) {
          if (!updated.audio_chain) updated.audio_chain = createDefaultAudioChain();
          updated.audio_chain.gain_db = entry.gain_db;
        }
        if (entry.muted !== undefined) {
          if (!updated.audio_chain) updated.audio_chain = createDefaultAudioChain();
          updated.audio_chain.muted = entry.muted;
        }
        if (entry.envelopes !== undefined) updated.envelopes = entry.envelopes;
        if (updated.anchor) {
          updated.at_ms = resolveCueStartMs(seq, updated);
        }

        targetLane.cues.push(updated);
        if (prevLaneId !== targetLane.id || JSON.stringify(prevCue) !== JSON.stringify(updated)) {
          diff.cues_updated.push(resolvedId);
        }
      } else {
        const kind = entry.kind ?? targetLane.kind;
        let spineAnchor: CueAnchor | null = entry.anchor ?? null;
        let cueAnchor: CueAnchor | undefined;
        if (entry.anchor) {
          const isSpine = seq.spine.clips.some((c) => c.id === entry.anchor!.ref);
          const isCue = !isSpine && seq.lanes.some((l) => l.cues.some((c) => c.id === entry.anchor!.ref));
          if (isCue) {
            spineAnchor = null;
            cueAnchor = entry.anchor;
          }
        }
        const created: LaneCue = {
          id: resolvedId,
          kind,
          asset_handle: entry.asset_handle,
          anchor: spineAnchor,
          ...(cueAnchor ? { cue_anchor: cueAnchor } : {}),
          at_ms: entry.at_ms ?? 0,
          duration_ms: entry.duration_ms ?? 2000,
          source_in_ms: entry.source_in_ms,
          source_out_ms: entry.source_out_ms,
          placement: { ...createDefaultPlacement(), ...(entry.placement ?? {}) },
          audio_chain:
            kind === "music" ||
            kind === "sfx" ||
            kind === "voiceover" ||
            kind === "broll" ||
            entry.gain_db !== undefined ||
            entry.muted !== undefined
              ? createDefaultAudioChain()
              : undefined,
          typography: entry.typography
            ? {
                text: entry.typography.text ?? "",
                words: entry.typography.words,
                font_family: entry.typography.font_family ?? "Inter",
                font_size_px: entry.typography.font_size_px ?? (kind === "title" ? 56 : 44),
                font_weight: entry.typography.font_weight ?? 700,
                color_hex: entry.typography.color_hex ?? "#FFFFFF",
                active_word_color_hex: entry.typography.active_word_color_hex,
                stroke_color_hex: entry.typography.stroke_color_hex ?? "#000000",
                stroke_width_px: entry.typography.stroke_width_px ?? 2,
                box_color_hex: entry.typography.box_color_hex ?? null,
                box_opacity: entry.typography.box_opacity ?? 0,
                align: entry.typography.align ?? "center",
                max_width_pct: entry.typography.max_width_pct ?? 76,
              }
            : undefined,
          composition: entry.composition,
          envelopes: entry.envelopes ?? [],
        };
        if (entry.gain_db !== undefined) {
          if (!created.audio_chain) created.audio_chain = createDefaultAudioChain();
          created.audio_chain.gain_db = entry.gain_db;
        }
        if (entry.muted !== undefined) {
          if (!created.audio_chain) created.audio_chain = createDefaultAudioChain();
          created.audio_chain.muted = entry.muted;
        }

        targetLane.cues.push(created);
        syncSequenceHandleCounters(seq, [resolvedId]);
        diff.cues_added.push(resolvedId);
      }
    }
  }

  reflowSpine(seq);
  syncSequenceHandleCounters(seq);
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      cue.at_ms = resolveCueStartMs(seq, cue);
    }
  }
  syncCueAnchors(seq);

  return { nextSeq: seq, diff };
}

export function planCueSheet(
  workspaceDir: string,
  sheet: CutholCueSheet
): { diff: CueSheetDiff; verification: VerificationReport; would_commit: boolean } {
  const { paths, sequence } = loadSequence(workspaceDir);
  const { nextSeq, diff } = mergeCueSheetIntoSequence(sequence, sheet);
  const verification = verifySequence(nextSeq, paths);
  return {
    diff,
    verification,
    would_commit: verification.ok,
  };
}

export function applyCueSheet(
  workspaceDir: string,
  sheet: CutholCueSheet
): { diff: CueSheetDiff; revision: number; verification: VerificationReport } {
  let computedDiff!: CueSheetDiff;
  const { revision, verification } = commitVerifiedMutation(
    workspaceDir,
    "cue.apply",
    (seq, _paths: WorkspacePaths) => {
      const { nextSeq, diff } = mergeCueSheetIntoSequence(seq, sheet);
      computedDiff = diff;
      Object.assign(seq, nextSeq);
    }
  );
  return { diff: computedDiff, revision, verification };
}

export function exportSequenceToCueSheet(seq: CutholSequence): CutholCueSheet {
  return {
    title: seq.meta.title,
    stage: {
      aspect: seq.stage.aspect,
      fps: seq.stage.fps,
      backdrop_color: seq.stage.backdrop.color,
      magnetic_spine: seq.spine.magnetic,
    },
    spine: seq.spine.clips.map((c) => ({
      id: c.id,
      op: "upsert",
      asset_handle: c.asset_handle,
      source_in_ms: c.source_in_ms,
      source_out_ms: c.source_out_ms,
      rate: c.playback.rate,
      preserve_pitch: c.playback.preserve_pitch,
      speed_ramp: c.playback.speed_ramp,
      placement: c.placement,
      gain_db: c.audio_chain.gain_db,
      muted: c.audio_chain.muted,
      fade_in_ms: c.audio_chain.fade_in_ms,
      fade_out_ms: c.audio_chain.fade_out_ms,
      denoise: c.audio_chain.denoise.enabled,
      voice_clarity: c.audio_chain.voice_clarity.enabled,
      loudness_target_lufs: c.audio_chain.loudness_target_lufs,
      true_peak_ceiling_dbtp: c.audio_chain.true_peak_ceiling_dbtp,
      treatments: c.treatments,
      transition_out: c.transition_out,
      envelopes: c.envelopes,
    })),
    cues: seq.lanes.flatMap((lane) =>
      lane.cues.map((cue) => ({
        id: cue.id,
        lane_id: lane.id,
        op: "upsert" as const,
        kind: cue.kind,
        asset_handle: cue.asset_handle,
        anchor: cue.anchor ?? cue.cue_anchor ?? null,
        at_ms: cue.at_ms,
        duration_ms: cue.duration_ms,
        source_in_ms: cue.source_in_ms,
        source_out_ms: cue.source_out_ms,
        placement: cue.placement,
        typography: cue.typography,
        composition: cue.composition,
        gain_db: cue.audio_chain?.gain_db,
        muted: cue.audio_chain?.muted,
        envelopes: cue.envelopes,
      }))
    ),
  };
}
