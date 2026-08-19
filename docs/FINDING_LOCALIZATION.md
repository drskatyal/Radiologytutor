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
| `measurements[]` | Length / Ellipse / Probe tools | Authored mm + mean HU for the tutor |
| `track.events` (`voi`, `slice`, `camera`, …) | Teacher capture | **AI reading digest** (how they scrolled/windowed) — not a student tape |

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
viewport (same semantics as DICOM `(0028,1051)` / `(0028,1050)`).

**Adaptive transitions** (`lib/voiTransition.ts`):

| |ΔWW| or |ΔWC| | Behavior |
|-----------------|----------|
| ≤ ~150 (mid of 100–200) | Eased scroll, duration scales with delta (radiologist feel) |
| > ~150 (e.g. bone → lung) | **Direct snap** — no multi-second tween through useless mid-windows |

Recorded walk-throughs stream dense `voi` / `slice` / `camera` events so we
can digest **how the consultant read**; students get AI-driven windowing, not
a VCR of those events.

## Measurements (Length + HU)

The viewer already has **Length**, **EllipticalROI**, **RectangleROI**, and
**Probe**. On finding save we snapshot them into `Finding.measurements`:

- Length → `lengthMm` (+ unit when PixelSpacing exists)
- Ellipse / rectangle ROI → `meanHu` / max / min / std + `areaMm2`
- Probe → point HU

The tutor may cite **only** these authored numbers. On student reveal (spoil),
`MeasurementOverlay` redraws calipers from stored `[0,1]` handles with the
authored mm / HU label — Layer 2 authenticity without re-running tools.

## What else makes a finding “awesome” (store next)

1. Image-plane / patient-space markers (stable under pan/zoom)
2. Bidirectional diameters (short + long axis)
3. Authored zoom/pan snapshot (already partially in Pacsbin state / track)
4. Optional GSPS/SR export for PACS interop
5. ~~Redraw measurement overlays on student reveal from `measurements.handles`~~ (done — `MeasurementOverlay`)

## Agent / realtime windowing

| Path | Behavior |
|------|----------|
| Guided `showState` | Slice snap, then adaptive VOI + camera |
| Tutor `set_window` | Adaptive VOI (scroll or snap) |
| Recorded `track` replay | Snap per dense event (looks continuous) |
