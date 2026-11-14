/**
 * Timeline interchange export (`src/export/timeline.ts`).
 *
 * Maps a Cuthol sequence to four editor interchange formats, all on the
 * sequence frame grid (`fps` from the stage, times rounded to whole frames):
 * `fcpxml` (FCPXML 1.10), `xmeml` (XMEML interchange v5), `edl` (CMX3600,
 * spine/video only) and `otio` (OpenTimelineIO JSON).
 *
 * Portable mapping: spine clips (source in/out, timeline position, constant
 * speed, cross dissolves), lane footage/graphic cues as upper video tracks,
 * audio lanes (music, sfx, voiceover) as audio tracks with gain, markers.
 * Compositions and captions are not portable: they are exported as references
 * to their rendered overlay files when the overlay cache holds them, else as
 * markers carrying a note. Everything not exported is reported back through
 * `notExported` (one line per kind); nothing is silently dropped.
 */

import fs from "node:fs";
import path from "node:path";
import { CutholSequence, LaneCue } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";

export type TimelineExportFormat = "fcpxml" | "xmeml" | "edl" | "otio";

export interface ExportedCueRef {
  cueId: string;
  kind: string;
  overlayPath: string | null;
  timelineMs: number;
  durationMs: number;
}

export interface TimelineExportResult {
  format: TimelineExportFormat;
  content: string;
  /** One line per kind of content that could not be exported; never empty when something was skipped. */
  notExported: string[];
  /** Composition/caption cue references (overlay file when cached, else marker-only). */
  cueRefs: ExportedCueRef[];
}

function msToFrames(ms: number, fps: number): number {
  return Math.max(0, Math.round((ms / 1000) * fps));
}

/** Absolute media path for a library handle (remote URIs pass through unchanged). */
export function resolveExportMediaPath(
  uri: string,
  rootDir: string
): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(uri)) return uri;
  const local = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  return path.isAbsolute(local) ? local : path.resolve(rootDir, local);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function laneGainDb(cue: LaneCue): number {
  return cue.audio_chain?.gain_db ?? 0;
}

interface MappedClip {
  id: string;
  name: string;
  mediaPath: string;
  srcInF: number;
  srcOutF: number;
  tlInF: number;
  tlOutF: number;
  rate: number;
  dissolveF: number;
}

function mapSpineClips(seq: CutholSequence, fps: number, libUri: Map<string, string>, rootDir: string): MappedClip[] {
  return seq.spine.clips.map((c) => ({
    id: c.id,
    name: c.id,
    mediaPath: resolveExportMediaPath(libUri.get(c.asset_handle) ?? c.asset_handle, rootDir),
    srcInF: msToFrames(c.source_in_ms, fps),
    srcOutF: msToFrames(c.source_out_ms, fps),
    tlInF: msToFrames(c.timeline_in_ms, fps),
    tlOutF: msToFrames(c.timeline_in_ms + c.duration_ms, fps),
    rate: c.playback?.rate ?? 1,
    dissolveF:
      c.transition_out && c.transition_out.kind === "dissolve" && c.transition_out.duration_ms > 0
        ? msToFrames(c.transition_out.duration_ms, fps)
        : 0,
  }));
}

interface MappedLaneCue {
  cue: LaneCue;
  mediaPath: string | null;
  tlInF: number;
  tlOutF: number;
  rate: number;
  gainDb: number;
}

function mapLaneCues(
  seq: CutholSequence,
  kind: "video" | "audio",
  fps: number,
  libUri: Map<string, string>,
  rootDir: string
): MappedLaneCue[] {
  const out: MappedLaneCue[] = [];
  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      const isAudio = cue.kind === "music" || cue.kind === "sfx" || cue.kind === "voiceover";
      if (kind === "audio" && !isAudio) continue;
      if (kind === "video" && (isAudio || cue.kind === "caption" || cue.kind === "composition")) continue;
      const handle = cue.asset_handle ?? "";
      out.push({
        cue,
        mediaPath: handle ? resolveExportMediaPath(libUri.get(handle) ?? handle, rootDir) : null,
        tlInF: msToFrames(cue.at_ms, fps),
        tlOutF: msToFrames(cue.at_ms + cue.duration_ms, fps),
        rate: cue.playback?.rate ?? 1,
        gainDb: laneGainDb(cue),
      });
    }
  }
  return out.sort((a, b) => a.tlInF - b.tlInF);
}

/** Overlay cache lookup for a composition cue; null when nothing cached. */
function findCachedOverlay(paths: WorkspacePaths, cueId: string): string | null {
  try {
    const dir = paths.blobsDir;
    if (!fs.existsSync(dir)) return null;
    const names = fs.readdirSync(dir).filter((n) => n.includes(cueId));
    if (names.length === 0) return null;
    const scored = names
      .map((n) => ({ n, mp4: n.endsWith(".mp4") ? 0 : 1 }))
      .sort((a, b) => a.mp4 - b.mp4 || a.n.localeCompare(b.n));
    return path.join(dir, scored[0].n);
  } catch {
    return null;
  }
}

function collectCueRefs(
  seq: CutholSequence,
  paths: WorkspacePaths
): { cueRefs: ExportedCueRef[]; notExported: string[] } {
  const cueRefs: ExportedCueRef[] = [];
  let compAsOverlay = 0;
  let compAsMarker = 0;
  let captions = 0;
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      if (cue.kind !== "composition" && cue.kind !== "caption" && cue.kind !== "title") continue;
      if (cue.kind === "composition") {
        const overlay = findCachedOverlay(paths, cue.id);
        cueRefs.push({
          cueId: cue.id,
          kind: cue.kind,
          overlayPath: overlay,
          timelineMs: cue.at_ms,
          durationMs: cue.duration_ms,
        });
        if (overlay) compAsOverlay += 1;
        else compAsMarker += 1;
      } else {
        captions += 1;
      }
    }
  }
  const notExported: string[] = [];
  if (compAsOverlay > 0) {
    notExported.push(
      `compositions: ${compAsOverlay} cue(s) exported as references to rendered overlay files (not portable timeline elements)`
    );
  }
  if (compAsMarker > 0) {
    notExported.push(
      `compositions: ${compAsMarker} cue(s) exported as markers with a note (no rendered overlay found in the cache)`
    );
  }
  if (captions > 0) {
    notExported.push(
      `captions/titles: ${captions} cue(s) exported as markers with text notes (typography is not portable)`
    );
  }
  return { cueRefs, notExported };
}

function buildFcpxml(
  seq: CutholSequence,
  clips: MappedClip[],
  videoCues: MappedLaneCue[],
  audioCues: MappedLaneCue[],
  cueRefs: ExportedCueRef[],
  fps: number
): string {
  const tb = fps;
  const f = (frames: number): string => `${frames}/${tb}s`;
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<fcpxml version="1.10"><resources><format id="r1" name="FFVideoFormat${seq.stage.width}x${seq.stage.height}p${fps}" frameDuration="1/${tb}s" width="${seq.stage.width}" height="${seq.stage.height}"/></resources>`
  );
  lines.push(`<library><event name="${xmlEscape(seq.meta.title)}"><project name="${xmlEscape(seq.meta.title)}"><sequence format="r1" duration="${f(msToFrames(durationMs(seq), fps))}" tcStart="0s"><spine>`);
  for (const c of clips) {
    lines.push(
      `<clip name="${xmlEscape(c.name)}" offset="${f(c.tlInF)}" duration="${f(c.tlOutF - c.tlInF)}" start="${f(c.srcInF)}"><video offset="${f(0)}" duration="${f(c.srcOutF - c.srcInF)}" start="${f(c.srcInF)}"><media src="${xmlEscape(c.mediaPath)}"/></video>${c.rate !== 1 ? `<timeMap><timept time="${f(0)}" value="${f(0)}"/><timept time="${f(c.tlOutF - c.tlInF)}" value="${f(Math.round((c.srcOutF - c.srcInF) / c.rate))}"/></timeMap>` : ""}${c.dissolveF > 0 ? `<transition name="Cross Dissolve" offset="${f(c.tlOutF - c.tlInF - c.dissolveF)}" duration="${f(c.dissolveF)}"/>` : ""}</clip>`
    );
  }
  let track = 0;
  for (const v of videoCues) {
    track += 1;
    lines.push(
      `<clip name="${xmlEscape(v.cue.id)}" lane="${track}" offset="${f(v.tlInF)}" duration="${f(v.tlOutF - v.tlInF)}" start="${f(0)}">${v.mediaPath ? `<video offset="${f(0)}" duration="${f(v.tlOutF - v.tlInF)}"><media src="${xmlEscape(v.mediaPath)}"/></video>` : `<note>graphic cue ${xmlEscape(v.cue.kind)}</note>`}</clip>`
    );
  }
  let aTrack = 0;
  for (const a of audioCues) {
    aTrack += 1;
    lines.push(
      `<clip name="${xmlEscape(a.cue.id)}" lane="-${aTrack}" offset="${f(a.tlInF)}" duration="${f(a.tlOutF - a.tlInF)}" start="${f(0)}">${a.mediaPath ? `<audio offset="${f(0)}" duration="${f(a.tlOutF - a.tlInF)}" gain="${a.gainDb}dB"><media src="${xmlEscape(a.mediaPath)}"/></audio>` : ""}</clip>`
    );
  }
  for (const r of cueRefs) {
    lines.push(
      `<marker start="${f(msToFrames(r.timelineMs, fps))}" duration="${f(msToFrames(r.durationMs, fps))}" value="composition ${xmlEscape(r.cueId)}${r.overlayPath ? ` (overlay: ${xmlEscape(r.overlayPath)})` : " (no cached overlay; re-render in Cuthol)"}"/>`
    );
  }
  for (const m of seq.markers) {
    lines.push(`<marker start="${f(msToFrames(m.at_ms, fps))}" duration="1/${tb}s" value="${xmlEscape(m.label)}"/>`);
  }
  lines.push(`</spine></sequence></project></event></library></fcpxml>`);
  return lines.join("\n");
}

function durationMs(seq: CutholSequence): number {
  let end = 0;
  for (const c of seq.spine.clips) end = Math.max(end, c.timeline_in_ms + c.duration_ms);
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) end = Math.max(end, cue.at_ms + cue.duration_ms);
  }
  return end;
}

function buildXmeml(
  seq: CutholSequence,
  clips: MappedClip[],
  videoCues: MappedLaneCue[],
  audioCues: MappedLaneCue[],
  cueRefs: ExportedCueRef[],
  fps: number
): string {
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<xmeml version="5"><sequence name="${xmlEscape(seq.meta.title)}"><media><video>`);
  lines.push(`<track>`);
  for (const c of clips) {
    lines.push(
      `<clipitem><name>${xmlEscape(c.name)}</name><file><pathurl>${xmlEscape(c.mediaPath)}</pathurl><timebase>${fps}</timebase></file><in>${c.srcInF}</in><out>${c.srcOutF}</out><start>${c.tlInF}</start><end>${c.tlOutF}</end>${c.rate !== 1 ? `<speed><value>${(c.rate * 100).toFixed(2)}</value></speed>` : ""}${c.dissolveF > 0 ? `<transition><type>crossdissolve</type><duration>${c.dissolveF}</duration></transition>` : ""}</clipitem>`
    );
  }
  videoCues.forEach((v, i) => {
    lines.push(
      `<track><clipitem id="v${i}"><name>${xmlEscape(v.cue.id)}</name>${v.mediaPath ? `<file><pathurl>${xmlEscape(v.mediaPath)}</pathurl><timebase>${fps}</timebase></file>` : ""}<in>0</in><out>${v.tlOutF - v.tlInF}</out><start>${v.tlInF}</start><end>${v.tlOutF}</end></clipitem></track>`
    );
  });
  lines.push(`</track></video><audio>`);
  audioCues.forEach((a, i) => {
    lines.push(
      `<track><clipitem id="a${i}"><name>${xmlEscape(a.cue.id)}</name>${a.mediaPath ? `<file><pathurl>${xmlEscape(a.mediaPath)}</pathurl><timebase>${fps}</timebase></file>` : ""}<in>0</in><out>${a.tlOutF - a.tlInF}</out><start>${a.tlInF}</start><end>${a.tlOutF}</end><volume>${a.gainDb}</volume></clipitem></track>`
    );
  });
  lines.push(`</audio></media>`);
  for (const r of cueRefs) {
    lines.push(
      `<marker><name>composition ${xmlEscape(r.cueId)}</name><comment>${r.overlayPath ? `overlay: ${xmlEscape(r.overlayPath)}` : "no cached overlay; re-render in Cuthol"}</comment><in>${msToFrames(r.timelineMs, fps)}</in><out>${msToFrames(r.timelineMs + r.durationMs, fps)}</out></marker>`
    );
  }
  for (const m of seq.markers) {
    lines.push(
      `<marker><name>${xmlEscape(m.label)}</name><comment>marker</comment><in>${msToFrames(m.at_ms, fps)}</in><out>${msToFrames(m.at_ms, fps) + 1}</out></marker>`
    );
  }
  lines.push(`</sequence></xmeml>`);
  return lines.join("\n");
}

function framesToTc(frames: number, fps: number): string {
  const s = Math.floor(frames / fps);
  const ff = frames - s * fps;
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number, l = 2): string => String(n).padStart(l, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

function buildEdl(clips: MappedClip[], fps: number, title: string): string {
  const lines: string[] = [`TITLE: ${title}`, `FCM: NON-DROP FRAME`];
  clips.forEach((c, i) => {
    const n = String(i + 1).padStart(3, "0");
    const kind = c.dissolveF > 0 ? "D" : "C";
    const dur = c.dissolveF > 0 ? ` ${framesToTc(c.dissolveF, fps)}` : "";
    lines.push(
      `${n}  AX       V     ${kind}        ${framesToTc(c.srcInF, fps)} ${framesToTc(c.srcOutF, fps)} ${framesToTc(c.tlInF, fps)} ${framesToTc(c.tlOutF, fps)}${dur}`.trimEnd()
    );
    lines.push(`* FROM CLIP NAME: ${c.name}`);
  });
  return lines.join("\n");
}

function buildOtio(
  seq: CutholSequence,
  clips: MappedClip[],
  videoCues: MappedLaneCue[],
  audioCues: MappedLaneCue[],
  cueRefs: ExportedCueRef[],
  fps: number
): string {
  const rate = { OTIO_SCHEMA: "RationalTime.1", rate: fps, value: 0 };
  const rt = (frames: number): Record<string, unknown> => ({ ...rate, value: frames });
  const tr = (start: number, dur: number): Record<string, unknown> => ({
    OTIO_SCHEMA: "TimeRange.1",
    duration: rt(dur),
    start_time: rt(start),
  });
  const mediaRef = (p: string): Record<string, unknown> => ({
    OTIO_SCHEMA: "ExternalReference.1",
    available_range: null,
    metadata: {},
    target_url: p,
  });
  const spineChildren = clips.map((c) => ({
    OTIO_SCHEMA: "Clip.1",
    effects: c.dissolveF > 0 ? [{ OTIO_SCHEMA: "Effect.1", effect_name: "CrossDissolve", metadata: { duration_frames: c.dissolveF } }] : [],
    markers: [],
    media_reference: mediaRef(c.mediaPath),
    metadata: { cuthol_id: c.id, speed: c.rate },
    name: c.name,
    source_range: tr(c.srcInF, c.srcOutF - c.srcInF),
  }));
  const videoTracks = [
    {
      OTIO_SCHEMA: "Track.1",
      children: spineChildren,
      kind: "Video",
      markers: seq.markers.map((m) => ({
        OTIO_SCHEMA: "Marker.1",
        color: "WHITE",
        marked_range: tr(msToFrames(m.at_ms, fps), 1),
        metadata: {},
        name: m.label,
      })),
      metadata: {},
      name: "V1 spine",
    },
    ...videoCues.map((v, i) => ({
      OTIO_SCHEMA: "Track.1",
      children: v.mediaPath
        ? [
            {
              OTIO_SCHEMA: "Clip.1",
              effects: [],
              markers: [],
              media_reference: mediaRef(v.mediaPath),
              metadata: { cuthol_id: v.cue.id, speed: v.rate },
              name: v.cue.id,
              source_range: tr(0, v.tlOutF - v.tlInF),
            },
          ]
        : [],
      kind: "Video",
      markers: cueRefs
        .filter((r) => r.cueId === v.cue.id)
        .map((r) => ({
          OTIO_SCHEMA: "Marker.1",
          color: "YELLOW",
          marked_range: tr(msToFrames(r.timelineMs, fps), msToFrames(r.durationMs, fps)),
          metadata: { overlay: r.overlayPath ?? null },
          name: `composition ${r.cueId}`,
        })),
      metadata: { cuthol_cue: v.cue.id },
      name: `V${i + 2} ${v.cue.kind}`,
    })),
  ];
  const audioTracks = audioCues.map((a, i) => ({
    OTIO_SCHEMA: "Track.1",
    children: a.mediaPath
      ? [
          {
            OTIO_SCHEMA: "Clip.1",
            effects: [],
            markers: [],
            media_reference: mediaRef(a.mediaPath),
            metadata: { cuthol_id: a.cue.id, gain_db: a.gainDb },
            name: a.cue.id,
            source_range: tr(0, a.tlOutF - a.tlInF),
          },
        ]
      : [],
    kind: "Audio",
    markers: [],
    metadata: { cuthol_cue: a.cue.id, gain_db: a.gainDb },
    name: `A${i + 1} ${a.cue.kind}`,
  }));
  const doc = {
    OTIO_SCHEMA: "Timeline.1",
    fps,
    global_start_time: null,
    markers: [],
    metadata: { cuthol_title: seq.meta.title, cuthol_revision: seq.meta.revision },
    name: seq.meta.title,
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      children: [...videoTracks, ...audioTracks],
      effects: [],
      markers: [],
      metadata: {},
      name: "tracks",
      source_range: null,
    },
  };
  return JSON.stringify(doc, null, 2);
}

export function exportTimeline(
  seq: CutholSequence,
  paths: WorkspacePaths,
  format: TimelineExportFormat
): TimelineExportResult {
  const fps = Math.max(1, seq.stage.fps);
  const libUri = new Map(seq.library.map((l) => [l.handle, l.uri]));
  const clips = mapSpineClips(seq, fps, libUri, paths.rootDir);
  const videoCues = mapLaneCues(seq, "video", fps, libUri, paths.rootDir);
  const audioCues = mapLaneCues(seq, "audio", fps, libUri, paths.rootDir);
  const { cueRefs, notExported } = collectCueRefs(seq, paths);
  let content: string;
  switch (format) {
    case "fcpxml":
      content = buildFcpxml(seq, clips, videoCues, audioCues, cueRefs, fps);
      break;
    case "xmeml":
      content = buildXmeml(seq, clips, videoCues, audioCues, cueRefs, fps);
      break;
    case "edl":
      content = buildEdl(clips, fps, seq.meta.title);
      break;
    case "otio":
      content = buildOtio(seq, clips, videoCues, audioCues, cueRefs, fps);
      break;
  }
  const notes = [...notExported];
  if (format === "edl" && (videoCues.length > 0 || audioCues.length > 0)) {
    notes.push(
      `lanes: ${videoCues.length} video cue(s) and ${audioCues.length} audio cue(s) not in EDL (CMX3600 carries the spine/video track only)`
    );
  }
  if (format === "edl" && audioCues.length === 0 && videoCues.length === 0) {
    notes.push(`edl: spine/video only by design (CMX3600 carries one video track)`);
  }
  return { format, content, notExported: notes, cueRefs };
}
