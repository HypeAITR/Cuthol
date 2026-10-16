/**
 * Cuthol 5-Gate Deterministic Sequence Verification Engine (`src/verify/gates.ts`).
 *
 * Gates & Severity Policy:
 * - G1_SCHEMA (ERROR -> Rollback): Schema version, unique handles, asset & anchor reference integrity.
 * - G2_ASSETS (ERROR -> Rollback): Physical file existence on disk and `[source_in_ms, source_out_ms]` media bounds.
 * - G3_TIMING (ERROR -> Rollback): Minimum 2-frame duration budget, magnetic spine continuity, transition overlap bounds, envelope bounds.
 * - G4_STAGE  (WARN -> Commit + Advisory): EBU R95 / SMPTE ST 2046-1 / 9:16 Safe Zones, real typography bounding box (`measureCuePixelBox`),
 *             Netflix Timed Text reading speed (`<= 17 CPS` EN / `<= 19 CPS` TR), and `z_index` layer occlusion.
 * - G5_SIGNAL (WARN -> Commit + Advisory): ITU-R BS.1770-4 True Peak ceiling (`-1.0 dBTP`) and gain clipping checks.
 */

import fs from "node:fs";
import path from "node:path";
import { describeSequenceExtent, findBackdropOnlySpans, resolveCueStartMs } from "../core/timeline.js";
import {
  CutholDiagnostic,
  CutholError,
  DIAGNOSTICS,
  VerificationGateId,
} from "../core/diagnostics.js";
import { CutholSequence, getCuePlaybackRate, isStillGraphic, LaneCue } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { minClipDurationMs } from "../core/time.js";
import { commitSequenceMutation, loadSequence, WorkspacePaths } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { LoudnessMetrics } from "../library/loudness.js";
import { resolveLibraryItemPath } from "../library/probe.js";
import { syncAllCompositionBridges } from "../compositor/bridge_exporter.js";
import { resolveExtension } from "../extensions/manager.js";
import {
  detectSceneHostFeaturesInComposition,
  lintHyperFramesComposition,
  validateHyperFramesCompositionContract,
} from "../compositor/hyperframes_bridge.js";
import { wrapTypographyLines } from "../compositor/ass_generator.js";

export interface PixelBoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  lines_count?: number;
}

export interface VerificationReport {
  ok: boolean;
  revision: number;
  gates_run: VerificationGateId[];
  error_count: number;
  warning_count: number;
  diagnostics: CutholDiagnostic[];
}

/**
 * Computes the exact pixel bounding box `[left, top, right, bottom]` of a `LaneCue`
 * on the stage canvas (`width x height`), accounting for typography metrics, line wrapping,
 * relative percentage offset (`x_pct`, `y_pct` from stage center), and `scale_x` / `scale_y`.
 */
export function measureCuePixelBox(
  stage: CutholSequence["stage"],
  cue: LaneCue,
  assetAspectRatio?: number,
  rootDir?: string
): PixelBoundingBox {
  let centerX = stage.width * 0.5 + (cue.placement.x_pct / 100) * stage.width;
  const centerY = stage.height * 0.5 + (cue.placement.y_pct / 100) * stage.height;

  let baseWidth = stage.width * 0.5;
  let baseHeight = stage.height * 0.2;
  let linesCount = 1;
  let effectiveCenterY = centerY;

  if (cue.typography) {
    const typo = cue.typography;
    const avgCharWidthPx = typo.font_size_px * 0.55;

    let longestLinePx = 0;
    let totalLines = 1;

    const activeWords = (typo.words ?? []).filter(
      (w) => !w.excised && w.sequence_start_ms !== null && w.sequence_end_ms !== null
    );
    if (activeWords.length > 0 && typo.active_word_color_hex) {
      const maxBoxWidthPx = stage.width * (Math.max(15, Math.min(95, typo.max_width_pct)) / 100);
      let currentLineLen = activeWords[0].word.length;
      totalLines = 1;
      longestLinePx = currentLineLen * avgCharWidthPx;
      for (let i = 1; i < activeWords.length; i++) {
        const wLen = activeWords[i].word.length;
        if ((currentLineLen + 1 + wLen) * avgCharWidthPx <= maxBoxWidthPx) {
          currentLineLen += 1 + wLen;
        } else {
          longestLinePx = Math.max(longestLinePx, currentLineLen * avgCharWidthPx);
          totalLines++;
          currentLineLen = wLen;
        }
        longestLinePx = Math.max(longestLinePx, currentLineLen * avgCharWidthPx);
      }
    } else {
      const wrapped = wrapTypographyLines(
        typo.text ?? "",
        typo.font_size_px,
        stage.width,
        typo.max_width_pct
      );
      totalLines = wrapped.lines.length;
      longestLinePx = wrapped.maxLineWidthPx;
    }

    linesCount = Math.max(1, totalLines);
    const padX = typo.box_color_hex ? typo.font_size_px * 0.8 : typo.stroke_width_px * 4 + 28;
    const padY = typo.box_color_hex ? typo.font_size_px * 0.5 : typo.stroke_width_px * 4 + 18;
    baseWidth = longestLinePx + padX;
    baseHeight = linesCount * (typo.font_size_px * 1.25) + padY;
  } else if (cue.composition) {
    if (cue.composition.transparent === false || cue.composition.mode === "scene_host") {
      baseWidth = stage.width;
      baseHeight = stage.height;
    } else {
      // Detect actual HyperFrames preset geometry (`title_card`, `stat_callout`, `badge_overlay`, `lower_third`)
      // from props or the HTML file's CSS classes so monitor bounding boxes match the rendered card!
      const baseDir = rootDir ?? process.cwd();
      const compDir = path.isAbsolute(cue.composition.composition_dir)
        ? cue.composition.composition_dir
        : path.resolve(baseDir, cue.composition.composition_dir);
      const bboxSidecarPath = path.join(compDir, "assets/cuthol-bbox.json");

      let detectedPreset = String(cue.composition.props?.preset ?? "");
      if (!detectedPreset) {
        try {
          const htmlPath = path.join(compDir, cue.composition.entry_html);
          if (fs.existsSync(htmlPath)) {
            const html = fs.readFileSync(htmlPath, "utf8");
            if (html.includes('class="title-banner"')) detectedPreset = "title_card";
            else if (html.includes('class="stat-card"')) detectedPreset = "stat_callout";
            else if (html.includes('class="badge-overlay-box"')) detectedPreset = "badge_overlay";
            else if (html.includes('class="lower-third-box"')) detectedPreset = "lower_third";
          }
        } catch {
          // ignore read error
        }
      }

      // For custom (non-preset) compositions, prefer the real measured alpha-channel bounding box from assets/cuthol-bbox.json!
      let appliedMeasuredAlphaBbox = false;
      if (!detectedPreset && fs.existsSync(bboxSidecarPath)) {
        try {
          const measured = JSON.parse(fs.readFileSync(bboxSidecarPath, "utf8")) as {
            left_pct: number;
            top_pct: number;
            right_pct: number;
            bottom_pct: number;
            width_pct: number;
            height_pct: number;
          };
          if (
            Number.isFinite(measured.width_pct) &&
            Number.isFinite(measured.height_pct) &&
            measured.width_pct > 0 &&
            measured.height_pct > 0
          ) {
            baseWidth = stage.width * measured.width_pct;
            baseHeight = stage.height * measured.height_pct;
            const naturalCenterX = stage.width * ((measured.left_pct + measured.right_pct) / 2);
            const naturalCenterY = stage.height * ((measured.top_pct + measured.bottom_pct) / 2);
            centerX = naturalCenterX + (cue.placement.x_pct / 100) * stage.width;
            effectiveCenterY = naturalCenterY + (cue.placement.y_pct / 100) * stage.height;
            appliedMeasuredAlphaBbox = true;
          }
        } catch {
          // ignore corrupt sidecar
        }
      }

      if (!appliedMeasuredAlphaBbox) {
        if (detectedPreset === "title_card") {
          baseWidth = stage.width * 0.66;
          baseHeight = stage.height * 0.24;
          effectiveCenterY = centerY;
        } else if (detectedPreset === "stat_callout") {
          baseWidth = stage.width * 0.54;
          baseHeight = stage.height * 0.24;
          effectiveCenterY = centerY;
        } else if (detectedPreset === "badge_overlay") {
          baseWidth = stage.width * 0.36;
          baseHeight = stage.height * 0.08;
          if (cue.placement.x_pct === 0 && cue.placement.y_pct === 0) {
            centerX = stage.width * 0.76;
            effectiveCenterY = stage.height * 0.09;
          }
        } else {
          // lower_third default (top: 58%, left: 90px)
          baseWidth = stage.width * 0.78;
          baseHeight = stage.height * 0.12;
          effectiveCenterY = stage.height * 0.64 + (cue.placement.y_pct / 100) * stage.height;
        }
      }
    }
  } else {
    // Visual B-roll or graphic overlay: width is stage.width, height follows asset aspect ratio
    baseWidth = stage.width;
    const ar = assetAspectRatio && assetAspectRatio > 0 ? assetAspectRatio : stage.width / stage.height;
    baseHeight = baseWidth / ar;
  }

  let finalWidth = baseWidth * Math.abs(cue.placement.scale_x);
  let finalHeight = baseHeight * Math.abs(cue.placement.scale_y);

  if (Math.abs(cue.placement.rotation_deg) > 0.01) {
    const rad = (cue.placement.rotation_deg * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const rotW = finalWidth * cos + finalHeight * sin;
    const rotH = finalWidth * sin + finalHeight * cos;
    finalWidth = rotW;
    finalHeight = rotH;
  }

  const left = Math.round(centerX - finalWidth / 2);
  const right = Math.round(centerX + finalWidth / 2);
  const top = Math.round(effectiveCenterY - finalHeight / 2);
  const bottom = Math.round(effectiveCenterY + finalHeight / 2);

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    lines_count: linesCount,
  };
}

function boxesIntersectionArea(a: PixelBoundingBox, b: PixelBoundingBox): number {
  const ix0 = Math.max(a.left, b.left);
  const iy0 = Math.max(a.top, b.top);
  const ix1 = Math.min(a.right, b.right);
  const iy1 = Math.min(a.bottom, b.bottom);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  return (ix1 - ix0) * (iy1 - iy0);
}

export function verifySequence(
  seq: CutholSequence,
  paths?: WorkspacePaths,
  enabledGates?: VerificationGateId[]
): VerificationReport {
  const gatesToRun: VerificationGateId[] = enabledGates ?? [
    "G1_SCHEMA",
    "G2_ASSETS",
    "G3_TIMING",
    "G4_STAGE",
    "G5_SIGNAL",
  ];
  const gateSet = new Set<VerificationGateId>(gatesToRun);
  const diagnostics: CutholDiagnostic[] = [];

  const libMap = new Map(seq.library.map((item) => [item.handle, item]));
  const spineMap = new Map(seq.spine.clips.map((clip) => [clip.id, clip]));

  // --- Gate 1: Schema & Handle Integrity (G1_SCHEMA) ---
  if (gateSet.has("G1_SCHEMA")) {
    const seenHandles = new Set<string>();
    const checkUnique = (id: string) => {
      if (seenHandles.has(id)) {
        diagnostics.push(DIAGNOSTICS.DUPLICATE_HANDLE(id));
      }
      seenHandles.add(id);
    };

    for (const item of seq.library) {
      checkUnique(item.handle);
    }
    for (const clip of seq.spine.clips) {
      checkUnique(clip.id);
      if (!libMap.has(clip.asset_handle)) {
        diagnostics.push(DIAGNOSTICS.DANGLING_ASSET_REF(clip.id, clip.asset_handle));
      }
    }
    for (const lane of seq.lanes) {
      checkUnique(lane.id);
      for (const cue of lane.cues) {
        checkUnique(cue.id);
        if (cue.asset_handle && !libMap.has(cue.asset_handle)) {
          diagnostics.push(DIAGNOSTICS.DANGLING_ASSET_REF(cue.id, cue.asset_handle));
        }
        if (cue.anchor && !spineMap.has(cue.anchor.ref)) {
          diagnostics.push(DIAGNOSTICS.DANGLING_ANCHOR_REF(cue.id, cue.anchor.ref));
        }
      }
    }
    for (const marker of seq.markers) {
      checkUnique(marker.id);
    }
  }

  // --- Gate 2: Physical Asset & Boundary Integrity (G2_ASSETS) ---
  if (gateSet.has("G2_ASSETS")) {
    if (paths) {
      for (const item of seq.library) {
        const absPath = resolveLibraryItemPath(paths.rootDir, item);
        if (!fs.existsSync(absPath)) {
          diagnostics.push(DIAGNOSTICS.MISSING_FILE_ON_DISK(item.handle, item.uri));
        }
      }
      for (const lane of seq.lanes) {
        for (const cue of lane.cues) {
          if (cue.composition) {
            const compDir = path.isAbsolute(cue.composition.composition_dir)
              ? cue.composition.composition_dir
              : path.resolve(paths.rootDir, cue.composition.composition_dir);
            const entryPath = path.join(compDir, cue.composition.entry_html);
            if (!fs.existsSync(entryPath)) {
              diagnostics.push(DIAGNOSTICS.MISSING_FILE_ON_DISK(cue.id, entryPath));
            } else {
              // Verify HyperFrames contract during sequence verification
              const contract = validateHyperFramesCompositionContract(
                compDir,
                cue.composition.entry_html,
                false,
                false
              );
              if (!contract.ok) {
                diagnostics.push(
                  DIAGNOSTICS.INVALID_COMPOSITION_CONTRACT(cue.id, contract.findings.join("; "))
                );
              }
            }
          }
        }
      }

      if (seq.extensions && seq.extensions.length > 0) {
        for (const extRef of seq.extensions) {
          try {
            const currentExt = resolveExtension(extRef.name, paths.rootDir);
            if (
              currentExt.contentHash !== extRef.content_hash ||
              currentExt.version !== extRef.version
            ) {
              diagnostics.push(
                DIAGNOSTICS.EXTENSION_HASH_MISMATCH(
                  extRef.name,
                  extRef.version,
                  extRef.content_hash,
                  currentExt.version,
                  currentExt.contentHash
                )
              );
            }
          } catch {
            diagnostics.push(
              DIAGNOSTICS.EXTENSION_HASH_MISMATCH(
                extRef.name,
                extRef.version,
                extRef.content_hash,
                "missing",
                "missing"
              )
            );
          }
        }
      }
    }

    for (const clip of seq.spine.clips) {
      const asset = libMap.get(clip.asset_handle);
      if (asset) {
        const isStaticGraphic = isStillGraphic(asset);
        if (clip.source_in_ms < 0) {
          diagnostics.push(
            DIAGNOSTICS.SOURCE_RANGE_EXCEEDED(clip.id, clip.source_in_ms, asset.probe.duration_ms)
          );
        } else if (clip.source_in_ms >= clip.source_out_ms) {
          diagnostics.push(
            DIAGNOSTICS.SOURCE_RANGE_EXCEEDED(clip.id, clip.source_out_ms, clip.source_in_ms)
          );
        } else if (!isStaticGraphic && clip.source_out_ms > asset.probe.duration_ms) {
          diagnostics.push(
            DIAGNOSTICS.SOURCE_RANGE_EXCEEDED(clip.id, clip.source_out_ms, asset.probe.duration_ms)
          );
        }
      }
    }

    for (const lane of seq.lanes) {
      for (const cue of lane.cues) {
        if (cue.asset_handle) {
          const asset = libMap.get(cue.asset_handle);
          if (asset) {
            const isStaticGraphic = isStillGraphic(asset);
            const cueRate = getCuePlaybackRate(cue);
            const effectiveInMs = cue.source_in_ms ?? 0;
            const effectiveOutMs =
              cue.source_out_ms ??
              (cueRate === 1.0
                ? effectiveInMs + cue.duration_ms
                : effectiveInMs + Math.round(cue.duration_ms * cueRate));
            const maxAllowedCueDurationMs =
              cue.source_out_ms !== undefined
                ? cueRate === 1.0
                  ? cue.source_out_ms - effectiveInMs
                  : Math.ceil((cue.source_out_ms - effectiveInMs) / cueRate) + 1
                : cue.duration_ms;

            if (effectiveInMs < 0) {
              diagnostics.push(
                DIAGNOSTICS.SOURCE_RANGE_EXCEEDED(cue.id, effectiveInMs, asset.probe.duration_ms)
              );
            } else if (cue.source_out_ms !== undefined && effectiveInMs >= cue.source_out_ms) {
              diagnostics.push(
                DIAGNOSTICS.SOURCE_RANGE_EXCEEDED(cue.id, cue.source_out_ms, effectiveInMs)
              );
            } else if (!isStaticGraphic && effectiveOutMs > asset.probe.duration_ms) {
              diagnostics.push(
                DIAGNOSTICS.SOURCE_RANGE_EXCEEDED(
                  cue.id,
                  effectiveOutMs,
                  asset.probe.duration_ms
                )
              );
            } else if (
              !isStaticGraphic &&
              cue.source_out_ms !== undefined &&
              cue.duration_ms > maxAllowedCueDurationMs
            ) {
              diagnostics.push(
                DIAGNOSTICS.SOURCE_RANGE_EXCEEDED(
                  cue.id,
                  effectiveInMs + Math.round(cue.duration_ms * cueRate),
                  cue.source_out_ms
                )
              );
            }
          }
        }
      }
    }
  }

  // --- Gate 3: Temporal Continuity & Frame Budget (G3_TIMING) ---
  if (gateSet.has("G3_TIMING")) {
    const minMs = minClipDurationMs(seq.stage.fps, OPEN_STANDARDS.SIGNAL_SANITY.MIN_CLIP_FRAMES);
    let expectedTimelineIn = 0;

    for (let i = 0; i < seq.spine.clips.length; i++) {
      const clip = seq.spine.clips[i];
      if (!Number.isFinite(clip.playback.rate) || clip.playback.rate < 0.1 || clip.playback.rate > 16.0) {
        diagnostics.push(DIAGNOSTICS.INVALID_PLAYBACK_RATE(clip.id, clip.playback.rate));
      }
      if (!Number.isFinite(clip.duration_ms) || clip.duration_ms < minMs) {
        diagnostics.push(DIAGNOSTICS.SUB_FRAME_DURATION(clip.id, clip.duration_ms, minMs));
      }
      if (seq.spine.magnetic && clip.timeline_in_ms !== expectedTimelineIn) {
        diagnostics.push(
          DIAGNOSTICS.SPINE_DISCONTINUITY(clip.id, expectedTimelineIn, clip.timeline_in_ms)
        );
      }
      expectedTimelineIn = clip.timeline_in_ms + clip.duration_ms;

      if (clip.transition_out) {
        const nextClip = seq.spine.clips[i + 1];
        const maxAllowed = nextClip
          ? Math.floor(Math.min(clip.duration_ms, nextClip.duration_ms) / 2)
          : Math.floor(clip.duration_ms / 2);
        if (
          !Number.isFinite(clip.transition_out.duration_ms) ||
          clip.transition_out.duration_ms <= 0 ||
          clip.transition_out.duration_ms > maxAllowed
        ) {
          diagnostics.push(
            DIAGNOSTICS.TRANSITION_TOO_LONG(clip.id, clip.transition_out.duration_ms, maxAllowed)
          );
        }
      }

      for (const env of clip.envelopes) {
        for (const pt of env.points) {
          if (
            !Number.isFinite(pt.offset_ms) ||
            !Number.isFinite(pt.value) ||
            pt.offset_ms < 0 ||
            pt.offset_ms > clip.duration_ms
          ) {
            diagnostics.push(
              DIAGNOSTICS.ENVELOPE_OUT_OF_RANGE(clip.id, env.parameter, pt.offset_ms, clip.duration_ms)
            );
          }
        }
      }
    }

    for (const lane of seq.lanes) {
      for (const cue of lane.cues) {
        if (
          cue.playback &&
          (!Number.isFinite(cue.playback.rate) ||
            cue.playback.rate < 0.1 ||
            cue.playback.rate > 16.0)
        ) {
          diagnostics.push(DIAGNOSTICS.INVALID_PLAYBACK_RATE(cue.id, cue.playback.rate));
        }
        if (!Number.isFinite(cue.duration_ms) || cue.duration_ms < minMs) {
          diagnostics.push(DIAGNOSTICS.SUB_FRAME_DURATION(cue.id, cue.duration_ms, minMs));
        }
        const cueStartMs = resolveCueStartMs(seq, cue);
        if (!Number.isFinite(cueStartMs) || cueStartMs < 0) {
          diagnostics.push(
            DIAGNOSTICS.ENVELOPE_OUT_OF_RANGE(cue.id, "at_ms", cueStartMs, cue.duration_ms)
          );
        }
        // Warn if an active lane cue extends past the primary spine duration
        if (
          !lane.muted &&
          seq.spine.clips.length > 0 &&
          expectedTimelineIn > 0 &&
          cueStartMs + cue.duration_ms > expectedTimelineIn + minMs
        ) {
          diagnostics.push(
            DIAGNOSTICS.LANE_EXTENDS_PAST_SPINE(
              cue.id,
              cueStartMs + cue.duration_ms,
              expectedTimelineIn
            )
          );
        }
        for (const env of cue.envelopes) {
          for (const pt of env.points) {
            if (
              !Number.isFinite(pt.offset_ms) ||
              !Number.isFinite(pt.value) ||
              pt.offset_ms < 0 ||
              pt.offset_ms > cue.duration_ms
            ) {
              diagnostics.push(
                DIAGNOSTICS.ENVELOPE_OUT_OF_RANGE(cue.id, env.parameter, pt.offset_ms, cue.duration_ms)
              );
            }
          }
        }
      }
    }

    // Without spine clips the lanes alone carry the edit (a graphics-only video). That is a supported
    // shape, so the only things worth reporting are a sequence with nothing on it at all, and stretches
    // where no visual cue is on screen and the viewer would see only the stage backdrop.
    if (describeSequenceExtent(seq).source === "empty") {
      diagnostics.push(DIAGNOSTICS.EMPTY_SEQUENCE("WARN"));
    }
    for (const span of findBackdropOnlySpans(seq)) {
      diagnostics.push(DIAGNOSTICS.BACKDROP_ONLY_SPAN(span.start_ms, span.end_ms));
    }
  }

  // --- Gate 4: Stage Geometry, Safe Zones, Caption CPS & Layer Occlusion (G4_STAGE) ---
  if (gateSet.has("G4_STAGE")) {
    const safeLeft = Math.round(
      seq.stage.width * (OPEN_STANDARDS.SAFE_ZONES.TITLE_MARGIN_PCT / 100)
    );
    const safeTop = Math.round(
      seq.stage.height * (OPEN_STANDARDS.SAFE_ZONES.TITLE_MARGIN_PCT / 100)
    );
    const safeRight =
      seq.stage.aspect === "9:16"
        ? Math.round(
            seq.stage.width *
              (1 - OPEN_STANDARDS.SAFE_ZONES.VERTICAL_9_16_RIGHT_CHROME_PCT / 100)
          )
        : seq.stage.width - safeLeft;
    const safeBottom =
      seq.stage.aspect === "9:16"
        ? Math.round(
            seq.stage.height *
              (1 - OPEN_STANDARDS.SAFE_ZONES.VERTICAL_9_16_BOTTOM_CHROME_PCT / 100)
          )
        : seq.stage.height - safeTop;

    // Resolve project/transcript language for caption CPS threshold (19 CPS for Turkish, 17 CPS default)
    let transcriptLangFromLedger: string | null = null;
    if (paths && fs.existsSync(paths.ledgerFile)) {
      const g4Ledger = new MediaLedger(paths.ledgerFile);
      try {
        const orderedHandles = [
          ...seq.spine.clips.map((c) => c.asset_handle),
          ...seq.lanes.flatMap((l) => l.cues.map((c) => c.asset_handle).filter((h): h is string => Boolean(h))),
          ...seq.library.map((item) => item.handle),
        ];
        const seenDigests = new Set<string>();
        for (const h of orderedHandles) {
          const item = libMap.get(h);
          if (!item || seenDigests.has(item.digest_sha256)) continue;
          seenDigests.add(item.digest_sha256);
          const trDoc = g4Ledger.getLatestTranscript<{ language?: string }>(item.digest_sha256);
          if (trDoc?.language && typeof trDoc.language === "string") {
            transcriptLangFromLedger = trDoc.language.toLowerCase();
            break;
          }
        }
      } finally {
        g4Ledger.close();
      }
    }

    const autoCaptionTrackIsTurkish = seq.lanes
      .filter((l) => !l.muted && (l.id === "ln_captions" || l.kind === "caption"))
      .flatMap((l) => l.cues)
      .some(
        (c) =>
          Boolean(c.typography?.words?.length) &&
          /[çğıöşüÇĞİÖŞÜ]/.test(c.typography?.text ?? "")
      );

    const evaluatedCues: Array<{
      cue: LaneCue;
      laneId: string;
      zIndex: number;
      orderIndex: number;
      startMs: number;
      endMs: number;
      box: PixelBoundingBox;
    }> = [];

    for (const lane of seq.lanes) {
      if (lane.muted) continue;
      if (lane.kind === "music" || lane.kind === "sfx" || lane.kind === "voiceover") {
        continue;
      }
      for (const cue of lane.cues) {
        if (cue.kind === "music" || cue.kind === "sfx" || cue.kind === "voiceover") {
          continue;
        }
        const asset = cue.asset_handle ? libMap.get(cue.asset_handle) : undefined;
        if (!cue.typography && !cue.composition && asset && !asset.probe.has_video) {
          continue;
        }
        const startMs = resolveCueStartMs(seq, cue);
        const endMs = startMs + cue.duration_ms;
        // Pass assetAspectRatio into measureCuePixelBox during G4_STAGE verification
        const assetAr =
          asset && asset.probe.width > 0 && asset.probe.height > 0
            ? asset.probe.width / asset.probe.height
            : undefined;
        const box = measureCuePixelBox(seq.stage, cue, assetAr, paths?.rootDir);
        evaluatedCues.push({
          cue,
          laneId: lane.id,
          zIndex: cue.z_index ?? lane.z_index,
          orderIndex: evaluatedCues.length,
          startMs,
          endMs,
          box,
        });

        // Check if composition in overlay_alpha mode uses backdrop-filter / mix-blend-mode (CUTHOL-G406)
        // and run cached HyperFrames lint (CUTHOL-G407)
        if (cue.kind === "composition" && cue.composition && paths) {
          const mode = cue.composition.mode ?? "overlay_alpha";
          const compDir = path.isAbsolute(cue.composition.composition_dir)
            ? cue.composition.composition_dir
            : path.resolve(paths.rootDir, cue.composition.composition_dir);
          if (mode === "overlay_alpha") {
            const shFeatures = detectSceneHostFeaturesInComposition(
              compDir,
              cue.composition.entry_html
            );
            if (shFeatures.length > 0) {
              diagnostics.push(DIAGNOSTICS.SCENE_HOST_RECOMMENDED(cue.id, shFeatures));
            }
          }
          const lintRes = lintHyperFramesComposition(
            compDir,
            cue.composition.entry_html,
            paths.blobsDir
          );
          for (const lf of lintRes.findings) {
            diagnostics.push(
              DIAGNOSTICS.COMPOSITION_LINT_FINDING(cue.id, lf.code, lf.message, lf.fixHint)
            );
          }
        }

        // Check Safe Zones & Reading Speed on Title / Caption cues
        if (cue.kind === "title" || cue.kind === "caption" || cue.typography) {
          if (box.left < safeLeft) {
            diagnostics.push(DIAGNOSTICS.SAFE_ZONE_VIOLATION(cue.id, "left", safeLeft - box.left));
          }
          if (box.right > safeRight) {
            diagnostics.push(
              DIAGNOSTICS.SAFE_ZONE_VIOLATION(cue.id, "right", box.right - safeRight)
            );
          }
          if (box.top < safeTop) {
            diagnostics.push(DIAGNOSTICS.SAFE_ZONE_VIOLATION(cue.id, "top", safeTop - box.top));
          }
          if (box.bottom > safeBottom) {
            diagnostics.push(
              DIAGNOSTICS.SAFE_ZONE_VIOLATION(cue.id, "bottom", box.bottom - safeBottom)
            );
          }

          if (cue.kind === "caption" && cue.typography && cue.duration_ms > 0) {
            const normalizedText = cue.typography.text.replace(/\s+/g, " ").trim();
            const charCount = normalizedText.length;
            const cps = charCount / (cue.duration_ms / 1000);
            const hasTrCharsOrWords =
              /[çğıöşüÇĞİÖŞÜ]/.test(normalizedText) ||
              /\b(modelleri|modeli|dostlar|tamam|yani|hani|acaba|ama|ve|bir|bu|var|yok|ben|sen|biz|siz|onlar|kadar|olarak|sonra|daha|bile|gibi|ancak|fakat|neden|niye)\b/i.test(
                normalizedText
              );
            const isTurkish =
              transcriptLangFromLedger !== null
                ? transcriptLangFromLedger.startsWith("tr")
                : Boolean(cue.typography.words?.length) && autoCaptionTrackIsTurkish
                  ? true
                  : hasTrCharsOrWords;
            const maxCps = isTurkish
              ? OPEN_STANDARDS.CAPTIONS.TURKISH_MAX_CPS
              : OPEN_STANDARDS.CAPTIONS.DEFAULT_MAX_CPS;
            if (cps > maxCps) {
              diagnostics.push(
                DIAGNOSTICS.CAPTION_READING_SPEED_HIGH(cue.id, cps, maxCps)
              );
            }
          }
        }
      }
    }

    // Check z_index Occlusion: a higher (or equal-z later) visual layer covering a lower text cue
    for (const textItem of evaluatedCues) {
      if (!textItem.cue.typography && textItem.cue.kind !== "title" && textItem.cue.kind !== "caption") {
        continue;
      }
      const textArea = Math.max(1, textItem.box.width * textItem.box.height);

      for (const other of evaluatedCues) {
        if (other.cue.id === textItem.cue.id) continue;
        if (other.zIndex < textItem.zIndex) continue;
        if (other.zIndex === textItem.zIndex && other.orderIndex <= textItem.orderIndex) continue;
        if (other.cue.placement.opacity < 0.3) continue;

        // Check temporal overlap
        const timeOverlap = Math.min(textItem.endMs, other.endMs) - Math.max(textItem.startMs, other.startMs);
        if (timeOverlap <= 0) continue;

        const spatialOverlap = boxesIntersectionArea(textItem.box, other.box);
        if (spatialOverlap / textArea >= 0.25) {
          diagnostics.push(DIAGNOSTICS.TEXT_OCCLUDED_BY_LAYER(textItem.cue.id, other.cue.id));
        }
      }

      // Also check if a negative-z_index text lane (`zIndex < 0`) is occluded by the primary spine (`z_index = 0`)
      if (textItem.zIndex < 0) {
        const stageBox: PixelBoundingBox = {
          left: 0,
          top: 0,
          right: seq.stage.width,
          bottom: seq.stage.height,
          width: seq.stage.width,
          height: seq.stage.height,
        };
        for (const clip of seq.spine.clips) {
          if (clip.placement.opacity < 0.3) continue;
          const clipStart = clip.timeline_in_ms;
          const clipEnd = clipStart + clip.duration_ms;
          const timeOverlap = Math.min(textItem.endMs, clipEnd) - Math.max(textItem.startMs, clipStart);
          if (timeOverlap <= 0) continue;

          const spatialOverlap = boxesIntersectionArea(textItem.box, stageBox);
          if (spatialOverlap / textArea >= 0.25) {
            diagnostics.push(DIAGNOSTICS.TEXT_OCCLUDED_BY_LAYER(textItem.cue.id, clip.id));
            break;
          }
        }
      }
    }
  }

  // --- Gate 5: Audio Signal & Render Frame Sanity (G5_SIGNAL) ---
  if (gateSet.has("G5_SIGNAL")) {
    let ledger: MediaLedger | null = null;
    if (paths && fs.existsSync(paths.ledgerFile)) {
      ledger = new MediaLedger(paths.ledgerFile);
    }
    try {
      for (const clip of seq.spine.clips) {
        if (clip.audio_chain.muted) continue;
        const asset = libMap.get(clip.asset_handle);
        if (!asset || !asset.probe.has_audio) continue;

        if (
          clip.audio_chain.loudness_target_lufs !== null &&
          clip.audio_chain.true_peak_ceiling_dbtp > OPEN_STANDARDS.LOUDNESS.DEFAULT_TRUE_PEAK_DBTP
        ) {
          diagnostics.push(
            DIAGNOSTICS.TRUE_PEAK_CEILING_EXCEEDED(
              clip.id,
              clip.audio_chain.true_peak_ceiling_dbtp,
              OPEN_STANDARDS.LOUDNESS.DEFAULT_TRUE_PEAK_DBTP
            )
          );
          continue;
        }

        const cachedLoud = ledger ? ledger.getLoudness<LoudnessMetrics>(asset.digest_sha256) : null;
        const basePeakDbtp = cachedLoud ? cachedLoud.true_peak_dbtp : -3.0;
        const maxEnvGainDb = Math.max(
          0,
          ...clip.envelopes
            .filter((e) => e.parameter === "audio_chain.gain_db")
            .flatMap((e) => e.points.map((p) => p.value))
        );
        const effectivePeakDbtp = basePeakDbtp + clip.audio_chain.gain_db + maxEnvGainDb;

        if (effectivePeakDbtp > clip.audio_chain.true_peak_ceiling_dbtp + 0.01) {
          diagnostics.push(
            DIAGNOSTICS.TRUE_PEAK_CEILING_EXCEEDED(
              clip.id,
              effectivePeakDbtp,
              clip.audio_chain.true_peak_ceiling_dbtp
            )
          );
        }
      }

      // Also check audio-bearing lane cues (`music`, `sfx`, `voiceover`, `broll`) in G5_SIGNAL
      for (const lane of seq.lanes) {
        if (lane.muted) continue;
        for (const cue of lane.cues) {
          if (!cue.audio_chain || cue.audio_chain.muted) continue;
          const asset = cue.asset_handle ? libMap.get(cue.asset_handle) : undefined;
          if (!asset || !asset.probe.has_audio) continue;

          if (
            cue.audio_chain.loudness_target_lufs !== null &&
            cue.audio_chain.true_peak_ceiling_dbtp > OPEN_STANDARDS.LOUDNESS.DEFAULT_TRUE_PEAK_DBTP
          ) {
            diagnostics.push(
              DIAGNOSTICS.TRUE_PEAK_CEILING_EXCEEDED(
                cue.id,
                cue.audio_chain.true_peak_ceiling_dbtp,
                OPEN_STANDARDS.LOUDNESS.DEFAULT_TRUE_PEAK_DBTP
              )
            );
            continue;
          }

          const cachedLoud = ledger ? ledger.getLoudness<LoudnessMetrics>(asset.digest_sha256) : null;
          const basePeakDbtp = cachedLoud ? cachedLoud.true_peak_dbtp : -3.0;
          const maxEnvGainDb = Math.max(
            0,
            ...cue.envelopes
              .filter((e) => e.parameter === "audio_chain.gain_db")
              .flatMap((e) => e.points.map((p) => p.value))
          );
          const effectivePeakDbtp = basePeakDbtp + cue.audio_chain.gain_db + maxEnvGainDb;
          if (effectivePeakDbtp > cue.audio_chain.true_peak_ceiling_dbtp + 0.01) {
            diagnostics.push(
              DIAGNOSTICS.TRUE_PEAK_CEILING_EXCEEDED(
                cue.id,
                effectivePeakDbtp,
                cue.audio_chain.true_peak_ceiling_dbtp
              )
            );
          }
        }
      }
    } finally {
      ledger?.close();
    }
  }

  const errorCount = diagnostics.filter((d) => d.severity === "ERROR").length;
  const warningCount = diagnostics.filter((d) => d.severity === "WARN").length;

  return {
    ok: errorCount === 0,
    revision: seq.meta.revision,
    gates_run: gatesToRun,
    error_count: errorCount,
    warning_count: warningCount,
    diagnostics,
  };
}

/**
 * Executes a sequence mutation inside `JournalGuard` and runs the 5-Gate Verification Engine
 * before committing to disk. If any `ERROR`-level diagnostic is detected, throws `CutholError`
 * so `JournalGuard` automatically aborts and leaves `cuthol.sequence.json` untouched.
 */
export function commitVerifiedMutation<T>(
  workspaceDir: string,
  operation: string,
  mutator: (seq: CutholSequence, paths: WorkspacePaths) => T
): { result: T; sequence: CutholSequence; revision: number; verification: VerificationReport } {
  let verificationReport!: VerificationReport;

  const { result, sequence, revision } = commitSequenceMutation(
    workspaceDir,
    operation,
    (seq, paths) => {
      const out = mutator(seq, paths);
      verificationReport = verifySequence(seq, paths);
      if (!verificationReport.ok) {
        const firstError = verificationReport.diagnostics.find((d) => d.severity === "ERROR")!;
        throw new CutholError(firstError, verificationReport.diagnostics);
      }
      try {
        syncAllCompositionBridges(seq, paths);
      } catch {
        // non-blocking bridge sync
      }
      return out;
    }
  );

  return { result, sequence, revision, verification: verificationReport };
}

export function runWorkspaceVerification(
  workspaceDir: string,
  gates?: VerificationGateId[]
): VerificationReport {
  const { paths, sequence } = loadSequence(workspaceDir);
  return verifySequence(sequence, paths, gates);
}
