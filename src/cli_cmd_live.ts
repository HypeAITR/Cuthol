import { CLI_NOT_HANDLED, type CliCommandContext, emitEnvelopeJson } from "./cli_output.js";
import { boolFlag, numFlag, strFlag } from "./cli_args.js";
import { resolveLiveConfig, setLiveConfig } from "./live/live_config.js";
import { ensureLiveServer, getLiveStatus, runLiveServer, stopLiveServer, waitForLiveResume } from "./live/live_server.js";
import { openLiveWindow } from "./live/live_window.js";
import type { LiveMode } from "./live/live_types.js";

/**
 * `cuthol live open|status|wait|config|stop|serve`.
 * open   start (or reuse) the project's live server and open the window
 * status one-line state for the agent: mode, running, lock, pending notes
 * wait   block until the user resumes the agent (after G601)
 * config --mode ask|on|off [--global]
 * stop   stop the server (the window shows "disconnected")
 * serve  internal: run the server in this process (spawned by `open`)
 */
export async function runLiveCommand(ctx: CliCommandContext): Promise<unknown> {
  const { action, flags, workspaceDir } = ctx;
  switch (action) {
    case "open": {
      const server = await ensureLiveServer(workspaceDir);
      const window = boolFlag(flags, "no-window") ? { opened: false, mode: "none" as const } : openLiveWindow(server.url, workspaceDir);
      emitEnvelopeJson(workspaceDir, "live open", { live: { url: server.url, port: server.port, pid: server.pid, window } });
      return;
    }
    case "status": {
      const status = getLiveStatus(workspaceDir);
      emitEnvelopeJson(workspaceDir, "live status", { live: { ...status, config: resolveLiveConfig(workspaceDir) } });
      return;
    }
    case "wait": {
      const r = await waitForLiveResume(workspaceDir, numFlag(flags, "timeout") ?? 1800);
      emitEnvelopeJson(workspaceDir, "live wait", { live: r });
      return;
    }
    case "config": {
      const mode = strFlag(flags, "mode") as LiveMode | undefined;
      const resolved = mode ? setLiveConfig(workspaceDir, mode, boolFlag(flags, "global") ? "user" : "project") : resolveLiveConfig(workspaceDir);
      emitEnvelopeJson(workspaceDir, "live config", { live: { config: resolved } });
      return;
    }
    case "stop": {
      const stopped = await stopLiveServer(workspaceDir);
      emitEnvelopeJson(workspaceDir, "live stop", { live: { stopped } });
      return;
    }
    case "serve": {
      await runLiveServer(workspaceDir, { port: numFlag(flags, "port") });
      return;
    }
  }
  return CLI_NOT_HANDLED;
}
