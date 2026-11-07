# UI audit — student, studio, viewer

Date: 2026-10-25. Read against the code in `components/CornerstoneViewer.tsx`,
`components/student/StudentSession.tsx`, `components/record/RecordStage.tsx`,
and `components/author/RecordingStudio.tsx`. Scores are harsh on purpose.
A 7 is “a radiologist would use this without apologizing for it.” Nothing here
is a 7.

FlowRad is a teaching product whose only irreplaceable surface is the image.
The image is the one place the chrome keeps sitting.

## References actually looked at

These are the patterns this pass stole from. Not whole apps — interaction and
placement.

- **OHIF longitudinal toolbar**
  ([`modes/longitudinal/src/index.ts`](https://github.com/OHIF/Viewers/blob/68bbe0b1a5f5dae6672e3623b7968e0a0f2867f2/modes/longitudinal/src/index.ts),
  [`toolbarButtons.ts`](https://github.com/OHIF/Viewers/blob/d8ef36ed24466988586e19b855d2bbb86f8c657a/modes/longitudinal/src/toolbarButtons.ts)).
  The primary bar is a short row: measurement split (Length on the face,
  ellipse / rectangle / arrow in the menu), Zoom, Pan, Window Level, then
  More. Every button has a label. Tools live in the application toolbar, not
  painted on the pixels. Invert, probe, and angle are in More, not peers of Pan.
- **OHIF viewport overlay**
  ([`CustomizableViewportOverlay.tsx`](https://github.com/OHIF/Viewers/blob/master/extensions/cornerstone/src/Viewport/Overlays/CustomizableViewportOverlay.tsx)).
  Slice index and `W` / `L` are corner readouts (`InstanceNumberOverlayItem`,
  `VOIOverlayItem`). [PR #5041](https://github.com/OHIF/Viewers/pull/5041)
  switches overlay text and shadow so it stays readable on light and dark
  backgrounds. [PR #3963](https://github.com/OHIF/Viewers/pull/3963) puts named
  window presets (soft tissue, lung, bone) in a viewport menu.
- **Cornerstone3D stack annotation example**
  ([`stackAnnotationTools/index.ts`](https://github.com/cornerstonejs/cornerstone3D/blob/c8ce18c7/packages/tools/examples/stackAnnotationTools/index.ts)).
  The tool control is `#demo-toolbar`, a sibling of the 500×500 element.
  “Left click to use selected tool” is another sibling. Nothing instructional
  is drawn on the canvas.
- **Weasis** ([`nroduit/Weasis`](https://github.com/nroduit/Weasis)).
  A labeled tool palette beside the viewport and a status line that says what
  the mouse will do. The image stays an image.

FlowRad’s viewer chrome is worse than all four. OHIF and Weasis are diagnostic
workstations and still leave the anatomy alone. This app is a *teaching*
product and was covering the finding with its own UI.

## Scores (as found, before this PR)

This pass does not claim any surface is now world-class. The table is the
product that was in the tree. The last section is what actually changed.

| Surface | Score | Why it is this low |
|---|---|---|
| DICOM viewer chrome | **3 / 10** | Ten equal icon buttons floating on the image. Window/Level and Invert are the same glyph. No slice index, no W/L numbers. Student and locate modes hide the toolbar entirely. |
| Student learn path | **4 / 10** | The right idea (full-bleed image, voice, a tour) buried under a second product: badges, a caption card, Teach/Exam, and a mic dock all stuck on the pixels. Finding dots are 6px tall. |
| Teacher record / studio | **4 / 10** | The code’s own primary loop (click → dictate → save) is the secondary button. The filled primary is the optional walk-through. The tool bar sits under the annotate hit-layer, so it is dead while you place a finding. |
| Design system consistency | **5 / 10** | Tokens, `Button`, `Badge`, and `Modal` are real. The session then hand-rolls a second system at 10px, and `--text-muted` (`#6e675e`) is about 3.5:1 on the canvas. |
| Mobile | **3 / 10** | Series navigator is `display: none` below `md`. What remains is a pile of overlays on a phone-sized image. |

## Viewer chrome

`CornerstoneViewer` (before this PR) rendered one wrapping cluster,
`absolute left-3 top-3`, over the square: a FlowRad mark, then all ten
`PRIMARY_TOOLS` as 32×32 icon buttons, then presets, invert, reset, clear.
`ToolIcon` mapped both `WindowLevel` and `Invert` to Lucide `Contrast`.

That fails discoverability (no labels, two identical icons), hierarchy (Length
and Pan are the same size as the brand mark), and anatomy (the cluster covers
the corner where a radiologist looks first). On a narrow studio column the
cluster wraps into a second row and covers more lung.

Worse, `RecordStage` puts a full-square annotate `<button>` on top of that
cluster (`z-20` hit layer after the viewer in the DOM). While “click to
annotate” is on — the default — the toolbar cannot be clicked. The tools are
visible and dead exactly when the teacher is marking.

`StudentViewer` and `LocateStage` pass `showToolbar={false}`. Left-drag is
Window/Level, wheel scrolls, right-drag zooms, because those bindings are set
in the tool group. Nothing in the student UI says so. A resident who does not
already know a PACS mouse map cannot find the product.

There is no slice counter and no window/level readout anywhere. OHIF treats
those as viewport furniture. Without them you cannot tell a student “you are
on slice 40, lung window” without saying it out loud.

Mouse bindings themselves are in good shape. `setLeftTool` correctly strips
the previous primary binding (see the comment in `CornerstoneViewer` and
`lib/toolBindings.ts`). This audit does not touch that. The failure is the
chrome around a working engine.

## Student learn path

`StudentSession` is a full-viewport image with four layers glued on top:

1. Top HUD (`z-50`): Library link, title badge, modality badge, finding badge,
   viva score, and five 28px icon buttons (`IconButton` `size="sm"`).
2. `TutorCaption`, a card at `bottom-40`, repeating the finding index and
   putting the teaching sentence over the lower thorax.
3. A synthetic-voice line at `top-12`, 10px, `text-muted/80`.
4. A bottom dock (`z-40`) that is `inset-x-0`, so the empty parts of the row
   still eat pointer events across the bottom of the image. Finding progress
   is `h-1.5` (6px) buttons. The hint under it is `text-[10px]`.

The dock and the tutor rail are both `z-40`. The dock is later in the DOM, so
it covers the rail’s composer. You cannot reliably type to the tutor while the
dock is up.

Mode hierarchy is two products. The dock offers Teach and Exam. The rail offers
Teach, Report, Socratic, Free, and Viva as equal tabs. `intentFromMode` treats
only viva and socratic as Exam. A teacher cannot explain this screen in one
sentence.

Series: the student rail is `w-14` (56px). `SeriesNavigator` is built for a
real rail — 56px thumbnail, description, modality badge — and the record page
gives it `w-44`. Crushed to 56px, the labels cannot exist. Below `md` the rail
is `hidden`, with no replacement. Multi-series cases are single-series on a
phone.

What is already good and should not be thrown out: push-to-talk is a real
`MicButton`, hotkeys exist, compare exists, the tour can pause, exam locate
gates its hit-layer so it does not block scroll (that fix is in
`LocateStage` / `StudentViewer`). The bones of a reading room are here. The
furniture is on the patient.

## Teacher studio / record

`RecordingStudio` states the primary loop in a comment: click the finding,
dictate, save. The transport card does the opposite. “Click to annotate” is
`variant="secondary"` (or `ghost` once you leave the mode). “Record
walk-through” is the default filled `Button`. The optional demo path looks
like the product.

Above that, the page is an admin form: breadcrumbs, display-serif title,
three badges, a stepper, then a 400px side column with a sequence board and
three more tabs (Click path / Speak once / Walk-through). The viewer is the
largest object and still feels like an embed.

`RecordStage` HUDs are small translucent chips (`text-[11px]` annotate hint,
`text-xs` REC badge on `bg-elevated/90`). On a bone window that chip
disappears. The replay bar sits on the bottom of the square with no scrim.

The pulsing record frame around the viewer is one of the few honest signals
in the studio. Keep it.

## Design system and accessibility

`app/globals.css` and `components/ui/` are a coherent reading-room system:
warm charcoal, one amber accent, Inter, display serif on titles. That is not
the problem.

The problem is the session and the viewer do not use it when it matters.

- `--text-muted` `#6e675e` on `--canvas` `#0e0d0c` is roughly 3.5:1. It is the
  color of every hint, including the only sentence that explains the mouse.
- Body text at `text-[10px]` and `text-[11px]` shows up on the caption kicker,
  the voice disclosure, the dock hint, measurement labels, and the annotate
  chip. Teaching text should not be 10px.
- Hit targets: finding dots 6×6, tool buttons 32×32, session icon buttons
  28×28. A reading room is used with a hand on a mouse, often not precisely.
- Segmented Teach/Exam controls are hand-rolled `<button>`s with no
  `aria-pressed`. The design system already has `Tabs` and `Button`.
- Radix is present (`Modal` is a real Dialog). The viewer menus were not;
  they were a `div` with `role="menu"` and no keyboard moves. This pass did
  not build a full menu widget. It did make the items taller and labeled.

Imaging stays `#000`. That part is correct. Do not “card” the viewport.

## What this PR changes

Before → after, only the surfaces above. Tool bindings, scroll, window/level,
zoom, pan, and measurement drawing are untouched.

| Before | After |
|---|---|
| Tool cluster floating on the image, including a brand mark. Annotate mode swallows the clicks. | Docked bar **under** the square (`chrome="dock"`). Record/demo/studio. The annotate layer stays on the square; the tools are outside it. |
| Ten peer icons. W/L and Invert share `Contrast`. | Navigate (W/L, Pan, Zoom, Scroll) with short labels. Length on the face; Angle, Ellipse, Rect, Probe, Arrow in a menu. Invert is `SunMoon`, W/L is `Blend`. Named presets stay, hints read `W 400  L 40`. |
| No slice or W/L on screen. | Corner readout, top-left: `42 / 240` and `W … L …`, white on `bg-black/80` so it survives bone and air. Same idea as OHIF’s overlay, with a scrim instead of sampling the WebGL background. |
| Student viewer has no tools. | `chrome="edge"`: the pane fills, the same bar sits on the **bottom edge of the pane**, not on the pixels. Both compare panes get it, so the images stay aligned. |
| Session chrome (library, caption, mic, 6px dots) painted on the image. The dock blocks the rail composer and the bottom of the stack. | Header and footer are real bars. The image is only the image. Caption is `text-sm` in the footer, clamped to three lines. Progress buttons are 32px with a visible tick inside. Teach/Exam is `aria-pressed` and 36px tall. Continue, when the tour is paused, is the filled primary. |
| Series rail 56px and gone on mobile. | Desktop rail is `w-44`, the width `SeriesNavigator` was designed for. Phones get a horizontal series strip in the header. |
| REC and “click the finding” chips wash out. | Black scrim, white type, `text-sm` / `text-xs`. |
| “Record walk-through” looks like the main action. | “Click to annotate” is the filled button, with a line that says it is the primary path. Walk-through is secondary. |
| Marker is a 2px amber ring. Amber on cortical bone fails. | White ring, black hairline, amber outer ring, white center dot. The pulse is a child, so it does not wipe the ring. Measurement labels are white on black. |
| `#6e675e` muted text. | `--text-muted` moved to `#8f877c` (~5.5:1 on the canvas, still darker than secondary). |
| Locate stage says “search the study” and hides the mouse map. | The line now says wheel / right-drag / left-drag. Toolbar stays off so the click layer geometry does not change. |
| Hotkeys omit the mouse. | Wheel, right-drag, middle-drag, and left-drag are in the cheat sheet. |

## Backlog — not in this PR

Ordered by how much a radiologist would feel it. None of this is viewer-engine work.

> **Update 2026-10-30 (`claude/viewer-perf`).** Items **2** and **10** are
> closed, and **3** is half closed. The slice scrollbar, the viewport keyboard
> (1–5 tools, arrows/PageUp/PageDown/Home/End, +/−, I, 0, Shift+digit presets)
> and a cine transport now ship; see `lib/sliceScrollbar.ts`,
> `lib/viewerHotkeys.ts`, `lib/cinePlayer.ts`. What is still open in #3 is the
> real **menu widget** — the toolbar's preset and measurement menus remain
> pointer menus with no arrow keys or typeahead. Everything else below is
> untouched and still accurate. Viewer *performance* work from the same branch
> is in `docs/VIEWER_BENCHMARK.md`.

> **Update 2026-10-31 (`claude/viewer-ux`).** **#3** is closed — the toolbar
> menus are Radix menus (arrow keys, typeahead, Escape) and every control's
> tooltip names its shortcut. **#7** is closed in the standalone viewer: hanging
> layouts share one toolbar that follows the outlined pane (student compare
> still has two bars). **#10**'s layout half is closed (1×1 / 1×2 / 2×1 / 2×2;
> magnify still open). **#12** is enforced by type: the corner overlay reads an
> allow-list of series fields (`lib/dicomOverlay.ts`), so a patient name cannot
> reach the screen. Details and the OHIF / Pacsbin / Stradus comparison are in
> `docs/VIEWER_BENCHMARK.md` §4a.

1. **One mode model.** The rail still has five equal tabs (Teach, Report,
   Socratic, Free, Viva) beside a Teach/Exam switch. Pick two intents on the
   surface and bury the rest. Do not do this as a visual tweak — it changes
   what `useStudentSession` thinks the product is.
2. ~~**Slice scrollbar** on the right edge of the stack (OHIF
   `ViewportSliceProgressScrollbar`). Wheel-only scroll is invisible.~~
   **Done** — `lib/sliceScrollbar.ts`. The thumb's height is the share of the
   series one slice represents, so series length is legible at a glance.
3. **Tool shortcuts** (1–4 for W/L, pan, zoom, scroll) — **done**, bound to
   the now-focusable viewport (`lib/viewerHotkeys.ts`) rather than to `window`,
   so they cannot fight the session's global keys. **Still open:** a real menu
   widget (arrow keys, typeahead). The menus are still pointer menus.
4. **Recording studio is still a form around a viewer.** Collapse the stepper,
   the transport card, and the three capture tabs into one column whose first
   action is the viewer. The side sequence board can stay.
5. **Caption length.** Three lines in the footer will clip a real teaching
   paragraph. The full text belongs in the rail, with the footer showing the
   current sentence only — that needs a split from the tutor, not a CSS clamp
   forever.
6. **Catalog, studio home, admin, course pages.** They use the token system
   and are calmer than the session, but they are still generic SaaS: equal
   cards, equal tabs, no reading-room density. Out of scope here.
7. **Compare is two toolbars.** Correct for independent windowing, noisy
   visually. A single bar that targets the focused pane is the OHIF model and
   needs an active-viewport notion we do not have.
8. **Mobile layout is honest but tall.** Header + series strip + image + tool
   bar + footer will crush the image on a phone. A real phone layout would
   hide the tool captions behind one “Tools” button. Not done.
9. **`IconButton` `sm` is still 28px** in the tutor rail. Bump the size token
   or stop using `sm` for primary session actions.
10. ~~**No cine**~~ — **done** (`lib/cinePlayer.ts`): play/pause plus a frame
    rate seeded from the series' own CineRate, hidden on a series too short to
    loop, and it stops when the reader touches the stack. **Still open: no
    hanging-protocol layout, no magnify.** Both are in the prioritised list in
    `docs/VIEWER_BENCHMARK.md` §4.
11. **Marker callout.** The ring is legible. It still does not say the finding
    name, and it has no leader line that dodges the abnormality. That is a
    design, not a border.
12. **De-identification burn-in.** Corner readouts must never grow a patient
    name. When de-id lands, the overlay list stays slice and W/L only.

## Explicitly not touched

Cloud Run, the eval harness, `teachingGuide`, tool-binding math, DICOMweb,
and auth. Scroll, window/level, zoom, pan, and measurement tools bind the
same way they did before this change.
