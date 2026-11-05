// Spine clip colour grade edits (`cuthol spine grade`).
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";

function requireFiniteNumber(value: number, raw: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(raw));
  }
  return value;
}

/**
 * Sets a spine clip's constant colour grade (`treatments.color_grade`). Only the provided fields change;
 * `lutUri: null` (CLI/MCP `--lut none`) clears the LUT binding. Temperature range (1000..40000 K) and LUT
 * path/existence are enforced by verification (G124/G414), so an invalid grade rolls the edit back.
 */
export function setSpineGrade(options: {
  workspaceDir: string;
  clipId: string;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  temperatureK?: number;
  lutUri?: string | null;
}): {
  color_grade: CutholSequence["spine"]["clips"][number]["treatments"]["color_grade"];
  revision: number;
  verification: VerificationReport;
} {
  if (options.brightness !== undefined) {
    requireFiniteNumber(options.brightness, String(options.brightness));
  }
  if (options.contrast !== undefined) {
    requireFiniteNumber(options.contrast, String(options.contrast));
  }
  if (options.saturation !== undefined) {
    requireFiniteNumber(options.saturation, String(options.saturation));
  }
  if (options.temperatureK !== undefined) {
    requireFiniteNumber(options.temperatureK, String(options.temperatureK));
  }

  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.grade(${options.clipId})`,
    (seq) => {
      const clip = seq.spine.clips.find((c) => c.id === options.clipId);
      if (!clip) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.clipId));
      }
      const cg = clip.treatments.color_grade;
      if (options.brightness !== undefined) cg.brightness = options.brightness;
      if (options.contrast !== undefined) cg.contrast = options.contrast;
      if (options.saturation !== undefined) cg.saturation = options.saturation;
      if (options.temperatureK !== undefined) cg.temperature_k = options.temperatureK;
      if (options.lutUri !== undefined) {
        cg.lut_uri = options.lutUri === null ? null : options.lutUri.trim();
      }
      return clip.treatments.color_grade;
    }
  );

  return { color_grade: result, revision, verification };
}
