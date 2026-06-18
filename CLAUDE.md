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
generous spacing, one decisive accent. Think Linear/Vercel polish applied to a PACS.

- **Font:** Inter via `next/font` (loaded in `app/layout.tsx`, exposed as `--font-sans`).
  Tabular numbers for measurements/counters.
- **Color tokens** (Tailwind theme in `tailwind.config.ts`):
  - Surfaces: `bg-canvas` (app bg, near-black), `bg-surface` (panels), `bg-elevated` (cards/menus).
  - Text: `text-primary`, `text-secondary`, `text-muted`.
  - Border: `border-subtle`, `border-strong`.
  - Accent: `accent` (primary action) + `accent-foreground`. Semantic: `success`, `warning`, `danger`, `info`.
  - Imaging surfaces are pure black (`#000`) regardless of theme.
- **Radii/shadow/spacing:** use the theme scale (`rounded-lg` default for cards/controls).
  Soft, subtle shadows only on elevated/floating surfaces.
- **Core UI primitives** live in `components/ui/` and are the ONLY way to render these:
  `Button`, `IconButton`, `Card`, `Panel`, `Field`/`Input`/`Textarea`/`Select`, `Badge`,
  `Spinner`, `Modal`, `Toast`, `MicButton`, `Tabs`, `EmptyState`. Keep them small, typed,
  composable, and themed via tokens.
- **App shell:** `components/AppShell` provides the sidebar/topbar nav (Cases · Author · Admin)
  and page header slot. Pages render inside it; they don't redraw chrome.

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

- `npm run build` must pass before any commit. `npm test` for lib logic.
- Do NOT run with `--turbo` (the Cornerstone webpack/wasm config needs the default builder).
- Commit in coherent units with clear messages. Keep the working tree clean.
- Branch: `claude/epic-noether-3nvcbf`. Open/maintain a single draft PR.
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
