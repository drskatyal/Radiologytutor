# Locked product decisions (do not reopen)

**Marketplace:** curated radiology teaching — teachers publish cases/courses; students learn; platform keeps ~20% later (India PSP, not Stripe-first).

## Infra
| Layer | Choice |
|--------|--------|
| App + Orthanc | **Fly.io** (two apps; Orthanc private + volume) |
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
- Parallel multi-series prefetch; finding-first; R2 cache; interactive ≤30s

## De-id
- `lib/deid.ts` on ingest; publish blocked until pass (quality gate, not HIPAA project)
