// Re-transcribe the spine's own speech after cleanup and compare it with the words the edit kept.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { compileSequenceAudioPlan } from "../compositor/compile_audio.js";
import {
  createSubprocessFailureDiagnostic,
  CutholError,
  DIAGNOSTICS,
  estimateCommandLineLength,
} from "../core/diagnostics.js";
import { loadDotEnvIfNeeded } from "../core/env.js";
import { CutholSequence, SpineClip } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import { WorkspacePaths, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { AcousticWindowProfile, measureAssetAcousticWindows } from "../library/waveform.js";
import { projectTranscriptAcrossSequence, sourceMsToSequenceMs } from "../sequence/spine.js";
import { resolveCleanupTargetClips } from "./cleanup_candidates.js";
import {
  AsrProviderId,
  normalizeTokenForMatch,
  RawTranscriptWord,
  TranscriptDocument,
  transcribeWithDeepgram,
  transcribeWithLocalProvider,
} from "./providers.js";
import { loadCachedTranscriptForAsset } from "./transcribe.js";

const FRAGMENT_MAX_MS = 200;
const NEIGHBOR_CUT_MS = OPEN_STANDARDS.DIALOGUE_CLEANUP.MAX_PAD_MS;
const NEAR_PRESERVED_MS = 1000;
const LENIENT_MATCH_SIMILARITY = 0.6;

export interface VerifyCleanupOptions {
  workspaceDir: string;
  clipId?: string;
  clipIds?: string[];
  allSpine?: boolean;
  provider?: AsrProviderId | string;
  language?: string;
}

export interface VerifyMissingWord {
  word: string;
  sequence_start_ms: number;
  sequence_end_ms: number;
  source_start_ms: number;
  source_end_ms: number;
  clip_id: string | null;
  neighbor_cut_id?: string;
}

export interface VerifyUnexpectedWord {
  word: string;
  sequence_start_ms: number;
  sequence_end_ms: number;
  duration_ms: number;
  fragment_candidate: boolean;
}

export interface VerifySubstitutedWord {
  expected: string;
  heard: string;
  similarity: number;
  sequence_start_ms: number;
  sequence_end_ms: number;
  source_start_ms: number;
  source_end_ms: number;
  clip_id: string | null;
}

export interface VerifyPreservedLink {
  clip_id: string;
  source_start_ms: number;
  source_end_ms: number;
  sequence_start_ms: number;
  sequence_end_ms: number;
  duration_ms: number;
  max_dbfs: number;
}

export interface VerifyRepeatedPhrase {
  phrase: string;
  words: string[];
  occurrences: number;
  sequence_start_ms: number;
  sequence_end_ms: number;
  repeats: Array<{ sequence_start_ms: number; sequence_end_ms: number }>;
  preserved_untranscribed?: VerifyPreservedLink;
}

export interface VerifyCleanupResult {
  dry_run: true;
  clip_id: string;
  clip_ids: string[];
  provider: AsrProviderId;
  language: string;
  cached: boolean;
  audio_sha256: string;
  audio_duration_ms: number;
  expected_word_count: number;
  heard_word_count: number;
  matched_word_count: number;
  match_rate: number;
  match_rate_lenient: number;
  missing_words: VerifyMissingWord[];
  repeated_phrases: VerifyRepeatedPhrase[];
  unexpected_words: VerifyUnexpectedWord[];
  substituted_words: VerifySubstitutedWord[];
}

interface ExpectedTok {
  word: string;
  norm: string;
  sequence_start_ms: number;
  sequence_end_ms: number;
  source_start_ms: number;
  source_end_ms: number;
  clip_id: string | null;
  asset_handle: string | null;
}

interface HeardTok {
  word: string;
  norm: string;
  sequence_start_ms: number;
  sequence_end_ms: number;
}

interface SourceGap {
  id: string;
  asset_handle: string;
  source_start_ms: number;
  source_end_ms: number;
}

function resolveProvider(
  explicit: string | undefined,
  docs: TranscriptDocument[]
): AsrProviderId {
  if (explicit !== undefined && explicit.trim() !== "") {
    const name = explicit.trim().toLowerCase();
    if (name !== "deepgram" && name !== "local") {
      throw new CutholError(
        DIAGNOSTICS.UNKNOWN_FLAG(
          `--provider ${explicit}`,
          "speech.verify-cleanup",
          "cuthol speech verify-cleanup --provider deepgram|local"
        )
      );
    }
    return name;
  }
  for (const doc of docs) {
    if (doc.provider === "local" || doc.provider === "deepgram") return doc.provider;
  }
  return "deepgram";
}

function rangeDistance(startA: number, endA: number, startB: number, endB: number): number {
  if (endA < startB) return startB - endA;
  if (endB < startA) return startA - endB;
  return 0;
}

function rangeOverlap(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function collectExciseGaps(clips: SpineClip[]): SourceGap[] {
  const byAsset = new Map<string, SpineClip[]>();
  for (const clip of clips) {
    const list = byAsset.get(clip.asset_handle) ?? [];
    list.push(clip);
    byAsset.set(clip.asset_handle, list);
  }
  const gaps: SourceGap[] = [];
  for (const [asset, list] of byAsset) {
    const sorted = list
      .slice()
      .sort((a, b) => a.source_in_ms - b.source_in_ms || a.timeline_in_ms - b.timeline_in_ms);
    for (let i = 0; i < sorted.length - 1; i++) {
      const prev = sorted[i];
      const next = sorted[i + 1];
      if (next.source_in_ms < prev.source_out_ms) continue;
      const gapStart = prev.source_out_ms;
      const gapEnd = next.source_in_ms;
      if (gapEnd - gapStart < 2) continue;
      gaps.push({
        id: `ex_${asset}_${gapStart}_${gapEnd}`,
        asset_handle: asset,
        source_start_ms: gapStart,
        source_end_ms: gapEnd,
      });
    }
  }
  return gaps;
}

function neighborCutId(word: ExpectedTok, gaps: SourceGap[]): string | undefined {
  if (!word.asset_handle) return undefined;
  let best: { id: string; dist: number } | undefined;
  for (const gap of gaps) {
    if (gap.asset_handle !== word.asset_handle) continue;
    const dist = rangeDistance(
      word.source_start_ms,
      word.source_end_ms,
      gap.source_start_ms,
      gap.source_end_ms
    );
    if (dist <= NEIGHBOR_CUT_MS && (!best || dist < best.dist)) {
      best = { id: gap.id, dist };
    }
  }
  return best?.id;
}

function audibleTargets(sequence: CutholSequence, targets: SpineClip[]): SpineClip[] {
  return targets.filter((clip) => {
    if (clip.audio_chain.muted) return false;
    const item = sequence.library.find((asset) => asset.handle === clip.asset_handle);
    return Boolean(item?.probe.has_audio);
  });
}

function buildExpectedWords(
  workspaceDir: string,
  sequence: CutholSequence,
  clips: SpineClip[],
  language: string
): { words: ExpectedTok[]; docsByHandle: Map<string, TranscriptDocument> } {
  const targetIds = new Set(clips.map((clip) => clip.id));
  const clipById = new Map(sequence.spine.clips.map((clip) => [clip.id, clip]));
  const docsByHandle = new Map<string, TranscriptDocument>();
  const words: ExpectedTok[] = [];
  const seenAssets = new Set<string>();

  for (const clip of clips) {
    if (seenAssets.has(clip.asset_handle)) continue;
    seenAssets.add(clip.asset_handle);
    const doc = loadCachedTranscriptForAsset(workspaceDir, clip.asset_handle, language);
    docsByHandle.set(clip.asset_handle, doc);
    const projected = projectTranscriptAcrossSequence(
      sequence,
      clip.asset_handle,
      doc.words.map((word) => ({
        word: word.punctuated_word || word.word,
        source_start_ms: word.source_start_ms,
        source_end_ms: word.source_end_ms,
        confidence: word.confidence,
      }))
    );
    for (const token of projected) {
      if (token.excised || token.sequence_start_ms === null || token.sequence_end_ms === null) continue;
      if (!token.clip_id || !targetIds.has(token.clip_id)) continue;
      const norm = normalizeTokenForMatch(token.word);
      if (!norm) continue;
      const owner = clipById.get(token.clip_id);
      words.push({
        word: token.word,
        norm,
        sequence_start_ms: token.sequence_start_ms,
        sequence_end_ms: token.sequence_end_ms,
        source_start_ms: token.source_start_ms,
        source_end_ms: token.source_end_ms,
        clip_id: token.clip_id,
        asset_handle: owner?.asset_handle ?? clip.asset_handle,
      });
    }
  }

  words.sort(
    (a, b) => a.sequence_start_ms - b.sequence_start_ms || a.source_start_ms - b.source_start_ms
  );
  return { words, docsByHandle };
}

function preservedSpansForClip(
  clip: SpineClip,
  words: RawTranscriptWord[],
  profile: AcousticWindowProfile
): VerifyPreservedLink[] {
  const windowMs = Math.max(1, profile.window_ms || 25);
  const floor = profile.silence_floor_dbfs;
  const minMs = OPEN_STANDARDS.DIALOGUE_CLEANUP.MIN_UNTRANSCRIBED_SPEECH_MS;
  const sorted = words
    .slice()
    .sort((a, b) => a.source_start_ms - b.source_start_ms || a.source_end_ms - b.source_end_ms);
  const startWin = Math.max(0, Math.floor(clip.source_in_ms / windowMs));
  const endWin = Math.min(profile.window_dbfs.length, Math.ceil(clip.source_out_ms / windowMs));
  const spans: VerifyPreservedLink[] = [];
  let runStart: number | null = null;
  let runMax = -96;
  let wordIdx = 0;

  const flush = (endWinExclusive: number): void => {
    if (runStart === null) return;
    const startMs = Math.max(clip.source_in_ms, runStart * windowMs);
    const endMs = Math.min(clip.source_out_ms, endWinExclusive * windowMs);
    if (endMs - startMs >= minMs) {
      const seqStart = sourceMsToSequenceMs(clip, startMs);
      const seqEnd = Math.max(seqStart + 1, sourceMsToSequenceMs(clip, endMs));
      spans.push({
        clip_id: clip.id,
        source_start_ms: startMs,
        source_end_ms: endMs,
        sequence_start_ms: seqStart,
        sequence_end_ms: seqEnd,
        duration_ms: endMs - startMs,
        max_dbfs: Number(runMax.toFixed(2)),
      });
    }
    runStart = null;
    runMax = -96;
  };

  for (let w = startWin; w < endWin; w++) {
    const wStart = w * windowMs;
    const wEnd = wStart + windowMs;
    while (wordIdx < sorted.length && sorted[wordIdx].source_end_ms <= wStart) wordIdx++;
    const transcribed =
      wordIdx < sorted.length && sorted[wordIdx].source_start_ms < wEnd && sorted[wordIdx].source_end_ms > wStart;
    const active = profile.window_dbfs[w] > floor;
    if (active && !transcribed) {
      if (runStart === null) runStart = w;
      runMax = Math.max(runMax, profile.window_dbfs[w]);
    } else {
      flush(w);
    }
  }
  flush(endWin);
  return spans;
}

function collectPreservedSpans(
  workspaceDir: string,
  clips: SpineClip[],
  docsByHandle: Map<string, TranscriptDocument>
): VerifyPreservedLink[] {
  const spans: VerifyPreservedLink[] = [];
  const profiles = new Map<string, AcousticWindowProfile | null>();
  for (const clip of clips) {
    const doc = docsByHandle.get(clip.asset_handle);
    if (!doc) continue;
    if (!profiles.has(clip.asset_handle)) {
      try {
        profiles.set(
          clip.asset_handle,
          measureAssetAcousticWindows({ workspaceDir, handle: clip.asset_handle })
        );
      } catch {
        profiles.set(clip.asset_handle, null);
      }
    }
    const profile = profiles.get(clip.asset_handle);
    if (!profile) continue;
    spans.push(...preservedSpansForClip(clip, doc.words, profile));
  }
  return spans;
}

/**
 * Renders selected spine clips through the shared audio compiler.
 * Lanes (music, voiceover, sfx) are omitted. Master-bus finalize stays off:
 * that gain and limiter were calibrated for the full mix, not for the speech chain.
 */
function renderSpineSpeechWav(
  sequence: CutholSequence,
  paths: WorkspacePaths,
  clips: SpineClip[]
): { wavPath: string; durationMs: number } {
  const audioSeq = structuredClone(sequence);
  audioSeq.lanes = [];
  const keep = new Set(clips.map((clip) => clip.id));
  for (const clip of audioSeq.spine.clips) {
    if (!keep.has(clip.id)) {
      clip.audio_chain = { ...clip.audio_chain, muted: true };
    }
  }
  const plan = compileSequenceAudioPlan(audioSeq, paths, undefined, { applyMasterFinalize: false });
  fs.mkdirSync(paths.blobsDir, { recursive: true });
  const wavPath = path.join(paths.blobsDir, `verify_cleanup_${process.pid}_${Date.now()}.wav`);
  const filterScriptPath = `${wavPath}.filter.txt`;
  const useScript =
    plan.filterComplex.length > 4000 ||
    estimateCommandLineLength("ffmpeg", plan.inputArgs) + plan.filterComplex.length > 12000;
  if (useScript) fs.writeFileSync(filterScriptPath, plan.filterComplex, "utf8");
  const ffArgs = [
    "-y",
    "-v",
    "error",
    ...plan.inputArgs,
    ...(useScript ? ["-/filter_complex", filterScriptPath] : ["-filter_complex", plan.filterComplex]),
    "-map",
    plan.audioOutPad,
    "-t",
    (plan.totalDurationMs / 1000).toFixed(3),
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    wavPath,
  ];
  let proc;
  try {
    proc = spawnWatchedSync("ffmpeg", ffArgs, {
      cwd: paths.rootDir,
      encoding: "utf8",
      step: "ffmpeg verify-cleanup speech",
      watchedPaths: [wavPath],
    });
  } finally {
    if (fs.existsSync(filterScriptPath)) {
      try {
        fs.unlinkSync(filterScriptPath);
      } catch {
        // ignore
      }
    }
  }
  const wavOk = fs.existsSync(wavPath) && fs.statSync(wavPath).size > 44;
  if (proc.error || proc.status !== 0 || !wavOk) {
    if (fs.existsSync(wavPath)) {
      try {
        fs.unlinkSync(wavPath);
      } catch {
        // ignore
      }
    }
    throw new CutholError(
      createSubprocessFailureDiagnostic({
        tool: "ffmpeg verify-cleanup speech",
        executable: "ffmpeg",
        args: ffArgs,
        proc,
        clipCount: clips.length,
        fallbackDetail: "spine speech export failed",
      })
    );
  }
  return { wavPath, durationMs: plan.totalDurationMs };
}

function clampTranscript(doc: TranscriptDocument, durationMs: number): TranscriptDocument {
  const maxDur = Math.max(1, Math.round(durationMs));
  const words = doc.words
    .filter((word) => word.source_start_ms < maxDur)
    .map((word) => {
      const st = Math.max(0, Math.min(maxDur - 1, word.source_start_ms));
      const en = Math.max(st + 1, Math.min(maxDur, word.source_end_ms));
      return { ...word, source_start_ms: st, source_end_ms: en };
    });
  return { ...doc, duration_ms: maxDur, words };
}

async function transcribeRenderedSpeech(options: {
  paths: WorkspacePaths;
  wavPath: string;
  durationMs: number;
  provider: AsrProviderId;
  language: string;
}): Promise<{ doc: TranscriptDocument; sha256: string; cached: boolean }> {
  const sha256 = sha256File(options.wavPath);
  const cacheKey = `${options.provider}:${options.language}`;
  const ledger = new MediaLedger(options.paths.ledgerFile);
  try {
    const cached = ledger.getTranscript<TranscriptDocument>(sha256, cacheKey);
    if (cached) return { doc: cached, sha256, cached: true };
    const fresh =
      options.provider === "local"
        ? await transcribeWithLocalProvider({
            audioFilePath: options.wavPath,
            language: options.language,
            durationMs: options.durationMs,
          })
        : await transcribeWithDeepgram({
            audioFilePath: options.wavPath,
            language: options.language,
            durationMs: options.durationMs,
          });
    const doc = clampTranscript(fresh, options.durationMs);
    ledger.setTranscript(sha256, cacheKey, doc);
    return { doc, sha256, cached: false };
  } finally {
    ledger.close();
  }
}

function heardTokens(doc: TranscriptDocument): HeardTok[] {
  const tokens: HeardTok[] = [];
  const sorted = doc.words
    .slice()
    .sort((a, b) => a.source_start_ms - b.source_start_ms || a.source_end_ms - b.source_end_ms);
  for (const word of sorted) {
    const display = word.punctuated_word || word.word;
    const norm = normalizeTokenForMatch(display) || normalizeTokenForMatch(word.word);
    if (!norm) continue;
    tokens.push({
      word: display,
      norm,
      sequence_start_ms: word.source_start_ms,
      sequence_end_ms: word.source_end_ms,
    });
  }
  return tokens;
}

function levenshteinChars(a: string, b: string): number {
  const aa = Array.from(a);
  const bb = Array.from(b);
  const n = aa.length;
  const m = bb.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[n][m];
}

function charSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(Array.from(a).length, Array.from(b).length);
  if (maxLen === 0) return 1;
  const score = 1 - levenshteinChars(a, b) / maxLen;
  return Math.round(Math.max(0, Math.min(1, score)) * 10000) / 10000;
}

function alignWords(
  expected: ExpectedTok[],
  heard: HeardTok[]
): {
  missing: ExpectedTok[];
  unexpected: HeardTok[];
  substituted: Array<{ expected: ExpectedTok; heard: HeardTok; similarity: number }>;
  matched: number;
} {
  const n = expected.length;
  const m = heard.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = expected[i - 1].norm === heard[j - 1].norm ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + sub);
    }
  }

  const missingRev: ExpectedTok[] = [];
  const unexpectedRev: HeardTok[] = [];
  const substitutedRev: Array<{ expected: ExpectedTok; heard: HeardTok; similarity: number }> = [];
  let matched = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      expected[i - 1].norm === heard[j - 1].norm &&
      dp[i][j] === dp[i - 1][j - 1]
    ) {
      matched++;
      i--;
      j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      // A paired token with a different spelling stays a substitution at every
      // similarity. It is not also a deletion or an insertion.
      const exp = expected[i - 1];
      const got = heard[j - 1];
      substitutedRev.push({
        expected: exp,
        heard: got,
        similarity: charSimilarity(exp.norm, got.norm),
      });
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      missingRev.push(expected[i - 1]);
      i--;
    } else {
      unexpectedRev.push(heard[j - 1]);
      j--;
    }
  }
  return {
    missing: missingRev.reverse(),
    unexpected: unexpectedRev.reverse(),
    substituted: substitutedRev.reverse(),
    matched,
  };
}

function findRepeatedPhrases(heard: HeardTok[], spans: VerifyPreservedLink[]): VerifyRepeatedPhrase[] {
  const phrases: VerifyRepeatedPhrase[] = [];
  const n = heard.length;
  let i = 0;
  while (i < n) {
    let best = 0;
    const maxLen = Math.floor((n - i) / 2);
    for (let len = maxLen; len >= 2; len--) {
      let same = true;
      for (let k = 0; k < len; k++) {
        if (heard[i + k].norm !== heard[i + len + k].norm) {
          same = false;
          break;
        }
      }
      if (same) {
        best = len;
        break;
      }
    }
    if (best === 0) {
      i++;
      continue;
    }
    let times = 2;
    while (i + (times + 1) * best <= n) {
      let same = true;
      for (let k = 0; k < best; k++) {
        if (heard[i + k].norm !== heard[i + times * best + k].norm) {
          same = false;
          break;
        }
      }
      if (!same) break;
      times++;
    }
    const repeats: Array<{ sequence_start_ms: number; sequence_end_ms: number }> = [];
    for (let t = 0; t < times; t++) {
      const slice = heard.slice(i + t * best, i + (t + 1) * best);
      repeats.push({
        sequence_start_ms: slice[0].sequence_start_ms,
        sequence_end_ms: slice[slice.length - 1].sequence_end_ms,
      });
    }
    const phraseStart = repeats[0].sequence_start_ms;
    const phraseEnd = repeats[repeats.length - 1].sequence_end_ms;
    let linked: { span: VerifyPreservedLink; dist: number; overlap: number } | undefined;
    for (const span of spans) {
      const dist = rangeDistance(
        phraseStart,
        phraseEnd,
        span.sequence_start_ms,
        span.sequence_end_ms
      );
      if (dist > NEAR_PRESERVED_MS) continue;
      const overlap = rangeOverlap(
        phraseStart,
        phraseEnd,
        span.sequence_start_ms,
        span.sequence_end_ms
      );
      if (
        !linked ||
        dist < linked.dist ||
        (dist === linked.dist && overlap > linked.overlap)
      ) {
        linked = { span, dist, overlap };
      }
    }
    phrases.push({
      phrase: heard
        .slice(i, i + best)
        .map((word) => word.word)
        .join(" "),
      words: heard.slice(i, i + best).map((word) => word.norm),
      occurrences: times,
      sequence_start_ms: phraseStart,
      sequence_end_ms: phraseEnd,
      repeats,
      ...(linked ? { preserved_untranscribed: linked.span } : {}),
    });
    i += times * best;
  }
  return phrases;
}

function roundRate(matched: number, expected: number, heard: number): number {
  const rate = expected === 0 ? (heard === 0 ? 1 : 0) : matched / expected;
  return Math.round(rate * 10000) / 10000;
}

export async function verifyCleanup(options: VerifyCleanupOptions): Promise<VerifyCleanupResult> {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  loadDotEnvIfNeeded(paths.rootDir);
  const language = (options.language ?? "tr").toLowerCase();
  const targets = resolveCleanupTargetClips(sequence, {
    clipId: options.clipId,
    clipIds: options.clipIds,
    allSpine: options.allSpine,
  });
  const clips = audibleTargets(sequence, targets);
  if (clips.length === 0) {
    throw new CutholError(
      DIAGNOSTICS.NO_AUDIO_STREAM(targets[0]?.asset_handle ?? targets[0]?.id ?? "spine")
    );
  }

  const { words: expected, docsByHandle } = buildExpectedWords(
    options.workspaceDir,
    sequence,
    clips,
    language
  );
  const provider = resolveProvider(
    typeof options.provider === "string" ? options.provider : undefined,
    [...docsByHandle.values()]
  );
  const preserved = collectPreservedSpans(options.workspaceDir, clips, docsByHandle);
  const gaps = collectExciseGaps(sequence.spine.clips);

  const rendered = renderSpineSpeechWav(sequence, paths, clips);
  let heardDoc: TranscriptDocument;
  let sha256: string;
  let cached: boolean;
  try {
    const transcribed = await transcribeRenderedSpeech({
      paths,
      wavPath: rendered.wavPath,
      durationMs: rendered.durationMs,
      provider,
      language,
    });
    heardDoc = transcribed.doc;
    sha256 = transcribed.sha256;
    cached = transcribed.cached;
  } finally {
    if (fs.existsSync(rendered.wavPath)) {
      try {
        fs.unlinkSync(rendered.wavPath);
      } catch {
        // ignore
      }
    }
  }

  const heard = heardTokens(heardDoc);
  const aligned = alignWords(expected, heard);
  const missing_words: VerifyMissingWord[] = aligned.missing.map((word) => {
    const cut = neighborCutId(word, gaps);
    return {
      word: word.word,
      sequence_start_ms: word.sequence_start_ms,
      sequence_end_ms: word.sequence_end_ms,
      source_start_ms: word.source_start_ms,
      source_end_ms: word.source_end_ms,
      clip_id: word.clip_id,
      ...(cut ? { neighbor_cut_id: cut } : {}),
    };
  });
  const unexpected_words: VerifyUnexpectedWord[] = aligned.unexpected.map((word) => {
    const duration_ms = Math.max(1, word.sequence_end_ms - word.sequence_start_ms);
    return {
      word: word.word,
      sequence_start_ms: word.sequence_start_ms,
      sequence_end_ms: word.sequence_end_ms,
      duration_ms,
      fragment_candidate: duration_ms <= FRAGMENT_MAX_MS,
    };
  });
  const substituted_words: VerifySubstitutedWord[] = aligned.substituted.map((item) => ({
    expected: item.expected.word,
    heard: item.heard.word,
    similarity: item.similarity,
    sequence_start_ms: item.expected.sequence_start_ms,
    sequence_end_ms: item.expected.sequence_end_ms,
    source_start_ms: item.expected.source_start_ms,
    source_end_ms: item.expected.source_end_ms,
    clip_id: item.expected.clip_id,
  }));
  const lenientMatched =
    aligned.matched +
    aligned.substituted.filter((item) => item.similarity >= LENIENT_MATCH_SIMILARITY).length;

  return {
    dry_run: true,
    clip_id: clips[0].id,
    clip_ids: clips.map((clip) => clip.id),
    provider,
    language,
    cached,
    audio_sha256: sha256,
    audio_duration_ms: rendered.durationMs,
    expected_word_count: expected.length,
    heard_word_count: heard.length,
    matched_word_count: aligned.matched,
    match_rate: roundRate(aligned.matched, expected.length, heard.length),
    match_rate_lenient: roundRate(lenientMatched, expected.length, heard.length),
    missing_words,
    repeated_phrases: findRepeatedPhrases(heard, preserved),
    unexpected_words,
    substituted_words,
  };
}
