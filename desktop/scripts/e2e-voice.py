#!/usr/bin/env python3
"""Voice commands in the BUILT app (production CSP, bundled model).

    python desktop/scripts/e2e-voice.py <flowrad-viewer exe> <study dir> <phrases.wav> [--expect "next series" "zoom in" …]

Launches the real app with FLOWRAD_BENCH=1 FLOWRAD_BENCH_VIEW=voice: once the
study's first image is up, the app switches voice on (silent input: the runner
has no microphone), waits for "listening", then feeds the spoken phrases in
<phrases.wav> to the live recognizer through the session's test hook and
performs what it recognises (desktop/src/voiceBench.ts).

Fails unless: the recognizer becomes ready (no error, no endless loading),
model download progress was reported, and at least one spoken command was
recognised. With --expect, EVERY listed phrase must be recognised (heard as
that command, not "?") and performed. 0.6.4-0.8.0 hung here: the recognizer's worker could not run
under the app's CSP, and nothing reported the failure.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time

sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]


def main() -> int:
    if len(sys.argv) < 4:
        print(__doc__)
        return 2
    exe, study, wav = sys.argv[1:4]
    rest = sys.argv[4:]
    expect = rest[rest.index("--expect") + 1 :] if "--expect" in rest else []
    env = {**os.environ, "FLOWRAD_BENCH": "1", "FLOWRAD_BENCH_VIEW": "voice", "FLOWRAD_BENCH_VOICE_WAV": os.path.abspath(wav)}
    env.pop("FLOWRAD_BENCH_EXIT", None)
    proc = subprocess.Popen([exe, study], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    box: dict = {}
    tail: list[str] = []

    def read() -> None:
        assert proc.stdout
        for line in proc.stdout:
            tail.append(line.rstrip())
            del tail[:-40]
            if line.startswith("FLOWRAD_BENCH ") and "r" not in box:
                box["r"] = json.loads(line[len("FLOWRAD_BENCH "):])

    threading.Thread(target=read, daemon=True).start()
    deadline = time.time() + 240
    while "r" not in box and time.time() < deadline and proc.poll() is None:
        time.sleep(0.25)
    proc.kill()
    report = box.get("r")
    if not report:
        print("FAIL  voice: no bench report\n" + "\n".join(tail))
        return 1
    voice = report.get("voice") or {}
    print(json.dumps(voice, indent=2))
    failures = []
    if voice.get("state") not in ("listening", "off") or voice.get("readyMs") is None:
        failures.append(f"the recognizer never became ready: state={voice.get('state')} error={voice.get('error')!r} ({voice.get('errorKind')})")
    if not voice.get("progressEvents"):
        failures.append("no model download progress was reported")
    if not voice.get("actions"):
        failures.append(f"no spoken command was recognised (heard: {voice.get('heard')})")
    recognised = [h.strip().lower() for h in voice.get("heard") or [] if not h.rstrip().endswith("?")]
    for phrase in expect:
        # Whole phrases only (voiceCommands.ts): the recognised utterance IS the phrase.
        if not any(phrase.lower() == h for h in recognised):
            failures.append(f"'{phrase}' was not recognised (heard: {voice.get('heard')})")
    for f in failures:
        print(f"FAIL  voice: {f}")
    if failures:
        return 1
    print(f"PASS  voice: ready in {voice['readyMs']} ms under the production CSP; recognised {voice['heard']} -> {voice['actions']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
