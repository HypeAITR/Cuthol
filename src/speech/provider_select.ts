// Speech provider selection: CLI flag > environment > project default > built-in default.
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { loadDotEnvIfNeeded } from "../core/env.js";
import { commitSequenceMutation, loadSequence } from "../core/workspace.js";
import { EXTENSION_NAME_RE } from "../extensions/ext_manifest.js";
import { AsrProviderId, TtsProviderId } from "./providers.js";

export const ASR_ENV_VAR = "CUTHOL_ASR_PROVIDER";
export const TTS_ENV_VAR = "CUTHOL_TTS_PROVIDER";

export type ProviderSource = "flag" | "env" | "project" | "builtin";

export const ASR_VALID_LIST = "deepgram, local, ext:<extension>";
export const TTS_VALID_LIST = "elevenlabs, local, ext:<extension>";

function parseBuiltinOrExt(
  kind: "asr" | "tts",
  raw: string,
  builtins: readonly string[],
  validList: string
): string {
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();
  for (const b of builtins) {
    if (lowered === b) return b;
  }
  if (lowered.startsWith("ext:")) {
    const name = trimmed.slice(4);
    if (EXTENSION_NAME_RE.test(name)) {
      return `ext:${name}`;
    }
  }
  throw new CutholError(DIAGNOSTICS.PROVIDER_UNKNOWN(kind, raw.trim() || raw, validList));
}

export function parseAsrProviderId(raw: string): AsrProviderId {
  return parseBuiltinOrExt("asr", raw, ["deepgram", "local"], ASR_VALID_LIST) as AsrProviderId;
}

export function parseTtsProviderId(raw: string): TtsProviderId {
  return parseBuiltinOrExt("tts", raw, ["elevenlabs", "local"], TTS_VALID_LIST) as TtsProviderId;
}

export function parseMediaProviderId(raw: string): `ext:${string}` {
  const trimmed = raw.trim();
  const name = trimmed.toLowerCase().startsWith("ext:") ? trimmed.slice(4) : "";
  if (name && EXTENSION_NAME_RE.test(name)) {
    return `ext:${name}`;
  }
  throw new CutholError(DIAGNOSTICS.PROVIDER_UNKNOWN("media", raw.trim() || raw, "ext:<extension>"));
}

export function extensionNameOf(providerId: string): string | null {
  return providerId.startsWith("ext:") ? providerId.slice(4) : null;
}

function readStoredDefault(
  workspaceDir: string,
  which: "asr" | "tts"
): string | undefined {
  const { sequence } = loadSequence(workspaceDir);
  const stored = which === "asr" ? sequence.providers?.asr : sequence.providers?.tts;
  return typeof stored === "string" && stored.trim() ? stored : undefined;
}

export function resolveAsrProvider(options: {
  workspaceDir: string;
  explicit?: string;
}): { id: AsrProviderId; source: ProviderSource } {
  loadDotEnvIfNeeded(path.resolve(options.workspaceDir));
  if (options.explicit !== undefined && options.explicit.trim() !== "") {
    return { id: parseAsrProviderId(options.explicit), source: "flag" };
  }
  const fromEnv = process.env[ASR_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { id: parseAsrProviderId(fromEnv), source: "env" };
  }
  const stored = readStoredDefault(options.workspaceDir, "asr");
  if (stored !== undefined) {
    return { id: parseAsrProviderId(stored), source: "project" };
  }
  return { id: "deepgram", source: "builtin" };
}

export function resolveTtsProvider(options: {
  workspaceDir: string;
  explicit?: string;
}): { id: TtsProviderId; source: ProviderSource } {
  loadDotEnvIfNeeded(path.resolve(options.workspaceDir));
  if (options.explicit !== undefined && options.explicit.trim() !== "") {
    return { id: parseTtsProviderId(options.explicit), source: "flag" };
  }
  const fromEnv = process.env[TTS_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { id: parseTtsProviderId(fromEnv), source: "env" };
  }
  const stored = readStoredDefault(options.workspaceDir, "tts");
  if (stored !== undefined) {
    return { id: parseTtsProviderId(stored), source: "project" };
  }
  return { id: "elevenlabs", source: "builtin" };
}

export interface ProjectProviderDefaults {
  asr?: string;
  tts?: string;
}

export function getProjectProviderDefaults(workspaceDir: string): ProjectProviderDefaults {
  const { sequence } = loadSequence(workspaceDir);
  return {
    ...(sequence.providers?.asr ? { asr: sequence.providers.asr } : {}),
    ...(sequence.providers?.tts ? { tts: sequence.providers.tts } : {}),
  };
}

function normalizeStoredValue(
  which: "asr" | "tts",
  raw: string
): string | null {
  const trimmed = raw.trim();
  // "builtin" (or an empty value) clears the project default.
  if (trimmed === "" || trimmed.toLowerCase() === "builtin") return null;
  return which === "asr" ? parseAsrProviderId(trimmed) : parseTtsProviderId(trimmed);
}

/**
 * Stores project provider defaults in the sequence (`providers.asr/tts`), journaled like
 * any other sequence edit. Values are validated before anything is written.
 */
export function setProjectProviderDefaults(
  workspaceDir: string,
  values: { asr?: string; tts?: string }
): { defaults: ProjectProviderDefaults; revision: number } {
  const nextAsr = values.asr !== undefined ? normalizeStoredValue("asr", values.asr) : undefined;
  const nextTts = values.tts !== undefined ? normalizeStoredValue("tts", values.tts) : undefined;
  const { result, revision } = commitSequenceMutation(
    workspaceDir,
    "speech.providers.set-defaults",
    (seq) => {
      const current = { ...(seq.providers ?? {}) };
      if (nextAsr !== undefined) {
        if (nextAsr === null) delete current.asr;
        else current.asr = nextAsr;
      }
      if (nextTts !== undefined) {
        if (nextTts === null) delete current.tts;
        else current.tts = nextTts;
      }
      if (current.asr === undefined && current.tts === undefined) {
        delete seq.providers;
      } else {
        seq.providers = current;
      }
      return {
        ...(current.asr ? { asr: current.asr } : {}),
        ...(current.tts ? { tts: current.tts } : {}),
      } as ProjectProviderDefaults;
    }
  );
  return { defaults: result, revision };
}

export function describeProviderResolution(workspaceDir: string): {
  stored: ProjectProviderDefaults;
  effective: {
    asr: { id: string; source: ProviderSource };
    tts: { id: string; source: ProviderSource };
  };
} {
  return {
    stored: getProjectProviderDefaults(workspaceDir),
    effective: {
      asr: resolveAsrProvider({ workspaceDir }),
      tts: resolveTtsProvider({ workspaceDir }),
    },
  };
}
