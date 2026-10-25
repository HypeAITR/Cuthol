// Explicit BT.709 conversion filter strings and the per-source input scale/matrix filter (split out of compiler.ts).
import {
  SourceColorSpec
} from "../library/probe.js";

export const BT709_SETPARAMS =
  "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";

export const BT709_TO_YUV420P = `scale=in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv,format=yuv420p,${BT709_SETPARAMS}`;

export const BT709_TO_YUVA420P = `scale=in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv,format=yuva420p,${BT709_SETPARAMS}`;

export const BT709_TO_YUV444P10 = `scale=in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv,format=yuv444p10le,${BT709_SETPARAMS}`;

export const BT709_TO_YUVA444P10 = `scale=in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv,format=yuva444p10le,${BT709_SETPARAMS}`;

export const BT709_TO_RGBA = "scale=in_color_matrix=bt709:out_color_matrix=bt709,format=rgba";

export function buildSourceScaleFilter(
  width: number,
  height: number,
  colorSpec: SourceColorSpec,
  forceOriginalAspectRatio?: "decrease" | "increase"
): string {
  const foar = forceOriginalAspectRatio
    ? `:force_original_aspect_ratio=${forceOriginalAspectRatio}`
    : "";
  if (colorSpec.isRgb) {
    return `scale=${width}:${height}${foar}`;
  }
  return `scale=${width}:${height}${foar}:in_color_matrix=${colorSpec.inMatrix}:out_color_matrix=bt709:in_range=${colorSpec.inRange}:out_range=tv`;
}
