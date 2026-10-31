#!/usr/bin/env python3
"""Turn a de-identified CT into smoothed organ GLBs.

Reads a TotalSegmentator multilabel NIfTI (produced with --fast --ml) and
writes decimated, Laplacian-smoothed meshes plus a manifest the 3D panel
loads. Meshes are in a centred scene. Finding markers are the teacher
points on the anatomically ordered stack, converted with the same affine.

Usage:
  python3 scripts/segment_ct_to_glb.py \
    --seg data/lidc-seg.nii \
    --dicom data/lidc-ct \
    --metadata data/lidc-ct/metadata.json \
    --case seed/case-lidc-nodule-search.json \
    --glb public/anatomy/lidc-organs.glb \
    --manifest public/anatomy/lidc-organs.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import fast_simplification
import nibabel as nib
import numpy as np
import pydicom
import trimesh
from scipy import ndimage
from skimage.measure import marching_cubes
from totalsegmentator.map_to_binary import class_map


GROUPS = [
    ("right-lung", "Right lung", ["lung_upper_lobe_right", "lung_middle_lobe_right", "lung_lower_lobe_right"], 9000),
    ("left-lung", "Left lung", ["lung_upper_lobe_left", "lung_lower_lobe_left"], 8000),
    ("heart", "Heart", ["heart"], 5500),
    ("aorta", "Aorta", ["aorta"], 4500),
    ("trachea", "Trachea", ["trachea"], 2800),
    ("liver", "Liver", ["liver"], 7000),
    ("right-kidney", "Right kidney", ["kidney_right"], 3200),
    ("left-kidney", "Left kidney", ["kidney_left"], 3200),
    ("spine", "Spine", [name for name in class_map["total"].values() if name.startswith("vertebrae_")], 9000),
]


def label_ids(names: list[str]) -> list[int]:
    inverse = {name: idx for idx, name in class_map["total"].items()}
    return [inverse[name] for name in names if name in inverse]


def mesh_from_mask(mask: np.ndarray, affine: np.ndarray, face_budget: int) -> trimesh.Trimesh | None:
    if int(mask.sum()) < 80:
        return None
    smooth = ndimage.gaussian_filter(mask.astype(np.float32), sigma=0.85)
    if smooth.max() < 0.2:
        return None
    try:
        verts, faces, _normals, _values = marching_cubes(smooth, level=0.35, step_size=1)
    except (ValueError, RuntimeError):
        return None
    if len(faces) < 20:
        return None
    hom = np.c_[verts, np.ones(len(verts))]
    world = (affine @ hom.T).T[:, :3]
    mesh = trimesh.Trimesh(vertices=world, faces=faces, process=True)
    trimesh.smoothing.filter_laplacian(mesh, iterations=10, lamb=0.45)
    if len(mesh.faces) > face_budget:
        verts, faces = fast_simplification.simplify(
            np.asarray(mesh.vertices),
            np.asarray(mesh.faces),
            target_count=face_budget,
        )
        mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=True)
    mesh.fix_normals()
    return mesh


def stack_order(metadata: list[dict]) -> list[dict]:
    def key(item: dict) -> float:
        pos = item.get("00200032", {}).get("Value")
        iop = item.get("00200037", {}).get("Value")
        if not pos or not iop or len(pos) < 3 or len(iop) < 6:
            return 0.0
        rx, ry, rz, cx, cy, cz = (float(v) for v in iop[:6])
        normal = (
            ry * cz - rz * cy,
            rz * cx - rx * cz,
            rx * cy - ry * cx,
        )
        return sum(float(pos[i]) * normal[i] for i in range(3))

    return sorted(metadata, key=key, reverse=True)


def patient_to_ras(point: np.ndarray) -> np.ndarray:
    # DICOM LPS → NIfTI RAS, matching nibabel's world affine.
    return np.array([-point[0], -point[1], point[2]], dtype=np.float64)


def finding_point(ds, x_pct: float, y_pct: float) -> np.ndarray:
    iop = np.array(ds.ImageOrientationPatient, dtype=np.float64)
    ipp = np.array(ds.ImagePositionPatient, dtype=np.float64)
    row = iop[:3]
    col = iop[3:]
    spacing = [float(v) for v in ds.PixelSpacing]
    col_index = x_pct * (int(ds.Columns) - 1)
    row_index = y_pct * (int(ds.Rows) - 1)
    lps = ipp + row * spacing[1] * col_index + col * spacing[0] * row_index
    return patient_to_ras(lps)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seg", type=Path, required=True)
    parser.add_argument("--dicom", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--case", type=Path, required=True)
    parser.add_argument("--glb", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()

    img = nib.load(str(args.seg))
    data = np.asanyarray(img.dataobj)
    affine = img.affine
    scene = trimesh.Scene()
    structures = []
    centroids = []

    for sid, label, names, budget in GROUPS:
        ids = label_ids(names)
        mask = np.isin(data, ids)
        mesh = mesh_from_mask(mask, affine, budget)
        if mesh is None:
            print(f"skip {sid}")
            continue
        mesh.metadata["name"] = sid
        scene.add_geometry(mesh, node_name=sid, geom_name=sid)
        center = mesh.vertices.mean(axis=0)
        centroids.append(center)
        structures.append({"id": sid, "node": sid, "label": label, "world": center.tolist()})
        print(f"{sid}: {len(mesh.faces)} faces")

    if not structures:
        raise SystemExit("no meshes")

    origin = np.mean(centroids, axis=0)
    for name, geom in scene.geometry.items():
        geom.apply_translation(-origin)

    args.glb.parent.mkdir(parents=True, exist_ok=True)
    scene.export(args.glb)

    metadata = stack_order(json.loads(args.metadata.read_text()))
    case = json.loads(args.case.read_text())
    # Files were saved in the original QIDO order. Map sorted metadata back to those files.
    original = json.loads(args.metadata.read_text())
    sop_to_file = {}
    for i, item in enumerate(original):
        sop_to_file[item["00080018"]["Value"][0]] = i

    findings = []
    for finding in case.get("findings") or []:
        marker = finding.get("marker") or {}
        slice_index = finding.get("sliceIndex")
        if slice_index is None or not marker:
            continue
        if slice_index < 0 or slice_index >= len(metadata):
            continue
        sop = metadata[slice_index]["00080018"]["Value"][0]
        ds = pydicom.dcmread(args.dicom / f"{sop_to_file[sop]:03d}.dcm", stop_before_pixels=True)
        world = finding_point(ds, float(marker["x_pct"]), float(marker["y_pct"]))
        findings.append(
            {
                "findingId": finding.get("id"),
                "label": finding.get("label"),
                "position": (world - origin).tolist(),
            }
        )

    manifest_structures = []
    for item in structures:
        world = np.array(item["world"]) - origin
        camera = world + np.array([180.0, 40.0, 220.0])
        manifest_structures.append(
            {
                "id": item["id"],
                "node": item["node"],
                "label": item["label"],
                "position": world.tolist(),
                "camera": camera.tolist(),
            }
        )

    manifest = {
        "source": "totalsegmentator",
        "caseId": case.get("caseId"),
        "glb": "/" + str(args.glb).split("public/", 1)[-1],
        "disclaimer": "Organs segmented from this de-identified LIDC-IDRI CT with TotalSegmentator (CPU, fast). Not a generic model.",
        "structures": manifest_structures,
        "findings": findings,
    }
    args.manifest.write_text(json.dumps(manifest, indent=2))
    print(f"wrote {args.glb} and {args.manifest}")


if __name__ == "__main__":
    main()
