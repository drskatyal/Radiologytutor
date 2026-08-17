# FlowRad Learn — Teaching Surfaces Design

This document governs the **author recording studio** and **student teaching
session**. Product chrome (catalog, studio lists, admin) follows `CLAUDE.md` §1.
These two surfaces are different: they are a **reading room**, not a dashboard.

## Product truth

FlowRad does **not** invent a search pattern. A radiologist authors a case by
clicking findings and dictating; that structured script is what the AI tutor
replays and narrates for the learner. The AI speaks, drives the viewer, and
moves a laser pointer to the author’s click coordinates — it teaches *from*
authored evidence.

## Authoring loop (target ≤ 5 minutes per case)

1. Open the study in the Cornerstone stage.
2. Scroll / window to the slice.
3. **Click** the finding → marker + popover.
4. **Dictate** with the mic → Gemini Flash returns `{ label, description, teachingPoints }`.
5. Review fields → **Save**. Marker is stored as normalized `[0,1]`.
6. Optional: Alt+X walk-through for a full cursor + VOI retrace students can replay.

Do not force a side-panel form as the primary path. The image is the workspace;
the popover is temporary.

## Student teaching loop

1. Viewer opens on finding 1.
2. If a recorded track exists → exact event replay + teacher audio + laser trail.
3. Else → camera tween, then **synthetic laser** approaches the stored marker.
4. Learner asks by voice (STT → tutor → TTS). Tutor tools: `show_finding`,
   `next_in_tour`, `prev_in_tour`, `set_window`, `point_to`.
5. Chat turns always show transcript then answer.

## Visual language (reading room)

- **Surfaces:** pure black imaging (`bg-imaging`); chrome `canvas` / `surface` /
  `elevated` from the token system. No purple gradients, no cream editorial
  brochure look, no floating promo cards on the image.
- **Accent:** one clinical cyan — laser, markers, primary actions only.
- **Typography:** Inter for UI; display serif only for catalog/course titles,
  never over the viewport HUD.
- **Density:** tight toolbars, tabular nums for slice/W/L, no empty hero panels
  beside the viewer.
- **Motion (intentional, ≤3):** (1) laser approach / comet trail, (2) marker
  pulse on land, (3) mic recording pulse. No decorative orb storms.
- **Controls:** real `<button>`s from `components/ui/`. Icon buttons need
  `aria-label`. No inline layout styles except dynamic left/top %.

## DICOM

- Archive: Orthanc. Browser: `/api/dicomweb` only.
- Prefer compressed transfer syntax in Orthanc; proxy caches frame URLs.
- Prefetch finding-ordered slices; never blank the imaging panel — skeleton.

## Anti-patterns

- Hardcoded center markers (`50%, 50%`) as the authoring default.
- Merging STT + tutor into one client call on the student path.
- Cards in the imaging hero / stat strips / pill clusters over the viewport.
- Pacsbin iframe as the live student path (legacy only).
