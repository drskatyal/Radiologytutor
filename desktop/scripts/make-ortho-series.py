#!/usr/bin/env python3
"""A coronal reformat of the CT phantom, as its own series in the same study.

    python3 desktop/scripts/make-ortho-series.py <ct-phantom dir> <out dir> [--every 8]

Reads the thin axial series (top level of <ct-phantom dir>), stacks it by
position, and writes coronal slices every N mm with the same Study / Frame of
Reference, so the UI e2e can check reference lines (they only exist between
non-parallel planes) and sync across planes. Synthetic data only.
"""
from __future__ import annotations

import copy
import sys
from pathlib import Path

import numpy as np
import pydicom
from pydicom.uid import generate_uid


def main() -> int:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    every = float(sys.argv[sys.argv.index("--every") + 1]) if "--every" in sys.argv else 8.0
    files = sorted(p for p in src.iterdir() if p.is_file())
    slices = [pydicom.dcmread(p) for p in files]
    slices.sort(key=lambda d: float(d.ImagePositionPatient[2]))
    vol = np.stack([d.pixel_array for d in slices])  # z, y, x (stored values)
    ref = slices[-1]  # most superior: coronal rows run head → feet
    dtype = ref.pixel_array.dtype
    ps = [float(v) for v in ref.PixelSpacing]
    x0, y0 = float(ref.ImagePositionPatient[0]), float(ref.ImagePositionPatient[1])
    zs = np.array([float(d.ImagePositionPatient[2]) for d in slices])
    dz = float(np.median(np.diff(zs)))
    out.mkdir(parents=True, exist_ok=True)
    series_uid = generate_uid(entropy_srcs=["flowrad-e2e-coronal", str(ref.SeriesInstanceUID)])
    step = max(1, int(round(every / ps[1])))
    rows_idx = list(range(step // 2, vol.shape[1], step))
    for n, j in enumerate(rows_idx, start=1):
        img = vol[::-1, j, :]  # superior first
        ds = copy.deepcopy(ref)  # a shallow copy would share (and rewrite) ref's elements
        ds.SOPInstanceUID = generate_uid(entropy_srcs=[series_uid, str(n)])
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
        ds.SeriesInstanceUID = series_uid
        ds.SeriesNumber = 9
        ds.SeriesDescription = "Coronal 8mm (e2e reformat)"
        ds.InstanceNumber = n
        ds.ImageOrientationPatient = [1, 0, 0, 0, 0, -1]
        ds.ImagePositionPatient = [x0, y0 + j * ps[1], float(zs.max())]
        ds.PixelSpacing = [abs(dz), ps[0]]
        ds.SliceThickness = every
        ds.Rows, ds.Columns = img.shape
        ds.PixelData = np.ascontiguousarray(img.astype(dtype)).tobytes()
        for tag in ("SliceLocation",):
            if tag in ds:
                del ds[tag]
        ds.save_as(out / f"COR{n:04d}.dcm", enforce_file_format=True)
    print(f"wrote {len(rows_idx)} coronal slices to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
