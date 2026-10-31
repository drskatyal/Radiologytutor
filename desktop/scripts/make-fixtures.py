#!/usr/bin/env python3
"""
make-fixtures.py — reproducible DICOM fixture generator for the FlowRad desktop viewer.

Generates a deterministic set of synthetic (and a few real, downloaded) DICOM Part 10
files used by the desktop viewer's tests, benchmarks and marketing screenshots:

  ct-phantom/            CT CAP torso phantom, 512x512x300 @ 0.7 x 0.7 x 1.0 mm (series 2)
  ct-phantom/axial-5mm/  same study, 5 mm slab-averaged reformat, 60 slices (series 3)
  pet-phantom/           F-18 FDG PET, same study + frame of reference as the CT (series 4)
  mr-brain/              small synthetic T1-ish brain MR, separate study
  ts/<syntax>/           20-slice CT subset re-encoded in every common transfer syntax
  multiframe/US_cine.dcm ultrasound multi-frame cine (40 frames, 30 fps)
  cd-media/              DICOMDIR + DICOM/STxxxxxx/SExxxxxx/IMxxxxxx CD-R layout (+ junk files)
  archives/study.zip     zip of cd-media
  real/                  real pydicom test files (downloaded, pinned refs)
  bench/ct-1200/         (--bench) 1200-slice uncompressed CT for scan/open benchmarks
  MANIFEST.md            per-folder file counts, sizes, transfer syntaxes, verification

Everything synthetic is deterministic: fixed RNG seed, fixed dates, and UIDs derived from
a hash of (seed, name) under the 2.25 (UUID-derived) root, so re-running produces the
same UIDs and the same pixel data.

Requirements:
  python3 -m pip install pydicom numpy scipy pylibjpeg pylibjpeg-openjpeg \
      pylibjpeg-libjpeg pylibjpeg-rle pyjpegls imagecodecs
  apt: dcmtk (dcmcjpeg, dcmmkdir, dcmdump)

Usage:
  python3 scripts/make-fixtures.py [OUT_DIR] [--bench] [--no-download] [--seed N]
  (OUT_DIR defaults to ./fixtures)
"""
from __future__ import annotations

import argparse
import hashlib
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

try:
    import pydicom
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.encaps import encapsulate
    from pydicom.sequence import Sequence
    from pydicom import uid as U
except ImportError:  # pragma: no cover
    sys.exit("pydicom>=3 is required: python3 -m pip install pydicom")

try:
    from scipy import ndimage
except ImportError:  # pragma: no cover
    sys.exit("scipy is required: python3 -m pip install scipy")

GENERATOR = "FlowRad make-fixtures.py v1"
IMPL_VERSION = "FLOWRAD_FIX_1"
SEED = 20240115

# --------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def make_uid(name: str) -> str:
    """Deterministic UID under the 2.25 root, derived from (seed, name)."""
    return U.generate_uid(prefix=None, entropy_srcs=[f"flowrad-fixtures/{SEED}", name])


def which_or_die(tool: str) -> str:
    p = shutil.which(tool)
    if not p:
        sys.exit(f"required tool '{tool}' not found on PATH (apt install dcmtk)")
    return p


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def ds_str(v: float, nd: int = 6) -> str:
    """Format a float for a DS element (max 16 chars)."""
    s = f"{v:.{nd}f}".rstrip("0").rstrip(".")
    if s in ("-0", ""):
        s = "0"
    while len(s) > 16:
        nd -= 1
        s = f"{v:.{nd}f}".rstrip("0").rstrip(".")
    return s


def new_file_ds(sop_class: str, sop_uid: str, ts: str = U.ExplicitVRLittleEndian) -> Dataset:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = sop_class
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = ts
    meta.ImplementationClassUID = U.PYDICOM_IMPLEMENTATION_UID
    meta.ImplementationVersionName = IMPL_VERSION
    ds = Dataset()
    ds.file_meta = meta
    ds.preamble = b"\0" * 128
    ds.SpecificCharacterSet = "ISO_IR 100"
    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = sop_uid
    return ds


def save(ds: Dataset, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ds.save_as(path, enforce_file_format=True)


# --------------------------------------------------------------------------------------
# Patients / studies
# --------------------------------------------------------------------------------------

@dataclass
class Study:
    key: str
    patient_name: str
    patient_id: str
    description: str
    date: str
    time: str
    accession: str
    birth_date: str = "19700101"
    sex: str = "O"
    age: str = "054Y"
    weight: str = "75"
    size: str = "1.75"
    study_uid: str = field(init=False)
    study_id: str = "1"

    def __post_init__(self) -> None:
        self.study_uid = make_uid(f"study/{self.key}")

    def apply(self, ds: Dataset) -> None:
        ds.PatientName = self.patient_name
        ds.PatientID = self.patient_id
        ds.PatientBirthDate = self.birth_date
        ds.PatientSex = self.sex
        ds.PatientAge = self.age
        ds.PatientWeight = self.weight
        ds.PatientSize = self.size
        ds.StudyInstanceUID = self.study_uid
        ds.StudyDate = self.date
        ds.StudyTime = self.time
        ds.StudyID = self.study_id
        ds.AccessionNumber = self.accession
        ds.ReferringPhysicianName = "FIXTURE^REFERRER"
        ds.StudyDescription = self.description
        ds.InstitutionName = "FlowRad Synthetic Imaging Lab"
        ds.Manufacturer = "FlowRad"
        ds.ManufacturerModelName = "Fixture Generator"
        ds.SoftwareVersions = GENERATOR
        ds.DeviceSerialNumber = "FIX-0001"
        ds.StationName = "FIXTURES"
        ds.PatientIdentityRemoved = "YES"
        ds.DeidentificationMethod = "Synthetic phantom - no real patient data"


CT_STUDY = Study("ct-cap", "PHANTOM^CT", "FIX-001", "CT CHEST ABDOMEN PELVIS (PHANTOM)",
                 "20240115", "093000", "FIXACC001")
TS_STUDY = Study("ts-matrix", "PHANTOM^CT", "FIX-001", "TRANSFER SYNTAX MATRIX (PHANTOM)",
                 "20240116", "101500", "FIXACC002", study_id="2")
MR_STUDY = Study("mr-brain", "PHANTOM^MR", "FIX-002", "MR BRAIN WO (PHANTOM)",
                 "20240117", "141000", "FIXACC003", age="041Y", weight="70")
US_STUDY = Study("us-cine", "PHANTOM^US", "FIX-003", "US ABDOMEN CINE (PHANTOM)",
                 "20240118", "080500", "FIXACC004", age="033Y", weight="68")
BENCH_STUDY = Study("bench-1200", "PHANTOM^BENCH", "FIX-004", "CT BENCHMARK 1200 SLICES (PHANTOM)",
                    "20240119", "120000", "FIXACC005")


# --------------------------------------------------------------------------------------
# CT torso phantom
# --------------------------------------------------------------------------------------

NX = NY = 512
NZ = 300
PX = 0.7          # mm in-plane
DZ = 1.0          # mm slice spacing
X0 = -(NX - 1) * PX / 2.0   # patient x (LPS, +x = patient left) of column 0
Y0 = -(NY - 1) * PX / 2.0   # patient y (+y = posterior) of row 0
Z0 = -150.0                 # z of array index 0 (most inferior)

# Tissue labels (used for PET activity assignment)
L_AIR, L_TABLE, L_FAT, L_MUSCLE, L_LUNG, L_CORTEX, L_MARROW, L_LIVER, L_SPLEEN = range(9)
(L_KCORTEX, L_KMED, L_BLADDER, L_BLOOD, L_MYO, L_BOWEL, L_STOMACH, L_CSF, L_CART,
 L_AIRWAY, L_LES_RUL, L_LES_LLL, L_LES_LIVER, L_LES_BONE, L_ESOPH, L_SOFT) = range(9, 25)
N_LABELS = 25

# Lesions (patient coordinates, mm; h = height above the most inferior slice)
LESIONS = [
    # name, label, x, y, h, radius, HU
    ("RUL lung nodule (spiculated)", L_LES_RUL, -62.0, -18.0, 266.0, 6.5, 30.0),
    ("LLL lung mass", L_LES_LLL, 78.0, 38.0, 212.0, 9.5, 40.0),
    ("Liver segment VII/VIII metastasis", L_LES_LIVER, -62.0, 22.0, 168.0, 13.0, 25.0),
    ("T12/L1 sclerotic vertebral metastasis", L_LES_BONE, 6.0, 46.0, 141.0, 7.0, 1350.0),
]


def lesion_table() -> list[dict]:
    out = []
    for name, _lab, x, y, h, r, hu in LESIONS:
        z = Z0 + h
        col = (x - X0) / PX
        row = (y - Y0) / PX
        out.append(dict(name=name, x=x, y=y, z=z, r=r, hu=hu,
                        col=col, row=row, instance_1mm=int(round(NZ - h)), hdesc=h))
    return out


@dataclass
class Tube:
    p0: np.ndarray
    p1: np.ndarray
    r0: float
    r1: float
    hu: float
    label: int
    clip: str | None = None   # "mask" => only paint inside the mask passed to paint_tubes

    def zrange(self) -> tuple[float, float]:
        rm = max(self.r0, self.r1)
        return min(self.p0[2], self.p1[2]) - rm, max(self.p0[2], self.p1[2]) + rm


def polyline(points, radii, hu, label, clip=None) -> list[Tube]:
    pts = [np.array(p, dtype=np.float64) for p in points]
    out = []
    for i in range(len(pts) - 1):
        out.append(Tube(pts[i], pts[i + 1], radii[i], radii[i + 1], hu, label, clip))
    return out


def build_vessel_trees(rng: np.random.Generator) -> list[Tube]:
    """Branching pulmonary vessel trees from each hilum (clipped to lung later)."""
    tubes: list[Tube] = []

    def grow(p, d, length, radius, gen):
        d = d / np.linalg.norm(d)
        q = p + d * length
        r1 = radius * 0.8
        tubes.append(Tube(p.copy(), q, radius, r1, 160.0 if radius > 1.5 else 110.0,
                          L_BLOOD, "mask"))
        if gen >= 5:
            return
        nchild = 2 if rng.random() < 0.7 else 3
        for _ in range(nchild):
            # random perpendicular perturbation
            perp = rng.normal(size=3)
            perp -= perp.dot(d) * d
            perp /= np.linalg.norm(perp) + 1e-9
            ang = rng.uniform(0.35, 0.75)
            nd = d * math.cos(ang) + perp * math.sin(ang)
            grow(q, nd, length * rng.uniform(0.62, 0.8), r1 * rng.uniform(0.68, 0.8), gen + 1)

    for side in (-1, 1):
        hil = np.array([side * 42.0, 6.0, 236.0])
        dirs = [
            (side * 0.25, -0.15, 1.0),    # upper lobe, apical
            (side * 0.8, -0.5, 0.45),     # anterior upper
            (side * 1.0, 0.1, 0.0),       # lateral
            (side * 0.5, -0.6, -0.6),     # anterior basal / lingula / middle lobe
            (side * 0.55, 0.6, -0.65),    # posterior basal
            (side * 0.2, 0.75, 0.1),      # superior segment (posterior)
        ]
        for dvec in dirs:
            grow(hil, np.array(dvec, dtype=np.float64), rng.uniform(26, 34), 5.0, 1)
    return tubes


def build_tubes(rng: np.random.Generator) -> dict[str, list[Tube]]:
    T: dict[str, list[Tube]] = {}
    # Aorta: iliac bifurcation -> descending -> arch -> ascending -> root
    T["aorta"] = polyline(
        [(14, 20, 60), (16, 20, 120), (20, 22, 180), (30, 34, 232), (28, 32, 262),
         (14, 22, 278), (2, 2, 286), (-8, -16, 282), (-12, -26, 268), (-10, -28, 246),
         (-6, -22, 222)],
        [9.5, 10.5, 11.5, 12.0, 12.0, 12.5, 13.0, 14.0, 15.0, 15.0, 14.5], 255.0, L_BLOOD)
    T["iliac_art"] = (polyline([(14, 20, 60), (42, 22, 35), (62, 2, 8), (70, -6, -2)],
                               [6.5, 6.0, 5.5, 5.0], 245.0, L_BLOOD)
                      + polyline([(14, 20, 60), (-20, 22, 35), (-56, 2, 8), (-66, -6, -2)],
                                 [6.5, 6.0, 5.5, 5.0], 245.0, L_BLOOD))
    T["renal_art"] = (polyline([(18, 20, 132), (62, 44, 128)], [3.2, 2.8], 240.0, L_BLOOD)
                      + polyline([(14, 20, 134), (-58, 46, 122)], [3.2, 2.8], 240.0, L_BLOOD))
    # IVC (portal-venous-ish, less dense than aorta)
    T["ivc"] = polyline([(-12, 22, 55), (-24, 18, 120), (-28, 14, 175), (-22, 6, 205)],
                        [10.0, 11.0, 12.0, 13.0], 135.0, L_BLOOD)
    T["iliac_vein"] = (polyline([(-12, 22, 55), (-50, 18, 25), (-66, 4, -2)], [7, 6.5, 6], 130.0, L_BLOOD)
                       + polyline([(-12, 22, 55), (36, 24, 30), (58, 6, -2)], [7, 6.5, 6], 130.0, L_BLOOD))
    # Hepatic / portal veins inside liver
    T["hepatic"] = (polyline([(-22, 10, 196), (-70, -10, 186)], [5, 3], 140.0, L_BLOOD)
                    + polyline([(-22, 10, 196), (-45, 30, 178)], [5, 3], 140.0, L_BLOOD)
                    + polyline([(-20, 20, 160), (-75, 10, 150)], [6, 3], 150.0, L_BLOOD)
                    + polyline([(-20, 20, 160), (-40, -30, 150)], [5, 2.5], 150.0, L_BLOOD))
    for t in T["hepatic"]:
        t.clip = "mask"
    # Pulmonary trunk and arteries
    T["pa"] = (polyline([(4, -40, 226), (8, -28, 246), (0, -6, 248), (-40, 4, 240)],
                        [13, 13, 10, 8], 210.0, L_BLOOD)
               + polyline([(8, -28, 246), (40, 6, 244)], [10, 8], 210.0, L_BLOOD))
    # Trachea and main bronchi: wall then lumen (air)
    airway = [(0, -14, 305), (0, -8, 262), (0, -2, 252)]
    T["airway_wall"] = (polyline(airway, [10, 10, 9], 40.0, L_SOFT)
                        + polyline([(0, -2, 252), (-30, 4, 240), (-44, 8, 234)], [8, 6.5, 5], 40.0, L_SOFT)
                        + polyline([(0, -2, 252), (34, 6, 238), (48, 12, 230)], [7.5, 6, 4.5], 40.0, L_SOFT))
    T["airway_lumen"] = (polyline(airway, [8, 8, 7], -1000.0, L_AIRWAY)
                         + polyline([(0, -2, 252), (-30, 4, 240), (-44, 8, 234)], [6, 4.8, 3.4], -1000.0, L_AIRWAY)
                         + polyline([(0, -2, 252), (34, 6, 238), (48, 12, 230)], [5.5, 4.4, 3], -1000.0, L_AIRWAY))
    T["esophagus"] = polyline([(4, 24, 300), (8, 24, 230), (18, 16, 190), (40, -20, 178)],
                              [7, 7, 7, 8], 40.0, L_ESOPH)
    T["pulm_vessels"] = build_vessel_trees(rng)
    # Colon frame (wall + gas lumen)
    colon = [(-95, 10, 70), (-100, 0, 110), (-96, -10, 136), (-50, -62, 140), (0, -70, 138),
             (50, -60, 144), (96, -5, 150), (100, 10, 120), (96, 18, 80), (60, 30, 60),
             (20, 20, 50)]
    T["colon_wall"] = polyline(colon, [19] * len(colon), 40.0, L_BOWEL)
    T["colon_lumen"] = polyline(colon, [15] * len(colon), -950.0, L_AIRWAY)
    # Small bowel loops (random, fluid filled with occasional gas)
    sb: list[Tube] = []
    sbl: list[Tube] = []
    for _ in range(22):
        c = np.array([rng.uniform(-60, 60), rng.uniform(-60, 10), rng.uniform(58, 110)])
        d = rng.normal(size=3)
        d /= np.linalg.norm(d)
        L = rng.uniform(20, 45)
        p0, p1 = c - d * L / 2, c + d * L / 2
        sb.append(Tube(p0, p1, 11.0, 11.0, 38.0, L_BOWEL))
        gas = rng.random() < 0.3
        sbl.append(Tube(p0, p1, 7.5, 7.5, -900.0 if gas else 15.0, L_AIRWAY if gas else L_BOWEL))
    T["small_bowel"] = sb
    T["small_bowel_lumen"] = sbl
    # Spiculations around the RUL nodule
    spic: list[Tube] = []
    _, _, nx, ny, nh, nr, _ = LESIONS[0]
    for _ in range(9):
        d = rng.normal(size=3)
        d /= np.linalg.norm(d)
        c = np.array([nx, ny, nh])
        spic.append(Tube(c, c + d * rng.uniform(nr + 4, nr + 10), 1.4, 0.5, 20.0, L_LES_RUL, "mask"))
    T["spiculation"] = spic
    return T


class TubeIndex:
    """Fast per-slice access to the subset of tubes overlapping a given height."""

    def __init__(self, tubes: list[Tube]):
        self.tubes = tubes
        self.z = np.array([t.zrange() for t in tubes]) if tubes else np.zeros((0, 2))

    def active(self, h: float) -> list[Tube]:
        if not self.tubes:
            return []
        idx = np.nonzero((self.z[:, 0] <= h) & (self.z[:, 1] >= h))[0]
        return [self.tubes[i] for i in idx]


def paint_tubes(img, lab, xs, ys, h, tubes: list[Tube], clip_mask=None):
    for t in tubes:
        rm = max(t.r0, t.r1)
        xmin = min(t.p0[0], t.p1[0]) - rm
        xmax = max(t.p0[0], t.p1[0]) + rm
        ymin = min(t.p0[1], t.p1[1]) - rm
        ymax = max(t.p0[1], t.p1[1]) + rm
        c0 = max(0, int((xmin - X0) / PX)); c1 = min(NX, int((xmax - X0) / PX) + 2)
        r0 = max(0, int((ymin - Y0) / PX)); r1 = min(NY, int((ymax - Y0) / PX) + 2)
        if c0 >= c1 or r0 >= r1:
            continue
        sx = xs[c0:c1][None, :]
        sy = ys[r0:r1][:, None]
        d = t.p1 - t.p0
        dd = float(d.dot(d))
        qx = sx - t.p0[0]; qy = sy - t.p0[1]; qz = h - t.p0[2]
        if dd > 0:
            tt = np.clip((qx * d[0] + qy * d[1] + qz * d[2]) / dd, 0.0, 1.0)
        else:
            tt = np.zeros_like(qx + qy)
        ex = qx - tt * d[0]; ey = qy - tt * d[1]; ez = qz - tt * d[2]
        dist2 = ex * ex + ey * ey + ez * ez
        rad = t.r0 + (t.r1 - t.r0) * tt
        m = dist2 <= rad * rad
        if t.clip == "mask" and clip_mask is not None:
            m &= clip_mask[r0:r1, c0:c1]
        if m.any():
            img[r0:r1, c0:c1][m] = t.hu
            lab[r0:r1, c0:c1][m] = t.label


def ell(X, Y, cx, cy, a, b, rot=0.0):
    """Normalized elliptical radius^2 (<=1 inside)."""
    dx = X - cx; dy = Y - cy
    if rot:
        c, s = math.cos(rot), math.sin(rot)
        dx, dy = c * dx + s * dy, -s * dx + c * dy
    return (dx / a) ** 2 + (dy / b) ** 2


def smoothstep(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def body_axes(h: float) -> tuple[float, float]:
    """Body outline semi-axes (x, y) as a function of height (pelvis->chest)."""
    a = 158 - 8 * math.exp(-((h - 120) / 45) ** 2) + 4 * smoothstep(190, 260, h)
    b = 108 + 6 * math.exp(-((h - 110) / 50) ** 2) - 6 * smoothstep(250, 300, h)
    return a, b


LUNG_C = {-1: (-68.0, 8.0), 1: (68.0, 8.0)}
LUNG_AB = (62.0, 76.0)


def diaphragm(X, Y, s: int):
    """Height (mm above bottom slice) of the hemidiaphragm dome under lung side s (-1 right, +1 left)."""
    cx, cy = LUNG_C[s]
    e = ell(X, Y, cx, cy, *LUNG_AB)
    return 176 + 26 * np.clip(1 - e, 0, 1) + (8 if s < 0 else 0)


def paint(img, lab, mask, hu, label):
    img[mask] = hu
    lab[mask] = label


def bone(img, lab, rho2_mask, rho2, inner=0.62, cortex_hu=1150.0, marrow_hu=420.0):
    """Paint a bone with cortical shell (rho2 normalized radius^2)."""
    paint(img, lab, rho2_mask, cortex_hu, L_CORTEX)
    paint(img, lab, rho2_mask & (rho2 < inner), marrow_hu, L_MARROW)


def ct_slice(k: int, X, Y, xs, ys, tubes: dict[str, TubeIndex]):
    """Return (HU float32, label uint8) for array index k (0 = most inferior)."""
    h = float(k)  # height above the bottom slice, in mm (DZ == 1)
    img = np.full((NY, NX), -1000.0, dtype=np.float32)
    lab = np.zeros((NY, NX), dtype=np.uint8)

    a, b = body_axes(h)
    # CT table: curved carbon-fibre top + support
    ty = b + 10 + 0.0009 * X ** 2
    tab = (np.abs(Y - ty) < 2.2) & (np.abs(X) < 175)
    paint(img, lab, tab, 180.0, L_TABLE)
    tab2 = (Y > ty + 2.2) & (Y < ty + 14) & (np.abs(X) < 150)
    paint(img, lab, tab2, -400.0, L_TABLE)

    # Body: skin/muscle wall, subcutaneous fat, abdominal muscle wall, visceral fat
    e_body = ell(X, Y, 0, 0, a, b)
    body = e_body <= 1
    paint(img, lab, body, 40.0, L_MUSCLE)
    paint(img, lab, ell(X, Y, 0, 0, a - 2.5, b - 2.5) <= 1, -105.0, L_FAT)
    paint(img, lab, ell(X, Y, 0, 0, a - 17, b - 17) <= 1, 52.0, L_MUSCLE)
    ai, bi = a - 25, b - 25
    interior = ell(X, Y, 0, 0, ai, bi) <= 1
    paint(img, lab, interior, -90.0, L_FAT)

    # Paraspinal muscles (all levels) and psoas
    for s in (-1, 1):
        paint(img, lab, ell(X, Y, s * 34, 84, 24, 17) <= 1, 50.0, L_MUSCLE)
        if 40 < h < 150:
            pr = 6 + 12 * smoothstep(150, 70, h)
            paint(img, lab, ell(X, Y, s * (28 + 18 * smoothstep(140, 50, h)), 46 - 20 * smoothstep(110, 40, h),
                                pr, pr * 1.1) <= 1, 48.0, L_MUSCLE)
    # Gluteal muscles (pelvis)
    if h < 85:
        g = smoothstep(85, 55, h)
        for s in (-1, 1):
            paint(img, lab, ell(X, Y, s * 82, 68, 50 * g + 1, 34 * g + 1, rot=s * 0.35) <= 1, 50.0, L_MUSCLE)

    # ---------------------------------------------------------------- abdomen
    # Liver (right side = -x), below right hemidiaphragm
    if 112 < h < 212:
        sc = math.sqrt(max(0.0, min(1.0, (h - 108) / 40)))
        e = ell(X, Y, -58, 4, 78 * sc + 1, 72 * sc + 1, rot=0.15)
        liv = (e <= 1) & interior & (h < diaphragm(X, Y, -1) - 2)
        paint(img, lab, liv, 62.0, L_LIVER)
    # Spleen (left posterior)
    if 148 < h < 198:
        zn = (h - 173) / 25
        sc = math.sqrt(max(0.0, 1 - zn * zn))
        paint(img, lab, (ell(X, Y, 78, 42, 26 * sc + 0.5, 44 * sc + 0.5, rot=-0.6) <= 1) & interior, 50.0, L_SPLEEN)
    # Stomach (left upper anterior) with air-fluid level (air anterior, supine)
    if 160 < h < 202:
        zn = (h - 181) / 21
        sc = math.sqrt(max(0.0, 1 - zn * zn))
        e = ell(X, Y, 48, -30, 40 * sc + 0.5, 30 * sc + 0.5, rot=0.4)
        wall = (e <= 1) & interior
        paint(img, lab, wall, 45.0, L_STOMACH)
        inner = ell(X, Y, 48, -30, 40 * sc - 4, 30 * sc - 4, rot=0.4) <= 1 if sc > 0.3 else np.zeros_like(wall)
        paint(img, lab, inner & (Y >= -38), 12.0, L_STOMACH)
        paint(img, lab, inner & (Y < -38), -1000.0, L_AIRWAY)
    # Kidneys
    for s, hc in ((-1, 116.0), (1, 126.0)):
        zn = (h - hc) / 28
        if abs(zn) < 1:
            sc = math.sqrt(1 - zn * zn)
            cx, cy = s * 66, 50
            rot = s * 0.55
            paint(img, lab, ell(X, Y, cx, cy, 30 * sc, 21 * sc, rot) <= 1, 175.0, L_KCORTEX)
            if sc > 0.35:
                paint(img, lab, ell(X, Y, cx - s * 4, cy - 2, 18 * sc, 11 * sc, rot) <= 1, 95.0, L_KMED)
                paint(img, lab, ell(X, Y, cx - s * 12, cy - 4, 7 * sc, 4 * sc, rot) <= 1, -60.0, L_FAT)  # sinus fat
    # Bladder
    zn = (h - 32) / 30
    if abs(zn) < 1:
        sc = math.sqrt(1 - zn * zn)
        paint(img, lab, ell(X, Y, 0, -38, 50 * sc, 38 * sc) <= 1, 8.0, L_BLADDER)

    # ---------------------------------------------------------------- chest
    lung_mask = None
    if h > 168:
        f_apex = math.sqrt(max(0.0, min(1.0, (312 - h) / 50)))
        lung_mask = np.zeros((NY, NX), dtype=bool)
        for s in (-1, 1):
            cx, cy = LUNG_C[s]
            la, lb = LUNG_AB[0] * f_apex, LUNG_AB[1] * min(1.0, f_apex * 1.05)
            e = ell(X, Y, cx, cy, la, lb)
            m = (e <= 1) & (h > diaphragm(X, Y, s)) & interior
            lung_mask |= m
        # mediastinum + paravertebral carve-out
        lung_mask &= ~((np.abs(X - 2) < 20) & (Y > -70) & (Y < 62))
        lung_mask &= ~((np.abs(X) < 30) & (Y > 26))
        lung_hu = -860 + 45 * np.clip((Y + 70) / 150, 0, 1)   # dependent density gradient
        img[lung_mask] = lung_hu[lung_mask]
        lab[lung_mask] = L_LUNG

        # Heart (rotated ellipsoid), pericardial fat, chambers
        hc = (12.0, -18.0, 220.0)
        zn = (h - hc[2]) / 34.0
        if abs(zn) < 1:
            sc = math.sqrt(1 - zn * zn)
            rot = -0.55
            peri = ell(X, Y, hc[0], hc[1], 62 * sc + 4, 48 * sc + 4, rot) <= 1
            paint(img, lab, peri & interior, -80.0, L_FAT)
            myo = ell(X, Y, hc[0], hc[1], 62 * sc, 48 * sc, rot) <= 1
            paint(img, lab, myo, 55.0, L_MYO)
            if sc > 0.3:
                lv = ell(X, Y, hc[0] + 18, hc[1] + 6, 26 * sc, 18 * sc, rot) <= 1
                rv = ell(X, Y, hc[0] - 22, hc[1] - 10, 24 * sc, 14 * sc, rot) <= 1
                paint(img, lab, lv, 240.0, L_BLOOD)
                paint(img, lab, rv, 170.0, L_BLOOD)
        # Sternum
        if 196 < h < 292:
            w = 13 + 6 * smoothstep(270, 288, h)
            st = ell(X, Y, 0, -bi + 1, w, 6.5)
            bone(img, lab, st <= 1, st, cortex_hu=1050.0, marrow_hu=380.0)
        # Scapulae
        if 214 < h < 296:
            for s in (-1, 1):
                p0 = np.array([s * 52.0, 92.0]); p1 = np.array([s * 112.0, 62.0])
                d = p1 - p0; L = np.linalg.norm(d); d /= L
                qx = X - p0[0]; qy = Y - p0[1]
                t = np.clip(qx * d[0] + qy * d[1], 0, L)
                dist = np.hypot(qx - t * d[0], qy - t * d[1])
                thick = 3.0 + 3.5 * smoothstep(240, 285, h)
                paint(img, lab, (dist < thick) & body, 950.0, L_CORTEX)
        # Breast/pectoral soft tissue anteriorly at chest levels
        for s in (-1, 1):
            paint(img, lab, (ell(X, Y, s * 70, -b + 20, 45, 9, rot=s * -0.25) <= 1) & body & ~interior,
                  48.0, L_MUSCLE)

    # ---------------------------------------------------------------- tubes (soft tissue/vessels)
    for key in ("colon_wall", "colon_lumen", "small_bowel", "small_bowel_lumen",
                "esophagus", "ivc", "iliac_vein", "aorta", "iliac_art", "renal_art", "pa",
                "airway_wall", "airway_lumen"):
        paint_tubes(img, lab, xs, ys, h, tubes[key].active(h))
    if lung_mask is not None:
        paint_tubes(img, lab, xs, ys, h, tubes["pulm_vessels"].active(h), lung_mask)
    if 112 < h < 212:
        paint_tubes(img, lab, xs, ys, h, tubes["hepatic"].active(h), lab == L_LIVER)

    # ---------------------------------------------------------------- skeleton
    # Spine (vertebral bodies + discs), canal, posterior elements
    period = 25.0
    phase = (h + 3.0) % period
    disc = phase < 5.0
    if h > 62:
        vb = ell(X, Y, 0, 50, 21, 17)
        if disc:
            paint(img, lab, vb <= 1, 85.0, L_CART)
        else:
            bone(img, lab, vb <= 1, vb, inner=0.7, cortex_hu=1100.0, marrow_hu=430.0)
            # posterior arch (pedicles + laminae)
            arch = (ell(X, Y, 0, 78, 16, 14) <= 1) & ~(ell(X, Y, 0, 77, 9.5, 8.5) <= 1) & (Y > 60)
            paint(img, lab, arch, 1000.0, L_CORTEX)
            # spinous process slopes caudally: present for the upper part of each segment
            if phase > 9:
                sp = (np.abs(X) < 3.6) & (Y > 88) & (Y < 103 - 6 * smoothstep(13, 24, phase))
                paint(img, lab, sp, 1000.0, L_CORTEX)
            # transverse processes
            if 10 < phase < 19:
                tp = (np.abs(Y - 72) < 3.6) & (np.abs(X) < (36 if h > 150 else 44)) & (np.abs(X) > 10)
                paint(img, lab, tp, 1000.0, L_CORTEX)
        # canal + cord
        paint(img, lab, ell(X, Y, 0, 77, 9.5, 8.5) <= 1, 12.0, L_CSF)
        paint(img, lab, ell(X, Y, 0, 77, 5, 4.2) <= 1, 35.0, L_CSF)
    else:
        # Sacrum: broad, posteriorly tilted plate
        sy = 62 + 0.25 * (62 - h)
        sa = 22 + 30 * smoothstep(10, 55, h)
        sac = ell(X, Y, 0, sy, sa, 13)
        if h > 18:
            bone(img, lab, sac <= 1, sac, inner=0.55, cortex_hu=1050.0, marrow_hu=380.0)
            paint(img, lab, ell(X, Y, 0, sy, 6, 3.5) <= 1, 12.0, L_CSF)

    # Pelvis: iliac wings, acetabula/femoral heads, pubis, ischia
    if 30 < h < 96:
        w = smoothstep(96, 82, h)
        for s in (-1, 1):
            cx, cy = s * (64 + 22 * smoothstep(40, 90, h)), 34 - 10 * smoothstep(40, 90, h)
            e = ell(X, Y, cx, cy, 52 * w + 1, 10, rot=s * 0.62)
            bone(img, lab, (e <= 1) & body, e, inner=0.35, cortex_hu=1100.0, marrow_hu=380.0)
    if h < 40:
        for s in (-1, 1):
            # femoral head sphere
            zn = (h - 16) / 23.0
            if abs(zn) < 1:
                r = 23 * math.sqrt(1 - zn * zn)
                e = ell(X, Y, s * 86, 8, r, r)
                bone(img, lab, e <= 1, e, inner=0.8, cortex_hu=1150.0, marrow_hu=330.0)
            # acetabular rim
            if 10 < h < 38:
                e = ell(X, Y, s * 86, 8, 28, 28)
                rim = (e <= 1) & (e > 0.72) & (s * X < s * 86 + 5)
                paint(img, lab, rim, 1100.0, L_CORTEX)
            # femoral neck towards greater trochanter
            if h < 14:
                p0 = np.array([s * 86.0, 8.0]); p1 = np.array([s * 128.0, 16.0])
                d = p1 - p0; L = np.linalg.norm(d); d /= L
                qx = X - p0[0]; qy = Y - p0[1]
                t = np.clip(qx * d[0] + qy * d[1], 0, L)
                dist = np.hypot(qx - t * d[0], qy - t * d[1])
                rr = 12 + 6 * (t / L)
                m = (dist < rr) & body
                paint(img, lab, m, 1100.0, L_CORTEX)
                paint(img, lab, m & (dist < rr - 3), 330.0, L_MARROW)
            # ischium (posterior) and pubic ramus (anterior)
            if h < 24:
                e = ell(X, Y, s * 52, 48, 10, 16, rot=s * 0.3)
                bone(img, lab, e <= 1, e, inner=0.45)
                e = ell(X, Y, s * 30, -64, 22, 7, rot=s * -0.4)
                bone(img, lab, e <= 1, e, inner=0.4)

    # Ribs: 11 pairs, each a flattened tube following the chest wall, descending anteriorly
    if 140 < h < 300:
        Rx, Ry = ai + 3.0, bi + 3.0
        rho = np.sqrt((X / Rx) ** 2 + (Y / Ry) ** 2)
        phi = np.arctan2(np.abs(X) / Rx, Y / Ry)      # 0 = posterior midline, pi = anterior
        Rloc = np.hypot(Rx * np.sin(phi), Ry * np.cos(phi))
        dr = (rho - 1.0) * Rloc                        # radial distance from rib circle (mm)
        near_wall = np.abs(dr) < 6
        if near_wall.any():
            for i in range(11):
                h0 = 290.0 - i * 12.5
                phi_end = 2.55 - 0.05 * i
                zr = h0 - 52.0 * ((1 - np.cos(phi)) / 2.0) ** 1.15
                halfz = 4.8 if i > 0 else 3.8
                dz = h - zr
                m = near_wall & (np.abs(dz) < halfz) & (phi > 0.32)
                if not m.any():
                    continue
                q2 = (dr / 3.4) ** 2 + (dz / halfz) ** 2
                ribm = m & (q2 <= 1) & (phi < phi_end)
                paint(img, lab, ribm, 1120.0, L_CORTEX)
                paint(img, lab, ribm & (q2 < 0.4), 400.0, L_MARROW)
                cart = m & (q2 <= 1) & (phi >= phi_end) & (phi < 2.98)
                paint(img, lab, cart, 130.0, L_CART)

    # ---------------------------------------------------------------- lesions (last)
    for name, label, lx, ly, lh, lr, lhu in LESIONS:
        dzl = h - lh
        if abs(dzl) < lr:
            rr = math.sqrt(lr * lr - dzl * dzl)
            e = ell(X, Y, lx, ly, rr, rr)
            m = e <= 1
            if label == L_LES_LIVER:
                paint(img, lab, m, 85.0, label)                               # enhancing rim
                paint(img, lab, e <= 0.62, lhu, label)
            else:
                paint(img, lab, m, lhu, label)
    if lung_mask is not None:
        paint_tubes(img, lab, xs, ys, h, tubes["spiculation"].active(h), lung_mask)

    return img, lab


def build_ct_volume(seed: int):
    log("CT phantom: painting 300 slices ...")
    rng = np.random.default_rng(seed)
    xs = (X0 + np.arange(NX) * PX).astype(np.float32)
    ys = (Y0 + np.arange(NY) * PX).astype(np.float32)
    X, Y = np.meshgrid(xs, ys)
    tubes = {k: TubeIndex(v) for k, v in build_tubes(rng).items()}
    hu = np.empty((NZ, NY, NX), dtype=np.float32)
    lab = np.empty((NZ, NY, NX), dtype=np.uint8)
    t0 = time.time()
    for k in range(NZ):
        hu[k], lab[k] = ct_slice(k, X, Y, xs, ys, tubes)
    log(f"CT phantom: painted in {time.time() - t0:.1f}s; smoothing + noise ...")
    # Partial-volume blur (slightly anisotropic, like a soft-tissue kernel) + quantum noise
    ndimage.gaussian_filter(hu, sigma=(0.7, 0.75, 0.75), output=hu)
    noise = rng.standard_normal(size=hu.shape, dtype=np.float32)
    # very light correlation of the noise, like a real recon kernel
    ndimage.gaussian_filter(noise, sigma=(0.0, 0.6, 0.6), output=noise)
    noise *= 14.0 / max(float(noise[::7, ::7, ::7].std()), 1e-6)
    inside = lab > L_AIR
    hu += np.where(inside, noise, noise * 0.35)
    np.clip(hu, -1024, 3071, out=hu)
    stored = np.rint(hu + 1024).astype(np.uint16)    # BitsStored 12, RescaleIntercept -1024
    log("CT phantom: done")
    return stored, lab, hu


# --------------------------------------------------------------------------------------
# Writers
# --------------------------------------------------------------------------------------

def ct_common(ds: Dataset, study: Study, series_uid: str, series_no: int, desc: str,
              frame_uid: str, thickness: float) -> None:
    study.apply(ds)
    ds.Modality = "CT"
    ds.SeriesInstanceUID = series_uid
    ds.SeriesNumber = series_no
    ds.SeriesDescription = desc
    ds.SeriesDate = study.date
    ds.SeriesTime = f"{int(study.time[:4]) + 2:04d}00"
    ds.AcquisitionDate = study.date
    ds.ContentDate = study.date
    ds.AcquisitionTime = ds.SeriesTime
    ds.ContentTime = ds.SeriesTime
    ds.InstanceCreationDate = study.date
    ds.InstanceCreationTime = ds.SeriesTime
    ds.BodyPartExamined = "CHEST"
    ds.ProtocolName = "CT CAP WITH CONTRAST"
    ds.PatientPosition = "HFS"
    ds.FrameOfReferenceUID = frame_uid
    ds.PositionReferenceIndicator = ""
    ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
    ds.ScanOptions = "HELICAL MODE"
    ds.KVP = "120"
    ds.XRayTubeCurrent = 200
    ds.ExposureTime = 500
    ds.ConvolutionKernel = "STANDARD"
    ds.ReconstructionDiameter = ds_str(NX * PX)
    ds.DataCollectionDiameter = "500"
    ds.GantryDetectorTilt = "0"
    ds.TableHeight = "160"
    ds.RotationDirection = "CW"
    ds.ContrastBolusAgent = "IODINATED CONTRAST"
    ds.ContrastBolusRoute = "IV"
    ds.SliceThickness = ds_str(thickness)
    ds.AcquisitionNumber = 1
    ds.ImageOrientationPatient = ["1", "0", "0", "0", "1", "0"]
    ds.PixelSpacing = [ds_str(PX), ds_str(PX)]
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = NY
    ds.Columns = NX
    ds.RescaleIntercept = "-1024"
    ds.RescaleSlope = "1"
    ds.RescaleType = "HU"
    ds.WindowCenter = "40"
    ds.WindowWidth = "400"
    ds.WindowCenterWidthExplanation = "SOFT TISSUE"
    ds.LossyImageCompression = "00"


def write_ct_slice(path: Path, pix: np.ndarray, *, study: Study, series_key: str, series_uid: str,
                   series_no: int, desc: str, frame_uid: str, inst: int, z: float, thickness: float,
                   signed: bool = False, ts: str = U.ExplicitVRLittleEndian) -> Dataset:
    sop = make_uid(f"{series_key}/{inst}")
    ds = new_file_ds(U.CTImageStorage, sop, ts)
    ct_common(ds, study, series_uid, series_no, desc, frame_uid, thickness)
    ds.InstanceNumber = inst
    ds.ImagePositionPatient = [ds_str(X0), ds_str(Y0), ds_str(z)]
    ds.SliceLocation = ds_str(z)
    if signed:
        ds.BitsAllocated = 16; ds.BitsStored = 16; ds.HighBit = 15; ds.PixelRepresentation = 1
        arr = pix.astype(np.int16)
    else:
        ds.BitsAllocated = 16; ds.BitsStored = 12; ds.HighBit = 11; ds.PixelRepresentation = 0
        arr = pix.astype(np.uint16)
    ds.SmallestImagePixelValue = int(arr.min())
    ds.LargestImagePixelValue = int(arr.max())
    ds["SmallestImagePixelValue"].VR = "SS" if signed else "US"
    ds["LargestImagePixelValue"].VR = "SS" if signed else "US"
    ds.PixelData = arr.tobytes()
    ds["PixelData"].VR = "OW"
    save(ds, path)
    return ds


def write_ct_series(out: Path, vol: np.ndarray, zs: np.ndarray, *, study: Study, key: str,
                    series_no: int, desc: str, frame_uid: str, thickness: float, signed=False) -> None:
    """vol[k] at height index ordering ascending z; instance 1 = most superior."""
    series_uid = make_uid(f"series/{key}")
    n = vol.shape[0]
    for k in range(n):
        inst = n - k
        write_ct_slice(out / f"IM{inst:06d}", vol[k], study=study, series_key=key, series_uid=series_uid,
                       series_no=series_no, desc=desc, frame_uid=frame_uid, inst=inst,
                       z=float(zs[k]), thickness=thickness, signed=signed)


# --------------------------------------------------------------------------------------
# PET
# --------------------------------------------------------------------------------------

PET_N = 128
PET_PX = 4.0
PET_NZ = 75
PET_DZ = 4.0
PET_X0 = -(PET_N - 1) * PET_PX / 2.0
PET_Z0 = Z0 + 1.5                    # slice centres -148.5 .. +147.5 (same 300 mm extent)
INJECTED_DOSE = 370e6                # Bq
HALF_LIFE = 6586.2                   # s
INJ_TIME = "090000.00"
SERIES_TIME_PET = "100000.00"        # 60 min uptake
WEIGHT_KG = 75.0


def suv_table() -> np.ndarray:
    s = np.zeros(N_LABELS, dtype=np.float32)
    s[L_FAT] = 0.35; s[L_MUSCLE] = 0.7; s[L_LUNG] = 0.45; s[L_CORTEX] = 0.6; s[L_MARROW] = 1.3
    s[L_LIVER] = 2.3; s[L_SPLEEN] = 1.9; s[L_KCORTEX] = 3.4; s[L_KMED] = 9.0; s[L_BLADDER] = 28.0
    s[L_BLOOD] = 1.7; s[L_MYO] = 5.5; s[L_BOWEL] = 1.6; s[L_STOMACH] = 1.8; s[L_CSF] = 0.9
    s[L_CART] = 0.5; s[L_AIRWAY] = 0.0; s[L_ESOPH] = 1.6; s[L_SOFT] = 0.8; s[L_TABLE] = 0.0
    s[L_LES_RUL] = 11.0; s[L_LES_LLL] = 14.0; s[L_LES_LIVER] = 8.5; s[L_LES_BONE] = 9.0
    return s


def bqml_per_suv() -> float:
    dt = 3600.0  # series time - injection time
    return INJECTED_DOSE * math.exp(-math.log(2) * dt / HALF_LIFE) / (WEIGHT_KG * 1000.0)


def build_pet(lab: np.ndarray, seed: int) -> np.ndarray:
    log("PET: computing activity map ...")
    suv = suv_table()[lab]                                   # (300,512,512) on CT grid
    # Block-average 4x4 in-plane, 2 in z => 2.8 mm x 2.8 mm x 2 mm
    s = suv.reshape(NZ // 2, 2, NY // 4, 4, NX // 4, 4).mean(axis=(1, 3, 5))
    del suv
    # PET resolution ~6.5 mm FWHM
    sig_mm = 6.5 / 2.3548
    s = ndimage.gaussian_filter(s, sigma=(sig_mm / 2.0, sig_mm / 2.8, sig_mm / 2.8))
    # Sample on PET grid
    pz = PET_Z0 + np.arange(PET_NZ) * PET_DZ
    pxy = PET_X0 + np.arange(PET_N) * PET_PX
    # coordinates in the downsampled CT grid index space
    zi = (pz - (Z0 + 0.5)) / 2.0
    yi = (pxy - (Y0 + 1.5 * PX)) / (4 * PX)
    xi = (pxy - (X0 + 1.5 * PX)) / (4 * PX)
    Zc, Yc, Xc = np.meshgrid(zi, yi, xi, indexing="ij")
    pet_suv = ndimage.map_coordinates(s, [Zc, Yc, Xc], order=1, mode="constant", cval=0.0)
    rng = np.random.default_rng(seed + 4)
    noise = rng.standard_normal(pet_suv.shape).astype(np.float32)
    noise = ndimage.gaussian_filter(noise, sigma=0.8)
    noise /= noise.std()
    pet_suv = pet_suv * (1 + 0.10 * noise) + 0.04 * noise * (pet_suv > 0.05)
    pet_suv = np.clip(pet_suv, 0, None)
    return (pet_suv * bqml_per_suv()).astype(np.float32)     # Bq/ml at series start time


def code_item(value, scheme, meaning) -> Dataset:
    it = Dataset()
    it.CodeValue = value
    it.CodingSchemeDesignator = scheme
    it.CodeMeaning = meaning
    return it


def write_pet_series(out: Path, bq: np.ndarray, frame_uid: str) -> None:
    key = "pet-fdg"
    series_uid = make_uid(f"series/{key}")
    study = CT_STUDY
    nz = bq.shape[0]
    dfac = 1.0
    for k in range(nz):
        inst = nz - k
        sl = bq[k]
        mx = float(sl.max())
        slope = mx / 32000.0 if mx > 0 else 1.0
        stored = np.rint(sl / slope).astype(np.uint16)
        z = PET_Z0 + k * PET_DZ
        ds = new_file_ds(U.PositronEmissionTomographyImageStorage, make_uid(f"{key}/{inst}"))
        study.apply(ds)
        ds.Modality = "PT"
        ds.SeriesInstanceUID = series_uid
        ds.SeriesNumber = 4
        ds.SeriesDescription = "PET WB FDG AC"
        ds.SeriesDate = study.date
        ds.SeriesTime = SERIES_TIME_PET
        ds.AcquisitionDate = study.date
        ds.AcquisitionTime = SERIES_TIME_PET
        ds.ContentDate = study.date
        ds.ContentTime = "101500"
        ds.InstanceCreationDate = study.date
        ds.InstanceCreationTime = "101500"
        ds.BodyPartExamined = "WHOLEBODY"
        ds.ProtocolName = "PET/CT FDG WB"
        ds.PatientPosition = "HFS"
        ds.FrameOfReferenceUID = frame_uid
        ds.PositionReferenceIndicator = ""
        ds.ImageType = ["ORIGINAL", "PRIMARY"]
        ds.InstanceNumber = inst
        ds.ImageIndex = inst
        ds.SliceLocation = ds_str(z)
        ds.ImagePositionPatient = [ds_str(PET_X0), ds_str(PET_X0), ds_str(z)]
        ds.ImageOrientationPatient = ["1", "0", "0", "0", "1", "0"]
        ds.PixelSpacing = [ds_str(PET_PX), ds_str(PET_PX)]
        ds.SliceThickness = ds_str(PET_DZ)
        ds.SpacingBetweenSlices = ds_str(PET_DZ)
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.Rows = PET_N; ds.Columns = PET_N
        ds.BitsAllocated = 16; ds.BitsStored = 16; ds.HighBit = 15; ds.PixelRepresentation = 0
        ds.RescaleIntercept = "0"
        ds.RescaleSlope = ds_str(slope, 8)
        ds.RescaleType = "BQML"
        ds.WindowCenter = ds_str(3.0 * bqml_per_suv(), 1)
        ds.WindowWidth = ds_str(6.0 * bqml_per_suv(), 1)
        ds.LossyImageCompression = "00"
        # PET Series module
        ds.SeriesType = ["WHOLE BODY", "IMAGE"]
        ds.Units = "BQML"
        ds.CountsSource = "EMISSION"
        ds.CorrectedImage = ["ATTN", "DECY", "SCAT", "DTIM", "NORM", "RAN"]
        ds.DecayCorrection = "START"
        ds.AttenuationCorrectionMethod = "CT-based"
        ds.ScatterCorrectionMethod = "Model-based"
        ds.ReconstructionMethod = "OSEM 3i21s"
        ds.RandomsCorrectionMethod = "DLYD"
        ds.NumberOfSlices = nz
        ds.NumberOfTimeSlices = 1
        ds.AxialAcceptance = "26"
        ds.AxialMash = [5, 6]
        ds.CollimatorType = "NONE"
        ds.DecayFactor = ds_str(dfac)
        ds.FrameReferenceTime = "0"
        ds.ActualFrameDuration = 120000
        ds.PrimaryPromptsCountsAccumulated = 1500000
        ds.DoseCalibrationFactor = "1"
        ds.TriggerTime = "0"
        ds.FrameTime = "0"
        ds.EnergyWindowRangeSequence = Sequence([Dataset()])
        ds.EnergyWindowRangeSequence[0].EnergyWindowLowerLimit = "425"
        ds.EnergyWindowRangeSequence[0].EnergyWindowUpperLimit = "650"
        # Radiopharmaceutical
        rp = Dataset()
        rp.Radiopharmaceutical = "Fluorodeoxyglucose"
        rp.RadiopharmaceuticalRoute = "Intravenous"
        rp.RadiopharmaceuticalVolume = "8"
        rp.RadiopharmaceuticalStartTime = INJ_TIME
        rp.RadiopharmaceuticalStartDateTime = study.date + INJ_TIME
        rp.RadionuclideTotalDose = ds_str(INJECTED_DOSE, 1)
        rp.RadionuclideHalfLife = ds_str(HALF_LIFE, 1)
        rp.RadionuclidePositronFraction = "0.9673"
        rp.RadionuclideCodeSequence = Sequence([code_item("C-111A1", "SRT", "^18^Fluorine")])
        rp.RadiopharmaceuticalCodeSequence = Sequence([code_item("C-B1031", "SRT", "Fluorodeoxyglucose F^18^")])
        ds.RadiopharmaceuticalInformationSequence = Sequence([rp])
        # NM/PET patient orientation
        ds.PatientOrientationCodeSequence = Sequence([code_item("F-10450", "SRT", "recumbent")])
        ds.PatientOrientationCodeSequence[0].PatientOrientationModifierCodeSequence = Sequence(
            [code_item("F-10340", "SRT", "supine")])
        ds.PatientGantryRelationshipCodeSequence = Sequence([code_item("F-10470", "SRT", "headfirst")])
        ds.PixelData = stored.tobytes()
        ds["PixelData"].VR = "OW"
        save(ds, out / f"IM{inst:06d}")


# --------------------------------------------------------------------------------------
# MR brain
# --------------------------------------------------------------------------------------

def build_mr(seed: int) -> tuple[np.ndarray, float, float]:
    n, nz, px, dz = 256, 24, 0.9375, 6.0
    rng = np.random.default_rng(seed + 7)
    c = (np.arange(n) - (n - 1) / 2) * px
    X, Y = np.meshgrid(c, c)
    zs = (np.arange(nz) - (nz - 1) / 2) * dz
    vol = np.zeros((nz, n, n), dtype=np.float32)
    th = np.arctan2(Y, X)
    gyri = 0.035 * np.sin(14 * th + 0.7) + 0.025 * np.sin(23 * th + 2.1) + 0.02 * np.sin(37 * th)
    for k, z in enumerate(zs):
        img = np.zeros((n, n), dtype=np.float32)
        zn = z / 78.0
        if abs(zn) >= 1:
            vol[k] = img
            continue
        sc = math.sqrt(1 - zn * zn)
        e = lambda a, b, cx=0.0, cy=0.0, rot=0.0: ell(X, Y, cx, cy, a, b, rot)
        A, B = 74 * sc, 92 * sc
        img[e(A, B) <= 1] = 900          # scalp (fat, bright on T1)
        img[e(A - 4, B - 4) <= 1] = 60   # skull (dark)
        img[e(A - 4, B - 4) <= 0.86] = 650  # diploe marrow
        img[e(A - 9, B - 9) <= 1] = 60
        img[e(A - 10, B - 10) <= 1] = 180  # CSF
        brain_r = e(A - 12, B - 12)
        img[brain_r <= 1] = 560          # grey matter
        wm = brain_r <= (0.62 + gyri) * (0.95 if sc > 0.5 else 0.6)
        img[wm] = 760                    # white matter
        # lateral ventricles + third ventricle in the mid slices
        if -12 < z < 26:
            vs = 1 - abs(z - 7) / 22
            for s in (-1, 1):
                img[e(7 * vs + 1, 26 * vs + 1, s * 9, -4, s * 0.18) <= 1] = 160
            img[e(2.5, 10, 0, 10) <= 1] = 160
        # deep grey nuclei
        if -10 < z < 14:
            for s in (-1, 1):
                img[e(8, 12, s * 22, 4) <= 1] = 600
        # orbits/eyes in low slices
        if -50 < z < -18:
            for s in (-1, 1):
                ee = e(13, 13, s * 32, -78)
                img[ee <= 1] = 120
                img[(ee > 1) & (e(18, 18, s * 32, -78) <= 1) & (img < 300)] = 850
        # posterior fossa / cerebellum slices
        if z < -25:
            for s in (-1, 1):
                img[(e(36 * sc, 30 * sc, s * 24, 40) <= 1) & (img > 0)] = 600
        vol[k] = img
    vol = ndimage.gaussian_filter(vol, sigma=(0.3, 1.0, 1.0))
    # coil bias field + Rician noise
    bias = (1.0 + 0.18 * np.exp(-((X + 40) ** 2 + (Y + 60) ** 2) / (2 * 80 ** 2)))[None]
    vol = vol * bias
    sigma = 18.0
    n1 = rng.standard_normal(vol.shape).astype(np.float32) * sigma
    n2 = rng.standard_normal(vol.shape).astype(np.float32) * sigma
    vol = np.sqrt((vol + n1) ** 2 + n2 ** 2)
    return np.clip(np.rint(vol), 0, 4095).astype(np.uint16), px, dz


def write_mr_series(out: Path, vol: np.ndarray, px: float, dz: float) -> None:
    key = "mr-t1"
    study = MR_STUDY
    series_uid = make_uid(f"series/{key}")
    frame_uid = make_uid("for/mr")
    nz, n, _ = vol.shape
    x0 = -(n - 1) * px / 2
    for k in range(nz):
        inst = nz - k
        z = (k - (nz - 1) / 2) * dz
        ds = new_file_ds(U.MRImageStorage, make_uid(f"{key}/{inst}"))
        study.apply(ds)
        ds.Modality = "MR"
        ds.SeriesInstanceUID = series_uid
        ds.SeriesNumber = 3
        ds.SeriesDescription = "AX T1 SE"
        ds.SeriesDate = study.date; ds.SeriesTime = "141500"
        ds.AcquisitionDate = study.date; ds.AcquisitionTime = "141500"
        ds.ContentDate = study.date; ds.ContentTime = "141500"
        ds.BodyPartExamined = "HEAD"
        ds.ProtocolName = "BRAIN ROUTINE"
        ds.PatientPosition = "HFS"
        ds.FrameOfReferenceUID = frame_uid
        ds.PositionReferenceIndicator = ""
        ds.ImageType = ["ORIGINAL", "PRIMARY", "M", "NONE"]
        ds.ScanningSequence = "SE"
        ds.SequenceVariant = "NONE"
        ds.ScanOptions = ""
        ds.MRAcquisitionType = "2D"
        ds.SequenceName = "se2d1"
        ds.RepetitionTime = "550"
        ds.EchoTime = "12"
        ds.EchoTrainLength = 1
        ds.NumberOfAverages = "1"
        ds.ImagingFrequency = "63.86"
        ds.ImagedNucleus = "1H"
        ds.MagneticFieldStrength = "1.5"
        ds.FlipAngle = "90"
        ds.SliceThickness = "5"
        ds.SpacingBetweenSlices = ds_str(dz)
        ds.InstanceNumber = inst
        ds.SliceLocation = ds_str(z)
        ds.ImagePositionPatient = [ds_str(x0), ds_str(x0), ds_str(z)]
        ds.ImageOrientationPatient = ["1", "0", "0", "0", "1", "0"]
        ds.PixelSpacing = [ds_str(px), ds_str(px)]
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.Rows = n; ds.Columns = n
        ds.BitsAllocated = 16; ds.BitsStored = 12; ds.HighBit = 11; ds.PixelRepresentation = 0
        ds.WindowCenter = "500"
        ds.WindowWidth = "1000"
        ds.LossyImageCompression = "00"
        ds.PixelData = vol[k].tobytes()
        ds["PixelData"].VR = "OW"
        save(ds, out / f"IM{inst:06d}")


# --------------------------------------------------------------------------------------
# Ultrasound multiframe
# --------------------------------------------------------------------------------------

def build_us(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed + 11)
    nf, rows, cols = 40, 240, 320
    yy, xx = np.mgrid[0:rows, 0:cols].astype(np.float32)
    ax, ay = cols / 2, 8.0
    r = np.hypot(xx - ax, yy - ay)
    ang = np.arctan2(xx - ax, yy - ay)
    sector = (r > 14) & (r < 228) & (np.abs(ang) < 0.72)
    # speckle field larger than the image; shifted slightly per frame (tissue motion)
    big = rng.rayleigh(1.0, size=(rows + 40, cols + 40)).astype(np.float32)
    big = ndimage.gaussian_filter(big, sigma=(1.6, 0.7))
    frames = np.zeros((nf, rows, cols), dtype=np.uint8)
    for f in range(nf):
        phase = 2 * math.pi * f / nf
        beat = 0.5 - 0.5 * math.cos(phase)
        dy = int(round(3 * math.sin(phase))) + 20
        sp = big[dy:dy + rows, 20:20 + cols]
        ech = np.full((rows, cols), 0.55, dtype=np.float32)
        ech[(r > 14) & (r < 40)] = 0.8                     # near-field fat/skin bright
        ech[(r > 40) & (r < 46)] = 1.4                     # fascia line
        # liver-like parenchyma below, kidney-ish ellipse
        ke = ((xx - 205) / 55) ** 2 + ((yy - 165) / 30) ** 2
        ech[ke < 1] = 0.75
        ech[ke < 0.35] = 1.2                               # sinus fat (bright)
        # pulsating vessel / chamber (anechoic) with bright wall
        cr = 26 + 9 * beat
        cd = np.hypot(xx - 130, yy - 115)
        ech[(cd > cr) & (cd < cr + 4)] = 1.6
        ech[cd <= cr] = 0.04
        # posterior acoustic enhancement below the chamber
        ech[(np.abs(xx - 130) < cr) & (yy > 115 + cr + 4)] *= 1.25
        att = np.exp(-r / 420.0)
        img = ech * sp * att
        img = 255 * np.clip(np.log1p(6 * img) / np.log1p(6 * 1.8), 0, 1)
        img[~sector] = 0
        # depth tick marks on the right edge (every ~1 cm)
        for d in range(20, 228, 24):
            img[int(ay + d), cols - 10:cols - 4] = 200
        frames[f] = img.astype(np.uint8)
    return frames


def write_us(path: Path, frames: np.ndarray) -> None:
    study = US_STUDY
    ds = new_file_ds(U.UltrasoundMultiFrameImageStorage, make_uid("us/1"))
    study.apply(ds)
    nf, rows, cols = frames.shape
    ds.Modality = "US"
    ds.SeriesInstanceUID = make_uid("series/us-cine")
    ds.SeriesNumber = 1
    ds.SeriesDescription = "ABDOMEN CINE"
    ds.SeriesDate = study.date; ds.SeriesTime = study.time
    ds.ContentDate = study.date; ds.ContentTime = study.time
    ds.AcquisitionDateTime = study.date + study.time
    ds.InstanceNumber = 1
    ds.ImageType = ["ORIGINAL", "PRIMARY", "ABDOMINAL", ""]
    ds.PatientOrientation = ""
    ds.BodyPartExamined = "ABDOMEN"
    ds.NumberOfFrames = nf
    ds.FrameIncrementPointer = 0x00181063     # FrameTime
    ds.FrameTime = "33.3"
    ds.CineRate = 30
    ds.RecommendedDisplayFrameRate = 30
    ds.FrameDelay = "0"
    ds.StartTrim = 1
    ds.StopTrim = nf
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = rows; ds.Columns = cols
    ds.BitsAllocated = 8; ds.BitsStored = 8; ds.HighBit = 7; ds.PixelRepresentation = 0
    ds.LossyImageCompression = "00"
    ds.TransducerData = ["C5-2", "", ""]
    ds.ProcessingFunction = "ABDOMEN"
    ds.TransducerFrequency = 3500
    # Calibrated region (0.05 cm per pixel) so viewers can measure on it
    reg = Dataset()
    reg.RegionSpatialFormat = 1
    reg.RegionDataType = 1
    reg.RegionFlags = 0
    reg.RegionLocationMinX0 = 0; reg.RegionLocationMinY0 = 0
    reg.RegionLocationMaxX1 = cols - 1; reg.RegionLocationMaxY1 = rows - 1
    reg.ReferencePixelX0 = cols // 2; reg.ReferencePixelY0 = 8
    reg.PhysicalUnitsXDirection = 3; reg.PhysicalUnitsYDirection = 3
    reg.ReferencePixelPhysicalValueX = 0.0; reg.ReferencePixelPhysicalValueY = 0.0
    reg.PhysicalDeltaX = 0.05; reg.PhysicalDeltaY = 0.05
    ds.SequenceOfUltrasoundRegions = Sequence([reg])
    ds.PixelData = frames.tobytes()
    ds["PixelData"].VR = "OB"
    save(ds, path)


# --------------------------------------------------------------------------------------
# Transfer syntax variants
# --------------------------------------------------------------------------------------

TS_VARIANTS = [
    # folder, uid, description, method
    ("explicit-le", U.ExplicitVRLittleEndian, "Explicit VR Little Endian", "pydicom"),
    ("implicit-le", U.ImplicitVRLittleEndian, "Implicit VR Little Endian", "pydicom"),
    ("jpeg-baseline-8bit", U.JPEGBaseline8Bit, "JPEG Baseline 8-bit (lossy, windowed 40/400)", "dcmcjpeg +eb"),
    ("jpeg-lossless-sv1", U.JPEGLosslessSV1, "JPEG Lossless SV1", "dcmcjpeg +e1"),
    ("jpeg-ls-lossless", U.JPEGLSLossless, "JPEG-LS Lossless", "pydicom/pyjpegls"),
    ("j2k-lossless", U.JPEG2000Lossless, "JPEG 2000 Lossless", "pydicom/pylibjpeg-openjpeg"),
    ("j2k-lossy", U.JPEG2000, "JPEG 2000 Lossy (20:1)", "pydicom/pylibjpeg-openjpeg"),
    ("htj2k-lossless", U.HTJ2KLossless, "HTJ2K Lossless", "imagecodecs (OpenJPH)"),
    ("rle-lossless", U.RLELossless, "RLE Lossless", "pydicom (native RLE)"),
    ("deflated-le", U.DeflatedExplicitVRLittleEndian, "Deflated Explicit VR Little Endian", "pydicom (zlib)"),
]
TS_FIRST_K = 215   # array index range [215, 235): mid-chest (heart, lungs, LLL mass)
TS_N = 20


def window_8bit(stored: np.ndarray, center=40.0, width=400.0) -> np.ndarray:
    hu = stored.astype(np.float32) - 1024
    lo = center - width / 2
    return np.clip(np.rint((hu - lo) / width * 255), 0, 255).astype(np.uint8)


def write_ts_variants(root: Path, stored: np.ndarray, notes: dict) -> None:
    frame_uid = make_uid("for/ts")
    sub = stored[TS_FIRST_K:TS_FIRST_K + TS_N]
    zs = Z0 + np.arange(TS_FIRST_K, TS_FIRST_K + TS_N) * DZ
    dcmcjpeg = which_or_die("dcmcjpeg")
    try:
        import imagecodecs  # noqa: F401
        have_htj2k = hasattr(imagecodecs, "htj2k_encode") and imagecodecs.HTJ2K.available
    except Exception:
        have_htj2k = False

    for i, (folder, ts, desc, method) in enumerate(TS_VARIANTS):
        out = root / folder
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        key = f"ts/{folder}"
        series_uid = make_uid(f"series/{key}")
        series_no = 101 + i
        if folder == "htj2k-lossless" and not have_htj2k:
            notes[folder] = "SKIPPED: no HTJ2K encoder (pip install imagecodecs)"
            shutil.rmtree(out)
            continue
        for j in range(TS_N):
            k = TS_N - 1 - j       # instance 1 = most superior
            inst = j + 1
            pix = sub[k]
            sop = make_uid(f"{key}/{inst}")
            ds = new_file_ds(U.CTImageStorage, sop, U.ExplicitVRLittleEndian)
            ct_common(ds, TS_STUDY, series_uid, series_no, desc, frame_uid, 1.0)
            ds.InstanceNumber = inst
            ds.ImagePositionPatient = [ds_str(X0), ds_str(Y0), ds_str(float(zs[k]))]
            ds.SliceLocation = ds_str(float(zs[k]))
            if folder == "jpeg-baseline-8bit":
                arr = window_8bit(pix)
                ds.BitsAllocated = 8; ds.BitsStored = 8; ds.HighBit = 7; ds.PixelRepresentation = 0
                ds.ImageType = ["DERIVED", "SECONDARY", "AXIAL"]
                del ds.RescaleIntercept, ds.RescaleSlope, ds.RescaleType
                ds.WindowCenter = "128"; ds.WindowWidth = "256"
                ds.WindowCenterWidthExplanation = "8-BIT WINDOWED COPY OF WL40/WW400"
                ds.DerivationDescription = "8-bit windowed (WL 40 / WW 400) copy for JPEG Baseline"
                ds.PixelData = arr.tobytes()
                ds["PixelData"].VR = "OW"
            else:
                arr = pix.astype(np.uint16)
                ds.BitsAllocated = 16; ds.BitsStored = 12; ds.HighBit = 11; ds.PixelRepresentation = 0
                ds.PixelData = arr.tobytes()
                ds["PixelData"].VR = "OW"
            dst = out / f"IM{inst:06d}"

            if folder in ("explicit-le",):
                save(ds, dst)
            elif folder == "implicit-le":
                ds.file_meta.TransferSyntaxUID = U.ImplicitVRLittleEndian
                save(ds, dst)
            elif folder == "deflated-le":
                ds.file_meta.TransferSyntaxUID = U.DeflatedExplicitVRLittleEndian
                save(ds, dst)
            elif folder in ("jpeg-baseline-8bit", "jpeg-lossless-sv1"):
                with tempfile.TemporaryDirectory() as td:
                    tmp = Path(td) / "in.dcm"
                    save(ds, tmp)
                    flag = "+eb" if folder == "jpeg-baseline-8bit" else "+e1"
                    run([dcmcjpeg, flag, "+un", str(tmp), str(dst)])
            elif folder == "jpeg-ls-lossless":
                ds.compress(U.JPEGLSLossless, encoding_plugin="pyjpegls")
                save(ds, dst)
            elif folder == "j2k-lossless":
                ds.compress(U.JPEG2000Lossless, encoding_plugin="pylibjpeg")
                save(ds, dst)
            elif folder == "j2k-lossy":
                ds.compress(U.JPEG2000, encoding_plugin="pylibjpeg", j2k_cr=[20])
                ds.LossyImageCompression = "01"
                ds.LossyImageCompressionRatio = "20"
                ds.LossyImageCompressionMethod = "ISO_15444_1"
                save(ds, dst)
            elif folder == "htj2k-lossless":
                import imagecodecs
                cs = imagecodecs.htj2k_encode(arr, reversible=True, bitspersample=12)
                ds.PixelData = encapsulate([cs])
                ds["PixelData"].VR = "OB"
                ds["PixelData"].is_undefined_length = True
                ds.file_meta.TransferSyntaxUID = U.HTJ2KLossless
                save(ds, dst)
            elif folder == "rle-lossless":
                ds.compress(U.RLELossless, encoding_plugin="pydicom")
                save(ds, dst)
            else:
                raise AssertionError(folder)
        notes[folder] = f"encoder: {method}"


# --------------------------------------------------------------------------------------
# CD media, archive, real files
# --------------------------------------------------------------------------------------

def build_cd_media(root: Path, ct5: Path, mr: Path) -> None:
    cd = root / "cd-media"
    if cd.exists():
        shutil.rmtree(cd)
    (cd / "DICOM").mkdir(parents=True)
    for st, src in ((1, ct5), (2, mr)):
        dst = cd / "DICOM" / f"ST{st:06d}" / "SE000001"
        dst.mkdir(parents=True)
        files = sorted(p for p in src.iterdir() if p.is_file() and p.name.startswith("IM"))
        for i, f in enumerate(files, 1):
            shutil.copyfile(f, dst / f"IM{i:06d}")
    run([which_or_die("dcmmkdir"), "-Pgp", "+I", "+r", "+F", "FLOWRAD_FIX",
         "+id", str(cd), "+D", str(cd / "DICOMDIR"), "DICOM"])
    (cd / "AUTORUN.INF").write_text(
        "[autorun]\r\nopen=VIEWER.EXE\r\nicon=VIEWER.EXE,0\r\nlabel=PHANTOM STUDY\r\n", encoding="ascii")
    (cd / "VIEWER.EXE").write_text(
        "This is NOT an executable. Placeholder mimicking the DICOM viewer that burners\r\n"
        "bundle on patient CDs. Viewers/importers must ignore it.\r\n", encoding="ascii")
    (cd / "README.TXT").write_text(
        "FLOWRAD SYNTHETIC PATIENT CD\r\n"
        "Contains: CT CAP phantom (Axial 5.0mm) and MR brain phantom.\r\n"
        "No real patient data. Generated by desktop/scripts/make-fixtures.py.\r\n", encoding="ascii")


def build_zip(root: Path) -> None:
    cd = root / "cd-media"
    out = root / "archives" / "study.zip"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(cd.rglob("*")):
            if p.is_file():
                info = zipfile.ZipInfo(str(Path("cd-media") / p.relative_to(cd)), date_time=(2024, 1, 15, 9, 30, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                z.writestr(info, p.read_bytes())


PYDICOM_REF = "v3.0.1"
REAL_FILES = [
    ("CT_small.dcm", f"https://raw.githubusercontent.com/pydicom/pydicom/{PYDICOM_REF}/src/pydicom/data/test_files/CT_small.dcm"),
    ("MR_small.dcm", f"https://raw.githubusercontent.com/pydicom/pydicom/{PYDICOM_REF}/src/pydicom/data/test_files/MR_small.dcm"),
    ("JPEG2000.dcm", f"https://raw.githubusercontent.com/pydicom/pydicom/{PYDICOM_REF}/src/pydicom/data/test_files/JPEG2000.dcm"),
    ("MR_small_RLE.dcm", f"https://raw.githubusercontent.com/pydicom/pydicom/{PYDICOM_REF}/src/pydicom/data/test_files/MR_small_RLE.dcm"),
    ("SC_rgb_jpeg_dcmtk.dcm", f"https://raw.githubusercontent.com/pydicom/pydicom/{PYDICOM_REF}/src/pydicom/data/test_files/SC_rgb_jpeg_dcmtk.dcm"),
    ("SC_rgb_rle.dcm", f"https://raw.githubusercontent.com/pydicom/pydicom/{PYDICOM_REF}/src/pydicom/data/test_files/SC_rgb_rle.dcm"),
    ("emri_small_jpeg_2k_lossless.dcm", "https://raw.githubusercontent.com/pydicom/pydicom-data/master/data_store/data/emri_small_jpeg_2k_lossless.dcm"),
    ("US1_J2KR.dcm", "https://raw.githubusercontent.com/pydicom/pydicom-data/master/data_store/data/US1_J2KR.dcm"),
    ("JPEG-LL.dcm", "https://raw.githubusercontent.com/pydicom/pydicom-data/master/data_store/data/JPEG-LL.dcm"),
    ("JPGLosslessP14SV1_1s_1f_8b.dcm", "https://raw.githubusercontent.com/pydicom/pydicom-data/master/data_store/data/JPGLosslessP14SV1_1s_1f_8b.dcm"),
]


def fetch_real(root: Path, notes: dict) -> None:
    out = root / "real"
    out.mkdir(parents=True, exist_ok=True)
    lines = []
    for name, url in REAL_FILES:
        dst = out / name
        if not dst.exists():
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    data = r.read()
                dst.write_bytes(data)
            except Exception as e:  # network is optional
                notes[f"real/{name}"] = f"download failed: {e}"
                continue
        sha = hashlib.sha256(dst.read_bytes()).hexdigest()[:16]
        lines.append(f"{name}\t{url}\tsha256:{sha}")
    (out / "SOURCES.txt").write_text(
        "Real DICOM test files from the pydicom project (MIT / per-file licences in pydicom-data).\n"
        + "\n".join(lines) + "\n")


# --------------------------------------------------------------------------------------
# Verification + manifest
# --------------------------------------------------------------------------------------

TS_NAMES = {
    U.ExplicitVRLittleEndian: "Explicit VR LE",
    U.ImplicitVRLittleEndian: "Implicit VR LE",
    U.JPEGBaseline8Bit: "JPEG Baseline 8-bit",
    U.JPEGLosslessSV1: "JPEG Lossless SV1",
    U.JPEGLossless: "JPEG Lossless (P14)",
    U.JPEGLSLossless: "JPEG-LS Lossless",
    U.JPEG2000Lossless: "JPEG 2000 Lossless",
    U.JPEG2000: "JPEG 2000",
    U.HTJ2KLossless: "HTJ2K Lossless",
    U.RLELossless: "RLE Lossless",
    U.DeflatedExplicitVRLittleEndian: "Deflated Explicit VR LE",
    U.JPEGExtended12Bit: "JPEG Extended 12-bit",
}


def is_part10(p: Path) -> bool:
    with open(p, "rb") as f:
        head = f.read(132)
    return len(head) == 132 and head[128:132] == b"DICM"


def dcmdump_check(files: list[Path]) -> tuple[int, list[str]]:
    """Parse every file with DCMTK dcmdump; a file passes if exit 0 and no E:/F: log lines."""
    dd = which_or_die("dcmdump")
    errs: list[str] = []
    ok = 0
    for f in files:
        r = subprocess.run([dd, str(f)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        bad = [ln for ln in r.stderr.splitlines() if ln.startswith(("E:", "F:"))]
        if r.returncode == 0 and not bad:
            ok += 1
        else:
            errs.append(f"{f.name}: {(bad or [f'exit {r.returncode}'])[0]}")
    return ok, errs


@dataclass
class FolderReport:
    folder: str
    nfiles: int
    nbytes: int
    syntaxes: str
    part10: str
    dcmdump: str
    decode: str
    extra: str = ""
    failed: bool = False


def verify_folder(root: Path, rel: str, ref: np.ndarray | None = None, ref_desc: str = "",
                  lossy: bool = False, recursive: bool = False, skip_names=()) -> FolderReport:
    d = root / rel
    it = d.rglob("*") if recursive else d.iterdir()
    allfiles = sorted(p for p in it if p.is_file())
    nbytes = sum(p.stat().st_size for p in allfiles)
    dfiles = [p for p in allfiles if p.name not in skip_names and is_part10(p)]
    nonp10 = [p for p in allfiles if p.name not in skip_names and p not in dfiles]
    ok, errs = dcmdump_check(dfiles)
    syntaxes: dict[str, int] = {}
    dec_ok = 0
    dec_fail: list[str] = []
    dec_na: list[str] = []
    slices = []
    for p in dfiles:
        ds = pydicom.dcmread(p)
        ts = ds.file_meta.TransferSyntaxUID
        syntaxes[TS_NAMES.get(ts, ts.name)] = syntaxes.get(TS_NAMES.get(ts, ts.name), 0) + 1
        if "PixelData" not in ds:
            dec_na.append(p.name)
            continue
        try:
            a = ds.pixel_array
            dec_ok += 1
            if ref is not None:
                slices.append((int(ds.InstanceNumber), a))
        except Exception as e:
            dec_fail.append(f"{p.name}: {type(e).__name__}: {e}"[:160])
    extra = ""
    if ref is not None and slices:
        slices.sort()
        got = np.stack([a for _, a in slices])
        exp = ref
        if got.shape != exp.shape:
            extra = f"shape mismatch {got.shape} vs {exp.shape}"
        elif lossy:
            mse = float(np.mean((got.astype(np.float64) - exp.astype(np.float64)) ** 2))
            peak = float(exp.max()) if exp.max() > 0 else 1.0
            psnr = 10 * math.log10(peak * peak / mse) if mse > 0 else float("inf")
            extra = f"lossy vs {ref_desc}: PSNR {psnr:.1f} dB"
        else:
            same = np.array_equal(got.astype(np.int64), exp.astype(np.int64))
            extra = f"bit-exact vs {ref_desc}: {'YES' if same else 'NO'}"
    syn = ", ".join(f"{k} ({v})" if len(syntaxes) > 1 else k for k, v in syntaxes.items()) or "-"
    dec = f"{dec_ok}/{len(dfiles) - len(dec_na)} decoded"
    if dec_fail:
        dec += f"; FAIL: {dec_fail[0]}" + (f" (+{len(dec_fail) - 1} more)" if len(dec_fail) > 1 else "")
    if dec_na:
        dec += f"; {len(dec_na)} without PixelData ({', '.join(dec_na[:3])})"
    p10 = f"{len(dfiles)}/{len(dfiles) + len(nonp10)}"
    if nonp10:
        p10 += f" (non-Part10: {', '.join(p.name for p in nonp10[:3])})"
    dd = f"{ok}/{len(dfiles)} OK" + (f"; {errs[0][:120]}" if errs else "")
    failed = bool(errs or dec_fail or nonp10 or "NO" in extra.split(":")[-1] or "mismatch" in extra)
    return FolderReport(rel, len(allfiles), nbytes, syn, p10, dd, dec, extra, failed)


def human(n: int) -> str:
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024 or u == "GB":
            return f"{n:.0f} {u}" if u == "B" else f"{n:.1f} {u}"
        n /= 1024
    return str(n)


def write_manifest(root: Path, reports: list[FolderReport], notes: dict, args, elapsed: float) -> None:
    L = []
    L.append("# DICOM test fixtures — MANIFEST\n")
    L.append(f"Generated by `desktop/scripts/make-fixtures.py` ({GENERATOR}), seed {SEED}, "
             f"pydicom {pydicom.__version__}, numpy {np.__version__}. Runtime {elapsed:.0f}s.\n")
    L.append("Regenerate:\n\n```\npython3 desktop/scripts/make-fixtures.py <OUT_DIR> --bench\n```\n")
    L.append("All synthetic data is deterministic (fixed seed, fixed dates, UIDs = 2.25.<hash(seed,name)>). "
             "No real patient data; `real/` holds public pydicom test files.\n")
    L.append("Verification columns: **Part10** = files with 128-byte preamble + `DICM`; **dcmdump** = "
             "parsed by DCMTK `dcmdump +E` with no errors; **decode** = `pydicom.Dataset.pixel_array` "
             "succeeded; **check** = pixel comparison against the generator's source volume.\n")
    L.append("| Folder | Files | Size | Transfer syntax | Part10 | dcmdump | pydicom decode | Check |")
    L.append("|---|---:|---:|---|---|---|---|---|")
    for r in reports:
        L.append(f"| `{r.folder}` | {r.nfiles} | {human(r.nbytes)} | {r.syntaxes} | {r.part10} | {r.dcmdump} | "
                 f"{r.decode} | {r.extra} |")
    L.append("")
    L.append("## Studies / series\n")
    L.append("| Study (PatientName / ID) | StudyInstanceUID | Series | Modality | Notes |")
    L.append("|---|---|---|---|---|")
    L.append(f"| {CT_STUDY.description} ({CT_STUDY.patient_name} / {CT_STUDY.patient_id}) | `{CT_STUDY.study_uid}` | "
             f"2 Axial 1.0mm (`ct-phantom/`), 3 Axial 5.0mm (`ct-phantom/axial-5mm/`), 4 PET WB FDG AC (`pet-phantom/`) | CT, PT | "
             f"shared FrameOfReferenceUID `{make_uid('for/ct')}` |")
    L.append(f"| {TS_STUDY.description} ({TS_STUDY.patient_name} / {TS_STUDY.patient_id}) | `{TS_STUDY.study_uid}` | "
             f"101-110, one per transfer syntax (`ts/*`) | CT | 20 slices = 1 mm slices z={Z0 + TS_FIRST_K:.0f}..{Z0 + TS_FIRST_K + TS_N - 1:.0f} mm |")
    L.append(f"| {MR_STUDY.description} ({MR_STUDY.patient_name} / {MR_STUDY.patient_id}) | `{MR_STUDY.study_uid}` | 3 AX T1 SE (`mr-brain/`) | MR | 256x256x24, 0.9375 mm, 6 mm spacing |")
    L.append(f"| {US_STUDY.description} ({US_STUDY.patient_name} / {US_STUDY.patient_id}) | `{US_STUDY.study_uid}` | 1 ABDOMEN CINE (`multiframe/US_cine.dcm`) | US | 40 frames 320x240, FrameTime 33.3, CineRate 30, calibrated US region 0.05 cm/px |")
    if args.bench:
        L.append(f"| {BENCH_STUDY.description} ({BENCH_STUDY.patient_name} / {BENCH_STUDY.patient_id}) | `{BENCH_STUDY.study_uid}` | 2 Axial 0.25mm (`bench/ct-1200/`) | CT | phantom linearly resampled to 0.25 mm |")
    L.append("")
    L.append("## CT phantom geometry\n")
    L.append(f"- 512x512, PixelSpacing 0.7 mm, 300 slices, 1.0 mm spacing, ImageOrientationPatient 1\\0\\0\\0\\1\\0 (axial, HFS).")
    L.append(f"- Column 0 at x={X0:.2f} mm, row 0 at y={Y0:.2f} mm; z = {Z0:.0f} (IM000300, inferior) .. {Z0 + NZ - 1:.0f} mm (IM000001, superior).")
    L.append("- Stored uint16, BitsStored 12, RescaleSlope 1 / Intercept -1024 (HU = stored - 1024). WL/WW 40/400.")
    L.append("- 5 mm series = mean of 5 consecutive 1 mm slices, stored **signed** int16 (PixelRepresentation 1, BitsStored 16) to exercise the signed path; same rescale.")
    L.append("- PET: 128x128 @ 4 mm, 75 slices @ 4 mm, same z extent, Units BQML, per-slice RescaleSlope; "
             f"FDG 370 MBq at 09:00, SeriesTime 10:00, weight 75 kg => 1 SUVbw = {bqml_per_suv():.1f} Bq/ml.")
    L.append("- Approximate HU: air -1000, lung ~-850 (+dependent gradient) with branching vessels, fat -100, muscle ~50, liver 62, "
             "aorta 255, pulmonary artery 210, kidneys 175, bone cortex 1000-1150, marrow ~400.\n")
    L.append("Lesions (ground truth for hot-spot / measurement tests):\n")
    L.append("| Lesion | x,y,z (mm, LPS) | radius mm | HU | CT 1 mm instance | col,row px | PET SUV |")
    L.append("|---|---|---:|---:|---:|---|---:|")
    st = suv_table()
    for les, lt in zip(LESIONS, lesion_table()):
        L.append(f"| {lt['name']} | {lt['x']:.0f}, {lt['y']:.0f}, {lt['z']:.0f} | {lt['r']} | {lt['hu']:.0f} | "
                 f"IM{lt['instance_1mm']:06d} | {lt['col']:.0f}, {lt['row']:.0f} | {st[les[1]]:.1f} (pre-PVE) |")
    L.append("")
    L.append("## Notes\n")
    for k, v in notes.items():
        L.append(f"- **{k}**: {v}")
    L.append("")
    (root / "MANIFEST.md").write_text("\n".join(L))


# --------------------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------------------

def main() -> int:
    global SEED
    ap = argparse.ArgumentParser(description="Generate reproducible DICOM fixtures for the desktop viewer.")
    ap.add_argument("out", nargs="?", default="./fixtures", help="output directory (default ./fixtures)")
    ap.add_argument("--bench", action="store_true", help="also generate bench/ct-1200 (1200 slices, ~630 MB)")
    ap.add_argument("--no-download", action="store_true", help="skip downloading real pydicom files")
    ap.add_argument("--seed", type=int, default=SEED, help=f"RNG/UID seed (default {SEED})")
    args = ap.parse_args()
    SEED = args.seed
    for s in (CT_STUDY, TS_STUDY, MR_STUDY, US_STUDY, BENCH_STUDY):
        s.study_uid = make_uid(f"study/{s.key}")
    for tool in ("dcmdump", "dcmcjpeg", "dcmmkdir"):
        which_or_die(tool)

    t0 = time.time()
    root = Path(args.out).resolve()
    root.mkdir(parents=True, exist_ok=True)
    managed = ["ct-phantom", "pet-phantom", "mr-brain", "ts", "multiframe", "cd-media", "archives"]
    if args.bench:
        managed.append("bench")
    for m in managed:
        if (root / m).exists():
            shutil.rmtree(root / m)
    notes: dict[str, str] = {}

    # ---- CT
    stored, lab, _hu = build_ct_volume(SEED)
    del _hu
    frame_uid = make_uid("for/ct")
    zs = Z0 + np.arange(NZ) * DZ
    log("writing ct-phantom (series 2, 300 slices) ...")
    write_ct_series(root / "ct-phantom", stored, zs, study=CT_STUDY, key="ct/axial-1mm", series_no=2,
                    desc="Axial 1.0mm", frame_uid=frame_uid, thickness=1.0)
    log("writing ct-phantom/axial-5mm (series 3, 60 slices, signed) ...")
    slab = stored.reshape(NZ // 5, 5, NY, NX).astype(np.float32).mean(axis=1)
    slab5 = np.rint(slab).astype(np.int16)
    zs5 = Z0 + np.arange(NZ // 5) * 5.0 + 2.0
    write_ct_series(root / "ct-phantom" / "axial-5mm", slab5, zs5, study=CT_STUDY, key="ct/axial-5mm",
                    series_no=3, desc="Axial 5.0mm", frame_uid=frame_uid, thickness=5.0, signed=True)

    # ---- PET
    bq = build_pet(lab, SEED)
    log("writing pet-phantom (series 4, 75 slices) ...")
    write_pet_series(root / "pet-phantom", bq, frame_uid)
    del lab

    # ---- MR
    log("MR brain ...")
    mr, mpx, mdz = build_mr(SEED)
    write_mr_series(root / "mr-brain", mr, mpx, mdz)

    # ---- transfer syntaxes
    log("transfer-syntax variants ...")
    write_ts_variants(root / "ts", stored, notes)

    # ---- US multiframe
    log("US multiframe ...")
    us = build_us(SEED)
    write_us(root / "multiframe" / "US_cine.dcm", us)

    # ---- CD media + zip
    log("cd-media + DICOMDIR ...")
    build_cd_media(root, root / "ct-phantom" / "axial-5mm", root / "mr-brain")
    build_zip(root)

    # ---- real files
    if args.no_download:
        notes["real/"] = "skipped (--no-download)"
    else:
        log("downloading real pydicom files ...")
        fetch_real(root, notes)

    # ---- bench
    if args.bench:
        log("bench/ct-1200 (1200 slices @ 0.25 mm) ...")
        out = root / "bench" / "ct-1200"
        key = "bench/axial-025"
        series_uid = make_uid(f"series/{key}")
        bframe = make_uid("for/bench")
        n = 1200
        for j in range(n):
            f = j * 0.25
            k0 = min(int(f), NZ - 1); k1 = min(k0 + 1, NZ - 1); w = f - k0
            sl = np.rint(stored[k0] * (1 - w) + stored[k1] * w).astype(np.uint16) if w else stored[k0]
            inst = n - j
            write_ct_slice(out / f"IM{inst:06d}", sl, study=BENCH_STUDY, series_key=key, series_uid=series_uid,
                           series_no=2, desc="Axial 0.25mm (bench)", frame_uid=bframe, inst=inst,
                           z=Z0 + f, thickness=0.5)

    # ---- verify
    log("verifying ...")
    reports: list[FolderReport] = []
    ref_desc = "source volume"
    reports.append(verify_folder(root, "ct-phantom", ref=stored[::-1], ref_desc=ref_desc))
    reports.append(verify_folder(root, "ct-phantom/axial-5mm", ref=slab5[::-1], ref_desc=ref_desc))
    reports.append(verify_folder(root, "pet-phantom"))
    reports.append(verify_folder(root, "mr-brain", ref=mr[::-1], ref_desc=ref_desc))
    sub = stored[TS_FIRST_K:TS_FIRST_K + TS_N][::-1]
    for folder, ts, desc, method in TS_VARIANTS:
        if not (root / "ts" / folder).exists():
            continue
        if folder == "jpeg-baseline-8bit":
            reports.append(verify_folder(root, f"ts/{folder}", ref=window_8bit(sub), ref_desc="8-bit windowed source", lossy=True))
        else:
            reports.append(verify_folder(root, f"ts/{folder}", ref=sub, ref_desc=ref_desc, lossy=(folder == "j2k-lossy")))
    rep = verify_folder(root, "multiframe")
    reports.append(rep)
    reports.append(verify_folder(root, "cd-media", recursive=True))
    try:
        from pydicom.fileset import FileSet
        fs = FileSet(pydicom.dcmread(root / "cd-media" / "DICOMDIR"))
        pats = sorted({str(i.PatientID) for i in fs})
        reports[-1].extra = (f"DICOMDIR: {len(fs)} image records, {len(fs.find_values('StudyInstanceUID'))} studies, "
                             f"patients {pats}; junk files AUTORUN.INF/VIEWER.EXE/README.TXT ignored")
    except Exception as e:
        reports[-1].extra = f"DICOMDIR parse FAILED: {e}"
        reports[-1].failed = True
    with zipfile.ZipFile(root / "archives" / "study.zip") as z:
        bad = z.testzip()
        names = z.namelist()
    zr = FolderReport("archives", 1, (root / "archives" / "study.zip").stat().st_size, "zip (deflate)", "-", "-",
                      "-", f"zip test {'OK' if bad is None else 'FAILED: ' + bad}; {len(names)} entries incl. cd-media/DICOMDIR",
                      failed=bad is not None)
    reports.append(zr)
    if (root / "real").exists():
        reports.append(verify_folder(root, "real", skip_names=("SOURCES.txt",)))
    if args.bench:
        reports.append(verify_folder(root, "bench/ct-1200"))
    elapsed = time.time() - t0
    write_manifest(root, reports, notes, args, elapsed)
    for r in reports:
        log(f"{r.folder:28s} {r.nfiles:5d} files {human(r.nbytes):>9s}  {r.syntaxes:28.28s}  "
            f"p10 {r.part10:8s} dcmdump {r.dcmdump:10.10s} {r.decode}  {r.extra}")
    log(f"done in {elapsed:.0f}s -> {root}")
    failed = [r.folder for r in reports if r.failed]
    if failed:
        log(f"VERIFICATION FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
