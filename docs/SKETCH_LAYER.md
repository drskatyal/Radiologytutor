# Sketch layer and anatomy assets

The tutor draws on the DICOM viewport in Three.js (react-three-fiber and drei),
loaded only when a mark exists. Marks are image fractions. The Cornerstone
camera projects them every frame, so zoom, pan, scroll, and windowing leave
the ring on the same anatomy. A finding’s slice window hides the mark
everywhere else.

`draw_circle`, `draw_arrow`, and `place_card` accept an authored finding id.
A coordinate the model invents is rejected. A learner tap is the other legal
target and is labelled **uncertain**. `jump_to_key_view` seats the authored
slice, window, and zoom. `place_card` is `differential`, `mechanism`, or
`sign`. HTML is stripped. Rough.js is only the handwritten underline on the
card and the wobble of the connector. The ring and the arrow are lit meshes.

Opening **Show in 3D** plays the current slice into the organ scene: the
captured frame sits on the axial plane of the finding, the same ring moves
to that point, and the camera eases out. Rotation keeps a little inertia.
**Exploded view** springs the organs apart along their centres and eases
them back. On a phone the scene is a bottom sheet, so the CT stays on screen.
The canvas caps device pixel ratio and drops to on-demand frames after the
intro.

## Asset pipeline

Jolt Physics, Terrain3D, and Material Maker are the reference for how a game
team treats collision, terrain, and materials. They are not linked into the
app. The anatomy path is:

1. TotalSegmentator `--fast` on CPU, multilabel NIfTI, from the de-identified
   LIDC-IDRI chest CT already in this case (65 slices). The study was read
   from the live app’s DICOMweb as the demo author. `case_mvqsdns246b5q` is
   not on that deployment; this published LIDC case is.
2. `scripts/anatomy_asset_pipeline.py` — marching cubes, Laplacian smooth,
   quadric decimation to LOD0 / LOD1 / LOD2, and tileable tissue maps
   (albedo, normal, roughness, ambient occlusion) for lung parenchyma,
   myocardium, vessel wall, cartilage, liver, kidney, and bone.
3. `scripts/compress_anatomy_glb.mjs` — meshopt (or `--codec draco`) and WebP.
   If `toktx` is on `PATH`, the same script can emit a KTX2 glTF. This
   environment has no KTX-Software binary, so the shipped textures are WebP
   inside the meshopt GLB.

```bash
python3 scripts/anatomy_asset_pipeline.py
node scripts/compress_anatomy_glb.mjs public/anatomy/lidc-organs.glb
```

The runtime file is `public/anatomy/lidc-organs.glb` with
`public/anatomy/lidc-organs.json`. The panel says the meshes come from this
study. A generic schematic remains only when that file does not match the
open case.
