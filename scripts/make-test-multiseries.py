#!/usr/bin/env python3
"""Copy a synthetic CT (scripts/make-test-ct.py) into six series with their own
numbers, descriptions and windows, for the series-panel / thumbnail e2e.

    python3 scripts/make-test-multiseries.py <make-test-ct dir> <out-dir>

Public, synthetic data only."""
import sys, pathlib, pydicom
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
specs = [(2, "Axial soft tissue", None), (3, "Axial lung", (-600, 1500)), (4, "Axial bone", (400, 1800)), (5, "Scout-ish", None), (6, "Thin recon", None), (7, "Delayed", None)]
for n, desc, win in specs:
    for i, f in enumerate(sorted(src.iterdir())):
        ds = pydicom.dcmread(f)
        ds.SeriesInstanceUID = f"{ds.SeriesInstanceUID[:50]}.{n}"
        ds.SOPInstanceUID = f"{ds.SOPInstanceUID[:55]}.{n}"
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
        ds.SeriesNumber = n
        ds.SeriesDescription = desc
        if win:
            ds.WindowCenter, ds.WindowWidth = win
        ds.save_as(out / f"s{n}_{i:03d}.dcm")
