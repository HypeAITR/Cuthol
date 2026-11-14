// Cuthol Live colour endpoints: graded-preview LUTs, unsaved drag previews, and the text colour map.
// Routes (registered by the live server): GET /api/color/lut?item=<id>,
// POST /api/color/preview {item, stage}, GET /api/color/map?item=<id>.
import type http from "node:http";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSequence } from "../core/workspace.js";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { itemColorProgram, listColorItems } from "../color/blocks.js";
import { compileLut, stableHash } from "../color/lut.js";
import type { ColorStageSpec } from "../color/types.js";

export interface LiveColorLutResponse {
  ok: true;
  item: string;
  hash: string;
  size: number;
  /** Base64 of the Float32Array RGB LUT (size^3 * 3 floats, little-endian). */
  data: string;
  identity: boolean;
  selftest: { samples: number; mean_de: number; p99_de: number; max_de: number };
  bake_ms: number;
}

function readBody(req: http.IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, json: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json));
}

/** Small server-side LUT cache: repeat fetches for an unchanged stage skip the bake. */
const lutCache = new Map<string, LiveColorLutResponse>();
const LUT_CACHE_MAX = 8;

function lutResponse(itemId: string, hashInput: unknown, fn: (p: [number, number, number]) => void, identity: boolean): LiveColorLutResponse {
  const preHash = stableHash(hashInput);
  const hit = lutCache.get(preHash);
  if (hit && hit.item === itemId) return { ...hit, bake_ms: 0 };
  const t0 = Date.now();
  const { lut, selftest } = compileLut(fn);
  const bakeMs = Date.now() - t0;
  const hash = stableHash(hashInput);
  const bytes = Buffer.from(lut.data.buffer, lut.data.byteOffset, lut.data.byteLength);
  const out: LiveColorLutResponse = {
    ok: true,
    item: itemId,
    hash,
    size: lut.size,
    data: bytes.toString("base64"),
    identity,
    selftest,
    bake_ms: bakeMs,
  };
  lutCache.set(hash, out);
  if (lutCache.size > LUT_CACHE_MAX) lutCache.delete(lutCache.keys().next().value as string);
  return out;
}

/** GET /api/color/lut?item=<id>: the compiled LUT of an item's stage (blocks + Look). */
export function liveColorLut(projectDir: string, itemId: string): { status: number; json: unknown } {
  let seq: ReturnType<typeof loadSequence>["sequence"];
  let root = projectDir;
  try {
    const loaded = loadSequence(projectDir);
    seq = loaded.sequence;
    root = loaded.paths.rootDir;
  } catch (e) {
    const d = DIAGNOSTICS.COLOR_LIVE_LUT_FAILED(itemId, e instanceof Error ? e.message : String(e));
    return { status: 500, json: { ok: false, code: d.code, message: d.formatted } };
  }
  const items = listColorItems(seq);
  const item = items.find((i) => i.id === itemId);
  if (!item) {
    const d = DIAGNOSTICS.COLOR_LIVE_LUT_FAILED(itemId, `unknown colour item '${itemId}'`);
    return { status: 404, json: { ok: false, code: d.code, message: d.formatted } };
  }
  try {
    const t0 = Date.now();
    const prog = itemColorProgram(seq, root, item);
    const out = lutResponse(item.id, prog.hashInput, prog.fn, prog.identity);
    void t0;
    return { status: 200, json: out };
  } catch (e) {
    const d = DIAGNOSTICS.COLOR_LIVE_LUT_FAILED(itemId, e instanceof Error ? e.message : String(e));
    return { status: 500, json: { ok: false, code: d.code, message: d.formatted } };
  }
}

/** POST /api/color/preview {item, stage}: LUT for an unsaved stage (slider drag, no journal write). */
export function liveColorPreview(projectDir: string, body: { item?: unknown; stage?: unknown }): { status: number; json: unknown } {
  const itemId = typeof body.item === "string" ? body.item : "";
  if (!itemId) {
    const d = DIAGNOSTICS.COLOR_LIVE_LUT_FAILED("(request)", "preview needs 'item'");
    return { status: 400, json: { ok: false, code: d.code, message: d.formatted } };
  }
  const stage = (body.stage ?? {}) as ColorStageSpec;
  if (typeof stage !== "object" || stage === null || Array.isArray(stage)) {
    const d = DIAGNOSTICS.COLOR_LIVE_LUT_FAILED(itemId, "preview needs 'stage' (a colour stage object)");
    return { status: 400, json: { ok: false, code: d.code, message: d.formatted } };
  }
  let loaded: ReturnType<typeof loadSequence>;
  try {
    loaded = loadSequence(projectDir);
  } catch (e) {
    const d = DIAGNOSTICS.COLOR_LIVE_LUT_FAILED(itemId, e instanceof Error ? e.message : String(e));
    return { status: 500, json: { ok: false, code: d.code, message: d.formatted } };
  }
  const item = listColorItems(loaded.sequence).find((i) => i.id === itemId);
  if (!item) {
    const d = DIAGNOSTICS.COLOR_LIVE_LUT_FAILED(itemId, `unknown colour item '${itemId}'`);
    return { status: 404, json: { ok: false, code: d.code, message: d.formatted } };
  }
  try {
    const prog = itemColorProgram(loaded.sequence, loaded.paths.rootDir, item, stage);
    return { status: 200, json: lutResponse(item.id, prog.hashInput, prog.fn, prog.identity) };
  } catch (e) {
    const d = DIAGNOSTICS.COLOR_LIVE_LUT_FAILED(itemId, e instanceof Error ? e.message : String(e));
    return { status: 500, json: { ok: false, code: d.code, message: d.formatted } };
  }
}

/**
 * GET /api/color/map?item=<id>: text colour map lines of the item as it looks now (after its grade).
 * Measuring decodes frames with ffmpeg, so it runs in a child CLI process and never blocks the event loop.
 */
export async function liveColorMap(projectDir: string, itemId: string): Promise<{ status: number; json: unknown }> {
  let loaded: ReturnType<typeof loadSequence>;
  try {
    loaded = loadSequence(projectDir);
  } catch (e) {
    const d = DIAGNOSTICS.COLOR_LIVE_MAP_FAILED(itemId, e instanceof Error ? e.message : String(e));
    return { status: 500, json: { ok: false, code: d.code, message: d.formatted } };
  }
  const item = listColorItems(loaded.sequence).find((i) => i.id === itemId);
  if (!item) {
    const d = DIAGNOSTICS.COLOR_LIVE_MAP_FAILED(itemId, `unknown colour item '${itemId}'`);
    return { status: 404, json: { ok: false, code: d.code, message: d.formatted } };
  }
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, "color", "map", "--item", itemId, "--graded", "--frames", "5", "--json", "--dir", projectDir],
      { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" } },
      (err, stdout) => {
        try {
          const env = JSON.parse(String(stdout)) as { ok?: boolean; lines?: string[]; error?: { message?: string } };
          if (env.ok && Array.isArray(env.lines)) return resolve({ status: 200, json: { ok: true, item: itemId, lines: env.lines } });
          throw new Error(env.error?.message ?? "no lines");
        } catch (e) {
          const why = err ? err.message : e instanceof Error ? e.message : String(e);
          const d = DIAGNOSTICS.COLOR_LIVE_MAP_FAILED(itemId, why.split("\n")[0]);
          resolve({ status: 500, json: { ok: false, code: d.code, message: d.formatted } });
        }
      }
    );
  });
}

/** Colour route handler (registered by the live server with the same token/Origin checks as /api/*). */
export async function routeLiveColorRequest(projectDir: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === "/api/color/lut" && req.method === "GET") {
    const out = liveColorLut(projectDir, url.searchParams.get("item") ?? "");
    sendJson(res, out.status, out.json);
    return true;
  }
  if (url.pathname === "/api/color/preview" && req.method === "POST") {
    let body: { item?: unknown; stage?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as { item?: unknown; stage?: unknown };
    } catch {
      sendJson(res, 400, { ok: false, message: "bad json" });
      return true;
    }
    const out = liveColorPreview(projectDir, body ?? {});
    sendJson(res, out.status, out.json);
    return true;
  }
  if (url.pathname === "/api/color/map" && req.method === "GET") {
    const out = await liveColorMap(projectDir, url.searchParams.get("item") ?? "");
    sendJson(res, out.status, out.json);
    return true;
  }
  return false;
}
