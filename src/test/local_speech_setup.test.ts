/**
 * Keyless local speech tests (`src/test/local_speech_setup.test.ts`).
 *
 * The Python side is faked: `CUTHOL_LOCAL_SPEECH_PYTHON` points at the node
 * binary and `CUTHOL_LOCAL_BRIDGE` at a small JS stub that mimics the bridge
 * JSON contract, so these tests run without the venv. One opt-in test drives
 * the real venv when `CUTHOL_TEST_LOCAL_ROOT` points at it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkLocalSpeech } from "../core/doctor.js";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import {
  describeLocalSpeechSetup,
  planLocalSpeechSetup,
} from "../core/local_speech_setup.js";
import {
  LOCAL_SPEECH_DEFAULT_MODEL,
  LOCAL_SPEECH_DEFAULT_VOICE,
  localSpeechStatus,
  runLocalAsrBridge,
  runLocalTtsBridge,
} from "../speech/local_engine.js";
import { transcribeWithLocalProvider } from "../speech/providers.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key] as string;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
  }
}

function makeFakeRoot(): { root: string; bridge: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-local-speech-"));
  // localSpeechRoot() appends "local-speech" to CUTHOL_DATA_DIR.
  const root = path.join(tmp, "data");
  const inst = path.join(root, "local-speech");
  fs.mkdirSync(inst, { recursive: true });
  const bridge = path.join(root, "fake_bridge.mjs");
  fs.writeFileSync(
    bridge,
    `import fs from "node:fs";
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
`,
    "utf8"
  );
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
  return { root, bridge, tmp };
}

function removeFakeRoot(fake: { root: string; tmp: string }): void {
  clearLocalSpeechEnv();
  fs.rmSync(fake.tmp, { recursive: true, force: true });
}

function useFakeRoot(): { root: string; bridge: string; tmp: string } {
  const fake = makeFakeRoot();
  process.env.CUTHOL_DATA_DIR = fake.root;
  process.env.CUTHOL_LOCAL_SPEECH_PYTHON = process.execPath;
  process.env.CUTHOL_LOCAL_BRIDGE = fake.bridge;
  return fake;
}

function clearLocalSpeechEnv(): void {
  delete process.env.CUTHOL_DATA_DIR;
  delete process.env.CUTHOL_LOCAL_SPEECH_PYTHON;
  delete process.env.CUTHOL_LOCAL_BRIDGE;
  delete process.env.CUTHOL_LOCAL_SPEECH_MODEL;
  delete process.env.CUTHOL_LOCAL_SPEECH_VOICE;
  delete process.env.CUTHOL_LOCAL_ASR_CMD;
  delete process.env.CUTHOL_LOCAL_TTS_CMD;
}

test("setup dry run names the install target, model, voice and sizes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-ls-plan-"));
  withEnv({ CUTHOL_DATA_DIR: dir }, () => {
    const plan = planLocalSpeechSetup({});
    assert.equal(plan.model, LOCAL_SPEECH_DEFAULT_MODEL);
    assert.equal(plan.voice, LOCAL_SPEECH_DEFAULT_VOICE);
    assert.equal(plan.alreadyInstalled, false);
    const lines = describeLocalSpeechSetup(plan);
    const text = lines.join("\n");
    assert.ok(text.includes(plan.root));
    assert.ok(text.includes("faster-whisper==1.2.1"));
    assert.ok(text.includes("piper-tts==1.8.0"));
    assert.ok(text.includes("486 MB") || text.includes("download"));
    assert.ok(text.includes("--apply"));
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("setup rejects unknown model and voice ids (G238)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-ls-plan-"));
  withEnv({ CUTHOL_DATA_DIR: dir }, () => {
    assert.throws(() => planLocalSpeechSetup({ model: "tiny" }), /CUTHOL-G238/);
    assert.throws(() => planLocalSpeechSetup({ voice: "en_US-joe" }), /CUTHOL-G238/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("second setup run is a no-op (idempotent)", () => {
  const fake = makeFakeRoot();
  try {
    withEnv({ CUTHOL_DATA_DIR: fake.root }, () => {
      const plan = planLocalSpeechSetup({});
      assert.equal(plan.alreadyInstalled, true);
      const lines = describeLocalSpeechSetup(plan);
      assert.ok(lines.join("\n").includes("nothing to do"));
    });
  } finally {
    removeFakeRoot(fake);
  }
});

test("missing installation fails with the setup suggestion (G237)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-ls-missing-"));
  withEnv(
    {
      CUTHOL_DATA_DIR: dir,
      CUTHOL_LOCAL_SPEECH_PYTHON: undefined,
      CUTHOL_LOCAL_BRIDGE: undefined,
      CUTHOL_LOCAL_ASR_CMD: undefined,
      CUTHOL_LOCAL_TTS_CMD: undefined,
    },
    async () => {
      await assert.rejects(
        transcribeWithLocalProvider({ audioFilePath: path.join(dir, "no.wav"), durationMs: 1000 }),
        /CUTHOL-G237.*cuthol setup --local-speech --apply/
      );
      assert.equal(
        DIAGNOSTICS.LOCAL_SPEECH_NOT_INSTALLED("x").formatted.includes("cuthol setup --local-speech"),
        true
      );
    }
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fake bridge transcribes with honest model id and keyterm default", async () => {
  const fake = useFakeRoot();
  try {
    const status = localSpeechStatus();
    assert.equal(status.installed, true);
    const doc = await transcribeWithLocalProvider({
      audioFilePath: path.join(fake.root, "talk.wav"),
      language: "tr",
      durationMs: 2000,
    });
    assert.equal(doc.provider, "local");
    assert.equal(doc.model, "faster-whisper-small");
    assert.equal(doc.language, "tr");
    assert.ok(
      doc.words.some((w) => w.punctuated_word === "Cuthol"),
      "default keyterms reach the bridge"
    );
    assert.ok(doc.words.every((w) => Number.isFinite(w.source_start_ms)));
  } finally {
    removeFakeRoot(fake);
  }
});

test("fake bridge synthesizes a wav with honest voice id", async () => {
  const fake = useFakeRoot();
  try {
    const outWav = path.join(fake.root, "vo.wav");
    const res = await runLocalTtsBridge({ text: "Merhaba dostlar", outWavPath: outWav });
    assert.equal(res.voiceId, "tr_TR-dfki-medium");
    assert.equal(res.durationMs, 1000);
    assert.ok(fs.existsSync(outWav));
    const tts = await runLocalTtsBridge({ text: "x", voiceId: "tr_TR-dfki-medium", outWavPath: outWav });
    void tts;
    const { synthesizeWithLocalProvider } = await import("../speech/providers.js");
    const tmpWav = path.join(fake.root, "vo2.wav");
    const built = await synthesizeWithLocalProvider({ text: "Merhaba", tempWavPath: tmpWav });
    assert.equal(built.provider, "local");
    assert.equal(built.voice_id, "piper-tr_TR-dfki-medium");
    assert.equal(built.is_placeholder_audio, false);
  } finally {
    removeFakeRoot(fake);
  }
});

test("doctor reports installed / not installed / broken local speech", () => {
  assert.equal(checkLocalSpeech({ localSpeech: "installed", localSpeechDetail: "ok" }).status, "ok");
  const missing = checkLocalSpeech({ localSpeech: "not-installed" });
  assert.equal(missing.status, "warn");
  assert.ok(missing.fix.includes("cuthol setup --local-speech"));
  const broken = checkLocalSpeech({ localSpeech: "broken", localSpeechDetail: "gone" });
  assert.equal(broken.status, "fail");
  assert.ok(broken.fix.includes("CUTHOL-G239"));
});

test("real venv bridge transcribes Turkish speech (opt-in)", { timeout: 300_000 }, async () => {
  const venvRoot = (process.env.CUTHOL_TEST_LOCAL_ROOT ?? "").trim();
  if (!venvRoot) return;
  const py =
    process.platform === "win32"
      ? path.join(venvRoot, ".venv", "Scripts", "python.exe")
      : path.join(venvRoot, ".venv", "bin", "python");
  const script = path.resolve(process.cwd(), "scripts", "local_speech.py");
  const talk = path.join(TEST_ROOT, "fixtures", "trial-media", "talk.mp4");
  for (const f of [py, script, talk]) {
    if (!fs.existsSync(f)) return;
  }
  const env = { ...process.env, PYTHONUTF8: "1" };
  const proc = spawnSync(
    py,
    [script, "asr", talk, "--lang", "tr", "--model", path.join(venvRoot, "models", "small")],
    { windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env }
  );
  assert.equal(proc.status, 0, (proc.stderr ?? "").slice(-500));
  const parsed = JSON.parse(proc.stdout) as { language: string; words: Array<{ word: string }> };
  assert.equal(parsed.language, "tr");
  assert.ok(parsed.words.length > 10);
});
