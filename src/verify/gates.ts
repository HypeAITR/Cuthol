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
import {
  CutholDiagnostic,
  CutholError,
  VerificationGateId,
} from "../core/diagnostics.js";
import { CutholSequence, LaneCue } from "../core/schema.js";
import { commitSequenceMutation, loadSequence, WorkspacePaths } from "../core/workspace.js";
import { syncAllCompositionBridges } from "../compositor/bridge_exporter.js";
import { wrapTypographyLines } from "../compositor/ass_generator.js";
import { verifyG1Schema, verifyG2Assets, verifyG3Timing } from "./gates_structural.js";
import { verifyEasing } from "./gates_easing.js";
import { verifyG4Stage, verifyG5Signal } from "./gates_stage_signal.js";
import { verifyCompositionAudio } from "./gates_hf_audio.js";
import { verifyEdgeMode } from "./gates_edge.js";
import { verifyExtensionTransitions } from "./gates_transition.js";
import { verifySpineFx } from "./gates_fx.js";

export { verifyG1Schema, verifyG2Assets, verifyG3Timing } from "./gates_structural.js";
export { verifyG4Stage, verifyG5Signal } from "./gates_stage_signal.js";

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
  info_count?: number;
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
    verifyG1Schema(seq, libMap, spineMap, diagnostics);
    verifyEasing(seq, diagnostics);
    verifySpineFx(seq, paths, diagnostics);
  }

  // --- Gate 2: Physical Asset & Boundary Integrity (G2_ASSETS) ---
  if (gateSet.has("G2_ASSETS")) {
    verifyG2Assets(seq, paths, libMap, diagnostics);
  }

  // --- Gate 3: Temporal Continuity & Frame Budget (G3_TIMING) ---
  if (gateSet.has("G3_TIMING")) {
    verifyG3Timing(seq, diagnostics);
  }

  if (gateSet.has("G1_SCHEMA") || gateSet.has("G4_STAGE")) verifyExtensionTransitions(seq, paths, diagnostics, gateSet);

  // --- Gate 4: Stage Geometry, Safe Zones, Caption CPS & Layer Occlusion (G4_STAGE) ---
  if (gateSet.has("G4_STAGE")) {
    verifyG4Stage(seq, paths, libMap, diagnostics);
    verifyEdgeMode(seq, diagnostics);
    verifyCompositionAudio(seq, paths, diagnostics);
  }

  // --- Gate 5: Audio Signal & Render Frame Sanity (G5_SIGNAL) ---
  if (gateSet.has("G5_SIGNAL")) {
    verifyG5Signal(seq, paths, libMap, diagnostics);
  }

  const errorCount = diagnostics.filter((d) => d.severity === "ERROR").length;
  const warningCount = diagnostics.filter((d) => d.severity === "WARN").length;
  const infoCount = diagnostics.filter((d) => d.severity === "INFO").length;

  return {
    ok: errorCount === 0,
    revision: seq.meta.revision,
    gates_run: gatesToRun,
    error_count: errorCount,
    warning_count: warningCount,
    ...(infoCount > 0 ? { info_count: infoCount } : {}),
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
      const preCheck = verifySequence(seq, paths, ["G1_SCHEMA", "G2_ASSETS", "G3_TIMING"]);
      if (!preCheck.ok) {
        const firstError = preCheck.diagnostics.find((d) => d.severity === "ERROR")!;
        throw new CutholError(firstError, preCheck.diagnostics);
      }
      try {
        syncAllCompositionBridges(seq, paths);
      } catch {
        // non-blocking bridge sync
      }
      verificationReport = verifySequence(seq, paths);
      if (!verificationReport.ok) {
        const firstError = verificationReport.diagnostics.find((d) => d.severity === "ERROR")!;
        throw new CutholError(firstError, verificationReport.diagnostics);
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
