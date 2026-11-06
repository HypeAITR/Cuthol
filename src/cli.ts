#!/usr/bin/env node
/**
 * Cuthol CLI Entry Point (`src/cli.ts`).
 *
 * Agent-native command surface for workspace management, media library ingestion,
 * signal/scene analysis, spine & lane editing, declarative cue sheets,
 * 5-gate verification, and multi-lens sequence inspection.
 */

import path from "node:path";
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import { loadDotEnvIfNeeded } from "./core/env.js";
import {
  CUTHOL_MCP_TOOLS,
  formatEnvelopeCompact,
  readWorkspaceRevision,
  resolveActionSpecForCommand,
  startMcpStdioServer,
} from "./mcp/server.js";
import {
  assertNoExtraPositionals,
  parseArgv,
  boolFlag,
  KNOWN_CLI_FLAGS,
  suggestFlagFix,
  strFlag,
  numFlag,
} from "./cli_args.js";
import { printHelp } from "./cli_help.js";
import {
  activeCliAction,
  activeCliCompactMode,
  activeCliGroup,
  activeCliRevisionBefore,
  activeCliSub,
  activeCliValues,
  activeCliWorkspaceDir,
  CLI_NOT_HANDLED,
  CliCommandContext,
  setActiveCliCommand,
  setActiveCliCompactMode,
  setActiveCliRevisionBefore,
  setActiveCliValues,
  setActiveCliWorkspaceDir,
} from "./cli_output.js";
import { runWorkspaceCommand } from "./cli_cmd_workspace.js";
import { runLibraryCommand } from "./cli_cmd_library.js";
import { runSpineCommand } from "./cli_cmd_spine.js";
import { runLaneCommand } from "./cli_cmd_lane.js";
import { runCompositionCommand, runCueCommand } from "./cli_cmd_composition.js";
import { runSpeechCommand } from "./cli_cmd_speech.js";
import { runMixCommand } from "./cli_cmd_mix.js";
import {
  runBriefCommand,
  runMonitorCommand,
  runRenderCommand,
  runVerifyCommand,
} from "./cli_cmd_output.js";
import { runExtensionCommand } from "./cli_cmd_extension.js";
import { runSkillsCommand } from "./cli_cmd_skills.js";
import { maybeAutoInstallSkills } from "./core/skills_install.js";

async function main(): Promise<void> {
  const { positionals, flags } = parseArgv(process.argv.slice(2));
  const [group, action, ...rest] = positionals;
  setActiveCliCommand(group ?? "", action, rest[0]);

  const formatFlag = typeof flags["format"] === "string" ? flags["format"].trim().toLowerCase() : "";
  const isLibraryQuery = group === "library" && action === "query";
  const wantsJsonOutput = Boolean(flags["json"]) || formatFlag === "json";
  setActiveCliCompactMode(
    !wantsJsonOutput &&
      (boolFlag(flags, "compact", false) === true ||
        formatFlag === "text" ||
        (formatFlag === "compact" && !isLibraryQuery))
  );

  const invokedBin = path.basename(process.argv[1] ?? "").toLowerCase();
  if (group === "mcp" || invokedBin.startsWith("cuthol-mcp")) {
    const mcpDir = typeof flags["dir"] === "string" ? flags["dir"] : undefined;
    startMcpStdioServer({ defaultDir: mcpDir });
    return;
  }

  // Install Cuthol skills into detected agent tools on first run of a new
  // package version. Silent once settled; never breaks the running command.
  // (The `mcp` branch above returns early; the server runs the same hook and
  // reports it on the first tool response instead of stderr.)
  const skillsAutoNote = maybeAutoInstallSkills();
  if (skillsAutoNote) {
    console.error(skillsAutoNote);
  }

  for (const key of Object.keys(flags)) {
    if (!KNOWN_CLI_FLAGS.has(key)) {
      throw new CutholError(
        DIAGNOSTICS.UNKNOWN_FLAG(`--${key}`, `${group ?? "cuthol"}${action ? `.${action}` : ""}`, suggestFlagFix(key, group ?? "", action))
      );
    }
  }
  if (
    formatFlag &&
    formatFlag !== "json" &&
    formatFlag !== "text" &&
    formatFlag !== "compact" &&
    !(isLibraryQuery && formatFlag === "default")
  ) {
    throw new CutholError(
      DIAGNOSTICS.UNKNOWN_FLAG(
        `--format ${String(flags["format"])}`,
        `${group ?? "cuthol"}${action ? `.${action}` : ""}`,
        `cuthol ${group ?? ""}${action ? ` ${action}` : ""} --format text`
      )
    );
  }

  const workspaceDir = strFlag(flags, "dir") ?? strFlag(flags, "project") ?? process.cwd();
  setActiveCliWorkspaceDir(workspaceDir);
  setActiveCliRevisionBefore(readWorkspaceRevision(workspaceDir));
  setActiveCliValues({
    dry_run: boolFlag(flags, "dry-run", false),
    verbose: boolFlag(flags, "verbose", false),
    clip: strFlag(flags, "clip"),
    cursor: strFlag(flags, "cursor"),
    limit: numFlag(flags, "limit"),
  });
  loadDotEnvIfNeeded(workspaceDir);

  if (!group || group === "help" || flags["help"]) {
    if (flags["json"]) {
      const targetGroup = group === "help" ? action : group;
      const tools = targetGroup
        ? CUTHOL_MCP_TOOLS.filter((t) => t.name === targetGroup)
        : CUTHOL_MCP_TOOLS;
      console.log(
        JSON.stringify(
          {
            ok: true,
            command: "help",
            schema_version: "cuthol.envelope/1",
            tools,
            flag_lexicon: {
              workspace_dir: ["--dir", "--project"],
              composition_dir: ["--comp-dir", "--composition-dir"],
              revision_guard: ["--expect-rev"],
              targeted_undo: ["--to"],
            },
          },
          null,
          2
        )
      );
      return;
    }
    printHelp();
    return;
  }

  assertNoExtraPositionals(group, action, rest, flags);

  const ctx: CliCommandContext = {
    group,
    action,
    rest,
    flags,
    workspaceDir,
    formatFlag,
  };

  switch (group) {
    case "workspace":
      if (runWorkspaceCommand(ctx) !== CLI_NOT_HANDLED) return;
      break;
    case "library":
      if (runLibraryCommand(ctx) !== CLI_NOT_HANDLED) return;
      break;
    case "spine":
      if (runSpineCommand(ctx) !== CLI_NOT_HANDLED) return;
      break;
    case "lane":
      if (runLaneCommand(ctx) !== CLI_NOT_HANDLED) return;
      break;
    case "composition":
      if (runCompositionCommand(ctx) !== CLI_NOT_HANDLED) return;
      break;
    case "cue":
      if (runCueCommand(ctx) !== CLI_NOT_HANDLED) return;
      break;
    case "verify":
      if (runVerifyCommand(ctx) !== CLI_NOT_HANDLED) return;
      break;
    case "speech":
      if ((await runSpeechCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    case "mix":
      if (runMixCommand(ctx) !== CLI_NOT_HANDLED) return;
      break;
    case "monitor":
      if (runMonitorCommand(ctx) !== CLI_NOT_HANDLED) return;
      break;
    case "render":
      if (runRenderCommand(ctx) !== CLI_NOT_HANDLED) return;
      break;
    case "brief":
      if (runBriefCommand(ctx) !== CLI_NOT_HANDLED) return;
      break;
    case "extension":
      if (runExtensionCommand(ctx) !== CLI_NOT_HANDLED) return;
      break;
    case "skills":
      if (runSkillsCommand(ctx) !== CLI_NOT_HANDLED) return;
      break;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  const errEnvelope: Record<string, unknown> =
    err instanceof CutholError
      ? {
          ok: false,
          schema_version: "cuthol.envelope/1",
          diagnostic: err.diagnostic,
        }
      : {
          ok: false,
          schema_version: "cuthol.envelope/1",
          error: err instanceof Error ? err.message : String(err),
        };

  if (activeCliCompactMode) {
    const spec = resolveActionSpecForCommand(activeCliGroup, activeCliAction, activeCliSub);
    const { text } = formatEnvelopeCompact({
      envelope: errEnvelope,
      spec,
      dir: activeCliWorkspaceDir,
      values: activeCliValues,
      revisionBefore: activeCliRevisionBefore,
      exitCode: 1,
    });
    console.error(text);
  } else {
    console.error(JSON.stringify(errEnvelope, null, 2));
  }
  process.exitCode = 1;
});
