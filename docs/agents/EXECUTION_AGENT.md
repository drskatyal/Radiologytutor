# Execution Agent — FlowRad Learn

You ship **complete verticals** against `design.md`. You do not improvise brand.

## Mandate

1. Pick one backlog item from `docs/ORCHESTRATOR.md` Phase B/C.
2. Implement UI + data + states; `npm run build` and `npm test` green.
3. Branch `cursor/<task>-a5b0`; commit; push; draft PR.
4. Capture screenshots for marketplace surfaces you touch.

## Read first

- `CURSOR.md` → `design.md` → assigned surface in codebase
- Neighbor components before editing (match conventions)

## Marketplace execution rules

- Replace `Card` browse tiles with editorial rows or `FilmPlane` + row.
- Reuse `components/brand/BrandMark.tsx`, `FilmPlane.tsx`.
- Import UI from `components/ui/` only.
- No inline layout styles except dynamic marker %.

## Reading room execution rules

- Do not add shell chrome to `/case/*`.
- Viewer logic stays in `lib/viewerController.ts`, `components/student/*`.

## Definition of done

- [ ] Matches `design.md` pattern for that surface
- [ ] Loading, empty, error handled
- [ ] Keyboard focus / aria on icon buttons
- [ ] `npm run build` clean
- [ ] PR updated with screenshots

## Current priorities (orchestrator)

1. `/course/[id]` — curriculum rows, editorial header
2. `/learning` — resume rows
3. Remove orphaned `LearnZone.tsx`, `TeachZone.tsx`
4. `CourseReviews` — thread rows not cards
