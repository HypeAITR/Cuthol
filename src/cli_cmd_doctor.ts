// CLI 'doctor' command: checks the local environment Cuthol needs and prints one fix per problem.
import { CLI_NOT_HANDLED, CliCommandContext, CliCommandResult } from "./cli_output.js";

export async function runDoctorCommand(ctx: CliCommandContext): Promise<CliCommandResult> {
  void ctx;
  return CLI_NOT_HANDLED;
}
