/**
 * Cuthol Live exact frame (`src/live/live_frame.ts`).
 *
 * The in-window preview is an approximation (no color grade, no clip fx, no
 * LUT). The "Exact frame" button asks the server for the true composite pixel
 * at the playhead through the `monitor frame` path (`captureMonitorFrame`)
 * and overlays it on the stage.
 *
 * Endpoint contract (owned by the live server file; this module only exports
 * the handler so it can be mounted):
 *   GET /api/frame?at=<ms>  -> PNG (exact composite, no HUD/boxes) or
 *                             500 + JSON (CUTHOL-G612) when the render fails.
 *
 * The render is synchronous and can take a few seconds (one composite frame);
 * it never touches the sequence, only reads it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { captureMonitorFrame } from "../monitor/preview.js";

/** Render the exact composite PNG at `atMs`; returns the temp file path. */
export function renderLiveExactFrame(projectDir: string, atMs: number): string {
  const out = path.join(os.tmpdir(), `cuthol-live-frame-${process.pid}-${crypto.randomBytes(4).toString("hex")}.png`);
  const result = captureMonitorFrame({ workspaceDir: path.resolve(projectDir), atMs, showBoxes: false, outputPath: out });
  if (!result.ok || !fs.existsSync(result.png_path)) {
    try {
      fs.unlinkSync(out);
    } catch {}
    const first = result.diagnostics[0];
    throw new Error(first ? `${first.code}: ${first.what}` : "frame render failed");
  }
  return result.png_path;
}

/**
 * Mount point for `GET /api/frame?at=<ms>`. Returns true when handled.
 * Streams the PNG and removes the temp file afterwards.
 */
export function routeLiveFrameRequest(
  projectDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  atMs: number
): boolean {
  if (!Number.isFinite(atMs) || atMs < 0) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "query param 'at' must be ms >= 0" }));
    return true;
  }
  let file: string;
  try {
    file = renderLiveExactFrame(projectDir, atMs);
  } catch (e) {
    const diag = DIAGNOSTICS.LIVE_EXACT_FRAME_FAILED(atMs, String((e as Error)?.message ?? e));
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, diagnostic: diag }));
    return true;
  }
  res.writeHead(200, { "Content-Type": "image/png", "Content-Length": fs.statSync(file).size, "Cache-Control": "no-cache" });
  const stream = fs.createReadStream(file);
  stream.on("close", () => {
    try {
      fs.unlinkSync(file);
    } catch {}
  });
  stream.pipe(res);
  return true;
}
