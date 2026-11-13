/**
 * Cuthol Composition Preview, Real-Footage WCAG Contrast Auditor & 3-Panel Alpha Contact Sheet
 * (`src/compositor/composition_preview.ts`).
 *
 * Implements the two-build verification loop:
 * 1. Preview Build (`.cuthol/monitor/comp_preview_<id>/build/`):
 *    - Injects `<video id="cuthol-preview-bg" data-cuthol-preview ...>` containing the underlying
 *      spine video slice so `npx hyperframes check --json` evaluates WCAG text contrast against
 *      the REAL video pixels instead of returning `0/0 text checks` on a transparent canvas.
 * 2. Transparent Build (Source of Truth):
 *    - Captures frame-snapped 32-bit RGBA PNG snapshots (`omitBackground: true`).
 *    - Runs `alpha_gate` (verifying corner alpha = 0 and opaque ratio <= 98%, emitting `CUTHOL-G505` on leak)
 *      only when moving footage plays under the cue; a full-frame opaque graphic over nothing is allowed.
 *    - Checks for `backdrop-filter` / `mix-blend-mode` in `overlay_alpha` mode (`CUTHOL-G406`).
 *    - Generates a 3-column visual contact sheet (`Checkerboard | Footage Composite | Alpha Mask`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnWatchedSync } from "../core/subprocess.js";
import { hyperFramesProcessEnv } from "./hf_common.js";
import { isVisualCue, resolveCueStartMs } from "../core/timeline.js";
import { CutholDiagnostic, CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { PngCanvas } from "../core/png_canvas.js";
import { CutholSequence, isStillGraphic } from "../core/schema.js";
import { loadSequence } from "../core/workspace.js";
import {
  compositionUsesAudio,
  extractScalarHyperFramesVariables,
  syncCompositionBridgeFiles,
  syncEnabledExtensionAssetsToComposition,
} from "./bridge_exporter.js";
import { applyScalarVarsToStagedHtml } from "./hf_frames.js";
import { compileSequenceRenderPlan } from "./compiler.js";
import {
  detectSceneHostFeaturesInComposition,
  recordCompositionAlphaBboxSidecar,
  validateHyperFramesCompositionContract,
} from "./hyperframes_bridge.js";
import { readCurrentScriptErrorRecord, writeCurrentScriptErrorRecord } from "./coords_extract.js";
import {
  dedupeScriptErrors,
  parseCheckRuntimeScriptErrors,
  probeScriptRecordsChildSync,
  scriptRecordToDiagnostic,
} from "./hf_script_errors.js";

const PACKAGE_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface AlphaGateFrameMetrics {
  at_sec: number;
  snapped_sec: number;
  frame_idx: number;
  corner_alpha_max: number;
  transparent_ratio: number;
  semi_transparent_ratio: number;
  opaque_ratio: number;
  alpha_ok: boolean;
}

export interface CompositionPreviewResult {
  ok: boolean;
  cue_id: string | null;
  composition_dir: string;
  mode: "overlay_alpha" | "scene_host";
  contract_ok: boolean;
  contract_findings: string[];
  contrast_check_ran_on_footage: boolean;
  hyperframes_check_findings: string[];
  alpha_gate: {
    passed: boolean;
    /** False when only the stage backdrop or still images sit under the cue; opacity is then not a leak. */
    covers_footage: boolean;
    frames: AlphaGateFrameMetrics[];
  };
  contact_sheet_path: string;
  diagnostics: CutholDiagnostic[];
}

function findLocalHyperFramesCliMjs(): string {
  const pkgCandidate = path.resolve(PACKAGE_ROOT_DIR, "node_modules/hyperframes/bin/hyperframes.mjs");
  if (fs.existsSync(pkgCandidate)) return pkgCandidate;
  return path.resolve(process.cwd(), "node_modules/hyperframes/bin/hyperframes.mjs");
}

function copyDirClean(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === "snapshots" || entry.name === "renders" || entry.name === ".hyperframes") {
      continue;
    }
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirClean(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function decodePngToRgbaBuffer(
  pngPath: string,
  width: number,
  height: number
): { ok: boolean; buffer: Buffer } {
  const proc = spawnWatchedSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      pngPath,
      "-sws_flags",
      "neighbor",
      "-vf",
      `scale=${width}:${height}:flags=neighbor,format=rgba`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    { maxBuffer: width * height * 4 + 2 * 1024 * 1024, step: "ffmpeg decode preview png" }
  );
  const buf = proc.stdout as Buffer;
  if (proc.status === 0 && buf && buf.length >= width * height * 4) {
    return { ok: true, buffer: buf.subarray(0, width * height * 4) };
  }
  return { ok: false, buffer: Buffer.alloc(width * height * 4, 0) };
}

function parseFrameSecFromFilename(filePath: string): number | null {
  const base = path.basename(filePath);
  const m = /^frame-([\d.]+)s\.png$/i.exec(base);
  if (!m) return null;
  const val = Number(m[1]);
  return Number.isFinite(val) ? val : null;
}

export function previewAndCheckComposition(options: {
  workspaceDir: string;
  cueId?: string;
  compositionDir?: string;
  atSeconds?: number[];
  outputPath?: string;
}): CompositionPreviewResult {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const diagnostics: CutholDiagnostic[] = [];

  let targetCue = options.cueId
    ? sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === options.cueId)
    : undefined;

  if (!targetCue && !options.compositionDir) {
    targetCue = sequence.lanes
      .flatMap((l) => l.cues)
      .find((c) => c.kind === "composition" && Boolean(c.composition));
  }

  // A folder given without a cue id still previews with the mounted cue's timing and footage
  if (!targetCue && options.compositionDir) {
    const wantedDir = path.resolve(paths.rootDir, options.compositionDir);
    targetCue = sequence.lanes
      .flatMap((l) => l.cues)
      .find(
        (c) =>
          c.kind === "composition" &&
          !!c.composition &&
          path.resolve(paths.rootDir, c.composition.composition_dir) === wantedDir
      );
  }

  const rawCompDir =
    options.compositionDir ??
    targetCue?.composition?.composition_dir ??
    (() => {
      throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.cueId ?? "composition"));
    })();

  const absCompDir = path.isAbsolute(rawCompDir)
    ? rawCompDir
    : path.resolve(paths.rootDir, rawCompDir);
  const entryHtml = targetCue?.composition?.entry_html ?? "index.html";
  const entryPath = path.join(absCompDir, entryHtml);

  if (!fs.existsSync(entryPath)) {
    throw new CutholError(DIAGNOSTICS.MISSING_FILE_ON_DISK("composition", entryPath));
  }

  const cueIdLabel = targetCue?.id ?? path.basename(absCompDir);

  if (targetCue) {
    const syncRes = syncCompositionBridgeFiles(sequence, targetCue, paths);
    const usesAudio =
      targetCue.composition?.props?.preset === "audio_glow" ||
      compositionUsesAudio(absCompDir, entryHtml);
    if (usesAudio && syncRes) {
      const bData = syncRes.bridgeData as {
        audio?: { mid?: number[] };
        warnings?: string[];
      };
      const hasMid = Boolean(bData.audio?.mid && bData.audio.mid.length > 0);
      const warnMsg = bData.warnings?.[0];
      if (!hasMid || warnMsg) {
        diagnostics.push(
          DIAGNOSTICS.COMPOSITION_AUDIO_UNAVAILABLE(
            cueIdLabel,
            warnMsg ?? "no audio-energy data in the composition window"
          )
        );
      }
    }
  } else {
    syncEnabledExtensionAssetsToComposition(sequence, absCompDir, entryHtml, paths);
  }

  const mode = targetCue?.composition?.mode ?? "overlay_alpha";
  const expectTransparent = targetCue?.composition ? targetCue.composition.transparent : true;

  // 1. Validate contract & check for scene_host features (`CUTHOL-G406`)
  const contractRes = validateHyperFramesCompositionContract(absCompDir, entryHtml, true);
  if (mode === "overlay_alpha") {
    const shFeatures = detectSceneHostFeaturesInComposition(absCompDir, entryHtml);
    if (shFeatures.length > 0) {
      diagnostics.push(DIAGNOSTICS.SCENE_HOST_RECOMMENDED(cueIdLabel, shFeatures));
    }
  }

  const cueStartMs = targetCue ? resolveCueStartMs(sequence, targetCue) : 0;
  const cueDurationMs = targetCue?.duration_ms ?? 3000;
  const durationSec = Math.max(0.2, Number((cueDurationMs / 1000).toFixed(3)));
  const fps = sequence.stage.fps;
  const stageW = sequence.stage.width;
  const stageH = sequence.stage.height;

  const rawTimes =
    options.atSeconds && options.atSeconds.length > 0
      ? options.atSeconds
      : [
          Number((durationSec * 0.2).toFixed(3)),
          Number((durationSec * 0.5).toFixed(3)),
          Number((durationSec * 0.8).toFixed(3)),
        ];

  const totalFrames = Math.max(1, Math.round(durationSec * fps));
  const seenFrameIndices = new Set<number>();
  const snappedSamples: Array<{ requestedSec: number; frameIdx: number; snappedSec: number }> = [];
  for (const t of rawTimes) {
    const fIdx = Math.max(0, Math.min(totalFrames - 1, Math.floor(t * fps + 1e-6)));
    if (seenFrameIndices.has(fIdx)) continue;
    seenFrameIndices.add(fIdx);
    snappedSamples.push({
      requestedSec: t,
      frameIdx: fIdx,
      snappedSec: Number((fIdx / fps).toFixed(4)),
    });
  }
  snappedSamples.sort((a, b) => a.frameIdx - b.frameIdx);

  const workRoot = path.join(paths.monitorDir, `comp_preview_${cueIdLabel}`);
  fs.rmSync(workRoot, { recursive: true, force: true });
  const buildDir = path.join(workRoot, "build");
  const snapDir = path.join(workRoot, "snaps");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(snapDir, { recursive: true });

  // 2. Prepare underlying footage slice for Preview Build (`data-cuthol-preview`) via the sequence compiler
  // so multi-clip spines, transitions, speed ramps, crops, and under-lanes match `render` & `monitor.frame` 100%.
  let backdropMp4Path: string | null = null;
  const cueEndMs = cueStartMs + cueDurationMs;
  const hasOverlappingSpineClip = sequence.spine.clips.some(
    (c) => c.timeline_in_ms < cueEndMs && c.timeline_in_ms + c.duration_ms > cueStartMs
  );
  const targetLaneZ =
    sequence.lanes.find((l) => l.cues.some((c) => c.id === targetCue?.id))?.z_index ?? 20;
  // Only cues that put a picture on screen count as "underneath"; a voiceover or sound effect below the
  // composition leaves nothing but the stage backdrop to preview against.
  const hasOverlappingUnderCue = sequence.lanes.some(
    (l) =>
      l.z_index < targetLaneZ &&
      !l.muted &&
      l.cues.some((c) => {
        if (c.id === targetCue?.id || c.kind === "composition" || Boolean(c.typography)) return false;
        if (!isVisualCue(sequence, c)) return false;
        const st = resolveCueStartMs(sequence, c);
        return st < cueEndMs && st + c.duration_ms > cueStartMs;
      })
  );

  // An opaque overlay only hides something when real footage (a moving video, not a still image or the stage
  // backdrop) plays underneath it. A full-frame opaque graphic over nothing is a deliberate design, not a leak.
  const libByHandle = new Map(sequence.library.map((a) => [a.handle, a]));
  const isMovingFootage = (handle: string | undefined): boolean => {
    const asset = handle ? libByHandle.get(handle) : undefined;
    return Boolean(asset && asset.probe.has_video && !isStillGraphic(asset));
  };
  const coversFootage =
    sequence.spine.clips.some(
      (c) =>
        c.timeline_in_ms < cueEndMs &&
        c.timeline_in_ms + c.duration_ms > cueStartMs &&
        isMovingFootage(c.asset_handle)
    ) ||
    sequence.lanes.some(
      (l) =>
        l.z_index < targetLaneZ &&
        !l.muted &&
        l.cues.some((c) => {
          if (c.id === targetCue?.id || !isMovingFootage(c.asset_handle)) return false;
          const st = resolveCueStartMs(sequence, c);
          return st < cueEndMs && st + c.duration_ms > cueStartMs;
        })
    );

  if (hasOverlappingSpineClip || hasOverlappingUnderCue) {
    const underneathSeq: CutholSequence = {
      ...sequence,
      lanes: sequence.lanes
        .filter((l) => l.z_index < targetLaneZ && !l.muted)
        .map((l) => ({
          ...l,
          cues: l.cues.filter(
            (c) =>
              c.id !== targetCue?.id &&
              c.kind !== "composition" &&
              !c.typography &&
              (c.kind === "broll" || Boolean(c.asset_handle))
          ),
        })),
    };

    const underneathPlan = compileSequenceRenderPlan(underneathSeq, paths, "draft_480p", {
      minDurationMs: cueEndMs + 500,
      activeWindowMs: [cueStartMs, cueEndMs],
      includeAudio: false,
    });
    const sliceFilter = `${underneathPlan.filterComplex};${underneathPlan.videoOutPad}fps=${fps},scale=${stageW}:${stageH}:in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[v_bg_preview]`;

    const candidateBg = path.join(workRoot, "preview_backdrop.mp4");
    const filterScriptPath = path.join(workRoot, "preview_backdrop.filter.txt");
    fs.writeFileSync(filterScriptPath, sliceFilter, "utf8");
    const bgProc = spawnWatchedSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        ...underneathPlan.inputArgs,
        "-/filter_complex",
        filterScriptPath,
        "-map",
        "[v_bg_preview]",
        "-t",
        String(durationSec),
        "-an",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "ultrafast",
        "-g",
        "1",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        candidateBg,
      ],
      {
        cwd: paths.rootDir,
        encoding: "utf8",
        step: "ffmpeg preview backdrop",
        watchedPaths: [candidateBg],
        cleanupPathsOnStall: [candidateBg],
      }
    );
    if (bgProc.status === 0 && fs.existsSync(candidateBg) && fs.statSync(candidateBg).size > 500) {
      backdropMp4Path = candidateBg;
    }
  }

  // Copy composition into `build/` and inject `<video id="cuthol-preview-bg" data-cuthol-preview ...>`
  copyDirClean(absCompDir, buildDir);
  let contrastCheckRanOnFootage = false;
  const hfCheckFindings: string[] = [];

  if (backdropMp4Path) {
    const bgDest = path.join(buildDir, "assets/cuthol_preview_backdrop.mp4");
    fs.mkdirSync(path.dirname(bgDest), { recursive: true });
    fs.copyFileSync(backdropMp4Path, bgDest);

    const buildHtmlPath = path.join(buildDir, entryHtml);
    const buildHtml = fs.readFileSync(buildHtmlPath, "utf8");
    const previewVideoTag = `\n      <video id="cuthol-preview-bg" data-cuthol-preview class="clip" src="assets/cuthol_preview_backdrop.mp4" data-start="0" data-duration="${durationSec}" data-track-index="0" muted playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0"></video>`;
    const rootRegex = /(<div\b[^>]*\b(?:data-composition-id|id)=(["'])[^"']+\2[^>]*>)/i;
    const injectedHtml = buildHtml.replace(rootRegex, `$1${previewVideoTag}`);
    if (injectedHtml !== buildHtml) {
      fs.writeFileSync(buildHtmlPath, injectedHtml, "utf8");
      contrastCheckRanOnFootage = true;
    }
  }

  const hfBin = findLocalHyperFramesCliMjs();
  let checkParsedJson: unknown = null;
  if (fs.existsSync(hfBin)) {
    // Run `npx hyperframes check --json` on the preview build (with footage background)
    const checkProc = spawnWatchedSync(
      process.execPath,
      [
        hfBin,
        "check",
        buildDir,
        "--json",
        "--at",
        snappedSamples.map((s) => s.snappedSec).join(","),
      ],
      { encoding: "utf8", env: hyperFramesProcessEnv(),
        step: "hyperframes check" }
    );
    const rawCheckOut = (checkProc.stdout || "").trim();
    if (rawCheckOut) {
      try {
        const parsed = JSON.parse(rawCheckOut) as {
          findings?: Array<{ rule?: string; message?: string; severity?: string }>;
          contrast?: { findings?: Array<{ message?: string }> };
        };
        checkParsedJson = parsed;
        for (const f of parsed.findings ?? []) {
          if (f.message) hfCheckFindings.push(`[${f.severity ?? "info"}] ${f.rule ?? "check"}: ${f.message}`);
        }
        for (const cf of parsed.contrast?.findings ?? []) {
          if (cf.message) hfCheckFindings.push(`[contrast] ${cf.message}`);
        }
      } catch {
        // non-JSON output fallback
      }
    }

    // 3. Capture transparent RGBA snapshots without mutating the user's source directory on disk
    let snapshotTargetDir = absCompDir;
    const srcHtml = fs.readFileSync(entryPath, "utf8");
    if (expectTransparent && /(?:body|#root)\s*\{[^}]*?background\s*:\s*#00ff00\b/i.test(srcHtml)) {
      const transparentBuildDir = path.join(workRoot, "transparent_build");
      copyDirClean(absCompDir, transparentBuildDir);
      const sanitizedHtml = srcHtml.replace(
        /((?:body|#root)\s*\{[^}]*?)background\s*:\s*#00ff00\b/gi,
        "$1background: transparent"
      );
      fs.writeFileSync(path.join(transparentBuildDir, entryHtml), sanitizedHtml, "utf8");
      snapshotTargetDir = transparentBuildDir;
    }

    // Feed the render-time scalar variables to `hyperframes snapshot` (which has
    // no variables option) by rewriting the variable defaults in a staged copy,
    // mirroring the `--variables-file` merge the render applies.
    const previewScalarVars = extractScalarHyperFramesVariables(
      targetCue?.composition?.props as Record<string, unknown> | undefined
    );
    if (Object.keys(previewScalarVars).length > 0) {
      if (snapshotTargetDir === absCompDir) {
        const varsBuildDir = path.join(workRoot, "vars_build");
        copyDirClean(absCompDir, varsBuildDir);
        snapshotTargetDir = varsBuildDir;
      }
      const stagedEntryPath = path.join(snapshotTargetDir, entryHtml);
      if (fs.existsSync(stagedEntryPath)) {
        const stagedHtml = fs.readFileSync(stagedEntryPath, "utf8");
        const nextHtml = applyScalarVarsToStagedHtml(stagedHtml, previewScalarVars);
        if (nextHtml !== stagedHtml) {
          fs.writeFileSync(stagedEntryPath, nextHtml, "utf8");
        }
      }
    }

    spawnWatchedSync(
      process.execPath,
      [
        hfBin,
        "snapshot",
        snapshotTargetDir,
        "--at",
        snappedSamples.map((s) => s.snappedSec).join(","),
        "--no-end",
        "--describe",
        "false",
        "--output",
        snapDir,
      ],
      {
        encoding: "utf8",
        env: hyperFramesProcessEnv(),
        step: "hyperframes preview snapshot",
        watchedPaths: [snapDir],
        cleanupPathsOnStall: [snapDir],
      }
    );
  }

  // Composition page script errors: `hyperframes check --json` runs the page in a
  // browser, so its runtime findings name real page errors; the probe (one sync child
  // process, since preview is sync) adds timeline registration status plus seek-time
  // errors. The merged record is content-keyed so fixing the script invalidates it,
  // and `verify`/`monitor` read it back without a browser.
  const checkScriptErrors = parseCheckRuntimeScriptErrors(checkParsedJson);
  try {
    probeScriptRecordsChildSync(paths.rootDir, [
      {
        cueId: targetCue?.id ?? path.basename(absCompDir),
        absCompDir,
        entryHtml,
        width: sequence.stage.width,
        height: sequence.stage.height,
        fps: Math.max(1, sequence.stage.fps),
        durationSec,
      },
    ]);
    const probed = readCurrentScriptErrorRecord(paths.rootDir, absCompDir, entryHtml);
    if (probed) {
      const merged = dedupeScriptErrors([...probed.errors, ...checkScriptErrors]);
      const record =
        merged.length !== probed.errors.length
          ? writeCurrentScriptErrorRecord(paths.rootDir, {
              absCompDir,
              entryHtml,
              source: "preview",
              timelineExpected: probed.timeline_expected,
              timelineRegistered: probed.timeline_registered,
              errors: merged,
            })
          : probed;
      const scriptDiag = scriptRecordToDiagnostic(
        targetCue?.id ?? path.basename(absCompDir),
        record
      );
      if (scriptDiag) diagnostics.push(scriptDiag);
    } else if (checkScriptErrors.length > 0) {
      // Probe failure with renderer findings: fail closed (a page that defeats the
      // probe while the renderer reports runtime errors is not trustworthy).
      const record = writeCurrentScriptErrorRecord(paths.rootDir, {
        absCompDir,
        entryHtml,
        source: "preview",
        timelineExpected: true,
        timelineRegistered: false,
        errors: checkScriptErrors,
      });
      const scriptDiag = scriptRecordToDiagnostic(
        targetCue?.id ?? path.basename(absCompDir),
        record
      );
      if (scriptDiag) diagnostics.push(scriptDiag);
    }
  } catch {
    // A probe/record failure must never fail the preview.
  }

  const capturedPngs = fs.existsSync(snapDir)
    ? fs
        .readdirSync(snapDir)
        .filter((f) => f.startsWith("frame-") && f.endsWith(".png"))
        .map((f) => path.join(snapDir, f))
        .sort((a, b) => {
          const sa = parseFrameSecFromFilename(a);
          const sb = parseFrameSecFromFilename(b);
          if (sa !== null && sb !== null) return sa - sb;
          return a.localeCompare(b);
        })
    : [];

  // 4. Evaluate `alpha_gate` and build 3-Column Visual Contact Sheet (Checkerboard | Footage Composite | Alpha Mask)
  const cellW = 420;
  const cellH = Math.max(180, Math.round((cellW * stageH) / stageW));
  const cols = 3;
  const rows = Math.max(1, snappedSamples.length);
  const pad = 12;
  const headerH = 44;
  const colHeaderH = 24;
  const sheetW = pad + cols * (cellW + pad);
  const sheetH = headerH + colHeaderH + pad + rows * (cellH + pad);

  const sheet = new PngCanvas(sheetW, sheetH, [11, 15, 23, 255]);
  sheet.fillRect(0, 0, sheetW, headerH, [20, 28, 42, 255]);
  sheet.drawText(
    `CUTHOL COMPOSITION PREVIEW | ${cueIdLabel} | MODE:${mode.toUpperCase()} | ${snappedSamples.length} SAMPLES`,
    14,
    14,
    [241, 245, 249, 255],
    2
  );

  const colTitles = [
    "1. CHECKERBOARD (ALPHA)",
    backdropMp4Path ? "2. REAL FOOTAGE COMPOSITE" : "2. OVER STAGE BACKDROP (NO FOOTAGE)",
    "3. ALPHA MASK (0..255)",
  ];
  for (let c = 0; c < 3; c++) {
    const cx = pad + c * (cellW + pad);
    sheet.drawText(colTitles[c], cx + 8, headerH + 6, [148, 163, 184, 255], 1);
  }

  const alphaFrames: AlphaGateFrameMetrics[] = [];
  let allAlphaPassed = true;

  for (let r = 0; r < rows; r++) {
    const sample = snappedSamples[r];
    // Match captured PNG by closest parsed timestamp (fallback to index r)
    let snapPng: string | undefined;
    let bestDiff = Infinity;
    for (const candidate of capturedPngs) {
      const cSec = parseFrameSecFromFilename(candidate);
      if (cSec !== null) {
        const diff = Math.abs(cSec - sample.snappedSec);
        if (diff < bestDiff && diff <= Math.max(0.05, 1.5 / fps)) {
          bestDiff = diff;
          snapPng = candidate;
        }
      }
    }
    if (!snapPng) {
      snapPng = capturedPngs[r];
    }
    if (snapPng && expectTransparent && mode === "overlay_alpha") {
      recordCompositionAlphaBboxSidecar(absCompDir, snapPng);
    }

    const fgDecoded = snapPng
      ? decodePngToRgbaBuffer(snapPng, cellW, cellH)
      : { ok: false, buffer: Buffer.alloc(cellW * cellH * 4, 0) };
    const fgRgba = fgDecoded.buffer;

    // Extract matching backdrop frame at sample.snappedSec if backdropMp4Path exists
    let bgRgba: Buffer = Buffer.alloc(cellW * cellH * 4, 0);
    if (backdropMp4Path) {
      const bgFramePng = path.join(workRoot, `bg_f_${r}.png`);
      spawnWatchedSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-ss",
          sample.snappedSec.toFixed(4),
          "-i",
          backdropMp4Path,
          "-vf",
          `scale=${cellW}:${cellH}:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba`,
          "-frames:v",
          "1",
          bgFramePng,
        ],
        {
          encoding: "utf8",
          step: "ffmpeg preview backdrop frame",
          watchedPaths: [bgFramePng],
          cleanupPathsOnStall: [bgFramePng],
        }
      );
      if (!fs.existsSync(bgFramePng)) {
        spawnWatchedSync(
          "ffmpeg",
          [
            "-y",
            "-v",
            "error",
            "-sseof",
            "-0.1",
            "-i",
            backdropMp4Path,
            "-vf",
            `scale=${cellW}:${cellH}:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba`,
            "-frames:v",
            "1",
            bgFramePng,
          ],
          {
            encoding: "utf8",
            step: "ffmpeg preview backdrop frame",
            watchedPaths: [bgFramePng],
            cleanupPathsOnStall: [bgFramePng],
          }
        );
      }
      if (fs.existsSync(bgFramePng)) {
        bgRgba = decodePngToRgbaBuffer(bgFramePng, cellW, cellH).buffer;
      }
    } else {
      // Nothing visual plays underneath: the render shows the stage backdrop colour there, so preview on it.
      const hex = /^#?([0-9a-f]{6})$/i.exec(sequence.stage.backdrop?.color ?? "")?.[1] ?? "182234";
      const [bgR, bgG, bgB] = [0, 2, 4].map((o) => parseInt(hex.slice(o, o + 2), 16));
      for (let i = 0; i < cellW * cellH; i++) {
        bgRgba[i * 4] = bgR;
        bgRgba[i * 4 + 1] = bgG;
        bgRgba[i * 4 + 2] = bgB;
        bgRgba[i * 4 + 3] = 255;
      }
    }

    let zeroCount = 0;
    let semiCount = 0;
    let opaqueCount = 0;
    const totalPixels = cellW * cellH;

    const cornerIndices = [
      0,
      cellW - 1,
      (cellH - 1) * cellW,
      cellH * cellW - 1,
    ];
    let cornerAlphaMax = 0;
    for (const ci of cornerIndices) {
      const a = fgRgba[ci * 4 + 3] ?? 0;
      if (a > cornerAlphaMax) cornerAlphaMax = a;
    }

    const rowY = headerH + colHeaderH + pad + r * (cellH + pad);
    const xChecker = pad;
    const xComp = pad + (cellW + pad);
    const xMask = pad + 2 * (cellW + pad);

    for (let py = 0; py < cellH; py++) {
      for (let px = 0; px < cellW; px++) {
        const idx = (py * cellW + px) * 4;
        const fr = fgRgba[idx];
        const fg = fgRgba[idx + 1];
        const fb = fgRgba[idx + 2];
        const fa = fgRgba[idx + 3];

        if (fa === 0) zeroCount++;
        else if (fa === 255) opaqueCount++;
        else semiCount++;

        const aNorm = fa / 255;

        // Col 1: Checkerboard + straight alpha blend
        const isLightTile = ((px >> 4) + (py >> 4)) % 2 === 0;
        const chkBase = isLightTile ? 58 : 32;
        const c1Idx = ((rowY + py) * sheetW + (xChecker + px)) * 4;
        sheet.pixels[c1Idx] = Math.round(fr * aNorm + chkBase * (1 - aNorm));
        sheet.pixels[c1Idx + 1] = Math.round(fg * aNorm + chkBase * (1 - aNorm));
        sheet.pixels[c1Idx + 2] = Math.round(fb * aNorm + chkBase * (1 - aNorm));
        sheet.pixels[c1Idx + 3] = 255;

        // Col 2: Real Footage Composite
        const br = bgRgba[idx];
        const bg = bgRgba[idx + 1];
        const bb = bgRgba[idx + 2];
        const c2Idx = ((rowY + py) * sheetW + (xComp + px)) * 4;
        sheet.pixels[c2Idx] = Math.round(fr * aNorm + br * (1 - aNorm));
        sheet.pixels[c2Idx + 1] = Math.round(fg * aNorm + bg * (1 - aNorm));
        sheet.pixels[c2Idx + 2] = Math.round(fb * aNorm + bb * (1 - aNorm));
        sheet.pixels[c2Idx + 3] = 255;

        // Col 3: Alpha Mask (grayscale 0..255, with cyan tint on semi-transparent shadow/AA pixels!)
        const c3Idx = ((rowY + py) * sheetW + (xMask + px)) * 4;
        if (fa > 0 && fa < 255) {
          sheet.pixels[c3Idx] = Math.round(fa * 0.4);
          sheet.pixels[c3Idx + 1] = Math.min(255, Math.round(fa * 0.9 + 25));
          sheet.pixels[c3Idx + 2] = 255;
        } else {
          sheet.pixels[c3Idx] = fa;
          sheet.pixels[c3Idx + 1] = fa;
          sheet.pixels[c3Idx + 2] = fa;
        }
        sheet.pixels[c3Idx + 3] = 255;
      }
    }

    const transparentRatio = Number((zeroCount / totalPixels).toFixed(4));
    const semiRatio = Number((semiCount / totalPixels).toFixed(4));
    const opaqueRatio = Number((opaqueCount / totalPixels).toFixed(4));
    const alphaOk =
      fgDecoded.ok &&
      (!expectTransparent ||
        mode === "scene_host" ||
        !coversFootage ||
        (cornerAlphaMax <= 16 && opaqueRatio <= 0.98));

    if (!alphaOk) {
      allAlphaPassed = false;
    }

    alphaFrames.push({
      at_sec: sample.requestedSec,
      snapped_sec: sample.snappedSec,
      frame_idx: sample.frameIdx,
      corner_alpha_max: cornerAlphaMax,
      transparent_ratio: transparentRatio,
      semi_transparent_ratio: semiRatio,
      opaque_ratio: opaqueRatio,
      alpha_ok: alphaOk,
    });

    // Draw HUD badge on each cell
    for (let c = 0; c < 3; c++) {
      const cx = pad + c * (cellW + pad);
      sheet.strokeRect(
        cx - 1,
        rowY - 1,
        cellW + 2,
        cellH + 2,
        2,
        alphaOk ? [56, 189, 248, 220] : [239, 68, 68, 255]
      );
    }
    sheet.fillRect(xChecker, rowY, cellW, 18, [15, 23, 42, 215]);
    sheet.drawText(
      `T:${sample.snappedSec}S (F:${sample.frameIdx}) | TRANSP:${(transparentRatio * 100).toFixed(0)}% SEMI:${(semiRatio * 100).toFixed(1)}%`,
      xChecker + 6,
      rowY + 5,
      [226, 232, 240, 255],
      1
    );
  }

  if (!allAlphaPassed && expectTransparent && mode === "overlay_alpha") {
    const worst = alphaFrames.find((f) => !f.alpha_ok) ?? alphaFrames[0];
    if (worst) {
      diagnostics.push(
        DIAGNOSTICS.OPAQUE_OVERLAY_LEAK(
          cueIdLabel,
          worst.opaque_ratio,
          worst.corner_alpha_max
        )
      );
    }
  }

  const defaultOut = path.join(paths.monitorDir, `comp_preview_${cueIdLabel}.png`);
  const resolvedOut = options.outputPath
    ? path.isAbsolute(options.outputPath)
      ? options.outputPath
      : path.resolve(paths.rootDir, options.outputPath)
    : defaultOut;

  sheet.saveAs(resolvedOut);

  return {
    ok: contractRes.ok && allAlphaPassed,
    cue_id: targetCue?.id ?? null,
    composition_dir: absCompDir,
    mode,
    contract_ok: contractRes.ok,
    contract_findings: contractRes.findings,
    contrast_check_ran_on_footage: contrastCheckRanOnFootage,
    hyperframes_check_findings: hfCheckFindings,
    alpha_gate: {
      passed: allAlphaPassed,
      covers_footage: coversFootage,
      frames: alphaFrames,
    },
    contact_sheet_path: resolvedOut,
    diagnostics,
  };
}
