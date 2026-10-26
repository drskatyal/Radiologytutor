# Locked product decisions (do not reopen)

**Marketplace:** curated radiology teaching — teachers publish cases/courses; students learn; platform keeps ~20% later (India PSP, not Stripe-first).

## Infra
| Layer | Choice |
|--------|--------|
| App | **Cloud Run** in GCP project `radlearn-app`, region `europe-west2` (Next.js standalone image). Fly.io remains until cutover — `docs/GCP_CLOUD_RUN.md`, `docs/FLY_R2.md` |
| DICOM archive | **Cloud Healthcare API DICOM store** `radlearn` / `radlearn-dicom` in `europe-west2`. **Orthanc** stays local/dev and the Fly archive until studies are re-imported |
| Domain DB | **MongoDB Atlas** on GCP `EUROPE_WEST_2`. Cloud Run requires `MONGODB_URI` (Secret Manager); JSON-on-disk is dev/test only |
| Auth | **Better Auth** + **Google OAuth** (password optional). Seam: `lib/auth.ts` only. DICOM store uses the Cloud Run service account, not IAP |
| Frames/audio cache | **S3-compatible** (`lib/r2.ts`): Cloudflare R2, or GCS via `R2_ENDPOINT`. Private. Not a public CDN |
| AI | Gemini Flash orchestration (`GEMINI_MODEL`, default `gemini-3.8-flash`) behind `lib/gemini.ts`. Same env on Cloud Run, values in Secret Manager |
| Live tutor voice | **ElevenLabs** clone when enrolled (`lib/voice.ts` / `lib/elevenlabs.ts`); Gemini TTS fallback |
| Realtime voice fallback | Gemini Live native audio (`GEMINI_LIVE_MODEL`) via ephemeral token from `POST /api/voice/realtime` when TTS latency exceeds `VOICE_LATENCY_BUDGET_MS` — see `docs/CONSULTANT_READING.md` |
| Payments | Deferred — `lib/payments.ts` stub; Razorpay/Cashfree later |

## Roles
- `super_admin` — platform (User.platformRole)
- Per-org `Membership.role`: `owner` \| `admin` \| `author` (teacher) \| `student`
- Never trust client-supplied `orgId` — use `activeOrgId()` from session

## Imaging UX
- Never download full 2–3 GB CTA up front
- Parallel multi-series prefetch; finding-first; R2 frame cache in `/api/dicomweb`; interactive ≤30s
- Finding landings key off DICOM UIDs + authored WW/WC; we do **not** write clicks into DICOM files — see `docs/FINDING_LOCALIZATION.md`
- VOI transitions are **adaptive**: scroll when |Δ| ≤ ~150, snap when larger (bone↔lung)
- Length / Ellipse HU measurements attach to findings at save (`Finding.measurements`)

## De-id
- `lib/deid.ts` on ingest (`orthancIngestInstance`); reports persisted via `upsertDeidReport`
- `updateCaseForOrg` blocks draft→published unless every `studyRefs` UID has a passing report
- Pixel OCR is explicitly unscanned — never claimed

## Signup default
- New Better Auth / Google users get **student** membership on `org_demo`
- Teachers are promoted by an org admin (Studio requires `author+`)
- Demo identities: super_admin (`demo@…`), teacher (`teacher@…`), student (`student@…`)

## Consultant authenticity (AI tutor armed by capture)
- Teacher capture (text + landing + optional track) **arms** the AI — students discuss with the tutor, they do not watch a VCR of the take
- Track digests (`lib/readingDigest.ts`) feed scroll/window/zoom habits into the tutor prompt
- Live Q&A uses ElevenLabs **cloned** teacher voice (`Author.voice`) when enrolled
- Consent required before clone enrollment (`POST /api/studio/voice`)
- Author Studio may still exact-replay a track for capture QA only
- Full write-up: `docs/CONSULTANT_READING.md`

## Marketplace learning loop
- Catalog is public for published courses/cases
- `POST /api/enrollments` creates a free active enrollment (payments later)
- Library shows **My learning**; `/learning` is the Continue Learning hub
- **Progress** (case checkmarks), **Wishlist**, **Reviews**, **Certificate of Completion** (not CME)
- Draft cases 404 for students; authors/admins can still open them
- Research notes: `docs/MARKETPLACE_RESEARCH.md`

## Deploy / what users see
- **Production deploy branch:** `claude/epic-noether-3nvcbf`. Target is Cloud Run in `radlearn-app` (`europe-west2`). Fly `flowrad-learn` stays until the cutover checklist in `docs/GCP_CLOUD_RUN.md` has been run.
- PR #6 (`cursor/marketplace-foundation-a5b0`) is **retargeted at that branch** and marked ready for review — merge it to ship Teach to production.
- Student product intent: **Teach** = AI attending drives viewer while teaching how to report; **Exam** = viva; **Report** = sectioned practice with model-on-viewer.
