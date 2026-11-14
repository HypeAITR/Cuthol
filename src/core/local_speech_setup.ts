// `cuthol setup --local-speech`: private keyless speech installation.
//
// Creates a private venv under the user's Cuthol data folder (never the
// project, never global site-packages), installs pinned `faster-whisper` and
// `piper-tts`, downloads the Whisper model and the Piper voice, and writes
// `local-speech.json`. Idempotent: a second run is a no-op.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "./diagnostics.js";
import {
  LOCAL_SPEECH_CONFIG_FILE,
  LOCAL_SPEECH_DEFAULT_MODEL,
  LOCAL_SPEECH_DEFAULT_VOICE,
  LOCAL_SPEECH_MODELS,
  LOCAL_SPEECH_PINNED_PACKAGES,
  LOCAL_SPEECH_VOICES,
  LocalSpeechConfig,
  localSpeechRoot,
  type LocalSpeechModelName,
} from "../speech/local_engine.js";

export interface LocalSpeechSetupOptions {
  model?: string;
  voice?: string;
  apply?: boolean;
}

export interface LocalSpeechSetupPlan {
  model: string;
  voice: string;
  root: string;
  venvDir: string;
  modelRepo: string;
  modelDir: string;
  voiceFile: string;
  downloadBytes: number;
  alreadyInstalled: boolean;
}

function fail(step: string, detail: string): never {
  throw new CutholError(DIAGNOSTICS.LOCAL_SPEECH_SETUP_FAILED(step, detail));
}

export function resolveLocalSpeechModel(raw: string | undefined): LocalSpeechModelName {
  const name = (raw ?? "").trim() || LOCAL_SPEECH_DEFAULT_MODEL;
  if (!(name in LOCAL_SPEECH_MODELS)) {
    fail("validate", `Unknown model '${name}'. Use one of: ${Object.keys(LOCAL_SPEECH_MODELS).join(", ")}.`);
  }
  return name as LocalSpeechModelName;
}

export function resolveLocalSpeechVoice(raw: string | undefined): string {
  const voice = (raw ?? "").trim() || LOCAL_SPEECH_DEFAULT_VOICE;
  if (!(voice in LOCAL_SPEECH_VOICES)) {
    fail("validate", `Unknown voice '${voice}'. Use one of: ${Object.keys(LOCAL_SPEECH_VOICES).join(", ")}.`);
  }
  return voice;
}

function isInstalled(plan: LocalSpeechSetupPlan): boolean {
  const configPath = path.join(plan.root, LOCAL_SPEECH_CONFIG_FILE);
  let config: LocalSpeechConfig | null = null;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8")) as LocalSpeechConfig;
  } catch {
    return false;
  }
  if (config.model !== plan.model || config.voice !== plan.voice) return false;
  const py = venvPython(plan);
  return (
    fs.existsSync(py) &&
    fs.existsSync(path.join(plan.modelDir, "model.bin")) &&
    fs.existsSync(plan.voiceFile)
  );
}

function venvPython(plan: LocalSpeechSetupPlan): string {
  return process.platform === "win32"
    ? path.join(plan.venvDir, "Scripts", "python.exe")
    : path.join(plan.venvDir, "bin", "python");
}

export function planLocalSpeechSetup(options: LocalSpeechSetupOptions = {}): LocalSpeechSetupPlan {
  const model = resolveLocalSpeechModel(options.model);
  const voice = resolveLocalSpeechVoice(options.voice);
  const root = localSpeechRoot();
  const plan: LocalSpeechSetupPlan = {
    model,
    voice,
    root,
    venvDir: path.join(root, "venv"),
    modelRepo: LOCAL_SPEECH_MODELS[model].repo,
    modelDir: path.join(root, "models", model),
    voiceFile: path.join(root, "voices", `${voice}.onnx`),
    downloadBytes:
      LOCAL_SPEECH_MODELS[model].downloadBytes +
      LOCAL_SPEECH_VOICES[voice as keyof typeof LOCAL_SPEECH_VOICES].downloadBytes,
    alreadyInstalled: false,
  };
  plan.alreadyInstalled = isInstalled(plan);
  return plan;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

/** Human-readable dry-run: exactly what `--apply` would install, with sizes. */
export function describeLocalSpeechSetup(plan: LocalSpeechSetupPlan): string[] {
  if (plan.alreadyInstalled) {
    return [
      `local speech already installed in '${plan.root}' (model ${plan.model}, voice ${plan.voice}); nothing to do.`,
    ];
  }
  const voiceMeta = LOCAL_SPEECH_VOICES[plan.voice as keyof typeof LOCAL_SPEECH_VOICES];
  return [
    `local speech would install into '${plan.root}':`,
    `- private venv at '${plan.venvDir}' (uv when present, else python -m venv; reference size ~310 MB with packages)`,
    `- pip packages: faster-whisper==${LOCAL_SPEECH_PINNED_PACKAGES.fasterWhisper}, piper-tts==${LOCAL_SPEECH_PINNED_PACKAGES.piperTts}`,
    `- Whisper model '${plan.model}' (${plan.modelRepo}) into '${plan.modelDir}' (${formatBytes(LOCAL_SPEECH_MODELS[plan.model as LocalSpeechModelName].downloadBytes)} download)`,
    `- Piper voice '${plan.voice}' into '${plan.voiceFile}' (${formatBytes(voiceMeta.downloadBytes)} download)`,
    `- config '${path.join(plan.root, LOCAL_SPEECH_CONFIG_FILE)}'`,
    `model + voice download total: ${formatBytes(plan.downloadBytes)} (plus ~310 MB venv with packages)`,
    `re-run with '--apply' to install.`,
  ];
}

function runLogged(file: string, args: string[], step: string): void {
  const proc = spawnSync(file, args, { windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (proc.status !== 0) {
    fail(step, `${file} ${args.join(" ")} exited with ${proc.status}: ${(proc.stderr || proc.stdout || "").slice(-500)}`);
  }
}

function commandExists(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const proc = spawnSync(probe, [cmd], { windowsHide: true, encoding: "utf8" });
  return proc.status === 0;
}

function findSystemPython(): string {
  for (const cand of process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"]) {
    if (cand === "py") {
      const proc = spawnSync("py", ["-3", "--version"], { windowsHide: true, encoding: "utf8" });
      if (proc.status === 0) return "py -3";
    } else if (commandExists(cand)) {
      return cand;
    }
  }
  fail("venv", "No system Python found (tried py/python/python3). Install Python 3.10+ and re-run.");
}

async function downloadVoiceFile(plan: LocalSpeechSetupPlan): Promise<void> {
  const voiceMeta = LOCAL_SPEECH_VOICES[plan.voice as keyof typeof LOCAL_SPEECH_VOICES];
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${voiceMeta.hfPath}`;
  for (const suffix of [".onnx", ".onnx.json"]) {
    const url = `${base}${suffix}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      fail("voice-download", `${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res!.ok) fail("voice-download", `${url}: HTTP ${res!.status}.`);
    const buf = Buffer.from(await res!.arrayBuffer());
    fs.mkdirSync(path.dirname(plan.voiceFile), { recursive: true });
    fs.writeFileSync(`${plan.voiceFile}${suffix === ".onnx" ? "" : ".json"}`, buf);
  }
}

function downloadModel(plan: LocalSpeechSetupPlan): void {
  const py = venvPython(plan);
  const script =
    "from huggingface_hub import snapshot_download;" +
    `snapshot_download(repo_id=${JSON.stringify(plan.modelRepo)}, local_dir=${JSON.stringify(plan.modelDir)});` +
    "print('model-ok')";
  const proc = spawnSync(py, ["-c", script], {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
  });
  if (proc.status !== 0 || !/model-ok/.test(proc.stdout ?? "")) {
    fail("model-download", (proc.stderr || proc.stdout || "snapshot_download failed").slice(-500));
  }
}

export async function applyLocalSpeechSetup(
  options: LocalSpeechSetupOptions = {},
  startedAt = Date.now()
): Promise<{ plan: LocalSpeechSetupPlan; noop: boolean; seconds: number }> {
  const plan = planLocalSpeechSetup(options);
  if (plan.alreadyInstalled) return { plan, noop: true, seconds: 0 };

  fs.mkdirSync(plan.root, { recursive: true });
  const py = venvPython(plan);

  if (!fs.existsSync(py)) {
    if (commandExists("uv")) {
      runLogged("uv", ["venv", plan.venvDir], "venv");
    } else {
      const sysPy = findSystemPython();
      if (sysPy === "py -3") runLogged("py", ["-3", "-m", "venv", plan.venvDir], "venv");
      else runLogged(sysPy, ["-m", "venv", plan.venvDir], "venv");
    }
  }

  // Pinned packages; piper install drops its binary next to the venv python.
  if (commandExists("uv")) {
    runLogged("uv", [
      "pip",
      "install",
      "--python",
      py,
      `faster-whisper==${LOCAL_SPEECH_PINNED_PACKAGES.fasterWhisper}`,
      `piper-tts==${LOCAL_SPEECH_PINNED_PACKAGES.piperTts}`,
    ], "pip-install");
  } else {
    runLogged(py, [
      "-m",
      "pip",
      "install",
      `faster-whisper==${LOCAL_SPEECH_PINNED_PACKAGES.fasterWhisper}`,
      `piper-tts==${LOCAL_SPEECH_PINNED_PACKAGES.piperTts}`,
    ], "pip-install");
  }

  if (!fs.existsSync(path.join(plan.modelDir, "model.bin"))) {
    downloadModel(plan);
  }
  if (!fs.existsSync(plan.voiceFile)) {
    await downloadVoiceFile(plan);
  }

  const config: LocalSpeechConfig = {
    model: plan.model,
    voice: plan.voice,
    fasterWhisper: LOCAL_SPEECH_PINNED_PACKAGES.fasterWhisper,
    piperTts: LOCAL_SPEECH_PINNED_PACKAGES.piperTts,
    installedAt: new Date().toISOString(),
  };
  const tmp = `${path.join(plan.root, LOCAL_SPEECH_CONFIG_FILE)}.tmp_${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tmp, path.join(plan.root, LOCAL_SPEECH_CONFIG_FILE));

  return { plan, noop: false, seconds: Math.round((Date.now() - startedAt) / 1000) };
}
