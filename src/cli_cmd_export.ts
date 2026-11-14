// CLI 'export timeline' command: timeline interchange for other editors.
import fs from "node:fs";
import path from "node:path";
import { strFlag } from "./cli_args.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
} from "./cli_output.js";
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import { loadSequence } from "./core/workspace.js";
import {
  exportTimeline,
  TimelineExportFormat,
} from "./export/timeline.js";

const FORMATS: TimelineExportFormat[] = ["fcpxml", "xmeml", "edl", "otio"];

function defaultExtension(format: TimelineExportFormat): string {
  switch (format) {
    case "fcpxml":
      return ".fcpxml";
    case "xmeml":
      return ".xml";
    case "edl":
      return ".edl";
    case "otio":
      return ".otio";
  }
}

export async function runExportCommand(ctx: CliCommandContext): Promise<CliCommandResult> {
  const { action, rest, flags, workspaceDir } = ctx;
  if (action !== "timeline") return CLI_NOT_HANDLED;
  const { paths, sequence } = loadSequence(workspaceDir);
  if (sequence.spine.clips.length === 0) {
    throw new CutholError(DIAGNOSTICS.EXPORT_NO_SPINE());
  }
  // Note: `--format` is the reserved global output flag (text/json/compact),
  // so the interchange format travels as the positional or `--as`.
  const formatRaw = (strFlag(flags, "as") ?? rest[0] ?? "").toLowerCase();
  if (!FORMATS.includes(formatRaw as TimelineExportFormat)) {
    throw new CutholError(
      DIAGNOSTICS.EXPORT_UNKNOWN_FORMAT(formatRaw || "(missing)", FORMATS.join(", "))
    );
  }
  const format = formatRaw as TimelineExportFormat;
  const result = exportTimeline(sequence, paths, format);
  const outRaw = strFlag(flags, "out");
  const resolvedOut = outRaw
    ? path.isAbsolute(outRaw)
      ? outRaw
      : path.resolve(paths.rootDir, outRaw)
    : path.join(paths.rootDir, `export_timeline${defaultExtension(format)}`);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.writeFileSync(resolvedOut, result.content, "utf8");
  console.log(`exported ${format} to ${resolvedOut} (${sequence.spine.clips.length} spine clip(s))`);
  if (result.notExported.length === 0) {
    console.log("not exported: nothing (all timeline elements are portable)");
  } else {
    for (const line of result.notExported) {
      console.log(`not exported: ${line}`);
    }
  }
  return;
}
