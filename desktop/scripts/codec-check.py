#!/usr/bin/env python3
"""Per-codec decode check: the real app's decoders vs an independent decoder.

For every source (each transfer-syntax fixture, the multiframe clip, and each
real pydicom sample file) this opens it in the built app with
FLOWRAD_BENCH_PIXELS=1, takes the decoded-pixel statistics the app reports for
its first image (Cornerstone's WASM codecs, in the WebView), decodes the SAME
file and frame with pydicom (pylibjpeg / OpenJPEG / CharLS / RLE / imagecodecs),
and compares:

  lossless  -> count, min, max and integer sum must match exactly
  lossy     -> count exact; mean within 0.5 % of the range; min/max within 2 %

Usage (Linux: wrap in xvfb-run -a):
  python3 desktop/scripts/codec-check.py <app-binary> <fixtures-dir>
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pydicom

LOSSY = {"1.2.840.10008.1.2.4.50", "1.2.840.10008.1.2.4.51", "1.2.840.10008.1.2.4.91", "1.2.840.10008.1.2.4.81"}


def app_stats(binary: str, source: Path) -> dict:
    env = dict(os.environ, FLOWRAD_BENCH="1", FLOWRAD_BENCH_EXIT="1", FLOWRAD_BENCH_PIXELS="1")
    out = subprocess.run([binary, str(source)], env=env, capture_output=True, text=True, timeout=90).stdout
    line = next((l for l in out.splitlines() if l.startswith(("FLOWRAD_BENCH ", "RADLEARN_BENCH "))), None)
    if not line:
        raise RuntimeError("the app reported nothing (no first paint)")
    report = json.loads(line.split(" ", 1)[1])
    px = report.get("pixels")
    if not px or "error" in px:
        raise RuntimeError(f"no pixel stats: {px}")
    return px


def reference_stats(file: str, frame: int, scaled: bool) -> tuple[dict, str]:
    ds = pydicom.dcmread(file)
    arr = ds.pixel_array
    frames = int(getattr(ds, "NumberOfFrames", 1) or 1)
    if frames > 1:
        arr = arr[frame - 1]
    arr = arr.astype(np.float64)
    if scaled:
        arr = arr * float(getattr(ds, "RescaleSlope", 1) or 1) + float(getattr(ds, "RescaleIntercept", 0) or 0)
    flat = arr.reshape(-1)
    return {"count": flat.size, "min": float(flat.min()), "max": float(flat.max()), "sum": float(flat.sum())}, str(
        ds.file_meta.TransferSyntaxUID
    )


def compare(app: dict, ref: dict, lossy: bool) -> str | None:
    if app["count"] != ref["count"]:
        return f"pixel count {app['count']} != {ref['count']}"
    if not lossy:
        for k in ("min", "max", "sum"):
            if abs(app[k] - ref[k]) > 1e-6:
                return f"{k} {app[k]} != {ref[k]} (lossless must be bit-exact)"
        return None
    span = max(ref["max"] - ref["min"], 1.0)
    mean_diff = abs(app["sum"] - ref["sum"]) / ref["count"]
    if mean_diff > 0.005 * span:
        return f"mean differs by {mean_diff:.3f} (> 0.5% of range {span:.0f})"
    for k in ("min", "max"):
        if abs(app[k] - ref[k]) > 0.02 * span:
            return f"{k} {app[k]} vs {ref[k]} (> 2% of range)"
    return None


def sources(root: Path) -> list[Path]:
    out = sorted(p for p in (root / "ts").iterdir() if p.is_dir())
    if (root / "multiframe").exists():
        out.append(root / "multiframe")
    real = root / "real"
    if real.exists():
        out += sorted(p for p in real.iterdir() if p.is_file() and p.name != "SOURCES.txt")
    return out


def main() -> int:
    binary, root = sys.argv[1], Path(sys.argv[2])
    failures = 0
    for source in sources(root):
        label = source.relative_to(root)
        try:
            app = app_stats(binary, source)
            ref, ts = reference_stats(app["file"], int(app.get("frame", 1)), bool(app.get("scaled")))
            problem = compare(app, ref, ts in LOSSY)
        except Exception as e:  # noqa: BLE001 - every failure is reported, not raised
            problem, ts = str(e), "?"
        mark = "OK  " if problem is None else "FAIL"
        print(f"{mark} {label}  [{ts}]" + ("" if problem is None else f"  {problem}"))
        failures += problem is not None
    print(f"{'all codecs match' if failures == 0 else f'{failures} mismatch(es)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
