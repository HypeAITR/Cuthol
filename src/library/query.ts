/**
 * Cuthol Progressive Disclosure Digest Formatter & Paginated Media Query Engine
 * (`src/library/query.ts`).
 *
 * Implements progressive disclosure for time-series analysis:
 * - Default CLI/MCP responses for time-series commands (`transcribe`, `captions`, `waveform`,
 *   `beats`, `scenes`) return a ~250-token `digest` (`counts`, `stats`, up to 6 `preview` items,
 *   `attention` spans, and runnable `query_hints`) instead of dumping hundreds of array entries.
 * - `queryLibraryAnalysis` (`cuthol library query`) lets the agent slice by `--range`, `--text`,
 *   `--limit`, `--cursor`, and `--max-tokens`.
 */

import fs from "node:fs";
import { resolveCueStartMs } from "../core/timeline.js";
import { normTurkish } from "../compositor/cuthol_runtime.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { parseTimeMs } from "../core/time.js";
import { loadSequence } from "../core/workspace.js";
import { GenerateCaptionsResult } from "../speech/captions.js";
import { TranscriptDocument } from "../speech/providers.js";
import { TranscribeResult } from "../speech/transcribe.js";
import { BeatAnalysisResult } from "./beats.js";
import { MediaLedger } from "./ledger.js";
import { SceneAnalysisResult } from "./scenes.js";
import { WaveformAnalysisResult } from "./waveform.js";

export type QueryableMediaKind = "transcript" | "beats" | "waveform" | "scenes" | "captions";

export interface MediaDigestEnvelope {
  kind: QueryableMediaKind;
  handle: string;
  duration_ms: number;
  counts: Record<string, number>;
  stats: Record<string, number | string>;
  preview: {
    strategy: string;
    items: unknown[];
  };
  attention: Array<{ span: [number, number]; reason: string; note?: string }>;
  query_hints: string[];
}

export interface MediaQueryResult {
  ok: true;
  handle: string;
  kind: QueryableMediaKind;
  matched: number;
  returned: number;
  truncated: boolean;
  truncated_by: "limit" | "max_tokens" | null;
  next_cursor: string | null;
  tokens_est: number;
  items: unknown[];
  hint: string | null;
}

function sampleUpTo<T>(arr: T[], maxItems = 6): T[] {
  if (arr.length <= maxItems) return arr;
  const out: T[] = [];
  for (let i = 0; i < maxItems; i++) {
    const idx = Math.min(arr.length - 1, Math.floor((i * (arr.length - 1)) / Math.max(1, maxItems - 1)));
    out.push(arr[idx]);
  }
  return out;
}

export function formatTranscribeDigest(res: TranscribeResult): {
  handle: string;
  sha256: string;
  cached: boolean;
  digest: MediaDigestEnvelope;
} {
  const doc = res.transcript;
  const words = doc.words ?? [];
  const lowConf = words.filter((w) => w.confidence < 0.75);
  const pauses = doc.disfluencies.filter((d) => d.kind === "pause");
  const fillers = doc.disfluencies.filter((d) => d.kind === "filler" || d.kind === "repetition");
  const wpm =
    doc.duration_ms > 0 ? Math.round((words.length / (doc.duration_ms / 1000)) * 60) : 0;

  const attention: MediaDigestEnvelope["attention"] = [];
  for (const p of pauses.slice(0, 4)) {
    attention.push({
      span: [p.source_start_ms, p.source_end_ms],
      reason: "LONG_PAUSE",
      note: `${p.duration_ms}ms duraksama`,
    });
  }
  for (const lc of lowConf.slice(0, 3)) {
    attention.push({
      span: [lc.source_start_ms, lc.source_end_ms],
      reason: "LOW_CONFIDENCE",
      note: `'${lc.word}' (conf=${lc.confidence.toFixed(2)})`,
    });
  }

  return {
    handle: res.handle,
    sha256: res.sha256,
    cached: res.cached,
    digest: {
      kind: "transcript",
      handle: res.handle,
      duration_ms: doc.duration_ms,
      counts: {
        words: words.length,
        projected_sequence_words: res.projected_sequence_words.filter((w) => !w.excised).length,
        pauses: pauses.length,
        fillers: fillers.length,
      },
      stats: {
        provider: doc.provider,
        language: doc.language,
        wpm,
        text_preview: doc.text.slice(0, 180),
      },
      preview: {
        strategy: "evenly_spaced",
        items: (() => {
          const activeProjected = res.projected_sequence_words.filter((w) => !w.excised);
          if (activeProjected.length > 0) {
            return sampleUpTo(
              activeProjected.map((w) => ({
                word: w.word,
                source_ms: [w.source_start_ms, w.source_end_ms],
                sequence_ms: [w.sequence_start_ms, w.sequence_end_ms],
              })),
              6
            );
          }
          return sampleUpTo(
            words.map((w) => ({
              word: w.punctuated_word || w.word,
              source_ms: [w.source_start_ms, w.source_end_ms],
              sequence_ms: null,
            })),
            6
          );
        })(),
      },
      attention,
      query_hints: [
        `cuthol library query --handle ${res.handle} --kind transcript --range 0s..5s`,
        `cuthol library query --handle ${res.handle} --kind transcript --text "<aranan_kelime>"`,
        `cuthol speech transcribe --handle ${res.handle} --verbose`,
      ],
    },
  };
}

export function formatCaptionsDigest(
  res: GenerateCaptionsResult,
  sequence?: CutholSequence
): {
  style: GenerateCaptionsResult["style"];
  cues_created: number;
  skipped_excised_words: number;
  revision: number;
  decision_trace: GenerateCaptionsResult["decision_trace"];
  verification: GenerateCaptionsResult["verification"];
  digest: MediaDigestEnvelope;
} {
  const cues = res.cues;
  const resolveAt = (c: (typeof cues)[number]): number =>
    sequence ? resolveCueStartMs(sequence, c) : c.at_ms;
  const durationMs = cues.reduce(
    (max, c) => Math.max(max, resolveAt(c) + c.duration_ms),
    0
  );

  return {
    style: res.style,
    cues_created: res.cues_created,
    skipped_excised_words: res.skipped_excised_words,
    revision: res.revision,
    decision_trace: res.decision_trace,
    verification: res.verification,
    digest: {
      kind: "captions",
      handle: "ln_captions",
      duration_ms: durationMs,
      counts: {
        cues_created: res.cues_created,
        skipped_excised_words: res.skipped_excised_words,
      },
      stats: {
        style: res.style,
        mean_cps: res.decision_trace.summary.effect.mean_cps ?? 0,
      },
      preview: {
        strategy: "evenly_spaced",
        items: sampleUpTo(
          cues.map((c) => ({
            id: c.id,
            at_ms: resolveAt(c),
            duration_ms: c.duration_ms,
            text: c.typography?.text ?? "",
          })),
          6
        ),
      },
      attention: res.decision_trace.near_misses.slice(0, 5).map((nm) => ({
        span: nm.span,
        reason: nm.reason_code,
        note: `id=${nm.id} cps=${nm.measured?.cps ?? ""}`,
      })),
      query_hints: [
        `cuthol library query --handle ln_captions --kind captions --range 0s..10s`,
        `cuthol brief --lens detail --id ${cues[0]?.id ?? "cue_01"}`,
      ],
    },
  };
}

export function formatWaveformDigest(res: WaveformAnalysisResult): {
  handle: string;
  sha256: string;
  duration_ms: number;
  peak_dbfs: number;
  rms_dbfs: number;
  spectral_summary: WaveformAnalysisResult["spectral_summary"];
  silence_intervals: WaveformAnalysisResult["silence_intervals"];
  png_path?: string;
  digest: MediaDigestEnvelope;
} {
  return {
    handle: res.handle,
    sha256: res.sha256,
    duration_ms: res.duration_ms,
    peak_dbfs: res.peak_dbfs,
    rms_dbfs: res.rms_dbfs,
    spectral_summary: res.spectral_summary,
    silence_intervals: res.silence_intervals,
    ...(res.png_path ? { png_path: res.png_path } : {}),
    digest: {
      kind: "waveform",
      handle: res.handle,
      duration_ms: res.duration_ms,
      counts: {
        bins: res.bins_count,
        silence_intervals: res.silence_intervals.length,
      },
      stats: {
        peak_dbfs: res.peak_dbfs,
        rms_dbfs: res.rms_dbfs,
        low_pct: res.spectral_summary.low_20_250hz_pct,
        mid_pct: res.spectral_summary.mid_250_4000hz_pct,
        high_pct: res.spectral_summary.high_4000_8000hz_pct,
      },
      preview: {
        strategy: "evenly_spaced",
        items: sampleUpTo(res.bins, 6),
      },
      attention: res.silence_intervals.slice(0, 5).map((s) => ({
        span: [s.start_ms, s.end_ms],
        reason: "SILENCE_INTERVAL",
        note: `${s.duration_ms}ms sessizlik`,
      })),
      query_hints: [
        `cuthol library query --handle ${res.handle} --kind waveform --range 0s..5s`,
        `cuthol library waveform --handle ${res.handle} --verbose`,
      ],
    },
  };
}

export function formatBeatsDigest(res: BeatAnalysisResult): {
  handle: string;
  sha256: string;
  duration_ms: number;
  estimated_bpm: number;
  grid_bpm: number;
  phase_ms: number;
  beat_period_ms: number;
  grid_count: number;
  onsets_count: number;
  beats_count: number;
  tempo_resolution?: BeatAnalysisResult["tempo_resolution"];
  digest: MediaDigestEnvelope & {
    grid: {
      bpm: number;
      phase_ms: number;
      beat_period_ms: number;
      count: number;
      preview_ms: number[];
    };
    onsets: {
      sensitivity: number;
      count: number;
      preview: BeatAnalysisResult["onsets"];
    };
  };
} {
  const gridMs = res.grid_ms ?? res.beats_ms ?? [];
  const onsets =
    res.onsets ??
    (res.onsets_ms ?? res.beats_ms ?? []).map((t) => ({ time_ms: t, strength: 1.0 }));
  const gridBpm = res.grid_bpm ?? res.estimated_bpm;
  const phaseMs = res.phase_ms ?? (gridMs[0] ?? 0);
  const periodMs =
    res.beat_period_ms ?? (gridBpm > 0 ? Number((60_000 / gridBpm).toFixed(2)) : 0);

  return {
    handle: res.handle,
    sha256: res.sha256,
    duration_ms: res.duration_ms,
    estimated_bpm: res.estimated_bpm,
    grid_bpm: gridBpm,
    phase_ms: phaseMs,
    beat_period_ms: periodMs,
    grid_count: gridMs.length,
    onsets_count: onsets.length,
    beats_count: res.beats_count,
    ...(res.tempo_resolution ? { tempo_resolution: res.tempo_resolution } : {}),
    digest: {
      kind: "beats",
      handle: res.handle,
      duration_ms: res.duration_ms,
      counts: {
        grid_beats: gridMs.length,
        onsets: onsets.length,
        beats: res.beats_count,
      },
      stats: {
        estimated_bpm: res.estimated_bpm,
        grid_bpm: gridBpm,
        phase_ms: phaseMs,
        beat_period_ms: periodMs,
        sensitivity: res.sensitivity,
        ...(res.tempo_resolution ? { tempo_resolution: res.tempo_resolution.resolution } : {}),
      },
      grid: {
        bpm: gridBpm,
        phase_ms: phaseMs,
        beat_period_ms: periodMs,
        count: gridMs.length,
        preview_ms: gridMs.slice(0, 8),
      },
      onsets: {
        sensitivity: res.sensitivity,
        count: onsets.length,
        preview: onsets.slice(0, 8),
      },
      preview: {
        strategy: "grid_and_onsets_head",
        items: [
          {
            kind: "grid",
            bpm: gridBpm,
            phase_ms: phaseMs,
            beat_period_ms: periodMs,
            count: gridMs.length,
            head_ms: gridMs.slice(0, 8),
          },
          {
            kind: "onsets",
            sensitivity: res.sensitivity,
            count: onsets.length,
            head: onsets.slice(0, 8),
          },
        ],
      },
      attention:
        res.tempo_resolution && res.tempo_resolution.resolution !== "in_range"
          ? [
              {
                span: [0, res.duration_ms],
                reason: "TEMPO_RESOLUTION",
                note: res.tempo_resolution.note,
              },
            ]
          : [],
      query_hints: [
        `cuthol library query --handle ${res.handle} --kind beats --range 0s..10s`,
        `cuthol library query --handle ${res.handle} --kind beats --text onset --range 0s..10s`,
        `cuthol library beats --handle ${res.handle} --verbose`,
      ],
    },
  };
}

export function formatScenesDigest(res: SceneAnalysisResult): {
  handle: string;
  sha256: string;
  duration_ms: number;
  threshold: number;
  cuts_count: number;
  segments_ms: SceneAnalysisResult["segments_ms"];
  digest: MediaDigestEnvelope;
} {
  return {
    handle: res.handle,
    sha256: res.sha256,
    duration_ms: res.duration_ms,
    threshold: res.threshold,
    cuts_count: res.cuts_count,
    segments_ms: res.segments_ms,
    digest: {
      kind: "scenes",
      handle: res.handle,
      duration_ms: res.duration_ms,
      counts: {
        cuts: res.cuts_count,
        segments: res.segments_ms.length,
      },
      stats: {
        threshold: res.threshold,
      },
      preview: {
        strategy: "head",
        items: res.cuts.slice(0, 6),
      },
      attention: res.cuts.slice(0, 5).map((c) => ({
        span: [c.time_ms, c.time_ms],
        reason: "SCENE_CUT",
        note: `score=${c.score.toFixed(1)}`,
      })),
      query_hints: [
        `cuthol library query --handle ${res.handle} --kind scenes --range 0s..10s`,
        `cuthol library scenes --handle ${res.handle} --verbose`,
      ],
    },
  };
}

function parseRangeWindowMs(rawRange?: string): [number, number] | null {
  if (!rawRange || !rawRange.trim()) return null;
  const trimmed = rawRange.trim();
  const parts = trimmed.includes("..") ? trimmed.split("..") : trimmed.split("-");
  if (parts.length !== 2) {
    throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(rawRange));
  }
  const leftStr = parts[0].trim();
  const rightStr = parts[1].trim();
  if (!leftStr && !rightStr) {
    throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(rawRange));
  }
  const start = leftStr ? parseTimeMs(leftStr) : 0;
  const end = rightStr ? parseTimeMs(rightStr) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(start) || Number.isNaN(end) || end < start) {
    throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(rawRange));
  }
  return [start, end];
}

function overlapsRangeWindow(startMs: number, endMs: number, rangeWin: [number, number]): boolean {
  if (rangeWin[0] === rangeWin[1]) {
    return endMs >= rangeWin[0] && startMs <= rangeWin[1];
  }
  return endMs > rangeWin[0] && startMs < rangeWin[1];
}

export function queryLibraryAnalysis(options: {
  workspaceDir: string;
  handle: string;
  kind?: QueryableMediaKind;
  format?: "default" | "compact";
  range?: string;
  text?: string;
  limit?: number;
  cursor?: string;
  maxTokens?: number;
}): MediaQueryResult {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const kind: QueryableMediaKind =
    options.kind ?? (options.handle === "ln_captions" ? "captions" : "transcript");
  const isCompactTranscript = kind === "transcript" && options.format === "compact";
  const rangeWin = parseRangeWindowMs(options.range);
  const textQuery = options.text ? normTurkish(options.text) : null;
  const defaultLimit = isCompactTranscript ? 600 : 40;
  const maxAllowedLimit = isCompactTranscript ? 2000 : 200;
  const rawLimit =
    options.limit !== undefined && Number.isFinite(options.limit) ? options.limit : defaultLimit;
  const limit = Math.max(1, Math.min(maxAllowedLimit, Math.floor(rawLimit)));

  let offset = 0;
  if (options.cursor !== undefined && options.cursor.trim() !== "") {
    const trimmedCursor = options.cursor.trim();
    if (!/^\d+$/.test(trimmedCursor)) {
      throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(`cursor=${options.cursor}`));
    }
    offset = parseInt(trimmedCursor, 10);
  }

  const rawMaxTokens =
    options.maxTokens !== undefined && Number.isFinite(options.maxTokens)
      ? options.maxTokens
      : 2000;
  const maxTokens = Math.max(100, Math.min(8000, Math.floor(rawMaxTokens)));

  let matchedItems: unknown[] = [];

  if (kind === "captions") {
    const capCues = sequence.lanes
      .filter((l) => l.kind === "caption" || l.id === options.handle)
      .flatMap((l) => l.cues);
    matchedItems = capCues
      .filter((c) => {
        const start = resolveCueStartMs(sequence, c);
        const end = start + c.duration_ms;
        if (rangeWin && !overlapsRangeWindow(start, end, rangeWin)) return false;
        if (textQuery) {
          const normTxt = normTurkish(c.typography?.text ?? "");
          if (!normTxt.includes(textQuery)) return false;
        }
        return true;
      })
      .map((c) => ({
        id: c.id,
        at_ms: resolveCueStartMs(sequence, c),
        duration_ms: c.duration_ms,
        text: c.typography?.text ?? "",
        words_count: c.typography?.words?.length ?? 0,
      }));
  } else {
    const asset = sequence.library.find((a) => a.handle === options.handle);
    if (!asset) {
      throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.handle));
    }
    if (!fs.existsSync(paths.ledgerFile)) {
      throw new CutholError(DIAGNOSTICS.MISSING_FILE_ON_DISK("ledger", paths.ledgerFile));
    }

    const ledger = new MediaLedger(paths.ledgerFile);
    try {
      if (kind === "transcript") {
        const doc = ledger.getLatestTranscript<TranscriptDocument>(asset.digest_sha256);
        const words = doc?.words ?? [];
        const queryTokens = textQuery ? textQuery.split(/\s+/).filter(Boolean) : [];
        const matchedWordIndices = new Set<number>();

        if (queryTokens.length <= 1) {
          const singleToken = queryTokens[0] ?? null;
          for (let i = 0; i < words.length; i++) {
            const w = words[i];
            const normWord = normTurkish(w.punctuated_word || w.word);
            if (!singleToken || normWord.includes(singleToken)) {
              matchedWordIndices.add(i);
            }
          }
        } else {
          const winLen = queryTokens.length;
          for (let i = 0; i <= words.length - winLen; i++) {
            let allMatch = true;
            for (let k = 0; k < winLen; k++) {
              const normW = normTurkish(words[i + k].punctuated_word || words[i + k].word);
              if (!normW.includes(queryTokens[k])) {
                allMatch = false;
                break;
              }
            }
            if (allMatch) {
              for (let k = 0; k < winLen; k++) {
                matchedWordIndices.add(i + k);
              }
            }
          }
        }

        const filteredWords = words
          .map((w, originalIdx) => ({
            index: originalIdx,
            word: w.punctuated_word || w.word,
            source_start_ms: w.source_start_ms,
            source_end_ms: w.source_end_ms,
            confidence: w.confidence,
          }))
          .filter((item) => {
            if (
              rangeWin &&
              !overlapsRangeWindow(item.source_start_ms, item.source_end_ms, rangeWin)
            ) {
              return false;
            }
            if (textQuery && !matchedWordIndices.has(item.index)) {
              return false;
            }
            return true;
          });

        matchedItems = isCompactTranscript
          ? filteredWords.map(
              (item) =>
                `${item.index}:${item.word}@${Number((item.source_start_ms / 1000).toFixed(2))}`
            )
          : filteredWords;
      } else if (kind === "beats") {
        const beats = ledger.getLatestBeats<BeatAnalysisResult>(asset.digest_sha256);
        if (textQuery && (textQuery.includes("onset") || textQuery.includes("transient"))) {
          const onsetList =
            beats?.onsets ??
            (beats?.onsets_ms ?? beats?.beats_ms ?? []).map((t) => ({
              time_ms: t,
              strength: 1.0,
            }));
          matchedItems = onsetList
            .map((o, originalIdx) => ({
              index: originalIdx,
              kind: "onset",
              beat_ms: o.time_ms,
              time_ms: o.time_ms,
              strength: o.strength,
            }))
            .filter((b) => !rangeWin || (b.beat_ms >= rangeWin[0] && b.beat_ms <= rangeWin[1]));
        } else {
          const beatList = beats?.grid_ms?.length ? beats.grid_ms : (beats?.beats_ms ?? []);
          const itemKind = beats?.grid_ms?.length ? "grid" : "onset";
          matchedItems = beatList
            .map((bMs, originalIdx) => ({ index: originalIdx, kind: itemKind, beat_ms: bMs }))
            .filter((b) => !rangeWin || (b.beat_ms >= rangeWin[0] && b.beat_ms <= rangeWin[1]));
        }
      } else if (kind === "waveform") {
        const wave = ledger.getLatestWaveform<WaveformAnalysisResult>(asset.digest_sha256);
        const bins = wave?.bins ?? [];
        matchedItems = bins.filter(
          (b) => !rangeWin || overlapsRangeWindow(b.start_ms, b.end_ms, rangeWin)
        );
      } else if (kind === "scenes") {
        const sc = ledger.getLatestScenes<SceneAnalysisResult>(asset.digest_sha256);
        const cuts = sc?.cuts ?? [];
        matchedItems = cuts.filter(
          (c) => !rangeWin || (c.time_ms >= rangeWin[0] && c.time_ms <= rangeWin[1])
        );
      }
    } finally {
      ledger.close();
    }
  }

  // Apply pagination and token budget
  const sliced: unknown[] = [];
  let estTokens = 40;
  let truncatedBy: "limit" | "max_tokens" | null = null;
  let nextIdx = offset;

  while (nextIdx < matchedItems.length) {
    if (sliced.length >= limit) {
      truncatedBy = "limit";
      break;
    }
    const candidate = matchedItems[nextIdx];
    const minItemTokens = isCompactTranscript ? 1 : 4;
    const itemTokens = Math.max(minItemTokens, Math.ceil(JSON.stringify(candidate).length / 4));
    if (sliced.length > 0 && estTokens + itemTokens > maxTokens) {
      truncatedBy = "max_tokens";
      break;
    }
    sliced.push(candidate);
    estTokens += itemTokens;
    nextIdx++;
  }

  const hasMore = nextIdx < matchedItems.length;
  return {
    ok: true,
    handle: options.handle,
    kind,
    matched: matchedItems.length,
    returned: sliced.length,
    truncated: hasMore,
    truncated_by: hasMore ? truncatedBy : null,
    next_cursor: hasMore ? String(nextIdx) : null,
    tokens_est: estTokens,
    items: sliced,
    hint: hasMore
      ? `${matchedItems.length} öğeden ${sliced.length} tanesi döndü. Devamı için '--cursor ${nextIdx}' veya daha dar bir '--range' kullanın.`
      : null,
  };
}
