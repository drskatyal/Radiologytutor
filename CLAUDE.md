# FlowRad Learn — Engineering & Design Guide

FlowRad Learn is a **world-class interactive radiology teaching platform**. A teacher
authors a case from a real DICOM study: they mark findings, record a narrated walk-through,
and the platform replays it for students with an AI tutor that answers questions by voice.

Treat this as a **production product**, not a demo. The bar is "a PACS vendor's flagship
teaching product." If a change would embarrass us in front of a radiology department, it is
not done.

---

## 0. Non-negotiable quality bar (read before every task)

- **No inline `style={{…}}` for layout/spacing/color.** Use Tailwind classes and the shared
  UI components in `components/ui/`. Inline style is allowed ONLY for truly dynamic values
  (e.g. a marker's computed `left/top` %, a canvas size).
- **Reuse the design system.** Never hand-roll a button, card, input, modal, or spinner —
  import from `components/ui/`. If a primitive is missing, add it there, don't fork it inline.
- **Every interactive control must actually work** and have hover/focus/disabled/loading
  states. A mic button that doesn't record, or a save button with no feedback, is a bug.
- **Loading, empty, and error states are required**, not optional. Never render a blank
  screen or an unexplained spinner.
- **Accessibility:** real `<button>`/`<label>`, keyboard focus rings, `aria-label` on icon
  buttons, sufficient contrast.
- **Finish the vertical.** A feature isn't done until: data persists, the UI reflects it,
  errors are handled, and `npm run build` is clean. No TODOs left as the deliverable.
- **Match surrounding code**: naming, file layout, comment density. Read neighbors first.

When unsure between "minimal" and "polished," choose polished. Bare-minimum is a defect here.

---

## 1. Design system

**Look & feel:** clean, calm, clinical. Dark theme (radiology reading-room), high contrast,
one decisive accent. Editorial marketplace + PACS-dense viewer — see **`design.md`** and **`docs/BRAND.md`**.

- **Font:** Source Sans 3 via `next/font` (`--font-sans`); Source Serif 4 for display titles (`font-display`).
  Tabular numbers for measurements/counters.
- **Color tokens** (Tailwind theme in `tailwind.config.ts`):
  - Surfaces: `bg-canvas`, `bg-surface`, `bg-elevated` (warm charcoal ladder).
  - Text: `text-primary`, `text-secondary`, `text-muted`.
  - Border: `border-subtle`, `border-strong`.
  - Accent: film-marker **amber** `accent` + `accent-foreground`. Semantic: `success`, `warning`, `danger`, `info`.
  - Imaging surfaces are pure black (`bg-imaging`) regardless of theme.
- **Marketplace layout:** editorial hairline **rows** + `FilmPlane` thumbnails — **not card grids** on browse surfaces.
- **Radii/shadow/spacing:** theme scale; soft shadows only on floating modals/menus.
- **Core UI primitives** live in `components/ui/`; brand visuals in `components/brand/`:
  `Button`, `IconButton`, `Card` (forms/admin only on marketplace), `Panel`, fields, `Badge`, etc.
- **App shell:** `components/AppShell` — sidebar nav; hidden on `/case/*` and auth screens.
- **Agent docs:** `CURSOR.md`, `docs/ORCHESTRATOR.md`.

---

## 2. Product surfaces & roles

- **Student (`/case/[caseId]`)** — the learner experience:
  - Our self-hosted Cornerstone3D viewer (smooth scroll/window/zoom/pan + annotations).
  - A **guided multi-step walk-through**: findings play in sequence; each step animates the
    viewer to the finding, shows the marker/annotation, and narrates.
  - **Voice Q&A:** press the mic → we capture audio → **call 1: transcribe** (Gemini STT) →
    **show the user's transcript immediately** → **call 2: run the teaching plan** (Gemini with
    case + findings context, returns the answer + any viewer actions) → speak the answer (TTS).
    Always render the transcript and the answer as chat turns.
- **Author (`/author`)** — the teacher reviews & edits a case:
  - Review each finding's **structured output** (label, description, teaching points) in a
    clean editable form; fix text, reorder steps, re-run Gemini structuring, delete.
  - Capture/record the per-finding viewer flow and marker.
- **Admin (`/admin`)** — upload & manage cases:
  - Upload a DICOM study (→ Orthanc), create a case, set title/modality/specialty, pick the
    series, publish/unpublish, delete. List all cases with status.

---

## 3. Architecture & conventions

- **Next.js 14 app-router, TypeScript, Tailwind.** Server components by default; mark
  `"use client"` only where needed. The Cornerstone viewer must be `next/dynamic({ssr:false})`.
- **Viewer is swappable.** All viewer-state logic stays behind `lib/viewerController.ts` /
  `lib/viewerSource.ts` / `lib/pacsbinUrl.ts`. UI never hard-codes a viewer.
- **Data layer behind `lib/cases.ts`** — identical exported signatures regardless of backend
  (JSON-on-volume now → MongoDB later). Callers never know the store. All persistence is
  server-side; never expose DB creds or the Gemini key to the client.
- **Imaging backend:** Orthanc DICOMweb, reached only through `lib/orthanc.ts` and the
  `/api/dicomweb` proxy (same-origin, no CORS, creds server-side).
- **AI is server-side only** (`lib/gemini.ts`). Two distinct calls — transcription and
  teaching — never merged. Keep prompts and tool schemas in one place.
- **Gemini model:** use the current Gemini Flash for STT/structuring/tutor. Read keys from
  env (`GEMINI_API_KEY`).
- **Data model** (`lib/types.ts`): a `CaseData` has ordered `Finding`s. A `Finding` has
  structured text (`label`, `description`, `teachingPoints`), an ordered `order`, a viewer
  `state`/`keyframes`, and a normalized `marker`. Markers are stored as `[0,1]` percentages,
  never pixels. Series/study are DICOM UIDs (strings), never integers.

### Multi-step / multi-finding driving
Findings are an ordered list. A "teaching plan" is a sequence of steps; the tutor advances
with `next_in_tour` / jumps with `show_finding`. The student UI shows step progress
(e.g. "Finding 2 of 5") and lets the user ask questions at any step without losing place.

### Saving & updating
Every create/edit/delete goes through the data layer and returns the updated entity; the UI
updates optimistically with rollback on error and a toast on success/failure.

---

## 4. Workflow

- `npm run build` must pass before any commit. `npm test` for lib logic (151 tests).
- Do NOT run with `--turbo` (the Cornerstone webpack/wasm config needs the default builder).
- Commit in coherent units with clear messages. Keep the working tree clean.
- Integration branch: `claude/epic-noether-3nvcbf`. Feature work branches off it and
  opens a single draft PR back into it.
- Railway: app service auto-deploys this branch; Orthanc is a separate service; never push a
  broken build (it breaks the live app).

## 4a. SaaS shape, data model & performance

**This is a multi-tenant SaaS.** Cases belong to an `org` (tenant); users belong to an org
with a role (`admin` | `author` | `student`). Everything is scoped by `orgId`. Auth is a seam
now (single demo org) but every data-layer call takes/derives `orgId` so we don't refactor later.

**Entity hierarchy (longitudinal-aware):**
```
Org → Patient → Study(s) → Series → (used by) Case → Finding(s)
```
- **Patient** groups multiple **Studies** (e.g. prior + current) for **chronology/comparison**.
  Studies carry `studyDate` so the UI can order them and show "prior vs current".
- A **Case** is a teaching unit. It references one or more studies/series of a patient (so a
  case can compare a prior and a follow-up), has `status` (`draft` | `published`), title,
  modality, specialty, and ordered **Findings**.
- A **Finding** keeps structured text + viewer `state`/`keyframes` + normalized marker + `order`.
- DICOM identity is always **UIDs** (study/series/sop); Orthanc ids are internal only.

**Saving/accessing:** all reads/writes go through `lib/cases.ts` (now JSON-on-volume, later
MongoDB) with stable, `orgId`-scoped signatures: list/get/create/update/delete for cases,
patients, studies, findings. Updates return the new entity; UI updates optimistically + toasts.

**Performance — prefetch aggressively (it's a teaching app, the path is known):**
- When the **case list** opens, kick off **background prefetch** of each case's first
  series metadata + the cover/first slices (warm the DICOMweb cache) so opening a case is
  instant. Use idle/low-priority fetches; never block the list render.
- When a **case opens**, prefetch the exact slices/series each finding needs next (we know the
  script), and prefetch the next finding while the current one is narrated.
- Serve compressed transfer syntax and decode in web workers; cache aggressively at the
  `/api/dicomweb` proxy (and a CDN later). Show skeletons, never blank panels.

**De-identification:** deferred to the end (after the app works). For now upload only
already-anonymized studies; keep `lib/orthanc.ts` ingest a single seam so anonymize-on-ingest
slots in later without touching callers.

## 5. Repo map
- `app/` routes (student `case/`, `author/`, `admin/`, `cornerstone/` viewer spike, `api/`).
- `components/` feature components; `components/ui/` design-system primitives.
- `lib/` data layer, viewer logic, Orthanc client, Gemini, types.
- `public/dicom/` bundled sample study. `seed/` seed cases.

---

## 6. Product architecture — the marketplace (see `ARCHITECTURE.md`)

FlowRad Learn is becoming **the marketplace where radiologists teach radiology**: Udemy/Coursera
reimagined around the **AI-tutored, narrated, interactive DICOM case**. The full design + phased
roadmap lives in **`ARCHITECTURE.md`** (read it before marketplace work). Headlines:

- **Identity & access (P0, the foundational gap):** **Clerk** for auth + first-class
  Organizations/RBAC, behind a `lib/auth.ts` seam (no Clerk import outside it; Better Auth is the
  fallback). Authorization = "does the session user hold a `Membership` in the resource's `orgId`
  with a sufficient role?" Replace `DEFAULT_ORG_ID` call sites with `activeOrgId()`; **never trust
  a client-supplied `orgId`**. Roles per-org: `owner | admin | author | student` (+ platform staff).
- **Data model is additive.** New entities are new Mongo collections registered through the
  **existing STORE SEAM** in `lib/cases.ts` (one `collection<T>()` + CRUD + an index line in
  `lib/mongo.ts`), all `orgId`-scoped. Key additions: `Membership`, `AuthorProfile` (verified,
  tied to a `User` — supersedes attribution-only `Author`), `Course→Module→Lesson`, `Enrollment`,
  `Progress`, `Assessment→Question→Attempt`, `Certificate`, `Product/Order/Entitlement/Subscription/
  Payout`, `Review`, `Notification`, `DeidReport`. Existing `Case`/`Finding`/viewer-state model is
  **unchanged**; new fields are optional for seed back-compat (the `normalizeCase` discipline).
- **Assessment is the differentiator — it runs ON the viewer we own.** Three question kinds:
  **click-the-finding** (compare click to the stored normalized `marker` — no new imaging infra),
  **MCQ**, and **AI-graded structured report** (reuse the Gemini `reporting` mode + `jsonOnly`;
  always show the rubric, never a bare AI score).
- **Monetization (P3, ships last):** **Stripe Connect (Express)** + destination charges with an
  application fee, behind `lib/payments.ts`. Models: free / paid course / learner subscription /
  institutional seats. **Webhooks are the only source of truth** for entitlements + payouts.
- **CME is gated.** We cannot grant AMA PRA Category 1 Credit ourselves — it requires an
  ACCME-accredited provider. Until a provider partner signs off, issue **"Certificate of
  Completion"** and keep the post-test/eval flow *accreditation-ready*; gate "CME"/credit language
  behind a verified `accreditationProviderId`.
- **Trust & compliance gates (publishing):** author **verification** (credentials → platform-admin
  queue; unverified can't publish public) and **hard de-identification** — header scrub (DICOM
  PS3.15 / HIPAA Safe Harbor) + pixel OCR for burned-in PHI, in the single `orthancIngestInstance`
  ingest seam (`lib/deid.ts`). **A case cannot be published unless every referenced study has a
  passing `DeidReport`.** De-id is infrastructure, pulled forward to P0/P1 — money never ships
  before it.
- **New seams to keep clean (mirror the STORE SEAM):** `lib/auth.ts`, `lib/payments.ts`,
  `lib/deid.ts`, `lib/notify.ts`. New infra: object storage + CDN (R2/S3) for narration audio,
  certificate PDFs, avatars, and cached DICOM frames (repoint `/api/audio` there).
- **Phased roadmap:** **P0** identity + author onboarding + verified profiles (+ de-id gate) →
  **P1** enrollment/progress + Course→Module→Lesson + richer catalog → **P2** assessment + CME-ready
  certificates → **P3** monetization/payouts → **P4** org dashboards/analytics + notifications.
- **Brand:** push past "generic premium AI SaaS" toward a domain-authentic radiology aesthetic —
  editorial display serif for course/author titles, reading-room density on clinical surfaces vs.
  breathing-room editorial catalog, radiology motifs (reticles, windowing gradients, calipers,
  tabular numerics), and **trust signals (verification badges, credentials, CME/de-id seals) as
  first-class designed UI**. Stay within the token system + `components/ui/` (§1).
