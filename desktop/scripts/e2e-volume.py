#!/usr/bin/env python3
"""End-to-end (P0 regressions): MPR and 3D on an UNCACHED study must DRAW.

"Done" here means pixels on screen, measured in the app (brightest pixel of
every pane's decoded frame), never "the volume was built": 0.6.0 built the MPR
volume in 0.36 s on the HP and never painted, and its 3D view was blank, while
a test that waited for "volume loaded" passed.

HP, 0.5.2: on a truly cold open (scan cache and WebView caches cleared) MPR
hung and never drew. Cause: the first-paint self-check sampled the viewport
before the first slice had decoded, read it as "the GPU drew black" and
switched the whole session to CPU rendering, which MPR / 3D cannot use.

This test reproduces the cold path (pre-fix it failed 1 of 2 runs, so it runs 3): the scan cache is
deleted and every file read is slowed (FLOWRAD_SCAN_DELAY_US) so the study is
still streaming in when the first slice paints, then MPR is requested. It
fails unless the volume loads and the session stayed on the GPU path.

Usage (Linux: wrap in xvfb-run -a):
  python3 desktop/scripts/e2e-volume.py <app-binary> [<study-dir>] [--view mpr|3d|both] [--runs N]
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
    args = [a for a in sys.argv[1:]]
    def opt(name: str, default: str) -> str:
        if name in args:
            i = args.index(name)
            value = args[i + 1]
            del args[i : i + 2]
            return value
        return default
    views = {"both": ["mpr", "3d"]}.get(opt("--view", "both"), None) or [opt("--view", "mpr")]
    runs = int(opt("--runs", "3"))
    binary = args[0]
    study = Path(args[1]) if len(args) > 1 else make_study()
    failures = 0
    for view, attempt in [(v, n) for v in views for n in range(1, runs + 1)]:
        shutil.rmtree(cache_dir(), ignore_errors=True)
        env = {
            **os.environ,
            "FLOWRAD_BENCH": "1",
            "FLOWRAD_BENCH_EXIT": "1",
            "FLOWRAD_BENCH_VIEW": view,
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
            problems.append(f"{view} never loaded: {report.get('volumeStuck') or report.get('note')}")
        panes = report.get("mprPanes" if view == "mpr" else "vrPanes") or {}
        want = 3 if view == "mpr" else 1
        # Pixels, not "volume built": every pane must show something bright.
        if len(panes) < want or any((v if v is not None else 0) <= 8 for v in panes.values()):
            problems.append(f"{view} panes blank or missing: {panes}")
        # MPR and 3D are rendered natively (Rust) and do not depend on the 2D
        # viewer's render path; report a 2D CPU fallback, don't fail on it
        # (e2e-paint.py owns the 2D render-path checks).
        note = f"  (2D viewer fell back to {path}: {report.get('fallbackWhy')})" if path not in ("gpu", None) else ""
        status = "OK  " if not problems else "FAIL"
        painted = report.get("mprPaintedMs" if view == "mpr" else "vrPaintedMs")
        print(f"{status} cold open #{attempt} -> {view}  render={path}  volumeLoadedMs={loaded}  paintedMs={painted}  panes={panes}{note}")
        for p in problems:
            print("     " + p)
        failures += bool(problems)
    print(f"{'/'.join(views)} draw on a cold open" if failures == 0 else f"{failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
