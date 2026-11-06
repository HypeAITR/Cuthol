// CLI 'speech' command group handler (split out of cli.ts).
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import { parseTimeMs } from "./core/time.js";
import { formatCaptionsDigest, formatTranscribeDigest } from "./library/query.js";
import { CaptionStylePreset, generateSequenceCaptions } from "./speech/captions.js";
import { cleanupClipDialogue, cleanupLaneCueDialogue } from "./speech/cleanup.js";
import { describeProviderResolution, setProjectProviderDefaults } from "./speech/provider_select.js";
import { synthesizeVoiceover } from "./speech/synthesize.js";
import { transcribeLibraryAsset } from "./speech/transcribe.js";
import { verifyCleanup } from "./speech/verify_cleanup.js";
import { boolFlag, numFlag, strFlag } from "./cli_args.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";

export async function runSpeechCommand(ctx: CliCommandContext): Promise<CliCommandResult> {
  const { action, rest, flags, workspaceDir } = ctx;
  if (action === "transcribe") {
    const handle = strFlag(flags, "handle") ?? rest[0];
    if (!handle) throw new Error("Provide --handle <vid_XX|aud_XX>.");
    const res = await transcribeLibraryAsset({
      workspaceDir,
      handle,
      language: strFlag(flags, "lang", "tr"),
      provider: strFlag(flags, "provider"),
    });
    const payload = flags["verbose"]
      ? { action: "speech.transcribe", ...res }
      : { action: "speech.transcribe", ...formatTranscribeDigest(res) };
    emitEnvelopeJson(workspaceDir, "speech.transcribe", payload);
    return;
  }

  if (action === "synthesize") {
    const text = strFlag(flags, "text") ?? rest[0];
    if (!text) throw new Error("Provide --text \"...\" to synthesize.");
    const atRaw = strFlag(flags, "at");
    const offRaw = strFlag(flags, "offset");
    const res = await synthesizeVoiceover({
      workspaceDir,
      text,
      voiceId: strFlag(flags, "voice"),
      modelId: strFlag(flags, "model"),
      speed: numFlag(flags, "speed"),
      provider: strFlag(flags, "provider"),
      language: strFlag(flags, "lang", "tr"),
      placeOnLane: strFlag(flags, "place-on-lane"),
      atMs: atRaw ? parseTimeMs(atRaw) : undefined,
      anchorClipId: strFlag(flags, "anchor"),
      anchorOffsetMs: offRaw ? parseTimeMs(offRaw) : undefined,
    });
    emitEnvelopeJson(workspaceDir, "speech.synthesize", {
      action: "speech.synthesize",
      ...res,
    });
    return;
  }

  if (action === "cleanup") {
    const clipId = strFlag(flags, "clip") ?? rest[0];
    const clipsRaw = strFlag(flags, "clips");
    const clipIds = clipsRaw
      ? clipsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const allSpine = boolFlag(
      flags,
      "all-spine",
      !clipId && (!clipIds || clipIds.length === 0)
    );
    const cueRaw = strFlag(flags, "cue");
    const cuesRaw = strFlag(flags, "cues");
    const requestedCueIds = [
      ...new Set(
        [...(cuesRaw ? cuesRaw.split(",") : []), ...(cueRaw ? cueRaw.split(",") : [])]
          .map((part) => part.trim())
          .filter(Boolean)
      ),
    ];
    const explicitAllSpine = boolFlag(flags, "all-spine") === true;
    const hasClipTarget =
      Boolean(clipId) || Boolean(clipIds && clipIds.length > 0) || explicitAllSpine;
    if (requestedCueIds.length > 0 && hasClipTarget) {
      throw new CutholError(DIAGNOSTICS.CLEANUP_TARGET_CONFLICT());
    }
    const minPauseRaw = strFlag(flags, "min-pause");
    const padRaw = strFlag(flags, "pad");
    const cutCandRaw = strFlag(flags, "cut-candidates");
    const cutCandidates = cutCandRaw
      ? cutCandRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const shared = {
      workspaceDir,
      minPauseMs: minPauseRaw ? parseTimeMs(minPauseRaw) : undefined,
      padMs: padRaw ? parseTimeMs(padRaw) : undefined,
      removePauses: boolFlag(flags, "remove-pauses", true),
      removeFillers: boolFlag(flags, "remove-fillers", true),
      removeRepetitions: boolFlag(flags, "remove-repetitions", false),
      cutCandidates,
      language: strFlag(flags, "lang", "tr"),
      dryRun: boolFlag(flags, "dry-run", false),
    };
    const res =
      requestedCueIds.length > 0
        ? cleanupLaneCueDialogue({
            ...shared,
            cueIds: requestedCueIds,
            across: strFlag(flags, "across"),
          })
        : cleanupClipDialogue({
            ...shared,
            clipId,
            clipIds,
            allSpine,
          });
    emitEnvelopeJson(workspaceDir, "speech.cleanup", {
      action: "speech.cleanup",
      ...res,
    });
    return;
  }

  if (action === "verify-cleanup") {
    const clipId = strFlag(flags, "clip") ?? rest[0];
    const clipsRaw = strFlag(flags, "clips");
    const clipIds = clipsRaw
      ? clipsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const allSpine = boolFlag(
      flags,
      "all-spine",
      !clipId && (!clipIds || clipIds.length === 0)
    );
    const res = await verifyCleanup({
      workspaceDir,
      clipId,
      clipIds,
      allSpine,
      provider: strFlag(flags, "provider"),
      language: strFlag(flags, "lang", "tr"),
    });
    emitEnvelopeJson(workspaceDir, "speech.verify-cleanup", {
      action: "speech.verify-cleanup",
      ...res,
    });
    return;
  }

  if (action === "providers") {
    const asrRaw = strFlag(flags, "asr");
    const ttsRaw = strFlag(flags, "tts");
    if (asrRaw === undefined && ttsRaw === undefined) {
      const res = describeProviderResolution(workspaceDir);
      emitEnvelopeJson(workspaceDir, "speech.providers", {
        action: "speech.providers",
        ...res,
      });
      return;
    }
    const res = setProjectProviderDefaults(workspaceDir, {
      ...(asrRaw !== undefined ? { asr: asrRaw } : {}),
      ...(ttsRaw !== undefined ? { tts: ttsRaw } : {}),
    });
    emitEnvelopeJson(workspaceDir, "speech.providers", {
      action: "speech.providers",
      ...res,
      effective: describeProviderResolution(workspaceDir).effective,
    });
    return;
  }

  if (action === "captions") {
    const style = (strFlag(flags, "style", "active_word") as CaptionStylePreset) ?? "active_word";
    const res = generateSequenceCaptions({
      workspaceDir,
      clipId: strFlag(flags, "clip"),
      allSpineOnly: boolFlag(flags, "all-spine", false),
      style,
      maxWordsPerGroup: numFlag(flags, "max-words"),
      maxCharsPerLine: numFlag(flags, "max-chars"),
      language: strFlag(flags, "lang", "tr"),
      replaceExistingCaptions: boolFlag(flags, "replace"),
    });
    const payload = flags["verbose"]
      ? { action: "speech.captions", ...res }
      : { action: "speech.captions", ...formatCaptionsDigest(res) };
    emitEnvelopeJson(workspaceDir, "speech.captions", payload);
    return;
  }
  return CLI_NOT_HANDLED;
}
