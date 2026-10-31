# Tutor mode: ink, cards, and 3D

The bar is a teacher at a lightbox: one confident mark at a time, drawn on the
sentence that names it, a readable label in the black beside the body, and a
3D view that looks like a product shot, not a schematic.

## Ink on the CT

`components/student/SketchStage.tsx` draws the tutor's marks as SVG over the
Cornerstone viewport.

- **Hand-drawn, not geometric.** `lib/inkStroke.ts` builds the centreline a
  person would draw: a loop that starts near ten o'clock, wobbles, drifts
  outward and overshoots its start; an arrow as a bowed shaft then two head
  ticks; a leader that wavers. `perfect-freehand` turns it into a
  pressure-tapered outline. Noise is seeded by mark id, so a camera move
  re-projects the same stroke instead of drawing a new scribble.
- **Drawn in by a moving pen.** Each frame renders the first `p` of the
  centreline with an open tip, eased brisk-in/brisk-out, 0.4–0.8 s per mark.
  Under `prefers-reduced-motion` marks appear complete.
- **Readable on any window.** A dark halo under the ink and a soft glow over it.
  Authored ink is marker yellow (`ink`); a learner tap is rose
  (`ink-uncertain`), drawn broken and labelled "Uncertain · your tap, not an
  authored finding". No blue on the image: the viewer toolbar, laser, finding
  marker and calipers use white or ink.
- **Locked to anatomy.** Every point is an image fraction projected through the
  live camera each frame (`useViewFrame`). Zoom, pan, scroll and window never
  move a mark off its lesion; a finding's slice window hides it elsewhere. The
  laser, finding marker and calipers sit in `ImageRectLayer`, the displayed
  image's rectangle, so they no longer land in letterbox space.
- **One mark at a time.** `keepWith` (in `lib/sketchMarks.ts`): a new stroke
  replaces the previous stroke, another finding's ink leaves (it fades), and a
  card stays with its finding. Reaching a finding draws a ring, then after the
  hand lifts, the leader and card. No arrow unless the tutor asks for one.

## Cards

Solid near-black (`bg-annotation`), white Inter, 13–15 px, an ink overline
naming the template (Sign, Differential, Mechanism). HTML is never accepted
from the model.

`lib/cardPlacement.ts` seats the card. It samples the rendered slice into a
luminance grid, flood-fills dark cells connected to the viewport edge
(letterbox and outside air reach the border; the lungs do not), and scores
seats around the ring: whole-card-in-black first, then darkness, then a short
leader. It tries 256/224/196/180 px widths so a slim card in the black beside
the body beats a wide one across the room. It never covers the ring, the
toolbar, the slice readout or the full-screen control. Seating happens as the
leader starts, after the slice has painted. The seat is an image point, so the
card rides with the anatomy; if a zoom pushes it off screen or onto the ring,
it reseats once the camera settles.

## Teaching flow

The guided script is orient → search → lean-in → commit → pearl (with the
check-in before the commit). `playTeachingGuide` now reports each beat
(`onBeat`): the ring is drawn when the commit's laser lands ("Look here"), the
card arrives with the pearl's first word. The live tutor's tools are unchanged:
`draw_circle`, `draw_arrow`, `place_card` accept only an authored finding id or
the learner's tap with `uncertain:true`; `jump_to_key_view` seats the authored
slice, window and zoom. Both prompts tell the model: one mark at a time, on the
sentence that names it, then one short question to check understanding.

## 3D

`Show in 3D` opens a full-viewport dialog (Escape closes). `AnatomyStage`:

- TotalSegmentator surfaces of this CT, in patient RAS millimetres, mapped by
  one matrix to the radiological view (superior up, patient left on screen
  right). Vertices are welded and normals smoothed at load (the GLB ships none).
- Image-based studio lighting from drei `Lightformer`s (no HDR download), key
  and rim lights, ACES tone mapping in the post chain.
- Lungs are milky frosted glass (`MeshPhysicalMaterial` transmission,
  roughness, attenuation, clear coat). Heart, aorta, airway, liver, kidneys and
  spine are clear-coated PBR tissue.
- The active finding is an HDR core that blooms, a halo, a slow pulse ring and
  the same near-black card with an ink leader.
- Fly-in from the finding, ease out to a three-quarter view, slow auto-rotate
  until the learner drags. Exploded view is a spring.

## Test case

`case-lidc-nodule-search`, finding 2. In this LIDC-IDRI series, stack index 49
is upper abdomen, below the lungs; the old marker sat on the stomach. The
finding now uses the LIDC readers' own DICOM-SEG (nodule 2, three readers):
stack index 6 (shown 7/65), centre (0.680, 0.494), about 5 mm, solid, left
upper lobe apex. It is present on that slice and gone above and below, which is
the "nodule, not a vessel on end" teaching point.

A store seeded before this change keeps the old finding until it is re-seeded.

## Running it locally

```bash
python3 scripts/serve_local_ct.py   # LIDC_CT_DIR=<dir with NNN.dcm + metadata.json>
```

```bash
ORTHANC_URL=http://127.0.0.1:8042 ORTHANC_USER=flowrad ORTHANC_PASSWORD=local npm run dev
```

```bash
SKETCH_SHOTS_DIR=docs/screenshots/tutor-mode npx playwright test e2e/sketch-overlay.spec.ts
```

The series is public on the Imaging Data Commons (`idc-index`, collection
`lidc_idri`, SeriesInstanceUID `1.3.6.1.4.1.14519.5.2.1.6279.6001.314917368146772872954571551463`).

## Asset pipeline

Unchanged: `scripts/anatomy_asset_pipeline.py` (marching cubes, smoothing,
decimation, tissue maps) and `scripts/compress_anatomy_glb.mjs` (meshopt).
