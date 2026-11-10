#!/usr/bin/env python3
"""From a synthetic CT (scripts/make-test-ct.py), write three studies for the
current-vs-prior hanging e2e:

    current/  the CT as is (the newest study)
    prior/    the same patient a year earlier: new study / series / SOP UIDs,
              and less coverage at the top (the first 8 images dropped)
    other/    another patient's earlier study (must never hang as a prior)

    python3 scripts/make-test-prior.py <make-test-ct dir> <out-dir>

Public, synthetic data only."""
import sys, pathlib, pydicom

src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
files = sorted(src.iterdir())
specs = [
    ("current", None, None, 0),
    ("prior", "20240105", None, 8),
    ("other", "20240105", "CI-0002", 0),
]
for name, date, patient, skip in specs:
    folder = out / name
    folder.mkdir(parents=True, exist_ok=True)
    for i, f in enumerate(files[skip:]):
        ds = pydicom.dcmread(f)
        if name != "current":
            tag = "8" if name == "prior" else "9"
            ds.StudyInstanceUID = f"{ds.StudyInstanceUID[:58]}.{tag}"
            ds.SeriesInstanceUID = f"{ds.SeriesInstanceUID[:58]}.{tag}"
            ds.SOPInstanceUID = f"{ds.SOPInstanceUID[:58]}.{tag}"
            ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
            ds.StudyDate = date
            ds.SeriesDate = date
            ds.InstanceNumber = i + 1
            if patient:
                ds.PatientID = patient
                ds.PatientName = "SYNTHETIC^OTHER"
        ds.save_as(folder / f"{name}_{i:03d}.dcm")
