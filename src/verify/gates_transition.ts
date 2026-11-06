// Verify pass for extension spine transitions (`ext:<extension>/<name>`).
// Called from verifySequence (gates.ts) with the enabled gate set: G1 codes only run under G1_SCHEMA,
// the G413 pin warning only under G4_STAGE. Duration bounds (G303) stay in G3 (kind-agnostic).
import type { CutholDiagnostic, VerificationGateId } from "../core/diagnostics.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type { CutholSequence, ExtensionEffectRef } from "../core/schema.js";
import type { WorkspacePaths } from "../core/workspace.js";
import {
  getSequenceEffectRegistry,
  isExtensionEffectRef,
  parseExtensionEffectRef,
} from "../extensions/ext_effects.js";
import { resolveTransitionParams } from "../extensions/ext_transitions.js";

export function verifyExtensionTransitions(
  seq: CutholSequence,
  paths: WorkspacePaths | undefined,
  diagnostics: CutholDiagnostic[],
  gatesRun: ReadonlySet<VerificationGateId>
): void {
  const checkG1 = gatesRun.has("G1_SCHEMA");
  const checkG4 = gatesRun.has("G4_STAGE");
  if (!checkG1 && !checkG4) return;
  for (const clip of seq.spine.clips) {
    const tr = clip.transition_out;
    if (!tr) continue;
    if (!tr.kind.startsWith("ext:")) {
      if (checkG1 && tr.params && Object.keys(tr.params).length > 0) {
        diagnostics.push(
          DIAGNOSTICS.EXTENSION_TRANSITION_PARAM_INVALID(
            tr.kind,
            clip.id,
            `Built-in '${tr.kind}' transition takes no parameters.`
          )
        );
      }
      continue;
    }
    const ref = isExtensionEffectRef(tr.kind) ? parseExtensionEffectRef(tr.kind) : null;
    if (checkG1 && !ref) {
      diagnostics.push(
        DIAGNOSTICS.EXTENSION_TRANSITION_UNAVAILABLE(
          tr.kind,
          `not in 'ext:<extension>/<name>' form (lowercase, [a-z0-9_-]).`,
          clip.id
        )
      );
      continue;
    }
    if (!paths || !ref) continue;
    const registry = getSequenceEffectRegistry(seq, paths.rootDir);
    const def = registry.transitions.get(tr.kind as ExtensionEffectRef);
    if (!def) {
      if (checkG1) {
        const loadErr = registry.load_errors.get(ref.extension);
        diagnostics.push(
          DIAGNOSTICS.EXTENSION_TRANSITION_UNAVAILABLE(
            tr.kind,
            loadErr
              ? `extension '${ref.extension}' failed to load: ${loadErr}`
              : `extension '${ref.extension}' is not enabled in the project, or does not define the '${ref.name}' transition.`,
            clip.id
          )
        );
      }
      continue;
    }
    if (checkG1) {
      try {
        resolveTransitionParams(def.spec, tr.params, tr.kind, clip.id);
      } catch (err) {
        diagnostics.push(
          err instanceof CutholError
            ? err.diagnostic
            : DIAGNOSTICS.EXTENSION_TRANSITION_PARAM_INVALID(tr.kind, clip.id, String(err))
        );
      }
    }
    if (checkG4 && !def.pinned_match) {
      const pinned = (seq.extensions ?? []).find((e) => e.name === def.extension);
      diagnostics.push(
        DIAGNOSTICS.EXTENSION_TRANSITION_PIN_MISMATCH(
          def.extension,
          pinned?.version ?? "?",
          pinned?.content_hash ?? "?",
          def.version,
          def.content_hash,
          clip.id
        )
      );
    }
  }
}
