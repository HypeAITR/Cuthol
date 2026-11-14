// CLI 'setup' command: registers the Cuthol MCP server with the agent tools found on this machine.
import { CLI_NOT_HANDLED, CliCommandContext, CliCommandResult } from "./cli_output.js";

export async function runSetupCommand(ctx: CliCommandContext): Promise<CliCommandResult> {
  void ctx;
  return CLI_NOT_HANDLED;
}
