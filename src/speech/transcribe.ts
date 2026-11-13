/**
 * Cuthol Speech Transcription Service (`src/speech/transcribe.ts`).
 *
 * Uses content-addressed `.cuthol/ledger.sqlite` (`transcript_cache`) so identical media
 * assets are never transcribed twice. Supports both cloud (`deepgram` Nova-3) and
 * pluggable `local` providers. The default language is auto-detection; records are
 * keyed by the document's real language, and a record filed under a disagreeing
 * language key is skipped on read so the cache heals itself.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { loadDotEnvIfNeeded } from "../core/env.js";
import { TimedWordToken } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { commitSequenceMutation, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { resolveLibraryItemPath } from "../library/probe.js";
import { analyzeAssetWaveform } from "../library/waveform.js";
import { projectTranscriptAcrossSequence } from "../sequence/spine.js";
import {
  AsrProviderId,
  TranscriptDocument,
  transcribeWithDeepgram,
  transcribeWithLocalProvider,
} from "./providers.js";
import { providerCacheTag, resolveExtensionProvider } from "../extensions/ext_providers.js";
import { transcribeWithExtensionProvider } from "./provider_ext.js";
import { extensionNameOf, resolveAsrProvider } from "./provider_select.js";

export interface TranscribeResult {
  handle: string;
  sha256: string;
  cached: boolean;
  transcript: TranscriptDocument;
  projected_sequence_words: TimedWordToken[];
}

/** Language named by a transcript cache key, or null for generic keys. */
function cacheKeyLanguage(key: string): string | null {
  const norm = key.toLowerCase();
  if (norm === "auto" || norm === "latest") return null;
  const last = norm.split(":").pop() ?? "";
  if (!last || last === "auto" || last === "latest") return null;
  return last;
}

/** True when two language tags name the same language (lenient on empty). */
function sameLanguage(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return true;
  if (x === y) return true;
  return x.split(/[-_]/)[0] === y.split(/[-_]/)[0];
}

/**
 * True when a cached record is filed under a language key that disagrees with
 * the document's own language (a poisoned record): skipped on read so the
 * cache heals itself; the next transcribe overwrites the bad keys.
 */
function isPoisonedCacheRecord(key: string, docLanguage: string | undefined): boolean {
  const keyLang = cacheKeyLanguage(key);
  if (!keyLang) return false;
  return !sameLanguage(keyLang, docLanguage ?? "");
}

function resolveTranscribeLookupKeys(
  providerSource: string,
  cacheLangKey: string,
  lang: string,
  requestedAuto: boolean
): string[] {
  if (requestedAuto) {
    // Auto-detection accepts whatever the transcript's language is; `auto` and
    // `latest` always point at the most recent transcript. An explicit provider
    // reads only its own auto record so providers never share transcripts.
    return providerSource !== "builtin"
      ? [cacheLangKey]
      : ["auto", "latest", cacheLangKey, "tr", "en", "deepgram:tr", "deepgram:en", "local:tr", "local:en"];
  }
  // An explicit language searches only that language's keys; generic keys are
  // never consulted, so another language's record cannot leak in.
  return providerSource !== "builtin"
    ? [cacheLangKey]
    : [cacheLangKey, lang, `local:${lang}`];
}

export async function transcribeLibraryAsset(options: {
  workspaceDir: string;
  handle: string;
  language?: string;
  provider?: string;
  keyterms?: string[];
  refresh?: boolean;
}): Promise<TranscribeResult> {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  loadDotEnvIfNeeded(paths.rootDir);
  const item = sequence.library.find((x) => x.handle === options.handle);
  if (!item) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.handle));
  }
  if (!item.probe.has_audio) {
    throw new CutholError(DIAGNOSTICS.NO_AUDIO_STREAM(options.handle));
  }

  const lang = (options.language ?? "auto").toLowerCase();
  const requestedAuto = lang === "auto";
  const resolvedProvider = resolveAsrProvider({
    workspaceDir: options.workspaceDir,
    explicit: options.provider,
  });
  const provider: AsrProviderId = resolvedProvider.id;
  const extProviderName = extensionNameOf(provider);
  // Extension transcripts are keyed by provider identity + version + content hash, so the
  // same file transcribed by different providers keeps separate cache records.
  const providerKeyPrefix =
    extProviderName !== null
      ? providerCacheTag(
          resolveExtensionProvider({
            extensionName: extProviderName,
            kind: "asr",
            workspaceDir: options.workspaceDir,
          }).extension
        )
      : provider;
  const cacheLangKey = `${providerKeyPrefix}:${lang}`;

  const ledger = new MediaLedger(paths.ledgerFile);

  try {
    let doc: TranscriptDocument | null = null;
    if (!options.refresh) {
      const lookupKeys = resolveTranscribeLookupKeys(
        resolvedProvider.source,
        cacheLangKey,
        lang,
        requestedAuto
      );
      for (const k of lookupKeys) {
        const candidate = ledger.getTranscript<TranscriptDocument>(item.digest_sha256, k);
        if (!candidate) continue;
        if (isPoisonedCacheRecord(k, candidate.language)) continue;
        doc = candidate;
        break;
      }
    }
    let wasCached = Boolean(doc);

    if (doc) {
      // Re-key a cache hit only under the document's own real language, never
      // under the requested one when they differ.
      const hitLang = (doc.language ?? "").trim().toLowerCase();
      if (hitLang && hitLang !== "auto" && hitLang !== "latest") {
        ledger.setTranscript(item.digest_sha256, hitLang, doc);
      }
    } else {
      wasCached = false;
      // Pre-compute acoustic 25ms-window silence intervals so ASR word tails stretched across silent pauses are clamped accurately
      let acousticSilenceIntervals: Array<{ start_ms: number; end_ms: number; duration_ms: number }> = [];
      try {
        const wave = analyzeAssetWaveform({
          workspaceDir: options.workspaceDir,
          handle: item.handle,
          bins: 160,
        });
        acousticSilenceIntervals = wave.silence_intervals;
      } catch {
        // ignore if waveform fails
      }

      const absMediaPath = resolveLibraryItemPath(paths.rootDir, item);

      if (extProviderName !== null) {
        doc = (
          await transcribeWithExtensionProvider({
            workspaceDir: options.workspaceDir,
            extensionName: extProviderName,
            audioFilePath: absMediaPath,
            language: lang,
            durationMs: item.probe.duration_ms,
            keyterms: options.keyterms,
          })
        ).doc;
      } else if (provider === "local") {
        doc = await transcribeWithLocalProvider({
          audioFilePath: absMediaPath,
          language: lang,
          durationMs: item.probe.duration_ms,
        });
      } else {
        // Extract clean 16 kHz mono WAV into `.cuthol/blobs/` for fast upload to Deepgram
        const wavForAsr = path.join(paths.blobsDir, `asr_input_${item.digest_sha256.slice(0, 12)}.wav`);
        const hasValidWav =
          fs.existsSync(wavForAsr) &&
          (() => {
            try {
              return fs.statSync(wavForAsr).size > 44;
            } catch {
              return false;
            }
          })();

        if (!hasValidWav) {
          const tmpWav = `${wavForAsr}.tmp.${process.pid}.wav`;
          const proc = spawnSync(
            "ffmpeg",
            [
              "-y",
              "-v",
              "error",
              "-i",
              absMediaPath,
              "-vn",
              "-af",
              "aresample=async=1:first_pts=0",
              "-ac",
              "1",
              "-ar",
              "16000",
              "-c:a",
              "pcm_s16le",
              tmpWav,
            ],
            { encoding: "utf8", windowsHide: true }
          );
          const tmpOk =
            proc.status === 0 &&
            fs.existsSync(tmpWav) &&
            (() => {
              try {
                return fs.statSync(tmpWav).size > 44;
              } catch {
                return false;
              }
            })();

          if (!tmpOk) {
            try {
              if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
            } catch {
              // ignore cleanup error
            }
            throw new CutholError(
              DIAGNOSTICS.EXTERNAL_TOOL_FAILED("ffmpeg asr audio extract", (proc.stderr || "").slice(-300))
            );
          }
          fs.renameSync(tmpWav, wavForAsr);
        }

        doc = await transcribeWithDeepgram({
          audioFilePath: wavForAsr,
          language: lang,
          durationMs: item.probe.duration_ms,
          keyterms: options.keyterms,
        });
      }

      // Clamp word & disfluency timestamps to [0, item.probe.duration_ms]
      const maxDurMs = item.probe.duration_ms;
      doc.words = doc.words
        .filter((w) => w.source_start_ms < maxDurMs)
        .map((w) => {
          const st = Math.max(0, Math.min(maxDurMs - 1, w.source_start_ms));
          const en = Math.max(st + 1, Math.min(maxDurMs, w.source_end_ms));
          return { ...w, source_start_ms: st, source_end_ms: en };
        });
      doc.disfluencies = doc.disfluencies
        .filter((d) => d.source_start_ms < maxDurMs)
        .map((d) => {
          const st = Math.max(0, Math.min(maxDurMs - 1, d.source_start_ms));
          const en = Math.max(st + 1, Math.min(maxDurMs, d.source_end_ms));
          return { ...d, source_start_ms: st, source_end_ms: en, duration_ms: en - st };
        });

      // Fuse acoustic 25ms-window silence intervals into doc.disfluencies so silent pauses
      // absorbed into stretched ASR word `end` timestamps are detected reliably without ever
      // overlapping or truncating spoken words.
      const minPauseMs = OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_MIN_PAUSE_MS;
      for (const sil of acousticSilenceIntervals) {
        for (let wi = 0; wi < doc.words.length; wi++) {
          const w = doc.words[wi];
          const nextW = wi + 1 < doc.words.length ? doc.words[wi + 1] : null;
          const nextStartsAfterSilStart =
            !nextW || nextW.source_start_ms >= sil.start_ms + minPauseMs * 0.5;
          if (
            w.source_start_ms <= sil.start_ms - 80 &&
            w.source_end_ms > sil.start_ms + 60 &&
            nextStartsAfterSilStart
          ) {
            const oldEnd = w.source_end_ms;
            w.source_end_ms = Math.max(w.source_start_ms + 80, sil.start_ms);
            for (const d of doc.disfluencies) {
              if (
                d.kind === "pause" &&
                (d.source_start_ms === oldEnd ||
                  (nextW && d.source_end_ms === nextW.source_start_ms && d.source_start_ms > w.source_end_ms))
              ) {
                d.source_start_ms = w.source_end_ms;
                d.duration_ms = d.source_end_ms - d.source_start_ms;
              }
            }
          }
        }

        // Subtract all ASR word intervals from [sil.start_ms, sil.end_ms] so acoustic pause
        // candidates never overlap spoken words
        let freeSegments: Array<{ start_ms: number; end_ms: number }> = [
          {
            start_ms: Math.max(0, Math.min(maxDurMs - 1, sil.start_ms)),
            end_ms: Math.max(1, Math.min(maxDurMs, sil.end_ms)),
          },
        ];
        for (const w of doc.words) {
          const nextSegments: Array<{ start_ms: number; end_ms: number }> = [];
          for (const seg of freeSegments) {
            if (w.source_end_ms <= seg.start_ms || w.source_start_ms >= seg.end_ms) {
              nextSegments.push(seg);
            } else {
              if (w.source_start_ms > seg.start_ms) {
                nextSegments.push({ start_ms: seg.start_ms, end_ms: w.source_start_ms });
              }
              if (w.source_end_ms < seg.end_ms) {
                nextSegments.push({ start_ms: w.source_end_ms, end_ms: seg.end_ms });
              }
            }
          }
          freeSegments = nextSegments;
        }

        for (const seg of freeSegments) {
          const dur = seg.end_ms - seg.start_ms;
          if (dur < minPauseMs) continue;
          const overlappingPause = doc.disfluencies.find(
            (d) =>
              d.kind === "pause" &&
              Math.min(d.source_end_ms, seg.end_ms) - Math.max(d.source_start_ms, seg.start_ms) >=
                dur * 0.5
          );
          if (overlappingPause) {
            overlappingPause.source_start_ms = Math.min(overlappingPause.source_start_ms, seg.start_ms);
            overlappingPause.source_end_ms = Math.max(overlappingPause.source_end_ms, seg.end_ms);
            overlappingPause.duration_ms =
              overlappingPause.source_end_ms - overlappingPause.source_start_ms;
          } else {
            doc.disfluencies.push({
              kind: "pause",
              source_start_ms: seg.start_ms,
              source_end_ms: seg.end_ms,
              duration_ms: dur,
              label: `<acoustic_pause ${dur}ms>`,
            });
          }
        }
      }
      doc.disfluencies.sort((a, b) => a.source_start_ms - b.source_start_ms);

      const detectedRaw = (doc.language ?? "").trim().toLowerCase();
      if (requestedAuto && (!detectedRaw || detectedRaw === "auto")) {
        throw new CutholError(DIAGNOSTICS.ASR_LANGUAGE_REQUIRED(provider));
      }
      const realLang = detectedRaw && detectedRaw !== "auto" ? detectedRaw : lang;
      ledger.setTranscript(item.digest_sha256, `${providerKeyPrefix}:${realLang}`, doc);
      ledger.setTranscript(item.digest_sha256, realLang, doc);
      ledger.setTranscript(item.digest_sha256, "auto", doc);
      ledger.setTranscript(item.digest_sha256, "latest", doc);
      if (requestedAuto) {
        // The provider's own latest auto detection, so an explicit provider
        // hits its own auto cache without ever reading another provider's.
        ledger.setTranscript(item.digest_sha256, cacheLangKey, doc);
      }
    }

    const refId = `asr_${item.digest_sha256.slice(0, 8)}`;
    const current = sequence.library.find((x) => x.handle === item.handle);
    if (current && current.analysis_refs.transcript !== refId) {
      commitSequenceMutation(options.workspaceDir, `speech.transcribe(${item.handle})`, (seq) => {
        const target = seq.library.find((x) => x.handle === item.handle);
        if (target) {
          target.analysis_refs.transcript = refId;
        }
      });
    }

    const latestSeq = loadSequence(options.workspaceDir).sequence;
    const projectedWords = projectTranscriptAcrossSequence(latestSeq, item.handle, doc.words);

    return {
      handle: item.handle,
      sha256: item.digest_sha256,
      cached: wasCached,
      transcript: doc,
      projected_sequence_words: projectedWords,
    };
  } finally {
    ledger.close();
  }
}

export function loadCachedTranscriptForAsset(
  workspaceDir: string,
  handle: string,
  language = "auto"
): TranscriptDocument {
  const { paths, sequence } = loadSequence(workspaceDir);
  const item = sequence.library.find((x) => x.handle === handle);
  if (!item) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(handle));
  }

  const normLang = language.toLowerCase();
  const ledger = new MediaLedger(paths.ledgerFile);
  try {
    // Downstream readers prefer the requested language but stay lenient: any
    // recorded transcript of the asset is usable dialogue data. Poisoned
    // records (key language vs doc.language mismatch) are skipped everywhere.
    const candidateKeys =
      normLang === "auto"
        ? ["latest", "auto", "tr", "en", "deepgram:tr", "deepgram:en", "local:tr", "local:en"]
        : [
            normLang,
            `deepgram:${normLang}`,
            `local:${normLang}`,
            "latest",
            "auto",
            "en",
            "tr",
            "deepgram:en",
            "local:en",
          ];

    for (const key of candidateKeys) {
      const candidate = ledger.getTranscript<TranscriptDocument>(item.digest_sha256, key);
      if (!candidate) continue;
      if (isPoisonedCacheRecord(key, candidate.language)) continue;
      return candidate;
    }

    throw new CutholError(DIAGNOSTICS.TRANSCRIPT_NOT_FOUND(handle));
  } finally {
    ledger.close();
  }
}
