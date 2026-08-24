# FlowRad Learn — Design System

Canonical UI/UX reference for humans and agents.  
**Engineering constraints:** `CLAUDE.md` · **Brand lockup:** `docs/BRAND.md` · **Agent routing:** `CURSOR.md`

---

## Product truth

Radiologists teach on the **study** — not slides, not generic video. The UI must feel like a
reading room plus a respected teaching journal, never like a ChatGPT wrapper.

---

## Two modes (signature contrast)

| Mode | Where | Feel | Background |
|------|-------|------|------------|
| **Editorial marketplace** | `/`, `/library`, `/course/*`, `/authors/*`, auth | Journal + exhibit hall | Warm charcoal ladder |
| **Clinical reading room** | `/case/*`, studio record | PACS workstation | Pure black imaging |

The contrast *is* the brand. Do not flatten both into one density.

---

## Brand

### Mark & wordmark

- **Mark:** film-window reticle + caliper — `components/brand/BrandMark.tsx`
- **Wordmark:** FlowRad (semibold serif) + Learn (secondary) — `Wordmark`
- Mark always on `bg-imaging` with amber stroke

### Palette (tokens in `app/globals.css`)

| Token | Hex (approx) | Role |
|-------|--------------|------|
| canvas → elevated | `#0e0d0c` → `#2a2723` | Warm charcoal surfaces |
| text-primary | `#f2ede6` | Paper on film |
| accent | `#d4a84b` | Film-marker amber — **primary actions only** |
| imaging | `#000` | DICOM planes, viewer, film thumbnails |
| info | cool steel | Metadata, not accent |

**Banned:** purple gradients, neon cyan marketplace accent, glow washes, glass cards.

### Typography

- **Source Sans 3** — UI, forms, dense toolbars (`font-sans`)
- **Source Serif 4** — course titles, case titles, hero, wordmark (`font-display`)
- **Tabular nums** — slice index, W/L, finding counts, CME hours, progress %

---

## Layout grammar (marketplace)

### 1. Editorial row (default browse)

Use for: case lists, course lists, teacher lists, my learning, curriculum steps.

```
[ optional film thumb ]  Title (display)
                         meta line · author · counts
                         ─────────────────────────────  ← border-subtle divide
```

- No `rounded-xl` elevated box
- Hover: `bg-surface/40`
- CTA: text link or trailing arrow, not a nested button card

**Implementations:** `CaseCard` (row), `Rails.tsx` (course/teacher rows), `MyLearning`

### 2. Film plane (imaging anchor)

Use for: case row thumbnail, future rail covers, empty imaging states.

- `components/brand/FilmPlane.tsx` — black + windowing gradient + reticle + modality label
- Future: real cover frame from prefetch API (not stock art)

### 3. Editorial band (CTA / callout)

Use for: "Open library", certificate prompts, post-test warnings.

- Full width, `border-t border-subtle`, no rounded card wrapper
- Optional left accent hairline (`border-l-2 border-accent`)

### 4. Panel (studio / assessment)

Use for: forms, admin tables, assessment blocks.

- `components/ui/Panel` — flat surface, header divider
- Clinical density; not marketing

### 5. Card (restricted)

**Allowed:** sign-in form container (prefer border-y band), admin modals, confirm dialogs.  
**Forbidden:** catalog browse, featured grids, course curriculum tiles.

---

## Surface-specific rules

### Home (`/`)

1. Hero: brand lockup + one headline + one supporting line + CTA group
2. Below fold: editorial sections (courses, teachers, cases) — **lists not grids**
3. No stat pills, no three-column card dashboard

### Library (`/library`)

1. Page header: title + one secondary action (not four pill buttons)
2. Rails when unfiltered; filtered cases → editorial list
3. Search/filters: compact bar, then results list

### Course / author detail

1. Display serif title, credentials as trust row (not badge soup)
2. Curriculum: timeline + **rows**, not nested case cards
3. Related courses: rail rows or short list

### Auth

1. Film atmosphere full bleed; shell hidden
2. Form in border-y band on `bg-surface/80` — no floating card shadow

### Reading room (`/case/*`) — see also legacy teaching notes below

- App shell hidden
- Pure black viewer; amber accent for laser/mic/primary (clinical HUD)
- Tutor caption on-image; no marketing cards

---

## Trust UI (first-class)

Components must exist and be visible on catalog surfaces:

- `VerifiedBadge` — author verification
- Credentials line (`MD, FRCR`) on teacher rows
- Institution on author profile
- Future: de-id verified seal, CME-ready badge (gated)

Never tuck trust into footer tooltips.

---

## Motion

| Surface | Motion |
|---------|--------|
| Marketplace | Subtle stagger on list reveal; no decorative particles |
| Hero | Slow scan line on reticle (optional, respect `prefers-reduced-motion`) |
| Reading room | Laser approach, marker pulse, mic pulse only (≤3 effects) |

---

## Teaching surfaces (author + student)

*Preserved from original `design.md` — authoritative for `/case/*` and studio.*

### Authoring loop

- **Path A:** continuous capture → segmented findings
- **Path B:** click → dictate per finding
- Real `[0,1]` markers; series/slice anchors required

### Student loop

- Full-bleed viewer; viva / guided / report modes
- Voice: transcribe → tutor → TTS; transcript + answer visible
- Compare pane when finding has secondary landing

### Reading-room visual (viewport)

- `bg-imaging` for pixels; chrome from token system
- Tight HUD; tabular nums for slice/W/L
- Real `<button>`; `aria-label` on icon buttons
- Dynamic `left/top` % only inline style allowed for markers

### DICOM

- Orthanc + `/api/dicomweb` proxy only
- Prefetch finding-ordered slices; skeleton never blank panel

---

## Primitives roadmap

| Primitive | Status | Path |
|-----------|--------|------|
| BrandMark / Wordmark | ✅ | `components/brand/BrandMark.tsx` |
| FilmPlane | ✅ | `components/brand/FilmPlane.tsx` |
| Case row | ✅ | `components/catalog/CaseCard.tsx` |
| EditorialRow | 🔲 | `components/ui/EditorialRow.tsx` |
| EditorialBand | 🔲 | `components/ui/EditorialBand.tsx` |
| RailCover | 🔲 | film header + meta footer tile |

---

## References (inspiration, not copy)

- **Radiopaedia** — course structure, CME trust, editorial titles
- **RSNA MIRC** — teaching file = images + narrative peers
- **AMBOSS** — intent-based nav, dark study mode
- **Linear** — one accent, hairline borders, craft on chrome

---

## Doc maintenance

When changing tokens or patterns, update in the same PR:

1. `app/globals.css` / `tailwind.config.ts`
2. `docs/BRAND.md` (if mark/palette)
3. This file (`design.md`)
4. `CLAUDE.md` §1 (short summary only)

Orchestrator rejects PRs that change UI without updating `design.md`.
