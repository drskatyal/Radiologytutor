#!/usr/bin/env python3
"""Deterministic synthetic PET/CT for the fusion gates (pydicom + numpy only).

    python3 scripts/make-test-petct.py <out-dir> [--slices 48]

One study, two series on one frame of reference:

  CT  256 x 256, 3 mm slices, HU (the body phantom of make-test-ct.py, smaller).
  PT  128 x 128 over the same field of view and z range, units BQML, decay
      corrected to the series start, with the dose, half-life, injection time
      and weight that SUVbw needs. Activity is written so that SUVbw is exactly
      1.0 in soft tissue, 2.5 in the liver and 8.0 in one hot lesion (the
      e2e test reads these back).

Fixed UIDs, so every run writes byte-identical files. Synthetic data only:
the patient name and ID are obvious test values.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, PositronEmissionTomographyImageStorage

ROOT = "1.2.826.0.1.3680043.10.1078.43"
FOV_MM = 350.0
SLICE_MM = 3.0
# SUVbw = activity (Bq/ml) x weight (g) / dose decayed to the series start.
WEIGHT_KG = 75.0
DOSE_BQ = 370e6
HALF_LIFE_S = 6586.2  # F-18
UPTAKE_S = 3600.0  # injection 11:00:00, series 12:00:00
DECAYED_DOSE = DOSE_BQ * 2 ** (-UPTAKE_S / HALF_LIFE_S)
BQML_PER_SUV = DECAYED_DOSE / (WEIGHT_KG * 1000.0)
LESION_SUV, LIVER_SUV, TISSUE_SUV = 8.0, 2.5, 1.0


def uid(*parts: object) -> str:
    digest = int(hashlib.sha1("/".join(map(str, parts)).encode()).hexdigest()[:16], 16)
    return f"{ROOT}.{digest}"[:64]


def grid(size: int):
    c = size / 2
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    return (xx + 0.5 - c) / c, (yy + 0.5 - c) / c


def masks(size: int, z: float):
    x, y = grid(size)
    body = (x / 0.86) ** 2 + (y / 0.62) ** 2 < 1
    lung_r = max(0.0, 0.32 * (1.0 - z * 1.3))
    lungs = np.zeros_like(body)
    for sx in (-0.38, 0.38):
        lungs |= ((x - sx) / (lung_r + 1e-6)) ** 2 + ((y + 0.05) / (lung_r * 1.4 + 1e-6)) ** 2 < 1
    liver = (((x + 0.35) / 0.40) ** 2 + ((y + 0.05) / 0.35) ** 2 < min(1.0, z * 1.6)) & body & ~lungs
    # A 2 cm-ish sphere in the right chest, centred at z = 0.4.
    dz = (z - 0.4) / 0.06
    lesion = ((x - 0.30) / 0.07) ** 2 + ((y + 0.10) / 0.07) ** 2 + dz**2 < 1
    return body, lungs & body, liver, lesion & body


def ct_slice(size: int, z: float) -> np.ndarray:
    body, lungs, liver, lesion = masks(size, z)
    x, y = grid(size)
    img = np.full((size, size), -1000, np.float32)
    img[body] = 40
    img[lungs] = -850
    img[liver] = 60
    img[lesion] = 35
    img[(x / 0.10) ** 2 + ((y - 0.40) / 0.10) ** 2 < 1] = 700
    return img.astype(np.int16)


def pt_slice(size: int, z: float) -> np.ndarray:
    body, lungs, liver, lesion = masks(size, z)
    suv = np.zeros((size, size), np.float32)
    suv[body] = TISSUE_SUV
    suv[lungs] = 0.3
    suv[liver] = LIVER_SUV
    suv[lesion] = LESION_SUV
    return np.round(suv * BQML_PER_SUV).astype(np.uint16)  # slope 1: stored = Bq/ml


def common(ds: Dataset, study: str, frame: str) -> None:
    ds.StudyInstanceUID, ds.FrameOfReferenceUID = study, frame
    ds.PatientName, ds.PatientID, ds.PatientSex, ds.PatientAge = "TEST^PETCT", "CI-0002", "O", "060Y"
    ds.PatientWeight = WEIGHT_KG
    ds.StudyDate = ds.SeriesDate = ds.AcquisitionDate = ds.ContentDate = "20250101"
    ds.StudyTime = ds.SeriesTime = ds.AcquisitionTime = ds.ContentTime = "120000"
    ds.StudyDescription, ds.Manufacturer = "CI TEST PET-CT (SYNTHETIC)", "FlowRad CI"
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.SliceThickness = SLICE_MM
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 16, 15


def write(out: Path, name: str, ds: Dataset, sop_class: str) -> None:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = sop_class
    meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = uid("impl")
    ds.file_meta = meta
    ds.save_as(out / name, enforce_file_format=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("out")
    ap.add_argument("--slices", type=int, default=48)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    n = args.slices
    study, frame = uid("study", n), uid("frame", n)
    for kind, size in (("CT", 256), ("PT", 128)):
        series = uid("series", kind, n)
        spacing = FOV_MM / size
        for i in range(n):
            z = i / max(1, n - 1)
            ds = Dataset()
            common(ds, study, frame)
            ds.SeriesInstanceUID, ds.SOPInstanceUID = series, uid("sop", kind, n, i)
            ds.Modality, ds.InstanceNumber = kind, i + 1
            ds.ImagePositionPatient = [-FOV_MM / 2, -FOV_MM / 2, -SLICE_MM * i]
            ds.PixelSpacing = [spacing, spacing]
            ds.Rows = ds.Columns = size
            if kind == "CT":
                ds.SOPClassUID = CTImageStorage
                ds.SeriesNumber, ds.SeriesDescription = 2, "CT Axial 3mm"
                ds.PixelRepresentation = 1
                ds.RescaleIntercept, ds.RescaleSlope, ds.RescaleType = 0, 1, "HU"
                ds.WindowCenter, ds.WindowWidth = 40, 400
                ds.PixelData = ct_slice(size, z).tobytes()
            else:
                ds.SOPClassUID = PositronEmissionTomographyImageStorage
                ds.SeriesNumber, ds.SeriesDescription = 3, "PET AC"
                ds.PixelRepresentation = 0
                ds.RescaleIntercept, ds.RescaleSlope = 0, 1
                ds.Units, ds.DecayCorrection = "BQML", "START"
                ds.CorrectedImage = ["ATTN", "DECY"]
                ds.SeriesType = ["WHOLE BODY", "IMAGE"]
                ds.ImageIndex = i + 1
                ds.NumberOfSlices = n
                ds.FrameReferenceTime = 0
                ds.ActualFrameDuration = 120000
                info = Dataset()
                info.Radiopharmaceutical = "Fluorodeoxyglucose"
                info.RadiopharmaceuticalStartTime = "110000"
                info.RadiopharmaceuticalStartDateTime = "20250101110000"
                info.RadionuclideTotalDose = DOSE_BQ
                info.RadionuclideHalfLife = HALF_LIFE_S
                ds.RadiopharmaceuticalInformationSequence = Sequence([info])
                ds.PixelData = pt_slice(size, z).tobytes()
            write(out, f"{kind}{i + 1:05d}.dcm", ds, ds.SOPClassUID)
    print(f"wrote {n} CT + {n} PT slices to {out} (1 SUV = {BQML_PER_SUV:.1f} Bq/ml)")


if __name__ == "__main__":
    main()
