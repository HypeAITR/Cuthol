/**
 * Optional test inputs that do not ship with the repository.
 *
 * Most tests build their own media with ffmpeg. A few also run against larger recorded projects
 * or real media when they are present, and skip that part when they are not:
 *
 * - `CUTHOL_TEST_FIXTURES` (default `test-workspace/fixtures`): recorded Cuthol projects
 *   (`t1`, `t1_K`, `beat_K`, `gaps`, `gaps_J`, `gfx_O`).
 * - `CUTHOL_TRIAL_MEDIA` (default `<fixtures>/trial-media`): real footage and music
 *   (`talk.mp4`, `broll_*.mp4`, `music.mp3`).
 * - Paid speech services run only when `DEEPGRAM_API_KEY` / `ELEVENLABS_API_KEY` are set
 *   (environment or `.env`).
 */
import fs from "node:fs";
import path from "node:path";
import { loadDotEnvIfNeeded } from "../core/env.js";

export const FIXTURES_DIR = path.resolve(process.env.CUTHOL_TEST_FIXTURES || path.join("test-workspace", "fixtures"));
export const TRIAL_MEDIA_DIR = path.resolve(process.env.CUTHOL_TRIAL_MEDIA || path.join(FIXTURES_DIR, "trial-media"));

export function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

/** Skip reason when a recorded fixture project is missing, otherwise `false`. */
export function missingFixture(...names: string[]): string | false {
  const missing = names.filter((n) => !fs.existsSync(fixturePath(n)));
  return missing.length ? `fixture not present: ${missing.join(", ")} (set CUTHOL_TEST_FIXTURES)` : false;
}

/** Skip reason when a paid-service key is missing, otherwise `false`. */
export function missingKeys(...keys: string[]): string | false {
  loadDotEnvIfNeeded();
  const missing = keys.filter((k) => !process.env[k]?.trim());
  return missing.length ? `needs ${missing.join(", ")}` : false;
}
