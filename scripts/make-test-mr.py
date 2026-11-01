#!/usr/bin/env python3
"""Deterministic synthetic multi-series brain MR for CI perf gates.

    python3 scripts/make-test-mr.py <out-dir> [--size 256] [--codec j2k|none]

Five series in one study, like a routine brain MR: Ax T1 (48), Ax T2 (48),
Ax FLAIR (48), Cor T2 (40) and Sag T1 (32, a different orientation), unsigned
16-bit (12 stored bits). With --codec j2k (default) every frame is JPEG 2000
lossless, so opening it exercises the lazy-loaded WASM decoder path in the web
viewer; the CT fixture (make-test-ct.py) is uncompressed, so together they pin
"codecs load only when a transfer syntax needs them".

Needs pydicom, numpy, and for j2k pylibjpeg + pylibjpeg-openjpeg. UIDs are
derived from a fixed root; synthetic data only, no real patient.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, JPEG2000Lossless, MRImageStorage

ROOT = "1.2.826.0.1.3680043.10.1078.43"

SERIES = [
    # number, description, slices, plane, (csf, grey, white, fat) contrast
    (3, "Ax T1 SE", 48, "ax", (300, 900, 1200, 1800)),
    (4, "Ax T2 TSE", 48, "ax", (2400, 1300, 900, 1100)),
    (5, "Ax FLAIR", 48, "ax", (250, 1400, 1000, 1200)),
    (6, "Cor T2 TSE", 40, "cor", (2400, 1300, 900, 1100)),
    (7, "Sag T1 SE", 32, "sag", (300, 900, 1200, 1800)),
]
ORIENT = {
    "ax": ([1, 0, 0, 0, 1, 0], lambda t: [-120.0, -120.0, t]),
    "cor": ([1, 0, 0, 0, 0, -1], lambda t: [-120.0, t, 120.0]),
    "sag": ([0, 1, 0, 0, 0, -1], lambda t: [t, -120.0, 120.0]),
}


def uid(*parts: object) -> str:
    digest = int(hashlib.sha1("/".join(map(str, parts)).encode()).hexdigest()[:16], 16)
    return f"{ROOT}.{digest}"[:64]


def brain(size: int, z: float, contrast: tuple[int, int, int, int], seed: int) -> np.ndarray:
    csf, grey, white, fat = contrast
    c = size / 2
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    x, y = (xx - c) / c, (yy - c) / c
    scale = max(0.05, 1 - (2 * z - 1) ** 2) ** 0.5  # the head narrows at the poles
    img = np.zeros((size, size), np.float32)
    scalp = (x / (0.82 * scale)) ** 2 + (y / (0.92 * scale)) ** 2 < 1
    img[scalp] = fat
    skull = (x / (0.78 * scale)) ** 2 + (y / (0.88 * scale)) ** 2 < 1
    img[skull] = 80
    cortex = (x / (0.74 * scale)) ** 2 + (y / (0.84 * scale)) ** 2 < 1
    img[cortex] = grey
    wm = (x / (0.6 * scale)) ** 2 + (y / (0.7 * scale)) ** 2 < 1
    img[wm] = white
    for sx in (-0.12, 0.12):
        vent = ((x - sx) / (0.07 * scale + 1e-6)) ** 2 + (y / (0.25 * scale + 1e-6)) ** 2 < 1
        img[vent] = csf
    if 0.4 < z < 0.55:  # a lesion on a few slices
        img[((x - 0.3) / 0.06) ** 2 + ((y + 0.2) / 0.06) ** 2 < 1] = csf * 0.8 + grey * 0.2
    rng = np.random.default_rng(seed)
    img += rng.normal(0, 25, img.shape).astype(np.float32) * (img > 0)
    return np.clip(img, 0, 4095).astype(np.uint16)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("out")
    ap.add_argument("--size", type=int, default=256)
    ap.add_argument("--codec", choices=["j2k", "none"], default="j2k")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    size = args.size
    study, frame = uid("study", size), uid("frame", size)
    spacing = 240.0 / size
    count = 0
    for number, desc, slices, plane, contrast in SERIES:
        series = uid("series", number, size)
        iop, ipp = ORIENT[plane]
        folder = out / f"SE{number:03d}"
        folder.mkdir(exist_ok=True)
        for i in range(slices):
            sop = uid("sop", number, size, i)
            meta = FileMetaDataset()
            meta.MediaStorageSOPClassUID = MRImageStorage
            meta.MediaStorageSOPInstanceUID = sop
            meta.TransferSyntaxUID = ExplicitVRLittleEndian
            meta.ImplementationClassUID = uid("impl")
            ds = Dataset()
            ds.file_meta = meta
            ds.SOPClassUID, ds.SOPInstanceUID = MRImageStorage, sop
            ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
            ds.PatientName, ds.PatientID, ds.PatientSex, ds.PatientAge = "TEST^MR", "CI-0002", "O", "040Y"
            ds.StudyDate = ds.SeriesDate = ds.ContentDate = "20250102"
            ds.StudyTime = ds.SeriesTime = ds.ContentTime = "090000"
            ds.StudyDescription, ds.SeriesDescription = "CI TEST MR BRAIN (SYNTHETIC)", desc
            ds.Modality, ds.Manufacturer = "MR", "FlowRad CI"
            ds.SeriesNumber, ds.InstanceNumber = number, i + 1
            t = -60.0 + 120.0 * i / max(1, slices - 1)
            ds.ImagePositionPatient = ipp(t)
            ds.ImageOrientationPatient = iop
            ds.PixelSpacing = [spacing, spacing]
            ds.SliceThickness = 120.0 / slices
            ds.Rows = ds.Columns = size
            ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
            ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 12, 11, 0
            ds.WindowCenter, ds.WindowWidth = 1000, 2000
            arr = brain(size, i / max(1, slices - 1), contrast, number * 1000 + i)
            ds.PixelData = arr.tobytes()
            if args.codec == "j2k":
                ds.compress(JPEG2000Lossless, arr, encoding_plugin="pylibjpeg")
            ds.save_as(folder / f"IM{i + 1:05d}", enforce_file_format=True)
            count += 1
    print(f"wrote {count} images in {len(SERIES)} series to {out} ({args.codec})")


if __name__ == "__main__":
    main()
