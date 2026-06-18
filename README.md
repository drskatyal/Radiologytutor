# FlowRad Learn — Demo

Interactive radiology teaching tool. A tutor uploads DICOM cases to **Pacsbin**,
records "findings" (exact viewport state + an on-image point + a dictated
explanation), and a student later experiences each case as a guided,
voice-narrated tour: the viewer animates to each finding while an AI tutor
narrates and answers questions.

> We are **not** building a DICOM viewer. Pacsbin renders the images — we
> orchestrate it by setting viewport state through URL query params (one-way).

## Stack

- Next.js 14 (App Router, TypeScript) + Tailwind
- Gemini Flash (Google AI Studio) for (a) structuring dictated findings into
  JSON and (b) the student-facing tutor agent with tool-calling
- Web Speech API (browser) for mic capture + narration in the demo
- Persistence: JSON files under `/data` (one per case)

## Setup

```bash
npm install
cp .env.example .env.local   # add your Google AI Studio key
npm run dev                  # http://localhost:3000
```

Set in `.env.local`:

- `GEMINI_API_KEY` — from https://aistudio.google.com/apikey
- `GEMINI_MODEL` — Flash model id (default `gemini-flash-latest`)

## Routes

- `/` — list of cases
- `/author` — attach a Pacsbin case, add findings (paste bookmark → parse
  viewport, click to place marker, dictate → AI structures the text)
- `/case/[caseId]` — student playback: clean embed, animated marker, AI tutor
  chat (guided / Socratic / free-explore modes)

## API routes (all Gemini calls are server-side)

- `POST /api/structure-finding` — transcript → strict JSON `{label, description, teachingPoints[]}`
- `POST /api/tutor` — chat + tool-calling (`show_finding`, `set_window`, `compare`, `next_in_tour`)
- `GET|POST /api/cases`, `/api/cases/[caseId]`, `.../findings`, `.../reorder` — persistence

## Architecture notes

- **Pacsbin is a swappable dependency.** Everything Pacsbin-specific (URL
  build/parse) lives in `lib/pacsbinUrl.ts`. Replace it with a Cornerstone3D /
  LiteVNA adapter without touching the UI or data model.
- **Viewport capture workaround:** we can't read state out of the iframe. The
  tutor creates a Pacsbin bookmark link (which encodes viewport state in the
  URL), pastes it, and we reverse-parse it.
- **Markers** are stored as percentages of the overlay box, never pixels, so
  they remap onto the same anatomy once we lock the same viewport at playback.
- **Series/image are stored as string IDs**, never integers.

## ⚠️ Before tuning the animation — run the Pacsbin caching test

Open a Pacsbin case → DevTools → Network → scroll slices manually:

- **No new network requests** (series cached in-browser): rapid URL updates
  animate smoothly → use the defaults in `lib/viewerController.ts`.
- **Every scroll refetches:** the iframe-reload animation will flicker. Raise
  `sliceStep` (keyframe every Nth slice) or pass `mode: "snap"` per case.

Also confirm whether changing URL params reloads the iframe or updates Pacsbin
in place (client-side routing). If in-place, animation is effectively free.
`lib/viewerController.ts` sets `iframe.src` directly and exposes both knobs.

## Seed data

`data/knee-acl-01.json` is a sample knee case. Replace
`pacsbinBaseUrl` with a real Pacsbin viewer token and fix the series/image IDs
to match that case before playback will render real images.

## Tests

```bash
npm test   # unit tests for lib/pacsbinUrl.ts (build + reverse-parse round-trip)
```
