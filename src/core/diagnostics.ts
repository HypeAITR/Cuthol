/**
 * Centralized Diagnostic Dictionary for Cuthol.
 *
 * Every error and warning emitted by Cuthol CLI or MCP tools MUST originate from this file
 * and follow the uniform structure:
 *   `[CUTHOL-<CODE>] <What Happened> | Suggestion: <Next Action Hint for the Agent>`
 */

export type DiagnosticSeverity = "ERROR" | "WARN" | "INFO";

export type VerificationGateId =
  | "G1_SCHEMA"
  | "G2_ASSETS"
  | "G3_TIMING"
  | "G4_STAGE"
  | "G5_SIGNAL"
  | "SYS";

export interface CutholDiagnostic {
  code: string;
  gate: VerificationGateId;
  severity: DiagnosticSeverity;
  what: string;
  suggestion: string;
  subject_id?: string;
  formatted: string;
}

export function createDiagnostic(
  code: string,
  gate: VerificationGateId,
  severity: DiagnosticSeverity,
  what: string,
  suggestion: string,
  subject_id?: string
): CutholDiagnostic {
  const formatted = `[${code}] ${what} | Suggestion: ${suggestion}`;
  return { code, gate, severity, what, suggestion, subject_id, formatted };
}

export class CutholError extends Error {
  public readonly diagnostic: CutholDiagnostic;
  public readonly allDiagnostics?: CutholDiagnostic[];

  constructor(diagnostic: CutholDiagnostic, allDiagnostics?: CutholDiagnostic[]) {
    super(diagnostic.formatted);
    this.name = "CutholError";
    this.diagnostic = diagnostic;
    this.allDiagnostics = allDiagnostics;
  }
}

export const DIAGNOSTICS = {
  // --- External project changes: CUTHOL-G210, CUTHOL-G211 ---
  EXTERNAL_CHANGES_PRESENT: (summary: string) =>
    createDiagnostic(
      "CUTHOL-G210",
      "G2_ASSETS",
      "INFO",
      `External changes detected in the project folder (made outside Cuthol): ${summary}`,
      `First inspect the diff with 'cuthol workspace changes show', then run 'cuthol workspace changes adopt' (adopt, undoable) or 'cuthol workspace changes revert' (back to Cuthol's last state).`
    ),

  EXTERNAL_CHANGE_WOULD_BE_OVERWRITTEN: (target: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G211",
      "G2_ASSETS",
      "ERROR",
      `'${target}' was changed outside Cuthol; this operation would have overwritten it and was stopped (${detail}). The file was left unchanged so your edit is not lost.`,
      `First inspect the diff with 'cuthol workspace changes show', then run 'cuthol workspace changes adopt' or 'cuthol workspace changes revert' and retry the operation.`
    ),

  // --- Cuthol Live: CUTHOL-G601..G619 ---
  // Blocks: G601 lock (contract) · G602–G605 server/inbox · G606–G608 window/timeline ·
  // G609–G612 live preview/proxies · G613–G615 progress/config · G616–G617 notes · G618–G619 human edits.
  LIVE_PAUSED_BY_USER: (operation: string, since: string) =>
    createDiagnostic(
      "CUTHOL-G601",
      "G1_SCHEMA",
      "ERROR",
      `The user paused the agent in the Cuthol Live window (since ${since}) and is editing the timeline; '${operation}' was not applied.`,
      `Do not retry yet. Run 'cuthol live wait' (MCP: workspace action=live_wait); it returns when the user resumes, with a summary of their edits. Read-only commands still work.`
    ),
  // [live:A G602–G605]
  LIVE_SERVER_START_FAILED: (dir: string) =>
    createDiagnostic(
      "CUTHOL-G602",
      "SYS",
      "ERROR",
      `The Cuthol Live server for '${dir}' did not start within 10 s.`,
      `Check '.cuthol/live/server.log' in the project, stop any stale server with 'cuthol live stop --dir "${dir}"', and retry 'cuthol live open'.`
    ),
  // [live:B G606–G608]
  LIVE_WINDOW_OPEN_FAILED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G606",
      "SYS",
      "WARN",
      `The Cuthol Live window could not be opened (${detail}). The live server keeps running; the agent's work continues.`,
      `Open the URL from 'cuthol live open' manually in Edge or Chrome, or retry once the browser is installed.`
    ),
  LIVE_THUMB_FAILED: (sceneId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G607",
      "SYS",
      "WARN",
      `Scene thumbnail for '${sceneId}' could not be rendered (${detail}); the scene list shows a placeholder.`,
      `Check that the scene's source media exists and 'monitor frame' works for the project, then re-open the Live window.`,
      sceneId
    ),
  // [live:C G609–G612]
  LIVE_PROXY_ENCODE_FAILED: (handle: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G609",
      "G2_ASSETS",
      "WARN",
      `Preview proxy for '${handle}' could not be encoded (${detail}); the window plays the original media instead.`,
      `Check that ffmpeg is on PATH and the source file is readable, then re-open the Live window to retry.`
    ),
  LIVE_PROXY_SOURCE_MISSING: (handle: string) =>
    createDiagnostic(
      "CUTHOL-G610",
      "G2_ASSETS",
      "WARN",
      `Preview proxy for '${handle}' was requested but the library asset file is missing.`,
      `Relink or re-import the asset; the preview falls back to the original media path.`
    ),
  LIVE_COMP_SERVE_BLOCKED: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G611",
      "G1_SCHEMA",
      "WARN",
      `Composition files for cue '${cueId}' could not be served to the Live preview (${detail}).`,
      `Check that the cue's composition_dir exists inside the project and entry_html is present.`
    ),
  LIVE_EXACT_FRAME_FAILED: (atMs: number, detail: string) =>
    createDiagnostic(
      "CUTHOL-G612",
      "G5_SIGNAL",
      "WARN",
      `Exact preview frame at ${atMs}ms could not be rendered (${detail}).`,
      `Run 'cuthol monitor frame --at ${atMs}ms' to see the full error.`
    ),
  // [live:D G613–G615]
  LIVE_CONFIG_INVALID_MODE: (where: string, value: string) =>
    createDiagnostic(
      "CUTHOL-G613",
      "G1_SCHEMA",
      "ERROR",
      `Invalid Cuthol Live mode '${value}' in ${where}; expected 'ask', 'on' or 'off'.`,
      `Run 'cuthol live config --mode ask|on|off' (add '--global' for the user-level setting) to fix it.`
    ),
  LIVE_CONFIG_WRITE_FAILED: (file: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G614",
      "SYS",
      "ERROR",
      `Could not write the Cuthol Live user setting to '${file}': ${reason}.`,
      `Check that the folder exists and is writable, or set the project-level mode instead ('cuthol live config --mode ask|on|off').`
    ),
  // [live:E G616–G617]
  LIVE_NOTE_COORDS_FAILED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G616",
      "G5_SIGNAL",
      "WARN",
      `Live note coordinate lookup failed or timed out (${detail}); the note is kept without element names.`,
      `Wait for the coordinate cache to warm up (the window retries automatically), or send the note without elements.`
    ),
  LIVE_NOTE_SHEET_FAILED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G617",
      "G5_SIGNAL",
      "WARN",
      `Live note contact sheet could not be rendered (${detail}); the packet is queued without an image.`,
      `Run 'cuthol monitor frame' for the note's timestamp to see the full error; the note text still reaches the agent.`
    ),
  // [live:F G618–G619]
  LIVE_EDIT_REVISION_CONFLICT: (
    action: string,
    detail: string,
    suggestion = "The timeline changed under the Live window; it refreshes automatically. Retry the edit, and use undo only for your own edits made while the agent is paused."
  ) =>
    createDiagnostic(
      "CUTHOL-G618",
      "SYS",
      "ERROR",
      `Live edit '${action}' was not applied: ${detail}.`,
      suggestion
    ),
  LIVE_EDIT_COMMAND_FAILED: (action: string, target: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G619",
      "SYS",
      "ERROR",
      `Live edit '${action}' on '${target}' failed: ${detail}.`,
      `Fix the underlying problem (see the command diagnostic above) and retry. If the timeline looks wrong, undo the paused session's edits one step at a time.`
    ),
  // [settings G620–G624]
  SETTINGS_UNKNOWN_KEY: (key: string) =>
    createDiagnostic(
      "CUTHOL-G620",
      "G1_SCHEMA",
      "ERROR",
      `Unknown settings key '${key}'.`,
      `Run 'cuthol settings list' to see the available keys.`
    ),
  SETTINGS_INVALID_VALUE: (key: string, value: string, expected: string) =>
    createDiagnostic(
      "CUTHOL-G621",
      "G1_SCHEMA",
      "ERROR",
      `Invalid value ${value} for setting '${key}'; expected ${expected}.`,
      `Run 'cuthol settings get ${key}' to see the current value and source.`
    ),
  SETTINGS_AGENT_READONLY: (key: string) =>
    createDiagnostic(
      "CUTHOL-G622",
      "G1_SCHEMA",
      "ERROR",
      `Setting '${key}' cannot be changed by the agent; it is window-only.`,
      `Change it in the Live window (Settings > Shortcuts) instead.`
    ),
  SETTINGS_WRITE_FAILED: (file: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G623",
      "SYS",
      "ERROR",
      `Could not write the setting to '${file}': ${reason}.`,
      `Check that the folder exists and is writable.`
    ),
  SETTINGS_ENV_LOCKED: (key: string, variable: string) =>
    createDiagnostic(
      "CUTHOL-G624",
      "G1_SCHEMA",
      "ERROR",
      `Setting '${key}' is locked by environment variable ${variable}; unset it to change the stored value.`,
      `Unset ${variable} and re-run, or keep the environment value.`
    ),
  // [doctor G625–G629]
  DOCTOR_FFMPEG_MISSING: () =>
    createDiagnostic(
      "CUTHOL-G625",
      "SYS",
      "ERROR",
      "ffmpeg or ffprobe was not found on PATH.",
      "Install ffmpeg 8.x (ffmpeg and ffprobe) and put it on PATH."
    ),
  DOCTOR_BROWSER_MISSING: () =>
    createDiagnostic(
      "CUTHOL-G626",
      "SYS",
      "ERROR",
      "No Chrome/Chromium browser was found for HyperFrames rendering.",
      "Install Google Chrome or Microsoft Edge and retry."
    ),
  // [setup G630–G634]
  SETUP_CONFIG_UNPARSEABLE: (file: string) =>
    createDiagnostic(
      "CUTHOL-G630",
      "SYS",
      "ERROR",
      `'${file}' cannot be parsed; left unchanged.`,
      `Fix the file syntax and re-run 'cuthol setup --apply'.`
    ),
  SETUP_UNKNOWN_AGENT: (id: string) =>
    createDiagnostic(
      "CUTHOL-G631",
      "G1_SCHEMA",
      "ERROR",
      `Unknown agent id '${id}' for setup.`,
      `Use one of: claude-code, codex, cursor, gemini-cli.`
    ),
  SETUP_MANUAL_ONLY: (id: string, instruction: string) =>
    createDiagnostic(
      "CUTHOL-G632",
      "SYS",
      "INFO",
      `Agent tool '${id}' has no writable config; registration is manual: ${instruction}`,
      `Follow the tool's MCP docs to register the printed command.`
    ),
  SETUP_DIFFERENT_ENTRY: (where: string) =>
    createDiagnostic(
      "CUTHOL-G633",
      "SYS",
      "WARN",
      `An existing cuthol entry in '${where}' runs a different command; not replaced without --force.`,
      `Re-run with '--force' to replace it.`
    ),
  SETUP_WRITE_FAILED: (file: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G634",
      "SYS",
      "ERROR",
      `Could not write '${file}': ${reason}.`,
      `Check that the folder exists and is writable.`
    ),
  // [lane-mute G125–G126]
  LANE_MUTE_SPINE: () =>
    createDiagnostic(
      "CUTHOL-G125",
      "G1_SCHEMA",
      "ERROR",
      "The spine is not a lane: 'lane mute' cannot target 'spine'.",
      "Mute a spine clip with 'cuthol spine mute --clip <id>', or pass a lane id ('ln_*') to 'cuthol lane mute --lane <id>'.",
      "spine"
    ),
  // [script-ext G433, G438–G439]
  // [monitor-scaffold G214–G216]
  BARE_DURATION_AS_MS: (raw: string) =>
    createDiagnostic(
      "CUTHOL-G214",
      "G1_SCHEMA",
      "WARN",
      `Duration '${raw}' was read as ${raw} milliseconds; did you mean seconds? (e.g. ${raw}s)`,
      `Add a unit to the duration (e.g. '${raw}s' or '${Number(raw) * 1000}ms'). Bare numbers stay milliseconds.`
    ),

  // --- Environment: CUTHOL-G212 ---
  FFMPEG_VERSION_BELOW_SUPPORTED: (tool: string, found: string) =>
    createDiagnostic(
      "CUTHOL-G212",
      "G2_ASSETS",
      "WARN",
      `${tool} ${found} found; Cuthol is tested with ffmpeg/ffprobe 8.x (tempo, loudness and scene analysis may differ).`,
      `Install ffmpeg and ffprobe 8.x on PATH and re-run.`
    ),

  // --- Speech language: CUTHOL-G213 ---
  ASR_LANGUAGE_REQUIRED: (provider: string) =>
    createDiagnostic(
      "CUTHOL-G213",
      "SYS",
      "ERROR",
      `ASR provider '${provider}' cannot detect the speech language automatically, and no language was given.`,
      `Re-run with an explicit language, e.g. 'cuthol speech transcribe --handle <id> --lang en --provider ${provider}'.`
    ),

  // --- System & Workspace (SYS) ---
  WORKSPACE_NOT_FOUND: (dir: string) =>
    createDiagnostic(
      "CUTHOL-SYS01",
      "SYS",
      "ERROR",
      `No initialized Cuthol workspace ('cuthol.sequence.json') found in '${dir}'.`,
      `Create the workspace first with 'cuthol workspace init "${dir}"'.`
    ),

  INVALID_TIME_LITERAL: (raw: string) =>
    createDiagnostic(
      "CUTHOL-SYS02",
      "SYS",
      "ERROR",
      `'${raw}' is not a valid time expression.`,
      `Pass a time value with an explicit unit ('1250ms', '1.25s', '0.5min') or in 'MM:SS.mmm' form.`
    ),

  INVALID_COLOR: (raw: string) =>
    createDiagnostic(
      "CUTHOL-SYS07",
      "SYS",
      "ERROR",
      `'${raw}' is not a valid color.`,
      `Pass the color as 6-digit hex '#RRGGBB' (e.g. '#F7C531').`
    ),

  JOURNAL_REVISION_UNAVAILABLE: (direction: "undo" | "redo") =>
    createDiagnostic(
      "CUTHOL-SYS03",
      "SYS",
      "ERROR",
      `No further revision to go to in the '${direction}' direction in the journal.`,
      `Check the revision history with 'cuthol workspace journal list'.`
    ),

  EXTERNAL_TOOL_FAILED: (tool: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-SYS04",
      "SYS",
      "ERROR",
      `'${tool}' subprocess failed: ${detail}`,
      `Verify the input file is not corrupt and '${tool}' is on the system PATH.`
    ),

  MISSING_API_KEY: (envVarName: string, serviceName: string) =>
    createDiagnostic(
      "CUTHOL-SYS05",
      "SYS",
      "ERROR",
      `Environment variable '${envVarName}' is not set for the ${serviceName} service.`,
      `Add the '${envVarName}=...' key to the '.env' file in the working directory.`
    ),

  TRANSCRIPT_NOT_FOUND: (handle: string) =>
    createDiagnostic(
      "CUTHOL-SYS06",
      "SYS",
      "ERROR",
      `No cached transcript found for source '${handle}'.`,
      `Run 'cuthol speech transcribe --handle ${handle}' first.`
    ),

  // --- Gate 1: Schema & Handle Integrity (G1_SCHEMA) ---
  UNKNOWN_HANDLE: (handle: string) =>
    createDiagnostic(
      "CUTHOL-G101",
      "G1_SCHEMA",
      "ERROR",
      `Handle '${handle}' not found in the active sequence.`,
      `List the available media, clip and lane handles with 'cuthol brief --lens overview'.`,
      handle
    ),

  DUPLICATE_HANDLE: (handle: string) =>
    createDiagnostic(
      "CUTHOL-G102",
      "G1_SCHEMA",
      "ERROR",
      `Handle '${handle}' is defined on more than one item in the sequence.`,
      `Every media item ('vid_*', 'aud_*'), spine clip ('sp_*') and lane cue ('cue_*') must have a unique handle.`,
      handle
    ),

  DANGLING_ASSET_REF: (ownerId: string, assetHandle: string) =>
    createDiagnostic(
      "CUTHOL-G103",
      "G1_SCHEMA",
      "ERROR",
      `Item '${ownerId}' refers to source '${assetHandle}', which is not in the library.`,
      `Add the media first with 'cuthol library ingest', or use a valid library handle.`,
      ownerId
    ),

  DANGLING_ANCHOR_REF: (cueId: string, anchorRef: string) =>
    createDiagnostic(
      "CUTHOL-G104",
      "G1_SCHEMA",
      "ERROR",
      `Lane cue '${cueId}' is anchored to spine clip '${anchorRef}', which does not exist.`,
      `Point the anchor at an existing 'sp_*' clip, or convert it to an absolute 'at_ms' time.`,
      cueId
    ),

  INVALID_COMPOSITION_CONTRACT: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G105",
      "G1_SCHEMA",
      "ERROR",
      `HyperFrames composition '${cueId}' failed the contract check: ${detail}`,
      `Fix 'data-composition-id', 'window.__timelines' and the determinism rules in the composition HTML file.`,
      cueId
    ),

  // --- Gate 2: Physical Asset & Boundary Integrity (G2_ASSETS) ---
  MISSING_FILE_ON_DISK: (handle: string, uri: string) =>
    createDiagnostic(
      "CUTHOL-G201",
      "G2_ASSETS",
      "ERROR",
      `File '${uri}' for source '${handle}' not found on disk.`,
      `Fix the file path, or re-ingest the file with 'cuthol library ingest'.`,
      handle
    ),

  SOURCE_RANGE_EXCEEDED: (clipId: string, outMs: number, assetDurationMs: number) =>
    createDiagnostic(
      "CUTHOL-G202",
      "G2_ASSETS",
      "ERROR",
      `Clip '${clipId}' source out-point (${outMs}ms) exceeds the media's physical duration (${assetDurationMs}ms).`,
      `Bring 'source_out_ms' down to ${assetDurationMs}ms or less.`,
      clipId
    ),

  NO_AUDIO_STREAM: (handle: string) =>
    createDiagnostic(
      "CUTHOL-G203",
      "G2_ASSETS",
      "ERROR",
      `Source '${handle}' has no audio stream.`,
      `Run audio analysis or audio separation only on sources with 'has_audio: true'.`,
      handle
    ),

  VARIABLE_FRAME_RATE_SOURCE: (
    handle: string,
    avgFps: number,
    stageFps: number,
    rFrameRate?: string | null,
    avgFrameRate?: string | null
  ) => {
    const rateDetail =
      rFrameRate && avgFrameRate
        ? `, avg=${avgFps} fps [${avgFrameRate}], r_frame_rate=${rFrameRate}`
        : `, avg ${avgFps} fps`;
    const frameStepMs = Math.round((1000 / Math.max(1, stageFps)) * 10) / 10;
    return createDiagnostic(
      "CUTHOL-G207",
      "G2_ASSETS",
      "INFO",
      `Source '${handle}' is variable frame rate (VFR${rateDetail}); during compilation Cuthol converts video to the stage frame rate (${stageFps} fps CFR, 'settb=AVTB,fps=${stageFps}:eof_action=pass') and audio with 'aresample=async=1:first_pts=0'. If the source has sudden frame-rate drops, expect frame duplication/drops there and ±${frameStepMs}ms (1 frame) rounding at cut boundaries.`,
      `Constant-frame-rate conversion is applied automatically; check critical cuts or screen-recording transitions with 'cuthol monitor frame'.`,
      handle
    );
  },

  BT2020_COLOR_SPACE_SOURCE: (
    handle: string,
    colorSpace: string,
    colorTransfer?: string | null,
    colorPrimaries?: string | null
  ) => {
    const trcDetail = colorTransfer ? `, color_transfer=${colorTransfer}` : "";
    const primDetail = colorPrimaries ? `, color_primaries=${colorPrimaries}` : "";
    return createDiagnostic(
      "CUTHOL-G208",
      "G2_ASSETS",
      "INFO",
      `Source '${handle}' is tagged BT.2020 (color_space=${colorSpace}${trcDetail}${primDetail}); Cuthol uses the 'in_color_matrix=bt2020:out_color_matrix=bt709' matrix for the YCbCr->BT.709 conversion, but applies no HDR gamma/primaries tone mapping.`,
      `For SDR BT.2020 sources the matrix conversion is enough; for HDR (PQ/HLG) sources apply external SDR tone mapping if needed, or check colors with 'cuthol monitor frame'.`,
      handle
    );
  },

  AV_STREAM_DURATION_MISMATCH: (videoMs: number, audioMs: number, frameMs: number, handle?: string) =>
    createDiagnostic(
      "CUTHOL-G209",
      "G2_ASSETS",
      "WARN",
      `In the processor output the video stream is ${Math.round(videoMs)} ms and audio is ${Math.round(audioMs)} ms; the gap is larger than one frame (${Math.max(1, Math.round(frameMs))} ms).`,
      `Add "audio": "drop" to the processor to drop audio on a duration-changing video filter, or write an audio_filter that equalizes the durations.`,
      handle
    ),

  // --- Gate 3: Temporal Continuity & Frame Budget (G3_TIMING) ---
  SUB_FRAME_DURATION: (itemId: string, durationMs: number, minMs: number) =>
    createDiagnostic(
      "CUTHOL-G301",
      "G3_TIMING",
      "ERROR",
      `Item '${itemId}' duration (${durationMs}ms) is below the 2-frame minimum (${minMs}ms) at the stage frame rate.`,
      `Delete the item or extend its duration to at least ${minMs}ms.`,
      itemId
    ),

  SPINE_DISCONTINUITY: (clipId: string, expectedStartMs: number, actualStartMs: number) =>
    createDiagnostic(
      "CUTHOL-G302",
      "G3_TIMING",
      "ERROR",
      `Clip '${clipId}' on the magnetic spine starts at ${actualStartMs}ms instead of ${expectedStartMs}ms (gap or overlap).`,
      `Use the 'cuthol spine' commands to repair spine continuity.`,
      clipId
    ),

  TRANSITION_TOO_LONG: (clipId: string, transMs: number, maxAllowedMs: number) =>
    createDiagnostic(
      "CUTHOL-G303",
      "G3_TIMING",
      "ERROR",
      `Out-transition of '${clipId}' (${transMs}ms) exceeds the maximum allowed by the neighboring clips (${maxAllowedMs}ms).`,
      `Lower the transition duration to ${maxAllowedMs}ms or less.`,
      clipId
    ),

  INVALID_PLAYBACK_RATE: (clipId: string, rate: number) =>
    createDiagnostic(
      "CUTHOL-G304",
      "G3_TIMING",
      "ERROR",
      `Playback rate (${rate}x) for clip '${clipId}' is outside the valid range (0.1x .. 16.0x).`,
      `Set '--rate' between 0.1 and 16.0.`,
      clipId
    ),

  ENVELOPE_OUT_OF_RANGE: (ownerId: string, param: string, offsetMs: number, durationMs: number) =>
    createDiagnostic(
      "CUTHOL-G305",
      "G3_TIMING",
      "ERROR",
      `Keyframe of '${param}' on '${ownerId}' (${offsetMs}ms) is outside the item duration (0..${durationMs}ms).`,
      `Define keyframe times within 0ms..${durationMs}ms.`,
      ownerId
    ),

  LANE_EXTENDS_PAST_SPINE: (cueId: string, cueEndMs: number, spineEndMs: number) =>
    createDiagnostic(
      "CUTHOL-G306",
      "G3_TIMING",
      "WARN",
      `Lane cue '${cueId}' ends at ${cueEndMs}ms, ${cueEndMs - spineEndMs}ms past the spine duration (${spineEndMs}ms) (no spine picture in ${spineEndMs}..${cueEndMs}ms).`,
      `Append/extend spine clips, or trim '${cueId}' to the ${spineEndMs}ms boundary.`,
      cueId
    ),

  EMPTY_SEQUENCE: (severity: DiagnosticSeverity) =>
    createDiagnostic(
      "CUTHOL-G307",
      "G3_TIMING",
      severity,
      `Empty edit: no clips on the spine and no cues on any unmuted lane (duration 0ms).`,
      `For a footage edit add clips with 'spine append'; for a graphics-only video add a composition with 'lane add-composition' (and audio with 'lane add-cue'). With an empty spine the duration comes from the latest-ending cue.`
    ),

  BACKDROP_ONLY_SPAN: (startMs: number, endMs: number) =>
    createDiagnostic(
      "CUTHOL-G308",
      "G3_TIMING",
      "WARN",
      `Spine is empty and no visual cue is on screen in ${startMs}..${endMs}ms (${endMs - startMs}ms); only the stage backdrop shows during this span.`,
      `Fill the span with a composition/title/visual cue, or extend the adjacent cue; if the empty backdrop is intentional, this warning is informational.`
    ),

  BARE_BACKDROP_UNDER_TRANSPARENT_COMPOSITION: (
    spans: Array<{ start_ms: number; end_ms: number }>,
    backdropColor: string,
    cueIds: string[]
  ) =>
    createDiagnostic(
      "CUTHOL-G316",
      "G3_TIMING",
      "INFO",
      `Spine is empty and in ${spans.map((s) => `${s.start_ms}..${s.end_ms}ms`).join(", ")} the only picture comes from transparent composition cue(s) ${cueIds.map((id) => `'${id}'`).join(", ")} with mostly-empty alpha; bare stage backdrop (${backdropColor}) shows through.`,
      `Set a base color with 'cuthol workspace backdrop --color #RRGGBB', or add an opaque background layer under the composition.`
    ),

  SHORT_SPINE_CLIP: (clipId: string, durationMs: number, recommendedMinMs: number) =>
    createDiagnostic(
      "CUTHOL-G309",
      "G3_TIMING",
      "WARN",
      `Spine clip '${clipId}' is ${durationMs}ms, at most ${recommendedMinMs}ms; a leftover sliver may remain between cuts.`,
      `If it is a leftover, delete it with 'cuthol spine remove --clips ${clipId}' or merge it with the neighboring cut.`,
      clipId
    ),

  SHORT_SPEECH_FRAGMENT: (clipId: string, durationMs: number, maxMs: number) =>
    createDiagnostic(
      "CUTHOL-G312",
      "G3_TIMING",
      "INFO",
      `Spine clip '${clipId}' (${durationMs}ms) is a short speech fragment, possibly a restart leftover.`,
      `Duration is between 150 ms and ${maxMs} ms with audio above the silence floor. If it is a restart leftover, delete it with 'cuthol spine remove --clips ${clipId}'; if intentional, ignore this note.`,
      clipId
    ),

  // --- Gate 4: Stage Geometry, Safe Zones & Legibility (G4_STAGE) ---
  SAFE_ZONE_VIOLATION: (cueId: string, edge: string, overflowPx: number) =>
    createDiagnostic(
      "CUTHOL-G401",
      "G4_STAGE",
      "WARN",
      `Item '${cueId}' crosses the '${edge}' safe-area boundary by ${Math.round(overflowPx)}px (EBU R95 / 9:16 UI margin).`,
      `Move the item closer to the center, or reduce its width/font size.`,
      cueId
    ),

  CAPTION_READING_SPEED_HIGH: (cueId: string, cps: number, maxCps: number) =>
    createDiagnostic(
      "CUTHOL-G402",
      "G4_STAGE",
      "WARN",
      `Caption '${cueId}' reading speed (${cps.toFixed(1)} cps) exceeds the recommended ceiling (${maxCps} cps — Netflix Timed Text / TR adaptation).`,
      `Split the caption text in two, or extend its on-screen duration.`,
      cueId
    ),

  TEXT_OCCLUDED_BY_LAYER: (textCueId: string, occluderCueId: string) =>
    createDiagnostic(
      "CUTHOL-G403",
      "G4_STAGE",
      "WARN",
      `Text item '${textCueId}' is covered by layer '${occluderCueId}' with a higher z_index.`,
      `Raise the text lane's 'z_index', or shift the position of the covering layer.`,
      textCueId
    ),

  SCENE_HOST_RECOMMENDED: (cueId: string, detectedFeatures: string[]) =>
    createDiagnostic(
      "CUTHOL-G406",
      "G4_STAGE",
      "WARN",
      `Composition '${cueId}' contains '${detectedFeatures.join(", ")}' but runs in 'overlay_alpha' (Mode A); these effects cannot see the video pixels underneath.`,
      `Pass '--mode scene_host' explicitly so the effect processes the video pixels underneath.`,
      cueId
    ),

  COMPOSITION_LINT_FINDING: (
    cueId: string,
    ruleCode: string,
    message: string,
    fixHint?: string,
    severity: DiagnosticSeverity = "WARN"
  ) =>
    createDiagnostic(
      "CUTHOL-G407",
      "G4_STAGE",
      severity,
      `HyperFrames lint finding in composition '${cueId}' (${ruleCode}): ${message}`,
      fixHint && fixHint.trim()
        ? fixHint.trim()
        : `Fix the composition HTML/GSAP code per rule '${ruleCode}'.`,
      cueId
    ),

  RENDER_FIELD_NOT_APPLIED: (itemId: string, field: string) =>
    createDiagnostic(
      "CUTHOL-G409",
      "G4_STAGE",
      "WARN",
      `'${field}' on '${itemId}' is not applied to the render in this version.`,
      `Leave this field at its default. On spine clips, static and enveloped brightness/contrast/saturation, color temperature and LUT reach the render; motion blur, masks and color envelopes on lane cues do not.`,
      itemId
    ),

  // --- Gate 5: Audio Signal & Render Frame Sanity (G5_SIGNAL) ---
  TRUE_PEAK_CEILING_EXCEEDED: (itemId: string, peakDbtp: number, ceilingDbtp: number) =>
    createDiagnostic(
      "CUTHOL-G501",
      "G5_SIGNAL",
      "WARN",
      `True peak of audio signal '${itemId}' (${peakDbtp.toFixed(1)} dBTP) exceeds the ITU-R BS.1770-4 ceiling (${ceilingDbtp.toFixed(1)} dBTP).`,
      `Run 'cuthol mix normalize --target-lufs -14', or lower the clip gain ('gain_db').`,
      itemId
    ),

  BLANK_FRAME_DETECTED: (timestampMs: number, lumaMean: number, lumaStd: number) =>
    createDiagnostic(
      "CUTHOL-G502",
      "G5_SIGNAL",
      "WARN",
      `Sampled frame at ${timestampMs}ms is almost fully dark/blank or flat backdrop color (luma mean=${lumaMean.toFixed(1)}, std=${lumaStd.toFixed(2)}).`,
      `Check the frame with 'cuthol monitor frame --at ${timestampMs}ms'; if it is not an intentional fade, fix the source range.`
    ),

  RENDER_EDGE_STRIP: (edges: string[], width: number, height: number) =>
    createDiagnostic(
      "CUTHOL-G506",
      "G5_SIGNAL",
      "WARN",
      `There is an 8px black strip on the ${edges.join(" and ")} edge of the render output (${width}x${height}); the content does not reach the edge.`,
      `This is usually caused by an ffmpeg build zeroing the last columns when converting planar RGB to yuv420p at widths that are not multiples of 16 (e.g. 1080). Check the ffmpeg/HyperFrames version and re-render; if the problem persists, set the stage width to a multiple of 16.`
    ),

  RENDER_BLANK_FRAMES_DETECTED: (
    events: Array<{ start_s: number; start_ms: number; frame_count: number; clip_id?: string }>
  ) => {
    const totalFrames = events.reduce((acc, e) => acc + e.frame_count, 0);
    const timeList = events
      .map((e) => `${e.start_s}s (${e.start_ms}ms${e.clip_id ? `, ${e.clip_id}` : ""})`)
      .join(", ");
    const firstMs = events[0]?.start_ms ?? 0;
    return createDiagnostic(
      "CUTHOL-G502",
      "G5_SIGNAL",
      "WARN",
      events.every((e) => e.clip_id)
        ? `Blank flat/backdrop-colored frames detected in the render output at ${events.length} point(s) (${totalFrames} frames) during an active spine clip: ${timeList}.`
        : `Blank frames in the render output in ${events.length} span(s) (${totalFrames} frames) with no visual cue (only the stage backdrop visible): ${timeList}.`,
      events.every((e) => e.clip_id)
        ? `Check the cut point with 'cuthol monitor frame --at ${firstMs}ms'; if it is not an intentional fade, fix the source clip range or the transition boundaries.`
        : `Check with 'cuthol monitor frame --at ${firstMs}ms'; fill the span with a composition/visual cue, or extend the adjacent cue.`
    );
  },

  HYPERFRAMES_RENDER_FAILED: (compositionDir: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G503",
      "G5_SIGNAL",
      "ERROR",
      `HyperFrames composition '${compositionDir}' failed to render; the render was stopped (no fallback image is substituted): ${reason}`,
      `Open the composition with 'composition preview' to see the error, check the HTML/GSAP code with 'npx hyperframes check'; verify browser (Chrome/Edge) access with 'npx hyperframes doctor'.`,
      compositionDir
    ),

  // --- Unprobed compositions: CUTHOL-G509 ---
  COMPOSITIONS_NEVER_PROBED_IN_BROWSER: (count: number) =>
    createDiagnostic(
      "CUTHOL-G509",
      "G4_STAGE",
      "INFO",
      count === 1
        ? `1 composition was never opened in a browser, so its script is unchecked (no record).`
        : `${count} compositions were never opened in a browser, so their scripts are unchecked (no record).`,
      `Run 'cuthol composition preview --cue <cue_XX>' (or 'composition coords --all' / 'monitor frame') to record a script-error check.`
    ),

  DUCKING_WITHOUT_TRANSCRIPT: (clipIds: string[], mode: "skipped" | "acoustic_vad") =>
    createDiagnostic(
      "CUTHOL-G504",
      "G5_SIGNAL",
      "WARN",
      mode === "skipped"
        ? `Spine clips '${clipIds.join(", ")}' have no transcript, so ducking was applied from transcribed clips and 'ln_vo' voiceovers only.`
        : `Spine clips '${clipIds.join(", ")}' have no transcript, so ducking was computed from signal-based acoustic energy (VAD).`,
      `For word-accurate ducking, run 'cuthol speech transcribe --handle <vid_XX>' first on clips containing speech.`
    ),

  OPAQUE_OVERLAY_LEAK: (cueId: string, opaqueRatio: number, cornerAlphaMax: number) =>
    createDiagnostic(
      "CUTHOL-G505",
      "G5_SIGNAL",
      "WARN",
      `Background leak detected in transparent overlay composition '${cueId}' (fully-opaque ratio=${(opaqueRatio * 100).toFixed(1)}%, corner alpha=${cornerAlphaMax}/255).`,
      `Make sure the composition HTML/CSS has 'body, #root { background: transparent; }' and no '[data-cuthol-preview]' element remains.`,
      cueId
    ),

  COMPOSITION_AUDIO_UNAVAILABLE: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G507",
      "G5_SIGNAL",
      "WARN",
      `Composition '${cueId}' uses 'C.audio' but no audio-energy envelope could be produced in its window (${detail}); 'C.audio' returns 0 every frame.`,
      `Make sure an active audio source (spine, voiceover, effect or music) is in the composition window and the media file is readable ('cuthol library waveform --handle <aud_XX|vid_XX>').`,
      cueId
    ),

  RENDER_AUDIO_ALIGNMENT_MISMATCH: (
    issues: Array<{
      item_id: string;
      check_at_ms: number;
      measured_offset_ms: number;
      similarity: number;
      detail: string;
    }>
  ) => {
    const summary = issues
      .map(
        (x) =>
          `${x.item_id}@${Math.round(x.check_at_ms)}ms (${x.detail}, offset=${x.measured_offset_ms >= 0 ? "+" : ""}${x.measured_offset_ms.toFixed(1)}ms, similarity=${x.similarity.toFixed(2)})`
      )
      .join("; ");
    const firstId = issues[0]?.item_id;
    return createDiagnostic(
      "CUTHOL-G508",
      "G5_SIGNAL",
      "WARN",
      `Post-render audio health check found audio drift or signal loss at ${issues.length} point(s): ${summary}.`,
      `Check the segment-boundary transition, start time and audio chain of the affected audio item ('${firstId ?? "cue/clip"}') and re-render.`,
      firstId
    );
  },

  REVISION_MISMATCH: (expectedRev: number, actualRev: number) =>
    createDiagnostic(
      "CUTHOL-G109",
      "G1_SCHEMA",
      "ERROR",
      `Expected revision (r${expectedRev}) does not match the active sequence revision (r${actualRev}).`,
      `Check the current revision with 'cuthol brief --lens overview' or 'cuthol workspace journal list' and use '--expect-rev ${actualRev}'.`
    ),

  UNKNOWN_FLAG: (flag: string, command: string, suggestionFix: string) =>
    createDiagnostic(
      "CUTHOL-G110",
      "G1_SCHEMA",
      "ERROR",
      `Unknown or conflicting flag '${flag}' in command '${command}'.`,
      `Use this command: ${suggestionFix}`
    ),

  PROTECTED_TARGET: (targetIds: string[], operation: string) =>
    createDiagnostic(
      "CUTHOL-G111",
      "G1_SCHEMA",
      "ERROR",
      `Operation '${operation}' would delete or modify locked/protected items ('${targetIds.join(", ")}').`,
      `Inspect the plan first with '--dry-run'; if you really want to delete/modify them, add '--allow-protected ${targetIds.join(",")}'.`
    ),

  INVALID_EXTENSION_MANIFEST: (extNameOrPath: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G112",
      "G1_SCHEMA",
      "ERROR",
      `Manifest file ('cuthol-extension.json') of extension '${extNameOrPath}' is invalid: ${detail}`,
      `Check the manifest schema ('name', 'version', 'description' and optional 'network', 'helper', 'assets', 'processors', 'recipes', 'guide'); run 'cuthol guide --topic extensions' for the guide.`,
      extNameOrPath
    ),

  EXTENSION_ALREADY_EXISTS: (name: string, dirPath: string) =>
    createDiagnostic(
      "CUTHOL-G113",
      "G1_SCHEMA",
      "ERROR",
      `Extension '${name}' already exists at '${dirPath}'.`,
      `Pick a different name, edit the existing extension, or delete it first with 'cuthol extension remove --name ${name}'.`,
      name
    ),

  EXTENSION_NOT_FOUND: (name: string, searchedPaths: string[]) =>
    createDiagnostic(
      "CUTHOL-G204",
      "G2_ASSETS",
      "ERROR",
      `Extension '${name}' found in neither the project extensions folder nor the persistent extensions folder (searched: ${searchedPaths.join(", ") || "none"}).`,
      `List existing extensions with 'cuthol extension list', or create it with 'cuthol extension create --name ${name}'.`,
      name
    ),

  EXTENSION_HASH_MISMATCH: (
    name: string,
    expectedVersion: string,
    expectedHash: string,
    actualVersion: string,
    actualHash: string,
    severity: DiagnosticSeverity = "WARN",
    detail?: string
  ) =>
    createDiagnostic(
      "CUTHOL-G205",
      "G2_ASSETS",
      severity,
      detail
        ? `Extension '${name}' enabled in the project, or its copy in the composition, differs from its source (${detail}; pinned in sequence: v${expectedVersion} ${expectedHash}, current on disk: v${actualVersion} ${actualHash}); the render is stopped so it does not go out with the stale copy.`
        : `Extension '${name}' enabled in the project changed on disk (pinned in sequence: v${expectedVersion} ${expectedHash}, current on disk: v${actualVersion} ${actualHash}); the render is stopped so it does not go out with the stale copy.`,
      `Run 'cuthol extension enable --name ${name}' to accept the change, move to the new content hash and sync the compositions.`,
      name
    ),

  EXTENSION_SECURITY_VIOLATION: (name: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G206",
      "G2_ASSETS",
      "ERROR",
      `Extension '${name}' violated the security boundary: ${detail}`,
      `An extension may only read files inside its own folder, and only write to the output path given by Cuthol or to CUTHOL_EXT_TMP.`,
      name
    ),

  EXTENSION_EXECUTION_FAILED: (name: string, target: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-SYS08",
      "SYS",
      "ERROR",
      `Run of '${target}' by extension '${name}' failed: ${detail}`,
      `Check the extension script/filter and the input parameters ('cuthol extension show --name ${name}').`,
      name
    ),

  COMMAND_LINE_TOO_LONG: (
    tool: string,
    commandLength: number,
    limitChars: number,
    clipCount?: number,
    errnoCode?: string
  ) => {
    const clipInfo =
      typeof clipCount === "number" ? `, clip count: ${clipCount}` : "";
    const codeInfo = errnoCode ? ` (${errnoCode})` : "";
    return createDiagnostic(
      "CUTHOL-SYS09",
      "SYS",
      "ERROR",
      `Could not start the '${tool}' subprocess${codeInfo}: command line too long (${commandLength} chars, OS limit: ${limitChars} chars${clipInfo}).`,
      `Pass the filter graph from a file ('-/filter_complex <file>'), or process the multi-clip sequence via time-segmented compilation.`
    );
  },

  SUBPROCESS_STALLED: (options: {
    step: string;
    stalledMs: number;
    thresholdMs: number;
    lastProgress: string;
    commandSummary: string;
  }) => {
    const stalledSec = (Math.max(0, options.stalledMs) / 1000).toFixed(1);
    const threshSec = (Math.max(0, options.thresholdMs) / 1000).toFixed(1);
    const lastProg = options.lastProgress?.trim() || "no progress/output produced";
    const cmdSum = options.commandSummary?.trim() || options.step;
    return createDiagnostic(
      "CUTHOL-SYS10",
      "SYS",
      "ERROR",
      `Subprocess '${options.step}' was terminated because progress stalled (no progress for ${stalledSec}s, threshold=${threshSec}s; last progress: ${lastProg}; command: ${cmdSum}).`,
      `The hardware encoder (NVENC/AMF/QSV/VAAPI/VideoToolbox) or a browser subprocess may be stuck; retry the operation, use 'CUTHOL_ENCODER=x264' to disable GPU encoding, or set the progress threshold with 'CUTHOL_STALL_TIMEOUT_SEC'.`
    );
  },

  INVALID_EXCISE_RANGE: (piece: string) =>
    createDiagnostic(
      "CUTHOL-G311",
      "G3_TIMING",
      "ERROR",
      `'${piece}' is not a cut range; every piece must be in 'start..end' form.`,
      `Write the broken piece as '2s..3s'. Separate multiple ranges with commas: '--ranges 2s..3s,6s..7s'.`
    ),

  UNITLESS_TIME_AS_MS: () =>
    createDiagnostic(
      "CUTHOL-G114",
      "G1_SCHEMA",
      "WARN",
      "Unitless values were read as milliseconds; did you mean seconds? (e.g. 21.1s)",
      "Add units to time values (e.g. '21.1s' or '00:21.1'). Unitless numbers stay milliseconds."
    ),

  QUERY_PAGE_TOKEN_TRUNCATED: (returned: number, nextCursor: string) =>
    createDiagnostic(
      "CUTHOL-G115",
      "G1_SCHEMA",
      "WARN",
      `Page cut at the token budget, returned ${returned} items; use next_cursor=${nextCursor} to continue`,
      `Use '--cursor ${nextCursor}' to continue where you left off, or raise the '--max-tokens' budget.`
    ),

  INVALID_CUE_EXCISE_KIND: (cueId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G310",
      "G3_TIMING",
      "ERROR",
      `Item '${cueId}' ('${kind}') has no linear source media stream, so no range can be excised from it with 'lane excise'.`,
      `'lane excise' only works on audio ('voiceover', 'music', 'sfx') and video ('broll') media cues. To change the duration of compositions, titles, captions or stills use 'cuthol lane update-cue --cue ${cueId} --duration <duration>', or 'cuthol lane remove-cue --cues ${cueId}' to delete.`,
      cueId
    ),

  CLEANUP_CUE_NOT_AUDIO: (cueId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G313",
      "G3_TIMING",
      "ERROR",
      `'${cueId}' ('${kind}') is not an audio cue; speech cleanup only runs on 'voiceover', 'music' and 'sfx' cues carrying an audio file.`,
      `Place the recording with 'cuthol lane add-cue --lane ln_vo --kind voiceover --asset <aud_XX>'. To clean footage on the spine use 'cuthol speech cleanup --clip <sp_XX>'. Compositions, titles, captions, b-roll and stills are not cut by this command.`,
      cueId
    ),

  CLEANUP_TARGET_CONFLICT: () =>
    createDiagnostic(
      "CUTHOL-G314",
      "G3_TIMING",
      "ERROR",
      "Speech cleanup cannot take both a spine clip and an audio cue in the same call.",
      `Use 'cuthol speech cleanup --cue <cue_XX>' (or '--cues a,b') for an audio cue, 'cuthol speech cleanup --clip <sp_XX>' for the spine.`
    ),

  CLEANUP_BAD_ACROSS: (value: string) =>
    createDiagnostic(
      "CUTHOL-G315",
      "G3_TIMING",
      "ERROR",
      `'${value}' is not a valid shift scope.`,
      `In audio-cue cleanup '--across' must be 'lane' (default), 'all_lanes', 'all', 'spine' or 'none'. This means the same as 'lane excise --across'.`
    ),


  // --- Speed ramp: codes CUTHOL-G116, CUTHOL-G117, CUTHOL-G410 ---
  INVALID_SPEED_RAMP: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G116",
      "G1_SCHEMA",
      "ERROR",
      `'--ramp' is invalid: ${detail}`,
      `Correct form: '--ramp "0s:1,1s:1,2.5s:4"' (source offset:rate pairs; offsets strictly increasing, rate 0.1..16, offsets within the clip's 0..source range, at least 2 points). '--ramp none' removes it. Example: 'cuthol spine speed --clip sp_01 --ramp "0s:1,2s:4"'. Cannot be combined with '--rate'.`
    ),

  SPEED_RAMP_AUDIO_APPROX: (clipId: string, minRate: number, maxRate: number) =>
    createDiagnostic(
      "CUTHOL-G410",
      "G4_STAGE",
      "WARN",
      `Speed ramp on '${clipId}' has rates outside 0.5..2.0 (${minRate.toFixed(2)}..${maxRate.toFixed(2)}); audio follows the ramp but quality drops at extreme rates (chained atempo or large pitch shift).`,
      `Listen to the audio in the draft render; on clips with speech keep the ramp ends within 0.5..2.0: 'cuthol spine speed --clip ${clipId} --ramp "0s:1,..."'.`,
      clipId
    ),

  SPEED_RAMP_BEYOND_SOURCE: (clipId: string, offsetMs: number, spanMs: number) =>
    createDiagnostic(
      "CUTHOL-G117",
      "G4_STAGE",
      "WARN",
      `Offset ${offsetMs}ms in the speed ramp of '${clipId}' exceeds the source range (0..${spanMs}ms); clamped to ${spanMs}ms.`,
      `Bring the ramp offsets into 0..${spanMs}ms: 'cuthol spine speed --clip ${clipId} --ramp "0s:1,..."'.`,
      clipId
    ),

  // ---------------------------------------------------------------------------------------------------

  // --- Spine fx: codes CUTHOL-G118, CUTHOL-G119, CUTHOL-G411 ---
  SPINE_FX_INVALID: (clipId: string, fxId: string, kind: string, detail: string, suggestion?: string) =>
    createDiagnostic(
      "CUTHOL-G118",
      "G1_SCHEMA",
      "ERROR",
      `Effect '${fxId}' ('${kind}') on clip '${clipId}' is invalid: ${detail}`,
      suggestion ??
        `Remove it with 'cuthol spine fx remove --clip ${clipId} --fx ${fxId}', or fix it with 'cuthol spine fx set --clip ${clipId} --fx ${fxId} --param name=value'.`,
      clipId
    ),

  SPINE_FX_ENVELOPE_UNSUPPORTED: (clipId: string, parameter: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G119",
      "G1_SCHEMA",
      "ERROR",
      `Envelope '${parameter}' on clip '${clipId}' cannot be applied: ${reason}`,
      `Remove the envelope or move it to an envelopable parameter ('cuthol spine envelope --clip ${clipId} --param <name> --points <...>'); the extension declares which parameters are envelopable ('animatable').`,
      clipId
    ),

  SPINE_FX_EXTENSION_DRIFTED: (
    clipId: string,
    fxId: string,
    ref: string,
    extName: string,
    pinnedLabel: string,
    actualLabel: string
  ) =>
    createDiagnostic(
      "CUTHOL-G411",
      "G4_STAGE",
      "WARN",
      `Effect '${fxId}' (${ref}) on clip '${clipId}' is compiling against a different extension than pinned (in sequence: ${pinnedLabel}, on disk: ${actualLabel}).`,
      `Run 'cuthol extension enable --name ${extName}' to accept the change and move to the new version.`,
      clipId
    ),

  // ---------------------------------------------------------------------------------------------------

  // --- Easing: codes CUTHOL-G120 ---
  EASING_NAME_INVALID: (subject: string, name: string) =>
    createDiagnostic(
      "CUTHOL-G120",
      "G1_SCHEMA",
      "ERROR",
      `Easing name '${name}' for '${subject}' is invalid.`,
      `Valid easing names: 'linear', 'ease_in', 'ease_out', 'ease_in_out', 'hold', 'cubic_bezier'. For a curve use '--easing "cubic-bezier(x1,y1,x2,y2)"' (x1 and x2 within 0..1; e.g. 'cubic-bezier(0.25,0.1,0.25,1)').`,
      subject
    ),

  EASING_HOLD_IN_TRANSITION: (subject: string) =>
    createDiagnostic(
      "CUTHOL-G120",
      "G1_SCHEMA",
      "ERROR",
      `'hold' easing cannot be used in the out-transition of clip '${subject}': the step curve ends the transition unseen (progress stalls at 0, then jumps to 1 at the end).`,
      `Use 'linear', 'ease_in', 'ease_out', 'ease_in_out' or 'cubic_bezier' for the transition (e.g. 'cuthol spine transition --clip ${subject} --easing ease_in_out').`,
      subject
    ),

  CUBIC_BEZIER_INVALID: (subject: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G120",
      "G1_SCHEMA",
      "ERROR",
      `cubic-bezier curve for '${subject}' is invalid: ${detail}.`,
      `Pass the curve as '--easing "cubic-bezier(x1,y1,x2,y2)"'; x1 and x2 must be within 0..1 (e.g. 'cubic-bezier(0.25,0.1,0.25,1)').`,
      subject
    ),

  // ---------------------------------------------------------------------------------------------------

  // --- Edge mode: codes CUTHOL-G121, CUTHOL-G412 ---
  EDGE_LANE_CUE_UNSUPPORTED: (cueId: string, edge: string) =>
    createDiagnostic(
      "CUTHOL-G121",
      "G1_SCHEMA",
      "ERROR",
      `'edge=${edge}' on lane cue '${cueId}' is not supported in this version; mirrored/extended edge fill only works on spine clips, so this setting is ignored.`,
      `Remove the 'edge' field from the lane cue; apply the fill to the spine clip underneath with 'cuthol spine transform --clip <sp_XX> --edge ${edge}'.`,
      cueId
    ),

  EDGE_INEFFECTIVE: (clipId: string) =>
    createDiagnostic(
      "CUTHOL-G412",
      "G4_STAGE",
      "WARN",
      `Clip '${clipId}' already covers the stage fully and does not move; the given edge mode changes nothing in the picture.`,
      `Remove the ineffective setting with 'cuthol spine transform --clip ${clipId} --edge transparent', or shrink/shift the clip to make the fill visible.`,
      clipId
    ),

  // ---------------------------------------------------------------------------------------------------

  // --- Extension transitions: codes CUTHOL-G122, CUTHOL-G123, CUTHOL-G413 ---
  EXTENSION_TRANSITION_UNAVAILABLE: (kind: string, detail: string, subjectId?: string) =>
    createDiagnostic(
      "CUTHOL-G122",
      "G1_SCHEMA",
      "ERROR",
      `Extension transition '${kind}' is unavailable: ${detail}`,
      `Verify the extension is installed with 'cuthol extension list' and the transition is defined in the 'transitions' section with 'cuthol extension show --name <name>'; if the extension is not enabled in the project, run 'cuthol extension enable --name <name>'.`,
      subjectId
    ),

  EXTENSION_TRANSITION_EASING_UNSUPPORTED: (kind: string, easing: string, subjectId?: string) =>
    createDiagnostic(
      "CUTHOL-G122",
      "G1_SCHEMA",
      "ERROR",
      `Easing '${easing}' is not supported in extension transition '${kind}' in this version.`,
      `Use 'linear', 'ease_in', 'ease_out' or 'ease_in_out' for the transition (e.g. 'cuthol spine transition --clip <sp_XX> --kind ${kind} --easing ease_in_out').`,
      subjectId
    ),

  EXTENSION_TRANSITION_PARAM_INVALID: (kind: string, clipId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G123",
      "G1_SCHEMA",
      "ERROR",
      `Parameters of transition '${kind}' on clip '${clipId}' are invalid: ${detail}`,
      `Fix the parameters per the 'transitions' definition in the extension manifest ('cuthol extension show --name <name>'); e.g. 'cuthol spine transition --clip ${clipId} --kind ${kind} --param name=value'.`,
      clipId
    ),

  EXTENSION_TRANSITION_PIN_MISMATCH: (
    name: string,
    expectedVersion: string,
    expectedHash: string,
    actualVersion: string,
    actualHash: string,
    subjectId?: string
  ) =>
    createDiagnostic(
      "CUTHOL-G413",
      "G4_STAGE",
      "WARN",
      `Extension '${name}' whose transition you use changed on disk (pinned in sequence: v${expectedVersion} ${expectedHash}, current on disk: v${actualVersion} ${actualHash}); the render goes out with the current extension.`,
      `Run 'cuthol extension enable --name ${name}' to accept the change and move to the new content hash.`,
      subjectId
    ),

  // ---------------------------------------------------------------------------------------------------

  // --- Colour (LUT, temperature, colour envelopes): codes CUTHOL-G124, CUTHOL-G414 ---
  INVALID_COLOR_TEMPERATURE: (clipId: string, kelvin: number) =>
    createDiagnostic(
      "CUTHOL-G124",
      "G1_SCHEMA",
      "ERROR",
      `Color temperature of clip '${clipId}' (${String(kelvin)} K) is outside the supported range (1000..40000 K).`,
      `Return to the neutral value (6500 K, no filter) with 'cuthol spine grade --clip ${clipId} --temperature 6500'.`,
      clipId
    ),

  LUT_FILE_NOT_READABLE: (clipId: string, lutUri: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G414",
      "G4_STAGE",
      "ERROR",
      `LUT file ('${lutUri}') of clip '${clipId}' is unusable: ${detail}.`,
      `Place the LUT file under the project folder as '.cube' or '.3dl' and re-attach it with 'cuthol spine grade --clip ${clipId} --lut <path>'; use '--lut none' to remove it.`,
      clipId
    ),

  // ---------------------------------------------------------------------------------------------------
  // --- Composition renderer (script errors, composition audio): codes CUTHOL-G415, CUTHOL-G416 ---
  SCRIPT_ERROR_ISOLATED: (
    subject: string,
    elementId: string,
    compositionId: string | null,
    error: string
  ) =>
    createDiagnostic(
      "CUTHOL-G415",
      "G4_STAGE",
      "WARN",
      `Silent gap in overlay '${subject}': the script of element '${elementId}'${compositionId && compositionId !== elementId ? ` ('${compositionId}' sub-composition)` : ""} threw (${error}); HyperFrames skipped this element with an empty timeline, its part is missing from the picture.`,
      `Fix the error in the '${compositionId ?? elementId}' script, then re-render the overlay with 'cuthol render' (a file change triggers the re-render).`,
      subject
    ),

  COMPOSITION_AUDIO_SILENT: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G416",
      "G4_STAGE",
      "WARN",
      `Audio playing in composition cue '${cueId}' (${detail}) is not in the Cuthol mix yet: no audio stem has been extracted for the current composition files.`,
      `Run 'cuthol render' (or a mix measurement such as 'cuthol mix normalize') once; it extracts the stem and mixes it at the cue's lane time. To keep the composition silent, run 'cuthol lane update-cue --cue ${cueId} --composition-audio off'; to manage the sound as a separate cue instead, place it on the 'ln_sfx' or 'ln_bgm' lane ('cuthol lane add-cue --lane ln_sfx --kind sfx --asset <handle> ...').`,
      cueId
    ),

  // --- Composition audio stems: CUTHOL-G416 (in-mix/off info), CUTHOL-G435, CUTHOL-G436, CUTHOL-G437 ---
  COMPOSITION_AUDIO_IN_MIX: (cueId: string, stemMs: number, offHint: string) =>
    createDiagnostic(
      "CUTHOL-G416",
      "G4_STAGE",
      "INFO",
      `Composition cue '${cueId}' brings ${stemMs}ms of engine-rendered audio into the Cuthol mix as a per-cue stem (lane gain, mute, envelopes and ducking apply).`,
      offHint,
      cueId
    ),

  COMPOSITION_AUDIO_OFF: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G416",
      "G4_STAGE",
      "INFO",
      `Audio in composition cue '${cueId}' (${detail}) stays out of the Cuthol mix because 'composition_audio' is 'off' on this cue.`,
      `To mix it, run 'cuthol lane update-cue --cue ${cueId} --composition-audio mix'.`,
      cueId
    ),

  COMPOSITION_STEM_FAILED: (cueId: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G435",
      "G4_STAGE",
      "WARN",
      `Composition cue '${cueId}' has audio, but its stem could not be extracted (${reason}); the cue renders silent until the extraction succeeds.`,
      `Fix the cause (usually a missing or unreadable audio file inside the composition), then re-render so the stem is retried.`,
      cueId
    ),

  COMPOSITION_RENDER_SILENT: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G436",
      "G4_STAGE",
      "INFO",
      `Composition cue '${cueId}' shows audio elements (${detail}), but the engine render produced no audible sound, so no stem enters the mix.`,
      `If the silence is unintended, check the audio file paths and timing inside the composition; otherwise no action is needed.`,
      cueId
    ),

  INVALID_COMPOSITION_AUDIO: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G437",
      "G1_SCHEMA",
      "ERROR",
      `Cue '${cueId}' has an invalid 'composition_audio' setting: ${detail}`,
      `Set 'composition_audio' to 'mix' or 'off' ('cuthol lane update-cue --cue ${cueId} --composition-audio mix|off'), only on composition cues.`,
      cueId
    ),

  // --- Composition coordinates: codes CUTHOL-G417, CUTHOL-G418, CUTHOL-G419, CUTHOL-G428, CUTHOL-G429 ---
  COORDS_MEASUREMENT_FAILED: (cueId: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G417",
      "G4_STAGE",
      "WARN",
      `Coordinate measurement failed for cue '${cueId}' (${reason}); the cue was skipped and the remaining cues continue.`,
      `Re-run the failed cue alone: 'cuthol composition coords --cue ${cueId} --refresh'. If it still fails, open the composition with 'cuthol composition preview --cue ${cueId}' to see the page error.`,
      cueId
    ),

  COORDS_FONTS_NOT_BUNDLED: (cueId: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G418",
      "G4_STAGE",
      "WARN",
      `Font bundling was unavailable for cue '${cueId}' (${reason}); measured with raw HTML, so text boxes may differ from render.`,
      `Re-run the cue after checking the renderer version ('npx hyperframes --version'): 'cuthol composition coords --cue ${cueId} --refresh'.`,
      cueId
    ),

  COORDS_PAGE_ISSUES: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G419",
      "G4_STAGE",
      "INFO",
      `Page issues while measuring cue '${cueId}': ${detail}.`,
      `Inspect the same page with 'cuthol composition preview --cue ${cueId}', fix the reported script error, then re-run 'cuthol composition coords --cue ${cueId} --refresh'.`,
      cueId
    ),

  COORDS_UNKNOWN_ELEMENT: (ref: string, cueId: string, nearest: string | null) =>
    createDiagnostic(
      "CUTHOL-G428",
      "G4_STAGE",
      "ERROR",
      `Unknown element '${ref}' in cue '${cueId}'.`,
      nearest
        ? `Did you mean '${nearest}'? List keys with 'cuthol composition coords --at <moment> --cue ${cueId}'.`
        : `List keys with 'cuthol composition coords --at <moment> --cue ${cueId}'.`,
      ref
    ),

  COORDS_QUERY_MISUSE: (detail: string, fix: string) =>
    createDiagnostic(
      "CUTHOL-G429",
      "G4_STAGE",
      "ERROR",
      `Geometry query misuse: ${detail}.`,
      `Use: ${fix}`
    ),

  // CUTHOL-G420..CUTHOL-G427 retired with the layout warning system; never reused (may appear in old projects/logs).

  // --- Media and speech providers (selection, extension providers, media sources): codes CUTHOL-G230 .. CUTHOL-G249 ---

  PROVIDER_UNKNOWN: (kind: string, id: string, valid: string) =>
    createDiagnostic(
      "CUTHOL-G230",
      "G1_SCHEMA",
      "ERROR",
      `Unknown ${kind} provider '${id}'.`,
      `Use one of: ${valid}.`
    ),

  PROVIDER_CAPABILITY_MISSING: (extName: string, kind: string, available: string) =>
    createDiagnostic(
      "CUTHOL-G231",
      "G2_ASSETS",
      "ERROR",
      `Extension '${extName}' does not provide a '${kind}' provider (it provides: ${available || "nothing"}).`,
      `Check the extension manifest 'providers' section with 'cuthol extension show --name ${extName}'.`
    ),

  PROVIDER_ENV_MISSING: (extName: string, kind: string, missingVars: string[]) =>
    createDiagnostic(
      "CUTHOL-G232",
      "SYS",
      "ERROR",
      `Extension provider '${extName}' (${kind}) needs ${missingVars.length === 1 ? "environment variable" : "environment variables"} ${missingVars.map((v) => `'${v}'`).join(", ")}, which ${missingVars.length === 1 ? "is" : "are"} not set.`,
      `Set ${missingVars.length === 1 ? "it" : "them"} in your shell environment or in the project '.env' file ('${missingVars[0]}=...'), then retry. Values are read from the environment only and are never written to the sequence, journal, cache, or logs.`
    ),

  PROVIDER_BAD_OUTPUT: (extName: string, kind: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G233",
      "SYS",
      "ERROR",
      `Extension provider '${extName}' (${kind}) returned invalid output: ${detail}`,
      `Fix the provider script to return the documented JSON contract (see 'extensions' guide, providers section).`
    ),

  PROVIDER_EXECUTION_FAILED: (extName: string, kind: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G234",
      "SYS",
      "ERROR",
      `Extension provider '${extName}' (${kind}) failed: ${detail}`,
      `Check the provider script and its configuration with 'cuthol extension show --name ${extName}'.`
    ),

  PROVIDER_TTS_NO_ALIGNMENT: (extName: string) =>
    createDiagnostic(
      "CUTHOL-G235",
      "SYS",
      "WARN",
      `Extension TTS provider '${extName}' returned audio without word or character alignment, so no word timings are available.`,
      `Captions, cleanup, and word-locked animation cannot use this voiceover. Use a provider with alignment, or transcribe the voiceover with 'cuthol speech transcribe'.`
    ),

  MEDIA_FETCH_NOT_FOUND: (extName: string, id: string) =>
    createDiagnostic(
      "CUTHOL-G236",
      "G2_ASSETS",
      "ERROR",
      `Media provider '${extName}' has no candidate with id '${id}'.`,
      `List candidates with 'cuthol library search --provider ext:${extName} --kind music|sfx --query "<text>"'.`
    ),

  // --- end of provider block ---

  // --- Composition script errors: CUTHOL-G430 .. CUTHOL-G434 ---
  // (G434 is reserved for future composition page diagnostics.)

  COMPOSITION_SCRIPT_FAILED_BEFORE_TIMELINE: (cueId: string, error: string, where: string | null) =>
    createDiagnostic(
      "CUTHOL-G430",
      "G4_STAGE",
      "ERROR",
      `Composition '${cueId}' page script threw before its timeline registered ('${error}'${where ? ` at ${where}` : ""}); the overlay cannot render (render stops with CUTHOL-G503) and monitor frames show the static unanimated page.`,
      `Fix the script${where ? ` (${where})` : ""}, then re-check with 'cuthol composition preview --cue ${cueId}' (preview re-runs the page); 'cuthol verify' stays red while the recorded error matches the current composition files.`,
      cueId
    ),

  COMPOSITION_SCRIPT_FAILED_AFTER_TIMELINE: (cueId: string, error: string, where: string | null) =>
    createDiagnostic(
      "CUTHOL-G431",
      "G4_STAGE",
      "WARN",
      `Composition '${cueId}' page script threw while its timeline was running ('${error}'${where ? ` at ${where}` : ""}); the render output is unaffected, but the throwing code path never completes.`,
      `Fix the callback${where ? ` (${where})` : ""}, then re-check with 'cuthol composition preview --cue ${cueId}'.`,
      cueId
    ),

  COMPOSITION_CONSOLE_ERROR: (cueId: string, error: string, where: string | null) =>
    createDiagnostic(
      "CUTHOL-G432",
      "G4_STAGE",
      "WARN",
      `Composition '${cueId}' page logged a console error ('${error}'${where ? ` at ${where}` : ""}); the render output is unaffected, but the message signals a real page problem (for example a failed shader compile or a missing asset).`,
      `Inspect the cause${where ? ` (${where})` : ""}, then re-check with 'cuthol composition preview --cue ${cueId}'.`,
      cueId
    ),

  COMPOSITION_CONSOLE_WARNING_ONLY: (cueId: string, warning: string, where: string | null) =>
    createDiagnostic(
      "CUTHOL-G433",
      "G4_STAGE",
      "INFO",
      `Composition '${cueId}' page logged only shader/compiler warnings ('${warning}'${where ? ` at ${where}` : ""}); nothing threw and the render output is unaffected.`,
      `No action needed; re-check with 'cuthol composition preview --cue ${cueId}' if the message changes.`,
      cueId
    ),

  // ---------------------------------------------------------------------------------------------------
} as const;

export function estimateCommandLineLength(executable: string, args: readonly string[]): number {
  let len = executable.length;
  for (const arg of args) {
    len += 1 + arg.length;
    if (arg.length === 0 || /[\s"]/u.test(arg)) {
      len += 2;
    }
  }
  return len;
}

export function getPlatformCommandLineLimit(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? 32_767 : 131_072;
}

export function summarizeCommandForDiagnostic(
  executable: string,
  args: readonly string[],
  maxChars = 160
): string {
  const exeBase = executable.replace(/\\/g, "/").split("/").pop() || executable;
  const compactArgs = args.map((a) => {
    if (a.length > 48) {
      const normalized = a.replace(/\\/g, "/");
      if (normalized.includes("/")) {
        const parts = normalized.split("/");
        const tail2 = parts.slice(-2).join("/");
        if (tail2.length <= 56) return `.../${tail2}`;
        const base = parts[parts.length - 1] || "";
        if (base.length <= 48) return `.../${base}`;
      }
      return `${a.slice(0, 20)}...${a.slice(-24)}`;
    }
    return a;
  });
  const full = [exeBase, ...compactArgs].join(" ");
  if (full.length <= maxChars) return full;
  const headLen = Math.max(40, Math.floor(maxChars * 0.55));
  const tailLen = Math.max(30, maxChars - headLen - 5);
  return `${full.slice(0, headLen)} ... ${full.slice(-tailLen)}`;
}

export function createSubprocessFailureDiagnostic(options: {
  tool: string;
  executable?: string;
  args?: readonly string[];
  proc: {
    status: number | null;
    signal?: NodeJS.Signals | null;
    error?: Error;
    stderr?: string | Buffer | null;
    stdout?: string | Buffer | null;
    stalled?: boolean;
    stalledMs?: number;
    stallThresholdMs?: number;
    lastProgress?: string;
    commandSummary?: string;
  };
  clipCount?: number;
  fallbackDetail?: string;
}): CutholDiagnostic {
  const executable = options.executable ?? options.tool.split(/\s+/)[0] ?? "ffmpeg";
  const args = options.args ?? [];

  if (options.proc.stalled) {
    return DIAGNOSTICS.SUBPROCESS_STALLED({
      step: options.tool,
      stalledMs: options.proc.stalledMs ?? options.proc.stallThresholdMs ?? 0,
      thresholdMs: options.proc.stallThresholdMs ?? options.proc.stalledMs ?? 0,
      lastProgress: options.proc.lastProgress ?? "no progress/output produced",
      commandSummary:
        options.proc.commandSummary ?? summarizeCommandForDiagnostic(executable, args),
    });
  }

  const commandLength = estimateCommandLineLength(executable, args);
  const limitChars = getPlatformCommandLineLimit();
  const singleArgMax = args.reduce((max, a) => (a.length > max ? a.length : max), 0);
  const err = options.proc.error as NodeJS.ErrnoException | undefined;
  const errCode = err?.code ?? "";

  if (
    errCode === "ENAMETOOLONG" ||
    errCode === "E2BIG" ||
    (err && (commandLength >= limitChars || singleArgMax >= limitChars))
  ) {
    return DIAGNOSTICS.COMMAND_LINE_TOO_LONG(
      options.tool,
      Math.max(commandLength, singleArgMax),
      limitChars,
      options.clipCount,
      errCode || undefined
    );
  }

  const stderrStr =
    typeof options.proc.stderr === "string"
      ? options.proc.stderr
      : Buffer.isBuffer(options.proc.stderr)
        ? options.proc.stderr.toString("utf8")
        : "";
  const stdoutStr =
    typeof options.proc.stdout === "string"
      ? options.proc.stdout
      : Buffer.isBuffer(options.proc.stdout)
        ? options.proc.stdout.toString("utf8")
        : "";

  if (err) {
    const clipInfo =
      typeof options.clipCount === "number" ? `, clip_count=${options.clipCount}` : "";
    const detail = `Subprocess failed to start (${errCode || err.name}: ${err.message}; command=${ executable }, command_length=${commandLength}/${limitChars} chars${clipInfo})${stderrStr.trim() ? ` — ${stderrStr.trim().slice(-360)}` : ""}`;
    return DIAGNOSTICS.EXTERNAL_TOOL_FAILED(options.tool, detail);
  }

  const outTail = (stderrStr || stdoutStr || "").trim().slice(-600);
  const statusInfo =
    options.proc.status !== null && options.proc.status !== undefined
      ? `exit_code=${options.proc.status}`
      : options.proc.signal
        ? `signal=${options.proc.signal}`
        : "status=null";
  const detail = outTail
    ? `${outTail} (${statusInfo})`
    : `${options.fallbackDetail ?? "subprocess failed"} (${statusInfo}, command_length=${commandLength} chars)`;
  return DIAGNOSTICS.EXTERNAL_TOOL_FAILED(options.tool, detail);
}
