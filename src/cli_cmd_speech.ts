// CLI 'speech' command group handler (split out of cli.ts).
import { parseTimeMs } from "./core/time.js";
import { formatCaptionsDigest, formatTranscribeDigest } from "./library/query.js";
import { CaptionStylePreset, generateSequenceCaptions } from "./speech/captions.js";
import { cleanupClipDialogue } from "./speech/cleanup.js";
import { AsrProviderId, TtsProviderId } from "./speech/providers.js";
import { synthesizeVoiceover } from "./speech/synthesize.js";
import { transcribeLibraryAsset } from "./speech/transcribe.js";
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
      provider: strFlag(flags, "provider") as AsrProviderId | undefined,
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
      provider: strFlag(flags, "provider") as TtsProviderId | undefined,
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
    const minPauseRaw = strFlag(flags, "min-pause");
    const padRaw = strFlag(flags, "pad");
    const cutCandRaw = strFlag(flags, "cut-candidates");
    const cutCandidates = cutCandRaw
      ? cutCandRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const res = cleanupClipDialogue({
      workspaceDir,
      clipId,
      clipIds,
      allSpine,
      minPauseMs: minPauseRaw ? parseTimeMs(minPauseRaw) : undefined,
      padMs: padRaw ? parseTimeMs(padRaw) : undefined,
      removePauses: boolFlag(flags, "remove-pauses", true),
      removeFillers: boolFlag(flags, "remove-fillers", true),
      removeRepetitions: boolFlag(flags, "remove-repetitions", false),
      cutCandidates,
      language: strFlag(flags, "lang", "tr"),
      dryRun: boolFlag(flags, "dry-run", false),
    });
    emitEnvelopeJson(workspaceDir, "speech.cleanup", {
      action: "speech.cleanup",
      ...res,
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
