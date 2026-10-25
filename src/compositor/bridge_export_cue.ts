// Builds and writes the per-cue bridge data (`cuthol-data.js`/`.json`, vars, runtime) for one composition cue (split out of bridge_exporter.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveCueStartMs } from "../core/timeline.js";
import { CutholSequence, LaneCue, LibraryItem } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { WorkspacePaths } from "../core/workspace.js";
import { analyzeAssetBeats, BeatAnalysisResult } from "../library/beats.js";
import { MediaLedger } from "../library/ledger.js";
import { analyzeAssetWaveform, WaveformAnalysisResult } from "../library/waveform.js";
import { CUTHOL_BRIDGE_SCHEMA, CutholBridgeV1 } from "./cuthol_runtime.js";
import { compositionUsesAudio, compositionUsesGlobal } from "./bridge_hash.js";
import {
  compileLocalAudioEnvelope,
  compileLocalBeats,
  compileLocalCutsAndSegments,
  compileLocalWordsPausesSentences,
} from "./bridge_export_local.js";
import { compileGlobalBridgeSlice } from "./bridge_export_global.js";

export let isAutoAnalyzingInBridge = false;

export interface BridgeCueExportContext {
  seq: CutholSequence;
  cue: LaneCue;
  paths?: WorkspacePaths;
  cueStartMs: number;
  cueEndMs: number;
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  toLocalSec: (seqMs: number) => number;
  overlapsWindow: (startMs: number, endMs: number) => boolean;
  libMap: Map<string, LibraryItem>;
  usesAudio: boolean;
  usesGlobal: boolean;
  ledger: MediaLedger | null;
  localWaveCache: Map<string, WaveformAnalysisResult>;
  attemptedWaveDigests: Set<string>;
  failedAudioHandles: Set<string>;
  activeWindowAudioHandles: Set<string>;
  bridgeWarnings: string[];
  getOrAnalyzeWaveform: (
    asset: { handle: string; digest_sha256: string; probe: { has_audio: boolean } },
    allowAutoAnalyze: boolean
  ) => WaveformAnalysisResult | null;
  getOrAnalyzeBeats: (src: {
    handle: string;
    digest: string;
    isMusicLane: boolean;
  }) => BeatAnalysisResult | null;
}

function computeSafeZonePx(seq: CutholSequence): { x: number; y: number; w: number; h: number } {
  const W = seq.stage.width;
  const H = seq.stage.height;
  const marginPct = OPEN_STANDARDS.SAFE_ZONES.TITLE_MARGIN_PCT / 100;
  const leftPx = Math.round(W * marginPct);
  const topPx = Math.round(H * marginPct);
  let rightMarginPx = leftPx;
  let bottomMarginPx = topPx;

  if (seq.stage.aspect === "9:16") {
    rightMarginPx = Math.round(W * (OPEN_STANDARDS.SAFE_ZONES.VERTICAL_9_16_RIGHT_CHROME_PCT / 100));
    bottomMarginPx = Math.round(H * (OPEN_STANDARDS.SAFE_ZONES.VERTICAL_9_16_BOTTOM_CHROME_PCT / 100));
  }

  return {
    x: leftPx,
    y: topPx,
    w: Math.max(16, W - leftPx - rightMarginPx),
    h: Math.max(16, H - topPx - bottomMarginPx),
  };
}

function createBridgeCueExportContext(
  seq: CutholSequence,
  cue: LaneCue,
  paths?: WorkspacePaths
): BridgeCueExportContext {
  const cueStartMs = resolveCueStartMs(seq, cue);
  const cueEndMs = cueStartMs + cue.duration_ms;
  const durationSec = Number((cue.duration_ms / 1000).toFixed(4));
  const fps = seq.stage.fps;
  const width = seq.stage.width;
  const height = seq.stage.height;

  // Single conversion point from sequence_ms to composition-local seconds
  const toLocalSec = (seqMs: number): number => Number(((seqMs - cueStartMs) / 1000).toFixed(4));
  const overlapsWindow = (startMs: number, endMs: number): boolean =>
    endMs > cueStartMs && startMs < cueEndMs;

  const libMap = new Map(seq.library.map((item) => [item.handle, item]));
  const resolvedCompDir = cue.composition?.composition_dir
    ? paths && !path.isAbsolute(cue.composition.composition_dir)
      ? path.resolve(paths.rootDir, cue.composition.composition_dir)
      : path.resolve(cue.composition.composition_dir)
    : null;
  const entryHtmlName = cue.composition?.entry_html || "index.html";
  const usesAudio =
    cue.composition?.props?.preset === "audio_glow" ||
    (resolvedCompDir !== null && compositionUsesAudio(resolvedCompDir, entryHtmlName));
  const usesGlobal =
    resolvedCompDir !== null && compositionUsesGlobal(resolvedCompDir, entryHtmlName);

  const ledger =
    paths &&
    (fs.existsSync(paths.ledgerFile) ||
      (usesAudio && fs.existsSync(path.dirname(paths.ledgerFile))))
      ? new MediaLedger(paths.ledgerFile)
      : null;

  const localWaveCache = new Map<string, WaveformAnalysisResult>();
  const attemptedWaveDigests = new Set<string>();
  const failedAudioHandles = new Set<string>();
  const activeWindowAudioHandles = new Set<string>();
  const bridgeWarnings: string[] = [];

  const getOrAnalyzeWaveform = (
    asset: { handle: string; digest_sha256: string; probe: { has_audio: boolean } },
    allowAutoAnalyze: boolean
  ): WaveformAnalysisResult | null => {
    if (!asset.probe.has_audio) return null;
    const cachedMem = localWaveCache.get(asset.digest_sha256);
    if (cachedMem?.bins?.length) return cachedMem;

    let wave = ledger
      ? ledger.getLatestWaveform<WaveformAnalysisResult>(asset.digest_sha256)
      : null;
    if (wave?.bins?.length) {
      localWaveCache.set(asset.digest_sha256, wave);
      return wave;
    }

    if (
      !wave &&
      allowAutoAnalyze &&
      paths &&
      !isAutoAnalyzingInBridge &&
      !attemptedWaveDigests.has(asset.digest_sha256)
    ) {
      attemptedWaveDigests.add(asset.digest_sha256);
      try {
        isAutoAnalyzingInBridge = true;
        wave = analyzeAssetWaveform({
          workspaceDir: paths.rootDir,
          handle: asset.handle,
          bins: 160,
        });
        if (wave?.bins?.length) {
          localWaveCache.set(asset.digest_sha256, wave);
          return wave;
        }
        if (usesAudio) {
          failedAudioHandles.add(asset.handle);
        }
      } catch {
        if (usesAudio) {
          failedAudioHandles.add(asset.handle);
        }
      } finally {
        isAutoAnalyzingInBridge = false;
      }
    } else if (!wave && allowAutoAnalyze && attemptedWaveDigests.has(asset.digest_sha256) && usesAudio) {
      failedAudioHandles.add(asset.handle);
    }

    return wave?.bins?.length ? wave : null;
  };

  const getOrAnalyzeBeats = (src: {
    handle: string;
    digest: string;
    isMusicLane: boolean;
  }): BeatAnalysisResult | null => {
    if (!ledger) return null;
    let beatData = ledger.getLatestBeats<BeatAnalysisResult>(src.digest);
    // Auto-analyze beats on the fly when an explicit music lane cue (`ln_bgm`) has not been analyzed yet
    // or when an older cache entry lacks `grid_ms`.
    if (
      (!beatData || !Array.isArray(beatData.grid_ms)) &&
      src.isMusicLane &&
      paths &&
      !isAutoAnalyzingInBridge
    ) {
      try {
        isAutoAnalyzingInBridge = true;
        beatData = analyzeAssetBeats({
          workspaceDir: paths.rootDir,
          handle: src.handle,
        });
      } catch {
        // ignore if audio extraction fails
      } finally {
        isAutoAnalyzingInBridge = false;
      }
    }
    return beatData;
  };

  return {
    seq,
    cue,
    paths,
    cueStartMs,
    cueEndMs,
    durationSec,
    fps,
    width,
    height,
    toLocalSec,
    overlapsWindow,
    libMap,
    usesAudio,
    usesGlobal,
    ledger,
    localWaveCache,
    attemptedWaveDigests,
    failedAudioHandles,
    activeWindowAudioHandles,
    bridgeWarnings,
    getOrAnalyzeWaveform,
    getOrAnalyzeBeats,
  };
}

/**
 * Exports all timeline intelligence (`words`, `sentences`, `pauses`, `beats`, `audio`, `cuts`, `safeZone`)
 * intersecting `cue`'s window `[cueStartMs, cueEndMs]`, converted at a single boundary to local seconds `[0 .. durationSec]`.
 */
export function exportBridgeDataForCue(
  seq: CutholSequence,
  cue: LaneCue,
  paths?: WorkspacePaths
): CutholBridgeV1 {
  const ctx = createBridgeCueExportContext(seq, cue, paths);
  const { cueStartMs, durationSec, fps, width, height, bridgeWarnings, ledger } = ctx;

  try {
    const { dedupedWords, pauses, sentences } = compileLocalWordsPausesSentences(ctx);
    const { bpm, dedupedBeatEntries, dedupedGridEntries } = compileLocalBeats(ctx);
    const localAudio = compileLocalAudioEnvelope(ctx);
    const { dedupedCuts, segments } = compileLocalCutsAndSegments(ctx);

    const compId =
      cue.composition?.composition_dir
        ? path.basename(cue.composition.composition_dir).replace(/[^a-zA-Z0-9_-]/g, "_") || "main"
        : "main";

    const safePx = computeSafeZonePx(seq);
    const props = cue.composition?.props ?? {};

    // IMPORTANT: `sequenceStartSec` and internal handle IDs (`clipId` on cuts/segments) are NOT
    // included in the hashable payload so out-of-window spine splits/excisions that merely renumber
    // upstream/downstream clip IDs do not invalidate this composition's window-local sliceHash!
    const gridTimes = dedupedGridEntries.map((g) => g.t);
    const downbeatTimes =
      dedupedGridEntries.length > 0
        ? dedupedGridEntries.filter((g) => g.down).map((g) => g.t)
        : dedupedBeatEntries.filter((b) => b.down).map((b) => b.t);

    const beatsPayload = {
      bpm,
      ...(gridTimes.length > 0
        ? { offset: gridTimes[0], phase: gridTimes[0], grid: gridTimes }
        : {}),
      times: dedupedBeatEntries.map((b) => b.t),
      strength: dedupedBeatEntries.map((b) => b.strength),
      downbeats: downbeatTimes,
    };

    const hashableLocalSlice = {
      schema: CUTHOL_BRIDGE_SCHEMA,
      composition: {
        id: compId,
        cueId: cue.id,
        duration: durationSec,
        fps,
        width,
        height,
      },
      props,
      words: dedupedWords,
      sentences,
      pauses,
      beats: beatsPayload,
      audio: localAudio,
      cuts: dedupedCuts.map((c) => ({ t: c.t, ...(c.kind ? { kind: c.kind } : {}) })),
      segments: segments.map((s) => ({
        t0: s.t0,
        t1: s.t1,
        index: s.index,
        duration: s.duration,
      })),
      safeZone: { px: safePx },
    };

    const sliceHash =
      "sha256:" +
      crypto
        .createHash("sha256")
        .update(JSON.stringify(hashableLocalSlice))
        .digest("hex")
        .slice(0, 16);

    const globalSlice = compileGlobalBridgeSlice(ctx);

    const outPayload: CutholBridgeV1 & { warnings?: string[] } = {
      schema: CUTHOL_BRIDGE_SCHEMA,
      hash: sliceHash,
      composition: {
        ...hashableLocalSlice.composition,
        sequenceStartSec: Number((cueStartMs / 1000).toFixed(4)),
      },
      props,
      words: hashableLocalSlice.words,
      sentences: hashableLocalSlice.sentences,
      pauses: hashableLocalSlice.pauses,
      beats: beatsPayload,
      audio: hashableLocalSlice.audio,
      cuts: dedupedCuts,
      segments,
      safeZone: hashableLocalSlice.safeZone,
      global: globalSlice,
      ...(bridgeWarnings.length > 0 ? { warnings: bridgeWarnings } : {}),
    };
    return outPayload;
  } finally {
    ledger?.close();
  }
}
