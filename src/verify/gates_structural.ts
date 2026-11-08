// Gates 1-3 (G1_SCHEMA, G2_ASSETS, G3_TIMING) of the 5-Gate sequence verification engine.
import fs from "node:fs";
import path from "node:path";
import { CutholDiagnostic, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  CutholSequence,
  getCuePlaybackRate,
  isStillGraphic,
  LibraryItem,
  SpineClip,
} from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { minClipDurationMs } from "../core/time.js";
import {
  describeSequenceExtent,
  findBackdropOnlySpans,
  findSpansCoveredOnlyByCues,
  resolveCueStartMs,
} from "../core/timeline.js";
import { WorkspacePaths } from "../core/workspace.js";
import { ffmpegVersionWarningDiagnostics } from "../core/ffmpeg_version.js";
import {
  detectCompositionExtensionCopyDrift,
  syncEnabledExtensionAssetsToComposition,
} from "../compositor/bridge_exporter.js";
import { validateHyperFramesCompositionContract } from "../compositor/hyperframes_bridge.js";
import { resolveExtension } from "../extensions/manager.js";
import { MediaLedger } from "../library/ledger.js";
import { peekCachedAcousticProfile } from "../speech/cleanup_acoustic.js";
import {
  ensureLibraryItemVideoProbe,
  isProbeMetadataComplete,
  isVariableFrameRate,
  resolveLibraryItemPath,
} from "../library/probe.js";

/** Assets that actually play: spine clips, plus cues on lanes that are not muted. */
function assetHandlesPlayedInEdit(seq: CutholSequence): Set<string> {
  const used = new Set<string>();
  for (const clip of seq.spine.clips) {
    if (clip.asset_handle) used.add(clip.asset_handle);
  }
  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (cue.asset_handle) used.add(cue.asset_handle);
    }
  }
  return used;
}

export function verifyG1Schema(
  seq: CutholSequence,
  libMap: Map<string, LibraryItem>,
  spineMap: Map<string, SpineClip>,
  diagnostics: CutholDiagnostic[]
): void {
  const seenHandles = new Set<string>();
  const checkUnique = (id: string) => {
    if (seenHandles.has(id)) {
      diagnostics.push(DIAGNOSTICS.DUPLICATE_HANDLE(id));
    }
    seenHandles.add(id);
  };

  for (const item of seq.library) {
    checkUnique(item.handle);
  }
  for (const clip of seq.spine.clips) {
    checkUnique(clip.id);
    if (!libMap.has(clip.asset_handle)) {
      diagnostics.push(DIAGNOSTICS.DANGLING_ASSET_REF(clip.id, clip.asset_handle));
    }
  }
  for (const lane of seq.lanes) {
    checkUnique(lane.id);
    for (const cue of lane.cues) {
      checkUnique(cue.id);
      if (cue.asset_handle && !libMap.has(cue.asset_handle)) {
        diagnostics.push(DIAGNOSTICS.DANGLING_ASSET_REF(cue.id, cue.asset_handle));
      }
      if (cue.anchor && !spineMap.has(cue.anchor.ref)) {
        diagnostics.push(DIAGNOSTICS.DANGLING_ANCHOR_REF(cue.id, cue.anchor.ref));
      }
      if (cue.composition_audio !== undefined && cue.composition_audio !== "mix" && cue.composition_audio !== "off") {
        diagnostics.push(
          DIAGNOSTICS.INVALID_COMPOSITION_AUDIO(cue.id, `got '${String(cue.composition_audio)}', want 'mix' or 'off'`)
        );
      } else if (
        cue.composition_audio !== undefined &&
        (cue.kind !== "composition" || !cue.composition)
      ) {
        diagnostics.push(
          DIAGNOSTICS.INVALID_COMPOSITION_AUDIO(cue.id, `'composition_audio' is set on a non-composition cue (kind '${cue.kind}')`)
        );
      }
    }
  }
  for (const marker of seq.markers) {
    checkUnique(marker.id);
  }
}

export function verifyG2Assets(
  seq: CutholSequence,
  paths: WorkspacePaths | undefined,
  libMap: Map<string, LibraryItem>,
  diagnostics: CutholDiagnostic[]
): void {
  const playedHandles = assetHandlesPlayedInEdit(seq);
  let g2Ledger: MediaLedger | null = null;
  try {
    if (paths) {
      for (const item of seq.library) {
        const absPath = resolveLibraryItemPath(paths.rootDir, item);
        if (!fs.existsSync(absPath)) {
          diagnostics.push(DIAGNOSTICS.MISSING_FILE_ON_DISK(item.handle, item.uri));
          continue;
        }
        if (item.probe.has_video) {
          if (!isProbeMetadataComplete(item.probe)) {
            try {
              if (!g2Ledger) g2Ledger = new MediaLedger(paths.ledgerFile);
              ensureLibraryItemVideoProbe(item, paths.rootDir, g2Ledger);
            } catch {
              // ignore probe failure
            }
          }
          if (
            playedHandles.has(item.handle) &&
            item.probe.fps > 0 &&
            !isStillGraphic(item) &&
            item.probe.is_vfr
          ) {
            diagnostics.push(
              DIAGNOSTICS.VARIABLE_FRAME_RATE_SOURCE(
                item.handle,
                item.probe.fps,
                seq.stage.fps,
                item.probe.r_frame_rate,
                item.probe.avg_frame_rate
              )
            );
          }
          const cs = (item.probe.color_space ?? "").toLowerCase().trim();
          if (cs === "bt2020nc" || cs === "bt2020c" || cs === "bt2020") {
            diagnostics.push(
              DIAGNOSTICS.BT2020_COLOR_SPACE_SOURCE(
                item.handle,
                item.probe.color_space ?? cs,
                item.probe.color_transfer,
                item.probe.color_primaries
              )
            );
          }
        }
      }
      for (const lane of seq.lanes) {
        for (const cue of lane.cues) {
          if (cue.composition) {
            const compDir = path.isAbsolute(cue.composition.composition_dir)
              ? cue.composition.composition_dir
              : path.resolve(paths.rootDir, cue.composition.composition_dir);
            const entryPath = path.join(compDir, cue.composition.entry_html);
            if (!fs.existsSync(entryPath)) {
              diagnostics.push(DIAGNOSTICS.MISSING_FILE_ON_DISK(cue.id, entryPath));
            } else {
              try {
                syncEnabledExtensionAssetsToComposition(
                  seq,
                  compDir,
                  cue.composition.entry_html,
                  paths
                );
              } catch {
                // ignore pre-contract asset sync error
              }
              // Verify HyperFrames contract during sequence verification
              const contract = validateHyperFramesCompositionContract(
                compDir,
                cue.composition.entry_html,
                false,
                false
              );
              if (!contract.ok) {
                diagnostics.push(
                  DIAGNOSTICS.INVALID_COMPOSITION_CONTRACT(cue.id, contract.findings.join("; "))
                );
              }
            }
          }
        }
      }

      if (seq.extensions && seq.extensions.length > 0) {
        for (const extRef of seq.extensions) {
          try {
            const currentExt = resolveExtension(extRef.name, paths.rootDir);
            const copyDrift = detectCompositionExtensionCopyDrift(seq, extRef.name, paths);
            if (
              currentExt.contentHash !== extRef.content_hash ||
              currentExt.version !== extRef.version
            ) {
              diagnostics.push(
                DIAGNOSTICS.EXTENSION_HASH_MISMATCH(
                  extRef.name,
                  extRef.version,
                  extRef.content_hash,
                  currentExt.version,
                  currentExt.contentHash,
                  "WARN",
                  copyDrift.drifted
                    ? `composition copy stale/different: ${copyDrift.driftedCompositions.join(", ")}`
                    : undefined
                )
              );
            } else if (copyDrift.drifted) {
              diagnostics.push(
                DIAGNOSTICS.EXTENSION_HASH_MISMATCH(
                  extRef.name,
                  extRef.version,
                  extRef.content_hash,
                  currentExt.version,
                  currentExt.contentHash,
                  "WARN",
                  `composition copy differs from its source: ${copyDrift.driftedCompositions.join(", ")}`
                )
              );
            }
          } catch {
            diagnostics.push(
              DIAGNOSTICS.EXTENSION_HASH_MISMATCH(
                extRef.name,
                extRef.version,
                extRef.content_hash,
                "missing",
                "missing"
              )
            );
          }
        }
      }
    } else {
      for (const item of seq.library) {
        if (item.probe.has_video) {
          if (playedHandles.has(item.handle) && item.probe.fps > 0 && !isStillGraphic(item)) {
            const vfr =
              item.probe.is_vfr ??
              isVariableFrameRate(item.probe.r_frame_rate, item.probe.avg_frame_rate);
            if (vfr) {
              diagnostics.push(
                DIAGNOSTICS.VARIABLE_FRAME_RATE_SOURCE(
                  item.handle,
                  item.probe.fps,
                  seq.stage.fps,
                  item.probe.r_frame_rate,
                  item.probe.avg_frame_rate
                )
              );
            }
          }
          const cs = (item.probe.color_space ?? "").toLowerCase().trim();
          if (cs === "bt2020nc" || cs === "bt2020c" || cs === "bt2020") {
            diagnostics.push(
              DIAGNOSTICS.BT2020_COLOR_SPACE_SOURCE(
                item.handle,
                item.probe.color_space ?? cs,
                item.probe.color_transfer,
                item.probe.color_primaries
              )
            );
          }
        }
      }
    }
  } finally {
    g2Ledger?.close();
  }

  for (const clip of seq.spine.clips) {
    const asset = libMap.get(clip.asset_handle);
    if (asset) {
      const isStaticGraphic = isStillGraphic(asset);
      if (clip.source_in_ms < 0) {
        diagnostics.push(
          DIAGNOSTICS.SOURCE_RANGE_EXCEEDED(clip.id, clip.source_in_ms, asset.probe.duration_ms)
        );
      } else if (clip.source_in_ms >= clip.source_out_ms) {
        diagnostics.push(
          DIAGNOSTICS.SOURCE_RANGE_EXCEEDED(clip.id, clip.source_out_ms, clip.source_in_ms)
        );
      } else if (!isStaticGraphic && clip.source_out_ms > asset.probe.duration_ms) {
        diagnostics.push(
          DIAGNOSTICS.SOURCE_RANGE_EXCEEDED(clip.id, clip.source_out_ms, asset.probe.duration_ms)
        );
      }
    }
  }

  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      if (cue.asset_handle) {
        const asset = libMap.get(cue.asset_handle);
        if (asset) {
          const isStaticGraphic = isStillGraphic(asset);
          const cueRate = getCuePlaybackRate(cue);
          const effectiveInMs = cue.source_in_ms ?? 0;
          const effectiveOutMs =
            cue.source_out_ms ??
            (cueRate === 1.0
              ? effectiveInMs + cue.duration_ms
              : effectiveInMs + Math.round(cue.duration_ms * cueRate));
          const maxAllowedCueDurationMs =
            cue.source_out_ms !== undefined
              ? cueRate === 1.0
                ? cue.source_out_ms - effectiveInMs
                : Math.ceil((cue.source_out_ms - effectiveInMs) / cueRate) + 1
              : cue.duration_ms;

          if (effectiveInMs < 0) {
            diagnostics.push(
              DIAGNOSTICS.SOURCE_RANGE_EXCEEDED(cue.id, effectiveInMs, asset.probe.duration_ms)
            );
          } else if (cue.source_out_ms !== undefined && effectiveInMs >= cue.source_out_ms) {
            diagnostics.push(
              DIAGNOSTICS.SOURCE_RANGE_EXCEEDED(cue.id, cue.source_out_ms, effectiveInMs)
            );
          } else if (!isStaticGraphic && effectiveOutMs > asset.probe.duration_ms) {
            diagnostics.push(
              DIAGNOSTICS.SOURCE_RANGE_EXCEEDED(
                cue.id,
                effectiveOutMs,
                asset.probe.duration_ms
              )
            );
          } else if (
            !isStaticGraphic &&
            cue.source_out_ms !== undefined &&
            cue.duration_ms > maxAllowedCueDurationMs
          ) {
            diagnostics.push(
              DIAGNOSTICS.SOURCE_RANGE_EXCEEDED(
                cue.id,
                effectiveInMs + Math.round(cue.duration_ms * cueRate),
                cue.source_out_ms
              )
            );
          }
        }
      }
    }
  }

  // Environment: ffmpeg/ffprobe below the tested 8.x warn once per tool
  // (probed once per process; silent when the version is unreadable).
  for (const diag of ffmpegVersionWarningDiagnostics()) {
    diagnostics.push(diag);
  }
}

/** True when a cached cleanup profile has an above-floor window inside the clip. No profile: false. */
function cachedClipHasSpeechAboveFloor(seq: CutholSequence, clip: SpineClip): boolean {
  const asset = seq.library.find((item) => item.handle === clip.asset_handle);
  if (!asset) return false;
  const profile = peekCachedAcousticProfile(asset.digest_sha256);
  if (!profile || profile.window_ms <= 0) return false;
  const startW = Math.max(0, Math.floor(clip.source_in_ms / profile.window_ms));
  const endW = Math.min(profile.window_dbfs.length, Math.ceil(clip.source_out_ms / profile.window_ms));
  for (let w = startW; w < endW; w++) {
    if (profile.window_dbfs[w] > profile.silence_floor_dbfs) return true;
  }
  return false;
}

/** Alpha bbox fill below this counts as "mostly empty" for the G316 check. */
const SPARSE_TRANSPARENT_FILL_THRESHOLD = 0.5;

/**
 * Cached alpha fill ratio (bbox area over frame area) of a composition, or
 * null when no measurement sidecar was recorded yet (preview/monitor/render
 * writes one for transparent compositions).
 */
function readCompositionAlphaFillRatio(
  compositionDir: string,
  paths: WorkspacePaths | undefined
): number | null {
  try {
    const absCompDir = path.isAbsolute(compositionDir)
      ? compositionDir
      : paths
        ? path.resolve(paths.rootDir, compositionDir)
        : null;
    if (!absCompDir) return null;
    const raw = JSON.parse(
      fs.readFileSync(path.join(absCompDir, "assets", "cuthol-bbox.json"), "utf8")
    );
    const w = Number(raw.width_pct);
    const h = Number(raw.height_pct);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 0 || h < 0 || w > 1 || h > 1) return null;
    return w * h;
  } catch {
    return null;
  }
}

export function verifyG3Timing(
  seq: CutholSequence,
  diagnostics: CutholDiagnostic[],
  paths?: WorkspacePaths | undefined
): void {
  const minMs = minClipDurationMs(seq.stage.fps, OPEN_STANDARDS.SIGNAL_SANITY.MIN_CLIP_FRAMES);
  let expectedTimelineIn = 0;

  for (let i = 0; i < seq.spine.clips.length; i++) {
    const clip = seq.spine.clips[i];
    if (!Number.isFinite(clip.playback.rate) || clip.playback.rate < 0.1 || clip.playback.rate > 16.0) {
      diagnostics.push(DIAGNOSTICS.INVALID_PLAYBACK_RATE(clip.id, clip.playback.rate));
    }
    if (!Number.isFinite(clip.duration_ms) || clip.duration_ms < minMs) {
      diagnostics.push(DIAGNOSTICS.SUB_FRAME_DURATION(clip.id, clip.duration_ms, minMs));
    } else if (clip.duration_ms <= OPEN_STANDARDS.SIGNAL_SANITY.MIN_RECOMMENDED_SPINE_CLIP_MS) {
      diagnostics.push(
        DIAGNOSTICS.SHORT_SPINE_CLIP(
          clip.id,
          clip.duration_ms,
          OPEN_STANDARDS.SIGNAL_SANITY.MIN_RECOMMENDED_SPINE_CLIP_MS
        )
      );
    } else if (
      clip.duration_ms < OPEN_STANDARDS.SIGNAL_SANITY.SHORT_SPEECH_FRAGMENT_MAX_MS &&
      cachedClipHasSpeechAboveFloor(seq, clip)
    ) {
      diagnostics.push(
        DIAGNOSTICS.SHORT_SPEECH_FRAGMENT(
          clip.id,
          clip.duration_ms,
          OPEN_STANDARDS.SIGNAL_SANITY.SHORT_SPEECH_FRAGMENT_MAX_MS
        )
      );
    }
    if (seq.spine.magnetic && clip.timeline_in_ms !== expectedTimelineIn) {
      diagnostics.push(
        DIAGNOSTICS.SPINE_DISCONTINUITY(clip.id, expectedTimelineIn, clip.timeline_in_ms)
      );
    }
    expectedTimelineIn = clip.timeline_in_ms + clip.duration_ms;

    if (clip.transition_out) {
      const nextClip = seq.spine.clips[i + 1];
      const maxAllowed = nextClip
        ? Math.floor(Math.min(clip.duration_ms, nextClip.duration_ms) / 2)
        : Math.floor(clip.duration_ms / 2);
      if (
        !Number.isFinite(clip.transition_out.duration_ms) ||
        clip.transition_out.duration_ms <= 0 ||
        clip.transition_out.duration_ms > maxAllowed
      ) {
        diagnostics.push(
          DIAGNOSTICS.TRANSITION_TOO_LONG(clip.id, clip.transition_out.duration_ms, maxAllowed)
        );
      }
    }

    for (const env of clip.envelopes) {
      for (const pt of env.points) {
        if (
          !Number.isFinite(pt.offset_ms) ||
          !Number.isFinite(pt.value) ||
          pt.offset_ms < 0 ||
          pt.offset_ms > clip.duration_ms
        ) {
          diagnostics.push(
            DIAGNOSTICS.ENVELOPE_OUT_OF_RANGE(clip.id, env.parameter, pt.offset_ms, clip.duration_ms)
          );
        }
      }
    }
  }

  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      if (
        cue.playback &&
        (!Number.isFinite(cue.playback.rate) ||
          cue.playback.rate < 0.1 ||
          cue.playback.rate > 16.0)
      ) {
        diagnostics.push(DIAGNOSTICS.INVALID_PLAYBACK_RATE(cue.id, cue.playback.rate));
      }
      if (!Number.isFinite(cue.duration_ms) || cue.duration_ms < minMs) {
        diagnostics.push(DIAGNOSTICS.SUB_FRAME_DURATION(cue.id, cue.duration_ms, minMs));
      }
      const cueStartMs = resolveCueStartMs(seq, cue);
      if (!Number.isFinite(cueStartMs) || cueStartMs < 0) {
        diagnostics.push(
          DIAGNOSTICS.ENVELOPE_OUT_OF_RANGE(cue.id, "at_ms", cueStartMs, cue.duration_ms)
        );
      }
      // Warn if an active lane cue extends past the primary spine duration
      if (
        !lane.muted &&
        seq.spine.clips.length > 0 &&
        expectedTimelineIn > 0 &&
        cueStartMs + cue.duration_ms > expectedTimelineIn + minMs
      ) {
        diagnostics.push(
          DIAGNOSTICS.LANE_EXTENDS_PAST_SPINE(
            cue.id,
            cueStartMs + cue.duration_ms,
            expectedTimelineIn
          )
        );
      }
      for (const env of cue.envelopes) {
        for (const pt of env.points) {
          if (
            !Number.isFinite(pt.offset_ms) ||
            !Number.isFinite(pt.value) ||
            pt.offset_ms < 0 ||
            pt.offset_ms > cue.duration_ms
          ) {
            diagnostics.push(
              DIAGNOSTICS.ENVELOPE_OUT_OF_RANGE(cue.id, env.parameter, pt.offset_ms, cue.duration_ms)
            );
          }
        }
      }
    }
  }

  // Without spine clips the lanes alone carry the edit (a graphics-only video). That is a supported
  // shape, so the only things worth reporting are a sequence with nothing on it at all, and stretches
  // where no visual cue is on screen and the viewer would see only the stage backdrop.
  if (describeSequenceExtent(seq).source === "empty") {
    diagnostics.push(DIAGNOSTICS.EMPTY_SEQUENCE("WARN"));
  }
  for (const span of findBackdropOnlySpans(seq)) {
    diagnostics.push(DIAGNOSTICS.BACKDROP_ONLY_SPAN(span.start_ms, span.end_ms));
  }
  // A spine-less stretch whose only picture is transparent composition(s)
  // with mostly-empty alpha still shows bare stage backdrop: one aggregate
  // INFO names the spans. Cues without a cached alpha measurement stay silent
  // rather than guessing.
  const sparseTransparentCueIds = new Set<string>();
  if (seq.spine.clips.length === 0) {
    for (const lane of seq.lanes) {
      if (lane.muted || lane.kind === "music" || lane.kind === "sfx" || lane.kind === "voiceover") continue;
      for (const cue of lane.cues) {
        if (!cue.composition || cue.composition.transparent !== true) continue;
        if ((cue.composition.mode ?? "overlay_alpha") === "scene_host") continue;
        const fill = readCompositionAlphaFillRatio(cue.composition.composition_dir, paths);
        if (fill !== null && fill < SPARSE_TRANSPARENT_FILL_THRESHOLD) {
          sparseTransparentCueIds.add(cue.id);
        }
      }
    }
  }
  if (sparseTransparentCueIds.size > 0) {
    const bareSpans = findSpansCoveredOnlyByCues(seq, sparseTransparentCueIds);
    if (bareSpans.length > 0) {
      diagnostics.push(
        DIAGNOSTICS.BARE_BACKDROP_UNDER_TRANSPARENT_COMPOSITION(
          bareSpans,
          seq.stage.backdrop.color,
          [...sparseTransparentCueIds].sort()
        )
      );
    }
  }
}
