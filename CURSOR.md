# CURSOR.md — FlowRad Learn agent guide

Read this file **before every task**. It routes you to the right docs and constraints.

---

## What we're building

**FlowRad Learn** — the marketplace where radiologists teach radiology: real DICOM cases,
narrated walk-throughs, AI tutor on the study. Production bar = PACS vendor flagship teaching product.

---

## Read order

| Order | File | Why |
|-------|------|-----|
| 1 | `CURSOR.md` (this file) | Routing |
| 2 | `CLAUDE.md` | Engineering bar, data layer, workflows |
| 3 | `design.md` | **All UI/UX** — marketplace vs reading room |
| 4 | `docs/BRAND.md` | Mark, palette, anti-patterns |
| 5 | `docs/ORCHESTRATOR.md` | If you are design/execution/orchestrator agent |
| 6 | `ARCHITECTURE.md` | Marketplace roadmap, entities, phases |

---

## Design rules (non-negotiable)

### No generic AI SaaS

- No purple/cyan gradients, glow washes, glassmorphism, or neon accents.
- No **card grids** on marketplace browse surfaces (home, library, course lists, author lists).
- One accent: **film-marker amber** (`accent` token). Imaging = **pure black** (`bg-imaging`).

### Typography

- **Source Sans 3** — UI (`--font-sans`)
- **Source Serif 4** — display titles, wordmark (`font-display`)
- Tabular nums for slices, counts, progress

### Marketplace layout grammar

| Pattern | Use |
|---------|-----|
| **Editorial row** | Case/course/teacher browse lists — `divide-y`, hover `bg-surface/40` |
| **Film plane** | Case visual anchor — `components/brand/FilmPlane.tsx` |
| **Editorial band** | CTAs, certificates — `border-t`, no rounded card box |
| **Panel** | Studio forms, assessments — flat header divider |
| **Card** | Auth forms, admin modals only — **not catalog browse** |

### Reading room (`/case/*`)

- Shell hidden. Pure black viewer. See `design.md` § Teaching surfaces.
- No cards, stat strips, or marketing chrome on the viewport.

---

## Engineering rules

- No inline `style={{}}` for layout/color — Tailwind + `components/ui/`.
- Viewer behind `lib/viewerController.ts` / `lib/viewerSource.ts`.
- Data via `lib/cases.ts` only; `orgId`-scoped; Gemini server-side only.
- `npm run build` clean before commit. Branch: `cursor/<name>-a5b0`.

---

## Components map

```
components/brand/     BrandMark, Wordmark, FilmPlane
components/ui/        Primitives — add EditorialRow here when spec'd
components/catalog/   CaseCard (row), Rails (lists), Catalog
components/home/      MarketplaceHero, FeaturedMarketplace
```

---

## Agent roles

- **Orchestrator** — backlog in `docs/ORCHESTRATOR.md`, merges PRs, resolves doc drift.
- **Design agent** — tokens, primitives, `design.md` / `docs/BRAND.md` updates.
- **Execution agent** — ships features against design.md; no brand improvisation.

If your task is UI on `/library` or `/course`, you are an **execution agent** for marketplace surfaces.

---

## Commands

```bash
npm run dev          # local
npm run build        # required before commit
npm test             # lib tests
npm run import:cases # TCIA teaching cases (needs Orthanc)
```

---

## Anti-patterns (instant reject)

- Card grid for "featured cases" on home
- Inter / Roboto / Space Grotesk
- Cyan accent on marketplace (legacy reading-room doc mentioned cyan — **amber wins on marketplace**)
- Placeholder Lorem cases without teaching findings
- Trust badges as afterthought footnotes
