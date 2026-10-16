/**
 * Stage-level edits. The backdrop colour is what the render starts from: it shows wherever no spine clip
 * and no lane content covers the frame, so in a graphics-only project it is the base colour of the video.
 */

import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";

/** Accepts `#RRGGBB` or `RRGGBB` (any case) and returns `#RRGGBB` in upper case. */
export function normalizeHexColor(raw: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(raw.trim());
  if (!match) {
    throw new CutholError(DIAGNOSTICS.INVALID_COLOR(raw));
  }
  return `#${match[1].toUpperCase()}`;
}

export function setStageBackdropColor(options: { workspaceDir: string; color: string }): {
  backdrop: CutholSequence["stage"]["backdrop"];
  previous_color: string;
  revision: number;
  verification: VerificationReport;
} {
  const color = normalizeHexColor(options.color);
  let previousColor = "";
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `workspace.backdrop(${color})`,
    (seq) => {
      previousColor = seq.stage.backdrop.color;
      seq.stage.backdrop = { ...seq.stage.backdrop, color };
      return { ...seq.stage.backdrop };
    }
  );
  return { backdrop: result, previous_color: previousColor, revision, verification };
}
