# Sketch layer and schematic anatomy

The tutor draws with Rough.js on image fractions. A mark stays on the anatomy
through scroll, zoom, pan, and windowing, and only while the stack is inside
that finding's slice window.

`draw_circle`, `draw_arrow`, and `place_card` accept an authored finding id.
Coordinates the model invents are rejected. A learner tap is the other legal
target, and that stroke is labelled **uncertain**. `jump_to_key_view` seats
the finding's slice, window, and zoom. `clear_overlay` removes the ink.
Diagram cards are `differential`, `mechanism`, or `sign`. The model sends
plain text. HTML is stripped.

## Why this build has no TotalSegmentator mesh

TotalSegmentator did not run:

- This checkout has no CT series. `public/dicom/` holds two small MR objects,
  not the 65-slice case `case_mvqsdns246b5q` or the larger uploaded study.
- Those studies live on the deployed Cloud Run app. They were not copied
  into this environment, and a patient-derived mesh has to come from the
  de-identified study itself.
- TotalSegmentator needs PyTorch. It is not installed here, and there is no
  de-identified CT volume to segment on CPU.

The 3D panel therefore loads `public/anatomy/generic-schematic.glb`. That
file is an original low-poly schematic (lungs, heart, aorta, trachea, liver)
licensed CC0. The panel says it is generic and not this patient's CT.
Rebuild it with `npx tsx scripts/build-generic-anatomy.ts`.
