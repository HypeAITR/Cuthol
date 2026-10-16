/**
 * Cuthol <-> HyperFrames Window-Local Bridge Exporter & Recursive Directory Hasher
 * (`src/compositor/bridge_exporter.ts`).
 *
 * Key architectural guarantees:
 * 1. Dual-channel data injection:
 *    - Scalar `props` (`string`, `number`, `boolean`) -> `assets/cuthol-vars.json` for `--variables-file`
 *      and `window.__hyperframes.getVariables()`.
 *    - Time-series timeline intelligence (`words`, `beats`, `audio`, `cuts`, `safeZone`) ->
 *      synchronous `assets/cuthol-data.js` (`window.__CUTHOL_DATA__`) + `assets/cuthol-runtime.js` (`window.__cuthol`).
 * 2. Window-local slice hashing (Zero Unnecessary Re-render):
 *    - Global `seq.meta.revision` is NEVER written into `cuthol-data.js`.
 *    - `sliceHash` is computed solely from the normalized local window `[0 .. durationSec]`.
 *    - Conditional disk write: if `assets/cuthol-data.json` already carries the same `hash`,
 *      files on disk are not touched (`mtime` and render cache remain intact).
 * 3. Recursive directory hashing (`hashDirectoryRecursive`):
 *    - Walks `assets/`, `compositions/`, and all nested subdirectories so any asset, font, CSS,
 *      or bridge data change is reflected in the render cache key.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCueStartMs } from "../brief/inspector.js";
import {
  AudioProcessingChain,
  CutholSequence,
  LaneCue,
  ParameterEnvelope,
  SpineClip,
} from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { WorkspacePaths } from "../core/workspace.js";
import { analyzeAssetBeats, BeatAnalysisResult } from "../library/beats.js";
import { MediaLedger } from "../library/ledger.js";
import { SceneAnalysisResult } from "../library/scenes.js";
import { analyzeAssetWaveform, WaveformAnalysisResult } from "../library/waveform.js";
import {
  evaluateEnvelopeAt,
  projectTranscriptWordsToClip,
  sequenceMsToSourceMs,
  sourceMsToSequenceMs,
} from "../sequence/spine.js";
import { TranscriptDocument } from "../speech/providers.js";
import {
  CUTHOL_BRIDGE_SCHEMA,
  CUTHOL_RUNTIME_VERSION,
  CutholBridgeGlobalV1,
  CutholBridgeSegment,
  CutholBridgeV1,
  CutholBridgeWord,
  getCutholRuntimeJsSource,
  normTurkish,
} from "./cuthol_runtime.js";

let isAutoAnalyzingInBridge = false;

const BRIDGE_PACKAGE_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Locates the package-local `gsap.min.js` so compositions never depend on a CDN. */
function findBundledGsapMinJs(): string | null {
  const candidates = [
    path.resolve(BRIDGE_PACKAGE_ROOT_DIR, "node_modules/gsap/dist/gsap.min.js"),
    path.resolve(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const IGNORED_COMPOSITION_SUBDIRS = new Set([
  ".hyperframes",
  "snapshots",
  "renders",
  "build",
  "node_modules",
  ".git",
  ".cuthol",
]);

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Deterministically hashes an entire composition directory tree (including `assets/`,
 * `compositions/`, fonts, images, CSS, JS, HTML) while ignoring transient output directories.
 */
export function hashDirectoryRecursive(rootDir: string): string {
  const absRoot = path.resolve(rootDir);
  const visitedDirs = new Set<string>([safeRealpath(absRoot)]);
  const hash = crypto
    .createHash("sha256")
    .update(`cuthol-runtime-v:${CUTHOL_RUNTIME_VERSION}\n`);

  const walk = (currentDir: string, relPrefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (
        entry.name.startsWith(".tmp.") ||
        entry.name.endsWith(".tmp.mp4") ||
        entry.name.endsWith(".tmp.mov") ||
        entry.name === "cuthol-bbox.json"
      ) {
        continue;
      }
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const targetStat = fs.statSync(fullPath);
          isDir = targetStat.isDirectory();
          isFile = targetStat.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        if (IGNORED_COMPOSITION_SUBDIRS.has(entry.name)) continue;
        const realDir = safeRealpath(fullPath);
        if (visitedDirs.has(realDir)) continue;
        visitedDirs.add(realDir);
        walk(fullPath, relPath);
      } else if (isFile) {
        try {
          const fileBuf = fs.readFileSync(fullPath);
          const fileDigest = crypto.createHash("sha256").update(fileBuf).digest("hex");
          hash.update(`file:${relPath}:${fileBuf.length}:${fileDigest}\n`);
        } catch {
          // ignore unreadable transient file
        }
      }
    }
  };

  walk(absRoot, "");
  return hash.digest("hex");
}

/**
 * Extracts only scalar variable values (`string`, `number`, `boolean`) compatible with
 * HyperFrames `--variables-file` / `data-composition-variables`.
 */
export function extractScalarHyperFramesVariables(
  props: Record<string, unknown> | undefined
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props) return out;
  for (const key of Object.keys(props).sort()) {
    const val = props[key];
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      out[key] = val;
    }
  }
  return out;
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

/**
 * Exports all timeline intelligence (`words`, `sentences`, `pauses`, `beats`, `audio`, `cuts`, `safeZone`)
 * intersecting `cue`'s window `[cueStartMs, cueEndMs]`, converted at a single boundary to local seconds `[0 .. durationSec]`.
 */
export function exportBridgeDataForCue(
  seq: CutholSequence,
  cue: LaneCue,
  paths?: WorkspacePaths
): CutholBridgeV1 {
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
  const ledger =
    paths && fs.existsSync(paths.ledgerFile) ? new MediaLedger(paths.ledgerFile) : null;

  try {
    // 1. Collect Words (from caption/voiceover cues AND spine/voiceover asset transcripts)
    const rawSeqWords: Array<{
      seqStartMs: number;
      seqEndMs: number;
      text: string;
      conf?: number;
    }> = [];

    // 1a. Words already embedded on caption/voiceover cues
    for (const lane of seq.lanes) {
      if (lane.muted) continue;
      for (const otherCue of lane.cues) {
        if (otherCue.id === cue.id) continue;
        const cStart = resolveCueStartMs(seq, otherCue);
        const cEnd = cStart + otherCue.duration_ms;
        if (!overlapsWindow(cStart, cEnd)) continue;

        if (otherCue.typography?.words && otherCue.typography.words.length > 0) {
          const firstKnownSeqStart = otherCue.typography.words.find(
            (w) => !w.excised && w.sequence_start_ms !== null && w.sequence_start_ms !== undefined
          )?.sequence_start_ms;
          const cueShiftMs =
            firstKnownSeqStart !== undefined && firstKnownSeqStart !== null
              ? cStart - firstKnownSeqStart
              : 0;

          for (const tw of otherCue.typography.words) {
            if (tw.excised) continue;
            const ownerClipId = tw.clip_id ?? otherCue.anchor?.ref ?? null;
            const ownerClip = ownerClipId
              ? seq.spine.clips.find((c) => c.id === ownerClipId)
              : undefined;

            let ws: number;
            let we: number;
            if (ownerClip) {
              if (
                tw.source_end_ms <= ownerClip.source_in_ms ||
                tw.source_start_ms >= ownerClip.source_out_ms
              ) {
                continue;
              }
              const clampedSrcStart = Math.max(ownerClip.source_in_ms, tw.source_start_ms);
              const clampedSrcEnd = Math.min(ownerClip.source_out_ms, tw.source_end_ms);
              ws = sourceMsToSequenceMs(ownerClip, clampedSrcStart);
              we = sourceMsToSequenceMs(ownerClip, clampedSrcEnd);
            } else if (tw.sequence_start_ms !== null && tw.sequence_start_ms !== undefined && tw.sequence_end_ms !== null && tw.sequence_end_ms !== undefined) {
              ws = tw.sequence_start_ms + cueShiftMs;
              we = tw.sequence_end_ms + cueShiftMs;
            } else {
              const srcIn = otherCue.source_in_ms ?? 0;
              ws = cStart + Math.max(0, tw.source_start_ms - srcIn);
              we = cStart + Math.min(otherCue.duration_ms, tw.source_end_ms - srcIn);
            }
            if (we > ws && overlapsWindow(ws, we)) {
              rawSeqWords.push({
                seqStartMs: ws,
                seqEndMs: we,
                text: tw.word,
                conf: tw.confidence,
              });
            }
          }
        } else if (otherCue.asset_handle && ledger) {
          const asset = libMap.get(otherCue.asset_handle);
          if (asset) {
            const doc = ledger.getLatestTranscript<TranscriptDocument>(asset.digest_sha256);
            if (doc?.words?.length) {
              const srcIn = otherCue.source_in_ms ?? 0;
              const srcOut = otherCue.source_out_ms ?? srcIn + otherCue.duration_ms;
              for (const w of doc.words) {
                if (w.source_end_ms <= srcIn || w.source_start_ms >= srcOut) continue;
                const ws = cStart + Math.max(0, w.source_start_ms - srcIn);
                const we = cStart + Math.min(otherCue.duration_ms, w.source_end_ms - srcIn);
                if (overlapsWindow(ws, we)) {
                  rawSeqWords.push({
                    seqStartMs: ws,
                    seqEndMs: we,
                    text: w.word,
                    conf: w.confidence,
                  });
                }
              }
            }
          }
        }
      }
    }

    // 1b. Words from SpineClips overlapping the composition window
    if (ledger) {
      for (const clip of seq.spine.clips) {
        const clipStart = clip.timeline_in_ms;
        const clipEnd = clipStart + clip.duration_ms;
        if (!overlapsWindow(clipStart, clipEnd) || clip.audio_chain.muted) continue;

        const asset = libMap.get(clip.asset_handle);
        if (!asset) continue;
        const doc = ledger.getLatestTranscript<TranscriptDocument>(asset.digest_sha256);
        if (!doc?.words?.length) continue;

        const projected = projectTranscriptWordsToClip(clip, doc.words);
        for (const pw of projected) {
          if (pw.excised || pw.sequence_start_ms === null || pw.sequence_end_ms === null) continue;
          if (overlapsWindow(pw.sequence_start_ms, pw.sequence_end_ms)) {
            rawSeqWords.push({
              seqStartMs: pw.sequence_start_ms,
              seqEndMs: pw.sequence_end_ms,
              text: pw.word,
              conf: pw.confidence,
            });
          }
        }
      }
    }

    // Sort and deduplicate words that appear in both spine transcript and generated captions
    rawSeqWords.sort((a, b) => a.seqStartMs - b.seqStartMs || a.seqEndMs - b.seqEndMs);
    const dedupedWords: CutholBridgeWord[] = [];
    for (const rw of rawSeqWords) {
      const rawT0 = toLocalSec(rw.seqStartMs);
      const rawT1 = toLocalSec(rw.seqEndMs);
      const isClipped = rawT0 < 0 || rawT1 > durationSec;
      const t0 = Number(Math.max(0, rawT0).toFixed(4));
      const t1 = Number(Math.min(durationSec, rawT1).toFixed(4));
      if (t1 <= t0) continue;

      const normCurr = normTurkish(rw.text);
      const prev = dedupedWords[dedupedWords.length - 1];
      if (prev && normTurkish(prev.text) === normCurr) {
        const overlapSec = Math.min(prev.t1, t1) - Math.max(prev.t0, t0);
        if (Math.abs(prev.t0 - t0) < 0.025 || overlapSec > 0) {
          continue;
        }
      }
      dedupedWords.push({
        t0,
        t1,
        text: rw.text,
        ...(rw.conf !== undefined ? { conf: Number(rw.conf.toFixed(3)) } : {}),
        ...(isClipped ? { clipped: true } : {}),
      });
    }

    // Build pauses & sentences from deduped local words
    const pauses: Array<{ t0: number; t1: number }> = [];
    const sentences: Array<{ t0: number; t1: number; text: string }> = [];
    if (dedupedWords.length > 0) {
      let sentStart = Math.max(0, dedupedWords[0].t0);
      let sentTokens: string[] = [];

      for (let i = 0; i < dedupedWords.length; i++) {
        const curr = dedupedWords[i];
        const next = dedupedWords[i + 1];
        sentTokens.push(curr.text);

        const gapSec = next ? next.t0 - curr.t1 : 0;
        if (next && gapSec >= 0.2) {
          pauses.push({
            t0: Number(Math.max(0, curr.t1).toFixed(4)),
            t1: Number(Math.min(durationSec, next.t0).toFixed(4)),
          });
        }

        const isPunctBreak = /[.!?…]$/.test(curr.text);
        if (!next || isPunctBreak || gapSec >= 0.4) {
          sentences.push({
            t0: Number(sentStart.toFixed(4)),
            t1: Number(Math.min(durationSec, curr.t1).toFixed(4)),
            text: sentTokens.join(" "),
          });
          if (next) {
            sentStart = Math.max(0, next.t0);
            sentTokens = [];
          }
        }
      }
    }

    // 2. Collect Beats (prefer music lane `ln_bgm` overlapping window, fallback to spine clip beats)
    let bpm = 0;
    const beatEntries: Array<{ t: number; strength: number; down: boolean }> = [];
    const gridEntries: Array<{ t: number; down: boolean }> = [];

    if (ledger) {
      const musicSources: Array<{
        handle: string;
        digest: string;
        seqStartMs: number;
        durMs: number;
        srcInMs: number;
        isMusicLane: boolean;
        clipRef?: SpineClip;
      }> = [];

      for (const lane of seq.lanes) {
        if (lane.muted || lane.kind !== "music") continue;
        for (const mCue of lane.cues) {
          if (!mCue.asset_handle || mCue.audio_chain?.muted) continue;
          const mStart = resolveCueStartMs(seq, mCue);
          const mEnd = mStart + mCue.duration_ms;
          if (!overlapsWindow(mStart, mEnd)) continue;
          const asset = libMap.get(mCue.asset_handle);
          if (asset) {
            musicSources.push({
              handle: asset.handle,
              digest: asset.digest_sha256,
              seqStartMs: mStart,
              durMs: mCue.duration_ms,
              srcInMs: mCue.source_in_ms ?? 0,
              isMusicLane: true,
            });
          }
        }
      }

      if (musicSources.length === 0) {
        for (const clip of seq.spine.clips) {
          if (clip.audio_chain.muted) continue;
          if (!overlapsWindow(clip.timeline_in_ms, clip.timeline_in_ms + clip.duration_ms)) continue;
          const asset = libMap.get(clip.asset_handle);
          if (asset) {
            musicSources.push({
              handle: asset.handle,
              digest: asset.digest_sha256,
              seqStartMs: clip.timeline_in_ms,
              durMs: clip.duration_ms,
              srcInMs: clip.source_in_ms,
              isMusicLane: false,
              clipRef: clip,
            });
          }
        }
      }

      for (const src of musicSources) {
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
        if (!beatData) continue;
        const effectiveBpm = beatData.grid_bpm ?? beatData.estimated_bpm;
        if (bpm === 0 && effectiveBpm > 0) {
          const rate = src.clipRef ? src.clipRef.playback.rate : 1;
          bpm = Number((effectiveBpm * rate).toFixed(2));
        }

        const projectSrcMsToSeqMs = (bSrcMs: number): number | null => {
          if (src.clipRef) {
            if (bSrcMs < src.clipRef.source_in_ms || bSrcMs > src.clipRef.source_out_ms) return null;
            return sourceMsToSequenceMs(src.clipRef, bSrcMs);
          }
          if (bSrcMs < src.srcInMs || bSrcMs > src.srcInMs + src.durMs) return null;
          return src.seqStartMs + (bSrcMs - src.srcInMs);
        };

        const rawGridMs = Array.isArray(beatData.grid_ms) ? beatData.grid_ms : [];
        rawGridMs.forEach((gSrcMs, idx) => {
          const seqMs = projectSrcMsToSeqMs(gSrcMs);
          if (seqMs !== null && seqMs >= cueStartMs && seqMs < cueEndMs) {
            gridEntries.push({
              t: toLocalSec(seqMs),
              down: idx % 4 === 0,
            });
          }
        });

        if (Array.isArray(beatData.onsets) && beatData.onsets.length > 0) {
          beatData.onsets.forEach((onset, idx) => {
            const seqMs = projectSrcMsToSeqMs(onset.time_ms);
            if (seqMs !== null && seqMs >= cueStartMs && seqMs < cueEndMs) {
              beatEntries.push({
                t: toLocalSec(seqMs),
                strength: onset.strength,
                down: onset.strength >= 0.85 || idx % 4 === 0,
              });
            }
          });
        } else {
          beatData.beats_ms.forEach((bSrcMs, idx) => {
            const seqMs = projectSrcMsToSeqMs(bSrcMs);
            if (seqMs !== null && seqMs >= cueStartMs && seqMs < cueEndMs) {
              const isDown = idx % 4 === 0;
              const strength = isDown ? 1.0 : idx % 2 === 0 ? 0.78 : 0.5;
              beatEntries.push({
                t: toLocalSec(seqMs),
                strength,
                down: isDown,
              });
            }
          });
        }
      }
    }

    beatEntries.sort((a, b) => a.t - b.t);
    const dedupedBeatEntries: typeof beatEntries = [];
    for (const b of beatEntries) {
      const prev = dedupedBeatEntries[dedupedBeatEntries.length - 1];
      if (prev && Math.abs(prev.t - b.t) < 0.02) {
        if (b.strength > prev.strength) {
          prev.strength = b.strength;
        }
        prev.down = prev.down || b.down;
      } else {
        dedupedBeatEntries.push({ ...b });
      }
    }

    gridEntries.sort((a, b) => a.t - b.t);
    const dedupedGridEntries: typeof gridEntries = [];
    for (const g of gridEntries) {
      const prev = dedupedGridEntries[dedupedGridEntries.length - 1];
      if (prev && Math.abs(prev.t - g.t) < 0.02) {
        prev.down = prev.down || g.down;
      } else {
        dedupedGridEntries.push({ ...g });
      }
    }

    // 3. Collect 3-Band Audio Envelope (`low`, `mid`, `high` @ 25 Hz across composition window)
    const audioFps = 25;
    const totalAudioFrames = Math.max(2, Math.ceil(durationSec * audioFps) + 1);
    const lowArr = new Array<number>(totalAudioFrames).fill(0);
    const midArr = new Array<number>(totalAudioFrames).fill(0);
    const highArr = new Array<number>(totalAudioFrames).fill(0);
    let hasAudioEnvelope = false;

    if (ledger) {
      // Gather waveform caches for active spine clips, voiceovers, and music cues
      const waveSources: Array<{
        wave: WaveformAnalysisResult;
        seqStartMs: number;
        seqEndMs: number;
        srcInMs: number;
        clipRef?: SpineClip;
        audioChain?: AudioProcessingChain;
        envelopes?: ParameterEnvelope[];
      }> = [];

      for (const clip of seq.spine.clips) {
        if (clip.audio_chain.muted) continue;
        const cStart = clip.timeline_in_ms;
        const cEnd = cStart + clip.duration_ms;
        if (!overlapsWindow(cStart, cEnd)) continue;
        const asset = libMap.get(clip.asset_handle);
        if (!asset) continue;
        const wave = ledger.getLatestWaveform<WaveformAnalysisResult>(asset.digest_sha256);
        if (wave?.bins?.length) {
          waveSources.push({
            wave,
            seqStartMs: cStart,
            seqEndMs: cEnd,
            srcInMs: clip.source_in_ms,
            clipRef: clip,
            audioChain: clip.audio_chain,
            envelopes: clip.envelopes,
          });
        }
      }

      for (const lane of seq.lanes) {
        if (lane.muted) continue;
        for (const aCue of lane.cues) {
          if (!aCue.asset_handle || aCue.audio_chain?.muted) continue;
          const aStart = resolveCueStartMs(seq, aCue);
          const aEnd = aStart + aCue.duration_ms;
          if (!overlapsWindow(aStart, aEnd)) continue;
          const asset = libMap.get(aCue.asset_handle);
          if (!asset) continue;
          let wave = ledger.getLatestWaveform<WaveformAnalysisResult>(asset.digest_sha256);
          if (!wave && lane.kind === "music" && paths && !isAutoAnalyzingInBridge) {
            try {
              isAutoAnalyzingInBridge = true;
              wave = analyzeAssetWaveform({
                workspaceDir: paths.rootDir,
                handle: asset.handle,
                bins: 160,
              });
            } catch {
              // ignore if waveform fails
            } finally {
              isAutoAnalyzingInBridge = false;
            }
          }
          if (wave?.bins?.length) {
            waveSources.push({
              wave,
              seqStartMs: aStart,
              seqEndMs: aEnd,
              srcInMs: aCue.source_in_ms ?? 0,
              audioChain: aCue.audio_chain,
              envelopes: aCue.envelopes,
            });
          }
        }
      }

      if (waveSources.length > 0) {
        hasAudioEnvelope = true;
        for (let f = 0; f < totalAudioFrames; f++) {
          const localSec = f / audioFps;
          const seqMs = cueStartMs + localSec * 1000;
          let lMax = 0;
          let mMax = 0;
          let hMax = 0;

          for (const ws of waveSources) {
            if (seqMs < ws.seqStartMs || seqMs > ws.seqEndMs) continue;
            const srcMs = ws.clipRef
              ? sequenceMsToSourceMs(ws.clipRef, seqMs)
              : ws.srcInMs + (seqMs - ws.seqStartMs);
            const binDur = Math.max(1, ws.wave.duration_ms / ws.wave.bins.length);
            const binIdx = Math.max(
              0,
              Math.min(ws.wave.bins.length - 1, Math.floor(srcMs / binDur))
            );
            const bin = ws.wave.bins[binIdx];
            if (bin) {
              const itemLocalMs = Math.max(0, seqMs - ws.seqStartMs);
              const itemDurMs = Math.max(1, ws.seqEndMs - ws.seqStartMs);
              let totalDb = ws.audioChain?.gain_db ?? 0;
              const gainEnv = ws.envelopes?.find((e) => e.parameter === "audio_chain.gain_db");
              if (gainEnv && gainEnv.points.length > 0) {
                totalDb += evaluateEnvelopeAt(gainEnv, itemLocalMs);
              }
              const linearGain = Math.pow(10, totalDb / 20);
              const fadeInMs = ws.audioChain?.fade_in_ms ?? 0;
              const fadeOutMs = ws.audioChain?.fade_out_ms ?? 0;
              const fadeInMul =
                fadeInMs > 0 && itemLocalMs < fadeInMs ? Math.max(0, itemLocalMs / fadeInMs) : 1;
              const fadeOutMul =
                fadeOutMs > 0 && itemDurMs - itemLocalMs < fadeOutMs
                  ? Math.max(0, (itemDurMs - itemLocalMs) / fadeOutMs)
                  : 1;
              const effectiveGain = linearGain * fadeInMul * fadeOutMul;
              const amp = Math.max(0.05, bin.rms_norm) * effectiveGain;
              lMax = Math.max(lMax, bin.low_energy * amp);
              mMax = Math.max(mMax, bin.mid_energy * amp);
              hMax = Math.max(hMax, bin.high_energy * amp);
            }
          }

          lowArr[f] = lMax;
          midArr[f] = mMax;
          highArr[f] = hMax;
        }

        // Normalize each frequency band (`low`, `mid`, `high`) independently to [0..1] across the window
        // so `C.audio(band, t)` always delivers full 0..1 dynamic range on real music!
        const normalizeBandToUnitRange = (arr: number[]): void => {
          let maxVal = 0;
          let minVal = Number.POSITIVE_INFINITY;
          for (const v of arr) {
            if (v > maxVal) maxVal = v;
            if (v < minVal) minVal = v;
          }
          if (maxVal <= 1e-4) {
            arr.fill(0);
            return;
          }
          const span = maxVal - minVal;
          for (let i = 0; i < arr.length; i++) {
            const norm =
              span > 1e-4
                ? 0.05 + 0.95 * ((arr[i] - minVal) / span)
                : Math.min(1, arr[i] / maxVal);
            arr[i] = Number(Math.max(0, Math.min(1, norm)).toFixed(3));
          }
        };
        normalizeBandToUnitRange(lowArr);
        normalizeBandToUnitRange(midArr);
        normalizeBandToUnitRange(highArr);
      }
    }

    // 4. Collect Cuts & Segments inside (cueStartMs, cueEndMs)
    const cutsList: Array<{ t: number; clipId?: string; kind?: "spine_cut" | "scene_cut" }> = [];
    for (const clip of seq.spine.clips) {
      if (clip.timeline_in_ms > cueStartMs && clip.timeline_in_ms < cueEndMs) {
        cutsList.push({
          t: toLocalSec(clip.timeline_in_ms),
          clipId: clip.id,
          kind: "spine_cut",
        });
      }
      if (ledger && overlapsWindow(clip.timeline_in_ms, clip.timeline_in_ms + clip.duration_ms)) {
        const asset = libMap.get(clip.asset_handle);
        if (asset) {
          const sc = ledger.getLatestScenes<SceneAnalysisResult>(asset.digest_sha256);
          if (sc?.cuts?.length) {
            for (const c of sc.cuts) {
              if (c.time_ms <= clip.source_in_ms || c.time_ms >= clip.source_out_ms) continue;
              const seqCutMs = sourceMsToSequenceMs(clip, c.time_ms);
              if (seqCutMs > cueStartMs && seqCutMs < cueEndMs) {
                cutsList.push({
                  t: toLocalSec(seqCutMs),
                  clipId: clip.id,
                  kind: "scene_cut",
                });
              }
            }
          }
        }
      }
    }
    cutsList.sort((a, b) => a.t - b.t);
    const dedupedCuts: typeof cutsList = [];
    for (const c of cutsList) {
      if (dedupedCuts.length === 0 || Math.abs(dedupedCuts[dedupedCuts.length - 1].t - c.t) > 0.04) {
        dedupedCuts.push(c);
      }
    }

    // Build contiguous segments covering [0 .. durationSec]
    const cutBounds = [0, ...dedupedCuts.map((c) => c.t), durationSec];
    const segments: CutholBridgeSegment[] = [];
    for (let i = 0; i < cutBounds.length - 1; i++) {
      const t0 = cutBounds[i];
      const t1 = cutBounds[i + 1];
      if (t1 <= t0) continue;
      const midSeqMs = cueStartMs + ((t0 + t1) / 2) * 1000;
      const ownerClip = seq.spine.clips.find(
        (c) => midSeqMs >= c.timeline_in_ms && midSeqMs <= c.timeline_in_ms + c.duration_ms
      );
      segments.push({
        t0,
        t1,
        index: segments.length,
        duration: Number((t1 - t0).toFixed(4)),
        ...(ownerClip ? { clipId: ownerClip.id } : {}),
      });
    }

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
      audio: hasAudioEnvelope
        ? {
            fps: audioFps,
            t0: 0,
            bands: ["low", "mid", "high"] as ["low", "mid", "high"],
            low: lowArr,
            mid: midArr,
            high: highArr,
          }
        : {
            fps: 0,
            t0: 0,
            bands: ["low", "mid", "high"] as ["low", "mid", "high"],
            low: [],
            mid: [],
            high: [],
          },
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

    // 5. Build full-sequence (`global`) intelligence in absolute timeline seconds [0 .. seqDurationSec]
    // with single sequence-wide 3-band audio normalization and compact resolution for long (40-50 min) edits.
    let seqDurationMs = cueEndMs;
    for (const clip of seq.spine.clips) {
      seqDurationMs = Math.max(seqDurationMs, clip.timeline_in_ms + clip.duration_ms);
    }
    for (const lane of seq.lanes) {
      if (lane.muted) continue;
      for (const c of lane.cues) {
        seqDurationMs = Math.max(seqDurationMs, resolveCueStartMs(seq, c) + c.duration_ms);
      }
    }
    const seqDurationSec = Number((seqDurationMs / 1000).toFixed(4));
    const toGlobalSec = (seqMs: number): number => Number((seqMs / 1000).toFixed(3));

    const globalRawWords: Array<{ seqStartMs: number; seqEndMs: number; text: string }> = [];
    for (const lane of seq.lanes) {
      if (lane.muted) continue;
      for (const otherCue of lane.cues) {
        if (otherCue.id === cue.id) continue;
        const cStart = resolveCueStartMs(seq, otherCue);
        const cEnd = cStart + otherCue.duration_ms;
        if (cEnd <= 0) continue;

        if (otherCue.typography?.words && otherCue.typography.words.length > 0) {
          const firstKnownSeqStart = otherCue.typography.words.find(
            (w) => !w.excised && w.sequence_start_ms !== null && w.sequence_start_ms !== undefined
          )?.sequence_start_ms;
          const cueShiftMs =
            firstKnownSeqStart !== undefined && firstKnownSeqStart !== null
              ? cStart - firstKnownSeqStart
              : 0;

          for (const tw of otherCue.typography.words) {
            if (tw.excised) continue;
            const ownerClipId = tw.clip_id ?? otherCue.anchor?.ref ?? null;
            const ownerClip = ownerClipId
              ? seq.spine.clips.find((c) => c.id === ownerClipId)
              : undefined;

            let ws: number;
            let we: number;
            if (ownerClip) {
              if (
                tw.source_end_ms <= ownerClip.source_in_ms ||
                tw.source_start_ms >= ownerClip.source_out_ms
              ) {
                continue;
              }
              const clampedSrcStart = Math.max(ownerClip.source_in_ms, tw.source_start_ms);
              const clampedSrcEnd = Math.min(ownerClip.source_out_ms, tw.source_end_ms);
              ws = sourceMsToSequenceMs(ownerClip, clampedSrcStart);
              we = sourceMsToSequenceMs(ownerClip, clampedSrcEnd);
            } else if (
              tw.sequence_start_ms !== null &&
              tw.sequence_start_ms !== undefined &&
              tw.sequence_end_ms !== null &&
              tw.sequence_end_ms !== undefined
            ) {
              ws = tw.sequence_start_ms + cueShiftMs;
              we = tw.sequence_end_ms + cueShiftMs;
            } else {
              const srcIn = otherCue.source_in_ms ?? 0;
              ws = cStart + Math.max(0, tw.source_start_ms - srcIn);
              we = cStart + Math.min(otherCue.duration_ms, tw.source_end_ms - srcIn);
            }
            if (we > ws && we > 0 && ws < seqDurationMs) {
              globalRawWords.push({ seqStartMs: ws, seqEndMs: we, text: tw.word });
            }
          }
        } else if (otherCue.asset_handle && ledger) {
          const asset = libMap.get(otherCue.asset_handle);
          if (asset) {
            const doc = ledger.getLatestTranscript<TranscriptDocument>(asset.digest_sha256);
            if (doc?.words?.length) {
              const srcIn = otherCue.source_in_ms ?? 0;
              const srcOut = otherCue.source_out_ms ?? srcIn + otherCue.duration_ms;
              for (const w of doc.words) {
                if (w.source_end_ms <= srcIn || w.source_start_ms >= srcOut) continue;
                const ws = cStart + Math.max(0, w.source_start_ms - srcIn);
                const we = cStart + Math.min(otherCue.duration_ms, w.source_end_ms - srcIn);
                if (we > ws && we > 0 && ws < seqDurationMs) {
                  globalRawWords.push({ seqStartMs: ws, seqEndMs: we, text: w.word });
                }
              }
            }
          }
        }
      }
    }

    if (ledger) {
      for (const clip of seq.spine.clips) {
        if (clip.audio_chain.muted) continue;
        const asset = libMap.get(clip.asset_handle);
        if (!asset) continue;
        const doc = ledger.getLatestTranscript<TranscriptDocument>(asset.digest_sha256);
        if (!doc?.words?.length) continue;

        const projected = projectTranscriptWordsToClip(clip, doc.words);
        for (const pw of projected) {
          if (pw.excised || pw.sequence_start_ms === null || pw.sequence_end_ms === null) continue;
          if (pw.sequence_end_ms > 0 && pw.sequence_start_ms < seqDurationMs) {
            globalRawWords.push({
              seqStartMs: pw.sequence_start_ms,
              seqEndMs: pw.sequence_end_ms,
              text: pw.word,
            });
          }
        }
      }
    }

    globalRawWords.sort((a, b) => a.seqStartMs - b.seqStartMs || a.seqEndMs - b.seqEndMs);
    const globalDedupedWords: CutholBridgeWord[] = [];
    for (const rw of globalRawWords) {
      const t0 = Number(Math.max(0, toGlobalSec(rw.seqStartMs)).toFixed(3));
      const t1 = Number(Math.min(seqDurationSec, toGlobalSec(rw.seqEndMs)).toFixed(3));
      if (t1 <= t0) continue;

      const normCurr = normTurkish(rw.text);
      const prev = globalDedupedWords[globalDedupedWords.length - 1];
      if (prev && normTurkish(prev.text) === normCurr) {
        const overlapSec = Math.min(prev.t1, t1) - Math.max(prev.t0, t0);
        if (Math.abs(prev.t0 - t0) < 0.025 || overlapSec > 0) {
          continue;
        }
      }
      globalDedupedWords.push({ t0, t1, text: rw.text });
    }

    const globalPauses: Array<{ t0: number; t1: number }> = [];
    for (let i = 0; i < globalDedupedWords.length - 1; i++) {
      const curr = globalDedupedWords[i];
      const next = globalDedupedWords[i + 1];
      if (next.t0 - curr.t1 >= 0.2) {
        globalPauses.push({
          t0: Number(Math.max(0, curr.t1).toFixed(3)),
          t1: Number(Math.min(seqDurationSec, next.t0).toFixed(3)),
        });
      }
    }

    // Global 3-band audio envelope across [0 .. seqDurationSec] with a single sequence-wide normalization.
    // Resolution scales automatically: 10 Hz (100 ms) up to 15 min, 5 Hz (200 ms) for 15-60 min edits.
    const globalAudioFps = seqDurationSec > 900 ? 5 : 10;
    const globalAudioPrecision = seqDurationSec > 900 ? 2 : 3;
    const totalGlobalAudioFrames = Math.max(2, Math.ceil(seqDurationSec * globalAudioFps) + 1);
    const gLowArr = new Array<number>(totalGlobalAudioFrames).fill(0);
    const gMidArr = new Array<number>(totalGlobalAudioFrames).fill(0);
    const gHighArr = new Array<number>(totalGlobalAudioFrames).fill(0);
    let hasGlobalAudio = false;

    if (ledger) {
      const globalWaveSources: Array<{
        wave: WaveformAnalysisResult;
        seqStartMs: number;
        seqEndMs: number;
        srcInMs: number;
        clipRef?: SpineClip;
        audioChain?: AudioProcessingChain;
        envelopes?: ParameterEnvelope[];
      }> = [];

      for (const clip of seq.spine.clips) {
        if (clip.audio_chain.muted) continue;
        const cStart = clip.timeline_in_ms;
        const cEnd = cStart + clip.duration_ms;
        const asset = libMap.get(clip.asset_handle);
        if (!asset) continue;
        const wave = ledger.getLatestWaveform<WaveformAnalysisResult>(asset.digest_sha256);
        if (wave?.bins?.length) {
          globalWaveSources.push({
            wave,
            seqStartMs: cStart,
            seqEndMs: cEnd,
            srcInMs: clip.source_in_ms,
            clipRef: clip,
            audioChain: clip.audio_chain,
            envelopes: clip.envelopes,
          });
        }
      }

      for (const lane of seq.lanes) {
        if (lane.muted) continue;
        for (const aCue of lane.cues) {
          if (!aCue.asset_handle || aCue.audio_chain?.muted) continue;
          const aStart = resolveCueStartMs(seq, aCue);
          const aEnd = aStart + aCue.duration_ms;
          const asset = libMap.get(aCue.asset_handle);
          if (!asset) continue;
          const wave = ledger.getLatestWaveform<WaveformAnalysisResult>(asset.digest_sha256);
          if (wave?.bins?.length) {
            globalWaveSources.push({
              wave,
              seqStartMs: aStart,
              seqEndMs: aEnd,
              srcInMs: aCue.source_in_ms ?? 0,
              audioChain: aCue.audio_chain,
              envelopes: aCue.envelopes,
            });
          }
        }
      }

      if (globalWaveSources.length > 0) {
        hasGlobalAudio = true;
        for (let f = 0; f < totalGlobalAudioFrames; f++) {
          const globalSec = f / globalAudioFps;
          const seqMs = globalSec * 1000;
          let lMax = 0;
          let mMax = 0;
          let hMax = 0;

          for (const ws of globalWaveSources) {
            if (seqMs < ws.seqStartMs || seqMs > ws.seqEndMs) continue;
            const srcMs = ws.clipRef
              ? sequenceMsToSourceMs(ws.clipRef, seqMs)
              : ws.srcInMs + (seqMs - ws.seqStartMs);
            const binDur = Math.max(1, ws.wave.duration_ms / ws.wave.bins.length);
            const binIdx = Math.max(
              0,
              Math.min(ws.wave.bins.length - 1, Math.floor(srcMs / binDur))
            );
            const bin = ws.wave.bins[binIdx];
            if (bin) {
              const itemLocalMs = Math.max(0, seqMs - ws.seqStartMs);
              const itemDurMs = Math.max(1, ws.seqEndMs - ws.seqStartMs);
              let totalDb = ws.audioChain?.gain_db ?? 0;
              const gainEnv = ws.envelopes?.find((e) => e.parameter === "audio_chain.gain_db");
              if (gainEnv && gainEnv.points.length > 0) {
                totalDb += evaluateEnvelopeAt(gainEnv, itemLocalMs);
              }
              const linearGain = Math.pow(10, totalDb / 20);
              const fadeInMs = ws.audioChain?.fade_in_ms ?? 0;
              const fadeOutMs = ws.audioChain?.fade_out_ms ?? 0;
              const fadeInMul =
                fadeInMs > 0 && itemLocalMs < fadeInMs ? Math.max(0, itemLocalMs / fadeInMs) : 1;
              const fadeOutMul =
                fadeOutMs > 0 && itemDurMs - itemLocalMs < fadeOutMs
                  ? Math.max(0, (itemDurMs - itemLocalMs) / fadeOutMs)
                  : 1;
              const effectiveGain = linearGain * fadeInMul * fadeOutMul;
              const amp = Math.max(0.05, bin.rms_norm) * effectiveGain;
              lMax = Math.max(lMax, bin.low_energy * amp);
              mMax = Math.max(mMax, bin.mid_energy * amp);
              hMax = Math.max(hMax, bin.high_energy * amp);
            }
          }

          gLowArr[f] = lMax;
          gMidArr[f] = mMax;
          gHighArr[f] = hMax;
        }

        const normalizeGlobalBand = (arr: number[]): void => {
          let maxVal = 0;
          let minVal = Number.POSITIVE_INFINITY;
          for (const v of arr) {
            if (v > maxVal) maxVal = v;
            if (v < minVal) minVal = v;
          }
          if (maxVal <= 1e-4) {
            arr.fill(0);
            return;
          }
          const span = maxVal - minVal;
          for (let i = 0; i < arr.length; i++) {
            const norm =
              span > 1e-4
                ? 0.05 + 0.95 * ((arr[i] - minVal) / span)
                : Math.min(1, arr[i] / maxVal);
            arr[i] = Number(Math.max(0, Math.min(1, norm)).toFixed(globalAudioPrecision));
          }
        };
        normalizeGlobalBand(gLowArr);
        normalizeGlobalBand(gMidArr);
        normalizeGlobalBand(gHighArr);
      }
    }

    // Global cuts & segments across [0 .. seqDurationSec]
    const globalCutsList: Array<{ t: number; clipId?: string; kind?: "spine_cut" | "scene_cut" }> = [];
    for (const clip of seq.spine.clips) {
      if (clip.timeline_in_ms > 0 && clip.timeline_in_ms < seqDurationMs) {
        globalCutsList.push({
          t: toGlobalSec(clip.timeline_in_ms),
          clipId: clip.id,
          kind: "spine_cut",
        });
      }
      if (ledger) {
        const asset = libMap.get(clip.asset_handle);
        if (asset) {
          const sc = ledger.getLatestScenes<SceneAnalysisResult>(asset.digest_sha256);
          if (sc?.cuts?.length) {
            for (const c of sc.cuts) {
              if (c.time_ms <= clip.source_in_ms || c.time_ms >= clip.source_out_ms) continue;
              const seqCutMs = sourceMsToSequenceMs(clip, c.time_ms);
              if (seqCutMs > 0 && seqCutMs < seqDurationMs) {
                globalCutsList.push({
                  t: toGlobalSec(seqCutMs),
                  clipId: clip.id,
                  kind: "scene_cut",
                });
              }
            }
          }
        }
      }
    }
    globalCutsList.sort((a, b) => a.t - b.t);
    const globalDedupedCuts: typeof globalCutsList = [];
    for (const c of globalCutsList) {
      if (
        globalDedupedCuts.length === 0 ||
        Math.abs(globalDedupedCuts[globalDedupedCuts.length - 1].t - c.t) > 0.04
      ) {
        globalDedupedCuts.push(c);
      }
    }

    const globalCutBounds = [0, ...globalDedupedCuts.map((c) => c.t), seqDurationSec];
    const globalSegments: CutholBridgeSegment[] = [];
    for (let i = 0; i < globalCutBounds.length - 1; i++) {
      const t0 = globalCutBounds[i];
      const t1 = globalCutBounds[i + 1];
      if (t1 <= t0) continue;
      const midSeqMs = ((t0 + t1) / 2) * 1000;
      const ownerClip = seq.spine.clips.find(
        (c) => midSeqMs >= c.timeline_in_ms && midSeqMs <= c.timeline_in_ms + c.duration_ms
      );
      globalSegments.push({
        t0,
        t1,
        index: globalSegments.length,
        duration: Number((t1 - t0).toFixed(3)),
        ...(ownerClip ? { clipId: ownerClip.id } : {}),
      });
    }

    const globalHashable = {
      duration: seqDurationSec,
      words: globalDedupedWords,
      pauses: globalPauses,
      audio: hasGlobalAudio
        ? {
            fps: globalAudioFps,
            t0: 0,
            bands: ["low", "mid", "high"] as ["low", "mid", "high"],
            low: gLowArr,
            mid: gMidArr,
            high: gHighArr,
          }
        : {
            fps: 0,
            t0: 0,
            bands: ["low", "mid", "high"] as ["low", "mid", "high"],
            low: [],
            mid: [],
            high: [],
          },
      cuts: globalDedupedCuts.map((c) => ({ t: c.t, ...(c.kind ? { kind: c.kind } : {}) })),
    };

    const globalHash =
      "sha256:" +
      crypto
        .createHash("sha256")
        .update(JSON.stringify(globalHashable))
        .digest("hex")
        .slice(0, 16);

    const globalSlice: CutholBridgeGlobalV1 = {
      hash: globalHash,
      duration: seqDurationSec,
      words: globalDedupedWords,
      pauses: globalPauses,
      audio: globalHashable.audio,
      cuts: globalDedupedCuts,
      segments: globalSegments,
    };

    return {
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
    };
  } finally {
    ledger?.close();
  }
}

/**
 * Synchronizes `assets/cuthol-data.json`, `assets/cuthol-data.js`, `assets/cuthol-runtime.js`,
 * and `assets/cuthol-vars.json` inside a composition directory using conditional writes:
 * If `sliceHash` has not changed, `cuthol-data.json` and `cuthol-data.js` are NOT overwritten.
 */
export function syncCompositionBridgeFiles(
  seq: CutholSequence,
  cue: LaneCue,
  paths: WorkspacePaths
): {
  updated: boolean;
  sliceHash: string;
  dataJsPath: string;
  runtimeJsPath: string;
  varsJsonPath: string;
  bridgeData: CutholBridgeV1;
} | null {
  if (cue.kind !== "composition" || !cue.composition) return null;

  const compDir = path.isAbsolute(cue.composition.composition_dir)
    ? cue.composition.composition_dir
    : path.resolve(paths.rootDir, cue.composition.composition_dir);

  if (!fs.existsSync(compDir)) return null;

  const assetsDir = path.join(compDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const bridgeData = exportBridgeDataForCue(seq, cue, paths);
  const dataJsonPath = path.join(assetsDir, "cuthol-data.json");
  const dataJsPath = path.join(assetsDir, "cuthol-data.js");
  const runtimeJsPath = path.join(assetsDir, "cuthol-runtime.js");
  const varsJsonPath = path.join(assetsDir, "cuthol-vars.json");

  let updated = false;

  // 1. Check if `cuthol-data.json` already has the exact same `sliceHash` (and `global` payload)
  const entryRel = cue.composition.entry_html || "index.html";
  const entryHtmlPath = path.join(compDir, entryRel);
  const existingEntryHtml = fs.existsSync(entryHtmlPath)
    ? fs.readFileSync(entryHtmlPath, "utf8")
    : null;
  const htmlUsesGlobal = existingEntryHtml !== null && /\bglobal\b/.test(existingEntryHtml);

  let existingHash: string | null = null;
  let existingGlobalHash: string | null = null;
  let hasExistingGlobal = false;
  if (fs.existsSync(dataJsonPath) && fs.existsSync(dataJsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(dataJsonPath, "utf8")) as {
        hash?: string;
        global?: { hash?: string };
      };
      existingHash = parsed.hash ?? null;
      hasExistingGlobal = parsed.global !== undefined;
      existingGlobalHash = parsed.global?.hash ?? null;
    } catch {
      existingHash = null;
    }
  }

  const needsDataWrite =
    existingHash !== bridgeData.hash ||
    !hasExistingGlobal ||
    (htmlUsesGlobal && existingGlobalHash !== (bridgeData.global?.hash ?? null));

  if (needsDataWrite) {
    const jsonStr = JSON.stringify(bridgeData, null, 2);
    const compactJsPayload = JSON.stringify(bridgeData);
    fs.writeFileSync(dataJsonPath, jsonStr, "utf8");
    fs.writeFileSync(
      dataJsPath,
      `/* Auto-generated by Cuthol (${bridgeData.hash}) — window-local + global timeline slice */\nwindow.__CUTHOL_DATA__ = ${compactJsPayload};\n`,
      "utf8"
    );
    updated = true;
  }

  // 2. Conditionally write `cuthol-runtime.js` only if missing or content differs
  const runtimeSource = getCutholRuntimeJsSource();
  const existingRuntime = fs.existsSync(runtimeJsPath)
    ? fs.readFileSync(runtimeJsPath, "utf8")
    : null;
  if (existingRuntime !== runtimeSource) {
    fs.writeFileSync(runtimeJsPath, runtimeSource, "utf8");
    updated = true;
  }

  // 3. Conditionally write `cuthol-vars.json` (scalar variables for `--variables-file`)
  const scalarVars = extractScalarHyperFramesVariables(cue.composition.props);
  const varsJsonStr = JSON.stringify(scalarVars, null, 2);
  const existingVars = fs.existsSync(varsJsonPath)
    ? fs.readFileSync(varsJsonPath, "utf8")
    : null;
  if (existingVars !== varsJsonStr) {
    fs.writeFileSync(varsJsonPath, varsJsonStr, "utf8");
    updated = true;
  }

  // 4. Ensure entry HTML (`index.html`) includes synchronous `<script src="assets/cuthol-data.js">`
  // followed by `<script src="assets/cuthol-runtime.js">` in the proper order, touching ONLY those
  // exact two tags and never modifying any other `<script>` tags in the user's HTML.
  if (existingEntryHtml !== null) {
    const html = existingEntryHtml;
    const dataTag = `<script src="assets/cuthol-data.js"></script>`;
    const runtimeTag = `<script src="assets/cuthol-runtime.js"></script>`;
    const exactDataRe = /<script\s+src=(["'])assets\/cuthol-data\.js\1\s*><\/script>/i;
    const exactRuntimeRe = /<script\s+src=(["'])assets\/cuthol-runtime\.js\1\s*><\/script>/i;
    const dataMatch = exactDataRe.exec(html);
    const runtimeMatch = exactRuntimeRe.exec(html);
    const dataIdx = dataMatch ? dataMatch.index : -1;
    const runtimeIdx = runtimeMatch ? runtimeMatch.index : -1;
    let nextHtml = html;

    if (dataIdx === -1 && runtimeIdx === -1) {
      if (/<template[\s>]/i.test(html) && /<script[\s>]/i.test(html)) {
        nextHtml = html.replace(/<script[\s>]/i, `${dataTag}\n      ${runtimeTag}\n      $&`);
      } else if (/<\/head>/i.test(html)) {
        nextHtml = html.replace(/<\/head>/i, `    ${dataTag}\n    ${runtimeTag}\n  </head>`);
      } else if (/<script[\s>]/i.test(html)) {
        nextHtml = html.replace(/<script[\s>]/i, `${dataTag}\n${runtimeTag}\n$&`);
      }
    } else if (dataIdx === -1 && runtimeIdx !== -1) {
      nextHtml = html.replace(exactRuntimeRe, `${dataTag}\n    $&`);
    } else if (dataIdx !== -1 && runtimeIdx === -1) {
      nextHtml = html.replace(exactDataRe, `$&\n    ${runtimeTag}`);
    } else if (runtimeIdx < dataIdx) {
      const withoutRuntime = html.replace(
        /\s*<script\s+src=(["'])assets\/cuthol-runtime\.js\1\s*><\/script>/i,
        ""
      );
      nextHtml = withoutRuntime.replace(exactDataRe, `$&\n    ${runtimeTag}`);
    }

    if (nextHtml !== html) {
      fs.writeFileSync(entryHtmlPath, nextHtml, "utf8");
      updated = true;
    }

    // 5. Hand-written compositions that reference `assets/gsap.min.js` get the bundled copy;
    // without it the timeline script throws and the overlay renders fully transparent.
    const gsapPath = path.join(assetsDir, "gsap.min.js");
    if (/src=["']assets\/gsap\.min\.js["']/i.test(nextHtml) && !fs.existsSync(gsapPath)) {
      const bundledGsap = findBundledGsapMinJs();
      if (bundledGsap) {
        fs.copyFileSync(bundledGsap, gsapPath);
        updated = true;
      }
    }
  }

  return {
    updated,
    sliceHash: bridgeData.hash,
    dataJsPath,
    runtimeJsPath,
    varsJsonPath,
    bridgeData,
  };
}

/**
 * Synchronizes all mounted HyperFrames compositions in the sequence using window-local conditional writes.
 */
export function syncAllCompositionBridges(
  seq: CutholSequence,
  paths: WorkspacePaths
): Array<{ cueId: string; compositionDir: string; updated: boolean; sliceHash: string }> {
  if (isAutoAnalyzingInBridge) return [];
  const results: Array<{
    cueId: string;
    compositionDir: string;
    updated: boolean;
    sliceHash: string;
  }> = [];

  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      if (cue.kind === "composition" && cue.composition) {
        const res = syncCompositionBridgeFiles(seq, cue, paths);
        if (res) {
          results.push({
            cueId: cue.id,
            compositionDir: cue.composition.composition_dir,
            updated: res.updated,
            sliceHash: res.sliceHash,
          });
        }
      }
    }
  }
  return results;
}
