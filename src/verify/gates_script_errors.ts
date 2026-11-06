// G4 composition page script errors (CUTHOL-G430..G432): reports the script-error record
// matching the current composition files, WITHOUT a browser. Records are written by
// coordinate measurement (every frame seek), `composition preview` (`hyperframes check`),
// and the monitor probe (page load plus timeline seeks); a record matches only the exact
// files it was measured against, so an unknown composition stays silent (never "clean").
import path from "node:path";
import { CutholDiagnostic } from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { readCurrentScriptErrorRecord } from "../compositor/coords_extract.js";
import { scriptRecordToDiagnostic } from "../compositor/hf_script_errors.js";

export function verifyCompositionScripts(
  sequence: CutholSequence,
  paths: WorkspacePaths | undefined,
  diagnostics: CutholDiagnostic[]
): void {
  if (!paths) return;
  for (const lane of sequence.lanes) {
    if (lane.muted) continue;
    if (lane.kind === "music" || lane.kind === "sfx" || lane.kind === "voiceover") continue;
    for (const cue of lane.cues) {
      if (cue.kind !== "composition" || !cue.composition) continue;
      let absCompDir: string;
      try {
        absCompDir = path.isAbsolute(cue.composition.composition_dir)
          ? cue.composition.composition_dir
          : path.resolve(paths.rootDir, cue.composition.composition_dir);
      } catch {
        continue;
      }
      const record = readCurrentScriptErrorRecord(paths.rootDir, absCompDir, cue.composition.entry_html);
      if (!record) continue;
      const diag = scriptRecordToDiagnostic(cue.id, record);
      if (diag) diagnostics.push(diag);
    }
  }
}
