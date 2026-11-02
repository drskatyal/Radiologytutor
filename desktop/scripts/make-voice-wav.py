#!/usr/bin/env python3
"""Spoken test commands for the voice e2e (Chromium's fake microphone).

    python3 desktop/scripts/make-voice-wav.py out.wav ["layout two" "lung window" …]

Synthesizes each phrase with espeak-ng (apt install espeak-ng) and joins them
with 1.2 s of silence, as 16 kHz mono 16-bit PCM. Chromium loops the file.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import wave
from pathlib import Path

RATE = 16_000
DEFAULT = ["layout two", "lung window", "zoom in"]


def speak(text: str, out: Path) -> None:
    # A clear, slightly slow voice; resampled to 16 kHz by espeak's own output path below.
    raw = out.with_suffix(".22k.wav")
    subprocess.run(["espeak-ng", "-v", "en-us", "-s", "140", "-w", str(raw), text], check=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(raw), "-ac", "1", "-ar", str(RATE), "-sample_fmt", "s16", str(out)], check=True)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    target = Path(sys.argv[1])
    phrases = sys.argv[2:] or DEFAULT
    silence = b"\x00\x00" * int(RATE * 1.2)
    frames = [silence]
    with tempfile.TemporaryDirectory() as tmp:
        for i, phrase in enumerate(phrases):
            part = Path(tmp) / f"p{i}.wav"
            speak(phrase, part)
            with wave.open(str(part)) as w:
                frames.append(w.readframes(w.getnframes()))
            frames.append(silence)
    with wave.open(str(target), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(frames))
    print(f"wrote {target}: {', '.join(phrases)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
