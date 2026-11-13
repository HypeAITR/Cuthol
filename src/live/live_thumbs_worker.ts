// Runs scene thumbnail rendering off the live server's event loop. Rendering a
// thumbnail goes through the synchronous monitor-frame path (seconds per scene);
// on the main thread that would hold back SSE deltas and every other request.
import { parentPort, workerData } from "node:worker_threads";
import { refreshSceneThumbs } from "./live_thumbs.js";
import type { LiveSceneSummary } from "./live_types.js";

const { projectDir, sequence, scenes } = workerData as { projectDir: string; sequence: unknown; scenes: LiveSceneSummary[] };

refreshSceneThumbs(projectDir, sequence, scenes).then(
  (ids) => parentPort?.postMessage({ ids }),
  (e: unknown) => parentPort?.postMessage({ ids: [], error: String(e) })
);
