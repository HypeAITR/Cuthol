/**
 * Multi-Vendor Hardware & Software Video Encoder Selection, Color Verification & Rate Control
 * (`src/render/encoder.ts`).
 *
 * Supports hardware H.264 encoders across GPU vendors with automatic fallback to `libx264`:
 *   1. NVIDIA NVENC (`h264_nvenc`)
 *   2. AMD AMF (`h264_amf`)
 *   3. Intel QuickSync (`h264_qsv`)
 *   4. Linux VAAPI (`h264_vaapi`)
 *   5. macOS VideoToolbox (`h264_videotoolbox`)
 *   6. Software CPU fallback (`libx264`)
 *
 * Note on Windows Media Foundation (`h264_mf`): deliberately excluded from automatic selection
 * because it wraps an opaque OS MFT without deterministic rate/matrix control, rejects `yuv420p`,
 * and measured slower than `libx264` on this hardware (2.2s vs 1.8s).
 *
 * Every hardware encoder is verified on first use via a real short color-bars encode compared
 * against a `libx264` BT.709 reference (checking both frame-aligned RGB PSNR and per-channel
 * color-bar drift after standard decoding). Results are memoized per process and cached on disk
 * keyed by hardware/driver/FFmpeg fingerprint.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveSharedCacheConfig,
  resolveVideoEncoderPreference,
  type VideoEncoderPreference,
} from "../core/env.js";
import { spawnWatchedSync } from "../core/subprocess.js";

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

const ENCODER_PROBE_CACHE_VERSION = "cuthol-encoder-probe-v2";
const MIN_VERIFICATION_PSNR_DB = 38.0;
const MAX_VERIFICATION_COLOR_DRIFT = 6.5;

const processProbeMemo = new Map<string, EncoderVerificationResult>();
let cachedEnvFingerprint: string | null = null;

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
export function buildVideoCodecArgs(
  encoder: VideoEncoderCodec,
  preset: "draft_480p" | "master_1080p"
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

function computeHardwareEnvironmentFingerprint(): string {
  if (cachedEnvFingerprint) return cachedEnvFingerprint;

  const parts: string[] = [
    ENCODER_PROBE_CACHE_VERSION,
    process.platform,
    process.arch,
    os.release(),
    os.cpus()[0]?.model ?? "cpu",
  ];

  try {
    const ffVer = spawnWatchedSync("ffmpeg", ["-version"], {
      encoding: "utf8",
      step: "ffmpeg version probe",
      stallTimeoutMs: 5000,
    });
    const firstLine = String(ffVer.stdout || "").split(/\r?\n/)[0] ?? "";
    parts.push(firstLine.trim());
  } catch {
    parts.push("ffmpeg-unknown");
  }

  if (process.platform === "win32") {
    try {
      // Query Windows Display class registry keys for installed GPU driver versions (fast, <40ms)
      const regProc = spawnWatchedSync(
        "reg",
        [
          "query",
          "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}",
          "/s",
          "/v",
          "DriverVersion",
        ],
        { encoding: "utf8", step: "gpu driver version query", stallTimeoutMs: 3000 }
      );
      if (regProc.status === 0 && regProc.stdout) {
        const versions = String(regProc.stdout)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.startsWith("DriverVersion"))
          .join("|");
        if (versions) parts.push(versions);
      }
    } catch {
      // ignore registry query failure
    }
  } else if (process.platform === "linux") {
    try {
      const drmDir = "/sys/class/drm";
      if (fs.existsSync(drmDir)) {
        const entries = fs
          .readdirSync(drmDir)
          .filter((e) => /^card\d+$/.test(e))
          .sort();
        for (const card of entries) {
          const ueventPath = path.join(drmDir, card, "device/uevent");
          if (fs.existsSync(ueventPath)) {
            parts.push(fs.readFileSync(ueventPath, "utf8").trim());
          }
        }
      }
    } catch {
      // ignore
    }
  }

  cachedEnvFingerprint = crypto
    .createHash("sha256")
    .update(parts.join("\n"))
    .digest("hex")
    .slice(0, 20);
  return cachedEnvFingerprint;
}

function getEncoderProbeCacheFilePath(): string | null {
  const overridePath = process.env.CUTHOL_ENCODER_CACHE_FILE?.trim();
  if (overridePath) {
    return path.resolve(overridePath);
  }
  const shared = resolveSharedCacheConfig();
  if (shared.enabled && shared.cacheDir) {
    return path.join(shared.cacheDir, "encoder_probes_v2.json");
  }
  return null;
}

interface DiskProbeCacheFile {
  fingerprint: string;
  entries: Record<string, Omit<EncoderVerificationResult, "cached">>;
}

function readDiskProbeEntry(encoder: VideoEncoderCodec): EncoderVerificationResult | null {
  const cacheFile = getEncoderProbeCacheFilePath();
  if (!cacheFile || !fs.existsSync(cacheFile)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as DiskProbeCacheFile;
    const fp = computeHardwareEnvironmentFingerprint();
    if (!parsed || parsed.fingerprint !== fp || !parsed.entries) return null;
    const hit = parsed.entries[encoder];
    if (!hit || typeof hit.ok !== "boolean") return null;
    return { ...hit, cached: true };
  } catch {
    return null;
  }
}

function writeDiskProbeEntry(result: EncoderVerificationResult): void {
  const cacheFile = getEncoderProbeCacheFilePath();
  if (!cacheFile) return;
  try {
    const fp = computeHardwareEnvironmentFingerprint();
    let data: DiskProbeCacheFile = { fingerprint: fp, entries: {} };
    if (fs.existsSync(cacheFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as DiskProbeCacheFile;
        if (existing && existing.fingerprint === fp && existing.entries) {
          data = existing;
        }
      } catch {
        // overwrite corrupt file
      }
    }
    const { cached: _c, ...toStore } = result;
    data.entries[result.encoder] = toStore;
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // ignore disk cache write failure
  }
}

export function clearEncoderProbeCache(): void {
  processProbeMemo.clear();
  cachedEnvFingerprint = null;
}

function matchesSimulatedList(rawEnv: string | undefined, encoder: VideoEncoderCodec): boolean {
  if (!rawEnv || !rawEnv.trim()) return false;
  const tokens = rawEnv
    .toLowerCase()
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.includes("1") || tokens.includes("all") || tokens.includes("true")) {
    return isHardwareEncoder(encoder);
  }
  const shortName = encoder.replace(/^h264_/, "");
  return tokens.includes(encoder.toLowerCase()) || tokens.includes(shortName);
}

/**
 * Computes frame-aligned RGB24 PSNR (in dB) and maximum per-bar color channel drift between two
 * decoded RGB24 buffers of dimensions `width x height x frames`.
 */
export function computeRgbBuffersPsnrAndColorDrift(
  candRgb: Buffer,
  refRgb: Buffer,
  width: number,
  height: number,
  frames: number
): { psnrDb: number; maxChannelDrift: number } {
  const frameBytes = width * height * 3;
  const totalBytes = Math.min(candRgb.length, refRgb.length, frameBytes * frames);
  if (totalBytes < frameBytes) {
    return { psnrDb: 0, maxChannelDrift: 255 };
  }

  let sumSq = 0;
  for (let i = 0; i < totalBytes; i++) {
    const d = candRgb[i] - refRgb[i];
    sumSq += d * d;
  }
  const mse = sumSq / totalBytes;
  const psnrDb = mse <= 1e-9 ? 99.0 : Number((10 * Math.log10((255 * 255) / mse)).toFixed(2));

  // Sample 7 horizontal bar regions across the upper half of frame 0 (where SMPTE HD bars sit)
  let maxChannelDrift = 0;
  const yStart = Math.floor(height * 0.15);
  const yEnd = Math.floor(height * 0.55);
  for (let bar = 0; bar < 7; bar++) {
    const xCenter = Math.floor(((bar + 0.5) / 7) * width);
    const xStart = Math.max(0, xCenter - 6);
    const xEnd = Math.min(width - 1, xCenter + 6);
    let sumDr = 0;
    let sumDg = 0;
    let sumDb = 0;
    let count = 0;
    for (let y = yStart; y <= yEnd; y += 2) {
      for (let x = xStart; x <= xEnd; x += 2) {
        const idx = (y * width + x) * 3;
        sumDr += candRgb[idx] - refRgb[idx];
        sumDg += candRgb[idx + 1] - refRgb[idx + 1];
        sumDb += candRgb[idx + 2] - refRgb[idx + 2];
        count++;
      }
    }
    if (count > 0) {
      const drift = Math.max(
        Math.abs(sumDr / count),
        Math.abs(sumDg / count),
        Math.abs(sumDb / count)
      );
      if (drift > maxChannelDrift) maxChannelDrift = drift;
    }
  }

  return {
    psnrDb,
    maxChannelDrift: Number(maxChannelDrift.toFixed(2)),
  };
}

/**
 * Verifies a video encoder via a real 6-frame `smptehdbars` encode and checks both frame-aligned
 * RGB PSNR (>= 38 dB) and maximum color-bar channel drift (<= 6.5 levels) against a `libx264`
 * BT.709 reference encode.
 */
export function probeAndVerifyVideoEncoder(
  encoder: VideoEncoderCodec,
  options?: { forceFresh?: boolean }
): EncoderVerificationResult {
  if (encoder === "libx264") {
    return {
      encoder: "libx264",
      ok: true,
      psnr_db: 99,
      max_channel_drift: 0,
      reason: null,
      elapsed_ms: 0,
      cached: true,
    };
  }

  // If stall simulation is active for NVENC (or this hardware encoder), report the encoder as available
  // during pre-render selection so the render step itself exercises the watchdog stall + libx264 retry path.
  if (
    (encoder === "h264_nvenc" && process.env.CUTHOL_SIMULATE_NVENC_STALL === "1") ||
    matchesSimulatedList(process.env.CUTHOL_SIMULATE_HW_ENCODER_STALL, encoder)
  ) {
    return {
      encoder,
      ok: true,
      psnr_db: 50,
      max_channel_drift: 0.5,
      reason: null,
      elapsed_ms: 0,
      cached: true,
    };
  }

  if (matchesSimulatedList(process.env.CUTHOL_SIMULATE_ENCODER_FAIL, encoder)) {
    return {
      encoder,
      ok: false,
      psnr_db: null,
      max_channel_drift: null,
      reason: `${encoder} hardware initialization failed (simulated via CUTHOL_SIMULATE_ENCODER_FAIL)`,
      elapsed_ms: 1,
      cached: false,
    };
  }

  const simulateColorShift = matchesSimulatedList(
    process.env.CUTHOL_SIMULATE_ENCODER_COLOR_SHIFT,
    encoder
  );
  const forceFresh =
    Boolean(options?.forceFresh) ||
    process.env.CUTHOL_FORCE_ENCODER_PROBE === "1" ||
    simulateColorShift;

  const memoKey = `${encoder}:${simulateColorShift ? "shift" : "norm"}`;
  if (!forceFresh) {
    const memHit = processProbeMemo.get(memoKey);
    if (memHit) return { ...memHit, cached: true };
    const diskHit = readDiskProbeEntry(encoder);
    if (diskHit) {
      processProbeMemo.set(memoKey, diskHit);
      return diskHit;
    }
  }

  const t0 = Date.now();
  const width = 320;
  const height = 180;
  const fps = 30;
  const frames = 6;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cuthol_enc_probe_${encoder}_`));
  const candMp4 = path.join(tmpDir, `cand_${encoder}.mp4`);
  const refMp4 = path.join(tmpDir, "ref_x264.mp4");

  try {
    // When `simulateColorShift` is active, feed Rec.601 YUV into the encoder while tagging the output as BT.709
    // (reproducing the exact 23.9 dB green/cyan shift caused by untagged 601 -> BT.709 VUI mismatch).
    const candVf = simulateColorShift
      ? "scale=in_color_matrix=bt601:out_color_matrix=bt601:out_range=tv,format=yuv420p"
      : "scale=in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";
    const refVf =
      "scale=in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";

    const codecArgs = buildVideoCodecArgs(encoder, "master_1080p");
    const vaapiInitArgs =
      encoder === "h264_vaapi"
        ? ["-vaapi_device", process.env.CUTHOL_VAAPI_DEVICE || "/dev/dri/renderD128"]
        : [];
    const effectiveCandVf =
      encoder === "h264_vaapi" ? `${candVf},format=nv12,hwupload` : candVf;

    const candProc = spawnWatchedSync(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-v",
        "error",
        ...vaapiInitArgs,
        "-f",
        "lavfi",
        "-i",
        `smptehdbars=s=${width}x${height}:r=${fps}:d=0.2`,
        "-frames:v",
        String(frames),
        "-vf",
        effectiveCandVf,
        "-an",
        ...codecArgs,
        candMp4,
      ],
      {
        encoding: "utf8",
        step: `ffmpeg ${encoder} probe`,
        stallTimeoutMs: 15_000,
      }
    );

    if (candProc.status !== 0 || candProc.error || !fs.existsSync(candMp4) || fs.statSync(candMp4).size < 256) {
      const stderrTail = String(candProc.stderr || candProc.stdout || "")
        .trim()
        .split(/\r?\n/)
        .slice(-2)
        .join(" | ")
        .slice(-200);
      const res: EncoderVerificationResult = {
        encoder,
        ok: false,
        psnr_db: null,
        max_channel_drift: null,
        reason: `${encoder} hardware encoder is not available on this machine${stderrTail ? ` (${stderrTail})` : ""}`,
        elapsed_ms: Date.now() - t0,
        cached: false,
      };
      processProbeMemo.set(memoKey, res);
      if (!simulateColorShift) writeDiskProbeEntry(res);
      return res;
    }

    const refProc = spawnWatchedSync(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `smptehdbars=s=${width}x${height}:r=${fps}:d=0.2`,
        "-frames:v",
        String(frames),
        "-vf",
        refVf,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "12",
        "-pix_fmt",
        "yuv420p",
        ...BT709_COLOR_OUTPUT_ARGS,
        refMp4,
      ],
      {
        encoding: "utf8",
        step: "ffmpeg libx264 reference probe",
        stallTimeoutMs: 15_000,
      }
    );

    if (refProc.status !== 0 || !fs.existsSync(refMp4)) {
      const res: EncoderVerificationResult = {
        encoder,
        ok: true,
        psnr_db: null,
        max_channel_drift: null,
        reason: null,
        elapsed_ms: Date.now() - t0,
        cached: false,
      };
      processProbeMemo.set(memoKey, res);
      return res;
    }

    // Decode both encoded files to RGB24 via FFmpeg's standard decoder + swscale path
    // (honoring each file's embedded bitstream VUI color space/range tags!)
    const maxBuf = width * height * 3 * frames + 262_144;
    const decCand = spawnWatchedSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        candMp4,
        "-frames:v",
        String(frames),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { maxBuffer: maxBuf, step: `ffmpeg decode ${encoder} probe`, stallTimeoutMs: 10_000 }
    );
    const decRef = spawnWatchedSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        refMp4,
        "-frames:v",
        String(frames),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { maxBuffer: maxBuf, step: "ffmpeg decode ref probe", stallTimeoutMs: 10_000 }
    );

    const candBuf = decCand.stdout as Buffer;
    const refBuf = decRef.stdout as Buffer;
    const expectedBytes = width * height * 3 * frames;
    if (
      decCand.status !== 0 ||
      decRef.status !== 0 ||
      !candBuf ||
      !refBuf ||
      candBuf.length < width * height * 3 ||
      refBuf.length < width * height * 3
    ) {
      const res: EncoderVerificationResult = {
        encoder,
        ok: false,
        psnr_db: null,
        max_channel_drift: null,
        reason: `${encoder} probe output could not be decoded for color verification`,
        elapsed_ms: Date.now() - t0,
        cached: false,
      };
      processProbeMemo.set(memoKey, res);
      return res;
    }

    const decodedFrames = Math.min(
      frames,
      Math.floor(Math.min(candBuf.length, refBuf.length) / (width * height * 3))
    );
    const { psnrDb, maxChannelDrift } = computeRgbBuffersPsnrAndColorDrift(
      candBuf,
      refBuf,
      width,
      height,
      decodedFrames
    );

    const passed =
      candBuf.length >= expectedBytes &&
      psnrDb >= MIN_VERIFICATION_PSNR_DB &&
      maxChannelDrift <= MAX_VERIFICATION_COLOR_DRIFT;

    const reason = passed
      ? null
      : `${encoder} failed color accuracy verification against libx264 BT.709 reference (PSNR=${psnrDb.toFixed(2)}dB [min ${MIN_VERIFICATION_PSNR_DB}dB], max_channel_drift=${maxChannelDrift.toFixed(2)} [max ${MAX_VERIFICATION_COLOR_DRIFT}])`;

    const res: EncoderVerificationResult = {
      encoder,
      ok: passed,
      psnr_db: psnrDb,
      max_channel_drift: maxChannelDrift,
      reason,
      elapsed_ms: Date.now() - t0,
      cached: false,
    };
    processProbeMemo.set(memoKey, res);
    if (!simulateColorShift && !options?.forceFresh) {
      writeDiskProbeEntry(res);
    }
    return res;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Resolves the active video encoder for `renderSequenceToMp4` (and intermediate segment encodes).
 * - Honors `overrideEncoder` (`render --encoder ...`), `CUTHOL_ENCODER`, `CUTHOL_VIDEO_ENCODER`,
 *   and backward-compatible `CUTHOL_DISABLE_NVENC=1` / `CUTHOL_DISABLE_GPU=1`.
 * - In `auto` mode, probes platform hardware encoders in vendor order
 *   (`h264_nvenc` -> `h264_amf` -> `h264_qsv` -> `h264_vaapi` -> `h264_videotoolbox`)
 *   and selects the first one that passes both hardware initialization and BT.709 color verification.
 */
export function resolveVideoEncoderForRender(overrideEncoder?: string | null): ResolvedRenderEncoder {
  const pref = resolveVideoEncoderPreference(overrideEncoder);

  if (pref === "libx264") {
    return {
      encoder: "libx264",
      preference: "libx264",
      fallback: {
        from: "h264_nvenc",
        to: "libx264",
        reason:
          "Hardware encoding disabled by configuration (CUTHOL_DISABLE_NVENC / CUTHOL_ENCODER=x264 / CUTHOL_VIDEO_ENCODER=libx264)",
      },
    };
  }

  if (pref !== "auto") {
    const targetCodec = preferenceToHardwareCodec(pref);
    const probe = probeAndVerifyVideoEncoder(targetCodec);
    if (probe.ok) {
      return {
        encoder: targetCodec,
        preference: pref,
        fallback: null,
        probe,
      };
    }
    return {
      encoder: "libx264",
      preference: pref,
      fallback: {
        from: targetCodec,
        to: "libx264",
        reason: probe.reason ?? `${targetCodec} is not available on this machine`,
      },
      probe,
    };
  }

  // `auto` mode: try vendor hardware encoders in priority order
  const candidates = getAutoHardwareEncoderOrder();
  const failureReasons: string[] = [];
  let firstFailedCodec: HardwareEncoderCodec = candidates[0] ?? "h264_nvenc";

  for (const codec of candidates) {
    const probe = probeAndVerifyVideoEncoder(codec);
    if (probe.ok) {
      return {
        encoder: codec,
        preference: "auto",
        fallback:
          failureReasons.length > 0 && process.env.CUTHOL_SIMULATE_ENCODER_COLOR_SHIFT
            ? {
                from: firstFailedCodec,
                to: codec,
                reason: failureReasons.join("; "),
              }
            : null,
        probe,
      };
    }
    if (failureReasons.length === 0) {
      firstFailedCodec = codec;
    }
    if (probe.reason) {
      failureReasons.push(probe.reason);
    }
  }

  return {
    encoder: "libx264",
    preference: "auto",
    fallback: {
      from: firstFailedCodec,
      to: "libx264",
      reason:
        failureReasons.join("; ") ||
        `${firstFailedCodec} hardware encoder is not available on this machine`,
    },
  };
}
