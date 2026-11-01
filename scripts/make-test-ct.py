#!/usr/bin/env python3
"""Deterministic synthetic CT for CI gates (pydicom + numpy only).

    python3 scripts/make-test-ct.py <out-dir> [--slices 60] [--size 512]

A body ellipse with lungs, spine and vessels that change along z, stored as
uncompressed explicit VR little endian, signed 16-bit with HU = stored + 0
(rescale slope 1, intercept 0). UIDs are derived from a fixed root, so every
run writes byte-identical files: the visual baselines and perf budgets in CI
(.github/workflows/web-ci.yml, desktop-ci.yml) depend on that. Public, synthetic
data only.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian

ROOT = "1.2.826.0.1.3680043.10.1078.42"


def uid(*parts: object) -> str:
    """Stable UID under ROOT from the given parts (≤ 64 chars)."""
    digest = int(hashlib.sha1("/".join(map(str, parts)).encode()).hexdigest()[:16], 16)
    return f"{ROOT}.{digest}"[:64]


def phantom(size: int, z: float) -> np.ndarray:
    """One axial slice in HU. z in [0, 1] runs head → feet."""
    c = size / 2
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    x, y = (xx - c) / c, (yy - c) / c
    img = np.full((size, size), -1000, np.float32)  # air
    body = (x / 0.86) ** 2 + (y / 0.62) ** 2 < 1
    img[body] = 40  # soft tissue
    fat = body & ((x / 0.80) ** 2 + (y / 0.56) ** 2 > 1)
    img[fat] = -100
    # Lungs shrink towards the abdomen.
    lung_r = max(0.0, 0.32 * (1.0 - z * 1.3))
    for sx in (-0.38, 0.38):
        lung = ((x - sx) / (lung_r + 1e-6)) ** 2 + ((y + 0.05) / (lung_r * 1.4 + 1e-6)) ** 2 < 1
        img[lung & body] = -850
    # Spine and aorta.
    img[(x / 0.10) ** 2 + ((y - 0.40) / 0.10) ** 2 < 1] = 700
    img[(x / 0.05) ** 2 + ((y - 0.40) / 0.05) ** 2 < 1] = 250  # canal
    img[((x + 0.06) / 0.07) ** 2 + ((y - 0.22) / 0.07) ** 2 < 1] = 180
    # A liver that grows with z, and a nodule on a few slices.
    liver = ((x + 0.35) / 0.40) ** 2 + ((y + 0.05) / 0.35) ** 2 < min(1.0, z * 1.6)
    img[liver & body & (img > -500)] = 60
    if 0.30 < z < 0.36:
        img[((x - 0.30) / 0.04) ** 2 + ((y + 0.10) / 0.04) ** 2 < 1] = 30
    # Ribs: a ring of small bright dots.
    for k in range(14):
        a = np.pi * (0.1 + 0.8 * k / 13)
        rx, ry = 0.80 * np.cos(a), -0.56 * np.sin(a) + 0.02
        img[((x - rx) / 0.035) ** 2 + ((y - ry) / 0.035) ** 2 < 1] = 900
        img[((x - rx) / 0.035) ** 2 + ((y + ry - 0.04) / 0.035) ** 2 < 1] = 900
    # Deterministic noise (seeded by slice) so windowing has texture.
    rng = np.random.default_rng(int(z * 10_000))
    img += rng.normal(0, 6, img.shape).astype(np.float32) * body
    return np.clip(img, -1024, 3071).astype(np.int16)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("out")
    ap.add_argument("--slices", type=int, default=60)
    ap.add_argument("--size", type=int, default=512)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    n, size = args.slices, args.size
    study, series, frame = uid("study", n, size), uid("series", n, size), uid("frame", n, size)
    spacing = 350.0 / size
    thickness = 2.5
    for i in range(n):
        sop = uid("sop", n, size, i)
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CTImageStorage
        meta.MediaStorageSOPInstanceUID = sop
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        meta.ImplementationClassUID = uid("impl")
        ds = Dataset()
        ds.file_meta = meta
        ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, sop
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
        ds.PatientName, ds.PatientID, ds.PatientSex, ds.PatientAge = "TEST^CT", "CI-0001", "O", "050Y"
        ds.StudyDate = ds.SeriesDate = ds.ContentDate = "20250101"
        ds.StudyTime = ds.SeriesTime = ds.ContentTime = "120000"
        ds.StudyDescription, ds.SeriesDescription = "CI TEST CT (SYNTHETIC)", "Axial 2.5mm"
        ds.Modality, ds.Manufacturer = "CT", "FlowRad CI"
        ds.SeriesNumber, ds.InstanceNumber = 2, i + 1
        ds.ImagePositionPatient = [-175.0, -175.0, -thickness * i]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.PixelSpacing = [spacing, spacing]
        ds.SliceThickness = thickness
        ds.Rows = ds.Columns = size
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 1
        ds.RescaleIntercept, ds.RescaleSlope, ds.RescaleType = 0, 1, "HU"
        ds.WindowCenter, ds.WindowWidth = 40, 400
        ds.PixelData = phantom(size, i / max(1, n - 1)).tobytes()
        ds.save_as(out / f"IM{i + 1:05d}.dcm", enforce_file_format=True)
    print(f"wrote {n} slices to {out}")


if __name__ == "__main__":
    main()
