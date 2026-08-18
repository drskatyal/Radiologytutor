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
| AI | Gemini API (swappable behind `lib/gemini.ts`) |
| Payments | Deferred — `lib/payments.ts` stub; Razorpay/Cashfree later |

## Roles
- `super_admin` — platform (User.platformRole)
- Per-org `Membership.role`: `owner` \| `admin` \| `author` (teacher) \| `student`
- Never trust client-supplied `orgId` — use `activeOrgId()` from session

## Imaging UX
- Never download full 2–3 GB CTA up front
- Parallel multi-series prefetch; finding-first; R2 frame cache in `/api/dicomweb`; interactive ≤30s

## De-id
- `lib/deid.ts` on ingest (`orthancIngestInstance`); reports persisted via `upsertDeidReport`
- `updateCaseForOrg` blocks draft→published unless every `studyRefs` UID has a passing report
- Pixel OCR is explicitly unscanned — never claimed

## Signup default
- New Better Auth / Google users get **student** membership on `org_demo`
- Teachers are promoted by an org admin (Studio requires `author+`)
- Demo identities: super_admin (`demo@…`), teacher (`teacher@…`), student (`student@…`)

## Marketplace learning loop
- Catalog is public for published courses/cases
- `POST /api/enrollments` creates a free active enrollment (payments later)
- Library shows **My learning** for the signed-in student
- Draft cases 404 for students; authors/admins can still open them

## Shut down
- Clerk as production auth
- Railway as forever host (migrate to Fly)
- DICOM bytes in Mongo / Firestore
- Stripe-first India monetization
- Vertex Healthcare DICOM as default archive
