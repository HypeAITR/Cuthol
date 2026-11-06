// Spine clip stage 3 — colour treatment (`treatments.color_grade`, colour envelopes, LUT, temperature).
// Runs after crop/scale/mirror and before the clip fx chain; frames are still in the
// source pixel format here (RGB sources already `format=rgba`, everything else YUV in the BT.709 matrix selected by
// stage 2). `eq` and `colortemperature` run directly on either domain; `lut3d` runs on RGBA for RGB sources and on
// YUV444 (lifted around the filter) for YUV sources.
//
// Filter order inside this stage: `eq` (exposure/contrast/saturation, static or animated) → `colortemperature`
// (white balance) → `lut3d` (creative look last). A colour envelope always wins over the static value of the same
// channel; when neither is set the output is byte-identical to a compiler without colour envelopes, LUT or temperature.
import fs from "node:fs";
import path from "node:path";
import type { CutholSequence } from "../core/schema.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type { resolveSourceColorSpec } from "../library/probe.js";
import type { VideoGraphCompileContext } from "./compiler.js";
import { compileEnvelopeToFfmpegExpr, escapeFfmpegFilterPath } from "./compile_filters.js";

type SpineClipSpec = CutholSequence["spine"]["clips"][number];

/** Neutral white point: no `colortemperature` filter is emitted at this value (also the schema default). */
export const COLOR_TEMPERATURE_NEUTRAL_K = 6500;
/** Supported `temperature_k` range, matching the ffmpeg `colortemperature` filter (1000..40000 K). */
export const COLOR_TEMPERATURE_MIN_K = 1000;
export const COLOR_TEMPERATURE_MAX_K = 40000;
/** Accepted LUT container extensions (ffmpeg `lut3d` parses both). */
export const GRADE_LUT_EXTENSIONS = [".cube", ".3dl"] as const;

export function isSupportedColorTemperature(kelvin: unknown): kelvin is number {
  return (
    typeof kelvin === "number" &&
    Number.isFinite(kelvin) &&
    kelvin >= COLOR_TEMPERATURE_MIN_K &&
    kelvin <= COLOR_TEMPERATURE_MAX_K
  );
}

/**
 * Resolves a spine clip `lut_uri` to an absolute on-disk path.
 *
 * LUTs are project data files, not library assets: `library ingest` requires ffprobe-readable media, while a
 * `.cube`/`.3dl` file is lookup data. The value is therefore resolved like `composition_dir` — relative to the
 * project root — and an absolute path is accepted only when it stays inside the project root. Anything escaping the
 * project, an unsupported extension, or a missing/unreadable file raises G414 (render never starts).
 *
 * Colour-space assumption: the LUT runs on RGBA for RGB sources and on full-chroma YUV444 (lifted around
 * the filter, then restored to the input subsampling) for YUV sources, i.e. the LUT is authored for
 * BT.709/sRGB-gamma values with ffmpeg's default tetrahedral interpolation. No tone mapping is performed; HDR
 * (PQ/HLG) sources need an SDR grade first.
 */
export function resolveGradeLutPath(rootDir: string, clipId: string, lutUri: string): string {
  const raw = lutUri.trim();
  if (!raw) {
    throw new CutholError(DIAGNOSTICS.LUT_FILE_NOT_READABLE(clipId, lutUri, "empty LUT path"));
  }
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(rootDir, raw);
  const root = path.resolve(rootDir);
  const eqAbs = process.platform === "win32" ? abs.toLowerCase() : abs;
  const eqRoot = process.platform === "win32" ? root.toLowerCase() : root;
  if (eqAbs !== eqRoot && !eqAbs.startsWith(eqRoot + path.sep)) {
    throw new CutholError(
      DIAGNOSTICS.LUT_FILE_NOT_READABLE(clipId, lutUri, "path escapes the project folder")
    );
  }
  const ext = path.extname(abs).toLowerCase();
  if (!(GRADE_LUT_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new CutholError(
      DIAGNOSTICS.LUT_FILE_NOT_READABLE(
        clipId,
        lutUri,
        `unsupported extension '${ext || "(none)"}' (only .cube/.3dl)`
      )
    );
  }
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) {
      throw new CutholError(
        DIAGNOSTICS.LUT_FILE_NOT_READABLE(clipId, lutUri, "path is not a file")
      );
    }
    fs.accessSync(abs, fs.constants.R_OK);
  } catch (err) {
    if (err instanceof CutholError) throw err;
    throw new CutholError(
      DIAGNOSTICS.LUT_FILE_NOT_READABLE(clipId, lutUri, "file not found or unreadable")
    );
  }
  return abs;
}

export function buildSpineClipColorFilters(
  ctx: VideoGraphCompileContext,
  params: {
    clip: SpineClipSpec;
    asset: CutholSequence["library"][number];
    absAssetPath: string;
    clipColorSpec: ReturnType<typeof resolveSourceColorSpec>;
  }
): string[] {
  const { clip } = params;
  const out: string[] = [];
  const cg = clip.treatments.color_grade;
  const brightness = cg.brightness ?? 0;
  const contrast = cg.contrast ?? 1;
  const saturation = cg.saturation ?? 1;
  const temperatureK = cg.temperature_k ?? COLOR_TEMPERATURE_NEUTRAL_K;
  const lutUri = cg.lut_uri ?? null;

  const brightnessEnv = clip.envelopes.find(
    (e) => e.parameter === "treatments.color_grade.brightness"
  );
  const contrastEnv = clip.envelopes.find((e) => e.parameter === "treatments.color_grade.contrast");
  const saturationEnv = clip.envelopes.find(
    (e) => e.parameter === "treatments.color_grade.saturation"
  );
  const brightnessExpr = compileEnvelopeToFfmpegExpr({
    envelope: brightnessEnv,
    timeBaseOffsetMs: 0,
    mode: "raw",
  });
  const contrastExpr = compileEnvelopeToFfmpegExpr({
    envelope: contrastEnv,
    timeBaseOffsetMs: 0,
    mode: "raw",
  });
  const saturationExpr = compileEnvelopeToFfmpegExpr({
    envelope: saturationEnv,
    timeBaseOffsetMs: 0,
    mode: "raw",
  });
  const hasEnvelope = Boolean(brightnessExpr || contrastExpr || saturationExpr);
  if (hasEnvelope || brightness !== 0 || contrast !== 1 || saturation !== 1) {
    const b = brightnessExpr ? `'${brightnessExpr}'` : brightness.toFixed(2);
    const c = contrastExpr ? `'${contrastExpr}'` : contrast.toFixed(2);
    const s = saturationExpr ? `'${saturationExpr}'` : saturation.toFixed(2);
    out.push(
      `eq=brightness=${b}:contrast=${c}:saturation=${s}${hasEnvelope ? ":eval=frame" : ""}`
    );
  }

  if (temperatureK !== COLOR_TEMPERATURE_NEUTRAL_K) {
    if (!isSupportedColorTemperature(temperatureK)) {
      throw new CutholError(DIAGNOSTICS.INVALID_COLOR_TEMPERATURE(clip.id, temperatureK));
    }
    out.push(`colortemperature=temperature=${temperatureK}`);
  }

  if (lutUri !== null) {
    const absLutPath = resolveGradeLutPath(ctx.paths.rootDir, clip.id, lutUri);
    // Graph form is project-relative (every graph-consuming ffmpeg runs with cwd=rootDir, same as
    // `ass=filename=`), single-quoted and escaped: a bare `\:` does not protect a drive-letter colon from
    // the option splitter, but a quoted + escaped value parses (verified against this ffmpeg build).
    const relLutPath = path.relative(path.resolve(ctx.paths.rootDir), absLutPath);
    const lutFilter = `lut3d=file='${escapeFfmpegFilterPath(relLutPath)}'`;
    if (params.clipColorSpec.isRgb) {
      // RGB sources are already RGBA here; `lut3d` is near-exact on RGB (~85 dB identity).
      out.push(lutFilter);
      return out;
    }
    // `lut3d` interpolates coarsely on subsampled chroma (~46 dB identity on yuv420p), so YUV sources
    // are lifted to full-chroma 444 around the LUT (~48 dB) and restored to their input subsampling
    // afterwards. The chain deliberately stays YUV throughout: detouring through RGB would rejoin YUV
    // with a second gamut clip (~40 dB on saturated bars). Alpha (yuva*) passes through bit-exact.
    const pixFmt = (params.asset.probe.pix_fmt ?? "").toLowerCase();
    const hasAlpha = pixFmt.startsWith("y") && pixFmt.includes("a");
    if (pixFmt === "yuv444p" || pixFmt === "yuva444p") {
      out.push(lutFilter);
    } else if (pixFmt.startsWith("yuv444p") || pixFmt.startsWith("yuva444p")) {
      // 9–16 bit 444: run the LUT in 8-bit 444 (stage 5 truncates depth to 8-bit anyway).
      out.push(hasAlpha ? "format=yuva444p" : "format=yuv444p", lutFilter);
    } else if (hasAlpha) {
      const back = pixFmt.startsWith("yuva422p") ? "yuva422p" : "yuva420p";
      out.push("format=yuva444p", lutFilter, `format=${back}`);
    } else {
      const back = pixFmt.startsWith("yuv422p") ? "yuv422p" : "yuv420p";
      out.push("format=yuv444p", lutFilter, `format=${back}`);
    }
  }
  return out;
}
