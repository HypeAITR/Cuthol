import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package root (two levels above dist/live or src/live). */
export const LIVE_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Static window files ship as plain HTML/CSS/JS in the source tree (not compiled by tsc). */
export const LIVE_UI_DIR = path.join(LIVE_PACKAGE_ROOT, "src", "live", "ui");

export interface LivePaths {
  dir: string;
  serverFile: string;
  lockFile: string;
  progressFile: string;
  inboxDir: string;
  proxiesDir: string;
  thumbsDir: string;
  logFile: string;
}

export function resolveLivePaths(projectDir: string): LivePaths {
  const dir = path.join(path.resolve(projectDir), ".cuthol", "live");
  return {
    dir,
    serverFile: path.join(dir, "server.json"),
    lockFile: path.join(dir, "lock.json"),
    progressFile: path.join(dir, "progress.json"),
    inboxDir: path.join(dir, "inbox"),
    proxiesDir: path.join(dir, "proxies"),
    thumbsDir: path.join(dir, "thumbs"),
    logFile: path.join(dir, "server.log"),
  };
}
