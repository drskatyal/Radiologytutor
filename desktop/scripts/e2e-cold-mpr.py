#!/usr/bin/env python3
"""End-to-end (P0 regression): MPR on an UNCACHED study must draw.

HP, 0.5.2: on a truly cold open (scan cache and WebView caches cleared) MPR
hung and never drew. Cause: the first-paint self-check sampled the viewport
before the first slice had decoded, read it as "the GPU drew black" and
switched the whole session to CPU rendering, which MPR / 3D cannot use.

This test reproduces the cold path (pre-fix it failed 1 of 2 runs, so it runs 3): the scan cache is
deleted and every file read is slowed (FLOWRAD_SCAN_DELAY_US) so the study is
still streaming in when the first slice paints, then MPR is requested. It
fails unless the volume loads and the session stayed on the GPU path.

Usage (Linux: wrap in xvfb-run -a):
  python3 desktop/scripts/e2e-cold-mpr.py <app-binary> [<study-dir>]
Use a large study (scripts/make-test-ct.py --slices 848): the race needs the
first decode to be slow. Without one, a small CT is generated.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def cache_dir() -> Path:
    app = "app.flowrad.viewer"
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", "")) / app
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / app
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / app


def make_study() -> Path:
    spec = importlib.util.spec_from_file_location("e2e_paint", Path(__file__).with_name("e2e-paint.py"))
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod.make_ct(Path(tempfile.mkdtemp(prefix="flowrad-cold-mpr-")), signed=True)


def main() -> int:
    binary = sys.argv[1]
    study = Path(sys.argv[2]) if len(sys.argv) > 2 else make_study()
    failures = 0
    for attempt in (1, 2, 3):
        shutil.rmtree(cache_dir(), ignore_errors=True)
        env = {
            **os.environ,
            "FLOWRAD_BENCH": "1",
            "FLOWRAD_BENCH_EXIT": "1",
            "FLOWRAD_BENCH_VIEW": "mpr",
            "FLOWRAD_BENCH_TIMEOUT_MS": "90000",
            # Slow every file read so the study is still streaming in when the
            # first slice paints (an 848-slice CT at 8 ms/file reproduced the
            # hang on 2 of 2 runs before the fix).
            "FLOWRAD_SCAN_DELAY_US": os.environ.get("E2E_SCAN_DELAY_US", "8000"),
        }
        proc = subprocess.run([binary, str(study)], env=env, capture_output=True, text=True, timeout=180)
        line = next((l for l in proc.stdout.splitlines() if l.startswith("FLOWRAD_BENCH ")), None)
        report = json.loads(line[len("FLOWRAD_BENCH ") :]) if line else {}
        path = (report.get("viewport") or {}).get("renderPath")
        loaded = report.get("volumeLoadedMs")
        problems = []
        if not line:
            problems.append(f"no report (exit {proc.returncode})")
        if loaded is None:
            problems.append(f"MPR never loaded: {report.get('volumeStuck') or report.get('note')}")
        if path not in ("gpu", None):
            problems.append(f"session fell back to {path} rendering on a cold open: {report.get('fallbackWhy')}")
        status = "OK  " if not problems else "FAIL"
        print(f"{status} cold open #{attempt} -> MPR  render={path}  volumeLoadedMs={loaded}")
        for p in problems:
            print("     " + p)
        failures += bool(problems)
    print("MPR draws on a cold open" if failures == 0 else f"{failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
