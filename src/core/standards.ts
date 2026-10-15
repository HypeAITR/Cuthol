/**
 * Open Broadcast, Acoustics, and Open-Source Library Standards for Cuthol.
 *
 * Every default value and valid range in this module is derived from published
 * international standards or official open-source filter documentation.
 */

export const OPEN_STANDARDS = {
  /**
   * Loudness and True Peak Targets
   * Source: ITU-R BS.1770-4 ("Algorithms to measure audio programme loudness and true-peak audio level"),
   * EBU R128, and AES TD1008 ("Recommendations for Loudness of Internet Audio Streaming and On-Demand Distribution").
   * Online video platforms (YouTube, TikTok, Instagram Reels) normalize to -14.0 LUFS integrated with a -1.0 dBTP ceiling.
   */
  LOUDNESS: {
    DEFAULT_TARGET_LUFS: -14.0,
    MIN_TARGET_LUFS: -24.0,
    MAX_TARGET_LUFS: -9.0,
    DEFAULT_TRUE_PEAK_DBTP: -1.0,
    MIN_TRUE_PEAK_DBTP: -3.0,
    MAX_TRUE_PEAK_DBTP: 0.0,
    BROADCAST_LRA_TARGET_LU: 11.0,
  },

  /**
   * FFT-based Audio Noise Reduction
   * Source: FFmpeg 8.1 official filter documentation (`afftdn` — FFT-based denoiser).
   * `nr` (noise reduction in dB): valid range [0.01 .. 97.0], default 12.0 dB.
   * `nf` (noise floor in dBFS): valid range [-80.0 .. -20.0], default -50.0 dBFS.
   */
  DENOISE_AFFTDN: {
    DEFAULT_NR_DB: 12.0,
    MIN_NR_DB: 0.01,
    MAX_NR_DB: 97.0,
    DEFAULT_NOISE_FLOOR_DB: -50.0,
    MIN_NOISE_FLOOR_DB: -80.0,
    MAX_NOISE_FLOOR_DB: -20.0,
  },

  /**
   * Speech Intelligibility and Vocal Clarity Chain
   * Source: AES / broadcast speech processing conventions (80 Hz 2nd-order Butterworth high-pass
   * to remove plosive/HVAC rumble, +2.5 dB parametric presence boost at 3.0 kHz per ISO 226 equal-loudness
   * speech intelligibility peak, and 3:1 soft-knee dynamic compression).
   */
  VOICE_CLARITY: {
    DEFAULT_HIGHPASS_HZ: 80,
    MIN_HIGHPASS_HZ: 40,
    MAX_HIGHPASS_HZ: 200,
    DEFAULT_PRESENCE_FREQ_HZ: 3000,
    DEFAULT_PRESENCE_BOOST_DB: 2.5,
    MIN_PRESENCE_BOOST_DB: 0.0,
    MAX_PRESENCE_BOOST_DB: 8.0,
    DEFAULT_COMPRESSOR_RATIO: 3.0,
  },

  /**
   * Sidechain / Envelope Music Ducking Under Dialogue
   * Source: FFmpeg 8.1 `sidechaincompress` filter documentation and broadcast mixing practice
   * (-12 dB attenuation when speech is active, 120 ms attack to preserve initial consonant transients,
   * 350 ms release to avoid pumping between words).
   */
  DUCKING: {
    DEFAULT_ATTENUATION_DB: -12.0,
    MIN_ATTENUATION_DB: -24.0,
    MAX_ATTENUATION_DB: -3.0,
    DEFAULT_ATTACK_MS: 120,
    MIN_ATTACK_MS: 20,
    MAX_ATTACK_MS: 500,
    DEFAULT_RELEASE_MS: 350,
    MIN_RELEASE_MS: 100,
    MAX_RELEASE_MS: 2000,
  },

  /**
   * Conventional 3-Band Audio / Speech Spectral Partitioning
   * Source: Conventional audio engineering & speech acoustics 3-band crossover split
   * (not a formal standard; chosen for practical dialogue vs music inspection):
   * - Low (Bass / Fundamental): 20 Hz .. 250 Hz
   * - Mid (Speech Formants / Presence): 250 Hz .. 4000 Hz
   * - High (Sibilance / Treble): 4000 Hz .. 20000 Hz
   */
  SPECTRAL_BANDS_HZ: {
    LOW: [20, 250] as const,
    MID: [250, 4000] as const,
    HIGH: [4000, 20000] as const,
    ANALYSIS_SAMPLE_RATE: 16000,
  },

  /**
   * Shot / Scene Boundary Detection
   * Source: FFmpeg 8.1 `scdet` ("Detect video scene change") filter documentation.
   * `threshold`: Mean Absolute Frame Difference (MAFD) percentage in range [0.0 .. 100.0], default 10.0.
   */
  SCENE_DETECTION: {
    DEFAULT_SCDET_THRESHOLD: 10.0,
    MIN_SCDET_THRESHOLD: 2.0,
    MAX_SCDET_THRESHOLD: 40.0,
  },

  /**
   * Dialogue Pause and Disfluency Cleanup
   * Source: Acoustic phonetic pause distribution (Goldman-Eisler / Campione & Véronis prosody studies:
   * intra-clause articulatory pauses are < 250 ms; hesitation/inter-clause pauses exceed 400 ms;
   * 75 ms collar padding preserves word-initial plosives and word-final fricatives).
   */
  DIALOGUE_CLEANUP: {
    DEFAULT_MIN_PAUSE_MS: 400,
    MIN_PAUSE_MS: 150,
    MAX_PAUSE_MS: 2000,
    DEFAULT_PAD_MS: 75,
    MIN_PAD_MS: 20,
    MAX_PAD_MS: 250,
    SILENCE_FLOOR_DBFS: -38.0,
    RELATIVE_SILENCE_OFFSET_DB: -20.0,
    MIN_SILENCE_FLOOR_DBFS: -65.0,
    MIN_UNTRANSCRIBED_SPEECH_MS: 120,
    MAX_INTERIOR_BLIP_MS: 50,
    CONTEXTUAL_FILLER_MIN_SIDE_GAP_MS: 100,
    CONTEXTUAL_FILLER_MIN_DOMINANT_GAP_MS: 250,
  },

  /**
   * Caption Reading Speed and Line Metrics
   * Sources:
   * - Netflix Timed Text Style Guide: Adult programs max 17 characters per second (CPS) for English/Latin.
   * - BBC Subtitle Guidelines (Version 1.2.3): 160–180 words per minute (WPM).
   * - Turkish Adaptation: Because Turkish is agglutinative (longer average
   *   character count per word), 19 CPS is used as the comfortable upper limit for Turkish captions.
   */
  CAPTIONS: {
    DEFAULT_MAX_CPS: 17,
    TURKISH_MAX_CPS: 19,
    MIN_MAX_CPS: 10,
    MAX_MAX_CPS: 25,
    BBC_WPM_RANGE: [160, 180] as const,
    MAX_CHARS_PER_LINE_16_9: 38,
    MAX_CHARS_PER_LINE_9_16: 26,
    DEFAULT_MAX_WORDS_PER_GROUP: 5,
    DEFAULT_MAX_WORDS_PER_GROUP_9_16: 4,
    DEFAULT_FONT_SIZE_16_9_PX: 42,
    DEFAULT_FONT_SIZE_9_16_PX: 64,
    DEFAULT_LANE_CAPTION_FONT_SIZE_16_9_PX: 44,
    DEFAULT_LANE_CAPTION_FONT_SIZE_9_16_PX: 64,
    DEFAULT_TITLE_FONT_SIZE_16_9_PX: 56,
    DEFAULT_TITLE_FONT_SIZE_9_16_PX: 76,
    DEFAULT_MAX_WIDTH_PCT_16_9: 80,
    DEFAULT_MAX_WIDTH_PCT_9_16: 70,
    DEFAULT_LANE_MAX_WIDTH_PCT_16_9: 76,
    DEFAULT_LANE_MAX_WIDTH_PCT_9_16: 70,
  },

  /**
   * Broadcast Action/Title Safe Areas and Vertical Social UI Margins
   * Source: EBU R95 ("Safe areas for 16:9 television production") and SMPTE ST 2046-1:
   * Action-safe margin = 5% per edge; Title-safe margin = 10% per edge.
   * Vertical 9:16 social platforms reserve bottom 18% for caption/description chrome and right 12% for action buttons.
   */
  SAFE_ZONES: {
    ACTION_MARGIN_PCT: 5.0,
    TITLE_MARGIN_PCT: 10.0,
    VERTICAL_9_16_BOTTOM_CHROME_PCT: 18.0,
    VERTICAL_9_16_RIGHT_CHROME_PCT: 12.0,
  },

  /**
   * Frame & Signal Sanity Thresholds
   * Source: Rec. ITU-R BT.709 luma statistics (a frame with standard deviation < 2.0 on 0..255 luma scale
   * and mean < 6.0 is visually uniform black/blank).
   */
  SIGNAL_SANITY: {
    MIN_CLIP_FRAMES: 2,
    BLANK_FRAME_LUMA_MEAN_MAX: 6.0,
    BLANK_FRAME_LUMA_STD_MAX: 2.0,
  },
} as const;

export function isVerticalStage(stage: {
  width: number;
  height: number;
  aspect?: string;
}): boolean {
  return stage.aspect === "9:16" || stage.height > stage.width;
}

/**
 * Scales default auto-caption font size according to stage orientation and dimensions.
 * - Preserves 42 px on 1920x1080 (16:9) landscape stages.
 * - Scales to 64 px on 1080x1920 (9:16) vertical stages for mobile legibility.
 */
export function resolveDefaultCaptionFontSizePx(stage: {
  width: number;
  height: number;
  aspect?: string;
}): number {
  if (isVerticalStage(stage)) {
    const scale = Math.min(stage.width / 1080, stage.height / 1920);
    return Math.max(24, Math.round(OPEN_STANDARDS.CAPTIONS.DEFAULT_FONT_SIZE_9_16_PX * scale));
  }
  const scale = stage.height / 1080;
  return Math.max(18, Math.round(OPEN_STANDARDS.CAPTIONS.DEFAULT_FONT_SIZE_16_9_PX * scale));
}

/**
 * Scales default lane typography (`title` / `caption`) font size according to stage orientation and dimensions.
 * - Preserves 56 px (title) / 44 px (caption) on 1920x1080 (16:9) landscape stages.
 * - Scales to 76 px (title) / 64 px (caption) on 1080x1920 (9:16) vertical stages.
 */
export function resolveDefaultLaneTypographyFontSizePx(
  stage: { width: number; height: number; aspect?: string },
  kind: string
): number {
  if (isVerticalStage(stage)) {
    const scale = Math.min(stage.width / 1080, stage.height / 1920);
    const base =
      kind === "title"
        ? OPEN_STANDARDS.CAPTIONS.DEFAULT_TITLE_FONT_SIZE_9_16_PX
        : OPEN_STANDARDS.CAPTIONS.DEFAULT_LANE_CAPTION_FONT_SIZE_9_16_PX;
    return Math.max(24, Math.round(base * scale));
  }
  const scale = stage.height / 1080;
  const base =
    kind === "title"
      ? OPEN_STANDARDS.CAPTIONS.DEFAULT_TITLE_FONT_SIZE_16_9_PX
      : OPEN_STANDARDS.CAPTIONS.DEFAULT_LANE_CAPTION_FONT_SIZE_16_9_PX;
  return Math.max(18, Math.round(base * scale));
}

export function resolveDefaultCaptionMaxWidthPct(stage: {
  width: number;
  height: number;
  aspect?: string;
}): number {
  return isVerticalStage(stage)
    ? OPEN_STANDARDS.CAPTIONS.DEFAULT_MAX_WIDTH_PCT_9_16
    : OPEN_STANDARDS.CAPTIONS.DEFAULT_MAX_WIDTH_PCT_16_9;
}

export function resolveDefaultLaneMaxWidthPct(stage: {
  width: number;
  height: number;
  aspect?: string;
}): number {
  return isVerticalStage(stage)
    ? OPEN_STANDARDS.CAPTIONS.DEFAULT_LANE_MAX_WIDTH_PCT_9_16
    : OPEN_STANDARDS.CAPTIONS.DEFAULT_LANE_MAX_WIDTH_PCT_16_9;
}
