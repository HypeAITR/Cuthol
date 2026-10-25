// Subject-tracking reframe of spine clips (split out of spine.ts).
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  CutholSequence, ParameterEnvelope
} from "../core/schema.js";
import { loadSequence } from "../core/workspace.js";
import {
  analyzeAssetSubjectTrack,
  planCalmReframeTrajectory,
  PlannedClipReframe,
  SubjectTrackAnalysis,
} from "../library/subject.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";
import { sourceMsToClipLocalMs, clipLocalMsToSourceMs } from "./spine_time.js";

export interface ReframeSpineOptions {
  workspaceDir: string;
  clipIds?: string[];
  mode?: "subject_track" | "center_lock" | "off";
  deadbandPct?: number;
  fixedCenterXPct?: number;
  manualPoints?: Array<{ offset_ms: number; center_x_pct: number; center_y_pct?: number }>;
  replaceManualPoints?: boolean;
  sampleFps?: number;
  dryRun?: boolean;
}

export interface ReframeSpineResult {
  dry_run: boolean;
  mode: "subject_track" | "center_lock" | "off";
  clips: PlannedClipReframe[];
  override_hint: string;
  revision: number;
  verification?: VerificationReport;
}

/**
 * Tracks the visual subject (speaker face or moving foreground object) across one or more
 * spine clips and configures `treatments.reframe`, `placement.scale_x`, `placement.x_pct`,
 * and `envelopes` (`placement.x_pct`) so that `brief`, `monitor`, and `render` all show
 * the exact same smooth, jitter-free subject-centered framing.
 */
export function reframeSpineClips(options: ReframeSpineOptions): ReframeSpineResult {
  const { sequence: initialSeq } = loadSequence(options.workspaceDir);
  const mode = options.mode ?? "subject_track";
  const dryRun = options.dryRun ?? false;

  const targetIds =
    options.clipIds && options.clipIds.length > 0
      ? options.clipIds
      : initialSeq.spine.clips.map((c) => c.id);

  if (targetIds.length === 0) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE("sp_01"));
  }

  for (const cid of targetIds) {
    if (!initialSeq.spine.clips.some((c) => c.id === cid)) {
      throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(cid));
    }
  }

  // Pre-analyze required library assets once (cached by SHA-256 in .cuthol/blobs)
  const trackByHandle = new Map<string, SubjectTrackAnalysis>();
  const needsAutoAnalysis =
    mode === "subject_track" &&
    !(options.manualPoints && options.manualPoints.length > 0 && options.replaceManualPoints);

  if (needsAutoAnalysis) {
    for (const cid of targetIds) {
      const clip = initialSeq.spine.clips.find((c) => c.id === cid)!;
      if (!trackByHandle.has(clip.asset_handle)) {
        const asset = initialSeq.library.find((x) => x.handle === clip.asset_handle);
        if (asset && asset.probe.has_video) {
          const track = analyzeAssetSubjectTrack({
            workspaceDir: options.workspaceDir,
            handle: clip.asset_handle,
            sampleFps: options.sampleFps,
          });
          trackByHandle.set(clip.asset_handle, track);
        }
      }
    }
  }

  const buildPlansForSequence = (seq: CutholSequence, applyMutations: boolean): PlannedClipReframe[] => {
    const plans: PlannedClipReframe[] = [];
    for (const cid of targetIds) {
      const clip = seq.spine.clips.find((c) => c.id === cid);
      if (!clip) continue;
      const asset = seq.library.find((x) => x.handle === clip.asset_handle);
      const assetW = asset?.probe.width ?? seq.stage.width;
      const assetH = asset?.probe.height ?? seq.stage.height;
      const track = trackByHandle.get(clip.asset_handle);

      // If patching existing reframe focal_points with manualPoints (without --replace),
      // merge manualPoints onto existing focal_points so cumulative manual edits are preserved.
      let effectiveManualPoints = options.manualPoints;
      let effectiveReplace = options.replaceManualPoints ?? false;

      if (
        options.manualPoints &&
        options.manualPoints.length > 0 &&
        !options.replaceManualPoints &&
        clip.treatments.reframe.enabled &&
        clip.treatments.reframe.focal_points.length > 0
      ) {
        const merged = clip.treatments.reframe.focal_points.map((fp) => ({
          offset_ms: fp.offset_ms,
          center_x_pct: fp.center_x_pct,
          center_y_pct: fp.center_y_pct,
        }));
        for (const mp of options.manualPoints) {
          const offMs = Math.max(0, Math.min(clip.duration_ms, Math.round(mp.offset_ms)));
          for (let j = merged.length - 1; j >= 0; j--) {
            if (Math.abs(merged[j].offset_ms - offMs) <= 1200) {
              merged.splice(j, 1);
            }
          }
          merged.push({
            offset_ms: offMs,
            center_x_pct: mp.center_x_pct,
            center_y_pct: mp.center_y_pct ?? 45,
          });
        }
        effectiveManualPoints = merged;
        effectiveReplace = true;
      }

      const plan = planCalmReframeTrajectory({
        clip,
        stageWidth: seq.stage.width,
        stageHeight: seq.stage.height,
        assetWidth: assetW,
        assetHeight: assetH,
        track,
        mode,
        deadbandPct: options.deadbandPct,
        fixedCenterXPct: options.fixedCenterXPct,
        manualPoints: effectiveManualPoints,
        replaceManualPoints: effectiveReplace,
        sourceMsToClipLocalMsFn: sourceMsToClipLocalMs,
        clipLocalMsToSourceMsFn: clipLocalMsToSourceMs,
      });

      if (applyMutations) {
        if (mode === "off") {
          clip.treatments.reframe = {
            enabled: false,
            mode: "center_lock",
            focal_points: [],
          };
          clip.placement.scale_x = 1;
          clip.placement.scale_y = 1;
          clip.placement.x_pct = 0;
          clip.envelopes = clip.envelopes.filter((e) => e.parameter !== "placement.x_pct");
        } else {
          clip.treatments.reframe = {
            enabled: plan.applied_pan || mode === "center_lock",
            mode,
            focal_points: plan.focal_points.map((fp) => ({
              offset_ms: fp.offset_ms,
              center_x_pct: fp.center_x_pct,
              center_y_pct: fp.center_y_pct,
              confidence: fp.confidence,
            })),
          };

          if (plan.applied_pan) {
            clip.placement.fit_mode = "cover";
            clip.placement.scale_x = plan.scale_x;
            clip.placement.scale_y = plan.scale_y;
            clip.placement.x_pct = plan.static_x_pct;
            if (plan.envelope_points.length > 1) {
              const existingIdx = clip.envelopes.findIndex((e) => e.parameter === "placement.x_pct");
              const newEnv: ParameterEnvelope = {
                parameter: "placement.x_pct",
                points: plan.envelope_points,
              };
              if (existingIdx >= 0) clip.envelopes[existingIdx] = newEnv;
              else clip.envelopes.push(newEnv);
            } else {
              clip.envelopes = clip.envelopes.filter((e) => e.parameter !== "placement.x_pct");
            }
          } else {
            clip.placement.scale_x = 1;
            clip.placement.scale_y = 1;
            clip.placement.x_pct = 0;
            clip.envelopes = clip.envelopes.filter((e) => e.parameter !== "placement.x_pct");
          }
        }
      }

      plans.push(plan);
    }
    return plans;
  };

  const firstClipId = targetIds[0] ?? "sp_01";
  const overrideHint = `cuthol spine reframe --clip ${firstClipId} --points 0ms:50,40000ms:64,78600ms:55`;

  if (dryRun) {
    const { sequence } = loadSequence(options.workspaceDir);
    const plans = buildPlansForSequence(sequence, false);
    return {
      dry_run: true,
      mode,
      clips: plans,
      override_hint: overrideHint,
      revision: sequence.meta.revision,
    };
  }

  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.reframe(${targetIds.join(",")},${mode})`,
    (seq) => buildPlansForSequence(seq, true)
  );

  return {
    dry_run: false,
    mode,
    clips: result,
    override_hint: overrideHint,
    revision,
    verification,
  };
}
