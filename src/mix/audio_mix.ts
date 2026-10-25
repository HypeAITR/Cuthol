/**
 * Cuthol Audio Mixing, Loudness Normalization, Voice Polish, Auto-Ducking & Beat Alignment (`src/mix/audio_mix.ts`).
 */

export { normalizeSequenceAudio, polishVoiceAudio } from "./mix_normalize.js";
export type { NormalizeAudioResult } from "./mix_normalize.js";
export { duckMusicUnderDialogue } from "./mix_duck.js";
export { alignClipsToBeats } from "./mix_beat_align.js";

