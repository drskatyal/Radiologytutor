#!/usr/bin/env python3
"""Fetch the offline voice-command model and package it for both apps.

    python3 scripts/fetch-voice-model.py            # -> public/voice/model.tar.gz, desktop/public/voice/model.tar.gz
    python3 scripts/fetch-voice-model.py --check    # exit 1 if the packaged model is missing

The model (a small English speech model, Apache-2.0) is downloaded once at
build time, verified against a pinned SHA-256, and repackaged as the tar.gz
the in-browser recognizer loads. It ships inside the installer and the web
build: nothing is downloaded at run time. The files are git-ignored.

Set VOICE_MODEL_URL / VOICE_MODEL_SHA256 to override (e.g. a mirror).
"""
from __future__ import annotations

import hashlib
import io
import os
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URL = os.environ.get("VOICE_MODEL_URL", "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip")
# Pinned digest of the zip above; an empty pin prints the digest and fails, so
# a changed upstream file never ships silently.
SHA256 = os.environ.get("VOICE_MODEL_SHA256", (Path(__file__).with_name("voice-model.sha256").read_text().strip() if Path(__file__).with_name("voice-model.sha256").exists() else ""))
OUTPUTS = [ROOT / "public" / "voice" / "model.tar.gz", ROOT / "desktop" / "public" / "voice" / "model.tar.gz"]


def main() -> int:
    if "--check" in sys.argv:
        missing = [str(p) for p in OUTPUTS if not p.exists() or p.stat().st_size < 1_000_000]
        print("voice model present" if not missing else f"voice model missing: {missing}")
        return 1 if missing else 0
    if all(p.exists() and p.stat().st_size > 1_000_000 for p in OUTPUTS) and "--force" not in sys.argv:
        print("voice model already packaged")
        return 0
    print(f"downloading {URL}")
    with urllib.request.urlopen(URL, timeout=120) as response:
        data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if not SHA256:
        print(f"no pinned SHA-256; this download is {digest} (write it to scripts/voice-model.sha256)", file=sys.stderr)
        return 2
    if digest != SHA256:
        print(f"SHA-256 mismatch: got {digest}, pinned {SHA256}", file=sys.stderr)
        return 1
    # The recognizer wants a tar.gz whose single top-level folder is the model.
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as zf, tarfile.open(fileobj=out, mode="w:gz") as tf:
        names = [n for n in zf.namelist() if not n.endswith("/")]
        top = os.path.commonprefix(names).split("/")[0]
        rel = [name[len(top) + 1 :] if top else name for name in names]
        # Every directory needs its own entry: the recognizer persists the
        # extracted model to IndexedDB, and that sync fails ("FS error") for a
        # file whose parent folder was never declared in the archive.
        dirs = sorted({"/".join(r.split("/")[:i]) for r in rel for i in range(1, r.count("/") + 1)})
        for d in ["", *dirs]:
            entry = tarfile.TarInfo(("model/" + d).rstrip("/"))
            entry.type, entry.mode, entry.mtime = tarfile.DIRTYPE, 0o755, 0
            tf.addfile(entry)
        for name in sorted(names):
            info = tarfile.TarInfo("model/" + name[len(top) + 1 :] if top else "model/" + name)
            info.mode = 0o644
            body = zf.read(name)
            info.size = len(body)
            info.mtime = 0
            tf.addfile(info, io.BytesIO(body))
    for path in OUTPUTS:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(out.getvalue())
        print(f"wrote {path} ({len(out.getvalue()) / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
