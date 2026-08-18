# Locked product decisions (do not reopen)

**Marketplace:** curated radiology teaching — teachers publish cases/courses; students learn; platform keeps ~20% later (India PSP, not Stripe-first).

## Infra
| Layer | Choice |
|--------|--------|
| App + Orthanc | **Fly.io** (two apps; Orthanc private + volume). Ops: `docs/FLY_R2.md` |
| Domain DB | **MongoDB Atlas** (JSON fallback in dev) |
| Auth | **Better Auth** + **Google OAuth** (password optional). Seam: `lib/auth.ts` only |
| Frames/audio cache | **Cloudflare R2** (`lib/r2.ts`) |
| DICOM archive | **Orthanc** DICOMweb |
| AI | Gemini Flash orchestration (`GEMINI_MODEL`, default `gemini-3.7-flash`) behind `lib/gemini.ts` |
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

## Consultant authenticity (voice)
- Layer 1 recorded tracks = teacher's **real** mic — never re-TTS
- Layer 3 live Q&A may use ElevenLabs **cloned** teacher voice (`Author.voice`)
- Consent required before clone enrollment (`POST /api/studio/voice`)
- Full write-up: `docs/CONSULTANT_READING.md`

## Marketplace learning loop
- Catalog is public for published courses/cases
- `POST /api/enrollments` creates a free active enrollment (payments later)
- Library shows **My learning**; `/learning` is the Continue Learning hub
- **Progress** (case checkmarks), **Wishlist**, **Reviews**, **Certificate of Completion** (not CME)
- Draft cases 404 for students; authors/admins can still open them
- Research notes: `docs/MARKETPLACE_RESEARCH.md`

## Shut down
- Clerk as production auth
- Railway as forever host (migrate to Fly)
- DICOM bytes in Mongo / Firestore
- Stripe-first India monetization
- Vertex Healthcare DICOM as default archive
