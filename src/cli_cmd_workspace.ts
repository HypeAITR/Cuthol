// CLI 'workspace' command group handler (split out of cli.ts).
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import { AspectPreset } from "./core/schema.js";
import {
  initWorkspace,
  loadJournalManifest,
  loadSequence,
  openWorkspaceSummary,
  stepJournal,
  tagCurrentRevision,
} from "./core/workspace.js";
import { setStageBackdropColor } from "./sequence/stage.js";
import { boolFlag, numFlag, strFlag } from "./cli_args.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
  emitEnvelopeObject,
} from "./cli_output.js";

export function runWorkspaceCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, rest, flags, workspaceDir } = ctx;
  if (action === "init") {
    const targetDir = rest[0] ?? workspaceDir;
    const aspect = (strFlag(flags, "aspect", "9:16") as AspectPreset) ?? "9:16";
    const fps = numFlag(flags, "fps", 30) ?? 30;
    const title = strFlag(flags, "title");
    const { paths, sequence } = initWorkspace({ dir: targetDir, aspect, fps, title });
    emitEnvelopeJson(targetDir, "workspace.init", {
      action: "workspace.init",
      sequence_file: paths.sequenceFile,
      ledger_file: paths.ledgerFile,
      project_id: sequence.meta.project_id,
      stage: sequence.stage,
    });
    return;
  }

  if (action === "open") {
    const targetDir = rest[0] ?? workspaceDir;
    const res = openWorkspaceSummary(targetDir, {
      verbose: boolFlag(flags, "verbose", false),
    });
    emitEnvelopeJson(targetDir, "workspace.open", {
      action: "workspace.open",
      ...res,
    });
    return;
  }

  if (action === "backdrop") {
    const color = strFlag(flags, "color") ?? rest[0];
    if (!color) throw new CutholError(DIAGNOSTICS.INVALID_COLOR("(boş / missing --color)"));
    const res = setStageBackdropColor({ workspaceDir, color });
    emitEnvelopeJson(workspaceDir, "workspace.backdrop", {
      action: "workspace.backdrop",
      ...res,
    });
    return;
  }

  if (action === "journal") {
    const sub = rest[0] ?? "list";
    if (sub === "list") {
      const { paths } = loadSequence(workspaceDir);
      const manifest = loadJournalManifest(paths);
      emitEnvelopeJson(workspaceDir, "workspace.journal.list", { ...manifest });
      return;
    }
    if (sub === "undo" || sub === "redo") {
      const allowRaw = strFlag(flags, "allow-protected");
      const allowProtected = allowRaw
        ? allowRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      const res = stepJournal(workspaceDir, sub, {
        steps: numFlag(flags, "steps"),
        toRevision: numFlag(flags, "to"),
        expectRevision: numFlag(flags, "expect-rev"),
        dryRun: boolFlag(flags, "dry-run", false),
        allowProtected,
      });
      emitEnvelopeObject(workspaceDir, `workspace.journal.${sub}`, {
        ok: true,
        command: `workspace.journal.${sub}`,
        action: `journal.${sub}`,
        schema_version: "cuthol.envelope/1",
        dry_run: res.dry_run,
        previous_revision: res.previous_revision,
        revision: res.revision,
        operation: res.operation,
        reverted_entries: res.reverted_entries,
        state: res.state,
        delta: {
          summary:
            res.reverted_entries.map((e) => e.inverse_summary).join("; ") || res.operation,
          affected_ids: [...new Set(res.reverted_entries.flatMap((e) => e.affected_ids))],
        },
        history: res.history,
      });
      return;
    }
    if (sub === "tag") {
      const tag = rest[1] ?? strFlag(flags, "name", "checkpoint")!;
      const entry = tagCurrentRevision(workspaceDir, tag);
      emitEnvelopeJson(workspaceDir, "workspace.journal.tag", {
        action: "journal.tag",
        entry,
      });
      return;
    }
  }
  return CLI_NOT_HANDLED;
}
