// Gates 4-5 (G4_STAGE, G5_SIGNAL) of the 5-Gate sequence verification engine.
import fs from "node:fs";
import path from "node:path";
import { CutholDiagnostic, CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { createDefaultTreatments, CutholSequence, LaneCue, LibraryItem } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { resolveCueStartMs } from "../core/timeline.js";
import { WorkspacePaths } from "../core/workspace.js";
import {
  compositionUsesAudio,
  exportBridgeDataForCue,
  syncEnabledExtensionAssetsToComposition,
} from "../compositor/bridge_exporter.js";
import {
  detectSceneHostFeaturesInComposition,
  lintHyperFramesComposition,
} from "../compositor/hyperframes_bridge.js";
import {
  COLOR_TEMPERATURE_NEUTRAL_K,
  isSupportedColorTemperature,
  resolveGradeLutPath,
} from "../compositor/compile_spine_color.js";
import { MediaLedger } from "../library/ledger.js";
import { LoudnessMetrics } from "../library/loudness.js";
import { measureCuePixelBox, PixelBoundingBox } from "./gates.js";

const UNAPPLIED_COLOR_ENVELOPE = new Set<string>([
  "treatments.color_grade.brightness",
  "treatments.color_grade.contrast",
  "treatments.color_grade.saturation",
]);

function colorEnvelopeFields(envelopes: Array<{ parameter: string }>): string[] {
  const fields: string[] = [];
  for (const env of envelopes) {
    if (UNAPPLIED_COLOR_ENVELOPE.has(env.parameter) && !fields.includes(env.parameter)) {
      fields.push(env.parameter);
    }
  }
  return fields;
}

/** Spine colour grade range/file validation (G124/G414 ERROR — render never starts). */
function validateSpineColorGrade(
  clip: CutholSequence["spine"]["clips"][number],
  diagnostics: CutholDiagnostic[],
  paths: WorkspacePaths | undefined
): void {
  const cg = clip.treatments.color_grade;
  const temperatureK = cg.temperature_k ?? COLOR_TEMPERATURE_NEUTRAL_K;
  if (!isSupportedColorTemperature(temperatureK)) {
    diagnostics.push(DIAGNOSTICS.INVALID_COLOR_TEMPERATURE(clip.id, temperatureK));
  }
  const lutUri = cg.lut_uri ?? null;
  if (lutUri !== null && paths) {
    try {
      resolveGradeLutPath(paths.rootDir, clip.id, lutUri);
    } catch (err) {
      if (err instanceof CutholError) {
        diagnostics.push(err.diagnostic);
        return;
      }
      throw err;
    }
  }
}

/** Motion blur, mask and lane colour envelopes are stored but not compiled. */
function warnUnappliedRenderFields(
  seq: CutholSequence,
  diagnostics: CutholDiagnostic[],
  paths?: WorkspacePaths
): void {
  const defaults = createDefaultTreatments();
  for (const clip of seq.spine.clips) {
    const fields: string[] = [];
    const blur = clip.treatments.motion_blur;
    const defaultBlur = defaults.motion_blur;
    if (
      blur.enabled !== defaultBlur.enabled ||
      blur.shutter_deg !== defaultBlur.shutter_deg ||
      blur.subframes !== defaultBlur.subframes
    ) {
      fields.push("treatments.motion_blur");
    }
    if (clip.treatments.mask !== null) fields.push("treatments.mask");
    validateSpineColorGrade(clip, diagnostics, paths);
    for (const field of fields) {
      diagnostics.push(DIAGNOSTICS.RENDER_FIELD_NOT_APPLIED(clip.id, field));
    }
  }
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      for (const field of colorEnvelopeFields(cue.envelopes)) {
        diagnostics.push(DIAGNOSTICS.RENDER_FIELD_NOT_APPLIED(cue.id, field));
      }
    }
  }
}

function boxesIntersectionArea(a: PixelBoundingBox, b: PixelBoundingBox): number {
  const ix0 = Math.max(a.left, b.left);
  const iy0 = Math.max(a.top, b.top);
  const ix1 = Math.min(a.right, b.right);
  const iy1 = Math.min(a.bottom, b.bottom);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  return (ix1 - ix0) * (iy1 - iy0);
}

export function verifyG4Stage(
  seq: CutholSequence,
  paths: WorkspacePaths | undefined,
  libMap: Map<string, LibraryItem>,
  diagnostics: CutholDiagnostic[]
): void {
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
        try {
          syncEnabledExtensionAssetsToComposition(
            seq,
            compDir,
            cue.composition.entry_html,
            paths
          );
        } catch {
          // ignore pre-lint asset sync error
        }
        const lintRes = lintHyperFramesComposition(
          compDir,
          cue.composition.entry_html,
          paths.blobsDir
        );
        for (const lf of lintRes.findings) {
          diagnostics.push(
            DIAGNOSTICS.COMPOSITION_LINT_FINDING(cue.id, lf.code, lf.message, lf.fixHint, "WARN")
          );
        }
        for (const lf of lintRes.info_findings) {
          if (lf.code === "duplicate_media_discovery_risk") {
            diagnostics.push(
              DIAGNOSTICS.COMPOSITION_LINT_FINDING(cue.id, lf.code, lf.message, lf.fixHint, "INFO")
            );
          }
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

  warnUnappliedRenderFields(seq, diagnostics, paths);
}

export function verifyG5Signal(
  seq: CutholSequence,
  paths: WorkspacePaths | undefined,
  libMap: Map<string, LibraryItem>,
  diagnostics: CutholDiagnostic[]
): void {
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

    // Check compositions that use `C.audio` in G5_SIGNAL: ensure audio envelope is available and non-empty
    if (paths) {
      for (const lane of seq.lanes) {
        if (lane.muted) continue;
        for (const cue of lane.cues) {
          if (cue.kind !== "composition" || !cue.composition) continue;
          const compDir = path.isAbsolute(cue.composition.composition_dir)
            ? cue.composition.composition_dir
            : path.resolve(paths.rootDir, cue.composition.composition_dir);
          const usesAudio =
            cue.composition.props?.preset === "audio_glow" ||
            compositionUsesAudio(compDir, cue.composition.entry_html);
          if (!usesAudio) continue;

          const bridgeData = exportBridgeDataForCue(seq, cue, paths) as {
            audio?: { mid?: number[] };
            warnings?: string[];
          };
          const hasMid = Boolean(bridgeData.audio?.mid && bridgeData.audio.mid.length > 0);
          const warnMsg = bridgeData.warnings?.[0];
          if (!hasMid || warnMsg) {
            diagnostics.push(
              DIAGNOSTICS.COMPOSITION_AUDIO_UNAVAILABLE(
                cue.id,
                warnMsg ?? "kompozisyon penceresinde ses enerjisi verisi yok"
              )
            );
          }
        }
      }
    }
  } finally {
    ledger?.close();
  }
}
