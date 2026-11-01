#!/usr/bin/env python3
"""Large deterministic synthetic studies for the real-size e2e gates.

    python3 scripts/make-big-study.py ct  <out-dir> [--slices 4332] [--size 512]
    python3 scripts/make-big-study.py mri <out-dir> [--images 10310] [--size 256]

CT: one axial series of the make-test-ct.py body phantom (spine, ribs, lungs,
liver), thin slices, signed 16-bit HU, explicit VR little endian. The HP CT
the gates are about has 4,332 images.

MRI: one study of many series whose image counts add up to --images (the HP
MRI has 10,310): a large isotropic 3D series (the MPR / 3D target, 1 mm,
sagittal acquisition) plus 2D axial / coronal / sagittal series, all of the
same head-shaped phantom in MR-like unsigned intensities.

Every file is byte-identical across runs (UIDs from a fixed root), written on
all cores, so CI can cache the output by this script's hash. Public,
synthetic data only.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, MRImageStorage

ROOT = "1.2.826.0.1.3680043.10.1078.43"


def uid(*parts: object) -> str:
    digest = int(hashlib.sha1("/".join(map(str, parts)).encode()).hexdigest()[:16], 16)
    return f"{ROOT}.{digest}"[:64]


def _ct_phantom():
    spec = importlib.util.spec_from_file_location("mtc", Path(__file__).with_name("make-test-ct.py"))
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod.phantom


def head(size: int, x0: float, y0: float, z: float) -> np.ndarray:
    """MR-like head phantom on a plane; (x0, y0) are the in-plane axes in [-1, 1]."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    a, b = (xx / size) * 2 - 1, (yy / size) * 2 - 1
    # Map the plane's axes into head coordinates.
    x, y, zz = a * x0 + z * (1 - abs(x0)), b * y0 + z * (1 - abs(y0)), z
    r = np.sqrt(x ** 2 + y ** 2 + (zz * 1.2) ** 2)
    img = np.zeros((size, size), np.float32)
    img[r < 0.85] = 900  # scalp / fat: bright on T1
    img[r < 0.78] = 300  # skull: dark
    img[r < 0.72] = 650  # grey matter
    img[r < 0.55] = 800  # white matter
    ventricles = ((x / 0.10) ** 2 + (y / 0.25) ** 2 + (zz / 0.30) ** 2) < 1
    img[ventricles] = 150  # CSF: dark on T1
    rng = np.random.default_rng(int((z + 2) * 10_000) + size)
    img += rng.normal(0, 12, img.shape).astype(np.float32) * (img > 0)
    return np.clip(img, 0, 4095).astype(np.uint16)


def write(path: Path, meta_sop: str, ds: Dataset, pixels: np.ndarray) -> None:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = meta_sop
    meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta = meta
    ds.SOPClassUID = meta_sop
    ds.Rows, ds.Columns = pixels.shape
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 16, 15
    ds.PixelData = pixels.tobytes()
    ds.save_as(path, enforce_file_format=True)


def ct_slice(job: tuple[str, int, int, int]) -> None:
    out, i, n, size = job
    phantom = _ct_phantom()
    z = i / max(1, n - 1)
    thickness = 0.625
    ds = Dataset()
    ds.SOPInstanceUID = uid("ct", "sop", n, i)
    ds.StudyInstanceUID, ds.SeriesInstanceUID = uid("ct", "study", n), uid("ct", "series", n)
    ds.FrameOfReferenceUID = uid("ct", "frame", n)
    ds.PatientName, ds.PatientID, ds.Modality = "Synthetic^BigCT", "SYN-BIGCT", "CT"
    ds.StudyDescription, ds.SeriesDescription = "Synthetic large CT", f"Axial {thickness} mm"
    ds.SeriesNumber, ds.InstanceNumber = 2, i + 1
    spacing = 350.0 / size
    ds.PixelSpacing, ds.SliceThickness = [spacing, spacing], thickness
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.ImagePositionPatient = [-175.0, -175.0, -i * thickness]
    ds.PixelRepresentation, ds.RescaleIntercept, ds.RescaleSlope = 1, 0, 1
    ds.WindowCenter, ds.WindowWidth = 40, 400
    write(Path(out) / f"CT{i:05d}.dcm", CTImageStorage, ds, phantom(size, z))


def mr_slice(job: tuple[str, int, str, int, int, float, int]) -> None:
    out, s, plane, i, n, thickness, size = job
    t = i / max(1, n - 1) * 2 - 1  # -1..1 through the head
    ds = Dataset()
    ds.SOPInstanceUID = uid("mr", "sop", s, i)
    ds.StudyInstanceUID, ds.SeriesInstanceUID = uid("mr", "study"), uid("mr", "series", s)
    ds.FrameOfReferenceUID = uid("mr", "frame")
    ds.PatientName, ds.PatientID, ds.Modality = "Synthetic^BigMR", "SYN-BIGMR", "MR"
    ds.StudyDescription = "Synthetic large MRI"
    ds.SeriesDescription = f"{'3D T1 ' if s == 1 else ''}{plane} {thickness:g} mm (series {s})"
    ds.SeriesNumber, ds.InstanceNumber = s, i + 1
    fov = 220.0
    ds.PixelSpacing, ds.SliceThickness = [fov / size, fov / size], thickness
    if plane == "sagittal":
        ds.ImageOrientationPatient = [0, 1, 0, 0, 0, -1]
        ds.ImagePositionPatient = [t * n * thickness / 2, -fov / 2, fov / 2]
        px = head(size, 1.0, 1.0, t)
    elif plane == "coronal":
        ds.ImageOrientationPatient = [1, 0, 0, 0, 0, -1]
        ds.ImagePositionPatient = [-fov / 2, t * n * thickness / 2, fov / 2]
        px = head(size, 1.0, 1.0, t)
    else:
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.ImagePositionPatient = [-fov / 2, -fov / 2, t * n * thickness / 2]
        px = head(size, 1.0, 1.0, t)
    ds.PixelRepresentation = 0
    ds.WindowCenter, ds.WindowWidth = 600, 1200
    folder = Path(out) / f"S{s:03d}"
    folder.mkdir(parents=True, exist_ok=True)
    write(folder / f"MR{i:05d}.dcm", MRImageStorage, ds, px)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("kind", choices=["ct", "mri"])
    ap.add_argument("out")
    ap.add_argument("--slices", type=int, default=4332)
    ap.add_argument("--images", type=int, default=10310)
    ap.add_argument("--size", type=int, default=0)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    workers = max(1, (os.cpu_count() or 2))
    if args.kind == "ct":
        size = args.size or 512
        jobs = [(str(out), i, args.slices, size) for i in range(args.slices)]
        with ProcessPoolExecutor(workers) as pool:
            list(pool.map(ct_slice, jobs, chunksize=32))
        print(f"wrote {args.slices} CT slices ({size}²) to {out}")
        return
    size = args.size or 256
    # Series plan: one 3D isotropic series (the MPR / 3D target), then 2D series
    # of 24-60 images cycling planes, until the total is reached.
    plan: list[tuple[int, str, int, float]] = [(1, "sagittal", 192, 1.0)]
    total, s = 192, 2
    planes = ["axial", "coronal", "sagittal"]
    while total < args.images:
        n = min(24 + (s * 7) % 37, args.images - total)
        plan.append((s, planes[s % 3], n, 5.0))
        total += n
        s += 1
    jobs = [(str(out), s, plane, i, n, th, size) for s, plane, n, th in plan for i in range(n)]
    with ProcessPoolExecutor(workers) as pool:
        list(pool.map(mr_slice, jobs, chunksize=64))
    print(f"wrote {total} MR images in {len(plan)} series ({size}²) to {out}; 3D series: S001 (192 sagittal, 1 mm)")


if __name__ == "__main__":
    main()
