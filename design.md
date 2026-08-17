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

**Path A — Speak once (preferred for multi-finding cases):**
1. Start continuous capture (mic).
2. Scroll / window / click while narrating every finding in one take.
3. Stop → Gemini returns transcript + segmented JSON findings with time ranges.
4. Review editable fields (label / description / teaching points) + suggested
   marker/slice → Save all. Each finding stores anchors (series/slice/marker).

**Path B — Click → dictate (single finding):**
1. Click the finding → marker + popover.
2. Dictate → Gemini fills fields.
3. Save with real `[0,1]` marker + series/slice.

Optional Alt+X walk-through remains for an exact cursor retrace.

## Student teaching loop (viva)

1. Full-bleed viewer; tutor rail collapsed by default.
2. Floating mic + progress dots; Space = push-to-talk.
3. Examiner AI speaks + drives viewer (`show_finding` / `point_to` / W/L).
4. Web-grounded questions when guidelines are needed.
5. Viva/guided: auto-advance to the next finding after TTS ends.
6. Expand rail for lesson cards / full transcript when wanted.

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
