// CLI 'doctor' command: one environment health check per line with a fix each.
import { collectDoctorChecks } from "./core/doctor.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";

export async function runDoctorCommand(ctx: CliCommandContext): Promise<CliCommandResult> {
  void CLI_NOT_HANDLED;
  const { flags, workspaceDir, formatFlag } = ctx;
  const wantsJson = Boolean(flags["json"]) || formatFlag === "json";
  const checks = collectDoctorChecks();
  const okCount = checks.filter((c) => c.status === "ok").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const failCount = checks.filter((c) => c.status === "fail").length;
  if (wantsJson) {
    emitEnvelopeJson(workspaceDir, "doctor", {
      action: "doctor",
      checks,
      summary: { ok: okCount, warn: warnCount, fail: failCount },
      ok: failCount === 0,
    });
  } else {
    for (const check of checks) {
      console.log(`${check.status} ${check.id}: ${check.found}${check.status === "ok" ? "" : ` | fix: ${check.fix}`}`);
    }
    console.log(`doctor: ${okCount} ok, ${warnCount} warn, ${failCount} fail`);
    console.log("Run 'cuthol setup' to register Cuthol (MCP) with your agent tools.");
  }
  if (failCount > 0) process.exitCode = 1;
}
