#!/usr/bin/env python3
"""Spoken test commands for the voice e2e (Chromium's fake microphone).

    python3 desktop/scripts/make-voice-wav.py [--room] out.wav ["layout two" "lung window" …]

Synthesizes each phrase with espeak-ng (apt install espeak-ng) and joins them
with 1.2 s of silence, as 16 kHz mono 16-bit PCM. Chromium loops the file.

--room plays the result through a simulated loudspeaker-to-microphone path —
a speaker's band (250 Hz–5.5 kHz), two early room reflections, quieter level
and seeded pink background noise (~25 dB SNR) — the way a reader's voice, or
speech played through a laptop speaker, reaches the mic. Deterministic: the
committed fixture e2e/fixtures/voice/commands-room.wav is made with it.
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


def room(clean: Path, out: Path) -> None:
    """Speaker band + early reflections + level drop, mixed with seeded pink noise."""
    seconds = wave.open(str(clean)).getnframes() / RATE
    graph = (
        "[0:a]highpass=f=250,lowpass=f=5500,aecho=0.8:0.7:23|47:0.35|0.2,volume=0.55[v];"
        f"anoisesrc=color=pink:seed=20261102:amplitude=0.012:sample_rate={RATE}:duration={seconds:.3f}[n];"
        "[v][n]amix=inputs=2:duration=first:normalize=0[m]"
    )
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", str(clean), "-filter_complex", graph, "-map", "[m]",
         "-ac", "1", "-ar", str(RATE), "-sample_fmt", "s16", "-bitexact", "-fflags", "+bitexact", str(out)],
        check=True,
    )


def main() -> int:
    args = sys.argv[1:]
    through_room = "--room" in args
    args = [a for a in args if a != "--room"]
    if not args:
        print(__doc__)
        return 2
    target = Path(args[0])
    phrases = args[1:] or DEFAULT
    silence = b"\x00\x00" * int(RATE * 1.2)
    frames = [silence]
    with tempfile.TemporaryDirectory() as tmp:
        for i, phrase in enumerate(phrases):
            part = Path(tmp) / f"p{i}.wav"
            speak(phrase, part)
            with wave.open(str(part)) as w:
                frames.append(w.readframes(w.getnframes()))
            frames.append(silence)
    clean = target.with_suffix(".clean.wav") if through_room else target
    with wave.open(str(clean), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(frames))
    if through_room:
        room(clean, target)
        clean.unlink()
    print(f"wrote {target}{' (through a simulated room)' if through_room else ''}: {', '.join(phrases)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
