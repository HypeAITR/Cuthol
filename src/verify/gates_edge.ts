// Edge-mode verification (lane-cue guard + ineffective-setting hint). Called from verifySequence's
// G4_STAGE block (one line in gates.ts); the G121 finding is still attributed to G1_SCHEMA.
import { CutholDiagnostic, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";

const MOTION_PARAMETERS = new Set([
  "placement.x_pct",
  "placement.y_pct",
  "placement.scale_x",
  "placement.scale_y",
  "placement.rotation_deg",
]);

/**
 * True when the clip's resting placement already covers the whole stage and nothing ever moves it: no pan/scale/
 * rotation envelopes and no transition in or out. (`contain` always leaves letterbox bars, so it never counts as
 * full cover; opacity/audio envelopes don't move pixels, so they don't count as motion.)
 */
function isStaticFullCover(seq: CutholSequence, index: number): boolean {
  const clip = seq.spine.clips[index];
  const p = clip.placement;
  if (Math.abs(p.scale_x) < 1 - 1e-3 || Math.abs(p.scale_y) < 1 - 1e-3) return false;
  if (Math.abs(p.x_pct) >= 0.01 || Math.abs(p.y_pct) >= 0.01) return false;
  if (Math.abs(p.rotation_deg) >= 0.01) return false;
  if (p.fit_mode === "contain") return false;
  if (clip.envelopes.some((e) => e.points.length > 0 && MOTION_PARAMETERS.has(e.parameter))) return false;
  if (clip.transition_out && clip.transition_out.duration_ms > 0) return false;
  const incoming = index > 0 ? seq.spine.clips[index - 1].transition_out : null;
  if (incoming && incoming.duration_ms > 0) return false;
  return true;
}

export function verifyEdgeMode(seq: CutholSequence, diagnostics: CutholDiagnostic[]): void {
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      const edge = cue.placement.edge;
      if (edge === "mirror" || edge === "clamp") {
        diagnostics.push(DIAGNOSTICS.EDGE_LANE_CUE_UNSUPPORTED(cue.id, edge));
      }
    }
  }
  for (let i = 0; i < seq.spine.clips.length; i++) {
    const clip = seq.spine.clips[i];
    const edge = clip.placement.edge;
    if ((edge === "mirror" || edge === "clamp") && isStaticFullCover(seq, i)) {
      diagnostics.push(DIAGNOSTICS.EDGE_INEFFECTIVE(clip.id));
    }
  }
}
