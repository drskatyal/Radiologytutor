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
- **Gemini Flash (Google AI Studio) does all model calls:** speech-to-text on
  dictation/voice questions (multimodal audio in), structuring dictated findings
  into JSON, and the student tutor agent with tool-calling
- **ElevenLabs** for tutor narration (speech out); falls back to the browser's
  `speechSynthesis` if no key is set
- Mic capture via `MediaRecorder` (audio → server → Gemini)
- Persistence: JSON-on-volume by default; **set `MONGODB_URI` to run on MongoDB**
  with no code changes (see [Database](#database)).

## Pacsbin integration (researched)

Pacsbin's embed client API (`new PacsbinClient()`) is minimal — only
`setTool()`, `toggleAnnotations()`, `noPageScrollWheel()`. **All viewport state
(series/image/ww/wc/scale/translation/layout) is set via URL query params only**
(colon-keyed: `s:1`, `i:1`, `ww:1`, …), with **no read-back and no postMessage
state stream.** So real-time control = rapid URL writes to the iframe, and we
draw our own marker overlay (Pacsbin's native annotations hidden via `an=false`).
This confirms the architecture in `lib/pacsbinUrl.ts`.
Docs: https://docs.pacsbin.com/viewer-url-options

## Setup

```bash
npm install
cp .env.example .env.local   # add your keys
npm run dev                  # http://localhost:3000
```

Set in `.env.local`:

- `GEMINI_API_KEY` — from https://aistudio.google.com/apikey (required). One key
  powers STT, the web-grounded tutor, and text-to-speech.
- `GEMINI_MODEL` — Flash model id (default `gemini-flash-latest`)
- `GEMINI_TTS_MODEL` / `GEMINI_TTS_VOICE` — tutor voice (defaults
  `gemini-2.5-flash-preview-tts` / `Kore`; falls back to browser TTS if absent)

## Routes

- `/` — list of cases
- `/author` — attach a Pacsbin case, add findings (paste bookmark → parse
  viewport, click to place marker, dictate → AI structures the text)
- `/case/[caseId]` — student playback: clean embed, animated marker, AI tutor
  chat (guided / Socratic / free-explore modes)

## API routes (all Gemini calls are server-side)

- `POST /api/structure-finding` — transcript **or audio** → strict JSON `{label, description, teachingPoints[]}`
- `POST /api/tutor` — chat (text **or audio** turn) + tool-calling (`show_finding`, `set_window`, `compare`, `next_in_tour`)
- `POST /api/tts` — text → ElevenLabs audio stream (narration)
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

## Database

The data layer (`lib/cases.ts`) sits behind a store seam: a `Collection`
interface with two implementations chosen at runtime by the `collection()`
factory.

- **Default — JSON-on-volume.** With no `MONGODB_URI` set, cases/patients/studies
  persist as JSON files under `DATA_DIR` (default `./data`; point it at a Railway
  Volume to survive redeploys). This is what the demo and `npm test` use — **no
  database required.**
- **MongoDB — set one env var.** Set `MONGODB_URI` and the *entire* app silently
  switches to MongoDB (`lib/mongo.ts`). No caller or API changes. Unset it to go
  back to JSON.

Either store **self-seeds from `/seed`** the first time it is empty, so a fresh
DB isn't blank. The Mongo connection is a cached singleton (no connection storm
on serverless / hot-reload) and connects **lazily on first use** — importing the
data layer at build time never touches the network. Indexes for fast org-scoped
lists are created once on first connect: `orgId` and `orgId+status` on cases,
`orgId` on patients, `orgId` and `orgId+patientId` on studies.

**Turn it on (MongoDB Atlas):**

1. Create a free cluster at https://www.mongodb.com/atlas and a database user.
2. Allow your app's IP (or `0.0.0.0/0` for Railway) under Network Access.
3. Copy the connection string (`mongodb+srv://USER:PASS@cluster…`) into
   `MONGODB_URI` (in `.env.local` locally, or the Railway service variables).
4. Optionally set `MONGODB_DB` (default `flowrad`). Redeploy/restart — done.

## Tests

```bash
npm test   # unit tests for lib/pacsbinUrl.ts (build + reverse-parse round-trip)
```
