# Finding localization & display state

## How clicks / pathology location are stored today

A finding’s **landing** is a FlowRad document fieldset — not a mutation of the
DICOM file in Orthanc:

| Field | Source of truth | Role |
|--------|-----------------|------|
| `studyInstanceUID` / `seriesInstanceUID` / `sopInstanceUID` | DICOM UIDs | Which pixels |
| `sliceIndex` | Stack index at click | Fast seek (SOP preferred when present) |
| `marker.{x_pct,y_pct}` | Overlay click `[0,1]` | Laser / click-the-finding |
| `windowWidth` / `windowCenter` | Live VOI at click (DICOM WW/WC) | Re-window so the lesion is visible |
| `track.events` (`voi`, `slice`, …) | Recorded walk-through | Exact retrace of teacher motion |

Pixels stay in Orthanc (DICOMweb). Teaching state lives in Mongo/JSON keyed by
those UIDs so de-id, multi-tenant authorship, and marketplace versioning stay
clean.

## Why we do **not** write markers into DICOM metadata

1. **Archive immutability** — Orthanc holds the de-identified study once; teaching
   overlays must not rewrite clinical objects on every edit.
2. **De-id / Safe Harbor** — private creator tags and burned-in annotations are
   PHI risk surfaces we already scrub on ingest.
3. **Multi-author** — several teachers can teach the same study; each Finding
   is a separate teaching unit.
4. **Right interop path later** — if we need PACS-portable overlays, emit
   **DICOM GSPS / Softcopy Presentation State** or an **SR** referencing the
   SOP — derived objects, not edits to the CT/MR instances.

“Use DICOM as much as possible” means: **identity + geometry from DICOM**,
**display VOI as DICOM WW/WC numbers**, **optional GSPS/SR export later** —
not stuffing clicks into `(gggg,eeee)` private tags on the image SOP.

## Window / level (the lung-nodule problem)

If the teacher marked a nodule in **lung window** and the resident is on
**bone**, a bare laser on the same slice is useless — the nodule is invisible.

So at annotate/save we persist `windowWidth` / `windowCenter` from the live
viewport (same semantics as DICOM `(0028,1051)` / `(0028,1050)`). On
`show_finding` / tutor drive, Cornerstone **eases** WW/WC with
`easeInOutCubic` (~500–750 ms) — it does **not** jump presets. Recorded
walk-throughs already stream dense `voi` events for an exact retrace.

The tutor may also call `set_window` with the authored WW/WC; that path uses
the same eased `setWindow`.

## Marker accuracy roadmap

Today `marker` is **viewport-overlay** `[0,1]` (works when zoom/pan match
authoring). Next hardening:

1. Store image-plane fractions using Columns/Rows (stable under pan/zoom).
2. Optionally store patient coordinates via `ImagePositionPatient` +
   `ImageOrientationPatient` + `PixelSpacing` for multiplanar landings.
3. Prefer `sopInstanceUID` over `sliceIndex` for prefetch and seating.

## Agent / realtime windowing

| Path | Behavior |
|------|----------|
| Guided `showState` | Slice snap (decode) then eased WW/WC + camera |
| Tutor `set_window` | Eased VOI tween |
| Recorded `track` replay | Snap per dense event (looks continuous) |
