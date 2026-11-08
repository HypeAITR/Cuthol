/**
 * Test Environment Isolation Setup (`src/test/test_setup.ts`).
 *
 * Preloaded via `--import ./dist/test/test_setup.js` during `npm test` so that neither
 * the test runner processes nor any spawned `dist/cli.js` / MCP child processes read from
 * or write to the user's shared cache (`~/.cuthol/cache`), unless a test explicitly points
 * `process.env.CUTHOL_CACHE_DIR` at its own isolated test directory.
 */

if (
  process.env.CUTHOL_CACHE_DIR === undefined &&
  process.env.CUTHOL_DISABLE_SHARED_CACHE === undefined
) {
  process.env.CUTHOL_CACHE_DIR = "0";
}

if (
  process.env.CUTHOL_EXTENSIONS_DIR === undefined &&
  process.env.CUTHOL_DISABLE_SHARED_CACHE === undefined
) {
  process.env.CUTHOL_EXTENSIONS_DIR = "0";
}

// User settings (`~/.cuthol/settings.json`) are never read or written by tests unless a test
// points `CUTHOL_SETTINGS_FILE` at its own temp file.
if (process.env.CUTHOL_SETTINGS_FILE === undefined) {
  process.env.CUTHOL_SETTINGS_FILE = "0";
}

// Skill auto-install is off in tests (and in CLI children they spawn, via env
// inheritance) so no test ever writes to the real home folder. Tests that cover
// the hook set `CUTHOL_SKILLS_AUTO=1` explicitly with a temporary home.
if (process.env.CUTHOL_SKILLS_AUTO === undefined) {
  process.env.CUTHOL_SKILLS_AUTO = "0";
}
