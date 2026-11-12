#!/usr/bin/env python3
"""Game-asset pipeline for a de-identified CT segmentation.

Segmentation (TotalSegmentator --fast --ml)
  → marching cubes
  → Laplacian smooth
  → quadric decimate into LOD0 / LOD1 / LOD2
  → tileable tissue maps (albedo, normal, roughness, AO), the way a
    Material Maker graph would: value noise, directional fibre, pores
  → glTF with shared PBR materials

Compression (Draco or meshopt, KTX2 when toktx is installed) is the next
step: scripts/compress_anatomy_glb.mjs

This does not vendor Jolt, Terrain3D, or Material Maker. Those projects are
the reference for how a game team treats meshes and materials.
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
from PIL import Image
from scipy import ndimage
from skimage.measure import marching_cubes
from totalsegmentator.map_to_binary import class_map

from segment_ct_to_glb import (  # noqa: E402
    GROUPS,
    finding_point,
    label_ids,
    stack_order,
)

TISSUE = {
    "right-lung": "lung",
    "left-lung": "lung",
    "heart": "myocardium",
    "aorta": "vessel",
    "trachea": "cartilage",
    "liver": "liver",
    "right-kidney": "kidney",
    "left-kidney": "kidney",
    "spine": "bone",
}

BASE = {
    "lung": np.array([240, 196, 206], dtype=np.float32),
    "myocardium": np.array([142, 32, 48], dtype=np.float32),
    "vessel": np.array([196, 48, 58], dtype=np.float32),
    "cartilage": np.array([236, 224, 206], dtype=np.float32),
    "liver": np.array([124, 72, 48], dtype=np.float32),
    "kidney": np.array([138, 58, 66], dtype=np.float32),
    "bone": np.array([236, 230, 216], dtype=np.float32),
}


def tile_noise(size: int, frequencies: tuple[int, ...], seed: int) -> np.ndarray:
    """Periodic value noise. Each octave is a sum of sines so the tile repeats."""
    ys, xs = np.mgrid[0:size, 0:size]
    x = xs / size * 2 * np.pi
    y = ys / size * 2 * np.pi
    rng = np.random.default_rng(seed)
    acc = np.zeros((size, size), dtype=np.float32)
    weight = 0.0
    for octave, freq in enumerate(frequencies):
        phase = rng.random(4) * 2 * np.pi
        amp = 0.55 ** octave
        acc += amp * (
            np.sin(x * freq + phase[0]) * np.cos(y * freq + phase[1])
            + 0.6 * np.sin((x + y) * freq * 0.5 + phase[2])
            + 0.35 * np.cos(x * freq * 1.7 + phase[3])
        )
        weight += amp
    acc /= weight
    return acc


def soften(field: np.ndarray, sigma: float) -> np.ndarray:
    return ndimage.gaussian_filter(field, sigma, mode="wrap")


def height_for(tissue: str, size: int) -> np.ndarray:
    # Low-frequency mottling. High octaves read as raw meat once they tile
    # across a decimated organ, so each tissue stays a soft surface.
    if tissue == "lung":
        pores = soften(tile_noise(size, (3, 6), 3), 5)
        return np.clip(0.62 + 0.22 * pores, 0, 1)
    if tissue == "myocardium":
        fibre = soften(tile_noise(size, (2, 4), 9), 3)
        ys, xs = np.mgrid[0:size, 0:size]
        stripes = np.sin(xs / size * 2 * np.pi * 7)
        return np.clip(0.55 + 0.22 * fibre + 0.08 * stripes, 0, 1)
    if tissue == "liver":
        return np.clip(0.55 + 0.28 * soften(tile_noise(size, (2, 4), 21), 8), 0, 1)
    if tissue == "bone":
        return np.clip(0.7 + 0.18 * soften(tile_noise(size, (3, 7), 4), 4), 0, 1)
    if tissue == "vessel":
        return np.clip(0.72 + 0.16 * soften(tile_noise(size, (2, 4), 6), 6), 0, 1)
    if tissue == "cartilage":
        return np.clip(0.66 + 0.2 * soften(tile_noise(size, (2, 5), 8), 5), 0, 1)
    return np.clip(0.58 + 0.24 * soften(tile_noise(size, (2, 5), 2), 6), 0, 1)


def maps_for(tissue: str, size: int) -> dict[str, Image.Image]:
    height = height_for(tissue, size)
    base = BASE[tissue]
    pores = tile_noise(size, (13, 29), hash(tissue) % 10000)
    albedo = base * (0.78 + 0.28 * height)[:, :, None]
    if tissue == "lung":
        mottling = soften(pores, 4)
        albedo *= (0.9 + 0.1 * mottling)[:, :, None]
    albedo = np.clip(albedo, 0, 255).astype(np.uint8)

    gy, gx = np.gradient(height.astype(np.float32))
    normal = np.dstack((-gx * 0.85, -gy * 0.85, np.ones_like(gx)))
    normal /= np.linalg.norm(normal, axis=2, keepdims=True) + 1e-8
    normal_img = np.clip((normal * 0.5 + 0.5) * 255, 0, 255).astype(np.uint8)

    rough = np.clip(0.35 + 0.5 * (1 - height) + 0.08 * pores, 0.08, 0.95)
    if tissue == "vessel":
        rough = np.clip(rough * 0.55, 0.08, 0.45)
    if tissue == "bone":
        rough = np.clip(0.42 + 0.2 * pores, 0.2, 0.7)
    # glTF metallic-roughness: G = roughness, B = metallic.
    mr = np.zeros((size, size, 3), dtype=np.uint8)
    mr[:, :, 1] = (rough * 255).astype(np.uint8)

    cavity = ndimage.gaussian_filter(1 - height, 1.2)
    ao = np.clip(1 - cavity * 0.65, 0.25, 1)
    ao_img = np.clip(ao * 255, 0, 255).astype(np.uint8)

    return {
        "albedo": Image.fromarray(albedo, mode="RGB"),
        "normal": Image.fromarray(normal_img, mode="RGB"),
        "roughness": Image.fromarray(mr, mode="RGB"),
        "ao": Image.fromarray(ao_img, mode="L"),
    }


def decimate(mesh: trimesh.Trimesh, faces: int) -> trimesh.Trimesh:
    if len(mesh.faces) <= faces:
        return mesh
    verts, faces_out = fast_simplification.simplify(
        np.asarray(mesh.vertices, dtype=np.float32),
        np.asarray(mesh.faces, dtype=np.uint32),
        target_count=int(faces),
    )
    out = trimesh.Trimesh(vertices=verts, faces=faces_out, process=True)
    out.fix_normals()
    return out


def smooth_mesh(mask: np.ndarray, affine: np.ndarray) -> trimesh.Trimesh | None:
    if int(mask.sum()) < 80:
        return None
    # Z voxels are 5 mm, so blur them a little harder than x/y or the
    # marching cubes keeps the slice stairs.
    smooth = ndimage.gaussian_filter(mask.astype(np.float32), sigma=(0.85, 0.85, 1.15))
    try:
        verts, faces, _n, _v = marching_cubes(smooth, level=0.34)
    except (ValueError, RuntimeError):
        return None
    hom = np.c_[verts, np.ones(len(verts))]
    world = (affine @ hom.T).T[:, :3]
    mesh = trimesh.Trimesh(vertices=world, faces=faces, process=True)
    trimesh.smoothing.filter_laplacian(mesh, iterations=22, lamb=0.52)
    return mesh


def bind(mesh: trimesh.Trimesh, material: trimesh.visual.material.PBRMaterial, tile_mm: float) -> None:
    verts = np.asarray(mesh.vertices)
    uv = np.column_stack((verts[:, 0] / tile_mm, verts[:, 1] / tile_mm))
    mesh.visual = trimesh.visual.TextureVisuals(uv=uv, material=material)


def build_material(tissue: str, images: dict[str, Image.Image]) -> trimesh.visual.material.PBRMaterial:
    rough = 0.45 if tissue != "vessel" else 0.28
    return trimesh.visual.material.PBRMaterial(
        name=tissue,
        baseColorTexture=images["albedo"],
        normalTexture=images["normal"],
        metallicRoughnessTexture=images["roughness"],
        occlusionTexture=images["ao"],
        metallicFactor=0.0,
        roughnessFactor=rough,
        doubleSided=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seg", type=Path, default=Path("data/lidc-seg.nii"))
    parser.add_argument("--dicom", type=Path, default=Path("data/lidc-ct"))
    parser.add_argument("--metadata", type=Path, default=Path("data/lidc-ct/metadata.json"))
    parser.add_argument("--case", type=Path, default=Path("seed/case-lidc-nodule-search.json"))
    parser.add_argument("--glb", type=Path, default=Path("public/anatomy/lidc-organs.glb"))
    parser.add_argument("--manifest", type=Path, default=Path("public/anatomy/lidc-organs.json"))
    parser.add_argument("--textures", type=Path, default=Path("public/anatomy/tissues"))
    args = parser.parse_args()

    img = nib.load(str(args.seg))
    data = np.asanyarray(img.dataobj)
    affine = img.affine
    args.textures.mkdir(parents=True, exist_ok=True)

    materials: dict[str, trimesh.visual.material.PBRMaterial] = {}
    for tissue in sorted(set(TISSUE.values())):
        images = maps_for(tissue, 256)
        for kind, image in images.items():
            image.save(args.textures / f"{tissue}-{kind}.png")
        materials[tissue] = build_material(tissue, images)
        print(f"tissue {tissue}")

    scene = trimesh.Scene()
    structures = []
    centroids = []
    for sid, label, names, budget in GROUPS:
        mask = np.isin(data, label_ids(names))
        base = smooth_mesh(mask, affine)
        if base is None:
            print(f"skip {sid}")
            continue
        tissue = TISSUE[sid]
        lods = {
            sid: decimate(base.copy(), budget),
            f"{sid}__lod1": decimate(base.copy(), max(500, budget // 3)),
            f"{sid}__lod2": decimate(base.copy(), max(220, budget // 8)),
        }
        for name, mesh in lods.items():
            bind(mesh, materials[tissue], tile_mm=84.0)
            scene.add_geometry(mesh, node_name=name, geom_name=name)
        center = np.asarray(lods[sid].vertices).mean(axis=0)
        centroids.append(center)
        structures.append({"id": sid, "node": sid, "label": label, "world": center.tolist(), "lod1": f"{sid}__lod1", "lod2": f"{sid}__lod2"})
        print(f"{sid}: {[len(m.faces) for m in lods.values()]} faces")

    if not structures:
        raise SystemExit("no meshes")

    origin = np.mean(np.stack(centroids), axis=0)
    for geom in scene.geometry.values():
        geom.apply_translation(-origin)

    args.glb.parent.mkdir(parents=True, exist_ok=True)
    scene.export(args.glb)

    metadata = stack_order(json.loads(args.metadata.read_text()))
    original = json.loads(args.metadata.read_text())
    sop_to_file = {item["00080018"]["Value"][0]: i for i, item in enumerate(original)}
    case = json.loads(args.case.read_text())
    findings = []
    for finding in case.get("findings") or []:
        marker = finding.get("marker") or {}
        slice_index = finding.get("sliceIndex")
        if slice_index is None or not marker or not (0 <= slice_index < len(metadata)):
            continue
        sop = metadata[slice_index]["00080018"]["Value"][0]
        ds = pydicom.dcmread(args.dicom / f"{sop_to_file[sop]:03d}.dcm", stop_before_pixels=True)
        world = finding_point(ds, float(marker["x_pct"]), float(marker["y_pct"]))
        findings.append({"findingId": finding.get("id"), "label": finding.get("label"), "position": (world - origin).tolist()})

    manifest_structures = []
    for item in structures:
        world = np.array(item["world"]) - origin
        manifest_structures.append(
            {
                "id": item["id"],
                "node": item["node"],
                "lod1": item["lod1"],
                "lod2": item["lod2"],
                "label": item["label"],
                "position": world.tolist(),
                "camera": (world + np.array([180.0, 40.0, 220.0])).tolist(),
            }
        )
    manifest = {
        "source": "totalsegmentator",
        "caseId": case.get("caseId"),
        "glb": "/anatomy/lidc-organs.glb",
        "disclaimer": "TotalSegmentator on this de-identified CT, then smoothed, decimated, and shaded with tissue maps.",
        "structures": manifest_structures,
        "findings": findings,
    }
    args.manifest.write_text(json.dumps(manifest, indent=2))
    print(f"wrote {args.glb}")


if __name__ == "__main__":
    main()
