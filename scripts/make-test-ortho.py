#!/usr/bin/env python3
"""Synthetic CT with an axial AND a coronal series of one frame of reference.

    python3 scripts/make-test-ortho.py <out-dir> [--slices 40] [--size 128]

The axial series is the phantom of make-test-ct.py; the coronal series is a
reformat of the same volume (rows run head → feet), so the two planes cross
and the viewer's reference lines have something to draw. Same study, same
FrameOfReferenceUID, deterministic UIDs. Public, synthetic data only.
"""
from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian

_spec = importlib.util.spec_from_file_location("make_test_ct", Path(__file__).with_name("make-test-ct.py"))
ct = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ct)  # type: ignore[union-attr]


def write(out: Path, name: str, *, study: str, frame: str, series: str, number: int, desc: str, index: int,
          pixels: np.ndarray, ipp: list[float], iop: list[float], spacing: list[float]) -> None:
    sop = ct.uid("ortho-sop", series, index)
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = ct.uid("impl")
    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, sop
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
    ds.PatientName, ds.PatientID, ds.PatientSex, ds.PatientAge = "TEST^ORTHO", "CI-0003", "O", "050Y"
    ds.StudyDate = ds.SeriesDate = ds.ContentDate = "20250101"
    ds.StudyTime = ds.SeriesTime = ds.ContentTime = "120000"
    ds.StudyDescription, ds.SeriesDescription = "CI TEST CT ORTHO (SYNTHETIC)", desc
    ds.Modality, ds.Manufacturer = "CT", "FlowRad CI"
    ds.SeriesNumber, ds.InstanceNumber = number, index + 1
    ds.ImagePositionPatient = ipp
    ds.ImageOrientationPatient = iop
    ds.PixelSpacing = spacing
    ds.SliceThickness = spacing[0]
    ds.Rows, ds.Columns = pixels.shape
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 1
    ds.RescaleIntercept, ds.RescaleSlope, ds.RescaleType = 0, 1, "HU"
    ds.WindowCenter, ds.WindowWidth = 40, 400
    ds.PixelData = np.ascontiguousarray(pixels, dtype=np.int16).tobytes()
    ds.save_as(out / name, enforce_file_format=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("out")
    ap.add_argument("--slices", type=int, default=40)
    ap.add_argument("--size", type=int, default=128)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    n, size = args.slices, args.size
    study, frame = ct.uid("ortho-study", n, size), ct.uid("ortho-frame", n, size)
    spacing = 350.0 / size
    thickness = 2.5
    volume = np.stack([ct.phantom(size, i / max(1, n - 1)) for i in range(n)])  # (z, y, x)
    axial = ct.uid("ortho-axial", n, size)
    for i in range(n):
        write(out, f"AX{i + 1:04d}.dcm", study=study, frame=frame, series=axial, number=2, desc="Axial", index=i,
              pixels=volume[i], ipp=[-175.0, -175.0, -thickness * i], iop=[1, 0, 0, 0, 1, 0], spacing=[spacing, spacing])
    coronal = ct.uid("ortho-coronal", n, size)
    for j in range(size):
        # Row r is axial slice r (z = −2.5 r, head at the top); columns run along x.
        write(out, f"CO{j + 1:04d}.dcm", study=study, frame=frame, series=coronal, number=3, desc="Coronal", index=j,
              pixels=volume[:, j, :], ipp=[-175.0, -175.0 + spacing * j, 0.0], iop=[1, 0, 0, 0, 0, -1],
              spacing=[thickness, spacing])
    print(f"wrote {n} axial + {size} coronal images to {out}")


if __name__ == "__main__":
    main()
