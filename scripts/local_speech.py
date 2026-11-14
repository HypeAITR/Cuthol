#!/usr/bin/env python3
"""Keyless local speech bridge for Cuthol (faster-whisper ASR + Piper TTS).

Shipped inside the npm package (`scripts/local_speech.py`) and driven by
`src/speech/local_engine.ts`; never hand-wire this in a shell.

Subcommands:
  asr <audio> --lang <code|auto> --model <dir|id> [--keyterms a,b]
    Decode <audio> with ffmpeg to 16 kHz mono s16le, transcribe with
    faster-whisper (deterministic: condition_on_previous_text=False, fixed
    beam_size, int8 CPU) and print the JSON the local provider parses:
    {"language": ..., "words": [{word, punctuated_word, source_start_ms,
    source_end_ms, confidence}]}.
  tts --text-file <utf8 file> --voice <onnx path|id> --out <wav>
    [plus --voices-dir and --piper-exe overrides]
    Synthesize with the Piper binary and print
    {"duration_ms": ..., "words": []} (Piper exposes no word timings, so
    Cuthol falls back to its proportional estimate).

Notes:
  - Audio is decoded by the ffmpeg binary (the bundled PyAV build rejects
    `av.open(..., metadata_errors=...)` in this version), never by PyAV.
  - The text file is always read as UTF-8 here, so Windows console code
    pages (cp1252 mangling "g", "u" etc.) cannot corrupt the input.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def decode_audio_16k_mono(path):
    """Decode any audio file to 16 kHz mono s16le via the ffmpeg binary."""
    import numpy as np

    ffmpeg = shutil.which("ffmpeg") or os.environ.get("FFMPEG_EXE", "ffmpeg")
    tmp = tempfile.NamedTemporaryFile(suffix=".raw", delete=False)
    tmp.close()
    try:
        subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-i", path,
             "-ac", "1", "-ar", "16000", "-f", "s16le", tmp.name],
            check=True,
        )
        with open(tmp.name, "rb") as f:
            raw = f.read()
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def cmd_asr(args):
    from faster_whisper import WhisperModel

    model_arg = args.model
    if os.path.isdir(model_arg):
        model_ref = model_arg
        model_label = os.path.basename(os.path.normpath(model_arg))
    else:
        model_ref = model_arg
        model_label = model_arg
    keyterms = [k.strip() for k in (args.keyterms or "").split(",") if k.strip()]
    hotwords = ", ".join(keyterms) if keyterms else None
    initial_prompt = (
        " ".join(keyterms) + "." if keyterms else None
    )
    lang = None if (args.lang or "auto").lower() == "auto" else args.lang

    model = WhisperModel(model_ref, device="cpu", compute_type="int8")
    try:
        pcm = decode_audio_16k_mono(args.audio)
        segments, info = model.transcribe(
            pcm,
            language=lang,
            word_timestamps=True,
            vad_filter=False,
            hotwords=hotwords,
            initial_prompt=initial_prompt,
            condition_on_previous_text=False,
            beam_size=5,
        )
        words = []
        for seg in segments:
            for w in seg.words or []:
                text = (w.word or "").strip()
                if not text:
                    continue
                words.append({
                    "word": text,
                    "punctuated_word": text,
                    "source_start_ms": int(round(w.start * 1000)),
                    "source_end_ms": int(round(w.end * 1000)),
                    "confidence": float(w.probability) if w.probability is not None else 0.99,
                })
        language = (info.language or args.lang or "auto").lower()
    finally:
        # Release the model promptly; callers may run ASR then TTS in sequence.
        del model

    sys.stdout.write(json.dumps(
        {"language": language, "model": model_label, "words": words},
        ensure_ascii=False,
    ) + "\n")


def resolve_voice(voice_arg, voices_dir):
    if voice_arg and os.path.isfile(voice_arg):
        return voice_arg
    candidates = []
    if voice_arg:
        candidates.append(voice_arg if voice_arg.endswith(".onnx") else voice_arg + ".onnx")
    if voices_dir:
        for name in candidates + ([voice_arg] if voice_arg else []):
            base = name if name.endswith(".onnx") else name + ".onnx"
            candidates.append(os.path.join(voices_dir, base))
            candidates.append(os.path.join(voices_dir, voice_arg or "", base))
    for cand in candidates:
        if cand and os.path.isfile(cand):
            return cand
    raise FileNotFoundError(
        "Piper voice not found: %r (tried %s)" % (voice_arg, candidates)
    )


def resolve_piper_exe(explicit):
    if explicit:
        return explicit
    env = os.environ.get("PIPER_EXE")
    if env:
        return env
    found = shutil.which("piper")
    if found:
        return found
    sibling = os.path.join(os.path.dirname(sys.executable), "piper.exe")
    if os.path.isfile(sibling):
        return sibling
    sibling2 = os.path.join(os.path.dirname(sys.executable), "piper")
    if os.path.isfile(sibling2):
        return sibling2
    raise FileNotFoundError(
        "Piper binary not found (set PIPER_EXE, put `piper` on PATH, "
        "or install it next to this Python)."
    )


def cmd_tts(args):
    import wave

    with open(args.text_file, "r", encoding="utf-8") as f:
        text = f.read()
    if not text.strip():
        raise ValueError("text file %r is empty" % args.text_file)
    voice_path = resolve_voice(args.voice, args.voices_dir)
    config_path = voice_path + ".json"
    piper_exe = resolve_piper_exe(args.piper_exe)

    cmd = [piper_exe, "-m", voice_path, "-f", args.out, "-i", args.text_file]
    if os.path.isfile(config_path):
        cmd += ["-c", config_path]
    env = dict(os.environ)
    # Keep stdin/stdout byte-clean; the text travels via --input-file.
    env.setdefault("PYTHONUTF8", "1")
    subprocess.run(cmd, check=True, env=env)

    with wave.open(args.out, "rb") as w:
        frames = w.getnframes()
        rate = w.getframerate() or 22050
    duration_ms = int(round(frames / float(rate) * 1000))
    sys.stdout.write(json.dumps(
        {"duration_ms": duration_ms, "words": []}, ensure_ascii=False
    ) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Cuthol keyless local speech bridge.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    asr = sub.add_parser("asr", help="Transcribe audio to provider JSON.")
    asr.add_argument("audio")
    asr.add_argument("--lang", default="auto")
    asr.add_argument("--model", required=True)
    asr.add_argument("--keyterms", default="")

    tts = sub.add_parser("tts", help="Synthesize a UTF-8 text file to wav.")
    tts.add_argument("--text-file", required=True)
    tts.add_argument("--voice", required=True)
    tts.add_argument("--out", required=True)
    tts.add_argument("--voices-dir", default=None)
    tts.add_argument("--piper-exe", default=None)

    args = parser.parse_args(argv)
    if args.cmd == "asr":
        cmd_asr(args)
    else:
        cmd_tts(args)


if __name__ == "__main__":
    main()
