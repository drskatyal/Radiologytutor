# FlowRad Learn

**The marketplace where radiologists teach radiology.** A teacher marks findings on a real
DICOM study, records a narrated walk-through, and a learner replays it as a guided tour with
an AI tutor that answers questions by voice — on our own viewer, over our own imaging backend.

The full product design and phased roadmap live in [`ARCHITECTURE.md`](./ARCHITECTURE.md).
Engineering and design rules live in [`CLAUDE.md`](./CLAUDE.md). A detailed assessment of the
current build — what is solid, what is not, and in what order to fix it — is in
[`docs/EVALUATION.md`](./docs/EVALUATION.md).

## Stack

- **Next.js 14** (App Router, TypeScript) + Tailwind, with a design system in `components/ui/`.
- **Cornerstone3D, self-hosted.** We render the pixels ourselves — `components/CornerstoneViewer.tsx`
  plus the drive logic in `lib/viewerController.ts`. There is no third-party embed.
- **Orthanc** over DICOMweb for the study bytes, reached only through `lib/orthanc.ts` and the
  same-origin `/api/dicomweb` proxy, so credentials never reach the browser.
- **Gemini Flash** for every model call — speech-to-text, structuring dictated findings into
  JSON, the tool-calling tutor, and TTS fallback. Server-side only (`lib/gemini.ts`).
- **ElevenLabs** for a cloned teacher voice on live Q&A; falls back to Gemini TTS, then to the
  browser's `speechSynthesis`.
- **Better Auth** behind the `lib/auth.ts` seam, with org-scoped RBAC (`owner`/`admin`/`author`/`student`).
- **Persistence:** JSON-on-volume by default; set `MONGODB_URI` to switch the whole app to
  MongoDB with no code changes (see [Database](#database)).

> **Historical note:** early versions embedded Pacsbin and drove it through URL query params,
> since we could not read viewport state back out of the iframe. That is gone. `lib/pacsbinUrl.ts`
> survives only to parse legacy bookmark links; `pacsbinBaseUrl` on a `Case` is a legacy field.

## Setup

```bash
npm install
cp .env.example .env.local   # add your keys
npm run dev                  # http://localhost:3000
```

The only key you need to see the app work is `GEMINI_API_KEY`. Everything else degrades
gracefully: with no `ORTHANC_URL` the imaging surfaces report "not configured", with no
`ELEVENLABS_API_KEY` the tutor uses Gemini TTS, with no `MONGODB_URI` data persists to disk.

`.env.example` documents every variable. Two matter for a real deployment:

- **`BETTER_AUTH_SECRET` is required in production.** With `NODE_ENV=production` and no value,
  the app refuses to serve rather than fall back to a signing key that ships in this repo.
  Generate one with `openssl rand -base64 32`.
- **`DEMO_AUTH_ENABLED`** controls the keyless "Continue as demo" button. It is on outside
  production and off in production unless you set it — left open it is a full authentication
  bypass. Even when deliberately enabled in production it caps out at `student`.

### Getting cases into a fresh install

`seed/` ships the org, users, memberships, authors, courses, playlists and an assessment — but
**no cases**, because the sample cases were removed along with the Pacsbin placeholders. The
seeded courses reference cases that the public-collection importer creates:

```bash
npm run import:cases        # pulls TCIA collections into Orthanc + creates the cases
```

This needs `ORTHANC_URL` configured. Until it runs, the catalog is empty and the seeded courses
point at case ids that do not exist yet.

## Routes

**Learner**
- `/` — marketplace home (hero, featured courses, teachers, cases)
- `/library` — the filterable catalog
- `/learning` — my learning: enrollments, progress, certificates
- `/course/[id]` — curriculum, reviews, assessment, certificate CTA
- `/playlist/[id]` — an ordered case list
- `/case/[caseId]` — **the product**: the guided session (viewer + finding spine + voice tutor)
- `/authors/[id]` — a teacher's profile
- `/certificate/[id]` — a certificate of completion

**Teacher (Studio)**
- `/studio` — teaching home
- `/studio/new` — the 4-step case creation arc (upload → details → series → findings)
- `/studio/cases`, `/studio/cases/[caseId]` — manage and edit cases and findings
- `/studio/cases/[caseId]/record` — the PACS recording studio (capture viewer flow + dictation)
- `/studio/courses`, `/studio/profile`

**Admin / dev**
- `/admin` — platform console (members, teacher verification, oversight)
- `/sign-in`, `/sign-up`
- `/record`, `/cornerstone` — developer labs for the record and viewer stacks

## API

Everything model- or imaging-related is server-side. Highlights:

| Route | Purpose |
|---|---|
| `POST /api/transcribe` | **Call 1** of voice Q&A — Gemini STT only |
| `POST /api/tutor` | **Call 2** — teaching plan + viewer tool-calls. Never merged with call 1 |
| `POST /api/tts` | Tutor narration; voice resolved server-side from the author record |
| `POST /api/structure-finding`, `/api/structure-session` | Dictation → structured finding JSON |
| `POST /api/grade-report` | AI-graded structured report against a visible rubric |
| `GET /api/dicomweb/...` | Same-origin WADO-RS/QIDO-RS proxy to Orthanc. **Read-only** |
| `POST /api/upload` | The single DICOM ingest path — runs the de-id gate |
| `GET /api/catalog` | The public, filterable catalog |
| `GET /api/assessments`, `POST /api/attempts` | Quiz delivery (no answer keys) and grading |
| `GET /api/assessments/question-view` | Imaging for a click-the-finding question — never the marker |

All expensive routes require a session and sit behind `middleware.ts`, which applies per-route
rate limits and body-size caps.

## Architecture notes

- **The viewer is swappable.** Viewer-state logic lives behind `lib/viewerController.ts` /
  `lib/viewerSource.ts`. UI never hard-codes a viewer.
- **The data layer is a seam.** Every read/write goes through `lib/cases.ts`, which exposes a
  `Collection<T>` interface (`all`/`find`/`get`/`put`/`remove`) with a JSON and a MongoDB
  implementation chosen at runtime. `find(filter)` is what lets list queries use the indexes
  in `lib/mongo.ts` instead of scanning.
- **Ingest is a single seam.** All DICOM enters through `orthancIngestInstance`, which runs the
  header identity gate in `lib/deid.ts` and refuses instances with residual PHI. The DICOMweb
  proxy exports no write verb precisely so STOW-RS cannot route around it.
- **Markers are normalized.** Stored as `[0,1]` fractions of the viewport, never pixels, so
  they land on the same anatomy once the viewport is reproduced. Series and studies are always
  DICOM UIDs (strings), never integers.
- **De-identification gates publishing.** A case cannot be published unless every study it
  references has a passing `DeidReport` in its own org. Header scrubbing is real; **pixel OCR
  for burned-in PHI is not implemented and is never claimed** — see `lib/deid.ts`.

## Database

With no `MONGODB_URI`, cases and friends persist as JSON under `DATA_DIR` (default `./data`;
point it at a mounted volume so data survives redeploys). Set `MONGODB_URI` and the entire app
runs on MongoDB — no caller or API changes. Either store self-seeds from `/seed` when empty.

The Mongo connection is a cached singleton that connects lazily on first use, so importing the
data layer at build time never touches the network. Indexes are created once on first connect.

**MongoDB Atlas:** create a cluster and database user, allow your app's IP under Network Access,
put the connection string in `MONGODB_URI`, optionally set `MONGODB_DB` (default `flowrad`).

## Tests

```bash
npm test           # 151 unit tests across lib/ — viewer math, grading, de-id, access, store
npm run build      # must pass before any commit
npm run test:access  # role × capability access harness
```

Do **not** run with `--turbo` — the Cornerstone webpack/wasm config needs the default builder.
