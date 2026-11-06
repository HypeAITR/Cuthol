// `spine fx` verification (G118 unknown kind / bad params, G119 unsupported envelope, G411 drift).
// The G118/G119 checks reuse the real stage-4 compiler per clip, so verify and render can never disagree:
// whatever the compiler would throw becomes a diagnostic attached to the offending clip. G411 (extension
// version/hash drift) is advisory and never blocks a commit. Clips without fx entries or fx envelopes are
// skipped untouched, so fx-less projects verify byte-identically to before.
import { CutholDiagnostic, CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type { CutholSequence, ExtensionEffectRef } from "../core/schema.js";
import type { WorkspacePaths } from "../core/workspace.js";
import type { VideoGraphCompileContext } from "../compositor/compiler.js";
import {
  buildSpineClipFxFilters,
  spineClipNeedsFxCheck,
} from "../compositor/compile_spine_fx.js";
import { getSequenceEffectRegistry } from "../extensions/ext_effects.js";

export function verifySpineFx(
  seq: CutholSequence,
  paths: WorkspacePaths | undefined,
  diagnostics: CutholDiagnostic[]
): void {
  if (!seq.spine.clips.some(spineClipNeedsFxCheck)) return;
  // The fx stage only reads `seq` and `paths.rootDir` from the context; the remaining compile fields and the
  // per-clip asset/color arguments below are unused by stage 4 (kept for the stage call shape).
  const ctx = { seq, paths } as VideoGraphCompileContext;
  for (const clip of seq.spine.clips) {
    if (!spineClipNeedsFxCheck(clip)) continue;
    try {
      buildSpineClipFxFilters(ctx, {
        clip,
        asset: undefined as never,
        absAssetPath: "",
        clipColorSpec: undefined as never,
        targetW: 0,
        targetH: 0,
      });
    } catch (err) {
      if (err instanceof CutholError && err.diagnostic) {
        diagnostics.push(err.diagnostic);
        continue;
      }
      throw err;
    }
  }
  const rootDir = paths?.rootDir;
  if (!rootDir) return;
  let reg: ReturnType<typeof getSequenceEffectRegistry> | null = null;
  for (const clip of seq.spine.clips) {
    for (const fx of clip.fx ?? []) {
      if (fx.enabled === false || !fx.kind.startsWith("ext:")) continue;
      reg ??= getSequenceEffectRegistry(seq, rootDir);
      const def = reg.fx.get(fx.kind as ExtensionEffectRef);
      if (def && !def.pinned_match) {
        const pinned = (seq.extensions ?? []).find((e) => e.name === def.extension);
        const pinnedLabel = pinned ? `v${pinned.version} (${pinned.content_hash.slice(0, 8)})` : "no record";
        diagnostics.push(
          DIAGNOSTICS.SPINE_FX_EXTENSION_DRIFTED(
            clip.id,
            fx.id,
            def.ref,
            def.extension,
            pinnedLabel,
            `v${def.version} (${def.content_hash.slice(0, 8)})`
          )
        );
      }
    }
  }
}
