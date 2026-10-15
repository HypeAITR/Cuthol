/**
 * Cuthol Speech Transcription Service (`src/speech/transcribe.ts`).
 *
 * Uses content-addressed `.cuthol/ledger.sqlite` (`transcript_cache`) so identical media
 * assets are never transcribed twice. Supports both cloud (`deepgram` Nova-3) and
 * pluggable `local` providers.
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

export interface TranscribeResult {
  handle: string;
  sha256: string;
  cached: boolean;
  transcript: TranscriptDocument;
  projected_sequence_words: TimedWordToken[];
}

export async function transcribeLibraryAsset(options: {
  workspaceDir: string;
  handle: string;
  language?: string;
  provider?: AsrProviderId;
  keyterms?: string[];
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

  const lang = (options.language ?? "tr").toLowerCase();
  const provider: AsrProviderId = options.provider ?? "deepgram";
  const cacheLangKey = `${provider}:${lang}`;

  const ledger = new MediaLedger(paths.ledgerFile);

  try {
    const lookupKeys =
      options.provider !== undefined
        ? lang === "auto"
          ? [cacheLangKey, "auto", "latest", lang]
          : [cacheLangKey, lang]
        : lang === "auto"
          ? [cacheLangKey, "auto", "latest", "tr", "en", "deepgram:tr", "deepgram:en", "local:tr", "local:en"]
          : [cacheLangKey, lang, `deepgram:${lang}`, `local:${lang}`, "auto", "latest"];

    let doc: TranscriptDocument | null = null;
    for (const k of lookupKeys) {
      doc = ledger.getTranscript<TranscriptDocument>(item.digest_sha256, k);
      if (doc) break;
    }
    let wasCached = Boolean(doc);

    if (doc) {
      // Ensure canonical keys are populated in both project and shared ledgers
      ledger.setTranscript(item.digest_sha256, cacheLangKey, doc);
      ledger.setTranscript(item.digest_sha256, lang, doc);
      ledger.setTranscript(item.digest_sha256, "auto", doc);
      ledger.setTranscript(item.digest_sha256, "latest", doc);
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

      if (provider === "local") {
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
            { encoding: "utf8" }
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

      ledger.setTranscript(item.digest_sha256, cacheLangKey, doc);
      // Also store under bare language key and canonical latest/auto keys so downstream lookups find it reliably
      ledger.setTranscript(item.digest_sha256, lang, doc);
      ledger.setTranscript(item.digest_sha256, "auto", doc);
      ledger.setTranscript(item.digest_sha256, "latest", doc);
      const detectedLang = doc.language?.toLowerCase();
      if (detectedLang && detectedLang !== lang) {
        ledger.setTranscript(item.digest_sha256, detectedLang, doc);
        ledger.setTranscript(item.digest_sha256, `${provider}:${detectedLang}`, doc);
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
  language = "tr"
): TranscriptDocument {
  const { paths, sequence } = loadSequence(workspaceDir);
  const item = sequence.library.find((x) => x.handle === handle);
  if (!item) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(handle));
  }

  const normLang = language.toLowerCase();
  const ledger = new MediaLedger(paths.ledgerFile);
  try {
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

    let doc: TranscriptDocument | null = null;
    for (const key of candidateKeys) {
      doc = ledger.getTranscript<TranscriptDocument>(item.digest_sha256, key);
      if (doc) break;
    }

    if (!doc) {
      throw new CutholError(DIAGNOSTICS.TRANSCRIPT_NOT_FOUND(handle));
    }
    return doc;
  } finally {
    ledger.close();
  }
}
