// Extension speech/media providers: manifest `providers` runtime (resolve, sandbox, env isolation).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { loadDotEnvIfNeeded } from "../core/env.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import {
  ExtensionProviderKind,
  ExtensionProviderSpec,
  ExtensionScope,
  ResolvedExtension,
  assertScriptRespectsNetworkPolicy,
  assertStayInsideDir,
} from "./ext_manifest.js";
import {
  hashExtensionDirectory,
  listFilesRecursiveRelative,
  resolveExtension,
} from "./ext_registry.js";

export interface ResolvedProvider {
  extension: ResolvedExtension;
  kind: ExtensionProviderKind;
  spec: ExtensionProviderSpec;
  scriptAbsPath: string;
}

/**
 * Resolves the `providers.<kind>` section of an extension (project-local wins over
 * persistent, like processors). Provider scripts run on demand; the extension does not
 * need to be enabled in the project.
 */
export function resolveExtensionProvider(options: {
  extensionName: string;
  kind: ExtensionProviderKind;
  workspaceDir?: string | null;
  scope?: ExtensionScope;
}): ResolvedProvider {
  const ext = resolveExtension(options.extensionName, options.workspaceDir, options.scope);
  const section = ext.manifest.providers ?? {};
  const spec = section[options.kind];
  if (!spec) {
    const available = (["asr", "tts", "media"] as const)
      .filter((k) => section[k] !== undefined)
      .join(", ");
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_CAPABILITY_MISSING(ext.name, options.kind, available)
    );
  }
  const scriptAbsPath = assertStayInsideDir(ext.dir, spec.script, ext.name);
  if (!fs.existsSync(scriptAbsPath)) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        ext.name,
        `'providers.${options.kind}.script' file ('${spec.script}') was not found.`
      )
    );
  }
  assertScriptRespectsNetworkPolicy(scriptAbsPath, ext);
  return { extension: ext, kind: options.kind, spec, scriptAbsPath };
}

/** Cache identity of a resolved provider (never contains secret values). */
export function providerCacheTag(ext: ResolvedExtension): string {
  return `ext:${ext.name}:${ext.version}:${ext.contentHash}`;
}

/**
 * Reads the declared secret values from the process environment or the project `.env`.
 * Only names listed in the manifest are read; missing names fail with CUTHOL-G232.
 */
export function collectProviderEnv(options: {
  workspaceDir: string;
  extensionName: string;
  kind: ExtensionProviderKind;
  declared: string[] | undefined;
}): Record<string, string> {
  const names = options.declared ?? [];
  if (names.length === 0) return {};
  loadDotEnvIfNeeded(path.resolve(options.workspaceDir));
  loadDotEnvIfNeeded(process.cwd());
  const missing = names.filter((v) => {
    const val = process.env[v];
    return val === undefined || val.trim() === "";
  });
  if (missing.length > 0) {
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_ENV_MISSING(options.extensionName, options.kind, missing)
    );
  }
  const out: Record<string, string> = {};
  for (const v of names) {
    out[v] = process.env[v] as string;
  }
  return out;
}

// Non-secret OS variables a provider child still needs (locate binaries, temp files).
// Everything else from the parent environment is withheld, so undeclared secrets
// (DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, other providers' keys) never reach the script.
const SAFE_ENV_PASSTHROUGH = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "OS",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
];

function lookupEnvCaseAware(name: string): string | undefined {
  if (process.env[name] !== undefined) return process.env[name];
  if (process.platform !== "win32") return undefined;
  const upper = name.toUpperCase();
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() === upper) return v;
  }
  return undefined;
}

export function buildProviderChildEnv(
  collectedSecrets: Record<string, string>,
  context: {
    extensionName: string;
    version: string;
    kind: ExtensionProviderKind;
    operation?: string;
    tmpDir: string;
  }
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of SAFE_ENV_PASSTHROUGH) {
    const val = lookupEnvCaseAware(name);
    if (val !== undefined) env[name] = val;
  }
  for (const [k, v] of Object.entries(collectedSecrets)) {
    env[k] = v;
  }
  env.CUTHOL_PROVIDER_NAME = context.extensionName;
  env.CUTHOL_PROVIDER_VERSION = context.version;
  env.CUTHOL_PROVIDER_KIND = context.kind;
  if (context.operation) env.CUTHOL_PROVIDER_OPERATION = context.operation;
  env.CUTHOL_PROVIDER_TMP = context.tmpDir;
  return env;
}

/** Redacts collected secret values (length >= 4) from text placed in errors or logs. */
export function redactSecrets(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const v of Object.values(secrets)) {
    if (typeof v === "string" && v.length >= 4) {
      out = out.split(v).join("***");
    }
  }
  return out;
}

export interface ProviderScriptResult {
  response: unknown;
  audioOutputPath: string | null;
  elapsedMs: number;
}

/**
 * Runs a provider script in an isolated child process:
 * `node <script> <requestJsonPath> <responseJsonPath>`.
 * No wall-clock limit; the progress watchdog kills stalled trees. The script may write
 * only the response file, the audio output file (TTS/fetch), and the `tmp/` scratch dir.
 */
export function runExtensionProviderScript(options: {
  provider: ResolvedProvider;
  workspaceDir: string;
  operation?: string;
  request: Record<string, unknown>;
  needsAudioOutput?: boolean;
  audioOutputExt?: string;
  /**
   * Durable destination for the audio output. Required when `needsAudioOutput` is
   * set: the sandbox (including the script's audio file) is removed when the run ends,
   * so the audio is copied here before cleanup and returned as `audioOutputPath`.
   */
  persistAudioTo?: string;
  secrets: Record<string, string>;
}): ProviderScriptResult {
  const startedAt = Date.now();
  const { provider } = options;
  const ext = provider.extension;

  const extFilesBefore = new Map(
    listFilesRecursiveRelative(ext.dir).map((f) => [
      f.path,
      crypto.createHash("sha256").update(fs.readFileSync(path.join(ext.dir, f.path))).digest("hex"),
    ])
  );
  const extHashBefore = hashExtensionDirectory(ext.dir);

  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), `cuthol-provider-${ext.name}-`));
  const requestPath = path.join(sandboxDir, "request.json");
  const responsePath = path.join(sandboxDir, "response.json");
  const tmpDir = path.join(sandboxDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const audioOutputPath = options.needsAudioOutput
    ? path.join(sandboxDir, `output${options.audioOutputExt ?? ".wav"}`)
    : null;

  const fullRequest = {
    ...options.request,
    extension_dir: ext.dir,
    ...(audioOutputPath ? { output_audio_path: audioOutputPath } : {}),
  };
  fs.writeFileSync(requestPath, JSON.stringify(fullRequest), "utf8");

  const childEnv = buildProviderChildEnv(options.secrets, {
    extensionName: ext.name,
    version: ext.version,
    kind: provider.kind,
    operation: options.operation,
    tmpDir,
  });

  const watchedPaths = options.needsAudioOutput && audioOutputPath
    ? [responsePath, audioOutputPath]
    : [responsePath];

  try {
    const proc = spawnWatchedSync(
      process.execPath,
      [provider.scriptAbsPath, requestPath, responsePath],
      {
        cwd: sandboxDir,
        env: childEnv,
        encoding: "utf8",
        step: `provider ${ext.name} ${provider.kind}${options.operation ? ` ${options.operation}` : ""}`,
        watchedPaths,
        cleanupPathsOnStall: [sandboxDir],
        maxBuffer: 8 * 1024 * 1024,
      }
    );

    const extHashAfter = hashExtensionDirectory(ext.dir);
    if (extHashAfter !== extHashBefore) {
      for (const f of listFilesRecursiveRelative(ext.dir)) {
        if (!extFilesBefore.has(f.path)) {
          try {
            fs.unlinkSync(path.join(ext.dir, f.path));
          } catch {
            // ignore
          }
        }
      }
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
          ext.name,
          `The provider script attempted to write inside the extension folder.`
        )
      );
    }

    const sandboxEntries = fs.existsSync(sandboxDir) ? fs.readdirSync(sandboxDir) : [];
    const allowedEntries = new Set([
      "request.json",
      "response.json",
      "tmp",
      ...(audioOutputPath ? [path.basename(audioOutputPath)] : []),
    ]);
    const extraEntries = sandboxEntries.filter((entry) => !allowedEntries.has(entry));
    if (extraEntries.length > 0) {
      throw new CutholError(
        DIAGNOSTICS.EXTENSION_SECURITY_VIOLATION(
          ext.name,
          `The provider script wrote outside the given output path ('${extraEntries.join(",")}').`
        )
      );
    }

    if (proc.stalled) {
      const detail =
        `The script stalled (${proc.stalledMs ?? proc.stallThresholdMs ?? 0}ms without progress; ` +
        `last progress: ${proc.lastProgress ?? "none"}). ` +
        `Adjust 'CUTHOL_STALL_TIMEOUT_SEC' if the provider legitimately needs longer pauses.`;
      throw new CutholError(DIAGNOSTICS.PROVIDER_EXECUTION_FAILED(ext.name, provider.kind, detail));
    }

    if (proc.error || proc.status !== 0) {
      const rawTail = String(proc.stderr || proc.stdout || proc.error?.message || "unknown error")
        .trim()
        .slice(-300);
      const detail = redactSecrets(
        `exit code ${proc.status ?? "null"}: ${rawTail || "no output"}`,
        options.secrets
      );
      throw new CutholError(DIAGNOSTICS.PROVIDER_EXECUTION_FAILED(ext.name, provider.kind, detail));
    }

    if (!fs.existsSync(responsePath)) {
      throw new CutholError(
        DIAGNOSTICS.PROVIDER_EXECUTION_FAILED(
          ext.name,
          provider.kind,
          `The script did not produce the expected response file.`
        )
      );
    }

    let response: unknown;
    try {
      response = JSON.parse(fs.readFileSync(responsePath, "utf8"));
    } catch (err) {
      throw new CutholError(
        DIAGNOSTICS.PROVIDER_BAD_OUTPUT(
          ext.name,
          provider.kind,
          `response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }

    if (audioOutputPath) {
      if (!options.persistAudioTo) {
        throw new CutholError(
          DIAGNOSTICS.PROVIDER_EXECUTION_FAILED(
            ext.name,
            provider.kind,
            `The provider run was misconfigured (no durable audio destination).`
          )
        );
      }
      if (fs.existsSync(audioOutputPath)) {
        fs.mkdirSync(path.dirname(options.persistAudioTo), { recursive: true });
        fs.copyFileSync(audioOutputPath, options.persistAudioTo);
        return { response, audioOutputPath: options.persistAudioTo, elapsedMs: Date.now() - startedAt };
      }
      // No audio file: the caller decides (media fetch maps `found: false` to
      // CUTHOL-G236; TTS treats it as an execution failure).
      return { response, audioOutputPath: null, elapsedMs: Date.now() - startedAt };
    }

    return { response, audioOutputPath, elapsedMs: Date.now() - startedAt };
  } finally {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  }
}

export interface ValidatedProviderWord {
  word: string;
  punctuated_word: string;
  source_start_ms: number;
  source_end_ms: number;
  confidence: number;
}

/**
 * Validates one `{word, start_ms, end_ms, confidence?}` list of the provider contract
 * (shared by ASR transcripts and word-level TTS alignment).
 */
export function assertProviderWordList(
  extName: string,
  kind: string,
  value: unknown,
  field: string
): ValidatedProviderWord[] {
  if (!Array.isArray(value)) {
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_BAD_OUTPUT(extName, kind, `expected '${field}' to be an array.`)
    );
  }
  return value.map((entry, i) => {
    const label = `'${field}[${i}]'`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new CutholError(
        DIAGNOSTICS.PROVIDER_BAD_OUTPUT(extName, kind, `expected ${label} to be an object.`)
      );
    }
    const obj = entry as Record<string, unknown>;
    const fail = (why: string): never => {
      throw new CutholError(DIAGNOSTICS.PROVIDER_BAD_OUTPUT(extName, kind, `${label} ${why}.`));
    };
    if (typeof obj.word !== "string" || !obj.word.trim()) fail("needs a non-empty 'word' string");
    const start = Number(obj.start_ms);
    const end = Number(obj.end_ms);
    if (!Number.isFinite(start) || start < 0) fail("needs 'start_ms' >= 0");
    if (!Number.isFinite(end) || end < start) fail("needs 'end_ms' >= 'start_ms'");
    const confidenceRaw = obj.confidence;
    const confidence =
      confidenceRaw === undefined ? 0.99 : Number(confidenceRaw);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      fail("needs 'confidence' in [0, 1] when present");
    }
    return {
      word: (obj.word as string).trim(),
      punctuated_word:
        typeof obj.punctuated_word === "string" && obj.punctuated_word.trim()
          ? (obj.punctuated_word as string).trim()
          : (obj.word as string).trim(),
      source_start_ms: Math.round(start),
      source_end_ms: Math.round(end),
      confidence,
    };
  });
}
