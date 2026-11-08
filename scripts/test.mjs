// Full test suite in two stages: files that are safe to overlap run in parallel, then the files that
// measure wall time, share hardware encoder sessions or call paid APIs run one at a time.
// Usage: npm test  (CUTHOL_TEST_CONCURRENCY=N to change the parallel stage, default 4; 1 = old serial run)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SERIAL = new Set([
  "stall_watchdog.test.js", // stall thresholds of a few seconds
  "color_alpha_encoders.test.js", // hardware encoder probes and session limits
  "render_speed.test.js", // worker counts and render timings
  "render_scan_timeouts.test.js",
  "long_form.test.js",
  "speech_pauses_fillers.test.js",
  "runtime_bridge_determinism.test.js",
  "speech_cleanup_mix.test.js", // live ElevenLabs + Deepgram
  "shared_cache_layout.test.js",
  "ducking_bbox_real_speech.test.js",
  "composition_audio.test.js", // renders HyperFrames audio (browser) and measures timing
  "composition_coords.test.js", // opens a browser
  "composition_coords_ink.test.js", // opens a browser
  "coords_ink_transform.test.js", // opens a browser
  "coords_query.test.js", // opens a browser
  "script_errors.test.js", // opens a browser (probe child)
  "coords_quads.test.js", // opens a browser
]);

const testDir = path.join("dist", "test");
const all = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();
const parallel = all.filter((f) => !SERIAL.has(f)).map((f) => path.join(testDir, f));
const serial = all.filter((f) => SERIAL.has(f)).map((f) => path.join(testDir, f));
const concurrency = Math.max(1, Number(process.env.CUTHOL_TEST_CONCURRENCY) || 4);

const run = (label, files, n) => {
  if (files.length === 0) return 0;
  console.log(`\n=== ${label}: ${files.length} files, concurrency ${n} ===`);
  const started = Date.now();
  const res = spawnSync(
    process.execPath,
    ["--import", "./dist/test/test_setup.js", "--test", `--test-concurrency=${n}`, ...files],
    { stdio: "inherit" }
  );
  console.log(`=== ${label}: exit ${res.status}, ${Math.round((Date.now() - started) / 1000)}s ===`);
  return res.status ?? 1;
};

const a = run("parallel", parallel, concurrency);
const b = run("serial", serial, 1);
process.exit(a || b ? 1 : 0);
