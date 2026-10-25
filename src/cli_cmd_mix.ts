// CLI 'mix' command group handler (split out of cli.ts).
import { parseTimeMs } from "./core/time.js";
import {
  alignClipsToBeats,
  duckMusicUnderDialogue,
  normalizeSequenceAudio,
  polishVoiceAudio,
} from "./mix/audio_mix.js";
import { boolFlag, numFlag, strFlag } from "./cli_args.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";

export function runMixCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, rest, flags, workspaceDir } = ctx;
  if (action === "normalize") {
    const clipsRaw = strFlag(flags, "clips") ?? strFlag(flags, "clip");
    const clipIds = clipsRaw ? clipsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const res = normalizeSequenceAudio({
      workspaceDir,
      targetLufs: numFlag(flags, "target-lufs"),
      truePeakDbtp: numFlag(flags, "true-peak"),
      clipIds,
      detailed: boolFlag(flags, "verbose", false) || boolFlag(flags, "detailed", false),
    });
    emitEnvelopeJson(workspaceDir, "mix.normalize", { action: "mix.normalize", ...res });
    return;
  }

  if (action === "polish-voice") {
    const clipsRaw = strFlag(flags, "clips") ?? strFlag(flags, "clip") ?? rest[0];
    const clipIds = clipsRaw ? clipsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const res = polishVoiceAudio({
      workspaceDir,
      clipIds,
      nrDb: numFlag(flags, "nr-db"),
      enableClarity: boolFlag(flags, "clarity", true),
    });
    emitEnvelopeJson(workspaceDir, "mix.polish-voice", {
      action: "mix.polish-voice",
      ...res,
    });
    return;
  }

  if (action === "duck") {
    const attackRaw = strFlag(flags, "attack");
    const releaseRaw = strFlag(flags, "release");
    const res = duckMusicUnderDialogue({
      workspaceDir,
      bgmLaneId: strFlag(flags, "bgm-lane", "ln_bgm"),
      duckDb: numFlag(flags, "duck-db"),
      attackMs: attackRaw ? parseTimeMs(attackRaw) : undefined,
      releaseMs: releaseRaw ? parseTimeMs(releaseRaw) : undefined,
      language: strFlag(flags, "lang", "tr"),
    });
    emitEnvelopeJson(workspaceDir, "mix.duck", { action: "mix.duck", ...res });
    return;
  }

  if (action === "beat-align") {
    const bgmHandle = strFlag(flags, "bgm-handle") ?? rest[0];
    if (!bgmHandle) throw new Error("Provide --bgm-handle <aud_XX>.");
    const clipsRaw = strFlag(flags, "clips");
    const clipIds = clipsRaw ? clipsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const tolRaw = strFlag(flags, "tolerance") ?? strFlag(flags, "tolerance-ms");
    const modeRaw = strFlag(flags, "mode");
    const gridFlag = boolFlag(flags, "grid");
    const alignTo: "grid" | "onsets" | undefined =
      modeRaw === "onsets" || modeRaw === "onset" || gridFlag === false
        ? "onsets"
        : modeRaw === "grid" || gridFlag === true
          ? "grid"
          : undefined;
    const res = alignClipsToBeats({
      workspaceDir,
      bgmHandle,
      clipIds,
      sensitivity: numFlag(flags, "sensitivity"),
      toleranceMs: tolRaw !== undefined ? parseTimeMs(tolRaw) : undefined,
      preserveDuration: boolFlag(flags, "preserve-duration", false),
      alignTo,
    });
    emitEnvelopeJson(workspaceDir, "mix.beat-align", { action: "mix.beat-align", ...res });
    return;
  }
  return CLI_NOT_HANDLED;
}
