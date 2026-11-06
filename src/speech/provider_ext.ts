// Extension ASR/TTS provider adapters: contract JSON <-> TranscriptDocument/TtsSynthesisOutput.
import fs from "node:fs";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { ExtensionScope } from "../extensions/ext_manifest.js";
import {
  assertProviderWordList,
  collectProviderEnv,
  resolveExtensionProvider,
  runExtensionProviderScript,
} from "../extensions/ext_providers.js";
import {
  annotateWordsAndDisfluencies,
  characterAlignmentToWordTokens,
  RawTranscriptWord,
  TranscriptDocument,
  TtsSynthesisOutput,
} from "./providers.js";

export interface ExtensionAsrResult {
  doc: TranscriptDocument;
  extVersion: string;
  extHash: string;
}

function assertResponseObject(extName: string, kind: string, response: unknown): Record<string, unknown> {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_BAD_OUTPUT(extName, kind, "expected the response to be a JSON object.")
    );
  }
  return response as Record<string, unknown>;
}

export async function transcribeWithExtensionProvider(options: {
  workspaceDir: string;
  extensionName: string;
  audioFilePath: string;
  language?: string;
  durationMs: number;
  keyterms?: string[];
  scope?: ExtensionScope;
}): Promise<ExtensionAsrResult> {
  const provider = resolveExtensionProvider({
    extensionName: options.extensionName,
    kind: "asr",
    workspaceDir: options.workspaceDir,
    scope: options.scope,
  });
  const secrets = collectProviderEnv({
    workspaceDir: options.workspaceDir,
    extensionName: provider.extension.name,
    kind: "asr",
    declared: provider.spec.env,
  });

  const lang = (options.language ?? "tr").toLowerCase();
  const { response } = runExtensionProviderScript({
    provider,
    workspaceDir: options.workspaceDir,
    request: {
      contract: "cuthol.provider.asr/1",
      extension: provider.extension.name,
      version: provider.extension.version,
      audio_path: options.audioFilePath,
      language: lang,
      keyterms: options.keyterms ?? [],
      config: provider.spec.config ?? {},
    },
    secrets,
  });

  const obj = assertResponseObject(provider.extension.name, "asr", response);
  const validated = assertProviderWordList(provider.extension.name, "asr", obj.words, "words");
  const { words, disfluencies } = annotateWordsAndDisfluencies(
    validated,
    Math.max(1, Math.round(options.durationMs))
  );
  const text =
    typeof obj.text === "string" && obj.text.trim()
      ? obj.text.trim()
      : words.map((w) => w.punctuated_word).join(" ");
  return {
    doc: {
      provider: `ext:${provider.extension.name}`,
      model:
        typeof obj.model === "string" && obj.model.trim()
          ? obj.model.trim()
          : provider.extension.version,
      language:
        typeof obj.language === "string" && obj.language.trim()
          ? obj.language.trim().toLowerCase()
          : lang,
      duration_ms: Math.max(1, Math.round(options.durationMs)),
      text,
      words,
      disfluencies,
    },
    extVersion: provider.extension.version,
    extHash: provider.extension.contentHash,
  };
}

export type ExtensionTtsAlignmentKind = "word" | "character" | "none";

export interface ExtensionTtsResult {
  output: TtsSynthesisOutput;
  extVersion: string;
  extHash: string;
  alignmentKind: ExtensionTtsAlignmentKind;
}

function assertCharacterAlignment(
  extName: string,
  value: unknown
): {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_BAD_OUTPUT(
        extName,
        "tts",
        "alignment 'character' needs a 'characters' object with 'characters', 'character_start_times_seconds' and 'character_end_times_seconds' arrays."
      )
    );
  }
  const obj = value as Record<string, unknown>;
  const chars = obj.characters;
  const starts = obj.character_start_times_seconds;
  const ends = obj.character_end_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends)) {
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_BAD_OUTPUT(
        extName,
        "tts",
        "alignment 'character' needs a 'characters' object with 'characters', 'character_start_times_seconds' and 'character_end_times_seconds' arrays."
      )
    );
  }
  if (chars.length !== starts.length || chars.length !== ends.length) {
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_BAD_OUTPUT(
        extName,
        "tts",
        "'characters' arrays must all have the same length."
      )
    );
  }
  if (!chars.every((c) => typeof c === "string")) {
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_BAD_OUTPUT(extName, "tts", "'characters.characters' must be strings.")
    );
  }
  if (
    ![...starts, ...ends].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
  ) {
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_BAD_OUTPUT(
        extName,
        "tts",
        "'characters' timestamps must be finite numbers >= 0 (seconds)."
      )
    );
  }
  return {
    characters: chars as string[],
    character_start_times_seconds: starts as number[],
    character_end_times_seconds: ends as number[],
  };
}

export async function synthesizeWithExtensionProvider(options: {
  workspaceDir: string;
  extensionName: string;
  text: string;
  voiceId: string;
  modelId: string;
  speed: number;
  language: string;
  tempAudioPath: string;
  scope?: ExtensionScope;
}): Promise<ExtensionTtsResult> {
  const provider = resolveExtensionProvider({
    extensionName: options.extensionName,
    kind: "tts",
    workspaceDir: options.workspaceDir,
    scope: options.scope,
  });
  const secrets = collectProviderEnv({
    workspaceDir: options.workspaceDir,
    extensionName: provider.extension.name,
    kind: "tts",
    declared: provider.spec.env,
  });

  const { response, audioOutputPath } = runExtensionProviderScript({
    provider,
    workspaceDir: options.workspaceDir,
    request: {
      contract: "cuthol.provider.tts/1",
      extension: provider.extension.name,
      version: provider.extension.version,
      text: options.text,
      voice_id: options.voiceId,
      model_id: options.modelId,
      speed: options.speed,
      language: options.language,
      config: provider.spec.config ?? {},
    },
    needsAudioOutput: true,
    audioOutputExt: ".wav",
    persistAudioTo: options.tempAudioPath,
    secrets,
  });

  if (!audioOutputPath) {
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_EXECUTION_FAILED(
        provider.extension.name,
        "tts",
        "The script did not produce the expected audio file."
      )
    );
  }
  const audioBuffer = fs.readFileSync(options.tempAudioPath);

  const obj = assertResponseObject(provider.extension.name, "tts", response);
  const alignment = obj.alignment;
  if (alignment !== "word" && alignment !== "character" && alignment !== "none") {
    throw new CutholError(
      DIAGNOSTICS.PROVIDER_BAD_OUTPUT(
        provider.extension.name,
        "tts",
        "expected 'alignment' to be 'word', 'character', or 'none'."
      )
    );
  }

  let words: RawTranscriptWord[] = [];
  if (alignment === "word") {
    const validated = assertProviderWordList(provider.extension.name, "tts", obj.words, "words");
    const totalMs = Math.max(
      1,
      validated.length > 0 ? validated[validated.length - 1].source_end_ms : 1
    );
    words = annotateWordsAndDisfluencies(validated, totalMs).words;
  } else if (alignment === "character") {
    words = characterAlignmentToWordTokens(assertCharacterAlignment(provider.extension.name, obj.characters));
  } else {
    if (
      (Array.isArray(obj.words) && obj.words.length > 0) ||
      (obj.characters !== undefined && obj.characters !== null)
    ) {
      throw new CutholError(
        DIAGNOSTICS.PROVIDER_BAD_OUTPUT(
          provider.extension.name,
          "tts",
          "declares alignment 'none' but returns word or character timings."
        )
      );
    }
    words = [];
  }

  const durationMs = words.length > 0 ? words[words.length - 1].source_end_ms : 0;
  return {
    output: {
      provider: `ext:${provider.extension.name}`,
      voice_id: options.voiceId,
      model_id: options.modelId,
      audio_buffer: audioBuffer,
      duration_ms: durationMs,
      words,
    },
    extVersion: provider.extension.version,
    extHash: provider.extension.contentHash,
    alignmentKind: alignment,
  };
}
