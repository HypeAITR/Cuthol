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
import os from "node:os";
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

const FAKE_BRIDGE_JS = `import fs from "node:fs";
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args[0] === "asr") {
  const lang = (flag("--lang") || "auto").toLowerCase();
  const modelDir = flag("--model") || "";
  const keyterms = (flag("--keyterms") || "").split(",").filter(Boolean);
  const words = [
    { word: "merhaba", punctuated_word: "Merhaba", source_start_ms: 100, source_end_ms: 500, confidence: 0.9 },
    { word: "dostlar", punctuated_word: "dostlar.", source_start_ms: 600, source_end_ms: 1000, confidence: 0.8 },
  ];
  if (keyterms.includes("Cuthol")) {
    words.push({ word: "Cuthol", punctuated_word: "Cuthol", source_start_ms: 1100, source_end_ms: 1500, confidence: 0.7 });
  }
  process.stdout.write(JSON.stringify({ language: lang === "auto" ? "tr" : lang, model: modelDir, words }));
} else if (args[0] === "tts") {
  const out = flag("--out");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + 16000, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(16000, 40);
  fs.writeFileSync(out, Buffer.concat([header, Buffer.alloc(16000)]));
  process.stdout.write(JSON.stringify({ duration_ms: 1000, words: [] }));
} else {
  process.stderr.write("unknown subcommand");
  process.exit(1);
}
`;

/**
 * Installs a fake keyless local-speech setup (node-driven bridge stub, empty
 * model/voice files) under a temp dir and points the engine at it. Returns a
 * restore function that clears the env vars and removes the temp dir. The
 * Python side is stubbed, so this runs without the venv.
 */
export function fakeLocalSpeechInstall(): { root: string; restore: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fake-local-speech-"));
  const root = path.join(tmp, "data");
  const inst = path.join(root, "local-speech");
  const bridge = path.join(tmp, "fake_bridge.mjs");
  fs.writeFileSync(bridge, FAKE_BRIDGE_JS, "utf8");
  const venvPy =
    process.platform === "win32"
      ? path.join(inst, "venv", "Scripts", "python.exe")
      : path.join(inst, "venv", "bin", "python");
  fs.mkdirSync(path.dirname(venvPy), { recursive: true });
  fs.writeFileSync(venvPy, "");
  fs.mkdirSync(path.join(inst, "models", "small"), { recursive: true });
  fs.writeFileSync(path.join(inst, "models", "small", "model.bin"), Buffer.alloc(8));
  fs.mkdirSync(path.join(inst, "voices"), { recursive: true });
  fs.writeFileSync(path.join(inst, "voices", "tr_TR-dfki-medium.onnx"), Buffer.alloc(8));
  fs.writeFileSync(
    path.join(inst, "local-speech.json"),
    JSON.stringify({
      model: "small",
      voice: "tr_TR-dfki-medium",
      fasterWhisper: "1.2.1",
      piperTts: "1.8.0",
      installedAt: new Date().toISOString(),
    }),
    "utf8"
  );
  const saved: Record<string, string | undefined> = {};
  const set = (key: string, value: string | undefined) => {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  set("CUTHOL_DATA_DIR", root);
  set("CUTHOL_LOCAL_SPEECH_PYTHON", process.execPath);
  set("CUTHOL_LOCAL_BRIDGE", bridge);
  set("CUTHOL_LOCAL_SPEECH_MODEL", undefined);
  set("CUTHOL_LOCAL_SPEECH_VOICE", undefined);
  set("CUTHOL_LOCAL_ASR_CMD", undefined);
  set("CUTHOL_LOCAL_TTS_CMD", undefined);
  return {
    root,
    restore: () => {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key] as string;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}
