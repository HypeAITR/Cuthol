/**
 * Cloud (Deepgram ASR & ElevenLabs TTS) and Pluggable Local Speech Providers (`src/speech/providers.ts`).
 *
 * Architecture:
 * - Default cloud providers use `.env` (`DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`).
 * - Open-source local provider doors (`local` ASR & `local` TTS) allow running Cuthol
 *   with local models (`whisper.cpp` / `faster-whisper` / `piper` / `kokoro` via CLI or HTTP)
 *   without changing any downstream Cuthol sequence, caption, or cleanup code.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { requireApiKey } from "../core/env.js";
import { OPEN_STANDARDS } from "../core/standards.js";

export type AsrProviderId = "deepgram" | "local" | `ext:${string}`;
export type TtsProviderId = "elevenlabs" | "local" | `ext:${string}`;

export interface RawTranscriptWord {
  word: string;
  punctuated_word: string;
  source_start_ms: number;
  source_end_ms: number;
  confidence: number;
  is_filler: boolean;
  is_repetition: boolean;
}

export interface DetectedDisfluencySpan {
  kind: "pause" | "filler" | "repetition";
  source_start_ms: number;
  source_end_ms: number;
  duration_ms: number;
  label: string;
}

export interface TranscriptDocument {
  provider: AsrProviderId;
  model: string;
  language: string;
  duration_ms: number;
  text: string;
  words: RawTranscriptWord[];
  disfluencies: DetectedDisfluencySpan[];
}

export interface TtsSynthesisOutput {
  provider: TtsProviderId;
  voice_id: string;
  model_id: string;
  audio_buffer: Buffer;
  duration_ms: number;
  words: RawTranscriptWord[];
  is_placeholder_audio?: boolean;
  placeholder_warning?: string;
}

export const UNCONDITIONAL_FILLER_TOKENS = new Set([
  // Turkish non-lexical hesitation sounds
  "ıı",
  "ııı",
  "ee",
  "eee",
  // English non-lexical hesitation sounds
  "uh",
  "um",
  "umm",
  "er",
  "ah",
  "hmm",
]);

export const CONTEXTUAL_FILLER_TOKENS = new Set([
  // Turkish discourse words that are meaningful in fluent clauses ("bir şey var", "yani şöyle")
  // and should only be treated as fillers when isolated by hesitation pauses on both sides.
  "şey",
  "yani",
  "hani",
  "acaba",
]);

export function normalizeTokenForMatch(word: string): string {
  return word
    .toLocaleLowerCase("tr-TR")
    .replace(/\u0307/g, "")
    .replace(/[.,!?;:"'()[\]{}…—–-]/g, "")
    .trim();
}

export function isContextualFillerToken(word: string): boolean {
  return CONTEXTUAL_FILLER_TOKENS.has(normalizeTokenForMatch(word));
}

export function isContextualFillerIsolated(gapBeforeMs: number, gapAfterMs: number): boolean {
  const minSideGap = OPEN_STANDARDS.DIALOGUE_CLEANUP.CONTEXTUAL_FILLER_MIN_SIDE_GAP_MS;
  const minDominantGap = OPEN_STANDARDS.DIALOGUE_CLEANUP.CONTEXTUAL_FILLER_MIN_DOMINANT_GAP_MS;
  return (
    gapBeforeMs >= minSideGap &&
    gapAfterMs >= minSideGap &&
    Math.max(gapBeforeMs, gapAfterMs) >= minDominantGap
  );
}

/**
 * Post-processes raw word tokens to annotate fillers, immediate repetitions, and inter-word pauses.
 */
export function annotateWordsAndDisfluencies(
  rawWords: Array<{
    word: string;
    punctuated_word?: string;
    source_start_ms: number;
    source_end_ms: number;
    confidence?: number;
  }>,
  totalDurationMs: number,
  minPauseMs: number = OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_MIN_PAUSE_MS
): { words: RawTranscriptWord[]; disfluencies: DetectedDisfluencySpan[] } {
  const words: RawTranscriptWord[] = [];
  const disfluencies: DetectedDisfluencySpan[] = [];

  for (let i = 0; i < rawWords.length; i++) {
    const curr = rawWords[i];
    const clean = normalizeTokenForMatch(curr.word);
    const prevClean = i > 0 ? normalizeTokenForMatch(rawWords[i - 1].word) : "";
    const gapFromPrev = i > 0 ? curr.source_start_ms - rawWords[i - 1].source_end_ms : curr.source_start_ms;
    const gapToNext =
      i + 1 < rawWords.length
        ? rawWords[i + 1].source_start_ms - curr.source_end_ms
        : totalDurationMs - curr.source_end_ms;

    // Leading silence / inter-word pause check
    if (i === 0 && curr.source_start_ms >= minPauseMs) {
      disfluencies.push({
        kind: "pause",
        source_start_ms: 0,
        source_end_ms: curr.source_start_ms,
        duration_ms: curr.source_start_ms,
        label: `<silence ${curr.source_start_ms}ms>`,
      });
    } else if (i > 0 && gapFromPrev >= minPauseMs) {
      const pStart = rawWords[i - 1].source_end_ms;
      const pEnd = curr.source_start_ms;
      disfluencies.push({
        kind: "pause",
        source_start_ms: pStart,
        source_end_ms: pEnd,
        duration_ms: pEnd - pStart,
        label: `<pause ${pEnd - pStart}ms>`,
      });
    }

    const isFiller =
      UNCONDITIONAL_FILLER_TOKENS.has(clean) ||
      (CONTEXTUAL_FILLER_TOKENS.has(clean) && isContextualFillerIsolated(gapFromPrev, gapToNext));
    const prevPunctuated =
      i > 0 ? String(rawWords[i - 1].punctuated_word ?? rawWords[i - 1].word ?? "").trim() : "";
    const prevEndsSentence = /[.!?…]+['"”’)\]]*$/.test(prevPunctuated);
    const isRepetition = Boolean(
      clean && clean === prevClean && gapFromPrev < 800 && !prevEndsSentence
    );

    if (isFiller) {
      disfluencies.push({
        kind: "filler",
        source_start_ms: curr.source_start_ms,
        source_end_ms: curr.source_end_ms,
        duration_ms: curr.source_end_ms - curr.source_start_ms,
        label: curr.word,
      });
    } else if (isRepetition) {
      disfluencies.push({
        kind: "repetition",
        source_start_ms: curr.source_start_ms,
        source_end_ms: curr.source_end_ms,
        duration_ms: curr.source_end_ms - curr.source_start_ms,
        label: curr.word,
      });
    }

    words.push({
      word: clean || curr.word,
      punctuated_word: curr.punctuated_word ?? curr.word,
      source_start_ms: curr.source_start_ms,
      source_end_ms: curr.source_end_ms,
      confidence: curr.confidence ?? 0.99,
      is_filler: isFiller,
      is_repetition: isRepetition,
    });
  }

  // Trailing silence check
  if (words.length > 0) {
    const lastEnd = words[words.length - 1].source_end_ms;
    if (totalDurationMs - lastEnd >= minPauseMs) {
      disfluencies.push({
        kind: "pause",
        source_start_ms: lastEnd,
        source_end_ms: totalDurationMs,
        duration_ms: totalDurationMs - lastEnd,
        label: `<trailing_silence ${totalDurationMs - lastEnd}ms>`,
      });
    }
  }

  return { words, disfluencies };
}

/**
 * Cloud ASR Provider: Deepgram Nova-3 (`/v1/listen`).
 */
export async function transcribeWithDeepgram(options: {
  audioFilePath: string;
  language?: string;
  durationMs: number;
  keyterms?: string[];
}): Promise<TranscriptDocument> {
  const apiKey = requireApiKey("DEEPGRAM_API_KEY", "Deepgram ASR");
  const audioBuffer = fs.readFileSync(options.audioFilePath);

  const params = new URLSearchParams({
    model: "nova-3",
    smart_format: "true",
    utterances: "true",
    filler_words: "true",
    punctuate: "true",
  });
  if (options.language && options.language !== "auto") {
    params.set("language", options.language);
  } else {
    params.set("detect_language", "true");
  }
  for (const term of options.keyterms ?? ["Cuthol", "HyperFrames"]) {
    if (term.trim()) {
      params.append("keyterm", term.trim());
    }
  }

  const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "audio/wav",
    },
    body: audioBuffer,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new CutholError(
      DIAGNOSTICS.EXTERNAL_TOOL_FAILED("Deepgram API", `HTTP ${response.status}: ${errText.slice(0, 300)}`)
    );
  }

  const payload = (await response.json()) as {
    results?: {
      channels?: Array<{
        detected_language?: string;
        alternatives?: Array<{
          transcript?: string;
          words?: Array<{
            word: string;
            punctuated_word?: string;
            start: number;
            end: number;
            confidence?: number;
          }>;
        }>;
      }>;
    };
  };

  const ch = payload.results?.channels?.[0];
  const alt = ch?.alternatives?.[0];
  const rawWords = (alt?.words ?? []).map((w) => ({
    word: w.word,
    punctuated_word: w.punctuated_word ?? w.word,
    source_start_ms: Math.round(w.start * 1000),
    source_end_ms: Math.round(w.end * 1000),
    confidence: w.confidence ?? 0.98,
  }));

  const { words, disfluencies } = annotateWordsAndDisfluencies(rawWords, options.durationMs);

  return {
    provider: "deepgram",
    model: "nova-3",
    language: ch?.detected_language ?? options.language ?? "auto",
    duration_ms: options.durationMs,
    text: alt?.transcript ?? words.map((w) => w.punctuated_word).join(" "),
    words,
    disfluencies,
  };
}

/**
 * Local ASR Provider Door:
 * - If `CUTHOL_LOCAL_ASR_CMD` is set (e.g. `faster-whisper` or `whisper-cli`), invokes it and parses JSON output.
 *   The JSON may carry an optional top-level `language`; without it, auto-detection asks for an explicit `--lang`.
 * - If a sidecar `<audioFilePath>.transcript.json` exists, loads it directly.
 */
export async function transcribeWithLocalProvider(options: {
  audioFilePath: string;
  language?: string;
  durationMs: number;
}): Promise<TranscriptDocument> {
  const sidecarPath = `${options.audioFilePath}.transcript.json`;
  if (fs.existsSync(sidecarPath)) {
    let raw: {
      language?: string;
      text?: string;
      words?: Array<{
        word: string;
        punctuated_word?: string;
        source_start_ms: number;
        source_end_ms: number;
        confidence?: number;
      }>;
    };
    try {
      raw = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    } catch (err) {
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
          "local sidecar transcript JSON",
          err instanceof Error ? err.message : String(err)
        )
      );
    }
    if (!raw || !Array.isArray(raw.words)) {
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
          "local sidecar transcript JSON",
          "Expected a JSON object with a 'words' array."
        )
      );
    }
    const sanitizedWords = raw.words
      .filter((w) => w && typeof w.word === "string")
      .map((w) => ({
        word: w.word,
        punctuated_word: typeof w.punctuated_word === "string" ? w.punctuated_word : w.word,
        source_start_ms: Number.isFinite(Number(w.source_start_ms)) ? Math.round(Number(w.source_start_ms)) : 0,
        source_end_ms: Number.isFinite(Number(w.source_end_ms)) ? Math.round(Number(w.source_end_ms)) : 100,
        confidence: Number.isFinite(Number(w.confidence)) ? Number(w.confidence) : 0.99,
      }));
    const { words, disfluencies } = annotateWordsAndDisfluencies(sanitizedWords, options.durationMs);
    const sidecarLang =
      typeof raw.language === "string" && raw.language.trim()
        ? raw.language.trim().toLowerCase()
        : (options.language ?? "auto");
    return {
      provider: "local",
      model: "local-sidecar",
      language: sidecarLang,
      duration_ms: options.durationMs,
      text: raw.text ?? words.map((w) => w.punctuated_word).join(" "),
      words,
      disfluencies,
    };
  }

  const customCmd = process.env.CUTHOL_LOCAL_ASR_CMD;
  if (customCmd) {
    const quotedAudioPath = `"${options.audioFilePath.replace(/"/g, '\\"')}"`;
    const proc = spawnSync(`${customCmd} ${quotedAudioPath}`, {
      shell: true,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CUTHOL_LOCAL_ASR_AUDIO_FILE: options.audioFilePath },
    });
    if (proc.status !== 0) {
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_TOOL_FAILED("CUTHOL_LOCAL_ASR_CMD", (proc.stderr || "failed").slice(-300))
      );
    }
    let parsed: {
      language?: string;
      words?: Array<{ word: string; punctuated_word?: string; source_start_ms: number; source_end_ms: number }>;
    };
    try {
      parsed = JSON.parse(proc.stdout);
    } catch (err) {
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
          "CUTHOL_LOCAL_ASR_CMD JSON",
          err instanceof Error ? err.message : String(err)
        )
      );
    }
    if (!parsed || !Array.isArray(parsed.words)) {
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
          "CUTHOL_LOCAL_ASR_CMD JSON",
          "Expected JSON output containing a 'words' array."
        )
      );
    }
    const sanitizedWords = parsed.words
      .filter((w) => w && typeof w.word === "string")
      .map((w) => ({
        word: w.word,
        punctuated_word: typeof w.punctuated_word === "string" ? w.punctuated_word : w.word,
        source_start_ms: Number.isFinite(Number(w.source_start_ms)) ? Math.round(Number(w.source_start_ms)) : 0,
        source_end_ms: Number.isFinite(Number(w.source_end_ms)) ? Math.round(Number(w.source_end_ms)) : 100,
      }));
    const { words, disfluencies } = annotateWordsAndDisfluencies(sanitizedWords, options.durationMs);
    const cmdLang =
      typeof parsed.language === "string" && parsed.language.trim()
        ? parsed.language.trim().toLowerCase()
        : (options.language ?? "auto");
    return {
      provider: "local",
      model: "custom-cli",
      language: cmdLang,
      duration_ms: options.durationMs,
      text: words.map((w) => w.punctuated_word).join(" "),
      words,
      disfluencies,
    };
  }

  throw new CutholError(
    DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
      "local ASR provider",
      "Provide a '<file>.transcript.json' sidecar or set CUTHOL_LOCAL_ASR_CMD to a local Whisper binary."
    )
  );
}

/**
 * Converts ElevenLabs character-level alignment arrays into exact millisecond word tokens.
 */
export function characterAlignmentToWordTokens(alignment: {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}): RawTranscriptWord[] {
  const chars = alignment.characters ?? [];
  const starts = alignment.character_start_times_seconds ?? [];
  const ends = alignment.character_end_times_seconds ?? [];

  const rawWords: Array<{
    word: string;
    punctuated_word: string;
    source_start_ms: number;
    source_end_ms: number;
  }> = [];

  let currentChars = "";
  let wordStartSec: number | null = null;
  let wordEndSec = 0;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const st = starts[i] ?? wordEndSec;
    const en = ends[i] ?? st;

    if (/\s/.test(ch)) {
      if (currentChars.length > 0 && wordStartSec !== null) {
        rawWords.push({
          word: normalizeTokenForMatch(currentChars) || currentChars,
          punctuated_word: currentChars,
          source_start_ms: Math.round(wordStartSec * 1000),
          source_end_ms: Math.max(Math.round(wordStartSec * 1000) + 20, Math.round(wordEndSec * 1000)),
        });
        currentChars = "";
        wordStartSec = null;
      }
    } else {
      if (wordStartSec === null) {
        wordStartSec = st;
      }
      currentChars += ch;
      wordEndSec = en;
    }
  }

  if (currentChars.length > 0 && wordStartSec !== null) {
    rawWords.push({
      word: normalizeTokenForMatch(currentChars) || currentChars,
      punctuated_word: currentChars,
      source_start_ms: Math.round(wordStartSec * 1000),
      source_end_ms: Math.max(Math.round(wordStartSec * 1000) + 20, Math.round(wordEndSec * 1000)),
    });
  }

  for (let i = 0; i < rawWords.length - 1; i++) {
    if (rawWords[i].source_end_ms > rawWords[i + 1].source_start_ms) {
      rawWords[i].source_end_ms = Math.max(
        rawWords[i].source_start_ms + 1,
        rawWords[i + 1].source_start_ms
      );
    }
    if (rawWords[i + 1].source_start_ms < rawWords[i].source_end_ms) {
      rawWords[i + 1].source_start_ms = rawWords[i].source_end_ms;
      rawWords[i + 1].source_end_ms = Math.max(
        rawWords[i + 1].source_end_ms,
        rawWords[i + 1].source_start_ms + 1
      );
    }
  }

  const totalDur = rawWords.length > 0 ? rawWords[rawWords.length - 1].source_end_ms : 0;
  return annotateWordsAndDisfluencies(rawWords, totalDur).words;
}

/**
 * Cloud TTS Provider: ElevenLabs `/v1/text-to-speech/{voice_id}/with-timestamps`.
 */
export async function synthesizeWithElevenLabs(options: {
  text: string;
  voiceId?: string;
  modelId?: string;
  speed?: number;
}): Promise<TtsSynthesisOutput> {
  const apiKey = requireApiKey("ELEVENLABS_API_KEY", "ElevenLabs TTS");
  // Default Rachel / premade multilingual voice ID
  const voiceId = options.voiceId ?? "21m00Tcm4TlvDq8ikWAM";
  const modelId = options.modelId ?? "eleven_multilingual_v2";

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: options.text,
        model_id: modelId,
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.75,
          speed: options.speed ?? 1.0,
        },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new CutholError(
      DIAGNOSTICS.EXTERNAL_TOOL_FAILED("ElevenLabs API", `HTTP ${response.status}: ${errText.slice(0, 300)}`)
    );
  }

  const payload = (await response.json()) as {
    audio_base64: string;
    alignment?: {
      characters: string[];
      character_start_times_seconds: number[];
      character_end_times_seconds: number[];
    };
    normalized_alignment?: {
      characters: string[];
      character_start_times_seconds: number[];
      character_end_times_seconds: number[];
    };
  };

  const audioBuffer = Buffer.from(payload.audio_base64, "base64");
  const align = payload.alignment ?? payload.normalized_alignment;
  const words = align ? characterAlignmentToWordTokens(align) : [];
  const durationMs = words.length > 0 ? words[words.length - 1].source_end_ms + 120 : 2000;

  return {
    provider: "elevenlabs",
    voice_id: voiceId,
    model_id: modelId,
    audio_buffer: audioBuffer,
    duration_ms: durationMs,
    words,
  };
}

/**
 * Local TTS Provider Door:
 * Synthesizes deterministic speech-cadence audio and proportional character-weighted word timestamps
 * when `--provider local` is selected (or invokes `CUTHOL_LOCAL_TTS_CMD` if configured).
 */
export async function synthesizeWithLocalProvider(options: {
  text: string;
  voiceId?: string;
  speed?: number;
  tempWavPath: string;
}): Promise<TtsSynthesisOutput> {
  const tokens = options.text.trim().split(/\s+/).filter(Boolean);
  const rawSpeed =
    options.speed !== undefined && Number.isFinite(options.speed) ? options.speed : 1.0;
  const speed = Math.max(0.5, Math.min(2.0, rawSpeed));
  const msPerChar = 62 / speed;
  const interWordGapMs = Math.round(70 / speed);

  const rawWords: Array<{
    word: string;
    punctuated_word: string;
    source_start_ms: number;
    source_end_ms: number;
  }> = [];

  let cursorMs = 80;

  for (const tok of tokens) {
    const wordDurMs = Math.max(160, Math.round(tok.length * msPerChar));
    const startMs = cursorMs;
    const endMs = startMs + wordDurMs;
    rawWords.push({
      word: normalizeTokenForMatch(tok) || tok,
      punctuated_word: tok,
      source_start_ms: startMs,
      source_end_ms: endMs,
    });
    cursorMs = endMs + interWordGapMs;
  }

  let totalDurationMs = Math.max(600, cursorMs + 120);

  const customTtsCmd = process.env.CUTHOL_LOCAL_TTS_CMD;
  if (customTtsCmd) {
    const quotedOut = `"${options.tempWavPath.replace(/"/g, '\\"')}"`;
    const proc = spawnSync(`${customTtsCmd} ${quotedOut}`, {
      shell: true,
      input: options.text,
      encoding: "utf8",
      env: {
        ...process.env,
        CUTHOL_LOCAL_TTS_TEXT: options.text,
        CUTHOL_LOCAL_TTS_VOICE: options.voiceId ?? "local_default",
        CUTHOL_LOCAL_TTS_OUT: options.tempWavPath,
      },
    });
    if (proc.status !== 0 || !fs.existsSync(options.tempWavPath)) {
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
          "CUTHOL_LOCAL_TTS_CMD",
          (proc.stderr || "local tts command failed").slice(-300)
        )
      );
    }

    // Measure actual duration of external TTS audio and scale synthetic word timestamps proportionally
    let actualDurationMs = 0;
    const extBuf = fs.readFileSync(options.tempWavPath);
    if (
      extBuf.length >= 44 &&
      extBuf.toString("ascii", 0, 4) === "RIFF" &&
      extBuf.toString("ascii", 8, 12) === "WAVE"
    ) {
      const byteRate = extBuf.readUInt32LE(28);
      if (byteRate > 0) {
        actualDurationMs = Math.max(100, Math.round(((extBuf.length - 44) / byteRate) * 1000));
      }
    }
    if (actualDurationMs > 0 && totalDurationMs > 0 && rawWords.length > 0) {
      const scale = actualDurationMs / totalDurationMs;
      for (let i = 0; i < rawWords.length; i++) {
        const scaledStart = Math.max(0, Math.min(actualDurationMs - 1, Math.round(rawWords[i].source_start_ms * scale)));
        const scaledEnd = Math.max(scaledStart + 1, Math.min(actualDurationMs, Math.round(rawWords[i].source_end_ms * scale)));
        rawWords[i].source_start_ms = scaledStart;
        rawWords[i].source_end_ms = scaledEnd;
      }
      totalDurationMs = actualDurationMs;
    }
  } else {
    // Synthesize formant-like voice cadence 48kHz 16-bit mono PCM WAV directly in memory
    // (avoids FFmpeg lavfi aevalsrc single-quote escaping & expression-tree depth limits on long texts)
    const sampleRate = 48000;
    const numSamples = Math.max(1, Math.round((totalDurationMs / 1000) * sampleRate));
    const headerSize = 44;
    const dataSize = numSamples * 2;
    const wavBuf = Buffer.alloc(headerSize + dataSize);

    // RIFF WAVE header (PCM s16le mono 48000 Hz)
    wavBuf.write("RIFF", 0, "ascii");
    wavBuf.writeUInt32LE(36 + dataSize, 4);
    wavBuf.write("WAVE", 8, "ascii");
    wavBuf.write("fmt ", 12, "ascii");
    wavBuf.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
    wavBuf.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
    wavBuf.writeUInt16LE(1, 22); // NumChannels = 1
    wavBuf.writeUInt32LE(sampleRate, 24); // SampleRate
    wavBuf.writeUInt32LE(sampleRate * 2, 28); // ByteRate
    wavBuf.writeUInt16LE(2, 32); // BlockAlign
    wavBuf.writeUInt16LE(16, 34); // BitsPerSample
    wavBuf.write("data", 36, "ascii");
    wavBuf.writeUInt32LE(dataSize, 40);

    const twoPiOverSr = (2 * Math.PI) / sampleRate;
    const fadeSamples = Math.min(240, Math.floor(sampleRate * 0.005)); // 5ms de-click envelope on word edges

    const segments =
      rawWords.length > 0
        ? rawWords.map((w) => ({
            startSample: Math.max(0, Math.floor((w.source_start_ms / 1000) * sampleRate)),
            endSample: Math.min(numSamples, Math.ceil((w.source_end_ms / 1000) * sampleRate)),
          }))
        : [{ startSample: 0, endSample: numSamples }];

    for (const seg of segments) {
      for (let s = seg.startSample; s < seg.endSample; s++) {
        let env = 1.0;
        const fromStart = s - seg.startSample;
        const toEnd = seg.endSample - 1 - s;
        if (fadeSamples > 0) {
          if (fromStart < fadeSamples) env = fromStart / fadeSamples;
          else if (toEnd < fadeSamples) env = Math.min(env, toEnd / fadeSamples);
        }
        const phase = s * twoPiOverSr;
        const sampleVal =
          env *
          (0.35 * Math.sin(165 * phase) +
            0.25 * Math.sin(720 * phase) +
            0.12 * Math.sin(2400 * phase));
        const pcm16 = Math.max(-32768, Math.min(32767, Math.round(sampleVal * 32767)));
        wavBuf.writeInt16LE(pcm16, headerSize + s * 2);
      }
    }

    fs.writeFileSync(options.tempWavPath, wavBuf);
  }

  const audioBuffer = fs.readFileSync(options.tempWavPath);
  const { words } = annotateWordsAndDisfluencies(rawWords, totalDurationMs);

  const isPlaceholder = !customTtsCmd;
  return {
    provider: "local",
    voice_id: options.voiceId ?? "local_default",
    model_id: isPlaceholder ? "local-placeholder-tone" : "local-custom-cmd",
    audio_buffer: audioBuffer,
    duration_ms: totalDurationMs,
    words,
    is_placeholder_audio: isPlaceholder,
    placeholder_warning: isPlaceholder
      ? "CUTHOL_LOCAL_TTS_CMD is not set, so a synthetic formant placeholder tone was produced instead of speech; for real speech use ElevenLabs, CUTHOL_LOCAL_TTS_CMD or an ext: TTS provider."
      : undefined,
  };
}
