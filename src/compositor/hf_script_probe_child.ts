// Sync composition script-probe child (`node dist/compositor/hf_script_probe_child.js`).
//
// Monitor and preview stay synchronous (their dispatch is sync), so the browser probe
// runs in one child node process. Args: `<projectDir> <jobsJson>`; each job probes one
// composition with the shared browser and writes its content-keyed record. Any failure
// (no browser, page hang) leaves records unknown; the parent re-reads whatever the
// child managed to write. Always exits 0: a probe failure must never fail the caller.
//
// NOTE: this must stay a real file, never `--eval`: the stall-watchdog worker thread
// never signals back under a `--eval` entry, so any `spawnWatchedSync` in an eval child
// (e.g. Chrome resolution) hangs until the watchdog kills it.
import {
  launchScriptProbeBrowser,
  probeCompositionScriptErrors,
  writeCurrentScriptErrorRecord,
} from "./coords_extract.js";
import { ScriptProbeJob } from "./hf_script_errors.js";

async function main(): Promise<void> {
  const projectDir = process.argv[2] ?? "";
  const jobsJson = process.argv[3] ?? "[]";
  if (!projectDir) return;
  let jobs: ScriptProbeJob[];
  try {
    jobs = JSON.parse(jobsJson) as ScriptProbeJob[];
  } catch {
    return;
  }
  if (!Array.isArray(jobs) || jobs.length === 0) return;
  let browser = null;
  try {
    browser = await launchScriptProbeBrowser();
    for (const job of jobs) {
      try {
        const probe = await probeCompositionScriptErrors({
          compDir: job.absCompDir,
          entryHtml: job.entryHtml,
          width: job.width,
          height: job.height,
          fps: job.fps,
          durationSec: job.durationSec,
          browser,
        });
        writeCurrentScriptErrorRecord(projectDir, {
          absCompDir: job.absCompDir,
          entryHtml: job.entryHtml,
          source: "probe",
          timelineExpected: probe.timelineExpected,
          timelineRegistered: probe.timelineRegistered,
          errors: probe.errors,
        });
      } catch {
        // per-cue failure stays unknown
      }
    }
  } catch {
    // browser launch failure: all stay unknown
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      // ignore
    }
  }
}

try {
  await main();
} catch {
  // never fail the caller
}
process.exit(0);
