// Plain-text `cuthol help` output (split out of cli.ts).

export function printHelp(): void {
  console.log(
    [
      "Cuthol — Agent-First Open-Source Non-Linear Video Editor (NLE)",
      "",
      "Usage:",
      "  cuthol workspace init [dir] [--aspect 9:16|16:9|1:1] [--fps 30] [--title <name>]",
      "  cuthol workspace backdrop --color <#RRGGBB> [--dir <dir>]",
      "  cuthol workspace journal [list | undo [--steps N | --to <rev>] [--expect-rev <rev>] [--dry-run] | redo [--steps N] | tag <name>] [--dir <dir>]",
      "  cuthol library ingest <files...> [--handle <vid_01>] [--dir <dir>]",
      "  cuthol library loudness --handle <vid_01> [--target-lufs -14] [--dir <dir>]",
      "  cuthol library waveform --handle <vid_01> [--bins 160] [--png <out.png>] [--verbose] [--dir <dir>]",
      "  cuthol library beats --handle <aud_01> [--sensitivity 1.35] [--verbose] [--dir <dir>]",
      "  cuthol library scenes --handle <vid_01> [--threshold 10.0] [--verbose] [--dir <dir>]",
      "  cuthol library detach-audio --handle <vid_01> [--target-handle <aud_01>] [--dir <dir>]",
      "  cuthol library query --handle <vid_01|ln_captions> [--kind transcript|beats|waveform|scenes|captions] [--range 0s..5s] [--text <q>] [--limit 40] [--cursor <idx>] [--max-tokens 2000]",
      "  cuthol spine [append|split|trim|excise|remove|reorder|transform|speed|transition|envelope] ...",
      "  cuthol lane [add-cue|add-composition|update-cue|remove-cue|lock|unlock] ...",
      "  cuthol composition [scaffold|sync|preview|check] --comp-dir <dir> ...",
      "  cuthol cue [plan|apply|diff|export] --file <cuthol.cues.json>",
      "  cuthol speech [transcribe|synthesize|cleanup|captions] ...",
      "  cuthol mix [normalize|polish-voice|duck|beat-align] ...",
      "  cuthol verify [--gates all|G1_SCHEMA,G2_ASSETS,G3_TIMING,G4_STAGE,G5_SIGNAL]",
      "  cuthol monitor frame --at <2400ms> [--boxes true] [--out <frame.png>] [--dir <dir>]",
      "  cuthol monitor sheet [--start 0s] [--end 12s] [--grid 3x3] [--boxes true] [--out <sheet.png>] [--dir <dir>]",
      "  cuthol monitor timeline [--width 1400] [--include-empty] [--out <timeline.png>] [--dir <dir>]",
      "  cuthol render [--preset draft_480p|master_1080p] [--out <render.mp4>] [--dir <dir>]",
      "  cuthol brief [--lens overview|flow|canvas|detail] [--id <id1,id2>] [--window 0s..10s] [--json] [--dir <dir>]",
      "  cuthol extension [list|create|show|enable|disable|promote|remove|run] --name <ext> ...",
      "  cuthol mcp",
      "",
      "Global output flags: [--compact | --format text|json]",
    ].join("\n")
  );
}
