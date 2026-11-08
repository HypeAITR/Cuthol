/**
 * Cuthol Voiceover Synthesis Service (`src/speech/synthesize.ts`).
 *
 * Synthesizes speech via ElevenLabs (`/with-timestamps`) or the local provider door,
 * caches the audio + word-level alignment in `.cuthol/ledger.sqlite` (`tts_cache` & `transcript_cache`),
 * ingests the voiceover into the sequence library (`vo_01`, `vo_02`...), and optionally
 * places it on a lane (`ln_vo`) or appends it to the spine.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveCueStartMs } from "../core/timeline.js";
import { CutholDiagnostic, DIAGNOSTICS } from "../core/diagnostics.js";
import { loadDotEnvIfNeeded } from "../core/env.js";
import {
  allocateNextHandle,
  assetPrefixForKind,
  createDefaultAudioChain,
  createDefaultPlacement,
  LaneCue,
  LibraryItem,
} from "../core/schema.js";
import { loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { probeLocalMediaFile } from "../library/probe.js";
import { commitVerifiedMutation } from "../verify/gates.js";
import {
  annotateWordsAndDisfluencies,
  RawTranscriptWord,
  synthesizeWithElevenLabs,
  synthesizeWithLocalProvider,
  TranscriptDocument,
  TtsProviderId,
} from "./providers.js";
import { providerCacheTag, resolveExtensionProvider } from "../extensions/ext_providers.js";
import {
  ExtensionTtsAlignmentKind,
  synthesizeWithExtensionProvider,
} from "./provider_ext.js";
import { extensionNameOf, resolveTtsProvider } from "./provider_select.js";

/**
 * Language recorded for a voiceover when none is given. Letters that only Turkish uses
 * (ğ, ı, ş, İ) mark it as `tr`; anything else is recorded as `und` (BCP 47 "undetermined")
 * instead of guessing, so an explicit `speech transcribe --lang <code>` never reuses it as
 * a transcript in the wrong language.
 */
export function guessTextLanguage(text: string): string {
  return /[ğĞıİşŞ]/.test(text) ? "tr" : "und";
}

export interface SynthesizeVoiceoverResult {
  asset: LibraryItem;
  cached: boolean;
  provider: TtsProviderId;
  duration_ms: number;
  words: RawTranscriptWord[];
  placed_cue?: LaneCue;
  is_placeholder_audio?: boolean;
  placeholder_warning?: string;
  has_alignment: boolean;
  alignment_kind: "word" | "character" | "none";
  alignment_warning?: string;
  diagnostics?: CutholDiagnostic[];
}

export async function synthesizeVoiceover(options: {
  workspaceDir: string;
  text: string;
  voiceId?: string;
  modelId?: string;
  speed?: number;
  provider?: string;
  language?: string;
  placeOnLane?: string;
  atMs?: number;
  anchorClipId?: string;
  anchorOffsetMs?: number;
}): Promise<SynthesizeVoiceoverResult> {
  const { paths, sequence: currentSeq } = loadSequence(options.workspaceDir);
  loadDotEnvIfNeeded(paths.rootDir);
  const resolvedProvider = resolveTtsProvider({
    workspaceDir: options.workspaceDir,
    explicit: options.provider,
  });
  const provider: TtsProviderId = resolvedProvider.id;
  const extProviderName = extensionNameOf(provider);
  const extCacheTag =
    extProviderName !== null
      ? providerCacheTag(
          resolveExtensionProvider({
            extensionName: extProviderName,
            kind: "tts",
            workspaceDir: options.workspaceDir,
          }).extension
        )
      : null;
  const transcriptProvider: TranscriptDocument["provider"] =
    provider === "elevenlabs" ? "deepgram" : provider === "local" ? "local" : provider;
  const voiceId = options.voiceId ?? (provider === "elevenlabs" ? "21m00Tcm4TlvDq8ikWAM" : provider === "local" ? "local_default" : "default");
  const modelId = options.modelId ?? (provider === "elevenlabs" ? "eleven_multilingual_v2" : provider === "local" ? "local-cadence-v1" : "default");
  const speed =
    options.speed !== undefined && Number.isFinite(options.speed) ? options.speed : 1.0;
  const lang = (options.language?.trim() || guessTextLanguage(options.text)).toLowerCase();

  const cacheKey = crypto
    .createHash("sha256")
    .update(JSON.stringify(extCacheTag !== null ? { provider, ext: extCacheTag, voiceId, modelId, speed, text: options.text.trim() } : { provider, voiceId, modelId, speed, text: options.text.trim() }))
    .digest("hex");

  const ledger = new MediaLedger(paths.ledgerFile);
  let audioFilePath: string;
  let words: RawTranscriptWord[];
  let wasCached = false;
  let extAlignmentKind: ExtensionTtsAlignmentKind | undefined;
  let probedSha256: string;
  let probedMeta: ReturnType<typeof probeLocalMediaFile>["probe"];

  try {
    const cachedTts = ledger.getTts<{ words: RawTranscriptWord[]; alignment_kind?: ExtensionTtsAlignmentKind }>(cacheKey);
    if (cachedTts && fs.existsSync(cachedTts.audioPath)) {
      wasCached = true;
      const ext = path.extname(cachedTts.audioPath) || (provider === "elevenlabs" ? ".mp3" : ".wav");
      const localBlobPath = path.join(paths.blobsDir, `tts_${cacheKey.slice(0, 14)}${ext}`);
      if (path.resolve(cachedTts.audioPath) !== path.resolve(localBlobPath)) {
        fs.mkdirSync(paths.blobsDir, { recursive: true });
        if (!fs.existsSync(localBlobPath)) {
          fs.copyFileSync(cachedTts.audioPath, localBlobPath);
        }
      }
      audioFilePath = fs.existsSync(localBlobPath) ? localBlobPath : cachedTts.audioPath;
      words = cachedTts.alignment.words;
      extAlignmentKind = cachedTts.alignment.alignment_kind;
    } else {
      const ext = provider === "elevenlabs" ? "mp3" : "wav";
      audioFilePath = path.join(paths.blobsDir, `tts_${cacheKey.slice(0, 14)}.${ext}`);

      if (extProviderName !== null) {
        const res = await synthesizeWithExtensionProvider({
          workspaceDir: options.workspaceDir,
          extensionName: extProviderName,
          text: options.text,
          voiceId,
          modelId,
          speed,
          language: lang,
          tempAudioPath: audioFilePath,
        });
        words = res.output.words;
        extAlignmentKind = res.alignmentKind;
      } else if (provider === "local") {
        const res = await synthesizeWithLocalProvider({
          text: options.text,
          voiceId,
          speed,
          tempWavPath: audioFilePath,
        });
        words = res.words;
      } else {
        const res = await synthesizeWithElevenLabs({
          text: options.text,
          voiceId,
          modelId,
          speed,
        });
        fs.writeFileSync(audioFilePath, res.audio_buffer);
        words = res.words;
      }
    }

    const probed = probeLocalMediaFile(audioFilePath, ledger);
    probedSha256 = probed.sha256;
    probedMeta = probed.probe;

    // Scale or clamp word timestamps to `[0, probedMeta.duration_ms]` so external TTS duration differences
    // or encoder/decoder frame padding never drop words or exceed `probedMeta.duration_ms`.
    const maxDurMs = Math.max(1, probedMeta.duration_ms);
    if (words.length > 0) {
      const lastWordEnd = words[words.length - 1].source_end_ms;
      const needsProportionalScale =
        lastWordEnd > maxDurMs &&
        (provider === "local" || words.some((w) => w.source_start_ms >= maxDurMs));
      if (needsProportionalScale && lastWordEnd > 0) {
        const scale = maxDurMs / lastWordEnd;
        words = words.map((w) => {
          const st = Math.max(0, Math.min(maxDurMs - 1, Math.round(w.source_start_ms * scale)));
          const en = Math.max(st + 1, Math.min(maxDurMs, Math.round(w.source_end_ms * scale)));
          return { ...w, source_start_ms: st, source_end_ms: en };
        });
      } else {
        words = words
          .filter((w) => w.source_start_ms < maxDurMs)
          .map((w) => {
            const st = Math.max(0, Math.min(maxDurMs - 1, w.source_start_ms));
            const en = Math.max(st + 1, Math.min(maxDurMs, w.source_end_ms));
            return { ...w, source_start_ms: st, source_end_ms: en };
          });
      }
    }

    ledger.setTts(
      cacheKey,
      audioFilePath,
      extAlignmentKind !== undefined ? { words, alignment_kind: extAlignmentKind } : { words }
    );

    // Store the word alignment directly in `transcript_cache` under the audio file's SHA-256
    // so `speech captions` and `speech cleanup` work immediately on synthesized voiceovers!
    const { disfluencies } = annotateWordsAndDisfluencies(words, probedMeta.duration_ms);
    const doc: TranscriptDocument = {
      provider: transcriptProvider,
      model: modelId,
      language: lang,
      duration_ms: probedMeta.duration_ms,
      text: options.text.trim(),
      words,
      disfluencies,
    };
    ledger.setTranscript(probedSha256, lang, doc);
    ledger.setTranscript(probedSha256, `local:${lang}`, doc);
    ledger.setTranscript(probedSha256, `deepgram:${lang}`, doc);
    if (extProviderName !== null) {
      ledger.setTranscript(probedSha256, `ext:${extProviderName}:${lang}`, doc);
    }
    ledger.setTranscript(probedSha256, "auto", doc);
    ledger.setTranscript(probedSha256, "latest", doc);
  } finally {
    ledger.close();
  }

  const transcriptRef = `tts_${probedSha256.slice(0, 8)}`;
  const existingItem = currentSeq.library.find((item) => item.digest_sha256 === probedSha256);

  const alignmentKind: "word" | "character" | "none" =
    extAlignmentKind ??
    (extProviderName !== null
      ? words.length > 0
        ? "word"
        : "none"
      : provider === "local"
        ? "word"
        : "character");
  const alignmentWarning =
    extProviderName !== null && alignmentKind === "none"
      ? `Extension TTS provider '${extProviderName}' returned audio without word or character alignment, so no word timings are available.`
      : undefined;

  const isPlaceholder = provider === "local" && !process.env.CUTHOL_LOCAL_TTS_CMD;
  const placeholderWarning = isPlaceholder
    ? "CUTHOL_LOCAL_TTS_CMD is not set, so a synthetic formant placeholder tone was produced instead of speech; for real speech use ElevenLabs, CUTHOL_LOCAL_TTS_CMD or an ext: TTS provider."
    : undefined;

  // If the asset is already in the library with its transcript ref set and no lane placement is requested,
  // avoid creating a redundant journal revision.
  if (
    existingItem &&
    existingItem.analysis_refs.transcript === transcriptRef &&
    !options.placeOnLane
  ) {
    return {
      asset: existingItem,
      cached: wasCached,
      provider,
      duration_ms: existingItem.probe.duration_ms,
      has_alignment: words.length > 0,
      alignment_kind: alignmentKind,
      ...(alignmentWarning !== undefined ? { alignment_warning: alignmentWarning } : {}),
      ...(extProviderName !== null && alignmentKind === "none"
        ? { diagnostics: [DIAGNOSTICS.PROVIDER_TTS_NO_ALIGNMENT(extProviderName)] }
        : {}),
      words,
      is_placeholder_audio: isPlaceholder,
      placeholder_warning: placeholderWarning,
    };
  }

  // Perform library ingestion, transcript ref tagging, and optional lane cue placement
  // inside a SINGLE atomic verified mutation so JournalGuard undo/rollback is 100% atomic.
  const { result: mutRes } = commitVerifiedMutation(
    options.workspaceDir,
    `speech.synthesize(${voiceId})`,
    (seq) => {
      let asset = seq.library.find((item) => item.digest_sha256 === probedSha256);
      if (!asset) {
        const absFile = path.resolve(audioFilePath);
        const existingHandles = seq.library.map((item) => item.handle);
        const handle = allocateNextHandle(existingHandles, assetPrefixForKind("voiceover"), seq);
        const relUri = path.relative(paths.rootDir, absFile).replace(/\\/g, "/");
        const uri = relUri.startsWith("..") ? absFile.replace(/\\/g, "/") : relUri;

        asset = {
          handle,
          kind: "voiceover",
          uri,
          digest_sha256: probedSha256,
          probe: probedMeta,
          analysis_refs: {
            transcript: transcriptRef,
          },
        };
        seq.library.push(asset);
      } else {
        asset.analysis_refs.transcript = transcriptRef;
      }

      let placedCue: LaneCue | undefined;
      if (options.placeOnLane) {
        let lane = seq.lanes.find((l) => l.id === options.placeOnLane);
        if (!lane) {
          lane = {
            id: options.placeOnLane,
            kind: "voiceover",
            z_index: -10,
            muted: false,
            locked: false,
            cues: [],
          };
          seq.lanes.push(lane);
        }

        const existingCueIds = seq.lanes.flatMap((l) => l.cues.map((c) => c.id));
        const cueId = allocateNextHandle(existingCueIds, "cue", seq);
        const newCue: LaneCue = {
          id: cueId,
          kind: "voiceover",
          asset_handle: asset.handle,
          anchor: options.anchorClipId
            ? { ref: options.anchorClipId, offset_ms: options.anchorOffsetMs ?? 0 }
            : null,
          at_ms: options.atMs ?? 0,
          duration_ms: asset.probe.duration_ms,
          placement: createDefaultPlacement(),
          audio_chain: createDefaultAudioChain(),
          envelopes: [],
        };
        newCue.at_ms = resolveCueStartMs(seq, newCue);
        lane.cues.push(newCue);
        placedCue = newCue;
      }

      return { asset, placedCue };
    }
  );

  return {
    asset: mutRes.asset,
    cached: wasCached,
    provider,
    duration_ms: mutRes.asset.probe.duration_ms,
    has_alignment: words.length > 0,
    alignment_kind: alignmentKind,
    ...(alignmentWarning !== undefined ? { alignment_warning: alignmentWarning } : {}),
    ...(extProviderName !== null && alignmentKind === "none"
      ? { diagnostics: [DIAGNOSTICS.PROVIDER_TTS_NO_ALIGNMENT(extProviderName)] }
      : {}),
    words,
    placed_cue: mutRes.placedCue,
    is_placeholder_audio: isPlaceholder,
    placeholder_warning: placeholderWarning,
  };
}
