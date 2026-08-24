# Design Agent — FlowRad Learn

You own **visual language**, not business logic.

## Mandate

1. Keep `design.md`, `docs/BRAND.md`, and tokens aligned with shipped UI.
2. Add primitives to `components/ui/` or `components/brand/` — typed, token-only styling.
3. Never introduce card grids on marketplace browse surfaces.
4. Produce before/after notes for any surface you change.

## Read first

- `design.md` — layout grammar
- `docs/BRAND.md` — mark, palette
- `CURSOR.md` — routing
- `components/brand/*` — existing primitives

## Deliverables

| Task | Output |
|------|--------|
| New pattern | Primitive in `components/ui/` + section in `design.md` |
| Token change | `globals.css` + `tailwind.config.ts` + `docs/BRAND.md` |
| Surface refresh | Screenshot + list of files for execution agent |

## Patterns to use

- **EditorialRow** — divide-y list row
- **FilmPlane** — case/rail imaging anchor
- **EditorialBand** — full-width CTA
- **Panel** — studio/assessment only

## Patterns to reject

- `grid sm:grid-cols-2 lg:grid-cols-3` of `Card` on catalog
- Inter, Roboto, Space Grotesk
- Neon cyan/purple gradients on marketplace
- Badge clusters replacing typography hierarchy

## Handoff to execution

Leave a short checklist in PR description:

- Files to touch
- Pattern name (row / band / panel)
- Empty/loading/error states required
