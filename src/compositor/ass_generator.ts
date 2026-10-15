/**
 * Advanced SubStation Alpha (`.ass`) Typography & Active-Word Highlight Compiler (`src/compositor/ass_generator.ts`).
 *
 * Compiles Cuthol `title` and `caption` lane cues into a deterministic UTF-8 `.ass`
 * script rendered by FFmpeg's built-in `libass` (`ass`) filter.
 * Supports:
 * - Full UTF-8 (including Turkish `ğüşiöçĞÜŞİÖÇ`)
 * - Exact pixel positioning (`\pos(x,y)`) from `placement.x_pct` / `placement.y_pct`
 * - Custom font size, stroke outline (`\bord`), and background box (`BorderStyle=3`)
 * - Word-by-word active highlight (`active_word_color_hex` across `TimedWordToken[]` intervals)
 */

import fs from "node:fs";
import path from "node:path";
import { resolveCueStartMs } from "../brief/inspector.js";
import { CutholSequence, LaneCue } from "../core/schema.js";

/**
 * Converts a CSS hex color (`#RRGGBB`) and opacity (`0..1`) into ASS `&HAABBGGRR` format
 * (where AA=00 is opaque and AA=FF is transparent).
 */
export function hexToAssColor(hex: string, opacity = 1.0): string {
  const clean = hex.replace(/^#/, "").trim();
  const r = clean.slice(0, 2) || "FF";
  const g = clean.slice(2, 4) || "FF";
  const b = clean.slice(4, 6) || "FF";
  const alphaByte = Math.max(0, Math.min(255, Math.round((1 - opacity) * 255)));
  const aa = alphaByte.toString(16).padStart(2, "0").toUpperCase();
  return `&H${aa}${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
}

/**
 * Formats integer milliseconds into ASS timestamp `H:MM:SS.cc` (centiseconds).
 */
export function formatAssTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const totalCs = Math.floor(clamped / 10);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hr = Math.floor(totalMin / 60);
  return `${hr}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(raw: string): string {
  return raw
    .replace(/\\N/g, "\n")
    .replace(/\\/g, "/")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, "\\N");
}

/**
 * Deterministically wraps plain text into lines that fit within `stageWidth * (maxWidthPct / 100)`
 * so that both `libass` (via explicit `\N`) and `measureCuePixelBox` always agree on line breaks.
 */
export function wrapTypographyLines(
  text: string,
  fontSizePx: number,
  stageWidth: number,
  maxWidthPct: number
): { lines: string[]; maxLineWidthPx: number } {
  const maxBoxWidthPx = stageWidth * (Math.max(15, Math.min(95, maxWidthPct)) / 100);
  const avgCharPx = fontSizePx * 0.55;
  const paragraphs = text.replace(/\\N/g, "\n").split(/\r?\n/);
  const wrappedLines: string[] = [];
  let maxLineWidthPx = 0;

  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    let currentLine = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${currentLine} ${words[i]}`;
      if (candidate.length * avgCharPx <= maxBoxWidthPx) {
        currentLine = candidate;
      } else {
        wrappedLines.push(currentLine);
        maxLineWidthPx = Math.max(maxLineWidthPx, currentLine.length * avgCharPx);
        currentLine = words[i];
      }
    }
    wrappedLines.push(currentLine);
    maxLineWidthPx = Math.max(maxLineWidthPx, currentLine.length * avgCharPx);
  }

  if (wrappedLines.length === 0) {
    wrappedLines.push("");
  }

  return { lines: wrappedLines, maxLineWidthPx };
}

export function compileTypographyAssFile(
  seq: CutholSequence,
  outputPath: string,
  targetLaneIds?: Set<string>
): { hasTypographyCues: boolean; cuesCount: number; filePath: string } {
  const lines: string[] = [
    "[Script Info]",
    "Title: Cuthol Typography Layer",
    "ScriptType: v4.00+",
    `PlayResX: ${seq.stage.width}`,
    `PlayResY: ${seq.stage.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  ];

  const dialogueEvents: string[] = [];
  let cueCounter = 0;

  const sortedLanes = [...seq.lanes].sort((a, b) => a.z_index - b.z_index);

  for (const lane of sortedLanes) {
    if (lane.muted) continue;
    if (targetLaneIds && !targetLaneIds.has(lane.id)) continue;
    for (const cue of lane.cues) {
      if (!cue.typography || !cue.typography.text.trim()) continue;
      cueCounter++;

      const typo = cue.typography;
      const styleName = `Style_${cue.id}`;
      // Respect typo.font_family and sanitize commas
      const fontName = (typo.font_family || "Arial").replace(/,/g, "").trim() || "Arial";
      const primaryColor = hexToAssColor(typo.color_hex, cue.placement.opacity);
      const outlineColor = typo.box_color_hex
        ? hexToAssColor(typo.box_color_hex, typo.box_opacity > 0 ? typo.box_opacity : 0.85)
        : hexToAssColor(typo.stroke_color_hex ?? "#000000", cue.placement.opacity);
      const backColor = hexToAssColor("#000000", 0.5);
      const borderStyle = typo.box_color_hex ? 3 : 1;
      const outlineWidth = typo.box_color_hex ? 14 : Math.max(1, typo.stroke_width_px);
      const shadowDepth = typo.box_color_hex ? 0 : 2;
      const boldFlag = typo.font_weight >= 600 ? -1 : 0;
      const scaleX = Math.round(cue.placement.scale_x * 100);
      const scaleY = Math.round(cue.placement.scale_y * 100);
      const marginSide = Math.round(
        seq.stage.width * ((100 - Math.min(95, Math.max(20, typo.max_width_pct))) / 200)
      );

      lines.push(
        `Style: ${styleName},${fontName},${typo.font_size_px},${primaryColor},${primaryColor},${outlineColor},${backColor},${boldFlag},0,0,0,${scaleX},${scaleY},0,0,${borderStyle},${outlineWidth},${shadowDepth},5,${marginSide},${marginSide},20,1`
      );

      const startMs = resolveCueStartMs(seq, cue);
      const endMs = startMs + cue.duration_ms;
      const posX = Math.round(seq.stage.width * 0.5 + (cue.placement.x_pct / 100) * seq.stage.width);
      const posY = Math.round(seq.stage.height * 0.5 + (cue.placement.y_pct / 100) * seq.stage.height);
      const layer = Math.max(0, lane.z_index + 50);

      // Check if word-by-word active highlight is requested (skip any excised words with sequence_start_ms === null)
      const activeWords = (typo.words ?? []).filter(
        (w): w is typeof w & { sequence_start_ms: number; sequence_end_ms: number } =>
          !w.excised && w.sequence_start_ms !== null && w.sequence_end_ms !== null
      );

      if (activeWords.length > 0 && typo.active_word_color_hex) {
        const activeColor = hexToAssColor(typo.active_word_color_hex, cue.placement.opacity);
        const normalColor = primaryColor;
        const safeWords = activeWords.map((tok) => escapeAssText(tok.word).trim());

        // Compute deterministic line-break separators (" " vs "\\N") across activeWords
        // using the exact same width heuristic as wrapTypographyLines (`measureCuePixelBox` agreement)
        const maxBoxWidthPx = seq.stage.width * (Math.max(15, Math.min(95, typo.max_width_pct)) / 100);
        const avgCharPx = typo.font_size_px * 0.55;
        const wordSeparators: string[] = [];
        let currentLineLen = (safeWords[0] ?? "").length;
        for (let i = 1; i < safeWords.length; i++) {
          const wLen = safeWords[i].length;
          if ((currentLineLen + 1 + wLen) * avgCharPx <= maxBoxWidthPx) {
            wordSeparators.push(" ");
            currentLineLen += 1 + wLen;
          } else {
            wordSeparators.push("\\N");
            currentLineLen = wLen;
          }
        }

        const joinWithWrappedBreaks = (tokens: string[]): string => {
          let out = tokens[0] ?? "";
          for (let i = 1; i < tokens.length; i++) {
            out += (wordSeparators[i - 1] ?? " ") + tokens[i];
          }
          return out;
        };

        const plainJoined = joinWithWrappedBreaks(safeWords);

        // If cue starts before the first word's sequence_start_ms, render unhighlighted phrase first
        const firstWordStart = Math.max(startMs, activeWords[0].sequence_start_ms);
        if (firstWordStart > startMs) {
          dialogueEvents.push(
            `Dialogue: ${layer},${formatAssTime(startMs)},${formatAssTime(firstWordStart)},${styleName},,0,0,0,,{\\an5\\pos(${posX},${posY})}${plainJoined}`
          );
        }

        let lastRenderedEnd = firstWordStart;
        for (let wIdx = 0; wIdx < activeWords.length; wIdx++) {
          const wToken = activeWords[wIdx];
          const wStart = Math.max(lastRenderedEnd, Math.max(startMs, wToken.sequence_start_ms));
          const naturalEnd =
            wIdx < activeWords.length - 1
              ? Math.max(wToken.sequence_end_ms, activeWords[wIdx + 1].sequence_start_ms)
              : wToken.sequence_end_ms;
          const wEnd = Math.min(endMs, Math.max(wStart + 20, naturalEnd));
          if (wEnd <= wStart) continue;

          const renderedTokens = safeWords.map((safeWord, j) => {
            if (j === wIdx) {
              return `{\\1c${activeColor}}${safeWord}{\\1c${normalColor}}`;
            }
            return safeWord;
          });

          dialogueEvents.push(
            `Dialogue: ${layer},${formatAssTime(wStart)},${formatAssTime(wEnd)},${styleName},,0,0,0,,{\\an5\\pos(${posX},${posY})}${joinWithWrappedBreaks(renderedTokens)}`
          );
          lastRenderedEnd = wEnd;
        }

        // If cue continues past the last word's end, hold unhighlighted phrase until endMs
        if (lastRenderedEnd < endMs) {
          dialogueEvents.push(
            `Dialogue: ${layer},${formatAssTime(lastRenderedEnd)},${formatAssTime(endMs)},${styleName},,0,0,0,,{\\an5\\pos(${posX},${posY})}${plainJoined}`
          );
        }
      } else {
        const { lines: wrapped } = wrapTypographyLines(
          typo.text,
          typo.font_size_px,
          seq.stage.width,
          typo.max_width_pct
        );
        const safeText = wrapped.map((l) => escapeAssText(l)).join("\\N");
        dialogueEvents.push(
          `Dialogue: ${layer},${formatAssTime(startMs)},${formatAssTime(endMs)},${styleName},,0,0,0,,{\\an5\\pos(${posX},${posY})}${safeText}`
        );
      }
    }
  }

  lines.push("");
  lines.push("[Events]");
  lines.push("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");
  lines.push(...dialogueEvents);
  lines.push("");

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  // Write with UTF-8 BOM so libass always detects UTF-8 on Windows
  fs.writeFileSync(outputPath, "\uFEFF" + lines.join("\r\n"), "utf8");

  return {
    hasTypographyCues: cueCounter > 0,
    cuesCount: cueCounter,
    filePath: path.resolve(outputPath),
  };
}
