/**
 * long renders.
 *
 * 1. The post-render blank-frame scan reads the output in bounded chunks; results do not depend on the chunk
 *    size (events that straddle a chunk boundary are merged), so hour-long renders scan with fixed memory.
 * 2. No subprocess whose work grows with media length carries a wall-clock `timeout`, and overlay render
 *    failures are never replaced by a stand-in (`drawbox`) image.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { scanRenderedMp4ForBlankFrames } from "../render/renderer.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");

test("1. Chunked post-render scan finds the same backdrop frames for every chunk size", () => {
  const wsDir = path.join(TEST_ROOT, "chunked_scan");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Chunked Scan", aspect: "16:9", fps: 30 });

  const sourceMp4 = path.join(wsDir, "source.mp4");
  const src = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=320x180:r=30:d=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", sourceMp4,
  ]);
  assert.equal(src.status, 0, src.stderr?.toString());
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [sourceMp4] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
  const { sequence } = loadSequence(wsDir);

  // Paint the stage backdrop colour over known frames: 20, 44..46 (straddles chunk sizes 45/23), 90, 119.
  const bg = sequence.stage.backdrop.color.replace("#", "0x");
  const brokenMp4 = path.join(wsDir, "broken.mp4");
  const paint = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-i", sourceMp4,
    "-vf", `drawbox=c=${bg}:t=fill:enable='eq(n\\,20)+between(n\\,44\\,46)+eq(n\\,90)+eq(n\\,119)'`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", brokenMp4,
  ]);
  assert.equal(paint.status, 0, paint.stderr?.toString());

  const expected = [
    [20, 1],
    [44, 3],
    [90, 1],
    [119, 1],
  ];
  for (const chunkFrames of [undefined, 45, 23, 7]) {
    const scan = scanRenderedMp4ForBlankFrames(brokenMp4, sequence, { chunkFrames });
    assert.equal(scan.total_frames, 120, `chunk ${chunkFrames}: frame count`);
    assert.deepEqual(
      scan.events.map((e) => [e.start_frame, e.frame_count]),
      expected,
      `chunk ${chunkFrames}: ${JSON.stringify(scan.events)}`
    );
  }
});

test("2. Media-length work has no wall-clock timeout and overlay failures have no stand-in", () => {
  const src = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), "src", rel), "utf8");
  // A facade file and the files split out next to it (same directory, given prefix) read as one source.
  const area = (dir: string, facade: string, prefix: string) =>
    [facade, ...fs.readdirSync(path.resolve(process.cwd(), "src", dir)).filter((f) => f.startsWith(prefix) && f.endsWith(".ts")).sort()]
      .map((f) => src(`${dir}/${f}`))
      .join("\n");

  const bridge = area("compositor", "hyperframes_bridge.ts", "hf_");
  assert.ok(!/drawbox/.test(bridge), "hyperframes_bridge.ts must not synthesize drawbox stand-ins");
  const renderCall = bridge.slice(bridge.indexOf("const hfProc = spawnWatchedSync("), bridge.indexOf("if (hfProc.status === 0"));
  assert.ok(renderCall.length > 0 && !/timeout\s*:/.test(renderCall), "HyperFrames render must not have a timeout");

  const renderer = area("render", "renderer.ts", "render_");
  for (const marker of ["const proc = spawnWatchedSync(\"ffmpeg\", ffArgs, {"]) {
    let from = 0;
    let idx: number;
    let seen = 0;
    while ((idx = renderer.indexOf(marker, from)) !== -1) {
      const call = renderer.slice(idx, renderer.indexOf("});", idx));
      assert.ok(!/timeout\s*:/.test(call), `render ffmpeg call at ${idx} must not have a timeout`);
      from = idx + marker.length;
      seen += 1;
    }
    assert.ok(seen >= 2, "both master and proxy render calls were checked");
  }

  // Killing a stalled process tree is fixed-cost work and may carry a short limit; watched jobs may not.
  const watchdogFull = src("core/subprocess.ts");
  const killStart = watchdogFull.indexOf("function killProcessTree");
  const killEnd = watchdogFull.indexOf("\nfunction ", killStart + 1);
  assert.ok(killStart !== -1 && killEnd !== -1, "killProcessTree located");
  const watchdog = watchdogFull.slice(0, killStart) + watchdogFull.slice(killEnd);
  assert.ok(!/\btimeout\s*:\s*\d/.test(watchdog), "the stall watchdog must not impose a wall-clock limit");

  for (const rel of ["mix/audio_mix.ts", "library/subject.ts"]) {
    const text = src(rel);
    assert.ok(!/timeout\s*:\s*\d/.test(text), `${rel} must not cap whole-media ffmpeg passes with a timeout`);
  }
});
