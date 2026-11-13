// Runs the window's timeline edits through the same CLI command handlers as
// `cuthol spine|lane|workspace …`, in a long-lived worker thread of the live
// server. A fresh CLI process per edit costs ~1–3 s of module loading; here the
// modules load once. Same journal, same lock check (the worker's own env says
// CUTHOL_LIVE_ACTOR=human), same envelopes.
import { parentPort } from "node:worker_threads";
import { CutholError } from "../core/diagnostics.js";
import { parseArgv, boolFlag, strFlag, numFlag } from "../cli_args.js";
import {
  CLI_NOT_HANDLED,
  type CliCommandContext,
  setActiveCliCommand,
  setActiveCliCompactMode,
  setActiveCliRevisionBefore,
  setActiveCliValues,
  setActiveCliWorkspaceDir,
} from "../cli_output.js";
import { runWorkspaceCommand } from "../cli_cmd_workspace.js";
import { runSpineCommand } from "../cli_cmd_spine.js";
import { runLaneCommand } from "../cli_cmd_lane.js";
import { readWorkspaceRevision } from "../mcp/mcp_format.js";
import { runWorkspaceVerification } from "../verify/gates.js";
import { LIVE_ACTOR_ENV } from "./live_types.js";

// Worker threads get their own copy of process.env: this marks only the
// worker's writes as the human's.
process.env[LIVE_ACTOR_ENV] = "human";
process.env["CUTHOL_SKILLS_AUTO"] = "0";

export interface LiveEditJob {
  id: number;
  args: string[];
  projectDir: string;
}

export interface LiveEditJobResult {
  id: number;
  status: number;
  stdout: string;
  stderr: string;
}

function runJob(job: LiveEditJob): LiveEditJobResult {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
  let status = 0;
  try {
    const { positionals, flags } = parseArgv([...job.args, "--dir", job.projectDir]);
    const [group, action, ...rest] = positionals;
    setActiveCliCommand(group ?? "", action, rest[0]);
    setActiveCliCompactMode(false);
    setActiveCliWorkspaceDir(job.projectDir);
    setActiveCliRevisionBefore(readWorkspaceRevision(job.projectDir));
    setActiveCliValues({
      dry_run: boolFlag(flags, "dry-run", false),
      verbose: boolFlag(flags, "verbose", false),
      clip: strFlag(flags, "clip"),
      cursor: strFlag(flags, "cursor"),
      limit: numFlag(flags, "limit"),
    });
    const ctx: CliCommandContext = { group: group ?? "", action, rest, flags, workspaceDir: job.projectDir, formatFlag: "" };
    const handled =
      group === "spine" ? runSpineCommand(ctx) : group === "lane" ? runLaneCommand(ctx) : group === "workspace" ? runWorkspaceCommand(ctx) : CLI_NOT_HANDLED;
    if (handled === CLI_NOT_HANDLED) {
      status = 1;
      err.push(`not an edit command: ${job.args.join(" ")}`);
    } else if (process.exitCode && process.exitCode !== 0) {
      status = Number(process.exitCode);
    }
  } catch (e) {
    status = 1;
    const envelope =
      e instanceof CutholError
        ? { ok: false, schema_version: "cuthol.envelope/1", diagnostic: e.diagnostic }
        : { ok: false, schema_version: "cuthol.envelope/1", error: e instanceof Error ? e.message : String(e) };
    err.push(JSON.stringify(envelope, null, 2));
  } finally {
    process.exitCode = 0;
    console.log = log;
    console.error = error;
  }
  return { id: job.id, status, stdout: out.join("\n"), stderr: err.join("\n") };
}

parentPort?.on("message", (job: LiveEditJob | { warm: string }) => {
  if ("warm" in job) {
    // Pause pressed: pay the one-time costs (tool probes, composition lint
    // cache) before the first edit instead of during it.
    try {
      runWorkspaceVerification(job.warm);
    } catch {
      // warming is best effort
    }
    return;
  }
  parentPort?.postMessage(runJob(job));
});
