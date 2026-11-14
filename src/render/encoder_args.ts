// Encoder types, BT.709 output args, hardware encoder order and codec arguments (split out of encoder.ts).
import os from "node:os";
import {
  type VideoEncoderPreference
} from "../core/env.js";

export type VideoEncoderCodec =
  | "h264_nvenc"
  | "h264_amf"
  | "h264_qsv"
  | "h264_vaapi"
  | "h264_videotoolbox"
  | "libx264";

export type HardwareEncoderCodec = Exclude<VideoEncoderCodec, "libx264">;

export interface RenderEncoderFallback {
  from: VideoEncoderCodec;
  to: VideoEncoderCodec;
  reason: string;
}

export interface EncoderVerificationResult {
  encoder: VideoEncoderCodec;
  ok: boolean;
  psnr_db: number | null;
  max_channel_drift: number | null;
  reason: string | null;
  elapsed_ms: number;
  cached: boolean;
}

export interface ResolvedRenderEncoder {
  encoder: VideoEncoderCodec;
  preference: VideoEncoderPreference;
  fallback: RenderEncoderFallback | null;
  probe?: EncoderVerificationResult;
}

export const BT709_COLOR_OUTPUT_ARGS: readonly string[] = [
  "-colorspace",
  "bt709",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-color_range",
  "tv",
];

export const H264_BT709_VUI_BSF =
  "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0";

export function isHardwareEncoder(encoder: VideoEncoderCodec): encoder is HardwareEncoderCodec {
  return encoder !== "libx264";
}

export function preferenceToHardwareCodec(
  pref: Exclude<VideoEncoderPreference, "auto" | "libx264">
): HardwareEncoderCodec {
  switch (pref) {
    case "nvenc":
      return "h264_nvenc";
    case "amf":
      return "h264_amf";
    case "qsv":
      return "h264_qsv";
    case "vaapi":
      return "h264_vaapi";
    case "videotoolbox":
      return "h264_videotoolbox";
  }
}

/**
 * Returns the ordered list of hardware encoders to try in `auto` mode for the given OS platform.
 */
export function getAutoHardwareEncoderOrder(
  platform: NodeJS.Platform = process.platform
): HardwareEncoderCodec[] {
  if (platform === "darwin") {
    return ["h264_videotoolbox"];
  }
  if (platform === "linux") {
    return ["h264_nvenc", "h264_amf", "h264_qsv", "h264_vaapi"];
  }
  // Windows & other platforms: NVIDIA -> AMD -> Intel
  return ["h264_nvenc", "h264_amf", "h264_qsv"];
}

/**
 * Resolves the maximum number of simultaneous hardware encode sessions to open during
 * parallel segment encoding. Consumer GPUs often cap concurrent sessions (e.g. 2-3),
 * so bounding concurrency avoids unnecessary session allocation failures.
 */
export function resolveMaxHardwareEncoderSessions(encoder: VideoEncoderCodec): number {
  if (!isHardwareEncoder(encoder)) {
    return Math.max(2, Math.min(os.cpus().length, 6));
  }
  const raw = process.env.CUTHOL_HW_ENCODER_SESSIONS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.max(1, Math.min(16, Math.floor(parsed)));
    }
  }
  return 2;
}

/**
 * Builds the FFmpeg video codec and explicit BT.709 (TV range) arguments for a given encoder and preset.
 *
 * Notice on `h264_amf`:
 * - AMD AMF stamps `matrix_coefficients=bt709, range=tv` into the H.264 VUI by default, which causes
 *   severe green/cyan color shifts (~23.9 dB) if the upstream filtergraph feeds default Rec.601 YUV,
 *   and AMF also leaves `colour_primaries` / `transfer_characteristics` as `unknown` in the SPS VUI
 *   unless `-bsf:v h264_metadata=...` is applied. Pairing explicit BT.709 filtergraph conversion with
 *   `-colorspace bt709` + `h264_metadata` VUI tags produces accurate BT.709 output (~49-51 dB).
 */
export type AlphaVideoCodec = "prores_ks" | "libvpx-vp9";

export function isDraftPreset(preset: string): boolean {
  return preset === "draft_480p";
}

export const ALPHA_CODEC_CHOICE_NOTE =
  "master_alpha keeps the alpha plane: ProRes 4444 (.mov) when this ffmpeg build encodes prores_ks reliably, else VP9 with alpha (.webm). Measured at render time by probing the ffmpeg build.";

/**
 * Video codec arguments for the transparent master preset. ProRes 4444 in MOV
 * is preferred (editors import it directly); VP9/WebM is the fallback when
 * this ffmpeg build cannot encode prores_ks. Both keep the alpha plane.
 */
export function buildAlphaCodecArgs(codec: AlphaVideoCodec): string[] {
  if (codec === "prores_ks") {
    return ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "ap10"];
  }
  return ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "18", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0"];
}

export function alphaOutputExtension(codec: AlphaVideoCodec): string {
  return codec === "prores_ks" ? ".mov" : ".webm";
}

export function buildVideoCodecArgs(
  encoder: VideoEncoderCodec,
  preset: "draft_480p" | "master_1080p" | "master_2160p" | "master_alpha"
): string[] {
  switch (encoder) {
    case "h264_nvenc":
      return preset === "draft_480p"
        ? [
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p1",
            "-rc",
            "vbr",
            "-cq",
            "24",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
            ...BT709_COLOR_OUTPUT_ARGS,
          ]
        : [
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p4",
            "-tune",
            "hq",
            "-rc",
            "vbr",
            "-cq",
            "22",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
            ...BT709_COLOR_OUTPUT_ARGS,
          ];

    case "h264_amf":
      return preset === "draft_480p"
        ? [
            "-c:v",
            "h264_amf",
            "-quality",
            "speed",
            "-rc",
            "cqp",
            "-qp_i",
            "22",
            "-qp_p",
            "24",
            "-qp_b",
            "26",
            "-pix_fmt",
            "yuv420p",
            ...BT709_COLOR_OUTPUT_ARGS,
            "-bsf:v",
            H264_BT709_VUI_BSF,
          ]
        : [
            "-c:v",
            "h264_amf",
            "-quality",
            "balanced",
            "-rc",
            "cqp",
            "-qp_i",
            "20",
            "-qp_p",
            "22",
            "-qp_b",
            "24",
            "-pix_fmt",
            "yuv420p",
            ...BT709_COLOR_OUTPUT_ARGS,
            "-bsf:v",
            H264_BT709_VUI_BSF,
          ];

    case "h264_qsv":
      return preset === "draft_480p"
        ? [
            "-c:v",
            "h264_qsv",
            "-preset",
            "veryfast",
            "-global_quality",
            "24",
            "-pix_fmt",
            "nv12",
            ...BT709_COLOR_OUTPUT_ARGS,
          ]
        : [
            "-c:v",
            "h264_qsv",
            "-preset",
            "medium",
            "-global_quality",
            "21",
            "-pix_fmt",
            "nv12",
            ...BT709_COLOR_OUTPUT_ARGS,
          ];

    case "h264_vaapi":
      return preset === "draft_480p"
        ? [
            "-c:v",
            "h264_vaapi",
            "-rc_mode",
            "CQP",
            "-qp",
            "24",
            ...BT709_COLOR_OUTPUT_ARGS,
          ]
        : [
            "-c:v",
            "h264_vaapi",
            "-rc_mode",
            "CQP",
            "-qp",
            "21",
            ...BT709_COLOR_OUTPUT_ARGS,
          ];

    case "h264_videotoolbox":
      return preset === "draft_480p"
        ? [
            "-c:v",
            "h264_videotoolbox",
            "-q:v",
            "65",
            "-allow_sw",
            "1",
            "-pix_fmt",
            "yuv420p",
            ...BT709_COLOR_OUTPUT_ARGS,
          ]
        : [
            "-c:v",
            "h264_videotoolbox",
            "-q:v",
            "75",
            "-allow_sw",
            "1",
            "-pix_fmt",
            "yuv420p",
            ...BT709_COLOR_OUTPUT_ARGS,
          ];

    case "libx264":
    default:
      return [
        "-c:v",
        "libx264",
        "-preset",
        preset === "draft_480p" ? "ultrafast" : "fast",
        "-crf",
        preset === "draft_480p" ? "24" : "19",
        "-pix_fmt",
        "yuv420p",
        ...BT709_COLOR_OUTPUT_ARGS,
      ];
  }
}
