# FlowRad Learn — Agent Orchestrator Architecture

This document defines how **autonomous design and execution agents** elevate the product.
The orchestrator (architect agent) owns priorities, merges conflicts, and routes work.
Humans approve phase boundaries; agents ship within guardrails.

---

## Roles

| Role | Responsibility | Reads first | Ships |
|------|----------------|-------------|-------|
| **Orchestrator** | Backlog, sequencing, PR strategy, doc truth | `ORCHESTRATOR.md`, `ARCHITECTURE.md`, open PRs | Plans, merges, unblocks |
| **Design agent** | Brand, tokens, layout grammar, component specs | `design.md`, `docs/BRAND.md`, `CURSOR.md` | Specs, primitives, visual diffs |
| **Execution agent** | Implement approved patterns end-to-end | Design agent output + `CLAUDE.md` | Code, tests, `npm run build` |
| **QA agent** (optional) | Click-through, screenshots, a11y spot checks | `docs/BRAND.md` surface list | Screenshot artifacts, issue list |

**Rule:** Execution agents do not invent brand. Design agents do not leave TODOs as deliverables.

---

## Decision flow

```
User / product intent
        │
        ▼
┌───────────────────┐
│   ORCHESTRATOR    │  ← backlog, phase, branch, base PR
└─────────┬─────────┘
          │
    ┌─────┴─────┐
    ▼           ▼
 DESIGN      EXECUTION
 agent       agent(s)
    │           │
    └─────┬─────┘
          ▼
   PR (draft) → build green → screenshots → orchestrator merge
```

### Orchestrator checklist (every cycle)

1. **Truth** — `design.md`, `docs/BRAND.md`, `CLAUDE.md` §1 agree on fonts/colors/surfaces.
2. **Scope** — one surface family per PR (e.g. marketplace catalog, not studio + admin).
3. **Pattern** — no new card grids on marketplace; use editorial rows / film planes (see `design.md`).
4. **Vertical** — data persists, loading/empty/error, `npm run build`, `npm test`.
5. **Branch** — `cursor/<topic>-a5b0` off `claude/epic-noether-3nvcbf` (or active epic branch).

---

## Surface families (routing)

| Family | Routes | Density | Chrome |
|--------|--------|---------|--------|
| **Marketplace** | `/`, `/library`, `/course/*`, `/authors/*`, auth | Editorial — breathe | Hairline rows, film planes |
| **Reading room** | `/case/*` | PACS-dense | Hidden shell, pure black imaging |
| **Studio / admin** | `/studio/*`, `/admin` | Form-dense | `Panel`, tables — cards OK for forms only |

Agents must not apply marketplace patterns to the reading room or vice versa.

---

## Backlog (orchestrator-owned)

### Phase A — Brand foundation *(PR #11, branch `cursor/orchestrator-design-a5b0`)*

- [x] Custom `BrandMark` + `Wordmark` (`components/brand/`)
- [x] `FilmPlane` visual for case rows
- [x] Home + library: editorial lists (not card grids)
- [x] `docs/BRAND.md`, hero + auth film atmosphere
- [x] Orchestrator docs (`ORCHESTRATOR.md`, `CURSOR.md`, agent playbooks)
- [ ] Merge PR #11 to `claude/epic-noether-3nvcbf`

### Phase B — Marketplace completion *(execution agent, branch `cursor/marketplace-surfaces-a5b0`)*

- [x] `/course/[id]` — editorial header, curriculum rows (no nested `CaseCard`)
- [x] `/learning` — resume rows, not card grids
- [x] `CourseReviews`, `CourseAssessment` — `Panel` / thread rows
- [x] Delete orphaned `LearnZone.tsx`, `TeachZone.tsx`
- [ ] Migrate inlined rows → `EditorialRow` (after Phase C merge)
- [ ] Real DICOM cover thumbnails on `FilmPlane` (prefetch API)

### Phase C — Design system primitives *(design agent, branch `cursor/design-primitives-a5b0`)*

- [x] `components/ui/EditorialRow.tsx` — hairline list row
- [x] `components/ui/EditorialBand.tsx` — full-width CTA / callout
- [x] `globals.css` — `.film-plane`, `.editorial-divide` utilities
- [x] Narrow `Card` docstring: forms/auth/admin only
- [ ] Merge PR, then refactor `CaseCard`, `Rails`, `MyLearning`, `CourseCurriculum`

### Phase D — Doc alignment *(complete in PR #11)*

- [x] `CLAUDE.md` §1 — Source Sans 3 + Source Serif 4, film-marker amber
- [x] `ARCHITECTURE.md` §9 — point to `design.md` + implemented mark
- [x] `design.md` — unified marketplace + reading room (replace stale cyan/Inter)

---

## Agent prompts (copy-paste)

### Design agent

```
You are the FlowRad Design Agent. Read design.md, docs/BRAND.md, CURSOR.md.
Propose or implement visual primitives only — no business logic.
Marketplace: editorial rows + film planes, never card grids for browse lists.
Output: component API, token additions, before/after surface notes.
npm run build must pass.
```

### Execution agent

```
You are the FlowRad Execution Agent. Read the orchestrator backlog item assigned to you
and design.md surface rules. Implement the vertical completely: UI + states + build.
Reuse components/brand/* and components/ui/*. Do not add inline style for layout.
Branch: cursor/<task>-a5b0. Commit, push, update PR.
```

---

## GitHub & sources

| Source | Use for |
|--------|---------|
| This repo `design.md`, `docs/BRAND.md` | Canonical product design |
| `ARCHITECTURE.md` §9 | Strategic brand direction |
| `CLAUDE.md` | Engineering bar + component rules |
| Radiopaedia / RSNA MIRC / AMBOSS | Editorial + teaching-file structure (not pixels) |
| Linear, Vercel | Chrome craft, one accent, hairline borders |

**Radiopaedia:** no DICOM API — cite articles only; pixels from TCIA (`lib/publicCases/`).

---

## PR policy

- One concern per PR; draft until screenshots + green build.
- Orchestrator merges to epic branch; production deploy follows epic → main policy.
- Screenshot artifacts: home, library, course detail, sign-in, one case teach view.

---

## Current orchestrator decision

**Merge order:** PR #11 (orchestrator + brand) → design primitives PR → marketplace surfaces PR.  
**Next execution priority:** Refactor catalog rows to `EditorialRow`; real DICOM thumbnails on `FilmPlane`.  
**Next design priority:** Author profile + playlist pages (`/authors/*`, `/playlist/*`) editorial pass.  
**Base branch for new work:** `cursor/design-primitives-a5b0` after primitives PR merges; until then `cursor/orchestrator-design-a5b0`.
