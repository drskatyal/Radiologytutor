#!/usr/bin/env python3
"""End-to-end: does a NORMAL launch with a study on the command line put real
pixels in the main viewport, and keep them there?

Launches the built app the way a user does (a study path as the argument, no
bench hooks), waits FLOWRAD_PROBE_AFTER_MS, and reads back what every viewport
holding a series shows on screen. Fails if any of them is blank.

Each source runs twice: a plain launch (the reported Windows bug: thumbnails
fine, main viewport grey then black) and a bench launch, whose report must
also say `viewport.nonBlank`.

Usage (Linux: wrap in xvfb-run -a; Windows: run from a desktop session):
  python3 desktop/scripts/e2e-paint.py <app-binary> [<study-dir> ...]
With no study, it writes two small CT series (unsigned, and signed with a
negative rescale) with pydicom and opens those.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def make_ct(root: Path, signed: bool) -> Path:
    import numpy as np
    import pydicom
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

    out = root / ("ct-signed" if signed else "ct-unsigned")
    out.mkdir(parents=True, exist_ok=True)
    study, series = generate_uid(), generate_uid()
    yy, xx = np.mgrid[0:256, 0:256]
    body = (xx - 128) ** 2 + (yy - 128) ** 2 < 100**2
    for i in range(40):
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CTImageStorage
        meta.MediaStorageSOPInstanceUID = sop = generate_uid()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = Dataset()
        ds.file_meta = meta
        ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, sop
        ds.StudyInstanceUID, ds.SeriesInstanceUID = study, series
        ds.PatientName, ds.PatientID, ds.Modality = "E2E^Paint", "E2E", "CT"
        ds.SeriesNumber, ds.InstanceNumber = 1, i + 1
        ds.ImagePositionPatient = [-128, -128, -i * 2.5]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.PixelSpacing, ds.SliceThickness = [1, 1], 2.5
        ds.Rows = ds.Columns = 256
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 12, 11
        ds.WindowCenter, ds.WindowWidth = 40, 400
        if signed:
            ds.PixelRepresentation, ds.RescaleIntercept, ds.RescaleSlope = 1, 0, 1
            px = np.where(body, 60 + (xx % 40), -1000).astype(np.int16)
        else:
            ds.PixelRepresentation, ds.RescaleIntercept, ds.RescaleSlope = 0, -1024, 1
            px = np.where(body, 1024 + 60 + (xx % 40), 24).astype(np.uint16)
        ds.PixelData = px.tobytes()
        ds.save_as(out / f"IM{i:04d}.dcm", enforce_file_format=True)
    return out


def make_mr(root: Path) -> Path:
    """Unsigned 16-bit MR (BitsStored 16, values 0-950, no rescale): the kind
    of series that drew on the non-GPU path on the HP (0.6.0 MRI)."""
    import numpy as np
    import pydicom
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, MRImageStorage, generate_uid

    out = root / "mr-u16"
    out.mkdir(parents=True, exist_ok=True)
    study, series = generate_uid(), generate_uid()
    yy, xx = np.mgrid[0:256, 0:256]
    head = (xx - 128) ** 2 + (yy - 128) ** 2 < 100**2
    for i in range(27):
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = MRImageStorage
        meta.MediaStorageSOPInstanceUID = sop = generate_uid()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = Dataset()
        ds.file_meta = meta
        ds.SOPClassUID, ds.SOPInstanceUID = MRImageStorage, sop
        ds.StudyInstanceUID, ds.SeriesInstanceUID = study, series
        ds.PatientName, ds.PatientID, ds.Modality = "E2E^Paint", "E2E", "MR"
        ds.SeriesNumber, ds.InstanceNumber = 1, i + 1
        ds.ImagePositionPatient = [-128, -128, -i * 5.0]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.PixelSpacing, ds.SliceThickness = [1, 1], 5.0
        ds.Rows = ds.Columns = 256
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 16, 15
        ds.PixelRepresentation = 0
        ds.WindowCenter, ds.WindowWidth = 600, 1200
        ds.PixelData = np.where(head, 650 + (xx % 300), 0).astype(np.uint16).tobytes()
        ds.save_as(out / f"MR{i:04d}.dcm", enforce_file_format=True)
    return out


def run(binary: str, study: Path, env: dict[str, str], prefix: str, timeout: int = 120) -> dict:
    proc = subprocess.run(
        [binary, str(study)], env={**os.environ, **env}, capture_output=True, text=True, timeout=timeout
    )
    line = next((l for l in proc.stdout.splitlines() if l.startswith(prefix + " ")), None)
    if not line:
        raise RuntimeError(f"no {prefix} line (exit {proc.returncode})")
    return json.loads(line[len(prefix) + 1 :])


def main() -> int:
    binary = sys.argv[1]
    studies = [Path(p) for p in sys.argv[2:]]
    if not studies:
        root = Path(tempfile.mkdtemp(prefix="radlearn-e2e-"))
        studies = [make_ct(root, signed=False), make_ct(root, signed=True), make_mr(root)]
    failures = 0
    for study in studies:
        try:
            probe = run(binary, study, {"FLOWRAD_PROBE_AFTER_MS": "8000"}, "FLOWRAD_PROBE")
            bench = run(binary, study, {"FLOWRAD_BENCH": "1", "FLOWRAD_BENCH_EXIT": "1"}, "FLOWRAD_BENCH")
            vp = bench.get("viewport") or {}
            problems = []
            if not probe.get("nonBlank"):
                problems.append(f"normal launch: blank viewport {probe.get('viewports')}")
            if not vp.get("nonBlank"):
                problems.append(f"bench launch: blank viewport {vp}")
            # A driver that draws black: the CPU fallback must have the image
            # on screen by the same probe time.
            blank = run(binary, study, {"FLOWRAD_PROBE_AFTER_MS": "8000", "FLOWRAD_SIMULATE_BLANK_GPU": "1"}, "FLOWRAD_PROBE")
            if not blank.get("nonBlank") or blank.get("renderPath") != "cpu-fallback":
                problems.append(
                    f"black GPU: fallback not on screen by 8 s (render={blank.get('renderPath')}, viewports={blank.get('viewports')})"
                )
            status = "OK  " if not problems else "FAIL"
            path = probe.get("renderPath") or vp.get("renderPath")
            print(f"{status} {study.name}  render={path}  maxLum={[v.get('maxLum') for v in probe.get('viewports', [])]}")
            for p in problems:
                print("     " + p)
            failures += bool(problems)
        except Exception as e:  # noqa: BLE001 - every failure is reported
            print(f"FAIL {study.name}  {e}")
            failures += 1
    print("viewport paints on every launch" if failures == 0 else f"{failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
