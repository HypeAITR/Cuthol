// Easing validation (CUTHOL-G120) for envelopes and
// spine transition progress. Runs inside G1_SCHEMA; called from `verifySequence`.
import { CutholDiagnostic } from "../core/diagnostics.js";
import { easingDiagnostic } from "../core/easing.js";
import { CutholSequence, ParameterEnvelope } from "../core/schema.js";

function checkEnvelope(
  ownerId: string,
  env: ParameterEnvelope,
  diagnostics: CutholDiagnostic[]
): void {
  for (const pt of env.points) {
    const problem = easingDiagnostic(
      `${ownerId} ${env.parameter}@${pt.offset_ms}ms`,
      pt.easing,
      pt.bezier
    );
    if (problem) diagnostics.push(problem);
  }
}

export function verifyEasing(seq: CutholSequence, diagnostics: CutholDiagnostic[]): void {
  for (const clip of seq.spine.clips) {
    for (const env of clip.envelopes) checkEnvelope(clip.id, env, diagnostics);
    const tr = clip.transition_out;
    if (tr) {
      const problem = easingDiagnostic(`${clip.id} transition_out`, tr.easing, tr.bezier, {
        allowHold: false,
      });
      if (problem) diagnostics.push(problem);
    }
  }
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      for (const env of cue.envelopes) checkEnvelope(cue.id, env, diagnostics);
    }
  }
}
