/**
 * Phrase Repetition & Sentence Restart Candidate Detector (`src/speech/repetitions.ts`).
 *
 * Surfaces multi-word phrase repeats (2..6 words, including Turkish inflectional stem matches,
 * skipped discourse fillers, and single-slot lexical substitutions), clause/sentence restarts,
 * and immediate/pause-stalled word repeats as review candidates (`repetition_candidates`).
 *
 * Design:
 * - Candidates are NEVER cut automatically; the agent reviews the candidate table and selects
 *   which candidates (and optionally which attempt within a group to keep) via `cut_candidates`.
 * - Each candidate carries a persistent source-anchored ID (`rr_<asset>_<start>_<end>`) so IDs
 *   remain stable across dry-run calls and after spine splits/cuts.
 */

import { SpineClip } from "../core/schema.js";
import { sourceMsToSequenceMs } from "../sequence/spine.js";
import { normalizeTokenForMatch, RawTranscriptWord } from "./providers.js";

export interface RepetitionAttempt {
  attempt_id: string;
  attempt_index: number;
  text: string;
  source_start_ms: number;
  source_end_ms: number;
  cut_start_ms: number;
  cut_end_ms: number;
  word_start_index: number;
  word_end_index: number;
  role: "abandoned_attempt" | "repeated_phrase" | "kept_final";
  suggested_action: "cut" | "keep";
}

/** Candidates with a larger gap stay selectable but are listed apart from close repeats. */
export const DISTANT_REPETITION_GAP_MS = 8000;

export interface RepetitionRestartCandidate {
  id: string;
  kind: "phrase_repeat" | "sentence_restart" | "word_repeat";
  clip_id: string;
  asset_handle: string;
  matched_phrase: string;
  source_start_ms: number;
  source_end_ms: number;
  duration_ms: number;
  /** End of the first attempt to the start of the last attempt. */
  gap_ms: number;
  sequence_start_ms: number;
  sequence_end_ms: number;
  suggested_cut_start_ms: number;
  suggested_cut_end_ms: number;
  suggested_cut_duration_ms: number;
  suggested_keep_attempt: number;
  attempts: RepetitionAttempt[];
  context: string;
}

const DISCOURSE_STARTERS = new Set([
  "şimdi",
  "yani",
  "hani",
  "hatta",
  "fakat",
  "ama",
  "örneğin",
  "mesela",
  "bakın",
  "ya",
  "peki",
  "sonuçta",
]);

const SKIPPABLE_PARTICLES = new Set([
  "de",
  "da",
  "ki",
  "ya",
  "yani",
  "şey",
  "hani",
  "acaba",
  "bir",
  "bu",
  "şu",
  "o",
  "çok",
  "daha",
  "en",
  "hem",
  "ve",
  "veya",
  "gibi",
  "tabii",
  "dostlar",
  "abi",
  "arkadaşlar",
]);

const PURE_FUNCTION_WORDS = new Set([
  "bir",
  "bu",
  "şu",
  "o",
  "ve",
  "de",
  "da",
  "ki",
  "mi",
  "mı",
  "mu",
  "mü",
  "için",
  "gibi",
  "kadar",
  "olarak",
  "daha",
  "çok",
  "en",
  "her",
  "şey",
  "yani",
  "hani",
  "ama",
  "fakat",
  "tabii",
  "zaten",
  "böyle",
  "şöyle",
  "öyle",
  "var",
  "yok",
  "olsun",
  "nokta",
  "beş",
  "dört",
  "altı",
  "üç",
  "iki",
  "on",
  "yüz",
  "arada",
  "şekilde",
  "zaman",
  "zamanda",
  "tarz",
  "diye",
  "falan",
  "filan",
  "bile",
  "ise",
  "ben",
  "sen",
  "biz",
  "siz",
  "onlar",
  "bunu",
  "şunu",
  "onu",
  "buna",
  "şuna",
  "ona",
  "bunlar",
  "bunları",
  "bunların",
]);

const TURKISH_SUFFIXES = [
  "larından",
  "lerinden",
  "larımız",
  "lerimiz",
  "larını",
  "lerini",
  "larına",
  "lerine",
  "larında",
  "lerinde",
  "lardan",
  "lerden",
  "ların",
  "lerin",
  "larla",
  "lerle",
  "mamasını",
  "memesini",
  "masını",
  "mesini",
  "masına",
  "mesine",
  "maması",
  "memesi",
  "larının",
  "lerinin",
  "ları",
  "leri",
  "sını",
  "sini",
  "sunu",
  "sünü",
  "mızı",
  "mizi",
  "muzu",
  "müzü",
  "nızı",
  "nizi",
  "nuzu",
  "nüzü",
  "lığı",
  "liği",
  "luğu",
  "lüğü",
  "lık",
  "lik",
  "luk",
  "lük",
  "sı",
  "si",
  "su",
  "sü",
  "nda",
  "nde",
  "dan",
  "den",
  "tan",
  "ten",
  "maya",
  "meye",
  "ması",
  "mesi",
  "mak",
  "mek",
  "dık",
  "dik",
  "duk",
  "dük",
  "la",
  "le",
  "lı",
  "li",
  "lu",
  "lü",
  "ca",
  "ce",
  "ça",
  "çe",
  "ye",
  "ya",
  "yi",
  "yı",
  "yu",
  "yü",
  "in",
  "ın",
  "un",
  "ün",
  "im",
  "ım",
  "um",
  "üm",
  "de",
  "da",
  "te",
  "ta",
  "e",
  "a",
  "i",
  "ı",
  "u",
  "ü",
];

export function stemTurkishToken(raw: string): string {
  let w = normalizeTokenForMatch(raw).replace(/['’].*$/, "");
  if (w.length <= 3) return w;
  for (const s of TURKISH_SUFFIXES) {
    if (w.length - s.length >= 3 && w.endsWith(s)) {
      w = w.slice(0, w.length - s.length);
      break;
    }
  }
  if (w.endsWith("ğ")) w = `${w.slice(0, -1)}k`;
  if (w.endsWith("b") && w.length >= 4) w = `${w.slice(0, -1)}p`;
  if (w.endsWith("d") && w.length >= 4) w = `${w.slice(0, -1)}t`;
  if (w.endsWith("c") && w.length >= 4) w = `${w.slice(0, -1)}ç`;
  return w;
}

export function tokensRoughlyMatch(a: string, b: string): boolean {
  const na = normalizeTokenForMatch(a);
  const nb = normalizeTokenForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const sa = stemTurkishToken(na);
  const sb = stemTurkishToken(nb);
  if (sa.length >= 3 && sa === sb) return true;
  if (na.startsWith("yap") && nb.startsWith("yap") && na.length >= 5 && nb.length >= 5) {
    return true;
  }
  if (na.length >= 4 && nb.length >= 4) {
    let p = 0;
    while (p < na.length && p < nb.length && na[p] === nb[p]) p++;
    if (p >= 4 && p >= Math.min(na.length, nb.length) * 0.72) return true;
  }
  return false;
}

interface TokenInfo {
  idx: number;
  w: RawTranscriptWord;
  norm: string;
  stem: string;
  gapBefore: number;
  gapAfter: number;
  endsSentence: boolean;
  endsClause: boolean;
}

interface RawAttemptSpan {
  wordStartIdx: number;
  wordEndIdx: number;
  matchEndIdx: number;
}

interface RawCandidateGroup {
  kind: "phrase_repeat" | "sentence_restart" | "word_repeat";
  matchedPhrase: string;
  attempts: RawAttemptSpan[];
}

/**
 * Detects repetition and sentence-restart candidates across `transcriptWords`
 * and projects those intersecting `clip` (`[clip.source_in_ms .. clip.source_out_ms]`).
 */
export function detectRepetitionAndRestartCandidates(options: {
  clip: SpineClip;
  transcriptWords: RawTranscriptWord[];
  docDurationMs?: number;
}): RepetitionRestartCandidate[] {
  const { clip, transcriptWords } = options;
  const docDurationMs = options.docDurationMs ?? clip.source_out_ms;
  if (transcriptWords.length < 2) return [];

  const toks: TokenInfo[] = transcriptWords.map((w, idx) => {
    const norm = normalizeTokenForMatch(w.word);
    const gapBefore =
      idx > 0 ? Math.max(0, w.source_start_ms - transcriptWords[idx - 1].source_end_ms) : w.source_start_ms;
    const gapAfter =
      idx + 1 < transcriptWords.length
        ? Math.max(0, transcriptWords[idx + 1].source_start_ms - w.source_end_ms)
        : Math.max(0, docDurationMs - w.source_end_ms);
    const punct = String(w.punctuated_word || w.word).trim();
    const endsSentence = /[.!?…]+['"”’)\]]*$/.test(punct);
    const endsClause = endsSentence || /[,;:—–-]+$/.test(punct) || gapAfter >= 320;
    return {
      idx,
      w,
      norm,
      stem: stemTurkishToken(norm),
      gapBefore,
      gapAfter,
      endsSentence,
      endsClause,
    };
  });

  const rawGroups: RawCandidateGroup[] = [];

  // 1. Immediate single-word repeats, particle-bridged repeats ("yapalım ya yapalım"), and pause-stalled false starts ("Yani bugün <pause> bugün")
  let idx = 0;
  while (idx < toks.length - 1) {
    const cur = toks[idx];
    if (!cur.norm) {
      idx++;
      continue;
    }

    // 1a. Immediate identical word repeat (2 or more times in a row)
    if (cur.norm === toks[idx + 1].norm && cur.gapAfter < 1200 && !cur.endsSentence) {
      const attempts: RawAttemptSpan[] = [{ wordStartIdx: idx, wordEndIdx: idx, matchEndIdx: idx }];
      let k = idx + 1;
      while (
        k < toks.length &&
        toks[k].norm === cur.norm &&
        toks[k - 1].gapAfter < 1200 &&
        !toks[k - 1].endsSentence
      ) {
        attempts.push({ wordStartIdx: k, wordEndIdx: k, matchEndIdx: k });
        k++;
      }
      rawGroups.push({
        kind: "word_repeat",
        matchedPhrase: cur.norm,
        attempts,
      });
      idx = k;
      continue;
    }

    // 1b. Particle-bridged repeat: W <particle> W (e.g. "hatta yapalım ya yapalım")
    if (
      idx + 2 < toks.length &&
      tokensRoughlyMatch(cur.norm, toks[idx + 2].norm) &&
      SKIPPABLE_PARTICLES.has(toks[idx + 1].norm) &&
      toks[idx + 2].w.source_start_ms - cur.w.source_start_ms <= 2200
    ) {
      let startIdx = idx;
      if (
        idx > 0 &&
        DISCOURSE_STARTERS.has(toks[idx - 1].norm) &&
        cur.gapBefore < 350 &&
        (idx - 1 === 0 || toks[idx - 2].endsClause)
      ) {
        startIdx = idx - 1;
      }
      rawGroups.push({
        kind: "phrase_repeat",
        matchedPhrase: `${cur.norm} ${toks[idx + 1].norm} ${toks[idx + 2].norm}`,
        attempts: [
          { wordStartIdx: startIdx, wordEndIdx: idx + 1, matchEndIdx: idx },
          { wordStartIdx: idx + 2, wordEndIdx: idx + 2, matchEndIdx: idx + 2 },
        ],
      });
      idx += 3;
      continue;
    }

    // 1c. Pause-stalled 1-2 word false start: "[Yani] bugün <long pause >= 500ms> bugün ..."
    if (cur.gapAfter >= 500 && !cur.endsSentence) {
      let matchedNext = -1;
      for (let j = idx + 1; j <= Math.min(toks.length - 1, idx + 2); j++) {
        if (toks[j].w.source_start_ms - cur.w.source_end_ms > 8000) break;
        if (tokensRoughlyMatch(cur.norm, toks[j].norm)) {
          matchedNext = j;
          break;
        }
      }
      if (matchedNext !== -1) {
        let startIdx = idx;
        if (
          idx > 0 &&
          DISCOURSE_STARTERS.has(toks[idx - 1].norm) &&
          cur.gapBefore < 450
        ) {
          startIdx = idx - 1;
        }
        rawGroups.push({
          kind: "sentence_restart",
          matchedPhrase: cur.norm,
          attempts: [
            { wordStartIdx: startIdx, wordEndIdx: matchedNext - 1, matchEndIdx: idx },
            { wordStartIdx: matchedNext, wordEndIdx: matchedNext, matchEndIdx: matchedNext },
          ],
        });
        idx = matchedNext;
        continue;
      }
    }

    idx++;
  }

  // 2. Multi-word phrase repeats and clause restarts (2..6 words)
  for (let i = 0; i < toks.length - 2; i++) {
    if (!toks[i].norm) continue;
    for (let j = i + 1; j < toks.length - 1; j++) {
      const dt = toks[j].w.source_start_ms - toks[i].w.source_start_ms;
      if (dt > 20000 || j - i > 36) break;
      if (!tokensRoughlyMatch(toks[i].norm, toks[j].norm)) continue;

      // Only start a phrase alignment at a maximal left edge (skip shifted suffixes of an earlier alignment)
      if (
        i > 0 &&
        j > i + 1 &&
        tokensRoughlyMatch(toks[i - 1].norm, toks[j - 1].norm) &&
        toks[i].gapBefore < 600 &&
        toks[j].gapBefore < 600
      ) {
        continue;
      }

      let p = i;
      let q = j;
      const matchedWords: string[] = [toks[i].norm];
      let substitutions = 0;

      while (matchedWords.length < 7 && p + 1 < j && q + 1 < toks.length) {
        if (toks[p].endsSentence || toks[q].endsSentence) break;
        const pPauseBreak =
          toks[p].gapAfter >= 1200 ||
          (toks[p].gapAfter >= 600 &&
            (DISCOURSE_STARTERS.has(toks[p].norm) ||
              /[,;:—–-]+$/.test(String(toks[p].w.punctuated_word || ""))));
        const qPauseBreak =
          toks[q].gapAfter >= 1200 ||
          (toks[q].gapAfter >= 600 &&
            (DISCOURSE_STARTERS.has(toks[q].norm) ||
              /[,;:—–-]+$/.test(String(toks[q].w.punctuated_word || ""))));
        if (pPauseBreak || qPauseBreak) break;

        if (tokensRoughlyMatch(toks[p + 1].norm, toks[q + 1].norm)) {
          p++;
          q++;
          matchedWords.push(toks[p].norm);
        } else if (
          p + 2 < j &&
          !toks[p + 1].endsSentence &&
          toks[p + 1].gapAfter < 650 &&
          SKIPPABLE_PARTICLES.has(toks[p + 1].norm) &&
          tokensRoughlyMatch(toks[p + 2].norm, toks[q + 1].norm)
        ) {
          p += 2;
          q += 1;
          matchedWords.push(toks[p].norm);
        } else if (
          q + 2 < toks.length &&
          !toks[q + 1].endsSentence &&
          toks[q + 1].gapAfter < 650 &&
          SKIPPABLE_PARTICLES.has(toks[q + 1].norm) &&
          tokensRoughlyMatch(toks[p + 1].norm, toks[q + 2].norm)
        ) {
          p += 1;
          q += 2;
          matchedWords.push(toks[p].norm);
        } else if (
          substitutions === 0 &&
          p + 2 < j &&
          q + 2 < toks.length &&
          !toks[p + 1].endsSentence &&
          !toks[q + 1].endsSentence &&
          toks[p + 1].gapAfter < 650 &&
          toks[q + 1].gapAfter < 650 &&
          tokensRoughlyMatch(toks[p + 2].norm, toks[q + 2].norm)
        ) {
          substitutions++;
          p += 2;
          q += 2;
          matchedWords.push(toks[p].norm);
        } else {
          break;
        }
      }

      if (matchedWords.length < 2) continue;

      // Skip correlative "birinde ... birinde" or "hem X ... hem Y"
      if (toks[i].norm === "birinde" && toks[j].norm === "birinde" && j - i > 3) continue;
      if (toks[i].norm === "hem" && toks[j].norm === "hem" && substitutions > 0) continue;

      // Skip version numbers ("beş nokta beş [olsun]") when preceded by two DIFFERENT model names (enumeration)
      if (
        (toks[i].norm === "beş" || toks[i].norm === "nokta") &&
        i > 0 &&
        j > 0 &&
        !tokensRoughlyMatch(toks[i - 1].norm, toks[j - 1].norm) &&
        !DISCOURSE_STARTERS.has(toks[i - 1].norm)
      ) {
        continue;
      }

      const contentWords = matchedWords.filter(
        (w) => !PURE_FUNCTION_WORDS.has(w) && w.length >= 3
      );
      const isImmediate = j <= p + 2;
      if (contentWords.length === 0 && !isImmediate && matchedWords.length < 3) continue;
      if (matchedWords.length === 2 && contentWords.length <= 1 && !isImmediate && dt > 9000) {
        continue;
      }

      let iStart = i;
      if (
        iStart > 0 &&
        DISCOURSE_STARTERS.has(toks[iStart - 1].norm) &&
        toks[iStart].gapBefore < 450 &&
        toks[iStart - 1].norm !== "örneğin" &&
        (iStart - 1 === 0 || toks[iStart - 2].endsClause || DISCOURSE_STARTERS.has(toks[iStart - 2].norm))
      ) {
        iStart--;
      } else if (
        iStart >= 3 &&
        DISCOURSE_STARTERS.has(toks[iStart - 3].norm) &&
        toks[iStart - 2].norm === "sonuçta" &&
        toks[iStart].w.source_start_ms - toks[iStart - 3].w.source_start_ms < 1000
      ) {
        // e.g. "yani sonuçta ben RaspberryP'yi..."
        iStart -= 3;
      } else if (
        iStart >= 2 &&
        (iStart - 2 === 0 || toks[iStart - 3].endsSentence) &&
        toks[iStart - 2].gapBefore >= 400 &&
        toks[p].endsClause &&
        toks[p].gapAfter >= 600 &&
        p - iStart <= 2
      ) {
        // Short 3-4 word aborted clause after sentence break whose tail is repeated in the next clause (e.g. "Model zaten biz modelin, <pause> ... biz modelin")
        iStart -= 2;
      }

      // If attempt 1 is a short clause before attempt 2 restarts, extend attempt 1's end up to j - 1
      let iEnd = p;
      if (j - p <= 7) {
        iEnd = j - 1;
      }

      rawGroups.push({
        kind: j - p <= 7 ? "sentence_restart" : "phrase_repeat",
        matchedPhrase: matchedWords.join(" "),
        attempts: [
          { wordStartIdx: iStart, wordEndIdx: iEnd, matchEndIdx: p },
          { wordStartIdx: j, wordEndIdx: q, matchEndIdx: q },
        ],
      });
    }
  }

  // 2b. SOV short framing/aborted clause restart: a short clause (3..5 words) starting with a discourse marker
  // ("Hatta ben şöyle yapalım,") ending at a comma/pause whose clause-final verb is repeated at the end of the next clause.
  for (let i = 0; i < toks.length - 4; i++) {
    if (!DISCOURSE_STARTERS.has(toks[i].norm)) continue;
    if (i > 0 && !toks[i - 1].endsSentence && toks[i].gapBefore < 200) continue;
    let clauseEnd = -1;
    for (let k = i + 2; k <= Math.min(toks.length - 2, i + 4); k++) {
      if (toks[k].endsClause && !toks[k].endsSentence && toks[k].gapAfter >= 200) {
        clauseEnd = k;
        break;
      }
      if (toks[k].endsSentence) break;
    }
    if (clauseEnd === -1) continue;
    const verbTok = toks[clauseEnd];
    if (PURE_FUNCTION_WORDS.has(verbTok.norm) || verbTok.norm.length < 4) continue;
    for (let m = clauseEnd + 2; m <= Math.min(toks.length - 1, clauseEnd + 18); m++) {
      if (
        tokensRoughlyMatch(verbTok.norm, toks[m].norm) &&
        toks[m].w.source_end_ms - toks[i].w.source_start_ms <= 8000
      ) {
        rawGroups.push({
          kind: "sentence_restart",
          matchedPhrase: `${toks[i].norm} … ${verbTok.norm}`,
          attempts: [
            { wordStartIdx: i, wordEndIdx: clauseEnd, matchEndIdx: clauseEnd },
            { wordStartIdx: clauseEnd + 1, wordEndIdx: m, matchEndIdx: m },
          ],
        });
        break;
      }
      if (toks[m].endsSentence) break;
    }
  }

  if (rawGroups.length === 0) return [];

  // 3. Chain & deduplicate overlapping raw groups that share the same repeated phrase / attempt anchor
  rawGroups.sort(
    (a, b) =>
      a.attempts[0].wordStartIdx - b.attempts[0].wordStartIdx ||
      b.matchedPhrase.length - a.matchedPhrase.length
  );

  interface MergedCluster {
    kind: "phrase_repeat" | "sentence_restart" | "word_repeat";
    matchedPhrase: string;
    anchorNorm: string;
    attemptStarts: Map<number, RawAttemptSpan>;
    minWordIdx: number;
    maxWordIdx: number;
  }

  const clusters: MergedCluster[] = [];

  for (const g of rawGroups) {
    const gMin = g.attempts[0].wordStartIdx;
    const gMax = g.attempts[g.attempts.length - 1].wordEndIdx;
    const gAnchor = g.matchedPhrase.split(" ")[0] ?? "";

    // Check if this group chains with an existing cluster (shares an attempt start and same phrase opening,
    // or is a strict sub-span of an existing cluster with a longer matched phrase)
    let targetCluster: MergedCluster | null = null;
    let isRedundantSubgroup = false;

    for (const cl of clusters) {
      const gWordCount = g.matchedPhrase.split(" ").length;
      const clWordCount = cl.matchedPhrase.split(" ").length;
      const overlapsClusterAttempts = g.attempts.every((gAtt) => {
        for (const clAtt of cl.attemptStarts.values()) {
          if (
            Math.min(gAtt.matchEndIdx, clAtt.matchEndIdx) -
              Math.max(gAtt.wordStartIdx, clAtt.wordStartIdx) >=
            0
          ) {
            return true;
          }
        }
        return false;
      });
      if (overlapsClusterAttempts && gWordCount <= clWordCount) {
        isRedundantSubgroup = true;
        break;
      }
      if (
        gWordCount <= 2 &&
        clWordCount >= 3 &&
        g.attempts.some(
          (att) => att.wordStartIdx >= cl.minWordIdx && att.wordStartIdx <= cl.maxWordIdx
        ) &&
        cl.matchedPhrase.includes(g.matchedPhrase)
      ) {
        isRedundantSubgroup = true;
        break;
      }
      const sameAnchor = tokensRoughlyMatch(gAnchor, cl.anchorNorm);
      const sharesAttempt =
        sameAnchor &&
        g.attempts.some((att) => {
          for (const ex of cl.attemptStarts.values()) {
            if (Math.abs(att.wordStartIdx - ex.wordStartIdx) <= 1) return true;
          }
          return false;
        });
      if (sharesAttempt) {
        targetCluster = cl;
        break;
      }
    }

    if (isRedundantSubgroup) continue;

    if (!targetCluster) {
      const map = new Map<number, RawAttemptSpan>();
      for (const att of g.attempts) {
        map.set(att.wordStartIdx, { ...att });
      }
      clusters.push({
        kind: g.kind,
        matchedPhrase: g.matchedPhrase,
        anchorNorm: gAnchor,
        attemptStarts: map,
        minWordIdx: gMin,
        maxWordIdx: gMax,
      });
    } else {
      if (g.matchedPhrase.length > targetCluster.matchedPhrase.length) {
        targetCluster.matchedPhrase = g.matchedPhrase;
      }
      if (g.kind === "sentence_restart") {
        targetCluster.kind = "sentence_restart";
      }
      targetCluster.minWordIdx = Math.min(targetCluster.minWordIdx, gMin);
      targetCluster.maxWordIdx = Math.max(targetCluster.maxWordIdx, gMax);

      for (const att of g.attempts) {
        let existingKey: number | null = null;
        for (const k of targetCluster.attemptStarts.keys()) {
          if (Math.abs(k - att.wordStartIdx) <= 1) {
            existingKey = k;
            break;
          }
        }
        if (existingKey !== null) {
          const ex = targetCluster.attemptStarts.get(existingKey)!;
          ex.wordStartIdx = Math.min(ex.wordStartIdx, att.wordStartIdx);
          ex.wordEndIdx = Math.max(ex.wordEndIdx, att.wordEndIdx);
          ex.matchEndIdx = Math.max(ex.matchEndIdx, att.matchEndIdx);
        } else {
          targetCluster.attemptStarts.set(att.wordStartIdx, { ...att });
        }
      }
    }
  }

  const candidates: RepetitionRestartCandidate[] = [];

  for (const cl of clusters) {
    const sortedAttempts = [...cl.attemptStarts.values()].sort(
      (a, b) => a.wordStartIdx - b.wordStartIdx
    );
    if (sortedAttempts.length < 2) continue;

    // Normalize non-overlapping attempt spans: each earlier attempt i ends at most at sortedAttempts[i+1].wordStartIdx - 1
    for (let aIdx = 0; aIdx < sortedAttempts.length - 1; aIdx++) {
      const cur = sortedAttempts[aIdx];
      const nxt = sortedAttempts[aIdx + 1];
      if (cur.wordEndIdx >= nxt.wordStartIdx) {
        cur.wordEndIdx = Math.max(cur.wordStartIdx, nxt.wordStartIdx - 1);
      } else if (nxt.wordStartIdx - cur.wordEndIdx <= 5) {
        // Include trailing aborted words before the next restart attempt
        cur.wordEndIdx = nxt.wordStartIdx - 1;
      }
    }

    const firstWord = toks[sortedAttempts[0].wordStartIdx].w;
    const lastAttempt = sortedAttempts[sortedAttempts.length - 1];
    const lastWord = toks[lastAttempt.wordEndIdx].w;

    const rawGroupStartMs = firstWord.source_start_ms;
    const rawGroupEndMs = lastWord.source_end_ms;

    // Intersect with clip's active source window
    if (rawGroupEndMs <= clip.source_in_ms || rawGroupStartMs >= clip.source_out_ms) {
      continue;
    }

    // Persistent ID is anchored to asset_handle + raw transcript source bounds
    const candidateId = `rr_${clip.asset_handle}_${rawGroupStartMs}_${rawGroupEndMs}`;
    const keepAttemptIndex = sortedAttempts.length; // 1-based: default recommendation keeps the final attempt

    const builtAttempts: RepetitionAttempt[] = sortedAttempts.map((att, idx0) => {
      const attemptIndex = idx0 + 1;
      const isKept = attemptIndex === keepAttemptIndex;
      const wStart = toks[att.wordStartIdx].w;
      const wEnd = toks[att.wordEndIdx].w;
      const nextAttStartMs =
        idx0 + 1 < sortedAttempts.length
          ? toks[sortedAttempts[idx0 + 1].wordStartIdx].w.source_start_ms
          : wEnd.source_end_ms;

      const textTokens: string[] = [];
      for (let wi = att.wordStartIdx; wi <= att.wordEndIdx; wi++) {
        textTokens.push(toks[wi].w.punctuated_word || toks[wi].w.word);
      }

      return {
        attempt_id: `${candidateId}#${attemptIndex}`,
        attempt_index: attemptIndex,
        text: textTokens.join(" "),
        source_start_ms: wStart.source_start_ms,
        source_end_ms: wEnd.source_end_ms,
        cut_start_ms: wStart.source_start_ms,
        cut_end_ms: isKept ? wEnd.source_end_ms : nextAttStartMs,
        word_start_index: att.wordStartIdx,
        word_end_index: att.wordEndIdx,
        role: isKept
          ? "kept_final"
          : cl.kind === "sentence_restart"
            ? "abandoned_attempt"
            : "repeated_phrase",
        suggested_action: isKept ? "keep" : "cut",
      };
    });

    const suggestedCutStartMs = Math.max(clip.source_in_ms, builtAttempts[0].cut_start_ms);
    const suggestedCutEndMs = Math.min(
      clip.source_out_ms,
      builtAttempts[keepAttemptIndex - 2].cut_end_ms
    );
    if (suggestedCutEndMs <= suggestedCutStartMs) continue;

    // Build readable context window around the group
    const ctxPreStart = Math.max(0, sortedAttempts[0].wordStartIdx - 3);
    const ctxPostEnd = Math.min(toks.length - 1, lastAttempt.wordEndIdx + 3);
    const preWords: string[] = [];
    if (ctxPreStart > 0) preWords.push("…");
    for (let wi = ctxPreStart; wi < sortedAttempts[0].wordStartIdx; wi++) {
      preWords.push(toks[wi].w.punctuated_word || toks[wi].w.word);
    }
    const postWords: string[] = [];
    for (let wi = lastAttempt.wordEndIdx + 1; wi <= ctxPostEnd; wi++) {
      postWords.push(toks[wi].w.punctuated_word || toks[wi].w.word);
    }
    if (ctxPostEnd < toks.length - 1) postWords.push("…");

    const attemptSummary = builtAttempts
      .map((a) =>
        a.suggested_action === "keep"
          ? `[KEEP #${a.attempt_index}: ${a.text}]`
          : `[CUT #${a.attempt_index}: ${a.text}]`
      )
      .join(" -> ");

    const contextStr = [preWords.join(" "), attemptSummary, postWords.join(" ")]
      .filter(Boolean)
      .join(" ");

    const clampedStart = Math.max(clip.source_in_ms, rawGroupStartMs);
    const clampedEnd = Math.min(clip.source_out_ms, rawGroupEndMs);
    const gapMs =
      builtAttempts[builtAttempts.length - 1].source_start_ms - builtAttempts[0].source_end_ms;

    candidates.push({
      id: candidateId,
      kind: cl.kind,
      clip_id: clip.id,
      asset_handle: clip.asset_handle,
      matched_phrase: cl.matchedPhrase,
      source_start_ms: clampedStart,
      source_end_ms: clampedEnd,
      duration_ms: clampedEnd - clampedStart,
      gap_ms: gapMs,
      sequence_start_ms: sourceMsToSequenceMs(clip, clampedStart),
      sequence_end_ms: sourceMsToSequenceMs(clip, clampedEnd),
      suggested_cut_start_ms: suggestedCutStartMs,
      suggested_cut_end_ms: suggestedCutEndMs,
      suggested_cut_duration_ms: suggestedCutEndMs - suggestedCutStartMs,
      suggested_keep_attempt: keepAttemptIndex,
      attempts: builtAttempts,
      context: contextStr,
    });
  }

  return candidates;
}
