// CLI output state, command handler context, and envelope emission helpers (split out of cli.ts).
import { buildWorkspaceEnvelopeHeader } from "./core/workspace.js";
import { formatEnvelopeCompact } from "./mcp/server.js";
import { drainLiveInbox } from "./live/live_inbox.js";

export const CLI_NOT_HANDLED = Symbol("CLI_NOT_HANDLED");
export type CliCommandResult = void | typeof CLI_NOT_HANDLED;

export interface CliCommandContext {
  group: string;
  action: string | undefined;
  rest: string[];
  flags: Record<string, string | boolean>;
  workspaceDir: string;
  formatFlag: string;
}

export let activeCliCompactMode = false;
export let activeCliWorkspaceDir = process.cwd();
export let activeCliRevisionBefore: number | null = null;
export let activeCliValues: Record<string, unknown> = {};
export let activeCliGroup = "";
export let activeCliAction: string | undefined;
export let activeCliSub: string | undefined;

export function setActiveCliCommand(
  group: string,
  action: string | undefined,
  sub: string | undefined
): void {
  activeCliGroup = group;
  activeCliAction = action;
  activeCliSub = sub;
}

export function setActiveCliCompactMode(compactMode: boolean): void {
  activeCliCompactMode = compactMode;
}

export function setActiveCliWorkspaceDir(workspaceDir: string): void {
  activeCliWorkspaceDir = workspaceDir;
}

export function setActiveCliRevisionBefore(revisionBefore: number | null): void {
  activeCliRevisionBefore = revisionBefore;
}

export function setActiveCliValues(values: Record<string, unknown>): void {
  activeCliValues = values;
}

export function emitEnvelopeObject(
  workspaceDir: string,
  command: string,
  envObj: Record<string, unknown>
): void {
  // Cuthol Live: notes the user queued in the window ride along with the next response.
  let liveNotes: ReturnType<typeof drainLiveInbox> = null;
  try {
    liveNotes = drainLiveInbox(workspaceDir);
  } catch {
    liveNotes = null;
  }
  if (liveNotes) envObj = { ...envObj, live_notes: liveNotes };
  if (activeCliCompactMode) {
    const { text } = formatEnvelopeCompact({
      envelope: envObj,
      command,
      dir: workspaceDir,
      values: activeCliValues,
      revisionBefore: activeCliRevisionBefore,
      exitCode: envObj.ok === false ? 1 : 0,
    });
    console.log(text);
    return;
  }
  console.log(JSON.stringify(envObj, null, 2));
}

export function emitEnvelopeJson(
  workspaceDir: string,
  command: string,
  payload: Record<string, unknown>
): void {
  let header: Record<string, unknown> = { schema_version: "cuthol.envelope/1" };
  try {
    header = buildWorkspaceEnvelopeHeader(workspaceDir);
  } catch {
    // workspace might not exist yet
  }
  emitEnvelopeObject(workspaceDir, command, {
    ok: true,
    command,
    ...header,
    ...payload,
  });
}
